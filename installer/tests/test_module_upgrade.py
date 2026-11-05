"""Native rebuild safety with real Doska inspectors/renderers and a finite engine.

No Docker daemon, external network, production files, or database is contacted.
"""
import copy
import hashlib
import importlib.util
import json
import os
import signal
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import Mock, patch

BASE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('pl_upgrade_test_' + name.replace('-', '_'), BASE / (name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


upgrade = load('module-upgrade')
doska = load('doska-controller')


class NativeRebuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('private', 'state', 'modules'): (self.root / name).mkdir(mode=0o700)
        self.installation = 'pl-123456abcdef'
        self.instances = [str(uuid.uuid4()), str(uuid.uuid4())]
        self.old = {}
        for role in doska.ROLES:
            labels = {'pl.source.sha256': 'a' * 64}
            if role == 'database': labels['pl.component'] = 'postgresql'
            else: labels.update({'pl.module.id': 'doska', 'pl.module.role': role, 'pl.module.config.version': '1',
                                 'pl.build.variant': 'source-build', 'org.opencontainers.image.version': '2.46.2'})
            self.old[role] = {'id': 'sha256:' + hashlib.sha256(('old-' + role).encode()).hexdigest(),
                'architecture': 'amd64', 'ref': 'pl/doska-' + role + ':0.3.1',
                'recipe': 'deploy/images/postgres.Dockerfile' if role == 'database' else 'deploy/images/doska.Dockerfile', 'labels': labels}
        self.new = copy.deepcopy(self.old)
        for role in ('api', 'web'):
            self.new[role].update(id='sha256:' + hashlib.sha256(('new-' + role).encode()).hexdigest(), ref='pl/doska-' + role + ':0.4.2')
            self.new[role]['labels']['pl.source.sha256'] = 'b' * 64
        self.images = {}
        for descriptor in (self.old, self.new):
            for role, image in descriptor.items():
                self.images[image['id']] = {'Id': image['id'], 'Os': 'linux', 'Architecture': 'amd64',
                    'Config': {'Labels': image['labels'], 'Env': ['LANG=C.UTF-8'], 'Entrypoint': ['/native-' + role],
                               'Cmd': [], 'WorkingDir': '/', 'User': 'postgres' if role == 'database' else '1000:1000'}}
        self.registry = {'schema': 1, 'installation': self.installation, 'manifest_sha256': 'c' * 64, 'doska': self.old}
        upgrade.files.atomic(self.root / 'private/module-images.json', self.registry)
        upgrade.files.atomic(self.root / 'state/installation.json', {'install_id': self.installation,
            'version': '0.4.1', 'manifest_sha256': 'c' * 64, 'config': {'public_url': 'https://pl.example'}})
        upgrade.files.atomic(self.root / 'private/module-controller-key', b'x' * 32, mode=0o640)
        upgrade.files.atomic(self.root / 'private/tls.crt', b'-----BEGIN CERTIFICATE-----\nfixture-ca\n', mode=0o444)
        self.calls, self.checkpoints, self.containers, self.resources, self.userdata = [], [], {}, {'network': {}, 'volume': {}}, {}
        self.counter = 0; self.fail_checkpoint = None; self.durable = None
        self.parent = types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker,
                                            module_upgrade_checkpoint=self.checkpoint)
        for key in ('API_GID', 'DATABASE_GID'):
            item = patch.object(doska, key, os.getgid()); item.start(); self.addCleanup(item.stop)
        self.controller = doska.DoskaController(self.parent)
        self.parent.application = lambda kind: self.controller if kind == 'doska' else self.fail('foreign kind')
        self.health_calls = []
        def http(instance, *args, **kwargs):
            self.health_calls.append(instance); return 200, 'application/json', b'{}'
        self.controller.http = http
        for index, instance in enumerate(self.instances):
            self.controller.initialize(instance)
            self.controller.create_resource(instance, 'network')
            for volume in ('database', 'attachments'): self.controller.create_resource(instance, 'volume', volume)
            for role in doska.ROLES:
                self.controller.create_container(instance, role)
                if index == 0: self.docker('container', 'start', self.controller.name(instance, '-' + role))
        for role in ('api', 'web', 'db'):
            name = self.installation + '-' + role + '-1'
            self.containers[name] = {'Id': hashlib.sha256(name.encode()).hexdigest(), 'Name': '/' + name,
                'Image': 'sha256:' + 'f' * 64, 'Config': {'Labels': {'com.docker.compose.project': self.installation,
                'com.docker.compose.service': role}}, 'State': {'Running': True}, 'HostConfig': {}, 'Mounts': [], 'NetworkSettings': {}}
        self.calls.clear()

    def checkpoint(self, value):
        snapshot = copy.deepcopy(value)
        self.calls.append(('checkpoint', snapshot))
        if self.fail_checkpoint and self.fail_checkpoint(snapshot):
            raise RuntimeError('simulated durable checkpoint interruption')
        self.durable = snapshot; self.checkpoints.append(snapshot)

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        kind, action = args[:2]
        if kind == 'image' and action == 'inspect': return json.dumps([self.images[args[-1]]]).encode()
        if kind in ('network', 'volume'):
            if action == 'ls':
                pattern = args[3].removeprefix('name=^').removesuffix('$')
                return pattern.encode() if pattern in self.resources[kind] else b''
            if action == 'inspect':
                obj = copy.deepcopy(self.resources[kind][args[-1]])
                if kind == 'network': obj['Containers'] = {c['Id']: {'Name': name} for name, c in self.containers.items()
                    if args[-1] in c.get('NetworkSettings', {}).get('Networks', {})}
                return json.dumps([obj]).encode()
            if action == 'create':
                labels = dict(args[i + 1].split('=', 1) for i, value in enumerate(args) if value == '--label')
                name = args[-1]; self.resources[kind][name] = {'Id': hashlib.sha256(name.encode()).hexdigest(), 'Name': name,
                    'Driver': 'bridge' if kind == 'network' else 'local', 'Internal': False, 'Ingress': False, 'Scope': 'local',
                    'Options': {}, 'Labels': labels, 'IPAM': {'Config': [{'Subnet': '192.0.2.0/28', 'Gateway': '192.0.2.1'}]}}
                if kind == 'volume': self.userdata[name] = b'existing user attachment or database rows'
                return name.encode()
        if kind == 'container':
            if action == 'ls':
                selected = list(self.containers.values())
                for i, value in enumerate(args):
                    if value != '--filter': continue
                    query = args[i + 1]
                    if query.startswith('name=^/'):
                        name = query.removeprefix('name=^/').removesuffix('$')
                        selected = [obj for obj in selected if obj['Name'] == '/' + name]
                    elif query.startswith('label='):
                        key, value = query.removeprefix('label=').split('=', 1)
                        selected = [obj for obj in selected if obj['Config']['Labels'].get(key) == value]
                    else: raise AssertionError('Unbounded fake query ' + query)
                return '\n'.join(obj['Id'] for obj in selected).encode()
            if action == 'inspect':
                return json.dumps([next(obj for obj in self.containers.values() if name in (obj['Name'][1:], obj['Id']))
                                   for name in args[2:]]).encode()
            if action == 'create':
                name = args[args.index('--name') + 1]; self.assertNotIn(name, self.containers)
                image = args[-1]; self.counter += 1
                identifier = hashlib.sha256((name + image + str(self.counter)).encode()).hexdigest()
                config = copy.deepcopy(self.images[image]['Config'])
                config.update(Image=image, Hostname=identifier[:12], User=args[args.index('--user') + 1])
                config['Labels'].update(dict(args[i + 1].split('=', 1) for i, value in enumerate(args) if value == '--label'))
                config['Env'] += [args[i + 1] for i, value in enumerate(args) if value == '--env']
                mounts = []
                for i, value in enumerate(args):
                    if value == '--mount':
                        fields = dict(part.split('=', 1) if '=' in part else (part, True) for part in args[i + 1].split(','))
                        mounts.append({'Type': fields['type'], 'Name': fields['source'] if fields['type'] == 'volume' else '',
                            'Source': '/var/lib/docker/volumes/' + fields['source'] + '/_data' if fields['type'] == 'volume' else fields['source'],
                            'Destination': fields['target'], 'RW': not fields.get('readonly', False)})
                ports = {}
                for i, value in enumerate(args):
                    if value == '--publish':
                        ip, host, port = args[i + 1].split(':'); ports[port + '/tcp'] = [{'HostIp': ip, 'HostPort': host}]
                network = args[args.index('--network') + 1]; role = config['Labels']['pl.module.role']
                self.containers[name] = {'Id': identifier, 'Name': '/' + name, 'Image': image, 'Config': config, 'Mounts': mounts,
                    'State': {'Running': False, 'Status': 'created'},
                    'HostConfig': {'PortBindings': ports, 'ReadonlyRootfs': True, 'CapDrop': ['ALL'], 'NetworkMode': network,
                        'Memory': 512 * 1024**2, 'NanoCpus': 1_000_000_000, 'PidsLimit': 256, 'Init': True,
                        'Tmpfs': dict(args[i + 1].split(':', 1) for i, value in enumerate(args) if value == '--tmpfs'),
                        'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}},
                        'RestartPolicy': {'Name': 'unless-stopped'}, 'SecurityOpt': ['no-new-privileges:true']},
                    'NetworkSettings': {'Networks': {network: {'Aliases': [role, name, identifier[:12]], 'NetworkID': 'e' * 64}}, 'Ports': {}}}
                return identifier.encode()
            if action in ('start', 'stop', 'rm'):
                name = next(name for name, obj in self.containers.items() if args[-1] in (name, obj['Id']))
                obj = self.containers[name]
                if action == 'rm':
                    self.assertFalse(obj['State']['Running']); del self.containers[name]
                else:
                    obj['State']['Running'] = action == 'start'
                    if action == 'start':
                        obj['NetworkSettings']['Ports'] = {port: [{'HostIp': '127.0.0.1', 'HostPort': str(32000 + self.counter)}]
                            for port in obj['HostConfig']['PortBindings']}
                return b''
        raise AssertionError('Unexpected fake Docker operation ' + repr(args))

    def snapshot(self, value):
        value['snapshot_operation_id'] = str(uuid.uuid4())
        folder = self.root / 'private/upgrade-backups' / value['snapshot_operation_id']; folder.mkdir(parents=True)
        volumes = sorted({self.installation + '-auth', self.installation + '_db', *self.userdata})
        meta = {'schema': 1, 'installation': self.installation, 'operation_id': value['snapshot_operation_id'],
            'from_version': '0.4.1', 'volumes': [{'name': name} for name in volumes],
            'containers': [{'name': obj['Name'][1:], 'core': 'com.docker.compose.project' in obj['Config']['Labels'],
                           'service': obj['Config']['Labels'].get('com.docker.compose.service', '')} for obj in self.containers.values()]}
        upgrade.files.atomic(folder / 'snapshot.json', meta)
        return folder

    def prepare(self):
        value = upgrade.plan(self.parent, 'doska', self.old, self.new)
        self.snapshot(value)
        for obj in self.containers.values():
            obj['State']['Running'] = obj['Config']['Labels'].get('com.docker.compose.service') == 'web'
        self.registry['doska'] = self.new
        upgrade.files.atomic(self.root / 'private/module-images.json', self.registry)
        self.calls.clear()
        return value

    def native_files(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in (self.root / 'modules').rglob('*') if p.is_file()}

    def test_two_instances_replace_only_application_images_preserve_all_data_and_disabled_state(self):
        before_files, data = self.native_files(), copy.deepcopy(self.userdata)
        database_ids = {instance: self.containers[self.controller.name(instance, '-database')]['Id'] for instance in self.instances}
        value = self.prepare(); self.assertEqual(value['changed_roles'], ['api', 'web'])
        self.assertEqual([x['running'] for x in value['instances']], [self.instances.index(x['instance_id']) == 0 for x in value['instances']])
        upgrade.apply(self.parent, value)
        removed = [call for call in self.calls if call[:2] == ('container', 'rm')]
        self.assertEqual(len(removed), 4)
        self.assertFalse(any(call[:2] == ('container', 'start') for call in self.calls))
        self.assertEqual(self.native_files(), before_files); self.assertEqual(self.userdata, data)
        for instance in self.instances:
            self.assertEqual(self.containers[self.controller.name(instance, '-database')]['Id'], database_ids[instance])
            for role in doska.ROLES:
                obj = self.containers[self.controller.name(instance, '-' + role)]
                self.assertEqual(obj['Image'], self.new[role]['id']); self.assertFalse(obj['State']['Running'])
        # The worker, not the helper, starts the original running dependency set.
        for role in doska.ROLES: self.docker('container', 'start', self.controller.name(self.instances[0], '-' + role))
        count = len([call for call in self.calls if call[:2] == ('container', 'start')])
        result = upgrade.verify(self.parent, value)
        self.assertEqual((result['running'], result['stopped']), (1, 1))
        self.assertEqual(set(self.health_calls), {self.instances[0]})
        self.assertEqual(len([call for call in self.calls if call[:2] == ('container', 'start')]), count)
        self.assertEqual(self.controller.images, self.old, 'Worker must use private new-descriptor copies even when its parent cache stays old')
        for i, call in enumerate(self.calls):
            if call[:2] in (('container', 'rm'), ('container', 'create')):
                checkpoint = next(event[1] for event in reversed(self.calls[:i]) if event[0] == 'checkpoint')
                if call[1] == 'rm':
                    self.assertTrue(any(entry['intent'] == {'action': 'remove', 'direction': 'apply', 'id': call[-1]}
                                        for entry in checkpoint['ledger'].values()))
                else:
                    name = call[call.index('--name') + 1]
                    self.assertEqual(checkpoint['ledger'][name]['intent'], {'action': 'create', 'direction': 'apply'})

    def test_unsupported_upstream_storage_roles_architecture_or_launch_defaults_fail_before_stop(self):
        for kind in ('upstream', 'storage', 'roles', 'architecture', 'defaults'):
            with self.subTest(change=kind):
                candidate = copy.deepcopy(self.new)
                image = copy.deepcopy(self.images[self.new['api']['id']])
                if kind == 'upstream': candidate['api']['labels']['org.opencontainers.image.version'] = '2.46.3'
                elif kind == 'storage': candidate['database']['ref'] += '-new'
                elif kind == 'roles': del candidate['web']
                elif kind == 'architecture': candidate['api']['architecture'] = 'arm64'
                else: self.images[self.new['api']['id']]['Config']['Env'] = ['CHANGED=1']
                self.calls.clear()
                with self.assertRaises(upgrade.UnsupportedTransition): upgrade.plan(self.parent, 'doska', self.old, candidate)
                self.assertFalse(any(call[:2] in (('container', 'stop'), ('container', 'rm'), ('container', 'create')) for call in self.calls))
                self.images[self.new['api']['id']] = image

    def test_mixed_or_foreign_native_roles_are_rejected_without_any_write(self):
        obj = self.containers[self.controller.name(self.instances[0], '-api')]
        obj['State']['Running'] = False
        with self.assertRaisesRegex(ValueError, 'Mixed'): upgrade.plan(self.parent, 'doska', self.old, self.new)
        obj['State']['Running'] = True; obj['Config']['Labels']['pl.installation'] = 'pl-000000000000'
        with self.assertRaises(ValueError): upgrade.plan(self.parent, 'doska', self.old, self.new)
        self.assertFalse(self.checkpoints)

    def test_custom_labels_paused_runtime_and_fixed_api_ports_are_rejected_before_stop(self):
        obj = self.containers[self.controller.name(self.instances[0], '-api')]
        for change in ('label', 'paused', 'port'):
            with self.subTest(change=change):
                original = copy.deepcopy(obj)
                if change == 'label': obj['Config']['Labels']['custom'] = 'unsupported'
                elif change == 'paused': obj['State']['Paused'] = True
                else: obj['HostConfig']['PortBindings']['1337/tcp'][0]['HostPort'] = '1337'
                self.calls.clear()
                with self.assertRaises(upgrade.UnsupportedTransition): upgrade.plan(self.parent, 'doska', self.old, self.new)
                self.assertFalse(any(call[:2] in (('container', 'stop'), ('container', 'rm')) for call in self.calls))
                obj.clear(); obj.update(original)

    def test_every_instance_is_fenced_before_first_destructive_action(self):
        value = self.prepare()
        obj = self.containers[self.controller.name(self.instances[1], '-web')]
        obj['Config']['Env'].append('INJECTED=value')
        with self.assertRaises(ValueError): upgrade.apply(self.parent, value)
        self.assertFalse(any(call[:2] in (('container', 'rm'), ('container', 'create')) for call in self.calls))
        self.assertFalse(self.checkpoints)

    def test_global_quiesce_registry_snapshot_and_durable_callback_are_mandatory(self):
        value = self.prepare(); api = self.containers[self.installation + '-api-1']; api['State']['Running'] = True
        with self.assertRaisesRegex(ValueError, 'quiesced'): upgrade.apply(self.parent, value)
        api['State']['Running'] = False
        self.registry['doska'] = self.old; upgrade.files.atomic(self.root / 'private/module-images.json', self.registry)
        with self.assertRaisesRegex(ValueError, 'registry'): upgrade.apply(self.parent, value)
        self.registry['doska'] = self.new; upgrade.files.atomic(self.root / 'private/module-images.json', self.registry)
        snapshot = value.pop('snapshot_operation_id')
        with self.assertRaises(ValueError): upgrade.apply(self.parent, value)
        value['snapshot_operation_id'] = snapshot
        self.parent.module_upgrade_checkpoint = None
        with self.assertRaisesRegex(ValueError, 'checkpoint'): upgrade.apply(self.parent, value)
        self.assertFalse(any(call[:2] == ('container', 'rm') for call in self.calls))

    def test_config_drift_is_rejected_even_after_a_container_is_already_removed(self):
        value = self.prepare(); item = value['instances'][0]; spec = next(x for x in item['containers'] if x['role'] == 'api')
        value['ledger'][spec['name']] = {'intent': {'action': 'remove', 'direction': 'apply', 'id': spec['id']}, 'replacements': []}
        self.docker('container', 'rm', spec['id']); self.calls.clear()
        config = self.controller.paths(item['instance_id']) / 'config/gateway_key'; config.chmod(0o640)
        config.write_bytes(b'changed-auth'); config.chmod(0o440)
        with self.assertRaises(ValueError): upgrade.apply(self.parent, value)
        self.assertFalse(any(call[:2] in (('container', 'rm'), ('container', 'create')) for call in self.calls))

    def restore_registry(self):
        self.registry['doska'] = self.old; upgrade.files.atomic(self.root / 'private/module-images.json', self.registry)

    def test_rollback_after_full_recreation_keeps_volumes_auth_and_all_originally_stopped(self):
        before_files, data = self.native_files(), copy.deepcopy(self.userdata)
        value = self.prepare(); upgrade.apply(self.parent, value); self.restore_registry(); self.calls.clear()
        upgrade.rollback(self.parent, value)
        self.assertEqual(self.native_files(), before_files); self.assertEqual(self.userdata, data)
        self.assertFalse(any(call[:2] == ('container', 'start') for call in self.calls))
        for instance in self.instances:
            for role in doska.ROLES:
                obj = self.containers[self.controller.name(instance, '-' + role)]
                self.assertEqual(obj['Image'], self.old[role]['id']); self.assertFalse(obj['State']['Running'])

    def test_apply_and_restored_rollback_can_resume_without_recreating_proved_roles_twice(self):
        value = self.prepare(); upgrade.apply(self.parent, value); self.calls.clear()
        upgrade.apply(self.parent, value)
        self.assertFalse(any(call[:2] in (('container', 'rm'), ('container', 'create')) for call in self.calls))
        self.restore_registry(); upgrade.rollback(self.parent, value); self.calls.clear()
        upgrade.rollback(self.parent, value)
        self.assertFalse(any(call[:2] in (('container', 'rm'), ('container', 'create')) for call in self.calls))

    def test_new_artifact_can_keep_all_image_ids_and_update_only_its_descriptor_refs(self):
        self.new = copy.deepcopy(self.old)
        for image in self.new.values(): image['ref'] += '-artifact'
        # Storage descriptors are immutable even when a ref is not used to run.
        self.new['database'] = copy.deepcopy(self.old['database'])
        value = self.prepare(); self.assertEqual(value['changed_roles'], [])
        upgrade.apply(self.parent, value)
        self.assertFalse(any(call[:2] in (('container', 'rm'), ('container', 'create'), ('container', 'start')) for call in self.calls))

    def test_crash_after_create_before_checkpoint_is_adopted_only_by_strict_native_contract(self):
        value = self.prepare()
        self.fail_checkpoint = lambda v: any(item['replacements'] for item in v['ledger'].values())
        with self.assertRaises(RuntimeError): upgrade.apply(self.parent, value)
        recovered = copy.deepcopy(self.durable)
        self.assertTrue(any(item['intent']['action'] == 'create' for item in recovered['ledger'].values()))
        self.assertFalse(any(item['replacements'] for item in recovered['ledger'].values()))
        self.fail_checkpoint = None; self.restore_registry(); self.calls.clear()
        upgrade.rollback(self.parent, recovered)
        self.assertEqual(len(self.containers), 9)
        self.assertFalse(any(call[:2] == ('container', 'start') for call in self.calls))
        self.assertTrue(all(obj['Image'] == self.old[role]['id'] for instance in self.instances for role in doska.ROLES
                            for obj in [self.containers[self.controller.name(instance, '-' + role)]]))

    def test_unproved_foreign_replacement_after_crash_is_not_removed(self):
        value = self.prepare(); self.fail_checkpoint = lambda v: any(item['replacements'] for item in v['ledger'].values())
        with self.assertRaises(RuntimeError): upgrade.apply(self.parent, value)
        recovered = copy.deepcopy(self.durable); self.fail_checkpoint = None; self.restore_registry()
        target = next(spec for item in recovered['instances'] for spec in item['containers']
                      if recovered['ledger'].get(spec['name'], {}).get('intent', {}).get('action') == 'create')
        self.containers[target['name']]['Config']['Env'].append('FOREIGN=1'); self.calls.clear()
        with self.assertRaises(ValueError): upgrade.rollback(self.parent, recovered)
        self.assertFalse(any(call[:2] == ('container', 'rm') for call in self.calls))

    def test_readiness_deadline_interrupts_native_calls_and_restores_process_alarm(self):
        value = self.prepare(); upgrade.apply(self.parent, value)
        for role in doska.ROLES: self.docker('container', 'start', self.controller.name(self.instances[0], '-' + role))
        previous = signal.getsignal(signal.SIGALRM)
        self.controller.ready = Mock(side_effect=lambda instance: signal.raise_signal(signal.SIGALRM))
        with self.assertRaisesRegex(ValueError, '120 second'):
            upgrade.verify(self.parent, value)
        self.assertEqual(signal.getsignal(signal.SIGALRM), previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))


