#!/usr/bin/env python3
"""Collect installed, locked Go/npm license texts without copying dependency code."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "monitoring/source/it-portal"


def licenses(directory):
    if not directory.is_dir():
        return []
    return sorted(p for p in directory.iterdir() if p.is_file() and p.name.lower().split(".")[0] in
                  {"license", "licence", "copying", "copyright", "notice", "license-mit", "license-apache", "license-bsd"})


def add(parts, name, version, files, metadata=""):
    parts.append("\n" + "=" * 72 + "\n" + name + " " + version + (" — " + metadata if metadata else "") + "\n")
    for path in files:
        parts.append("\n[" + path.name + "]\n" + path.read_text(errors="replace").strip() + "\n")


def collect():
    parts = ["PL third-party notices\n\nOriginal PL sources use MIT; dependencies retain the following notices.\n"
             "Build dependencies are included for source reproducibility. This file does not change their licenses.\n"]
    goroot = Path(subprocess.check_output(["go", "env", "GOROOT"], text=True, cwd=ROOT).strip())
    go_license = next((p for p in (goroot / "LICENSE", goroot.parent / "LICENSE") if p.is_file()), None)
    if go_license is None:
        raise ValueError("Go distribution LICENSE is unavailable")
    add(parts, "Go standard library", "", [go_license])
    runtime = CORE / "deploy/licenses"
    for name, version, names in (("iperf3", "3.20", ("iperf3.LICENSE",)),
                                  ("musl libc", "", ("musl.COPYRIGHT",)),
                                  ("OpenSSL", "3.x", ("openssl.LICENSE", "openssl.AUTHORS"))):
        add(parts, name, version, [runtime / name for name in names])
    raw = subprocess.check_output(["go", "-C", str(CORE), "list", "-m", "-json", "all"], text=True, cwd=ROOT)
    decoder, position = json.JSONDecoder(), 0
    missing = []
    while position < len(raw):
        while position < len(raw) and raw[position].isspace():
            position += 1
        if position >= len(raw):
            break
        module, position = decoder.raw_decode(raw, position)
        if module.get("Main"):
            continue
        directory = module.get("Dir")
        texts = licenses(Path(directory)) if directory else []
        if not texts:
            # go list need not populate transitive modules' Dir until downloaded.
            info = json.loads(subprocess.check_output(["go", "-C", str(CORE), "mod", "download", "-json", module["Path"] + "@" + module["Version"]], text=True, cwd=ROOT))
            texts = licenses(Path(info["Dir"]))
        if not texts:
            missing.append(module["Path"])
        add(parts, module["Path"], module.get("Version", ""), texts)
    npm = CORE / "frontend/node_modules"
    entries = []
    for path in npm.iterdir():
        if path.name.startswith("."):
            continue
        candidates = path.iterdir() if path.name.startswith("@") and path.is_dir() else [path]
        for candidate in candidates:
            if not (candidate / "package.json").is_file():
                continue
            package = json.loads((candidate / "package.json").read_text())
            if package.get("name", "").startswith("@pl/"):
                continue
            entries.append((package, candidate))
    for package, directory in sorted(entries, key=lambda p: p[0].get("name", "")):
        texts = licenses(directory)
        if package.get("name", "").startswith("@rolldown/binding-"):
            texts = licenses(npm / "rolldown")
        if package.get("name") == "react-remove-scroll-bar":
            supplied = CORE / "deploy/licenses/react-remove-scroll-bar.LICENSE"
            if supplied.is_file():
                texts = [supplied]
        license_id = package.get("license", "")
        if isinstance(license_id, dict):
            license_id = license_id.get("type", "")
        if not texts:
            missing.append(package["name"])
        add(parts, package["name"], package.get("version", ""), texts, str(license_id))
    if missing:
        print("No root license text (inspect upstream/package inheritance): " + ", ".join(sorted(missing)))
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()) + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=CORE / "THIRD_PARTY_NOTICES")
    args = parser.parse_args()
    args.output.write_text(collect())
