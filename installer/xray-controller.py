#!/usr/bin/env python3
"""Finite Xray module lifecycle. Imported credentials never leave root-owned plans.

Composed by module-controller.Controller. It supplies root, installation and docker;
this controller shares its lifecycle lock and has an independent owned file tree.
"""
from __future__ import annotations

import base64
import copy
import errno
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import urllib.parse
import uuid
from contextlib import contextmanager, nullcontext

BINARY = '/usr/local/bin/xray'
FLAGS = ['run', '-config', '/etc/xray/config.json']
PRIVATE_RANGES = tuple(ipaddress.IPv4Network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


def identifier(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise ValueError('Canonical UUID required') from None
    return value


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode() + b'\n'


def directory(path, create=True, mode=0o700):
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise ValueError('Unsafe Xray directory')
    if create and not path.exists():
        try:
            path.mkdir(mode=mode)
        except FileExistsError:
            pass
        else:
            # The service UMask=0077 must not make the new config bind unreadable
            # for container UID65534. Existing directory drift is never repaired.
            path.chmod(mode)
    if (not path.is_dir() or path.stat().st_uid != os.geteuid()
            or path.stat().st_mode & 0o7777 != mode):
        raise ValueError('Unsafe Xray directory ownership or mode')


def read_file(path, mode=0o600, limit=256 * 1024):
    if (path.is_symlink() or not path.is_file() or path.stat().st_uid != os.geteuid()
            or path.stat().st_mode & 0o777 != mode or path.stat().st_size > limit):
        raise ValueError('Unsafe Xray file ownership or size')
    return path.read_bytes()


def atomic(path, value, mode=0o600):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError('Unsafe Xray state')
    data = value if isinstance(value, bytes) else encoded(value)
    temp = path.with_name(path.name + '.new.' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        fsync_directory(path.parent)
    finally:
        temp.unlink(missing_ok=True)


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def operation_lock(operations, operation):
    # Observational refreshes share instance admission, but the same durable
    # operation ID must still serialize conflict detection and journal writes.
    # Fixed stripes bound lock files even when polling creates fresh UUIDs.
    slot = hashlib.sha256(identifier(operation).encode()).digest()[0] % 64
    path = operations / ('operation-slot-' + format(slot, '02x') + '.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600:
        os.close(fd)
        raise ValueError('Unsafe module operation lock')
    with os.fdopen(fd, 'a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def text(value, maximum=256, empty=False):
    if (not isinstance(value, str) or len(value.encode()) > maximum
            or (not empty and not value) or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError('Invalid Xray text value')
    return value


def hostname(value):
    text(value, 253)
    try:
        ipaddress.ip_address(value)
    except ValueError:
        if any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', p)
               for p in value.rstrip('.').split('.')):
            raise ValueError('Invalid outbound hostname') from None
    return value


class XrayInputError(ValueError):
    def __init__(self, code):
        self.public_code = code
        super().__init__(code)


def parse_outbound(link):
    """Connection URI parser, never a subscription client. No I/O or URL fetch."""
    text(link, 16384)
    if re.search(r'%(?![a-fA-F0-9]{2})', link):
        raise ValueError('Invalid connection URI encoding')
    try:
        uri = urllib.parse.urlsplit(link)
        host, port = uri.hostname, uri.port
        if uri.scheme not in ('vless', 'trojan', 'http', 'socks', 'socks5') or uri.path not in ('', '/'):
            raise ValueError()
        if not host or type(port) is not int or not 1 <= port <= 65535:
            raise ValueError()
        hostname(host)
        pairs = urllib.parse.parse_qsl(uri.query, keep_blank_values=True, strict_parsing=True,
                                      max_num_fields=24, errors='strict')
        if len(dict(pairs)) != len(pairs):
            raise ValueError()
        query = dict(pairs)
        allowed = {'type', 'security', 'sni', 'fp', 'alpn', 'pbk', 'sid', 'spx', 'flow', 'encryption', 'headerType', 'support-x25519mlkem768'}
        if set(query) - allowed:
            raise XrayInputError('xray_unsupported_outbound_parameters')
        if query.get('type', 'tcp') != 'tcp' or query.get('headerType', 'none') != 'none':
            raise XrayInputError('xray_unsupported_transport')
        user = urllib.parse.unquote(uri.username or '', errors='strict')
        password = urllib.parse.unquote(uri.password or '', errors='strict')
        name = urllib.parse.unquote(uri.fragment, errors='strict')
        text(name, 128, empty=True)
        protocol = 'socks' if uri.scheme == 'socks5' else uri.scheme
        stream = {'network': 'tcp'}
        if protocol in ('vless', 'trojan'):
            security = query.get('security', 'tls' if protocol == 'trojan' else '')
            if security not in ('tls', 'reality') or (protocol == 'trojan' and security != 'tls'):
                raise ValueError()
            sni = hostname(query.get('sni', host))
            fingerprint = query.get('fp', 'chrome')
            if fingerprint not in ('chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'):
                raise ValueError()
            stream['security'] = security
            if security == 'reality':
                # 3x-ui includes a Mihomo URI import hint. Xray negotiates
                # REALITY's key exchange natively; this is not a JSON setting.
                if query.get('support-x25519mlkem768', 'true') not in ('true', 'false'):
                    raise ValueError()
                public_key = query.get('pbk', '')
                key = base64.urlsafe_b64decode(public_key + '=' * (-len(public_key) % 4))
                short = query.get('sid', '')
                if len(key) != 32 or not re.fullmatch(r'[A-Za-z0-9_-]{43}', public_key) or not re.fullmatch(r'(?:[0-9a-fA-F]{2}){0,8}', short):
                    raise ValueError()
                spider = query.get('spx', '/')
                if not spider.startswith('/') or len(spider) > 256:
                    raise ValueError()
                stream['realitySettings'] = {'serverName': sni, 'fingerprint': fingerprint,
                                             'password': public_key, 'shortId': short, 'spiderX': spider}
                if 'alpn' in query:
                    raise ValueError()
            else:
                if set(query) & {'pbk', 'sid', 'spx', 'support-x25519mlkem768'}:
                    raise ValueError()
                tls = {'serverName': sni, 'fingerprint': fingerprint}
                if 'alpn' in query:
                    alpn = query['alpn'].split(',')
                    if not alpn or any(v not in ('h2', 'http/1.1') for v in alpn):
                        raise ValueError()
                    tls['alpn'] = alpn
                stream['tlsSettings'] = tls
            flow = query.get('flow', '')
            if flow not in ('', 'xtls-rprx-vision') or (protocol != 'vless' and flow):
                raise ValueError()
            if protocol == 'vless':
                identifier(user)
                if password or query.get('encryption', 'none') != 'none':
                    raise ValueError()
                account = {'id': user, 'encryption': 'none'}
                if flow:
                    account['flow'] = flow
                settings = {'vnext': [{'address': host, 'port': port, 'users': [account]}]}
            else:
                if uri.password is not None or not user or set(query) & {'encryption', 'flow'}:
                    raise ValueError()
                text(user, 1024)
                settings = {'servers': [{'address': host, 'port': port, 'password': user}]}
        else:
            if query:
                raise ValueError()
            server = {'address': host, 'port': port}
            if user or password:
                text(user, 128)
                text(password, 1024)
                server['users'] = [{'user': user, 'pass': password}]
            settings = {'servers': [server]}
        outbound = {'tag': 'proxy', 'protocol': protocol, 'settings': settings, 'streamSettings': stream}
        public = {'mode': 'imported', 'protocol': protocol, 'server': host, 'port': port, 'name': name}
        return outbound, public
    except XrayInputError:
        raise
    except (ValueError, TypeError, UnicodeError, AttributeError):
        # No parser exception may interpolate raw credentials or URI components.
        raise XrayInputError('xray_invalid_outbound') from None


def default_public():
    return {'revision': 0, 'ref': '', 'inbounds': [], 'outbound': {'mode': 'direct', 'protocol': '',
            'server': '', 'port': 0, 'name': ''}, 'routing': 'proxy_all'}


def render(inbounds, outbound, routing):
    proxy = outbound if outbound is not None else {'tag': 'proxy', 'protocol': 'freedom', 'settings': {}}
    rules = [{'type': 'field', 'inboundTag': ['api'], 'outboundTag': 'api'}]
    if routing == 'private_direct':
        rules.append({'type': 'field', 'ip': ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10'], 'outboundTag': 'direct'})
    rules.append({'type': 'field', 'network': 'tcp,udp', 'outboundTag': 'proxy'})
    return {'log': {'loglevel': 'warning', 'access': 'none'},
            'api': {'tag': 'api', 'services': ['StatsService']}, 'stats': {},
            'policy': {'system': {'statsInboundUplink': True, 'statsInboundDownlink': True,
                                  'statsOutboundUplink': True, 'statsOutboundDownlink': True}},
            'inbounds': [{'tag': 'api', 'listen': '127.0.0.1', 'port': 10085,
                          'protocol': 'dokodemo-door', 'settings': {'address': '127.0.0.1'}}] + inbounds,
            'outbounds': [proxy, {'tag': 'direct', 'protocol': 'freedom', 'settings': {}},
                          {'tag': 'block', 'protocol': 'blackhole', 'settings': {}}],
            'routing': {'domainStrategy': 'AsIs', 'rules': rules}}


class XrayController:
    def __init__(self, parent):
        self.parent = parent
        self.root, self.installation = Path(parent.root), parent.installation
        self.docker = parent.docker
        self.base = self.root / 'modules' / 'xray'
        directory(self.base)
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        directory(self.instances)
        directory(self.operations)
        self.image_contract = self.resolve_image()
        self.image = self.image_contract['id']
        self.version = self.image_contract['labels']['org.opencontainers.image.version'].removeprefix('v')
        self._checked_runtimes = {}

    def revoke_runtime(self, instance):
        self._checked_runtimes.pop(instance, None)

    def checked_stats(self, instance):
        """Reuse only recently verified identity/version; counters are always live."""
        try:
            state = self.active(instance)
            cached = self._checked_runtimes.get(instance)
            if cached is not None and (time.monotonic() >= cached['expires'] or cached['current'] != state['current']):
                self.revoke_runtime(instance)
                cached = None
            checked_at = time.monotonic()
            obj = cached['container'] if cached is not None else self.inspect(instance)
            if obj is None:
                raise ValueError('Xray container absent but managed artifacts remain')
            if not obj.get('State', {}).get('Running'):
                self.revoke_runtime(instance)
                return state, False, []
            counters = self.stats_for(obj, verify_version=cached is None)
            if cached is None:
                self._checked_runtimes[instance] = {'expires': checked_at + 30, 'current': state['current'], 'container': obj}
            return state, True, counters
        except (ValueError, OSError, KeyError, TypeError):
            self.revoke_runtime(instance)
            raise

    def resolve_image(self):
        private = self.root / 'private'
        directory(private, create=False)
        if private.stat().st_mode & 0o077:
            raise ValueError('Unsafe module image directory')
        value = json.loads(read_file(private / 'module-images.json', limit=32768))
        state = json.loads(read_file(self.root / 'state' / 'installation.json'))
        image = value.get('xray', {})
        labels = image.get('labels', {}) if isinstance(image, dict) else {}
        if (value.get('schema') != 1 or value.get('installation') != self.installation
                or value.get('manifest_sha256') != state.get('manifest_sha256')
                or not re.fullmatch(r'[0-9a-f]{64}', value.get('manifest_sha256', ''))
                or state.get('install_id') != self.installation
                or set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                or image.get('architecture') not in ('amd64', 'arm64')
                or image.get('recipe') != 'deploy/images/xray.Dockerfile'
                or labels.get('pl.module.id') != 'xray' or labels.get('pl.module.config.version') != '1'
                or not re.fullmatch(r'v?\d+\.\d+\.\d+', labels.get('org.opencontainers.image.version', ''))
                or not re.fullmatch(r'[0-9a-f]{40}', labels.get('org.opencontainers.image.revision', ''))
                or labels.get('org.opencontainers.image.source') != 'https://github.com/XTLS/Xray-core'):
            raise ValueError('Invalid bundled Xray image contract')
        return image

    def verify_image(self):
        value = json.loads(self.docker('image', 'inspect', self.image))[0]
        if (value.get('Id') != self.image or value.get('Os') != 'linux'
                or value.get('Architecture') != self.image_contract['architecture']
                or any((value.get('Config', {}).get('Labels') or {}).get(k) != v
                       for k, v in self.image_contract['labels'].items())):
            raise ValueError('Bundled Xray image identity mismatch')
        return value

    @contextmanager
    def locked(self):
        path = self.root / 'modules' / 'controller.lock'
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o077:
            os.close(fd)
            raise ValueError('Unsafe module lifecycle lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    @contextmanager
    def instance_lock(self, instance, exclusive=False):
        path = self.operations / ('instance-' + identifier(instance) + '.lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600:
            os.close(fd)
            raise ValueError('Unsafe Xray instance lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def paths(self, instance, create=False):
        identifier(instance)
        base = self.instances / instance
        if create:
            directory(base)
            directory(base / 'plans')
            directory(base / 'config', mode=0o755)
        else:
            directory(base, create=False)
            directory(base / 'plans', create=False)
            directory(base / 'config', create=False, mode=0o755)
        return base

    def state(self, instance):
        path = self.paths(instance) / 'state.json'
        value = json.loads(read_file(path))
        if not isinstance(value, dict) or set(value) != {'current', 'pending'}:
            raise ValueError('Invalid Xray configuration state')
        if value['current'] is not None:
            self.plan(instance, value['current'])
        if value['pending'] is not None:
            pending = value['pending']
            if not isinstance(pending, dict) or set(pending) != {'operation_id', 'ref'}:
                raise ValueError('Invalid pending Xray operation')
            identifier(pending['operation_id'])
            self.plan(instance, pending['ref'])
        return value

    def plan(self, instance, ref):
        identifier(instance); identifier(ref)
        value = json.loads(read_file(self.instances / instance / 'plans' / (ref + '.json')))
        if (not isinstance(value, dict) or set(value) != {'schema', 'installation', 'instance_id', 'public', 'config'}
                or value['schema'] != 1 or value['installation'] != self.installation or value['instance_id'] != instance
                or value['public'].get('ref') != ref or type(value['public'].get('revision')) is not int
                or value['public']['revision'] < 1 or not isinstance(value['config'], dict)):
            raise ValueError('Invalid immutable Xray plan')
        return value

    def selected(self, instance, ref):
        if ref is None:
            return {'public': default_public(), 'config': render([], None, 'proxy_all')}
        return self.plan(instance, ref)

    def active(self, instance, allow_pending=False):
        state = self.state(instance)
        if state['pending'] and not allow_pending:
            raise ValueError('Xray configuration requires same-operation reconciliation')
        values = [encoded(self.selected(instance, state['current'])['config'])]
        if state['pending']:
            values.append(encoded(self.plan(instance, state['pending']['ref'])['config']))
        path = self.paths(instance) / 'config' / 'config.json'
        if read_file(path, mode=0o444) not in values:
            raise ValueError('Xray active configuration drift')
        return state

    def host_addresses(self):
        try:
            result = subprocess.run(['ip', '-j', '-4', 'address', 'show'], cwd=self.root,
                                    env=getattr(self.parent, 'env', {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}),
                                    capture_output=True, timeout=10, check=True)
            values = json.loads(result.stdout)
            return {a['local'] for interface in values for a in interface.get('addr_info', []) if a.get('family') == 'inet'}
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
            raise XrayInputError('xray_host_addresses_unavailable') from None

    def prepare(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id', 'configuration'}:
            raise ValueError('Invalid Xray preparation request')
        instance = identifier(body['instance_id'])
        with self.instance_lock(instance, exclusive=True), self.locked():
            self.revoke_runtime(instance)
            self.active(instance)
            value = body['configuration']
            if not isinstance(value, dict) or set(value) - {'revision', 'ref', 'inbounds', 'outbound', 'routing'}:
                raise ValueError('Invalid Xray configuration fields')
            if type(value.get('revision')) is not int or not 0 <= value['revision'] < 2**53 - 1:
                raise ValueError('Invalid Xray revision')
            previous = self.selected(instance, value.get('ref') or None)
            if previous['public']['revision'] != value['revision']:
                raise ValueError('Xray reference revision mismatch')
            inbounds = value.get('inbounds')
            if not isinstance(inbounds, list) or len(inbounds) > 16 or value.get('routing') not in ('proxy_all', 'private_direct'):
                raise ValueError('Invalid Xray inbounds or routing')
            addresses, tags, bindings, public, private = self.host_addresses(), set(), set(), [], []
            for index, item in enumerate(inbounds):
                allowed = {'tag', 'protocol', 'listen', 'port', 'auth', 'username', 'password', 'password_set'}
                if not isinstance(item, dict) or set(item) - allowed:
                    raise ValueError('Invalid Xray inbound fields')
                tag = item.get('tag'); text(tag, 64)
                if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,63}', tag) or tag in tags or tag in ('api', 'proxy', 'direct', 'block'):
                    raise ValueError('Invalid or duplicate Xray inbound tag')
                tags.add(tag)
                protocol, auth = item.get('protocol'), item.get('auth')
                listen, port = item.get('listen'), item.get('port')
                if protocol not in ('socks', 'http') or auth not in ('none', 'password') or type(port) is not int or not 1024 <= port <= 65535 or port == 10085:
                    raise ValueError('Invalid Xray inbound protocol/authentication/port')
                try:
                    ip = ipaddress.IPv4Address(listen)
                except (ipaddress.AddressValueError, TypeError):
                    raise ValueError('Inbound requires a canonical local IPv4 address') from None
                if (str(ip) != listen or (listen != '127.0.0.1' and not any(ip in n for n in PRIVATE_RANGES))
                        or listen not in addresses or (listen, port) in bindings):
                    raise XrayInputError('xray_invalid_bind_address')
                bindings.add((listen, port))
                username, password = item.get('username', ''), item.get('password', '')
                text(username, 128, empty=auth == 'none'); text(password, 1024, empty=True)
                if auth == 'none' and (username or password):
                    raise ValueError('Unauthenticated inbound cannot include credentials')
                if auth == 'password' and not password:
                    old = next((i for i in previous['public']['inbounds'] if i['tag'] == tag and i['username'] == username and i['auth'] == 'password'), None)
                    if old is None:
                        raise ValueError('New authenticated inbound requires a password')
                    old_private = next(i for i in previous['config']['inbounds'] if i['tag'] == tag)
                    account = old_private['settings']['accounts'][0]
                    password = account['pass']
                settings = {'auth': 'password' if auth == 'password' else 'noauth', 'udp': False} if protocol == 'socks' else {}
                if auth == 'password':
                    settings['accounts'] = [{'user': username, 'pass': password}]
                private.append({'tag': tag, 'protocol': protocol, 'listen': '0.0.0.0', 'port': 20000 + index, 'settings': settings})
                public.append({'tag': tag, 'protocol': protocol, 'listen': listen, 'port': port, 'auth': auth,
                               'username': username, 'password_set': auth == 'password'})
            outbound = value.get('outbound')
            if not isinstance(outbound, dict) or set(outbound) - {'mode', 'link'} or outbound.get('mode') not in ('direct', 'imported'):
                raise ValueError('Invalid Xray outbound fields')
            link = outbound.get('link', '')
            text(link, 16384, empty=True)
            private_outbound, public_outbound = None, default_public()['outbound']
            if outbound['mode'] == 'direct':
                if link:
                    raise ValueError('Direct outbound does not accept a link')
            elif link:
                private_outbound, public_outbound = parse_outbound(link)
            else:
                if previous['public']['outbound']['mode'] != 'imported':
                    raise ValueError('Imported outbound requires a connection URI')
                private_outbound = copy.deepcopy(previous['config']['outbounds'][0])
                public_outbound = copy.deepcopy(previous['public']['outbound'])
            ref = str(uuid.uuid4())
            summary = {'revision': value['revision'] + 1, 'ref': ref, 'inbounds': public,
                       'outbound': public_outbound, 'routing': value['routing']}
            plan = {'schema': 1, 'installation': self.installation, 'instance_id': instance,
                    'public': summary, 'config': render(private, private_outbound, value['routing'])}
            # UUID file creation is exclusive: a saved plan is never rewritten.
            path = self.paths(instance) / 'plans' / (ref + '.json')
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600); stream.write(encoded(plan)); stream.flush(); os.fsync(stream.fileno())
            fsync_directory(path.parent)
            return summary

    def labels(self, instance, ref):
        return {'pl.installation': self.installation, 'pl.module': 'xray', 'pl.instance': instance,
                'pl.xray.plan': ref or 'initial'}

    def name(self, instance):
        return self.installation + '-xray-' + identifier(instance)

    def inspect(self, instance, allow_pending=False):
        name = self.name(instance)
        found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
        if not found:
            return None
        image = self.verify_image()
        value = json.loads(self.docker('container', 'inspect', name))[0]
        state = self.active(instance, allow_pending=allow_pending)
        refs = [state['current']]
        if allow_pending and state['pending']:
            refs.append(state['pending']['ref'])
        config, host = value.get('Config', {}), value.get('HostConfig', {})
        labels = config.get('Labels') or {}
        ref = next((r for r in refs if all(labels.get(k) == v for k, v in self.labels(instance, r).items())), False)
        if ref is False:
            raise ValueError('Foreign Xray container ownership')
        selected = self.selected(instance, ref)
        ports = self.bindings(selected['public'])
        actual_mounts = {(m.get('Type'), m.get('Source'), m.get('Destination'), m.get('RW')) for m in value.get('Mounts', [])}
        expected_mounts = {('bind', str(self.paths(instance) / 'config'), '/etc/xray', False)}
        if (not re.fullmatch(r'[0-9a-f]{64}', value.get('Id', '')) or value.get('Image') != self.image
                or config.get('Image') != self.image or config.get('Cmd') != FLAGS
                or config.get('Entrypoint') != [BINARY] or config.get('User') != '65534:65534'
                or actual_mounts != expected_mounts or (host.get('PortBindings') or {}) != ports
                or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('NetworkMode') != 'bridge'
                or host.get('Memory') != 384 * 1024**2 or host.get('NanoCpus') != 1_000_000_000
                or host.get('PidsLimit') != 64 or host.get('CapDrop') != ['ALL']
                or host.get('CapAdd') or host.get('Devices') or host.get('Binds')
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])
                or config.get('Env') != image.get('Config', {}).get('Env')
                or config.get('WorkingDir') != image.get('Config', {}).get('WorkingDir')
                or host.get('PublishAllPorts') or host.get('Tmpfs')
                or host.get('PidMode') not in (None, '')
                or host.get('IpcMode') not in (None, 'private')):
            raise ValueError('Xray container drift; manual inspection required')
        return value

    @staticmethod
    def bindings(public):
        return {str(20000 + index) + '/tcp': [{'HostIp': item['listen'], 'HostPort': str(item['port'])}]
                for index, item in enumerate(public['inbounds'])}

    def initialize(self, instance):
        base = self.paths(instance, create=True)
        if (self.operations / ('remove-' + instance + '.json')).exists():
            raise ValueError('Removed Xray instance cannot be recreated')
        state = base / 'state.json'
        if not state.exists() and not state.is_symlink():
            if any(p.name not in ('plans', 'config') for p in base.iterdir()) or any((base / 'plans').iterdir()) or any((base / 'config').iterdir()):
                raise ValueError('Unowned Xray initialization artifacts')
            atomic(state, {'current': None, 'pending': None})
        selected = self.state(instance)
        path = base / 'config' / 'config.json'
        if not path.exists() and not path.is_symlink():
            if selected != {'current': None, 'pending': None} or any((base / 'plans').iterdir()) or any((base / 'config').iterdir()):
                raise ValueError('Managed Xray configuration missing')
            atomic(path, encoded(render([], None, 'proxy_all')), 0o444)
        self.active(instance)

    def preflight_ports(self, instance, public):
        current = self.inspect(instance, allow_pending=True)
        own_id = current['Id'] if current else None
        requested = {(i['listen'], str(i['port'])) for i in public['inbounds']}
        # Docker NAT allocations may not appear in listening sockets when its
        # userland proxy is disabled, so check both ownership and real bindability.
        ids = self.docker('container', 'ls', '--format', '{{.ID}}').decode().splitlines()
        if len(ids) > 10000:
            raise ValueError('Too many engine allocations to verify')
        if ids:
            if any(not re.fullmatch(r'[0-9a-f]{12,64}', i) for i in ids):
                raise ValueError('Invalid engine container identity')
            for start in range(0, len(ids), 128):
                for obj in json.loads(self.docker('container', 'inspect', *ids[start:start + 128])):
                    if obj.get('Id') == own_id:
                        continue
                    for key, binds in (obj.get('HostConfig', {}).get('PortBindings') or {}).items():
                        if not key.endswith('/tcp'):
                            continue
                        for bind in binds or []:
                            if any(bind.get('HostPort') == p and bind.get('HostIp') in ('', '0.0.0.0', '::', ip)
                                   for ip, p in requested):
                                raise XrayInputError('xray_port_in_use')
        owned = set()
        if current and current.get('State', {}).get('Running'):
            owned = {(b['HostIp'], b['HostPort']) for values in self.bindings(self.selected_for_container(instance, current)['public']).values() for b in values}
        for address, port in requested - owned:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                # A stopped proxy may retain closed connections in TIME_WAIT.
                # Match listener reuse without permitting a concurrent listener.
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    probe.bind((address, int(port)))
                except OSError as error:
                    code = 'xray_port_in_use' if error.errno == errno.EADDRINUSE else 'xray_bind_unavailable'
                    raise XrayInputError(code) from None

    def selected_for_container(self, instance, obj):
        label = (obj.get('Config', {}).get('Labels') or {}).get('pl.xray.plan')
        return self.selected(instance, None if label == 'initial' else label)

    def check_plan(self, instance, ref):
        plan = self.plan(instance, ref)
        self.verify_image()
        candidate = self.paths(instance) / 'config' / 'candidate.json'
        if candidate.exists() or candidate.is_symlink():
            read_file(candidate, mode=0o444)
        atomic(candidate, encoded(plan['config']), 0o444)
        try:
            self.docker('container', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                        '--security-opt', 'no-new-privileges:true', '--user', '65534:65534', '--memory', '384m',
                        '--cpus', '1', '--pids-limit', '64', '--entrypoint', BINARY,
                        '--mount', 'type=bind,source=' + str(candidate) + ',target=/etc/xray/config.json,readonly',
                        self.image, 'run', '-test', '-config', '/etc/xray/config.json', timeout=35)
        finally:
            candidate.unlink(missing_ok=True)
            fsync_directory(candidate.parent)
        return plan

    def validate(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id', 'configuration_ref'}:
            raise ValueError('Invalid Xray validation request')
        instance, ref = identifier(body['instance_id']), identifier(body['configuration_ref'])
        with self.instance_lock(instance, exclusive=True), self.locked():
            self.revoke_runtime(instance)
            self.active(instance)
            self.check_plan(instance, ref)
            self.preflight_ports(instance, self.plan(instance, ref)['public'])
            return {'valid': True}

    def destroy_container(self, instance):
        self.revoke_runtime(instance)
        obj = self.inspect(instance, allow_pending=True)
        if obj:
            if obj.get('State', {}).get('Running'):
                self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
            self.docker('container', 'rm', obj['Id'])

    def create_container(self, instance, ref):
        self.revoke_runtime(instance)
        self.verify_image()
        plan = self.selected(instance, ref)
        args = ['container', 'create', '--name', self.name(instance), '--network', 'bridge',
                '--restart', 'unless-stopped', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--user', '65534:65534', '--memory', '384m',
                '--cpus', '1', '--pids-limit', '64', '--entrypoint', BINARY,
                '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
                '--mount', 'type=bind,source=' + str(self.paths(instance) / 'config') + ',target=/etc/xray,readonly']
        for key, value in self.labels(instance, ref).items():
            args += ['--label', key + '=' + value]
        for internal, values in self.bindings(plan['public']).items():
            bind = values[0]
            args += ['--publish', bind['HostIp'] + ':' + bind['HostPort'] + ':' + internal]
        self.docker(*args, self.image, *FLAGS)
        obj = self.inspect(instance, allow_pending=True)
        if obj is None:
            raise ValueError('Xray container creation not confirmed')
        self.docker('container', 'start', obj['Id'])

    def stats(self, instance):
        instance = identifier(instance)
        with self.instance_lock(instance):
            _, running, counters = self.checked_stats(instance)
            if not running:
                raise ValueError('Xray is not running')
            return counters

    def stats_for(self, obj, verify_version=True):
        if verify_version:
            version = self.docker('container', 'exec', obj['Id'], BINARY, 'version', timeout=10).decode().splitlines()
            if not version or not re.match(r'^Xray ' + re.escape(self.version) + r'(?:\s|$)', version[0]):
                raise ValueError('Xray runtime version mismatch')
        raw = self.docker('container', 'exec', obj['Id'], BINARY, 'api', 'statsquery', '--server=127.0.0.1:10085', timeout=10)
        if len(raw) > 128 * 1024:
            raise ValueError('Xray statistics exceed limit')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) - {'stat'} or not isinstance(value.get('stat', []), list) or len(value.get('stat', [])) > 128:
            raise ValueError('Invalid Xray statistics response')
        result = []
        for stat in value.get('stat', []):
            if not isinstance(stat, dict) or set(stat) - {'name', 'value'}:
                raise ValueError('Invalid Xray statistic')
            name = stat.get('name')
            if not isinstance(name, str) or not re.fullmatch(r'(?:inbound|outbound)>>>(?:[A-Za-z][A-Za-z0-9_.-]{0,63})>>>traffic>>>(?:up|down)link', name):
                raise ValueError('Unsupported Xray statistic name')
            # protobuf JSON encodes int64 as decimal strings, not JSON numbers.
            number = stat.get('value', '0')
            if type(number) not in (str, int) or not re.fullmatch(r'[0-9]{1,19}', str(number)) or not 0 <= int(number) <= 2**63 - 1:
                raise ValueError('Invalid Xray statistic value')
            result.append({'name': name, 'value': int(number)})
        return result

    def wait_ready(self, instance, allow_pending=False):
        deadline = time.monotonic() + 30
        while True:
            obj = self.inspect(instance, allow_pending=allow_pending)
            if obj is None or not obj.get('State', {}).get('Running'):
                raise ValueError('Xray container stopped before readiness')
            try:
                return self.stats_for(obj)
            except (ValueError, KeyError, TypeError):
                if time.monotonic() >= deadline:
                    raise ValueError('Xray readiness could not be confirmed') from None
                time.sleep(.25)

    def observe(self, instance, allow_pending=False):
        self.revoke_runtime(instance)
        checked_at = time.monotonic()
        if not (self.instances / identifier(instance)).exists():
            if self.docker('container', 'ls', '-a', '--filter', 'name=^/' + self.name(instance) + '$', '--format', '{{.ID}}').decode().strip():
                raise ValueError('Xray container has no managed configuration')
            return {'state': 'absent', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0, 'error': ''}
        state = self.active(instance, allow_pending=allow_pending)
        obj = self.inspect(instance, allow_pending=allow_pending)
        selected = self.selected(instance, state['current'])
        result = {'state': 'absent', 'version': self.version, 'endpoint': '', 'targets_up': 0, 'targets_total': 0, 'error': '',
                  'configuration_revision': selected['public']['revision'],
                  'configuration_hash': hashlib.sha256(encoded(selected['config'])).hexdigest()}
        if obj is None:
            raise ValueError('Xray container absent but managed artifacts remain')
        if not obj.get('State', {}).get('Running'):
            result['state'] = 'disabled'
        else:
            self.stats_for(obj)
            result['state'] = 'running'
            self._checked_runtimes[instance] = {'expires': checked_at + 30, 'current': state['current'], 'container': obj}
        return result

    def status(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id'}:
            raise ValueError('Invalid Xray status request')
        instance = identifier(body['instance_id'])
        with self.instance_lock(instance):
            state, running, counters = self.checked_stats(instance)
            public = self.selected(instance, state['current'])['public']
            inbounds = [{key: item[key] for key in ('tag', 'protocol', 'listen', 'port')} for item in public['inbounds']]
            return {'state': 'running' if running else 'disabled', 'version': self.version, 'inbounds': inbounds,
                    'outbound': public['outbound'], 'routing': public['routing'],
                    'counters': counters}

    def ensure(self, instance):
        self.revoke_runtime(instance)
        self.initialize(instance)
        obj = self.inspect(instance)
        if obj is None:
            state = self.state(instance)
            self.preflight_ports(instance, self.selected(instance, state['current'])['public'])
            self.create_container(instance, state['current'])
        elif not obj.get('State', {}).get('Running'):
            self.preflight_ports(instance, self.selected(instance, self.state(instance)['current'])['public'])
            self.docker('container', 'start', obj['Id'])
        self.wait_ready(instance)

    def configure(self, body):
        instance, ref = body['instance_id'], body['configuration_ref']
        self.revoke_runtime(instance)
        state = self.active(instance, allow_pending=True)
        pending = {'operation_id': body['operation_id'], 'ref': ref}
        if state['pending'] and state['pending'] != pending:
            raise ValueError('Another Xray configuration requires reconciliation')
        plan, previous = self.plan(instance, ref), self.selected(instance, state['current'])
        if plan['public']['revision'] < previous['public']['revision'] or (plan['public']['revision'] == previous['public']['revision'] and ref != state['current']):
            raise ValueError('Xray configuration revision has changed')
        if ref == state['current'] and not state['pending']:
            return self.observe(instance)
        # A confirmed rejection must release the draft for editing. An interrupted
        # operation instead retains its pending journal until same-ID reconciliation.
        try:
            self.check_plan(instance, ref)
            self.preflight_ports(instance, plan['public'])
            old_obj = self.inspect(instance, allow_pending=True)
            if not state['pending'] and (old_obj is None or not old_obj.get('State', {}).get('Running')):
                raise ValueError('Enable Xray before applying configuration')
        except (ValueError, OSError, KeyError, TypeError):
            if state['pending']:
                raise
            result = self.observe(instance)
            if result['state'] != 'running':
                raise ValueError('Xray rejection cannot confirm previous active configuration') from None
            result.update(state='error', rolled_back=True, error='Xray settings were rejected; previous configuration remains active')
            return result
        state['pending'] = pending
        state_path, config_path = self.paths(instance) / 'state.json', self.paths(instance) / 'config' / 'config.json'
        atomic(state_path, state)
        try:
            self.destroy_container(instance)
            atomic(config_path, encoded(plan['config']), 0o444)
            self.create_container(instance, ref)
            self.wait_ready(instance, allow_pending=True)
        except (ValueError, OSError, KeyError, TypeError):
            try:
                self.destroy_container(instance)
                atomic(config_path, encoded(previous['config']), 0o444)
                self.create_container(instance, state['current'])
                self.wait_ready(instance, allow_pending=True)
            except (ValueError, OSError, KeyError, TypeError):
                raise ValueError('Xray apply and rollback unconfirmed; reconcile same operation') from None
            atomic(state_path, {'current': state['current'], 'pending': None})
            result = self.observe(instance)
            result.update(state='error', rolled_back=True, error='Xray was not applied; previous configuration was restored')
            return result
        atomic(state_path, {'current': ref, 'pending': None})
        return self.observe(instance)

    def owned_files(self, instance):
        base = self.paths(instance)
        if set(p.name for p in base.iterdir()) != {'config', 'plans', 'state.json'}:
            raise ValueError('Unknown Xray files; manual inspection required')
        self.active(instance, allow_pending=True)
        if set(p.name for p in (base / 'config').iterdir()) - {'config.json', 'candidate.json'}:
            raise ValueError('Unknown Xray configuration files')
        candidate = base / 'config' / 'candidate.json'
        if candidate.exists() or candidate.is_symlink():
            read_file(candidate, mode=0o444)
        for path in (base / 'plans').iterdir():
            if path.suffix != '.json':
                raise ValueError('Unknown Xray plan file')
            self.plan(instance, path.stem)
        return base

    def remove(self, instance):
        self.revoke_runtime(instance)
        identifier(instance)
        base = self.instances / instance
        marker = self.operations / ('remove-' + instance + '.json')
        if not base.exists() and not base.is_symlink():
            found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + self.name(instance) + '$', '--format', '{{.ID}}').decode().strip()
            if found:
                raise ValueError('Unowned Xray container remains')
            return
        if not marker.exists() and not marker.is_symlink():
            self.owned_files(instance)
            self.inspect(instance, allow_pending=True)
            files = {}
            for path in [base / 'state.json', *(base / 'plans').iterdir(), *(base / 'config').iterdir()]:
                mode = 0o444 if path.parent.name == 'config' else 0o600
                files[str(path.relative_to(base))] = {'mode': mode, 'sha256': hashlib.sha256(read_file(path, mode=mode)).hexdigest()}
            atomic(marker, {'installation': self.installation, 'instance_id': instance, 'files': files})
        removal = json.loads(read_file(marker))
        if (not isinstance(removal, dict) or set(removal) != {'installation', 'instance_id', 'files'}
                or removal['installation'] != self.installation or removal['instance_id'] != instance
                or not isinstance(removal['files'], dict)):
            raise ValueError('Invalid Xray removal journal')
        directory(base, create=False)
        if set(p.name for p in base.iterdir()) - {'config', 'plans', 'state.json'}:
            raise ValueError('Unknown Xray files during removal')
        actual = set()
        for name in ('config', 'plans'):
            path = base / name
            if path.exists() or path.is_symlink():
                directory(path, create=False, mode=0o755 if name == 'config' else 0o700)
                actual.update(str(p.relative_to(base)) for p in path.iterdir())
        if (base / 'state.json').exists() or (base / 'state.json').is_symlink():
            actual.add('state.json')
        if actual - set(removal['files']):
            raise ValueError('Unowned files appeared during Xray removal')
        for relative, item in removal['files'].items():
            valid_name = relative == 'state.json' or re.fullmatch(r'plans/[0-9a-f-]{36}\.json', relative) or relative in ('config/config.json', 'config/candidate.json')
            expected_mode = 0o444 if relative.startswith('config/') else 0o600
            if (not valid_name or not isinstance(item, dict) or set(item) != {'mode', 'sha256'} or item['mode'] != expected_mode
                    or not re.fullmatch(r'[0-9a-f]{64}', item['sha256'])):
                raise ValueError('Unsafe Xray removal file manifest')
            if relative in actual and hashlib.sha256(read_file(base / relative, mode=item['mode'])).hexdigest() != item['sha256']:
                raise ValueError('Xray removal artifact changed')
        found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + self.name(instance) + '$', '--format', '{{.ID}}').decode().strip()
        if found:
            # A remaining container is accepted only while its entire configuration
            # and plan ownership can still be proven by the ordinary inspector.
            self.destroy_container(instance)
        for relative in actual:
            (base / relative).unlink()
        for name in ('plans', 'config'):
            if (base / name).exists():
                (base / name).rmdir()
        base.rmdir()
        fsync_directory(self.instances)
        if self.observe(instance)['state'] != 'absent':
            raise ValueError('Xray removal not confirmed')

    def execute(self, body):
        fields = {'operation_id', 'instance_id', 'module_id', 'action'}
        if isinstance(body, dict) and body.get('action') == 'configure':
            fields.add('configuration_ref')
        if (not isinstance(body, dict) or set(body) != fields or body.get('module_id') != 'xray'
                or body.get('action') not in ('install', 'refresh', 'enable', 'disable', 'remove', 'configure')):
            raise ValueError('Unsupported Xray operation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        if body['action'] == 'configure':
            identifier(body['configuration_ref'])
        refreshing = body['action'] == 'refresh'
        with operation_lock(self.operations, operation), self.instance_lock(instance, exclusive=not refreshing), \
                (nullcontext() if refreshing else self.locked()):
            if not refreshing:
                self.revoke_runtime(instance)
            path = self.operations / (operation + '.json')
            fingerprint = hashlib.sha256(encoded(body)).hexdigest()
            if path.exists() or path.is_symlink():
                journal = json.loads(read_file(path))
                if journal.get('fingerprint') != fingerprint:
                    raise ValueError('Xray operation ID conflict')
                if journal.get('phase') == 'complete':
                    if body['action'] == 'configure':
                        return journal['result']
                    return {**self.observe(instance), 'operation_id': operation}
            atomic(path, {'fingerprint': fingerprint, 'phase': 'running', 'request': body})
            try:
                if body['action'] in ('install', 'enable'):
                    self.ensure(instance)
                elif body['action'] == 'disable':
                    self.active(instance)
                    obj = self.inspect(instance)
                    if obj and obj.get('State', {}).get('Running'):
                        self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
                elif body['action'] == 'remove':
                    self.remove(instance)
                if body['action'] == 'configure':
                    result = self.configure(body)
                else:
                    result = self.observe(instance)
                result['operation_id'] = operation
                atomic(path, {'fingerprint': fingerprint, 'phase': 'complete', 'request': body, 'result': result})
                return result
            except (ValueError, OSError, KeyError, TypeError):
                self.revoke_runtime(instance)
                # Keep the pending operation and return only a fixed safe error.
                return {'state': 'error', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0,
                        'error': 'Xray operation could not be confirmed; reconcile the same operation', 'operation_id': operation}

    def get(self, instance):
        identifier(instance)
        with self.instance_lock(instance):
            return self.observe(instance)


def module_network_args(root, installation, docker):
    import importlib.util
    helper = Path(__file__).with_name('module-network.py')
    if helper.is_symlink() or not helper.is_file():
        raise ValueError('Trusted module network allocator unavailable')
    spec = importlib.util.spec_from_file_location('pl_module_network', helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.allocation_args(root, installation, docker)


def validate_module_network(root, installation, obj, docker, *, prometheus=''):
    import importlib.util
    helper = Path(__file__).with_name('module-network.py')
    if helper.is_symlink() or not helper.is_file():
        raise ValueError('Trusted module network allocator unavailable')
    spec = importlib.util.spec_from_file_location('pl_module_network', helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if prometheus:
        module.validate_existing(root, installation, obj, docker, prometheus=prometheus)
    else:
        module.validate_existing(root, installation, obj, docker)


def module_network_error(error, fallback):
    if getattr(error, 'public_code', None) == 'module_network_pool_exhausted':
        return 'module_network_pool_exhausted: Исчерпан диапазон сетей модулей. Дополнительный диапазон задаётся при установке через --module-network-cidr.'
    return fallback
