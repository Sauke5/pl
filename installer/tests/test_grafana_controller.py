"""Owned Grafana lifecycle; native browser/login acceptance belongs to CI."""
import base64
import copy
from email.message import Message
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pl_grafana_test', BASE / 'grafana-controller.py')
gf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gf)


class GrafanaTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for name in ('private', 'state', 'modules'):
            (self.root / name).mkdir(mode=0o700)
        self.installation, self.instance = 'pl-123456abcdef', str(uuid.uuid4())
        self.image = {'id': 'sha256:' + '1' * 64, 'architecture': 'amd64', 'ref': 'pl/core-grafana:fixture',
                      'recipe': 'deploy/images/grafana.Dockerfile', 'labels': {
                          'pl.module.id': 'grafana', 'pl.module.config.version': '1', 'pl.build.variant': 'upstream-pinned',
                          'org.opencontainers.image.version': '13.3.0'}}
        gf.atomic(self.root / 'state/installation.json', {'install_id': self.installation, 'manifest_sha256': 'a' * 64})
        gf.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
                  'manifest_sha256': 'a' * 64, 'grafana': self.image})
        self.calls, self.containers, self.volumes, self.networks = [], {}, {}, {}
        self.prometheus = {}
        self.ingress = self.installation + '_ingress'
        self.networks[self.ingress] = self.network_object(self.ingress, {
            'pl.installation': self.installation, 'com.docker.compose.project': self.installation,
            'com.docker.compose.network': 'ingress'})
        self.controller = gf.GrafanaController(types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker, inspect=self.inspect_prometheus,
            observe=self.observe_prometheus, name=lambda instance: self.installation + '-prometheus-' + instance))
        self.controller.http = self.http

    def image_config(self):
        return {'User': '472:0', 'Entrypoint': ['/run.sh'], 'Cmd': None, 'Env': ['FIXTURE=1'], 'WorkingDir': '/usr/share/grafana', 'Labels': self.image['labels']}

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        kind, action = args[:2]
        if kind == 'image':
            return json.dumps([{'Id': self.image['id'], 'Architecture': 'amd64', 'Os': 'linux', 'Config': self.image_config()}]).encode()
        if kind in ('volume', 'network'):
            resources = self.volumes if kind == 'volume' else self.networks
            if action == 'ls':
                name = args[3].removeprefix('name=^').removesuffix('$')
                return name.encode() if name in resources else b''
            if action == 'inspect':
                return json.dumps([resources[args[-1]]]).encode()
            if action == 'create':
                if kind == 'network':
                    raise AssertionError('Grafana must never create a network')
                labels = dict(args[i+1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')
                resources[args[-1]] = {'Name': args[-1], 'Labels': labels, 'Driver': 'local' if kind == 'volume' else 'bridge', 'Options': {}, 'Scope': 'local', 'Internal': False, 'Ingress': False, 'Containers': {}, 'Id': '9' * 64, 'IPAM': {'Config': [{'Gateway': '172.29.0.1', 'Subnet': '172.29.0.0/16'}]}}
                return args[-1].encode()
            if kind == 'network' and action in ('connect', 'disconnect'):
                name, obj_id = args[-2:]
                prom = next(value for value in self.prometheus.values() if value['Id'] == obj_id)
                if action == 'connect':
                    resources[name]['Containers'][obj_id] = {'Name': prom['Name']}
                    prom['NetworkSettings']['Networks'][name] = {'Aliases': [args[args.index('--alias') + 1]]}
                else:
                    del resources[name]['Containers'][obj_id]
                    del prom['NetworkSettings']['Networks'][name]
                return b''
            if action == 'rm':
                del resources[args[-1]]
                return b''
        if kind == 'container':
            if action == 'ls':
                name = args[4].removeprefix('name=^/').removesuffix('$')
                return b'1' * 64 if name in self.containers else b''
            if action == 'inspect':
                return json.dumps([self.containers[args[-1]]]).encode()
            if action == 'create':
                name = args[args.index('--name') + 1]
                config = copy.deepcopy(self.image_config())
                config.update(Image=args[-1], Labels=dict(args[i+1].split('=', 1) for i, arg in enumerate(args) if arg == '--label'))
                mounts = []
                for i, arg in enumerate(args):
                    if arg != '--mount':
                        continue
                    fields = dict(part.split('=', 1) if '=' in part else (part, True) for part in args[i+1].split(','))
                    mounts.append({'Type': fields['type'], 'Name': fields['source'], 'Source': fields['source'], 'Destination': fields['target'], 'RW': not fields.get('readonly', False)})
                network = args[args.index('--network') + 1]
                alias = args[args.index('--network-alias') + 1]
                self.containers[name] = {'Id': '1' * 64, 'Name': '/' + name, 'Image': args[-1], 'Config': config, 'Mounts': mounts,
                    'State': {'Running': False}, 'HostConfig': {
                        'PortBindings': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]},
                        'ReadonlyRootfs': True, 'CapDrop': ['ALL'], 'NetworkMode': network, 'Memory': 512*1024**2,
                        'NanoCpus': 1_000_000_000, 'PidsLimit': 128, 'Init': True, 'SecurityOpt': ['no-new-privileges'],
                        'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}},
                        'RestartPolicy': {'Name': 'unless-stopped'}, 'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777'}},
                    'NetworkSettings': {'Networks': {network: {'NetworkID': self.networks[network]['Id'], 'Aliases': [name, alias]}}, 'Ports': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '32100'}]}}}
                return b'1' * 64
            if action in ('start', 'stop', 'rm'):
                name = next(k for k, value in self.containers.items() if value['Id'] == args[-1])
                if action == 'rm':
                    del self.containers[name]
                else:
                    self.containers[name]['State']['Running'] = action == 'start'
                return b''
        raise AssertionError('Unexpected Docker call')

    def inspect_prometheus(self, instance):
        value = self.prometheus.get(instance)
        if value and value.get('foreign'):
            raise ValueError('Prometheus ownership mismatch')
        return value

    def observe_prometheus(self, instance):
        obj = self.inspect_prometheus(instance)
        return {'state': 'running' if obj and obj['State']['Running'] else 'disabled'}

    def add_prometheus(self):
        instance = str(uuid.uuid4())
        self.prometheus[instance] = {'Id': '7' * 64, 'Name': self.controller.parent.name(instance),
            'State': {'Running': True}, 'NetworkSettings': {'Networks': {'bridge': {}}}}
        return instance

    def http(self, instance, obj):
        return 200, 'application/json', json.dumps({'version': self.controller.version, 'database': 'ok'}).encode()

    @staticmethod
    def network_object(name, labels, identity='9' * 64):
        return {'Name': name, 'Labels': labels, 'Driver': 'bridge', 'Options': {}, 'Scope': 'local',
                'Internal': False, 'Ingress': False, 'Containers': {}, 'Id': identity,
                'IPAM': {'Driver': 'default', 'Config': [{'Gateway': '172.29.0.1', 'Subnet': '172.29.0.0/16'}]}}

    def operation(self, action, operation=None):
        body = {'operation_id': operation or str(uuid.uuid4()), 'instance_id': self.instance, 'module_id': 'grafana', 'action': action}
        if action in ('install', 'enable'):
            body['public_url'] = 'https://pl.example'
        return body

    def install(self):
        result = self.controller.execute(self.operation('install'))
        self.assertEqual(result['state'], 'running')
        return result

    def test_initial_login_is_read_only_official_human_default(self):
        self.install()
        body = {'instance_id': self.instance, 'module_id': 'grafana', 'service': 'grafana'}
        state = self.controller.state(self.instance)
        files = {name: (self.controller.paths(self.instance) / name).read_bytes()
                 for name in ('state.json', 'config/grafana.ini')}
        self.calls.clear()
        value = self.controller.initial_login(body)
        self.assertEqual(value, {**body, 'username': 'admin', 'password': 'admin', 'path': '/grafana/login'})
        self.assertNotIn(state['secret'], json.dumps(value))
        self.assertTrue(all(args[1] in ('ls', 'inspect') for args in self.calls))
        self.assertEqual(files, {name: (self.controller.paths(self.instance) / name).read_bytes() for name in files})
        for extra in ({'service': 'pl-bootstrap'}, {'module_id': 'netmap'}, {'password': 'replacement'}, {'instance_id': 'foreign'}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.controller.initial_login({**body, **extra})

    def test_initial_login_rejects_stopped_and_drifted_native_container(self):
        self.install()
        body = {'instance_id': self.instance, 'module_id': 'grafana', 'service': 'grafana'}
        obj = self.containers[self.controller.name(self.instance)]
        for modify in (lambda x: x['State'].update(Running=False),
                       lambda x: x['Config']['Labels'].update({'pl.instance': str(uuid.uuid4())}),
                       lambda x: x['Config'].update(Env=['GF_SECURITY_ADMIN_PASSWORD=foreign'])):
            before = copy.deepcopy(obj)
            modify(obj)
            with self.assertRaises(ValueError):
                self.controller.initial_login(body)
            obj.clear()
            obj.update(before)

    def test_initial_login_refuses_legacy_bootstrap_credentials(self):
        legacy, _ = self.legacy_fixture()
        before = copy.deepcopy(self.containers)
        with self.assertRaises(ValueError):
            self.controller.initial_login({'instance_id': self.instance, 'module_id': 'grafana', 'service': 'grafana'})
        self.assertEqual(self.controller.journal(self.instance), legacy)
        self.assertEqual(self.containers, before)

    def test_install_is_idempotent_with_native_defaults_and_private_versioned_state(self):
        operation = self.operation('install')
        first = self.controller.execute(operation)
        self.assertEqual(first['state'], 'running')
        self.assertEqual(self.controller.execute(operation), first)
        self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'running')
        state = self.controller.state(self.instance)
        self.assertEqual(set(state), {'schema', 'installation', 'instance_id', 'root_url', 'secret', 'network_id'})
        self.assertEqual(state['schema'], 2)
        self.assertNotIn(state['secret'], json.dumps(first))
        self.assertEqual((self.controller.paths(self.instance) / 'state.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(first['endpoint'], 'http://pl-grafana-' + self.instance + ':3000')
        self.assertEqual(len(self.containers), 1)
        self.assertEqual(len(self.volumes), 1)
        config = (self.controller.paths(self.instance) / 'config/grafana.ini').read_text()
        self.assertEqual(config, '[server]\nroot_url = https://pl.example/grafana/\nserve_from_sub_path = true\n'
                         '[security]\nsecret_key = ' + state['secret'] + '\n')
        # Default admin/admin, password change, users, CSRF and plugin signatures
        # belong to the official image. No Platform identity/role overrides.
        for forbidden in ('auth', 'admin_user', 'admin_password', 'disable_login', 'users', 'csrf', 'plugins'):
            self.assertNotIn(forbidden, config)

    def test_zero_prometheus_uses_only_existing_ingress_without_provisioning(self):
        with patch.object(self.controller.parent, 'inspect', side_effect=AssertionError('Unexpected Prometheus lookup')), \
             patch.object(self.controller.parent, 'observe', side_effect=AssertionError('Unexpected Prometheus lookup')):
            self.install()
            self.assertEqual(self.controller.get(self.instance)['state'], 'running')
        self.assertEqual(set(self.networks), {self.ingress})
        self.assertFalse(any(call[:2] in (('network', 'create'), ('network', 'connect')) for call in self.calls))
        create = next(call for call in self.calls if call[:2] == ('container', 'create'))
        self.assertEqual(create[create.index('--network') + 1], self.ingress)
        self.assertEqual(create[create.index('--network-alias') + 1], 'pl-grafana-' + self.instance)
        self.assertEqual(create[create.index('--publish') + 1], '127.0.0.1::3000')

    def test_automatic_prometheus_selection_is_rejected_without_artifacts(self):
        result = self.controller.execute({**self.operation('install'), 'prometheus_instance_id': str(uuid.uuid4())})
        self.assertEqual(result['state'], 'error')
        self.assertFalse(self.volumes)
        self.assertFalse(self.containers)
        self.assertFalse(self.controller.instances.joinpath(self.instance).exists())
        self.assertFalse(any(call[:2] in (('network', 'connect'), ('network', 'create')) for call in self.calls))

    def test_disable_enable_preserves_native_state_and_remove_keeps_shared_ingress(self):
        self.install()
        state = self.controller.state(self.instance)
        self.networks[self.ingress]['Containers']['a' * 64] = {'Name': self.installation + '-web-1'}
        shared_before = copy.deepcopy(self.networks[self.ingress])
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertEqual(len(self.volumes), 1)
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'running')
        self.assertEqual(self.controller.state(self.instance), state)
        operation = self.operation('remove')
        self.assertEqual(self.controller.execute(operation)['state'], 'absent')
        self.assertEqual(self.controller.execute(operation)['state'], 'absent')
        self.assertFalse(self.volumes)
        self.assertFalse(self.containers)
        self.assertEqual(self.networks[self.ingress], shared_before)
        self.assertFalse(any(call[:2] in (('network', 'rm'), ('network', 'disconnect')) for call in self.calls))

    def interrupt_remove_after_state_unlink(self, operation):
        base = self.controller.paths(self.instance)
        original_rmdir = Path.rmdir
        interrupted = []
        def rmdir(path):
            if path == base / 'config' and not (base / 'state.json').exists():
                interrupted.append(path)
                raise OSError('Simulated crash after state unlink')
            return original_rmdir(path)
        with patch.object(Path, 'rmdir', autospec=True, side_effect=rmdir):
            self.assertEqual(self.controller.execute(operation)['state'], 'error')
        self.assertEqual(interrupted, [base / 'config'])
        self.assertFalse((base / 'state.json').exists())
        self.assertTrue((self.controller.operations / ('remove-' + self.instance + '.json')).exists())
        return base

    def test_remove_resumes_hash_bound_cleanup_after_state_unlink_for_native_and_legacy(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                if legacy:
                    self.legacy_fixture()
                else:
                    self.install()
                operation = self.operation('remove')
                base = self.interrupt_remove_after_state_unlink(operation)
                self.calls.clear()
                self.assertEqual(self.controller.execute(operation)['state'], 'absent')
                self.assertFalse(base.exists())
                self.assertFalse((self.controller.operations / ('remove-' + self.instance + '.json')).exists())
                self.assertEqual(set(self.networks), {self.ingress})
                self.assertFalse(any(c[:2] in (('container', 'rm'), ('volume', 'rm'), ('network', 'rm'),
                                              ('network', 'disconnect')) for c in self.calls))

    def test_remove_without_state_does_not_delete_recreated_owned_volume(self):
        self.install()
        name = self.controller.name(self.instance, '-data')
        volume = copy.deepcopy(self.volumes[name])
        operation = self.operation('remove')
        self.interrupt_remove_after_state_unlink(operation)
        self.volumes[name] = volume
        self.calls.clear()
        self.assertEqual(self.controller.execute(operation)['state'], 'error')
        self.assertEqual(self.volumes[name], volume)
        self.assertFalse(any(c[:2] in (('volume', 'rm'), ('network', 'rm')) for c in self.calls))
        del self.volumes[name]
        self.assertEqual(self.controller.execute(operation)['state'], 'absent')

    def test_shared_ingress_is_never_created_or_adopted_on_identity_mismatch(self):
        original = copy.deepcopy(self.networks[self.ingress])
        mutations = (
            lambda obj: obj.update(Name='foreign'), lambda obj: obj.update(Driver='overlay'),
            lambda obj: obj.update(Scope='swarm'), lambda obj: obj.update(Internal=True),
            lambda obj: obj.update(Ingress=True), lambda obj: obj.update(Id='short-id'),
            lambda obj: obj['Labels'].update({'pl.installation': 'another-installation'}),
            lambda obj: obj['Labels'].update({'com.docker.compose.project': 'foreign'}),
            lambda obj: obj['Labels'].update({'com.docker.compose.network': 'backend'}))
        for change in mutations:
            with self.subTest(change=change):
                self.networks[self.ingress] = copy.deepcopy(original)
                change(self.networks[self.ingress])
                self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'error')
                self.assertFalse(self.volumes)
                self.assertFalse(self.containers)
        self.networks.clear()
        self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'error')
        self.assertFalse(any(call[:2] == ('network', 'create') for call in self.calls))

    def test_ingress_identity_change_and_container_alias_extra_network_drift_fail_closed(self):
        self.install()
        original = copy.deepcopy(self.networks[self.ingress])
        self.networks[self.ingress]['Id'] = '8' * 64
        with self.assertRaises(ValueError):
            self.controller.state(self.instance)
        self.networks[self.ingress] = original
        obj = next(iter(self.containers.values()))
        for change in (
                lambda x: x['NetworkSettings']['Networks'][self.ingress].update(Aliases=[]),
                lambda x: x['NetworkSettings']['Networks'][self.ingress].update(Aliases=['pl-grafana-' + self.instance, 'foreign']),
                lambda x: x['NetworkSettings']['Networks'][self.ingress].update(NetworkID='8' * 64),
                lambda x: x['NetworkSettings']['Networks'].update(bridge={}),
                lambda x: x['HostConfig'].update(NetworkMode='bridge')):
            before = copy.deepcopy(obj)
            change(obj)
            with self.assertRaises(ValueError):
                self.controller.inspect(self.instance)
            obj.clear()
            obj.update(before)

    def test_only_never_started_container_may_have_pending_network_endpoint(self):
        self.install()
        obj = next(iter(self.containers.values()))
        obj['NetworkSettings']['Networks'][self.ingress]['NetworkID'] = ''
        with self.assertRaises(ValueError):
            self.controller.inspect(self.instance)
        obj['State'].update(Running=False, Status='created')
        self.controller.inspect(self.instance)
        obj['State']['Status'] = 'exited'
        with self.assertRaises(ValueError):
            self.controller.inspect(self.instance)

    def test_foreign_volume_or_configuration_is_not_deleted(self):
        name = self.controller.name(self.instance, '-data')
        self.volumes[name] = {'Name': name, 'Driver': 'local', 'Options': {}, 'Labels': {}}
        self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'error')
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertFalse(any(c[:2] == ('volume', 'rm') for c in self.calls))
        self.assertIn(name, self.volumes)

    def test_unexpected_config_file_or_ini_drift_blocks_removal_before_stop(self):
        self.install()
        base = self.controller.paths(self.instance)
        (base / 'config/foreign.ini').write_text('foreign')
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertTrue(next(iter(self.containers.values()))['State']['Running'])
        (base / 'config/foreign.ini').unlink()
        gf.atomic(base / 'config/grafana.ini', b'[auth.proxy]\nenabled = true\n', mode=0o444)
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertFalse(any(c[:2] in (('container', 'stop'), ('container', 'rm'), ('volume', 'rm')) for c in self.calls))

    def test_lan_binding_capability_mount_and_image_drift_fail_closed(self):
        self.install()
        obj = next(iter(self.containers.values()))
        for modify in (lambda x: x['HostConfig']['PortBindings']['3000/tcp'][0].update(HostIp='0.0.0.0'),
                       lambda x: x['HostConfig'].update(CapAdd=['NET_ADMIN']),
                       lambda x: x['Config'].update(Env=['GF_AUTH_PROXY_ENABLED=true']),
                       lambda x: x['Mounts'][0].update(Name='foreign-volume'),
                       lambda x: x['Mounts'].append(copy.deepcopy(x['Mounts'][0])),
                       lambda x: x.update(Name='/foreign')):
            before = copy.deepcopy(obj)
            modify(obj)
            with self.assertRaises(ValueError):
                self.controller.inspect(self.instance)
            obj.clear()
            obj.update(before)

    def test_health_requires_database_and_manifest_native_version(self):
        self.install()
        for data in (b'{"version":"13.3.0","database":"failed"}', b'{"version":"other","database":"ok"}', b'[]'):
            self.controller.http = lambda *a, **k: (200, 'application/json', data)
            with self.assertRaises(ValueError):
                self.controller.ready(self.instance)

    def test_native_version_comes_from_trusted_descriptor(self):
        self.image['labels']['org.opencontainers.image.version'] = '14.1.2'
        gf.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
                  'manifest_sha256': 'a' * 64, 'grafana': self.image})
        self.controller = gf.GrafanaController(self.controller.parent)
        self.controller.http = self.http
        self.assertEqual(self.install()['version'], '14.1.2')

    def test_controller_http_only_probes_health_without_identity_or_credentials(self):
        self.install()
        captured = []
        class Response:
            status = 200
            headers = types.SimpleNamespace(get_content_type=lambda: 'application/json')
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, maximum):
                return b'{"database":"ok"}'
        def open_request(request, timeout):
            captured.append(request)
            return Response()
        with patch.object(gf.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_request)):
            gf.GrafanaController.http(self.controller, self.instance, next(iter(self.containers.values())))
        request = captured[0]
        self.assertEqual(request.method, 'GET')
        self.assertEqual(request.full_url, 'http://127.0.0.1:32100/grafana/api/health')
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers, {'accept-encoding': 'identity', 'host': 'pl.example'})
        self.assertIsNone(request.data)

    def test_platform_identity_gateway_is_disabled(self):
        self.install()
        for body in ({}, {'instance_id': self.instance, 'admin': True, 'user_id': 'platform-admin'}, None):
            with self.assertRaisesRegex(ValueError, 'direct native HTTP proxy'):
                self.controller.request(body)

    def test_chart_transport_uses_native_session_and_bounds_routes(self):
        self.install()
        body = {'instance_id': self.instance, 'method': 'GET', 'path': '/grafana/api/search',
                'query': 'limit=201&type=dash-db', 'content_type': '', 'body': '',
                'user_id': 'system:modules:provider', 'user_name': 'PL', 'admin': False,
                'browser_session': 'native-session'}
        captured = []

        class Response:
            status = 200
            headers = Message()
            headers.add_header('Set-Cookie', 'grafana_session=rotated; Path=/grafana/; HttpOnly')
            headers.add_header('Set-Cookie', 'portal_session=forged; Path=/')
            def read(self, limit):
                return b'[]'
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass

        def open_request(request, timeout):
            captured.append(request)
            return Response()

        query = base64.b64encode(b'{"queries":[]}').decode()
        with patch.object(gf.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_request)):
            result = self.controller.request(body)
            self.controller.request({**body, 'method': 'POST', 'path': '/grafana/api/ds/query',
                                     'query': '', 'content_type': 'application/json', 'body': query})
            for fields in ({'admin': True}, {'browser_session': 'foo; portal_session=bad'},
                           {'path': '/grafana/api/admin/users'}, {'query': 'limit=10000&type=dash-db'},
                           {'method': 'POST', 'path': '/grafana/api/datasources', 'query': '',
                            'content_type': 'application/json', 'body': query}):
                with self.subTest(fields=fields), self.assertRaises(ValueError):
                    self.controller.request({**body, **fields})
        self.assertEqual(len(captured), 2)
        self.assertEqual(result['set_cookies'], ['grafana_session=rotated; Path=/grafana/; HttpOnly'])
        self.assertEqual(captured[0].full_url, 'http://127.0.0.1:32100/grafana/api/search?limit=201&type=dash-db')
        self.assertEqual(captured[0].get_header('Cookie'), 'grafana_session=native-session')
        self.assertIsNone(captured[0].get_header('Authorization'))
        self.assertEqual(captured[1].get_header('Origin'), 'https://pl.example')
        self.assertEqual(captured[1].data, b'{"queries":[]}')

    def test_chart_transport_renews_grafana_session_on_rotation_error(self):
        self.install()
        body = {'instance_id': self.instance, 'method': 'GET', 'path': '/grafana/api/search',
                'query': 'limit=201&type=dash-db', 'content_type': '', 'body': '',
                'user_id': 'system:modules:provider', 'user_name': 'PL', 'admin': False,
                'browser_session': 'before-rotation'}
        cookie = 'grafana_session=after-rotation; Path=/grafana/; HttpOnly'
        captured = []
        responses = iter(((401, b'{"messageId":"session.token.rotate"}', ''),
                          (200, b'{}', cookie), (200, b'[]', '')))

        class Response:
            def __init__(self, status, data, session_cookie):
                self.status, self.data, self.headers = status, data, Message()
                if session_cookie:
                    self.headers.add_header('Set-Cookie', session_cookie)
            def read(self, limit):
                return self.data
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass

        def open_request(request, timeout):
            captured.append((request.method, gf.urllib.parse.urlsplit(request.full_url).path, request.get_header('Cookie')))
            return Response(*next(responses))

        with patch.object(gf.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_request)):
            result = self.controller.request(body)
        self.assertEqual(captured, [
            ('GET', '/grafana/api/search', 'grafana_session=before-rotation'),
            ('POST', '/grafana/api/user/auth-tokens/rotate', 'grafana_session=before-rotation'),
            ('GET', '/grafana/api/search', 'grafana_session=after-rotation'),
        ])
        self.assertEqual(result['status'], 200)
        self.assertEqual(result['set_cookies'], [cookie])

    def legacy_fixture(self, with_container=True, prometheus=True):
        self.install()
        base = self.controller.paths(self.instance)
        native = self.controller.state(self.instance)
        prom = self.add_prometheus() if prometheus else ''
        legacy_name = self.controller.name(self.instance, '-net')
        legacy = {'installation': self.installation, 'instance_id': self.instance, 'root_url': native['root_url'],
                  'secret': native['secret'], 'password': 'd' * 64, 'network_id': '8' * 64,
                  'gateway': '172.29.0.1', 'prometheus_instance_id': prom}
        self.networks[legacy_name] = self.network_object(legacy_name, self.controller.labels(self.instance), '8' * 64)
        if prom:
            self.networks[legacy_name]['Containers'][self.prometheus[prom]['Id']] = {'Name': self.controller.parent.name(prom)}
            self.prometheus[prom]['NetworkSettings']['Networks'][legacy_name] = {'Aliases': ['pl-prometheus-' + prom]}
        gf.atomic(base / 'state.json', legacy)
        gf.atomic(base / 'config/grafana.ini', self.controller.config(legacy), mode=0o444)
        if with_container:
            obj = next(iter(self.containers.values()))
            obj['HostConfig']['NetworkMode'] = legacy_name
            obj['NetworkSettings']['Networks'] = {legacy_name: {}}
        else:
            self.containers.clear()
        return legacy, prom

    def test_legacy_observe_remove_preserve_selected_prometheus_and_shared_ingress(self):
        legacy, prom = self.legacy_fixture()
        self.assertEqual(self.controller.get(self.instance)['endpoint'], 'http://127.0.0.1:32100')
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')
        self.assertFalse(self.volumes)
        self.assertFalse(self.containers)
        self.assertEqual(set(self.networks), {self.ingress})
        self.assertTrue(self.prometheus[prom]['State']['Running'])
        self.assertEqual(self.prometheus[prom]['NetworkSettings']['Networks'], {'bridge': {}})
        removed = [c[-1] for c in self.calls if c[:2] == ('network', 'rm')]
        self.assertEqual(removed, [self.controller.name(self.instance, '-net')])

    def test_legacy_failed_initialization_can_remove_owned_volume_without_container(self):
        self.legacy_fixture(with_container=False, prometheus=False)
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')
        self.assertFalse(self.volumes)
        self.assertEqual(set(self.networks), {self.ingress})

    def test_legacy_enable_refuses_implicit_migration_and_preserves_files_and_data(self):
        legacy, _ = self.legacy_fixture()
        base = self.controller.paths(self.instance)
        before = {name: (base / name).read_bytes() for name in ('state.json', 'config/grafana.ini')}
        volumes = copy.deepcopy(self.volumes)
        for action in ('enable', 'install'):
            result = self.controller.execute(self.operation(action))
            self.assertEqual(result['state'], 'error')
            self.assertIn('explicit native-auth migration', result['error'])
        self.assertEqual(self.controller.journal(self.instance), legacy)
        self.assertEqual({name: (base / name).read_bytes() for name in before}, before)
        self.assertEqual(self.volumes, volumes)

    def test_legacy_foreign_network_member_blocks_destructive_removal(self):
        self.legacy_fixture()
        self.networks[self.controller.name(self.instance, '-net')]['Containers']['e' * 64] = {'Name': 'foreign-container'}
        self.calls.clear()
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertTrue(self.volumes)
        self.assertTrue(self.containers)
        self.assertFalse(any(c[:2] in (('container', 'stop'), ('network', 'disconnect'), ('volume', 'rm')) for c in self.calls))

    def test_legacy_source_signed_image_can_be_observed_and_removed(self):
        self.legacy_fixture(prometheus=False)
        labels = {'pl.build.variant': 'source-build-pl-signed', 'pl.build.go': '1.27.2'}
        self.image['labels'].update(labels)
        self.controller.image['labels'].update(labels)
        next(iter(self.containers.values()))['Config']['Labels'].update(labels)
        self.assertEqual(self.controller.get(self.instance)['state'], 'running')
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')
        self.assertEqual(set(self.networks), {self.ingress})

    def test_custom_signed_image_is_legacy_only(self):
        self.controller.image['labels']['pl.build.variant'] = 'source-build-pl-signed'
        result = self.controller.execute(self.operation('install'))
        self.assertEqual(result['state'], 'error')
        self.assertIn('explicit migration', result['error'])
        self.assertFalse(self.volumes)
        self.assertFalse(self.containers)

    def test_operation_id_cannot_change_origin_or_action(self):
        op = self.operation('install')
        self.controller.execute(op)
        for change in ({'action': 'remove'}, {'public_url': 'https://another.example'}):
            with self.assertRaises(ValueError):
                self.controller.execute({**op, **change})

    def test_origin_is_only_explicit_http_origin(self):
        self.assertEqual(gf.public_origin('https://pl.example:8443'), 'https://pl.example:8443/grafana/')
        for value in ('https://u:p@pl.example', 'https://pl.example/arbitrary', 'file:///etc/passwd',
                      'https://pl.example/?url=x', 'http://pl.example\nInjected: yes'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                gf.public_origin(value)


if __name__ == '__main__':
    unittest.main()
