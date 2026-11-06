#!/usr/bin/env python3
"""Private backup and bounded restore for an installed PL core on local Linux."""
from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

_spec = importlib.util.spec_from_file_location("pl_maintenance_bootstrap", Path(__file__).with_name("bootstrap.py"))
bootstrap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bootstrap)

HEX = re.compile(r"[0-9a-f]{64}\Z")
IDENTITY = re.compile(r"pl-[0-9a-f]{12}\Z")
PHC = re.compile(rb"\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}\n?\Z")
MAX_DUMP = 8 * 1024 ** 3
MAX_ARCHIVE = MAX_DUMP + 1024 ** 2
TABLES = {"schema_migrations", "documents", "sessions", "oidc_states", "jobs", "import_plans",
          "audit_events", "events", "local_login_attempts"}
CONNECTOR_KEY_MEMBER = "integration-credential-key"
# Exact cumulative table sets from the shipped migrations, not arbitrary tables
# sharing a prefix. Intermediate package schemas keep their previous contracts.
TABLE_STAGES = (
    {"sftp_collections", "sftp_collection_readers", "sftp_accounts", "sftp_account_collections", "sftp_versions", "sftp_version_seen", "sftp_access_audit"},
    {"sftp_provider_state"},
    {"sftp_receipt_rejections"},
    {"sftp_version_deletions", "sftp_active_files"},
    {"org_employees", "org_departments", "org_department_groups", "org_employee_candidates", "org_primary_selections", "org_department_heads", "org_outbox", "org_audit", "org_cursor_state", "org_snapshots", "org_snapshot_items"},
    {"event_journal_readers", "event_journal_seen"},
    {"pl_local_directory_accounts", "pl_local_directory_events", "pl_local_directory_snapshots", "pl_local_directory_snapshot_items"},
    {"ad_login_settings"},
)
TABLE_PROFILES = [TABLES, TABLES | {"local_users"}]
for _stage in TABLE_STAGES:
    TABLE_PROFILES.append(TABLE_PROFILES[-1] | _stage)
CURRENT_TABLES = TABLE_PROFILES[-1]
SCAFFOLDING_ROWS = {
    "sftp_provider_state": [{"id": True, "last_attempt_at": None, "last_success_at": None, "error": "", "cursor_timestamp": 0}],
    "org_cursor_state": [{"singleton": True, "retained_after": 0}],
}
DEFAULTS = {
    "settings": {"revision": 0, "board_enabled": False, "board_anonymous": False,
                 "board_title": "Platform · Состояние сервисов", "board_resource_ids": [],
                 "timezone": "Europe/Moscow", "stale_after_seconds": 180},
    "dictionaries": {"revision": 0, "directions": ["Мониторинг", "Сети", "AD / Windows", "Виртуализация", "Контейнеры", "Файлы", "Управление"],
                     "sites": [], "environments": ["Prod", "Test", "Lab"],
                     "types": ["Приложение", "Сервер", "Сетевое устройство", "Хранилище", "Management"]},
}
CURRENT_DEFAULTS = {
    "settings": {**DEFAULTS["settings"], "session_lifetime_minutes": 0, "local_password_min_length": 0},
    "dictionaries": {**DEFAULTS["dictionaries"], "relation_types": ["Размещено на", "Использует БД", "Зависит от", "Резервируется на"]},
}
# The PostgreSQL deparser preserves precedence while removing redundant AND
# parentheses that change during dump/restore of BETWEEN combined with AND.
SCHEMA_SQL = """SELECT json_build_object(
 'postgres_major', current_setting('server_version_num')::int / 10000,
 'migrations', (SELECT json_agg(version ORDER BY version) FROM public.schema_migrations),
 'columns', (SELECT json_agg(row_to_json(c) ORDER BY c.table_name,c.ordinal_position) FROM
   (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public') c),
 'constraints', (SELECT json_agg(row_to_json(c) ORDER BY c.tab,c.name) FROM
   (SELECT r.relname AS tab,k.conname AS name,pg_get_constraintdef(k.oid, true) AS def
    FROM pg_constraint k JOIN pg_class r ON r.oid=k.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public') c),
 'indexes', (SELECT json_agg(row_to_json(i) ORDER BY i.tablename,i.indexname) FROM
   (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public') i));"""
FRESH_SQL = """SELECT json_build_object(
 'tables',(SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'),
 'foreign_tables',(SELECT count(*) FROM information_schema.foreign_tables WHERE foreign_table_schema='public'),
 'foreign_schemas',(SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'),
 'large_objects',(SELECT count(*) FROM pg_largeobject_metadata),
 'documents',(SELECT coalesce(json_agg(json_build_object('kind',kind,'id',id,'revision',revision,'body',body)), '[]'::json) FROM documents),
 'blocking',(SELECT count(*) FROM jobs)+(SELECT count(*) FROM import_plans)+(SELECT count(*) FROM events)+(SELECT count(*) FROM oidc_states),
 'foreign_sessions',(SELECT count(*) FROM sessions WHERE user_id<>'local-admin' OR NOT admin),
 'foreign_audit',(SELECT count(*) FROM audit_events WHERE body->>'kind' IS DISTINCT FROM 'auth.login'
   OR body->>'actor' IS DISTINCT FROM 'local-admin' OR coalesce(body->>'resource_id','')<>'')
);"""


def private_regular(path: Path, *, max_bytes: int | None = None, mode: int = 0o600) -> None:
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) != mode:
        raise ValueError("A root-owned regular file with the required private mode is needed")
    if max_bytes is not None and s.st_size > max_bytes:
        raise ValueError("Private input exceeds its size limit")


def safe_json(path: Path, *, private=False) -> dict:
    s = path.lstat()
    if (not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o022
            or s.st_size > 1024 * 1024):
        raise ValueError("Unsafe managed JSON file")
    if private:
        private_regular(path)
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("Expected managed JSON object")
    return value


def validate_auth(value: dict) -> dict:
    if (set(value) != {"hash", "password_change_required"} or not isinstance(value["hash"], str)
            or not PHC.fullmatch(value["hash"].encode()) or type(value["password_change_required"]) is not bool):
        raise ValueError("Invalid private authentication payload")
    return value


