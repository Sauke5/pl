#!/usr/bin/env python3
"""Owned NetMap frontdoor, inventory adapter and explicitly requested discovery.

No scheduler or scan runs at startup. Native upstreams are fixed and private.
"""
from __future__ import annotations
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from gateway import GatewayVerifier, GatewayError


REQUEST_ERRORS = {
    'netmap_snmp_required': 400,
    'netmap_network_missing': 400,
    'netmap_profile_missing': 400,
    'netmap_invalid_network': 400,
    'netmap_invalid_profile': 400,
    'netmap_invalid_ssh_trust': 400,
    'netmap_invalid_model': 400,
    'netmap_invalid_snmp_community': 400,
    'netmap_network_limit': 400,
    'netmap_profile_limit': 400,
    'netmap_poll_running': 409,
    'netmap_idempotency_conflict': 409,
    'netmap_invalid_observations': 400,
    'netmap_invalid_snmp_profiles': 400,
    'netmap_device_missing': 400,
    'netmap_invalid_binding': 400,
    'netmap_device_changed': 409,
    'netmap_collector_not_ready': 409,
}


class RequestError(ValueError):
    """Finite validation cause only; never forward exception text or inputs."""
    def __init__(self, code):
        self.status = REQUEST_ERRORS[code]
        self.code = code
        super().__init__(code)

MAX_BODY = 3 * 1024 * 1024
MAX_RESPONSE = 32 * 1024 * 1024
GRAPH_OBSERVATION_LIMIT = 4096
GRAPH_REPORT_LIMIT = 8192
NATIVE = {'netbox': ('netbox', 8080), 'gitea': ('gitea', 3000), 'oxidized': ('oxidized', 8888)}

def canonical_network(value):
    if not isinstance(value, str):
        raise RequestError('netmap_invalid_network')
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError:
        raise RequestError('netmap_invalid_network') from None
    if network.num_addresses > 4096 or network.is_multicast or network.is_unspecified or network.is_loopback or network.is_link_local:
        raise RequestError('netmap_invalid_network')
    return str(network)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def valid_netbox_version(value):
    return isinstance(value, str) and re.fullmatch(r'W/"[0-9TZ:.+\-]{20,80}"', value) is not None


