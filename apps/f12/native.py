"""Run the private F12 service or a read-only serving endpoint for one network."""

import hmac
import http.client
import ipaddress
import json
import os
import re
import signal
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
from contextlib import ExitStack, closing
from http.server import ThreadingHTTPServer
from pathlib import Path

from bootimus import ORIGIN_KEY, BootError, admin_token, origin_call, prepare_local
from gateway import (
    HEX,
    RANGE,
    Handler,
    UnixConnection,
    network,
    networks,
    one_header,
    permitted_path,
)
from library import Library, menu_firmware, selected_segments
from pxe_control import PXEControl
from uploads import MAX_CHUNK, Transfers

DATA = Path("/data")
ADMIN = Path("/run/pl-f12/admin")
BOOT = Path("/run/pl-f12/boot/boot.sock")
EDGE = Path("/etc/pl-f12/edge.json")


def actor_key(value):
    if not isinstance(value, str) or not HEX.fullmatch(value):
        raise BootError(403, "Недействительный сеанс управления.")
    return value


def length_header(headers, limit):
    text = one_header(headers, "Content-Length")
    if (
        "Transfer-Encoding" in headers
        or not text
        or not re.fullmatch(r"[0-9]{1,12}", text)
    ):
        raise BootError(400, "Требуется точный размер запроса.")
    size = int(text)
    if not 0 < size <= limit:
        raise BootError(413, "Слишком большой или пустой запрос.")
    return size


class Runtime:
    def __init__(self, root, config):
        self.config = Path(config)
        self.library = Library(root / "publication.sqlite", prepare_local)
        self.library.initialize()
        self.transfers = Transfers(self.library, root / "staging", self.choices)
        self.transfers.initialize()
        self.token = None
        self.health_lock = threading.Lock()

    def choices(self):
        return networks(self.config)

    def ready(self):
        with self.health_lock:
            try:
                if self.token is None:
                    self.token = admin_token(timeout=2)
                origin_call("GET", "/api/me", token=self.token, timeout=2)
                self.choices()
                return True
            except (
                OSError,
                ValueError,
                TypeError,
                KeyError,
                BootError,
                http.client.HTTPException,
            ):
                self.token = None
                return False

    def request(self, action, actor, payload):
        if action == "upload-start":
            return 200, self.transfers.start(actor, payload)
        if action == "upload-finish":
            return self.transfers.finish(actor, payload.get("id"))
        if action == "upload-cancel":
            return 200, self.transfers.cancel(actor, payload.get("id"))
        scopes = self.choices()
        if action == "library":
            result = {
                "items": self.library.images(),
                "segments": {k: v["name"] for k, v in scopes.items()},
                "boot_urls": {
                    k: f"http://{v['address']}:{v['port']}/menu.ipxe"
                    for k, v in scopes.items()
                },
            }
            pending = self.transfers.pending(actor)
            if pending:
                result["pending"] = pending
            return 200, result
        if action == "menu":
            segment = payload.get("segment")
            if not isinstance(segment, str) or segment not in scopes:
                raise BootError(404, "Сеть не найдена.")
            return 200, {"items": self.library.menu(segment), "segment": segment}
        if action == "publish":
            ident = payload.get("id")
            if not isinstance(ident, str) or not HEX.fullmatch(ident):
                raise BootError(400, "Неверный идентификатор образа.")
            return 200, self.library.publish(
                ident, selected_segments(payload.get("segments"), scopes)
            )
        raise BootError(404, "Неизвестная операция.")


class AdminHandler(Handler):
    def body(self, limit):
        size = length_header(self.headers, limit)
        body = self.rfile.read(size)
        if len(body) != size:
            raise BootError(400, "Передача прервалась. Повторите запрос.")
        return body

    def route(self):
        runtime = self.server.runtime
        if self.path == "/health" and self.command == "GET":
            if not runtime.ready():
                raise BootError(503, "Служба сетевой загрузки ещё не готова.")
            with runtime.transfers.lock:
                busy = bool(runtime.transfers.workers)
            return self.send(200, {"ready": True, "busy": busy})
        if self.command == "POST" and self.path == "/request":
            try:
                obj = json.loads(self.body(65536))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise BootError(400, "Неверный формат запроса.") from None
            if not isinstance(obj, dict) or not isinstance(obj.get("payload"), dict):
                raise BootError(400, "Неверные параметры операции.")
            code, result = runtime.request(
                obj.get("action"), actor_key(obj.get("actor")), obj["payload"]
            )
            return self.send(code, result)
        if self.command == "POST" and self.path == "/chunk":
            actor = actor_key(one_header(self.headers, "X-PL-F12-Actor"))
            ident = one_header(self.headers, "X-PL-F12-Upload")
            offset = one_header(self.headers, "X-PL-F12-Offset") or ""
            if not re.fullmatch(r"[0-9]{1,12}", offset):
                raise BootError(400, "Неверное смещение части файла.")
            digest = one_header(self.headers, "X-PL-F12-SHA256")
            return self.send(
                200,
                runtime.transfers.chunk(
                    actor, ident, int(offset), digest, self.body(MAX_CHUNK)
                ),
            )
        raise BootError(404, "Не найдено.")