def supported_tables(tables: set, *, connector_credentials=False) -> bool:
    if connector_credentials:
        return tables == CURRENT_TABLES | {"integration_credentials"}
    return tables in TABLE_PROFILES


def validate_fresh(data: dict, *, connector_credentials=False) -> None:
    tables = set(data.get("tables") or [])
    if (not supported_tables(tables, connector_credentials=connector_credentials) or data.get("local_users_count", 0) != 0
            or (connector_credentials and data.get("integration_credentials_count") != 0)
            or data.get("foreign_tables") != 0
            or data.get("foreign_schemas") != 0 or data.get("large_objects") != 0
            or data.get("blocking") != 0 or data.get("foreign_sessions") != 0 or data.get("foreign_audit") != 0):
        raise ValueError("Restore requires an empty fresh core installation")
    extra_tables = tables - TABLES - {"local_users", "integration_credentials"}
    scaffolding = data.get("scaffolding", {})
    if not isinstance(scaffolding, dict) or set(scaffolding) != extra_tables:
        raise ValueError("Fresh schema scaffolding was not fully checked")
    for name in extra_tables:
        value = scaffolding[name]
        if name in SCAFFOLDING_ROWS:
            # Canonical JSON comparison keeps integer 1 distinct from true.
            if json.dumps(value, sort_keys=True) != json.dumps(SCAFFOLDING_ROWS[name], sort_keys=True):
                raise ValueError("Fresh schema singleton scaffolding has changed")
        elif type(value) is not int or value != 0:
            raise ValueError("Restore requires empty directory, organization, journal and SFTP tables")
    documents = data.get("documents")
    if not isinstance(documents, list) or len(documents) != 2:
        raise ValueError("Fresh installation must contain only the two default documents")
    seen = set()
    defaults = CURRENT_DEFAULTS if "pl_local_directory_accounts" in tables else DEFAULTS
    for d in documents:
        kind = d.get("kind")
        if (kind not in DEFAULTS or kind in seen or d.get("id") != "global" or d.get("revision") != 1
                or d.get("body") != defaults[kind]):
            raise ValueError("Fresh installation default documents have been changed")
        seen.add(kind)


def same_contract(meta: dict, rt) -> None:
    expected_features = {"connector_credentials": True} if rt.m.get("features", {}).get("connector_credentials") else {}
    if (meta.get("schema") != 1 or meta.get("product") != "PL-private-backup"
            or meta.get("features", {}) != expected_features
            or not IDENTITY.fullmatch(meta.get("source_install_id", ""))
            or meta.get("source_install_id") == rt.install_id
            or meta.get("version") != rt.state["version"]
            or meta.get("manifest_sha256") != rt.state["manifest_sha256"]
            or meta.get("images") != rt.image_ids
            or meta.get("postgres_major") != rt.schema["postgres_major"]
            or meta.get("database_schema") != rt.schema
            or meta.get("admin_user") != rt.state["config"]["admin_user"]):
        raise ValueError("Backup requires a different fresh target with the same package, schema, images and admin name")


