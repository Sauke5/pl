import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import base64
import http.server
import io
from concurrent.futures import ThreadPoolExecutor
import threading
import unittest
import uuid
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('pl_module_controller', Path(__file__).resolve().parents[1] / 'module-controller.py')
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.controller = pl.Controller(self.root, 'pl-123456abcdef')
        self.instance = str(uuid.uuid4())
        self.body = {'operation_id': str(uuid.uuid4()), 'instance_id': self.instance,
                     'module_id': 'prometheus', 'action': 'install'}

    def bundled_descriptor(self):
        private, state = self.root / 'private', self.root / 'state'
        private.mkdir(mode=0o700)
        state.mkdir(mode=0o750)
        value = {'schema': 1, 'installation': self.controller.installation, 'manifest_sha256': 'b' * 64,
                 'prometheus': {'id': 'sha256:' + 'a' * 64, 'architecture': 'amd64', 'ref': 'pl/core-prometheus:test',
                                'recipe': 'deploy/images/prometheus.Dockerfile',
                                'labels': {'pl.module.id': 'prometheus', 'pl.module.config.version': '1', 'org.opencontainers.image.version': '3.15.0',
                                           'pl.build.go': '1.27.2', 'pl.build.x-net': 'v0.61.0', 'pl.source.sha256': 'c' * 64}}}
        path = private / 'module-images.json'
        path.write_text(json.dumps(value)); path.chmod(0o600)
        statepath = state / 'installation.json'
        statepath.write_text(json.dumps({'install_id': self.controller.installation, 'manifest_sha256': 'b' * 64, 'package_schema': 2}))
        statepath.chmod(0o600)
        original_stat = Path.stat
        def root_stat(p, *args, **kwargs):
            result = original_stat(p, *args, **kwargs)
            if p in (private, state, path, statepath):
                values = list(result); values[4] = 0
                return os.stat_result(values)
            return result
        return path, value, root_stat

    def test_controller_resolves_bundled_identity_without_api_image_argument(self):
        path, value, root_stat = self.bundled_descriptor()
        with patch.object(Path, 'stat', root_stat):
            controller = pl.Controller(self.root, self.controller.installation)
            self.assertEqual(controller.image, value['prometheus']['id'])
            calls = []
            def docker(*args, **kwargs):
                calls.append(args)
                return json.dumps([{'Id': controller.image, 'Os': 'linux', 'Architecture': 'amd64',
                                    'Config': {'Labels': value['prometheus']['labels']}}]).encode()
            controller.docker = docker
            controller.verify_image()
            self.assertEqual(calls, [('image', 'inspect', controller.image)])

    def test_minimal_controller_starts_without_optional_image_or_download(self):
        path, value, root_stat = self.bundled_descriptor()
        value.pop('prometheus')
        path.write_text(json.dumps(value))
        (self.root / 'config').mkdir(mode=0o700)
        (self.root / 'config/delivery.json').write_text(json.dumps({'schema': 1, 'catalog_url': 'https://github.com/Sauke5/pl/releases/download/channel-stable/catalog.json'}))
        with patch.object(Path, 'stat', root_stat), patch.object(pl.subprocess, 'run') as command:
            controller = pl.Controller(self.root, self.controller.installation)
            self.assertTrue(controller.on_demand)
            self.assertIsNone(controller.image)
            self.assertFalse(hasattr(controller, '_delivery'))
            command.assert_not_called()

    def test_controller_rejects_descriptor_foreign_identity_permissions_and_symlink(self):
        path, value, root_stat = self.bundled_descriptor()
        with patch.object(Path, 'stat', root_stat):
            value['installation'] = 'pl-000000000000'
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, 'identity'):
                self.controller.resolve_image()
            value['installation'] = self.controller.installation
            path.write_text(json.dumps(value)); path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                self.controller.resolve_image()
            path.chmod(0o600)
            target = path.with_name('foreign.json'); path.rename(target); path.symlink_to(target)
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                self.controller.resolve_image()

    def test_schema2_missing_descriptor_does_not_fall_back_to_official_image(self):
        path, value, root_stat = self.bundled_descriptor()
        path.unlink()
        with self.assertRaisesRegex(ValueError, 'missing'):
            self.controller.resolve_image()

    def configuration(self, revision=1):
        return {'revision': revision, 'global': {'scrape_interval': '15s', 'scrape_timeout': '10s'},
                'jobs': [{'name': 'node', 'enabled': True, 'scrape_interval': '30s', 'scrape_timeout': '5s',
                          'metrics_path': '/metrics', 'scheme': 'http',
                          'targets': [{'address': 'node.example:9100', 'labels': {'site': 'lab'}}]}]}

    def configure_engine(self):
        self.controller.config(self.instance)
        self.controller.inspect = lambda instance: {'Id': 'a' * 64, 'State': {'Running': True}}
        self.controller.observe = lambda instance: {'state': 'running', 'error': ''}
        self.controller.docker = lambda *args, **kwargs: b'SUCCESS'
        self.controller.reload_configuration = lambda obj: 'global: {}'
        self.controller.confirm_targets = lambda obj, value: None
        return {**self.body, 'action': 'configure', 'configuration': self.configuration()}

    def test_configure_render_is_finite_and_protects_self_job(self):
        value = self.configuration()
        value['jobs'][0]['targets'][0]['labels']['site'] = 'lab: \"quoted\"'
        rendered = pl.render_configuration(value).decode()
        self.assertIn('job_name: "prometheus"', rendered)
        self.assertIn('"127.0.0.1:9090"', rendered)
        self.assertIn('job_name: "node"', rendered)
        value['jobs'][0]['enabled'] = False
        self.assertNotIn('job_name: "node"', pl.render_configuration(value).decode())
        value['jobs'][0]['name'] = 'prometheus'
        with self.assertRaisesRegex(ValueError, 'protected'):
            pl.configuration(value)

    def test_configure_rejects_injected_settings_and_reserved_labels(self):
        import copy
        mutations = [lambda v: v.update(remote_write=[]),
                     lambda v: v['jobs'][0].update(bearer_token='secret'),
                     lambda v: v['jobs'][0].update(metrics_path='/metrics?token=x'),
                     lambda v: v['jobs'][0].update(scrape_timeout='31s'),
                     lambda v: v['jobs'][0]['targets'][0].update(address='http://node:9100'),
                     lambda v: v['jobs'][0]['targets'][0]['labels'].update(job='foreign'),
                     lambda v: v['jobs'][0]['targets'][0]['labels'].update(__address__='foreign')]
        for mutate in mutations:
            candidate = copy.deepcopy(self.configuration())
            mutate(candidate)
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                pl.configuration(candidate)

    def test_configure_applies_owned_candidate_and_replay_preserves_original_revision(self):
        body = self.configure_engine()
        first = self.controller.execute(body)
        self.assertEqual(first['configuration_revision'], 1)
        self.assertEqual(first['configuration_hash'], hashlib.sha256(pl.render_configuration(body['configuration'])).hexdigest())
        path = self.controller.base / self.instance / 'config/prometheus.yml'
        self.assertEqual(path.read_bytes(), pl.render_configuration(body['configuration']))
        second = {**body, 'operation_id': str(uuid.uuid4()), 'configuration': self.configuration(2)}
        self.assertEqual(self.controller.execute(second)['configuration_revision'], 2)
        self.assertEqual(self.controller.execute(body), first)
        self.assertEqual(self.controller.configuration_state(self.instance)['current']['revision'], 2)

    def test_promtool_rejection_keeps_previous_config_and_cleans_candidate(self):
        body = self.configure_engine()
        self.controller.docker = lambda *args, **kwargs: (_ for _ in ()).throw(ValueError('Rejected by promtool'))
        result = self.controller.execute(body)
        self.assertEqual(result['state'], 'error')
        base = self.controller.base / self.instance
        self.assertEqual((base / 'config/prometheus.yml').read_bytes(), pl.CONFIG)
        self.assertFalse((base / 'config/candidate.yml').exists())
        self.assertFalse((base / 'candidate.json').exists())
        self.assertIsNone(self.controller.configuration_state(self.instance)['pending'])
        self.assertTrue(result['rolled_back'])
        self.assertEqual(result['configuration_revision'], 0)
        self.controller.docker = lambda *args, **kwargs: b'SUCCESS'
        edited = {**body, 'operation_id': str(uuid.uuid4()), 'configuration': self.configuration(2)}
        self.assertEqual(self.controller.execute(edited)['configuration_revision'], 2)

    def test_promtool_failure_during_recovery_does_not_claim_previous_config_confirmed(self):
        body = self.configure_engine()
        with patch.object(self.controller, 'reload_configuration', side_effect=ValueError('transport failed')):
            self.controller.execute(body)
        self.controller.docker = lambda *args, **kwargs: (_ for _ in ()).throw(ValueError('Rejected by promtool'))
        result = self.controller.execute(body)
        self.assertEqual(result['state'], 'error')
        self.assertFalse(result.get('rolled_back', False))
        self.assertIsNotNone(self.controller.configuration_state(self.instance)['pending'])

    def test_failed_reload_rolls_back_and_reports_original_revision(self):
        body = self.configure_engine()
        with patch.object(self.controller, 'reload_configuration', side_effect=[ValueError('rejected'), 'old yaml']):
            result = self.controller.execute(body)
        self.assertEqual(result['state'], 'error')
        self.assertTrue(result['rolled_back'])
        self.assertEqual(result['configuration_revision'], 0)
        self.assertEqual((self.controller.base / self.instance / 'config/prometheus.yml').read_bytes(), pl.CONFIG)
        self.assertIsNone(self.controller.configuration_state(self.instance)['pending'])

    def test_failed_rollback_blocks_health_and_recovers_same_operation(self):
        body = self.configure_engine()
        with patch.object(self.controller, 'reload_configuration', side_effect=ValueError('transport failed')):
            result = self.controller.execute(body)
        self.assertEqual(result['state'], 'error')
        self.assertIsNotNone(self.controller.configuration_state(self.instance)['pending'])
        with self.assertRaisesRegex(ValueError, 'interrupted'):
            self.controller.config(self.instance, create=False)
        conflicting = {**body, 'operation_id': str(uuid.uuid4())}
        with self.assertRaises(pl.Conflict):
            self.controller.configure(conflicting)
        self.assertEqual(self.controller.execute(body)['configuration_revision'], 1)
        self.assertIsNone(self.controller.configuration_state(self.instance)['pending'])

    def test_configuration_validation_does_not_write_live_file(self):
        self.configure_engine()
        result = self.controller.validate_configuration({'instance_id': self.instance, 'configuration': self.configuration()})
        self.assertTrue(result['valid'])
        self.assertEqual(result['hash'], hashlib.sha256(result['yaml'].encode()).hexdigest())
        self.assertEqual((self.controller.base / self.instance / 'config/prometheus.yml').read_bytes(), pl.CONFIG)
        self.assertIsNone(self.controller.configuration_state(self.instance)['current'])

    def test_foreign_candidate_is_preserved_without_docker_call(self):
        self.configure_engine()
        path = self.controller.base / self.instance / 'config/candidate.yml'
        path.write_bytes(b'foreign')
        calls = []
        self.controller.docker = lambda *args, **kwargs: calls.append(args)
        with self.assertRaisesRegex(ValueError, 'Unrecognized'):
            self.controller.validate_configuration({'instance_id': self.instance, 'configuration': self.configuration()})
        self.assertEqual(path.read_bytes(), b'foreign')
        self.assertEqual(calls, [])

    def test_interrupted_promtool_candidate_is_recognized_and_cleaned(self):
        self.configure_engine()
        base = self.controller.base / self.instance
        pl.atomic(base / 'candidate.json', self.configuration())
        pl.atomic(base / 'config/candidate.yml', pl.render_configuration(self.configuration()), 0o644)
        self.assertTrue(self.controller.owned_config(self.instance))
        self.controller.validate_configuration({'instance_id': self.instance, 'configuration': self.configuration(2)})
        self.assertFalse((base / 'candidate.json').exists())
        self.assertFalse((base / 'config/candidate.yml').exists())

    def test_reload_requires_changed_runtime_timestamp_before_success(self):
        self.configure_engine()
        del self.controller.reload_configuration
        responses = [{'lastConfigTime': '2026-01-01T00:00:00Z', 'serverTime': '2026-01-01T00:00:01Z', 'reloadConfigSuccess': True},
                     {'lastConfigTime': '2026-01-01T00:00:01Z', 'reloadConfigSuccess': True}, {'yaml': 'confirmed'}]
        with patch.object(self.controller, 'api_json', side_effect=responses):
            self.assertEqual(self.controller.reload_configuration({'Id': 'a' * 64}), 'confirmed')

    def test_rollback_reload_waits_for_success_after_previous_reload_failure(self):
        self.configure_engine()
        del self.controller.reload_configuration
        responses = [{'lastConfigTime': '2026-01-01T00:00:00Z', 'serverTime': '2026-01-01T00:00:01Z', 'reloadConfigSuccess': False},
                     {'lastConfigTime': '2026-01-01T00:00:00Z', 'reloadConfigSuccess': False},
                     {'lastConfigTime': '2026-01-01T00:00:01Z', 'reloadConfigSuccess': True}, {'yaml': 'restored'}]
        with patch.object(self.controller, 'api_json', side_effect=responses), patch.object(pl.time, 'sleep'):
            self.assertEqual(self.controller.reload_configuration({'Id': 'a' * 64}), 'restored')

    def test_reload_waits_for_distinguishable_server_second_before_hup(self):
        reads, calls = [], []
        self.controller.docker = lambda *args, **kwargs: calls.append((args, len(reads)))
        responses = [
            {'lastConfigTime': '2026-01-01T00:00:00Z', 'serverTime': '2026-01-01T00:00:00.500Z', 'reloadConfigSuccess': True},
            {'lastConfigTime': '2026-01-01T00:00:00Z', 'serverTime': '2026-01-01T00:00:00.900Z', 'reloadConfigSuccess': True},
            {'lastConfigTime': '2026-01-01T00:00:00Z', 'serverTime': '2026-01-01T00:00:01.001Z', 'reloadConfigSuccess': True},
            {'lastConfigTime': '2026-01-01T00:00:01Z', 'reloadConfigSuccess': True}, {'yaml': 'confirmed'}]
        def read(obj, path):
            reads.append(path)
            return responses[len(reads) - 1]
        with patch.object(self.controller, 'api_json', side_effect=read), patch.object(pl.time, 'sleep') as sleep:
            self.assertEqual(self.controller.reload_configuration({'Id': 'a' * 64}), 'confirmed')
        self.assertEqual(calls, [(('container', 'kill', '--signal', 'HUP', 'a' * 64), 3)])
        self.assertEqual(sleep.call_count, 2)

    def test_stalled_server_clock_refuses_hup(self):
        state = {'lastConfigTime': '2026-01-01T00:00:00Z', 'serverTime': '2026-01-01T00:00:00.500Z', 'reloadConfigSuccess': True}
        with patch.object(self.controller, 'api_json', return_value=state), patch.object(self.controller, 'docker') as docker, \
                patch.object(pl.time, 'monotonic', side_effect=[0, 0, 3]), patch.object(pl.time, 'sleep'):
            with self.assertRaisesRegex(ValueError, 'clock did not advance'):
                self.controller.reload_configuration({'Id': 'a' * 64})
            docker.assert_not_called()

    def test_reload_requires_valid_timezone_aware_server_clock(self):
        for server in (None, 'invalid', '2026-01-01T00:00:01'):
            state = {'lastConfigTime': '2026-01-01T00:00:00Z', 'serverTime': server}
            with self.subTest(server=server), patch.object(self.controller, 'api_json', return_value=state), \
                    patch.object(self.controller, 'docker') as docker:
                with self.assertRaisesRegex(ValueError, 'clock unavailable'):
                    self.controller.reload_configuration({'Id': 'a' * 64})
                docker.assert_not_called()

    def test_active_targets_readback_checks_user_labels_and_expected_set(self):
        self.configure_engine()
        del self.controller.confirm_targets
        targets = [
            {'scrapePool': 'prometheus', 'scrapeUrl': 'http://127.0.0.1:9090/metrics',
             'scrapeInterval': '15s', 'scrapeTimeout': '10s', 'labels': {'job': 'prometheus', 'instance': '127.0.0.1:9090'}},
            {'scrapePool': 'node', 'scrapeUrl': 'http://node.example:9100/metrics',
             'scrapeInterval': '30s', 'scrapeTimeout': '5s', 'labels': {'job': 'node', 'instance': 'node.example:9100', 'site': 'lab'}}]
        value = self.configuration()
        value['jobs'][0]['metrics_path'] = '/metrics%custom'
        targets[1]['scrapeUrl'] = 'http://node.example:9100/metrics%25custom'
        with patch.object(self.controller, 'api_json', return_value={'activeTargets': targets}):
            self.controller.confirm_targets({}, value)
            targets[1]['labels']['site'] = 'unexpected'
            with patch.object(pl.time, 'monotonic', side_effect=[0, 16]), self.assertRaisesRegex(ValueError, 'did not match'):
                self.controller.confirm_targets({}, value)

    def test_hmac_covers_method_path_body_and_fresh_timestamp(self):
        key, raw = b'x' * 32, b'{"action":"install"}'
        payload = b'1000\nPOST\n/v1/operations\n' + raw
        headers = {'X-PL-Timestamp': '1000', 'X-PL-Signature': hmac.new(key, payload, hashlib.sha256).hexdigest()}
        self.assertTrue(pl.authenticated(key, headers, 'POST', '/v1/operations', raw, now=1060))
        for method, path, body, now in [('GET', '/v1/operations', raw, 1000),
                                        ('POST', '/v1/other', raw, 1000),
                                        ('POST', '/v1/operations', raw + b' ', 1000),
                                        ('POST', '/v1/operations', raw, 1061)]:
            self.assertFalse(pl.authenticated(key, headers, method, path, body, now=now))

    def test_reject_arbitrary_image_command_paths_and_noncanonical_ids(self):
        for changes in ({'image': 'evil'}, {'action': 'delete'}, {'module_id': 'shell'},
                        {'instance_id': '../../etc'}, {'operation_id': self.body['operation_id'].upper()}):
            candidate = {**self.body, **changes}
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                pl.operation(candidate)

    def test_completed_replay_observes_without_reapplying_and_conflicting_id_rejected(self):
        calls = []
        self.controller.ensure = lambda instance: calls.append(instance)
        self.controller.observe = lambda instance: {'state': 'running'}
        self.assertEqual(self.controller.execute(self.body)['state'], 'running')
        self.controller.observe = lambda instance: {'state': 'disabled'}
        self.assertEqual(self.controller.execute(self.body)['state'], 'disabled')
        self.assertEqual(calls, [self.instance])
        with self.assertRaises(pl.Conflict):
            self.controller.execute({**self.body, 'action': 'disable'})

    def test_completed_replay_reports_later_drift_with_operation_id(self):
        self.controller.ensure = lambda instance: None
        self.controller.observe = lambda instance: {'state': 'running'}
        self.controller.execute(self.body)
        self.controller.observe = lambda instance: (_ for _ in ()).throw(ValueError('Container drift'))
        result = self.controller.execute(self.body)
        self.assertEqual(result['state'], 'error')
        self.assertEqual(result['operation_id'], self.body['operation_id'])

    def test_interrupted_journal_reconciles_same_owned_instance(self):
        attempts = []
        def ensure(instance):
            attempts.append(instance)
            if len(attempts) == 1:
                raise ValueError('Interrupted after create')
        self.controller.ensure = ensure
        self.controller.observe = lambda instance: {'state': 'running'}
        first = self.controller.execute(self.body)
        self.assertEqual(first['state'], 'error')
        self.assertEqual(first['operation_id'], self.body['operation_id'])
        journal = self.controller.operations / (self.body['operation_id'] + '.json')
        self.assertEqual(json.loads(journal.read_text())['phase'], 'running')
        self.assertEqual(self.controller.execute(self.body)['state'], 'running')
        self.assertEqual(attempts, [self.instance, self.instance])
        self.assertEqual(json.loads(journal.read_text())['phase'], 'complete')

    def test_disable_only_stops_owned_container_and_preserves_data(self):
        calls = []
        self.controller.inspect = lambda instance: {'State': {'Running': True}}
        self.controller.docker = lambda *args, **kw: calls.append(args)
        self.controller.observe = lambda instance: {'state': 'disabled'}
        self.controller.execute({**self.body, 'action': 'disable'})
        self.assertEqual(calls, [('container', 'stop', '--time', '20', self.controller.name(self.instance))])

    def test_config_readable_under_systemd_restrictive_umask(self):
        previous = os.umask(0o077)
        try:
            config = self.controller.config(self.instance)
        finally:
            os.umask(previous)
        self.assertEqual((config / 'prometheus.yml').stat().st_mode & 0o777, 0o644)
        self.assertEqual(config.stat().st_mode & 0o777, 0o755)

    def test_config_drift_and_symlinks_refused(self):
        config = self.controller.config(self.instance)
        (config / 'prometheus.yml').write_text('scrape_configs: [foreign]')
        with self.assertRaisesRegex(ValueError, 'differs'):
            self.controller.config(self.instance)
        (config / 'prometheus.yml').unlink()
        (config / 'prometheus.yml').symlink_to(self.root / 'outside')
        with self.assertRaises(ValueError):
            self.controller.config(self.instance)

    def test_symlink_lock_rejected_before_docker_call(self):
        (self.controller.base / 'controller.lock').symlink_to(self.root / 'outside')
        with self.assertRaises(OSError):
            self.controller.get(self.instance)

    def test_container_ownership_and_resource_drift_fail_before_start(self):
        def docker(*args, **kwargs):
            if args[:2] == ('container', 'ls'):
                return b'containerid'
            return json.dumps([{'Config': {'Labels': {}, 'Image': 'foreign'}, 'HostConfig': {}, 'Mounts': []}]).encode()
        self.controller.docker = docker
        with self.assertRaisesRegex(ValueError, 'drift'):
            self.controller.inspect(self.instance)

    def test_preflight_failure_leaves_no_instance_or_volume(self):
        self.controller.inspect = lambda instance: None
        self.controller.preflight = lambda: (_ for _ in ()).throw(ValueError('Insufficient disk'))
        calls = []
        self.controller.docker = lambda *args, **kwargs: calls.append(args)
        result = self.controller.execute(self.body)
        self.assertEqual(result['state'], 'error')
        self.assertFalse((self.controller.base / self.instance).exists())
        self.assertEqual(calls, [])

    def test_preflight_checks_both_filesystems_and_available_memory(self):
        self.controller.docker = lambda *args, **kwargs: json.dumps(str(self.root)).encode()
        with patch.object(pl.shutil, 'disk_usage') as disk, patch.object(pl.Path, 'read_text', return_value='MemAvailable: 524288 kB'):
            disk.return_value.free = 2 * 1024**3
            self.controller.preflight()
            self.assertEqual(disk.call_count, 2)
            disk.return_value.free = 1024
            with self.assertRaisesRegex(ValueError, '1 GiB'):
                self.controller.preflight()
        with patch.object(pl.shutil, 'disk_usage') as disk, patch.object(pl.Path, 'read_text', return_value='MemAvailable: 1024 kB'):
            disk.return_value.free = 2 * 1024**3
            with self.assertRaisesRegex(ValueError, '256 MiB'):
                self.controller.preflight()

    def test_no_shell_or_inherited_remote_docker_environment(self):
        with patch.object(pl.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b'ok'
            self.controller.docker('version')
            args, kwargs = run.call_args
            self.assertEqual(args[0][:3], ['docker', '--host', 'unix:///var/run/docker.sock'])
            self.assertNotIn('shell', kwargs)
            self.assertFalse(any(k.startswith(('DOCKER_', 'PL_', 'PORTAL_')) for k in kwargs['env']))

    def owned_engine(self):
        controller, instance = self.controller, self.instance
        config = controller.config(instance)
        name = controller.name(instance)
        state = {'container': True, 'volume': True, 'running': True, 'volume_labels': controller.labels(instance), 'calls': [], 'fail_volume_once': False}
        def docker(*args, **kwargs):
            state['calls'].append(args)
            if args[:2] == ('container', 'ls'):
                return b'a' * 64 if state['container'] else b''
            if args[:2] == ('container', 'inspect'):
                return json.dumps([{'Id': 'a' * 64, 'Config': {'Labels': controller.labels(instance), 'Image': pl.IMAGE, 'Cmd': pl.FLAGS, 'User': '65534:65534'},
                    'HostConfig': {'ReadonlyRootfs': True, 'NetworkMode': 'bridge', 'Memory': 768 * 1024**2, 'NanoCpus': 1_000_000_000,
                                   'PidsLimit': 128, 'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'],
                                   'PortBindings': {'9090/tcp': [{'HostIp': '127.0.0.1'}]}},
                    'Mounts': [{'Type': 'bind', 'Source': str(config), 'Destination': '/etc/prometheus', 'RW': False},
                               {'Type': 'volume', 'Name': name + '-data', 'Destination': '/prometheus', 'RW': True}],
                    'State': {'Running': state['running']}, 'NetworkSettings': {'Ports': {'9090/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19099'}]}}}]).encode()
            if args[:2] == ('volume', 'ls'):
                return (name + '-data').encode() if state['volume'] else b''
            if args[:2] == ('volume', 'inspect'):
                return json.dumps([{'Name': name + '-data', 'Driver': 'local', 'Options': None, 'Labels': state['volume_labels']}]).encode()
            if args[:2] == ('container', 'stop'):
                self.assertEqual(args[-1], 'a' * 64)
                state['running'] = False
                return b''
            if args[:2] == ('container', 'rm'):
                self.assertEqual(args[-1], 'a' * 64)
                state['container'] = False
                return b''
            if args[:2] == ('volume', 'rm'):
                self.assertEqual(args[-1], name + '-data')
                if state['fail_volume_once']:
                    state['fail_volume_once'] = False
                    raise ValueError('Volume busy')
                state['volume'] = False
                return b''
            self.fail('Unexpected Docker operation: ' + repr(args))
        controller.docker = docker
        return state

    def test_remove_cleans_applied_revision_and_recognized_interrupted_candidate(self):
        config = self.controller.config(self.instance)
        value = self.configuration()
        pl.atomic(self.controller.base / self.instance / 'configuration.json', {'current': value, 'pending': None})
        pl.atomic(config / 'prometheus.yml', pl.render_configuration(value), 0o644)
        pl.atomic(self.controller.base / self.instance / 'candidate.json', self.configuration(2))
        pl.atomic(config / 'candidate.yml', pl.render_configuration(self.configuration(2)), 0o644)
        state = self.owned_engine()
        result = self.controller.execute({**self.body, 'action': 'remove'})
        self.assertEqual(result['state'], 'absent')
        self.assertFalse(state['container'])
        self.assertFalse((self.controller.base / self.instance).exists())

    def test_remove_verifies_and_deletes_only_three_owned_artifacts(self):
        state = self.owned_engine()
        result = self.controller.execute({**self.body, 'action': 'remove'})
        self.assertEqual(result['state'], 'absent')
        self.assertFalse(state['container'])
        self.assertFalse(state['volume'])
        self.assertFalse((self.controller.base / self.instance).exists())
        mutations = [call[:2] for call in state['calls'] if call[:2] in [('container', 'stop'), ('container', 'rm'), ('volume', 'rm')]]
        self.assertEqual(mutations, [('container', 'stop'), ('container', 'rm'), ('volume', 'rm')])
        before = len(state['calls'])
        self.assertEqual(self.controller.execute({**self.body, 'action': 'remove'})['state'], 'absent')
        self.assertFalse(any(call[:2] in mutations for call in state['calls'][before:]))

    def test_remove_refuses_foreign_volume_and_config_before_stopping(self):
        for kind in ('foreign-volume', 'symlink', 'extra-file', 'changed-config'):
            with self.subTest(kind=kind):
                # Keep each deliberately corrupted fixture independent. A failed
                # operation may retain reconciliation state for that instance.
                self.instance = str(uuid.uuid4())
                state = self.owned_engine()
                path = self.controller.base / self.instance / 'config/prometheus.yml'
                if kind == 'foreign-volume':
                    state['volume_labels'] = {}
                elif kind == 'symlink':
                    path.unlink()
                    path.symlink_to(self.root / 'outside')
                elif kind == 'extra-file':
                    (path.parent / 'foreign-data').write_text('preserve me')
                else:
                    path.write_bytes(b'foreign config')
                result = self.controller.execute({**self.body, 'instance_id': self.instance, 'operation_id': str(uuid.uuid4()), 'action': 'remove'})
                self.assertEqual(result['state'], 'error')
                self.assertTrue(state['container'])
                self.assertTrue(state['running'])
                self.assertTrue(state['volume'])
                self.assertFalse(any(call[:2] in [('container', 'stop'), ('container', 'rm'), ('volume', 'rm')] for call in state['calls']))

    def test_remove_interrupted_after_container_removal_resumes_volume_and_config(self):
        state = self.owned_engine()
        state['fail_volume_once'] = True
        request = {**self.body, 'action': 'remove'}
        self.assertEqual(self.controller.execute(request)['state'], 'error')
        self.assertFalse(state['container'])
        self.assertTrue(state['volume'])
        self.assertTrue((self.controller.base / self.instance / 'config/prometheus.yml').exists())
        self.assertEqual(self.controller.get(self.instance)['state'], 'error')  # leftovers are not absent
        self.assertEqual(self.controller.execute(request)['state'], 'absent')
        self.assertFalse(state['volume'])
        self.assertFalse((self.controller.base / self.instance).exists())

    def test_remove_interrupted_between_config_unlinks_can_resume(self):
        state = self.owned_engine()
        state['container'] = state['volume'] = False
        path = self.controller.base / self.instance / 'config/prometheus.yml'
        path.unlink()
        self.assertEqual(self.controller.execute({**self.body, 'action': 'remove'})['state'], 'absent')
        self.assertFalse(path.parent.parent.exists())

    def test_read_routes_refuse_admin_write_escape_and_invalid_query(self):
        for path, query in [('/-/reload', ''), ('/api/v1/admin/tsdb/delete_series', ''), ('/debug/pprof', ''),
                            ('/assets/../secret.js', ''), ('//evil/targets', ''), ('/assets/%2fsecret.js', ''),
                            ('/api/v1/targets', 'x=%0afoo'), ('/api/v1/targets', 'x=%zz'), ('/query', 'x=' + 'a' * 8193)]:
            with self.subTest(path=path, query=query[:20]), self.assertRaises(ValueError):
                self.controller.read({'instance_id': self.instance, 'path': path, 'query': query})

    def test_ready_read_does_not_wait_for_another_modules_lifecycle_lock(self):
        self.controller._read_routes[self.instance] = (pl.time.monotonic(), 'http://127.0.0.1:9090')
        def response(*args, **kwargs):
            value = io.BytesIO(b'{"status":"success"}')
            value.status, value.headers = 200, {'Content-Type': 'application/json'}
            return value
        opener = Mock(); opener.open.side_effect = response
        with (self.controller.base / 'controller.lock').open('a') as held:
            pl.fcntl.flock(held, pl.fcntl.LOCK_EX | pl.fcntl.LOCK_NB)
            with patch.object(pl.urllib.request, 'build_opener', return_value=opener):
                result = self.controller.read({'instance_id': self.instance, 'path': '/api/v1/targets', 'query': ''})
            self.assertEqual(result['status'], 200)
            self.assertEqual(json.loads(base64.b64decode(result['body'])), {'status': 'success'})

    def test_read_uses_owned_loopback_and_returns_bounded_real_api_without_cookies(self):
        seen = []
        class API(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get('Cookie'), self.headers.get('Authorization')))
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Set-Cookie', 'foreign=yes')
                self.end_headers()
                health = 'up' if len(seen) == 1 else 'down'
                self.wfile.write(json.dumps({'status': 'success', 'data': {'activeTargets': [{'health': health}]}}).encode())
            def log_message(self, *args):
                pass
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), API) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.shutdown)
            self.controller.inspect = Mock(return_value={'State': {'Running': True}, 'NetworkSettings': {'Ports': {'9090/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(server.server_port)}]}}})
            self.controller.config(self.instance)
            result = self.controller.read({'instance_id': self.instance, 'path': '/api/v1/targets', 'query': 'state=active'})
            self.assertEqual(result['instance_id'], self.instance)
            self.assertEqual(result['status'], 200)
            self.assertEqual(json.loads(base64.b64decode(result['body']))['data']['activeTargets'][0]['health'], 'up')
            self.assertEqual(set(result), {'instance_id', 'status', 'content_type', 'body'})
            fresh = self.controller.read({'instance_id': self.instance, 'path': '/api/v1/targets', 'query': 'state=active'})
            self.assertEqual(json.loads(base64.b64decode(fresh['body']))['data']['activeTargets'][0]['health'], 'down')
            self.controller.inspect.assert_called_once_with(self.instance)
            self.assertEqual(seen, [('/api/v1/targets?state=active', None, None)] * 2)
            server.shutdown()

    def test_expired_prometheus_route_rechecks_running_state(self):
        self.controller._read_routes[self.instance] = (pl.time.monotonic() - 31, 'http://127.0.0.1:9090')
        self.controller.inspect = Mock(return_value=None)
        with self.assertRaisesRegex(ValueError, 'not running'):
            self.controller.read({'instance_id': self.instance, 'path': '/api/v1/targets', 'query': ''})
        self.controller.inspect.assert_called_once_with(self.instance)
        self.assertNotIn(self.instance, self.controller._read_routes)

    def test_prometheus_connection_failure_revokes_route_without_retry(self):
        self.controller._read_routes[self.instance] = (pl.time.monotonic(), 'http://127.0.0.1:9090')
        opener = Mock()
        opener.open.side_effect = OSError('native connection lost')
        with patch.object(pl.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaises(OSError):
                self.controller.read({'instance_id': self.instance, 'path': '/api/v1/targets', 'query': ''})
        self.assertEqual(opener.open.call_count, 1)
        self.assertNotIn(self.instance, self.controller._read_routes)

    def test_prometheus_http_releases_global_lock_and_retains_instance_lock(self):
        self.controller._read_routes[self.instance] = (pl.time.monotonic(), 'http://127.0.0.1:9090')
        entered, release = threading.Event(), threading.Event()
        def fetch(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError('Native request was not released')
            response = io.BytesIO(b'{"status":"success"}')
            response.status, response.headers = 200, {'Content-Type': 'application/json'}
            return response
        opener = Mock(); opener.open.side_effect = fetch
        with patch.object(pl.urllib.request, 'build_opener', return_value=opener), ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.controller.read, {'instance_id': self.instance, 'path': '/api/v1/targets', 'query': ''})
            try:
                self.assertTrue(entered.wait(3))
                with (self.controller.base / 'controller.lock').open('a') as probe:
                    pl.fcntl.flock(probe, pl.fcntl.LOCK_EX | pl.fcntl.LOCK_NB)
                with (self.controller.operations / ('read-' + self.instance + '.lock')).open('rb') as probe:
                    with self.assertRaises(BlockingIOError):
                        pl.fcntl.flock(probe, pl.fcntl.LOCK_EX | pl.fcntl.LOCK_NB)
                release.set()
                self.assertEqual(pending.result(timeout=3)['status'], 200)
            finally:
                release.set()


if __name__ == '__main__':
    unittest.main()
