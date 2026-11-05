from __future__ import annotations

import re


MAX_LINE_CHARS = 4096
MAX_LOG_CHARS = 128 * 1024

_ANSI_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_TELEGRAM_TOKEN_RE = re.compile(r"(?<!\d)\d{6,12}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])")
_BEARER_RE = re.compile(r"(?i)(\bauthorization\s*[:=]\s*bearer\s+)[^\s,;]+")
_SECRET_KV_RE = re.compile(
    r"(?i)(\b(?:password|passwd|token|api[_-]?key|secret|bot[_-]?token)\b\s*[:=]\s*)"
    r"([^\s,;]+)"
)
_URL_CREDENTIAL_RE = re.compile(r"(https?://[^\s:/@]+:)[^\s/@]+(@)", re.IGNORECASE)


def sanitize_text(value: str) -> str:
    value = _ANSI_RE.sub("", value)
    value = _CONTROL_RE.sub("", value)
    value = _TELEGRAM_TOKEN_RE.sub("[REDACTED]", value)
    value = _BEARER_RE.sub(r"\1[REDACTED]", value)
    value = _SECRET_KV_RE.sub(r"\1[REDACTED]", value)
    return _URL_CREDENTIAL_RE.sub(r"\1[REDACTED]\2", value)


def sanitize_log_lines(raw: str, *, limit: int = 50) -> list[str]:
    # splitlines() also handles CRLF and prevents control characters from
    # smuggling fake lines into the UI or journal.
    lines = raw.splitlines()[-limit:]
    result: list[str] = []
    used = 0
    for line in lines:
        clean = sanitize_text(line)[:MAX_LINE_CHARS]
        remaining = MAX_LOG_CHARS - used
        if remaining <= 0:
            break
        clean = clean[:remaining]
        result.append(clean)
        used += len(clean)
    return result