class Runtime:
    def __init__(self, root: Path):
        # No directory creation/chmod before validation: a foreign root remains untouched.
        self.root = root.absolute()
        if self.root == Path("/") or self.root != self.root.resolve():
            raise ValueError("Use a real absolute managed installation root")
        bootstrap.managed_root(self.root)
        for name in ("private", "state", "config", "releases"):
            p = self.root / name
            s = p.lstat()
            if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o022:
                raise ValueError("Unsafe managed installation directory")
        if stat.S_IMODE((self.root / "private").stat().st_mode) != 0o700:
            raise ValueError("Private directory must be root-owned 0700")
        self.private = self.root / "private"
        self.state = safe_json(self.root / "state/installation.json", private=True)
        self.install_id = self.state.get("install_id", "")
        if (self.state.get("schema") != 1 or self.state.get("product") not in ("PL", "Pl")
                or self.state.get("phase") != "ready" or not IDENTITY.fullmatch(self.install_id)
                or not bootstrap.VERSION.fullmatch(self.state.get("version", ""))):
            raise ValueError("A ready managed PL core installation is required")
        cfg = self.state.get("config", {})
        if not isinstance(cfg, dict):
            raise ValueError("Unsupported core configuration")
        canonical = bootstrap.configuration(cfg["public_url"], cfg["bind_address"], cfg["admin_user"],
                                             cfg.get("network_cidr"), cfg.get("module_network_cidr"),
                                             cfg.get("integration_config"),
                                             cfg.get("icmp_allowed_cidrs") if "icmp_allowed_cidrs" in cfg else None)
        # The bootstrap and the web deployment editor persist these finite
        # extensions. compose_model below validates their destination/CA rules;
        # unrelated keys and noncanonical base/ICMP values remain rejected.
        for name in ("allowed_cidrs", "allowed_ports", "custom_tls", "outbound_ca_pem", "icmp_policy_mode"):
            if name in cfg:
                canonical[name] = cfg[name]
        if "custom_tls" in cfg and type(cfg["custom_tls"]) is not bool:
            raise ValueError("Invalid persisted custom TLS mode")
        bootstrap.icmp_policy(cfg)
        if canonical != cfg:
            raise ValueError("Unsupported core configuration")
        bootstrap.validate_integration_secrets(self.root, cfg.get("integration_config"))
        self.package = self.root / "releases" / self.state["version"]
        if self.package != self.package.resolve():
            raise ValueError("Unsafe package directory")
        self.m = bootstrap.manifest(self.package)
        if (self.m["version"] != self.state["version"] or bootstrap.digest(self.package / "manifest.json") != self.state["manifest_sha256"]):
            raise ValueError("Installed package manifest differs from state")
        if self.m.get("features", {}).get("connector_credentials"):
            bootstrap.read_connector_key(self.root)
        model = safe_json(self.root / "config/compose.json", private=True)
        if not bootstrap.managed_model_equal(model, bootstrap.compose_model(self.root, self.m, cfg, self.install_id)):
            raise ValueError("Core Compose differs from the managed model")
        self.model = model
        private_regular(self.private / "runtime.env")
        if os.environ.get("DOCKER_HOST") not in (None, "unix:///var/run/docker.sock") or os.environ.get("DOCKER_CONTEXT"):
            raise ValueError("Docker endpoint overrides are refused")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("DOCKER_", "COMPOSE_", "PORTAL_", "PL_"))}
        self.image_ids = {}
        self.schema = {}

    def run(self, args, *, data=None, stdout=None, stdin=None, timeout=600):
        try:
            result = subprocess.run(args, input=data, stdin=stdin, stdout=stdout if stdout is not None else subprocess.PIPE,
                                    stderr=subprocess.PIPE, cwd=self.root, env=self.env, timeout=timeout)
        except subprocess.SubprocessError:
            raise ValueError("Maintenance command timed out or failed to start") from None
        if result.returncode:
            # Output can contain dump values or passwords. Do not retain it, even in diagnostics.
            # Retain a nonreversible stderr fingerprint and return code in a root-private log.
            record = {"command": Path(args[0]).name, "returncode": result.returncode,
                      "stderr_sha256": hashlib.sha256(result.stderr).hexdigest(), "time": int(time.time()),
                      "diagnostics": "Command output redacted because it can contain private data"}
            bootstrap.write_json(self.private / "maintenance-error.json", record)
            raise ValueError("Maintenance command failed; redacted diagnostics: private/maintenance-error.json")
        return result.stdout if stdout is None else None

    def docker(self, *args, **kwargs):
        return self.run(["docker", "--host", "unix:///var/run/docker.sock", *args], **kwargs)

    def compose(self, *args, **kwargs):
        return self.docker("compose", "--project-name", self.install_id, "--env-file", str(self.private / "runtime.env"),
                           "-f", str(self.root / "config/compose.json"), *args, **kwargs)

    def sql(self, query: str, database="pl") -> bytes:
        if not re.fullmatch(r"pl(?:_stage_[0-9a-f]{12}|_before_[0-9a-f]{12})?", database):
            raise ValueError("Unsafe maintenance database identity")
        return self.compose("exec", "-T", "db", "psql", "-X", "--no-password", "-U", "pl", "-d", database,
                            "-v", "ON_ERROR_STOP=1", "-At", data=query.encode())

    def schema_contract(self, database="pl") -> dict:
        return json.loads(self.sql(SCHEMA_SQL, database))

    def validate_runtime(self):
        for name in ("api", "web", "db"):
            ref = self.m["images"][name].get("id") or self.m["images"][name]["ref"]
            meta = json.loads(self.docker("image", "inspect", ref))[0]
            if meta.get("Os") != "linux" or meta.get("Architecture") != self.m["architecture"] or not bootstrap.SHA.fullmatch(meta.get("Id", "")):
                raise ValueError("Installed image identity differs")
            if (name != "db" or self.m.get("schema") == 2) and meta["Id"] != ref:
                raise ValueError("Installed core image content ID differs")
            if self.m.get("schema") == 2 and any((meta.get("Config", {}).get("Labels") or {}).get(k) != v for k, v in self.m["images"][name]["labels"].items()):
                raise ValueError("Installed image provenance differs")
            self.image_ids[name] = meta["Id"]
        for name in (self.install_id + "_db", self.install_id + "-auth"):
            meta = json.loads(self.docker("volume", "inspect", name))[0]
            if meta.get("Driver") != "local" or meta.get("Options") or meta.get("Labels", {}).get("pl.installation") != self.install_id:
                raise ValueError("Core volume ownership/driver mismatch")
        self.services = {}
        self.containers = {}
        for name in ("db", "api", "web"):
            ids = self.compose("ps", "--all", "--quiet", name).decode().split()
            if len(ids) != 1:
                raise ValueError("Exactly one managed container per core service is required")
            c = json.loads(self.docker("container", "inspect", ids[0]))[0]
            labels = c.get("Config", {}).get("Labels", {})
            state = c.get("State", {})
            if (labels.get("com.docker.compose.project") != self.install_id
                    or labels.get("com.docker.compose.service") != name or c.get("Image") != self.image_ids[name]
                    or state.get("Paused") or state.get("Restarting") or state.get("Status") not in ("running", "exited", "created")):
                raise ValueError("Managed core container identity/state mismatch")
            if name in ("db", "api"):
                target = bootstrap.database_mount(self.m) if name == "db" else "/run/pl-auth"
                expected = self.install_id + ("_db" if name == "db" else "-auth")
                found = [x for x in c.get("Mounts", []) if x.get("Destination") == target]
                if len(found) != 1 or found[0].get("Type") != "volume" or found[0].get("Name") != expected:
                    raise ValueError("Managed core volume mount mismatch")
            mounts = c.get("Mounts", [])
            if any(x.get("Type") not in ("volume", "bind", "tmpfs") for x in mounts):
                raise ValueError("Unexpected managed container mount type")
            if name == "api":
                transfer_mounts = [x for x in mounts if x.get("Destination") == "/var/lib/pl/transfers"]
                transfer_enabled = (self.m.get("features", {}).get("sftpgo_module") is True
                                    or self.m.get("features", {}).get("on_demand_modules") is True)
                if transfer_enabled:
                    expected = self.install_id + "_module-transfers"
                    if (len(transfer_mounts) != 1 or transfer_mounts[0].get("Type") != "volume"
                            or transfer_mounts[0].get("Name") != expected or transfer_mounts[0].get("RW") is not True):
                        raise ValueError("Temporary transfer volume mount mismatch")
                    volume = json.loads(self.docker("volume", "inspect", expected))[0]
                    labels = volume.get("Labels") or {}
                    if (volume.get("Name") != expected or volume.get("Driver") != "local" or volume.get("Options") not in (None, {})
                            or not isinstance(labels, dict) or labels.get("pl.installation") != self.install_id
                            or labels.get("pl.temporary") != "true"):
                        raise ValueError("Temporary transfer volume ownership/driver mismatch")
                elif transfer_mounts:
                    raise ValueError("Unexpected temporary transfer volume without module feature")
            if name in ("db", "api"):
                allowed = {bootstrap.database_mount(self.m)} if name == "db" else {"/run/pl-auth", "/tmp"}
                if name == "api" and transfer_enabled:
                    allowed.add("/var/lib/pl/transfers")
                if name == "api":
                    expected_binds = {}
                    if self.m.get("features", {}).get("upgrade_status"):
                        expected_binds["/run/pl-upgrade"] = str(self.root / "run/upgrade-status")
                    if self.m.get("features", {}).get("module_controller"):
                        expected_binds.update({"/run/pl-module-controller": str(self.root / "run/module-controller"),
                                               "/run/secrets/module-controller-key": str(self.private / "module-controller-key")})
                    if self.m.get("features", {}).get("icmp_probe"):
                        expected_binds["/run/pl-icmp-probe"] = str(self.root / "run/icmp-probe")
                    cfg = getattr(self, "state", {}).get("config", {})
                    canonical_api = getattr(self, "model", {}).get("services", {}).get("api", {})
                    canonical_env = canonical_api.get("environment", {})
                    if canonical_env:
                        env = c.get("Config", {}).get("Env", [])
                        if not isinstance(env, list) or any(not isinstance(item, str) or "=" not in item for item in env):
                            raise ValueError("API environment differs from the managed model")
                        actual = dict(item.split("=", 1) for item in env)
                        names = ("PORTAL_PUBLIC_URL", "PORTAL_ALLOWED_CIDRS", "PORTAL_ALLOWED_PORTS",
                                 "PORTAL_CHECK_ALLOWED_CIDRS", "PORTAL_CHECK_ALLOWED_PORTS", "PORTAL_CHECK_INHERIT_INTEGRATION_POLICY",
                                 "PORTAL_ICMP_EXECUTOR_URL", "PORTAL_ICMP_POLICY", "PORTAL_ICMP_ALLOWED_CIDRS", "PORTAL_OUTBOUND_CA_FILE")
                        if len(actual) != len(env) or any(actual.get(name) != canonical_env.get(name) for name in names):
                            raise ValueError("API environment differs from the managed model")
                    if self.m.get("features", {}).get("icmp_probe"):
                        groups = canonical_api.get("group_add", [])
                        if not groups or not set(groups) <= set(c.get("HostConfig", {}).get("GroupAdd") or []):
                            raise ValueError("ICMP socket API service group differs from the managed model")
                    if cfg.get("outbound_ca_pem"):
                        ca = self.private / "outbound-ca.pem"
                        value = bootstrap._integration_read(ca, owner={os.geteuid()}, modes={0o444}, limit=64 * 1024)
                        if value != cfg["outbound_ca_pem"].encode():
                            raise ValueError("Outbound CA file differs from the persisted configuration")
                        expected_binds["/run/secrets/outbound-ca.pem"] = str(ca)
                    if self.m.get("features", {}).get("connector_credentials"):
                        bootstrap.read_connector_key(self.root)
                        expected_binds[bootstrap.CONNECTOR_KEY_TARGET] = str(self.private / CONNECTOR_KEY_MEMBER)
                        env = c.get("Config", {}).get("Env", [])
                        actual = dict(item.split("=", 1) for item in env if isinstance(item, str) and "=" in item)
                        gid = str(bootstrap.connector_service_gid(self.root))
                        if (len(actual) != len(env) or actual.get("PORTAL_CONNECTOR_KEY_FILE") != bootstrap.CONNECTOR_KEY_TARGET
                                or gid not in (c.get("HostConfig", {}).get("GroupAdd") or [])):
                            raise ValueError("Connector credential API key access differs from the managed model")
                    policy = getattr(self, "state", {}).get("config", {}).get("integration_config")
                    if policy is not None:
                        policy = bootstrap.integration_policy(policy)
                        bootstrap.validate_integration_secrets(self.root, policy)
                        if policy["secret_names"]:
                            expected_binds["/run/secrets/portal"] = str(self.private / "integration-secrets")
                        expected_env = bootstrap.integration_environment(policy)
                        # The web editor deliberately overrides destination
                        # policy while retaining the credential-file contract.
                        expected_env = {name: canonical_env.get(name, value) for name, value in expected_env.items()}
                        env = c.get("Config", {}).get("Env", [])
                        if not isinstance(env, list) or any(not isinstance(item, str) or "=" not in item for item in env):
                            raise ValueError("Integration environment differs from the managed model")
                        actual = dict(item.split("=", 1) for item in env)
                        if len(actual) != len(env) or any(actual.get(key) != value for key, value in expected_env.items()):
                            raise ValueError("Integration environment differs from the managed model")
                    allowed |= expected_binds.keys()
                    binds = [x for x in mounts if x.get("Type") == "bind"]
                    if (len(binds) != len(expected_binds) or len({x.get("Destination") for x in binds}) != len(binds)
                            or any(x.get("Source") != expected_binds.get(x.get("Destination")) or x.get("RW") is not False for x in binds)):
                        raise ValueError("Unexpected module controller API mounts")
                if any(x.get("Destination") not in allowed for x in mounts):
                    raise ValueError("Unexpected database/API mount")
            else:
                expected_binds = {"/etc/nginx/nginx.conf": str(self.root / "config/nginx.conf"),
                                  "/run/pl/tls.crt": str(self.private / "tls.crt"),
                                  "/run/pl/tls.key": str(self.private / "tls.key")}
                if self.m.get("features", {}).get("upgrade_status"):
                    expected_binds["/run/pl-upgrade"] = str(self.root / "run/upgrade-status")
                binds = [x for x in mounts if x.get("Type") == "bind"]
                if (len(binds) != len(expected_binds) or len({x.get("Destination") for x in binds}) != len(binds)
                        or any(x.get("Source") != expected_binds.get(x.get("Destination"))
                        or x.get("RW") is not False for x in binds)
                        or any(x.get("Destination") not in {*expected_binds, "/tmp"} for x in mounts)):
                    raise ValueError("Unexpected HTTPS web bind mounts")
            self.services[name] = bool(state.get("Running"))
            self.containers[name] = ids[0]
        if not self.services["db"]:
            raise ValueError("The managed database must already be running")
        self.schema = self.schema_contract()
        if self.m.get("schema") == 2 and self.schema.get("postgres_major") != self.m["database"]["major"]:
            raise ValueError("Installed PostgreSQL major differs from the package")
        if not supported_tables(set(c["table_name"] for c in self.schema.get("columns") or []), connector_credentials=bool(self.m.get("features", {}).get("connector_credentials"))):
            raise ValueError("Unsupported database schema; explicit maintenance migration needed")

    def fresh_contract(self):
        data = json.loads(self.sql(FRESH_SQL))
        tables = set(data.get("tables") or [])
        if not supported_tables(tables, connector_credentials=bool(self.m.get("features", {}).get("connector_credentials"))):
            raise ValueError("Unsupported fresh database table contract")
        if "local_users" in (data.get("tables") or []):
            data["local_users_count"] = int(self.sql("SELECT count(*) FROM public.local_users;").strip())
        else:
            data["local_users_count"] = 0
        if self.m.get("features", {}).get("connector_credentials"):
            data["integration_credentials_count"] = int(self.sql("SELECT count(*) FROM public.integration_credentials;").strip())
        data["scaffolding"] = {}
        for name in sorted(tables - TABLES - {"local_users", "integration_credentials"}):
            if name in SCAFFOLDING_ROWS:
                data["scaffolding"][name] = json.loads(self.sql("SELECT COALESCE(json_agg(to_jsonb(t)), '[]'::json) FROM public." + name + " t;"))
            else:
                data["scaffolding"][name] = int(self.sql("SELECT count(*) FROM public." + name + ";").strip())
        return data

    def verify_connector_credentials(self, database="pl", key_file=None):
        """Use the exact API codec against the selected database, without migrations."""
        if not self.m.get("features", {}).get("connector_credentials"):
            raise ValueError("Connector credential verification is not part of this package")
        if not re.fullmatch(r"pl(?:_stage_[0-9a-f]{12})?", database):
            raise ValueError("Unsafe credential verification database identity")
        key_file = self.private / CONNECTOR_KEY_MEMBER if key_file is None else key_file
        if (not key_file.is_absolute() or key_file != key_file.resolve() or not key_file.is_relative_to(self.private)
                or "," in str(key_file)):
            raise ValueError("Unsafe credential verification key input")
        value = bootstrap._integration_read(key_file, owner={os.geteuid()}, modes={0o600, 0o640}, limit=32)
        if len(value) != 32:
            raise ValueError("Invalid credential verification key input")
        runtime = bootstrap._integration_read(self.private / "runtime.env", owner={os.geteuid()}, modes={0o600}, limit=4096)
        # Only the installer-created DB credential is accepted; never shell-source this file.
        if not re.fullmatch(rb"PL_DB_PASSWORD=[0-9a-f]{64}\n", runtime):
            raise ValueError("Invalid managed database credentials")
        password = runtime.decode().strip().split("=", 1)[1]
        environment = ("PORTAL_DATABASE_URL=postgres://pl:" + password + "@db:5432/" + database + "?sslmode=disable\n"
                       "PORTAL_CONNECTOR_KEY_FILE=" + bootstrap.CONNECTOR_KEY_TARGET + "\n").encode()
        # Docker reads the env file from stdin. Neither key nor DB password enters argv/output.
        self.docker("run", "--rm", "--pull", "never", "--network", self.install_id + "_backend",
                    "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                    "--env-file", "/dev/stdin", "--entrypoint", "/portal",
                    "--mount", "type=bind,source=" + str(key_file) + ",target=" + bootstrap.CONNECTOR_KEY_TARGET + ",readonly",
                    self.image_ids["api"], "verify-connector-credentials", data=environment, timeout=135)

    def helper(self, script: str, data=None):
        return self.docker("run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "-i",
                           "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
                           "--security-opt", "no-new-privileges:true", "--entrypoint", "/bin/sh",
                           "--mount", "type=volume,source=" + self.install_id + "-auth,target=/auth",
                           self.image_ids["web"], "-c", script, data=data)

    def read_auth(self):
        output = self.helper("set -eu; [ ! -L /auth ]; [ \"$(stat -c '%u:%a' /auth)\" = '10001:700' ]; "
            "[ ! -L /auth/local-admin.hash ]; [ -f /auth/local-admin.hash ]; "
            "[ \"$(stat -c '%u:%a' /auth/local-admin.hash)\" = '10001:600' ]; "
            "[ \"$(stat -c '%s' /auth/local-admin.hash)\" -lt 512 ]; "
            "for p in /auth/* /auth/.[!.]* /auth/..?*; do [ -e \"$p\" ] || [ -L \"$p\" ] || continue; "
            "case \"$p\" in /auth/local-admin.hash|/auth/password-change-required) ;; *) exit 1;; esac; done; "
            "cat /auth/local-admin.hash; printf '\\n'; "
            "if [ -e /auth/password-change-required ] || [ -L /auth/password-change-required ]; then "
            "[ ! -L /auth/password-change-required ]; [ -f /auth/password-change-required ]; "
            "[ \"$(stat -c '%s' /auth/password-change-required)\" = 0 ]; printf required; else printf changed; fi")
        hashed, marker = output.rstrip(b"\n").rsplit(b"\n", 1)
        if marker not in (b"required", b"changed"):
            raise ValueError("Unexpected live authentication marker")
        return validate_auth({"hash": hashed.decode().rstrip("\n"), "password_change_required": marker == b"required"})

    def write_auth(self, auth):
        validate_auth(auth)
        marker = ("touch /auth/password-change-required; chown 10001:10001 /auth/password-change-required; "
                  "chmod 600 /auth/password-change-required; " if auth["password_change_required"] else
                  "rm -f /auth/password-change-required; ")
        self.helper("set -eu; [ ! -e /auth/.restore.hash ]; [ ! -L /auth/.restore.hash ]; "
                    "trap 'rm -f /auth/.restore.hash' EXIT; umask 077; cat > /auth/.restore.hash; chown 10001:10001 /auth/.restore.hash; "
                    "chmod 600 /auth/.restore.hash; mv /auth/.restore.hash /auth/local-admin.hash; " + marker,
                    data=(auth["hash"] + "\n").encode())

    def start_original(self):
        failed = []
        for name in ("api", "web"):
            if self.services[name]:
                try:
                    self.compose("start", name)
                except (ValueError, OSError, subprocess.SubprocessError):
                    failed.append(name)
        if failed:
            raise ValueError("Could not resume all originally running services; inspect managed API/web state")

    def wait_original(self):
        pending = {name for name in ("api", "web") if self.services[name]}
        deadline = time.monotonic() + 90
        while pending:
            for name in list(pending):
                value = json.loads(self.docker("container", "inspect", self.containers[name]))[0]["State"]
                if not value.get("Running"):
                    raise ValueError("An originally running core service exited after maintenance")
                if name == "api" or value.get("Health", {}).get("Status") == "healthy":
                    pending.remove(name)
            if pending:
                if time.monotonic() >= deadline:
                    raise ValueError("Core HTTPS readiness did not return after maintenance")
                time.sleep(1)

    @contextmanager
    def quiesced(self):
        try:
            # Stop gateway first; the database remains running for a consistent pg_dump.
            for name in ("web", "api"):
                if self.services[name]:
                    self.compose("stop", "--timeout", "30", name)
            yield
        finally:
            self.start_original()
            self.wait_original()

    def dump(self, path):
        with path.open("xb") as out:
            self.compose("exec", "-T", "db", "pg_dump", "--no-password", "-U", "pl", "-d", "pl",
                         "--format=custom", "--no-owner", "--no-acl", stdout=out)
        path.chmod(0o600)
        with path.open("rb") as f:
            header = f.read(5)
        if path.stat().st_size > MAX_DUMP or header != b"PGDMP":
            raise ValueError("Unexpected database dump or size limit exceeded")

    def restore_dump(self, path: Path, database: str):
        with path.open("rb") as source:
            self.compose("exec", "-T", "db", "pg_restore", "--no-password", "-U", "pl", "-d", database,
                         "--no-owner", "--no-acl", "--exit-on-error", "--single-transaction",
                         stdin=source, stdout=subprocess.DEVNULL)


