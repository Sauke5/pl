"""Collect bounded diagnostics for one managed installation."""
from __future__ import annotations

from collections import deque
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time
from urllib.parse import urlsplit
import zipfile

MIB = 1024**2
MAX_WINDOW = 7 * 24 * 60 * 60
MAX_CONTAINERS = 64
MAX_RECORDS = 6000
MAX_RECORD_BYTES = 16 * 1024
MAX_SOURCE_BYTES = MIB
MAX_LOG_BYTES = 20 * MIB
MAX_ARCHIVE_BYTES = 24 * MIB
PREPARE_SECONDS = 26
COMMAND_SECONDS = 3
DOCKER = ('docker', '--host', 'unix:///var/run/docker.sock')
CORE = ('api', 'web', 'db')
MODULES = {'alertmanager', 'bookstack', 'doska', 'forms', 'grafana', 'netmap', 'prometheus', 'sftpgo', 'wayline', 'xray'}
CONTAINER_ID = re.compile(r'[0-9a-f]{64}')
CONTAINER_NAME = re.compile(r'/([A-Za-z0-9][A-Za-z0-9_.-]{0,199})')
TOKEN = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
TIME = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ')
DOCKER_RECORD = re.compile(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z) (.*)')
LABELS = ('com.docker.compose.project', 'com.docker.compose.service', 'pl.installation', 'pl.module', 'pl.instance')
INSPECT = '{{printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s" .Id .Name ' + ' '.join(
    '(index .Config.Labels "' + key + '")' for key in LABELS) + '}}'

SECRET = (r'(?:[a-z0-9]+[_.-])*'
          r'(?:password|passwd|passphrase|pwd|secret|token|authorization|cookie|credentials?|'
          r'api[_-]?key|private[_-]?key|signature|session[_-]?id)')
SECRET_KEY = re.compile(SECRET, re.I)
HEADERS = re.compile(r'\b(?:proxy-authorization|authorization|set-cookie|cookie|x-pl-signature)\s*[:=]\s*.*', re.I)
ASSIGNMENT = re.compile(
    r'(?<![\w.-])(["\']?' + SECRET + r'["\']?\s*[:=]\s*|--' + SECRET + r'\s+)'
    r'("(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[^\s,;}\]]+)', re.I)
BEARER = re.compile(r'\b(Bearer|Basic)\s+[A-Za-z0-9_./+=-]{4,}', re.I)
JWT = re.compile(r'\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b')
URL = re.compile(r'\b[a-z][a-z0-9+.-]{1,15}://[^\s<>"\'\\]+', re.I)
LOG_WORD = re.compile(r'[^\s"\'<>]+')
SHARE = re.compile(r'(/(?:shares?|invites?|reset-password|access-token)/)[^/?#\s"\'<>]+', re.I)
CONTROL = re.compile(r'[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]')
KEY_START = re.compile(r'-{5}BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-{5}')
KEY_END = re.compile(r'-{5}END [A-Z ]*PRIVATE KEY(?: BLOCK)?-{5}')
OPAQUE_LINE = re.compile(r'[A-Za-z0-9+/=_-]{64,}')
PG_PAYLOAD = re.compile(r'^(\d{4}-\d\d-\d\d [0-9:.]+ \S+ \[\d+\]\s+(?:STATEMENT|QUERY|DETAIL):)\s*.*')
HIDDEN_FIELDS = {'headers', 'request_headers', 'response_headers', 'body', 'request_body', 'response_body',
                 'env', 'environment', 'query', 'raw_query', 'sql', 'statement', 'parameters', 'raw_output',
                 'args', 'argv', 'config', 'configuration', 'stdin', 'local_admin_hash'}


def window(raw):
    def unique(pairs):
        value = dict(pairs)
        if len(value) != len(pairs):
            raise ValueError('Repeated log export field')
        return value

    body = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(body, dict) or set(body) != {'since', 'until'}:
        raise ValueError('Invalid log export arguments')
    since, until = body['since'], body['until']
    if (type(since) is not int or type(until) is not int or not 0 <= since < until <= int(time.time()) + 5
            or until - since > MAX_WINDOW):
        raise ValueError('Invalid log export interval')
    return since, until


def utc(seconds):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(seconds))


