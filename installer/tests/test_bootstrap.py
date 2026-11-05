import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import MagicMock, Mock, patch

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pl_bootstrap", BASE / "bootstrap.py")
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        (self.root / "private").mkdir(mode=0o700)
        (self.root / "config").mkdir()
        self.cfg = pl.configuration("https://192.0.2.5:8443", "127.0.0.1", "admin")
        self.m = {"features": {"local_users": True}, "images": {"api": {"id": "sha256:" + "1" * 64},
                             "web": {"id": "sha256:" + "2" * 64},
                             "db": {"ref": "postgres:17-alpine@sha256:" + "3" * 64}}}

    def tearDown(self):
        self.temp.cleanup()

    def test_reject_ambiguous_or_injected_origins(self):
        for url in ("http://example.org", "https://u:p@example.org", "https://example.org/path",
                    "https://example.org/?secret=x", "https://example.org/#a", "https://host\nname",
                    "https://evil\\hostname", "https://host:0", "https://host:65536"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                pl.configuration(url, "127.0.0.1", "admin")
        self.assertEqual(pl.configuration("https://host", "127.0.0.1", "admin")["port"], 443)

    def test_core_model_has_no_external_or_demo_dependency(self):
        model = pl.compose_model(self.root, self.m, self.cfg, "pl-abc123")
        self.assertEqual(set(model["services"]), {"db", "api", "web"})
        self.assertTrue(model["networks"]["backend"]["internal"])
        self.assertEqual(model["services"]["web"]["networks"], ["backend", "ingress"])
        self.assertNotIn("internal", model["networks"]["ingress"])
        self.assertEqual(model["services"]["db"]["networks"], ["backend"])
        api = model["services"]["api"]
        self.assertEqual(api["environment"]["PORTAL_DEMO"], "false")
        self.assertEqual(api["environment"]["PORTAL_LOCAL_USERS"], "true")
        self.assertFalse(any(k.startswith(("PORTAL_AD_", "PORTAL_OIDC_", "PORTAL_EDGE_")) for k in api["environment"]))
        self.assertNotIn("ports", api)
        self.assertNotIn("ports", model["services"]["db"])
        self.assertNotIn("docker.sock", json.dumps(model))
        self.assertEqual(model["services"]["web"]["ports"][0]["host_ip"], "127.0.0.1")

    def test_api_temporary_directory_belongs_to_unprivileged_runtime(self):
        model = pl.compose_model(self.root, self.m, self.cfg, "pl-abc123")
        api = model["services"]["api"]
        target, options = api["tmpfs"][0].split(":", 1)
        mount = dict(option.split("=", 1) for option in options.split(","))
        self.assertEqual(target, "/tmp")
        self.assertEqual((int(mount["uid"]), int(mount["gid"])), (10001, 10001))
        self.assertEqual(int(mount["mode"], 8), 0o700)
        self.assertTrue(api["read_only"])
        self.assertEqual(api["cap_drop"], ["ALL"])
        self.assertEqual(api["security_opt"], ["no-new-privileges:true"])
        self.assertEqual(model["services"]["web"]["tmpfs"], ["/tmp"])

    def test_persisted_web_destination_policy_overrides_bootstrap_defaults(self):
        cfg = {**self.cfg, "allowed_cidrs": ["192.0.2.0/24"], "allowed_ports": [443, 9443]}
        env = pl.compose_model(self.root, self.m, cfg, "pl-abc123")["services"]["api"]["environment"]
        self.assertEqual(env["PORTAL_ALLOWED_CIDRS"], "192.0.2.0/24")
        self.assertEqual(env["PORTAL_ALLOWED_PORTS"], "443,9443")
        self.assertEqual(env["PORTAL_CHECK_ALLOWED_CIDRS"], "192.0.2.0/24")
        self.assertEqual(env["PORTAL_CHECK_INHERIT_INTEGRATION_POLICY"], "false")

    def test_persisted_outbound_ca_has_a_finite_readonly_bind_and_can_be_cleared(self):
        cfg = {**self.cfg, "outbound_ca_pem": "public CA certificate"}
        api = pl.compose_model(self.root, self.m, cfg, "pl-abc123")["services"]["api"]
        self.assertEqual(api["environment"]["PORTAL_OUTBOUND_CA_FILE"], "/run/secrets/outbound-ca.pem")
        mount = next(v for v in api["volumes"] if isinstance(v, dict) and v.get("target") == "/run/secrets/outbound-ca.pem")
        self.assertTrue(mount["read_only"])
        self.assertEqual(mount["source"], str(self.root / "private/outbound-ca.pem"))
        api = pl.compose_model(self.root, self.m, {**cfg, "outbound_ca_pem": ""}, "pl-abc123")["services"]["api"]
        self.assertNotIn("PORTAL_OUTBOUND_CA_FILE", api["environment"])

    def test_module_controller_mounts_only_directory_and_key_with_egress(self):
        self.m["features"]["module_controller"] = True
        (self.root / ".pl-installation.json").write_text(json.dumps({"gid": 997}))
        model = pl.compose_model(self.root, self.m, self.cfg, "pl-abc123")
        api = model["services"]["api"]
        self.assertEqual(api["group_add"], ["997"])
        self.assertEqual(api["networks"], ["backend", "egress"])
        self.assertNotIn("internal", model["networks"]["egress"])
        binds = [v for v in api["volumes"] if isinstance(v, dict)]
        self.assertEqual({b["target"] for b in binds}, {"/run/pl-module-controller", "/run/secrets/module-controller-key"})
        self.assertTrue(all(b["read_only"] for b in binds))
        self.assertNotIn("docker.sock", json.dumps(model))
        self.assertNotIn("ports", api)

    def test_original_package_keeps_its_single_admin_profile(self):
        old = {k: v for k, v in self.m.items() if k != "features"}
        model = pl.compose_model(self.root, old, self.cfg, "pl-abc123")
        self.assertNotIn("PORTAL_LOCAL_USERS", model["services"]["api"]["environment"])

    def test_literal_dollar_path_is_not_compose_interpolation(self):
        model = pl.compose_model(self.root / "pl$site", self.m, self.cfg, "pl-id")
        self.assertIn("pl$$site", model["services"]["web"]["volumes"][0]["source"])

    def runtime(self):
        rt = pl.Runtime(self.root, self.root, self.m)
        calls = []
        def docker(*args, data=None, **kwargs):
            calls.append((args, data))
            return b"$argon2id$v=19$m=65536,t=3,p=1$YXNkZmFzZGZhc2RmYXNkZg$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY\n"
        rt.docker = docker
        return rt, calls

    def test_password_never_in_args_and_rerun_preserves_credentials(self):
        rt, calls = self.runtime()
        rt.credentials(self.cfg, None)
        files = {p.name: p.read_bytes() for p in (self.root / "private").iterdir()}
        password = files["initial-admin-password"]
        self.assertEqual(password, b"admin")
        self.assertEqual(calls[0][1], password)
        self.assertNotIn(password.decode(), " ".join(calls[0][0]))
        self.assertNotIn(password.decode(), json.dumps(rt.env))
        rt.credentials(self.cfg, None)
        self.assertEqual(len(calls), 1)
        self.assertEqual(files, {p.name: p.read_bytes() for p in (self.root / "private").iterdir()})
        self.assertEqual((self.root / "private").stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / "private/initial-admin-password").stat().st_mode & 0o777, 0o600)

    def test_missing_existing_db_secret_is_not_regenerated(self):
        rt, calls = self.runtime()
        rt.credentials(self.cfg, None)
        (self.root / "config/compose.json").write_text("{}")
        (self.root / "private/runtime.env").unlink()
        with self.assertRaisesRegex(ValueError, "restore"):
            rt.credentials(self.cfg, None)
        self.assertEqual(len(calls), 1)
        self.assertFalse((self.root / "private/runtime.env").exists())

    def test_password_file_requires_private_permissions_and_length(self):
        rt, calls = self.runtime()
        p = self.root / "input"
        p.write_text("bad")
        p.chmod(0o600)
        with self.assertRaises(ValueError):
            rt.credentials(self.cfg, p)
        p.write_text("a-valid-test-password")
        p.chmod(0o644)
        with self.assertRaises(ValueError):
            rt.credentials(self.cfg, p)
        self.assertEqual(calls, [])

    def test_atomic_write_refuses_symlink_and_retains_other_files(self):
        outside = self.root / "preserve"
        outside.write_text("keep")
        dest = self.root / "private/file"
        dest.symlink_to(outside)
        with self.assertRaises(ValueError):
            pl.write_file(dest, "replace")
        self.assertEqual(outside.read_text(), "keep")
        dest.unlink()
        (dest.parent / "file.new.stale").write_text("stale")
        pl.write_file(dest, "correct")
        self.assertEqual(dest.read_text(), "correct")
        self.assertEqual((dest.parent / "file.new.stale").read_text(), "stale")

    def test_foreign_root_is_refused_without_permissions_or_content_changes(self):
        foreign = self.root / "foreign"
        foreign.mkdir(mode=0o755)
        (foreign / "keep").write_text("unrelated")
        before = foreign.stat().st_mode
        with self.assertRaisesRegex(ValueError, "install.sh"):
            pl.managed_root(foreign)
        self.assertEqual(foreign.stat().st_mode, before)
        self.assertEqual({x.name for x in foreign.iterdir()}, {"keep"})

    def test_manifest_tamper_and_wrong_architecture_rejected(self):
        pkg = self.root / "package"
        pkg.mkdir()
        files = {}
        for name in pl.REQUIRED:
            (pkg / name).write_bytes(b"test")
            files[name] = hashlib.sha256(b"test").hexdigest()
        m = {"schema": 1, "product": "Pl", "version": "0.1.0-core.1", "architecture": "amd64",
             "files": files, "images": self.m["images"]}
        (pkg / "manifest.json").write_text(json.dumps(m))
        with patch.object(pl.platform, "machine", return_value="x86_64"):
            self.assertEqual(pl.manifest(pkg)["version"], "0.1.0-core.1")
            (pkg / "nginx.conf").write_text("tampered")
            with self.assertRaisesRegex(ValueError, "integrity"):
                pl.manifest(pkg)
        with patch.object(pl.platform, "machine", return_value="aarch64"), self.assertRaisesRegex(ValueError, "architecture"):
            pl.manifest(pkg)

    def bundled(self):
        source = "a" * 64
        labels = {"api": {}, "web": {},
                  "db": {"pl.component": "postgresql", "pl.postgresql.version": "18.6", "pl.gosu.version": "1.19", "pl.gosu.go.version": "1.27.2"},
                  "prometheus": {"pl.module.id": "prometheus", "pl.module.config.version": "1", "org.opencontainers.image.version": "3.15.0", "pl.build.go": "1.27.2", "pl.build.x-net": "v0.61.0"}}
        return {"schema": 2, "architecture": "amd64", "source_sha256": source,
                "features": {"module_controller": True, "local_users": True},
                "database": {"major": 18, "version": "18.6", "volume_target": "/var/lib/postgresql", "pgdata": "/var/lib/postgresql/18/docker"},
                "images": {name: {"id": "sha256:" + str(n) * 64, "architecture": "amd64", "ref": "pl/core-" + name + ":test",
                                  "recipe": "deploy/images/" + ("postgres" if name == "db" else name) + ".Dockerfile" if name in ("db", "prometheus") else "Dockerfile",
                                  "labels": {"pl.source.sha256": source, **values}}
                           for n, (name, values) in enumerate(labels.items(), 1)}}

    def test_bundled_runtime_rejects_missing_image_and_foreign_provenance(self):
        import copy
        good = self.bundled()
        pl.validate_bundled_images(good)
        for mutate in (lambda m: m["images"].pop("prometheus"),
                       lambda m: m["images"]["db"].update(id="postgres:latest"),
                       lambda m: m["images"]["prometheus"]["labels"].update({"pl.source.sha256": "b" * 64}),
                       lambda m: m["images"]["prometheus"].update(architecture="arm64"),
                       lambda m: m["database"].update(major=17),
                       lambda m: m["database"].update(volume_target="/var/lib/postgresql/data")):
            value = copy.deepcopy(good)
            mutate(value)
            with self.assertRaises(ValueError):
                pl.validate_bundled_images(value)

    def test_bundled_images_load_all_four_without_registry_pull(self):
        m = self.bundled()
        rt = pl.Runtime(self.root, self.root, m)
        calls = []
        def docker(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("image", "load"):
                return b"loaded"
            image = next(v for v in m["images"].values() if v["id"] == args[2])
            return json.dumps([{"Id": image["id"], "Architecture": "amd64", "Os": "linux", "Config": {"Labels": image["labels"]}}]).encode()
        rt.docker = docker
        rt.images()
        self.assertEqual(len(calls), 5)
        self.assertFalse(any(args[0] == "pull" for args in calls))
        m["images"]["prometheus"]["architecture"] = "arm64"
        # Actual image remains amd64; manifest validation rejects changed architecture.
        with self.assertRaises(ValueError):
            pl.validate_bundled_images(m)

    def test_bundled_images_verify_loaded_labels_not_just_content_id(self):
        m = self.bundled()
        rt = pl.Runtime(self.root, self.root, m)
        def docker(*args, **kwargs):
            if args[:2] == ("image", "load"):
                return b"loaded"
            return json.dumps([{"Id": args[2], "Architecture": "amd64", "Os": "linux", "Config": {"Labels": {}}}]).encode()
        rt.docker = docker
        with self.assertRaisesRegex(ValueError, "provenance"):
            rt.images()

    def test_pg18_uses_verified_image_and_fresh_major_data_path(self):
        m = self.bundled()
        (self.root / ".pl-installation.json").write_text(json.dumps({"gid": 997}))
        db = pl.compose_model(self.root, m, self.cfg, "pl-123456abcdef")["services"]["db"]
        self.assertEqual(db["image"], m["images"]["db"]["id"])
        self.assertEqual(db["volumes"], ["db:/var/lib/postgresql"])
        self.assertEqual(db["environment"]["PGDATA"], "/var/lib/postgresql/18/docker")
        self.assertEqual(pl.database_mount(self.m), "/var/lib/postgresql/data")

    def test_explicit_network_cidr_requires_canonical_rfc1918_slash24(self):
        for value in ("10.90.1.0/24", "172.23.40.0/24", "192.168.220.0/24"):
            cfg = pl.configuration("https://host", "127.0.0.1", "admin", value)
            self.assertEqual(cfg["network_cidr"], value)
        self.assertNotIn("network_cidr", self.cfg)
        for value in ("10.90.1.1/24", "10.90.1.0/25", "10.90.1.0/255.255.255.0", "10.90.1.0", "8.8.8.0/24",
                      "100.64.1.0/24", "127.0.0.0/24", "169.254.1.0/24", "172.32.1.0/24", "fc00::/24", " 10.90.1.0/24", "10.90.01.0/24"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                pl.configuration("https://host", "127.0.0.1", "admin", value)

    def test_explicit_core_networks_are_three_disjoint_slash26(self):
        self.m["features"]["module_controller"] = True
        (self.root / ".pl-installation.json").write_text(json.dumps({"gid": 997}))
        cfg = dict(self.cfg, network_cidr="10.90.1.0/24")
        networks = pl.compose_model(self.root, self.m, cfg, "pl-123456abcdef")["networks"]
        for name, subnet, gateway in (("backend", "10.90.1.0/26", "10.90.1.1"), ("ingress", "10.90.1.64/26", "10.90.1.65"), ("egress", "10.90.1.128/26", "10.90.1.129")):
            self.assertEqual(networks[name]["driver"], "bridge")
            self.assertEqual(networks[name]["ipam"], {"driver": "default", "config": [{"subnet": subnet, "gateway": gateway}]})
            self.assertEqual(networks[name].get("internal", False), name == "backend")
        legacy = pl.compose_model(self.root, self.m, self.cfg, "pl-123456abcdef")
        self.assertTrue(all("ipam" not in value and "driver" not in value for value in legacy["networks"].values()))

    def network_inventory(self, networks=None, routes=None, installation=None, cfg=None):
        values = networks or []
        def read(args, **kwargs):
            if args[0] == "ip":
                self.assertEqual(args, ["ip", "-j", "-4", "route", "show", "table", "all"])
                body = json.dumps(routes or []).encode()
            elif args[3:] == ["network", "ls", "--quiet", "--no-trunc"]:
                body = ("\n".join(obj["Id"] for obj in values)).encode()
            else:
                self.assertEqual(args[3:5], ["network", "inspect"])
                body = json.dumps([next(obj for obj in values if obj["Id"] == args[5])]).encode()
            return types.SimpleNamespace(returncode=0, stdout=body)
        rt = pl.Runtime(self.root, self.root, self.m)
        with patch.object(pl.subprocess, "run", side_effect=read):
            rt.network_preflight(cfg or dict(self.cfg, network_cidr="10.90.1.0/24"), installation)
        self.assertFalse((self.root / "private/last-command.log").exists())

    def owned_network(self):
        return {"Id": "a" * 64, "Name": "pl-123456abcdef_backend", "Driver": "bridge", "Scope": "local", "Internal": True,
                "Labels": {"pl.installation": "pl-123456abcdef", "com.docker.compose.project": "pl-123456abcdef", "com.docker.compose.network": "backend"},
                "IPAM": {"Driver": "default", "Config": [{"Subnet": "10.90.1.0/26", "Gateway": "10.90.1.1"}]}}

    def owned_routes(self, dev="br-aaaaaaaaaaaa"):
        return [{"dst": "10.90.1.0/26", "dev": dev, "protocol": "kernel", "scope": "link", "prefsrc": "10.90.1.1"},
                {"type": "local", "dst": "10.90.1.1", "dev": dev, "protocol": "kernel", "scope": "host", "prefsrc": "10.90.1.1"},
                {"type": "broadcast", "dst": "10.90.1.0", "dev": dev, "protocol": "kernel", "scope": "link", "prefsrc": "10.90.1.1"},
                {"type": "broadcast", "dst": "10.90.1.63", "dev": dev, "protocol": "kernel", "scope": "link", "prefsrc": "10.90.1.1"}]

    def test_network_preflight_allows_free_block_and_skips_default_only(self):
        self.network_inventory(routes=[{"dst": "default", "gateway": "192.0.2.1", "dev": "eth0"},
                                       {"dst": "192.0.2.0/24", "dev": "eth0", "scope": "link"}])
        with patch.object(pl.subprocess, "run") as run:
            pl.Runtime(self.root, self.root, self.m).network_preflight(self.cfg)
            run.assert_not_called()

    def test_network_preflight_rejects_physical_vpn_and_docker_overlap(self):
        for route in ({"dst": "10.0.0.0/8", "dev": "wg0"}, {"dst": "10.90.1.0/24", "dev": "eth0"},
                      {"dst": "10.90.1.220/32", "dev": "tun0"}, {"dst": "10.90.1.1", "type": "local", "dev": "eth0"}):
            with self.subTest(route=route), self.assertRaisesRegex(ValueError, "route"):
                self.network_inventory(routes=[route])
        foreign = self.owned_network(); foreign["Name"] = "another_backend"
        with self.assertRaisesRegex(ValueError, "Docker network"):
            self.network_inventory(networks=[foreign])

    def test_network_preflight_repeat_allows_exact_own_kernel_bridge_routes(self):
        self.network_inventory(networks=[self.owned_network()], routes=self.owned_routes(), installation="pl-123456abcdef")
        explicit = self.owned_network(); explicit["Options"] = {"com.docker.network.bridge.name": "pl-test-br"}
        self.network_inventory(networks=[explicit], routes=self.owned_routes("pl-test-br"), installation="pl-123456abcdef")

    def test_network_preflight_does_not_broadly_trust_owned_bridge_or_labels(self):
        for mutate in (lambda n: n["Labels"].update({"pl.installation": "pl-000000000000"}),
                       lambda n: n["Labels"].update({"com.docker.compose.project": "another"}),
                       lambda n: n["IPAM"]["Config"][0].update(Subnet="10.90.1.0/25")):
            network = self.owned_network(); mutate(network)
            with self.assertRaises(ValueError):
                self.network_inventory(networks=[network], installation="pl-123456abcdef")
        for route in ({"dst": "10.90.1.0/26", "dev": "eth0", "protocol": "kernel", "scope": "link"},
                      {"dst": "10.90.1.0/24", "dev": "br-aaaaaaaaaaaa", "protocol": "kernel", "scope": "link"},
                      {"dst": "10.90.1.2", "type": "local", "dev": "br-aaaaaaaaaaaa", "protocol": "kernel", "scope": "host"},
                      {"dst": "10.90.1.1", "type": "local", "dev": "br-aaaaaaaaaaaa", "protocol": "static", "scope": "host"}):
            with self.assertRaisesRegex(ValueError, "route"):
                self.network_inventory(networks=[self.owned_network()], routes=[route], installation="pl-123456abcdef")

    def test_repeated_preflight_accepts_only_owned_module_subnet_and_its_kernel_routes(self):
        instance = "123e4567-e89b-42d3-a456-426614174000"
        network = {"Id": "b" * 64, "Name": "pl-123456abcdef-forms-" + instance + "-net",
            "Driver": "bridge", "Scope": "local", "Internal": True, "Ingress": False, "Options": {},
            "Labels": {"pl.installation": "pl-123456abcdef", "pl.module": "forms", "pl.instance": instance,
                       "pl.module.network.version": "1", "pl.module.network.subnet": "10.90.1.192/29"},
            "IPAM": {"Driver": "default", "Config": [{"Subnet": "10.90.1.192/29", "Gateway": "10.90.1.193"}]}, "Containers": {}}
        routes = [{"dst": "10.90.1.192/29", "dev": "br-bbbbbbbbbbbb", "protocol": "kernel", "scope": "link", "prefsrc": "10.90.1.193"},
                  {"dst": "10.90.1.193", "dev": "br-bbbbbbbbbbbb", "protocol": "kernel", "scope": "host", "type": "local"}]
        self.network_inventory([network], routes, "pl-123456abcdef")
        for changes in ({"pl.installation": "foreign"}, {"pl.module.network.version": "2"}, {"pl.module.network.subnet": "10.90.1.200/29"}):
            altered = json.loads(json.dumps(network)); altered["Labels"].update(changes)
            with self.assertRaises(ValueError):
                self.network_inventory([altered], routes, "pl-123456abcdef")
        for altered in (dict(routes[0], dev="eth0"), dict(routes[0], dst="10.90.1.192/26")):
            with self.assertRaises(ValueError):
                self.network_inventory([network], [altered], "pl-123456abcdef")
        with self.assertRaises(ValueError):
            self.network_inventory([network], routes)  # Fresh installation cannot borrow another installation's subnet.

    def test_additional_module_pool_is_optional_and_preflight_reserves_entire_range(self):
        cfg = pl.configuration("https://192.0.2.5:8443", "127.0.0.1", "admin", "10.90.1.0/24", "10.90.2.0/24")
        self.assertEqual(cfg["module_network_cidr"], "10.90.2.0/24")
        self.assertNotIn("module_network_cidr", self.cfg)
        self.network_inventory(cfg=dict(self.cfg, module_network_cidr="10.90.2.0/24"))
        with self.assertRaisesRegex(ValueError, "route"):
            self.network_inventory(routes=[{"dst": "10.90.2.0/24", "dev": "vpn0"}], cfg=cfg)
        with self.assertRaises(ValueError):
            pl.configuration("https://192.0.2.5:8443", "127.0.0.1", "admin", "10.90.1.0/24", "10.90.1.0/24")

    def test_forms_without_xray_controller_unit_allows_netlink_only_when_needed(self):
        for features, expected in (({"forms_module": True, "xray_module": False}, "AF_UNIX AF_INET AF_INET6 AF_NETLINK"),
                                   ({"module_controller": True}, "AF_UNIX AF_INET AF_INET6")):
            with self.subTest(features=features):
                key = MagicMock()
                key.exists.return_value = True
                key.is_symlink.return_value = False
                key.is_file.return_value = True
                key.read_bytes.return_value = bytes(32)
                key.stat.return_value = types.SimpleNamespace(st_uid=0)
                private = MagicMock()
                private.__truediv__.return_value = key
                rt = types.SimpleNamespace(m={"schema": 1, "features": features}, private=private,
                                           root=self.root, package=self.root, install_id="pl-123456abcdef", run=Mock())
                with patch.object(pl, "read_json", return_value={"gid": 10001}), patch.object(pl, "directory"), \
                     patch.object(pl.os, "chown"), patch.object(pl.Path, "exists", return_value=False), \
                     patch.object(pl.Path, "is_socket", return_value=True), \
                     patch.object(pl, "write_file") as write:
                    pl.prepare_module_controller(rt)
                unit = write.call_args.args[1]
                self.assertIn("RestrictAddressFamilies=" + expected + "\n", unit)
                self.assertIn("ProtectSystem=strict\n", unit)
                self.assertIn("NoNewPrivileges=true\n", unit)
                self.assertIn("ProtectKernelTunables=true\nProtectKernelModules=true\n", unit)


if __name__ == "__main__":
    unittest.main()
