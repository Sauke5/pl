"""The native ocserv process, its management socket and its namespace firewall."""
import ipaddress
import json
import re
import ssl
from pathlib import Path
import stat
import subprocess
import time
from urllib.parse import urlsplit

from policy import DEVICE, RESERVED, SESSION, SUBJECT, label, networks, stamp

OPERATOR = Path("/etc/pl-ocserv")
RUN = Path("/run/pl-ocserv")
DATA = Path("/var/lib/pl-ocserv")
CTL = RUN / "occtl.socket"
USERS = RUN / "users"
BINARY = "/usr/local/bin/pl-ocserv"
NFT = "/usr/sbin/nft"


def operator_file(folder, name, secret=False):
    path = folder / name
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & (0o077 if secret else 0o022)
            or not 0 < info.st_size <= 1024 * 1024):
        raise ValueError("Invalid VPN operator file " + name)
    return path


SYSTEM_ROOTS = Path("/usr/share/pl-ocserv/debian-ca.crt")
TRUST_DIR = Path("/run/pl-ocserv-trust")
PEM_CA = re.compile(rb"-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+?\s+-----END CERTIFICATE-----")


def extra_roots(folder):
    candidate = folder / "idp-ca.pem"
    if not candidate.exists() and not candidate.is_symlink():
        return b""
    certs = operator_file(folder, "idp-ca.pem").read_bytes()
    blocks = PEM_CA.findall(certs)
    if not 1 <= len(blocks) <= 32 or PEM_CA.sub(b"", certs).strip():
        raise ValueError("idp-ca.pem requires PEM CA certificates")
    for block in blocks:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.load_verify_locations(cadata=block.decode("ascii"))
        if ctx.cert_store_stats()["x509_ca"] != 1:
            raise ValueError("idp-ca.pem contains a non-CA certificate")
    return b"\n".join(blocks) + b"\n"


def prepare_trust(gateway, folder=OPERATOR, system=SYSTEM_ROOTS, target=TRUST_DIR):
    target.mkdir(mode=0o755, exist_ok=True)
    target.chmod(0o755)
    bundle = target / "ca-certificates.crt"
    tmp = target / ".new"
    tmp.unlink(missing_ok=True)
    custom = extra_roots(folder) if gateway and gateway["auth_mode"] == "oidc" else b""
    if custom:
        tmp.write_bytes(system.read_bytes() + b"\n" + custom)
        tmp.chmod(0o644)
    else:
        tmp.symlink_to(system)
    tmp.replace(bundle)


def config(folder=OPERATOR):
    if not (folder / "gateway.json").exists():
        return None
    item = json.loads(operator_file(folder, "gateway.json").read_text())
    if not isinstance(item, dict) or set(item) != {"name", "auth_mode", "pool"}:
        raise ValueError("Invalid gateway.json fields")
    label(item["name"], 128, "название шлюза")
    pool = ipaddress.IPv4Network(item["pool"])
    if str(pool) != item["pool"] or not 8 <= pool.prefixlen <= 29 or any(pool.overlaps(net) for net in RESERVED):
        raise ValueError("Invalid VPN client pool")
    for name in ("server.crt", "server.key"):
        operator_file(folder, name, secret=name.endswith(".key"))
    if item["auth_mode"] == "certificate":
        operator_file(folder, "ca.crt")
    elif item["auth_mode"] == "oidc":
        provider = json.loads(operator_file(folder, "oidc.json", secret=True).read_text())
        if (not isinstance(provider, dict) or provider.get("user_name_claim") != "sub"
                or not isinstance(provider.get("client_id"), str) or not provider["client_id"]):
            raise ValueError("OIDC requires client_id and user_name_claim=sub")
        if not isinstance(provider.get("required_claims"), dict):
            raise ValueError("OIDC requires a required_claims object")
        for key in ("openid_configuration_url", "redirect_uri"):
            url = urlsplit(provider.get(key, ""))
            if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
                raise ValueError("Invalid OIDC provider or callback URL")
    else:
        raise ValueError("Unknown VPN authentication mode")
    return item


def server_config(gateway):
    pool = ipaddress.IPv4Network(gateway["pool"])
    auth = ('auth = "certificate"\nca-cert = /etc/pl-ocserv/ca.crt\ncert-user-oid = 2.5.4.3'
            if gateway["auth_mode"] == "certificate" else 'auth = "oidc[config=/etc/pl-ocserv/oidc.json,mode=browser]"')
    return f"""{auth}
server-cert = /etc/pl-ocserv/server.crt
server-key = /etc/pl-ocserv/server.key
tcp-port = 4443
udp-port = 4443
listen-host = 0.0.0.0
run-as-user = nobody
run-as-group = nogroup
socket-file = /run/ocserv-secmod.socket
use-occtl = true
occtl-socket-file = {CTL}
pid-file = {RUN}/ocserv.pid
isolate-workers = true
max-clients = 64
max-same-clients = 4
device = plvpn
ipv4-network = {pool.network_address}
ipv4-netmask = {pool.netmask}
predictable-ips = true
ping-leases = false
config-per-user = {USERS}
connect-script = {BINARY}
disconnect-script = {BINARY}
auth-timeout = 180
cookie-timeout = 180
persistent-cookies = false
keepalive = 300
dpd = 60
mobile-dpd = 300
tls-priorities = "NORMAL:%SERVER_PRECEDENCE:%COMPAT:-VERS-SSL3.0:-VERS-TLS1.0:-VERS-TLS1.1"
"""


