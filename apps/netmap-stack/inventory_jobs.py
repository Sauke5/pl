"""Bounded, persistent inventory jobs for explicitly configured targets.

Shares the adapter SQLite file; collectors and NetBox writes have separate
boundaries. Credentials never enter job records or HTTP results.
"""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import re
import socket
import threading
import time
import uuid

from inventory_collectors import (
    DRIVERS, InventoryCollectionError, collect, host_key_name, ssh_host_pins, validate_profile, validate_ssh_host_key,
)
from inventory_netbox import sync_snapshot

UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z')
ACTIVE = ('queued', 'running')
SECRETS = ('password', 'private_key', 'passphrase', 'enable_password', 'ssh_known_hosts', 'ca_pem')
PROFILE_KEYS = {'id', 'name', 'kind', 'username', 'port', 'driver', 'scheme', 'transport', 'auth_method', 'clear_secrets', *SECRETS}
TARGET_KEYS = {'id', 'name', 'kind', 'address', 'profile_id', 'network_id', 'interval_minutes', 'ssh_host_key', 'replace_ssh_host_key'}
ENROLL_KEYS = (TARGET_KEYS - {'id', 'replace_ssh_host_key'}) | {'profile'}
KIND = ('network', 'linux', 'windows')


class InventoryError(ValueError):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def now():
    return datetime.now(timezone.utc).isoformat()


def address(value):
    try:
        if not isinstance(value, str) or '%' in value:
            raise ValueError()
        ip = ipaddress.ip_address(value)
        if (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified
                or isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped
                or str(ip) in ('100.100.100.200', 'fd00:ec2::254', '255.255.255.255')):
            raise ValueError()
        return str(ip)
    except ValueError:
        raise InventoryError('inventory_invalid_address') from None


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise InventoryError('inventory_invalid_id')
    return value


def text(value, limit=128):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 for c in value):
        raise InventoryError('inventory_invalid_name')
    return value.strip()


def read_ssh_host_key(ip, port):
    """Stop after key exchange. There is no SSH login or trust-on-first-use write."""
    try:
        import paramiko
    except ImportError:
        raise InventoryError('inventory_dependency_missing', 503) from None
    deadline = time.monotonic() + 8
    try:
        with socket.create_connection((ip, port), timeout=3) as connection:
            transport = paramiko.Transport(connection)
            try:
                remaining = max(0.1, deadline - time.monotonic())
                transport.banner_timeout = remaining
                transport.start_client(timeout=remaining)
                if time.monotonic() >= deadline:
                    raise TimeoutError()
                key = transport.get_remote_server_key()
                digest = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
                return {'algorithm': key.get_name(), 'fingerprint': 'SHA256:' + digest,
                        'known_hosts': f'{host_key_name(ip, port)} {key.get_name()} {key.get_base64()}'}
            finally:
                transport.close()
    except TimeoutError:
        raise InventoryError('inventory_timeout', 422) from None
    except (OSError, EOFError, paramiko.SSHException):
        raise InventoryError('inventory_connection_failed', 422) from None


def without_ssh_host_pin(known_hosts, expected):
    remaining = []
    for line in known_hosts.splitlines(keepends=True):
        content = line.lstrip()
        parts = content.split(maxsplit=1)
        if len(parts) == 2 and not parts[0].startswith('#'):
            aliases = parts[0].split(',')
            if expected in aliases:
                others = [host for host in aliases if host != expected]
                if not others:
                    continue
                line = line[:len(line) - len(content)] + ','.join(others) + content[len(parts[0]):]
        remaining.append(line)
    return ''.join(remaining)


def profile_for_host(profile, ip, body, *, replace=False):
    supplied = 'ssh_host_key' in body
    if profile['kind'] == 'windows':
        if supplied:
            raise InventoryError('inventory_invalid_target')
        return profile
    expected = host_key_name(ip, profile.get('port', 22))
    known_hosts = profile.get('ssh_known_hosts', '')
    pins = ssh_host_pins(known_hosts, expected)
    if not pins and (replace or not supplied):
        raise InventoryError('inventory_host_key_required', 422)
    if not supplied:
        return profile
    try:
        confirmed = validate_ssh_host_key(body['ssh_host_key'], expected)
        if pins and not replace:
            _, algorithm, encoded = confirmed.split()
            raw = base64.b64decode(encoded, validate=True)
            if not any(kind == algorithm and base64.b64decode(pin, validate=True) == raw for kind, pin in pins):
                raise InventoryError('inventory_host_key_failed', 422)
            return profile
        if replace:
            known_hosts = without_ssh_host_pin(known_hosts, expected)
        separator = '\n' if known_hosts and not known_hosts.endswith(('\n', '\r')) else ''
        value = {**profile, 'ssh_known_hosts': known_hosts + separator + confirmed}
        return validate_profile(value)
    except InventoryCollectionError as exc:
        raise InventoryError(exc.code, 503 if exc.code == 'inventory_dependency_missing' else 400) from None


