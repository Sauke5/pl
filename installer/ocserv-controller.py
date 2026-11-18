#!/usr/bin/env python3
"""Manage the owned ocserv gateway and its finite administrative RPC."""
from contextlib import contextmanager, nullcontext
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import threading
import time


def helper(name):
    path = Path(__file__).with_name(name + '.py')
    if path.is_symlink() or not path.is_file():
        raise ValueError('Trusted module helper unavailable')
    spec = importlib.util.spec_from_file_location('pl_' + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_files = helper('xray-controller')
_setup = helper('ocserv-setup')
identifier, directory, read_file = _files.identifier, _files.directory, _files.read_file
atomic, encoded = _files.atomic, _files.encoded

BINARY = '/usr/local/bin/pl-ocserv'
DATA, CONFIG = '/var/lib/pl-ocserv', '/etc/pl-ocserv'
CAPS = ('CHOWN', 'KILL', 'NET_ADMIN', 'SETGID', 'SETUID')
TUN = {'PathOnHost': '/dev/net/tun', 'PathInContainer': '/dev/net/tun', 'CgroupPermissions': 'rw'}
TMPFS = {'/run': 'rw,nosuid,nodev,noexec,size=16m,mode=755', '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777'}
SYSCTLS = {'net.ipv4.ip_forward': '1'}
LOGS = {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
BRIDGE_DEFAULTS = {'com.docker.network.enable_ipv4': 'true', 'com.docker.network.enable_ipv6': 'false'}
ROUTES = {
    'state': set(), 'setup': set(), 'discover': set(), 'connection': None, 'configure': None,
    'profile': {'revision', 'actor', 'id', 'name', 'networks'},
    'grant': {'revision', 'actor', 'subject', 'display_name', 'profile_id', 'expires_at'},
    'revoke': {'revision', 'actor', 'subject'},
    'terminate': {'revision', 'actor', 'id'},
}


Failure = _setup.Failure


def bindings(value):
    if value is None:
        return {}
    if (not isinstance(value, dict) or set(value) != {'address', 'port'} or not isinstance(value['address'], str)
            or type(value['port']) != int or not 1 <= value['port'] <= 65535):
        raise ValueError('Invalid VPN ingress')
    ip = ipaddress.IPv4Address(value['address'])
    if str(ip) != value['address'] or ip.is_unspecified or ip.is_multicast or ip.is_reserved or ip.is_link_local:
        raise ValueError('VPN ingress requires an explicit local IPv4 address')
    return {port: [{'HostIp': str(ip), 'HostPort': str(value['port'])}] for port in ('4443/tcp', '4443/udp')}


@contextmanager
def lock(path, exclusive=True):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Unsafe VPN lock')
        fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield


class OcservController:
    def __init__(self, parent):
        self.root, self.installation, self.docker = Path(parent.root), parent.installation, parent.docker
        self.base = self.root / 'modules/ocserv'
        self.instances, self.operations, self.operator = (self.base / n for n in ('instances', 'operations', 'operator'))
        for path in (self.base, self.instances, self.operations, self.operator):
            directory(path)
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        installation = json.loads(read_file(self.root / 'state/installation.json'))
        bundle = registry.get('ocserv')
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or installation.get('install_id') != self.installation or not re.fullmatch('[0-9a-f]{64}', registry.get('manifest_sha256', ''))
                or registry['manifest_sha256'] != installation.get('manifest_sha256') or not isinstance(bundle, dict) or set(bundle) != {'server'}):
            raise ValueError('Invalid VPN installation identity')
        self.image = bundle['server']
        if (not isinstance(self.image, dict) or set(self.image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                or not re.fullmatch('sha256:[0-9a-f]{64}', self.image.get('id', '')) or self.image['architecture'] not in ('amd64', 'arm64')
                or self.image['recipe'] != 'deploy/images/ocserv.Dockerfile' or not isinstance(self.image['labels'], dict)):
            raise ValueError('Invalid VPN image descriptor')
        labels = self.image['labels']
        self.version = labels.get('org.opencontainers.image.version', '')
        if (self.version != '1.6.0' or labels.get('pl.upstream.version') != self.version
                or labels.get('pl.module.id') != 'ocserv' or labels.get('pl.module.role') != 'server'
                or labels.get('pl.module.config.version') != '1' or labels.get('pl.build.variant') != 'upstream-pinned'):
            raise ValueError('Invalid VPN image contract')
        self.slots = threading.BoundedSemaphore(4)
        self.wizard = _setup.GatewaySetup(self, _files, lambda: helper('ocserv-discovery'))

    def names(self, instance, suffix=''):
        return self.installation + '-ocserv-' + identifier(instance) + suffix

    def labels(self, instance):
        return {'pl.installation': self.installation, 'pl.module': 'ocserv', 'pl.instance': identifier(instance)}

    def state(self, instance):
        path = self.instances / identifier(instance)
        directory(path, create=False)
        value = json.loads(read_file(path / 'state.json'))
        if (not isinstance(value, dict) or set(value) != {'installation', 'instance_id', 'ingress', 'storage_created'}
                or value['installation'] != self.installation or value['instance_id'] != instance or type(value['storage_created']) != bool):
            raise ValueError('Invalid VPN instance state')
        bindings(value['ingress'])
        return value

    def desired_ingress(self):
        path = self.base / 'ingress.json'
        value = json.loads(read_file(path, limit=1024)) if path.exists() or path.is_symlink() else None
        bindings(value)
        return value

    def locked(self, instance, exclusive=False):
        return lock(self.operations / ('instance-' + identifier(instance) + '.lock'), exclusive)

    def verify_image(self):
        image, = json.loads(self.docker('image', 'inspect', self.image['id']))
        config = image.get('Config', {})
        if (image.get('Id') != self.image['id'] or image.get('Os') != 'linux' or image.get('Architecture') != self.image['architecture']
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.image['labels'].items())
                or config.get('Entrypoint') != [BINARY] or config.get('Cmd') != ['serve']
                or config.get('User') not in (None, '', '0', '0:0', 'root')):
            raise ValueError('VPN image identity mismatch')
        return config

    def resource(self, instance, kind, create=False):
        if kind not in ('volume', 'network'):
            raise ValueError('Unknown VPN resource kind')
        name = self.names(instance, '-data' if kind == 'volume' else '-net')
        found = self.docker(kind, 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found and create:
            args = [kind, 'create']
            if kind == 'network':
                args += ['--driver', 'bridge', *_files.module_network_args(self.root, self.installation, self.docker)]
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, name)
            return self.resource(instance, kind)
        if not found:
            return None
        obj, = json.loads(self.docker(kind, 'inspect', name))
        options = obj.get('Options') or {}
        if (found != name or obj.get('Name') != name or obj.get('Driver') != ('bridge' if kind == 'network' else 'local')
                or obj.get('Scope') != 'local' or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())
                or options and (kind != 'network' or options != BRIDGE_DEFAULTS)):
            raise ValueError('VPN resource ownership mismatch')
        if kind == 'network':
            if (obj.get('Internal') is not False or obj.get('Ingress') or obj.get('EnableIPv6')
                    or any(m.get('Name') != self.names(instance) for m in (obj.get('Containers') or {}).values())):
                raise ValueError('VPN network drift')
            _files.validate_module_network(self.root, self.installation, obj, self.docker)
        return obj

    def container_id(self, instance):
        name = self.names(instance)
        result = self.docker('container', 'ls', '-a', '--no-trunc', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
        if result and not re.fullmatch('[0-9a-f]{64}', result):
            raise ValueError('Invalid VPN container identity')
        return result

    def inspect(self, instance):
        identity = self.container_id(instance)
        if not identity:
            return None
        obj, = json.loads(self.docker('container', 'inspect', identity))
        image, state = self.verify_image(), self.state(instance)
        conf, host = obj['Config'], obj['HostConfig']
        network = self.names(instance, '-net')
        expected_mounts = {('volume', self.names(instance, '-data'), DATA, True), ('bind', str(self.operator), CONFIG, False)}
        mounts = {(m['Type'], m.get('Name') if m['Type'] == 'volume' else m.get('Source'), m['Destination'], m['RW']) for m in obj.get('Mounts', [])}
        expected_ports = bindings(state['ingress'])
        if (obj.get('Id') != identity or obj.get('Name') != '/' + self.names(instance) or obj.get('Image') != self.image['id']
                or conf.get('Image') != self.image['id'] or conf.get('Labels') != {**(image.get('Labels') or {}), **self.labels(instance)}
                or any((conf.get(k) or '') != (image.get(k) or '') for k in ('User', 'WorkingDir'))
                or any(conf.get(k) != image.get(k) for k in ('Env', 'Entrypoint', 'Cmd', 'Healthcheck'))
                or mounts != expected_mounts or len(obj.get('Mounts', [])) != len(expected_mounts)
                or host.get('NetworkMode') != network or set(obj.get('NetworkSettings', {}).get('Networks', {})) != {network}
                or (host.get('PortBindings') or {}) != expected_ports or host.get('ReadonlyRootfs') is not True
                or set(host.get('CapDrop') or []) != {'ALL'} or {cap.removeprefix('CAP_') for cap in host.get('CapAdd') or []} != set(CAPS)
                or host.get('Devices') != [TUN] or host.get('Tmpfs') != TMPFS or host.get('Sysctls') != SYSCTLS
                or host.get('SecurityOpt') != ['no-new-privileges'] or host.get('IpcMode') not in ('private', None)
                or any(host.get(k) for k in ('Privileged', 'Binds', 'PublishAllPorts', 'VolumesFrom', 'Links', 'ExtraHosts',
                                             'PidMode', 'UTSMode', 'UsernsMode', 'GroupAdd', 'DeviceRequests', 'DeviceCgroupRules'))
                or host.get('Memory') != 256 * 1024**2 or host.get('NanoCpus') != 1_000_000_000 or host.get('PidsLimit') != 192
                or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped' or host.get('LogConfig') != LOGS):
            raise ValueError('VPN container ownership or configuration drift')
        if not self.resource(instance, 'network') or not self.resource(instance, 'volume'):
            raise ValueError('VPN resources missing')
        if obj['State'].get('Running') and not obj['State'].get('Restarting'):
            exposed = {k: v for k, v in (obj['NetworkSettings'].get('Ports') or {}).items() if v}
            if exposed != expected_ports:
                raise ValueError('VPN public bindings differ from configured ingress')
        return obj

    def create(self, instance):
        config = self.state(instance)
        self.verify_image()
        directory(self.operator, create=False)
        args = ['container', 'create', '--name', self.names(instance), '--network', self.names(instance, '-net'),
                '--restart', 'unless-stopped', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--device', '/dev/net/tun:/dev/net/tun:rw', '--sysctl', 'net.ipv4.ip_forward=1',
                '--memory', '256m', '--cpus', '1', '--pids-limit', '192',
                '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
                '--mount', 'type=bind,source=' + str(self.operator) + ',target=' + CONFIG + ',readonly',
                '--mount', 'type=volume,source=' + self.names(instance, '-data') + ',target=' + DATA]
        for cap in CAPS:
            args += ['--cap-add', cap]
        for dest, options in TMPFS.items():
            args += ['--tmpfs', dest + ':' + options]
        for port, (binding,) in bindings(config['ingress']).items():
            args += ['--publish', binding['HostIp'] + ':' + binding['HostPort'] + ':' + port]
        for key, value in self.labels(instance).items():
            args += ['--label', key + '=' + value]
        identity = self.docker(*args, self.image['id']).decode().strip()
        obj = self.inspect(instance)
        if not obj or obj['Id'] != identity:
            raise ValueError('VPN container creation unconfirmed')
        return obj

    def call(self, obj, action, payload):
        if not obj or not obj['State'].get('Running') or obj['State'].get('Restarting'):
            raise ValueError('VPN container unavailable')
        raw = self.docker('exec', '-i', obj['Id'], BINARY, 'request', input_bytes=encoded({'action': action, 'payload': payload}), timeout=25)
        if len(raw) > 4 * 1024**2:
            raise ValueError('VPN response too large')
        reply = json.loads(raw)
        if (not isinstance(reply, dict) or set(reply) != {'status', 'body'} or not isinstance(reply.get('body'), dict)
                or reply.get('status') not in (200, 400, 404, 409, 422, 429, 503)):
            raise ValueError('Invalid VPN response')
        return reply

    def start(self, instance, obj=None):
        obj = obj or self.inspect(instance)
        if not obj:
            raise ValueError('VPN container is missing')
        if not obj['State'].get('Running'):
            self.docker('container', 'start', obj['Id'], timeout=30)
        deadline = time.monotonic() + 15
        while True:
            try:
                if self.call(self.inspect(instance), 'state', {})['status'] == 200:
                    return
            except (ValueError, OSError):
                pass
            if time.monotonic() >= deadline:
                raise ValueError('VPN management readiness timed out')
            time.sleep(.25)

    def stop(self, obj):
        if obj and obj['State'].get('Running'):
            self.docker('container', 'stop', '--time', '8', obj['Id'], timeout=16)

    def has_unprovisioned_instance(self):
        """Allow a core update to carry a partial install that owns no resources."""
        entries = list(self.instances.iterdir())
        if len(entries) != 1:
            return False
        path, = entries
        instance = identifier(path.name)
        if self.state(instance)['storage_created'] or {p.name for p in path.iterdir()} != {'state.json'}:
            return False
        if self.container_id(instance) or self.resource(instance, 'network') or self.resource(instance, 'volume'):
            return False
        filters = ('--filter', 'label=pl.installation=' + self.installation, '--filter', 'label=pl.module=ocserv')
        return not any(self.docker(kind, 'ls', *extra, *filters, '--quiet').strip()
                       for kind, extra in (('container', ('-a',)), ('network', ()), ('volume', ())))

    def ensure(self, instance):
        path, desired = self.instances / instance, self.desired_ingress()
        others = [p for p in self.instances.iterdir() if p.name != instance]
        if others:
            raise ValueError('VPN instance already exists')
        if not path.exists():
            if self.container_id(instance) or self.resource(instance, 'network') or self.resource(instance, 'volume'):
                raise ValueError('Unexpected VPN resources without state')
            directory(path)
        directory(path, create=False)
        local = path / 'state.json'
        if not local.exists() and not local.is_symlink():
            if any(path.iterdir()):
                raise ValueError('Incomplete VPN instance state')
            atomic(local, {'installation': self.installation, 'instance_id': instance, 'ingress': desired, 'storage_created': False})
        state = self.state(instance)
        self.resource(instance, 'network', create=True)
        if not self.resource(instance, 'volume', create=not state['storage_created']):
            raise ValueError('VPN state volume is missing')
        if not state['storage_created']:
            state['storage_created'] = True
            atomic(local, state)
        obj = self.inspect(instance)
        if state['ingress'] != desired:
            if obj and obj['State'].get('Running'):
                raise Failure(409, 'ocserv_conflict', 'Отключите модуль перед изменением адреса VPN.')
            if obj:
                self.docker('container', 'rm', obj['Id'])
            atomic(local, {**state, 'ingress': desired})
            obj = None
        self.start(instance, obj or self.create(instance))

    def remove(self, instance):
        path = self.instances / instance
        if not path.exists():
            if self.container_id(instance) or self.resource(instance, 'network') or self.resource(instance, 'volume'):
                raise ValueError('Unexpected VPN resources without state')
            return
        directory(path, create=False)
        entries = {p.name for p in path.iterdir()}
        if not entries:
            if self.container_id(instance) or self.resource(instance, 'network') or self.resource(instance, 'volume'):
                raise ValueError('Unexpected VPN resources without state')
            path.rmdir()
            _files.fsync_directory(self.instances)
            return
        if entries != {'state.json'}:
            raise ValueError('Unexpected private VPN instance files')
        self.state(instance)
        obj = self.inspect(instance)
        volume, network = self.resource(instance, 'volume'), self.resource(instance, 'network')
        if volume:
            users = self.docker('container', 'ls', '-a', '--no-trunc', '--filter', 'volume=' + volume['Name'], '--format', '{{.ID}}').decode().split()
            if set(users) - ({obj['Id']} if obj else set()):
                raise ValueError('Foreign container uses the VPN volume')
        if obj:
            self.stop(obj)
            self.docker('container', 'rm', obj['Id'])
        if network:
            self.docker('network', 'rm', network['Id'])
        if volume:
            self.docker('volume', 'rm', volume['Name'])
        (path / 'state.json').unlink()
        path.rmdir()
        _files.fsync_directory(self.instances)

    def observe(self, instance):
        result = {'state': 'absent', 'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        if not (self.instances / instance).exists():
            if self.container_id(instance) or self.resource(instance, 'network') or self.resource(instance, 'volume'):
                raise ValueError('Unexpected VPN resources without state')
            return result
        obj = self.inspect(instance)
        if not obj:
            raise ValueError('VPN container is missing')
        running = obj['State'].get('Running')
        if running:
            reply = self.call(obj, 'state', {})
            if reply['status'] != 200 or not isinstance(reply['body'].get('gateway'), dict):
                raise ValueError('VPN management unavailable')
        return {**result, 'state': 'running' if running else 'disabled', 'version': self.version}

    @contextmanager
    def transaction_lock(self, instance, mutable=False, host=False):
        # A writer can leave a durable journal if its process is interrupted.
        # Inspect it under the instance lock before letting a reader see the gateway.
        if not mutable:
            with self.locked(instance):
                if not self.wizard.pending(instance).exists() and not self.wizard.stage_path(instance).exists():
                    yield
                    return
        with self.locked(instance, exclusive=True):
            recover = self.wizard.pending(instance).exists() or self.wizard.stage_path(instance).exists()
            with (lock(self.root / 'modules/controller.lock') if host or recover else nullcontext()):
                if recover:
                    self.wizard.recover(instance)
                yield

    def recover_setup(self):
        for path in self.operations.glob('setup-*'):
            match = re.fullmatch(r'setup-([0-9a-f-]{36})\.(?:pending|stage)', path.name)
            if match:
                with self.transaction_lock(identifier(match[1]), mutable=True):
                    pass

    def get(self, instance):
        with self.transaction_lock(instance):
            return self.observe(instance)

    def execute(self, body):
        if (not isinstance(body, dict) or set(body) != {'module_id', 'instance_id', 'operation_id', 'action'}
                or body['module_id'] != 'ocserv' or body['action'] not in ('install', 'enable', 'refresh', 'disable', 'remove')):
            raise ValueError('Unknown VPN lifecycle operation')
        instance, operation, action = identifier(body['instance_id']), identifier(body['operation_id']), body['action']
        journal, fingerprint = self.operations / (operation + '.json'), hashlib.sha256(encoded(body)).hexdigest()
        mutable = action != 'refresh'
        with _files.operation_lock(self.operations, operation), self.transaction_lock(instance, mutable=mutable, host=mutable):
            if journal.exists() or journal.is_symlink():
                stored = json.loads(read_file(journal))
                if stored['fingerprint'] != fingerprint:
                    raise ValueError('VPN operation identity conflict')
                if stored['phase'] == 'complete':
                    return {**self.observe(instance), 'operation_id': operation}
            atomic(journal, {'fingerprint': fingerprint, 'phase': 'running'})
            try:
                if action in ('install', 'enable'):
                    self.ensure(instance)
                elif action == 'disable' and (self.instances / instance).exists():
                    self.stop(self.inspect(instance))
                elif action == 'remove':
                    self.remove(instance)
                result = self.observe(instance)
            except (ValueError, OSError, KeyError, TypeError) as exc:
                message = str(exc) if isinstance(exc, Failure) else _files.module_network_error(exc, 'Проверьте состояние шлюза VPN и его конфигурацию на хосте PL.')
                return {'operation_id': operation, 'state': 'error', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0, 'error': message}
            atomic(journal, {'fingerprint': fingerprint, 'phase': 'complete'})
            return {**result, 'operation_id': operation}

    @staticmethod
    def fields(action, payload):
        fields = set(payload)
        if action == 'configure':
            mandatory = _setup.REQUIRED - {'issuer', 'client_id'} if payload.get('auth_mode') == 'certificate' else _setup.REQUIRED
            return mandatory <= fields <= (_setup.REQUIRED | _setup.OPTIONAL | {'auth_mode'})
        if action == 'connection':
            if 'status_only' in fields:
                if payload['status_only'] is not True:
                    return False
                fields.remove('status_only')
            if fields == {'subject'}:
                return isinstance(payload['subject'], str) and _setup.SUBJECT.fullmatch(payload['subject']) is not None
            return fields == {'portal_user_id'} and _setup.valid_portal_id(payload['portal_user_id'])
        return fields == ROUTES[action]

    def request(self, request):
        instance = identifier(request.get('instance_id') if isinstance(request, dict) else None)
        try:
            action, payload = request.get('action'), request.get('payload')
            if (set(request) != {'instance_id', 'action', 'payload'} or not isinstance(action, str) or action not in ROUTES
                    or not isinstance(payload, dict) or not self.fields(action, payload)
                    or len(encoded(request)) > (300 * 1024 if action == 'configure' else 16384)):
                raise Failure(400, 'ocserv_invalid', 'Проверьте параметры запроса VPN.')
            if not self.slots.acquire(blocking=False):
                raise Failure(429, 'ocserv_limit', 'Шлюз VPN обрабатывает другие запросы.')
            try:
                with self.transaction_lock(instance, mutable=action not in ('state', 'setup', 'discover', 'connection'),
                                           host=action == 'configure'):
                    if not (self.instances / instance).is_dir():
                        if action == 'connection':
                            raise _setup.unavailable()
                        raise Failure(404, 'ocserv_not_installed', 'Корпоративный VPN не установлен.')
                    if action == 'discover':
                        body = self.wizard.discovery().discover()
                        return {'instance_id': instance, 'status': 200, 'body': body}
                    obj = self.inspect(instance)
                    if action == 'connection':
                        body = self.wizard.connection(instance, payload, obj)
                    elif action == 'setup':
                        live = self.wizard.snapshot(obj) if obj and obj['State'].get('Running') else {}
                        body = self.wizard.describe(instance, self.wizard.entries(), live)
                    else:
                        if obj and not obj['State'].get('Running'):
                            raise Failure(409, 'ocserv_disabled', 'Включите модуль VPN в PL.')
                        if action == 'configure':
                            body = self.wizard.configure(instance, payload, obj)
                        else:
                            reply = self.call(obj, action, payload)
                            if reply['status'] == 200 and self.state(instance)['ingress'] is None:
                                reply['body']['gateway']['ready'] = False
                            return {'instance_id': instance, **reply}
                    reply = {'status': 200, 'body': body}
            finally:
                self.slots.release()
        except Failure as exc:
            reply = {'status': exc.status, 'body': {'error': {'code': exc.code, 'message': str(exc)}}}
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            reply = {'status': 503, 'body': {'error': {'code': 'ocserv_unavailable', 'message': 'Шлюз VPN недоступен.'}}}
        return {'instance_id': instance, **reply}
