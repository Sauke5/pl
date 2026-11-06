"""Local filesystem/archive and finite recovery tests. No daemon or host changes."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import itertools
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
import uuid
from unittest.mock import Mock, patch


BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pl_dr_test", BASE / "disaster-recovery.py")
dr = importlib.util.module_from_spec(spec); spec.loader.exec_module(dr)
NATIVE_XATTR = hasattr(os, "listxattr")


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class FullRecoveryTests(unittest.TestCase):
    def setUp(self):
        if not NATIVE_XATTR:
            # The supported runtime is Linux. This Mac's Python omits the xattr
            # API; archive/data tests exercise empty attrs, the Linux test below
            # remains an explicit platform gate rather than a product fallback.
            self.enterContext(patch.object(os, "listxattr", create=True, return_value=[]))
        self.temporary = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "installation"
        self.installation = "pl-123456abcdef"
        image = "sha256:" + "a" * 64
        self.meta = {"schema": 1, "product": "PL-full-disaster-backup", "backup_id": str(uuid.uuid4()),
            "created_unix": 1790000000, "installation": self.installation, "root": str(self.root),
            "origin": "https://pl.example.test:8452", "architecture": "amd64", "version": "0.5.1",
            "manifest_sha256": "b" * 64, "supervisor_version": "0.5.0-rc.1",
            "marker": {"product": "PL", "uid": os.getuid() or 991, "gid": os.getgid() or 991},
            "schema_contract": {"postgres_major": 18}, "live_auth_sha256": "c" * 64,
            "images": {image: {"id": image, "architecture": "amd64", "ref": "pl/test:v1", "recipe": "Dockerfile", "labels": {}}},
            "image_storage_bytes": 1024**2,
            "registry": {"schema": 1, "installation": self.installation, "manifest_sha256": "b" * 64},
            "native": {}, "containers": [], "volumes": [], "networks": [], "files": {}, "controller_active": True}
        for service in ("db", "api", "web"):
            name = self.installation + "-" + service + "-1"
            self.meta["containers"].append({"name": name, "id": digest(name), "running": True, "core": True,
                "service": service, "module_id": "", "instance_id": "", "role": "", "image": image,
                "contract": "d" * 64, "bindings": {}})
        for suffix in ("_db", "-auth", "_module-transfers"):
            self.add_volume(self.installation + suffix, {"pl.installation": self.installation})
        for role, subnet in (("backend", "172.31.252.0/26"), ("ingress", "172.31.252.64/26"), ("egress", "172.31.252.128/26")):
            self.meta["networks"].append({"name": self.installation + "_" + role, "id": digest(role),
                "labels": {"pl.installation": self.installation, "com.docker.compose.project": self.installation,
                           "com.docker.compose.network": role}, "internal": role == "backend", "subnet": subnet,
                "gateway": str(dr.ipaddress.IPv4Network(subnet).network_address + 1)})
        self.payload = self.base / "payload"; self.payload.mkdir(mode=0o700)
        self.source = self.base / "source"; self.source.mkdir(mode=0o700)
        for name in ("config", "private", "state", "modules", "releases"):
            (self.source / name).mkdir(mode=0o700)
        (self.source / ".pl-installation.json").write_bytes(dr.encoded(self.meta["marker"]))
        (self.source / ".pl-installation.json").chmod(0o600)
        self.secret = b"LIVE_HASH_NOT_THE_OLD_SEED"
        (self.source / "private/live-auth-fixture").write_bytes(self.secret)
        (self.source / "private/live-auth-fixture").chmod(0o600)

    def add_volume(self, name, labels):
        self.meta["volumes"].append({"name": name, "labels": labels, "archive": "volume-" + str(len(self.meta["volumes"])) + ".tar"})

    def add_module(self, kind):
        instance = str(uuid.uuid4())
        prefix = self.installation + "-" + kind + "-" + instance
        item = {"instance_id": instance, "running": kind != "prometheus", "state_sha256": "e" * 64, "containers": []}
        self.meta["native"][kind] = {"instances": [item]}
        for role in dr.ROLES[kind]:
            name = prefix + ("-" + role if len(dr.ROLES[kind]) > 1 else "")
            item["containers"].append({"name": name, "role": role})
            self.meta["containers"].append({"name": name, "id": digest(name), "running": item["running"], "core": False,
                "service": "", "module_id": kind, "instance_id": instance, "role": role,
                "image": next(iter(self.meta["images"])), "contract": "d" * 64, "bindings": {}})
        labels = {"pl.installation": self.installation, "pl.module": kind, "pl.instance": instance}
        for volume in dr.VOLUMES[kind]: self.add_volume(prefix + ("-" + volume if volume else "") + "-data", labels)
        if kind in dr.NETWORK_MODULES:
            index = len(self.meta["networks"])
            subnet = "172.30." + str(index) + ".0/" + ("28" if kind == "netmap" else "29")
            self.meta["networks"].append({"name": prefix + "-net", "id": digest(prefix),
                "labels": {**labels, "pl.module.network.version": "1", "pl.module.network.subnet": subnet},
                "internal": kind == "forms", "subnet": subnet, "gateway": "172.30." + str(index) + ".1"})
        return instance

    def tree_archive(self, path, source, installation=False):
        delivery = dr.helper("delivery")
        with tarfile.open(path, "w", format=tarfile.PAX_FORMAT) as archive:
            if installation:
                for item in sorted(source.iterdir()): delivery.add_tree(archive, item, item.name)
            else: delivery.add_tree(archive, source, ".")
        path.chmod(0o600)

    def build_backup(self):
        self.tree_archive(self.payload / "installation.tar", self.source, installation=True)
        with tarfile.open(self.payload / "images.tar", "w"):
            pass
        for index, volume in enumerate(self.meta["volumes"]):
            data = self.base / ("volume" + str(index)); data.mkdir(mode=0o700)
            file = data / "data.bin"; file.write_bytes(b"native bytes " + bytes([index % 255])); file.chmod(0o600)
            self.tree_archive(self.payload / volume["archive"], data)
        for path in self.payload.iterdir():
            self.meta["files"][path.name] = {"sha256": dr.checksum(path), "bytes": path.stat().st_size}
        dr.validate_metadata(self.meta)
        output = self.base / "backup.tar"
        dr.seal_archive(output, self.meta, self.payload)
        return output

    def recovery(self):
        self.root.mkdir(mode=0o700); (self.root / "recovery").mkdir(mode=0o700)
        host = types.SimpleNamespace(docker=Mock(), verify_images=Mock(), inspect_all=Mock(return_value=[]), run=Mock())
        recovery = dr.Recovery(self.root, self.meta, self.payload, "f" * 64, host)
        recovery.operation = {"schema": 1, "backup_id": self.meta["backup_id"], "installation": self.installation,
            "root": str(self.root), "archive_sha256": "f" * 64, "phase": "prepared", "committed": False,
            "created": {"volume": {}, "network": {}, "container": {}}, "files_installed": False,
            "restored_volumes": [], "rebindings": {}, "sessions_revoked": False}
        recovery.write()
        return recovery

    def test_all_ten_kinds_have_closed_complete_role_volume_and_network_sets(self):
        for kind in sorted(dr.MODULES): self.add_module(kind)
        self.build_backup()
        dr.validate_networks(self.meta)
        self.assertEqual(len(self.meta["native"]), 10)
        self.assertTrue(any(not v["running"] for v in self.meta["containers"]))

    def test_core_network_set_includes_canonical_api_egress(self):
        self.build_backup()
        self.assertEqual(set(dr.CORE_NETWORKS), set(dr.helper("bootstrap").network_subnets("172.31.252.0/24")))
        self.assertTrue(any(value["name"].endswith("_egress") and not value["internal"] for value in self.meta["networks"]))
        value = copy.deepcopy(self.meta); value["networks"] = [v for v in value["networks"] if not v["name"].endswith("_egress")]
        with self.assertRaises(ValueError): dr.validate_metadata(value)

    def test_native_receipt_accepts_current_optional_package_version_after_update(self):
        receipt = {"module_id": "doska", "version": "2.46.2", "core_api": 1, "sha256": "f" * 64}
        dr.validate_module_receipt(receipt, "doska")
        dr.validate_module_receipt({**receipt, "package_version": "0.5.1-rc.1"}, "doska")
        for value in ({**receipt, "package_version": "../other"}, {**receipt, "package_version": True},
                      {**receipt, "arbitrary_override": "anything"}):
            with self.assertRaises(ValueError): dr.validate_module_receipt(value, "doska")

    def test_same_image_content_accepts_only_reference_aliases_without_mutating_role_registry(self):
        core = {"id": "sha256:" + "a" * 64, "architecture": "amd64", "recipe": "deploy/images/postgres.Dockerfile",
                "ref": "pl/core-db:0.5.1", "labels": {"pl.component": "postgresql"}}
        native = {"database": {**copy.deepcopy(core), "ref": "pl/core-db:0.5.0"}}
        for role, digit in (("api", "b"), ("web", "c")):
            native[role] = {"id": "sha256:" + digit * 64, "architecture": "amd64", "recipe": "deploy/images/doska.Dockerfile",
                            "ref": "pl/core-doska-" + role + ":0.5.1", "labels": {}}
        registry = {"doska": native}; before = copy.deepcopy(registry)
        upgrade = dr.helper("module-upgrade")
        result = dr.image_set({"images": {"db": core}}, registry, upgrade)
        self.assertEqual(len(result), 3)
        self.assertEqual(result[core["id"]], core)
        self.assertEqual(registry, before)
        for key, value in (("labels", {"pl.component": "different"}), ("architecture", "arm64"), ("recipe", "other.Dockerfile")):
            changed = copy.deepcopy(registry); changed["doska"]["database"][key] = value
            with self.assertRaisesRegex(ValueError, "Conflicting"): dr.image_set({"images": {"db": core}}, changed, upgrade)
        changed = copy.deepcopy(registry); changed["doska"]["database"]["ref"] = "https://untrusted/image"
        with self.assertRaisesRegex(ValueError, "reference"): dr.image_set({"images": {"db": core}}, changed, upgrade)

    def test_shared_noncore_alias_selection_is_stable_across_python_hash_seeds(self):
        program = """import importlib.util,json,sys
