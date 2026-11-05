#!/usr/bin/env python3
"""Independent owned NetMap deployment; local Linux Docker and explicit TLS ingress."""
from __future__ import annotations

import argparse
import base64
import copy
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import ssl
import stat
import string
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('netmap_standalone_base', BASE / 'netmap-controller.py')
nm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(nm)

PACKAGE_FILES = {'netmap-standalone.py', 'netmap-controller.py', 'xray-controller.py',
                 'netmap-standalone/nginx.conf.example', 'README.ru.md', 'LICENSES.txt', 'images.tar'}
SECRET_NAMES = {'database_password', 'cache_password', 'secret_key', 'token_pepper',
                'token_key', 'token', 'admin_password', 'source_password', 'gitea_secret'}
PRIVATE = tuple(ipaddress.IPv4Network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def canonical_path(path):
    path = Path(path).absolute()
    if (path == Path('/') or path.resolve() != path
            or any(ord(c) < 32 for c in str(path)) or ',' in str(path)):
        raise ValueError('Explicit canonical path without symlinks required')
    return path


def origin(value):
    if not isinstance(value, str) or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ValueError('Explicit HTTPS origin required')
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or parsed.port is not None and not 1 <= parsed.port <= 65535
            or parsed.netloc.endswith(':') or '%' in parsed.netloc or '\\' in value):
        raise ValueError('Explicit HTTPS origin without a path required')
    host = parsed.hostname
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if (len(host) > 253 or any(not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', part)
                                   for part in host.split('.'))):
            raise ValueError('Invalid HTTPS hostname') from None
    authority = '[' + host.lower() + ']' if ':' in host else host.lower()
    return 'https://' + authority + (':' + str(parsed.port) if parsed.port not in (None, 443) else '')


def subnet(value):
    network = ipaddress.IPv4Network(value, strict=True)
    if str(network) != value or network.prefixlen != 28 or not any(network.subnet_of(parent) for parent in PRIVATE):
        raise ValueError('Explicit unused canonical RFC1918 IPv4 /28 required')
    return network


def validate_manifest(value):
    if (not isinstance(value, dict) or set(value) != {'schema', 'product', 'version', 'architecture',
            'canonical_sha256', 'source_sha256', 'images', 'files'} or value.get('schema') != 1
            or value.get('product') != 'PL NetMap Standalone'
            or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value.get('version', ''))
            or value.get('architecture') not in ('amd64', 'arm64')
            or any(not re.fullmatch(r'[0-9a-f]{64}', value.get(key, '')) for key in ('canonical_sha256', 'source_sha256'))
            or not isinstance(value.get('files'), dict) or set(value['files']) != PACKAGE_FILES
            or any(not isinstance(item, str) or not re.fullmatch(r'[0-9a-f]{64}', item) for item in value['files'].values())
            or not isinstance(value.get('images'), dict) or set(value['images']) != set(nm.ROLES)):
        raise ValueError('Invalid standalone NetMap package manifest')
    for role, image in value['images'].items():
        labels = image.get('labels', {}) if isinstance(image, dict) else {}
        required = {'id', 'architecture', 'ref', 'recipe', 'labels'}
        if (not isinstance(image, dict) or set(image) not in (required, required | {'config_id'})
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                or 'config_id' in image and (not isinstance(image['config_id'], str)
                    or not re.fullmatch(r'sha256:[0-9a-f]{64}', image['config_id']))
                or image.get('architecture') != value['architecture']
                or image.get('recipe') != 'deploy/images/netmap.Dockerfile' or not isinstance(labels, dict)
                or labels.get('pl.source.sha256') != value['source_sha256']
                or labels.get('pl.module.id') != 'netmap' or labels.get('pl.module.role') != role
                or labels.get('pl.module.config.version') != '1'
                or labels.get('org.opencontainers.image.version') != value['version']
                or labels.get('pl.build.variant') != ('source-build' if role == 'adapter' else 'upstream-pinned')
                or role != 'adapter' and not re.fullmatch(r'[0-9]+\.[0-9]+(?:\.[0-9]+)?', labels.get('pl.upstream.version', ''))):
            raise ValueError('Invalid standalone NetMap image identity')
    if len({image['id'] for image in value['images'].values()}) != len(nm.ROLES):
        raise ValueError('NetMap roles require independent image identities')
    return value


def load_package(package, *, images=False):
    package = canonical_path(package)
    manifest = package / 'manifest.json'
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 65536:
        raise ValueError('Standalone package manifest unavailable')
    value = validate_manifest(json.loads(manifest.read_bytes()))
    for name, expected in value['files'].items():
        path = package / name
        if path.resolve() != path or not path.is_file() or path.is_symlink():
            raise ValueError('Unsafe standalone package member')
        if (images or name != 'images.tar') and digest(path) != expected:
            raise ValueError('Standalone package checksum mismatch')
    return value, digest(manifest)


