"""Owned Wayline orchestration and finite bridge contract. Real probes run in CI."""
from concurrent.futures import ThreadPoolExecutor
import threading
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pl_wayline_test', BASE / 'wayline-controller.py')
wl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wl)


class RoutesTests(unittest.TestCase):
    def test_actual_numeric_object_ids_and_finite_routes(self):
        for method, path, query, body in (
                ('GET', '/', '', b''), ('HEAD', '/assets/index-Ab_12.js', '', b''), ('GET', '/assets/index-Ab_12.js', '', b''),
                ('GET', '/assets/theme-init.js', '', b''), ('GET', '/api/v1/targets/3', '', b''),
                ('GET', '/api/v1/checks/latest', 'kind=path', b''),
                ('GET', '/api/v1/checks', 'target_id=12&limit=50', b''),
                ('POST', '/api/v1/targets/3/checks', '', b'{"kind":"path"}'),
                ('PUT', '/api/v1/targets/3', '', b'{}'), ('DELETE', '/api/v1/targets/3', '', b'')):
            with self.subTest(method=method, path=path):
                wl.allowed_request(method, path, query, 'application/json' if body else '', body)

    def test_no_urls_path_escape_or_arbitrary_operations(self):
        for method, path, query, content_type, body in (
                ('GET', 'http://other/api/v1/targets', '', '', b''),
                ('GET', '//other/api/v1/targets', '', '', b''),
                ('GET', '/assets/../state.json', '', '', b''),
                ('GET', '/assets/%2e%2e/state.json', '', '', b''),
                ('GET', '/api/v1/targets\\anything', '', '', b''),
                ('GET', '/api/v1/targets', 'url=http://other', '', b''),
                ('GET', '/api/v1/checks', 'kind=path&kind=iperf', '', b''),
                ('GET', '/api/v1/targets', '', '', b'{}'),
                ('POST', '/api/v1/targets', '', 'text/plain', b'{}'),
                ('POST', '/api/v1/targets', '', 'application/json', b'x' * (wl.MAX_BODY + 1)),
                ('DELETE', '/api/v1/checks/3', '', '', b''),
                ('GET', '/api/v1/targets/0', '', '', b''),
                ('GET', '/etc/passwd', '', '', b''), ('CONNECT', '/', '', '', b'')):
            with self.subTest(method=method, path=path):
                with self.assertRaises(ValueError):
                    wl.allowed_request(method, path, query, content_type, body)


class WaylineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('private', 'state', 'modules'):
            (self.root / name).mkdir(mode=0o700)
        self.installation = 'pl-123456abcdef'
        self.images = {}
        for index, role in enumerate(wl.ROLES):
            self.images[role] = {'id': 'sha256:' + str(index + 1) * 64, 'architecture': 'amd64',
                'ref': 'pl/wayline-' + role + ':test', 'recipe': 'deploy/images/wayline.Dockerfile',
                'labels': {'pl.module.id': 'wayline', 'pl.module.role': role,
                           'pl.module.config.version': '1', 'pl.build.variant': 'source-build', 'org.opencontainers.image.version': '0.1.0'}}
        wl.atomic(self.root / 'state/installation.json', {'install_id': self.installation, 'manifest_sha256': 'a' * 64})
        wl.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
            'manifest_sha256': 'a' * 64, 'wayline': self.images})
        self.calls, self.containers, self.resources = [], {}, {'network': {}, 'volume': {}}
        parent = types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker)
        gid_patch = patch.object(wl, 'RUNNER_GID', os.getegid())
        gid_patch.start()
        self.addCleanup(gid_patch.stop)
        self.controller = wl.WaylineController(parent)
        self.instance = str(uuid.uuid4())
        self.http_calls = []
        self.controller.http = self.http

    def image(self, role):
        return {'Id': self.images[role]['id'], 'Os': 'linux', 'Architecture': 'amd64', 'Config': {
            'Labels': self.images[role]['labels'], 'Entrypoint': ['/bin/fixture-' + role], 'Cmd': None,
            'User': '0:10001' if role == 'runner' else '10001:10001', 'WorkingDir': '/', 'Env': ['FIXTURE=1']}}

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        kind, action = args[:2]
        if kind == 'image':
            role = next(k for k, v in self.images.items() if v['id'] == args[-1])
            return json.dumps([self.image(role)]).encode()
        if kind in ('network', 'volume'):
            if action == 'ls':
                name = args[3].removeprefix('name=^').removesuffix('$')
                return name.encode() if name in self.resources[kind] else b''
            if action == 'inspect':
                obj = copy.deepcopy(self.resources[kind][args[-1]])
                if kind == 'network':
                    obj['Containers'] = {v['Id']: {'Name': name} for name, v in self.containers.items()}
                return json.dumps([obj]).encode()
            if action == 'create':
                labels = dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')
                self.resources[kind][args[-1]] = {'Name': args[-1], 'Driver': 'local' if kind == 'volume' else 'bridge',
                                                'Labels': labels, 'Options': {}, 'Scope': 'local', 'Internal': False, 'Ingress': False}
                return args[-1].encode()
            if action == 'rm':
                del self.resources[kind][args[-1]]
                return b''
        if kind == 'container':
            if action == 'ls':
                name = args[4].removeprefix('name=^/').removesuffix('$')
                return self.containers[name]['Id'].encode() if name in self.containers else b''
            if action == 'inspect':
                return json.dumps([self.containers[args[-1]]]).encode()
            if action == 'create':
                role = next(k for k, v in self.images.items() if v['id'] == args[-1])
                name = args[args.index('--name') + 1]
                labels = dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')
                config = copy.deepcopy(self.image(role)['Config'])
                config.update(Image=args[-1], Labels=labels)
                mounts = []
                for index, arg in enumerate(args):
                    if arg != '--mount':
                        continue
                    fields = dict(part.split('=', 1) if '=' in part else (part, True) for part in args[index + 1].split(','))
                    mounts.append({'Type': fields['type'], 'Name': fields['source'] if fields['type'] == 'volume' else '',
                                   'Source': fields['source'], 'Destination': fields['target'], 'RW': not fields.get('readonly', False)})
                ports = {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]} if role == 'gateway' else {}
                self.containers[name] = {'Id': str(len(self.containers) + 1) * 64, 'Image': args[-1], 'Config': config,
                    'Mounts': mounts, 'State': {'Running': False}, 'HostConfig': {
                        'PortBindings': ports, 'ReadonlyRootfs': True, 'CapDrop': ['ALL'], 'CapAdd': ['CAP_NET_RAW'] if role == 'runner' else [],
                        'NetworkMode': self.controller.name(self.instance, '-net'), 'Memory': 256 * 1024**2,
                        'NanoCpus': 1_000_000_000, 'PidsLimit': 128, 'Init': True, 'SecurityOpt': ['no-new-privileges'],
                        'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}},
                        'RestartPolicy': {'Name': 'unless-stopped'}, 'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=33554432,mode=1777'}},
                    'NetworkSettings': {'Networks': {self.controller.name(self.instance, '-net'): {}},
                                        'Ports': {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '32100'}]} if role == 'gateway' else {}}}
                return self.containers[name]['Id'].encode()
            if action in ('start', 'stop', 'rm'):
                name = next(k for k, v in self.containers.items() if v['Id'] == args[-1])
                if action == 'rm':
                    del self.containers[name]
                else:
                    self.containers[name]['State']['Running'] = action == 'start'
                return b''
        raise AssertionError('Unexpected Docker invocation')

    def http(self, instance, obj, method, path, query='', content_type='', raw=b''):
        self.http_calls.append((method, path, query, content_type, raw))
        value = {'version': '0.1.0'} if path.endswith('/health') else {'status': 'ready'}
        return 200, 'application/json', json.dumps(value).encode()

    def operation(self, action, operation=None):
        return {'operation_id': operation or str(uuid.uuid4()), 'instance_id': self.instance, 'module_id': 'wayline', 'action': action}

    def install(self):
        result = self.controller.execute(self.operation('install'))
        self.assertEqual(result['state'], 'running')
        return result

    def test_install_is_idempotent_and_secrets_are_not_observed(self):
        request = self.operation('install')
        first = self.controller.execute(request)
        self.assertEqual(first['state'], 'running')
        state = self.controller.state(self.instance)
        self.assertNotIn(state['password'], json.dumps(first))
        self.assertNotIn(state['runner_token'], json.dumps(first))
        self.assertEqual(self.controller.execute(request), first)
        self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'running')
        self.assertEqual(len(self.containers), 3)
        self.assertEqual(len(self.resources['volume']), 1)
        self.assertEqual(len(self.resources['network']), 1)

    def test_disable_enable_preserves_volume_and_credentials(self):
        self.install()
        before = self.controller.state(self.instance)
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertEqual(len(self.resources['volume']), 1)
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'running')
        self.assertEqual(self.controller.state(self.instance), before)

    def test_only_gateway_publishes_loopback_runner_is_only_capable_process(self):
        self.install()
        creates = [c for c in self.calls if c[:2] == ('container', 'create')]
        self.assertEqual(sum('--publish' in call for call in creates), 1)
        self.assertIn('127.0.0.1::8080', next(c for c in creates if '--publish' in c))
        self.assertEqual(sum('--cap-add' in call for call in creates), 1)
        self.assertIn(self.images['runner']['id'], next(c for c in creates if '--cap-add' in c))
        self.assertNotIn('--privileged', str(creates))

    def test_reusing_operation_id_with_other_action_is_rejected(self):
        operation = self.operation('install')
        self.controller.execute(operation)
        with self.assertRaises(ValueError):
            self.controller.execute({**operation, 'action': 'remove'})

    def test_foreign_volume_prevents_install_and_is_not_removed(self):
        name = self.controller.name(self.instance, '-data')
        self.resources['volume'][name] = {'Name': name, 'Driver': 'local', 'Options': {}, 'Labels': {}}
        self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'error')
        self.assertIn(name, self.resources['volume'])
        self.assertFalse(any(c[:2] == ('volume', 'rm') for c in self.calls))

    def test_container_drift_prevents_stop_and_remove(self):
        self.install()
        self.containers[self.controller.name(self.instance, '-gateway')]['HostConfig']['PortBindings']['8080/tcp'][0]['HostIp'] = '0.0.0.0'
        self.calls.clear()
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertFalse(any(c[:2] in (('container', 'stop'), ('container', 'rm'), ('volume', 'rm')) for c in self.calls))

    def test_runner_capability_prefix_is_equivalent_without_runtime_changes(self):
        self.install()
        runner = self.containers[self.controller.name(self.instance, '-runner')]
        self.calls.clear()
        for capabilities in (['NET_RAW'], ['CAP_NET_RAW']):
            runner['HostConfig']['CapAdd'] = capabilities
            self.assertEqual(self.controller.inspect(self.instance, 'runner')['Id'], runner['Id'])
        for role in ('api', 'gateway'):
            container = self.containers[self.controller.name(self.instance, '-' + role)]
            for capabilities in (None, []):
                container['HostConfig']['CapAdd'] = capabilities
                self.assertEqual(self.controller.inspect(self.instance, role)['Id'], container['Id'])
        self.assertFalse(any(c[1] in ('create', 'start', 'stop', 'rm') for c in self.calls))

    def test_malformed_or_additional_capabilities_fail_closed(self):
        self.install()
        runner = self.containers[self.controller.name(self.instance, '-runner')]
        invalid = (None, [], ['NET_ADMIN'], ['CAP_SYS_ADMIN'], ['ALL'], ['CAP_ALL'],
                   ['NET_RAW', 'NET_ADMIN'], ['CAP_NET_RAW', 'CAP_NET_ADMIN'],
                   ['NET_RAW', 'NET_RAW'], ['NET_RAW', 'CAP_NET_RAW'],
                   ['CAP_CAP_NET_RAW'], ['CAP_'], ['net_raw'], [' NET_RAW'], ['NET_RAW\n'],
                   [1], [None], [['NET_RAW']], 'NET_RAW', {'NET_RAW': True}, 1, False)
        for capabilities in invalid:
            with self.subTest(capabilities=capabilities):
                runner['HostConfig']['CapAdd'] = copy.deepcopy(capabilities)
                with self.assertRaises(ValueError):
                    self.controller.inspect(self.instance, 'runner')
        runner['HostConfig']['CapAdd'] = ['CAP_NET_RAW']
        for role in ('api', 'gateway'):
            container = self.containers[self.controller.name(self.instance, '-' + role)]
            for capabilities in (['NET_RAW'], ['CAP_NET_RAW']):
                container['HostConfig']['CapAdd'] = capabilities
                with self.assertRaises(ValueError):
                    self.controller.inspect(self.instance, role)
            container['HostConfig']['CapAdd'] = []

    def test_extra_runner_capability_blocks_removal_before_docker_mutations(self):
        self.install()
        runner = self.containers[self.controller.name(self.instance, '-runner')]
        runner['HostConfig']['CapAdd'] = ['CAP_NET_RAW', 'CAP_NET_ADMIN']
        self.calls.clear()
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertEqual(len(self.containers), 3)
        self.assertFalse(any(c[:2] in (('container', 'stop'), ('container', 'rm'), ('volume', 'rm'), ('network', 'rm')) for c in self.calls))

    def test_unknown_local_file_blocks_removal(self):
        self.install()
        (self.controller.paths(self.instance) / 'foreign-file').write_text('unowned')
        self.calls.clear()
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertFalse(any(c[:2] == ('container', 'rm') for c in self.calls))

    def test_owned_remove_is_complete_and_repeatable(self):
        self.install()
        operation = self.operation('remove')
        self.assertEqual(self.controller.execute(operation)['state'], 'absent')
        self.assertEqual(self.controller.execute(operation)['state'], 'absent')
        self.assertFalse(self.containers)
        self.assertFalse(self.resources['volume'])
        self.assertFalse(self.resources['network'])
        self.assertFalse((self.controller.instances / self.instance).exists())

    def test_gateway_request_rejects_client_headers_and_base64_corruption(self):
        self.install()
        request = {'instance_id': self.instance, 'method': 'GET', 'path': '/api/v1/targets',
                   'query': '', 'content_type': '', 'body': ''}
        self.assertEqual(self.controller.request(request)['status'], 200)
        for delta in ({'headers': {'Authorization': 'untrusted'}}, {'body': '!'}, {'path': 'http://other/'}, {'method': 'CONNECT'}):
            with self.subTest(delta=delta), self.assertRaises(ValueError):
                self.controller.request({**request, **delta})

    def test_runner_credential_drift_is_not_repaired(self):
        self.install()
        path = self.controller.paths(self.instance) / 'config/runner-token'
        path.chmod(0o640)
        before = path.read_bytes()
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'error')
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_interrupted_initialization_reuses_private_journal(self):
        original = wl.atomic
        def interrupted(path, value, mode=0o600):
            if path.name == 'runner-token':
                raise OSError('simulated interruption')
            return original(path, value, mode)
        with patch.object(wl, 'atomic', side_effect=interrupted):
            with self.assertRaises(OSError):
                self.controller.initialize(self.instance)
        state = json.loads(wl.read_file(self.controller.paths(self.instance) / 'state.json'))
        self.controller.initialize(self.instance)
        self.assertEqual(self.controller.state(self.instance), state)

    def test_changed_image_identity_is_rejected(self):
        original = self.docker
        def changed(*args, **kwargs):
            if args[:2] == ('image', 'inspect'):
                value = json.loads(original(*args, **kwargs))
                value[0]['Id'] = 'sha256:' + 'f' * 64
                return json.dumps(value).encode()
            return original(*args, **kwargs)
        self.controller.docker = changed
        self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'error')
        self.assertFalse(self.containers)

    def test_runner_version_must_match_the_other_roles(self):
        self.images['runner']['labels']['org.opencontainers.image.version'] = '0.2.0'
        wl.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
            'manifest_sha256': 'a' * 64, 'wayline': self.images})
        with self.assertRaises(ValueError):
            self.controller.resolve_images()

    def test_interrupted_file_removal_resumes_from_hash_journal(self):
        self.install()
        original = Path.unlink
        target = self.controller.paths(self.instance) / 'config/runner-token'
        def interrupted(path, *args, **kwargs):
            if path == target:
                raise OSError('simulated file removal interruption')
            return original(path, *args, **kwargs)
        operation = self.operation('remove')
        with patch.object(Path, 'unlink', interrupted):
            self.assertEqual(self.controller.execute(operation)['state'], 'error')
        self.assertFalse(self.containers)
        self.assertEqual(self.controller.execute(operation)['state'], 'absent')
        self.assertFalse((self.controller.instances / self.instance).exists())

    def route_body(self):
        return {'instance_id': self.instance, 'method': 'GET', 'path': '/api/v1/targets',
                'query': '', 'content_type': '', 'body': ''}

    def test_warm_route_has_zero_docker_and_zero_health_with_fresh_responses(self):
        self.install()
        self.calls.clear()
        request = self.route_body()
        sent = []
        def http(instance, obj, method, path, *args, **kwargs):
            self.assertEqual(path, request['path'])
            sent.append(path)
            return 200, 'application/json', json.dumps({'sequence': len(sent)}).encode()
        with patch.object(self.controller, 'http', side_effect=http):
            for sequence in range(1, 4):
                result = self.controller.request(request)
                self.assertEqual(json.loads(base64.b64decode(result['body'])), {'sequence': sequence})
        self.assertEqual(self.calls, [])
        self.assertEqual(len(sent), 3)

    def test_real_warm_http_uses_verified_route_without_docker(self):
        self.install()
        self.calls.clear()
        captured = []
        class Response:
            status = 200
            headers = types.SimpleNamespace(get_content_type=lambda: 'application/json')
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, maximum):
                return b'{"fresh":true}'
        def open_request(request, timeout):
            captured.append(request)
            return Response()
        native = types.MethodType(wl.WaylineController.http, self.controller)
        with patch.object(self.controller, 'http', native), \
             patch.object(wl.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_request)):
            result = self.controller.request(self.route_body())
        self.assertEqual(json.loads(base64.b64decode(result['body'])), {'fresh': True})
        self.assertEqual(self.calls, [])
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0].full_url, 'http://127.0.0.1:32100' + self.route_body()['path'])

    def test_expired_route_rechecks_drift_and_does_not_keep_old_route(self):
        self.install()
        checked = self.controller._routes[self.instance][0]
        self.calls.clear()
        with patch.object(wl.time, 'monotonic', return_value=checked + wl.ROUTE_MAX_AGE):
            self.assertEqual(self.controller.request(self.route_body())['status'], 200)
        self.assertTrue(self.calls)
        checked = self.controller._routes[self.instance][0]
        self.containers[self.controller.name(self.instance, '-gateway')]['HostConfig']['PortBindings']['8080/tcp'][0]['HostIp'] = '0.0.0.0'
        with patch.object(wl.time, 'monotonic', return_value=checked + wl.ROUTE_MAX_AGE + 1):
            with self.assertRaises(ValueError):
                self.controller.request(self.route_body())
        self.assertNotIn(self.instance, self.controller._routes)

    def test_health_failure_and_disable_immediately_revoke_warm_route(self):
        self.install()
        with patch.object(self.controller, 'http', return_value=(200, 'application/json', b'{}')):
            with self.assertRaises(ValueError):
                self.controller.get(self.instance)
        self.assertNotIn(self.instance, self.controller._routes)
        self.controller.get(self.instance)
        self.assertIn(self.instance, self.controller._routes)
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertNotIn(self.instance, self.controller._routes)
        with self.assertRaises(ValueError):
            self.controller.request(self.route_body())

    def test_native_connection_failure_revokes_route_without_replaying_mutation(self):
        self.install()
        request = self.route_body()
        request.update(method='POST', path='/api/v1/targets', content_type='application/json', body=base64.b64encode(b'{}').decode())
        with patch.object(self.controller, 'http', side_effect=OSError('native connection lost')) as native:
            with self.assertRaises(OSError):
                self.controller.request(request)
        self.assertEqual(native.call_count, 1)
        self.assertNotIn(self.instance, self.controller._routes)

    def test_routes_are_per_instance_and_new_controller_has_no_trusted_route(self):
        self.install()
        route = self.controller._routes[self.instance]
        foreign = str(uuid.uuid4())
        self.assertNotIn(foreign, self.controller._routes)
        with self.assertRaises(ValueError):
            self.controller.request({**self.route_body(), 'instance_id': foreign})
        self.assertIs(self.controller._routes[self.instance], route)
        other = wl.WaylineController(self.controller.parent)
        self.assertEqual(other._routes, {})

    def test_concurrent_cold_assets_share_one_full_refresh(self):
        self.install()
        self.controller._routes.clear()
        self.calls.clear()
        request = self.route_body()
        start = threading.Barrier(5)
        original_http = self.controller.http
        def http(instance, obj, method, path, *args, **kwargs):
            if path == request['path']:
                return 200, 'application/json', b'{}'
            return original_http(instance, obj, method, path, *args, **kwargs)
        def read():
            start.wait(5)
            return self.controller.request(request)
        with patch.object(self.controller, 'ready', wraps=self.controller.ready) as ready, \
             patch.object(self.controller, 'http', side_effect=http), ThreadPoolExecutor(max_workers=4) as pool:
            reads = [pool.submit(read) for _ in range(4)]
            start.wait(5)
            self.assertTrue(all(read.result(timeout=5)['status'] == 200 for read in reads))
        self.assertEqual(ready.call_count, 1)
        self.assertTrue(self.calls)

    def test_native_request_holds_instance_lock_and_releases_global_lock(self):
        self.install()
        request = self.route_body()
        entered, release = threading.Event(), threading.Event()
        def http(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError('Native request was not released')
            return 200, 'application/json', b'{}'
        with patch.object(self.controller, 'http', side_effect=http), ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.controller.request, request)
            try:
                self.assertTrue(entered.wait(3))
                with (self.controller.operations / ('instance-' + self.instance + '.lock')).open('rb') as probe:
                    with self.assertRaises(BlockingIOError):
                        wl.fcntl.flock(probe, wl.fcntl.LOCK_EX | wl.fcntl.LOCK_NB)
                with (self.root / 'modules/controller.lock').open('rb') as probe:
                    wl.fcntl.flock(probe, wl.fcntl.LOCK_EX | wl.fcntl.LOCK_NB)
                    wl.fcntl.flock(probe, wl.fcntl.LOCK_UN)
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=3)['status'], 200)

if __name__ == '__main__':
    unittest.main()
