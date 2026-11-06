#!/usr/bin/env python3
"""Offline, same-identity PL disaster recovery. Never imports a live installation."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager, ExitStack
import copy
import ctypes
import datetime
import fcntl
import grp
import http.client
import hashlib
import importlib.util
import ipaddress
import itertools
import json
import math
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import pwd
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
import types
import uuid


BASE = Path(__file__).resolve().parent
HEX = re.compile(r"[0-9a-f]{64}\Z")
IDENTITY = re.compile(r"pl-[0-9a-f]{12}\Z")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\Z")
SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
RESERVE = 512 * 1024**2
MAX_METADATA = 8 * 1024**2
MAX_RESOURCES = 4096
MAX_ENTRIES = 500_000
ROOTS = {".pl-installation.json", "config", "private", "state", "modules", "releases", "host-packages.json"}
PRESERVE = {"state/install.lock", "state/delivery/delivery.lock", "state/delivery/worker.lock", "modules/controller.lock"}
EXCLUDE = PRESERVE | {"private/upgrade-backups", "private/icmp-helper.json", "private/icmp-runtime-owner.json",
                      "state/delivery/operation.json", "modules/transfers"}
TERMINAL = {"complete", "failed", "rolled_back"}
MODULES = {"prometheus", "xray", "alertmanager", "wayline", "grafana", "forms", "doska", "sftpgo", "netmap", "bookstack"}
STORAGE = {"forms": {"mongo", "keydb"}, "doska": {"database"}, "netmap": {"database", "cache"}, "bookstack": {"database"}}
ROLES = {"prometheus": ("",), "xray": ("",), "alertmanager": ("",), "grafana": ("",),
         "wayline": ("runner", "api", "gateway"), "forms": ("mongo", "keydb", "engine", "adapter"),
         "doska": ("database", "api", "web"), "sftpgo": ("server",),
         "netmap": ("database", "cache", "netbox", "netbox-worker", "gitea", "adapter", "oxidized"), "bookstack": ("database", "web")}
VOLUMES = {"prometheus": ("",), "alertmanager": ("",), "wayline": ("",), "grafana": ("",), "xray": (),
           "forms": ("mongo", "mongo-config", "keydb", "assets", "adapter"), "doska": ("database", "attachments"),
           "sftpgo": ("state", "files"), "netmap": ("database", "cache", "media", "gitea", "adapter", "oxidized"),
           "bookstack": ("database", "config")}
NETWORK_MODULES = {"wayline", "forms", "doska", "sftpgo", "netmap", "bookstack"}
CORE_NETWORKS = ("backend", "ingress", "egress")
DNS_DEFAULTS = ("Dns", "DnsOptions", "DnsSearch")
MAX_LEGACY_DIGESTS = 11520  # 720 mount orders × 2 OOM defaults × 8 DNS defaults.
SYSTEMD_UNITS = Path("/etc/systemd/system")
CONTROLLER_UNIT_PROPERTIES = ("LoadState", "FragmentPath", "DropInPaths", "MainPID", "ActiveState", "UnitFileState")


def helper(name):
    path = BASE / (name + ".py")
    if path.is_symlink() or not path.is_file():
        raise ValueError("Trusted recovery helper is unavailable")
    spec = importlib.util.spec_from_file_location("pl_dr_" + name.replace("-", "_"), path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def checksum(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024**2), b""):
            result.update(block)
    return result.hexdigest()


def json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate recovery JSON key")
        result[key] = value
    return result


def load_json(data):
    return json.loads(data, object_pairs_hook=json_object)


def valid_labels(value):
    return (isinstance(value, dict) and len(value) <= 32
            and all(isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9_.\-/]{1,128}", key)
                    and isinstance(item, str) and len(item.encode()) <= 4096 and not any(char in item for char in ("\0", "\n", "\r"))
                    for key, item in value.items()))


def private_file(path, *, limit=None):
    info = Path(path).lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1 or limit is not None and info.st_size > limit):
        raise ValueError("Recovery input must be an owned private regular file")


def atomic(path, value):
    path = Path(path)
    if path.exists() or path.is_symlink():
        private_file(path)
    temporary = path.with_name(path.name + ".new." + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded(value) + b"\n")
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def trusted_directory(path, *, create=False):
    path = Path(path)
    if create and not path.exists():
        path.mkdir(mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError("Unsafe recovery directory")


@contextmanager
def lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError("Unsafe recovery barrier")
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Installation busy; no recovery mutation performed") from None
        yield


def archive_name(value):
    if not isinstance(value, str) or not value or len(value.encode()) > 4096 or "\0" in value or "\\" in value:
        raise ValueError("Unsafe recovery archive name")
    value = value.removeprefix("./").rstrip("/") or "."
    name = PurePosixPath(value)
    if name.is_absolute() or ".." in name.parts or str(name) != value:
        raise ValueError("Unsafe recovery archive path")
    return value


def validate_tree_archive(path, *, installation=False):
    with tarfile.open(path, "r:") as archive:
        entries, names, links = [], {}, set()
        for entry in archive:
            name = archive_name(entry.name)
            if (len(entries) >= MAX_ENTRIES or name in names or entry.size < 0
                    or not (entry.isfile() or entry.isdir() or entry.issym() or entry.islnk())
                    or installation and name.split("/", 1)[0] not in ROOTS):
                raise ValueError("Unexpected recovery tree entry")
            if name == "." and not entry.isdir():
                raise ValueError("Invalid recovery tree root")
            if entry.uid < 0 or entry.gid < 0 or not 0 <= entry.mode <= 0o7777:
                raise ValueError("Invalid recovery file metadata")
            if entry.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), entry.linkname))
                if entry.linkname.startswith("/") or target == ".." or target.startswith("../") or "\0" in entry.linkname:
                    raise ValueError("External symbolic link is outside the recovery contract")
                links.add(name)
            if entry.islnk():
                target = archive_name(entry.linkname)
                if target not in names or not names[target].isfile():
                    raise ValueError("Unsafe recovery hard link")
            names[name] = entry; entries.append(entry)
        for name in names:
            if any(str(parent) in links for parent in PurePosixPath(name).parents):
                raise ValueError("Recovery entry traverses a symbolic link")
        if installation and not {".pl-installation.json", "config", "private", "state", "modules", "releases"} <= set(names):
            raise ValueError("Incomplete installation tree")
    return entries


def verify_tree(archive_path, destination, overrides=None):
    destination = Path(destination)
    with tarfile.open(archive_path, "r:") as archive:
        for entry in archive:
            path = destination / archive_name(entry.name)
            info = path.lstat()
            if (info.st_uid != entry.uid or info.st_gid != entry.gid
                    or not entry.issym() and stat.S_IMODE(info.st_mode) != entry.mode):
                raise ValueError("Restored file ownership or mode differs")
            if entry.isfile() or entry.islnk():
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("Restored file type differs")
                expected = hashlib.sha256()
                if archive_name(entry.name) in (overrides or {}):
                    alternatives = overrides[archive_name(entry.name)]
                    alternatives = alternatives if isinstance(alternatives, tuple) else (alternatives,)
                    permitted = {hashlib.sha256(value).hexdigest() for value in alternatives}
                else:
                    with archive.extractfile(entry) as source:
                        for block in iter(lambda: source.read(1024**2), b""):
                            expected.update(block)
                    permitted = {expected.hexdigest()}
                if checksum(path) not in permitted:
                    raise ValueError("Restored file bytes differ")
            elif entry.issym():
                if not stat.S_ISLNK(info.st_mode) or os.readlink(path) != entry.linkname:
                    raise ValueError("Restored symbolic link differs")
            elif not stat.S_ISDIR(info.st_mode):
                raise ValueError("Restored directory differs")
            expected_attrs = {os.fsdecode(base64.b64decode(key[9:], validate=True)):
                              base64.b64decode(value, validate=True)
                              for key, value in entry.pax_headers.items() if key.startswith("PL.xattr.")}
            actual_attrs = {key: os.getxattr(path, key, follow_symlinks=False)
                            for key in os.listxattr(path, follow_symlinks=False)}
            if actual_attrs != expected_attrs:
                raise ValueError("Restored extended attributes differ")


def validate_metadata(meta):
    fields = {"schema", "product", "backup_id", "created_unix", "installation", "root", "origin", "architecture",
              "version", "manifest_sha256", "supervisor_version", "marker", "schema_contract", "live_auth_sha256",
              "images", "image_storage_bytes", "registry", "native", "containers", "volumes", "networks", "files", "controller_active"}
    if (not isinstance(meta, dict) or set(meta) - {"contract_version"} != fields or meta.get("schema") != 1
            or meta.get("product") != "PL-full-disaster-backup" or not IDENTITY.fullmatch(meta.get("installation", ""))
            or meta.get("architecture") not in ("amd64", "arm64") or type(meta.get("created_unix")) is not int
            or not VERSION.fullmatch(meta.get("version", "")) or not VERSION.fullmatch(meta.get("supervisor_version", ""))
            or not HEX.fullmatch(meta.get("manifest_sha256", "")) or not HEX.fullmatch(meta.get("live_auth_sha256", ""))
            or type(meta.get("controller_active")) is not bool or type(meta.get("image_storage_bytes")) is not int
            or not 0 < meta["image_storage_bytes"] < 2**55):
        raise ValueError("Unsupported full recovery manifest")
    contract_version = meta.get("contract_version", 1)
    if type(contract_version) is not int or contract_version not in (1, 2):
        raise ValueError("Unsupported full recovery container contract version")
    if contract_version == 1 and meta["version"] not in ("0.5.1", "0.5.2"):
        raise ValueError("Legacy recovery contracts are limited to published beta 0.5.1 and 0.5.2")
    if str(uuid.UUID(meta["backup_id"])) != meta["backup_id"]:
        raise ValueError("Invalid recovery backup identity")
    root = Path(meta["root"])
    if not root.is_absolute() or root == Path("/") or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(root)) or ".." in root.parts:
        raise ValueError("Invalid original recovery root")
    marker = meta["marker"]
    if (not isinstance(marker, dict) or set(marker) != {"product", "uid", "gid"} or marker.get("product") not in ("PL", "Pl")
            or any(type(marker.get(key)) is not int or not 0 < marker[key] < 65534 for key in ("uid", "gid"))):
        raise ValueError("Invalid recovery service identity")
    for name in ("containers", "volumes", "networks"):
        values = meta[name]
        if not isinstance(values, list) or not 1 <= len(values) <= MAX_RESOURCES or len({v["name"] for v in values}) != len(values):
            raise ValueError("Invalid recovery resource inventory")
    if len({v["id"] for v in meta["containers"]}) != len(meta["containers"]):
        raise ValueError("Duplicate recovery container identity")
    if not isinstance(meta["native"], dict) or set(meta["native"]) - MODULES:
        raise ValueError("Unsupported recovery native module")
    expected_native, expected_volumes = {}, {meta["installation"] + "_db", meta["installation"] + "-auth", meta["installation"] + "_module-transfers"}
    expected_networks = {meta["installation"] + "_" + name for name in CORE_NETWORKS}
    for kind, plan in meta["native"].items():
        if set(plan) != {"instances"} or not isinstance(plan["instances"], list) or len(plan["instances"]) > MAX_RESOURCES:
            raise ValueError("Unsupported native recovery plan")
        seen = set()
        for item in plan["instances"]:
            if (set(item) != {"instance_id", "running", "state_sha256", "containers"}
                    or str(uuid.UUID(item["instance_id"])) != item["instance_id"] or item["instance_id"] in seen
                    or type(item["running"]) is not bool or not HEX.fullmatch(item["state_sha256"])):
                raise ValueError("Invalid native recovery instance")
            instance = item["instance_id"]; seen.add(instance)
            prefix = meta["installation"] + "-" + kind + "-" + instance
            expected_names = {prefix + ("-" + role if len(ROLES[kind]) > 1 else ""): role for role in ROLES[kind]}
            if (not isinstance(item["containers"], list) or len(item["containers"]) != len(expected_names)
                    or any(set(v) != {"name", "role"} for v in item["containers"])
                    or {v["name"]: v["role"] for v in item["containers"]} != expected_names):
                raise ValueError("Native recovery role graph differs from finite recipes")
            expected_native.update({name: (kind, instance, role, item["running"]) for name, role in expected_names.items()})
            expected_volumes.update(prefix + ("-" + volume if volume else "") + "-data" for volume in VOLUMES[kind])
            if kind in NETWORK_MODULES: expected_networks.add(prefix + "-net")
    for item in meta["containers"]:
        if (set(item) != {"name", "id", "running", "core", "service", "module_id", "instance_id", "role", "image", "contract", "bindings"}
                or not NAME.fullmatch(item["name"]) or not HEX.fullmatch(item["id"]) or not SHA.fullmatch(item["image"])
                or not HEX.fullmatch(item["contract"]) or type(item["running"]) is not bool or type(item["core"]) is not bool):
            raise ValueError("Invalid recovery container contract")
        if item["core"]:
            if item["service"] not in ("db", "api", "web") or item["module_id"] or item["instance_id"] or item["role"] or not item["running"]:
                raise ValueError("Invalid recovery core role")
            if not re.fullmatch(re.escape(meta["installation"]) + r"[-_]" + item["service"] + r"[-_][1-9][0-9]*", item["name"]):
                raise ValueError("Invalid core recovery container name")
        elif item["module_id"] not in MODULES or str(uuid.UUID(item["instance_id"])) != item["instance_id"]:
            raise ValueError("Invalid recovery native identity")
        elif expected_native.get(item["name"]) != (item["module_id"], item["instance_id"], item["role"], item["running"]):
            raise ValueError("Native recovery container is outside its registered plan")
        if not isinstance(item["bindings"], dict):
            raise ValueError("Invalid preserved recovery bindings")
        for port, bindings in item["bindings"].items():
            if not re.fullmatch(r"[1-9][0-9]{0,4}/tcp", port) or int(port.split("/")[0]) > 65535 or not isinstance(bindings, list) or len(bindings) != 1:
                raise ValueError("Unsupported recovery host binding")
            binding = bindings[0]
            if (set(binding) != {"HostIp", "HostPort"} or not isinstance(binding["HostIp"], str) or not isinstance(binding["HostPort"], str)
                    or binding["HostPort"] not in ("", "0") and (not binding["HostPort"].isdigit() or not 1 <= int(binding["HostPort"]) <= 65535)):
                raise ValueError("Invalid preserved host binding")
            ipaddress.ip_address(binding["HostIp"] or "0.0.0.0")
    if {v["name"] for v in meta["containers"] if not v["core"]} != set(expected_native):
        raise ValueError("Incomplete recovery native role inventory")
    if {v["service"] for v in meta["containers"] if v["core"]} != {"db", "api", "web"} or sum(v["core"] for v in meta["containers"]) != 3:
        raise ValueError("Incomplete recovery core")
    expected = {"installation.tar", "images.tar"}
    for index, volume in enumerate(meta["volumes"]):
        if (set(volume) != {"name", "labels", "archive"} or not NAME.fullmatch(volume["name"])
                or volume["archive"] != "volume-" + str(index) + ".tar"
                or not valid_labels(volume["labels"]) or volume["labels"].get("pl.installation") != meta["installation"]):
            raise ValueError("Invalid recovery volume ownership")
        expected.add(volume["archive"])
    if {v["name"] for v in meta["volumes"]} != expected_volumes or {v["name"] for v in meta["networks"]} != expected_networks:
        raise ValueError("Recovery volumes or networks differ from the finite owned graph")
    if not isinstance(meta["files"], dict) or set(meta["files"]) != expected:
        raise ValueError("Incomplete full recovery payload set")
    for record in meta["files"].values():
        if set(record) != {"sha256", "bytes"} or not HEX.fullmatch(record["sha256"]) or type(record["bytes"]) is not int or record["bytes"] <= 0:
            raise ValueError("Invalid recovery payload integrity record")
    if (not isinstance(meta["images"], dict) or not meta["images"] or len(meta["images"]) > MAX_RESOURCES
            or any(not SHA.fullmatch(key) or set(value) != {"id", "architecture", "ref", "recipe", "labels"}
                   or value.get("id") != key or value.get("architecture") != meta["architecture"] or not isinstance(value.get("labels"), dict)
                   for key, value in meta["images"].items())
            or not {v["image"] for v in meta["containers"]} <= meta["images"].keys()):
        raise ValueError("Invalid recovery image set")
    return meta


@contextmanager
def open_backup(path, expected, workspace):
    if not HEX.fullmatch(expected):
        raise ValueError("An independently retained backup SHA256 is required")
    private_file(path)
    with tempfile.TemporaryDirectory(prefix="pl-dr-input-", dir=workspace) as temporary:
        temporary = Path(temporary)
        stable = temporary / "input.tar"
        if shutil.disk_usage(workspace).free < Path(path).stat().st_size * 3 + RESERVE:
            raise ValueError("Insufficient recovery staging space")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as source, stable.open("xb") as target:
            shutil.copyfileobj(source, target)
        stable.chmod(0o600)
        if checksum(stable) != expected:
            raise ValueError("Full recovery archive SHA256 differs")
        with tarfile.open(stable, "r:") as archive:
            entries = archive.getmembers()
            names = [v.name for v in entries]
            if (len(entries) > MAX_RESOURCES + 3 or len(names) != len(set(names)) or "metadata.json" not in names
                    or any(not v.isfile() or "/" in v.name or "\\" in v.name or v.size <= 0 for v in entries)):
                raise ValueError("Unsafe full recovery outer archive")
            member = archive.getmember("metadata.json")
            if member.size > MAX_METADATA:
                raise ValueError("Recovery metadata exceeds limit")
            meta = validate_metadata(load_json(archive.extractfile(member).read()))
            if set(names) != {"metadata.json", *meta["files"]}:
                raise ValueError("Unexpected full recovery payload")
            for name, record in meta["files"].items():
                member = archive.getmember(name)
                if member.size != record["bytes"]:
                    raise ValueError("Recovery payload size differs")
                destination = temporary / name
                with archive.extractfile(member) as source, destination.open("xb") as target:
                    shutil.copyfileobj(source, target)
                destination.chmod(0o600)
                if checksum(destination) != record["sha256"]:
                    raise ValueError("Recovery payload checksum differs")
                if name != "images.tar":
                    validate_tree_archive(destination, installation=name == "installation.tar")
        yield meta, temporary


class Host:
    def __init__(self):
        self.env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8"}

    def run(self, args, *, data=None, stdout=None, timeout=600):
        result = subprocess.run(args, input=data, stdout=stdout if stdout is not None else subprocess.PIPE,
                                stderr=subprocess.PIPE, env=self.env, timeout=timeout)
        if result.returncode:
            raise ValueError("Recovery host command failed; output withheld because it can contain private data")
        return result.stdout

    def docker(self, *args, **kwargs):
        return self.run(["docker", "--host", "unix:///var/run/docker.sock", *args], **kwargs)

    def inspect_all(self, kind):
        ids = self.docker(kind, "ls", *(["-a"] if kind == "container" else []), "--quiet").decode().split()
        if len(ids) > 16384:
            raise ValueError("Host resource inventory exceeds recovery bounds")
        return load_json(self.docker(kind, "inspect", *ids)) if ids else []

    def preflight(self, architecture):
        if sys.platform != "linux" or os.geteuid() != 0 or sys.version_info < (3, 10):
            raise ValueError("Disaster recovery requires root and Python 3.10+ on supported Linux")
        if any(os.environ.get(key) for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY")):
            raise ValueError("Docker endpoint overrides are refused")
        actual = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
        info = load_json(self.docker("version", "--format", "{{json .Server}}"))
        compose = self.docker("compose", "version", "--short").decode().lstrip("v")
        match = re.match(r"(\d+)\.(\d+)", compose)
        if (actual != architecture or info.get("Arch") != architecture or info.get("Os") != "linux"
                or not re.match(r"29\.", info.get("Version", "")) or not match
                or not (int(match[1]) == 5 or int(match[1]) == 2 and int(match[2]) >= 24)):
            raise ValueError("Recovery needs matching architecture, Docker Engine 29.x and Compose 2.24+ or 5.x")
        if load_json(self.docker("context", "inspect", "--format", "{{json .Endpoints.docker.Host}}")) != "unix:///var/run/docker.sock":
            raise ValueError("Only the local Docker engine is supported")

    def verify_images(self, images):
        for identity, descriptor in images.items():
            actual, = load_json(self.docker("image", "inspect", identity))
            if (actual.get("Id") != identity or actual.get("Os") != "linux" or actual.get("Architecture") != descriptor["architecture"]
                    or any((actual.get("Config", {}).get("Labels") or {}).get(key) != value for key, value in descriptor["labels"].items())):
                raise ValueError("Recovery image identity or provenance differs")

    def unit_active(self, installation):
        value = self.run(["systemctl", "show", "--property=ActiveState", "--value", installation + "-module-controller.service"]).strip()
        if value not in (b"active", b"inactive", b"failed"):
            raise ValueError("Host controller is not in a stable state")
        return value == b"active"


def _container_projection(obj, *, canonical_mount_order=True):
    """Retain every recipe field while canonicalizing daemon-assigned identities."""
    config, host = copy.deepcopy(obj.get("Config", {})), copy.deepcopy(obj.get("HostConfig", {}))
    # Engine 29 may inspect the same default as false before start and null
    # after start. Keep the archived null representation; true stays distinct.
    if host.get("OomKillDisable") is False:
        host["OomKillDisable"] = None
    # A daemon restart materializes present null DNS defaults as empty lists.
    # Keep missing fields distinct and retain every nonempty override verbatim.
    for key in DNS_DEFAULTS:
        if key in host and type(host[key]) is list and not host[key]:
            host[key] = None
    targets = []
    def add_target(target):
        if (not isinstance(target, str) or not target.startswith("/") or target.startswith("//") or "\0" in target
                or ".." in PurePosixPath(target).parts or str(PurePosixPath(target)) != target):
            raise ValueError("Invalid container mount target")
        targets.append(target)
    declarations = host.get("Mounts")
    if declarations is not None:
        if not isinstance(declarations, list):
            raise ValueError("Invalid container mount targets")
        for value in declarations:
            add_target(value.get("Target") if isinstance(value, dict) else None)
        if canonical_mount_order:
            host["Mounts"] = sorted(declarations, key=lambda value: (value["Target"], encoded(value)))
    binds = host.get("Binds")
    if binds is not None:
        if not isinstance(binds, list):
            raise ValueError("Invalid container bind declarations")
        destinations = {}
        for value in binds:
            if not isinstance(value, str) or any(character in value for character in ("\0", "\n", "\r")):
                raise ValueError("Invalid container bind declaration")
            fields = value.split(":")
            if len(fields) not in (2, 3) or not fields[0] or len(fields) == 3 and not fields[2]:
                raise ValueError("Invalid container bind declaration")
            add_target(fields[1])
            destinations[value] = fields[1]
        if canonical_mount_order:
            host["Binds"] = sorted(binds, key=lambda value: (destinations[value], value))
    if len(targets) != len(set(targets)):
        raise ValueError("Duplicate container mount target")
    if config.get("Hostname") == obj.get("Id", "")[:12]:
        config["Hostname"] = ""
    for key in ("com.docker.compose.version", "com.docker.compose.config-hash", "com.docker.compose.image"):
        config.get("Labels", {}).pop(key, None)
    if isinstance(config.get("Env"), list):
        config["Env"].sort()
    module = (obj.get("Config", {}).get("Labels") or {}).get("pl.module", "")
    for port, bindings in (host.get("PortBindings") or {}).items():
        if module == "xray" or module == "sftpgo" and port == "2022/tcp" or not module:
            continue
        for binding in bindings or []:
            if binding.get("HostIp") == "127.0.0.1":
                binding["HostPort"] = "*"
    generated = {obj.get("Id"), obj.get("Id", "")[:12], obj.get("Name", "").removeprefix("/")}
    networks = {}
    for name, value in obj.get("NetworkSettings", {}).get("Networks", {}).items():
        networks[name] = {"aliases": sorted(set(value.get("Aliases") or []) - generated), "ipam": value.get("IPAMConfig")}
        if host.get("NetworkMode") == value.get("NetworkID"):
            host["NetworkMode"] = name
    mounts = []
    for mount in obj.get("Mounts", []):
        mount = copy.deepcopy(mount)
        if mount.get("Type") == "volume":
            mount.pop("Source", None)
        mounts.append(mount)
    mounts.sort(key=lambda value: value.get("Destination", ""))
    return {"config": config, "host": host, "mounts": mounts, "networks": networks}


def container_contract(obj):
    """Version 2: mount record order is not a change to a closed recipe."""
    return hashlib.sha256(encoded(_container_projection(obj))).hexdigest()


def container_contract_matches(obj, expected, metadata):
    version = metadata.get("contract_version", 1)
    if type(version) is not int or version not in (1, 2):
        raise ValueError("Unsupported full recovery container contract version")
    if version == 2:
        return container_contract(obj) == expected
    if metadata.get("version") not in ("0.5.1", "0.5.2"):
        raise ValueError("Legacy recovery contracts are limited to published beta 0.5.1 and 0.5.2")
    projection = _container_projection(obj, canonical_mount_order=False)
    host = projection["host"]
    mounts, binds = host.get("Mounts"), host.get("Binds")
    if any(value is not None and len(value) > 6 for value in (mounts, binds)):
        raise ValueError("Legacy recovery permits at most six mount records")
    order_count = math.prod(math.factorial(len(value)) for value in (mounts, binds) if value is not None)
    if order_count > 720:
        raise ValueError("Legacy recovery permits at most 720 combined mount orders")
    default_oom = "OomKillDisable" in host and host["OomKillDisable"] is None
    oom_forms = (None, False) if default_oom else (host.get("OomKillDisable"),)
    dns_defaults = tuple(key for key in DNS_DEFAULTS if key in host and host[key] is None)
    if order_count * len(oom_forms) * 2**len(dns_defaults) > MAX_LEGACY_DIGESTS:
        raise ValueError("Legacy recovery permits at most 11520 complete digest checks")
    for bind_order in itertools.permutations(binds) if binds is not None else (None,):
        if bind_order is not None:
            host["Binds"] = list(bind_order)
        for mount_order in itertools.permutations(mounts) if mounts is not None else (None,):
            if mount_order is not None:
                host["Mounts"] = list(mount_order)
            # The old beta format hashed raw order. It still must match every
            # complete record; only the proved OOM and empty DNS defaults vary.
            for oom in oom_forms:
                if default_oom:
                    host["OomKillDisable"] = oom
                for values in itertools.product((None, []), repeat=len(dns_defaults)):
                    for key, value in zip(dns_defaults, values):
                        host[key] = value
                    if hashlib.sha256(encoded(projection)).hexdigest() == expected:
                        return True
    return False


def unit_payload(root, supervisor):
    return ("[Unit]\nDescription=PL finite module controller\nAfter=docker.service\nRequires=docker.service\n"
            "[Service]\nType=simple\nUser=root\nGroup=root\nUMask=0077\n"
            "ExecStart=/usr/bin/python3 " + str(root / "releases" / supervisor / "controller-supervisor.py") + " --root " + str(root) + "\n"
            "Restart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\n"
            "ProtectSystem=strict\nProtectHome=true\nProtectKernelTunables=true\nProtectKernelModules=true\n"
            "ProtectControlGroups=true\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK\n"
            "ReadWritePaths=" + str(root) + "\n[Install]\nWantedBy=multi-user.target\n").encode()


def validate_unit(host, root, installation, supervisor):
    path = SYSTEMD_UNITS / (installation + "-module-controller.service")
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o644 or path.read_bytes() != unit_payload(root, supervisor)):
        raise ValueError("Host controller unit differs from its finite trusted recipe")
    controller_unit_state(host, path)


def controller_unit_state(host, path):
    raw = host.run(["systemctl", "show", *["--property=" + key for key in CONTROLLER_UNIT_PROPERTIES], path.name])
    lines = raw.decode().splitlines()
    if len(lines) != len(CONTROLLER_UNIT_PROPERTIES) or any("=" not in line for line in lines):
        raise ValueError("Invalid controller unit state")
    value = dict(line.split("=", 1) for line in lines)
    if (set(value) != set(CONTROLLER_UNIT_PROPERTIES) or value["LoadState"] not in ("loaded", "not-found")
            or value["FragmentPath"] not in ("", str(path)) or value["DropInPaths"]
            or value["UnitFileState"] not in ("", "enabled", "enabled-runtime", "disabled", "static")
            or value["ActiveState"] not in ("active", "inactive", "failed", "activating")
            or not re.fullmatch(r"[0-9]{1,10}", value["MainPID"]) or int(value["MainPID"]) >= 2**31):
        raise ValueError("Foreign, masked or overridden controller unit")
    return value


def publish_unit(path, payload):
    """Publish complete generated bytes atomically, without replacing a target."""
    trusted_directory(path.parent)
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise ValueError("Atomic no-replace unit publication requires Linux renameat2")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    temporary = path.with_name("." + path.name + ".pl-recovery-" + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    identity = os.fstat(fd)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload); stream.flush(); os.fchmod(stream.fileno(), 0o644); os.fsync(stream.fileno())
        if rename(-100, os.fsencode(temporary), -100, os.fsencode(path), 1) != 0:  # AT_FDCWD / RENAME_NOREPLACE.
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        if temporary.exists():
            current = temporary.lstat()
            if current.st_dev == identity.st_dev and current.st_ino == identity.st_ino:
                temporary.unlink()


def controller_records(root, meta):
    for name in ("state/controller-active.json", "state/controller-supervisor.json", "private/module-images.json"):
        private_file(root / name, limit=MAX_METADATA)
    active = load_json((root / "state/controller-active.json").read_bytes())
    supervisor = load_json((root / "state/controller-supervisor.json").read_bytes())
    registry = load_json((root / "private/module-images.json").read_bytes())
    if (active != {"schema": 1, "version": meta["version"]} or supervisor != {"schema": 1, "version": meta["supervisor_version"]}
            or registry != meta["registry"] or registry.get("installation") != meta["installation"]
            or registry.get("manifest_sha256") != meta["manifest_sha256"] or registry.get("schema") != 1
            or set(registry) - {"schema", "installation", "manifest_sha256"} != set(meta["native"])):
        raise ValueError("Recovery controller or module registry differs")
    return registry


def validate_delivery_configuration(root):
    path = root / "config/delivery.json"
    private_file(path, limit=MAX_METADATA)
    value = load_json(path.read_bytes())
    if (not isinstance(value, dict) or set(value) != {"schema", "catalog_url"}
            or type(value["schema"]) is not int or value["schema"] != 1 or not isinstance(value["catalog_url"], str)):
        raise ValueError("Invalid preserved delivery configuration")
    helper("delivery").asset_url(value["catalog_url"])


def image_set(manifest, registry, upgrade):
    result = {}
    values = list(manifest["images"].values())
    for kind in sorted(MODULES & registry.keys()):
        values.extend(upgrade._roles(kind, registry[kind]).values())
    for descriptor in values:
        identity = descriptor["id"]
        if not isinstance(descriptor.get("ref"), str) or not re.fullmatch(r"pl/[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}", descriptor["ref"]):
            raise ValueError("Invalid managed recovery image reference")
        if identity in result:
            if ({key: value for key, value in result[identity].items() if key != "ref"}
                    != {key: value for key, value in descriptor.items() if key != "ref"}):
                raise ValueError("Conflicting immutable image descriptors")
            # Tags are informational aliases; preserve every original per-role
            # descriptor in registry, and export each exact content ID once.
            continue
        result[identity] = descriptor
    return result


def validate_networks(meta):
    installation = meta["installation"]
    networks = []
    for value in meta["networks"]:
        if (set(value) != {"name", "id", "labels", "internal", "subnet", "gateway"}
                or not NAME.fullmatch(value["name"]) or not HEX.fullmatch(value["id"])
                or type(value["internal"]) is not bool or not valid_labels(value["labels"])
                or value["labels"].get("pl.installation") != installation):
            raise ValueError("Invalid owned recovery network")
        subnet = ipaddress.IPv4Network(value["subnet"], strict=True)
        if str(subnet) != value["subnet"] or value["gateway"] != str(subnet.network_address + 1):
            raise ValueError("Invalid recovery network allocation")
        if value["name"] not in {installation + "_" + name for name in CORE_NETWORKS}:
            module, instance = value["labels"].get("pl.module"), value["labels"].get("pl.instance")
            if (module not in MODULES or str(uuid.UUID(instance)) != instance
                    or value["name"] != installation + "-" + module + "-" + instance + "-net"
                    or subnet.prefixlen != (28 if module == "netmap" else 29)
                    or value["labels"].get("pl.module.network.version") != "1"
                    or value["labels"].get("pl.module.network.subnet") != str(subnet)
                    or value["internal"] is not (module == "forms")):
                raise ValueError("Unsupported native recovery network")
        else:
            logical = value["name"].rsplit("_", 1)[1]
            if (value["internal"] is not (logical == "backend")
                    or value["labels"].get("com.docker.compose.project") != installation
                    or value["labels"].get("com.docker.compose.network") != logical):
                raise ValueError("Core recovery network isolation or ownership differs")
        networks.append(subnet)
    if any(left.overlaps(right) for index, left in enumerate(networks) for right in networks[index + 1:]):
        raise ValueError("Recovery network allocations overlap")
    if not {installation + "_" + name for name in CORE_NETWORKS} <= {v["name"] for v in meta["networks"]}:
        raise ValueError("Core recovery network is missing")


def validate_module_receipt(receipt, kind):
    required = {"module_id", "version", "core_api", "sha256"}
    if (not isinstance(receipt, dict) or not required <= set(receipt) or set(receipt) - required - {"package_version"}
            or receipt["module_id"] != kind or type(receipt["core_api"]) is not int or receipt["core_api"] != 1
            or not VERSION.fullmatch(receipt["version"]) or not HEX.fullmatch(receipt["sha256"])
            or "package_version" in receipt and (not isinstance(receipt["package_version"], str) or not VERSION.fullmatch(receipt["package_version"]))):
        raise ValueError("Delivered module receipt is missing or invalid")


def validate_package_tree(root, meta):
    """Validate using trusted local code, never execute code extracted from backup."""
    bootstrap = helper("bootstrap")
    state = load_json((root / "state/installation.json").read_bytes())
    marker = load_json((root / ".pl-installation.json").read_bytes())
    if (state.get("install_id") != meta["installation"] or state.get("version") != meta["version"]
            or state.get("manifest_sha256") != meta["manifest_sha256"] or state.get("phase") != "ready"
            or state.get("config", {}).get("public_url") != meta["origin"] or marker != meta["marker"]):
        raise ValueError("Recovery installation identity differs from its archive")
    versions = {meta["version"], meta["supervisor_version"]}
    if {v.name for v in (root / "releases").iterdir()} != versions:
        raise ValueError("Unexpected recovery release selection")
    manifests = {}
    trusted_key = (BASE / "release-signing-public.pem").read_bytes()
    for version in versions:
        package = root / "releases" / version
        manifests[version] = bootstrap.manifest(package)
        if (manifests[version].get("schema") != 2 or manifests[version]["architecture"] != meta["architecture"]
                or (package / "release-signing-public.pem").read_bytes() != trusted_key):
            raise ValueError("Recovery release changes its immutable trust contract")
    manifest = manifests[meta["version"]]
    if (not manifest.get("features", {}).get("on_demand_modules") or set(manifest["images"]) != {"api", "web", "db"}
            or checksum(root / "releases" / meta["version"] / "manifest.json") != meta["manifest_sha256"]):
        raise ValueError("Full recovery currently requires the minimal schema-2 on-demand core")
    registry = controller_records(root, meta)
    validate_delivery_configuration(root)
    upgrade = helper("module-upgrade")
    if image_set(manifest, registry, upgrade) != meta["images"]:
        raise ValueError("Recovery images are not the exact registered role set")
    cfg = state["config"]
    canonical = bootstrap.configuration(cfg["public_url"], cfg["bind_address"], cfg["admin_user"], cfg.get("network_cidr"),
        cfg.get("module_network_cidr"), cfg.get("integration_config"), cfg.get("icmp_allowed_cidrs") if "icmp_allowed_cidrs" in cfg else None)
    for name in ("allowed_cidrs", "allowed_ports", "custom_tls", "outbound_ca_pem", "icmp_policy_mode"):
        if name in cfg: canonical[name] = cfg[name]
    if canonical != cfg or "custom_tls" in cfg and type(cfg["custom_tls"]) is not bool:
        raise ValueError("Unsupported persisted recovery configuration")
    bootstrap.icmp_policy(cfg)
    bootstrap.validate_integration_secrets(root, cfg.get("integration_config"))
    if manifest["features"].get("connector_credentials"): bootstrap.read_connector_key(root)
    model = bootstrap.compose_model(root, manifest, cfg, meta["installation"])
    # Render against the staged marker, then compare the generated bind paths
    # with their original final root. No installed path or origin is remapped.
    for service in model["services"].values():
        for mount in service.get("volumes", []):
            if isinstance(mount, dict) and mount.get("type") == "bind":
                source = Path(mount["source"])
                if not source.is_relative_to(root):
                    raise ValueError("Unexpected canonical recovery bind source")
                mount["source"] = str(Path(meta["root"]) / source.relative_to(root))
    if not bootstrap.managed_model_equal(load_json((root / "config/compose.json").read_bytes()), model) or "network_cidr" not in cfg:
        raise ValueError("Recovery Compose differs from its canonical finite recipe")
    subnets = bootstrap.network_subnets(cfg["network_cidr"])
    pools = bootstrap.module_networks().pools(cfg)
    for network in meta["networks"]:
        subnet = ipaddress.IPv4Network(network["subnet"])
        if network["name"] in {meta["installation"] + "_" + name for name in CORE_NETWORKS}:
            if subnet != subnets[network["name"].rsplit("_", 1)[1]]:
                raise ValueError("Core recovery IPAM differs from configuration")
        elif not any(subnet.subnet_of(pool) for pool in pools):
            raise ValueError("Native recovery IPAM is outside its configured pools")
    for kind in meta["native"]:
        receipt = load_json((root / "state/delivery" / ("module-" + kind + ".json")).read_bytes())
        validate_module_receipt(receipt, kind)
    validate_networks(meta)
    return state, manifest


def validate_lifecycle_history(rt, parent, native, rows):
    """Read old failed attempts without rewriting history or replaying actions."""
    pending = {}
    directories = [(None, rt.root / "modules/operations")]
    directories += [(kind, rt.root / "modules" / kind / "operations") for kind in sorted(MODULES)]
    for kind, directory in directories:
        if not directory.is_dir():
            continue
        for journal in sorted(directory.glob("*.json")):
            value = load_json(journal.read_bytes())
            if isinstance(value, dict) and value.get("phase") in ("complete", "failed"):
                continue
            # The Prometheus controller uses a different journal/request codec.
            # Only the common native two-field operation record is recognized.
            trusted_directory(directory)
            private_file(journal, limit=4096)
            operation = journal.stem
            if (kind not in MODULES - {"prometheus"} or str(uuid.UUID(operation)) != operation
                    or operation in pending or len(pending) >= MAX_RESOURCES or not isinstance(value, dict)
                    or set(value) != {"phase", "fingerprint"} or value["phase"] != "running"
                    or not isinstance(value["fingerprint"], str) or not HEX.fullmatch(value["fingerprint"])):
                raise ValueError("A native lifecycle journal requires reconciliation before full backup")
            pending[operation] = (kind, value["fingerprint"])
    if not pending:
        return
    if int(rt.sql("SELECT count(*) FROM jobs WHERE status IN ('queued','running');").strip()):
        raise ValueError("Installation jobs are active; failed history cannot be admitted")
    # UUIDs were validated above. One bounded read joins exact operation IDs;
    # neither the PostgreSQL job nor its private controller journal is changed.
    ids = ",".join("'" + value + "'" for value in sorted(pending))
    jobs = load_json(rt.sql("SELECT COALESCE(json_agg(json_build_object('id',id,'kind',kind,'status',status,"
        "'target',target,'body',body)), '[]'::json) FROM public.jobs WHERE id IN (" + ids + ");"))
    if not isinstance(jobs, list) or len(jobs) != len(pending):
        raise ValueError("Failed native history has no unique terminal job")
    current = {value["id"]: value for value in rows}
    actual = {(kind, item["instance_id"]): item["running"]
              for kind, plan in native.items() for item in plan["instances"]}
    seen, healthy = set(), set()
    for job in jobs:
        if (not isinstance(job, dict) or set(job) != {"id", "kind", "status", "target", "body"}
                or not isinstance(job["id"], str) or job["id"] not in pending or job["id"] in seen
                or job["kind"] != "module" or job["status"] != "failed" or not isinstance(job["body"], dict)):
            raise ValueError("Failed native history has an ambiguous or nonterminal job")
        operation = job["id"]
        kind, fingerprint = pending[operation]
        body = job["body"]
        params = body.get("parameters")
        if (body.get("id") != operation or body.get("kind") != "module" or body.get("status") != "failed"
                or not isinstance(params, dict) or set(params) - {"instance_id", "action", "recovered"}
                or not {"instance_id", "action"} <= set(params)
                or "recovered" in params and type(params["recovered"]) is not bool):
            raise ValueError("Failed native history does not match its stored job body")
        instance, action = params["instance_id"], params["action"]
        if (not isinstance(instance, str) or str(uuid.UUID(instance)) != instance or job["target"] != instance
                or not isinstance(action, str) or not (action == "refresh" or kind == "grafana" and action == "install")
                or (kind, instance) not in actual or current.get(instance, {}).get("module_id") != kind
                or current[instance].get("observed_state") != ("running" if actual[(kind, instance)] else "disabled")):
            raise ValueError("Failed native history is outside the reconciled current graph")
        request = {"operation_id": operation, "instance_id": instance, "module_id": kind, "action": action}
        if action == "install":
            if not actual[(kind, instance)]:
                raise ValueError("A failed Grafana install requires a healthy current instance")
            request["public_url"] = rt.state["config"]["public_url"]
            if instance not in healthy:
                observation = parent.grafana().observe(instance)
                if observation.get("state") != "running" or observation.get("error") != "":
                    raise ValueError("A failed Grafana install requires fresh native readiness")
                healthy.add(instance)
        if hashlib.sha256(encoded(request) + b"\n").hexdigest() != fingerprint:
            raise ValueError("Failed native history differs from its exact stock request")
        seen.add(operation)


def collect(rt, host, prior=None):
    bootstrap, delivery_module, upgrade = helper("bootstrap"), helper("delivery"), helper("module-upgrade")
    parent = helper("module-controller").Controller(rt.root, rt.install_id)
    delivery = delivery_module.Delivery(parent, rt.package)
    state = rt.state
    registry = load_json((rt.private / "module-images.json").read_bytes())
    plans = {kind: upgrade.plan(parent, kind, registry[kind], registry[kind]) for kind in sorted(MODULES & registry.keys())}
    native = {kind: {"instances": [{"instance_id": item["instance_id"], "running": item["running"],
        "state_sha256": item["state_sha256"], "containers": [{"name": v["name"], "role": v["role"]} for v in item["containers"]]}
        for item in plan["instances"]]} for kind, plan in plans.items()}
    rows = load_json(rt.sql("SELECT COALESCE(json_agg(json_build_object('id',id,'module_id',body->>'module_id',"
                            "'desired_state',body->>'desired_state','observed_state',body->>'observed_state')), '[]'::json) FROM public.documents "
                            "WHERE kind='module_instance' AND body->>'mode'='local';"))
    expected_records = {(item["instance_id"], kind, "enabled" if item["running"] else "disabled")
                        for kind, plan in native.items() for item in plan["instances"]}
    if {(v["id"], v["module_id"], v["desired_state"]) for v in rows} != expected_records or len(rows) != len(expected_records):
        raise ValueError("PL local records and native runtime state are not reconciled")
    validate_lifecycle_history(rt, parent, native, rows)
    objects = upgrade._inventory(parent)
    known_native = {v["id"]: (kind, item["instance_id"], v["role"]) for kind, plan in plans.items()
                    for item in plan["instances"] for v in item["containers"]}
    containers = []
    prior_by_id = {value["id"]: value for value in (prior or {}).get("containers", [])}
    for obj in objects:
        labels = obj.get("Config", {}).get("Labels") or {}
        core = labels.get("com.docker.compose.project") == rt.install_id
        kind, instance, role = ("", "", "") if core else known_native.get(obj["Id"], (None, None, None))
        if kind is None or core and not obj.get("State", {}).get("Running") and obj["Id"] not in prior_by_id:
            raise ValueError("Incomplete or orphaned installation runtime")
        if (obj.get("HostConfig", {}).get("RestartPolicy") or {}).get("Name") != "unless-stopped":
            raise ValueError("Custom container restart policy is outside the recovery recipe")
        record = {"name": obj["Name"].removeprefix("/"), "id": obj["Id"], "running": obj.get("State", {}).get("Running") is True,
            "core": core, "service": labels.get("com.docker.compose.service", "") if core else "", "module_id": kind,
            "instance_id": instance, "role": role, "image": obj["Image"], "contract": container_contract(obj),
            "bindings": copy.deepcopy(obj.get("HostConfig", {}).get("PortBindings") or {})}
        if core and obj["Id"] in prior_by_id:
            record["running"] = prior_by_id[obj["Id"]]["running"]
        if prior and prior_by_id.get(obj["Id"]) != record:
            raise ValueError("Installation runtime recipe changed while closing writer admission")
        containers.append(record)
    if prior and {v["id"] for v in containers} != set(prior_by_id):
        raise ValueError("Installation container inventory changed while quiescing")
    volumes, paths = [], {}
    for index, item in enumerate(delivery.volumes()):
        obj, = load_json(host.docker("volume", "inspect", item["name"]))
        volumes.append({"name": item["name"], "labels": obj.get("Labels") or {}, "archive": "volume-" + str(index) + ".tar"})
        paths[item["name"]] = Path(item["path"])
    if {v["name"] for v in volumes} != {m["Name"] for obj in objects for m in obj.get("Mounts", []) if m.get("Type") == "volume"}:
        raise ValueError("Orphaned or unowned installation data volume")
    used_networks = {name for obj in objects for name in obj.get("NetworkSettings", {}).get("Networks", {})} - {"bridge"}
    networks = []
    for obj in host.inspect_all("network"):
        owned = (obj.get("Labels") or {}).get("pl.installation") == rt.install_id
        if not owned and obj.get("Name") not in used_networks:
            continue
        configs = obj.get("IPAM", {}).get("Config") or []
        if (not owned or obj["Name"] not in used_networks or obj.get("Driver") != "bridge" or obj.get("Scope") != "local"
                or obj.get("Ingress") or obj.get("EnableIPv6") or obj.get("Options") or len(configs) != 1
                or configs[0].get("IPRange") or configs[0].get("AuxiliaryAddresses")
                or set(obj.get("Containers") or {}) - {v["id"] for v in containers}):
            raise ValueError("Foreign, orphaned or unsupported installation network")
        networks.append({"name": obj["Name"], "id": obj["Id"], "labels": obj.get("Labels") or {},
                         "internal": obj.get("Internal") is True, "subnet": configs[0]["Subnet"], "gateway": configs[0]["Gateway"]})
    if {v["name"] for v in networks} != used_networks:
        raise ValueError("Incomplete installation network graph")
    supervisor = load_json((rt.root / "state/controller-supervisor.json").read_bytes())["version"]
    meta = {"schema": 1, "contract_version": 2, "product": "PL-full-disaster-backup", "backup_id": str(uuid.uuid4()), "created_unix": int(time.time()),
            "installation": rt.install_id, "root": str(rt.root), "origin": state["config"]["public_url"], "architecture": rt.m["architecture"],
            "version": state["version"], "manifest_sha256": state["manifest_sha256"], "supervisor_version": supervisor,
            "marker": load_json((rt.root / ".pl-installation.json").read_bytes()), "schema_contract": rt.schema,
            "live_auth_sha256": hashlib.sha256(encoded(rt.read_auth())).hexdigest(), "images": image_set(rt.m, registry, upgrade),
            "image_storage_bytes": 0,
            "registry": registry, "native": native, "containers": sorted(containers, key=lambda v: v["name"]), "volumes": volumes,
            "networks": sorted(networks, key=lambda v: v["name"]), "files": {},
            "controller_active": prior["controller_active"] if prior else host.unit_active(rt.install_id)}
    validate_unit(host, rt.root, rt.install_id, supervisor)
    host.verify_images(meta["images"])
    meta["image_storage_bytes"] = sum(load_json(host.docker("image", "inspect", identity))[0]["Size"] for identity in meta["images"])
    return meta, paths, parent, delivery


def stop_group(host, values):
    values = [v for v in values if v["running"]]
    if not values:
        return
    host.docker("container", "stop", "--time", "90", *[v["id"] for v in values], timeout=600)
    for obj in load_json(host.docker("container", "inspect", *[v["id"] for v in values])):
        state = obj.get("State", {})
        if state.get("Running") or state.get("OOMKilled") or state.get("ExitCode") not in (0, 143):
            raise ValueError("Writers did not stop cleanly; full backup refused")


def seal_archive(output, meta, folder):
    if len(encoded(meta)) > MAX_METADATA:
        raise ValueError("Full recovery metadata exceeds its supported size")
    temporary = output.with_name(output.name + ".partial." + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as raw, tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as archive:
            body = encoded(meta)
            import io
            member = tarfile.TarInfo("metadata.json"); member.size = len(body); member.mode = 0o600
            archive.addfile(member, io.BytesIO(body))
            for name in sorted(meta["files"]):
                path = folder / name
                member = tarfile.TarInfo(name); member.size = path.stat().st_size; member.mode = 0o600
                with path.open("rb") as source:
                    archive.addfile(member, source)
            archive.close(); raw.flush(); os.fsync(raw.fileno())
        # Publish without replacing a concurrently created destination.
        os.link(temporary, output, follow_symlinks=False)
        descriptor = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)
        descriptor = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)


def never_started(obj):
    state = obj.get("State", {})
    return (state.get("Status") == "created" and state.get("Running") is False
            and isinstance(state.get("StartedAt"), str) and state["StartedAt"].startswith("0001-01-01T00:00:00"))


def directory_paths(meta):
    return {"/api/v1/modules/" + item["instance_id"] + "/doska-directory/" + kind
            for item in meta["native"].get("doska", {}).get("instances", []) if item["running"]
            for kind in ("identity", "employees", "departments", "changes")}


def relay_allowed(meta, method, path):
    return method == "GET" and path.split("?", 1)[0] in directory_paths(meta)


def directory_config(meta, address):
    address = str(ipaddress.IPv4Address(address))
    locations = []
    for path in sorted(directory_paths(meta)):
        locations.append("location = " + path + " {\n"
            "if ($request_method != GET) { return 503; }\n"
            "proxy_pass http://" + address + ":8080;\nproxy_pass_request_headers off;\n"
            "proxy_pass_request_body off;\nproxy_set_header Content-Length \"\";\n"
            "proxy_set_header Host $http_host;\nproxy_set_header Authorization $http_authorization;\n"
            "proxy_set_header Accept application/json;\nproxy_set_header X-Forwarded-Proto https;\n"
            "proxy_http_version 1.1;\nproxy_set_header Connection \"\";\n"
            "proxy_connect_timeout 2s;\nproxy_read_timeout 15s;\nproxy_buffering off;\n}")
    return ("worker_processes 1;\npid /tmp/nginx.pid;\nerror_log /dev/stderr crit;\n"
        "events { worker_connections 128; }\nhttp { access_log off; server_tokens off;\n"
        "client_body_temp_path /tmp/client_temp;\nproxy_temp_path /tmp/proxy_temp;\n"
        "fastcgi_temp_path /tmp/fastcgi_temp;\nuwsgi_temp_path /tmp/uwsgi_temp;\nscgi_temp_path /tmp/scgi_temp;\n"
        "server { listen 8443 ssl;\nssl_certificate /run/pl/tls.crt;\nssl_certificate_key /run/pl/tls.key;\n"
        "ssl_protocols TLSv1.2 TLSv1.3;\nadd_header Cache-Control no-store always;\n"
        "add_header Retry-After 5 always;\nadd_header X-Content-Type-Options nosniff always;\n"
        + "\n".join(locations) + "\nlocation / { default_type text/plain; return 503 'PL: восстановление данных. Повторите подключение позже.\\n'; }\n}}\n").encode()


def timestamp(value):
    if not isinstance(value, str): raise ValueError("A native observation timestamp is required")
    result = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None: raise ValueError("A timezone is required")
    return result.timestamp()


def binding_projection_ready(projection, instance_id, expected, committed):
    try:
        instance, integration, job = (projection.get(key) for key in ("instance", "integration", "job"))
        if not isinstance(instance, dict) or not isinstance(job, dict): return False
        created = timestamp(job.get("created_at"))
        observed = job.get("result", {}).get("instance", {})
        if (created < committed or job.get("actor") != "system:modules" or job.get("kind") != "module" or job.get("status") != "succeeded"
                or job.get("parameters", {}).get("instance_id") != instance_id or job.get("parameters", {}).get("action") != "refresh"
                or instance.get("id") != instance_id or instance.get("module_id") != expected["module_id"]
                or instance.get("desired_state") != "enabled" or instance.get("observed_state") != "running" or instance.get("error")
                or instance.get("endpoint", "") != expected["endpoint"] or timestamp(instance.get("last_success")) < created
                or observed.get("id") != instance_id or observed.get("endpoint", "") != expected["endpoint"]
                or observed.get("observed_state") != "running" or observed.get("error") or timestamp(observed.get("last_success")) < created):
            return False
        if expected["module_id"] == "xray":
            return not expected["endpoint"] and not instance.get("integration_id") and not observed.get("integration_id")
        return (isinstance(integration, dict) and bool(instance.get("integration_id"))
                and integration.get("id") == instance["integration_id"] and integration.get("managed_module_id") == instance_id
                and integration.get("enabled") is True and integration.get("status") == "connected" and not integration.get("error")
                and integration.get("url") == expected["endpoint"] and timestamp(integration.get("last_success")) >= created)
    except (TypeError, ValueError, AttributeError, KeyError):
        return False


def flush_filesystems(paths):
    """Persist cold payload and Docker metadata before committing a resume-only journal."""
    if sys.platform != "linux":
        raise ValueError("Linux syncfs is required for durable disaster recovery")
    function = getattr(os, "syncfs", None)
    if function is None:
        library = ctypes.CDLL(None, use_errno=True)
        function = library.syncfs
        function.argtypes = [ctypes.c_int]; function.restype = ctypes.c_int
    devices = set()
    for path in paths:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            device = os.fstat(descriptor).st_dev
            if device in devices: continue
            result = function(descriptor)
            if result not in (None, 0):
                raise OSError(ctypes.get_errno(), "Recovery filesystem flush failed")
            devices.add(device)
        finally:
            os.close(descriptor)


def backup(root, output, host=None):
    host = host or Host()
    root, output = Path(root).absolute(), Path(output).absolute()
    if root != root.resolve() or output.parent != output.parent.resolve() or output.is_relative_to(root) or output.exists() or output.is_symlink():
        raise ValueError("Full backup requires a new private output outside the installation root")
    trusted_directory(output.parent)
    maintenance, delivery_module = helper("maintenance"), helper("delivery")
    with maintenance.installation(root) as rt:
        host.preflight(rt.m["architecture"])
        if not all(rt.services.values()):
            raise ValueError("Full backup requires all three managed core services running")
        if int(rt.sql("SELECT count(*) FROM jobs WHERE status IN ('queued','running');").strip()):
            raise ValueError("Installation jobs are active; retry full backup when idle")
        meta, volumes, parent, delivery = collect(rt, host)
        controller_stopped, stopped = False, False
        with tempfile.TemporaryDirectory(prefix="pl-dr-backup-", dir=output.parent) as temporary:
            folder = Path(temporary)
            try:
                total = sum(delivery_module.tree_size(root / name, exclude={"upgrade-backups", "transfers"})
                            for name in ("private", "config", "state", "modules"))
                total += sum(delivery_module.tree_size(path) for path in volumes.values())
                images_size = meta["image_storage_bytes"]
                releases_size = sum(delivery_module.tree_size(root / "releases" / version) for version in {meta["version"], meta["supervisor_version"]})
                if shutil.disk_usage(output.parent).free < 2 * (total + images_size + releases_size) + RESERVE:
                    raise ValueError("Insufficient space for a sealed full recovery archive")
                with (folder / "images.tar").open("xb") as target:
                    host.docker("image", "save", *sorted(meta["images"]), stdout=target, timeout=1800)
                stopped = True
                stop_group(host, [v for v in meta["containers"] if v["core"] and v["service"] in ("api", "web")])
                if meta["controller_active"]:
                    controller_stopped = True
                    host.run(["systemctl", "stop", rt.install_id + "-module-controller.service"])
                    if host.unit_active(rt.install_id):
                        raise ValueError("Host controller writers did not stop")
                if int(rt.sql("SELECT count(*) FROM jobs WHERE status IN ('queued','running');").strip()):
                    raise ValueError("Jobs were admitted while closing the source; full backup refused")
                closed, closed_volumes, parent, delivery = collect(rt, host, prior=meta)
                if closed["images"] != meta["images"] or closed_volumes != volumes:
                    raise ValueError("Installation data inventory changed before the cold snapshot")
                closed["backup_id"] = meta["backup_id"]
                meta = closed
                stop_group(host, [v for v in meta["containers"] if not v["core"] and v["role"] not in STORAGE.get(v["module_id"], set())])
                stop_group(host, [v for v in meta["containers"] if not v["core"] and v["role"] in STORAGE.get(v["module_id"], set())])
                stop_group(host, [v for v in meta["containers"] if v["core"] and v["service"] == "db"])
                actual = load_json(host.docker("container", "inspect", *[v["id"] for v in meta["containers"]]))
                if any(v.get("State", {}).get("Running") for v in actual) or {v["Id"] for v in actual} != {v["id"] for v in meta["containers"]}:
                    raise ValueError("Installation did not become cold")
                meta["live_auth_sha256"] = hashlib.sha256(encoded(rt.read_auth())).hexdigest()
                meta["created_unix"] = int(time.time())
                if {v["name"]: Path(v["path"]) for v in delivery.volumes()} != volumes:
                    raise ValueError("Owned data volumes changed during full-backup quiesce")
                excludes = set(EXCLUDE)
                for path in [root / "state/delivery", root / "modules/operations", *[root / "modules" / kind / "operations" for kind in MODULES]]:
                    if path.is_dir():
                        excludes.update(str(p.relative_to(root)) for p in path.glob("*.lock"))
                with tarfile.open(folder / "installation.tar", "w", format=tarfile.PAX_FORMAT) as archive:
                    for name in sorted(ROOTS - {"releases"}):
                        if (root / name).exists():
                            delivery_module.add_tree(archive, root / name, name, excludes)
                    archive.addfile(archive.gettarinfo(str(root / "releases"), arcname="releases"))
                    for version in sorted({meta["version"], meta["supervisor_version"]}):
                        delivery_module.add_tree(archive, root / "releases" / version, "releases/" + version)
                for volume in meta["volumes"]:
                    with tarfile.open(folder / volume["archive"], "w", format=tarfile.PAX_FORMAT) as archive:
                        delivery_module.add_tree(archive, volumes[volume["name"]], ".")
                for path in folder.iterdir():
                    path.chmod(0o600)
                    meta["files"][path.name] = {"bytes": path.stat().st_size, "sha256": checksum(path)}
                    if path.name != "images.tar":
                        validate_tree_archive(path, installation=path.name == "installation.tar")
                validate_metadata(meta)
                # Verify the exported release/config contract independently before publication.
                stage = folder / "check"; stage.mkdir(mode=0o700)
                delivery_module.restore_tree(folder / "installation.tar", stage)
                validate_package_tree(stage, meta)
                seal_archive(output, meta, folder)
            finally:
                if stopped:
                    if controller_stopped:
                        host.run(["systemctl", "start", rt.install_id + "-module-controller.service"])
                    delivery.restart(meta["containers"])
                    delivery.readiness()
    return {"backup_id": meta["backup_id"], "installation": meta["installation"], "sha256": checksum(output), "bytes": output.stat().st_size}


def resource_labels(labels, operation):
    result = dict(labels)
    result["pl.recovery.operation"] = operation
    return result


def account_preflight(marker, intent=None):
    try:
        account = pwd.getpwnam("pl")
    except KeyError:
        try: pwd.getpwuid(marker["uid"])
        except KeyError: pass
        else: raise ValueError("Recovery service UID belongs to another account")
        try: group = grp.getgrnam("pl")
        except KeyError:
            try: grp.getgrgid(marker["gid"])
            except KeyError: return False
            raise ValueError("Recovery service GID belongs to another group")
        owned = (isinstance(intent, dict) and intent.get("uid") == marker["uid"] and intent.get("gid") == marker["gid"]
                 and intent.get("group_intent") is True and group.gr_gid == marker["gid"] and not group.gr_mem)
        if not owned or grp.getgrgid(marker["gid"]).gr_name != "pl":
            raise ValueError("Recovery service group already exists without a proved creation intent")
        return False
    if (account.pw_uid != marker["uid"] or account.pw_gid != marker["gid"]
            or account.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin")):
        raise ValueError("Recovery service account differs from its preserved identity")
    if any(group.gr_name in {"docker", "sudo", "wheel", "adm"} and ("pl" in group.gr_mem or group.gr_gid == account.pw_gid)
           for group in grp.getgrall()):
        raise ValueError("Recovery service account has privileged membership")
    return True


def safe_root(root):
    if (not root.is_absolute() or root == Path("/") or root != root.resolve()
            or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(root)) or any(p.is_symlink() for p in [root, *root.parents])):
        raise ValueError("Use the original canonical dedicated installation root")
    helper("bootstrap").validate_root_socket_paths(root)
    trusted_directory(root.parent)


class Recovery:
    def __init__(self, root, meta, folder, archive_sha256, host=None):
        self.root, self.meta, self.folder = Path(root), meta, Path(folder)
        self.host = host or Host()
        self.expected = archive_sha256
        self.recovery = self.root / "recovery"
        self.journal = self.recovery / "operation.json"
        self.operation = None

    def write(self, **updates):
        self.operation.update(updates)
        atomic(self.journal, self.operation)

    def status(self):
        if self.operation is None:
            private_file(self.journal, limit=MAX_METADATA)
            self.operation = load_json(self.journal.read_bytes())
        result = {key: self.operation[key] for key in ("schema", "backup_id", "installation", "root", "phase", "committed")}
        for key in ("failed_step", "error_kind"):
            if key in self.operation: result[key] = self.operation[key]
        return result

    def validate_journal(self):
        private_file(self.journal, limit=MAX_METADATA)
        operation = load_json(self.journal.read_bytes())
        if (operation.get("schema") != 1 or operation.get("backup_id") != self.meta["backup_id"]
                or operation.get("installation") != self.meta["installation"] or operation.get("root") != str(self.root)
                or operation.get("archive_sha256") != self.expected or type(operation.get("committed")) is not bool
                or not isinstance(operation.get("created"), dict)
                or set(operation["created"]) != {"volume", "network", "container"}):
            raise ValueError("Recovery journal does not belong to this exact backup and target")
        failure = operation.get("last_failure")
        if failure is not None:
            if (not isinstance(failure, dict) or set(failure) != {"phase", "type", "frames"}
                    or any(not isinstance(failure.get(key), str) or not 0 < len(failure[key]) <= 128
                           or any(character in failure[key] for character in ("/", "\\", "\0", "\n", "\r"))
                           for key in ("phase", "type"))
                    or not isinstance(failure.get("frames"), list) or len(failure["frames"]) > 12):
                raise ValueError("Invalid private recovery failure frames")
            for frame in failure["frames"]:
                if (not isinstance(frame, dict) or set(frame) != {"file", "line", "function"}
                        or type(frame.get("line")) is not int or not 0 < frame["line"] < 2**31
                        or any(not isinstance(frame.get(key), str) or not 0 < len(frame[key]) <= 255
                               or any(character in frame[key] for character in ("/", "\\", "\0", "\n", "\r"))
                               for key in ("file", "function"))):
                    raise ValueError("Invalid private recovery failure frames")
        self.operation = operation

    def preflight_target(self):
        installation = self.meta["installation"]
        actual = {kind: self.host.inspect_all(kind) for kind in ("container", "volume", "network")}
        created_ids = {v["id"] for v in (self.operation or {}).get("created", {}).get("container", {}).values()}
        relay = (self.operation or {}).get("relay")
        if relay and not relay.get("removed"):
            created_ids.add(relay["id"])
        volume_names = {v["name"] for v in self.meta["volumes"]}
        for container in actual["container"]:
            if (container.get("Id") not in created_ids
                    and any(v.get("Type") == "volume" and v.get("Name") in volume_names for v in container.get("Mounts", []))):
                raise ValueError("A recovery volume is mounted by a foreign container")
        for kind, saved in (("container", self.meta["containers"]), ("volume", self.meta["volumes"]), ("network", self.meta["networks"])):
            records = (self.operation or {}).get("created", {}).get(kind, {})
            names = {v["name"] for v in saved}
            if kind == "container" and relay and not relay.get("removed"):
                records = {**records, relay["name"]: relay}; names.add(relay["name"])
            for obj in actual[kind]:
                labels = obj.get("Config", {}).get("Labels") if kind == "container" else obj.get("Labels")
                labels = labels or {}
                name = (obj.get("Name") or "").removeprefix("/")
                owned = labels.get("pl.installation") == installation or labels.get("com.docker.compose.project") == installation
                if name not in names and not owned:
                    continue
                record = records.get(name)
                if record is None or not self.matches(kind, obj, record):
                    raise ValueError("Target contains an existing or unproved resource; foreign data was not adopted")
                if kind == "network" and set(obj.get("Containers") or {}) - created_ids:
                    raise ValueError("A recovery network has a foreign member")
        if not self.operation:
            for suffix in ("-module-controller.service", "-icmp-probe.service", "-icmp-probe.socket"):
                path = Path("/etc/systemd/system") / (installation + suffix)
                if path.exists() or path.is_symlink():
                    raise ValueError("A host unit already owns the recovery installation identity")
            if any((Path(base) / installation).exists() for base in ("/usr/local/lib/pl/icmp", "/etc/pl/icmp")):
                raise ValueError("An ICMP host payload already owns the recovery identity")
        if self.operation and self.operation["committed"]:
            return
        allocated = [ipaddress.IPv4Network(v["subnet"]) for v in self.meta["networks"]]
        own_networks = (self.operation or {}).get("created", {}).get("network", {})
        for obj in actual["network"]:
            if obj.get("Name") in own_networks:
                continue
            for value in obj.get("IPAM", {}).get("Config") or []:
                if value.get("Subnet") and any(ipaddress.ip_network(value["Subnet"]).overlaps(net) for net in allocated):
                    raise ValueError("Recovery network overlaps an existing host network")
        routes = load_json(self.host.run(["ip", "-j", "-4", "route", "show", "table", "all"]))
        own_bridges = {"br-" + value["id"][:12] for value in own_networks.values()}
        for route in routes:
            if route.get("dst") == "default" or route.get("dev") in own_bridges:
                continue
            subnet = ipaddress.IPv4Network(route["dst"], strict=False)
            if subnet.prefixlen and any(subnet.overlaps(value) for value in allocated):
                raise ValueError("Recovery network overlaps a physical or VPN host route")
        if not (self.operation or {}).get("created", {}).get("container"):
            requested = set()
            for container in self.meta["containers"]:
                for bindings in container["bindings"].values():
                    for binding in bindings or []:
                        port = binding.get("HostPort", "")
                        if port in ("", "0"):
                            continue
                        address = binding.get("HostIp", "") or "0.0.0.0"
                        if not port.isdigit() or not 1 <= int(port) <= 65535:
                            raise ValueError("Invalid preserved host port")
                        requested.add((str(ipaddress.ip_address(address)), int(port)))
            for address, port in requested:
                try:
                    with socket.socket(socket.AF_INET6 if ":" in address else socket.AF_INET) as probe:
                        probe.bind((address, port))
                except OSError:
                    raise ValueError("A preserved recovery bind address or host port is unavailable") from None

    def matches(self, kind, obj, record):
        name = obj.get("Name", "").removeprefix("/")
        if kind == "container":
            return obj.get("Id") == record.get("id") and obj.get("Image") == record.get("image") and name == record.get("name")
        if kind == "network":
            return obj.get("Id") == record.get("id") and name == record.get("name") and obj.get("Labels") == record.get("labels")
        return (name == record.get("name") and obj.get("CreatedAt") == record.get("created_at")
                and obj.get("Mountpoint") == record.get("path") and obj.get("Labels") == record.get("labels")
                and obj.get("Driver") == "local" and not obj.get("Options"))

    def remember(self, kind, obj):
        name = obj["Name"].removeprefix("/")
        record = {"name": name}
        if kind == "container":
            record.update(id=obj["Id"], image=obj["Image"])
        else:
            record["labels"] = obj.get("Labels") or {}
            if kind == "network": record["id"] = obj["Id"]
            else: record.update(created_at=obj["CreatedAt"], path=obj["Mountpoint"])
        self.operation["created"][kind][name] = record
        self.write()

    @contextmanager
    def admission(self):
        safe_root(self.root)
        if self.meta["root"] != str(self.root):
            raise ValueError("Full restore requires the exact original root; path remapping is unsupported")
        exists = self.root.exists()
        if exists:
            for path in (self.root, self.recovery): trusted_directory(path)
            self.validate_journal()
        self.host.preflight(self.meta["architecture"])
        staged_manifest = load_json((self.folder / "root/releases" / self.meta["version"] / "manifest.json").read_bytes())
        if staged_manifest.get("features", {}).get("icmp_probe"):
            helper("icmp-install")._checked_file(Path("/usr/sbin/hping3"), 0, executable=True, read=False)
        account_exists = account_preflight(self.meta["marker"], (self.operation or {}).get("account"))
        self.preflight_target()
        if not exists:
            self.root.mkdir(mode=0o700)
            self.recovery.mkdir(mode=0o700)
            self.operation = {"schema": 1, "backup_id": self.meta["backup_id"], "installation": self.meta["installation"],
                "root": str(self.root), "archive_sha256": self.expected, "phase": "prepared", "committed": False,
                "created": {"volume": {}, "network": {}, "container": {}}, "files_installed": False,
                "restored_volumes": [], "rebindings": {}, "sessions_revoked": False}
            self.write()
        for name in ("state", "state/delivery", "modules", "private", "config"):
            trusted_directory(self.root / name, create=True)
        with ExitStack() as barriers:
            for name in ("state/install.lock", "state/delivery/delivery.lock", "state/delivery/worker.lock", "modules/controller.lock"):
                barriers.enter_context(lock(self.root / name))
            self.validate_journal()
            self.preflight_target()
            if not account_exists:
                account = self.operation.get("account") or {"uid": self.meta["marker"]["uid"], "gid": self.meta["marker"]["gid"], "group_intent": True}
                self.write(account=account)
                try: group = grp.getgrnam("pl")
                except KeyError:
                    self.host.run(["groupadd", "--system", "--gid", str(self.meta["marker"]["gid"]), "pl"])
                else:
                    if group.gr_gid != account["gid"] or group.gr_mem:
                        raise ValueError("Recovery service group changed during account creation")
                account["group_created"] = True; account["user_intent"] = True
                self.write(account=account)
                self.host.run(["useradd", "--system", "--uid", str(self.meta["marker"]["uid"]), "--gid", "pl",
                               "--home-dir", str(self.root / "state"), "--no-create-home", "--shell", "/usr/sbin/nologin", "pl"])
                if not account_preflight(self.meta["marker"], account):
                    raise ValueError("Recovery service account creation is incomplete")
                account["user_created"] = True; self.write(account=account)
            yield

    def install_files(self, *, strict_rebindings=False):
        if self.operation["files_installed"]:
            overrides = {}
            for instance, record in self.operation["rebindings"].items():
                path = "modules/grafana/instances/" + instance + "/state.json"
                original = load_json((self.folder / "root" / path).read_bytes())
                ingress = self.meta["installation"] + "_ingress"
                if (original.get("network_id") != record["old"]
                        or self.operation["created"]["network"].get(ingress, {}).get("id") != record["new"]):
                    raise ValueError("Invalid durable recovery network rebinding")
                candidate = encoded({**original, "network_id": record["new"]}) + b"\n"
                overrides[path] = candidate if strict_rebindings else ((self.folder / "root" / path).read_bytes(), candidate)
            verify_tree(self.folder / "installation.tar", self.root, overrides)
            return
        helper("delivery").restore_tree(self.folder / "installation.tar", self.root, preserve=PRESERVE)
        verify_tree(self.folder / "installation.tar", self.root)
        self.write(files_installed=True, phase="files")

    def create_resources(self):
        docker_root = Path(load_json(self.host.docker("info", "--format", "{{json .DockerRootDir}}")))
        if not docker_root.is_absolute() or docker_root != docker_root.resolve():
            raise ValueError("Unsafe local Docker data root")
        total = sum(v["bytes"] for key, v in self.meta["files"].items() if key.startswith("volume-"))
        if shutil.disk_usage(docker_root).free < total + RESERVE:
            raise ValueError("Insufficient space on the target Docker filesystem")
        for volume in self.meta["volumes"]:
            name = volume["name"]
            if name not in self.operation["created"]["volume"]:
                args = ["volume", "create", "--driver", "local"]
                labels = resource_labels(volume["labels"], self.meta["backup_id"])
                for key, value in sorted(labels.items()): args += ["--label", key + "=" + value]
                self.host.docker(*args, name)
                obj, = load_json(self.host.docker("volume", "inspect", name))
                path = Path(obj.get("Mountpoint", ""))
                if (obj.get("Name") != name or obj.get("Labels") != labels or obj.get("Driver") != "local" or obj.get("Options")
                        or path != docker_root / "volumes" / name / "_data" or path != path.resolve() or any(path.iterdir())):
                    raise ValueError("Recovery volume creation did not prove a new empty owned target")
                self.remember("volume", obj)
            obj, = load_json(self.host.docker("volume", "inspect", name))
            record = self.operation["created"]["volume"][name]
            if not self.matches("volume", obj, record):
                raise ValueError("Created recovery volume identity changed")
            if name not in self.operation["restored_volumes"]:
                self.preflight_target()
                path = record["path"]
                image = next(v["image"] for v in self.meta["containers"] if v["core"] and v["service"] == "web")
                self.host.docker("run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL",
                    "--cap-add", "SYS_CHROOT", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "FSETID", "--cap-add", "SETFCAP",
                    "--security-opt", "no-new-privileges:true", "--mount", "type=bind,source=/,target=/host,readonly",
                    "--mount", "type=volume,source=" + name + ",target=/host" + path, "--entrypoint", "/bin/busybox", image,
                    "chroot", "/host", "/usr/bin/python3", str(BASE / "delivery.py"), "--restore-volume", str(self.folder / volume["archive"]), "--target", path, timeout=1800)
                verify_tree(self.folder / volume["archive"], Path(path))
                self.operation["restored_volumes"].append(name)
                self.write(phase="volumes")
            else:
                verify_tree(self.folder / volume["archive"], Path(record["path"]))
        for network in self.meta["networks"]:
            name = network["name"]
            if name in self.operation["created"]["network"]:
                continue
            args = ["network", "create", "--driver", "bridge", "--subnet", network["subnet"], "--gateway", network["gateway"]]
            if network["internal"]: args += ["--internal"]
            labels = resource_labels(network["labels"], self.meta["backup_id"])
            for key, value in sorted(labels.items()): args += ["--label", key + "=" + value]
            identity = self.host.docker(*args, name).decode().strip()
            obj, = load_json(self.host.docker("network", "inspect", name))
            if obj.get("Id") != identity or not HEX.fullmatch(identity) or obj.get("Labels") != labels or obj.get("Containers"):
                raise ValueError("Recovery network creation could not be proved")
            self.remember("network", obj)
        self.write(phase="networks")

    def rebind_network_references(self):
        # Grafana native state deliberately pins the ingress network's physical
        # Docker ID. Rebind only this finite runtime field; no key or URL changes.
        ingress = self.meta["installation"] + "_ingress"
        old = next(v["id"] for v in self.meta["networks"] if v["name"] == ingress)
        new = self.operation["created"]["network"][ingress]["id"]
        for item in self.meta["native"].get("grafana", {}).get("instances", []):
            instance = item["instance_id"]
            path = self.root / "modules/grafana/instances" / instance / "state.json"
            value = load_json(path.read_bytes())
            original = load_json((self.folder / "root/modules/grafana/instances" / instance / "state.json").read_bytes())
            expected = {**original, "network_id": new}
            if value not in (original, expected) or original.get("network_id") != old:
                raise ValueError("Grafana recovery changed more than its physical network reference")
            if value.get("schema") != 2 or value.get("installation") != self.meta["installation"] or value.get("instance_id") != instance:
                raise ValueError("Unsupported Grafana recovery state")
            prior = self.operation["rebindings"].get(instance)
            if prior is None:
                if value.get("network_id") != old:
                    raise ValueError("Grafana recovery network reference drift")
                self.operation["rebindings"][instance] = {"old": old, "new": new, "before": checksum(path)}
                self.write()
            elif prior["old"] != old or prior["new"] != new:
                raise ValueError("Grafana recovery rebinding changed")
            if value["network_id"] == old:
                value["network_id"] = new
                atomic(path, value)
            elif value["network_id"] != new:
                raise ValueError("Grafana physical network identity changed outside recovery")

    def remember_container(self, obj, expected):
        if (obj.get("Name") != "/" + expected["name"] or obj.get("Image") != expected["image"]
                or not never_started(obj) or not container_contract_matches(obj, expected["contract"], self.meta)):
            raise ValueError("Reconstructed container differs from its closed preserved recipe")
        self.remember("container", obj)

    def native_docker(self, *args, **kwargs):
        allowed = {("container", "ls"), ("container", "inspect"), ("container", "create"), ("volume", "ls"), ("volume", "inspect"),
                   ("network", "ls"), ("network", "inspect"), ("network", "connect"), ("image", "inspect")}
        if args[0] != "info" and args[:2] not in allowed:
            raise ValueError("Precommit native reconstruction cannot start a writer")
        if args[:2] == ("network", "connect"):
            if args[-2] not in {v["name"] for v in self.meta["networks"]} or args[-1] not in {v["name"] for v in self.meta["containers"]}:
                raise ValueError("Native recipe attempted an unplanned network connection")
        if args[:2] == ("container", "create"):
            name = args[args.index("--name") + 1]
            if name not in {v["name"] for v in self.meta["containers"] if not v["core"]}:
                raise ValueError("Native recipe attempted an unplanned container")
        output = self.host.docker(*args, **kwargs)
        if args[:2] == ("container", "create"):
            identity = output.decode().strip()
            obj, = load_json(self.host.docker("container", "inspect", identity))
            if not HEX.fullmatch(identity) or obj["Id"] != identity or obj.get("State", {}).get("Running"):
                raise ValueError("Native create did not prove an exact stopped container identity")
            self.remember("container", obj)
        return output

    def construct(self):
        bootstrap, upgrade = helper("bootstrap"), helper("module-upgrade")
        rt = bootstrap.Runtime(self.root, self.root / "releases" / self.meta["version"], helper("bootstrap").manifest(self.root / "releases" / self.meta["version"]))
        rt.install_id = self.meta["installation"]
        for name, mode in (("run", 0o750), ("run/module-controller", 0o750), ("run/icmp-probe", 0o755), ("run/upgrade-status", 0o755)):
            if not (self.root / name).exists(): (self.root / name).mkdir(mode=mode)
        os.chown(self.root / "run/module-controller", 0, self.meta["marker"]["gid"])
        if rt.m.get("features", {}).get("icmp_probe"):
            icmp = helper("icmp-install")
            paths = icmp._paths(self.root, rt.install_id, None)
            if not paths["runtime_marker"].exists():
                atomic(paths["runtime_marker"], icmp._runtime_record(paths, rt.install_id, self.root, self.meta["marker"]["gid"]))
            icmp._verify_runtime(paths, rt.install_id, self.root, self.meta["marker"]["gid"], 0)
        parent = helper("module-controller").Controller(self.root, self.meta["installation"])
        for service in ("db", "api", "web"):
            spec = next(v for v in self.meta["containers"] if v["core"] and v["service"] == service)
            if spec["name"] in self.operation["created"]["container"]: continue
            self.host.docker("compose", "--project-name", self.meta["installation"], "--env-file", str(self.root / "private/runtime.env"),
                "-f", str(self.root / "config/compose.json"), "create", "--no-recreate", "--no-build", "--pull", "never", service)
            obj, = load_json(self.host.docker("container", "inspect", spec["name"]))
            self.remember_container(obj, spec)
        for kind, plan in self.meta["native"].items():
            for item in plan["instances"]:
                instance = item["instance_id"]
                c = upgrade._controller(parent, kind, self.meta["registry"][kind])
                for source_spec in item["containers"]:
                    spec = next(v for v in self.meta["containers"] if v["name"] == source_spec["name"])
                    if spec["name"] in self.operation["created"]["container"]:
                        if kind == "bookstack" and spec["role"] == "web":
                            self.ensure_bookstack_ingress(spec)
                        continue
                    c.docker = self.native_docker
                    role = spec["role"]
                    if kind == "prometheus": c.create(instance)
                    elif kind == "xray": c.create_container(instance, c.active(instance)["current"], start=False)
                    elif kind == "alertmanager": c.create_container(instance, start=False)
                    elif kind == "grafana": c.create(instance)
                    elif kind == "forms": c.create(instance, role)
                    elif kind == "sftpgo":
                        state = c.state(instance); c.create(instance, state["configuration"], state["revision"])
                    else:
                        c.create_container(instance, role)
                        if kind == "bookstack" and role == "web":
                            self.ensure_bookstack_ingress(spec)
                    obj, = load_json(self.host.docker("container", "inspect", spec["name"]))
                    self.remember_container(obj, spec)
        self.write(phase="constructed")

    def ensure_bookstack_ingress(self, spec):
        record = self.operation["created"]["container"][spec["name"]]
        obj, = load_json(self.host.docker("container", "inspect", record["id"]))
        if not self.matches("container", obj, record) or not never_started(obj):
            raise ValueError("BookStack ingress replay requires its exact never-started owned container")
        ingress = self.meta["installation"] + "_ingress"
        if ingress not in obj.get("NetworkSettings", {}).get("Networks", {}):
            self.host.docker("network", "connect", "--alias", "pl-bookstack-" + spec["instance_id"], ingress, record["id"])

    def validate_constructed(self):
        records = self.operation["created"]["container"]
        if set(records) != {v["name"] for v in self.meta["containers"]}:
            raise ValueError("Incomplete constructed recovery graph")
        self.preflight_target()
        for spec in self.meta["containers"]:
            obj, = load_json(self.host.docker("container", "inspect", records[spec["name"]]["id"]))
            if not never_started(obj) or not container_contract_matches(obj, spec["contract"], self.meta):
                raise ValueError("Recovery container changed or started before durable commit")
        self.install_files(strict_rebindings=True)
        for volume in self.meta["volumes"]:
            verify_tree(self.folder / volume["archive"], Path(self.operation["created"]["volume"][volume["name"]]["path"]))

    def private_api_address(self):
        spec = next(v for v in self.meta["containers"] if v["core"] and v["service"] == "api")
        record = self.operation["created"]["container"][spec["name"]]
        obj, = load_json(self.host.docker("container", "inspect", record["id"]))
        network = self.meta["installation"] + "_backend"
        endpoint = obj.get("NetworkSettings", {}).get("Networks", {}).get(network, {})
        address = ipaddress.IPv4Address(endpoint.get("IPAddress", ""))
        subnet = ipaddress.IPv4Network(next(v["subnet"] for v in self.meta["networks"] if v["name"] == network))
        if (not self.matches("container", obj, record) or not obj.get("State", {}).get("Running")
                or endpoint.get("NetworkID") != self.operation["created"]["network"][network]["id"]
                or address not in subnet or address in (subnet.network_address, subnet.broadcast_address, subnet.network_address + 1)):
            raise ValueError("Recovery API is outside its exact owned private backend")
        return str(address)

    def wait_private_api(self):
        deadline = time.monotonic() + 180
        while True:
            connection = None
            try:
                address = self.private_api_address()
                connection = http.client.HTTPConnection(address, 8080, timeout=5)
                connection.request("GET", "/health/ready")
                response = connection.getresponse(); response.read(65536)
                if response.status == 200: return address
            except (ValueError, OSError, http.client.HTTPException):
                pass
            finally:
                if connection is not None: connection.close()
            if time.monotonic() >= deadline: raise ValueError("Private restored API did not become ready")
            time.sleep(1)

    def relay_object(self, record):
        values = [v for v in self.host.inspect_all("container") if v.get("Id") == record["id"]]
        if not values: return None
        obj, = values
        if (not self.matches("container", obj, record) or obj.get("Config", {}).get("Labels") != record["labels"]
                or container_contract(obj) != record["contract"]):
            raise ValueError("Temporary Directory relay identity or recipe changed")
        return obj

    def ensure_relay_ingress(self, record):
        values = [v for v in self.host.inspect_all("container") if v.get("Id") == record["id"]]
        if not values: return False
        obj, = values
        if not self.matches("container", obj, record) or obj.get("Config", {}).get("Labels") != record["labels"]:
            raise ValueError("Temporary Directory relay identity changed before ingress attachment")
        ingress, backend = (self.meta["installation"] + "_" + value for value in ("ingress", "backend"))
        networks = obj.get("NetworkSettings", {}).get("Networks", {})
        if set(networks) - {ingress, backend} or backend not in networks:
            raise ValueError("Temporary Directory relay network graph changed")
        stripped = copy.deepcopy(obj)
        stripped["NetworkSettings"]["Networks"].pop(ingress, None)
        if container_contract(stripped) != record["base_contract"]:
            raise ValueError("Temporary Directory relay changed beyond its owned ingress attachment")
        for name in (backend, ingress):
            network_record = self.operation["created"]["network"][name]
            actual, = load_json(self.host.docker("network", "inspect", network_record["id"]))
            if not self.matches("network", actual, network_record):
                raise ValueError("Temporary Directory relay requires both exact owned core networks")
        if ingress not in networks:
            self.host.docker("network", "connect", self.operation["created"]["network"][ingress]["id"], record["id"])
            obj, = load_json(self.host.docker("container", "inspect", record["id"]))
            networks = obj.get("NetworkSettings", {}).get("Networks", {})
        endpoint = networks.get(ingress, {})
        aliases = set(endpoint.get("Aliases") or [])
        ipam = endpoint.get("IPAMConfig")
        empty_ipam = (ipam is None or type(ipam) is dict and set(ipam) == {"IPv4Address", "IPv6Address"}
                      and all(type(value) is str and value == "" for value in ipam.values()))
        if (set(networks) != {backend, ingress}
                or endpoint.get("NetworkID") not in (self.operation["created"]["network"][ingress]["id"], "", None)
                or not empty_ipam
                or aliases - {obj["Id"], obj["Id"][:12], obj["Name"].removeprefix("/")}):
            raise ValueError("Temporary Directory relay ingress attachment differs")
        record["contract"] = container_contract(obj); record["attach_pending"] = False
        self.write(relay=record)
        return True

    def remove_relay(self):
        record = self.operation.get("relay")
        if record and not record.get("removed") and record.get("attach_pending"):
            self.ensure_relay_ingress(record)
        if not record or record.get("removed"): return
        obj = self.relay_object(record)
        if obj is not None:
            if obj.get("State", {}).get("Running"):
                self.host.docker("container", "stop", "--time", "15", record["id"])
            obj = self.relay_object(record)
            if obj is None or obj.get("State", {}).get("Running"):
                raise ValueError("Temporary Directory relay did not stop safely")
            self.host.docker("container", "rm", record["id"])
        record["removed"] = True; self.write(relay=record)

    def start_relay(self, address):
        if self.operation["committed"] is not True or not self.operation["sessions_revoked"]:
            raise ValueError("Directory relay requires committed data and revoked archived sessions")
        config = directory_config(self.meta, address)
        checksum_value = hashlib.sha256(config).hexdigest()
        path = self.recovery / "directory-nginx.conf"
        record = self.operation.get("relay")
        if record and not record.get("removed") and record.get("attach_pending"):
            self.ensure_relay_ingress(record)
        if record and not record.get("removed") and record["config_sha256"] != checksum_value:
            self.remove_relay(); record = self.operation.get("relay")
        if record and not record.get("removed"):
            if not path.is_file() or path.is_symlink() or checksum(path) != checksum_value:
                raise ValueError("Temporary Directory relay configuration drift")
            obj = self.relay_object(record)
            if obj is not None:
                if not obj.get("State", {}).get("Running"): self.host.docker("container", "start", record["id"])
                return
        name = self.meta["installation"] + "-recovery-directory-" + self.meta["backup_id"]
        if any(v.get("Name") == "/" + name for v in self.host.inspect_all("container")):
            raise ValueError("An unproved container already occupies the Directory relay name")
        if path.exists():
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o444:
                raise ValueError("Unsafe temporary Directory relay config")
        temporary = path.with_name(path.name + ".new." + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
        try:
            with os.fdopen(fd, "wb") as out: out.write(config); out.flush(); os.fsync(out.fileno())
            os.replace(temporary, path); path.chmod(0o444)
        finally: temporary.unlink(missing_ok=True)
        cfg = load_json((self.root / "state/installation.json").read_bytes())["config"]
        image = next(v["image"] for v in self.meta["containers"] if v["core"] and v["service"] == "web")
        image_config, = load_json(self.host.docker("image", "inspect", image))
        labels = {**(image_config.get("Config", {}).get("Labels") or {}), "pl.installation": self.meta["installation"],
                  "pl.recovery.operation": self.meta["backup_id"], "pl.recovery.role": "directory-relay"}
        address_bind = cfg["bind_address"]
        published = ("[" + address_bind + "]" if ":" in address_bind else address_bind) + ":" + str(cfg["port"]) + ":8443"
        args = ["container", "create", "--name", name, "--network", self.meta["installation"] + "_backend",
            "--restart", "unless-stopped", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--memory", "128m", "--cpus", "0.5", "--pids-limit", "64", "--no-healthcheck",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=33554432,mode=1777", "--publish", published,
            "--mount", "type=bind,source=" + str(path) + ",target=/etc/nginx/nginx.conf,readonly",
            "--mount", "type=bind,source=" + str(self.root / "private/tls.crt") + ",target=/run/pl/tls.crt,readonly",
            "--mount", "type=bind,source=" + str(self.root / "private/tls.key") + ",target=/run/pl/tls.key,readonly"]
        for key in ("pl.installation", "pl.recovery.operation", "pl.recovery.role"): args += ["--label", key + "=" + labels[key]]
        identity = self.host.docker(*args, image).decode().strip()
        obj, = load_json(self.host.docker("container", "inspect", identity))
        if (not HEX.fullmatch(identity) or obj.get("Id") != identity or obj.get("Name") != "/" + name or obj.get("Image") != image
                or not never_started(obj) or obj.get("Config", {}).get("Labels") != labels):
            raise ValueError("Directory relay creation did not prove its exact stopped identity")
        record = {"name": name, "id": identity, "image": image, "labels": labels, "contract": container_contract(obj),
                  "base_contract": container_contract(obj), "attach_pending": True, "config_sha256": checksum_value, "removed": False}
        self.write(relay=record)
        self.ensure_relay_ingress(record)
        # The actual created ID and full finite recipe are durable before start.
        self.host.docker("container", "start", identity)

    def controller_socket_ready(self, properties):
        path = self.root / "run/module-controller/control.sock"
        try: info = path.lstat()
        except FileNotFoundError: return False
        if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid() or info.st_gid != self.meta["marker"]["gid"]
                or stat.S_IMODE(info.st_mode) != 0o660 or info.st_nlink != 1):
            raise ValueError("Foreign controller socket metadata")
        pid = int(properties["MainPID"])
        if properties["ActiveState"] != "active" or pid <= 0:
            raise ValueError("Controller socket has no canonical active unit peer")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(1)
            client.connect(str(path))
            peer_pid, peer_uid, _ = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        if peer_pid != pid or peer_uid != os.geteuid():
            raise ValueError("Controller socket peer differs from its canonical unit MainPID")
        current = path.lstat()
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("Controller socket changed during peer verification")
        return True

    def controller_activation_preflight(self):
        controller_records(self.root, self.meta)
        validate_package_tree(self.root, self.meta)
        runtime = self.root / "run/module-controller"
        trusted_directory(runtime)
        if runtime.stat().st_gid != self.meta["marker"]["gid"] or stat.S_IMODE(runtime.stat().st_mode) != 0o750:
            raise ValueError("Unsafe restored controller runtime directory")
        preserved = ("state/controller-active.json", "state/controller-supervisor.json", "private/module-images.json",
                     "private/module-controller-key", "config/delivery.json")
        for name in preserved:
            path = self.root / name
            if name.endswith("-key"):
                info = path.lstat()
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_gid != self.meta["marker"]["gid"]
                        or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o640 or info.st_size != 32):
                    raise ValueError("Unsafe restored controller key")
            else:
                private_file(path, limit=MAX_METADATA)
            if name != "config/delivery.json" and checksum(path) != checksum(self.folder / "root" / name):
                raise ValueError("Restored controller input differs from its verified archive")
        validate_delivery_configuration(self.root)
        trusted_directory(SYSTEMD_UNITS)
        unit = SYSTEMD_UNITS / (self.meta["installation"] + "-module-controller.service")
        paths = self.host.run(["systemctl", "show", "--property=UnitPath", "--value"]).decode().split()
        if not paths or len(paths) > 64 or any(not p.startswith("/") or "\0" in p or len(p) > 4096 for p in paths):
            raise ValueError("Invalid systemd controller lookup paths")
        stem = unit.name.removesuffix(".service")
        dropins = [unit.name + ".d", "service.d"] + ["-".join(stem.split("-")[:i]) + "-.service.d" for i in range(1, len(stem.split("-")))]
        for base in map(Path, paths):
            other = base / unit.name
            if other != unit and (other.exists() or other.is_symlink()):
                raise ValueError("A foreign controller unit lookup path exists")
            for name in dropins:
                path = base / name
                if path.is_symlink() or path.exists() and (not path.is_dir() or any(path.glob("*.conf"))):
                    raise ValueError("Controller unit drop-ins are unsupported")
        properties = controller_unit_state(self.host, unit)
        if unit.exists() or unit.is_symlink():
            validate_unit(self.host, self.root, self.meta["installation"], self.meta["supervisor_version"])
        elif properties["FragmentPath"] or properties["LoadState"] != "not-found" or int(properties["MainPID"]):
            raise ValueError("An existing controller unit was not proved")
        sock = runtime / "control.sock"
        if sock.exists() or sock.is_symlink():
            self.controller_socket_ready(properties)
        return unit

    def activate_controller(self):
        if self.operation["committed"] is not True:
            raise ValueError("Controller activation requires durable commit")
        unit = self.controller_activation_preflight()
        if not unit.exists():
            publish_unit(unit, unit_payload(self.root, self.meta["supervisor_version"]))
        self.host.run(["systemctl", "daemon-reload"])
        validate_unit(self.host, self.root, self.meta["installation"], self.meta["supervisor_version"])
        self.host.run(["systemctl", "enable", "--now", unit.name])
        self.host.run(["systemctl", "is-active", "--quiet", unit.name])
        deadline = time.monotonic() + 30
        while True:
            try:
                if self.controller_socket_ready(controller_unit_state(self.host, unit)): return
            except (OSError, ValueError):
                pass
            if time.monotonic() >= deadline:
                raise ValueError("Restored controller socket did not become ready")
            time.sleep(0.1)

    def resume_committed(self):
        if self.operation["committed"] is not True:
            raise ValueError("Recovery must commit before the first runtime start")
        self.write(phase="resuming")
        records = self.operation["created"]["container"]
        def start(values):
            for value in values:
                record = records[value["name"]]
                obj, = load_json(self.host.docker("container", "inspect", record["id"]))
                if not self.matches("container", obj, record):
                    raise ValueError("Committed recovery container identity changed")
                if not obj.get("State", {}).get("Running"):
                    self.host.docker("container", "start", record["id"])
        start([v for v in self.meta["containers"] if v["core"] and v["service"] == "db"])
        maintenance = helper("maintenance")
        rt = maintenance.Runtime(self.root)
        deadline = time.monotonic() + 180
        while True:
            try:
                rt.validate_runtime()
                break
            except (ValueError, OSError):
                if time.monotonic() >= deadline: raise ValueError("Restored core database did not become ready") from None
                time.sleep(1)
        if rt.schema != self.meta["schema_contract"]:
            raise ValueError("Restored schema differs")
        if not self.operation["sessions_revoked"] and hashlib.sha256(encoded(rt.read_auth())).hexdigest() != self.meta["live_auth_sha256"]:
            raise ValueError("Initial restored live authentication differs")
        rt.verify_connector_credentials()
        if not self.operation["sessions_revoked"]:
            rt.sql("BEGIN; DELETE FROM sessions; DELETE FROM oidc_states; DELETE FROM local_login_attempts; COMMIT;")
            if rt.sql("SELECT (SELECT count(*) FROM sessions)+(SELECT count(*) FROM oidc_states)+(SELECT count(*) FROM local_login_attempts);").strip() != b"0":
                raise ValueError("Archived PL sessions were not revoked")
            self.write(sessions_revoked=True)
        bootstrap = helper("bootstrap")
        self.activate_controller()
        if rt.m.get("features", {}).get("icmp_probe"):
            bootstrap.icmp_installer(rt.package).prepare(self.root, rt.package, rt.install_id,
                bootstrap.icmp_policy(rt.state["config"]), self.meta["marker"]["gid"], rt.run)
        web = next(v for v in self.meta["containers"] if v["core"] and v["service"] == "web")
        web_record = records[web["name"]]
        obj, = load_json(self.host.docker("container", "inspect", web_record["id"]))
        if not self.matches("container", obj, web_record): raise ValueError("Recovered web identity changed")
        if obj.get("State", {}).get("Running"):
            self.host.docker("container", "stop", "--time", "30", web_record["id"])
        start([v for v in self.meta["containers"] if v["core"] and v["service"] == "api"])
        self.start_relay(self.wait_private_api())
        running = [v for v in self.meta["containers"] if not v["core"] and v["running"]]
        start([v for v in running if v["role"] in STORAGE.get(v["module_id"], set())])
        start([v for v in running if v["role"] not in STORAGE.get(v["module_id"], set())])
        parent = helper("module-controller").Controller(self.root, rt.install_id)
        upgrade = helper("module-upgrade")
        endpoints = {}
        for kind, plan in self.meta["native"].items():
            c = upgrade._controller(parent, kind, self.meta["registry"][kind]) if plan["instances"] else None
            for item in plan["instances"]:
                deadline = time.monotonic() + 180
                while True:
                    try:
                        for source_spec in item["containers"]:
                            obj = upgrade._inspect(c, kind, item["instance_id"], source_spec["role"])
                            if obj is None or obj["Id"] != records[source_spec["name"]]["id"] or bool(obj["State"].get("Running")) is not item["running"]:
                                raise ValueError("Native recovered role state differs")
                        if item["running"]:
                            observed = c.observe(item["instance_id"])
                            if observed.get("state") != "running": raise ValueError("Native recovery is not ready")
                            endpoints[item["instance_id"]] = {"module_id": kind, "endpoint": observed.get("endpoint", "")}
                        break
                    except (ValueError, OSError):
                        if time.monotonic() >= deadline: raise ValueError("Native semantic readiness did not return; use resume") from None
                        time.sleep(1)
        self.write(phase="runtime_ready", endpoints=endpoints)

    def projection(self, rt, instance):
        if str(uuid.UUID(instance)) != instance:
            raise ValueError("Invalid recovery reconciliation identity")
        committed = float(self.operation["commit_unix"])
        query = ("SELECT json_build_object('instance',(SELECT body FROM public.documents WHERE kind='module_instance' AND id='" + instance + "'),"
            "'integration',(SELECT body FROM public.documents WHERE kind='integration' AND id=(SELECT body->>'integration_id' FROM public.documents "
            "WHERE kind='module_instance' AND id='" + instance + "')), 'job',(SELECT body FROM public.jobs WHERE actor='system:modules' "
            "AND kind='module' AND status='succeeded' AND target='" + instance + "' AND body#>>'{parameters,action}'='refresh' "
            "AND (body->>'created_at')::timestamptz>=to_timestamp(" + str(committed) + ") ORDER BY (body->>'created_at')::timestamptz DESC LIMIT 1));")
        return load_json(rt.sql(query))

    def reconcile_and_publish(self):
        # Ordinary controller refresh RPCs require delivery SH, so no install /
        # delivery / worker / lifecycle barrier is held during this committed
        # phase. The independent command lock still excludes a second recovery.
        if not self.operation["committed"] or self.operation.get("phase") == "complete": return
        rt = helper("maintenance").Runtime(self.root)
        deadline = time.monotonic() + 180
        while True:
            state = load_json((self.root / "state/installation.json").read_bytes())
            if (state.get("install_id") != self.meta["installation"] or state.get("version") != self.meta["version"]
                    or state.get("manifest_sha256") != self.meta["manifest_sha256"]):
                raise ValueError("Installation changed during committed recovery reconciliation")
            self.preflight_target()
            if all(binding_projection_ready(self.projection(rt, instance), instance, value, self.operation["commit_unix"])
                   for instance, value in self.operation.get("endpoints", {}).items()):
                break
            if time.monotonic() >= deadline:
                raise ValueError("Fresh native bindings did not reconcile; data retained and PL web remains closed")
            time.sleep(1)
        self.write(phase="publishing", bindings_verified_unix=time.time())
        self.remove_relay()
        spec = next(v for v in self.meta["containers"] if v["core"] and v["service"] == "web")
        record = self.operation["created"]["container"][spec["name"]]
        obj, = load_json(self.host.docker("container", "inspect", record["id"]))
        if not self.matches("container", obj, record): raise ValueError("Recovered web identity changed before publishing")
        self.host.docker("container", "start", record["id"])
        parent = helper("module-controller").Controller(self.root, self.meta["installation"])
        helper("delivery").Delivery(parent, rt.package).wait_readiness()
        self.write(phase="complete")

    def execute(self):
        with ExitStack() as command:
            admitted = False
            try:
                with self.admission():
                    command.enter_context(lock(self.recovery / "command.lock"))
                    admitted = True
                    if self.operation["phase"] == "complete": return self.status()
                    if not self.operation["committed"]:
                        docker_root = Path(load_json(self.host.docker("info", "--format", "{{json .DockerRootDir}}")))
                        if docker_root != docker_root.resolve() or not docker_root.is_dir():
                            raise ValueError("Unsafe target Docker filesystem")
                        required = self.meta["image_storage_bytes"] + sum(v["bytes"] for key, v in self.meta["files"].items()
                            if key != "images.tar") + RESERVE
                        if shutil.disk_usage(docker_root).free < required or shutil.disk_usage(self.root.parent).free < self.meta["files"]["installation.tar"]["bytes"] + RESERVE:
                            raise ValueError("Insufficient target space before image or data import")
                        self.host.docker("image", "load", "--input", str(self.folder / "images.tar"), timeout=1800)
                        self.host.verify_images(self.meta["images"])
                        self.install_files()
                        self.create_resources()
                        self.rebind_network_references()
                        self.write(phase="constructing")
                        self.construct()
                        self.validate_constructed()
                        flush_filesystems([self.root, docker_root, *[Path(v["path"]) for v in self.operation["created"]["volume"].values()]])
                        self.write(committed=True, phase="committed", commit_unix=time.time())
                    self.resume_committed()
                self.reconcile_and_publish()
            except BaseException as error:
                if admitted and self.operation is not None:
                    self.write(failed_step=self.operation["phase"], error_kind=type(error).__name__,
                               last_failure={"phase": self.operation["phase"], "type": type(error).__name__,
                                   "frames": [{"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name}
                                              for frame in traceback.extract_tb(error.__traceback__)[-12:]]},
                               phase="recovery_required" if self.operation["committed"] else "staging_failed")
                    if self.operation["committed"]:
                        # Publishing may have started the stateless web before
                        # its health failed. Close only its exact proved ID;
                        # retain the 503 Directory relay if it can be resumed.
                        try:
                            spec = next(v for v in self.meta["containers"] if v["core"] and v["service"] == "web")
                            record = self.operation["created"]["container"][spec["name"]]
                            obj, = load_json(self.host.docker("container", "inspect", record["id"]))
                            if self.matches("container", obj, record) and obj.get("State", {}).get("Running"):
                                self.host.docker("container", "stop", "--time", "30", record["id"])
                            self.start_relay(self.private_api_address())
                        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                            pass
                raise
            return self.status()


def restore(root, installation, path, expected, *, resume=False, host=None):
    root = Path(root).absolute()
    safe_root(root)
    with open_backup(Path(path), expected, root.parent) as (meta, folder):
        if installation != meta["installation"]:
            raise ValueError("Restore requires the original explicitly selected installation identity")
        stage = folder / "root"; stage.mkdir(mode=0o700)
        helper("delivery").restore_tree(folder / "installation.tar", stage)
        verify_tree(folder / "installation.tar", stage)
        validate_package_tree(stage, meta)
        if resume is not (root / "recovery/operation.json").exists():
            raise ValueError("Use restore for a cold target or resume for the exact existing recovery operation")
        return Recovery(root, meta, folder, expected, host).execute()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    b = sub.add_parser("backup", help="PRIVATE full offline backup; requires a ready idle source")
    b.add_argument("--root", required=True, type=Path); b.add_argument("--output", required=True, type=Path)
    for name in ("restore", "resume"):
        r = sub.add_parser(name, help="Cold same-identity restore; after commit only forward resume is possible")
        r.add_argument("--root", required=True, type=Path); r.add_argument("--installation-id", required=True)
        r.add_argument("--backup", required=True, type=Path); r.add_argument("--backup-sha256", required=True)
    s = sub.add_parser("status", help="Read the bounded private recovery receipt")
    s.add_argument("--root", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.action == "backup": result = backup(args.root, args.output)
        elif args.action == "status":
            safe_root(args.root)
            result = Recovery(args.root, {}, Path("/"), "").status()
        else:
            result = restore(args.root, args.installation_id, args.backup, args.backup_sha256, resume=args.action == "resume")
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError, subprocess.SubprocessError):
        # No raw error or subprocess output: archives and native probes contain secrets.
        print("PL disaster recovery did not complete. Data and private recovery journal were retained; inspect status before resume.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
