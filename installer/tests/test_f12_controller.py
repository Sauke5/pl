"""Finite F12 host RPC, segment ownership and publication rollback."""
import base64
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import types
import unittest
import uuid
from unittest.mock import Mock, patch


def load(name):
    file = Path(__file__).resolve().parents[1] / (name + '.py')
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


f12 = load('f12-controller')
host = load('module-controller')
INSTANCE = str(uuid.uuid4())
UPLOAD = str(uuid.uuid4())
ACTOR = 'a' * 64
NET = {'name': 'lan · 192.0.2.0/24 (192.0.2.10)', 'address': '192.0.2.10', 'cidr': '192.0.2.0/24', 'port': 18080}


def request(action, payload, **extra):
    return {'instance_id': INSTANCE, 'actor': ACTOR, 'action': action, 'payload': payload, **extra}


class ContractTests(unittest.TestCase):
    def test_finite_framing(self):
        allowed = request('upload-chunk', {'id': UPLOAD, 'offset': 0}, body_sha256='a' * 64, body_length=4)
        self.assertEqual(f12.parse_request(allowed, True), ('upload-chunk', allowed['payload']))
        invalid = [(allowed, False), ({**allowed, 'body_length': 0}, True),
                   ({**allowed, 'body_length': f12.CHUNK + 1}, True),
                   ({**allowed, 'payload': {'id': UPLOAD, 'offset': False}}, True),
                   ({**allowed, 'body_sha256': 'A' * 64}, True),
                   (request('publish', {'id': 'a' * 64, 'segments': ['b' * 64, 'b' * 64]}), False),
                   (request('menu', {'segment': '192.0.2.1'}), False),
                   (request('upload-cancel', {'id': UPLOAD}, actor='anonymous'), False),
                   (request('upload-start', {'id': UPLOAD, 'size': 1, 'name': '../test.iso', 'segments': []}), False),
                   (request('library', {'target': 'http://127.0.0.1'}), False)]
        for item, streaming in invalid:
            with self.subTest(item=item), self.assertRaises(f12.Failure):
                f12.parse_request(item, streaming)

    def test_host_network_identity_and_eligibility(self):
        c = f12.F12Controller.__new__(f12.F12Controller)
        c.root, c.parent = Path('/'), types.SimpleNamespace()
        def nic(name, address, prefix=24):
            return {'ifname': name, 'flags': ['UP'], 'addr_info': [
                {'family': 'inet', 'scope': 'global', 'local': address, 'prefixlen': prefix}]}
        records = [nic('eno1', '192.0.2.1'), nic('vethfe1', '192.0.2.2'), nic('docker0', '172.17.0.1'),
                   nic('eno2', '198.51.100.4'), nic('eno3', '198.51.100.4'), nic('eno5', '169.254.1.1')]
        state = {'secret': 'a' * 64}
        def collect(rows, data=state):
            with patch.object(f12.subprocess, 'run', return_value=types.SimpleNamespace(stdout=json.dumps(rows))):
                return c.host_networks(data)
        scopes = collect(records)
        self.assertEqual([v['address'] for v in scopes.values()], ['192.0.2.1'])
        self.assertEqual(collect(list(reversed(records))), scopes)
        self.assertEqual(collect([nic('eno1', '192.0.2.1'), nic('eno2', '192.0.2.131', 25)]), {})
        self.assertNotEqual(set(scopes), set(collect([nic('eno1', '192.0.2.1', 27)])))
        self.assertNotEqual(set(scopes), set(collect(records, {'secret': 'b' * 64})))

    def test_server_and_edge_do_not_share_private_mounts_or_publish_wildcard(self):
        c = f12.F12Controller.__new__(f12.F12Controller)
        c.root, c.installation = Path('/opt/pl'), 'pltest'
        c.image = {'labels': {}}
        key = '1' * 64
        state = {'edges': {key: NET}}
        server, edge = c.spec(INSTANCE, None, state), c.spec(INSTANCE, key, state)
        self.assertEqual((server['network'], server['ports'], server['cmd']), ('none', {}, ['serve']))
        self.assertEqual(edge['ports'], {'8080/tcp': [{'HostIp': NET['address'], 'HostPort': '18080'}]})
        self.assertEqual({m[2] for m in edge['mounts']}, {'/run/pl-f12/boot', '/etc/pl-f12/edge.json'})
        self.assertTrue(all(not m[3] for m in edge['mounts']))
        c.image['labels'][f12.PXE_LABEL] = '1'
        current = c.spec(INSTANCE, key, state)
        self.assertEqual(current['mounts'] - edge['mounts'], {
            ('bind', str(c.runtime(INSTANCE) / 'edges' / key / 'pxe'), '/run/pl-f12/pxe', True)})
        self.assertEqual(current['ports'], edge['ports'])
        self.assertEqual(current['network'], edge['network'])


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('private', 'modules', 'state'):
            (self.root / name).mkdir(mode=0o700)
        descriptor = {'id': 'sha256:' + '1' * 64, 'architecture': 'arm64', 'ref': 'pl/qa:f12', 'recipe': 'deploy/images/f12.Dockerfile',
                      'labels': {'pl.module.id': 'f12', 'pl.module.role': 'server', 'pl.module.config.version': '1',
                                 'org.opencontainers.image.version': f12.VERSION, 'pl.upstream.version': f12.VERSION,
                                 'pl.build.variant': 'upstream-pinned'}}
        f12.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': 'pltest', 'manifest_sha256': 'a' * 64, 'f12': {'server': descriptor}})
        f12.atomic(self.root / 'state/installation.json', {'install_id': 'pltest', 'manifest_sha256': 'a' * 64})
        self.parent = types.SimpleNamespace(root=self.root, base=self.root / 'modules', installation='pltest', docker=Mock())
        self.c = f12.F12Controller(self.parent)
        self.parent.application = lambda _: self.c
        self.path = self.c.path(INSTANCE, create=True) / 'state.json'
        self.initial = {'installation': 'pltest', 'instance_id': INSTANCE, 'secret': 'e' * 64, 'storage_created': True, 'edges': {}}
        f12.atomic(self.path, self.initial)
        self.key = f12.digest(self.initial['secret'], 'segment', NET)
        self.running = {'State': {'Running': True, 'Pid': 413}}
        self.stopped = {'State': {'Running': False, 'Pid': 0}}

    def test_incomplete_first_install_can_be_removed_only_when_no_runtime_exists(self):
        self.path.unlink()
        with patch.object(self.c, 'inventory', return_value={}), patch.object(self.c, 'resource', return_value={'Name': 'foreign'}):
            with self.assertRaises(ValueError):
                self.c.remove(INSTANCE)
        self.assertTrue(self.path.parent.is_dir())
        with patch.object(self.c, 'inventory', return_value={}), patch.object(self.c, 'resource', return_value=None):
            self.c.remove(INSTANCE)
        self.assertFalse(self.path.parent.exists())

    def test_absent_and_disabled_return_known_status(self):
        self.assertEqual(self.c.request({**request('library', {}), 'instance_id': str(uuid.uuid4())})['status'], 404)
        self.parent.docker.assert_not_called()
        with patch.object(self.c, 'inspect', return_value=self.stopped), patch.object(self.c, 'native') as origin:
            self.assertEqual(self.c.request(request('library', {}))['status'], 503)
            origin.assert_not_called()

    def test_stale_selection_and_read_never_open_listener(self):
        with patch.object(self.c, 'sync_networks', return_value={}), patch.object(self.c, 'inspect', return_value=self.running), \
                patch.object(self.c, 'create') as create, patch.object(self.c, 'forward', return_value=(200, {'items': []})):
            self.assertEqual(self.c.request(request('library', {}))['status'], 200)
            self.assertEqual(self.c.request(request('publish', {'id': 'a' * 64, 'segments': [self.key]}))['status'], 409)
            self.assertEqual(self.c.request(request('menu', {'segment': self.key}))['status'], 404)
            create.assert_not_called()
        self.assertEqual(self.c.state(INSTANCE), self.initial)

    def test_collision_preserves_state_and_native_publication(self):
        with patch.object(self.c, 'sync_networks', return_value={self.key: NET}), patch.object(self.c, 'inspect', return_value=self.running), \
                patch.object(self.c, 'container_id', return_value=''), patch.object(self.c, 'forward') as origin, \
                patch.object(self.c, 'preflight_port', side_effect=f12.Failure(409, 'Порт занят.')), patch.object(self.c, 'create') as create:
            self.assertEqual(self.c.request(request('publish', {'id': 'a' * 64, 'segments': [self.key]}))['status'], 409)
            create.assert_not_called()
            origin.assert_not_called()
        self.assertEqual(self.c.state(INSTANCE), self.initial)

    def test_publication_reports_bridge_failure_after_successful_port_check(self):
        allocator = f12.load_network_helper()
        for error, message in (
            (allocator.PoolExhausted('exhausted'), 'PL не нашла свободную внутреннюю подсеть /28 для F12.'),
            (ValueError('engine failed'), 'Не удалось подготовить службу публикации F12 в выбранной сети.'),
        ):
            with self.subTest(error=type(error).__name__), \
                    patch.object(self.c, 'sync_networks', return_value={self.key: NET}), \
                    patch.object(self.c, 'inspect', side_effect=[self.running, None]), \
                    patch.object(self.c, 'container_id', return_value=''), patch.object(self.c, 'preflight_port') as port, \
                    patch.object(self.c, 'resource', side_effect=[None, error, None]), \
                    patch.object(self.c, 'prepare_runtime'), patch.object(self.c, 'forward') as origin:
                result = self.c.request(request('publish', {'id': 'b' * 64, 'segments': [self.key]}))
                self.assertEqual((result['status'], result['body']['error']), (409, message))
                port.assert_called_once_with(NET['address'])
                origin.assert_not_called()
                self.assertEqual(self.c.state(INSTANCE), self.initial)

    def test_rejected_native_publication_removes_only_new_edge(self):
        item = {'Id': '1' * 64, 'State': {'Running': True}}
        bridge = {'Id': '2' * 64, 'IPAM': {'Config': [{'Subnet': '10.244.182.192/28'}]}}
        def inspect(_instance, segment=None, **_):
            return self.running if segment is None else item
        with patch.object(self.c, 'sync_networks', return_value={self.key: NET}), patch.object(self.c, 'inspect', side_effect=inspect), \
                patch.object(self.c, 'resource', side_effect=[None, bridge, bridge]), patch.object(self.c, 'prepare_runtime'), \
                patch.object(self.c, 'container_id', return_value=''), patch.object(self.c, 'preflight_port'), \
                patch.object(self.c, 'create', return_value=item), patch.object(self.c, 'start'), patch.object(self.c, 'drop') as drop, \
                patch.object(self.c, 'forward', return_value=(404, {'error': 'Образ не найден.'})):
            result = self.c.request(request('publish', {'id': 'b' * 64, 'segments': [self.key]}))
            self.assertEqual(result['status'], 404)
            drop.assert_called_once_with(item)
            self.parent.docker.assert_called_once_with('network', 'rm', bridge['Id'])
        self.assertEqual(self.c.state(INSTANCE), self.initial)

    def test_background_refresh_stops_stale_listener_and_resumes_previous_selection(self):
        state = {**self.initial, 'edges': {self.key: NET}}
        f12.atomic(self.path, state)
        self.c.sampled_networks[INSTANCE] = frozenset([self.key])
        with patch.object(self.c, 'sync_networks', side_effect=[{}, {self.key: NET}]), \
                patch.object(self.c, 'inspect', side_effect=[self.running, self.running, self.running, self.stopped]), \
                patch.object(self.c, 'stop') as stop, patch.object(self.c, 'start') as start:
            self.c.reconcile_interfaces(INSTANCE)
            stop.assert_called_once_with(self.running)
            start.assert_not_called()
            self.c.reconcile_interfaces(INSTANCE)
            start.assert_called_once_with(INSTANCE, self.stopped, self.key, state)
        self.assertEqual(self.c.state(INSTANCE), state)

    def test_disable_checks_live_worker_before_stopping_edges(self):
        with patch.object(self.c, 'inventory', return_value={None: self.running}), \
                patch.object(self.c, 'health', return_value={'ready': True, 'busy': True}), patch.object(self.c, 'stop') as stop:
            with self.assertRaises(f12.Failure) as error:
                self.c.disable(INSTANCE, self.c.state(INSTANCE))
            self.assertEqual(error.exception.status, 409)
            stop.assert_not_called()

    def test_automatic_pxe_requires_committed_firmware_and_live_interface(self):
        self.c.image['labels'][f12.PXE_LABEL] = '1'
        edge = {**NET, 'interface': 'lan'}
        state = {**self.initial, 'edges': {self.key: NET}}
        pending = {'state':'waiting', 'firmware':['bios']}
        attached = {'state':'active', 'firmware':['bios']}
        with patch.object(self.c, 'inspect', return_value=self.running), \
                patch.object(f12, 'pxe_command', side_effect=[pending, pending, attached, pending, pending, pending]), \
                patch.object(self.c, 'published_firmware', side_effect=[[], ['bios'], ['bios']]), \
                patch.object(f12, 'open_pxe_sockets', side_effect=[[], OSError('port busy')]) as opened:
            def reconcile(activate):
                return self.c.segment_pxe(INSTANCE, state, self.key, edge, self.running, activate=activate)
            self.assertEqual(reconcile(True), 'idle')
            opened.assert_not_called()
            self.assertEqual(reconcile(True), 'active')
            self.assertEqual(opened.call_args.args[1:], ('lan', '192.0.2.10'))
            self.assertEqual(reconcile(False), 'waiting')
            self.assertEqual(opened.call_count, 1)
            self.assertEqual(reconcile(True), 'error')
            self.assertEqual(reconcile(False), 'error')

    def test_http_only_network_reports_manual_before_and_after_publication(self):
        self.c.image['labels'][f12.PXE_LABEL] = '1'
        direct, manual = 'a' * 64, 'b' * 64
        networks = {direct: {**NET, 'interface': 'lan'}, manual: NET}
        state = {**self.initial, 'edges': dict.fromkeys(networks, NET)}
        with patch.object(self.c, 'segment_pxe', return_value='active') as probe:
            items = {'items': []}
            self.assertEqual(self.c.library_pxe(INSTANCE, state, networks, self.running, items),
                             {direct: 'idle', manual: 'manual'})
            probe.assert_not_called()
            items['items'].append({'segments': [direct, manual]})
            self.assertEqual(self.c.library_pxe(INSTANCE, state, networks, self.running, items),
                             {direct: 'active', manual: 'manual'})
            probe.assert_called_once_with(INSTANCE, state, direct, networks[direct], self.running, activate=False)
            probe.reset_mock()
            self.c.reconcile_pxe(INSTANCE, state, networks, self.running)
            probe.assert_called_once_with(INSTANCE, state, direct, networks[direct], self.running, activate=True)

    def test_pxe_selection_keeps_existing_segment_id_after_upgrade(self):
        def addr(local):
            return {'family':'inet', 'scope':'global', 'local':local, 'prefixlen':24}
        iface = {'ifname':'lan', 'flags':['UP', 'BROADCAST'], 'addr_info':[addr(NET['address'])]}
        def discover():
            with patch.object(f12.subprocess, 'run', return_value=types.SimpleNamespace(stdout=json.dumps([iface]))):
                return self.c.host_networks(self.initial)
        self.assertEqual(discover(), {self.key:{**NET, 'interface':'lan'}})
        iface['addr_info'].append(addr('198.51.100.10'))
        self.assertTrue(all('interface' not in record for record in discover().values()))

    def test_signed_stream_checks_payload_before_native_and_preserves_202(self):
        unix = self.root / 'ctrl.sock'
        key = os.urandom(32)
        data = b'fixture contents'
        chunk = request('upload-chunk', {'id': UPLOAD, 'offset': 0}, body_length=len(data), body_sha256=hashlib.sha256(data).hexdigest())
        def rpc(meta, body=None, valid=True):
            path = '/v1/f12/request' if body is None else '/v1/f12/stream'
            raw = json.dumps(meta).encode()
            timestamp = str(int(time.time()))
            digest = hmac.new(key, timestamp.encode() + b'\nPOST\n' + path.encode() + b'\n' + raw, hashlib.sha256).hexdigest()
            headers = {'X-PL-Timestamp': timestamp, 'X-PL-Signature': digest if valid else '0' * 64}
            if body is not None:
                headers.update({'X-PL-Transport-Meta': base64.b64encode(raw).decode(), 'Content-Type': 'application/octet-stream'})
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(4)
                client.connect(str(unix))
                data = raw if body is None else body
                headers['Content-Length'] = str(len(data))
                head = f'POST {path} HTTP/1.0\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in headers.items())
                client.sendall((head + '\r\n').encode() + data)
                response = http.client.HTTPResponse(client)
                response.begin()
                return response.status, json.loads(response.read())
        def forward(_instance, _obj, method, path, *, body, headers):
            if path == '/chunk':
                self.assertEqual((method, body.read(), headers['X-PL-F12-Actor'], headers['X-PL-F12-Upload']),
                                 ('POST', data, ACTOR, UPLOAD))
                return 200, {'id': UPLOAD, 'offset': len(data)}
            return 202, {'id': UPLOAD, 'status': 'processing'}
        with host.Server(str(unix), host.Handler) as server, patch.object(self.c, 'inspect', return_value=self.running), \
                patch.object(self.c, 'sync_networks', return_value={}), patch.object(self.c, 'native', side_effect=forward) as native, \
                patch.object(host.Handler, 'report_failure'):
            server.key, server.controller = key, self.parent
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
            thread.start()
            try:
                self.assertEqual(rpc(chunk, data, valid=False)[0], 403)
                # Same length and signed metadata, different bytes.
                self.assertEqual(rpc(chunk, data.upper())[1]['status'], 400)
                native.assert_not_called()
                status, result = rpc(chunk, data)
                self.assertEqual((status, result['status'], result['body']['offset']), (200, 200, len(data)))
                status, result = rpc(request('upload-finish', {'id': UPLOAD}))
                self.assertEqual((status, result['status'], result['body']['status']), (200, 202, 'processing'))
            finally:
                server.shutdown()
                thread.join(timeout=3)


