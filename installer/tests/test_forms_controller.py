"""Owned Forms fixtures. Native compatibility and build gates execute separately in CI."""
import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import hmac
import importlib.util
import time
import json
import os
import re
from pathlib import Path
import tempfile
import threading
import types
import unittest
import uuid
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
forms = load('pl_forms_controller_test', BASE / 'forms-controller.py')
gateway = load('pl_forms_gateway_test', BASE.parent / 'apps/forms/gateway.py')


class FormsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('private', 'state', 'modules'):
            (self.root / name).mkdir(mode=0o700)
        self.installation = 'pl-123456abcdef'
        self.instance = str(uuid.uuid4())
        self.images = {}
        for index, role in enumerate(forms.ROLES):
            self.images[role] = {'id': 'sha256:' + str(index + 1) * 64, 'architecture': 'amd64',
                'ref': 'pl/forms-' + role + ':test', 'recipe': 'deploy/images/forms.Dockerfile',
                'labels': {'pl.module.id': 'forms', 'pl.module.role': role,
                    'pl.module.config.version': '1', 'org.opencontainers.image.version': '0.1.0',
                    'pl.build.variant': 'source-build' if role == 'adapter' else 'upstream-pinned'}}
        forms.atomic(self.root / 'state/installation.json', {'install_id': self.installation, 'manifest_sha256': 'a' * 64, 'config': {'public_url': 'https://pl.example'}})
        forms.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
            'manifest_sha256': 'a' * 64, 'forms': self.images})
        self.calls, self.containers, self.resources = [], {}, {'network': {}, 'volume': {}}
        gid = patch.object(forms, 'GID', os.getegid())
        gid.start()
        self.addCleanup(gid.stop)
        self.controller = forms.FormsController(types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker))
        forms.atomic(self.root / 'private/module-controller-key', b'm' * 32, mode=0o640)
        self.http_calls = []
        self.controller.http = self.http

    def image(self, role):
        return {'Id': self.images[role]['id'], 'Os': 'linux', 'Architecture': 'amd64', 'Config': {
            'Labels': self.images[role]['labels'], 'Entrypoint': ['/bin/fixture-' + role], 'Cmd': None,
            'User': '10001:10001', 'WorkingDir': '/', 'Env': ['FIXTURE=1']}}

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
                    obj['Containers'] = {v['Id']: {'Name': name, 'IPv4Address': v['NetworkSettings']['Networks'][args[-1]]['IPAddress'] + '/24'}
                                         for name, v in self.containers.items() if args[-1] in v['NetworkSettings']['Networks']}
                    for member_id, changes in getattr(self, 'member_overrides', {}).items():
                        obj['Containers'].setdefault(member_id, {}).update(changes)
                return json.dumps([obj]).encode()
            if action == 'create':
                labels = dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')
                self.resources[kind][args[-1]] = {'Name': args[-1], 'Driver': 'local' if kind == 'volume' else 'bridge',
                                                'Labels': labels, 'Options': {}, 'Scope': 'local', 'Internal': '--internal' in args, 'Ingress': False,
                                                'Id': hashlib.sha256(args[-1].encode()).hexdigest(),
                                                'IPAM': {'Config': [{'Subnet': '172.28.0.0/24', 'Gateway': '172.28.0.1'}]}}
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
                if '--env' in args:
                    role = 'engine-bootstrap'
                name = args[args.index('--name') + 1]
                labels = dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')
                config = copy.deepcopy(self.image('engine' if role == 'engine-bootstrap' else role)['Config'])
                if role == 'engine-bootstrap':
                    config['Env'].append('PL_FORMS_BOOTSTRAP=1')
                config.update(Image=args[-1], Labels=labels)
                mounts = []
                for index, arg in enumerate(args):
                    if arg != '--mount':
                        continue
                    fields = dict(part.split('=', 1) if '=' in part else (part, True) for part in args[index + 1].split(','))
                    mounts.append({'Type': fields['type'], 'Name': fields['source'] if fields['type'] == 'volume' else '',
                                   'Source': fields['source'], 'Destination': fields['target'], 'RW': not fields.get('readonly', False)})
                ports = {'8091/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]} if '--publish' in args else {}
                self.containers[name] = {'Name': '/' + name, 'Id': str(len(self.containers) + 1) * 64, 'Image': args[-1], 'Config': config,
                    'Mounts': mounts, 'State': {'Running': False}, 'HostConfig': {
                        'PortBindings': ports, 'ReadonlyRootfs': True, 'CapDrop': ['ALL'], 'CapAdd': [],
                        'NetworkMode': self.controller.name(self.instance, '-net'), 'Memory': forms.MEMORY[role] * 1024**2,
                        'NanoCpus': forms.CPUS[role], 'PidsLimit': forms.PIDS[role], 'Init': True, 'SecurityOpt': ['no-new-privileges'],
                        'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}},
                        'RestartPolicy': {'Name': 'unless-stopped'}, 'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777'}},
                    'NetworkSettings': {'Networks': {self.controller.name(self.instance, '-net'): {
                        'NetworkID': self.resources['network'][self.controller.name(self.instance, '-net')]['Id'],
                        'IPAddress': '172.28.0.' + str(10 + forms.ALL_ROLES.index(role)), 'Gateway': '172.28.0.1'}},
                        # Docker leaves publication dormant on an Internal-only bridge.
                        'Ports': {'8091/tcp': None} if ports else {}}}
                return self.containers[name]['Id'].encode()
            if action == 'exec':
                self.assertIn('Engine().bootstrap()', args[-1])
                return b''
            if action in ('start', 'stop', 'rm'):
                name = next(k for k, v in self.containers.items() if v['Id'] == args[-1])
                if action == 'rm':
                    del self.containers[name]
                else:
                    self.containers[name]['State']['Running'] = action == 'start'
                return b''
        raise AssertionError('Unexpected Docker invocation')

    def http(self, instance, obj, method, path, raw=b'', headers=None, *, origin=None):
        self.http_calls.append((method, path, raw, headers))
        value = {'status': 'ready', 'database': 'ok', 'engine': 'connected', 'version': '0.1.0'} if path == '/ready' else {'ok': True}
        return 200, 'application/json', json.dumps(value).encode()

    def operation(self, action, operation=None):
        return {'operation_id': operation or str(uuid.uuid4()), 'instance_id': self.instance, 'module_id': 'forms', 'action': action}

    def install(self):
        result = self.controller.execute(self.operation('install'))
        self.assertEqual(result['state'], 'running')
        return result

    def body(self, method='GET', path='/forms/api/v1/context', admin=False):
        write = method not in ('GET', 'HEAD')
        raw = b'{}' if write else b''
        token = forms.b64(b'c' * 32)
        idem = str(uuid.uuid4()) if write else ''
        scope = forms.request_scope(method, path, '', 'application/json' if write else '', raw, True, idem)
        now = int(time.time())
        claims = {'v': 2, 'aud': 'forms', 'iat': now, 'exp': now + 20, 'nonce': forms.b64(os.urandom(32)),
                  'sub': 'user1', 'name': 'Пользователь', 'admin': admin, 'scopes': [scope], 'method': method,
                  'uri': path, 'content_type': 'application/json' if write else '', 'body_sha256': hashlib.sha256(raw).hexdigest(),
                  'idempotency_key': idem, 'source_ip': '127.0.0.1', 'csrf_token': token, 'csrf_verified': write}
        assertion = forms.b64(json.dumps(claims, separators=(',', ':'), ensure_ascii=False).encode())
        signature = forms.b64(hmac.digest(self.controller.gateway_key(self.instance), b'pl-gateway-v2\n' + assertion.encode(), 'sha256'))
        headers = {'X-PL-Gateway-Assertion': assertion, 'X-PL-Gateway-Signature': signature}
        if write:
            headers.update({'X-CSRF-Token': token, 'Idempotency-Key': idem})
        return {'instance_id': self.instance, 'method': method, 'path': path, 'query': '',
                'content_type': claims['content_type'], 'body': base64.b64encode(raw).decode(), 'headers': headers}

    def test_network_capacity_error_is_public_and_other_errors_remain_generic(self):
        class Capacity(ValueError):
            public_code = 'module_network_pool_exhausted'
        for error, capacity in ((Capacity('private details'), True), (ValueError('private details'), False)):
            with self.subTest(capacity=capacity), patch.object(forms._files, 'module_network_args', side_effect=error):
                result = self.controller.execute(self.operation('install'))
            self.assertEqual(result['state'], 'error')
            self.assertEqual('module_network_pool_exhausted' in result['error'], capacity)
            self.assertNotIn('private details', result['error'])
            self.assertFalse(self.containers)

    def test_new_service_password_satisfies_pinned_heyform_signup_policy(self):
        # Exact meaningful constraints from v3.0.5 compiled SignUpInput:
        # Length(8,100), uppercase+lowercase+digit, restricted ASCII alphabet.
        policy = re.compile(r'(?=.{8,100}\Z)(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[!#$%&()*+,\-./\\:<=>?@\[\]^_{|}~0-9a-zA-Z]+')
        self.assertIsNone(policy.fullmatch('a1' * 32))
        # Even an all-digit random suffix must satisfy every character class.
        with patch.object(forms.secrets, 'token_hex', side_effect=lambda size: '0' * (size * 2)):
            self.controller.initialize(self.instance)
        state = self.controller.state(self.instance)
        password = state['service']['password']
        self.assertEqual(len(password), 64)
        self.assertIsNotNone(policy.fullmatch(password))
        for key in ('session_key', 'encryption_key', 'keydb_password'):
            self.assertRegex(state[key], r'^[0-9a-f]{64}$')
        self.assertEqual(json.loads((self.controller.paths(self.instance) / 'config/forms-service.json').read_text())['password'], password)

    def test_existing_legacy_service_password_is_not_rotated(self):
        self.controller.initialize(self.instance)
        state = self.controller.state(self.instance)
        # Legacy 64-hex passwords remain valid for LoginInput and existing users.
        state['service']['password'] = 'a1' * 32
        for bootstrapped in (False, True):
            state['bootstrapped'] = bootstrapped
            forms.atomic(self.controller.paths(self.instance) / 'state.json', state)
            config = self.controller.paths(self.instance) / 'config/forms-service.json'
            forms.atomic(config, forms.encoded(state['service']), mode=0o440)
            os.chown(config, -1, forms.GID)
            with patch.object(forms.secrets, 'token_hex', side_effect=AssertionError('existing credentials must not be regenerated')):
                self.controller.initialize(self.instance)
            self.assertEqual(self.controller.state(self.instance), state)

    def test_private_service_password_rejects_unrecognized_storage_formats(self):
        self.controller.initialize(self.instance)
        original = self.controller.state(self.instance)
        for password in ('a1' * 31, 'Pl1-' + 'a' * 59, 'pl1-' + 'a' * 60, 'Pl1-' + 'z' * 60):
            with self.subTest(length=len(password)):
                state = copy.deepcopy(original)
                state['service']['password'] = password
                with self.assertRaises(ValueError):
                    self.controller.validate_state(state, self.instance)

    def test_install_bootstraps_once_and_never_observes_secrets(self):
        operation = self.operation('install')
        result = self.controller.execute(operation)
        self.assertEqual(result['state'], 'running')
        state = self.controller.state(self.instance)
        for key in ('gateway_key', 'session_key', 'keydb_password', 'encryption_key'):
            self.assertNotIn(state[key], json.dumps(result))
        self.assertNotIn(state['service']['password'], str(self.calls))
        self.assertEqual(self.controller.execute(operation), result)
        self.install()
        self.assertEqual(len(self.containers), 4)
        self.assertEqual(len(self.resources['volume']), 5)
        self.assertEqual(sum(call[:2] == ('container', 'exec') for call in self.calls), 1)
        self.assertTrue(all('PL_FORMS_BOOTSTRAP=1' not in obj['Config']['Env'] for obj in self.containers.values()))
        creates = [call for call in self.calls if call[:2] == ('container', 'create')]
        self.assertEqual(sum('--publish' in call for call in creates), 0)
        self.assertEqual(self.controller.endpoint(self.instance, self.controller.inspect(self.instance, 'adapter')), 'http://172.28.0.13:8091')
        self.assertTrue(all(obj['Internal'] for obj in self.resources['network'].values()))

    def test_owned_internal_adapter_endpoint_ignores_dormant_legacy_publication(self):
        self.install()
        before = self.controller.state(self.instance)
        adapter = self.containers[self.controller.name(self.instance, '-adapter')]
        adapter['HostConfig']['PortBindings'] = {'8091/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]}
        adapter['NetworkSettings']['Ports'] = {'8091/tcp': None}
        for actual in (None, [{'HostIp': '127.0.0.1', 'HostPort': '32100'}]):
            adapter['NetworkSettings']['Ports']['8091/tcp'] = actual
            self.assertEqual(self.controller.get(self.instance)['endpoint'], 'http://172.28.0.13:8091')
        count = len(self.calls)
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'running')
        self.assertEqual(self.controller.state(self.instance), before)
        self.assertFalse(any(call[:2] == ('container', 'create') for call in self.calls[count:]))
        self.assertFalse(any(call[:2] == ('network', 'connect') for call in self.calls))
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')
        self.assertFalse(any(self.resources.values()))

    def test_endpoint_rejects_foreign_network_id_membership_and_reserved_addresses(self):
        self.install()
        adapter = self.containers[self.controller.name(self.instance, '-adapter')]
        network_name = self.controller.name(self.instance, '-net')
        original = copy.deepcopy(adapter['NetworkSettings']['Networks'])
        for address in ('127.0.0.1', '169.254.1.2', '0.0.0.0', '8.8.8.8', '172.28.0.1', '172.28.0.0', '172.28.0.255', '172.29.0.13', '172.028.0.13'):
            with self.subTest(address=address):
                adapter['NetworkSettings']['Networks'] = copy.deepcopy(original)
                adapter['NetworkSettings']['Networks'][network_name]['IPAddress'] = address
                with self.assertRaises(ValueError):
                    self.controller.endpoint(self.instance, adapter)
        adapter['NetworkSettings']['Networks'] = copy.deepcopy(original)
        adapter['NetworkSettings']['Networks'][network_name]['NetworkID'] = 'f' * 64
        with self.assertRaises(ValueError):
            self.controller.endpoint(self.instance, adapter)
        adapter['NetworkSettings']['Networks'] = copy.deepcopy(original)
        self.member_overrides = {adapter['Id']: {'IPv4Address': '172.28.0.99/24'}}
        with self.assertRaises(ValueError):
            self.controller.endpoint(self.instance, adapter)
        self.member_overrides = {adapter['Id']: {'Name': 'foreign-container'}}
        with self.assertRaises(ValueError):
            self.controller.endpoint(self.instance, adapter)

    def test_endpoint_and_ports_cannot_select_another_service_or_lan_binding(self):
        self.install()
        for role in ('mongo', 'keydb', 'engine'):
            with self.subTest(role=role), self.assertRaises(ValueError):
                self.controller.endpoint(self.instance, self.controller.inspect(self.instance, role))
        adapter = self.containers[self.controller.name(self.instance, '-adapter')]
        for requested, actual in (
                ({'8091/tcp': [{'HostIp': '0.0.0.0', 'HostPort': ''}]}, {'8091/tcp': None}),
                ({'8091/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]}, {'8091/tcp': [{'HostIp': '192.168.1.2', 'HostPort': '32100'}]}),
                ({'8092/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]}, {}),
                ({}, {'8091/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '32100'}]})):
            with self.subTest(requested=requested, actual=actual):
                adapter['HostConfig']['PortBindings'] = requested
                adapter['NetworkSettings']['Ports'] = actual
                with self.assertRaises(ValueError):
                    self.controller.inspect(self.instance, 'adapter')

    def test_backend_network_policy_drift_is_never_converted(self):
        self.install()
        network = self.resources['network'][self.controller.name(self.instance, '-net')]
        network['Internal'] = False
        count = len(self.calls)
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'error')
        self.assertFalse(network['Internal'])
        self.assertFalse(any(call[:2] in (('network', 'rm'), ('network', 'create'), ('network', 'connect')) for call in self.calls[count:]))

    def test_disable_preserves_private_state_and_remove_only_owned_resources(self):
        self.install()
        before = self.controller.state(self.instance)
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertEqual(len(self.resources['volume']), 5)
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'running')
        self.assertEqual(self.controller.state(self.instance), before)
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')
        self.assertEqual(self.containers, {})
        self.assertFalse(any(self.resources.values()))
        self.assertFalse((self.controller.instances / self.instance).exists())

    def test_mongo_unset_image_working_dir_accepts_docker_root_and_removes(self):
        self.install()
        original_image = self.image
        def image(role):
            value = original_image(role)
            if role == 'mongo':
                value['Config']['WorkingDir'] = ''
            return value
        self.image = image
        # Docker's unset root defaults must not block lifecycle reconciliation.
        mongo = self.containers[self.controller.name(self.instance, '-mongo')]
        self.assertEqual(mongo['Config']['WorkingDir'], '/')
        self.assertEqual(self.controller.get(self.instance)['state'], 'running')
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')
        self.assertEqual(self.containers, {})
        self.assertFalse(any(self.resources.values()))

    def test_all_docker_unset_root_working_dir_representations_are_equivalent(self):
        self.install()
        original_image = self.image
        mongo = self.containers[self.controller.name(self.instance, '-mongo')]
        missing = object()
        for expected in (missing, None, '', '/'):
            for actual in (missing, None, '', '/'):
                with self.subTest(image='absent' if expected is missing else expected,
                                  container='absent' if actual is missing else actual):
                    def image(role):
                        value = original_image(role)
                        if role == 'mongo':
                            if expected is missing:
                                value['Config'].pop('WorkingDir', None)
                            else:
                                value['Config']['WorkingDir'] = expected
                        return value
                    self.image = image
                    if actual is missing:
                        mongo['Config'].pop('WorkingDir', None)
                    else:
                        mongo['Config']['WorkingDir'] = actual
                    self.assertIsNotNone(self.controller.inspect(self.instance, 'mongo'))
        # The observed native failure: image has no WorkingDir key, container ''.
        def image(role):
            value = original_image(role)
            if role == 'mongo':
                value['Config'].pop('WorkingDir', None)
            return value
        self.image = image
        mongo['Config']['WorkingDir'] = ''
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')

    def test_working_dir_equivalence_rejects_nonroot_path_and_type_drift(self):
        self.install()
        original_image = self.image
        mongo = self.containers[self.controller.name(self.instance, '-mongo')]
        cases = [('', '/tmp'), (None, '/./'), ('', '//'), ('/app', '/'),
                 ('/app', '/app/'), ('/app', '/other'), ('/app', None)]
        for malformed in (False, True, 0, 1, 1.5, [], {}):
            cases += [(None, malformed), (malformed, '/'), (malformed, malformed)]
        for expected, actual in cases:
            with self.subTest(image=expected, container=actual):
                def image(role):
                    value = original_image(role)
                    if role == 'mongo':
                        value['Config']['WorkingDir'] = expected
                    return value
                self.image = image
                mongo['Config']['WorkingDir'] = actual
                with self.assertRaisesRegex(ValueError, 'container drift'):
                    self.controller.inspect(self.instance, 'mongo')

    def test_identical_explicit_nonroot_working_dir_remains_valid(self):
        self.install()
        original_image = self.image
        def image(role):
            value = original_image(role)
            if role == 'mongo':
                value['Config']['WorkingDir'] = '/app'
            return value
        self.image = image
        self.containers[self.controller.name(self.instance, '-mongo')]['Config']['WorkingDir'] = '/app'
        self.assertIsNotNone(self.controller.inspect(self.instance, 'mongo'))

    def test_root_working_dir_equivalence_keeps_other_container_constraints(self):
        self.install()
        original_image = self.image
        def image(role):
            value = original_image(role)
            if role == 'mongo':
                value['Config']['WorkingDir'] = ''
            return value
        self.image = image
        mongo = self.containers[self.controller.name(self.instance, '-mongo')]
        for section, field, unexpected in (('Config', 'Entrypoint', ['/bin/sh']),
                                           ('Config', 'Cmd', ['other-command']),
                                           ('Config', 'User', '0:0'),
                                           ('HostConfig', 'ReadonlyRootfs', False)):
            with self.subTest(field=field):
                previous = mongo[section].get(field)
                mongo[section][field] = unexpected
                with self.assertRaisesRegex(ValueError, 'container drift'):
                    self.controller.inspect(self.instance, 'mongo')
                mongo[section][field] = previous

    def test_owned_drift_prevents_remove_and_preserves_data(self):
        self.install()
        obj = self.containers[self.controller.name(self.instance, '-engine')]
        obj['Config']['Env'].append('APP_DISABLE_REGISTRATION=false')
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertEqual(len(self.containers), 4)
        self.assertEqual(len(self.resources['volume']), 5)

    def test_native_health_failure_cannot_be_reported_running(self):
        self.install()
        self.controller.http = lambda *args: (200, 'application/json', b'{"status":"ok"}')
        with self.assertRaises(ValueError):
            self.controller.get(self.instance)

    def test_ready_reads_each_docker_object_once_and_discards_the_snapshot(self):
        self.install()
        self.calls.clear()
        self.controller.ready(self.instance)
        self.assertEqual(len(self.calls), len(set(self.calls)))
        volume = self.resources['volume'][self.controller.resource_name(self.instance, 'volume', 'adapter')]
        original = volume['Labels']['pl.installation']
        volume['Labels']['pl.installation'] = 'foreign'
        with self.assertRaises(ValueError):
            self.controller.ready(self.instance)
        self.assertNotIn(self.instance, self.controller._routes)
        volume['Labels']['pl.installation'] = original
        self.controller.ready(self.instance)
        self.assertIn(self.instance, self.controller._routes)

    def test_warm_page_requests_do_not_query_docker_and_health_revokes_drift(self):
        self.install()
        self.calls.clear()
        self.assertEqual(self.controller.request(self.body())['status'], 200)
        self.assertEqual(self.calls, [])
        self.resources['network'][self.controller.name(self.instance, '-net')]['Internal'] = False
        with self.assertRaises(ValueError):
            self.controller.get(self.instance)
        self.assertNotIn(self.instance, self.controller._routes)
        with self.assertRaises(ValueError):
            self.controller.request(self.body())

    def test_expired_routes_recheck_ownership_and_lifecycle_clears_routes(self):
        self.install()
        checked = self.controller._routes[self.instance][0]
        self.calls.clear()
        with patch.object(forms.time, 'monotonic', return_value=checked + forms.ROUTE_MAX_AGE + 1):
            self.assertEqual(self.controller.request(self.body())['status'], 200)
        self.assertTrue(self.calls)
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertNotIn(self.instance, self.controller._routes)
        with self.assertRaises(ValueError):
            self.controller.request(self.body())

    def test_failed_native_connection_discards_route_without_replaying_request(self):
        self.install()
        with patch.object(self.controller, 'http', side_effect=OSError('native connection lost')) as transport:
            with self.assertRaises(OSError):
                self.controller.request(self.body())
        self.assertEqual(transport.call_count, 1)
        self.assertNotIn(self.instance, self.controller._routes)

    def test_observation_and_gateway_readiness_overlap_but_writer_waits_for_both(self):
        self.install()
        self.controller._routes.clear()  # Exercise cold admission, not the established HTTP route.
        body = self.body()
        original_http = self.controller.http
        entered = [threading.Event(), threading.Event()]
        release = [threading.Event(), threading.Event()]
        writer_started, writer_entered = threading.Event(), threading.Event()
        reader = threading.local()

        def http(*args, **kwargs):
            if args[3] == '/ready':
                index = reader.index
                entered[index].set()
                if not release[index].wait(5):
                    raise TimeoutError('Read readiness was not released')
            return original_http(*args, **kwargs)

        def read(index):
            reader.index = index
            return self.controller.get(self.instance) if index == 0 else self.controller.request(body)

        def writer():
            writer_started.set()
            with self.controller.locked():
                writer_entered.set()

        with patch.object(self.controller, 'http', side_effect=http), ThreadPoolExecutor(max_workers=3) as pool:
            reads = [pool.submit(read, index) for index in range(2)]
            try:
                self.assertTrue(all(event.wait(3) for event in entered), 'Reads serialized during readiness')
                pending_writer = pool.submit(writer)
                self.assertTrue(writer_started.wait(3))
                with (self.root / 'modules/controller.lock').open('rb') as probe:
                    with self.assertRaises(BlockingIOError):
                        forms.fcntl.flock(probe, forms.fcntl.LOCK_EX | forms.fcntl.LOCK_NB)
                self.assertFalse(writer_entered.is_set())
                release[0].set()
                self.assertEqual(reads[0].result(timeout=3)['state'], 'running')
                with (self.root / 'modules/controller.lock').open('rb') as probe:
                    with self.assertRaises(BlockingIOError):
                        forms.fcntl.flock(probe, forms.fcntl.LOCK_EX | forms.fcntl.LOCK_NB)
                self.assertFalse(writer_entered.is_set(), 'Writer bypassed the remaining reader')
                release[1].set()
                self.assertEqual(reads[1].result(timeout=3)['status'], 200)
                pending_writer.result(timeout=3)
                self.assertTrue(writer_entered.is_set())
            finally:
                for event in release:
                    event.set()

    def test_exclusive_lifecycle_lock_blocks_observation_and_gateway_readiness(self):
        self.install()
        self.controller._routes.clear()
        body = self.body()
        lock_stat = (self.root / 'modules/controller.lock').stat()
        attempted = threading.Barrier(3)
        real_flock = forms.fcntl.flock

        def flock(stream, operation):
            stat = os.fstat(stream if isinstance(stream, int) else stream.fileno())
            if (stat.st_dev, stat.st_ino) == (lock_stat.st_dev, lock_stat.st_ino):
                attempted.wait(3)
            return real_flock(stream, operation)

        with ThreadPoolExecutor(max_workers=2) as pool:
            with self.controller.locked():
                with patch.object(forms.fcntl, 'flock', side_effect=flock):
                    reads = [pool.submit(self.controller.get, self.instance), pool.submit(self.controller.request, body)]
                    attempted.wait(3)
                    self.assertTrue(all(not read.done() for read in reads))
            self.assertEqual(reads[0].result(timeout=3)['state'], 'running')
            self.assertEqual(reads[1].result(timeout=3)['status'], 200)

    def test_gateway_retains_instance_lock_but_releases_global_lock_during_native_request(self):
        self.install()
        body = self.body()
        original_http = self.controller.http
        entered, release = threading.Event(), threading.Event()

        def http(*args, **kwargs):
            if args[3] == body['path']:
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('Native request was not released')
            return original_http(*args, **kwargs)

        with patch.object(self.controller, 'http', side_effect=http), ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.controller.request, body)
            try:
                self.assertTrue(entered.wait(3))
                with (self.controller.operations / ('instance-' + self.instance + '.lock')).open('rb') as probe:
                    with self.assertRaises(BlockingIOError):
                        forms.fcntl.flock(probe, forms.fcntl.LOCK_EX | forms.fcntl.LOCK_NB)
                with (self.root / 'modules/controller.lock').open('rb') as probe:
                    forms.fcntl.flock(probe, forms.fcntl.LOCK_EX | forms.fcntl.LOCK_NB)
                release.set()
                self.assertEqual(pending.result(timeout=3)['status'], 200)
            finally:
                release.set()

    def test_public_origin_must_match_installation(self):
        with self.assertRaises(ValueError):
            self.controller.execute({**self.operation('install'), 'public_url': 'https://other.example'})
        self.assertEqual(self.controller.execute({**self.operation('install'), 'public_url': 'https://pl.example'})['state'], 'running')
        self.assertEqual(self.controller.state(self.instance)['public_url'], 'https://pl.example')

    def test_operation_identity_conflict(self):
        operation = self.operation('install')
        self.controller.execute(operation)
        with self.assertRaises(ValueError):
            self.controller.execute({**operation, 'action': 'remove'})

    def test_signed_transport_matches_native_verifier_and_exact_idempotency(self):
        self.install()
        expected_key = hmac.digest(b'm' * 32, ('pl-module-key-v1\nforms\n' + self.instance).encode(), 'sha256')
        self.assertEqual(bytes.fromhex(self.controller.state(self.instance)['gateway_key']), expected_key)
        for body in (self.body(), self.body('POST', '/forms/api/v1/surveys/test1/responses'),
                     self.body('POST', '/forms/api/v1/surveys', True)):
            self.controller.request(body)
            method, path, raw, headers = self.http_calls[-1]
            scope = {'method': method, 'raw_path': path.encode(), 'query_string': b'',
                     'headers': [(key.lower().encode(), value.encode('latin1')) for key, value in headers.items()]}
            verifier = gateway.GatewayVerifier(expected_key)
            required = forms.request_scope(method, path, '', body['content_type'], raw, True, body['headers'].get('Idempotency-Key', ''))
            claims = verifier.verify(scope, raw, required_scope=required)
            self.assertEqual(claims['idempotency_key'], body['headers'].get('Idempotency-Key', ''))
            self.assertEqual(claims['sub'], 'user1')
            for key, value in body['headers'].items():
                self.assertEqual(headers[key], value)
            self.assertNotIn('Cookie', headers)
            self.assertNotIn('Authorization', headers)
            if method == 'POST':
                with self.assertRaises(gateway.GatewayError):
                    verifier.verify(scope, raw, required_scope=required)

    def test_native_adapter_rejects_nonadmin_signature_for_admin_write(self):
        self.install()
        body = self.body('POST', '/forms/api/v1/surveys', False)
        self.controller.request(body)
        method, path, raw, headers = self.http_calls[-1]
        scope = {'method': method, 'raw_path': path.encode(), 'query_string': b'',
                 'headers': [(key.lower().encode(), value.encode('latin1')) for key, value in headers.items()]}
        with self.assertRaises(gateway.GatewayError):
            gateway.GatewayVerifier(self.controller.gateway_key(self.instance)).verify(scope, raw, required_scope='forms:admin')

    def test_request_route_headers_and_body_boundary(self):
        self.install()
        good = self.body()
        cases = [{'path': '/ready'}, {'path': '/forms/%2e%2e/secrets'}, {'path': '/graphql'},
                 {'query': 'token=x'}, {'Cookie': 'browser'}, {'body': 'e30='},
                 {'headers': {**good['headers'], 'Cookie': 'browser'}},
                 {'headers': {'X-PL-Gateway-Assertion': 'x'}},
                 {'headers': {**good['headers'], 'X-CSRF-Token': 'x'}}]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.controller.request({**good, **change})
        mutation = self.body('POST', '/forms/api/v1/surveys', True)
        for change in ({'headers': {**mutation['headers'], 'Idempotency-Key': ''}},
                       {'content_type': 'text/plain'}, {'body': base64.b64encode(b'[]').decode()}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.controller.request({**mutation, **change})