def validate_image_archive(path, images):
    """Verify exactly seven config IDs or OCI platform-manifest identities.

    containerd Docker-save archives preserve the original OCI manifest bytes.
    The platform-manifest digest, not the config digest, is their inspect Id.
    Return role -> verified config ID without changing the canonical image IDs.
    """
    if (not isinstance(images, dict) or set(images) != set(nm.ROLES)
            or any(not isinstance(image, dict) or not isinstance(image.get('id'), str)
                   or not re.fullmatch(r'sha256:[0-9a-f]{64}', image['id']) for image in images.values())
            or len({image['id'] for image in images.values()}) != len(nm.ROLES)):
        raise ValueError('Invalid standalone Docker image identities')
    wanted = {image['id']: role for role, image in images.items()}

    def checked(configs):
        if any('config_id' in image and image['config_id'] != configs[role] for role, image in images.items()):
            raise ValueError('Standalone Docker config identity binding mismatch')
        return configs

    with tarfile.open(path, mode='r:') as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if (len(names) > 4096 or len(names) != len(set(names)) or any(
                Path(name).is_absolute() or '..' in Path(name).parts
                or not (member.isfile() or member.isdir()) for name, member in zip(names, members))):
            raise ValueError('Unsafe standalone Docker archive')
        files = {member.name: member for member in members if member.isfile()}
        hashes = {}

        def member(name, maximum=None):
            value = files.get(name) if isinstance(name, str) else None
            if value is None or value.size < 0 or maximum is not None and value.size > maximum:
                raise ValueError('Invalid standalone Docker member')
            return value

        def document(name, maximum=1024 * 1024):
            value = member(name, maximum)
            with archive.extractfile(value) as stream:
                raw = stream.read(maximum + 1)
            if len(raw) != value.size:
                raise ValueError('Invalid standalone Docker metadata size')
            observed = 'sha256:' + hashlib.sha256(raw).hexdigest()
            if name in hashes and hashes[name] != observed:
                raise ValueError('Standalone OCI blob changed during validation')
            hashes[name] = observed
            try:
                return json.loads(raw, object_pairs_hook=unique_members)
            except (ValueError, UnicodeError):
                raise ValueError('Invalid standalone Docker metadata') from None

        def unique_members(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError('Duplicate standalone Docker metadata field')
                value[key] = item
            return value

        def blob(descriptor, media_types):
            if (not isinstance(descriptor, dict) or set(descriptor) - {'mediaType', 'digest', 'size', 'platform', 'annotations', 'urls', 'data'}
                    or descriptor.get('mediaType') not in media_types
                    or not isinstance(descriptor.get('digest'), str)
                    or not re.fullmatch(r'sha256:[0-9a-f]{64}', descriptor['digest'])
                    or type(descriptor.get('size')) is not int or descriptor['size'] < 0
                    or descriptor.get('urls') or descriptor.get('data')):
                raise ValueError('Invalid standalone OCI descriptor')
            name = 'blobs/sha256/' + descriptor['digest'][7:]
            value = member(name)
            if value.size != descriptor['size']:
                raise ValueError('Standalone OCI blob size mismatch')
            if name not in hashes:
                result = hashlib.sha256()
                with archive.extractfile(value) as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        result.update(block)
                hashes[name] = 'sha256:' + result.hexdigest()
            if hashes[name] != descriptor['digest']:
                raise ValueError('Standalone OCI blob digest mismatch')
            return name

        manifest = document('manifest.json', 65536)
        if not isinstance(manifest, list) or len(manifest) != len(nm.ROLES):
            raise ValueError('Standalone Docker archive contains unexpected images')
        identities = []
        for item in manifest:
            if (not isinstance(item, dict) or set(item) - {'Config', 'RepoTags', 'Layers', 'LayerSources', 'Parent'}
                    or not isinstance(item.get('Config'), str)
                    or not isinstance(item.get('Layers', []), list)
                    or any(not isinstance(name, str) for name in item.get('Layers', []))):
                raise ValueError('Invalid standalone Docker config')
            document(item['Config'])
            for layer in item.get('Layers', []):
                member(layer)
            identities.append(hashes[item['Config']])
        if len(set(identities)) != len(nm.ROLES):
            raise ValueError('Standalone Docker image identities mismatch')
        oci = {'index.json', 'oci-layout'} & set(files)
        if not oci:
            if set(identities) != set(wanted):
                raise ValueError('Standalone Docker image identities mismatch')
            return checked({role: image['id'] for role, image in images.items()})
        if oci != {'index.json', 'oci-layout'} or document('oci-layout') != {'imageLayoutVersion': '1.0.0'}:
            raise ValueError('Invalid standalone OCI layout')
        index = document('index.json')
        manifest_types = {'application/vnd.oci.image.manifest.v1+json',
                          'application/vnd.docker.distribution.manifest.v2+json'}
        config_types = {'application/vnd.oci.image.config.v1+json',
                        'application/vnd.docker.container.image.v1+json'}
        layer_types = {'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
                       'application/vnd.oci.image.layer.v1.tar+zstd', 'application/vnd.docker.image.rootfs.diff.tar.gzip'}
        if (not isinstance(index, dict) or set(index) - {'schemaVersion', 'mediaType', 'manifests', 'annotations'}
                or type(index.get('schemaVersion')) is not int or index['schemaVersion'] != 2
                or index.get('mediaType', 'application/vnd.oci.image.index.v1+json') != 'application/vnd.oci.image.index.v1+json'
                or not isinstance(index.get('manifests'), list) or len(index['manifests']) != len(nm.ROLES)
                or any(not isinstance(item, dict) or not isinstance(item.get('digest'), str) for item in index['manifests'])
                or {item.get('digest') for item in index['manifests']} != set(wanted)):
            raise ValueError('Standalone OCI archive contains unexpected images')
        expected_files = {'manifest.json', 'index.json', 'oci-layout'}
        matched = set()
        configs = {}
        for descriptor in index['manifests']:
            selected = images[wanted[descriptor['digest']]]
            platform_info = descriptor.get('platform')
            if platform_info is not None and (not isinstance(platform_info, dict)
                    or platform_info.get('architecture') != selected['architecture'] or platform_info.get('os') != 'linux'):
                raise ValueError('Standalone OCI platform mismatch')
            name = blob(descriptor, manifest_types)
            image = document(name)
            if (not isinstance(image, dict) or set(image) - {'schemaVersion', 'mediaType', 'config', 'layers', 'annotations'}
                    or type(image.get('schemaVersion')) is not int or image['schemaVersion'] != 2
                    or image.get('mediaType', descriptor['mediaType']) != descriptor['mediaType']
                    or not isinstance(image.get('layers'), list) or len(image['layers']) > 256):
                raise ValueError('Invalid standalone OCI platform manifest')
            config = blob(image.get('config'), config_types)
            layers = [blob(layer, layer_types) for layer in image['layers']]
            rows = [index for index, row in enumerate(manifest)
                    if row['Config'] == config and row.get('Layers', []) == layers]
            if (len(rows) != 1 or rows[0] in matched
                    or manifest[rows[0]].get('LayerSources') not in (None, {})
                    or manifest[rows[0]].get('Parent') not in (None, '')):
                raise ValueError('Standalone OCI and Docker manifest bindings mismatch')
            matched.add(rows[0])
            expected_files.update([name, config, *layers])
            configs[wanted[descriptor['digest']]] = image['config']['digest']
        if set(files) != expected_files or len(matched) != len(nm.ROLES):
            raise ValueError('Standalone OCI archive contains unadvertised content')
        return checked(configs)


class ImageNotFound(ValueError):
    """Only the exact local Docker inspect not-found response permits fallback."""


def docker_at(root):
    environment = {key: value for key, value in os.environ.items() if not key.startswith(('DOCKER_', 'COMPOSE_'))}

    def docker(*args, timeout=180):
        result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *args], cwd=root,
                                env=environment, capture_output=True, timeout=timeout, check=False)
        if result.returncode:
            if (len(args) == 3 and args[:2] == ('image', 'inspect')
                    and re.fullmatch(r'sha256:[0-9a-f]{64}', args[2]) and result.returncode == 1
                    and isinstance(result.stdout, bytes) and result.stdout.strip() == b'[]'
                    and isinstance(result.stderr, bytes) and result.stderr.strip() in (
                        b'Error response from daemon: No such image: ' + args[2].encode(),
                        b'Error: No such image: ' + args[2].encode())):
                raise ImageNotFound('Pinned standalone Docker image is absent')
            raise ValueError('Local Docker operation failed; private deployment remains for inspection')
        return result.stdout
    return docker


