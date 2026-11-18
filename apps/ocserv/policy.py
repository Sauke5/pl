"""Revisioned VPN access policy. All calls run serially in the gateway process."""
from datetime import datetime, timezone
import ipaddress
import json
import re
import sqlite3


SUBJECT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@:+-]{0,61}")
PROFILE = re.compile(r"[a-z][a-z0-9-]{0,47}")
SESSION = re.compile(r"[1-9][0-9]{0,9}")
DEVICE = re.compile(r"plvpn[0-9]{1,10}")
RESERVED = tuple(ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4"))
FIELDS = {
    "state": set(), "profile": {"revision", "actor", "id", "name", "networks"},
    "grant": {"revision", "actor", "subject", "display_name", "profile_id", "expires_at"},
    "revoke": {"revision", "actor", "subject"}, "terminate": {"revision", "actor", "id"},
}


class Error(Exception):
    def __init__(self, status, code, message):
        self.status, self.code = status, code
        super().__init__(message)


def invalid(message):
    return Error(422, "ocserv_invalid", message)


def stamp(now):
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def label(value, limit, field):
    if not isinstance(value, str) or not 1 <= len(value) <= limit or value != value.strip() or not value.isprintable():
        raise invalid("Проверьте поле «" + field + "».")
    return value


def token(value, pattern, field):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise invalid("Недопустимый идентификатор " + field + ".")
    return value


def networks(values, pool):
    if not isinstance(values, list) or not 1 <= len(values) <= 64:
        raise invalid("Укажите от 1 до 64 IPv4-подсетей.")
    result = []
    for value in values:
        try:
            net = ipaddress.IPv4Network(value) if isinstance(value, str) else None
        except ValueError:
            net = None
        if not net or str(net) != value or not net.prefixlen or value in result:
            raise invalid("Укажите уникальные IPv4-подсети в формате CIDR.")
        if any(net.overlaps(other) for other in RESERVED + ((pool,) if pool else ())):
            raise invalid("Подсеть пересекается со служебным диапазоном или пулом VPN.")
        result.append(value)
    return result


def deadline(value, now):
    if value == "":
        return 0
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value):
        raise invalid("Укажите время окончания доступа в UTC.")
    try:
        dt = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        end = int(dt.timestamp())
    except (ValueError, OverflowError):
        raise invalid("Некорректное время окончания доступа.") from None
    if end <= now:
        raise invalid("Время окончания доступа должно быть в будущем.")
    return end


