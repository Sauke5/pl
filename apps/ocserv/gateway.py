"""Finite administration RPC and ocserv connect/disconnect hooks inside its namespace."""
import ipaddress
import json
import os
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import time

from policy import DEVICE, Error, Policy, SESSION, SUBJECT, invalid, networks, stamp, token
import runtime

CONTROL = runtime.RUN / "control.sock"
LIMIT = 16384
UNAVAILABLE = (OSError, subprocess.SubprocessError, RuntimeError, ValueError, KeyError, TypeError, sqlite3.Error)


class Gateway:
    def __init__(self):
        runtime.DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.policy = Policy(runtime.DATA / "policy.sqlite3")
        self.config = None
        self.pool = None
        self.daemon = None
        self.leases = {}
        self.next_refresh = 0

    def start(self):
        self.config = runtime.config()
        runtime.prepare_trust(self.config)
        if not self.config:
            return
        self.pool = ipaddress.IPv4Network(self.config["pool"])
        for row in self.policy.db.execute("SELECT networks FROM profiles"):
            networks(json.loads(row[0]), self.pool)
        runtime.USERS.mkdir(mode=0o700, exist_ok=True)
        if self.managed_certificates():
            with self.policy.db:
                self.policy.ensure_certificate_names()
        for subject in self.policy.subjects():
            self.write_routes(subject)
        self.enforce()
        conf = runtime.RUN / "ocserv.conf"
        conf.write_text(runtime.server_config(self.config))
        self.daemon = subprocess.Popen(["/usr/sbin/ocserv", "-f", "--log-stderr", "-c", str(conf)], start_new_session=True)

    def stop(self, force=False):
        if self.daemon and self.daemon.poll() is None:
            try:
                os.killpg(self.daemon.pid, signal.SIGKILL if force else signal.SIGTERM)
            except ProcessLookupError:
                pass

    def enforce(self):
        try:
            runtime.apply_firewall(self.pool, self.leases)
        except UNAVAILABLE:
            # End the namespace's VPN workers if a required kernel policy cannot
            # be installed. PID 1 exits on daemon loss and Docker recreates it.
            self.stop(force=True)
            raise
        self.next_refresh = time.monotonic() + 3600

    def live(self):
        if not self.daemon or self.daemon.poll() is not None:
            return False
        try:
            info = runtime.CTL.lstat()
        except FileNotFoundError:
            return False
        if not stat.S_ISSOCK(info.st_mode):
            raise RuntimeError("Invalid ocserv control socket")
        # ocserv chowns its socket to its unprivileged worker. Keep the management
        # socket in a root-only directory and give its sole caller access.
        if info.st_uid:
            os.chown(runtime.CTL, 0, 0)
        return True

    def managed_certificates(self):
        return bool(self.config and self.config.get("managed_certificates"))

    def write_routes(self, subject):
        if not self.managed_certificates():
            runtime.write_user(self.policy, subject, self.pool, time.time())
            return {subject}
        names = set()
        for cn, current in self.policy.certificate_names(subject):
            names.add(cn)
            if current:
                runtime.write_user(self.policy, subject, self.pool, time.time(), cn)
            else:
                (runtime.USERS / cn).unlink(missing_ok=True)
        return names

    def reconcile(self):
        pending = self.policy.pending()
        if not pending:
            return
        if self.config:
            self.leases = {sid: lease for sid, lease in self.leases.items() if lease[0] not in pending}
            self.enforce()
            identities = set()
            for subject in pending:
                identities.update(self.write_routes(subject))
            if not self.live():
                raise RuntimeError("VPN control socket unavailable")
            runtime.close_subjects(identities)
        with self.policy.db:
            self.policy.db.execute("DELETE FROM certificate_names WHERE current=0 AND subject IN (SELECT subject FROM pending)")
            self.policy.db.executemany("DELETE FROM pending WHERE subject=?", [(s,) for s in pending])

    def tick(self):
        if self.daemon and self.daemon.poll() is not None:
            raise RuntimeError("ocserv exited")
        self.policy.expiry(time.time())
        if self.policy.pending():
            try:
                self.reconcile()
            except UNAVAILABLE:
                # Retry durable intent. Pending grants are rejected by the hook.
                return
        if self.config and time.monotonic() >= self.next_refresh:
            self.enforce()

    def snapshot(self):
        now = time.time()
        rows, known = [], False
        if self.live():
            try:
                rows = runtime.public_sessions(runtime.active_users())
                known = True
            except UNAVAILABLE:
                pass
        if self.managed_certificates():
            for row in rows:
                row["subject"] = self.policy.certificate_owner(row["subject"]) or row["subject"]
        state = self.policy.snapshot(now, self.managed_certificates())
        state["gateway"] = {**(self.config or {"name": "Корпоративный VPN", "auth_mode": "", "pool": ""}),
                            "ready": known, "sessions_known": known, "observed_at": stamp(now)}
        state["sessions"] = rows
        return state

    def request(self, action, body):
        self.policy.check(action, body)
        if action == "state":
            return self.snapshot()
        if action == "terminate":
            sid = token(body["id"], SESSION, "сессии")
            if not self.live():
                raise Error(503, "ocserv_unavailable", "Шлюз VPN недоступен.")
            if self.leases.pop(sid, None):
                self.enforce()
            subject = runtime.close_one(sid)
            if not subject:
                raise Error(404, "ocserv_session", "Сессия уже завершена.")
            with self.policy.db:
                if self.managed_certificates():
                    subject = self.policy.certificate_owner(subject) or subject
                self.policy.audit(action, subject, body["actor"], time.time())
        else:
            with self.policy.db:
                self.policy.mutate(action, body, self.pool, time.time(), self.managed_certificates())
            self.reconcile()
        return self.snapshot()

    def hook(self, env):
        reason, subject, dev, sid, address = (env[k] for k in ("REASON", "USERNAME", "DEVICE", "ID", "IP_REMOTE"))
        token(sid, SESSION, "сессии")
        token(dev, DEVICE, "интерфейса")
        if self.managed_certificates():
            owner = self.policy.certificate_owner(subject, current_only=reason == "connect")
            if owner is None:
                if reason == "disconnect":
                    return {}
                raise invalid("Сертификат этого подключения отозван.")
            subject = owner
        if reason == "disconnect":
            previous = self.leases.get(sid)
            if previous and previous[:3] == (subject, dev, address):
                del self.leases[sid]
                self.enforce()
            return {}
        if reason != "connect" or not self.config or ipaddress.IPv4Address(address) not in self.pool:
            raise invalid("Шлюз отклонил подключение.")
        token(subject, SUBJECT, "сотрудника")
        current = self.policy.grant(subject)
        if not current or current["revoked"] or (current["end"] and current["end"] <= time.time()) or subject in self.policy.pending():
            raise invalid("Нет действующего назначения VPN.")
        routes = networks(json.loads(current["networks"]), self.pool)
        # Reconnect and disconnect hooks can arrive out of order. Bind each ACL
        # to the ocserv worker ID, interface and the assigned point-to-point IP.
        self.leases = {key: v for key, v in self.leases.items() if v[1] != dev and v[2] != address}
        self.leases[sid] = (subject, dev, address, routes, current["end"])
        self.enforce()
        return {}


