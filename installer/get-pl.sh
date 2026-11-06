#!/bin/sh
# PL bootstrap. The release catalog and complete payload are verified before execution.
set -eu
[ "$(id -u)" = 0 ] || { echo 'PL: запустите установку через sudo.' >&2; exit 1; }
if ! command -v python3 >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    [ -f /etc/os-release ] || { echo 'PL: требуется Ubuntu или Debian.' >&2; exit 1; }
    . /etc/os-release
    case "${ID:-}" in ubuntu|debian) ;; *) echo 'PL: требуется Ubuntu или Debian.' >&2; exit 1;; esac
    echo 'PL: Python/OpenSSL отсутствуют; системные зависимости устанавливаются через apt с прямым доступом. --proxy применяется к HTTPS загрузкам PL и ключа Docker.' >&2
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 openssl ca-certificates
fi
exec python3 - "$@" <<'PL_BOOTSTRAP_PY'
import argparse
import base64
import hashlib
import hmac
import http.server
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import select
import socket
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from contextlib import contextmanager, ExitStack
import urllib.parse
import urllib.request

CATALOG = 'https://github.com/Sauke5/pl/releases/download/channel-stable/catalog.json'
PUBLIC_KEY = b'''-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMit/4wY5+txhseLK650aGNo4qU1hHkkb5teeFKliv8c=
-----END PUBLIC KEY-----
'''
MAX_PACKAGE = 8 * 1024**3

def check_url(url, redirect=False):
    value = urllib.parse.urlsplit(url)
    if value.scheme != 'https' or value.username or value.password or value.fragment:
        raise ValueError('Небезопасный адрес поставки')
    if value.hostname == 'github.com' and value.path.startswith('/Sauke5/pl/releases/download/'):
        return
    if redirect and value.hostname in ('release-assets.githubusercontent.com', 'objects.githubusercontent.com'):
        return
    raise ValueError('Адрес поставки не принадлежит PL')

class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl, True)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def proxy_host(value):
    if not isinstance(value, str) or not value or len(value) > 253:
        raise ValueError('Invalid host')
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', value):
            raise ValueError('Invalid host') from None
        if any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-')
               for label in value.split('.')):
            raise ValueError('Invalid host')
        return value.lower()


def load_download_proxy(path):
    # Read one stable private file. Neither the file nor its contents enter the bundle.
    try:
        path = Path(path)
        if any(part.is_symlink() for part in (path, *path.parents)):
            raise ValueError('Symlink')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 16384):
                raise ValueError('Private file required')
            raw = stream.read(16385)
            if len(raw) > 16384:
                raise ValueError('Too large')
        profile = json.loads(raw)
        if (not isinstance(profile, dict) or set(profile) - {'url', 'username', 'password', 'no_proxy', 'ca_file'}
                or not isinstance(profile.get('url'), str)):
            raise ValueError('Invalid profile')
        url = urllib.parse.urlsplit(profile['url'])
        if (url.scheme not in ('http', 'socks5', 'socks5h') or not url.hostname or not url.port or url.username is not None
                or url.password is not None or url.path not in ('', '/') or url.query or url.fragment
                or any(ord(c) <= 32 or ord(c) == 127 for c in profile['url'])):
            raise ValueError('HTTP CONNECT or SOCKS5 proxy required')
        proxy_host(url.hostname)
        if ('username' in profile) != ('password' in profile):
            raise ValueError('Credential pair required')
        for key, size in (('username', 256), ('password', 1024)):
            if key in profile and (not isinstance(profile[key], str) or not profile[key]
                                   or len(profile[key].encode('utf-8')) > (255 if url.scheme in ('socks5', 'socks5h') else size)
                                   or any(ord(c) < 32 or ord(c) == 127 for c in profile[key])):
                raise ValueError('Invalid credential')
        if url.scheme == 'http' and ':' in profile.get('username', ''):
            raise ValueError('Invalid Basic username')
        excluded = profile.get('no_proxy', [])
        if not isinstance(excluded, list) or len(excluded) > 128:
            raise ValueError('Invalid exceptions')
        for value in excluded:
            if not isinstance(value, str) or not value:
                raise ValueError('Invalid exception')
            if '/' in value:
                ipaddress.ip_network(value, strict=True)
            else:
                proxy_host(value[1:] if value.startswith('.') else value)
        if 'ca_file' in profile:
            ca = Path(profile['ca_file'])
            if not ca.is_absolute() or not ca.is_file():
                raise ValueError('CA file required')
            ssl.create_default_context(cafile=str(ca))
        return profile
    except (OSError, ValueError, TypeError):
        raise ValueError('Некорректный профиль прокси: нужен JSON владельца root с правами 0600 и HTTP CONNECT или SOCKS5 адресом с портом.') from None


