"""Finite boot routes shared by the service and the two-segment acceptance lab."""

import base64
import http.client
import ipaddress
import json
import logging
import re
import shutil
import socket
import sqlite3
from contextlib import closing
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote

from bootimus import CHUNK, ORIGIN_HOST, SYSTEMRESCUE_FILES, BootError, artifact
from library import render_menu
import strelec_media
from winpe_profile import GUEST_FILES, HIRENS_RECIPE

HEX = re.compile(r"[a-f0-9]{64}\Z")
MEDIA = re.compile(r"/media/([a-f0-9]{64})/(.+)\Z")
RANGE = re.compile(r"bytes=(?:[0-9]{1,20}-[0-9]{0,20}|-[0-9]{1,20})\Z")
RESPONSE_HEADERS = ("Content-Length", "Content-Range", "Accept-Ranges", "Content-Type")
WINPE_FILES = ("boot.wim", "wimboot", *GUEST_FILES)
WINPE_ASSETS = Path(__file__).with_name("winpe")


def networks(path):
    config = json.loads(Path(path).read_text())
    if not isinstance(config, dict):
        raise TypeError("Invalid F12 network list")
    return {key: network(key, value) for key, value in config.items()}


def network(ident, value):
    if (
        not isinstance(value, dict)
        or not isinstance(ident, str)
        or not HEX.fullmatch(ident)
    ):
        raise ValueError("Invalid F12 network")
    token = value["token"]
    name = value["name"]
    pxe_allowed = value.get("pxe_allowed", True)
    address = ipaddress.IPv4Address(value["address"])
    subnet = ipaddress.IPv4Network(value["cidr"])
    if (
        not isinstance(name, str)
        or not name.strip()
        or len(name) > 255
        or not isinstance(token, str)
        or not HEX.fullmatch(token)
        or value["port"] != 18080
        or address not in subnet
        or not isinstance(pxe_allowed, bool)
    ):
        raise ValueError("Invalid F12 network settings")
    return {
        "id": ident,
        "name": name,
        "address": str(address),
        "subnet": subnet,
        "port": value["port"],
        "token": token,
        "pxe_allowed": pxe_allowed,
    }


def permitted_path(path):
    if path == "/menu.ipxe":
        return True
    match = MEDIA.fullmatch(path)
    return bool(
        match
        and (
            match[2]
            in (
                "iso",
                "image.iso",
                "kernel",
                "initrd",
                *SYSTEMRESCUE_FILES,
                *WINPE_FILES,
            )
            or strelec_media.route(match[2])
        )
    )


def one_header(headers, name):
    values = headers.get_all(name, [])
    return values[0] if len(values) == 1 else None


