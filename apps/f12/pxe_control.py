"""Supervise one PXE worker using host-bound sockets and the committed boot menu."""

import array
import errno
import http.client
import json
import logging
import os
import re
import select
import socket
import stat
import struct
import subprocess
import time
from contextlib import closing

from gateway import UnixConnection

WORKER = "/opt/pl-f12/pxe-worker"
PORTS = (67, 4011, 69)
FAMILIES = {"bios", "uefi-x64"}
INTERFACE = re.compile(r"[a-zA-Z0-9_.:-]{1,15}\Z")
POLL_INTERVAL = 0.5
POLL_TIMEOUT = 0.45
MAX_FRAME = 1024
RETRY_DELAY = 2
LOG = logging.getLogger(__name__)


def read_firmware(boot_socket, scope):
    # This private, finite response is always sent with Content-Length. Bound both
    # its size and the total time, including a peer that only sends partial headers.
    deadline = time.monotonic() + POLL_TIMEOUT
    headers = {
        "X-PL-F12-Segment": scope["id"],
        "X-PL-F12-Token": scope["token"],
        "Connection": "close",
    }
    with closing(UnixConnection(boot_socket, timeout=POLL_TIMEOUT)) as conn:
        conn.request("GET", "/first-hop", headers=headers)
        reply = bytearray()
        while len(reply) <= 4096:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("first-hop deadline")
            conn.sock.settimeout(remaining)
            part = conn.sock.recv(4097 - len(reply))
            if not part:
                break
            reply.extend(part)
    head, separator, body = bytes(reply).partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    lengths = [line.partition(b":")[2].strip() for line in lines[1:]
               if line.partition(b":")[0].lower() == b"content-length"]
    if (len(reply) > 4096 or not separator or len(body) > 128
            or lines[0].split(b" ", 2)[:2] not in ([b"HTTP/1.0", b"200"], [b"HTTP/1.1", b"200"])
            or lengths != [str(len(body)).encode()]):
        raise ValueError("invalid first-hop response")
    data = json.loads(body)
    if not isinstance(data, dict) or set(data) != {"firmware"}:
        raise ValueError("invalid first-hop payload")
    firmware = data["firmware"]
    if (not isinstance(firmware, list) or len(firmware) > len(FAMILIES)
            or not all(isinstance(f, str) and f in FAMILIES for f in firmware)
            or len(set(firmware)) != len(firmware)):
        raise ValueError("invalid firmware families")
    return tuple(sorted(firmware))


def validate_sockets(descriptors, interface, address):
    if len(descriptors) != len(PORTS):
        raise ValueError("expected three UDP descriptors")
    for fd, port in zip(descriptors, PORTS):
        # The outer request owns every received descriptor, including rejected ones.
        sock = socket.socket(fileno=fd)
        try:
            if (sock.family != socket.AF_INET
                    or sock.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_DGRAM
                    or sock.getsockopt(socket.SOL_SOCKET, socket.SO_PROTOCOL) != socket.IPPROTO_UDP):
                raise ValueError("wrong socket type")
            nic = sock.getsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, 16)
            ip, bound_port = sock.getsockname()
            expected_ip = "0.0.0.0" if port == 67 else address
            if (nic.rstrip(b"\0") != interface.encode("ascii")
                    or ip != expected_ip or bound_port != port
                    or sock.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR)
                    or sock.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT)):
                raise ValueError("wrong socket binding")
            if port == 67:
                # Older CPython versions omit the Linux IP_PKTINFO constant.
                pktinfo = sock.getsockopt(socket.IPPROTO_IP, getattr(socket, "IP_PKTINFO", 8))
                if not pktinfo or not sock.getsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST):
                    raise ValueError("wrong discovery socket options")
            try:
                sock.getpeername()
            except OSError as error:
                if error.errno != errno.ENOTCONN:
                    raise
            else:
                raise ValueError("expected unconnected UDP socket")
        finally:
            sock.detach()


