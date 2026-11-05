#!/usr/bin/env python3
"""Install the bounded PL core candidate on a local Linux Docker engine."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import http.cookiejar
import ipaddress
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import secrets
import socket
import ssl
import stat
import subprocess
import sys
import urllib.request
from urllib.parse import urlsplit

SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
FILES = {"bootstrap.py", "images.tar", "nginx.conf", "LICENSES.txt", "source.tar.gz", "README.md", "maintenance.py", "module-controller.py", "xray-controller.py", "alertmanager-controller.py", "wayline-controller.py", "grafana-controller.py", "forms-controller.py", "doska-controller.py", "sftpgo-controller.py", "netmap-controller.py", "bookstack-controller.py", "controller-supervisor.py", "installation-settings.py", "module-origin.py", "module-network.py", "icmp-probe.py", "icmp-install.py", "install.sh", "delivery.py", "delivery-proxy.py", "release-signing-public.pem"}
REQUIRED = {"bootstrap.py", "images.tar", "nginx.conf", "LICENSES.txt"}


# Module lifecycle operations and module RPCs share this host AF_UNIX endpoint.
# Linux sun_path has 108 bytes including its terminating NUL.
ROOT_SOCKET_PATHS = ("run/module-controller/control.sock", "run/icmp-probe/probe.sock")
UNIX_SOCKET_PATH_LIMIT = 107


def validate_root_socket_paths(root: Path) -> None:
    for relative in ROOT_SOCKET_PATHS:
        length = len(os.fsencode(root / relative))
        if length > UNIX_SOCKET_PATH_LIMIT:
            raise ValueError("Installation root is too long for Linux Unix sockets (" + str(length)
                             + " bytes; limit 107). Choose a shorter --root, for example /opt/pl.")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def read_json(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Required regular JSON file unavailable")
    return json.loads(path.read_text())


def write_file(path: Path, data: str | bytes, mode: int = 0o600) -> None:
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError("Unsafe destination file")
    temp = path.with_name(path.name + ".new." + secrets.token_hex(6))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data.encode() if isinstance(data, str) else data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        path.chmod(mode)
    finally:
        temp.unlink(missing_ok=True)


def write_json(path: Path, data: dict) -> None:
    write_file(path, json.dumps(data, indent=2) + "\n")


def directory(path: Path, mode: int) -> None:
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise ValueError("Unsafe installation directory")
    path.mkdir(mode=mode, parents=False, exist_ok=True)
    if path.stat().st_uid != os.geteuid():
        raise ValueError("Installation directory has a different owner")
    path.chmod(mode)


def managed_root(root: Path) -> None:
    """Validate host-wrapper ownership before changing even directory permissions."""
    marker = root / ".pl-installation.json"
    if root.is_symlink() or not root.is_dir() or marker.is_symlink() or not marker.is_file():
        raise ValueError("Installation root must first be prepared by install.sh")
    if root.stat().st_uid != os.geteuid() or marker.stat().st_uid != os.geteuid():
        raise ValueError("Installation identity has a different owner")
    record = read_json(marker)
    account = pwd.getpwnam("pl")
    if record.get("product") not in ("PL", "Pl") or record.get("uid") != account.pw_uid or record.get("gid") != account.pw_gid:
        raise ValueError("Installation identity does not match the PL service account")


def manifest(package: Path) -> dict:
    m = read_json(package / "manifest.json")
    if m.get("schema") not in (1, 2) or m.get("product") not in ("PL", "Pl") or not VERSION.fullmatch(m.get("version", "")):
        raise ValueError("Unsupported PL package manifest")
    arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
    if m.get("architecture") != arch:
        raise ValueError("Package CPU architecture does not match this host")
    features = m.get("features", {})
    if not isinstance(features, dict) or set(features) - {"local_users", "module_controller", "xray_module", "alertmanager_module", "wayline_module", "grafana_module", "forms_module", "doska_module", "sftpgo_module", "netmap_module", "bookstack_module", "connector_credentials", "icmp_probe", "on_demand_modules"} or any(type(v) is not bool for v in features.values()):
        raise ValueError("Unsupported core package features")
    if features.get("on_demand_modules"):
        payloads = {"install.sh", "delivery.py", "delivery-proxy.py", "release-signing-public.pem", "module-controller.py", "module-network.py", "xray-controller.py", "alertmanager-controller.py", "wayline-controller.py", "grafana-controller.py", "forms-controller.py", "doska-controller.py", "sftpgo-controller.py", "netmap-controller.py", "bookstack-controller.py", "controller-supervisor.py", "installation-settings.py", "module-origin.py"}
        if (m.get("schema") != 2 or not features.get("module_controller") or not isinstance(m.get("files"), dict) or not payloads <= m["files"].keys()
                or any(features.get(name + "_module") for name in ("xray", "alertmanager", "wayline", "grafana", "forms", "doska", "sftpgo", "netmap", "bookstack"))):
            raise ValueError("On-demand core requires its finite delivery controllers without bundled modules")
    if features.get("connector_credentials") and m.get("schema") != 2:
        raise ValueError("Connector credentials require a schema-2 package")
    files = m.get("files", {})
    if features.get("icmp_probe") and (m.get("schema") != 2 or not isinstance(files, dict)
                                       or not {"icmp-probe.py", "icmp-install.py"} <= files.keys()):
        raise ValueError("ICMP feature requires its trusted host helper payload")
    if features.get("module_controller") and "module-controller.py" not in files:
        raise ValueError("Module controller payload required by package feature")
    if features.get("xray_module") and (m.get("schema") != 2 or not features.get("module_controller") or "xray-controller.py" not in files):
        raise ValueError("Xray feature requires module controller and payload")
    if features.get("alertmanager_module") and (m.get("schema") != 2 or not features.get("module_controller")
            or not isinstance(files, dict) or not {"alertmanager-controller.py", "xray-controller.py"} <= files.keys()):
        raise ValueError("Alertmanager module requires its controller and trusted file primitives")
    if features.get("wayline_module") and (m.get("schema") != 2 or not features.get("module_controller")
            or not isinstance(files, dict) or not {"wayline-controller.py", "xray-controller.py"} <= files.keys()):
        raise ValueError("Wayline module requires its controller and trusted file primitives")
    if features.get("grafana_module") and (m.get("schema") != 2 or not features.get("module_controller")
            or not isinstance(files, dict) or not {"grafana-controller.py", "xray-controller.py"} <= files.keys()):
        raise ValueError("Grafana module requires its controller and trusted file primitives")
    for module in ("forms", "doska", "sftpgo", "netmap", "bookstack"):
        if features.get(module + "_module") and (m.get("schema") != 2 or not features.get("module_controller")
                or not isinstance(files, dict) or not {module + "-controller.py", "xray-controller.py"} <= files.keys()):
            raise ValueError("Application module requires its controller and trusted file primitives")
    if not isinstance(files, dict) or not REQUIRED <= files.keys() <= FILES:
        raise ValueError("Unexpected package file set")
    for name, expected in files.items():
        p = package / name
        if (not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected)
                or p.is_symlink() or not p.is_file() or digest(p) != expected):
            raise ValueError("Package file integrity check failed")
    images = m.get("images", {})
    if m["schema"] == 1:
        if set(images) != {"api", "web", "db"}:
            raise ValueError("Expected exactly the legacy core image set")
        for name in ("api", "web"):
            if not SHA.fullmatch(images[name].get("id", "")):
                raise ValueError("Core image content ID required")
        if not re.fullmatch(r"postgres:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}", images["db"].get("ref", "")):
            raise ValueError("Immutable PostgreSQL image required")
    else:
        validate_bundled_images(m)
    legacy_worker_handoff(package, m)
    return m


def legacy_worker_handoff(package: Path, candidate: dict) -> None:
    """Bridge the one pre-snapshot entry point available to older updaters.

    Ordinary manifest validation is pure. Only PID1's real pinned old worker,
    while staging its exact signed target, may promote itself to that worker.
    """
    main = sys.modules.get('__main__')
    if (__name__ != 'pl_candidate_bootstrap' or not candidate.get('features', {}).get('icmp_probe')
            or getattr(main, 'HOST_FEATURE_API', 0) >= 1
            or len(sys.argv) != 6 or sys.argv[1] != 'worker' or sys.argv[2] != '--root' or sys.argv[4] != '--operation-id'):
        return
    root, operation_id = Path(sys.argv[3]), sys.argv[5]
    main_path = Path(getattr(main, '__file__', ''))
    # A validation command with incidental worker-shaped argv cannot hand off.
    if (not root.is_absolute() or root != root.resolve() or root == Path('/')
            or not main_path.is_absolute() or main_path != main_path.resolve()
            or main_path.name != 'delivery.py' or main_path.parent.parent != root / 'releases'):
        return
    import types
    spec = importlib.util.spec_from_file_location('pl_candidate_handoff', package / 'delivery.py')
    delivery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(delivery)
    delivery.canonical_id(operation_id)
    state = delivery.read(root / 'state/installation.json')
    anchor = delivery.read(root / 'state/controller-supervisor.json')
    if set(anchor) != {'schema', 'version'} or anchor.get('schema') != 1 or not VERSION.fullmatch(anchor.get('version', '')):
        raise ValueError('Invalid legacy worker trust anchor')
    validator = delivery.Delivery(types.SimpleNamespace(root=root, installation=state['install_id']))
    validator.supervisor = root / 'releases' / anchor['version']
    operation = delivery.read(validator.base / 'operation.json')
    if (operation.get('operation_id') != operation_id or operation.get('kind', '') not in ('', 'upgrade')
            or operation.get('phase') != 'downloading' or 'containers' in operation or 'snapshot' in operation
            or 'worker_handoff' in operation or operation.get('from_version') != state.get('version')
            or operation.get('version') != candidate['version'] or package != root / 'releases' / candidate['version']
            or (root / 'private/upgrade-backups' / operation_id / 'snapshot.json').exists()
            or main_path.parent.name != operation.get('worker_version', anchor['version'])
            or candidate.get('core_api', 1) != 1 or candidate.get('schema') != 2
            or set(candidate.get('images', {})) != {'api', 'web', 'db'}
            or not candidate.get('features', {}).get('on_demand_modules')
            or not delivery.newer(candidate['version'], state.get('version', ''))):
        raise ValueError('Legacy worker handoff is outside the pre-snapshot stage')
    expected_unit = state['install_id'] + '-upgrade-' + operation_id.replace('-', '') + '.service'
    if operation.get('worker_unit') != expected_unit:
        raise ValueError('Legacy worker unit identity differs')
    groups = Path('/proc/self/cgroup').read_text().splitlines()
    if not any(line.endswith('/' + expected_unit) for line in groups):
        raise ValueError('Legacy worker is outside its fixed service unit')
    if validator.host(['systemctl', 'show', '--property=MainPID', '--value', expected_unit], timeout=5).strip() != str(os.getpid()).encode():
        raise ValueError('Legacy worker is not the service main process')
    if os.environ.get('PL_HOST_SUPERVISOR_PACKAGE') != str(validator.supervisor):
        raise ValueError('Legacy worker immutable anchor differs')
    old_package = validator.worker_package(operation, recovering=True)
    if old_package != main_path.parent:
        raise ValueError('Legacy worker payload differs')
    validator.verified_worker_release(operation['from_version'], state.get('manifest_sha256'))
    validator.verified_worker_release(anchor['version'])
    validator.verified_worker_release(candidate['version'])
    if (package / '.package-sha256').read_text().strip() != operation['artifact']['sha256']:
        raise ValueError('Legacy worker signed artifact identity differs')
    old = delivery.read(root / 'releases' / operation['from_version'] / 'manifest.json')
    if candidate.get('database', {}).get('major') != old.get('database', {}).get('major'):
        raise ValueError('Legacy worker handoff requires the same PostgreSQL major')
    checksum = digest(package / 'manifest.json')
    operation['worker_handoff'] = {'schema': 1, 'capability': 1, 'from_version': old_package.name,
                                   'from_manifest_sha256': operation.get('worker_manifest_sha256', digest(old_package / 'manifest.json')),
                                   'core_from_version': operation['from_version'],
                                   'to_version': candidate['version'], 'to_manifest_sha256': checksum}
    operation.update(worker_version=candidate['version'], worker_manifest_sha256=checksum)
    delivery.atomic(validator.base / 'operation.json', operation)
    # CLOEXEC closes the old lifecycle/worker lock descriptors. The durable
    # nonterminal operation keeps every controller mutation blocked meanwhile.
    os.execve('/usr/bin/python3', ['/usr/bin/python3', str(package / 'delivery.py'), 'worker', '--root', str(root),
                                  '--operation-id', operation_id],
              {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
               'PL_HOST_SUPERVISOR_PACKAGE': str(validator.supervisor)})


def validate_bundled_images(m: dict) -> None:
    """Finite schema-2 runtime contract. All images travel inside the package."""
    expected = {"api": {}, "web": {},
                "db": {"pl.component": "postgresql", "pl.postgresql.version": "18.6", "pl.gosu.version": "1.19", "pl.gosu.go.version": "1.27.2"},
                "prometheus": {"pl.module.id": "prometheus", "pl.module.config.version": "1", "org.opencontainers.image.version": "3.15.0", "pl.build.go": "1.27.2", "pl.build.x-net": "v0.61.0"}}
    if m.get("features", {}).get("on_demand_modules"):
        expected.pop("prometheus")
    if m.get("features", {}).get("xray_module"):
        xray = m.get("images", {}).get("xray", {})
        labels = xray.get("labels", {})
        if (not isinstance(labels, dict) or set(labels) != {"pl.source.sha256", "pl.module.id", "pl.module.config.version", "org.opencontainers.image.version", "org.opencontainers.image.revision", "org.opencontainers.image.source", "org.opencontainers.image.licenses", "pl.build.variant", "pl.build.go"}
                or not re.fullmatch(r"[0-9a-f]{40}", labels.get("org.opencontainers.image.revision", ""))
                or labels.get("org.opencontainers.image.source") != "https://github.com/XTLS/Xray-core"
                or labels.get("org.opencontainers.image.licenses") != "MPL-2.0" or labels.get("pl.build.variant") != "source-build"
                or labels.get("pl.module.id") != "xray" or labels.get("pl.module.config.version") != "1"
                or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", labels.get("org.opencontainers.image.version", ""))
                or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", labels.get("pl.build.go", ""))):
            raise ValueError("Invalid Xray version/provenance contract")
        expected["xray"] = {k: v for k, v in labels.items() if k != "pl.source.sha256"}
    if m.get("features", {}).get("alertmanager_module"):
        alertmanager = m.get("images", {}).get("alertmanager", {})
        labels = alertmanager.get("labels", {})
        fields = {"pl.source.sha256", "pl.module.id", "pl.module.config.version", "org.opencontainers.image.version", "org.opencontainers.image.revision", "org.opencontainers.image.source", "org.opencontainers.image.licenses", "pl.build.variant", "pl.build.go"}
        if (not isinstance(labels, dict) or set(labels) != fields or labels.get("pl.module.id") != "alertmanager"
                or labels.get("pl.module.config.version") != "1" or labels.get("pl.build.variant") != "source-build"
                or labels.get("org.opencontainers.image.source") != "https://github.com/prometheus/alertmanager"
                or labels.get("org.opencontainers.image.licenses") != "Apache-2.0"
                or not re.fullmatch(r"[0-9a-f]{40}", labels.get("org.opencontainers.image.revision", ""))
                or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", labels.get("org.opencontainers.image.version", ""))
                or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", labels.get("pl.build.go", ""))):
            raise ValueError("Invalid Alertmanager version/provenance contract")
        expected["alertmanager"] = {k: v for k, v in labels.items() if k != "pl.source.sha256"}
    if m.get("features", {}).get("grafana_module"):
        labels = m.get("images", {}).get("grafana", {}).get("labels", {})
        fields = {"pl.source.sha256", "pl.module.id", "pl.module.config.version", "org.opencontainers.image.version", "org.opencontainers.image.revision", "org.opencontainers.image.source", "org.opencontainers.image.licenses", "pl.build.variant"}
        if isinstance(labels, dict) and labels.get("pl.build.variant") == "source-build-pl-signed":
            fields.add("pl.build.go")
            if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", labels.get("pl.build.go", "")):
                raise ValueError("Missing Grafana source-build toolchain identity")
        if (not isinstance(labels, dict) or set(labels) != fields or labels.get("pl.module.id") != "grafana"
                or labels.get("pl.module.config.version") != "1" or labels.get("pl.build.variant") not in ("upstream-pinned", "source-build-pl-signed")
                or labels.get("org.opencontainers.image.source") != "https://github.com/grafana/grafana"
                or labels.get("org.opencontainers.image.licenses") != "AGPL-3.0-only"
                or not re.fullmatch(r"[0-9a-f]{40}", labels.get("org.opencontainers.image.revision", ""))
                or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", labels.get("org.opencontainers.image.version", ""))):
            raise ValueError("Invalid Grafana version/provenance contract")
        expected["grafana"] = {key: value for key, value in labels.items() if key != "pl.source.sha256"}
    if m.get("features", {}).get("wayline_module"):
        version = None
        for role in ("api", "gateway", "runner"):
            name = "wayline-" + role
            labels = m.get("images", {}).get(name, {}).get("labels", {})
            fields = {"pl.source.sha256", "pl.module.id", "pl.module.config.version", "pl.module.role", "org.opencontainers.image.version", "pl.build.variant"}
            if (not isinstance(labels, dict) or set(labels) != fields or labels.get("pl.module.id") != "wayline"
                    or labels.get("pl.module.config.version") != "1" or labels.get("pl.module.role") != role
                    or labels.get("pl.build.variant") != "source-build"
                    or not VERSION.fullmatch(labels.get("org.opencontainers.image.version", ""))):
                raise ValueError("Invalid Wayline image role/version contract")
            current = labels["org.opencontainers.image.version"]
            if version is not None and version != current:
                raise ValueError("Wayline image versions differ")
            version = current
            expected[name] = {key: value for key, value in labels.items() if key != "pl.source.sha256"}
    for module, roles in (("forms", ("adapter", "engine", "mongo", "keydb")), ("doska", ("api", "web")), ("sftpgo", ("server",)), ("netmap", ("database", "cache", "netbox", "netbox-worker", "oxidized", "gitea", "adapter")), ("bookstack", ("web", "database"))):
        if not m.get("features", {}).get(module + "_module"):
            continue
        version = None
        for role in roles:
            name = module + "-" + role
            labels = m.get("images", {}).get(name, {}).get("labels", {})
            upstream = (module == "forms" and role != "adapter") or (module == "netmap" and role != "adapter") or module == "bookstack"
            fields = {"pl.source.sha256", "pl.module.id", "pl.module.config.version", "pl.module.role", "org.opencontainers.image.version", "pl.build.variant"} | ({"pl.upstream.version"} if upstream else set())
            if (not isinstance(labels, dict) or set(labels) != fields or labels.get("pl.module.id") != module
                    or labels.get("pl.module.config.version") != "1" or labels.get("pl.module.role") != role
                    or labels.get("pl.build.variant") != ("upstream-pinned" if upstream or module == "sftpgo" else "source-build")
                    or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", labels.get("org.opencontainers.image.version", ""))
                    or (upstream and not re.fullmatch(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?", labels.get("pl.upstream.version", "")))):
                raise ValueError("Invalid application image role/version contract")
            current = labels["org.opencontainers.image.version"]
            if version is not None and current != version:
                raise ValueError("Application image versions differ")
            version = current
            expected[name] = {key: value for key, value in labels.items() if key != "pl.source.sha256"}
    images = m.get("images", {})
    source = m.get("source_sha256", "")
    database = {"major": 18, "version": "18.6", "volume_target": "/var/lib/postgresql", "pgdata": "/var/lib/postgresql/18/docker"}
    if (set(images) != set(expected) or not re.fullmatch(r"[0-9a-f]{64}", source)
            or m.get("database") != database or m.get("features", {}).get("module_controller") is not True):
        raise ValueError("Unsupported bundled runtime contract")
    for name, labels in expected.items():
        image = images[name]
        application = name.split("-", 1)[0]
        recipe = "deploy/images/" + application + ".Dockerfile" if application in ("forms", "doska", "sftpgo", "netmap", "bookstack") else "deploy/images/wayline.Dockerfile" if name.startswith("wayline-") else {"db": "deploy/images/postgres.Dockerfile", "prometheus": "deploy/images/prometheus.Dockerfile", "xray": "deploy/images/xray.Dockerfile", "alertmanager": "deploy/images/alertmanager.Dockerfile", "grafana": "deploy/images/grafana.Dockerfile"}.get(name, "Dockerfile")
        if (not isinstance(image, dict) or set(image) != {"id", "architecture", "ref", "recipe", "labels"}
                or not SHA.fullmatch(image.get("id", "")) or image.get("architecture") != m["architecture"]
                or image.get("recipe") != recipe
                or image.get("labels") != {"pl.source.sha256": source, **labels}
                or not re.fullmatch(r"pl/core-" + name + r":[A-Za-z0-9][A-Za-z0-9._-]{0,63}", image.get("ref", ""))):
            raise ValueError("Bundled image identity/provenance is invalid")


def database_mount(m: dict) -> str:
    return "/var/lib/postgresql" if m.get("schema") == 2 else "/var/lib/postgresql/data"


def module_networks():
    path = Path(__file__).with_name("module-network.py")
    if path.is_symlink() or not path.is_file():
        raise ValueError("Trusted module network allocator unavailable")
    spec = importlib.util.spec_from_file_location("pl_installer_networks", path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def network_cidr(value: str) -> ipaddress.IPv4Network:
    try:
        network = ipaddress.IPv4Network(value, strict=True)
    except (ValueError, TypeError):
        raise ValueError("Network CIDR must be a canonical RFC1918 IPv4 /24") from None
    private = (ipaddress.IPv4Network("10.0.0.0/8"), ipaddress.IPv4Network("172.16.0.0/12"), ipaddress.IPv4Network("192.168.0.0/16"))
    if network.prefixlen != 24 or str(network) != value or not any(network.subnet_of(block) for block in private):
        raise ValueError("Network CIDR must be a canonical RFC1918 IPv4 /24")
    return network


def network_subnets(value: str) -> dict:
    return dict(zip(("backend", "ingress", "egress"), list(network_cidr(value).subnets(new_prefix=26))[:3]))


INTEGRATION_UID = 10001
INTEGRATION_GID = 10001
INTEGRATION_PROFILE_LIMIT = 64 * 1024
INTEGRATION_SECRET_LIMIT = 16 * 1024
INTEGRATION_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\Z")
INTEGRATION_INPUT_ERROR = "Integration configuration requires private regular files and bounded explicit values"
INTEGRATION_STATE_ERROR = "Integration secrets are missing or differ; reprovision on a fresh target, never rotate implicitly"
CONNECTOR_KEY_TARGET = "/run/secrets/integration-credential-key"
CONNECTOR_KEY_ERROR = "Persistent connector credential key is missing or unsafe; restore the matching private key, never regenerate it"


def _integration_json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(INTEGRATION_INPUT_ERROR)
        value[key] = item
    return value


def _integration_read(path: Path, *, owner: set[int], modes: set[int], limit: int) -> bytes:
    """Open every path component without following links; never print a source path."""
    fd = directory_fd = None
    try:
        if not path.is_absolute() or ".." in path.parts:
            raise ValueError(INTEGRATION_INPUT_ERROR)
        directory_fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = child
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in owner
                or stat.S_IMODE(info.st_mode) not in modes or not 0 < info.st_size <= limit):
            raise ValueError(INTEGRATION_INPUT_ERROR)
        with os.fdopen(fd, "rb") as stream:
            fd = None
            data = stream.read(limit + 1)
            after = os.fstat(stream.fileno())
        if (not 0 < len(data) <= limit or after.st_size != len(data)
                or (after.st_dev, after.st_ino, after.st_uid, after.st_mode, after.st_mtime_ns, after.st_ctime_ns)
                != (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_mtime_ns, info.st_ctime_ns)):
            raise ValueError(INTEGRATION_INPUT_ERROR)
        return data
    except (OSError, ValueError):
        raise ValueError(INTEGRATION_INPUT_ERROR) from None
    finally:
        if fd is not None:
            os.close(fd)
        if directory_fd is not None:
            os.close(directory_fd)


def connector_service_gid(root: Path) -> int:
    marker = read_json(root / ".pl-installation.json")
    gid = marker.get("gid")
    if type(gid) is not int or not 1 <= gid <= 2**31 - 1:
        raise ValueError(CONNECTOR_KEY_ERROR)
    return gid


def read_connector_key(root: Path) -> bytes:
    try:
        private = root / "private"
        info = private.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError
        path = private / "integration-credential-key"
        value = _integration_read(path, owner={os.geteuid()}, modes={0o640}, limit=32)
        info = path.lstat()
        if len(value) != 32 or info.st_gid != connector_service_gid(root) or info.st_nlink != 1:
            raise ValueError
        return value
    except (OSError, ValueError):
        raise ValueError(CONNECTOR_KEY_ERROR) from None


def prepare_connector_key(root: Path, *, existing: bool) -> None:
    """Create once. A missing key on an existing install is never a rotation request."""
    path = root / "private/integration-credential-key"
    if path.exists() or path.is_symlink() or existing:
        read_connector_key(root)
        return
    gid = connector_service_gid(root)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchown(stream.fileno(), os.geteuid(), gid)
            os.fchmod(stream.fileno(), 0o640)
            stream.write(secrets.token_bytes(32))
            stream.flush()
            os.fsync(stream.fileno())
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        read_connector_key(root)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def restore_connector_key(root: Path, value: bytes) -> None:
    """Restore only while API is stopped; retain the inode of its readonly bind."""
    read_connector_key(root)
    if not isinstance(value, bytes) or len(value) != 32:
        raise ValueError(CONNECTOR_KEY_ERROR)
    path = root / "private/integration-credential-key"
    descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "r+b") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_gid != connector_service_gid(root) or stat.S_IMODE(info.st_mode) != 0o640 or info.st_size != 32 or info.st_nlink != 1):
            raise ValueError(CONNECTOR_KEY_ERROR)
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    if read_connector_key(root) != value:
        raise ValueError(CONNECTOR_KEY_ERROR)


def integration_policy(value: dict) -> dict:
    """Canonical persisted policy: filenames and explicit network values only."""
    try:
        if (not isinstance(value, dict) or set(value) != {"schema", "allowed_cidrs", "allowed_ports", "secret_names"}
                or type(value["schema"]) is not int or value["schema"] != 1):
            raise ValueError
        cidrs, ports, names = value["allowed_cidrs"], value["allowed_ports"], value["secret_names"]
        if (not isinstance(cidrs, list) or len(cidrs) > 64 or not isinstance(ports, list) or len(ports) > 64
                or not isinstance(names, list) or len(names) > 32):
            raise ValueError
        forbidden = [ipaddress.ip_network(item) for item in (
            "0.0.0.0/32", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "255.255.255.255/32",
            "100.100.100.200/32", "168.63.129.16/32", "::/128", "::1/128", "fe80::/10", "ff00::/8",
            "fd00:ec2::254/128", "::ffff:0:0/96")]
        for item in cidrs:
            if not isinstance(item, str) or len(item) > 64:
                raise ValueError
            network = ipaddress.ip_network(item, strict=True)
            if (str(network) != item or network.prefixlen == 0
                    or any(network.version == block.version and network.overlaps(block) for block in forbidden)):
                raise ValueError
        if any(type(port) is not int or not 1 <= port <= 65535 for port in ports):
            raise ValueError
        if any(not isinstance(name, str) or not INTEGRATION_NAME.fullmatch(name) for name in names):
            raise ValueError
        if len(set(cidrs)) != len(cidrs) or len(set(ports)) != len(ports) or len(set(names)) != len(names):
            raise ValueError
        return {"schema": 1, "allowed_cidrs": sorted(cidrs), "allowed_ports": sorted(ports), "secret_names": sorted(names)}
    except (ValueError, TypeError, KeyError):
        raise ValueError(INTEGRATION_INPUT_ERROR) from None


def _integration_secret(data: bytes) -> None:
    # FileAuditor's existing gateway contract is an opaque 32-byte signing key;
    # its bytes must survive unchanged, including NUL, non-UTF8 and newlines.
    if len(data) == 32:
        return
    try:
        value = data.decode("utf-8").strip()
        if not value or "\r" in value or "\n" in value or "\x00" in value:
            raise ValueError
    except (UnicodeError, ValueError):
        raise ValueError(INTEGRATION_INPUT_ERROR) from None


def load_integration_config(path: Path) -> tuple[dict, dict[str, bytes]]:
    """Read an administrator's private input. Returned bytes/paths are never state."""
    try:
        raw = _integration_read(path, owner={0, os.geteuid()}, modes={0o600}, limit=INTEGRATION_PROFILE_LIMIT)
        value = json.loads(raw, object_pairs_hook=_integration_json_object)
        if (not isinstance(value, dict) or set(value) != {"schema", "allowed_cidrs", "allowed_ports", "secrets"}
                or not isinstance(value["secrets"], dict)):
            raise ValueError
        policy = integration_policy({"schema": value["schema"], "allowed_cidrs": value["allowed_cidrs"],
            "allowed_ports": value["allowed_ports"], "secret_names": list(value["secrets"])})
        supplied = {}
        for name in policy["secret_names"]:
            filename = value["secrets"][name]
            if not isinstance(filename, str) or not filename or len(filename) > 4096:
                raise ValueError
            data = _integration_read(Path(filename), owner={0, os.geteuid()}, modes={0o400, 0o600}, limit=INTEGRATION_SECRET_LIMIT)
            _integration_secret(data)
            supplied[name] = data
        return policy, supplied
    except (ValueError, TypeError, KeyError, UnicodeError, OSError):
        raise ValueError(INTEGRATION_INPUT_ERROR) from None


