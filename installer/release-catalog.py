#!/usr/bin/env python3
"""Sign a finite PL release catalog from the exact immutable artifact files."""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
URL = "https://github.com/Sauke5/pl/releases/download/v"


def metadata(path, name):
    with tarfile.open(path, "r|gz") as archive:
        first = archive.next()
        if first is None or first.name != name or not first.isfile() or first.size > 1024**2:
            raise ValueError("Artifact manifest must be its first bounded regular member")
        return json.load(archive.extractfile(first))


def artifact(path, version):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]+", path.name) or path.is_symlink() or not path.is_file():
        raise ValueError("Unsafe release artifact")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024**2), b""):
            digest.update(chunk)
    return {"url": URL + version + "/" + path.name, "size": path.stat().st_size, "sha256": digest.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--sequence", type=int, required=True)
    parser.add_argument("--core", type=Path, action="append", required=True)
    parser.add_argument("--module", type=Path, action="append", default=[])
    parser.add_argument("--signing-key-file", type=Path, required=True)
    parser.add_argument("--expires-days", type=int, default=90)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if (not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9][A-Za-z0-9.-]*)?", args.version)
            or args.sequence < 1 or not 1 <= args.expires_days <= 366):
        raise ValueError("Invalid catalog identity")
    key = args.signing_key_file.resolve()
    if args.signing_key_file.is_symlink() or not key.is_file() or key.stat().st_mode & 0o077:
        raise ValueError("Signing key must be a private regular file")
    public_key = ROOT / "installer/release-signing-public.pem"
    actual_public = subprocess.check_output(["openssl", "pkey", "-in", str(key), "-pubout"], cwd=ROOT)
    if actual_public != public_key.read_bytes():
        raise ValueError("Signing key differs from the pinned PL release identity")
    value = {"schema": 1, "product": "PL", "sequence": args.sequence, "core_api": 1, "version": args.version,
             "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "expires_at": int(time.time()) + args.expires_days * 86400, "core": {}, "modules": {}}
    for path in args.core:
        m = metadata(path, "manifest.json")
        if m.get("product") != "PL" or m.get("version") != args.version or not m.get("features", {}).get("on_demand_modules") or set(m.get("images", {})) != {"api", "web", "db"}:
            raise ValueError("Catalog core must match the exact minimal release")
        arch = m["architecture"]
        if arch not in ("amd64", "arm64") or arch in value["core"]:
            raise ValueError("Duplicate or unsupported core architecture")
        value["core"][arch] = artifact(path, args.version)
    for path in args.module:
        m = metadata(path, "module.json")
        if m.get("product") != "PL" or m.get("kind") != "module" or m.get("core_api") != 1:
            raise ValueError("Catalog module must use the compatible module contract")
        entry = value["modules"].setdefault(m["module_id"], {"version": m["version"], "core_api": 1, "artifacts": {}})
        if entry["version"] != m["version"] or m["architecture"] in entry["artifacts"]:
            raise ValueError("Duplicate or incompatible module versions")
        entry["artifacts"][m["architecture"]] = artifact(path, m["package_version"])
    payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    with tempfile.TemporaryDirectory(prefix="pl-release-sign-") as temporary:
        source = Path(temporary) / "catalog.json"
        source.write_bytes(payload)
        signature = subprocess.check_output(["openssl", "pkeyutl", "-sign", "-inkey", str(key), "-rawin", "-in", str(source)], cwd=ROOT)
    if len(signature) != 64:
        raise ValueError("Ed25519 signature required")
    envelope = {"payload": base64.b64encode(payload).decode(), "signature": base64.b64encode(signature).decode()}
    spec = importlib.util.spec_from_file_location("pl_catalog_validation", ROOT / "installer/delivery.py")
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    validator.verify_catalog(envelope, public_key)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as output:
        json.dump(envelope, output, indent=2)
        output.write("\n")
    print("Signed PL " + args.version + ", sequence " + str(args.sequence) + ", architectures " + ",".join(value["core"]))


if __name__ == "__main__":
    main()
