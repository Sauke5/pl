#!/usr/bin/env python3
"""Owned BookStack/MariaDB lifecycle; native authentication stays in BookStack."""
from __future__ import annotations
from contextlib import contextmanager, nullcontext
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import string
import time
import urllib.error
import urllib.parse
import urllib.request

_helper = Path(__file__).with_name('xray-controller.py')
if _helper.is_symlink() or not _helper.is_file():
    raise ValueError('Trusted file primitives unavailable')
_spec = importlib.util.spec_from_file_location('pl_bookstack_files', _helper)
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
identifier, directory, read_file = _files.identifier, _files.directory, _files.read_file
atomic, encoded, fsync_directory = _files.atomic, _files.encoded, _files.fsync_directory
ROLES = ('database', 'web')
SECRET_NAMES = ('app_key', 'database_password', 'root_password', 'admin_password')
CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID', 'NET_BIND_SERVICE']


def public_origin(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) <= 32 or ord(c) == 127 for c in value):
        raise ValueError('Invalid Platform origin')
    url = urllib.parse.urlsplit(value)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
            or url.path not in ('', '/') or url.query or url.fragment):
        raise ValueError('Invalid Platform origin')
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ValueError('Invalid Platform origin port')
    return url.scheme + '://' + url.netloc


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class BookStackController:
    def __init__(self, parent):
        self.parent, self.root, self.installation = parent, Path(parent.root), parent.installation
        self.docker = parent.docker
        self.images = self.resolve_images()
        self.version = self.images['web']['labels']['org.opencontainers.image.version']
        self.base = self.root / 'modules/bookstack'
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        for path in (self.base, self.instances, self.operations):
            directory(path)

    def resolve_images(self):
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        state = json.loads(read_file(self.root / 'state/installation.json'))
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or state.get('install_id') != self.installation or registry.get('manifest_sha256') != state.get('manifest_sha256')
                or not re.fullmatch(r'[0-9a-f]{64}', registry.get('manifest_sha256', ''))):
            raise ValueError('Invalid BookStack installation image contract')
        bundle = registry.get('bookstack', {})
        if not isinstance(bundle, dict) or set(bundle) != set(ROLES):
            raise ValueError('Incomplete BookStack image roles')
        for role, image in bundle.items():
            labels = image.get('labels', {})
            if (set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                    or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                    or image.get('architecture') not in ('amd64', 'arm64')
                    or image.get('recipe') != 'deploy/images/bookstack.Dockerfile'
                    or labels.get('pl.module.id') != 'bookstack' or labels.get('pl.module.role') != role
                    or labels.get('pl.module.config.version') != '1' or labels.get('pl.build.variant') != 'upstream-pinned'
                    or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', labels.get('pl.upstream.version', ''))
                    or (role == 'web' and labels.get('pl.upstream.version') != labels.get('org.opencontainers.image.version'))
                    or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', labels.get('org.opencontainers.image.version', ''))):
                raise ValueError('Invalid BookStack image contract')
        if len({image['labels']['org.opencontainers.image.version'] for image in bundle.values()}) != 1:
            raise ValueError('Mixed BookStack bundle versions')
        if len({image['architecture'] for image in bundle.values()}) != 1:
            raise ValueError('Mixed BookStack image architectures')
        return bundle

    def verify_image(self, role):
        expected = self.images[role]
        image = json.loads(self.docker('image', 'inspect', expected['id']))[0]
        if (image.get('Id') != expected['id'] or image.get('Os') != 'linux' or image.get('Architecture') != expected['architecture']
                or any((image.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in expected['labels'].items())):
            raise ValueError('BookStack image identity mismatch')
        return image

    @contextmanager
    def locked(self):
        fd = os.open(self.root / 'modules/controller.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600:
            os.close(fd)
            raise ValueError('Unsafe lifecycle lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    @contextmanager
    def instance_lock(self, instance, exclusive=False):
        fd = os.open(self.operations / ('instance-' + identifier(instance) + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600:
            os.close(fd)
            raise ValueError('Unsafe BookStack instance lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def name(self, instance, suffix=''):
        return self.installation + '-bookstack-' + identifier(instance) + suffix

    def labels(self, instance, role=''):
        values = {'pl.installation': self.installation, 'pl.module': 'bookstack', 'pl.instance': identifier(instance)}
        if role:
            values['pl.module.role'] = role
        return values

    def paths(self, instance, create=False):
        base = self.instances / identifier(instance)
        directory(base, create=create)
        directory(base / 'config', create=create, mode=0o755)
        return base

    def ingress_network(self):
        name = self.installation + '_ingress'
        if self.docker('network', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip() != name:
            raise ValueError('Core ingress network is missing')
        obj = json.loads(self.docker('network', 'inspect', name))[0]
        labels = obj.get('Labels') or {}
        if (obj.get('Name') != name or obj.get('Driver') != 'bridge' or obj.get('Scope') != 'local'
                or obj.get('Internal') or obj.get('Ingress') or labels.get('pl.installation') != self.installation
                or labels.get('com.docker.compose.project') != self.installation or labels.get('com.docker.compose.network') != 'ingress'
                or not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', ''))):
            raise ValueError('Core ingress ownership mismatch')
        return obj

    def journal(self, instance):
        value = json.loads(read_file(self.paths(instance) / 'state.json'))
        fields = {'schema', 'installation', 'instance_id', 'origin', 'ingress_id', 'images', *SECRET_NAMES}
        if (set(value) != fields or type(value.get('schema')) is not int or value['schema'] != 1
                or value.get('installation') != self.installation or value.get('instance_id') != instance
                or public_origin(value.get('origin')) != value.get('origin')
                or not re.fullmatch(r'[0-9a-f]{64}', value.get('ingress_id', ''))
                or value.get('images') != {role: self.images[role]['id'] for role in ROLES}
                or any(not re.fullmatch(r'[0-9a-f]{64}', value.get(name, '')) for name in SECRET_NAMES if name != 'admin_password')
                or not re.fullmatch(r'(?:[A-Za-z0-9]{8}|[0-9a-f]{64})', value.get('admin_password', ''))):
            raise ValueError('Invalid BookStack state; explicit migration required')
        configured = json.loads(read_file(self.root / 'state/installation.json')).get('config', {}).get('public_url')
        if public_origin(configured) != value['origin']:
            raise ValueError('BookStack installation origin drift')
        return value

    def credentials(self, state):
        return {name: (('base64:' + base64.b64encode(bytes.fromhex(state[name])).decode()) if name == 'app_key' else state[name]).encode()
                for name in SECRET_NAMES}

    def state(self, instance):
        state = self.journal(instance)
        if self.ingress_network()['Id'] != state['ingress_id']:
            raise ValueError('BookStack ingress identity changed')
        for name, expected in self.credentials(state).items():
            if read_file(self.paths(instance) / 'config' / name) != expected:
                raise ValueError('BookStack credential drift')
        return state

    def initialize(self, instance):
        base = self.paths(instance, create=True)
        path = base / 'state.json'
        if path.exists() or path.is_symlink():
            state = self.journal(instance)
        else:
            if list((base / 'config').iterdir()):
                raise ValueError('Unmanaged BookStack configuration')
            origin = public_origin(json.loads(read_file(self.root / 'state/installation.json')).get('config', {}).get('public_url'))
            state = {'schema': 1, 'installation': self.installation, 'instance_id': instance, 'origin': origin,
                     'ingress_id': self.ingress_network()['Id'], 'images': {role: self.images[role]['id'] for role in ROLES},
                     **{name: secrets.token_hex(32) for name in SECRET_NAMES if name != 'admin_password'},
                     'admin_password': ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8))}
            atomic(path, state)
        if set(p.name for p in (base / 'config').iterdir()) - set(SECRET_NAMES):
            raise ValueError('Unknown BookStack configuration files')
        for name, value in self.credentials(state).items():
            secret = base / 'config' / name
            if secret.exists() or secret.is_symlink():
                if read_file(secret) != value:
                    raise ValueError('BookStack credential drift')
            else:
                atomic(secret, value)
        self.state(instance)

    def resource(self, instance, kind, volume='database'):
        if kind not in ('network', 'volume') or volume not in ('database', 'config'):
            raise ValueError('Invalid BookStack resource role')
        name = self.name(instance, '-net' if kind == 'network' else '-' + volume + '-data')
        found = self.docker(kind, 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found:
            return None
        obj = json.loads(self.docker(kind, 'inspect', name))[0]
        if kind == 'network':
            _files.validate_module_network(self.root, self.installation, obj, self.docker)
        if (found != name or obj.get('Name') != name or obj.get('Driver') != ('local' if kind == 'volume' else 'bridge')
                or obj.get('Options') or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())
                or (kind == 'network' and (obj.get('Internal') or obj.get('Ingress') or obj.get('Scope') != 'local'
                    or not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', ''))))):
            raise ValueError('BookStack resource ownership mismatch')
        if kind == 'network':
            allowed = {self.name(instance, '-' + role) for role in ROLES}
            if any(member.get('Name') not in allowed for member in obj.get('Containers', {}).values()):
                raise ValueError('Foreign container attached to BookStack network')
        return obj

    def create_resource(self, instance, kind, volume='database'):
        if self.resource(instance, kind, volume) is None:
            args = [kind, 'create']
            if kind == 'network':
                args += ['--driver', 'bridge'] + _files.module_network_args(self.root, self.installation, self.docker)
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, self.name(instance, '-net' if kind == 'network' else '-' + volume + '-data'))
        if self.resource(instance, kind, volume) is None:
            raise ValueError('BookStack resource creation unconfirmed')

    def specification(self, instance, role):
        state, config = self.state(instance), self.paths(instance) / 'config'
        if role == 'database':
            env = {'MARIADB_DATABASE': 'bookstack', 'MARIADB_USER': 'bookstack',
                   'MARIADB_PASSWORD_FILE': '/run/secrets/database_password', 'MARIADB_ROOT_PASSWORD_FILE': '/run/secrets/root_password'}
            mounts = [('volume', self.name(instance, '-database-data'), '/var/lib/mysql', True)]
            names = ('database_password', 'root_password')
        elif role == 'web':
            env = {'APP_URL': state['origin'] + '/wiki', 'DB_HOST': 'database', 'DB_PORT': '3306',
                   'DB_DATABASE': 'bookstack', 'DB_USERNAME': 'bookstack', 'AUTH_METHOD': 'standard',
                   'FILE__DB_PASSWORD': '/run/secrets/database_password', 'FILE__APP_KEY': '/run/secrets/app_key',
                   'SESSION_COOKIE_NAME': 'pl_bookstack_session', 'PUID': '1000', 'PGID': '1000', 'TZ': 'UTC'}
            mounts = [('volume', self.name(instance, '-config-data'), '/config', True)]
            names = ('database_password', 'app_key', 'admin_password')
        else:
            raise ValueError('Invalid BookStack container role')
        mounts += [('bind', str(config / name), '/run/secrets/' + name, False) for name in names]
        return env, mounts

    def inspect(self, instance, role, allow_pending=False):
        name = self.name(instance, '-' + role)
        found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
        if not found:
            return None
        image = self.verify_image(role)
        env, expected_mounts = self.specification(instance, role)
        obj = json.loads(self.docker('container', 'inspect', name))[0]
        config, host = obj.get('Config', {}), obj.get('HostConfig', {})
        mounts = {(m.get('Type'), m.get('Name') if m.get('Type') == 'volume' else m.get('Source'), m.get('Destination'), m.get('RW')) for m in obj.get('Mounts', [])}
        expected_env = dict(item.split('=', 1) for item in image.get('Config', {}).get('Env', []))
        expected_env.update(env)
        actual_env = config.get('Env') or []
        working_dir = config.get('WorkingDir')
        image_working_dir = image.get('Config', {}).get('WorkingDir')
        ports = host.get('PortBindings') or {}
        networks = obj.get('NetworkSettings', {}).get('Networks', {})
        private = self.name(instance, '-net')
        ingress = self.installation + '_ingress'
        missing_ingress = (role == 'web' and set(networks) == {private} and allow_pending
                           and obj.get('State', {}).get('Status') == 'created' and not obj.get('State', {}).get('Running'))
        expected_networks = {private} | ({ingress} if role == 'web' and not missing_ingress else set())
        port_ok = not ports if role == 'database' else (set(ports) == {'80/tcp'} and len(ports['80/tcp']) == 1 and ports['80/tcp'][0].get('HostIp') == '127.0.0.1')
        if (not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', '')) or obj.get('Image') != self.images[role]['id']
                or obj.get('Name') != '/' + name or config.get('Image') != self.images[role]['id']
                or mounts != set(expected_mounts) or len(obj.get('Mounts', [])) != len(expected_mounts)
                or dict(item.split('=', 1) for item in actual_env) != expected_env or len(actual_env) != len(expected_env)
                or config.get('User', '') != ''
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.labels(instance, role).items())
                or any(config.get(k) != image.get('Config', {}).get(k) for k in ('Entrypoint', 'Cmd'))
                or ('' if working_dir is None else working_dir) != ('' if image_working_dir is None else image_working_dir)
                or not port_ok or host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapDrop') != ['ALL']
                # Docker canonicalizes CHOWN to CAP_CHOWN in inspect output.
                # Compare the exact capability list, including duplicates, after
                # removing only that representation prefix; extra privileges fail.
                or not isinstance(host.get('CapAdd'), list)
                or any(not isinstance(cap, str) for cap in host['CapAdd'])
                or sorted(cap.removeprefix('CAP_') for cap in host['CapAdd']) != sorted(CAPS)
                or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts')
                or host.get('NetworkMode') != private or set(networks) != expected_networks
                or host.get('Memory') != 512 * 1024**2 or host.get('NanoCpus') != 1_000_000_000 or host.get('PidsLimit') != 256
                or host.get('Init') or host.get('Tmpfs') or host.get('PidMode') not in ('', None) or host.get('IpcMode') not in ('private', None)
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])):
            raise ValueError('BookStack container drift')
        network = self.resource(instance, 'network')
        if not network or not self.resource(instance, 'volume', 'database') or not self.resource(instance, 'volume', 'config'):
            raise ValueError('BookStack resources missing')
        for network_name, alias, identity in [(private, role, network['Id'])] + ([(ingress, 'pl-bookstack-' + instance, self.state(instance)['ingress_id'])] if role == 'web' and not missing_ingress else []):
            connection = networks[network_name]
            aliases = connection.get('Aliases') or []
            pending = obj.get('State', {}).get('Status') == 'created' and not obj.get('State', {}).get('Running')
            if ((connection.get('NetworkID') != identity and not (pending and not connection.get('NetworkID')))
                    or aliases.count(alias) != 1 or set(aliases) - {alias, name, obj['Id'], obj['Id'][:12]}):
                raise ValueError('BookStack network identity or alias drift')
        return obj

    def create_container(self, instance, role):
        self.verify_image(role)
        env, mounts = self.specification(instance, role)
        args = ['container', 'create', '--name', self.name(instance, '-' + role), '--network', self.name(instance, '-net'),
                '--network-alias', role, '--restart', 'unless-stopped', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                '--memory', '512m', '--cpus', '1', '--pids-limit', '256', '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2']
        for capability in CAPS:
            args += ['--cap-add', capability]
        for key, value in env.items():
            args += ['--env', key + '=' + value]
        for kind, source, target, writable in mounts:
            args += ['--mount', 'type=' + kind + ',source=' + source + ',target=' + target + ('' if writable else ',readonly')]
        if role == 'web':
            args += ['--publish', '127.0.0.1::80']
        for key, value in self.labels(instance, role).items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.images[role]['id'])
        if self.inspect(instance, role, allow_pending=True) is None:
            raise ValueError('BookStack creation unconfirmed')

    def endpoint(self, obj):
        ports = obj.get('NetworkSettings', {}).get('Ports', {}).get('80/tcp') or []
        if (len(ports) != 1 or ports[0].get('HostIp') != '127.0.0.1' or not str(ports[0].get('HostPort', '')).isdigit()
                or not 1 <= int(ports[0]['HostPort']) <= 65535):
            raise ValueError('Invalid BookStack loopback binding')
        return 'http://127.0.0.1:' + ports[0]['HostPort']

    def http(self, instance, obj):
        state = self.state(instance)
        req = urllib.request.Request(self.endpoint(obj) + '/status', method='GET', headers={
            'Accept-Encoding': 'identity', 'Host': urllib.parse.urlsplit(state['origin']).netloc})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            response = opener.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(65537)
            if response.status != 200 or len(raw) > 65536:
                raise ValueError('BookStack status failed')
            return json.loads(raw)

    def ready(self, instance):
        objects = {role: self.inspect(instance, role) for role in ROLES}
        if any(not obj or not obj.get('State', {}).get('Running') for obj in objects.values()):
            raise ValueError('BookStack components are stopped')
        health = self.http(instance, objects['web'])
        if not isinstance(health, dict) or any(health.get(key) is not True for key in ('database', 'cache', 'session')):
            raise ValueError('BookStack database/cache/session readiness failed')
        return objects['web']

    def ensure(self, instance):
        self.initialize(instance)
        self.create_resource(instance, 'network')
        for volume in ('database', 'config'):
            self.create_resource(instance, 'volume', volume)
        for role in ROLES:
            obj = self.inspect(instance, role, allow_pending=True)
            if obj is None:
                self.create_container(instance, role)
                obj = self.inspect(instance, role, allow_pending=True)
            if role == 'web' and self.installation + '_ingress' not in obj['NetworkSettings']['Networks']:
                self.docker('network', 'connect', '--alias', 'pl-bookstack-' + instance, self.installation + '_ingress', obj['Id'])
                obj = self.inspect(instance, role)
            if not obj.get('State', {}).get('Running'):
                self.docker('container', 'start', obj['Id'])
        deadline = time.monotonic() + 120
        while True:
            try:
                self.ready(instance)
                return
            except (OSError, ValueError):
                if time.monotonic() >= deadline:
                    raise ValueError('BookStack readiness unconfirmed') from None
                time.sleep(0.5)

    def observe(self, instance):
        base = self.instances / identifier(instance)
        result = {'state': 'absent', 'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        if not base.exists() and not base.is_symlink():
            if (any(self.resource(instance, kind, volume) for kind, volume in (('network', 'database'), ('volume', 'database'), ('volume', 'config')))
                    or any(self.inspect(instance, role) for role in ROLES)):
                raise ValueError('BookStack artifacts without state')
            return result
        self.state(instance)
        objects = [self.inspect(instance, role) for role in ROLES]
        if any(obj is None for obj in objects):
            raise ValueError('BookStack components incomplete')
        running = [bool(obj.get('State', {}).get('Running')) for obj in objects]
        if any(running) and not all(running):
            raise ValueError('BookStack components have mixed state')
        result.update(state='disabled', version=self.version)
        if all(running):
            self.ready(instance)
            result.update(state='running', endpoint='http://pl-bookstack-' + instance + ':80')
        return result

    def remove(self, instance):
        base = self.instances / identifier(instance)
        marker = self.operations / ('remove-' + instance + '.json')
        expected = {'state.json': 0o600, **{'config/' + name: 0o600 for name in SECRET_NAMES}}
        if not base.exists() and not base.is_symlink():
            self.observe(instance)
            if marker.exists() or marker.is_symlink():
                value = json.loads(read_file(marker))
                if value.get('installation') != self.installation or value.get('instance_id') != instance:
                    raise ValueError('Invalid BookStack removal journal')
                marker.unlink()
                fsync_directory(self.operations)
            return
        if not marker.exists() and not marker.is_symlink():
            self.state(instance)
            if set(p.name for p in base.iterdir()) != {'state.json', 'config'} or set(p.name for p in (base / 'config').iterdir()) != set(SECRET_NAMES):
                raise ValueError('Unknown BookStack removal files')
            self.assert_removable(instance)
            atomic(marker, {'installation': self.installation, 'instance_id': instance,
                           'files': {name: hashlib.sha256(read_file(base / name, mode=mode)).hexdigest() for name, mode in expected.items()}})
        value = json.loads(read_file(marker))
        if (set(value) != {'installation', 'instance_id', 'files'} or value['installation'] != self.installation
                or value['instance_id'] != instance or not isinstance(value['files'], dict) or set(value['files']) != set(expected)
                or any(not re.fullmatch(r'[0-9a-f]{64}', digest) for digest in value['files'].values())):
            raise ValueError('Invalid BookStack removal journal')
        directory(base, create=False)
        if set(p.name for p in base.iterdir()) - {'state.json', 'config'}:
            raise ValueError('Unknown BookStack removal artifacts')
        config = base / 'config'
        if config.exists() or config.is_symlink():
            directory(config, create=False, mode=0o755)
            if set(p.name for p in config.iterdir()) - set(SECRET_NAMES):
                raise ValueError('Unknown BookStack removal configuration')
        for name, mode in expected.items():
            path = base / name
            if (path.exists() or path.is_symlink()) and hashlib.sha256(read_file(path, mode=mode)).hexdigest() != value['files'][name]:
                raise ValueError('BookStack removal artifact changed')
        # Runtime cleanup precedes every unlink, so interrupted unlinks need no credentials.
        if (base / 'state.json').exists():
            objects = self.assert_removable(instance)
            for obj in reversed(objects):
                if obj:
                    if obj.get('State', {}).get('Running'):
                        self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                    self.docker('container', 'rm', obj['Id'])
            for kind, volume in (('volume', 'config'), ('volume', 'database'), ('network', 'database')):
                if self.resource(instance, kind, volume):
                    self.docker(kind, 'rm', self.name(instance, '-net' if kind == 'network' else '-' + volume + '-data'))
                if self.resource(instance, kind, volume):
                    raise ValueError('BookStack removal unconfirmed')
        elif (any(self.resource(instance, kind, volume) for kind, volume in (('network', 'database'), ('volume', 'database'), ('volume', 'config')))
                or any(self.inspect(instance, role) for role in ROLES)):
            raise ValueError('BookStack artifacts reappeared after cleanup')
        for name in [*('config/' + name for name in SECRET_NAMES), 'state.json']:
            (base / name).unlink(missing_ok=True)
        if config.exists():
            config.rmdir()
        base.rmdir()
        fsync_directory(self.instances)
        marker.unlink()
        fsync_directory(self.operations)

    def assert_removable(self, instance):
        objects = [self.inspect(instance, role, allow_pending=True) for role in ROLES]
        network = self.resource(instance, 'network')
        if network and set(network.get('Containers', {})) - {obj['Id'] for obj in objects if obj}:
            raise ValueError('Foreign container attached to BookStack network')
        for volume in ('database', 'config'):
            self.resource(instance, 'volume', volume)
        return objects

    def execute(self, body):
        if (not isinstance(body, dict) or set(body) - {'operation_id', 'instance_id', 'module_id', 'action', 'public_url'}
                or not {'operation_id', 'instance_id', 'module_id', 'action'} <= set(body) or body.get('module_id') != 'bookstack'
                or body.get('action') not in ('install', 'enable', 'disable', 'refresh', 'remove')):
            raise ValueError('Unsupported BookStack operation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        configured = json.loads(read_file(self.root / 'state/installation.json')).get('config', {}).get('public_url')
        if 'public_url' in body and public_origin(body['public_url']) != public_origin(configured):
            raise ValueError('BookStack operation origin mismatch')
        refreshing = body['action'] == 'refresh'
        with _files.operation_lock(self.operations, operation), self.instance_lock(instance, exclusive=not refreshing), \
                (nullcontext() if refreshing else self.locked()):
            path = self.operations / (operation + '.json')
            fingerprint = hashlib.sha256(encoded(body)).hexdigest()
            if path.exists() or path.is_symlink():
                previous = json.loads(read_file(path))
                if previous.get('fingerprint') != fingerprint:
                    raise ValueError('BookStack operation ID conflict')
                if previous.get('phase') == 'complete':
                    return {**self.observe(instance), 'operation_id': operation}
            atomic(path, {'fingerprint': fingerprint, 'phase': 'running'})
            try:
                if body['action'] in ('install', 'enable'):
                    self.ensure(instance)
                elif body['action'] == 'disable':
                    for role in reversed(ROLES):
                        obj = self.inspect(instance, role)
                        if obj and obj.get('State', {}).get('Running'):
                            self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                elif body['action'] == 'remove':
                    self.remove(instance)
                result = {**self.observe(instance), 'operation_id': operation}
                atomic(path, {'fingerprint': fingerprint, 'phase': 'complete'})
                return result
            except (ValueError, OSError, KeyError, TypeError) as error:
                return {'state': 'error', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0,
                        'error': _files.module_network_error(error, 'BookStack operation unconfirmed; reconcile the same operation'), 'operation_id': operation}

    def get(self, instance):
        instance = identifier(instance)
        with self.instance_lock(instance):
            return self.observe(instance)

    def initial_login(self, body):
        if (not isinstance(body, dict) or set(body) != {'instance_id', 'module_id', 'service'}
                or body.get('module_id') != 'bookstack' or body.get('service') != 'bookstack'):
            raise ValueError('Invalid BookStack initial login request')
        instance = identifier(body['instance_id'])
        with self.instance_lock(instance):
            state = self.state(instance)
            obj = self.inspect(instance, 'web')
            if not obj or not obj.get('State', {}).get('Running'):
                raise ValueError('BookStack initial login unavailable')
            # Initial human administrator only; no database or application key.
            return {'instance_id': instance, 'module_id': 'bookstack', 'service': 'bookstack',
                    'username': 'admin@pl.invalid', 'password': state['admin_password'], 'path': '/wiki/login'}

    def request(self, body):
        raise ValueError('BookStack uses direct native HTTP proxy')
