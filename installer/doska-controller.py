#!/usr/bin/env python3
"""Owned Doska lifecycle and finite authenticated loopback gateway transport.

The Platform authenticates/authorizes each browser request before signing this
transport. No browser headers, upstream URL or Docker arguments are accepted.
"""
from __future__ import annotations

import fcntl
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import select
import socket
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager, nullcontext

_helper = Path(__file__).with_name('xray-controller.py')
if _helper.is_symlink() or not _helper.is_file():
    raise ValueError('Trusted file primitives unavailable')
_spec = importlib.util.spec_from_file_location('pl_doska_files', _helper)
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
identifier, directory, read_file = _files.identifier, _files.directory, _files.read_file
atomic, encoded, fsync_directory = _files.atomic, _files.encoded, _files.fsync_directory

MAX_BODY = 26 * 1024 * 1024
MAX_RESPONSE = 26 * 1024 * 1024
ROLES = ('database', 'api', 'web')
API_GID = 10001
DATABASE_GID = 70
ROUTE_MAX_AGE = 30


@contextmanager
def client_stream_guard(handler, upstream):
    """Release a native SSE reader when its gateway connection disappears."""
    client = getattr(handler, 'connection', None)
    if not isinstance(client, socket.socket) or not isinstance(upstream, socket.socket):
        yield None
        return
    finished, disconnected = threading.Event(), threading.Event()

    def watch():
        while not finished.is_set():
            try:
                readable, _, errors = select.select([client], [], [client], 0.1)
                if not readable and not errors:
                    continue
                if not errors:
                    # The finite signed input is fully consumed, and this
                    # response closes its connection. EOF or extra pipelined
                    # input both end the stream; never consume client bytes.
                    client.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
            except (BlockingIOError, InterruptedError):
                continue
            except (OSError, ValueError):
                pass
            if finished.is_set():
                return
            disconnected.set()
            try:
                # close() alone does not interrupt HTTPResponse's buffered
                # socket read. Shutdown wakes it without waiting for heartbeat.
                upstream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return

    # The gateway/controller's existing SSE admission bounds these watchers.
    watcher = threading.Thread(target=watch, name='pl-doska-sse-disconnect', daemon=True)
    watcher.start()
    try:
        yield disconnected
    finally:
        finished.set()
        watcher.join(timeout=1)


