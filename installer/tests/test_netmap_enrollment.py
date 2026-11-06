"""Explicit SNMP poll through real enrollment/sync; no sockets or Docker."""
import copy
import unittest
from unittest.mock import Mock

import test_netmap_access_profiles as profiles

service = profiles.service


class Inventory:
    """Stateful native API boundary: filters, conditional devices, partial fields."""
    def __init__(self):
        self.tables = {path: [] for path in ('/dcim/sites/', '/dcim/manufacturers/', '/dcim/device-types/',
            '/dcim/device-roles/', '/dcim/devices/', '/dcim/interfaces/')}
        self.tags = [{'id': 1, 'slug': 'pl-managed'}, {'id': 2, 'slug': 'network-config-backup'}]
        self.writes = []
        self.version = 'W/"2026-11-06T00:00:00+00:00"'

    def all(self, path, **query):
        rows = self.tags if path == '/extras/tags/' else self.tables[path]
        def matches(row, key, value):
            if key.startswith('cf_'):
                return row.get('custom_fields', {}).get(key[3:]) == value
            if key == 'tag':
                return any(tag['slug'] == value for tag in row.get('tags', []))
            if key in ('site_id', 'device_id'):
                return row.get(key[:-3]) == value
            return row.get(key) == value
        return copy.deepcopy([row for row in rows if all(matches(row, key, value) for key, value in query.items())])

    def get_or_create(self, path, lookup, body):
        found = self.all(path, **lookup)
        if len(found) > 1:
            raise AssertionError('Fixture identity conflict')
        return found[0] if found else self.request('POST', path, body)

    def request(self, method, path, body=None, *, version=None, include_version=False):
        if method == 'POST':
            rows = self.tables[path]
            row = {'id': len(rows) + 1, **copy.deepcopy(body)}
            if path == '/dcim/devices/':
                row['tags'] = [copy.deepcopy(tag) for tag in self.tags if tag['id'] in row['tags']]
            rows.append(row)
        else:
            collection, identifier = path.rstrip('/').rsplit('/', 1)
            rows = self.tables[collection + '/']
            row = next(row for row in rows if row['id'] == int(identifier))
            if method == 'PATCH':
                if collection == '/dcim/devices' and version != self.version:
                    raise AssertionError('Device write lost its conditional version')
                for key, value in body.items():
                    if key == 'custom_fields':
                        row.setdefault(key, {}).update(copy.deepcopy(value))
                    else:
                        row[key] = copy.deepcopy(value)
            elif method != 'GET':
                raise AssertionError('Unexpected native mutation')
        if method != 'GET':
            self.writes.append((method, path, copy.deepcopy(body)))
        value = copy.deepcopy(row)
        return (value, self.version) if include_version else value


