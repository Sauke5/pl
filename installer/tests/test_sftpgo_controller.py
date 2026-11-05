"""Owned orchestration fixtures; real native/SFTP acceptance runs separately in CI."""
import base64
import copy
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import MagicMock, patch

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pl_sftpgo_test', BASE / 'sftpgo-controller.py')
sg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sg)


class SFTPGoTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        for name in ('private', 'state', 'modules'):
            (self.root / name).mkdir(mode=0o700)
        self.installation = 'pl-123456abcdef'
        self.instance = str(uuid.uuid4())
        self.image = {'id': 'sha256:' + '1' * 64, 'architecture': 'amd64', 'ref': 'pl/sftpgo:fixture', 'recipe': 'deploy/images/sftpgo.Dockerfile', 'labels': {
            'org.opencontainers.image.version': '2.7.6', 'pl.module.id': 'sftpgo', 'pl.module.role': 'server', 'pl.module.config.version': '1', 'pl.build.variant': 'upstream-pinned'}}
        sg.atomic(self.root / 'state/installation.json', {'install_id': self.installation, 'manifest_sha256': 'a' * 64})
        sg.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation, 'manifest_sha256': 'a' * 64, 'sftpgo': {'server': self.image}})
        gid = patch.object(sg, 'GID', os.getegid()); gid.start(); self.addCleanup(gid.stop)
        self.calls, self.containers, self.resources = [], {}, {'network': {}, 'volume': {}}
        self.controller = sg.SFTPGoController(types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker))
        self.controller.initial_listener = lambda: {'listen_ip': '127.0.0.1', 'port': 2022}
        self.controller.preflight = lambda *args: None
        self.controller.http = self.http
        self.http_calls = []
        self.users, self.groups, self.folders = {}, {}, {}
        self.actor = {'subject': 'local:employee', 'admin': False, 'session_key': 'b' * 64}

    def image_info(self):
        return {'Id': self.image['id'], 'Architecture': 'amd64', 'Os': 'linux', 'Config': {
            'Labels': self.image['labels'], 'User': '1000:1000', 'Env': ['FIXTURE=1'], 'WorkingDir': '/var/lib/sftpgo', 'Cmd': sg.COMMAND, 'Entrypoint': ['/usr/local/bin/sftpgo']}}

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        kind, action = args[:2]
        if kind == 'image':
            return json.dumps([self.image_info()]).encode()
        if kind in ('network', 'volume'):
            if action == 'ls':
                name = args[3].removeprefix('name=^').removesuffix('$')
                return name.encode() if name in self.resources[kind] else b''
            if action == 'inspect':
                obj = copy.deepcopy(self.resources[kind][args[-1]])
                if kind == 'network':
                    obj['Containers'] = {v['Id']: {'Name': k} for k, v in self.containers.items() if args[-1] in v.get('NetworkSettings', {}).get('Networks', {})}
                return json.dumps([obj]).encode()
            if action == 'create':
                labels = dict(args[i+1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')
                self.resources[kind][args[-1]] = {'Name': args[-1], 'Driver': 'bridge' if kind == 'network' else 'local', 'Options': {}, 'Labels': labels, 'Internal': '--internal' in args, 'Scope': 'local', 'Ingress': False}
                return b''
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
                name = args[args.index('--name') + 1]
                labels = dict(args[i+1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')
                ports = {}; mounts = []
                for i, arg in enumerate(args):
                    if arg == '--publish':
                        host, port, inside = args[i+1].split(':')
                        ports[inside + '/tcp'] = [{'HostIp': host, 'HostPort': port}]
                    if arg == '--mount':
                        fields = dict(value.split('=', 1) if '=' in value else (value, True) for value in args[i+1].split(','))
                        mounts.append({'Type': fields['type'], 'Name': fields['source'] if fields['type'] == 'volume' else '', 'Source': fields['source'], 'Destination': fields['target'], 'RW': not fields.get('readonly', False)})
                config = copy.deepcopy(self.image_info()['Config']); config.update(Image=self.image['id'], Labels=labels)
                published = {port: None for port in ports}
                self.containers[name] = {'Id': 'f' * 64, 'Image': self.image['id'], 'Config': config, 'State': {'Running': False}, 'Mounts': mounts,
                    'HostConfig': {'PortBindings': ports, 'ReadonlyRootfs': True, 'CapDrop': ['ALL'], 'NetworkMode': self.controller.names(self.instance, '-net'), 'Memory': 512*1024**2, 'NanoCpus': 1_000_000_000, 'PidsLimit': 128, 'Init': True, 'RestartPolicy': {'Name': 'unless-stopped'}, 'SecurityOpt': ['no-new-privileges'], 'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777'}, 'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}},
                    'NetworkSettings': {'Networks': {self.controller.names(self.instance, '-net'): {}}, 'Ports': published}}
                return b'f' * 64
            if action in ('start', 'stop', 'rm'):
                name = next(k for k, v in self.containers.items() if v['Id'] == args[-1])
                if action == 'rm':
                    del self.containers[name]
                else:
                    obj = self.containers[name]
                    obj['State']['Running'] = action == 'start'
                    network = self.resources['network'][obj['HostConfig']['NetworkMode']]
                    if action == 'start' and not network['Internal']:
                        published = copy.deepcopy(obj['HostConfig']['PortBindings'])
                        for bindings in published.values():
                            for binding in bindings:
                                if not binding['HostPort']:
                                    binding['HostPort'] = '32500'
                        obj['NetworkSettings']['Ports'] = published
                    else:
                        # Paired Docker evidence: internal bridge accepts the
                        # publish configuration but running Ports remain null.
                        obj['NetworkSettings']['Ports'] = {port: None for port in obj['HostConfig']['PortBindings']}
                return b''
        raise AssertionError('Unexpected Docker operation')

    def http(self, instance, method, path, payload=None, headers=None, user=False, *, origin=None):
        obj = self.containers.get(self.controller.names(instance))
        if not obj or not obj.get('State', {}).get('Running'):
            raise ValueError('Fixture SFTPGo is not running')
        self.assertEqual(origin or self.controller.route(instance)[2], self.controller.endpoint(obj))
        self.http_calls.append((method, path, payload, headers, user))
        if path in ('/token', '/user/token'):
            return {'access_token': 'fixture-native-token-' + str(uuid.uuid4())}
        if path == '/version':
            return {'version': '2.7.6'}
        if path == '/status':
            return {'data_provider': {'is_active': True}, 'ssh': {'is_active': True}}
        if path == '/user/logout':
            return {}
        if path.startswith('/user/dirs'):
            return [{'name': 'data.txt', 'size': 12, 'mode': 420, 'last_modified': '2026-10-26T12:00:00Z'}] if method == 'GET' else {}
        if path.startswith('/user/'):
            return {}
        kind, _, object_name = path.lstrip('/').partition('/')
        table = {'users': self.users, 'groups': self.groups, 'folders': self.folders}.get(kind.split('?')[0])
        if table is None:
            raise AssertionError('Unexpected native route')
        if method == 'GET':
            if not object_name:
                return list(table.values())
            if object_name not in table:
                raise sg.NativeError(404)
            return copy.deepcopy(table[object_name])
        if method in ('POST', 'PUT'):
            key = payload.get('username', payload.get('name'))
            if method == 'POST' and key in table:
                raise sg.NativeError(409)
            value = copy.deepcopy(payload)
            if kind == 'users':
                value['has_password'] = 'password' in value or table.get(key, {}).get('has_password', False)
                value.pop('password', None)
            table[key] = value
            return {}
        if method == 'DELETE':
            table.pop(object_name, None)
            return {}
        raise AssertionError('Unexpected native method')

    def operation(self, action, **extra):
        return {'operation_id': str(uuid.uuid4()), 'instance_id': self.instance, 'module_id': 'sftpgo', 'action': action, **extra}

    def install(self):
        result = self.controller.execute(self.operation('install'))
        self.assertEqual(result['state'], 'running')
        return result

    def request(self, action, payload=None, admin=True, actor=None):
        return self.controller.request({'instance_id': self.instance, 'action': action, 'actor': actor or {**self.actor, 'admin': admin}, 'payload': payload or {}})

    def user(self):
        return {'username': 'alice', 'description': 'User', 'enabled': True, 'password_enabled': True, 'public_key_enabled': False, 'password': 'native-password', 'public_keys': [], 'permissions': {'/': ['list', 'download', 'upload']}, 'groups': [], 'virtual_folders': [], **{key: 0 for key in sg.LIMITS}}

    def test_warm_file_api_does_not_inspect_or_probe_and_status_stays_live(self):
        from email.message import Message
        self.install()
        self.assertEqual(self.request('client-login', {'username': 'alice', 'password': 'native-password'}, admin=False)['status'], 200)
        self.controller.http = sg.SFTPGoController.http.__get__(self.controller)
        observed = []
        class Response(io.BytesIO):
            status = 200
            def __init__(self, data):
                super().__init__(json.dumps(data).encode())
                self.headers = Message(); self.headers['Content-Type'] = 'application/json'
        def serve(request, timeout):
            path = sg.urllib.parse.urlsplit(request.full_url).path
            observed.append(path)
            if path.endswith('/version'):
                return Response({'version': '2.7.6'})
            if path.endswith('/status'):
                return Response({'data_provider': {'is_active': True}, 'ssh': {'is_active': True}})
            self.assertTrue(request.get_header('Authorization').startswith('Bearer '))
            return Response([{'name': 'file-' + str(len(observed)) + '.txt', 'mode': 420, 'size': len(observed)}])
        self.calls.clear()
        with patch.object(sg.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=serve)):
            one = self.request('files-list', {'path': '/'}, admin=False)
            two = self.request('files-list', {'path': '/'}, admin=False)
            self.assertEqual(one['status'], 200); self.assertEqual(two['status'], 200)
            self.assertNotEqual(one['body']['entries'], two['body']['entries'])
            self.assertEqual(observed, ['/api/v2/user/dirs', '/api/v2/user/dirs'])
            self.assertEqual(self.request('users-list', admin=False)['status'], 403)
            self.assertEqual(len(observed), 2)
            self.assertEqual(self.request('status', admin=False)['status'], 200)
            self.assertEqual(observed[-2:], ['/api/v2/version', '/api/v2/status'])
        self.assertEqual(self.calls, [])

    def test_cold_expiry_coalescing_and_instance_bound_routes(self):
        from concurrent.futures import ThreadPoolExecutor
        self.install()
        self.controller._routes.clear()
        with patch.object(self.controller, 'ready', wraps=self.controller.ready) as ready:
            with ThreadPoolExecutor(max_workers=4) as pool:
                routes = list(pool.map(self.controller.route, [self.instance] * 8))
            ready.assert_called_once_with(self.instance)
        self.assertTrue(all(route[2] == routes[0][2] for route in routes))
        self.calls.clear(); self.http_calls.clear()
        self.controller.route(self.instance)
        self.assertEqual(self.calls, []); self.assertEqual(self.http_calls, [])
        verified = self.controller._routes[self.instance][0]
        with patch.object(sg.time, 'monotonic', return_value=verified + sg.ROUTE_MAX_AGE):
            self.controller.route(self.instance)
            count = len(self.calls)
            self.assertGreater(count, 0)
            self.controller.route(self.instance)
            self.assertEqual(len(self.calls), count)
        other = str(uuid.uuid4())
        with self.assertRaises((OSError, ValueError)):
            self.controller.route(other)
        self.assertNotIn(other, self.controller._routes)
        self.assertIn(self.instance, self.controller._routes)

    def test_native_failure_revokes_route_but_business_denial_does_not(self):
        self.install()
        native = sg.SFTPGoController.http.__get__(self.controller)
        denied = sg.urllib.error.HTTPError('http://127.0.0.1:32500/api/v2/users', 403, 'forbidden', {}, io.BytesIO())
        opener = types.SimpleNamespace(open=MagicMock(side_effect=denied))
        with patch.object(sg.urllib.request, 'build_opener', return_value=opener), self.assertRaises(sg.NativeError):
            native(self.instance, 'GET', '/users')
        self.assertIn(self.instance, self.controller._routes)
        opener.open.side_effect = sg.urllib.error.URLError('native unavailable')
        with patch.object(sg.urllib.request, 'build_opener', return_value=opener), self.assertRaises(ValueError):
            native(self.instance, 'GET', '/users')
        self.assertNotIn(self.instance, self.controller._routes)

    def test_lifecycle_and_failed_health_revoke_before_reuse(self):
        self.install()
        original = self.controller.docker
        def stop(*args, **kwargs):
            if args[:2] == ('container', 'stop'):
                self.assertNotIn(self.instance, self.controller._routes)
            return original(*args, **kwargs)
        self.controller.docker = stop
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertNotIn(self.instance, self.controller._routes)
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'running')
        self.assertIn(self.instance, self.controller._routes)
        obj = self.containers[self.controller.names(self.instance)]
        obj['HostConfig']['Privileged'] = True
        self.assertEqual(self.controller.execute(self.operation('refresh'))['state'], 'error')
        self.assertNotIn(self.instance, self.controller._routes)
        obj['HostConfig']['Privileged'] = False
        self.controller.ready(self.instance)
        with patch.object(self.controller, 'native_ready', side_effect=ValueError('native database stopped')), self.assertRaises(ValueError):
            self.controller.ready(self.instance)
        self.assertNotIn(self.instance, self.controller._routes)

    def test_warm_stream_preserves_session_path_digest_and_no_docker(self):
        self.install()
        self.assertEqual(self.request('client-login', {'username': 'alice', 'password': 'native-password'}, admin=False)['status'], 200)
        meta = {'instance_id': self.instance, 'action': 'file-download', 'actor': self.actor,
                'payload': {'path': '/data.txt'}, 'body_length': 0, 'body_sha256': hashlib.sha256(b'').hexdigest()}
        response = MagicMock(status=200)
        response.getheader.side_effect = lambda name: '4' if name == 'Content-Length' else None
        response.read.side_effect = [b'data', b'']
        connection = MagicMock(); connection.getresponse.return_value = response
        handler = MagicMock(wfile=io.BytesIO())
        self.calls.clear(); self.http_calls.clear()
        with patch.object(sg.http.client, 'HTTPConnection', return_value=connection):
            self.controller.stream(meta, io.BytesIO(), handler)
        self.assertEqual(handler.wfile.getvalue(), b'data')
        self.assertEqual(self.calls, []); self.assertEqual(self.http_calls, [])
        self.assertIn('Bearer ', connection.request.call_args.kwargs['headers']['Authorization'])
        for changes in ({'payload': {'path': '/../other'}}, {'body_sha256': '0' * 64},
                        {'actor': {**self.actor, 'session_key': 'c' * 64}}):
            with self.subTest(changes=changes), patch.object(sg.http.client, 'HTTPConnection') as connect, self.assertRaises(ValueError):
                self.controller.stream({**meta, **changes}, io.BytesIO(), MagicMock())
            connect.assert_not_called()
        connection = MagicMock(); connection.request.side_effect = ConnectionRefusedError('native stopped')
        with patch.object(sg.http.client, 'HTTPConnection', return_value=connection), self.assertRaises(ConnectionRefusedError):
            self.controller.stream(meta, io.BytesIO(), MagicMock())
        self.assertNotIn(self.instance, self.controller._routes)

    def test_owned_lifecycle_idempotency_secrets_and_data_preservation(self):
        op = self.operation('install')
        result = self.controller.execute(op)
        self.assertEqual(result['state'], 'running')
        state = self.controller.state(self.instance)
        self.assertNotIn(state['admin_password'], str(self.calls) + str(result))
        self.assertEqual(self.controller.execute(op), result)
        self.assertEqual(len(self.containers), 1)
        self.assertEqual(len(self.resources['volume']), 2)
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertEqual(len(self.resources['volume']), 2)
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'running')
        self.assertEqual(self.controller.state(self.instance), state)
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')
        self.assertFalse(self.containers); self.assertFalse(any(self.resources.values()))

    def test_native_admin_and_ui_are_private_and_ssh_commands_disabled(self):
        self.install()
        config = self.controller.config(self.controller.state(self.instance))
        binding = config['httpd']['bindings'][0]
        self.assertFalse(binding['enable_web_admin']); self.assertFalse(binding['enable_web_client'])
        self.assertEqual(config['sftpd']['enabled_ssh_commands'], [])
        ports = next(iter(self.containers.values()))['HostConfig']['PortBindings']
        self.assertEqual(ports['2022/tcp'], [{'HostIp': '127.0.0.1', 'HostPort': '2022'}])
        self.assertEqual(ports['8080/tcp'][0]['HostIp'], '127.0.0.1')

    def test_auth_methods_are_independent_and_password_is_write_only(self):
        self.install()
        created = self.request('users-create', {'user': self.user()})
        self.assertEqual(created['status'], 200)
        self.assertNotIn('native-password', json.dumps(created))
        self.assertTrue(created['body']['password_enabled']); self.assertTrue(created['body']['has_password'])
        user = self.user(); user.pop('password')
        user.update(password_enabled=False, public_key_enabled=True, public_keys=['ssh-ed25519 ' + base64.b64encode(b'x'*48).decode()])
        updated = self.request('users-update', {'user': user})
        self.assertEqual(updated['status'], 200)
        self.assertFalse(updated['body']['password_enabled']); self.assertTrue(updated['body']['public_key_enabled'])
        filters = self.users['alice']['filters']['denied_login_methods']
        self.assertIn('password', filters); self.assertIn('password-over-SSH', filters); self.assertNotIn('publickey', filters)
        user['password_enabled'] = True
        self.assertEqual(self.request('users-update', {'user': user})['status'], 200)
        user['public_keys'] = []
        self.assertEqual(self.request('users-update', {'user': user})['status'], 400)

    def test_shared_paths_are_generated_and_host_paths_never_accepted(self):
        self.install()
        result = self.request('folders-save', {'folder': {'name': 'team', 'description': 'Shared'}})
        self.assertEqual(result['status'], 200)
        self.assertEqual(self.folders['team']['mapped_path'], '/srv/sftpgo/data/shared/team')
        self.assertNotIn('mapped_path', result['body'])
        self.assertEqual(self.request('folders-save', {'folder': {'name': 'team', 'description': '', 'mapped_path': '/etc'}})['status'], 400)
        user = self.user(); user['virtual_folders'] = [{'name': 'team', 'virtual_path': '/team', 'quota_size': -1, 'quota_files': -1}]
        self.assertEqual(self.request('users-create', {'user': user})['status'], 200)
        self.assertEqual(self.users['alice']['virtual_folders'][0]['mapped_path'], '/srv/sftpgo/data/shared/team')

    def test_native_client_is_session_bound_and_cannot_use_admin_token(self):
        self.install()
        self.assertEqual(self.request('users-list', admin=False)['status'], 403)
        self.assertEqual(self.request('files-list', {'path': '/'}, admin=False)['status'], 401)
        result = self.request('client-login', {'username': 'alice', 'password': 'native-password'}, admin=False)
        self.assertEqual(result['body'], {'authenticated': True, 'username': 'alice'})
        listing = self.request('files-list', {'path': '/'}, admin=False)
        self.assertEqual(listing['body']['entries'][0]['type'], 'file')
        call = self.http_calls[-1]
        self.assertTrue(call[-1]); self.assertIn('Authorization', call[3])
        other = {**self.actor, 'subject': 'local:other'}
        self.assertEqual(self.request('files-list', {'path': '/'}, admin=False, actor=other)['status'], 401)
        self.controller.execute(self.operation('disable'))
        self.assertFalse(self.controller.sessions)
        self.controller.execute(self.operation('enable'))
        self.assertEqual(self.request('files-list', {'path': '/'}, admin=False)['status'], 401)

    def test_typed_listener_preparation_and_apply_revision(self):
        self.install()
        prepared = self.request('settings-prepare', {'configuration': {'listen_ip': '127.0.0.1', 'port': 2233}, 'expected_revision': 0})
        self.assertEqual(prepared['status'], 200)
        ref = prepared['body']['configuration_ref']
        result = self.controller.execute(self.operation('configure', configuration_ref=ref))
        self.assertEqual(result['configuration_revision'], 1)
        self.assertEqual(next(iter(self.containers.values()))['HostConfig']['PortBindings']['2022/tcp'][0]['HostPort'], '2233')
        self.assertEqual(self.request('settings-prepare', {'configuration': {'listen_ip': '127.0.0.1', 'port': 2234}, 'expected_revision': 0})['status'], 409)
        for ip in ('0.0.0.0', '8.8.8.8', '::1'):
            self.assertEqual(self.request('settings-prepare', {'configuration': {'listen_ip': ip, 'port': 2022}, 'expected_revision': 1})['status'], 400)

    def test_foreign_container_drift_prevents_remove(self):
        self.install()
        next(iter(self.containers.values()))['Config']['Env'].append('SFTPGO_DEFAULT_ADMIN_PASSWORD=other')
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertEqual(len(self.resources['volume']), 2)
        self.assertEqual(len(self.containers), 1)

    def test_initial_listener_prefers_free_2022(self):
        sock = MagicMock()
        sock.getsockname.return_value = ('127.0.0.1', 2022)
        with patch.object(sg.socket, 'socket') as create:
            create.return_value.__enter__.return_value = sock
            self.assertEqual(sg.SFTPGoController.initial_listener(self.controller), {'listen_ip': '127.0.0.1', 'port': 2022})
        create.assert_called_once_with(sg.socket.AF_INET, sg.socket.SOCK_STREAM)
        sock.bind.assert_called_once_with(('127.0.0.1', 2022))
        create.return_value.__exit__.assert_called_once()

    def test_initial_listener_falls_back_only_when_2022_is_in_use(self):
        sock = MagicMock()
        sock.bind.side_effect = [OSError(errno.EADDRINUSE, 'occupied'), None]
        sock.getsockname.return_value = ('127.0.0.1', 40321)
        with patch.object(sg.socket, 'socket') as create:
            create.return_value.__enter__.return_value = sock
            self.controller.initial_listener = lambda: sg.SFTPGoController.initial_listener(self.controller)
            self.controller.initialize(self.instance)
        self.assertEqual([call.args[0] for call in sock.bind.call_args_list], [('127.0.0.1', 2022), ('127.0.0.1', 0)])
        state = self.controller.state(self.instance)
        self.assertEqual(state['configuration'], {'listen_ip': '127.0.0.1', 'port': 40321})
        self.assertEqual(self.controller.summary(state)['port'], 40321)
        with patch.object(self.controller, 'initial_listener', side_effect=AssertionError('existing listener must not change')):
            self.controller.initialize(self.instance)
        self.assertEqual(self.controller.state(self.instance), state)

    def test_initial_listener_rejects_unknown_and_dynamic_bind_failures(self):
        for failures in ([OSError(errno.EACCES, 'private')], [OSError(errno.EADDRNOTAVAIL, 'private')],
                         [OSError(errno.EADDRINUSE, 'occupied'), OSError(errno.ENOBUFS, 'private')]):
            with self.subTest(failures=[e.errno for e in failures]):
                sock = MagicMock(); sock.bind.side_effect = failures
                with patch.object(sg.socket, 'socket') as create:
                    create.return_value.__enter__.return_value = sock
                    with self.assertRaisesRegex(ValueError, '^Initial SFTPGo listener allocation unavailable$'):
                        sg.SFTPGoController.initial_listener(self.controller)
                self.assertEqual(sock.bind.call_count, len(failures))
                self.assertFalse((self.controller.instances / self.instance / 'state.json').exists())
        with patch.object(sg.socket, 'socket', side_effect=OSError(errno.EMFILE, 'private')):
            with self.assertRaisesRegex(ValueError, '^Initial SFTPGo listener allocation unavailable$'):
                sg.SFTPGoController.initial_listener(self.controller)

    def test_explicit_listener_port_conflict_is_never_reallocated(self):
        sock = MagicMock(); sock.bind.side_effect = OSError(errno.EADDRINUSE, 'occupied')
        with patch.object(sg.socket, 'socket') as create:
            create.return_value.__enter__.return_value = sock
            with self.assertRaisesRegex(ValueError, 'Requested SFTP port is not available'):
                sg.SFTPGoController.preflight(self.controller, {'listen_ip': '127.0.0.1', 'port': 2233})
        sock.bind.assert_called_once_with(('127.0.0.1', 2233))

    def test_initial_listener_race_preserves_selected_port_and_fails_start(self):
        self.controller.initial_listener = lambda: {'listen_ip': '127.0.0.1', 'port': 40321}
        self.controller.initialize(self.instance)
        state = self.controller.state(self.instance)
        self.controller.preflight = lambda value: sg.SFTPGoController.preflight(self.controller, value)
        sock = MagicMock(); sock.bind.side_effect = OSError(errno.EADDRINUSE, 'occupied after selection')
        with patch.object(sg.socket, 'socket') as create:
            create.return_value.__enter__.return_value = sock
            with self.assertRaisesRegex(ValueError, 'Requested SFTP port is not available'):
                self.controller.start(self.instance, state['configuration'], state['revision'])
        self.assertFalse(self.containers)
        self.assertEqual(self.controller.state(self.instance), state)

    def test_interrupted_initialization_reuses_credentials(self):
        self.controller.initialize(self.instance)
        state = self.controller.state(self.instance)
        config = self.controller.path(self.instance) / 'config/bootstrap.json'
        config.unlink()
        self.controller.initialize(self.instance)
        self.assertEqual(self.controller.state(self.instance), state)
        self.assertEqual(json.loads(config.read_text())['admins'][0]['password'], state['admin_password'])

    def test_interrupted_private_file_removal_reconciles_owned_journal(self):
        self.install()
        request = self.operation('remove')
        target = self.controller.path(self.instance) / 'config/bootstrap.json'
        original = Path.unlink
        interrupted = False
        def unlink(path, *args, **kwargs):
            nonlocal interrupted
            result = original(path, *args, **kwargs)
            if path == target and not interrupted:
                interrupted = True
                raise OSError('fixture interruption after owned file deletion')
            return result
        with patch.object(Path, 'unlink', unlink):
            self.assertEqual(self.controller.execute(request)['state'], 'error')
        self.assertFalse(self.containers)
        self.assertFalse(any(self.resources.values()))
        self.assertEqual(self.controller.execute(request)['state'], 'absent')

    def test_stream_digest_and_path_are_checked_before_native_transfer(self):
        self.install()
        metadata = {'instance_id': self.instance, 'action': 'file-upload', 'actor': self.actor, 'payload': {'path': '/data.txt'}, 'body_length': 3, 'body_sha256': hashlib.sha256(b'abc').hexdigest()}
        with self.assertRaises(ValueError):
            self.controller.stream(metadata, io.BytesIO(b'bad'), None)
        with self.assertRaises(ValueError):
            self.controller.stream({**metadata, 'payload': {'path': '/../etc/passwd'}}, io.BytesIO(b'abc'), None)
        with self.assertRaises(sg.NativeError):
            self.controller.stream(metadata, io.BytesIO(b'abc'), None)


    def test_owned_bridge_publishes_only_selected_sftp_and_loopback_api(self):
        self.install()
        network = self.resources['network'][self.controller.names(self.instance, '-net')]
        self.assertIs(network['Internal'], False)
        creation = next(args for args in self.calls if args[:2] == ('network', 'create'))
        self.assertNotIn('--internal', creation)
        obj = self.controller.inspect(self.instance)
        self.assertEqual(obj['NetworkSettings']['Ports']['2022/tcp'], [{'HostIp': '127.0.0.1', 'HostPort': '2022'}])
        self.assertEqual(obj['NetworkSettings']['Ports']['8080/tcp'], [{'HostIp': '127.0.0.1', 'HostPort': '32500'}])
        self.assertEqual(self.controller.endpoint(obj), 'http://127.0.0.1:32500')

    def test_fake_internal_bridge_does_not_allocate_published_ports(self):
        self.install()
        obj = next(iter(self.containers.values()))
        self.docker('container', 'stop', obj['Id'])
        self.resources['network'][self.controller.names(self.instance, '-net')]['Internal'] = True
        self.docker('container', 'start', obj['Id'])
        self.assertTrue(obj['State']['Running'])
        self.assertEqual(obj['NetworkSettings']['Ports'], {'2022/tcp': None, '8080/tcp': None})
        with self.assertRaises(ValueError):
            self.controller.endpoint(obj)
        with self.assertRaises(ValueError):
            self.controller.inspect(self.instance)

    def test_network_identity_options_members_and_bind_drift_are_refused(self):
        self.install()
        original_resources, original_containers = copy.deepcopy(self.resources), copy.deepcopy(self.containers)
        cases = ('foreign-label', 'network-options', 'foreign-member', 'additional-network', 'api-all-interfaces', 'sftp-unselected-bind')
        for case in cases:
            with self.subTest(case=case):
                self.resources, self.containers = copy.deepcopy(original_resources), copy.deepcopy(original_containers)
                network = self.resources['network'][self.controller.names(self.instance, '-net')]
                obj = next(iter(self.containers.values()))
                if case == 'foreign-label':
                    network['Labels']['pl.installation'] = 'foreign-installation'
                elif case == 'network-options':
                    network['Options'] = {'com.docker.network.bridge.enable_ip_masquerade': 'false'}
                elif case == 'foreign-member':
                    foreign = copy.deepcopy(obj); foreign['Id'] = 'e' * 64
                    self.containers['foreign-container'] = foreign
                elif case == 'additional-network':
                    obj['NetworkSettings']['Networks']['foreign-network'] = {}
                elif case == 'api-all-interfaces':
                    obj['HostConfig']['PortBindings']['8080/tcp'][0]['HostIp'] = '0.0.0.0'
                    obj['NetworkSettings']['Ports']['8080/tcp'][0]['HostIp'] = '0.0.0.0'
                    with self.assertRaises(ValueError):
                        self.controller.endpoint(obj)
                elif case == 'sftp-unselected-bind':
                    obj['HostConfig']['PortBindings']['2022/tcp'][0]['HostIp'] = '0.0.0.0'
                with self.assertRaises(ValueError):
                    self.controller.inspect(self.instance)