def native_model_matches(actual, expected):
    # Oxidized0.37 HTTP source applies these default aliases, then serializes the Ruby class name.
    if (not isinstance(actual, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', actual)
            or not isinstance(expected, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', expected)):
        return False
    return actual.lower() == {'cisco': 'ios', 'juniper': 'junos'}.get(expected, expected)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class NetBox:
    def __init__(self, config):
        self.auth = 'Bearer nbt_' + config['token_key'] + '.' + config['token']
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None, *, version=None, include_version=False):
        parsed = urllib.parse.urlsplit(path)
        if (not path.startswith(('/dcim/', '/extras/', '/status/')) or parsed.scheme or parsed.netloc
                or parsed.fragment or any(c in path for c in ('\\', '#', '//'))
                or any(part in ('.', '..') for part in parsed.path.split('/'))):
            raise ValueError('Invalid NetBox API route')
        headers = {'Authorization': self.auth, 'Content-Type': 'application/json', 'Accept': 'application/json'}
        if version is not None:
            if method != 'PATCH' or not valid_netbox_version(version):
                raise RequestError('netmap_invalid_binding')
            headers['If-Match'] = version
        req = urllib.request.Request('http://netbox:8080/netmap/netbox/api' + path,
            data=None if body is None else json_bytes(body), method=method,
            headers=headers)
        try:
            with self.opener.open(req, timeout=20) as response:
                data = response.read(MAX_RESPONSE + 1)
                if len(data) > MAX_RESPONSE:
                    raise ValueError('NetBox response exceeds limit')
                value = json.loads(data) if data else None
                if include_version:
                    tag = response.headers.get('ETag')
                    if not valid_netbox_version(tag):
                        raise ValueError('Native conditional writes are unavailable')
                    return value, tag
                return value
        except urllib.error.HTTPError as exc:
            with exc:
                code = exc.code
            if code == 412:
                raise RequestError('netmap_device_changed') from None
            if code == 404 and include_version:
                raise RequestError('netmap_device_missing') from None
            raise RuntimeError('NetBox request rejected: ' + str(code)) from None

    def all(self, path, **query):
        results = []
        for offset in range(0, 100001, 1000):
            page = self.request('GET', path + '?' + urllib.parse.urlencode({**query, 'limit': 1000, 'offset': offset}))
            rows = page.get('results')
            if not isinstance(rows, list):
                raise ValueError('Invalid NetBox collection')
            results.extend(rows)
            if not page.get('next'):
                return results
        raise ValueError('NetBox inventory exceeds limit')

    def get_or_create(self, path, lookup, body):
        found = self.all(path, **lookup)
        if len(found) > 1:
            raise ValueError('Ambiguous NetBox object')
        return found[0] if found else self.request('POST', path, body)


class StoreConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class Store:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS networks(id TEXT PRIMARY KEY,cidr TEXT UNIQUE NOT NULL,name TEXT NOT NULL,profile TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS polls(id TEXT PRIMARY KEY,network TEXT NOT NULL,state TEXT NOT NULL,result TEXT NOT NULL,actor TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,digest TEXT NOT NULL,response TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS network_snmp_profiles(network TEXT PRIMARY KEY,profiles TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS device_access_state(device INTEGER PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS host_observations(network TEXT NOT NULL,ip TEXT NOT NULL,last_seen TEXT NOT NULL,methods TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(network,ip));
                CREATE TABLE IF NOT EXISTS host_reports(network TEXT NOT NULL,source TEXT NOT NULL,ip TEXT NOT NULL,hostname TEXT NOT NULL,mac TEXT NOT NULL,methods TEXT NOT NULL,observed_at TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(network,source,ip));''')
        os.chmod(path, 0o600)

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10, factory=StoreConnection)
        connection.row_factory = sqlite3.Row
        return connection

    def networks(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute('SELECT * FROM networks ORDER BY name,id')]

    def profile(self, name):
        with self.connect() as db:
            row = db.execute('SELECT payload FROM profiles WHERE id=?', (name,)).fetchone()
            return json.loads(row[0]) if row else None

    def snmp_profiles(self, network):
        with self.connect() as db:
            row = db.execute('SELECT profiles FROM network_snmp_profiles WHERE network=?', (network,)).fetchone()
            return json.loads(row[0]) if row else None

    def device_access(self, device):
        with self.connect() as db:
            row = db.execute('SELECT payload FROM device_access_state WHERE device=?', (device,)).fetchone()
            return json.loads(row[0]) if row else None

    def set_device_access(self, device, value):
        with self.connect() as db:
            db.execute('INSERT INTO device_access_state VALUES(?,?) ON CONFLICT(device) DO UPDATE SET payload=excluded.payload',
                       (device, json.dumps(value)))

    def observations(self, network=None, limit=None):
        with self.connect() as db:
            query = 'SELECT * FROM host_observations WHERE network IN (SELECT id FROM networks)'
            args = []
            if network is not None:
                query += ' AND network=?'
                args.append(network)
            query += ' ORDER BY network,ip'
            if limit is not None:
                if not isinstance(limit, int) or limit < 1:
                    raise ValueError('Invalid observation limit')
                query += ' LIMIT ?'
                args.append(limit)
            rows = db.execute(query, args)
            return [dict(row) for row in rows]

    def record_observations(self, network, found, seen_at):
        # A completed poll changes freshness, never deletes previously observed hosts.
        with self.connect() as db:
            db.execute("UPDATE host_observations SET state='stale' WHERE network=?", (network,))
            for item in found:
                db.execute('''INSERT INTO host_observations(network,ip,last_seen,methods,state) VALUES(?,?,?,?,?)
                    ON CONFLICT(network,ip) DO UPDATE SET last_seen=excluded.last_seen,methods=excluded.methods,state=excluded.state''',
                    (network, item['ip'], seen_at, json.dumps(item['methods']), 'observed'))

    def reports(self, network=None, limit=None):
        with self.connect() as db:
            query = 'SELECT * FROM host_reports WHERE network IN (SELECT id FROM networks)'
            args = []
            if network is not None:
                query += ' AND network=?'
                args.append(network)
            query += ' ORDER BY network,source,ip'
            if limit is not None:
                if not isinstance(limit, int) or limit < 1:
                    raise ValueError('Invalid report limit')
                query += ' LIMIT ?'
                args.append(limit)
            rows = db.execute(query, args)
            return [dict(row) for row in rows]

    def record_reports(self, network, source, records):
        with self.connect() as db:
            existing = {(row['source'], row['ip']) for row in db.execute('SELECT source,ip FROM host_reports WHERE network=?', (network,))}
            if len({item[0] for item in existing} | {source}) > 32 or len(existing | {(source, item['ip']) for item in records}) > 16384:
                raise RequestError('netmap_invalid_observations')
            for item in records:
                db.execute('''INSERT INTO host_reports(network,source,ip,hostname,mac,methods,observed_at,expires_at) VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(network,source,ip) DO UPDATE SET hostname=excluded.hostname,mac=excluded.mac,methods=excluded.methods,observed_at=excluded.observed_at,expires_at=excluded.expires_at
                    WHERE excluded.observed_at >= host_reports.observed_at''',
                    (network, source, item['ip'], item['hostname'], item['mac'], json.dumps(item['methods']), item['observed_at'], item['expires_at']))


class Application:
    def __init__(self, directory='/data', secrets_dir='/run/secrets'):
        self.directory = Path(directory)
        self.directory.mkdir(exist_ok=True)
        self.config = json.loads(Path(secrets_dir, 'adapter.json').read_text())
        self.netbox = NetBox(self.config)
        self.store = Store(self.directory / 'netmap.sqlite3')
        self.verifier = GatewayVerifier(Path(secrets_dir, 'gateway_key').read_bytes())
        self.poll_lock = threading.Lock()
        self.mutation_lock = threading.Lock()
        self.bootstrap_lock = threading.Lock()
        self.bootstrap_ready = False
        # Recover interrupted jobs as failed; never silently resume a network poll.
        with self.store.connect() as db:
            db.execute("UPDATE polls SET state='error',result=? WHERE state='running'", (json.dumps({'error': 'interrupted; explicit retry required'}),))

    def bootstrap(self):
        with self.bootstrap_lock:
            receipt = Path('/gitea-data/pl-bootstrap/collector').read_text()
            match = re.search(r'Access token was successfully created\.\.\. ([a-f0-9]{40})', receipt)
            if not match:
                raise ValueError('Private Gitea bootstrap receipt unavailable')
            token = match[1]
            origin = 'http://gitea:3000/api/v1'
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            def call(method, path, data=None):
                req = urllib.request.Request(origin + path, data=None if data is None else json_bytes(data), method=method,
                    headers={'Authorization': 'token ' + token, 'Content-Type': 'application/json'})
                try:
                    with opener.open(req, timeout=10) as response:
                        return response.status, json.loads(response.read(1048576))
                except urllib.error.HTTPError as exc:
                    if exc.code == 404:
                        return 404, None
                    raise ValueError('Gitea bootstrap rejected') from None
            status, repo = call('GET', '/repos/pl-collector/device-configs')
            if status == 404:
                status, repo = call('POST', '/user/repos', {'name': 'device-configs', 'private': True, 'auto_init': False, 'default_branch': 'master'})
            if status not in (200, 201) or repo.get('private') is not True or repo.get('owner', {}).get('login') != 'pl-collector':
                raise ValueError('Gitea owned repository identity conflict')
            # Authenticated read proves NetBox migrations/schema/token, not only HTTP readiness.
            fields = self.netbox.all('/extras/custom-fields/', name='collector_ip')
            if len(fields) != 1 or fields[0].get('name') != 'collector_ip':
                raise ValueError('NetBox collector schema unavailable')
            self.bootstrap_ready = True
            return {'push_token': token}

    def trust(self):
        lines = []
        with self.store.connect() as db:
            for row in db.execute('SELECT payload FROM profiles ORDER BY id'):
                lines.extend(json.loads(row[0]).get('ssh_known_hosts', '').splitlines())
        value = '\n'.join(dict.fromkeys(lines)) + ('\n' if lines else '')
        if len(value.encode()) > 262144:
            raise ValueError('SSH trust exceeds limit')
        return {'known_hosts': value}

    def nodes(self):
        result = []
        for node in self.netbox.all('/dcim/devices/', tag='network-config-backup'):
            fields = node.get('custom_fields') or {}
            profile = self.store.profile(fields.get('collector_profile', ''))
            address = fields.get('collector_ip')
            model = fields.get('oxidized_model') or (profile or {}).get('oxidized_model')
            if not address or not model or not profile or not profile.get('username') or not profile.get('password'):
                continue
            ipaddress.ip_address(address)
            if not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', model):
                continue
            result.append({'name': 'device-' + str(node['id']), 'ip': address, 'model': model,
                           'username': profile['username'], 'password': profile['password']})
        return result

    def snmp_candidates(self, network):
        names = self.store.snmp_profiles(network['id'])
        if names is None:
            legacy = self.store.profile(network['profile']) if network['profile'] else None
            return [(network['profile'], legacy)] if legacy and legacy.get('snmp_community') else []
        if (not isinstance(names, list) or len(names) > 4
                or any(not isinstance(name, str) or not re.fullmatch(r'[a-z0-9_-]{1,64}', name) for name in names)
                or len(set(names)) != len(names)):
            raise RequestError('netmap_invalid_snmp_profiles')
        candidates = [(name, self.store.profile(name)) for name in names]
        if any(not profile or not profile.get('snmp_community') for name, profile in candidates):
            raise RequestError('netmap_invalid_snmp_profiles')
        return candidates

    def networks_view(self):
        items = []
        for network in self.store.networks():
            try:
                names = [name for name, profile in self.snmp_candidates(network)]
                invalid = False
            except RequestError:
                names = self.store.snmp_profiles(network['id'])
                if (not isinstance(names, list) or len(names) > 4
                        or any(not isinstance(name, str) or not re.fullmatch(r'[a-z0-9_-]{1,64}', name) for name in names)):
                    names = []
                invalid = True
            items.append({**network, 'snmp_profiles': names, 'snmp_profiles_invalid': invalid})
        return {'items': items,
                'capabilities': {'device_access': 1, 'ordered_snmp_profiles': 1, 'max_snmp_profiles': 4}}

    def probe_profiles(self, address, candidates, deadline):
        attempts = []
        for name, profile in candidates:
            if time.monotonic() >= deadline:
                break
            started = time.monotonic()
            observed = self.probe(address, profile, deadline)
            attempts.append({'profile_id': name, 'outcome': 'responded' if observed else 'unconfirmed',
                             'elapsed_ms': max(0, round((time.monotonic() - started) * 1000)),
                             'checked_at': datetime.now(timezone.utc).isoformat()})
            if observed:
                return observed, attempts
        return None, attempts

    def owned_device(self, device):
        if type(device) is not int or not 1 <= device < 10**15:
            raise RequestError('netmap_device_missing')
        record, version = self.netbox.request('GET', '/dcim/devices/' + str(device) + '/', include_version=True)
        fields = record.get('custom_fields') or {}
        source = fields.get('pl_source', '')
        network = next((item for item in self.store.networks() if source == 'network:' + item['id']), None)
        try:
            address = ipaddress.ip_address(fields.get('collector_ip', ''))
        except ValueError:
            raise RequestError('netmap_device_missing') from None
        if not network or address not in ipaddress.ip_network(network['cidr']) or str(address) != fields['collector_ip']:
            raise RequestError('netmap_device_missing')
        return record, network, version

    def device_binding(self, record):
        fields = record.get('custom_fields') or {}
        profile_id = fields.get('collector_profile') or ''
        profile = self.store.profile(profile_id) if profile_id else None
        override = fields.get('oxidized_model') or ''
        model = override or (profile or {}).get('oxidized_model', '')
        address = fields.get('collector_ip', '')
        host_key = bool(profile and any(line.split() and address in line.split()[0].split(',')
                        for line in profile.get('ssh_known_hosts', '').splitlines()))
        ready = bool(profile and profile.get('username') and profile.get('password') and host_key
                     and isinstance(model, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,63}', model))
        private = {'ip': address, 'profile_id': profile_id, 'model': model,
                   **{key: (profile or {}).get(key, '') for key in ('username', 'password', 'ssh_known_hosts')}}
        fingerprint = hashlib.sha256(json_bytes(private)).hexdigest()
        return {'profile_id': profile_id, 'model_override': override, 'effective_model': model,
                'host_key_set': host_key, 'ssh_ready': ready}, fingerprint

    def native_device_request(self, device, action, revision=None):
        if type(device) is not int or not 1 <= device < 10**15:
            raise RequestError('netmap_device_missing')
        name = 'device-' + str(device)
        paths = {'queue': '/netmap/oxidized/node/next/' + name + '.json',
                 'versions': '/netmap/oxidized/node/version.json?node_full=' + name}
        if action == 'configuration':
            if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision):
                raise ValueError('Invalid native revision')
            path = '/netmap/oxidized/node/version/view.text?' + urllib.parse.urlencode(
                {'node': name, 'group': '', 'oid': revision, 'epoch': '0', 'num': '1'})
        elif action in paths:
            path = paths[action]
        else:
            raise ValueError('Invalid native collection action')
        connection = http.client.HTTPConnection('oxidized', 8888, timeout=5)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            body = response.read(2 * 1024 * 1024 + 1)
            if response.status != 200 or len(body) > 2 * 1024 * 1024:
                raise ValueError('Native collection response unconfirmed')
            return body
        finally:
            connection.close()

    def native_device_records(self):
        value = json.loads(self._collector_get('/netmap/oxidized/nodes.json'))
        if not isinstance(value, list) or len(value) > 16384:
            raise ValueError('Invalid collector inventory')
        result = {}
        for item in value:
            if not isinstance(item, dict) or not isinstance(item.get('name'), str) or item['name'] in result:
                raise ValueError('Invalid collector identity')
            result[item['name']] = item
        return result

    @staticmethod
    def native_time(value):
        if not isinstance(value, str) or len(value) > 80:
            return None
        try:
            date = datetime.fromisoformat(value)
            if date.tzinfo is None:
                return None
            return date.astimezone(timezone.utc)
        except ValueError:
            return None

    def device_view(self, record, native):
        binding, fingerprint = self.device_binding(record)
        fields = record.get('custom_fields') or {}
        observed = native.get('device-' + str(record['id']))
        loaded = bool(observed and observed.get('ip') == fields.get('collector_ip')
                      and native_model_matches(observed.get('model'), binding['effective_model']))
        last = (observed or {}).get('last') or {}
        started, ended = self.native_time(last.get('start')), self.native_time(last.get('end'))
        return {'id': record['id'], 'name': record['name'], 'collector_ip': fields.get('collector_ip', ''),
                'binding': binding, 'source_loaded': loaded,
                'last_attempt': {'status': 'success' if last.get('status') == 'success' else 'failed' if last.get('status') in ('fail', 'no_connection') else 'unknown',
                                 'started_at': started.isoformat() if started else None,
                                 'finished_at': ended.isoformat() if ended else None}}

    def devices(self, network_id):
        network = next((item for item in self.store.networks() if item['id'] == network_id), None)
        if not network:
            raise RequestError('netmap_network_missing')
        records = self.netbox.all('/dcim/devices/', cf_pl_source='network:' + network_id)
        if len(records) > 4096:
            raise ValueError('Device list exceeds the finite bound')
        try:
            native = self.native_device_records()
            collector_available = True
        except (OSError, ValueError, http.client.HTTPException):
            native, collector_available = {}, False
        views = []
        addresses = set()
        for record in records:
            fields = record.get('custom_fields') or {}
            try:
                address = ipaddress.ip_address(fields.get('collector_ip', ''))
            except ValueError:
                raise ValueError('Invalid source-scoped device') from None
            if (fields.get('pl_source') != 'network:' + network_id
                    or address not in ipaddress.ip_network(network['cidr']) or str(address) != fields['collector_ip']
                    or str(address) in addresses):
                raise ValueError('Ambiguous source-scoped device')
            addresses.add(str(address))
            views.append(self.device_view(record, native))
        return {'items': sorted(views, key=lambda item: (ipaddress.ip_address(item['collector_ip']).version,
                int(ipaddress.ip_address(item['collector_ip'])))), 'collector_available': collector_available}

    def device_details(self, device):
        record, network, version = self.owned_device(device)
        try:
            native = self.native_device_records()
        except (OSError, ValueError, http.client.HTTPException):
            native = {}
        view = self.device_view(record, native)
        binding, fingerprint = self.device_binding(record)
        state = self.store.device_access(device) or {}
        collection = {'state': 'not_configured' if not binding['ssh_ready'] else 'unconfirmed', 'saved_configuration': None}
        observed = native.get('device-' + str(device)) or {}
        last = observed.get('last') or {}
        started = self.native_time(last.get('start'))
        ended = self.native_time(last.get('end'))
        watermark = self.native_time(state.get('confirmed_source_at'))
        current = state.get('binding_hash') == fingerprint and bool(state.get('source_loaded')) and view['source_loaded']
        fresh = bool(current and started and ended and watermark
                     and watermark <= started <= ended <= datetime.now(timezone.utc) + timedelta(seconds=5))
        if fresh and last.get('status') in ('fail', 'no_connection'):
            collection['state'] = 'failed'
        elif state.get('queue_outcome') == 'queued' and not fresh and current:
            collection['state'] = 'queued'
        if view['source_loaded']:
            try:
                versions = json.loads(self.native_device_request(device, 'versions'))
                if isinstance(versions, list) and versions and isinstance(versions[0], dict):
                    revision = versions[0].get('oid')
                    content = self.native_device_request(device, 'configuration', revision)
                    if content.strip() and content not in (b'version not found', b'node not found'):
                        collection['saved_configuration'] = {'revision': revision, 'bytes': len(content),
                            'sha256': hashlib.sha256(content).hexdigest(),
                            'committed_at': versions[0].get('date') if isinstance(versions[0].get('date'), str) else None}
                        if fresh and last.get('status') == 'success':
                            collection['state'] = 'collected'
            except (OSError, ValueError, http.client.HTTPException):
                pass
        return {'device': view, 'network_id': network['id'], 'version': version, 'collection': collection}

    def save_device_binding(self, device, body):
        if (not isinstance(body, dict) or set(body) != {'network_id', 'profile_id', 'model', 'collector_ip', 'version'}
                or not isinstance(body['profile_id'], str) or not re.fullmatch(r'[a-z0-9_-]{0,64}', body['profile_id'])
                or not isinstance(body['model'], str) or body['model'] and not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', body['model'])
                or not valid_netbox_version(body['version'])):
            raise RequestError('netmap_invalid_binding')
        record, network, version = self.owned_device(device)
        fields = record.get('custom_fields') or {}
        if body['network_id'] != network['id'] or body['collector_ip'] != fields.get('collector_ip'):
            raise RequestError('netmap_invalid_binding')
        if body['version'] != version:
            raise RequestError('netmap_device_changed')
        candidate = {**record, 'custom_fields': {**fields, 'collector_profile': body['profile_id'], 'oxidized_model': body['model']}}
        binding, fingerprint = self.device_binding(candidate)
        if body['profile_id'] and not binding['ssh_ready'] or not body['profile_id'] and body['model']:
            raise RequestError('netmap_invalid_binding')
        tags = self.netbox.all('/extras/tags/', slug='network-config-backup')
        if len(tags) != 1:
            raise ValueError('Native collector tag unavailable')
        patch = {'custom_fields': {'collector_profile': body['profile_id'], 'oxidized_model': body['model']},
                 'add_tags' if body['profile_id'] else 'remove_tags': [tags[0]['id']]}
        updated, new_version = self.netbox.request('PATCH', '/dcim/devices/' + str(device) + '/', patch,
                                                   version=version, include_version=True)
        if self.device_binding(updated)[1] != fingerprint:
            raise ValueError('Native binding readback differs')
        loaded = False
        try:
            self.reload_collector(time.monotonic() + 20)
            loaded = True
        except (OSError, ValueError, http.client.HTTPException):
            pass
        self.store.set_device_access(device, {'binding_hash': fingerprint, 'source_loaded': loaded,
            'confirmed_source_at': datetime.now(timezone.utc).isoformat(), 'queue_outcome': None})
        return {'saved': True, 'version': new_version, 'source_loaded': loaded, 'collection_confirmed': False}

    def collect_device(self, device, body, operation, actor):
        if not isinstance(body, dict) or set(body) != {'version'} or not valid_netbox_version(body['version']):
            raise RequestError('netmap_invalid_binding')
        record, network, version = self.owned_device(device)
        binding, fingerprint = self.device_binding(record)
        if body['version'] != version:
            raise RequestError('netmap_device_changed')
        if not binding['ssh_ready']:
            raise RequestError('netmap_invalid_binding')
        if 'device-' + str(device) not in self._collector_expected():
            raise RequestError('netmap_collector_not_ready')
        try:
            self.reload_collector(time.monotonic() + 20)
        except (OSError, ValueError, http.client.HTTPException):
            raise RequestError('netmap_collector_not_ready') from None
        state = {'binding_hash': fingerprint, 'source_loaded': True,
                 'confirmed_source_at': datetime.now(timezone.utc).isoformat(), 'request_id': operation, 'actor': actor,
                 'queue_outcome': 'unconfirmed'}
        self.store.set_device_access(device, state)
        try:
            if json.loads(self.native_device_request(device, 'queue')) == ['ok']:
                state['queue_outcome'] = 'queued'
        except (OSError, ValueError, http.client.HTTPException):
            pass
        self.store.set_device_access(device, state)
        return {'state': state['queue_outcome'], 'device_id': device, 'request_id': operation}

    def _collector_expected(self):
        # Source/API errors propagate: they cannot become a healthy empty source.
        records = self.nodes()
        if not isinstance(records, list) or any(not isinstance(item, dict) for item in records):
            raise ValueError('Invalid owned collector inventory')
        names = [item.get('name') for item in records]
        if any(not isinstance(name, str) or not name or len(name) > 256 for name in names) or len(set(names)) != len(names):
            raise ValueError('Invalid owned collector inventory')
        return set(names)

    def _collector_get(self, path, timeout=5):
        if path not in ('/netmap/oxidized/nodes.json', '/netmap/oxidized/reload') or not 0 < timeout <= 5:
            raise ValueError('Invalid owned collector request')
        connection = http.client.HTTPConnection('oxidized', 8888, timeout=timeout)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            data = response.read(MAX_RESPONSE + 1)
            if response.status != 200 or len(data) > MAX_RESPONSE:
                raise ValueError('Owned collector API unconfirmed')
            return data
        finally:
            connection.close()

    def _collector_names(self, timeout=5):
        records = json.loads(self._collector_get('/netmap/oxidized/nodes.json', timeout))
        if not isinstance(records, list) or any(not isinstance(item, dict) for item in records):
            raise ValueError('Invalid owned collector response')
        names = [item.get('name') for item in records]
        if any(not isinstance(name, str) or not name or len(name) > 256 for name in names) or len(set(names)) != len(names):
            raise ValueError('Invalid owned collector response')
        return set(names)

    def collector_status(self):
        expected = self._collector_expected()
        if not expected:
            return {'state': 'waiting_targets', 'targets': 0}
        if expected != self._collector_names():
            raise ValueError('Owned collector targets not loaded')
        return {'state': 'ready', 'targets': len(expected)}

    def reload_collector(self, deadline):
        if time.monotonic() >= deadline:
            raise ValueError('Explicit poll collector deadline exceeded')
        expected = self._collector_expected()
        def timeout(limit, until):
            remaining = until - time.monotonic()
            if remaining <= 0:
                raise ValueError('Owned collector readiness unconfirmed')
            return min(limit, remaining)
        if not expected:
            # Fresh SNMP-only installations have no native process to reload.
            # If a previously configured process still holds nodes, clear its
            # live source instead of leaving revoked credentials collecting.
            try:
                previous = self._collector_names(timeout(2, deadline))
            except (OSError, http.client.HTTPException):
                return {'state': 'waiting_targets', 'targets': 0}
            if previous:
                self._collector_get('/netmap/oxidized/reload', timeout(2, deadline))
                if self._collector_names(timeout(2, deadline)):
                    raise ValueError('Owned collector empty source reload unconfirmed')
            return {'state': 'waiting_targets', 'targets': 0}
        until = min(deadline, time.monotonic() + 20)
        reloaded = False
        while True:
            try:
                actual = self._collector_names(timeout(5, until))
            except (OSError, ValueError, http.client.HTTPException):
                actual = None
            if actual is not None:
                if not reloaded:
                    # A reload with an unknown result is not automatically replayed.
                    self._collector_get('/netmap/oxidized/reload', timeout(5, until))
                    reloaded = True
                    continue
                if expected == actual:
                    return {'state': 'ready', 'targets': len(expected)}
            time.sleep(min(0.5, timeout(0.5, until)))

    def configuration(self):
        # Generic discovered inventory has no classified network backbone yet.
        # Show its real devices/Cables instead of applying the office-only projection.
        scopes = [{'id': 'network', 'name': 'Вся сеть', 'api': './api/sites/network', 'grouped': False, 'rack': False}]
        scopes += [{'id': 'network-' + item['id'], 'name': item['name'], 'api': './api/sites/network-' + item['id'], 'grouped': False, 'rack': False} for item in self.store.networks()]
        return {'title': 'NetMap', 'default_scope': 'network', 'platform_url': '/', 'scopes': scopes}

    def descriptor(self):
        origin = self.config.get('platform_origin', self.config.get('origin', ''))
        if not origin or origin != self.config.get('origin'):
            raise ValueError('NetMap public origin is not configured consistently')
        return {'module': 'netmap', 'protocol': 'pl-gateway-v2', 'version': '1.0.0', 'platform_origin': origin}

    def graph(self, path='/api/topology'):
        now = datetime.now(timezone.utc).isoformat()
        if path.endswith('health'):
            self.netbox.request('GET', '/status/')
            return {'status': 'ok', 'generated_at': now, 'sources_ok': 1, 'sources_total': 1}
        devices = self.netbox.all('/dcim/devices/')
        cables = self.netbox.all('/dcim/cables/')
        selected = None
        scope_seed_ids = set()
        match = re.fullmatch(r'/api/sites/network-([a-f0-9]{16})', path)
        if match:
            selected = next((item for item in self.store.networks() if item['id'] == match[1]), None)
            if not selected:
                raise ValueError('Unknown network scope')
            cidr = ipaddress.ip_network(selected['cidr'])
            def member(device):
                fields = device.get('custom_fields') or {}
                address = fields.get('collector_ip') or (device.get('primary_ip') or {}).get('address', '').split('/')[0]
                try:
                    return fields.get('pl_source') == 'network:' + selected['id'] or ipaddress.ip_address(address) in cidr
                except ValueError:
                    return False
            scope_seed_ids = {device['id'] for device in devices if member(device)}
            support = set(scope_seed_ids)
            neighbors = {}
            for cable in cables:
                a, b = cable.get('a_terminations') or [], cable.get('b_terminations') or []
                if len(a) == 1 and len(b) == 1:
                    da = ((a[0].get('object') or {}).get('device') or {}).get('id')
                    db = ((b[0].get('object') or {}).get('device') or {}).get('id')
                    if da and db:
                        neighbors.setdefault(da, set()).add(db)
                        neighbors.setdefault(db, set()).add(da)
            pending = list(support)
            while pending:
                device_id = pending.pop()
                for neighbor in neighbors.get(device_id, set()) - support:
                    support.add(neighbor)
                    pending.append(neighbor)
            devices = [device for device in devices if device['id'] in support]
        device_ids = {device['id'] for device in devices}
        interfaces = self.netbox.all('/dcim/interfaces/')
        nodes, edges, ports = [], [], {}
        for port in interfaces:
            device = (port.get('device') or {}).get('id')
            ports.setdefault(device, []).append({'id': str(port['id']), 'name': port['name'], 'type': port.get('type'), 'enabled': port.get('enabled')})
        for device in devices:
            fields = device.get('custom_fields') or {}
            nodes.append({'id': 'device:' + str(device['id']), 'name': device['name'], 'kind': 'unknown' if (device.get('role') or {}).get('slug') == 'pl-network' else __import__('equipment_types').inventory_kind(role_name=(device.get('role') or {}).get('name', ''), role_slug=(device.get('role') or {}).get('slug', '')),
                'management_ip': fields.get('collector_ip') or (device.get('primary_ip') or {}).get('address', '').split('/')[0],
                'netbox_url': '/netmap/netbox/dcim/devices/' + str(device['id']) + '/', 'ports': ports.get(device['id'], []),
                'site': device.get('site'),
                'config_url': '/netmap/oxidized/node/fetch/device-' + str(device['id']) if fields.get('oxidized_model') else '',
                'config_history_url': '/netmap/gitea/pl-collector/device-configs/commits/branch/master/device-' + str(device['id']) if fields.get('oxidized_model') else '',
                'details': {'source': fields.get('pl_source'), 'netbox_id': device['id'], 'support_only': bool(selected and device['id'] not in scope_seed_ids)}})
        networks = {item['id']: item for item in self.store.networks()}
        inventory_by_ip = {}
        for item in nodes:
            if item['management_ip']:
                inventory_by_ip.setdefault(item['management_ip'], []).append(item)
        observed_nodes = {}
        scope = selected['id'] if selected else None
        observations = self.store.observations(scope, limit=GRAPH_OBSERVATION_LIMIT + 1)
        reports = self.store.reports(scope, limit=GRAPH_REPORT_LIMIT + 1)
        warnings = []
        if len(observations) > GRAPH_OBSERVATION_LIMIT or len(reports) > GRAPH_REPORT_LIMIT:
            warnings.append('Карта неполная: достигнут предел отображения наблюдений. Выберите конкретную сеть, чтобы сузить данные.')
        for observation in observations[:GRAPH_OBSERVATION_LIMIT]:
            network = networks.get(observation['network'])
            if not network:
                continue
            address = observation['ip']
            node = {'id': 'observed:' + network['id'] + ':' + address, 'name': address,
                'kind': 'unknown', 'management_ip': address, 'ports': [], 'netbox_url': '',
                'config_url': '', 'config_history_url': '',
                'details': {'source': 'network:' + network['id'], 'observation_methods': json.loads(observation['methods']),
                            'last_seen': observation['last_seen'], 'observation_state': observation['state']}}
            observed_nodes[(network['id'], address)] = node
            nodes.append(node)
        for report in reports[:GRAPH_REPORT_LIMIT]:
            network = networks.get(report['network'])
            address = report['ip']
            if not network:
                continue
            key = (network['id'], address)
            node = observed_nodes.get(key)
            expired = bool(report['expires_at'] and datetime.fromisoformat(report['expires_at']) <= datetime.now(timezone.utc))
            report_state = 'stale' if expired else 'reported'
            if node is None:
                node = {'id': 'observed:' + network['id'] + ':' + address, 'name': address,
                    'kind': 'unknown', 'management_ip': address, 'ports': [], 'netbox_url': '', 'config_url': '', 'config_history_url': '',
                    'details': {'source': 'network:' + network['id'], 'observation_methods': [],
                                'observation_state': report_state}}
                observed_nodes[key] = node
                nodes.append(node)
            details = node['details']
            details.setdefault('reports', []).append({'source': report['source'], 'hostname': report['hostname'], 'mac': report['mac'],
                'methods': json.loads(report['methods']), 'observed_at': report['observed_at'], 'expires_at': report['expires_at'], 'state': report_state})
            if report_state == 'reported' and details['observation_state'] == 'stale':
                details['observation_state'] = 'reported'
        for node in observed_nodes.values():
            # Names are presentation hints only. Keep every source report and
            # prefer the most recent non-expired name, with a stable tie-break.
            names = [(item['observed_at'], item['source'], item['hostname'])
                     for item in node['details'].get('reports', [])
                     if item['state'] == 'reported' and item['hostname']]
            if names:
                node['name'] = max(names)[2]
            source = node['details']['source']
            matches = sorted(item['details']['netbox_id'] for item in inventory_by_ip.get(node['management_ip'], [])
                if not str(item['details'].get('source') or '').startswith('network:') or item['details']['source'] == source)
            if matches:
                node['details']['inventory_matches'] = matches
                node['details']['identity_unconfirmed'] = True
        for cable in cables:
            # Physical authority is explicit NetBox Cable only. Never infer from ARP/FDB.
            a, b = cable.get('a_terminations') or [], cable.get('b_terminations') or []
            if len(a) != 1 or len(b) != 1:
                continue
            left, right = a[0].get('object') or {}, b[0].get('object') or {}
            da, db = (left.get('device') or {}).get('id'), (right.get('device') or {}).get('id')
            if da not in device_ids or db not in device_ids:
                continue
            edges.append({'id': 'cable:' + str(cable['id']), 'source': 'device:' + str(da), 'target': 'device:' + str(db),
                'source_port': left.get('name'), 'target_port': right.get('name'), 'kind': 'physical', 'status': 'documented',
                'details': {'relationship': {'authority': 'netbox', 'cable_id': cable['id'], 'assurance': 'registered'}}})
        return {'schema_version': 1, 'generated_at': now, 'site': {'id': 'network-' + selected['id'] if selected else 'network', 'name': selected['name'] if selected else 'Сеть', 'slug': 'network-' + selected['id'] if selected else 'network'},
            'nodes': nodes, 'edges': edges, 'sources': [{'id': 'netbox', 'status': 'ok', 'last_success': now}],
            'warnings': warnings, 'coverage': {}, 'rack_items': []}

    def probe(self, address, profile, deadline=None):
        # net-snmp config carries credentials; argv/logs carry neither community nor device passwords.
        if deadline is not None and time.monotonic() >= deadline:
            return None
        community = profile.get('snmp_community')
        if not community:
            raise ValueError('SNMP profile required')
        def timeout():
            remaining = 5 if deadline is None else min(5, deadline - time.monotonic())
            if remaining <= 0:
                raise subprocess.TimeoutExpired('bounded SNMP probe', 0)
            return remaining
        with tempfile.TemporaryDirectory(prefix='pl-snmp-') as directory:
            config = Path(directory, 'snmp.conf')
            config.write_text('defVersion 2c\ndefCommunity ' + community + '\n')
            config.chmod(0o600)
            env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'SNMPCONFPATH': directory, 'MIBS': ''}
            target = 'udp6:[' + address + ']' if ipaddress.ip_address(address).version == 6 else address
            try:
                result = subprocess.run(['snmpget', '-On', '-Oqv', '-t', '1', '-r', '1', target, '1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.1.0'],
                    env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout(), check=False)
            except subprocess.TimeoutExpired:
                return None
            if result.returncode:
                return None
            lines = result.stdout.decode('utf-8', errors='replace').splitlines()
            if len(lines) != 2 or any('No Such' in item for item in lines):
                return None
            interfaces = {}
            columns = {'name': '1.3.6.1.2.1.31.1.1.1.1', 'description': '1.3.6.1.2.1.2.2.1.2',
                       'alias': '1.3.6.1.2.1.31.1.1.1.18', 'type': '1.3.6.1.2.1.2.2.1.3',
                       'admin_status': '1.3.6.1.2.1.2.2.1.7', 'oper_status': '1.3.6.1.2.1.2.2.1.8'}
            table_errors = 0
            for column, oid in columns.items():
                if deadline is not None and time.monotonic() >= deadline:
                    table_errors += 1
                    break
                try:
                    walk = subprocess.run(['snmpwalk', '-On', '-OQ', '-Oe', '-t', '1', '-r', '1', target, oid],
                        env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout(), check=False)
                except subprocess.TimeoutExpired:
                    table_errors += 1
                    continue
                if walk.returncode or len(walk.stdout) > 256 * 1024:
                    table_errors += 1
                    continue
                for line in walk.stdout.decode('utf-8', errors='replace').splitlines()[:1024]:
                    match = re.fullmatch(r'\.?' + re.escape(oid) + r'\.(\d+)\s*=\s*(.*)', line)
                    if match:
                        value = match[2]
                        # Net-SNMP prints exception values against the last OID.
                        # Keep quoted strings as data, including exception-like aliases.
                        if value == 'No more variables left in this MIB View (It is past the end of the MIB tree)' or value.startswith(('No Such Object', 'No Such Instance')):
                            continue
                        interfaces.setdefault(match[1], {'index': match[1]})[column] = value.strip('"')[:1024]
            return {'ip': address, 'name': lines[0].strip('"')[:64], 'description': lines[1].strip('"')[:2048],
                    'interfaces': list(interfaces.values())[:1024], 'table_errors': table_errors}

    def probe_host(self, address, deadline):
        """Bounded address reachability; a refusal alone does not identify a host."""
        methods, warnings = [], []
        if time.monotonic() >= deadline:
            return {'ip': address, 'methods': methods, 'warnings': warnings}
        try:
            result = subprocess.run(['ping', '-n', '-c', '1', '-W', '1', address],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=min(2, max(0.01, deadline - time.monotonic())), check=False)
            if result.returncode == 0:
                methods.append('icmp')
            elif result.returncode != 1:
                warnings.append('icmp_unavailable')
        except (FileNotFoundError, PermissionError):
            warnings.append('icmp_unavailable')
        except subprocess.TimeoutExpired:
            pass
        # A small fixed set bounds traffic and works without privileges. No
        # payload, banner grab, DNS lookup or UDP scanning is performed.
        for port in (22, 80, 443, 445, 3389):
            if time.monotonic() >= deadline:
                break
            try:
                with socket.create_connection((address, port), timeout=min(0.2, max(0.01, deadline - time.monotonic()))):
                    methods.append('tcp:' + str(port))
            except OSError:
                pass
        return {'ip': address, 'methods': methods, 'warnings': warnings}

    def import_observations(self, network_id, body):
        """Import explicit, time-stamped reports without treating leases as live probes."""
        network = next((item for item in self.store.networks() if item['id'] == network_id), None)
        if not network:
            raise RequestError('netmap_network_missing')
        if (not isinstance(body, dict) or set(body) != {'source', 'records'} or
                not isinstance(body['source'], str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,64}', body['source']) or
                not isinstance(body['records'], list) or len(body['records']) > 4096):
            raise RequestError('netmap_invalid_observations')
        now = datetime.now(timezone.utc)
        cidr = ipaddress.ip_network(network['cidr'])
        records, seen = [], set()
        def timestamp(value):
            if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)', value):
                raise ValueError('invalid timestamp')
            return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
        try:
            for row in body['records']:
                if not isinstance(row, dict) or set(row) - {'ip', 'hostname', 'mac', 'methods', 'observed_at', 'expires_at'} or not {'ip', 'methods'} <= set(row):
                    raise ValueError('invalid record')
                if not isinstance(row['ip'], str):
                    raise ValueError('invalid address')
                ip = ipaddress.ip_address(row['ip'])
                address = str(ip)
                if ip not in cidr or address in seen or ip.is_multicast or ip.is_unspecified:
                    raise ValueError('invalid or duplicate address')
                seen.add(address)
                hostname, mac, methods = row.get('hostname', ''), row.get('mac', ''), row['methods']
                if (not isinstance(hostname, str) or len(hostname) > 253 or any(ord(c) < 32 or ord(c) == 127 for c in hostname) or
                        not isinstance(mac, str) or (mac and not re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}', mac)) or
                        not isinstance(methods, list) or not methods or len(methods) > 3 or
                        any(not isinstance(method, str) or method not in ('dhcp', 'arp', 'wifi') for method in methods) or len(set(methods)) != len(methods)):
                    raise ValueError('invalid observation')
                observed_at = timestamp(row['observed_at']) if 'observed_at' in row else now
                expires_at = timestamp(row['expires_at']) if 'expires_at' in row else None
                if observed_at > now:
                    raise ValueError('future observation')
                records.append({'ip': address, 'hostname': hostname, 'mac': mac.lower(), 'methods': methods,
                                'observed_at': observed_at.isoformat(timespec='microseconds'),
                                'expires_at': expires_at.isoformat(timespec='microseconds') if expires_at else ''})
        except (TypeError, ValueError, OverflowError):
            raise RequestError('netmap_invalid_observations') from None
        self.store.record_reports(network_id, body['source'], records)
        return {'accepted': len(records), 'source': body['source']}

    def enroll(self, network, observed):
        source = 'network:' + network['id']
        # Stable identity includes the source and collector IP, never a guessed MAC/OUI identity.
        managed = self.netbox.all('/dcim/devices/', cf_pl_source=source, cf_collector_ip=observed['ip'])
        if len(managed) > 1:
            raise ValueError('Ambiguous source-scoped inventory')
        fields = {'pl_source': source, 'collector_ip': observed['ip'], 'pl_observed_name': observed['name'], 'pl_observed_description': observed['description']}
        if managed:
            current, version = self.netbox.request('GET', '/dcim/devices/' + str(managed[0]['id']) + '/', include_version=True)
            current_fields = current.get('custom_fields') or {}
            if current_fields.get('pl_source') != source or current_fields.get('collector_ip') != observed['ip']:
                raise ValueError('Source-scoped inventory changed')
            # Discovery updates observations only. Existing SSH binding/default
            # choices, model overrides, tags and unrelated native fields stay owned by the user.
            patch = {'custom_fields': {'pl_observed_name': observed['name'],
                                      'pl_observed_description': observed['description']}}
            self.netbox.request('PATCH', '/dcim/devices/' + str(current['id']) + '/', patch, version=version)
            return current['id']
        site = self.netbox.get_or_create('/dcim/sites/', {'slug': 'pl-network-' + network['id']}, {'name': network['name'], 'slug': 'pl-network-' + network['id'], 'status': 'active'})
        manufacturer = self.netbox.get_or_create('/dcim/manufacturers/', {'slug': 'pl-discovered'}, {'name': 'Discovered', 'slug': 'pl-discovered'})
        dtype = self.netbox.get_or_create('/dcim/device-types/', {'slug': 'pl-discovered'}, {'manufacturer': manufacturer['id'], 'model': 'Discovered', 'slug': 'pl-discovered'})
        role = self.netbox.get_or_create('/dcim/device-roles/', {'slug': 'pl-network'}, {'name': 'Network device', 'slug': 'pl-network', 'color': '2196f3'})
        tag = self.netbox.all('/extras/tags/', slug='pl-managed')[0]
        suffix = hashlib.sha256((source + ':' + observed['ip']).encode()).hexdigest()[:12]
        name = ''.join(char for char in observed['name'] if ord(char) >= 32 and ord(char) != 127).strip()[:64] or observed['ip']
        if self.netbox.all('/dcim/devices/', name=name, site_id=site['id']):
            name = name[:51] + '-' + suffix
        profile = self.store.profile(network['profile']) or {}
        tags = [tag['id']]
        if profile.get('oxidized_model') and profile.get('username') and profile.get('password'):
            fields.update(collector_profile=network['profile'], oxidized_model='')
            tags += [self.netbox.all('/extras/tags/', slug='network-config-backup')[0]['id']]
        node = self.netbox.request('POST', '/dcim/devices/', {'name': name, 'site': site['id'], 'role': role['id'], 'device_type': dtype['id'], 'status': 'active', 'tags': tags, 'custom_fields': fields})
        return node['id']

    def sync_interfaces(self, network, device_id, observations):
        result = {'interfaces_created': 0, 'interfaces_updated': 0, 'manual_conflicts': 0, 'errors': 0}
        existing = self.netbox.all('/dcim/interfaces/', device_id=device_id)
        source = 'network:' + network['id']
        by_index = {}
        for interface in existing:
            fields = interface.get('custom_fields') or {}
            if fields.get('pl_source') == source and fields.get('pl_if_index'):
                if fields['pl_if_index'] in by_index:
                    result['errors'] += 1
                else:
                    by_index[fields['pl_if_index']] = interface
        for observed in observations[:1024]:
            index = observed.get('index', '')
            if not re.fullmatch(r'[0-9]{1,10}', index):
                result['errors'] += 1
                continue
            fields = {'pl_source': source, 'pl_if_index': index,
                'pl_observed_if_name': observed.get('name', observed.get('description', '')),
                'pl_observed_if_alias': observed.get('alias', ''), 'pl_observed_if_type': observed.get('type', ''),
                'pl_observed_admin_status': observed.get('admin_status', ''), 'pl_observed_oper_status': observed.get('oper_status', '')}
            try:
                current = by_index.get(index)
                if current:
                    # Source observation fields only: retain name/type/description/enabled and every manual field.
                    self.netbox.request('PATCH', '/dcim/interfaces/' + str(current['id']) + '/',
                        {'custom_fields': {**(current.get('custom_fields') or {}), **fields}})
                    result['interfaces_updated'] += 1
                else:
                    name = observed.get('name') or observed.get('description') or 'ifIndex-' + index
                    name = ''.join(c for c in name if ord(c) >= 32)[:64]
                    if any(item['name'] == name for item in existing):
                        result['manual_conflicts'] += 1
                        continue
                    interface = self.netbox.request('POST', '/dcim/interfaces/', {'device': device_id, 'name': name,
                        'type': 'virtual' if observed.get('type') == '24' else 'other',
                        'description': observed.get('alias', '')[:200], 'enabled': observed.get('admin_status') == '1', 'custom_fields': fields})
                    existing.append(interface)
                    result['interfaces_created'] += 1
            except Exception:
                result['errors'] += 1
        return result

    def start_poll(self, network_id, operation, actor):
        if not self.poll_lock.acquire(blocking=False):
            raise RequestError('netmap_poll_running')
        network = next((item for item in self.store.networks() if item['id'] == network_id), None)
        profile = self.store.profile(network['profile']) if network and network['profile'] else {}
        if not network:
            self.poll_lock.release()
            raise RequestError('netmap_network_missing')
        if profile is None:
            self.poll_lock.release()
            raise RequestError('netmap_profile_missing')
        try:
            self.snmp_candidates(network)
        except Exception:
            self.poll_lock.release()
            raise
        try:
            with self.store.connect() as db:
                db.execute('INSERT INTO polls(id,network,state,result,actor) VALUES(?,?,?,?,?)', (operation, network_id, 'running', '{}', actor))
        except Exception:
            self.poll_lock.release()
            raise
        def worker():
            try:
                self.poll(network_id, operation, actor, admitted=True)
            except Exception:
                pass  # poll persists a terminal safe error; no credentials in logs.
        try:
            threading.Thread(target=worker, daemon=True, name='pl-network-poll').start()
        except Exception:
            self.poll_lock.release()
            with self.store.connect() as db:
                db.execute("UPDATE polls SET state='error',result=? WHERE id=?", (json.dumps({'error': 'poll worker unavailable'}), operation))
            raise
        return {'id': operation, 'state': 'running'}

    def poll(self, network_id, operation, actor, admitted=False):
        if not admitted and not self.poll_lock.acquire(blocking=False):
            raise ValueError('Another explicit poll is running')
        counters, found = {}, []
        try:
            network = next((item for item in self.store.networks() if item['id'] == network_id), None)
            if network is None:
                raise ValueError('Unknown network')
            cidr = canonical_network(network['cidr'])
            candidates = self.snmp_candidates(network)
            if not admitted:
                with self.store.connect() as db:
                    db.execute('INSERT INTO polls(id,network,state,result,actor) VALUES(?,?,?,?,?)', (operation, network_id, 'running', '{}', actor))
            found = []
            counters = {'targets_total': sum(1 for _ in ipaddress.ip_network(cidr).hosts()), 'responders': 0, 'unresponsive': 0,
                        'interfaces_created': 0, 'interfaces_updated': 0, 'manual_conflicts': 0, 'errors': 0}
            deadline = time.monotonic() + 600
            host_observations, warnings, snmp_attempts = [], set(), []
            def inspect(address):
                address = str(address)
                observed, attempts = self.probe_profiles(address, candidates, deadline)
                # Do not assign an SNMP/SSH profile to an address that only
                # answered ping or TCP, and do not duplicate an SNMP device.
                return address, observed, None if observed else self.probe_host(address, deadline), attempts
            with ThreadPoolExecutor(max_workers=8) as pool:
                for address, observed, host, attempts in pool.map(inspect, ipaddress.ip_network(cidr).hosts()):
                    if attempts:
                        snmp_attempts.append({'ip': address, 'attempts': attempts})
                    if time.monotonic() > deadline:
                        raise ValueError('Explicit network poll exceeded ten minutes')
                    if observed:
                        counters['responders'] += 1
                        counters['errors'] += observed.get('table_errors', 0)
                        try:
                            device_id = self.enroll(network, observed)
                            found.append(device_id)
                            for key, count in self.sync_interfaces(network, device_id, observed.get('interfaces', [])).items():
                                counters[key] += count
                        except Exception:
                            counters['errors'] += 1
                    elif host and host['methods']:
                        counters['responders'] += 1
                        host_observations.append(host)
                    else:
                        counters['unresponsive'] += 1
                    if host:
                        warnings.update(host['warnings'])
            self.store.record_observations(network_id, host_observations, datetime.now(timezone.utc).isoformat())
            collector = self.reload_collector(deadline)
            result = {**counters, 'devices': len(found), 'device_ids': found, 'observed_hosts': len(host_observations),
                      'warnings': sorted(warnings), 'collector': collector, 'snmp_attempts': snmp_attempts}
            with self.store.connect() as db:
                db.execute('UPDATE polls SET state=?,result=? WHERE id=?', ('error' if counters['errors'] else 'complete', json.dumps(result), operation))
            return result
        except Exception:
            with self.store.connect() as db:
                db.execute("UPDATE polls SET state='error',result=? WHERE id=?", (json.dumps({**counters, 'devices': len(found), 'error': 'poll incomplete; review inventory before retry'}), operation))
            raise
        finally:
            self.poll_lock.release()

    def mutation(self, path, body, claims):
        operation = claims['idempotency_key']
        fingerprint = hashlib.sha256(path.encode() + b'\n' + json_bytes(body)).hexdigest()
        with self.mutation_lock:
            with self.store.connect() as db:
                previous = db.execute('SELECT digest,response FROM requests WHERE id=?', (operation,)).fetchone()
                if previous:
                    if previous[0] != fingerprint:
                        raise RequestError('netmap_idempotency_conflict')
                    return json.loads(previous[1])
                # Reserve BEFORE side effects. Interrupted operations remain explicit errors;
                # automatic replay must never launch a second scan.
                db.execute('INSERT INTO requests VALUES(?,?,?)', (operation, fingerprint, json.dumps({'error': 'operation interrupted; inspect before explicit retry'})))
            if path == '/api/networks':
                if set(body) not in ({'cidr', 'name', 'profile'}, {'cidr', 'name', 'profile', 'snmp_profiles'}) or not isinstance(body['name'], str) or not 1 <= len(body['name']) <= 128 or not isinstance(body['profile'], str) or not re.fullmatch(r'[a-z0-9_-]{0,64}', body['profile']):
                    raise RequestError('netmap_invalid_network')
                snmp_profiles = body.get('snmp_profiles')
                if 'snmp_profiles' in body:
                    if (not isinstance(snmp_profiles, list) or len(snmp_profiles) > 4
                            or any(not isinstance(name, str) or not re.fullmatch(r'[a-z0-9_-]{1,64}', name) for name in snmp_profiles)
                            or len(set(snmp_profiles)) != len(snmp_profiles)
                            or any(not (self.store.profile(name) or {}).get('snmp_community') for name in snmp_profiles)):
                        raise RequestError('netmap_invalid_snmp_profiles')
                cidr = canonical_network(body['cidr'])
                network_id = hashlib.sha256(cidr.encode()).hexdigest()[:16]
                with self.store.connect() as db:
                    if not db.execute('SELECT 1 FROM networks WHERE id=?', (network_id,)).fetchone() and db.execute('SELECT COUNT(*) FROM networks').fetchone()[0] >= 128:
                        raise RequestError('netmap_network_limit')
                    db.execute('INSERT INTO networks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,profile=excluded.profile', (network_id, cidr, body['name'], body['profile']))
                    if 'snmp_profiles' in body:
                        db.execute('INSERT INTO network_snmp_profiles VALUES(?,?) ON CONFLICT(network) DO UPDATE SET profiles=excluded.profiles',
                                   (network_id, json.dumps(snmp_profiles)))
                result = {'id': network_id, 'cidr': cidr}
            elif path == '/api/profiles':
                if set(body) - {'id', 'snmp_community', 'username', 'password', 'oxidized_model', 'ssh_known_hosts'} or not re.fullmatch(r'[a-z0-9_-]{1,64}', body.get('id', '')) or any(not isinstance(v, str) or len(v) > (65536 if key == 'ssh_known_hosts' else 1024) or any(ord(c) < 32 and not (key == 'ssh_known_hosts' and c == '\n') for c in v) for key, v in body.items()):
                    raise RequestError('netmap_invalid_profile')
                if 'ssh_known_hosts' in body:
                    for line in body['ssh_known_hosts'].splitlines():
                        fields = line.split()
                        if len(fields) != 3 or not re.fullmatch(r'(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))', fields[1]):
                            raise RequestError('netmap_invalid_ssh_trust')
                        try:
                            ipaddress.ip_address(fields[0])
                            key = base64.b64decode(fields[2], validate=True)
                        except ValueError:
                            raise RequestError('netmap_invalid_ssh_trust') from None
                        if not 32 <= len(key) <= 8192:
                            raise RequestError('netmap_invalid_ssh_trust')
                if body.get('oxidized_model') and not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', body['oxidized_model']):
                    raise RequestError('netmap_invalid_model')
                if any(c.isspace() or c in '#\\"' for c in body.get('snmp_community', '')):
                    raise RequestError('netmap_invalid_snmp_community')
                body = {**(self.store.profile(body['id']) or {}), **body}
                with self.store.connect() as db:
                    if not db.execute('SELECT 1 FROM profiles WHERE id=?', (body['id'],)).fetchone() and db.execute('SELECT COUNT(*) FROM profiles').fetchone()[0] >= 128:
                        raise RequestError('netmap_profile_limit')
                    db.execute('INSERT INTO profiles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (body['id'], json.dumps(body)))
                result = {'id': body['id']}
            elif match := re.fullmatch(r'/api/devices/([1-9][0-9]{0,14})/(ssh-binding|collect)', path):
                if not self.poll_lock.acquire(blocking=False):
                    raise RequestError('netmap_poll_running')
                try:
                    device = int(match[1])
                    result = self.save_device_binding(device, body) if match[2] == 'ssh-binding' else self.collect_device(device, body, operation, claims['sub'])
                finally:
                    self.poll_lock.release()
            elif re.fullmatch(r'/api/networks/[a-f0-9]{16}/poll', path) and body == {}:
                result = self.start_poll(path.split('/')[3], operation, claims['sub'])
            elif re.fullmatch(r'/api/networks/[a-f0-9]{16}/observations', path):
                result = self.import_observations(path.split('/')[3], body)
            elif re.fullmatch(r'/api/networks/[a-f0-9]{16}/remove', path) and body == {}:
                with self.store.connect() as db:
                    if db.execute("SELECT 1 FROM polls WHERE network=? AND state='running'", (path.split('/')[3],)).fetchone():
                        raise RequestError('netmap_poll_running')
                    db.execute('DELETE FROM networks WHERE id=?', (path.split('/')[3],))
                    db.execute('DELETE FROM network_snmp_profiles WHERE network=?', (path.split('/')[3],))
                # Inventory and Gitea history survive network removal.
                result = {'removed': True}
            else:
                raise ValueError('Unsupported NetMap mutation')
            with self.store.connect() as db:
                db.execute('UPDATE requests SET response=? WHERE id=?', (json.dumps(result), operation))
            return result


def make_handler(application, map_handler):
    class Handler(map_handler):
        def log_message(self, *args):
            pass

        def json(self, status, value):
            data = json_bytes(value)
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(data)

        def dispatch(self):
            try:
                if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Encoding'):
                    raise ValueError('Unsupported request framing')
                lengths = self.headers.get_all('Content-Length') or []
                if len(lengths) > 1 or lengths and not re.fullmatch(r'\d{1,8}', lengths[0]):
                    raise ValueError('Invalid request length')
                length = int(lengths[0]) if lengths else 0
                if length > MAX_BODY:
                    return self.json(413, {'error': 'request too large'})
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError('Incomplete body')
                if self.path == '/healthz' and self.command in ('GET', 'HEAD'):
                    try:
                        application.bootstrap()
                        collector = application.collector_status()
                        return self.json(200, {'status': 'ready', 'version': '1.0.0', 'collector': collector})
                    except Exception:
                        return self.json(503, {'status': 'initializing'})
                if self.path in ('/internal/oxidized/nodes', '/internal/oxidized/trust', '/internal/bootstrap') and self.command == 'GET':
                    expected = 'Basic ' + base64.b64encode(('oxidized:' + application.config['source_password']).encode()).decode()
                    if not hmac.compare_digest(self.headers.get('Authorization', ''), expected):
                        return self.json(401, {'error': 'source authorization required'})
                    return self.json(200, application.nodes() if self.path.endswith('/nodes') else application.trust() if self.path.endswith('/trust') else application.bootstrap())
                parsed = urllib.parse.urlsplit(self.path)
                if (not parsed.path.startswith('/netmap/') or any(c in parsed.path for c in ('%', '\\', '//'))
                        or '..' in parsed.path.split('/') or parsed.fragment):
                    raise ValueError('Invalid NetMap route')
                path = parsed.path.removeprefix('/netmap')
                native = next((name for name in NATIVE if path.startswith('/' + name + '/')), None)
                write = self.command not in ('GET', 'HEAD')
                scope = 'netmap:admin' if native or write or path.startswith(('/api/networks', '/api/profiles', '/api/polls', '/api/devices')) else 'netmap:read'
                asgi = {'method': self.command, 'raw_path': parsed.path.encode('ascii'), 'query_string': parsed.query.encode('ascii'),
                    'headers': [(k.lower().encode(), v.encode('latin1')) for k, v in self.headers.raw_items()]}
                claims = application.verifier.verify(asgi, body, required_scope=scope)
                if native:
                    return self.proxy(native, parsed, body)
                if path == '/api/instance':
                    if self.command not in ('GET', 'HEAD') or body or parsed.query:
                        raise ValueError('Unsupported NetMap descriptor request')
                    return self.json(200, application.descriptor())
                if self.command == 'POST':
                    if path.startswith('/api/devices') and parsed.query:
                        raise ValueError('Invalid device mutation query')
                    if self.headers.get_content_type() != 'application/json':
                        raise ValueError('JSON body required')
                    return self.json(200, application.mutation(path, json.loads(body), claims))
                if self.command not in ('GET', 'HEAD') or body:
                    raise ValueError('Unsupported NetMap method')
                if path == '/api/networks':
                    return self.json(200, application.networks_view())
                if path == '/api/devices':
                    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
                    if (set(query) != {'network'} or len(query['network']) != 1
                            or not re.fullmatch(r'[a-f0-9]{16}', query['network'][0])):
                        raise ValueError('Invalid device network query')
                    return self.json(200, application.devices(query['network'][0]))
                if match := re.fullmatch(r'/api/devices/([1-9][0-9]{0,14})', path):
                    if parsed.query:
                        raise ValueError('Invalid device detail query')
                    return self.json(200, application.device_details(int(match[1])))
                if path == '/api/profiles':
                    with application.store.connect() as db:
                        profiles = []
                        for row in db.execute('SELECT id,payload FROM profiles ORDER BY id'):
                            profile = json.loads(row[1])
                            profiles.append({'id': row[0], 'username': profile.get('username', ''), 'oxidized_model': profile.get('oxidized_model', ''), 'password_set': bool(profile.get('password')), 'snmp_community_set': bool(profile.get('snmp_community')), 'ssh_known_hosts_set': bool(profile.get('ssh_known_hosts'))})
                        return self.json(200, {'items': profiles})
                if path == '/api/polls':
                    with application.store.connect() as db:
                        items = []
                        for row in db.execute('SELECT * FROM polls ORDER BY rowid DESC LIMIT 100'):
                            item = dict(row)
                            item['result'] = json.loads(item['result'])
                            item['error'] = item['result'].get('error', 'Some probes or interface updates failed' if item['state'] == 'error' else '')
                            items.append(item)
                        return self.json(200, {'items': items})
                original = self.path
                try:
                    self.path = path + ('?' + parsed.query if parsed.query else '')
                    return super().do_GET() if self.command == 'GET' else super().do_HEAD()
                finally:
                    self.path = original
            except GatewayError as exc:
                self.json(exc.status, {'error': exc.code})
            except RequestError as exc:
                self.json(exc.status, {'error': exc.code})
            except (ValueError, KeyError, TypeError, json.JSONDecodeError, sqlite3.IntegrityError):
                self.json(400, {'error': 'invalid NetMap request'})
            except Exception:
                self.json(502, {'error': 'NetMap operation unconfirmed'})

        def proxy(self, role, parsed, body):
            if self.command not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'):
                raise ValueError('Unsupported native method')
            host, port = NATIVE[role]
            # Only these explicit native applications can receive browser cookies.
            # Gateway assertions, portal auth and Authorization are never forwarded.
            headers = {name: value for name, value in self.headers.items() if name.lower() in ('accept', 'accept-language', 'content-type', 'cookie', 'origin', 'referer', 'x-csrftoken', 'x-pl-native-csrf-token', 'if-none-match')}
            native_csrf = next((value for name, value in headers.items() if name.lower() == 'x-pl-native-csrf-token'), None)
            headers = {name: value for name, value in headers.items() if name.lower() != 'x-pl-native-csrf-token'}
            if native_csrf:
                headers['X-CSRF-Token'] = native_csrf
            allowed_cookies = {'pl_netbox_sessionid', 'pl_netbox_csrftoken', 'messages'} if role == 'netbox' else {'pl_gitea_session', '_csrf', 'i_like_gitea', 'redirect_to'} if role == 'gitea' else set()
            cookies = []
            for item in headers.pop('Cookie', headers.pop('cookie', '')).split(';'):
                if '=' in item and item.split('=', 1)[0].strip() in allowed_cookies:
                    cookies.append(item.strip())
            if cookies:
                headers['Cookie'] = '; '.join(cookies)
            headers['Host'] = application.config['hostname']
            headers['X-Forwarded-Proto'] = 'https'
            headers['Content-Length'] = str(len(body))
            # ROOT_URL gives Gitea its public links/cookie path, while its
            # listener serves the root namespace behind a stripping proxy.
            path = parsed.path.removeprefix('/netmap/gitea') if role == 'gitea' else parsed.path
            # Django's BASE_PATH prefixes asset URLs, but the pinned upstream
            # Granian launcher serves them at /static. Keep Django routes intact.
            if role == 'netbox' and self.command in ('GET', 'HEAD') and path.startswith('/netmap/netbox/static/'):
                path = path.removeprefix('/netmap/netbox')
            path = path or '/'
            path += ('?' + parsed.query) if parsed.query else ''
            connection = http.client.HTTPConnection(host, port, timeout=30)
            try:
                connection.request(self.command, path, body=body or None, headers=headers)
                response = connection.getresponse()
                data = response.read(MAX_RESPONSE + 1)
                if len(data) > MAX_RESPONSE:
                    raise ValueError('Native response exceeds limit')
                for name, value in response.getheaders():
                    if name.lower() == 'location':
                        location = urllib.parse.urlsplit(value)
                        if location.netloc and (location.netloc != application.config['hostname'] or location.scheme not in ('', 'https')):
                            raise ValueError('Unexpected native redirect')
                self.send_response(response.status)
                for name, value in response.getheaders():
                    if name.lower() in ('content-type', 'content-disposition', 'cache-control', 'etag', 'set-cookie', 'location', 'vary'):
                        if name.lower() == 'location':
                            # Reject redirects to an arbitrary external origin.
                            location = urllib.parse.urlsplit(value)
                            if location.netloc and location.netloc != application.config['hostname']:
                                raise ValueError('Unexpected native redirect')
                        self.send_header(name, value)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(data)
            except (OSError, http.client.HTTPException):
                if role == 'oxidized':
                    try:
                        unconfigured = not application._collector_expected()
                    except Exception:
                        raise RuntimeError('Owned collector source unavailable') from None
                    if unconfigured:
                        return self.json(409, {'error': 'collection_not_configured', 'message': 'Нет устройств с профилем доступа Oxidized. Настройте профиль и выполните опрос выбранной сети.'})
                raise
            finally:
                connection.close()
        do_GET = dispatch
        do_HEAD = dispatch
        do_POST = dispatch
        do_PUT = dispatch
        do_PATCH = dispatch
        do_DELETE = dispatch
    return Handler


def main():
    application = Application()
    import sys
    sys.path.insert(0, '/opt/netmap')
    spec = importlib.util.spec_from_file_location('pl_existing_netmap', '/opt/netmap/app.py')
    source = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(source)
    handler = source.make_handler(application.graph, application.configuration)
    ThreadingHTTPServer(('0.0.0.0', 8092), make_handler(application, handler)).serve_forever()


if __name__ == '__main__':
    main()
