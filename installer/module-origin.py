"""Finite native origin/CA migration. Called only by the snapshotted host worker.

BookStack 26.09.2 URL tool and --force were verified in its exact upstream source:
https://github.com/BookStackApp/BookStack/blob/6265d5667dd6904b7aa0d05a8c60795cf104011b/app/Console/Commands/UpdateUrlCommand.php
LinuxServer documents the /app/www/artisan path and persistent configuration:
https://docs.linuxserver.io/images/docker-bookstack/#changing-app_url
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

_spec=importlib.util.spec_from_file_location('pl_origin_files',Path(__file__).with_name('xray-controller.py'))
files=importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(files)
KINDS=('forms','doska','netmap','bookstack','grafana')
ROLES={'forms':('mongo','keydb','engine','adapter'),'doska':('database','api','web'),
       'netmap':('database','cache','netbox','netbox-worker','oxidized','gitea','adapter'),
       'bookstack':('database','web'),'grafana':('',)}
RECREATE={'forms':(), 'doska':('api',), 'netmap':('netbox','netbox-worker','gitea','adapter'),
          'bookstack':('web',),'grafana':('',)}
PREFIXES={'forms':('/forms/',),'doska':('/doska/',),'netmap':('/netmap/','/netmap/netbox/','/netmap/oxidized/','/netmap/gitea/'),
          'bookstack':('/wiki/',),'grafana':('/grafana/',),'inventory':('/inventory/',),'wayline':('/wayline/',),'sftpgo':('/sftpgo/',)}
BOOKSTACK_TOOL_HASH='28ae1490e681654d57448727270d18ac244f22aba0e10d7c97264df3cee2d193'


class OriginMigrationRequired(ValueError):
    public_code='installation_origin_modules'
    public_message='Установленные модули требуют согласованного переноса адреса. Проверьте состояние модулей и совместимость опубликованной версии.'
    status=409


def sha(data):
    return hashlib.sha256(data).hexdigest()


def origin(value):
    if not isinstance(value,str) or len(value)>2048 or any(ord(c)<=32 or ord(c)>=127 for c in value) or '\\' in value:
        raise ValueError('Native origin must be an ASCII HTTPS origin')
    parsed=urllib.parse.urlsplit(value)
    if (parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('','/') or parsed.query or parsed.fragment
            or parsed.port is not None and not 1<=parsed.port<=65535):
        raise ValueError('Invalid native Platform origin')
    host=parsed.hostname
    try:ipaddress.ip_address(host)
    except ValueError:
        if len(host)>253 or any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?',part) for part in host.rstrip('.').split('.')):
            raise ValueError('Invalid native origin hostname') from None
    return value.rstrip('/')


def controller(parent,kind):
    return parent.grafana() if kind=='grafana' else parent.application(kind)


def clear(parent):
    for kind in KINDS:
        attribute='_'+kind+'_controller'
        if hasattr(parent,attribute):
            obj=getattr(parent,attribute)
            cache=getattr(obj,'_routes',None)
            if isinstance(cache,dict):cache.clear()
            delattr(parent,attribute)


def container_fingerprint(obj):
    """Ignore only Docker-generated hostname and assigned loopback port numbers."""
    config=copy.deepcopy(obj.get('Config',{}))
    hostname=config.get('Hostname','')
    if hostname==obj.get('Id','')[:12]:config['Hostname']=''
    host=copy.deepcopy(obj.get('HostConfig',{}))
    for bindings in (host.get('PortBindings') or {}).values():
        for binding in bindings or []:
            if binding.get('HostIp')=='127.0.0.1' and (binding.get('HostPort')=='' or str(binding.get('HostPort','')).isdigit()):
                binding['HostPort']='*'
    return sha(files.encoded({'image':obj.get('Image'),'config':config,'host':host,'mounts':obj.get('Mounts',[])}))


def next_container_fingerprint(obj,kind,new_origin):
    candidate=copy.deepcopy(obj)
    updates={}
    if kind=='doska':
        updates={'DOSKA_DIRECTORY_ORIGIN':new_origin,'KANEO_CLIENT_URL':new_origin+'/doska','KANEO_API_URL':new_origin+'/doska/api'}
    elif kind=='bookstack':updates={'APP_URL':new_origin+'/wiki'}
    if updates:
        env=[]
        for item in candidate['Config'].get('Env',[]):
            key,_,value=item.partition('=')
            env.append(key+'='+updates.pop(key,value))
        if updates:raise ValueError('Native origin environment is incomplete')
        candidate['Config']['Env']=env
    return container_fingerprint(candidate)


def raw_container(parent,item):
    objects=json.loads(parent.docker('container','inspect',item['name']))
    if not isinstance(objects,list) or len(objects)!=1:raise ValueError('Native container unavailable')
    obj=objects[0]
    if (obj.get('Name')!='/'+item['name'] or obj.get('Image')!=item['image']
            or not re.fullmatch(r'[0-9a-f]{64}',obj.get('Id',''))
            or container_fingerprint(obj) not in {item['before'],item['after']}):
        raise ValueError('Native container changed outside the migration plan')
    return obj


def cp_file(parent,container,path,*,directory=False):
    archive=parent.docker('container','cp',container+':'+path,'-',timeout=30)
    if len(archive)>2*1024**2:raise ValueError('Native configuration exceeds its bounded contract')
    name=Path(path).name
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:*') as tar:
        members=tar.getmembers()
        by_name={m.name.rstrip('/') if m.isdir() else m.name:m for m in members}
        allowed={name,name+'/app.ini'} if directory else {name}
        if (len(by_name)!=len(members) or set(by_name)-allowed
                or any(not(m.isfile() or directory and m.isdir() and m.name.rstrip('/')==name) for m in members)):
            raise ValueError('Native configuration is not an owned regular file tree')
        target=name+'/app.ini' if directory else name
        member=by_name[target]
        if not member.isfile() or member.size>1024**2:
            raise ValueError('Native configuration is not a bounded regular file')
        if directory:
            parent_member=by_name[name]
            if not parent_member.isdir() or member.uid!=1000 or member.gid!=1000 or member.mode&0o777!=0o600:
                raise ValueError('Native Gitea configuration permissions changed')
        return tar.extractfile(member).read()


def gitea_config(data,old_origin,new_origin):
    """Change exactly the two PL-owned [server] values, retaining all native keys."""
    if len(data)>1024**2 or b'\x00' in data:raise ValueError('Invalid native Gitea configuration')
    lines=data.decode('utf-8').splitlines(keepends=True)
    old_host=urllib.parse.urlsplit(old_origin).hostname
    new_host=urllib.parse.urlsplit(new_origin).hostname
    expected={'DOMAIN':(old_host,new_host),'ROOT_URL':(old_origin+'/netmap/gitea/',new_origin+'/netmap/gitea/')}
    section='';seen=set();server_sections=0;result=[]
    for line in lines:
        text=line.strip()
        if text.startswith('['):
            if not text.endswith(']'):raise ValueError('Invalid native Gitea section')
            section=text[1:-1].strip().lower()
            if section=='server':
                server_sections+=1
                if server_sections>1:raise ValueError('Duplicate native Gitea server section')
        if section=='server' and text and not text.startswith((';','#','[')) and '=' in line:
            left,right=line.split('=',1);key=left.strip().upper()
            if key in expected:
                if key in seen:raise ValueError('Duplicate native Gitea origin setting')
                seen.add(key)
                previous,replacement=expected[key]
                value=right.strip();quote=''
                if len(value)>=2 and value[0]==value[-1] and value[0] in ('"',"'"):
                    quote=value[0];value=value[1:-1]
                if value!=previous:raise OriginMigrationRequired('Custom Gitea origin requires an explicit migration')
                newline='\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
                leading=right[:len(right)-len(right.lstrip(' \t'))]
                line=left+'='+leading+quote+replacement+quote+newline
        result.append(line)
    if seen!=set(expected):raise ValueError('Native Gitea origin settings are incomplete')
    return ''.join(result).encode('utf-8')


def instance_paths(root,kind):
    path=root/'modules'/kind/'instances'
    if not path.exists() and not path.is_symlink():return []
    files.directory(path,create=False)
    result=[]
    for item in sorted(path.iterdir()):
        files.identifier(item.name);files.directory(item,create=False)
        if (item/'state.json').is_file() and not (item/'state.json').is_symlink():result.append(item)
        else:raise OriginMigrationRequired('Incomplete native module state requires reconciliation')
    return result


def core_link_sql(old_origin,new_origin=None):
    quote=lambda value:"'"+value.replace("'","''")+"'"
    rows=','.join('('+quote(kind)+','+quote(path)+')' for kind,paths in PREFIXES.items() for path in paths)
    old=quote(old_origin)
    selection=f"""WITH prefixes(module,suffix) AS (VALUES {rows}), owned AS (
 SELECT d.kind,d.id,p.suffix FROM documents d
 JOIN documents m ON m.kind='module_instance' AND m.id=d.body->>'managed_module_id'
 JOIN prefixes p ON p.module=m.body->>'module_id'
 WHERE m.body->>'mode'='local' AND m.body->>'desired_state'<>'removed'
 AND ((d.kind='resource' AND d.body->>'source'='module' AND d.body->>'url'={old}||p.suffix)
 OR (d.kind='integration' AND m.body->>'integration_id'=d.id AND d.body->'config'->>'public_url'={old}||p.suffix))
 ) """
    if new_origin is None:return selection+'SELECT count(*) FROM owned;'
    new=quote(new_origin)
    # Preserve all custom body fields; only the exact derived primary route changes.
    # Replace only the primary URL position in the canonical index prefix. Terms
    # from a user's description, endpoints and collection names remain intact.
    prefix="btrim(regexp_replace(replace(lower(concat_ws(' ',d.body->>'name',d.body->>'description',d.body->>'type')),'ё','е'),'[[:space:]]+',' ','g'))"
    old_uri=f"lower({old}||o.suffix)"
    new_uri=f"lower({new}||o.suffix)"
    search=f"CASE WHEN left(d.search_text,length({prefix})+1+length({old_uri}))={prefix}||' '||{old_uri} THEN {prefix}||' '||{new_uri}||substr(d.search_text,length({prefix})+length({old_uri})+2) ELSE d.search_text||' '||{new_uri} END"
    return 'BEGIN; '+selection+f"""UPDATE documents d SET
 body=CASE WHEN d.kind='resource' THEN jsonb_set(d.body,'{{url}}',to_jsonb({new}||o.suffix))
 ELSE jsonb_set(d.body,'{{config,public_url}}',to_jsonb({new}||o.suffix)) END,
 revision=d.revision+1,updated_at=now(),
 search_text=CASE WHEN d.kind='resource' THEN {search} ELSE d.search_text END
 FROM owned o WHERE d.kind=o.kind AND d.id=o.id; COMMIT;"""


def core_database(parent):
    ids=parent.docker('container','ls','-a','--filter','label=com.docker.compose.project='+parent.installation,
                      '--filter','label=com.docker.compose.service=db','--format','{{.ID}}').decode().split()
    if len(ids)!=1:raise ValueError('Owned core database is unavailable')
    obj=json.loads(parent.docker('container','inspect',ids[0]))[0]
    state=json.loads(files.read_file(Path(parent.root)/'state/installation.json'))
    manifest=json.loads((Path(parent.root)/'releases'/state['version']/'manifest.json').read_bytes())
    labels=obj.get('Config',{}).get('Labels') or {}
    if (obj.get('Image')!=manifest['images']['db']['id'] or labels.get('com.docker.compose.project')!=parent.installation
            or labels.get('com.docker.compose.service')!='db' or not re.fullmatch(r'[0-9a-f]{64}',obj.get('Id',''))):
        raise ValueError('Core database ownership changed')
    return obj


def core_sql(parent,sql,*,mutation=False):
    obj=core_database(parent);started=False
    try:
        if not obj.get('State',{}).get('Running'):
            if not mutation:raise ValueError('Core database is stopped before migration preflight')
            started=True
            parent.docker('container','start',obj['Id'])
            deadline=time.monotonic()+60
            while True:
                try:
                    parent.docker('container','exec',obj['Id'],'pg_isready','-U','pl','-d','pl',timeout=5);break
                except (ValueError,OSError):
                    if time.monotonic()>=deadline:raise ValueError('Core database startup unconfirmed') from None
                    time.sleep(.5)
        return parent.docker('container','exec',obj['Id'],'psql','-U','pl','-d','pl','-X','-A','-t','-v','ON_ERROR_STOP=1','-c',sql,timeout=60)
    finally:
        if started:parent.docker('container','stop','--time','30',obj['Id'],timeout=60)


def plan(parent,old_config,next_config,tls_changed):
    old_origin,new_origin=origin(old_config['public_url']),origin(next_config['public_url'])
    if type(tls_changed) is not bool:raise ValueError('TLS change must be explicit')
    if old_origin==new_origin and not tls_changed:return None
    root=Path(parent.root)
    current=json.loads(files.read_file(root/'state/installation.json'))
    if current.get('install_id')!=parent.installation or origin(current['config']['public_url'])!=old_origin:
        raise ValueError('Origin preflight installation differs')
    result={'schema':1,'installation':parent.installation,'old_origin':old_origin,'new_origin':new_origin,
            'tls_changed':tls_changed,'requires_full_snapshot':True,'affected':[],'instances':[],'core_links':False}
    for kind in KINDS:
        if old_origin==new_origin and kind!='doska':continue
        for path in instance_paths(root,kind):
            files.directory(root/'modules'/kind/'operations',create=False)
            c=controller(parent,kind);instance=path.name
            state=c.state(instance)
            if kind=='forms' and not state['bootstrapped']:raise OriginMigrationRequired('Forms bootstrap must finish before origin migration')
            if kind=='grafana' and state.get('schema')!=2:raise OriginMigrationRequired('Legacy Grafana requires its native authentication migration first')
            objects={role:(c.inspect(instance) if kind=='grafana' else c.inspect(instance,role)) for role in ROLES[kind]}
            if any(v is None for v in objects.values()):raise OriginMigrationRequired('Incomplete native module must be reconciled first')
            running=[v.get('State',{}).get('Running') is True for v in objects.values()]
            if any(running) and not all(running):raise OriginMigrationRequired('Native module components have mixed states')
            item={'module_id':kind,'instance_id':instance,'state_sha256':sha(files.read_file(path/'state.json')),'containers':[],
                  'running':all(running),'recreate':list(RECREATE[kind]),
                  'volumes':sorted({mount['Name'] for obj in objects.values() for mount in obj.get('Mounts',[]) if mount.get('Type')=='volume'})}
            for role,obj in objects.items():
                item['containers'].append({'role':role,'name':obj['Name'].removeprefix('/'),'image':obj['Image'],
                                           'before':container_fingerprint(obj),'after':next_container_fingerprint(obj,kind,new_origin) if role in RECREATE[kind] else container_fingerprint(obj)})
            if kind=='netmap':
                gitea=cp_file(parent,objects['gitea']['Id'],'/var/lib/gitea/custom/conf',directory=True)
                gitea_config(gitea,old_origin,new_origin);item['gitea_sha256']=sha(gitea)
            if kind=='bookstack':
                if c.version!='26.09.2':raise OriginMigrationRequired('BookStack version has no verified origin migration')
                source=cp_file(parent,objects['web']['Id'],'/app/www/app/Console/Commands/UpdateUrlCommand.php')
                if sha(source)!=BOOKSTACK_TOOL_HASH:raise OriginMigrationRequired('BookStack native URL migration command differs')
            result['instances'].append(item)
            if kind not in result['affected']:result['affected'].append(kind)
    if old_origin!=new_origin and any(instance_paths(root,kind) for kind in PREFIXES):
        result['core_links']=int(core_sql(parent,core_link_sql(old_origin)).decode().strip())>0
    if not result['instances'] and not result['core_links']:return None
    return result


def snapshot_guard(parent,plan):
    identifier=plan.get('snapshot_operation_id')
    try:
        if str(uuid.UUID(identifier))!=identifier:raise ValueError()
    except (ValueError,TypeError,AttributeError):raise ValueError('Complete installation snapshot is required') from None
    root=Path(parent.root);path=root/'private/upgrade-backups'/identifier
    if path!=path.resolve():raise ValueError('Unsafe origin migration snapshot path')
    meta=json.loads(files.read_file(path/'snapshot.json'))
    expected={'installation.tar',*[v['archive'] for v in meta.get('volumes',[])]}
    required_volumes={parent.installation+'-auth',parent.installation+'_db',*[name for item in plan['instances'] for name in item.get('volumes',[])]}
    snapshot_volumes={v.get('name') for v in meta.get('volumes',[])}
    if (meta.get('schema')!=1 or meta.get('installation')!=parent.installation or meta.get('operation_id')!=identifier
            or set(meta.get('files',{}))!=expected or not required_volumes<=snapshot_volumes
            or {c.get('service') for c in meta.get('containers',[]) if c.get('core')}!={'api','web','db'}):
        raise ValueError('Complete installation snapshot does not match this migration')
    for name,value in meta['files'].items():
        if not re.fullmatch(r'(?:installation|volume-[0-9]+)\.tar',name) or not re.fullmatch(r'[0-9a-f]{64}',value):raise ValueError('Invalid snapshot manifest')
        archive=path/name
        if archive.is_symlink() or not archive.is_file() or archive.stat().st_uid!=os.geteuid() or archive.stat().st_mode&0o077:
            raise ValueError('Private snapshot payload is unavailable')
    return path,meta


def validate_plan(parent,plan,*,restored=False):
    if (not isinstance(plan,dict) or plan.get('schema')!=1 or plan.get('requires_full_snapshot') is not True
            or plan.get('installation')!=parent.installation or not isinstance(plan.get('instances'),list)):
        raise ValueError('Invalid native origin migration plan')
    old,new=origin(plan['old_origin']),origin(plan['new_origin'])
    state=json.loads(files.read_file(Path(parent.root)/'state/installation.json'))
    if origin(state['config']['public_url'])!=(old if restored else new):raise ValueError('Native migration installation origin differs')
    snapshot_guard(parent,plan)
    return old,new


def write_gitea(parent,obj,data):
    with tempfile.TemporaryDirectory(prefix='gitea-origin-',dir=Path(parent.root)/'private') as temporary:
        path=Path(temporary)/'app.ini';files.atomic(path,data,mode=0o600);os.chown(path,1000,1000)
        parent.docker('container','cp','--archive',str(path),obj['Id']+':/var/lib/gitea/custom/conf/app.ini',timeout=30)
    if cp_file(parent,obj['Id'],'/var/lib/gitea/custom/conf',directory=True)!=data:
        raise ValueError('Native Gitea origin configuration read-back differs')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None


def bookstack_url(parent,item,old,new):
    by_role={v['role']:v for v in item['containers']}
    database=raw_container(parent,by_role['database']);web=raw_container(parent,by_role['web'])
    try:
        parent.docker('container','start',database['Id'],web['Id'],timeout=120)
        deadline=time.monotonic()+120
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        while True:
            try:
                obj=raw_container(parent,by_role['web'])
                ports=obj.get('NetworkSettings',{}).get('Ports',{}).get('80/tcp') or []
                if len(ports)!=1 or ports[0].get('HostIp')!='127.0.0.1' or not str(ports[0].get('HostPort','')).isdigit():raise ValueError('BookStack local route changed')
                req=urllib.request.Request('http://127.0.0.1:'+ports[0]['HostPort']+'/status',headers={'Host':urllib.parse.urlsplit(old).netloc,'Accept-Encoding':'identity'})
                with opener.open(req,timeout=10) as response:
                    data=response.read(65537)
                    health=json.loads(data)
                    if response.status!=200 or len(data)>65536 or any(health.get(key) is not True for key in ('database','cache','session')):raise ValueError('BookStack native health unavailable')
                break
            except (ValueError,OSError,urllib.error.URLError):
                if time.monotonic()>=deadline:raise ValueError('BookStack readiness before URL migration is unconfirmed') from None
                time.sleep(.5)
        parent.docker('container','exec','--user','1000:1000',web['Id'],'php','/app/www/artisan','bookstack:update-url',old+'/wiki',new+'/wiki','--force',timeout=180)
        parent.docker('container','exec','--user','1000:1000',web['Id'],'php','/app/www/artisan','cache:clear',timeout=60)
    finally:
        parent.docker('container','stop','--time','30',web['Id'],database['Id'],timeout=90)


def create_replacements(parent,item):
    c=controller(parent,item['module_id']);kind=item['module_id'];instance=item['instance_id']
    for role in item['recreate']:
        if kind=='grafana':c.create(instance)
        elif kind=='netmap':c.create_container(instance,role)
        elif kind=='bookstack':
            c.create_container(instance,role)
            obj=c.inspect(instance,role,allow_pending=True)
            ingress=parent.installation+'_ingress'
            if ingress not in obj.get('NetworkSettings',{}).get('Networks',{}):
                parent.docker('network','connect','--alias','pl-bookstack-'+instance,ingress,obj['Id'])
        else:c.create_container(instance,role)


def apply(parent,plan):
    old,new=validate_plan(parent,plan)
    root=Path(parent.root);clear(parent)
    # Read and fence every affected file/container before the first mutation.
    states={}
    for item in plan['instances']:
        kind=item['module_id'];instance=files.identifier(item['instance_id'])
        if kind not in KINDS:raise ValueError('Unsupported native origin migration')
        path=root/'modules'/kind/'instances'/instance
        body=files.read_file(path/'state.json')
        if sha(body)!=item['state_sha256']:raise ValueError('Native state changed since migration preflight')
        states[(kind,instance)]=json.loads(body)
        for container in item['containers']:
            if raw_container(parent,container).get('State',{}).get('Running'):raise ValueError('Native writes were not quiesced before migration')
        if kind=='netmap':
            obj=raw_container(parent,next(v for v in item['containers'] if v['role']=='gitea'))
            data=cp_file(parent,obj['Id'],'/var/lib/gitea/custom/conf',directory=True)
            if sha(data)!=item['gitea_sha256']:raise ValueError('Native Gitea configuration changed after preflight')
            gitea_config(data,old,new)
    for item in plan['instances']:
        kind,instance=item['module_id'],item['instance_id'];path=root/'modules'/kind/'instances'/instance
        state=states[(kind,instance)]
        if kind=='bookstack':bookstack_url(parent,item,old,new)
        if kind=='netmap':
            obj=raw_container(parent,next(v for v in item['containers'] if v['role']=='gitea'))
            data=cp_file(parent,obj['Id'],'/var/lib/gitea/custom/conf',directory=True)
            write_gitea(parent,obj,gitea_config(data,old,new))
        for spec in item['containers']:
            if spec['role'] in item['recreate']:
                obj=raw_container(parent,spec)
                if obj.get('State',{}).get('Running'):raise ValueError('Native migration container unexpectedly running')
                parent.docker('container','rm',obj['Id'])
        c=controller(parent,kind)
        if kind=='forms':state['public_url']=new
        elif kind=='doska':
            state['origin']=new;state['ca_sha256']=sha(files.read_file(root/'private/tls.crt',mode=0o444))
        elif kind=='netmap':
            state['origin']=new;values=c.config_values(instance,state)
            for name,value in values.items():
                target=path/'config'/name
                if files.read_file(target,mode=0o444)!=value:files.atomic(target,value,mode=0o444)
            state['files']={name:sha(value) for name,value in values.items()}
        elif kind=='bookstack':state['origin']=new
        elif kind=='grafana':
            state['root_url']=new+'/grafana/';files.atomic(path/'config/grafana.ini',c.config(state),mode=0o444)
        files.atomic(path/'state.json',state)
        c.state(instance)
        create_replacements(parent,item)
    if plan.get('core_links'):core_sql(parent,core_link_sql(old,new),mutation=True)
    clear(parent)


def rollback(parent,plan):
    validate_plan(parent,plan,restored=True)
    clear(parent)
    for item in plan['instances']:
        for spec in item['containers']:
            if spec['role'] not in item['recreate']:continue
            found=parent.docker('container','ls','-a','--filter','name=^/'+spec['name']+'$','--format','{{.ID}}').decode().strip()
            if found:
                obj=raw_container(parent,spec)
                if obj.get('State',{}).get('Running'):raise ValueError('Rollback native writes were not quiesced')
                parent.docker('container','rm',obj['Id'])
        create_replacements(parent,item)
    clear(parent)


def verify(parent,plan):
    validate_plan(parent,plan)
    clear(parent)
    for item in plan['instances']:
        c=controller(parent,item['module_id']);instance=item['instance_id']
        c.state(instance)
        # The worker already owns modules/controller.lock exclusively. Calling
        # get() here would acquire that file lock again through a different FD.
        expected='running' if item['running'] else 'disabled'
        deadline=time.monotonic()+(300 if item['module_id']=='netmap' else 180)
        while True:
            try:
                result=c.observe(instance)
                if result.get('state')!=expected:raise ValueError('Native module state was not preserved by origin migration')
                break
            except (ValueError,OSError):
                if not item['running'] or time.monotonic()>=deadline:
                    raise ValueError('Native module readiness after origin migration is unconfirmed') from None
                time.sleep(1)
        if item['module_id']=='netmap':
            obj=c.inspect(instance,'gitea')
            updated=cp_file(parent,obj['Id'],'/var/lib/gitea/custom/conf',directory=True)
            # A no-op transform verifies canonical values while retaining native keys.
            if gitea_config(updated,plan['new_origin'],plan['new_origin'])!=updated:
                raise ValueError('Native Gitea origin verification differs')
    if plan.get('core_links') and int(core_sql(parent,core_link_sql(plan['old_origin'])).decode().strip()):
        raise ValueError('Owned catalog links still use the previous origin')
