"""Finite Syslog contracts and opt-in real lifecycle on a local Docker socket."""
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import types
import unittest
import uuid
from unittest.mock import Mock, patch

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pl_syslog_test', BASE / 'syslog-controller.py')
sl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sl)
WINDOW = {'from': '2026-02-10T10:00:00Z', 'to': '2026-02-10T11:00:00+00:00'}


def make_controller(root, installation, descriptor, docker):
    for name in ('private', 'state', 'modules'):
        (root / name).mkdir(mode=0o700)
    sl.atomic(root / 'private/module-images.json', {'schema': 1, 'installation': installation, 'manifest_sha256': 'a' * 64,
                                                    'syslog': {'server': descriptor}})
    sl.atomic(root / 'state/installation.json', {'install_id': installation, 'manifest_sha256': 'a' * 64})
    return sl.SyslogController(types.SimpleNamespace(root=root, installation=installation, docker=docker))


class QueryTests(unittest.TestCase):
    def test_query_is_a_fixed_projection_and_literal_filters(self):
        text = 'ИП "Порт" | stats count()\\'
        payload = {**WINDOW, 'source': 'router-1', 'address': '192.0.2.15', 'severity': '0', 'text': text}
        for action, limit in sl.LIMITS.items():
            with self.subTest(action=action):
                params = sl.query_parameters(action, payload if action == 'messages' else WINDOW)
                self.assertEqual((params['start'], params['end'], params['limit'], params['timeout']), (*WINDOW.values(), limit + 1, '5s'))
                if action != 'messages':
                    continue
                for expected in ('hostname:="router-1"', 'remote_ip:="192.0.2.15"', 'severity:="0"', '_msg:*' + json.dumps(text, ensure_ascii=False) + '*'):
                    self.assertIn(expected, params['query'])
        self.assertIn('by (hostname, remote_ip)', sl.query_parameters('sources', WINDOW)['query'])
        nanosecond = {'from': '2026-02-10T10:00:00.000000001Z', 'to': '2026-02-10T10:00:00.000000002Z'}
        self.assertEqual(sl.query_parameters('messages', nanosecond)['end'], nanosecond['to'])
        with self.assertRaises(sl.RequestError):
            sl.query_parameters('sources', payload)

    def test_wrong_windows_types_and_query_fields(self):
        for extra in ({'from': 'yesterday'}, {'to': WINDOW['from']}, {'to': '2026-03-14T10:00:00Z'},
                      {'from': '2026-02-31T00:00:00Z'}, {'from': '2026-02-10T10:00:00'}, {'severity': '8'},
                      {'severity': 0}, {'address': '192.0.2.1:5514'}, {'text': 'x\n'}, {'source': False},
                      {'text': 'я' * 257}, {'limit': 1}, {'query': '*'}):
            with self.subTest(extra=extra), self.assertRaises(sl.RequestError):
                sl.query_parameters('messages', {**WINDOW, **extra})

    def test_no_lan_by_default_and_exact_protocol_bindings(self):
        self.assertEqual(sl.published(sl.DEFAULT), {})
        candidate = {**sl.DEFAULT, 'address': '192.0.2.4', 'tcp': False}
        self.assertEqual(sl.published(sl.settings(candidate)), {'1514/udp': [{'HostIp': '192.0.2.4', 'HostPort': '5514'}]})
        self.assertNotIn('-syslog.listenAddr.tcp=:1514', sl.command(candidate))
        for extra in ({'port': True}, {'port': 0}, {'port': 65536}, {'retention_days': False}, {'retention_days': 366},
                      {'address': '0.0.0.0'}, {'address': '224.0.0.1'}, {'tcp': 'true'}, {'tcp': False, 'udp': False, 'address': '192.0.2.4'}):
            with self.subTest(extra=extra), self.assertRaises(sl.RequestError):
                sl.settings({**sl.DEFAULT, **extra})

    def test_preflight_skips_owned_binding_only_for_identical_protocol(self):
        c = sl.SyslogController.__new__(sl.SyslogController)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.bind(('127.0.0.1', 0))
            addr, port = udp.getsockname()
            current = {**sl.DEFAULT, 'address': addr, 'port': port, 'udp': False}
            with self.assertRaises(sl.RequestError) as e:
                c.preflight({**current, 'udp': True}, current, [addr])
            self.assertEqual(e.exception.code, 'syslog_port_in_use')
            c.preflight({**current, 'udp': True}, {**current, 'udp': True}, [addr])
            with self.assertRaises(sl.RequestError) as e:
                c.preflight(current, current, ['192.0.2.4'])
            self.assertEqual(e.exception.code, 'syslog_address_unavailable')

    def test_ipv4_inventory_uses_assigned_addresses_and_excludes_docker_bridges(self):
        ips = [
            {'ifname': 'eth0', 'flags': ['UP'], 'addr_info': [{'family': 'inet', 'local': '192.0.2.4'}]},
            {'ifname': 'lo', 'flags': ['UP'], 'addr_info': [{'family': 'inet', 'local': '127.0.0.1'}]},
            {'ifname': 'br-012345abcdef', 'flags': ['UP'], 'addr_info': [{'family': 'inet', 'local': '172.31.0.1'}]},
            {'ifname': 'eth1', 'flags': [], 'addr_info': [{'family': 'inet', 'local': '198.51.100.2'}]}]
        c = sl.SyslogController.__new__(sl.SyslogController)
        c.parent, c.root = types.SimpleNamespace(), BASE
        with patch.object(sl.subprocess, 'run', return_value=types.SimpleNamespace(stdout=json.dumps(ips).encode())) as run:
            self.assertEqual(c.host_addresses(), ['192.0.2.4', '127.0.0.1'])
        self.assertEqual(run.call_args.args[0], ['ip', '-j', '-4', 'address', 'show'])


class StateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root, self.instance = Path(temp.name).resolve(), str(uuid.uuid4())
        image = {'id': 'sha256:' + 'a' * 64, 'architecture': 'arm64', 'recipe': 'deploy/images/syslog.Dockerfile', 'ref': 'fixture',
                 'labels': {'org.opencontainers.image.version': '1.54.0', 'pl.upstream.version': '1.54.0', 'pl.module.id': 'syslog',
                            'pl.module.role': 'server', 'pl.module.config.version': '1', 'pl.build.variant': 'upstream-pinned'}}
        self.c = make_controller(self.root, 'pl-676767676767', image, Mock())
        self.previous = {'installation': self.c.installation, 'instance_id': self.instance, 'configuration': sl.DEFAULT, 'revision': 2, 'pending': None}
        self.file = self.c.path(self.instance, create=True) / 'state.json'
        sl.atomic(self.file, self.previous)

    def call(self, action, payload):
        return self.c.request({'instance_id': self.instance, 'action': action, 'payload': payload})

    def test_rejects_stale_revision_before_contacting_docker(self):
        result = self.call('receiver-set', {**sl.DEFAULT, 'retention_days': 7, 'expected_revision': 1})
        self.assertEqual((result['status'], result['body']['error']['code']), (409, 'syslog_revision_conflict'))
        self.c.docker.assert_not_called()
        self.assertEqual(self.c.state(self.instance), self.previous)

    def test_failed_start_restores_old_revision_and_running_state(self):
        old = {'Id': '1', 'Config': {'Labels': {'pl.syslog.revision': '2'}}, 'State': {'Running': True}}
        fresh = {'Id': '2', 'Config': {'Labels': {'pl.syslog.revision': '3'}}, 'State': {'Running': False}}
        with patch.object(self.c, 'host_addresses', return_value=['127.0.0.1']), \
                patch.object(self.c, 'inspect', side_effect=[old, fresh]), patch.object(self.c, 'drop') as drop, \
                patch.object(self.c, 'create', side_effect=[fresh, old]) as create, \
                patch.object(self.c, 'start', side_effect=[sl.unavailable(), None]) as start:
            result = self.call('receiver-set', {**sl.DEFAULT, 'retention_days': 8, 'expected_revision': 2})
        self.assertEqual(result['body']['error']['code'], 'syslog_apply_failed')
        self.assertEqual([c.args[0] for c in drop.call_args_list], [old, fresh])
        self.assertEqual(create.call_args_list[-1].args, (self.instance, sl.DEFAULT, 2))
        self.assertEqual(start.call_args_list[-1].args, (self.instance, old))
        self.assertEqual(self.c.state(self.instance), self.previous)

    def test_interrupted_disabled_change_recovers_without_start(self):
        pending = {**self.previous, 'pending': {'configuration': {**sl.DEFAULT, 'port': 5515}, 'running': False, 'revision': 3}}
        sl.atomic(self.file, pending)
        with patch.object(self.c, 'inspect', return_value=None), patch.object(self.c, 'create', return_value={'State': {'Running': False}}), \
                patch.object(self.c, 'start') as start:
            self.c.restore_previous(self.instance, self.c.state(self.instance, pending=True))
            start.assert_not_called()
        self.assertEqual(self.c.state(self.instance), self.previous)

    def test_unexpected_file_stops_removal_before_engine(self):
        (self.file.parent / 'unrelated').touch()
        with self.assertRaisesRegex(ValueError, 'Unexpected'):
            self.c.remove(self.instance)
        self.assertTrue(self.file.exists())
        self.c.docker.assert_not_called()

    def test_enable_never_replaces_a_previously_created_data_volume(self):
        sl.atomic(self.file, {**self.previous, 'storage_created': True})
        with patch.object(self.c, 'resource', return_value=None) as resource:
            with self.assertRaisesRegex(ValueError, 'volume missing'):
                self.c.ensure(self.instance)
            resource.assert_called_once_with(self.instance, 'volume', create=False)

    def test_interrupted_first_install_finishes_provisioning_once(self):
        sl.atomic(self.file, {**self.previous, 'storage_created': False})
        running = {'State': {'Running': True}}
        with patch.object(self.c, 'resource', return_value={'Name': 'owned'}) as resource, patch.object(self.c, 'inspect', return_value=running):
            self.c.ensure(self.instance)
            self.c.ensure(self.instance)
        volume_creates = [call.kwargs['create'] for call in resource.call_args_list if call.args[1] == 'volume']
        self.assertEqual(volume_creates, [True, False])
        self.assertIs(self.c.state(self.instance)['storage_created'], True)

    def test_queries_require_an_owned_container_and_a_live_private_api(self):
        identity = '1' * 64
        foreign = {'Id': '2' * 64, 'Config': {'Labels': {'pl.syslog.revision': str(self.previous['revision'])}}}
        self.c.docker.return_value = json.dumps([foreign]).encode()
        with patch.object(self.c, 'container_id', return_value=identity), patch.object(self.c, 'verify_image', return_value={'Config': {}}), \
                patch.object(sl.http.client, 'HTTPConnection') as native:
            self.assertEqual(self.call('messages', WINDOW)['status'], 503)
            self.assertEqual(self.call('receiver-get', {})['status'], 503)
            native.assert_not_called()
        running = {'State': {'Running': True}, 'NetworkSettings': {'Ports': {sl.API_PORT: [{'HostIp': '127.0.0.1', 'HostPort': '12345'}]}}}
        with patch.object(self.c, 'inspect', return_value=running), patch.object(sl.http.client, 'HTTPConnection') as native:
            native.return_value.request.side_effect = ConnectionRefusedError()
            self.assertEqual(self.call('sources', WINDOW)['status'], 503)
            native.assert_called_once_with('127.0.0.1', 12345, timeout=7)
            native.return_value.close.assert_called_once()

    def test_page_truncation_and_busy_native_reads(self):
        running = {'State': {'Running': True}, 'NetworkSettings': {'Ports': {sl.API_PORT: [{'HostIp': '127.0.0.1', 'HostPort': '12345'}]}}}
        with patch.object(self.c, 'inspect', return_value=running), patch.object(sl.http.client, 'HTTPConnection') as native:
            for action, limit in sl.LIMITS.items():
                with self.subTest(action=action):
                    rows = io.BytesIO(b'{"_time":"2026-02-10T10:01:02Z","hostname":"fixture"}\n' * (limit + 1))
                    response = native.return_value.getresponse.return_value
                    response.status, response.readline = 200, rows.readline
                    page = self.call(action, WINDOW)['body']
                    self.assertEqual((len(page['items']), page['truncated']), (limit, True))
        with self.c.query_slots, self.c.query_slots:
            self.assertEqual(self.call('messages', WINDOW)['status'], 429)

    def test_unix_hmac_rejects_altered_request_and_returns_json_envelope(self):
        spec = importlib.util.spec_from_file_location('pl_syslog_hmac_test', BASE / 'module-controller.py')
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        key, target, unix = os.urandom(32), '/v1/syslog', self.root / 'control.sock'
        def rpc(payload, *, valid=True):
            raw = json.dumps(payload).encode()
            ts = str(int(time.time()))
            signed = ts.encode() + b'\nPOST\n/v1/syslog\n' + raw
            signature = hmac.new(key, signed if valid else signed + b' ', hashlib.sha256).hexdigest()
            headers = f'POST {target} HTTP/1.0\r\nContent-Length: {len(raw)}\r\nX-PL-Timestamp: {ts}\r\nX-PL-Signature: {signature}\r\n\r\n'
            with socket.socket(socket.AF_UNIX) as client:
                client.connect(str(unix))
                client.sendall(headers.encode() + raw)
                response = http.client.HTTPResponse(client)
                response.begin()
                return response.status, json.loads(response.read())
        with host.Server(str(unix), host.Handler) as server, patch.object(self.c, 'host_addresses', return_value=['127.0.0.1']), \
                patch.object(self.c, 'inspect', return_value={'Id': '1' * 64}):
            server.key = key
            server.controller = types.SimpleNamespace(base=self.root / 'modules', application=lambda kind: self.c)
            worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
            worker.start()
            try:
                body = {'instance_id': self.instance, 'action': 'receiver-get', 'payload': {}}
                self.assertEqual(rpc(body, valid=False)[0], 403)
                status, result = rpc(body)
                self.assertEqual((status, result['status'], result['instance_id']), (200, 200, self.instance))
                self.assertEqual(result['body'], {**sl.DEFAULT, 'revision': 2, 'addresses': ['127.0.0.1']})
                status, absent = rpc({**body, 'instance_id': str(uuid.uuid4())})
                self.assertEqual((status, absent['status']), (200, 404))
            finally:
                server.shutdown()
                worker.join(timeout=2)

    def test_missing_instance_and_unknown_actions(self):
        self.assertEqual(self.call('other', {})['status'], 400)
        self.assertEqual(self.call('receiver-get', {'extra': True})['status'], 400)
        result = self.c.request({'instance_id': str(uuid.uuid4()), 'action': 'messages', 'payload': WINDOW})
        self.assertEqual((result['status'], result['body']['error']['code']), (404, 'syslog_not_installed'))
        self.c.docker.assert_not_called()