def command(controller, args, deadline, limit, *, merge_stderr=False):
    """Read only bounded output. Keep CLI diagnostics out of the support archive."""
    end = min(deadline, time.monotonic() + COMMAND_SECONDS)
    if end <= time.monotonic():
        return b'', 'deadline'
    data = bytearray()
    try:
        with subprocess.Popen(args, cwd=controller.root, env=controller.env,
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT if merge_stderr else subprocess.DEVNULL) as process:
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while (remaining := end - time.monotonic()) > 0 and selector.select(remaining):
                        chunk = os.read(process.stdout.fileno(), min(65536, limit - len(data) + 1))
                        if not chunk:
                            result = process.wait(timeout=max(0, end - time.monotonic()))
                            return bytes(data), '' if result == 0 else 'command_failed'
                        data.extend(chunk)
                        if len(data) > limit:
                            return bytes(data[:limit]), 'read_limit'
                return bytes(data), 'timeout'
            finally:
                if process.poll() is None:
                    process.kill()
    except subprocess.TimeoutExpired:
        return bytes(data), 'timeout'
    except (OSError, subprocess.SubprocessError):
        return bytes(data), 'command_failed'


def lines(raw, reason):
    rows = raw.split(b'\n')
    if not rows[-1] or reason in ('read_limit', 'timeout'):
        rows.pop()
    return rows


def container_inventory(controller, deadline):
    installation = controller.installation
    ids = []
    incomplete = False
    for key in ('com.docker.compose.project', 'pl.installation'):
        raw, reason = command(controller, (*DOCKER, 'container', 'ls', '--all', '--no-trunc',
                                          '--filter', 'label=' + key + '=' + installation, '--format', '{{.ID}}'),
                              deadline, MAX_CONTAINERS * 65 + 65)
        incomplete |= bool(reason)
        for row in lines(raw, reason):
            identifier = row.decode('ascii', 'replace')
            if CONTAINER_ID.fullmatch(identifier):
                if identifier not in ids and len(ids) < MAX_CONTAINERS:
                    ids.append(identifier)
                elif identifier not in ids:
                    incomplete = True
            else:
                incomplete = True
    if not ids:
        return [], incomplete

    raw, reason = command(controller, (*DOCKER, 'container', 'inspect', '--format', INSPECT, *ids), deadline, 128 * 1024)
    found = {}
    for row in lines(raw, reason):
        fields = row.decode('ascii', 'replace').split('\t')
        if len(fields) != 7:
            continue
        identifier, name, project, service, owner, module, instance = fields
        match = CONTAINER_NAME.fullmatch(name)
        if identifier not in ids or not match:
            continue
        if project == installation and service in CORE:
            found[identifier] = (identifier, match[1], service, '')
        elif owner == installation and module in MODULES and UUID.fullmatch(instance):
            found[identifier] = (identifier, match[1], '', module)
    return list(found.values()), incomplete or bool(reason) or len(found) != len(ids)


def endpoint(match):
    try:
        url = urlsplit(match[0])
        if url.scheme in ('http', 'https', 'postgres', 'postgresql', 'redis', 'rediss', 'ldap', 'ldaps', 'ssh', 'sftp'):
            host = url.netloc.rsplit('@', 1)[-1]
            if re.fullmatch(r'[A-Za-z0-9._:\[\]-]{1,255}', host):
                return url.scheme + '://' + host + '/[path omitted]'
    except ValueError:
        pass
    return '[URL omitted]'


def omit_path_query(match):
    word = match[0]
    slash = word.find('/')
    if slash < 0:
        return word
    return word[:slash] + word[slash:].split('?', 1)[0].split('#', 1)[0]


def redact(text):
    text = CONTROL.sub('', text)
    text = HEADERS.sub('[header redacted]', text)
    text = ASSIGNMENT.sub(r'\1[redacted]', text)
    text = BEARER.sub(r'\1 [redacted]', text)
    text = JWT.sub('[token redacted]', text)
    text = URL.sub(endpoint, text)
    if '?' in text or '#' in text:
        text = LOG_WORD.sub(omit_path_query, text)
    return SHARE.sub(r'\1[redacted]', text)


def sanitize(value, depth=0):
    if depth > 12:
        return '[nested fields omitted]'
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            canonical = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', '_', key).lower()
            hidden = SECRET_KEY.fullmatch(canonical) or canonical in HIDDEN_FIELDS
            result[redact(key)] = '[redacted]' if hidden else sanitize(item, depth + 1)
        return result
    if isinstance(value, list):
        return [sanitize(item, depth + 1) for item in value]
    if isinstance(value, str):
        first, sep, _ = value.partition('\n')
        return redact(first) + (' [continuation omitted]' if sep else '')
    return value