def integration_environment(policy: dict) -> dict:
    policy = integration_policy(policy)
    return {"PORTAL_ALLOWED_CIDRS": ",".join(["127.0.0.1/32", *policy["allowed_cidrs"]]),
            "PORTAL_ALLOWED_PORTS": ",".join(str(port) for port in sorted({80, 443, *policy["allowed_ports"]})),
            "PORTAL_SECRET_REFS": ",".join("file:" + name for name in policy["secret_names"]),
            "PORTAL_SECRETS_DIR": "/run/secrets/portal",
            "PORTAL_CHECK_INHERIT_INTEGRATION_POLICY": "false",
            "PORTAL_CHECK_ALLOWED_CIDRS": "127.0.0.1/32", "PORTAL_CHECK_ALLOWED_PORTS": "80,443"}


def validate_integration_secrets(root: Path, policy: dict | None) -> dict[str, bytes]:
    if policy is None:
        return {}
    try:
        policy = integration_policy(policy)
        private, base = root / "private", root / "private/integration-secrets"
        info = private.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError
        if not policy["secret_names"]:
            if base.exists() or base.is_symlink():
                raise ValueError
            return {}
        info = base.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != INTEGRATION_UID
                or info.st_gid != INTEGRATION_GID or stat.S_IMODE(info.st_mode) != 0o500
                or set(p.name for p in base.iterdir()) != set(policy["secret_names"])):
            raise ValueError
        supplied = {}
        for name in policy["secret_names"]:
            path = base / name
            data = _integration_read(path, owner={INTEGRATION_UID}, modes={0o400}, limit=INTEGRATION_SECRET_LIMIT)
            if path.lstat().st_gid != INTEGRATION_GID:
                raise ValueError
            _integration_secret(data)
            supplied[name] = data
        return supplied
    except (OSError, ValueError):
        raise ValueError(INTEGRATION_STATE_ERROR) from None


