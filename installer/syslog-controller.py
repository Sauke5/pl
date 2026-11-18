#!/usr/bin/env python3
"""Owned VictoriaLogs receiver, lifecycle and finite Syslog module queries."""
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import errno
import fcntl
import hashlib
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import threading
import time
import unicodedata
from urllib.parse import urlencode

_helper = Path(__file__).with_name('xray-controller.py')
if _helper.is_symlink() or not _helper.is_file():
    raise ValueError('Trusted module file primitives unavailable')
_spec = importlib.util.spec_from_file_location('pl_syslog_files', _helper)
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
identifier, directory, read_file = _files.identifier, _files.directory, _files.read_file
atomic, encoded, fsync_directory = _files.atomic, _files.encoded, _files.fsync_directory

DEFAULT = {'address': '', 'port': 5514, 'tcp': True, 'udp': True, 'retention_days': 14}
API_PORT = '9428/tcp'
STORAGE = '/victoria-logs-data'
LIMITS = {'sources': 100, 'messages': 200}
PROTOCOLS = ('tcp', 'udp')
RFC3339 = re.compile(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)', re.ASCII)
LOG_CONFIG = {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}


class RequestError(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def invalid():
    return RequestError(400, 'syslog_invalid_request', 'Проверьте параметры запроса.')


def unavailable():
    return RequestError(503, 'syslog_unavailable', 'Сервер журналов недоступен.')


def settings(value):
    if (not isinstance(value, dict) or set(value) != set(DEFAULT)
            or type(value['port']) is not int or not 1 <= value['port'] <= 65535
            or type(value['retention_days']) is not int or not 1 <= value['retention_days'] <= 365
            or any(type(value[key]) is not bool for key in PROTOCOLS) or not any(value[key] for key in PROTOCOLS)
            or not isinstance(value['address'], str)):
        raise invalid()
    if value['address']:
        try:
            ip = ipaddress.IPv4Address(value['address'])
        except ValueError:
            raise invalid() from None
        if str(ip) != value['address'] or ip.is_unspecified or ip.is_multicast or ip.is_reserved:
            raise invalid()
    return value


def published(configuration):
    if not configuration['address']:
        return {}
    return {f'1514/{proto}': [{'HostIp': configuration['address'], 'HostPort': str(configuration['port'])}]
            for proto in PROTOCOLS if configuration[proto]}


def command(configuration):
    args = ['-storageDataPath=' + STORAGE, '-httpListenAddr=:9428',
            '-retentionPeriod=' + str(configuration['retention_days']) + 'd',
            '-search.maxQueryDuration=6s', '-search.maxQueryTimeRange=31d',
            '-search.maxConcurrentRequests=2', '-search.maxQueueDuration=2s']
    for proto in PROTOCOLS:
        if configuration[proto]:
            args.extend(['-syslog.listenAddr.' + proto + '=:1514', '-syslog.useLocalTimestamp.' + proto,
                         '-syslog.useRemoteIP.' + proto, '-syslog.streamFields.' + proto + '=["hostname","remote_ip"]'])
    return args


@contextmanager
def lock(path, exclusive=True):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Invalid Syslog lock')
        deadline = time.monotonic() + (12 if exclusive else 2)
        while True:
            try:
                fcntl.flock(stream, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RequestError(503, 'syslog_busy', 'Настройки сервера применяются. Повторите запрос.') from None
                time.sleep(.05)
        yield


def query_parameters(action, value):
    if (action not in LIMITS or not isinstance(value, dict) or not {'from', 'to'} <= value.keys()
            or value.keys() - {'from', 'to', 'source', 'address', 'severity', 'text'}):
        raise invalid()
    if action == 'sources' and value.keys() - {'from', 'to'}:
        raise invalid()
    bounds = []
    for key in ('from', 'to'):
        match = RFC3339.fullmatch(value[key]) if isinstance(value[key], str) else None
        if not match:
            raise invalid()
        try:
            wall, fraction, zone = match.groups()
            instant = datetime.fromisoformat(wall + ('+00:00' if zone == 'Z' else zone))
            seconds = instant - datetime(1970, 1, 1, tzinfo=timezone.utc)
        except (ValueError, OverflowError):
            raise invalid() from None
        bounds.append((seconds.days * 86400 + seconds.seconds) * 10**9 + int((fraction or '0').ljust(9, '0')))
    if not 0 < bounds[1] - bounds[0] <= 31 * 86400 * 10**9:
        raise invalid()
    filters = []
    for key, field, maximum in (('source', 'hostname', 512), ('address', 'remote_ip', 64),
                                 ('severity', 'severity', 1), ('text', '_msg', 512)):
        item = value.get(key, '')
        if (not isinstance(item, str) or any(unicodedata.category(char) in ('Cc', 'Cs') for char in item)
                or len(item.encode('utf-8')) > maximum):
            raise invalid()
        if not item:
            continue
        if key == 'severity' and item not in '01234567':
            raise invalid()
        if key == 'address':
            try:
                if '%' in item:
                    raise ValueError()
                item = str(ipaddress.ip_address(item))
            except ValueError:
                raise invalid() from None
        literal = json.dumps(item, ensure_ascii=False)
        filters.append(field + (':*' + literal + '*' if key == 'text' else ':=' + literal))
    query = ' and '.join(filters) or '*'
    if action == 'sources':
        # All three values come from the same latest event for the (host, IP) pair.
        query += (' | stats by (hostname, remote_ip) row_max(_time, _time, _msg, severity) as latest'
                  ' | unpack_json from latest | sort by (_time desc, hostname, remote_ip) limit 101'
                  ' | fields hostname, remote_ip, _time, _msg, severity')
    else:
        query += ' | fields _time, timestamp, hostname, remote_ip, severity, app_name, format, _msg'
    return {'start': value['from'], 'end': value['to'], 'query': query, 'limit': LIMITS[action] + 1, 'timeout': '5s'}


class SyslogController:
    def __init__(self, parent):
        self.parent, self.root, self.installation, self.docker = parent, Path(parent.root), parent.installation, parent.docker
        self.base = self.root / 'modules/syslog'
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        for path in (self.base, self.instances, self.operations):
            directory(path)
        registry = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        installation = json.loads(read_file(self.root / 'state/installation.json'))
        bundle = registry.get('syslog')
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or installation.get('install_id') != self.installation or not re.fullmatch('[0-9a-f]{64}', registry.get('manifest_sha256', ''))
                or registry['manifest_sha256'] != installation.get('manifest_sha256') or not isinstance(bundle, dict) or set(bundle) != {'server'}):
            raise ValueError('Invalid Syslog installation identity')
        self.image = bundle['server']
        expected = {'org.opencontainers.image.version': '1.54.0', 'pl.upstream.version': '1.54.0', 'pl.module.id': 'syslog',
                    'pl.module.role': 'server', 'pl.module.config.version': '1', 'pl.build.variant': 'upstream-pinned'}
        if (not isinstance(self.image, dict) or set(self.image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                or not re.fullmatch('sha256:[0-9a-f]{64}', self.image.get('id', ''))
                or self.image['architecture'] not in ('amd64', 'arm64') or self.image['recipe'] != 'deploy/images/syslog.Dockerfile'
                or any((self.image['labels'] or {}).get(k) != v for k, v in expected.items())):
            raise ValueError('Invalid Syslog image descriptor')
        self.version = expected['org.opencontainers.image.version']
        self.query_slots = threading.BoundedSemaphore(2)

    def names(self, instance, suffix=''):
        return self.installation + '-syslog-' + identifier(instance) + suffix

    def labels(self, instance):
        return {'pl.installation': self.installation, 'pl.module': 'syslog', 'pl.instance': identifier(instance)}

    def locked(self, instance, exclusive=False):
        return lock(self.operations / ('instance-' + identifier(instance) + '.lock'), exclusive)

    def path(self, instance, create=False):
        path = self.instances / identifier(instance)
        directory(path, create=create)
        return path

    def state(self, instance, pending=False):
        value = json.loads(read_file(self.path(instance) / 'state.json'))
        fields = {'installation', 'instance_id', 'configuration', 'revision', 'pending'}
        if (not isinstance(value, dict) or not fields <= value.keys() or value.keys() - fields - {'storage_created'}
                or value['installation'] != self.installation or value['instance_id'] != instance
                or type(value.get('storage_created', True)) is not bool or type(value['revision']) is not int or not 0 <= value['revision'] < 2**53):
            raise ValueError('Invalid Syslog state')
        settings(value['configuration'])
        change = value['pending']
        if change is not None:
            if (not isinstance(change, dict) or set(change) != {'configuration', 'revision', 'running'}
                    or type(change['revision']) is not int or change['revision'] != value['revision'] + 1
                    or type(change['running']) is not bool):
                raise ValueError('Invalid Syslog transition')
            settings(change['configuration'])
            if not pending:
                raise RequestError(409, 'syslog_pending', 'Применение настроек прервано. Повторите сохранение.')
        return value

    def resource(self, instance, kind, *, create=False):
        if kind not in ('network', 'volume'):
            raise ValueError('Invalid Syslog resource kind')
        name = self.names(instance, '-net' if kind == 'network' else '-logs-data')
        found = self.docker(kind, 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found and create:
            args = [kind, 'create']
            if kind == 'network':
                args += ['--driver', 'bridge', *_files.module_network_args(self.root, self.installation, self.docker)]
            for key, val in self.labels(instance).items():
                args += ['--label', key + '=' + val]
            self.docker(*args, name)
            return self.resource(instance, kind)
        if not found:
            return None
        obj, = json.loads(self.docker(kind, 'inspect', name))
        options = obj.get('Options') or {}
        default_bridge = {'com.docker.network.enable_ipv4': 'true', 'com.docker.network.enable_ipv6': 'false'}
        if (found != name or obj.get('Name') != name or obj.get('Driver') != ('bridge' if kind == 'network' else 'local')
                or options and (kind != 'network' or options != default_bridge)
                or obj.get('Scope') != 'local'
                or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())):
            raise ValueError('Syslog resource ownership mismatch')
        if kind == 'network':
            if obj.get('Internal') is not False or obj.get('Ingress'):
                raise ValueError('Syslog network drift')
            _files.validate_module_network(self.root, self.installation, obj, self.docker)
            for identity, member in (obj.get('Containers') or {}).items():
                if member.get('Name') != self.names(instance) or not re.fullmatch('[0-9a-f]{64}', identity):
                    raise ValueError('Foreign Syslog network member')
                container, = json.loads(self.docker('container', 'inspect', identity))
                if (container.get('Id') != identity or container.get('Name') != '/' + self.names(instance)
                        or any((container['Config'].get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())):
                    raise ValueError('Foreign Syslog network member')
        return obj

    def verify_image(self):
        obj, = json.loads(self.docker('image', 'inspect', self.image['id']))
        config = obj.get('Config', {})
        if (obj.get('Id') != self.image['id'] or obj.get('Os') != 'linux' or obj.get('Architecture') != self.image['architecture']
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.image['labels'].items())
                or config.get('Entrypoint') != ['/victoria-logs-prod'] or config.get('User') != '65532:65532'):
            raise ValueError('Syslog image identity mismatch')
        return obj

    def container_id(self, instance):
        name = self.names(instance)
        identity = self.docker('container', 'ls', '-a', '--no-trunc', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
        if identity and not re.fullmatch('[0-9a-f]{64}', identity):
            raise ValueError('Invalid Syslog container identity')
        return identity

    def inspect(self, instance, *, check_bindings=True):
        identity = self.container_id(instance)
        if not identity:
            return None
        obj, = json.loads(self.docker('container', 'inspect', identity))
        state = self.state(instance, pending=True)
        image = self.verify_image()['Config']
        config, host = obj.get('Config', {}), obj.get('HostConfig', {})
        labels = config.get('Labels') or {}
        for version in (state, state['pending']):
            if version and labels.get('pl.syslog.revision') == str(version['revision']):
                selected = version['configuration']
                break
        else:
            raise ValueError('Unknown Syslog container revision')
        network = self.names(instance, '-net')
        expected_labels = {**(image.get('Labels') or {}), **self.labels(instance), 'pl.syslog.revision': str(version['revision'])}
        ports = host.get('PortBindings') or {}
        api = ports.get(API_PORT) or []
        mounts = [(m.get('Type'), m.get('Name'), m.get('Destination'), m.get('RW')) for m in obj.get('Mounts', [])]
        if (obj.get('Id') != identity or obj.get('Name') != '/' + self.names(instance)
                or obj.get('Image') != self.image['id'] or config.get('Image') != self.image['id'] or labels != expected_labels
                or any(config.get(k) != image.get(k) for k in ('User', 'Env', 'WorkingDir', 'Entrypoint', 'Healthcheck'))
                or config.get('Cmd') != command(selected) or mounts != [('volume', self.names(instance, '-logs-data'), STORAGE, True)]
                or {k: v for k, v in ports.items() if k != API_PORT} != published(selected)
                or len(api) != 1 or api[0].get('HostIp') != '127.0.0.1' or api[0].get('HostPort') not in ('', '0')
                or host.get('NetworkMode') != network or set(obj.get('NetworkSettings', {}).get('Networks', {})) != {network}
                or host.get('ReadonlyRootfs') is not True or host.get('CapDrop') != ['ALL'] or host.get('SecurityOpt') != ['no-new-privileges']
                or any(host.get(k) for k in ('Privileged', 'CapAdd', 'Devices', 'Binds', 'PublishAllPorts', 'VolumesFrom', 'Links', 'ExtraHosts',
                                             'PidMode', 'UTSMode', 'UsernsMode', 'DeviceRequests', 'GroupAdd', 'Tmpfs'))
                or host.get('IpcMode') not in ('private', None) or host.get('Memory') != 512 * 1024**2 or host.get('NanoCpus') != 1_000_000_000
                or host.get('PidsLimit') != 128 or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('LogConfig') != LOG_CONFIG):
            raise ValueError('Syslog container ownership or configuration drift')
        if not self.resource(instance, 'network') or not self.resource(instance, 'volume'):
            raise ValueError('Syslog owned resource missing')
        if check_bindings and obj.get('State', {}).get('Running') and not obj['State'].get('Restarting'):
            actual = obj.get('NetworkSettings', {}).get('Ports') or {}
            if {k: v for k, v in actual.items() if k != API_PORT and v} != published(selected):
                raise ValueError('Syslog published binding differs from requested receiver')
            self.api_port(obj)
        return obj

    def create(self, instance, configuration, revision):
        self.verify_image()
        args = ['container', 'create', '--name', self.names(instance), '--network', self.names(instance, '-net'),
                '--restart', 'unless-stopped', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--log-driver', 'local',
                '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2', '--publish', '127.0.0.1::9428/tcp',
                '--mount', 'type=volume,source=' + self.names(instance, '-logs-data') + ',target=' + STORAGE]
        for port, (binding,) in published(configuration).items():
            args += ['--publish', binding['HostIp'] + ':' + binding['HostPort'] + ':' + port]
        for key, val in {**self.labels(instance), 'pl.syslog.revision': str(revision)}.items():
            args += ['--label', key + '=' + val]
        identity = self.docker(*args, self.image['id'], *command(configuration)).decode().strip()
        obj = self.inspect(instance)
        if not obj or obj['Id'] != identity:
            raise ValueError('Syslog container creation unconfirmed')
        return obj

    @staticmethod
    def api_port(obj):
        ports = obj.get('NetworkSettings', {}).get('Ports', {}).get(API_PORT) or []
        if (len(ports) != 1 or ports[0].get('HostIp') != '127.0.0.1'
                or not re.fullmatch('[1-9][0-9]{0,4}', str(ports[0].get('HostPort', ''))) or int(ports[0]['HostPort']) > 65535):
            raise ValueError('Syslog private API binding unavailable')
        return int(ports[0]['HostPort'])

    def ready(self, obj):
        connection = http.client.HTTPConnection('127.0.0.1', self.api_port(obj), timeout=1.5)
        try:
            connection.request('GET', '/health')
            response = connection.getresponse()
            if response.status != 200 or response.read(17).strip() != b'OK':
                raise unavailable()
        finally:
            connection.close()

    def start(self, instance, obj):
        if not obj['State'].get('Running'):
            self.docker('container', 'start', obj['Id'], timeout=15)
        running = self.inspect(instance)
        if not running or running['Id'] != obj['Id'] or not running['State'].get('Running'):
            raise unavailable()
        deadline = time.monotonic() + 10
        while True:
            try:
                self.ready(running)
                return
            except (OSError, http.client.HTTPException, RequestError):
                if time.monotonic() >= deadline:
                    raise unavailable() from None
                time.sleep(.15)

    def stop(self, obj):
        if obj['State'].get('Running'):
            self.docker('container', 'stop', '--time', '8', obj['Id'], timeout=13)

    def drop(self, obj):
        if obj:
            self.stop(obj)
            self.docker('container', 'rm', obj['Id'])

    def host_addresses(self):
        try:
            result = subprocess.run(['ip', '-j', '-4', 'address', 'show'], cwd=self.root, env=getattr(self.parent, 'env', None),
                                    capture_output=True, timeout=3, check=True)
            values = set()
            for interface in json.loads(result.stdout):
                if 'UP' not in interface.get('flags', []) or re.fullmatch(r'docker\d+|br-[0-9a-f]{12}|veth[0-9a-f]+', interface['ifname']):
                    continue
                for info in interface.get('addr_info', []):
                    if info.get('family') == 'inet':
                        ip = ipaddress.IPv4Address(info['local'])
                        if not (ip.is_unspecified or ip.is_multicast or ip.is_reserved):
                            values.add(ip)
            return [str(ip) for ip in sorted(values, key=lambda ip: (ip.is_loopback, int(ip)))]
        except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
            raise RequestError(503, 'syslog_addresses_unavailable', 'Не удалось получить IPv4-адреса хоста.') from None

    def preflight(self, configuration, previous, addresses):
        if configuration['address'] and configuration['address'] not in addresses:
            raise RequestError(400, 'syslog_address_unavailable', 'Выбранный IPv4-адрес не назначен этому хосту.')
        occupied = published(previous) if previous else {}
        for port, bindings in published(configuration).items():
            if occupied.get(port) == bindings:
                continue
            port_type = socket.SOCK_STREAM if port.endswith('/tcp') else socket.SOCK_DGRAM
            with socket.socket(socket.AF_INET, port_type) as probe:
                try:
                    probe.bind((configuration['address'], configuration['port']))
                except OSError as error:
                    if error.errno == errno.EADDRINUSE:
                        raise RequestError(409, 'syslog_port_in_use', 'Выбранный порт уже занят.') from None
                    raise RequestError(400, 'syslog_bind_unavailable', 'Не удалось занять выбранный адрес и порт.') from None

    def restore_previous(self, instance, state):
        # Both revisions remain provable until the committed listener has returned.
        obj = self.inspect(instance, check_bindings=False)
        if obj and obj['Config']['Labels']['pl.syslog.revision'] != str(state['revision']):
            self.drop(obj)
            obj = None
        if not obj:
            obj = self.create(instance, state['configuration'], state['revision'])
        if state['pending']['running']:
            self.start(instance, obj)
        else:
            self.stop(obj)
        state = {**state, 'pending': None}
        atomic(self.path(instance) / 'state.json', state)
        return state

    def configure(self, instance, payload):
        if (set(payload) != set(DEFAULT) | {'expected_revision'} or type(payload['expected_revision']) is not int
                or not 0 <= payload['expected_revision'] < 2**53):
            raise invalid()
        configuration = settings({k: payload[k] for k in DEFAULT})
        state = self.state(instance, pending=True)
        if state['pending']:
            state = self.restore_previous(instance, state)
        if payload['expected_revision'] != state['revision']:
            raise RequestError(409, 'syslog_revision_conflict', 'Настройки изменились. Обновите страницу и повторите сохранение.')
        addresses = self.host_addresses()
        obj = self.inspect(instance)
        if not obj:
            raise unavailable()
        running = bool(obj['State'].get('Running'))
        self.preflight(configuration, state['configuration'] if running else None, addresses)
        if configuration != state['configuration']:
            change = {'revision': state['revision'] + 1, 'configuration': configuration, 'running': running}
            state = {**state, 'pending': change}
            path = self.path(instance) / 'state.json'
            atomic(path, state)
            try:
                self.drop(obj)
                obj = self.create(instance, configuration, change['revision'])
                if running:
                    self.start(instance, obj)
                state = {**state, 'configuration': configuration, 'revision': change['revision'], 'pending': None}
                atomic(path, state)
            except (ValueError, OSError, http.client.HTTPException):
                self.restore_previous(instance, self.state(instance, pending=True))
                raise RequestError(409, 'syslog_apply_failed', 'Настройки применить не удалось. Предыдущий приёмник восстановлен.') from None
        return {**state['configuration'], 'revision': state['revision'], 'addresses': addresses}

    def ensure(self, instance):
        path = self.path(instance, create=True)
        if not (path / 'state.json').exists():
            if list(path.iterdir()) or self.container_id(instance) or self.resource(instance, 'network') or self.resource(instance, 'volume'):
                raise ValueError('Unmanaged Syslog resources exist')
            atomic(path / 'state.json', {'installation': self.installation, 'instance_id': instance, 'configuration': DEFAULT,
                                         'revision': 0, 'pending': None, 'storage_created': False})
        state = self.state(instance, pending=True)
        if state['pending']:
            state = self.restore_previous(instance, state)
        # An interrupted first install can finish provisioning. After this point
        # an absent data volume requires recovery, including on a repeated install.
        has_storage = state.get('storage_created', True)
        if not self.resource(instance, 'volume', create=not has_storage):
            raise ValueError('Syslog owned volume missing')
        if not has_storage:
            atomic(path / 'state.json', {**state, 'storage_created': True})
        if not self.resource(instance, 'network', create=True):
            raise ValueError('Syslog owned network missing')
        obj = self.inspect(instance)
        if not obj or not obj['State'].get('Running'):
            if state['configuration']['address']:
                self.preflight(state['configuration'], None, self.host_addresses())
            obj = obj or self.create(instance, state['configuration'], state['revision'])
            self.start(instance, obj)

    def remove(self, instance):
        path = self.instances / identifier(instance)
        if path.is_symlink():
            raise ValueError('Unowned Syslog instance')
        if not path.exists():
            self.observe(instance)
            return
        self.path(instance)
        entries = {p.name for p in path.iterdir()}
        if entries - {'state.json'}:
            raise ValueError('Unexpected Syslog instance files')
        if entries:
            self.state(instance, pending=True)
        elif self.container_id(instance) or self.resource(instance, 'volume') or self.resource(instance, 'network'):
            raise ValueError('Unmanaged Syslog resources exist')
        obj = self.inspect(instance, check_bindings=False)
        volume = self.resource(instance, 'volume')
        network = self.resource(instance, 'network')
        if volume:
            users = set(self.docker('container', 'ls', '-a', '--no-trunc', '--filter', 'volume=' + volume['Name'], '--format', '{{.ID}}').decode().split())
            if users - ({obj['Id']} if obj else set()):
                raise ValueError('Foreign container uses the Syslog volume')
        self.drop(obj)
        if network:
            self.docker('network', 'rm', network['Id'])
        if volume:
            self.docker('volume', 'rm', volume['Name'])
        (path / 'state.json').unlink(missing_ok=True)
        path.rmdir()
        fsync_directory(self.instances)

    def observe(self, instance):
        path = self.instances / identifier(instance)
        common = {'version': '', 'endpoint': '', 'error': '', 'targets_up': 0, 'targets_total': 0}
        if not path.exists() and not path.is_symlink():
            if self.container_id(instance) or self.resource(instance, 'network') or self.resource(instance, 'volume'):
                raise ValueError('Syslog artifacts without state')
            return {**common, 'state': 'absent'}
        state = self.state(instance)
        obj = self.inspect(instance)
        if not obj:
            raise unavailable()
        running = bool(obj['State'].get('Running'))
        if running:
            self.ready(obj)
        return {**common, 'state': 'running' if running else 'disabled', 'version': self.version, 'configuration_revision': state['revision'],
                'configuration_hash': hashlib.sha256(encoded(state['configuration'])).hexdigest()}

    def get(self, instance):
        with self.locked(instance):
            return self.observe(instance)

    def execute(self, body):
        if (not isinstance(body, dict) or set(body) != {'operation_id', 'instance_id', 'module_id', 'action'}
                or body['module_id'] != 'syslog' or body['action'] not in ('install', 'enable', 'refresh', 'disable', 'remove')):
            raise ValueError('Invalid Syslog lifecycle operation')
        instance, operation, action = identifier(body['instance_id']), identifier(body['operation_id']), body['action']
        fingerprint = hashlib.sha256(encoded(body)).hexdigest()
        journal = self.operations / (operation + '.json')
        mutable = action != 'refresh'
        with _files.operation_lock(self.operations, operation), self.locked(instance, exclusive=mutable), \
                (lock(self.root / 'modules/controller.lock') if mutable else nullcontext()):
            if journal.exists() or journal.is_symlink():
                record = json.loads(read_file(journal))
                if record.get('fingerprint') != fingerprint:
                    raise ValueError('Syslog operation identity conflict')
                if record.get('phase') == 'complete':
                    return {**self.observe(instance), 'operation_id': operation}
            atomic(journal, {'fingerprint': fingerprint, 'phase': 'running'})
            try:
                if action in ('install', 'enable'):
                    self.ensure(instance)
                elif action == 'disable' and (self.instances / instance).exists():
                    state = self.state(instance, pending=True)
                    if state['pending']:
                        self.restore_previous(instance, state)
                    obj = self.inspect(instance)
                    if obj:
                        self.stop(obj)
                elif action == 'remove':
                    self.remove(instance)
                result = self.observe(instance)
                atomic(journal, {'fingerprint': fingerprint, 'phase': 'complete'})
                return {**result, 'operation_id': operation}
            except (ValueError, OSError, KeyError, http.client.HTTPException) as error:
                return {'state': 'error', 'operation_id': operation, 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0,
                        'error': _files.module_network_error(error, 'Операция с сервером журналов прервана. Проверьте состояние экземпляра.')}

    def query(self, instance, action, parameters):
        self.state(instance)
        obj = self.inspect(instance)
        if not obj or not obj['State'].get('Running'):
            raise RequestError(503, 'syslog_stopped', 'Сервер журналов остановлен.')
        connection = http.client.HTTPConnection('127.0.0.1', self.api_port(obj), timeout=7)
        try:
            connection.request('POST', '/select/logsql/query', urlencode(parameters),
                               {'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Encoding': 'identity'})
            response = connection.getresponse()
            if response.status != 200:
                raise unavailable()
            rows, received, returned = [], 0, 0
            deadline = time.monotonic() + 7
            while len(rows) <= LIMITS[action]:
                if time.monotonic() >= deadline:
                    raise unavailable()
                line = response.readline(512 * 1024 + 1)
                if not line:
                    break
                received += len(line)
                if len(line) > 512 * 1024 or received > 12 * 1024**2:
                    if rows:
                        return {'items': rows, 'truncated': True}
                    raise unavailable()
                row = json.loads(line)
                if not isinstance(row, dict) or not isinstance(row.get('_time'), str):
                    raise unavailable()
                item = self.result_row(row, action)
                returned += len(encoded(item))
                if returned > 3 * 1024**2:
                    return {'items': rows, 'truncated': True}
                rows.append(item)
            return {'items': rows[:LIMITS[action]], 'truncated': len(rows) > LIMITS[action]}
        finally:
            connection.close()

    @staticmethod
    def result_row(row, action):
        def field(key, limit):
            value = row.get(key, '')
            if not isinstance(value, str):
                raise unavailable()
            if len(value) > limit:
                return value[:limit - 1] + '…'
            return value
        item = {'source': field('hostname', 512), 'address': field('remote_ip', 64), 'severity': field('severity', 1)}
        if action == 'sources':
            return {**item, 'last_seen': field('_time', 64), 'last_message': field('_msg', 1024)}
        item.update(time=field('_time', 64), message=field('_msg', 8192))
        for key, alias, limit in (('timestamp', 'device_time', 64), ('app_name', 'program', 255), ('format', 'format', 32)):
            if row.get(key):
                item[alias] = field(key, limit)
        return item

    def request(self, body):
        instance = identifier(body.get('instance_id') if isinstance(body, dict) else None)
        try:
            if (set(body) != {'instance_id', 'action', 'payload'} or not isinstance(body['payload'], dict)
                    or body['action'] not in ('receiver-get', 'receiver-set', 'sources', 'messages')):
                raise invalid()
            action, payload = body['action'], body['payload']
            if action == 'receiver-get' and payload:
                raise invalid()
            params = query_parameters(action, payload) if action in LIMITS else None
            if not (self.instances / instance).exists():
                raise RequestError(404, 'syslog_not_installed', 'Сервер журналов не установлен.')
            with self.locked(instance, exclusive=action == 'receiver-set'):
                if action == 'receiver-set':
                    with lock(self.root / 'modules/controller.lock'):
                        result = self.configure(instance, payload)
                elif action == 'receiver-get':
                    state = self.state(instance)
                    if not self.inspect(instance):
                        raise unavailable()
                    result = {**state['configuration'], 'revision': state['revision'], 'addresses': self.host_addresses()}
                else:
                    if not self.query_slots.acquire(blocking=False):
                        raise RequestError(429, 'syslog_busy', 'Сервер журналов обрабатывает другие запросы.')
                    try:
                        result = self.query(instance, action, params)
                    finally:
                        self.query_slots.release()
            return {'instance_id': instance, 'status': 200, 'body': result}
        except RequestError as error:
            return {'instance_id': instance, 'status': error.status, 'body': {'error': {'code': error.code, 'message': str(error)}}}
        except (ValueError, OSError, TypeError, KeyError, http.client.HTTPException):
            return {'instance_id': instance, 'status': 503, 'body': {'error': {'code': 'syslog_unavailable', 'message': 'Сервер журналов недоступен.'}}}
