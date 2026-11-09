#!/usr/bin/env python3
"""Owned official Grafana lifecycle with native authentication and users."""
from __future__ import annotations
import base64
from contextlib import contextmanager, nullcontext
import fcntl
import hashlib
from http.cookies import CookieError, SimpleCookie
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

_helper = Path(__file__).with_name('xray-controller.py')
if _helper.is_symlink() or not _helper.is_file():
    raise ValueError('Trusted file primitives unavailable')
_spec = importlib.util.spec_from_file_location('pl_grafana_files', _helper)
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
identifier, directory, read_file = _files.identifier, _files.directory, _files.read_file
atomic, encoded, fsync_directory = _files.atomic, _files.encoded, _files.fsync_directory
MAX_RESPONSE = 4 * 1024**2
MAX_CHART_BODY = 512 * 1024
CHART_DASHBOARD_PATH = re.compile(r'/grafana/api/dashboards/uid/[A-Za-z0-9_-]{1,128}')
SESSION_VALUE = re.compile(r'[A-Za-z0-9._~+/=-]{1,512}')
SESSION_COOKIES = {'grafana_session', 'grafana_session_expiry'}


def public_origin(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) <= 32 or ord(c) == 127 for c in value):
        raise ValueError('Invalid Platform origin')
    p = urllib.parse.urlsplit(value)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password or p.path not in ('', '/') or p.query or p.fragment:
        raise ValueError('Invalid Platform origin')
    try:
        if p.port is not None and not 1 <= p.port <= 65535:
            raise ValueError('Invalid Platform origin port')
    except ValueError:
        raise ValueError('Invalid Platform origin port') from None
    return p.scheme + '://' + p.netloc + '/grafana/'


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class LegacyMigrationRequired(ValueError):
    pass