@unittest.skipUnless(os.environ.get('PL_F12_DIND_SMOKE') == '1', 'requires the isolated Linux Docker-in-Docker fixture')
class DockerLifecycleTests(unittest.TestCase):
    def test_signed_image_import_and_segment_server_lifecycle(self):
        import io
        import subprocess

        # Both endpoints are reserved documentation addresses on virtual NICs
        # of the disposable Linux host. The test never selects the default route.
        self.assertEqual(os.uname().sysname, 'Linux')
        self.assertEqual(subprocess.check_output(['ip', '-4', 'route', 'show', 'default']).strip(), b'')
        iso = Path(os.environ['PL_F12_QA_ISO'])
        data = iso.read_bytes()
        image_sha = hashlib.sha256(data).hexdigest()
        self.assertEqual(image_sha, 'f26ca71a1bb8534ebad65a5df844d6adc4aba7252910186bef8623d86855db08')
        def docker(*args, timeout=40):
            return subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *args],
                                  check=True, capture_output=True, timeout=timeout).stdout
        image, = json.loads(docker('image', 'inspect', os.environ['PL_F12_QA_IMAGE']))
        descriptor = {'id': image['Id'], 'architecture': image['Architecture'], 'ref': os.environ['PL_F12_QA_IMAGE'],
                      'recipe': 'deploy/images/f12.Dockerfile', 'labels': image['Config']['Labels']}
        identity, upload = str(uuid.uuid4()), str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for directory in ('state', 'private', 'modules'):
                (root / directory).mkdir(mode=0o700)
            installation = 'plf12qa' + uuid.uuid4().hex[:6]
            f12.atomic(root / 'private/module-images.json', {'schema': 1, 'installation': installation, 'manifest_sha256': 'f' * 64,
                                                            'f12': {'server': descriptor}})
            f12.atomic(root / 'state/installation.json', {'install_id': installation, 'manifest_sha256': 'f' * 64,
                                                         'config': {'network_cidr': '10.245.210.0/24'}})
            parent = types.SimpleNamespace(root=root, base=root / 'modules', installation=installation, docker=docker)
            controller = f12.F12Controller(parent)
            def lifecycle(action):
                return controller.execute({'instance_id': identity, 'operation_id': str(uuid.uuid4()), 'module_id': 'f12', 'action': action})['state']
            def call(action, payload, buf=None, actor=ACTOR):
                extra = {} if buf is None else {'body_length': len(buf), 'body_sha256': hashlib.sha256(buf).hexdigest()}
                obj = {'instance_id': identity, 'action': action, 'actor': actor, 'payload': payload, **extra}
                return controller.request(obj, None if buf is None else io.BytesIO(buf))
            def from_client(namespace, uri):
                snippet = ('import http.client,sys;c=http.client.HTTPConnection("192.0.2.10",18080,timeout=4);'
                           'c.request("GET",sys.argv[1]);r=c.getresponse();print(r.status,r.read(150).hex())')
                status, body = subprocess.check_output(['ip', 'netns', 'exec', namespace, 'python3', '-c', snippet, uri],
                                                        text=True, timeout=8).split()
                return int(status), bytes.fromhex(body)
            try:
                self.assertEqual(lifecycle('install'), 'running')
                primary = controller.inspect(identity)
                self.assertEqual(primary['HostConfig']['NetworkMode'], 'none')
                self.assertFalse(primary['HostConfig']['PortBindings'])
                self.assertIsNone(controller.resource(identity, 'network'))
                choices = call('library', {})['body']['segments']
                self.assertEqual(len(choices), 2)
                segment = next(k for k,v in choices.items() if 'lablan1' in v and '192.0.2.10' in v)
                other = next(k for k in choices if k != segment)
                payload = {'id': upload, 'name': 'TinyCore.iso', 'size': len(data), 'segments': [segment]}
                self.assertEqual(call('upload-start', payload)['status'], 200)
                self.assertEqual(call('upload-chunk', {'id': upload, 'offset': 0}, data[:8], actor='b' * 64)['status'], 404)
                for index in range(0, len(data), f12.CHUNK):
                    block = data[index:index + f12.CHUNK]
                    result = call('upload-chunk', {'id': upload, 'offset': index}, block)
                    self.assertEqual(result['body']['offset'], index + len(block))
                for _ in range(30):
                    finish = call('upload-finish', {'id': upload})
                    if finish['status'] != 202:
                        break
                    time.sleep(1)
                self.assertEqual(finish['status'], 200, finish)
                self.assertEqual([i['id'] for i in call('menu', {'segment': segment})['body']['items']], [image_sha])
                self.assertEqual(call('menu', {'segment': other})['body']['items'], [])
                self.assertIn(b'TinyCore.iso', from_client('lab1', '/menu.ipxe')[1])
                self.assertEqual(from_client('lab2', '/media/' + image_sha + '/kernel')[0], 403)
                self.assertEqual(lifecycle('disable'), 'disabled')
                self.assertEqual(call('library', {})['status'], 503)
                self.assertEqual(lifecycle('enable'), 'running')
                self.assertEqual(from_client('lab1', '/media/' + image_sha + '/kernel')[0], 200)
                self.assertEqual(call('publish', {'id': image_sha, 'segments': []})['status'], 200)
                self.assertEqual(from_client('lab1', '/media/' + image_sha + '/kernel')[0], 404)
            finally:
                self.assertEqual(lifecycle('remove'), 'absent')
            self.assertIsNone(controller.resource(identity, 'volume'))
            self.assertIsNone(controller.resource(identity, 'network'))
            self.assertFalse(controller.runtime(identity).exists())
