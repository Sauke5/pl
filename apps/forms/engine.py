"""Private HeyForm v3.0.5 adapter. No respondent identity crosses this boundary.

Contract source: heyform/heyform tag v3.0.5, server GraphQL resolvers and e2e client.
Submission timeouts are ambiguous: upstream has no idempotent create operation.
The caller must journal before submit and reconcile unknown writes, never resend them.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
from http.cookies import SimpleCookie
from pathlib import Path

MARKER = "pl_submission_id"


class EngineError(RuntimeError):
    """Safe to log: remote payloads and credentials are never included."""


class EngineSubmissionUnknown(EngineError):
    """A submission may have committed; reconcile before deciding its outcome."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Engine:
    def __init__(self, url: str | None = None, credentials_file: str | None = None):
        self.url = (url or os.getenv("HEYFORM_URL", "http://heyform:9157")).rstrip("/")
        parsed = urllib.parse.urlsplit(self.url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment or parsed.path):
            raise EngineError("engine_invalid_origin")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        self.credentials_file = Path(credentials_file or os.getenv(
            "HEYFORM_CREDENTIALS_FILE", "/run/secrets/heyform-service.json"))
        self.workspace = os.getenv("HEYFORM_WORKSPACE_NAME", "PL Forms")
        self.project = os.getenv("HEYFORM_PROJECT_NAME", "Forms")
        self.timeout = float(os.getenv("HEYFORM_TIMEOUT", "15"))
        self.cookies: dict[str, str] = {}
        self.project_id: str | None = None
        self.lock = threading.RLock()

    def _credentials(self):
        try:
            data = json.loads(self.credentials_file.read_text())
            if not all(isinstance(data.get(k), str) and data[k] for k in
                       ("email", "password", "device_id")):
                raise ValueError()
            return data
        except (OSError, ValueError, TypeError) as exc:
            raise EngineError("engine_credentials_unavailable") from None

    def _request(self, query: str, variables: dict | None = None, *, anonymous: bool = False,
                 submission_id: str | None = None):
        credentials = self._credentials()
        headers = {"Content-Type": "application/json", "User-Agent": "PL-Forms-Service/1",
                   "x-device-id": credentials["device_id"]}
        if anonymous:
            # Random submission marker, never Platform account, IP, or browser identity.
            headers["x-anonymous-id"] = submission_id or "pl-forms-service"
        elif self.cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        request = urllib.request.Request(self.url + "/graphql", headers=headers,
            data=json.dumps({"query": query, "variables": variables or {}}).encode())
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                for value in response.headers.get_all("Set-Cookie", []):
                    cookie = SimpleCookie()
                    cookie.load(value)
                    for key, morsel in cookie.items():
                        self.cookies[key] = morsel.value
                payload = json.loads(response.read(4 * 1024 * 1024))
        except urllib.error.HTTPError as error:
            error.close()
            raise EngineError("engine_transport_error") from None
        except (OSError, ValueError, urllib.error.URLError):
            raise EngineError("engine_transport_error") from None
        if payload.get("errors"):
            codes = [str(row.get("code", row.get("extensions", {}).get("code", "")))
                     for row in payload["errors"]]
            if "UNAUTHORIZED" in codes:
                raise EngineError("engine_unauthorized")
            raise EngineError("engine_operation_rejected")
        if not isinstance(payload.get("data"), dict):
            raise EngineError("engine_invalid_response")
        return payload["data"]

    def _login(self):
        c = self._credentials()
        self.cookies.clear()
        self._request("query Login($input:LoginInput!){login(input:$input)}",
                      {"input": {"email": c["email"], "password": c["password"]}})
        if not self.cookies.get("HEYFORM_SESSION"):
            raise EngineError("engine_session_missing")

    def _auth(self, query, variables=None):
        if not self.cookies.get("HEYFORM_SESSION"):
            self._login()
        try:
            return self._request(query, variables)
        except EngineError as exc:
            if str(exc) != "engine_unauthorized":
                raise
            # The AuthGuard rejects before the operation executes, so this retry is safe.
            self._login()
            return self._request(query, variables)

    def _teams(self):
        return self._auth("query{teams{id name projects{id name}}}")["teams"]

    def _project_id(self):
        if not self.project_id:
            matches = [p["id"] for t in self._teams() if t["name"] == self.workspace
                       for p in t["projects"] if p["name"] == self.project]
            if len(matches) != 1:
                raise EngineError("engine_bootstrap_required")
            self.project_id = matches[0]
        return self.project_id

    def bootstrap(self):
        """Explicit operator step: private service account + workspace via native API."""
        with self.lock:
            try:
                self._login()
            except EngineError as exc:
                if str(exc) != "engine_operation_rejected":
                    raise
                c = self._credentials()
                self._request("mutation Signup($input:SignUpInput!){signUp(input:$input)}",
                    {"input": {"email": c["email"], "password": c["password"],
                               "name": c.get("name", "PL Forms Service")}})
            teams = [t for t in self._teams() if t["name"] == self.workspace]
            if not teams:
                self._auth("mutation Team($input:CreateTeamInput!){createTeam(input:$input)}",
                    {"input": {"name": self.workspace, "projectName": self.project}})
            self._project_id()

    def ready(self):
        """Read-only native API validation; cached project IDs never imply health."""
        with self.lock:
            matches = [project["id"] for team in self._teams() if team["name"] == self.workspace
                       for project in team["projects"] if project["name"] == self.project]
            if len(matches) != 1:
                raise EngineError("engine_bootstrap_required")
            return True

    @staticmethod
    def _fields(form):
        fields = []
        for question in form["questions"]:
            fields.append({"id": question["id"], "kind": "multiple_choice",
                "title": [question["title"]],
                "validations": {"required": question.get("required", True)},
                "properties": {"allowMultiple": False, "allowOther": False,
                    "choices": [{"id": o["id"], "label": o["label"]}
                                for o in question["options"]]}})
        fields.append({"id": "pl_complete", "kind": "thank_you", "title": ["Спасибо"]})
        return fields

    def ensure_form(self, local_form: dict) -> str:
        with self.lock:
            project_id = self._project_id()
            # Stable unique private name permits recovery after ambiguous native create timeout.
            name = f"{local_form['title']} [pl:{local_form['id']}]"
            forms = self._auth("query Forms($input:FormsInput!){forms(input:$input){id name}}",
                {"input": {"projectId": project_id, "status": 1}})["forms"]
            matches = [f["id"] for f in forms if f["name"].endswith(f"[pl:{local_form['id']}]")]
            if len(matches) > 1:
                raise EngineError("engine_duplicate_form_mapping")
            form_id = matches[0] if matches else self._auth(
                "mutation Create($input:CreateFormInput!){createForm(input:$input)}",
                {"input": {"projectId": project_id, "name": name, "interactiveMode": 1,
                           "kind": 2 if local_form.get("kind") == "quiz" else 1}})["createForm"]
            detail = self._auth(
                "query Detail($input:FormDetailInput!){formDetail(input:$input){id version}}",
                {"input": {"formId": form_id}})["formDetail"]
            self._auth("mutation Hidden($input:UpdateHiddenFieldsInput!){updateFormHiddenFields(input:$input)}",
                {"input": {"formId": form_id, "hiddenFields": [{"id": MARKER, "name": MARKER}]}})
            self._auth("mutation Settings($input:UpdateFormInput!){updateForm(input:$input)}",
                {"input": {"formId": form_id, "enableEmailNotification": False,
                           "filterSpam": False, "captchaKind": 0, "displayIpAddress": False,
                           "allowArchive": True}})
            self._auth("mutation Publish($input:UpdateFormSchemasInput!){publishForm(input:$input)}",
                {"input": {"formId": form_id, "version": detail["version"] + 1,
                           "drafts": self._fields(local_form), "logics": []}})
            return form_id

    def close_form(self, engine_id: str):
        with self.lock:
            self._auth("mutation Close($input:UpdateFormInput!){updateForm(input:$input)}",
                {"input": {"formId": engine_id, "active": False}})

    def reopen_form(self, engine_id: str):
        with self.lock:
            self._auth("mutation Reopen($input:UpdateFormInput!){updateForm(input:$input)}",
                {"input": {"formId": engine_id, "active": True}})

    def _find_submission(self, engine_id: str, submission_id: str):
        page = 1
        deadline = time.monotonic() + 30
        while True:
            if page > 1000 or time.monotonic() > deadline:
                raise EngineError("engine_reconciliation_limit")
            result = self._auth("""query Submissions($input:SubmissionsInput!){
                submissions(input:$input){total submissions{id answers hiddenFields{id name value}}}}
                """, {"input": {"formId": engine_id, "page": page, "limit": 30}})["submissions"]
            for row in result["submissions"]:
                if any(h["id"] == MARKER and h.get("value") == submission_id
                       for h in (row.get("hiddenFields") or [])):
                    return row
            if page * 30 >= result["total"]:
                return None
            if not result["submissions"]:
                raise EngineError("engine_incomplete_submission_page")
            page += 1

    def reconcile(self, engine_id: str, submission_id: str) -> bool:
        with self.lock:
            return self._find_submission(engine_id, submission_id) is not None

    def submit(self, engine_id: str, submission_id: str, form: dict, answers: dict):
        with self.lock:
            existing = self._find_submission(engine_id, submission_id)
            native_answers = {q["id"]: {"value": [answers[q["id"]]]}
                              for q in form["questions"] if q["id"] in answers}
            if existing:
                stored = {a["id"]: a["value"] for a in existing["answers"]}
                if any(stored.get(key) != value for key, value in native_answers.items()):
                    raise EngineError("engine_submission_conflict")
                return
            token = self._request("query Open($input:OpenFormInput!){openForm(input:$input)}",
                {"input": {"formId": engine_id}}, anonymous=True,
                submission_id=submission_id)["openForm"]
            try:
                self._request("""mutation Complete($input:CompleteSubmissionInput!){
                    completeSubmission(input:$input){clientSecret}}""",
                    {"input": {"formId": engine_id, "openToken": token,
                        "answers": native_answers, "hiddenFields": [{"id": MARKER,
                            "name": MARKER, "value": submission_id}]}},
                    anonymous=True, submission_id=submission_id)
            except EngineError:
                # Even a GraphQL rejection can follow a committed insert (integration enqueue).
                raise EngineSubmissionUnknown("engine_submission_unknown") from None


if __name__ == "__main__":
    import sys
    if sys.argv[1:] != ["bootstrap"]:
        raise SystemExit("Usage: python engine.py bootstrap")
    try:
        Engine().bootstrap()
    except EngineError as error:
        raise SystemExit(str(error)) from None
    print("HeyForm service workspace ready")