@unittest.skipUnless(all(os.environ.get(name) for name in ('PL_SYSLOG_TEST_DOCKER_SOCKET', 'PL_SYSLOG_TEST_IMAGE', 'PL_SYSLOG_TEST_SENDER_IMAGE')),
                     'requires a local Unix Docker socket, built Syslog role and local Python sender image')
class LocalDockerTests(unittest.TestCase):
    def test_install_receive_reconfigure_disable_enable_remove(self):
        path = Path(os.environ['PL_SYSLOG_TEST_DOCKER_SOCKET'])
        self.assertTrue(path.is_absolute() and path.is_socket())
        image = os.environ['PL_SYSLOG_TEST_IMAGE']
        def docker(*args, timeout=30):
            return subprocess.run(['docker', '--host', 'unix://' + str(path), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  timeout=timeout, check=True).stdout
        def engine(*args, **kwargs):
            try:
                return docker(*args, **kwargs)
            except subprocess.CalledProcessError:
                raise ValueError('Local Docker operation failed') from None
        obj, = json.loads(docker('image', 'inspect', image))
        installation, instance = 'pl-' + uuid.uuid4().hex[:12], str(uuid.uuid4())
        descriptor = {'id': obj['Id'], 'architecture': obj['Architecture'], 'ref': image, 'recipe': 'deploy/images/syslog.Dockerfile',
                      'labels': obj['Config']['Labels']}
        output = BASE.parent / 'output'
        with tempfile.TemporaryDirectory(dir=output) as folder:
            c = make_controller(Path(folder), installation, descriptor, engine)
            c.host_addresses = lambda: ['127.0.0.1']  # Local macOS test only binds loopback. The deployed controller enumerates Linux interfaces.
            name = c.names(instance)
            def clean():
                for kind, target in (('container', name), ('network', name + '-net'), ('volume', name + '-logs-data')):
                    try:
                        item, = json.loads(docker(kind, 'inspect', target))
                    except subprocess.CalledProcessError:
                        continue
                    labels = (item['Config'] if kind == 'container' else item)['Labels']
                    self.assertTrue(all(labels.get(k) == v for k, v in c.labels(instance).items()))
                    docker(kind, 'rm', *(['-f'] if kind == 'container' else []), target)
            def read(action, payload):
                result = c.request({'instance_id': instance, 'action': action, 'payload': payload})
                self.assertEqual(result['status'], 200, result)
                return result['body']
            def lifecycle(action):
                result = c.execute({'instance_id': instance, 'operation_id': str(uuid.uuid4()), 'module_id': 'syslog', 'action': action})
                self.assertNotEqual(result['state'], 'error', result)
                return result['state']
            with contextlib.ExitStack() as cleanup:
                cleanup.callback(clean)
                self.assertEqual(lifecycle('install'), 'running')
                initial = c.inspect(instance)
                self.assertEqual(set(initial['HostConfig']['PortBindings']), {sl.API_PORT})
                receiver = read('receiver-get', {})
                self.assertEqual(receiver, {**sl.DEFAULT, 'revision': 0, 'addresses': ['127.0.0.1']})
                with socket.socket() as reserve:
                    reserve.bind(('127.0.0.1', 0))
                    port = reserve.getsockname()[1]
                config = {**sl.DEFAULT, 'port': port, 'address': '127.0.0.1'}
                self.assertEqual(read('receiver-set', {**config, 'expected_revision': 0})['revision'], 1)
                now = datetime.now(timezone.utc)
                window = {'from': (now - timedelta(minutes=1)).isoformat(), 'to': (now + timedelta(minutes=3)).isoformat()}
                old = (now - timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
                with socket.create_connection(('127.0.0.1', port), timeout=2) as client:
                    client.sendall(f'<11>1 {old} switch-1 portd - - - uplink moved\n'.encode())
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                    stamp = (now - timedelta(minutes=2)).strftime('%b %d %H:%M:%S')
                    client.sendto(f'<14>{stamp} gateway-2 routed: office WAN online\n'.encode(), ('127.0.0.1', port))
                deadline = time.monotonic() + 10
                while True:
                    rows = read('messages', window)['items']
                    if len(rows) == 2:
                        break
                    self.assertLess(time.monotonic(), deadline, rows)
                    time.sleep(.2)
                sources = read('sources', window)
                self.assertEqual({item['source'] for item in sources['items']}, {'switch-1', 'gateway-2'})
                self.assertFalse(sources['truncated'])
                self.assertTrue(all(item['address'] for item in sources['items']))
                switch, = read('messages', {**window, 'source': 'switch-1', 'severity': '3', 'text': 'link move'})['items']
                self.assertEqual((switch['message'], switch['device_time'], switch['program'], switch['format']),
                                 ('uplink moved', old, 'portd', 'rfc5424'))
                self.assertNotEqual(switch['time'], switch['device_time'])
                self.assertEqual(read('messages', {**window, 'address': switch['address'], 'severity': '1'})['items'], [])
                self.assertEqual({item['format'] for item in rows}, {'rfc3164', 'rfc5424'})
                # A client in the same network namespace reaches the receiver from a
                # second peer IP. Reuse switch-1 and verify its two identities stay separate.
                receiver_id = c.inspect(instance)['Id']
                sender = ('import socket; s=socket.create_connection(("127.0.0.1",1514)); '
                          's.sendall(b"<12>1 ' + old + ' switch-1 test - - - local-copy\\n"); s.close()')
                docker('run', '--rm', '--pull=never', '--name', name + '-test-client', '--network', 'container:' + receiver_id,
                       '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '32m', '--pids-limit', '16',
                       os.environ['PL_SYSLOG_TEST_SENDER_IMAGE'], 'python', '-c', sender)
                deadline = time.monotonic() + 8
                while True:
                    sources = read('sources', window)['items']
                    if len(sources) == 3:
                        break
                    self.assertLess(time.monotonic(), deadline, sources)
                    time.sleep(.2)
                twins = [item for item in sources if item['source'] == 'switch-1']
                self.assertEqual({v['address'] for v in twins}, {switch['address'], '127.0.0.1'})
                self.assertEqual({v['last_message'] for v in twins}, {'uplink moved', 'local-copy'})
                with socket.create_connection(('127.0.0.1', port), timeout=2) as client:
                    client.sendall(f'<13>1 {old} switch-1 portd - - - uplink repaired\n'.encode())
                deadline = time.monotonic() + 8
                while True:
                    sources = read('sources', window)['items']
                    actual = next(v for v in sources if (v['source'], v['address']) == ('switch-1', switch['address']))
                    if actual['last_message'] == 'uplink repaired':
                        break
                    self.assertLess(time.monotonic(), deadline, sources)
                    time.sleep(.2)
                self.assertEqual(actual['severity'], '5')
                rows = read('messages', window)['items']
                self.assertEqual(len(rows), 4)
                # Occupy a different host port after preflight has succeeded but
                # before Docker starts the new receiver. The old port and data return.
                with socket.socket() as free:
                    free.bind(('127.0.0.1', 0))
                    race_port = free.getsockname()[1]
                drop = c.drop
                with socket.socket() as racer:
                    def race_after_preflight(obj):
                        drop(obj)
                        if not racer.getsockname()[1]:
                            racer.bind(('127.0.0.1', race_port))
                            racer.listen()
                    with patch.object(c, 'drop', side_effect=race_after_preflight):
                        failed = c.request({'instance_id': instance, 'action': 'receiver-set',
                                            'payload': {**config, 'port': race_port, 'expected_revision': 1}})
                self.assertEqual((failed['status'], failed['body']['error']['code']), (409, 'syslog_apply_failed'), failed)
                self.assertEqual(read('receiver-get', {})['revision'], 1)
                self.assertEqual(read('messages', window)['items'], rows)
                with socket.create_connection(('127.0.0.1', port), timeout=2):
                    pass
                self.assertEqual(read('receiver-set', {**config, 'udp': False, 'retention_days': 15, 'expected_revision': 1})['revision'], 2)
                self.assertEqual(set(c.inspect(instance)['HostConfig']['PortBindings']), {sl.API_PORT, '1514/tcp'})
                self.assertEqual(read('messages', window)['items'], rows)
                self.assertEqual(lifecycle('disable'), 'disabled')
                self.assertEqual(lifecycle('enable'), 'running')
                self.assertEqual(read('messages', window)['items'], rows)
                self.assertEqual(read('receiver-get', {})['revision'], 2)
                self.assertEqual(lifecycle('remove'), 'absent')
                self.assertFalse(c.container_id(instance))
                self.assertIsNone(c.resource(instance, 'network'))
                self.assertIsNone(c.resource(instance, 'volume'))
