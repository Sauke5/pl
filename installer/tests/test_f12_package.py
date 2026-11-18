"""Optional F12 source selection and immutable image lookup across Docker stores."""
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

BASE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, BASE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


delivery, package = load("delivery"), load("package")


class F12PackageTests(unittest.TestCase):
    def test_runtime_source_selection_is_finite(self):
        portal = BASE.parent / package.PREFIX
        metadata = package.application_metadata(portal, "f12")
        self.assertEqual(metadata["version"], "0.1.81")
        self.assertEqual(set(metadata["images"]), {"f12-server"})
        self.assertEqual(metadata["images"]["f12-server"]["labels"]["pl.f12.pxe.version"], "1")
        for name in package.F12_RUNTIME | package.F12_PXE | package.F12_STRELEC:
            self.assertTrue(package.application_source_allowed("f12", name))
        for name in ("apps/f12/tests/test_native.py", "apps/f12/debug.py", "apps/f12/data/image.iso",
                     "apps/f12/future.sh", "apps/f12/pxe/unselected.go", "apps/f12/strelec/unselected.exe",
                     "apps/f12/strelec/recovery.iso", "apps/f12/SOURCE-SNAPSHOT.json"):
            self.assertFalse(package.application_source_allowed("f12", name))
        for name in package.F12_BUILD:
            self.assertTrue((portal / name).is_file())
        self.assertTrue((portal / "deploy/images/f12.LICENSE").read_text(encoding="utf-8"))

    def test_bios_wimboot_build_inputs_match_the_corresponding_sources(self):
        portal = BASE.parent / package.PREFIX
        provenance = package.application_metadata(portal, "f12")["upstream"]
        bios = provenance["wimboot_bios"]
        images = portal / "deploy/images"
        runtime = json.loads((images / provenance["runtime_inputs"]).read_text())["origin"]
        sources = json.loads((images / provenance["corresponding_sources"]).read_text())["files"]
        archive = images / bios["packaged_source"]
        locked = sources[bios["archive"]]
        self.assertIn("deploy/images/" + archive.name, package.F12_BUILD)
        self.assertEqual(archive.stat().st_size, locked["bytes"])
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), locked["sha256"])
        signed = "wimboot-" + bios["version"]
        self.assertEqual(runtime[signed], sources["firmware/" + signed])
        self.assertNotEqual(bios["sha256"], runtime[signed]["sha256"])
        self.assertIn("deploy/images/" + bios["patch"], package.F12_BUILD)
        recipe = (portal / package.APPLICATION_RECIPES["f12"]).read_text()
        self.assertIn(bios["builder"], recipe)
        self.assertIn(bios["target"], recipe)

    def test_old_pxe_descriptor_remains_passive_and_unknown_version_is_rejected(self):
        metadata = package.application_metadata(BASE.parent / package.PREFIX, "f12")
        target = self.root / package.APPLICATION_METADATA["f12"]
        target.parent.mkdir(parents=True)
        labels = metadata["images"]["f12-server"]["labels"]
        del labels["pl.f12.pxe.version"]
        target.write_text(json.dumps(metadata))
        self.assertEqual(package.application_metadata(self.root, "f12"), metadata)
        labels["pl.f12.pxe.version"] = "2"
        target.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, "PXE worker contract"):
            package.application_metadata(self.root, "f12")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.labels = {"pl.module.id": "f12", "pl.module.role": "server", "pl.source.sha256": "a" * 64}

    def image_archive(self, *, kind="f12", duplicate=False, corrupt=False):
        blobs = {}
        labels = {**self.labels, "pl.module.id": kind}

        def blob(value):
            body = json.dumps(value, sort_keys=True).encode()
            sha = hashlib.sha256(body).hexdigest()
            blobs["blobs/sha256/" + sha] = body
            return {"digest": "sha256:" + sha, "size": len(body)}

        config = blob({"config": {"Labels": labels}, "architecture": "amd64", "os": "linux"})
        manifest = blob({"config": config, "layers": []})
        supported = {**manifest, "platform": {"architecture": "amd64", "os": "linux"}}
        extra = supported if duplicate else {**manifest, "platform": {"architecture": "unknown", "os": "unknown"}}
        root = blob({"manifests": [supported, extra]})
        blobs["index.json"] = json.dumps({"manifests": [root]}).encode()
        if corrupt:
            blobs["blobs/sha256/" + config["digest"][7:]] += b" "
        with tarfile.open(self.root / "images.tar", "w") as archive:
            for name, body in blobs.items():
                member = tarfile.TarInfo(name)
                member.size = len(body)
                archive.addfile(member, io.BytesIO(body))
        image = {"id": root["digest"], "labels": labels, "architecture": "amd64"}
        return {"module_id": kind, "images": {kind + "-server": image}}, config["digest"], manifest["digest"]

    def test_classic_and_containerd_keep_the_exact_signed_content_identity(self):
        for kind in ("f12", "ocserv", "syslog"):
            meta, config_id, manifest_id = self.image_archive(kind=kind)
            role = kind + "-server"
            image = meta["images"][role]
            for local_id in (image["id"], config_id, manifest_id):
                with self.subTest(kind=kind, identity=local_id):
                    def verify(images):
                        if images[role]["id"] != local_id:
                            raise ValueError("image unavailable by that digest")
                    selected = copy.deepcopy(meta)
                    delivery.Delivery.verify_module_images(types.SimpleNamespace(verify_images=verify), selected, self.root)
                    self.assertEqual(selected["images"][role], {**image, "id": local_id})

    def test_unrelated_digests_corrupt_blobs_and_ambiguous_platforms_are_refused(self):
        for options, changes in (({}, {"id": "sha256:" + "f" * 64}), ({}, {"architecture": "arm64"}),
                                 ({}, {"labels": {"pl.module.id": "other"}}), ({"duplicate": True}, {}), ({"corrupt": True}, {})):
            with self.subTest(options=options, changes=changes):
                meta, _, _ = self.image_archive(**options)
                with self.assertRaises(ValueError):
                    delivery.f12_archive_identities(self.root / "images.tar", {**meta["images"]["f12-server"], **changes})


if __name__ == "__main__":
    unittest.main()