class CreateOnlyAPITests(unittest.TestCase):
    def test_xray_and_alertmanager_create_default_start_remains_compatible(self):
        for name, cls in (('xray-controller', 'XrayController'), ('alertmanager-controller', 'AlertmanagerController')):
            module = load(name); c = object.__new__(getattr(module, cls))
            c.docker = Mock(return_value=b'created'); c.verify_image = Mock()
            c.inspect = Mock(return_value={'Id': 'd' * 64, 'State': {'Running': False}})
            c.name = lambda instance: 'owned-module'; c.paths = lambda instance: Path('/owned/config')
            c.labels = lambda *args: {}; c.image = 'sha256:' + 'e' * 64
            instance = str(uuid.uuid4())
            if name.startswith('xray'):
                c.revoke_runtime = Mock(); c.selected = Mock(return_value={'public': {}}); c.bindings = Mock(return_value={})
                args = (instance, str(uuid.uuid4()))
            else:
                c.revoke_read_route = Mock(); c.owned_volume = Mock(return_value={'owned': True}); args = (instance,)
            c.create_container(*args, start=False)
            self.assertFalse(any(call.args[:2] == ('container', 'start') for call in c.docker.call_args_list))
            c.docker.reset_mock(); c.create_container(*args)
            c.docker.assert_any_call('container', 'start', 'd' * 64)

    def test_prometheus_create_does_not_start_and_ensure_still_does(self):
        module = load('module-controller'); c = object.__new__(module.Controller)
        c.preflight = Mock(); c.config = Mock(return_value=Path('/owned/config')); c.verify_image = Mock()
        c.labels = lambda instance: {}; c.name = lambda instance: 'owned-prometheus'; c.image = 'sha256:' + 'e' * 64
        volume = {'Driver': 'local', 'Labels': {}}
        c.docker = Mock(side_effect=lambda *args, **kwargs: json.dumps([volume]).encode() if args[:2] == ('volume', 'inspect') else b'owned-data')
        c.inspect = Mock(return_value={})
        c.create(str(uuid.uuid4()))
        self.assertFalse(any(call.args[:2] == ('container', 'start') for call in c.docker.call_args_list))
        c.docker.reset_mock(); c.inspect = Mock(return_value=None)
        c.ensure(str(uuid.uuid4()))
        c.docker.assert_any_call('container', 'start', 'owned-prometheus')
