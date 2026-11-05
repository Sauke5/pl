#!/usr/bin/env python3
"""Owned Forms/HeyForm lifecycle and a finite signed gateway-v2 transport."""
from __future__ import annotations
import base64
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
import fcntl
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import time
import threading
import urllib.error
import urllib.parse
import urllib.request

_helper = Path(__file__).with_name('xray-controller.py')
if _helper.is_symlink() or not _helper.is_file():
    raise ValueError('Trusted Forms file primitives unavailable')
_spec = importlib.util.spec_from_file_location('pl_forms_files', _helper)
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
identifier, directory, read_file = _files.identifier, _files.directory, _files.read_file
atomic, encoded, fsync_directory = _files.atomic, _files.encoded, _files.fsync_directory
ROLES = ('mongo', 'keydb', 'engine', 'adapter')
ALL_ROLES = (*ROLES, 'engine-bootstrap')
VOLUMES = {'mongo': '/data/db', 'mongo-config': '/data/configdb', 'keydb': '/data', 'assets': '/app/packages/server/static/upload', 'adapter': '/data'}
GID = 10001
MAX_BODY, MAX_RESPONSE = 3 * 1024 * 1024, 4 * 1024 * 1024
ROUTE_MAX_AGE = 30
STATE_FIELDS = {'public_url', 'installation', 'instance_id', 'gateway_key', 'service', 'session_key', 'encryption_key', 'keydb_password', 'bootstrapped'}
CONFIG_FILES = ('forms-gateway.key', 'forms-service.json', 'forms-engine.json', 'forms-keydb.conf')
MEMORY = {'mongo': 1024, 'keydb': 256, 'engine': 1024, 'engine-bootstrap': 1024, 'adapter': 256}
CPUS = {'mongo': 1_000_000_000, 'keydb': 500_000_000, 'engine': 1_500_000_000, 'engine-bootstrap': 1_500_000_000, 'adapter': 500_000_000}
PIDS = {'mongo': 256, 'keydb': 128, 'engine': 128, 'engine-bootstrap': 128, 'adapter': 128}


def private_adapter_bindings(requested, observed):
    # New adapters publish nothing. Preserve only an older loopback reservation;
    # Docker may leave it dormant on an Internal bridge or publish it on loopback.
    if not isinstance(requested, dict) or not isinstance(observed, dict):
        return False
    if not requested:
        return not any(observed.values())
    if set(requested) != {'8091/tcp'} or set(observed) - {'8091/tcp'}:
        return False
    def loopback(bindings, optional=False):
        if optional and (bindings is None or bindings == []):
            return True
        if not isinstance(bindings, list) or len(bindings) != 1 or bindings[0].get('HostIp') != '127.0.0.1':
            return False
        port = bindings[0].get('HostPort')
        if not optional and port == '':
            return True
        return isinstance(port, str) and port.isdigit() and 1 <= int(port) <= 65535
    return loopback(requested['8091/tcp']) and loopback(observed.get('8091/tcp'), optional=True)


def normalized_working_dir(value):
    # Docker represents its unset root WorkingDir as absent, null, '' or '/'.
    # These are one default, not drift. Other paths retain exact comparison.
    if value is None:
        return '/'
    if not isinstance(value, str):
        raise ValueError('Forms container drift: invalid WorkingDir type')
    return '/' if value == '' else value


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def csrf(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', value):
        raise ValueError('Invalid Forms CSRF token')
    raw = base64.urlsafe_b64decode(value + '=')
    if len(raw) != 32 or b64(raw) != value:
        raise ValueError('Invalid Forms CSRF token')
    return value


def request_scope(method, path, query, content_type, raw, admin, idempotency=''):
    if (type(admin) is not bool or not isinstance(path, str) or len(path) > 1024
            or not path.startswith('/forms/') or query != ''
            or any(c in path for c in ('%', '\\', '?', '#', '//')) or '..' in path.split('/')
            or any(ord(c) <= 32 or ord(c) == 127 for c in path)
            or not isinstance(content_type, str) or len(content_type) > 256
            or any(ord(c) < 32 or ord(c) > 126 for c in content_type) or len(raw) > MAX_BODY):
        raise ValueError('Invalid Forms route')
    scope = ''
    if method in ('GET', 'HEAD') and path in ('/forms/', '/forms/index.html', '/forms/app.js', '/forms/styles.css', '/forms/theme.js'):
        scope = 'forms:read'
    elif method == 'GET' and path in ('/forms/api/v1/context', '/forms/api/v1/surveys'):
        scope = 'forms:read'
    elif method == 'POST' and path == '/forms/api/v1/surveys':
        scope = 'forms:admin'
    else:
        match = re.fullmatch(r'/forms/api/v1/surveys/[a-z0-9]{1,32}(?:/(responses|results|publish|close))?', path)
        if match:
            action = match[1]
            if method == 'GET' and action is None:
                scope = 'forms:read'
            elif method == 'POST' and action == 'responses':
                scope = 'forms:respond'
            elif (method == 'PUT' and action is None) or (method == 'GET' and action == 'results') or (method == 'POST' and action in ('results', 'publish', 'close')):
                scope = 'forms:admin'
    if not scope or scope == 'forms:admin' and not admin:
        raise ValueError('Forms route or role denied')
    if method in ('GET', 'HEAD'):
        if raw or content_type or idempotency:
            raise ValueError('Unexpected Forms read body')
    else:
        if content_type.split(';', 1)[0].strip() != 'application/json' or not raw:
            raise ValueError('Forms mutation requires JSON')
        identifier(idempotency)
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('Forms JSON object required')
    return scope


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, message, headers, new_url):
        return None


