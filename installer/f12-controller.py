#!/usr/bin/env python3
"""Own the private F12 server, its data volume and explicitly published segment listeners."""
from array import array
from contextlib import ExitStack, closing, contextmanager, nullcontext
import fcntl
import hashlib
import hmac
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import struct
import subprocess
import tempfile
import threading
import time

_helper = Path(__file__).with_name('xray-controller.py')
if _helper.is_symlink() or not _helper.is_file():
    raise ValueError('Trusted host file primitives unavailable')
_spec = importlib.util.spec_from_file_location('pl_f12_files', _helper)
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
directory, identifier, read_file = _files.directory, _files.identifier, _files.read_file
atomic, encoded = _files.atomic, _files.encoded

UID = 65532
PORT = 18080
PXE_PORTS = (67, 4011, 69)
PXE_FIRMWARE = {'bios', 'uefi-x64'}
PXE_LABEL = 'pl.f12.pxe.version'
CHUNK = 4 * 1024**2
MAX_ISO = 32 * 1024**3
HEX = re.compile(r'[0-9a-f]{64}\Z', re.ASCII)
VERSION = '0.1.81'
ROUTES = {'library': set(), 'menu': {'segment'}, 'publish': {'id', 'segments'},
          'upload-start': {'id', 'name', 'size', 'segments'}, 'upload-finish': {'id'},
          'upload-cancel': {'id'}, 'upload-chunk': {'id', 'offset'}}
