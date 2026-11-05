#!/usr/bin/env python3
"""Private, finite GitHub delivery routes. No ambient proxy or direct fallback."""
from __future__ import annotations

import base64
import hashlib
import http.client
import importlib.util
import ipaddress
import io
import json
from pathlib import Path
import re
import socket
import ssl
import time
import urllib.error
import urllib.request
import uuid

_spec = importlib.util.spec_from_file_location('pl_proxy_delivery_files', Path(__file__).with_name('delivery.py'))
files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(files)

ERRORS = {
    'delivery_proxy_invalid': (400, 'Проверьте параметры доступа к GitHub.'),
    'delivery_proxy_conflict': (409, 'Настройки уже изменились. Обновите данные перед сохранением.'),
    'delivery_proxy_busy': (409, 'Другая операция установки выполняется или требует восстановления.'),
    'delivery_proxy_unavailable': (502, 'Не удалось подключиться к GitHub выбранным способом.'),
    'delivery_proxy_auth': (502, 'Proxy отклонил указанные данные входа.'),
    'delivery_proxy_tls': (502, 'Не удалось подтвердить TLS-сертификат GitHub.'),
    'delivery_proxy_timeout': (504, 'Истекло время подключения к GitHub.'),
    'delivery_proxy_catalog': (502, 'Подпись или совместимость каталога GitHub не подтверждена.'),
}
TEST_TIMEOUT = 30


class ProxyError(ValueError):
    def __init__(self, code='delivery_proxy_invalid'):
        self.public_code = code
        self.status, self.public_message = ERRORS[code]
        super().__init__(self.public_message)


