"""Prepare and verify the Bootimus x86 firmware selection from pinned upstream inputs."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile


def put(archive, name, data):
    entry = tarfile.TarInfo(name)
    entry.mode = 0o644
    entry.size = len(data)
    archive.addfile(entry, io.BytesIO(data))


def prepare(inputs, destination):
    with tarfile.open(inputs / "bootimus-c1b3328.tar.gz") as upstream, tarfile.open(inputs / "ipxeboot-v2.0.0.tar.gz") as ipxe:
        with destination.open("wb") as out, gzip.GzipFile(filename="", fileobj=out, mode="wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w|") as tar:
            for item in upstream:
                name = item.name.partition("/")[2]
                if not item.isfile():
                    continue
                if (name.startswith(("cmd/", "internal/", "web/"))
                        or name.startswith(("bootloaders/", "raspberrypi/")) and name.endswith(".go")
                        or name in {"main.go", "go.mod", "go.sum", "LICENSE", "raspberrypi/assets/config.txt"}):
                    put(tar, name, upstream.extractfile(item).read())
            bios = upstream.extractfile("bootimus-c1b33282c695cff79cb348c80d303a101db7b8b3/bootloaders/default/undionly.kpxe").read()
            wimboot = (inputs / "wimboot-2.9.0").read_bytes()
            shim = (inputs / "shimx64-dual-16.1.efi").read_bytes()
            for name, driver in (("default", "ipxe"), ("secureboot-official", "ipxe"), ("secureboot-official-snp", "snponly")):
                secure = name != "default"
                efi = ipxe.extractfile("ipxeboot/" + ("x86_64-sb/" if secure else "x86_64/") + driver + ".efi").read()
                loader = "ipxe-shimx64.efi" if secure else "bootimus.efi"
                files = {"undionly.kpxe": bios, "ipxe.efi": efi, "wimboot": wimboot, loader: shim if secure else efi}
                for filename, data in files.items():
                    put(tar, "bootloaders/" + name + "/" + filename, data)
                manifest = {"name": name, "description": "PL office x86 firmware selection", "bootfiles": {"bios": "undionly.kpxe", "uefi": loader}}
                put(tar, "bootloaders/" + name + "/manifest.json", json.dumps(manifest).encode())
    # Verify the uncompressed tar stream. Its gzip encoding varies across zlib versions.
    with gzip.open(destination) as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != "f84c6395c2a81c9ab9d00127375aa43a0c62dc73a473d66161aa504f52405122":
        raise ValueError("Prepared Bootimus source digest differs")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]), Path(sys.argv[2]))
