#!/usr/bin/env python3
"""Build allowlisted PL core and independently delivered module artifacts."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RECIPES = {"db": "deploy/images/postgres.Dockerfile", "prometheus": "deploy/images/prometheus.Dockerfile", "xray": "deploy/images/xray.Dockerfile", "alertmanager": "deploy/images/alertmanager.Dockerfile", "grafana": "deploy/images/grafana.Dockerfile"}
IMAGE_SOURCES = {"db": {"pl.component": "postgresql", "pl.postgresql.version": "18.6", "pl.gosu.version": "1.19", "pl.gosu.go.version": "1.27.2"},
                 "prometheus": {"pl.module.id": "prometheus", "pl.module.config.version": "1", "org.opencontainers.image.version": "3.15.0", "pl.build.go": "1.27.2", "pl.build.x-net": "v0.61.0"}}
PREFIX = "monitoring/source/it-portal/"
EXACT = {"Dockerfile", ".dockerignore", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES", "deploy/licenses/react-remove-scroll-bar.LICENSE", "deploy/licenses/react-remove-scroll-bar.sources.json", "deploy/licenses/iperf3.LICENSE", "deploy/licenses/musl.COPYRIGHT", "deploy/licenses/openssl.LICENSE", "deploy/licenses/openssl.AUTHORS", "deploy/licenses/runtime.sources.json", "go.mod", "go.sum", "deploy/nginx.conf", *[recipe for name, recipe in RECIPES.items() if name != "grafana"], "deploy/images/postgres.sources.json", "deploy/images/prometheus.sources.json", "deploy/images/prometheus-embed-assets.sh", "deploy/images/xray.sources.json", "deploy/images/alertmanager.sources.json",
         "docs/platform-sso-contract.md", "docs/examples/admin-v1-vectors.json", "docs/examples/auditor-v2-vectors.json", "docs/examples/directory-v2-vectors.json", "docs/examples/doska-gateway-v2-vectors.json"}
FRONTEND_FILES = {"components.json", "index.html", "package-lock.json", "package.json", "tsconfig.json", "vite.config.ts"}
UI_PACKAGE_FILES = {"package.json", "core.js", "styles.css", "react.tsx", "dialog.tsx", "primitives.tsx", "build.mjs", "core.test.cjs", "build.test.cjs", "README.md"}
UI_PACKAGE_PREFIX = "frontend/packages/pl-ui/"
UI_VENDOR_NAME = re.compile(r"pl-ui-[0-9][A-Za-z0-9._-]*\.tgz\Z")
CONNECTOR_SOURCES = {"internal/connectorcredentials/codec.go", "internal/store/integration_credentials.go",
                     "internal/server/connector_credentials.go", "cmd/portal/connector_credentials.go",
                     "db/migrations/014_integration_credentials.sql"}
WAYLINE_IMAGES = ("wayline-api", "wayline-gateway", "wayline-runner")
WAYLINE_RECIPE = "deploy/images/wayline.Dockerfile"
WAYLINE_METADATA = "deploy/images/wayline.sources.json"
WAYLINE_EXACT = {WAYLINE_RECIPE, WAYLINE_METADATA}
WAYLINE_REQUIRED = {"apps/wayline/backend/go.mod", "apps/wayline/backend/go.sum", "apps/wayline/backend/cmd/wayline/main.go", "apps/wayline/backend/cmd/wayline-runner/main.go", "apps/wayline/web/package.json", "apps/wayline/web/package-lock.json", "apps/wayline/web/index.html", "apps/wayline/web/tsconfig.json", "apps/wayline/web/tsconfig.app.json", "apps/wayline/web/vite.config.ts", "apps/wayline/deploy/nginx/nginx.conf"}

def wayline_source_allowed(name: str) -> bool:
    if name in WAYLINE_REQUIRED:
        return True
    if name.startswith(("apps/wayline/backend/cmd/", "apps/wayline/backend/internal/")):
        return Path(name).suffix in {".go", ".sql"}
    if name.startswith(("apps/wayline/web/src/", "apps/wayline/web/public/")):
        return Path(name).suffix in {".ts", ".tsx", ".css", ".svg", ".js"}
    if name.startswith("apps/wayline/web/vendor/"):
        return bool(UI_VENDOR_NAME.fullmatch(Path(name).name)) and len(Path(name).parts) == 5
    return False

APPLICATION_ROLES = {"forms": ("adapter", "engine", "mongo", "keydb"), "doska": ("api", "web"), "sftpgo": ("server",), "inventory": ("server",),
                     "netmap": ("database", "cache", "netbox", "netbox-worker", "oxidized", "gitea", "adapter"),
                     "bookstack": ("web", "database")}
APPLICATION_UPSTREAM_ROLES = {"forms": {"engine", "mongo", "keydb"},
                              "netmap": {"database", "cache", "netbox", "netbox-worker", "oxidized", "gitea"},
                              "bookstack": {"web", "database"}}
APPLICATION_RECIPES = {name: "deploy/images/" + name + ".Dockerfile" for name in APPLICATION_ROLES}
APPLICATION_METADATA = {name: "deploy/images/" + name + ".sources.json" for name in APPLICATION_ROLES}
FORMS_REQUIRED = {"apps/forms/" + name for name in ("app.py", "gateway.py", "engine.py", "json_import.py", "analytics.py", "engine-launcher.cjs", "static/index.html", "static/app.js", "static/styles.css", "static/theme.js")}
DOSKA_REQUIRED = {"apps/doska/" + name for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vite.config.ts", "LICENSE", "apps/api/package.json", "apps/api/src/index.ts", "apps/web/package.json", "apps/web/index.html", "deploy/nginx.conf", "deploy/generate-manifest.mjs", "deploy/gateway-manifest.json")}
NETMAP_STACK_REQUIRED = {"apps/netmap-stack/" + name for name in (
    "cache-start.sh", "gateway.py", "gitea-start.sh", "known-hosts-source.rb", "netbox-bootstrap.py",
    "netbox-extra.py", "netbox-start.sh", "oxidized-start.rb", "service.py")}
APPLICATION_REQUIRED = {"forms": FORMS_REQUIRED, "doska": DOSKA_REQUIRED, "sftpgo": set(),
                        "inventory": {"apps/inventory/" + name for name in ("LICENSE", "requirements.txt", "inventory_service/app.py", "inventory_service/gateway.py", "inventory_service/importer.py", "inventory_service/store.py", "inventory_service/__init__.py", "web/index.html", "web/platform.css", "web/report.js", "web/bootstrap.js", "web/shared-shell.js", "web/theme-init.js")},
                        "bookstack": {"apps/wiki/bootstrap-admin.php"},
                        "netmap": NETMAP_STACK_REQUIRED | {"apps/netmap/app.py", "apps/netmap/web/index.html", "apps/netmap/web/app.js", "apps/netmap/web/office-view.js", "apps/netmap/web/style.css", "apps/netmap/web/theme-init.js"}}
APPLICATION_SOURCE_PREFIXES = {"bookstack": ("apps/wiki/",), "netmap": ("apps/netmap/", "apps/netmap-stack/")}


def application_source_allowed(module: str, name: str) -> bool:
    path = Path(name)
    if path.name == "SOURCE-SNAPSHOT.json":
        return False
    if not name.startswith(APPLICATION_SOURCE_PREFIXES.get(module, ("apps/" + module + "/",))) or set(path.parts) & FORBIDDEN_DIRS:
        return False
    if any(part.startswith(".") or part.lower() in {"runtime", "data", "history", "reports", "secrets", "uploads", "coverage", "build"} for part in path.parts):
        return False
    if module == "forms":
        return name in FORMS_REQUIRED
    if module == "inventory":
        return name in APPLICATION_REQUIRED[module] or name == "apps/inventory/web/software-page.js"
    if module == "bookstack":
        return name in APPLICATION_REQUIRED[module]
    if module == "netmap":
        if name.startswith("apps/netmap-stack/"):
            return name in NETMAP_STACK_REQUIRED
        if (path.name.startswith(("test-", "test_", "tests_"))
                or path.name.endswith((".test.mjs", ".test.cjs", "_test.py"))
                or "tests" in path.parts):
            return False
        return (path.suffix in {".py", ".js", ".cjs", ".mjs", ".css", ".html", ".svg", ".json", ".txt", ".woff2"}
                or path.name.startswith(("LICENSE", "NOTICE")))
    if module != "doska":
        return False
    rel = path.relative_to("apps/doska").as_posix()
    if rel.startswith("apps/web/vendor/"):
        return bool(UI_VENDOR_NAME.fullmatch(path.name)) and len(Path(rel).parts) == 4
    if name in DOSKA_REQUIRED:
        return True
    if rel.startswith(("apps/api/src/", "apps/web/src/", "packages/", "i18n/", "scripts/")):
        if rel.startswith("packages/") and len(Path(rel).parts) == 3:
            return path.name in {"package.json", "tsconfig.json", "vite.config.ts", "vitest.config.ts", "LICENSE", "base.json", "react-library.json", "server.json"}
        return path.suffix in {".ts", ".tsx", ".js", ".mjs", ".css", ".json", ".svg", ".html"}
    if rel.startswith("apps/api/drizzle/"):
        return path.suffix in {".sql", ".json"}
    if rel.startswith("apps/web/public/"):
        return path.suffix in {".svg", ".png", ".jpg", ".jpeg", ".ico", ".webp", ".woff", ".woff2", ".json", ".txt", ".js", ".webmanifest"}
    if len(Path(rel).parts) == 3 and rel.startswith(("apps/api/", "apps/web/")):
        return path.name in {"package.json", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "vite.config.ts", "vitest.config.ts", "vitest.integration.config.ts", "vitest.storage.config.ts", "drizzle.config.ts", "auth-schema.ts", "postcss.config.js", "components.json", "index.html"}
    return False


def application_metadata(context: Path, module: str) -> dict:
    metadata = json.loads((context / APPLICATION_METADATA[module]).read_text())
    version = metadata.get("version", "")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Invalid application version metadata")
    roles = APPLICATION_ROLES[module]
    if set(metadata.get("images", {})) != {module + "-" + role for role in roles}:
        raise ValueError("Incomplete application image role metadata")
    for role in roles:
        image = metadata["images"][module + "-" + role]
        labels = image.get("labels", {})
        upstream = role in APPLICATION_UPSTREAM_ROLES.get(module, set())
        fields = {"pl.module.id", "pl.module.role", "pl.module.config.version", "org.opencontainers.image.version", "pl.build.variant"} | ({"pl.upstream.version"} if upstream else set())
        if (set(labels) != fields or labels.get("pl.module.id") != module or labels.get("pl.module.role") != role
                or labels.get("pl.module.config.version") != "1" or labels.get("org.opencontainers.image.version") != version
                or labels.get("pl.build.variant") != ("upstream-pinned" if upstream or module == "sftpgo" else "source-build")
                or (upstream and not re.fullmatch(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?", labels.get("pl.upstream.version", "")))
                or image.get("target", role) != role):
            raise ValueError("Invalid application image role metadata")
    return metadata


FORBIDDEN_DIRS = {".git", "node_modules", "dist", "__pycache__", "private", "backups", "credentials", "logs", "state", "artifacts"}
ORGANIZATION_REFERENCE = re.compile(r"(?i)(?<!\w)psk(?:\b|[-_/.])|PSK(?:Theme|UI)\b|пск|(?:psk|pl)-group\.(?:ru|com)")


def audit_source_file(name: str, body: bytes) -> None:
    path = Path(name)
    if (path.is_absolute() or ".." in path.parts or set(path.parts[:-1]) & FORBIDDEN_DIRS
            or path.name.startswith((".env", "._")) or path.suffix.lower() in {".log", ".db", ".sqlite", ".sqlite3", ".bak", ".dump", ".key"}
            or (path.suffix.lower() == ".pem" and path.name != "release-signing-public.pem")):
        raise ValueError("Forbidden runtime/private artifact in source context: " + name)
    if re.search(rb"-----BEGIN (?:(?:OPENSSH |RSA |EC )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----", body):
        raise ValueError("Private key material in selected source: " + name)
    if path.suffix == ".tgz" and UI_VENDOR_NAME.fullmatch(path.name):
        with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as archive:
            members = archive.getmembers()
            if (sum(m.size for m in members) > 8 * 1024**2
                    or len({m.name for m in members}) != len(members)
                    or any(not m.isfile() or not m.name.startswith("package/") or ".." in Path(m.name).parts for m in members)):
                raise ValueError("Unsafe shared UI vendor archive")
            for member in members:
                audit_source_file(name + "!" + member.name, archive.extractfile(member).read())
        return
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return
    # Protocol names and encoded integrity/assertion bytes are not organization names.
    text = re.sub(r"\b(?:TLS|WPA[23]?|IKE|EAP)[_-]PSK\b", "", text, flags=re.I)
    text = re.sub(r"(?:sha(?:256|384|512)-|h1:)[A-Za-z0-9+/_=-]+", "", text)
    text = re.sub(r"(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{80,}={0,2}(?![A-Za-z0-9+/_-])", "", text)
    if ORGANIZATION_REFERENCE.search(text):
        raise ValueError("Organization-specific identifier in selected source: " + name)


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def run(args: list[str], cwd: Path = ROOT) -> str:
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if r.returncode:
        raise ValueError("Candidate command failed: " + Path(args[0]).name)
    return r.stdout


def add(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.mode, info.size, info.mtime = 0o644, len(data), 0
    tar.addfile(info, io.BytesIO(data))


GRAFANA_EXACT = {"deploy/images/grafana.Dockerfile", "deploy/images/grafana.sources.json"}
GRAFANA_BUILD_FILES = {"installer/grafana-build.py", "installer/grafana-plugins.json", "installer/grafana-trust.patch", "installer/grafana-signing/main.go", "installer/grafana-signing/main_test.go"}


def grafana_metadata(context: Path) -> dict:
    metadata = json.loads((context / "deploy/images/grafana.sources.json").read_text())
    if not isinstance(metadata, dict) or not isinstance(metadata.get("labels"), dict) or not isinstance(metadata.get("source"), dict):
        raise ValueError("Invalid Grafana source metadata")
    version = metadata.get("version", "")
    labels = metadata["labels"]
    variant = labels.get("pl.build.variant")
    fields = {"pl.module.id", "pl.module.config.version", "org.opencontainers.image.version",
              "org.opencontainers.image.revision", "org.opencontainers.image.source", "org.opencontainers.image.licenses", "pl.build.variant"}
    if variant == "source-build-pl-signed":
        fields.add("pl.build.go")
        if (not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", metadata.get("go_version", ""))
                or labels.get("pl.build.go") != metadata["go_version"]):
            raise ValueError("Invalid Grafana source-build toolchain identity")
        source = metadata["source"]
        if (not re.fullmatch(r"[0-9a-f]{64}", source.get("sha256", ""))
                or source.get("url") != "https://codeload.github.com/grafana/grafana/tar.gz/" + source.get("revision", "")):
            raise ValueError("Invalid Grafana source-build archive identity")
    if (metadata.get("schema") != 1 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version)
            or variant not in ("upstream-pinned", "source-build-pl-signed") or set(labels) != fields
            or labels.get("pl.module.id") != "grafana" or labels.get("pl.module.config.version") != "1"
            or labels.get("org.opencontainers.image.version") != version
            or labels.get("org.opencontainers.image.source") != "https://github.com/grafana/grafana"
            or labels.get("org.opencontainers.image.licenses") != "AGPL-3.0-only"
            or not re.fullmatch(r"[0-9a-f]{40}", labels.get("org.opencontainers.image.revision", ""))
            or metadata.get("source", {}).get("revision") != labels.get("org.opencontainers.image.revision")
            or not re.fullmatch(r"grafana/grafana:" + re.escape(version) + r"@sha256:[0-9a-f]{64}", metadata.get("upstream_image", ""))):
        raise ValueError("Invalid Grafana source metadata")
    return metadata


def grafana_build_arguments(metadata: dict, args, context: Path) -> list[str]:
    # Official binaries and native plugin signatures need no PL signing secret.
    if metadata["labels"]["pl.build.variant"] == "upstream-pinned":
        return []
    key = getattr(args, "grafana_signing_key_file", None)
    fingerprint = getattr(args, "grafana_signing_fingerprint", "")
    if key is None or not key.is_absolute() or key.is_symlink() or not key.is_file() or key.stat().st_mode & 0o077 or key.resolve().is_relative_to(ROOT) or key.resolve().is_relative_to(context):
        raise ValueError("Grafana requires a protected signing key outside the source workspace")
    if not re.fullmatch(r"[0-9a-f]{40}", fingerprint):
        raise ValueError("Grafana requires the approved public signing-key fingerprint")
    return ["--secret", "id=pl-grafana-signing-key,src=" + str(key), "--build-arg", "PL_SIGNING_FINGERPRINT=" + fingerprint]


def source_context(destination: Path, with_wayline: bool = False, with_grafana: bool = False, with_forms: bool = False, with_doska: bool = False, with_sftpgo: bool = False, with_netmap: bool = False, with_bookstack: bool = False, with_inventory: bool = False) -> None:
    if destination.exists():
        raise ValueError("Source snapshot already exists")
    applications = [name for name, enabled in (("forms", with_forms), ("doska", with_doska), ("sftpgo", with_sftpgo), ("netmap", with_netmap), ("bookstack", with_bookstack), ("inventory", with_inventory)) if enabled]
    application_exact = {value for name in applications for value in (APPLICATION_RECIPES[name], APPLICATION_METADATA[name])}
    names = run(["git", "ls-files", "-z", PREFIX]).split("\0")
    selected = {}
    for name in sorted(set(names)):
        if not name.startswith(PREFIX):
            continue
        rel = name[len(PREFIX):]
        allowed = (rel in EXACT or rel == "NOTICE" or rel.startswith(("cmd/", "internal/", "db/", "frontend/src/", "frontend/public/"))
                   or (rel.startswith(UI_PACKAGE_PREFIX) and rel[len(UI_PACKAGE_PREFIX):] in UI_PACKAGE_FILES)
                   or (with_wayline and rel in WAYLINE_EXACT)
                   or (with_grafana and rel in GRAFANA_EXACT)
                   or rel in application_exact
                   or (rel.startswith("frontend/") and rel[len("frontend/"):] in FRONTEND_FILES))
        if not allowed or any(p.startswith("._") or p in {".env", ".DS_Store"} for p in Path(rel).parts):
            continue
        p = ROOT / name
        if p.is_symlink() or not p.is_file():
            raise ValueError("Source context contains a non-regular file")
        selected[rel] = p.read_bytes()
        audit_source_file(rel, selected[rel])
    if not EXACT <= selected.keys() or "frontend/package-lock.json" not in selected:
        raise ValueError("Incomplete source context")
    frontend_package = json.loads(selected.get("frontend/package.json", b"{}"))
    if "@pl/ui" in frontend_package.get("dependencies", {}):
        required_ui = {UI_PACKAGE_PREFIX + name for name in UI_PACKAGE_FILES - {"README.md", "core.test.cjs", "build.test.cjs"}}
        if not required_ui <= selected.keys():
            raise ValueError("Incomplete shared UI source context")
        ui_metadata = json.loads(selected[UI_PACKAGE_PREFIX + "package.json"])
        if ui_metadata.get("name") != "@pl/ui" or frontend_package["dependencies"]["@pl/ui"] != "file:packages/pl-ui":
            raise ValueError("Shared UI must use its bundled local source package")
    if with_grafana and not GRAFANA_EXACT <= selected.keys():
        raise ValueError("Incomplete optional Grafana source context")
    if with_grafana and grafana_metadata(ROOT / PREFIX)["labels"]["pl.build.variant"] == "source-build-pl-signed":
        tracked = set(run(["git", "ls-files", "-z", "installer/"]).split("\0"))
        for name in sorted(GRAFANA_BUILD_FILES):
            path = ROOT / name
            if name not in tracked or path.is_symlink() or not path.is_file():
                raise ValueError("Incomplete Grafana source-build tooling")
            selected[name] = path.read_bytes()
            audit_source_file(name, selected[name])
    if with_wayline:
        for name in sorted(set(run(["git", "ls-files", "-z", "apps/wayline/"]).split("\0"))):
            if not wayline_source_allowed(name):
                continue
            path = ROOT / name
            if path.is_symlink() or not path.is_file():
                raise ValueError("Wayline context contains a non-regular file")
            body = path.read_bytes()
            audit_source_file(name, body)
            selected[name] = body
        if not (WAYLINE_EXACT | WAYLINE_REQUIRED) <= selected.keys():
            raise ValueError("Incomplete optional Wayline source context")
    for module in applications:
        for name in sorted(set(run(["git", "ls-files", "-z", *APPLICATION_SOURCE_PREFIXES.get(module, ("apps/" + module + "/",))]).split("\0"))):
            if not application_source_allowed(module, name):
                continue
            path = ROOT / name
            if path.is_symlink() or not path.is_file():
                raise ValueError("Application context contains a non-regular file")
            body = path.read_bytes()
            audit_source_file(name, body)
            selected[name] = body
        if not (APPLICATION_REQUIRED[module] | {APPLICATION_RECIPES[module], APPLICATION_METADATA[module]}) <= selected.keys():
            raise ValueError("Incomplete optional application source context: " + module)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w") as out:
        for name, body in selected.items():
            add(out, name, body)
    print("Selected source snapshot SHA256: " + sha(destination))


def engine() -> None:
    if os.environ.get("DOCKER_HOST") or os.environ.get("DOCKER_CONTEXT"):
        raise ValueError("Unset Docker endpoint overrides")
    endpoint = json.loads(run(["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}" ]))
    if not endpoint.startswith("unix://"):
        raise ValueError("Only a local Docker engine is allowed")


def write_package_archive(target, manifest, files, *, compression_level=9) -> None:
    if type(compression_level) is not int or not 1 <= compression_level <= 9:
        raise ValueError("Compression level must be an integer from 1 to 9")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(target, "x:gz", compresslevel=compression_level) as archive:
        add(archive, "manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())
        for name, path in files.items():
            archive.add(path, arcname=name, recursive=False)



def write_module_archive(target: Path, manifest: dict, files: dict, *, compression_level=9) -> None:
    if type(compression_level) is not int or not 1 <= compression_level <= 9:
        raise ValueError("Compression level must be an integer from 1 to 9")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(target, "x:gz", compresslevel=compression_level) as archive:
        add(archive, "module.json", (json.dumps(manifest, indent=2) + "\n").encode())
        for name, path in files.items():
            archive.add(path, arcname=name, recursive=False)


def build(args) -> None:
    engine()
    source = args.source_archive.resolve()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", args.version):
        raise ValueError("Invalid version")
    target = args.output.resolve()
    if target.exists():
        raise ValueError("Candidate output exists; use a new version")
    requested_platform = getattr(args, "platform", None)
    if requested_platform is not None and requested_platform not in ("linux/amd64", "linux/arm64"):
        raise ValueError("Only linux/amd64 and linux/arm64 artifacts are supported")
    source_hash = sha(source)
    with tempfile.TemporaryDirectory(prefix="pl-build-") as tmp:
        context = Path(tmp) / "source"
        context.mkdir()
        with tarfile.open(source) as archive:
            members = archive.getmembers()
            if len({m.name for m in members}) != len(members) or any(
                    not m.isfile() or m.name.startswith("/") or ".." in Path(m.name).parts for m in members):
                raise ValueError("Unsafe source archive")
            for member in members:
                out = context / member.name
                out.parent.mkdir(parents=True, exist_ok=True)
                body = archive.extractfile(member).read()
                audit_source_file(member.name, body)
                out.write_bytes(body)
        if any(not (context / name).is_file() for name in CONNECTOR_SOURCES):
            raise ValueError("Connector credential feature requires its complete source and schema")
        module_id = getattr(args, "module_id", None)
        bundled = bool(getattr(args, "bundled", False))
        with_icmp = bool(getattr(args, "with_icmp", False))
        if with_icmp and not (context / "internal/providers/icmp.go").is_file():
            raise ValueError("ICMP helper requires its provider source")
        optional = [name for name in ("wayline", "grafana", *APPLICATION_ROLES) if getattr(args, "with_" + name, False)]
        if optional and not bundled and module_id is None:
            raise ValueError("Optional images require an independent module artifact or explicit --bundled")
        xray_sources = json.loads((context / "deploy/images/xray.sources.json").read_text())
        xray_labels = xray_sources["labels"]
        if (xray_labels.get("pl.module.id") != "xray" or xray_labels.get("pl.module.config.version") != "1"
                or xray_labels.get("org.opencontainers.image.version") != xray_sources["version"]):
            raise ValueError("Invalid Xray source metadata")
        am_sources = json.loads((context / "deploy/images/alertmanager.sources.json").read_text())
        am_labels = am_sources["labels"]
        if (am_labels.get("pl.module.id") != "alertmanager" or am_labels.get("pl.module.config.version") != "1"
                or am_labels.get("org.opencontainers.image.version") != am_sources["version"]):
            raise ValueError("Invalid Alertmanager source metadata")
        image_sources = {**IMAGE_SOURCES, "xray": xray_labels, "alertmanager": am_labels}
        image_names = ("api", "web", "db", "prometheus", "xray", "alertmanager")
        with_grafana = getattr(args, "with_grafana", False)
        if with_grafana:
            grafana_sources = grafana_metadata(context)
            image_sources["grafana"] = grafana_sources["labels"]
            image_names += ("grafana",)
        with_wayline = getattr(args, "with_wayline", False)
        if with_wayline:
            wayline_sources = json.loads((context / WAYLINE_METADATA).read_text())
            for role in WAYLINE_IMAGES:
                labels = wayline_sources["images"][role]["labels"]
                if labels.get("pl.module.id") != "wayline" or labels.get("pl.module.role") != role.removeprefix("wayline-"):
                    raise ValueError("Invalid Wayline source metadata")
                image_sources[role] = labels
            image_names += WAYLINE_IMAGES
        application_targets = {}
        applications = [name for name in APPLICATION_ROLES if getattr(args, "with_" + name, False)]
        for module in applications:
            metadata = application_metadata(context, module)
            for role in APPLICATION_ROLES[module]:
                name = module + "-" + role
                image_sources[name] = metadata["images"][name]["labels"]
                application_targets[name] = (APPLICATION_RECIPES[module], metadata["images"][name].get("target", role), module.upper() + "_VERSION=" + metadata["version"])
                image_names += (name,)
        if module_id is not None:
            selected_images = (module_id,) if module_id in ("prometheus", "xray", "alertmanager", "grafana") else WAYLINE_IMAGES if module_id == "wayline" else tuple(module_id + "-" + role for role in APPLICATION_ROLES[module_id])
            image_names = selected_images
        elif not bundled:
            image_names = ("api", "web", "db")
        images = {}
        for name in image_names:
            tag = "pl/core-" + name + ":" + args.version
            print("Building " + tag, flush=True)
            recipe = application_targets[name][0] if name in application_targets else WAYLINE_RECIPE if name in WAYLINE_IMAGES else RECIPES.get(name, "Dockerfile")
            command = ["docker", "build", "--file", str(context / recipe)]
            if requested_platform is not None:
                command += ["--platform", requested_platform]
            if name == "grafana":
                command += grafana_build_arguments(grafana_sources, args, context)
            if name in application_targets:
                command += ["--target", application_targets[name][1], "--build-arg", application_targets[name][2]]
            if name in ("api", "web") or name in WAYLINE_IMAGES:
                command += ["--target", name.removeprefix("wayline-")]
            r = subprocess.run(command + ["--label", "pl.source.sha256=" + source_hash,
                                         "--tag", tag, str(context)], cwd=ROOT)
            if r.returncode:
                raise ValueError("Candidate build failed")
            obj = json.loads(run(["docker", "image", "inspect", tag]))[0]
            if requested_platform is not None and obj.get("Architecture") != requested_platform.split("/")[1]:
                raise ValueError("Built image does not match the requested platform")
            if obj["Os"] != "linux" or obj["Config"].get("Labels", {}).get("pl.source.sha256") != source_hash:
                raise ValueError("Built image provenance mismatch")
            labels = {"pl.source.sha256": source_hash, **image_sources.get(name, {})}
            if any((obj["Config"].get("Labels") or {}).get(k) != v for k, v in labels.items()):
                raise ValueError("Runtime image provenance mismatch")
            images[name] = {"id": obj["Id"], "architecture": obj["Architecture"], "ref": tag,
                            "recipe": recipe, "labels": labels}
        if len({image["architecture"] for image in images.values()}) != 1:
            raise ValueError("Core architecture mismatch")
        image_tar = Path(tmp) / "images.tar"
        run(["docker", "image", "save", "--output", str(image_tar), *[image["id"] for image in images.values()]])
        if module_id is not None:
            module_version = next(iter(images.values()))["labels"]["org.opencontainers.image.version"]
            files = {"images.tar": image_tar, "source.tar.gz": source}
            m = {"schema": 1, "product": "PL", "kind": "module", "module_id": module_id,
                 "version": module_version, "package_version": args.version, "core_api": 1,
                 "architecture": next(iter(images.values()))["architecture"], "source_sha256": source_hash,
                 "images": images, "files": {name: sha(path) for name, path in files.items()}}
            write_module_archive(target, m, files, compression_level=getattr(args, "compression_level", 9))
            target.with_suffix(target.suffix + ".sha256").write_text(sha(target) + "  " + target.name + "\n")
            print("Module packaged: " + str(target), flush=True)
            return
        payloads = ("bootstrap.py", "nginx.conf", "LICENSES.txt", "maintenance.py", "module-controller.py", "xray-controller.py", "alertmanager-controller.py", "module-network.py")
        if not bundled:
            payloads += ("install.sh", "delivery.py", "release-signing-public.pem", "wayline-controller.py", "grafana-controller.py", "forms-controller.py", "doska-controller.py", "sftpgo-controller.py", "netmap-controller.py", "bookstack-controller.py", "inventory-controller.py", "controller-supervisor.py", "installation-settings.py", "module-origin.py")
        files = {name: (ROOT / "installer" / name) for name in payloads}
        if with_icmp:
            files.update({name: ROOT / "installer" / name for name in ("icmp-probe.py", "icmp-install.py")})
        if with_grafana:
            files["grafana-controller.py"] = ROOT / "installer/grafana-controller.py"
        if with_wayline:
            files["wayline-controller.py"] = ROOT / "installer/wayline-controller.py"
        for module in applications:
            files[module + "-controller.py"] = ROOT / "installer" / (module + "-controller.py")
        files["README.md"] = ROOT / "installer/README.package.ru.md"
        for name, path in files.items():
            audit_source_file(name, path.read_bytes())
        files.update({"images.tar": image_tar, "source.tar.gz": source})
        for name in image_names:
            obj = json.loads(run(["docker", "image", "inspect", images[name]["ref"]]))[0]
            if obj["Id"] != images[name]["id"]:
                raise ValueError("Image reference moved during packaging")
        m = {"schema": 2, "product": "PL", "version": args.version, "core_api": 1,
             "features": {"local_users": True, "module_controller": True, "connector_credentials": True, **({"on_demand_modules": True} if not bundled else {"xray_module": True, "alertmanager_module": True}), **({"icmp_probe": True} if with_icmp else {}), **({"wayline_module": True} if with_wayline else {}), **({"grafana_module": True} if with_grafana else {}), **{module + "_module": True for module in applications}},
             "architecture": images["api"]["architecture"], "source_sha256": source_hash,
             "database": {"major": 18, "version": "18.6", "volume_target": "/var/lib/postgresql", "pgdata": "/var/lib/postgresql/18/docker"},
             "images": images, "files": {n: sha(p) for n, p in files.items()}}
        write_package_archive(target, m, files, compression_level=getattr(args, "compression_level", 9))
        checksum = sha(target)
        target.with_suffix(target.suffix + ".sha256").write_text(checksum + "  " + target.name + "\n")
        print("Candidate packaged: " + str(target))
        print("SHA256: " + checksum)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="action", required=True)
    context = sub.add_parser("context")
    context.add_argument("--output", type=Path, required=True)
    context.add_argument("--with-wayline", action="store_true")
    context.add_argument("--with-grafana", action="store_true")
    package = sub.add_parser("build")
    package.add_argument("--source-archive", type=Path, required=True)
    package.add_argument("--version", required=True)
    package.add_argument("--output", type=Path, required=True)
    package.add_argument("--compression-level", type=int, choices=range(1, 10), default=9,
                         help="Gzip compression level (1 fastest, 9 smallest; default: 9)")
    package.add_argument("--bundled", action="store_true", help="Legacy all-in-one artifact; independent installations use the default minimal core")
    package.add_argument("--with-icmp", action="store_true", help="Explicitly include the optional Linux ICMP host helper")
    package.add_argument("--platform", choices=("linux/amd64", "linux/arm64"), help="Build the selected Linux CPU architecture with the local engine")
    package.add_argument("--with-wayline", action="store_true")
    package.add_argument("--with-grafana", action="store_true")
    package.add_argument("--grafana-signing-key-file", type=Path)
    package.add_argument("--grafana-signing-fingerprint", default="")
    for parser in (context, package):
        parser.add_argument("--with-forms", action="store_true")
        parser.add_argument("--with-doska", action="store_true")
        parser.add_argument("--with-sftpgo", action="store_true")
        parser.add_argument("--with-netmap", action="store_true")
        parser.add_argument("--with-bookstack", action="store_true")
        parser.add_argument("--with-inventory", action="store_true")
    module = sub.add_parser("module", help="Build exactly one independently delivered module")
    module.add_argument("--module-id", required=True, choices=("prometheus", "xray", "alertmanager", "grafana", "wayline", *APPLICATION_ROLES))
    module.add_argument("--source-archive", type=Path, required=True)
    module.add_argument("--version", required=True, help="Immutable artifact/image release version")
    module.add_argument("--output", type=Path, required=True)
    module.add_argument("--compression-level", type=int, choices=range(1, 10), default=9)
    module.add_argument("--platform", choices=("linux/amd64", "linux/arm64"))
    module.add_argument("--grafana-signing-key-file", type=Path)
    module.add_argument("--grafana-signing-fingerprint", default="")
    args = p.parse_args()
    if args.action == "module":
        setattr(args, "with_" + args.module_id, True)
    try:
        source_context(args.output, args.with_wayline, args.with_grafana, args.with_forms, args.with_doska, args.with_sftpgo, args.with_netmap, args.with_bookstack, args.with_inventory) if args.action == "context" else build(args)
        return 0
    except (ValueError, OSError, KeyError, tarfile.TarError) as e:
        print("Packaging failed: " + str(e), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
