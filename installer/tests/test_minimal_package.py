"""Independent delivery boundaries: core never builds or ships module images."""
import copy
import hashlib
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


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


package = load("pl_minimal_package", BASE / "package.py")
bootstrap = load("pl_minimal_bootstrap", BASE / "bootstrap.py")
wrapper = types.ModuleType("pl_minimal_installer")
script = (BASE / "install.sh").read_text().split("<<'PL_INSTALL_PY'\n", 1)[1].rsplit("\nPL_INSTALL_PY", 1)[0]
exec(compile(script, str(BASE / "install.sh"), "exec"), wrapper.__dict__)


class MinimalBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "source.tar.gz"
        source_files = {name: b"fixture\n" for name in package.CONNECTOR_SOURCES}
        source_files["internal/providers/icmp.go"] = b"package providers\n"
        portal = BASE.parent / package.PREFIX
        self.labels = {"api": {}, "web": {}, **copy.deepcopy(package.IMAGE_SOURCES)}
        for module in ("xray", "alertmanager", "grafana", "wayline", *package.APPLICATION_ROLES):
            name = "deploy/images/" + module + ".sources.json"
            source_files[name] = (portal / name).read_bytes()
            data = json.loads(source_files[name])
            if module in ("xray", "alertmanager", "grafana"):
                self.labels[module] = data["labels"]
            else:
                self.labels.update({name: image["labels"] for name, image in data["images"].items()})
        with tarfile.open(self.source, "w:gz") as archive:
            for name, body in source_files.items():
                package.add(archive, name, body)
        installers = self.root / "installer"
        installers.mkdir()
        for path in BASE.iterdir():
            if path.is_file():
                (installers / path.name).write_bytes(b"fixture trusted payload\n")
        # delivery.py may still be developed in parallel in the shared checkout.
        (installers / "delivery.py").write_bytes(b"fixture delivery payload\n")
        self.commands = []

    def args(self, module=None, **options):
        value = types.SimpleNamespace(source_archive=self.source, output=self.root / (str(module) + ".tar.gz"),
                                      version="0.3.0", platform="linux/amd64", bundled=False,
                                      compression_level=1, module_id=module)
        if module:
            setattr(value, "with_" + module, True)
        for key, val in options.items():
            setattr(value, key, val)
        return value

    def execute(self, args, *, actual_arch="amd64"):
        source_hash = package.sha(self.source)

        def run(command, **kwargs):
            self.commands.append(command)
            if command[:3] == ["docker", "image", "inspect"]:
                name = command[3].split(":")[0].removeprefix("pl/core-")
                return json.dumps([{"Id": "sha256:" + hashlib.sha256(name.encode()).hexdigest(),
                                    "Os": "linux", "Architecture": actual_arch,
                                    "Config": {"Labels": {"pl.source.sha256": source_hash, **self.labels[name]}}}])
            if command[:3] == ["docker", "image", "save"]:
                Path(command[command.index("--output") + 1]).write_bytes(b"fixture image archive")
                return ""
            raise AssertionError("Unexpected command: " + repr(command))

        with patch.object(package, "ROOT", self.root), patch.object(package, "engine"), \
                patch.object(package, "run", side_effect=run), \
                patch.object(package.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as build, \
                patch.object(package, "grafana_build_arguments", return_value=[]):
            package.build(args)
        return [call.args[0] for call in build.call_args_list]

    def read_manifest(self, path, name="manifest.json"):
        with tarfile.open(path) as archive:
            manifest = json.load(archive.extractfile(name))
            for payload, expected in manifest["files"].items():
                self.assertEqual(hashlib.sha256(archive.extractfile(payload).read()).hexdigest(), expected)
            return manifest, set(archive.getnames())

    def test_default_build_ships_only_three_core_images_with_delivery_payload(self):
        args = self.args()
        calls = self.execute(args)
        manifest, files = self.read_manifest(args.output)
        self.assertEqual(set(manifest["images"]), {"api", "web", "db"})
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(command[command.index("--platform") + 1] == "linux/amd64" for command in calls))
        self.assertTrue(manifest["features"]["on_demand_modules"])
        self.assertNotIn("icmp_probe", manifest["features"])
        self.assertTrue({"delivery.py", "release-signing-public.pem", "forms-controller.py", "netmap-controller.py"} <= files)
        self.assertFalse(any(key.endswith("_module") for key in manifest["features"]))
        bootstrap.validate_bundled_images(manifest)
        self.assertEqual(wrapper.verify_package(args.output, "amd64"), manifest)
        extracted = self.root / "extracted"
        extracted.mkdir()
        with tarfile.open(args.output) as archive:
            for member in archive.getmembers():
                (extracted / member.name).write_bytes(archive.extractfile(member).read())
        with patch.object(bootstrap.platform, "machine", return_value="x86_64"):
            self.assertEqual(bootstrap.manifest(extracted), manifest)
            for changed in ({"images": {**manifest["images"], "prometheus": manifest["images"]["db"]}},
                            {"features": {**manifest["features"], "forms_module": True}}):
                invalid = {**manifest, **changed}
                (extracted / "manifest.json").write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    bootstrap.manifest(extracted)
                invalid_archive = self.root / ("invalid-" + next(iter(changed)) + ".tar.gz")
                package.write_package_archive(invalid_archive, invalid, {name: extracted / name for name in invalid["files"]})
                with self.assertRaises(wrapper.InstallError):
                    wrapper.verify_package(invalid_archive, "amd64")
        saved = next(command for command in self.commands if command[:3] == ["docker", "image", "save"])
        self.assertEqual(len(saved[5:]), 3)

    def test_legacy_bundle_requires_explicit_selection(self):
        args = self.args(bundled=True)
        self.execute(args)
        manifest, files = self.read_manifest(args.output)
        self.assertEqual(set(manifest["images"]), {"api", "web", "db", "prometheus", "xray", "alertmanager"})
        self.assertNotIn("on_demand_modules", manifest["features"])
        self.assertTrue(manifest["features"]["xray_module"])
        bootstrap.validate_bundled_images(manifest)

    def test_each_module_build_contains_only_its_own_roles(self):
        self.assertEqual(set(package.APPLICATION_ROLES), {"forms", "doska", "sftpgo", "netmap", "bookstack"})
        for module in ("prometheus", "xray", "alertmanager", "grafana", "wayline", *package.APPLICATION_ROLES):
            with self.subTest(module=module):
                args = self.args(module)
                calls = self.execute(args)
                manifest, files = self.read_manifest(args.output, "module.json")
                expected = {module} if module in ("prometheus", "xray", "alertmanager", "grafana") else set(package.WAYLINE_IMAGES) if module == "wayline" else {module + "-" + role for role in package.APPLICATION_ROLES[module]}
                self.assertEqual(set(manifest["images"]), expected)
                self.assertEqual(len(calls), len(expected))
                self.assertEqual(files, {"module.json", "images.tar", "source.tar.gz"})
                self.assertEqual((manifest["kind"], manifest["module_id"], manifest["core_api"]), ("module", module, 1))
                self.assertEqual(manifest["package_version"], "0.3.0")
                self.assertEqual(manifest["version"], next(iter(manifest["images"].values()))["labels"]["org.opencontainers.image.version"])

    def test_optional_flags_do_not_silently_restore_a_large_core(self):
        with self.assertRaisesRegex(ValueError, "independent module"):
            self.execute(self.args(with_forms=True))
        self.assertFalse(self.commands)

    def test_requested_platform_is_verified_against_built_image(self):
        with self.assertRaisesRegex(ValueError, "requested platform"):
            self.execute(self.args(), actual_arch="arm64")
        self.assertFalse(self.args().output.exists())


