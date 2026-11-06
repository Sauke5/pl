"""Selected-module update never restores a neighbour's concurrently written data."""
import io
from pathlib import Path
import tarfile
import unittest
import uuid
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

from installer.tests import test_module_update_delivery as fixtures
from installer.tests.test_module_upgrade import upgrade
from installer.tests import test_application_transport as transport

d = fixtures.d


class ScopedModuleDeliveryTests(unittest.TestCase):
    def setUp(self):
        fixtures.ModuleUpdateDeliveryTests.setUp(self)
        self.request['scope'] = 'module'
        d.atomic(self.delivery.base / 'operation.json', self.request)
        instance = str(uuid.uuid4())
        self.relative = 'modules/doska/instances/' + instance
        self.native = self.root / self.relative
        self.native.mkdir(parents=True)
        for directory in (self.root / 'modules/doska', self.root / 'modules/doska/instances', self.native):
            directory.chmod(0o700)
        (self.root / 'modules/doska/operations').mkdir(mode=0o700)
        (self.native / 'state.json').write_text('original-native-configuration')
        (self.native / 'state.json').chmod(0o600)
        self.plan.update(snapshot_scope='module', requires_full_snapshot=False,
                         core_version='0.3.0', core_manifest_sha256=self.delivery.state()['manifest_sha256'],
                         installation=self.installation, root=str(self.root),
                         old_descriptor=self.old_descriptor, new_descriptor=self.new_descriptor,
                         snapshot_paths=[self.relative],
                         instances=[{'instance_id': instance, 'volumes': [self.volumes[2]['name']],
                                     'containers': [{'name': 'doska-native'}]}])
        self.helper._snapshot = upgrade._snapshot
        self.engine = self.parent.docker.side_effect
        self.objects = [{'Name': '/doska-native', 'Config': {'Labels': {'pl.installation': self.installation,
                        'pl.module': 'doska'}}, 'Mounts': [{'Type': 'volume', 'Name': self.volumes[2]['name']}]}]
        def engine(*args, **kwargs):
            if args[:2] == ('container', 'ls'):
                return b'native-id\n'
            if args[:2] == ('container', 'inspect'):
                return d.json_bytes(self.objects)
            return self.engine(*args, **kwargs)
        self.parent.docker.side_effect = engine

    def test_success_only_stops_and_starts_selected_module_and_keeps_core_writes(self):
        def apply(parent, plan):
            (self.volume_roots[0] / 'new-core-record').write_text('accepted during module update')
            plan['ledger']['replacement'] = {'id': 'new-native-id'}
            parent.module_upgrade_checkpoint(plan)
        def start(containers):
            self.assertTrue(d.read(self.delivery.base / 'operation.json')['data_committed'])
            self.assertEqual([c['name'] for c in containers], ['doska-native'])
        self.helper.apply.side_effect = apply
        self.delivery.resume_native.side_effect = start
        self.delivery.run_operation()
        self.helper.plan.assert_called_once_with(self.parent, 'doska', self.old_descriptor, self.new_descriptor, scoped=True)
        self.delivery.stop.assert_called_once_with([self.containers[3]])
        self.assertFalse(self.restarted)
        self.delivery.activate_host.assert_not_called()
        self.assertEqual((self.volume_roots[0] / 'new-core-record').read_text(), 'accepted during module update')
        operation = d.read(self.delivery.base / 'operation.json')
        self.assertEqual(operation['phase'], 'complete')
        folder = Path(operation['snapshot'])
        meta = d.read(folder / 'snapshot.json')
        self.assertEqual(meta['schema'], 2)
        self.assertEqual([v['name'] for v in meta['volumes']], [self.volumes[2]['name']])
        with tarfile.open(folder / 'installation.tar') as archive:
            self.assertTrue(all(v.name == self.relative or v.name.startswith(self.relative + '/') for v in archive.getmembers()))
        self.assertFalse((self.root / 'run/upgrade-status/active').exists())
        self.assertEqual(d.read(self.root / 'run/upgrade-status/status.json')['operation']['scope'], 'module')

    def test_precommit_failure_restores_only_target_and_merges_neighbour_registry(self):
        def apply(parent, plan):
            (self.volume_roots[0] / 'database').write_text('new core data')
            (self.root / 'private/new-neighbour-key').write_text('new neighbour secret')
            (self.native / 'state.json').write_text('failed native configuration')
            (self.volume_roots[2] / 'history').write_text('failed native write')
            neighbour = self.delivery.module_registry()
            neighbour['forms'] = {'new-neighbour-image': 'must survive'}
            d.atomic(self.root / 'private/module-images.json', neighbour)
            raise ValueError('injected failure before native start')
        self.helper.apply.side_effect = apply
        self.delivery.run_operation()
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'rolled_back')
        self.assertEqual((self.volume_roots[0] / 'database').read_text(), 'new core data')
        self.assertEqual((self.root / 'private/new-neighbour-key').read_text(), 'new neighbour secret')
        self.assertEqual((self.native / 'state.json').read_text(), 'original-native-configuration')

        self.assertEqual((self.volume_roots[2] / 'history').read_text(), 'existing-module-history')
        self.assertEqual(self.delivery.module_registry()['doska'], self.old_descriptor)
        self.assertEqual(self.delivery.module_registry()['forms'], {'new-neighbour-image': 'must survive'})
        self.helper.rollback.assert_called_once()
        self.assertFalse(self.restarted)
        self.delivery.activate_host.assert_not_called()

    def test_post_start_failure_resumes_target_and_preserves_accepted_data(self):
        accepted = self.volume_roots[2] / 'accepted-file'
        self.delivery.resume_native.side_effect = lambda containers: accepted.write_text('new native data')
        self.helper.verify.side_effect = ValueError('not ready yet')
        self.delivery.run_operation()
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'recovery_required')
        self.helper.rollback.assert_not_called()
        self.helper.verify.side_effect = None
        self.delivery.run_operation(recovering=True)
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'complete')
        self.assertEqual(accepted.read_text(), 'new native data')
        self.assertFalse(self.restarted)

    def test_same_installation_shared_volume_is_rejected(self):
        self.objects.append({'Config': {'Labels': {'pl.installation': self.installation, 'pl.module': 'forms'}},
                             'Mounts': [{'Type': 'volume', 'Name': self.volumes[2]['name']}]})
        with self.assertRaisesRegex(ValueError, 'outside the update scope'):
            self.delivery.module_snapshot_volumes(self.plan)

    def test_descriptor_without_instances_rolls_back_without_restoring_any_root(self):
        (self.native / 'state.json').unlink()
        self.native.rmdir()
        self.plan.update(instances=[], snapshot_paths=[])
        self.containers[:] = [c for c in self.containers if c.get('module_id') != 'doska']
        self.helper.apply.side_effect = ValueError('injected descriptor-only update failure')
        self.delivery.run_operation()
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'rolled_back')
        self.assertEqual(self.delivery.module_registry()['doska'], self.old_descriptor)
        self.assertEqual((self.volume_roots[0] / 'database').read_bytes(), d.json_bytes(self.original))
        self.assertFalse(self.restarted)

    def test_admission_allows_neighbours_and_fences_target_and_global_changes(self):
        for phase in ('queued', 'snapshot', 'applying', 'recovery_required'):
            d.atomic(self.delivery.base / 'operation.json', {**self.request, 'phase': phase})
            for kind in ('forms', 'sftpgo', 'prometheus', 'core'):
                with self.delivery.rpc_guard(module_id=kind):
                    pass
            for kind in ('doska', None):
                with self.assertRaises(ValueError), self.delivery.rpc_guard(module_id=kind):
                    pass
        d.atomic(self.delivery.base / 'operation.json', {**self.request, 'phase': 'reconciling', 'data_committed': True})
        with self.delivery.rpc_guard(module_id='doska', allow_refresh=True):
            pass

    def test_scoped_restore_rejects_other_paths_before_deleting_anything(self):
        archive = self.root / 'bad.tar'
        with tarfile.open(archive, 'w') as tar:
            entry = tarfile.TarInfo('private/new-neighbour-key'); entry.size = 1
            tar.addfile(entry, io.BytesIO(b'x'))
        with self.assertRaisesRegex(ValueError, 'outside the selected'):
            d.restore_tree(archive, self.root, allowed_roots={self.relative})
        self.assertEqual((self.native / 'state.json').read_text(), 'original-native-configuration')


