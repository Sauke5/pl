#!/usr/bin/env python3
"""Finite local Alertmanager lifecycle and root-private immutable notification plans."""
from __future__ import annotations
import base64
import copy
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import ssl
import time
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager

# Shared file primitives only. This does not construct or inherit XrayController.
_helper_path = Path(__file__).with_name('xray-controller.py')
if _helper_path.is_symlink() or not _helper_path.is_file():
    raise ValueError('Trusted module file primitives are unavailable')
_spec = importlib.util.spec_from_file_location('pl_alertmanager_file_primitives', _helper_path)
_helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helpers)
identifier, encoded, directory = _helpers.identifier, _helpers.encoded, _helpers.directory
read_file, atomic, fsync_directory, text = _helpers.read_file, _helpers.atomic, _helpers.fsync_directory, _helpers.text

BINARY = '/bin/alertmanager'
FLAGS = ['--config.file=/etc/alertmanager/config.json', '--storage.path=/alertmanager',
         '--web.listen-address=0.0.0.0:9093', '--cluster.listen-address=', '--data.retention=120h']


def default_public():
    return {'revision': 0, 'ref': '', 'route': {'receiver': '', 'group_wait': '30s', 'group_interval': '5m', 'repeat_interval': '4h'}, 'receivers': []}


def duration(value, zero=False):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]{0,6})(s|m|h)', value):
        raise ValueError('Invalid Alertmanager duration')
    seconds = int(value[:-1]) * {'s': 1, 'm': 60, 'h': 3600}[value[-1]]
    if not (0 if zero else 1) <= seconds <= 168 * 3600:
        raise ValueError('Alertmanager duration exceeds supported bounds')
    return seconds


def endpoint(value):
    text(value, 8192)
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValueError('Invalid HTTPS notification endpoint') from None
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.fragment or port == 0 or any(ord(c) <= 32 or ord(c) == 127 for c in value)):
        raise ValueError('Notifications require an HTTPS endpoint without embedded credentials')
    return value


def proxy_profile(value, previous):
    fields = {'mode', 'url', 'username', 'password_set', 'no_proxy', 'ca_set', 'password', 'ca_pem', 'clear_ca'}
    if not isinstance(value, dict) or set(value) - fields or value.get('mode') not in ('direct', 'http'):
        raise ValueError('Invalid notification proxy fields')
    mode, url, username = value['mode'], value.get('url', ''), value.get('username', '')
    password, ca = value.get('password', ''), value.get('ca_pem', '')
    for item, size in ((url, 8192), (username, 128), (password, 1024)):
        text(item, size, empty=True)
    if not isinstance(ca, str) or len(ca.encode()) > 64 * 1024:
        raise ValueError('Invalid notification CA')
    if ':' in username:
        raise ValueError('Invalid proxy authentication username')
    bypass = value.get('no_proxy', [])
    if not isinstance(bypass, list) or len(bypass) > 128:
        raise ValueError('Invalid proxy exclusions')
    for item in bypass:
        text(item, 253)
        if '/' in item:
            if str(ipaddress.ip_network(item, strict=True)) != item:
                raise ValueError('Proxy exclusion CIDR must be canonical')
        else:
            host = item[1:] if item.startswith('.') else item
            try:
                ipaddress.ip_address(host)
            except ValueError:
                if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', host) or any(not label or len(label) > 63 for label in host.split('.')):
                    raise ValueError('Invalid proxy exclusion host') from None
    if mode == 'direct':
        if url or username or password or bypass:
            raise ValueError('Direct notifications do not accept proxy URL or credentials')
        url, username, password = '', '', ''
    else:
        try:
            parsed = urllib.parse.urlsplit(url)
            port = parsed.port
        except ValueError:
            raise ValueError('Invalid HTTP proxy') from None
        if (parsed.scheme != 'http' or not parsed.hostname or port is None or not 1 <= port <= 65535
                or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment
                or parsed.path not in ('', '/') or any(ord(c) <= 32 or ord(c) == 127 for c in url)):
            raise ValueError('Notification proxy requires plain HTTP URL with explicit port')
        if username and not password and previous.get('mode') == mode and previous.get('url') == url and previous.get('username') == username:
            password = previous.get('password', '')
        if bool(username) != bool(password):
            raise ValueError('Notification proxy authentication requires a credential pair')
    clear_ca = value.get('clear_ca', False)
    if type(clear_ca) is not bool or (clear_ca and ca):
        raise ValueError('CA replacement and removal cannot be combined')
    if clear_ca:
        ca = ''
    elif not ca:
        ca = previous.get('ca_pem', '')
    if ca:
        if 'PRIVATE KEY' in ca:
            raise ValueError('Only CA certificates are accepted')
        try:
            ssl.create_default_context(cadata=ca)
        except (ssl.SSLError, ValueError):
            raise ValueError('Invalid notification CA certificate') from None
    private = {'mode': mode, 'url': url, 'username': username, 'password': password, 'no_proxy': list(bypass), 'ca_pem': ca}
    public = {k: private[k] for k in ('mode', 'url', 'username', 'no_proxy')}
    public.update(password_set=bool(password), ca_set=bool(ca))
    return public, private


