import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
import socket
import sys
from pathlib import Path
import tempfile
import threading
import types
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pl_xray_controller', Path(__file__).resolve().parents[1] / 'xray-controller.py')
xray = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xray)


class ParserTests(unittest.TestCase):
    def test_3x_ui_reality_mlkem_uri_hint_is_compatible_with_native_xray(self):
        link = ('vless://11111111-1111-4111-8111-111111111111@example.invalid:443'
                '?encryption=none&flow=xtls-rprx-vision&fp=firefox'
                '&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&security=reality'
                '&sid=abcd&sni=example.invalid&spx=%2Ffixture&type=tcp')
        original, summary = xray.parse_outbound(link)
        for value in ('true', 'false'):
            with self.subTest(hint=value):
                private, public = xray.parse_outbound(link + '&support-x25519mlkem768=' + value)
                self.assertEqual(private, original)
                self.assertEqual(public, summary)
                self.assertNotIn('support-x25519mlkem768', json.dumps(private))
        for bad in (link + '&support-x25519mlkem768=invalid',
                    link + '&support-x25519mlkem768=true&unknown=fixture',
                    link + '&support-x25519mlkem768=true&support-x25519mlkem768=false'):
            with self.assertRaises(ValueError):
                xray.parse_outbound(bad)

    def test_vless_reality_and_tls_keep_credentials_private(self):
        account = str(uuid.uuid4())
        key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
        link = f'vless://{account}@example.invalid:443?security=reality&type=tcp&pbk={key}&sid=abcd&sni=www.example.invalid&flow=xtls-rprx-vision#Office'
        private, public = xray.parse_outbound(link)
        self.assertEqual(private['settings']['vnext'][0]['users'][0]['id'], account)
        self.assertEqual(private['streamSettings']['realitySettings']['password'], key)
        self.assertEqual(public['protocol'], 'vless')
        self.assertNotIn(account, json.dumps(public))
        self.assertNotIn(key, json.dumps(public))
        self.assertNotIn(link, json.dumps(private))
        tls, _ = xray.parse_outbound(f'vless://{account}@example.invalid:443?security=tls&alpn=h2,http%2F1.1')
        self.assertNotIn('allowInsecure', tls['streamSettings']['tlsSettings'])
        self.assertEqual(tls['streamSettings']['tlsSettings']['alpn'], ['h2', 'http/1.1'])

    def test_trojan_and_authenticated_proxy_outbounds(self):
        private, public = xray.parse_outbound('trojan://private%40password@example.invalid:443?security=tls')
        self.assertEqual(private['settings']['servers'][0]['password'], 'private@password')
        self.assertNotIn('private@password', json.dumps(public))
        for protocol in ('socks', 'socks5', 'http'):
            private, public = xray.parse_outbound(f'{protocol}://operator:password@example.invalid:1080')
            self.assertEqual(private['settings']['servers'][0]['users'], [{'user': 'operator', 'pass': 'password'}])
            self.assertEqual(public['protocol'], 'socks' if protocol == 'socks5' else protocol)

    def test_rejects_unsupported_options_without_echoing_credentials(self):
        base = 'vless://11111111-1111-4111-8111-111111111111@example.invalid:443?security=tls'
        for link in (base + '&allowInsecure=1', base + '&security=reality', base + '&type=ws',
                     base + '&unknown=secret', base + '&sni=bad%0Aname', base + '&alpn=ftp',
                     base + '&fp=unsafe', base.replace('security=tls', 'security=none'),
                     'https://subscription.invalid/secret', 'vmess://secret', 'trojan://secret@example.invalid:443?security=reality',
                     'socks://secret:password@example.invalid:1080?unknown=1'):
            with self.subTest(link=link.split(':')[0]):
                with self.assertRaises(ValueError) as caught:
                    xray.parse_outbound(link)
                self.assertNotIn('secret', str(caught.exception))
                self.assertNotIn(link, str(caught.exception))

    def test_render_has_only_loopback_api_and_aggregate_statistics(self):
        value = xray.render([], None, 'private_direct')
        self.assertEqual(value['inbounds'][0]['listen'], '127.0.0.1')
        self.assertEqual(value['inbounds'][0]['port'], 10085)
        self.assertEqual(value['api']['services'], ['StatsService'])
        self.assertNotIn('HandlerService', json.dumps(value))
        self.assertEqual(value['log']['access'], 'none')
        self.assertTrue(value['policy']['system']['statsOutboundDownlink'])
        self.assertIn('10.0.0.0/8', value['routing']['rules'][1]['ip'])
        self.assertNotIn('geoip:', json.dumps(value))