class InventoryJobs:
    def __init__(self, application, *, collector=collect, writer=sync_snapshot, executor=None):
        self.app, self.store = application, application.store
        self.collector, self.writer = collector, writer
        self.lock = threading.RLock()
        self.executor = executor or ThreadPoolExecutor(max_workers=2, thread_name_prefix='inventory')
        self.stop = threading.Event()
        with self.store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS inventory_profiles(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS inventory_targets(id TEXT PRIMARY KEY,address TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,next_due REAL NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS inventory_jobs(id TEXT PRIMARY KEY,target_id TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT NOT NULL,actor TEXT NOT NULL,result TEXT NOT NULL,error TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS inventory_jobs_target ON inventory_jobs(target_id,state);
            ''')
            db.execute("UPDATE inventory_jobs SET state='failed',finished_at=?,error='inventory_interrupted' WHERE state IN ('queued','running')", (now(),))

    def close(self):
        self.stop.set()
        self.executor.shutdown(wait=True, cancel_futures=False)

    def _get(self, table, key, db=None):
        if db is None:
            with self.store.connect() as connection:
                return self._get(table, key, connection)
        row = db.execute('SELECT payload FROM ' + table + ' WHERE id=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def profile(self, key):
        return self._get('inventory_profiles', key)

    def target(self, key):
        return self._get('inventory_targets', key)

    def profiles(self):
        with self.store.connect() as db:
            values = [json.loads(row[0]) for row in db.execute('SELECT payload FROM inventory_profiles ORDER BY id')]
        return {'items': [{**{k: v for k, v in item.items() if k not in SECRETS}, **{k + '_set': bool(item.get(k)) for k in SECRETS}} for item in values]}

    def targets(self):
        with self.store.connect() as db:
            return {'items': [json.loads(row[0]) for row in db.execute('SELECT payload FROM inventory_targets ORDER BY id')]}

    def jobs(self):
        with self.store.connect() as db:
            rows = db.execute('SELECT * FROM inventory_jobs ORDER BY rowid DESC LIMIT 100').fetchall()
        result = []
        for row in rows:
            item = dict(row)
            target = json.loads(item.pop('target'))
            item.update(target_name=target['name'], kind=target['kind'], address=target['address'])
            item['result'] = json.loads(item['result'])
            result.append(item)
        return {'items': result}

    def _busy(self, db, target_id=None, profile_id=None):
        rows = db.execute("SELECT target_id,target FROM inventory_jobs WHERE state IN ('queued','running')")
        return any(row[0] == target_id or profile_id is not None and json.loads(row[1])['profile_id'] == profile_id for row in rows)

    def save_profile(self, body):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            return self._save_profile(db, body)

    def _save_profile(self, db, body):
        if not isinstance(body, dict) or set(body) - PROFILE_KEYS:
            raise InventoryError('inventory_invalid_profile')
        key = identifier(body.get('id', str(uuid.uuid4())))
        previous = self._get('inventory_profiles', key, db) or {}
        if previous and body.get('kind', previous['kind']) != previous['kind']:
            raise InventoryError('inventory_profile_kind_changed')
        clears = body.get('clear_secrets', [])
        if not isinstance(clears, list) or len(clears) > len(SECRETS) or any(k not in SECRETS for k in clears) or len(set(clears)) != len(clears):
            raise InventoryError('inventory_invalid_profile')
        value = {**previous, **{k: v for k, v in body.items() if k != 'clear_secrets' and (k not in SECRETS or v != '')}}
        for secret in clears:
            value[secret] = ''
        # Switching SSH auth is explicit: nonempty password/key clears the old
        # counterpart, while an untouched empty edit retains its credential.
        value['id'] = key
        auth_method = body.get('auth_method', previous.get('auth_method'))
        if auth_method not in (None, 'password', 'key'):
            raise InventoryError('inventory_invalid_profile')
        if auth_method == 'key' or body.get('private_key'):
            value['password'] = ''
        elif auth_method == 'password' or body.get('password'):
            value['private_key'] = value['passphrase'] = ''
        value['name'] = text(value.get('name'))
        try:
            may_be_unpinned = not previous.get('ssh_known_hosts') and 'ssh_known_hosts' not in clears
            value = validate_profile(value, allow_unpinned_ssh=may_be_unpinned)
        except InventoryCollectionError as exc:
            raise InventoryError(exc.code) from None
        if self._busy(db, profile_id=key):
            raise InventoryError('inventory_profile_busy', 409)
        if not previous and db.execute('SELECT COUNT(*) FROM inventory_profiles').fetchone()[0] >= 128:
            raise InventoryError('inventory_profile_limit')
        db.execute('INSERT INTO inventory_profiles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (key, json.dumps(value)))
        return {'id': key}

    def save_target(self, body):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            return {'id': self._save_target(db, body)['id']}

    def _save_target(self, db, body):
        if not isinstance(body, dict) or set(body) - TARGET_KEYS:
            raise InventoryError('inventory_invalid_target')
        key = identifier(body.get('id', str(uuid.uuid4())))
        previous = self._get('inventory_targets', key, db)
        value = {**(previous or {}), **{name: field for name, field in body.items()
                                       if name not in ('ssh_host_key', 'replace_ssh_host_key')}}
        value['id'] = key
        value['name'] = text(value.get('name'))
        value['address'] = address(value.get('address'))
        value['profile_id'] = identifier(value.get('profile_id'))
        replace_pin = 'replace_ssh_host_key' in body
        if replace_pin and (body['replace_ssh_host_key'] is not True or 'ssh_host_key' not in body
                or set(body) - {'id', 'address', 'profile_id', 'ssh_host_key', 'replace_ssh_host_key'}
                or not previous or value.get('kind') == 'windows'
                or value['address'] != previous['address'] or value['profile_id'] != previous['profile_id']):
            raise InventoryError('inventory_invalid_target')
        profile = self._get('inventory_profiles', value['profile_id'], db)
        if value.get('kind') not in KIND or not profile or profile['kind'] != value['kind']:
            raise InventoryError('inventory_profile_mismatch')
        if value.get('network_id') is None:
            value['network_id'] = ''
        if not isinstance(value['network_id'], str):
            raise InventoryError('inventory_network_mismatch')
        if value['network_id']:
            network = db.execute('SELECT cidr FROM networks WHERE id=?', (value['network_id'],)).fetchone()
            if (not network or value['kind'] != 'network'
                    or ipaddress.ip_address(value['address']) not in ipaddress.ip_network(network['cidr'])):
                raise InventoryError('inventory_network_mismatch')
        interval = value.setdefault('interval_minutes', 0)
        if type(interval) is not int or interval != 0 and not 5 <= interval <= 1440:
            raise InventoryError('inventory_invalid_interval')
        if self._busy(db, target_id=key):
            raise InventoryError('inventory_target_busy', 409)
        existing = db.execute('SELECT id FROM inventory_targets WHERE address=? AND id<>?', (value['address'], key)).fetchone()
        if existing:
            raise InventoryError('inventory_address_exists', 409)
        if not previous and db.execute('SELECT COUNT(*) FROM inventory_targets').fetchone()[0] >= 2048:
            raise InventoryError('inventory_target_limit')
        pinned = profile_for_host(profile, value['address'], body, replace=replace_pin)
        if pinned is not profile:
            db.execute('UPDATE inventory_profiles SET payload=? WHERE id=?', (json.dumps(pinned), value['profile_id']))
        if replace_pin:
            return previous
        db.execute('INSERT INTO inventory_targets VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET address=excluded.address,payload=excluded.payload,next_due=excluded.next_due',
                   (key, value['address'], json.dumps(value), time.time() + interval * 60 if interval else 0))
        return value

    def remove(self, kind, key):
        identifier(key)
        with self.store.connect() as db:
            if self._busy(db, target_id=key if kind == 'targets' else None, profile_id=key if kind == 'profiles' else None):
                raise InventoryError('inventory_target_busy' if kind == 'targets' else 'inventory_profile_busy', 409)
            if kind == 'profiles' and any(json.loads(row[0])['profile_id'] == key for row in db.execute('SELECT payload FROM inventory_targets')):
                raise InventoryError('inventory_profile_in_use', 409)
            db.execute('DELETE FROM inventory_' + kind + ' WHERE id=?', (key,))
        return {'removed': True}

    def test_profile(self, key, body):
        if not isinstance(body, dict) or 'address' not in body or set(body) - {'address', 'ssh_host_key'}:
            raise InventoryError('inventory_invalid_target')
        profile = self.profile(identifier(key))
        if not profile:
            raise InventoryError('inventory_profile_missing', 404)
        ip = address(body['address'])
        profile = profile_for_host(profile, ip, body)
        # Admission remains bounded even if several clients test credentials.
        if not self.preview_slots.acquire(blocking=False):
            raise InventoryError('inventory_busy', 409)
        try:
            snapshot = self.collector({'id': str(uuid.uuid4()), 'kind': profile['kind'], 'address': ip}, profile, deadline=time.monotonic() + 20)
            return {'state': 'succeeded', 'summary': self.summary(snapshot), 'warnings': snapshot.get('warnings', [])}
        except InventoryCollectionError as exc:
            raise InventoryError(exc.code, 422) from None
        finally:
            self.preview_slots.release()

    preview_slots = threading.BoundedSemaphore(2)

    @staticmethod
    def capabilities():
        return {'guided_enrollment': True, 'ssh_host_key': True, 'profile_host_keys': True, 'drivers': list(DRIVERS)}

    def ssh_host_key(self, body):
        if not isinstance(body, dict) or set(body) != {'address', 'port'}:
            raise InventoryError('inventory_invalid_target')
        ip, port = address(body['address']), body['port']
        if type(port) is not int or not 1 <= port <= 65535:
            raise InventoryError('inventory_invalid_port')
        if not self.preview_slots.acquire(blocking=False):
            raise InventoryError('inventory_busy', 409)
        try:
            return read_ssh_host_key(ip, port)
        finally:
            self.preview_slots.release()

    @staticmethod
    def summary(snapshot):
        return {**{k: snapshot.get(k) for k in ('kind', 'observed_at', 'hostname', 'manufacturer', 'model', 'serial', 'os_name', 'os_version', 'virtualization', 'cpu_count', 'memory_mib')},
                'interfaces': len(snapshot.get('interfaces', [])), 'addresses': sum(len(i.get('addresses', [])) for i in snapshot.get('interfaces', [])),
                'disks': len(snapshot.get('disks', [])), 'neighbors': len(snapshot.get('neighbors', []))}

    def enroll(self, body, operation, actor, fingerprint):
        identifier(operation)
        if (not isinstance(body, dict) or set(body) - ENROLL_KEYS
                or body.get('kind') not in KIND or ('profile' in body) == ('profile_id' in body)):
            raise InventoryError('inventory_invalid_target')
        ip = address(body.get('address'))
        kind = body['kind']
        name = text(body.get('name', ip))
        with self.lock, self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT digest,response FROM requests WHERE id=?', (operation,)).fetchone()
            if previous:
                if previous['digest'] != fingerprint:
                    raise InventoryError('netmap_idempotency_conflict', 409)
                return json.loads(previous['response'])
            if 'profile' in body:
                draft = body['profile']
                if (not isinstance(draft, dict) or set(draft) - (PROFILE_KEYS - {'id', 'clear_secrets'})
                        or draft.get('kind', kind) != kind):
                    raise InventoryError('inventory_invalid_profile')
                draft = {**draft, 'name': draft.get('name') or name, 'kind': kind}
                if kind == 'network':
                    draft.setdefault('driver', 'auto')
                profile_id = self._save_profile(db, draft)['id']
            else:
                profile_id = identifier(body['profile_id'])
            target = self._save_target(db, {**{key: body[key] for key in ('network_id', 'interval_minutes', 'ssh_host_key') if key in body},
                'address': ip, 'name': name, 'kind': kind, 'profile_id': profile_id})
            self._enqueue(db, target, operation, actor)
            result = {'target_id': target['id'], 'profile_id': profile_id, 'job_id': operation, 'state': 'queued'}
            db.execute('INSERT INTO requests VALUES(?,?,?)', (operation, fingerprint, json.dumps(result)))
        self._dispatch(operation, target)
        return result

    def start(self, key, operation, actor):
        target = self.target(identifier(key))
        if not target:
            raise InventoryError('inventory_target_missing', 404)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._enqueue(db, target, operation, actor)
        self._dispatch(operation, target)
        return {'id': operation, 'state': 'queued'}

    def _enqueue(self, db, target, operation, actor):
        key = target['id']
        if self._busy(db, target_id=key):
            raise InventoryError('inventory_target_busy', 409)
        if db.execute("SELECT COUNT(*) FROM inventory_jobs WHERE state IN ('queued','running')").fetchone()[0] >= 16:
            raise InventoryError('inventory_busy', 409)
        db.execute('INSERT INTO inventory_jobs VALUES(?,?,?,?,?,?,?,?,?,?)', (operation, key, json.dumps(target), 'queued', now(), '', '', actor, '{}', ''))
        interval = target.get('interval_minutes', 0)
        db.execute('UPDATE inventory_targets SET next_due=? WHERE id=?', (time.time() + interval * 60 if interval else 0, key))
        # Only terminal jobs expire; native inventory/history never do.
        db.execute("DELETE FROM inventory_jobs WHERE state NOT IN ('queued','running') AND id NOT IN (SELECT id FROM inventory_jobs ORDER BY rowid DESC LIMIT 200)")

    def _dispatch(self, operation, target):
        try:
            self.executor.submit(self._run, operation, target)
        except RuntimeError:
            with self.store.connect() as db:
                db.execute("UPDATE inventory_jobs SET state='failed',finished_at=?,error='inventory_interrupted' WHERE id=?", (now(), operation))
            raise InventoryError('inventory_interrupted', 503) from None

    def _run(self, operation, target):
        state, result, error = 'failed', {}, 'inventory_collection_failed'
        deadline = time.monotonic() + 180
        with self.store.connect() as db:
            db.execute("UPDATE inventory_jobs SET state='running',started_at=? WHERE id=?", (now(), operation))
        try:
            profile = self.profile(target['profile_id'])
            if not profile:
                raise InventoryError('inventory_profile_missing')
            snapshot = self.collector(target, profile, deadline=min(deadline, time.monotonic() + 90))
            result = {'summary': self.summary(snapshot), 'warnings': snapshot.get('warnings', [])}
            # A network poll and structured sync share one writer lane, avoiding
            # SNMP/SSH adoption races. Busy source never becomes empty success.
            if not self.app.poll_lock.acquire(timeout=max(0, min(20, deadline - time.monotonic()))):
                raise InventoryError('inventory_writer_busy')
            try:
                client = self.app.netbox.bounded(deadline) if callable(getattr(self.app.netbox, 'bounded', None)) else self.app.netbox
                report = self.writer(client, target, snapshot, deadline=deadline)
            finally:
                self.app.poll_lock.release()
            result['sync'] = report
            if report.get('state') == 'failed':
                state, error = 'failed', 'inventory_sync_failed'
            else:
                state = 'partial' if report.get('state') == 'partial' or report.get('errors') or report.get('conflicts') or snapshot.get('warnings') else 'succeeded'
                error = ''
        except (InventoryCollectionError, InventoryError) as exc:
            error = exc.code
        except Exception:
            # Native API bodies / remote errors may contain credentials. The
            # finite public code and operation ID are enough for retry/status.
            error = 'inventory_sync_failed' if result else 'inventory_collection_failed'
        finally:
            with self.store.connect() as db:
                db.execute('UPDATE inventory_jobs SET state=?,finished_at=?,result=?,error=? WHERE id=?', (state, now(), json.dumps(result), error, operation))

    def mutation(self, path, body, operation, actor, *, method='POST'):
        if method == 'POST' and re.fullmatch(r'/api/inventory/profiles/[a-f0-9-]{36}/test', path):
            return self.test_profile(path.split('/')[4], body)
        with self.lock:
            if method == 'POST' and path == '/api/inventory/profiles':
                return self.save_profile(body)
            if method == 'POST' and path == '/api/inventory/targets':
                return self.save_target(body)
            match = re.fullmatch(r'/api/inventory/(profiles|targets)/([^/]+)(?:/(test|collect))?', path)
            if not match:
                raise InventoryError('inventory_invalid_route')
            kind, key, action = match.groups()
            if method == 'DELETE' and action is None and body == {}:
                return self.remove(kind, key)
            if method == 'POST' and kind == 'profiles' and action == 'test':
                return self.test_profile(key, body)
            if method == 'POST' and kind == 'targets' and action == 'collect' and body == {}:
                return self.start(key, operation, actor)
            raise InventoryError('inventory_invalid_route')

    def schedule_due(self):
        with self.lock:
            with self.store.connect() as db:
                due = [row[0] for row in db.execute('SELECT id FROM inventory_targets WHERE next_due>0 AND next_due<=? ORDER BY next_due LIMIT 16', (time.time(),))]
            for key in due:
                try:
                    self.start(key, str(uuid.uuid4()), 'system:netmap-inventory')
                except InventoryError:
                    continue

    def start_scheduler(self):
        def loop():
            while not self.stop.wait(30):
                try:
                    self.schedule_due()
                except Exception:
                    # Persistent SQLite failure should not start duplicate jobs.
                    continue
        threading.Thread(target=loop, name='inventory-scheduler', daemon=True).start()
