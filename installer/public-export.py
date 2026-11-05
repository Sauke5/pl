#!/usr/bin/env python3
"""Export reviewed PL source into a new directory, without repository history."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CORE = "monitoring/source/it-portal/"
FORBIDDEN_PARTS = {".git", ".private", "private", "node_modules", "__pycache__", "bin", "obj", "dist", "artifacts", "backups", "credentials", "secrets", "logs", "state", ".venv", "test-results", "playwright-report"}
TEXT_SUFFIXES = {".py", ".go", ".sql", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".css", ".svg", ".html", ".md", ".txt", ".toml", ".ini", ".sh", ".ps1", ".yaml", ".yml", ".cs", ".csproj", ".sln", ".props", ".targets", ".mako", ".lock"}
ASSET_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".webmanifest", ".tgz"}
INSTALLER_FILES = {
    "package.py", "public-export.py", "release-catalog.py", "get-pl.sh", "install.sh", "bootstrap.py", "delivery.py", "delivery-proxy.py", "delivery.ru.md", "maintenance.py",
    "module-controller.py", "controller-supervisor.py", "installation-settings.py", "module-origin.py", "module-network.py", "xray-controller.py", "alertmanager-controller.py",
    "wayline-controller.py", "grafana-controller.py", "forms-controller.py", "doska-controller.py",
    "sftpgo-controller.py", "netmap-controller.py", "bookstack-controller.py",
    "icmp-install.py", "icmp-probe.py", "nginx.conf", "release-signing-public.pem", "LICENSES.txt",
    "README.package.ru.md", "README.public.ru.md", "maintenance.ru.md", "license-notices.py",
    "grafana-build.py", "grafana-plugins.json", "grafana-trust.patch", "grafana-signing/main.go", "grafana-signing/main_test.go",
    "netmap-standalone.py", "netmap-standalone-package.py", "netmap-standalone/nginx.conf.example",
}
UNIT_TEST_NAMES = {
    "test_alertmanager_controller.py", "test_alertmanager_package.py", "test_application_package.py", "test_application_transport.py",
    "test_bookstack_controller.py", "test_bookstack_package.py", "test_bootstrap.py", "test_connector_credentials.py",
    "test_delivery.py", "test_delivery_concurrency.py", "test_delivery_proxy.py", "test_child_read_isolation.py", "test_doska_controller.py", "test_doska_stream_cancellation.py", "test_forms_controller.py", "test_grafana_build.py", "test_grafana_controller.py",
    "test_grafana_package.py", "test_host_status.py", "test_icmp_install.py", "test_icmp_probe.py", "test_icmp_upgrade.py", "test_install_proxy.py",
    "test_install_sh.py", "test_integration_config.py", "test_maintenance.py", "test_minimal_package.py", "test_module_controller.py",
    "test_module_network.py", "test_module_proxy.py", "test_native_initial_login.py", "test_netmap_collector_idle.py",
    "test_netmap_controller.py", "test_netmap_gitea_routing.py", "test_netmap_gitea_startup.py", "test_netmap_host_discovery.py",
    "test_netmap_instance_descriptor.py", "test_netmap_netbox_bootstrap.py", "test_netmap_netbox_startup.py", "test_netmap_package.py",
    "test_netmap_request_errors.py", "test_netmap_standalone.py", "test_network_stack_install.py", "test_package.py",
    "test_portable_ui_icmp.py", "test_sftpgo_controller.py", "test_sftpgo_package.py", "test_wayline_controller.py",
    "test_wayline_package.py", "test_xray_bundle.py", "test_xray_controller.py", "test_xray_dispatch.py",
    "test_public_export.py", "test_reports_portability.py", "test_get_pl.py", "test_installation_settings.py", "test_module_origin.py",
}
REPORT_FILES = {
    "monitoring_daily_summary.py", "monitoring_weekly_report.py", "monitoring_report_api.py", "manage_reports.py",
    "run_daily_reports.py", "retry_report_deliveries.py", "generate_reports_manifest.py",
}
AUDITOR_EXACT = {"README.md", "FileStructureAuditor.sln", "global.json", "LICENSE", "NOTICE", "Directory.Build.props", "Directory.Build.targets"}
STANDALONE_EXACT = {"README.md", "pyproject.toml", "Dockerfile", "docker-entrypoint.sh", "alembic.ini"}
STANDALONE_DOCS = {"docs/production-layout.md"}
CORE_EXTRAS = {"frontend/playwright.config.ts", "frontend/playwright.webkit.config.ts", "frontend/playwright.components.config.ts", "frontend/vitest.config.ts", "frontend/README.md"}
CORE_EXTRAS |= {"deploy/doska/prepare-gateway-manifest.py", "docs/ecosystem-ui-workflow.ru.md"}
PUBLIC_REPORT_ASSETS = {"monitoring/source/nginx/index.html", "monitoring/source/nginx/reports-theme-bridge.js", "monitoring/source/nginx/reports-theme-bridge.css"}
RELEASE_NUMBER = r"(?:0|[1-9][0-9]*)"
RELEASE_PRERELEASE = r"(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
RELEASE_NOTE_PATH = re.compile(
    r"docs/releases/" + r"\.".join([RELEASE_NUMBER] * 3)
    + r"(?:-" + RELEASE_PRERELEASE + r"(?:\." + RELEASE_PRERELEASE + r")*)?"
    + r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\.json\Z"
)

# These expressions deliberately spell out excluded source identifiers.
LEGACY_ORGANIZATION = re.compile(r"(?i)(?<!\w)psk(?:\b|[-_/.])|PSK(?:Theme|UI)\b|пск|(?:psk|pl)-group\.(?:ru|com)")
SITE_DOMAIN = re.compile(r"(?i)(?:psk|pl)-group\.(?:ru|com)")
LAB_ADDRESS = re.compile(r"(?<![\d.])192\.168\.2\.(?:22|25)(?![\d.])")
PERSONAL_HOME = re.compile(r"(?<![\w/])/(?:Users|home)/[A-Za-z0-9_.-]+")
PRIVATE_KEY = re.compile(rb"-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----")
ACCESS_TOKEN = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b|\b\d{7,}:[A-Za-z0-9_-]{25,}\b")
URL_CREDENTIAL = re.compile(r"\b[a-z][a-z0-9+.-]*://([^\s/\"'<>]+:[^\s/\"'<>]+)@([^\s/\"'<>]+)", re.I)
REVIEWED_TEST_TOKENS = {
    "apps/doska/apps/web/src/components/project/integrations/telegram/build-telegram-request.test.ts": {"2491404d485a28b690fe6ef4c089f130eac6fab9984fa43dace764b47ca83de7"},
    "monitoring/source/monitoring-admin-agent/tests/test_agent.py": {"a2290c006d1c2b776fae9158a41eea93334e56e1d484fab0f055def9bdc4c5e0"},
}


def test_source(name: str) -> bool:
    return "/tests/" in name or name.endswith(("_test.go", ".test.ts", ".test.tsx", ".test.mjs", ".test.cjs", ".spec.ts"))


def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def source_name(name: str) -> str:
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or ".." in path.parts or name != path.as_posix()
            or "\\" in name or set(path.parts) & FORBIDDEN_PARTS
            or path.parts[0] == "ci" or name.startswith("apps/inventory/") or path.name in {".env", ".DS_Store", "SOURCE-SNAPSHOT.json"}
            or path.name.startswith(("._", "acceptance."))
            or path.suffix.lower() in {".db", ".sqlite", ".sqlite3", ".dump", ".key", ".bak", ".log"}
            or path.suffix.lower() == ".pem" and name != "installer/release-signing-public.pem"):
        raise ValueError("Private/runtime or unsafe export path: " + name)
    return name


def context_destination(name: str) -> str:
    source_name(name)
    return source_name(name if name.startswith(("apps/", "installer/")) else CORE + name)


def load_package(root: Path):
    spec = importlib.util.spec_from_file_location("pl_public_package", root / "installer/package.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tracked_files(root: Path, *paths: str) -> list[str]:
    result = subprocess.run(["git", "ls-files", "-z", "--", *paths], cwd=root, capture_output=True, check=True)
    return sorted(set(result.stdout.decode().split("\0")) - {""})


def supplemental_allowed(name: str) -> bool:
    path = PurePosixPath(name)
    try:
        source_name(name)
    except ValueError:
        return False
    if name.startswith("docs/releases/"):
        return RELEASE_NOTE_PATH.fullmatch(name) is not None
    if name in PUBLIC_REPORT_ASSETS:
        return True
    if name.startswith(CORE):
        relative = name[len(CORE):]
        if relative == "frontend/tests/e2e/reports-theme.spec.ts":
            return False  # Historical acceptance depends on a non-public Git commit.
        return relative in CORE_EXTRAS or relative.startswith("frontend/tests/") and path.suffix in TEXT_SUFFIXES
    if name.startswith("apps/file-auditor/"):
        relative = name[len("apps/file-auditor/"):]
        return relative in AUDITOR_EXACT or relative.startswith(("src/", "tests/", "scripts/", "docs/")) and path.suffix in TEXT_SUFFIXES | ASSET_SUFFIXES
    for component in ("monitoring-admin", "websites-admin", "monitoring-admin-agent"):
        prefix = "monitoring/source/" + component + "/"
        if name.startswith(prefix):
            relative = name[len(prefix):]
            return relative in STANDALONE_EXACT or relative in STANDALONE_DOCS or relative.startswith(("app/", "agent/", "migrations/", "tests/")) and path.suffix in TEXT_SUFFIXES | ASSET_SUFFIXES or component == "monitoring-admin-agent" and relative == "main.py"
    if name.startswith("monitoring/source/scripts/monitoring_summary/"):
        return path.suffix in {".py", ".html"}
    return name.startswith("monitoring/source/scripts/") and name.removeprefix("monitoring/source/scripts/") in REPORT_FILES


def source_context_files(root: Path, package) -> dict[str, bytes]:
    # The builder owns the finite runtime source allowlist. Import its exact
    # archive rather than copying a checkout or maintaining a second runtime list.
    kwargs = {key: True for key in inspect.signature(package.source_context).parameters if key.startswith("with_")}
    selected: dict[str, bytes] = {}
    with tempfile.TemporaryDirectory(prefix="pl-public-context-") as temporary:
        archive = Path(temporary) / "source.tar.gz"
        with contextlib.redirect_stdout(io.StringIO()):
            package.source_context(archive, **kwargs)
        with tarfile.open(archive, "r:gz") as contents:
            entries = contents.getmembers()
            if len({entry.name for entry in entries}) != len(entries) or sum(entry.size for entry in entries) > 256 * 1024**2:
                raise ValueError("Unsafe source context inventory")
            for entry in entries:
                if not entry.isfile():
                    raise ValueError("Source context contains a non-regular file")
                if PurePosixPath(entry.name).name == "SOURCE-SNAPSHOT.json":
                    continue  # Internal baseline provenance is not customer source.
                name = context_destination(entry.name)
                selected[name] = contents.extractfile(entry).read()
    return selected


def put_file(selected: dict[str, bytes], name: str, body: bytes) -> None:
    source_name(name)
    if name in selected and selected[name] != body:
        raise ValueError("Conflicting source selection: " + name)
    selected[name] = body


def read_regular(root: Path, name: str) -> bytes:
    path = root / name
    parents = [root / parent for parent in PurePosixPath(name).parents if str(parent) != "."]
    if path.is_symlink() or any(parent.is_symlink() for parent in parents) or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Expected a regular source file: " + name)
    return path.read_bytes()


def select_files(root: Path, package=None) -> dict[str, bytes]:
    package = package or load_package(root)
    selected = source_context_files(root, package)
    for name in ("LICENSE", "NOTICE"):
        put_file(selected, name, read_regular(root, name))
    if (root / ".gitattributes").is_file():
        put_file(selected, ".gitattributes", read_regular(root, ".gitattributes"))
    for name in sorted(INSTALLER_FILES):
        path = root / "installer" / name
        if path.exists():
            put_file(selected, "installer/" + name, read_regular(root, "installer/" + name))
    for name in sorted(UNIT_TEST_NAMES):
        path = "installer/tests/" + name
        if (root / path).exists():
            put_file(selected, path, read_regular(root, path))
    for name in tracked_files(root, CORE, "apps/file-auditor", "monitoring/source/monitoring-admin", "monitoring/source/websites-admin", "monitoring/source/monitoring-admin-agent", "monitoring/source/scripts", "monitoring/source/nginx", "docs/releases"):
        if supplemental_allowed(name):
            put_file(selected, name, read_regular(root, name))
    selected["README.md"] = PUBLIC_README.encode()
    selected[".gitignore"] = PUBLIC_GITIGNORE.encode()
    for component, documentation in PUBLIC_STANDALONE_READMES.items():
        selected["monitoring/source/" + component + "/README.md"] = documentation.encode()
    selected["monitoring/source/websites-admin/docs/platform-integration.md"] = PUBLIC_STANDALONE_GATEWAY.encode()
    selected["apps/file-auditor/README.md"] = PUBLIC_AUDITOR_README.encode()
    if "installer/README.public.ru.md" in selected:
        selected["installer/README.ru.md"] = selected["installer/README.public.ru.md"]
    return selected


def organization_text(text: str) -> str:
    text = re.sub(r"\b(?:TLS|WPA[23]?|IKE|EAP)[_-]PSK\b", "", text, flags=re.I)
    text = re.sub(r"(?:sha(?:256|384|512)-|h1:)[A-Za-z0-9+/_=-]+", "", text)
    return re.sub(r"(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{80,}={0,2}(?![A-Za-z0-9+/_-])", "", text)


def allowed_match(name: str, line: str, rule: str, value: str) -> str | None:
    if rule in {"organization", "site-domain"} and name in {"installer/package.py", "installer/public-export.py"}:
        if any(marker in line for marker in ("ORGANIZATION_REFERENCE =", "LEGACY_ORGANIZATION =", "SITE_DOMAIN =", "(?:TLS|WPA")):
            return "exclusion rule or standard TLS-PSK protocol token in the source auditor"
    if rule == "organization" and name == "installer/tests/test_portable_ui_icmp.py":
        return "negative source-audit fixtures proving former identifiers are rejected"
    if rule == "access-token" and digest(value.encode()) in REVIEWED_TEST_TOKENS.get(name, set()):
        return "reviewed exact synthetic token fixture used by validation/redaction tests"
    if rule == "personal-home" and value == "/home/oxidized":
        return "upstream container account home required by Oxidized"
    if rule == "url-credential":
        if any(marker in value for marker in ("${", "{password}", "{key}", "{auth}")):
            return "runtime interpolation; no credential value is embedded"
        if test_source(name) and re.search(r"@(?:localhost|127\.0\.0\.1|db(?=[:/\s]|$)|[a-z0-9.-]+\.(?:test|invalid)(?=[:/\s]|$))", value, re.I):
            return "synthetic test-only connection identity"
        match = URL_CREDENTIAL.fullmatch(value)
        if test_source(name) and match:
            username, password = match.group(1).split(":", 1)
            fake_users = {"u", "user", "reader", "admin", "actual-user", "fixture-user"}
            fake_passwords = {"p", "pass", "password", "secret", "unrelated-value", "fixture-password", "fixture-secret"}
            if username in fake_users and password in fake_passwords:
                return "explicit low-entropy synthetic userinfo in a URL-validation test"
    return None


def audit_file(name: str, body: bytes, findings: list[dict], *, nested: bool = False) -> None:
    if not nested:
        source_name(name)
    for match in PRIVATE_KEY.finditer(body):
        number = body[:match.start()].count(b"\n") + 1
        line = body.splitlines()[number-1]
        negative_fixture = (
            name in {"installer/tests/test_package.py", "installer/tests/test_portable_ui_icmp.py", CORE + "frontend/tests/unit/sftpData.test.ts"}
            and any(marker in line for marker in (b"audit_source_file", b"self.vendor", b"never-echo-me", b"assert.throws"))
            and not re.search(rb"-----END (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----", body)
        )
        finding = {"path": name, "line": number, "rule": "private-key", "severity": "reviewed" if negative_fixture else "error"}
        if negative_fixture:
            finding["reason"] = "negative parser/audit fixture containing only a key marker, no encoded key material"
        findings.append(finding)
    if name.endswith(".tgz"):
        try:
            with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as archive:
                entries = archive.getmembers()
                if (len(entries) > 256 or sum(entry.size for entry in entries) > 8 * 1024**2
                        or len({entry.name for entry in entries}) != len(entries)):
                    raise ValueError("Unsafe nested source archive")
                for entry in entries:
                    source_name(entry.name)
                    if not entry.isfile() or not entry.name.startswith("package/"):
                        raise ValueError("Unsafe shared UI vendor archive")
                    audit_file(name + "!" + entry.name, archive.extractfile(entry).read(), findings, nested=True)
        except (tarfile.TarError, ValueError, OSError):
            findings.append({"path": name, "line": 0, "rule": "unsafe-vendor-archive", "severity": "error"})
        return
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        if PurePosixPath(name).suffix not in ASSET_SUFFIXES:
            findings.append({"path": name, "line": 0, "rule": "unexpected-binary", "severity": "error"})
        return
    for number, line in enumerate(text.splitlines(), 1):
        expressions = (("organization", LEGACY_ORGANIZATION, organization_text(line)), ("site-domain", SITE_DOMAIN, line),
                       ("laboratory-address", LAB_ADDRESS, line), ("personal-home", PERSONAL_HOME, line),
                       ("access-token", ACCESS_TOKEN, line), ("url-credential", URL_CREDENTIAL, line))
        for rule, expression, inspected in expressions:
            for match in expression.finditer(inspected):
                reason = allowed_match(name, line, rule, match.group())
                finding = {"path": name, "line": number, "rule": rule, "severity": "reviewed" if reason else "error"}
                if reason:
                    finding["reason"] = reason
                findings.append(finding)


def audit_files(selected: dict[str, bytes]) -> list[dict]:
    findings: list[dict] = []
    for name, body in sorted(selected.items()):
        audit_file(name, body, findings)
    return findings


def write_export(destination: Path, selected: dict[str, bytes]) -> dict:
    if destination.exists() or destination.is_symlink():
        raise ValueError("Export destination already exists; preserve it and choose a new directory")
    inventory = []
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".pl-public-", dir=destination.parent) as temporary:
        candidate = Path(temporary) / "source"
        candidate.mkdir()
        for name, body in sorted(selected.items()):
            source_name(name)
            output = candidate / name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(body)
            output.chmod(0o755 if name.endswith(".sh") else 0o644)
            inventory.append({"path": name, "sha256": digest(body), "size": len(body)})
        manifest = {"schema": 1, "product": "PL", "kind": "public-source", "files": inventory,
                    "generated_files": sorted(set(selected) & GENERATED_PUBLIC_PATHS)}
        (candidate / "PUBLIC-SOURCE-MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        os.rename(candidate, destination)
    return manifest


def write_report(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("w", encoding="utf-8") as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "release/generated/public-pl")
    parser.add_argument("--report", type=Path, default=ROOT / "release/private/public-export-audit.json")
    args = parser.parse_args(argv)
    try:
        destination, report_path = args.output.resolve(), args.report.resolve()
        if not destination.is_relative_to(ROOT / "release/generated") or destination == ROOT / "release/generated":
            raise ValueError("Public export must use a dedicated directory in release/generated")
        if not report_path.is_relative_to(ROOT / "release/private"):
            raise ValueError("Audit evidence must remain under release/private")
        if destination.exists():
            raise ValueError("Export destination exists; use a new immutable directory")
        selected = select_files(ROOT)
        findings = audit_files(selected)
        errors = [finding for finding in findings if finding["severity"] == "error"]
        report = {"schema": 1, "product": "PL", "file_count": len(selected), "total_bytes": sum(map(len, selected.values())),
                  "errors": len(errors), "findings": findings,
                  "files": [{"path": name, "sha256": digest(body)} for name, body in sorted(selected.items())]}
        write_report(report_path, report)
        if errors:
            for finding in errors[:30]:
                print(f"Review required: {finding['path']}:{finding['line']} [{finding['rule']}]", file=sys.stderr)
            raise ValueError("Public source audit failed; no export was written (details in private report)")
        write_export(destination, selected)
        print(f"PL public source exported: {len(selected)} files, {report['total_bytes']} bytes")
        print("Export: " + str(destination))
        print("Private audit: " + str(report_path))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError) as error:
        print("Public export failed: " + str(error), file=sys.stderr)
        return 2


PUBLIC_GITIGNORE = """.env
._*
.DS_Store
__MACOSX/
**/node_modules/
**/.venv/
**/__pycache__/
**/dist/
**/bin/
**/obj/
**/test-results/
**/playwright-report/
/release/generated/
/release/private/
*.sqlite
*.sqlite3
*.db
"""

PUBLIC_STANDALONE_READMES = {
    "monitoring-admin": """# PL Monitoring Admin