class Engine:
    """Owned engine model for finite lifecycle/crash and drift regressions."""
    def __init__(self, root, descriptor):
        self.root, self.descriptor = root, descriptor
        self.containers = {}
        self.calls = []
        self.test_error = False
        self.start_errors = 0
        self.image = {'Id': descriptor['id'], 'Os': 'linux', 'Architecture': descriptor['architecture'],
                      'Config': {'Labels': descriptor['labels'], 'Env': ['PATH=/usr/local/bin'], 'WorkingDir': '/etc/xray'}}

    def __call__(self, *args, **kwargs):
        self.calls.append(args)
        if args[:2] == ('image', 'inspect'):
            return json.dumps([self.image]).encode()
        if args[:2] == ('container', 'ls'):
            if '--filter' in args:
                name = args[args.index('--filter') + 1].removeprefix('name=^/').removesuffix('$')
                value = self.containers.get(name)
                return (value['Id'] if value else '').encode()
            return '\n'.join(o['Id'] for o in self.containers.values() if o['State']['Running']).encode()
        if args[:2] == ('container', 'inspect'):
            values = []
            for key in args[2:]:
                value = self.containers.get(key) or next(o for o in self.containers.values() if o['Id'] == key)
                values.append(value)
            return json.dumps(values).encode()
        if args[:2] == ('container', 'run'):
            if self.test_error:
                raise ValueError('private raw validation error')
            return b'Configuration OK.'
        if args[:2] == ('container', 'create'):
            name = args[args.index('--name') + 1]
            image_index = args.index(self.descriptor['id'])
            labels, ports = {}, {}
            for index, part in enumerate(args):
                if part == '--label':
                    key, value = args[index + 1].split('=', 1); labels[key] = value
                if part == '--publish':
                    host, port, internal = args[index + 1].split(':')
                    ports[internal] = [{'HostIp': host, 'HostPort': port}]
            source = args[args.index('--mount') + 1].split('source=', 1)[1].split(',')[0]
            value = {'Id': uuid.uuid4().hex * 2, 'Image': self.descriptor['id'], 'State': {'Running': False},
                     'Config': {'Labels': labels, 'Image': self.descriptor['id'], 'Cmd': list(args[image_index + 1:]),
                                'Entrypoint': [xray.BINARY], 'User': '65534:65534',
                                'Env': self.image['Config']['Env'], 'WorkingDir': '/etc/xray'},
                     'HostConfig': {'PortBindings': ports, 'ReadonlyRootfs': True, 'NetworkMode': 'bridge',
                                    'Memory': 384 * 1024**2, 'NanoCpus': 1_000_000_000, 'PidsLimit': 64,
                                    'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'], 'IpcMode': 'private'},
                     'Mounts': [{'Type': 'bind', 'Source': source, 'Destination': '/etc/xray', 'RW': False}]}
            self.containers[name] = value
            return value['Id'].encode()
        if args[:2] in (('container', 'start'), ('container', 'stop'), ('container', 'rm')):
            key = args[-1]
            name = next((n for n, o in self.containers.items() if n == key or o['Id'] == key), None)
            if name is None:
                raise ValueError('Container absent')
            if args[1] == 'start':
                if self.start_errors:
                    self.start_errors -= 1
                    raise ValueError('Injected start failure')
                self.containers[name]['State']['Running'] = True
            elif args[1] == 'stop':
                self.containers[name]['State']['Running'] = False
            else:
                del self.containers[name]
            return b''
        if args[:2] == ('container', 'exec'):
            if args[-1] == 'version':
                return ('Xray ' + self.descriptor['labels']['org.opencontainers.image.version'] + ' (fixture)\n').encode()
            if args[-1] == '--server=127.0.0.1:10085':
                return b'{"stat":[{"name":"outbound>>>proxy>>>traffic>>>uplink","value":"42"}]}'
        raise AssertionError('Unexpected finite engine command: ' + repr(args))


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'modules').mkdir(mode=0o700)
        (self.root / 'private').mkdir(mode=0o700)
        (self.root / 'state').mkdir(mode=0o700)
        self.installation = 'pl-123456abcdef'
        self.image = {'id': 'sha256:' + 'a' * 64, 'architecture': 'amd64', 'ref': 'pl/core-xray:test',
                      'recipe': 'deploy/images/xray.Dockerfile',
                      'labels': {'org.opencontainers.image.version': '1.2.3', 'org.opencontainers.image.revision': 'b' * 40,
                                 'org.opencontainers.image.source': 'https://github.com/XTLS/Xray-core',
                                 'pl.module.id': 'xray', 'pl.module.config.version': '1'}}
        xray.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
                    'manifest_sha256': 'c' * 64, 'xray': self.image})
        xray.atomic(self.root / 'state/installation.json', {'install_id': self.installation, 'manifest_sha256': 'c' * 64})
        # Unit lifecycle tests use an explicit engine model, not unrelated host ports.
        socket_patch = patch.object(xray.socket, 'socket')
        socket_patch.start(); self.addCleanup(socket_patch.stop)
        self.engine = Engine(self.root, self.image)
        self.parent = types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.engine)
        self.controller = xray.XrayController(self.parent)
        self.controller.host_addresses = lambda: {'127.0.0.1', '10.123.45.25'}
        self.instance = str(uuid.uuid4())
        result = self.controller.execute(self.operation('install'))
        self.assertEqual(result['state'], 'running', result)

    def operation(self, action, **extra):
        return {'module_id': 'xray', 'instance_id': self.instance, 'operation_id': str(uuid.uuid4()), 'action': action, **extra}

    def input(self):
        return {'revision': 0, 'ref': '', 'inbounds': [
            {'tag': 'office', 'protocol': 'socks', 'listen': '127.0.0.1', 'port': 18080,
             'auth': 'password', 'username': 'operator', 'password': 'private-password'}],
            'outbound': {'mode': 'imported', 'link': 'socks://remote:remote-secret@127.0.0.1:18081'},
            'routing': 'proxy_all'}

    def prepare(self, value=None):
        return self.controller.prepare({'instance_id': self.instance, 'configuration': value or self.input()})

    def test_install_and_disable_enable_preserve_plan_and_only_proxy_ports(self):
        install = self.operation('install')
        self.assertEqual(self.controller.execute(install)['state'], 'running')
        plan = self.prepare()
        op = self.operation('configure', configuration_ref=plan['ref'])
        self.assertEqual(self.controller.execute(op)['state'], 'running')
        obj = self.controller.inspect(self.instance)
        self.assertEqual(obj['HostConfig']['PortBindings'], {'20000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18080'}]})
        self.assertNotIn('10085/tcp', obj['HostConfig']['PortBindings'])
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertEqual(self.controller.execute(install)['state'], 'disabled', 'completed install replay must not undo disable')
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'running')
        self.assertEqual(self.controller.state(self.instance)['current'], plan['ref'])
        self.assertEqual(self.controller.status({'instance_id': self.instance})['counters'][0]['value'], 42)

    def test_prepare_redaction_immutable_plan_password_and_import_preservation(self):
        plan = self.prepare()
        self.assertNotIn('private-password', json.dumps(plan))
        self.assertNotIn('remote-secret', json.dumps(plan))
        path = self.controller.paths(self.instance) / 'plans' / (plan['ref'] + '.json')
        data = path.read_bytes()
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertIn(b'private-password', data)
        self.assertNotIn(b'socks://', data)
        value = self.input(); value.update(revision=1, ref=plan['ref'])
        value['inbounds'][0]['password'] = ''
        value['outbound'] = {'mode': 'imported', 'link': ''}
        next_plan = self.prepare(value)
        private = self.controller.plan(self.instance, next_plan['ref'])
        self.assertEqual(private['config']['inbounds'][1]['settings']['accounts'][0]['pass'], 'private-password')
        self.assertEqual(private['config']['outbounds'][0]['settings']['servers'][0]['users'][0]['pass'], 'remote-secret')
        self.assertEqual(path.read_bytes(), data, 'old immutable plan was modified')
        value['inbounds'][0]['username'] = 'other'
        with self.assertRaises(ValueError):
            self.prepare(value)

    def test_inbound_address_auth_reserved_ports_and_unknown_fields(self):
        mutations = [lambda v: v['inbounds'][0].update(listen='0.0.0.0'),
                     lambda v: v['inbounds'][0].update(listen='10.123.45.99'),
                     lambda v: v['inbounds'][0].update(port=10085),
                     lambda v: v['inbounds'][0].update(tag='api'),
                     lambda v: v['inbounds'][0].update(unknown='secret'),
                     lambda v: v['inbounds'].append(copy.deepcopy(v['inbounds'][0]))]
        for change in mutations:
            value = self.input(); change(value)
            with self.assertRaises(ValueError): self.prepare(value)

    def test_lan_socks_and_http_can_explicitly_disable_authentication(self):
        for protocol in ('socks', 'http'):
            with self.subTest(protocol=protocol):
                value = self.input()
                value['inbounds'][0].update(protocol=protocol, listen='10.123.45.25', auth='none', username='', password='')
                plan = self.prepare(value)
                private = self.controller.plan(self.instance, plan['ref'])
                self.assertEqual(plan['inbounds'][0]['auth'], 'none')
                self.assertFalse(plan['inbounds'][0]['password_set'])
                settings = private['config']['inbounds'][1]['settings']
                self.assertNotIn('accounts', settings)
                if protocol == 'socks':
                    self.assertEqual(settings['auth'], 'noauth')
                self.assertEqual(self.controller.bindings(plan)['20000/tcp'][0]['HostIp'], '10.123.45.25')

    def test_same_public_port_on_distinct_host_addresses_uses_distinct_container_ports(self):
        value = self.input(); second = copy.deepcopy(value['inbounds'][0]); second.update(tag='http', protocol='http', listen='10.123.45.25')
        value['inbounds'].append(second)
        plan = self.prepare(value)
        private = self.controller.plan(self.instance, plan['ref'])
        self.assertEqual([i['port'] for i in private['config']['inbounds'][1:]], [20000, 20001])
        self.assertEqual([i['listen'] for i in private['config']['inbounds'][1:]], ['0.0.0.0', '0.0.0.0'])

    def test_validation_uses_actual_binary_test_no_network_or_shell(self):
        plan = self.prepare()
        self.assertEqual(self.controller.validate({'instance_id': self.instance, 'configuration_ref': plan['ref']}), {'valid': True})
        command = next(c for c in self.engine.calls if c[:2] == ('container', 'run'))
        self.assertIn('none', command); self.assertIn('65534:65534', command)
        self.assertEqual(command[-4:], ('run', '-test', '-config', '/etc/xray/config.json'))
        self.assertFalse((self.controller.paths(self.instance) / 'config/candidate.json').exists())
        self.engine.test_error = True
        result = self.controller.execute(self.operation('configure', configuration_ref=plan['ref']))
        self.assertTrue(result['rolled_back']); self.assertEqual(result['configuration_revision'], 0)
        self.assertNotIn('private raw', json.dumps(result))
        self.assertEqual(self.controller.state(self.instance), {'current': None, 'pending': None})

    def test_failed_new_container_rolls_back_and_old_operation_cannot_revert_new_revision(self):
        first = self.prepare(); first_op = self.operation('configure', configuration_ref=first['ref'])
        self.assertEqual(self.controller.execute(first_op)['state'], 'running')
        value = self.input(); value.update(revision=1, ref=first['ref']); value['inbounds'][0]['port'] = 18082
        second = self.prepare(value)
        self.engine.start_errors = 1
        result = self.controller.execute(self.operation('configure', configuration_ref=second['ref']))
        self.assertTrue(result['rolled_back'], result)
        self.assertEqual(self.controller.state(self.instance)['current'], first['ref'])
        self.assertEqual(self.controller.execute(self.operation('configure', configuration_ref=second['ref']))['state'], 'running')
        self.assertEqual(self.controller.execute(first_op)['configuration_revision'], 1)
        self.assertEqual(self.controller.state(self.instance)['current'], second['ref'], 'old replay changed live config')

    def test_interrupted_apply_after_destroy_and_before_start_converges_same_operation(self):
        for phase in ('after_destroy', 'before_start'):
            with self.subTest(phase=phase):
                # Each phase uses an independent instance with revision zero.
                self.instance = str(uuid.uuid4()); self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'running')
                plan = self.prepare(); op = self.operation('configure', configuration_ref=plan['ref'])
                base = self.controller.paths(self.instance)
                xray.atomic(base / 'state.json', {'current': None, 'pending': {'operation_id': op['operation_id'], 'ref': plan['ref']}})
                self.controller.destroy_container(self.instance)
                if phase == 'before_start':
                    xray.atomic(base / 'config/config.json', xray.encoded(self.controller.plan(self.instance, plan['ref'])['config']), 0o444)
                    # Simulate create success followed by process death before start.
                    original = self.engine.__call__
                    def stopped(*args, **kwargs):
                        if args[:2] == ('container', 'start'): return b''
                        return original(*args, **kwargs)
                    self.controller.docker = stopped
                    self.controller.create_container(self.instance, plan['ref'])
                    self.controller.docker = self.engine
                result = self.controller.execute(op)
                self.assertEqual(result['state'], 'running', result)
                self.assertEqual(self.controller.state(self.instance), {'current': plan['ref'], 'pending': None})
                # The next phase uses another instance but intentionally the same
                # proxy binding. Release only this completed fixture via its real
                # owned removal path; otherwise collision rejection is correct.
                self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')
                self.assertNotIn(self.controller.name(self.instance), self.engine.containers)

    def test_foreign_instance_port_collision_rejects_without_changing_active_proxy(self):
        first_instance = self.instance
        first = self.prepare()
        self.assertEqual(self.controller.execute(self.operation('configure', configuration_ref=first['ref']))['state'], 'running')
        self.instance = str(uuid.uuid4())
        self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'running')
        conflicting = self.prepare()
        result = self.controller.execute(self.operation('configure', configuration_ref=conflicting['ref']))
        self.assertEqual(result['state'], 'error')
        self.assertTrue(result['rolled_back'], result)
        self.assertEqual(self.controller.state(self.instance), {'current': None, 'pending': None})
        self.assertEqual(self.controller.state(first_instance)['current'], first['ref'])
        self.assertEqual(self.controller.observe(first_instance)['state'], 'running')
        original = self.controller.inspect(first_instance)
        self.assertEqual(original['HostConfig']['PortBindings'], {'20000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18080'}]})

    def test_apply_and_rollback_failure_keeps_pending_owner_and_only_same_job_can_resume(self):
        plan = self.prepare(); op = self.operation('configure', configuration_ref=plan['ref'])
        self.engine.start_errors = 2
        result = self.controller.execute(op)
        self.assertEqual(result['state'], 'error'); self.assertNotIn('rolled_back', result)
        self.assertEqual(self.controller.state(self.instance)['pending']['operation_id'], op['operation_id'])
        self.assertEqual(self.controller.execute(self.operation('configure', configuration_ref=plan['ref']))['state'], 'error')
        self.assertEqual(self.controller.execute(op)['state'], 'running')
        self.assertIsNone(self.controller.state(self.instance)['pending'])

    def test_initialization_crash_after_state_resumes_but_unowned_configuration_is_rejected(self):
        other = str(uuid.uuid4()); base = self.controller.paths(other, create=True)
        xray.atomic(base / 'state.json', {'current': None, 'pending': None})
        self.assertEqual(self.controller.execute({'module_id': 'xray', 'instance_id': other, 'operation_id': str(uuid.uuid4()), 'action': 'install'})['state'], 'running')
        foreign = str(uuid.uuid4()); base = self.controller.paths(foreign, create=True)
        xray.atomic(base / 'config/config.json', b'foreign', 0o444)
        result = self.controller.execute({'module_id': 'xray', 'instance_id': foreign, 'operation_id': str(uuid.uuid4()), 'action': 'install'})
        self.assertEqual(result['state'], 'error'); self.assertEqual((base / 'config/config.json').read_bytes(), b'foreign')

    def test_foreign_ownership_drift_and_symlinks_refuse_mutations(self):
        base = self.controller.paths(self.instance)
        # Config is container-readable only behind the root-private ancestor.
        self.assertEqual(base.stat().st_mode & 0o777, 0o700)
        self.assertEqual((base / 'config').stat().st_mode & 0o777, 0o755)
        base.chmod(0o755)
        result = self.controller.execute(self.operation('refresh'))
        self.assertEqual(result['state'], 'error', 'public ancestor must be rejected')
        self.assertEqual(base.stat().st_mode & 0o777, 0o755, 'do not silently repair drift')
        base.chmod(0o700)
        obj = self.engine.containers[self.controller.name(self.instance)]
        obj['Config']['Labels']['pl.installation'] = 'foreign'
        result = self.controller.execute(self.operation('remove'))
        self.assertEqual(result['state'], 'error'); self.assertIn(self.controller.name(self.instance), self.engine.containers)
        obj['Config']['Labels']['pl.installation'] = self.installation
        base = self.controller.paths(self.instance)
        (base / 'unrelated').write_text('preserve')
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertEqual((base / 'unrelated').read_text(), 'preserve')
        (base / 'unrelated').unlink()
        path = base / 'config/config.json'; path.unlink(); path.symlink_to('/etc/passwd')
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'error')
        self.assertTrue(path.is_symlink())

    def test_remove_resumes_exact_owned_partial_deletion_and_preserves_neighbors(self):
        plan = self.prepare(); self.assertTrue(plan['ref'])
        base = self.controller.owned_files(self.instance)
        files = {}
        for path in [base / 'state.json', *(base / 'plans').iterdir(), *(base / 'config').iterdir()]:
            files[str(path.relative_to(base))] = {'mode': 0o444 if path.parent.name == 'config' else 0o600,
                                                'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        xray.atomic(self.controller.operations / ('remove-' + self.instance + '.json'),
                    {'installation': self.installation, 'instance_id': self.instance, 'files': files})
        self.controller.destroy_container(self.instance)
        (base / 'plans' / (plan['ref'] + '.json')).unlink()
        neighbor = self.controller.instances / 'unrelated'; neighbor.mkdir(mode=0o700); (neighbor / 'keep').write_text('preserve')
        op = self.operation('remove')
        self.assertEqual(self.controller.execute(op)['state'], 'absent')
        self.assertEqual(self.controller.execute(op)['state'], 'absent')
        self.assertEqual((neighbor / 'keep').read_text(), 'preserve')
        self.assertFalse(base.exists())

    def test_journal_has_only_refs_and_conflicting_operation_is_rejected(self):
        plan = self.prepare(); op = self.operation('configure', configuration_ref=plan['ref'])
        result = self.controller.execute(op); self.assertEqual(result['state'], 'running')
        raw = (self.controller.operations / (op['operation_id'] + '.json')).read_text()
        for secret in ('private-password', 'remote-secret', 'socks://'):
            self.assertNotIn(secret, raw)
        changed = {**op, 'configuration_ref': str(uuid.uuid4())}
        with self.assertRaises(ValueError): self.controller.execute(changed)

    def test_descriptor_and_image_provenance_are_bound_to_installation(self):
        self.engine.image['Id'] = 'sha256:' + 'd' * 64
        with self.assertRaises(ValueError): self.controller.verify_image()
        descriptor = self.root / 'private/module-images.json'
        value = json.loads(descriptor.read_text()); value['installation'] = 'pl-ffffffffffff'; xray.atomic(descriptor, value)
        with self.assertRaises(ValueError): xray.XrayController(self.parent)

    def test_status_queries_counters_once_and_reuses_only_identity_and_version(self):
        self.controller.revoke_runtime(self.instance)
        self.engine.calls.clear()
        values = iter((43, 44))
        def live(*args, **kwargs):
            value = self.engine(*args, **kwargs)
            if args[-1] == '--server=127.0.0.1:10085':
                return json.dumps({'stat': [{'name': 'outbound>>>proxy>>>traffic>>>uplink', 'value': str(next(values))}]}).encode()
            return value
        with patch.object(self.controller, 'docker', side_effect=live):
            first = self.controller.status({'instance_id': self.instance})
            self.assertEqual(first['counters'][0]['value'], 43)
            self.assertEqual(sum(call[-1] == 'version' for call in self.engine.calls), 1)
            self.assertEqual(sum(call[-1] == '--server=127.0.0.1:10085' for call in self.engine.calls), 1)
            self.engine.calls.clear()
            second = self.controller.status({'instance_id': self.instance})
            self.assertEqual(second['counters'][0]['value'], 44)
            self.assertEqual(len(self.engine.calls), 1)
            self.assertEqual(self.engine.calls[0][-1], '--server=127.0.0.1:10085')

    def test_status_lease_expires_without_sliding_and_rejects_foreign_runtime(self):
        self.controller.revoke_runtime(self.instance)
        with patch.object(xray.time, 'monotonic', return_value=100):
            self.controller.status({'instance_id': self.instance})
        obj = self.engine.containers[self.controller.name(self.instance)]
        obj['Config']['Labels']['pl.installation'] = 'pl-000000000000'
        with patch.object(xray.time, 'monotonic', return_value=129):
            self.controller.status({'instance_id': self.instance})
        self.assertEqual(self.controller._checked_runtimes[self.instance]['expires'], 130)
        with patch.object(xray.time, 'monotonic', return_value=130), self.assertRaises(ValueError):
            self.controller.status({'instance_id': self.instance})
        self.assertNotIn(self.instance, self.controller._checked_runtimes)

    def test_statistics_failure_revokes_identity_before_next_status(self):
        original = self.controller.docker
        def unavailable(*args, **kwargs):
            if args[-1] == '--server=127.0.0.1:10085':
                raise OSError('native statistics unavailable')
            return original(*args, **kwargs)
        with patch.object(self.controller, 'docker', side_effect=unavailable), self.assertRaises(OSError):
            self.controller.status({'instance_id': self.instance})
        self.assertNotIn(self.instance, self.controller._checked_runtimes)
        self.engine.calls.clear()
        self.controller.status({'instance_id': self.instance})
        self.assertEqual(sum(call[-1] == 'version' for call in self.engine.calls), 1)
        self.assertEqual(sum(call[-1] == '--server=127.0.0.1:10085' for call in self.engine.calls), 1)
        self.assertTrue(any(call[:2] == ('container', 'inspect') for call in self.engine.calls))

    def test_health_and_configuration_lifecycle_revoke_cached_xray_identity(self):
        obj = self.engine.containers[self.controller.name(self.instance)]
        obj['HostConfig']['Privileged'] = True
        with self.assertRaises(ValueError):
            self.controller.get(self.instance)
        self.assertNotIn(self.instance, self.controller._checked_runtimes)
        obj['HostConfig']['Privileged'] = False
        self.controller.status({'instance_id': self.instance})
        self.prepare()
        self.assertNotIn(self.instance, self.controller._checked_runtimes)
        self.controller.status({'instance_id': self.instance})
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertNotIn(self.instance, self.controller._checked_runtimes)
        self.engine.calls.clear()
        self.assertEqual(self.controller.status({'instance_id': self.instance})['counters'], [])
        self.assertFalse(any(call[-1] == '--server=127.0.0.1:10085' for call in self.engine.calls))

    def test_native_statistics_hold_instance_lock_without_blocking_other_module_lifecycles(self):
        entered, release, writer_started = threading.Event(), threading.Event(), threading.Event()
        original = self.controller.docker
        def docker(*args, **kwargs):
            if args[-1] == '--server=127.0.0.1:10085':
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('Native statistics were not released')
            return original(*args, **kwargs)
        def prepare():
            writer_started.set()
            return self.prepare()
        with patch.object(self.controller, 'docker', side_effect=docker), ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(self.controller.status, {'instance_id': self.instance})
            try:
                self.assertTrue(entered.wait(3))
                instance_lock = self.controller.operations / ('instance-' + self.instance + '.lock')
                with instance_lock.open('rb') as probe:
                    with self.assertRaises(BlockingIOError):
                        xray.fcntl.flock(probe, xray.fcntl.LOCK_EX | xray.fcntl.LOCK_NB)
                writer = pool.submit(prepare)
                self.assertTrue(writer_started.wait(3))
                with (self.root / 'modules/controller.lock').open('rb') as probe:
                    xray.fcntl.flock(probe, xray.fcntl.LOCK_EX | xray.fcntl.LOCK_NB)
                self.assertFalse(writer.done())
                release.set()
                self.assertEqual(pending.result(timeout=3)['counters'][0]['value'], 42)
                self.assertEqual(writer.result(timeout=3)['revision'], 1)
            finally:
                release.set()

    def test_statistics_reject_unbounded_or_private_names_and_dont_reset(self):
        stats = self.controller.status({'instance_id': self.instance})['counters']
        self.assertEqual(stats, [{'name': 'outbound>>>proxy>>>traffic>>>uplink', 'value': 42}])
        self.assertFalse(any('-reset' in c or '--reset' in c for c in self.engine.calls))
        original = self.engine.__call__
        def bad(*args, **kwargs):
            if args[-1] == '--server=127.0.0.1:10085':
                return b'{"stat":[{"name":"user>>>private@example.invalid>>>traffic>>>uplink","value":"1"}]}'
            return original(*args, **kwargs)
        self.controller.docker = bad
        with self.assertRaises(ValueError): self.controller.status({'instance_id': self.instance})


