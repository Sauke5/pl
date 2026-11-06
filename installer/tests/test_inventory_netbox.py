"""Stateful NetBox API boundary tests; no real NetBox, sockets, SNMP or SSH.

The real writer runs against a constrained in-memory API model with conditional
writes and NetBox4.7 MAC/VM/IP fields. Native acceptance is a separate check.
"""
import copy
import importlib.util
import ipaddress
import json
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('pl_inventory_netbox', ROOT / 'apps/netmap-stack/inventory_netbox.py')
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)
SOURCE, KEY, META = writer.SOURCE, writer.KEY, writer.META
DEVICE = '/dcim/devices/'
IFACE = '/dcim/interfaces/'
VM = '/virtualization/virtual-machines/'
VMIF = '/virtualization/interfaces/'
DISK = '/virtualization/virtual-disks/'
MAC = '/dcim/mac-addresses/'
IP = '/ipam/ip-addresses/'
PREFIX = '/ipam/prefixes/'
VRF = '/ipam/vrfs/'
VLANGROUP = '/ipam/vlan-groups/'
VLAN = '/ipam/vlans/'


class NativeBoundary:
    """Finite fake API: row ETags, reference objects, partial custom-field PATCH."""
    def __init__(self):
        paths = [DEVICE, IFACE, VM, VMIF, DISK, MAC, IP, PREFIX, VRF, VLANGROUP, VLAN, '/dcim/sites/',
                 '/dcim/manufacturers/', '/dcim/device-types/', '/dcim/device-roles/']
        self.rows = {path: [] for path in paths}
        self.writes, self.calls = [], []
        self.after_create = None
        self.after_patch = None
        self.before_get = None
        self.before_patch = None
        self.budgets = []

    def bounded(self, deadline):
        self.budgets.append(deadline)
        return self

    def seed(self, path, **body):
        row = {'id': len(self.rows[path]) + 1, 'custom_fields': {}, '_revision': 1, **copy.deepcopy(body)}
        self.rows[path].append(row)
        return row

    def version(self, row):
        return 'W/"2026-11-06T00:00:00.' + str(row['_revision']).zfill(6) + '+00:00"'

    def response(self, row):
        value = {k: copy.deepcopy(v) for k, v in row.items() if not k.startswith('_')}
        for key in ('device', 'virtual_machine', 'site', 'role', 'device_type', 'manufacturer',
                    'primary_mac_address', 'primary_ip4', 'primary_ip6', 'vrf', 'group', 'lag', 'untagged_vlan'):
            if type(value.get(key)) is int:
                value[key] = {'id': value[key]}
        if 'type' in value:
            value['type'] = {'value': value['type'], 'label': value['type']}
        if 'mode' in value:
            value['mode'] = {'value': value['mode'], 'label': value['mode']} if value['mode'] else None
        if 'tagged_vlans' in value:
            value['tagged_vlans'] = [{'id': identifier} for identifier in value['tagged_vlans']]
        if 'vcpus' in value and value['vcpus'] is not None:
            value['vcpus'] = str(value['vcpus']) + '.00'
        return value

    def all(self, path, **query):
        self.calls.append(('all', path, query))
        if path not in self.rows:
            raise AssertionError('Unexpected API path: ' + path)
        def matches(row, key, wanted):
            if key.startswith('cf_'):
                return row['custom_fields'].get(key[3:]) == wanted
            if key.endswith('_id'):
                key = key[:-3]
            if key == 'address':
                return ipaddress.ip_interface(row[key]).ip == ipaddress.ip_interface(wanted).ip
            return row.get(key) == wanted
        return [self.response(row) for row in self.rows[path]
                if all(matches(row, key, wanted) for key, wanted in query.items())]

    def get_or_create(self, path, lookup, body):
        rows = self.all(path, **lookup)
        if len(rows) > 1:
            raise AssertionError('Ambiguous fixture reference')
        return rows[0] if rows else self.request('POST', path, body)

    def validate(self, path, body, row=None):
        if path == VM:
            candidate = {**(row or {}), **body}
            if not any(candidate.get(k) for k in ('site', 'cluster', 'device')):
                raise AssertionError('NetBox4.7 VM requires a placement')
        if path in (IFACE, VMIF) and 'mac_address' in body:
            raise AssertionError('MAC must use the explicit NetBox4.7 MAC model')
        if path == VMIF and any(k in body for k in ('type', 'speed', 'lag')):
            raise AssertionError('VMInterface has no physical type or speed field')
        if path in (IFACE, VMIF):
            candidate = {**(row or {}), **body}
            if candidate.get('tagged_vlans') and candidate.get('mode') != 'tagged':
                raise AssertionError('Only tagged mode accepts explicit tagged VLANs')
            if not candidate.get('mode') and candidate.get('untagged_vlan'):
                raise AssertionError('Routed interface cannot have an untagged VLAN')
            for identifier in candidate.get('tagged_vlans', []) + ([candidate['untagged_vlan']] if candidate.get('untagged_vlan') else []):
                if not any(v['id'] == identifier for v in self.rows[VLAN]):
                    raise AssertionError('Unknown VLAN assignment')
        if path == VLANGROUP:
            candidate = {**(row or {}), **body}
            if candidate.get('scope_type') != 'dcim.site' or not candidate.get('scope_id'):
                raise AssertionError('Inventory VLAN group requires a site scope')
        if path == VLAN:
            candidate = {**(row or {}), **body}
            if not any(group['id'] == candidate.get('group') for group in self.rows[VLANGROUP]):
                raise AssertionError('Unknown VLAN group')
            if any(v['group'] == candidate['group'] and v['vid'] == candidate['vid'] and v is not row for v in self.rows[VLAN]):
                raise RuntimeError('400 VLAN VID must be unique within group')
            if any(v['group'] == candidate['group'] and v['name'] == candidate['name'] and v is not row for v in self.rows[VLAN]):
                raise RuntimeError('400 VLAN name must be unique within group')
        if path == VRF and body.get('rd') and any(v.get('rd') == body['rd'] and v is not row for v in self.rows[VRF]):
            raise RuntimeError('400 VRF RD must be unique')
        if path == MAC:
            self.assert_assignment({**(row or {}), **body})
        if path == IP:
            candidate = {**(row or {}), **body}
            ipaddress.ip_interface(candidate['address'])
            self.assert_assignment(candidate)
        if path == DISK:
            candidate = {**(row or {}), **body}
            if type(candidate.get('size')) is not int or not 0 <= candidate['size'] < 2**31:
                raise AssertionError('VirtualDisk size must be integer MB')
        if path == DEVICE and body.get('device_type') is None and row is None:
            raise AssertionError('Device must have an actual DeviceType')
        if row is None and path in (IFACE, VMIF, DISK):
            parent = 'device' if path == IFACE else 'virtual_machine'
            if any(r[parent] == body[parent] and r['name'] == body['name'] for r in self.rows[path]):
                raise RuntimeError('400 interface/disk name must be unique within parent')

    def assert_assignment(self, candidate):
        path = {'dcim.interface': IFACE, 'virtualization.vminterface': VMIF}.get(candidate.get('assigned_object_type'))
        if path is None or not any(r['id'] == candidate.get('assigned_object_id') for r in self.rows[path]):
            raise AssertionError('Unknown assigned interface')

    def request(self, method, path, body=None, *, version=None, include_version=False):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == 'POST':
            self.validate(path, body)
            row = self.seed(path, **body)
            self.writes.append((method, path, copy.deepcopy(body)))
            if self.after_create:
                self.after_create(path, row)
        else:
            collection, raw_id = path.rstrip('/').rsplit('/', 1)
            path = collection + '/'
            row = next(r for r in self.rows[path] if r['id'] == int(raw_id))
            if method == 'PATCH':
                if self.before_patch:
                    self.before_patch(path, row, body)
                if version != self.version(row):
                    raise RuntimeError('412 private response contains a credential fixture-secret')
                self.validate(path, body, row)
                for key, value in copy.deepcopy(body).items():
                    if key == 'custom_fields':
                        row['custom_fields'].update(value)
                    else:
                        row[key] = value
                row['_revision'] += 1
                self.writes.append((method, path, copy.deepcopy(body)))
                if self.after_patch:
                    self.after_patch(path, row)
            elif method != 'GET':
                raise AssertionError('Writer must never delete or use arbitrary methods')
            elif self.before_get:
                self.before_get(path, row)
        value = self.response(row)
        return (value, self.version(row)) if include_version else value


