"""Source evidence must come from the exact Go module used by the compiler."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('pl_grafana_build_test', Path(__file__).resolve().parents[1] / 'grafana-build.py')
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class SecuritySourceEvidenceTests(unittest.TestCase):
    def fixture(self, root):
        module = root / 'module'
        output = root / 'proof'
        output.mkdir()
        files = {'GO-2026-5528': ('modules/frontend/config.go', b'package frontend\n// fixed query limit\n'),
                 'GO-2026-5359': ('tempodb/backend/s3/config.go', b'package s3\n// fixed secret type\n')}
        evidence = []
        for advisory, (name, raw) in files.items():
            path = module / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            evidence.append({'advisory': advisory, 'source_sha256': hashlib.sha256(raw).hexdigest(),
                             'required_fragment': raw.splitlines()[-1].decode()})
        version = 'v1.5.1-0.20260910130453-bcfe9f230c1d'
        row = {'retained_dependencies': {'github.com/grafana/tempo': version}, 'security_evidence': evidence}
        actual = {'Path': 'github.com/grafana/tempo', 'Version': version, 'Dir': str(module)}
        return output, row, actual, files

    def test_copies_actual_compiler_module_files_and_binds_their_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output, row, actual, files = self.fixture(root)
            with patch.object(build, 'command', return_value=json.dumps(actual)) as command:
                build.security_provenance(root, output, row, {})
            command.assert_called_once_with(['go', 'list', '-m', '-json', 'github.com/grafana/tempo'], root, {}, capture=True)
            report = json.loads((output / 'security/source-evidence.json').read_text())
            self.assertEqual(report['version'], actual['Version'])
            self.assertEqual(report['module'], 'github.com/grafana/tempo')
            for item in report['files']:
                raw = (output / 'security' / item['file']).read_bytes()
                self.assertEqual(raw, files[item['advisory']][1])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), item['sha256'])

    def test_wrong_module_replacement_source_or_fix_cannot_produce_accepted_evidence(self):
        for scenario in ('module', 'version', 'replace', 'source', 'fragment', 'missing-advisory', 'symlink'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                output, row, actual, files = self.fixture(root)
                first = Path(actual['Dir']) / files['GO-2026-5528'][0]
                if scenario == 'module':
                    actual['Path'] = 'github.com/other/module'
                elif scenario == 'version':
                    actual['Version'] = 'v1.0.0'
                elif scenario == 'replace':
                    actual['Replace'] = {'Dir': '/unverified'}
                elif scenario == 'source':
                    first.write_bytes(b'package frontend\n// old vulnerable source\n')
                elif scenario == 'fragment':
                    row['security_evidence'][0]['required_fragment'] = 'missing actual fix'
                elif scenario == 'missing-advisory':
                    row['security_evidence'].pop()
                else:
                    target = root / 'foreign.go'
                    target.write_bytes(first.read_bytes())
                    first.unlink()
                    first.symlink_to(target)
                with patch.object(build, 'command', return_value=json.dumps(actual)), self.assertRaises(ValueError):
                    build.security_provenance(root, output, row, {})
                self.assertFalse((output / 'security/source-evidence.json').exists())


if __name__ == '__main__':
    unittest.main()