HTTP_STATUSES = {200, 201, 202, 400, 401, 403, 404, 409, 413, 415, 416, 422, 429, 500, 502, 503, 507}
ENTRYPOINT = ['python3', '-B', '-u', '/opt/pl-f12/native.py']
LOGS = {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
DEFAULT_BRIDGE = {'com.docker.network.enable_ipv4': 'true', 'com.docker.network.enable_ipv6': 'false'}
TEMPFS = {'/tmp': 'rw,nosuid,nodev,size=64m,mode=1777'}


def load_network_helper():
    path = Path(__file__).with_name('module-network.py')
    if path.is_symlink() or not path.is_file():
        raise ValueError('Trusted module network allocator unavailable')
    spec = importlib.util.spec_from_file_location('pl_f12_network', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Failure(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def hex_id(value):
    return isinstance(value, str) and bool(HEX.fullmatch(value))


def invalid():
    return Failure(400, 'Проверьте параметры сетевой загрузки.')


def unavailable():
    return Failure(503, 'Сервер сетевой загрузки недоступен.')


def segment_record(value):
    if not isinstance(value, dict) or set(value) != {'name', 'address', 'cidr', 'port'}:
        raise ValueError('Invalid F12 segment')
    name = value['name']
    if (not isinstance(name, str) or not 0 < len(name.encode()) <= 180 or any(ord(c) < 32 for c in name)
            or value['port'] != PORT or type(value['port']) is not int):
        raise ValueError('Invalid F12 segment attributes')
    address = ipaddress.IPv4Address(value['address'])
    subnet = ipaddress.IPv4Network(value['cidr'], strict=True)
    if (str(address) != value['address'] or str(subnet) != value['cidr'] or address not in subnet
            or not subnet.prefixlen or address.is_loopback or address.is_link_local or address.is_multicast
            or address.is_unspecified or address.is_reserved):
        raise ValueError('Invalid F12 segment address')
    return value


def digest(secret, purpose, data):
    return hmac.new(bytes.fromhex(secret), purpose.encode() + b'\0' + encoded(data), hashlib.sha256).hexdigest()


def parse_request(request, streaming):
    keys = {'instance_id', 'action', 'actor', 'payload'} | ({'body_sha256', 'body_length'} if streaming else set())
    if not isinstance(request, dict) or set(request) != keys or not hex_id(request['actor']):
        raise invalid()
    action, payload = request['action'], request['payload']
    if (not isinstance(action, str) or action not in ROUTES or (action == 'upload-chunk') != streaming
            or not isinstance(payload, dict) or set(payload) != ROUTES[action]):
        raise invalid()
    if action.startswith('upload-'):
        try:
            identifier(payload['id'])
        except ValueError:
            raise invalid() from None
    if action == 'menu' and not hex_id(payload['segment']) or action == 'publish' and not hex_id(payload['id']):
        raise invalid()
    if 'segments' in payload:
        values = payload['segments']
        if (not isinstance(values, list) or len(values) > 128 or any(not hex_id(v) for v in values)
                or len(set(values)) != len(values)):
            raise invalid()
    if action == 'upload-start':
        name = payload['name']
        if (not isinstance(name, str) or not name.isprintable() or not 1 <= len(name.encode()) <= 240 or not name.lower().endswith('.iso')
                or '/' in name or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)
                or type(payload['size']) is not int or not 1 <= payload['size'] <= MAX_ISO):
            raise invalid()
    if streaming:
        if (type(payload['offset']) is not int or not 0 <= payload['offset'] < MAX_ISO or not hex_id(request['body_sha256'])
                or type(request['body_length']) is not int or not 1 <= request['body_length'] <= CHUNK
                or payload['offset'] + request['body_length'] > MAX_ISO):
            raise invalid()
    return action, payload


def connect_owned_socket(client, directory_path, name, peer_pid):
    fd = os.open(directory_path, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if (not stat.S_ISSOCK(info.st_mode) or
                (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (UID, UID, 0o660)):
            raise unavailable()
        # Linux sun_path is short; the installation root itself may be long.
        client.connect('/proc/self/fd/' + str(fd) + '/' + name)
    finally:
        os.close(fd)
    if struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) != (peer_pid, UID, UID):
        raise unavailable()


class AdminConnection(http.client.HTTPConnection):
    def __init__(self, admin, peer_pid, timeout, name='admin.sock'):
        super().__init__('localhost', timeout=timeout)
        self.admin, self.peer_pid, self.name = admin, peer_pid, name

    def connect(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(self.timeout)
            connect_owned_socket(client, self.admin, self.name, self.peer_pid)
            self.sock = client.dup()


@contextmanager
def host_lock(path, exclusive=True):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        item = os.fstat(fd)
        if not stat.S_ISREG(item.st_mode) or item.st_uid != os.geteuid() or stat.S_IMODE(item.st_mode) != 0o600:
            raise ValueError('Invalid F12 host lock')
        deadline = time.monotonic() + (12 if exclusive else 4)
        while True:
            try:
                mode = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
                fcntl.flock(fd, mode | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Failure(409, 'Другая операция с модулем ещё выполняется.')
                time.sleep(.05)
        yield


def private_dir(path, mode, gid):
    try:
        path.mkdir(mode=mode)
    except FileExistsError:
        pass
    else:
        os.chown(path, os.geteuid(), gid)
        path.chmod(mode)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (os.geteuid(), gid, mode)):
        raise ValueError('Unsafe F12 runtime directory')


def runtime_json(path, value):
    data = encoded(value)
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_gid != UID
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o440 or info.st_size > 256 * 1024):
            raise ValueError('Unsafe F12 runtime file')
        if path.read_bytes() == data:
            return
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            os.fchown(fd, os.geteuid(), UID)
            os.fchmod(fd, 0o440)
            out.write(data)
            out.flush()
            os.fsync(fd)
        os.replace(name, path)
        _files.fsync_directory(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def running_pid(obj):
    state = (obj or {}).get('State') or {}
    pid = state.get('Pid')
    if not state.get('Running') or state.get('Paused') or state.get('Restarting') or type(pid) is not int or pid <= 0:
        raise unavailable()
    return pid


def firmware_list(values):
    if not isinstance(values, list) or len(values) > 2 or any(type(value) is not str for value in values):
        raise unavailable()
    if not set(values) <= PXE_FIRMWARE or sorted(set(values)) != values:
        raise unavailable()
    return values


def pxe_command(path, pid, message, sockets=()):
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as client:
        client.settimeout(3)
        connect_owned_socket(client, path, 'control.sock', pid)
        rights = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array('i', (s.fileno() for s in sockets)))] if sockets else []
        data = encoded(message)
        if client.sendmsg([data], rights) != len(data):
            raise unavailable()
        reply, _, flags, _ = client.recvmsg(512)
    if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
        raise unavailable()
    result = json.loads(reply)
    if (not isinstance(result, dict) or set(result) != {'state', 'firmware'}
            or result['state'] not in ('idle', 'waiting', 'active', 'error')):
        raise unavailable()
    firmware_list(result['firmware'])
    return result


def open_pxe_sockets(stack, interface, address):
    sockets = []
    for port in PXE_PORTS:
        listener = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode('ascii') + b'\0')
        if port == 67:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            # Python before 3.14 does not export Linux IP_PKTINFO (uapi linux/in.h).
            listener.setsockopt(socket.IPPROTO_IP, getattr(socket, 'IP_PKTINFO', 8), 1)
        listener.bind(('0.0.0.0' if port == 67 else address, port))
        sockets.append(listener)
    return sockets


def remove_pxe_directory(path):
    if not path.exists() and not path.is_symlink():
        return
    private_dir(path, 0o1770, UID)
    if {p.name for p in path.iterdir()} - {'control.sock'}:
        raise ValueError('Unexpected content in F12 PXE runtime directory')
    entry = path / 'control.sock'
    if entry.exists() or entry.is_symlink():
        info = entry.lstat()
        if (not stat.S_ISSOCK(info.st_mode) or
                (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (UID, UID, 0o660)):
            raise ValueError('Unowned F12 PXE control socket')
        entry.unlink()
    path.rmdir()


class F12Controller:
    def __init__(self, parent):
        self.parent, self.root, self.installation, self.docker = parent, Path(parent.root), parent.installation, parent.docker
        self.base = self.root / 'modules/f12'
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        for path in (self.base, self.instances, self.operations):
            directory(path)
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        installed = json.loads(read_file(self.root / 'state/installation.json'))
        bundle = registry.get('f12')
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or installed.get('install_id') != self.installation or not hex_id(registry.get('manifest_sha256'))
                or registry['manifest_sha256'] != installed.get('manifest_sha256') or not isinstance(bundle, dict)
                or set(bundle) != {'server'}):
            raise ValueError('Invalid F12 installation identity')
        self.image = bundle['server']
        self.version = VERSION
        self.native_slots = threading.BoundedSemaphore(8)
        self.sampled_networks = {}
        self.pxe_errors = set()
        labels = {'org.opencontainers.image.version': VERSION, 'pl.upstream.version': VERSION, 'pl.module.id': 'f12',
                  'pl.module.role': 'server', 'pl.module.config.version': '1', 'pl.build.variant': 'upstream-pinned'}
        if (not isinstance(self.image, dict) or set(self.image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                or not isinstance(self.image['id'], str) or not re.fullmatch('sha256:[0-9a-f]{64}', self.image['id'])
                or self.image['architecture'] not in ('amd64', 'arm64') or self.image['recipe'] != 'deploy/images/f12.Dockerfile'
                or not isinstance(self.image['labels'], dict) or any(self.image['labels'].get(k) != v for k, v in labels.items())
                or self.image['labels'].get(PXE_LABEL) not in (None, '1')):
            raise ValueError('Invalid F12 image descriptor')

    @property
    def automatic_pxe(self):
        return self.image['labels'].get(PXE_LABEL) == '1'

    def names(self, instance, suffix=''):
        return self.installation + '-f12-' + identifier(instance) + suffix

    def labels(self, instance):
        return {'pl.installation': self.installation, 'pl.module': 'f12', 'pl.instance': identifier(instance)}

    def locked(self, instance, exclusive=False):
        return host_lock(self.operations / ('instance-' + identifier(instance) + '.lock'), exclusive)

    def path(self, instance, create=False):
        path = self.instances / identifier(instance)
        directory(path, create=create)
        return path

    def state(self, instance):
        value = json.loads(read_file(self.path(instance) / 'state.json'))
        if (not isinstance(value, dict) or set(value) != {'installation', 'instance_id', 'secret', 'storage_created', 'edges'}
                or value['installation'] != self.installation or value['instance_id'] != instance or not hex_id(value['secret'])
                or type(value['storage_created']) is not bool or not isinstance(value['edges'], dict) or len(value['edges']) > 128):
            raise ValueError('Invalid F12 instance state')
        for key, net in value['edges'].items():
            if not hex_id(key) or digest(value['secret'], 'segment', segment_record(net)) != key:
                raise ValueError('Invalid F12 edge identity')
        return value

    def host_networks(self, state):
        proc = subprocess.run(['ip', '-j', '-4', 'address', 'show', 'up'], cwd=self.root, env=getattr(self.parent, 'env', None),
                              capture_output=True, check=True, timeout=4)
        table = {}
        ambiguous = set()
        interfaces = {}
        primary_count = {}
        for iface in json.loads(proc.stdout):
            nic = iface['ifname']
            if ('UP' not in iface.get('flags', []) or 'LOOPBACK' in iface['flags'] or
                    not re.fullmatch(r'[a-zA-Z0-9_.:@-]{1,64}', nic) or
                    re.fullmatch(r'lo|docker\d+|br-[0-9a-f]{12}|veth.*', nic)):
                continue
            for address in iface.get('addr_info', []):
                if (address.get('family') != 'inet' or address.get('scope') != 'global'
                        or address.get('secondary') or {'tentative', 'dadfailed', 'secondary'}.intersection(address.get('flags', []))):
                    continue
                ip = ipaddress.IPv4Address(address['local'])
                cidr = str(ipaddress.IPv4Network((ip, address['prefixlen']), strict=False))
                record = {'name': f'{nic} · {cidr} ({ip})', 'address': str(ip), 'cidr': cidr, 'port': PORT}
                try:
                    segment_record(record)
                except ValueError:
                    continue
                if str(ip) in table:
                    ambiguous.add(str(ip))
                table[str(ip)] = record
                primary_count[nic] = primary_count.get(nic, 0) + 1
                if ('BROADCAST' in iface['flags'] and not {'NOARP', 'POINTOPOINT'}.intersection(iface['flags'])
                        and re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', nic) and address['prefixlen'] < 31):
                    interfaces[str(ip)] = nic
        # Source-address filtering cannot distinguish overlapping client subnets.
        ranges = []
        for address, net in table.items():
            subnet = ipaddress.IPv4Network(net['cidr'])
            ranges.append((int(subnet.network_address), int(subnet.broadcast_address), address))
        end, previous = -1, ''
        for start, stop, address in sorted(ranges):
            if start <= end:
                ambiguous.update((previous, address))
            end, previous = max(end, stop), address
        result = {}
        for address, record in sorted(table.items()):
            if address in ambiguous:
                continue
            # The persistent segment identity predates PXE. Only a single, directly
            # attached broadcast domain can be selected for firmware discovery.
            key = digest(state['secret'], 'segment', record)
            nic = interfaces.get(address)
            result[key] = {**record, 'interface': nic} if nic and primary_count[nic] == 1 else record
        return result

    def runtime(self, instance):
        return self.root / 'run/f12' / identifier(instance)

    def clear_pxe_runtime(self, instance, segment):
        if not hex_id(segment):
            raise ValueError('Invalid F12 segment')
        remove_pxe_directory(self.runtime(instance) / 'edges' / segment / 'pxe')

    def prepare_runtime(self, state, networks):
        root = self.runtime(state['instance_id'])
        run = self.root / 'run'
        if not run.exists():
            directory(run)
        info = run.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError('Unsafe runtime parent')
        directory(root.parent)
        directory(root)
        private_dir(root / 'admin', 0o1770, UID)
        private_dir(root / 'boot', 0o1770, UID)
        directory(root / 'edges')
        records = {key: {**net, 'token': digest(state['secret'], 'boot', key)} for key, net in networks.items()}
        if self.automatic_pxe:
            for net in records.values():
                net['pxe_allowed'] = bool(net.get('interface'))
        runtime_json(root / 'admin/networks.json', records)
        for key, net in state['edges'].items():
            config = root / 'edges' / key
            directory(config)
            edge = {'id': key, **net, 'token': digest(state['secret'], 'boot', key)}
            if self.automatic_pxe:
                private_dir(config / 'pxe', 0o1770, UID)
                # The bind-mounted identity stays stable while link flags or the
                # number of addresses change. The private boot service evaluates
                # current eligibility on each request.
                nic = net['name'].partition(' · ')[0]
                if re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', nic):
                    edge['interface'] = nic
            runtime_json(config / 'edge.json', edge)

    def verify_image(self):
        obj, = json.loads(self.docker('image', 'inspect', self.image['id']))
        cfg = obj.get('Config') or {}
        if (obj.get('Id') != self.image['id'] or obj.get('Os') != 'linux' or obj.get('Architecture') != self.image['architecture']
                or any((cfg.get('Labels') or {}).get(k) != v for k, v in self.image['labels'].items())
                or cfg.get('User') != '65532:65532' or cfg.get('Entrypoint') != ENTRYPOINT or cfg.get('Cmd') != ['serve']
                or cfg.get('Volumes')):
            raise ValueError('F12 image identity mismatch')
        return obj

    def container_name(self, instance, segment=None):
        if segment is not None and not hex_id(segment):
            raise ValueError('Invalid F12 edge name')
        return self.names(instance, '-edge-' + segment if segment else '')

    def container_id(self, instance, segment=None):
        name = self.container_name(instance, segment)
        ident = self.docker('container', 'ls', '-a', '--no-trunc', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
        if ident and not hex_id(ident):
            raise ValueError('Invalid F12 container identity')
        return ident

    def resource(self, instance, kind, *, create=False):
        if kind not in ('volume', 'network'):
            raise ValueError('Invalid F12 resource')
        name = self.names(instance, '-net' if kind == 'network' else '-data')
        found = self.docker(kind, 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found and create:
            args = [kind, 'create']
            if kind == 'network':
                module = load_network_helper()
                args += ['--driver', 'bridge', *module.allocation_args(self.root, self.installation, self.docker, prefixlen=28)]
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, name)
            return self.resource(instance, kind)
        if not found:
            return None
        obj, = json.loads(self.docker(kind, 'inspect', name))
        options = obj.get('Options') or {}
        if (found != name or obj.get('Name') != name or obj.get('Scope') != 'local'
                or obj.get('Driver') != ('bridge' if kind == 'network' else 'local')
                or options and (kind != 'network' or options != DEFAULT_BRIDGE)
                or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())):
            raise ValueError('F12 resource ownership mismatch')
        if kind == 'network':
            if obj.get('Internal') is not False or obj.get('Ingress') or obj.get('EnableIPv6'):
                raise ValueError('F12 network drift')
            _files.validate_module_network(self.root, self.installation, obj, self.docker)
            for identity, member in (obj.get('Containers') or {}).items():
                if not hex_id(identity):
                    raise ValueError('Invalid F12 bridge member')
                item, = json.loads(self.docker('container', 'inspect', identity))
                labels = item['Config']['Labels'] or {}
                key = labels.get('pl.f12.segment')
                if (item['Id'] != identity or not hex_id(key) or member.get('Name') != self.container_name(instance, key)
                        or item.get('Name') != '/' + member['Name'] or labels.get('pl.f12.role') != 'edge'
                        or any(labels.get(k) != v for k, v in self.labels(instance).items())):
                    raise ValueError('Foreign member on F12 bridge')
        return obj

    def mounts(self, instance, segment):
        root = self.runtime(instance)
        if segment:
            config = root / 'edges' / segment
            mounts = {('bind', str(root / 'boot'), '/run/pl-f12/boot', False),
                      ('bind', str(config / 'edge.json'), '/etc/pl-f12/edge.json', False)}
            if self.automatic_pxe:
                mounts.add(('bind', str(config / 'pxe'), '/run/pl-f12/pxe', True))
            return mounts
        return {('volume', self.names(instance, '-data'), '/data', True),
                ('bind', str(root / 'admin'), '/run/pl-f12/admin', True),
                ('bind', str(root / 'boot'), '/run/pl-f12/boot', True)}

    def spec(self, instance, segment, state):
        role = 'edge' if segment else 'server'
        labels = {**self.labels(instance), 'pl.f12.role': role}
        ports = {}
        if segment:
            labels['pl.f12.segment'] = segment
            ports = {'8080/tcp': [{'HostIp': state['edges'][segment]['address'], 'HostPort': str(PORT)}]}
        return {'cmd': ['edge' if segment else 'serve'], 'labels': labels, 'ports': ports,
                'network': self.names(instance, '-net') if segment else 'none', 'mounts': self.mounts(instance, segment),
                'memory': 96 if segment else 1024, 'cpus': .5 if segment else 2, 'pids': 64 if segment else 256}

    def inspect(self, instance, segment=None, *, state=None, image=None):
        identity = self.container_id(instance, segment)
        if not identity:
            return None
        spec = self.spec(instance, segment, state if state is not None else self.state(instance))
        base = (image or self.verify_image())['Config']
        obj, = json.loads(self.docker('container', 'inspect', identity))
        cfg, host = obj['Config'], obj['HostConfig']
        mounts = {(m['Type'], m['Name'] if m['Type'] == 'volume' else m['Source'], m['Destination'], m['RW'])
                  for m in obj.get('Mounts') or []}
        if (obj['Id'] != identity or obj.get('Name') != '/' + self.container_name(instance, segment)
                or obj['Image'] != self.image['id'] or cfg.get('Image') != self.image['id']
                or cfg.get('Labels') != {**(base.get('Labels') or {}), **spec['labels']}
                or any(cfg.get(k) != base.get(k) for k in ('Entrypoint', 'User', 'Env', 'WorkingDir', 'Healthcheck'))
                or cfg.get('Cmd') != spec['cmd'] or mounts != spec['mounts'] or len(mounts) != len(obj['Mounts'])
                or (host.get('PortBindings') or {}) != spec['ports'] or host.get('NetworkMode') != spec['network']
                or set(obj['NetworkSettings'].get('Networks') or {}) != {spec['network']}
                or not host.get('ReadonlyRootfs') or host.get('CapDrop') != ['ALL'] or host.get('SecurityOpt') != ['no-new-privileges']
                or any(host.get(k) for k in ('Privileged','CapAdd','Devices','DeviceRequests','Binds','PublishAllPorts',
                                             'VolumesFrom','Links','ExtraHosts','PidMode','UTSMode','UsernsMode','GroupAdd'))
                or host.get('IpcMode') not in ('private', None) or (host.get('Tmpfs') or {}) != ({} if segment else TEMPFS)
                or host.get('Memory') != spec['memory'] * 1024**2 or host.get('NanoCpus') != int(spec['cpus'] * 1e9)
                or host.get('PidsLimit') != spec['pids'] or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('LogConfig') != LOGS):
            raise ValueError('F12 container configuration or ownership drift')
        if obj['State'].get('Running'):
            actual = {key: value for key, value in (obj['NetworkSettings'].get('Ports') or {}).items() if value}
            if actual != spec['ports']:
                raise ValueError('Unexpected F12 published ports')
        return obj

    def create(self, instance, segment=None, *, state=None):
        spec = self.spec(instance, segment, state if state is not None else self.state(instance))
        image = self.verify_image()
        args = ['container','create','--name',self.container_name(instance, segment),'--network',spec['network'],
                '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--restart','unless-stopped',
                '--memory',str(spec['memory'])+'m','--cpus',str(spec['cpus']),'--pids-limit',str(spec['pids']),
                '--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=2']
        if segment:
            binding = spec['ports']['8080/tcp'][0]
            args += ['-p', binding['HostIp'] + ':' + binding['HostPort'] + ':8080/tcp']
        else:
            args += ['--tmpfs', '/tmp:' + TEMPFS['/tmp']]
        for kind, source, dest, writable in sorted(spec['mounts']):
            args += ['--mount', f'type={kind},source={source},target={dest}' + ('' if writable else ',readonly')]
        for key, value in spec['labels'].items():
            args += ['--label', key + '=' + value]
        identity = self.docker(*args, self.image['id'], *spec['cmd']).decode().strip()
        obj = self.inspect(instance, segment, state=state, image=image)
        if not obj or obj['Id'] != identity:
            raise ValueError('F12 container creation unconfirmed')
        return obj

    def native(self, instance, obj, method, route, *, body=None, headers=None, timeout=25, limit=4 * 1024**2):
        pid = running_pid(obj)
        if not self.native_slots.acquire(blocking=False):
            raise Failure(429, 'Сервер занят. Повторите запрос.')
        connection = AdminConnection(self.runtime(instance) / 'admin', pid, timeout)
        try:
            connection.request(method, route, body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read(limit + 1)
            if len(data) > limit or response.status not in HTTP_STATUSES:
                raise unavailable()
            result = json.loads(data)
            if not isinstance(result, dict):
                raise unavailable()
            return response.status, result
        except (OSError, ValueError, http.client.HTTPException):
            raise unavailable() from None
        finally:
            connection.close()
            self.native_slots.release()

    def health(self, instance, obj):
        status, result = self.native(instance, obj, 'GET', '/health', timeout=4, limit=4096)
        if status != 200 or result.get('ready') is not True or type(result.get('busy')) is not bool:
            raise unavailable()
        return result

    def busy(self, instance, obj):
        return bool(obj and obj['State'].get('Running') and self.health(instance, obj)['busy'])

    def published_firmware(self, instance, main, state, key):
        with closing(AdminConnection(self.runtime(instance) / 'boot', running_pid(main), 1.5, 'boot.sock')) as conn:
            conn.request('GET', '/first-hop', headers={'X-PL-F12-Segment': key,
                         'X-PL-F12-Token': digest(state['secret'], 'boot', key)})
            response = conn.getresponse()
            data = response.read(257)
            if response.status != 200 or len(data) > 256:
                raise unavailable()
        value = json.loads(data)
        if not isinstance(value, dict) or set(value) != {'firmware'}:
            raise unavailable()
        return firmware_list(value['firmware'])

    def segment_pxe(self, instance, state, key, net, main, *, activate):
        identity = instance, key
        try:
            path = self.runtime(instance) / 'edges' / key / 'pxe'
            edge = self.inspect(instance, key, state=state)
            pid = running_pid(edge)
            status = pxe_command(path, pid, {'action': 'status'})['state']
            if not activate:
                return 'error' if status == 'waiting' and identity in self.pxe_errors else status
            if status == 'waiting':
                # An edge can request only the sockets for a committed publication.
                # The private server, kernel NIC inventory and container PID are verified independently.
                if not self.published_firmware(instance, main, state, key):
                    return 'idle'
                interface = net.get('interface')
                if not interface:
                    raise unavailable()
                with ExitStack() as opened:
                    sockets = open_pxe_sockets(opened, interface, net['address'])
                    status = pxe_command(path, pid, {'action': 'attach', 'interface': interface,
                                         'address': net['address'], 'cidr': net['cidr']}, sockets)['state']
            self.pxe_errors.discard(identity)
            return status
        except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException, subprocess.SubprocessError):
            if activate:
                self.pxe_errors.add(identity)
            return 'error'

    def reconcile_pxe(self, instance, state, networks, main):
        if self.automatic_pxe:
            for key in state['edges'].keys() & networks.keys():
                if networks[key].get('interface'):
                    self.segment_pxe(instance, state, key, networks[key], main, activate=True)

    def library_pxe(self, instance, state, networks, main, body):
        published = {key for row in body['items'] for key in row['segments']}
        statuses = {key: 'idle' if net.get('interface') else 'manual' for key, net in networks.items()}
        for key in published & networks.keys():
            if networks[key].get('interface'):
                statuses[key] = (self.segment_pxe(instance, state, key, networks[key], main, activate=False)
                                 if key in state['edges'] else 'error')
        return statuses

    def preflight_port(self, address):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind((address, PORT))
        except OSError:
            raise Failure(409, 'Порт 18080 занят или выбранный адрес недоступен.') from None

    def edge_ready(self, net):
        # A local hairpin can have the Docker gateway as its peer. An explicit
        # segment rejection still confirms that the owned HTTP edge is listening.
        address = net['address']
        conn = http.client.HTTPConnection(address, PORT, timeout=2, source_address=(address, 0))
        try:
            conn.request('GET', '/menu.ipxe')
            response = conn.getresponse()
            body = response.read(8192)
            if response.status == 200 and body.startswith(b'#!ipxe'):
                return
            if response.status == 403 and json.loads(body).get('error') == 'Доступ для этой сети закрыт.':
                return
            raise unavailable()
        finally:
            conn.close()

    def start(self, instance, obj, segment, state):
        if not obj['State'].get('Running'):
            if segment:
                self.preflight_port(state['edges'][segment]['address'])
            self.docker('container', 'start', obj['Id'])
            item = self.inspect(instance, segment, state=state)
            if not item or item['Id'] != obj['Id']:
                raise unavailable()
            obj = item
        deadline = time.monotonic() + 22
        while True:
            try:
                if segment:
                    self.edge_ready(state['edges'][segment])
                else:
                    self.health(instance, obj)
                return obj
            except (ValueError, OSError, http.client.HTTPException):
                if time.monotonic() >= deadline:
                    raise unavailable() from None
                time.sleep(.25)

    def stop(self, obj):
        if obj and obj['State'].get('Running'):
            self.docker('container', 'stop', '--timeout', '10', obj['Id'])

    def drop(self, obj):
        if obj:
            self.stop(obj)
            self.docker('container', 'rm', obj['Id'])

    def inventory(self, instance, state):
        # Discover stopped containers too. A duplicate label or an unknown name
        # makes lifecycle/DR ambiguous even if it is not on our bridge.
        args = ['container', 'ls', '-a', '--no-trunc', '--format', '{{.ID}}']
        for key, value in self.labels(instance).items():
            args.extend(['--filter', 'label=' + key + '=' + value])
        raw = self.docker(*args).decode().split()
        if len(raw) > 129 or any(not hex_id(i) for i in raw) or len(set(raw)) != len(raw):
            raise ValueError('Invalid F12 container inventory')
        image = self.verify_image() if raw else None
        result = {}
        for segment in (None, *state['edges']):
            obj = self.inspect(instance, segment, state=state, image=image)
            if obj:
                result[segment] = obj
        if set(raw) != {obj['Id'] for obj in result.values()}:
            raise ValueError('Unexpected F12 container')
        return result

    def ensure(self, instance):
        self.verify_image()
        path = self.path(instance, create=True)
        if not (path / 'state.json').exists():
            runtime = self.runtime(instance)
            if (list(path.iterdir()) or runtime.exists() or runtime.is_symlink() or self.inventory(instance, {'edges': {}})
                    or self.resource(instance, 'network') or self.resource(instance, 'volume')):
                raise ValueError('Unmanaged F12 resources exist')
            atomic(path / 'state.json', {'installation': self.installation, 'instance_id': instance,
                    'secret': secrets.token_hex(32), 'storage_created': False, 'edges': {}})
        state = self.state(instance)
        objects = self.inventory(instance, state)
        if not self.resource(instance, 'volume', create=not state['storage_created']):
            raise ValueError('F12 owned data volume missing')
        if not state['storage_created']:
            state['storage_created'] = True
            atomic(path / 'state.json', state)
        networks = self.sync_networks(state)
        primary = objects.get(None) or self.create(instance, state=state)
        primary = self.start(instance, primary, None, state)
        if state['edges']:
            self.resource(instance, 'network', create=True)
            for key in state['edges']:
                if key not in networks:
                    self.stop(objects.get(key))
            for key in state['edges'].keys() & networks.keys():
                obj = objects.get(key) or self.create(instance, key, state=state)
                self.start(instance, obj, key, state)
            self.reconcile_pxe(instance, state, networks, primary)

    def sync_networks(self, state):
        try:
            networks = self.host_networks(state)
        except (ValueError, KeyError, OSError, TypeError, subprocess.SubprocessError):
            # The native boot socket reevaluates this allowlist on every read.
            self.prepare_runtime(state, {})
            raise unavailable() from None
        self.prepare_runtime(state, networks)
        return networks

    def reconcile_interfaces(self, instance):
        # Runtime authorization must track link changes even when nobody has PL open.
        with self.locked(instance, exclusive=True):
            state = self.state(instance)
            if not state['edges']:
                return
            networks = self.sync_networks(state)
            current = frozenset(networks)
            previous = self.sampled_networks.get(instance)
            if current == previous and not self.automatic_pxe:
                return
            primary = self.inspect(instance, state=state)
            if primary and primary['State'].get('Running'):
                if current != previous:
                    for key in state['edges'].keys() - current:
                        self.stop(self.inspect(instance, key, state=state))
                    for key in (state['edges'].keys() & current) - (previous or set()):
                        obj = self.inspect(instance, key, state=state)
                        if obj and not obj['State'].get('Running'):
                            self.start(instance, obj, key, state)
                self.reconcile_pxe(instance, state, networks, primary)
            self.sampled_networks[instance] = current

    def disable(self, instance, state):
        objects = self.inventory(instance, state)
        if self.busy(instance, objects.get(None)):
            raise Failure(409, 'Образ обрабатывается. Дождитесь завершения импорта.')
        for key in state['edges']:
            self.stop(objects.get(key))
        self.stop(objects.get(None))

    def remove_runtime(self, state):
        root = self.runtime(state['instance_id'])
        if not root.exists() and not root.is_symlink():
            return
        directory(root, create=False)
        if {p.name for p in root.iterdir()} - {'admin', 'boot', 'edges'}:
            raise ValueError('Unexpected F12 runtime files')
        edges = root / 'edges'
        directories = [root]
        files = []
        if edges.exists():
            directory(edges, create=False)
            directories.append(edges)
            for item in edges.iterdir():
                if item.name not in state['edges']:
                    raise ValueError('Unowned F12 edge configuration')
                directory(item, create=False)
                directories.append(item)
                if {p.name for p in item.iterdir()} - {'edge.json', 'pxe'}:
                    raise ValueError('Unowned F12 edge file')
                remove_pxe_directory(item / 'pxe')
                if (item / 'edge.json').exists() or (item / 'edge.json').is_symlink():
                    files.append((item / 'edge.json', False))
        for kind, allowed in {'admin': {'admin.sock', 'networks.json'}, 'boot': {'boot.sock'}}.items():
            path = root / kind
            if not path.exists() and not path.is_symlink():
                continue
            private_dir(path, 0o1770, UID)
            directories.append(path)
            for item in path.iterdir():
                if item.name not in allowed:
                    raise ValueError('Unexpected F12 socket directory entry')
                files.append((item, item.suffix == '.sock'))
        for file, is_socket in files:
            info = file.lstat()
            if (is_socket and not (stat.S_ISSOCK(info.st_mode) and info.st_uid == UID and info.st_gid == UID)
                    or not is_socket and not (stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                                              and info.st_gid == UID and stat.S_IMODE(info.st_mode) == 0o440 and info.st_nlink == 1)):
                raise ValueError('Unowned F12 runtime entry')
        for file, _ in files:
            file.unlink(missing_ok=True)
        for path in reversed(directories):
            path.rmdir()

    def remove(self, instance):
        path = self.instances / identifier(instance)
        if not path.exists() and not path.is_symlink():
            self.observe(instance)
            return
        self.path(instance)
        entries = {item.name for item in path.iterdir()}
        if not entries:
            runtime = self.runtime(instance)
            if (runtime.exists() or runtime.is_symlink() or self.inventory(instance, {'edges': {}})
                    or self.resource(instance, 'network') or self.resource(instance, 'volume')):
                raise ValueError('F12 resources have no private state')
            path.rmdir()
            _files.fsync_directory(self.instances)
            return
        if entries != {'state.json'}:
            raise ValueError('Unexpected F12 instance files')
        state = self.state(instance)
        objects = self.inventory(instance, state)
        volume = self.resource(instance, 'volume')
        network = self.resource(instance, 'network')
        if volume:
            users = set(self.docker('container', 'ls', '-a', '--no-trunc', '--filter',
                                    'volume=' + volume['Name'], '--format', '{{.ID}}').decode().split())
            if users - ({objects[None]['Id']} if None in objects else set()):
                raise ValueError('Foreign user of F12 data volume')
        if self.busy(instance, objects.get(None)):
            raise Failure(409, 'Образ обрабатывается. Дождитесь завершения импорта.')
        for key in state['edges']:
            self.drop(objects.get(key))
        self.drop(objects.get(None))
        self.remove_runtime(state)
        if network:
            self.docker('network', 'rm', network['Id'])
        if volume:
            self.docker('volume', 'rm', volume['Name'])
        (path / 'state.json').unlink()
        self.sampled_networks.pop(instance, None)
        for key in state['edges']:
            self.pxe_errors.discard((instance, key))
        path.rmdir()
        _files.fsync_directory(self.instances)

    def observe(self, instance):
        path = self.instances / identifier(instance)
        common = {'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        if not path.exists() and not path.is_symlink():
            if self.inventory(instance, {'edges': {}}) or self.resource(instance, 'network') or self.resource(instance, 'volume'):
                raise ValueError('F12 artifacts without state')
            return {**common, 'state': 'absent'}
        state = self.state(instance)
        primary = self.inspect(instance, state=state)
        if not primary or not self.resource(instance, 'volume'):
            raise unavailable()
        running = bool(primary['State'].get('Running'))
        if running:
            self.sync_networks(state)
            self.health(instance, primary)
        return {**common, 'state': 'running' if running else 'disabled', 'version': self.version}

    def get(self, instance):
        with self.locked(instance):
            return self.observe(instance)

    def execute(self, body):
        if (not isinstance(body, dict) or set(body) != {'operation_id', 'instance_id', 'action', 'module_id'}
                or body['module_id'] != 'f12' or body['action'] not in ('install', 'enable', 'refresh', 'disable', 'remove')):
            raise ValueError('Invalid F12 lifecycle operation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        journal = self.operations / (operation + '.json')
        fingerprint = hashlib.sha256(encoded(body)).hexdigest()
        mutable = body['action'] != 'refresh'
        with _files.operation_lock(self.operations, operation), self.locked(instance, exclusive=mutable), \
                (host_lock(self.root / 'modules/controller.lock') if mutable else nullcontext()):
            if journal.exists() or journal.is_symlink():
                record = json.loads(read_file(journal))
                if record.get('fingerprint') != fingerprint:
                    raise ValueError('F12 operation identity conflict')
                if record.get('phase') == 'complete':
                    return {**self.observe(instance), 'operation_id': operation}
            atomic(journal, {'fingerprint': fingerprint, 'phase': 'running'})
            try:
                if body['action'] in ('install', 'enable'):
                    self.ensure(instance)
                elif body['action'] == 'remove':
                    self.remove(instance)
                elif body['action'] == 'disable' and (self.instances / instance).exists():
                    self.disable(instance, self.state(instance))
                result = self.observe(instance)
                atomic(journal, {'fingerprint': fingerprint, 'phase': 'complete'})
                return {**result, 'operation_id': operation}
            except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError, http.client.HTTPException) as error:
                message = str(error) if isinstance(error, Failure) else _files.module_network_error(
                    error, 'Проверьте состояние экземпляра сетевой загрузки на сервере PL.')
                return {'state': 'error', 'operation_id': operation, 'version': '', 'endpoint': '',
                        'targets_up': 0, 'targets_total': 0, 'error': message}

    def rollback_edges(self, instance, state, additions, created_network, previous):
        for key, obj in previous.items():
            if key in additions or obj and obj['State'].get('Running'):
                continue
            restored = self.inspect(instance, key, state=state)
            if obj:
                self.stop(restored)
            else:
                self.drop(restored)
        for key in additions:
            self.drop(self.inspect(instance, key, state=state))
        if created_network and not state['edges'].keys() - set(additions):
            network = self.resource(instance, 'network')
            if network:
                self.docker('network', 'rm', network['Id'])
        for key in additions:
            path = self.runtime(instance) / 'edges' / key
            if path.exists() or path.is_symlink():
                directory(path, create=False)
                file = path / 'edge.json'
                if file.exists() or file.is_symlink():
                    # Validate ownership before unlinking the generated configuration.
                    runtime_json(file, {'id': key, **state['edges'][key], 'token': digest(state['secret'], 'boot', key)})
                    file.unlink()
                remove_pxe_directory(path / 'pxe')
                path.rmdir()
            del state['edges'][key]
        atomic(self.path(instance) / 'state.json', state)

    def forward(self, instance, main, request, action, payload, spool):
        if spool is None:
            data = encoded({'action': action, 'payload': payload, 'actor': request['actor']})
            return self.native(instance, main, 'POST', '/request', body=data,
                               headers={'Content-Type': 'application/json'})
        headers = {'Content-Type': 'application/octet-stream', 'Content-Length': str(request['body_length']),
                   'X-PL-F12-Actor': request['actor'], 'X-PL-F12-Upload': payload['id'],
                   'X-PL-F12-Offset': str(payload['offset']), 'X-PL-F12-SHA256': request['body_sha256']}
        return self.native(instance, main, 'POST', '/chunk', body=spool, headers=headers)

    def forward_with_edges(self, instance, main, state, networks, request):
        selected = request['payload']['segments']
        if any(key not in networks for key in selected):
            raise Failure(409, 'Выбранный интерфейс изменился. Обновите список сетей.')
        if not selected:
            return self.forward(instance, main, request, request['action'], request['payload'], None)
        old = state['edges']
        additions = [key for key in selected if key not in old]
        if len(old) + len(additions) > 128:
            raise Failure(409, 'Достигнут предел числа сетей экземпляра.')
        for key in old.keys() - networks.keys():
            self.stop(self.inspect(instance, key, state=state))
        current = {}
        for key in selected:
            if key in additions and self.container_id(instance, key):
                raise Failure(409, 'Имя сетевого слушателя занято.')
            current[key] = None if key in additions else self.inspect(instance, key, state=state)
            if not current[key] or not current[key]['State'].get('Running'):
                self.preflight_port(networks[key]['address'])
        had_network = self.resource(instance, 'network') is not None
        state['edges'] = {**old, **{key: {k: v for k, v in networks[key].items() if k != 'interface'} for key in additions}}
        if additions:
            atomic(self.path(instance) / 'state.json', state)
        try:
            self.prepare_runtime(state, networks)
            bridge = self.resource(instance, 'network', create=True)
            subnet = ipaddress.IPv4Network(bridge['IPAM']['Config'][0]['Subnet'])
            # Docker reserves the network, broadcast and gateway addresses.
            if len(state['edges']) > subnet.num_addresses - 3:
                raise Failure(409, 'В сети модуля закончились адреса для новых слушателей.')
            for key in selected:
                edge = current[key] or self.create(instance, key, state=state)
                self.start(instance, edge, key, state)
        except (ValueError, KeyError, OSError, http.client.HTTPException) as error:
            self.rollback_edges(instance, state, additions, not had_network, current)
            if isinstance(error, Failure) and error.status == 409:
                raise
            if getattr(error, 'public_code', None) == 'module_network_pool_exhausted':
                raise Failure(409, 'PL не нашла свободную внутреннюю подсеть /28 для F12.') from None
            raise Failure(409, 'Не удалось подготовить службу публикации F12 в выбранной сети.') from None
        # Once native may have committed, keep a passive edge on an ambiguous
        # transport error. Native checks the committed publication on each read.
        status, body = self.forward(instance, main, request, request['action'], request['payload'], None)
        if 400 <= status < 500 or status == 507:
            self.rollback_edges(instance, state, additions, not had_network, current)
        return status, body

    def request(self, request, spool=None):
        instance = identifier(request.get('instance_id') if isinstance(request, dict) else None)
        try:
            action, payload = parse_request(request, spool is not None)
            with self.locked(instance, exclusive=action in ('upload-start', 'publish')):
                if not (self.instances / instance).exists():
                    raise Failure(404, 'Сетевая загрузка не установлена.')
                state = self.state(instance)
                main = self.inspect(instance, state=state)
                if not main or not main['State'].get('Running') or main['State'].get('Restarting'):
                    raise Failure(503, 'Сервер сетевой загрузки остановлен.')
                if action in ('library', 'menu', 'publish', 'upload-start', 'upload-finish'):
                    networks = self.sync_networks(state)
                    if action == 'menu' and payload['segment'] not in networks:
                        raise Failure(404, 'Сеть не найдена.')
                if action in ('upload-start', 'publish') and payload['segments']:
                    with host_lock(self.root / 'modules/controller.lock'):
                        status, body = self.forward_with_edges(instance, main, state, networks, request)
                else:
                    status, body = self.forward(instance, main, request, action, payload, spool)
                if status == 200 and self.automatic_pxe:
                    if action in ('publish', 'upload-finish'):
                        self.reconcile_pxe(instance, state, networks, main)
                    elif action == 'library':
                        body['pxe'] = self.library_pxe(instance, state, networks, main, body)
        except Failure as error:
            status, body = error.status, {'error': str(error)}
        except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException, subprocess.SubprocessError):
            status, body = 503, {'error': 'Проверьте состояние сервера сетевой загрузки.'}
        return {'instance_id': instance, 'status': status, 'body': body}
