"""Gateway setup, native enrollment and transaction recovery through the signed RPC handler."""
from copy import deepcopy
import hashlib
import http.server
import ipaddress
import json
from pathlib import Path
import ssl
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import test_ocserv_controller as fixtures

vpn = fixtures.vpn
setup = vpn._setup


class SetupTests(unittest.TestCase):
    def setUp(self):
        owner = fixtures.VPNControllerTests()
        owner.setUp()
        self.addCleanup(owner.doCleanups)
        self.c, self.instance = owner.c, owner.instance
        self.w = self.c.wizard
        self.obj = {'Id': 'a' * 64, 'State': {'Running': True}}
        self.config = {}
        self.profiles, self.grants = [], []
        self.w.discovery = lambda: Mock(local_inventory=lambda: (
            ['127.0.0.1'], [ipaddress.IPv4Network('192.168.4.0/24')], '127.0.0.1'))
        self.c.inspect = Mock(side_effect=lambda _iid: deepcopy(self.obj))
        self.c.call = Mock(side_effect=self.snapshot)
        self.c.stop = Mock(wraps=self.c.stop)
        self.c.start = Mock(wraps=self.c.start)
        self.c.create = Mock(side_effect=self.create)
        self.c.resource = Mock(return_value={'Id': 'owned'})
        self.c.docker.side_effect = self.docker
        self.w.check_listener = Mock()
        self.native = {'auth_mode': 'certificate', 'name': 'Корпоративный VPN', 'actor': 'local-admin',
                       'public_host': 'vpn.example.test', 'public_port': 443, 'bind_address': '127.0.0.1',
                       'port': 33443, 'pool': '10.77.0.0/24'}
        self.oidc = {**self.native, 'auth_mode': 'oidc', 'issuer': 'https://id.example.test/dex', 'client_id': 'pl-vpn'}
        self.revision = self.rpc('setup')['body']['revision']

    def snapshot(self, obj, action, payload):
        if not obj or not obj['State']['Running'] or not self.obj or not self.obj['State']['Running'] or obj['Id'] != self.obj['Id']:
            raise ValueError('Gateway is stopped')
        self.assertEqual((action, payload), ('state', {}))
        return {'status': 200, 'body': {'gateway': {**self.config, 'ready': bool(self.config)},
                'profiles': self.profiles, 'grants': self.grants, 'revision': 3, 'sessions': []}}

    def create(self, instance):
        self.assertIsNone(self.obj)
        self.obj = {'Id': 'b' * 64, 'State': {'Running': False}}
        return deepcopy(self.obj)

    def docker(self, *args, timeout=None):
        self.assertEqual((args[0], args[-1]), ('container', self.obj['Id']))
        if args[1] == 'stop':
            self.assertTrue(self.obj['State']['Running'])
            self.obj['State']['Running'] = False
        elif args[1] == 'start':
            self.assertFalse(self.obj['State']['Running'])
            self.obj['State']['Running'] = True
            gateway = self.c.operator / 'gateway.json'
            self.config = json.loads(gateway.read_bytes()) if gateway.is_file() else {}
        else:
            self.assertEqual(args[1], 'rm')
            self.assertFalse(self.obj['State']['Running'])
            self.obj = None

    def rpc(self, action, payload=None):
        return self.c.request({'instance_id': self.instance, 'action': action, 'payload': payload or {}})

    def apply(self, data=None):
        return self.rpc('configure', {'revision': self.revision, **(data or self.native)})

    def test_new_site_native_mints_only_for_current_user_and_active_certificate_generation(self):
        public = self.apply()
        self.assertEqual(public['status'], 200, public['body'])
        dto = public['body']
        self.assertTrue(dto['ready'] and dto['has_certificate'] and dto['has_key'] and dto['managed_certificates'])
        self.assertRegex(dto['certificate_pin'], r'^pin-sha256:[A-Za-z0-9+/]{43}=$')
        self.assertEqual((dto['public_host'], dto['public_port'], dto['port']), ('vpn.example.test', 443, 33443))
        self.assertTrue(self.config['managed_certificates'])
        self.assertFalse((self.c.operator / 'client-ca.key').exists())
        self.assertEqual((self.c.operations / 'client-ca.key').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.apply()['status'], 409)
        self.assertEqual(self.c.stop.call_count, 1)
        self.revision = dto['revision']
        self.assertEqual(self.apply()['body'], dto)
        self.assertEqual(self.c.stop.call_count, 1)

        user, other = 'local:1a1d5ce2-43e9-47fd-9a79-cbbfcfc91c2c', 'local:2b2d5ce2-43e9-47fd-9a79-cbbfcfc91c2c'
        cn = 'plc-' + '1' * 32
        grant = {'subject': user, 'status': 'active', 'expires_at': '', 'certificate_subject': cn}
        self.grants.append(grant)
        with patch.object(setup, 'client_pair', side_effect=AssertionError('Unexpected enrollment')):
            self.assertEqual(self.rpc('connection', {'portal_user_id': user, 'status_only': True})['status'], 200)
            self.assertEqual(self.rpc('connection', {'portal_user_id': other})['status'], 404)
        before = {p: p.stat().st_mtime_ns for p in self.c.base.rglob('*') if p.is_file()}
        downloaded = self.rpc('connection', {'portal_user_id': user})
        self.assertEqual(downloaded['status'], 200, downloaded['body'])
        result = downloaded['body']
        pubkey = setup.openssl(['pkey', '-pubout'], result['client_key_pem'].encode())
        self.assertEqual(pubkey, setup.openssl(['x509', '-pubkey', '-noout'], result['client_cert_pem'].encode()))
        self.assertIn(cn.encode(), setup.openssl(['x509', '-noout', '-subject'], result['client_cert_pem'].encode()))
        self.assertIn(b'OK', setup.openssl(['verify', '-purpose', 'sslclient', '-CAfile', str(self.c.operator / 'ca.crt')],
                                           result['client_cert_pem'].encode()))
        self.assertEqual(before, {p: p.stat().st_mtime_ns for p in self.c.base.rglob('*') if p.is_file()})
        self.assertNotIn('PRIVATE KEY', json.dumps(dto))
        for changed in ({'status': 'revoked'}, {'status': 'pending'}, {'expires_at': '2000-01-01T00:00:00Z'},
                        {'certificate_subject': user}):
            self.grants[:] = [{**grant, **changed}]
            self.assertEqual(self.rpc('connection', {'subject': user})['status'], 404)
        self.obj['State']['Running'] = False
        self.assertFalse(self.rpc('setup')['body']['ready'])
        self.assertEqual(self.rpc('connection', {'portal_user_id': user})['status'], 404)

    def test_auto_renewal_preserves_spki_and_leaves_custom_pairs_under_operator_control(self):
        first = self.apply()['body']
        self.revision = first['revision']
        key = (self.c.operator / 'server.key').read_bytes()
        old_cert = (self.c.operator / 'server.crt').read_bytes()
        new = {**self.native, 'public_host': 'vpn2.example.test'}
        renewed = self.apply(new)
        self.assertEqual(renewed['status'], 200, renewed['body'])
        self.assertEqual(renewed['body']['certificate_pin'], first['certificate_pin'])
        self.assertEqual((self.c.operator / 'server.key').read_bytes(), key)
        self.assertNotEqual((self.c.operator / 'server.crt').read_bytes(), old_cert)
        self.assertEqual(ssl._ssl._test_decode_cert(str(self.c.operator / 'server.crt'))['subjectAltName'],
                         (('DNS', 'vpn2.example.test'),))

        # A certificate about to expire can renew in place with the same key and endpoint.
        near_expiry, _ = setup.self_signed('PL VPN gateway', ['subjectAltName=DNS:vpn2.example.test'], 1, key)
        vpn.atomic(self.c.operator / 'server.crt', near_expiry)
        vpn.atomic(self.c.base / 'server-auto.json', {'certificate_sha256': hashlib.sha256(near_expiry).hexdigest(),
                                                     'pin': first['certificate_pin']})
        self.revision = self.rpc('setup')['body']['revision']
        renewed = self.apply(new)
        self.assertEqual(renewed['status'], 200)
        self.assertEqual(renewed['body']['certificate_pin'], first['certificate_pin'])
        self.assertNotEqual((self.c.operator / 'server.crt').read_bytes(), near_expiry)

        self.revision = renewed['body']['revision']
        custom, custom_key = setup.server_pair('vpn2.example.test')
        imported = self.apply({**new, 'cert_pem': custom.decode(), 'key_pem': custom_key.decode()})
        self.assertEqual(imported['status'], 200)
        self.assertNotEqual(imported['body']['certificate_pin'], first['certificate_pin'])
        self.assertFalse((self.c.base / 'server-auto.json').exists())
        self.revision = imported['body']['revision']
        self.assertEqual(self.apply(self.native)['status'], 422)
        self.assertEqual((self.c.operator / 'server.crt').read_bytes(), custom)

    def test_dex_preserves_claims_secrets_and_validates_origin_scoped_subjects(self):
        original = {**self.oidc, 'client_secret': 'fixture-client-secret', 'idp_ca_pem': setup.ca_pair()[0].decode()}
        with patch.object(setup, 'preflight_dex'):
            result = self.apply(original)
            self.assertEqual(result['status'], 200, result['body'])
            dto = result['body']
            self.assertTrue(dto['has_client_secret'] and dto['has_idp_ca'])
            self.assertNotIn('fixture-client-secret', json.dumps(dto))
            oidc_path = self.c.operator / 'oidc.json'
            provider = json.loads(oidc_path.read_bytes())
            self.assertEqual(provider['redirect_uri'], 'https://vpn.example.test/sso/callback')
            self.assertEqual(provider['required_claims'], {'iss': self.oidc['issuer'], 'aud': 'pl-vpn'})
            provider['required_claims']['groups'] = 'vpn-users'
            vpn.atomic(oidc_path, provider)
            self.revision = self.rpc('setup')['body']['revision']
            updated = self.apply({**self.oidc, 'public_port': 8443})
            self.assertEqual(updated['status'], 200, updated['body'])
            self.revision = updated['body']['revision']
            provider = json.loads(oidc_path.read_bytes())
            self.assertEqual(provider['redirect_uri'], 'https://vpn.example.test:8443/sso/callback')
            self.assertEqual(provider['required_claims']['groups'], 'vpn-users')
            self.assertEqual(provider['client_secret'], original['client_secret'])
            sub = 'alice'
            self.grants.append({'subject': sub, 'status': 'active', 'expires_at': ''})
            for issuer, want in ((self.oidc['issuer'], 200), ('https://other.test', 404)):
                identity = hashlib.sha256((issuer + '\0' + sub).encode()).hexdigest()
                download = self.rpc('connection', {'portal_user_id': identity})
                self.assertEqual(download['status'], want)
                self.assertNotIn('client_key_pem', download['body'])
            conflict = self.apply({**self.oidc, 'issuer': 'https://other.test'})
            self.assertEqual((conflict['status'], conflict['body']['error']['code']), (409, 'ocserv_active_grants'))
            cleared = self.apply({**self.oidc, 'client_secret': '', 'idp_ca_pem': ''})
            self.assertEqual(cleared['status'], 200)
            self.assertFalse(cleared['body']['has_client_secret'] or cleared['body']['has_idp_ca'])
            self.assertNotIn('client_secret', json.loads(oidc_path.read_bytes()))

    def test_invalid_settings_rejected_before_stopping_or_writing_operator(self):
        cert, key = setup.server_pair('wrong.example.test')
        self.profiles.append({'networks': ['10.55.0.0/16']})
        for changes in ({'bind_address': '192.168.4.20'}, {'port': True}, {'public_host': 'bad:port'},
                        {'pool': '192.168.4.0/24'}, {'pool': '10.55.1.0/24'}, {'pool': '0.0.0.0/8'},
                        {'cert_pem': cert.decode(), 'key_pem': key.decode()},
                        {'cert_pem': cert.decode(), 'key_pem': setup.generate_key().decode()}):
            with self.subTest(changes=list(changes)):
                self.assertEqual(self.apply({**self.native, **changes})['status'], 422)
                self.assertEqual(list(self.c.operator.iterdir()), [])
        self.c.stop.assert_not_called()
        self.assertFalse(self.w.pending(self.instance).exists())
        self.assertFalse(self.w.stage_path(self.instance).exists())

    def test_failed_restart_restores_legacy_certificate_gateway_permissions_and_published_port(self):
        old = {'name': 'Старый VPN', 'auth_mode': 'certificate', 'pool': '10.18.0.0/24'}
        vpn.atomic(self.c.operator / 'gateway.json', old, 0o644)
        cert, key = setup.server_pair(self.native['public_host'])
        for name, value, mode in (('server.crt', cert, 0o644), ('server.key', key, 0o600), ('ca.crt', setup.ca_pair()[0], 0o644)):
            vpn.atomic(self.c.operator / name, value, mode)
        old_ingress = {'address': '127.0.0.1', 'port': 33442}
        vpn.atomic(self.c.base / 'ingress.json', old_ingress)
        state_path = self.c.instances / self.instance / 'state.json'
        vpn.atomic(state_path, {**self.c.state(self.instance), 'ingress': old_ingress})
        self.config = old
        public = self.rpc('setup')['body']
        self.revision = public['revision']
        self.assertEqual((public['public_host'], public['public_port'], public['auth_mode']), ('127.0.0.1', 33442, 'certificate'))
        self.assertTrue(public['ready'])
        self.assertFalse(public['managed_certificates'])
        previous = {name: (entry[0], entry[1]) for name, entry in self.w.entries().items() if entry}
        self.w.check_listener.side_effect = OSError('TLS unavailable')
        result = self.apply()
        self.assertEqual((result['status'], result['body']['error']['code']), (503, 'ocserv_apply'))
        self.assertEqual(self.c.state(self.instance)['ingress'], old_ingress)
        self.assertEqual(self.config, old)
        self.assertTrue(self.obj['State']['Running'])
        self.assertEqual(previous, {name: (entry[0], entry[1]) for name, entry in self.w.entries().items() if entry})
        self.assertFalse(self.w.pending(self.instance).exists())
        self.assertTrue(self.rpc('setup')['body']['ready'])

    def test_same_ingress_restores_running_container_after_failed_candidate(self):
        prior = self.apply()['body']
        self.revision = prior['revision']
        previous = {name: entry[:2] for name, entry in self.w.entries().items() if entry}
        original_id = self.obj['Id']
        self.c.docker.reset_mock()
        self.w.check_listener.side_effect = OSError('Candidate TLS unavailable')
        failed = self.apply({**self.native, 'public_host': 'new.example.test'})
        self.assertEqual((failed['status'], failed['body']['error']['code']), (503, 'ocserv_apply'))
        self.assertEqual([call.args[1] for call in self.c.docker.call_args_list], ['stop', 'start', 'stop', 'start'])
        self.assertEqual((self.obj['Id'], self.obj['State']['Running']), (original_id, True))
        self.assertFalse(self.w.pending(self.instance).exists())
        self.assertEqual(previous, {name: entry[:2] for name, entry in self.w.entries().items() if entry})
        restored = self.rpc('setup')['body']
        self.assertTrue(restored['ready'])
        self.assertEqual(restored['public_host'], self.native['public_host'])

    def test_pending_transaction_recovers_on_next_read_after_process_interruption(self):
        # BaseException represents a process exit after operator files and new ingress were applied.
        with patch.object(self.w, 'ready', side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            self.apply()
        self.assertTrue(self.w.pending(self.instance).exists())
        self.assertTrue((self.c.operator / 'server.key').is_file())
        recovered = self.rpc('setup')
        self.assertEqual(recovered['status'], 200, recovered['body'])
        self.assertFalse(recovered['body']['ready'] or recovered['body']['has_certificate'])
        self.assertTrue(self.obj['State']['Running'])
        self.assertIsNone(self.c.state(self.instance)['ingress'])
        self.assertFalse(self.w.pending(self.instance).exists())
        self.assertEqual(list(self.c.operator.iterdir()), [])


class TrustedEndpointTests(unittest.TestCase):
    def test_tls_and_dex_metadata_require_the_intended_certificate_issuer_and_signing_keys(self):
        with tempfile.TemporaryDirectory() as location:
            root = Path(location)
            cert, key = setup.self_signed('Dex test', ['basicConstraints=critical,CA:TRUE',
                'keyUsage=critical,keyCertSign,digitalSignature', 'extendedKeyUsage=serverAuth', 'subjectAltName=IP:127.0.0.1'], 1)
            vpn.atomic(root / 'cert', cert)
            vpn.atomic(root / 'key', key)
            class Dex(http.server.BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def handle(self):
                    # The gateway probe verifies the TLS handshake and closes before sending HTTP.
                    try:
                        super().handle()
                    except ConnectionResetError:
                        pass

                def do_GET(self):
                    body = jwks if self.path == '/keys' else metadata
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps(body).encode())
            with http.server.HTTPServer(('127.0.0.1', 0), Dex) as server:
                port = server.server_port
                issuer = f'https://127.0.0.1:{port}'
                metadata = {'issuer': issuer, 'authorization_endpoint': issuer + '/auth', 'token_endpoint': issuer + '/token',
                            'jwks_uri': issuer + '/keys'}
                jwks = {'keys': [{'kty': 'RSA', 'kid': 'test', 'n': 'test-modulus', 'e': 'AQAB'}]}
                tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                tls.load_cert_chain(root / 'cert', root / 'key')
                server.socket = tls.wrap_socket(server.socket, server_side=True)
                worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
                worker.start()
                try:
                    setup.preflight_dex(issuer, cert)
                    setup.GatewaySetup(None, None, None).check_listener({'address': '127.0.0.1', 'port': port}, '127.0.0.1', cert)
                    with self.assertRaises(setup.Failure):
                        setup.preflight_dex(issuer, None)
                    metadata['issuer'] = issuer + '/wrong'
                    with self.assertRaises(setup.Failure):
                        setup.preflight_dex(issuer, cert)
                    metadata['issuer'] = issuer
                    jwks['keys'].clear()
                    with self.assertRaises(setup.Failure):
                        setup.preflight_dex(issuer, cert)
                finally:
                    server.shutdown()
                    worker.join(1)


if __name__ == '__main__':
    unittest.main()
