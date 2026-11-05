#!/usr/bin/env python3
"""Owned SFTPGo lifecycle, typed admin API and session-bound native user client."""
from __future__ import annotations
import base64
from contextlib import contextmanager
import fcntl
import errno
import hashlib
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

_helper = Path(__file__).with_name('xray-controller.py')
if _helper.is_symlink() or not _helper.is_file():
    raise ValueError('Trusted SFTPGo file primitives unavailable')
_spec = importlib.util.spec_from_file_location('pl_sftpgo_files', _helper)
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
identifier, directory, read_file = _files.identifier, _files.directory, _files.read_file
atomic, encoded, fsync_directory = _files.atomic, _files.encoded, _files.fsync_directory
GID = 1000
ROUTE_MAX_AGE = 30
MAX_BODY, MAX_RESPONSE, MAX_UPLOAD = 256 * 1024, 4 * 1024 * 1024, 1024**3
COMMAND = ['serve', '--config-dir', '/etc/pl-sftpgo', '--config-file', 'sftpgo.json', '--loaddata-from', '/etc/pl-sftpgo/bootstrap.json', '--loaddata-mode', '1', '--log-file-path', '']
PERMISSIONS = {'*', 'list', 'download', 'upload', 'overwrite', 'delete', 'delete_files', 'delete_dirs', 'rename', 'rename_files', 'rename_dirs', 'create_dirs', 'chmod', 'chtimes', 'copy'}
LIMITS = ('quota_size', 'quota_files', 'max_sessions', 'upload_bandwidth', 'download_bandwidth')
USER_FIELDS = {'username', 'description', 'enabled', 'password_enabled', 'public_key_enabled', 'password', 'public_keys', 'permissions', 'groups', 'virtual_folders', *LIMITS}


def text(value, maximum=256, empty=False):
    if not isinstance(value, str) or (not empty and not value) or len(value.encode()) > maximum or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('Invalid SFTPGo text')
    return value


def name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', value) or value in ('.', '..'):
        raise ValueError('Invalid SFTPGo object name')
    return value


def virtual_path(value, root=True):
    text(value, 2048)
    if not value.startswith('/') or any(v in value for v in ('\\', '\x00')) or any(part in ('.', '..', '') for part in value.split('/')[1:]) or (not root and value == '/'):
        if value != '/' or not root:
            raise ValueError('Invalid SFTPGo virtual path')
    return value


def integer(value, maximum=2**53 - 1, minimum=0):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('Invalid SFTPGo numeric limit')
    return value


def permissions(value):
    if not isinstance(value, dict) or '/' not in value or len(value) > 128:
        raise ValueError('Root directory permissions required')
    for path, modes in value.items():
        virtual_path(path)
        if not isinstance(modes, list) or not modes or len(modes) != len(set(modes)) or any(mode not in PERMISSIONS for mode in modes):
            raise ValueError('Invalid SFTPGo permissions')
    return value