def journal_record(row, allowed, since, until):
    try:
        record = json.loads(row)
    except (ValueError, RecursionError):
        return None
    if not isinstance(record, dict):
        return None
    unit = record.get('_SYSTEMD_UNIT')
    if record.get('_PID') == '1' and not (isinstance(unit, str) and allowed.fullmatch(unit)):
        unit = record.get('UNIT')
    stamp, message = record.get('__REALTIME_TIMESTAMP'), record.get('MESSAGE')
    if (not isinstance(unit, str) or not allowed.fullmatch(unit) or not isinstance(stamp, str)
            or not re.fullmatch(r'[0-9]{1,18}', stamp) or not isinstance(message, str)):
        return None
    micros = int(stamp)
    if not since * 10**6 <= micros <= until * 10**6:
        return None
    return utc(micros // 10**6)[:-1] + f'.{micros % 10**6:06d}Z ' + unit, message


def log_tail(raw, reason, capacity, *, journal=None, deadline=float('inf')):
    rows = lines(raw, reason)
    clipped = len(rows) > MAX_RECORDS
    size = 0
    result = deque()
    private_key = False
    pg_payload = False
    for row in rows[-MAX_RECORDS:]:
        if time.monotonic() >= deadline:
            reason = 'deadline'
            break
        if len(row) > MAX_RECORD_BYTES:
            clipped = True
            continue
        decoded = row.decode('utf-8', 'replace')
        if journal is None:
            match = DOCKER_RECORD.fullmatch(decoded)
            fields = match.groups() if match else None
        else:
            fields = journal_record(decoded, *journal)
        if fields is None:
            clipped = True
            continue
        prefix, message = fields
        postgres = PG_PAYLOAD.match(message)
        db_continuation = pg_payload and message.startswith((' ', '\t'))
        pg_payload = bool(postgres) or db_continuation
        if private_key or KEY_START.search(message):
            private_key = not KEY_END.search(message)
            message = '[private key material omitted]'
        elif postgres:
            message = postgres[1] + ' [redacted]'
        elif db_continuation:
            message = '[database continuation omitted]'
        elif OPAQUE_LINE.fullmatch(message.strip()):
            message = '[opaque record omitted]'
        elif message.startswith(('{', '[')):
            try:
                message = json.dumps(sanitize(json.loads(message)), ensure_ascii=True, separators=(',', ':'), allow_nan=False)
            except (ValueError, RecursionError):
                message = redact(message.split('\n', 1)[0])
        else:
            first, sep, _ = message.partition('\n')
            message = redact(first)
            if sep:
                message += ' [continuation omitted]'
                clipped = True
        encoded = (prefix + ' ' + message + '\n').encode('utf-8', 'replace')
        result.append(encoded)
        size += len(encoded)
        while size > capacity:
            size -= len(result.popleft())
            clipped = True
    return b''.join(result), reason or ('record_limit' if clipped else '')


def state_file(path):
    if path.parent != path.parent.resolve():
        raise ValueError('Invalid state path')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_size > MIB):
            raise ValueError('Invalid state file')
        raw = stream.read(MIB + 1)
        if len(raw) > MIB:
            raise ValueError('Oversized state file')
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError('Invalid state document')
        return data


def strings(data, fields, pattern=TOKEN):
    return {key: data[key] for key in fields if isinstance(data.get(key), str) and pattern.fullmatch(data[key])}


def project_state(controller, name):
    if name == 'installation':
        state = state_file(controller.root / 'state/installation.json')
        if state.get('install_id') != controller.installation or state.get('product') not in ('PL', 'Pl'):
            raise ValueError('Invalid installation identity')
        return {'installation': controller.installation, **strings(state, ('phase', 'version', 'previous_version'))}
    state = state_file(controller.root / 'state/delivery/operation.json')
    projection = {**strings(state, ('kind', 'phase', 'version', 'from_version', 'module_id', 'module_version')),
                  **strings(state, ('operation_id',), UUID),
                  **strings(state, ('started_at', 'finished_at'), TIME)}
    for key in ('data_committed', 'restored_snapshot'):
        if type(state.get(key)) is bool:
            projection[key] = state[key]
    failure = state.get('last_failure')
    if isinstance(failure, dict):
        projection['last_failure'] = strings(failure, ('phase', 'type', 'code'))
        frames = failure.get('frames')
        if isinstance(frames, list):
            projection['last_failure']['frames'] = [
                {**strings(frame, ('file', 'function')), 'line': frame['line']}
                for frame in frames[-12:] if isinstance(frame, dict) and type(frame.get('line')) is int
                and 0 < frame['line'] < 1000000 and len(strings(frame, ('file', 'function'))) == 2]
    return projection


