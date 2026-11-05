#!/usr/bin/env python3
"""Signed release delivery for the finite PL installation controller (protocol 1)."""
from __future__ import annotations

import base64
from contextlib import contextmanager, ExitStack
import copy
import hmac
import fcntl
import hashlib
import http.client
import ipaddress
import importlib.util
import json
import logging
import os
from pathlib import Path
import platform
import re
import shutil
import ssl
import socket
import stat
import subprocess
import tarfile
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid

CATALOG_URL = 'https://github.com/Sauke5/pl/releases/download/channel-stable/catalog.json'
MODULES = {'prometheus', 'xray', 'alertmanager', 'wayline', 'grafana', 'forms', 'doska', 'sftpgo', 'netmap', 'bookstack'}
ROLES = {'wayline': ('api', 'gateway', 'runner'), 'forms': ('adapter', 'engine', 'mongo', 'keydb'),
         'doska': ('api', 'web'), 'sftpgo': ('server',), 'netmap': ('database', 'cache', 'netbox', 'netbox-worker', 'oxidized', 'gitea', 'adapter'),
         'bookstack': ('web', 'database')}
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9][A-Za-z0-9.-]*)?\Z')
HEX = re.compile(r'[0-9a-f]{64}\Z')
MAX_PACKAGE = 8 * 1024**3
MAX_RELEASE_NOTES = 24 * 1024
RESERVE = 512 * 1024**2
HOST_FEATURE_API = 2
_threads = threading.Lock()


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def _object(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise ValueError('Duplicate release JSON key')
        result[k] = v
    return result


def load_json(data):
    return json.loads(data, object_pairs_hook=_object)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024**2), b''):
            h.update(chunk)
    return h.hexdigest()


def directory(path):
    if path.is_symlink() or path.exists() and not path.is_dir():
        raise ValueError('Unsafe delivery directory')
    path.mkdir(mode=0o700, exist_ok=True)
    if path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o022:
        raise ValueError('Unsafe delivery directory owner or permissions')


def atomic(path, value, *, mode=0o600):
    if path.is_symlink() or path.exists() and not path.is_file():
        raise ValueError('Unsafe delivery state')
    data = value if isinstance(value, bytes) else json_bytes(value)
    tmp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, mode)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        tmp.unlink(missing_ok=True)


def read(path, limit=1024**2):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_size > limit):
        raise ValueError('Unsafe release state file')
    return load_json(path.read_bytes())


def asset_url(url, redirect=False):
    if not isinstance(url, str) or len(url) > 4096:
        raise ValueError('Invalid release URL')
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.fragment
            or parsed.port not in (None, 443) or not parsed.hostname):
        raise ValueError('Release URLs require trusted HTTPS')
    if redirect and parsed.hostname == 'release-assets.githubusercontent.com':
        return url
    if (parsed.hostname != 'github.com' or parsed.query
            or not re.fullmatch(r'/Sauke5/pl/releases/download/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', parsed.path, re.I)):
        raise ValueError('Release URL is outside the trusted repository')
    return url


class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        asset_url(url, redirect=True)
        return super().redirect_request(request, fp, code, message, headers, url)


def download(url, destination, size, expected=None, *, opener=None, timeout=30, deadline_seconds=1800, absolute_deadline=None):
    asset_url(url)
    if type(size) is not int or not 1 <= size <= MAX_PACKAGE:
        raise ValueError('Invalid release size')
    if shutil.disk_usage(destination.parent).free < size + RESERVE:
        raise ValueError('Insufficient free space for release download')
    deadline = absolute_deadline if absolute_deadline is not None else time.monotonic() + deadline_seconds
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects(),
                                                   urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    checksum, received = hashlib.sha256(), 0
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Release download timed out')
        with opener.open(urllib.request.Request(url, headers={'User-Agent': 'PL-delivery/1'}), timeout=min(timeout, remaining)) as response, destination.open('xb') as target:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Release download timed out')
                sock = getattr(getattr(getattr(response, 'fp', None), 'raw', None), '_sock', None)
                if sock is not None:
                    sock.settimeout(min(timeout, remaining))
                block = getattr(response, 'read1', response.read)(min(64 * 1024, size + 1 - received))
                if not block:
                    break
                received += len(block)
                if received > size:
                    raise ValueError('Release download exceeds declared size')
                checksum.update(block)
                target.write(block)
            target.flush()
            os.fsync(target.fileno())
        if expected is not None and (received != size or checksum.hexdigest() != expected):
            raise ValueError('Release download integrity mismatch')
        return destination.read_bytes() if expected is None else None
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def artifact(value):
    if (not isinstance(value, dict) or set(value) != {'url', 'sha256', 'size'}
            or not HEX.fullmatch(value.get('sha256', '')) or type(value.get('size')) is not int
            or not 1 <= value['size'] <= MAX_PACKAGE):
        raise ValueError('Invalid signed release artifact')
    asset_url(value['url'])
    return value


def validate_release_notes(value, version):
    if not isinstance(value, dict) or set(value) != {'version', 'title', 'summary', 'sections'}:
        raise ValueError('Invalid signed release notes object')
    if not isinstance(value['version'], str) or value['version'] != version:
        raise ValueError('Release notes version differs from the signed catalog')

    def text(candidate, limit):
        if not isinstance(candidate, str) or not candidate or candidate != candidate.strip() or len(candidate) > limit:
            raise ValueError('Release notes require bounded trimmed plain text')

    text(value['title'], 120)
    text(value['summary'], 800)
    if not isinstance(value['sections'], list) or len(value['sections']) > 3:
        raise ValueError('Invalid release notes sections')
    seen, total = set(), 0
    for section in value['sections']:
        if not isinstance(section, dict) or set(section) != {'kind', 'items'}:
            raise ValueError('Invalid release notes section')
        kind = section['kind']
        if not isinstance(kind, str) or kind not in {'new', 'improved', 'fixed'} or kind in seen:
            raise ValueError('Release notes section kinds must be known and distinct')
        seen.add(kind)
        if not isinstance(section['items'], list):
            raise ValueError('Invalid release notes items')
        total += len(section['items'])
        if total > 8:
            raise ValueError('Release notes contain too many items')
        for item in section['items']:
            if not isinstance(item, dict) or set(item) != {'title', 'description'}:
                raise ValueError('Invalid release notes item')
            text(item['title'], 120)
            text(item['description'], 800)
    if len(json_bytes(value)) > MAX_RELEASE_NOTES:
        raise ValueError('Encoded release notes size exceeds 24 KiB')
    return value


def verify_catalog(envelope, key, previous=None, *, allow_expired=False):
    if not isinstance(envelope, dict) or set(envelope) != {'payload', 'signature'}:
        raise ValueError('Invalid signed catalog envelope')
    try:
        payload = base64.b64decode(envelope['payload'], validate=True)
        signature = base64.b64decode(envelope['signature'], validate=True)
    except (TypeError, ValueError):
        raise ValueError('Invalid release signature encoding') from None
    if len(payload) > 512 * 1024 or len(signature) != 64:
        raise ValueError('Invalid release signature size')
    if key.is_symlink() or not key.is_file() or key.stat().st_mode & 0o022:
        raise ValueError('Unsafe release trust key')
    with tempfile.TemporaryDirectory(prefix='pl-signature-') as tmp:
        data, sig = Path(tmp) / 'payload', Path(tmp) / 'signature'
        data.write_bytes(payload)
        sig.write_bytes(signature)
        result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(key), '-rawin', '-in', str(data), '-sigfile', str(sig)],
                                capture_output=True, timeout=15)
    if result.returncode:
        raise ValueError('Release signature verification failed')
    value = load_json(payload)
    if (not isinstance(value, dict) or value.get('schema') != 1 or value.get('product') != 'PL'
            or value.get('core_api') != 1 or type(value.get('sequence')) is not int or value['sequence'] < 1
            or not VERSION.fullmatch(value.get('version', '')) or not isinstance(value.get('core'), dict)
            or not value['core'] or set(value['core']) - {'amd64', 'arm64'} or not isinstance(value.get('modules'), dict)
            or set(value['modules']) - MODULES):
        raise ValueError('Unsupported signed release catalog')
    for info in value['core'].values():
        artifact(info)
    for module in value['modules'].values():
        if (not isinstance(module, dict) or module.get('core_api') != 1 or not VERSION.fullmatch(module.get('version', ''))
                or not isinstance(module.get('artifacts'), dict) or not module['artifacts'] or set(module['artifacts']) - {'amd64', 'arm64'}):
            raise ValueError('Incompatible module release')
        for info in module['artifacts'].values():
            artifact(info)
    if 'release_notes' in value:
        validate_release_notes(value['release_notes'], value['version'])
    if previous is not None:
        if value['sequence'] < previous['sequence'] or value['sequence'] == previous['sequence'] and value != previous:
            raise ValueError('Signed catalog replay or conflicting release sequence')
    if 'expires_at' in value and (type(value['expires_at']) is not int or not allow_expired and value['expires_at'] < int(time.time())):
        raise ValueError('Signed catalog has expired or has an invalid expiry')
    return value


def newer(candidate, current):
    # Stable release comparison; prereleases are only offered from their signed channel.
    def version(value):
        match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(.*)', value)
        if not match:
            return (-1, -1, -1, 0, value)
        return (*map(int, match.group(1, 2, 3)), int(not match[4]), match[4])
    return version(candidate) > version(current)


def extract_flat(archive, destination, allowed, required):
    with tarfile.open(archive, 'r:*') as tar:
        entries = tar.getmembers()
        names = {m.name for m in entries}
        if (len(entries) != len(names) or not required <= names <= allowed or sum(m.size for m in entries) > MAX_PACKAGE
                or any(not m.isfile() or m.name not in allowed for m in entries)):
            raise ValueError('Unsafe release archive members')
        for member in entries:
            path = destination / member.name
            with tar.extractfile(member) as source, path.open('xb') as target:
                shutil.copyfileobj(source, target)
            path.chmod(0o600)