def host(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 253 or '%' in value:
        raise ProxyError()
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        if (not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', value)
                or any(not p or len(p) > 63 or p.startswith('-') or p.endswith('-') for p in value.split('.'))):
            raise ProxyError() from None
        return value.lower()


def credential(value, maximum, empty=False):
    try:
        size = len(value.encode('utf-8')) if isinstance(value, str) else maximum + 1
    except UnicodeError:
        raise ProxyError() from None
    if (not isinstance(value, str) or not empty and not value or size > maximum
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ProxyError()
    return value


def context(ca_pem):
    if not isinstance(ca_pem, str) or len(ca_pem.encode()) > 64 * 1024:
        raise ProxyError()
    result = ssl.create_default_context()
    result.set_alpn_protocols(['http/1.1'])
    if ca_pem:
        blocks = re.findall(r'-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----', ca_pem)
        remainder = ca_pem
        for block in blocks:
            remainder = remainder.replace(block, '', 1)
        if not blocks or len(blocks) > 64 or remainder.strip() or 'PRIVATE KEY' in ca_pem:
            raise ProxyError()
        try:
            result.load_verify_locations(cadata=ca_pem)
        except (ssl.SSLError, ValueError):
            raise ProxyError() from None
    return result


def normalize(value, previous):
    if (not isinstance(value, dict) or not {'mode'} <= value.keys() <= {'mode', 'external', 'xray', 'ca_pem'}
            or value['mode'] not in ('direct', 'external', 'xray')):
        raise ProxyError()
    result = {'mode': value['mode'], 'ca_pem': value.get('ca_pem', previous.get('ca_pem', ''))}
    context(result['ca_pem'])
    if set(value) - {'mode', 'ca_pem', value['mode']}:
        raise ProxyError()
    if value['mode'] == 'direct':
        if 'direct' in value:
            raise ProxyError()
    elif value['mode'] == 'external':
        candidate = value.get('external')
        required = {'protocol', 'host', 'port', 'auth', 'username', 'password_action'}
        if not isinstance(candidate, dict) or not required <= candidate.keys() <= required | {'password'}:
            raise ProxyError()
        protocol, auth, action = candidate['protocol'], candidate['auth'], candidate['password_action']
        if (protocol not in ('http', 'socks5') or auth not in ('none', 'password')
                or action not in ('keep', 'set', 'clear') or type(candidate['port']) is not int
                or not 1 <= candidate['port'] <= 65535):
            raise ProxyError()
        username = credential(candidate['username'], 255, empty=auth == 'none')
        if protocol == 'http' and ':' in username:
            raise ProxyError()
        external = {key: candidate[key] for key in ('protocol', 'port', 'auth', 'username')}
        external['host'] = host(candidate['host'])
        if auth == 'none':
            if username or action != 'clear' or 'password' in candidate:
                raise ProxyError()
            external['password'] = ''
        elif action == 'set':
            external['password'] = credential(candidate.get('password'), 255 if protocol == 'socks5' else 1024)
        elif action == 'keep' and 'password' not in candidate:
            old = previous.get('external', {})
            if any(old.get(key) != external[key] for key in ('protocol', 'host', 'port', 'auth', 'username')) or not old.get('password'):
                raise ProxyError()
            external['password'] = credential(old['password'], 255 if protocol == 'socks5' else 1024)
        else:
            raise ProxyError()
        result['external'] = external
    else:
        candidate = value.get('xray')
        if not isinstance(candidate, dict) or set(candidate) != {'instance_id', 'inbound_tag'}:
            raise ProxyError()
        try:
            files.canonical_id(candidate['instance_id'])
            if not isinstance(candidate['inbound_tag'], str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,63}', candidate['inbound_tag']):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ProxyError() from None
        result['xray'] = dict(candidate)
    return result


class DeadlineRaw(io.RawIOBase):
    def __init__(self, raw, sock, deadline, timeout):
        self.raw, self._sock, self.deadline, self.timeout = raw, sock, deadline, timeout

    def readable(self):
        return True

    def readinto(self, buffer):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('GitHub delivery budget expired')
        self._sock.settimeout(min(self.timeout, remaining))
        return self.raw.readinto(buffer)

    def close(self):
        try:
            self.raw.close()
        finally:
            super().close()


class DeadlineSocket:
    def __init__(self, sock, deadline, timeout):
        self.sock, self.deadline, self.timeout = sock, deadline, timeout

    def __getattr__(self, name):
        return getattr(self.sock, name)

    def makefile(self, mode='rb', *args, **kwargs):
        if mode != 'rb':
            raise ValueError('Delivery socket is read-only')
        # SocketIO retains the descriptor when HTTPConnection closes its own
        # reference. Update the absolute budget on every underlying TLS read,
        # including status lines, headers and chunk framing.
        raw = self.sock.makefile('rb', buffering=0)
        return io.BufferedReader(DeadlineRaw(raw, self.sock, self.deadline, self.timeout))


class TunnelConnection(http.client.HTTPSConnection):
    def __init__(self, destination, *, route, context, deadline, timeout=30, **kwargs):
        super().__init__(destination, timeout=timeout, context=context, **kwargs)
        self.route, self.deadline = route, deadline

    def connect(self):
        raw = None
        deadline = min(self.deadline, time.monotonic() + min(self.timeout, 15))
        def exact(count):
            result = bytearray()
            while len(result) < count:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProxyError('delivery_proxy_timeout')
                raw.settimeout(remaining)
                block = raw.recv(count - len(result))
                if not block:
                    raise ProxyError('delivery_proxy_unavailable')
                result.extend(block)
            return bytes(result)
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProxyError('delivery_proxy_timeout')
            endpoint = (self.host, self.port) if self.route is None else (self.route['host'], self.route['port'])
            raw = socket.create_connection(endpoint, timeout=remaining)
            if self.route is not None and self.route['protocol'] == 'http':
                authority = self.host + ':' + str(self.port)
                headers = 'CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n'
                if self.route['auth'] == 'password':
                    token = base64.b64encode((self.route['username'] + ':' + self.route['password']).encode()).decode('ascii')
                    headers += 'Proxy-Authorization: Basic ' + token + '\r\n'
                raw.sendall((headers + '\r\n').encode('ascii'))
                response = bytearray()
                while not response.endswith(b'\r\n\r\n'):
                    if len(response) >= 16384:
                        raise ProxyError('delivery_proxy_unavailable')
                    response.extend(exact(1))
                status = re.fullmatch(rb'HTTP/1\.[01] ([0-9]{3})[^\r\n]*', bytes(response).split(b'\r\n', 1)[0])
                if status is None or status[1] != b'200':
                    raise ProxyError('delivery_proxy_auth' if status is not None and status[1] == b'407' else 'delivery_proxy_unavailable')
            elif self.route is not None:
                method = 2 if self.route['auth'] == 'password' else 0
                raw.sendall(bytes((5, 1, method)))
                if exact(2) != bytes((5, method)):
                    raise ProxyError('delivery_proxy_auth')
                if method == 2:
                    user, password = self.route['username'].encode(), self.route['password'].encode()
                    if not 1 <= len(user) <= 255 or not 1 <= len(password) <= 255:
                        raise ProxyError('delivery_proxy_auth')
                    raw.sendall(bytes((1, len(user))) + user + bytes((len(password),)) + password)
                    if exact(2) != b'\x01\x00':
                        raise ProxyError('delivery_proxy_auth')
                name = self.host.encode('idna')
                if not 1 <= len(name) <= 255:
                    raise ProxyError('delivery_proxy_unavailable')
                raw.sendall(b'\x05\x01\x00\x03' + bytes((len(name),)) + name + self.port.to_bytes(2, 'big'))
                reply = exact(4)
                if reply[:3] != b'\x05\x00\x00' or reply[3] not in (1, 3, 4):
                    raise ProxyError('delivery_proxy_unavailable')
                count = {1: 4, 4: 16}.get(reply[3])
                if count is None:
                    count = exact(1)[0]
                    if count == 0:
                        raise ProxyError('delivery_proxy_unavailable')
                exact(count + 2)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProxyError('delivery_proxy_timeout')
            raw.settimeout(remaining)
            tls = self._context.wrap_socket(raw, server_hostname=self.host)
            tls.settimeout(min(self.timeout, max(0.001, self.deadline - time.monotonic())))
            self.sock = DeadlineSocket(tls, self.deadline, self.timeout)
        except BaseException:
            if raw is not None:
                raw.close()
            raise


class TunnelHTTPS(urllib.request.HTTPSHandler):
    def __init__(self, route, tls, deadline):
        super().__init__(context=tls)
        self.route, self.deadline = route, deadline

    def https_open(self, request):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('GitHub delivery budget expired')
        return self.do_open(lambda destination, **kw: TunnelConnection(destination, route=self.route, context=self._context,
                            deadline=self.deadline, **{**kw, 'timeout': min(kw.get('timeout', 30), remaining)}), request)


class Redirects(files.Redirects):
    max_redirections = 5

    def __init__(self, deadline):
        self.deadline = deadline

    def redirect_request(self, request, fp, code, message, headers, url):
        if time.monotonic() >= self.deadline:
            raise TimeoutError('GitHub delivery budget expired')
        return super().redirect_request(request, fp, code, message, headers, url)


def network_error(error):
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, ProxyError):
        return reason
    if isinstance(reason, (ssl.SSLError, ssl.CertificateError)):
        return ProxyError('delivery_proxy_tls')
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return ProxyError('delivery_proxy_timeout')
    return ProxyError('delivery_proxy_unavailable')


class DeliveryProxy:
    def __init__(self, delivery):
        self.delivery, self.parent, self.root = delivery, delivery.parent, delivery.root
        self.path = self.root / 'private/delivery-proxy.json'

    def load(self):
        if not self.path.exists() and not self.path.is_symlink():
            return {'schema': 1, 'revision': 0, 'configuration': {'mode': 'direct', 'ca_pem': ''}, 'operations': []}
        try:
            value = files.read(self.path, limit=96 * 1024)
            if (self.path.stat().st_mode & 0o077 or set(value) != {'schema', 'revision', 'configuration', 'operations'}
                    or value['schema'] != 1 or type(value['revision']) is not int or not 0 <= value['revision'] < 2**53 - 1
                    or not isinstance(value['operations'], list) or len(value['operations']) > 64):
                raise ValueError()
            candidate = dict(value['configuration'])
            if candidate.get('mode') == 'external':
                external = dict(candidate['external'])
                if set(external) != {'protocol', 'host', 'port', 'auth', 'username', 'password'}:
                    raise ValueError()
                external['password_action'] = 'set' if external['auth'] == 'password' else 'clear'
                if external['auth'] == 'none':
                    if external.pop('password') != '':
                        raise ValueError()
                candidate['external'] = external
            if normalize(candidate, {}) != value['configuration']:
                raise ValueError()
            for operation in value['operations']:
                if (not isinstance(operation, dict) or set(operation) != {'operation_id', 'sha256'}
                        or not files.HEX.fullmatch(operation.get('sha256', ''))):
                    raise ValueError()
                files.canonical_id(operation['operation_id'])
            return value
        except (ValueError, TypeError, KeyError, OSError, AttributeError):
            raise ProxyError('delivery_proxy_unavailable') from None

    def xray(self, selection, require_running=True):
        try:
            controller = self.parent.xray()
            instance = selection['instance_id']
            with controller.instance_lock(instance):
                state = controller.active(instance)
                selected = controller.selected(instance, state['current'])
                obj = controller.inspect(instance)
                if obj is None or require_running and not obj.get('State', {}).get('Running'):
                    raise ValueError()
                public = next(item for item in selected['public']['inbounds'] if item['tag'] == selection['inbound_tag'])
                private = next(item for item in selected['config']['inbounds'] if item['tag'] == selection['inbound_tag'])
                if public['protocol'] not in ('http', 'socks'):
                    raise ValueError()
                result = {'protocol': 'socks5' if public['protocol'] == 'socks' else 'http', 'host': public['listen'],
                          'port': public['port'], 'auth': public['auth'], 'username': '', 'password': ''}
                if public['auth'] == 'password':
                    account = private['settings']['accounts'][0]
                    result.update(username=credential(account['user'], 255),
                                  password=credential(account['pass'], 255 if result['protocol'] == 'socks5' else 1024))
                return result
        except (ValueError, OSError, AttributeError, KeyError, TypeError, StopIteration, files.subprocess.SubprocessError):
            raise ProxyError('delivery_proxy_unavailable') from None

    def candidates(self):
        base = self.root / 'modules/xray/instances'
        if not base.is_dir() or base.is_symlink():
            return []
        result = []
        try:
            controller = self.parent.xray()
            for index, path in enumerate(base.iterdir()):
                if len(result) >= 64 or index >= 64:
                    break
                if path.is_symlink() or not path.is_dir():
                    continue
                try:
                    files.canonical_id(path.name)
                    with controller.instance_lock(path.name):
                        state = controller.active(path.name)
                        public = controller.selected(path.name, state['current'])['public']
                        obj = controller.inspect(path.name)
                        ready = bool(obj and obj.get('State', {}).get('Running'))
                        for item in public['inbounds']:
                            if len(result) == 64:
                                break
                            result.append({'instance_id': path.name, 'inbound_tag': item['tag'],
                                           'protocol': 'socks5' if item['protocol'] == 'socks' else 'http',
                                           'listen': item['listen'], 'port': item['port'], 'auth': item['auth'], 'ready': ready})
                except (ValueError, OSError, KeyError, TypeError, files.subprocess.SubprocessError):
                    continue
        except (ValueError, OSError, AttributeError, files.subprocess.SubprocessError):
            pass
        return result

    def route(self, configuration, require_running=True):
        if configuration['mode'] == 'xray':
            return self.xray(configuration['xray'], require_running=require_running)
        return configuration.get('external')

    def projection(self, value):
        configuration = value['configuration']
        public = {'mode': configuration['mode']}
        if 'external' in configuration:
            public['external'] = {k: v for k, v in configuration['external'].items() if k != 'password'}
            public['external']['password_configured'] = bool(configuration['external']['password'])
        if 'xray' in configuration:
            public['xray'] = dict(configuration['xray'])
        error = None
        try:
            self.route(configuration)
        except ProxyError as failure:
            error = failure
        return {'core_api': 1, 'revision': value['revision'], 'configuration': public,
                'custom_ca': bool(configuration['ca_pem']),
                'ca_sha256': hashlib.sha256(configuration['ca_pem'].encode()).hexdigest() if configuration['ca_pem'] else '',
                'xray_inbounds': self.candidates(), 'error_code': error.public_code if error else '',
                'error': error.public_message if error else ''}

    def status(self, body):
        if body != {}:
            raise ProxyError()
        return self.projection(self.load())

    def request(self, body, configure=False):
        required = {'revision', 'configuration'} | ({'operation_id'} if configure else set())
        if not isinstance(body, dict) or set(body) != required or type(body['revision']) is not int or not 0 <= body['revision'] < 2**53 - 1:
            raise ProxyError()
        if configure:
            try:
                files.canonical_id(body['operation_id'])
            except (ValueError, TypeError, AttributeError):
                raise ProxyError() from None

    def configure(self, body):
        self.request(body, configure=True)
        fingerprint = hashlib.sha256(files.json_bytes(body)).hexdigest()
        try:
            with self.delivery.lock(blocking=False), self.delivery.worker_lock(blocking=False), self.delivery.lifecycle_lock(blocking=False):
                try:
                    self.delivery.require_idle()
                except ValueError:
                    raise ProxyError('delivery_proxy_busy') from None
                previous = self.load()
                old = next((op for op in previous['operations'] if op['operation_id'] == body['operation_id']), None)
                if old:
                    if old['sha256'] != fingerprint:
                        raise ProxyError('delivery_proxy_conflict')
                    return self.projection(previous)
                if body['revision'] != previous['revision']:
                    raise ProxyError('delivery_proxy_conflict')
                candidate = normalize(body['configuration'], previous['configuration'])
                self.route(candidate, require_running=False)
                value = {'schema': 1, 'revision': previous['revision'] + 1, 'configuration': candidate,
                         'operations': (previous['operations'] + [{'operation_id': body['operation_id'], 'sha256': fingerprint}])[-64:]}
                files.directory(self.path.parent)
                files.atomic(self.path, value)
                return self.projection(value)
        except BlockingIOError:
            raise ProxyError('delivery_proxy_busy') from None

    def download(self, url, destination, size, expected=None, *, configuration=None, testing=False):
        deadline = time.monotonic() + (TEST_TIMEOUT if testing else 1800)
        selected = self.load()['configuration'] if configuration is None else configuration
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects(deadline),
                                                 TunnelHTTPS(self.route(selected), context(selected['ca_pem']), deadline))
            return files.download(url, destination, size, expected, opener=opener,
                                  timeout=15 if testing else 30, absolute_deadline=deadline)
        except ProxyError:
            raise
        except (ValueError, OSError, http.client.HTTPException) as error:
            raise network_error(error) from None

    def test(self, body):
        self.request(body)
        try:
            import tempfile
            with self.delivery.lock(exclusive=False, blocking=False), self.delivery.worker_lock(blocking=False), self.delivery.lifecycle_lock(exclusive=False, blocking=False):
                try:
                    self.delivery.require_idle()
                except ValueError:
                    raise ProxyError('delivery_proxy_busy') from None
                previous = self.load()
                if body['revision'] != previous['revision']:
                    raise ProxyError('delivery_proxy_conflict')
                candidate = normalize(body['configuration'], previous['configuration'])
                result = {'ok': False, 'checked_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                          'mode': candidate['mode'], 'latest_version': '', 'error_code': '', 'error': ''}
                try:
                    with tempfile.TemporaryDirectory(prefix='pl-proxy-test-') as temporary:
                        raw = self.download(files.CATALOG_URL, Path(temporary) / 'catalog.json', 1024**2,
                                            configuration=candidate, testing=True)
                    try:
                        value = files.verify_catalog(files.load_json(raw), self.delivery.key,
                                                     self.delivery.catalog(allow_expired=True))
                    except (ValueError, OSError, files.subprocess.SubprocessError):
                        raise ProxyError('delivery_proxy_catalog') from None
                    result.update(ok=True, latest_version=value['version'])
                except (ProxyError, OSError, http.client.HTTPException) as error:
                    failure = error if isinstance(error, ProxyError) else network_error(error)
                    result.update(error_code=failure.public_code, error=failure.public_message)
                return result
        except BlockingIOError:
            raise ProxyError('delivery_proxy_busy') from None