@contextmanager
def deployment_lock(root):
    descriptor = os.open(root / 'standalone.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or not stat.S_ISREG(info.st_mode):
            raise ValueError('Unsafe standalone deployment lock')
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


class Standalone(nm.NetMapController):
    """Reuse native mounts/bootstrap/readiness and removal journal, without PL state."""

    def __init__(self, root, manifest, package_sha256, settings, docker=None):
        self.root, self.settings, self.package_sha256 = Path(root), settings, package_sha256
        self.instance = nm.identifier(settings['instance_id'])
        self.installation = 'nm-' + settings['owner']
        self._image_contracts = copy.deepcopy(manifest['images'])
        self.images, self.version = copy.deepcopy(self._image_contracts), manifest['version']
        self.docker = docker or docker_at(self.root)
        self.base = self.root / 'modules/netmap'
        for path in (self.root / 'modules', self.base):
            nm.directory(path)
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        nm.directory(self.instances)
        nm.directory(self.operations)
        self._routes, self._route_lock = {}, threading.RLock()

    def verify_image(self, role):
        contract = self._image_contracts[role]
        identities = [contract['id']]
        if contract.get('config_id') and contract['config_id'] != contract['id']:
            identities.append(contract['config_id'])
        for index, identity in enumerate(identities):
            try:
                objects = json.loads(self.docker('image', 'inspect', identity))
            except ImageNotFound:
                if index + 1 < len(identities):
                    continue
                raise
            if not isinstance(objects, list) or len(objects) != 1 or not isinstance(objects[0], dict):
                raise ValueError('NetMap image identity mismatch')
            image = objects[0]
            labels = image.get('Config', {}).get('Labels') if isinstance(image.get('Config'), dict) else None
            if (not isinstance(labels, dict) or image.get('Id') not in identities or image.get('Os') != 'linux'
                    or image.get('Architecture') != contract['architecture']
                    or any(labels.get(key) != value for key, value in contract['labels'].items())):
                # A found but invalid canonical image must never select another ID.
                raise ValueError('NetMap image identity mismatch')
            self.images[role]['id'] = image['Id']
            return image

    def labels(self, instance, role=None):
        result = {'netmap.standalone.version': '1', 'netmap.owner': self.settings['owner'],
                  'pl.module': 'netmap', 'pl.instance': nm.identifier(instance)}
        if role:
            result['pl.module.role'] = role
        return result

    def state(self, instance):
        base = self.paths(instance)
        value = json.loads(nm.read_file(base / 'state.json'))
        self.validate_seed(value, instance)
        if (set(value) != {'schema', 'installation', 'instance_id', 'origin', 'secrets', 'files'}
                or not isinstance(value['files'], dict) or set(value['files']) != set(nm.CONFIG_FILES)):
            raise ValueError('Invalid standalone NetMap state')
        for name, expected in value['files'].items():
            if hashlib.sha256(nm.read_file(base / 'config' / name, mode=0o444)).hexdigest() != expected:
                raise ValueError('Standalone NetMap private configuration drift')
        if len(nm.read_file(base / 'config/gateway_key', mode=0o444)) != 32:
            raise ValueError('Invalid independent NetMap gateway key')
        return value

    def validate_seed(self, value, instance):
        if (not isinstance(value, dict) or value.get('schema') != 1
                or value.get('installation') != self.installation or value.get('instance_id') != instance
                or value.get('origin') != self.settings['platform_origin']
                or not isinstance(value.get('secrets'), dict) or set(value['secrets']) != SECRET_NAMES
                or any(not isinstance(item, str) or not re.fullmatch(
                    r'[A-Za-z0-9]{8}' if key == 'admin_password' else r'[0-9a-f]{12}' if key == 'token_key' else r'[0-9a-f]{64}', item)
                       for key, item in value['secrets'].items())):
            raise ValueError('Invalid standalone NetMap bootstrap seed')

    def initialize(self, instance):
        base = self.paths(instance, create=True)
        journal = base / 'initialization.json'
        if (base / 'state.json').exists() or (base / 'state.json').is_symlink():
            current = self.state(instance)
            if journal.exists() or journal.is_symlink():
                if json.loads(nm.read_file(journal)) != {key: value for key, value in current.items() if key != 'files'}:
                    raise ValueError('Standalone initialization journal drift')
                journal.unlink()
                nm.fsync_directory(base)
            return
        if journal.exists() or journal.is_symlink():
            seed = json.loads(nm.read_file(journal))
            self.validate_seed(seed, instance)
        else:
            if list((base / 'config').iterdir()):
                raise ValueError('Unmanaged standalone NetMap configuration')
            secret = {key: secrets.token_hex(32) for key in SECRET_NAMES - {'admin_password', 'token_key'}}
            secret['token_key'] = secrets.token_hex(6)
            secret['admin_password'] = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8))
            seed = {'schema': 1, 'installation': self.installation, 'instance_id': instance,
                    'origin': self.settings['platform_origin'], 'secrets': secret}
            nm.atomic(journal, seed)
        secret, public = seed['secrets'], urllib.parse.urlsplit(seed['origin'])
        netbox = {key: secret[key] for key in ('database_password', 'cache_password', 'secret_key',
                                             'token_pepper', 'token_key', 'token', 'admin_password')}
        netbox.update(origin=seed['origin'], hostname=public.hostname)
        gateway = base / 'config/gateway_key'
        # A separate random key, never derived from a Platform installation or another module.
        gateway_key = nm.read_file(gateway, mode=0o444) if gateway.exists() or gateway.is_symlink() else secrets.token_bytes(32)
        if len(gateway_key) != 32:
            raise ValueError('Invalid standalone gateway key')
        values = {
            'postgres_password': secret['database_password'].encode(), 'netbox.json': nm.encoded(netbox),
            'adapter.json': nm.encoded({**{key: secret[key] for key in ('token_key', 'token', 'source_password')},
                                       'origin': seed['origin'], 'platform_origin': seed['origin'], 'hostname': public.netloc}),
            'oxidized.json': nm.encoded({'source_password': secret['source_password']}), 'gateway_key': gateway_key,
            'cache.conf': ('bind 0.0.0.0\nprotected-mode yes\nport 6379\nappendonly yes\ndir /data\nrequirepass '
                           + secret['cache_password'] + '\n').encode(),
            'gitea.ini': ('APP_NAME = PL Configuration History\nRUN_USER = git\nWORK_PATH = /var/lib/gitea\n'
                '[database]\nDB_TYPE = sqlite3\nPATH = /var/lib/gitea/data/gitea.db\n[server]\n'
                'HTTP_ADDR = 0.0.0.0\nHTTP_PORT = 3000\nDOMAIN = ' + public.hostname + '\nROOT_URL = '
                + seed['origin'] + '/netmap/gitea/\nDISABLE_SSH = true\nOFFLINE_MODE = true\n[security]\n'
                'INSTALL_LOCK = true\nSECRET_KEY = ' + secret['gitea_secret'] + '\n[service]\n'
                'DISABLE_REGISTRATION = true\nREQUIRE_SIGNIN_VIEW = true\n[session]\nCOOKIE_NAME = pl_gitea_session\n'
                'COOKIE_SECURE = true\n[actions]\nENABLED = false\n[mailer]\nENABLED = false\n[log]\nMODE = console\nLEVEL = Warn\n').encode(),
        }
        if set(path.name for path in (base / 'config').iterdir()) - set(nm.CONFIG_FILES):
            raise ValueError('Unknown standalone configuration files')
        for name, value in values.items():
            path = base / 'config' / name
            if path.exists() or path.is_symlink():
                if nm.read_file(path, mode=0o444) != value:
                    raise ValueError('Standalone initialization drift')
            else:
                nm.atomic(path, value, mode=0o444)
        nm.atomic(base / 'state.json', {**seed, 'files': {name: hashlib.sha256(value).hexdigest() for name, value in values.items()}})
        journal.unlink()
        nm.fsync_directory(base)
        self.state(instance)

    def resource(self, instance, kind, volume='database'):
        if kind not in ('network', 'volume') or volume not in nm.VOLUMES:
            raise ValueError('Invalid standalone resource role')
        name = self.name(instance, '-net' if kind == 'network' else '-' + volume + '-data')
        if not self.docker(kind, 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').strip():
            return None
        value = json.loads(self.docker(kind, 'inspect', name))[0]
        if (value.get('Name') != name or value.get('Driver') != ('bridge' if kind == 'network' else 'local')
                or value.get('Options') or value.get('Labels') != self.labels(instance)):
            raise ValueError('Standalone resource ownership mismatch')
        if kind == 'network':
            network = subnet(self.settings['subnet'])
            configs = value.get('IPAM', {}).get('Config') or []
            if (not re.fullmatch(r'[0-9a-f]{64}', value.get('Id', '')) or value.get('Scope') != 'local'
                    or value.get('Internal') or value.get('Ingress') or value.get('EnableIPv6')
                    or value.get('IPAM', {}).get('Driver') != 'default' or value.get('IPAM', {}).get('Options')
                    or len(configs) != 1 or configs[0].get('Subnet') != str(network)
                    or configs[0].get('Gateway') != str(network.network_address + 1)
                    or configs[0].get('IPRange') or configs[0].get('AuxiliaryAddresses')):
                raise ValueError('Standalone private network drift')
            for identity, member in (value.get('Containers') or {}).items():
                obj = json.loads(self.docker('container', 'inspect', identity))[0]
                role = (obj.get('Config', {}).get('Labels') or {}).get('pl.module.role')
                if (role not in nm.ROLES or obj.get('Id') != identity
                        or member.get('Name') != self.name(instance, '-' + role)
                        or obj.get('Name', '').lstrip('/') != member.get('Name')
                        or any((obj.get('Config', {}).get('Labels') or {}).get(key) != item
                               for key, item in self.labels(instance, role).items())):
                    raise ValueError('Foreign container attached to standalone NetMap network')
        elif value.get('Scope') != 'local':
            raise ValueError('Standalone volume scope mismatch')
        return value

    def preflight_network(self):
        selected = subnet(self.settings['subnet'])
        identities = self.docker('network', 'ls', '--quiet', '--no-trunc').decode().split()
        if len(identities) > 4096 or any(not re.fullmatch(r'[0-9a-f]{64}', value) for value in identities):
            raise ValueError('Invalid Docker network inventory')
        occupied = []
        for identity in identities:
            obj = json.loads(self.docker('network', 'inspect', identity))[0]
            if obj.get('Id') != identity:
                raise ValueError('Docker network inventory changed')
            occupied.extend(ipaddress.ip_network(item['Subnet'], strict=True)
                            for item in obj.get('IPAM', {}).get('Config') or [] if item.get('Subnet'))
        result = subprocess.run(['ip', '-j', '-4', 'route', 'show', 'table', 'all'], cwd=self.root,
                                capture_output=True, timeout=30, check=False)
        if result.returncode:
            raise ValueError('Standalone network route preflight failed')
        routes = json.loads(result.stdout)
        if not isinstance(routes, list):
            raise ValueError('Invalid host route inventory')
        occupied.extend(ipaddress.IPv4Network(item['dst'], strict=False)
                        for item in routes if item.get('dst') and item['dst'] != 'default')
        if any(network.version == 4 and network.prefixlen and selected.overlaps(network) for network in occupied):
            raise ValueError('Selected standalone subnet overlaps a host route or Docker network')

    def create_resource(self, instance, kind, volume='database'):
        if self.resource(instance, kind, volume) is None:
            args = [kind, 'create']
            if kind == 'network':
                self.preflight_network()
                network = subnet(self.settings['subnet'])
                args += ['--driver', 'bridge', '--subnet', str(network), '--gateway', str(network.network_address + 1)]
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, self.name(instance, '-net' if kind == 'network' else '-' + volume + '-data'))
        if self.resource(instance, kind, volume) is None:
            raise ValueError('Standalone resource creation unconfirmed')

    def inspect(self, instance, role):
        name = self.name(instance, '-' + role)
        if not self.docker('container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').strip():
            return None
        image = self.verify_image(role)
        environment, mounts, user, tmpfs = self.specification(instance, role)
        obj = json.loads(self.docker('container', 'inspect', name))[0]
        config, host = obj.get('Config', {}), obj.get('HostConfig', {})
        actual_mounts = {(item.get('Type'), item.get('Name') if item.get('Type') == 'volume' else item.get('Source'),
                          item.get('Destination'), item.get('RW')) for item in obj.get('Mounts', [])}
        expected_env = dict(item.split('=', 1) for item in image.get('Config', {}).get('Env', []))
        expected_env.update(environment)
        actual_env = config.get('Env') or []
        actual_env_map = dict(item.split('=', 1) for item in actual_env)
        bindings = {'8092/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(self.settings['adapter_port'])}]} if role == 'adapter' else {}
        published = {key: value for key, value in (obj.get('NetworkSettings', {}).get('Ports') or {}).items() if value}
        running = obj.get('State', {}).get('Running') is True
        if (obj.get('Name') != '/' + name or not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', ''))
                or obj.get('Image') != self.images[role]['id'] or config.get('Image') != self.images[role]['id']
                or actual_mounts != set(mounts) or actual_env_map != expected_env or len(actual_env) != len(actual_env_map)
                or config.get('User') != user
                or any(config.get(key) != image.get('Config', {}).get(key) for key in ('Entrypoint', 'Cmd', 'WorkingDir'))
                or any((config.get('Labels') or {}).get(key) != value for key, value in self.labels(instance, role).items())
                or (host.get('PortBindings') or {}) != bindings or published != (bindings if running else {})
                or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapDrop') != ['ALL']
                or host.get('CapAdd') or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts')
                or host.get('NetworkMode') != self.name(instance, '-net')
                or set(obj.get('NetworkSettings', {}).get('Networks', {})) != {self.name(instance, '-net')}
                or host.get('Memory') != nm.MEMORY[role] * 1024**2 or host.get('NanoCpus') != 1_000_000_000
                or host.get('PidsLimit') != 256 or not host.get('Init') or host.get('Tmpfs') != tmpfs
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('PidMode') not in (None, '') or host.get('IpcMode') not in (None, 'private')
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])):
            raise ValueError('Standalone container ownership or specification drift')
        network = self.resource(instance, 'network')
        if network is None or any(self.resource(instance, 'volume', item) is None for item in nm.VOLUMES):
            raise ValueError('Standalone managed resources missing')
        connection = obj['NetworkSettings']['Networks'][self.name(instance, '-net')]
        pending = (obj.get('State', {}).get('Status') == 'created' and not running
                   and obj['State'].get('StartedAt') in (None, '', '0001-01-01T00:00:00Z')
                   and connection.get('IPAMConfig') in (None, {})
                   and all(connection.get(key) in (None, '') for key in
                           ('NetworkID', 'EndpointID', 'IPAddress', 'GlobalIPv6Address', 'Gateway', 'IPv6Gateway')))
        if role not in (connection.get('Aliases') or []) or connection.get('NetworkID') != network['Id'] and not pending:
            raise ValueError('Standalone container network identity drift')
        return obj

    def create_container(self, instance, role):
        self.verify_image(role)
        environment, mounts, user, tmpfs = self.specification(instance, role)
        args = ['container', 'create', '--name', self.name(instance, '-' + role), '--network', self.name(instance, '-net'),
                '--network-alias', role, '--restart', 'unless-stopped', '--init', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory', str(nm.MEMORY[role]) + 'm', '--cpus', '1',
                '--pids-limit', '256', '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2', '--user', user]
        if role == 'adapter':
            args += ['--publish', '127.0.0.1:' + str(self.settings['adapter_port']) + ':8092/tcp']
        for path, options in tmpfs.items():
            args += ['--tmpfs', path + ':' + options]
        for key, value in environment.items():
            args += ['--env', key + '=' + value]
        for kind, source, target, writable in mounts:
            args += ['--mount', 'type=' + kind + ',source=' + source + ',target=' + target + ('' if writable else ',readonly')]
        for key, value in self.labels(instance, role).items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.images[role]['id'])
        if self.inspect(instance, role) is None:
            raise ValueError('Standalone container creation unconfirmed')

    def endpoint(self, obj):
        return self.settings['endpoint']

    def _observe(self, instance):
        base = self.instances / nm.identifier(instance)
        if not base.exists() and not base.is_symlink():
            if (self.resource(instance, 'network') or any(self.resource(instance, 'volume', item) for item in nm.VOLUMES)
                    or any(self.inspect(instance, role) for role in nm.ROLES)):
                raise ValueError('Standalone resources have no owned bootstrap state')
            return {'state': 'absent', 'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        self.state(instance)
        objects = [self.inspect(instance, role) for role in nm.ROLES]
        result = {'state': 'disabled', 'version': self.version, 'endpoint': '', 'error': '',
                  'targets_up': 0, 'targets_total': 0}
        if all(obj is None for obj in objects):
            if self.resource(instance, 'network') or any(self.resource(instance, 'volume', item) is None for item in nm.VOLUMES):
                raise ValueError('Standalone deployment resources incomplete')
            return {**result, 'state': 'deployment_removed'}
        if any(obj is None for obj in objects):
            raise ValueError('Standalone containers incomplete')
        running = [bool(obj.get('State', {}).get('Running')) for obj in objects]
        if any(running) and not all(running):
            raise ValueError('Standalone containers have mixed state')
        if all(running):
            result.update(state='running', endpoint=self.endpoint(self.ready(instance)))
        return result

    def stop(self, *, remove_deployment=False):
        instance = self.instance
        self.state(instance)
        objects = [self.inspect(instance, role) for role in nm.ROLES]
        # Complete ownership preflight before stopping the first container.
        self.resource(instance, 'network')
        for volume in nm.VOLUMES:
            self.resource(instance, 'volume', volume)
        for obj in reversed(objects):
            if obj:
                if obj.get('State', {}).get('Running'):
                    self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=30)
                if remove_deployment:
                    self.docker('container', 'rm', obj['Id'])
        if remove_deployment and self.resource(instance, 'network'):
            self.docker('network', 'rm', self.name(instance, '-net'))
        for role in nm.ROLES:
            obj = self.inspect(instance, role)
            if obj and (remove_deployment or obj.get('State', {}).get('Running')):
                raise ValueError('Standalone stop/removal unconfirmed')

    def private_handoff(self):
        value = self.state(self.instance)
        key = nm.read_file(self.paths(self.instance) / 'config/gateway_key', mode=0o444)
        connection = {'schema': 1, 'module_id': 'netmap', 'endpoint': self.settings['endpoint'],
                      'platform_origin': self.settings['platform_origin'], 'gateway_key_hex': key.hex()}
        nm.atomic(self.root / 'connection.json', connection)
        initial = self.root / 'initial-logins.json'
        if not initial.exists() and not initial.is_symlink():
            volume = self.resource(self.instance, 'volume', 'gitea')
            nm.atomic(initial, {'schema': 1, 'kind': 'initial_credentials',
                'netbox': {'username': 'pl-admin', 'password': value['secrets']['admin_password'],
                           'url': self.settings['platform_origin'] + '/netmap/netbox/login/'},
                'gitea': {'username': 'pl-admin', 'password': self.gitea_initial_password(volume['Mountpoint']),
                          'url': self.settings['platform_origin'] + '/netmap/gitea/user/login'}})
        else:
            nm.read_file(initial)

    def tls_check(self):
        ca = self.settings['ca_file']
        if ca and digest(Path(ca)) != self.settings['ca_sha256']:
            raise ValueError('Standalone TLS CA file changed')
        context = ssl.create_default_context(cafile=ca or None)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), nm._NoRedirect(),
                                            urllib.request.HTTPSHandler(context=context))
        encoded = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
        now, path = int(time.time()), '/netmap/api/health'
        claims = {'v': 2, 'aud': 'netmap', 'iat': now, 'exp': now + 15, 'nonce': encoded(secrets.token_bytes(16)),
                  'sub': 'standalone-installer', 'name': 'Standalone installer', 'admin': False,
                  'scopes': ['netmap:read'], 'method': 'GET', 'uri': path, 'content_type': '',
                  'body_sha256': hashlib.sha256(b'').hexdigest(), 'idempotency_key': '', 'source_ip': '127.0.0.1',
                  'csrf_token': encoded(secrets.token_bytes(32)), 'csrf_verified': False}
        assertion = encoded(json.dumps(claims, separators=(',', ':')).encode())
        key = nm.read_file(self.paths(self.instance) / 'config/gateway_key', mode=0o444)
        signature = encoded(hmac.digest(key, b'pl-gateway-v2\n' + assertion.encode(), 'sha256'))
        request = urllib.request.Request(self.settings['endpoint'] + path,
            headers={'X-PL-Gateway-Assertion': assertion, 'X-PL-Gateway-Signature': signature,
                     'Accept': 'application/json', 'Accept-Encoding': 'identity'})
        try:
            with opener.open(request, timeout=30) as response:
                raw = response.read(8193)
                if response.status != 200 or len(raw) > 8192:
                    raise ValueError('Standalone signed TLS readiness failed')
                value = json.loads(raw)
                if (not isinstance(value, dict) or value.get('status') != 'ok'
                        or value.get('sources_ok') != 1 or value.get('sources_total') != 1):
                    raise ValueError('Standalone signed TLS source readiness failed')
            for denied in ('/internal/bootstrap', '/healthz'):
                try:
                    with opener.open(self.settings['endpoint'] + denied, timeout=10) as response:
                        code = response.status
                except urllib.error.HTTPError as error:
                    code = error.code
                    error.close()
                if code != 404:
                    raise ValueError('Standalone ingress exposes an internal route')
        except (urllib.error.URLError, OSError, ValueError) as error:
            if isinstance(error, ValueError) and str(error).startswith('Standalone'):
                raise
            raise ValueError('Standalone TLS ingress readiness failed; verify DNS, certificate trust and proxy configuration') from None