def mailbox(value):
    # Plain addresses only: no display names, templates, comments or headers.
    text(value, 254)
    if not re.fullmatch(r"[A-Za-z0-9!#$%&'*+/=?^_`|~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", value):
        raise ValueError('Invalid plain email address')
    local, host = value.rsplit('@', 1)
    if len(local) > 64 or local.startswith('.') or local.endswith('.') or '..' in local:
        raise ValueError('Invalid email local part')
    if any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', part) for part in host.split('.')):
        raise ValueError('Invalid email domain')
    return value


def smtp_profile(value, previous):
    fields = {'smarthost', 'from', 'to', 'tls_mode', 'username', 'password', 'password_set'}
    if not isinstance(value, dict) or set(value) - fields:
        raise ValueError('Invalid SMTP fields')
    hostport, username, password = value.get('smarthost', ''), value.get('username', ''), value.get('password', '')
    text(hostport, 320); text(username, 128, empty=True); text(password, 1024, empty=True)
    try:
        parsed = urllib.parse.urlsplit('smtp://' + hostport)
        host, port = parsed.hostname, parsed.port
        if not host or '%' in host or port is None or not 1 <= port <= 65535 or parsed.username is not None or parsed.password is not None or parsed.path or parsed.query or parsed.fragment:
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if len(host) > 253 or any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', part) for part in host.split('.')):
                raise ValueError()
        if hostport.lower() != (('[' + host + ']') if ':' in host else host) + ':' + str(port):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError('SMTP requires host and explicit port') from None
    mode = value.get('tls_mode')
    if mode not in ('starttls', 'implicit'):
        raise ValueError('SMTP requires STARTTLS or implicit TLS')
    sender, recipients = mailbox(value.get('from')), value.get('to')
    if not isinstance(recipients, list) or not 1 <= len(recipients) <= 32 or not all(isinstance(item, str) for item in recipients) or len(set(recipients)) != len(recipients):
        raise ValueError('SMTP requires one to 32 distinct email addresses')
    recipients = [mailbox(item) for item in recipients]
    identity = ('smarthost', 'username', 'tls_mode')
    if username and not password and all(value.get(key) == previous.get(key) for key in identity):
        password = previous.get('password', '')
    if bool(username) != bool(password):
        raise ValueError('SMTP authentication requires a credential pair')
    private = {'smarthost': hostport, 'from': sender, 'to': recipients, 'tls_mode': mode, 'username': username, 'password': password}
    public = {key: val for key, val in private.items() if key != 'password'}
    public['password_set'] = bool(password)
    return public, private


def render(public, secrets, ref=None):
    receivers, certificates = [], {}
    for index, receiver in enumerate(public['receivers']):
        secret = secrets[receiver['name']]
        config = {'proxy_from_environment': False, 'tls_config': {'insecure_skip_verify': False}}
        proxy = secret['proxy']
        if proxy['mode'] == 'http':
            config['proxy_url'] = proxy['url']
            if proxy['no_proxy']:
                expanded = []
                for item in proxy['no_proxy']:
                    for entry in ([item[1:], item] if item.startswith('.') else [item]):
                        if entry not in expanded:
                            expanded.append(entry)
                config['no_proxy'] = ','.join(expanded)
            if proxy['username']:
                basic = base64.b64encode((proxy['username'] + ':' + proxy['password']).encode()).decode('ascii')
                config['proxy_connect_header'] = {'Proxy-Authorization': ['Basic ' + basic]}
        if proxy['ca_pem']:
            name = 'ca-' + identifier(ref) + '-' + str(index) + '.pem'
            certificates[name] = proxy['ca_pem']
            config['tls_config']['ca_file'] = '/etc/alertmanager/' + name
        kind = receiver['kind']
        if kind == 'email':
            smtp = secret['smtp']
            item = {'send_resolved': True, 'smarthost': smtp['smarthost'], 'from': smtp['from'],
                    'to': ','.join(smtp['to']), 'require_tls': True,
                    'force_implicit_tls': smtp['tls_mode'] == 'implicit', 'tls_config': config['tls_config']}
            if smtp['username']:
                item.update(auth_username=smtp['username'], auth_password=smtp['password'])
            receivers.append({'name': receiver['name'], 'email_configs': [item]})
            continue
        item = {'http_config': config, 'send_resolved': True}
        if kind == 'telegram':
            item.update(api_url=secret['endpoint'], bot_token=secret['token'], chat_id=receiver['chat_id'])
        elif kind == 'pagerduty':
            item.update(url=secret['endpoint'], routing_key=secret['token'])
        else:
            item[{'webhook': 'url', 'slack': 'api_url', 'discord': 'webhook_url', 'msteamsv2': 'webhook_url'}[kind]] = secret['endpoint']
        receivers.append({'name': receiver['name'], kind + '_configs': [item]})
    route = dict(public['route'])
    if not receivers:
        receivers, route['receiver'] = [{'name': 'pl-disabled'}], 'pl-disabled'
    return {'route': route, 'receivers': receivers}, certificates


