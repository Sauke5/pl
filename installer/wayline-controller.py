#!/usr/bin/env python3
"""Owned Wayline lifecycle and finite authenticated loopback gateway transport.

The Platform authenticates/authorizes each browser request before signing this
transport. No browser headers, upstream URL or Docker arguments are accepted.
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager

_helper = Path(__file__).with_name('xray-controller.py')
if _helper.is_symlink() or not _helper.is_file():
    raise ValueError('Trusted file primitives unavailable')
_spec = importlib.util.spec_from_file_location('pl_wayline_files', _helper)
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
identifier, directory, read_file = _files.identifier, _files.directory, _files.read_file
atomic, encoded, fsync_directory = _files.atomic, _files.encoded, _files.fsync_directory

MAX_BODY = 256 * 1024
MAX_RESPONSE = 4 * 1024 * 1024
ROLES = ('runner', 'api', 'gateway')
RUNNER_GID = 10001
ROUTE_MAX_AGE = 30.0


def canonical_capabilities(value):
    # Docker accepts both NET_RAW and CAP_NET_RAW; inspect may emit the latter.
    # Keep list shape and duplicates so normalization cannot hide extra entries.
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(cap, str) or not re.fullmatch(r'(?:CAP_)?[A-Z][A-Z0-9_]*', cap) for cap in value):
        raise ValueError('Invalid Wayline capability metadata')
    return [cap.removeprefix('CAP_') for cap in value]


def allowed_request(method, path, query, content_type, raw):
    if (not isinstance(path, str) or len(path) > 1024 or not path.startswith('/')
            or any(c in path for c in ('%', '\\', '?', '#', '//'))
            or any(ord(c) <= 32 or ord(c) == 127 for c in path)
            or '..' in path.split('/') or not isinstance(query, str) or len(query) > 4096
            or any(ord(c) <= 32 or ord(c) == 127 for c in query)):
        raise ValueError('Invalid Wayline path or query')
    object_id = r'[1-9][0-9]{0,18}'
    allowed = (method in ('GET', 'HEAD') and (path in ('/', '/index.html', '/favicon.svg', '/assets/theme-init.js',
                                            '/api/v1/health', '/api/v1/ready', '/api/v1/targets',
                                            '/api/v1/checks', '/api/v1/checks/latest', '/metrics')
               or re.fullmatch(r'/assets/[A-Za-z0-9_-]+\.(js|css|svg|woff2)', path)
               or re.fullmatch(r'/api/v1/(targets|checks)/' + object_id, path)))
    allowed = allowed or (method == 'POST' and (path == '/api/v1/targets'
                          or re.fullmatch(r'/api/v1/targets/' + object_id + '/checks', path)))
    allowed = allowed or (method in ('PUT', 'DELETE') and re.fullmatch(r'/api/v1/targets/' + object_id, path))
    if not allowed or len(raw) > MAX_BODY:
        raise ValueError('Unsupported Wayline request')
    parsed = urllib.parse.parse_qs(query, keep_blank_values=True, strict_parsing=True) if query else {}
    query_fields = {'kind', 'target_id', 'limit'} if path in ('/api/v1/checks', '/api/v1/checks/latest') else set()
    if set(parsed) - query_fields or any(len(values) != 1 for values in parsed.values()):
        raise ValueError('Unsupported Wayline query')
    if method in ('POST', 'PUT'):
        if content_type != 'application/json' or not raw:
            raise ValueError('Wayline mutation requires JSON')
    elif raw or content_type:
        raise ValueError('Unexpected Wayline request body')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class WaylineController:
    def __init__(self, parent):
        self.parent, self.root, self.installation = parent, Path(parent.root), parent.installation
        self.docker = parent.docker
        self._routes = {}
        self.images = self.resolve_images()
        self.version = self.images['api']['labels']['org.opencontainers.image.version']
        self.base = self.root / 'modules' / 'wayline'
        directory(self.base)
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        directory(self.instances)
        directory(self.operations)

    def resolve_images(self):
        directory(self.root / 'private', create=False)
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        state = json.loads(read_file(self.root / 'state/installation.json'))
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or state.get('install_id') != self.installation
                or registry.get('manifest_sha256') != state.get('manifest_sha256')
                or not re.fullmatch(r'[0-9a-f]{64}', registry.get('manifest_sha256', ''))):
            raise ValueError('Invalid Wayline installation image contract')
        bundle = registry.get('wayline', {})
        if not isinstance(bundle, dict) or set(bundle) != set(ROLES):
            raise ValueError('Invalid bundled Wayline roles')
        result = {}
        for role in ROLES:
            image = bundle[role]
            labels = image.get('labels', {})
            if (set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                    or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                    or image.get('architecture') not in ('amd64', 'arm64')
                    or image.get('recipe') != 'deploy/images/wayline.Dockerfile'
                    or labels.get('pl.module.id') != 'wayline' or labels.get('pl.module.role') != role
                    or labels.get('pl.module.config.version') != '1' or labels.get('pl.build.variant') != 'source-build'
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', labels.get('org.opencontainers.image.version', ''))):
                raise ValueError('Invalid bundled Wayline image contract')
            result[role] = image
        if len({image['labels']['org.opencontainers.image.version'] for image in result.values()}) != 1:
            raise ValueError('Wayline component versions differ')
        return result

    def verify_image(self, role):
        contract = self.images[role]
        image = json.loads(self.docker('image', 'inspect', contract['id']))[0]
        if (image.get('Id') != contract['id'] or image.get('Os') != 'linux'
                or image.get('Architecture') != contract['architecture']
                or any((image.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in contract['labels'].items())):
            raise ValueError('Wayline image identity mismatch')
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
        # A long check must not block unrelated modules; removal must not recycle
        # the gateway port while an authenticated request is still in flight.
        path = self.operations / ('instance-' + identifier(instance) + '.lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if (os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600
                or not os.path.isfile(path)):
            os.close(fd)
            raise ValueError('Unsafe Wayline instance lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def name(self, instance, suffix=''):
        return self.installation + '-wayline-' + identifier(instance) + suffix

    def labels(self, instance, role=None):
        labels = {'pl.installation': self.installation, 'pl.module': 'wayline', 'pl.instance': identifier(instance)}
        if role:
            labels['pl.module.role'] = role
        return labels

    def paths(self, instance, create=False):
        base = self.instances / identifier(instance)
        directory(base, create=create)
        directory(base / 'config', create=create, mode=0o755)
        return base

    def state(self, instance):
        base = self.paths(instance)
        state = json.loads(read_file(base / 'state.json'))
        if (set(state) != {'installation', 'instance_id', 'password', 'runner_token'} or state['installation'] != self.installation
                or state['instance_id'] != instance or not re.fullmatch(r'[0-9a-f]{64}', state.get('runner_token', ''))
                or not re.fullmatch(r'[0-9a-f]{64}', state.get('password', ''))):
            raise ValueError('Invalid Wayline state')
        password = state['password']
        expected = ('pl:{SHA}' + base64.b64encode(hashlib.sha1(password.encode()).digest()).decode() + '\n').encode()
        if read_file(base / 'config/htpasswd', mode=0o444) != expected:
            raise ValueError('Wayline gateway credential drift')
        token = base / 'config/runner-token'
        if read_file(token, mode=0o440) != state['runner_token'].encode() or token.stat().st_gid != RUNNER_GID:
            raise ValueError('Wayline runner credential drift')
        return state

    def initialize(self, instance):
        base = self.paths(instance, create=True)
        if (base / 'state.json').exists() or (base / 'state.json').is_symlink():
            state = json.loads(read_file(base / 'state.json'))
            if (set(state) != {'installation', 'instance_id', 'password', 'runner_token'}
                    or state.get('installation') != self.installation or state.get('instance_id') != instance
                    or any(not re.fullmatch(r'[0-9a-f]{64}', state.get(k, '')) for k in ('password', 'runner_token'))):
                raise ValueError('Invalid Wayline initialization journal')
        else:
            if list((base / 'config').iterdir()):
                raise ValueError('Wayline unmanaged configuration exists')
            state = {'installation': self.installation, 'instance_id': instance,
                     'password': secrets.token_hex(32), 'runner_token': secrets.token_hex(32)}
            atomic(base / 'state.json', state)
        if set(p.name for p in (base / 'config').iterdir()) - {'htpasswd', 'runner-token'}:
            raise ValueError('Unknown Wayline initialization files')
        password = state['password']
        credential = ('pl:{SHA}' + base64.b64encode(hashlib.sha1(password.encode()).digest()).decode() + '\n').encode()
        for name, data, mode in (('htpasswd', credential, 0o444), ('runner-token', state['runner_token'].encode(), 0o440)):
            path = base / 'config' / name
            if path.exists() or path.is_symlink():
                if read_file(path, mode=mode) != data:
                    raise ValueError('Wayline credential drift')
            else:
                atomic(path, data, mode=mode)
                if name == 'runner-token':
                    os.chown(path, -1, RUNNER_GID)
        self.state(instance)

    def resource(self, instance, kind):
        suffix = '-data' if kind == 'volume' else '-net'
        name = self.name(instance, suffix)
        found = self.docker(kind, 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found:
            return None
        obj = json.loads(self.docker(kind, 'inspect', name))[0]
        if kind == 'network':
            _files.validate_module_network(self.root, self.installation, obj, self.docker)
        if (obj.get('Name') != name or obj.get('Driver') != ('local' if kind == 'volume' else 'bridge')
                or obj.get('Options') or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())
                or (kind == 'network' and (obj.get('Internal') or obj.get('Ingress') or obj.get('Scope') != 'local'))):
            raise ValueError('Wayline ' + kind + ' ownership mismatch')
        return obj

    def create_resource(self, instance, kind):
        if self.resource(instance, kind) is None:
            args = [kind, 'create']
            if kind == 'network':
                args += ['--driver', 'bridge'] + _files.module_network_args(self.root, self.installation, self.docker)
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, self.name(instance, '-data' if kind == 'volume' else '-net'))
        if self.resource(instance, kind) is None:
            raise ValueError('Wayline resource creation unconfirmed')

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
        token_mount = ('bind', str(self.paths(instance) / 'config/runner-token'), '/run/secrets/runner-token', False)
        expected = {('volume', self.name(instance, '-data'), '/data', True), token_mount} if role == 'api' else (
            {token_mount} if role == 'runner' else {('bind', str(self.paths(instance) / 'config/htpasswd'), '/run/secrets/wayline.htpasswd', False)})
        ports = host.get('PortBindings') or {}
        expected_ports = role == 'gateway' and set(ports) == {'8080/tcp'} and len(ports['8080/tcp']) == 1 and ports['8080/tcp'][0].get('HostIp') == '127.0.0.1'
        image_config = image.get('Config', {})
        if (not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', '')) or obj.get('Image') != self.images[role]['id']
                or config.get('Image') != self.images[role]['id'] or mounts != expected
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.labels(instance, role).items())
                or (role != 'gateway' and ports) or (role == 'gateway' and not expected_ports)
                or any(config.get(k) != image_config.get(k) for k in ('Entrypoint', 'Cmd', 'Env', 'WorkingDir', 'User'))
                or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapDrop') != ['ALL']
                or canonical_capabilities(host.get('CapAdd')) != (['NET_RAW'] if role == 'runner' else []) or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts')
                or host.get('NetworkMode') != self.name(instance, '-net')
                or set(obj.get('NetworkSettings', {}).get('Networks', {})) != {self.name(instance, '-net')}
                or host.get('Memory') != 256 * 1024**2 or host.get('NanoCpus') != 1_000_000_000
                or host.get('PidsLimit') != 128 or not host.get('Init')
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('Tmpfs') != {'/tmp': 'rw,noexec,nosuid,size=33554432,mode=1777'}
                or host.get('PidMode') not in (None, '') or host.get('IpcMode') not in (None, 'private')
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])):
            raise ValueError('Wayline container drift; manual inspection required')
        network = self.resource(instance, 'network')
        if network is None or self.resource(instance, 'volume') is None:
            raise ValueError('Wayline managed resources missing')
        if any(member.get('Name') not in {self.name(instance, '-' + role) for role in ROLES}
               for member in network.get('Containers', {}).values()):
            raise ValueError('Foreign container attached to Wayline network')
        return obj

    def create_container(self, instance, role):
        self.verify_image(role)
        args = ['container', 'create', '--name', self.name(instance, '-' + role), '--network', self.name(instance, '-net'),
                '--network-alias', role, '--restart', 'unless-stopped', '--init', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--cpus', '1', '--pids-limit', '128',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=33554432,mode=1777',
                '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2']
        if role == 'runner':
            args += ['--cap-add', 'NET_RAW', '--network-alias', 'wayline-runner']
        if role != 'gateway':
            args += ['--mount', 'type=bind,source=' + str(self.paths(instance) / 'config/runner-token') + ',target=/run/secrets/runner-token,readonly']
        if role == 'api':
            args += ['--mount', 'type=volume,source=' + self.name(instance, '-data') + ',target=/data']
        elif role == 'gateway':
            args += ['--publish', '127.0.0.1::8080', '--mount',
                     'type=bind,source=' + str(self.paths(instance) / 'config/htpasswd') + ',target=/run/secrets/wayline.htpasswd,readonly']
        for key, value in self.labels(instance, role).items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.images[role]['id'])
        if self.inspect(instance, role) is None:
            raise ValueError('Wayline container creation unconfirmed')

    def endpoint(self, obj):
        ports = obj.get('NetworkSettings', {}).get('Ports', {}).get('8080/tcp') or []
        if (len(ports) != 1 or ports[0].get('HostIp') != '127.0.0.1'
                or not str(ports[0].get('HostPort', '')).isdigit() or not 1 <= int(ports[0]['HostPort']) <= 65535):
            raise ValueError('Invalid Wayline loopback binding')
        return 'http://127.0.0.1:' + ports[0]['HostPort']

    def http(self, instance, obj, method, path, query='', content_type='', raw=b''):
        password = self.state(instance)['password']
        headers = {'Authorization': 'Basic ' + base64.b64encode(('pl:' + password).encode()).decode(), 'Accept-Encoding': 'identity'}
        if content_type:
            headers['Content-Type'] = content_type
        request = urllib.request.Request(self.endpoint(obj) + path + ('?' + query if query else ''),
                                         data=raw if method in ('POST', 'PUT') else None, headers=headers, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            response = opener.open(request, timeout=220 if method == 'POST' and path.endswith('/checks') else 5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE or not 200 <= response.status < 500 or 300 <= response.status < 400:
                raise ValueError('Wayline response exceeds finite contract')
            mime = response.headers.get_content_type()
            if mime not in ('application/json', 'text/html', 'text/css', 'text/javascript', 'application/javascript',
                            'image/svg+xml', 'font/woff2', 'text/plain'):
                raise ValueError('Unsupported Wayline response type')
            return response.status, mime, body

    def ready(self, instance):
        try:
            obj = self._ready(instance)
            self._routes[instance] = (time.monotonic(), obj)
            return obj
        except Exception:
            self._routes.pop(instance, None)
            raise

    def _ready(self, instance):
        gateway = self.inspect(instance, 'gateway')
        api = self.inspect(instance, 'api')
        runner = self.inspect(instance, 'runner')
        if not gateway or not api or not runner or not all(obj.get('State', {}).get('Running') for obj in (gateway, api, runner)):
            raise ValueError('Wayline components are stopped')
        status, _, body = self.http(instance, gateway, 'GET', '/api/v1/health')
        if status != 200 or json.loads(body).get('version') != self.version:
            raise ValueError('Wayline runtime version mismatch')
        status, _, body = self.http(instance, gateway, 'GET', '/api/v1/ready')
        if status != 200 or json.loads(body).get('status') != 'ready':
            raise ValueError('Wayline database is not ready')
        return gateway

    def ensure(self, instance):
        self.initialize(instance)
        for kind in ('network', 'volume'):
            self.create_resource(instance, kind)
        for role in ROLES:
            obj = self.inspect(instance, role)
            if obj is None:
                self.create_container(instance, role)
                obj = self.inspect(instance, role)
            if not obj.get('State', {}).get('Running'):
                self.docker('container', 'start', obj['Id'])
        deadline = time.monotonic() + 30
        while True:
            try:
                self.ready(instance)
                return
            except (ValueError, OSError):
                if time.monotonic() >= deadline:
                    raise ValueError('Wayline readiness unconfirmed') from None
                time.sleep(0.25)

    def observe(self, instance):
        try:
            result = self._observe(instance)
            if result['state'] != 'running':
                self._routes.pop(instance, None)
            return result
        except Exception:
            self._routes.pop(instance, None)
            raise

    def _observe(self, instance):
        base = self.instances / identifier(instance)
        if not base.exists() and not base.is_symlink():
            if any(self.resource(instance, kind) for kind in ('network', 'volume')) or any(self.inspect(instance, role) for role in ROLES):
                raise ValueError('Wayline artifacts have no managed state')
            return {'state': 'absent', 'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        self.state(instance)
        objects = [self.inspect(instance, role) for role in ROLES]
        if any(obj is None for obj in objects):
            raise ValueError('Wayline components incomplete')
        running = [bool(obj.get('State', {}).get('Running')) for obj in objects]
        if any(running) and not all(running):
            raise ValueError('Wayline components have mixed state')
        result = {'state': 'disabled', 'version': self.version, 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        if all(running):
            result.update(state='running', endpoint=self.endpoint(self.ready(instance)))
        return result

    def remove(self, instance):
        base = self.instances / identifier(instance)
        marker = self.operations / ('remove-' + instance + '.json')
        expected = {'state.json': 0o600, 'config/htpasswd': 0o444, 'config/runner-token': 0o440}
        if not base.exists() and not base.is_symlink():
            self.observe(instance)
            if marker.exists() or marker.is_symlink():
                value = json.loads(read_file(marker))
                if value.get('installation') != self.installation or value.get('instance_id') != instance:
                    raise ValueError('Invalid Wayline removal journal')
                marker.unlink()
                fsync_directory(self.operations)
            return
        if not marker.exists() and not marker.is_symlink():
            self.state(instance)
            if set(p.name for p in base.iterdir()) != {'state.json', 'config'} or set(p.name for p in (base / 'config').iterdir()) != {'htpasswd', 'runner-token'}:
                raise ValueError('Unknown Wayline removal files')
            objects = [self.inspect(instance, role) for role in ROLES]
            network = self.resource(instance, 'network')
            self.resource(instance, 'volume')
            owned_ids = {obj['Id'] for obj in objects if obj}
            if network and set(network.get('Containers', {})) - owned_ids:
                raise ValueError('Foreign container attached to Wayline network')
            files = {name: hashlib.sha256(read_file(base / name, mode=mode)).hexdigest() for name, mode in expected.items()}
            atomic(marker, {'installation': self.installation, 'instance_id': instance, 'files': files})
        journal = json.loads(read_file(marker))
        if (set(journal) != {'installation', 'instance_id', 'files'} or journal['installation'] != self.installation
                or journal['instance_id'] != instance or not isinstance(journal['files'], dict)
                or set(journal['files']) != set(expected)
                or any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v) for v in journal['files'].values())):
            raise ValueError('Invalid Wayline removal journal')
        directory(base, create=False)
        if set(p.name for p in base.iterdir()) - {'state.json', 'config'}:
            raise ValueError('Unknown Wayline removal artifacts')
        config = base / 'config'
        if config.exists() or config.is_symlink():
            directory(config, create=False, mode=0o755)
            if set(p.name for p in config.iterdir()) - {'htpasswd', 'runner-token'}:
                raise ValueError('Unknown Wayline removal configuration')
        for name, mode in expected.items():
            path = base / name
            if (path.exists() or path.is_symlink()) and hashlib.sha256(read_file(path, mode=mode)).hexdigest() != journal['files'][name]:
                raise ValueError('Wayline removal artifact changed')
        objects = [self.inspect(instance, role) for role in ROLES]
        network = self.resource(instance, 'network')
        owned_ids = {obj['Id'] for obj in objects if obj}
        if network and set(network.get('Containers', {})) - owned_ids:
            raise ValueError('Foreign container attached to Wayline network')
        for obj in reversed(objects):
            if obj:
                if obj.get('State', {}).get('Running'):
                    self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                self.docker('container', 'rm', obj['Id'])
        for kind in ('volume', 'network'):
            if self.resource(instance, kind):
                self.docker(kind, 'rm', self.name(instance, '-data' if kind == 'volume' else '-net'))
            if self.resource(instance, kind):
                raise ValueError('Wayline resource removal unconfirmed')
        # Journal authenticates remaining files after an interrupted unlink.
        for name in ('config/htpasswd', 'config/runner-token', 'state.json'):
            (base / name).unlink(missing_ok=True)
        if config.exists():
            config.rmdir()
        base.rmdir()
        fsync_directory(self.instances)
        marker.unlink()
        fsync_directory(self.operations)

    def execute(self, body):
        if (not isinstance(body, dict) or set(body) != {'operation_id', 'instance_id', 'module_id', 'action'}
                or body.get('module_id') != 'wayline' or body.get('action') not in ('install', 'enable', 'disable', 'refresh', 'remove')):
            raise ValueError('Unsupported Wayline operation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        with self.instance_lock(instance, exclusive=True), self.locked():
            self._routes.pop(instance, None)
            path = self.operations / (operation + '.json')
            fingerprint = hashlib.sha256(encoded(body)).hexdigest()
            if path.exists() or path.is_symlink():
                previous = json.loads(read_file(path))
                if previous.get('fingerprint') != fingerprint:
                    raise ValueError('Wayline operation ID conflict')
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
                self._routes.pop(instance, None)
                return {'state': 'error', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0,
                        'error': _files.module_network_error(error, 'Wayline operation unconfirmed; reconcile the same operation'), 'operation_id': operation}

    def get(self, instance):
        with self.instance_lock(instance), self.locked():
            return self.observe(identifier(instance))

    def request(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id', 'method', 'path', 'query', 'content_type', 'body'}:
            raise ValueError('Invalid Wayline gateway request')
        instance = identifier(body['instance_id'])
        if not isinstance(body['body'], str) or len(body['body']) > 4 * ((MAX_BODY + 2) // 3):
            raise ValueError('Invalid Wayline body')
        raw = base64.b64decode(body['body'], validate=True)
        allowed_request(body['method'], body['path'], body['query'], body['content_type'], raw)
        with self.instance_lock(instance):
            route = self._routes.get(instance)
            if route is None or not 0 <= time.monotonic() - route[0] < ROUTE_MAX_AGE:
                # Only a cold/expired route enters full Docker/health validation.
                # Recheck after admission so concurrent page assets share one refresh.
                with self.locked():
                    route = self._routes.get(instance)
                    if route is None or not 0 <= time.monotonic() - route[0] < ROUTE_MAX_AGE:
                        self.ready(instance)
                        route = self._routes[instance]
            try:
                status, content_type, response = self.http(instance, route[1], body['method'], body['path'], body['query'], body['content_type'], raw)
            except Exception:
                self._routes.pop(instance, None)
                raise
        return {'instance_id': instance, 'status': status, 'content_type': content_type,
                'body': base64.b64encode(response).decode('ascii')}