def write_archive(controller, output, since, until):
    deadline = time.monotonic() + PREPARE_SECONDS
    start, end = utc(since), utc(until)
    rows = []
    remaining = MAX_LOG_BYTES
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        def add(source, path=None, data=b'', *, reason=''):
            nonlocal remaining
            status = 'collected' if data else 'empty'
            if reason:
                status = 'truncated' if data or reason in ('read_limit', 'record_limit', 'archive_limit') else 'unavailable'
            row = {'source': source, 'status': status}
            if reason:
                row['reason'] = reason
            if data:
                archive.writestr(path, data)
                row.update(path=path, bytes=len(data))
                if path.endswith('.log'):
                    row.update(records=data.count(b'\n'),
                               first_record_at=data.partition(b' ')[0].decode('ascii'),
                               last_record_at=data.rstrip(b'\n').rsplit(b'\n', 1)[-1].partition(b' ')[0].decode('ascii'))
                remaining -= len(data)
            rows.append(row)

        def add_logs(source, path, args, *, journal=None):
            if remaining <= 0:
                add(source, reason='archive_limit')
                return
            raw, reason = command(controller, args, deadline, 3 * MAX_SOURCE_BYTES, merge_stderr=journal is None)
            data, reason = log_tail(raw, reason, min(remaining, MAX_SOURCE_BYTES), journal=journal, deadline=deadline)
            add(source, path, data, reason=reason)

        containers, incomplete = container_inventory(controller, deadline)
        if incomplete:
            add('docker:inventory', reason='incomplete_inventory')
        for service in CORE:
            if not any(row[2] == service for row in containers):
                add('docker:core:' + service, reason='container_missing')
        for name in ('installation', 'delivery'):
            source = 'state:' + name
            try:
                data = project_state(controller, name)
            except FileNotFoundError:
                add(source, reason='state_missing' if name == 'installation' else '')
            except (OSError, ValueError, RecursionError):
                add(source, reason='state_unavailable')
            else:
                add(source, 'host/state/' + name + '.json', json.dumps(data, indent=2).encode() + b'\n')

        def docker_logs(entries):
            for identifier, name, service, module in entries:
                add_logs('docker:' + (service or module) + ':' + name, 'host/docker/' + name + '-' + identifier[:12] + '.log',
                         (*DOCKER, 'container', 'logs', '--since', start, '--until', end,
                          '--timestamps', '--tail', str(MAX_RECORDS + 1), identifier))

        docker_logs(row for row in containers if row[2])
        installation = controller.installation
        unit_groups = {
            'module-controller': (('module-controller.service',), r'module-controller\.service'),
            'icmp-probe': (('icmp-probe.service', 'icmp-probe.socket', 'icmp-*.service'),
                           r'(?:icmp-probe\.(?:service|socket)|icmp-[0-9a-f]{32}-(?:dependency|apply|restore)\.service)'),
            'delivery-workers': (('upgrade-*.service',), r'upgrade-[0-9a-f]{32}\.service'),
        }
        for name, (units, pattern) in unit_groups.items():
            allowed = re.compile(re.escape(installation) + '-' + pattern)
            add_logs('systemd:' + name, 'host/journal/' + name + '.log',
                     ('journalctl', '--system', '--no-pager', '--quiet', '--output=json',
                      '--output-fields=MESSAGE,_SYSTEMD_UNIT,UNIT,_PID',
                      *('--unit=' + installation + '-' + unit for unit in units),
                      '--since=@' + str(since), '--until=@' + str(until), '--lines=' + str(MAX_RECORDS + 1)),
                     journal=(allowed, since, until))
        docker_logs(row for row in containers if not row[2])
        manifest = {'schema': 1, 'installation': installation, 'since': start, 'until': end,
                    'collected_at': utc(time.time()), 'partial': any(row['status'] in ('truncated', 'unavailable') for row in rows),
                    'limits': {'containers': MAX_CONTAINERS, 'records_per_source': MAX_RECORDS, 'bytes_per_source': MAX_SOURCE_BYTES,
                               'log_bytes': MAX_LOG_BYTES, 'preparation_seconds': PREPARE_SECONDS},
                    'sources': rows}
        archive.writestr('host/manifest.json', json.dumps(manifest, indent=2).encode() + b'\n')

    size = output.tell()
    if not 0 < size <= MAX_ARCHIVE_BYTES:
        raise ValueError('Unexpected log archive size')
    output.seek(0)
    return size
