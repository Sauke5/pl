"""Source-owned, retryable inventory writes through the finite NetBox 4.7 API.

The three pl_inventory* custom fields are provisioned by netbox-bootstrap.py.
Native fields are changed only while they still equal our last accepted output.
Observations never authorize deleting objects, claiming manual inventory, or
creating cables. No credentials or raw transport errors enter this module.
"""
from __future__ import annotations

import copy
from datetime import datetime
from decimal import Decimal, InvalidOperation
import hashlib
import ipaddress
import json
import math
import re
import time
import uuid


SOURCE = 'pl_inventory_source'
KEY = 'pl_inventory_key'
META = 'pl_inventory'
ASSETS = {'device': '/dcim/devices/', 'virtual_machine': '/virtualization/virtual-machines/'}
OBJECT_TYPES = {'device': 'dcim.device', 'virtual_machine': 'virtualization.virtualmachine'}
COUNTS = ('created', 'updated', 'unchanged', 'manual_preserved', 'conflicts', 'errors')
MAX_IPS = 4096
DEFAULT_BUDGET_SECONDS = 120


class InventoryConflict(ValueError):
    """A safe, finite conflict code; never a NetBox response or transport error."""


class InventoryDeadlineExceeded(TimeoutError):
    def __init__(self):
        super().__init__('inventory_timeout')


class _DeadlineClient:
    """One absolute budget shared by every query, write, and paginated request.

    The native client's bounded clone also limits transport/read time. Legacy
    clients retain their existing method signatures and are checked between calls.
    """
    def __init__(self, client, deadline, accepted):
        self.deadline, self.accepted = deadline, accepted
        bounded = getattr(client, 'bounded', None)
        self.client = bounded(deadline) if callable(bounded) else client

    def check(self):
        if time.monotonic() >= self.deadline:
            raise InventoryDeadlineExceeded()

    def call(self, method_name, *args, **kwargs):
        self.check()
        try:
            value = getattr(self.client, method_name)(*args, **kwargs)
        except Exception:
            self.check()
            raise
        # A response can cross the deadline after the server accepted a write.
        # Account for that durable result before stopping all subsequent work.
        if method_name == 'request' and args[0] in ('POST', 'PATCH'):
            self.accepted(args[0], args[1], value)
        self.check()
        return value

    def all(self, *args, **kwargs):
        return self.call('all', *args, **kwargs)

    def get_or_create(self, *args, **kwargs):
        return self.call('get_or_create', *args, **kwargs)

    def request(self, *args, **kwargs):
        return self.call('request', *args, **kwargs)


def _text(value, limit=256, *, required=False):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('inventory_invalid_snapshot')
    if required and not value.strip():
        raise ValueError('inventory_invalid_snapshot')
    return value


def _integer(value, high, low=0):
    if value is not None and (type(value) is not int or not low <= value <= high):
        raise ValueError('inventory_invalid_snapshot')
    return value


def _ref(value):
    if isinstance(value, list):
        return sorted((_ref(item) for item in value), key=str)
    if isinstance(value, dict):
        return value.get('id', value.get('value'))
    return value


def _equal(first, second):
    first, second = _ref(first), _ref(second)
    # NetBox serializes a blank ChoiceField (e.g. interface mode) as null.
    # Both represent an unset native value, not a manual configuration change.
    if first in (None, '') and second in (None, ''):
        return True
    if type(first) is bool or type(second) is bool:
        return type(first) is type(second) and first == second
    if (isinstance(first, (int, float, Decimal)) or isinstance(second, (int, float, Decimal))) and isinstance(first, (str, int, float, Decimal)) and isinstance(second, (str, int, float, Decimal)):
        try:
            return Decimal(str(first)) == Decimal(str(second))
        except InvalidOperation:
            pass
    return first == second


def _safe_address(value):
    value = ipaddress.ip_address(value)
    if (value.is_loopback or value.is_link_local or value.is_multicast or value.is_unspecified
            or getattr(value, 'scope_id', None) or value == ipaddress.ip_address('169.254.169.254')):
        raise ValueError('inventory_invalid_address')
    return value