Отдельная операционная консоль с SQLite, сохранёнными jobs и ограниченным host-agent. Не устанавливается автоматически вместе с core PL. Web и worker не получают Docker socket; host-agent исполняет только фиксированные операции для своего явного реестра сервисов.

Standalone-вход использует подготовленный файл учётных данных с Argon2id hash. Для интеграции с PL задаются `MONITORING_ADMIN_AUTH_PROVIDER=gateway` и `MONITORING_ADMIN_GATEWAY_KEY_FILE` с индивидуальным raw32 ключом. В gateway mode каждый запрос проверяется по подписанному контракту PL; локальный fallback при ошибке подписи отсутствует. Shared UI загружается с `/ecosystem/` на origin PL, standalone использует собственные assets.

[Runtime layout и права](docs/production-layout.md) · [Контракт gateway](../websites-admin/docs/platform-integration.md)

Источник не содержит баз, credentials, production aliases или deployment overlays. Настройте trusted hosts, mounts, права и разрешённые host-agent операции для своей установки. Python tests запускаются через pytest в каталоге приложения; browser fixture обеих админок находится в `../websites-admin/tests/admin_shell_browser.test.mjs` и использует Playwright из frontend PL. Tests не запускают реальные restart или уведомления.
""",
    "websites-admin": """# PL Websites Admin