def download_bypasses_proxy(host, exceptions):
    host = proxy_host(host)
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if host == 'localhost' or (address is not None and address.is_loopback):
        return True
    for value in exceptions:
        if '/' in value:
            if address is not None and address in ipaddress.ip_network(value, strict=True):
                return True
        elif value.startswith('.'):
            suffix = value[1:].lower()
            if host == suffix or host.endswith('.' + suffix):
                return True
        elif host == proxy_host(value):
            return True
    return False


class DownloadProxy(urllib.request.ProxyHandler):
    def __init__(self, profile):
        self.profile = profile
        super().__init__({'https': profile['url']})

    def proxy_open(self, request, proxy, protocol):
        # urllib's default ProxyHandler also consults ambient no_proxy; this
        # operation instead follows only its selected profile and explicit bypasses.
        if download_bypasses_proxy(urllib.parse.urlsplit(request.full_url).hostname,
                                  self.profile.get('no_proxy', [])):
            return None
        if 'username' in self.profile:
            token = base64.b64encode((self.profile['username'] + ':' + self.profile['password']).encode()).decode('ascii')
            request.add_unredirected_header('Proxy-Authorization', 'Basic ' + token)
        request.set_proxy(urllib.parse.urlsplit(proxy).netloc, 'http')
        return None



# The released installer accepts an HTTP profile. A task-local authenticated
# adapter keeps its Docker GPG request on SOCKS without changing host services.
SOCKS_DESTINATIONS = {(name, 443) for name in ('github.com', 'release-assets.githubusercontent.com',
                                             'objects.githubusercontent.com', 'download.docker.com')}


def socks_tunnel(profile, host, port):
    endpoint = urllib.parse.urlsplit(profile['url'])
    raw = socket.create_connection((endpoint.hostname, endpoint.port), timeout=15)
    deadline = time.monotonic() + 15
    def exact(count):
        result = bytearray()
        while len(result) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError('SOCKS handshake timeout')
            raw.settimeout(remaining)
            part = raw.recv(count - len(result))
            if not part: raise ValueError('SOCKS connection closed')
            result.extend(part)
        return bytes(result)
    try:
        method = 2 if 'username' in profile else 0
        raw.sendall(bytes((5, 1, method)))
        if exact(2) != bytes((5, method)):
            raise ValueError('SOCKS authentication refused')
        if method == 2:
            user, password = profile['username'].encode(), profile['password'].encode()
            raw.sendall(bytes((1, len(user))) + user + bytes((len(password),)) + password)
            if exact(2) != b'\x01\x00': raise ValueError('SOCKS authentication refused')
        # Always ATYP=DOMAIN: target DNS is resolved only by the SOCKS server,
        # including for the socks5:// alias (same semantics as socks5h://).
        name = host.encode('idna')
        if not 1 <= len(name) <= 255: raise ValueError('Invalid SOCKS target')
        raw.sendall(b'\x05\x01\x00\x03' + bytes((len(name),)) + name + port.to_bytes(2, 'big'))
        reply = exact(4)
        if reply[:3] != b'\x05\x00\x00' or reply[3] not in (1, 3, 4):
            raise ValueError('SOCKS target refused')
        length = {1: 4, 4: 16}.get(reply[3])
        if length is None:
            length = exact(1)[0]
            if not length: raise ValueError('Invalid SOCKS reply')
        exact(length + 2)
        raw.settimeout(30)
        return raw
    except BaseException:
        raw.close()
        raise