class GrafanaController:
    def __init__(self, parent):
        self.parent, self.root, self.installation = parent, Path(parent.root), parent.installation
        self.docker = parent.docker
        self.image = self.resolve_image()
        self.version = self.image['labels']['org.opencontainers.image.version']
        self.base = self.root / 'modules/grafana'
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        for path in (self.base, self.instances, self.operations):
            directory(path)

    def resolve_image(self):
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        state = json.loads(read_file(self.root / 'state/installation.json'))
        image = registry.get('grafana', {})
        labels = image.get('labels', {})
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or state.get('install_id') != self.installation or registry.get('manifest_sha256') != state.get('manifest_sha256')
                or not re.fullmatch(r'[0-9a-f]{64}', registry.get('manifest_sha256', ''))
                or set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                or image.get('architecture') not in ('amd64', 'arm64') or image.get('recipe') != 'deploy/images/grafana.Dockerfile'
                or labels.get('pl.module.id') != 'grafana' or labels.get('pl.module.config.version') != '1'
                or labels.get('pl.build.variant') not in ('upstream-pinned', 'source-build-pl-signed')
                or (labels.get('pl.build.variant') == 'source-build-pl-signed'
                    and not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', labels.get('pl.build.go', '')))
                or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', labels.get('org.opencontainers.image.version', ''))):
            raise ValueError('Invalid Grafana image contract')
        return image

    def verify_image(self):
        image = json.loads(self.docker('image', 'inspect', self.image['id']))[0]
        if (image.get('Id') != self.image['id'] or image.get('Os') != 'linux' or image.get('Architecture') != self.image['architecture']
                or any((image.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in self.image['labels'].items())):
            raise ValueError('Grafana image identity mismatch')
        return image

    @contextmanager
    def locked(self):
        fd = os.open(self.root / 'modules/controller.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o077:
            os.close(fd)
            raise ValueError('Unsafe lifecycle lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    @contextmanager
    def instance_lock(self, instance, exclusive=False):
        # Serialize lifecycle changes against observation of this instance.
        path = self.operations / ('instance-' + identifier(instance) + '.lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if (os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600
                or not os.path.isfile(path)):
            os.close(fd)
            raise ValueError('Unsafe Grafana instance lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def name(self, instance, suffix=''):
        return self.installation + '-grafana-' + identifier(instance) + suffix

    def labels(self, instance):
        return {'pl.installation': self.installation, 'pl.module': 'grafana', 'pl.instance': identifier(instance)}

    def paths(self, instance, create=False):
        base = self.instances / identifier(instance)
        directory(base, create=create)
        directory(base / 'config', create=create, mode=0o755)
        return base

    def config(self, state):
        if state.get('schema') == 2:
            # Omit auth/user/plugin overrides: the official image owns these defaults.
            return ('[server]\nroot_url = ' + state['root_url'] + '\nserve_from_sub_path = true\n'
                    '[security]\nsecret_key = ' + state['secret'] + '\n').encode()
        # Preserve the exact legacy file solely for ownership checks and removal.
        return ('[server]\nroot_url = ' + state['root_url'] + '\nserve_from_sub_path = true\n'
                '[security]\nadmin_user = pl-bootstrap\nadmin_password = ' + state['password'] + '\nsecret_key = ' + state['secret'] + '\n'
                '[auth]\ndisable_login_form = true\ndisable_signout_menu = true\n'
                '[auth.basic]\nenabled = false\n[auth.anonymous]\nenabled = false\n'
                '[auth.proxy]\nenabled = true\nheader_name = X-WEBAUTH-USER\nheader_property = username\n'
                'auto_sign_up = true\nsync_ttl = 0\nwhitelist = ' + state['gateway'] + '\nheaders = Name:X-WEBAUTH-NAME Role:X-WEBAUTH-ROLE\n'
                'enable_login_token = false\nheaders_encoded = true\n[users]\nallow_sign_up = false\nallow_org_create = false\n'
                '[analytics]\nreporting_enabled = false\ncheck_for_updates = false\ncheck_for_plugin_updates = false\n'
                '[plugins]\npreinstall_disabled = true\n[log]\nmode = console\n').encode()

    def journal(self, instance):
        state = json.loads(read_file(self.paths(instance) / 'state.json'))
        native = state.get('schema') == 2
        fields = ({'schema', 'installation', 'instance_id', 'root_url', 'secret', 'network_id'} if native else
                  {'installation', 'instance_id', 'root_url', 'password', 'secret', 'network_id', 'gateway', 'prometheus_instance_id'})
        if (set(state) != fields or (native and type(state['schema']) is not int) or state.get('installation') != self.installation or state.get('instance_id') != instance
                or public_origin(state.get('root_url', '').removesuffix('grafana/')) != state.get('root_url')
                or not re.fullmatch(r'[0-9a-f]{64}', state.get('network_id', ''))
                or not re.fullmatch(r'[0-9a-f]{64}', state.get('secret', ''))):
            raise ValueError('Invalid Grafana state')
        if not native:
            if not re.fullmatch(r'[0-9a-f]{64}', state.get('password', '')):
                raise ValueError('Invalid legacy Grafana state')
            gateway = ipaddress.ip_address(state['gateway'])
            if gateway.version != 4 or str(gateway) != state['gateway'] or gateway.is_unspecified or gateway.is_loopback:
                raise ValueError('Invalid Grafana auth-proxy gateway')
            if state['prometheus_instance_id']:
                identifier(state['prometheus_instance_id'])
        return state

    def state(self, instance):
        state = self.journal(instance)
        network = self.network(instance)
        if (not network or network.get('Id') != state['network_id']
                or (state.get('schema') != 2 and self.gateway(network) != state['gateway'])):
            raise ValueError('Grafana network identity changed')
        if read_file(self.paths(instance) / 'config/grafana.ini', mode=0o444) != self.config(state):
            raise ValueError('Grafana configuration drift')
        return state

    def gateway(self, network):
        values = network.get('IPAM', {}).get('Config', [])
        gateways = [item.get('Gateway', '') for item in values if ':' not in item.get('Gateway', '')]
        if len(gateways) != 1:
            raise ValueError('Grafana network must have one IPv4 gateway')
        value = ipaddress.ip_address(gateways[0])
        if value.version != 4 or value.is_loopback or value.is_unspecified:
            raise ValueError('Invalid Grafana network gateway')
        return str(value)

    def initialize(self, instance, origin, prometheus=''):
        root_url = public_origin(origin)
        if prometheus:
            raise ValueError('Grafana uses native datasource management; automatic Prometheus selection is unsupported')
        if self.image['labels']['pl.build.variant'] != 'upstream-pinned':
            raise LegacyMigrationRequired('Legacy Grafana image cannot start native-auth installs; explicit migration required')
        base = self.paths(instance, create=True)
        path = base / 'state.json'
        if path.exists() or path.is_symlink():
            state = self.journal(instance)
            if state.get('schema') != 2:
                raise LegacyMigrationRequired('Legacy Grafana requires explicit native-auth migration; existing data is preserved')
            if state['root_url'] != root_url:
                raise ValueError('Grafana origin changed; explicit migration required')
        else:
            if list((base / 'config').iterdir()):
                raise ValueError('Unknown Grafana initialization files')
            network = self.ingress_network()
            state = {'schema': 2, 'installation': self.installation, 'instance_id': instance,
                     'root_url': root_url, 'secret': secrets.token_hex(32), 'network_id': network['Id']}
            atomic(path, state)
        if set(p.name for p in (base / 'config').iterdir()) - {'grafana.ini'}:
            raise ValueError('Unknown Grafana initialization files')
        config = base / 'config/grafana.ini'
        if config.exists() or config.is_symlink():
            if read_file(config, mode=0o444) != self.config(state):
                raise ValueError('Grafana configuration drift')
        else:
            atomic(config, self.config(state), mode=0o444)
        self.state(instance)

    def volume(self, instance, create=False):
        name = self.name(instance, '-data')
        found = self.docker('volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found and create:
            args = ['volume', 'create']
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, name)
            return self.volume(instance)
        if not found:
            return None
        obj = json.loads(self.docker('volume', 'inspect', name))[0]
        if obj.get('Name') != name or obj.get('Driver') != 'local' or obj.get('Options') or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items()):
            raise ValueError('Grafana volume ownership mismatch')
        return obj

    def ingress_network(self):
        name = self.installation + '_ingress'
        found = self.docker('network', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if found != name:
            raise ValueError('Core ingress network is missing')
        obj = json.loads(self.docker('network', 'inspect', name))[0]
        labels = obj.get('Labels') or {}
        if (obj.get('Name') != name or obj.get('Driver') != 'bridge' or obj.get('Scope') != 'local'
                or obj.get('Internal') or obj.get('Ingress')
                or labels.get('pl.installation') != self.installation
                or labels.get('com.docker.compose.project') != self.installation
                or labels.get('com.docker.compose.network') != 'ingress'
                or not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', ''))):
            raise ValueError('Core ingress network ownership mismatch')
        return obj

    def network(self, instance):
        statepath = self.instances / identifier(instance) / 'state.json'
        state = self.journal(instance) if statepath.exists() or statepath.is_symlink() else None
        if state and state.get('schema') == 2:
            return self.ingress_network()
        # Legacy owned networks are retained only for observation/removal.
        name = self.name(instance, '-net')
        found = self.docker('network', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found:
            return None
        obj = json.loads(self.docker('network', 'inspect', name))[0]
        statepath = self.instances / identifier(instance) / 'state.json'
        prom = self.journal(instance)['prometheus_instance_id'] if statepath.exists() or statepath.is_symlink() else ''
        # The selected Prometheus is an intentional member, checked again below
        # by its full native controller. Other installations/instances stay foreign.
        _files.validate_module_network(self.root, self.installation, obj, self.docker, prometheus=prom)
        if (obj.get('Name') != name or obj.get('Driver') != 'bridge' or obj.get('Options') or obj.get('Internal')
                or obj.get('Ingress') or obj.get('Scope') != 'local'
                or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())
                or not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', ''))):
            raise ValueError('Grafana network ownership mismatch')
        allowed = {self.name(instance)}
        if prom:
            attached = self.parent.inspect(prom)
            if attached is not None:
                allowed.add(self.parent.name(prom))
                for member_id, member in obj.get('Containers', {}).items():
                    if member.get('Name') == self.parent.name(prom) and member_id != attached.get('Id'):
                        raise ValueError('Grafana Prometheus network identity mismatch')
        if any(member.get('Name') not in allowed for member in obj.get('Containers', {}).values()):
            raise ValueError('Foreign container attached to Grafana network')
        self.gateway(obj)
        return obj

    def inspect(self, instance):
        name = self.name(instance)
        found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
        if not found:
            return None
        state = self.state(instance)
        native = state.get('schema') == 2
        network_name = self.installation + '_ingress' if native else self.name(instance, '-net')
        self.verify_image()
        obj = json.loads(self.docker('container', 'inspect', name))[0]
        config, host = obj.get('Config', {}), obj.get('HostConfig', {})
        mounts = {(m.get('Type'), m.get('Name') if m.get('Type') == 'volume' else m.get('Source'), m.get('Destination'), m.get('RW')) for m in obj.get('Mounts', [])}
        expected = {('volume', self.name(instance, '-data'), '/var/lib/grafana', True),
                    ('bind', str(self.paths(instance) / 'config/grafana.ini'), '/etc/grafana/grafana.ini', False)}
        ports = host.get('PortBindings') or {}
        if (not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', '')) or obj.get('Image') != self.image['id']
                or obj.get('Name') != '/' + name
                or config.get('Image') != self.image['id'] or config.get('User') != '472:0' or mounts != expected or len(obj.get('Mounts', [])) != 2
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())
                or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapDrop') != ['ALL'] or host.get('CapAdd')
                or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts')
                or host.get('NetworkMode') != network_name
                or set(obj.get('NetworkSettings', {}).get('Networks', {})) != {network_name} or set(ports) != {'3000/tcp'} or len(ports['3000/tcp']) != 1
                or ports['3000/tcp'][0].get('HostIp') != '127.0.0.1'
                or host.get('Memory') != 512 * 1024**2 or host.get('NanoCpus') != 1_000_000_000 or host.get('PidsLimit') != 128
                or not host.get('Init') or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('Tmpfs') != {'/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777'}
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or host.get('PidMode') not in ('', None) or host.get('IpcMode') not in ('private', None)
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])):
            raise ValueError('Grafana container drift')
        if native:
            if self.image['labels']['pl.build.variant'] != 'upstream-pinned':
                raise ValueError('Native Grafana requires the official upstream image')
            connection = obj['NetworkSettings']['Networks'][network_name]
            aliases = connection.get('Aliases') or []
            allowed_aliases = {'pl-grafana-' + instance, name, obj['Id'], obj['Id'][:12]}
            # Docker may not allocate an endpoint before the first start. The
            # named network is still inspected above; running/previously-started
            # containers must carry its exact persistent network identity.
            pending = obj.get('State', {}).get('Status') == 'created' and not obj.get('State', {}).get('Running')
            if ((connection.get('NetworkID') != state['network_id'] and not (pending and not connection.get('NetworkID')))
                    or aliases.count('pl-grafana-' + instance) != 1
                    or set(aliases) - allowed_aliases):
                raise ValueError('Grafana ingress alias/identity drift')
        image_config = self.verify_image().get('Config', {})
        if any(config.get(k) != image_config.get(k) for k in ('Entrypoint', 'Cmd', 'Env', 'WorkingDir')) or self.volume(instance) is None or self.network(instance) is None:
            raise ValueError('Grafana runtime identity drift')
        return obj

    def create(self, instance):
        self.verify_image()
        if self.state(instance).get('schema') != 2:
            raise LegacyMigrationRequired('Legacy Grafana requires explicit native-auth migration')
        args = ['container', 'create', '--name', self.name(instance), '--network', self.installation + '_ingress',
                '--network-alias', 'pl-grafana-' + instance, '--user', '472:0',
                '--restart', 'unless-stopped', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864,mode=1777',
                '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2', '--publish', '127.0.0.1::3000',
                '--mount', 'type=volume,source=' + self.name(instance, '-data') + ',target=/var/lib/grafana',
                '--mount', 'type=bind,source=' + str(self.paths(instance) / 'config/grafana.ini') + ',target=/etc/grafana/grafana.ini,readonly']
        for key, value in self.labels(instance).items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.image['id'])
        if self.inspect(instance) is None:
            raise ValueError('Grafana creation unconfirmed')

    def endpoint(self, obj):
        ports = obj.get('NetworkSettings', {}).get('Ports', {}).get('3000/tcp') or []
        if len(ports) != 1 or ports[0].get('HostIp') != '127.0.0.1' or not str(ports[0].get('HostPort', '')).isdigit() or not 1 <= int(ports[0]['HostPort']) <= 65535:
            raise ValueError('Invalid Grafana loopback binding')
        return 'http://127.0.0.1:' + ports[0]['HostPort']

    def http(self, instance, obj):
        # Native lifecycle health is unauthenticated.
        origin = urllib.parse.urlsplit(self.state(instance)['root_url'])
        req = urllib.request.Request(self.endpoint(obj) + '/grafana/api/health',
                                     headers={'Accept-Encoding': 'identity', 'Host': origin.netloc}, method='GET')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            response = opener.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE or response.status != 200:
                raise ValueError('Invalid Grafana health response')
            return response.status, response.headers.get_content_type(), data

    def ready(self, instance):
        obj = self.inspect(instance)
        if not obj or not obj.get('State', {}).get('Running'):
            raise ValueError('Grafana is stopped')
        status, _, data = self.http(instance, obj)
        health = json.loads(data)
        if status != 200 or not isinstance(health, dict) or health.get('database') != 'ok' or health.get('version') != self.version:
            raise ValueError('Grafana database/version readiness failed')
        return obj

    def observe(self, instance):
        return self._observe(instance)

    def initial_login(self, body):
        if (not isinstance(body, dict) or set(body) != {'instance_id', 'module_id', 'service'}
                or body.get('module_id') != 'grafana' or body.get('service') != 'grafana'):
            raise ValueError('Invalid Grafana initial login request')
        instance = identifier(body['instance_id'])
        with self.instance_lock(instance):
            state = self.state(instance)
            if state.get('schema') != 2 or self.image['labels']['pl.build.variant'] != 'upstream-pinned':
                raise ValueError('Grafana initial login unavailable for legacy installation')
            obj = self.inspect(instance)
            if not obj or not obj.get('State', {}).get('Running'):
                raise ValueError('Grafana initial login unavailable')
            # Official defaults.ini supplies this initial human account. The
            # native password may have changed; do not query/reset it or expose
            # secret_key or the legacy pl-bootstrap service account.
            return {'instance_id': instance, 'module_id': 'grafana', 'service': 'grafana',
                    'username': 'admin', 'password': 'admin', 'path': '/grafana/login'}

    def _observe(self, instance):
        base = self.instances / identifier(instance)
        if not base.exists() and not base.is_symlink():
            if self.volume(instance) or self.network(instance) or self.inspect(instance):
                raise ValueError('Grafana artifacts without state')
            return {'state': 'absent', 'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        self.state(instance)
        obj = self.inspect(instance)
        if not obj:
            raise ValueError('Grafana container missing')
        result = {'state': 'disabled', 'version': self.version, 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        if obj.get('State', {}).get('Running'):
            self.ready(instance)
            endpoint = ('http://pl-grafana-' + instance + ':3000' if self.journal(instance).get('schema') == 2
                        else self.endpoint(obj))
            result.update(state='running', endpoint=endpoint)
        return result

    def ensure(self, instance, origin, prometheus=''):
        self.initialize(instance, origin, prometheus)
        self.volume(instance, create=True)
        self.network(instance)
        obj = self.inspect(instance)
        if obj is None:
            self.create(instance)
            obj = self.inspect(instance)
        if not obj.get('State', {}).get('Running'):
            self.docker('container', 'start', obj['Id'])
        deadline = time.monotonic() + 60
        while True:
            try:
                self.ready(instance)
                return
            except (OSError, ValueError):
                if time.monotonic() >= deadline:
                    raise ValueError('Grafana readiness unconfirmed') from None
                time.sleep(0.25)

    def remove(self, instance):
        base = self.instances / identifier(instance)
        journal = self.operations / ('remove-' + instance + '.json')
        expected = {'state.json': 0o600, 'config/grafana.ini': 0o444}
        if not base.exists() and not base.is_symlink():
            self.observe(instance)
            if journal.exists() or journal.is_symlink():
                value = json.loads(read_file(journal))
                if value.get('installation') != self.installation or value.get('instance_id') != instance:
                    raise ValueError('Invalid Grafana removal journal')
                journal.unlink()
                fsync_directory(self.operations)
            return
        if not journal.exists() and not journal.is_symlink():
            self.state(instance)
            self.inspect(instance)
            self.volume(instance)
            self.network(instance)
            if set(p.name for p in base.iterdir()) != {'state.json', 'config'} or set(p.name for p in (base / 'config').iterdir()) != {'grafana.ini'}:
                raise ValueError('Unknown Grafana removal files')
            atomic(journal, {'installation': self.installation, 'instance_id': instance,
                             'files': {name: hashlib.sha256(read_file(base / name, mode=mode)).hexdigest() for name, mode in expected.items()}})
        value = json.loads(read_file(journal))
        if set(value) != {'installation', 'instance_id', 'files'} or value['installation'] != self.installation or value['instance_id'] != instance or set(value['files']) != set(expected):
            raise ValueError('Invalid Grafana removal journal')
        directory(base, create=False)
        if set(p.name for p in base.iterdir()) - {'state.json', 'config'}:
            raise ValueError('Unknown Grafana removal files')
        config = base / 'config'
        if config.exists() or config.is_symlink():
            directory(config, create=False, mode=0o755)
            if set(p.name for p in config.iterdir()) - {'grafana.ini'}:
                raise ValueError('Unknown Grafana configuration')
        for name, mode in expected.items():
            path = base / name
            if (path.exists() or path.is_symlink()) and hashlib.sha256(read_file(path, mode=mode)).hexdigest() != value['files'][name]:
                raise ValueError('Grafana removal artifact changed')
        statepath = base / 'state.json'
        if statepath.exists() or statepath.is_symlink():
            state = self.journal(instance)
            obj = self.inspect(instance)
            if obj:
                if obj.get('State', {}).get('Running'):
                    self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                self.docker('container', 'rm', obj['Id'])
            # Recheck before any removal: an attached foreign container is never removed.
            self.network(instance)
            if self.volume(instance):
                self.docker('volume', 'rm', self.name(instance, '-data'))
            if self.volume(instance):
                raise ValueError('Grafana volume removal unconfirmed')
            prom = state.get('prometheus_instance_id', '')
            network = self.network(instance)
            attached = self.parent.inspect(prom) if prom else None
            if network and attached and (attached['Id'] in network.get('Containers', {})
                    or self.name(instance, '-net') in attached.get('NetworkSettings', {}).get('Networks', {})):
                self.docker('network', 'disconnect', self.name(instance, '-net'), attached['Id'])
                if attached['Id'] in (self.network(instance) or {}).get('Containers', {}):
                    raise ValueError('Prometheus network detachment unconfirmed')
            if state.get('schema') != 2:
                if self.network(instance):
                    self.docker('network', 'rm', self.name(instance, '-net'))
                if self.network(instance):
                    raise ValueError('Grafana network removal unconfirmed')
        elif self.inspect(instance) or self.volume(instance) or self.network(instance):
            # State is unlinked only after runtime cleanup. A crash may leave
            # empty directories, but cannot authorize deleting recreated assets.
            raise ValueError('Grafana artifacts reappeared after state cleanup')
        for name in ('config/grafana.ini', 'state.json'):
            (base / name).unlink(missing_ok=True)
        if config.exists():
            config.rmdir()
        base.rmdir()
        fsync_directory(self.instances)
        journal.unlink()
        fsync_directory(self.operations)

    def execute(self, body):
        if (not isinstance(body, dict) or set(body) - {'operation_id', 'instance_id', 'module_id', 'action', 'public_url', 'prometheus_instance_id'}
                or not {'operation_id', 'instance_id', 'module_id', 'action'} <= set(body)
                or body.get('module_id') != 'grafana' or body.get('action') not in ('install', 'enable', 'disable', 'refresh', 'remove')):
            raise ValueError('Unsupported Grafana operation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        refreshing = body['action'] == 'refresh'
        with _files.operation_lock(self.operations, operation), self.instance_lock(instance, exclusive=not refreshing), \
                (nullcontext() if refreshing else self.locked()):
            path = self.operations / (operation + '.json')
            fingerprint = hashlib.sha256(encoded(body)).hexdigest()
            if path.exists() or path.is_symlink():
                previous = json.loads(read_file(path))
                if previous.get('fingerprint') != fingerprint:
                    raise ValueError('Grafana operation ID conflict')
                if previous.get('phase') == 'complete':
                    return {**self.observe(instance), 'operation_id': operation}
            atomic(path, {'fingerprint': fingerprint, 'phase': 'running'})
            try:
                if body['action'] in ('install', 'enable'):
                    self.ensure(instance, body.get('public_url', ''), body.get('prometheus_instance_id', ''))
                elif body['action'] == 'disable':
                    obj = self.inspect(instance)
                    if obj and obj.get('State', {}).get('Running'):
                        self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                elif body['action'] == 'remove':
                    self.remove(instance)
                result = {**self.observe(instance), 'operation_id': operation}
                atomic(path, {'fingerprint': fingerprint, 'phase': 'complete'})
                return result
            except (ValueError, OSError, KeyError, TypeError) as error:
                return {'state': 'error', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0,
                        'error': (str(error) if isinstance(error, LegacyMigrationRequired) else
                                  _files.module_network_error(error, 'Grafana operation unconfirmed; reconcile the same operation')),
                        'operation_id': operation}

    def get(self, instance):
        with self.instance_lock(instance):
            return self.observe(identifier(instance))

    def request(self, body):
        fields = {'instance_id', 'method', 'path', 'query', 'content_type', 'body',
                  'user_id', 'user_name', 'admin', 'browser_session'}
        if not isinstance(body, dict) or set(body) != fields:
            raise ValueError('Grafana uses direct native HTTP proxy; controller gateway is unsupported')
        session = body['browser_session']
        if (body['user_id'] != 'system:modules:provider' or body['admin'] is not False
                or not isinstance(session, str) or not SESSION_VALUE.fullmatch(session)):
            raise ValueError('Invalid Grafana chart session')
        instance = identifier(body['instance_id'])
        method, path, query = body['method'], body['path'], body['query']
        content_type, raw = body['content_type'], body['body']
        if not isinstance(path, str) or not isinstance(raw, str):
            raise ValueError('Invalid Grafana chart request')
        if method == 'GET':
            if path == '/grafana/api/search':
                allowed = query == 'limit=201&type=dash-db'
            else:
                allowed = query == '' and (path == '/grafana/api/datasources' or CHART_DASHBOARD_PATH.fullmatch(path))
            if not allowed or raw != '' or content_type != '':
                raise ValueError('Invalid Grafana chart read')
            payload = None
        elif (method == 'POST' and path == '/grafana/api/ds/query' and query == ''
              and content_type == 'application/json' and len(raw) <= 4 * ((MAX_CHART_BODY + 2) // 3)):
            payload = base64.b64decode(raw, validate=True)
            if not 0 < len(payload) <= MAX_CHART_BODY or not isinstance(json.loads(payload), dict):
                raise ValueError('Invalid Grafana chart query')
        else:
            raise ValueError('Invalid Grafana chart route')

        with self.instance_lock(instance):
            obj = self.inspect(instance)
            if obj is None or not obj['State'].get('Running'):
                raise ValueError('Grafana module is unavailable')
            state = self.journal(instance)
            if state.get('schema') != 2:
                raise ValueError('Grafana native session is unavailable')
            origin = urllib.parse.urlsplit(state['root_url'])
            endpoint = self.endpoint(obj)
            address = endpoint + path + ('?' + query if query else '')
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
            status, data, cookies = self.chart_response(opener, address, origin, method, payload, session)
            if status == 401:
                try:
                    error = json.loads(data)
                except ValueError:
                    error = None
                if isinstance(error, dict) and error.get('messageId') == 'session.token.rotate':
                    rotated, _, rotated_cookies = self.chart_response(
                        opener, endpoint + '/grafana/api/user/auth-tokens/rotate', origin, 'POST', None, session)
                    if 200 <= rotated < 300:
                        renewed = self.chart_session_cookie(rotated_cookies)
                        if renewed:
                            status, data, cookies = self.chart_response(opener, address, origin, method, payload, renewed)
                            cookies = rotated_cookies + cookies
        # An expired Grafana login can redirect to its login page. Never follow it.
        if 300 <= status < 400:
            status, data = 401, b''
        return {'instance_id': instance, 'status': status, 'content_type': 'application/json',
                'body': base64.b64encode(data).decode('ascii'), 'set_cookies': cookies}

    @staticmethod
    def chart_response(opener, address, origin, method, payload, session):
        headers = {'Accept': 'application/json', 'Accept-Encoding': 'identity',
                   'Host': origin.netloc, 'X-Forwarded-Proto': origin.scheme,
                   'Cookie': 'grafana_session=' + session}
        if method == 'POST':
            headers.update({'Content-Type': 'application/json', 'Origin': origin.scheme + '://' + origin.netloc})
        request = urllib.request.Request(address, headers=headers, method=method, data=payload)
        try:
            response = opener.open(request, timeout=12)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise ValueError('Grafana chart response exceeds limit')
            cookies = [value for value in response.headers.get_all('Set-Cookie', [])
                       if len(value) <= 1024 and value.partition('=')[0] in SESSION_COOKIES][:4]
            return response.status, data, cookies

    @staticmethod
    def chart_session_cookie(cookies):
        for raw in cookies:
            cookie = SimpleCookie()
            try:
                cookie.load(raw)
            except CookieError:
                continue
            value = cookie.get('grafana_session')
            if value and not value['domain'] and value['path'] in ('/grafana', '/grafana/') and SESSION_VALUE.fullmatch(value.value):
                return value.value
        return ''
