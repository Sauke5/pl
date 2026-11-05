"""BookStack lifecycle ownership and persistence; execute only in authorized CI."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pl_bookstack_test', BASE / 'bookstack-controller.py')
bs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bs)


class BookStackTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for name in ('private', 'state', 'modules'):
            (self.root / name).mkdir(mode=0o700)
        self.installation, self.instance = 'pl-123456abcdef', str(uuid.uuid4())
        self.images = {role: {'id': 'sha256:' + digit * 64, 'architecture': 'amd64', 'ref': 'pl/bookstack-' + role,
            'recipe': 'deploy/images/bookstack.Dockerfile', 'labels': {'pl.module.id': 'bookstack', 'pl.module.role': role,
                'pl.module.config.version': '1', 'pl.build.variant': 'upstream-pinned', 'org.opencontainers.image.version': '26.09.2',
                'pl.upstream.version': '13.0.2' if role == 'database' else '26.09.2'}}
            for role, digit in (('database', '1'), ('web', '2'))}
        bs.atomic(self.root / 'state/installation.json', {'install_id': self.installation, 'manifest_sha256': 'a' * 64,
                  'config': {'public_url': 'https://pl.example'}})
        bs.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
                  'manifest_sha256': 'a' * 64, 'bookstack': self.images})
        self.calls, self.containers, self.volumes = [], {}, {}
        self.ingress = self.installation + '_ingress'
        self.networks = {self.ingress: self.network(self.ingress, {'pl.installation': self.installation,
            'com.docker.compose.project': self.installation, 'com.docker.compose.network': 'ingress'}, '9' * 64)}
        self.controller = bs.BookStackController(types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker))
        self.controller.http = lambda instance, obj: {'database': True, 'cache': True, 'session': True}
        for method, value in (('module_network_args', []), ('validate_module_network', None)):
            mocking = patch.object(bs._files, method, return_value=value)
            mocking.start()
            self.addCleanup(mocking.stop)

    @staticmethod
    def network(name, labels, identity):
        return {'Name': name, 'Labels': labels, 'Driver': 'bridge', 'Options': {}, 'Scope': 'local', 'Internal': False,
                'Ingress': False, 'Containers': {}, 'Id': identity, 'IPAM': {'Config': [{'Gateway': '172.29.0.1'}]}}

    def image_config(self, role):
        return {'User': '', 'Entrypoint': ['/init'] if role == 'web' else ['docker-entrypoint.sh'],
                'Cmd': None if role == 'web' else ['mariadbd'], 'Env': ['FIXTURE=1'],
                'WorkingDir': '/' if role == 'web' else None, 'Labels': self.images[role]['labels']}

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        kind, action = args[:2]
        if kind == 'image':
            role = next(role for role in bs.ROLES if self.images[role]['id'] == args[-1])
            return json.dumps([{'Id': args[-1], 'Architecture': 'amd64', 'Os': 'linux', 'Config': self.image_config(role)}]).encode()
        if kind in ('network', 'volume'):
            resources = self.networks if kind == 'network' else self.volumes
            if action == 'ls':
                name = args[3].removeprefix('name=^').removesuffix('$')
                return name.encode() if name in resources else b''
            if action == 'inspect':
                return json.dumps([resources[args[-1]]]).encode()
            if action == 'create':
                name = args[-1]
                labels = dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')
                resources[name] = self.network(name, labels, '8' * 64) if kind == 'network' else {'Name': name, 'Driver': 'local', 'Options': {}, 'Labels': labels}
                return name.encode()
            if action == 'connect':
                network, identity = args[-2:]
                obj = next(obj for obj in self.containers.values() if obj['Id'] == identity)
                alias = args[args.index('--alias') + 1]
                obj['NetworkSettings']['Networks'][network] = {'NetworkID': self.networks[network]['Id'], 'Aliases': [obj['Name'][1:], alias]}
                self.networks[network]['Containers'][identity] = {'Name': obj['Name'][1:]}
                return b''
            if action == 'rm':
                del resources[args[-1]]
                return b''
        if kind == 'container':
            if action == 'ls':
                name = args[4].removeprefix('name=^/').removesuffix('$')
                return self.containers[name]['Id'].encode() if name in self.containers else b''
            if action == 'inspect':
                obj = self.containers.get(args[-1]) or next(obj for obj in self.containers.values() if obj['Id'] == args[-1])
                return json.dumps([obj]).encode()
            if action == 'create':
                name = args[args.index('--name') + 1]
                role = name.rsplit('-', 1)[1]
                identity = ('3' if role == 'database' else '4') * 64
                config = copy.deepcopy(self.image_config(role))
                # Docker normalizes a missing image cwd to an empty container cwd.
                if config.get('WorkingDir') is None:
                    config['WorkingDir'] = ''
                env = dict(item.split('=', 1) for item in config['Env'])
                env.update(dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '--env'))
                config.update(Image=args[-1], Env=[key + '=' + value for key, value in env.items()],
                    Labels=dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '--label'))
                mounts = []
                for i, arg in enumerate(args):
                    if arg == '--mount':
                        values = dict(part.split('=', 1) if '=' in part else (part, True) for part in args[i + 1].split(','))
                        mounts.append({'Type': values['type'], 'Name': values['source'], 'Source': values['source'],
                                       'Destination': values['target'], 'RW': not values.get('readonly', False)})
                network = args[args.index('--network') + 1]
                alias = args[args.index('--network-alias') + 1]
                self.containers[name] = {'Id': identity, 'Name': '/' + name, 'Image': args[-1], 'Config': config, 'Mounts': mounts,
                    'State': {'Running': False, 'Status': 'created'}, 'HostConfig': {'PortBindings': {} if role == 'database' else {'80/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]},
                        'ReadonlyRootfs': False,
                        'CapDrop': [args[i + 1] for i, arg in enumerate(args) if arg == '--cap-drop'],
                        'CapAdd': ['CAP_' + args[i + 1].removeprefix('CAP_') for i, arg in enumerate(args) if arg == '--cap-add'],
                        'NetworkMode': network, 'Memory': 512 * 1024**2,
                        'NanoCpus': 1_000_000_000, 'PidsLimit': 256, 'SecurityOpt': ['no-new-privileges'],
                        'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}}, 'RestartPolicy': {'Name': 'unless-stopped'}},
                    'NetworkSettings': {'Networks': {network: {'NetworkID': self.networks[network]['Id'], 'Aliases': [name, alias]}},
                        'Ports': {} if role == 'database' else {'80/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '32100'}]}}}
                self.networks[network]['Containers'][identity] = {'Name': name}
                return identity.encode()
            if action in ('start', 'stop', 'rm'):
                name = next(name for name, obj in self.containers.items() if obj['Id'] == args[-1])
                obj = self.containers[name]
                if action == 'rm':
                    for network in self.networks.values():
                        network['Containers'].pop(obj['Id'], None)
                    del self.containers[name]
                else:
                    obj['State'] = {'Running': action == 'start', 'Status': 'running' if action == 'start' else 'exited'}
                return b''
        raise AssertionError('Unexpected Docker operation: ' + repr(args))

    def operation(self, action, operation=None):
        return {'operation_id': operation or str(uuid.uuid4()), 'instance_id': self.instance, 'module_id': 'bookstack', 'action': action}

    def install(self):
        result = self.controller.execute(self.operation('install'))
        self.assertEqual(result['state'], 'running')
        return result

    def test_capability_prefix_normalization_keeps_exact_privilege_boundary(self):
        self.install()
        for role in bs.ROLES:
            obj = self.containers[self.controller.name(self.instance, '-' + role)]
            canonical = list(obj['HostConfig']['CapAdd'])
            for accepted in (list(bs.CAPS), canonical, [cap if i % 2 else cap.removeprefix('CAP_') for i, cap in enumerate(canonical)]):
                obj['HostConfig']['CapAdd'] = accepted
                self.assertEqual(self.controller.inspect(self.instance, role), obj)
            for invalid in (canonical + ['CAP_SYS_ADMIN'], canonical[:-1], canonical + canonical[:1],
                            ['CAP_' + cap for cap in canonical], [None], 'CAP_CHOWN'):
                with self.subTest(role=role, invalid=invalid):
                    obj['HostConfig']['CapAdd'] = invalid
                    with self.assertRaisesRegex(ValueError, 'drift'):
                        self.controller.inspect(self.instance, role)
            obj['HostConfig']['CapAdd'] = canonical

    def test_empty_default_working_directory_is_equivalent_for_both_roles(self):
        original = self.image_config
        with patch.object(self, 'image_config', side_effect=lambda role: {**original(role), 'WorkingDir': None}):
            self.install()
            for role in bs.ROLES:
                with self.subTest(role=role):
                    obj = self.containers[self.controller.name(self.instance, '-' + role)]
                    self.assertEqual(obj['Config']['WorkingDir'], '')
                    self.assertEqual(self.controller.inspect(self.instance, role), obj)
                    # Both null and empty are default cwd representations.
                    obj['Config']['WorkingDir'] = None
                    self.assertEqual(self.controller.inspect(self.instance, role), obj)

    def test_foreign_working_directory_and_command_drift_remain_rejected(self):
        self.install()
        for role in bs.ROLES:
            obj = self.containers[self.controller.name(self.instance, '-' + role)]
            for field, value in (('WorkingDir', '/foreign'), ('Entrypoint', []),
                                 ('Cmd', [] if role == 'web' else None)):
                with self.subTest(role=role, field=field):
                    original = obj['Config'][field]
                    obj['Config'][field] = value
                    with self.assertRaises(ValueError):
                        self.controller.inspect(self.instance, role)
                    obj['Config'][field] = original

    def test_initial_login_is_human_only_read_and_never_resets_native_password(self):
        self.install()
        body = {'instance_id': self.instance, 'module_id': 'bookstack', 'service': 'bookstack'}
        before = list(self.calls)
        state = self.controller.state(self.instance)
        value = self.controller.initial_login(body)
        self.assertEqual(value['username'], 'admin@pl.invalid')
        self.assertEqual(value['password'], state['admin_password'])
        self.assertEqual(value['path'], '/wiki/login')
        self.assertEqual(set(value), {'instance_id', 'module_id', 'service', 'username', 'password', 'path'})
        self.assertNotIn(state['database_password'], json.dumps(value))
        self.assertNotIn(state['app_key'], json.dumps(value))
        self.assertFalse(any(call[:2] in (('container', 'exec'), ('container', 'create'), ('container', 'start')) for call in self.calls[len(before):]))
        for extra in ({'service': 'database'}, {'module_id': 'netmap'}, {'password': 'reset'}):
            with self.assertRaises(ValueError):
                self.controller.initial_login({**body, **extra})
        self.containers[self.controller.name(self.instance, '-web')]['State']['Running'] = False
        with self.assertRaises(ValueError):
            self.controller.initial_login(body)

    def test_new_bootstrap_password_is_eight_random_letters_and_digits(self):
        with patch.object(bs.secrets, 'choice', side_effect=list('Az09By18')) as choose:
            self.install()
        state = self.controller.state(self.instance)
        self.assertEqual(state['admin_password'], 'Az09By18')
        self.assertEqual(choose.call_count, 8)
        self.assertEqual((self.controller.paths(self.instance) / 'config/admin_password').read_bytes(), b'Az09By18')
        for name in bs.SECRET_NAMES:
            if name != 'admin_password':
                self.assertRegex(state[name], r'^[a-f0-9]{64}$')
        value = self.controller.initial_login({'instance_id': self.instance, 'module_id': 'bookstack', 'service': 'bookstack'})
        self.assertEqual(value['password'], 'Az09By18')

    def test_legacy_bootstrap_state_and_full_password_survive_initialize_and_enable(self):
        self.controller.initialize(self.instance)
        base = self.controller.paths(self.instance)
        state = self.controller.state(self.instance)
        state['admin_password'] = 'e' * 64
        bs.atomic(base / 'state.json', state)
        bs.atomic(base / 'config/admin_password', state['admin_password'].encode())
        original = {path: path.read_bytes() for path in (base / 'config').iterdir()}
        original[base / 'state.json'] = (base / 'state.json').read_bytes()
        with patch.object(bs.secrets, 'choice', side_effect=AssertionError('unexpected password rotation')), \
                patch.object(bs.secrets, 'token_hex', side_effect=AssertionError('unexpected secret rotation')):
            self.controller.initialize(self.instance)
        self.install()
        self.controller.execute(self.operation('disable'))
        self.controller.execute(self.operation('enable'))
        self.assertEqual({path: path.read_bytes() for path in original}, original)
        value = self.controller.initial_login({'instance_id': self.instance, 'module_id': 'bookstack', 'service': 'bookstack'})
        self.assertEqual(value['password'], 'e' * 64)

    def test_install_is_idempotent_and_secrets_never_enter_docker_env_or_result(self):
        body = self.operation('install')
        result = self.controller.execute(body)
        self.assertEqual(result['state'], 'running')
        self.assertEqual(self.controller.execute(body), result)
        self.assertEqual(len(self.containers), 2)
        self.assertEqual(len(self.volumes), 2)
        state = self.controller.state(self.instance)
        for name in bs.SECRET_NAMES:
            self.assertNotIn(state[name], json.dumps(result))
            self.assertNotIn(state[name], repr(self.calls))
            secret = self.controller.paths(self.instance) / 'config' / name
            self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
        self.assertEqual(result['endpoint'], 'http://pl-bookstack-' + self.instance + ':80')
        web_env, _ = self.controller.specification(self.instance, 'web')
        self.assertEqual(web_env['APP_URL'], 'https://pl.example/wiki')
        self.assertEqual(web_env['AUTH_METHOD'], 'standard')
        self.assertFalse(any('X-WEBAUTH' in str(call) for call in self.calls))

    def test_disable_enable_preserves_database_uploads_and_secret_identity(self):
        self.install()
        state, volumes = self.controller.state(self.instance), copy.deepcopy(self.volumes)
        identities = {name: obj['Id'] for name, obj in self.containers.items()}
        self.assertEqual(self.controller.execute(self.operation('disable'))['state'], 'disabled')
        self.assertEqual(self.volumes, volumes)
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'running')
        self.assertEqual(self.controller.state(self.instance), state)
        self.assertEqual({name: obj['Id'] for name, obj in self.containers.items()}, identities)

    def test_only_web_joins_ingress_database_has_no_published_port(self):
        self.install()
        database = self.controller.inspect(self.instance, 'database')
        self.assertEqual(set(database['NetworkSettings']['Networks']), {self.controller.name(self.instance, '-net')})
        self.assertEqual(database['HostConfig']['PortBindings'], {})
        self.assertEqual(set(self.controller.inspect(self.instance, 'web')['NetworkSettings']['Networks']),
                         {self.ingress, self.controller.name(self.instance, '-net')})

    def test_remove_deletes_owned_data_and_keeps_core_ingress(self):
        self.install()
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'absent')
        self.assertEqual(self.containers, {})
        self.assertEqual(self.volumes, {})
        self.assertEqual(set(self.networks), {self.ingress})
        self.assertFalse((self.controller.instances / self.instance).exists())

    def test_foreign_network_member_blocks_remove_before_any_stop_or_delete(self):
        self.install()
        self.networks[self.controller.name(self.instance, '-net')]['Containers']['f' * 64] = {'Name': 'foreign'}
        self.calls.clear()
        self.assertEqual(self.controller.execute(self.operation('remove'))['state'], 'error')
        self.assertFalse(any(call[:2] in (('container', 'stop'), ('container', 'rm'), ('volume', 'rm')) for call in self.calls))
        self.assertEqual(len(self.volumes), 2)

    def test_foreign_volume_mount_or_container_privilege_blocks_observation(self):
        self.install()
        obj = self.containers[self.controller.name(self.instance, '-web')]
        obj['Mounts'][0]['Name'] = 'foreign'
        with self.assertRaises(ValueError):
            self.controller.get(self.instance)
        obj['Mounts'][0]['Name'] = self.controller.name(self.instance, '-config-data')
        obj['HostConfig']['Privileged'] = True
        with self.assertRaises(ValueError):
            self.controller.get(self.instance)

    def test_operation_id_conflict_does_not_change_runtime(self):
        body = self.operation('install')
        self.assertEqual(self.controller.execute(body)['state'], 'running')
        self.calls.clear()
        with self.assertRaises(ValueError):
            self.controller.execute({**body, 'action': 'remove'})
        self.assertFalse(any(call[:2] in (('container', 'stop'), ('container', 'rm'), ('volume', 'rm')) for call in self.calls))

    def test_private_file_drift_is_not_overwritten_on_retry(self):
        self.install()
        path = self.controller.paths(self.instance) / 'config/app_key'
        bs.atomic(path, b'changed')
        self.assertEqual(self.controller.execute(self.operation('enable'))['state'], 'error')
        self.assertEqual(path.read_bytes(), b'changed')
        self.assertEqual(len(self.volumes), 2)

    def test_ingress_recreation_requires_explicit_recovery(self):
        self.install()
        self.networks[self.ingress]['Id'] = '7' * 64
        with self.assertRaises(ValueError):
            self.controller.get(self.instance)

    def test_readiness_checks_native_database_cache_and_session(self):
        self.install()
        for key in ('database', 'cache', 'session'):
            self.controller.http = lambda instance, obj, failed=key: {name: name != failed for name in ('database', 'cache', 'session')}
            with self.assertRaises(ValueError):
                self.controller.ready(self.instance)

    def test_created_web_without_ingress_is_reconciled_before_first_start(self):
        self.controller.initialize(self.instance)
        self.controller.create_resource(self.instance, 'network')
        for volume in ('database', 'config'):
            self.controller.create_resource(self.instance, 'volume', volume)
        for role in bs.ROLES:
            self.controller.create_container(self.instance, role)
        self.assertEqual(self.controller.execute(self.operation('install'))['state'], 'running')
        self.assertEqual(len(self.containers), 2)

    def test_interrupted_removal_reuses_journal_after_runtime_cleanup(self):
        self.install()
        body = self.operation('remove')
        original = self.controller.docker
        failed = False

        def interrupted(*args, **kwargs):
            nonlocal failed
            if args[:2] == ('volume', 'rm') and args[-1].endswith('-database-data') and not failed:
                failed = True
                raise OSError('Interrupted volume cleanup')
            return original(*args, **kwargs)

        with patch.object(self.controller, 'docker', side_effect=interrupted):
            self.assertEqual(self.controller.execute(body)['state'], 'error')
            self.assertEqual(self.containers, {})
            self.assertEqual(len(self.volumes), 1)
            self.assertTrue((self.controller.operations / ('remove-' + self.instance + '.json')).exists())
            self.assertEqual(self.controller.execute(body)['state'], 'absent')
        self.assertEqual(set(self.networks), {self.ingress})

    def test_invalid_origin_and_image_bundle_are_rejected(self):
        for origin in ('https://user:pass@pl.example', 'https://pl.example/wiki', 'https://pl.example?x=1', 'https://pl.example\n'):
            with self.assertRaises(ValueError):
                bs.public_origin(origin)
        broken = copy.deepcopy(self.images)
        broken['database']['architecture'] = 'arm64'
        bs.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation,
                  'manifest_sha256': 'a' * 64, 'bookstack': broken})
        with self.assertRaises(ValueError):
            self.controller.resolve_images()


if __name__ == '__main__':
    unittest.main()
