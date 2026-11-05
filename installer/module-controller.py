#!/usr/bin/env python3
"""Finite PL module host controller. Root-only, local Unix HTTP, no shell API."""
from __future__ import annotations

import argparse
from contextlib import contextmanager, nullcontext
import base64
import fcntl
import hashlib
import hmac
import http.server
import ipaddress
import io
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socketserver
import stat
import subprocess
import time
import tempfile
import threading
import urllib.request
import urllib.error
import urllib.parse
import uuid
from datetime import datetime, timedelta

IMAGE = 'prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e'
VERSION = '3.15.0'
CONFIG = b'global:\n  scrape_interval: 15s\nscrape_configs:\n  - job_name: prometheus\n    static_configs:\n      - targets: ["127.0.0.1:9090"]\n'
FLAGS = ['--config.file=/etc/prometheus/prometheus.yml', '--storage.tsdb.path=/prometheus',
         '--storage.tsdb.retention.time=15d', '--storage.tsdb.retention.size=512MB',
         '--web.listen-address=0.0.0.0:9090']
READ_LIMIT = 8 * 1024 * 1024
READ_PATHS = {'/', '/query', '/graph', '/alerts', '/rules', '/targets', '/service-discovery',
              '/alertmanager-discovery', '/status', '/tsdb-status', '/flags', '/config',
              '/agent', '/favicon.svg', '/favicon.ico', '/manifest.json', '/-/ready', '/-/healthy',
              '/api/v1/query', '/api/v1/query_range', '/api/v1/query_exemplars',
              '/api/v1/format_query', '/api/v1/parse_query', '/api/v1/series', '/api/v1/labels',
              '/api/v1/targets', '/api/v1/targets/metadata', '/api/v1/metadata', '/api/v1/rules',
              '/api/v1/alerts', '/api/v1/alertmanagers', '/api/v1/notifications', '/api/v1/features',
              '/api/v1/status/buildinfo', '/api/v1/status/runtimeinfo', '/api/v1/status/config',
              '/api/v1/status/flags', '/api/v1/status/tsdb', '/api/v1/status/walreplay'}


def read_request(body):
    if not isinstance(body, dict) or set(body) != {'instance_id', 'path', 'query'}:
        raise ValueError('Invalid module read request')
    identifier(body['instance_id'])
    path, query = body['path'], body['query']
    if (not isinstance(path, str) or not isinstance(query, str) or len(query) > 8192
            or any(ord(c) < 32 or ord(c) == 127 for c in path + query)
            or not (path in READ_PATHS
                    or re.fullmatch(r'/api/v1/label/[A-Za-z_][A-Za-z0-9_]{0,127}/values', path)
                    or re.fullmatch(r'/assets/[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.(?:js|css|woff2?|ttf|svg|png|txt)', path))
            or '..' in path or '%' in path or '\\' in path or '#' in query):
        raise ValueError('Unsupported module read path')
    # Parse before forwarding: do not accept malformed percent escapes or encoded controls.
    if re.search(r'%(?![A-Fa-f0-9]{2})', query):
        raise ValueError('Invalid query encoding')
    values = urllib.parse.parse_qsl(query, keep_blank_values=True, max_num_fields=128, errors='strict')
    if any(any(ord(c) < 32 or ord(c) == 127 for c in k + v) for k, v in values):
        raise ValueError('Invalid query value')
    return body


class ControllerBusy(ValueError):
    """Transient shared-read admission failure, not a lifecycle failure."""


class Conflict(ValueError):
    pass


def identifier(value):
    if not isinstance(value, str):
        raise ValueError('UUID required')
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise ValueError('UUID required') from None
    if str(parsed) != value:
        raise ValueError('Canonical UUID required')
    return value


def configuration(value):
    if not isinstance(value, dict) or set(value) != {'revision', 'global', 'jobs'}:
        raise ValueError('Invalid Prometheus configuration')
    if type(value['revision']) is not int or not 0 <= value['revision'] <= 2**53 - 1:
        raise ValueError('Invalid configuration revision')
    if len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()) > 256 * 1024:
        raise ValueError('Configuration exceeds 256 KiB')
    def duration(text):
        if not isinstance(text, str) or not re.fullmatch(r'[1-9][0-9]{0,7}(?:ms|s|m|h)', text):
            raise ValueError('Invalid scrape duration')
        match = re.fullmatch(r'([0-9]+)(ms|s|m|h)', text)
        seconds = int(match[1]) * {'ms': .001, 's': 1, 'm': 60, 'h': 3600}[match[2]]
        if not 1 <= seconds <= 86400:
            raise ValueError('Scrape duration outside 1s..24h')
        return seconds
    def timing(item):
        if duration(item['scrape_timeout']) > duration(item['scrape_interval']):
            raise ValueError('Scrape timeout exceeds interval')
    glob = value['global']
    if not isinstance(glob, dict) or set(glob) != {'scrape_interval', 'scrape_timeout'}:
        raise ValueError('Invalid global scrape settings')
    timing(glob)
    jobs = value['jobs']
    if not isinstance(jobs, list) or len(jobs) > 64:
        raise ValueError('At most 64 editable jobs are supported')
    names, total = {'prometheus'}, 0
    for job in jobs:
        fields = {'name', 'enabled', 'scrape_interval', 'scrape_timeout', 'metrics_path', 'scheme', 'targets'}
        if not isinstance(job, dict) or set(job) != fields:
            raise ValueError('Invalid static scrape job')
        name = job['name']
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,127}', name) or name in names:
            raise ValueError('Job names must be unique; prometheus is protected')
        names.add(name)
        if type(job['enabled']) is not bool or job['scheme'] not in ('http', 'https'):
            raise ValueError('Invalid job state or scheme')
        timing(job)
        path = job['metrics_path']
        if not isinstance(path, str) or not re.fullmatch(r'/[A-Za-z0-9/_%.~:@!$&()*+,;=-]{0,255}', path):
            raise ValueError('Invalid metrics path')
        targets = job['targets']
        if not isinstance(targets, list) or not targets or len(targets) > 512:
            raise ValueError('Each job requires static targets')
        total += len(targets)
        if total > 512:
            raise ValueError('At most 512 static targets are supported')
        addresses = set()
        for target in targets:
            if not isinstance(target, dict) or set(target) != {'address', 'labels'}:
                raise ValueError('Invalid static target')
            address = target['address']
            if not isinstance(address, str) or len(address) > 256 or address in addresses:
                raise ValueError('Invalid or duplicate target address')
            addresses.add(address)
            match = re.fullmatch(r'(\[[0-9a-fA-F:]+\]|[A-Za-z0-9][A-Za-z0-9.-]*):([0-9]{1,5})', address)
            if not match or not 1 <= int(match[2]) <= 65535:
                raise ValueError('Target requires hostname or IP and port')
            host = match[1]
            if host.startswith('['):
                ipaddress.IPv6Address(host[1:-1])
            elif len(host) > 253 or any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', part) for part in host.rstrip('.').split('.')):
                raise ValueError('Invalid target hostname')
            labels = target['labels']
            if not isinstance(labels, dict) or len(labels) > 32:
                raise ValueError('At most 32 target labels are supported')
            for key, text in labels.items():
                if (not isinstance(key, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', key)
                        or key.startswith('__') or key in ('job', 'instance')
                        or not isinstance(text, str) or len(text.encode('utf-8')) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in text)):
                    raise ValueError('Invalid or reserved target label')
    return value


