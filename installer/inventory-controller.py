#!/usr/bin/env python3
"""Finite Inventory lifecycle, private import credential and signed v2 transport."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request

_spec = importlib.util.spec_from_file_location('pl_inventory_files', Path(__file__).with_name('xray-controller.py'))
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
identifier, directory, read_file, atomic = _files.identifier, _files.directory, _files.read_file, _files.atomic
MAX_BODY, MAX_RESPONSE = 64 * 1024 * 1024, 8 * 1024 * 1024
UID, GID = 10001, 10001
ASSETS = {'theme-init.js', 'platform.css', 'report.js', 'bootstrap.js', 'shared-shell.js'}


def request_scope(method, path, query, content_type, raw, idempotency=''):
    if (method not in ('GET', 'HEAD', 'POST') or not isinstance(path, str) or len(path) > 1024
            or any(c in path for c in ('%', '\\', '?', '#', '//')) or '..' in path.split('/')
            or any(ord(c) <= 32 or ord(c) == 127 for c in path)
            or not isinstance(query, str) or len(query) > 4096 or '#' in query
            or any(ord(c) < 32 or ord(c) > 126 for c in query)
            or re.search(r'%(?![0-9A-Fa-f]{2})', query)
            or not isinstance(content_type, str) or len(content_type) > 256
            or any(ord(c) < 32 or ord(c) > 126 for c in content_type) or len(raw) > MAX_BODY):
        raise ValueError('Invalid Inventory request')
    if method in ('GET', 'HEAD'):
        if raw or content_type or idempotency:
            raise ValueError('Inventory reads cannot contain bodies or mutation headers')
        if path in ('/inventory/', '/inventory/api/session', '/inventory/api/imports') or re.fullmatch(r'/inventory/api/jobs/[0-9a-f-]{36}', path) or path.startswith('/inventory/static/') and path.removeprefix('/inventory/static/') in ASSETS:
            if query:
                raise ValueError('Unexpected Inventory query')
        elif path in ('/inventory/api/data', '/inventory/api/software'):
            pairs = urllib.parse.parse_qsl(query, keep_blank_values=True, strict_parsing=True, max_num_fields=12, errors='strict')
            keys = [key for key, _ in pairs]
            allowed = {'page', 'revision'} if path.endswith('/data') else {'page', 'limit', 'search', 'branch', 'category', 'machine', 'version', 'evidence', 'answer', 'sort', 'direction'}
            if len(keys) != len(set(keys)) or set(keys) - allowed or any(any(ord(c) < 32 for c in key + val) for key, val in pairs):
                raise ValueError('Invalid Inventory query parameters')
        else:
            raise ValueError('Unsupported Inventory route')
        return 'inventory:read'
    if query or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', idempotency):
        raise ValueError('Inventory mutations require an idempotency key without query')
    if path == '/inventory/api/imports/preview':
        if content_type.split(';', 1)[0].strip() != 'multipart/form-data' or not raw:
            raise ValueError('Inventory preview requires a multipart upload')
    elif re.fullmatch(r'/inventory/api/imports/[0-9a-f-]{36}/commit', path):
        if content_type.split(';', 1)[0].strip() != 'application/json' or len(raw) > 4096 or json.loads(raw) != {}:
            raise ValueError('Inventory commit requires an empty JSON object')
    else:
        raise ValueError('Unsupported Inventory mutation')
    return 'inventory:write'


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, message, headers, new_url):
        return None


class InventoryController:
    def __init__(self, parent):
        self.parent, self.root, self.installation = parent, Path(parent.root), parent.installation
        self.base = self.root / 'modules/inventory'
        directory(self.base)
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        directory(self.instances)
        directory(self.operations)
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        state = json.loads(read_file(self.root / 'state/installation.json'))
        bundle = registry.get('inventory')
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or state.get('install_id') != self.installation or registry.get('manifest_sha256') != state.get('manifest_sha256')
                or not isinstance(bundle, dict) or set(bundle) != {'server'}):
            raise ValueError('Inventory image installation identity mismatch')
        self.image = bundle['server']
        labels = self.image.get('labels', {})
        if (set(self.image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', self.image.get('id', ''))
                or self.image.get('architecture') not in ('amd64', 'arm64')
                or self.image.get('recipe') != 'deploy/images/inventory.Dockerfile'
                or labels.get('pl.module.id') != 'inventory' or labels.get('pl.module.role') != 'server'
                or labels.get('pl.module.config.version') != '1' or labels.get('pl.build.variant') != 'source-build'
                or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', labels.get('org.opencontainers.image.version', ''))
                or not re.fullmatch(r'[0-9a-f]{64}', labels.get('pl.source.sha256', ''))):
            raise ValueError('Invalid Inventory image contract')
        self.version = labels['org.opencontainers.image.version']
        self._routes = {}

    def docker(self, *args, **kwargs):
        return self.parent.docker(*args, **kwargs)

    @contextmanager
    def locked(self, instance=None, exclusive=True):
        path = self.operations / ('instance-' + identifier(instance) + '.lock') if instance else self.root / 'modules/controller.lock'
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            meta = os.fstat(stream.fileno())
            if meta.st_uid != os.geteuid() or meta.st_mode & 0o777 != 0o600:
                raise ValueError('Unsafe Inventory operation lock')
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def name(self, instance):
        return self.installation + '-inventory-' + identifier(instance)

    def labels(self, instance):
        return {'pl.installation': self.installation, 'pl.module': 'inventory', 'pl.instance': identifier(instance), 'pl.module.role': 'server'}

    def key(self, instance):
        master = read_file(self.root / 'private/module-controller-key', mode=0o640)
        if len(master) != 32:
            raise ValueError('Invalid Inventory controller key')
        return hmac.digest(master, ('pl-module-key-v1\ninventory\n' + identifier(instance)).encode(), 'sha256')

    def path(self, instance, create=False):
        path = self.instances / identifier(instance)
        directory(path, create=create)
        return path

    def initialize(self, instance):
        path = self.path(instance, create=True)
        journal = path / 'state.json'
        expected = {'installation': self.installation, 'instance_id': instance, 'schema': 1}
        if journal.exists():
            if json.loads(read_file(journal)) != expected:
                raise ValueError('Inventory state identity mismatch')
        else:
            if list(path.iterdir()):
                raise ValueError('Unmanaged Inventory files')
            atomic(journal, expected)
        config = path / 'config'
        directory(config, mode=0o750)
        os.chown(config, -1, GID)
        if set(p.name for p in config.iterdir()) - {'gateway.key', 'archive-password'}:
            raise ValueError('Unknown Inventory secret files')
        key = config / 'gateway.key'
        if key.exists() or key.is_symlink():
            if read_file(key, mode=0o440) != self.key(instance) or key.stat().st_gid != GID:
                raise ValueError('Inventory gateway key drift')
        else:
            atomic(key, self.key(instance), mode=0o440)
            os.chown(key, -1, GID)
        data = path / 'data'
        if not data.exists():
            data.mkdir(mode=0o700)
            os.chown(data, UID, GID)
        if data.is_symlink() or not data.is_dir() or data.stat().st_uid != UID or data.stat().st_mode & 0o777 != 0o700:
            raise ValueError('Unsafe Inventory data directory')
        self.validate_state(instance)

    def validate_state(self, instance):
        path = self.path(instance)
        if json.loads(read_file(path / 'state.json')) != {'installation': self.installation, 'instance_id': instance, 'schema': 1}:
            raise ValueError('Inventory state identity mismatch')
        config = path / 'config'
        directory(config, create=False, mode=0o750)
        if config.stat().st_gid != GID or set(p.name for p in config.iterdir()) - {'gateway.key', 'archive-password'}:
            raise ValueError('Inventory secret directory drift')
        key = config / 'gateway.key'
        if read_file(key, mode=0o440) != self.key(instance) or key.stat().st_gid != GID:
            raise ValueError('Inventory gateway key drift')
        secret = config / 'archive-password'
        if secret.exists() or secret.is_symlink():
            if not read_file(secret, mode=0o440, limit=4096) or secret.stat().st_gid != GID:
                raise ValueError('Unsafe Inventory archive password')
        return path

    def verify_image(self):
        obj = json.loads(self.docker('image', 'inspect', self.image['id']))[0]
        if (obj.get('Id') != self.image['id'] or obj.get('Os') != 'linux' or obj.get('Architecture') != self.image['architecture']
                or any((obj.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in self.image['labels'].items())):
            raise ValueError('Inventory image identity mismatch')
        return obj

    def network(self, instance, create=False):
        name = self.name(instance) + '-net'
        found = self.docker('network', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found and create:
            args = ['network', 'create', '--driver', 'bridge', '--internal'] + _files.module_network_args(self.root, self.installation, self.docker)
            for key, val in self.labels(instance).items():
                args += ['--label', key + '=' + val]
            self.docker(*args, name)
            return self.network(instance)
        if not found:
            return None
        obj = json.loads(self.docker('network', 'inspect', name))[0]
        if (obj.get('Name') != name or obj.get('Driver') != 'bridge' or not obj.get('Internal') or obj.get('Options')
                or obj.get('Ingress') or obj.get('Scope') != 'local'
                or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())):
            raise ValueError('Inventory network ownership mismatch')
        _files.validate_module_network(self.root, self.installation, obj, self.docker)
        if any(member.get('Name') != self.name(instance) + '-server' for member in (obj.get('Containers') or {}).values()):
            raise ValueError('Foreign container in Inventory network')
        return obj

    def mounts(self, instance):
        path = self.path(instance)
        return {('bind', str(path / 'data'), '/data', True), ('bind', str(path / 'config'), '/run/secrets/inventory', False)}

    def inspect(self, instance):
        name = self.name(instance) + '-server'
        found = self.docker('container', 'ls', '--all', '--filter', 'name=^' + name + '$', '--format', '{{.Names}}').decode().strip()
        if not found:
            return None
        self.validate_state(instance)
        image = self.verify_image()
        obj = json.loads(self.docker('container', 'inspect', name))[0]
        config, host = obj.get('Config', {}), obj.get('HostConfig', {})
        mounts = {(m.get('Type'), m.get('Source'), m.get('Destination'), m.get('RW')) for m in obj.get('Mounts', [])}
        netname = self.name(instance) + '-net'
        if (not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', '')) or obj.get('Name') != '/' + name
                or obj.get('Image') != self.image['id'] or config.get('Image') != self.image['id']
                or mounts != self.mounts(instance)
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())
                or any(config.get(k) != image.get('Config', {}).get(k) for k in ('Entrypoint', 'Cmd', 'User', 'Env', 'WorkingDir', 'Healthcheck'))
                or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapDrop') != ['ALL'] or host.get('CapAdd')
                or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts') or host.get('PortBindings')
                or any((obj.get('NetworkSettings', {}).get('Ports') or {}).values())
                or host.get('NetworkMode') != netname or set(obj.get('NetworkSettings', {}).get('Networks', {})) != {netname}
                or host.get('Memory') != 1024**3 or host.get('NanoCpus') != 1_000_000_000 or host.get('PidsLimit') != 128
                or not host.get('Init') or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('Tmpfs') != {'/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777'}
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or host.get('PidMode') not in ('', None) or host.get('IpcMode') not in ('private', None)
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])):
            raise ValueError('Inventory container drift')
        if self.network(instance) is None:
            raise ValueError('Inventory network missing')
        return obj

    def create(self, instance):
        self.verify_image()
        args = ['container', 'create', '--name', self.name(instance) + '-server', '--network', self.name(instance) + '-net',
                '--restart', 'unless-stopped', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                '--memory', '1024m', '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864,mode=1777',
                '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2']
        for kind, source, target, writable in sorted(self.mounts(instance)):
            args += ['--mount', 'type=bind,source=' + source + ',target=' + target + ('' if writable else ',readonly')]
        for key, val in self.labels(instance).items():
            args += ['--label', key + '=' + val]
        self.docker(*args, self.image['id'])
        return self.inspect(instance)

    def endpoint(self, instance, obj):
        network = self.network(instance)
        view = obj.get('NetworkSettings', {}).get('Networks', {}).get(self.name(instance) + '-net', {})
        member = (network.get('Containers') or {}).get(obj.get('Id')) if network else None
        try:
            address = ipaddress.IPv4Address(view.get('IPAddress'))
            assigned = ipaddress.IPv4Interface(member.get('IPv4Address'))
            subnet = ipaddress.IPv4Network(network['IPAM']['Config'][0]['Subnet'])
            if (view.get('NetworkID') != network['Id'] or member.get('Name') != self.name(instance) + '-server'
                    or assigned.ip != address or address not in subnet or address in (subnet.network_address, subnet.broadcast_address)
                    or str(address) == network['IPAM']['Config'][0].get('Gateway')):
                raise ValueError()
        except (ValueError, AttributeError, TypeError, KeyError):
            raise ValueError('Inventory network membership mismatch') from None
        return 'http://' + str(address) + ':8587'

    def http(self, endpoint, method, uri, raw=b'', headers=None):
        request = urllib.request.Request(endpoint + uri, data=raw if method == 'POST' else None, method=method, headers=headers or {})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            response = opener.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(MAX_RESPONSE + 1)
            mime = response.headers.get_content_type()
            if (len(data) > MAX_RESPONSE or not 200 <= response.status <= 599 or 300 <= response.status < 400
                    or mime not in ('application/json', 'text/html', 'text/css', 'application/javascript', 'text/javascript')
                    or response.headers.get('Set-Cookie') or response.headers.get('WWW-Authenticate') or response.headers.get('Content-Encoding')):
                raise ValueError('Inventory response outside finite contract')
            return response.status, mime, data

    def ready(self, instance):
        obj = self.inspect(instance)
        if obj is None or not obj.get('State', {}).get('Running'):
            raise ValueError('Inventory server stopped')
        endpoint = self.endpoint(instance, obj)
        status, mime, body = self.http(endpoint, 'GET', '/healthz')
        if status != 200 or mime != 'application/json' or json.loads(body).get('status') != 'ok':
            raise ValueError('Inventory readiness unconfirmed')
        self._routes[instance] = (time.monotonic(), endpoint)
        return endpoint

    def observe(self, instance):
        obj = self.inspect(instance)
        state, endpoint = 'absent', ''
        if obj is not None:
            state = 'running' if obj.get('State', {}).get('Running') else 'disabled'
            if state == 'running':
                endpoint = self.ready(instance)
        return {'state': state, 'version': self.version if obj else '', 'endpoint': endpoint, 'targets_up': 0, 'targets_total': 0, 'error': ''}

    def execute(self, op):
        expected = {'operation_id', 'instance_id', 'module_id', 'action'}
        if (not isinstance(op, dict) or set(op) not in (expected, expected | {'public_url'})
                or op.get('module_id') != 'inventory' or op.get('action') not in ('install', 'enable', 'disable', 'refresh', 'remove')):
            raise ValueError('Unsupported Inventory operation')
        instance, operation = identifier(op['instance_id']), identifier(op['operation_id'])
        fingerprint = hashlib.sha256(_files.encoded(op)).hexdigest()
        journal = self.operations / (operation + '.json')
        with self.locked(instance), self.locked():
            if journal.exists() and json.loads(read_file(journal)).get('fingerprint') != fingerprint:
                raise ValueError('Inventory operation identity conflict')
            atomic(journal, {'fingerprint': fingerprint, 'phase': 'running'})
            self._routes.pop(instance, None)
            try:
                if op['action'] in ('install', 'enable'):
                    self.initialize(instance)
                    self.network(instance, create=True)
                    obj = self.inspect(instance) or self.create(instance)
                    if not obj.get('State', {}).get('Running'):
                        self.docker('container', 'start', obj['Id'])
                    deadline = time.monotonic() + 60
                    while True:
                        try:
                            self.ready(instance)
                            break
                        except (ValueError, OSError, urllib.error.URLError):
                            if time.monotonic() >= deadline:
                                raise ValueError('Inventory startup unconfirmed') from None
                            time.sleep(0.5)
                elif op['action'] in ('disable', 'remove'):
                    obj = self.inspect(instance)
                    if obj:
                        if obj.get('State', {}).get('Running'):
                            self.docker('container', 'stop', '--time', '15', obj['Id'], timeout=30)
                        if op['action'] == 'remove':
                            self.docker('container', 'rm', obj['Id'])
                    if op['action'] == 'remove':
                        net = self.network(instance)
                        if net:
                            if net.get('Containers'):
                                raise ValueError('Inventory network still in use')
                            self.docker('network', 'rm', net['Id'])
                        path = self.instances / instance
                        if path.exists():
                            self.path(instance)
                            if json.loads(read_file(path / 'state.json')) != {'installation': self.installation, 'instance_id': instance, 'schema': 1}:
                                raise ValueError('Inventory removal ownership mismatch')
                            shutil.rmtree(path)
                result = {**self.observe(instance), 'operation_id': operation}
                atomic(journal, {'fingerprint': fingerprint, 'phase': 'complete'})
                return result
            except (ValueError, OSError, KeyError, TypeError):
                self._routes.pop(instance, None)
                return {'state': 'error', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0,
                        'error': 'Inventory operation unconfirmed; reconcile the same operation', 'operation_id': operation}

    def get(self, instance):
        with self.locked(identifier(instance), exclusive=False), self.locked(exclusive=False):
            return self.observe(instance)

    def settings(self, body):
        if not isinstance(body, dict) or set(body) not in ({'instance_id'}, {'instance_id', 'archive_password', 'operation_id'}):
            raise ValueError('Invalid Inventory settings')
        instance = identifier(body['instance_id'])
        with self.locked(instance), self.locked(exclusive=False):
            path = self.validate_state(instance) / 'config/archive-password'
            if 'archive_password' in body:
                identifier(body['operation_id'])
                value = body['archive_password']
                if not isinstance(value, str) or not 1 <= len(value.encode()) <= 4096 or '\x00' in value:
                    raise ValueError('Inventory archive password requires 1..4096 UTF-8 bytes')
                atomic(path, value.encode(), mode=0o440)
                os.chown(path, -1, GID)
            configured = False
            if path.exists() or path.is_symlink():
                value = read_file(path, mode=0o440, limit=4096)
                if not value or path.stat().st_gid != GID:
                    raise ValueError('Unsafe Inventory import password')
                configured = True
            return {'instance_id': instance, 'archive_password_configured': configured}

    def request(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id', 'method', 'path', 'query', 'content_type', 'body', 'headers'}:
            raise ValueError('Invalid Inventory transport payload')
        instance = identifier(body['instance_id'])
        if not isinstance(body['body'], str) or len(body['body']) > 4 * ((MAX_BODY + 2) // 3):
            raise ValueError('Inventory request exceeds 64 MiB')
        raw = base64.b64decode(body['body'], validate=True)
        headers = body['headers']
        required = {'X-PL-Gateway-Assertion', 'X-PL-Gateway-Signature'}
        if (not isinstance(headers, dict) or not required <= set(headers) or set(headers) - required - {'X-CSRF-Token', 'Idempotency-Key'}
                or any(not isinstance(v, str) or not v or len(v) > 8192 or any(ord(c) < 32 or ord(c) > 126 for c in v) for v in headers.values())):
            raise ValueError('Invalid Inventory gateway headers')
        scope = request_scope(body['method'], body['path'], body['query'], body['content_type'], raw, headers.get('Idempotency-Key', ''))
        if set(headers) != (required | {'X-CSRF-Token', 'Idempotency-Key'} if scope == 'inventory:write' else required):
            raise ValueError('Inventory gateway transport headers mismatch')
        forwarded = {**headers, 'Accept-Encoding': 'identity'}
        if body['content_type']:
            forwarded['Content-Type'] = body['content_type']
        uri = body['path'] + ('?' + body['query'] if body['query'] else '')
        with self.locked(instance, exclusive=False):
            with self.locked(exclusive=False):
                route = self._routes.get(instance)
                if route is None or time.monotonic() - route[0] >= 30:
                    self.ready(instance)
                    route = self._routes[instance]
            status, mime, response = self.http(route[1], body['method'], uri, raw, forwarded)
        return {'instance_id': instance, 'status': status, 'content_type': mime, 'body': base64.b64encode(response).decode()}
