"""Real collect/native-plan admission for immutable failed-operation history."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import types
import unittest
import uuid
from unittest.mock import patch

import test_grafana_controller as grafana_fixture


BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pl_history_dr", BASE / "disaster-recovery.py")
dr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dr)


class BackupHistoryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = grafana_fixture.GrafanaTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        f.root = f.root.resolve()
        self.root, self.installation, self.instance = f.root, f.installation, f.instance
        f.install()
        self.native = f.containers[f.controller.name(self.instance)]
        self.native["Config"]["Labels"].update(f.image["labels"])
        self.state = {"install_id": self.installation, "version": "0.5.5", "manifest_sha256": "a" * 64,
                      "phase": "ready", "config": {"public_url": "https://pl.example"}}
        (self.root / "state/installation.json").write_text(json.dumps(self.state))
        self.write("state/controller-supervisor.json", {"schema": 1, "version": "0.5.3"})
        self.write(".pl-installation.json", {"product": "PL", "uid": os.getuid() or 991, "gid": os.getgid() or 991})
        self.current = [{"id": self.instance, "module_id": "grafana", "desired_state": "enabled",
                         "observed_state": "running"}]
        self.jobs, self.active, self.queries = [], 0, []
        self.core, self.images = {}, {}
        self.manifest = {"architecture": "amd64", "images": {}}
        for index, name in enumerate(("api", "web", "db")):
            image = "sha256:" + "abc"[index] * 64
            self.manifest["images"][name] = {"id": image, "architecture": "amd64", "ref": "pl/core-" + name + ":0.5.5",
                "recipe": "Dockerfile", "labels": {"pl.source.sha256": "e" * 64}}
            self.images[image] = {"Id": image, "Os": "linux", "Architecture": "amd64", "Size": 1024,
                                   "Config": {"Labels": {"pl.source.sha256": "e" * 64}}}
            cid = hashlib.sha256(name.encode()).hexdigest()
            self.core[name] = {"Id": cid, "Name": "/" + self.installation + "-" + name + "-1", "Image": image,
                "Config": {"Labels": {"com.docker.compose.project": self.installation,
                                       "com.docker.compose.service": name}}, "State": {"Running": True},
                "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}}, "Mounts": [],
                "NetworkSettings": {"Networks": {self.installation + "_backend": {}}}}
        self.core["api"]["NetworkSettings"]["Networks"][self.installation + "_egress"] = {}
        self.core["web"]["NetworkSettings"]["Networks"][f.ingress] = {}
        for role, subnet in (("backend", "172.31.252.0/26"), ("ingress", "172.31.252.64/26"), ("egress", "172.31.252.128/26")):
            name = self.installation + "_" + role
            network = dr.ipaddress.IPv4Network(subnet)
            obj = f.network_object(name, {"pl.installation": self.installation,
                "com.docker.compose.project": self.installation, "com.docker.compose.network": role},
                identity="9" * 64 if role == "ingress" else hashlib.sha256(role.encode()).hexdigest())
            obj["Internal"] = role == "backend"
            obj["IPAM"]["Config"] = [{"Subnet": subnet, "Gateway": str(network.network_address + 1)}]
            f.networks[name] = obj
        self.volume_paths = []
        for suffix, role in (("_db", "db"), ("-auth", "api"), ("_module-transfers", "api")):
            name = self.installation + suffix
            f.volumes[name] = {"Name": name, "Driver": "local", "Options": {}, "Labels": {"pl.installation": self.installation}}
            self.core[role]["Mounts"].append({"Type": "volume", "Name": name, "Destination": "/" + name, "RW": True})
        for index, name in enumerate(f.volumes):
            directory = self.root / ("volume-" + str(index))
            directory.mkdir(mode=0o700)
            (directory / "fixture.data").write_bytes(b"existing native data")
            self.volume_paths.append({"name": name, "path": str(directory)})
        self.parent = types.SimpleNamespace(root=self.root, installation=self.installation, docker=self.docker,
            grafana=lambda: f.controller, application=lambda kind: f.controller if kind == "grafana" else self.fail("wrong controller"))
        f.controller.docker = self.docker
        self.rt = types.SimpleNamespace(root=self.root, private=self.root / "private", install_id=self.installation,
            package=self.root, state=self.state, m=self.manifest, schema={}, sql=self.sql,
            read_auth=lambda: {"hash": "fixture", "password_change_required": False})
        self.host = types.SimpleNamespace(docker=self.docker, inspect_all=lambda kind: list(f.networks.values()), unit_active=lambda install: True)
        self.host.verify_images = lambda images: dr.Host.verify_images(self.host, images)
        modules = {name: dr.helper(name) for name in ("bootstrap", "delivery", "module-upgrade")}
        modules["module-controller"] = types.SimpleNamespace(Controller=lambda *args: self.parent)
        self.enterContext(patch.object(modules["delivery"], "Delivery", return_value=types.SimpleNamespace(volumes=lambda: self.volume_paths)))
        self.enterContext(patch.object(dr, "helper", side_effect=modules.__getitem__))
        self.enterContext(patch.object(dr, "validate_unit"))
        f.calls.clear()

    def write(self, relative, value):
        path = self.root / relative
        path.write_text(json.dumps(value) + "\n")
        path.chmod(0o600)

    def objects(self):
        return [*self.core.values(), *self.fixture.containers.values()]

    def docker(self, *args, **kwargs):
        kind, action = args[:2]
        if (kind, action) == ("container", "ls"):
            values = self.objects()
            for index, value in enumerate(args):
                if value != "--filter":
                    continue
                query = args[index + 1]
                if query.startswith("label="):
                    key, expected = query[6:].split("=", 1)
                    values = [v for v in values if v["Config"]["Labels"].get(key) == expected]
                elif query.startswith("name=^/"):
                    values = [v for v in values if v["Name"] == "/" + query[7:].removesuffix("$")]
                else:
                    raise AssertionError("unexpected read filter")
            return "\n".join(v["Id"] for v in values).encode()
        if (kind, action) == ("container", "inspect"):
            return json.dumps([next(v for v in self.objects() if name in (v["Id"], v["Name"].removeprefix("/"))) for name in args[2:]]).encode()
        if (kind, action) == ("image", "inspect"):
            if args[-1] in self.images:
                return json.dumps([self.images[args[-1]]]).encode()
            value = json.loads(self.fixture.docker(*args, **kwargs))
            value[0]["Size"] = 1024
            return json.dumps(value).encode()
        if kind in ("volume", "network") and action in ("ls", "inspect"):
            return self.fixture.docker(*args, **kwargs)
        raise AssertionError("collect attempted a runtime mutation")

    def sql(self, query):
        self.queries.append(query)
        self.assertTrue(query.lstrip().startswith("SELECT"))
        if "count(*)" in query and "jobs" in query:
            return str(self.active).encode()
        if "FROM public.documents" in query:
            return dr.encoded(self.current)
        if "FROM public.jobs" in query:
            return dr.encoded(self.jobs)
        raise AssertionError("unexpected SQL read")

    def failed_history(self, action="refresh"):
        operation = str(uuid.uuid4())
        request = {"operation_id": operation, "instance_id": self.instance, "module_id": "grafana", "action": action}
        if action in ("install", "enable"):
            request["public_url"] = self.state["config"]["public_url"]
        record = {"phase": "running", "fingerprint": hashlib.sha256(dr.encoded(request) + b"\n").hexdigest()}
        path = self.root / "modules/grafana/operations" / (operation + ".json")
        if action in ("refresh", "install"):
            # Produce the historical record through the real stock controller;
            # its error response deliberately leaves the private phase running.
            responses = ([(200, "application/json", json.dumps({"version": self.fixture.controller.version,
                           "database": "ok"}).encode())] if action == "install" else [])
            responses.append((503, "application/json", b"{}"))
            with patch.object(self.fixture.controller, "http", side_effect=responses):
                result = self.fixture.controller.execute(request)
            self.assertEqual(result["state"], "error")
            self.assertEqual(json.loads(path.read_bytes()), record)
        else:
            path.write_bytes(dr.encoded(record) + b"\n")
            path.chmod(0o600)
        self.jobs.append({"id": operation, "kind": "module", "status": "failed", "target": self.instance,
            "body": {"id": operation, "kind": "module", "status": "failed",
                     "parameters": {"instance_id": self.instance, "action": action}}})
        return path

    def preserved(self):
        return {str(p.relative_to(self.root)): (p.read_bytes(), p.stat().st_ino, p.stat().st_mode)
                for p in self.root.rglob("*") if p.is_file()}

    def test_collect_accepts_terminal_failed_refresh_and_keeps_history_byte_exact(self):
        path = self.failed_history()
        before = self.preserved()
        first, *_ = dr.collect(self.rt, self.host)
        second, *_ = dr.collect(self.rt, self.host, prior=first)
        self.assertEqual(self.preserved(), before)
        self.assertEqual(json.loads(path.read_text())["phase"], "running")
        self.assertEqual(first["native"], second["native"])
        self.assertTrue(any("FROM public.jobs" in q for q in self.queries))

    def test_collect_accepts_old_failed_grafana_install_only_with_current_native_health(self):
        self.failed_history("install")
        before = self.preserved()
        first, *_ = dr.collect(self.rt, self.host)
        dr.collect(self.rt, self.host, prior=first)
        self.assertEqual(self.preserved(), before)
        self.assertEqual(first["native"]["grafana"]["instances"][0]["instance_id"], self.instance)

    def test_collect_accepts_failed_refresh_of_fully_disabled_instance_after_recovery(self):
        self.failed_history()
        self.jobs[0]["body"]["parameters"]["recovered"] = True
        self.native["State"]["Running"] = False
        self.current[0].update(desired_state="disabled", observed_state="disabled")
        before = self.preserved()
        first, *_ = dr.collect(self.rt, self.host)
        dr.collect(self.rt, self.host, prior=first)
        self.assertFalse(first["native"]["grafana"]["instances"][0]["running"])
        self.assertEqual(self.preserved(), before)

    def test_collect_reads_large_failed_history_in_one_bounded_batch_per_collection(self):
        for _ in range(104):
            self.failed_history()
        before = self.preserved()
        first, *_ = dr.collect(self.rt, self.host)
        dr.collect(self.rt, self.host, prior=first)
        self.assertEqual(sum("FROM public.jobs" in query for query in self.queries), 2)
        self.assertEqual(self.preserved(), before)

    def test_collect_rejects_history_over_the_reader_bound_before_job_lookup(self):
        self.failed_history()
        self.failed_history()
        with patch.object(dr, "MAX_RESOURCES", 1), self.assertRaises(ValueError):
            dr.collect(self.rt, self.host)
        self.assertFalse(any("FROM public.jobs" in query for query in self.queries))

    def test_failed_install_unhealthy_or_missing_current_graph_is_not_closed_history(self):
        self.failed_history("install")
        self.fixture.controller.http = lambda *args: (503, "application/json", b"{}")
        with self.assertRaises(ValueError):
            dr.collect(self.rt, self.host)
        self.fixture.controller.http = self.fixture.http
        del self.fixture.containers[self.fixture.controller.name(self.instance)]
        with self.assertRaisesRegex(ValueError, "Incomplete native"):
            dr.collect(self.rt, self.host)

    def test_collect_refuses_active_missing_ambiguous_or_nonfailed_jobs(self):
        self.failed_history()
        self.active = 1
        with self.assertRaises(ValueError):
            dr.collect(self.rt, self.host)
        self.active = 0
        saved = copy.deepcopy(self.jobs)
        for jobs in ([], saved * 2, [{**saved[0], "status": "running"}], [{**saved[0], "status": "queued"}],
                     [{**saved[0], "status": "succeeded"}], [{**saved[0], "kind": "report"}]):
            with self.subTest(jobs=jobs):
                self.jobs = jobs
                with self.assertRaises(ValueError):
                    dr.collect(self.rt, self.host)

    def test_collect_refuses_body_target_action_identity_and_fingerprint_drift(self):
        path = self.failed_history()
        original = copy.deepcopy(self.jobs[0])
        for keys, value in ((("target",), str(uuid.uuid4())), (("body", "id"), str(uuid.uuid4())),
                            (("body", "kind"), "report"), (("body", "status"), "running"),
                            (("body", "parameters", "instance_id"), str(uuid.uuid4())),
                            (("body", "parameters", "action"), "remove"),
                            (("body", "parameters", "action"), True),
                            (("body", "parameters", "recovered"), 1),
                            (("body", "parameters", "configuration_ref"), str(uuid.uuid4())),
                            (("body", "parameters"), [])):
            with self.subTest(keys=keys):
                changed = copy.deepcopy(original)
                target = changed
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                self.jobs = [changed]
                with self.assertRaises(ValueError):
                    dr.collect(self.rt, self.host)
        self.jobs = [original]
        record = json.loads(path.read_text())
        for change in ({"fingerprint": "f" * 64}, {"fingerprint": True}, {"extra": True}, {"phase": "applying"}):
            with self.subTest(change=change):
                path.write_bytes(dr.encoded({**record, **change}))
                with self.assertRaises(ValueError):
                    dr.collect(self.rt, self.host)

    def test_collect_refuses_unreconciled_local_records_and_current_recipe_drift(self):
        self.failed_history()
        original = copy.deepcopy(self.current)
        for change in ({"observed_state": "error"}, {"observed_state": None}, {"desired_state": "removed"},
                       {"module_id": "xray"}, {"id": str(uuid.uuid4())}):
            with self.subTest(change=change):
                self.current = [{**original[0], **change}]
                with self.assertRaises(ValueError):
                    dr.collect(self.rt, self.host)
        self.current = original
        self.native["HostConfig"]["ReadonlyRootfs"] = False
        with self.assertRaises(ValueError):
            dr.collect(self.rt, self.host)

    def test_collect_refuses_duplicate_or_nonprivate_history_and_unknown_journal_codec(self):
        path = self.failed_history()
        record = path.read_bytes()
        path.chmod(0o640)
        with self.assertRaises(ValueError):
            dr.collect(self.rt, self.host)
        path.chmod(0o600)
        other = self.root / "modules/xray/operations"
        other.mkdir(parents=True, mode=0o700)
        duplicate = other / path.name
        duplicate.write_bytes(record)
        duplicate.chmod(0o600)
        with self.assertRaises(ValueError):
            dr.collect(self.rt, self.host)
        duplicate.unlink()
        global_operations = self.root / "modules/operations"
        global_operations.mkdir(mode=0o700)
        path.rename(global_operations / path.name)
        with self.assertRaises(ValueError):
            dr.collect(self.rt, self.host)

    def test_collect_refuses_noncanonical_operation_names_and_other_lifecycle_actions(self):
        path = self.failed_history()
        renamed = path.with_name(path.stem.upper() + ".json")
        path.rename(renamed)
        with self.assertRaises(ValueError):
            dr.collect(self.rt, self.host)
        renamed.rename(path)
        for action in ("enable", "disable", "remove", "configure"):
            other = self.failed_history(action)
            with self.subTest(action=action), self.assertRaises(ValueError):
                dr.collect(self.rt, self.host)
            other.unlink()
            self.jobs.pop()


if __name__ == "__main__":
    unittest.main()
