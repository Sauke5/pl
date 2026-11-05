"""Bounded aggregate reporting for single-choice employee surveys."""
from __future__ import annotations

import re


_ID = re.compile(r"[a-z0-9_]{1,32}\Z")


def _identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("Некорректный идентификатор настройки аналитики.")
    return value


def _ids(value, maximum):
    if not isinstance(value, list) or not 1 <= len(value) <= maximum:
        raise ValueError("Проверьте количество вопросов в настройках аналитики.")
    result = [_identifier(item) for item in value]
    if len(set(result)) != len(result):
        raise ValueError("Идентификаторы в настройках аналитики повторяются.")
    return result


def normalize_analytics(raw, questions):
    """Validate references without importing the application's HTTP error type."""
    expected = {"role_question_id", "manager_option_id", "employee_option_id", "filter_question_ids", "metrics"}
    if not isinstance(raw, dict) or set(raw) != expected:
        raise ValueError("Некорректные настройки аналитики.")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 60:
        raise ValueError("Аналитика поддерживает от 1 до 60 вопросов.")
    question_map = {q["id"]: q for q in questions}
    if len(question_map) != len(questions):
        raise ValueError("Идентификаторы вопросов повторяются.")
    role_id = _identifier(raw["role_question_id"])
    manager_id = _identifier(raw["manager_option_id"])
    employee_id = _identifier(raw["employee_option_id"])
    if role_id not in question_map:
        raise ValueError("Вопрос о должности не найден.")
    role_options = {o["id"] for o in question_map[role_id]["options"]}
    if manager_id == employee_id or not {manager_id, employee_id} <= role_options:
        raise ValueError("Для руководителей и сотрудников нужны разные варианты ответа о должности.")
    filter_ids = _ids(raw["filter_question_ids"], 12)
    if not set(filter_ids) <= question_map.keys():
        raise ValueError("Вопрос для фильтрации не найден.")
    if role_id not in filter_ids:
        raise ValueError("Добавьте вопрос о должности в фильтры аналитики.")
    metrics = raw["metrics"]
    if not isinstance(metrics, list) or not 1 <= len(metrics) <= 12:
        raise ValueError("Укажите от 1 до 12 показателей аналитики.")
    normalized_metrics = []
    for metric in metrics:
        if not isinstance(metric, dict) or set(metric) != {"id", "title", "question_ids"}:
            raise ValueError("Некорректный показатель аналитики.")
        metric_id = _identifier(metric["id"])
        title = metric["title"]
        if (not isinstance(title, str) or not title.strip() or len(title) > 120
                or any(ord(c) < 32 for c in title)):
            raise ValueError("Проверьте название показателя аналитики.")
        question_ids = _ids(metric["question_ids"], 60)
        if not set(question_ids) <= question_map.keys():
            raise ValueError("Вопрос для показателя аналитики не найден.")
        for question_id in question_ids:
            question = question_map[question_id]
            scale = question.get("scale")
            options = {o["id"] for o in question["options"]}
            if (not isinstance(scale, dict) or len(scale) < 2 or not set(scale) <= options
                    or any(type(value) is not int or not 1 <= value <= 5 for value in scale.values())):
                raise ValueError("Для показателя нужны вопросы со шкалой от 1 до 5.")
        normalized_metrics.append({"id": metric_id, "title": title.strip(), "question_ids": question_ids})
    if len({m["id"] for m in normalized_metrics}) != len(normalized_metrics):
        raise ValueError("Идентификаторы показателей повторяются.")
    return {"role_question_id": role_id, "manager_option_id": manager_id,
            "employee_option_id": employee_id, "filter_question_ids": filter_ids,
            "metrics": normalized_metrics}


def _filters(raw, config, questions):
    if raw is None:
        return {}
    if not isinstance(raw, dict) or len(raw) > 12:
        raise ValueError("Некорректные фильтры результатов.")
    if not raw:
        return {}
    if not config or not set(raw) <= set(config["filter_question_ids"]):
        raise ValueError("Выбранный фильтр не предусмотрен анкетой.")
    result = {}
    for question_id in config["filter_question_ids"]:
        if question_id not in raw:
            continue
        selection = _ids(raw[question_id], 12)
        options = {o["id"] for o in questions[question_id]["options"]}
        if not set(selection) <= options:
            raise ValueError("Выбранный вариант фильтра не найден.")
        result[question_id] = selection
    return result