def lock_directory(path: Path):
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError("Unsafe maintenance lock directory")


@contextmanager
def maintenance_lock(path: Path, *, create=False):
    flags = os.O_RDWR | os.O_NOFOLLOW | (os.O_CREAT if create else 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "a") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError("Unsafe installation maintenance lock")
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Maintenance busy: another installation operation is active") from None
        yield


@contextmanager
def installation(root: Path):
    if sys.platform != "linux" or os.geteuid() != 0:
        raise ValueError("Maintenance requires root on the local Linux installation host")
    initial = Runtime(root)
    # This order matches delivery's queue barrier and worker -> lifecycle
    # ordering. Nonblocking admission cannot deadlock an existing operation.
    with ExitStack() as locks:
        locks.enter_context(maintenance_lock(initial.root / "state/install.lock"))
        delivery = initial.root / "state/delivery"
        on_demand = initial.m.get("features", {}).get("on_demand_modules")
        if on_demand:
            lock_directory(delivery)
            locks.enter_context(maintenance_lock(delivery / "delivery.lock", create=True))
            locks.enter_context(maintenance_lock(delivery / "worker.lock", create=True))
        if initial.m.get("features", {}).get("module_controller") or on_demand:
            modules = initial.root / "modules"
            lock_directory(modules)
            locks.enter_context(maintenance_lock(modules / "controller.lock", create=True))
        operation = delivery / "operation.json"
        if on_demand and (operation.exists() or operation.is_symlink()):
            if safe_json(operation, private=True).get("phase") not in ("complete", "failed", "rolled_back"):
                raise ValueError("Maintenance busy: update/configuration is active or requires recovery")
        # Re-read the complete model only after every relevant barrier is held.
        rt = Runtime(root)
        if (rt.install_id != initial.install_id or rt.state.get("version") != initial.state.get("version")
                or rt.state.get("manifest_sha256") != initial.state.get("manifest_sha256")):
            raise ValueError("Installation changed during maintenance admission; retry after the operation finishes")
        rt.validate_runtime()
        yield rt