def write_user(policy, subject, pool, now):
    path = USERS / subject
    grant = policy.grant(subject)
    if not grant or grant["revoked"] or (grant["end"] and grant["end"] <= now):
        path.unlink(missing_ok=True)
        return
    routes = networks(json.loads(grant["networks"]), pool)
    tmp = USERS / (".tmp-" + subject)
    tmp.write_text("".join("route = " + route + "\n" for route in routes))
    tmp.replace(path)


def firewall(pool, leases, now):
    # One netlink transaction replaces all rules, including the base denies. A
    # client can only use its own TUN and address. Return traffic is stateful.
    lines = ["destroy table inet pl_vpn", "add table inet pl_vpn",
             "add chain inet pl_vpn local { type filter hook input priority -10; policy accept; }",
             "add chain inet pl_vpn transit { type filter hook forward priority -10; policy accept; }",
             "add chain inet pl_vpn return_path { type nat hook postrouting priority srcnat; policy accept; }",
             'add rule inet pl_vpn local iifname "plvpn*" counter drop',
             'add rule inet pl_vpn transit iifname "plvpn*" oifname "plvpn*" counter drop']
    for session, lease in leases.items():
        subject, dev, address, routes, end = lease
        if not (SESSION.fullmatch(session) and SUBJECT.fullmatch(subject) and DEVICE.fullmatch(dev)
                and ipaddress.IPv4Address(address) in pool):
            raise ValueError("Unexpected tunnel lease")
        allowed = sorted(ipaddress.collapse_addresses(ipaddress.IPv4Network(net) for net in networks(routes, pool)))
        dst = "{ " + ", ".join(str(net) for net in allowed) + " }"
        source = str(ipaddress.IPv4Address(address))
        if end:
            ttl = min(int((end - now) * 1000), 86400000)
            if ttl <= 0:
                continue
            key = "lease" + session
            lines.extend([f"add set inet pl_vpn {key} {{ type ipv4_addr; flags timeout; }}",
                          f"add element inet pl_vpn {key} {{ {source} timeout {ttl}ms }}"])
            source = "@" + key
        lines.extend([f'add rule inet pl_vpn transit iifname "{dev}" ip saddr {source} ip daddr {dst} counter accept',
                      f'add rule inet pl_vpn transit oifname "{dev}" ct state established,related ip daddr {source} ip saddr {dst} counter accept'])
    lines.extend(['add rule inet pl_vpn transit iifname "plvpn*" counter drop',
                  'add rule inet pl_vpn transit oifname "plvpn*" counter drop',
                  f'add rule inet pl_vpn return_path ip saddr {pool} oifname != "plvpn*" masquerade'])
    return "\n".join(lines) + "\n"


def apply_firewall(pool, leases):
    subprocess.run([NFT, "-f", "-"], input=firewall(pool, leases, time.time()), text=True,
                   capture_output=True, timeout=5, check=True)


def occtl(*args, get=False, check=True):
    command = ["/usr/bin/occtl", "--socket-file", str(CTL)]
    if get:
        command.append("--json")
    result = subprocess.run([*command, *args], capture_output=True, timeout=3, check=check)
    if get:
        rows = json.loads(result.stdout)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError("Invalid occtl JSON")
        return rows
    return result.returncode


def active_users():
    return [row for row in occtl("show", "users", get=True) if row.get("State") == "connected"]


def cookies():
    return occtl("show", "sessions", "valid", get=True)


def safe_id(row):
    # occtl returns the printable SHA-1-based external session identifier,
    # distinct from its authentication cookie. It never crosses the PL API.
    return row.get("Full session ID") or row.get("Full session")


def public_sessions(rows):
    result = []
    for row in rows:
        sid = str(row["ID"])
        if not SESSION.fullmatch(sid):
            raise ValueError("Invalid connection ID")
        device = row.get("Hostname") or row.get("User-Agent") or row.get("Device") or ""
        result.append({"id": sid, "subject": row["Username"], "ip": row.get("IPv4") or "",
                       "device": str(device)[:256], "since": stamp(int(row["raw_connected_at"]))})
    return result


def close_subjects(subjects):
    users = active_users()
    saved = cookies()
    observed = {row["Username"] for row in users + saved}
    for subject in sorted(subjects & observed):
        occtl("terminate", "user", subject, check=False)
    if subjects & observed:
        until = time.monotonic() + 1.5
        while any(row["Username"] in subjects for row in active_users() + cookies()):
            if time.monotonic() >= until:
                raise RuntimeError("VPN sessions still present")
            time.sleep(0.05)


def close_one(sid):
    row = next((row for row in active_users() if str(row["ID"]) == sid), None)
    if not row:
        return None
    cookie = safe_id(row)
    if not cookie:
        raise RuntimeError("Missing ocserv session identity")
    occtl("terminate", "id", sid)
    until = time.monotonic() + 1.5
    while any(str(user["ID"]) == sid for user in active_users()) or any(safe_id(c) == cookie for c in cookies()):
        if time.monotonic() >= until:
            raise RuntimeError("VPN session still present")
        time.sleep(0.05)
    return row["Username"]