def prepare_integration_secrets(root: Path, policy: dict | None, supplied: dict[str, bytes], *, existing: bool) -> None:
    if policy is None:
        return
    policy = integration_policy(policy)
    if set(supplied) != set(policy["secret_names"]):
        raise ValueError(INTEGRATION_INPUT_ERROR)
    if existing:
        if validate_integration_secrets(root, policy) != supplied:
            raise ValueError(INTEGRATION_STATE_ERROR)
        return
    private, base = root / "private", root / "private/integration-secrets"
    info = private.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700
            or base.exists() or base.is_symlink()):
        raise ValueError(INTEGRATION_STATE_ERROR)
    if not supplied:
        return
    temporary = private / (".integration-secrets.new." + secrets.token_hex(8))
    temporary.mkdir(mode=0o700)
    try:
        for name, data in supplied.items():
            if not isinstance(data, bytes) or not 0 < len(data) <= INTEGRATION_SECRET_LIMIT:
                raise ValueError(INTEGRATION_INPUT_ERROR)
            _integration_secret(data)
            target = temporary / name
            write_file(target, data, 0o400)
            os.chown(target, INTEGRATION_UID, INTEGRATION_GID)
        os.chown(temporary, INTEGRATION_UID, INTEGRATION_GID)
        temporary.chmod(0o500)
        os.rename(temporary, base)
    finally:
        if temporary.exists():
            temporary.chmod(0o700)
            for child in temporary.iterdir():
                child.unlink()
            temporary.rmdir()
    validate_integration_secrets(root, policy)