from pathlib import Path
p=Path(sys.argv[1]);s=importlib.util.spec_from_file_location('dr_seed_test',p);dr=importlib.util.module_from_spec(s);s.loader.exec_module(dr)
image={'id':'sha256:'+'a'*64,'architecture':'amd64','recipe':'Dockerfile','labels':{},'ref':'pl/z-shared:v1'}
registry={'xray':{**image,'ref':'pl/a-shared:v2'},'prometheus':image}
value=dr.image_set({'images':{}},registry,dr.helper('module-upgrade'))
print(value[image['id']]['ref'])
"""
        selected = []
        for seed in (0, 1, 8, 81):
            result = subprocess.run([sys.executable, "-c", program, str(BASE / "disaster-recovery.py")],
                capture_output=True, text=True, env={**os.environ, "PYTHONHASHSEED": str(seed)}, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            selected.append(result.stdout.strip())
        self.assertEqual(selected, ["pl/z-shared:v1"] * 4)

    def test_missing_stateful_volume_or_extra_foreign_name_is_not_a_full_backup(self):
        self.add_module("doska"); self.add_module("sftpgo"); self.build_backup()
        for modify in (lambda m: m["volumes"].pop(), lambda m: m["volumes"][0].update(name="foreign-data"),
                       lambda m: m["containers"][-1].update(name="foreign-container"),
                       lambda m: m["native"]["doska"]["instances"][0]["containers"].pop(),
                       lambda m: m["native"].update(unknown={"instances": []})):
            value = copy.deepcopy(self.meta); modify(value)
            with self.assertRaises(ValueError): dr.validate_metadata(value)

    def test_private_archive_round_trip_preserves_live_auth_native_bytes_modes_and_links(self):
        original = self.source / "private/live-auth-fixture"
        os.link(original, self.source / "private/hardlink")
        (self.source / "private/symlink").symlink_to("live-auth-fixture")
        output = self.build_backup()
        with dr.open_backup(output, dr.checksum(output), self.base) as (meta, folder):
            target = self.base / "readback"; target.mkdir(mode=0o700)
            dr.helper("delivery").restore_tree(folder / "installation.tar", target)
            dr.verify_tree(folder / "installation.tar", target)
            self.assertEqual((target / "private/live-auth-fixture").read_bytes(), self.secret)
            self.assertEqual((target / "private/live-auth-fixture").stat().st_mode & 0o777, 0o600)
            self.assertEqual((target / "private/hardlink").stat().st_ino, (target / "private/live-auth-fixture").stat().st_ino)
            self.assertTrue((target / "private/symlink").is_symlink())
            self.assertEqual(meta["backup_id"], self.meta["backup_id"])
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(NATIVE_XATTR, "Linux native xattr acceptance is separate on this Python build")
    def test_real_extended_attribute_round_trip(self):
        path = self.source / "private/live-auth-fixture"
        os.setxattr(path, "user.pl-recovery-test", b"preserved-attribute")
        self.tree_archive(self.payload / "attrs.tar", self.source)
        target = self.base / "attrs"; target.mkdir()
        dr.helper("delivery").restore_tree(self.payload / "attrs.tar", target)
        dr.verify_tree(self.payload / "attrs.tar", target)
        self.assertEqual(os.getxattr(target / "private/live-auth-fixture", "user.pl-recovery-test"), b"preserved-attribute")

    def test_wrong_whole_archive_hash_never_creates_a_target_or_calls_the_host(self):
        output = self.build_backup(); host = Mock()
        with self.assertRaisesRegex(ValueError, "SHA256"):
            dr.restore(self.root, self.installation, output, "0" * 64, host=host)
        self.assertFalse(self.root.exists()); self.assertEqual(host.mock_calls, [])

    def test_corrupt_inner_payload_is_rejected_even_with_a_new_outer_checksum(self):
        self.build_backup()
        (self.payload / "volume-0.tar").write_bytes(b"corruption")
        output = self.base / "corrupt.tar"; dr.seal_archive(output, self.meta, self.payload)
        with self.assertRaisesRegex(ValueError, "size|checksum"):
            with dr.open_backup(output, dr.checksum(output), self.base): pass

    def test_duplicate_json_keys_and_incomplete_payload_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"): dr.load_json(b'{"schema":1,"schema":2}')
        self.build_backup(); self.meta["files"].pop("volume-0.tar")
        with self.assertRaisesRegex(ValueError, "payload set"): dr.validate_metadata(self.meta)

    def test_tree_rejects_traversal_external_symlink_special_and_duplicate_entries(self):
        cases = [("../escape", tarfile.REGTYPE, ""), ("absolute", tarfile.SYMTYPE, "/etc/passwd"),
                 ("escape", tarfile.SYMTYPE, "../outside"), ("socket", tarfile.FIFOTYPE, ""),
                 ("hard", tarfile.LNKTYPE, "../outside")]
        for index, (name, kind, link) in enumerate(cases):
            path = self.base / (str(index) + ".tar")
            with tarfile.open(path, "w") as archive:
                member = tarfile.TarInfo(name); member.type = kind; member.linkname = link
                archive.addfile(member)
            with self.subTest(name=name), self.assertRaises(ValueError): dr.validate_tree_archive(path)
        path = self.base / "duplicates.tar"
        with tarfile.open(path, "w") as archive:
            archive.addfile(tarfile.TarInfo("same")); archive.addfile(tarfile.TarInfo("./same"))
        with self.assertRaises(ValueError): dr.validate_tree_archive(path)

    def test_tar_cannot_traverse_an_archive_created_directory_symlink(self):
        path = self.base / "through-link.tar"
        with tarfile.open(path, "w") as archive:
            member = tarfile.TarInfo("link"); member.type = tarfile.SYMTYPE; member.linkname = "other"
            archive.addfile(member); archive.addfile(tarfile.TarInfo("link/child"))
        with self.assertRaisesRegex(ValueError, "traverses"): dr.validate_tree_archive(path)

    def test_output_collision_never_replaces_existing_file(self):
        output = self.build_backup(); before = output.read_bytes()
        with self.assertRaises(FileExistsError): dr.seal_archive(output, self.meta, self.payload)
        self.assertEqual(output.read_bytes(), before)
        self.assertFalse(list(self.base.glob("*.partial.*")))

    def test_nonprivate_input_is_rejected_and_staging_is_removed_on_failure(self):
        output = self.build_backup(); output.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private"):
            with dr.open_backup(output, dr.checksum(output), self.base): pass
        self.assertFalse(list(self.base.glob("pl-dr-input-*")))

    def test_disk_space_failure_precedes_input_copy(self):
        output = self.build_backup()
        with patch.object(dr.shutil, "disk_usage", return_value=types.SimpleNamespace(free=0)), self.assertRaisesRegex(ValueError, "space"):
            with dr.open_backup(output, dr.checksum(output), self.base): pass
        self.assertFalse(list(self.base.glob("pl-dr-input-*")))

    def test_real_competing_subprocess_is_busy_and_lock_is_available_after_exit(self):
        path = self.base / "operation.lock"
        program = "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.read()"
        process = subprocess.Popen([sys.executable, "-c", program, str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "ready"); path.chmod(0o600)
            with self.assertRaisesRegex(ValueError, "busy"):
                with dr.lock(path): self.fail("concurrent lock admitted")
        finally:
            process.communicate(timeout=10)
        with dr.lock(path): pass

    def test_symlink_lock_cannot_redirect_a_write(self):
        outside = self.base / "outside"; outside.write_bytes(b"preserve")
        link = self.base / "barrier"; link.symlink_to(outside)
        with self.assertRaises((OSError, ValueError)):
            with dr.lock(link): pass
        self.assertEqual(outside.read_bytes(), b"preserve")

    def test_foreign_existing_resource_with_matching_labels_is_not_adopted(self):
        recovery = self.recovery()
        spec = self.meta["containers"][0]
        foreign = {"Id": "f" * 64, "Name": "/" + spec["name"], "Image": spec["image"],
                   "Config": {"Labels": {"pl.installation": self.installation}}}
        recovery.host.inspect_all.side_effect = lambda kind: [foreign] if kind == "container" else []
        with self.assertRaisesRegex(ValueError, "unproved"): recovery.preflight_target()
        recovery.host.docker.assert_not_called(); recovery.host.run.assert_not_called()
        recovery.operation["created"]["container"][spec["name"]] = {"id": "0" * 64, "image": spec["image"], "name": spec["name"]}
        with self.assertRaisesRegex(ValueError, "unproved"): recovery.preflight_target()

    def test_precommit_start_is_refused_before_any_daemon_call(self):
        recovery = self.recovery()
        for command in (("container", "start", "anything"), ("run", "--rm", "anything"), ("container", "run", "anything")):
            with self.assertRaisesRegex(ValueError, "cannot start"): recovery.native_docker(*command)
        recovery.host.docker.assert_not_called()

    def test_unplanned_native_create_is_refused_before_any_daemon_call(self):
        recovery = self.recovery()
        with self.assertRaisesRegex(ValueError, "unplanned"):
            recovery.native_docker("container", "create", "--name", "foreign", "image")
        recovery.host.docker.assert_not_called()

    def test_created_container_id_is_recorded_before_returning_to_native_inspector(self):
        self.add_module("doska"); recovery = self.recovery()
        spec = next(v for v in self.meta["containers"] if not v["core"])
        obj = {"Id": "8" * 64, "Name": "/" + spec["name"], "Image": spec["image"], "State": {"Running": False}}
        recovery.host.docker.side_effect = [obj["Id"].encode(), dr.encoded([obj])]
        recovery.native_docker("container", "create", "--name", spec["name"], spec["image"])
        persisted = dr.load_json(recovery.journal.read_bytes())
        self.assertEqual(persisted["created"]["container"][spec["name"]]["id"], obj["Id"])

    def oom_contract_fixture(self):
        spec = self.meta["containers"][0]
        original = {"Id": "1" * 64, "Name": "/" + spec["name"], "Image": spec["image"],
            "State": {"Status": "exited", "Running": False, "StartedAt": "2026-11-05T23:00:00Z"},
            "Config": {"Hostname": "1" * 12, "Image": spec["image"], "Env": ["TEST=fixture"],
                       "Labels": {"com.docker.compose.project": self.installation, "com.docker.compose.service": "db"}},
            "HostConfig": {"OomKillDisable": None, "Memory": 64 * 1024**2, "ReadonlyRootfs": True, "CapDrop": ["ALL"]},
            "NetworkSettings": {"Networks": {}}, "Mounts": []}
        spec["contract"] = dr.container_contract(original)
        created = copy.deepcopy(original)
        created.update(Id="2" * 64, State={"Status": "created", "Running": False, "StartedAt": "0001-01-01T00:00:00Z"})
        created["Config"]["Hostname"] = "2" * 12
        created["HostConfig"]["OomKillDisable"] = False
        return spec, original, created

    def test_native_default_oom_null_source_accepts_false_created_container(self):
        recovery = self.recovery()
        spec, original, created = self.oom_contract_fixture()
        source_before, target_before = copy.deepcopy(original), copy.deepcopy(created)
        self.assertEqual(spec["contract"], "4a45166e5fb88763b00bdd2d47638e4924499b6364e35e177815263f6592cbd1")
        self.assertEqual(dr.container_contract(created), spec["contract"])
        recovery.remember_container(created, spec)
        persisted = dr.load_json(recovery.journal.read_bytes())
        self.assertEqual(persisted["created"]["container"][spec["name"]]["id"], created["Id"])
        self.assertEqual(original, source_before)
        self.assertEqual(created, target_before)

    def test_oom_default_equivalence_keeps_true_and_other_contract_drift_strict(self):
        recovery = self.recovery()
        spec, _, created = self.oom_contract_fixture()
        for field, value in (("OomKillDisable", True), ("Memory", 128 * 1024**2),
                             ("ReadonlyRootfs", False), ("CapDrop", [])):
            with self.subTest(field=field):
                changed = copy.deepcopy(created)
                changed["HostConfig"][field] = value
                with self.assertRaisesRegex(ValueError, "closed preserved recipe"):
                    recovery.remember_container(changed, spec)
        self.assertEqual(recovery.operation["created"]["container"], {})

        numeric = copy.deepcopy(created)
        numeric["HostConfig"]["OomKillDisable"] = 0
        self.assertNotEqual(dr.container_contract(numeric), spec["contract"])

    def mount_contract_fixture(self, count=2):
        spec, original, created = self.oom_contract_fixture()
        mounts = [{"Type": "bind", "Source": "/fixture/" + chr(97 + i), "Target": "/run/pl-" + chr(97 + i),
                   "ReadOnly": True, "BindOptions": {"Propagation": "rprivate"}} for i in reversed(range(count))]
        original["HostConfig"]["Mounts"] = copy.deepcopy(mounts)
        created["HostConfig"]["Mounts"] = copy.deepcopy(list(reversed(mounts)))
        physical = [{"Type": "bind", "Source": v["Source"], "Destination": v["Target"],
                     "Mode": "", "RW": False, "Propagation": "rprivate"} for v in mounts]
        original["Mounts"], created["Mounts"] = copy.deepcopy(physical), copy.deepcopy(physical)
        spec["contract"] = dr.container_contract(original)
        return spec, original, created

    def test_v2_mount_order_is_canonical_and_never_uses_legacy_permutations(self):
        recovery = self.recovery(); recovery.meta["contract_version"] = 2
        spec, original, created = self.mount_contract_fixture()
        before = copy.deepcopy(created)
        self.assertEqual(dr.container_contract(created), spec["contract"])
        with patch("itertools.permutations", side_effect=AssertionError("v2 must not enumerate legacy order")):
            recovery.remember_container(created, spec)
        self.assertEqual(created, before)
        self.assertEqual(original["HostConfig"]["Mounts"][0]["Target"], "/run/pl-b")

    def test_v2_mount_fields_and_duplicate_or_invalid_targets_remain_strict(self):
        recovery = self.recovery(); recovery.meta["contract_version"] = 2
        spec, _, created = self.mount_contract_fixture()
        for field, value in (("Source", "/foreign"), ("Target", "/foreign"), ("ReadOnly", False),
                             ("BindOptions", {"Propagation": "shared"})):
            with self.subTest(field=field):
                changed = copy.deepcopy(created); changed["HostConfig"]["Mounts"][0][field] = value
                with self.assertRaisesRegex(ValueError, "closed preserved recipe"):
                    recovery.remember_container(changed, spec)
        for field, value in (("Source", "/foreign"), ("Destination", "/foreign"), ("RW", True), ("Propagation", "shared")):
            changed = copy.deepcopy(created); changed["Mounts"][0][field] = value
            with self.assertRaisesRegex(ValueError, "closed preserved recipe"):
                recovery.remember_container(changed, spec)
        for target in (None, "", "relative", "//run/pl-a", "/run/../foreign", "/run/pl-b"):
            with self.subTest(target=target):
                changed = copy.deepcopy(created); changed["HostConfig"]["Mounts"][0]["Target"] = target
                with self.assertRaisesRegex(ValueError, "mount target"):
                    dr.container_contract(changed)
        self.assertEqual(recovery.operation["created"]["container"], {})

    def test_legacy_beta_mount_order_accepts_only_the_same_records(self):
        recovery = self.recovery()
        spec, _, created = self.mount_contract_fixture()
        spec["contract"] = "6d96ec8b64d446c82f447ab8f042697a2df8dbd26a98a1ce9b2b02a6a68f79d8"
        for version, marker in (("0.5.1", None), ("0.5.2", 1)):
            recovery.meta["version"] = version
            if marker is None: recovery.meta.pop("contract_version", None)
            else: recovery.meta["contract_version"] = marker
            recovery.remember_container(created, spec)
        for kind, field, value in (("HostConfig", "OomKillDisable", True), ("HostConfig", "OomKillDisable", 0),
                                   ("declaration", "Source", "/foreign"), ("declaration", "ReadOnly", False),
                                   ("physical", "RW", True)):
            changed = copy.deepcopy(created)
            if kind == "declaration": changed["HostConfig"]["Mounts"][0][field] = value
            elif kind == "physical": changed["Mounts"][0][field] = value
            else: changed["HostConfig"][field] = value
            with self.assertRaisesRegex(ValueError, "closed preserved recipe"):
                recovery.remember_container(changed, spec)

    def test_legacy_beta_mount_verification_is_bounded_at_six_records(self):
        recovery = self.recovery()
        spec, _, created = self.mount_contract_fixture(6)
        spec["contract"] = "04ad703c7410e4d972bf171c0a1f06cc07b36880217ce86af69b9d9977272af9"
        original_permutations, seen = itertools.permutations, []
        def counted(values):
            for value in original_permutations(values):
                seen.append(1)
                yield value
        with patch("itertools.permutations", side_effect=counted): recovery.remember_container(created, spec)
        self.assertEqual(len(seen), 720)
        created["HostConfig"]["Mounts"].append({"Type": "bind", "Source": "/fixture/g", "Target": "/run/pl-g", "ReadOnly": True})
        with patch("itertools.permutations", side_effect=AssertionError("over-limit order must be refused")):
            with self.assertRaisesRegex(ValueError, "Legacy.*six"):
                recovery.remember_container(created, spec)
        recovery.meta["contract_version"] = 2
        spec, _, created = self.mount_contract_fixture(7)
        with patch("itertools.permutations", side_effect=AssertionError("v2 has no legacy permutation path")):
            recovery.remember_container(created, spec)

    def bind_contract_fixture(self, bind_count=2, mount_count=5):
        spec, original, created = self.mount_contract_fixture(mount_count)
        binds = ["pl-fixture-" + str(i) + ":/var/pl-bind-" + str(i) + ":rw" for i in reversed(range(bind_count))]
        original["HostConfig"]["Binds"] = copy.deepcopy(binds)
        created["HostConfig"]["Binds"] = copy.deepcopy(list(reversed(binds)))
        for obj in (original, created):
            obj["Mounts"] += [{"Type": "volume", "Name": "pl-fixture-" + str(i),
                "Source": "/var/lib/docker/volumes/pl-fixture-" + str(i) + "/_data",
                "Destination": "/var/pl-bind-" + str(i), "Driver": "local", "Mode": "rw", "RW": True,
                "Propagation": ""} for i in range(bind_count)]
        spec["contract"] = dr.container_contract(original)
        return spec, original, created

    def test_v2_binds_and_mounts_order_are_canonical_without_legacy_enumeration(self):
        recovery = self.recovery(); recovery.meta["contract_version"] = 2
        spec, original, created = self.bind_contract_fixture()
        source_before, target_before = copy.deepcopy(original), copy.deepcopy(created)
        self.assertEqual(dr.container_contract(created), spec["contract"])
        with patch("itertools.permutations", side_effect=AssertionError("v2 must not enumerate")):
            recovery.remember_container(created, spec)
        self.assertEqual(original, source_before); self.assertEqual(created, target_before)

    def test_binds_sources_modes_and_destinations_remain_strict(self):
        spec, original, created = self.bind_contract_fixture()
        legacy = hashlib.sha256(dr.encoded(dr._container_projection(original, canonical_mount_order=False))).hexdigest()
        for version, expected in ((1, legacy), (2, spec["contract"])):
            for value in ("foreign:/var/pl-bind-0:rw", "pl-fixture-0:/var/pl-bind-0:ro",
                          "pl-fixture-0:/var/pl-foreign:rw", "pl-fixture-0:/var/pl-bind-0:rw,shared"):
                with self.subTest(version=version, value=value):
                    changed = copy.deepcopy(created); changed["HostConfig"]["Binds"][0] = value
                    self.assertFalse(dr.container_contract_matches(changed, expected, {"version": "0.5.1", "contract_version": version}))
            for value in (True, 0):
                changed = copy.deepcopy(created); changed["HostConfig"]["OomKillDisable"] = value
                self.assertFalse(dr.container_contract_matches(changed, expected, {"version": "0.5.1", "contract_version": version}))
        for binds in ("not-a-list", [None], [""], ["missing-target"], ["source:relative:rw"],
                      ["source://var/pl-bind-0:rw"], ["source:/var/../foreign:rw"],
                      ["source:/var/pl-bind-0:rw", "other:/var/pl-bind-0:ro"], ["source:/run/pl-a:ro"]):
            with self.subTest(binds=binds):
                changed = copy.deepcopy(created); changed["HostConfig"]["Binds"] = binds
                with self.assertRaisesRegex(ValueError, "mount target|bind"):
                    dr.container_contract(changed)

    def test_legacy_binds_and_mounts_permutations_share_one_720_order_budget(self):
        spec, original, created = self.bind_contract_fixture(3, 5)
        # Frozen pre-canonical beta digest: reverse-ordered full declarations,
        # including the original null OOM representation, without dropping fields.
        expected = "119df6f03c24609e148f27e702929108358ceacb983e4ea5c54c90c11a7404c0"
        self.assertEqual(hashlib.sha256(dr.encoded(dr._container_projection(original, canonical_mount_order=False))).hexdigest(), expected)
        real_sha256, seen = hashlib.sha256, []
        def counted(*args, **kwargs):
            seen.append(1)
            return real_sha256(*args, **kwargs)
        with patch.object(dr.hashlib, "sha256", side_effect=counted):
            self.assertTrue(dr.container_contract_matches(created, expected, {"version": "0.5.1"}))
        self.assertLessEqual(len(seen), 1440)
        self.assertGreater(len(seen), 720)
        for bind_count, mount_count in ((3, 6), (6, 2), (7, 0)):
            _, _, changed = self.bind_contract_fixture(bind_count, mount_count)
            with self.subTest(binds=bind_count, mounts=mount_count):
                with patch("itertools.permutations", side_effect=AssertionError("budget must be checked before enumeration")):
                    with self.assertRaisesRegex(ValueError, "Legacy"):
                        dr.container_contract_matches(changed, expected, {"version": "0.5.2", "contract_version": 1})

    def test_v2_larger_binds_and_mounts_have_no_legacy_budget_or_enumeration(self):
        spec, original, created = self.bind_contract_fixture(7, 7)
        with patch("itertools.permutations", side_effect=AssertionError("v2 must not enumerate")):
            self.assertTrue(dr.container_contract_matches(created, spec["contract"], {"contract_version": 2}))

    def dns_daemon_fixtures(self):
        # Shapes and nil/empty defaults observed on the eight never-started
        # native containers before and after a real Docker 29 daemon restart.
        shapes = (("core-api", 2, 5, True), ("core-db", 1, 0, True), ("core-web", 0, 4, True),
                  ("doska-api", 0, 6, False), ("doska-database", 0, 2, False),
                  ("doska-web", 0, 0, False), ("sftpgo", 0, 3, False), ("prometheus", 0, 2, False))
        for name, binds, mounts, core in shapes:
            _, source, before = self.bind_contract_fixture(binds, mounts)
            for obj in (source, before):
                obj["Name"] = "/fixture-" + name
                obj["Config"]["Labels"]["fixture.role"] = name
                obj["HostConfig"].update(Dns=None, DnsOptions=None if core else [], DnsSearch=None if core else [])
            after = copy.deepcopy(before)
            after["HostConfig"].update(Dns=[], DnsOptions=[], DnsSearch=[])
            yield name, source, before, after

    def test_daemon_restart_empty_dns_defaults_match_all_eight_preserved_roles(self):
        legacy = {
            'core-api': '14bfdb91eba24d09b3bfb20a19571ea52e6db3d5a4a65b1943bc96a4ed4641c3',
            'core-db': '90eee9bada50f83ac004cd2baa3cc60732b4a301c6f025ea2fa5fea2d0acb6da',
            'core-web': '04a29c8459083db055156d3e1566b1ce75958f4c7d721b5eb0baea6518347fa6',
            'doska-api': '7d1cbd7aebb2cc25efddde558c2b965e1e46253c3e242f6fdc6d0f3a58744995',
            'doska-database': '8404f33c13477f0cf3e788d907e15d5ad744a0ab4eec5bc05cf29fa21a2177a2',
            'doska-web': '2fee3289969def804b6bf24ab088e6045c4cdebe610ee56aef66d60c74efb5ed',
            'sftpgo': 'fbe19245456d2e03df9560021ab336077724b6e370f120443cfb786dbb883753',
            'prometheus': '4a1132d273da2491fe3d50ff5f705c4b8e0f6fe66d49615d0c059e6f9c36a385',
        }
        for name, source, before, after in self.dns_daemon_fixtures():
            with self.subTest(role=name):
                original = copy.deepcopy((source, before, after))
                expected = dr.container_contract(source)
                self.assertEqual(dr.container_contract(before), expected)
                self.assertEqual(dr.container_contract(after), expected)
                with patch("itertools.permutations", side_effect=AssertionError("v2 must not enumerate")), \
                     patch("itertools.product", side_effect=AssertionError("v2 must not enumerate DNS defaults")):
                    self.assertTrue(dr.container_contract_matches(after, expected, {"contract_version": 2}))
                for version in ("0.5.1", "0.5.2"):
                    self.assertTrue(dr.container_contract_matches(before, legacy[name], {"version": version}))
                    self.assertTrue(dr.container_contract_matches(after, legacy[name], {"version": version}))
                self.assertEqual((source, before, after), original)

    def test_dns_nonempty_order_values_wrong_types_and_missing_fields_are_strict(self):
        _, source, created = self.bind_contract_fixture(0, 0)
        source["HostConfig"].update(Dns=None, DnsOptions=None, DnsSearch=None)
        created["HostConfig"].update(Dns=[], DnsOptions=[], DnsSearch=[])
        expected = dr.container_contract(source)
        for field, values in (("Dns", ["192.0.2.53", "192.0.2.54"]),
                              ("DnsOptions", ["ndots:0", "timeout:1"]),
                              ("DnsSearch", ["one.example.test", "two.example.test"])):
            for value in (values, False, 0, "", {}, "default"):
                with self.subTest(field=field, value=value):
                    changed = copy.deepcopy(created); changed["HostConfig"][field] = value
                    for metadata in ({"contract_version": 2}, {"version": "0.5.1"}):
                        self.assertFalse(dr.container_contract_matches(changed, expected, metadata))
            missing = copy.deepcopy(source); del missing["HostConfig"][field]
            self.assertNotIn(field, dr._container_projection(missing)["host"])
            for metadata in ({"contract_version": 2}, {"version": "0.5.1"}):
                self.assertFalse(dr.container_contract_matches(missing, expected, metadata))
            custom = copy.deepcopy(source); custom["HostConfig"][field] = values
            custom_digest = dr.container_contract(custom)
            self.assertEqual(dr._container_projection(custom)["host"][field], values)
            for value in (list(reversed(values)), values[:-1], None, []):
                changed = copy.deepcopy(custom); changed["HostConfig"][field] = value
                for metadata in ({"contract_version": 2}, {"version": "0.5.2"}):
                    self.assertFalse(dr.container_contract_matches(changed, custom_digest, metadata))

    def test_legacy_dns_defaults_have_an_explicit_11520_total_digest_budget(self):
        _, source, created = self.bind_contract_fixture(3, 5)
        source["HostConfig"].update(Dns=[], DnsOptions=[], DnsSearch=[])
        created["HostConfig"].update(Dns=None, DnsOptions=None, DnsSearch=None)
        # Frozen raw beta digest: last mount order, false OOM and all three
        # empty DNS arrays. Reaching it requires the entire finite search.
        expected = "a890f5d227e01889d5c83242368025f79a491f466833d00007c1cd31260e734b"
        real_sha256, seen = hashlib.sha256, []
        def counted(*args, **kwargs):
            seen.append(1)
            return real_sha256(*args, **kwargs)
        with patch.object(dr.hashlib, "sha256", side_effect=counted):
            self.assertTrue(dr.container_contract_matches(created, expected, {"version": "0.5.1"}))
        self.assertEqual(len(seen), 11520)
        _, _, over = self.bind_contract_fixture(3, 6)
        over["HostConfig"].update(Dns=None, DnsOptions=None, DnsSearch=None)
        with patch("itertools.permutations", side_effect=AssertionError("check bound before enumeration")), \
             patch("itertools.product", side_effect=AssertionError("check bound before DNS enumeration")):
            with self.assertRaisesRegex(ValueError, "Legacy"):
                dr.container_contract_matches(over, expected, {"version": "0.5.2"})

    def test_v2_dns_defaults_keep_absent_fields_and_large_recipes_without_enumeration(self):
        _, source, created = self.bind_contract_fixture(7, 7)
        source["HostConfig"].update(Dns=None, DnsOptions=None)
        created["HostConfig"].update(Dns=[], DnsOptions=[])
        self.assertNotIn("DnsSearch", source["HostConfig"])
        with patch("itertools.permutations", side_effect=AssertionError("v2 has no permutation path")), \
             patch("itertools.product", side_effect=AssertionError("v2 has no DNS enumeration path")):
            self.assertTrue(dr.container_contract_matches(created, dr.container_contract(source), {"contract_version": 2}))
        self.assertNotIn("DnsSearch", dr._container_projection(created)["host"])

    def test_metadata_contract_version_is_explicit_for_new_and_finite_for_legacy(self):
        self.build_backup()
        dr.validate_metadata({**self.meta, "contract_version": 2, "version": "0.5.3"})
        for marker in (True, False, 0, 3, "2"):
            with self.assertRaises(ValueError): dr.validate_metadata({**self.meta, "contract_version": marker})
        for version in ("0.5.0", "0.5.3", "0.5.2-rc.1"):
            with self.assertRaisesRegex(ValueError, "Legacy"):
                dr.validate_metadata({**self.meta, "version": version})
        for version in ("0.5.1", "0.5.2"):
            dr.validate_metadata({**self.meta, "version": version, "contract_version": 1})

    def test_foreign_volume_consumer_is_refused_before_any_import(self):
        recovery = self.recovery()
        foreign = {"Id": "1" * 64, "Name": "/foreign", "Config": {"Labels": {}},
                   "Mounts": [{"Type": "volume", "Name": self.meta["volumes"][0]["name"]}]}
        recovery.host.inspect_all.side_effect = lambda kind: [foreign] if kind == "container" else []
        with self.assertRaisesRegex(ValueError, "foreign container"): recovery.preflight_target()
        recovery.host.docker.assert_not_called(); recovery.host.run.assert_not_called()

    def test_native_recipe_cannot_create_untracked_volumes_or_remove_anything(self):
        recovery = self.recovery()
        for command in (("volume", "create", "surprise"), ("volume", "rm", "foreign"), ("container", "rm", "foreign"),
                        ("network", "create", "surprise"), ("container", "exec", "foreign", "anything")):
            with self.assertRaises(ValueError): recovery.native_docker(*command)
        recovery.host.docker.assert_not_called()

    def test_real_doska_recipe_recreates_stopped_roles_and_preserves_private_files_and_data(self):
        from test_module_upgrade import NativeRebuildTests
        fixture = NativeRebuildTests("test_two_instances_replace_only_application_images_preserve_all_data_and_disabled_state")
        fixture.setUp(); self.addCleanup(fixture.doCleanups)
        instance = fixture.instances[0]
        source = [copy.deepcopy(fixture.containers[fixture.controller.name(instance, "-" + role)])
                  for role in ("database", "api", "web")]
        before_files, before_data = fixture.native_files(), copy.deepcopy(fixture.userdata)
        recovery = self.recovery()
        def engine(*args, **kwargs):
            output = fixture.docker(*args, **kwargs)
            if args[:2] == ("container", "create"):
                fixture.containers[args[args.index("--name") + 1]]["State"]["StartedAt"] = "0001-01-01T00:00:00Z"
            return output
        recovery.host.docker = engine
        specs = []
        for obj in source:
            name = obj["Name"][1:]
            spec = {"name": name, "core": False, "image": obj["Image"], "contract": dr.container_contract(obj)}
            specs.append(spec); self.meta["containers"].append(spec)
            del fixture.containers[name]
        fixture.calls.clear(); fixture.controller.docker = recovery.native_docker
        for role, spec in zip(("database", "api", "web"), specs):
            fixture.controller.create_container(instance, role)
            recovery.remember_container(fixture.containers[spec["name"]], spec)
        self.assertEqual(fixture.native_files(), before_files)
        self.assertEqual(fixture.userdata, before_data)
        self.assertEqual(len(recovery.operation["created"]["container"]), 3)
        self.assertTrue(all(not fixture.containers[v["name"]]["State"]["Running"] for v in specs))
        self.assertFalse(any(v[:2] in (("container", "start"), ("container", "rm")) for v in fixture.calls))

    def test_session_revocation_and_live_key_verification_precede_api_and_web_start(self):
        self.exercise_auth_resume(changed_after_publish=False)

    def test_forward_resume_preserves_a_password_changed_after_initial_session_revocation(self):
        self.exercise_auth_resume(changed_after_publish=True)

    def test_resume_preserves_a_valid_pinned_catalog_without_fresh_install_policy(self):
        self.exercise_auth_resume(changed_after_publish=True, pinned_channel=True)

    def test_icmp_recovery_uses_the_existing_maintenance_command_runner(self):
        self.exercise_auth_resume(changed_after_publish=True, pinned_channel=True, icmp_enabled=True)

    def exercise_auth_resume(self, *, changed_after_publish, pinned_channel=False, icmp_enabled=False):
        recovery = self.recovery(); recovery.write(committed=True)
        events, running = [], set()
        for value in self.meta["containers"]:
            recovery.operation["created"]["container"][value["name"]] = {"name": value["name"], "id": value["id"], "image": value["image"]}
        auth = {"phc": "changed-live-password-hash", "password_change_required": False}
        self.meta["live_auth_sha256"] = hashlib.sha256(dr.encoded(auth)).hexdigest()
        if changed_after_publish:
            auth["phc"] = "new-authorized-password-after-publish"
            recovery.write(sessions_revoked=True)
        def docker(*args, **kwargs):
            spec = next(v for v in self.meta["containers"] if v["id"] == args[-1])
            if args[:2] == ("container", "start"):
                self.assertTrue(dr.load_json(recovery.journal.read_bytes())["committed"])
                if spec["service"] in ("api", "web") and not changed_after_publish: self.assertIn("revoke", events)
                events.append("start-" + spec["service"]); running.add(spec["id"]); return b""
            return dr.encoded([{"Id": spec["id"], "Image": spec["image"], "Name": "/" + spec["name"], "State": {"Running": spec["id"] in running}}])
        recovery.host.docker = docker
        def sql(query):
            if "DELETE FROM sessions" in query: events.append("revoke"); return b""
            return b"0"
        rt = types.SimpleNamespace(schema=self.meta["schema_contract"], package=self.base, install_id=self.installation,
            m={"features": {}}, state={"config": {}}, validate_runtime=lambda: events.append("schema"), read_auth=lambda: auth,
            verify_connector_credentials=lambda: events.append("decrypt"), sql=sql, run=Mock(return_value=b""))
        modules = {"maintenance": types.SimpleNamespace(Runtime=lambda root: rt),
                   "bootstrap": types.SimpleNamespace(Runtime=lambda *args: types.SimpleNamespace(), prepare_module_controller=lambda rt: events.append("controller")),
                   "module-controller": types.SimpleNamespace(Controller=lambda *args: object()),
                   "delivery": types.SimpleNamespace(Delivery=lambda *args: types.SimpleNamespace(wait_readiness=lambda: events.append("ready"))),
                   "module-upgrade": types.SimpleNamespace()}
        if pinned_channel:
            modules["bootstrap"].prepare_module_controller = Mock(side_effect=ValueError("Delivery configuration differs from the trusted release channel"))
        if icmp_enabled:
            rt.m["features"]["icmp_probe"] = True
            policy = {"mode": "interactive", "cidrs": []}
            modules["bootstrap"].icmp_policy = Mock(return_value=policy)
            def prepare(root, package, installation, selected_policy, gid, run):
                self.assertIs(run, rt.run)
                self.assertEqual((root, package, installation, selected_policy, gid),
                                 (self.root, rt.package, self.installation, policy, self.meta["marker"]["gid"]))
                run(["systemctl", "daemon-reload"], timeout=30)
                events.append("icmp")
            modules["bootstrap"].icmp_installer = Mock(return_value=types.SimpleNamespace(prepare=prepare))
        recovery.activate_controller = Mock(side_effect=lambda: events.append("controller"))
        recovery.wait_private_api = Mock(return_value="172.31.252.2")
        recovery.start_relay = Mock(side_effect=lambda address: events.append("relay"))
        with patch.object(dr, "helper", side_effect=modules.__getitem__): recovery.resume_committed()
        if changed_after_publish:
            self.assertNotIn("revoke", events)
            self.assertEqual(auth["phc"], "new-authorized-password-after-publish")
        else:
            self.assertLess(events.index("decrypt"), events.index("revoke"))
            self.assertLess(events.index("revoke"), events.index("start-api"))
            self.assertLess(events.index("revoke"), events.index("relay"))
        self.assertNotIn("start-web", events)
        self.assertEqual(recovery.operation["phase"], "runtime_ready")
        self.assertTrue(recovery.operation["sessions_revoked"])
        if icmp_enabled:
            rt.run.assert_called_once_with(["systemctl", "daemon-reload"], timeout=30)
            self.assertLess(events.index("controller"), events.index("icmp"))
            self.assertLess(events.index("icmp"), events.index("start-api"))

    def controller_activation_fixture(self, *, existing_unit=True):
        recovery = self.recovery(); recovery.write(committed=True, sessions_revoked=True)
        for name in ("private", "config", "run", "run/module-controller"):
            p = self.root / name; p.mkdir(mode=0o750 if name.startswith("run") else 0o700, exist_ok=True)
        os.chown(self.root / "run/module-controller", -1, self.meta["marker"]["gid"])
        source = self.payload / "root"; source.mkdir(mode=0o700)
        data = {"state/controller-active.json": dr.encoded({"schema": 1, "version": self.meta["version"]}),
                "state/controller-supervisor.json": dr.encoded({"schema": 1, "version": self.meta["supervisor_version"]}),
                "private/module-images.json": dr.encoded(self.meta["registry"]),
                "private/module-controller-key": b"k" * 32,
                "config/delivery.json": dr.encoded({"schema": 1, "catalog_url": "https://github.com/Sauke5/pl/releases/download/v0.5.1/catalog.json"})}
        for name, body in data.items():
            for base in (self.root, source):
                p = base / name; p.parent.mkdir(mode=0o700, parents=True, exist_ok=True); p.write_bytes(body)
                p.chmod(0o640 if name.endswith("-key") else 0o600)
                if name.endswith("-key"): os.chown(p, -1, self.meta["marker"]["gid"])
        units = self.base / "systemd"; units.mkdir(mode=0o755)
        self.enterContext(patch.object(dr, "SYSTEMD_UNITS", units, create=True))
        unit = units / (self.installation + "-module-controller.service")
        if existing_unit: unit.write_bytes(dr.unit_payload(self.root, self.meta["supervisor_version"])); unit.chmod(0o644)
        properties = {"LoadState": "loaded" if existing_unit else "not-found", "FragmentPath": str(unit) if existing_unit else "",
                      "DropInPaths": "", "MainPID": "0", "ActiveState": "inactive", "UnitFileState": "disabled" if existing_unit else ""}
        calls = []
        def run(args, **kwargs):
            calls.append(list(args))
            if args == ["systemctl", "show", "--property=UnitPath", "--value"]: return str(units).encode()
            if args[:2] == ["systemctl", "show"]:
                return ("\n".join(key + "=" + value for key, value in properties.items()) + "\n").encode()
            if args[:3] == ["systemctl", "enable", "--now"]:
                properties.update(LoadState="loaded", FragmentPath=str(unit), MainPID=str(os.getpid()), ActiveState="active", UnitFileState="enabled")
            return b""
        recovery.host.run = Mock(side_effect=run)
        self.enterContext(patch.object(dr, "validate_package_tree", return_value=({}, {})))
        return recovery, unit, source, properties, calls, tuple(data)

    def test_controller_activation_preserves_pinned_config_keys_registry_pointers_and_existing_unit(self):
        recovery, unit, source, properties, calls, names = self.controller_activation_fixture()
        before = {name: ((self.root / name).read_bytes(), (self.root / name).stat().st_ino) for name in names}
        inode = unit.stat().st_ino
        with patch.object(recovery, "controller_socket_ready", return_value=True, create=True): recovery.activate_controller()
        self.assertEqual(before, {name: ((self.root / name).read_bytes(), (self.root / name).stat().st_ino) for name in names})
        self.assertEqual(unit.stat().st_ino, inode)
        self.assertEqual(unit.read_bytes(), dr.unit_payload(self.root, self.meta["supervisor_version"]))
        self.assertIn(["systemctl", "daemon-reload"], calls)
        self.assertIn(["systemctl", "enable", "--now", unit.name], calls)
        self.assertIn(["systemctl", "is-active", "--quiet", unit.name], calls)

    def test_forward_controller_activation_keeps_current_valid_delivery_configuration(self):
        recovery, unit, source, properties, calls, names = self.controller_activation_fixture()
        path = self.root / "config/delivery.json"
        current = dr.encoded({"schema": 1, "catalog_url": "https://github.com/Sauke5/pl/releases/download/v0.5.2/catalog.json"})
        path.write_bytes(current); inode = path.stat().st_ino
        self.assertNotEqual(path.read_bytes(), (source / "config/delivery.json").read_bytes())
        with patch.object(recovery, "controller_socket_ready", return_value=True, create=True): recovery.activate_controller()
        self.assertEqual(path.read_bytes(), current); self.assertEqual(path.stat().st_ino, inode)

    @unittest.skipUnless(sys.platform == "linux", "Atomic Linux systemd unit publication requires native Linux")
    def test_new_controller_unit_is_published_atomically_without_replacing_a_foreign_path(self):
        recovery, unit, source, properties, calls, names = self.controller_activation_fixture(existing_unit=False)
        with patch.object(recovery, "controller_socket_ready", return_value=True, create=True): recovery.activate_controller()
        self.assertEqual(unit.read_bytes(), dr.unit_payload(self.root, self.meta["supervisor_version"]))
        self.assertEqual(unit.stat().st_mode & 0o777, 0o644)
        before = (unit.read_bytes(), unit.stat().st_ino)
        with self.assertRaises(FileExistsError): dr.publish_unit(unit, b"foreign replacement")
        self.assertEqual((unit.read_bytes(), unit.stat().st_ino), before)

    def test_controller_activation_refuses_foreign_unit_mask_dropin_socket_and_archived_input_drift_before_writes(self):
        recovery, unit, source, properties, calls, names = self.controller_activation_fixture()
        original_unit = unit.read_bytes()
        def rejected():
            calls.clear()
            with self.assertRaises((OSError, ValueError)): recovery.activate_controller()
            self.assertFalse(any(args[1] != "show" for args in calls))
        for key, value in (("LoadState", "masked"), ("FragmentPath", "/foreign/controller.service"), ("DropInPaths", "/foreign/override.conf")):
            old = properties[key]; properties[key] = value; rejected(); properties[key] = old
        unit.write_bytes(b"foreign unit"); rejected(); unit.write_bytes(original_unit)
        unit.chmod(0o640); rejected(); unit.chmod(0o644)
        dropin = unit.parent / "service.d"; dropin.mkdir(); conf = dropin / "policy.conf"; conf.write_text("[Service]\n")
        rejected(); conf.unlink(); dropin.rmdir()
        sock = self.root / "run/module-controller/control.sock"; sock.write_bytes(b"foreign socket path"); rejected(); sock.unlink()
        for name in names:
            p = self.root / name; before = p.read_bytes(); p.write_bytes(b"drift"); rejected(); p.write_bytes(before)
        cfg = self.root / "config/delivery.json"; original = cfg.read_bytes()
        bad = dr.encoded({"schema": 1, "catalog_url": "https://foreign.example/catalog.json"})
        cfg.write_bytes(bad); (source / "config/delivery.json").write_bytes(bad); rejected()
        cfg.write_bytes(original)

    @unittest.skipUnless(sys.platform == "linux" and hasattr(socket, "SO_PEERCRED"), "Linux native UNIX peer identity acceptance")
    def test_controller_socket_peer_must_be_the_actual_canonical_unit_main_pid(self):
        recovery, unit, source, properties, calls, names = self.controller_activation_fixture()
        path = self.root / "run/module-controller/control.sock"
        program = "import os,socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); os.chown(sys.argv[1],-1,int(sys.argv[2])); os.chmod(sys.argv[1],0o660); s.listen(); print('ready',flush=True);\nwhile True:\n c,_=s.accept(); c.close()"
        process = subprocess.Popen([sys.executable, "-c", program, str(path), str(self.meta["marker"]["gid"])], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "ready")
            properties.update(MainPID=str(process.pid), ActiveState="active")
            self.assertTrue(recovery.controller_socket_ready(properties))
            properties["MainPID"] = str(process.pid + 1)
            with self.assertRaisesRegex(ValueError, "peer"): recovery.controller_socket_ready(properties)
        finally:
            process.terminate(); process.wait(timeout=5); process.stdout.close()

    def test_runtime_resume_without_commit_never_calls_the_host(self):
        recovery = self.recovery()
        with self.assertRaisesRegex(ValueError, "commit"): recovery.resume_committed()
        with self.assertRaisesRegex(ValueError, "commit"): recovery.activate_controller()
        recovery.host.docker.assert_not_called()
        recovery.host.run.assert_not_called()

    def run_state_machine(self, recovery, failure=None):
        events = []
        recovery.admission = contextlib.nullcontext
        recovery.host.docker.return_value = dr.encoded(str(self.base))
        def flush(paths):
            self.assertFalse(recovery.operation["committed"])
            self.assertFalse(dr.load_json(recovery.journal.read_bytes())["committed"])
            events.append("flush")
        self.enterContext(patch.object(dr, "flush_filesystems", side_effect=flush))
        for method in ("install_files", "create_resources", "rebind_network_references", "construct", "validate_constructed"):
            def action(method=method):
                events.append(method)
                if method == failure: raise RuntimeError("controlled failure")
            setattr(recovery, method, Mock(side_effect=action))
        def resume():
            events.append("first_start")
            self.assertTrue(recovery.operation["committed"])
            self.assertTrue(dr.load_json(recovery.journal.read_bytes())["committed"])
            if failure == "first_start": raise RuntimeError("controlled postcommit failure")
            recovery.write(phase="complete")
        recovery.resume_committed = Mock(side_effect=resume)
        return events

    def test_byte_and_graph_validation_precedes_durable_commit_and_first_start(self):
        self.build_backup(); recovery = self.recovery(); events = self.run_state_machine(recovery)
        recovery.execute()
        self.assertEqual(events, ["install_files", "create_resources", "rebind_network_references", "construct", "validate_constructed", "flush", "first_start"])
        self.assertEqual(recovery.status()["phase"], "complete")

    def test_precommit_failure_never_starts_a_writer(self):
        self.build_backup(); recovery = self.recovery(); self.run_state_machine(recovery, "validate_constructed")
        with self.assertRaises(RuntimeError): recovery.execute()
        self.assertFalse(recovery.operation["committed"])
        self.assertEqual(recovery.status()["phase"], "staging_failed")
        recovery.resume_committed.assert_not_called()

    def test_private_failure_frames_are_bounded_and_public_status_omits_private_details(self):
        self.build_backup(); recovery = self.recovery(); self.run_state_machine(recovery)
        namespace = {}
        exec(compile("def fail(depth):\n local_secret = 'PRIVATE_FAILURE_MESSAGE_AND_LOCAL'\n if depth: return fail(depth - 1)\n raise ValueError(local_secret)\n",
                     "/PRIVATE_FAILURE_DIRECTORY/finite-fault.py", "exec"), namespace)
        recovery.construct = lambda: namespace["fail"](20)
        with self.assertRaises(ValueError): recovery.execute()
        saved = dr.load_json(recovery.journal.read_bytes())
        self.assertEqual(saved["failed_step"], "constructing")
        failure = saved["last_failure"]
        self.assertEqual(set(failure), {"phase", "type", "frames"})
        self.assertEqual(failure["type"], "ValueError")
        self.assertEqual(len(failure["frames"]), 12)
        for frame in failure["frames"]:
            self.assertEqual(set(frame), {"file", "line", "function"})
            self.assertEqual(frame["file"], Path(frame["file"]).name)
            self.assertGreater(frame["line"], 0)
        raw = recovery.journal.read_text()
        self.assertNotIn("PRIVATE_FAILURE_MESSAGE_AND_LOCAL", raw)
        self.assertNotIn("PRIVATE_FAILURE_DIRECTORY", raw)
        recovery.validate_journal()
        status = json.dumps(recovery.status())
        self.assertNotIn("last_failure", status)
        self.assertNotIn("frames", status)
        self.assertNotIn("finite-fault.py", status)
        invalid = copy.deepcopy(failure); invalid["frames"][0]["file"] = "/PRIVATE_FAILURE_DIRECTORY/finite-fault.py"
        recovery.write(last_failure=invalid)
        with self.assertRaisesRegex(ValueError, "private recovery failure frames"): recovery.validate_journal()
        recovery.operation.pop("last_failure"); recovery.write()
        recovery.validate_journal()

    def test_postcommit_failure_resumes_without_restoring_old_bytes(self):
        self.build_backup(); recovery = self.recovery(); self.run_state_machine(recovery, "first_start")
        with self.assertRaises(RuntimeError): recovery.execute()
        self.assertTrue(recovery.operation["committed"])
        self.assertEqual(recovery.status()["phase"], "recovery_required")
        userdata = self.root / "new-user-data"; userdata.write_bytes(b"accepted after commit")
        events = self.run_state_machine(recovery)
        recovery.execute()
        self.assertEqual(events, ["first_start"])
        self.assertEqual(userdata.read_bytes(), b"accepted after commit")
        recovery.install_files.assert_not_called(); recovery.create_resources.assert_not_called()

    def test_completed_operation_returns_receipt_without_any_repeated_runtime_action(self):
        self.build_backup(); recovery = self.recovery(); recovery.write(phase="complete", committed=True)
        events = self.run_state_machine(recovery)
        recovery.execute()
        self.assertEqual(events, []); recovery.host.docker.assert_not_called()

    def test_grafana_rebind_changes_only_physical_network_id_and_is_repeatable(self):
        instance = self.add_module("grafana"); recovery = self.recovery()
        relative = Path("modules/grafana/instances") / instance / "state.json"
        path = self.root / relative; path.parent.mkdir(parents=True)
        source = self.payload / "root" / relative; source.parent.mkdir(parents=True)
        ingress = self.installation + "_ingress"; old = next(v["id"] for v in self.meta["networks"] if v["name"] == ingress)
        value = {"schema": 2, "installation": self.installation, "instance_id": instance, "network_id": old,
                 "secret": "SAME_PRIVATE_KEY", "root_url": self.meta["origin"] + "/grafana/"}
        dr.atomic(path, value); dr.atomic(source, value)
        recovery.operation["created"]["network"][ingress] = {"id": "9" * 64}
        recovery.rebind_network_references(); recovery.rebind_network_references()
        self.assertEqual(dr.load_json(path.read_bytes()), {**value, "network_id": "9" * 64})
        changed = dr.load_json(path.read_bytes()); changed["secret"] = "UNAUTHORIZED_REPLACEMENT"; dr.atomic(path, changed)
        with self.assertRaisesRegex(ValueError, "more than"): recovery.rebind_network_references()

    def test_grafana_intent_checkpoint_can_resume_before_state_file_was_replaced(self):
        instance = self.add_module("grafana")
        relative = Path("modules/grafana/instances") / instance / "state.json"
        original = {"schema": 2, "installation": self.installation, "instance_id": instance,
            "network_id": next(v["id"] for v in self.meta["networks"] if v["name"].endswith("_ingress")), "secret": "keep"}
        (self.source / relative).parent.mkdir(parents=True)
        dr.atomic(self.source / relative, original); self.build_backup()
        recovery = self.recovery()
        dr.helper("delivery").restore_tree(self.payload / "installation.tar", self.root)
        (self.payload / "root").mkdir()
        dr.helper("delivery").restore_tree(self.payload / "installation.tar", self.payload / "root")
        recovery.operation["files_installed"] = True
        recovery.operation["created"]["network"][self.installation + "_ingress"] = {"id": "9" * 64}
        original_atomic = dr.atomic
        def fail_state(path, value):
            if Path(path) == self.root / relative: raise RuntimeError("power loss after intent")
            return original_atomic(path, value)
        with patch.object(dr, "atomic", side_effect=fail_state), self.assertRaises(RuntimeError): recovery.rebind_network_references()
        self.assertIn(instance, recovery.operation["rebindings"])
        self.assertEqual(dr.load_json((self.root / relative).read_bytes()), original)
        recovery.install_files()
        recovery.rebind_network_references()
        recovery.install_files(strict_rebindings=True)
        self.assertEqual(dr.load_json((self.root / relative).read_bytes())["network_id"], "9" * 64)

    def test_bookstack_proved_web_replays_missing_ingress_connection_once(self):
        self.add_module("bookstack"); recovery = self.recovery()
        spec = next(v for v in self.meta["containers"] if v["module_id"] == "bookstack" and v["role"] == "web")
        obj = {"Id": "3" * 64, "Name": "/" + spec["name"], "Image": spec["image"],
            "State": {"Status": "created", "Running": False, "StartedAt": "0001-01-01T00:00:00Z"},
            "NetworkSettings": {"Networks": {"private": {}}}}
        recovery.remember("container", obj)
        calls = []
        def docker(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("network", "connect"):
                self.assertEqual(args[-1], obj["Id"])
                obj["NetworkSettings"]["Networks"][self.installation + "_ingress"] = {}
                return b""
            return dr.encoded([obj])
        recovery.host.docker = docker
        recovery.ensure_bookstack_ingress(spec); recovery.ensure_bookstack_ingress(spec)
        self.assertEqual(sum(v[:2] == ("network", "connect") for v in calls), 1)

    def test_partial_service_group_is_reused_only_with_exact_durable_creation_intent(self):
        marker = {"uid": 991, "gid": 992}
        group = types.SimpleNamespace(gr_name="pl", gr_gid=992, gr_mem=[])
        with patch.object(dr.pwd, "getpwnam", side_effect=KeyError), patch.object(dr.pwd, "getpwuid", side_effect=KeyError), \
                patch.object(dr.grp, "getgrnam", return_value=group), patch.object(dr.grp, "getgrgid", return_value=group):
            with self.assertRaisesRegex(ValueError, "proved"): dr.account_preflight(marker)
            self.assertFalse(dr.account_preflight(marker, {"uid": 991, "gid": 992, "group_intent": True}))
            with self.assertRaises(ValueError): dr.account_preflight(marker, {"uid": 991, "gid": 777, "group_intent": True})

    def test_linux_filesystem_flush_deduplicates_device_and_propagates_failure(self):
        directories = [self.base, self.source, self.payload]
        calls = []
        with patch.object(dr.sys, "platform", "linux"), patch.object(dr.os, "syncfs", create=True, side_effect=lambda fd: calls.append(os.fstat(fd).st_dev)):
            dr.flush_filesystems(directories)
        self.assertEqual(len(calls), 1)
        with patch.object(dr.sys, "platform", "linux"), patch.object(dr.os, "syncfs", create=True, return_value=-1), self.assertRaises(OSError):
            dr.flush_filesystems(directories)

    def test_never_started_guard_rejects_stopped_previous_writers(self):
        self.assertTrue(dr.never_started({"State": {"Status": "created", "Running": False, "StartedAt": "0001-01-01T00:00:00Z"}}))
        for state in ({"Status": "exited", "Running": False, "StartedAt": "2026-01-01T00:00:00Z"},
                      {"Status": "created", "Running": False, "StartedAt": "2026-01-01T00:00:00Z"}):
            self.assertFalse(dr.never_started({"State": state}))

    def test_directory_relay_whitelist_is_get_only_without_general_api_or_auth_forwarding(self):
        instance = self.add_module("doska")
        for kind in ("employees", "departments", "changes", "identity"):
            path = "/api/v1/modules/" + instance + "/doska-directory/" + kind
            self.assertTrue(dr.relay_allowed(self.meta, "GET", path + "?limit=100"))
            for method in ("POST", "PUT", "DELETE", "HEAD", "OPTIONS"):
                self.assertFalse(dr.relay_allowed(self.meta, method, path))
        for path in ("/", "/auth/local", "/api/v1/session", "/api/v1/resources", "/doska/", "/sftpgo/", "/api/v1/doska-directory/employees"):
            self.assertFalse(dr.relay_allowed(self.meta, "GET", path))
        config = dr.directory_config(self.meta, "172.31.252.2").decode()
        self.assertIn("proxy_pass_request_headers off;", config)
        self.assertIn("proxy_set_header Authorization $http_authorization;", config)
        self.assertNotIn("auth_request", config)
        self.assertIn("location / { default_type text/plain; return 503", config)
        self.assertIn("add_header Cache-Control no-store always;", config)
        self.assertIn("add_header Retry-After 5 always;", config)
        for value in ("client_body", "proxy", "fastcgi", "uwsgi", "scgi"):
            self.assertIn(value + "_temp_path /tmp/", config)

    def pending_relay_fixture(self, ipam):
        self.add_module("doska"); recovery = self.recovery(); recovery.write(committed=True, sessions_revoked=True)
        (self.root / "state").mkdir()
        dr.atomic(self.root / "state/installation.json", {"config": {"bind_address": "127.0.0.1", "port": 8452}})
        containers, calls = {}, []
        networks = {}
        for source in self.meta["networks"]:
            obj = {"Id": source["id"], "Name": source["name"], "Labels": source["labels"]}
            networks[obj["Id"]] = obj
            recovery.operation["created"]["network"][obj["Name"]] = {"id": obj["Id"], "name": obj["Name"], "labels": obj["Labels"]}
        recovery.host.inspect_all = lambda kind: list(containers.values()) if kind == "container" else []
        def docker(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("image", "inspect"): return dr.encoded([{"Config": {"Labels": {}}}])
            if args[:2] == ("network", "inspect"): return dr.encoded([networks[args[-1]]])
            if args[:2] == ("network", "connect"):
                obj = containers[args[-1]]
                obj["NetworkSettings"]["Networks"][networks[args[-2]]["Name"]] = {
                    "NetworkID": "", "Aliases": [], "IPAMConfig": copy.deepcopy(ipam), "DriverOpts": {}, "Links": None}
                return b""
            if args[:2] == ("container", "create"):
                name = args[args.index("--name") + 1]; identity = digest(name)
                labels = dict(args[i + 1].split("=", 1) for i, value in enumerate(args) if value == "--label")
                containers[identity] = {"Id": identity, "Name": "/" + name, "Image": args[-1], "Config": {"Labels": labels},
                    "State": {"Status": "created", "Running": False, "StartedAt": "0001-01-01T00:00:00Z"},
                    "HostConfig": {"NetworkMode": self.installation + "_backend", "ReadonlyRootfs": True},
                    "Mounts": [], "NetworkSettings": {"Networks": {
                        self.installation + "_backend": {"Aliases": [], "IPAMConfig": None}}}}
                return identity.encode()
            obj = containers[args[-1]]
            if args[:2] == ("container", "start"):
                persisted = dr.load_json(recovery.journal.read_bytes())
                self.assertEqual(persisted["relay"]["id"], obj["Id"])
                self.assertIs(persisted["relay"]["attach_pending"], False)
                self.assertEqual(persisted["relay"]["contract"], dr.container_contract(obj))
                for name, endpoint in obj["NetworkSettings"]["Networks"].items():
                    endpoint["NetworkID"] = recovery.operation["created"]["network"][name]["id"]
                obj["State"]["Running"] = True; obj["State"]["Status"] = "running"; return b""
            if args[:2] == ("container", "stop"): obj["State"]["Running"] = False; return b""
            if args[:2] == ("container", "rm"): del containers[args[-1]]; return b""
            return dr.encoded([obj])
        recovery.host.docker = docker
        original_write = recovery.write
        interrupted = False
        def fail_after_attach(**updates):
            nonlocal interrupted
            if updates.get("relay", {}).get("attach_pending") is False and not interrupted:
                interrupted = True
                raise RuntimeError("power loss after network attach before checkpoint")
            return original_write(**updates)
        recovery.write = fail_after_attach
        with self.assertRaises(RuntimeError): recovery.start_relay("172.31.252.2")
        self.assertFalse(any(v[:2] == ("container", "start") for v in calls))
        self.assertTrue(dr.load_json(recovery.journal.read_bytes())["relay"]["attach_pending"])
        recovery.operation = dr.load_json(recovery.journal.read_bytes()); recovery.write = original_write
        return recovery, containers, networks, calls

    def exercise_owned_directory_relay_replay(self, ipam):
        recovery, containers, networks, calls = self.pending_relay_fixture(ipam)
        recovery.start_relay("172.31.252.2"); recovery.start_relay("172.31.252.2")
        self.assertEqual(sum(v[:2] == ("container", "create") for v in calls), 1)
        self.assertEqual(sum(v[:2] == ("container", "start") for v in calls), 1)
        self.assertEqual(sum(v[:2] == ("network", "connect") for v in calls), 1)
        before = len(calls)
        containers[recovery.operation["relay"]["id"]]["Image"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ValueError, "identity"): recovery.remove_relay()
        self.assertFalse(any(v[:2] == ("container", "rm") for v in calls[before:]))

    def test_owned_directory_relay_records_actual_id_before_start_and_resumes_without_second_create(self):
        self.exercise_owned_directory_relay_replay(None)

    def test_relay_exact_engine_empty_ipam_replays_after_connect_before_checkpoint(self):
        self.exercise_owned_directory_relay_replay({"IPv4Address": "", "IPv6Address": ""})

    def test_relay_ipam_network_alias_and_base_recipe_drift_remain_strict_and_pending(self):
        recovery, containers, networks, calls = self.pending_relay_fixture({"IPv4Address": "", "IPv6Address": ""})
        record = recovery.operation["relay"]; obj = containers[record["id"]]
        original = copy.deepcopy(obj); ingress = self.installation + "_ingress"
        endpoint = obj["NetworkSettings"]["Networks"][ingress]
        invalid = ({"IPv4Address": "192.0.2.1", "IPv6Address": ""}, {"IPv4Address": "", "IPv6Address": "2001:db8::1"},
                   {"IPv4Address": "", "IPv6Address": "", "LinkLocalIPs": []},
                   {"IPv4Address": "", "IPv6Address": "", "extra": ""}, {"IPv4Address": ""}, {}, [], "", False, 0,
                   {"IPv4Address": 0, "IPv6Address": ""}, {"IPv4Address": "", "IPv6Address": None})
        def refused():
            before = len(calls); journal = recovery.journal.read_bytes(); checkpoint = copy.deepcopy(record)
            with self.assertRaises(ValueError): recovery.ensure_relay_ingress(record)
            self.assertEqual(recovery.journal.read_bytes(), journal); self.assertEqual(record, checkpoint)
            self.assertTrue(record["attach_pending"])
            self.assertFalse(any(v[:2] in (("container", "start"), ("container", "create"), ("container", "rm"), ("network", "connect")) for v in calls[before:]))
        for ipam in invalid:
            with self.subTest(ipam=ipam):
                endpoint["IPAMConfig"] = ipam; refused()
        endpoint["IPAMConfig"] = {"IPv4Address": "", "IPv6Address": ""}
        for field, value in (("NetworkID", "f" * 64), ("Aliases", ["foreign-alias"])):
            before = endpoint[field]; endpoint[field] = value; refused(); endpoint[field] = before
        network = networks[recovery.operation["created"]["network"][ingress]["id"]]
        labels = network["Labels"]; network["Labels"] = {"foreign": "labels"}; refused(); network["Labels"] = labels
        obj["HostConfig"]["ReadonlyRootfs"] = False; refused(); obj["HostConfig"] = copy.deepcopy(original["HostConfig"])
        obj["NetworkSettings"]["Networks"]["foreign-network"] = {}; refused()

    def projection_fixture(self, module="doska"):
        instance = str(uuid.uuid4()); integration = str(uuid.uuid4()); committed = 1700000000.0
        created = "2023-11-14T22:13:21+00:00"; success = "2023-11-14T22:13:22+00:00"
        expected = {"module_id": module, "endpoint": "" if module == "xray" else "http://127.0.0.1:32768"}
        item = {"id": instance, "module_id": module, "desired_state": "enabled", "observed_state": "running", "error": "",
                "endpoint": expected["endpoint"], "integration_id": "" if module == "xray" else integration, "last_success": success}
        projection = {"instance": item, "integration": None if module == "xray" else {"id": integration, "managed_module_id": instance,
            "enabled": True, "status": "connected", "error": "", "url": expected["endpoint"], "last_success": success},
            "job": {"actor": "system:modules", "kind": "module", "status": "succeeded", "created_at": created,
                    "parameters": {"instance_id": instance, "action": "refresh"}, "result": {"instance": copy.deepcopy(item)}}}
        return projection, instance, expected, committed

    def test_bindings_require_fresh_actual_job_and_matching_native_instance_and_integration(self):
        projection, instance, expected, committed = self.projection_fixture()
        self.assertTrue(dr.binding_projection_ready(projection, instance, expected, committed))
        for modify in (lambda p: p["job"].update(created_at="2023-11-14T22:00:00Z"), lambda p: p["instance"].update(endpoint="old"),
                       lambda p: p["integration"].update(url="old"), lambda p: p["job"].update(status="queued"),
                       lambda p: p["job"].update(actor="local-admin"), lambda p: p["instance"].update(last_success=None)):
            value = copy.deepcopy(projection); modify(value)
            self.assertFalse(dr.binding_projection_ready(value, instance, expected, committed))
        projection, instance, expected, committed = self.projection_fixture("xray")
        self.assertTrue(dr.binding_projection_ready(projection, instance, expected, committed))
        projection["instance"]["integration_id"] = str(uuid.uuid4())
        self.assertFalse(dr.binding_projection_ready(projection, instance, expected, committed))

    def test_busy_second_recovery_does_not_rewrite_journal_or_stop_any_runtime(self):
        recovery = self.recovery(); recovery.write(committed=True, phase="runtime_ready")
        recovery.admission = contextlib.nullcontext
        recovery.write = Mock()
        with patch.object(dr, "lock", side_effect=ValueError("busy")), self.assertRaisesRegex(ValueError, "busy"):
            recovery.execute()
        recovery.write.assert_not_called(); recovery.host.docker.assert_not_called()

    def test_publish_releases_maintenance_only_after_fresh_binding_proof(self):
        projection, instance, expected, committed = self.projection_fixture()
        recovery = self.recovery(); recovery.write(committed=True, phase="runtime_ready", commit_unix=committed, endpoints={instance: expected})
        (self.root / "state").mkdir()
        dr.atomic(self.root / "state/installation.json", {"install_id": self.installation, "version": self.meta["version"], "manifest_sha256": self.meta["manifest_sha256"]})
        spec = next(v for v in self.meta["containers"] if v["service"] == "web")
        recovery.operation["created"]["container"][spec["name"]] = {"id": spec["id"], "name": spec["name"], "image": spec["image"]}
        events = []
        recovery.preflight_target = Mock()
        recovery.projection = Mock(side_effect=lambda rt, id: (events.append("fresh-bindings"), projection)[1])
        recovery.remove_relay = Mock(side_effect=lambda: events.append("remove-relay"))
        def docker(*args, **kwargs):
            if args[:2] == ("container", "start"):
                self.assertIsNotNone(recovery.operation.get("bindings_verified_unix")); events.append("start-web"); return b""
            return dr.encoded([{"Id": spec["id"], "Image": spec["image"], "Name": "/" + spec["name"]}])
        recovery.host.docker = docker
        modules = {"maintenance": types.SimpleNamespace(Runtime=lambda root: types.SimpleNamespace(package=self.base)),
            "module-controller": types.SimpleNamespace(Controller=lambda *args: object()),
            "delivery": types.SimpleNamespace(Delivery=lambda *args: types.SimpleNamespace(wait_readiness=lambda: events.append("web-ready")))}
        with patch.object(dr, "helper", side_effect=modules.__getitem__): recovery.reconcile_and_publish()
        self.assertEqual(events, ["fresh-bindings", "remove-relay", "start-web", "web-ready"])
        self.assertEqual(recovery.operation["phase"], "complete")

    def test_status_and_cli_error_do_not_print_private_values(self):
        recovery = self.recovery(); recovery.operation["private_canary"] = self.secret.decode(); recovery.write()
        with contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(dr.main(["status", "--root", str(self.root)]), 0)
            with patch.object(dr, "backup", side_effect=ValueError(self.secret.decode())):
                self.assertEqual(dr.main(["backup", "--root", str(self.root), "--output", str(self.base / "out")]), 2)
        self.assertNotIn(self.secret.decode(), output.getvalue() + errors.getvalue())


if __name__ == "__main__":
    unittest.main()
