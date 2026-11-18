"""Private Bootimus administration and verified references to its HTTP artifacts."""

import hashlib
import http.client
import json
import os
import re
import shutil
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from winpe_profile import HIRENS_RECIPE, wim_reference

ORIGIN_HOST = os.environ.get("PL_F12_ORIGIN_HOST", "127.0.0.1")
ORIGIN_KEY = Path(os.environ.get("PL_F12_ORIGIN_KEY", "/data/origin.key"))
STAGE = Path(os.environ.get("PL_F12_STAGE", "/data/staging"))
ISO_DIR = Path("/data/isos")
CHUNK = 256 * 1024
DISK_RESERVE = 128 * 1024**2
SYSTEMRESCUE_FILES = (
    "sysresccd/x86_64/airootfs.sfs",
    "sysresccd/x86_64/airootfs.sha512",
    "sysresccd/boot/intel_ucode.img",
    "sysresccd/boot/amd_ucode.img",
)


class BootError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def origin_call(method, path, data=None, token=None, timeout=120):
    conn = http.client.HTTPConnection(ORIGIN_HOST, 8081, timeout=timeout)
    try:
        body = None if data is None else json.dumps(data).encode()
        headers = {"Authorization": "Bearer " + token} if token else {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body, headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read())
        if resp.status != 200 or payload.get("success") is False:
            raise BootError(502, "Bootimus не смог выполнить операцию.")
        return payload.get("data", {})
    finally:
        conn.close()


def admin_token(timeout=120):
    result = origin_call(
        "POST",
        "/api/login",
        {
            "username": "admin",
            "password": ORIGIN_KEY.read_text().strip(),
            "auth_method": "local",
        },
        timeout=timeout,
    )
    return result["token"]


def upload(file, name, size, token):
    boundary = "pl" + uuid.uuid4().hex
    origin_filename = "UTF-8''" + quote(name, safe="")
    prefix = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="public"\r\n\r\nfalse\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.iso"; filename*={origin_filename}\r\nContent-Type: application/octet-stream\r\n\r\n'
    ).encode()
    suffix = f"\r\n--{boundary}--\r\n".encode()
    conn = http.client.HTTPConnection(ORIGIN_HOST, 8081, timeout=150)
    try:
        conn.putrequest("POST", "/api/images/upload")
        conn.putheader("Authorization", "Bearer " + token)
        conn.putheader("Content-Type", "multipart/form-data; boundary=" + boundary)
        conn.putheader("Content-Length", str(len(prefix) + size + len(suffix)))
        conn.endheaders()
        conn.send(prefix)
        for chunk in iter(lambda: file.read(CHUNK), b""):
            conn.send(chunk)
        conn.send(suffix)
        resp = conn.getresponse()
        resp.read()
        if resp.status not in (200, 201, 409):
            raise BootError(502, "Bootimus не принял ISO.")
    finally:
        conn.close()


def upstream_hash(path):
    conn = http.client.HTTPConnection(ORIGIN_HOST, 8080, timeout=60)
    try:
        conn.request("GET", path)
        r = conn.getresponse()
        if r.status != 200:
            raise BootError(502, "Bootimus не вернул загруженный ISO.")
        h = hashlib.sha256()
        for chunk in iter(lambda: r.read(CHUNK), b""):
            h.update(chunk)
        return h.hexdigest()
    finally:
        conn.close()


def artifact(origin, relative):
    if (
        not relative
        or len(relative) > 1024
        or "\\" in relative
        or any(ord(c) < 32 for c in relative)
    ):
        raise BootError(502, "Bootimus не определил загрузочный файл.")
    value = PurePosixPath(relative)
    if value.is_absolute():
        root = PurePosixPath("/data/isos") / Path(origin).stem
        if not value.is_relative_to(root):
            raise BootError(502, "Файл не принадлежит этому образу.")
        value = value.relative_to(root)
    parts = value.parts
    if not parts or any(x in (".", "..") for x in parts):
        raise BootError(502, "Некорректный путь загрузочного файла.")
    return (
        "/boot/"
        + quote(Path(origin).stem, safe="")
        + "/"
        + "/".join(quote(s, safe="") for s in parts)
    )


