import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from inventory_service.app import InventoryApp, ImportJobs, parse_upload, APIError
from test_gateway import KEY, signed_request
PREVIEW_ID = "12345678-1234-1234-1234-123456789012"


class FakeStore:
    def __init__(self):
        self.previews = []
        self.commits = []

    def bootstrap_page(self, page=1, revision=None):
        return {"dataset": {}, "page": page, "next_page": None, "revision": "a" * 64}

    def software_page(self, params):
        return {"rows": [], "total": 0, "page": int(params.get("page", 1)), "limit": int(params.get("limit", 25))}

    def list_imports(self):
        return []

    def preview(self, parsed, actor):
        self.previews.append((parsed, actor))
        return {"token": PREVIEW_ID, "branch": "TEST", "counts": {"machines": 2}}

    def commit(self, token, actor):
        self.commits.append((token, actor))
        return {"imported": True, "branch": "TEST"}


class FakeImporter:
    @staticmethod
    def parse(workbook, archive, **kwargs):
        assert workbook.read_bytes() == b"workbook-data"
        assert archive.read_bytes() == b"zip-data"
        return {"metadata": kwargs, "dataset": {"windows": []}, "fingerprint": "example"}


def multipart(boundary="test-boundary", duplicate=False):
    pieces = []
    fields = [("workbook", "branch_Admin.xlsx", b"workbook-data"), ("archive", "branch_Source.zip", b"zip-data")]
    if duplicate:
        fields.append(fields[0])
    for name, filename, body in fields:
        pieces.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + body + b"\r\n")
    return b"".join(pieces) + f"--{boundary}--\r\n".encode(), "multipart/form-data; boundary=" + boundary


async def call(app, scope, body=b""):
    sent = []
    requested = False
    async def receive():
        nonlocal requested
        if requested:
            return {"type": "http.disconnect"}
        requested = True
        return {"type": "http.request", "body": body, "more_body": False}
    async def send(message):
        sent.append(message)
    await app(scope, receive, send)
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    response = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, json.loads(response) if response else None


class APITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = FakeStore()
        self.app = InventoryApp(self.directory.name, key=KEY, store=self.store, importer=FakeImporter)

    def tearDown(self):
        self.app.jobs.close()
        self.directory.cleanup()

    def request(self, method="GET", path="/inventory/api/data", body=b"", content_type="", **kwargs):
        scope, _ = signed_request(method, path, body, content_type, **kwargs)
        return asyncio.run(call(self.app, scope, body))

    def test_employee_read_empty_dataset_and_anonymous_denied(self):
        status, data = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(data["dataset"]["software"], [])
        scope, _ = signed_request()
        scope["headers"] = []
        status, _ = asyncio.run(call(self.app, scope))
        self.assertEqual(status, 401)
        status, data = self.request(path="/inventory/api/session")
        self.assertEqual(status, 200)
        self.assertFalse(data["user"]["admin"])

    def test_shared_shell_asset_requires_a_signed_session(self):
        async def read_asset(scope):
            sent = []
            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}
            async def send(message):
                sent.append(message)
            await self.app(scope, receive, send)
            start = next(item for item in sent if item["type"] == "http.response.start")
            body = b"".join(item.get("body", b"") for item in sent if item["type"] == "http.response.body")
            return start, body

        path = "/inventory/static/shared-shell.js"
        scope, _ = signed_request("GET", path)
        start, body = asyncio.run(read_asset(scope))
        self.assertEqual(start["status"], 200)
        self.assertIn(b"window.PLUI.createShell", body)
        self.assertIn((b"content-type", b"application/javascript; charset=utf-8"), start["headers"])
        scope, _ = signed_request("GET", path)
        scope["headers"] = []
        start, _ = asyncio.run(read_asset(scope))
        self.assertEqual(start["status"], 401)

    def test_preview_poll_commit_and_boundary_independent_retry(self):
        body, ctype = multipart()
        status, job = self.request("POST", "/inventory/api/imports/preview", body, ctype, idempotency_key="stable-key")
        self.assertEqual(status, 202)
        for _ in range(100):
            status, polled = self.request(path="/inventory/api/jobs/" + job["job_id"])
            if polled["status"] in {"succeeded", "failed"}:
                break
            time.sleep(.01)
        self.assertEqual(polled["status"], "succeeded")
        self.assertEqual(polled["result"]["preview_id"], PREVIEW_ID)
        body2, ctype2 = multipart("other-boundary")
        _, retry = self.request("POST", "/inventory/api/imports/preview", body2, ctype2, idempotency_key="stable-key")
        self.assertEqual(retry["job_id"], job["job_id"])
        self.assertEqual(len(self.store.previews), 1)
        status, _ = self.request("POST", "/inventory/api/imports/" + PREVIEW_ID + "/commit", b"{}", "application/json", idempotency_key="commit-key")
        self.assertEqual(status, 200)
        self.assertEqual(len(self.store.commits), 1)
        self.assertFalse(list((Path(self.directory.name) / "jobs").glob("upload-*")))

    def test_different_user_cannot_read_private_job(self):
        body, ctype = multipart()
        _, job = self.request("POST", "/inventory/api/imports/preview", body, ctype, idempotency_key="actor-key")
        status, _ = self.request(path="/inventory/api/jobs/" + job["job_id"], actor="ad:other")
        self.assertEqual(status, 404)

    def test_missing_archive_config_fails_job_without_preview_or_publication(self):
        from inventory_service.importer import Importer
        self.app.jobs.importer = Importer
        body, content_type = multipart()
        with patch.dict("os.environ", {}, clear=True):
            status, job = self.request("POST", "/inventory/api/imports/preview", body,
                                       content_type, idempotency_key="missing-password-config")
            self.assertEqual(status, 202)
            for _ in range(100):
                status, result = self.request(path="/inventory/api/jobs/" + job["job_id"])
                if result["status"] == "failed":
                    break
                time.sleep(.01)
        self.assertEqual(result["error"], "archive_password_not_configured")
        self.assertIn("не настроена", result["message"])
        self.assertEqual(self.store.previews, [])
        self.assertEqual(self.store.commits, [])

    def test_csrf_limit_invalid_multipart_and_static_allowlist(self):
        body, ctype = multipart()
        scope, _ = signed_request("POST", "/inventory/api/imports/preview", body, ctype, idempotency_key="key")
        scope["headers"] = [(k, v) for k, v in scope["headers"] if k != b"x-csrf-token"]
        status, _ = asyncio.run(call(self.app, scope, body))
        self.assertEqual(status, 403)
        status, _ = self.request("POST", "/inventory/api/imports/preview", b"bad", "text/plain", idempotency_key="key")
        self.assertEqual(status, 400)
        status, _ = self.request(path="/inventory/static/../../data/jobs.json")
        self.assertEqual(status, 404)
        self.app.max_upload = 1
        status, _ = self.request("POST", "/inventory/api/imports/preview", body, ctype, idempotency_key="key")
        self.assertEqual(status, 413)

    def test_multipart_duplicate_fields_and_paths(self):
        body, ctype = multipart(duplicate=True)
        with self.assertRaises(APIError):
            parse_upload(ctype, body)
        body, ctype = multipart()
        with self.assertRaises(APIError):
            parse_upload(ctype, body.replace(b"branch_Admin.xlsx", b"../escape.xlsx"))

    def test_software_pagination_and_query_allowlist(self):
        status, page = self.request(path="/inventory/api/software?page=2&limit=100&search=Adobe")
        self.assertEqual(status, 200)
        self.assertEqual(page["page"], 2)
        for query in ("limit=101", "page=0", "sort=raw_source", "limit=25&limit=50", "unknown=1", "direction=sideways", "search=" + "a" * 201):
            with self.subTest(query=query):
                status, _ = self.request(path="/inventory/api/software?" + query)
                self.assertEqual(status, 400)

    def test_commit_requires_uuid_and_idempotency_key(self):
        status, _ = self.request("POST", "/inventory/api/imports/" + "x" * 32 + "/commit", b"{}", "application/json", idempotency_key="commit")
        self.assertEqual(status, 404)
        status, _ = self.request("POST", "/inventory/api/imports/" + PREVIEW_ID + "/commit", b"{}", "application/json")
        self.assertEqual(status, 400)

    def test_other_actor_commit_is_forbidden_and_keeps_active_dataset(self):
        from inventory_service.store import Store
        from test_store import parsed
        store = Store(Path(self.directory.name) / "actor-isolation")
        initial = store.preview(parsed(seed="published"), "ad:owner")
        published = store.commit(initial["token"], "ad:owner")
        replacement = store.preview(parsed(seed="replacement", answer="Changed answer"), "ad:owner")
        before = store.dataset()
        self.app.store = store
        status, result = self.request("POST", "/inventory/api/imports/" + replacement["token"] + "/commit", b"{}", "application/json", actor="ad:other", idempotency_key="other-commit")
        self.assertEqual((status, result["error"]), (403, "preview_actor_mismatch"))
        self.assertEqual(store.dataset(), before)
        self.assertEqual([item["id"] for item in store.list_imports()], [published["id"]])
        self.assertEqual(store.bootstrap_page()["dataset"]["questions"][0]["answer"], "Нет лицензии")

    def test_bootstrap_does_not_export_software_and_json_is_bounded(self):
        self.store.bootstrap_page = lambda **kwargs: {"dataset": {"software": ["private-full-table"], "sources": []}, "page": 1, "next_page": None, "revision": "a" * 64}
        status, result = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(result["dataset"]["software"], [])
        self.store.bootstrap_page = lambda **kwargs: {"dataset": {"oversized": "x" * (8 * 1024 * 1024)}}
        status, result = self.request()
        self.assertEqual(status, 413)
        self.assertEqual(result["error"], "response_too_large")

    def test_bootstrap_revision_pagination_and_strict_query(self):
        calls = []
        def page_store(page=1, revision=None):
            calls.append((page, revision))
            if revision and revision != "a" * 64:
                error = ValueError("changed")
                error.code, error.status = "snapshot_changed", 409
                raise error
            return {"dataset": {"sources": [{"name": "branch"}]}, "page": page, "next_page": 2 if page == 1 else None, "revision": "a" * 64}
        self.store.bootstrap_page = page_store
        status, first = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(first["next_page"], 2)
        status, last = self.request(path="/inventory/api/data?page=2&revision=" + first["revision"])
        self.assertEqual(status, 200)
        self.assertIsNone(last["next_page"])
        self.assertEqual(calls, [(1, None), (2, "a" * 64)])
        status, result = self.request(path="/inventory/api/data?page=2&revision=" + "b" * 64)
        self.assertEqual((status, result["error"]), (409, "snapshot_changed"))
        for query in ("page=2", "page=0", "page=10001", "revision=bad", "page=1&page=2", "unknown=1", "revision=" + "a" * 64 + "&revision=" + "a" * 64):
            with self.subTest(query=query):
                status, _ = self.request(path="/inventory/api/data?" + query)
                self.assertEqual(status, 400)

    def test_restart_marks_jobs_interrupted_and_cleans_upload(self):
        jobs = Path(self.directory.name) / "jobs"
        identity = "12345678-1234-1234-1234-123456789012"
        (jobs / (identity + ".json")).write_text(json.dumps({"job_id": identity, "status": "running", "actor": "ad:user", "idempotency_key": "key", "fingerprint": "hash"}))
        (jobs / ("upload-" + identity)).mkdir()
        self.app.jobs.close()
        restarted = ImportJobs(jobs, FakeImporter, self.store)
        try:
            self.assertEqual(restarted.get(identity, "ad:user")["status"], "failed")
            self.assertFalse((jobs / ("upload-" + identity)).exists())
        finally:
            restarted.close()

    def test_development_mode_only_loopback_and_no_assertion_fallback(self):
        dev = InventoryApp(self.directory.name + "/dev", mode="development", store=self.store, importer=FakeImporter)
        try:
            scope, _ = signed_request()
            status, _ = asyncio.run(call(dev, scope))
            self.assertEqual(status, 403)
            scope["headers"] = []
            scope["client"] = ("192.0.2.1", 1)
            status, _ = asyncio.run(call(dev, scope))
            self.assertEqual(status, 403)
            scope["client"] = ("127.0.0.1", 1)
            status, _ = asyncio.run(call(dev, scope))
            self.assertEqual(status, 200)
        finally:
            dev.jobs.close()


if __name__ == "__main__":
    unittest.main()
