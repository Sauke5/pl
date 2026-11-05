"""Installed-module updates pin an artifact and preserve the used core/data."""
import copy
import hashlib
from pathlib import Path
import types
import unittest
import uuid
from unittest.mock import Mock

import installer.tests.test_delivery as fixtures

d = fixtures.d


class ModuleUpdateDeliveryTests(unittest.TestCase):
    def setUp(self):
        fixtures.UpgradeTransactionTests.setUp(self)
        self.containers[-1].update(name='doska-native', module_id='doska')
        self.containers.append({'name': 'sftp-native', 'running': True, 'core': False, 'service': '', 'module_id': 'sftpgo'})
        self.old_descriptor = {'api': {'id': 'old-api'}, 'web': {'id': 'old-web'}, 'database': {'id': 'same-db'}}
        self.new_descriptor = {'api': {'id': 'new-api'}, 'web': {'id': 'new-web'}, 'database': {'id': 'same-db'}}
        registry = self.delivery.module_registry(); registry['doska'] = self.old_descriptor
        d.atomic(self.root / 'private/module-images.json', registry)
        self.old_receipt = {'module_id': 'doska', 'version': '2.46.2', 'core_api': 1, 'sha256': 'c' * 64}
        d.atomic(self.delivery.base / 'module-doska.json', self.old_receipt)
        self.artifact = {'url': 'https://github.com/Sauke5/pl/releases/download/v0.4.2/pl-doska.tar.gz', 'sha256': 'd' * 64, 'size': 123}
        self.request = {'operation_id': self.operation_id, 'kind': 'module_upgrade', 'module_id': 'doska',
                        'version': '0.3.0', 'from_version': '0.3.0', 'module_version': '2.46.2',
                        'phase': 'queued', 'artifact': self.artifact}
        d.atomic(self.delivery.base / 'operation.json', self.request)
        self.plan = {'schema': 1, 'module_id': 'doska', 'instances': [{'instance_id': 'a'}, {'instance_id': 'b'}], 'ledger': {}}
        self.helper = types.SimpleNamespace(plan=Mock(return_value=self.plan), apply=Mock(), verify=Mock(), rollback=Mock())
        self.delivery.module_upgrade_helper = Mock(return_value=self.helper)
        self.delivery.stage_module_upgrade = Mock(return_value=({'version': '2.46.2', 'package_version': '0.4.2'}, self.new_descriptor))

    def test_used_module_update_keeps_core_version_and_prepares_full_snapshot(self):
        def apply(parent, plan):
            operation = d.read(self.delivery.base / 'operation.json')
            self.assertTrue((Path(operation['snapshot']) / 'snapshot.json').exists())
            self.assertEqual(self.delivery.module_registry()['doska'], self.new_descriptor)
            plan['ledger']['new-web'] = {'id': 'replacement-id'}
            parent.module_upgrade_checkpoint(plan)
        self.helper.apply.side_effect = apply
        self.delivery.run_operation()
        self.helper.plan.assert_called_once_with(self.parent, 'doska', self.old_descriptor, self.new_descriptor)
        self.helper.verify.assert_called_once()
        self.assertEqual(self.delivery.state()['version'], '0.3.0')
        self.assertEqual(d.load_json((self.volume_roots[0] / 'database').read_bytes()), self.original)
        self.assertEqual((self.volume_roots[2] / 'history').read_text(), 'existing-module-history')
        self.assertEqual((self.volume_roots[1] / 'password.hash').read_text(), 'changed-local-admin-password')
        self.assertEqual(d.read(self.delivery.base / 'module-doska.json')['sha256'], 'd' * 64)
        operation = d.read(self.delivery.base / 'operation.json')
        self.assertEqual(operation['phase'], 'complete')
        self.assertEqual(operation['module_upgrade_plan_sha256'], hashlib.sha256(d.json_bytes(operation['module_upgrade_plan'])).hexdigest())
        self.assertEqual(self.restarted[0], self.containers)

    def test_failed_native_update_restores_data_registry_receipt_before_old_recreate(self):
        def apply(parent, plan):
            (self.volume_roots[0] / 'database').write_bytes(d.json_bytes({'cards': ['changed-by-failed-start']}))
            (self.volume_roots[2] / 'history').write_text('failed new module write')
            d.atomic(self.delivery.base / 'module-doska.json', {**self.old_receipt, 'sha256': 'd' * 64})
            plan['ledger']['new-api'] = {'id': 'partial-replacement'}
            parent.module_upgrade_checkpoint(plan)
        def rollback(parent, plan):
            self.assertEqual(self.delivery.module_registry()['doska'], self.old_descriptor)
            self.assertEqual(d.load_json((self.volume_roots[0] / 'database').read_bytes()), self.original)
            self.assertEqual((self.volume_roots[2] / 'history').read_text(), 'existing-module-history')
            self.assertEqual(plan['ledger']['new-api']['id'], 'partial-replacement')
        self.helper.apply.side_effect = apply
        self.helper.verify.side_effect = ValueError('injected readiness failure')
        self.helper.rollback.side_effect = rollback
        self.delivery.run_operation()
        self.helper.rollback.assert_called_once()
        self.assertEqual(self.delivery.state()['version'], '0.3.0')
        self.assertEqual(d.read(self.delivery.base / 'module-doska.json'), self.old_receipt)
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'rolled_back')
        self.assertEqual((self.root / 'private/integration-credential-key').read_bytes(), bytes(range(32)))

    def test_unsupported_native_contract_does_not_stop_services_or_change_registry(self):
        self.helper.plan.side_effect = ValueError('storage image changed')
        self.delivery.run_operation()
        self.delivery.stop.assert_not_called()
        self.assertFalse((self.root / 'private/upgrade-backups').exists())
        self.assertEqual(self.delivery.module_registry()['doska'], self.old_descriptor)
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'failed')

    def test_committed_native_write_survives_failed_resume_and_recovery(self):
        accepted = self.volume_roots[2] / 'accepted-sftp-file'
        def resume(containers, *, safe_only=False):
            if safe_only:
                self.assertNotIn('sftp-native', [v['name'] for v in containers])
                self.assertIsNot(d.read(self.delivery.base / 'operation.json').get('data_committed'), True)
            else:
                self.assertTrue(d.read(self.delivery.base / 'operation.json')['data_committed'])
                accepted.write_text('successful native upload')
                raise ValueError('later module did not resume')
        self.delivery.resume_native.side_effect = resume
        self.delivery.run_operation()
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'recovery_required')
        self.assertEqual(accepted.read_text(), 'successful native upload')
        self.helper.rollback.assert_not_called()
        self.delivery.resume_native.side_effect = None
        self.delivery.run_operation(recovering=True)
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'complete')
        self.assertEqual(accepted.read_text(), 'successful native upload')
        self.helper.rollback.assert_not_called()

    def test_presnapshot_interruption_can_recover_without_plan_or_receipt(self):
        for phase in ('queued', 'downloading', 'quiescing'):
            with self.subTest(phase=phase):
                d.atomic(self.delivery.base / 'operation.json', {**self.request, 'phase': phase})
                self.delivery.rollback()
                self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'rolled_back')
                self.helper.rollback.assert_not_called()
                self.assertEqual(self.delivery.module_registry()['doska'], self.old_descriptor)

    def test_storage_repackage_retains_only_byte_identical_storage_images(self):
        def image(identity, source='old'):
            return {'id': identity, 'architecture': 'amd64', 'recipe': 'deploy/images/forms.Dockerfile',
                    'ref': 'pl/forms:' + source, 'labels': {'org.opencontainers.image.version': '8.2.0',
                        'pl.module.config.version': '1', 'pl.source.sha256': source}}
        old = {'mongo': image('old-mongo'), 'keydb': image('old-keydb')}
        candidate = {'mongo': image('new-mongo', 'new'), 'keydb': {**old['keydb'], 'ref': 'pl/forms:new-tag'}}
        registry = self.delivery.module_registry(); registry['forms'] = old
        d.atomic(self.root / 'private/module-images.json', registry)
        def actual(*args, **kwargs):
            identity = args[-1]
            return d.json_bytes([{'Id': identity, 'Os': 'linux', 'Architecture': 'amd64',
                                  'RootFS': {'Type': 'layers', 'Layers': ['unchanged-storage-bytes']},
                                  'Config': {'Env': ['DB_MODE=original'], 'Labels': {'build': identity}}}])
        self.parent.docker = Mock(side_effect=actual)
        kept = self.delivery.preserve_storage_images('forms', copy.deepcopy(candidate))
        self.assertEqual(kept, old)
        def changed(*args, **kwargs):
            value = d.load_json(actual(*args, **kwargs))
            if args[-1] == 'new-mongo': value[0]['RootFS']['Layers'] = ['changed-database-binary']
            return d.json_bytes(value)
        self.parent.docker.side_effect = changed
        refused = self.delivery.preserve_storage_images('forms', copy.deepcopy(candidate))
        self.assertEqual(refused['mongo']['id'], 'new-mongo', 'changed database bytes must reach the rejecting native preflight')
        self.assertEqual(refused['keydb'], old['keydb'])

    def test_corrupt_recovery_plan_is_rejected_before_stop_or_data_restore(self):
        plan = {**self.plan, 'snapshot_operation_id': self.operation_id}
        self.delivery.snapshot(self.request, self.containers)
        d.atomic(self.delivery.base / 'operation.json', {**self.request, 'phase': 'recovery_required',
                 'module_upgrade_plan': plan, 'module_upgrade_plan_sha256': '0' * 64, 'old_module_receipt': self.old_receipt})
        with self.assertRaisesRegex(ValueError, 'plan integrity'):
            self.delivery.rollback()
        self.delivery.stop.assert_not_called()
        self.parent.docker.assert_not_called()
        self.helper.rollback.assert_not_called()

    def offers(self):
        self.delivery.module_upgrade_capable = lambda: True
        self.delivery.catalog = lambda: {'sequence': 11, 'version': '0.4.5', 'core': {'amd64': self.artifact},
            'modules': {'doska': {'version': '2.46.2', 'core_api': 1, 'artifacts': {'amd64': self.artifact}}}}

    def test_offer_detects_rebuilt_artifact_with_unchanged_upstream_version(self):
        self.offers()
        offer = self.delivery.module_updates(self.delivery.catalog())[0]
        self.assertTrue(offer['installed'])
        self.assertEqual(offer['installed_version'], offer['version'])
        self.assertTrue(offer['update_available'])
        self.assertTrue(offer['upgrade_supported'])
        self.delivery.catalog()['modules']['doska']['version'] = '3.0.0'
        changed = copy.deepcopy(self.delivery.catalog()); changed['modules']['doska']['version'] = '3.0.0'
        self.assertFalse(self.delivery.module_updates(changed)[0]['upgrade_supported'])

    def test_queue_and_replay_bind_the_same_kind_and_signed_artifact(self):
        self.offers()
        (self.delivery.base / 'operation.json').unlink()
        self.delivery.worker_active = Mock(return_value=True)
        def launch(operation, recovering):
            d.atomic(self.delivery.base / 'operation.json', operation)
        self.delivery._launch = Mock(side_effect=launch)
        body = {'operation_id': str(uuid.uuid4()), 'module_id': 'doska', 'artifact_sha256': 'd' * 64}
        self.delivery.module_upgrade(body)
        self.delivery.module_upgrade(body)
        self.assertEqual(self.delivery._launch.call_count, 1)
        for invalid in ({**body, 'artifact_sha256': 'e' * 64}, {**body, 'module_id': 'forms'}, {**body, 'url': 'https://other.test'}):
            with self.assertRaises(ValueError):
                self.delivery.module_upgrade(invalid)
        self.assertEqual(self.delivery._launch.call_count, 1)


if __name__ == '__main__':
    unittest.main()
