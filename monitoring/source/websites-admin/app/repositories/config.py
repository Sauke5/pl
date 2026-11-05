from __future__ import annotations

import copy
import hashlib
import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq


class ConfigError(RuntimeError):
    pass


class ConcurrentModificationError(ConfigError):
    pass


class DuplicateTargetError(ConfigError):
    pass


class TargetNotFoundError(ConfigError):
    pass


class UnsafeConfigError(ConfigError):
    pass


@dataclass(slots=True)
class WebsiteTarget:
    site_id: str
    url: str
    display_name: str | None
    labels: dict[str, str]
    http_module: str
    content_enabled: bool
    content_module: str | None = None
    fragments: list[str] = field(default_factory=list)
    negative_fragments: list[str] = field(default_factory=list)
    config_error: str | None = None

    @property
    def title(self) -> str:
        return self.display_name or self.url

    def audit_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "display_name": self.display_name,
            "content_enabled": self.content_enabled,
            "fragments": list(self.fragments),
        }


@dataclass(slots=True)
class ConfigDocuments:
    websites: CommentedSeq
    content: CommentedSeq
    blackbox: CommentedMap
    revision: str
    file_hashes: dict[str, str]

    def clone(self) -> ConfigDocuments:
        return ConfigDocuments(
            websites=copy.deepcopy(self.websites),
            content=copy.deepcopy(self.content),
            blackbox=copy.deepcopy(self.blackbox),
            revision=self.revision,
            file_hashes=dict(self.file_hashes),
        )


@dataclass(slots=True)
class ConfigState:
    targets: list[WebsiteTarget]
    revision: str
    global_errors: list[str]

    def by_site_id(self, site_id: str) -> WebsiteTarget:
        for target in self.targets:
            if target.site_id == site_id:
                return target
        raise TargetNotFoundError("Цель не найдена.")

    def by_url(self, url: str) -> WebsiteTarget:
        for target in self.targets:
            if target.url == url:
                return target
        raise TargetNotFoundError("Цель не найдена.")


def _yaml() -> YAML:
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    yaml.width = 4096
    yaml.indent(mapping=2, sequence=4, offset=2)
    return yaml


def deterministic_site_id(url: str) -> str:
    parsed = urlsplit(url)
    source = f"{parsed.hostname or 'site'}{parsed.path.rstrip('/')}"
    slug = re.sub(r"[^a-z0-9]+", "-", source.lower()).strip("-") or "site"
    slug = slug[:42].rstrip("-")
    return f"{slug}-{hashlib.sha256(url.encode('utf-8')).hexdigest()[:8]}"


def deterministic_module_name(url: str, kind: str = "content") -> str:
    prefix = "http_content" if kind == "content" else "http_site"
    return f"{prefix}_{deterministic_site_id(url).replace('-', '_')}"


def escape_fragment(text: str) -> str:
    cleaned = text.strip()
    if not cleaned:
        raise ConfigError("Контрольный фрагмент не может быть пустым.")
    if len(cleaned) > 500:
        raise ConfigError("Контрольный фрагмент длиннее 500 символов.")
    # Blackbox Exporter compiles patterns with Go RE2. Python re.escape()
    # additionally escapes spaces and punctuation which RE2 rejects as an
    # invalid escape sequence, so quote only actual regexp metacharacters.
    metacharacters = frozenset(r"\.+*?()|[]{}^$")
    return "".join(f"\\{character}" if character in metacharacters else character for character in cleaned)


def display_fragment(pattern: str) -> str:
    value = pattern
    value = re.sub(r"^\(\?i\)", "", value)
    value = re.sub(r"^<title\[\^>\]\*>", "", value)
    value = re.sub(r"\\(.)", r"\1", value)
    # Older hand-written modules sometimes wrap the positive expression in
    # <title[^>]*>...</title>.  The opening regexp is removed above before
    # unescaping; strip either remaining literal tag so the UI shows only the
    # operator-facing fragment.
    value = re.sub(r"^<title[^>]*>", "", value, flags=re.IGNORECASE)
    value = re.sub(r"</title>$", "", value, flags=re.IGNORECASE)
    return value.strip() or "Системный контрольный фрагмент"