Отдельный интерфейс управления HTTP- и content-проверками сайтов. Не устанавливается автоматически вместе с core PL. Сервис управляет выбранными оператором YAML-файлами HTTP targets, content targets и Blackbox modules. Перед записью создаёт snapshot, проверяет YAML и Blackbox, применяет изменения атомарно и выполняет read-back; ошибка после применения запускает rollback.

Для integrated-входа задаются `WEBSITES_ADMIN_AUTH_MODE=gateway` и `WEBSITES_ADMIN_PLATFORM_SSO_KEY_FILE` с индивидуальным raw32 ключом. Самостоятельный режим сохраняет собственные Argon2id credentials и SQLite sessions. Gateway mode требует подпись PL для каждого запроса и не переходит в standalone при ошибке подписи. Trusted hosts, SSRF allowlist, адреса Prometheus/Blackbox, paths и необязательные уведомления задаются для своей установки.

[Runtime layout и права](docs/production-layout.md) · [Контракт gateway](docs/platform-integration.md)

Python tests запускаются через pytest в каталоге приложения. `tests/admin_shell_browser.test.mjs` проверяет обе standalone-админки, а `tests/reports_shell_browser.test.mjs` — общую оболочку Reports. Browser fixtures используют Playwright из frontend PL и не применяют конфигурацию реальных сервисов. SQLite, snapshots, config targets и credentials не входят в исходники.
""",
}

PUBLIC_STANDALONE_GATEWAY = """# Gateway standalone-админок PL