class _Scale:
    def __init__(self):
        self.sum = 0.0
        self.valid = self.favorable = self.negative = self.respondents = 0

    def add(self, values):
        if not values:
            return
        self.valid += len(values)
        self.favorable += sum(value >= 4 for value in values)
        self.negative += sum(value <= 2 for value in values)
        # Each respondent contributes one mean, even if they skipped some items.
        self.sum += (sum(values) / len(values) - 1) * 25
        self.respondents += 1

    def result(self, respondents=False):
        result = {"score": round(self.sum / self.respondents, 1) if self.respondents else None,
                  "favorable_percent": round(self.favorable * 100 / self.valid, 1) if self.valid else None,
                  "negative_percent": round(self.negative * 100 / self.valid, 1) if self.valid else None,
                  "valid_answers": self.valid, "favorable_answers": self.favorable,
                  "negative_answers": self.negative}
        if respondents:
            result["respondents"] = self.respondents
        return result


def analyze(form, rows, filters=None, pending=0):
    """Consume confirmed (answers, outcome) pairs once, retaining only counts."""
    source_questions = {q["id"]: q for q in form["questions"]}
    config = normalize_analytics(form["analytics"], form["questions"]) if "analytics" in form else None
    selected = _filters(filters, config, source_questions)
    selected_sets = {key: set(value) for key, value in selected.items()}
    questions = [{"id": q["id"], "title": q["title"], "options": [
        {"id": o["id"], "label": o["label"], "count": 0} for o in q["options"]]} for q in form["questions"]]
    option_counts = {q["id"]: {o["id"]: o for o in q["options"]} for q in questions}
    outcomes = [{"id": o["id"], "title": o["title"], "count": 0} for o in form.get("outcomes", [])]
    outcome_counts = {o["id"]: o for o in outcomes}
    scale_questions = {q["id"]: q["scale"] for q in form["questions"] if config and q.get("scale")}
    question_scales = {key: _Scale() for key in scale_questions}
    metrics = config["metrics"] if config else []
    metric_scales = [_Scale() for _ in metrics]
    groups = [{"id": "manager", "title": "Руководители", "total": 0},
              {"id": "employee", "title": "Сотрудники", "total": 0}]
    group_scales = [[_Scale() for _ in metrics] for _ in groups]
    total = overall_total = 0
    for answers, outcome in rows:
        overall_total += 1
        if any(answers.get(key) not in options for key, options in selected_sets.items()):
            continue
        total += 1
        for question_id, options in option_counts.items():
            option = options.get(answers.get(question_id))
            if option is not None:
                option["count"] += 1
        if outcome and outcome.get("id") in outcome_counts:
            outcome_counts[outcome["id"]]["count"] += 1
        if not config:
            continue
        values = {key: scale.get(answers.get(key)) for key, scale in scale_questions.items()}
        for key, value in values.items():
            question_scales[key].add([value] if value is not None else [])
        role = answers.get(config["role_question_id"])
        group_index = (0 if role == config["manager_option_id"] else
                       1 if role == config["employee_option_id"] else None)
        if group_index is not None:
            groups[group_index]["total"] += 1
        for index, metric in enumerate(metrics):
            answered = [values[key] for key in metric["question_ids"] if values[key] is not None]
            metric_scales[index].add(answered)
            if group_index is not None:
                group_scales[group_index][index].add(answered)
    result = {"total": total, "questions": questions, "outcomes": outcomes, "pending": pending}
    if config:
        def metric_results(scales):
            return [{"id": metric["id"], "title": metric["title"], **scale.result(respondents=True)}
                    for metric, scale in zip(metrics, scales)]

        for question in questions:
            source = source_questions[question["id"]]
            if source.get("section"):
                question["section"] = source["section"]
            if question["id"] in question_scales:
                question["scale_summary"] = question_scales[question["id"]].result()
        for group, scales in zip(groups, group_scales):
            group["metrics"] = metric_results(scales)
        result.update({"overall_total": overall_total, "filters": selected,
                       "filter_definitions": [{"id": key, "title": source_questions[key]["title"], "options": [
                           {"id": o["id"], "label": o["label"]} for o in source_questions[key]["options"]]}
                           for key in config["filter_question_ids"]],
                       "metrics": metric_results(metric_scales), "comparison": groups})
    return result