class SocksConnect(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args): pass

    def do_CONNECT(self):
        auth = self.headers.get('Proxy-Authorization', '')
        if not hmac.compare_digest(auth.encode('utf-8'), self.server.authorization):
            self.send_error(407, 'Proxy authentication required')
            return
        target = re.fullmatch(r'([A-Za-z0-9.-]+):([0-9]{1,5})', self.path)
        if target is None or (target[1], int(target[2])) not in SOCKS_DESTINATIONS:
            self.send_error(403, 'Target is not allowed')
            return
        try:
            upstream = socks_tunnel(self.server.profile, target[1], int(target[2]))
        except (OSError, ValueError):
            self.send_error(502, 'SOCKS connection failed')
            return
        with upstream:
            with self.server.peers_lock: self.server.peers.add(upstream)
            try:
                self.send_response(200, 'Connection established')
                self.end_headers(); self.wfile.flush()
                self.connection.settimeout(30)
                deadline = time.monotonic() + 1800
                while not self.server.stopping.is_set() and time.monotonic() < deadline:
                    ready, _, _ = select.select([self.connection, upstream], [], [], 0.2)
                    for source in ready:
                        data = source.recv(64 * 1024)
                        if not data: return
                        (upstream if source is self.connection else self.connection).sendall(data)
            except OSError:
                pass
            finally:
                with self.server.peers_lock: self.server.peers.discard(upstream)


class SocksAdapter(http.server.ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    def handle_error(self, request, address): pass

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(15)
        with self.peers_lock: self.peers.add(connection)
        return connection, address

    def shutdown_request(self, request):
        with self.peers_lock: self.peers.discard(request)
        super().shutdown_request(request)


@contextmanager
def socks_adapter(profile):
    user, password = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
    server = SocksAdapter(('127.0.0.1', 0), SocksConnect, bind_and_activate=False)
    server.peers, server.peers_lock, server.stopping = set(), threading.Lock(), threading.Event()
    server.profile = profile
    server.authorization = ('Basic ' + base64.b64encode((user + ':' + password).encode()).decode()).encode()
    thread = None
    try:
        server.server_bind(); server.server_activate()
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True)
        thread.start()
        yield {**{k: v for k, v in profile.items() if k in ('ca_file', 'no_proxy')},
               'url': 'http://127.0.0.1:' + str(server.server_port), 'username': user, 'password': password}
    finally:
        server.stopping.set()
        if thread:
            server.shutdown(); thread.join(timeout=2)
        with server.peers_lock:
            for peer in server.peers:
                try: peer.shutdown(socket.SHUT_RDWR)
                except OSError: pass
                peer.close()
        server.server_close()


def inline_proxy_profile(url, credentials=None):
    try:
        if any(ord(c) <= 32 or ord(c) == 127 for c in url):
            raise ValueError()
        parsed = urllib.parse.urlsplit(url)
        profile = {'url': url}
        if parsed.username is not None or parsed.password is not None:
            if credentials is not None or parsed.username is None or parsed.password is None:
                raise ValueError()
            profile.update(username=urllib.parse.unquote(parsed.username, errors='strict'),
                           password=urllib.parse.unquote(parsed.password, errors='strict'))
            profile['url'] = parsed._replace(netloc=parsed.netloc.rsplit('@', 1)[1]).geturl()
        elif credentials is not None:
            user, separator, password = credentials.partition(':')
            if not separator: raise ValueError()
            profile.update(username=user, password=password)
        return profile
    except (ValueError, TypeError, UnicodeError):
        raise ValueError('Некорректные параметры прокси. Укажите --proxy URL и один способ авторизации: --proxy-user LOGIN:PASSWORD или userinfo в URL.') from None


