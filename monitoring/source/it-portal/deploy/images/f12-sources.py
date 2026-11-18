"""Download and verify the pinned F12 build inputs or corresponding source files."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import urllib.request


ROOT = Path(__file__).resolve().parent


def verified(path, record):
    if not path.is_file() or path.stat().st_size != record["bytes"]:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == record["sha256"]


def fetch(root, name, record):
    path = root / name
    if Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError("Invalid locked source path")
    path.parent.mkdir(parents=True, exist_ok=True)
    if verified(path, record):
        return
    for attempt in range(3):
        for url in record["urls"]:
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "PL-F12-build/1"})
                with urllib.request.urlopen(request, timeout=60) as response, tempfile.NamedTemporaryFile(
                    dir=path.parent, prefix=".download-", delete=False
                ) as out:
                    try:
                        shutil.copyfileobj(response, out, length=1024 * 1024)
                        out.flush()
                        if not verified(Path(out.name), record):
                            raise ValueError("Checksum or size mismatch")
                        os.replace(out.name, path)
                    finally:
                        Path(out.name).unlink(missing_ok=True)
                return
            except (ValueError, OSError) as exc:
                error = exc
        time.sleep(attempt + 1)
    raise RuntimeError("Could not verify " + name) from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=("sources", "runtime", "windows-build"))
    parser.add_argument("--architecture", choices=("amd64", "arm64"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.component == "sources":
        records = json.loads((ROOT / "f12-source-lock.json").read_text())["files"]
    else:
        if not args.architecture:
            parser.error(args.component + " needs --architecture")
        lock = json.loads((ROOT / "f12-runtime.json").read_text())
        if args.component == "windows-build":
            records = lock["windows_build"][args.architecture]
        else:
            records = dict(lock["origin"])
            records.update({"python/" + name: value for name, value in lock.get("python", {}).items()})
            records.update({"packages/" + name: value for name, value in lock["packages"][args.architecture].items()})
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda pair: fetch(args.output, *pair), records.items()))
    print(f"Verified {len(records)} files, {sum(item['bytes'] for item in records.values())} bytes")


if __name__ == "__main__":
    main()