def allowed_request(role, method, path, query, content_type, raw, headers):
    if (role not in ('api', 'web') or method not in ('GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE')
            or not isinstance(path, str) or not isinstance(query, str) or not path.startswith('/') or len(path) > 4096
            or any(c in path for c in ('\\', '?', '#', '//', '%')) or '..' in urllib.parse.unquote(path).split('/')
            or any(ord(c) <= 32 or ord(c) == 127 for c in path + query)
            or not isinstance(query, str) or len(query) > 4096 or len(raw) > MAX_BODY
            or not isinstance(content_type, str) or len(content_type) > 256
            or any(ord(c) < 32 or ord(c) == 127 for c in content_type)):
        raise ValueError('Invalid Doska request')
    names = {name.lower(): name for name in ('X-PL-Gateway-Assertion', 'X-PL-Gateway-Signature',
             'X-CSRF-Token', 'Idempotency-Key', 'Last-Event-ID', 'Accept', 'Accept-Language',
             'If-None-Match', 'If-Modified-Since', 'Range', 'If-Range', 'Content-Range')}
    if not isinstance(headers, dict) or any(not isinstance(k, str) or k.lower() not in names for k in headers):
        raise ValueError('Unsupported Doska gateway headers')
    normalized = {names[key.lower()]: value for key, value in headers.items()}
    if len(normalized) != len(headers):
        raise ValueError('Duplicate Doska gateway headers')
    headers = normalized
    if any(not isinstance(v, str) or len(v) > 16384 or any(ord(c) < 32 or ord(c) == 127 for c in v)
           for v in headers.values()):
        raise ValueError('Invalid Doska gateway header')
    if role == 'web':
        if method not in ('GET', 'HEAD') or raw or content_type or not path.startswith('/doska/') or path.startswith('/doska/api/'):
            raise ValueError('Unsupported Doska web request')
    elif (not path.startswith('/api/') or not headers.get('X-PL-Gateway-Assertion')
          or not headers.get('X-PL-Gateway-Signature') or path.startswith(('/api/auth', '/api/admin', '/api/ws'))):
        raise ValueError('Doska API requires a native signed gateway request')
    if method in ('GET', 'HEAD') and (raw or content_type):
        raise ValueError('Unexpected Doska body')
    return headers


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class DoskaController:
    def __init__(self, parent):
        self.parent, self.root, self.installation = parent, Path(parent.root), parent.installation
        self.docker = parent.docker
        self.images = self.resolve_images()
        self.version = self.images['api']['labels']['org.opencontainers.image.version']
        self.base = self.root / 'modules' / 'doska'
        directory(self.base)
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        directory(self.instances)
        directory(self.operations)
        self._routes, self._route_lock = {}, threading.RLock()

    def resolve_images(self):
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        state = json.loads(read_file(self.root / 'state/installation.json'))
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or state.get('install_id') != self.installation
                or registry.get('manifest_sha256') != state.get('manifest_sha256')
                or not re.fullmatch(r'[0-9a-f]{64}', registry.get('manifest_sha256', ''))):
            raise ValueError('Invalid Doska installation image contract')
        bundle = registry.get('doska', {})
        if not isinstance(bundle, dict) or set(bundle) != set(ROLES):
            raise ValueError('Invalid bundled Doska roles')
        for role, image in bundle.items():
            labels = image.get('labels', {})
            if (set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                    or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                    or image.get('architecture') not in ('amd64', 'arm64')):
                raise ValueError('Invalid bundled Doska image identity')
            if role == 'database':
                if image.get('recipe') != 'deploy/images/postgres.Dockerfile' or labels.get('pl.component') != 'postgresql':
                    raise ValueError('Doska requires the core PostgreSQL recipe')
            elif (image.get('recipe') != 'deploy/images/doska.Dockerfile' or labels.get('pl.module.id') != 'doska'
                    or labels.get('pl.module.role') != role or labels.get('pl.module.config.version') != '1'
                    or labels.get('pl.build.variant') != 'source-build'
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', labels.get('org.opencontainers.image.version', ''))):
                raise ValueError('Invalid bundled Doska application contract')
        if bundle['api']['labels']['org.opencontainers.image.version'] != bundle['web']['labels']['org.opencontainers.image.version']:
            raise ValueError('Doska application versions differ')
        return bundle

    def verify_image(self, role):
        contract = self.images[role]
        image = json.loads(self.docker('image', 'inspect', contract['id']))[0]
        if (image.get('Id') != contract['id'] or image.get('Os') != 'linux'
                or image.get('Architecture') != contract['architecture']
                or any((image.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in contract['labels'].items())):
            raise ValueError('Doska image identity mismatch')
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
            raise ValueError('Unsafe Doska instance lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def name(self, instance, suffix=''):
        return self.installation + '-doska-' + identifier(instance) + suffix

    def labels(self, instance, role=None):
        labels = {'pl.installation': self.installation, 'pl.module': 'doska', 'pl.instance': identifier(instance)}
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
        if (set(state) != {'installation', 'instance_id', 'database_password', 'auth_secret', 'origin', 'ca_sha256'}
                or state.get('installation') != self.installation or state.get('instance_id') != instance
                or any(not re.fullmatch(r'[0-9a-f]{64}', state.get(k, '')) for k in ('database_password', 'auth_secret', 'ca_sha256'))):
            raise ValueError('Invalid Doska state')
        configured_origin = json.loads(read_file(self.root / 'state/installation.json')).get('config', {}).get('public_url', '').rstrip('/')
        if state['origin'] != configured_origin:
            raise ValueError('Doska installation origin drift')
        expected = self.credentials(instance, state)
        for name, value in expected.items():
            path = base / 'config' / name
            if read_file(path, mode=0o440) != value or path.stat().st_gid != (DATABASE_GID if name == 'database_password' else API_GID):
                raise ValueError('Doska credential drift')
        ca = read_file(self.root / 'private/tls.crt', mode=0o444)
        if hashlib.sha256(ca).hexdigest() != state['ca_sha256']:
            raise ValueError('Doska public CA drift')
        return state

    def credentials(self, instance, state):
        master = read_file(self.root / 'private/module-controller-key', mode=0o640)
        if len(master) != 32:
            raise ValueError('Invalid controller master key')
        return {'gateway_key': hmac.new(master, ('pl-module-key-v1\ndoska\n' + instance).encode(), hashlib.sha256).digest(),
                'directory_token': hmac.new(master, ('pl-module-directory-token-v1\ndoska\n' + instance).encode(), hashlib.sha256).hexdigest().encode(),
                'postgres_password': state['database_password'].encode(), 'database_password': state['database_password'].encode(), 'auth_secret': state['auth_secret'].encode()}

    def initialize(self, instance):
        base = self.paths(instance, create=True)
        if (base / 'state.json').exists() or (base / 'state.json').is_symlink():
            state = json.loads(read_file(base / 'state.json'))
            if (state.get('installation') != self.installation or state.get('instance_id') != instance
                    or any(not re.fullmatch(r'[0-9a-f]{64}', state.get(k, '')) for k in ('database_password', 'auth_secret', 'ca_sha256'))):
                raise ValueError('Invalid Doska initialization journal')
        else:
            if list((base / 'config').iterdir()):
                raise ValueError('Unmanaged Doska configuration')
            installation = json.loads(read_file(self.root / 'state/installation.json'))
            origin = installation.get('config', {}).get('public_url', '')
            url = urllib.parse.urlsplit(origin)
            if (url.scheme != 'https' or not url.hostname or url.username or url.password
                    or url.path not in ('', '/') or url.query or url.fragment):
                raise ValueError('Doska requires an explicit HTTPS Platform origin')
            ca = read_file(self.root / 'private/tls.crt', mode=0o444)
            if b'PRIVATE KEY' in ca or b'BEGIN CERTIFICATE' not in ca:
                raise ValueError('Invalid public Platform CA')
            state = {'installation': self.installation, 'instance_id': instance,
                     'database_password': secrets.token_hex(32), 'auth_secret': secrets.token_hex(32),
                     'origin': origin.rstrip('/'), 'ca_sha256': hashlib.sha256(ca).hexdigest()}
            atomic(base / 'state.json', state)
        values = self.credentials(instance, state)
        if set(p.name for p in (base / 'config').iterdir()) - set(values):
            raise ValueError('Unknown Doska configuration files')
        for name, value in values.items():
            path = base / 'config' / name
            if path.exists() or path.is_symlink():
                if read_file(path, mode=0o440) != value or path.stat().st_gid != (DATABASE_GID if name == 'database_password' else API_GID):
                    raise ValueError('Doska credential drift')
            else:
                atomic(path, value, mode=0o440)
                os.chown(path, -1, DATABASE_GID if name == 'database_password' else API_GID)
        self.state(instance)

    def resource(self, instance, kind, volume='database'):
        suffix = '-net' if kind == 'network' else '-' + volume + '-data'
        if kind not in ('network', 'volume') or volume not in ('database', 'attachments'):
            raise ValueError('Invalid Doska resource role')
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
            raise ValueError('Doska resource ownership mismatch')
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
            raise ValueError('Doska resource creation unconfirmed')

    def specification(self, instance, role):
        state = self.state(instance)
        config = self.paths(instance) / 'config'
        env, mounts = {}, []
        user = 'postgres' if role == 'database' else self.verify_image(role).get('Config', {}).get('User', '')
        if role == 'database':
            env = {'POSTGRES_DB': 'doska', 'POSTGRES_USER': 'doska',
                   'POSTGRES_PASSWORD_FILE': '/run/secrets/postgres_password', 'PGDATA': '/var/lib/postgresql/18/docker'}
            mounts += [('volume', self.name(instance, '-database-data'), '/var/lib/postgresql', True)]
            secret_names = ('database_password',)
        elif role == 'api':
            env = {'DOSKA_DIRECTORY_ORIGIN': state['origin'], 'DOSKA_MODULE_INSTANCE_ID': instance,
                   'KANEO_CLIENT_URL': state['origin'] + '/doska', 'KANEO_API_URL': state['origin'] + '/doska/api'}
            mounts += [('volume', self.name(instance, '-attachments-data'), '/app/data/attachments', True)]
            secret_names = ('gateway_key', 'directory_token', 'auth_secret', 'postgres_password')
        else:
            secret_names = ()
        mounts += [('bind', str(config / name), '/run/secrets/' + ('postgres_password' if name == 'database_password' else name), False) for name in secret_names]
        if role == 'api':
            mounts += [('bind', str(self.root / 'private/tls.crt'), '/run/secrets/platform-ca.crt', False)]
        tmpfs = {'/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777'}
        if role == 'database':
            tmpfs['/var/run/postgresql'] = 'rw,noexec,nosuid,size=16777216,uid=70,gid=70,mode=3775'
        return env, mounts, user, tmpfs

    def inspect(self, instance, role):
        name = self.name(instance, '-' + role)
        found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
        if not found:
            return None
        image = self.verify_image(role)
        env, expected_mounts, user, tmpfs = self.specification(instance, role)
        obj = json.loads(self.docker('container', 'inspect', name))[0]
        config, host = obj.get('Config', {}), obj.get('HostConfig', {})
        mounts = {(m.get('Type'), m.get('Name') if m.get('Type') == 'volume' else m.get('Source'), m.get('Destination'), m.get('RW')) for m in obj.get('Mounts', [])}
        expected_env = dict(item.split('=', 1) for item in image.get('Config', {}).get('Env', []))
        expected_env.update(env)
        actual_env = config.get('Env') or []
        actual_env_map = dict(item.split('=', 1) for item in actual_env)
        ports = host.get('PortBindings') or {}
        expected_port = ('1337/tcp' if role == 'api' else '8080/tcp')
        port_ok = not ports if role == 'database' else (set(ports) == {expected_port} and len(ports[expected_port]) == 1 and ports[expected_port][0].get('HostIp') == '127.0.0.1')
        if (not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', '')) or obj.get('Image') != self.images[role]['id']
                or config.get('Image') != self.images[role]['id'] or mounts != set(expected_mounts)
                or actual_env_map != expected_env or len(actual_env) != len(actual_env_map) or config.get('User', '') != user
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.labels(instance, role).items())
                or any(config.get(k) != image.get('Config', {}).get(k) for k in ('Entrypoint', 'Cmd', 'WorkingDir'))
                or not port_ok or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapDrop') != ['ALL']
                or host.get('CapAdd') or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts')
                or host.get('NetworkMode') != self.name(instance, '-net')
                or set(obj.get('NetworkSettings', {}).get('Networks', {})) != {self.name(instance, '-net')}
                or host.get('Memory') != 512 * 1024**2 or host.get('NanoCpus') != 1_000_000_000
                or host.get('PidsLimit') != 256 or not host.get('Init') or host.get('Tmpfs') != tmpfs
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('PidMode') not in (None, '') or host.get('IpcMode') not in (None, 'private')
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])):
            raise ValueError('Doska container drift; manual inspection required')
        network = self.resource(instance, 'network')
        if network is None or any(self.resource(instance, 'volume', volume) is None for volume in ('database', 'attachments')):
            raise ValueError('Doska managed resources missing')
        if any(member.get('Name') not in {self.name(instance, '-' + item) for item in ROLES} for member in network.get('Containers', {}).values()):
            raise ValueError('Foreign container attached to Doska network')
        return obj

    def create_container(self, instance, role):
        self.verify_image(role)
        env, mounts, user, tmpfs = self.specification(instance, role)
        args = ['container', 'create', '--name', self.name(instance, '-' + role), '--network', self.name(instance, '-net'),
                '--network-alias', role, '--restart', 'unless-stopped', '--init', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--cpus', '1', '--pids-limit', '256',
                '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2']
        if user:
            args += ['--user', user]
        for path, options in tmpfs.items():
            args += ['--tmpfs', path + ':' + options]
        for key, value in env.items():
            args += ['--env', key + '=' + value]
        for kind, source, target, writable in mounts:
            args += ['--mount', 'type=' + kind + ',source=' + source + ',target=' + target + ('' if writable else ',readonly')]
        if role != 'database':
            args += ['--publish', '127.0.0.1::' + ('1337' if role == 'api' else '8080')]
        for key, value in self.labels(instance, role).items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.images[role]['id'])
        if self.inspect(instance, role) is None:
            raise ValueError('Doska container creation unconfirmed')

    def endpoint(self, obj, role='web'):
        ports = obj.get('NetworkSettings', {}).get('Ports', {}).get('1337/tcp' if role == 'api' else '8080/tcp') or []
        if (len(ports) != 1 or ports[0].get('HostIp') != '127.0.0.1'
                or not str(ports[0].get('HostPort', '')).isdigit() or not 1 <= int(ports[0]['HostPort']) <= 65535):
            raise ValueError('Invalid Doska loopback binding')
        return 'http://127.0.0.1:' + ports[0]['HostPort']

    def http(self, instance, obj, method, path, query='', content_type='', raw=b'', headers=None, role='web', stream=False):
        headers = {**(headers or {}), 'Accept-Encoding': 'identity'}
        if content_type:
            headers['Content-Type'] = content_type
        request = urllib.request.Request(self.endpoint(obj, role) + path + ('?' + query if query else ''),
                                         data=raw if method not in ('GET', 'HEAD') else None, headers=headers, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            response = opener.open(request, timeout=35)
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, http.client.HTTPException):
            self._routes.pop(instance, None)
            raise
        if not 200 <= response.status < 600 or (300 <= response.status < 400 and response.status != 304):
            response.close()
            self._routes.pop(instance, None)
            raise ValueError('Unsupported Doska response status')
        if response.status == 304 and method not in ('GET', 'HEAD'):
            response.close()
            self._routes.pop(instance, None)
            raise ValueError('Unexpected Doska conditional response')
        if stream:
            return response
        with response:
            try:
                body = b'' if response.status == 304 else response.read(MAX_RESPONSE + 1)
            except (OSError, http.client.HTTPException):
                self._routes.pop(instance, None)
                raise
            if len(body) > MAX_RESPONSE:
                self._routes.pop(instance, None)
                raise ValueError('Doska response exceeds finite contract')
            return response.status, response.headers.get('Content-Type', 'application/octet-stream'), body

    def route(self, instance, role):
        identifier(instance)
        if role not in ('api', 'web'):
            raise ValueError('Invalid Doska route role')
        route = self._routes.get(instance)
        if route is None or time.monotonic() - route[0] >= ROUTE_MAX_AGE:
            # Coalesce cold verification. Warm requests never wait for another
            # instance's Docker observation and never extend the verification TTL.
            with self._route_lock:
                route = self._routes.get(instance)
                if route is None or time.monotonic() - route[0] >= ROUTE_MAX_AGE:
                    self.ready(instance)
                    route = self._routes[instance]
        return route[1][role], route[2][role]

    def ready(self, instance):
        with self._route_lock:
            try:
                objects = {role: self.inspect(instance, role) for role in ROLES}
                if any(not obj or not obj.get('State', {}).get('Running') for obj in objects.values()):
                    raise ValueError('Doska components are stopped')
                origins = {role: self.endpoint(objects[role], role) for role in ('api', 'web')}
                for role in ('api', 'web'):
                    status, _, _ = self.http(instance, objects[role], 'GET', '/healthz', role=role)
                    if status != 200:
                        raise ValueError('Doska Directory or application is not ready')
                # Retain routing identity and bindings, not Docker Env/secrets.
                verified = {role: {'Id': obj.get('Id'), 'Image': obj.get('Image'),
                    'NetworkSettings': {'Ports': obj.get('NetworkSettings', {}).get('Ports', {})}}
                    for role, obj in objects.items() if role in ('api', 'web')}
                self._routes[instance] = (time.monotonic(), verified, origins)
                return objects['web']
            except Exception:
                self._routes.pop(instance, None)
                raise

    def ensure(self, instance):
        self._routes.pop(instance, None)
        self.initialize(instance)
        self.create_resource(instance, 'network')
        for volume in ('database', 'attachments'):
            self.create_resource(instance, 'volume', volume)
        for role in ROLES:
            obj = self.inspect(instance, role)
            if obj is None:
                self.create_container(instance, role)
                obj = self.inspect(instance, role)
            if not obj.get('State', {}).get('Running'):
                self.docker('container', 'start', obj['Id'])
        deadline = time.monotonic() + 90
        while True:
            try:
                self.ready(instance)
                return
            except (ValueError, OSError):
                if time.monotonic() >= deadline:
                    raise ValueError('Doska readiness unconfirmed') from None
                time.sleep(0.5)

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
            if any(self.resource(instance, kind, volume) for kind, volume in (('network', 'database'), ('volume', 'database'), ('volume', 'attachments'))) or any(self.inspect(instance, role) for role in ROLES):
                raise ValueError('Doska artifacts have no managed state')
            return {'state': 'absent', 'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        self.state(instance)
        objects = [self.inspect(instance, role) for role in ROLES]
        if any(obj is None for obj in objects):
            raise ValueError('Doska components incomplete')
        running = [bool(obj.get('State', {}).get('Running')) for obj in objects]
        if any(running) and not all(running):
            raise ValueError('Doska components have mixed state')
        result = {'state': 'disabled', 'version': self.version, 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        if all(running):
            result.update(state='running', endpoint=self.endpoint(self.ready(instance)))
        return result

    def remove(self, instance):
        self._routes.pop(instance, None)
        base = self.instances / identifier(instance)
        marker = self.operations / ('remove-' + instance + '.json')
        expected = {'state.json': 0o600, **{'config/' + name: 0o440 for name in ('gateway_key', 'directory_token', 'postgres_password', 'database_password', 'auth_secret')}}
        if not base.exists() and not base.is_symlink():
            self.observe(instance)
            if marker.exists() or marker.is_symlink():
                value = json.loads(read_file(marker))
                if value.get('installation') != self.installation or value.get('instance_id') != instance:
                    raise ValueError('Invalid Doska removal journal')
                marker.unlink()
                fsync_directory(self.operations)
            return
        if not marker.exists() and not marker.is_symlink():
            self.state(instance)
            if set(p.name for p in base.iterdir()) != {'state.json', 'config'} or set(p.name for p in (base / 'config').iterdir()) != {'gateway_key', 'directory_token', 'postgres_password', 'database_password', 'auth_secret'}:
                raise ValueError('Unknown Doska removal files')
            objects = [self.inspect(instance, role) for role in ROLES]
            network = self.resource(instance, 'network')
            self.resource(instance, 'volume', 'database')
            self.resource(instance, 'volume', 'attachments')
            owned_ids = {obj['Id'] for obj in objects if obj}
            if network and set(network.get('Containers', {})) - owned_ids:
                raise ValueError('Foreign container attached to Doska network')
            files = {name: hashlib.sha256(read_file(base / name, mode=mode)).hexdigest() for name, mode in expected.items()}
            atomic(marker, {'installation': self.installation, 'instance_id': instance, 'files': files})
        journal = json.loads(read_file(marker))
        if (set(journal) != {'installation', 'instance_id', 'files'} or journal['installation'] != self.installation
                or journal['instance_id'] != instance or not isinstance(journal['files'], dict)
                or set(journal['files']) != set(expected)
                or any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v) for v in journal['files'].values())):
            raise ValueError('Invalid Doska removal journal')
        directory(base, create=False)
        if set(p.name for p in base.iterdir()) - {'state.json', 'config'}:
            raise ValueError('Unknown Doska removal artifacts')
        config = base / 'config'
        if config.exists() or config.is_symlink():
            directory(config, create=False, mode=0o755)
            if set(p.name for p in config.iterdir()) - {'gateway_key', 'directory_token', 'postgres_password', 'database_password', 'auth_secret'}:
                raise ValueError('Unknown Doska removal configuration')
        for name, mode in expected.items():
            path = base / name
            if (path.exists() or path.is_symlink()) and hashlib.sha256(read_file(path, mode=mode)).hexdigest() != journal['files'][name]:
                raise ValueError('Doska removal artifact changed')
        objects = [self.inspect(instance, role) for role in ROLES]
        network = self.resource(instance, 'network')
        owned_ids = {obj['Id'] for obj in objects if obj}
        if network and set(network.get('Containers', {})) - owned_ids:
            raise ValueError('Foreign container attached to Doska network')
        for obj in reversed(objects):
            if obj:
                if obj.get('State', {}).get('Running'):
                    self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                self.docker('container', 'rm', obj['Id'])
        for kind, volume in (('volume', 'attachments'), ('volume', 'database'), ('network', 'database')):
            if self.resource(instance, kind, volume):
                self.docker(kind, 'rm', self.name(instance, '-net' if kind == 'network' else '-' + volume + '-data'))
            if self.resource(instance, kind, volume):
                raise ValueError('Doska resource removal unconfirmed')
        # Journal authenticates remaining files after an interrupted unlink.
        for name in [*('config/' + key for key in ('gateway_key', 'directory_token', 'postgres_password', 'database_password', 'auth_secret')), 'state.json']:
            (base / name).unlink(missing_ok=True)
        if config.exists():
            config.rmdir()
        base.rmdir()
        fsync_directory(self.instances)
        marker.unlink()
        fsync_directory(self.operations)

    def execute(self, body):
        if (not isinstance(body, dict) or set(body) - {'operation_id', 'instance_id', 'module_id', 'action', 'public_url'} or not {'operation_id', 'instance_id', 'module_id', 'action'} <= set(body)
                or body.get('module_id') != 'doska' or body.get('action') not in ('install', 'enable', 'disable', 'refresh', 'remove')):
            raise ValueError('Unsupported Doska operation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        configured_origin = json.loads(read_file(self.root / 'state/installation.json')).get('config', {}).get('public_url')
        if 'public_url' in body and body['public_url'] != configured_origin:
            raise ValueError('Doska operation origin mismatch')
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
                    raise ValueError('Doska operation ID conflict')
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
                        'error': _files.module_network_error(error, 'Doska operation unconfirmed; reconcile the same operation'), 'operation_id': operation}

    def get(self, instance):
        instance = identifier(instance)
        with self.instance_lock(instance):
            return self.observe(instance)

    def manifest(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id'}:
            raise ValueError('Invalid Doska manifest request')
        instance = identifier(body['instance_id'])
        try:
            return self._manifest(instance)
        except (ValueError, OSError, http.client.HTTPException):
            self._routes.pop(instance, None)
            raise

    def _manifest(self, instance):
        with self.instance_lock(instance):
            web, _ = self.route(instance, 'web')
            response = self.http(instance, web, 'GET', '/__pl_manifest.json', role='web', stream=True)
            with response:
                raw = response.read(512 * 1024 + 1)
                if response.status != 200 or response.headers.get_content_type() != 'application/json' or len(raw) > 512 * 1024:
                    raise ValueError('Doska owned manifest unavailable')
                manifest = json.loads(raw)
        if (not isinstance(manifest, dict) or set(manifest) != {'version', 'routes'}
                or manifest.get('version') != 'pl-doska-' + self.version
                or not isinstance(manifest['routes'], list) or not 1 <= len(manifest['routes']) <= 1024):
            raise ValueError('Invalid Doska owned manifest')
        seen = set()
        for route in manifest['routes']:
            if not isinstance(route, dict) or set(route) - {'method', 'path', 'kind', 'schema', 'query'}:
                raise ValueError('Unknown Doska manifest fields')
            key = route.get('method'), route.get('path')
            if not isinstance(key[0], str) or not isinstance(key[1], str):
                raise ValueError('Invalid Doska manifest route fields')
            if key in seen or not isinstance(key[1], str) or not key[1].startswith('/doska/') or '__pl_manifest' in key[1]:
                raise ValueError('Invalid Doska manifest route')
            seen.add(key)
            if route.get('kind') == 'asset' and (key[0] != 'GET' or not re.fullmatch(r'/doska/[A-Za-z0-9_./-]+', key[1])
                    or '..' in key[1] or key[1].endswith('.map')):
                raise ValueError('Invalid Doska manifest asset')
        return manifest

    def transport(self, meta, bodyfile, handler):
        fields = {'instance_id', 'role', 'method', 'path', 'query', 'content_type', 'headers', 'body_length', 'body_sha256'}
        if not isinstance(meta, dict) or set(meta) != fields:
            raise ValueError('Invalid Doska transport metadata')
        instance = identifier(meta['instance_id'])
        size = meta['body_length']
        if (not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= MAX_BODY
                or not isinstance(meta['body_sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', meta['body_sha256'])):
            raise ValueError('Invalid Doska transport body metadata')
        signed_headers = allowed_request(meta['role'], meta['method'], meta['path'], meta['query'], meta['content_type'], b'', meta['headers'])
        if meta['method'] in ('GET', 'HEAD') and size:
            raise ValueError('Unexpected Doska transport body')
        bodyfile.seek(0)
        digest, count = hashlib.sha256(), 0
        while True:
            chunk = bodyfile.read(65536)
            if not chunk:
                break
            count += len(chunk)
            if count > size:
                raise ValueError('Doska transport body length mismatch')
            digest.update(chunk)
        if count != size or not hmac.compare_digest(digest.hexdigest(), meta['body_sha256']):
            raise ValueError('Doska transport body digest mismatch')
        bodyfile.seek(0)
        # Native application revalidates the exact signed request. Never keep an
        # exclusive lifecycle lock while a user watches the long-lived SSE feed.
        with self.instance_lock(instance):
            _, origin = self.route(instance, meta['role'])
            endpoint = urllib.parse.urlsplit(origin)
            connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=125)
            headers = {**signed_headers, 'Accept-Encoding': 'identity', 'Content-Length': str(size)}
            if meta['content_type']:
                headers['Content-Type'] = meta['content_type']
            path = meta['path'] + ('?' + meta['query'] if meta['query'] else '')
            try:
                connection.request(meta['method'], path, body=bodyfile if size else None, headers=headers)
                # HTTPConnection can drop its socket reference for a response
                # framed by EOF; retain the socket before getresponse().
                upstream = connection.sock
                response = connection.getresponse()
            except BaseException:
                self._routes.pop(instance, None)
                connection.close()
                raise
        try:
            if not 200 <= response.status < 600 or (300 <= response.status < 400 and response.status != 304):
                self._routes.pop(instance, None)
                raise ValueError('Unsupported Doska transport response')
            if response.status == 304 and meta['method'] not in ('GET', 'HEAD'):
                self._routes.pop(instance, None)
                raise ValueError('Unexpected Doska conditional transport response')
            mime = response.getheader('Content-Type', 'application/octet-stream')
            sse = mime.split(';')[0].strip() == 'text/event-stream'
            if sse and (meta['role'] != 'api' or meta['method'] != 'GET' or meta['path'] != '/api/doska/events'):
                self._routes.pop(instance, None)
                raise ValueError('Unexpected Doska event stream')
            content_length = response.getheader('Content-Length')
            if content_length and (not content_length.isdigit() or int(content_length) > MAX_RESPONSE):
                self._routes.pop(instance, None)
                raise ValueError('Doska transport response exceeds limit')
            handler.send_response(response.status)
            safe = {'content-type', 'content-disposition', 'cache-control', 'etag', 'last-modified', 'retry-after', 'x-accel-buffering', 'expires', 'vary'}
            if not sse and response.status != 304:
                safe.add('content-length')
            for name, value in response.getheaders():
                if name.lower() in safe and len(value) <= 4096 and not any(ord(c) < 32 or ord(c) == 127 for c in value):
                    handler.send_header(name, value)
            handler.send_header('Connection', 'close')
            handler.close_connection = True
            handler.end_headers()
            total = 0
            with (client_stream_guard(handler, upstream) if sse else nullcontext(None)) as disconnected:
                if meta['method'] != 'HEAD' and response.status != 304:
                    while True:
                        try:
                            chunk = response.read1(65536)
                        except (OSError, http.client.HTTPException):
                            if disconnected is not None and disconnected.is_set():
                                break
                            self._routes.pop(instance, None)
                            raise
                        if not chunk:
                            break
                        total += len(chunk)
                        if not sse and total > MAX_RESPONSE:
                            self._routes.pop(instance, None)
                            raise ValueError('Doska transport response exceeds limit')
                        handler.wfile.write(chunk)
                        handler.wfile.flush()
        finally:
            try:
                response.close()
            finally:
                connection.close()