def icmp_cidrs(values: list[str] | None) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list) or len(values) > 64:
        raise ValueError("ICMP requires at most 64 explicit canonical IPv4 CIDRs")
    selected = set()
    for value in values:
        try:
            network = ipaddress.IPv4Network(value, strict=True)
        except (ValueError, TypeError):
            raise ValueError("ICMP requires explicit canonical IPv4 CIDRs") from None
        if not isinstance(value, str) or str(network) != value:
            raise ValueError("ICMP requires explicit canonical IPv4 CIDRs")
        selected.add(value)
    return sorted(selected)


def icmp_policy(cfg: dict) -> dict:
    """An explicit legacy list, including [], retains its strict meaning."""
    mode = cfg.get('icmp_policy_mode', 'cidr' if 'icmp_allowed_cidrs' in cfg else 'interactive')
    values = icmp_cidrs(cfg.get('icmp_allowed_cidrs', []))
    if mode not in ('interactive', 'cidr') or mode == 'interactive' and values:
        raise ValueError('Invalid ICMP diagnostic policy')
    return {'mode': mode, 'cidrs': values}


def apply_icmp_model(root: Path, model: dict, generated: dict) -> None:
    """Copy only the new trusted ICMP recipe into an existing used core."""
    source, api = generated['services']['api'], model['services']['api']
    for name in ('PORTAL_ICMP_EXECUTOR_URL', 'PORTAL_ICMP_POLICY', 'PORTAL_ICMP_ALLOWED_CIDRS'):
        if name in source['environment']:
            api['environment'][name] = source['environment'][name]
        else:
            api['environment'].pop(name, None)
    target = '/run/pl-icmp-probe'
    for mount in api.get('volumes', []):
        if isinstance(mount, str) and target in mount:
            raise ValueError('Unsupported existing ICMP mount')
    api['volumes'] = [mount for mount in api.get('volumes', [])
                      if not isinstance(mount, dict) or mount.get('target') != target]
    api['volumes'] += [mount for mount in source.get('volumes', [])
                       if isinstance(mount, dict) and mount.get('target') == target]
    gid = str(read_json(root / '.pl-installation.json')['gid'])
    if gid not in source.get('group_add', []):
        raise ValueError('Generated ICMP socket group is missing')
    groups = list(api.get('group_add', []))
    if gid not in groups:
        groups.append(gid)
    api['group_add'] = groups


def configuration(url: str, bind: str, username: str, cidr: str | None = None, module_cidr: str | None = None,
                  integration: dict | None = None, allowed_icmp_cidrs: list[str] | None = None) -> dict:
    if any(ord(x) < 33 or ord(x) > 126 for x in url):
        raise ValueError("Invalid public HTTPS URL")
    try:
        u = urlsplit(url)
        host, port = u.hostname, u.port if u.port is not None else 443
        ipaddress.ip_address(bind)
    except ValueError:
        raise ValueError("Invalid public URL or bind address") from None
    if (u.scheme != "https" or not host or u.username is not None or u.password is not None
            or u.path not in ("", "/") or u.query or u.fragment or not 1 <= port <= 65535):
        raise ValueError("Use an HTTPS origin on a valid port")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", host):
            raise ValueError("Invalid public hostname") from None
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", username):
        raise ValueError("Invalid local admin username")
    cfg = {"public_url": url.rstrip("/"), "bind_address": bind, "port": port, "hostname": host,
           "admin_user": username, "modules": ["core"]}
    if cidr is not None:
        cfg["network_cidr"] = str(network_cidr(cidr))
    if module_cidr is not None:
        cfg["module_network_cidr"] = str(module_networks().extra_pool(module_cidr))
        module_networks().pools(cfg)
    if integration is not None:
        if cidr is None:
            raise ValueError("Integration configuration requires an explicit --network-cidr for isolated egress IPAM")
        cfg["integration_config"] = integration_policy(integration)
    if allowed_icmp_cidrs is not None:
        cfg["icmp_allowed_cidrs"] = icmp_cidrs(allowed_icmp_cidrs)
    return cfg


def choose_network_cidr(occupied: list) -> str:
    """Choose a private /24 disjoint from every observed host/Docker subnet."""
    nets = [ipaddress.ip_network(value, strict=False) for value in occupied]
    for block in ("10.240.0.0/12", "172.16.0.0/12", "192.168.0.0/16"):
        for candidate in ipaddress.IPv4Network(block).subnets(new_prefix=24):
            if not any(net.version == 4 and net.prefixlen and candidate.overlaps(net) for net in nets):
                return str(candidate)
    raise ValueError("No unused private IPv4 /24 available; specify a dedicated --network-cidr")


