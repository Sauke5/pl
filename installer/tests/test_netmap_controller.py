"""Owned network stack contracts. Run in CI; never contact a device or Docker daemon."""
import ast
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
import uuid
from unittest.mock import MagicMock, Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('pl_netmap_test', ROOT / 'installer/netmap-controller.py')
nm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(nm)
sys.path.insert(0, str(ROOT / 'apps/netmap-stack'))
sys.path.insert(0, str(ROOT / 'apps/netmap'))
SERVICE_SPEC = importlib.util.spec_from_file_location('pl_netmap_service_test', ROOT / 'apps/netmap-stack/service.py')
service = importlib.util.module_from_spec(SERVICE_SPEC)
SERVICE_SPEC.loader.exec_module(service)


class NetworkContracts(unittest.TestCase):
    def test_configuration_link_reads_saved_config_instead_of_node_metadata(self):
        app = service.Application.__new__(service.Application)
        app.store = types.SimpleNamespace(networks=lambda: [], observations=lambda network=None, limit=None: [], reports=lambda network=None, limit=None: [])
        devices = [
            {'id': 17, 'name': 'Manual switch name', 'custom_fields': {'oxidized_model': 'ios'}},
            {'id': 18, 'name': 'SNMP only', 'custom_fields': {}},
        ]
        app.netbox = Mock()
        app.netbox.all.side_effect = lambda path: devices if path == '/dcim/devices/' else []
        nodes = app.graph()['nodes']
        self.assertEqual(nodes[0]['config_url'], '/netmap/oxidized/node/fetch/device-17')
        self.assertEqual(nodes[0]['config_history_url'],
                         '/netmap/gitea/pl-collector/device-configs/commits/branch/master/device-17')
        self.assertEqual(nodes[1]['config_url'], '')
        self.assertEqual(nodes[1]['config_history_url'], '')

    def test_inventory_scopes_preserve_unclassified_devices_and_real_cable(self):
        app = service.Application.__new__(service.Application)
        network = {'id': 'a' * 16, 'name': 'Lab network', 'cidr': '192.0.2.0/30'}
        app.store = types.SimpleNamespace(networks=lambda: [network], observations=lambda network=None, limit=None: [], reports=lambda network=None, limit=None: [])
        devices = [{'id': i, 'name': f'Observed {i}', 'role': {'slug': 'pl-network'},
                    'custom_fields': {'pl_source': 'network:' + network['id'], 'collector_ip': f'192.0.2.{i}'}}
                   for i in (1, 2)]
        ports = [{'id': i, 'name': 'eth1', 'device': {'id': i}, 'type': 'other', 'enabled': True}
                 for i in (1, 2)]
        cable = {'id': 7, 'a_terminations': [{'object': ports[0]}], 'b_terminations': [{'object': ports[1]}]}
        app.netbox = Mock()
        app.netbox.all.side_effect = lambda path: {
            '/dcim/devices/': devices, '/dcim/interfaces/': ports, '/dcim/cables/': [cable],
            '/virtualization/interfaces/': [], '/virtualization/virtual-machines/': [],
        }[path]
        scopes = app.configuration()['scopes']
        self.assertEqual([scope['id'] for scope in scopes], ['network', 'network-' + network['id']])
        for scope in scopes:
            with self.subTest(scope=scope['id']):
                self.assertFalse(scope['grouped'], 'An unclassified inventory must not require an office backbone')
                graph = app.graph(scope['api'].removeprefix('.'))
                self.assertEqual([(node['id'], node['kind']) for node in graph['nodes']],
                                 [('device:1', 'unknown'), ('device:2', 'unknown')])
                self.assertEqual(len(graph['edges']), 1)
                edge = graph['edges'][0]
                self.assertEqual((edge['id'], edge['source'], edge['target'], edge['kind']),
                                 ('cable:7', 'device:1', 'device:2', 'physical'))
                self.assertEqual(edge['details']['relationship']['authority'], 'netbox')
        app.netbox.request.assert_not_called()

    def test_vm_placement_uses_native_device_and_keeps_guest_scope(self):
        app = service.Application.__new__(service.Application)
        network = {'id': 'a' * 16, 'name': 'Guest network', 'cidr': '192.0.2.0/29'}
        app.store = types.SimpleNamespace(networks=lambda: [network],
            observations=lambda network=None, limit=None: [], reports=lambda network=None, limit=None: [])
        stamp = service.datetime.now(service.timezone.utc).isoformat()
        devices = [
            {'id': 1, 'name': 'Hypervisor', 'primary_ip4': {'address': '198.51.100.10/24'}, 'custom_fields': {
                'pl_inventory_source': 'inventory:b210573a-8369-41ef-8d56-4b7499126aab',
                'pl_inventory': {'schema': 1, 'observed_at': stamp, 'observed': {'neighbors': [
                    {'protocol': 'arp', 'address': '192.0.2.6', 'mac': '02:00:00:00:00:06'}]}}}},
            {'id': 2, 'name': 'Host uplink', 'primary_ip4': {'address': '198.51.100.20/24'}},
            {'id': 3, 'name': 'Local host', 'primary_ip4': {'address': '192.0.2.1/29'}},
        ]
        cable = {'id': 7, 'a_terminations': [{'object': {'name': 'eth0', 'device': {'id': 1}}}],
                 'b_terminations': [{'object': {'name': 'eth1', 'device': {'id': 2}}}]}
        machines = [
            {'id': 21, 'name': 'Pinned guest', 'primary_ip4': {'address': '192.0.2.2/29'}, 'device': {'id': 1}},
            {'id': 22, 'name': 'Cluster-only guest', 'primary_ip4': {'address': '192.0.2.3/29'},
             'device': None, 'cluster': {'id': 5}},
            {'id': 23, 'name': 'Missing host', 'primary_ip4': {'address': '192.0.2.4/29'}, 'device': {'id': 99}},
            {'id': 24, 'name': 'Outside guest', 'primary_ip4': {'address': '198.51.100.30/24'}, 'device': {'id': 1}},
            {'id': 25, 'name': 'Local guest', 'primary_ip4': {'address': '192.0.2.5/29'}, 'device': {'id': 3}},
        ]
        app.netbox = Mock()
        app.netbox.all.side_effect = lambda path: {
            '/dcim/devices/': devices, '/dcim/interfaces/': [], '/dcim/cables/': [cable],
            '/virtualization/interfaces/': [], '/virtualization/virtual-machines/': machines,
        }[path]

        scoped = app.graph('/api/sites/network-' + network['id'])
        nodes = {node['id']: node for node in scoped['nodes']}
        self.assertEqual(set(nodes), {'device:1', 'device:3', 'vm:21', 'vm:22', 'vm:23', 'vm:25'})
        self.assertTrue(nodes['device:1']['details']['support_only'])
        self.assertFalse(nodes['device:3']['details']['support_only'])
        self.assertEqual(nodes['vm:21']['parent_id'], 'device:1')
        self.assertEqual(nodes['vm:25']['parent_id'], 'device:3')
        self.assertIsNone(nodes['vm:22'].get('parent_id'))
        self.assertIsNone(nodes['vm:23'].get('parent_id'))
        self.assertEqual(nodes['vm:21']['management_ip'], '192.0.2.2')
        expected = {'id': 'vm-host:21', 'source': 'device:1', 'target': 'vm:21', 'kind': 'virtual',
                    'status': 'documented', 'details': {'relationship': {'authority': 'netbox', 'assurance': 'hosting'}}}
        edges = {edge['id']: edge for edge in scoped['edges']}
        self.assertEqual(set(edges), {'vm-host:21', 'vm-host:25'})
        self.assertEqual(edges['vm-host:21'], expected)

        aggregate = app.graph('/api/sites/network')
        self.assertIn('vm:24', {node['id'] for node in aggregate['nodes']})
        edges = {edge['id']: edge for edge in aggregate['edges']}
        self.assertEqual(edges['vm-host:21'], expected)
        self.assertEqual(edges['vm-host:24']['target'], 'vm:24')
        self.assertEqual(edges['cable:7']['kind'], 'physical')

        # Even when both remote hosts are needed as VM context, their cable
        # belongs to the aggregate topology rather than the guest subnet.
        machines.append({'id': 26, 'name': 'Second pinned guest', 'primary_ip4': {'address': '192.0.2.6/29'},
                         'device': {'id': 2}})
        scoped = app.graph('/api/sites/network-' + network['id'])
        self.assertEqual({edge['id'] for edge in scoped['edges']}, {'vm-host:21', 'vm-host:25', 'vm-host:26'})
        app.netbox.request.assert_not_called()

    def test_gitea_initial_receipt_is_finite_owned_and_never_a_collector_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bootstrap = root / 'pl-bootstrap'
            bootstrap.mkdir(mode=0o755)
            bootstrap.chmod(0o755)
            receipt = bootstrap / 'admin'
            password = 'x' * 40
            valid = "generated random password is '" + password + "'\nNew user 'pl-admin' has been successfully created!\n"
            receipt.write_text(valid)
            receipt.chmod(0o444)
            original = nm.os.fstat
            def fixture_owner(fd):
                fields = list(original(fd))
                fields[4] = 1000
                return os.stat_result(fields)
            with patch.object(nm.os, 'fstat', side_effect=fixture_owner):
                self.assertEqual(nm.NetMapController.gitea_initial_password(str(root)), password)
                short = valid.replace(password, 'Az09By18')
                receipt.chmod(0o644)
                receipt.write_text(short)
                receipt.chmod(0o444)
                self.assertEqual(nm.NetMapController.gitea_initial_password(str(root)), 'Az09By18')
                for text in (valid + 'Access token was successfully created... private\n',
                             valid.replace('pl-admin', 'pl-collector'), valid + valid, 'incomplete',
                             short.replace('Az09By18', 'short77'), short.replace('Az09By18', 'longer999'),
                             short.replace('Az09By18', 'Az09-B18')):
                    receipt.chmod(0o644)
                    receipt.write_text(text)
                    receipt.chmod(0o444)
                    with self.assertRaises(ValueError):
                        nm.NetMapController.gitea_initial_password(str(root))
                receipt.chmod(0o644)
                receipt.write_text(valid)
                with self.assertRaises(ValueError):
                    nm.NetMapController.gitea_initial_password(str(root))
                receipt.chmod(0o444)
                receipt.rename(bootstrap / 'real')
                receipt.symlink_to('real')
                with self.assertRaises(OSError):
                    nm.NetMapController.gitea_initial_password(str(root))
                receipt.unlink()
                (bootstrap / 'real').rename(receipt)
            def foreign_owner(fd):
                fields = list(original(fd))
                fields[4] = 2000
                return os.stat_result(fields)
            with patch.object(nm.os, 'fstat', side_effect=foreign_owner), self.assertRaises(ValueError):
                nm.NetMapController.gitea_initial_password(str(root))

    def test_cidr_is_explicit_bounded_and_canonical(self):
        self.assertEqual(service.canonical_network('192.0.2.0/24'), '192.0.2.0/24')
        self.assertEqual(service.canonical_network('2001:db8::/120'), '2001:db8::/120')
        for value in ('0.0.0.0/0', '192.0.2.1/24', '127.0.0.0/24', '169.254.0.0/16', '224.0.0.0/24', '::/0', 'host.local', ''):
            with self.subTest(value=value), self.assertRaises(ValueError):
                service.canonical_network(value)

    def test_gateway_has_no_arbitrary_transport(self):
        headers = {'X-PL-Gateway-Assertion': 'assertion', 'X-PL-Gateway-Signature': 'signature'}
        nm.allowed_request('adapter', 'GET', '/netmap/api/topology', '', '', b'', headers)
        for role, path, supplied in [('database', '/netmap/', headers), ('adapter', 'http://other/', headers),
                                     ('adapter', '/netmap/../secret', headers), ('adapter', '/netmap/%2e%2e/secret', headers),
                                     ('adapter', '/netmap/', {**headers, 'Authorization': 'Basic injected'})]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                nm.allowed_request(role, 'GET', path, '', '', b'', supplied)

    def test_no_startup_scan_or_legacy_collectors(self):
        source = ast.parse((ROOT / 'apps/netmap-stack/service.py').read_text())
        app = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'Application')
        initializer = next(node for node in app.body if isinstance(node, ast.FunctionDef) and node.name == '__init__')
        self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ('poll', 'probe', 'enroll', 'start_poll') for node in ast.walk(initializer)))
        docker = (ROOT / 'monitoring/source/it-portal/deploy/images/netmap.Dockerfile').read_text()
        self.assertNotIn('docker.sock', docker)
        self.assertNotIn('production/', docker)
        self.assertIn('COPY apps/netmap/ /opt/netmap/', docker)


class StackLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('private', 'state', 'modules'):
            (self.root / name).mkdir(mode=0o700)
        self.installation = 'pl-123456abcdef'
        self.instance = str(uuid.uuid4())
        self.images = {role: {'id': 'sha256:' + hashlib.sha256(role.encode()).hexdigest(), 'architecture': 'amd64',
            'ref': 'pl/netmap-' + role + ':test', 'recipe': 'deploy/images/netmap.Dockerfile',
            'labels': {'org.opencontainers.image.version': '1.0.0', 'pl.module.id': 'netmap', 'pl.module.role': role,
                       'pl.module.config.version': '1', 'pl.build.variant': 'source-build' if role == 'adapter' else 'upstream-pinned'}} for role in nm.ROLES}
        upstream = {'database': '18.6', 'cache': '9.1', 'netbox': '4.7.4', 'netbox-worker': '4.7.4', 'gitea': '28.2.0', 'oxidized': '0.37.0'}
        for role, version in upstream.items():
            self.images[role]['labels']['pl.upstream.version'] = version
        nm.atomic(self.root / 'state/installation.json', {'install_id': self.installation, 'manifest_sha256': 'a' * 64, 'config': {'public_url': 'https://pl.example.test'}})
        nm.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation, 'manifest_sha256': 'a' * 64, 'netmap': self.images})
        nm.atomic(self.root / 'private/module-controller-key', b'x' * 32, mode=0o640)
        self.calls, self.containers = [], {}
        ingress = self.installation + '_ingress'
        self.resources = {'network': {ingress: {'Id': 'f' * 64, 'Name': ingress, 'Driver': 'bridge', 'Internal': False,
            'Ingress': False, 'Scope': 'local', 'Options': {}, 'Labels': {'pl.installation': self.installation,
            'com.docker.compose.project': self.installation, 'com.docker.compose.network': 'ingress'}}}, 'volume': {}}
        parent = types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker)
        self.controller = nm.NetMapController(parent)
        self.patches = [patch.object(nm, 'network_args', return_value=[]), patch.object(nm._files, 'validate_module_network', return_value=None)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.controller.http = lambda *args, **kwargs: (200, 'application/json', b'{"status":"ready","version":"1.0.0"}', [])

    def test_bundle_version_comes_from_consistent_adapter_metadata(self):
        for image in self.images.values():
            image['labels']['org.opencontainers.image.version'] = '2.3.4'
        registry = {'schema': 1, 'installation': self.installation, 'manifest_sha256': 'a' * 64, 'netmap': self.images}
        nm.atomic(self.root / 'private/module-images.json', registry)
        controller = nm.NetMapController(self.controller.parent)
        self.assertEqual(controller.version, '2.3.4')
        self.images['oxidized']['labels']['org.opencontainers.image.version'] = '2.3.3'
        nm.atomic(self.root / 'private/module-images.json', registry)
        with self.assertRaises(ValueError):
            controller.resolve_images()

    def test_bundle_and_native_versions_have_distinct_finite_formats(self):
        registry = {'schema': 1, 'installation': self.installation, 'manifest_sha256': 'a' * 64, 'netmap': self.images}
        for value in ('latest', '2.3', '2.3.4.5', '02.3.4'):
            with self.subTest(bundle=value):
                for image in self.images.values():
                    image['labels']['org.opencontainers.image.version'] = value
                nm.atomic(self.root / 'private/module-images.json', registry)
                with self.assertRaises(ValueError):
                    self.controller.resolve_images()
        for image in self.images.values():
            image['labels']['org.opencontainers.image.version'] = '2.3.4'
        for value in ('9.1', '9.1.2'):
            self.images['cache']['labels']['pl.upstream.version'] = value
            nm.atomic(self.root / 'private/module-images.json', registry)
            self.controller.resolve_images()
        for value in ('latest', '9', '9.1.2.3'):
            self.images['cache']['labels']['pl.upstream.version'] = value
            nm.atomic(self.root / 'private/module-images.json', registry)
            with self.assertRaises(ValueError):
                self.controller.resolve_images()

    def image(self, role):
        return {'Id': self.images[role]['id'], 'Os': 'linux', 'Architecture': 'amd64', 'Config': {
            'Labels': self.images[role]['labels'], 'Entrypoint': ['/fixture-' + role], 'Cmd': [], 'WorkingDir': '/', 'Env': [],
            'Volumes': {'/etc/gitea': {}, '/var/lib/gitea': {}} if role == 'gitea' else {}}}

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        kind, action = args[:2]
        if kind == 'image':
            role = next(role for role, image in self.images.items() if image['id'] == args[-1])
            return json.dumps([self.image(role)]).encode()
        if kind in ('network', 'volume'):
            if action == 'ls':
                name = args[3].removeprefix('name=^').removesuffix('$')
                return name.encode() if name in self.resources[kind] else b''
            if action == 'inspect':
                obj = copy.deepcopy(self.resources[kind][args[-1]])
                if kind == 'network':
                    obj['Containers'] = {value['Id']: {'Name': name} for name, value in self.containers.items()
                        if args[-1] in value['NetworkSettings']['Networks']}
                return json.dumps([obj]).encode()
            if action == 'create':
                labels = dict(args[index + 1].split('=', 1) for index, arg in enumerate(args) if arg == '--label')
                self.resources[kind][args[-1]] = {'Id': 'e' * 64, 'Name': args[-1], 'Driver': 'bridge' if kind == 'network' else 'local',
                    'Internal': False, 'Ingress': False, 'Scope': 'local', 'Options': {}, 'Labels': labels,
                    'IPAM': {'Config': [{'Subnet': '192.0.2.0/28', 'Gateway': '192.0.2.1'}]}}
                return args[-1].encode()
            if action == 'connect':
                name = args[-1]
                self.containers[name]['NetworkSettings']['Networks'][args[-2]] = {
                    'NetworkID': '', 'EndpointID': '', 'Aliases': [args[3]], 'IPAddress': '',
                    'IPAMConfig': {'IPv4Address': '', 'IPv6Address': ''}, 'DriverOpts': {}}
                return b''
            if action == 'rm':
                del self.resources[kind][args[-1]]
                return b''
        if kind == 'container':
            if action == 'ls':
                name = args[4].removeprefix('name=^/').removesuffix('$')
                return self.containers[name]['Id'].encode() if name in self.containers else b''
            if action == 'inspect':
                obj = next(value for name, value in self.containers.items() if args[-1] in (name, value['Id']))
                return json.dumps([obj]).encode()
            if action == 'create':
                role = next(role for role, image in self.images.items() if image['id'] == args[-1])
                name = args[args.index('--name') + 1]
                config = copy.deepcopy(self.image(role)['Config'])
                labels = dict(args[index + 1].split('=', 1) for index, arg in enumerate(args) if arg == '--label')
                env = [args[index + 1] for index, arg in enumerate(args) if arg == '--env']
                config.update(Image=args[-1], Labels=labels, User=args[args.index('--user') + 1], Env=env)
                mounts = []
                for index, arg in enumerate(args):
                    if arg == '--mount':
                        fields = dict(part.split('=', 1) if '=' in part else (part, True) for part in args[index + 1].split(','))
                        mounts.append({'Type': fields['type'], 'Name': fields['source'] if fields['type'] == 'volume' else '', 'Source': fields['source'], 'Destination': fields['target'], 'RW': not fields.get('readonly', False)})
                tmpfs = dict(args[index + 1].split(':', 1) for index, arg in enumerate(args) if arg == '--tmpfs')
                covered = {mount['Destination'] for mount in mounts} | set(tmpfs)
                for target in config.get('Volumes') or {}:
                    if target not in covered:
                        mounts.append({'Type': 'volume', 'Name': 'unmanaged-anonymous', 'Source': '/unmanaged-anonymous', 'Destination': target, 'RW': True})
                network = args[args.index('--network') + 1]
                self.containers[name] = {'Id': hashlib.sha256(name.encode()).hexdigest(), 'Image': args[-1], 'Config': config,
                    'Mounts': mounts, 'State': {'Running': False, 'Status': 'created', 'StartedAt': '0001-01-01T00:00:00Z'}, 'HostConfig': {'PortBindings': {}, 'ReadonlyRootfs': True, 'Privileged': False,
                    'CapDrop': ['ALL'], 'NetworkMode': network, 'Memory': nm.MEMORY[role] * 1024**2, 'NanoCpus': 1000000000, 'PidsLimit': 256,
                    'Init': True, 'Tmpfs': tmpfs, 'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}},
                    'RestartPolicy': {'Name': 'unless-stopped'}, 'SecurityOpt': ['no-new-privileges:true']},
                    'NetworkSettings': {'Networks': {network: {'NetworkID': '', 'EndpointID': '', 'Aliases': [role], 'IPAddress': ''}}, 'Ports': {}}}
                return self.containers[name]['Id'].encode()
            if action in ('start', 'stop', 'rm'):
                name = next(name for name, obj in self.containers.items() if obj['Id'] == args[-1])
                if action == 'rm':
                    del self.containers[name]
                else:
                    self.containers[name]['State']['Running'] = action == 'start'
                    self.containers[name]['State']['Status'] = 'running' if action == 'start' else 'exited'
                    if action == 'start':
                        self.containers[name]['State']['StartedAt'] = '2026-10-30T01:00:00Z'
                        for target, connection in self.containers[name]['NetworkSettings']['Networks'].items():
                            connection.update(NetworkID=('f' if target == self.installation + '_ingress' else 'e') * 64,
                                              EndpointID=hashlib.sha256((name + target).encode()).hexdigest(),
                                              IPAddress='192.0.2.3' if target == self.installation + '_ingress' else '192.0.2.2')
                return b''
        raise AssertionError('Unexpected fake Docker call ' + repr(args))

    def execute(self, action, operation=None):
        return self.controller.execute({'operation_id': operation or str(uuid.uuid4()), 'instance_id': self.instance, 'module_id': 'netmap', 'action': action})

    def test_cold_install_waits_for_migrations_without_recreating_containers(self):
        clock = types.SimpleNamespace(now=0)
        ready = self.controller.ready

        def cold_ready(instance):
            if clock.now < 660:
                raise ValueError('Schema is still migrating')
            return ready(instance)

        def sleep(duration):
            clock.now += duration

        with patch.object(self.controller, 'ready', side_effect=cold_ready), \
             patch.object(nm.time, 'monotonic', side_effect=lambda: clock.now), \
             patch.object(nm.time, 'sleep', side_effect=sleep):
            result = self.execute('install')
        self.assertEqual(result['state'], 'running')
        self.assertEqual(clock.now, 660)
        self.assertEqual(len([call for call in self.calls if call[:2] == ('container', 'create')]), 7)
        self.assertFalse(any(call[:2] == ('container', 'restart') for call in self.calls))

    def test_unready_install_has_finite_deadline_and_preserves_owned_containers(self):
        clock = types.SimpleNamespace(now=0)

        def sleep(duration):
            clock.now += duration

        with patch.object(self.controller, 'ready', side_effect=ValueError('Schema unavailable')), \
             patch.object(nm.time, 'monotonic', side_effect=lambda: clock.now), \
             patch.object(nm.time, 'sleep', side_effect=sleep):
            result = self.execute('install')
        self.assertEqual(result['state'], 'error')
        self.assertEqual(clock.now, 1200)
        self.assertEqual(len(self.containers), 7)
        self.assertFalse(any(call[:2] in (('container', 'rm'), ('container', 'restart')) for call in self.calls))

    def test_initial_login_reads_only_human_admin_and_rejects_stopped_or_drifted_container(self):
        self.assertEqual(self.execute('install')['state'], 'running')
        body = {'instance_id': self.instance, 'module_id': 'netmap', 'service': 'netbox'}
        state = self.controller.state(self.instance)
        value = self.controller.initial_login(body)
        self.assertEqual(value['password'], state['secrets']['admin_password'])
        self.assertEqual(set(value), {'instance_id', 'module_id', 'service', 'username', 'password', 'path'})
        self.assertNotIn(state['secrets']['token'], json.dumps(value))
        self.assertNotIn(state['secrets']['source_password'], json.dumps(value))
        for service_name in ('collector', 'adapter', 'oxidized', '../gitea'):
            with self.assertRaises(ValueError):
                self.controller.initial_login({**body, 'service': service_name})
        obj = self.containers[self.controller.name(self.instance, '-netbox')]
        obj['State']['Running'] = False
        with self.assertRaises(ValueError):
            self.controller.initial_login(body)
        obj['State']['Running'] = True
        obj['Config']['Labels']['pl.instance'] = str(uuid.uuid4())
        with self.assertRaises(ValueError):
            self.controller.initial_login(body)

    def test_new_netbox_password_is_eight_alphanumeric_and_other_secrets_keep_their_contract(self):
        with patch.object(nm.secrets, 'choice', side_effect=list('Az09By18')) as choose:
            self.assertEqual(self.execute('install')['state'], 'running')
        state = self.controller.state(self.instance)
        self.assertEqual(state['secrets']['admin_password'], 'Az09By18')
        self.assertEqual(choose.call_count, 8)
        for name, value in state['secrets'].items():
            if name != 'admin_password':
                self.assertRegex(value, r'^[a-f0-9]{12}$' if name == 'token_key' else r'^[a-f0-9]{64}$')
        config = json.loads((self.controller.paths(self.instance) / 'config/netbox.json').read_text())
        self.assertEqual(config['admin_password'], 'Az09By18')
        value = self.controller.initial_login({'instance_id': self.instance, 'module_id': 'netmap', 'service': 'netbox'})
        self.assertEqual(value['password'], 'Az09By18')

    def test_legacy_netbox_state_keeps_full_password_and_all_configuration_on_reenable(self):
        self.controller.initialize(self.instance)
        base = self.controller.paths(self.instance)
        state = self.controller.state(self.instance)
        state['secrets']['admin_password'] = 'e' * 64
        config = json.loads((base / 'config/netbox.json').read_text())
        config['admin_password'] = state['secrets']['admin_password']
        content = nm.encoded(config)
        nm.atomic(base / 'config/netbox.json', content, mode=0o444)
        state['files']['netbox.json'] = hashlib.sha256(content).hexdigest()
        nm.atomic(base / 'state.json', state)
        original = {path: path.read_bytes() for path in (base / 'config').iterdir()}
        original[base / 'state.json'] = (base / 'state.json').read_bytes()
        with patch.object(nm.secrets, 'choice', side_effect=AssertionError('unexpected password rotation')), \
                patch.object(nm.secrets, 'token_hex', side_effect=AssertionError('unexpected secret rotation')):
            self.controller.initialize(self.instance)
        self.assertEqual(self.execute('install')['state'], 'running')
        self.execute('disable')
        self.assertEqual(self.execute('enable')['state'], 'running')
        self.assertEqual({path: path.read_bytes() for path in original}, original)
        value = self.controller.initial_login({'instance_id': self.instance, 'module_id': 'netmap', 'service': 'netbox'})
        self.assertEqual(value['password'], 'e' * 64)

    def test_pending_adapter_networks_are_limited_to_never_started_container(self):
        self.controller.initialize(self.instance)
        self.controller.create_resource(self.instance, 'network')
        for volume in nm.VOLUMES:
            self.controller.create_resource(self.instance, 'volume', volume)
        self.controller.create_container(self.instance, 'adapter')
        name = self.controller.name(self.instance, '-adapter')
        original = copy.deepcopy(self.containers[name])
        self.assertEqual(self.controller.inspect(self.instance, 'adapter')['State']['Status'], 'created')
        for target in original['NetworkSettings']['Networks']:
            for ipam in (None, {}, {'IPv4Address': '', 'IPv6Address': ''}):
                with self.subTest(target=target, unallocated_ipam=ipam):
                    self.containers[name] = copy.deepcopy(original)
                    self.containers[name]['NetworkSettings']['Networks'][target]['IPAMConfig'] = ipam
                    self.assertEqual(self.controller.inspect(self.instance, 'adapter')['State']['Status'], 'created')
            for field, value in (('NetworkID', 'a' * 64), ('IPAddress', '192.0.2.99'), ('EndpointID', 'a' * 64),
                                 ('Gateway', '192.0.2.1'), ('IPv6Gateway', '2001:db8::1'),
                                 ('GlobalIPv6Address', '2001:db8::99'),
                                 ('IPAMConfig', {'IPv4Address': '192.0.2.99'}),
                                 ('IPAMConfig', {'IPv4Address': '192.0.2.99', 'IPv6Address': ''}),
                                 ('IPAMConfig', {'IPv4Address': '', 'IPv6Address': '2001:db8::99'}),
                                 ('IPAMConfig', {'IPv4Address': '', 'IPv6Address': '', 'LinkLocalIPs': []}),
                                 ('IPAMConfig', {'IPv4Address': ''}),
                                 ('IPAMConfig', {'IPv4Address': '', 'IPv6Address': None}),
                                 ('IPAMConfig', {'IPv4Address': False, 'IPv6Address': ''}),
                                 ('IPAMConfig', {'IPv4Address': '', 'IPv6Address': 0}),
                                 ('IPAMConfig', []), ('IPAMConfig', ''), ('IPAMConfig', False),
                                 ('Aliases', ['foreign'])):
                with self.subTest(target=target, field=field, value=value):
                    self.containers[name] = copy.deepcopy(original)
                    self.containers[name]['NetworkSettings']['Networks'][target][field] = value
                    with self.assertRaises(ValueError):
                        self.controller.inspect(self.instance, 'adapter')
        for changed in ({'Status': 'exited'}, {'Running': True}, {'StartedAt': '2026-10-29T01:00:00Z'}):
            self.containers[name] = copy.deepcopy(original)
            self.containers[name]['State'].update(changed)
            with self.assertRaises(ValueError):
                self.controller.inspect(self.instance, 'adapter')
        self.containers[name] = copy.deepcopy(original)
        self.docker('container', 'start', original['Id'])
        self.assertTrue(self.controller.inspect(self.instance, 'adapter')['State']['Running'])
        running = copy.deepcopy(self.containers[name])
        for target in original['NetworkSettings']['Networks']:
            for value in ('', 'a' * 64):
                self.containers[name] = copy.deepcopy(running)
                self.containers[name]['NetworkSettings']['Networks'][target]['NetworkID'] = value
                with self.assertRaises(ValueError):
                    self.controller.inspect(self.instance, 'adapter')

    def test_pending_adapter_continuation_preserves_owned_graph_and_secrets(self):
        operation = str(uuid.uuid4())
        interrupted = False

        def interrupt_after_attach(*args, **kwargs):
            nonlocal interrupted
            result = self.docker(*args, **kwargs)
            if args[:2] == ('network', 'connect') and not interrupted:
                interrupted = True
                raise OSError('Interrupted after adapter network attachment')
            return result

        self.controller.docker = interrupt_after_attach
        self.assertEqual(self.execute('install', operation)['state'], 'error')
        self.assertTrue(interrupted)
        adapter_name = self.controller.name(self.instance, '-adapter')
        adapter = self.containers[adapter_name]
        self.assertEqual(adapter['State']['Status'], 'created')
        self.assertEqual(adapter['State']['StartedAt'], '0001-01-01T00:00:00Z')
        self.assertEqual(adapter['NetworkSettings']['Networks'][self.installation + '_ingress']['IPAMConfig'],
                         {'IPv4Address': '', 'IPv6Address': ''})
        existing = {name: obj['Id'] for name, obj in self.containers.items()}
        base = self.controller.paths(self.instance)
        files = {path: (path.stat().st_ino, path.read_bytes()) for path in base.rglob('*') if path.is_file()}
        journal_path = self.controller.operations / (operation + '.json')
        fingerprint = json.loads(journal_path.read_bytes())['fingerprint']
        self.controller.docker = self.docker
        self.calls.clear()
        with patch.object(nm.secrets, 'choice', side_effect=AssertionError('unexpected password rotation')), \
                patch.object(nm.secrets, 'token_hex', side_effect=AssertionError('unexpected secret rotation')):
            self.assertEqual(self.execute('install', operation)['state'], 'running')
        self.assertEqual({name: self.containers[name]['Id'] for name in existing}, existing)
        self.assertEqual(sum(call[:2] == ('container', 'create') for call in self.calls), 1)
        self.assertEqual(sum(call[:2] == ('container', 'start') for call in self.calls), 2)
        self.assertEqual({path: (path.stat().st_ino, path.read_bytes()) for path in files}, files)
        self.assertEqual(json.loads(journal_path.read_bytes()), {'fingerprint': fingerprint, 'phase': 'complete'})
        self.calls.clear()
        self.assertEqual(self.execute('install', operation)['state'], 'running')
        self.assertFalse(any(call[:2] in (('container', 'create'), ('container', 'start')) for call in self.calls))

    def test_upstream_gitea_volumes_are_explicit_without_weakening_mount_guard(self):
        result = self.controller.execute({'operation_id': str(uuid.uuid4()), 'instance_id': self.instance, 'module_id': 'netmap', 'action': 'install'})
        self.assertEqual(result['state'], 'running')
        gitea = self.containers[self.controller.name(self.instance, '-gitea')]
        self.assertIn('/etc/gitea', gitea['HostConfig']['Tmpfs'])
        self.assertFalse(any(item.get('Name') == 'unmanaged-anonymous' for item in gitea['Mounts']))
        gitea['Mounts'].append({'Type': 'volume', 'Name': 'foreign', 'Source': '/foreign', 'Destination': '/extra', 'RW': True})
        with self.assertRaises(ValueError):
            self.controller.inspect(self.instance, 'gitea')

    def test_owned_seven_component_lifecycle_and_no_host_ports(self):
        self.assertEqual(self.execute('install')['state'], 'running')
        self.assertEqual(len(self.containers), 7)
        self.assertEqual(len(self.resources['volume']), 6)
        self.assertFalse(any('--publish' in call or '--network=host' in call for call in self.calls))
        self.assertEqual(self.execute('disable')['state'], 'disabled')
        self.assertTrue(self.resources['volume'])
        self.assertEqual(self.execute('enable')['state'], 'running')
        self.assertEqual(self.execute('remove')['state'], 'absent')
        self.assertFalse(self.containers)
        self.assertFalse(self.resources['volume'])
        self.assertEqual(set(self.resources['network']), {self.installation + '_ingress'})

    def test_ready_distinguishes_empty_inventory_from_unavailable_collector(self):
        self.assertEqual(self.execute('install')['state'], 'running')
        def response(collector, status=200):
            payload = {'status': 'ready', 'version': self.controller.version, 'collector': collector}
            self.controller.http = lambda *args, **kwargs: (status, 'application/json', json.dumps(payload).encode(), [])
        for collector in ({'state': 'waiting_targets', 'targets': 0}, {'state': 'ready', 'targets': 2}):
            response(collector)
            self.assertTrue(self.controller.ready(self.instance)['State']['Running'])
        for collector in (None, [], {}, {'state': 'waiting_targets', 'targets': 1},
                          {'state': 'ready', 'targets': 0}, {'state': 'ready', 'targets': -1},
                          {'state': 'ready', 'targets': True}, {'state': 'ready', 'targets': 1.5},
                          {'state': 'error', 'targets': 1},
                          {'state': 'ready', 'targets': 1, 'error': 'unavailable'}):
            with self.subTest(collector=collector), self.assertRaises(ValueError):
                response(collector)
                self.controller.ready(self.instance)
        response({'state': 'waiting_targets', 'targets': 0}, status=503)
        with self.assertRaises(ValueError):
            self.controller.ready(self.instance)
        response({'state': 'waiting_targets', 'targets': 0})
        self.containers[self.controller.name(self.instance, '-oxidized')]['State']['Running'] = False
        with self.assertRaises(ValueError):
            self.controller.ready(self.instance)

    def test_idempotency_and_private_config_drift(self):
        operation = str(uuid.uuid4())
        self.assertEqual(self.execute('install', operation)['state'], 'running')
        initial = len([call for call in self.calls if call[:2] == ('container', 'create')])
        self.assertEqual(self.execute('install', operation)['state'], 'running')
        self.assertEqual(initial, len([call for call in self.calls if call[:2] == ('container', 'create')]))
        with self.assertRaises(ValueError):
            self.execute('disable', operation)
        file = self.controller.paths(self.instance) / 'config/adapter.json'
        nm.atomic(file, b'{}', mode=0o444)
        self.assertEqual(self.execute('remove')['state'], 'error')
        self.assertTrue(self.containers)

    def request(self):
        return self.controller.request({'instance_id': self.instance, 'method': 'GET', 'path': '/netmap/app.js',
            'query': '', 'content_type': '', 'body': '',
            'headers': {'X-PL-Gateway-Assertion': 'signed', 'X-PL-Gateway-Signature': 'signature'}})

    def test_cold_and_expired_browser_route_do_not_probe_native_health(self):
        self.assertEqual(self.execute('install')['state'], 'running')
        self.controller._routes.clear()
        def application_http(instance, obj, method, path, *args):
            self.assertEqual((method, path), ('GET', '/netmap/app.js'))
            return 200, 'application/javascript', b'code', []
        with patch.object(self.controller, 'ready', side_effect=AssertionError('Browser request invoked native health')), \
             patch.object(self.controller, 'http', side_effect=application_http) as http_call, \
             patch.object(self.controller, 'inspect', wraps=self.controller.inspect) as inspect:
            self.assertEqual(self.request()['status'], 200)
            inspect.assert_called_once_with(self.instance, 'adapter')
            self.request()
            self.assertEqual(inspect.call_count, 1)
            cached = self.controller._routes[self.instance]
            self.controller._routes[self.instance] = (cached[0] - nm.ROUTE_MAX_AGE - 1, cached[1])
            self.request()
            self.assertEqual(inspect.call_count, 2)
            self.assertEqual(http_call.call_count, 3)

    def test_cold_route_refuses_adapter_ownership_network_and_ip_drift(self):
        self.assertEqual(self.execute('install')['state'], 'running')
        name = self.controller.name(self.instance, '-adapter')
        baseline = copy.deepcopy(self.containers[name])
        network = self.controller.name(self.instance, '-net')
        for drift in ('owner', 'network', 'address', 'stopped'):
            with self.subTest(drift=drift):
                self.containers[name] = copy.deepcopy(baseline)
                obj = self.containers[name]
                if drift == 'owner':
                    obj['Config']['Labels']['pl.instance'] = str(uuid.uuid4())
                elif drift == 'network':
                    obj['NetworkSettings']['Networks'][network]['NetworkID'] = 'a' * 64
                elif drift == 'address':
                    obj['NetworkSettings']['Networks'][network]['IPAddress'] = '198.51.100.1'
                else:
                    obj['State']['Running'] = False
                self.controller._routes.clear()
                with patch.object(self.controller, 'ready', side_effect=AssertionError('Unexpected readiness probe')), \
                     patch.object(self.controller, 'http', side_effect=AssertionError('Unowned route reached HTTP')):
                    with self.assertRaises(ValueError):
                        self.request()

    def test_image_and_foreign_container_refuse_destructive_remove(self):
        self.execute('install')
        adapter = self.containers[self.controller.name(self.instance, '-adapter')]
        adapter['HostConfig']['Privileged'] = True
        self.assertEqual(self.execute('remove')['state'], 'error')
        self.assertEqual(len(self.containers), 7)


class InventoryContracts(unittest.TestCase):
    def probe_with_alias_rows(self, alias_rows, exception_only=False):
        columns = {'1.3.6.1.2.1.31.1.1.1.1': ['"GigabitEthernet0/1"', '"GigabitEthernet0/2"'],
                   '1.3.6.1.2.1.2.2.1.2': ['"GigabitEthernet0/1"', '"GigabitEthernet0/2"'],
                   '1.3.6.1.2.1.2.2.1.3': ['6', '6'],
                   '1.3.6.1.2.1.2.2.1.7': ['1', '1'],
                   '1.3.6.1.2.1.2.2.1.8': ['1', '1']}
        alias_oid = '1.3.6.1.2.1.31.1.1.1.18'
        def run(args, **kwargs):
            self.assertNotIn('fixture-community', ' '.join(args))
            if args[0] == 'snmpget':
                return types.SimpleNamespace(returncode=0, stdout=b'"switch-lab"\n"Fixture switch"\n')
            self.assertEqual(args[0], 'snmpwalk')
            self.assertIn('-OQ', args)
            self.assertIn('-Oe', args)
            oid = args[-1]
            if oid == alias_oid or exception_only:
                rows = alias_rows
            else:
                rows = list(enumerate(columns[oid], 1))
            body = ''.join('.' + oid + '.' + str(index) + ' = ' + value + '\n' for index, value in rows)
            return types.SimpleNamespace(returncode=0, stdout=body.encode())
        with patch.object(service.subprocess, 'run', side_effect=run):
            return self.app.probe('192.0.2.1', {'snmp_community': 'fixture-community'})

    def test_walk_terminal_values_do_not_overwrite_last_observed_alias(self):
        exceptions = ['No more variables left in this MIB View (It is past the end of the MIB tree)',
                      'No Such Object available on this agent at this OID',
                      'No Such Instance currently exists at this OID']
        for terminal in exceptions:
            with self.subTest(terminal=terminal):
                result = self.probe_with_alias_rows([(1, '"CI observed uplink"'), (2, '"CI observed uplink"'), (2, terminal)])
                self.assertEqual(result['table_errors'], 0)
                self.assertEqual([(row['index'], row['alias']) for row in result['interfaces']],
                                 [('1', 'CI observed uplink'), ('2', 'CI observed uplink')])

    def test_walk_exception_only_rows_do_not_create_phantom_interfaces(self):
        result = self.probe_with_alias_rows([(99, 'No Such Instance currently exists at this OID')], exception_only=True)
        self.assertEqual(result['interfaces'], [])
        self.assertEqual(result['table_errors'], 0)

    def test_walk_quoted_exception_text_remains_a_legitimate_alias(self):
        for alias in ('No more variables left in this MIB View (It is past the end of the MIB tree)',
                      'No Such Object is this port label', 'No Such Instance is this port label'):
            with self.subTest(alias=alias):
                result = self.probe_with_alias_rows([(1, '"' + alias + '"'), (2, '"regular alias"')])
                self.assertEqual([row['alias'] for row in result['interfaces']], [alias, 'regular alias'])

    def test_netbox_client_uses_native_api_prefix_for_inventory_and_schema(self):
        client = service.NetBox({'token_key': 'fixture-key', 'token': 'fixture-token'})
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"results":[],"next":null}'
        client.opener = types.SimpleNamespace(open=Mock(return_value=response))
        self.assertEqual(client.all('/dcim/devices/', cf_pl_source='network:fixture'), [])
        request = client.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://netbox:8080/netmap/netbox/api/dcim/devices/?cf_pl_source=network%3Afixture&limit=1000&offset=0')
        self.assertTrue(request.get_header('Authorization').startswith('Bearer nbt_'))
        client.request('GET', '/extras/custom-fields/?name=collector_ip')
        self.assertEqual(client.opener.open.call_args.args[0].full_url, 'http://netbox:8080/netmap/netbox/api/extras/custom-fields/?name=collector_ip')
        for path in ('https://foreign.example/api/dcim/', '//foreign/dcim/', '/dcim/../users/', '/api/dcim/devices/', '/users/'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                client.request('GET', path)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = service.Application.__new__(service.Application)
        connections = []
        connect = service.sqlite3.connect
        def owned_connection(*args, **kwargs):
            connection = connect(*args, **kwargs)
            connections.append(connection)
            return connection
        connection_patch = patch.object(service.sqlite3, 'connect', side_effect=owned_connection)
        connection_patch.start()
        self.addCleanup(connection_patch.stop)
        def close_connections():
            for connection in connections:
                connection.close()
        self.addCleanup(close_connections)
        self.app.store = service.Store(Path(self.temp.name) / 'netmap.sqlite3')
        self.app.mutation_lock = __import__('threading').Lock()
        self.app.poll_lock = __import__('threading').Lock()

    def test_profile_secrets_and_explicit_poll_reservation(self):
        claims = {'idempotency_key': 'profile-op', 'sub': 'admin'}
        profile = {'id': 'test', 'snmp_community': 'fixture', 'username': 'collector', 'password': 'fixture', 'oxidized_model': 'ios'}
        self.assertEqual(self.app.mutation('/api/profiles', profile, claims), {'id': 'test'})
        network = self.app.mutation('/api/networks', {'cidr': '192.0.2.0/30', 'name': 'Fixture', 'profile': 'test'}, {**claims, 'idempotency_key': 'net-op'})
        with patch.object(self.app, 'start_poll', return_value={'id': 'poll-op', 'state': 'running'}) as poll:
            url = '/api/networks/' + network['id'] + '/poll'
            first = self.app.mutation(url, {}, {**claims, 'idempotency_key': 'poll-op'})
            self.assertEqual(first['state'], 'running')
            self.assertEqual(self.app.mutation(url, {}, {**claims, 'idempotency_key': 'poll-op'}), first)
            poll.assert_called_once()
        self.assertEqual(self.app.store.profile('test')['password'], 'fixture')

    def test_discovery_preserves_manual_fields_and_never_creates_cables(self):
        calls = []
        current = {'id': 17, 'name': 'Manual name', 'custom_fields': {'collector_profile': 'manual-profile',
            'manual_key': 'keep', 'pl_source': 'network:source1', 'collector_ip': '192.0.2.1'}}
        version = 'W/"2026-11-06T00:00:00+00:00"'
        def request(method, path, body=None, **kwargs):
            if method == 'GET':
                self.assertTrue(kwargs['include_version'])
                return current, version
            self.assertEqual(kwargs, {'version': version})
            calls.append((method, path, body))
            current['custom_fields'].update(body['custom_fields'])
        self.app.netbox = types.SimpleNamespace(all=lambda *args, **kwargs: [current], request=request)
        self.app.enroll({'id': 'source1', 'name': 'Fixture', 'profile': 'new'}, {'ip': '192.0.2.1', 'name': 'Observed name', 'description': 'Observed description'})
        self.assertEqual(calls[0][:2], ('PATCH', '/dcim/devices/17/'))
        self.assertEqual(set(calls[0][2]), {'custom_fields'})
        self.assertEqual(set(calls[0][2]['custom_fields']), {'pl_observed_name', 'pl_observed_description'})
        self.assertEqual(current['custom_fields']['manual_key'], 'keep')
        self.assertEqual(current['custom_fields']['collector_profile'], 'manual-profile')
        self.assertFalse(any('cables' in call[1] for call in calls))

    def test_existing_device_requires_explicit_binding_after_default_profile_completion(self):
        self.app.mutation('/api/profiles', {'id': 'test', 'snmp_community': 'fixture', 'username': 'collector', 'password': 'fixture', 'oxidized_model': 'ios'}, {'idempotency_key': 'profile', 'sub': 'admin'})
        calls = []
        current = {'id': 17, 'name': 'Manual name', 'tags': [{'id': 8, 'slug': 'manual'}],
                   'custom_fields': {'manual_key': 'keep', 'pl_source': 'network:source1', 'collector_ip': '192.0.2.1'}}
        def request(method, path, body=None, **kwargs):
            if method == 'GET':
                return current, 'W/"2026-11-06T00:00:00+00:00"'
            calls.append((method, path, body))
            current['custom_fields'].update(body['custom_fields'])
        self.app.netbox = types.SimpleNamespace(all=lambda path, **kwargs: [current] if path == '/dcim/devices/' else [{'id': 9, 'slug': 'network-config-backup'}], request=request)
        network = {'id': 'source1', 'name': 'Fixture', 'profile': 'test'}
        observed = {'ip': '192.0.2.1', 'name': 'Observed', 'description': 'Fixture'}
        self.app.enroll(network, observed)
        payload = calls[0][2]
        self.assertNotIn('collector_profile', payload['custom_fields'])
        self.assertNotIn('oxidized_model', payload['custom_fields'])
        self.assertEqual(current['custom_fields']['manual_key'], 'keep')
        self.assertNotIn('tags', payload)
        self.assertEqual(current['tags'], [{'id': 8, 'slug': 'manual'}])
        current['custom_fields'].update(collector_profile='manual-profile', oxidized_model='vrp')
        calls.clear()
        self.app.enroll(network, observed)
        self.assertNotIn('collector_profile', calls[0][2]['custom_fields'])
        self.assertNotIn('oxidized_model', calls[0][2]['custom_fields'])
        self.assertEqual(current['custom_fields']['collector_profile'], 'manual-profile')
        self.assertEqual(current['custom_fields']['oxidized_model'], 'vrp')
        self.assertNotIn('tags', calls[0][2])

    def test_new_inventory_uses_observed_name_without_adopting_name_collisions(self):
        network = {'id': 'source1', 'name': 'Fixture', 'profile': 'test'}
        observed = {'ip': '192.0.2.1', 'name': 'switch-lab', 'description': 'Fixture'}
        for collision in (False, True):
            calls = []
            def all_records(path, **query):
                if path == '/extras/tags/':
                    return [{'id': 9}]
                if collision and query.get('name'):
                    return [{'id': 99, 'name': 'switch-lab'}]
                return []
            self.app.netbox = types.SimpleNamespace(all=all_records, get_or_create=lambda *args: {'id': 1},
                request=lambda *args: calls.append(args) or {'id': 17})
            self.assertEqual(self.app.enroll(network, observed), 17)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][:2], ('POST', '/dcim/devices/'))
            name = calls[0][2]['name']
            if collision:
                self.assertTrue(name.startswith('switch-lab-'))
                self.assertNotEqual(name, 'switch-lab')
            else:
                self.assertEqual(name, 'switch-lab')

    def test_interface_observations_preserve_manual_configuration(self):
        calls = []
        current = {'id': 8, 'name': 'Manually renamed uplink', 'type': '10gbase-x-sfpp', 'description': 'Manual description', 'enabled': False,
            'custom_fields': {'pl_source': 'network:source1', 'pl_if_index': '42', 'manual_key': 'retain'}}
        self.app.netbox = types.SimpleNamespace(all=lambda *args, **kwargs: [current], request=lambda *args: calls.append(args))
        result = self.app.sync_interfaces({'id': 'source1'}, 17, [{'index': '42', 'name': 'Gi1/0/1', 'alias': 'Changed description', 'admin_status': '1', 'oper_status': '1', 'type': '6'}])
        self.assertEqual(result['interfaces_updated'], 1)
        payload = calls[0][2]
        self.assertEqual(set(payload), {'custom_fields'})
        self.assertEqual(payload['custom_fields']['manual_key'], 'retain')
        self.assertEqual(payload['custom_fields']['pl_observed_if_name'], 'Gi1/0/1')
        self.assertEqual(current['description'], 'Manual description')

    def test_profile_updates_preserve_omitted_secrets(self):
        self.app.mutation('/api/profiles', {'id': 'test', 'password': 'fixture', 'snmp_community': 'fixture'}, {'idempotency_key': 'first', 'sub': 'admin'})
        self.app.mutation('/api/profiles', {'id': 'test', 'username': 'new-user'}, {'idempotency_key': 'second', 'sub': 'admin'})
        self.assertEqual(self.app.store.profile('test')['password'], 'fixture')
        self.assertEqual(self.app.store.profile('test')['snmp_community'], 'fixture')
        self.assertEqual(self.app.store.profile('test')['username'], 'new-user')

    def test_async_poll_persists_admission_before_starting_worker(self):
        self.app.mutation('/api/profiles', {'id': 'test', 'snmp_community': 'fixture'}, {'idempotency_key': 'profile', 'sub': 'admin'})
        network = self.app.mutation('/api/networks', {'cidr': '192.0.2.0/30', 'name': 'Fixture', 'profile': 'test'}, {'idempotency_key': 'network', 'sub': 'admin'})
        with patch.object(service.threading, 'Thread') as worker:
            result = self.app.start_poll(network['id'], 'async-poll', 'admin')
            self.assertEqual(result, {'id': 'async-poll', 'state': 'running'})
            worker.return_value.start.assert_called_once_with()
            with self.app.store.connect() as db:
                row = db.execute('SELECT network,state,result,actor FROM polls WHERE id=?', ('async-poll',)).fetchone()
                self.assertEqual(tuple(row), (network['id'], 'running', '{}', 'admin'))
        self.app.poll_lock.release()

    def test_poll_has_terminal_counters_and_no_unmocked_io(self):
        self.app.mutation('/api/profiles', {'id': 'test', 'snmp_community': 'fixture'}, {'idempotency_key': 'profile', 'sub': 'admin'})
        network = self.app.mutation('/api/networks', {'cidr': '192.0.2.0/30', 'name': 'Fixture', 'profile': 'test'}, {'idempotency_key': 'network', 'sub': 'admin'})
        with patch.object(self.app, 'probe', side_effect=[{'name': 'Fixture', 'ip': '192.0.2.1', 'description': 'Test', 'interfaces': [], 'table_errors': 0}, None]), \
             patch.object(self.app, 'probe_host', return_value={'ip': '192.0.2.2', 'methods': [], 'warnings': []}), \
             patch.object(self.app, 'enroll', return_value=17), \
             patch.object(self.app, 'sync_interfaces', return_value={'interfaces_created': 2, 'interfaces_updated': 1, 'manual_conflicts': 0, 'errors': 0}), \
             patch.object(self.app, 'nodes', return_value=[]), \
             patch.object(service.http.client, 'HTTPConnection', side_effect=ConnectionRefusedError):
            result = self.app.poll(network['id'], 'poll', 'admin')
        self.assertEqual(result['targets_total'], 2)
        self.assertEqual(result['responders'], 1)
        self.assertEqual(result['unresponsive'], 1)
        self.assertEqual(result['interfaces_created'], 2)
        self.assertEqual(result['collector'], {'state': 'waiting_targets', 'targets': 0})
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT state FROM polls WHERE id=?', ('poll',)).fetchone()[0], 'complete')

    def test_network_remove_retains_inventory_and_history(self):
        network = self.app.mutation('/api/networks', {'cidr': '192.0.2.0/30', 'name': 'Fixture', 'profile': 'test'}, {'idempotency_key': 'add', 'sub': 'admin'})
        self.app.netbox = types.SimpleNamespace(request=lambda *args: self.fail('Network remove must retain NetBox inventory'))
        self.assertEqual(self.app.mutation('/api/networks/' + network['id'] + '/remove', {}, {'idempotency_key': 'remove', 'sub': 'admin'}), {'removed': True})
        self.assertFalse(self.app.store.networks())


if __name__ == '__main__':
    unittest.main()
