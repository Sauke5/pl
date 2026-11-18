"""Identify the VPN host's public IPv4 and suggest a non-overlapping client pool."""
import http.client
import importlib.util
import ipaddress
import json
from pathlib import Path
import ssl
import subprocess


def network_helper():
    spec = importlib.util.spec_from_file_location("pl_vpn_ipam", Path(__file__).with_name("module-network.py"))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def ip_json(*args):
    result = subprocess.run(["ip", "-j", "-4", *args], capture_output=True, timeout=4, check=True)
    rows = json.loads(result.stdout)
    if not isinstance(rows, list):
        raise ValueError("Invalid host IPv4 inventory")
    return rows


def local_inventory():
    addresses, usable, occupied = [], [], set()
    for link in ip_json("address", "show"):
        for item in link.get("addr_info", []):
            if item.get("family") != "inet" or "tentative" in item.get("flags", []):
                continue
            interface = ipaddress.IPv4Interface((item["local"], item["prefixlen"]))
            address = str(interface.ip)
            if interface.network.prefixlen:
                occupied.add(interface.network)
            if address not in addresses:
                addresses.append(address)
            if (not interface.ip.is_loopback and not interface.ip.is_link_local and
                    link.get("operstate") != "DOWN" and not link.get("ifname", "").startswith(("veth", "docker", "br-"))):
                usable.append(address)
    for route in ip_json("route", "show", "table", "all"):
        dst = route.get("dst", "default")
        if dst != "default":
            network = ipaddress.IPv4Network(dst, strict=False)
            if network.prefixlen:
                occupied.add(network)
    try:
        routes = ip_json("route", "get", "1.1.1.1")
    except (OSError, ValueError, subprocess.SubprocessError):
        routes = []
    preferred = next((r["prefsrc"] for r in routes if r.get("prefsrc") in addresses), "")
    return addresses, sorted(occupied), preferred or next(iter(usable), "")


def public_ipv4(value):
    try:
        addr = ipaddress.IPv4Address(value)
    except (ValueError, TypeError):
        return ""
    return str(addr) if addr.is_global and not addr.is_multicast and not addr.is_reserved else ""


def observed_ip():
    # This endpoint receives just the connection source IP. Never follow redirects.
    conn = http.client.HTTPSConnection("api.ipify.org", timeout=3, context=ssl.create_default_context())
    try:
        conn.request("GET", "/", headers={"Accept": "text/plain"})
        response = conn.getresponse()
        if response.status == 200:
            data = response.read(65)
            if len(data) <= 64:
                return public_ipv4(data.decode("ascii").strip())
    except (OSError, UnicodeError, http.client.HTTPException):
        pass
    finally:
        conn.close()
    return ""


def discover():
    addresses, occupied, bind = local_inventory()
    ipam = network_helper()
    pool = ipam.first_free([ipaddress.IPv4Network("10.77.0.0/16"), *ipam.PRIVATE], occupied, 24)
    public = public_ipv4(bind)
    if not public:
        globals_ = {public_ipv4(address) for address in addresses} - {""}
        if len(globals_) == 1:
            public = globals_.pop()
    source = "interface"
    if not public:
        public = observed_ip()
        source = "external" if public else "unavailable"
    return {"addresses": addresses, "bind_address": bind, "public_ip": public,
            "source": source, "pool": str(pool) if pool else ""}