class Runtime:
    def __init__(self, root: Path, package: Path, m: dict):
        self.root, self.package, self.m = root, package, m
        self.private = root / "private"
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("COMPOSE_", "PORTAL_", "PL_", "DOCKER_"))}

    def run(self, args: list[str], *, data: bytes | None = None, timeout: int = 300) -> bytes:
        r = subprocess.run(args, input=data, capture_output=True, cwd=self.root,
                           env=self.env, timeout=timeout)
        if r.returncode:
            # Diagnostics remain root-private and never contain the stdin password.
            if (self.private.is_dir() and not self.private.is_symlink()
                    and self.private.stat().st_uid == os.geteuid() and not self.private.stat().st_mode & 0o077):
                write_file(self.private / "last-command.log", r.stdout + r.stderr)
            raise ValueError("Command failed; inspect private/last-command.log on this host")
        return r.stdout

    def docker(self, *args: str, **kwargs) -> bytes:
        return self.run(["docker", "--host", "unix:///var/run/docker.sock", *args], **kwargs)

    def compose(self, *args: str) -> bytes:
        return self.docker("compose", "--project-name", self.install_id,
                           "--env-file", str(self.private / "runtime.env"),
                           "-f", str(self.root / "config/compose.json"), *args)

    def images(self) -> None:
        self.docker("image", "load", "--input", str(self.package / "images.tar"), timeout=600)
        for name in (tuple(self.m["images"]) if self.m.get("schema") == 2 else ("api", "web")):
            expected = self.m["images"][name]["id"]
            data = json.loads(self.docker("image", "inspect", expected))[0]
            if data["Id"] != expected or data["Architecture"] != self.m["architecture"] or data["Os"] != "linux":
                raise ValueError("Loaded image identity/architecture mismatch")
            if self.m.get("schema") == 2 and any((data.get("Config", {}).get("Labels") or {}).get(k) != v for k, v in self.m["images"][name]["labels"].items()):
                raise ValueError("Loaded image provenance mismatch")
        if self.m.get("schema") == 2:
            return
        ref = self.m["images"]["db"]["ref"]
        self.docker("pull", ref, timeout=600)
        db = json.loads(self.docker("image", "inspect", ref))[0]
        if db["Architecture"] != self.m["architecture"] or db["Os"] != "linux":
            raise ValueError("PostgreSQL image architecture mismatch")

    def choose_network_cidr(self) -> str:
        identifiers = self.docker("network", "ls", "--quiet", "--no-trunc").decode().split()
        if len(identifiers) > 4096 or any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in identifiers):
            raise ValueError("Invalid Docker network identity inventory")
        occupied = []
        for identity in identifiers:
            values = json.loads(self.docker("network", "inspect", identity))
            if not isinstance(values, list) or len(values) != 1 or values[0].get("Id") != identity:
                raise ValueError("Docker network identity changed during allocation")
            occupied.extend(entry["Subnet"] for entry in (values[0].get("IPAM", {}).get("Config") or []) if entry.get("Subnet"))
        routes = json.loads(self.run(["ip", "-j", "-4", "route", "show", "table", "all"], timeout=30))
        if not isinstance(routes, list):
            raise ValueError("Invalid IPv4 route inventory")
        occupied.extend(route["dst"] for route in routes if route.get("dst") and route["dst"] != "default")
        return choose_network_cidr(occupied)

    def network_preflight(self, cfg: dict, installation: str | None = None) -> None:
        if "network_cidr" not in cfg and "module_network_cidr" not in cfg:
            return
        selected = network_cidr(cfg["network_cidr"]) if "network_cidr" in cfg else None
        expected = network_subnets(cfg["network_cidr"]) if selected else {}
        helper = module_networks()
        available = helper.pools(cfg)
        reserved = ([selected] if selected else []) + ([helper.extra_pool(cfg["module_network_cidr"])] if cfg.get("module_network_cidr") else [])
        if not self.m.get("features", {}).get("module_controller") and not self.m.get("features", {}).get("connector_credentials") and "integration_config" not in cfg:
            expected.pop("egress", None)
        if installation is not None and not re.fullmatch(r"pl-[0-9a-f]{12}", installation):
            raise ValueError("Invalid network installation identity")
        def read(args):
            # Diagnostics are deliberately not written during this read-only guard.
            result = subprocess.run(args, cwd=self.root, env=self.env, capture_output=True, timeout=30)
            if result.returncode:
                raise ValueError("Network overlap preflight command failed")
            return result.stdout
        docker = ["docker", "--host", "unix:///var/run/docker.sock"]
        ids = read(docker + ["network", "ls", "--quiet", "--no-trunc"]).decode().split()
        if any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in ids) or len(ids) > 4096:
            raise ValueError("Invalid Docker network identity inventory")
        owned = {}
        for identity in ids:
            values = json.loads(read(docker + ["network", "inspect", identity]))
            if not isinstance(values, list) or len(values) != 1 or values[0].get("Id") != identity:
                raise ValueError("Docker network identity changed during preflight")
            obj = values[0]
            entries = obj.get("IPAM", {}).get("Config") or []
            subnets = [ipaddress.ip_network(entry["Subnet"], strict=True) for entry in entries if entry.get("Subnet")]
            overlapping = any(net.version == 4 and any(block.overlaps(net) for block in reserved) for net in subnets)
            logical = next((name for name in expected if installation and obj.get("Name") == installation + "_" + name), None)
            if logical is None:
                if overlapping:
                    subnet = helper.owned_network(obj, installation, available,
                        lambda container: json.loads(read(docker + ["container", "inspect", container]))[0]) if installation else None
                    if subnet is None:
                        raise ValueError("Network CIDR overlaps an existing Docker network")
                    bridge = "br-" + identity[:12]
                    owned["module:" + identity] = (subnet, str(subnet.network_address + 1), bridge)
                continue
            labels = obj.get("Labels") or {}
            subnet = expected[logical]
            gateway = str(subnet.network_address + 1)
            configs = [entry for entry in entries if entry.get("Subnet")]
            if (obj.get("Driver") != "bridge" or obj.get("Scope") != "local" or obj.get("Ingress")
                    or obj.get("Internal", False) != (logical == "backend") or obj.get("IPAM", {}).get("Driver") != "default"
                    or labels.get("pl.installation") != installation
                    or labels.get("com.docker.compose.project") != installation
                    or labels.get("com.docker.compose.network") != logical
                    or subnets != [subnet] or len(configs) != 1 or configs[0].get("Gateway") != gateway
                    or configs[0].get("IPRange") or configs[0].get("AuxiliaryAddresses")
                    or logical in owned):
                raise ValueError("Existing installation network ownership or subnet differs")
            bridge = (obj.get("Options") or {}).get("com.docker.network.bridge.name") or "br-" + identity[:12]
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge):
                raise ValueError("Invalid owned Docker bridge interface")
            owned[logical] = (subnet, gateway, bridge)
        routes = json.loads(read(["ip", "-j", "-4", "route", "show", "table", "all"]))
        if not isinstance(routes, list):
            raise ValueError("Invalid IPv4 route inventory")
        for route in routes:
            destination = route.get("dst")
            if destination == "default":
                continue
            try:
                subnet = ipaddress.IPv4Network(destination, strict=False)
            except (ValueError, TypeError):
                raise ValueError("Invalid IPv4 route destination during overlap preflight") from None
            if subnet.prefixlen == 0 or not any(block.overlaps(subnet) for block in reserved):
                continue
            allowed = False
            for own_subnet, gateway, bridge in owned.values():
                if (route.get("dev") != bridge or route.get("protocol") != "kernel"
                        or route.get("gateway") or route.get("nexthops")
                        or route.get("prefsrc", gateway) != gateway):
                    continue
                kind, scope = route.get("type", "unicast"), route.get("scope")
                connected = subnet == own_subnet and kind == "unicast" and scope == "link"
                local = subnet.prefixlen == 32 and str(subnet.network_address) == gateway and kind == "local" and scope == "host"
                broadcast = (subnet.prefixlen == 32 and subnet.network_address in (own_subnet.network_address, own_subnet.broadcast_address)
                             and kind == "broadcast" and scope == "link")
                if connected or local or broadcast:
                    allowed = True
                    break
            if not allowed:
                raise ValueError("Network CIDR overlaps a physical, VPN or foreign host route")

    def credentials(self, cfg: dict, password_file: Path | None) -> None:
        initial, phc = self.private / "initial-admin-password", self.private / "local-admin.hash"
        if (self.root / "config/compose.json").exists() and not (self.private / "runtime.env").exists():
            raise ValueError("Existing installation credentials are missing; restore them before resuming")
        if not phc.exists():
            if initial.exists():
                password = initial.read_bytes()
            elif password_file:
                if password_file.is_symlink() or not password_file.is_file() or password_file.stat().st_mode & 0o077:
                    raise ValueError("Password input must be a private regular file")
                password = password_file.read_bytes().rstrip(b"\r\n")
            else:
                password = b"admin"  # Explicit initial credential required by the product owner.
            minimum = 12 if password_file else 1
            if not minimum <= len(password) <= 1024 or b"\n" in password or b"\r" in password or b"\0" in password:
                raise ValueError("Password file must have 12..1024 bytes on a single line")
            if not initial.exists():
                write_file(initial, password)
            hashed = self.docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
                                 "--security-opt", "no-new-privileges:true", "-i", self.m["images"]["api"]["id"],
                                 "hash-password", data=password)
            if not re.fullmatch(rb"\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+\n?", hashed):
                raise ValueError("Hash generator returned an invalid format")
            # Parent directory is 0700. Only the hash file is mounted into UID10001 API.
            write_file(phc, hashed, 0o444)
        env = self.private / "runtime.env"
        if not env.exists():
            write_file(env, "PL_DB_PASSWORD=" + secrets.token_hex(32) + "\n")

    def auth_volume(self) -> bool:
        """Seed once; the API subsequently owns the password, including across reinstall."""
        name = self.install_id + "-auth"
        found = self.docker("volume", "ls", "--filter", "name=^" + name + "$", "--format", "{{.Name}}").decode().strip()
        if not found:
            self.docker("volume", "create", "--label", "pl.installation=" + self.install_id, name)
        meta = json.loads(self.docker("volume", "inspect", name))[0]
        if meta.get("Labels", {}).get("pl.installation") != self.install_id or meta.get("Driver") != "local":
            raise ValueError("Authentication volume does not belong to this installation")
        script = ("set -eu; if [ ! -e /auth/local-admin.hash ]; then "
                  "cp /seed.hash /auth/.initial.hash; chmod 600 /auth/.initial.hash; "
                  "chown 10001:10001 /auth/.initial.hash; "
                  "touch /auth/password-change-required; chown 10001:10001 /auth/password-change-required; "
                  "mv /auth/.initial.hash /auth/local-admin.hash; fi; "
                  "chown 10001:10001 /auth; chmod 700 /auth; "
                  "if [ -e /auth/password-change-required ]; then echo required; else echo changed; fi")
        output = self.docker("run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
                    "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
                    "--security-opt", "no-new-privileges:true", "--entrypoint", "/bin/sh",
                    "--mount", "type=volume,source=" + name + ",target=/auth",
                    "--mount", "type=bind,source=" + str(self.private / "local-admin.hash") + ",target=/seed.hash,readonly",
                    self.m["images"]["web"]["id"], "-c", script)
        return output.strip() == b"required"

    def tls(self, cfg: dict, cert: Path | None, key: Path | None, self_signed: bool) -> None:
        dst_cert, dst_key = self.private / "tls.crt", self.private / "tls.key"
        if not dst_cert.exists() or not dst_key.exists():
            if cert and key:
                write_file(dst_key, key.read_bytes(), 0o444)
                write_file(dst_cert, cert.read_bytes(), 0o444)
            elif self_signed:
                host = cfg["hostname"]
                try:
                    ipaddress.ip_address(host)
                    san = "IP:" + host
                except ValueError:
                    san = "DNS:" + host
                self.run(["openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256",
                          "-days", "365", "-subj", "/CN=" + host, "-addext", "subjectAltName=" + san,
                          "-keyout", str(dst_key), "-out", str(dst_cert)])
                dst_key.chmod(0o444)
                dst_cert.chmod(0o444)
            else:
                raise ValueError("Provide TLS cert/key or explicitly select --self-signed")
        try:
            ipaddress.ip_address(cfg["hostname"])
            option = "-verify_ip"
        except ValueError:
            option = "-verify_hostname"
        self.run(["openssl", "x509", "-in", str(dst_cert), "-noout", "-checkend", "86400"])
        self.run(["openssl", "verify", "-partial_chain", "-trusted", str(dst_cert), option,
                  cfg["hostname"], str(dst_cert)])
        a = self.run(["openssl", "x509", "-in", str(dst_cert), "-pubkey", "-noout"])
        b = self.run(["openssl", "pkey", "-in", str(dst_key), "-pubout"])
        if a != b:
            raise ValueError("TLS certificate and key do not match")