class NativeError(ValueError):
    def __init__(self, status):
        self.status = status
        super().__init__('SFTPGo API request rejected (' + str(status) + ')')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class SFTPGoController:
    def __init__(self, parent):
        self.parent, self.root, self.installation, self.docker = parent, Path(parent.root), parent.installation, parent.docker
        self.base = self.root / 'modules/sftpgo'
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        for path in (self.base, self.instances, self.operations):
            directory(path)
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        installation = json.loads(read_file(self.root / 'state/installation.json'))
        bundle = registry.get('sftpgo')
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation or installation.get('install_id') != self.installation
                or not re.fullmatch('[0-9a-f]{64}', registry.get('manifest_sha256', '')) or registry.get('manifest_sha256') != installation.get('manifest_sha256')
                or not isinstance(bundle, dict) or set(bundle) != {'server'}):
            raise ValueError('Invalid SFTPGo installation identity')
        self.image = bundle['server']
        labels = self.image.get('labels', {})
        if (set(self.image) != {'id', 'architecture', 'ref', 'recipe', 'labels'} or not re.fullmatch('sha256:[0-9a-f]{64}', self.image.get('id', ''))
                or self.image.get('architecture') not in ('amd64', 'arm64') or self.image.get('recipe') != 'deploy/images/sftpgo.Dockerfile'
                or labels.get('pl.module.id') != 'sftpgo' or labels.get('pl.module.role') != 'server' or labels.get('pl.module.config.version') != '1'
                or labels.get('pl.build.variant') != 'upstream-pinned' or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', labels.get('org.opencontainers.image.version', ''))):
            raise ValueError('Invalid SFTPGo image descriptor')
        self.version = labels['org.opencontainers.image.version']
        self.sessions, self.admin_tokens, self.session_lock = {}, {}, threading.RLock()
        self._routes, self._route_lock = {}, threading.RLock()

    @contextmanager
    def locked(self, instance, exclusive=False):
        path = self.operations / ('instance-' + identifier(instance) + '.lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600:
            os.close(fd)
            raise ValueError('Unsafe SFTPGo lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def names(self, instance, suffix=''):
        return self.installation + '-sftpgo-' + identifier(instance) + suffix

    def labels(self, instance):
        return {'pl.installation': self.installation, 'pl.module': 'sftpgo', 'pl.instance': identifier(instance)}

    def path(self, instance, create=False):
        path = self.instances / identifier(instance)
        directory(path, create=create)
        for sub, mode in (('config', 0o755), ('plans', 0o700)):
            directory(path / sub, create=create, mode=mode)
        return path

    def settings(self, value):
        if not isinstance(value, dict) or set(value) != {'listen_ip', 'port'}:
            raise ValueError('Invalid SFTPGo listener configuration')
        ip = ipaddress.IPv4Address(value['listen_ip'])
        if str(ip) != value['listen_ip'] or (str(ip) != '127.0.0.1' and not any(ip in ipaddress.IPv4Network(cidr) for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))):
            raise ValueError('Only host loopback or private IPv4 is supported')
        integer(value['port'], 65535, 1024)
        return value

    def initial_listener(self):
        # Discovery is only for a new instance. Persist the selected port once;
        # preflight and Docker still reject a later bind race without reallocating.
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                try:
                    sock.bind(('127.0.0.1', 2022))
                except OSError as error:
                    if error.errno != errno.EADDRINUSE:
                        raise
                    sock.bind(('127.0.0.1', 0))
                selected = {'listen_ip': '127.0.0.1', 'port': sock.getsockname()[1]}
                self.settings(selected)
                return selected
        except OSError:
            raise ValueError('Initial SFTPGo listener allocation unavailable') from None

    def preflight(self, value, previous=None):
        self.settings(value)
        if value == previous:
            return
        if value['listen_ip'] != '127.0.0.1':
            try:
                result = subprocess.run(['ip', '-j', '-4', 'address', 'show'], cwd=self.root, env=getattr(self.parent, 'env', {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}), capture_output=True, timeout=10, check=True)
                addresses = {a['local'] for interface in json.loads(result.stdout) for a in interface.get('addr_info', []) if a.get('family') == 'inet'}
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                raise ValueError('Host IPv4 enumeration unavailable') from None
            if value['listen_ip'] not in addresses:
                raise ValueError('Listener IPv4 is not assigned to this host')
        with socket.socket() as sock:
            try:
                sock.bind((value['listen_ip'], value['port']))
            except OSError:
                raise ValueError('Requested SFTP port is not available') from None

    def config(self, state):
        return {'common': {'idle_timeout': 15, 'symlink_mode': 0, 'defender': {'enabled': False}, 'event_manager': {'enabled_commands': []}},
                'data_provider': {'driver': 'sqlite', 'name': '/var/lib/sftpgo/sftpgo.db', 'users_base_dir': '/srv/sftpgo/data/users', 'backups_path': '/srv/sftpgo/backups', 'create_default_admin': False, 'track_quota': 2},
                'sftpd': {'bindings': [{'address': '', 'port': 2022}], 'host_keys': ['/var/lib/sftpgo/id_ed25519', '/var/lib/sftpgo/id_rsa'], 'enabled_ssh_commands': [], 'keyboard_interactive_authentication': False, 'password_authentication': True},
                'ftpd': {'bindings': []}, 'webdavd': {'bindings': []},
                'httpd': {'bindings': [{'address': '', 'port': 8080, 'enable_web_admin': False, 'enable_web_client': False, 'enable_rest_api': True, 'render_openapi': False}], 'signing_passphrase': state['signing_key'], 'jwt_lifetime': 15},
                'telemetry': {'bind_port': 0}}

    def files(self, state):
        return {'sftpgo.json': encoded(self.config(state)), 'bootstrap.json': encoded({'version': 17, 'admins': [{'username': 'pl-controller', 'password': state['admin_password'], 'status': 1, 'permissions': ['*']} ]})}

    def state(self, instance, pending=False, check_files=True):
        path = self.path(instance)
        value = json.loads(read_file(path / 'state.json'))
        if (set(value) != {'installation', 'instance_id', 'admin_password', 'signing_key', 'configuration', 'revision', 'pending'}
                or value['installation'] != self.installation or value['instance_id'] != instance
                or any(not re.fullmatch('[0-9a-f]{64}', value.get(key, '')) for key in ('admin_password', 'signing_key'))
                or type(value['revision']) is not int or value['revision'] < 0):
            raise ValueError('Invalid SFTPGo private state')
        self.settings(value['configuration'])
        if value['pending'] is not None:
            change = value['pending']
            if not isinstance(change, dict) or set(change) != {'ref', 'configuration', 'revision'} or change['revision'] != value['revision'] + 1:
                raise ValueError('Invalid SFTPGo pending plan')
            identifier(change['ref'])
            self.settings(change['configuration'])
            if not pending:
                raise ValueError('SFTPGo configuration reconciliation required')
        if check_files:
            for name_, expected in self.files(value).items():
                file = path / 'config' / name_
                if read_file(file, mode=0o440) != expected or file.stat().st_gid != GID:
                    raise ValueError('SFTPGo private configuration drift')
        return value

    def initialize(self, instance):
        path = self.path(instance, create=True)
        if (path / 'state.json').exists() or (path / 'state.json').is_symlink():
            value = self.state(instance, pending=True, check_files=False)
            if set(p.name for p in (path / 'config').iterdir()) - {'sftpgo.json', 'bootstrap.json'}:
                raise ValueError('Unknown SFTPGo initialization files')
            for name_, expected in self.files(value).items():
                file = path / 'config' / name_
                if file.exists() or file.is_symlink():
                    if read_file(file, mode=0o440) != expected or file.stat().st_gid != GID:
                        raise ValueError('SFTPGo private initialization drift')
                else:
                    atomic(file, expected, mode=0o440)
                    os.chown(file, -1, GID)
            self.state(instance, pending=True)
            return
        if list((path / 'config').iterdir()) or list((path / 'plans').iterdir()):
            raise ValueError('Unmanaged SFTPGo files exist')
        value = {'installation': self.installation, 'instance_id': instance, 'admin_password': secrets.token_hex(32), 'signing_key': secrets.token_hex(32), 'configuration': self.initial_listener(), 'revision': 0, 'pending': None}
        atomic(path / 'state.json', value)
        for name_, raw in self.files(value).items():
            atomic(path / 'config' / name_, raw, mode=0o440)
            os.chown(path / 'config' / name_, -1, GID)

    def resource(self, instance, kind, volume='', create=False):
        resource = self.names(instance, '-net' if kind == 'network' else '-' + volume + '-data')
        found = self.docker(kind, 'ls', '--filter', 'name=^' + resource + '$', '--format', '{{.Name}}').decode().strip()
        if not found and create:
            args = [kind, 'create'] + (['--driver', 'bridge'] + _files.module_network_args(self.root, self.installation, self.docker) if kind == 'network' else [])
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, resource)
            return self.resource(instance, kind, volume)
        if not found:
            return None
        obj = json.loads(self.docker(kind, 'inspect', resource))[0]
        if kind == 'network':
            _files.validate_module_network(self.root, self.installation, obj, self.docker)
        if (obj.get('Name') != resource or obj.get('Driver') != ('bridge' if kind == 'network' else 'local') or obj.get('Options')
                or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())
                or kind == 'network' and (obj.get('Internal') is not False or obj.get('Scope') != 'local' or obj.get('Ingress'))):
            raise ValueError('SFTPGo resource ownership mismatch')
        if kind == 'network':
            for container_id, member in obj.get('Containers', {}).items():
                if member.get('Name') != self.names(instance):
                    raise ValueError('Foreign member on SFTPGo network')
                container = json.loads(self.docker('container', 'inspect', self.names(instance)))[0]
                if container.get('Id') != container_id or any((container.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items()):
                    raise ValueError('Foreign member on SFTPGo network')
        return obj

    def verify_image(self):
        obj = json.loads(self.docker('image', 'inspect', self.image['id']))[0]
        if (obj.get('Id') != self.image['id'] or obj.get('Os') != 'linux' or obj.get('Architecture') != self.image['architecture']
                or any((obj.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in self.image['labels'].items())
                or obj.get('Config', {}).get('User') != '1000:1000'):
            raise ValueError('SFTPGo image identity mismatch')
        return obj

    def selected(self, state, revision):
        if revision == state['revision']:
            return state['configuration']
        if state['pending'] and revision == state['pending']['revision']:
            return state['pending']['configuration']
        raise ValueError('SFTPGo container revision mismatch')

    def inspect(self, instance):
        found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + self.names(instance) + '$', '--format', '{{.ID}}').decode().strip()
        if not found:
            return None
        state = self.state(instance, pending=True)
        image = self.verify_image()
        obj = json.loads(self.docker('container', 'inspect', self.names(instance)))[0]
        config, host = obj.get('Config', {}), obj.get('HostConfig', {})
        labels = config.get('Labels') or {}
        try:
            selected = self.selected(state, int(labels.get('pl.sftpgo.revision', '-1')))
        except (TypeError, ValueError):
            raise ValueError('SFTPGo container configuration drift') from None
        mounts = {(v.get('Type'), v.get('Name') if v.get('Type') == 'volume' else v.get('Source'), v.get('Destination'), v.get('RW')) for v in obj.get('Mounts', [])}
        expected = {('bind', str(self.path(instance) / 'config'), '/etc/pl-sftpgo', False), ('volume', self.names(instance, '-state-data'), '/var/lib/sftpgo', True), ('volume', self.names(instance, '-files-data'), '/srv/sftpgo', True)}
        ports = host.get('PortBindings') or {}
        sftp = ports.get('2022/tcp') or []
        api = ports.get('8080/tcp') or []
        if (not re.fullmatch('[0-9a-f]{64}', obj.get('Id', '')) or obj.get('Image') != self.image['id'] or config.get('Image') != self.image['id']
                or any(labels.get(k) != v for k, v in self.labels(instance).items()) or mounts != expected
                or config.get('Cmd') != COMMAND or config.get('Entrypoint') != ['/usr/local/bin/sftpgo']
                or any(config.get(k) != image['Config'].get(k) for k in ('User', 'Env', 'WorkingDir', 'Healthcheck'))
                or set(ports) != {'2022/tcp', '8080/tcp'} or len(sftp) != 1 or sftp[0] != {'HostIp': selected['listen_ip'], 'HostPort': str(selected['port'])}
                or len(api) != 1 or api[0].get('HostIp') != '127.0.0.1'
                or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapDrop') != ['ALL'] or host.get('CapAdd')
                or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts')
                or host.get('PidMode') not in ('', None) or host.get('IpcMode') not in ('private', None) or host.get('UTSMode') not in ('', None)
                or host.get('UsernsMode') not in ('', None) or host.get('VolumesFrom') or host.get('Links') or host.get('ExtraHosts')
                or host.get('NetworkMode') != self.names(instance, '-net')
                or host.get('Memory') != 512 * 1024**2 or host.get('NanoCpus') != 1_000_000_000 or host.get('PidsLimit') != 128 or not host.get('Init')
                or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped' or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])
                or host.get('Tmpfs') != {'/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777'}
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or set(obj.get('NetworkSettings', {}).get('Networks', {})) != {self.names(instance, '-net')}):
            raise ValueError('SFTPGo container ownership or configuration drift')
        if not self.resource(instance, 'network') or not self.resource(instance, 'volume', 'state') or not self.resource(instance, 'volume', 'files'):
            raise ValueError('SFTPGo owned resources missing')
        return obj

    def create(self, instance, configuration, revision):
        self.verify_image()
        args = ['container', 'create', '--name', self.names(instance), '--network', self.names(instance, '-net'), '--restart', 'unless-stopped', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864,mode=1777', '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2', '--publish', '127.0.0.1::8080', '--publish', configuration['listen_ip'] + ':' + str(configuration['port']) + ':2022']
        for mount in ('type=bind,source=' + str(self.path(instance) / 'config') + ',target=/etc/pl-sftpgo,readonly', 'type=volume,source=' + self.names(instance, '-state-data') + ',target=/var/lib/sftpgo', 'type=volume,source=' + self.names(instance, '-files-data') + ',target=/srv/sftpgo'):
            args += ['--mount', mount]
        for key, value in {**self.labels(instance), 'pl.sftpgo.revision': str(revision)}.items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.image['id'])
        self.inspect(instance)

    def endpoint(self, obj):
        ports = obj.get('NetworkSettings', {}).get('Ports', {}).get('8080/tcp') or []
        if len(ports) != 1 or ports[0].get('HostIp') != '127.0.0.1' or not str(ports[0].get('HostPort', '')).isdigit() or not 1 <= int(ports[0]['HostPort']) <= 65535:
            raise ValueError('Invalid SFTPGo API binding')
        return 'http://127.0.0.1:' + str(ports[0]['HostPort'])

    def http(self, instance, method, path, payload=None, headers=None, user=False, *, origin=None):
        origin = origin or self.route(instance)[2]
        raw = encoded(payload) if payload is not None else None
        request = urllib.request.Request(origin + '/api/v2' + path, method=method, data=raw, headers={**(headers or {}), **({'Content-Type': 'application/json'} if raw is not None else {}), 'Accept-Encoding': 'identity'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            response = opener.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            if status >= 500:
                self._routes.pop(instance, None)
            raise NativeError(status) from None
        except (OSError, http.client.HTTPException):
            self._routes.pop(instance, None)
            raise ValueError('SFTPGo native API unavailable') from None
        with response:
            try:
                data = response.read(MAX_RESPONSE + 1)
            except (OSError, http.client.HTTPException):
                self._routes.pop(instance, None)
                raise
            if len(data) > MAX_RESPONSE or response.headers.get_content_type() != 'application/json':
                self._routes.pop(instance, None)
                raise ValueError('SFTPGo response outside finite contract')
            try:
                return json.loads(data) if data else {}
            except (ValueError, UnicodeError):
                self._routes.pop(instance, None)
                raise

    def token(self, instance, username, password, user=False, *, origin=None):
        value = base64.b64encode((text(username, 64) + ':' + text(password, 1024)).encode()).decode()
        result = self.http(instance, 'GET', '/user/token' if user else '/token', headers={'Authorization': 'Basic ' + value}, user=user, origin=origin)
        token = result.get('access_token')
        if not isinstance(token, str) or not re.fullmatch('[A-Za-z0-9_.-]{16,8192}', token):
            raise ValueError('SFTPGo token response invalid')
        return token

    def admin(self, instance, method, path, payload=None, *, origin=None):
        with self.session_lock:
            cached = self.admin_tokens.get(instance)
        if not cached or cached['expires'] < time.monotonic():
            token = self.token(instance, 'pl-controller', self.state(instance, pending=True)['admin_password'], origin=origin)
            cached = {'token': token, 'expires': time.monotonic() + 600}
            with self.session_lock:
                self.admin_tokens[instance] = cached
        try:
            return self.http(instance, method, path, payload, {'Authorization': 'Bearer ' + cached['token']}, origin=origin)
        except NativeError as error:
            if error.status == 401:
                with self.session_lock:
                    self.admin_tokens.pop(instance, None)
            raise

    def route(self, instance):
        identifier(instance)
        route = self._routes.get(instance)
        if route is None or time.monotonic() - route[0] >= ROUTE_MAX_AGE:
            with self._route_lock:
                route = self._routes.get(instance)
                if route is None or time.monotonic() - route[0] >= ROUTE_MAX_AGE:
                    self.ready(instance)
                    route = self._routes[instance]
        return route

    def native_ready(self, instance, origin):
        # Probe real status on health reconciliation and explicit status reads;
        # file/user data requests do not execute these readiness calls.
        version = self.admin(instance, 'GET', '/version', origin=origin)
        status = self.admin(instance, 'GET', '/status', origin=origin)
        if str(version.get('version', '')).removeprefix('v') != self.version or not isinstance(status, dict) or not status.get('data_provider', {}).get('is_active') or not status.get('ssh', {}).get('is_active'):
            raise ValueError('SFTPGo native database/SFTP readiness unconfirmed')

    def ready(self, instance, pending=False):
        with self._route_lock:
            try:
                self.state(instance, pending=pending)
                obj = self.inspect(instance)
                if not obj or not obj.get('State', {}).get('Running'):
                    raise ValueError('SFTPGo is not running')
                origin = self.endpoint(obj)
                self.native_ready(instance, origin)
                verified = {'Id': obj.get('Id'), 'Image': obj.get('Image'),
                    'NetworkSettings': {'Ports': obj.get('NetworkSettings', {}).get('Ports', {})}}
                self._routes[instance] = (time.monotonic(), verified, origin)
                return obj
            except Exception:
                self._routes.pop(instance, None)
                raise

    def start(self, instance, configuration=None, revision=None):
        self._routes.pop(instance, None)
        state = self.state(instance, pending=True)
        configuration = configuration or state['configuration']
        revision = state['revision'] if revision is None else revision
        obj = self.inspect(instance)
        if obj is None:
            self.preflight(configuration)
            self.create(instance, configuration, revision)
            obj = self.inspect(instance)
        if not obj.get('State', {}).get('Running'):
            self.docker('container', 'start', obj['Id'])

    def forget(self, instance):
        with self.session_lock:
            self.sessions = {k: v for k, v in self.sessions.items() if k[0] != instance}
            self.admin_tokens.pop(instance, None)

    def drop_container(self, instance):
        self._routes.pop(instance, None)
        obj = self.inspect(instance)
        if obj:
            if obj.get('State', {}).get('Running'):
                self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
            self.docker('container', 'rm', obj['Id'])
        self.forget(instance)

    def summary(self, state):
        return {**state['configuration'], 'revision': state['revision'], 'configuration_hash': hashlib.sha256(encoded(state['configuration'])).hexdigest()}

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
        if (self.instances / identifier(instance)).is_symlink():
            raise ValueError('Unsafe SFTPGo instance ownership')
        if not (self.instances / identifier(instance)).exists():
            if self.inspect(instance) or self.resource(instance, 'network') or any(self.resource(instance, 'volume', v) for v in ('state', 'files')):
                raise ValueError('SFTPGo artifacts without managed state')
            return {'state': 'absent', 'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        state = self.state(instance)
        obj = self.inspect(instance)
        if obj is None:
            raise ValueError('SFTPGo managed container missing')
        running = obj.get('State', {}).get('Running')
        if running:
            self.ready(instance)
        return {'state': 'running' if running else 'disabled', 'version': self.version, 'endpoint': self.endpoint(obj) if running else '', 'error': '', 'targets_up': 0, 'targets_total': 0, 'configuration_revision': state['revision'], 'configuration_hash': self.summary(state)['configuration_hash']}

    def get(self, instance):
        with self.locked(instance):
            return self.observe(instance)

    def ensure(self, instance):
        self._routes.pop(instance, None)
        self.initialize(instance)
        self.resource(instance, 'network', create=True)
        for volume in ('state', 'files'):
            self.resource(instance, 'volume', volume, create=True)
        self.start(instance)
        deadline = time.monotonic() + 60
        while True:
            try:
                return self.ready(instance)
            except (ValueError, OSError):
                if time.monotonic() >= deadline:
                    raise ValueError('SFTPGo native bootstrap/readiness unconfirmed') from None
                time.sleep(0.5)

    def prepare(self, instance, payload):
        if not isinstance(payload, dict) or set(payload) != {'configuration', 'expected_revision'}:
            raise ValueError('Invalid SFTPGo configuration preparation')
        state = self.state(instance)
        if type(payload['expected_revision']) is not int or payload['expected_revision'] != state['revision']:
            raise NativeError(409)
        configuration = self.settings(payload['configuration'])
        self.preflight(configuration, state['configuration'])
        ref = str(uuid.uuid4())
        plan = {'installation': self.installation, 'instance_id': instance, 'ref': ref, 'configuration': configuration, 'revision': state['revision'] + 1}
        path = self.path(instance) / 'plans' / (ref + '.json')
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encoded(plan)); stream.flush(); os.fsync(stream.fileno())
        fsync_directory(path.parent)
        return {'configuration_ref': ref, 'revision': plan['revision'], 'configuration_hash': hashlib.sha256(encoded(configuration)).hexdigest(), 'configuration': configuration}

    def configure(self, instance, ref):
        self._routes.pop(instance, None)
        plan = json.loads(read_file(self.path(instance) / 'plans' / (identifier(ref) + '.json')))
        state = self.state(instance, pending=True)
        if (set(plan) != {'installation', 'instance_id', 'ref', 'configuration', 'revision'} or plan['installation'] != self.installation or plan['instance_id'] != instance or plan['ref'] != ref):
            raise ValueError('SFTPGo configuration plan ownership mismatch')
        self.settings(plan['configuration'])
        if state['revision'] == plan['revision'] and state['configuration'] == plan['configuration']:
            return
        if plan['revision'] != state['revision'] + 1 or state['pending'] and state['pending']['ref'] != ref:
            raise ValueError('SFTPGo configuration plan revision conflict')
        active = self.inspect(instance)
        previous = self.selected(state, int(active['Config']['Labels']['pl.sftpgo.revision'])) if active else None
        self.preflight(plan['configuration'], previous)
        if not state['pending']:
            state['pending'] = {k: plan[k] for k in ('ref', 'configuration', 'revision')}
            atomic(self.path(instance) / 'state.json', state)
        self.drop_container(instance)
        try:
            self.start(instance, plan['configuration'], plan['revision'])
            deadline = time.monotonic() + 60
            while True:
                try:
                    self.ready(instance, pending=True)
                    next_state = {**state, 'configuration': plan['configuration'], 'revision': plan['revision'], 'pending': None}
                    atomic(self.path(instance) / 'state.json', next_state)
                    return
                except (ValueError, OSError):
                    if time.monotonic() >= deadline:
                        raise ValueError('SFTPGo new listener readiness unconfirmed') from None
                    time.sleep(0.5)
        except (ValueError, OSError):
            # Both revisions remain valid during recovery; the old data volumes
            # and private credentials are never replaced by a listener change.
            atomic(self.path(instance) / 'state.json', state)
            self.drop_container(instance)
            atomic(self.path(instance) / 'state.json', {**state, 'pending': None})
            self.start(instance)
            self.ready(instance)
            raise ValueError('SFTPGo listener change failed; previous binding restored') from None

    def remove(self, instance):
        self._routes.pop(instance, None)
        path = self.instances / identifier(instance)
        marker = self.operations / ('remove-' + instance + '.json')
        if path.is_symlink():
            raise ValueError('Unsafe SFTPGo removal instance')
        if not path.exists():
            self.observe(instance)
            if marker.exists():
                journal = json.loads(read_file(marker))
                if journal.get('installation') != self.installation or journal.get('instance_id') != instance:
                    raise ValueError('Invalid SFTPGo removal journal')
                marker.unlink(); fsync_directory(self.operations)
            return
        if not marker.exists():
            self.state(instance, pending=True)
            if set(p.name for p in path.iterdir()) != {'config', 'plans', 'state.json'} or set(p.name for p in (path / 'config').iterdir()) != {'sftpgo.json', 'bootstrap.json'}:
                raise ValueError('Unknown SFTPGo removal files')
            expected = {'state.json': 0o600, 'config/sftpgo.json': 0o440, 'config/bootstrap.json': 0o440}
            for plan in (path / 'plans').iterdir():
                identifier(plan.stem)
                data = json.loads(read_file(plan))
                if data.get('installation') != self.installation or data.get('instance_id') != instance or data.get('ref') != plan.stem or plan.suffix != '.json':
                    raise ValueError('Foreign SFTPGo configuration plan')
                expected['plans/' + plan.name] = 0o600
            self.inspect(instance)
            self.resource(instance, 'network')
            for volume in ('state', 'files'):
                self.resource(instance, 'volume', volume)
            atomic(marker, {'installation': self.installation, 'instance_id': instance,
                            'files': {key: {'mode': mode, 'sha256': hashlib.sha256(read_file(path / key, mode=mode)).hexdigest()} for key, mode in expected.items()}})
        journal = json.loads(read_file(marker))
        if set(journal) != {'installation', 'instance_id', 'files'} or journal['installation'] != self.installation or journal['instance_id'] != instance or not isinstance(journal['files'], dict):
            raise ValueError('Invalid SFTPGo removal journal')
        expected = journal['files']
        if not {'state.json', 'config/sftpgo.json', 'config/bootstrap.json'} <= set(expected):
            raise ValueError('Incomplete SFTPGo removal journal')
        for key, item in expected.items():
            if key not in ('state.json', 'config/sftpgo.json', 'config/bootstrap.json'):
                if not re.fullmatch(r'plans/[0-9a-f-]{36}\.json', key):
                    raise ValueError('Unknown SFTPGo removal artifact')
                identifier(Path(key).stem)
            if set(item) != {'mode', 'sha256'} or item['mode'] != (0o440 if key.startswith('config/') else 0o600) or not re.fullmatch('[0-9a-f]{64}', item['sha256']):
                raise ValueError('Invalid SFTPGo removal fingerprint')
            file = path / key
            if (file.exists() or file.is_symlink()) and hashlib.sha256(read_file(file, mode=item['mode'])).hexdigest() != item['sha256']:
                raise ValueError('SFTPGo removal artifact changed')
        if set(p.name for p in path.iterdir()) - {'config', 'plans', 'state.json'}:
            raise ValueError('Unknown SFTPGo removal files')
        for sub, mode in (('config', 0o755), ('plans', 0o700)):
            folder = path / sub
            if folder.exists() or folder.is_symlink():
                directory(folder, create=False, mode=mode)
                if any(sub + '/' + file.name not in expected for file in folder.iterdir()):
                    raise ValueError('Unknown SFTPGo removal files')
        self.drop_container(instance)
        for volume in ('state', 'files'):
            if self.resource(instance, 'volume', volume):
                self.docker('volume', 'rm', self.names(instance, '-' + volume + '-data'))
            if self.resource(instance, 'volume', volume):
                raise ValueError('SFTPGo volume removal unconfirmed')
        if self.resource(instance, 'network'):
            self.docker('network', 'rm', self.names(instance, '-net'))
        if self.resource(instance, 'network'):
            raise ValueError('SFTPGo network removal unconfirmed')
        for key in sorted(expected, key=lambda value: value == 'state.json'):
            (path / key).unlink(missing_ok=True)
        for sub in ('config', 'plans'):
            if (path / sub).exists():
                (path / sub).rmdir()
        path.rmdir(); fsync_directory(self.instances)
        marker.unlink(); fsync_directory(self.operations)
        self.forget(instance)

    def execute(self, body):
        fields = {'operation_id', 'instance_id', 'module_id', 'action'}
        if not isinstance(body, dict) or not fields <= set(body) or set(body) - fields - {'configuration_ref'} or body['module_id'] != 'sftpgo' or body['action'] not in ('install', 'refresh', 'disable', 'enable', 'remove', 'configure'):
            raise ValueError('Invalid SFTPGo lifecycle operation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        if (body['action'] == 'configure') != bool(body.get('configuration_ref')):
            raise ValueError('SFTPGo configuration reference required only for configure')
        with self.locked(instance, exclusive=True):
            self._routes.pop(instance, None)
            journal = self.operations / (operation + '.json')
            fingerprint = hashlib.sha256(encoded(body)).hexdigest()
            if journal.exists():
                previous = json.loads(read_file(journal))
                if previous.get('fingerprint') != fingerprint:
                    raise ValueError('SFTPGo operation identity conflict')
                if previous.get('phase') == 'complete':
                    return {**self.observe(instance), 'operation_id': operation}
            atomic(journal, {'fingerprint': fingerprint, 'phase': 'running'})
            try:
                if body['action'] in ('install', 'enable'):
                    self.ensure(instance)
                elif body['action'] == 'disable':
                    obj = self.inspect(instance)
                    if obj and obj.get('State', {}).get('Running'):
                        self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                    self.forget(instance)
                elif body['action'] == 'remove':
                    self.remove(instance)
                elif body['action'] == 'configure':
                    self.configure(instance, body['configuration_ref'])
                result = {**self.observe(instance), 'operation_id': operation}
                atomic(journal, {'fingerprint': fingerprint, 'phase': 'complete'})
                return result
            except (ValueError, OSError, KeyError, TypeError) as error:
                self._routes.pop(instance, None)
                return {'state': 'error', 'version': '', 'endpoint': '', 'error': _files.module_network_error(error, 'SFTPGo operation unconfirmed; reconcile the same operation'), 'targets_up': 0, 'targets_total': 0, 'operation_id': operation}

    def actor(self, actor):
        if (not isinstance(actor, dict) or set(actor) != {'subject', 'admin', 'session_key'} or type(actor['admin']) is not bool
                or not re.fullmatch('[0-9a-f]{64}', actor.get('session_key', ''))):
            raise ValueError('Invalid trusted PL actor')
        text(actor['subject'], 256)
        return actor

    def client(self, instance, actor):
        key = (instance, actor['session_key'])
        with self.session_lock:
            self.sessions = {k: v for k, v in self.sessions.items() if v['expires'] > time.monotonic()}
            value = self.sessions.get(key)
        if not value or value['subject'] != actor['subject']:
            raise NativeError(401)
        return value

    def user_http(self, instance, actor, method, path):
        session = self.client(instance, actor)
        try:
            return self.http(instance, method, path, headers={'Authorization': 'Bearer ' + session['token']}, user=True)
        except NativeError as error:
            if error.status == 401:
                with self.session_lock:
                    self.sessions.pop((instance, actor['session_key']), None)
            raise

    def folders(self, instance, value):
        if not isinstance(value, list) or len(value) > 128:
            raise ValueError('Invalid virtual folders')
        result, seen = [], set()
        for item in value:
            if not isinstance(item, dict) or set(item) != {'name', 'virtual_path', 'quota_size', 'quota_files'}:
                raise ValueError('Invalid virtual folder mapping')
            folder = self.admin(instance, 'GET', '/folders/' + name(item['name']))
            if folder.get('mapped_path') != '/srv/sftpgo/data/shared/' + item['name'] or folder.get('filesystem', {}).get('provider', 0) != 0:
                raise ValueError('Shared folder is outside owned storage')
            path = virtual_path(item['virtual_path'], root=False)
            if path in seen:
                raise ValueError('Duplicate virtual folder path')
            seen.add(path)
            result.append({'name': item['name'], 'mapped_path': folder['mapped_path'], 'virtual_path': path,
                           'quota_size': integer(item['quota_size'], minimum=-1), 'quota_files': integer(item['quota_files'], minimum=-1), 'filesystem': {'provider': 0}})
        return result

    def native_user(self, instance, user, existing=None):
        required = USER_FIELDS - {'password'}
        if not isinstance(user, dict) or not required <= set(user) or set(user) - USER_FIELDS:
            raise ValueError('Invalid SFTPGo user fields')
        username = name(user['username'])
        if any(type(user[k]) is not bool for k in ('enabled', 'password_enabled', 'public_key_enabled')):
            raise ValueError('Invalid user authentication flags')
        if not user['password_enabled'] and not user['public_key_enabled']:
            raise ValueError('At least one login method must be enabled')
        keys = user['public_keys']
        if not isinstance(keys, list) or len(keys) > 32:
            raise ValueError('Invalid SSH public keys')
        for key in keys:
            text(key, 16384)
            fields = key.split()
            if len(fields) < 2 or fields[0] not in ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'):
                raise ValueError('OpenSSH public key required')
            try:
                if len(base64.b64decode(fields[1], validate=True)) < 24:
                    raise ValueError()
            except ValueError:
                raise ValueError('Invalid OpenSSH public key encoding') from None
        if user['public_key_enabled'] and not keys:
            raise ValueError('SSH public-key authentication requires a key')
        if 'password' in user:
            text(user['password'], 1024)
            if user['password'].startswith(('$2', '$argon2', '$pbkdf2', '$1$', '$5$', '$6$')):
                raise ValueError('Plain new password required; hash import is not allowed')
        if user['password_enabled'] and 'password' not in user and not (existing and existing.get('has_password')):
            raise ValueError('Password authentication requires an existing or new password')
        groups = user['groups']
        if not isinstance(groups, list) or len(groups) > 32:
            raise ValueError('Invalid group mappings')
        for group in groups:
            if not isinstance(group, dict) or set(group) != {'name', 'type'}:
                raise ValueError('Invalid group mapping')
            name(group['name']); integer(group['type'], 3, 1)
            self.admin(instance, 'GET', '/groups/' + group['name'])
        denied = ['keyboard-interactive', 'publickey+password', 'publickey+keyboard-interactive', 'TLSCertificate', 'TLSCertificate+password']
        if not user['password_enabled']:
            denied += ['password', 'password-over-SSH']
        if not user['public_key_enabled']:
            denied += ['publickey']
        native = {'username': username, 'description': text(user['description'], 1024, empty=True), 'status': int(user['enabled']),
                  'home_dir': '/srv/sftpgo/data/users/' + username, 'public_keys': keys,
                  'permissions': permissions(user['permissions']), 'groups': groups, 'virtual_folders': self.folders(instance, user['virtual_folders']),
                  'filesystem': {'provider': 0}, 'filters': {'denied_login_methods': denied, 'denied_protocols': ['FTP', 'DAV'], 'allow_api_key_auth': False}}
        for key in LIMITS:
            native[key] = integer(user[key])
        if 'password' in user:
            native['password'] = user['password']
        return native

    @staticmethod
    def public_user(user):
        denied = user.get('filters', {}).get('denied_login_methods') or []
        return {**{k: user.get(k, 0 if k in LIMITS or k in ('used_quota_size', 'used_quota_files', 'updated_at') else [] if k in ('public_keys', 'groups', 'virtual_folders') else {} if k == 'permissions' else '')
                   for k in ('username', 'description', 'public_keys', 'permissions', 'groups', 'virtual_folders', *LIMITS, 'used_quota_size', 'used_quota_files', 'updated_at')},
                'enabled': user.get('status') == 1, 'password_enabled': 'password' not in denied and 'password-over-SSH' not in denied,
                'public_key_enabled': 'publickey' not in denied, 'has_password': bool(user.get('has_password')),
                'virtual_folders': [{k: folder.get(k) for k in ('name', 'virtual_path', 'quota_size', 'quota_files')} for folder in user.get('virtual_folders', [])]}

    def public_group(self, group):
        settings = group.get('user_settings') or {}
        return {'name': group.get('name'), 'description': group.get('description', ''), 'permissions': settings.get('permissions') or {'/': ['list']},
                'virtual_folders': [{k: item.get(k) for k in ('name', 'virtual_path', 'quota_size', 'quota_files')} for item in group.get('virtual_folders', [])],
                **{k: settings.get(k, 0) for k in LIMITS}, 'users': group.get('users') or [], 'updated_at': group.get('updated_at', 0)}

    @staticmethod
    def public_folder(folder):
        return {k: folder.get(k, [] if k == 'users' else 0 if k in ('used_quota_size', 'used_quota_files') else '') for k in ('name', 'description', 'used_quota_size', 'used_quota_files', 'users')}

    def request(self, body):
        instance = identifier(body.get('instance_id')) if isinstance(body, dict) else identifier(None)
        try:
            return {'instance_id': instance, 'status': 200, 'body': self._request(body)}
        except NativeError as error:
            status = error.status if error.status in (400, 401, 403, 404, 409, 429) else 503
        except (ValueError, TypeError, KeyError, UnicodeError):
            status = 400
        except OSError:
            status = 503
        codes = {400: 'invalid_request', 401: 'authentication_required', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 429: 'rate_limited', 503: 'unavailable'}
        messages = {400: 'Проверьте параметры операции SFTPGo.', 401: 'Войдите в файловый сервис заново.', 403: 'Недостаточно прав для этой операции.', 404: 'Объект файлового сервиса не найден.', 409: 'Объект или конфигурация изменились; обновите страницу.', 429: 'Слишком много запросов к файловому сервису.', 503: 'Файловый сервис недоступен.'}
        return {'instance_id': instance, 'status': status, 'body': {'error': {'code': codes[status], 'message': messages[status]}}}

    def _request(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id', 'action', 'actor', 'payload'} or not isinstance(body['payload'], dict) or len(encoded(body)) > MAX_BODY:
            raise ValueError('Invalid SFTPGo request envelope')
        instance, actor, action, payload = identifier(body['instance_id']), self.actor(body['actor']), body['action'], body['payload']
        if not isinstance(action, str):
            raise ValueError('Invalid SFTPGo action')
        exclusive = action == 'settings-prepare'
        with self.locked(instance, exclusive=exclusive):
            try:
                self.route(instance)
            except (ValueError, OSError):
                raise NativeError(503) from None
            if action == 'client-login':
                if set(payload) != {'username', 'password'}:
                    raise ValueError('Invalid native client login')
                username = name(payload['username'])
                token = self.token(instance, username, payload['password'], user=True)
                with self.session_lock:
                    self.sessions = {k: v for k, v in self.sessions.items() if v['expires'] > time.monotonic()}
                    if len(self.sessions) >= 512 and (instance, actor['session_key']) not in self.sessions:
                        raise ValueError('SFTPGo client session limit reached')
                    self.sessions[(instance, actor['session_key'])] = {'subject': actor['subject'], 'username': username, 'token': token, 'expires': time.monotonic() + 600}
                return {'authenticated': True, 'username': username}
            if action == 'client-logout':
                if payload:
                    raise ValueError('Unexpected logout fields')
                try:
                    self.user_http(instance, actor, 'GET', '/user/logout')
                except NativeError as error:
                    if error.status != 401:
                        raise
                finally:
                    with self.session_lock:
                        self.sessions.pop((instance, actor['session_key']), None)
                return {'authenticated': False}
            if action.startswith('files-'):
                expected = {'source', 'target'} if action == 'files-rename' else {'path', 'directory'} if action == 'files-delete' else {'path'}
                if set(payload) != expected:
                    raise ValueError('Invalid file operation fields')
                if action == 'files-rename':
                    source, target = virtual_path(payload['source'], False), virtual_path(payload['target'], False)
                    self.user_http(instance, actor, 'POST', '/user/file-actions/move?' + urllib.parse.urlencode({'path': source, 'target': target}))
                    return {'ok': True}
                path = virtual_path(payload['path'], action == 'files-list')
                query = urllib.parse.urlencode({'path': path})
                if action == 'files-list':
                    entries = self.user_http(instance, actor, 'GET', '/user/dirs?' + query)
                    if not isinstance(entries, list) or len(entries) > 1000:
                        raise ValueError('SFTPGo directory exceeds display bound')
                    return {'path': path, 'entries': [{'name': text(v['name'], 1024), 'type': 'dir' if v.get('mode', 0) & 2147483648 else 'file' if not v.get('mode', 0) & 2401763328 else 'other', 'size': v.get('size', 0), 'modified_at': v.get('last_modified', '')} for v in entries]}
                if action == 'files-mkdir':
                    self.user_http(instance, actor, 'POST', '/user/dirs?' + query)
                    return {'ok': True}
                if action == 'files-delete':
                    if type(payload['directory']) is not bool:
                        raise ValueError('Explicit directory deletion flag required')
                    self.user_http(instance, actor, 'DELETE', ('/user/dirs?' if payload['directory'] else '/user/files?') + query)
                    return {'ok': True}
                raise ValueError('Unsupported SFTPGo file action')
            if action == 'status':
                if payload:
                    raise ValueError('Unexpected status fields')
                try:
                    self.native_ready(instance, self.route(instance)[2])
                except (ValueError, OSError):
                    self._routes.pop(instance, None)
                    raise NativeError(503) from None
                try:
                    client = self.client(instance, actor)
                except NativeError:
                    client = None
                return {'version': self.version, 'state': 'running', 'client_authenticated': client is not None, 'client_username': client['username'] if client else '', 'configuration': self.summary(self.state(instance))}
            if not actor['admin']:
                raise NativeError(403)
            if action == 'settings-get':
                if payload:
                    raise ValueError('Unexpected settings fields')
                return self.summary(self.state(instance))
            if action == 'settings-prepare':
                return self.prepare(instance, payload)
            if action in ('users-list', 'groups-list', 'folders-list'):
                if set(payload) - {'offset', 'limit'}:
                    raise ValueError('Invalid listing fields')
                offset, limit = integer(payload.get('offset', 0)), integer(payload.get('limit', 100), 500, 1)
                kind = action.split('-')[0]
                rows = self.admin(instance, 'GET', '/' + kind + '?' + urllib.parse.urlencode({'offset': offset, 'limit': limit, 'order': 'ASC'}))
                if not isinstance(rows, list) or len(rows) > limit:
                    raise ValueError('Invalid SFTPGo listing response')
                convert = {'users': self.public_user, 'groups': self.public_group, 'folders': self.public_folder}[kind]
                return {'items': [convert(row) for row in rows], 'offset': offset, 'limit': limit}
            if action in ('users-create', 'users-update'):
                if set(payload) != {'user'}:
                    raise ValueError('Invalid user payload')
                user = payload['user']
                username = name(user.get('username')) if isinstance(user, dict) else name(None)
                existing = self.admin(instance, 'GET', '/users/' + username) if action == 'users-update' else None
                native = self.native_user(instance, user, existing)
                self.admin(instance, 'POST' if action == 'users-create' else 'PUT', '/users' + ('/' + username + '?disconnect=1' if existing else ''), native)
                result = self.public_user(self.admin(instance, 'GET', '/users/' + username))
                self.forget(instance)
                return result
            if action == 'groups-save':
                if set(payload) != {'group'}:
                    raise ValueError('Invalid group payload')
                group = payload['group']
                if not isinstance(group, dict) or set(group) != {'name', 'description', 'permissions', 'virtual_folders', *LIMITS}:
                    raise ValueError('Invalid group fields')
                group_name = name(group['name'])
                native = {'name': group_name, 'description': text(group['description'], 1024, True), 'user_settings': {'permissions': permissions(group['permissions']), **{key: integer(group[key]) for key in LIMITS}}, 'virtual_folders': self.folders(instance, group['virtual_folders'])}
                self.save(instance, 'groups', group_name, native)
                result = self.public_group(self.admin(instance, 'GET', '/groups/' + group_name))
                self.forget(instance)
                return result
            if action == 'folders-save':
                if set(payload) != {'folder'} or not isinstance(payload['folder'], dict) or set(payload['folder']) != {'name', 'description'}:
                    raise ValueError('Invalid shared folder fields')
                folder = payload['folder']; folder_name = name(folder['name'])
                native = {'name': folder_name, 'description': text(folder['description'], 1024, True), 'mapped_path': '/srv/sftpgo/data/shared/' + folder_name, 'filesystem': {'provider': 0}}
                self.save(instance, 'folders', folder_name, native)
                result = self.public_folder(self.admin(instance, 'GET', '/folders/' + folder_name))
                self.forget(instance)
                return result
            if action in ('users-delete', 'groups-delete', 'folders-delete'):
                field = 'username' if action == 'users-delete' else 'name'
                if set(payload) != {field}:
                    raise ValueError('Invalid delete fields')
                self.admin(instance, 'DELETE', '/' + action.split('-')[0] + '/' + name(payload[field]))
                self.forget(instance)
                return {'ok': True}
            raise ValueError('Unsupported SFTPGo action')

    def save(self, instance, kind, object_name, native):
        try:
            self.admin(instance, 'GET', '/' + kind + '/' + object_name)
        except NativeError as error:
            if error.status != 404:
                raise
            self.admin(instance, 'POST', '/' + kind, native)
        else:
            self.admin(instance, 'PUT', '/' + kind + '/' + object_name, native)

    def stream(self, metadata, bodyfile, handler):
        fields = {'instance_id', 'action', 'actor', 'payload', 'body_length', 'body_sha256'}
        if not isinstance(metadata, dict) or set(metadata) != fields or metadata['action'] not in ('file-upload', 'file-download'):
            raise ValueError('Invalid SFTPGo stream envelope')
        instance, actor = identifier(metadata['instance_id']), self.actor(metadata['actor'])
        upload = metadata['action'] == 'file-upload'
        if not isinstance(metadata['payload'], dict) or set(metadata['payload']) != {'path'}:
            raise ValueError('Invalid SFTPGo stream path')
        path = virtual_path(metadata['payload']['path'], False)
        size = integer(metadata['body_length'], MAX_UPLOAD if upload else 0)
        if not re.fullmatch('[0-9a-f]{64}', metadata.get('body_sha256', '')):
            raise ValueError('Invalid SFTPGo stream digest')
        digest = hashlib.sha256(); received = 0
        bodyfile.seek(0)
        while chunk := bodyfile.read(65536):
            received += len(chunk); digest.update(chunk)
            if received > size:
                raise ValueError('SFTPGo stream size mismatch')
        if received != size or digest.hexdigest() != metadata['body_sha256']:
            raise ValueError('SFTPGo stream digest mismatch')
        bodyfile.seek(0)
        with self.locked(instance):
            route = self.route(instance)
            session = self.client(instance, actor)
            endpoint = urllib.parse.urlsplit(route[2])
            connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=120)
            headers = {'Authorization': 'Bearer ' + session['token'], 'Accept-Encoding': 'identity'}
            if upload:
                headers.update({'Content-Type': 'application/octet-stream', 'Content-Length': str(size)})
            native = '/api/v2/user/files/upload?' if upload else '/api/v2/user/files?'
            try:
                try:
                    connection.request('POST' if upload else 'GET', native + urllib.parse.urlencode({'path': path}), body=bodyfile if upload else None, headers=headers)
                    response = connection.getresponse()
                except (OSError, http.client.HTTPException):
                    self._routes.pop(instance, None)
                    raise
                if not 200 <= response.status < 300:
                    if response.status >= 500:
                        self._routes.pop(instance, None)
                    if response.status == 401:
                        with self.session_lock:
                            self.sessions.pop((instance, actor['session_key']), None)
                    raise NativeError(response.status)
                handler.send_response(200)
                handler.send_header('Content-Type', 'application/json' if upload else 'application/octet-stream')
                handler.send_header('Cache-Control', 'no-store')
                handler.send_header('X-Content-Type-Options', 'nosniff')
                if not upload:
                    handler.send_header('Content-Disposition', "attachment; filename*=UTF-8''" + urllib.parse.quote(path.rsplit('/', 1)[1], safe=''))
                    length = response.getheader('Content-Length')
                    if length and length.isdigit():
                        handler.send_header('Content-Length', length)
                    else:
                        handler.close_connection = True
                        handler.send_header('Connection', 'close')
                else:
                    handler.send_header('Content-Length', '11')
                handler.end_headers()
                if upload:
                    try:
                        response.read(MAX_RESPONSE + 1)
                    except (OSError, http.client.HTTPException):
                        self._routes.pop(instance, None)
                        raise
                    handler.wfile.write(b'{"ok":true}')
                else:
                    while True:
                        try:
                            chunk = response.read(65536)
                        except (OSError, http.client.HTTPException):
                            self._routes.pop(instance, None)
                            raise
                        if not chunk:
                            break
                        handler.wfile.write(chunk)
                handler.wfile.flush()
            finally:
                connection.close()