def render_configuration(value):
    configuration(value)
    # Only fixed keys are emitted; JSON quoted scalars are valid YAML strings.
    quote = lambda text: json.dumps(text, ensure_ascii=True)
    lines = ['global:', '  scrape_interval: ' + quote(value['global']['scrape_interval']),
             '  scrape_timeout: ' + quote(value['global']['scrape_timeout']), 'scrape_configs:',
             '  - job_name: "prometheus"', '    static_configs:',
             '      - targets: ["127.0.0.1:9090"]']
    for job in value['jobs']:
        if not job['enabled']:
            continue
        lines += ['  - job_name: ' + quote(job['name']),
                  '    scrape_interval: ' + quote(job['scrape_interval']),
                  '    scrape_timeout: ' + quote(job['scrape_timeout']),
                  '    metrics_path: ' + quote(job['metrics_path']),
                  '    scheme: ' + quote(job['scheme']), '    static_configs:']
        for target in job['targets']:
            lines.append('      - targets: [' + quote(target['address']) + ']')
            if target['labels']:
                lines.append('        labels:')
                lines.extend('          ' + quote(key) + ': ' + quote(text)
                             for key, text in sorted(target['labels'].items()))
    return ('\n'.join(lines) + '\n').encode()


def operation(body):
    fields = {'operation_id', 'instance_id', 'module_id', 'action'}
    if isinstance(body, dict) and body.get('action') == 'configure':
        fields.add('configuration')
    if (not isinstance(body, dict) or set(body) != fields or body['module_id'] != 'prometheus'
            or body['action'] not in ('install', 'enable', 'disable', 'refresh', 'remove', 'configure')):
        raise ValueError('Unsupported module operation')
    identifier(body['operation_id'])
    identifier(body['instance_id'])
    if body['action'] == 'configure':
        configuration(body['configuration'])
        if body['configuration']['revision'] < 1:
            raise ValueError('Applied configuration requires a positive revision')
    return body