def compose_model(root: Path, m: dict, cfg: dict, install_id: str) -> dict:
    def mount(name: str, target: str) -> dict:
        return {"type": "bind", "source": str(root / name).replace("$", "$$"), "target": target,
                "read_only": True, "bind": {"create_host_path": False}}
    locked = {"read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
              "tmpfs": ["/tmp"], "networks": ["backend"], "restart": "unless-stopped", "pids_limit": 256,
              "pull_policy": "never"}
    model = {"name": install_id, "services": {
        "db": {"image": (m["images"]["db"]["id"] if m.get("schema") == 2 else m["images"]["db"]["ref"]), "pull_policy": "never", "restart": "unless-stopped",
               "networks": ["backend"], "environment": {"POSTGRES_DB": "pl", "POSTGRES_USER": "pl",
               "POSTGRES_PASSWORD": "${PL_DB_PASSWORD:?}"}, "volumes": ["db:" + database_mount(m)],
               "healthcheck": {"test": ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U pl -d pl"],
                               "interval": "2s", "timeout": "3s", "retries": 30}},
        "api": {**locked, "image": m["images"]["api"]["id"], "depends_on": {"db": {"condition": "service_healthy"}},
                # The unprivileged API creates private attachment spools here.
                # Set ownership on every mount, including after container restart.
                "tmpfs": ["/tmp:uid=10001,gid=10001,mode=0700"],
                "environment": {"PORTAL_ADDR": ":8080", "PORTAL_DEMO": "false",
                "PORTAL_PORTABLE_RELEASE": "true", "PORTAL_PUBLIC_URL": cfg["public_url"], "PORTAL_LOCAL_ADMIN_USERNAME": cfg["admin_user"],
                "PORTAL_LOCAL_ADMIN_HASH_FILE": "/run/pl-auth/local-admin.hash", "PORTAL_LOCAL_ADMIN_PASSWORD_CHANGE": "true",
                **({"PORTAL_LOCAL_USERS": "true"} if m.get("features", {}).get("local_users") is True else {}),
                "PORTAL_CHECK_PUBLIC_WEB": "false",
                "PORTAL_DATABASE_URL": "postgres://pl:${PL_DB_PASSWORD:?}@db:5432/pl?sslmode=disable",
                "PORTAL_ALLOWED_CIDRS": "127.0.0.1/32", "PORTAL_ALLOWED_PORTS": "80,443"},
                "volumes": ["local-auth:/run/pl-auth"]},
        "web": {**locked, "image": m["images"]["web"]["id"], "depends_on": ["api"],
                "networks": ["backend", "ingress"],
                "ports": [{"target": 8443, "published": str(cfg["port"]), "host_ip": cfg["bind_address"], "protocol": "tcp"}],
                "volumes": [mount("config/nginx.conf", "/etc/nginx/nginx.conf"),
                            mount("private/tls.crt", "/run/pl/tls.crt"), mount("private/tls.key", "/run/pl/tls.key")],
                "healthcheck": {"test": ["CMD", "wget", "--no-check-certificate", "-qO-", "https://127.0.0.1:8443/health/ready"],
                                "interval": "3s", "timeout": "3s", "retries": 40}},
    }, "volumes": {"db": {"labels": {"pl.installation": install_id}},
                   "local-auth": {"external": True, "name": install_id + "-auth"}},
        "networks": {"backend": {"internal": True, "labels": {"pl.installation": install_id}},
                     "ingress": {"labels": {"pl.installation": install_id}}}}

    if m.get("features", {}).get("sftpgo_module") is True or m.get("features", {}).get("on_demand_modules") is True:
        model["volumes"]["module-transfers"] = {"labels": {"pl.installation": install_id, "pl.temporary": "true"}}
        model["services"]["api"]["volumes"].append("module-transfers:/var/lib/pl/transfers")

    if m.get("features", {}).get("module_controller") is True:
        gid = read_json(root / ".pl-installation.json")["gid"]
        if type(gid) is not int or not 1 <= gid <= 2**31 - 1:
            raise ValueError("Invalid module controller service group")
        api = model["services"]["api"]
        if m.get("features", {}).get("on_demand_modules"):
            api["environment"]["PORTAL_ON_DEMAND_MODULES"] = "true"
        api["environment"].update({"PORTAL_MODULE_SOCKET": "/run/pl-module-controller/control.sock",
                                   "PORTAL_MODULE_KEY_FILE": "/run/secrets/module-controller-key",
                                   "PORTAL_MODULE_VERSIONS": json.dumps({
                                       **{name: image["labels"]["org.opencontainers.image.version"]
                                          for name, image in m["images"].items()
                                          if name in ("prometheus", "xray", "alertmanager", "grafana") and "labels" in image},
                                       **({"wayline": m["images"]["wayline-api"]["labels"]["org.opencontainers.image.version"]}
                                          if m.get("features", {}).get("wayline_module") else {}),
                                       **{module: m["images"][module + "-" + role]["labels"]["org.opencontainers.image.version"]
                                          for module, role in (("forms", "adapter"), ("doska", "api"), ("sftpgo", "server"), ("netmap", "adapter"), ("bookstack", "web"))
                                          if m.get("features", {}).get(module + "_module")}})})
        api["volumes"] += [mount("run/module-controller", "/run/pl-module-controller"),
                              mount("private/module-controller-key", "/run/secrets/module-controller-key")]
        api["group_add"] = [str(gid)]
        api["networks"] = ["backend", "egress"]
        model["networks"]["egress"] = {"labels": {"pl.installation": install_id}}
    if m.get("features", {}).get("icmp_probe") is True:
        gid = read_json(root / ".pl-installation.json")["gid"]
        if type(gid) is not int or not 1 <= gid <= 2**31 - 1:
            raise ValueError("Invalid ICMP service group")
        api = model["services"]["api"]
        policy = icmp_policy(cfg)
        api["environment"].update({"PORTAL_ICMP_EXECUTOR_URL": "unix:///run/pl-icmp-probe/probe.sock",
                                   "PORTAL_ICMP_POLICY": policy['mode']})
        if policy['mode'] == 'cidr':
            api['environment']['PORTAL_ICMP_ALLOWED_CIDRS'] = ','.join(policy['cidrs'])
        api["volumes"].append(mount("run/icmp-probe", "/run/pl-icmp-probe"))
        api["group_add"] = sorted(set(api.get("group_add", []) + [str(gid)]))
    if "integration_config" in cfg:
        if "network_cidr" not in cfg:
            raise ValueError("Integration configuration requires explicit core network IPAM")
        policy = integration_policy(cfg["integration_config"])
        api = model["services"]["api"]
        api["environment"].update(integration_environment(policy))
        api["networks"] = ["backend", "egress"]
        model["networks"].setdefault("egress", {"labels": {"pl.installation": install_id}})
        if policy["secret_names"]:
            api["volumes"].append(mount("private/integration-secrets", "/run/secrets/portal"))
    if m.get("features", {}).get("connector_credentials") is True:
        if "network_cidr" not in cfg:
            raise ValueError("Connector credentials require explicit --network-cidr for isolated egress IPAM")
        gid = connector_service_gid(root)
        api = model["services"]["api"]
        api["environment"]["PORTAL_CONNECTOR_KEY_FILE"] = CONNECTOR_KEY_TARGET
        api["volumes"].append(mount("private/integration-credential-key", CONNECTOR_KEY_TARGET))
        api["group_add"] = sorted(set(api.get("group_add", [])) | {str(gid)})
        api["networks"] = ["backend", "egress"]
        model["networks"].setdefault("egress", {"labels": {"pl.installation": install_id}})
    if m.get("schema") == 2:
        model["services"]["db"]["environment"]["PGDATA"] = m["database"]["pgdata"]
    if "network_cidr" in cfg:
        subnets = network_subnets(cfg["network_cidr"])
        for name, network in model["networks"].items():
            subnet = subnets[name]
            network["driver"] = "bridge"
            network["ipam"] = {"driver": "default", "config": [{"subnet": str(subnet), "gateway": str(subnet.network_address + 1)}]}
    if "allowed_cidrs" in cfg or "allowed_ports" in cfg:
        cidrs, ports = cfg.get("allowed_cidrs"), cfg.get("allowed_ports")
        if (not isinstance(cidrs, list) or len(cidrs) > 64 or not isinstance(ports, list) or not 1 <= len(ports) <= 64
                or any(type(port) is not int or not 1 <= port <= 65535 for port in ports)):
            raise ValueError("Invalid persisted destination policy")
        try:
            if any(str(ipaddress.ip_network(value, strict=True)) != value or ipaddress.ip_network(value).prefixlen == 0 for value in cidrs):
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError("Invalid persisted destination networks") from None
        policy = {"PORTAL_ALLOWED_CIDRS": ",".join(cidrs), "PORTAL_ALLOWED_PORTS": ",".join(map(str, ports)),
                  "PORTAL_CHECK_ALLOWED_CIDRS": ",".join(cidrs), "PORTAL_CHECK_ALLOWED_PORTS": ",".join(map(str, ports)),
                  "PORTAL_CHECK_INHERIT_INTEGRATION_POLICY": "false"}
        model["services"]["api"]["environment"].update(policy)
    if "outbound_ca_pem" in cfg:
        if not isinstance(cfg["outbound_ca_pem"], str) or len(cfg["outbound_ca_pem"].encode()) > 64 * 1024:
            raise ValueError("Invalid persisted outbound trust certificates")
        if cfg["outbound_ca_pem"]:
            model["services"]["api"]["environment"]["PORTAL_OUTBOUND_CA_FILE"] = "/run/secrets/outbound-ca.pem"
            model["services"]["api"]["volumes"].append(mount("private/outbound-ca.pem", "/run/secrets/outbound-ca.pem"))
        else:
            model["services"]["api"]["environment"].pop("PORTAL_OUTBOUND_CA_FILE", None)
    return model