def write_archive(output: Path, metadata: dict, dump: Path, auth: dict, connector_key: bytes | None = None):
    expected_features = {"connector_credentials": True} if connector_key is not None else {}
    if metadata.get("features", {}) != expected_features or (connector_key is not None and (not isinstance(connector_key, bytes) or len(connector_key) != 32)):
        raise ValueError("Backup connector credential feature/key mismatch")
    output = output.absolute()
    if output.parent != output.parent.resolve():
        raise ValueError("Use a real backup output directory")
    parent = output.parent.stat()
    if parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
        raise ValueError("Backup output parent must be root-owned and not group/world writable")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as raw, tarfile.open(fileobj=raw, mode="w") as archive:
            members = [("metadata.json", json.dumps(metadata, sort_keys=True).encode()),
                       ("auth.json", json.dumps(auth, sort_keys=True).encode())]
            if connector_key is not None:
                members.append((CONNECTOR_KEY_MEMBER, connector_key))
            for name, body in members:
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(body), 0o600
                archive.addfile(info, io.BytesIO(body))
            info = tarfile.TarInfo("database.dump")
            info.size, info.mode = dump.stat().st_size, 0o600
            with dump.open("rb") as f:
                archive.addfile(info, f)
            raw.flush()
            os.fsync(raw.fileno())
    except BaseException:
        output.unlink(missing_ok=True)
        raise