def snapshot(virtualization='physical'):
    return {'schema': 1, 'kind': 'linux', 'observed_at': '2026-11-06T10:00:00Z',
            'hostname': 'fixture-host', 'manufacturer': 'Fixture maker', 'model': 'Fixture model',
            'serial': 'observed-serial', 'os_name': 'Fixture Linux', 'os_version': '1',
            'virtualization': virtualization, 'cpu_count': 2, 'memory_mib': 4096,
            'disks': [{'name': 'disk0', 'size_bytes': 4000001}],
            'interfaces': [
                {'key': 'stable-1', 'name': 'eth0', 'description': 'Observed description',
                 'mac_address': '02:00:00:00:00:01', 'mtu': 1500, 'speed_mbps': 1000,
                 'enabled': True, 'link_up': True, 'type': 'physical',
                 'addresses': [{'address': '192.0.2.10/24', 'vrf': ''}, {'address': '2001:db8::10/64', 'vrf': ''}]},
                {'key': 'stable-2', 'name': 'eth1', 'description': '', 'mac_address': '02:00:00:00:00:02',
                 'mtu': None, 'speed_mbps': None, 'enabled': False, 'link_up': False, 'type': 'virtual', 'addresses': []},
            ], 'warnings': [], 'capabilities': {'interfaces': True, 'hardware': True, 'lldp': False}}