def module_image_descriptor(m: dict, installation: str, manifest_sha256: str) -> dict:
    descriptor = {"schema": 1, "installation": installation, "manifest_sha256": manifest_sha256}
    if "prometheus" in m["images"]:
        descriptor["prometheus"] = m["images"]["prometheus"]
    for module in ("xray", "alertmanager", "grafana"):
        if m.get("features", {}).get(module + "_module"):
            descriptor[module] = m["images"][module]
    for module, roles in (("wayline", ("api", "gateway", "runner")),
                          ("forms", ("adapter", "engine", "mongo", "keydb")),
                          ("doska", ("api", "web")), ("sftpgo", ("server",)),
                          ("netmap", ("database", "cache", "netbox", "netbox-worker", "oxidized", "gitea", "adapter")),
                          ("bookstack", ("web", "database"))):
        if m.get("features", {}).get(module + "_module"):
            descriptor[module] = {role: m["images"][module + "-" + role] for role in roles}
    if "doska" in descriptor:
        descriptor["doska"]["database"] = m["images"]["db"]
    return descriptor


def prepare_delivery_configuration(root: Path) -> None:
    path = root / "config/delivery.json"
    value = {"schema": 1, "catalog_url": "https://github.com/Sauke5/pl/releases/download/channel-stable/catalog.json"}
    if path.exists() or path.is_symlink():
        if read_json(path) != value:
            raise ValueError("Delivery configuration differs from the trusted release channel")
        return
    write_json(path, value)


def prepare_module_image_descriptor(rt: Runtime) -> None:
    if rt.m.get("schema") == 2:
        descriptor = module_image_descriptor(rt.m, rt.install_id, digest(rt.package / "manifest.json"))
        path = rt.private / "module-images.json"
        if path.exists():
            existing = read_json(path)
            if rt.m.get("features", {}).get("on_demand_modules"):
                modules = {"prometheus", "xray", "alertmanager", "wayline", "grafana", "forms", "doska", "sftpgo", "netmap", "bookstack"}
                if (any(existing.get(key) != value for key, value in descriptor.items())
                        or set(existing) - set(descriptor) - modules):
                    raise ValueError("Module image descriptor differs; upgrade is a separate operation")
                # Independently delivered images remain bound to this installation.
                # Repeating the core bootstrap must never erase their descriptors.
            elif existing != descriptor:
                raise ValueError("Module image descriptor differs; upgrade is a separate operation")
        else:
            write_json(path, descriptor)


def prepare_module_controller(rt: Runtime) -> None:
    """Trusted package code, fixed unit and mount paths; no browser controlled unit arguments."""
    prepare_module_image_descriptor(rt)
    marker = read_json(rt.root / ".pl-installation.json")
    gid = marker["gid"]
    for rel, mode in (("run", 0o750), ("run/module-controller", 0o750), ("modules", 0o700)):
        directory(rt.root / rel, mode)
    os.chown(rt.root / "run/module-controller", 0, gid)
    key = rt.private / "module-controller-key"
    if not key.exists():
        write_file(key, secrets.token_bytes(32), 0o640)
    if key.is_symlink() or not key.is_file() or len(key.read_bytes()) != 32 or key.stat().st_uid != 0:
        raise ValueError("Unsafe module controller key")
    key.chmod(0o640)
    os.chown(key, 0, gid)
    # systemd specifiers/quotes are not permitted in installation paths.
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(rt.root)) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(rt.package)):
        raise ValueError("Module controller installation paths require simple absolute paths")
    # Xray enumerates bind addresses; module IPAM checks host routes via Netlink.
    # Packages without either capability retain the legacy socket policy.
    features = rt.m.get("features", {})
    supervisor_package = rt.package
    if features.get("on_demand_modules"):
        prepare_delivery_configuration(rt.root)
        supervisor = rt.root / "state/controller-supervisor.json"
        if supervisor.exists() or supervisor.is_symlink():
            record = read_json(supervisor)
            if set(record) != {"schema", "version"} or record.get("schema") != 1 or not VERSION.fullmatch(record.get("version", "")):
                raise ValueError("Invalid immutable controller supervisor identity")
            supervisor_package = rt.root / "releases" / record["version"]
            if supervisor_package != supervisor_package.resolve() or not (supervisor_package / "controller-supervisor.py").is_file():
                raise ValueError("Immutable controller supervisor package unavailable")
        else:
            write_json(supervisor, {"schema": 1, "version": rt.m["version"]})
        active = rt.root / "state/controller-active.json"
        if active.exists() or active.is_symlink():
            pointer = read_json(active)
            if set(pointer) != {"schema", "version"} or pointer.get("schema") != 1 or not VERSION.fullmatch(pointer.get("version", "")):
                raise ValueError("Invalid controller release pointer")
        else:
            write_json(active, {"schema": 1, "version": rt.m["version"]})
    needs_netlink = features.get("on_demand_modules") or any(features.get(module + "_module") for module in ("xray", "forms", "doska", "wayline", "grafana", "sftpgo", "netmap", "bookstack"))
    writable = str(rt.root) if features.get("on_demand_modules") else str(rt.root / "modules") + " " + str(rt.root / "run/module-controller")
    families = "AF_UNIX AF_INET AF_INET6" + (" AF_NETLINK" if needs_netlink else "")
    unit_name = rt.install_id + "-module-controller.service"
    unit = ("[Unit]\nDescription=PL finite module controller\nAfter=docker.service\nRequires=docker.service\n"
            "[Service]\nType=simple\nUser=root\nGroup=root\nUMask=0077\n"
            "ExecStart=/usr/bin/python3 " + str(supervisor_package / ("controller-supervisor.py" if features.get("on_demand_modules") else "module-controller.py")) + " --root " + str(rt.root) + "\n"
            "Restart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\n"
            "ProtectSystem=strict\nProtectHome=true\nProtectKernelTunables=true\nProtectKernelModules=true\n"
            "ProtectControlGroups=true\nRestrictAddressFamilies=" + families + "\n"
            "ReadWritePaths=" + writable + "\n"
            "[Install]\nWantedBy=multi-user.target\n")
    destination = Path("/etc/systemd/system") / unit_name
    if destination.exists() and destination.read_text() != unit:
        raise ValueError("Module controller unit differs from managed definition")
    write_file(destination, unit, 0o644)
    rt.run(["systemctl", "daemon-reload"])
    rt.run(["systemctl", "enable", "--now", unit_name])
    rt.run(["systemctl", "is-active", "--quiet", unit_name])
    # Wait for the socket before Docker resolves the directory bind mount.
    import time
    for _ in range(50):
        if (rt.root / "run/module-controller/control.sock").is_socket():
            return
        time.sleep(0.1)
    raise ValueError("Module controller socket did not become ready")


def check_auth(cfg: dict, root: Path, password: bytes | None, *, allow_configured_ad: bool = False) -> dict:
    jar = http.cookiejar.CookieJar()
    context = ssl.create_default_context(cafile=str(root / "private/tls.crt"))
    context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=context),
        urllib.request.HTTPCookieProcessor(jar))
    def call(path: str, body=None, csrf=None):
        headers = {"Origin": cfg["public_url"]}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if csrf:
            headers["X-CSRF-Token"] = csrf
        req = urllib.request.Request(cfg["public_url"] + path,
                                     data=json.dumps(body).encode() if body is not None else None, headers=headers)
        with opener.open(req, timeout=5) as r:
            raw = r.read(1024 * 1024)
            return json.loads(raw) if raw else {}
    call("/health/ready")
    initial = call("/api/v1/session")
    ad_enabled = initial.get("ad_login_enabled")
    allowed_ad = ad_enabled is False or (allow_configured_ad and ad_enabled is True)
    if (initial.get("demo") is not False or initial.get("authenticated") is not False
            or initial.get("local_login_enabled") is not True or not allowed_ad
            or initial.get("oidc_login_enabled") is not False):
        raise ValueError("Runtime authentication differs from the non-demo installation profile")
    checks = {"https_ready": True, "local_only_non_demo": not ad_enabled, "ad_login_enabled": ad_enabled}
    if password is None:
        return {**checks, "login": "not_repeated_password_changed_or_removed"}
    call("/auth/local", {"username": cfg["admin_user"], "password": password.decode()})
    logged = call("/api/v1/session")
    if not logged.get("authenticated") or logged.get("user", {}).get("id") != "local-admin" or not logged["user"].get("admin"):
        raise ValueError("Local administrator acceptance failed")
    call("/auth/logout", {}, logged["csrf_token"])
    if call("/api/v1/session").get("authenticated"):
        raise ValueError("Logout acceptance failed")
    return {**checks, "login": True, "session": True, "logout": True}


