from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from bs4 import BeautifulSoup, Tag


@dataclass(frozen=True, slots=True)
class Candidate:
    text: str
    source: str
    score: int
    recommended: bool = False


EXACT_NOISE = {
    "главная",
    "подробнее",
    "о компании",
    "читать далее",
    "заказать звонок",
    "политика конфиденциальности",
    "согласен",
    "принять",
}
NOISE_MARKERS = (
    "cookie",
    "используем файлы",
    "согласие на обработку",
    "навигация",
    "личный кабинет",
)
PHONE_RE = re.compile(r"^\+?[\d\s()\-]{7,}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
PRICE_RE = re.compile(r"(?:\d[\d\s.,]*)\s*(?:₽|руб\.?|тенге|₸|\$|€)", re.I)
DYNAMIC_RE = re.compile(r"(?:session|sid|token|counter|просмотр(?:ов|а)?)[\s:=_-]*[a-z0-9_-]+", re.I)
DATE_RE = re.compile(r"\b(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:20)?\d{2}\b")
YEAR_RE = re.compile(r"\b20(?:2[4-9]|3\d)\b")


def normalize_text(value: str) -> str:
    return " ".join(value.replace("\xa0", " ").split()).strip()


def _stable(text: str, raw_html: str) -> bool:
    folded = text.casefold()
    if len(text) < 20 or len(text) > 360:
        return False
    if folded in EXACT_NOISE or any(marker in folded for marker in NOISE_MARKERS):
        return False
    if PHONE_RE.fullmatch(text) or EMAIL_RE.fullmatch(text):
        return False
    if PRICE_RE.search(text) or DYNAMIC_RE.search(text) or DATE_RE.search(text):
        return False
    if YEAR_RE.search(text):
        return False
    if text not in raw_html:
        return False
    alpha = sum(character.isalpha() for character in text)
    return alpha >= 12 and alpha / max(1, len(text)) >= 0.35


def _near_duplicate(left: str, right: str) -> bool:
    folded_left = left.casefold()
    folded_right = right.casefold()
    if folded_left in folded_right or folded_right in folded_left:
        return min(len(left), len(right)) / max(len(left), len(right)) > 0.72
    return SequenceMatcher(None, folded_left, folded_right).ratio() >= 0.86


def _candidate(tag: Tag, source: str, base_score: int, raw_html: str) -> Candidate | None:
    text = normalize_text(tag.get_text(" ", strip=True))
    if not _stable(text, raw_html):
        return None
    length_bonus = min(18, max(0, (len(text) - 30) // 15))
    return Candidate(text=text, source=source, score=base_score + length_bonus)


def extract_candidates(raw_html: str) -> list[Candidate]:
    soup = BeautifulSoup(raw_html, "lxml")
    candidates: list[Candidate] = []

    title = soup.find("title")
    if isinstance(title, Tag):
        item = _candidate(title, "Заголовок страницы", 100, raw_html)
        if item:
            candidates.append(item)

    h1 = soup.find_all("h1")
    for tag in h1[:3]:
        item = _candidate(tag, "Главный заголовок", 92, raw_html)
        if item:
            candidates.append(item)

    for tag in soup.find_all("meta"):
        if str(tag.get("name", "")).casefold() != "description":
            continue
        text = normalize_text(str(tag.get("content", "")))
        if _stable(text, raw_html):
            candidates.append(Candidate(text=text, source="Описание страницы", score=88 + min(12, len(text) // 30)))
        break

    for tag in soup.find_all("h2")[:12]:
        item = _candidate(tag, "Заголовок раздела", 72, raw_html)
        if item:
            candidates.append(item)

    for unwanted in soup.find_all(["script", "style", "noscript", "nav", "button", "form"]):
        unwanted.decompose()
    for tag in soup.find_all("footer"):
        tag.decompose()

    for tag in soup.find_all("p")[:80]:
        item = _candidate(tag, "Текстовый блок", 58, raw_html)
        if item:
            candidates.append(item)

    for tag in soup.find_all(["section", "article", "div"])[:100]:
        classes = " ".join(str(value) for value in tag.get("class", []))
        identity = f"{classes} {tag.get('id', '')}".casefold()
        if any(marker in identity for marker in ("menu", "nav", "cookie", "footer", "header", "modal", "popup")):
            continue
        item = _candidate(tag, "Крупный текстовый блок", 46, raw_html)
        if item:
            candidates.append(item)

    ordered = sorted(candidates, key=lambda item: (-item.score, item.source, item.text.casefold()))
    unique: list[Candidate] = []
    for item in ordered:
        if any(_near_duplicate(item.text, existing.text) for existing in unique):
            continue
        unique.append(item)
        if len(unique) >= 12:
            break

    recommended_count = 2 if len(unique) >= 2 else len(unique)
    return [
        Candidate(item.text, item.source, item.score, index < recommended_count)
        for index, item in enumerate(unique)
    ]


def verify_fragments(raw_html: str, fragments: list[str]) -> dict[str, bool]:
    return {fragment: fragment in raw_html for fragment in fragments}
