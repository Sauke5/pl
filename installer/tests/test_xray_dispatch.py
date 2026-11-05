"""Parent Xray dispatch remains finite, authenticated and legacy-compatible.

No Docker, host service or network calls are needed. Real config/proxy behaviour
belongs to the controller and CI runtime suites, not these boundary tests.
"""
import contextlib
import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import Mock, patch

import test_bootstrap as bootstrap_baseline
import test_module_controller as controller_baseline

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pl_xray_parent_dispatch', BASE / 'module-controller.py')
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)


class XrayDispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.controller = pl.Controller(self.root, 'pl-123456abcdef')
        self.instance = str(uuid.uuid4())

    def test_lazy_import_only_on_demand_and_cached_per_controller(self):
        payload = self.root / 'xray-controller.py'
        payload.write_text(
            'class XrayController:\n'
            '    def __init__(self, parent):\n'
            '        parent._loaded_count = getattr(parent, "_loaded_count", 0) + 1\n'
            '        self.parent = parent\n'
        )
        self.assertFalse(hasattr(self.controller, '_loaded_count'))
        with patch.object(pl, '__file__', str(self.root / 'module-controller.py')):
            first = self.controller.xray()
            second = self.controller.xray()
        self.assertIs(first, second)
        self.assertIs(first.parent, self.controller)
        self.assertEqual(self.controller._loaded_count, 1)

    def test_missing_or_symlink_payload_never_imports(self):
        with patch.object(pl, '__file__', str(self.root / 'module-controller.py')):
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                self.controller.xray()
            target = self.root / 'foreign.py'
            target.write_text('raise AssertionError("foreign code executed")\n')
            (self.root / 'xray-controller.py').symlink_to(target)
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                self.controller.xray()
        self.assertFalse(hasattr(self.controller, '_xray_controller'))

    def test_xray_operation_dispatch_preserves_exact_frozen_reference(self):
        body = {'operation_id': str(uuid.uuid4()), 'instance_id': self.instance,
                'module_id': 'xray', 'action': 'configure',
                'configuration_ref': str(uuid.uuid4())}
        result = {'operation_id': body['operation_id'], 'state': 'running'}
        xray = types.SimpleNamespace(execute=Mock(return_value=result))
        with patch.object(self.controller, 'xray', return_value=xray), patch.object(
                pl, 'operation', side_effect=AssertionError('Prometheus dispatch selected')):
            self.assertEqual(self.controller.execute(body), result)
        xray.execute.assert_called_once_with(body)
        self.assertNotIn('configuration', body)

    def test_instance_dispatch_validates_uuid_before_selecting_xray(self):
        directory = self.controller.base / 'xray/instances' / self.instance
        directory.mkdir(parents=True)
        xray = types.SimpleNamespace(get=Mock(return_value={'state': 'running'}))
        with patch.object(self.controller, 'xray', return_value=xray):
            self.assertEqual(self.controller.get(self.instance), {'state': 'running'})
            with self.assertRaises(ValueError):
                self.controller.get('../private/plans')
        xray.get.assert_called_once_with(self.instance)

    def descriptor(self):
        return controller_baseline.ControllerTests.bundled_descriptor(self)

    def test_old_and_extended_descriptor_resolve_same_prometheus_without_xray_import(self):
        path, value, root_stat = self.descriptor()
        with patch.object(Path, 'stat', root_stat), patch.object(
                pl.importlib.util, 'spec_from_file_location', side_effect=AssertionError('eager Xray import')):
            self.assertEqual(self.controller.resolve_image(), value['prometheus']['id'])
            # Prometheus does not interpret optional Xray metadata. The Xray
            # controller validates its own descriptor only when requested.
            value['xray'] = {'id': 'sha256:' + 'd' * 64}
            path.write_text(json.dumps(value))
            self.assertEqual(self.controller.resolve_image(), value['prometheus']['id'])
            value['unknown_module'] = {}
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                self.controller.resolve_image()

    def test_extended_descriptor_still_binds_installation_manifest(self):
        path, value, root_stat = self.descriptor()
        value['xray'] = {'id': 'sha256:' + 'd' * 64}
        value['manifest_sha256'] = 'f' * 64
        path.write_text(json.dumps(value))
        with patch.object(Path, 'stat', root_stat), self.assertRaisesRegex(ValueError, 'does not match'):
            self.controller.resolve_image()

    def test_legacy_core_manifest_cannot_advertise_unbundled_xray(self):
        package = self.root / 'package'
        package.mkdir()
        files = {}
        for name in bootstrap_baseline.pl.REQUIRED | {'module-controller.py', 'xray-controller.py'}:
            (package / name).write_bytes(b'fixture')
            files[name] = hashlib.sha256(b'fixture').hexdigest()
        legacy = {
            'schema': 1, 'product': 'Pl', 'version': 'test.1', 'architecture': 'amd64',
            'features': {'module_controller': True}, 'files': files,
            'images': {'api': {'id': 'sha256:' + 'a' * 64},
                       'web': {'id': 'sha256:' + 'b' * 64},
                       'db': {'ref': 'postgres:17@sha256:' + 'c' * 64}},
        }
        manifest = package / 'manifest.json'
        manifest.write_text(json.dumps(legacy))
        with patch.object(bootstrap_baseline.pl.platform, 'machine', return_value='x86_64'):
            self.assertEqual(bootstrap_baseline.pl.manifest(package)['schema'], 1)
            legacy['features']['xray_module'] = True
            manifest.write_text(json.dumps(legacy))
            with self.assertRaisesRegex(ValueError, 'Xray|schema'):
                bootstrap_baseline.pl.manifest(package)