def read(stream, limit):
    data = stream.read(limit + 1)
    if not data or len(data) > limit:
        raise Error(400, "ocserv_invalid", "Превышен предел запроса VPN.")
    return json.loads(data)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


def error_reply(exc):
    if not isinstance(exc, Error):
        return {"status": 503, "body": {"error": {"code": "ocserv_unavailable", "message": "Не удалось применить или прочитать состояние шлюза."}}}
    return {"status": exc.status, "body": {"error": {"code": exc.code, "message": str(exc)}}}


def serve():
    os.umask(0o077)
    runtime.RUN.mkdir(mode=0o700, parents=True, exist_ok=True)
    CONTROL.unlink(missing_ok=True)
    gateway = Gateway()
    stopping = False
    def stop(_sig, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(CONTROL))
        server.listen(32)
        server.settimeout(0.4)
        try:
            gateway.start()
            while not stopping:
                gateway.tick()
                try:
                    client, _ = server.accept()
                except socket.timeout:
                    continue
                with client:
                    client.settimeout(3)
                    try:
                        _, uid, _ = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                        if uid != 0:
                            continue
                        with client.makefile("rb") as stream:
                            msg = read(stream, LIMIT)
                        if isinstance(msg, dict) and set(msg) == {"hook"}:
                            result = gateway.hook(msg["hook"])
                        elif isinstance(msg, dict) and set(msg) == {"action", "payload"}:
                            result = gateway.request(msg["action"], msg["payload"])
                        else:
                            raise Error(400, "ocserv_invalid", "Некорректный запрос VPN.")
                        reply = {"status": 200, "body": result}
                    except (Error, *UNAVAILABLE) as exc:
                        if not isinstance(exc, Error):
                            print("VPN request failed: " + type(exc).__name__, file=sys.stderr)
                        reply = error_reply(exc)
                    try:
                        client.sendall(encode(reply))
                    except (BrokenPipeError, ConnectionResetError):
                        pass
        finally:
            gateway.stop()
            if gateway.daemon:
                try:
                    gateway.daemon.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    gateway.stop(force=True)


def main(args):
    if args == ["serve"]:
        serve()
        return 0
    request = args == ["request"]
    try:
        if request:
            msg = read(sys.stdin.buffer, LIMIT)
            if not isinstance(msg, dict) or set(msg) != {"action", "payload"}:
                raise Error(400, "ocserv_invalid", "Некорректный запрос VPN.")
        elif not args and os.environ.get("REASON") in ("connect", "disconnect"):
            msg = {"hook": {k: os.environ.get(k, "") for k in ("REASON", "USERNAME", "DEVICE", "ID", "IP_REMOTE")}}
        else:
            return 2
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(20)
            client.connect(str(CONTROL))
            client.sendall(encode(msg))
            client.shutdown(socket.SHUT_WR)
            with client.makefile("rb") as stream:
                reply = read(stream, 4 * 1024**2)
    except (Error, *UNAVAILABLE) as exc:
        reply = error_reply(exc)
    if request:
        sys.stdout.buffer.write(encode(reply))
        return 0
    return 0 if reply["status"] == 200 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