Monitoring Admin публикуется под `/admin/`, Websites Admin — под `/websites/`. Это отдельные сервисы: их source не создаёт runtime route или доступ автоматически. Портал проверяет текущую admin session и Origin/CSRF, затем подписывает точные method, raw URI/query, body hash, content type и idempotency key.

Headers: `X-PL-Gateway-Assertion`, `X-PL-Gateway-Signature`. HMAC domain — `pl-gateway-v1\\n` с настоящим LF. Каждая админка получает собственный ключ из 32 raw bytes через read-only файл. Публичный контракт и общие тестовые vectors находятся в `it-portal/docs/platform-sso-contract.md` и `it-portal/docs/examples/admin-v1-vectors.json`.

Gateway проверяет audience/scopes, TTL, подпись, method/path/body binding, derived CSRF и replay. Он не принимает локальную session как замену подписи. Unsafe nonce cache ограничен одним процессом/репликой; persistent operation tokens и jobs сохраняют отдельную idempotency-защиту. Не включайте fallback с gateway на standalone при ошибке авторизации.

В gateway mode UI использует центральные `/ecosystem/` assets и общий POST `/auth/logout`. Исходная cookie и portal CSRF не передаются upstream. Standalone mode использует собственный вход и выход. Развёртывание должно согласованно настроить prefix, proxy, individual key, trusted hosts и права чтения ключа; source tests не подтверждают пользовательский сценарий конкретной установки.
"""

PUBLIC_AUDITOR_README = """# PL File Auditor