class FormsController:
    def __init__(self, parent):
        self.parent, self.root, self.installation = parent, Path(parent.root), parent.installation
        self._docker_observation = ContextVar('forms_docker_observation', default=None)
        self._routes, self._route_lock = {}, threading.RLock()
        self.images = self.resolve_images()
        self.version = self.images['adapter']['labels']['org.opencontainers.image.version']
        self.base = self.root / 'modules/forms'
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        for path in (self.base, self.instances, self.operations):
            directory(path)

    def docker(self, *args, timeout=30):
        snapshot = self._docker_observation.get()
        if snapshot is None:
            return self.parent.docker(*args, timeout=timeout)
        if args[:2] not in (('container', 'ls'), ('container', 'inspect'), ('image', 'inspect'),
                            ('network', 'ls'), ('network', 'inspect'), ('volume', 'ls'), ('volume', 'inspect')):
            raise ValueError('Forms observation only permits Docker reads')
        key = (args, timeout)
        if key not in snapshot:
            snapshot[key] = self.parent.docker(*args, timeout=timeout)
        return snapshot[key]

    @contextmanager
    def observation(self):
        # One readiness check has one read snapshot. No data survives the call
        # or crosses request contexts; lifecycle operations remain uncached.
        token = self._docker_observation.set({})
        try:
            yield
        finally:
            self._docker_observation.reset(token)

    def resolve_images(self):
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        state = json.loads(read_file(self.root / 'state/installation.json'))
        bundle = registry.get('forms')
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or state.get('install_id') != self.installation or registry.get('manifest_sha256') != state.get('manifest_sha256')
                or not re.fullmatch(r'[0-9a-f]{64}', registry.get('manifest_sha256', ''))
                or not isinstance(bundle, dict) or set(bundle) != set(ROLES)):
            raise ValueError('Invalid Forms package installation identity')
        for role, image in bundle.items():
            labels = image.get('labels', {})
            if (set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                    or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', '')) or image.get('architecture') not in ('amd64', 'arm64')
                    or image.get('recipe') != 'deploy/images/forms.Dockerfile' or labels.get('pl.module.id') != 'forms'
                    or labels.get('pl.module.role') != role or labels.get('pl.module.config.version') != '1'
                    or labels.get('pl.build.variant') != ('source-build' if role == 'adapter' else 'upstream-pinned')
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', labels.get('org.opencontainers.image.version', ''))):
                raise ValueError('Invalid Forms component image')
        if len({image['labels']['org.opencontainers.image.version'] for image in bundle.values()}) != 1:
            raise ValueError('Forms component package versions differ')
        return bundle

    def image_role(self, role):
        return 'engine' if role == 'engine-bootstrap' else role

    def verify_image(self, role):
        expected = self.images[self.image_role(role)]
        obj = json.loads(self.docker('image', 'inspect', expected['id']))[0]
        if (obj.get('Id') != expected['id'] or obj.get('Os') != 'linux' or obj.get('Architecture') != expected['architecture']
                or any((obj.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in expected['labels'].items())):
            raise ValueError('Forms image identity mismatch')
        return obj

    @contextmanager
    def locked(self, exclusive=True):
        path = self.root / 'modules/controller.lock'
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600:
            os.close(fd)
            raise ValueError('Unsafe Forms lifecycle lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    @contextmanager
    def instance_lock(self, instance, exclusive=False):
        path = self.operations / ('instance-' + identifier(instance) + '.lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600:
            os.close(fd)
            raise ValueError('Unsafe Forms instance lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def name(self, instance, suffix=''):
        return self.installation + '-forms-' + identifier(instance) + suffix

    def labels(self, instance, role=None):
        result = {'pl.installation': self.installation, 'pl.module': 'forms', 'pl.instance': identifier(instance)}
        if role:
            result['pl.module.role'] = role
        return result

    def paths(self, instance, create=False):
        path = self.instances / identifier(instance)
        directory(path, create=create)
        directory(path / 'config', create=create, mode=0o755)
        return path

    def public_url(self):
        value = json.loads(read_file(self.root / 'state/installation.json')).get('config', {}).get('public_url', '')
        if not isinstance(value, str) or len(value) > 2048 or any(ord(c) <= 32 or ord(c) == 127 for c in value):
            raise ValueError('Invalid Forms Platform origin')
        url = urllib.parse.urlsplit(value)
        if (url.scheme != 'https' or not url.hostname or url.username or url.password
                or url.path not in ('', '/') or url.query or url.fragment):
            raise ValueError('Forms requires an explicit HTTPS Platform origin')
        return value

    def gateway_key(self, instance):
        master = read_file(self.root / 'private/module-controller-key', mode=0o640)
        if len(master) != 32:
            raise ValueError('Invalid Forms controller master key')
        return hmac.digest(master, ('pl-module-key-v1\nforms\n' + identifier(instance)).encode(), 'sha256')

    def validate_state(self, state, instance):
        service = state.get('service', {})
        if (set(state) != STATE_FIELDS or state.get('public_url') != self.public_url() or state.get('installation') != self.installation or state.get('instance_id') != instance or state.get('gateway_key') != self.gateway_key(instance).hex()
                or type(state.get('bootstrapped')) is not bool
                or any(not re.fullmatch(r'[0-9a-f]{64}', state.get(key, '')) for key in ('gateway_key', 'session_key', 'encryption_key', 'keydb_password'))
                or not isinstance(service, dict) or set(service) != {'email', 'password', 'device_id', 'name'}
                or service.get('email') != 'forms-' + instance + '@pl.internal' or service.get('name') != 'PL Forms Service'
                or not re.fullmatch(r'(?:[0-9a-f]{64}|Pl1-[0-9a-f]{60})', service.get('password', '')) or not re.fullmatch(r'[0-9a-f]{32}', service.get('device_id', ''))):
            raise ValueError('Invalid private Forms state')
        return state

    def configs(self, state):
        engine = {'session_key': state['session_key'], 'encryption_key': state['encryption_key'], 'keydb_password': state['keydb_password']}
        keydb = ('bind 0.0.0.0\nport 6379\nprotected-mode yes\nrequirepass ' + state['keydb_password']
                 + '\nappendonly yes\ndir /data\nserver-threads 1\nmaxmemory 128mb\nmaxmemory-policy noeviction\n')
        return {'forms-gateway.key': bytes.fromhex(state['gateway_key']), 'forms-service.json': encoded(state['service']),
                'forms-engine.json': encoded(engine), 'forms-keydb.conf': keydb.encode()}

    def state(self, instance):
        path = self.paths(instance)
        state = self.validate_state(json.loads(read_file(path / 'state.json')), instance)
        for name, expected in self.configs(state).items():
            file = path / 'config' / name
            if read_file(file, mode=0o440) != expected or file.stat().st_gid != GID:
                raise ValueError('Private Forms configuration drift')
        return state

    def initialize(self, instance):
        path = self.paths(instance, create=True)
        journal = path / 'state.json'
        if journal.exists() or journal.is_symlink():
            state = self.validate_state(json.loads(read_file(journal)), instance)
        else:
            if list((path / 'config').iterdir()):
                raise ValueError('Unmanaged Forms configuration exists')
            # Pinned HeyForm SignUpInput requires upper/lowercase and a digit.
            # Keep 64 characters and 240 random bits; existing credentials stay unchanged.
            state = {'public_url': self.public_url(), 'installation': self.installation, 'instance_id': instance, 'gateway_key': self.gateway_key(instance).hex(),
                     'session_key': secrets.token_hex(32), 'encryption_key': secrets.token_hex(32), 'keydb_password': secrets.token_hex(32),
                     'service': {'email': 'forms-' + instance + '@pl.internal', 'password': 'Pl1-' + secrets.token_hex(30), 'device_id': secrets.token_hex(16), 'name': 'PL Forms Service'},
                     'bootstrapped': False}
            atomic(journal, state)
        if set(p.name for p in (path / 'config').iterdir()) - set(CONFIG_FILES):
            raise ValueError('Unknown Forms configuration files')
        for name, expected in self.configs(state).items():
            file = path / 'config' / name
            if file.exists() or file.is_symlink():
                if read_file(file, mode=0o440) != expected or file.stat().st_gid != GID:
                    raise ValueError('Private Forms initialization drift')
            else:
                atomic(file, expected, mode=0o440)
                os.chown(file, -1, GID)
        self.state(instance)

    def resource_name(self, instance, kind, volume=None):
        return self.name(instance, '-net' if kind == 'network' else '-' + volume + '-data')

    def resource(self, instance, kind, volume=None, create=False):
        if kind not in ('network', 'volume') or kind == 'volume' and volume not in VOLUMES:
            raise ValueError('Invalid Forms resource')
        name = self.resource_name(instance, kind, volume)
        found = self.docker(kind, 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found and create:
            args = [kind, 'create']
            if kind == 'network':
                args += ['--driver', 'bridge', '--internal'] + _files.module_network_args(self.root, self.installation, self.docker)
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, name)
            return self.resource(instance, kind, volume)
        if not found:
            return None
        obj = json.loads(self.docker(kind, 'inspect', name))[0]
        if kind == 'network':
            _files.validate_module_network(self.root, self.installation, obj, self.docker)
        if (obj.get('Name') != name or obj.get('Driver') != ('bridge' if kind == 'network' else 'local') or obj.get('Options')
                or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())
                or kind == 'network' and (not obj.get('Internal') or obj.get('Ingress') or obj.get('Scope') != 'local')):
            raise ValueError('Forms resource ownership mismatch')
        if kind == 'network':
            for member_id, member in obj.get('Containers', {}).items():
                name = member.get('Name')
                if name not in {self.name(instance, '-' + role) for role in ALL_ROLES}:
                    raise ValueError('Foreign container attached to Forms network')
                container = json.loads(self.docker('container', 'inspect', name))[0]
                if (container.get('Id') != member_id
                        or any((container.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())):
                    raise ValueError('Foreign container attached to Forms network')
        return obj

    def mounts(self, instance, role):
        config = self.paths(instance) / 'config'
        if role == 'adapter':
            return {('volume', self.resource_name(instance, 'volume', 'adapter'), '/data', True),
                    ('bind', str(config / 'forms-gateway.key'), '/run/secrets/forms-gateway.key', False),
                    ('bind', str(config / 'forms-service.json'), '/run/secrets/forms-service.json', False)}
        if role in ('engine', 'engine-bootstrap'):
            return {('volume', self.resource_name(instance, 'volume', 'assets'), VOLUMES['assets'], True),
                    ('bind', str(config / 'forms-engine.json'), '/run/secrets/forms-engine.json', False)}
        if role == 'mongo':
            return {('volume', self.resource_name(instance, 'volume', key), VOLUMES[key], True) for key in ('mongo', 'mongo-config')}
        return {('volume', self.resource_name(instance, 'volume', 'keydb'), '/data', True),
                ('bind', str(config / 'forms-keydb.conf'), '/run/secrets/forms-keydb.conf', False)}

    def inspect(self, instance, role):
        name = self.name(instance, '-' + role)
        found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
        if not found:
            return None
        self.state(instance)
        image = self.verify_image(role)
        obj = json.loads(self.docker('container', 'inspect', name))[0]
        config, host = obj.get('Config', {}), obj.get('HostConfig', {})
        mounts = {(m.get('Type'), m.get('Name') if m.get('Type') == 'volume' else m.get('Source'), m.get('Destination'), m.get('RW')) for m in obj.get('Mounts', [])}
        expected_env = dict(value.split('=', 1) for value in image.get('Config', {}).get('Env', []))
        if role == 'engine-bootstrap':
            expected_env['PL_FORMS_BOOTSTRAP'] = '1'
        actual_env = dict(value.split('=', 1) for value in config.get('Env', []))
        ports = host.get('PortBindings') or {}
        observed_ports = obj.get('NetworkSettings', {}).get('Ports') or {}
        private_ports = private_adapter_bindings(ports, observed_ports) if role == 'adapter' else not ports and not any(observed_ports.values())
        if (not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', '')) or obj.get('Image') != self.images[self.image_role(role)]['id']
                or config.get('Image') != self.images[self.image_role(role)]['id'] or mounts != self.mounts(instance, role)
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.labels(instance, role).items())
                or any(config.get(k) != image.get('Config', {}).get(k) for k in ('Entrypoint', 'Cmd', 'User', 'Healthcheck'))
                or normalized_working_dir(config.get('WorkingDir')) != normalized_working_dir(image.get('Config', {}).get('WorkingDir'))
                or expected_env != actual_env or len(config.get('Env', [])) != len(actual_env)
                or not private_ports
                or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapDrop') != ['ALL'] or host.get('CapAdd')
                or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts') or host.get('NetworkMode') != self.name(instance, '-net')
                or set(obj.get('NetworkSettings', {}).get('Networks', {})) != {self.name(instance, '-net')}
                or host.get('Memory') != MEMORY[role] * 1024**2 or host.get('NanoCpus') != CPUS[role] or host.get('PidsLimit') != PIDS[role]
                or not host.get('Init') or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('Tmpfs') != {'/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777'}
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or host.get('PidMode') not in ('', None) or host.get('IpcMode') not in ('private', None)
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])):
            raise ValueError('Forms container drift')
        if not self.resource(instance, 'network') or any(not self.resource(instance, 'volume', key) for key in VOLUMES):
            raise ValueError('Forms managed resources missing')
        return obj

    def create(self, instance, role):
        self.verify_image(role)
        args = ['container', 'create', '--name', self.name(instance, '-' + role), '--network', self.name(instance, '-net'),
                '--network-alias', 'heyform' if role in ('engine', 'engine-bootstrap') else role,
                '--restart', 'unless-stopped', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                '--memory', str(MEMORY[role]) + 'm', '--cpus', str(CPUS[role] / 1_000_000_000), '--pids-limit', str(PIDS[role]),
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864,mode=1777', '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2']
        if role == 'engine-bootstrap':
            args += ['--env', 'PL_FORMS_BOOTSTRAP=1']
        for kind, source, target, writable in sorted(self.mounts(instance, role)):
            args += ['--mount', 'type=' + kind + ',source=' + source + ',target=' + target + ('' if writable else ',readonly')]
        for key, value in self.labels(instance, role).items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.images[self.image_role(role)]['id'])
        if self.inspect(instance, role) is None:
            raise ValueError('Forms creation unconfirmed')

    def start(self, instance, role):
        obj = self.inspect(instance, role)
        if obj is None:
            self.create(instance, role)
            obj = self.inspect(instance, role)
        if not obj.get('State', {}).get('Running'):
            self.docker('container', 'start', obj['Id'])

    def delete_container(self, instance, role):
        obj = self.inspect(instance, role)
        if obj:
            if obj.get('State', {}).get('Running'):
                self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
            self.docker('container', 'rm', obj['Id'])

    def endpoint(self, instance, obj):
        network = self.resource(instance, 'network')
        labels = obj.get('Config', {}).get('Labels') or {}
        network_name = self.name(instance, '-net')
        views = obj.get('NetworkSettings', {}).get('Networks') or {}
        if (network is None or set(views) != {network_name}
                or obj.get('Image') != self.images['adapter']['id']
                or any(labels.get(k) != v for k, v in self.labels(instance, 'adapter').items())
                or obj.get('Name') != '/' + self.name(instance, '-adapter')):
            raise ValueError('Invalid Forms adapter network ownership')
        view = views[network_name]
        member = (network.get('Containers') or {}).get(obj.get('Id')) or {}
        if (not re.fullmatch('[0-9a-f]{64}', network.get('Id', '')) or view.get('NetworkID') != network['Id']
                or member.get('Name') != self.name(instance, '-adapter')):
            raise ValueError('Forms adapter network membership mismatch')
        try:
            raw = view.get('IPAddress')
            address = ipaddress.IPv4Address(raw)
            assigned = ipaddress.IPv4Interface(member.get('IPv4Address'))
            private = any(address in ipaddress.IPv4Network(cidr) for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
            subnets = [ipaddress.ip_network(value['Subnet']) for value in network.get('IPAM', {}).get('Config', []) if value.get('Subnet')]
            gateways = {str(value.get('Gateway')) for value in network.get('IPAM', {}).get('Config', []) if value.get('Gateway')}
            if (str(address) != raw or not private or assigned.ip != address
                    or not any(subnet.version == 4 and address in subnet and address not in (subnet.network_address, subnet.broadcast_address) for subnet in subnets)
                    or str(address) in gateways or raw == view.get('Gateway')):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise ValueError('Invalid Forms owned adapter IPv4') from None
        return 'http://' + str(address) + ':8091'

    def http(self, instance, obj, method, path, raw=b'', headers=None, *, origin=None):
        request = urllib.request.Request((origin or self.endpoint(instance, obj)) + path, data=raw if method in ('POST', 'PUT') else None,
                                         method=method, headers=headers or {'Accept-Encoding': 'identity'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            response = opener.open(request, timeout=35)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(MAX_RESPONSE + 1)
            mime = response.headers.get_content_type()
            if len(data) > MAX_RESPONSE or not 200 <= response.status <= 599 or 300 <= response.status < 400 or mime not in ('application/json', 'text/html', 'text/css', 'text/javascript', 'application/javascript'):
                raise ValueError('Forms response outside finite contract')
            return response.status, mime, data

    def ready(self, instance):
        try:
            with self.observation():
                adapter = self._ready(instance)
                origin = self.endpoint(instance, adapter)
            self._routes[instance] = (time.monotonic(), adapter, origin)
            return adapter
        except Exception:
            self._routes.pop(instance, None)
            raise

    def _ready(self, instance):
        if not self.state(instance)['bootstrapped'] or self.inspect(instance, 'engine-bootstrap') is not None:
            raise ValueError('Forms bootstrap incomplete')
        objects = [self.inspect(instance, role) for role in ROLES]
        if any(not obj or not obj.get('State', {}).get('Running') for obj in objects):
            raise ValueError('Forms components stopped')
        status, _, raw = self.http(instance, objects[-1], 'GET', '/ready')
        data = json.loads(raw)
        if status != 200 or data.get('status') != 'ready' or data.get('database') != 'ok' or data.get('engine') != 'connected' or data.get('version') != self.version:
            raise ValueError('Forms native readiness unconfirmed')
        return objects[-1]

    def ensure(self, instance):
        self.initialize(instance)
        self.resource(instance, 'network', create=True)
        for volume in VOLUMES:
            if not self.resource(instance, 'volume', volume, create=True):
                raise ValueError('Forms volume creation unconfirmed')
        for role in ('mongo', 'keydb', 'adapter'):
            self.start(instance, role)
        if not self.state(instance)['bootstrapped']:
            if self.inspect(instance, 'engine') is not None:
                raise ValueError('Final Forms engine exists before bootstrap journal')
            self.start(instance, 'engine-bootstrap')
            deadline = time.monotonic() + 120
            while True:
                try:
                    adapter = self.inspect(instance, 'adapter')
                    self.docker('container', 'exec', adapter['Id'], 'python', '-c', 'from engine import Engine; Engine().bootstrap()', timeout=40)
                    break
                except (ValueError, OSError):
                    if time.monotonic() >= deadline:
                        raise ValueError('Forms native bootstrap unconfirmed') from None
                    time.sleep(1)
            state = self.state(instance)
            state['bootstrapped'] = True
            atomic(self.paths(instance) / 'state.json', state)
        self.delete_container(instance, 'engine-bootstrap')
        self.start(instance, 'engine')
        deadline = time.monotonic() + 90
        while True:
            try:
                self.ready(instance)
                return
            except (ValueError, OSError):
                if time.monotonic() >= deadline:
                    raise ValueError('Forms native readiness unconfirmed') from None
                time.sleep(0.5)

    def observe(self, instance):
        base = self.instances / identifier(instance)
        if not base.exists() and not base.is_symlink():
            if self.resource(instance, 'network') or any(self.resource(instance, 'volume', key) for key in VOLUMES) or any(self.inspect(instance, role) for role in ALL_ROLES):
                raise ValueError('Forms artifacts without managed state')
            return {'state': 'absent', 'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        self.state(instance)
        objects = [self.inspect(instance, role) for role in ROLES]
        if any(obj is None for obj in objects) or self.inspect(instance, 'engine-bootstrap') is not None:
            raise ValueError('Forms components incomplete')
        running = [bool(obj.get('State', {}).get('Running')) for obj in objects]
        if any(running) and not all(running):
            raise ValueError('Forms components have mixed state')
        result = {'state': 'disabled', 'version': self.version, 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        if all(running):
            result.update(state='running', endpoint=self.endpoint(instance, self.ready(instance)))
        return result

    def remove(self, instance):
        base = self.instances / identifier(instance)
        marker = self.operations / ('remove-' + instance + '.json')
        expected = {'state.json': 0o600, **{'config/' + name: 0o440 for name in CONFIG_FILES}}
        if not base.exists() and not base.is_symlink():
            self.observe(instance)
            if marker.exists() or marker.is_symlink():
                value = json.loads(read_file(marker))
                if value.get('installation') != self.installation or value.get('instance_id') != instance:
                    raise ValueError('Invalid Forms removal journal')
                marker.unlink()
                fsync_directory(self.operations)
            return
        if not marker.exists() and not marker.is_symlink():
            self.state(instance)
            if set(p.name for p in base.iterdir()) != {'state.json', 'config'} or set(p.name for p in (base / 'config').iterdir()) != set(CONFIG_FILES):
                raise ValueError('Unknown Forms removal files')
            for role in ALL_ROLES:
                self.inspect(instance, role)
            self.resource(instance, 'network')
            for volume in VOLUMES:
                self.resource(instance, 'volume', volume)
            atomic(marker, {'installation': self.installation, 'instance_id': instance,
                            'files': {name: hashlib.sha256(read_file(base / name, mode=mode)).hexdigest() for name, mode in expected.items()}})
        journal = json.loads(read_file(marker))
        if (set(journal) != {'installation', 'instance_id', 'files'} or journal['installation'] != self.installation
                or journal['instance_id'] != instance or not isinstance(journal['files'], dict) or set(journal['files']) != set(expected)
                or any(not re.fullmatch(r'[0-9a-f]{64}', value) for value in journal['files'].values())):
            raise ValueError('Invalid Forms removal journal')
        if set(p.name for p in base.iterdir()) - {'state.json', 'config'}:
            raise ValueError('Unknown Forms removal artifacts')
        config = base / 'config'
        if config.exists() or config.is_symlink():
            directory(config, create=False, mode=0o755)
            if set(p.name for p in config.iterdir()) - set(CONFIG_FILES):
                raise ValueError('Unknown Forms removal configuration')
        for name, mode in expected.items():
            path = base / name
            if (path.exists() or path.is_symlink()) and hashlib.sha256(read_file(path, mode=mode)).hexdigest() != journal['files'][name]:
                raise ValueError('Forms removal artifact changed')
        for role in reversed(ALL_ROLES):
            self.delete_container(instance, role)
        for volume in VOLUMES:
            if self.resource(instance, 'volume', volume):
                self.docker('volume', 'rm', self.resource_name(instance, 'volume', volume))
            if self.resource(instance, 'volume', volume):
                raise ValueError('Forms volume removal unconfirmed')
        if self.resource(instance, 'network'):
            self.docker('network', 'rm', self.resource_name(instance, 'network'))
        if self.resource(instance, 'network'):
            raise ValueError('Forms network removal unconfirmed')
        for name in ('config/forms-gateway.key', 'config/forms-service.json', 'config/forms-engine.json', 'config/forms-keydb.conf', 'state.json'):
            (base / name).unlink(missing_ok=True)
        if config.exists():
            config.rmdir()
        base.rmdir()
        fsync_directory(self.instances)
        marker.unlink()
        fsync_directory(self.operations)

    def execute(self, body):
        if (not isinstance(body, dict) or not {'operation_id', 'instance_id', 'module_id', 'action'} <= set(body)
                or set(body) - {'operation_id', 'instance_id', 'module_id', 'action', 'public_url'}
                or body.get('module_id') != 'forms' or body.get('action') not in ('install', 'enable', 'disable', 'refresh', 'remove')):
            raise ValueError('Unsupported Forms operation')
        if 'public_url' in body and body['public_url'] != self.public_url():
            raise ValueError('Forms Platform origin differs from installation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        refreshing = body['action'] == 'refresh'
        with _files.operation_lock(self.operations, operation), self.instance_lock(instance, exclusive=not refreshing), \
                (nullcontext() if refreshing else self.locked()):
            if not refreshing:
                self._routes.pop(instance, None)
            path = self.operations / (operation + '.json')
            fingerprint = hashlib.sha256(encoded(body)).hexdigest()
            if path.exists() or path.is_symlink():
                previous = json.loads(read_file(path))
                if previous.get('fingerprint') != fingerprint:
                    raise ValueError('Forms operation ID conflict')
                if previous.get('phase') == 'complete':
                    return {**self.observe(instance), 'operation_id': operation}
            atomic(path, {'fingerprint': fingerprint, 'phase': 'running'})
            try:
                if body['action'] in ('install', 'enable'):
                    self.ensure(instance)
                elif body['action'] == 'disable':
                    for role in reversed(ALL_ROLES):
                        obj = self.inspect(instance, role)
                        if obj and obj.get('State', {}).get('Running'):
                            self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                elif body['action'] == 'remove':
                    self.remove(instance)
                result = {**self.observe(instance), 'operation_id': operation}
                atomic(path, {'fingerprint': fingerprint, 'phase': 'complete'})
                return result
            except (ValueError, OSError, KeyError, TypeError) as error:
                self._routes.pop(instance, None)
                return {'state': 'error', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0,
                        'error': _files.module_network_error(error, 'Forms operation unconfirmed; reconcile the same operation'), 'operation_id': operation}

    def get(self, instance):
        with self.instance_lock(instance):
            try:
                result = self.observe(identifier(instance))
                if result['state'] != 'running':
                    self._routes.pop(instance, None)
                return result
            except Exception:
                self._routes.pop(instance, None)
                raise

    def request(self, body):
        fields = {'instance_id', 'method', 'path', 'query', 'content_type', 'body', 'headers'}
        if not isinstance(body, dict) or set(body) != fields:
            raise ValueError('Invalid Forms gateway request')
        instance = identifier(body['instance_id'])
        if not isinstance(body['body'], str) or len(body['body']) > 4 * ((MAX_BODY + 2) // 3):
            raise ValueError('Invalid Forms body')
        headers = body['headers']
        required = {'X-PL-Gateway-Assertion', 'X-PL-Gateway-Signature'}
        if (not isinstance(headers, dict) or not required <= set(headers)
                or set(headers) - required - {'X-CSRF-Token', 'Idempotency-Key'}
                or any(not isinstance(v, str) or not v or len(v) > 8192
                       or any(ord(c) < 32 or ord(c) > 126 for c in v) for v in headers.values())):
            raise ValueError('Unsupported Forms gateway headers')
        for name in required:
            if not re.fullmatch(r'[A-Za-z0-9_-]+', headers[name]):
                raise ValueError('Invalid Forms gateway assertion encoding')
        if body['method'] in ('GET', 'HEAD'):
            if set(headers) != required:
                raise ValueError('Unexpected Forms read headers')
        elif set(headers) != required | {'X-CSRF-Token', 'Idempotency-Key'}:
            raise ValueError('Forms mutation requires signed CSRF and idempotency')
        if 'X-CSRF-Token' in headers:
            csrf(headers['X-CSRF-Token'])
        raw = base64.b64decode(body['body'], validate=True)
        # This only limits routes. The adapter verifies the original signed role,
        # exact request/body, derived CSRF token and single-use assertion nonce.
        request_scope(body['method'], body['path'], body['query'], body['content_type'], raw, True, headers.get('Idempotency-Key', ''))
        forwarded = {**headers, 'Accept-Encoding': 'identity'}
        if body['content_type']:
            forwarded['Content-Type'] = body['content_type']
        with self.instance_lock(instance):
            # Lifecycle/health observations establish the route. Page assets
            # reuse it instead of querying Docker; cold/expired routes are
            # verified once. Shared instance admission still excludes disable.
            route = self._routes.get(instance)
            if route is None or time.monotonic() - route[0] >= ROUTE_MAX_AGE:
                with self._route_lock:
                    route = self._routes.get(instance)
                    if route is None or time.monotonic() - route[0] >= ROUTE_MAX_AGE:
                        self.ready(instance)
                        route = self._routes[instance]
            try:
                status, mime, response = self.http(instance, route[1], body['method'], body['path'], raw, forwarded, origin=route[2])
            except (ValueError, OSError):
                self._routes.pop(instance, None)
                raise
        return {'instance_id': instance, 'status': status, 'content_type': mime, 'body': base64.b64encode(response).decode()}
