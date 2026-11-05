"""Module IPAM and repeated-install ownership regressions; laboratory CI only."""
import copy
import importlib.util
import ipaddress
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('pl_network_test', Path(__file__).resolve().parents[1] / 'module-network.py')
net = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(net)
INSTALL = 'pl-123456abcdef'
INSTANCE = '123e4567-e89b-42d3-a456-426614174000'


class ModuleNetworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'state').mkdir()
        self.config = {'network_cidr': '10.90.1.0/24'}
        self.networks = []
        self.routes = []
        self.save()
        route = patch.object(net.subprocess, 'run', side_effect=lambda *a, **k: types.SimpleNamespace(returncode=0, stdout=json.dumps(self.routes).encode()))
        route.start(); self.addCleanup(route.stop)

    def save(self):
        (self.root / 'state/installation.json').write_text(json.dumps({'config': self.config}))

    def docker(self, *args):
        if args == ('network', 'ls', '--quiet', '--no-trunc'):
            return '\n'.join(v['Id'] for v in self.networks).encode()
        if args[:2] == ('network', 'inspect'):
            return json.dumps([next(v for v in self.networks if v['Id'] == args[2])]).encode()
        raise AssertionError(args)

    def allocate(self):
        return net.allocation_args(self.root, INSTALL, self.docker)

    def network(self, cidr='10.90.1.192/29'):
        subnet = ipaddress.IPv4Network(cidr)
        return {'Id': 'a' * 64, 'Name': INSTALL + '-forms-' + INSTANCE + '-net',
                'Driver': 'bridge', 'Scope': 'local', 'Internal': True, 'Ingress': False, 'Options': {},
                'Labels': {'pl.installation': INSTALL, 'pl.module': 'forms', 'pl.instance': INSTANCE,
                           'pl.module.network.version': '1', 'pl.module.network.subnet': cidr},
                'IPAM': {'Driver': 'default', 'Config': [{'Subnet': cidr, 'Gateway': str(subnet.network_address + 1)}]}, 'Containers': {}}

    def test_default_explicit_subnet_skips_occupied_and_reuses_removed(self):
        first = self.allocate()
        self.assertEqual(first[first.index('--subnet') + 1], '10.90.1.192/29')
        self.assertIn('pl.module.network.subnet=10.90.1.192/29', first)
        self.networks.append(self.network())
        second = self.allocate()
        self.assertEqual(second[second.index('--subnet') + 1], '10.90.1.200/29')
        self.networks.clear()
        self.assertEqual(self.allocate(), first)

    def test_default_host_and_none_networks_have_no_ipam_subnets(self):
        self.networks = [
            {'Id': '1' * 64, 'Name': 'host', 'Driver': 'host', 'IPAM': {'Driver': 'default', 'Config': None}},
            {'Id': '2' * 64, 'Name': 'none', 'Driver': 'null', 'IPAM': {'Driver': 'default', 'Config': None}},
        ]
        args = self.allocate()
        self.assertEqual(args[args.index('--subnet') + 1], '10.90.1.192/29')

    def test_explicit_extra_pool_extends_eight_slots_without_default_pool_fallback(self):
        self.networks = [dict(self.network(str(v)), Id=format(i + 1, '064x')) for i, v in enumerate(net.pools(self.config)[0].subnets(new_prefix=29))]
        with self.assertRaisesRegex(ValueError, 'pool exhausted'):
            self.allocate()
        self.config['module_network_cidr'] = '10.90.2.0/24'
        self.save()
        args = self.allocate()
        self.assertEqual(args[args.index('--subnet') + 1], '10.90.2.0/29')

    def test_routes_and_foreign_docker_networks_block_allocation(self):
        self.routes = [{'dst': '10.90.1.192/26', 'dev': 'vpn0'}]
        with self.assertRaisesRegex(ValueError, 'pool exhausted'):
            self.allocate()
        self.routes = [{'dst': 'default', 'dev': 'eth0'}]
        foreign = self.network('10.90.1.192/26')
        foreign['Labels'] = {}
        self.networks = [foreign]
        with self.assertRaisesRegex(ValueError, 'pool exhausted'):
            self.allocate()

    def test_owned_ipam_and_membership_reject_drift(self):
        obj = self.network()
        pools = net.pools(self.config)
        self.assertEqual(net.owned_network(obj, INSTALL, pools, lambda _: None), ipaddress.IPv4Network('10.90.1.192/29'))
        populated = copy.deepcopy(obj)
        adapter = INSTALL + '-forms-' + INSTANCE + '-adapter'
        populated['Containers'] = {'b' * 64: {'Name': adapter}}
        container = {'Id': 'b' * 64, 'Name': '/' + adapter, 'Config': {'Labels': {
            'pl.installation': INSTALL, 'pl.module': 'forms', 'pl.instance': INSTANCE, 'pl.module.role': 'adapter'}}}
        self.assertEqual(net.owned_network(populated, INSTALL, pools, lambda _: container), ipaddress.IPv4Network('10.90.1.192/29'))
        container['Config']['Labels']['pl.module.role'] = 'engine'
        self.assertIsNone(net.owned_network(populated, INSTALL, pools, lambda _: container))
        for field, value in (('Internal', False), ('Name', 'foreign'), ('Options', {'bridge': 'foreign'})):
            changed = copy.deepcopy(obj); changed[field] = value
            self.assertIsNone(net.owned_network(changed, INSTALL, pools, lambda _: None))
        for key, value in (('pl.installation', 'foreign'), ('pl.module.network.version', '2'), ('pl.module.network.subnet', '10.90.1.200/29')):
            changed = copy.deepcopy(obj); changed['Labels'][key] = value
            self.assertIsNone(net.owned_network(changed, INSTALL, pools, lambda _: None))
        changed = copy.deepcopy(obj); changed['Containers'] = {'b' * 64: {'Name': 'foreign'}}
        self.assertIsNone(net.owned_network(changed, INSTALL, pools, lambda _: {'Id': 'b' * 64, 'Name': '/foreign'}))
        changed = copy.deepcopy(obj)
        related = INSTALL + '-forms-' + INSTANCE + '-adapter-foreign'
        changed['Containers'] = {'b' * 64: {'Name': related}}
        clone = {'Id': 'b' * 64, 'Name': '/' + related, 'Config': {'Labels': {
            'pl.installation': INSTALL, 'pl.module': 'forms', 'pl.instance': INSTANCE, 'pl.module.role': 'adapter'}}}
        self.assertIsNone(net.owned_network(changed, INSTALL, pools, lambda _: clone))
        changed = copy.deepcopy(obj); changed['IPAM']['Config'][0]['Gateway'] = '10.90.1.194'
        self.assertIsNone(net.owned_network(changed, INSTALL, pools, lambda _: None))
        changed = copy.deepcopy(obj); changed['IPAM']['Options'] = {'foreign': 'value'}
        self.assertIsNone(net.owned_network(changed, INSTALL, pools, lambda _: None))

    def test_legacy_network_subnets_are_preserved_not_reallocated(self):
        obj = self.network('172.20.0.0/16')
        obj['Labels'].pop('pl.module.network.version')
        obj['Labels'].pop('pl.module.network.subnet')
        net.validate_existing(self.root, INSTALL, obj, self.docker)
        self.config = {}; self.save()
        self.assertEqual(self.allocate(), [])

    def grafana_network(self):
        obj = self.network()
        obj['Name'] = INSTALL + '-grafana-' + INSTANCE + '-net'
        obj['Internal'] = False
        obj['Labels']['pl.module'] = 'grafana'
        prom = '123e4567-e89b-42d3-a456-426614174001'
        containers = {
            'b' * 64: {'Id': 'b' * 64, 'Name': '/' + INSTALL + '-grafana-' + INSTANCE,
                       'Config': {'Labels': {'pl.installation': INSTALL, 'pl.module': 'grafana', 'pl.instance': INSTANCE}}},
            'c' * 64: {'Id': 'c' * 64, 'Name': '/' + INSTALL + '-prometheus-' + prom,
                       'Config': {'Labels': {'pl.installation': INSTALL, 'pl.module': 'prometheus', 'pl.instance': prom}}},
        }
        obj['Containers'] = {key: {'Name': value['Name'].lstrip('/')} for key, value in containers.items()}
        return obj, prom, containers

    def test_grafana_explicit_selected_prometheus_survives_network_recheck(self):
        obj, prom, containers = self.grafana_network()
        inspect = containers.__getitem__
        self.assertIsNone(net.owned_network(obj, INSTALL, net.pools(self.config), inspect))
        self.assertEqual(net.owned_network(obj, INSTALL, net.pools(self.config), inspect, prometheus=prom),
                         ipaddress.IPv4Network('10.90.1.192/29'))
        net.validate_existing(self.root, INSTALL, obj,
                              lambda *args: json.dumps([containers[args[2]]]).encode(), prometheus=prom)
        # Removing/disconnecting the source does not invalidate Grafana's own network.
        del obj['Containers']['c' * 64]
        self.assertIsNotNone(net.owned_network(obj, INSTALL, net.pools(self.config), inspect, prometheus=prom))

    def test_grafana_source_exception_rejects_foreign_identity_and_ipam_drift(self):
        obj, prom, containers = self.grafana_network()
        for field, value in [('pl.installation', 'pl-000000000000'), ('pl.module', 'grafana'), ('pl.instance', INSTANCE)]:
            with self.subTest(field=field):
                changed = copy.deepcopy(containers)
                changed['c' * 64]['Config']['Labels'][field] = value
                self.assertIsNone(net.owned_network(obj, INSTALL, net.pools(self.config), changed.__getitem__, prometheus=prom))
        for field, value in [('Id', 'd' * 64), ('Name', '/foreign')]:
            changed = copy.deepcopy(containers); changed['c' * 64][field] = value
            self.assertIsNone(net.owned_network(obj, INSTALL, net.pools(self.config), changed.__getitem__, prometheus=prom))
        for mutation in ('gateway', 'internal', 'extra_member'):
            with self.subTest(mutation=mutation):
                changed = copy.deepcopy(obj)
                if mutation == 'gateway': changed['IPAM']['Config'][0]['Gateway'] = '10.90.1.194'
                elif mutation == 'internal': changed['Internal'] = True
                else: changed['Containers']['d' * 64] = {'Name': 'foreign'}
                extra = {**containers, 'd' * 64: {'Id': 'd' * 64, 'Name': '/foreign', 'Config': {'Labels': {}}}}
                self.assertIsNone(net.owned_network(changed, INSTALL, net.pools(self.config), extra.__getitem__, prometheus=prom))

    def test_prometheus_source_exception_is_only_for_selected_grafana(self):
        obj, prom, containers = self.grafana_network()
        for selected in ('', INSTANCE, 'invalid', 1):
            self.assertIsNone(net.owned_network(obj, INSTALL, net.pools(self.config), containers.__getitem__, prometheus=selected))
        other = self.network()
        self.assertIsNone(net.owned_network(other, INSTALL, net.pools(self.config), containers.__getitem__, prometheus=prom))

    def test_partial_allocation_labels_do_not_downgrade_to_legacy(self):
        for missing in ('pl.module.network.version', 'pl.module.network.subnet'):
            with self.subTest(missing=missing):
                obj = self.network()
                obj['Labels'].pop(missing)
                with self.assertRaisesRegex(ValueError, 'IPAM or ownership drift'):
                    net.validate_existing(self.root, INSTALL, obj, self.docker)

    def test_additional_pool_cannot_overlap_core_or_use_public_noncanonical_ranges(self):
        for value in ('10.90.1.0/24', '8.8.8.0/24', '10.90.2.1/24', '10.0.0.0/8', '10.90.2.0/27'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                net.pools(dict(self.config, module_network_cidr=value))


if __name__ == '__main__':
    unittest.main()
