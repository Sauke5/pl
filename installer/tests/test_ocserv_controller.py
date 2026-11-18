"""Ownership, bounded gateway RPC and ingress of the local VPN module."""
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

BASE = Path(__file__).resolve().parents[1]


def load_controller(name):
    spec = importlib.util.spec_from_file_location('test_' + name, BASE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vpn = load_controller('ocserv-controller')
host = load_controller('module-controller')


class VPNControllerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        for name in ('modules', 'state', 'private'):
            (self.root / name).mkdir(mode=0o700)
        self.installation = 'pl-' + '1' * 12
        self.instance = str(uuid.uuid4())
        labels = {'pl.module.id': 'ocserv', 'org.opencontainers.image.version': '1.6.0', 'pl.upstream.version': '1.6.0',
                  'pl.module.role': 'server', 'pl.module.config.version': '1', 'pl.build.variant': 'upstream-pinned'}
        image = {'labels': labels, 'id': 'sha256:' + 'a' * 64, 'architecture': 'arm64',
                 'recipe': 'deploy/images/ocserv.Dockerfile', 'ref': 'local/ocserv'}
        vpn.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
                   'manifest_sha256': 'd' * 64, 'ocserv': {'server': image}})
        vpn.atomic(self.root / 'state/installation.json', {'install_id': self.installation, 'manifest_sha256': 'd' * 64})
        self.docker = Mock()
        self.c = vpn.OcservController(types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker))
        self.path = self.c.instances / self.instance
        self.path.mkdir(mode=0o700)
        vpn.atomic(self.path / 'state.json', {'installation': self.installation, 'instance_id': self.instance,
                                              'ingress': None, 'storage_created': True})

    def test_ingress_is_opt_in_and_binds_both_transports_on_one_address(self):
        self.assertEqual(vpn.bindings(self.c.desired_ingress()), {})
        desired = {'address': '192.0.2.1', 'port': 9443}
        vpn.atomic(self.c.base / 'ingress.json', desired)
        slot = [{'HostIp': '192.0.2.1', 'HostPort': '9443'}]
        self.assertEqual(vpn.bindings(self.c.desired_ingress()), {'4443/tcp': slot, '4443/udp': slot})
        for change in ({'address': ''}, {'address': '0.0.0.0'}, {'address': '::1'}, {'address': '224.0.0.1'},
                       {'address': '169.254.0.1'}, {'port': 65536}, {'port': True}, {'another': 'option'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                vpn.bindings({**desired, **change})

    def test_owned_state_volume_loss_aborts_before_recreate_or_start(self):
        def resources(_instance, kind, create=False):
            if kind == 'volume':
                self.assertFalse(create, 'previously created state must survive enable')
                return None
            return {'Id': 'owned-network'}
        with patch.object(self.c, 'resource', side_effect=resources), self.assertRaisesRegex(ValueError, 'volume is missing'):
            self.c.ensure(self.instance)
        self.docker.assert_not_called()

    def test_core_upgrade_can_carry_only_resource_free_initial_install(self):
        self.docker.return_value = b''
        self.assertFalse(self.c.has_unprovisioned_instance())
        state = self.c.state(self.instance)
        vpn.atomic(self.path / 'state.json', {**state, 'storage_created': False})
        self.assertTrue(self.c.has_unprovisioned_instance())
        with patch.object(self.c, 'container_id', return_value='a' * 64):
            self.assertFalse(self.c.has_unprovisioned_instance())
        with patch.object(self.c, 'resource', return_value={'Id': 'existing-network'}):
            self.assertFalse(self.c.has_unprovisioned_instance())
        def foreign_resource(*args):
            if args[:2] == ('volume', 'ls') and 'label=pl.module=ocserv' in args:
                return b'other-vpn-volume\n'
            return b''
        self.docker.side_effect = foreign_resource
        self.assertFalse(self.c.has_unprovisioned_instance())
        (self.path / 'unexpected-data').touch()
        self.assertFalse(self.c.has_unprovisioned_instance())

    def test_removal_stops_before_deleting_an_unexpected_tree(self):
        (self.path / 'other').write_bytes(b'existing data')
        with self.assertRaisesRegex(ValueError, 'Unexpected private'):
            self.c.remove(self.instance)
        self.docker.assert_not_called()

    def test_retry_after_private_state_removal_finishes_empty_instance(self):
        (self.path / 'state.json').unlink()
        with patch.object(self.c, 'resource', return_value=None), patch.object(self.c, 'container_id', return_value=''):
            self.c.remove(self.instance)
        self.assertFalse(self.path.exists())
        self.docker.assert_not_called()

    def test_native_exec_uses_verified_id_fixed_argv_and_request_on_stdin(self):
        obj = {'Id': 'b' * 64, 'State': {'Running': True}}
        self.docker.return_value = vpn.encoded({'status': 409, 'body': {'error': {'code': 'conflict', 'message': 'Обновите экран'}}})
        payload = {'revision': 2, 'subject': 'alice', 'actor': 'local-admin'}
        call = {'instance_id': self.instance, 'action': 'revoke', 'payload': payload}
        with patch.object(self.c, 'inspect', return_value=obj) as owner:
            self.assertEqual(self.c.request(call)['status'], 409)
            owner.assert_called_once_with(self.instance)
            self.docker.assert_called_once_with('exec', '-i', obj['Id'], '/usr/local/bin/pl-ocserv', 'request',
                                                input_bytes=vpn.encoded({'action': 'revoke', 'payload': payload}), timeout=25)
        self.docker.reset_mock()
        with patch.object(self.c, 'inspect', side_effect=ValueError('ownership drift')):
            self.assertEqual(self.c.request(call)['status'], 503)
        for bad in ({**call, 'action': '../request'}, {**call, 'payload': {**payload, 'command': 'test'}}):
            self.assertEqual(self.c.request(bad)['status'], 400)
        self.docker.assert_not_called()

    def test_revoke_during_disable_or_after_remove_never_reaches_gateway(self):
        call = {'instance_id': self.instance, 'action': 'revoke', 'payload': {'revision': 9, 'subject': 'alice', 'actor': 'admin'}}
        with patch.object(self.c, 'inspect', return_value={'State': {'Running': False}}):
            self.assertEqual(self.c.request(call)['status'], 409)
        call['instance_id'] = str(uuid.uuid4())
        self.assertEqual(self.c.request(call)['status'], 404)
        self.docker.assert_not_called()

    def test_signed_unix_rpc_rejects_tampering_and_unknown_instance(self):
        sock = self.root / 'control.sock'
        key = os.urandom(32)
        delivery = object.__new__(load_controller('delivery').Delivery)
        delivery.base = self.root / 'delivery'
        delivery.base.mkdir(mode=0o700)
        service = types.SimpleNamespace(base=self.root / 'modules', application=lambda kind: self.c, on_demand=True,
                                        delivery_guard=delivery.rpc_guard)
        def rpc(instance, valid=True):
            raw = vpn.encoded({'instance_id': instance, 'action': 'state', 'payload': {}})
            timestamp = str(int(time.time()))
            signed = timestamp.encode() + b'\nPOST\n/v1/ocserv\n' + raw
            signature = hmac.new(key, signed if valid else signed + b' ', hashlib.sha256).hexdigest()
            headers = f'POST /v1/ocserv HTTP/1.0\r\nContent-Length: {len(raw)}\r\nX-PL-Timestamp: {timestamp}\r\nX-PL-Signature: {signature}\r\n\r\n'
            with socket.socket(socket.AF_UNIX) as client:
                client.connect(str(sock))
                client.sendall(headers.encode() + raw)
                response = http.client.HTTPResponse(client)
                response.begin()
                return response.status, json.loads(response.read())
        with host.Server(str(sock), host.Handler) as server, patch.object(self.c, 'call', return_value={'status': 200, 'body': {'revision': 0, 'gateway': {}}}) as call, patch.object(self.c, 'inspect', return_value={'Id': 'c' * 64, 'State': {'Running': True}}):
            server.key, server.controller = key, service
            worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
            worker.start()
            try:
                self.assertEqual(rpc(self.instance, valid=False)[0], 403)
                status, missing = rpc(str(uuid.uuid4()))
                self.assertEqual((status, missing['status']), (200, 404))
                call.assert_not_called()
                status, read = rpc(self.instance)
                self.assertEqual((status, read['instance_id'], read['status']), (200, self.instance, 200))
                call.assert_called_once()
                journal = delivery.base / 'operation.json'
                vpn.atomic(journal, {'kind': 'module_upgrade', 'module_id': 'ocserv', 'scope': 'module', 'phase': 'quiescing'})
                self.assertEqual(rpc(self.instance)[0], 503)
                call.assert_called_once()
                vpn.atomic(journal, {'kind': 'module_upgrade', 'module_id': 'grafana', 'scope': 'module', 'phase': 'quiescing'})
                self.assertEqual(rpc(self.instance)[1]['status'], 200)
            finally:
                server.shutdown()
                worker.join(2)


if __name__ == '__main__':
    unittest.main()
