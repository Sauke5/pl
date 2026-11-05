from __future__ import annotations

import re

import pytest

from app.repositories.config import (
    ConcurrentModificationError,
    ConfigError,
    DuplicateTargetError,
    deterministic_module_name,
    deterministic_site_id,
    display_fragment,
)


def test_round_trip_preserves_comments_unknown_keys_and_existing_module(repository):
    documents = repository.load_documents()
    original_module = documents.blackbox["modules"]["http_2xx"].copy()
    changed = repository.add_target(documents, "https://new.example.net/path", "Новый сайт", ["Стабильный фрагмент страницы"])
    rendered = repository.render(changed)
    assert b"# keep websites comment" in rendered["websites.yml"]
    assert b"# keep blackbox comment" in rendered["blackbox.yml"]
    assert b"custom_label: preserve-me" in rendered["websites.yml"]
    assert b"X-Preserved-Test: keep" in rendered["blackbox.yml"]
    assert changed.blackbox["modules"]["http_2xx"] == original_module
    repository.validate_rendered(rendered)


def test_add_is_deterministic_and_escapes_unicode_fragments(repository):
    url = "https://xn--e1afmkfd.xn--p1ai/path?a=1"
    fragments = ["АО «PL» (Москва)", "Сервис [работает] 24/7"]
    changed = repository.add_target(repository.load_documents(), url, "PL", fragments)
    state = repository.build_state(changed)
    target = state.by_url(url)
    assert target.site_id == deterministic_site_id(url)
    assert target.content_module == deterministic_module_name(url, "content")
    patterns = changed.blackbox["modules"][target.content_module]["http"]["fail_if_body_not_matches_regexp"]
    assert all(re.compile(pattern) for pattern in patterns)
    assert patterns[0] == "АО «PL» \\(Москва\\)"
    assert patterns[1] == "Сервис \\[работает\\] 24/7"


def test_display_fragment_removes_legacy_title_wrapper():
    assert display_fragment(r"(?i)<title[^>]*>АО \(PL\)</title>") == "АО (PL)"


def test_duplicate_url_is_rejected(repository):
    with pytest.raises(DuplicateTargetError):
        repository.add_target(repository.load_documents(), "https://example.org/", None, None)


def test_enable_update_disable_content_does_not_change_http_module(repository):
    documents = repository.load_documents()
    disabled = repository.disable_content(documents, "https://example.org/")
    assert not repository.build_state(disabled).by_url("https://example.org/").content_enabled
    assert disabled.blackbox["modules"]["http_2xx"]["timeout"] == "5s"

    enabled = repository.enable_content(disabled, "https://example.org/", ["Новый стабильный текст страницы"])
    target = repository.build_state(enabled).by_url("https://example.org/")
    assert target.content_enabled
    assert target.fragments == ["Новый стабильный текст страницы"]

    updated = repository.update_fragments(enabled, "https://example.org/", ["Ещё один стабильный фрагмент"])
    target = repository.build_state(updated).by_url("https://example.org/")
    assert target.fragments == ["Ещё один стабильный фрагмент"]
    assert updated.blackbox["modules"]["http_2xx"]["http"]["valid_status_codes"] == [200, 204]


def test_delete_removes_target_and_owned_modules_only(repository):
    documents = repository.load_documents()
    added = repository.add_target(documents, "https://delete.example.net/", None, ["Удаляемый стабильный фрагмент"])
    target = repository.build_state(added).by_url("https://delete.example.net/")
    deleted = repository.delete_target(added, target.url)
    state = repository.build_state(deleted)
    assert target.url not in {item.url for item in state.targets}
    assert target.http_module not in deleted.blackbox["modules"]
    assert target.content_module not in deleted.blackbox["modules"]
    assert "http_2xx" in deleted.blackbox["modules"]


def test_config_inconsistency_is_visible_and_blocks_unsafe_change(repository):
    documents = repository.load_documents()
    documents.websites.append(documents.websites[0])
    state = repository.build_state(documents)
    assert "повторяется" in state.by_url("https://example.org/").config_error
    with pytest.raises(ConfigError):
        repository.disable_content(documents, "https://example.org/")


def test_revision_detects_concurrent_external_edit(repository):
    documents = repository.load_documents()
    repository.paths["websites.yml"].write_text(
        repository.paths["websites.yml"].read_text(encoding="utf-8") + "\n# external edit\n",
        encoding="utf-8",
    )
    with pytest.raises(ConcurrentModificationError):
        repository.assert_revision(documents.revision)


def test_yaml_syntax_failure_is_reported_as_config_error(repository):
    repository.paths["content.yml"].write_text("- labels: [unterminated\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="content.yml"):
        repository.load_documents()


@pytest.mark.parametrize("fragments", [[], [""], ["same", "same"], ["x" * 501]])
def test_invalid_fragment_sets_are_rejected(repository, fragments):
    with pytest.raises(ConfigError):
        repository.update_fragments(repository.load_documents(), "https://example.org/", fragments)
