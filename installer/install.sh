#!/bin/sh
# PL host installer. Never formats disks or partitions.
set -eu
if ! command -v python3 >/dev/null 2>&1; then
    # Validate the actual root option before bootstrapping Python on bare hosts.
    # These exact aliases mirror argparse's accepted unique --root abbreviations.
    pl_root=/opt/pl
    pl_root_pending=no
    for pl_argument do
        case "$pl_argument" in
            --i|--i=*|--ic*) echo 'PL: --icmp-allowed-cidr validation requires Python 3.10+ installed beforehand. No host changes applied.' >&2; exit 1 ;;
        esac
        if [ "$pl_root_pending" = yes ]; then
            pl_root=$pl_argument
            pl_root_pending=no
            continue
        fi
        case "$pl_argument" in
            --) break ;;
            --r|--ro|--roo|--root) pl_root_pending=yes ;;
            --r=*|--ro=*|--roo=*|--root=*) pl_root=${pl_argument#*=} ;;
        esac
    done
    [ "$pl_root_pending" = no ] || { echo 'PL: --root requires a directory.' >&2; exit 1; }
    while [ "$pl_root" != / ] && [ "${pl_root%/}" != "$pl_root" ]; do pl_root=${pl_root%/}; done
    pl_socket_bytes=$(LC_ALL=C printf %s "$pl_root/run/module-controller/control.sock" | LC_ALL=C wc -c)
    [ "$pl_socket_bytes" -le 107 ] || {
        echo 'PL: installation root is too long for Linux Unix sockets (limit 107 bytes). Choose a shorter --root, for example /opt/pl.' >&2
        exit 1
    }
    case " $* " in
        *' --download-proxy-file '*|*' --download-proxy-file='*) echo 'PL: proxy downloads require Python 3.10+ installed beforehand. No host changes applied.' >&2; exit 1 ;;
    esac
    case " $* " in
        *' --integration-config '*|*' --integration-config='*) echo 'PL: --integration-config validation requires Python 3.10+ installed beforehand. No host changes applied.' >&2; exit 1 ;;
        *' --network-cidr '*|*' --network-cidr='*|*' --module-network-cidr '*|*' --module-network-cidr='*) echo 'PL: --network-cidr validation requires python3; install it before retrying. No host changes applied.' >&2; exit 1 ;;
    esac
    case " $* " in
        *' --help '*|*' -h '*) echo 'Usage: install.sh --check | --package PATH --public-url HTTPS_URL | --package-url HTTPS_URL --package-sha256 SHA256 --public-url HTTPS_URL'; exit 0 ;;
        *' --check '*) echo 'PL: Python 3.10+ is missing; --check makes no changes.' >&2; exit 1 ;;
    esac
    [ "$(id -u)" = 0 ] || { echo 'PL: run as root (sudo).' >&2; exit 1; }
    [ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}" ] || { echo 'PL: unset Docker endpoint overrides.' >&2; exit 1; }
    [ -f /etc/os-release ] || { echo 'PL: unsupported OS.' >&2; exit 1; }
    . /etc/os-release
    case "${ID:-}:${VERSION_CODENAME:-}" in
        ubuntu:jammy|ubuntu:noble|ubuntu:resolute|ubuntu:stonking|debian:bookworm|debian:trixie) ;;
        *) echo 'PL: unsupported OS.' >&2; exit 1 ;;
    esac
    # Only minimal language runtime bootstrap occurs before full Python preflight.
    apt-get update >/dev/null 2>&1 || { echo 'PL: apt update failed.' >&2; exit 1; }
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 ca-certificates >/dev/null 2>&1 || { echo 'PL: Python bootstrap failed.' >&2; exit 1; }
fi
exec python3 - "$@" <<'PL_INSTALL_PY'
import argparse
import base64
import hashlib
import grp
import json
import ipaddress
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

