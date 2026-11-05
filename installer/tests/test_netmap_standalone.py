"""Standalone module boundaries. Run in CI; these tests never contact Docker or a device."""
import base64
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import stat
import subprocess
import tarfile
import tempfile
import types
import unittest
import urllib.error
import uuid
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


standalone = load('netmap_standalone_tests', ROOT / 'installer/netmap-standalone.py')
packager = load('netmap_standalone_package_tests', ROOT / 'installer/netmap-standalone-package.py')
gateway = load('netmap_standalone_gateway_tests', ROOT / 'apps/netmap-stack/gateway.py')


def image_fixture():
    configs = {role: json.dumps({'role': role}).encode() for role in standalone.nm.ROLES}
    images = {}
    upstream = {'database': '18.6', 'cache': '9.1', 'netbox': '4.7.4', 'netbox-worker': '4.7.4',
                'gitea': '28.2.0', 'oxidized': '0.37.0'}
    for role, raw in configs.items():
        labels = {'pl.module.id': 'netmap', 'pl.module.role': role, 'pl.module.config.version': '1',
                  'org.opencontainers.image.version': '1.0.0', 'pl.source.sha256': 'a' * 64,
                  'pl.build.variant': 'source-build' if role == 'adapter' else 'upstream-pinned'}
        if role in upstream:
            labels['pl.upstream.version'] = upstream[role]
        images[role] = {'id': 'sha256:' + hashlib.sha256(raw).hexdigest(), 'architecture': 'amd64',
                        'ref': 'pl/core-netmap-' + role + ':1.0.0', 'recipe': 'deploy/images/netmap.Dockerfile', 'labels': labels}
    return images, configs


def docker_archive(path, configs, extra=False):
    with tarfile.open(path, 'w') as archive:
        entries = []
        for role, raw in configs.items():
            name = hashlib.sha256(raw).hexdigest() + '.json'
            packager.add(archive, name, raw)
            entries.append({'Config': name, 'RepoTags': [], 'Layers': []})
        if extra:
            packager.add(archive, 'core.json', b'core')
            entries.append({'Config': 'core.json', 'RepoTags': [], 'Layers': []})
        packager.add(archive, 'manifest.json', json.dumps(entries).encode())


def oci_fixture(images):
    """Real save shape: direct OCI manifests + Docker rows, gzip blob paths."""
    images, members, rows, descriptors, config_ids = copy.deepcopy(images), {}, [], [], {}

    def encoded(value):
        return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

    def put(raw, media_type):
        identity = 'sha256:' + hashlib.sha256(raw).hexdigest()
        members['blobs/sha256/' + identity[7:]] = raw
        return {'mediaType': media_type, 'digest': identity, 'size': len(raw)}

    def layer(name):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w') as archive:
            packager.add(archive, 'owned.txt', name.encode())
        data = raw.getvalue()
        descriptor = put(gzip.compress(data, mtime=0), 'application/vnd.oci.image.layer.v1.tar+gzip')
        return descriptor, 'sha256:' + hashlib.sha256(data).hexdigest()

    shared, shared_diff = layer('shared-owned-layer')
    for role, image in images.items():
        unique, unique_diff = layer(role)
        config = put(encoded({'architecture': image['architecture'], 'os': 'linux',
                              'config': {'Labels': image['labels']},
                              'rootfs': {'type': 'layers', 'diff_ids': [shared_diff, unique_diff]}}),
                     'application/vnd.oci.image.config.v1+json')
        descriptor = put(encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                                  'config': config, 'layers': [shared, unique]}),
                         'application/vnd.oci.image.manifest.v1+json')
        image['id'] = descriptor['digest']
        config_ids[role] = config['digest']
        descriptors.append(descriptor)
        rows.append({'Config': 'blobs/sha256/' + config['digest'][7:],
                     'Layers': ['blobs/sha256/' + item['digest'][7:] for item in [shared, unique]],
                     'RepoTags': None, 'LayerSources': None})
    return images, members, rows, {'schemaVersion': 2, 'manifests': descriptors}, config_ids


def oci_archive(path, members, rows, index):
    with tarfile.open(path, 'w') as archive:
        for name, raw in members.items():
            packager.add(archive, name, raw)
        packager.add(archive, 'oci-layout', b'{"imageLayoutVersion":"1.0.0"}')
        packager.add(archive, 'index.json', json.dumps(index).encode())
        packager.add(archive, 'manifest.json', json.dumps(rows).encode())


class StandaloneContracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.images, self.configs = image_fixture()
        self.manifest = {'schema': 1, 'product': 'PL NetMap Standalone', 'version': '1.0.0',
                         'architecture': 'amd64', 'canonical_sha256': 'b' * 64, 'source_sha256': 'a' * 64,
                         'images': self.images, 'files': {name: 'c' * 64 for name in standalone.PACKAGE_FILES}}
        self.settings = {'schema': 1, 'owner': '0123456789abcdef', 'instance_id': str(uuid.uuid4()),
                         'package_sha256': 'd' * 64, 'platform_origin': 'https://pl.example.test',
                         'endpoint': 'https://netmap.example.test', 'subnet': '172.30.240.0/28',
                         'adapter_port': 18092, 'ca_file': '', 'ca_sha256': ''}
        self.docker = Mock()
        self.controller = standalone.Standalone(self.root, self.manifest, 'd' * 64, self.settings, docker=self.docker)
        self.instance = self.controller.instance

    def oci_controller(self, docker=None):
        images, _, _, _, config_ids = oci_fixture(self.images)
        for role, image in images.items():
            image['config_id'] = config_ids[role]
        manifest = {**copy.deepcopy(self.manifest), 'images': images}
        controller = standalone.Standalone(self.root, manifest, 'd' * 64, self.settings, docker=docker or self.docker)
        return controller, manifest, config_ids

    @staticmethod
    def inspected_image(images, role, identity):
        return {'Id': identity, 'Os': 'linux', 'Architecture': images[role]['architecture'],
                'Config': {'Labels': copy.deepcopy(images[role]['labels'])}}

    def test_bootstrap_repeat_preserves_secrets_and_has_no_platform_state(self):
        self.controller.initialize(self.instance)
        first = self.controller.state(self.instance)
        key = standalone.nm.read_file(self.controller.paths(self.instance) / 'config/gateway_key', mode=0o444)
        self.controller.initialize(self.instance)
        self.assertEqual(first, self.controller.state(self.instance))
        self.assertEqual(len(key), 32)
        self.assertEqual(len(first['secrets']['admin_password']), 8)
        # A completed legacy seed had only origin. A new runner may expose a
        # descriptor, but must not rewrite that private seed or rotate its key.
        adapter_path = self.controller.paths(self.instance) / 'config/adapter.json'
        adapter = json.loads(adapter_path.read_bytes())
        adapter.pop('platform_origin')
        legacy = standalone.nm.encoded(adapter)
        standalone.nm.atomic(adapter_path, legacy, mode=0o444)
        first['files']['adapter.json'] = hashlib.sha256(legacy).hexdigest()
        standalone.nm.atomic(self.controller.paths(self.instance) / 'state.json', first)
        self.controller.initialize(self.instance)
        self.assertEqual(adapter_path.read_bytes(), legacy)
        self.assertEqual(standalone.nm.read_file(self.controller.paths(self.instance) / 'config/gateway_key', mode=0o444), key)
        self.assertFalse((self.root / 'state/installation.json').exists())
        self.assertFalse((self.root / 'private/module-controller-key').exists())
        self.docker.assert_not_called()
        second_root = self.root / 'other'
        second_root.mkdir(mode=0o700)
        other_settings = {**self.settings, 'owner': 'f' * 16, 'instance_id': str(uuid.uuid4())}
        other = standalone.Standalone(second_root, self.manifest, 'd' * 64, other_settings, docker=Mock())
        other.initialize(other.instance)
        other_key = standalone.nm.read_file(other.paths(other.instance) / 'config/gateway_key', mode=0o444)
        self.assertNotEqual(key, other_key)

    def test_native_origins_use_platform_origin_and_explicit_subpaths(self):
        self.controller.initialize(self.instance)
        config = self.controller.paths(self.instance) / 'config'
        netbox = json.loads((config / 'netbox.json').read_bytes())
        adapter = json.loads((config / 'adapter.json').read_bytes())
        self.assertEqual(netbox['origin'], self.settings['platform_origin'])
        self.assertEqual(netbox['hostname'], 'pl.example.test')
        self.assertEqual(adapter['hostname'], 'pl.example.test')
        ini = (config / 'gitea.ini').read_text()
        self.assertIn('ROOT_URL = https://pl.example.test/netmap/gitea/\n', ini)
        self.assertNotIn(self.settings['endpoint'], ini)

    def test_configuration_drift_rejects_mutation_before_docker(self):
        self.controller.initialize(self.instance)
        path = self.controller.paths(self.instance) / 'config/gateway_key'
        path.chmod(0o644)
        path.write_bytes(b'x' * 32)
        path.chmod(0o444)
        with self.assertRaises(ValueError):
            self.controller.stop()
        self.docker.assert_not_called()

    def test_only_adapter_publishes_loopback_and_no_ingress_is_connected(self):
        self.controller.initialize(self.instance)
        with patch.object(self.controller, 'verify_image'), patch.object(self.controller, 'inspect', return_value={'Id': 'a' * 64}):
            for role in standalone.nm.ROLES:
                self.controller.create_container(self.instance, role)
        calls = [call.args for call in self.docker.call_args_list]
        self.assertEqual(len(calls), 7)
        for call in calls:
            self.assertEqual(call[:2], ('container', 'create'))
            if call[-1] == self.images['adapter']['id']:
                self.assertIn('127.0.0.1:18092:8092/tcp', call)
                self.assertEqual(call.count('--publish'), 1)
            else:
                self.assertNotIn('--publish', call)
            self.assertNotIn('--privileged', call)
            self.assertNotIn('--network=host', call)
            self.assertFalse(any('docker.sock' in value or '_ingress' in value for value in call))

    def container_fixture(self, role='adapter'):
        self.controller.initialize(self.instance)
        environment, mounts, user, tmpfs = self.controller.specification(self.instance, role)
        image = {'Config': {'Env': [], 'Entrypoint': ['native-entrypoint'], 'Cmd': [], 'WorkingDir': '/data'}}
        bindings = {'8092/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18092'}]} if role == 'adapter' else {}
        obj = {'Id': '1' * 64, 'Name': '/' + self.controller.name(self.instance, '-' + role), 'Image': self.images[role]['id'],
               'Config': {**image['Config'], 'Image': self.images[role]['id'], 'User': user,
                          'Env': [key + '=' + value for key, value in environment.items()],
                          'Labels': {**self.images[role]['labels'], **self.controller.labels(self.instance, role)}},
               'Mounts': [{'Type': kind, 'Name' if kind == 'volume' else 'Source': source,
                           'Destination': target, 'RW': writable} for kind, source, target, writable in mounts],
               'State': {'Running': True, 'Status': 'running'},
               'HostConfig': {'PortBindings': bindings, 'ReadonlyRootfs': True, 'Privileged': False, 'CapDrop': ['ALL'],
                              'NetworkMode': self.controller.name(self.instance, '-net'), 'Memory': standalone.nm.MEMORY[role] * 1024**2,
                              'NanoCpus': 1_000_000_000, 'PidsLimit': 256, 'Init': True, 'Tmpfs': tmpfs,
                              'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '2'}},
                              'RestartPolicy': {'Name': 'unless-stopped'}, 'IpcMode': 'private', 'SecurityOpt': ['no-new-privileges']},
               'NetworkSettings': {'Ports': bindings, 'Networks': {self.controller.name(self.instance, '-net'):
                                   {'NetworkID': '2' * 64, 'Aliases': [role], 'IPAddress': '172.30.240.2'}}}}
        return image, obj

    def test_inspection_rejects_public_listener_mount_label_image_and_extra_network(self):
        image, valid = self.container_fixture()
        changes = [lambda obj: obj['HostConfig']['PortBindings']['8092/tcp'][0].update(HostIp='0.0.0.0'),
                   lambda obj: obj['Mounts'][0].update(Name='foreign-volume'),
                   lambda obj: obj['Config']['Labels'].update({'netmap.owner': 'foreign'}),
                   lambda obj: obj.update(Image='sha256:' + 'f' * 64),
                   lambda obj: obj['NetworkSettings']['Networks'].update({'foreign-network': {}})]
        with patch.object(self.controller, 'verify_image', return_value=image), \
                patch.object(self.controller, 'resource', return_value={'Id': '2' * 64}):
            self.docker.side_effect = lambda *args, **kwargs: b'id\n' if args[1] == 'ls' else json.dumps([valid]).encode()
            self.assertEqual(self.controller.inspect(self.instance, 'adapter')['Id'], valid['Id'])
            for change in changes:
                invalid = copy.deepcopy(valid)
                change(invalid)
                self.docker.side_effect = lambda *args, **kwargs: b'id\n' if args[1] == 'ls' else json.dumps([invalid]).encode()
                with self.assertRaisesRegex(ValueError, 'Standalone container ownership or specification drift'):
                    self.controller.inspect(self.instance, 'adapter')

    def test_network_preflight_rejects_host_route_and_docker_overlap(self):
        self.docker.return_value = b''
        with patch.object(standalone.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'[{"dst":"172.30.240.0/24"}]')):
            with self.assertRaisesRegex(ValueError, 'overlaps a host route or Docker network'):
                self.controller.preflight_network()
        self.docker.side_effect = lambda *args: b'1' * 64 if args[1] == 'ls' else json.dumps(
            [{'Id': '1' * 64, 'IPAM': {'Config': [{'Subnet': '172.30.0.0/16'}]}}]).encode()
        with patch.object(standalone.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'[]')):
            with self.assertRaisesRegex(ValueError, 'overlaps a host route or Docker network'):
                self.controller.preflight_network()
        self.assertFalse(any(call.args[1] in ('create', 'connect', 'rm') for call in self.docker.call_args_list))

    def test_stop_preflights_all_ownership_before_first_mutation(self):
        self.controller.initialize(self.instance)
        with patch.object(self.controller, 'inspect', return_value={'Id': '1' * 64, 'State': {'Running': True}}), \
                patch.object(self.controller, 'resource', side_effect=ValueError('Foreign volume')):
            with self.assertRaises(ValueError):
                self.controller.stop(remove_deployment=True)
        self.docker.assert_not_called()

    def test_absent_observation_supports_interrupted_purge_retry(self):
        with patch.object(self.controller, 'inspect', return_value=None), patch.object(self.controller, 'resource', return_value=None):
            self.assertEqual(self.controller.observe(self.instance)['state'], 'absent')
            self.controller.remove(self.instance)
        self.docker.assert_not_called()

    def test_deployment_removal_retains_data_and_bootstrap(self):
        self.controller.initialize(self.instance)
        initial = self.controller.state(self.instance)
        objects = {role: {'Id': hashlib.sha256(role.encode()).hexdigest(), 'State': {'Running': True}}
                   for role in standalone.nm.ROLES}
        network = [True]

        def docker(*args, **kwargs):
            if args[:2] == ('container', 'rm'):
                for role in list(objects):
                    if objects[role]['Id'] == args[2]:
                        del objects[role]
            if args[:2] == ('network', 'rm'):
                network[0] = False
            return b''

        self.docker.side_effect = docker
        with patch.object(self.controller, 'inspect', side_effect=lambda instance, role: objects.get(role)), \
                patch.object(self.controller, 'resource', side_effect=lambda instance, kind, volume='database':
                             {'Id': '2' * 64} if kind == 'volume' or network[0] else None):
            self.controller.stop(remove_deployment=True)
        self.assertFalse(objects)
        self.assertFalse(network[0])
        self.assertEqual(initial, self.controller.state(self.instance))
        self.assertFalse(any(call.args[:2] == ('volume', 'rm') or '--force' in call.args for call in self.docker.call_args_list))
        with patch.object(self.controller, 'inspect', return_value=None), \
                patch.object(self.controller, 'resource', side_effect=lambda instance, kind, volume='database':
                             {'Name': volume} if kind == 'volume' else None):
            self.assertEqual(self.controller.observe(self.instance)['state'], 'deployment_removed')

    def test_handoff_is_private_and_excludes_collector_api_tokens(self):
        self.controller.initialize(self.instance)
        with patch.object(self.controller, 'resource', return_value={'Mountpoint': '/owned/gitea'}), \
                patch.object(self.controller, 'gitea_initial_password', return_value='Ab12Cd34'):
            self.controller.private_handoff()
        connection = json.loads((self.root / 'connection.json').read_bytes())
        key = standalone.nm.read_file(self.controller.paths(self.instance) / 'config/gateway_key', mode=0o444)
        self.assertEqual(bytes.fromhex(connection['gateway_key_hex']), key)
        logins = json.loads((self.root / 'initial-logins.json').read_bytes())
        self.assertEqual(logins['gitea']['password'], 'Ab12Cd34')
        for name in ('connection.json', 'initial-logins.json'):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o600)
        raw = (self.root / 'initial-logins.json').read_text()
        for key in ('token', 'token_key', 'source_password'):
            self.assertNotIn(self.controller.state(self.instance)['secrets'][key], raw)

    def test_tls_probe_uses_actual_v2_verifier_and_blocks_internal_routes(self):
        self.controller.initialize(self.instance)
        requests = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self, size):
                return b'{"status":"ok","sources_ok":1,"sources_total":1}'

        def open_request(request, timeout):
            requests.append(request)
            if isinstance(request, str):
                raise urllib.error.HTTPError(request, 404, '', {}, None)
            key = standalone.nm.read_file(self.controller.paths(self.instance) / 'config/gateway_key', mode=0o444)
            scope = {'method': 'GET', 'raw_path': b'/netmap/api/health', 'query_string': b'',
                     'headers': [(name.lower().encode(), value.encode()) for name, value in request.header_items()]}
            claims = gateway.GatewayVerifier(key).verify(scope, b'')
            self.assertFalse(claims['admin'])
            self.assertEqual(claims['scopes'], ['netmap:read'])
            self.assertTrue(request.full_url.startswith(self.settings['endpoint'] + '/netmap/'))
            return Response()

        contexts = []
        original_context = ssl.create_default_context

        def context(**kwargs):
            value = original_context(**kwargs)
            contexts.append(value)
            return value

        with patch.object(standalone.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_request)), \
                patch.object(standalone.ssl, 'create_default_context', side_effect=context):
            self.controller.tls_check()
        self.assertEqual(len(requests), 3)
        self.assertTrue(contexts[0].check_hostname)
        self.assertEqual(contexts[0].verify_mode, ssl.CERT_REQUIRED)

    def test_certificate_error_has_no_http_or_unverified_fallback(self):
        self.controller.initialize(self.instance)
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError(ssl.SSLCertVerificationError('wrong hostname'))
        with patch.object(standalone.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaises(ValueError):
                self.controller.tls_check()
        self.assertEqual(opener.open.call_count, 1)

    def test_archive_rejects_unadvertised_core_image(self):
        path = self.root / 'images.tar'
        docker_archive(path, self.configs)
        self.assertEqual(standalone.validate_image_archive(path, self.images),
                         {role: image['id'] for role, image in self.images.items()})
        docker_archive(path, self.configs, extra=True)
        with self.assertRaises(ValueError):
            standalone.validate_image_archive(path, self.images)

    def test_oci_archive_proves_exact_platform_manifest_ids_config_and_ordered_gzip_layers(self):
        images, members, rows, index, config_ids = oci_fixture(self.images)
        path = self.root / 'oci-images.tar'
        rows.reverse()  # containerd emits compatibility rows independently of OCI descriptor order.
        oci_archive(path, members, rows, index)
        self.assertTrue(all(images[role]['id'] != config_ids[role] for role in images))
        self.assertEqual(standalone.validate_image_archive(path, images), config_ids)
        for role, image in images.items():
            image['config_id'] = config_ids[role]
        self.assertEqual(standalone.validate_image_archive(path, images), config_ids)
        images['adapter']['config_id'] = 'sha256:' + 'f' * 64
        with self.assertRaisesRegex(ValueError, 'config identity binding mismatch'):
            standalone.validate_image_archive(path, images)

    def test_oci_archive_rejects_tampered_missing_extra_or_rebound_content(self):
        def tamper_manifest(images, members, rows, index):
            name = 'blobs/sha256/' + images['adapter']['id'][7:]
            members[name] = members[name][:-1] + b' '

        def tamper_layer(images, members, rows, index):
            name = rows[0]['Layers'][0]
            members[name] = b'!' + members[name][1:]

        def swap_configs(images, members, rows, index):
            rows[0]['Config'], rows[1]['Config'] = rows[1]['Config'], rows[0]['Config']

        def descriptor_size(images, members, rows, index):
            index['manifests'][0]['size'] += 1

        def unadvertised_index_manifest(images, members, rows, index):
            index['manifests'][0]['digest'] = 'sha256:' + 'f' * 64

        def index_as_identity(images, members, rows, index):
            images['adapter']['id'] = 'sha256:' + hashlib.sha256(json.dumps(index).encode()).hexdigest()

        changes = {
            'manifest hash': tamper_manifest, 'layer hash': tamper_layer,
            'config size': lambda images, members, rows, index: members.__setitem__(rows[0]['Config'], members[rows[0]['Config']] + b' '),
            'missing layer': lambda images, members, rows, index: members.pop(rows[0]['Layers'][0]),
            'missing config': lambda images, members, rows, index: members.pop(rows[0]['Config']),
            'descriptor size': descriptor_size, 'different manifest': unadvertised_index_manifest,
            'rebound configs': swap_configs,
            'reordered layers': lambda images, members, rows, index: rows[0]['Layers'].reverse(),
            'alternate layer sources': lambda images, members, rows, index: rows[0].update(LayerSources={'foreign': {}}),
            'foreign parent': lambda images, members, rows, index: rows[0].update(Parent='sha256:' + 'f' * 64),
            'orphan blob': lambda images, members, rows, index: members.update({'blobs/sha256/' + hashlib.sha256(b'core').hexdigest(): b'core'}),
            'eighth Docker row': lambda images, members, rows, index: rows.append(copy.deepcopy(rows[0])),
            'eighth OCI image': lambda images, members, rows, index: index['manifests'].append({'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'digest': 'sha256:' + 'f' * 64, 'size': 1}),
            'index digest as wanted ID': index_as_identity,
            'nested index as image': lambda images, members, rows, index: index['manifests'][0].update(mediaType='application/vnd.oci.image.index.v1+json'),
            'wrong platform': lambda images, members, rows, index: index['manifests'][0].update(platform={'architecture': 'arm64', 'os': 'linux'}),
            'ambiguous Docker row': lambda images, members, rows, index: rows[0].update(config=rows[1]['Config']),
        }
        for name, change in changes.items():
            with self.subTest(name=name):
                images, members, rows, index, _ = oci_fixture(self.images)
                change(images, members, rows, index)
                path = self.root / 'invalid-oci.tar'
                oci_archive(path, members, rows, index)
                with self.assertRaises(ValueError):
                    standalone.validate_image_archive(path, images)

    def test_runtime_missing_canonical_selects_only_verified_config_and_preserves_manifest(self):
        controller, manifest, config_ids = self.oci_controller()
        original = copy.deepcopy(manifest)
        role = 'adapter'

        def docker(*args):
            self.assertEqual(args[:2], ('image', 'inspect'))
            if args[2] == manifest['images'][role]['id']:
                raise standalone.ImageNotFound('Pinned standalone Docker image is absent')
            self.assertEqual(args[2], config_ids[role])
            return json.dumps([self.inspected_image(manifest['images'], role, config_ids[role])]).encode()

        self.docker.side_effect = docker
        controller.verify_image(role)
        self.assertEqual(controller.images[role]['id'], config_ids[role])
        self.assertEqual(manifest, original)
        self.assertEqual(len(self.docker.call_args_list), 2)
        # Reconstructing the runner needs no schema/state migration or tar scan.
        repeated = standalone.Standalone(self.root, manifest, 'd' * 64, self.settings, docker=self.docker)
        repeated.verify_image(role)
        self.assertEqual(repeated.images[role]['id'], config_ids[role])
        self.assertEqual(manifest, original)

    def test_runtime_alias_lookup_may_return_either_of_the_two_bound_ids(self):
        for missing_canonical in (False, True):
            with self.subTest(missing_canonical=missing_canonical):
                docker = Mock()
                controller, manifest, config_ids = self.oci_controller(docker)
                canonical = manifest['images']['adapter']['id']
                actual = canonical if missing_canonical else config_ids['adapter']

                def inspect(*args):
                    if missing_canonical and args[2] == canonical:
                        raise standalone.ImageNotFound('Pinned standalone Docker image is absent')
                    return json.dumps([self.inspected_image(manifest['images'], 'adapter', actual)]).encode()

                docker.side_effect = inspect
                controller.verify_image('adapter')
                self.assertEqual(controller.images['adapter']['id'], actual)
                self.assertEqual(docker.call_count, 2 if missing_canonical else 1)

    def test_runtime_found_bad_image_or_daemon_failure_never_falls_back(self):
        for change in (lambda image: image.update(Id='sha256:' + 'f' * 64),
                       lambda image: image.update(Os='windows'), lambda image: image.update(Architecture='arm64'),
                       lambda image: image['Config']['Labels'].pop('pl.source.sha256'),
                       lambda image: image['Config']['Labels'].update({'pl.module.role': 'core-api'}),
                       lambda image: image.update(Config=None)):
            docker = Mock()
            controller, manifest, config_ids = self.oci_controller(docker)
            image = self.inspected_image(manifest['images'], 'adapter', config_ids['adapter'])
            change(image)
            docker.return_value = json.dumps([image]).encode()
            with self.assertRaises(ValueError):
                controller.verify_image('adapter')
            self.assertEqual(docker.call_count, 1)
        docker = Mock(side_effect=ValueError('Local Docker operation failed'))
        controller, _, _ = self.oci_controller(docker)
        with self.assertRaises(ValueError):
            controller.verify_image('adapter')
        self.assertEqual(docker.call_count, 1)

    def test_runtime_legacy_package_has_one_exact_id_and_no_fallback(self):
        self.docker.return_value = json.dumps([self.inspected_image(self.images, 'adapter', self.images['adapter']['id'])]).encode()
        self.controller.verify_image('adapter')
        self.assertEqual(self.docker.call_count, 1)
        self.docker.reset_mock(side_effect=True)
        self.docker.side_effect = standalone.ImageNotFound('Pinned standalone Docker image is absent')
        with self.assertRaises(standalone.ImageNotFound):
            self.controller.verify_image('adapter')
        self.assertEqual(self.docker.call_count, 1)

    def test_docker_inspect_fallback_classifies_only_an_exact_missing_image_error(self):
        identity = 'sha256:' + 'a' * 64
        missing = b'Error response from daemon: No such image: ' + identity.encode()
        for stderr in (missing, b'Error: No such image: ' + identity.encode()):
            with patch.object(standalone.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'[]\n', stderr)):
                with self.assertRaises(standalone.ImageNotFound):
                    standalone.docker_at(self.root)('image', 'inspect', identity)
        for stdout, stderr in ((b'[]', b'permission denied'), (b'[]', b'Cannot connect to Docker daemon'),
                               (b'[{}]', missing), (b'[]', missing + b'\nunrelated error')):
            with patch.object(standalone.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, stdout, stderr)):
                with self.assertRaises(ValueError) as caught:
                    standalone.docker_at(self.root)('image', 'inspect', identity)
                self.assertNotIsInstance(caught.exception, standalone.ImageNotFound)

    def test_classic_runtime_container_ownership_stays_bound_to_the_selected_exact_id(self):
        self.controller, self.manifest, config_ids = self.oci_controller()
        self.images = self.manifest['images']
        canonical = self.images['adapter']['id']
        selected = config_ids['adapter']
        image, valid = self.container_fixture()
        valid['Image'] = valid['Config']['Image'] = selected
        image = {**self.inspected_image(self.images, 'adapter', selected),
                 'Config': {**image['Config'], 'Labels': self.images['adapter']['labels']}}
        current = [valid]

        def docker(*args, **kwargs):
            if args[:2] == ('image', 'inspect'):
                if args[2] == canonical:
                    raise standalone.ImageNotFound('Pinned standalone Docker image is absent')
                self.assertEqual(args[2], selected)
                return json.dumps([image]).encode()
            if args[:2] == ('container', 'ls'):
                return b'id\n'
            self.assertEqual(args[:2], ('container', 'inspect'))
            return json.dumps(current).encode()

        self.docker.side_effect = docker
        with patch.object(self.controller, 'resource', return_value={'Id': '2' * 64}):
            self.assertEqual(self.controller.inspect(self.instance, 'adapter')['Image'], selected)
            for mutate in (lambda obj: obj.update(Image=canonical),
                           lambda obj: obj['Config'].update(Image=canonical),
                           lambda obj: obj['Config']['Labels'].update({'netmap.owner': 'foreign'})):
                invalid = copy.deepcopy(valid)
                mutate(invalid)
                current[:] = [invalid]
                with self.assertRaisesRegex(ValueError, 'Standalone container ownership or specification drift'):
                    self.controller.inspect(self.instance, 'adapter')
        self.assertEqual(self.manifest['images']['adapter']['id'], canonical)
        self.assertFalse(any(call.args[1] in ('create', 'start', 'stop', 'rm') for call in self.docker.call_args_list))

    def test_explicit_origins_and_network_are_finite(self):
        self.assertEqual(standalone.origin('https://PL.example.test:443/'), 'https://pl.example.test')
        self.assertEqual(standalone.origin('https://[2001:db8::1]:8443'), 'https://[2001:db8::1]:8443')
        for value in ('http://netmap.test', 'https://user:pass@netmap.test', 'https://netmap.test/netmap/',
                      'https://netmap.test:', 'https://netmap.test:0', 'https://netmap.test/?key=x'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                standalone.origin(value)
        for value in ('0.0.0.0/0', '172.30.240.1/28', '192.0.2.0/28', '172.30.240.0/24'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                standalone.subnet(value)

    def test_repeat_refuses_new_origin_or_manifest(self):
        standalone.nm.atomic(self.root / 'deployment.json', self.settings)
        args = types.SimpleNamespace(action='install', platform_origin=None, endpoint='https://other.example.test',
                                     subnet=None, adapter_port=None, ca_file=None)
        with self.assertRaises(ValueError):
            standalone.settings_for(args, self.root, 'd' * 64)
        args.endpoint = None
        with self.assertRaises(ValueError):
            standalone.settings_for(args, self.root, 'e' * 64)

    def test_manifest_rejects_shared_ids_wrong_role_or_missing_source_binding(self):
        standalone.validate_manifest(self.manifest)
        for mutate in (lambda value: value['images']['cache'].update(id=value['images']['database']['id']),
                       lambda value: value['images']['adapter']['labels'].update({'pl.module.role': 'core-api'}),
                       lambda value: value['images']['adapter']['labels'].pop('pl.source.sha256'),
                       lambda value: value['images']['adapter'].update(config_id='not-a-digest')):
            value = copy.deepcopy(self.manifest)
            mutate(value)
            with self.assertRaises(ValueError):
                standalone.validate_manifest(value)


class StandalonePackaging(unittest.TestCase):
    def test_packager_selects_only_netmap_and_does_not_run_or_load_core(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            images, configs = image_fixture()
            helpers = {name: (ROOT / 'installer' / name).read_bytes()
                       for name in ('netmap-controller.py', 'xray-controller.py', 'LICENSES.txt')}
            # Packaging has its own complete input tree. The unit suite must not
            # depend on product docs being exported into an unrelated CI stage.
            source = root / 'source'
            readme = b'# Standalone packaging documentation fixture\n'
            inputs = {**{'installer/' + name: raw for name, raw in helpers.items()},
                      'installer/netmap-standalone.py': (ROOT / 'installer/netmap-standalone.py').read_bytes(),
                      'installer/netmap-standalone/nginx.conf.example':
                          (ROOT / 'installer/netmap-standalone/nginx.conf.example').read_bytes(),
                      'docs/product/netmap-standalone.md': readme}
            for name, raw in inputs.items():
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
            canonical = {'schema': 2, 'product': 'Pl', 'version': '1.0.0', 'architecture': 'amd64',
                         'source_sha256': 'a' * 64, 'features': {'netmap_module': True},
                         'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in helpers.items()},
                         'images': {**{'netmap-' + role: image for role, image in images.items()},
                                    'api': {'id': 'sha256:' + 'f' * 64}, 'db': {'id': 'sha256:' + 'e' * 64}}}
            bundle = root / 'canonical.tar.gz'
            with tarfile.open(bundle, 'w:gz') as archive:
                packager.add(archive, 'manifest.json', json.dumps(canonical).encode())
                for name, raw in helpers.items():
                    packager.add(archive, name, raw)
            calls = []

            def run(command, **kwargs):
                calls.append(command)
                self.assertEqual(kwargs['cwd'], source)
                action = command[3:5]
                if action == ['image', 'inspect']:
                    contract = next(image for image in images.values() if image['id'] == command[5])
                    value = [{'Id': contract['id'], 'Architecture': 'amd64', 'Os': 'linux', 'Config': {'Labels': contract['labels']}}]
                    return subprocess.CompletedProcess(command, 0, json.dumps(value).encode())
                self.assertEqual(action, ['image', 'save'])
                self.assertEqual(set(command[7:]), {image['id'] for image in images.values()})
                docker_archive(Path(command[6]), configs)
                return subprocess.CompletedProcess(command, 0, b'')

            args = types.SimpleNamespace(canonical_bundle=bundle, canonical_sha256=standalone.digest(bundle),
                                         output=root / 'standalone.tar.gz')
            with patch.object(packager, 'ROOT', source), patch.object(packager.sys, 'platform', 'linux'), \
                    patch.object(packager.subprocess, 'run', side_effect=run), \
                    patch('sys.stdout', new_callable=io.StringIO):
                packager.package(args)
            with tarfile.open(args.output) as archive:
                self.assertEqual(set(archive.getnames()), standalone.PACKAGE_FILES | {'manifest.json'})
                manifest = json.load(archive.extractfile('manifest.json'))
                self.assertEqual(set(manifest['images']), set(standalone.nm.ROLES))
                self.assertEqual(manifest['canonical_sha256'], args.canonical_sha256)
                self.assertTrue(all('config_id' not in image for image in manifest['images'].values()))
                self.assertEqual(archive.extractfile('README.ru.md').read(), readme)
            self.assertEqual(len(calls), 8)
            self.assertTrue(all(command[1:3] == ['--host', 'unix:///var/run/docker.sock'] for command in calls))
            self.assertFalse(any('run' in command or 'load' in command or 'pull' in command for command in calls))
            self.assertEqual(args.output.with_suffix('.gz.sha256').read_text().split()[0], standalone.digest(args.output))
            # A real missing mandatory document must still fail before touching
            # Docker; the packager must never substitute a placeholder runbook.
            (source / 'docs/product/netmap-standalone.md').unlink()
            missing = types.SimpleNamespace(canonical_bundle=bundle, canonical_sha256=args.canonical_sha256,
                                            output=root / 'missing-doc.tar.gz')
            with patch.object(packager, 'ROOT', source), patch.object(packager.sys, 'platform', 'linux'), \
                    patch.object(packager.subprocess, 'run') as docker:
                with self.assertRaises(FileNotFoundError):
                    packager.package(missing)
                docker.assert_not_called()
            self.assertFalse(missing.output.exists())

    def test_oci_packager_adds_only_archive_bound_config_ids_without_mutating_canonical(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            images, members, rows, index, config_ids = oci_fixture(image_fixture()[0])
            helpers = {name: (ROOT / 'installer' / name).read_bytes()
                       for name in ('netmap-controller.py', 'xray-controller.py', 'LICENSES.txt')}
            canonical = {'schema': 2, 'product': 'Pl', 'version': '1.0.0', 'architecture': 'amd64',
                         'source_sha256': 'a' * 64, 'images': {'netmap-' + role: image for role, image in images.items()}}
            original = copy.deepcopy(canonical)
            source = root / 'source'
            inputs = {**{'installer/' + name: raw for name, raw in helpers.items()},
                      'installer/netmap-standalone.py': (ROOT / 'installer/netmap-standalone.py').read_bytes(),
                      'installer/netmap-standalone/nginx.conf.example':
                          (ROOT / 'installer/netmap-standalone/nginx.conf.example').read_bytes(),
                      'docs/product/netmap-standalone.md': b'# Owned OCI packaging fixture\n'}
            for name, raw in inputs.items():
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
            calls = []

            def docker(command, **kwargs):
                calls.append(command)
                if command[3:5] == ['image', 'inspect']:
                    role = next(role for role, image in images.items() if image['id'] == command[5])
                    value = StandaloneContracts.inspected_image(images, role, images[role]['id'])
                    return subprocess.CompletedProcess(command, 0, json.dumps([value]).encode())
                self.assertEqual(command[3:5], ['image', 'save'])
                self.assertEqual(set(command[7:]), {image['id'] for image in images.values()})
                oci_archive(Path(command[6]), members, rows, index)
                return subprocess.CompletedProcess(command, 0, b'')

            args = types.SimpleNamespace(canonical_bundle=root / 'canonical', canonical_sha256='b' * 64,
                                         output=root / 'standalone.tar.gz')
            with patch.object(packager, 'ROOT', source), patch.object(packager.sys, 'platform', 'linux'), \
                    patch.object(packager, 'canonical_inputs', return_value=(canonical, helpers)), \
                    patch.object(packager.subprocess, 'run', side_effect=docker), patch('sys.stdout', new_callable=io.StringIO):
                packager.package(args)
            with tarfile.open(args.output) as archive:
                manifest = json.load(archive.extractfile('manifest.json'))
                self.assertEqual(manifest['schema'], 1)
                self.assertEqual(set(manifest['images']), set(standalone.nm.ROLES))
                for role, image in manifest['images'].items():
                    self.assertEqual(image['id'], images[role]['id'])
                    self.assertEqual(image['config_id'], config_ids[role])
                exported = root / 'exported-images.tar'
                exported.write_bytes(archive.extractfile('images.tar').read())
            self.assertEqual(standalone.validate_image_archive(exported, manifest['images']), config_ids)
            self.assertEqual(canonical, original)
            self.assertEqual(len(calls), 8)
            self.assertFalse(any('load' in command or 'pull' in command or 'run' in command for command in calls))


if __name__ == '__main__':
    unittest.main()