def settings_for(args, root, package_sha256):
    path = root / 'deployment.json'
    if path.exists() or path.is_symlink():
        value = json.loads(nm.read_file(path))
        if (not isinstance(value, dict) or set(value) != {'schema', 'owner', 'instance_id', 'package_sha256',
                'platform_origin', 'endpoint', 'subnet', 'adapter_port', 'ca_file', 'ca_sha256'}
                or value.get('schema') != 1 or not re.fullmatch(r'[0-9a-f]{16}', value.get('owner', ''))
                or value.get('package_sha256') != package_sha256):
            raise ValueError('Standalone deployment identity/package drift')
        nm.identifier(value['instance_id'])
        if origin(value['platform_origin']) != value['platform_origin'] or origin(value['endpoint']) != value['endpoint']:
            raise ValueError('Standalone deployment origin drift')
        subnet(value['subnet'])
        if type(value['adapter_port']) is not int or not 1024 <= value['adapter_port'] <= 65535:
            raise ValueError('Invalid standalone loopback port')
        if value['ca_file'] and (str(canonical_path(value['ca_file'])) != value['ca_file']
                                or not re.fullmatch(r'[0-9a-f]{64}', value['ca_sha256'])):
            raise ValueError('Invalid standalone TLS trust configuration')
        for argument, key in (('platform_origin', 'platform_origin'), ('endpoint', 'endpoint'),
                              ('subnet', 'subnet'), ('adapter_port', 'adapter_port')):
            requested = getattr(args, argument, None)
            if requested is not None and (origin(requested) if key in ('platform_origin', 'endpoint') else requested) != value[key]:
                raise ValueError('Standalone repeat must preserve origin, endpoint, subnet and port')
        if getattr(args, 'ca_file', None) is not None and str(canonical_path(args.ca_file)) != value['ca_file']:
            raise ValueError('Standalone repeat must preserve TLS trust input')
        return value
    if args.action != 'install' or any(getattr(args, key, None) is None for key in ('platform_origin', 'endpoint', 'subnet', 'adapter_port')):
        raise ValueError('Fresh install requires platform-origin, endpoint, subnet and adapter-port')
    if set(path.name for path in root.iterdir()) - {'standalone.lock'}:
        raise ValueError('Fresh standalone deployment requires an empty owned root')
    public, endpoint = origin(args.platform_origin), origin(args.endpoint)
    if public == endpoint:
        raise ValueError('Remote adapter origin must differ from Platform public origin')
    subnet(args.subnet)
    if not 1024 <= args.adapter_port <= 65535:
        raise ValueError('Explicit loopback adapter port must be 1024 through 65535')
    ca = canonical_path(args.ca_file) if args.ca_file else None
    if ca and not ca.is_file():
        raise ValueError('TLS CA bundle unavailable')
    value = {'schema': 1, 'owner': secrets.token_hex(8), 'instance_id': str(uuid.uuid4()),
             'package_sha256': package_sha256, 'platform_origin': public, 'endpoint': endpoint,
             'subnet': args.subnet, 'adapter_port': args.adapter_port,
             'ca_file': str(ca) if ca else '', 'ca_sha256': digest(ca) if ca else ''}
    nm.atomic(path, value)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'status', 'stop', 'remove-deployment', 'remove'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--package-dir', type=Path, default=BASE)
    parser.add_argument('--platform-origin', help='Public HTTPS Platform origin; native services use /netmap/... there')
    parser.add_argument('--endpoint', help='Remote HTTPS adapter origin, without /netmap or other path')
    parser.add_argument('--subnet', help='Unused canonical RFC1918 IPv4 /28')
    parser.add_argument('--adapter-port', type=int, help='Explicit local loopback HTTP port behind existing host TLS ingress')
    parser.add_argument('--ca-file', type=Path, help='PEM CA bundle for remote ingress; hostname verification remains enabled')
    parser.add_argument('--purge-data', action='store_true')
    parser.add_argument('--confirm-instance', help='Exact instance UUID required with remove --purge-data')
    args = parser.parse_args()
    phase = 'input_and_package_validation'
    try:
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise ValueError('Standalone lifecycle requires root on the target Linux host')
        if args.action == 'remove' and not args.purge_data or args.purge_data and args.action != 'remove':
            raise ValueError('Use remove-deployment to preserve data, or remove --purge-data --confirm-instance UUID')
        manifest, package_sha256 = load_package(args.package_dir, images=args.action == 'install')
        if canonical_path(args.package_dir) != BASE:
            raise ValueError('Run the standalone script from the package being installed')
        if manifest['architecture'] != {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine()):
            raise ValueError('Standalone package architecture does not match target')
        root = canonical_path(args.root)
        if not root.exists() and args.action != 'install':
            raise ValueError('Standalone deployment root is absent')
        nm.directory(root)
        with deployment_lock(root):
            settings = settings_for(args, root, package_sha256)
            controller = Standalone(root, manifest, package_sha256, settings)
            if args.action == 'install':
                phase = 'image_archive_validation_and_load'
                validate_image_archive(args.package_dir / 'images.tar', manifest['images'])
                controller.docker('image', 'load', '--input', str(canonical_path(args.package_dir) / 'images.tar'), timeout=900)
                for role in nm.ROLES:
                    controller.verify_image(role)
                phase = 'owned_resources_and_native_bootstrap'
                controller.ensure(controller.instance)
                # Persist the key handoff even when the separately managed TLS ingress needs correction.
                controller.private_handoff()
                phase = 'signed_tls_gateway_and_route_boundaries'
                controller.tls_check()
                result = {'state': 'ready', 'instance_id': controller.instance,
                          'checks': ['owned_containers', 'native_bootstrap', 'signed_tls_gateway'],
                          'connection_file': str(root / 'connection.json'), 'initial_logins_file': str(root / 'initial-logins.json')}
            elif args.action == 'status':
                phase = 'owned_status_and_tls_readiness'
                state = controller.observe(controller.instance)
                if state['state'] == 'running':
                    controller.tls_check()
                result = {'state': state['state'], 'instance_id': controller.instance, 'version': controller.version}
            elif args.action in ('stop', 'remove-deployment'):
                phase = 'owned_stop_or_deployment_removal'
                controller.stop(remove_deployment=args.action == 'remove-deployment')
                result = {'state': 'stopped' if args.action == 'stop' else 'deployment_removed',
                          'instance_id': controller.instance, 'data_preserved': True}
            else:
                if args.confirm_instance != controller.instance:
                    raise ValueError('Destructive removal requires the exact owned instance UUID')
                phase = 'explicit_owned_data_removal'
                for name in ('connection.json', 'initial-logins.json', 'deployment.json'):
                    if (root / name).exists() or (root / name).is_symlink():
                        nm.read_file(root / name)
                controller.remove(controller.instance)
                for path in (controller.instances, controller.operations, controller.base, root / 'modules'):
                    path.rmdir()
                for name in ('connection.json', 'initial-logins.json', 'deployment.json'):
                    path = root / name
                    if path.exists() or path.is_symlink():
                        nm.read_file(path)
                        path.unlink()
                nm.fsync_directory(root)
                result = {'state': 'removed', 'instance_id': controller.instance, 'data_preserved': False}
            print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError, tarfile.TarError):
        # External errors/arguments and private native receipts may contain credentials.
        print('NetMap standalone failed at ' + phase + '; inspect the owned deployment and explicit input configuration.',
              file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