class Delivery:
    def __init__(self, parent, package=None):
        self.parent, self.root, self.installation = parent, Path(parent.root), parent.installation
        self.package = Path(package) if package else Path(__file__).resolve().parent
        self.supervisor = Path(os.environ.get('PL_HOST_SUPERVISOR_PACKAGE', str(self.package)))
        self.key = self.package / 'release-signing-public.pem'
        self.base = self.root / 'state/delivery'
        directory(self.root / 'state')
        directory(self.base)
        self._checking = False

    @contextmanager
    def lock(self, exclusive=True, blocking=True):
        # Upgrade/configuration barrier. Ordinary RPCs and artifact staging share
        # it; only installation-wide changes take the exclusive side.
        fd = os.open(self.base / 'delivery.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | (0 if blocking else fcntl.LOCK_NB))
            yield

    @contextmanager
    def artifact_lock(self, name):
        # Names are fixed internally, never derived from a URL or package path.
        if name != 'catalog' and name not in MODULES:
            raise ValueError('Unsupported artifact lock')
        fd = os.open(self.base / (name + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    def state(self):
        state = read(self.root / 'state/installation.json')
        if state.get('install_id') != self.installation or state.get('product') not in ('PL', 'Pl'):
            raise ValueError('Installation identity differs')
        return state

    def catalog(self, *, allow_expired=False):
        path = self.base / 'catalog.json'
        return verify_catalog(read(path), self.key, allow_expired=allow_expired) if path.exists() else None

    def github_proxy(self):
        if not hasattr(self, '_github_proxy'):
            path = self.package / 'delivery-proxy.py'
            if path.is_symlink() or not path.is_file():
                raise ValueError('GitHub delivery controller unavailable')
            spec = importlib.util.spec_from_file_location('pl_github_delivery_proxy', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self._github_proxy = module.DeliveryProxy(self)
        return self._github_proxy

    def download(self, url, destination, size, expected=None):
        profile = self.root / 'private/delivery-proxy.json'
        if not profile.exists() and not profile.is_symlink():
            return download(url, destination, size, expected)
        return self.github_proxy().download(url, destination, size, expected)

    def status(self, body, refresh=True):
        if body != {}:
            raise ValueError('Delivery status has no parameters')
        cache = read(self.base / 'cache.json') if (self.base / 'cache.json').exists() else {}
        try:
            catalog = self.catalog()
        except (ValueError, OSError, subprocess.SubprocessError):
            catalog = None
            cache['error'] = 'Сохранённый каталог релизов недоступен или срок его действия истёк. Повторите проверку обновлений.'
        operation = self.reconcile_upgrade()
        state = self.state()
        if refresh and time.time() - cache.get('checked_unix', 0) > 6 * 3600:
            self.start_check()
        modules = self.module_updates(catalog) if catalog else []
        latest = catalog['version'] if catalog else ''
        public_operation = None
        if operation:
            public_operation = {key: operation[key] for key in ('operation_id', 'kind', 'module_id', 'version', 'phase', 'error', 'next_url', 'started_at', 'finished_at') if key in operation}
            public_operation.setdefault('kind', 'upgrade')
            public_operation['recovery_mode'] = 'resume' if operation.get('data_committed') is True else 'rollback'
            if operation.get('restored_snapshot') is True:
                public_operation['restored_snapshot'] = True
        result = {'current_version': state['version'], 'latest_version': latest,
                  'update_available': bool(latest and newer(latest, state['version'])), 'core_api': 1,
                  'checked_at': cache.get('checked_at', ''), 'error': cache.get('error', ''),
                  'modules': modules, 'operation': public_operation}
        if catalog and 'release_notes' in catalog:
            result['release_notes'] = copy.deepcopy(catalog['release_notes'])
        return result

    def module_upgrade_capable(self):
        path = self.package / 'manifest.json'
        return path.exists() and read(path).get('features', {}).get('module_upgrades') is True

    def module_updates(self, catalog):
        registry = self.module_registry()
        result = []
        capable = self.module_upgrade_capable()
        for kind, selected in sorted(catalog['modules'].items()):
            if self.architecture() not in selected['artifacts']:
                continue
            target = selected['artifacts'][self.architecture()]
            path = self.base / ('module-' + kind + '.json')
            receipt = read(path) if path.exists() else {}
            installed = kind in registry
            current = receipt.get('sha256', '')
            if not isinstance(current, str):
                current = ''
            available = installed and bool(HEX.fullmatch(current)) and current != target['sha256']
            supported = available and capable and kind != 'sftpgo' and receipt.get('core_api') == 1 and receipt.get('version') == selected['version']
            reason = ''
            if available and not capable:
                reason = 'Обновите Платформу для установки новой сборки модуля.'
            elif available and not supported:
                reason = ('Обновление SFTP требует отдельного окна с закрытым файловым доступом.' if kind == 'sftpgo'
                          else 'Эта версия модуля требует отдельного плана совместимости.')
            result.append({'module_id': kind, 'version': selected['version'], 'installed': installed,
                           'installed_version': receipt.get('version', ''), 'update_available': available,
                           'upgrade_supported': supported, 'artifact_sha256': target['sha256'], 'blocked_reason': reason})
        return result

    def reconcile_upgrade(self):
        path = self.base / 'operation.json'
        # Launchers hold the delivery barrier until systemd confirms exec. An
        # active unit may still be hashing its payload before acquiring its OS
        # worker lock: status readers must leave that startup lock available.
        if path.exists():
            try:
                with self.lock(exclusive=False, blocking=False):
                    current = read(path)
                    terminal = ('complete', 'failed', 'rolled_back', 'recovery_required')
                    if current.get('phase') not in terminal and self.worker_active(current) is False:
                        with self.worker_lock(blocking=False):
                            # Re-read under the lock: a worker may have completed
                            # while the unit-status query was in flight.
                            current = read(path)
                            if current.get('phase') not in terminal and self.worker_active(current) is False:
                                current['phase'] = 'recovery_required'
                                current['error'] = 'Обновление прервано. Требуется восстановление установки.'
                                atomic(path, current)
            except BlockingIOError:
                pass
        self.publish_upgrade_status()
        return read(path) if path.exists() else None

    @contextmanager
    def status_monitor(self, interval=2.0):
        """Keep orphan detection available when the core API is stopped."""
        stopped = threading.Event()
        def monitor():
            reported = False
            while not stopped.is_set():
                try:
                    self.reconcile_upgrade()
                    reported = False
                except (ValueError, OSError, subprocess.SubprocessError, TypeError):
                    if not reported:
                        logging.warning('PL upgrade status could not be reconciled; inspect the private operation journal')
                        reported = True
                stopped.wait(interval)
        thread = threading.Thread(target=monitor, name='pl-upgrade-status', daemon=True)
        thread.start()
        try:
            yield
        finally:
            stopped.set()
            thread.join(timeout=6)

    def architecture(self):
        arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
        if arch not in ('amd64', 'arm64'):
            raise ValueError('Unsupported release architecture')
        return arch

    def start_check(self):
        with _threads:
            if self._checking:
                return
            self._checking = True
        def run():
            try:
                self.check({})
            finally:
                self._checking = False
        threading.Thread(target=run, name='pl-release-check', daemon=True).start()

    def check(self, body):
        if body != {}:
            raise ValueError('Release check has no parameters')
        # Serialize catalog/replay and cache writers without blocking RPCs on a
        # slow network. Take singleflight before the shared upgrade barrier.
        with self.artifact_lock('catalog'), self.lock(exclusive=False):
            cache = {'checked_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'checked_unix': int(time.time()), 'error': ''}
            try:
                cfgpath = self.root / 'config/delivery.json'
                cfg = read(cfgpath) if cfgpath.exists() else {'schema': 1, 'catalog_url': CATALOG_URL}
                if set(cfg) != {'schema', 'catalog_url'} or cfg['schema'] != 1:
                    raise ValueError('Invalid release channel configuration')
                asset_url(cfg['catalog_url'])
                with tempfile.TemporaryDirectory(dir=self.base) as tmp:
                    raw = self.download(cfg['catalog_url'], Path(tmp) / 'catalog.json', 1024**2)
                    envelope = load_json(raw)
                    verify_catalog(envelope, self.key, self.catalog(allow_expired=True))
                    atomic(self.base / 'catalog.json', envelope)
            except (ValueError, OSError, subprocess.SubprocessError):
                cache['error'] = 'Не удалось проверить подписанный каталог релизов. Сохранён последний подтверждённый каталог.'
            atomic(self.base / 'cache.json', cache)
        return self.status({}, refresh=False)

    def ensure_module(self, kind):
        if kind not in MODULES:
            raise ValueError('Unsupported delivered module')
        # Different modules stage concurrently; repeated delivery of one kind
        # waits only for that kind. No module lifecycle lock covers network or
        # Docker work, and core/configuration changes still require our barrier.
        with self.artifact_lock(kind), self.lock(exclusive=False):
            self.require_idle()
            registry = self.module_registry()
            if kind in registry:
                return False
            catalog = self.catalog()
            if not catalog or kind not in catalog['modules'] or self.architecture() not in catalog['modules'][kind]['artifacts']:
                raise ValueError('Модуль отсутствует в подтверждённом каталоге для этой архитектуры')
            selected = catalog['modules'][kind]
            info = selected['artifacts'][self.architecture()]
            with tempfile.TemporaryDirectory(prefix='.module-', dir=self.root / 'releases') as tmp:
                tmp = Path(tmp)
                archive = tmp / 'module.tar.gz'
                self.download(info['url'], archive, info['size'], info['sha256'])
                extract_flat(archive, tmp, {'module.json', 'images.tar', 'source.tar.gz'}, {'module.json', 'images.tar', 'source.tar.gz'})
                meta = read(tmp / 'module.json')
                self.validate_module(meta, kind, selected['version'], tmp)
                self.parent.docker('image', 'load', '--input', str(tmp / 'images.tar'), timeout=900)
                self.verify_images(meta['images'])
                # Build only this module's descriptor outside the registry
                # commit. Another module may have completed during staging.
                if kind in ROLES:
                    descriptor = {role: meta['images'][kind + '-' + role] for role in ROLES[kind]}
                    if kind == 'doska':
                        current = read(self.root / 'releases' / self.state()['version'] / 'manifest.json')
                        descriptor['database'] = current['images']['db']
                else:
                    descriptor = meta['images'][kind]
                with self.lifecycle_lock():
                    updated = self.module_registry()
                    updated[kind] = descriptor
                    # Publish compatibility evidence before making the new
                    # descriptor visible to installation-wide operations.
                    atomic(self.base / ('module-' + kind + '.json'), {'module_id': kind, 'version': meta['version'], 'core_api': 1, 'sha256': info['sha256']})
                    atomic(self.root / 'private/module-images.json', updated)
            return True

    def module_registry(self):
        registry = read(self.root / 'private/module-images.json')
        state = self.state()
        if (registry.get('schema') != 1 or registry.get('installation') != self.installation
                or registry.get('manifest_sha256') != state.get('manifest_sha256')
                or set(registry) - {'schema', 'installation', 'manifest_sha256'} - MODULES):
            raise ValueError('Module image registry does not match this installation')
        return registry

    def validate_module(self, meta, kind, version, folder):
        expected = {kind + '-' + role for role in ROLES[kind]} if kind in ROLES else {kind}
        if (meta.get('schema') != 1 or meta.get('product') != 'PL' or meta.get('kind') != 'module'
                or meta.get('module_id') != kind or meta.get('core_api') != 1 or meta.get('version') != version
                or meta.get('architecture') != self.architecture() or set(meta.get('images', {})) != expected
                or not HEX.fullmatch(meta.get('source_sha256', '')) or set(meta.get('files', {})) != {'images.tar', 'source.tar.gz'}
                or 'package_version' in meta and (not isinstance(meta['package_version'], str) or not VERSION.fullmatch(meta['package_version']))):
            raise ValueError('Incompatible module package')
        for name, checksum in meta['files'].items():
            if not HEX.fullmatch(checksum) or digest(folder / name) != checksum:
                raise ValueError('Module package integrity mismatch')
        if digest(folder / 'source.tar.gz') != meta['source_sha256']:
            raise ValueError('Module source integrity mismatch')
        for name, image in meta['images'].items():
            labels = image.get('labels', {})
            if (set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                    or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                    or image.get('architecture') != self.architecture() or labels.get('pl.module.id') != kind
                    or image.get('recipe') != 'deploy/images/' + kind + '.Dockerfile'
                    or labels.get('pl.module.config.version') != '1' or labels.get('org.opencontainers.image.version') != version
                    or labels.get('pl.source.sha256') != meta['source_sha256']):
                raise ValueError('Module image provenance mismatch')

    def verify_images(self, images):
        for image in images.values():
            actual = load_json(self.parent.docker('image', 'inspect', image['id']))[0]
            if (actual.get('Id') != image['id'] or actual.get('Os') != 'linux' or actual.get('Architecture') != image['architecture']
                    or any((actual.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in image['labels'].items())):
                raise ValueError('Loaded release image differs from signed artifact')

    @contextmanager
    def lifecycle_lock(self, exclusive=True, blocking=True):
        fd = os.open(self.root / 'modules/controller.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | (0 if blocking else fcntl.LOCK_NB))
            yield

    @contextmanager
    def worker_lock(self, blocking=True):
        fd = os.open(self.base / 'worker.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            yield

    @contextmanager
    def worker_admission(self):
        # The direct recovery CLI has no _launch caller holding this barrier.
        # Exclude status probes only while taking the startup lock; lifecycle
        # work then keeps the worker lock without blocking status/delivery RPCs.
        with ExitStack() as acquired:
            with self.lock():
                acquired.enter_context(self.worker_lock(blocking=False))
            yield

    def require_idle(self, *, allow_refresh=False):
        path = self.base / 'operation.json'
        if path.exists():
            operation = read(path)
            if allow_refresh and operation.get('phase') == 'reconciling' and operation.get('data_committed') is True:
                return
            if operation.get('phase') not in ('complete', 'failed', 'rolled_back'):
                raise ValueError('Обновление установки выполняется или требует восстановления')

    @contextmanager
    def rpc_guard(self, *, allow_refresh=False):
        with self.lock(exclusive=False):
            self.require_idle(allow_refresh=allow_refresh)
            yield

    def operation(self, phase, **fields):
        path = self.base / 'operation.json'
        current = read(path)
        current.update(fields, phase=phase)
        if phase in ('complete', 'rolled_back', 'failed'):
            current['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        atomic(path, current)
        self.publish_upgrade_status()

    def publish_upgrade_status(self):
        # This lock is separate from the lifecycle/delivery barriers: a worker
        # already holding those barriers must be able to publish progress.
        fd = os.open(self.base / 'public-status.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise ValueError('Unsafe upgrade status lock')
            fcntl.flock(stream, fcntl.LOCK_EX)
            self._publish_upgrade_status_locked()

    def _publish_upgrade_status_locked(self):
        """Publish only the finite UI projection, readable without the API.

        The operation journal, artifact URLs, snapshots, configuration and
        exception details remain private. A completed journal is not a live
        health check; the browser must also resynchronize its own session.
        """
        state = self.state()
        value = {'active': False, 'ready': False, 'current_version': state['version']}
        path = self.base / 'operation.json'
        operation = read(path) if path.exists() else None
        blocking = bool(operation and (operation.get('phase') not in ('complete', 'failed', 'rolled_back')
                                       or state.get('phase') != 'ready'))
        if operation and operation.get('kind', 'upgrade') in ('upgrade', 'module_upgrade'):
            # UI telemetry must not prevent recovery of a legacy/incomplete
            # journal. Never advertise an unvalidated operation as active.
            try:
                canonical_id(operation.get('operation_id'))
                if (not VERSION.fullmatch(operation.get('version', '')) or not isinstance(operation.get('phase'), str)
                        or operation.get('kind') == 'module_upgrade' and operation.get('module_id') not in MODULES):
                    operation = None
            except (TypeError, ValueError, AttributeError):
                operation = None
        if operation and operation.get('kind', 'upgrade') in ('upgrade', 'module_upgrade'):
            phase = operation.get('phase')
            phases = {'queued', 'queued_recovery', 'downloading', 'preparing_host', 'quiescing', 'snapshot',
                      'applying', 'verifying_host', 'verifying', 'restoring', 'complete', 'failed',
                      'rolled_back', 'recovery_required', 'resuming', 'reconciling'}
            if phase not in phases:
                phase = 'recovery_required'
            terminal = phase in {'complete', 'failed', 'rolled_back'}
            public = {'operation_id': operation['operation_id'], 'kind': operation.get('kind', 'upgrade'),
                      'version': operation['version'], 'phase': phase}
            public['recovery_mode'] = 'resume' if operation.get('data_committed') is True else 'rollback'
            if operation.get('restored_snapshot') is True:
                public['restored_snapshot'] = True
            if operation.get('kind') == 'module_upgrade':
                public['module_id'] = operation['module_id']
            for name in ('started_at', 'finished_at'):
                timestamp = operation.get(name)
                if isinstance(timestamp, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', timestamp):
                    public[name] = timestamp
            errors = {'failed': 'Обновление не применено. Предыдущая версия и данные сохранены.',
                      'rolled_back': 'Обновление не завершено. Восстановлены предыдущая версия и данные.',
                      'recovery_required': 'Обновление прервано. Требуется восстановление установки.'}
            if operation.get('data_committed') is True:
                errors['recovery_required'] = 'Данные сохранены. Требуется завершить запуск модулей.'
                if operation.get('restored_snapshot') is True:
                    errors['recovery_required'] = 'Предыдущая версия и данные восстановлены. Требуется завершить запуск модулей.'
            if phase in errors:
                public['error'] = errors[phase]
            value.update(active=not terminal, ready=terminal and state.get('phase') == 'ready', operation=public)
        directory(self.root / 'run')
        folder = self.root / 'run/upgrade-status'
        directory(folder)
        folder.chmod(0o755)
        # The ingress rejects application writes throughout the snapshot and
        # rollback window, including the interval when the API has restarted
        # but the operation has not committed yet. It never reads private state.
        marker = folder / 'active'
        if marker.is_symlink() or marker.exists() and not marker.is_file():
            raise ValueError('Unsafe public maintenance marker')
        if blocking:
            if not marker.exists():
                atomic(marker, b'', mode=0o644)
        else:
            marker.unlink(missing_ok=True)
        path = folder / 'status.json'
        if path.exists() and read(path) == value and stat.S_IMODE(path.stat().st_mode) == 0o644:
            return
        atomic(path, value, mode=0o644)

    def record_failure(self, error):
        path = self.base / 'operation.json'
        current = read(path)
        # Retain actionable source locations privately, never argv, environment,
        # exception messages or local variable values that may contain secrets.
        current['last_failure'] = {'phase': current.get('phase', ''), 'type': type(error).__name__,
                                  'code': getattr(error, 'public_code', ''),
                                  'frames': [{'file': Path(frame.filename).name, 'line': frame.lineno, 'function': frame.name}
                                             for frame in traceback.extract_tb(error.__traceback__)[-12:]]}
        atomic(path, current)

    def upgrade(self, body):
        if (not isinstance(body, dict) or set(body) != {'version', 'operation_id'}
                or not VERSION.fullmatch(body.get('version', ''))):
            raise ValueError('Invalid upgrade request')
        canonical_id(body.get('operation_id'))
        with self.lock():
            existing = read(self.base / 'operation.json') if (self.base / 'operation.json').exists() else None
            if existing and existing.get('operation_id') == body['operation_id']:
                if existing.get('kind', 'upgrade') != 'upgrade' or existing.get('version') != body['version']:
                    raise ValueError('Upgrade operation ID was used for another version')
                return self.status({}, refresh=False)
            self.require_idle()
            catalog, state = self.catalog(), self.state()
            if (not catalog or catalog['version'] != body['version'] or not newer(body['version'], state['version'])
                    or self.architecture() not in catalog['core']):
                raise ValueError('Версия не является доступным подтверждённым обновлением')
            # A protocol-1 core upgrade preserves module images and all their data.
            registry = read(self.root / 'private/module-images.json')
            for kind in set(registry) & MODULES:
                record = self.base / ('module-' + kind + '.json')
                if not record.exists() or read(record).get('core_api') != 1:
                    raise ValueError('Совместимость установленного модуля с обновлением не подтверждена')
            operation = {**body, 'phase': 'queued', 'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                         'from_version': state['version'], 'error': '', 'artifact': catalog['core'][self.architecture()],
                         'catalog_sequence': catalog['sequence']}
            self._launch(operation, recovering=False)
        return self.status({}, refresh=False)

    def recover(self, body):
        if not isinstance(body, dict) or set(body) != {'operation_id'}:
            raise ValueError('Invalid recovery request')
        canonical_id(body.get('operation_id'))
        with self.lock():
            operation = read(self.base / 'operation.json')
            if operation.get('operation_id') != body['operation_id'] or operation.get('phase') != 'recovery_required':
                raise ValueError('Нет прерванного обновления с этим идентификатором')
            self._launch(operation, recovering=True)
        return self.status({}, refresh=False)

    def module_upgrade(self, body):
        if (not isinstance(body, dict) or set(body) != {'module_id', 'artifact_sha256', 'operation_id'}
                or not isinstance(body.get('module_id'), str) or body['module_id'] not in MODULES
                or not isinstance(body.get('artifact_sha256'), str) or not HEX.fullmatch(body['artifact_sha256'])):
            raise ValueError('Invalid module upgrade request')
        canonical_id(body.get('operation_id'))
        with self.lock():
            path = self.base / 'operation.json'
            existing = read(path) if path.exists() else None
            if existing and existing.get('operation_id') == body['operation_id']:
                if (existing.get('kind') != 'module_upgrade' or existing.get('module_id') != body['module_id']
                        or existing.get('artifact', {}).get('sha256') != body['artifact_sha256']):
                    raise ValueError('Operation ID belongs to another update')
                return self.status({}, refresh=False)
            self.require_idle()
            if not self.module_upgrade_capable():
                raise ValueError('This core does not support installed module updates')
            catalog = self.catalog()
            offers = self.module_updates(catalog) if catalog else []
            offer = next((v for v in offers if v['module_id'] == body['module_id']), None)
            if (not offer or not offer['update_available'] or not offer['upgrade_supported']
                    or offer['artifact_sha256'] != body['artifact_sha256']):
                raise ValueError('Module update is not the selected compatible signed artifact')
            state = self.state()
            selected = catalog['modules'][body['module_id']]
            operation = {'operation_id': body['operation_id'], 'kind': 'module_upgrade', 'module_id': body['module_id'],
                         'version': state['version'], 'from_version': state['version'], 'module_version': selected['version'],
                         'phase': 'queued', 'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'error': '',
                         'artifact': selected['artifacts'][self.architecture()], 'catalog_sequence': catalog['sequence']}
            self._launch(operation, recovering=False)
        return self.status({}, refresh=False)

    def _launch(self, operation, recovering):
        if (self.supervisor != self.supervisor.resolve() or self.supervisor.parent != self.root / 'releases'
                or not (self.supervisor / 'controller-supervisor.py').is_file()):
            raise ValueError('Immutable host supervisor package is unavailable')
        package = self.worker_package(operation, recovering=recovering)
        unit = self.installation + '-upgrade-' + uuid.UUID(operation['operation_id']).hex
        operation['worker_unit'] = unit + '.service'
        operation['phase'] = 'queued_recovery' if recovering else 'queued'
        atomic(self.base / 'operation.json', operation)
        self.publish_upgrade_status()
        command = ['systemd-run', '--quiet', '--collect', '--unit', unit,
                   '--property=Type=exec', '--property=TimeoutStartSec=7200', '--property=UMask=0077',
                   '--property=NoNewPrivileges=true', '--property=ProtectSystem=strict', '--property=ProtectHome=true',
                   '--property=PrivateTmp=true', '--property=ReadWritePaths=' + str(self.root),
                   '--setenv=PL_HOST_SUPERVISOR_PACKAGE=' + str(self.supervisor),
                   '/usr/bin/python3', str(package / 'delivery.py'), 'worker', '--root', str(self.root),
                   '--operation-id', operation['operation_id']]
        if recovering:
            command.append('--recover')
        try:
            self.host(command, timeout=20)
        except (ValueError, OSError, subprocess.SubprocessError):
            self.operation('recovery_required' if recovering else 'failed', error='Не удалось запустить отдельный процесс обновления. Данные установки не изменены.')

    def verified_worker_release(self, version, expected=None):
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            raise ValueError('Invalid pinned worker version')
        package = self.root / 'releases' / version
        if (package != package.resolve() or not package.is_dir() or package.stat().st_uid != os.geteuid()
                or package.stat().st_mode & 0o022):
            raise ValueError('Unsafe worker release directory')
        self.validate_core_files(package, version)
        manifest = read(package / 'manifest.json')
        if not manifest.get('features', {}).get('on_demand_modules'):
            raise ValueError('Worker requires protocol-1 on-demand payload')
        for name in manifest['files']:
            path = package / name
            if path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o022:
                raise ValueError('Unsafe worker payload permissions')
        if expected is not None and (not isinstance(expected, str) or not HEX.fullmatch(expected)
                                     or digest(package / 'manifest.json') != expected):
            raise ValueError('Pinned worker manifest differs')
        return package

    def worker_package(self, operation, *, recovering):
        identity = read(self.root / 'state/controller-supervisor.json')
        if (set(identity) != {'schema', 'version'} or identity['schema'] != 1
                or self.supervisor != self.root / 'releases' / identity['version']):
            raise ValueError('Immutable supervisor identity differs')
        self.verified_worker_release(identity['version'])
        if recovering:
            version = operation.get('worker_version', identity['version'])
            if 'worker_version' in operation and 'worker_manifest_sha256' not in operation:
                raise ValueError('Pinned worker manifest unavailable')
            return self.verified_worker_release(version, operation.get('worker_manifest_sha256'))
        # Reuse the immutable supervisor's full active payload validation.
        spec = importlib.util.spec_from_file_location('pl_worker_supervisor', self.supervisor / 'controller-supervisor.py')
        supervisor = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(supervisor)
        package = supervisor.selected_package(self.root, self.supervisor)
        state = self.state()
        if package.name != state['version']:
            raise ValueError('Active worker and installed core versions differ')
        self.verified_worker_release(package.name, state['manifest_sha256'])
        operation.update(worker_version=package.name, worker_manifest_sha256=state['manifest_sha256'])
        return package

    def validate_worker_entry(self, operation):
        package = self.worker_package(operation, recovering=True)
        if package != self.package.resolve():
            raise ValueError('Operation requires its exact verified worker release')
        if 'worker_handoff' in operation:
            handoff = operation['worker_handoff']
            if (not isinstance(handoff, dict) or set(handoff) != {'schema', 'capability', 'from_version', 'from_manifest_sha256', 'core_from_version', 'to_version', 'to_manifest_sha256'}
                    or handoff.get('schema') != 1 or type(handoff.get('capability')) is not int or handoff.get('capability') not in (1, 2)
                    or handoff.get('to_version') != operation.get('worker_version')
                    or handoff.get('to_version') != operation.get('version')
                    or handoff.get('to_manifest_sha256') != operation.get('worker_manifest_sha256')
                    or handoff.get('core_from_version') != operation.get('from_version')
                    or not isinstance(handoff.get('from_manifest_sha256'), str) or not HEX.fullmatch(handoff['from_manifest_sha256'])):
                raise ValueError('Invalid pre-snapshot worker handoff ledger')
            self.verified_worker_release(handoff['from_version'], handoff.get('from_manifest_sha256'))
        return package

    @staticmethod
    def host(command, timeout=30):
        result = subprocess.run(command, capture_output=True, timeout=timeout,
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'})
        if result.returncode:
            raise ValueError('Finite host service operation failed')
        return result.stdout

    def worker_active(self, operation):
        unit = operation.get('worker_unit', '')
        if not re.fullmatch(re.escape(self.installation) + r'-upgrade-[0-9a-f]{32}\.service', unit):
            return False
        try:
            state = self.host(['systemctl', 'show', '--property=ActiveState', '--value', unit], timeout=5).strip()
            if state in (b'active', b'activating', b'reloading', b'deactivating'):
                return True
            if state in (b'inactive', b'failed'):
                return False
            return None
        except (ValueError, OSError, subprocess.SubprocessError):
            # An unavailable service manager cannot establish that a unit died.
            return None

    def bootstrap(self):
        spec = importlib.util.spec_from_file_location('pl_delivery_bootstrap', self.package / 'bootstrap.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def icmp_installer(self, package):
        self.verified_worker_release(package.name)
        spec = importlib.util.spec_from_file_location('pl_delivery_icmp', package / 'icmp-install.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        return helper

    def prepare_icmp(self, package, manifest, config):
        if not manifest.get('features', {}).get('icmp_probe'):
            return False
        operation = read(self.base / 'operation.json')
        helper = self.icmp_installer(package)
        policy = self.bootstrap().icmp_policy(config)
        fingerprint = helper.transaction(self.root, package, self.installation, operation['operation_id'], policy, self.host)
        self.operation('preparing_host', icmp_package=package.name, icmp_package_manifest_sha256=digest(package / 'manifest.json'),
                       icmp_host_plan_sha256=fingerprint)
        self.icmp_host('dependency')
        return True

    def icmp_host(self, action):
        if action not in ('dependency', 'apply', 'restore'):
            raise ValueError('Invalid ICMP provision action')
        operation = read(self.base / 'operation.json')
        if not operation.get('icmp_host_plan_sha256'):
            return
        package = self.verified_worker_release(operation['icmp_package'], operation['icmp_package_manifest_sha256'])
        unit_prefix = self.installation + '-icmp-' + uuid.UUID(operation['operation_id']).hex + '-'
        for pending in ('dependency', 'apply', 'restore'):
            try:
                active = self.host(['systemctl', 'show', '--property=ActiveState', '--value', unit_prefix + pending + '.service'], timeout=5)
            except (ValueError, OSError, subprocess.SubprocessError):
                continue
            if active.strip() in (b'active', b'activating', b'deactivating', b'reloading'):
                raise ValueError('ICMP provisioner is still running; wait before recovery')
        unit = unit_prefix + action
        # PID1 starts a separate finite provisioner. The updater retains its
        # root-only ReadWritePaths. Only apt prerequisites need OS package paths.
        writable = [str(self.root), '/usr', '/etc', '/var', '/run'] if action == 'dependency' else [
            str(self.root), '/usr/local/lib/pl/icmp', '/etc/pl/icmp', '/etc/systemd/system']
        command = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit', unit,
                   '--property=Type=exec', '--property=TimeoutStartSec=1000', '--property=RuntimeMaxSec=1000',
                   '--property=KillMode=control-group', '--property=UMask=0077',
                   '--property=NoNewPrivileges=true', '--property=ProtectSystem=strict', '--property=ProtectHome=true',
                   '--property=PrivateTmp=true', '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
                   '--property=InaccessiblePaths=-/run/docker.sock', '--property=ReadWritePaths=' + ' '.join(writable),
                   '/usr/bin/python3', str(package / 'icmp-install.py'), action, '--root', str(self.root),
                   '--operation-id', operation['operation_id']]
        self.host(command, timeout=1020)

    def upgraded_model(self, destination, manifest, state):
        model = read(self.root / 'config/compose.json')
        for name in ('api', 'web', 'db'):
            model['services'][name]['image'] = manifest['images'][name]['id']
        if manifest.get('features', {}).get('icmp_probe'):
            spec = importlib.util.spec_from_file_location('pl_upgrade_compose', destination / 'bootstrap.py')
            bootstrap = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(bootstrap)
            generated = bootstrap.compose_model(self.root, manifest, state['config'], self.installation)
            bootstrap.apply_icmp_model(self.root, model, generated)
        if manifest.get('features', {}).get('upgrade_status'):
            mount = {'type': 'bind', 'source': str(self.root / 'run/upgrade-status').replace('$', '$$'),
                     'target': '/run/pl-upgrade', 'read_only': True, 'bind': {'create_host_path': False}}
            volumes = model['services']['web']['volumes']
            volumes[:] = [v for v in volumes if not isinstance(v, dict) or v.get('target') != '/run/pl-upgrade']
            volumes.append(mount)
            api = model['services']['api']
            api['volumes'] = [v for v in api.get('volumes', []) if not isinstance(v, dict) or v.get('target') != '/run/pl-upgrade']
            api['volumes'].append(copy.deepcopy(mount))
            api.setdefault('environment', {})['PORTAL_MAINTENANCE_DIR'] = '/run/pl-upgrade'
        return model

    def installation_settings(self):
        active = read(self.root / 'state/controller-active.json')
        if active.get('schema') != 1 or not VERSION.fullmatch(active.get('version', '')):
            raise ValueError('Invalid active host release')
        package = self.root / 'releases' / active['version']
        if package != package.resolve():
            raise ValueError('Unsafe active host release')
        manifest = read(package / 'manifest.json')
        path = package / 'installation-settings.py'
        expected = manifest.get('files', {}).get(path.name)
        if (not isinstance(expected, str) or not HEX.fullmatch(expected) or path.is_symlink() or not path.is_file()
                or digest(path) != expected or digest(package / 'release-signing-public.pem') != digest(self.supervisor / 'release-signing-public.pem')):
            raise ValueError('Active installation settings helper integrity differs')
        identity = (str(path), expected)
        if getattr(self, '_installation_helper_identity', None) != identity:
            spec = importlib.util.spec_from_file_location('pl_active_installation_settings', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self._installation_helper = module.InstallationSettings(self)
            self._installation_helper_identity = identity
        return self._installation_helper

    def run_operation(self, recovering=False):
        operation = read(self.base / 'operation.json')
        if recovering and operation.get('data_committed') is True:
            self.resume_committed()
        elif operation.get('kind') == 'configuration':
            if recovering:
                self.installation_settings().rollback()
            else:
                self.installation_settings().perform()
        elif recovering:
            self.rollback()
        elif operation.get('kind') == 'module_upgrade':
            self.perform_module_upgrade()
        else:
            self.perform_upgrade()

    def module_upgrade_helper(self):
        path = self.package / 'module-upgrade.py'
        expected = read(self.package / 'manifest.json').get('files', {}).get(path.name)
        if (not isinstance(expected, str) or not HEX.fullmatch(expected) or path.is_symlink()
                or not path.is_file() or digest(path) != expected):
            raise ValueError('Pinned native module upgrade helper is unavailable')
        spec = importlib.util.spec_from_file_location('pl_native_module_upgrade', path)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        return helper

    def preserve_storage_images(self, kind, descriptor):
        roles = {'forms': ('mongo', 'keydb'), 'netmap': ('database', 'cache'), 'bookstack': ('database',)}.get(kind, ())
        if not roles:
            return descriptor
        previous = self.module_registry()[kind]
        for role in roles:
            old, new = previous[role], descriptor[role]
            same_contract = (old['architecture'] == new['architecture'] and old['recipe'] == new['recipe']
                             and old['labels'].get('org.opencontainers.image.version') == new['labels'].get('org.opencontainers.image.version')
                             and old['labels'].get('pl.module.config.version') == new['labels'].get('pl.module.config.version'))
            if not same_contract:
                continue
            equivalent = old['id'] == new['id']
            if not equivalent:
                values = []
                for image in (old, new):
                    actual = load_json(self.parent.docker('image', 'inspect', image['id']))[0]
                    config = copy.deepcopy(actual.get('Config') or {}); config.pop('Labels', None)
                    values.append((actual.get('Os'), actual.get('Architecture'), actual.get('RootFS'), config))
                equivalent = values[0] == values[1] and isinstance(values[0][2], dict) and 'Layers' in values[0][2]
            if equivalent:
                # Keep storage bytes and identity. A package tag or build-source
                # label is not a database migration; changed filesystem layers
                # remain a refused transition in the native preflight.
                descriptor[role] = copy.deepcopy(old)
        return descriptor

    def stage_module_upgrade(self, operation):
        kind, info = operation['module_id'], artifact(operation['artifact'])
        if shutil.disk_usage(self.root / 'releases').free < 3 * info['size'] + RESERVE:
            raise ValueError('Insufficient free space to stage both module image versions')
        with tempfile.TemporaryDirectory(prefix='.module-update-', dir=self.root / 'releases') as temporary:
            folder = Path(temporary)
            archive = folder / 'module.tar.gz'
            self.download(info['url'], archive, info['size'], info['sha256'])
            extract_flat(archive, folder, {'module.json', 'images.tar', 'source.tar.gz'}, {'module.json', 'images.tar', 'source.tar.gz'})
            meta = read(folder / 'module.json')
            self.validate_module(meta, kind, operation['module_version'], folder)
            self.parent.docker('image', 'load', '--input', str(folder / 'images.tar'), timeout=900)
            self.verify_images(meta['images'])
        if kind in ROLES:
            descriptor = {role: meta['images'][kind + '-' + role] for role in ROLES[kind]}
            if kind == 'doska':
                descriptor['database'] = copy.deepcopy(self.module_registry()[kind]['database'])
        else:
            descriptor = meta['images'][kind]
        return meta, self.preserve_storage_images(kind, descriptor)

    def checkpoint_module_upgrade(self, plan):
        operation = read(self.base / 'operation.json')
        if (operation.get('kind') != 'module_upgrade' or plan.get('snapshot_operation_id') != operation['operation_id']
                or plan.get('module_id') != operation['module_id']):
            raise ValueError('Native update checkpoint identity differs')
        self.operation(operation['phase'], module_upgrade_plan=plan,
                       module_upgrade_plan_sha256=hashlib.sha256(json_bytes(plan)).hexdigest())

    def perform_module_upgrade(self):
        request = read(self.base / 'operation.json')
        changed = False
        try:
            self.operation('downloading')
            meta, descriptor = self.stage_module_upgrade(request)
            old = copy.deepcopy(self.module_registry()[request['module_id']])
            helper = self.module_upgrade_helper()
            plan = helper.plan(self.parent, request['module_id'], old, descriptor)
            plan['snapshot_operation_id'] = request['operation_id']
            self.parent.module_upgrade_checkpoint = self.checkpoint_module_upgrade
            self.checkpoint_module_upgrade(plan)
            old_receipt = read(self.base / ('module-' + request['module_id'] + '.json'))
            self.operation('quiescing', old_module_receipt=old_receipt)
            self.check_snapshot_capacity()
            containers = self.inventory()
            self.operation('quiescing', containers=containers)
            self.stop(containers, keep_web=True)
            self.operation('snapshot')
            snapshot = self.snapshot(request, containers)
            self.operation('applying', snapshot=str(snapshot))
            changed = True
            registry = self.module_registry()
            registry[request['module_id']] = descriptor
            atomic(self.root / 'private/module-images.json', registry)
            helper.apply(self.parent, plan)
            self.activate_host(request['from_version'])
            self.operation('verifying')
            self.restart_core()
            target = [v for v in containers if not v['core'] and v.get('module_id') == request['module_id']]
            self.resume_native(target, safe_only=True)
            helper.verify(self.parent, plan)
            self.readiness()
            atomic(self.base / ('module-' + request['module_id'] + '.json'), {
                'module_id': request['module_id'], 'version': meta['version'], 'core_api': 1,
                'sha256': request['artifact']['sha256'], 'package_version': meta.get('package_version', '')})
            self.commit_and_resume(containers)
        except BaseException as error:
            self.record_failure(error)
            if read(self.base / 'operation.json').get('data_committed') is True:
                self.operation('recovery_required', error='Версия установлена. Требуется завершить запуск модулей; новые данные сохранены.')
            elif changed:
                self.rollback()
            else:
                latest = read(self.base / 'operation.json')
                if latest.get('containers'):
                    self.restart(latest['containers'])
                    self.readiness()
                self.operation('failed', error='Обновление не применено. Предыдущая версия и данные сохранены.')

    def stage_core(self, request):
        info = artifact(request['artifact'])
        destination = self.root / 'releases' / request['version']
        if destination.exists():
            if destination.is_symlink() or (destination / '.package-sha256').read_text().strip() != info['sha256']:
                raise ValueError('Published version already staged with different contents')
            self.validate_core_files(destination, request['version'])
        else:
            with tempfile.TemporaryDirectory(prefix='.upgrade-', dir=self.root / 'releases') as temporary:
                folder = Path(temporary)
                archive = folder / 'core.tar.gz'
                self.download(info['url'], archive, info['size'], info['sha256'])
                payload = folder / 'payload'
                payload.mkdir(mode=0o750)
                with tarfile.open(archive, 'r:*') as tar:
                    member = tar.getmember('manifest.json')
                    if not member.isfile() or member.size > 1024**2:
                        raise ValueError('Invalid signed core manifest')
                    meta = load_json(tar.extractfile(member).read())
                names = set(meta.get('files', {})) | {'manifest.json'}
                if len(names) > 100 or any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name) for name in names):
                    raise ValueError('Invalid signed core file set')
                extract_flat(archive, payload, names, names)
                self.validate_core_files(payload, request['version'])
                atomic(payload / '.package-sha256', (info['sha256'] + '\n').encode())
                payload.rename(destination)
        # The signed package's validator owns its new runtime recipes. Execute
        # it only after verifying the complete signed payload and immutable key.
        spec = importlib.util.spec_from_file_location('pl_candidate_bootstrap', destination / 'bootstrap.py')
        bootstrap = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bootstrap)
        manifest = bootstrap.manifest(destination)
        old = read(self.root / 'releases' / request['from_version'] / 'manifest.json')
        if (manifest['version'] != request['version'] or manifest['schema'] != 2
                or manifest.get('database', {}).get('major') != old.get('database', {}).get('major')
                or set(manifest['images']) != {'api', 'web', 'db'}
                or not manifest.get('features', {}).get('on_demand_modules')):
            raise ValueError('Core upgrade requires matching PostgreSQL major and protocol-1 minimal images')
        self.parent.docker('image', 'load', '--input', str(destination / 'images.tar'), timeout=900)
        self.verify_images(manifest['images'])
        return destination, manifest

    def validate_core_files(self, destination, version):
        manifest = read(destination / 'manifest.json')
        if (manifest.get('product') != 'PL' or manifest.get('schema') != 2 or manifest.get('version') != version
                or manifest.get('core_api', 1) != 1 or not isinstance(manifest.get('files'), dict)
                or not {'bootstrap.py', 'module-controller.py', 'delivery.py', 'release-signing-public.pem', 'images.tar'} <= manifest['files'].keys()
                or len(manifest['files']) > 100):
            raise ValueError('Unsupported signed core package')
        for name, checksum in manifest['files'].items():
            path = destination / name
            if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name) or not isinstance(checksum, str)
                    or not HEX.fullmatch(checksum) or path.is_symlink() or not path.is_file() or digest(path) != checksum):
                raise ValueError('Signed core payload integrity mismatch')
        if digest(destination / 'release-signing-public.pem') != digest(self.supervisor / 'release-signing-public.pem'):
            raise ValueError('Core update changes the immutable release trust key')

    def activate_host(self, version):
        atomic(self.root / 'state/controller-active.json', {'schema': 1, 'version': version})
        self.host(['systemctl', 'restart', self.installation + '-module-controller.service'], timeout=60)
        deadline = time.monotonic() + 120
        while True:
            try:
                key = (self.root / 'private/module-controller-key').read_bytes()
                timestamp = str(int(time.time()))
                body, path = b'{}', '/v1/delivery/status'
                signature = hmac.new(key, (timestamp + '\nPOST\n' + path + '\n').encode() + body, hashlib.sha256).hexdigest()
                conn = http.client.HTTPConnection('pl-controller', timeout=5)
                conn.sock = socket.socket(socket.AF_UNIX)
                conn.sock.settimeout(5)
                conn.sock.connect(str(self.root / 'run/module-controller/control.sock'))
                try:
                    conn.request('POST', path, body, {'Content-Type': 'application/json', 'X-PL-Timestamp': timestamp, 'X-PL-Signature': signature})
                    response = conn.getresponse()
                    value = load_json(response.read(65537))
                    if (response.status == 200 and value.get('core_api') == 1 and value.get('current_version') == version
                            and value.get('operation', {}).get('operation_id') == read(self.base / 'operation.json')['operation_id']):
                        return
                finally:
                    conn.close()
            except (OSError, ValueError, http.client.HTTPException):
                pass
            if time.monotonic() > deadline:
                raise ValueError('Updated host controller did not confirm the active installation')
            time.sleep(1)

    def inventory(self, require_core=True):
        ids = set(self.parent.docker('container', 'ls', '-a', '--filter', 'label=pl.installation=' + self.installation, '--format', '{{.ID}}').decode().split())
        ids.update(self.parent.docker('container', 'ls', '-a', '--filter', 'label=com.docker.compose.project=' + self.installation, '--format', '{{.ID}}').decode().split())
        if not ids:
            if require_core:
                raise ValueError('Installed core containers are missing')
            return []
        containers = load_json(self.parent.docker('container', 'inspect', *sorted(ids)))
        result = []
        for obj in containers:
            labels = obj.get('Config', {}).get('Labels') or {}
            core = labels.get('com.docker.compose.project') == self.installation
            if not core and labels.get('pl.installation') != self.installation:
                raise ValueError('Foreign container in installation inventory')
            name = obj.get('Name', '').removeprefix('/')
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,200}', name):
                raise ValueError('Invalid owned container name')
            for mount in obj.get('Mounts', []):
                if mount.get('RW') and mount.get('Type') == 'bind':
                    source = Path(mount.get('Source', ''))
                    if not source.is_relative_to(self.root / 'modules') or source != source.resolve():
                        raise ValueError('Owned container has data outside the managed installation')
            kind = labels.get('pl.module', '')
            if not core and kind not in MODULES:
                raise ValueError('Owned native container has no supported module identity')
            result.append({'name': name, 'running': obj.get('State', {}).get('Running') is True, 'core': core,
                           'module_id': kind, 'service': labels.get('com.docker.compose.service', ''), 'image': obj['Image']})
        if require_core and {c['service'] for c in result if c['core']} != {'api', 'web', 'db'}:
            raise ValueError('Unexpected core service inventory')
        return result

    def volumes(self):
        names = self.parent.docker('volume', 'ls', '--filter', 'label=pl.installation=' + self.installation, '--format', '{{.Name}}').decode().split()
        docker_root = Path(load_json(self.parent.docker('info', '--format', '{{json .DockerRootDir}}')))
        result = []
        for name in sorted(names):
            obj = load_json(self.parent.docker('volume', 'inspect', name))[0]
            path = Path(obj.get('Mountpoint', ''))
            if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,200}', name) or obj.get('Driver') != 'local' or obj.get('Options')
                    or (obj.get('Labels') or {}).get('pl.installation') != self.installation
                    or path != docker_root / 'volumes' / name / '_data' or path != path.resolve() or not path.is_dir()):
                raise ValueError('Unsupported or foreign installation volume')
            result.append({'name': name, 'path': str(path)})
        if self.installation + '-auth' not in names:
            raise ValueError('Owned authentication data volume is missing')
        # Labels cannot grant us a volume concurrently used by another service.
        all_ids = self.parent.docker('container', 'ls', '-a', '--format', '{{.ID}}').decode().split()
        for obj in load_json(self.parent.docker('container', 'inspect', *all_ids)) if all_ids else []:
            labels = obj.get('Config', {}).get('Labels') or {}
            if labels.get('pl.installation') == self.installation or labels.get('com.docker.compose.project') == self.installation:
                continue
            if any(m.get('Type') == 'volume' and m.get('Name') in names for m in obj.get('Mounts', [])):
                raise ValueError('Installation volume is also mounted by a foreign container')
        return result

    def stop(self, containers, *, keep_web=False):
        if not containers:
            return
        # The stateless HTTPS ingress can continue serving the update screen and
        # its public journal. API shutdown closes writes before database stop.
        stopped = [c for c in containers if not (keep_web and c['core'] and c['service'] == 'web')]
        first = [c['name'] for c in stopped if c['running'] and c['core'] and c['service'] in ('web', 'api')]
        rest = [c['name'] for c in stopped if c['running'] and c['name'] not in first]
        for group in (first, rest):
            if group:
                self.parent.docker('container', 'stop', '--time', '30', *group, timeout=180)
        for obj in load_json(self.parent.docker('container', 'inspect', *[c['name'] for c in stopped])) if stopped else []:
            if obj.get('State', {}).get('Running'):
                raise ValueError('Installation did not quiesce')

    def compose(self, *args):
        return self.parent.docker('compose', '--project-name', self.installation, '--env-file', str(self.root / 'private/runtime.env'),
                                  '-f', str(self.root / 'config/compose.json'), *args, timeout=240)

    def restart(self, containers):
        self.restart_core()
        self.resume_native(containers)

    def restart_core(self):
        # Keep HTTPS and the update journal available until the new API is
        # healthy. Recreate web explicitly: Compose does not notice atomically
        # replaced bind-mounted config files when the image ID is unchanged.
        self.compose('up', '--detach', '--pull', 'never', '--no-build', '--wait', '--wait-timeout', '180', 'db', 'api')
        journal = self.base / 'operation.json'
        if journal.exists() and read(journal).get('kind', 'upgrade') in ('upgrade', 'module_upgrade'):
            # API has no container healthcheck. Its listener and migrations
            # must actually be ready before replacing the existing ingress.
            self.wait_readiness()
        self.compose('up', '--detach', '--pull', 'never', '--no-build', '--no-deps', '--force-recreate',
                     '--wait', '--wait-timeout', '180', 'web')
    def resume_native(self, containers, *, safe_only=False):
        names = [c['name'] for c in containers if c['running'] and not c['core'] and (not safe_only or c.get('module_id') != 'sftpgo')]
        if names:
            self.parent.docker('container', 'start', *names, timeout=180)
            deadline = time.monotonic() + 120
            while True:
                objects = load_json(self.parent.docker('container', 'inspect', *names))
                if all(v.get('State', {}).get('Running') and v.get('State', {}).get('Health', {}).get('Status', 'healthy') == 'healthy' for v in objects):
                    break
                if time.monotonic() >= deadline:
                    raise ValueError('Previously running modules did not become healthy')
                time.sleep(2)

    def commit_and_resume(self, containers):
        # From here onward native ingress (including SFTP) may accept writes.
        # A later failure must resume the committed installation, never restore
        # its older full snapshot over newly accepted files or user data.
        self.operation('resuming', data_committed=True, error='')
        self.resume_native(containers)
        self.operation('reconciling')
        self.synchronize_modules()
        self.readiness()
        restored = read(self.base / 'operation.json').get('restored_snapshot') is True
        self.operation('rolled_back' if restored else 'complete',
                       error='Восстановлены предыдущая версия и данные.' if restored else '')

    def synchronize_modules(self):
        state = self.state()
        manifest = read(self.root / 'releases' / state['version'] / 'manifest.json')
        if not manifest.get('features', {}).get('module_upgrades'):
            # Legacy rollback APIs have no signed reconciliation callback.
            # Their existing scheduler resumes after the terminal operation.
            return
        ids = self.parent.docker('container', 'ls', '--filter', 'label=com.docker.compose.project=' + self.installation,
                                 '--filter', 'label=com.docker.compose.service=api', '--format', '{{.ID}}').decode().split()
        if len(ids) != 1:
            raise ValueError('Owned core API is unavailable for reconciliation')
        obj = load_json(self.parent.docker('container', 'inspect', ids[0]))[0]
        labels = obj.get('Config', {}).get('Labels') or {}
        if (obj.get('Image') != manifest['images']['api']['id'] or not obj.get('State', {}).get('Running')
                or labels.get('com.docker.compose.project') != self.installation
                or labels.get('com.docker.compose.service') != 'api'):
            raise ValueError('Core reconciliation target identity differs')
        network = obj.get('NetworkSettings', {}).get('Networks', {}).get(self.installation + '_backend', {})
        address = ipaddress.IPv4Address(network.get('IPAddress', ''))
        if not address.is_private:
            raise ValueError('Core reconciliation target is outside its private network')
        key_path = self.root / 'private/module-controller-key'
        info = key_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o007:
            raise ValueError('Unsafe core reconciliation credential')
        key = key_path.read_bytes()
        if len(key) != 32:
            raise ValueError('Invalid core reconciliation credential')
        operation = read(self.base / 'operation.json')
        body = json_bytes({'operation_id': operation['operation_id'], 'request_id': str(uuid.uuid4())})
        timestamp = str(int(time.time())); path = '/internal/delivery/reconcile'
        signature = hmac.new(key, b'pl-delivery-reconcile-v1\n' + (timestamp + '\nPOST\n' + path + '\n').encode() + body, hashlib.sha256).hexdigest()
        connection = http.client.HTTPConnection(str(address), 8080, timeout=70)
        try:
            connection.request('POST', path, body, {'Content-Type': 'application/json',
                'X-PL-Delivery-Timestamp': timestamp, 'X-PL-Delivery-Signature': signature})
            response = connection.getresponse(); raw = response.read(65537)
            if response.status != 200 or len(raw) > 65536:
                raise ValueError('Core did not confirm refreshed module bindings')
            value = load_json(raw)
            if (set(value) != {'operation_id', 'ready', 'instances'} or value['operation_id'] != operation['operation_id']
                    or value['ready'] is not True or type(value['instances']) is not int or not 0 <= value['instances'] <= 1000):
                raise ValueError('Invalid core module reconciliation result')
        finally:
            connection.close()

    def resume_committed(self):
        operation = read(self.base / 'operation.json')
        if operation.get('data_committed') is not True or not isinstance(operation.get('containers'), list):
            raise ValueError('No committed installation is available to resume')
        self.restart_core()
        self.commit_and_resume(operation['containers'])

    def readiness(self):
        state = self.state()
        context = ssl.create_default_context(cafile=str(self.root / 'private/tls.crt'))
        context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        with opener.open(state['config']['public_url'] + '/health/ready', timeout=15) as response:
            if response.status != 200:
                raise ValueError('Core readiness failed after upgrade')

    def wait_readiness(self, timeout=180):
        deadline = time.monotonic() + timeout
        while True:
            try:
                self.readiness()
                return
            except (ValueError, OSError, http.client.HTTPException):
                if time.monotonic() >= deadline:
                    raise ValueError('Core readiness did not return before the HTTPS switch') from None
                time.sleep(1)

    def check_snapshot_capacity(self):
        backup_root = self.root / 'private/upgrade-backups'
        directory(backup_root)
        volumes = self.volumes()
        sources = [Path(v['path']) for v in volumes] + [self.root / name for name in ('modules', 'private', 'config', 'state')]
        total = sum(tree_size(p, exclude={'upgrade-backups', 'delivery'}) for p in sources)
        if shutil.disk_usage(backup_root).free < total + RESERVE:
            raise ValueError('Insufficient free space for the complete installation snapshot')
        return volumes

    def snapshot(self, operation, containers):
        volumes = self.check_snapshot_capacity()
        destination = self.root / 'private/upgrade-backups' / operation['operation_id']
        directory(destination)
        files = {}
        with tarfile.open(destination / 'installation.tar', 'w', format=tarfile.PAX_FORMAT) as tar:
            for name in ('.pl-installation.json', 'config', 'private', 'state', 'modules'):
                add_tree(tar, self.root / name, name, exclude={'private/upgrade-backups', 'state/delivery', 'state/install.lock', 'state/icmp-host.lock', 'modules/controller.lock'})
        (destination / 'installation.tar').chmod(0o600)
        files['installation.tar'] = digest(destination / 'installation.tar')
        for index, volume in enumerate(volumes):
            filename = 'volume-' + str(index) + '.tar'
            with tarfile.open(destination / filename, 'w', format=tarfile.PAX_FORMAT) as tar:
                add_tree(tar, Path(volume['path']), '.')
            (destination / filename).chmod(0o600)
            files[filename] = digest(destination / filename)
            volume['archive'] = filename
        meta = {'schema': 1, 'installation': self.installation, 'operation_id': operation['operation_id'],
                'from_version': operation['from_version'], 'containers': containers, 'volumes': volumes, 'files': files}
        atomic(destination / 'snapshot.json', meta)
        return destination

    def perform_upgrade(self):
        request = read(self.base / 'operation.json')
        changed = False
        try:
            self.operation('downloading')
            destination, manifest = self.stage_core(request)
            state = self.state()
            icmp = self.prepare_icmp(destination, manifest, state['config'])
            model = self.upgraded_model(destination, manifest, state)
            containers = self.inventory()
            self.check_snapshot_capacity()
            self.operation('quiescing', containers=containers)
            self.stop(containers, keep_web=True)
            self.operation('snapshot')
            snapshot = self.snapshot(request, containers)
            self.operation('applying', snapshot=str(snapshot))
            changed = True
            if icmp:
                self.icmp_host('apply')
            if manifest.get('features', {}).get('upgrade_status'):
                atomic(self.root / 'config/nginx.conf', (destination / 'nginx.conf').read_bytes(), mode=0o644)
            atomic(self.root / 'config/compose.json', model)
            state.update(version=manifest['version'], manifest_sha256=digest(destination / 'manifest.json'), phase='upgrading')
            atomic(self.root / 'state/installation.json', state)
            registry = read(self.root / 'private/module-images.json')
            registry['manifest_sha256'] = state['manifest_sha256']
            atomic(self.root / 'private/module-images.json', registry)
            self.operation('verifying_host')
            self.activate_host(manifest['version'])
            self.operation('verifying')
            self.restart_core()
            self.readiness()
            state['phase'] = 'ready'
            atomic(self.root / 'state/installation.json', state)
            self.commit_and_resume(containers)
        except BaseException as error:
            self.record_failure(error)
            if read(self.base / 'operation.json').get('data_committed') is True:
                self.operation('recovery_required', error='Версия установлена. Требуется завершить запуск модулей; новые данные сохранены.')
            elif changed:
                self.rollback()
            else:
                latest = read(self.base / 'operation.json')
                if latest.get('containers'):
                    self.restart(latest['containers'])
                    self.readiness()
                self.operation('failed', error='Обновление не применено. Предыдущая версия и данные сохранены.')

    def rollback(self):
        operation = read(self.base / 'operation.json')
        if operation.get('data_committed') is True:
            raise ValueError('Committed installation data must be resumed, not rolled back')
        path = self.root / 'private/upgrade-backups' / operation['operation_id']
        has_snapshot = (path / 'snapshot.json').exists()
        if operation.get('snapshot') and not has_snapshot:
            raise ValueError('The required complete recovery snapshot is missing')
        module_plan = None
        if operation.get('kind') == 'module_upgrade' and has_snapshot:
            module_plan = operation.get('module_upgrade_plan')
            if (not isinstance(module_plan, dict) or module_plan.get('module_id') != operation.get('module_id')
                    or module_plan.get('snapshot_operation_id') != operation.get('operation_id')
                    or hashlib.sha256(json_bytes(module_plan)).hexdigest() != operation.get('module_upgrade_plan_sha256')):
                raise ValueError('Native module recovery plan integrity differs')
            receipt = operation.get('old_module_receipt')
            if (not isinstance(receipt, dict) or receipt.get('module_id') != operation['module_id']
                    or receipt.get('core_api') != 1 or not isinstance(receipt.get('sha256'), str)
                    or not HEX.fullmatch(receipt['sha256'])):
                raise ValueError('Native module recovery receipt differs')
        self.operation('restoring')
        if has_snapshot:
            meta = read(path / 'snapshot.json')
            if meta.get('installation') != self.installation or meta.get('operation_id') != operation['operation_id']:
                raise ValueError('Recovery snapshot belongs to another installation')
            for name, checksum in meta.get('files', {}).items():
                if not re.fullmatch(r'(?:installation|volume-[0-9]+)\.tar', name) or not HEX.fullmatch(checksum) or digest(path / name) != checksum:
                    raise ValueError('Recovery snapshot integrity mismatch')
            if set(meta.get('files', {})) != {'installation.tar', *[v['archive'] for v in meta['volumes']]}:
                raise ValueError('Incomplete recovery snapshot')
            self.stop(self.inventory(require_core=False), keep_web=operation.get('kind', 'upgrade') in ('upgrade', 'module_upgrade'))
            self.icmp_host('restore')
            actual = {v['name']: v['path'] for v in self.volumes()}
            helper = read(self.root / 'releases' / operation['from_version'] / 'manifest.json')['images']['web']['id']
            for volume in meta['volumes']:
                if actual.get(volume['name']) != volume['path']:
                    raise ValueError('Recovery target volume ownership has changed')
                # The daemon mounts only this volume writable. The host root,
                # Python runtime, trusted code and snapshot are all read-only.
                self.parent.docker('run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
                    '--cap-drop', 'ALL', '--cap-add', 'SYS_CHROOT', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE',
                    '--cap-add', 'FOWNER', '--cap-add', 'FSETID', '--cap-add', 'SETFCAP', '--security-opt', 'no-new-privileges:true',
                    '--mount', 'type=bind,source=/,target=/host,readonly',
                    '--mount', 'type=volume,source=' + volume['name'] + ',target=/host' + volume['path'],
                    '--entrypoint', '/bin/busybox', helper, 'chroot', '/host', '/usr/bin/python3', str(self.package / 'delivery.py'),
                    '--restore-volume', str(path / volume['archive']), '--target', volume['path'], timeout=1800)
            restore_tree(path / 'installation.tar', self.root, preserve={'private/upgrade-backups', 'state/delivery', 'modules/controller.lock', 'state/install.lock', 'state/icmp-host.lock'})
            if operation.get('kind') == 'module_upgrade':
                self.parent.module_upgrade_checkpoint = self.checkpoint_module_upgrade
                self.module_upgrade_helper().rollback(self.parent, module_plan)
                atomic(self.base / ('module-' + operation['module_id'] + '.json'), operation['old_module_receipt'])
            if operation.get('kind') == 'configuration' and operation.get('module_origin_plan'):
                helper = self.installation_settings().origin_helper()
                if helper is None:
                    raise ValueError('Native origin rollback helper is missing')
                helper.rollback(self.parent, operation['module_origin_plan'])
            self.activate_host(operation['from_version'])
            self.operation('resuming', data_committed=True, restored_snapshot=True)
            self.restart_core()
            self.commit_and_resume(meta['containers'])
            return
        elif operation.get('containers'):
            # No complete snapshot means no schema-changing stage was allowed.
            self.icmp_host('restore')
            self.restart(operation['containers'])
        else:
            self.icmp_host('restore')
        self.readiness()
        if not (path / 'snapshot.json').exists():
            self.activate_host(operation['from_version'])
        self.operation('rolled_back', error='Обновление не завершено. Восстановлены предыдущая версия и полный снимок данных.')


def canonical_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('Canonical operation UUID required')
    return value


def tree_size(path, exclude=frozenset()):
    if path.name in exclude:
        return 0
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        return 0
    if stat.S_ISDIR(info.st_mode):
        return sum(tree_size(p, exclude) for p in path.iterdir())
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Special files cannot be included in installation snapshot')
    return info.st_size + 2048


def add_tree(tar, path, name, exclude=frozenset()):
    if name in exclude:
        return
    info = tar.gettarinfo(str(path), arcname=name)
    if not (info.isfile() or info.isdir() or info.issym() or info.islnk()):
        raise ValueError('Special file in installation snapshot')
    for attribute in os.listxattr(path, follow_symlinks=False):
        key = 'PL.xattr.' + base64.b64encode(os.fsencode(attribute)).decode()
        info.pax_headers[key] = base64.b64encode(os.getxattr(path, attribute, follow_symlinks=False)).decode()
    if info.isfile():
        with path.open('rb') as stream:
            tar.addfile(info, stream)
    else:
        tar.addfile(info)
    if info.isdir():
        for child in sorted(path.iterdir()):
            add_tree(tar, child, name.rstrip('/') + '/' + child.name, exclude)


def restore_tree(archive, target, preserve=frozenset()):
    """Restore our verified snapshot without following archive-created symlinks."""
    target = Path(target)
    if target != target.resolve() or not target.is_dir():
        raise ValueError('Unsafe snapshot restoration target')
    with tarfile.open(archive, 'r:') as tar:
        entries = tar.getmembers()
        names = set()
        symlinks = {Path(v.name) for v in entries if v.issym()}
        for member in entries:
            name = Path(member.name)
            if (name.is_absolute() or '..' in name.parts or member.name in names
                    or any(parent in symlinks for parent in name.parents)
                    or not (member.isfile() or member.isdir() or member.issym() or member.islnk())):
                raise ValueError('Unsafe restoration snapshot')
            if member.islnk() and (Path(member.linkname).is_absolute() or '..' in Path(member.linkname).parts):
                raise ValueError('Unsafe snapshot hard link')
            names.add(member.name)
        roots = {v.name.split('/', 1)[0] for v in entries}
        def clear(path, relative):
            if relative in preserve:
                return
            if any(value.startswith(relative + '/') for value in preserve) and path.is_dir() and not path.is_symlink():
                for child in path.iterdir():
                    clear(child, relative + '/' + child.name)
            elif path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
        if '.' in roots:
            for child in target.iterdir():
                clear(child, child.name)
        else:
            for name in roots:
                clear(target / name, name)
        dirs = sorted((v for v in entries if v.isdir()), key=lambda v: len(Path(v.name).parts))
        for member in dirs:
            (target / member.name).mkdir(mode=0o700, parents=True, exist_ok=True)
        for member in entries:
            path = target / member.name
            if member.isfile():
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as out, tar.extractfile(member) as source:
                    shutil.copyfileobj(source, out)
            elif member.islnk():
                source = target / member.linkname
                if source.is_symlink() or not source.is_file():
                    raise ValueError('Snapshot hard-link target unavailable')
                os.link(source, path)
        for member in (v for v in entries if v.issym()):
            (target / member.name).symlink_to(member.linkname)
        for member in reversed(entries):
            path = target / member.name
            os.chown(path, member.uid, member.gid, follow_symlinks=False)
            if not member.issym():
                path.chmod(member.mode)
            attrs = {os.fsdecode(base64.b64decode(k.removeprefix('PL.xattr.'), validate=True)): base64.b64decode(v, validate=True)
                     for k, v in member.pax_headers.items() if k.startswith('PL.xattr.')}
            for attribute in os.listxattr(path, follow_symlinks=False):
                if attribute not in attrs:
                    os.removexattr(path, attribute, follow_symlinks=False)
            for attribute, value in attrs.items():
                os.setxattr(path, attribute, value, follow_symlinks=False)
            os.utime(path, (member.mtime, member.mtime), follow_symlinks=False)


if __name__ == '__main__':
    import argparse
    import sys
    if os.geteuid() != 0:
        raise ValueError('Volume recovery requires root')
    if len(sys.argv) > 1 and sys.argv[1] in ('recover', 'worker'):
        parser = argparse.ArgumentParser(description='Recover one interrupted PL upgrade from its verified snapshot')
        parser.add_argument('action', choices=('recover', 'worker'))
        parser.add_argument('--root', required=True, type=Path)
        parser.add_argument('--operation-id', required=True)
        parser.add_argument('--recover', action='store_true')
        arguments = parser.parse_args()
        canonical_id(arguments.operation_id)
        root = arguments.root
        if root != root.resolve():
            raise ValueError('Canonical installation root required')
        identity = read(root / 'state/controller-supervisor.json')
        if (set(identity) != {'schema', 'version'} or identity['schema'] != 1
                or not isinstance(identity['version'], str) or not VERSION.fullmatch(identity['version'])):
            raise ValueError('Invalid immutable worker trust anchor')
        initial = root / 'releases' / identity['version']
        if os.environ.get('PL_HOST_SUPERVISOR_PACKAGE', str(initial)) != str(initial):
            raise ValueError('Worker trust anchor environment differs')
        installation = read(root / 'state/installation.json')['install_id']
        import types
        validator = Delivery(types.SimpleNamespace(root=root, installation=installation))
        validator.supervisor = initial
        journal = read(validator.base / 'operation.json')
        if journal.get('operation_id') != arguments.operation_id:
            raise ValueError('Operation requires its exact verified worker release')
        validator.validate_worker_entry(journal)
        spec = importlib.util.spec_from_file_location('pl_recovery_controller', Path(__file__).with_name('module-controller.py'))
        controller_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(controller_module)
        controller = controller_module.Controller(root, installation)
        delivery = Delivery(controller)
        delivery.supervisor = initial
        with delivery.worker_admission(), delivery.lifecycle_lock():
            operation = read(delivery.base / 'operation.json')
            if operation.get('operation_id') != arguments.operation_id or operation.get('phase') in ('complete', 'failed', 'rolled_back'):
                raise ValueError('No interrupted upgrade with the requested identity')
            try:
                delivery.run_operation(recovering=arguments.action == 'recover' or arguments.recover)
            except BaseException:
                delivery.operation('recovery_required', error='Операция не завершена. Сохранены снимок и журнал; выполните штатное восстановление установки.')
                raise
        print('PL: finite installation operation finished; inspect its durable status.')
    else:
        parser = argparse.ArgumentParser(description='Finite PL volume restore helper')
        parser.add_argument('--restore-volume', required=True, type=Path)
        parser.add_argument('--target', required=True, type=Path)
        arguments = parser.parse_args()
        restore_tree(arguments.restore_volume, arguments.target)