Исходники отдельной Windows-службы FileStructureAuditor и её web-интерфейса. Core PL не устанавливает Windows-службу автоматически. Сканер использует Windows API: компиляция и тесты в Linux SDK не подтверждают работу службы или сканирование Windows-файловой системы.

Для своей установки задайте SQLite storage, доступные корни сканирования, параметры Windows Service, журналирования и TLS. Gateway требует `Gateway:Enabled`, `Gateway:PathBase` и `Gateway:KeyFile`; файл должен содержать индивидуальный ключ из 32 raw bytes и читаться только нужным процессом. В Production отключить проверку gateway нельзя. Данные, customer paths и ключи не входят в исходники.

[Контракт gateway v2](docs/gateway-v2-contract.md) · [Удаление собственной установки](docs/uninstall.md)

Проверка исходников:

```sh
dotnet test --project tests/Auditor.Tests/Auditor.Tests.csproj
cd src/Auditor.Web
npm ci
npm run lint
AUDITOR_APP_BASE=/audit/ npm run build
npm run test:browser
```

Browser tests запускают локальный fixture API и требуют Chromium/WebKit отдельно. Общий `@pl/ui` включён как локальный versioned archive в `src/Auditor.Web/vendor/`. Зависимости сохраняют свои лицензии; собственный код PL лицензирован по корневому MIT.
"""

GENERATED_PUBLIC_PATHS = {"README.md", ".gitignore", "installer/README.ru.md", "apps/file-auditor/README.md",
                          "monitoring/source/monitoring-admin/README.md", "monitoring/source/websites-admin/README.md",
                          "monitoring/source/websites-admin/docs/platform-integration.md"}

PUBLIC_README = """# PL