OS_RELEASE = Path('/etc/os-release')
MEMINFO = Path('/proc/meminfo')
APT_SOURCES = Path('/etc/apt/sources.list.d/pl-docker.sources')
APT_KEY = Path('/etc/apt/keyrings/pl-docker.asc')
MAX_PACKAGE = 8 * 1024**3
MIN_DISK = 20 * 1024**3
MIN_MEMORY_KIB = 4 * 1024**2
ALLOWED = {'bootstrap.py', 'manifest.json', 'images.tar', 'nginx.conf', 'LICENSES.txt', 'README.md', 'source.tar.gz', 'maintenance.py', 'module-controller.py', 'xray-controller.py', 'alertmanager-controller.py', 'wayline-controller.py', 'grafana-controller.py', 'forms-controller.py', 'doska-controller.py', 'sftpgo-controller.py', 'module-network.py', 'netmap-controller.py', 'bookstack-controller.py', 'controller-supervisor.py', 'installation-settings.py', 'module-origin.py', 'icmp-probe.py', 'icmp-install.py', 'install.sh', 'delivery.py', 'delivery-proxy.py', 'release-signing-public.pem'}
REQUIRED = ALLOWED - {'README.md', 'source.tar.gz', 'maintenance.py', 'module-controller.py', 'xray-controller.py', 'alertmanager-controller.py', 'wayline-controller.py', 'grafana-controller.py', 'forms-controller.py', 'doska-controller.py', 'sftpgo-controller.py', 'module-network.py', 'netmap-controller.py', 'bookstack-controller.py', 'controller-supervisor.py', 'installation-settings.py', 'module-origin.py', 'icmp-probe.py', 'icmp-install.py', 'install.sh', 'delivery.py', 'delivery-proxy.py', 'release-signing-public.pem'}
DOCKER_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88'


class InstallError(Exception):
    pass


def fail(message):
    raise InstallError(message)


# Keep in sync with bootstrap.py: operations use the module controller socket.
ROOT_SOCKET_PATHS = ('run/module-controller/control.sock', 'run/icmp-probe/probe.sock')
UNIX_SOCKET_PATH_LIMIT = 107


def validate_root_socket_paths(root):
    for relative in ROOT_SOCKET_PATHS:
        length = len(os.fsencode(root / relative))
        if length > UNIX_SOCKET_PATH_LIMIT:
            fail('Installation root is too long for Linux Unix sockets (' + str(length)
                 + ' bytes; limit 107). Choose a shorter --root, for example /opt/pl.')