class ScopedControllerCacheTests(unittest.TestCase):
    def test_first_refresh_replaces_cached_target_and_retains_neighbour(self):
        controller = transport.pl.Controller.__new__(transport.pl.Controller)
        target, neighbour = object(), object()
        controller._doska_controller, controller._forms_controller = target, neighbour
        registry = {'doska': {'api': {'id': 'new-api'}, 'web': {'id': 'new-web'}}}
        controller.delivery = lambda: SimpleNamespace(module_registry=lambda: registry)
        controller.refresh_module_descriptor('doska')
        self.assertFalse(hasattr(controller, '_doska_controller'))
        self.assertIs(controller._forms_controller, neighbour)
        current = object()
        controller._doska_controller = current
        controller.refresh_module_descriptor('doska')
        self.assertIs(controller._doska_controller, current)
        registry['doska'] = {'api': {'id': 'next-api'}, 'web': {'id': 'next-web'}}
        controller.refresh_module_descriptor('doska')
        self.assertFalse(hasattr(controller, '_doska_controller'))

    def test_authenticated_stream_refreshes_descriptor_without_holding_barrier_for_stream(self):
        fixture = transport.SignedTransportTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        handler, _ = fixture.handler(method='GET', path='/api/doska/projects', content_type='')
        parent = handler.server.controller
        parent.on_demand = True
        admitted = []
        active = False
        fresh = Mock()
        @contextmanager
        def admission(**kwargs):
            nonlocal active
            self.assertEqual(kwargs, {'module_id': 'doska'})
            active = True
            admitted.append(True)
            parent.application.return_value = fresh
            try:
                yield
            finally:
                active = False
        parent.delivery_guard = admission
        fresh.transport.side_effect = lambda *args: self.assertFalse(active, 'long stream retained the delivery barrier')
        handler.handle_doska_transport()
        self.assertEqual(admitted, [True])
        fresh.transport.assert_called_once()


if __name__ == '__main__':
    unittest.main()
