"""VPN artifacts use an explicit source set and preserve the operator's TLS/DTLS binding."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), BASE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OcservPackageTests(unittest.TestCase):
    def test_portable_source_contract(self):
        package, delivery = load("package"), load("delivery")
        meta = package.application_metadata(BASE.parent / package.PREFIX, "ocserv")
        self.assertEqual(meta["version"], delivery.PINNED_SERVERS["ocserv"])
        self.assertEqual(set(meta["images"]), {"ocserv-server"})
        self.assertTrue(all(package.application_source_allowed("ocserv", path) for path in package.OCSERV_RUNTIME))
        for name in ("operator/server.key", "operator/oidc.json", "server.crt", "data/policy.sqlite", "credentials.json"):
            self.assertFalse(package.application_source_allowed("ocserv", "apps/ocserv/" + name))
        old = {"modules": {}}
        self.assertEqual(delivery.catalog_modules(old), {})
        old["module_extensions"] = {"ocserv": {"version": meta["version"]}}
        self.assertEqual(delivery.catalog_modules(old), old["module_extensions"])

    def test_patches_are_in_the_module_source_with_their_recorded_digests(self):
        package = load("package")
        source = BASE.parent / package.PREFIX
        upstream = package.application_metadata(source, "ocserv")["upstream"]
        for field in ("pl_patch", "pl_test_patch"):
            with self.subTest(field=field):
                patch = upstream[field]
                self.assertIn(patch, package.APPLICATION_REQUIRED["ocserv"])
                self.assertEqual(hashlib.sha256((source / patch).read_bytes()).hexdigest(), upstream[field + "_sha256"])

    def test_existing_gateway_requires_its_recovery_registry(self):
        dr = load("disaster-recovery")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "modules/ocserv/instances/record").mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, "ocserv.*registry"):
                dr.require_native_registries(root, {})
            dr.require_native_registries(root, {"ocserv": {}})

    def test_recovery_restores_matched_tls_and_dtls_on_an_explicit_ipv4_address(self):
        dr = load("disaster-recovery")
        def port(address, value="4443"):
            return [{"HostIp": address, "HostPort": value}]
        for address in ("192.0.2.41", "127.0.0.1"):
            dr.validate_bindings("ocserv", {"4443/tcp": port(address), "4443/udp": port(address)})
        dr.validate_bindings("ocserv", {})
        for ports in ({"4443/tcp": port("192.0.2.41")}, {"4443/tcp": port("0.0.0.0"), "4443/udp": port("0.0.0.0")},
                      {"4443/tcp": port("192.0.2.41"), "4443/udp": port("192.0.2.42")},
                      {"4443/tcp": port("192.0.2.41"), "4443/udp": port("192.0.2.41", "0")}):
            with self.subTest(ports=ports), self.assertRaises(ValueError):
                dr.validate_bindings("ocserv", ports)


if __name__ == "__main__":
    unittest.main()