class InventorySyncTests(unittest.TestCase):
    def setUp(self):
        self.api = NativeBoundary()
        self.target = {'id': 'b210573a-8369-41ef-8d56-4b7499126aab', 'kind': 'linux',
                       'address': '192.0.2.10', 'name': 'fixture target'}
        self.observed = snapshot()

    def sync(self):
        return writer.sync_snapshot(self.api, self.target, self.observed)

    def test_physical_inventory_uses_first_class_mac_ip_prefix_and_primary_ips(self):
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertEqual((len(self.api.rows[DEVICE]), len(self.api.rows[IFACE]), len(self.api.rows[MAC]), len(self.api.rows[IP])), (1, 2, 2, 2))
        device = self.api.rows[DEVICE][0]
        self.assertEqual(report['object_type'], 'dcim.device')
        self.assertEqual((device['primary_ip4'], device['primary_ip6']), (1, 2))
        self.assertEqual(self.api.rows[IFACE][0]['speed'], 1000000)
        self.assertEqual(self.api.rows[IFACE][0]['primary_mac_address'], 1)
        self.assertEqual(self.api.rows[MAC][0]['assigned_object_type'], 'dcim.interface')
        self.assertEqual(self.api.rows[IP][0]['assigned_object_id'], self.api.rows[IFACE][0]['id'])
        self.assertEqual({r['prefix'] for r in self.api.rows[PREFIX]}, {'192.0.2.0/24', '2001:db8::/64'})
        self.assertEqual(device['custom_fields'][META]['observed']['memory_mib'], 4096)
        self.assertFalse(self.api.rows[VM] or self.api.rows[DISK])

    def test_replaying_identical_snapshot_has_no_duplicate_or_additional_write(self):
        first = self.sync()
        sizes = {p: len(v) for p, v in self.api.rows.items()}
        writes = len(self.api.writes)
        second = self.sync()
        self.assertEqual(second['state'], 'succeeded', second)
        self.assertEqual(second['ids'], first['ids'])
        self.assertEqual(second['created'], 0)
        self.assertEqual(second['updated'], 0)
        self.assertEqual(sizes, {p: len(v) for p, v in self.api.rows.items()})
        self.assertEqual(len(self.api.writes), writes)

    def test_second_observation_preserves_manual_fields_and_records_fresh_values(self):
        self.sync()
        device, interface = self.api.rows[DEVICE][0], self.api.rows[IFACE][0]
        device.update(name='Manual name', serial='Manual serial', site=987, role=988, device_type=989,
                      tags=[17], comments='Manual comments')
        device['custom_fields']['manual'] = 'Keep me'
        interface.update(name='Manual port', type='10gbase-x-sfpp', description='Manual alias', enabled=False)
        interface['custom_fields']['manual'] = 'Keep port data'
        self.observed.update(hostname='new observed name', serial='new serial', memory_mib=8192,
                             observed_at='2026-11-06T11:00:00Z')
        self.observed['interfaces'][0].update(name='observed-port', description='new alias')
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertGreater(report['manual_preserved'], 0)
        self.assertEqual((device['name'], device['serial'], device['site'], device['role'], device['device_type']),
                         ('Manual name', 'Manual serial', 987, 988, 989))
        self.assertEqual((device['tags'], device['comments'], device['custom_fields']['manual']), ([17], 'Manual comments', 'Keep me'))
        self.assertEqual((interface['name'], interface['type'], interface['description'], interface['enabled']),
                         ('Manual port', '10gbase-x-sfpp', 'Manual alias', False))
        self.assertEqual(interface['custom_fields']['manual'], 'Keep port data')
        self.assertEqual(interface['custom_fields'][META]['observed']['description'], 'new alias')
        self.assertEqual(device['custom_fields'][META]['observed']['memory_mib'], 8192)

    def test_vm_native_cpu_ram_interfaces_mac_and_disks_use_netbox47_model(self):
        self.observed['virtualization'] = 'vm'
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertEqual(report['object_type'], 'virtualization.virtualmachine')
        self.assertFalse(self.api.rows[DEVICE] or self.api.rows[IFACE] or self.api.rows['/dcim/device-types/'])
        vm = self.api.rows[VM][0]
        self.assertEqual((vm['vcpus'], vm['memory']), (2, 4096))
        self.assertTrue(vm['site'])
        self.assertNotIn('cluster', vm)
        self.assertEqual(self.api.rows[DISK][0]['size'], 5)  # API size is MB, exact bytes are preserved.
        self.assertEqual(self.api.rows[DISK][0]['custom_fields'][META]['observed']['size_bytes'], 4000001)
        self.assertEqual(self.api.rows[MAC][0]['assigned_object_type'], 'virtualization.vminterface')
        self.assertNotIn('type', self.api.rows[VMIF][0])
        self.observed.update(cpu_count=4, memory_mib=8192)
        self.observed['disks'][0]['size_bytes'] = 8000000
        retry = self.sync()
        self.assertEqual(retry['state'], 'succeeded', retry)
        self.assertEqual((vm['vcpus'], vm['memory'], self.api.rows[DISK][0]['size']), (4, 8192, 8))

    def test_vm_manual_capacity_is_preserved_and_absence_never_deletes_disks(self):
        self.observed['virtualization'] = 'vm'
        self.sync()
        vm, disk = self.api.rows[VM][0], self.api.rows[DISK][0]
        vm.update(vcpus=12, memory=32768)
        disk['size'] = 12000
        self.observed.update(cpu_count=6, memory_mib=16384)
        self.observed['disks'][0]['size_bytes'] = 6000000
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual((vm['vcpus'], vm['memory'], disk['size']), (12, 32768, 12000))
        self.observed.update(cpu_count=None, memory_mib=None, disks=[], interfaces=[])
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual((len(self.api.rows[VMIF]), len(self.api.rows[DISK]), len(self.api.rows[IP])), (2, 1, 2))

    def seed_snmp(self, *, duplicate=False):
        self.target['network_id'] = '0123456789abcdef'
        device = self.api.seed(DEVICE, name='Manual SNMP name', site=45, role=46, device_type=47,
                               serial='Kept serial', primary_ip4=None, primary_ip6=None,
                               custom_fields={'pl_source': 'network:' + self.target['network_id'],
                                              'collector_ip': self.target['address'], 'collector_profile': 'manual-ssh',
                                              'oxidized_model': 'vrp', 'manual': 'preserved'})
        interface = self.api.seed(IFACE, device=device['id'], name='Manual port', type='10gbase-x-sfpp',
                                  description='Manual alias', enabled=False, primary_mac_address=None,
                                  custom_fields={'pl_source': 'network:' + self.target['network_id'],
                                                 'pl_if_index': '1', 'pl_observed_if_name': 'eth0'})
        if duplicate:
            self.api.seed(DEVICE, **{k: v for k, v in device.items() if k not in ('id', '_revision')})
        self.observed['interfaces'][0]['key'] = '1'
        return device, interface

    def test_explicit_network_attachment_adopts_exact_snmp_device_and_interfaces(self):
        device, interface = self.seed_snmp()
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertEqual((report['object_id'], len(self.api.rows[DEVICE]), len(self.api.rows[IFACE])), (device['id'], 1, 2))
        self.assertEqual((device['name'], device['site'], device['role'], device['device_type']), ('Manual SNMP name', 45, 46, 47))
        self.assertEqual(device['custom_fields']['collector_profile'], 'manual-ssh')
        self.assertEqual(device['custom_fields']['oxidized_model'], 'vrp')
        self.assertEqual(interface['name'], 'Manual port')
        self.assertEqual(interface['description'], 'Manual alias')
        self.assertEqual(device['primary_ip4'], 1)
        self.assertEqual(interface['primary_mac_address'], 1)

    def test_missing_attachment_ambiguous_or_foreign_owner_never_adopts(self):
        for case in ('missing', 'ambiguous', 'foreign'):
            with self.subTest(case=case):
                self.setUp()
                device, _ = self.seed_snmp(duplicate=case == 'ambiguous')
                if case == 'missing':
                    self.target.pop('network_id')
                if case == 'foreign':
                    device['custom_fields'].update({SOURCE: 'inventory:another-target', KEY: 'asset'})
                before = copy.deepcopy(self.api.rows)
                report = self.sync()
                self.assertEqual(report['state'], 'failed', report)
                self.assertEqual(report['conflicts'], 1)
                self.assertEqual(self.api.rows, before)
                self.assertFalse(self.api.writes)

    def test_manual_interface_and_ip_conflicts_do_not_capture_unowned_objects(self):
        self.sync()
        interface = self.api.rows[IFACE][0]
        interface['custom_fields'] = {'manual': 'unowned'}
        before = copy.deepcopy(interface)
        report = self.sync()
        self.assertEqual(report['state'], 'partial')
        self.assertIn('inventory_unowned_interface_conflict', report['warnings'])
        self.assertEqual(interface, before)
        self.assertEqual(len(self.api.rows[IFACE]), 2)
        self.setUp()
        manual = self.api.seed(IP, address='192.0.2.10/24', vrf=None, custom_fields={'manual': 'ip'})
        before = copy.deepcopy(manual)
        report = self.sync()
        self.assertEqual(report['state'], 'partial', report)
        self.assertIn('inventory_unowned_ip_conflict', report['warnings'])
        self.assertEqual(manual, before)
        self.assertIsNone(self.api.rows[DEVICE][0]['primary_ip4'])

    def test_unique_manual_vrf_and_prefix_are_only_referenced(self):
        vrf = self.api.seed(VRF, name='Blue', rd='65000:1', custom_fields={'manual': 'vrf'})
        prefix = self.api.seed(PREFIX, prefix='192.0.2.0/24', vrf=vrf['id'], status='reserved', custom_fields={'manual': 'prefix'})
        before = copy.deepcopy((vrf, prefix))
        self.observed['interfaces'][0]['addresses'][0]['vrf'] = 'Blue'
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertEqual((vrf, prefix), before)
        self.assertEqual(self.api.rows[IP][0]['vrf'], vrf['id'])
        self.assertFalse(any(method == 'PATCH' and path in (VRF, PREFIX) for method, path, _ in self.api.writes))

    def test_ambiguous_vrf_cannot_assign_address_in_arbitrary_routing_domain(self):
        for rd in ('65000:1', '65000:2'):
            self.api.seed(VRF, name='Blue', rd=rd)
        self.observed['interfaces'][0]['addresses'] = [{'address': '192.0.2.10/24', 'vrf': 'Blue'}]
        report = self.sync()
        self.assertEqual(report['state'], 'partial', report)
        self.assertIn('inventory_ambiguous_vrf', report['warnings'])
        self.assertFalse(self.api.rows[IP] or self.api.rows[PREFIX])

    def test_accepted_but_lost_create_responses_converge_without_duplicate_objects(self):
        for path in (DEVICE, IFACE, MAC, IP, DISK):
            with self.subTest(path=path):
                self.setUp()
                if path == DISK:
                    self.observed['virtualization'] = 'vm'
                triggered = []
                def fail_after_create(actual_path, row):
                    if actual_path == path and not triggered:
                        triggered.append(True)
                        raise RuntimeError('private upstream credential fixture-secret')
                self.api.after_create = fail_after_create
                first = self.sync()
                self.assertIn(first['state'], ('failed', 'partial'))
                self.assertNotIn('fixture-secret', str(first))
                self.api.after_create = None
                retry = self.sync()
                self.assertEqual(retry['state'], 'succeeded', retry)
                self.assertEqual(len(self.api.rows[VM if path == DISK else DEVICE]), 1)
                self.assertEqual(len(self.api.rows[VMIF if path == DISK else IFACE]), 2)
                self.assertEqual((len(self.api.rows[MAC]), len(self.api.rows[IP])), (2, 2))
                self.assertEqual(len(self.api.rows[DISK]), int(path == DISK))

    def test_conditional_write_detects_concurrent_manual_edit_and_retry_preserves_it(self):
        self.sync()
        self.observed['hostname'] = 'Changed by collector'
        fired = []
        def race(path, row, body):
            if path == DEVICE and not fired:
                fired.append(True)
                row['name'] = 'Concurrent human edit'
                row['_revision'] += 1
        self.api.before_patch = race
        report = self.sync()
        self.assertEqual(report['state'], 'failed', report)
        self.assertEqual(self.api.rows[DEVICE][0]['name'], 'Concurrent human edit')
        self.assertNotIn('fixture-secret', str(report))
        self.api.before_patch = None
        retry = self.sync()
        self.assertEqual(retry['state'], 'succeeded', retry)
        self.assertEqual(self.api.rows[DEVICE][0]['name'], 'Concurrent human edit')

    def test_user_selected_primary_ip_is_preserved(self):
        self.sync()
        device = self.api.rows[DEVICE][0]
        device['primary_ip4'] = 987
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertEqual(device['primary_ip4'], 987)

    def test_unknown_virtualization_does_not_invent_hypervisor_and_unsupported_capability_is_not_failure(self):
        self.observed['virtualization'] = 'unknown'
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertEqual(report['object_type'], 'dcim.device')
        self.assertEqual(self.api.rows[DEVICE][0]['custom_fields'][META]['observed']['virtualization'], 'unknown')
        self.assertEqual(report['errors'], 0)

    def test_manual_numeric_hostname_is_not_coerced_to_a_number(self):
        self.observed['hostname'] = '0001'
        self.sync()
        self.api.rows[DEVICE][0]['name'] = '1'
        self.observed['hostname'] = '0002'
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual(self.api.rows[DEVICE][0]['name'], '1')

    def test_lost_accepted_patch_response_is_safe_to_retry(self):
        self.sync()
        self.observed['hostname'] = 'New observed hostname'
        fired = []
        def lost_response(path, row):
            if path == DEVICE and not fired:
                fired.append(True)
                raise RuntimeError('connection closed after accepted PATCH fixture-secret')
        self.api.after_patch = lost_response
        self.assertEqual(self.sync()['state'], 'failed')
        self.api.after_patch = None
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertEqual(self.api.rows[DEVICE][0]['name'], 'New observed hostname')
        self.assertEqual(len(self.api.rows[DEVICE]), 1)

    def test_manual_mac_and_ip_assignments_are_not_stolen_back(self):
        for path in (MAC, IP):
            with self.subTest(path=path):
                self.setUp()
                self.sync()
                row = self.api.rows[path][0]
                if path == MAC:
                    self.api.rows[IFACE][0]['primary_mac_address'] = None
                else:
                    self.api.rows[DEVICE][0]['primary_ip4'] = None
                row['assigned_object_id'] = self.api.rows[IFACE][1]['id']
                report = self.sync()
                self.assertEqual(report['state'], 'partial', report)
                self.assertEqual(row['assigned_object_id'], 2)
                self.assertIn('inventory_mac_assignment_changed' if path == MAC else 'inventory_ip_assignment_changed', report['warnings'])

    def test_attachment_changed_between_list_and_fresh_get_is_not_adopted(self):
        device, _ = self.seed_snmp()
        def change_binding(path, row):
            if path == DEVICE:
                row['custom_fields']['pl_source'] = 'network:fedcba9876543210'
        self.api.before_get = change_binding
        report = self.sync()
        self.assertEqual(report['state'], 'failed', report)
        self.assertIn('inventory_network_attachment_conflict', report['warnings'])
        self.assertNotIn(SOURCE, device['custom_fields'])
        self.assertFalse(self.api.writes)

    def test_multiple_observed_addresses_do_not_guess_a_primary_ip(self):
        self.observed['interfaces'][0]['addresses'] = [
            {'address': '198.51.100.1/24', 'vrf': ''}, {'address': '198.51.100.2/24', 'vrf': ''}]
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertIsNone(self.api.rows[DEVICE][0]['primary_ip4'])
        self.assertIsNone(self.api.rows[DEVICE][0]['primary_ip6'])

    def test_actual_host_normalizer_output_is_accepted_without_transport(self):
        collector_spec = importlib.util.spec_from_file_location('pl_inventory_collectors_contract', ROOT / 'apps/netmap-stack/inventory_collectors.py')
        collector = importlib.util.module_from_spec(collector_spec)
        collector_spec.loader.exec_module(collector)
        raw = copy.deepcopy(self.observed)
        raw['os_name'] = 'Observed OS ' * 40
        raw['interfaces'][0]['name'] = 'A long interface name ' * 6
        self.observed = collector._host_snapshot('linux', json.dumps(raw).encode())
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertLessEqual(len(self.api.rows[IFACE][0]['name']), 64)
        self.assertEqual(self.api.rows[IFACE][0]['custom_fields'][META]['observed']['name'], raw['interfaces'][0]['name'])
        self.assertEqual(self.api.rows[DEVICE][0]['custom_fields'][META]['observed']['os_name'], raw['os_name'])

    def test_valid_ifindex_is_kept_usable_by_existing_snmp_enrollment(self):
        self.target['network_id'] = '0123456789abcdef'
        self.observed['interfaces'][0]['key'] = '101'
        self.sync()
        fields = self.api.rows[IFACE][0]['custom_fields']
        self.assertEqual((fields['pl_source'], fields['pl_if_index']), ('network:0123456789abcdef', '101'))
        self.assertNotIn('pl_if_index', self.api.rows[IFACE][1]['custom_fields'])

    def test_linux_loopback_mtu_65536_and_zero_mac_are_normal_not_an_entire_snapshot_failure(self):
        self.observed['interfaces'].append({
            'key': '1', 'name': 'lo', 'description': '', 'mac_address': '00:00:00:00:00:00',
            'mtu': 65536, 'speed_mbps': None, 'enabled': True, 'link_up': True, 'type': 'virtual',
            'addresses': [{'address': '127.0.0.1/8', 'vrf': ''}, {'address': '::1/128', 'vrf': ''}]})
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertEqual(self.api.rows[IFACE][-1]['mtu'], 65536)
        self.assertEqual((len(self.api.rows[MAC]), len(self.api.rows[IP])), (2, 2))

    def test_expired_budget_has_no_api_calls_and_default_is_finite(self):
        with patch.object(writer.time, 'monotonic', return_value=100):
            expired = writer.sync_snapshot(self.api, self.target, self.observed, deadline=99)
            self.assertEqual(expired['state'], 'failed', expired)
            self.assertEqual((expired['errors'], expired['created'], expired['updated']), (1, 0, 0))
            self.assertEqual(expired['warnings'], ['inventory_timeout'])
            self.assertFalse(self.api.calls)
            self.assertEqual(self.sync()['state'], 'succeeded')
            self.assertEqual(self.api.budgets[-1], 220)

    def test_first_deadline_expiry_aborts_all_remaining_interfaces_and_preserves_accepted_ids(self):
        self.observed['interfaces'] = [
            {'key': str(i), 'name': 'port' + str(i), 'type': 'unknown', 'mac_address': '', 'addresses': []}
            for i in range(1024)]
        clock, expiry_calls = [100], []
        def expire_after_first_interface(path, row):
            if path == IFACE and not expiry_calls:
                clock[0] = 106
                expiry_calls.append(len(self.api.calls))
        self.api.after_create = expire_after_first_interface
        with patch.object(writer.time, 'monotonic', side_effect=lambda: clock[0]):
            report = writer.sync_snapshot(self.api, self.target, self.observed, deadline=105)
        self.assertEqual(report['state'], 'partial', report)
        self.assertEqual(report['warnings'], ['inventory_timeout'])
        self.assertEqual((report['created'], report['errors']), (2, 1))
        self.assertEqual(report['ids']['interfaces'], [1])
        self.assertEqual((len(self.api.rows[DEVICE]), len(self.api.rows[IFACE])), (1, 1))
        self.assertEqual(len(self.api.calls), expiry_calls[0])
        self.api.after_create = None
        with patch.object(writer.time, 'monotonic', return_value=200):
            retry = writer.sync_snapshot(self.api, self.target, self.observed, deadline=220)
        self.assertEqual(retry['state'], 'succeeded', retry)
        self.assertEqual((len(self.api.rows[DEVICE]), len(self.api.rows[IFACE])), (1, 1024))
        self.assertEqual(retry['object_id'], report['object_id'])
        self.assertEqual(self.api.rows[IFACE][0]['id'], report['ids']['interfaces'][0])

    def test_read_crossing_deadline_aborts_without_any_write_or_further_queries(self):
        clock = [100]
        original = self.api.all
        def slow_read(*args, **kwargs):
            value = original(*args, **kwargs)
            clock[0] = 106
            return value
        self.api.all = slow_read
        with patch.object(writer.time, 'monotonic', side_effect=lambda: clock[0]):
            report = writer.sync_snapshot(self.api, self.target, self.observed, deadline=105)
        self.assertEqual(report['state'], 'failed', report)
        self.assertEqual(report['warnings'], ['inventory_timeout'])
        self.assertEqual(len(self.api.calls), 1)
        self.assertFalse(self.api.writes)

    def test_deadline_inside_disk_loop_is_fatal_and_partial_retry_converges(self):
        self.observed['virtualization'] = 'vm'
        self.observed['disks'] = [{'name': 'disk' + str(i), 'size_bytes': 1000000} for i in range(128)]
        clock, expiry_calls = [100], []
        def expire_on_disk(path, row):
            if path == DISK and not expiry_calls:
                clock[0] = 106
                expiry_calls.append(len(self.api.calls))
        self.api.after_create = expire_on_disk
        with patch.object(writer.time, 'monotonic', side_effect=lambda: clock[0]):
            report = writer.sync_snapshot(self.api, self.target, self.observed, deadline=105)
        self.assertEqual(report['state'], 'partial', report)
        self.assertEqual(report['warnings'], ['inventory_timeout'])
        self.assertEqual(report['ids']['virtual_disks'], [1])
        self.assertEqual(len(self.api.rows[DISK]), 1)
        self.assertEqual(len(self.api.calls), expiry_calls[0])
        self.api.after_create = None
        with patch.object(writer.time, 'monotonic', return_value=200):
            retry = writer.sync_snapshot(self.api, self.target, self.observed, deadline=220)
        self.assertEqual(retry['state'], 'succeeded', retry)
        self.assertEqual((len(self.api.rows[VM]), len(self.api.rows[DISK])), (1, 128))

    def test_kind_change_and_unknown_existing_name_are_conflicts(self):
        self.sync()
        self.observed['virtualization'] = 'vm'
        report = self.sync()
        self.assertEqual(report['state'], 'failed', report)
        self.assertIn('inventory_object_kind_changed', report['warnings'])
        self.assertFalse(self.api.rows[VM])
        self.setUp()
        self.api.seed(DEVICE, name=self.observed['hostname'], custom_fields={})
        self.assertEqual(self.sync()['state'], 'failed')
        self.assertFalse(self.api.writes)

    def network_observation(self):
        self.target.update(kind='network', network_id='0123456789abcdef')
        self.observed.update(kind='network', vlans=[{'vid': 10, 'name': 'Users'}, {'vid': 20, 'name': 'Servers'}],
                             vrfs=[{'name': 'Blue', 'rd': '65000:10'}],
                             chassis=[{'slot': '1', 'role': 'Master', 'model': 'Observed chassis'}])
        self.observed['interfaces'][0].update(mode='tagged', untagged_vlan=10, tagged_vlans=[20], lag='bond')
        self.observed['interfaces'][0]['addresses'][0]['vrf'] = 'Blue'
        self.observed['interfaces'].append({'key': 'bond', 'name': 'Eth-Trunk1', 'type': 'lag', 'addresses': []})

    def test_native_vlan_vrf_and_forward_lag_assignments_are_retryable(self):
        self.network_observation()
        first = self.sync()
        self.assertEqual(first['state'], 'succeeded', first)
        group, vlan, vrf, interface = self.api.rows[VLANGROUP][0], self.api.rows[VLAN], self.api.rows[VRF][0], self.api.rows[IFACE][0]
        self.assertEqual((group['scope_type'], group['scope_id'], group['custom_fields'][SOURCE]),
                         ('dcim.site', self.api.rows[DEVICE][0]['site'], 'network:0123456789abcdef'))
        self.assertEqual((interface['mode'], interface['untagged_vlan'], interface['tagged_vlans'], interface['lag']),
                         ('tagged', vlan[0]['id'], [vlan[1]['id']], self.api.rows[IFACE][2]['id']))
        self.assertEqual(vrf['rd'], '65000:10')
        self.assertEqual(self.api.rows[IP][0]['vrf'], vrf['id'])
        self.assertEqual(self.api.rows[DEVICE][0]['custom_fields'][META]['observed']['chassis'], self.observed['chassis'])
        writes = len(self.api.writes)
        second = self.sync()
        self.assertEqual(second['state'], 'succeeded', second)
        self.assertEqual(second['ids'], first['ids'])
        self.assertEqual(len(self.api.writes), writes)

    def test_network_catalog_is_shared_within_network_and_isolated_from_other_networks(self):
        self.network_observation()
        self.observed['vrfs'] = []
        for port in self.observed['interfaces']:
            port.update(addresses=[], mac_address='')
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.target.update(id='c210573a-8369-41ef-8d56-4b7499126aab', address='192.0.2.11')
        self.observed['hostname'] = 'second device'
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual((len(self.api.rows[VLANGROUP]), len(self.api.rows[VLAN])), (1, 2))
        self.target.update(id='d210573a-8369-41ef-8d56-4b7499126aab', address='192.0.2.12', network_id='fedcba9876543210')
        self.observed['hostname'] = 'third device'
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual((len(self.api.rows[VLANGROUP]), len(self.api.rows[VLAN])), (2, 4))
        self.assertNotEqual(self.api.rows[IFACE][0]['untagged_vlan'], self.api.rows[IFACE][6]['untagged_vlan'])

    def test_duplicate_collected_vlan_descriptions_use_unique_native_names(self):
        self.network_observation()
        self.observed['vlans'] = [{'vid': 10, 'name': 'Same description' * 10}, {'vid': 20, 'name': 'Same description' * 10}]
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        first, second = self.api.rows[VLAN]
        self.assertNotEqual(first['name'], second['name'])
        self.assertLessEqual(max(len(first['name']), len(second['name'])), 64)
        self.assertEqual(first['custom_fields'][META]['observed']['name'], self.observed['vlans'][0]['name'])

    def test_vlan_moved_manually_between_list_and_fresh_get_is_not_changed_or_assigned(self):
        self.network_observation()
        self.sync()
        original_name = self.api.rows[VLAN][0]['name']
        def move_vlan(path, row):
            if path == VLAN and row['id'] == 1:
                row.update(group=999, vid=123)
        self.api.before_get = move_vlan
        self.observed['vlans'][0]['name'] = 'New observed name'
        report = self.sync()
        self.assertIn('inventory_native_identity_changed', report['warnings'])
        self.assertEqual(self.api.rows[VLAN][0]['name'], original_name)
        self.assertIn('inventory_unknown_vlan_observation', report['warnings'])

    def test_manual_vlan_tuple_lag_and_names_are_preserved_as_one_assignment(self):
        self.network_observation()
        self.sync()
        interface, vlan, vrf = self.api.rows[IFACE][0], self.api.rows[VLAN][0], self.api.rows[VRF][0]
        interface.update(mode='access', untagged_vlan=self.api.rows[VLAN][1]['id'], tagged_vlans=[], lag=None)
        vlan.update(name='Manual users', comments='Keep manual comments')
        vrf.update(rd='65000:99', description='Manual VRF')
        report = self.sync()
        self.assertEqual(report['state'], 'partial', report)
        self.assertIn('inventory_vrf_identity_changed', report['warnings'])
        self.assertGreaterEqual(report['manual_preserved'], 3)
        self.assertEqual((interface['mode'], interface['untagged_vlan'], interface['tagged_vlans'], interface['lag']),
                         ('access', self.api.rows[VLAN][1]['id'], [], None))
        self.assertEqual((vlan['name'], vlan['comments'], vrf['rd'], vrf['description']),
                         ('Manual users', 'Keep manual comments', '65000:99', 'Manual VRF'))
        self.assertTrue(all(name not in interface['custom_fields'][META]['native'] for name in ('mode', 'untagged_vlan', 'tagged_vlans', 'lag')))
        self.assertEqual(self.sync()['state'], 'partial')
        self.assertIsNone(interface['lag'])  # A manual clear must not be claimed again on the next poll.

    def test_manual_clear_of_all_vlan_fields_remains_protected_on_later_polls(self):
        self.network_observation()
        self.sync()
        interface = self.api.rows[IFACE][0]
        interface.update(mode='', untagged_vlan=None, tagged_vlans=[])
        for _ in range(2):
            report = self.sync()
            self.assertEqual(report['state'], 'succeeded', report)
            self.assertEqual((interface['mode'], interface['untagged_vlan'], interface['tagged_vlans']), ('', None, []))
        self.assertEqual(set(interface['custom_fields'][META]['protected']), {'mode', 'untagged_vlan', 'tagged_vlans'})

    def test_empty_snmp_vlan_assignment_is_claimed_but_manual_assignment_is_preserved(self):
        for manual in (False, True):
            with self.subTest(manual=manual):
                self.setUp()
                _, interface = self.seed_snmp()
                self.observed.update(vlans=[{'vid': 10, 'name': 'Users'}])
                self.observed['interfaces'][0].update(mode='access', untagged_vlan=10, tagged_vlans=[])
                interface.update(mode='access' if manual else '', untagged_vlan=None, tagged_vlans=[])
                report = self.sync()
                self.assertEqual(report['state'], 'succeeded', report)
                self.assertEqual(interface['untagged_vlan'], None if manual else self.api.rows[VLAN][0]['id'])
                if manual:
                    self.assertGreater(report['manual_preserved'], 0)

    def test_lost_vlan_vrf_creates_converge_without_duplicate_catalog_objects(self):
        for failing_path in (VLANGROUP, VLAN, VRF):
            with self.subTest(path=failing_path):
                self.setUp()
                self.network_observation()
                failed = []
                def lose_once(path, row):
                    if path == failing_path and not failed:
                        failed.append(row['id'])
                        raise RuntimeError('private transport error fixture-secret')
                self.api.after_create = lose_once
                first = self.sync()
                self.assertEqual(first['state'], 'partial', first)
                self.api.after_create = None
                retry = self.sync()
                self.assertEqual(retry['state'], 'succeeded', retry)
                self.assertEqual((len(self.api.rows[VLANGROUP]), len(self.api.rows[VLAN]), len(self.api.rows[VRF])), (1, 2, 1))
                self.assertNotIn('fixture-secret', json.dumps(first))

    def test_unique_manual_vrf_reference_with_matching_rd_is_not_claimed(self):
        self.network_observation()
        manual = self.api.seed(VRF, name='Blue', rd='65000:10', comments='Manual routing domain')
        before = copy.deepcopy(manual)
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual(manual, before)
        self.assertEqual(self.api.rows[IP][0]['vrf'], manual['id'])
        self.assertFalse(any(path.startswith(VRF) for _, path, _ in self.api.writes))

    def test_unclaimed_manual_rd_is_not_repurposed_for_a_different_reported_domain(self):
        self.network_observation()
        self.observed['vrfs'] = []
        self.sync()  # An address references Blue before an RD has been observed.
        vrf = self.api.rows[VRF][0]
        vrf['rd'] = '65000:99'
        self.observed['vrfs'] = [{'name': 'Blue', 'rd': '65000:10'}]
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual(vrf['rd'], '65000:99')
        vrf['rd'] = None
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertIsNone(vrf['rd'])
        self.assertEqual(len(self.api.rows[VRF]), 2)
        self.assertEqual(self.api.rows[VRF][1]['rd'], '65000:10')

    def test_two_devices_with_equal_vrf_names_and_different_rds_keep_separate_domains(self):
        self.network_observation()
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.target.update(id='c210573a-8369-41ef-8d56-4b7499126aab', address='192.0.2.11')
        self.observed.update(hostname='Second PE', vrfs=[{'name': 'Blue', 'rd': '65000:20'}])
        self.observed['interfaces'][0].update(mac_address='02:00:00:00:01:01',
            addresses=[{'address': '192.0.2.11/24', 'vrf': 'Blue'}])
        self.observed['interfaces'][1]['mac_address'] = '02:00:00:00:01:02'
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual([(v['name'], v['rd']) for v in self.api.rows[VRF]], [('Blue', '65000:10'), ('Blue', '65000:20')])
        ips = {v['address']: v['vrf'] for v in self.api.rows[IP]}
        self.assertNotEqual(ips['192.0.2.10/24'], ips['192.0.2.11/24'])
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual(len(self.api.rows[VRF]), 2)

    def test_fresh_parent_change_never_updates_an_interface_on_another_device(self):
        self.network_observation()
        self.sync()
        interface = self.api.rows[IFACE][0]
        original_name = interface['name']
        def move_interface(path, row):
            if path == IFACE and row['id'] == interface['id']:
                row['device'] = 999
        self.api.before_get = move_interface
        self.observed['interfaces'][0]['name'] = 'Do not apply to another device'
        self.api.writes.clear()
        report = self.sync()
        self.assertIn('inventory_interface_parent_changed', report['warnings'])
        self.assertEqual(interface['name'], original_name)
        self.assertFalse(any(path == IFACE and body.get('name') == 'Do not apply to another device'
                             for _, path, body in self.api.writes))

    def test_foreign_vrf_rd_and_manual_vlan_group_scope_are_conflicts(self):
        self.network_observation()
        self.api.seed(VRF, name='Blue', rd='65000:10', custom_fields={SOURCE: 'network:foreign', KEY: 'vrf:Blue'})
        report = self.sync()
        self.assertIn('inventory_foreign_vrf_scope', report['warnings'])
        self.assertFalse(any(v.get('vrf') for v in self.api.rows[IP]))
        self.api.rows[VLANGROUP][0]['scope_id'] = 999
        old = copy.deepcopy(self.api.rows[VLAN])
        report = self.sync()
        self.assertIn('inventory_vlan_group_scope_changed', report['warnings'])
        self.assertEqual(self.api.rows[VLAN], old)

    def test_unknown_vlan_and_invalid_lag_do_not_create_guessed_links(self):
        self.network_observation()
        self.observed['interfaces'][0]['tagged_vlans'] = [99]
        report = self.sync()
        self.assertIn('inventory_unknown_vlan_observation', report['warnings'])
        self.assertEqual((self.api.rows[IFACE][0]['mode'], self.api.rows[IFACE][0]['tagged_vlans'], self.api.rows[IFACE][0]['lag']), ('', [], None))
        self.observed['interfaces'][0].update(tagged_vlans=[20], lag='stable-2')
        report = self.sync()
        self.assertIn('inventory_invalid_lag_observation', report['warnings'])
        self.assertIsNone(self.api.rows[IFACE][0]['lag'])

    def test_missing_optional_observation_does_not_clear_vlan_lag_or_vrf_inventory(self):
        self.network_observation()
        self.sync()
        interface = self.api.rows[IFACE][0]
        before = {key: copy.deepcopy(interface[key]) for key in ('mode', 'untagged_vlan', 'tagged_vlans', 'lag')}
        self.observed.pop('vlans')
        self.observed.pop('vrfs')
        for port in self.observed['interfaces']:
            for key in ('mode', 'untagged_vlan', 'tagged_vlans', 'lag'):
                port.pop(key, None)
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual({key: interface[key] for key in before}, before)
        self.assertEqual((len(self.api.rows[VLAN]), len(self.api.rows[VRF])), (2, 1))

    def test_vm_vlan_assignment_uses_native_fields_without_inventing_lag(self):
        self.network_observation()
        self.observed['virtualization'] = 'vm'
        report = self.sync()
        self.assertEqual(report['state'], 'succeeded', report)
        self.assertEqual(self.api.rows[VMIF][0]['mode'], 'tagged')
        self.assertNotIn('lag', self.api.rows[VMIF][0])

    def test_deadline_during_vlan_catalog_stops_remaining_work_and_retry_converges(self):
        self.network_observation()
        clock = [100]
        def expire(path, row):
            if path == VLAN:
                clock[0] = 106
        self.api.after_create = expire
        with patch.object(writer.time, 'monotonic', side_effect=lambda: clock[0]):
            report = writer.sync_snapshot(self.api, self.target, self.observed, deadline=105)
        self.assertEqual(report['state'], 'partial', report)
        self.assertEqual(report['warnings'], ['inventory_timeout'])
        self.assertEqual((len(self.api.rows[VLAN]), len(self.api.rows[IFACE])), (1, 0))
        self.assertEqual(report['ids']['vlans'], [1])
        self.api.after_create = None
        self.assertEqual(self.sync()['state'], 'succeeded')
        self.assertEqual(len(self.api.rows[VLAN]), 2)

    def test_invalid_input_fails_before_any_api_call(self):
        for change in (
                lambda: self.target.update(address='169.254.169.254'),
                lambda: self.target.update(id='not-a-uuid'),
                lambda: self.observed.update(cpu_count=True),
                lambda: self.observed.update(memory_mib=float('nan')),
                lambda: self.observed.update(observed_at='not-a-date'),
                lambda: self.observed.update(vlans=[{'vid': True, 'name': 'Bad'}]),
                lambda: self.observed.update(vrfs=[{'name': 'Blue', 'rd': 'x' * 22}]),
                lambda: self.observed['interfaces'][0].update(tagged_vlans=[10, 10]),
                lambda: self.observed['interfaces'].append(copy.deepcopy(self.observed['interfaces'][0])),
                lambda: self.observed['interfaces'][0].update(password='forbidden'),
                lambda: self.observed.update(warnings=['raw error with password'])):
            with self.subTest(change=change):
                self.setUp()
                change()
                with self.assertRaisesRegex(ValueError, '^inventory_invalid_'):
                    self.sync()
                self.assertFalse(self.api.calls)


if __name__ == '__main__':
    unittest.main()