class PortPreflightTests(unittest.TestCase):
    def setUp(self):
        # Exercise the actual kernel bind check without an engine or root state.
        self.controller = object.__new__(xray.XrayController)
        self.controller.inspect = lambda *args, **kwargs: None
        def engine(*args):
            self.assertEqual(args, ('container', 'ls', '--format', '{{.ID}}'))
            return b''
        self.controller.docker = engine

    def check(self, port):
        self.controller.preflight_ports(str(uuid.uuid4()), {
            'inbounds': [{'listen': '127.0.0.1', 'port': port}]})

    def test_closed_proxy_connection_does_not_block_reenable(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.settimeout(3)
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            listener.listen(1)
            with socket.create_connection(('127.0.0.1', port), timeout=3) as client:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(3)
                    # The server closes first and retains its local TCP TIME_WAIT.
                    connection.shutdown(socket.SHUT_WR)
                    self.assertEqual(client.recv(1), b'')
                    client.shutdown(socket.SHUT_WR)
                    self.assertEqual(connection.recv(1), b'')
        with socket.socket() as bare:
            with self.assertRaises(OSError):
                bare.bind(('127.0.0.1', port))
        self.check(port)

    def test_live_listener_is_still_rejected(self):
        for address in ('127.0.0.1', '0.0.0.0'):
            with self.subTest(address=address), socket.socket() as listener:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind((address, 0))
                listener.listen(1)
                if sys.platform == 'darwin' and address == '0.0.0.0':
                    # Darwin admits a more specific bind beside a wildcard
                    # listener. The supported Linux host rejects this case.
                    self.check(listener.getsockname()[1])
                    continue
                with self.assertRaises(xray.XrayInputError) as caught:
                    self.check(listener.getsockname()[1])
                self.assertEqual(caught.exception.public_code, 'xray_port_in_use')

    def test_docker_nat_allocation_is_reported_without_a_kernel_listener(self):
        container = 'a' * 64
        def engine(*args):
            if args == ('container', 'ls', '--format', '{{.ID}}'):
                return (container + '\n').encode()
            self.assertEqual(args, ('container', 'inspect', container))
            return json.dumps([{'Id': container, 'HostConfig': {'PortBindings': {
                '20000/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '1080'}]}}}]).encode()
        self.controller.docker = engine
        with patch.object(xray.socket, 'socket') as probe:
            with self.assertRaises(xray.XrayInputError) as caught:
                self.check(1080)
            self.assertEqual(caught.exception.public_code, 'xray_port_in_use')
            probe.assert_not_called()

    def test_unavailable_bind_does_not_expose_operating_system_details(self):
        with patch.object(xray.socket, 'socket') as probe:
            probe.return_value.__enter__.return_value.bind.side_effect = OSError(
                xray.errno.EADDRNOTAVAIL, 'fixture-private-host-detail')
            with self.assertRaises(xray.XrayInputError) as caught:
                self.check(1080)
            self.assertEqual(caught.exception.public_code, 'xray_bind_unavailable')
            self.assertNotIn('fixture-private-host-detail', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
