from __future__ import annotations

from app.services.content import extract_candidates, verify_fragments


HTML = """<!doctype html><html><head>
<title>Корпоративный портал производственной компании PL</title>
<meta name="description" content="Проектирование и строительство промышленных объектов полного цикла">
</head><body><nav>Главная Подробнее</nav>
<h1>Надёжные инженерные решения для сложных промышленных объектов</h1>
<h2>Комплексное управление строительными проектами</h2>
<p>Мы проектируем, строим и вводим в эксплуатацию промышленные объекты по всей России.</p>
<p>Цена проекта 100 000 руб.</p><p>Опубликовано 14.07.2026</p>
<div class="cookie-popup">Мы используем файлы cookie и просим дать согласие на обработку данных</div>
</body></html>"""


def test_candidate_scorer_is_deterministic_and_marks_recommended():
    first = extract_candidates(HTML)
    second = extract_candidates(HTML)
    assert first == second
    assert 1 <= len(first) <= 12
    assert sum(item.recommended for item in first) == 2
    assert first[0].source == "Заголовок страницы"


def test_candidate_scorer_filters_dynamic_and_navigation_noise():
    texts = [item.text for item in extract_candidates(HTML)]
    assert all("100 000" not in value for value in texts)
    assert all("14.07.2026" not in value for value in texts)
    assert all("cookie" not in value.casefold() for value in texts)
    assert all(value != "Главная Подробнее" for value in texts)


def test_verify_fragments_requires_every_literal_fragment():
    result = verify_fragments(HTML, ["сложных промышленных объектов", "нет такого текста"])
    assert result == {"сложных промышленных объектов": True, "нет такого текста": False}