class Policy:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS meta(revision INTEGER NOT NULL);
            INSERT INTO meta SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM meta);
            CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, networks TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS grants(subject TEXT PRIMARY KEY, display_name TEXT NOT NULL,
                profile_id TEXT NOT NULL REFERENCES profiles(id), end INTEGER NOT NULL, revoked INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS certificate_names(cn TEXT PRIMARY KEY, subject TEXT NOT NULL REFERENCES grants(subject),
                current INTEGER NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS active_certificate_name ON certificate_names(subject) WHERE current=1;
            CREATE TABLE IF NOT EXISTS pending(subject TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, at TEXT, actor TEXT, action TEXT, subject TEXT);
        """)

    def revision(self):
        return self.db.execute("SELECT revision FROM meta").fetchone()[0]

    def grant(self, subject):
        return self.db.execute("""SELECT g.*, p.networks FROM grants g JOIN profiles p ON p.id=g.profile_id
                                  WHERE g.subject=?""", (subject,)).fetchone()

    def ensure_certificate_names(self):
        # An installation may already have grants when the gateway is first configured.
        self.db.execute("""INSERT INTO certificate_names(cn, subject, current)
                           SELECT 'plc-' || lower(hex(randomblob(16))), g.subject, 1 FROM grants g
                           WHERE g.revoked=0 AND NOT EXISTS (SELECT 1 FROM certificate_names c
                           WHERE c.current=1 AND c.subject=g.subject)""")

    def certificate_owner(self, cn, current_only=False):
        row = self.db.execute("SELECT subject FROM certificate_names WHERE cn=? AND (current=1 OR ?=0)",
                              (cn, current_only)).fetchone()
        return row[0] if row else None

    def certificate_names(self, subject):
        return self.db.execute("SELECT cn, current FROM certificate_names WHERE subject=?", (subject,)).fetchall()

    def subjects(self):
        return [r[0] for r in self.db.execute("SELECT subject FROM grants ORDER BY subject")]

    def pending(self):
        return {r[0] for r in self.db.execute("SELECT subject FROM pending")}

    def expiry(self, now):
        # Record each deadline once. The kernel also enforces the deadline on a live lease.
        with self.db:
            rows = self.db.execute("SELECT subject FROM grants WHERE revoked=0 AND end>0 AND end<=?", (now,)).fetchall()
            if rows:
                self.db.executemany("INSERT OR IGNORE INTO pending VALUES (?)", [tuple(r) for r in rows])
                self.db.execute("UPDATE grants SET revoked=2 WHERE revoked=0 AND end>0 AND end<=?", (now,))
                self.db.execute("UPDATE meta SET revision=revision+1")
        return bool(rows)

    def check(self, action, body):
        if (not isinstance(action, str) or action not in FIELDS or not isinstance(body, dict)
                or set(body) != FIELDS[action]):
            raise Error(400, "ocserv_invalid", "Проверьте параметры запроса VPN.")
        if action == "state":
            return
        if type(body["revision"]) is not int or body["revision"] != self.revision():
            raise Error(409, "ocserv_conflict", "Состояние VPN изменилось. Обновите страницу.")
        label(body["actor"], 256, "администратор")

    def mutate(self, action, body, pool, now, managed_certificates=False):
        """Durably record intent and identities whose active sessions must be invalidated."""
        actor = body["actor"]
        affected = []
        if action == "profile":
            target = token(body["id"], PROFILE, "профиля")
            name = label(body["name"], 128, "название")
            routes = networks(body["networks"], pool)
            current = self.db.execute("SELECT networks FROM profiles WHERE id=?", (target,)).fetchone()
            if not current and self.db.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] >= 128:
                raise invalid("Достигнут предел в 128 профилей.")
            if current and set(json.loads(current["networks"])) != set(routes):
                affected = [r[0] for r in self.db.execute("SELECT subject FROM grants WHERE profile_id=? AND revoked=0", (target,))]
            self.db.execute("""INSERT INTO profiles VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET
                               name=excluded.name, networks=excluded.networks""", (target, name, json.dumps(routes)))
        elif action in ("grant", "revoke"):
            target = token(body["subject"], SUBJECT, "сотрудника")
            current = self.grant(target)
            if action == "grant":
                profile = token(body["profile_id"], PROFILE, "профиля")
                if not self.db.execute("SELECT 1 FROM profiles WHERE id=?", (profile,)).fetchone():
                    raise Error(404, "ocserv_profile", "Профиль доступа не найден.")
                name = label(body["display_name"], 128, "имя")
                end = deadline(body["expires_at"], now)
                if not current and self.db.execute("SELECT COUNT(*) FROM grants").fetchone()[0] >= 2048:
                    raise invalid("Достигнут предел в 2048 назначений.")
                if not current or current["revoked"] or (profile, end) != (current["profile_id"], current["end"]):
                    affected.append(target)
                self.db.execute("""INSERT INTO grants VALUES (?,?,?,?,0) ON CONFLICT(subject) DO UPDATE SET
                    display_name=excluded.display_name,profile_id=excluded.profile_id,end=excluded.end,revoked=0""",
                    (target, name, profile, end))
                if managed_certificates and (not current or current["revoked"] or current["end"] and current["end"] <= now):
                    self.db.execute("UPDATE certificate_names SET current=0 WHERE subject=?", (target,))
                    self.ensure_certificate_names()
                    if target not in affected:
                        affected.append(target)
            else:
                if not current:
                    raise Error(404, "ocserv_grant", "Назначение доступа не найдено.")
                self.db.execute("UPDATE grants SET revoked=1 WHERE subject=?", (target,))
                affected.append(target)
        else:
            raise ValueError("Unknown policy mutation")
        self.db.executemany("INSERT OR IGNORE INTO pending VALUES (?)", [(s,) for s in affected])
        self.audit(action, target, actor, now)

    def audit(self, action, target, actor, now):
        self.db.execute("INSERT INTO events(at,actor,action,subject) VALUES (?,?,?,?)", (stamp(now), actor, action, target))
        self.db.execute("DELETE FROM events WHERE seq <= (SELECT MAX(seq)-1000 FROM events)")
        self.db.execute("UPDATE meta SET revision=revision+1")

    def snapshot(self, now, managed_certificates=False):
        profiles = [{"id": r["id"], "name": r["name"], "networks": json.loads(r["networks"])}
                    for r in self.db.execute("SELECT * FROM profiles ORDER BY name,id")]
        grants = []
        pending = self.pending()
        for r in self.db.execute("""SELECT g.*, c.cn FROM grants g LEFT JOIN certificate_names c
                                    ON c.subject=g.subject AND c.current=1 ORDER BY g.display_name,g.subject"""):
            active = r["revoked"] == 0 and (not r["end"] or r["end"] > now)
            status = "pending" if r["subject"] in pending else "active" if active else "revoked" if r["revoked"] == 1 else "expired"
            grants.append({"subject": r["subject"], "display_name": r["display_name"], "profile_id": r["profile_id"],
                           "expires_at": stamp(r["end"]) if r["end"] else "", "status": status})
            if managed_certificates and status == "active":
                grants[-1]["certificate_subject"] = r["cn"]
        events = [dict(r) for r in self.db.execute("SELECT at,actor,action,subject FROM events ORDER BY seq DESC LIMIT 100")]
        return {"revision": self.revision(), "profiles": profiles, "grants": grants, "events": events}
