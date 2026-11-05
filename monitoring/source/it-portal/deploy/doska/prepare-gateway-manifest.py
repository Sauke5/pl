#!/usr/bin/env python3
"""Convert a reviewed Doska pilot release manifest; no network or provisioning."""
import argparse
from datetime import date
import json
import re
from pathlib import Path

MAX_SOURCE_BYTES = 512 * 1024
ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SUBJECT_ID = re.compile(r"^[A-Za-z0-9:_-]{1,128}$")
DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
PATH = re.compile(r"^/doska/(?:[A-Za-z0-9_.-]+|\{[A-Za-z0-9_]+\}|/)*$")


def fail(message):
    raise ValueError(message)


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("duplicate JSON key")
        result[key] = value
    return result


def keys(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        fail("unknown or missing schema fields")


def path(value):
    if not isinstance(value, str) or len(value) > 1024 or not PATH.fullmatch(value) or ".." in value or "//" in value:
        fail("invalid external path")
    return value


def valid_date(value):
    if not DATE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


PATTERNS = {
    "^[A-Za-z0-9_-]+$": ("id", 128, ID.fullmatch),
    "^[A-Za-z0-9_-]{1,128}$": ("id", 128, ID.fullmatch),
    "^[A-Za-z0-9:_-]{1,128}$": ("subjectid", 128, SUBJECT_ID.fullmatch),
    r"^\d{4}-\d{2}-\d{2}$": ("date", 10, valid_date),
}


def query_rule(schema, required, multiplicity, max_length=1024):
    if type(required) is not bool or type(multiplicity) is not int or multiplicity != 1:
        fail("unsupported query multiplicity")
    keys(schema, {"type", "minimum", "maximum", "default", "minLength", "maxLength", "pattern", "enum"}, {"type"})
    result = {"required": required}
    if schema["type"] == "integer":
        if set(schema) - {"type", "minimum", "maximum", "default"}:
            fail("unsupported integer schema")
        low, high = schema.get("minimum"), schema.get("maximum")
        if type(low) is not int or type(high) is not int or not 0 <= low <= high <= 9223372036854775807:
            fail("integer schema requires bounded nonnegative range")
        result.update(kind="integer", minimum=low, maximum=high)
        if "default" in schema and (type(schema["default"]) is not int or not low <= schema["default"] <= high):
            fail("invalid integer default")
    elif schema["type"] == "string":
        if "minimum" in schema or "maximum" in schema:
            fail("unsupported string range")
        result["kind"] = "text"
        result["allow_empty"] = True
        if "minLength" in schema:
            if type(schema["minLength"]) is not int or schema["minLength"] != 1:
                fail("unsupported query minLength")
            result["allow_empty"] = False
        if "pattern" in schema:
            if schema["pattern"] not in PATTERNS:
                fail("unsupported query pattern")
            kind, max_bytes, _ = PATTERNS[schema["pattern"]]
            result.update(kind=kind, allow_empty=False, max_bytes=max_bytes)
        if "maxLength" in schema:
            n = schema["maxLength"]
            if type(n) is not int or not 1 <= n <= max_length:
                fail("invalid query maxLength")
            result.update(max_chars=n, max_bytes=min(4 * n, 4096))
        if "enum" in schema:
            values = schema["enum"]
            if not isinstance(values, list) or not 1 <= len(values) <= 100 or any(not isinstance(v, str) or not v or len(v.encode()) > 256 for v in values) or len(set(values)) != len(values):
                fail("invalid query enum")
            result.update(enum=values, allow_empty=False)
        if not any(k in schema for k in ("pattern", "maxLength", "enum")):
            fail("unbounded string query")
        if "default" in schema:
            default = schema["default"]
            if not isinstance(default, str) or schema.get("minLength") == 1 and default == "" or "enum" in schema and default not in schema["enum"] or "maxLength" in schema and len(default) > schema["maxLength"] or "pattern" in schema and not PATTERNS[schema["pattern"]][2](default):
                fail("invalid string default")
    else:
        fail("unsupported query schema type")
    return result


ATTACHMENT_BASE = "/doska/api/doska/projects/{id}/tasks/{taskId}"
ATTACHMENT_ROUTES = {
    (method, ATTACHMENT_BASE + suffix): (kind, schema)
    for method, suffix, kind, schema in (
        ("GET", "/attachments", "read", "attachment-list-v1"),
        ("POST", "/attachment-uploads", "write", "attachment-reserve-v1"),
        ("PUT", "/attachment-uploads/{uploadId}/content", "upload", "attachment-content-v1"),
        ("POST", "/attachment-uploads/{uploadId}/finalize", "write", "attachment-finalize-v1"),
        ("DELETE", "/attachment-uploads/{uploadId}", "write", "attachment-empty-v1"),
        ("GET", "/attachments/{attachmentId}/content", "download", "attachment-download-v1"),
        ("DELETE", "/attachments/{attachmentId}", "write", "attachment-empty-v1"),
    )
}
ATTACHMENT_LIST_QUERY = {
    "limit": {"required": False, "kind": "integer", "minimum": 1, "maximum": 100},
    "offset": {"required": False, "kind": "integer", "minimum": 0, "maximum": 10000000},
}


def convert(source, version=None, attachments_candidate=False):
    keys(source, {"status", "source", "webSource", "apiSource", "apiImage", "webImage", "upstreams", "readiness", "pages", "assets", "apiRoutes", "requestBodyLimitBytes", "websockets", "uploads", "nativeRoutes", "rewrite", "directory", "gateway", "bootstrap", "queryLimits", "pageQuery"} | ({"attachments"} if attachments_candidate else set()), {"source", "pages", "assets", "apiRoutes", "requestBodyLimitBytes", "websockets", "uploads", "nativeRoutes", "queryLimits", "pageQuery"})
    for field in ("webSource", "apiSource"):
        if field in source and (not isinstance(source[field], str) or not re.fullmatch(r"(?:[0-9a-f]{8}|[0-9a-f]{40})", source[field])):
            fail("invalid source commit metadata")
    if source["requestBodyLimitBytes"] != 131072 or any(source[k] is not False for k in ("websockets", "nativeRoutes")) or type(source["uploads"]) is not bool or source["uploads"] and not attachments_candidate:
        fail("unsupported pilot capabilities")
    if "attachments" in source:
        metadata = source["attachments"]
        keys(metadata, {"storage", "maxFileBytes", "quotaBytes", "releaseGate"}, {"storage", "maxFileBytes", "quotaBytes", "releaseGate"})
        if type(metadata["maxFileBytes"]) is not int or metadata["maxFileBytes"] != 26214400 or type(metadata["quotaBytes"]) is not int or metadata["quotaBytes"] != 20000000000 or any(not isinstance(metadata[k], str) or not metadata[k] or len(metadata[k].encode()) > 512 for k in ("storage", "releaseGate")):
            fail("invalid attachment candidate metadata")
    if source["queryLimits"] != {"rawBytes": 4096, "duplicateKeys": "reject"}:
        fail("unsupported query limits")
    if version is None:
        if not isinstance(source["source"], str) or not re.fullmatch(r"[0-9a-f]{40}", source["source"]):
            fail("source commit or explicit version required")
        version = "doska-" + source["source"][:12]
    if not isinstance(version, str) or not ID.fullmatch(version):
        fail("invalid manifest version")
    routes, seen = [], set()

    def add(method, external, kind, query):
        external = path(external)
        key = (method, external)
        if key in seen:
            fail("duplicate route")
        seen.add(key)
        route = dict(method=method, path=external, kind=kind)
        if query:
            route["query"] = query
        routes.append(route)

    pages, page_queries = source["pages"], source["pageQuery"]
    if not isinstance(pages, list) or not isinstance(page_queries, dict) or page_queries.get("otherPages", {}) != {} or set(page_queries) - set(pages) - {"otherPages"}:
        fail("invalid page query registry")
    for page in pages:
        if page == "/doska":
            continue  # The gateway owns this fixed redirect.
        query = {}
        for name, rule in page_queries.get(page, {}).items():
            if not ID.fullmatch(name):
                fail("invalid query name")
            keys(rule, {"type", "pattern", "enum", "multiplicity", "required"}, {"type", "multiplicity", "required"})
            query[name] = query_rule({k: rule[k] for k in ("type", "pattern", "enum") if k in rule}, rule["required"], rule["multiplicity"])
        add("GET", page, "page", query)
    if not isinstance(source["assets"], list):
        fail("exact built asset list required")
    for asset in source["assets"]:
        keys(asset, {"path", "bytes", "sha256"}, {"path", "bytes", "sha256"})
        if "{" in asset["path"] or type(asset["bytes"]) is not int or not 1 <= asset["bytes"] <= 16 * 1024 * 1024 or not isinstance(asset["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", asset["sha256"]):
            fail("invalid built asset metadata")
        add("GET", asset["path"], "asset", {})
    if not isinstance(source["apiRoutes"], list):
        fail("API route list required")
    attachment_inputs = set()
    for route in source["apiRoutes"]:
        keys(route, {"method", "external", "upstream", "query", "unknownQueryKeys"} | ({"kind", "schema"} if attachments_candidate else set()), {"method", "external", "upstream", "query", "unknownQueryKeys"})
        method, external = route["method"], route["external"]
        if method not in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE") or not isinstance(external, str) or not external.startswith("/doska/api/doska/") or route["upstream"] != external.removeprefix("/doska") or route["unknownQueryKeys"] != "reject" or not isinstance(route["query"], list):
            fail("unsupported API route or prefix rewrite")
        query = {}
        for rule in route["query"]:
            keys(rule, {"name", "required", "multiplicity", "schema"}, {"name", "required", "multiplicity", "schema"})
            name = rule["name"]
            if not isinstance(name, str) or not ID.fullmatch(name) or name in query:
                fail("invalid or duplicate query name")
            # Only the reviewed task-search field needs a larger text bound.
            # Cursor and all other route/schema limits retain the 1024 ceiling.
            max_length = 2000 if (method, external, name) == ("GET", "/doska/api/doska/task-search", "customFieldValue") else 1024
            query[name] = query_rule(rule["schema"], rule["required"], rule["multiplicity"], max_length)
        if "attachment" in external or "kind" in route or "schema" in route:
            expected = ATTACHMENT_ROUTES.get((method, external))
            if not attachments_candidate or source["uploads"] is not True or expected is None or (route.get("kind"), route.get("schema")) != expected:
                fail("unapproved attachment route/kind/schema")
            expected_query = ATTACHMENT_LIST_QUERY if expected[1] == "attachment-list-v1" else {}
            if query != expected_query:
                fail("invalid attachment query schema")
            attachment_inputs.add((method, external))
            add(method, external, expected[0], query)
            routes[-1]["schema"] = expected[1]
        else:
            add(method, external, "read" if method in ("GET", "HEAD") else "write", query)
    if attachments_candidate:
        if source["uploads"]:
            if attachment_inputs != set(ATTACHMENT_ROUTES):
                fail("attachment candidate requires all seven exact routes")
        else:
            # Backward-compatible explicit local preparation from a closed base.
            # A source already declaring the seven routes is validated above and
            # never appended a second time.
            for (method, external), (kind, schema) in ATTACHMENT_ROUTES.items():
                query = ATTACHMENT_LIST_QUERY if schema == "attachment-list-v1" else {}
                add(method, external, kind, query)
                routes[-1]["schema"] = schema
    if not 1 <= len(routes) <= 1024:
        fail("manifest route bound exceeded")
    return dict(version=version, routes=routes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--version")
    parser.add_argument("--attachments-candidate", action="store_true", help="LOCAL ONLY: validate seven exact input attachment routes, or append them to a closed base; separate opt-in spool config required")
    args = parser.parse_args()
    try:
        with args.source.open("rb") as source_file:
            raw = source_file.read(MAX_SOURCE_BYTES + 1)
        if len(raw) > MAX_SOURCE_BYTES:
            fail("source manifest exceeds bound")
        source = json.loads(raw, object_pairs_hook=unique_pairs)
        result = convert(source, args.version, args.attachments_candidate)
        # Refuse to replace a reviewed artifact accidentally.
        with args.output.open("x", encoding="utf-8") as output:
            json.dump(result, output, ensure_ascii=False, indent=2)
            output.write("\n")
    except (ValueError, TypeError, KeyError, OSError, RecursionError) as error:
        parser.exit(2, f"manifest rejected: {error}\n")


if __name__ == "__main__":
    main()
