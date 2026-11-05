"""Install and remove the socket-activated ICMP helper for one PL installation.

Only trusted root-side installer code should call this module.  The caller validates
its package manifest and serializes installation operations with its existing lock.
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import time

IDENTITY = re.compile(r'pl-[0-9a-f]{12}\Z')
SIMPLE_PATH = re.compile(r'/[A-Za-z0-9_./-]+\Z')


def _checked_dir(path, owner, *, mode=None):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
        raise ValueError('unsafe directory: ' + str(path))
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise ValueError('unexpected directory mode: ' + str(path))


def _traversable_chain(path, boundary, owner):
    """All host path components must be trusted and traversable by DynamicUser."""
    cursor = path
    while True:
        _checked_dir(cursor, owner)
        if not cursor.stat().st_mode & 0o001:
            raise ValueError('ICMP host directory is not publicly traversable: ' + str(cursor))
        if cursor == boundary:
            break
        if cursor == cursor.parent:
            raise ValueError('invalid host directory boundary')
        cursor = cursor.parent


def _check_helper_parents(path, boundary, owner):
    _traversable_chain(path, boundary, owner)
    _checked_dir(path, owner, mode=0o755)
    _checked_dir(path.parent, owner, mode=0o755)


def _checked_file(path, owner, *, mode=None, executable=False, read=True):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1
            or info.st_mode & 0o6022 or (executable and not info.st_mode & 0o111)):
        raise ValueError('unsafe file: ' + str(path))
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise ValueError('unexpected file mode: ' + str(path))
    if not read:
        return None
    if info.st_size > 1 << 20:
        raise ValueError('oversized file: ' + str(path))
    return path.read_bytes()


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _mkdir(path, owner, created, mode=0o755):
    if path.exists() or path.is_symlink():
        _checked_dir(path, owner)
        return
    path.mkdir(mode=mode)
    os.chmod(path, mode)
    created.append(path)
    _checked_dir(path, owner, mode=mode)


def _write_new(path, data, mode, created):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    created.append(path)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        raise


def _identity(root, install_id, owner):
    if not IDENTITY.fullmatch(install_id):
        raise ValueError('invalid installation identity')
    root = Path(root)
    if not root.is_absolute() or root == Path('/') or root != root.resolve() or not SIMPLE_PATH.fullmatch(str(root)):
        raise ValueError('invalid installation root')
    _checked_dir(root, owner)
    private = root / 'private'
    _checked_dir(private, owner, mode=0o700)
    _checked_dir(root / 'state', owner)
    marker = json.loads(_checked_file(root / '.pl-installation.json', owner))
    state = json.loads(_checked_file(root / 'state/installation.json', owner))
    if marker.get('product') not in ('PL', 'Pl') or state.get('product') not in ('PL', 'Pl') or state.get('install_id') != install_id:
        raise ValueError('installation identity mismatch')
    return root, marker


def _paths(root, install_id, prefix):
    def host(path):
        return prefix / path.lstrip('/') if prefix else Path(path)
    base = host('/usr/local/lib/pl/icmp')
    policy = host('/etc/pl/icmp')
    units = host('/etc/systemd/system')
    name = install_id + '-icmp-probe'
    return {'payload_dir': base / install_id, 'payload': base / install_id / 'probe.py',
            'policy_dir': policy / install_id, 'policy': policy / install_id / 'cidrs.json',
            'service': units / (name + '.service'), 'socket_unit': units / (name + '.socket'),
            'runtime': root / 'run/icmp-probe', 'socket': root / 'run/icmp-probe/probe.sock',
            'marker': root / 'private/icmp-helper.json', 'runtime_marker': root / 'private/icmp-runtime-owner.json',
            'binary': host('/usr/sbin/hping3')}


def _health_once(path):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(1)
        connection.connect(str(path))
        connection.sendall(b'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
        response = bytearray()
        while len(response) <= 4096:
            part = connection.recv(4096)
            if not part:
                break
            response.extend(part)
        if len(response) > 4096:
            raise ValueError('oversized helper health response')
    headers, sep, body = bytes(response).partition(b'\r\n\r\n')
    if not sep or not headers.startswith(b'HTTP/1.1 200 ') or json.loads(body) != {'status': 'ready'}:
        raise ValueError('helper health check failed')


def _health(path):
    deadline = time.monotonic() + 10
    while True:
        try:
            _health_once(path)
            return
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                raise ValueError('ICMP helper health check timed out')
            time.sleep(0.1)


def _units(paths, install_id, gid):
    name = install_id + '-icmp-probe'
    socket_unit = (f'[Unit]\nDescription=PL ICMP probe socket\n[Socket]\nListenStream={paths["socket"]}\n'
                   f'SocketMode=0660\nSocketGroup={gid}\nDirectoryMode=0755\nRemoveOnStop=yes\n'
                   '[Install]\nWantedBy=sockets.target\n')
    service = (f'[Unit]\nDescription=PL fixed ICMP probe\nRequires={name}.socket\nAfter={name}.socket\n'
               f'[Service]\nExecStart=/usr/bin/python3 -B {paths["payload"]} --policy {paths["policy"]}\n'
               'DynamicUser=yes\nNoNewPrivileges=yes\nCapabilityBoundingSet=CAP_NET_RAW\n'
               'AmbientCapabilities=CAP_NET_RAW\nRestrictAddressFamilies=AF_UNIX AF_INET AF_PACKET\n'
               'PrivateTmp=yes\nPrivateDevices=yes\nProtectSystem=strict\nProtectHome=yes\n'
               'ProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectKernelLogs=yes\n'
               'ProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictNamespaces=yes\n'
               'LockPersonality=yes\nMemoryMax=96M\nTasksMax=16\nUMask=0077\nTimeoutStopSec=30s\n')
    return socket_unit.encode(), service.encode()


def _validate_socket(path, owner, gid):
    if not (path.exists() or path.is_symlink()):
        return
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != owner or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o660:
        raise ValueError('foreign or unsafe ICMP socket')


def _runtime_record(paths, install_id, root, gid):
    info = paths['runtime'].stat()
    return {'schema': 1, 'install_id': install_id, 'root': str(root), 'gid': gid,
            'device': info.st_dev, 'inode': info.st_ino}


def _verify_runtime(paths, install_id, root, gid, owner):
    _checked_dir(paths['runtime'], owner, mode=0o755)
    record = json.loads(_checked_file(paths['runtime_marker'], owner, mode=0o600))
    if record != _runtime_record(paths, install_id, root, gid):
        raise ValueError('ICMP runtime directory ownership mismatch')


def _verify(paths, record, owner):
    if not isinstance(record, dict) or set(record) != {'schema', 'install_id', 'root', 'gid', 'hashes'} or record['schema'] != 1:
        raise ValueError('invalid ICMP ownership metadata')
    hashes = record['hashes']
    names = ('payload', 'policy', 'service', 'socket_unit')
    if not isinstance(hashes, dict) or set(hashes) != set(names):
        raise ValueError('invalid ICMP ownership hashes')
    _verify_runtime(paths, record['install_id'], Path(record['root']), record['gid'], owner)
    for directory in (paths['payload_dir'], paths['policy_dir'], paths['runtime']):
        _checked_dir(directory, owner, mode=0o755)
    for name in names:
        expected_mode = 0o755 if name == 'payload' else 0o644
        if _sha(_checked_file(paths[name], owner, mode=expected_mode)) != hashes[name]:
            raise ValueError('ICMP owned file changed: ' + name)
    if {p.name for p in paths['payload_dir'].iterdir()} != {'probe.py'} or {p.name for p in paths['policy_dir'].iterdir()} != {'cidrs.json'}:
        raise ValueError('foreign files in ICMP helper directory')
    if {p.name for p in paths['runtime'].iterdir()} - {'probe.sock'}:
        raise ValueError('foreign files in ICMP runtime directory')
    _validate_socket(paths['socket'], owner, record['gid'])


def _configuration(cidrs):
    if not isinstance(cidrs, (tuple, list)) or len(cidrs) > 64:
        raise ValueError('invalid diagnostic CIDRs')
    values = []
    for value in cidrs:
        try:
            network = ipaddress.ip_network(value, strict=True)
        except (TypeError, ValueError) as exc:
            raise ValueError('invalid diagnostic CIDRs') from exc
        if network.version != 4 or str(network) != value or value in values:
            raise ValueError('invalid diagnostic CIDRs')
        values.append(value)
    return (json.dumps({'cidrs': values}, indent=2) + '\n').encode()


def prepare(root, package, install_id, cidrs, api_gid, run, *, _host_prefix=None):
    """Prepare fixed unit/policy, activate socket and verify health; return socket path."""
    owner = os.geteuid() if _host_prefix is not None else 0
    if os.geteuid() != owner:
        raise ValueError('root is required')
    prefix = Path(_host_prefix).resolve() if _host_prefix is not None else None
    root, identity = _identity(root, install_id, owner)
    if type(api_gid) is not int or api_gid <= 0 or identity.get('gid') != api_gid:
        raise ValueError('API group does not match installation identity')
    paths = _paths(root, install_id, prefix)
    if len(os.fsencode(paths['socket'])) > 107:
        raise ValueError('ICMP Unix socket path exceeds 107 bytes')
    for path in paths.values():
        if not SIMPLE_PATH.fullmatch(str(path)):
            raise ValueError('unsafe systemd path')
    policy = _configuration(cidrs)
    payload = _checked_file(Path(package) / 'icmp-probe.py', owner)
    if not payload or len(payload) > 1 << 20:
        raise ValueError('invalid helper payload')
    _checked_file(paths['binary'], owner, executable=True, read=False)
    socket_unit, service = _units(paths, install_id, api_gid)
    contents = {'payload': payload, 'policy': policy, 'socket_unit': socket_unit, 'service': service}
    record = {'schema': 1, 'install_id': install_id, 'root': str(root), 'gid': api_gid,
              'hashes': {name: _sha(value) for name, value in contents.items()}}
    name = install_id + '-icmp-probe'
    if paths['marker'].exists() or paths['marker'].is_symlink():
        old = json.loads(_checked_file(paths['marker'], owner, mode=0o600))
        if old != record:
            raise ValueError('ICMP helper differs; upgrade is a separate operation')
        for key in ('payload_dir', 'policy_dir'):
            _check_helper_parents(paths[key].parent, prefix or Path('/'), owner)
        _traversable_chain(paths['service'].parent, prefix or Path('/'), owner)
        _checked_dir(root / 'run', owner)
        _verify(paths, old, owner)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', '--now', name + '.socket'])
        run(['systemctl', 'is-active', '--quiet', name + '.socket'])
        _health(paths['socket'])
        return str(paths['socket'])
    for key in ('payload_dir', 'policy_dir', 'service', 'socket_unit'):
        if paths[key].exists() or paths[key].is_symlink():
            raise ValueError('foreign ICMP helper path: ' + str(paths[key]))
    runtime_exists = paths['runtime'].exists() or paths['runtime'].is_symlink()
    runtime_marker_exists = paths['runtime_marker'].exists() or paths['runtime_marker'].is_symlink()
    if runtime_exists != runtime_marker_exists:
        raise ValueError('unowned ICMP runtime directory')
    if runtime_exists:
        _verify_runtime(paths, install_id, root, api_gid, owner)
        if any(paths['runtime'].iterdir()):
            raise ValueError('foreign files in ICMP runtime directory')
    created = []
    activated = False
    try:
        # The shared parents are never claimed or removed; verify every ancestor.
        for parent in (paths['payload_dir'].parent, paths['policy_dir'].parent):
            missing = []
            cursor = parent
            while not cursor.exists() and not cursor.is_symlink():
                missing.append(cursor)
                cursor = cursor.parent
            _checked_dir(cursor, owner)
            for directory in reversed(missing):
                _mkdir(directory, owner, created)
            _check_helper_parents(parent, prefix or Path('/'), owner)
        _traversable_chain(paths['service'].parent, prefix or Path('/'), owner)
        _checked_dir(root / 'run', owner)
        for key in ('payload_dir', 'policy_dir'):
            _mkdir(paths[key], owner, created)
        if not runtime_exists:
            _mkdir(paths['runtime'], owner, created)
            runtime_record = _runtime_record(paths, install_id, root, api_gid)
            _write_new(paths['runtime_marker'], (json.dumps(runtime_record, indent=2) + '\n').encode(), 0o600, created)
        for key in ('payload', 'policy', 'socket_unit', 'service'):
            _write_new(paths[key], contents[key], 0o755 if key == 'payload' else 0o644, created)
        _write_new(paths['marker'], (json.dumps(record, indent=2) + '\n').encode(), 0o600, created)
        run(['systemctl', 'daemon-reload'])
        activated = True
        run(['systemctl', 'enable', '--now', name + '.socket'])
        run(['systemctl', 'is-active', '--quiet', name + '.socket'])
        _health(paths['socket'])
        return str(paths['socket'])
    except BaseException as exc:
        if activated:
            try:
                run(['systemctl', 'disable', '--now', name + '.socket'])
                run(['systemctl', 'stop', name + '.service'])
                _validate_socket(paths['socket'], owner, api_gid)
                paths['socket'].unlink(missing_ok=True)
            except Exception as rollback:
                raise ValueError('ICMP activation failed; owned files retained for removal: ' + str(rollback)) from exc
        for path in reversed(created):
            if path.is_dir() and not path.is_symlink():
                try: path.rmdir()
                except OSError: pass
            else:
                path.unlink(missing_ok=True)
        try: run(['systemctl', 'daemon-reload'])
        except Exception: pass
        raise


def remove(root, install_id, run, *, _host_prefix=None):
    """Remove only a fully verified helper belonging to this installation."""
    owner = os.geteuid() if _host_prefix is not None else 0
    if os.geteuid() != owner:
        raise ValueError('root is required')
    prefix = Path(_host_prefix).resolve() if _host_prefix is not None else None
    root, identity = _identity(root, install_id, owner)
    paths = _paths(root, install_id, prefix)
    if not paths['marker'].exists() and not paths['marker'].is_symlink():
        raise ValueError('ICMP ownership metadata missing')
    record = json.loads(_checked_file(paths['marker'], owner, mode=0o600))
    if record.get('install_id') != install_id or record.get('root') != str(root) or record.get('gid') != identity.get('gid'):
        raise ValueError('ICMP ownership identity mismatch')
    for key in ('payload_dir', 'policy_dir'):
        _check_helper_parents(paths[key].parent, prefix or Path('/'), owner)
    _traversable_chain(paths['service'].parent, prefix or Path('/'), owner)
    _checked_dir(root / 'run', owner)
    _verify(paths, record, owner)
    name = install_id + '-icmp-probe'
    run(['systemctl', 'disable', '--now', name + '.socket'])
    run(['systemctl', 'stop', name + '.service'])
    _validate_socket(paths['socket'], owner, record['gid'])
    paths['socket'].unlink(missing_ok=True)
    for key in ('service', 'socket_unit', 'payload', 'policy'):
        paths[key].unlink()
    for key in ('payload_dir', 'policy_dir'):
        paths[key].rmdir()
    paths['marker'].unlink()
    run(['systemctl', 'daemon-reload'])
