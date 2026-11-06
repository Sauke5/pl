"""Attested Forms provenance-only COPY differences never select new storage."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location('forms_storage_delivery', Path(__file__).resolve().parents[1] / 'delivery.py')
d = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(d)
PAIRS = {
    'mongo': ('sha256:59d6350a5a9616d78bc4b1b573bc71c5226340137048061974c7060f203c8174', 'sha256:a70cada625bfa48128fe225f9e5e47a8f23d5dcacc5ed70129ddf8ecd1d0eaad'),
    'keydb': ('sha256:c87e4aef35c9c97793697a32c2f58b91e0d76501d97a293e935b0f8d00fc94d5', 'sha256:47f92549d53e95386be14e052f9cc4ae9efdc015a3ab3f57e0612151fa3242a2'),
}


class FormsMetadataPreservation(unittest.TestCase):
    def setUp(self):
        self.old, self.new, self.images, self.calls = {}, {}, {}, []
        for i, (role, pair) in enumerate(PAIRS.items()):
            labels = {'pl.module.id': 'forms', 'pl.module.role': role, 'pl.module.config.version': '1',
                'org.opencontainers.image.version': '0.1.0', 'pl.build.variant': 'upstream-pinned',
                'pl.upstream.version': '9.0.4' if role == 'mongo' else '6.3.4', 'pl.source.sha256': 'a' * 64}
            for candidate, destination in ((False, self.old), (True, self.new)):
                identifier = 'sha256:' + str(i * 2 + int(candidate) + 1) * 64
                selected = {**labels, 'pl.source.sha256': ('b' if candidate else 'a') * 64}
                destination[role] = {'id': identifier, 'architecture': 'amd64', 'recipe': 'deploy/images/forms.Dockerfile',
                    'ref': 'pl/forms-' + role + (':new' if candidate else ':old'), 'labels': selected}
                self.images[identifier] = {'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Labels': selected, 'User': '999:999', 'Env': ['HOME=/tmp']},
                    'RootFS': {'Type': 'layers', 'Layers': ['sha256:' + 'c' * 64, pair[int(candidate)]]}}
        def docker(*args):
            self.calls.append(args)
            self.assertEqual(args[:2], ('image', 'inspect'))
            return json.dumps([self.images[args[2]]]).encode()
        self.delivery = object.__new__(d.Delivery)
        self.delivery.parent = SimpleNamespace(docker=docker)
        self.delivery.module_registry = lambda: {'forms': self.old}

    def preserve(self):
        return self.delivery.preserve_storage_images('forms', copy.deepcopy(self.new))

    def test_attested_pairs_keep_exact_old_descriptors_without_mutating_input_or_starting(self):
        before = copy.deepcopy(self.new)
        self.assertEqual(self.preserve(), self.old)
        self.assertEqual(self.new, before)
        self.assertEqual(len(self.calls), 4)

    def test_changed_data_config_prefix_and_unknown_or_reversed_pairs_are_not_preserved(self):
        baseline = copy.deepcopy(self.images)
        for role in PAIRS:
            identifier = self.new[role]['id']
            for change in ('prefix', 'last', 'length', 'type', 'config', 'os', 'architecture', 'reverse', 'other_role_pair'):
                self.images = copy.deepcopy(baseline)
                image = self.images[identifier]
                if change == 'prefix': image['RootFS']['Layers'][0] = 'sha256:' + 'd' * 64
                elif change == 'last': image['RootFS']['Layers'][-1] = 'sha256:' + 'e' * 64
                elif change == 'length': image['RootFS']['Layers'].insert(0, 'sha256:' + 'd' * 64)
                elif change == 'type': image['RootFS']['Type'] = 'other'
                elif change == 'config': image['Config']['Env'] = ['HOME=/other']
                elif change == 'os': image['Os'] = 'windows'
                elif change == 'architecture': image['Architecture'] = 'arm64'
                elif change == 'reverse':
                    self.images[self.old[role]['id']]['RootFS']['Layers'][-1], image['RootFS']['Layers'][-1] = PAIRS[role][1], PAIRS[role][0]
                else:
                    other = 'keydb' if role == 'mongo' else 'mongo'
                    self.images[self.old[role]['id']]['RootFS']['Layers'][-1], image['RootFS']['Layers'][-1] = PAIRS[other]
                with self.subTest(role=role, change=change): self.assertEqual(self.preserve()[role], self.new[role])

    def test_labels_recipe_version_and_descriptor_architecture_remain_strict(self):
        baseline = copy.deepcopy(self.new)
        for role in PAIRS:
            for field, value in (('pl.module.id', 'other'), ('pl.module.role', 'other'), ('pl.module.config.version', '2'),
                                 ('org.opencontainers.image.version', '0.2.0'), ('pl.upstream.version', 'changed'),
                                 ('pl.build.variant', 'source-build'), ('extra', 'unapproved')):
                self.new = copy.deepcopy(baseline); self.new[role]['labels'][field] = value
                with self.subTest(role=role, label=field): self.assertEqual(self.preserve()[role], self.new[role])
            for field, value in (('recipe', 'deploy/images/other.Dockerfile'), ('architecture', 'arm64')):
                self.new = copy.deepcopy(baseline); self.new[role][field] = value
                with self.subTest(role=role, field=field): self.assertEqual(self.preserve()[role], self.new[role])


if __name__ == '__main__': unittest.main()