def require_core_only(rt, database="pl"):
    """Module state/TSDB backup is a separate contract; never emit incomplete full backup."""
    if not rt.m.get("features", {}).get("module_controller"):
        return
    base = rt.root / "modules"
    if base.exists() and any(p.name not in {"operations", "controller.lock"} for p in base.iterdir()):
        raise ValueError("Core backup/restore excludes module data; installed local modules require a module-aware backup")
    count = int(rt.sql("SELECT count(*) FROM public.documents WHERE kind='module_instance' AND body->>'mode'='local';", database).strip())
    if count:
        raise ValueError("Core backup/restore excludes local module instances; module-aware backup is required")


def backup(rt, output: Path):
    if output.exists() or output.is_symlink():
        raise ValueError("Backup output must be a new file")
    require_core_only(rt)
    with tempfile.TemporaryDirectory(prefix="backup-", dir=rt.private) as tmp:
        dump = Path(tmp) / "database.dump"
        with rt.quiesced():
            require_core_only(rt)
            auth = rt.read_auth()  # Live volume, never the original seed on the host.
            connector_key = None
            if rt.m.get("features", {}).get("connector_credentials"):
                connector_key = bootstrap.read_connector_key(rt.root)
                rt.verify_connector_credentials()
            rt.dump(dump)
            schema = rt.schema_contract()
            if schema != rt.schema:
                raise ValueError("Database schema changed during backup")
        auth_body = json.dumps(auth, sort_keys=True).encode()
        metadata = {"schema": 1, "product": "PL-private-backup", "created_unix": int(time.time()),
                    "source_install_id": rt.install_id, "version": rt.state["version"],
                    "manifest_sha256": rt.state["manifest_sha256"], "images": rt.image_ids,
                    "postgres_major": schema["postgres_major"], "database_schema": schema,
                    "admin_user": rt.state["config"]["admin_user"], "source_config": rt.state["config"],
                    "files": {"database.dump": {"sha256": bootstrap.digest(dump), "bytes": dump.stat().st_size},
                              "auth.json": {"sha256": hashlib.sha256(auth_body).hexdigest(), "bytes": len(auth_body)}}}
        if connector_key is not None:
            metadata["features"] = {"connector_credentials": True}
            metadata["files"][CONNECTOR_KEY_MEMBER] = {"sha256": hashlib.sha256(connector_key).hexdigest(), "bytes": 32}
        write_archive(output, metadata, dump, auth, connector_key)
    print("PRIVATE PL backup created; retain offline and restrict access.")
    if rt.state["config"].get("integration_config", {}).get("secret_names"):
        print("Integration secret files are excluded; prepare server-side integration keys on the fresh restore target.")
    print("SHA256: " + bootstrap.digest(output))