class SignedXrayRouteTests(unittest.TestCase):
    key = b'xray-boundary-test-key-not-a-runtime-secret'
    now = 1700000000

    def request(self, path, method='POST', value=None, signed_path=None,
                signed_method=None, signed_raw=None, signed_time=None, failure=None):
        raw = b'' if value is None else json.dumps(value).encode()
        timestamp = str(self.now if signed_time is None else signed_time)
        message = (timestamp.encode() + b'\n' + (signed_method or method).encode() + b'\n'
                   + (signed_path or path).encode() + b'\n' + (raw if signed_raw is None else signed_raw))
        headers = {'Content-Length': str(len(raw)), 'X-PL-Timestamp': timestamp,
                   'X-PL-Signature': hmac.new(self.key, message, hashlib.sha256).hexdigest()}
        calls = []
        xray = types.SimpleNamespace(**{
            action: (lambda data, action=action: calls.append((action, data)) or {'action': action})
            for action in ('prepare', 'validate', 'status')})
        if failure is not None:
            xray.prepare = Mock(side_effect=failure)
        controller = types.SimpleNamespace(xray=Mock(return_value=xray))
        handler = object.__new__(pl.Handler)
        handler.command, handler.path, handler.headers = method, path, headers
        handler.server = types.SimpleNamespace(key=self.key, controller=controller)
        handler.rfile = io.BytesIO(raw)
        replies = []
        handler.reply = lambda status, body: replies.append((status, body))
        output = io.StringIO()
        with patch.object(pl.time, 'time', return_value=self.now), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            handler.handle_request()
        self.assertEqual(output.getvalue(), '')
        return replies, calls, controller

    def test_signed_exact_paths_dispatch_and_do_not_log_private_prepare_input(self):
        for action in ('prepare', 'validate', 'status'):
            with self.subTest(action=action):
                payload = {'instance_id': str(uuid.uuid4())}
                if action == 'prepare':
                    payload['configuration'] = {'outbound': {'mode': 'imported', 'link': 'trojan://fixture-password@relay.example:443'}}
                if action == 'validate':
                    payload['configuration_ref'] = str(uuid.uuid4())
                replies, calls, controller = self.request('/v1/xray/' + action, value=payload)
                self.assertEqual(replies, [(200, {'action': action})])
                self.assertEqual(calls, [(action, payload)])
                controller.xray.assert_called_once_with()

    def test_only_reviewed_diagnostic_codes_cross_the_authenticated_boundary(self):
        for code in ('xray_invalid_outbound', 'xray_unsupported_outbound_parameters',
                     'xray_unsupported_transport', 'xray_host_addresses_unavailable',
                     'xray_invalid_bind_address', 'xray_port_in_use', 'xray_bind_unavailable',
                     'unreviewed_fixture_code', None):
            with self.subTest(code=code):
                failure = ValueError('fixture-private-parser-detail')
                failure.public_code = code
                replies, _, _ = self.request('/v1/xray/prepare', value={}, failure=failure)
                status, body = replies[0]
                self.assertEqual(status, 400)
                self.assertNotIn('fixture-private-parser-detail', json.dumps(body))
                if code and code.startswith('xray_'):
                    self.assertEqual(body['code'], code)
                else:
                    self.assertNotIn('code', body)

    def test_signature_binds_route_method_body_and_freshness_before_import(self):
        payload = {'instance_id': str(uuid.uuid4())}
        for options in (
            {'signed_path': '/v1/xray/validate'},
            {'signed_method': 'GET'},
            {'signed_raw': b'{}'},
            {'signed_time': self.now - 61},
        ):
            with self.subTest(options=options):
                replies, calls, controller = self.request('/v1/xray/status', value=payload, **options)
                self.assertEqual(replies[0][0], 403)
                self.assertEqual(calls, [])
                controller.xray.assert_not_called()

    def test_private_plans_arbitrary_rpc_queries_and_wrong_methods_have_no_route(self):
        for method, path in (
            ('GET', '/v1/xray/status'),
            ('POST', '/v1/xray/status?command=version'),
            ('POST', '/v1/xray/prepare/'),
            ('POST', '/v1/xray/exec'),
            ('POST', '/v1/xray/plans/' + str(uuid.uuid4())),
            ('GET', '/v1/xray/plans/' + str(uuid.uuid4())),
            ('POST', '/v1/xray/../private/module-images.json'),
        ):
            with self.subTest(method=method, path=path):
                replies, calls, controller = self.request(path, method, {} if method == 'POST' else None)
                self.assertEqual(replies[0][0], 404)
                self.assertEqual(calls, [])
                controller.xray.assert_not_called()


if __name__ == '__main__':
    unittest.main()