PL — платформа для каталога ресурсов, карточек сервисов, систем и подключаемых инструментов. Новая установка получает core: Go API, web-интерфейс и PostgreSQL. Образы приложений загружаются отдельно, когда администратор устанавливает модуль из web PL.

Установочный core содержит готовые образы и может занимать сотни MiB. Отдельный архив публичных исходников обычно занимает несколько MiB после сжатия; его состав описывает `PUBLIC-SOURCE-MANIFEST.json`.

Ручная диагностика входит в core: ICMP, DNS, PTR, HTTP, TCP, TLS, проверка портов и клиент iperf3. Установка и обновление автоматически подготавливают компоненты ICMP. Режим ICMP и ограничения по сетям меняются через web PL.

## Установка

На отдельном сервере Ubuntu или Debian с доступом в интернет:

```sh
curl -fsSL https://raw.githubusercontent.com/Sauke5/pl/main/installer/get-pl.sh | sudo sh
```

Bootstrap определяет адрес сервера, проверяет подписанный каталог и контрольные суммы, устанавливает core и создаёт локальную учётную запись `admin` с первоначальным паролем `admin`. После входа смените пароль в PL. Первый запуск создаёт самоподписанный TLS-сертификат, повторный сохраняет существующий. Собственный домен можно задать через `--public-url`, доверенный сертификат — загрузить в настройках PL. Дополнительные параметры: `sh get-pl.sh --help`.