class AlertmanagerController:
    def __init__(self, parent):
        self.parent, self.root, self.installation = parent, Path(parent.root), parent.installation
        self.docker = parent.docker
        self.image_contract = self.resolve_image()
        self.image = self.image_contract['id']
        self.version = self.image_contract['labels']['org.opencontainers.image.version']
        self.base = self.root / 'modules' / 'alertmanager'
        directory(self.base)
        self.instances, self.operations = self.base / 'instances', self.base / 'operations'
        directory(self.instances); directory(self.operations)
        self._read_routes = {}

    def revoke_read_route(self, instance):
        self._read_routes.pop(instance, None)

    def cached_read_route(self, instance):
        route = self._read_routes.get(instance)
        if route is None:
            return None
        try:
            if time.monotonic() >= route['expires'] or self.active(instance)['current'] != route['current']:
                self.revoke_read_route(instance)
                return None
            return route['container']
        except (ValueError, OSError, KeyError, TypeError):
            self.revoke_read_route(instance)
            raise

    def native_ready(self, obj):
        self.api(obj, '/-/ready')
        info = json.loads(self.api(obj, '/api/v2/status'))
        version = info.get('versionInfo') if isinstance(info, dict) else None
        if not isinstance(version, dict) or version.get('version') != self.version:
            raise ValueError('Alertmanager runtime version mismatch')

    def resolve_image(self):
        directory(self.root / 'private', create=False)
        value = json.loads(read_file(self.root / 'private/module-images.json', limit=65536))
        state = json.loads(read_file(self.root / 'state/installation.json'))
        image = value.get('alertmanager', {})
        labels = image.get('labels', {}) if isinstance(image, dict) else {}
        if (value.get('schema') != 1 or value.get('installation') != self.installation
                or state.get('install_id') != self.installation or value.get('manifest_sha256') != state.get('manifest_sha256')
                or not re.fullmatch(r'[0-9a-f]{64}', value.get('manifest_sha256', ''))
                or set(image) != {'id', 'architecture', 'ref', 'recipe', 'labels'}
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                or image.get('architecture') not in ('amd64', 'arm64')
                or image.get('recipe') != 'deploy/images/alertmanager.Dockerfile'
                or labels.get('pl.module.id') != 'alertmanager' or labels.get('pl.module.config.version') != '1'
                or not re.fullmatch(r'\d+\.\d+\.\d+', labels.get('org.opencontainers.image.version', ''))
                or not re.fullmatch(r'[0-9a-f]{40}', labels.get('org.opencontainers.image.revision', ''))
                or labels.get('org.opencontainers.image.source') != 'https://github.com/prometheus/alertmanager'):
            raise ValueError('Invalid bundled Alertmanager image contract')
        return image

    def verify_image(self):
        value = json.loads(self.docker('image', 'inspect', self.image))[0]
        if (value.get('Id') != self.image or value.get('Os') != 'linux' or value.get('Architecture') != self.image_contract['architecture']
                or any((value.get('Config', {}).get('Labels') or {}).get(k) != v for k, v in self.image_contract['labels'].items())):
            raise ValueError('Bundled Alertmanager image identity mismatch')
        return value

    @contextmanager
    def locked(self):
        path = self.root / 'modules/controller.lock'
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o077:
            os.close(fd); raise ValueError('Unsafe module lifecycle lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    @contextmanager
    def instance_lock(self, instance, exclusive=False):
        path = self.operations / ('instance-' + identifier(instance) + '.lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o777 != 0o600:
            os.close(fd)
            raise ValueError('Unsafe Alertmanager instance lock')
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def paths(self, instance, create=False):
        base = self.instances / identifier(instance)
        directory(base, create=create)
        directory(base / 'plans', create=create)
        directory(base / 'config', create=create, mode=0o755)
        return base

    def plan(self, instance, ref):
        value = json.loads(read_file(self.paths(instance) / 'plans' / (identifier(ref) + '.json'), limit=1024 * 1024))
        if (not isinstance(value, dict) or set(value) != {'schema', 'installation', 'instance_id', 'public', 'config', 'secrets', 'certificates'}
                or value.get('schema') != 1 or value.get('installation') != self.installation or value.get('instance_id') != instance
                or value.get('public', {}).get('ref') != ref or type(value['public'].get('revision')) is not int
                or value['public']['revision'] < 1):
            raise ValueError('Invalid immutable Alertmanager plan')
        config, certificates = render(value['public'], value['secrets'], ref)
        if value['config'] != config or value['certificates'] != certificates:
            raise ValueError('Alertmanager plan content mismatch')
        return value

    def selected(self, instance, ref):
        if ref is None:
            public = default_public(); config, certificates = render(public, {})
            return {'public': public, 'config': config, 'secrets': {}, 'certificates': certificates}
        return self.plan(instance, ref)

    def state(self, instance):
        value = json.loads(read_file(self.paths(instance) / 'state.json'))
        if not isinstance(value, dict) or set(value) != {'current', 'pending'}:
            raise ValueError('Invalid Alertmanager state')
        if value['current'] is not None:
            self.plan(instance, value['current'])
        if value['pending'] is not None:
            pending = value['pending']
            if not isinstance(pending, dict) or set(pending) != {'operation_id', 'ref'}:
                raise ValueError('Invalid pending Alertmanager operation')
            identifier(pending['operation_id']); self.plan(instance, pending['ref'])
        return value

    def active(self, instance, allow_pending=False):
        state = self.state(instance)
        if state['pending'] and not allow_pending:
            raise ValueError('Alertmanager requires same-operation reconciliation')
        plans = [self.selected(instance, state['current'])]
        if state['pending']:
            plans.append(self.plan(instance, state['pending']['ref']))
        if read_file(self.paths(instance) / 'config/config.json', mode=0o444, limit=1024 * 1024) not in [encoded(plan['config']) for plan in plans]:
            raise ValueError('Alertmanager active configuration drift')
        for plan in plans:
            for name, body in plan['certificates'].items():
                if read_file(self.paths(instance) / 'config' / name, mode=0o444) != body.encode():
                    raise ValueError('Alertmanager CA file drift')
        return state

    def initialize(self, instance):
        base = self.paths(instance, create=True)
        if (self.operations / ('remove-' + instance + '.json')).exists():
            raise ValueError('Removed Alertmanager instance cannot be recreated')
        path = base / 'state.json'
        if not path.exists() and not path.is_symlink():
            if any(p.name not in ('config', 'plans') for p in base.iterdir()) or any((base / 'plans').iterdir()) or any((base / 'config').iterdir()):
                raise ValueError('Unowned Alertmanager initialization files')
            atomic(path, {'current': None, 'pending': None})
        config = base / 'config/config.json'
        if not config.exists() and not config.is_symlink():
            if self.state(instance) != {'current': None, 'pending': None} or any((base / 'plans').iterdir()) or any((base / 'config').iterdir()):
                raise ValueError('Alertmanager active configuration missing')
            atomic(config, encoded(self.selected(instance, None)['config']), 0o444)
        self.active(instance)

    def prepare(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id', 'configuration'}:
            raise ValueError('Invalid Alertmanager preparation request')
        if len(json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()) > 256 * 1024:
            raise ValueError('Alertmanager request exceeds the bounded size')
        instance = identifier(body['instance_id'])
        with self.instance_lock(instance, exclusive=True), self.locked():
            self.revoke_read_route(instance)
            self.active(instance)
            value = body['configuration']
            if (not isinstance(value, dict) or set(value) - {'revision', 'ref', 'route', 'receivers'}
                    or type(value.get('revision')) is not int or not 0 <= value['revision'] < 2**53 - 1):
                raise ValueError('Invalid Alertmanager configuration fields')
            previous = self.selected(instance, value.get('ref') or None)
            if previous['public']['revision'] != value['revision']:
                raise ValueError('Alertmanager reference revision mismatch')
            route, receivers = value.get('route'), value.get('receivers')
            if not isinstance(route, dict) or set(route) != {'receiver', 'group_wait', 'group_interval', 'repeat_interval'}:
                raise ValueError('Invalid Alertmanager route')
            duration(route['group_wait'], zero=True)
            interval, repeat = duration(route['group_interval']), duration(route['repeat_interval'])
            if repeat < interval or not isinstance(receivers, list) or len(receivers) > 32:
                raise ValueError('Invalid Alertmanager grouping or receiver count')
            names, public_receivers, private = set(), [], {}
            for receiver in receivers:
                fields = {'name', 'kind', 'endpoint_set', 'token_set', 'chat_id', 'proxy', 'endpoint', 'token', 'smtp'}
                if not isinstance(receiver, dict) or set(receiver) - fields:
                    raise ValueError('Invalid Alertmanager receiver fields')
                name, kind = receiver.get('name'), receiver.get('kind')
                if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,63}', name) or name in names or kind not in ('webhook', 'telegram', 'slack', 'discord', 'email', 'msteamsv2', 'pagerduty'):
                    raise ValueError('Invalid or duplicate Alertmanager receiver')
                names.add(name)
                old_public = next((item for item in previous['public']['receivers'] if item['name'] == name and item['kind'] == kind), None)
                old = previous['secrets'].get(name, {}) if old_public else {}
                if kind == 'email':
                    if receiver.get('endpoint') or receiver.get('token') or receiver.get('chat_id') not in (None, 0):
                        raise ValueError('SMTP does not accept HTTP receiver fields')
                    smtp_public, smtp_private = smtp_profile(receiver.get('smtp'), old.get('smtp', {}))
                    old_proxy = copy.deepcopy(old.get('proxy', {}))
                    if smtp_public['smarthost'] != old.get('smtp', {}).get('smarthost'):
                        old_proxy.pop('ca_pem', None)
                    public_proxy, secret_proxy = proxy_profile(receiver.get('proxy'), old_proxy)
                    if public_proxy['mode'] != 'direct':
                        raise ValueError('SMTP does not use HTTP proxy')
                    public_receivers.append({'name': name, 'kind': kind, 'endpoint_set': False, 'token_set': False,
                                             'smtp': smtp_public, 'proxy': public_proxy})
                    private[name] = {'smtp': smtp_private, 'proxy': secret_proxy}
                    continue
                if receiver.get('smtp') is not None:
                    raise ValueError('SMTP fields belong only to email receivers')
                target, token = receiver.get('endpoint', ''), receiver.get('token', '')
                text(target, 8192, empty=True); text(token, 4096, empty=True)
                if kind not in ('telegram', 'pagerduty') and token:
                    raise ValueError('Tokens are supported only for Telegram and PagerDuty')
                if kind == 'pagerduty' and (any(c.isspace() for c in token) or '{' in token or '}' in token):
                    raise ValueError('PagerDuty requires a literal routing key')
                target = target or old.get('endpoint', '') or {'telegram': 'https://api.telegram.org', 'pagerduty': 'https://events.pagerduty.com/v2/enqueue'}.get(kind, '')
                target = endpoint(target)
                if old.get('token') and not token and target != old.get('endpoint'):
                    raise ValueError('Changing notification endpoint requires re-entering its token')
                token = token or old.get('token', '')
                old_proxy = copy.deepcopy(old.get('proxy', {}))
                if target != old.get('endpoint'):
                    old_proxy.pop('ca_pem', None)
                public_proxy, secret_proxy = proxy_profile(receiver.get('proxy'), old_proxy)
                summary = {'name': name, 'kind': kind, 'endpoint_set': True, 'token_set': bool(token), 'proxy': public_proxy}
                if kind == 'telegram':
                    chat = receiver.get('chat_id')
                    if type(chat) is not int or not -(2**53) < chat < 2**53 or chat == 0 or not token:
                        raise ValueError('Telegram requires a bot token and JSON-safe nonzero chat ID')
                    summary['chat_id'] = chat
                elif receiver.get('chat_id') not in (None, 0):
                    raise ValueError('Chat ID is supported only for Telegram')
                if kind == 'pagerduty' and not token:
                    raise ValueError('PagerDuty requires a routing key')
                public_receivers.append(summary)
                private[name] = {'endpoint': target, 'token': token, 'proxy': secret_proxy}
            if (names and route['receiver'] not in names) or (not names and route['receiver'] != ''):
                raise ValueError('Route must reference an existing notification receiver')
            ref = str(uuid.uuid4())
            summary = {'revision': value['revision'] + 1, 'ref': ref, 'route': dict(route), 'receivers': public_receivers}
            config, certificates = render(summary, private, ref)
            plan = {'schema': 1, 'installation': self.installation, 'instance_id': instance,
                    'public': summary, 'config': config, 'secrets': private, 'certificates': certificates}
            data = encoded(plan)
            if len(data) > 1024 * 1024:
                raise ValueError('Alertmanager plan exceeds the bounded size')
            path = self.paths(instance) / 'plans' / (ref + '.json')
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600); stream.write(data); stream.flush(); os.fsync(stream.fileno())
            fsync_directory(path.parent)
            return summary

    def labels(self, instance):
        return {'pl.installation': self.installation, 'pl.module': 'alertmanager', 'pl.instance': identifier(instance)}

    def name(self, instance):
        return self.installation + '-alertmanager-' + identifier(instance)

    def owned_volume(self, instance):
        name = self.name(instance) + '-data'
        found = self.docker('volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().strip()
        if not found:
            return None
        obj = json.loads(self.docker('volume', 'inspect', name))[0]
        if (obj.get('Name') != name or obj.get('Driver') != 'local' or obj.get('Options')
                or any((obj.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())):
            raise ValueError('Alertmanager data volume ownership mismatch')
        return obj

    def inspect(self, instance, allow_pending=False):
        found = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + self.name(instance) + '$', '--format', '{{.ID}}').decode().strip()
        if not found:
            return None
        image = self.verify_image()
        obj = json.loads(self.docker('container', 'inspect', self.name(instance)))[0]
        self.active(instance, allow_pending=allow_pending)
        config, host = obj.get('Config', {}), obj.get('HostConfig', {})
        mounts = {(m.get('Type'), m.get('Name') if m.get('Type') == 'volume' else m.get('Source'), m.get('Destination'), m.get('RW')) for m in obj.get('Mounts', [])}
        expected = {('bind', str(self.paths(instance) / 'config'), '/etc/alertmanager', False), ('volume', self.name(instance) + '-data', '/alertmanager', True)}
        ports = host.get('PortBindings') or {}
        if (obj.get('Image') != self.image or config.get('Image') != self.image or config.get('Cmd') != FLAGS
                or config.get('Entrypoint') != [BINARY] or config.get('User') != '65534:65534'
                or not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', ''))
                or any((config.get('Labels') or {}).get(k) != v for k, v in self.labels(instance).items())
                or mounts != expected or set(ports) != {'9093/tcp'} or len(ports['9093/tcp']) != 1
                or ports['9093/tcp'][0].get('HostIp') != '127.0.0.1' or not host.get('ReadonlyRootfs')
                or host.get('Privileged') or host.get('NetworkMode') != 'bridge' or host.get('Memory') != 256 * 1024**2
                or host.get('NanoCpus') != 1_000_000_000 or host.get('PidsLimit') != 64 or host.get('CapDrop') != ['ALL']
                or host.get('CapAdd') or host.get('Devices') or host.get('Binds') or host.get('PublishAllPorts')
                or host.get('LogConfig') != {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}
                or host.get('RestartPolicy', {}).get('Name') != 'unless-stopped'
                or host.get('Tmpfs') or host.get('PidMode') not in (None, '') or host.get('IpcMode') not in (None, 'private')
                or 'no-new-privileges' not in ','.join(host.get('SecurityOpt') or [])
                or config.get('Env') != image.get('Config', {}).get('Env')
                or config.get('WorkingDir') != image.get('Config', {}).get('WorkingDir')):
            raise ValueError('Alertmanager container drift; manual inspection required')
        self.owned_volume(instance)
        return obj

    def api(self, obj, path, reload=False):
        values = obj.get('NetworkSettings', {}).get('Ports', {}).get('9093/tcp') or []
        if len(values) != 1 or values[0].get('HostIp') != '127.0.0.1' or not str(values[0].get('HostPort', '')).isdigit():
            raise ValueError('Alertmanager loopback binding unavailable')
        port = int(values[0]['HostPort'])
        if not 1 <= port <= 65535:
            raise ValueError('Invalid Alertmanager loopback port')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        request = urllib.request.Request('http://127.0.0.1:' + str(port) + path, data=b'' if reload else None,
                                         method='POST' if reload else 'GET')
        with opener.open(request, timeout=5) as response:
            body = response.read(4 * 1024 * 1024 + 1)
            if response.status != 200 or len(body) > 4 * 1024 * 1024:
                raise ValueError('Alertmanager response exceeds the finite contract')
            return body

    def wait_ready(self, instance, allow_pending=False):
        deadline = time.monotonic() + 30
        while True:
            obj = self.inspect(instance, allow_pending=allow_pending)
            if obj is None or not obj.get('State', {}).get('Running'):
                raise ValueError('Alertmanager stopped before readiness')
            try:
                self.api(obj, '/-/ready')
                info = json.loads(self.api(obj, '/api/v2/status'))
                if info.get('versionInfo', {}).get('version') != self.version:
                    raise ValueError('Alertmanager runtime version mismatch')
                return obj
            except (ValueError, OSError, KeyError, TypeError):
                if time.monotonic() >= deadline:
                    raise ValueError('Alertmanager readiness could not be confirmed') from None
                time.sleep(.25)

    def check_plan(self, instance, ref):
        plan = self.plan(instance, ref)
        self.verify_image()
        for name, pem in plan['certificates'].items():
            certificate = self.paths(instance) / 'config' / name
            if certificate.exists() or certificate.is_symlink():
                if read_file(certificate, mode=0o444) != pem.encode():
                    raise ValueError('Alertmanager planned CA file drift')
            else:
                atomic(certificate, pem.encode(), 0o444)
        candidate = self.paths(instance) / 'config/candidate.json'
        if candidate.exists() or candidate.is_symlink():
            read_file(candidate, mode=0o444, limit=1024 * 1024)
        atomic(candidate, encoded(plan['config']), 0o444)
        try:
            self.docker('container', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                        '--security-opt', 'no-new-privileges:true', '--user', '65534:65534', '--memory', '256m',
                        '--cpus', '1', '--pids-limit', '64', '--entrypoint', '/bin/amtool',
                        '--mount', 'type=bind,source=' + str(self.paths(instance) / 'config') + ',target=/etc/alertmanager,readonly',
                        self.image, 'check-config', '/etc/alertmanager/candidate.json', timeout=35)
        finally:
            candidate.unlink(missing_ok=True); fsync_directory(candidate.parent)
        return plan

    def validate(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id', 'configuration_ref'}:
            raise ValueError('Invalid Alertmanager validation request')
        instance, ref = identifier(body['instance_id']), identifier(body['configuration_ref'])
        with self.instance_lock(instance, exclusive=True), self.locked():
            self.revoke_read_route(instance)
            self.active(instance)
            self.check_plan(instance, ref)
            return {'valid': True}

    def create_container(self, instance):
        self.revoke_read_route(instance)
        self.verify_image()
        volume = self.name(instance) + '-data'
        if self.owned_volume(instance) is None:
            args = ['volume', 'create']
            for key, value in self.labels(instance).items():
                args += ['--label', key + '=' + value]
            self.docker(*args, volume)
        self.owned_volume(instance)
        args = ['container', 'create', '--name', self.name(instance), '--network', 'bridge', '--restart', 'unless-stopped',
                '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '65534:65534',
                '--memory', '256m', '--cpus', '1', '--pids-limit', '64', '--entrypoint', BINARY,
                '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
                '--publish', '127.0.0.1::9093', '--mount', 'type=bind,source=' + str(self.paths(instance) / 'config') + ',target=/etc/alertmanager,readonly',
                '--mount', 'type=volume,source=' + volume + ',target=/alertmanager']
        for key, value in self.labels(instance).items():
            args += ['--label', key + '=' + value]
        self.docker(*args, self.image, *FLAGS)
        obj = self.inspect(instance, allow_pending=True)
        if obj is None:
            raise ValueError('Alertmanager container creation not confirmed')
        self.docker('container', 'start', obj['Id'])

    def ensure(self, instance):
        self.revoke_read_route(instance)
        self.initialize(instance)
        obj = self.inspect(instance)
        if obj is None:
            self.create_container(instance)
        elif not obj.get('State', {}).get('Running'):
            self.docker('container', 'start', obj['Id'])
        self.wait_ready(instance)

    def observe(self, instance, allow_pending=False):
        self.revoke_read_route(instance)
        checked_at = time.monotonic()
        if not (self.instances / identifier(instance)).exists():
            if self.owned_volume(instance) or self.docker('container', 'ls', '-a', '--filter', 'name=^/' + self.name(instance) + '$', '--format', '{{.ID}}').decode().strip():
                raise ValueError('Alertmanager artifacts have no managed configuration')
            return {'state': 'absent', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0, 'error': ''}
        state = self.active(instance, allow_pending=allow_pending)
        obj = self.inspect(instance, allow_pending=allow_pending)
        plan = self.selected(instance, state['current'])
        result = {'state': 'disabled', 'version': self.version, 'endpoint': '', 'targets_up': 0, 'targets_total': 0, 'error': '',
                  'configuration_revision': plan['public']['revision'], 'configuration_hash': hashlib.sha256(encoded(plan['config'])).hexdigest()}
        if obj is None:
            raise ValueError('Alertmanager container absent but managed artifacts remain')
        if obj.get('State', {}).get('Running'):
            self.native_ready(obj)
            result['state'] = 'running'
            ports = obj['NetworkSettings']['Ports']['9093/tcp']
            result['endpoint'] = 'http://127.0.0.1:' + ports[0]['HostPort']
            self._read_routes[instance] = {'expires': checked_at + 30, 'current': state['current'], 'container': obj}
        return result

    def status(self, body):
        if not isinstance(body, dict) or set(body) != {'instance_id'}:
            raise ValueError('Invalid Alertmanager status request')
        instance = identifier(body['instance_id'])
        with self.instance_lock(instance):
            try:
                obj = self.cached_read_route(instance)
                if obj is not None:
                    self.native_ready(obj)
                    return {'state': 'running', 'version': self.version}
                observed = self.observe(instance)
                return {'state': observed['state'], 'version': observed['version']}
            except (ValueError, OSError, KeyError, TypeError):
                self.revoke_read_route(instance)
                raise

    def read(self, body):
        if (not isinstance(body, dict) or set(body) != {'instance_id', 'path', 'query'}
                or body.get('path') != '/api/v2/alerts' or body.get('query') != ''):
            raise ValueError('Unsupported Alertmanager read request')
        instance = identifier(body['instance_id'])
        with self.instance_lock(instance):
            try:
                obj = self.cached_read_route(instance)
                if obj is None:
                    if self.observe(instance)['state'] != 'running':
                        raise ValueError('Alertmanager module is not running')
                    obj = self._read_routes[instance]['container']
                raw = self.api(obj, '/api/v2/alerts')
                value = json.loads(raw)
                if not isinstance(value, list):
                    raise ValueError('Invalid Alertmanager alerts response')
                return {'instance_id': instance, 'status': 200, 'content_type': 'application/json',
                        'body': base64.b64encode(raw).decode('ascii')}
            except (ValueError, OSError, KeyError, TypeError):
                self.revoke_read_route(instance)
                raise

    def configure(self, body):
        instance, ref = body['instance_id'], body['configuration_ref']
        self.revoke_read_route(instance)
        state = self.active(instance, allow_pending=True)
        pending = {'operation_id': body['operation_id'], 'ref': ref}
        if state['pending'] and state['pending'] != pending:
            raise ValueError('Another Alertmanager operation requires reconciliation')
        plan, previous = self.plan(instance, ref), self.selected(instance, state['current'])
        if plan['public']['revision'] < previous['public']['revision'] or (plan['public']['revision'] == previous['public']['revision'] and ref != state['current']):
            raise ValueError('Alertmanager configuration revision changed')
        if ref == state['current'] and not state['pending']:
            return self.observe(instance)
        try:
            self.check_plan(instance, ref)
            obj = self.inspect(instance, allow_pending=True)
            if obj is None or not obj.get('State', {}).get('Running'):
                raise ValueError('Enable Alertmanager before applying configuration')
        except (ValueError, OSError, KeyError, TypeError):
            if state['pending']:
                raise
            result = self.observe(instance)
            result.update(state='error', rolled_back=True, error='Alertmanager configuration rejected; previous settings remain active')
            return result
        state['pending'] = pending
        state_path, path = self.paths(instance) / 'state.json', self.paths(instance) / 'config/config.json'
        atomic(state_path, state)
        try:
            atomic(path, encoded(plan['config']), 0o444)
            # Alertmanager's finite reload handler returns success only after
            # loading this file; management HTTP is loopback/controller-only.
            self.api(obj, '/-/reload', reload=True)
            self.wait_ready(instance, allow_pending=True)
        except (ValueError, OSError, KeyError, TypeError):
            try:
                atomic(path, encoded(previous['config']), 0o444)
                self.api(obj, '/-/reload', reload=True)
                self.wait_ready(instance, allow_pending=True)
            except (ValueError, OSError, KeyError, TypeError):
                raise ValueError('Alertmanager apply and rollback unconfirmed; reconcile same operation') from None
            atomic(state_path, {'current': state['current'], 'pending': None})
            result = self.observe(instance)
            result.update(state='error', rolled_back=True, error='Alertmanager apply failed; previous settings were restored')
            return result
        atomic(state_path, {'current': ref, 'pending': None})
        return self.observe(instance)

    def owned_files(self, instance):
        base = self.paths(instance)
        if set(p.name for p in base.iterdir()) != {'config', 'plans', 'state.json'}:
            raise ValueError('Unknown Alertmanager instance files')
        self.active(instance, allow_pending=True)
        expected = {'config.json', 'candidate.json'}
        for path in (base / 'plans').iterdir():
            if path.suffix != '.json':
                raise ValueError('Unknown Alertmanager plan file')
            plan = self.plan(instance, path.stem)
            for name, body in plan['certificates'].items():
                expected.add(name)
                certificate = base / 'config' / name
                if (certificate.exists() or certificate.is_symlink()) and read_file(certificate, mode=0o444) != body.encode():
                    raise ValueError('Alertmanager CA content mismatch')
        if set(p.name for p in (base / 'config').iterdir()) - expected:
            raise ValueError('Unknown Alertmanager configuration files')
        return base

    def destroy_container(self, instance):
        self.revoke_read_route(instance)
        obj = self.inspect(instance, allow_pending=True)
        if obj:
            if obj.get('State', {}).get('Running'):
                self.docker('container', 'stop', '--time', '10', obj['Id'], timeout=20)
            self.docker('container', 'rm', obj['Id'])

    def remove(self, instance):
        self.revoke_read_route(instance)
        base = self.instances / identifier(instance)
        marker = self.operations / ('remove-' + instance + '.json')
        if not base.exists() and not base.is_symlink():
            self.observe(instance)
            return
        if not marker.exists() and not marker.is_symlink():
            self.owned_files(instance); self.inspect(instance, allow_pending=True); self.owned_volume(instance)
            files = {}
            for path in [base / 'state.json', *(base / 'plans').iterdir(), *(base / 'config').iterdir()]:
                mode = 0o444 if path.parent.name == 'config' else 0o600
                files[str(path.relative_to(base))] = {'mode': mode, 'sha256': hashlib.sha256(read_file(path, mode=mode, limit=1024 * 1024)).hexdigest()}
            atomic(marker, {'installation': self.installation, 'instance_id': instance, 'files': files})
        removal = json.loads(read_file(marker))
        if (not isinstance(removal, dict) or set(removal) != {'installation', 'instance_id', 'files'}
                or removal['installation'] != self.installation or removal['instance_id'] != instance or not isinstance(removal['files'], dict)):
            raise ValueError('Invalid Alertmanager removal journal')
        directory(base, create=False)
        if set(p.name for p in base.iterdir()) - {'config', 'plans', 'state.json'}:
            raise ValueError('Unknown Alertmanager files during removal')
        actual = set()
        for name in ('config', 'plans'):
            path = base / name
            if path.exists() or path.is_symlink():
                directory(path, create=False, mode=0o755 if name == 'config' else 0o700)
                actual.update(str(p.relative_to(base)) for p in path.iterdir())
        if (base / 'state.json').exists() or (base / 'state.json').is_symlink():
            actual.add('state.json')
        if actual - set(removal['files']):
            raise ValueError('Unknown Alertmanager removal artifacts')
        for relative, value in removal['files'].items():
            valid = relative == 'state.json' or re.fullmatch(r'plans/[0-9a-f-]{36}\.json', relative) or relative in ('config/config.json', 'config/candidate.json') or re.fullmatch(r'config/ca-[0-9a-f-]{36}-[0-9]{1,2}\.pem', relative)
            mode = 0o444 if relative.startswith('config/') else 0o600
            if (not valid or not isinstance(value, dict) or set(value) != {'mode', 'sha256'} or value['mode'] != mode
                    or not re.fullmatch(r'[0-9a-f]{64}', value['sha256'])):
                raise ValueError('Invalid Alertmanager removal file identity')
            if relative in actual and hashlib.sha256(read_file(base / relative, mode=mode, limit=1024 * 1024)).hexdigest() != value['sha256']:
                raise ValueError('Alertmanager removal artifact changed')
        self.destroy_container(instance)
        if self.owned_volume(instance):
            self.docker('volume', 'rm', self.name(instance) + '-data')
        if self.owned_volume(instance) is not None:
            raise ValueError('Alertmanager volume removal unconfirmed')
        for relative in actual:
            (base / relative).unlink()
        for name in ('plans', 'config'):
            if (base / name).exists():
                (base / name).rmdir()
        base.rmdir(); fsync_directory(self.instances)
        if self.observe(instance)['state'] != 'absent':
            raise ValueError('Alertmanager removal unconfirmed')

    def execute(self, body):
        fields = {'operation_id', 'instance_id', 'module_id', 'action'}
        if isinstance(body, dict) and body.get('action') == 'configure':
            fields.add('configuration_ref')
        if (not isinstance(body, dict) or set(body) != fields or body.get('module_id') != 'alertmanager'
                or body.get('action') not in ('install', 'enable', 'disable', 'refresh', 'remove', 'configure')):
            raise ValueError('Unsupported Alertmanager operation')
        instance, operation = identifier(body['instance_id']), identifier(body['operation_id'])
        if body['action'] == 'configure':
            identifier(body['configuration_ref'])
        with self.instance_lock(instance, exclusive=True), self.locked():
            self.revoke_read_route(instance)
            path = self.operations / (operation + '.json')
            fingerprint = hashlib.sha256(encoded(body)).hexdigest()
            if path.exists() or path.is_symlink():
                journal = json.loads(read_file(path))
                if journal.get('fingerprint') != fingerprint:
                    raise ValueError('Alertmanager operation ID conflict')
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
                result = self.configure(body) if body['action'] == 'configure' else self.observe(instance)
                result['operation_id'] = operation
                atomic(path, {'fingerprint': fingerprint, 'phase': 'complete', 'request': body, 'result': result})
                return result
            except (ValueError, OSError, KeyError, TypeError):
                self.revoke_read_route(instance)
                return {'state': 'error', 'version': '', 'endpoint': '', 'targets_up': 0, 'targets_total': 0,
                        'error': 'Alertmanager operation unconfirmed; reconcile the same operation', 'operation_id': operation}

    def get(self, instance):
        instance = identifier(instance)
        with self.instance_lock(instance):
            return self.observe(instance)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ValueError('Alertmanager management redirect refused')