def atomic(path, value, mode=0o600):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError('Unsafe module state')
    tmp = path.with_name(path.name + '.new.' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)  # systemd UMask=0077 must not hide the public config from container UID.
        with os.fdopen(fd, 'wb') as stream:
            stream.write(value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        tmp.unlink(missing_ok=True)


def safe_directory(path):
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise ValueError('Unsafe module directory')
    path.mkdir(mode=0o700, exist_ok=True)
    if path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o022:
        raise ValueError('Unsafe module directory owner or mode')


class Controller:
    def __init__(self, root, installation):
        self.root = Path(root)
        self.installation = installation
        if (self.root != self.root.resolve() or not re.fullmatch(r'pl-[0-9a-f]{12}', installation)):
            raise ValueError('Invalid installation identity')
        self.on_demand = (self.root / 'config/delivery.json').is_file()
        self.image = self.resolve_image()
        self.base = self.root / 'modules'
        safe_directory(self.base)
        self.operations = self.base / 'operations'
        safe_directory(self.operations)
        self.env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
        self._read_routes = {}

    @contextmanager
    def instance_lock(self, instance, exclusive=False):
        path = self.operations / ('read-' + identifier(instance) + '.lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            meta = os.fstat(stream.fileno())
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_mode & 0o7777 != 0o600:
                raise ValueError('Invalid module read lock')
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    @contextmanager
    def operation_lock(self, operation_id):
        # Equal operation IDs always serialize, including refreshes for different
        # instances. A bounded set avoids another permanent file per poll job.
        slot = hashlib.sha256(identifier(operation_id).encode()).digest()[0] % 64
        path = self.operations / ('operation-slot-' + format(slot, '02x') + '.lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o7777 != 0o600:
                raise ValueError('Invalid module operation lock')
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    def resolve_image(self):
        path = self.root / 'private/module-images.json'
        if not path.exists() and not path.is_symlink():
            state = self.root / 'state/installation.json'
            if state.exists() and (state.is_symlink() or json.loads(state.read_text()).get('package_schema') == 2):
                raise ValueError('Bundled module image descriptor is missing')
            # Legacy packages have no bundled optional image descriptor.
            return IMAGE
        parent = path.parent
        if (parent.is_symlink() or parent.stat().st_uid != 0 or parent.stat().st_mode & 0o077
                or path.is_symlink() or not path.is_file() or path.stat().st_uid != 0
                or path.stat().st_mode & 0o777 != 0o600 or path.stat().st_size > 65536):
            raise ValueError('Unsafe module image descriptor')
        value = json.loads(path.read_text())
        required = {'schema', 'installation', 'manifest_sha256'} | (set() if self.on_demand else {'prometheus'})
        if (not isinstance(value, dict) or not required <= set(value) or set(value) - {'schema', 'installation', 'manifest_sha256', 'prometheus', 'xray', 'alertmanager', 'wayline', 'grafana', 'forms', 'doska', 'sftpgo', 'netmap', 'bookstack'}
                or value.get('schema') != 1 or value.get('installation') != self.installation
                or not re.fullmatch(r'[0-9a-f]{64}', value.get('manifest_sha256', ''))):
            raise ValueError('Invalid module image installation identity')
        statepath = self.root / 'state/installation.json'
        if (statepath.parent.is_symlink() or statepath.parent.stat().st_uid != 0
                or statepath.parent.stat().st_mode & 0o022
                or statepath.is_symlink() or not statepath.is_file() or statepath.stat().st_uid != 0
                or statepath.stat().st_mode & 0o077):
            raise ValueError('Unsafe module image installation state')
        state = json.loads(statepath.read_text())
        if state.get('install_id') != self.installation or state.get('manifest_sha256') != value['manifest_sha256']:
            raise ValueError('Module image descriptor does not match installation')
        if 'prometheus' not in value and self.on_demand:
            return None
        image = value['prometheus']
        labels = image.get('labels', {}) if isinstance(image, dict) else {}
        if (not isinstance(image, dict) or set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                or image.get('architecture') not in ('amd64', 'arm64')
                or image.get('recipe') != 'deploy/images/prometheus.Dockerfile'
                or labels.get('pl.module.id') != 'prometheus' or labels.get('pl.module.config.version') != '1'
                or labels.get('org.opencontainers.image.version') != VERSION
                or labels.get('pl.build.go') != '1.27.2' or labels.get('pl.build.x-net') != 'v0.61.0'
                or not re.fullmatch(r'[0-9a-f]{64}', labels.get('pl.source.sha256', ''))):
            raise ValueError('Invalid bundled Prometheus image contract')
        self.image_contract = image
        return image['id']

    def verify_image(self):
        if self.image is None:
            raise ValueError('Prometheus image has not been delivered')
        if self.image == IMAGE:
            self.docker('pull', IMAGE, timeout=180)
            return
        image = json.loads(self.docker('image', 'inspect', self.image))[0]
        contract = self.image_contract
        if (image.get('Id') != self.image or image.get('Os') != 'linux'
                or image.get('Architecture') != contract['architecture']
                or any((image.get('Config', {}).get('Labels') or {}).get(k) != v
                       for k, v in contract['labels'].items())):
            raise ValueError('Bundled Prometheus image identity/provenance mismatch')

    def docker(self, *args, timeout=30):
        try:
            result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *args],
                                    cwd=self.root, env=self.env, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise ValueError('Module engine operation timed out; reconcile the same operation') from None
        if result.returncode:
            raise ValueError('Module engine operation failed; inspect the local engine')
        return result.stdout

    def labels(self, instance):
        return {'pl.installation': self.installation, 'pl.module': 'prometheus', 'pl.instance': instance}

    def name(self, instance):
        return self.installation + '-prometheus-' + instance

    def inspect(self, instance):
        name = self.name(instance)
        found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
        if not found:
            return None
        obj = json.loads(self.docker('container', 'inspect', name))[0]
        if self.image != IMAGE:
            self.verify_image()
            if obj.get('Image') != self.image:
                raise ValueError('Module container image content mismatch')
        labels = obj.get('Config', {}).get('Labels') or {}
        host = obj.get('HostConfig', {})
        config_path = str(self.base / instance / 'config')
        mounts = obj.get('Mounts', [])
        expected_mounts = {('bind', config_path, '/etc/prometheus', False),
                           ('volume', self.name(instance) + '-data', '/prometheus', True)}
        actual_mounts = {(m['Type'], m.get('Name') if m['Type'] == 'volume' else m['Source'],
                          m['Destination'], m['RW']) for m in mounts}
        ports = host.get('PortBindings', {})
        if (any(labels.get(k) != v for k, v in self.labels(instance).items())
                or obj['Config'].get('Image') != self.image or obj['Config'].get('Cmd') != FLAGS
                or obj['Config'].get('User') != '65534:65534'
                or actual_mounts != expected_mounts or not host.get('ReadonlyRootfs')
                or host.get('Privileged') or host.get('NetworkMode') != 'bridge'
                or host.get('Memory') != 768 * 1024**2 or host.get('NanoCpus') != 1_000_000_000
                or host.get('PidsLimit') != 128 or host.get('CapDrop') != ['ALL']
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])
                or set(ports) != {'9090/tcp'} or len(ports['9090/tcp']) != 1
                or ports['9090/tcp'][0].get('HostIp') != '127.0.0.1'):
            raise ValueError('Module container drift or foreign ownership; manual inspection required')
        volume = json.loads(self.docker('volume', 'inspect', self.name(instance) + '-data'))[0]
        if volume.get('Driver') != 'local' or volume.get('Options') or any((volume.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items()):
            raise ValueError('Module data volume has foreign ownership or options')
        return obj

    def configuration_state(self, instance):
        path = self.base / instance / 'configuration.json'
        if not path.exists() and not path.is_symlink():
            return {'current': None, 'pending': None}
        if (path.is_symlink() or not path.is_file() or path.stat().st_uid != os.geteuid()
                or path.stat().st_mode & 0o077):
            raise ValueError('Unsafe managed configuration state')
        state = json.loads(path.read_text())
        if not isinstance(state, dict) or set(state) != {'current', 'pending'}:
            raise ValueError('Invalid managed configuration state')
        if state['current'] is not None:
            configuration(state['current'])
        if state['pending'] is not None:
            pending = state['pending']
            if not isinstance(pending, dict) or set(pending) != {'operation_id', 'configuration'}:
                raise ValueError('Invalid pending configuration state')
            identifier(pending['operation_id'])
            configuration(pending['configuration'])
        return state

    @staticmethod
    def config_bytes(value):
        return CONFIG if value is None else render_configuration(value)

    def config(self, instance, create=True, allow_pending=False):
        base = self.base / instance
        if not create and not (base / 'config/prometheus.yml').is_file():
            raise ValueError('Managed module configuration missing')
        safe_directory(base)
        config = base / 'config'
        safe_directory(config)
        if create:
            config.chmod(0o755)
        state = self.configuration_state(instance)
        if state['pending'] and not allow_pending:
            raise ValueError('Configuration operation interrupted; reconcile its operation ID')
        expected = [self.config_bytes(state['current'])]
        if state['pending']:
            expected.append(self.config_bytes(state['pending']['configuration']))
        path = config / 'prometheus.yml'
        if path.exists() or path.is_symlink():
            if (path.is_symlink() or not path.is_file() or path.stat().st_uid != os.geteuid()
                    or path.stat().st_mode & 0o022 or path.read_bytes() not in expected):
                raise ValueError('Module configuration differs from the managed revision')
        elif create and state['current'] is None and state['pending'] is None:
            atomic(path, CONFIG, 0o644)
        else:
            raise ValueError('Managed module configuration missing')
        return config

    def api_json(self, obj, path):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(self.loopback_endpoint(obj) + path, timeout=4) as response:
            raw = response.read(READ_LIMIT + 1)
            if len(raw) > READ_LIMIT:
                raise ValueError('Module configuration response exceeds limit')
            value = json.loads(raw)
            if value.get('status') != 'success':
                raise ValueError('Prometheus configuration API failed')
            return value['data']

    def reload_configuration(self, obj):
        initial = self.api_json(obj, '/api/v1/status/runtimeinfo')
        # Prometheus runtimeinfo truncates its reload metric to whole seconds.
        # Wait for a distinguishable server second before HUP, keeping the
        # subsequent timestamp-change proof even for back-to-back reloads.
        clock_deadline = time.monotonic() + 2
        while True:
            try:
                previous = initial['lastConfigTime']
                before = datetime.fromisoformat(previous)
                server = datetime.fromisoformat(initial['serverTime'])
                if before.utcoffset() is None or server.utcoffset() is None:
                    raise ValueError()
            except (KeyError, TypeError, ValueError):
                raise ValueError('Prometheus reload clock unavailable') from None
            if server >= before + timedelta(seconds=1):
                break
            if time.monotonic() >= clock_deadline:
                raise ValueError('Prometheus reload clock did not advance')
            time.sleep(.05)
            initial = self.api_json(obj, '/api/v1/status/runtimeinfo')
        self.docker('container', 'kill', '--signal', 'HUP', obj['Id'])
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            state = self.api_json(obj, '/api/v1/status/runtimeinfo')
            if state.get('lastConfigTime') != previous:
                if not state.get('reloadConfigSuccess'):
                    raise ValueError('Prometheus rejected the configuration reload')
                return self.api_json(obj, '/api/v1/status/config')['yaml']
            # A failed reload retains lastConfigTime but sets reloadConfigSuccess false.
            if state.get('reloadConfigSuccess') is False and initial.get('reloadConfigSuccess') is True:
                raise ValueError('Prometheus rejected the configuration reload')
            time.sleep(.2)
        raise ValueError('Prometheus configuration reload was not confirmed')

    def owned_candidate(self, instance):
        config = self.base / instance / 'config'
        marker = self.base / instance / 'candidate.json'
        path = config / 'candidate.yml'
        if not marker.exists() and not marker.is_symlink():
            if path.exists() or path.is_symlink():
                raise ValueError('Unrecognized candidate configuration')
            return False
        if (marker.is_symlink() or not marker.is_file() or marker.stat().st_uid != os.geteuid()
                or marker.stat().st_mode & 0o077):
            raise ValueError('Unsafe candidate configuration ownership')
        expected = render_configuration(json.loads(marker.read_text()))
        if path.exists() or path.is_symlink():
            if (path.is_symlink() or not path.is_file() or path.stat().st_uid != os.geteuid()
                    or path.stat().st_mode & 0o022 or path.read_bytes() != expected):
                raise ValueError('Unrecognized candidate configuration')
        return True

    def check_configuration(self, obj, config, value):
        instance = config.parent.name
        candidate = config / 'candidate.yml'
        marker = config.parent / 'candidate.json'
        data = render_configuration(value)
        if self.owned_candidate(instance):
            candidate.unlink(missing_ok=True)
            marker.unlink()
        atomic(marker, value)
        try:
            atomic(candidate, data, 0o644)
            self.docker('container', 'exec', '--user', '65534:65534', obj['Id'],
                        '/bin/promtool', 'check', 'config', '/etc/prometheus/candidate.yml', timeout=30)
        finally:
            # These two paths were either recognized before mutation or created here.
            candidate.unlink(missing_ok=True)
            marker.unlink(missing_ok=True)
        return data

    def validate_configuration(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id', 'configuration'}:
            raise ValueError('Invalid configuration validation request')
        instance = identifier(body['instance_id'])
        configuration(body['configuration'])
        fd = os.open(self.base / 'controller.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            obj = self.inspect(instance)
            if obj is None or not obj['State'].get('Running'):
                raise ValueError('Enable the managed Prometheus before validating its configuration')
            if self.configuration_state(instance)['pending']:
                raise ValueError('Reconcile the pending configuration operation first')
            data = self.check_configuration(obj, self.config(instance, create=False), body['configuration'])
            return {'instance_id': instance, 'valid': True, 'yaml': data.decode(),
                    'hash': hashlib.sha256(data).hexdigest()}

    def confirm_targets(self, obj, value):
        def seconds(text):
            # Prometheus canonical durations may contain several units (1m30s).
            pieces = re.findall(r'([0-9]+)(ms|s|m|h|d)', text)
            if ''.join(a + b for a, b in pieces) != text:
                raise ValueError('Invalid runtime scrape duration')
            return sum(int(a) * {'ms': .001, 's': 1, 'm': 60, 'h': 3600, 'd': 86400}[b] for a, b in pieces)
        glob = value['global'] if value else {'scrape_interval': '15s', 'scrape_timeout': '10s'}
        expected = [('prometheus', 'http', '127.0.0.1:9090', '/metrics',
                     seconds(glob['scrape_interval']), seconds(glob['scrape_timeout']), {})]
        for job in value['jobs'] if value else []:
            if job['enabled']:
                expected.extend((job['name'], job['scheme'], target['address'], job['metrics_path'],
                                 seconds(job['scrape_interval']), seconds(job['scrape_timeout']), target['labels'])
                                for target in job['targets'])
        deadline = time.monotonic() + 15
        while True:
            active = self.api_json(obj, '/api/v1/targets?state=active').get('activeTargets', [])
            actual = []
            for target in active:
                url = urllib.parse.urlsplit(target['scrapeUrl'])
                labels = dict(target['labels'])
                name = labels.pop('job', None)
                address = labels.pop('instance', None)
                if target.get('scrapePool') != name or url.netloc.lower() != str(address).lower() or url.query or url.fragment:
                    break
                actual.append((name, url.scheme, address, urllib.parse.unquote(url.path), seconds(target['scrapeInterval']),
                               seconds(target['scrapeTimeout']), labels))
            else:
                if (len(actual) == len(expected)
                        and sorted(actual, key=lambda item: (item[0], item[2])) == sorted(expected, key=lambda item: (item[0], item[2]))):
                    return
            if time.monotonic() >= deadline:
                raise ValueError('Prometheus active targets did not match the applied configuration')
            time.sleep(.2)

    def configure(self, body):
        instance, value = body['instance_id'], body['configuration']
        self._read_routes.pop(instance, None)
        obj = self.inspect(instance)
        if obj is None or not obj['State'].get('Running'):
            raise ValueError('Enable the managed Prometheus before applying its configuration')
        config = self.config(instance, create=False, allow_pending=True)
        state = self.configuration_state(instance)
        if state['pending'] and state['pending'] != {'operation_id': body['operation_id'], 'configuration': value}:
            raise Conflict('Another configuration operation requires reconciliation')
        current = state['current']
        revision = current['revision'] if current else 0
        if value['revision'] < revision or (value['revision'] == revision and value != current):
            raise Conflict('Configuration revision has already changed')
        if value == current and not state['pending']:
            return self.configuration_observation(instance)
        try:
            data = self.check_configuration(obj, config, value)
        except (ValueError, OSError, KeyError, TypeError):
            if state['pending']:
                # An earlier attempt may already have switched the live file. Preserve
                # its recovery ownership until that same operation is reconciled.
                raise
            result = self.configuration_observation(instance)
            if result.get('state') != 'running':
                raise ValueError('Candidate validation failed; previous active configuration could not be confirmed') from None
            self.confirm_targets(obj, current)
            result.update(state='error', rolled_back=True,
                          error='Candidate validation failed; the previous configuration remains active')
            return result
        state['pending'] = {'operation_id': body['operation_id'], 'configuration': value}
        state_path = self.base / instance / 'configuration.json'
        atomic(state_path, state)
        try:
            atomic(config / 'prometheus.yml', data, 0o644)
            applied_yaml = self.reload_configuration(obj)
            self.confirm_targets(obj, value)
        except (ValueError, OSError, KeyError, TypeError):
            atomic(config / 'prometheus.yml', self.config_bytes(current), 0o644)
            try:
                self.reload_configuration(obj)
                self.confirm_targets(obj, current)
            except (ValueError, OSError, KeyError, TypeError):
                raise ValueError('Configuration apply and rollback could not be confirmed; reconcile the same operation') from None
            atomic(state_path, {'current': current, 'pending': None})
            result = self.configuration_observation(instance)
            result.update(state='error', rolled_back=True, error='Configuration was not applied; the previous configuration was restored')
            return result
        atomic(state_path, {'current': value, 'pending': None})
        return {**self.configuration_observation(instance), 'configuration_yaml': applied_yaml}

    def configuration_observation(self, instance):
        state = self.configuration_state(instance)
        if state['pending']:
            raise ValueError('Configuration operation interrupted; reconcile its operation ID')
        result = self.observe(instance)
        value = state['current']
        result.update(configuration_revision=value['revision'] if value else 0,
                      configuration_hash=hashlib.sha256(self.config_bytes(value)).hexdigest())
        return result

    def owned_volume(self, instance):
        name = self.name(instance) + '-data'
        found = self.docker('volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found:
            return False
        if found != name:
            raise ValueError('Unexpected module data volume identity')
        meta = json.loads(self.docker('volume', 'inspect', name))[0]
        if (meta.get('Name') != name or meta.get('Driver') != 'local' or meta.get('Options')
                or any((meta.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())):
            raise ValueError('Module data volume has foreign ownership or options')
        return True

    def owned_config(self, instance):
        """Validate the entire finite directory before deletion, without creating or chmodding it."""
        base = self.base / instance
        if not base.exists() and not base.is_symlink():
            return False
        for directory in (base, base / 'config'):
            if not directory.exists() and not directory.is_symlink():
                continue
            if (directory.is_symlink() or not directory.is_dir()
                    or directory.stat().st_uid != os.geteuid() or directory.stat().st_mode & 0o022):
                raise ValueError('Unsafe module configuration ownership')
        if any(p.name not in ('config', 'configuration.json', 'candidate.json') for p in base.iterdir()):
            raise ValueError('Unknown files in module directory; manual inspection required')
        config = base / 'config'
        if config.exists():
            if any(p.name not in ('prometheus.yml', 'candidate.yml') for p in config.iterdir()):
                raise ValueError('Unknown files in module configuration; manual inspection required')
            path = config / 'prometheus.yml'
            if path.exists() or path.is_symlink():
                if (path.is_symlink() or not path.is_file() or path.stat().st_uid != os.geteuid()
                        or path.stat().st_mode & 0o022):
                    raise ValueError('Module configuration differs from the managed revision')
                self.config(instance, create=False, allow_pending=True)
        self.owned_candidate(instance)
        self.configuration_state(instance)
        return True

    def remove(self, instance):
        # Preflight every remaining artifact before the first destructive step. Exact names,
        # labels and finite file layout also make interrupted deletion safe to reconcile.
        obj = self.inspect(instance)
        self.owned_volume(instance)
        self.owned_config(instance)
        if obj:
            identity = obj.get('Id')
            if not isinstance(identity, str) or not re.fullmatch(r'[0-9a-f]{64}', identity):
                raise ValueError('Invalid module container identity')
            if obj['State'].get('Running'):
                self.docker('container', 'stop', '--time', '20', identity, timeout=30)
            self.docker('container', 'rm', identity)
        if self.owned_volume(instance):
            self.docker('volume', 'rm', self.name(instance) + '-data')
        if self.owned_config(instance):
            base = self.base / instance
            config = base / 'config'
            (config / 'prometheus.yml').unlink(missing_ok=True)
            (config / 'candidate.yml').unlink(missing_ok=True)
            (base / 'configuration.json').unlink(missing_ok=True)
            (base / 'candidate.json').unlink(missing_ok=True)
            if config.exists():
                config.rmdir()
            base.rmdir()
            descriptor = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        # Docker success is insufficient: independently confirm all three are gone.
        if self.inspect(instance) is not None or self.owned_volume(instance) or self.owned_config(instance):
            raise ValueError('Module artifacts remain; reconcile removal')

    @staticmethod
    def loopback_endpoint(obj):
        bindings = obj.get('NetworkSettings', {}).get('Ports', {}).get('9090/tcp') or []
        if (len(bindings) != 1 or bindings[0].get('HostIp') != '127.0.0.1'
                or not re.fullmatch(r'[0-9]{1,5}', bindings[0].get('HostPort', ''))
                or not 1 <= int(bindings[0]['HostPort']) <= 65535):
            raise ValueError('Module loopback endpoint unavailable')
        return 'http://127.0.0.1:' + bindings[0]['HostPort']

    def read(self, body):
        read_request(body)
        instance = body['instance_id']
        with self.instance_lock(instance):
            # The instance lock excludes this module's stop/configure/remove.
            # Another module's installation must not deny a verified read.
            route = self._read_routes.get(instance)
            if route is None or time.monotonic() - route[0] >= 30:
                self._read_routes.pop(instance, None)
                obj = self.inspect(instance)
                if obj is None or not obj['State'].get('Running'):
                    raise ValueError('Managed module is not running')
                self.config(instance, create=False)
                route = (time.monotonic(), self.loopback_endpoint(obj))
                self._read_routes[instance] = route
            address = route[1] + body['path']
            if body['query']:
                address += '?' + body['query']
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            try:
                response = opener.open(urllib.request.Request(address, method='GET'), timeout=12)
            except urllib.error.HTTPError as error:
                # Preserve finite upstream HTTP errors; never follow redirects or return cookies.
                response = error
            except (ValueError, OSError):
                self._read_routes.pop(instance, None)
                raise
            try:
                with response:
                    if not 200 <= response.status < 300 and not 400 <= response.status < 600:
                        raise ValueError('Module redirects refused')
                    data = response.read(READ_LIMIT + 1)
                    if len(data) > READ_LIMIT:
                        raise ValueError('Module response exceeded limit')
                    content_type = response.headers.get('Content-Type', 'application/octet-stream')
                    if len(content_type) > 256 or any(ord(c) < 32 for c in content_type):
                        raise ValueError('Invalid module content type')
                    return {'instance_id': instance, 'status': response.status,
                            'content_type': content_type, 'body': base64.b64encode(data).decode('ascii')}
            except (ValueError, OSError):
                self._read_routes.pop(instance, None)
                raise

    def preflight(self):
        info = json.loads(self.docker('info', '--format', '{{json .DockerRootDir}}'))
        docker_root = Path(info)
        if not docker_root.is_absolute() or docker_root != docker_root.resolve() or not docker_root.is_dir():
            raise ValueError('Local Docker data root unavailable')
        if any(shutil.disk_usage(p).free < 1024**3 for p in (self.base, docker_root)):
            raise ValueError('Prometheus requires 1 GiB free on module and Docker filesystems')
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        if int(memory.get('MemAvailable', '0 kB').split()[0]) < 256 * 1024:
            raise ValueError('Prometheus requires at least 256 MiB available host memory')

    def ensure(self, instance):
        obj = self.inspect(instance)
        if obj:
            self.config(instance, create=False)
            if not obj['State'].get('Running'):
                self.preflight()
                self.docker('container', 'start', self.name(instance))
            return
        self.preflight()
        config = self.config(instance)
        volume = self.name(instance) + '-data'
        found = self.docker('volume', 'ls', '--filter', 'name=^' + volume + '$', '--format', '{{.Name}}').decode().strip()
        if not found:
            args = ['volume', 'create']
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, volume)
        meta = json.loads(self.docker('volume', 'inspect', volume))[0]
        if meta.get('Driver') != 'local' or meta.get('Options') or any((meta.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items()):
            raise ValueError('Module data volume has foreign ownership or options')
        # Pull only the descriptor's immutable image. No user-provided image or command.
        self.verify_image()
        args = ['container', 'create', '--name', self.name(instance), '--network', 'bridge',
                '--restart', 'unless-stopped', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--user', '65534:65534',
                '--memory', '768m', '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
                '--publish', '127.0.0.1::9090', '--mount', 'type=bind,source=' + str(config) + ',target=/etc/prometheus,readonly',
                '--mount', 'type=volume,source=' + volume + ',target=/prometheus']
        for key, value in self.labels(instance).items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.image, *FLAGS)
        self.inspect(instance)  # Refuse starting a drifted container.
        self.docker('container', 'start', self.name(instance))

    def observe(self, instance):
        self._read_routes.pop(instance, None)
        result = {'state': 'absent', 'version': '', 'targets_up': 0, 'targets_total': 0, 'error': ''}
        obj = self.inspect(instance)
        if obj is None:
            if self.owned_volume(instance) or self.owned_config(instance):
                raise ValueError('Module container absent but managed artifacts remain')
            return result
        self.config(instance, create=False)  # Detect configuration edits before reporting managed health.
        if not obj['State'].get('Running'):
            result['state'] = 'disabled'
            return result
        endpoint = self.loopback_endpoint(obj)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        def read(path, json_body=True):
            with opener.open(endpoint + path, timeout=4) as response:
                body = response.read(2 * 1024 * 1024 + 1)
                if len(body) > 2 * 1024 * 1024:
                    raise ValueError('Module response exceeded limit')
                return json.loads(body) if json_body else body
        try:
            read('/-/ready', False)
            build = read('/api/v1/status/buildinfo')
            targets = read('/api/v1/targets?state=active')
            if build.get('status') != 'success' or build.get('data', {}).get('version') != VERSION or targets.get('status') != 'success':
                raise ValueError('Module API version or envelope mismatch')
            active = targets['data']['activeTargets']
            result.update(state='running', version=VERSION, endpoint=endpoint,
                          targets_up=sum(t.get('health') == 'up' for t in active), targets_total=len(active))
            self._read_routes[instance] = (time.monotonic(), endpoint)
        except (OSError, ValueError, KeyError, TypeError):
            result.update(state='error', error='Prometheus readiness or API validation failed')
        return result

    def xray(self):
        if not hasattr(self, '_xray_controller'):
            path = Path(__file__).with_name('xray-controller.py')
            if path.is_symlink() or not path.is_file():
                raise ValueError('Xray controller is unavailable in this package')
            spec = importlib.util.spec_from_file_location('pl_xray_controller', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self._xray_controller = module.XrayController(self)
        return self._xray_controller

    def host_status(self, body):
        if body != {}:
            raise ValueError('Host diagnostic arguments are not supported')
        memory = {}
        with open('/proc/meminfo', encoding='ascii') as stream:
            for line in stream.read(65536).splitlines():
                fields = line.split()
                if fields and fields[0] in ('MemTotal:', 'MemAvailable:') and len(fields) == 3 and fields[2] == 'kB':
                    memory[fields[0].rstrip(':')] = int(fields[1]) * 1024
        if set(memory) != {'MemTotal', 'MemAvailable'}:
            raise ValueError('Host memory data unavailable')
        with open('/proc/uptime', encoding='ascii') as stream:
            uptime = float(stream.read(128).split()[0])
        storage = shutil.disk_usage(self.root)
        return {'schema': 1, 'installation': self.installation, 'hostname': os.uname().nodename,
                'kernel': os.uname().release, 'cpus': os.cpu_count() or 1,
                'load_average': list(os.getloadavg()), 'uptime_seconds': uptime,
                'memory': {'total_bytes': memory['MemTotal'], 'available_bytes': memory['MemAvailable']},
                'storage': {'total_bytes': storage.total, 'used_bytes': storage.used, 'free_bytes': storage.free},
                'observed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}

    def grafana(self):
        if not hasattr(self, '_grafana_controller'):
            path = Path(__file__).with_name('grafana-controller.py')
            if path.is_symlink() or not path.is_file():
                raise ValueError('Grafana controller is unavailable in this package')
            spec = importlib.util.spec_from_file_location('pl_grafana_controller', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self._grafana_controller = module.GrafanaController(self)
        return self._grafana_controller

    def application(self, kind):
        if kind not in ('forms', 'doska', 'sftpgo', 'netmap', 'bookstack'):
            raise ValueError('Unsupported application module')
        attribute = '_' + kind + '_controller'
        if not hasattr(self, attribute):
            path = Path(__file__).with_name(kind + '-controller.py')
            if path.is_symlink() or not path.is_file():
                raise ValueError('Application controller unavailable')
            spec = importlib.util.spec_from_file_location('pl_' + kind + '_controller', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            setattr(self, attribute, getattr(module, {'sftpgo': 'SFTPGoController', 'netmap': 'NetMapController', 'bookstack': 'BookStackController'}.get(kind, kind.title() + 'Controller'))(self))
        return getattr(self, attribute)

    def wayline(self):
        if not hasattr(self, '_wayline_controller'):
            path = Path(__file__).with_name('wayline-controller.py')
            if path.is_symlink() or not path.is_file():
                raise ValueError('Wayline controller is unavailable in this package')
            spec = importlib.util.spec_from_file_location('pl_wayline_controller', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self._wayline_controller = module.WaylineController(self)
        return self._wayline_controller

    def alertmanager(self):
        if not hasattr(self, '_alertmanager_controller'):
            path = Path(__file__).with_name('alertmanager-controller.py')
            if path.is_symlink() or not path.is_file():
                raise ValueError('Trusted Alertmanager controller is unavailable')
            spec = importlib.util.spec_from_file_location('pl_alertmanager_controller', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self._alertmanager_controller = module.AlertmanagerController(self)
        return self._alertmanager_controller

    def delivery(self):
        if not self.on_demand:
            raise ValueError('Signed delivery is unavailable in this installation')
        if not hasattr(self, '_delivery'):
            path = Path(__file__).with_name('delivery.py')
            if path.is_symlink() or not path.is_file():
                raise ValueError('Trusted delivery controller is unavailable')
            spec = importlib.util.spec_from_file_location('pl_release_delivery', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self._delivery = module.Delivery(self)
        return self._delivery

    def delivery_guard(self):
        return self.delivery().rpc_guard() if self.on_demand else nullcontext()

    def execute(self, body):
        if self.on_demand:
            if isinstance(body, dict) and body.get('action') in ('install', 'enable'):
                identifier(body.get('operation_id'))
                identifier(body.get('instance_id'))
                if set(body) - {'operation_id', 'instance_id', 'module_id', 'action', 'public_url', 'prometheus_instance_id'}:
                    raise ValueError('Unsupported module installation parameters')
                if self.delivery().ensure_module(body.get('module_id')):
                    self.image = self.resolve_image()
                    # Other modules retain their verified routes while this one
                    # is delivered. Replacing every controller forced unrelated
                    # browser requests back through cold Docker validation.
                    name = '_' + body['module_id'] + '_controller'
                    if hasattr(self, name):
                        delattr(self, name)
            with self.delivery_guard():
                return self._execute(body)
        return self._execute(body)

    def _execute(self, body):
        if isinstance(body, dict) and body.get('module_id') in ('forms', 'doska', 'sftpgo', 'netmap', 'bookstack'):
            return self.application(body['module_id']).execute(body)
        if isinstance(body, dict) and body.get('module_id') == 'xray':
            return self.xray().execute(body)
        if isinstance(body, dict) and body.get('module_id') == 'grafana':
            return self.grafana().execute(body)
        if isinstance(body, dict) and body.get('module_id') == 'wayline':
            return self.wayline().execute(body)
        if isinstance(body, dict) and body.get('module_id') == 'alertmanager':
            return self.alertmanager().execute(body)
        operation(body)
        lock_path = self.base / 'controller.lock'
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as lock, self.operation_lock(body['operation_id']), self.instance_lock(body['instance_id'], exclusive=body['action'] != 'refresh'):
            if body['action'] != 'refresh':
                fcntl.flock(lock, fcntl.LOCK_EX)
            self._read_routes.pop(body['instance_id'], None)
            path = self.operations / (body['operation_id'] + '.json')
            fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            if path.exists():
                if path.is_symlink() or json.loads(path.read_text()).get('fingerprint') != fingerprint:
                    raise Conflict('Operation ID already used for another request')
                # Observe current state after a completed request. Repeating install after a later
                # disable must never restart it. Interrupted operations resume finite idempotent steps.
                if json.loads(path.read_text()).get('phase') == 'complete':
                    if body['action'] == 'configure':
                        return json.loads(path.read_text())['result']
                    try:
                        return {**self.observe(body['instance_id']), 'operation_id': body['operation_id']}
                    except (ValueError, OSError, KeyError, TypeError) as error:
                        return self.failed(body['operation_id'], error)
            atomic(path, {'fingerprint': fingerprint, 'phase': 'running', 'request': body})
            try:
                if body['action'] in ('install', 'enable'):
                    self.ensure(body['instance_id'])
                elif body['action'] == 'disable':
                    obj = self.inspect(body['instance_id'])
                    if obj and obj['State'].get('Running'):
                        self.docker('container', 'stop', '--time', '20', self.name(body['instance_id']), timeout=30)
                elif body['action'] == 'remove':
                    self.remove(body['instance_id'])
                if body['action'] == 'configure':
                    result = self.configure(body)
                else:
                    result = self.observe(body['instance_id'])
                if body['action'] in ('install', 'enable'):
                    deadline = time.monotonic() + 45
                    while result['state'] == 'error' and time.monotonic() < deadline:
                        time.sleep(1)
                        result = self.observe(body['instance_id'])
                result['operation_id'] = body['operation_id']
                atomic(path, {'fingerprint': fingerprint, 'phase': 'complete', 'request': body, 'result': result})
                return result
            except (ValueError, OSError, KeyError, TypeError) as error:
                # Keep phase running: same-ID reconciliation retries finite owned operations.
                self._read_routes.pop(body['instance_id'], None)
                return self.failed(body['operation_id'], error)

    @staticmethod
    def failed(operation_id, error):
        message = str(error) if isinstance(error, ValueError) else 'Module host operation failed'
        return {'state': 'error', 'version': '', 'targets_up': 0, 'targets_total': 0,
                'error': message, 'operation_id': operation_id}

    def get(self, instance):
        identifier(instance)
        for kind in ('forms', 'doska', 'sftpgo', 'netmap', 'bookstack'):
            path = self.base / kind / 'instances' / instance
            if path.exists() or path.is_symlink():
                return self.application(kind).get(instance)
        grafana_path = self.base / 'grafana/instances' / instance
        if grafana_path.exists() or grafana_path.is_symlink():
            return self.grafana().get(instance)
        wayline_path = self.base / 'wayline/instances' / instance
        if wayline_path.exists() or wayline_path.is_symlink():
            return self.wayline().get(instance)
        am_path = self.base / 'alertmanager/instances' / instance
        if am_path.exists() or am_path.is_symlink():
            return self.alertmanager().get(instance)
        xray_path = self.base / 'xray/instances' / instance
        if xray_path.exists() or xray_path.is_symlink():
            return self.xray().get(instance)

        # Keep the root-private lock-file ownership/symlink check, without
        # waiting for another instance's lifecycle writer.
        fd = os.open(self.base / 'controller.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a'), self.instance_lock(instance):
            try:
                return self.observe(instance)
            except (ValueError, OSError, KeyError, TypeError) as error:
                result = self.failed('', error)
                del result['operation_id']
                return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, url):
        raise ValueError('Module redirects refused')


def authenticated(key, headers, method, path, body, now=None):
    timestamp = headers.get('X-PL-Timestamp', '')
    signature = headers.get('X-PL-Signature', '')
    if not re.fullmatch(r'[0-9]{1,12}', timestamp) or abs((time.time() if now is None else now) - int(timestamp)) > 60:
        return False
    if not re.fullmatch(r'[0-9a-f]{64}', signature):
        return False
    payload = timestamp.encode() + b'\n' + method.encode() + b'\n' + path.encode() + b'\n' + body
    return hmac.compare_digest(signature, hmac.new(key, payload, hashlib.sha256).hexdigest())


# One in-flight native stream bounds host-side spooling and the simultaneous
# native destination write. flock also excludes a second controller process.
_application_transfer_slot = threading.BoundedSemaphore(1)
TRANSFER_RESERVE = 256 * 1024 * 1024
# Match the gateway's separate asset, SSE and ordinary request lanes.
# Empty signed requests reserve no upload disk budget and cannot monopolize it.
_doska_empty_events = threading.BoundedSemaphore(32)
_doska_empty_requests = threading.BoundedSemaphore(4)
_doska_empty_assets = threading.BoundedSemaphore(8)


@contextmanager
def doska_empty_input(metadata):
    if not hmac.compare_digest(metadata['body_sha256'], hashlib.sha256(b'').hexdigest()):
        raise ValueError('Transport body digest mismatch')
    events = (metadata.get('role') == 'api' and metadata.get('method') == 'GET'
              and metadata.get('path') == '/api/doska/events'
              and metadata.get('query') == '' and metadata.get('content_type') == '')
    assets = (metadata.get('role') == 'web' and metadata.get('method') in ('GET', 'HEAD')
              and metadata.get('query') == '' and metadata.get('content_type') == '')
    slot = _doska_empty_events if events else _doska_empty_assets if assets else _doska_empty_requests
    if not slot.acquire(blocking=False):
        raise TransferRefused(429)
    try:
        with io.BytesIO() as empty:
            yield empty
    finally:
        slot.release()


class TransferRefused(ValueError):
    def __init__(self, status):
        self.status = status
        super().__init__('Native transfer resource admission refused')


def single_headers(headers, names):
    for name in names:
        values = headers.get_all(name, []) if hasattr(headers, 'get_all') else ([headers[name]] if name in headers else [])
        if len(values) != 1:
            raise ValueError('Missing or duplicate transport header')


@contextmanager
def application_spool(controller, length, kind, action):
    if not _application_transfer_slot.acquire(blocking=False):
        raise TransferRefused(429)
    fd = None
    try:
        root = Path(controller.root)
        spool_root = root / 'modules' / 'transfers'
        safe_directory(root / 'modules')
        safe_directory(spool_root)
        if spool_root.stat().st_mode & 0o777 != 0o700:
            raise ValueError('Unsafe native transfer spool permissions')
        fd = os.open(spool_root / 'admission.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600:
            raise ValueError('Unsafe native transfer admission lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TransferRefused(429) from None
        required = length + TRANSFER_RESERVE
        if kind == 'sftpgo' and action == 'file-upload':
            docker_root = Path(json.loads(controller.docker('info', '--format', '{{json .DockerRootDir}}')))
            if not docker_root.is_absolute() or docker_root != docker_root.resolve() or not docker_root.is_dir():
                raise ValueError('Local Docker data root unavailable')
            if docker_root.stat().st_dev == spool_root.stat().st_dev:
                required += length
            elif shutil.disk_usage(docker_root).free < length + TRANSFER_RESERVE:
                raise TransferRefused(503)
        if shutil.disk_usage(spool_root).free < required:
            raise TransferRefused(503)
        # This directory is persistent host storage, inside service ReadWritePaths;
        # /tmp may be tmpfs and must never receive a 1 GiB upload.
        with tempfile.TemporaryFile(dir=spool_root) as spool:
            yield spool
    finally:
        if fd is not None:
            os.close(fd)
        _application_transfer_slot.release()


class Handler(http.server.BaseHTTPRequestHandler):
    def send_response(self, code, message=None):
        self._response_started = True
        return super().send_response(code, message)
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass  # No request bodies, credentials, endpoints or server internals in stdout.

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        # A lifecycle install has its own guard after lazy artifact delivery;
        # native streams may outlive the request that stops the core API. They
        # are rejected while an upgrade is active and closed by quiescence.
        if (self.path.startswith(('/v1/delivery/', '/v1/installation/')) or self.path == '/v1/operations'
                or self.path in ('/v1/doska/transport', '/v1/sftpgo/stream')):
            self._handle_request()
            return
        try:
            guard = self.server.controller.delivery_guard() if getattr(self.server.controller, 'on_demand', False) is True else nullcontext()
            with guard:
                self._handle_request()
        except ValueError:
            self.reply(503, {'error': 'Installation update is active; retry after recovery'})

    def _handle_request(self):
        self._response_started = False
        try:
            if self.command == 'POST' and self.path in ('/v1/doska/transport', '/v1/sftpgo/stream'):
                if getattr(self.server.controller, 'on_demand', False) is True:
                    self.server.controller.delivery().require_idle()
                if self.path == '/v1/doska/transport':
                    self.handle_doska_transport()
                else:
                    self.handle_application_stream('sftpgo', 1024**3)
                return
            single_headers(self.headers, ('X-PL-Timestamp', 'X-PL-Signature'))
            if self.command == 'POST' or self.headers.get('Content-Length') is not None:
                single_headers(self.headers, ('Content-Length',))
            if self.headers.get('Transfer-Encoding'):
                raise ValueError('Transfer encoding refused')
            length = int(self.headers.get('Content-Length', '0'))
            # Forms embeds up to 3 MiB in base64 plus signed JSON metadata.
            limit = (96 * 1024 if self.command == 'POST' and self.path.startswith('/v1/delivery/proxy/') else
                     384 * 1024 if self.command == 'POST' and self.path == '/v1/installation/configure' else
                     5 * 1024 * 1024 if self.command == 'POST' and self.path == '/v1/forms/request' else
                     24 * 1024 * 1024 if self.command == 'POST' and self.path == '/v1/netmap/request' else 1024 * 1024)
            if not 0 <= length <= limit:
                raise ValueError('Request exceeds limit')
            raw = self.rfile.read(length)
            if len(raw) != length or not authenticated(self.server.key, self.headers, self.command, self.path, raw):
                self.reply(403, {'error': 'Controller authentication refused'})
                return
            if self.command == 'POST' and self.path in ('/v1/delivery/proxy/status', '/v1/delivery/proxy/configure', '/v1/delivery/proxy/test'):
                result = getattr(self.server.controller.delivery().github_proxy(), self.path.rsplit('/', 1)[1])(json.loads(raw))
            elif self.command == 'POST' and self.path in ('/v1/delivery/status', '/v1/delivery/check', '/v1/delivery/upgrade', '/v1/delivery/recover'):
                result = getattr(self.server.controller.delivery(), self.path.rsplit('/', 1)[1])(json.loads(raw))
            elif self.command == 'POST' and self.path in ('/v1/installation/status', '/v1/installation/configure'):
                result = getattr(self.server.controller.delivery().installation_settings(), self.path.rsplit('/', 1)[1])(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/host/status':
                result = self.server.controller.host_status(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/sftpgo/request':
                result = self.server.controller.application('sftpgo').request(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/netmap/request':
                result = self.server.controller.application('netmap').request(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/native/initial-login':
                payload = json.loads(raw)
                if (not isinstance(payload, dict) or set(payload) != {'instance_id', 'module_id', 'service'}
                        or payload.get('module_id') not in ('netmap', 'bookstack', 'grafana')):
                    raise ValueError('Invalid native initial login request')
                native = (self.server.controller.grafana() if payload['module_id'] == 'grafana'
                          else self.server.controller.application(payload['module_id']))
                result = native.initial_login(payload)
            elif self.command == 'POST' and self.path == '/v1/forms/request':
                result = self.server.controller.application('forms').request(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/doska/manifest':
                result = self.server.controller.application('doska').manifest(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/operations':
                result = self.server.controller.execute(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/grafana/request':
                result = self.server.controller.grafana().request(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/wayline/request':
                result = self.server.controller.wayline().request(json.loads(raw))
            elif self.command == 'POST' and self.path in ('/v1/xray/prepare', '/v1/xray/validate', '/v1/xray/status'):
                action = self.path.rsplit('/', 1)[1]
                result = getattr(self.server.controller.xray(), action)(json.loads(raw))
            elif self.command == 'POST' and self.path in ('/v1/alertmanager/prepare', '/v1/alertmanager/validate', '/v1/alertmanager/status', '/v1/alertmanager/read', '/v1/alertmanager/preview', '/v1/alertmanager/test-notification'):
                action = self.path.rsplit('/', 1)[1].replace('-', '_')
                result = getattr(self.server.controller.alertmanager(), action)(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/configuration/validate':
                result = self.server.controller.validate_configuration(json.loads(raw))
            elif self.command == 'POST' and self.path == '/v1/read':
                result = self.server.controller.read(json.loads(raw))
            elif self.command == 'GET' and self.path.startswith('/v1/instances/') and not raw:
                result = self.server.controller.get(self.path[len('/v1/instances/'):])
            else:
                self.reply(404, {'error': 'Unknown controller operation'})
                return
            self.reply(200, result)
        except Conflict as error:
            if self._response_started:
                self.close_connection = True
                return
            self.reply(409, {'error': str(error)})
        except (ValueError, OSError, KeyError, TypeError) as error:
            if self._response_started:
                self.close_connection = True
                return
            if self.path in ('/v1/sftpgo/stream', '/v1/doska/transport'):
                self.close_connection = True
            if self.path == '/v1/sftpgo/stream' and getattr(error, 'status', None) in (400, 401, 403, 404, 409, 429, 503):
                self.reply(error.status, {'error': {'code': 'sftpgo_operation_failed', 'message': 'Операция файлового сервера не выполнена'}})
                return
            if self.path == '/v1/read' and isinstance(error, ControllerBusy):
                self.reply(503, {'error': {'code': 'controller_busy', 'message': 'Module controller busy; retry the read'}})
                return
            result = {'state': 'error', 'error': 'Controller operation failed; reconcile or inspect host state'}
            code = getattr(error, 'public_code', None)
            if self.path.startswith('/v1/delivery/proxy/') and code in {
                    'delivery_proxy_invalid', 'delivery_proxy_conflict', 'delivery_proxy_busy', 'delivery_proxy_unavailable',
                    'delivery_proxy_auth', 'delivery_proxy_tls', 'delivery_proxy_timeout', 'delivery_proxy_catalog'}:
                self.reply(getattr(error, 'status', 400), {'error': {'code': code, 'message': error.public_message}})
                return
            if self.path.startswith('/v1/installation/') and code in {
                    'installation_invalid', 'installation_conflict', 'installation_origin_modules', 'installation_tls_modules'}:
                self.reply(getattr(error, 'status', 400), {'error': {'code': code, 'message': error.public_message}})
                return
            if self.path.startswith('/v1/xray/') and code in {
                    'xray_invalid_outbound', 'xray_unsupported_outbound_parameters', 'xray_unsupported_transport',
                    'xray_host_addresses_unavailable', 'xray_invalid_bind_address',
                    'xray_port_in_use', 'xray_bind_unavailable'}:
                result['code'] = code
            self.reply(400, result)

    def handle_doska_transport(self):
        return self.handle_application_stream('doska', 26 * 1024 * 1024)

    def handle_application_stream(self, kind, limit):
        single_headers(self.headers, ('Content-Length', 'Content-Type', 'X-PL-Transport-Meta', 'X-PL-Timestamp', 'X-PL-Signature'))
        if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type') != 'application/octet-stream':
            raise ValueError('Invalid transport framing')
        encoded = self.headers.get('X-PL-Transport-Meta', '')
        if not encoded or len(encoded) > 65536:
            raise ValueError('Invalid transport metadata')
        raw = base64.b64decode(encoded, validate=True)
        if not authenticated(self.server.key, self.headers, 'POST', self.path, raw):
            self.reply(403, {'error': 'Controller authentication refused'})
            return
        metadata = json.loads(raw)
        raw_length = self.headers.get('Content-Length', '')
        if not re.fullmatch(r'0|[1-9][0-9]{0,10}', raw_length):
            raise ValueError('Invalid transport content length')
        length = int(raw_length)
        if not isinstance(metadata, dict) or type(metadata.get('body_length')) is not int or metadata['body_length'] != length or not 0 <= length <= limit:
            raise ValueError('Invalid transport body length')
        expected = metadata.get('body_sha256', '')
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ValueError('Invalid transport body digest')
        admission = (doska_empty_input(metadata) if kind == 'doska' and length == 0 else
                     application_spool(self.server.controller, length, kind, metadata.get('action')))
        with admission as spool:
            remaining, checksum = length, hashlib.sha256()
            deadline = time.monotonic() + 300
            while remaining:
                if time.monotonic() > deadline:
                    raise TransferRefused(503)
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    raise ValueError('Incomplete transport body')
                checksum.update(chunk)
                spool.write(chunk)
                remaining -= len(chunk)
            if not hmac.compare_digest(checksum.hexdigest(), expected):
                raise ValueError('Transport body digest mismatch')
            spool.seek(0)
            controller = self.server.controller.application(kind)
            if kind == 'doska':
                controller.transport(metadata, spool, self)
            else:
                controller.stream(metadata, spool, self)

    def reply(self, status, result):
        body = json.dumps(result).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    # A scheduler pause must not overflow the legacy five-connection default
    # before the independent 4/8/32 native lanes can apply their own admission.
    request_queue_size = 128
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or args.root != args.root.resolve():
        raise ValueError('Controller requires a managed root and root identity')
    marker = json.loads((args.root / '.pl-installation.json').read_text())
    state = json.loads((args.root / 'state/installation.json').read_text())
    if marker.get('product') not in ("PL", "Pl") or state.get('product') not in ("PL", "Pl"):
        raise ValueError('Managed PL installation required')
    controller = Controller(args.root, state['install_id'])
    key_path = args.root / 'private/module-controller-key'
    key_stat = key_path.lstat()
    if key_path.is_symlink() or not key_path.is_file() or key_stat.st_uid != 0 or key_stat.st_mode & 0o777 != 0o640 or key_stat.st_gid != marker['gid']:
        raise ValueError('Unsafe controller key owner or permissions')
    key = key_path.read_bytes()
    if len(key) != 32:
        raise ValueError('Invalid controller key')
    runtime = args.root / 'run/module-controller'
    path = runtime / 'control.sock'
    if path.exists() or path.is_symlink():
        if not path.is_socket() or path.is_symlink():
            raise ValueError('Unsafe controller socket')
        path.unlink()
    with Server(str(path), Handler) as server:
        os.chown(path, 0, marker['gid'])
        path.chmod(0o660)
        server.controller, server.key = controller, key
        server.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    main()
