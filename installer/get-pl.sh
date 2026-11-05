#!/bin/sh
# PL bootstrap. The release catalog and complete payload are verified before execution.
set -eu
[ "$(id -u)" = 0 ] || { echo 'PL: запустите установку через sudo.' >&2; exit 1; }
if ! command -v python3 >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    [ -f /etc/os-release ] || { echo 'PL: требуется Ubuntu или Debian.' >&2; exit 1; }
    . /etc/os-release
    case "${ID:-}" in ubuntu|debian) ;; *) echo 'PL: требуется Ubuntu или Debian.' >&2; exit 1;; esac
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 openssl ca-certificates
fi
exec python3 - "$@" <<'PL_BOOTSTRAP_PY'
import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import tarfile
import tempfile
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

def download(url, target, limit, expected_size=None, expected_hash=None):
    check_url(url)
    total, digest = 0, hashlib.sha256()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects())
    request = urllib.request.Request(url, headers={'User-Agent': 'PL-bootstrap/1'})
    with opener.open(request, timeout=60) as response, target.open('xb') as out:
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

def main():
    parser = argparse.ArgumentParser(description='Установка минимального PL из подписанной публичной поставки')
    parser.add_argument('--public-url', help='HTTPS адрес PL; по умолчанию адрес сервера')
    parser.add_argument('--root', default='/opt/pl')
    parser.add_argument('--bind-address', default='0.0.0.0')
    args = parser.parse_args()
    if os.geteuid() != 0 or platform.system() != 'Linux':
        raise ValueError('Требуется root на Linux')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if arch is None:
        raise ValueError('Поддерживаются amd64 и arm64')
    with tempfile.TemporaryDirectory(prefix='pl-bootstrap-') as name:
        directory = Path(name)
        catalog_file = directory / 'catalog.json'
        download(CATALOG, catalog_file, 1024 * 1024)
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
        download(artifact['url'], archive, artifact['size'], artifact['size'], artifact['sha256'])
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
        subprocess.run(['/bin/sh', str(install), '--package', str(archive), '--public-url', public_url,
            '--root', args.root, '--bind-address', args.bind_address, '--self-signed'], check=True)
        print('PL: ' + public_url + '\nПервый вход: admin / admin. Измените пароль в интерфейсе PL.')
    return 0

try:
    sys.exit(main())
except (ValueError, OSError, KeyError, tarfile.TarError, subprocess.CalledProcessError) as error:
    print('PL: установка не завершена: ' + str(error), file=sys.stderr)
    sys.exit(1)
PL_BOOTSTRAP_PY