def _validate_fragments(fragments: Iterable[str], maximum: int = 4) -> list[str]:
    values = [value.strip() for value in fragments if value and value.strip()]
    if not 1 <= len(values) <= maximum:
        raise ConfigError(f"Нужно выбрать от одного до {maximum} контрольных фрагментов.")
    deduplicated: list[str] = []
    for value in values:
        if value not in deduplicated:
            deduplicated.append(value)
    if len(deduplicated) != len(values):
        raise ConfigError("Контрольные фрагменты не должны повторяться.")
    for value in values:
        escape_fragment(value)
    return values


class ConfigRepository:
    STANDARD_NEGATIVE = [
        "(?i)404 Not Found",
        "(?i)Service Unavailable",
        "(?i)403 Forbidden",
        "Доступ к странице запрещен",
        "Whoops, looks like something went wrong",
    ]

    def __init__(self, websites_file: Path, content_file: Path, blackbox_file: Path):
        self.paths = {
            "websites.yml": Path(websites_file),
            "content.yml": Path(content_file),
            "blackbox.yml": Path(blackbox_file),
        }

    def _read(self, name: str) -> tuple[Any, bytes]:
        path = self.paths[name]
        try:
            raw = path.read_bytes()
            document = _yaml().load(raw.decode("utf-8"))
        except Exception as exc:
            raise ConfigError(f"Не удалось прочитать {name}: {exc}") from exc
        return document, raw

    def load_documents(self) -> ConfigDocuments:
        websites, websites_raw = self._read("websites.yml")
        content, content_raw = self._read("content.yml")
        blackbox, blackbox_raw = self._read("blackbox.yml")
        if not isinstance(websites, CommentedSeq):
            raise ConfigError("websites.yml должен содержать список target-групп.")
        if not isinstance(content, CommentedSeq):
            raise ConfigError("content.yml должен содержать список target-групп.")
        if not isinstance(blackbox, CommentedMap) or not isinstance(blackbox.get("modules"), CommentedMap):
            raise ConfigError("blackbox.yml не содержит корректную секцию modules.")
        hashes = {
            "websites.yml": hashlib.sha256(websites_raw).hexdigest(),
            "content.yml": hashlib.sha256(content_raw).hexdigest(),
            "blackbox.yml": hashlib.sha256(blackbox_raw).hexdigest(),
        }
        revision = hashlib.sha256("".join(f"{key}:{hashes[key]}" for key in sorted(hashes)).encode()).hexdigest()
        return ConfigDocuments(websites, content, blackbox, revision, hashes)

    def documents_from_rendered(self, rendered: dict[str, bytes], revision: str = "snapshot") -> ConfigDocuments:
        try:
            websites = _yaml().load(rendered["websites.yml"].decode("utf-8"))
            content = _yaml().load(rendered["content.yml"].decode("utf-8"))
            blackbox = _yaml().load(rendered["blackbox.yml"].decode("utf-8"))
        except Exception as exc:
            raise ConfigError(f"Snapshot содержит некорректный YAML: {exc}") from exc
        if not isinstance(websites, CommentedSeq) or not isinstance(content, CommentedSeq):
            raise ConfigError("Snapshot targets имеют некорректную структуру.")
        if not isinstance(blackbox, CommentedMap) or not isinstance(blackbox.get("modules"), CommentedMap):
            raise ConfigError("Snapshot blackbox.yml не содержит modules.")
        hashes = {name: hashlib.sha256(data).hexdigest() for name, data in rendered.items()}
        return ConfigDocuments(websites, content, blackbox, revision, hashes)

    def assert_revision(self, expected_revision: str) -> ConfigDocuments:
        documents = self.load_documents()
        if not expected_revision or documents.revision != expected_revision:
            raise ConcurrentModificationError(
                "Конфигурация была изменена другим пользователем. Обновите страницу и повторите операцию."
            )
        return documents

    @staticmethod
    def _targets(entry: Any) -> CommentedSeq | None:
        if isinstance(entry, CommentedMap) and isinstance(entry.get("targets"), CommentedSeq):
            return entry["targets"]
        return None

    @staticmethod
    def _labels(entry: Any) -> dict[str, str]:
        labels = entry.get("labels", {}) if isinstance(entry, CommentedMap) else {}
        if not isinstance(labels, dict):
            return {}
        return {str(key): str(value) for key, value in labels.items()}

    def build_state(self, documents: ConfigDocuments | None = None) -> ConfigState:
        documents = documents or self.load_documents()
        errors: list[str] = []
        http_entries: dict[str, list[tuple[CommentedMap, dict[str, str]]]] = {}
        for index, entry in enumerate(documents.websites):
            targets = self._targets(entry)
            if targets is None:
                errors.append(f"Некорректная target-группа websites.yml #{index + 1}.")
                continue
            labels = self._labels(entry)
            for raw_url in targets:
                url = str(raw_url)
                http_entries.setdefault(url, []).append((entry, labels))

        content_entries: dict[str, list[tuple[CommentedMap, dict[str, str]]]] = {}
        for index, entry in enumerate(documents.content):
            targets = self._targets(entry)
            if targets is None:
                errors.append(f"Некорректная target-группа content.yml #{index + 1}.")
                continue
            labels = self._labels(entry)
            for raw_url in targets:
                content_entries.setdefault(str(raw_url), []).append((entry, labels))

        modules = documents.blackbox["modules"]
        result: list[WebsiteTarget] = []
        all_urls = list(http_entries)
        all_urls.extend(url for url in content_entries if url not in http_entries)
        for url in all_urls:
            per_target_errors: list[str] = []
            http_refs = http_entries.get(url, [])
            content_refs = content_entries.get(url, [])
            labels = dict(http_refs[0][1]) if http_refs else {}
            if len(http_refs) > 1:
                per_target_errors.append("URL повторяется в websites.yml.")
            if not http_refs:
                per_target_errors.append("Есть content-check, но отсутствует HTTP-target.")
            if len(content_refs) > 1:
                per_target_errors.append("URL повторяется в content.yml.")

            http_module = labels.get("module", "http_2xx")
            if http_module not in modules:
                per_target_errors.append(f"HTTP-модуль {http_module} отсутствует в blackbox.yml.")

            content_module: str | None = None
            fragments: list[str] = []
            negative: list[str] = []
            if content_refs:
                content_labels = content_refs[0][1]
                content_module = content_labels.get("module")
                if not content_module:
                    per_target_errors.append("У content-target отсутствует имя модуля.")
                elif content_module not in modules:
                    per_target_errors.append(f"Content-модуль {content_module} отсутствует в blackbox.yml.")
                else:
                    module = modules[content_module]
                    http_config = module.get("http", {}) if isinstance(module, dict) else {}
                    positive = http_config.get("fail_if_body_not_matches_regexp", []) if isinstance(http_config, dict) else []
                    negative_raw = http_config.get("fail_if_body_matches_regexp", []) if isinstance(http_config, dict) else []
                    if not isinstance(positive, list) or not positive:
                        per_target_errors.append("Content-модуль не содержит обязательных фрагментов.")
                    else:
                        fragments = [display_fragment(str(item)) for item in positive]
                    if isinstance(negative_raw, list):
                        negative = [display_fragment(str(item)) for item in negative_raw]

            result.append(
                WebsiteTarget(
                    site_id=deterministic_site_id(url),
                    url=url,
                    display_name=labels.get("display_name") or None,
                    labels=labels,
                    http_module=http_module,
                    content_enabled=bool(content_refs),
                    content_module=content_module,
                    fragments=fragments,
                    negative_fragments=negative,
                    config_error=" ".join(per_target_errors) or None,
                )
            )

        result.sort(key=lambda target: (target.display_name or target.url).casefold())
        return ConfigState(result, documents.revision, errors)

    @staticmethod
    def _standard_http_module(fragments: list[str] | None = None) -> CommentedMap:
        module = CommentedMap()
        module["prober"] = "http"
        module["timeout"] = "10s"
        http = CommentedMap()
        http["valid_http_versions"] = CommentedSeq(["HTTP/1.1", "HTTP/2.0"])
        http["valid_status_codes"] = CommentedSeq([200])
        http["method"] = "GET"
        http["fail_if_not_ssl"] = False
        http["preferred_ip_protocol"] = "ip4"
        if fragments:
            http["fail_if_body_not_matches_regexp"] = CommentedSeq([escape_fragment(item) for item in fragments])
            http["fail_if_body_matches_regexp"] = CommentedSeq(ConfigRepository.STANDARD_NEGATIVE)
        module["http"] = http
        return module

    @staticmethod
    def _new_target_entry(url: str, display_name: str | None, module: str) -> CommentedMap:
        entry = CommentedMap()
        entry["targets"] = CommentedSeq([url])
        labels = CommentedMap()
        labels["role"] = "web-app"
        labels["location"] = "others"
        labels["env"] = "prod"
        labels["site"] = deterministic_site_id(url)
        labels["module"] = module
        labels["managed_by"] = "websites-admin"
        if display_name and display_name.strip():
            labels["display_name"] = display_name.strip()[:120]
        entry["labels"] = labels
        return entry

    @staticmethod
    def _content_entry(url: str, labels_source: dict[str, str], module: str) -> CommentedMap:
        entry = CommentedMap()
        entry["targets"] = CommentedSeq([url])
        labels = CommentedMap()
        for key, value in labels_source.items():
            if key not in {"module", "display_name"}:
                labels[key] = value
        labels["site"] = labels_source.get("site") or deterministic_site_id(url)
        labels["module"] = module
        entry["labels"] = labels
        return entry

    def add_target(
        self, documents: ConfigDocuments, url: str, display_name: str | None, fragments: Iterable[str] | None
    ) -> ConfigDocuments:
        state = self.build_state(documents)
        if any(target.url == url for target in state.targets):
            raise DuplicateTargetError("Этот URL уже есть в мониторинге.")
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ConfigError("Некорректный URL.")
        values = _validate_fragments(fragments, 3) if fragments else []
        result = documents.clone()
        http_module = deterministic_module_name(url, "http")
        if http_module in result.blackbox["modules"]:
            raise UnsafeConfigError("Коллизия с существующим HTTP-модулем.")
        result.blackbox["modules"][http_module] = self._standard_http_module()
        result.websites.append(self._new_target_entry(url, display_name, http_module))
        if values:
            content_module = deterministic_module_name(url, "content")
            if content_module in result.blackbox["modules"]:
                raise UnsafeConfigError("Коллизия с существующим content-модулем.")
            result.blackbox["modules"][content_module] = self._standard_http_module(values)
            labels = self._labels(result.websites[-1])
            result.content.append(self._content_entry(url, labels, content_module))
        return result

    def _find_http_entry(self, documents: ConfigDocuments, url: str) -> CommentedMap:
        found: list[CommentedMap] = []
        for entry in documents.websites:
            targets = self._targets(entry)
            if targets is not None and url in [str(item) for item in targets]:
                found.append(entry)
        if not found:
            raise TargetNotFoundError("Цель не найдена.")
        if len(found) > 1:
            raise UnsafeConfigError("URL повторяется в websites.yml; автоматическое изменение запрещено.")
        return found[0]

    def _remove_url(self, sequence: CommentedSeq, url: str) -> list[dict[str, str]]:
        removed_labels: list[dict[str, str]] = []
        for entry in list(sequence):
            targets = self._targets(entry)
            if targets is None:
                continue
            matching = [item for item in list(targets) if str(item) == url]
            if not matching:
                continue
            removed_labels.append(self._labels(entry))
            for item in matching:
                targets.remove(item)
            if not targets:
                sequence.remove(entry)
        return removed_labels

    @staticmethod
    def _module_references(documents: ConfigDocuments, module_name: str) -> int:
        count = 0
        for sequence in (documents.websites, documents.content):
            for entry in sequence:
                labels = ConfigRepository._labels(entry)
                if labels.get("module") == module_name:
                    targets = ConfigRepository._targets(entry)
                    count += len(targets or [])
        return count

    def delete_target(self, documents: ConfigDocuments, url: str) -> ConfigDocuments:
        state = self.build_state(documents)
        target = state.by_url(url)
        if target.config_error and "повторяется" in target.config_error:
            raise UnsafeConfigError("Цель содержит коллизию; удаление через интерфейс запрещено.")
        result = documents.clone()
        http_labels = self._remove_url(result.websites, url)
        content_labels = self._remove_url(result.content, url)
        candidate_modules = {labels.get("module") for labels in content_labels}
        if http_labels and http_labels[0].get("managed_by") == "websites-admin":
            candidate_modules.add(http_labels[0].get("module"))
        for module_name in candidate_modules:
            if module_name and self._module_references(result, module_name) == 0:
                result.blackbox["modules"].pop(module_name, None)
        return result

    def enable_content(self, documents: ConfigDocuments, url: str, fragments: Iterable[str]) -> ConfigDocuments:
        values = _validate_fragments(fragments, 4)
        state = self.build_state(documents)
        target = state.by_url(url)
        if target.content_enabled:
            raise ConfigError("Content-check уже включён.")
        if target.config_error:
            raise UnsafeConfigError("Цель содержит ошибку конфигурации; автоматическое изменение запрещено.")
        result = documents.clone()
        http_entry = self._find_http_entry(result, url)
        module = deterministic_module_name(url, "content")
        if module in result.blackbox["modules"]:
            raise UnsafeConfigError("Коллизия с существующим content-модулем.")
        result.blackbox["modules"][module] = self._standard_http_module(values)
        result.content.append(self._content_entry(url, self._labels(http_entry), module))
        return result

    def disable_content(self, documents: ConfigDocuments, url: str) -> ConfigDocuments:
        state = self.build_state(documents)
        target = state.by_url(url)
        if not target.content_enabled or not target.content_module:
            raise ConfigError("Content-check уже выключен.")
        if target.config_error:
            raise UnsafeConfigError("Цель содержит ошибку конфигурации; автоматическое изменение запрещено.")
        result = documents.clone()
        removed = self._remove_url(result.content, url)
        if not removed:
            raise UnsafeConfigError("Content-target не найден.")
        if self._module_references(result, target.content_module) == 0:
            result.blackbox["modules"].pop(target.content_module, None)
        return result

    def update_fragments(self, documents: ConfigDocuments, url: str, fragments: Iterable[str]) -> ConfigDocuments:
        values = _validate_fragments(fragments, 4)
        state = self.build_state(documents)
        target = state.by_url(url)
        if not target.content_enabled or not target.content_module:
            raise ConfigError("Content-check выключен.")
        if target.config_error:
            raise UnsafeConfigError("Цель содержит ошибку конфигурации; автоматическое изменение запрещено.")
        result = documents.clone()
        module = result.blackbox["modules"].get(target.content_module)
        if not isinstance(module, dict) or not isinstance(module.get("http"), dict):
            raise UnsafeConfigError("Content-модуль имеет неизвестную структуру.")
        module["http"]["fail_if_body_not_matches_regexp"] = CommentedSeq([escape_fragment(item) for item in values])
        return result

    def render(self, documents: ConfigDocuments) -> dict[str, bytes]:
        rendered: dict[str, bytes] = {}
        for name, document in (
            ("websites.yml", documents.websites),
            ("content.yml", documents.content),
            ("blackbox.yml", documents.blackbox),
        ):
            stream = io.StringIO()
            _yaml().dump(document, stream)
            rendered[name] = stream.getvalue().encode("utf-8")
        return rendered

    def validate_rendered(self, rendered: dict[str, bytes]) -> None:
        for name in ("websites.yml", "content.yml", "blackbox.yml"):
            try:
                document = _yaml().load(rendered[name].decode("utf-8"))
            except Exception as exc:
                raise ConfigError(f"Ошибка YAML в {name}: {exc}") from exc
            if name in {"websites.yml", "content.yml"} and not isinstance(document, CommentedSeq):
                raise ConfigError(f"{name} должен содержать список.")
            if name == "blackbox.yml" and (not isinstance(document, CommentedMap) or "modules" not in document):
                raise ConfigError("blackbox.yml не содержит modules.")
