"""Typed installation settings, real TLS checks and config-only recovery."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import tempfile
import types
import unittest
import uuid
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('pl_installation_settings_test', Path(__file__).resolve().parents[1] / 'installation-settings.py')
s = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(s)
d = s.files


def request(**values):
    return {'operation_id': str(uuid.uuid4()), 'revision': 0, 'public_url': 'https://pl.example.test:8443',
            'bind_address': '0.0.0.0', 'allowed_cidrs': ['192.0.2.0/24'], 'allowed_ports': [80, 443], **values}


class ValidationTests(unittest.TestCase):
    def test_canonical_https_origin_ipv6_and_typed_policy(self):
        result = s.validate(request(public_url='https://PL.Example.Test:443/', allowed_ports=[443, 443, 80]))
        self.assertEqual(result['public_url'], 'https://pl.example.test')
        self.assertEqual(result['allowed_ports'], [80, 443])
        self.assertEqual(s.origin('https://[2001:db8::1]:9443'), ('https://[2001:db8::1]:9443', '2001:db8::1', 9443))

    def test_no_commands_paths_credentials_query_or_invalid_scope(self):
        for url in ('http://pl.example.test', 'https://pl.example.test/path', 'https://pl.example.test?x=1',
                    'https://u:p@pl.example.test', 'https://pl.example.test/#x', 'https://0.0.0.0',
                    'https://[fe80::1%25eth0]', 'https://pl.example.test:0'):
            with self.subTest(url=url), self.assertRaises(s.ConfigurationError):
                s.validate(request(public_url=url))
        for changes in ({'allowed_cidrs': ['0.0.0.0/0']}, {'allowed_cidrs': ['192.0.2.1/24']},
                        {'allowed_ports': [True]}, {'allowed_ports': []}, {'allowed_ports': [0]},
                        {'allowed_ports': list(range(1, 66))}, {'revision': True}, {'bind_address': 'eth0'},
                        {'command': 'docker system prune'}, {'tls_key_pem': 'secret-only-key'}):
            with self.subTest(changes=changes), self.assertRaises(s.ConfigurationError):
                s.validate(request(**changes))

    def test_missing_and_explicit_empty_outbound_ca_remain_distinct(self):
        self.assertNotIn('outbound_ca_pem', s.validate(request()))
        self.assertEqual(s.validate(request(outbound_ca_pem=''))['outbound_ca_pem'], '')
        with self.assertRaises(s.ConfigurationError):
            s.validate(request(outbound_ca_pem='x' * (64 * 1024 + 1)))

    def test_port_probe_refuses_an_actual_occupied_local_port(self):
        with socket.socket(socket.AF_INET) as listener:
            listener.bind(('127.0.0.1', 0)); listener.listen()
            with self.assertRaises(s.ConfigurationError):
                s.InstallationSettings.available('127.0.0.1', listener.getsockname()[1])


class TLSValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name).resolve()
        cls.cert, cls.key = cls.root / 'tls.crt', cls.root / 'tls.key'
        cls.other_cert, cls.other_key = cls.root / 'other.crt', cls.root / 'other.key'
        for cert, key, hostname in ((cls.cert, cls.key, 'pl.example.test'), (cls.other_cert, cls.other_key, 'other.example.test')):
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-sha256', '-days', '365',
                            '-subj', '/CN=' + hostname, '-addext', 'subjectAltName=DNS:' + hostname,
                            '-keyout', str(key), '-out', str(cert)], capture_output=True, check=True)

    def service(self):
        def host(command, **kwargs):
            # Production uses /usr/bin/openssl on supported Linux hosts. This
            # Mac also carries an obsolete LibreSSL at that path.
            return d.Delivery.host([shutil.which('openssl'), *command[1:]], **kwargs)
        delivery = types.SimpleNamespace(root=self.root, parent=None, host=host)
        return s.InstallationSettings(delivery)

    def test_real_certificate_hostname_dates_and_key_matching(self):
        service = self.service()
        service.validate_tls(self.cert, self.key, 'pl.example.test')
        for cert, key, hostname in ((self.cert, self.other_key, 'pl.example.test'), (self.cert, self.key, 'different.example.test')):
            with self.subTest(hostname=hostname), self.assertRaises(s.ConfigurationError):
                service.validate_tls(cert, key, hostname)

    def test_missing_san_is_rejected_even_when_common_name_matches(self):
        cert, key = self.root / 'nosan.crt', self.root / 'nosan.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '365', '-subj', '/CN=pl.example.test',
                        '-keyout', str(key), '-out', str(cert)], capture_output=True, check=True)
        with self.assertRaises(s.ConfigurationError):
            self.service().validate_tls(cert, key, 'pl.example.test')

    def test_public_outbound_bundle_accepts_multiple_certificates_and_rejects_keys_or_junk(self):
        bundle = self.root / 'bundle.pem'
        bundle.write_bytes(self.cert.read_bytes() + self.other_cert.read_bytes())
        self.service().validate_outbound_ca(bundle)
        for raw in (self.key.read_bytes(), self.cert.read_bytes() + b'not a certificate', b'-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'):
            bundle.write_bytes(raw)
            with self.assertRaises(s.ConfigurationError):
                self.service().validate_outbound_ca(bundle)


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('state', 'private', 'config', 'modules', 'releases'):
            (self.root / name).mkdir(mode=0o700)
        self.installation = 'pl-123456abcdef'
        self.config = {'public_url': 'https://pl.example.test:8443', 'hostname': 'pl.example.test', 'port': 8443,
                       'bind_address': '0.0.0.0', 'admin_user': 'admin', 'custom_tls': False}
        self.state = {'product': 'PL', 'install_id': self.installation, 'version': '0.3.0', 'phase': 'ready',
                      'config': self.config, 'manifest_sha256': 'a' * 64, 'config_revision': 0}
        self.model = {'services': {'api': {'image': 'sha256:' + 'a' * 64,
            'environment': {'PORTAL_PUBLIC_URL': self.config['public_url'], 'PORTAL_ALLOWED_CIDRS': '127.0.0.1/32', 'PORTAL_ALLOWED_PORTS': '80,443',
                            'PORTAL_DATABASE_URL': 'private-database-url'}, 'volumes': ['local-auth:/run/pl-auth']},
            'web': {'image': 'sha256:' + 'b' * 64, 'ports': [{'target': 8443, 'published': '8443', 'host_ip': '0.0.0.0', 'protocol': 'tcp'}]}}}
        d.atomic(self.root / 'state/installation.json', self.state)
        d.atomic(self.root / 'config/compose.json', self.model)
        d.atomic(self.root / 'private/tls.crt', b'current public certificate')
        d.atomic(self.root / 'private/tls.key', b'CURRENT-PRIVATE-TLS-KEY')
        (self.root / 'private/tls.crt').chmod(0o444)
        self.parent = types.SimpleNamespace(root=self.root, installation=self.installation, docker=Mock())
        self.delivery = d.Delivery(self.parent)
        self.delivery.catalog = lambda: None
        self.delivery.worker_active = Mock(return_value=True)
        self.service = s.InstallationSettings(self.delivery)
        self.service.origin_helper = lambda: None
        if not hasattr(os, 'listxattr'):
            missing = patch.object(s.os, 'listxattr', return_value=[], create=True)
            missing.start(); self.addCleanup(missing.stop)
        if os.getuid() != 0:
            # File ownership is exercised without mocks in Linux acceptance.
            ownership = patch.object(s.os, 'chown')
            ownership.start(); self.addCleanup(ownership.stop)

    def prepare(self, body):
        self.service.preflight_port = Mock()
        self.service.validate_tls = Mock()
        self.service.validate_outbound_ca = Mock()
        def prepare(folder, value, state):
            d.atomic(folder / 'tls.crt', b'next public certificate')
            d.atomic(folder / 'tls.key', b'NEXT-PRIVATE-TLS-KEY')
            return True, True
        self.service.prepare_tls = prepare
        def launch(operation, recovering):
            operation['worker_unit'] = self.installation + '-upgrade-' + uuid.UUID(operation['operation_id']).hex + '.service'
            d.atomic(self.delivery.base / 'operation.json', operation)
        self.delivery._launch = Mock(side_effect=launch)
        return self.service.configure(body)

    def test_status_projects_effective_policy_and_never_private_key_or_database_url(self):
        d.atomic(self.delivery.base / 'operation.json', {'operation_id': str(uuid.uuid4()), 'phase': 'complete', 'kind': 'configuration',
            'tls_key_pem': 'SHOULD-NEVER-BE-PROJECTED', 'private_request': {'key': 'SHOULD-NEVER-BE-PROJECTED'}})
        result = self.service.status({})
        self.assertEqual(result['allowed_cidrs'], ['127.0.0.1/32'])
        self.assertEqual(result['allowed_ports'], [80, 443])
        for forbidden in ('CURRENT-PRIVATE-TLS-KEY', 'private-database-url', 'SHOULD-NEVER-BE-PROJECTED'):
            self.assertNotIn(forbidden, json.dumps(result))
            self.assertNotIn(forbidden, json.dumps(self.delivery.status({}, refresh=False)))

    def test_active_settings_helper_loads_without_shadowing_installation_identity(self):
        package = self.root / 'releases/0.3.0'; package.mkdir()
        source = Path(__file__).resolve().parents[1]
        for name in ('delivery.py', 'installation-settings.py'):
            (package / name).write_bytes((source / name).read_bytes())
        (package / 'release-signing-public.pem').write_bytes(b'fixture pinned release authority')
        digest = hashlib.sha256((package / 'installation-settings.py').read_bytes()).hexdigest()
        d.atomic(package / 'manifest.json', {'files': {'installation-settings.py': digest}})
        d.atomic(self.root / 'state/controller-active.json', {'schema': 1, 'version': '0.3.0'})
        self.delivery.supervisor = package
        helper = self.delivery.installation_settings()
        self.assertEqual(self.delivery.installation, self.installation)
        self.assertEqual(helper.status({})['core_api'], 1)
        self.assertEqual(helper.status({})['revision'], 0)

    def test_optimistic_revision_rejects_stale_write_before_tls_or_host_changes(self):
        self.service.preflight_port = Mock()
        with self.assertRaises(s.ConfigurationError) as failed:
            self.service.configure(request(revision=1))
        self.assertEqual(failed.exception.public_code, 'installation_conflict')
        self.service.preflight_port.assert_not_called()
        self.parent.docker.assert_not_called()

    def test_acceptance_stages_key_privately_and_retries_same_operation_without_relaunch(self):
        body = request()
        first = self.prepare(body)
        self.assertEqual(first['operation']['next_url'], self.config['public_url'])
        self.assertNotIn('NEXT-PRIVATE-TLS-KEY', json.dumps(first))
        path = self.root / 'private/installation-configurations' / body['operation_id']
        self.assertEqual((path / 'tls.key').stat().st_mode & 0o777, 0o600)
        self.assertNotIn('PRIVATE-TLS-KEY', (path / 'request.json').read_text())
        self.service.configure(body)
        self.delivery._launch.assert_called_once()
        with self.assertRaises(s.ConfigurationError):
            self.service.configure({**body, 'allowed_ports': [9443]})

    def test_missing_module_origin_migration_fails_before_launch(self):
        instances = self.root / 'modules/forms'; instances.mkdir()
        (instances / 'instances').mkdir(); (instances / 'instances' / str(uuid.uuid4())).mkdir()
        with self.assertRaises(s.ConfigurationError) as failed:
            self.prepare(request(public_url='https://new.example.test:8443'))
        self.assertEqual(failed.exception.public_code, 'installation_origin_modules')
        self.assertIn('forms', failed.exception.public_message)
        self.delivery._launch.assert_not_called()

    def test_tls_rotation_requires_doska_trust_migration(self):
        instances = self.root / 'modules/doska'; instances.mkdir()
        (instances / 'instances').mkdir(); (instances / 'instances' / str(uuid.uuid4())).mkdir()
        with self.assertRaises(s.ConfigurationError) as failed:
            self.prepare(request())
        self.assertEqual(failed.exception.public_code, 'installation_tls_modules')

    def runtime(self):
        self.service.available = Mock()
        self.service.readback = Mock()
        self.delivery.compose = Mock()
        self.delivery.readiness = Mock()
        self.parent.docker.return_value = d.json_bytes([{'Config': {'User': '101:101'}}])

    def test_apply_preserves_database_and_auth_and_persists_typed_network_policy(self):
        body = request(allowed_ports=[443, 9443])
        self.prepare(body); self.runtime()
        self.service.perform()
        state = self.delivery.state()
        self.assertEqual(state['config_revision'], 1)
        self.assertEqual(state['config']['allowed_ports'], [443, 9443])
        current = d.read(self.root / 'config/compose.json')
        self.assertEqual(current['services']['api']['environment']['PORTAL_DATABASE_URL'], 'private-database-url')
        self.assertEqual(current['services']['api']['environment']['PORTAL_CHECK_ALLOWED_PORTS'], '443,9443')
        self.assertEqual(current['services']['api']['volumes'], ['local-auth:/run/pl-auth'])
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'complete')
        self.assertFalse((self.root / 'private/installation-configurations' / body['operation_id'] / 'tls.key').exists())
        self.assertEqual((self.root / 'private/tls.key').stat().st_mode & 0o777, 0o640)
        for call in self.delivery.compose.call_args_list:
            self.assertNotIn('db', call.args)

    def test_failure_after_config_change_restores_previous_tls_policy_revision_and_url(self):
        body = request(public_url='https://next.example.test:9443', outbound_ca_pem='outbound public CA')
        self.prepare(body); self.runtime()
        def ready():
            if self.delivery.state()['config_revision'] == 1:
                raise ValueError('Injected HTTPS validation failure')
        self.delivery.readiness = ready
        self.service.perform()
        self.assertEqual(self.delivery.state(), self.state)
        self.assertEqual(d.read(self.root / 'config/compose.json'), self.model)
        self.assertEqual((self.root / 'private/tls.key').read_bytes(), b'CURRENT-PRIVATE-TLS-KEY')
        self.assertEqual((self.root / 'private/tls.crt').read_bytes(), b'current public certificate')
        self.assertFalse((self.root / 'private/outbound-ca.pem').exists())
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'rolled_back')

    def test_outbound_ca_apply_preserve_and_explicit_clear(self):
        body = request(outbound_ca_pem='public CA')
        self.prepare(body); self.runtime(); self.service.perform()
        current = d.read(self.root / 'config/compose.json')
        self.assertEqual(current['services']['api']['environment']['PORTAL_OUTBOUND_CA_FILE'], '/run/secrets/outbound-ca.pem')
        self.assertEqual((self.root / 'private/outbound-ca.pem').read_text(), 'public CA')
        keep = request(revision=1)
        self.prepare(keep); self.runtime(); self.service.perform()
        self.assertEqual((self.root / 'private/outbound-ca.pem').read_text(), 'public CA')
        clear = request(revision=2, outbound_ca_pem='')
        self.prepare(clear); self.runtime(); self.service.perform()
        self.assertFalse((self.root / 'private/outbound-ca.pem').exists())
        final = d.read(self.root / 'config/compose.json')['services']['api']
        self.assertNotIn('PORTAL_OUTBOUND_CA_FILE', final['environment'])
        self.assertFalse(any(isinstance(v, dict) and v.get('target') == '/run/secrets/outbound-ca.pem' for v in final['volumes']))

    def test_non_owned_bind_address_and_foreign_docker_port_conflict_are_rejected(self):
        self.delivery.host = Mock(return_value=d.json_bytes([{'addr_info': [{'local': '192.0.2.10'}]}]))
        self.parent.docker.return_value = b''
        with self.assertRaises(s.ConfigurationError):
            self.service.preflight_port(s.validate(request(bind_address='192.0.2.99')), self.config)
        foreign = [{'Config': {'Labels': {}}, 'HostConfig': {'PortBindings': {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '9443'}]}}}]
        self.parent.docker.side_effect = [b'foreign-id', d.json_bytes(foreign)]
        with self.assertRaises(s.ConfigurationError):
            self.service.preflight_port(s.validate(request(public_url='https://pl.example.test:9443')), self.config)

    def test_runtime_readback_rejects_environment_or_published_port_drift(self):
        expected = copy.deepcopy(self.model)
        expected['services']['api']['environment'].update({'PORTAL_CHECK_INHERIT_INTEGRATION_POLICY': 'false',
            'PORTAL_CHECK_ALLOWED_CIDRS': '127.0.0.1/32', 'PORTAL_CHECK_ALLOWED_PORTS': '80,443'})
        drift = None
        def engine(*args, **kwargs):
            if args[:2] == ('container', 'ls'):
                return b'api-id' if any(v.endswith('service=api') for v in args) else b'web-id'
            role = 'api' if args[-1] == 'api-id' else 'web'
            actual = {'Image': expected['services'][role]['image'], 'State': {'Running': True},
                      'Config': {'Env': [k + '=' + v for k, v in expected['services']['api']['environment'].items()]},
                      'HostConfig': {'PortBindings': {'8443/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '8443'}]}}}
            if role == 'api' and drift == 'environment':
                actual['Config']['Env'] = ['PORTAL_PUBLIC_URL=https://foreign.example.test']
            if role == 'web' and drift == 'port':
                actual['HostConfig']['PortBindings']['8443/tcp'][0]['HostPort'] = '9443'
            return d.json_bytes([actual])
        self.parent.docker.side_effect = engine
        self.service.readback(self.config, expected)
        for drift in ('environment', 'port'):
            with self.subTest(drift=drift), self.assertRaises(ValueError):
                self.service.readback(self.config, expected)

    def test_configuration_snapshot_corruption_is_rejected_before_stopping_core(self):
        body = request()
        self.prepare(body); self.runtime()
        operation = d.read(self.delivery.base / 'operation.json')
        snapshot = self.service.snapshot(operation)
        (snapshot / '0').write_text('corrupted configuration backup')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            self.service.rollback()
        self.delivery.compose.assert_not_called()
        self.assertEqual(d.read(self.root / 'config/compose.json'), self.model)


if __name__ == '__main__':
    unittest.main()
