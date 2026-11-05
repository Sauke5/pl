"""Finite native-origin migrations and independent persistence boundaries."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

import test_forms_controller as forms_fixture
import test_grafana_controller as grafana_fixture
import test_doska_controller as doska_fixture
import test_netmap_controller as netmap_fixture
import test_bookstack_controller as bookstack_fixture

BASE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('pl_module_origin_test',BASE/'module-origin.py')
origin=importlib.util.module_from_spec(spec);spec.loader.exec_module(origin)


class OriginTests(unittest.TestCase):
    def fixture(self,kind):
        klass={'forms':forms_fixture.FormsTests,'grafana':grafana_fixture.GrafanaTests,
               'netmap':netmap_fixture.StackLifecycle,'bookstack':bookstack_fixture.BookStackTests}[kind]
        fixture=klass(methodName='runTest');fixture.setUp();self.addCleanup(fixture.doCleanups)
        fixture.execute('install') if kind=='netmap' else fixture.install()
        state=json.loads((fixture.root/'state/installation.json').read_text())
        state['version']='0.3.0';state.setdefault('config',{'public_url':'https://pl.example'})
        origin.files.atomic(fixture.root/'state/installation.json',state)
        for name,obj in fixture.containers.items():obj['Name']='/'+name
        parent=types.SimpleNamespace(root=fixture.root,installation=fixture.installation,docker=fixture.docker,
                                     application=lambda name:fixture.controller,grafana=lambda:fixture.controller)
        return fixture,parent

    def snapshot(self,parent,plan):
        identifier=str(uuid.uuid4());plan['snapshot_operation_id']=identifier
        directory=parent.root/'private/upgrade-backups'/identifier;directory.mkdir(parents=True)
        names={parent.installation+'-auth',parent.installation+'_db',*[name for item in plan['instances'] for name in item['volumes']]}
        volumes=[{'name':name,'archive':'volume-'+str(index)+'.tar'} for index,name in enumerate(sorted(names))]
        checksums={}
        for name in ('installation.tar',*[volume['archive'] for volume in volumes]):
            origin.files.atomic(directory/name,b'private snapshot fixture');checksums[name]=origin.sha((directory/name).read_bytes())
        meta={'schema':1,'installation':parent.installation,'operation_id':identifier,'volumes':volumes,'files':checksums,
              'containers':[{'name':'core-'+service,'core':True,'service':service} for service in ('api','web','db')]}
        origin.files.atomic(directory/'snapshot.json',meta)
        return directory

    def select_origin(self,parent,value):
        state=json.loads((parent.root/'state/installation.json').read_text());state['config']['public_url']=value
        origin.files.atomic(parent.root/'state/installation.json',state)

    def test_forms_changes_only_owned_origin_and_keeps_engine_keys_and_data(self):
        fixture,parent=self.fixture('forms');before=fixture.controller.state(fixture.instance)
        secrets={path.name:path.read_bytes() for path in (fixture.controller.paths(fixture.instance)/'config').iterdir()}
        old,new='https://pl.example','https://new.example:9443'
        with patch.object(origin,'core_sql',return_value=b'0'):
            plan=origin.plan(parent,{'public_url':old},{'public_url':new},False)
        self.assertEqual(plan['affected'],['forms']);self.assertEqual(plan['instances'][0]['recreate'],[])
        self.snapshot(parent,plan)
        for obj in fixture.containers.values():obj['State']['Running']=False
        self.select_origin(parent,new);origin.apply(parent,plan)
        after=fixture.controller.state(fixture.instance)
        self.assertEqual(after,{**before,'public_url':new})
        self.assertEqual({path.name:path.read_bytes() for path in (fixture.controller.paths(fixture.instance)/'config').iterdir()},secrets)
        for obj in fixture.containers.values():obj['State']['Running']=True
        origin.verify(parent,plan)

    def test_snapshot_and_state_fences_fail_before_mutating_any_native_file(self):
        fixture,parent=self.fixture('forms');old,new='https://pl.example','https://new.example'
        path=fixture.controller.paths(fixture.instance)/'state.json';original=path.read_bytes()
        with patch.object(origin,'core_sql',return_value=b'0'):plan=origin.plan(parent,{'public_url':old},{'public_url':new},False)
        self.select_origin(parent,new)
        with self.assertRaisesRegex(ValueError,'snapshot'):origin.apply(parent,plan)
        self.assertEqual(path.read_bytes(),original)
        snapshot=self.snapshot(parent,plan)
        metadata=json.loads((snapshot/'snapshot.json').read_text());metadata['volumes']=metadata['volumes'][:1]
        origin.files.atomic(snapshot/'snapshot.json',metadata)
        with self.assertRaisesRegex(ValueError,'snapshot'):origin.apply(parent,plan)
        self.assertEqual(path.read_bytes(),original)
        self.snapshot(parent,plan)
        path.write_bytes(original+b' ')
        with self.assertRaisesRegex(ValueError,'changed since'):origin.apply(parent,plan)

    def test_grafana_native_config_recreation_and_restored_rollback_keep_secret_and_volume(self):
        fixture,parent=self.fixture('grafana');old,new='https://pl.example','https://new.example:9443'
        state_path=fixture.controller.paths(fixture.instance)/'state.json'
        config_path=fixture.controller.paths(fixture.instance)/'config/grafana.ini'
        state_before,config_before=state_path.read_bytes(),config_path.read_bytes();volume_names=set(fixture.volumes)
        with patch.object(origin,'core_sql',return_value=b'0'):plan=origin.plan(parent,{'public_url':old},{'public_url':new},False)
        self.snapshot(parent,plan)
        for obj in fixture.containers.values():obj['State']['Running']=False
        self.select_origin(parent,new);origin.apply(parent,plan)
        state_after=fixture.controller.state(fixture.instance)
        self.assertEqual(state_after['root_url'],new+'/grafana/')
        self.assertEqual(state_after['secret'],json.loads(state_before)['secret']);self.assertEqual(set(fixture.volumes),volume_names)
        self.assertIn(('container','rm','1'*64),fixture.calls)
        self.assertIn(new+'/grafana/',config_path.read_text())
        # Physical rollback restores source files before the native reconstruction hook.
        self.select_origin(parent,old);origin.files.atomic(state_path,state_before);origin.files.atomic(config_path,config_before,mode=0o444)
        origin.rollback(parent,plan)
        self.assertEqual(fixture.controller.state(fixture.instance)['root_url'],old+'/grafana/')
        self.assertEqual(set(fixture.volumes),volume_names)
        self.assertEqual(len(fixture.containers),1)

    def test_doska_tls_rotation_preserves_credentials_and_recreates_only_api_with_new_ca(self):
        fixture,parent=self.fixture('forms')
        # Real Doska state/credential/specification renderers with a finite
        # stopped-container fixture: replacing the public CA must recreate its
        # bind inode while retaining the directory and gateway identities.
        module=doska_fixture.doska;c=object.__new__(module.DoskaController)
        c.root,c.installation=parent.root,parent.installation
        c.instances=parent.root/'modules/doska/instances';c.instances.mkdir(parents=True,mode=0o700)
        c.operations=parent.root/'modules/doska/operations';c.operations.mkdir(mode=0o700)
        c.images={role:{'id':'sha256:'+hashlib.sha256(role.encode()).hexdigest()} for role in module.ROLES}
        c.verify_image=lambda role:{'Config':{'User':'1000:1000'}}
        origin.files.atomic(parent.root/'private/tls.crt',b'-----BEGIN CERTIFICATE-----\nold-ca\n',mode=0o444)
        with patch.object(module,'API_GID',os.getgid()),patch.object(module,'DATABASE_GID',os.getgid()):
            c.initialize(fixture.instance)
            state=c.state(fixture.instance);base=c.paths(fixture.instance)
            credentials={file.name:file.read_bytes() for file in (base/'config').iterdir()}
            spec_before=c.specification(fixture.instance,'api')
            obj={'Id':'c'*64,'Name':'/'+c.name(fixture.instance,'-api'),'Image':c.images['api']['id'],
                 'Config':{'Env':[key+'='+value for key,value in spec_before[0].items()]},'State':{'Running':False},'HostConfig':{},'Mounts':[]}
            item={'module_id':'doska','instance_id':fixture.instance,'state_sha256':origin.sha((base/'state.json').read_bytes()),
                  'running':True,'recreate':['api'],'volumes':[],'containers':[{'role':'api','name':obj['Name'][1:],'image':obj['Image'],
                    'before':origin.container_fingerprint(obj),'after':origin.container_fingerprint(obj)}]}
            plan={'schema':1,'installation':parent.installation,'old_origin':'https://pl.example','new_origin':'https://pl.example',
                  'tls_changed':True,'requires_full_snapshot':True,'instances':[item],'affected':['doska'],'core_links':False}
            self.snapshot(parent,plan)
            calls=[]
            parent.application=lambda kind:c
            parent.docker=lambda *args,**kw:json.dumps([obj]).encode() if args[:2]==('container','inspect') else calls.append(args) or b''
            c.create_container=lambda instance,role:calls.append(('recreate',instance,role,c.specification(instance,role)))
            origin.files.atomic(parent.root/'private/tls.crt',b'-----BEGIN CERTIFICATE-----\nnew-ca\n',mode=0o444)
            origin.apply(parent,plan)
            after=c.state(fixture.instance)
            self.assertEqual(after,{**state,'ca_sha256':origin.sha((parent.root/'private/tls.crt').read_bytes())})
            self.assertEqual({file.name:file.read_bytes() for file in (base/'config').iterdir()},credentials)
            recreates=[call for call in calls if call[0]=='recreate']
            self.assertEqual([(call[1],call[2]) for call in recreates],[(fixture.instance,'api')])
            self.assertEqual(recreates[0][3],spec_before)
            self.assertIn(('bind',str(parent.root/'private/tls.crt'),'/run/secrets/platform-ca.crt',False),recreates[0][3][1])

    def test_netmap_regenerates_only_origin_configs_with_all_secrets_and_native_gitea_keys_preserved(self):
        fixture,parent=self.fixture('netmap');old,new='https://pl.example.test','https://new.example:9443'
        c=fixture.controller;before=c.state(fixture.instance);base=c.paths(fixture.instance)
        configs={file.name:file.read_bytes() for file in (base/'config').iterdir()}
        volumes=set(fixture.resources['volume'])
        persisted=[configs['gitea.ini']+b'\n[oauth2]\nJWT_SECRET = native-key\n']
        with patch.object(origin,'cp_file',side_effect=lambda *args,**kw:persisted[0]),patch.object(origin,'core_sql',return_value=b'0'):
            plan=origin.plan(parent,{'public_url':old},{'public_url':new},False)
        self.snapshot(parent,plan)
        for obj in fixture.containers.values():obj['State']['Running']=False
        self.select_origin(parent,new)
        with patch.object(origin,'cp_file',side_effect=lambda *args,**kw:persisted[0]),patch.object(origin,'write_gitea',side_effect=lambda parent,obj,data:persisted.__setitem__(0,data)):
            origin.apply(parent,plan)
        after=c.state(fixture.instance)
        self.assertEqual(after['secrets'],before['secrets']);self.assertEqual(set(fixture.resources['volume']),volumes)
        self.assertEqual(set(after['files']),set(before['files']))
        changed={name for name,value in configs.items() if (base/'config'/name).read_bytes()!=value}
        self.assertEqual(changed,{'netbox.json','adapter.json','gitea.ini'})
        netbox=json.loads((base/'config/netbox.json').read_bytes());adapter=json.loads((base/'config/adapter.json').read_bytes())
        self.assertEqual(netbox['origin'],new);self.assertEqual(netbox['hostname'],'new.example')
        self.assertEqual(adapter['platform_origin'],new);self.assertEqual(adapter['hostname'],'new.example:9443')
        self.assertIn(b'JWT_SECRET = native-key',persisted[0]);self.assertIn((new+'/netmap/gitea/').encode(),persisted[0])
        self.assertEqual(set(plan['instances'][0]['recreate']),{'netbox','netbox-worker','gitea','adapter'})

    def test_bookstack_uses_verified_native_tool_once_then_recreates_web_preserving_keys_and_data(self):
        fixture,parent=self.fixture('bookstack');old,new='https://pl.example','https://new.example:9443'
        c=fixture.controller;before=c.state(fixture.instance);volumes=set(fixture.volumes)
        native_tool=b'verified pinned upstream command fixture'
        with patch.object(origin,'cp_file',return_value=native_tool),patch.object(origin,'BOOKSTACK_TOOL_HASH',origin.sha(native_tool)),patch.object(origin,'core_sql',return_value=b'0'):
            plan=origin.plan(parent,{'public_url':old},{'public_url':new},False)
        self.snapshot(parent,plan)
        for obj in fixture.containers.values():obj['State']['Running']=False
        self.select_origin(parent,new)
        original=fixture.docker;commands=[]
        def docker(*args,**kwargs):
            if args[:2]==('container','exec'):
                commands.append(args);return b''
            if args[:2] in (('container','start'),('container','stop')):
                for value in args[2:]:
                    if isinstance(value,str) and len(value)==64:original(*args[:2],value,**kwargs)
                return b''
            return original(*args,**kwargs)
        parent.docker=docker
        class Response(io.BytesIO):
            status=200
        opener=types.SimpleNamespace(open=lambda *args,**kw:Response(b'{"database":true,"cache":true,"session":true}'))
        with patch.object(origin.urllib.request,'build_opener',return_value=opener):origin.apply(parent,plan)
        self.assertEqual(c.state(fixture.instance),{**before,'origin':new});self.assertEqual(set(fixture.volumes),volumes)
        self.assertEqual([command[7:] for command in commands],[('bookstack:update-url',old+'/wiki',new+'/wiki','--force'),('cache:clear',)])
        self.assertTrue(all(command[2:4]==('--user','1000:1000') for command in commands))
        self.assertEqual(plan['instances'][0]['recreate'],['web'])
        fixture.calls.clear()
        with patch.object(origin,'cp_file',return_value=b'foreign command'),self.assertRaises(origin.OriginMigrationRequired):
            origin.plan(parent,{'public_url':new},{'public_url':old},False)
        self.assertFalse(any(call[:2] in (('container','start'),('container','stop'),('container','rm'),('container','exec')) for call in fixture.calls))

    def test_readiness_retries_are_read_only_and_do_not_require_the_already_held_lifecycle_lock(self):
        fixture,parent=self.fixture('forms');old,new='https://pl.example','https://new.example'
        with patch.object(origin,'core_sql',return_value=b'0'):plan=origin.plan(parent,{'public_url':old},{'public_url':new},False)
        self.snapshot(parent,plan)
        state=fixture.controller.state(fixture.instance);state['public_url']=new
        self.select_origin(parent,new)
        origin.files.atomic(fixture.controller.paths(fixture.instance)/'state.json',state)
        observe=iter((OSError('warming up'),{'state':'running'}))
        def observe_state(instance):
            value=next(observe)
            if isinstance(value,Exception):raise value
            return value
        with patch.object(fixture.controller,'observe',side_effect=observe_state),patch.object(origin.time,'sleep') as wait:
            origin.verify(parent,plan)
        wait.assert_called_once_with(1)

    def test_gitea_rewrites_only_pl_owned_domain_and_root_url(self):
        old,new='https://old.example:8443','https://new.example:9443'
        value=b'; custom comment\n[server]\nDOMAIN = old.example\nROOT_URL = https://old.example:8443/netmap/gitea/\nSSH_DOMAIN = custom.example\n[security]\nINTERNAL_TOKEN = keep-private-token\nSECRET_KEY = keep-key\n[custom]\nLINK = https://old.example:8443/custom/\n'
        updated=origin.gitea_config(value,old,new)
        self.assertIn(b'DOMAIN = new.example\n',updated);self.assertIn((new+'/netmap/gitea/').encode(),updated)
        self.assertIn(b'INTERNAL_TOKEN = keep-private-token',updated)
        self.assertIn(b'SSH_DOMAIN = custom.example',updated);self.assertIn((old+'/custom/').encode(),updated)
        self.assertEqual(origin.gitea_config(updated,new,new),updated)
        for changed in (value.replace(b'DOMAIN = old.example',b'DOMAIN = custom.example'),value+b'[server]\n',value.replace(b'ROOT_URL = ',b'OTHER_URL = ')):
            with self.assertRaises(ValueError):origin.gitea_config(changed,old,new)

    def test_container_fences_ignore_only_generated_hostname_and_private_port_number(self):
        original={'Id':'a'*64,'Image':'sha256:'+'1'*64,'Config':{'Hostname':'a'*12,'Env':['KANEO_API_URL=https://old/doska/api','KANEO_CLIENT_URL=https://old/doska','DOSKA_DIRECTORY_ORIGIN=https://old']},'HostConfig':{'PortBindings':{'1337/tcp':[{'HostIp':'127.0.0.1','HostPort':'32001'}]},'CapDrop':['ALL']},'Mounts':[]}
        after=copy.deepcopy(original);after['Id']='b'*64;after['Config']['Hostname']='b'*12;after['HostConfig']['PortBindings']['1337/tcp'][0]['HostPort']='32002'
        after['Config']['Env']=['KANEO_API_URL=https://new/doska/api','KANEO_CLIENT_URL=https://new/doska','DOSKA_DIRECTORY_ORIGIN=https://new']
        self.assertEqual(origin.next_container_fingerprint(original,'doska','https://new'),origin.container_fingerprint(after))
        changed=copy.deepcopy(after);changed['HostConfig']['CapAdd']=['SYS_ADMIN']
        self.assertNotEqual(origin.container_fingerprint(after),origin.container_fingerprint(changed))

    def test_cp_file_refuses_native_symlinks_or_extra_configuration_files(self):
        def archive(symlink=False,extra=False):
            output=io.BytesIO()
            with tarfile.open(fileobj=output,mode='w') as tar:
                directory=tarfile.TarInfo('conf/');directory.type=tarfile.DIRTYPE;tar.addfile(directory)
                member=tarfile.TarInfo('conf/app.ini');member.uid=member.gid=1000;member.mode=0o600
                if symlink:member.type=tarfile.SYMTYPE;member.linkname='/run/secrets/master'
                else:member.size=3
                tar.addfile(member,None if symlink else io.BytesIO(b'ini'))
                if extra:tar.addfile(tarfile.TarInfo('conf/unknown'))
            return output.getvalue()
        parent=types.SimpleNamespace(docker=lambda *args,**kw:archive())
        self.assertEqual(origin.cp_file(parent,'a'*64,'/var/lib/gitea/custom/conf',directory=True),b'ini')
        for bad in (archive(symlink=True),archive(extra=True)):
            parent.docker=lambda *args,value=bad,**kw:value
            with self.assertRaises(ValueError):origin.cp_file(parent,'a'*64,'/var/lib/gitea/custom/conf',directory=True)


@unittest.skipUnless(os.getenv('PL_ORIGIN_TEST_CONTAINER'),'PL_ORIGIN_TEST_CONTAINER is required for isolated PostgreSQL checks')
class CoreLinkSQLTests(unittest.TestCase):
    def test_exact_local_managed_urls_change_and_custom_or_external_links_remain(self):
        container=os.environ['PL_ORIGIN_TEST_CONTAINER'];self.assertRegex(container,r'^[A-Za-z0-9_.-]{1,100}$')
        info=json.loads(subprocess.check_output(['docker','inspect',container]))[0]
        env=dict(v.split('=',1) for v in info['Config']['Env'] if '=' in v);user=env.get('POSTGRES_USER','postgres');database=env.get('POSTGRES_DB',user)
        schema='pl_origin_'+uuid.uuid4().hex
        def sql(statement):
            return subprocess.check_output(['docker','exec',container,'psql','-U',user,'-d',database,'-X','-A','-t','-v','ON_ERROR_STOP=1','-c',statement]).decode()
        sql('CREATE SCHEMA '+schema)
        self.addCleanup(lambda:sql('DROP SCHEMA '+schema+' CASCADE'))
        sql('CREATE TABLE '+schema+'.documents(kind text,id text,body jsonb,revision bigint default 1,search_text text default \'\',updated_at timestamptz default now(),primary key(kind,id))')
        old,new='https://old.example:8443','https://new.example:9443';url=old+'/wayline/'
        module={'module_id':'wayline','mode':'local','desired_state':'enabled','integration_id':'integration'}
        rows=[('module_instance','owner',module,''),('module_instance','external',{**module,'mode':'external'},''),
              ('resource','managed',{'name':'Demo','description':'Keep '+url,'type':'Приложение','url':url,'source':'module','managed_module_id':'owner','links':[{'url':url}]},('Demo Keep '+url+' Приложение '+url+' Collection').lower()),
              ('resource','custom',{'url':old+'/custom/','source':'module','managed_module_id':'owner'},''),
              ('resource','manual',{'url':url,'source':'manual'},''),
              ('resource','external-resource',{'url':url,'source':'module','managed_module_id':'external'},''),
              ('integration','integration',{'url':'http://owned:8587','managed_module_id':'owner','config':{'public_url':url,'custom':url}},'')]
        quote=lambda value:"'"+value.replace("'","''")+"'"
        for kind,identifier,body,search in rows:
            sql('INSERT INTO '+schema+'.documents(kind,id,body,search_text) VALUES('+','.join(map(quote,(kind,identifier,json.dumps(body,ensure_ascii=False),search)))+')')
        prefix='SET search_path='+schema+';'
        self.assertEqual(sql(prefix+origin.core_link_sql(old)).strip(),'SET\n2')
        sql(prefix+origin.core_link_sql(old,new))
        data=json.loads(sql(prefix+"SELECT json_object_agg(id,json_build_object('body',body,'revision',revision,'search',search_text)) FROM documents").split('\n')[-2])
        self.assertEqual(data['managed']['body']['url'],new+'/wayline/');self.assertEqual(data['managed']['body']['links'],[{'url':url}])
        self.assertEqual(data['managed']['search'],('Demo Keep '+url+' Приложение '+new+'/wayline/ Collection').lower())
        self.assertEqual(data['managed']['revision'],2)
        self.assertEqual(data['integration']['body']['config'],{'public_url':new+'/wayline/','custom':url})
        self.assertEqual(data['manual']['body']['url'],url);self.assertEqual(data['external-resource']['body']['url'],url)
        self.assertEqual(data['custom']['body']['url'],old+'/custom/')


if __name__=='__main__':unittest.main()