class PXEControl:
    def __init__(self, path, boot_socket, scope, interface):
        if not isinstance(interface, str) or not INTERFACE.fullmatch(interface):
            raise ValueError("invalid PXE interface")
        self.path = path
        self.boot_socket = boot_socket
        self.scope = scope
        self.interface = interface
        self.child = None
        self.firmware = None
        self.retry_after = 0

    def status(self):
        if self.firmware is None or time.monotonic() < self.retry_after:
            state = "error"
        elif not self.firmware:
            state = "idle"
        elif self.child is None:
            state = "waiting"
        else:
            state = "active"
        return {"state": state, "firmware": list(self.firmware or ())}

    def stop_worker(self):
        if self.child is None:
            return
        child, self.child = self.child, None
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=0.4)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

    def refresh(self):
        try:
            current = read_firmware(self.boot_socket, self.scope)
        except (OSError, ValueError, http.client.HTTPException):
            current = None
        if current != self.firmware:
            self.stop_worker()
            self.firmware = current
            self.retry_after = 0
        elif self.child is not None and self.child.poll() is not None:
            LOG.warning("F12 PXE worker exited on %s", self.interface)
            self.stop_worker()
            self.retry_after = time.monotonic() + RETRY_DELAY

    def attach(self, request, descriptors):
        required = {"action": "attach", "interface": self.interface,
                    "address": self.scope["address"], "cidr": str(self.scope["subnet"])}
        if request != required:
            raise ValueError("wrong PXE scope")
        validate_sockets(descriptors, self.interface, self.scope["address"])
        # The host may have observed waiting before a withdrawal or a firmware change.
        self.refresh()
        if self.status()["state"] != "waiting":
            return
        args = [
            WORKER, "--fds=" + ",".join(str(fd) for fd in descriptors),
            "--interface=" + self.interface, "--address=" + self.scope["address"],
            "--cidr=" + str(self.scope["subnet"]), "--firmware=" + ",".join(self.firmware),
        ]
        try:
            self.child = subprocess.Popen(
                args, pass_fds=descriptors, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            )
            with self.child.stdout as stream:
                if not select.select([stream], [], [], 1)[0] or os.read(stream.fileno(), 6) != b"READY\n":
                    raise ValueError("PXE worker did not become ready")
            # Starting the firmware reader can race with a withdrawal.
            self.refresh()
        except (OSError, ValueError):
            self.stop_worker()
            self.retry_after = time.monotonic() + RETRY_DELAY
            LOG.warning("F12 PXE worker could not start on %s", self.interface)

    def handle(self, client):
        client.settimeout(0.2)
        _, uid, _ = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != 0:
            return
        descriptors = array.array("i")
        try:
            frame, ancillary, flags, _ = client.recvmsg(
                MAX_FRAME, socket.CMSG_SPACE(3 * descriptors.itemsize), socket.MSG_CMSG_CLOEXEC
            )
            invalid = False
            for level, kind, value in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    tail = len(value) % descriptors.itemsize
                    descriptors.frombytes(value[:len(value) - tail])
                    invalid |= bool(tail)
                else:
                    invalid = True
            if invalid or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                raise ValueError("truncated control frame")
            request = json.loads(frame)
            if request == {"action": "status"} and not descriptors:
                self.refresh()
                result = self.status()
            elif isinstance(request, dict) and request.get("action") == "attach":
                self.attach(request, descriptors)
                result = self.status()
            else:
                raise ValueError("unknown control request")
        except (OSError, ValueError, RecursionError):
            result = {"state": "error", "firmware": []}
        finally:
            for fd in descriptors:
                os.close(fd)
        client.sendall(json.dumps(result).encode())

    def run(self, stopping):
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid():
                raise RuntimeError("Путь управляющего сокета PXE занят.")
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as probe:
                probe.settimeout(0.2)
                try:
                    probe.connect(str(self.path))
                except ConnectionRefusedError:
                    self.path.unlink()
                else:
                    raise RuntimeError("Управляющий сокет PXE уже работает.")
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as listener:
            listener.bind(str(self.path))
            try:
                self.path.chmod(0o660)
                listener.listen(8)
                next_poll = 0
                while not stopping.is_set():
                    now = time.monotonic()
                    if now >= next_poll:
                        self.refresh()
                        next_poll = now + POLL_INTERVAL
                    remaining = max(0, next_poll - time.monotonic())
                    if not select.select([listener], [], [], remaining)[0]:
                        continue
                    client, _ = listener.accept()
                    with client:
                        try:
                            self.handle(client)
                        except OSError:
                            pass  # A controller may disconnect during a refresh.
            finally:
                self.stop_worker()
                self.path.unlink(missing_ok=True)