def run(args, capture=True):
    environment = dict(os.environ, DEBIAN_FRONTEND='noninteractive')
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None, check=False, env=environment,
                            stdin=subprocess.DEVNULL if capture else None)
    if result.returncode:
        # Tool output may contain repository credentials, passwords or expanded config.
        fail(f'Command failed ({result.returncode}): {Path(args[0]).name}')
    return result.stdout.strip() if capture else ''


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def check_https(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        fail('Download URL must use HTTPS without credentials or fragment.')


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_https(newurl)
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
        if (url.scheme != 'http' or not url.hostname or not url.port or url.username is not None
                or url.password is not None or url.path not in ('', '/') or url.query or url.fragment
                or any(ord(c) <= 32 or ord(c) == 127 for c in profile['url'])):
            raise ValueError('HTTP CONNECT proxy required')
        proxy_host(url.hostname)
        if ('username' in profile) != ('password' in profile):
            raise ValueError('Credential pair required')
        for key, size in (('username', 256), ('password', 1024)):
            if key in profile and (not isinstance(profile[key], str) or not profile[key]
                                   or len(profile[key]) > size
                                   or any(ord(c) < 32 or ord(c) == 127 for c in profile[key])):
                raise ValueError('Invalid credential')
        if ':' in profile.get('username', ''):
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
        fail('Invalid download proxy file; use a private owner-only 0600 JSON profile with an HTTP proxy and explicit port.')


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


def build_download_opener(proxy=None):
    context = ssl.create_default_context(cafile=proxy.get('ca_file') if proxy else None)
    context.set_alpn_protocols(['http/1.1'])
    handler = DownloadProxy(proxy) if proxy else urllib.request.ProxyHandler({})
    return urllib.request.build_opener(handler, HTTPSRedirect(), urllib.request.HTTPSHandler(context=context))


def download(url, destination, limit=MAX_PACKAGE, proxy=None):
    check_https(url)
    try:
        opener = build_download_opener(proxy)
        with opener.open(url, timeout=60) as source, destination.open('xb') as target:
            count = 0
            while chunk := source.read(1024 * 1024):
                count += len(chunk)
                if count > limit:
                    fail('Download exceeds the size limit.')
                target.write(chunk)
    except InstallError:
        raise
    except Exception:
        fail('HTTPS download failed; verify connectivity and the URL.')


def preflight(root):
    if sys.version_info < (3, 10):
        fail('Python 3.10+ is required.')
    if os.geteuid() != 0:
        fail('Run as root (sudo).')
    if platform.system() != 'Linux':
        fail('Only Linux is supported.')
    if os.environ.get('DOCKER_HOST') or os.environ.get('DOCKER_CONTEXT') or os.environ.get('DOCKER_TLS_VERIFY'):
        fail('Unset DOCKER_HOST, DOCKER_CONTEXT and DOCKER_TLS_VERIFY; only the local daemon is supported.')
    values = {}
    for line in OS_RELEASE.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            values[key] = value.strip('"\'')
    distro, codename = values.get('ID'), values.get('VERSION_CODENAME')
    supported = {'ubuntu': {'jammy', 'noble', 'resolute', 'stonking'},
                 'debian': {'bookworm', 'trixie'}}
    if distro not in supported or codename not in supported[distro]:
        fail('Supported hosts: Ubuntu 22.04/24.04/26.04/26.10, Debian 12/13.')
    arch = run(['dpkg', '--print-architecture'])
    if arch not in {'amd64', 'arm64'}:
        fail('Only amd64 and arm64 are supported.')
    memory = re.search(r'^MemTotal:\s+(\d+)\s+kB$', MEMINFO.read_text(), re.M)
    if not memory or int(memory[1]) < MIN_MEMORY_KIB:
        fail('At least 4 GiB of usable RAM is required.')
    ancestor = root
    while not ancestor.exists():
        ancestor = ancestor.parent
    if shutil.disk_usage(ancestor).free < MIN_DISK:
        fail('At least 20 GiB of free disk space is required.')
    if any(part.is_symlink() for part in [root, *root.parents]):
        fail('Installation path must not contain symlinks.')
    marker = root / '.pl-installation.json'
    if marker.is_symlink() or (root / 'releases').is_symlink():
        fail('Managed installation paths must not be symlinks.')
    if root.exists() and (not root.is_dir() or (any(root.iterdir()) and not marker.is_file())):
        fail('Existing non-empty installation root is not managed by PL.')
    docker = shutil.which('docker')
    if docker:
        context = run(['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])
        try:
            endpoint = json.loads(context)
        except ValueError:
            fail('Cannot inspect Docker context.')
        if endpoint != 'unix:///var/run/docker.sock':
            fail('Docker context must use unix:///var/run/docker.sock.')
        info = json.loads(run(['docker', 'version', '--format', '{{json .Server}}']))
        version = info.get('Version', '')
        if not re.match(r'^29\.', version) or info.get('Os') != 'linux' or info.get('Arch') != arch:
            fail('Existing Docker must be Linux Engine 29.x on the host architecture; upgrade it explicitly first.')
        compose = run(['docker', 'compose', 'version', '--short']).lstrip('v')
        match = re.match(r'^(\d+)\.(\d+)', compose)
        if not match or not ((int(match[1]) == 2 and int(match[2]) >= 24) or int(match[1]) == 5):
            fail('Existing Docker Compose plugin must be 2.24+ (2.x) or 5.x.')
    else:
        # Do not replace distribution/container runtimes or repair incomplete installs.
        for package in ('docker.io', 'docker-ce', 'docker-ce-cli', 'docker-compose', 'docker-compose-v2',
                        'podman-docker', 'containerd', 'containerd.io', 'runc'):
            status = subprocess.run(['dpkg-query', '-W', '-f=${db:Status-Status}', package],
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if status.returncode == 0 and status.stdout.strip() == 'installed':
                fail('Conflicting or incomplete container runtime exists; resolve it explicitly first.')
        for source in [Path('/etc/apt/sources.list'), *Path('/etc/apt/sources.list.d').glob('*.list'),
                       *Path('/etc/apt/sources.list.d').glob('*.sources')]:
            if source != APT_SOURCES and source.is_file() and 'download.docker.com' in source.read_text():
                fail('An existing Docker apt repository is configured; install Docker explicitly or resolve the repository first.')
    return {'distribution': distro, 'codename': codename, 'architecture': arch, 'docker_present': bool(docker)}


def verify_package(package, arch):
    if package.stat().st_size > MAX_PACKAGE:
        fail('Package exceeds the size limit.')
    try:
        with tarfile.open(package, 'r:*') as archive:
            members = []
            for member in archive:
                members.append(member)
                if len(members) > len(ALLOWED):
                    fail('Too many package members.')
            names = [entry.name for entry in members]
            if len(names) != len(set(names)) or not REQUIRED <= set(names) or not set(names) <= ALLOWED:
                fail('Package must contain unique allowlisted flat files.')
            if any(not entry.isfile() or entry.size < 0 for entry in members):
                fail('Package links, directories and special files are forbidden.')
            if sum(entry.size for entry in members) > MAX_PACKAGE:
                fail('Expanded package exceeds the size limit.')
            manifest_member = archive.getmember('manifest.json')
            if manifest_member.size > 1024 * 1024:
                fail('Manifest is too large.')
            manifest = json.load(archive.extractfile(manifest_member))
            version = manifest.get('version', '')
            if not isinstance(version, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}', version):
                fail('Invalid release version.')
            if manifest.get('schema') not in (1, 2) or manifest.get('product') not in ('PL', 'Pl') or manifest.get('architecture') != arch:
                fail('Package schema, product or architecture mismatch.')
            features = manifest.get('features', {})
            if not isinstance(features, dict) or set(features) - {'local_users', 'module_controller', 'xray_module', 'alertmanager_module', 'wayline_module', 'grafana_module', 'forms_module', 'doska_module', 'sftpgo_module', 'netmap_module', 'bookstack_module', 'connector_credentials', 'icmp_probe', 'on_demand_modules'} or any(type(value) is not bool for value in features.values()):
                fail('Unsupported core package features.')
            if features.get('on_demand_modules'):
                payloads = {'install.sh', 'delivery.py', 'delivery-proxy.py', 'release-signing-public.pem', 'module-controller.py', 'module-network.py', 'xray-controller.py', 'alertmanager-controller.py', 'wayline-controller.py', 'grafana-controller.py', 'forms-controller.py', 'doska-controller.py', 'sftpgo-controller.py', 'netmap-controller.py', 'bookstack-controller.py', 'controller-supervisor.py', 'installation-settings.py', 'module-origin.py'}
                if (manifest.get('schema') != 2 or not features.get('module_controller')
                        or not payloads <= set(names) or set(manifest.get('images', {})) != {'api', 'web', 'db'}
                        or any(features.get(name + '_module') for name in ('xray', 'alertmanager', 'wayline', 'grafana', 'forms', 'doska', 'sftpgo', 'netmap', 'bookstack'))):
                    fail('On-demand core requires its finite delivery controllers without bundled module images.')
            if features.get('connector_credentials') and manifest.get('schema') != 2:
                fail('Connector credentials require a schema-2 package.')
            if features.get('icmp_probe') and (manifest.get('schema') != 2 or not {'icmp-probe.py', 'icmp-install.py'} <= set(names)):
                fail('ICMP feature requires its trusted host helper payload.')
            if features.get('module_controller') and 'module-controller.py' not in names:
                fail('Module controller feature requires its trusted payload.')
            if features.get('xray_module') and (manifest.get('schema') != 2 or not features.get('module_controller') or 'xray-controller.py' not in names):
                fail('Xray feature requires module controller and payload.')
            if features.get('alertmanager_module') and (manifest.get('schema') != 2 or not features.get('module_controller')
                    or not {'alertmanager-controller.py', 'xray-controller.py'} <= set(names)):
                fail('Alertmanager feature requires its controller and trusted file primitives.')
            if features.get('grafana_module') and (manifest.get('schema') != 2 or not features.get('module_controller')
                    or not {'grafana-controller.py', 'xray-controller.py'} <= set(names)):
                raise ValueError('Grafana module payload missing')
            if features.get('wayline_module') and (manifest.get('schema') != 2 or not features.get('module_controller')
                    or not {'wayline-controller.py', 'xray-controller.py'} <= set(names)):
                fail('Wayline feature requires its controller and trusted file primitives.')
            for module in ('forms', 'doska', 'sftpgo', 'netmap', 'bookstack'):
                if features.get(module + '_module') and (manifest.get('schema') != 2 or not features.get('module_controller')
                        or not {module + '-controller.py', 'xray-controller.py'} <= set(names)):
                    fail('Application feature requires its controller and trusted file primitives.')
            if (features.get('netmap_module') or features.get('bookstack_module')) and 'module-network.py' not in names:
                fail('Network stack and Wiki require the trusted module network allocator.')
            files = manifest.get('files')
            if not isinstance(files, dict) or set(files) != set(names) - {'manifest.json'}:
                fail('Manifest must hash every package file.')
            for name, expected in files.items():
                if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected):
                    fail('Invalid file checksum in manifest.')
                sha = hashlib.sha256()
                with archive.extractfile(name) as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        sha.update(chunk)
                if sha.hexdigest() != expected:
                    fail(f'Package file checksum mismatch: {name}')
            return manifest
    except InstallError:
        raise
    except (tarfile.TarError, ValueError, OSError, TypeError, AttributeError):
        fail('Invalid package archive or manifest.')


def validate_account(record, account):
    if record.get('product') not in ('PL', 'Pl') or record.get('uid') != account.pw_uid or record.get('gid') != account.pw_gid:
        fail('PL service account does not match installation metadata.')
    if account.pw_shell not in ('/usr/sbin/nologin', '/sbin/nologin'):
        fail('PL service account must use nologin.')
    forbidden = {'sudo', 'wheel', 'docker'}
    if any(group.gr_name in forbidden and ('pl' in group.gr_mem or group.gr_gid == account.pw_gid)
           for group in grp.getgrall()):
        fail('PL service account must not have sudo or Docker privileges.')


def shared_account(source):
    if not source.is_absolute() or source == Path('/') or source != source.resolve():
        fail('Service account source must be a real managed installation directory.')
    for path in (source, source / '.pl-installation.json', source / 'state', source / 'state/installation.json'):
        if path.is_symlink() or path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o022:
            fail('Service account source must be owned and protected by root.')
    state = json.loads((source / 'state/installation.json').read_text())
    if state.get('product') not in ('PL', 'Pl') or state.get('phase') != 'ready' or not re.fullmatch(r'pl-[0-9a-f]{12}', state.get('install_id', '')):
        fail('Service account source is not a ready PL installation.')
    record = json.loads((source / '.pl-installation.json').read_text())
    account = pwd.getpwnam('pl')
    validate_account(record, account)
    return account


def prepare_root(root, reuse_from=None):
    marker = root / '.pl-installation.json'
    if marker.exists():
        record = json.loads(marker.read_text())
        account = pwd.getpwnam('pl')
        validate_account(record, account)
    else:
        if reuse_from is not None:
            account = shared_account(reuse_from)
            if root == reuse_from or root.is_relative_to(reuse_from) or reuse_from.is_relative_to(root):
                fail('Installations must use separate non-nested roots.')
        else:
            try:
                pwd.getpwnam('pl')
            except KeyError:
                pass
            else:
                fail('User pl already exists; use --service-account-from with a verified PL installation, or choose a clean host.')
        root.mkdir(mode=0o750, parents=True, exist_ok=True)
        if reuse_from is None:
            run(['useradd', '--system', '--user-group', '--home-dir', str(root / 'state'),
                 '--no-create-home', '--shell', '/usr/sbin/nologin', 'pl'])
        account = pwd.getpwnam('pl')
        marker.write_text(json.dumps({'product': 'Pl', 'uid': account.pw_uid, 'gid': account.pw_gid}) + '\n')
        marker.chmod(0o600)
    (root / 'releases').mkdir(mode=0o750, exist_ok=True)


def pin_packages(packages):
    selected = []
    for package in packages:
        policy = run(['apt-cache', 'policy', package])
        candidate = re.search(r'^\s*Candidate:\s+(\S+)', policy, re.M)
        if not candidate or candidate[1] == '(none)':
            fail(f'No apt candidate for {package}.')
        selected.append(f'{package}={candidate[1]}')
    return selected


def record_packages(root, packages):
    path = root / 'host-packages.json'
    current = json.loads(path.read_text()) if path.exists() else {'packages': []}
    selected = {spec.split('=', 1)[0]: spec for spec in current.get('packages', [])}
    selected.update({spec.split('=', 1)[0]: spec for spec in packages})
    current['packages'] = list(selected.values())
    path.write_text(json.dumps(current, indent=2) + '\n')


def ensure_openssl(root):
    if shutil.which('openssl'):
        return
    run(['apt-get', 'update'])
    packages = pin_packages(['openssl'])
    record_packages(root, packages)
    run(['apt-get', 'install', '-y', '--no-install-recommends', *packages])
    if not shutil.which('openssl'):
        fail('OpenSSL CLI is still unavailable after apt installation.')


def ensure_icmp_dependencies(root, manifest):
    if not manifest.get('features', {}).get('icmp_probe'):
        return
    binary = Path('/usr/sbin/hping3')
    if not binary.is_file():
        run(['apt-get', 'update'])
        packages = pin_packages(['hping3'])
        record_packages(root, packages)
        run(['apt-get', 'install', '-y', '--no-install-recommends', *packages])
    info = binary.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o6022 or not info.st_mode & 0o111:
        fail('ICMP requires a root-owned hping3 binary without unsafe permissions.')


def install_docker(info, root, download_proxy=None):
    if info['docker_present']:
        return
    run(['apt-get', 'update'])
    prerequisites = pin_packages(['ca-certificates', 'curl', 'gnupg'])
    run(['apt-get', 'install', '-y', '--no-install-recommends', *prerequisites])
    APT_KEY.parent.mkdir(mode=0o755, exist_ok=True)
    source = ('Types: deb\nURIs: https://download.docker.com/linux/' + info['distribution'] +
              '\nSuites: ' + info['codename'] + '\nComponents: stable\nArchitectures: ' +
              info['architecture'] + '\nSigned-By: ' + str(APT_KEY) + '\n')
    if APT_SOURCES.exists() and APT_SOURCES.read_text() != source:
        fail('Existing PL Docker apt source differs; refusing to overwrite it.')
    with tempfile.TemporaryDirectory(prefix='pl-docker-key-') as directory:
        key = Path(directory) / 'docker.asc'
        key_url = 'https://download.docker.com/linux/' + info['distribution'] + '/gpg'
        if download_proxy is None:
            download(key_url, key, 1024 * 1024)
        else:
            download(key_url, key, 1024 * 1024, proxy=download_proxy)
        keys = run(['gpg', '--batch', '--no-options', '--homedir', directory,
                    '--show-keys', '--with-colons', str(key)])
        fingerprints = [line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:')]
        if not fingerprints or fingerprints[0] != DOCKER_FINGERPRINT:
            fail('Docker signing key fingerprint mismatch.')
        if APT_KEY.exists() and APT_KEY.read_bytes() != key.read_bytes():
            fail('Existing PL Docker signing key differs; refusing to overwrite it.')
        shutil.copyfile(key, APT_KEY)
        APT_KEY.chmod(0o644)
    APT_SOURCES.write_text(source)
    APT_SOURCES.chmod(0o644)
    run(['apt-get', 'update'])
    packages = pin_packages(['docker-ce', 'docker-ce-cli', 'containerd.io',
                             'docker-buildx-plugin', 'docker-compose-plugin'])
    if not re.match(r'docker-ce=(?:\d+:)?29\.', packages[0]):
        fail('Docker repository candidate is outside supported Engine 29.x.')
    record_packages(root, prerequisites + packages)
    run(['apt-get', 'install', '-y', '--no-install-recommends', *packages])
    run(['systemctl', 'enable', '--now', 'docker'])
    # Verify daemon, architecture and Compose after installing, before any payload starts.
    info.update(preflight(root))


def stage_release(package, root, manifest, package_hash):
    destination = root / 'releases' / manifest['version']
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            fail('Release path is not a directory.')
        marker = destination / '.package-sha256'
        if not marker.is_file() or marker.read_text().strip() != package_hash:
            fail('Release version exists with a different package; refusing overwrite.')
        for name, expected in manifest['files'].items():
            path = destination / name
            if path.is_symlink() or not path.is_file() or digest(path) != expected:
                fail('Existing release files differ; refusing reuse.')
        if digest(destination / 'manifest.json') != digest_manifest(package):
            fail('Existing release manifest differs; refusing reuse.')
        return destination
    with tempfile.TemporaryDirectory(prefix='.stage-', dir=root / 'releases') as temporary:
        staged = Path(temporary) / 'payload'
        staged.mkdir(mode=0o750)
        with tarfile.open(package, 'r:*') as archive:
            # Explicit writes, never tar.extract / extractall, regardless of Python version.
            for member in archive.getmembers():
                with archive.extractfile(member) as source, (staged / member.name).open('xb') as target:
                    shutil.copyfileobj(source, target)
                (staged / member.name).chmod(0o600)
        (staged / '.package-sha256').write_text(package_hash + '\n')
        staged.rename(destination)
    return destination


def digest_manifest(package):
    with tarfile.open(package, 'r:*') as archive:
        return hashlib.sha256(archive.extractfile('manifest.json').read()).hexdigest()


def integration_preflight(archive, profile):
    # The outer archive and every file hash are already verified. Use the same
    # package validator before host mutation, without loading any container.
    try:
        with tarfile.open(archive, 'r:*') as package:
            stream = package.extractfile('bootstrap.py')
            if stream is None:
                raise ValueError
            with stream:
                source = stream.read(2 * 1024**2 + 1)
            if len(source) > 2 * 1024**2:
                raise ValueError
        namespace = {'__name__': 'pl_integration_preflight', '__file__': str(archive.parent / 'bootstrap.py')}
        exec(compile(source, namespace['__file__'], 'exec'), namespace)
        loader = namespace.get('load_integration_config')
        if not callable(loader):
            fail('Selected package does not support --integration-config.')
        loader(profile)
    except InstallError:
        raise
    except (OSError, ValueError, TypeError, KeyError, SyntaxError):
        fail('Integration configuration requires private regular files and bounded explicit values.')


def main(argv=None):
    parser = argparse.ArgumentParser(description='PL online Linux host installer (no disk formatting).')
    parser.add_argument('--check', action='store_true', help='Read-only host preflight; no package is needed.')
    parser.add_argument('--root', default='/opt/pl')
    parser.add_argument('--service-account-from', type=Path, help='Reuse the nologin OS account from a verified ready PL installation; data remains isolated.')
    package = parser.add_mutually_exclusive_group()
    package.add_argument('--package', type=Path)
    package.add_argument('--package-url')
    parser.add_argument('--package-sha256')
    parser.add_argument('--download-proxy-file', type=Path,
                        help='Private 0600 JSON HTTP CONNECT proxy for HTTPS bundle/key downloads only; apt and Docker daemon settings remain separate.')
    parser.add_argument('--public-url')
    parser.add_argument('--bind-address')
    parser.add_argument('--module-network-cidr', help='Additional RFC1918 /16 through /26; default module pool holds 8 networks; initial installation only.')
    parser.add_argument('--network-cidr', help='Explicit unused canonical RFC1918 IPv4 /24 for core bridges.')
    parser.add_argument('--integration-config', type=Path, help='Private 0600 JSON of explicit integration CIDRs, ports and secret files; first installation only; requires --network-cidr.')
    parser.add_argument('--icmp-allowed-cidr', action='append', help='Explicit canonical IPv4 CIDR for manual ICMP; repeat for several networks, empty denies all.')
    parser.add_argument('--admin-user')
    parser.add_argument('--tls-cert')
    parser.add_argument('--tls-key')
    parser.add_argument('--self-signed', action='store_true')
    parser.add_argument('--password-file', type=Path, help='Private initial password file; content is never logged.')
    args = parser.parse_args(argv)
    if args.network_cidr is not None:
        try:
            selected = ipaddress.IPv4Network(args.network_cidr, strict=True)
        except (ValueError, TypeError):
            fail('--network-cidr must be a canonical RFC1918 IPv4 /24.')
        private = (ipaddress.IPv4Network('10.0.0.0/8'), ipaddress.IPv4Network('172.16.0.0/12'), ipaddress.IPv4Network('192.168.0.0/16'))
        if (selected.prefixlen != 24 or str(selected) != args.network_cidr
                or not any(selected.subnet_of(block) for block in private)):
            fail('--network-cidr must be a canonical RFC1918 IPv4 /24.')
    if args.module_network_cidr is not None:
        try:
            additional = ipaddress.IPv4Network(args.module_network_cidr, strict=True)
        except (ValueError, TypeError):
            fail('--module-network-cidr must be a canonical RFC1918 /16 through /26.')
        private = (ipaddress.IPv4Network('10.0.0.0/8'), ipaddress.IPv4Network('172.16.0.0/12'), ipaddress.IPv4Network('192.168.0.0/16'))
        if (str(additional) != args.module_network_cidr or not 16 <= additional.prefixlen <= 26
                or not any(additional.subnet_of(block) for block in private)
                or args.network_cidr and additional.overlaps(ipaddress.IPv4Network(args.network_cidr))):
            fail('--module-network-cidr must be private, canonical and disjoint from core networks.')
    if args.icmp_allowed_cidr is not None:
        if len(args.icmp_allowed_cidr) > 64:
            fail('ICMP accepts at most 64 explicit IPv4 CIDRs.')
        for value in args.icmp_allowed_cidr:
            try:
                selected = ipaddress.IPv4Network(value, strict=True)
            except (ValueError, TypeError):
                fail('ICMP requires canonical IPv4 CIDRs.')
            if str(selected) != value:
                fail('ICMP requires canonical IPv4 CIDRs.')
    if args.integration_config is not None and args.network_cidr is None:
        fail('--integration-config requires --network-cidr for isolated egress IPAM.')
    root = Path(args.root)
    if not root.is_absolute() or root == Path('/') or '..' in root.parts:
        fail('Installation root must be an absolute, dedicated directory.')
    validate_root_socket_paths(root)
    if args.package_sha256 and not re.fullmatch('[0-9a-fA-F]{64}', args.package_sha256):
        fail('--package-sha256 must contain 64 hexadecimal characters.')
    if args.package_url:
        check_https(args.package_url)
        if not args.package_sha256:
            fail('Network packages require --package-sha256 from a trusted release source.')
    if not args.check and (not (args.package or args.package_url) or not args.public_url):
        fail('Installation requires a package and --public-url.')
    if args.public_url:
        public = urllib.parse.urlsplit(args.public_url)
        if public.scheme != 'https' or not public.hostname or public.username or public.password or public.query or public.fragment or public.path not in ('', '/'):
            fail('--public-url must be an HTTPS origin without credentials, path, query or fragment.')
    if bool(args.tls_cert) != bool(args.tls_key) or (args.self_signed and args.tls_cert):
        fail('Use either --tls-cert with --tls-key or --self-signed.')
    if not args.check and not (args.self_signed or args.tls_cert):
        fail('Installation requires --self-signed or --tls-cert with --tls-key.')
    download_proxy = load_download_proxy(args.download_proxy_file) if args.download_proxy_file else None
    info = preflight(root)
    print('PL preflight OK: ' + info['distribution'] + '/' + info['codename'] + ' ' + info['architecture'])
    if args.check:
        if not shutil.which('openssl'):
            fail('OpenSSL CLI is missing; installation will install it through apt.')
        return
    with tempfile.TemporaryDirectory(prefix='pl-install-') as temporary:
        private = Path(temporary)
        archive = private / 'package.tar'
        if args.package_url:
            download(args.package_url, archive, proxy=download_proxy)
        else:
            # Make a private stable copy before hashing and extraction (no source-file race).
            if not args.package.is_file() or args.package.stat().st_size > MAX_PACKAGE:
                fail('Local package is missing or too large.')
            with args.package.open('rb') as source, archive.open('xb') as target:
                shutil.copyfileobj(source, target)
        package_hash = digest(archive)
        if args.package_sha256 and package_hash != args.package_sha256.lower():
            fail('Package SHA-256 mismatch; no host changes were applied.')
        manifest = verify_package(archive, info['architecture'])
        if args.icmp_allowed_cidr is not None and not manifest.get('features', {}).get('icmp_probe'):
            fail('Selected package does not include the ICMP helper; no host changes were applied.')
        if manifest.get('features', {}).get('connector_credentials') and not manifest.get('features', {}).get('on_demand_modules') and args.network_cidr is None:
            fail('Connector credentials require --network-cidr for isolated egress IPAM; no host changes were applied.')
        if args.integration_config is not None:
            integration_preflight(archive, args.integration_config)
        if args.service_account_from is not None:
            prepare_root(root, args.service_account_from)
        else:
            prepare_root(root)
        release = stage_release(archive, root, manifest, package_hash)
        if download_proxy is None:
            install_docker(info, root)
        else:
            install_docker(info, root, download_proxy=download_proxy)
        ensure_openssl(root)
        ensure_icmp_dependencies(root, manifest)
        command = [sys.executable, str(release / 'bootstrap.py'), 'install', '--root', str(root),
                   '--package-dir', str(release), '--public-url', args.public_url]
        for option in ('bind_address', 'admin_user', 'tls_cert', 'tls_key', 'password_file', 'network_cidr', 'module_network_cidr', 'integration_config'):
            value = getattr(args, option)
            if value is not None:
                command += ['--' + option.replace('_', '-'), str(value)]
        for value in args.icmp_allowed_cidr or []:
            command += ['--icmp-allowed-cidr', value]
        if args.self_signed:
            command += ['--self-signed']
        # Bootstrap owns interactive secret input and sanitised output.
        run(command, capture=False)
        print('PL installation finished.')


if __name__ == '__main__':
    try:
        main()
    except (InstallError, OSError, KeyError, ValueError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, InstallError) else 'Host operation failed; inspect host state before retrying.'
        print('PL: ' + message, file=sys.stderr)
        sys.exit(1)
PL_INSTALL_PY
