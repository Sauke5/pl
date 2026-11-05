"""Import the explicit entertainment_personality JSON schema_version 1.0.

Supported source inspected: quiz.json content_version 1.0.0 in the supplied quiz
archive. This is a data converter: JavaScript and executable archive content are
never loaded. flow/editorial_notes are explanatory metadata, not executable rules.
UI copy (including intro.start_button), estimated_minutes, quiz_id/content_version,
share_text/name_genitive and equal_maxima_explanation are checked as metadata;
they do not replace Platform controls, routing, scoring or published versions.
"""
from __future__ import annotations

import re

_ID = re.compile(r"[a-z0-9_]{1,32}\Z")


def _object(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys.split()):
        raise ValueError("Unsupported or malformed source object")
    return value


def _string(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Source text must be nonempty")
    return value


def _id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("Unsupported source identifier")
    return value


def _strings(value, keys):
    _object(value, keys)
    for item in value.values():
        _string(item)


def _fixed(value, expected):
    # Exact JSON types distinguish booleans from 0/1.
    if type(value) is not type(expected) or value != expected:
        raise ValueError("Unsupported source semantics")


def _unique(values):
    if len(set(values)) != len(values):
        raise ValueError("Duplicate source identifier")


def to_platform(raw):
    """Convert supported data or raise ValueError; never guess other quiz formats."""
    _object(raw, "schema_version content_version quiz_id language title kind estimated_minutes intro scoring presentation ui characters questions tie_break flow editorial_notes")
    _fixed(raw["schema_version"], "1.0")
    _fixed(raw["kind"], "entertainment_personality")
    _fixed(raw["language"], "ru")
    for key in ("title", "content_version", "quiz_id"):
        _string(raw[key])
    minutes = raw["estimated_minutes"]
    if (not isinstance(minutes, list) or len(minutes) != 2
            or any(type(v) is not int or v < 1 for v in minutes) or minutes[0] > minutes[1]):
        raise ValueError("Invalid source duration")
    _strings(raw["intro"], "lead instruction note start_button")
    _strings(raw["ui"], "next previous finish restart share answer_required progress tie_progress result_heading secondary_heading tie_note result_footer")
    _strings(raw["flow"], "start main incomplete unique_leader multiple_second_places exact_tie two_way_tie three_or_more_way_tie edit restart")
    _strings(raw["editorial_notes"], "character_scope weight_meaning interpretation platform_import output_policy")
    _object(raw["scoring"], "method primary_weight secondary_weight max_per_character total_awarded_points secondary_max_gap secondary_max_gap_is partial_result tie_break_adds_points display_confidence_percent equal_maxima_explanation")
    scoring = raw["scoring"]
    for key, expected in {
        "method": "weighted_character_sum", "primary_weight": 3, "secondary_weight": 1,
        "secondary_max_gap_is": "author_defined_raw_score_threshold", "partial_result": False,
        "tie_break_adds_points": False, "display_confidence_percent": False,
    }.items():
        _fixed(scoring[key], expected)
    gap = scoring["secondary_max_gap"]
    if type(gap) is not int or not 0 <= gap <= 10:
        raise ValueError("Unsupported secondary gap")
    _string(scoring["equal_maxima_explanation"])
    source_characters = raw["characters"]
    if not isinstance(source_characters, list) or not 2 <= len(source_characters) <= 12:
        raise ValueError("Invalid source characters")
    outcomes = []
    for character in source_characters:
        _object(character, "id name headline description strength blind_spot tip share_text name_genitive")
        _id(character["id"])
        for key, value in character.items():
            _string(value)
        outcomes.append({"id": character["id"], "title": character["name"] + " — " + character["headline"],
            "description": (character["description"] + "\n\nСильная сторона: " + character["strength"]
                + "\n\nОбратная сторона: " + character["blind_spot"] + "\n\nПодсказка: " + character["tip"])})
    character_ids = [c["id"] for c in outcomes]
    _unique(character_ids)
    source_questions = raw["questions"]
    if not isinstance(source_questions, list) or not 1 <= len(source_questions) <= 30:
        raise ValueError("Invalid source questions")
    questions = []
    maxima = {key: 0 for key in character_ids}
    for question in source_questions:
        _object(question, "id text options")
        _id(question["id"])
        _string(question["text"])
        if not isinstance(question["options"], list) or not 2 <= len(question["options"]) <= 12:
            raise ValueError("Invalid source options")
        options = []
        for option in question["options"]:
            _object(option, "id text weights")
            _id(option["id"])
            _string(option["text"])
            weights = option["weights"]
            if (not isinstance(weights, dict) or len(weights) != 2
                    or set(weights) - set(character_ids)
                    or any(type(v) is not int for v in weights.values())
                    or sorted(weights.values()) != [1, 3]):
                raise ValueError("Unsupported source weights")
            options.append({"id": option["id"], "label": option["text"], "weights": dict(weights)})
        _unique([o["id"] for o in options])
        for key in character_ids:
            maxima[key] += max(o["weights"].get(key, 0) for o in options)
        questions.append({"id": question["id"], "title": question["text"], "required": True, "options": options})
    _unique([q["id"] for q in questions])
    if (type(scoring["max_per_character"]) is not int
            or any(maximum != scoring["max_per_character"] for maximum in maxima.values())
            or type(scoring["total_awarded_points"]) is not int
            or scoring["total_awarded_points"] != len(questions) * 4):
        raise ValueError("Source score assertions do not match weights")
    presentation = raw["presentation"]
    _object(presentation, "question_order shuffle_options shuffle_tie_options option_identity allow_back all_questions_required show_weights show_characters_before_result show_partial_scores minimum_questions maximum_questions save_attempt_version changing_main_answer_invalidates_tie_choice")
    for key, expected in {
        "question_order": "fixed", "shuffle_options": "once_per_attempt",
        "shuffle_tie_options": "once_when_tie_question_appears", "option_identity": "id",
        "allow_back": True, "all_questions_required": True, "show_weights": False,
        "show_characters_before_result": False, "show_partial_scores": False,
        "minimum_questions": len(questions), "maximum_questions": len(questions) + 1,
        "save_attempt_version": True, "changing_main_answer_invalidates_tie_choice": True,
    }.items():
        _fixed(presentation[key], expected)
    tie = raw["tie_break"]
    _object(tie, "id text filter selection score_effect options")
    _id(tie["id"])
    _string(tie["text"])
    for key, expected in {"filter": "only_characters_with_exact_maximum_score",
                          "selection": "one_required_option", "score_effect": "none"}.items():
        _fixed(tie[key], expected)
    if not isinstance(tie["options"], list):
        raise ValueError("Invalid source tie options")
    tie_options = []
    tie_ids = []
    for option in tie["options"]:
        _object(option, "id character_id text")
        tie_ids.append(_id(option["id"]))
        tie_options.append({"outcome_id": _id(option["character_id"]), "label": _string(option["text"])})
    _unique(tie_ids)
    if len(tie_options) != len(character_ids) or {o["outcome_id"] for o in tie_options} != set(character_ids):
        raise ValueError("Tie options must cover each character once")
    result = {"schema": "pl.forms/v1", "title": raw["title"],
        "description": "\n\n".join(raw["intro"][key] for key in ("lead", "instruction", "note")
            if raw["intro"][key] != "Это развлекательный тест: результат — игровой образ, а не психологическая оценка."),
        "kind": "quiz", "questions": questions, "outcomes": outcomes,
        "scoring": {"tie_break": {"title": tie["text"], "options": tie_options}, "close_secondary_gap": gap},
        "presentation": {key: presentation[key] for key in
            ("question_order", "shuffle_options", "shuffle_tie_options", "allow_back")}}
    if len(result["description"]) > 4000 or any(len(o["title"]) > 120 or len(o["description"]) > 2000 for o in outcomes):
        raise ValueError("Source content exceeds Platform limits")
    return result