def icmp_installer(package: Path):
    path = package / "icmp-install.py"
    spec = importlib.util.spec_from_file_location("pl_icmp_install", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def remove_icmp_helper(root: Path) -> None:
    if sys.platform != "linux" or os.geteuid() != 0:
        raise ValueError("ICMP helper removal requires root on Linux")
    if not root.is_absolute() or root != root.resolve() or root == Path("/"):
        raise ValueError("Use a real absolute installation directory")
    managed_root(root)
    lockpath = root / "state/install.lock"
    if lockpath.is_symlink() or (root / "state").is_symlink():
        raise ValueError("Unsafe installation lock")
    with lockpath.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = read_json(root / "state/installation.json")
        if not VERSION.fullmatch(state.get("version", "")):
            raise ValueError("Invalid installed package version")
        package = root / "releases" / state["version"]
        if package != package.resolve() or digest(package / "manifest.json") != state.get("manifest_sha256"):
            raise ValueError("Installed package identity mismatch")
        m = manifest(package)
        if not m.get("features", {}).get("icmp_probe"):
            raise ValueError("This installation has no managed ICMP helper")
        rt = Runtime(root, package, m)
        icmp_installer(package).remove(root, state["install_id"], rt.run)
    print("Managed ICMP helper removed; core data retained.")


def install(args) -> None:
    if sys.platform != "linux" or os.geteuid() != 0:
        raise ValueError("Installation requires root on the supported Linux host")
    if os.environ.get("DOCKER_HOST", "unix://").startswith(("tcp:", "ssh:", "http:")):
        raise ValueError("Remote Docker endpoint refused")
    root, package = args.root.absolute(), args.package_dir.absolute()
    if root != root.resolve() or root == Path("/") or package != package.resolve():
        raise ValueError("Use real absolute installation and package directories")
    validate_root_socket_paths(root)
    integration_path = getattr(args, "integration_config", None)
    policy, supplied = load_integration_config(integration_path) if integration_path is not None else (None, {})
    supplied_icmp = getattr(args, "icmp_allowed_cidr", None)
    m = manifest(package)
    managed_root(root)
    selected_cidr = args.network_cidr
    if m.get("features", {}).get("on_demand_modules") and selected_cidr is None:
        prior_path = root / "state/installation.json"
        if prior_path.exists():
            selected_cidr = read_json(prior_path).get("config", {}).get("network_cidr")
            if selected_cidr is None:
                raise ValueError("Installed on-demand core is missing its network allocation")
        else:
            selected_cidr = Runtime(root, package, m).choose_network_cidr()
    cfg = configuration(args.public_url, args.bind_address, args.admin_user, selected_cidr,
                        args.module_network_cidr, policy, supplied_icmp)
    if not m.get("features", {}).get("icmp_probe") and supplied_icmp is not None:
        raise ValueError("Selected package does not include the ICMP helper")
    if m.get("features", {}).get("connector_credentials") and "network_cidr" not in cfg:
        raise ValueError("Connector credentials require explicit --network-cidr for isolated egress IPAM")
    managed_root(root)
    # Reject a foreign/older root before loading any Docker images. The locked
    # check below repeats this after validation to cover concurrent installers.
    existing_state = root / "state/installation.json"
    if existing_state.parent.is_symlink() or existing_state.is_symlink():
        raise ValueError("Unsafe installation state path")
    previous = None
    if existing_state.exists():
        previous = read_json(existing_state)
        if m.get("features", {}).get("on_demand_modules"):
            for name in ("allowed_cidrs", "allowed_ports", "custom_tls", "outbound_ca_pem", "icmp_policy_mode", "icmp_allowed_cidrs"):
                if name in previous.get("config", {}):
                    cfg[name] = previous["config"][name]
        if (previous.get("config") != cfg or previous.get("version") != m["version"]
                or previous.get("manifest_sha256") != digest(package / "manifest.json")):
            raise ValueError("Existing installation differs; upgrade/reconfiguration is a separate operation")
    elif m.get("features", {}).get("on_demand_modules"):
        cfg["custom_tls"] = getattr(args, "tls_cert", None) is not None
    # On repeat, reject missing/changed owned secret material before images,
    # network commands, credentials or Compose can mutate the installation.
    if previous is not None and policy is not None:
        prepare_integration_secrets(root, policy, supplied, existing=True)
    if previous is not None and m.get("features", {}).get("connector_credentials"):
        read_connector_key(root)
    # Load and inspect the entire finite runtime set before installation state/config writes.
    rt = Runtime(root, package, m)
    rt.network_preflight(cfg, previous.get("install_id") if previous is not None else None)
    rt.images()
    directory(root, 0o750)
    for name, mode in (("private", 0o700), ("state", 0o750), ("config", 0o750)):
        directory(root / name, mode)
    lockpath = root / "state/install.lock"
    if lockpath.is_symlink():
        raise ValueError("Unsafe installation lock")
    with lockpath.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        statepath = root / "state/installation.json"
        package_hash = digest(package / "manifest.json")
        was_existing = statepath.exists()
        if was_existing:
            state = read_json(statepath)
            if state.get("config") != cfg or state.get("version") != m["version"] or state.get("manifest_sha256") != package_hash:
                raise ValueError("Existing installation differs; upgrade/reconfiguration is a separate operation")
        else:
            # A new root must not silently attach to another product's state.
            if any((root / "private").iterdir()) or any((root / "config").iterdir()):
                raise ValueError("Existing configuration without PL installation identity")
            with socket.socket(socket.AF_INET6 if ":" in cfg["bind_address"] else socket.AF_INET) as sock:
                sock.bind((cfg["bind_address"], cfg["port"]))
            state = {"schema": 1, "product": "PL", "core_api": 1, "config_revision": 0, "install_id": "pl-" + secrets.token_hex(6),
                     "version": m["version"], "package_schema": m["schema"], "manifest_sha256": package_hash, "config": cfg, "phase": "prepared"}
            write_json(statepath, state)
        rt.install_id = state["install_id"]
        new_icmp = False
        try:
            prepare_integration_secrets(root, policy, supplied, existing=was_existing)
            if m.get("features", {}).get("connector_credentials"):
                prepare_connector_key(root, existing=was_existing)
            rt.credentials(cfg, args.password_file)
            initial_password_active = rt.auth_volume()
            rt.tls(cfg, args.tls_cert, args.tls_key, args.self_signed)
            write_file(root / "config/nginx.conf", (package / "nginx.conf").read_bytes(), 0o644)
            if m.get("features", {}).get("module_controller") is True:
                prepare_module_controller(rt)
            if m.get("features", {}).get("icmp_probe") is True:
                directory(root / "run", 0o750)
                existed = (root / "private/icmp-helper.json").exists()
                gid = read_json(root / ".pl-installation.json")["gid"]
                icmp_installer(package).prepare(root, package, rt.install_id, icmp_policy(cfg), gid, rt.run)
                new_icmp = not existed
            write_json(root / "config/compose.json", compose_model(root, m, cfg, rt.install_id))
            rt.compose("config", "--quiet")
            state["phase"] = "starting"
            write_json(statepath, state)
            print("Starting isolated PL core (database, API, HTTPS web)...", flush=True)
            rt.compose("up", "--detach", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "150")
            pw = root / "private/initial-admin-password"
            state["checks"] = check_auth(cfg, root, pw.read_bytes() if initial_password_active and pw.exists() else None,
                                         allow_configured_ad=previous is not None)
            state["phase"] = "ready"
            write_json(statepath, state)
        except BaseException:
            if new_icmp:
                try:
                    icmp_installer(package).remove(root, rt.install_id, rt.run)
                except (ValueError, OSError, subprocess.SubprocessError):
                    state["icmp_rollback"] = "incomplete; inspect owned helper before retry"
            state["phase"] = "failed"
            write_json(statepath, state)
            raise
    print("PL core ready: " + cfg["public_url"])
    print("Local administrator: " + cfg["admin_user"])
    print("Initial credentials are documented in README.md; change the password in PL settings.")
    print("Self-signed TLS requires explicit client trust if selected. Manage optional modules in the PL UI.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "status", "remove-icmp-helper"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--package-dir", type=Path)
    parser.add_argument("--public-url")
    parser.add_argument("--bind-address", default="127.0.0.1")
    parser.add_argument("--module-network-cidr", help="Additional unused RFC1918 /16 through /26; default module pool holds 8 networks; initial installation only")
    parser.add_argument("--network-cidr", help="Explicit unused canonical RFC1918 IPv4 /24 for core bridge networks")
    parser.add_argument("--integration-config", type=Path, help="Private 0600 JSON of explicit integration CIDRs, ports and supplied secret files; first installation only; secrets are excluded from backup")
    parser.add_argument("--icmp-allowed-cidr", action="append", help="Explicit IPv4 CIDR for manual ICMP; repeat for several networks, none permits no destinations")
    parser.add_argument("--admin-user", default="admin")
    parser.add_argument("--password-file", type=Path)
    parser.add_argument("--tls-cert", type=Path)
    parser.add_argument("--tls-key", type=Path)
    parser.add_argument("--self-signed", action="store_true")
    args = parser.parse_args()
    try:
        if args.action == "remove-icmp-helper":
            remove_icmp_helper(args.root.absolute())
        elif args.action == "status":
            state = read_json(args.root / "state/installation.json")
            validate_integration_secrets(args.root.absolute(), state.get("config", {}).get("integration_config"))
            print(json.dumps({k: state.get(k) for k in ("product", "install_id", "version", "phase", "checks")}, indent=2))
        else:
            if not args.public_url or not args.package_dir or bool(args.tls_cert) != bool(args.tls_key):
                raise ValueError("Install needs package-dir, public-url and paired TLS cert/key or self-signed")
            if args.self_signed and args.tls_cert:
                raise ValueError("Select either provided TLS or self-signed")
            install(args)
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as e:
        # Do not propagate external HTTP bodies, subprocess arguments or credentials.
        print("PL bootstrap failed: " + (str(e) if isinstance(e, ValueError) else type(e).__name__), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