def load_archive(path: Path, expected: str, destination: Path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source_file:
        identity = os.fstat(source_file.fileno())
        if (not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.geteuid()
                or stat.S_IMODE(identity.st_mode) != 0o600 or identity.st_size > MAX_ARCHIVE):
            raise ValueError("Backup must be a root-owned regular 0600 file within its size limit")
        checksum = hashlib.sha256()
        for block in iter(lambda: source_file.read(1024 * 1024), b""):
            checksum.update(block)
        if not HEX.fullmatch(expected) or checksum.hexdigest() != expected:
            raise ValueError("Backup SHA256 does not match the independently trusted digest")
        source_file.seek(0)
        names = {"metadata.json", "auth.json", "database.dump"}
        with tarfile.open(fileobj=source_file, mode="r:") as archive:
            members = archive.getmembers()
            actual_names = {m.name for m in members}
            if (actual_names not in (names, names | {CONNECTOR_KEY_MEMBER}) or len(members) != len(actual_names)
                    or any(not m.isfile() for m in members)
                    or any(m.size < 0 or m.size > (MAX_DUMP if m.name == "database.dump" else 32 if m.name == CONNECTOR_KEY_MEMBER else 1024 * 1024) for m in members)):
                raise ValueError("Unexpected backup archive paths, types, duplicates or size")
            for member in members:
                # No archive-driven path interpretation, ownership or extractall.
                out = destination / member.name
                with out.open("xb") as f, archive.extractfile(member) as source:
                    while body := source.read(1024 * 1024):
                        f.write(body)
                out.chmod(0o600)
    meta = safe_json(destination / "metadata.json", private=True)
    files = meta.get("files", {})
    features = meta.get("features", {})
    if features not in ({}, {"connector_credentials": True}) or ("connector_credentials" in features and features["connector_credentials"] is not True):
        raise ValueError("Unsupported backup features")
    expects_key = features == {"connector_credentials": True}
    expected_files = {"database.dump", "auth.json"} | ({CONNECTOR_KEY_MEMBER} if expects_key else set())
    if (not isinstance(files, dict) or set(files) != expected_files or (CONNECTOR_KEY_MEMBER in actual_names) != expects_key
            or (expects_key and (destination / CONNECTOR_KEY_MEMBER).stat().st_size != 32)):
        raise ValueError("Unexpected backup manifest file set")
    for name, record in files.items():
        p = destination / name
        if not isinstance(record, dict) or record.get("bytes") != p.stat().st_size or record.get("sha256") != bootstrap.digest(p):
            raise ValueError("Backup internal file integrity failed")
    dump = destination / "database.dump"
    with dump.open("rb") as f:
        if f.read(5) != b"PGDMP":
            raise ValueError("Expected PostgreSQL custom-format dump")
    auth = validate_auth(safe_json(destination / "auth.json", private=True))
    return meta, dump, auth


def restore(rt, path: Path, expected: str):
    # No service/database mutation until the complete archive and target contract are validated.
    with tempfile.TemporaryDirectory(prefix="restore-", dir=rt.private) as tmp:
        meta, dump, auth = load_archive(path, expected, Path(tmp))
        source_policy = meta.get("source_config", {}).get("integration_config")
        if source_policy is not None:
            source_names = set(bootstrap.integration_policy(source_policy)["secret_names"])
            if source_names:
                try:
                    target_policy = rt.state["config"].get("integration_config")
                    target_names = set(bootstrap.integration_policy(target_policy)["secret_names"]) if target_policy is not None else set()
                    if not source_names <= target_names:
                        raise ValueError
                    bootstrap.validate_integration_secrets(rt.root, target_policy)
                except (ValueError, OSError):
                    raise ValueError("Перед восстановлением подготовьте серверные ключи интеграций на новом хосте") from None
        same_contract(meta, rt)
        credentials_enabled = bool(rt.m.get("features", {}).get("connector_credentials"))
        validate_fresh(rt.fresh_contract(), connector_credentials=credentials_enabled)
        require_core_only(rt)
        original_auth = rt.read_auth()
        original_key = bootstrap.read_connector_key(rt.root) if credentials_enabled else None
        restored_key = (Path(tmp) / CONNECTOR_KEY_MEMBER).read_bytes() if credentials_enabled else None
        if not original_auth["password_change_required"]:
            raise ValueError("Target administrator password has already changed; use a fresh target")
        suffix = secrets.token_hex(6)
        stage, previous = "pl_stage_" + suffix, "pl_before_" + suffix
        swapped = False
        stage_created = False
        auth_touched = False
        key_touched = False
        keep_stopped = False
        stopped = False
        started = False
        completed = False
        try:
            for name in ("web", "api"):
                if rt.services[name]:
                    stopped = True
                    rt.compose("stop", "--timeout", "30", name)
            validate_fresh(rt.fresh_contract(), connector_credentials=credentials_enabled)
            original_auth = rt.read_auth()
            if not original_auth["password_change_required"]:
                raise ValueError("Target password changed while quiescing; restore refused")
            rt.sql('CREATE DATABASE "' + stage + '" TEMPLATE template0;', "pl")
            stage_created = True
            rt.restore_dump(dump, stage)
            if rt.schema_contract(stage) != meta["database_schema"]:
                raise ValueError("Restored staging schema differs from the validated backup")
            require_core_only(rt, stage)
            if credentials_enabled:
                rt.verify_connector_credentials(stage, Path(tmp) / CONNECTOR_KEY_MEMBER)
            rt.sql("BEGIN; DELETE FROM sessions; DELETE FROM oidc_states; DELETE FROM local_login_attempts; COMMIT;", stage)
            if rt.sql("SELECT (SELECT count(*) FROM sessions)+(SELECT count(*) FROM oidc_states)+(SELECT count(*) FROM local_login_attempts);", stage).strip() != b"0":
                raise ValueError("Restored sessions were not revoked")
            # Validate again immediately before the final swap. Other owners must not write directly to PostgreSQL.
            validate_fresh(rt.fresh_contract(), connector_credentials=credentials_enabled)
            if credentials_enabled:
                key_touched = True
                bootstrap.restore_connector_key(rt.root, restored_key)
            rt.sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='pl' AND pid<>pg_backend_pid();")
            # Connect to staging while renaming target. ALTER DATABASE cannot run in a transaction.
            rt.sql('ALTER DATABASE "pl" RENAME TO "' + previous + '";', stage)
            try:
                rt.sql('ALTER DATABASE "' + stage + '" RENAME TO "pl";', previous)
            except BaseException:
                rt.sql('ALTER DATABASE "' + previous + '" RENAME TO "pl";', stage)
                raise
            swapped = True
            auth_touched = True
            rt.write_auth(auth)
            # Keep the old fresh database until data/auth and original service readiness succeeded.
            started = True
            rt.start_original()
            rt.wait_original()
            # It contains only the fresh scaffolding accepted above, never user data.
            rt.sql('DROP DATABASE "' + previous + '";', "pl")
            stage_created = False
            completed = True
        except BaseException:
            try:
                if started:
                    # A failed readiness check must not race a running restored API during rollback.
                    for name in ("web", "api"):
                        if rt.services[name]:
                            rt.compose("stop", "--timeout", "30", name)
                if swapped:
                    # Do not discard the populated restored database: rename it back to its staging name.
                    rt.sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='pl' AND pid<>pg_backend_pid();")
                    rt.sql('ALTER DATABASE "pl" RENAME TO "' + stage + '";', previous)
                    rt.sql('ALTER DATABASE "' + previous + '" RENAME TO "pl";', stage)
                    stage_created = True
                if auth_touched:
                    rt.write_auth(original_auth)
                if key_touched:
                    bootstrap.restore_connector_key(rt.root, original_key)
            except BaseException:
                keep_stopped = True
                bootstrap.write_json(rt.private / "restore-recovery.json", {"stage": stage, "previous": previous,
                    "status": "automatic rollback incomplete; keep API/web stopped; preserve both databases, auth volume, connector key and source backup"})
                raise ValueError("Restore rollback incomplete; API/web left stopped. See private/restore-recovery.json") from None
            # Populated/partially restored staging databases are deliberately retained for investigation.
            if stage_created:
                bootstrap.write_json(rt.private / "restore-recovery.json", {"stage": stage, "previous": previous,
                    "status": "target kept or rolled back; staging retained, inspect before explicit removal"})
            raise
        finally:
            if stopped and not keep_stopped and not completed:
                rt.start_original()
                rt.wait_original()
    print("PL private backup restored into the verified fresh target; browser sessions revoked.")
    print("The target keeps its own installation identity, database password, TLS and HTTPS origin.")
    if rt.state["config"].get("integration_config", {}).get("secret_names"):
        print("Integration secret files were not restored; the target keeps its independently reprovisioned integration secrets.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    b = sub.add_parser("backup", help="Create a PRIVATE database and live-auth backup")
    b.add_argument("--root", type=Path, required=True)
    b.add_argument("--output", type=Path, required=True)
    r = sub.add_parser("restore", help="Restore a trusted PRIVATE backup into a different fresh installation")
    r.add_argument("--root", type=Path, required=True)
    r.add_argument("--backup", type=Path, required=True)
    r.add_argument("--backup-sha256", required=True)
    args = parser.parse_args()
    try:
        with installation(args.root) as rt:
            if args.action == "backup":
                backup(rt, args.output)
            else:
                restore(rt, args.backup, args.backup_sha256)
        return 0
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError, tarfile.TarError, subprocess.SubprocessError) as exc:
        message = str(exc) if isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError) else type(exc).__name__
        print("PL maintenance failed: " + message, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