class BootHandler(Handler):
    def route(self):
        runtime = self.server.runtime
        segment = one_header(self.headers, "X-PL-F12-Segment")
        token = one_header(self.headers, "X-PL-F12-Token") or ""
        config = runtime.choices().get(segment)
        if (
            not config
            or not HEX.fullmatch(token)
            or not hmac.compare_digest(token, config["token"])
        ):
            raise BootError(403, "Доступ для этой сети закрыт.")
        if self.command == "GET" and self.path == "/first-hop":
            if not config["pxe_allowed"]:
                return self.send(200, {"firmware": []})
            offered = {
                kind
                for row in runtime.library.menu(segment)
                for kind in menu_firmware(row["recipe"])
            }
            return self.send(200, {"firmware": sorted(offered)})
        return self.serve_boot(
            runtime.library, self.path, segment, config["address"], config["port"]
        )


class EdgeHandler(Handler):
    def route(self):
        scope = self.server.scope
        if ipaddress.ip_address(self.client_address[0]) not in scope["subnet"]:
            raise BootError(403, "Доступ для этой сети закрыт.")
        if self.command not in ("GET", "HEAD") or not permitted_path(self.path):
            raise BootError(404, "Не найдено.")
        headers = {"X-PL-F12-Segment": scope["id"], "X-PL-F12-Token": scope["token"]}
        if "Range" in self.headers:
            value = one_header(self.headers, "Range") or ""
            # The service checks publication before returning a range error.
            headers["Range"] = value if RANGE.fullmatch(value) else "invalid"
        with closing(UnixConnection(self.server.boot_socket)) as conn:
            conn.request(self.command, self.path, headers=headers)
            self.relay_response(conn.getresponse())


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, path, handler, runtime):
        self.runtime = runtime
        self.path = Path(path)
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid():
                raise RuntimeError("Путь сокета занят.")
            self.path.unlink()
        super().__init__(str(path), handler)
        self.path.chmod(0o660)

    def server_close(self):
        super().server_close()
        self.path.unlink(missing_ok=True)


def start_bootimus():
    args = [
        "/opt/pl-f12/bootimus",
        "--data-dir",
        str(DATA),
        "--server-addr",
        "127.0.0.1",
        "--bind-interface",
        "lo",
        "--http-port",
        "8080",
        "--admin-port",
        "8081",
        "--tftp-port",
        "1069",
        "--proxy-dhcp=false",
        "--nbd-enabled=false",
        "--nfs-enabled=false",
        "--windows-smb=false",
        "--disable-remote-profiles",
        "serve",
    ]
    if (DATA / "bootimus.db").exists() and not ORIGIN_KEY.is_file():
        args.append("--reset-admin-password")
    process = subprocess.Popen(
        args,
        cwd=DATA,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    def capture_key():
        with process.stdout as output:
            for line in output:
                match = re.search(r"║\s*(?:New )?Password:\s*([^\s║]+)", line)
                if match:
                    with tempfile.NamedTemporaryFile(
                        dir=DATA, prefix=".origin-key-", delete=False
                    ) as handle:
                        handle.write(match[1].encode())
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(handle.name, ORIGIN_KEY)

    threading.Thread(target=capture_key, daemon=True, name="bootimus-output").start()
    return process


def serve():
    os.umask(0o077)
    runtime = Runtime(DATA, ADMIN / "networks.json")
    stopping = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopping.set())
    with ExitStack() as stack:
        boot = stack.enter_context(UnixServer(BOOT, BootHandler, runtime))
        admin = stack.enter_context(
            UnixServer(ADMIN / "admin.sock", AdminHandler, runtime)
        )
        process = start_bootimus()
        try:
            for server in (boot, admin):
                threading.Thread(target=server.serve_forever, daemon=True).start()
                stack.callback(server.shutdown)
            threading.Thread(
                target=runtime.library.refresh_local_profiles,
                args=(runtime.transfers.stage,),
                daemon=True,
                name="f12-upgrade-media",
            ).start()
            ticks = 0
            while not stopping.wait(1):
                if process.poll() is not None:
                    raise SystemExit("Bootimus завершил работу.")
                ticks += 1
                if ticks % 60 == 0:
                    runtime.transfers.cleanup()
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def edge():
    raw = json.loads(EDGE.read_text())
    scope = network(raw["id"], raw)
    with ThreadingHTTPServer(("0.0.0.0", 8080), EdgeHandler) as server:
        server.scope = scope
        server.boot_socket = BOOT
        socket_dir = Path("/run/pl-f12/pxe")
        if "interface" not in raw or not socket_dir.is_dir():
            server.serve_forever()
            return
        stopping = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stopping.set())
        control = PXEControl(socket_dir / "control.sock", BOOT, scope, raw["interface"])
        threading.Thread(target=server.serve_forever, daemon=True, name="f12-edge-http").start()
        try:
            control.run(stopping)
        finally:
            server.shutdown()


def main():
    if sys.argv[1:] == ["serve"]:
        serve()
    elif sys.argv[1:] == ["edge"]:
        edge()
    else:
        raise SystemExit("Допустимые режимы: serve, edge.")


if __name__ == "__main__":
    main()
