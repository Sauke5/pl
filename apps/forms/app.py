"""PL Forms: a bounded, signed gateway application around a private HeyForm engine."""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from gateway import GatewayError, GatewayVerifier, MAX_BODY

ROOT = Path(__file__).parent
ID = re.compile(r"[a-z0-9_]{1,32}\Z")
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z")
MAX_RESPONSE = 4 * 1024 * 1024
LOG = logging.getLogger("forms")


class Error(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def text(value, limit, required=True):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise Error("Проверьте текстовые поля и их длину.")
    if any(ord(c) < 32 and c not in "\n\t" for c in value):
        raise Error("Недопустимые символы в тексте.")
    return value.strip()


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise Error("Недопустимый идентификатор.")
    return value


def definition(raw):
    if (isinstance(raw, dict) and raw.get("schema_version") == "1.0"
            and raw.get("kind") == "entertainment_personality"):
        from json_import import to_platform
        try:
            raw = to_platform(raw)
        except ValueError:
            raise Error("Исходный JSON содержит неподдерживаемые настройки или некорректные данные.") from None
    if not isinstance(raw, dict) or set(raw) - {"schema", "title", "description", "kind", "questions", "outcomes", "scoring", "presentation", "analytics"}:
        raise Error("Некорректная анкета.")
    if raw.get("schema", "pl.forms/v1") != "pl.forms/v1":
        raise Error("Неподдерживаемая версия формата анкеты.")
    kind = raw.get("kind")
    if kind not in {"poll", "quiz"}:
        raise Error("Выберите тип анкеты.")
    outcomes = raw.get("outcomes", [])
    if not isinstance(outcomes, list) or not (2 <= len(outcomes) <= 12 if kind == "quiz" else len(outcomes) == 0):
        raise Error("Тест должен содержать от 2 до 12 результатов.")
    normalized_outcomes = []
    for outcome in outcomes:
        if not isinstance(outcome, dict) or set(outcome) - {"id", "title", "description"}:
            raise Error("Некорректный результат теста.")
        normalized_outcomes.append({"id": identifier(outcome.get("id")), "title": text(outcome.get("title"), 120),
                                    "description": text(outcome.get("description", ""), 2000, False)})
    outcome_ids = {o["id"] for o in normalized_outcomes}
    if len(outcome_ids) != len(outcomes):
        raise Error("Идентификаторы результатов повторяются.")
    presentation = None
    if "presentation" in raw:
        presentation = raw["presentation"]
        expected = {"question_order": "fixed", "shuffle_options": "once_per_attempt",
                    "shuffle_tie_options": "once_when_tie_question_appears", "allow_back": True}
        if isinstance(presentation, dict) and presentation.get("shuffle_options") == "none":
            expected["shuffle_options"] = "none"
        if (not isinstance(presentation, dict) or set(presentation) != set(expected)
                or any(type(presentation[key]) is not type(value) or presentation[key] != value
                       for key, value in expected.items())):
            raise Error("Неподдерживаемые настройки показа вопросов.")
        presentation = dict(presentation)
    scoring = None
    if "scoring" in raw:
        scoring = raw["scoring"]
        if (kind != "quiz" or not isinstance(scoring, dict)
                or set(scoring) - {"tie_break", "close_secondary_gap"} or "tie_break" not in scoring):
            raise Error("Некорректные настройки результата теста.")
        gap = scoring.get("close_secondary_gap", 2)
        if type(gap) is not int or not 0 <= gap <= 10:
            raise Error("Разница для второго результата должна быть целым числом от 0 до 10.")
        tie = scoring["tie_break"]
        if not isinstance(tie, dict) or set(tie) != {"title", "options"} or not isinstance(tie["options"], list):
            raise Error("Некорректный вопрос при равенстве результатов.")
        tie_options = []
        for option in tie["options"]:
            if not isinstance(option, dict) or set(option) != {"outcome_id", "label"}:
                raise Error("Некорректный вариант уточняющего вопроса.")
            tie_options.append({"outcome_id": identifier(option["outcome_id"]),
                                "label": text(option["label"], 1000)})
        if len(tie_options) != len(outcome_ids) or {o["outcome_id"] for o in tie_options} != outcome_ids:
            raise Error("Для каждого результата нужен ровно один вариант уточняющего вопроса.")
        scoring = {"tie_break": {"title": text(tie["title"], 1000), "options": tie_options},
                   "close_secondary_gap": gap}
    questions = raw.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 60:
        raise Error("Добавьте от 1 до 60 вопросов.")
    normalized_questions = []
    for question in questions:
        if not isinstance(question, dict) or set(question) - {"id", "title", "required", "options", "section", "help", "scale"}:
            raise Error("Некорректный вопрос.")
        options = question.get("options")
        if not isinstance(options, list) or not 2 <= len(options) <= 12:
            raise Error("У вопроса должно быть от 2 до 12 вариантов ответа.")
        if question.get("required", True) is not True:
            raise Error("В этой версии все вопросы обязательные.")
        normalized_options = []
        for option in options:
            if not isinstance(option, dict) or set(option) - {"id", "label", "weights"}:
                raise Error("Некорректный вариант ответа.")
            weights = option.get("weights", {})
            if (not isinstance(weights, dict) or set(weights) - outcome_ids
                    or any(type(v) is not int or not -100 <= v <= 100 for v in weights.values())):
                raise Error("Баллы должны быть целыми числами от −100 до 100.")
            normalized_options.append({"id": identifier(option.get("id")), "label": text(option.get("label"), 500),
                                       "weights": dict(weights)})
        if len({o["id"] for o in normalized_options}) != len(options):
            raise Error("Идентификаторы вариантов повторяются.")
        if len({o["label"] for o in normalized_options}) != len(options):
            raise Error("Варианты ответа должны различаться.")
        normalized_question = {"id": identifier(question.get("id")), "title": text(question.get("title"), 1000),
                               "required": True, "options": normalized_options}
        for key, limit in (("section", 120), ("help", 500)):
            if key in question:
                normalized_question[key] = text(question[key], limit)
        if "scale" in question:
            scale = question["scale"]
            if (not isinstance(scale, dict) or not 2 <= len(scale) <= len(options)
                    or set(scale) - {o["id"] for o in normalized_options}
                    or any(type(value) is not int or not 1 <= value <= 5 for value in scale.values())):
                raise Error("Шкала вопроса должна содержать оценки от 1 до 5 для существующих вариантов.")
            normalized_question["scale"] = dict(scale)
        normalized_questions.append(normalized_question)
    if len({q["id"] for q in normalized_questions}) != len(questions):
        raise Error("Идентификаторы вопросов повторяются.")
    result = {"schema": "pl.forms/v1", "title": text(raw.get("title"), 200),
              "description": text(raw.get("description", ""), 4000, False),
              "kind": kind, "questions": normalized_questions, "outcomes": normalized_outcomes}
    if scoring is not None:
        result["scoring"] = scoring
    if presentation is not None:
        result["presentation"] = presentation
    if "analytics" in raw:
        if kind != "poll":
            raise Error("Настройки аналитики доступны только для опросов.")
        from analytics import normalize_analytics
        try:
            result["analytics"] = normalize_analytics(raw["analytics"], normalized_questions)
        except ValueError as error:
            raise Error(str(error)) from None
    return result


def evaluate(form, answers, tie_break=None):
    if not isinstance(answers, dict) or set(answers) != {q["id"] for q in form["questions"]}:
        raise Error("Ответьте на все вопросы.")
    scores = {o["id"]: 0 for o in form["outcomes"]}
    for question in form["questions"]:
        option = next((o for o in question["options"] if o["id"] == answers[question["id"]]), None)
        if option is None:
            raise Error("Выберите один из предложенных вариантов.")
        for key, weight in option["weights"].items():
            scores[key] += weight
    scoring = form.get("scoring")
    if not scoring:
        if tie_break is not None:
            raise Error("Уточняющий ответ не предусмотрен для этой анкеты.")
        # Legacy quizzes keep the immutable author order for ties.
        return max(form["outcomes"], key=lambda o: scores[o["id"]]) if scores else None
    leaders = [o for o in form["outcomes"] if scores[o["id"]] == max(scores.values())]
    if tie_break is not None and (len(leaders) == 1 or not isinstance(tie_break, str)
                                  or tie_break not in {o["id"] for o in leaders}):
        raise Error("Выберите один из предложенных уточняющих вариантов.")
    if len(leaders) > 1 and tie_break is None:
        leader_ids = {o["id"] for o in leaders}
        return {"tie_break": {"title": scoring["tie_break"]["title"], "options": [
            {"id": o["outcome_id"], "label": o["label"]} for o in scoring["tie_break"]["options"]
            if o["outcome_id"] in leader_ids]}}
    winner = next(o for o in leaders if tie_break is None or o["id"] == tie_break)
    secondary = None
    if len(leaders) == 2:
        secondary = next(o for o in leaders if o["id"] != winner["id"])
    elif len(leaders) == 1:
        remaining = [o for o in form["outcomes"] if o["id"] != winner["id"]]
        second_score = max(scores[o["id"]] for o in remaining)
        runners_up = [o for o in remaining if scores[o["id"]] == second_score]
        gap = scores[winner["id"]] - second_score
        if len(runners_up) == 1 and 1 <= gap <= scoring["close_secondary_gap"]:
            secondary = runners_up[0]
    return {**winner, "secondary": copy.deepcopy(secondary)}


class Application:
    def __init__(self, database, engine):
        self.database, self.engine = str(database), engine
        self.lock = threading.RLock()
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript("""
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS surveys (
                id TEXT PRIMARY KEY, definition TEXT NOT NULL, status TEXT NOT NULL,
                version INTEGER NOT NULL, engine_id TEXT, created REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS submissions (
                id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, digest TEXT NOT NULL,
                answers TEXT NOT NULL, result TEXT NOT NULL, state TEXT NOT NULL,
                created REAL NOT NULL, FOREIGN KEY(survey_id) REFERENCES surveys(id));
              CREATE INDEX IF NOT EXISTS submissions_survey ON submissions(survey_id,state);
              CREATE TABLE IF NOT EXISTS actions (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS authoring_audit (
                id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
                survey_id TEXT NOT NULL, created REAL NOT NULL);
            """)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.database, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, survey_id):
        with self.db() as db:
            row = db.execute("SELECT * FROM surveys WHERE id=?", (survey_id,)).fetchone()
        if not row:
            raise Error("Анкета не найдена.", 404)
        return {**json.loads(row["definition"]), "id": row["id"], "status": row["status"],
                "version": row["version"], "engine_id": row["engine_id"]}

    @staticmethod
    def visible(form, admin):
        value = copy.deepcopy(form)
        value.pop("engine_id", None)
        if not admin:
            value.pop("outcomes", None)
            value.pop("scoring", None)
            value.pop("analytics", None)
            for question in value["questions"]:
                for option in question["options"]:
                    option.pop("weights", None)
        return value

    def results(self, form, filters=None):
        from analytics import analyze
        with self.db() as db:
            rows = db.execute("SELECT answers,result FROM submissions WHERE survey_id=? AND state='confirmed'", (form["id"],))
            pending = db.execute("SELECT count(*) FROM submissions WHERE survey_id=? AND state!='confirmed'", (form["id"],)).fetchone()[0]
            try:
                return analyze(form, ((json.loads(row["answers"]), json.loads(row["result"])) for row in rows), filters, pending)
            except ValueError as error:
                raise Error(str(error)) from None

    def respond(self, survey_id, body):
        with self.lock:
            form = self.get(survey_id)
            required = {"version", "answers", "submission_id"}
            if (not isinstance(body, dict) or not required <= set(body)
                    or set(body) - required - {"tie_break"}
                    or ("tie_break" in body and not isinstance(body["tie_break"], str))):
                raise Error("Некорректный ответ.")
            submission_id = body["submission_id"]
            if not isinstance(submission_id, str) or not UUID.fullmatch(submission_id):
                raise Error("Некорректный идентификатор отправки.")
            if type(body["version"]) is not int or body["version"] != form["version"]:
                raise Error("Версия анкеты изменилась. Откройте её заново.", 409)
            outcome = evaluate(form, body["answers"], body.get("tie_break"))
            digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            with self.db() as db:
                existing = db.execute("SELECT * FROM submissions WHERE id=?", (submission_id,)).fetchone()
                if existing:
                    if existing["digest"] != digest or existing["survey_id"] != survey_id:
                        raise Error("Идентификатор отправки уже использован для другого ответа.", 409)
                    if existing["state"] == "confirmed":
                        return {"saved": True, "outcome": json.loads(existing["result"])}
            # A closed form accepts neither a first response nor a retry of an unconfirmed response.
            if form["status"] != "published":
                raise Error("Приём ответов для этой анкеты закрыт.", 409)
            if outcome is not None and "tie_break" in outcome:
                return {"saved": False, "tie_break": outcome["tie_break"]}
            if existing:
                if self.engine.reconcile(form["engine_id"], submission_id):
                    with self.db() as db:
                        db.execute("UPDATE submissions SET state='confirmed' WHERE id=?", (submission_id,))
                    return {"saved": True, "outcome": outcome}
                raise Error("Статус отправки пока не подтверждён. Не создавайте новый ответ; повторите проверку позже.", 503)
            with self.db() as db:
                db.execute("INSERT INTO submissions VALUES (?,?,?,?,?,?,?)", (submission_id, survey_id, digest,
                           json.dumps(body["answers"]), json.dumps(outcome), "pending", time.time()))
            # The durable journal precedes the remote call. An ambiguous failure is never blindly resent.
            try:
                self.engine.submit(form["engine_id"], submission_id, form, body["answers"])
            except Exception as error:
                from engine import EngineError, EngineSubmissionUnknown
                if isinstance(error, EngineError) and not isinstance(error, EngineSubmissionUnknown):
                    # Engine guarantees these errors occurred before completeSubmission dispatch.
                    with self.db() as db:
                        db.execute("DELETE FROM submissions WHERE id=? AND state='pending'", (submission_id,))
                raise
            with self.db() as db:
                db.execute("UPDATE submissions SET state='confirmed' WHERE id=?", (submission_id,))
            return {"saved": True, "outcome": outcome}

    def handle(self, method, path, claims, body, idem=""):
        admin = claims["admin"]
        if path == "/forms/api/v1/context":
            return {"name": claims["name"], "admin": admin, "csrf_token": claims["csrf_token"]}
        base = "/forms/api/v1/surveys"
        if method == "GET" and path == base:
            with self.db() as db:
                rows = db.execute("SELECT id FROM surveys WHERE ? OR status='published' ORDER BY created DESC LIMIT 100", (admin,)).fetchall()
            forms = [self.get(row["id"]) for row in rows]
            return {"surveys": [{k: f[k] for k in ("id", "title", "description", "kind", "status", "version")} |
                                {"question_count": len(f["questions"])} for f in forms]}
        parts = path[len(base):].strip("/").split("/") if path.startswith(base) else []
        survey_id = parts[0] if parts and parts[0] else None
        if survey_id:
            identifier(survey_id)
        if method == "GET":
            form = self.get(survey_id)
            if len(parts) == 2 and parts[1] == "results":
                if not admin:
                    raise Error("Результаты доступны администратору.", 403)
                return self.results(form)
            if form["status"] != "published" and not admin:
                raise Error("Анкета не найдена.", 404)
            return self.visible(form, admin)
        if len(parts) == 2 and parts[1] == "responses":
            return self.respond(survey_id, body)
        if len(parts) == 2 and parts[1] == "results":
            if not admin:
                raise Error("Результаты доступны администратору.", 403)
            if (not isinstance(body, dict) or set(body) != {"filters"}
                    or not isinstance(body["filters"], dict)):
                raise Error("Укажите фильтры выборки.")
            return self.results(self.get(survey_id), body["filters"])
        if not admin:
            raise Error("Это действие доступно администратору.", 403)
        digest = hashlib.sha256(json.dumps([method, path, body], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.lock, self.db() as db:
            old = db.execute("SELECT * FROM actions WHERE id=?", (idem,)).fetchone()
            if old:
                if old["digest"] != digest:
                    raise Error("Идентификатор операции уже использован.", 409)
                return json.loads(old["result"])
            if method == "POST" and path == base:
                if db.execute("SELECT count(*) FROM surveys").fetchone()[0] >= 100:
                    raise Error("Достигнут предел в 100 анкет. Обратитесь к администратору.", 409)
                data, survey_id = definition(body), uuid.uuid4().hex
                db.execute("INSERT INTO surveys VALUES (?,?, 'draft',1,NULL,?)", (survey_id, json.dumps(data), time.time()))
            elif method == "PUT":
                form = self.get(survey_id)
                if form["status"] != "draft":
                    raise Error("Опубликованную анкету нельзя изменять. Создайте новую.", 409)
                data = definition(body)
                db.execute("UPDATE surveys SET definition=?,version=version+1 WHERE id=?", (json.dumps(data), survey_id))
            else:
                form = self.get(survey_id)
                if body != {}:
                    raise Error("Действие не принимает дополнительные параметры.")
                if parts[1] == "publish":
                    if form["status"] == "draft":
                        # Deterministic engine name lets ensure_form reconcile after a lost create reply.
                        engine_id = self.engine.ensure_form(form)
                    elif form["status"] == "closed":
                        engine_id = form["engine_id"]
                        self.engine.reopen_form(engine_id)
                    else:
                        raise Error("Анкета уже принимает ответы.", 409)
                    db.execute("UPDATE surveys SET status='published',engine_id=? WHERE id=?", (engine_id, survey_id))
                elif parts[1] == "close":
                    if form["status"] != "published":
                        raise Error("Анкета уже закрыта или ещё не опубликована.", 409)
                    self.engine.close_form(form["engine_id"])
                    db.execute("UPDATE surveys SET status='closed' WHERE id=?", (survey_id,))
            row = db.execute("SELECT * FROM surveys WHERE id=?", (survey_id,)).fetchone()
            result = {**json.loads(row["definition"]), "id": row["id"], "status": row["status"], "version": row["version"]}
            db.execute("INSERT INTO actions VALUES (?,?,?)", (idem, digest, json.dumps(result)))
            db.execute("INSERT INTO authoring_audit(actor,action,survey_id,created) VALUES (?,?,?,?)",
                       (claims["sub"], method + " " + path, survey_id, time.time()))
            return result


def route(method, path):
    if method in {"GET", "HEAD"} and path in {"/forms/", "/forms/index.html", "/forms/app.js", "/forms/styles.css", "/forms/theme.js"}:
        return "forms:read"
    if method == "GET" and path in {"/forms/api/v1/context", "/forms/api/v1/surveys"}:
        return "forms:read"
    match = re.fullmatch(r"/forms/api/v1/surveys/([a-z0-9]{1,32})(?:/(responses|results|publish|close))?", path)
    if method == "POST" and path == "/forms/api/v1/surveys":
        return "forms:admin"
    if not match:
        raise Error("Маршрут не найден.", 404)
    action = match[2]
    if (method == "GET" and not action):
        return "forms:read"
    if method == "POST" and action == "responses":
        return "forms:respond"
    if (method == "PUT" and not action) or (method == "GET" and action == "results") or (method == "POST" and action in {"publish", "close", "results"}):
        return "forms:admin"
    raise Error("Метод не разрешён.", 405)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PlForms"

    def log_message(self, *_):
        pass  # No identity, answer body, submission token or signed header in access logs.

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def send(self, status, body, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def request(self):
        try:
            if self.path == "/health" and self.command == "GET":
                return self.send(200, b'{"status":"ok"}')
            if self.path == "/ready" and self.command == "GET":
                with self.server.application.db() as db:
                    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                        raise Error("База форм недоступна.", 503)
                self.server.application.engine.ready()
                return self.send(200, json.dumps({"status": "ready", "database": "ok", "engine": "connected",
                    "version": os.environ.get("FORMS_VERSION", "development")}).encode())
            if "?" in self.path or not self.path.isascii():
                raise Error("Параметры запроса не поддерживаются.")
            required = route(self.command, self.path)
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) > 1 or "Transfer-Encoding" in self.headers:
                self.close_connection = True
                raise Error("Некорректное тело запроса.")
            length = int(lengths[0]) if lengths else 0
            if length < 0 or length > MAX_BODY:
                self.close_connection = True
                raise Error("JSON-запрос превышает 3 МиБ.", 413)
            raw = self.rfile.read(length)
            if len(raw) != length:
                self.close_connection = True
                raise Error("Неполное тело запроса.")
            scope = {"method": self.command, "raw_path": self.path.encode("ascii"), "query_string": b"",
                     "headers": [(k.lower().encode("ascii"), v.encode("latin1")) for k, v in self.headers.raw_items()]}
            claims = self.server.verifier.verify(scope, raw, required_scope=required)
            if self.path.startswith("/forms/api/"):
                body = None
                idem = self.headers.get("Idempotency-Key", "")
                if self.command not in {"GET", "HEAD"}:
                    if not UUID.fullmatch(idem):
                        raise Error("Требуется уникальный идентификатор операции.")
                    if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                        raise Error("Ожидается JSON.", 415)
                    body = json.loads(raw, object_pairs_hook=unique_json)
                result = self.server.application.handle(self.command, self.path, claims, body, idem)
                data = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()
                if len(data) > MAX_RESPONSE:
                    raise Error("Ответ слишком большой.", 503)
                self.send(200, data)
            else:
                name = "index.html" if self.path == "/forms/" else self.path.removeprefix("/forms/")
                types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}
                self.send(200, (ROOT / "static" / name).read_bytes(), types[Path(name).suffix])
        except GatewayError as error:
            self.send(error.status, json.dumps({"error": "Сессия Платформы или права доступа не подтверждены."}, ensure_ascii=False).encode())
        except Error as error:
            self.send(error.status, json.dumps({"error": error.message}, ensure_ascii=False).encode())
        except (ValueError, UnicodeError):
            self.send(400, json.dumps({"error": "Некорректные данные запроса."}, ensure_ascii=False).encode())
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception as error:
            LOG.error("request_failed class=%s", type(error).__name__)
            self.send(503, json.dumps({"error": "Сервис временно недоступен. Сохраните введённые данные и повторите запрос."}, ensure_ascii=False).encode())

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = request


def unique_json(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate key")
        value[key] = item
    return value


def main():
    from engine import Engine
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    key = Path(os.environ["FORMS_GATEWAY_KEY_FILE"]).read_bytes()
    application = Application(os.environ.get("FORMS_DATABASE", "/data/forms.sqlite3"), Engine())
    server = ThreadingHTTPServer((os.environ.get("FORMS_BIND", "0.0.0.0"), int(os.environ.get("FORMS_PORT", "8091"))), Handler)
    server.verifier, server.application = GatewayVerifier(key), application
    LOG.info("forms_started")
    server.serve_forever()


if __name__ == "__main__":
    main()