В «Настройки → Развёртывание» меняются адрес, TLS-сертификат, разрешённые сети и порты источников, а также CA внешних HTTPS-интеграций. PL проверяет конфигурацию и восстанавливает предыдущую при неудачном применении. Настройки Active Directory и credentials подключений сохраняются через web.

[Руководство установки и сборки](installer/README.ru.md) · [Лицензии компонентов](installer/LICENSES.txt)

## Настройка и модули

В web PL создаются карточки и системы, пользователи и внешние подключения. Раздел Active Directory позволяет задать сервер, домен входа, Base DN, группу администраторов, учётную запись чтения и сертификаты CA, проверить соединение и сохранить настройки. Пароль чтения хранится зашифрованным. Локальная учётная запись администратора доступна для восстановления.

В каталоге представлены Prometheus, Alertmanager, Xray, Wayline, Grafana, Forms, Doska, SFTPGo, NetMap и BookStack. Доступность установки конкретной версии определяется подписанным каталогом релиза и архитектурой сервера. Исходники модулей и зафиксированные зависимости входят в этот репозиторий; их runtime-образы не скачиваются при установке core. Внешний сервис можно подключить отдельно, если для него доступен connector.

File Auditor поставляется отдельными исходниками Windows-службы и интерфейса в `apps/file-auditor`. Для рабочего сканирования нужен Windows-сервер и явные корни сканирования. Компиляция и тесты в Linux SDK не подтверждают работу службы и Windows API.

