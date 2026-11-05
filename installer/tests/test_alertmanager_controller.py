"""Finite Alertmanager plans/lifecycle; Docker is mocked, real runtime belongs to CI."""
import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
import uuid
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pl_alertmanager_test', BASE / 'alertmanager-controller.py')
am = importlib.util.module_from_spec(spec)
spec.loader.exec_module(am)


class AlertmanagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('private', 'state', 'modules'):
            (self.root / name).mkdir(mode=0o700)
        self.installation = 'pl-123456abcdef'
        self.image = {'id': 'sha256:' + 'a' * 64, 'architecture': 'amd64', 'ref': 'pl/core-alertmanager:test',
                      'recipe': 'deploy/images/alertmanager.Dockerfile', 'labels': {
                          'org.opencontainers.image.version': '0.34.1', 'org.opencontainers.image.revision': 'b' * 40,
                          'org.opencontainers.image.source': 'https://github.com/prometheus/alertmanager',
                          'pl.module.id': 'alertmanager', 'pl.module.config.version': '1', 'pl.source.sha256': 'c' * 64}}
        am.atomic(self.root / 'state/installation.json', {'install_id': self.installation, 'manifest_sha256': 'd' * 64})
        am.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
                  'manifest_sha256': 'd' * 64, 'alertmanager': self.image})
        self.calls = []
        self.parent = types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker)
        self.controller = am.AlertmanagerController(self.parent)
        self.instance = str(uuid.uuid4())
        self.controller.initialize(self.instance)

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        if args[:2] == ('image', 'inspect'):
            return json.dumps([{'Id': self.image['id'], 'Os': 'linux', 'Architecture': 'amd64',
                               'Config': {'Labels': self.image['labels']}}]).encode()
        if args[:2] in (('volume', 'ls'), ('container', 'ls')):
            return b''
        return b'SUCCESS'

    def config(self, kind='webhook'):
        receiver = {'name': 'office', 'kind': kind, 'endpoint': 'https://notify.example/private-hook',
                    'token': 'fixture-token' if kind == 'telegram' else '', 'proxy': {'mode': 'http', 'url': 'http://proxy.example:3128',
                    'username': 'fixture-user', 'password': 'fixture-password', 'no_proxy': ['.internal.example', '10.0.0.0/8']}}
        if kind == 'telegram':
            receiver['chat_id'] = -100123456789
        return {**am.default_public(), 'route': {**am.default_public()['route'], 'receiver': 'office'}, 'receivers': [receiver]}

    def prepare(self, value=None):
        return self.controller.prepare({'instance_id': self.instance, 'configuration': value or self.config()})

    def engine(self):
        self.controller.inspect = lambda instance, allow_pending=False: {'Id': 'e' * 64, 'State': {'Running': True}}
        self.controller.wait_ready = lambda *args, **kwargs: None
        self.controller.api = lambda *args, **kwargs: b''
        def observe(instance, allow_pending=False):
            state = self.controller.active(instance, allow_pending=allow_pending)
            public = self.controller.selected(instance, state['current'])['public']
            return {'state': 'running', 'version': '0.34.1', 'endpoint': 'http://127.0.0.1:12345',
                    'configuration_revision': public['revision'], 'error': ''}
        self.controller.observe = observe

    def read_engine(self):
        """Use the real ownership inspector and observer against owned Docker data."""
        obj = {'Id': 'e' * 64, 'Image': self.image['id'], 'State': {'Running': True},
            'Config': {'Image': self.image['id'], 'Labels': self.controller.labels(self.instance),
                       'Cmd': am.FLAGS, 'Entrypoint': [am.BINARY], 'User': '65534:65534'},
            'Mounts': [{'Type': 'bind', 'Source': str(self.controller.paths(self.instance) / 'config'), 'Destination': '/etc/alertmanager', 'RW': False},
                       {'Type': 'volume', 'Name': self.controller.name(self.instance) + '-data', 'Destination': '/alertmanager', 'RW': True}],
            'NetworkSettings': {'Ports': {'9093/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19093'}]}},
            'HostConfig': {'PortBindings': {'9093/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]}, 'ReadonlyRootfs': True,
                'NetworkMode': 'bridge', 'Memory': 256 * 1024**2, 'NanoCpus': 1000000000, 'PidsLimit': 64,
                'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'], 'RestartPolicy': {'Name': 'unless-stopped'},
                'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}}}
        volume = {'Name': self.controller.name(self.instance) + '-data', 'Driver': 'local', 'Labels': self.controller.labels(self.instance)}
        original = self.controller.docker
        def docker(*args, **kwargs):
            if args[:2] == ('container', 'inspect'):
                self.calls.append(args); return json.dumps([obj]).encode()
            if args[:2] == ('container', 'ls'):
                self.calls.append(args); return obj['Id'].encode()
            if args[:2] == ('volume', 'ls'):
                self.calls.append(args); return volume['Name'].encode()
            if args[:2] == ('volume', 'inspect'):
                self.calls.append(args); return json.dumps([volume]).encode()
            if args[:2] == ('container', 'stop'):
                obj['State']['Running'] = False
            return original(*args, **kwargs)
        self.controller.docker = docker
        self.api_calls = []
        def api(container, path, reload=False):
            self.api_calls.append(path)
            if path == '/api/v2/status':
                return b'{"versionInfo":{"version":"0.34.1"},"config":{"original":"private-notification-secret"}}'
            if path == '/api/v2/alerts':
                return json.dumps([{'labels': {'alertname': 'Fresh-' + str(len(self.api_calls))}}]).encode()
            return b'OK'
        self.controller.api = api
        return obj

    def operation(self, action='configure', ref=None):
        value = {'operation_id': str(uuid.uuid4()), 'instance_id': self.instance, 'module_id': 'alertmanager', 'action': action}
        if action == 'configure':
            value['configuration_ref'] = ref
        return value

    def test_initial_configuration_has_no_notification_transport(self):
        plan = self.controller.selected(self.instance, None)
        self.assertEqual(plan['public'], am.default_public())
        self.assertEqual(plan['config']['receivers'], [{'name': 'pl-disabled'}])
        self.assertEqual(plan['config']['route']['receiver'], 'pl-disabled')
        self.assertFalse(any('configs' in key for receiver in plan['config']['receivers'] for key in receiver))

    def test_prepare_keeps_secrets_private_and_renders_explicit_proxy_auth(self):
        public = self.prepare()
        text = json.dumps(public)
        self.assertTrue(all(value not in text for value in ('fixture-password', 'fixture-token', 'private-hook')), 'Public plan must not contain notification secrets')
        plan = self.controller.plan(self.instance, public['ref'])
        config = plan['config']['receivers'][0]['webhook_configs'][0]['http_config']
        self.assertFalse(config['proxy_from_environment'])
        self.assertEqual(config['proxy_url'], 'http://proxy.example:3128')
        self.assertEqual(config['no_proxy'], 'internal.example,.internal.example,10.0.0.0/8')
        auth = config['proxy_connect_header']['Proxy-Authorization'][0]
        self.assertTrue(auth == 'Basic ' + base64.b64encode(b'fixture-user:fixture-password').decode(), 'Basic secret must be confined to the native CONNECT header')
        self.assertTrue(plan['config']['receivers'][0]['webhook_configs'][0]['url'].endswith('/private-hook'))
        path = self.controller.paths(self.instance) / 'plans' / (public['ref'] + '.json')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.controller.selected(self.instance, None)['public']['revision'], 0)

    def test_blank_secret_retention_and_changed_proxy_identity_rejection(self):
        previous = self.prepare(self.config('telegram'))
        retained = self.prepare(copy.deepcopy(previous))
        self.assertTrue(retained['receivers'][0]['proxy']['password_set'])
        self.assertTrue(retained['receivers'][0]['token_set'])
        changed = copy.deepcopy(previous); changed['receivers'][0]['proxy']['url'] = 'http://another.example:3128'
        with self.assertRaises(ValueError):
            self.prepare(changed)
        changed = copy.deepcopy(previous); changed['receivers'][0]['proxy']['username'] = 'different'
        with self.assertRaises(ValueError):
            self.prepare(changed)

    def test_telegram_token_is_not_retained_for_a_changed_api_endpoint(self):
        previous = self.prepare(self.config('telegram'))
        changed = copy.deepcopy(previous)
        changed['receivers'][0]['endpoint'] = 'https://different.example/api'
        with self.assertRaises(ValueError):
            self.prepare(changed)
        changed['receivers'][0]['token'] = 'explicit-new-fixture-token'
        updated = self.prepare(changed)
        self.assertTrue(updated['receivers'][0]['token_set'])

    def test_all_supported_native_receiver_shapes_and_telegram_default(self):
        for kind, key in (('webhook', 'url'), ('slack', 'api_url'), ('discord', 'webhook_url'), ('telegram', 'api_url')):
            value = self.config(kind)
            if kind == 'telegram':
                value['receivers'][0]['endpoint'] = ''
            public = self.prepare(value)
            plan = self.controller.plan(self.instance, public['ref'])
            native = plan['config']['receivers'][0][kind + '_configs'][0]
            self.assertTrue(key in native)
            if kind == 'telegram':
                self.assertEqual(native['api_url'], 'https://api.telegram.org')
                self.assertEqual(native['chat_id'], -100123456789)
                self.assertTrue(bool(native['bot_token']))

    def test_teams_v2_uses_native_workflow_config_and_hides_webhook(self):
        value = self.config('msteamsv2')
        public = self.prepare(value)
        plan = self.controller.plan(self.instance, public['ref'])
        native = plan['config']['receivers'][0]['msteamsv2_configs'][0]
        self.assertEqual(native['webhook_url'], value['receivers'][0]['endpoint'])
        self.assertTrue(native['send_resolved'])
        self.assertFalse(native['http_config']['proxy_from_environment'])
        self.assertFalse(native['http_config']['tls_config']['insecure_skip_verify'])
        self.assertEqual(native['http_config']['proxy_url'], 'http://proxy.example:3128')
        self.assertNotIn('private-hook', json.dumps(public))
        self.assertNotIn('fixture-password', json.dumps(public))
        self.assertNotIn('msteams_configs', plan['config']['receivers'][0])
        retained = self.prepare(copy.deepcopy(public))
        self.assertEqual(self.controller.plan(self.instance, retained['ref'])['secrets']['office']['endpoint'], value['receivers'][0]['endpoint'])

    def test_pagerduty_events_v2_default_native_config_and_private_routing_key(self):
        value = self.config('pagerduty')
        value['receivers'][0].update(endpoint='', token='fixture-routing-key')
        public = self.prepare(value)
        native = self.controller.plan(self.instance, public['ref'])['config']['receivers'][0]['pagerduty_configs'][0]
        self.assertEqual(native['url'], 'https://events.pagerduty.com/v2/enqueue')
        self.assertEqual(native['routing_key'], 'fixture-routing-key')
        self.assertNotIn('service_key', native)
        self.assertTrue(native['send_resolved'])
        self.assertIn('Proxy-Authorization', native['http_config']['proxy_connect_header'])
        self.assertTrue(public['receivers'][0]['token_set'])
        self.assertNotIn('fixture-routing-key', json.dumps(public))
        self.assertNotIn('fixture-password', json.dumps(public))

    def test_pagerduty_key_retention_is_bound_to_receiver_and_endpoint(self):
        value = self.config('pagerduty'); value['receivers'][0]['token'] = 'fixture-routing-key'
        previous = self.prepare(value)
        retained = self.prepare(copy.deepcopy(previous))
        self.assertEqual(self.controller.plan(self.instance, retained['ref'])['secrets']['office']['token'], 'fixture-routing-key')
        changed = copy.deepcopy(previous); changed['receivers'][0]['endpoint'] = 'https://different.example/events'
        with self.assertRaises(ValueError): self.prepare(changed)
        changed['receivers'][0]['token'] = 'explicit-new-routing-key'
        updated = self.prepare(changed)
        self.assertTrue(updated['receivers'][0]['token_set'])
        changed = copy.deepcopy(previous); changed['receivers'][0]['name'] = 'different'; changed['route']['receiver'] = 'different'
        with self.assertRaises(ValueError): self.prepare(changed)
        # A Telegram token cannot become a PagerDuty key through changing kind.
        telegram = self.prepare(self.config('telegram'))
        changed = copy.deepcopy(telegram); changed['receivers'][0]['kind'] = 'pagerduty'; changed['receivers'][0].pop('chat_id')
        with self.assertRaises(ValueError): self.prepare(changed)

    def test_teams_and_pagerduty_reject_wrong_channel_secrets_insecure_urls_and_templates(self):
        mutations = [('msteamsv2', {'token': 'wrong-channel-token'}),
                     ('msteamsv2', {'endpoint': 'http://workflow.example/secret'}),
                     ('pagerduty', {'token': ''}),
                     ('pagerduty', {'token': '{{ .Labels.key }}'}),
                     ('pagerduty', {'token': 'key with spaces'}),
                     ('pagerduty', {'token': 'fixture-key', 'endpoint': 'http://events.example/enqueue'}),
                     ('pagerduty', {'token': 'fixture-key', 'chat_id': 123})]
        for kind, patch in mutations:
            value = self.config(kind); value['receivers'][0].update(patch)
            with self.assertRaises(ValueError): self.prepare(value)

    def email_config(self, tls_mode='starttls'):
        value = self.config()
        value['receivers'] = [{'name': 'office', 'kind': 'email', 'smtp': {
            'smarthost': 'smtp.example.invalid:587', 'from': 'alerts@example.invalid',
            'to': ['admin@example.invalid', 'ops@example.invalid'], 'tls_mode': tls_mode,
            'username': 'smtp-user', 'password': 'fixture-smtp-password'},
            'proxy': {'mode': 'direct', 'url': '', 'username': '', 'no_proxy': []}}]
        return value

    def test_smtp_rendering_tls_modes_private_credentials_and_retention(self):
        for mode in ('starttls', 'implicit'):
            public = self.prepare(self.email_config(mode))
            receiver = public['receivers'][0]
            self.assertEqual(receiver['kind'], 'email')
            self.assertTrue(receiver['smtp']['password_set'])
            self.assertFalse(receiver['endpoint_set'])
            self.assertNotIn('fixture-smtp-password', json.dumps(public))
            native = self.controller.plan(self.instance, public['ref'])['config']['receivers'][0]['email_configs'][0]
            self.assertTrue(native['require_tls'])
            self.assertEqual(native['force_implicit_tls'], mode == 'implicit')
            self.assertFalse(native['tls_config']['insecure_skip_verify'])
            self.assertEqual(native['to'], 'admin@example.invalid,ops@example.invalid')
            self.assertEqual(native['from'], 'alerts@example.invalid')
            self.assertEqual(native['smarthost'], 'smtp.example.invalid:587')
            self.assertNotIn('http_config', native)
            self.assertEqual(native['auth_password'], 'fixture-smtp-password')
            retained = self.prepare(copy.deepcopy(public))
            self.assertTrue(retained['receivers'][0]['smtp']['password_set'])
            self.assertEqual(self.controller.plan(self.instance, retained['ref'])['secrets']['office']['smtp']['password'], 'fixture-smtp-password')

    def test_smtp_changed_identity_does_not_reuse_password_and_auth_can_be_removed(self):
        previous = self.prepare(self.email_config())
        for field, replacement in (('smarthost', 'other.example.invalid:587'), ('username', 'other-user'), ('tls_mode', 'implicit')):
            changed = copy.deepcopy(previous); changed['receivers'][0]['smtp'][field] = replacement
            with self.assertRaises(ValueError):
                self.prepare(changed)
        renamed = copy.deepcopy(previous); renamed['receivers'][0]['name'] = 'different'; renamed['route']['receiver'] = 'different'
        with self.assertRaises(ValueError):
            self.prepare(renamed)
        no_auth = copy.deepcopy(previous); no_auth['receivers'][0]['smtp']['username'] = ''
        public = self.prepare(no_auth)
        self.assertFalse(public['receivers'][0]['smtp']['password_set'])
        native = self.controller.plan(self.instance, public['ref'])['config']['receivers'][0]['email_configs'][0]
        self.assertNotIn('auth_username', native)
        self.assertNotIn('auth_password', native)

    def test_smtp_rejects_header_injection_templates_http_proxy_and_invalid_addresses(self):
        changes = [lambda r: r['smtp'].update(smarthost='smtp.example.invalid'),
                   lambda r: r['smtp'].update(smarthost='smtp.example.invalid:0'),
                   lambda r: r['smtp'].update(smarthost='smtp://smtp.example.invalid:587'),
                   lambda r: r['smtp'].update(smarthost='user:pass@smtp.example.invalid:587'),
                   lambda r: r['smtp'].update(tls_mode='none'),
                   lambda r: r['smtp'].update(username='', password='orphan-password'),
                   lambda r: r['smtp'].update(to=[]),
                   lambda r: r['smtp'].update(to=['ops@example.invalid'] * 2),
                   lambda r: r['smtp'].update(to=['ops@example.invalid'] * 33),
                   lambda r: r['smtp'].update(to=['ops@example.invalid\r\nBcc: other@example.invalid']),
                   lambda r: r['smtp'].update(to=['{{ .Labels.recipient }}']),
                   lambda r: r['smtp'].update(to=['Ops <ops@example.invalid>']),
                   lambda r: r['smtp'].update(to=['.ops@example.invalid']),
                   lambda r: r['smtp'].update(to=['ops@-example.invalid']),
                   lambda r: r['smtp'].update(**{'from': 'alerts@example.invalid\nSubject: injection'}),
                   lambda r: r['smtp'].update(headers={'Bcc': 'other@example.invalid'}),
                   lambda r: r['proxy'].update(mode='http', url='http://proxy.example:3128'),
                   lambda r: r.update(endpoint='https://notify.example.invalid'),
                   lambda r: r.update(token='unused-token')]
        for change in changes:
            value = self.email_config(); change(value['receivers'][0])
            with self.assertRaises(ValueError):
                self.prepare(value)
        value = self.config(); value['receivers'][0]['smtp'] = self.email_config()['receivers'][0]['smtp']
        with self.assertRaises(ValueError):
            self.prepare(value)

    def test_smtp_private_ca_retention_and_system_ca_restore(self):
        value = self.email_config(); value['receivers'][0]['proxy']['ca_pem'] = 'fixture-smtp-ca'
        with patch.object(am.ssl, 'create_default_context'):
            public = self.prepare(value)
            retained = self.prepare(copy.deepcopy(public))
        plan = self.controller.plan(self.instance, retained['ref'])
        self.assertEqual(list(plan['certificates'].values()), ['fixture-smtp-ca'])
        native = plan['config']['receivers'][0]['email_configs'][0]
        self.assertIn('ca_file', native['tls_config'])
        cleared = copy.deepcopy(retained); cleared['receivers'][0]['proxy']['clear_ca'] = True
        result = self.prepare(cleared)
        self.assertFalse(result['receivers'][0]['proxy']['ca_set'])
        self.assertEqual(self.controller.plan(self.instance, result['ref'])['certificates'], {})
        # Changing SMTP host requires explicit credentials and discards host-specific CA.
        changed = copy.deepcopy(public); changed['receivers'][0]['smtp'].update(smarthost='another.example.invalid:587', password='new-fixture-password')
        result = self.prepare(changed)
        self.assertFalse(result['receivers'][0]['proxy']['ca_set'])

    def test_rejects_insecure_arbitrary_or_cross_identity_settings(self):
        changes = [lambda c: c['receivers'][0].update(endpoint='http://notify.example'),
                   lambda c: c['receivers'][0].update(endpoint='https://user:pass@notify.example'),
                   lambda c: c['receivers'][0]['proxy'].update(url='http://user:pass@proxy.example:3128'),
                   lambda c: c['receivers'][0]['proxy'].update(url='socks5://proxy.example:1080'),
                   lambda c: c['receivers'][0]['proxy'].update(url='http://proxy.example'),
                   lambda c: c['receivers'][0]['proxy'].update(no_proxy=['*']),
                   lambda c: c['receivers'][0]['proxy'].update(insecure_skip_verify=True),
                   lambda c: c['route'].update(repeat_interval='1s'),
                   lambda c: c['route'].update(group_wait='169h'),
                   lambda c: c.update(remote_write=[])]
        for change in changes:
            value = self.config(); change(value)
            with self.assertRaises(ValueError):
                self.prepare(value)
        with self.assertRaises(ValueError):
            self.controller.read({'instance_id': self.instance, 'path': '/api/v2/status', 'query': ''})

    def test_ca_remains_available_in_direct_mode_and_is_written_only_for_validation(self):
        # Certificate parsing itself belongs to the real TLS CI fixture. This
        # unit verifies private retention and generated file identity/permissions.
        value = self.config(); value['receivers'][0]['proxy']['ca_pem'] = 'fixture-ca-pem'
        with patch.object(am.ssl, 'create_default_context'):
            first = self.prepare(value)
            direct = copy.deepcopy(first)
            direct['receivers'][0]['proxy'].update(mode='direct', url='', username='', no_proxy=[])
            direct['receivers'][0]['proxy']['password_set'] = False
            public = self.prepare(direct)
        self.assertTrue(public['receivers'][0]['proxy']['ca_set'])
        plan = self.controller.plan(self.instance, public['ref'])
        config = plan['config']['receivers'][0]['webhook_configs'][0]['http_config']
        self.assertFalse(config['proxy_from_environment'])
        self.assertNotIn('proxy_url', config)
        self.assertFalse(config['tls_config']['insecure_skip_verify'])
        self.assertTrue(config['tls_config']['ca_file'].startswith('/etc/alertmanager/ca-'))
        self.controller.check_plan(self.instance, public['ref'])
        command = next(args for args in self.calls if args[:2] == ('container', 'run'))
        self.assertIn('/bin/amtool', command)
        self.assertIn('check-config', command)
        self.assertIn('none', command)
        self.assertFalse((self.controller.paths(self.instance) / 'config/candidate.json').exists())
        for name in plan['certificates']:
            self.assertEqual((self.controller.paths(self.instance) / 'config' / name).stat().st_mode & 0o777, 0o444)

    def test_explicit_clear_ca_restores_system_trust_without_mutating_previous_plan(self):
        value = self.config(); value['receivers'][0]['proxy']['ca_pem'] = 'fixture-ca-pem'
        with patch.object(am.ssl, 'create_default_context'):
            first = self.prepare(value)
            clear = copy.deepcopy(first); clear['receivers'][0]['proxy']['clear_ca'] = True
            public = self.prepare(clear)
        self.assertFalse(public['receivers'][0]['proxy']['ca_set'])
        plan = self.controller.plan(self.instance, public['ref'])
        tls = plan['config']['receivers'][0]['webhook_configs'][0]['http_config']['tls_config']
        self.assertNotIn('ca_file', tls)
        self.assertFalse(tls['insecure_skip_verify'])
        self.assertTrue(self.controller.plan(self.instance, first['ref'])['certificates'])
        clear['receivers'][0]['proxy']['ca_pem'] = 'fixture-ca-pem'
        with self.assertRaises(ValueError):
            self.prepare(clear)

    def test_alerts_read_is_finite_and_status_cannot_expose_native_secret_configuration(self):
        self.read_engine()
        result = self.controller.read({'instance_id': self.instance, 'path': '/api/v2/alerts', 'query': ''})
        self.assertEqual(result['instance_id'], self.instance)
        self.assertEqual(result['status'], 200)
        self.assertEqual(result['content_type'], 'application/json')
        self.assertTrue(isinstance(json.loads(base64.b64decode(result['body'])), list))
        self.assertEqual(self.api_calls, ['/-/ready', '/api/v2/status', '/api/v2/alerts'])
        for path in ('/api/v2/status', '/api/v2/alerts?secret=x', 'https://foreign.example/api/v2/alerts'):
            with self.assertRaises(ValueError):
                self.controller.read({'instance_id': self.instance, 'path': path, 'query': ''})
        self.assertEqual(set(self.controller.status({'instance_id': self.instance})), {'state', 'version'})

    def test_alerts_remain_fresh_without_docker_and_status_does_not_extend_route_lease(self):
        self.read_engine()
        request = {'instance_id': self.instance, 'path': '/api/v2/alerts', 'query': ''}
        with patch.object(am.time, 'monotonic', return_value=100):
            first = self.controller.read(request)
        calls = len(self.calls)
        with patch.object(am.time, 'monotonic', return_value=129):
            second = self.controller.read(request)
            status = self.controller.status({'instance_id': self.instance})
        self.assertNotEqual(first['body'], second['body'])
        self.assertEqual(len(self.calls), calls)
        self.assertEqual(self.api_calls.count('/api/v2/alerts'), 2)
        self.assertEqual(status, {'state': 'running', 'version': '0.34.1'})
        self.assertEqual(self.controller._read_routes[self.instance]['expires'], 130)
        with patch.object(am.time, 'monotonic', return_value=130):
            self.controller.read(request)
        self.assertGreater(len(self.calls), calls)

    def test_alertmanager_expiry_and_explicit_health_reject_foreign_container(self):
        obj = self.read_engine()
        request = {'instance_id': self.instance, 'path': '/api/v2/alerts', 'query': ''}
        with patch.object(am.time, 'monotonic', return_value=100):
            self.controller.read(request)
        obj['Config']['Labels']['pl.installation'] = 'pl-000000000000'
        with patch.object(am.time, 'monotonic', return_value=130), self.assertRaises(ValueError):
            self.controller.read(request)
        self.assertNotIn(self.instance, self.controller._read_routes)
        obj['Config']['Labels']['pl.installation'] = self.installation
        self.controller.read(request)
        obj['HostConfig']['Privileged'] = True
        with self.assertRaises(ValueError):
            self.controller.get(self.instance)
        self.assertNotIn(self.instance, self.controller._read_routes)

    def test_alertmanager_connection_health_failure_and_mutations_revoke_cached_route(self):
        self.read_engine()
        request = {'instance_id': self.instance, 'path': '/api/v2/alerts', 'query': ''}
        self.controller.read(request)
        with patch.object(self.controller, 'api', side_effect=OSError('unreachable')):
            with self.assertRaises(OSError):
                self.controller.read(request)
        self.assertNotIn(self.instance, self.controller._read_routes)
        calls = len(self.calls)
        self.controller.read(request)
        self.assertGreater(len(self.calls), calls)
        with patch.object(self.controller, 'api', return_value=b'{"versionInfo":{"version":"foreign"}}'):
            with self.assertRaises(ValueError):
                self.controller.status({'instance_id': self.instance})
        self.assertNotIn(self.instance, self.controller._read_routes)
        self.controller.read(request)
        self.prepare()
        self.assertNotIn(self.instance, self.controller._read_routes)
        self.controller.read(request)
        self.assertEqual(self.controller.execute(self.operation(action='disable'))['state'], 'disabled')
        self.assertNotIn(self.instance, self.controller._read_routes)
        with self.assertRaises(ValueError):
            self.controller.read(request)

    def test_native_reads_hold_only_instance_lock_and_configuration_waits_without_global_lock(self):
        self.read_engine()
        # A warm read no longer creates the global lock. Create its fixture
        # before probing that the concurrent writer has not acquired it.
        fd = am.os.open(self.root / 'modules/controller.lock', am.os.O_CREAT | am.os.O_RDWR | am.os.O_NOFOLLOW, 0o600)
        am.os.close(fd)
        request = {'instance_id': self.instance, 'path': '/api/v2/alerts', 'query': ''}
        for action in ('read', 'status', 'get'):
            with self.subTest(action=action):
                entered, release, writer_started = threading.Event(), threading.Event(), threading.Event()
                original = self.controller.api
                blocked_path = '/api/v2/alerts' if action == 'read' else '/-/ready'
                def api(obj, path, reload=False):
                    if path == blocked_path:
                        entered.set()
                        if not release.wait(5):
                            raise TimeoutError('Native read was not released')
                    return original(obj, path, reload)
                def read():
                    if action == 'read': return self.controller.read(request)
                    if action == 'status': return self.controller.status({'instance_id': self.instance})
                    return self.controller.get(self.instance)
                def prepare():
                    writer_started.set()
                    return self.prepare()
                with patch.object(self.controller, 'api', side_effect=api), ThreadPoolExecutor(max_workers=2) as pool:
                    pending = pool.submit(read)
                    try:
                        self.assertTrue(entered.wait(3))
                        instance_lock = self.controller.operations / ('instance-' + self.instance + '.lock')
                        with instance_lock.open('rb') as probe:
                            with self.assertRaises(BlockingIOError):
                                am.fcntl.flock(probe, am.fcntl.LOCK_EX | am.fcntl.LOCK_NB)
                        writer = pool.submit(prepare)
                        self.assertTrue(writer_started.wait(3))
                        with (self.root / 'modules/controller.lock').open('rb') as probe:
                            am.fcntl.flock(probe, am.fcntl.LOCK_EX | am.fcntl.LOCK_NB)
                        self.assertFalse(writer.done())
                        release.set()
                        pending.result(timeout=3)
                        self.assertEqual(writer.result(timeout=3)['revision'], 1)
                    finally:
                        release.set()

    def test_successful_apply_uses_reload_and_same_operation_replays_frozen_result(self):
        self.engine(); first = self.prepare()
        body = self.operation(ref=first['ref'])
        result = self.controller.execute(body)
        self.assertEqual(result['state'], 'running')
        self.assertEqual(self.controller.state(self.instance)['current'], first['ref'])
        second = self.prepare(copy.deepcopy(first))
        self.controller.execute(self.operation(ref=second['ref']))
        self.assertTrue(self.controller.execute(body) == result, 'Replay must preserve the original operation result')
        self.assertEqual(self.controller.state(self.instance)['current'], second['ref'])

    def test_failed_reload_restores_previous_active_file_and_reports_confirmed_rollback(self):
        self.engine(); public = self.prepare()
        old = (self.controller.paths(self.instance) / 'config/config.json').read_bytes()
        calls = []
        def api(*args, **kwargs):
            calls.append(kwargs.get('reload'))
            if len(calls) == 1:
                raise ValueError('fixture reload refusal')
            return b''
        self.controller.api = api
        result = self.controller.execute(self.operation(ref=public['ref']))
        self.assertEqual(result['state'], 'error')
        self.assertTrue(result['rolled_back'])
        self.assertEqual(calls, [True, True])
        self.assertTrue((self.controller.paths(self.instance) / 'config/config.json').read_bytes() == old)
        self.assertEqual(self.controller.state(self.instance), {'current': None, 'pending': None})

    def test_unconfirmed_rollback_preserves_pending_and_same_id_can_reconcile(self):
        self.engine(); public = self.prepare(); body = self.operation(ref=public['ref'])
        self.controller.api = lambda *args, **kwargs: (_ for _ in ()).throw(ValueError('fixture reload unavailable'))
        failed = self.controller.execute(body)
        self.assertEqual(failed['state'], 'error')
        self.assertEqual(self.controller.state(self.instance)['pending']['operation_id'], body['operation_id'])
        self.controller.api = lambda *args, **kwargs: b''
        success = self.controller.execute(body)
        self.assertEqual(success['state'], 'running')
        self.assertEqual(self.controller.state(self.instance), {'current': public['ref'], 'pending': None})

    def test_process_loss_after_live_write_recovers_original_operation(self):
        self.engine(); public = self.prepare(); body = self.operation(ref=public['ref'])
        self.controller.api = lambda *args, **kwargs: (_ for _ in ()).throw(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.controller.execute(body)
        self.assertEqual(self.controller.state(self.instance)['pending']['operation_id'], body['operation_id'])
        journal = self.controller.operations / (body['operation_id'] + '.json')
        self.assertEqual(json.loads(journal.read_text())['phase'], 'running')
        self.controller.api = lambda *args, **kwargs: b''
        restored = self.controller.execute(body)
        self.assertEqual(restored['operation_id'], body['operation_id'])
        self.assertEqual(restored['state'], 'running')
        self.assertEqual(self.controller.state(self.instance)['current'], public['ref'])

    def test_partial_remove_can_resume_without_recreating_data(self):
        self.prepare()
        original = Path.unlink
        count = [0]
        def interrupt(path, *args, **kwargs):
            if path.parent.name in ('config', 'plans'):
                count[0] += 1
                if count[0] == 2:
                    raise OSError('fixture interrupted deletion')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'unlink', interrupt):
            with self.assertRaises(OSError):
                self.controller.remove(self.instance)
        self.controller.remove(self.instance)
        self.assertFalse((self.controller.instances / self.instance).exists())
        self.assertFalse(any(args[:2] == ('volume', 'create') for args in self.calls))

    def test_inspector_rejects_runtime_port_command_and_privilege_drift(self):
        self.controller.verify_image = lambda: {'Config': {'Env': [], 'WorkingDir': '/alertmanager'}}
        obj = {'Id': 'e' * 64, 'Image': self.image['id'], 'Config': {
            'Image': self.image['id'], 'Cmd': am.FLAGS, 'Entrypoint': [am.BINARY], 'User': '65534:65534',
            'Labels': self.controller.labels(self.instance), 'Env': [], 'WorkingDir': '/alertmanager'},
            'Mounts': [{'Type': 'bind', 'Source': str(self.controller.paths(self.instance) / 'config'), 'Destination': '/etc/alertmanager', 'RW': False},
                       {'Type': 'volume', 'Name': self.controller.name(self.instance) + '-data', 'Destination': '/alertmanager', 'RW': True}],
            'HostConfig': {'PortBindings': {'9093/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]}, 'ReadonlyRootfs': True,
                'NetworkMode': 'bridge', 'Memory': 256 * 1024**2, 'NanoCpus': 1000000000, 'PidsLimit': 64,
                'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'], 'RestartPolicy': {'Name': 'unless-stopped'},
                'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}}}
        self.controller.owned_volume = lambda instance: {'Name': 'owned'}
        def docker(*args, **kwargs):
            return b'owned' if args[:2] == ('container', 'ls') else json.dumps([obj]).encode()
        self.controller.docker = docker
        self.assertTrue(self.controller.inspect(self.instance) is not None)
        for mutate in (lambda v: v['HostConfig']['PortBindings']['9093/tcp'][0].update(HostIp='0.0.0.0'),
                       lambda v: v['Config'].update(Cmd=['--web.listen-address=0.0.0.0:9093']),
                       lambda v: v['HostConfig'].update(Privileged=True),
                       lambda v: v['HostConfig'].update(LogConfig={'Type': 'syslog', 'Config': {}})):
            original = copy.deepcopy(obj); mutate(obj)
            with self.assertRaises(ValueError):
                self.controller.inspect(self.instance)
            obj = original

    def test_unknown_file_blocks_removal_and_retry_removes_only_owned_files(self):
        foreign = self.controller.paths(self.instance) / 'config/keep'
        foreign.write_text('foreign')
        with self.assertRaises(ValueError):
            self.controller.remove(self.instance)
        self.assertEqual(foreign.read_text(), 'foreign')
        foreign.unlink()
        self.prepare()
        self.controller.remove(self.instance)
        self.assertFalse((self.controller.instances / self.instance).exists())
        self.controller.remove(self.instance)

    def test_private_image_descriptor_and_plan_foreign_identity_are_rejected(self):
        descriptor = self.root / 'private/module-images.json'
        value = json.loads(descriptor.read_text()); value['installation'] = 'pl-000000000000'; am.atomic(descriptor, value)
        with self.assertRaises(ValueError):
            am.AlertmanagerController(self.parent)
        public = self.prepare()
        path = self.controller.paths(self.instance) / 'plans' / (public['ref'] + '.json')
        value = json.loads(path.read_text()); value['instance_id'] = str(uuid.uuid4()); am.atomic(path, value)
        with self.assertRaises(ValueError):
            self.controller.plan(self.instance, public['ref'])


if __name__ == '__main__':
    unittest.main()