def range_header(headers):
    if "Range" not in headers:
        return {}
    value = one_header(headers, "Range")
    if not value or not RANGE.fullmatch(value):
        raise BootError(416, "Диапазон не поддерживается.")
    return {"Range": value}


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=90):
        super().__init__("localhost", timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.sock.settimeout(self.timeout)
            self.sock.connect(self.path)
        except OSError:
            self.sock.close()
            raise


class Handler(BaseHTTPRequestHandler):
    server_version = "PL-F12/1"

    def log_message(self, *args):
        pass

    def send(self, code, data=b"", kind="application/json; charset=utf-8", extra=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, val in (extra or {}).items():
            self.send_header(key, val)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def end_headers(self):
        self.headers_sent = True
        super().end_headers()

    def dispatch(self):
        self.headers_sent = False
        try:
            self.connection.settimeout(90)
            self.route()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except BootError as err:
            if not self.headers_sent:
                self.send(err.status, {"error": err.message})
        except (
            OSError,
            ValueError,
            TypeError,
            KeyError,
            http.client.HTTPException,
            sqlite3.Error,
        ) as err:
            logging.getLogger(__name__).warning(
                "F12 request failed (%s)", type(err).__name__
            )
            if not self.headers_sent:
                self.send(
                    503, {"error": "Служба временно недоступна. Повторите запрос."}
                )

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = dispatch

    def relay_response(self, response):
        self.send_response(response.status)
        for key in RESPONSE_HEADERS:
            value = response.getheader(key)
            if value is not None:
                self.send_header(key, value)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command == "GET":
            shutil.copyfileobj(response, self.wfile, CHUNK)

    def serve_boot(self, library, path, segment, address, port):
        if self.command not in ("GET", "HEAD") or not permitted_path(path):
            raise BootError(404, "Не найдено.")
        if path == "/menu.ipxe":
            return self.send(
                200,
                render_menu(library.menu(segment), address, port),
                "text/plain; charset=utf-8",
            )
        ident, kind = MEDIA.fullmatch(path).groups()
        row = library.visible_image(ident, segment)
        if not row:
            raise BootError(404, "Образ недоступен.")
        strelec = strelec_media.route(kind)
        if strelec:
            if row["recipe"] != strelec_media.RECIPE:
                raise BootError(404, "Образ недоступен.")
            base = f"http://{address}:{port}/media/{ident}"
            return self.serve_strelec(library, row, segment, base, *strelec)
        if kind in WINPE_FILES:
            if row["recipe"] != HIRENS_RECIPE:
                raise BootError(404, "Образ недоступен.")
            requested = range_header(self.headers).get("Range")
            if kind == "boot.wim":
                return self.serve_extent_ref(row, row["initrd"], requested)
            if kind == "pl-f12.url":
                data = f"http://{address}:{port}/media/{ident}/iso\r\n".encode("ascii")
            else:
                data = (WINPE_ASSETS / kind).read_bytes()
                if kind in ("pl-f12.cmd", "winpeshl.ini"):
                    data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            return self.serve_small_asset(data, requested)
        if row["recipe"] in (HIRENS_RECIPE, strelec_media.RECIPE) and kind in (
            "kernel",
            "initrd",
        ):
            raise BootError(404, "Образ недоступен.")
        if kind == "image.iso":
            kind = "iso"
        if kind in SYSTEMRESCUE_FILES:
            if row["recipe"] != "systemrescue-http":
                raise BootError(404, "Образ недоступен.")
            name = unquote(row["iso"].removeprefix("/isos/"))
            origin_path = artifact(name, "iso/" + kind)
        else:
            origin_path = row[kind]
        if not origin_path:
            raise BootError(404, "Образ недоступен.")
        headers = range_header(self.headers)
        if row["recipe"] == "ubuntu-casper" and kind in ("kernel", "initrd"):
            return self.serve_extent_ref(row, origin_path, headers.get("Range"))
        with closing(http.client.HTTPConnection(ORIGIN_HOST, 8080, timeout=90)) as conn:
            conn.request(self.command, origin_path, headers=headers)
            response = conn.getresponse()
            if response.status not in (200, 206, 416):
                raise BootError(502, "Данные Bootimus временно недоступны.")
            self.relay_response(response)

    def serve_strelec(self, library, row, segment, base, mode, edition, asset):
        profile, bcd = library.strelec_assets(
            row["id"], segment, mode + "/" + edition if asset == "BCD" else ""
        )
        if asset == "menu.ipxe":
            return self.send(
                200,
                strelec_media.menu_script(base, profile),
                "text/plain; charset=utf-8",
            )
        if edition not in profile["options"].get(mode, ()):
            raise BootError(404, "Эта среда недоступна для выбранной прошивки.")
        if asset in ("boot.ipxe", "pecmd.ini") and edition not in profile.get(
            "startup", {}
        ):
            raise BootError(503, "PL готовит загрузочные файлы из сохранённого ISO.")
        if asset == "boot.ipxe":
            return self.send(
                200,
                strelec_media.boot_script(base, profile, mode, edition),
                "text/plain; charset=utf-8",
            )
        requested = range_header(self.headers).get("Range")
        if asset in ("environment.wim", "boot.sdi", strelec_media.MANAGERS[mode][0]):
            key = edition if asset == "environment.wim" else asset
            offset, length = profile["files"][key][:2]
            if not (0 <= offset < row["size"] and 0 < length <= row["size"] - offset):
                raise BootError(502, "Повреждена запись загрузочного образа.")
            return self.serve_iso_extent(row, offset, length, requested)
        if asset == "BCD" and bcd:
            data = bcd
        elif asset == "wimboot":
            loader = (
                strelec_media.GUEST / "wimboot-bios"
                if mode == "bios"
                else WINPE_ASSETS / "wimboot"
            )
            data = loader.read_bytes()
        elif asset == "pl-f12.url":
            data = (base + "/iso\r\n").encode("ascii")
        elif asset == "pecmd.ini":
            data = base64.b64decode(profile["startup"][edition], validate=True)
        elif asset == "pl-strelec.exe":
            arch = strelec_media.EDITIONS[edition][2]
            data = (strelec_media.GUEST / f"pl-strelec-{arch}.exe").read_bytes()
        elif asset == "winpeshl.ini":
            data = (
                (strelec_media.GUEST / asset)
                .read_bytes()
                .replace(b"\r\n", b"\n")
                .replace(b"\n", b"\r\n")
            )
        else:
            raise BootError(404, "Загрузочный файл недоступен.")
        return self.serve_small_asset(data, requested)

    def serve_extent_ref(self, row, ref, requested):
        mode, offset, length = ref.split(":")
        start, size = int(offset), int(length)
        if mode != "extent" or start < 0 or size <= 0 or start + size > row["size"]:
            raise BootError(502, "Неверная запись загрузочного файла.")
        return self.serve_iso_extent(row, start, size, requested)

    def byte_range(self, size, requested):
        begin = 0
        end = size - 1
        if requested:
            start_byte, end_byte = requested[6:].split("-")
            if start_byte:
                begin = int(start_byte)
                end = min(end, int(end_byte)) if end_byte else end
            else:
                begin = max(0, size - int(end_byte))
            if begin > end or begin >= size:
                self.send(
                    416,
                    b"",
                    "application/octet-stream",
                    {"Content-Range": "bytes */" + str(size)},
                )
                return None
        return begin, end

    def serve_small_asset(self, data, requested):
        interval = self.byte_range(len(data), requested)
        if interval is None:
            return
        begin, end = interval
        headers = {"Accept-Ranges": "bytes"}
        if requested:
            headers["Content-Range"] = f"bytes {begin}-{end}/{len(data)}"
        return self.send(
            206 if requested else 200,
            data[begin : end + 1],
            "application/octet-stream",
            headers,
        )

    def serve_iso_extent(self, row, offset, size, requested):
        interval = self.byte_range(size, requested)
        if interval is None:
            return
        begin, end = interval
        physical = f"bytes={offset + begin}-{offset + end}"
        length = end - begin + 1
        conn = http.client.HTTPConnection(ORIGIN_HOST, 8080, timeout=90)
        try:
            conn.request(self.command, row["iso"], headers={"Range": physical})
            r = conn.getresponse()
            if (
                r.status != 206
                or int(r.getheader("Content-Length", "-1")) != length
                or r.getheader("Content-Range")
                != f"bytes {offset + begin}-{offset + end}/{row['size']}"
            ):
                raise BootError(502, "Bootimus не вернул запрошенную часть ISO.")
            self.send_response(206 if requested else 200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            if requested:
                self.send_header("Content-Range", f"bytes {begin}-{end}/{size}")
            self.end_headers()
            if self.command == "GET":
                shutil.copyfileobj(r, self.wfile, CHUNK)
        finally:
            conn.close()