def require_artifacts(paths):
    for path in paths:
        conn = http.client.HTTPConnection(ORIGIN_HOST, 8080, timeout=30)
        try:
            conn.request("HEAD", path)
            response = conn.getresponse()
            if (
                response.status != 200
                or int(response.getheader("Content-Length", "0")) <= 0
            ):
                raise BootError(
                    422,
                    "В этом ISO отсутствует файл, необходимый для сетевой загрузки.",
                )
        finally:
            conn.close()


def choose_origin(rows, name, size, ident):
    candidates = {row["filename"]: row for row in rows}
    stem = Path(name).stem
    while len(stem.encode()) > 170:
        stem = stem[:-1]
    origin = name
    count = 0
    while origin in candidates:
        expected = candidates[origin]
        if (
            expected.get("size") == size
            and upstream_hash("/isos/" + quote(origin, safe="")) == ident
        ):
            return origin, True
        count += 1
        suffix = ident[:16] if count == 1 else f"{ident[:16]}-{count}"
        origin = f"{stem} ({suffix}).iso"
    return origin, False


def prepare_local(file, size, ident, name, layout):
    result = prepare(file, size, ident, name, layout, place=publish_to_origin)
    wim = wim_reference(file, layout.get("hirens"), STAGE, DISK_RESERVE)
    if wim:
        return result[0], "", wim, HIRENS_RECIPE
    return result


def publish_to_origin(file, name, _size, _token):
    # Bootimus scans its ISO directory when listing images. Link only the completed,
    # fsynced spool file; SQLite publication and network access are committed later.
    # Both directories belong to the same persistent /data volume.
    try:
        os.link(file.name, ISO_DIR / name)
    except FileExistsError:
        pass  # A previous preparation may have completed this step before restart.
    directory = os.open(ISO_DIR, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def prepare(file, size, ident, name, layout, place=upload):
    token = admin_token()
    rows = origin_call("GET", "/api/images", token=token)
    origin, present = choose_origin(rows, name, size, ident)
    if not present:
        file.seek(0)
        place(file, origin, size, token)
    iso = "/isos/" + quote(origin, safe="")
    if not present and upstream_hash(iso) != ident:
        raise BootError(502, "Сверка содержимого с Bootimus не прошла.")

    def uploaded_image():
        return next(
            (
                r
                for r in origin_call("GET", "/api/images", token=token)
                if r["filename"] == origin
            ),
            {},
        )

    recipe = "bios-iso" if layout["bios"] else "library"
    kernel = initrd = ""
    if layout.get("casper"):
        refs = [
            "extent:" + str(offset) + ":" + str(length)
            for offset, length in [layout["casper"][k] for k in ("kernel", "initrd")]
        ]
        return iso, *refs, "ubuntu-casper"
    volume = re.sub(r"[^a-z0-9]", "", layout["volume"].lower())
    if "tinycore" in volume or re.fullmatch(
        r"(?:rescue\d+|systemrescue.*|sysresccd.*)", volume
    ):
        image = uploaded_image()
        if not image.get("kernel_path") or not image.get("initrd_path"):
            # Bootimus caches the optical tree and separate copies of the kernel and initrd.
            if shutil.disk_usage(STAGE).free < size * 2 + DISK_RESERVE:
                raise BootError(
                    507, "Недостаточно места для подготовки загрузочных файлов образа."
                )
            origin_call(
                "POST",
                "/api/images/extract?filename=" + quote(origin, safe=""),
                token=token,
            )
            image = uploaded_image()
        distro = image.get("distro")
        if distro in ("tinycore", "systemrescue"):
            kernel, initrd = (
                artifact(origin, image.get(field, ""))
                for field in ("kernel_path", "initrd_path")
            )
            paths = [kernel, initrd]
            if distro == "systemrescue":
                paths.extend(
                    artifact(origin, "iso/" + value) for value in SYSTEMRESCUE_FILES
                )
            require_artifacts(paths)
            recipe = distro + "-http"
    return iso, kernel, initrd, recipe
