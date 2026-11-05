from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class Finding:
    category: str
    key: str
    severity: str
    subject: str
    summary: str
    details: dict[str, Any] = field(default_factory=dict)

    @property
    def fingerprint(self) -> str:
        value = f"{self.category}:{self.key}".encode()
        return hashlib.sha256(value).hexdigest()

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["fingerprint"] = self.fingerprint
        return result


@dataclass
class MonitoringSnapshot:
    collected_at: datetime
    window_start: datetime
    window_end: datetime
    scope: str = "central"
    branch: str | None = None
    findings: list[Finding] = field(default_factory=list)
    collector_errors: dict[str, str] = field(default_factory=dict)
    successful_categories: set[str] = field(default_factory=set)
    successful_collectors: set[str] = field(default_factory=set)
    statistics: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    history: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "collected_at": self.collected_at.isoformat(),
            "window_start": self.window_start.isoformat(),
            "window_end": self.window_end.isoformat(),
            "scope": self.scope,
            "branch": self.branch,
            "findings": [finding.to_dict() for finding in self.findings],
            "collector_errors": self.collector_errors,
            "successful_categories": sorted(self.successful_categories),
            "successful_collectors": sorted(self.successful_collectors),
            "statistics": self.statistics,
            "history": self.history,
        }