def write_proxy_profile(path, value):
    with open(path, 'x', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        json.dump(value, stream)


def build_download_opener(proxy=None):
    context = ssl.create_default_context(cafile=proxy.get('ca_file') if proxy else None)
    context.set_alpn_protocols(['http/1.1'])
    handler = DownloadProxy(proxy) if proxy else urllib.request.ProxyHandler({})
    return urllib.request.build_opener(handler, Redirects(), urllib.request.HTTPSHandler(context=context))


def download(url, target, limit, expected_size=None, expected_hash=None, *, proxy=None):
    check_url(url)
    total, digest = 0, hashlib.sha256()
    opener = build_download_opener(proxy)
    request = urllib.request.Request(url, headers={'User-Agent': 'PL-bootstrap/1'})
    try:
        response = opener.open(request, timeout=60)
    except Exception:
        raise ValueError('HTTPS загрузка не удалась; проверьте доступ и настройки прокси.') from None
    with response, target.open('xb') as out:
        if response.status != 200:
            raise ValueError('Не удалось загрузить поставку')
        while True:
            body = response.read(1024 * 1024)
            if not body:
                break
            total += len(body)
            if total > limit:
                raise ValueError('Превышен размер поставки')
            digest.update(body)
            out.write(body)
    if expected_size is not None and total != expected_size:
        raise ValueError('Размер поставки не совпадает с подписанным каталогом')
    if expected_hash is not None and digest.hexdigest() != expected_hash:
        raise ValueError('Контрольная сумма поставки не совпадает')

def default_url():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
        connection.connect(('1.1.1.1', 443))  # Route lookup; no datagram is sent.
        address = connection.getsockname()[0]
    if ipaddress.ip_address(address).is_loopback:
        raise ValueError('Не удалось определить адрес сервера; укажите --public-url')
    return 'https://' + address

def main(argv=None):
    parser = argparse.ArgumentParser(description='Установка минимального PL из подписанной публичной поставки')
    parser.add_argument('--public-url', help='HTTPS адрес PL; по умолчанию адрес сервера')
    parser.add_argument('--root', default='/opt/pl')
    parser.add_argument('--bind-address', default='0.0.0.0')
    parser.add_argument('--production', action='store_true', help='Случайный первоначальный пароль для новой установки; существующие credentials сохраняются')
    proxy_arguments = parser.add_mutually_exclusive_group()
    proxy_arguments.add_argument('--proxy', help='http://host:port или socks5h://host:port (remote DNS); поддерживается USER:PASSWORD@host')
    proxy_arguments.add_argument('--proxy-file', type=Path, help='Приватный JSON профиль HTTP CONNECT или SOCKS5 прокси, владелец root и права 0600')
    parser.add_argument('--proxy-user', metavar='LOGIN:PASSWORD', help='Логин и пароль прокси для --proxy, как в curl')
    args = parser.parse_args(argv)
    if args.proxy_user is not None and (not args.proxy or args.proxy_file):
        raise ValueError('--proxy-user требует --proxy URL и несовместим с --proxy-file.')
    if os.geteuid() != 0 or platform.system() != 'Linux':
        raise ValueError('Требуется root на Linux')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if arch is None:
        raise ValueError('Поддерживаются amd64 и arm64')
    with tempfile.TemporaryDirectory(prefix='pl-bootstrap-') as name, ExitStack() as stack:
        directory = Path(name)
        proxy_file = args.proxy_file
        if args.proxy:
            proxy_file = directory / 'download-proxy.json'
            write_proxy_profile(proxy_file, inline_proxy_profile(args.proxy, args.proxy_user))
        try:
            proxy = load_download_proxy(proxy_file) if proxy_file else None
        except ValueError:
            if args.proxy:
                raise ValueError('Проверьте адрес, порт, логин и пароль прокси.') from None
            raise
        if proxy and urllib.parse.urlsplit(proxy['url']).scheme in ('socks5', 'socks5h'):
            proxy = stack.enter_context(socks_adapter(proxy))
            proxy_file = directory / 'installer-proxy.json'
            write_proxy_profile(proxy_file, proxy)
        download_options = {'proxy': proxy} if proxy else {}
        if proxy:
            print('Прокси используется для HTTPS загрузок поставки и ключа Docker. apt использует прямой доступ.', flush=True)
        catalog_file = directory / 'catalog.json'
        download(CATALOG, catalog_file, 1024 * 1024, **download_options)
        envelope = json.loads(catalog_file.read_bytes())
        if set(envelope) != {'payload', 'signature'}:
            raise ValueError('Некорректный подписанный каталог')
        payload = base64.b64decode(envelope['payload'], validate=True)
        signature = base64.b64decode(envelope['signature'], validate=True)
        if len(signature) != 64 or len(payload) > 512 * 1024:
            raise ValueError('Некорректная подпись каталога')
        (directory / 'public.pem').write_bytes(PUBLIC_KEY)
        (directory / 'payload.json').write_bytes(payload)
        (directory / 'signature.bin').write_bytes(signature)
        result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(directory / 'public.pem'),
            '-rawin', '-in', str(directory / 'payload.json'), '-sigfile', str(directory / 'signature.bin')], capture_output=True)
        if result.returncode:
            raise ValueError('Подпись каталога не подтверждена')
        catalog = json.loads(payload)
        if catalog.get('schema') != 1 or catalog.get('product') != 'PL' or catalog.get('core_api') != 1:
            raise ValueError('Несовместимый каталог поставки')
        artifact = catalog.get('core', {}).get(arch)
        if not artifact:
            raise ValueError('Для этой архитектуры ещё нет опубликованной поставки')
        if (set(artifact) != {'url', 'sha256', 'size'} or type(artifact['size']) is not int
                or not 0 < artifact['size'] <= MAX_PACKAGE or len(artifact['sha256']) != 64
                or any(c not in '0123456789abcdef' for c in artifact['sha256'])):
            raise ValueError('Некорректная запись поставки')
        print('Загружаем PL ' + catalog['version'] + ' (' + arch + ')', flush=True)
        archive = directory / 'core.tar.gz'
        download(artifact['url'], archive, artifact['size'], artifact['size'], artifact['sha256'], **download_options)
        # Only the verified installer is extracted here. Its existing preflight
        # validates and extracts the complete finite package into the managed root.
        with tarfile.open(archive, 'r:gz') as package:
            members = package.getmembers()
            if (len({m.name for m in members}) != len(members) or len(members) > 64
                    or any(not m.isfile() or '/' in m.name or '\\' in m.name or m.name.startswith('.') for m in members)):
                raise ValueError('Небезопасная структура поставки')
            member = package.getmember('install.sh')
            if member.size > 1024 * 1024:
                raise ValueError('Некорректный установщик')
            install = directory / 'install.sh'
            install.write_bytes(package.extractfile(member).read())
        public_url = args.public_url or default_url()
        command = ['/bin/sh', str(install), '--package', str(archive), '--public-url', public_url,
                   '--root', args.root, '--bind-address', args.bind_address, '--self-signed']
        if args.production:
            command += ['--production']
        if proxy_file:
            command += ['--download-proxy-file', str(proxy_file)]
        subprocess.run(command, check=True)
        if proxy:
            print('Для будущих загрузок GitHub сохраните прокси в настройках доставки PL. Bootstrap профиль не сохраняется.')
        print('PL: ' + public_url + '\nФайл первоначального пароля: '
              + str(Path(args.root) / 'private/initial-admin-password')
              + '\nФайл доступен root. При повторе действующий пароль сохраняется.')
    return 0

try:
    sys.exit(main())
except (ValueError, OSError, KeyError, tarfile.TarError, subprocess.CalledProcessError) as error:
    print('PL: установка не завершена: ' + str(error), file=sys.stderr)
    sys.exit(1)
PL_BOOTSTRAP_PY