## Обновления и данные

Администратор получает уведомление о новой версии в PL и запускает обновление в настройках. Host-controller принимает только конечные операции установки и обновления, проверяет подпись каталога, совместимость и hashes артефактов. Docker socket не передаётся в API или web.

Перед подтверждением установки PL показывает описание версии из подписанного каталога: какую пользу приносит обновление, что появилось, что улучшено и какие ошибки исправлены. Описание готовится для пользователей и доступно на странице обновлений.

Доступ к GitHub для каталога и загрузки core/модулей настраивается в web PL. Можно выбрать прямое соединение, внешний HTTP CONNECT или SOCKS5 proxy с DNS через proxy либо существующий inbound установленного PL-модуля Xray. Внешний Xray на том же сервере подключается как внешний proxy по `127.0.0.1`. Перед сохранением доступна проверка подписанного каталога; ошибка выбранного канала останавливает доставку без перехода на прямое соединение. Для первой установки Xray нужен уже работающий канал первоначальной загрузки.

Обновление сохраняет конфигурацию и данные установки. Перед применением создаётся согласованный snapshot core и установленных локальных модулей; при неудаче возвращаются данные и образы. Смена только image не является откатом миграции базы. Прерванная операция отображает своё состояние и требует восстановления перед следующей попыткой. Поддерживаемые переходы и ограничения определяются контрактом конкретного релиза.

## Исходники и проверки

```sh
python3 -m unittest discover -s installer/tests
go -C monitoring/source/it-portal test ./...
npm --prefix monitoring/source/it-portal/frontend ci
npm --prefix monitoring/source/it-portal/frontend run build
```

PostgreSQL integration tests используют отдельную тестовую базу, заданную через `PORTAL_TEST_DATABASE_URL`. Сборка контейнеров выполняется локальным Docker через `installer/package.py`; сначала создайте allowlisted source context. Source tests, сборка образов, опубликованный релиз и runtime-приёмка — разные этапы.

`PUBLIC-SOURCE-MANIFEST.json` содержит hashes всех выбранных файлов. Этот репозиторий создан из проверенного экспорта; конфигурации установок, credentials, runtime-данные и прежняя история разработки не входят в него.

## Лицензия

Собственный код PL распространяется по [MIT](LICENSE). Зависимости и отдельные приложения сохраняют свои лицензии и авторство; подробности — в [NOTICE](NOTICE), исходниках компонентов и `deploy/images/*.sources.json`. MIT для PL не изменяет условий Grafana, HeyForm, SFTPGo, NetBox, BookStack и других сторонних компонентов.
"""


if __name__ == "__main__":
    raise SystemExit(main())
