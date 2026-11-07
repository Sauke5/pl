#!/usr/bin/env python3
"""Owned NetMap lifecycle and finite authenticated loopback gateway transport.

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
import stat
import string
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager, nullcontext

_helper = Path(__file__).with_name('xray-controller.py')
if _helper.is_symlink() or not _helper.is_file():
    raise ValueError('Trusted file primitives unavailable')
_spec = importlib.util.spec_from_file_location('pl_netmap_files', _helper)
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
identifier, directory, read_file = _files.identifier, _files.directory, _files.read_file
atomic, encoded, fsync_directory = _files.atomic, _files.encoded, _files.fsync_directory

MAX_BODY = 3 * 1024 * 1024
MAX_RESPONSE = 32 * 1024 * 1024
ROLES = ('database', 'cache', 'netbox', 'netbox-worker', 'gitea', 'adapter', 'oxidized')
VOLUMES = ('database', 'cache', 'media', 'gitea', 'adapter', 'oxidized')
CONFIG_FILES = ('postgres_password', 'netbox.json', 'adapter.json', 'oxidized.json', 'gitea.ini', 'cache.conf', 'gateway_key')
MEMORY = {'database': 512, 'cache': 256, 'netbox': 2048, 'netbox-worker': 1024, 'gitea': 512, 'adapter': 512, 'oxidized': 512}
API_GID = 10001
DATABASE_GID = 70
ROUTE_MAX_AGE = 30


def allowed_request(role, method, path, query, content_type, raw, headers):
    if (role != 'adapter' or method not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE') or not isinstance(path, str)
            or not path.startswith('/netmap/') or len(path) > 4096 or any(c in path for c in ('%', '\\', '?', '#', '//'))
            or '..' in path.split('/') or not isinstance(query, str) or len(query) > 4096
            or any(ord(c) <= 32 or ord(c) == 127 for c in path + query) or len(raw) > MAX_BODY):
        raise ValueError('Invalid NetMap request')
    allowed = {'X-PL-Gateway-Assertion', 'X-PL-Gateway-Signature', 'X-CSRF-Token', 'Idempotency-Key', 'Accept', 'Cookie', 'Origin', 'Referer', 'X-CSRFToken', 'X-PL-Native-CSRF-Token', 'Accept-Language', 'If-None-Match'}
    names = {name.lower(): name for name in allowed}
    if not isinstance(headers, dict) or any(not isinstance(name, str) or name.lower() not in names for name in headers):
        raise ValueError('Unsupported NetMap gateway headers')
    normalized = {names[name.lower()]: value for name, value in headers.items()}
    if len(normalized) != len(headers) or not {'X-PL-Gateway-Assertion', 'X-PL-Gateway-Signature'} <= set(normalized):
        raise ValueError('NetMap requires a signed gateway request')
    headers = normalized
    if not isinstance(content_type, str) or len(content_type) > 256 or any(ord(c) < 32 or ord(c) > 126 for c in content_type):
        raise ValueError('Invalid NetMap content type')
    if any(not isinstance(v, str) or len(v) > 16384 or any(ord(c) < 32 or ord(c) == 127 for c in v) for v in headers.values()):
        raise ValueError('Invalid NetMap headers')
    if method in ('GET', 'HEAD') and (raw or content_type):
        raise ValueError('Unexpected NetMap read body')
    if method not in ('GET', 'HEAD') and not path.startswith(('/netmap/netbox/', '/netmap/gitea/', '/netmap/oxidized/')) and (query or content_type != 'application/json' or not raw):
        raise ValueError('NetMap mutation requires JSON')
    return dict(headers)


def network_args(root, installation, docker):
    helper = Path(__file__).with_name('module-network.py')
    if helper.is_symlink() or not helper.is_file():
        raise ValueError('Trusted module network allocator unavailable')
    spec = importlib.util.spec_from_file_location('pl_netmap_network', helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.allocation_args(root, installation, docker, prefixlen=28)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class NetMapController:
    def __init__(self, parent):
        self.parent, self.root, self.installation = parent, Path(parent.root), parent.installation
        self.docker = parent.docker
        self.images = self.resolve_images()
        self.version = self.images['adapter']['labels']['org.opencontainers.image.version']
        self.base = self.root / 'modules' / 'netmap'
        directory(self.base)
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        directory(self.instances)
        directory(self.operations)
        self._routes, self._route_lock = {}, threading.RLock()

    def resolve_images(self):
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        state = json.loads(read_file(self.root / 'state/installation.json'))
        bundle = registry.get('netmap')
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or state.get('install_id') != self.installation or registry.get('manifest_sha256') != state.get('manifest_sha256')
                or not re.fullmatch(r'[0-9a-f]{64}', registry.get('manifest_sha256', ''))
                or not isinstance(bundle, dict) or set(bundle) != set(ROLES)):
            raise ValueError('Invalid NetMap installation image contract')
        version = bundle['adapter'].get('labels', {}).get('org.opencontainers.image.version')
        if not isinstance(version, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
            raise ValueError('Invalid NetMap bundle version')
        # Supported upgrades retain the installed PostgreSQL/Valkey images
        # with their original descriptors and pinned upstream versions.
        storage_version = bundle['database'].get('labels', {}).get('org.opencontainers.image.version')
        permitted_storage = {
            '1.1.0': ('1.0.0',), '1.2.0': ('1.0.0', '1.1.0'), '1.2.1': ('1.0.0', '1.1.0', '1.2.0'),
        }
        preserved_storage = (storage_version in permitted_storage.get(version, ())
            and all(image.get('labels', {}).get('org.opencontainers.image.version')
                    == (storage_version if role in ('database', 'cache') else version)
                    for role, image in bundle.items())
            and bundle['database'].get('labels', {}).get('pl.upstream.version') == '18.6'
            and bundle['cache'].get('labels', {}).get('pl.upstream.version') == '9.1'
            and all(image.get('architecture') == bundle['adapter'].get('architecture') for image in bundle.values()))
        for role, image in bundle.items():
            labels = image.get('labels', {})
            if (set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                    or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', '')) or image.get('architecture') not in ('amd64', 'arm64')
                    or image.get('recipe') != 'deploy/images/netmap.Dockerfile' or labels.get('pl.module.id') != 'netmap'
                    or labels.get('pl.module.role') != role or labels.get('pl.module.config.version') != '1'
                    or labels.get('pl.build.variant') != ('source-build' if role == 'adapter' else 'upstream-pinned')
                    or labels.get('org.opencontainers.image.version') != (storage_version if preserved_storage and role in ('database', 'cache') else version)
                    or (role != 'adapter' and (not isinstance(labels.get('pl.upstream.version'), str)
                        or not re.fullmatch(r'[0-9]+\.[0-9]+(?:\.[0-9]+)?', labels['pl.upstream.version'])))):
                raise ValueError('Invalid NetMap component image')
        return bundle

    def verify_image(self, role):
        contract = self.images[role]
        image = json.loads(self.docker('image', 'inspect', contract['id']))[0]
        if (image.get('Id') != contract['id'] or image.get('Os') != 'linux'
                or image.get('Architecture') != contract['architecture']
                or any((image.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in contract['labels'].items())):
            raise ValueError('NetMap image identity mismatch')
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
            raise ValueError('Unsafe NetMap instance lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def name(self, instance, suffix=''):
        return self.installation + '-netmap-' + identifier(instance) + suffix

    def labels(self, instance, role=None):
        labels = {'pl.installation': self.installation, 'pl.module': 'netmap', 'pl.instance': identifier(instance)}
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
        if (set(state) != {'schema', 'installation', 'instance_id', 'origin', 'secrets', 'files', 'ingress_id'}
                or state.get('schema') != 1 or state.get('installation') != self.installation or state.get('instance_id') != instance
                or not isinstance(state.get('files'), dict) or set(state['files']) != set(CONFIG_FILES)
                or not isinstance(state.get('secrets'), dict) or set(state['secrets']) != {'database_password', 'cache_password', 'secret_key', 'token_pepper', 'token_key', 'token', 'admin_password', 'source_password', 'gitea_secret'}
                or any(not isinstance(v, str) or not re.fullmatch(r'[a-f0-9]{12,64}', v) for key, v in state['secrets'].items() if key != 'admin_password')
                or not isinstance(state['secrets'].get('admin_password'), str)
                or not re.fullmatch(r'(?:[A-Za-z0-9]{8}|[a-f0-9]{12,64})', state['secrets']['admin_password'])
                or not re.fullmatch(r'[a-f0-9]{64}', state.get('ingress_id', ''))):
            raise ValueError('Invalid NetMap state')
        installation = json.loads(read_file(self.root / 'state/installation.json'))
        if state['origin'] != installation.get('config', {}).get('public_url', '').rstrip('/'):
            raise ValueError('NetMap origin drift')
        for name, digest in state['files'].items():
            if hashlib.sha256(read_file(base / 'config' / name, mode=0o444)).hexdigest() != digest:
                raise ValueError('NetMap private configuration drift')
        return state

    def ingress(self):
        name = self.installation + '_ingress'
        obj = json.loads(self.docker('network', 'inspect', name))[0]
        if (obj.get('Name') != name or obj.get('Driver') != 'bridge' or obj.get('Ingress')
                or not re.fullmatch(r'[a-f0-9]{64}', obj.get('Id', '')) or obj.get('Internal') or obj.get('Scope') != 'local'
                or (obj.get('Labels') or {}).get('pl.installation') != self.installation
                or (obj.get('Labels') or {}).get('com.docker.compose.network') != 'ingress'
                or (obj.get('Labels') or {}).get('com.docker.compose.project') != self.installation):
            raise ValueError('NetMap Platform ingress identity mismatch')
        return obj

    def config_values(self, instance, state):
        secret = state['secrets']
        url = urllib.parse.urlsplit(state['origin'])
        netbox = {**{key: secret[key] for key in ('database_password', 'cache_password', 'secret_key', 'token_pepper', 'token_key', 'token', 'admin_password')},
                  'origin': state['origin'], 'hostname': url.hostname}
        values = {
            'postgres_password': secret['database_password'].encode(),
            'netbox.json': encoded(netbox),
            'adapter.json': encoded({**{key: secret[key] for key in ('token_key', 'token', 'source_password')}, 'origin': state['origin'], 'platform_origin': state['origin'], 'hostname': url.netloc}),
            'oxidized.json': encoded({'source_password': secret['source_password']}),
            'gateway_key': self.gateway_key(instance),
            'cache.conf': ('bind 0.0.0.0\nprotected-mode yes\nport 6379\nappendonly yes\ndir /data\nrequirepass ' + secret['cache_password'] + '\n').encode(),
            'gitea.ini': ("APP_NAME = PL Configuration History\nRUN_USER = git\nWORK_PATH = /var/lib/gitea\n[database]\nDB_TYPE = sqlite3\nPATH = /var/lib/gitea/data/gitea.db\n[server]\nHTTP_ADDR = 0.0.0.0\nHTTP_PORT = 3000\nDOMAIN = " + url.hostname + "\nROOT_URL = " + state['origin'] + "/netmap/gitea/\nDISABLE_SSH = true\nOFFLINE_MODE = true\n[security]\nINSTALL_LOCK = true\nSECRET_KEY = " + secret['gitea_secret'] + "\n[service]\nDISABLE_REGISTRATION = true\nREQUIRE_SIGNIN_VIEW = true\n[session]\nCOOKIE_NAME = pl_gitea_session\nCOOKIE_SECURE = true\n[actions]\nENABLED = false\n[mailer]\nENABLED = false\n[log]\nMODE = console\nLEVEL = Warn\n").encode(),
        }
        return values

    def initialize(self, instance):
        base = self.paths(instance, create=True)
        journal = base / 'initialization.json'
        if (base / 'state.json').exists() or (base / 'state.json').is_symlink():
            current = self.state(instance)
            if journal.exists() or journal.is_symlink():
                pending = json.loads(read_file(journal))
                if pending != {key: value for key, value in current.items() if key != 'files'}:
                    raise ValueError('NetMap initialization journal drift')
                journal.unlink()
                fsync_directory(base)
            return
        if journal.exists() or journal.is_symlink():
            state = json.loads(read_file(journal))
            if state.get('installation') != self.installation or state.get('instance_id') != instance:
                raise ValueError('Invalid NetMap initialization journal')
        else:
            if list((base / 'config').iterdir()):
                raise ValueError('Unmanaged NetMap configuration')
            origin = json.loads(read_file(self.root / 'state/installation.json')).get('config', {}).get('public_url', '').rstrip('/')
            url = urllib.parse.urlsplit(origin)
            if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path or url.query or url.fragment:
                raise ValueError('Explicit HTTPS Platform origin required')
            keys = ('database_password', 'cache_password', 'secret_key', 'token_pepper', 'token', 'source_password', 'gitea_secret')
            state = {'schema': 1, 'installation': self.installation, 'instance_id': instance, 'origin': origin,
                     'secrets': {key: secrets.token_hex(32) for key in keys}, 'ingress_id': self.ingress()['Id']}
            state['secrets']['token_key'] = secrets.token_hex(6)
            state['secrets']['admin_password'] = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8))
            atomic(journal, state)
        values = self.config_values(instance, state)
        if set(p.name for p in (base / 'config').iterdir()) - set(CONFIG_FILES):
            raise ValueError('Unknown NetMap configuration files')
        for name, value in values.items():
            path = base / 'config' / name
            if path.exists() or path.is_symlink():
                if read_file(path, mode=0o444) != value:
                    raise ValueError('NetMap initialization drift')
            else:
                atomic(path, value, mode=0o444)
        state['files'] = {name: hashlib.sha256(value).hexdigest() for name, value in values.items()}
        atomic(base / 'state.json', state)
        journal.unlink()
        fsync_directory(base)
        self.state(instance)

    def gateway_key(self, instance):
        master = read_file(self.root / 'private/module-controller-key', mode=0o640)
        if len(master) != 32:
            raise ValueError('Invalid module controller key')
        return hmac.digest(master, ('pl-module-key-v1\nnetmap\n' + instance).encode(), 'sha256')

    def resource(self, instance, kind, volume='database'):
        suffix = '-net' if kind == 'network' else '-' + volume + '-data'
        if kind not in ('network', 'volume') or volume not in VOLUMES:
            raise ValueError('Invalid NetMap resource role')
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
            raise ValueError('NetMap resource ownership mismatch')
        return obj

    def create_resource(self, instance, kind, volume='database'):
        if self.resource(instance, kind, volume) is None:
            args = [kind, 'create']
            if kind == 'network':
                args += ['--driver', 'bridge'] + network_args(self.root, self.installation, self.docker)
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, self.name(instance, '-net' if kind == 'network' else '-' + volume + '-data'))
        if self.resource(instance, kind, volume) is None:
            raise ValueError('NetMap resource creation unconfirmed')

    def specification(self, instance, role):
        state = self.state(instance)
        config = self.paths(instance) / 'config'
        env = {}
        volume_mounts = {
            'database': [('database', '/var/lib/postgresql')], 'cache': [('cache', '/data')],
            'netbox': [('media', '/opt/netbox/netbox/media')], 'netbox-worker': [('media', '/opt/netbox/netbox/media')],
            'gitea': [('gitea', '/var/lib/gitea')], 'adapter': [('adapter', '/data')],
            'oxidized': [('oxidized', '/home/oxidized/.config/oxidized')],
        }
        names = {'database': ('postgres_password',), 'cache': ('cache.conf',), 'netbox': ('netbox.json',),
                 'netbox-worker': ('netbox.json',), 'gitea': ('gitea.ini',), 'adapter': ('adapter.json', 'gateway_key'), 'oxidized': ('oxidized.json',)}
        mounts = [('volume', self.name(instance, '-' + name + '-data'), target, True) for name, target in volume_mounts[role]]
        mounts += [('bind', str(config / name), '/run/secrets/' + name, False) for name in names[role]]
        if role == 'database':
            env = {'POSTGRES_DB': 'netbox', 'POSTGRES_USER': 'netbox', 'POSTGRES_PASSWORD_FILE': '/run/secrets/postgres_password', 'PGDATA': '/var/lib/postgresql/18/docker'}
        elif role in ('netbox', 'netbox-worker'):
            env = {'SKIP_SUPERUSER': 'true', 'CENSUS_REPORTING_ENABLED': 'false', 'GRANIAN_WORKERS': '2'}
        elif role == 'adapter':
            mounts += [('volume', self.name(instance, '-gitea-data'), '/gitea-data', False)]
        tmpfs = {'/tmp': 'rw,noexec,nosuid,size=134217728,mode=1777'}
        if role == 'database':
            tmpfs['/var/run/postgresql'] = 'rw,noexec,nosuid,size=16777216,uid=70,gid=70,mode=3775'
        elif role == 'gitea':
            # The upstream image declares /etc/gitea as VOLUME. Configuration
            # lives in the owned /var/lib/gitea mount; explicitly cover the
            # unused path so Docker cannot create an unowned anonymous volume.
            tmpfs['/etc/gitea'] = 'rw,noexec,nosuid,nodev,size=1048576,uid=1000,gid=1000,mode=0750'
        user = {'database': 'postgres', 'cache': 'valkey', 'netbox': '999:0', 'netbox-worker': '999:0',
                'gitea': '1000:1000', 'adapter': '10001:10001', 'oxidized': '30000:30000'}[role]
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
        port_ok = not ports and not any(obj.get('NetworkSettings', {}).get('Ports', {}).values())
        if (not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', '')) or obj.get('Image') != self.images[role]['id']
                or config.get('Image') != self.images[role]['id'] or mounts != set(expected_mounts)
                or actual_env_map != expected_env or len(actual_env) != len(actual_env_map) or config.get('User', '') != user
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.labels(instance, role).items())
                or any(config.get(k) != image.get('Config', {}).get(k) for k in ('Entrypoint', 'Cmd', 'WorkingDir'))
                or not port_ok or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapDrop') != ['ALL']
                or host.get('CapAdd') or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts')
                or host.get('NetworkMode') != self.name(instance, '-net')
                or set(obj.get('NetworkSettings', {}).get('Networks', {})) != ({self.name(instance, '-net'), self.installation + '_ingress'} if role == 'adapter' else {self.name(instance, '-net')})
                or host.get('Memory') != MEMORY[role] * 1024**2 or host.get('NanoCpus') != 1_000_000_000
                or host.get('PidsLimit') != 256 or not host.get('Init') or host.get('Tmpfs') != tmpfs
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('PidMode') not in (None, '') or host.get('IpcMode') not in (None, 'private')
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])):
            raise ValueError('NetMap container drift; manual inspection required')
        network = self.resource(instance, 'network')
        if network is None or any(self.resource(instance, 'volume', volume) is None for volume in VOLUMES):
            raise ValueError('NetMap managed resources missing')
        if any(member.get('Name') not in {self.name(instance, '-' + item) for item in ROLES} for member in network.get('Containers', {}).values()):
            raise ValueError('Foreign container attached to NetMap network')
        if role == 'adapter':
            ingress = self.ingress()
            if ingress['Id'] != self.state(instance)['ingress_id']:
                raise ValueError('NetMap ingress identity drift')
            never_started = (obj.get('State', {}).get('Status') == 'created'
                             and obj['State'].get('Running') is False
                             and obj['State'].get('StartedAt') in (None, '', '0001-01-01T00:00:00Z'))
            for name, expected_id, alias in ((self.name(instance, '-net'), network['Id'], 'adapter'),
                                             (self.installation + '_ingress', ingress['Id'], 'pl-netmap-' + instance)):
                connection = obj['NetworkSettings']['Networks'][name]
                # Docker may expose only configured names/aliases until the
                # first start materializes endpoints. Never admit a wrong ID,
                # allocated address or this pending form on a running/stopped
                # container. Full runtime identity is checked after start.
                ipam = connection.get('IPAMConfig')
                unallocated_ipam = ipam is None or (type(ipam) is dict and ipam in
                    ({}, {'IPv4Address': '', 'IPv6Address': ''}))
                pending = (never_started and unallocated_ipam
                           and all(connection.get(key) in (None, '') for key in
                                   ('NetworkID', 'EndpointID', 'IPAddress', 'GlobalIPv6Address', 'Gateway', 'IPv6Gateway')))
                if alias not in (connection.get('Aliases') or []) or (connection.get('NetworkID') != expected_id and not pending):
                    raise ValueError('NetMap ingress identity drift')
        return obj

    def create_container(self, instance, role):
        self.verify_image(role)
        env, mounts, user, tmpfs = self.specification(instance, role)
        args = ['container', 'create', '--name', self.name(instance, '-' + role), '--network', self.name(instance, '-net'),
                '--network-alias', role, '--restart', 'unless-stopped', '--init', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory', str(MEMORY[role]) + 'm', '--cpus', '1', '--pids-limit', '256',
                '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2']
        if user:
            args += ['--user', user]
        for path, options in tmpfs.items():
            args += ['--tmpfs', path + ':' + options]
        for key, value in env.items():
            args += ['--env', key + '=' + value]
        for kind, source, target, writable in mounts:
            args += ['--mount', 'type=' + kind + ',source=' + source + ',target=' + target + ('' if writable else ',readonly')]
        for key, value in self.labels(instance, role).items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.images[role]['id'])
        if role == 'adapter':
            self.docker('network', 'connect', '--alias', 'pl-netmap-' + instance, self.installation + '_ingress', self.name(instance, '-' + role))
        if self.inspect(instance, role) is None:
            raise ValueError('NetMap container creation unconfirmed')

    def endpoint(self, obj):
        instance = (obj.get('Config', {}).get('Labels') or {}).get('pl.instance')
        return 'http://pl-netmap-' + identifier(instance) + ':8092'

    def http(self, instance, obj, method, path, raw=b'', headers=None):
        network = obj.get('NetworkSettings', {}).get('Networks', {}).get(self.name(instance, '-net'), {})
        address = network.get('IPAddress', '')
        import ipaddress
        ipaddress.ip_address(address)
        request = urllib.request.Request('http://' + address + ':8092' + path, data=raw if raw else None, method=method,
                                        headers={**(headers or {}), 'Accept-Encoding': 'identity'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            response = opener.open(request, timeout=180)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise ValueError('NetMap response exceeds limit')
            safe = {'set-cookie', 'location', 'cache-control', 'etag', 'last-modified', 'content-disposition', 'vary'}
            headers_out = [{'name': name, 'value': value} for name, value in response.headers.items() if name.lower() in safe and len(value) <= 8192 and not any(ord(c) < 32 or ord(c) == 127 for c in value)]
            return response.status, response.headers.get('Content-Type', 'application/octet-stream'), data, headers_out

    def local_route(self, instance):
        """Verify local routing ownership without native application probes.

        Lifecycle observation owns schema/bootstrap readiness. A cold browser
        route verifies only persisted config and the actual adapter/network.
        """
        self.state(instance)
        obj = self.inspect(instance, 'adapter')
        if not obj or not obj.get('State', {}).get('Running'):
            raise ValueError('NetMap adapter is stopped')
        network = self.resource(instance, 'network')
        connection = obj.get('NetworkSettings', {}).get('Networks', {}).get(self.name(instance, '-net'), {})
        if network is None or connection.get('NetworkID') != network.get('Id'):
            raise ValueError('NetMap private network identity drift')
        import ipaddress
        address = ipaddress.ip_address(connection.get('IPAddress', ''))
        configs = network.get('IPAM', {}).get('Config', [])
        if len(configs) != 1:
            raise ValueError('NetMap private network addressing drift')
        subnet = ipaddress.ip_network(configs[0].get('Subnet', ''), strict=True)
        if (address.version != 4 or address not in subnet or address in (subnet.network_address, subnet.broadcast_address)
                or str(address) == configs[0].get('Gateway')):
            raise ValueError('NetMap adapter address outside owned network')
        self.endpoint(obj)
        # Retain no Docker Env, native credentials or schema observations.
        route = {'Id': obj['Id'], 'Config': {'Labels': self.labels(instance, 'adapter')},
                 'NetworkSettings': {'Networks': obj['NetworkSettings']['Networks']}}
        self._routes[instance] = (time.monotonic(), route)
        return route

    def ready(self, instance):
        objects = {role: self.inspect(instance, role) for role in ROLES}
        if any(not obj or not obj.get('State', {}).get('Running') for obj in objects.values()):
            raise ValueError('NetMap components are stopped')
        status, mime, raw, _ = self.http(instance, objects['adapter'], 'GET', '/healthz')
        payload = json.loads(raw)
        expected = {'status': 'ready', 'version': self.version}
        if isinstance(payload, dict) and set(payload) == {'status', 'version', 'collector'}:
            collector = payload['collector']
            if (not isinstance(collector, dict) or set(collector) != {'state', 'targets'}
                    or type(collector['targets']) is not int
                    or not ((collector['state'] == 'waiting_targets' and collector['targets'] == 0)
                            or (collector['state'] == 'ready' and collector['targets'] > 0))):
                raise ValueError('NetMap collector readiness unconfirmed')
            payload = {key: payload[key] for key in expected}
        if status != 200 or payload != expected:
            raise ValueError('NetMap bootstrap readiness unconfirmed')
        obj = objects['adapter']
        self.local_route(instance)
        return obj

    def ensure(self, instance):
        self._routes.pop(instance, None)
        self.initialize(instance)
        self.create_resource(instance, 'network')
        for volume in VOLUMES:
            self.create_resource(instance, 'volume', volume)
        for role in ROLES:
            obj = self.inspect(instance, role)
            if obj is None:
                self.create_container(instance, role)
                obj = self.inspect(instance, role)
            if not obj.get('State', {}).get('Running'):
                self.docker('container', 'start', obj['Id'])
                self.inspect(instance, role)
        # NetBox's first schema migration exceeded ten minutes under the
        # declared one-CPU limit. Keep install/enable pending until readiness,
        # with a finite budget below the host RPC and durable job deadlines.
        deadline = time.monotonic() + 1200
        while True:
            try:
                self.ready(instance)
                return
            except (ValueError, OSError):
                if time.monotonic() >= deadline:
                    raise ValueError('NetMap readiness unconfirmed') from None
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
            if any(self.resource(instance, kind, volume) for kind, volume in (('network', 'database'), *(('volume', volume) for volume in VOLUMES))) or any(self.inspect(instance, role) for role in ROLES):
                raise ValueError('NetMap artifacts have no managed state')
            return {'state': 'absent', 'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        self.state(instance)
        objects = [self.inspect(instance, role) for role in ROLES]
        if any(obj is None for obj in objects):
            raise ValueError('NetMap components incomplete')
        running = [bool(obj.get('State', {}).get('Running')) for obj in objects]
        if any(running) and not all(running):
            raise ValueError('NetMap components have mixed state')
        result = {'state': 'disabled', 'version': self.version, 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        if all(running):
            result.update(state='running', endpoint=self.endpoint(self.ready(instance)))
        return result

    def remove(self, instance):
        self._routes.pop(instance, None)
        base = self.instances / identifier(instance)
        marker = self.operations / ('remove-' + instance + '.json')
        if (base / 'initialization.json').exists() and not (base / 'state.json').exists():
            self.initialize(instance)
        expected = {'state.json': 0o600, **{'config/' + name: 0o444 for name in CONFIG_FILES}}
        if not base.exists() and not base.is_symlink():
            self.observe(instance)
            if marker.exists() or marker.is_symlink():
                value = json.loads(read_file(marker))
                if value.get('installation') != self.installation or value.get('instance_id') != instance:
                    raise ValueError('Invalid NetMap removal journal')
                marker.unlink()
                fsync_directory(self.operations)
            return
        if not marker.exists() and not marker.is_symlink():
            self.state(instance)
            if set(p.name for p in base.iterdir()) != {'state.json', 'config'} or set(p.name for p in (base / 'config').iterdir()) != set(CONFIG_FILES):
                raise ValueError('Unknown NetMap removal files')
            objects = [self.inspect(instance, role) for role in ROLES]
            network = self.resource(instance, 'network')
            for volume in VOLUMES:
                self.resource(instance, 'volume', volume)
            owned_ids = {obj['Id'] for obj in objects if obj}
            if network and set(network.get('Containers', {})) - owned_ids:
                raise ValueError('Foreign container attached to NetMap network')
            files = {name: hashlib.sha256(read_file(base / name, mode=mode)).hexdigest() for name, mode in expected.items()}
            atomic(marker, {'installation': self.installation, 'instance_id': instance, 'files': files})
        journal = json.loads(read_file(marker))
        if (set(journal) != {'installation', 'instance_id', 'files'} or journal['installation'] != self.installation
                or journal['instance_id'] != instance or not isinstance(journal['files'], dict)
                or set(journal['files']) != set(expected)
                or any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v) for v in journal['files'].values())):
            raise ValueError('Invalid NetMap removal journal')
        directory(base, create=False)
        if set(p.name for p in base.iterdir()) - {'state.json', 'config'}:
            raise ValueError('Unknown NetMap removal artifacts')
        config = base / 'config'
        if config.exists() or config.is_symlink():
            directory(config, create=False, mode=0o755)
            if set(p.name for p in config.iterdir()) - set(CONFIG_FILES):
                raise ValueError('Unknown NetMap removal configuration')
        for name, mode in expected.items():
            path = base / name
            if (path.exists() or path.is_symlink()) and hashlib.sha256(read_file(path, mode=mode)).hexdigest() != journal['files'][name]:
                raise ValueError('NetMap removal artifact changed')
        objects = [self.inspect(instance, role) for role in ROLES]
        network = self.resource(instance, 'network')
        owned_ids = {obj['Id'] for obj in objects if obj}
        if network and set(network.get('Containers', {})) - owned_ids:
            raise ValueError('Foreign container attached to NetMap network')
        for obj in reversed(objects):
            if obj:
                if obj.get('State', {}).get('Running'):
                    self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                self.docker('container', 'rm', obj['Id'])
        for kind, volume in (*(('volume', volume) for volume in reversed(VOLUMES)), ('network', 'database')):
            if self.resource(instance, kind, volume):
                self.docker(kind, 'rm', self.name(instance, '-net' if kind == 'network' else '-' + volume + '-data'))
            if self.resource(instance, kind, volume):
                raise ValueError('NetMap resource removal unconfirmed')
        # Journal authenticates remaining files after an interrupted unlink.
        for name in [*('config/' + key for key in CONFIG_FILES), 'state.json']:
            (base / name).unlink(missing_ok=True)
        if config.exists():
            config.rmdir()
        base.rmdir()
        fsync_directory(self.instances)
        marker.unlink()
        fsync_directory(self.operations)

    def execute(self, body):
        if (not isinstance(body, dict) or set(body) - {'operation_id', 'instance_id', 'module_id', 'action', 'public_url'} or not {'operation_id', 'instance_id', 'module_id', 'action'} <= set(body)
                or body.get('module_id') != 'netmap' or body.get('action') not in ('install', 'enable', 'disable', 'refresh', 'remove')):
            raise ValueError('Unsupported NetMap operation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        configured_origin = json.loads(read_file(self.root / 'state/installation.json')).get('config', {}).get('public_url')
        if 'public_url' in body and body['public_url'] != configured_origin:
            raise ValueError('NetMap operation origin mismatch')
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
                    raise ValueError('NetMap operation ID conflict')
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
                        'error': _files.module_network_error(error, 'NetMap operation unconfirmed; reconcile the same operation'), 'operation_id': operation}

    def get(self, instance):
        instance = identifier(instance)
        with self.instance_lock(instance):
            return self.observe(instance)

    def initial_login(self, body):
        if (not isinstance(body, dict) or set(body) != {'instance_id', 'module_id', 'service'}
                or body.get('module_id') != 'netmap' or body.get('service') not in ('netbox', 'gitea')):
            raise ValueError('Invalid NetMap initial login request')
        instance = identifier(body['instance_id'])
        service = body['service']
        with self.instance_lock(instance):
            state = self.state(instance)
            obj = self.inspect(instance, service)
            if not obj or not obj.get('State', {}).get('Running'):
                raise ValueError('Native initial login unavailable')
            if service == 'netbox':
                password, path = state['secrets']['admin_password'], '/netmap/netbox/login/'
            else:
                volume = self.resource(instance, 'volume', 'gitea')
                if not volume:
                    raise ValueError('Native initial login unavailable')
                password = self.gitea_initial_password(volume.get('Mountpoint'))
                path = '/netmap/gitea/user/login'
            return {'instance_id': instance, 'module_id': 'netmap', 'service': service,
                    'username': 'pl-admin', 'password': password, 'path': path}

    @staticmethod
    def gitea_initial_password(mountpoint):
        # The owned volume is verified before this read. Walk only this fixed
        # native bootstrap file; never inspect the collector/token receipt.
        if not isinstance(mountpoint, str) or not mountpoint.startswith('/'):
            raise ValueError('Native initial login unavailable')
        base = Path(mountpoint)
        if '..' in base.parts or base.resolve(strict=True) != base:
            raise ValueError('Native initial login unavailable')
        root_fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            directory_fd = os.open('pl-bootstrap', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            try:
                info = os.fstat(directory_fd)
                if info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o755:
                    raise ValueError('Native initial login unavailable')
                fd = os.open('admin', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o444 or info.st_nlink != 1 or not 1 <= info.st_size <= 4096:
                        raise ValueError('Native initial login unavailable')
                    raw = os.read(fd, 4097)
                    if len(raw) > 4096:
                        raise ValueError('Native initial login unavailable')
                finally:
                    os.close(fd)
            finally:
                os.close(directory_fd)
        finally:
            os.close(root_fd)
        # Exact v28.2 CLI markers, not a generic secret/log scraper. A receipt
        # with token output or another username is never an administrator login.
        try:
            lines = raw.decode('utf-8').splitlines()
        except UnicodeDecodeError:
            raise ValueError('Native initial login unavailable') from None
        matches = [re.fullmatch(r"generated random password is '([A-Za-z0-9]{8}|[!-~]{40})'", line) for line in lines]
        passwords = [match.group(1) for match in matches if match]
        if (len(passwords) != 1 or lines.count("New user 'pl-admin' has been successfully created!") != 1
                or any('Access token' in line or "New user '" in line and line != "New user 'pl-admin' has been successfully created!" for line in lines)):
            raise ValueError('Native initial login unavailable')
        return passwords[0]

    def manifest(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id'}:
            raise ValueError('Invalid NetMap manifest request')
        self.get(identifier(body['instance_id']))
        return {'version': 'pl-netmap-' + self.version, 'routes': [
            {'method': 'GET', 'path': '/netmap/', 'kind': 'asset'},
            *({'method': 'GET', 'path': '/netmap/' + name, 'kind': 'asset'} for name in ('app.js', 'style.css', 'theme-init.js', 'office-view.js', 'config.js')),
            *({'method': 'GET', 'path': '/netmap/api/' + name, 'kind': 'api'} for name in ('topology', 'health', 'sites/network', 'networks', 'profiles', 'polls'))]}

    def request(self, body):
        fields = {'instance_id', 'method', 'path', 'query', 'content_type', 'body', 'headers'}
        if not isinstance(body, dict) or set(body) != fields:
            raise ValueError('Invalid NetMap request')
        import base64
        if not isinstance(body['body'], str) or len(body['body']) > 4 * ((MAX_BODY + 2) // 3):
            raise ValueError('NetMap body exceeds limit')
        raw = base64.b64decode(body['body'], validate=True)
        headers = allowed_request('adapter', body['method'], body['path'], body['query'], body['content_type'], raw, body['headers'])
        if body['content_type']:
            headers['Content-Type'] = body['content_type']
        instance = identifier(body['instance_id'])
        with self.instance_lock(instance):
            route = self._routes.get(instance)
            if route is None or not 0 <= time.monotonic() - route[0] < ROUTE_MAX_AGE:
                with self._route_lock:
                    route = self._routes.get(instance)
                    if route is None or not 0 <= time.monotonic() - route[0] < ROUTE_MAX_AGE:
                        self.local_route(instance)
                        route = self._routes[instance]
            obj = route[1]
            try:
                status, mime, data, headers_out = self.http(instance, obj, body['method'], body['path'] + ('?' + body['query'] if body['query'] else ''), raw, headers)
            except Exception:
                self._routes.pop(instance, None)
                raise
        return {'instance_id': instance, 'status': status, 'content_type': mime, 'body': base64.b64encode(data).decode(), 'headers': headers_out}
