import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pl_public_export", BASE / "public-export.py")
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


class PublicExportTests(unittest.TestCase):
    def test_context_preserves_public_source_structure_and_rejects_traversal(self):
        for name, expected in {
            "cmd/portal/main.go": "monitoring/source/it-portal/cmd/portal/main.go",
            "deploy/images/forms.Dockerfile": "monitoring/source/it-portal/deploy/images/forms.Dockerfile",
            "apps/forms/app.py": "apps/forms/app.py",
            "installer/grafana-build.py": "installer/grafana-build.py",
        }.items():
            self.assertEqual(export.context_destination(name), expected)
        for name in ("../escape", "/absolute", ".git/config", "ci/.private/key", "release/private/value", "data.sqlite", "SOURCE-SNAPSHOT.json", "a/._private", "x\\escape"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                export.source_name(name)

    def test_runtime_context_uses_every_supported_module_flag(self):
        def source_context(destination, with_forms=False, with_doska=False):
            self.assertTrue(with_forms)
            self.assertTrue(with_doska)
            with tarfile.open(destination, "w:gz") as archive:
                for name in ("internal/main.go", "apps/forms/app.py", "apps/doska/apps/web/src/main.tsx", "apps/netmap/SOURCE-SNAPSHOT.json"):
                    value = b"public source"
                    member = tarfile.TarInfo(name)
                    member.size = len(value)
                    archive.addfile(member, io.BytesIO(value))
        files = export.source_context_files(Path("unused"), types.SimpleNamespace(source_context=source_context))
        self.assertEqual(set(files), {"monitoring/source/it-portal/internal/main.go", "apps/forms/app.py", "apps/doska/apps/web/src/main.tsx"})

    def test_allowlist_excludes_runtime_metadata_receipts_and_build_outputs(self):
        allowed = (
            "apps/file-auditor/src/Auditor.Api/Program.cs",
            "apps/file-auditor/tests/Auditor.Tests/GatewayTests.cs",
            "monitoring/source/websites-admin/app/static/ecosystem/ui-v1.js",
            "monitoring/source/scripts/monitoring_summary/collector.py",
            "monitoring/source/nginx/index.html",
            "monitoring/source/it-portal/deploy/doska/prepare-gateway-manifest.py",
        )
        for name in allowed:
            self.assertTrue(export.supplemental_allowed(name), name)
        denied = (
            "apps/inventory/inventory_service/app.py",
            "apps/inventory/web/index.html",
            "apps/inventory/README.ru.md",
            "apps/inventory/LICENSE",
            "apps/inventory/SOURCE-SNAPSHOT.json",
            "apps/file-auditor/src/Auditor.Api/bin/Release/Auditor.Api.dll",
            "apps/file-auditor/src/Auditor.Web/node_modules/index.js",
            "apps/inventory/.venv/secrets.py",
            "monitoring/source/scripts/legacy/old.py",
            "installer/acceptance.core7.dev.json",
            "ci/fixtures.py",
            "monitoring/source/it-portal/frontend/tests/e2e/reports-theme.spec.ts",
            "monitoring/source/monitoring-admin/docs/platform-integration-qa.md",
            "monitoring/source/websites-admin/docs/ecosystem-ui-qa.md",
        )
        for name in denied:
            self.assertFalse(export.supplemental_allowed(name), name)

    def test_audit_detects_private_material_site_and_home_without_echoing_values(self):
        # Assemble synthetic forbidden material so this test source itself does
        # not contain a deployment identity or complete private-key marker.
        examples = {
            "private-key": b"-----BEGIN " + b"PRIVATE KEY-----\nnot-a-real-key",
            "access-token": ("ghp_" + "A" * 36).encode(),
            "personal-home": ("/" + "Users" + "/example/project").encode(),
            "laboratory-address": ("192.168.2." + "25").encode(),
            "site-domain": ("https://monitoring." + "p" + "sk-group.ru").encode(),
            "url-credential": b"https://actual-user:unrelated-value@service.example.org",
        }
        for rule, body in examples.items():
            findings = export.audit_files({"app/source.py": body})
            self.assertTrue(any(item["rule"] == rule and item["severity"] == "error" for item in findings), rule)
            self.assertNotIn(body.decode(), json.dumps(findings))

    def test_standards_and_runtime_interpolation_are_not_site_secrets(self):
        body = b'cipher="TLS_PSK"\nurl="postgres://pl:${PL_DB_PASSWORD:?}@db/pl"\n'
        findings = export.audit_files({"installer/bootstrap.py": body})
        self.assertFalse([item for item in findings if item["severity"] == "error"])
        self.assertEqual(findings[0]["severity"], "reviewed")

    def test_import_subdirectory_named_home_is_not_a_personal_user_path(self):
        findings = export.audit_files({"apps/example/src/main.ts": b'import {x} from "@/components/home/page";\n'})
        self.assertFalse(findings)

    def test_reviewed_test_token_is_bound_to_exact_file_and_exact_bytes(self):
        root = BASE.parent
        for name in export.REVIEWED_TEST_TOKENS:
            tokens = list(export.ACCESS_TOKEN.finditer((root / name).read_text()))
            self.assertEqual(len(tokens), 1, name)
            token = tokens[0].group()
            good = export.audit_files({name: token.encode()})
            self.assertEqual(good[0]["severity"], "reviewed")
            for path, value in (("app.py", token), (name, token[:-1] + ("Z" if token[-1] != "Z" else "Y"))):
                self.assertEqual(export.audit_files({path: value.encode()})[0]["severity"], "error")

    def test_negative_key_marker_exception_never_allows_a_complete_key_block(self):
        begin = b"-----BEGIN " + b"PRIVATE KEY-----"
        end = b"-----END " + b"PRIVATE KEY-----"
        body = b'package.audit_source_file("fixture", b"' + begin + b'\\n' + b"A"*64 + b'\\n' + end + b'")'
        findings = export.audit_files({"installer/tests/test_package.py": body})
        self.assertTrue(any(item["rule"] == "private-key" and item["severity"] == "error" for item in findings))

    def vendor(self, name="package/core.js", body=b"public UI", *, symlink=False):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            member = tarfile.TarInfo(name)
            if symlink:
                member.type = tarfile.SYMTYPE
                member.linkname = "/elsewhere"
                archive.addfile(member)
            else:
                member.size = len(body)
                archive.addfile(member, io.BytesIO(body))
        return buffer.getvalue()

    def test_vendor_archives_are_recursively_audited_and_never_extract_links(self):
        name = "apps/file-auditor/src/Auditor.Web/vendor/pl-ui-1.tgz"
        self.assertFalse(export.audit_files({name: self.vendor()}))
        for archive in (self.vendor("../private"), self.vendor(symlink=True), self.vendor(body=("ghp_" + "B" * 36).encode())):
            self.assertTrue([item for item in export.audit_files({name: archive}) if item["severity"] == "error"])

    def test_export_is_new_plain_tree_with_file_manifest_and_no_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "public"
            selected = {"LICENSE": b"license\n", "installer/get-pl.sh": b"#!/bin/sh\n", "apps/forms/app.py": b"pass\n"}
            manifest = export.write_export(destination, selected)
            self.assertEqual({item["path"] for item in manifest["files"]}, set(selected))
            self.assertEqual(manifest, json.loads((destination / "PUBLIC-SOURCE-MANIFEST.json").read_text()))
            self.assertFalse((destination / ".git").exists())
            self.assertFalse((destination / "release/private").exists())
            for item in manifest["files"]:
                self.assertEqual(item["sha256"], export.digest((destination / item["path"]).read_bytes()))
            self.assertEqual((destination / "installer/get-pl.sh").stat().st_mode & 0o777, 0o755)
            with self.assertRaises(ValueError):
                export.write_export(destination, selected)

    def test_private_report_is_mode_600_and_not_an_export_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "private/report.json"
            export.write_report(path, {"errors": 1})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), {"errors": 1})

    def test_supplemental_read_refuses_symlinked_parents(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "private").mkdir()
            (root / "private/data.py").write_bytes(b"not public")
            (root / "apps").mkdir()
            (root / "apps/example").symlink_to(root / "private", target_is_directory=True)
            with self.assertRaises(ValueError):
                export.read_regular(root, "apps/example/data.py")

    def test_cli_audit_failure_does_not_write_partial_public_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            output, report = root / "release/generated/export", root / "release/private/audit.json"
            secret = ("ghp_" + "C" * 36).encode()
            with patch.object(export, "ROOT", root), patch.object(export, "select_files", return_value={"app.py": secret}), patch("sys.stderr", new=io.StringIO()):
                self.assertEqual(export.main(["--output", str(output), "--report", str(report)]), 2)
            self.assertFalse(output.exists())
            self.assertEqual(json.loads(report.read_text())["errors"], 1)


if __name__ == "__main__":
    unittest.main()