class EnrollmentTests(unittest.TestCase):
    change = profiles.OrderedProfiles.change
    network = profiles.OrderedProfiles.network

    def setUp(self):
        profiles.OrderedProfiles.setUp(self)
        self.inventory = Inventory()
        self.app.netbox = self.inventory
        self.app.probe_host = Mock(side_effect=AssertionError('SNMP responder must not fall back to host discovery'))
        self.collector_sources = []
        def reload(deadline):
            nodes = self.app.nodes()
            self.collector_sources.append(nodes)
            return {'state': 'ready', 'targets': len(nodes)}
        self.app.reload_collector = reload
        self.generation = 1
        self.probes = []
        def probe(address, profile, deadline):
            name = profile['snmp_community']
            self.probes.append((address, name))
            if (address, name) not in (('192.0.2.1', 'private-a'), ('192.0.2.2', 'private-b')):
                return None
            return {'ip': address, 'name': 'observed-switch-' + address[-1], 'description': 'observed generation ' + str(self.generation),
                'interfaces': [{'index': str(index), 'name': 'port' + str(index), 'description': 'Port ' + str(index),
                    'alias': 'observed alias ' + str(self.generation), 'type': '6', 'admin_status': '1', 'oper_status': '1'}
                    for index in (1, 2)], 'table_errors': 0}
        self.app.probe = probe

    def test_first_poll_enrolls_then_second_preserves_identity_manual_fields_and_independent_ssh_binding(self):
        self.change('/api/profiles', {'id': 'ssh', 'username': 'ssh-fixture', 'password': 'ssh-fixture-password', 'oxidized_model': 'ios'})
        # SNMP success must not substitute the SNMP profile's SSH identity for
        # the network's explicitly selected default SSH profile.
        for name in ('a', 'b'):
            self.change('/api/profiles', {'id': name, 'username': 'other-' + name, 'password': 'other-password', 'oxidized_model': 'vrp'})
        network = self.network(profile='ssh', snmp_profiles=['a', 'b'])
        first = self.app.poll(network, 'first-poll', 'fixture')
        devices = self.inventory.tables['/dcim/devices/']
        interfaces = self.inventory.tables['/dcim/interfaces/']
        self.assertEqual((first['devices'], first['interfaces_created'], first['errors']), (2, 4, 0))
        self.assertEqual(len(devices), 2)
        self.assertEqual(len(interfaces), 4)
        self.assertEqual([(entry['ip'], [attempt['profile_id'] for attempt in entry['attempts']])
                         for entry in first['snmp_attempts']], [('192.0.2.1', ['a']), ('192.0.2.2', ['a', 'b'])])
        self.assertEqual({node['username'] for node in self.collector_sources[0]}, {'ssh-fixture'})
        self.assertEqual({node['model'] for node in self.collector_sources[0]}, {'ios'})
        ids = {row['custom_fields']['collector_ip']: row['id'] for row in devices}
        for row in devices:
            self.assertEqual(row['custom_fields']['collector_profile'], 'ssh')
            self.assertEqual(row['custom_fields']['pl_source'], 'network:' + network)
            row.update(name='Manual name ' + str(row['id']), comments='Manual comments', role=99, site=98)
            row['custom_fields']['manual_field'] = 'retain'
        # Preserve an explicit per-device override despite changing the default.
        devices[0]['custom_fields'].update(collector_profile='b', oxidized_model='vrp')
        for row in interfaces:
            row.update(name='Manual port ' + str(row['id']), type='10gbase-x-sfpp', description='Manual description', enabled=False)
            row['custom_fields']['manual_field'] = 'retain'
        manual_devices = [{key: copy.deepcopy(row[key]) for key in ('name', 'comments', 'role', 'site', 'tags')} for row in devices]
        manual_interfaces = [{key: copy.deepcopy(row[key]) for key in ('name', 'type', 'description', 'enabled')} for row in interfaces]
        self.network(profile='a')
        self.generation = 2
        first_write_count = len(self.inventory.writes)
        second = self.app.poll(network, 'second-poll', 'fixture')
        self.assertEqual((second['devices'], second['interfaces_created'], second['interfaces_updated'], second['errors']), (2, 0, 4, 0))
        self.assertEqual({row['custom_fields']['collector_ip']: row['id'] for row in devices}, ids)
        self.assertEqual(len(devices), 2)
        self.assertEqual(len(interfaces), 4)
        self.assertTrue(all(method == 'PATCH' for method, _, _ in self.inventory.writes[first_write_count:]))
        for row, expected in zip(devices, manual_devices):
            self.assertEqual({key: row[key] for key in expected}, expected)
            self.assertEqual(row['custom_fields']['manual_field'], 'retain')
            self.assertEqual(row['custom_fields']['pl_observed_description'], 'observed generation 2')
        self.assertEqual([row['custom_fields']['collector_profile'] for row in devices], ['b', 'ssh'])
        self.assertEqual([row['custom_fields']['oxidized_model'] for row in devices], ['vrp', ''])
        for row, expected in zip(interfaces, manual_interfaces):
            self.assertEqual({key: row[key] for key in expected}, expected)
            self.assertEqual(row['custom_fields']['manual_field'], 'retain')
            self.assertEqual(row['custom_fields']['pl_observed_if_alias'], 'observed alias 2')
        self.assertFalse(any('cables' in path or 'ipam' in path for _, path, _ in self.inventory.writes))
        with self.app.store.connect() as db:
            self.assertEqual([row['state'] for row in db.execute('SELECT state FROM polls ORDER BY rowid')], ['complete', 'complete'])
        self.app.probe_host.assert_not_called()


if __name__ == '__main__':
    unittest.main()
