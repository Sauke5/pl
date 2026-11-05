"""Install and remove the socket-activated ICMP helper for one PL installation.

Only trusted root-side installer code should call this module.  The caller validates
its package manifest and serializes installation operations with its existing lock.
"""
import hashlib
import base64
from contextlib import contextmanager
import fcntl
import grp
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import time
import uuid

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
    # systemd.socket documents a group name. A numeric string is not portable
    # across systemd versions and can fail with status=216/GROUP.
    group = grp.getgrgid(gid).gr_name
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,63}', group):
        raise ValueError('invalid API socket group name')
    socket_unit = (f'[Unit]\nDescription=PL ICMP probe socket\n[Socket]\nListenStream={paths["socket"]}\n'
                   f'SocketMode=0660\nSocketGroup={group}\nDirectoryMode=0755\nRemoveOnStop=yes\n'
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
    mode = None
    if isinstance(cidrs, dict):
        mode = cidrs.get('mode')
        if mode == 'interactive' and set(cidrs) <= {'mode', 'cidrs'} and cidrs.get('cidrs', []) == []:
            return b'{"mode":"interactive"}\n'
        if mode != 'cidr' or set(cidrs) != {'mode', 'cidrs'}:
            raise ValueError('invalid diagnostic policy')
        cidrs = cidrs['cidrs']
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
    return (json.dumps({**({'mode': mode} if mode else {}), 'cidrs': values}, indent=2) + '\n').encode()


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


def _atomic(path, data, mode=0o600):
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def _json(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def _file_record(path, owner):
    if not path.exists() and not path.is_symlink():
        return None
    data = _checked_file(path, owner)
    return {'sha256': _sha(data), 'data': base64.b64encode(data).decode(), 'mode': stat.S_IMODE(path.stat().st_mode)}


def _record(data, mode):
    return {'sha256': _sha(data), 'data': base64.b64encode(data).decode(), 'mode': mode}


def _unit_state(run, name):
    raw = run(['systemctl', 'show', '--property=LoadState,ActiveState,UnitFileState', name]).decode()
    fields = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    if fields.get('ActiveState') not in ('active', 'inactive', 'failed'):
        raise ValueError('ICMP unit is changing state; retry after it settles')
    if fields.get('UnitFileState', '') not in ('', 'enabled', 'disabled', 'static'):
        raise ValueError('Unsupported ICMP unit enablement')
    return {'active': fields['ActiveState'] == 'active', 'enabled': fields.get('UnitFileState') == 'enabled',
            'load': fields.get('LoadState')}


def _activation_paths(paths, install_id, owner):
    units = paths['service'].parent
    for suffix in ('.service.d', '.socket.d'):
        path = units / (install_id + '-icmp-probe' + suffix)
        if path.exists() or path.is_symlink():
            raise ValueError('Foreign ICMP unit override')
    link = units / 'sockets.target.wants' / paths['socket_unit'].name
    if link.exists() or link.is_symlink():
        info = link.lstat()
        if not stat.S_ISLNK(info.st_mode) or info.st_uid != owner or link.resolve() != paths['socket_unit']:
            raise ValueError('Foreign ICMP activation link')


def transaction(root, package, install_id, operation_id, policy, run, *, _host_prefix=None):
    owner = os.geteuid() if _host_prefix is not None else 0
    with _host_lock(root, owner):
        _active_operation(root, operation_id, 'plan', owner)
        return _plan(root, package, install_id, operation_id, policy, run, _host_prefix=_host_prefix)


def _plan(root, package, install_id, operation_id, policy, run, *, _host_prefix=None):
    """Save immutable old/new host state before apt, quiescence or host changes.

    The owned runtime inode is retained, just as by remove(). A new empty runtime
    and its marker may be created here; they carry no application data or rights.
    """
    owner = os.geteuid() if _host_prefix is not None else 0
    root, identity = _identity(root, install_id, owner)
    if str(uuid.UUID(operation_id)) != operation_id:
        raise ValueError('Invalid ICMP operation identity')
    prefix = Path(_host_prefix).resolve() if _host_prefix is not None else None
    paths = _paths(root, install_id, prefix)
    gid = identity.get('gid')
    if type(gid) is not int or gid <= 0:
        raise ValueError('Invalid ICMP API group')
    if len(os.fsencode(paths['socket'])) > 107:
        raise ValueError('ICMP Unix socket path exceeds 107 bytes')
    _activation_paths(paths, install_id, owner)
    old = None
    if paths['marker'].exists() or paths['marker'].is_symlink():
        old = json.loads(_checked_file(paths['marker'], owner, mode=0o600))
        if (old.get('install_id'), old.get('root'), old.get('gid')) != (install_id, str(root), gid):
            raise ValueError('ICMP ownership identity mismatch')
        _verify(paths, old, owner)
    else:
        for key in ('payload_dir', 'policy_dir', 'service', 'socket_unit'):
            if paths[key].exists() or paths[key].is_symlink():
                raise ValueError('Foreign ICMP helper path')
    _checked_dir(root / 'run', owner)
    if paths['runtime'].exists() or paths['runtime'].is_symlink() or paths['runtime_marker'].exists() or paths['runtime_marker'].is_symlink():
        _verify_runtime(paths, install_id, root, gid, owner)
        if {p.name for p in paths['runtime'].iterdir()} - ({'probe.sock'} if old else set()):
            raise ValueError('Foreign files in ICMP runtime directory')
    else:
        paths['runtime'].mkdir(mode=0o755)
        paths['runtime'].chmod(0o755)
        _atomic(paths['runtime_marker'], _json(_runtime_record(paths, install_id, root, gid)))
    socket_unit, service = _units(paths, install_id, gid)
    contents = {'payload': _checked_file(Path(package) / 'icmp-probe.py', owner),
                'policy': _configuration(policy), 'socket_unit': socket_unit, 'service': service}
    marker = {'schema': 1, 'install_id': install_id, 'root': str(root), 'gid': gid,
              'hashes': {key: _sha(value) for key, value in contents.items()}}
    contents['marker'] = _json(marker)
    plan = {'schema': 1, 'installation': install_id, 'root': str(root), 'operation_id': operation_id,
            'runtime': _runtime_record(paths, install_id, root, gid),
            'old': {key: _file_record(paths[key], owner) for key in contents},
            'new': {key: _record(value, 0o755 if key == 'payload' else 0o644 if key != 'marker' else 0o600)
                    for key, value in contents.items()},
            'units': {kind: _unit_state(run, install_id + '-icmp-probe.' + kind) for kind in ('socket', 'service')}}
    if not old and any(state['active'] or state['enabled'] or state['load'] != 'not-found' for state in plan['units'].values()):
        raise ValueError('Unowned active ICMP unit')
    folder = root / 'private/upgrade-backups'
    folder.mkdir(mode=0o700, exist_ok=True)
    _checked_dir(folder, owner, mode=0o700)
    folder = folder / operation_id
    folder.mkdir(mode=0o700, exist_ok=True)
    _checked_dir(folder, owner, mode=0o700)
    path = folder / 'icmp-host.json'
    fingerprint = _sha(_json(plan))
    if path.exists() or path.is_symlink():
        saved = _transaction(path, root, install_id, operation_id, fingerprint, owner)
        if saved['plan'] != plan:
            raise ValueError('ICMP transaction already belongs to different host state')
    else:
        _atomic(path, _json({'plan': plan, 'phase': 'prepared'}))
    return fingerprint


def _transaction(path, root, install_id, operation_id, expected, owner):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4 * 1024**2):
        raise ValueError('Unsafe ICMP recovery record')
    value = json.loads(path.read_bytes())
    plan = value['plan']
    if (plan.get('schema') != 1 or plan.get('installation') != install_id or plan.get('root') != str(root)
            or plan.get('operation_id') != operation_id or _sha(_json(plan)) != expected
            or set(plan.get('old', {})) != {'payload', 'policy', 'service', 'socket_unit', 'marker'}
            or plan['new'].keys() != plan['old'].keys()
            or value.get('phase') not in ('prepared', 'applying', 'applied', 'restoring', 'restored')):
        raise ValueError('ICMP recovery identity or integrity differs')
    for records in (plan['old'], plan['new']):
        for key, record in records.items():
            if record is None and records is plan['old']:
                continue
            data = base64.b64decode(record['data'], validate=True)
            mode = 0o755 if key == 'payload' else 0o600 if key == 'marker' else 0o644
            if _sha(data) != record['sha256'] or record['mode'] != mode:
                raise ValueError('Invalid ICMP recovery file')
    return value


def _active_operation(root, operation_id, action, owner):
    current = json.loads(_checked_file(Path(root) / 'state/delivery/operation.json', owner, mode=0o600))
    phases = {'plan': ('downloading', 'validating_configuration'), 'dependency': ('preparing_host',),
              'apply': ('applying', 'applying_configuration'), 'restore': ('restoring', 'restoring_configuration')}
    if current.get('operation_id') != operation_id or current.get('phase') not in phases[action]:
        raise ValueError('ICMP action no longer belongs to the active operation phase')
    return current


@contextmanager
def _host_lock(root, owner):
    _checked_dir(Path(root), owner)
    _checked_dir(Path(root) / 'state', owner)
    fd = os.open(Path(root) / 'state/icmp-host.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Unsafe ICMP host lock')
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def transition(root, install_id, operation_id, expected, action, run, *, _host_prefix=None):
    owner = os.geteuid() if _host_prefix is not None else 0
    with _host_lock(root, owner):
        return _transition(root, install_id, operation_id, expected, action, run, _host_prefix=_host_prefix)


def _transition(root, install_id, operation_id, expected, action, run, *, _host_prefix=None):
    """Apply or restore only the five hashed files of one protected transaction."""
    if action not in ('apply', 'restore'):
        raise ValueError('Invalid ICMP host transition')
    if str(uuid.UUID(operation_id)) != operation_id:
        raise ValueError('Invalid ICMP operation identity')
    owner = os.geteuid() if _host_prefix is not None else 0
    _active_operation(root, operation_id, action, owner)
    root, identity = _identity(root, install_id, owner)
    prefix = Path(_host_prefix).resolve() if _host_prefix is not None else None
    paths = _paths(root, install_id, prefix)
    path = root / 'private/upgrade-backups' / operation_id / 'icmp-host.json'
    value = _transaction(path, root, install_id, operation_id, expected, owner)
    if action == 'apply' and value['phase'] != 'prepared':
        raise ValueError('ICMP apply is outside its prepared transaction phase')
    plan = value['plan']
    if plan['runtime'] != _runtime_record(paths, install_id, root, identity['gid']):
        raise ValueError('ICMP runtime inode changed')
    _verify_runtime(paths, install_id, root, identity['gid'], owner)
    _activation_paths(paths, install_id, owner)
    actual_files = {}
    for key in plan['old']:
        actual = _file_record(paths[key], owner)
        actual_files[key] = actual
        if actual not in (plan['old'][key], plan['new'][key]):
            raise ValueError('ICMP host file changed outside the transaction: ' + key)
    for key in ('payload_dir', 'policy_dir'):
        if paths[key].exists():
            _checked_dir(paths[key], owner, mode=0o755)
            expected_name = 'probe.py' if key == 'payload_dir' else 'cidrs.json'
            if {child.name for child in paths[key].iterdir()} - {expected_name}:
                raise ValueError('Foreign ICMP helper directory contents')
    if action == 'restore' and value['phase'] == 'restored':
        if actual_files != plan['old']:
            raise ValueError('Restored ICMP host state has changed')
        return
    if value['phase'] == 'prepared' and actual_files != plan['old']:
        raise ValueError('ICMP host state changed before the prepared transition')
    value['phase'] = 'applying' if action == 'apply' else 'restoring'
    _atomic(path, _json(value))
    name = install_id + '-icmp-probe'
    if paths['socket_unit'].exists():
        run(['systemctl', 'disable', '--now', name + '.socket'])
    if paths['service'].exists():
        run(['systemctl', 'stop', name + '.service'])
    _validate_socket(paths['socket'], owner, identity['gid'])
    paths['socket'].unlink(missing_ok=True)
    target = plan['new'] if action == 'apply' else plan['old']
    if action == 'apply':
        _checked_file(paths['binary'], owner, executable=True, read=False)
        for key in ('payload_dir', 'policy_dir'):
            missing, cursor = [], paths[key]
            while not cursor.exists() and not cursor.is_symlink():
                missing.append(cursor); cursor = cursor.parent
            _checked_dir(cursor, owner)
            for directory in reversed(missing):
                directory.mkdir(mode=0o755); directory.chmod(0o755)
            _check_helper_parents(paths[key].parent, prefix or Path('/'), owner)
        _traversable_chain(paths['service'].parent, prefix or Path('/'), owner)
    for key, record in target.items():
        if record is None:
            paths[key].unlink(missing_ok=True)
        else:
            _atomic(paths[key], base64.b64decode(record['data'], validate=True), record['mode'])
    if action == 'restore' and target['marker'] is None:
        for key in ('payload_dir', 'policy_dir'):
            if paths[key].exists():
                paths[key].rmdir()
    run(['systemctl', 'daemon-reload'])
    if action == 'apply':
        run(['systemctl', 'enable', '--now', name + '.socket'])
        run(['systemctl', 'is-active', '--quiet', name + '.socket'])
        _health(paths['socket'])
        _verify(paths, json.loads(base64.b64decode(target['marker']['data'])), owner)
    elif target['marker'] is not None:
        if plan['units']['socket']['enabled']:
            run(['systemctl', 'enable', name + '.socket'])
        for kind in ('socket', 'service'):
            if plan['units'][kind]['active']:
                run(['systemctl', 'start', name + '.' + kind])
        _verify(paths, json.loads(base64.b64decode(target['marker']['data'])), owner)
        if plan['units']['service']['active']:
            _health(paths['socket'])
    value['phase'] = 'applied' if action == 'apply' else 'restored'
    _atomic(path, _json(value))


def ensure_dependency(run):
    binary = Path('/usr/sbin/hping3')
    if not binary.exists() and not binary.is_symlink():
        run(['apt-get', 'update'], timeout=300)
        text = run(['apt-cache', 'policy', 'hping3']).decode()
        match = re.search(r'^\s*Candidate:\s*([A-Za-z0-9.+:~_-]+)\s*$', text, re.M)
        if not match or match.group(1) == '(none)':
            raise ValueError('hping3 is unavailable from configured host repositories')
        run(['apt-get', 'install', '-y', '--no-install-recommends', 'hping3=' + match.group(1)], timeout=600)
    _checked_file(binary, 0, executable=True, read=False)
    version = run(['dpkg-query', '-W', '-f=${Version}', 'hping3']).decode().strip()
    if not re.fullmatch(r'[A-Za-z0-9.+:~_-]+', version):
        raise ValueError('Invalid installed hping3 version')
    return version


def _run(command, timeout=30):
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
                                 'DEBIAN_FRONTEND': 'noninteractive'})
    if result.returncode:
        raise ValueError('Finite ICMP host operation failed')
    return result.stdout


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Finite verified PL ICMP host transaction')
    parser.add_argument('action', choices=('dependency', 'apply', 'restore'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--operation-id', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or sys.platform != 'linux':
        raise ValueError('ICMP host transaction requires root on Linux')
    root = args.root
    if not root.is_absolute() or root != root.resolve() or str(uuid.UUID(args.operation_id)) != args.operation_id:
        raise ValueError('Invalid ICMP host request')
    with _host_lock(root, 0):
        _execute(args)


def _execute(args):
    root = args.root
    state = json.loads(_checked_file(root / 'state/installation.json', 0))
    root, _ = _identity(root, state['install_id'], 0)
    operation = json.loads(_checked_file(root / 'state/delivery/operation.json', 0, mode=0o600))
    package = Path(__file__).resolve().parent
    if (operation.get('operation_id') != args.operation_id or operation.get('icmp_package') != package.name
            or package.parent != root / 'releases' or operation.get('phase') in ('complete', 'failed', 'rolled_back')):
        raise ValueError('ICMP operation/package identity differs')
    _active_operation(root, args.operation_id, args.action, 0)
    # Validate every file before importing another candidate payload. The root
    # worker also performs this check before asking PID1 to execute this file.
    manifest_data = _checked_file(package / 'manifest.json', 0)
    if _sha(manifest_data) != operation.get('icmp_package_manifest_sha256'):
        raise ValueError('ICMP candidate manifest differs')
    manifest = json.loads(manifest_data)
    if (manifest.get('product') != 'PL' or manifest.get('core_api', 1) != 1
            or not manifest.get('features', {}).get('icmp_probe') or not isinstance(manifest.get('files'), dict)):
        raise ValueError('ICMP candidate capability is unavailable')
    for name, expected in manifest['files'].items():
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name):
            raise ValueError('Invalid ICMP candidate filename')
        file = package / name
        _checked_file(file, 0, read=False)
        if not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ValueError('Invalid ICMP candidate hash')
        h = hashlib.sha256()
        with file.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024**2), b''): h.update(chunk)
        if h.hexdigest() != expected:
            raise ValueError('ICMP candidate payload differs')
    anchor = json.loads(_checked_file(root / 'state/controller-supervisor.json', 0))
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9][A-Za-z0-9.-]*)?', anchor.get('version', '')):
        raise ValueError('Invalid ICMP trust anchor')
    initial = root / 'releases' / anchor['version']
    if initial != initial.resolve() or _checked_file(package / 'release-signing-public.pem', 0) != _checked_file(initial / 'release-signing-public.pem', 0):
        raise ValueError('ICMP candidate signing identity differs')
    record = root / 'private/upgrade-backups' / args.operation_id / 'icmp-host.json'
    value = _transaction(record, root, state['install_id'], args.operation_id, operation['icmp_host_plan_sha256'], 0)
    if args.action == 'dependency':
        if value['phase'] != 'prepared':
            raise ValueError('ICMP prerequisite is outside the preparation phase')
        value['dependency'] = {'package': 'hping3', 'version': ensure_dependency(_run)}
        paths = _paths(root, state['install_id'], None)
        # These shared parent directories must exist before PID1 can bind them
        # writable into the narrower apply/restore service namespace.
        for parent in (paths['payload_dir'].parent, paths['policy_dir'].parent):
            missing, cursor = [], parent
            while not cursor.exists() and not cursor.is_symlink():
                missing.append(cursor); cursor = cursor.parent
            _checked_dir(cursor, 0)
            for directory in reversed(missing):
                directory.mkdir(mode=0o755); directory.chmod(0o755)
            _check_helper_parents(parent, Path('/'), 0)
        _atomic(record, _json(value))
    else:
        _transition(root, state['install_id'], args.operation_id, operation['icmp_host_plan_sha256'], args.action, _run)


if __name__ == '__main__':
    main()