class MinimalBootstrapTests(unittest.TestCase):
    def test_allocator_skips_host_routes_and_docker_pools(self):
        self.assertEqual(bootstrap.choose_network_cidr(["10.240.0.0/24", "10.240.1.0/24", "0.0.0.0/0", "::/0"]), "10.240.2.0/24")
        self.assertEqual(bootstrap.choose_network_cidr(["10.0.0.0/8"]), "172.16.0.0/24")
        with self.assertRaisesRegex(ValueError, "No unused"):
            bootstrap.choose_network_cidr(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"])
        with self.assertRaises(ValueError):
            bootstrap.choose_network_cidr(["malformed-route"])

    def test_empty_module_descriptor_is_bound_to_core_without_module_image(self):
        manifest = {"images": {"api": {}, "web": {}, "db": {}}, "features": {"on_demand_modules": True}}
        descriptor = bootstrap.module_image_descriptor(manifest, "pl-fixture", "f" * 64)
        self.assertEqual(descriptor, {"schema": 1, "installation": "pl-fixture", "manifest_sha256": "f" * 64})

    def test_repeated_core_bootstrap_preserves_independently_delivered_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            private = root / "private"
            private.mkdir()
            release = root / "package"
            release.mkdir()
            (release / "manifest.json").write_text("fixture")
            manifest = {"schema": 2, "images": {}, "features": {"on_demand_modules": True}}
            runtime = types.SimpleNamespace(root=root, private=private, package=release, m=manifest, install_id="pl-fixture")
            bootstrap.prepare_module_image_descriptor(runtime)
            path = private / "module-images.json"
            current = json.loads(path.read_text())
            current["forms"] = {"adapter": {"id": "sha256:" + "a" * 64}}
            path.write_text(json.dumps(current))
            before = path.read_bytes()
            bootstrap.prepare_module_image_descriptor(runtime)
            self.assertEqual(path.read_bytes(), before)
            for change in ({"installation": "pl-foreign"}, {"manifest_sha256": "f" * 64}, {"foreign": {}}):
                invalid = {**current, **change}
                path.write_text(json.dumps(invalid))
                with self.assertRaisesRegex(ValueError, "descriptor differs"):
                    bootstrap.prepare_module_image_descriptor(runtime)
                self.assertEqual(json.loads(path.read_text()), invalid)

    def test_delivery_config_is_created_once_and_foreign_configuration_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "config").mkdir()
            bootstrap.prepare_delivery_configuration(root)
            path = root / "config/delivery.json"
            previous = path.stat().st_mtime_ns
            bootstrap.prepare_delivery_configuration(root)
            self.assertEqual(path.stat().st_mtime_ns, previous)
            self.assertEqual(json.loads(path.read_text())["schema"], 1)
            path.write_text('{"schema":1,"catalog_url":"https://untrusted.example/manifest"}')
            with self.assertRaisesRegex(ValueError, "trusted release channel"):
                bootstrap.prepare_delivery_configuration(root)


if __name__ == "__main__":
    unittest.main()
