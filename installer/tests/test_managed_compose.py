"""Managed Compose admission on used installations and staged cold backups."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


BASE = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, BASE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bootstrap = load("pl_model_bootstrap", "bootstrap.py")
maintenance = load("pl_model_maintenance", "maintenance.py")
dr = load("pl_model_dr", "disaster-recovery.py")


class ManagedComposeTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(bootstrap.platform, "machine", return_value="x86_64"))
        if not hasattr(os, "listxattr"):
            self.enterContext(patch.object(os, "listxattr", create=True, return_value=[]))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / "installation"
        self.root.mkdir(mode=0o700)
        self.installation = "pl-123456abcdef"
        self.version = "0.5.4"
        self.marker = {"product": "PL", "uid": os.getuid() or 991, "gid": os.getgid() or 991}
        for name in ("private", "state", "config", "releases"):
            (self.root / name).mkdir(mode=0o700)
        self.write(".pl-installation.json", self.marker)
        self.package = self.root / "releases" / self.version
        self.package.mkdir(mode=0o700)
        key = (BASE / "release-signing-public.pem").read_bytes()
        files = {}
        for name in bootstrap.FILES:
            # Validation must use trusted local helpers, not this staged code.
            body = key if name == "release-signing-public.pem" else b"raise RuntimeError('untrusted backup code')\n"
            path = self.package / name
            path.write_bytes(body)
            path.chmod(0o600)
            files[name] = hashlib.sha256(body).hexdigest()
        architecture = {"x86_64": "amd64", "aarch64": "arm64"}[bootstrap.platform.machine()]
        source = "c" * 64
        self.manifest = {"schema": 2, "product": "PL", "version": self.version,
            "architecture": architecture, "source_sha256": source, "files": files,
            "features": {"local_users": True, "module_controller": True, "on_demand_modules": True,
                         "connector_credentials": True, "icmp_probe": True, "upgrade_status": True},
            "database": {"major": 18, "version": "18.6", "volume_target": "/var/lib/postgresql",
                         "pgdata": "/var/lib/postgresql/18/docker"}, "images": {}}
        for index, name in enumerate(("api", "web", "db"), 1):
            labels = {"pl.source.sha256": source}
            if name == "db":
                labels.update({"pl.component": "postgresql", "pl.postgresql.version": "18.6",
                               "pl.gosu.version": "1.19", "pl.gosu.go.version": "1.27.2"})
            self.manifest["images"][name] = {"id": "sha256:" + str(index) * 64,
                "architecture": architecture, "ref": "pl/core-" + name + ":" + self.version,
                "recipe": "deploy/images/postgres.Dockerfile" if name == "db" else "Dockerfile", "labels": labels}
        self.write("releases/" + self.version + "/manifest.json", self.manifest)
        self.manifest_sha = bootstrap.digest(self.package / "manifest.json")
        self.cfg = dict(bootstrap.configuration("https://pl.example.test:8452", "127.0.0.1", "admin",
            "172.31.252.0/24", "172.30.0.0/16"), custom_tls=False)
        self.state = {"schema": 1, "product": "PL", "phase": "ready", "install_id": self.installation,
            "version": self.version, "manifest_sha256": self.manifest_sha, "config": self.cfg}
        self.write("state/installation.json", self.state)
        self.canonical = bootstrap.compose_model(self.root, self.manifest, self.cfg, self.installation)
        self.write("config/compose.json", self.canonical)
        self.write("config/delivery.json", {"schema": 1,
            "catalog_url": "https://github.com/Sauke5/pl/releases/download/v0.5.4/catalog.json"})
        self.write("state/controller-active.json", {"schema": 1, "version": self.version})
        self.write("state/controller-supervisor.json", {"schema": 1, "version": self.version})
        registry = {"schema": 1, "installation": self.installation, "manifest_sha256": self.manifest_sha}
        self.write("private/module-images.json", registry)
        (self.root / "private/runtime.env").write_text("PL_DB_PASSWORD=" + "a" * 64 + "\n")
        (self.root / "private/runtime.env").chmod(0o600)
        credential = self.root / "private/integration-credential-key"
        credential.write_bytes(b"k" * 32)
        os.chown(credential, -1, self.marker["gid"])
        credential.chmod(0o640)
        self.meta = {"installation": self.installation, "root": str(self.root), "version": self.version,
            "supervisor_version": self.version, "manifest_sha256": self.manifest_sha, "origin": self.cfg["public_url"],
            "marker": self.marker, "architecture": architecture, "registry": registry, "native": {},
            "images": {image["id"]: image for image in self.manifest["images"].values()}, "networks": []}
        for role, subnet in bootstrap.network_subnets(self.cfg["network_cidr"]).items():
            network = dr.ipaddress.IPv4Network(subnet)
            self.meta["networks"].append({"name": self.installation + "_" + role, "id": "d" * 64,
                "labels": {"pl.installation": self.installation, "com.docker.compose.project": self.installation,
                           "com.docker.compose.network": role}, "internal": role == "backend",
                "subnet": str(network), "gateway": str(network.network_address + 1)})

    def write(self, relative, value):
        path = self.root / relative
        path.write_text(json.dumps(value) + "\n")
        path.chmod(0o600)

    def runtime(self):
        account = types.SimpleNamespace(pw_uid=self.marker["uid"], pw_gid=self.marker["gid"])
        with patch.object(maintenance.bootstrap.pwd, "getpwnam", return_value=account):
            return maintenance.Runtime(self.root)

    def upgraded_order(self):
        model = copy.deepcopy(self.canonical)
        mounts = model["services"]["api"]["volumes"]
        # Exact native122 shape after ICMP and upgrade-status handoff:
        # auth, transfers, controller-dir/key, credential-key, ICMP, status.
        model["services"]["api"]["volumes"] = [mounts[i] for i in (0, 2, 3, 4, 6, 5, 1)]
        model["services"]["web"]["volumes"].reverse()
        return model

    def test_runtime_accepts_native_upgraded_mount_order_without_rewriting_files(self):
        self.runtime()
        model = self.upgraded_order()
        self.write("config/compose.json", model)
        path = self.root / "config/compose.json"
        before = (path.read_bytes(), path.stat().st_ino)
        runtime = self.runtime()
        self.assertEqual(runtime.model, model)
        self.assertEqual((path.read_bytes(), path.stat().st_ino), before)

    def test_cold_archive_validator_accepts_upgraded_order_using_only_trusted_helpers(self):
        dr.validate_package_tree(self.root, self.meta)
        self.write("config/compose.json", self.upgraded_order())
        archive = self.base / "installation.tar"
        delivery = dr.helper("delivery")
        with dr.tarfile.open(archive, "w", format=dr.tarfile.PAX_FORMAT) as target:
            for path in sorted(self.root.iterdir()):
                delivery.add_tree(target, path, path.name)
        stage = self.base / "stage"
        stage.mkdir(mode=0o700)
        delivery.restore_tree(archive, stage)
        dr.verify_tree(archive, stage)
        path = stage / "config/compose.json"
        before = (path.read_bytes(), path.stat().st_ino)
        state, manifest = dr.validate_package_tree(stage, self.meta)
        self.assertEqual(state, self.state)
        self.assertEqual(manifest, self.manifest)
        self.assertEqual((path.read_bytes(), path.stat().st_ino), before)

    def test_runtime_and_archive_guards_do_not_accept_bool_integer_coercion(self):
        for path in (("services", "api", "read_only"),
                     ("services", "web", "volumes", 0, "bind", "create_host_path")):
            with self.subTest(path=path):
                model = copy.deepcopy(self.canonical)
                target = model
                for part in path[:-1]:
                    target = target[part]
                target[path[-1]] = int(target[path[-1]])
                self.write("config/compose.json", model)
                for name, validate, message in (
                    ("runtime", self.runtime, "Core Compose"),
                    ("archive", lambda: dr.validate_package_tree(self.root, self.meta), "Recovery Compose"),
                ):
                    with self.subTest(consumer=name), self.assertRaisesRegex(ValueError, message):
                        validate()

    def test_managed_model_preserves_types_full_mount_records_and_other_list_order(self):
        model = self.upgraded_order()
        before = copy.deepcopy(model)
        self.assertTrue(bootstrap.managed_model_equal(model, self.canonical))
        self.assertEqual(model, before)
        mutations = (
            ("services", "api", "volumes", 0, "other-auth:/run/pl-auth"),
            ("services", "api", "volumes", 0, "local-auth:/run/pl-auth:ro"),
            ("services", "api", "volumes", 2, "source", "/foreign"),
            ("services", "api", "volumes", 2, "target", "/foreign"),
            ("services", "api", "volumes", 2, "read_only", False),
            ("services", "api", "volumes", 2, "read_only", 1),
            ("services", "api", "volumes", 2, "bind", {"create_host_path": 0}),
            ("services", "api", "volumes", 2, "extra", True),
            ("services", "api", "image", "sha256:" + "f" * 64),
            ("services", "api", "environment", "PORTAL_DEMO", "true"),
            ("services", "api", "networks", ["egress", "backend"]),
            ("services", "api", "cap_drop", []),
            ("services", "other", {"image": "foreign"}),
            ("services", "web", "ports", 0, "target", "8443"),
            ("networks", "backend", "internal", 1),
        )
        for *path, value in mutations:
            with self.subTest(path=path, value=value):
                changed = copy.deepcopy(model)
                target = changed
                for part in path[:-1]:
                    target = target[part]
                target[path[-1]] = value
                self.assertFalse(bootstrap.managed_model_equal(changed, self.canonical))
                self.write("config/compose.json", changed)
                with self.assertRaisesRegex(ValueError, "Core Compose"):
                    self.runtime()
                with self.assertRaisesRegex(ValueError, "Recovery Compose"):
                    dr.validate_package_tree(self.root, self.meta)
        expected = copy.deepcopy(self.canonical)
        expected["services"]["db"]["volumes"].append("other:/other")
        changed = copy.deepcopy(expected)
        changed["services"]["db"]["volumes"].reverse()
        self.assertFalse(bootstrap.managed_model_equal(changed, expected))

    def test_both_consumers_reject_missing_extra_duplicate_and_malformed_mounts(self):
        malformed = (None, {}, 1, "local-auth", "local-auth:relative", "local-auth:/run/../auth",
                     {"type": "bind", "source": "/tmp", "target": False},
                     {"type": "bind", "target": "/run/new"})
        variants = []
        for value in malformed:
            model = self.upgraded_order()
            model["services"]["api"]["volumes"][0] = value
            variants.append(model)
        missing = self.upgraded_order()
        missing["services"]["api"]["volumes"].pop()
        variants.append(missing)
        extra = self.upgraded_order()
        extra["services"]["web"]["volumes"].append("other:/other")
        variants.append(extra)
        duplicate = self.upgraded_order()
        duplicate["services"]["api"]["volumes"].append(copy.deepcopy(duplicate["services"]["api"]["volumes"][1]))
        variants.append(duplicate)
        duplicate_cross_syntax = self.upgraded_order()
        duplicate_cross_syntax["services"]["api"]["volumes"].append(
            {"type": "bind", "source": "/foreign", "target": "/run/pl-auth", "read_only": True})
        variants.append(duplicate_cross_syntax)
        for model in variants:
            with self.subTest(model=model):
                self.write("config/compose.json", model)
                with self.assertRaisesRegex(ValueError, "Core Compose"):
                    self.runtime()
                with self.assertRaisesRegex(ValueError, "Recovery Compose"):
                    dr.validate_package_tree(self.root, self.meta)
                self.assertFalse(bootstrap.managed_model_equal(model, self.canonical))
                if model is not missing and model is not extra:
                    self.assertFalse(bootstrap.managed_model_equal(model, model))


if __name__ == "__main__":
    unittest.main()