def _validated(target, snapshot):
    if not isinstance(target, dict) or not isinstance(snapshot, dict):
        raise ValueError('inventory_invalid_snapshot')
    identifier = target.get('id')
    try:
        if not isinstance(target.get('address'), str):
            raise ValueError()
        if str(uuid.UUID(identifier)) != identifier:
            raise ValueError()
        address = str(_safe_address(target.get('address')))
    except (TypeError, AttributeError, ValueError):
        raise ValueError('inventory_invalid_target') from None
    if target.get('kind') not in ('network', 'linux', 'windows'):
        raise ValueError('inventory_invalid_target')
    network = target.get('network_id', '') or ''
    if not isinstance(network, str) or network and not re.fullmatch(r'[0-9a-f]{16}', network):
        raise ValueError('inventory_invalid_target')
    _text(target.get('name', ''), 128)
    if snapshot.get('schema') != 1 or type(snapshot.get('schema')) is not int or snapshot.get('kind') != target['kind']:
        raise ValueError('inventory_invalid_snapshot')
    allowed = {'schema', 'kind', 'observed_at', 'hostname', 'manufacturer', 'model', 'serial', 'os_name',
               'os_version', 'virtualization', 'cpu_count', 'memory_mib', 'disks', 'interfaces',
               'neighbors', 'vlans', 'vrfs', 'chassis', 'modules', 'warnings', 'capabilities'}
    if set(snapshot) - allowed:
        raise ValueError('inventory_invalid_snapshot')
    observed_at = snapshot.get('observed_at')
    try:
        moment = datetime.fromisoformat(_text(observed_at, 48).replace('Z', '+00:00'))
        if moment.utcoffset() is None or moment.utcoffset().total_seconds() != 0:
            raise ValueError()
    except (TypeError, ValueError):
        raise ValueError('inventory_invalid_snapshot') from None
    try:
        encoded = json.dumps(snapshot, allow_nan=False, ensure_ascii=False)
        if len(encoded.encode()) > 1024 * 1024:
            raise ValueError()
    except (TypeError, ValueError):
        raise ValueError('inventory_invalid_snapshot') from None
    result = copy.deepcopy(snapshot)
    for name in ('hostname', 'manufacturer', 'model', 'serial', 'os_name', 'os_version'):
        result[name] = _text(snapshot.get(name, ''), 1024)
    if snapshot.get('virtualization') not in ('physical', 'vm', 'unknown'):
        raise ValueError('inventory_invalid_snapshot')
    _integer(snapshot.get('cpu_count'), 9999)
    _integer(snapshot.get('memory_mib'), 2**31 - 1)
    disks, interfaces = snapshot.get('disks', []), snapshot.get('interfaces', [])
    if not isinstance(disks, list) or len(disks) > 128 or not isinstance(interfaces, list) or len(interfaces) > 1024:
        raise ValueError('inventory_invalid_snapshot')
    disk_names, keys, ips = set(), set(), 0
    for disk in disks:
        if not isinstance(disk, dict) or set(disk) - {'name', 'size_bytes'}:
            raise ValueError('inventory_invalid_snapshot')
        name = _text(disk.get('name'), 256, required=True)
        if name in disk_names or _integer(disk.get('size_bytes'), (2**31 - 1) * 1000000) is None:
            raise ValueError('inventory_invalid_snapshot')
        disk_names.add(name)
    for interface in interfaces:
        if not isinstance(interface, dict) or set(interface) - {
                'key', 'name', 'description', 'mac_address', 'mtu', 'speed_mbps', 'enabled', 'link_up', 'type', 'addresses',
                'mode', 'untagged_vlan', 'tagged_vlans', 'lag'}:
            raise ValueError('inventory_invalid_snapshot')
        key = _text(interface.get('key'), 256, required=True)
        if key in keys:
            raise ValueError('inventory_invalid_snapshot')
        keys.add(key)
        _text(interface.get('name'), 256, required=True)
        _text(interface.get('description', ''), 1024)
        _text(interface.get('mac_address', ''), 32)
        if interface.get('type', 'unknown') not in ('physical', 'virtual', 'lag', 'unknown'):
            raise ValueError('inventory_invalid_snapshot')
        _integer(interface.get('mtu'), 65536)
        _integer(interface.get('speed_mbps'), (2**31 - 1) // 1000)
        if interface.get('mode') is not None and interface['mode'] not in ('access', 'tagged', 'tagged-all'):
            raise ValueError('inventory_invalid_snapshot')
        if 'untagged_vlan' in interface:
            _integer(interface['untagged_vlan'], 4094, 1)
        if 'tagged_vlans' in interface:
            tagged = interface['tagged_vlans']
            if (not isinstance(tagged, list) or len(tagged) > 4094
                    or any(type(vid) is not int or not 1 <= vid <= 4094 for vid in tagged)
                    or len(set(tagged)) != len(tagged)):
                raise ValueError('inventory_invalid_snapshot')
        if interface.get('lag') is not None:
            _text(interface['lag'], 256, required=True)
        for name in ('enabled', 'link_up'):
            if interface.get(name) is not None and type(interface[name]) is not bool:
                raise ValueError('inventory_invalid_snapshot')
        addresses = interface.get('addresses', [])
        if not isinstance(addresses, list) or len(addresses) > 128:
            raise ValueError('inventory_invalid_snapshot')
        ips += len(addresses)
        for item in addresses:
            if not isinstance(item, dict) or set(item) - {'address', 'vrf'}:
                raise ValueError('inventory_invalid_snapshot')
            _text(item.get('address'), 80, required=True)
            _text(item.get('vrf', ''), 128)
    if ips > MAX_IPS:
        raise ValueError('inventory_invalid_snapshot')
    capabilities = snapshot.get('capabilities', {})
    if (not isinstance(capabilities, dict) or len(capabilities) > 64
            or any(not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', str(k)) or type(v) is not bool for k, v in capabilities.items())):
        raise ValueError('inventory_invalid_snapshot')
    for name in ('neighbors', 'vlans', 'vrfs', 'chassis', 'modules'):
        value = snapshot.get(name, [])
        if not isinstance(value, list) or len(value) > 1024:
            raise ValueError('inventory_invalid_snapshot')
    vids, vrf_names = set(), set()
    for vlan in snapshot.get('vlans', []):
        if not isinstance(vlan, dict) or set(vlan) - {'vid', 'name'}:
            raise ValueError('inventory_invalid_snapshot')
        vid = _integer(vlan.get('vid'), 4094, 1)
        if vid is None or vid in vids:
            raise ValueError('inventory_invalid_snapshot')
        vids.add(vid)
        _text(vlan.get('name', ''), 256)
    for vrf in snapshot.get('vrfs', []):
        if not isinstance(vrf, dict) or set(vrf) - {'name', 'rd'}:
            raise ValueError('inventory_invalid_snapshot')
        name = _text(vrf.get('name'), 100, required=True).strip()
        if name in vrf_names:
            raise ValueError('inventory_invalid_snapshot')
        vrf_names.add(name)
        if vrf.get('rd') is not None:
            _text(vrf['rd'], 21)
    warnings = snapshot.get('warnings', [])
    if (not isinstance(warnings, list) or len(warnings) > 64
            or any(not isinstance(code, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,95}', code) for code in warnings)):
        raise ValueError('inventory_invalid_snapshot')
    result['interfaces'], result['disks'], result['capabilities'] = interfaces, disks, capabilities
    return {**target, 'address': address, 'network_id': network}, result


class _Sync:
    def __init__(self, client, target, snapshot, deadline):
        self.target, self.snapshot = target, snapshot
        self.source = 'inventory:' + target['id']
        self.network_source = 'network:' + target['network_id'] if target['network_id'] else ''
        self.scope_source = self.network_source or self.source
        self.report = {'schema': 1, 'state': 'succeeded', 'object_type': '', 'object_id': None,
                       **{name: 0 for name in COUNTS}, 'ids': {}, 'warnings': []}
        self.client = _DeadlineClient(client, deadline, self.accepted)
        self.vrfs, self.prefixes, self.ip_assignments = {}, set(), {}
        self.owned_rows, self.interface_rows = {}, {}
        self.vlan_ids = {}
        self.interface_parents = {}

    def warn(self, code):
        if code not in self.report['warnings'] and len(self.report['warnings']) < 64:
            self.report['warnings'].append(code)

    def failure(self, error):
        if isinstance(error, InventoryDeadlineExceeded):
            raise error
        if isinstance(error, InventoryConflict):
            self.report['conflicts'] += 1
            self.warn(str(error))
        else:
            self.report['errors'] += 1
            self.warn('inventory_netbox_write_failed')

    def remember(self, category, identifier):
        values = self.report['ids'].setdefault(category, [])
        if identifier not in values:
            values.append(identifier)

    def accepted(self, method, path, value):
        if not isinstance(value, dict) or (value.get('custom_fields') or {}).get(SOURCE) not in (self.source, self.scope_source):
            return
        self.report['created' if method == 'POST' else 'updated'] += 1
        categories = {**{v: k for k, v in ASSETS.items()}, '/dcim/interfaces/': 'interfaces',
                      '/virtualization/interfaces/': 'interfaces', '/dcim/mac-addresses/': 'mac_addresses',
                      '/ipam/ip-addresses/': 'ip_addresses', '/ipam/prefixes/': 'prefixes',
                      '/ipam/vrfs/': 'vrfs', '/ipam/vlan-groups/': 'vlan_groups', '/ipam/vlans/': 'vlans',
                      '/virtualization/virtual-disks/': 'virtual_disks'}
        for prefix, category in categories.items():
            if path == prefix or path.startswith(prefix) and path[len(prefix):].rstrip('/').isdigit():
                self.remember(category, value['id'])
                if category in ASSETS:
                    self.report['object_type'], self.report['object_id'] = OBJECT_TYPES[category], value['id']
                break

    def owned(self, path, key, *, source=None):
        source = source or self.source
        cache_key = (path, source)
        if cache_key not in self.owned_rows:
            self.owned_rows[cache_key] = self.client.all(path, **{'cf_' + SOURCE: source})
        values = self.owned_rows[cache_key]
        values = [v for v in values if (v.get('custom_fields') or {}).get(SOURCE) == source
                  and (v.get('custom_fields') or {}).get(KEY) == key]
        if len(values) > 1:
            raise InventoryConflict('inventory_ambiguous_owned_object')
        return values[0] if values else None

    def cache(self, path, value):
        cache_key = (path, (value.get('custom_fields') or {}).get(SOURCE))
        if cache_key in self.owned_rows:
            rows = self.owned_rows[cache_key]
            rows[:] = [row for row in rows if row['id'] != value['id']]
            rows.append(value)

    def fresh(self, path, identifier):
        return self.client.request('GET', path + str(identifier) + '/', include_version=True)

    def metadata(self, key, native, observed, protected=()):
        value = {'schema': 1, 'native': copy.deepcopy(native), 'observed': copy.deepcopy(observed),
                 'observed_at': self.snapshot['observed_at']}
        if protected:
            value['protected'] = sorted(protected)
        return value

    def create(self, path, key, body, observed, *, source=None):
        native = {k: _ref(v) for k, v in body.items() if k != 'custom_fields'}
        fields = {**body.get('custom_fields', {}), SOURCE: source or self.source, KEY: key,
                  META: self.metadata(key, native, observed)}
        value = self.client.request('POST', path, {**body, 'custom_fields': fields})
        self.cache(path, value)
        return value

    def update(self, path, value, key, desired, observed, *, adopt=False, claim_empty=(), source=None,
               atomic_fields=(), expected=None):
        source = source or self.source
        current, version = self.fresh(path, value['id'])
        parent = self.interface_parents.get((path, value['id']))
        if parent and not _equal(current.get(parent[0]), parent[1]):
            raise InventoryConflict('inventory_interface_parent_changed')
        if expected and any(not _equal(current.get(name), wanted) for name, wanted in expected.items()):
            raise InventoryConflict('inventory_native_identity_changed')
        fields = current.get('custom_fields') or {}
        owner, old_key = fields.get(SOURCE), fields.get(KEY)
        if owner not in (None, '', source) or owner == source and old_key != key:
            raise InventoryConflict('inventory_foreign_owner')
        if not owner and not adopt:
            raise InventoryConflict('inventory_unowned_object')
        if path == ASSETS['device'] and self.network_source and (
                fields.get('pl_source') != self.network_source or fields.get('collector_ip') != self.target['address']):
            raise InventoryConflict('inventory_network_attachment_conflict')
        if not owner and adopt:
            if path == '/dcim/interfaces/':
                if fields.get('pl_source') != self.network_source or not (
                        str(fields.get('pl_if_index')) == key.removeprefix('interface:') or
                        fields.get('pl_observed_if_name') == observed.get('name')):
                    raise InventoryConflict('inventory_network_attachment_conflict')
            elif path != ASSETS['device']:
                raise InventoryConflict('inventory_unowned_object')
        old = fields.get(META) or {}
        if owner and (not isinstance(old, dict) or old.get('schema') != 1 or not isinstance(old.get('native'), dict)):
            raise InventoryConflict('inventory_invalid_ownership_record')
        old_protected = old.get('protected', [])
        if (not isinstance(old_protected, list) or len(old_protected) > 64
                or any(not isinstance(name, str) for name in old_protected)):
            raise InventoryConflict('inventory_invalid_ownership_record')
        protected = set(old_protected)
        native = copy.deepcopy(old.get('native', {}))
        desired = dict(desired)
        if atomic_fields and any(name in protected or (
                not _equal(current.get(name), native[name]) if name in native
                else _ref(current.get(name)) not in (None, '', [])) for name in atomic_fields):
            for name in atomic_fields:
                desired.pop(name, None)
                native.pop(name, None)
                protected.add(name)
            self.report['manual_preserved'] += 1
            self.warn('inventory_manual_value_preserved')
        patch = {}
        for name, wanted in desired.items():
            actual = _ref(current.get(name))
            if name not in native:
                if name not in protected and (owner or adopt) and name in claim_empty and actual in (None, '', []):
                    native[name] = actual
                else:
                    if name not in protected and name in claim_empty and actual not in (None, '', []):
                        protected.add(name)
                        self.report['manual_preserved'] += 1
                        self.warn('inventory_manual_value_preserved')
                    continue
            if not _equal(actual, native[name]):
                native.pop(name)
                protected.add(name)
                self.report['manual_preserved'] += 1
                self.warn('inventory_manual_value_preserved')
            elif not _equal(actual, wanted):
                patch[name], native[name] = wanted, _ref(wanted)
        metadata = self.metadata(key, native, observed, protected)
        owned_fields = {SOURCE: source, KEY: key, META: metadata}
        if patch or any(fields.get(k) != v for k, v in owned_fields.items()):
            patch['custom_fields'] = owned_fields
            current = self.client.request('PATCH', path + str(current['id']) + '/', patch, version=version)
        else:
            self.report['unchanged'] += 1
        self.cache(path, current)
        return current

    def reference(self, path, lookup, body):
        values = self.client.all(path, **lookup)
        if len(values) > 1:
            raise InventoryConflict('inventory_ambiguous_reference')
        return values[0] if values else self.client.get_or_create(path, lookup, body)

    def catalog(self, kind):
        suffix = self.target['network_id']
        site_slug = 'pl-network-' + suffix if self.network_source else 'pl-inventory'
        site = self.reference('/dcim/sites/', {'slug': site_slug},
                              {'slug': site_slug, 'name': 'NetMap ' + suffix if suffix else 'NetMap inventory',
                               'status': 'active'})
        role = self.reference('/dcim/device-roles/', {'slug': 'pl-inventory'},
                              {'slug': 'pl-inventory', 'name': 'Collected host', 'color': '2196f3', 'vm_role': True})
        if kind == 'virtual_machine':
            return site['id'], role['id'], None
        manufacturer_name = self.snapshot['manufacturer'].strip()[:100] or 'Discovered'
        slug = 'pl-inventory-' + hashlib.sha256(manufacturer_name.encode()).hexdigest()[:16]
        manufacturer = self.reference('/dcim/manufacturers/', {'name': manufacturer_name},
                                      {'name': manufacturer_name, 'slug': slug})
        model = self.snapshot['model'].strip()[:100] or 'Discovered'
        dtype = self.reference('/dcim/device-types/', {'manufacturer_id': manufacturer['id'], 'model': model},
                               {'manufacturer': manufacturer['id'], 'model': model,
                                'slug': 'pl-inventory-' + hashlib.sha256((str(manufacturer['id']) + ':' + model).encode()).hexdigest()[:16]})
        return site['id'], role['id'], dtype['id']

    def asset(self):
        kind = 'virtual_machine' if self.snapshot['virtualization'] == 'vm' else 'device'
        path = ASSETS[kind]
        existing = self.owned(path, 'asset')
        other = self.owned(ASSETS['device' if kind == 'virtual_machine' else 'virtual_machine'], 'asset')
        if other:
            raise InventoryConflict('inventory_object_kind_changed')
        adopted = False
        matches = self.client.all('/dcim/devices/', cf_collector_ip=self.target['address'])
        matches = [v for v in matches if (v.get('custom_fields') or {}).get('collector_ip') == self.target['address']]
        scoped = [v for v in matches if self.network_source and (v.get('custom_fields') or {}).get('pl_source') == self.network_source]
        if len(scoped) > 1:
            raise InventoryConflict('inventory_ambiguous_network_attachment')
        if self.network_source and scoped:
            if kind != 'device' or existing and existing['id'] != scoped[0]['id']:
                raise InventoryConflict('inventory_network_attachment_conflict')
            if not existing:
                existing, adopted = scoped[0], True
        elif not existing and matches:
            raise InventoryConflict('inventory_network_attachment_required')
        observed = {name: copy.deepcopy(self.snapshot[name]) for name in (
            'kind', 'hostname', 'manufacturer', 'model', 'serial', 'os_name', 'os_version',
            'virtualization', 'disks', 'capabilities')}
        observed.update(cpu_count=self.snapshot.get('cpu_count'), memory_mib=self.snapshot.get('memory_mib'),
                        collector_ip=self.target['address'])
        for name in ('neighbors', 'vlans', 'vrfs', 'chassis', 'modules'):
            if name in self.snapshot:
                observed[name] = copy.deepcopy(self.snapshot[name])
        name = (self.snapshot['hostname'].strip() or self.target.get('name', '').strip() or self.target['address'])[:64]
        desired = {'name': name, 'serial': self.snapshot['serial'].strip()[:50]}
        if kind == 'virtual_machine':
            for key, source in (('vcpus', 'cpu_count'), ('memory', 'memory_mib')):
                if self.snapshot.get(source) is not None and (key != 'vcpus' or self.snapshot[source] > 0):
                    desired[key] = self.snapshot[source]
        if existing:
            if self.network_source and (existing.get('custom_fields') or {}).get('pl_source') != self.network_source:
                raise InventoryConflict('inventory_network_attachment_conflict')
            if adopted:
                for field in ('primary_ip4', 'primary_ip6'):
                    if existing.get(field) is None:
                        desired[field] = None
            existing = self.update(path, existing, 'asset', desired, observed, adopt=adopted,
                                   claim_empty=('serial', 'primary_ip4', 'primary_ip6'))
        else:
            if self.client.all(path, name=name):
                raise InventoryConflict('inventory_unowned_name_conflict')
            site, role, dtype = self.catalog(kind)
            body = {**desired, 'status': 'active', 'site': site, 'role': role,
                    'primary_ip4': None, 'primary_ip6': None}
            if kind == 'device':
                body['device_type'] = dtype
                body['custom_fields'] = {'pl_source': self.network_source or self.source,
                                         'collector_ip': self.target['address']}
            existing = self.create(path, 'asset', body, observed)
        self.report['object_type'], self.report['object_id'] = OBJECT_TYPES[kind], existing['id']
        self.remember(kind, existing['id'])
        return kind, path, existing

    def interface(self, kind, asset, interface):
        vm = kind == 'virtual_machine'
        path = '/virtualization/interfaces/' if vm else '/dcim/interfaces/'
        parent = 'virtual_machine' if vm else 'device'
        key = 'interface:' + interface['key']
        existing = self.owned(path, key)
        adopted = False
        cache_key = (path, asset['id'])
        if cache_key not in self.interface_rows:
            self.interface_rows[cache_key] = self.client.all(path, **{parent + '_id': asset['id']})
        rows = self.interface_rows[cache_key]
        if existing and _ref(existing.get(parent)) != asset['id']:
            raise InventoryConflict('inventory_interface_parent_changed')
        if not existing and not vm and self.network_source:
            matches = []
            for row in rows:
                fields = row.get('custom_fields') or {}
                if fields.get('pl_source') == self.network_source and (
                        str(fields.get('pl_if_index')) == interface['key'] or
                        fields.get('pl_observed_if_name') == interface['name']):
                    matches.append(row)
            if len(matches) > 1:
                raise InventoryConflict('inventory_ambiguous_network_interface')
            if matches:
                existing, adopted = matches[0], True
        if existing:
            self.interface_parents[(path, existing['id'])] = (parent, asset['id'])
        name = interface['name'].strip()
        if len(name) > 64:
            name = name[:51] + '-' + hashlib.sha256(interface['key'].encode()).hexdigest()[:12]
        desired = {'name': name, 'description': interface.get('description', '').strip()[:200]}
        if interface.get('enabled') is not None:
            desired['enabled'] = interface['enabled']
        if interface.get('mtu') is not None:
            desired['mtu'] = interface['mtu']
        if not vm:
            desired['type'] = {'virtual': 'virtual', 'lag': 'lag'}.get(interface.get('type'), 'other')
            if interface.get('speed_mbps') is not None:
                desired['speed'] = interface['speed_mbps'] * 1000  # NetBox interface speed is Kbps.
        observed = {k: copy.deepcopy(v) for k, v in interface.items() if k != 'addresses'}
        if existing:
            if adopted and existing.get('primary_mac_address') is None:
                desired['primary_mac_address'] = None
            existing = self.update(path, existing, key, desired, observed, adopt=adopted,
                                   claim_empty=('mtu', 'primary_mac_address'))
        else:
            if any(v.get('name') == name for v in rows):
                raise InventoryConflict('inventory_unowned_interface_conflict')
            body = {**desired, parent: asset['id'], 'primary_mac_address': None,
                    'mode': '', 'untagged_vlan': None, 'tagged_vlans': []}
            if not vm:
                body['lag'] = None
            if not vm and self.network_source and re.fullmatch(r'[0-9]{1,10}', interface['key']):
                # Keep a genuine collected ifIndex usable by the existing SNMP
                # writer. A textual key never becomes an invented ifIndex.
                body['custom_fields'] = {'pl_source': self.network_source, 'pl_if_index': interface['key'],
                                         'pl_observed_if_name': interface['name']}
            existing = self.create(path, key, body, observed)
            rows.append(existing)
        self.interface_parents[(path, existing['id'])] = (parent, asset['id'])
        self.remember('interfaces', existing['id'])
        return path, 'virtualization.vminterface' if vm else 'dcim.interface', existing

    def mac(self, path, object_type, interface, observed):
        raw = observed.get('mac_address', '')
        if not raw:
            return
        compact = raw.replace(':', '').replace('-', '').replace('.', '').lower()
        if compact == '0' * 12:
            return  # Linux loopback/tunnel interfaces have no Ethernet address.
        if not re.fullmatch(r'[0-9a-f]{12}', compact) or int(compact[:2], 16) & 1:
            self.report['errors'] += 1
            self.warn('inventory_invalid_mac_observation')
            return
        address = ':'.join(compact[i:i + 2] for i in range(0, 12, 2)).upper()
        key = 'mac:' + observed['key'] + ':' + address
        current = self.owned('/dcim/mac-addresses/', key)
        rows = self.client.all('/dcim/mac-addresses/', mac_address=address)
        if any(v['id'] != (current or {}).get('id') for v in rows):
            raise InventoryConflict('inventory_unowned_mac_conflict')
        desired = {'mac_address': address, 'assigned_object_type': object_type, 'assigned_object_id': interface['id']}
        value = (self.update('/dcim/mac-addresses/', current, key, desired, {'mac_address': address}) if current
                 else self.create('/dcim/mac-addresses/', key, desired, {'mac_address': address}))
        if _ref(value.get('assigned_object_type')) != object_type or value.get('assigned_object_id') != interface['id']:
            raise InventoryConflict('inventory_mac_assignment_changed')
        self.remember('mac_addresses', value['id'])
        self.update(path, interface, 'interface:' + observed['key'], {'primary_mac_address': value['id']},
                    {k: copy.deepcopy(v) for k, v in observed.items() if k != 'addresses'})

    def vlans(self, asset):
        if not self.snapshot.get('vlans'):
            return
        site = _ref(asset.get('site'))
        if not site:
            raise InventoryConflict('inventory_vlan_site_missing')
        path, key = '/ipam/vlan-groups/', 'vlan-group'
        slug = 'pl-inventory-' + (self.target['network_id'] or self.target['id'])
        desired = {'name': slug, 'slug': slug, 'scope_type': 'dcim.site', 'scope_id': site}
        group = self.owned(path, key, source=self.scope_source)
        if group:
            group = self.update(path, group, key, {}, {'scope': self.scope_source}, source=self.scope_source)
        else:
            if self.client.all(path, slug=slug):
                raise InventoryConflict('inventory_unowned_vlan_group_conflict')
            group = self.create(path, key, desired, {'scope': self.scope_source}, source=self.scope_source)
        if _ref(group.get('scope_type')) != 'dcim.site' or group.get('scope_id') != site:
            raise InventoryConflict('inventory_vlan_group_scope_changed')
        self.remember('vlan_groups', group['id'])
        path = '/ipam/vlans/'
        rows = self.client.all(path, group_id=group['id'])
        for observed in self.snapshot['vlans']:
            self.client.check()
            try:
                vid, key = observed['vid'], 'vlan:' + str(observed['vid'])
                current = self.owned(path, key, source=self.scope_source)
                if any(row['vid'] == vid and row['id'] != (current or {}).get('id') for row in rows):
                    raise InventoryConflict('inventory_unowned_vlan_conflict')
                # NetBox also requires unique names within a group. Different
                # VLANs may legitimately have the same collected description.
                label = observed.get('name', '').strip()
                suffix = ' (VLAN ' + str(vid) + ')'
                desired = {'name': label[:64 - len(suffix)] + suffix if label else 'VLAN ' + str(vid)}
                if current:
                    current = self.update(path, current, key, desired, observed, source=self.scope_source,
                                          expected={'group': group['id'], 'vid': vid, 'site': site})
                else:
                    current = self.create(path, key, {**desired, 'vid': vid, 'group': group['id'],
                                          'site': site, 'status': 'active'}, observed, source=self.scope_source)
                    rows.append(current)
                if _ref(current.get('group')) != group['id'] or current.get('vid') != vid or _ref(current.get('site')) != site:
                    raise InventoryConflict('inventory_vlan_scope_changed')
                self.vlan_ids[vid] = current['id']
                self.remember('vlans', current['id'])
            except Exception as error:
                self.failure(error)

    def interface_links(self, kind, records):
        for observed in self.snapshot['interfaces']:
            self.client.check()
            if observed['key'] not in records:
                continue
            path, _, row = records[observed['key']]
            desired = {}
            try:
                if observed.get('mode') is not None:
                    desired['mode'] = observed['mode']
                    if 'untagged_vlan' in observed:
                        vid = observed['untagged_vlan']
                        if vid is not None and vid not in self.vlan_ids:
                            raise InventoryConflict('inventory_unknown_vlan_observation')
                        desired['untagged_vlan'] = self.vlan_ids.get(vid)
                    if 'tagged_vlans' in observed:
                        if any(vid not in self.vlan_ids for vid in observed['tagged_vlans']):
                            raise InventoryConflict('inventory_unknown_vlan_observation')
                        if observed['mode'] != 'tagged' and observed['tagged_vlans']:
                            raise InventoryConflict('inventory_invalid_vlan_mode')
                        desired['tagged_vlans'] = sorted(self.vlan_ids[vid] for vid in observed['tagged_vlans'])
                if 'lag' in observed and kind == 'device':
                    lag = observed['lag']
                    desired['lag'] = None
                    if lag is not None:
                        candidate = records.get(lag)
                        if (lag == observed['key'] or candidate is None
                                or _ref(candidate[2].get('type')) != 'lag'
                                or _ref(candidate[2].get('device')) != _ref(row.get('device'))):
                            raise InventoryConflict('inventory_invalid_lag_observation')
                        desired['lag'] = candidate[2]['id']
                if desired:
                    # VLAN fields form one validated assignment. If a human has
                    # changed one member, preserve the whole tuple, not a mix of
                    # manual and collected mode/membership that NetBox rejects.
                    self.update(path, row, 'interface:' + observed['key'], desired,
                                {k: copy.deepcopy(v) for k, v in observed.items() if k != 'addresses'},
                                claim_empty=('mode', 'untagged_vlan', 'tagged_vlans', 'lag'),
                                atomic_fields=('mode', 'untagged_vlan', 'tagged_vlans') if 'mode' in desired else ())
            except Exception as error:
                self.failure(error)

    def vrf(self, name):
        name = name.strip()
        if not name:
            return None
        if len(name) > 100:
            raise InventoryConflict('inventory_vrf_name_exceeds_native_limit')
        if name in self.vrfs:
            return self.vrfs[name]
        path, base_key = '/ipam/vrfs/', 'vrf:' + name
        observed = next((v for v in self.snapshot.get('vrfs', []) if v['name'].strip() == name), {'name': name})
        desired = {'name': name}
        if observed.get('rd'):
            desired['rd'] = observed['rd']
        rd = desired.get('rd')
        key = 'vrf-rd:' + str(len(name)) + ':' + name + ':' + rd if rd else base_key
        # Keep legacy target-owned VRFs usable; new network VRFs share the
        # explicit network source. Equal names with different RDs are distinct
        # routing domains, not an instruction to overwrite another PE's RD.
        value, owner = None, self.scope_source
        for source in dict.fromkeys((self.scope_source, self.source)):
            value = self.owned(path, key, source=source)
            if value:
                owner = source
                break
            if rd:
                legacy = self.owned(path, base_key, source=source)
                fields = (legacy or {}).get('custom_fields') or {}
                meta = fields.get(META) or {}
                if legacy and (legacy.get('rd') == rd or (
                        not legacy.get('rd') and 'rd' not in meta.get('protected', [])
                        and not meta.get('native', {}).get('rd'))):
                    value, owner, key = legacy, source, base_key
                    break
        if value:
            if rd and value.get('rd') not in (None, '', rd):
                raise InventoryConflict('inventory_vrf_identity_changed')
            if rd and any(row['id'] != value['id'] for row in self.client.all(path, rd=rd)):
                raise InventoryConflict('inventory_vrf_rd_conflict')
            value = self.update(path, value, key, desired, observed, source=owner, claim_empty=('rd',),
                                expected={'rd': value.get('rd')} if rd else None)
            if rd and value.get('rd') != rd:
                raise InventoryConflict('inventory_vrf_identity_changed')
        else:
            rows = self.client.all(path, name=name)
            if rd:
                rows = [row for row in rows if row.get('rd') == rd]
            if len(rows) > 1:
                raise InventoryConflict('inventory_ambiguous_vrf')
            if rows:
                value = rows[0]
                fields = value.get('custom_fields') or {}
                if fields.get(SOURCE) in (self.scope_source, self.source):
                    expected_key = ('vrf-rd:' + str(len(name)) + ':' + name + ':' + value['rd']
                                    if value.get('rd') else base_key)
                    if fields.get(KEY) not in (base_key, expected_key):
                        raise InventoryConflict('inventory_invalid_ownership_record')
                    value = self.update(path, value, fields[KEY], {}, observed, source=fields[SOURCE])
                elif fields.get(SOURCE):
                    raise InventoryConflict('inventory_foreign_vrf_scope')
            else:
                if rd and self.client.all(path, rd=rd):
                    raise InventoryConflict('inventory_vrf_rd_conflict')
                value = self.create(path, key, desired, observed, source=self.scope_source)
        self.vrfs[name] = value['id']
        self.remember('vrfs', value['id'])
        return value['id']

    def prefix(self, address, vrf):
        network = address.network
        if address.network.prefixlen in (0, address.max_prefixlen):
            return
        key = (str(network), vrf)
        if key in self.prefixes:
            return
        rows = [v for v in self.client.all('/ipam/prefixes/', prefix=str(network))
                if _ref(v.get('vrf')) == vrf and ipaddress.ip_network(v['prefix']) == network]
        if len(rows) > 1:
            raise InventoryConflict('inventory_ambiguous_prefix')
        value = rows[0] if rows else self.create('/ipam/prefixes/', 'prefix:' + str(vrf) + ':' + str(network),
                                                {'prefix': str(network), 'vrf': vrf, 'status': 'active'}, {'prefix': str(network)})
        self.prefixes.add(key)
        self.remember('prefixes', value['id'])

    def ip(self, object_type, interface, item):
        try:
            address = ipaddress.ip_interface(item['address'])
        except ValueError:
            self.report['errors'] += 1
            self.warn('inventory_invalid_address_observation')
            return None
        try:
            _safe_address(address.ip)
        except ValueError:
            # OS snapshots normally contain loopback/link-local addresses. They
            # are not globally meaningful IPAM assignments, not a poll failure.
            return None
        vrf = self.vrf(item.get('vrf', ''))
        claim = (str(address.ip), vrf)
        if claim in self.ip_assignments and self.ip_assignments[claim] != (object_type, interface['id']):
            raise InventoryConflict('inventory_ambiguous_ip_assignment')
        self.ip_assignments[claim] = (object_type, interface['id'])
        self.prefix(address, vrf)
        key = 'ip:' + str(vrf) + ':' + str(address.ip)
        current = self.owned('/ipam/ip-addresses/', key)
        rows = [v for v in self.client.all('/ipam/ip-addresses/', address=str(address.ip))
                if _ref(v.get('vrf')) == vrf and ipaddress.ip_interface(v['address']).ip == address.ip]
        if any(v['id'] != (current or {}).get('id') for v in rows):
            raise InventoryConflict('inventory_unowned_ip_conflict')
        desired = {'address': str(address), 'vrf': vrf,
                   'assigned_object_type': object_type, 'assigned_object_id': interface['id']}
        value = (self.update('/ipam/ip-addresses/', current, key, desired, {'address': str(address)}) if current
                 else self.create('/ipam/ip-addresses/', key, {**desired, 'status': 'active'}, {'address': str(address)}))
        if (ipaddress.ip_interface(value['address']).ip != address.ip or _ref(value.get('vrf')) != vrf
                or _ref(value.get('assigned_object_type')) != object_type or value.get('assigned_object_id') != interface['id']):
            raise InventoryConflict('inventory_ip_assignment_changed')
        self.remember('ip_addresses', value['id'])
        return value

    def disks(self, asset):
        path = '/virtualization/virtual-disks/'
        rows = self.client.all(path, virtual_machine_id=asset['id'])
        for disk in self.snapshot['disks']:
            self.client.check()
            try:
                key, name = 'disk:' + disk['name'], disk['name'].strip()[:64]
                current = self.owned(path, key)
                desired = {'name': name, 'size': (disk['size_bytes'] + 999999) // 1000000}
                if current:
                    if _ref(current.get('virtual_machine')) != asset['id']:
                        raise InventoryConflict('inventory_disk_parent_changed')
                    value = self.update(path, current, key, desired, disk)
                else:
                    if any(v.get('name') == name for v in rows):
                        raise InventoryConflict('inventory_unowned_disk_conflict')
                    value = self.create(path, key, {**desired, 'virtual_machine': asset['id']}, disk)
                    rows.append(value)
                self.remember('virtual_disks', value['id'])
            except Exception as error:
                self.failure(error)

    def run(self):
        try:
            kind, asset_path, asset = self.asset()
        except Exception as error:
            self.failure(error)
            self.report['state'] = 'failed'
            return self.report
        try:
            self.vlans(asset)
        except Exception as error:
            self.failure(error)
        for observed in self.snapshot.get('vrfs', []):
            try:
                self.vrf(observed['name'])
            except Exception as error:
                self.failure(error)
        addresses, records = [], {}
        for observed in self.snapshot['interfaces']:
            self.client.check()
            try:
                path, object_type, interface = self.interface(kind, asset, observed)
                records[observed['key']] = (path, object_type, interface)
            except Exception as error:
                self.failure(error)
                continue
            try:
                self.mac(path, object_type, interface, observed)
            except Exception as error:
                self.failure(error)
            for item in observed.get('addresses', []):
                self.client.check()
                try:
                    value = self.ip(object_type, interface, item)
                    if value:
                        addresses.append(value)
                except Exception as error:
                    self.failure(error)
        self.interface_links(kind, records)
        primary = {}
        for family in (4, 6):
            values = {v['id']: v for v in addresses if ipaddress.ip_interface(v['address']).version == family}
            exact = [v for v in values.values() if str(ipaddress.ip_interface(v['address']).ip) == self.target['address']]
            if len(exact) == 1:
                primary['primary_ip' + str(family)] = exact[0]['id']
            elif len(values) == 1:
                primary['primary_ip' + str(family)] = next(iter(values))
        if primary:
            try:
                observed = (asset.get('custom_fields') or {})[META]['observed']
                self.update(asset_path, asset, 'asset', primary, observed,
                            claim_empty=('primary_ip4', 'primary_ip6'))
            except Exception as error:
                self.failure(error)
        if kind == 'virtual_machine':
            self.disks(asset)
        if self.report['errors'] or self.report['conflicts']:
            self.report['state'] = 'partial'
        return self.report


def sync_snapshot(client, target, snapshot, *, deadline=None):
    """Converge one validated observation; retries reuse durable source identities.

    A rejected object does not authorize rollback of previously accepted objects.
    Invalid input raises a safe ValueError before any API call; operational
    failures/conflicts return a bounded report with no raw response or exception.
    Counters describe accepted owned-object API writes (not catalog references).
    """
    if deadline is None:
        deadline = time.monotonic() + DEFAULT_BUDGET_SECONDS
    elif type(deadline) not in (int, float) or not math.isfinite(deadline):
        raise ValueError('inventory_invalid_deadline')
    target, snapshot = _validated(target, snapshot)
    operation = _Sync(client, target, snapshot, deadline)
    try:
        return operation.run()
    except InventoryDeadlineExceeded:
        operation.report['errors'] += 1
        operation.warn('inventory_timeout')
        operation.report['state'] = 'partial' if operation.report['object_id'] is not None else 'failed'
        return operation.report
