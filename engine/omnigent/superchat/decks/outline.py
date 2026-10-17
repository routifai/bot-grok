"""A deck's slide outline, derived by code for a file's studio turn (ADR 0024).

One line per slide: its number, then each named element (``data-superchat-id``) that holds
text, with that text, so most requests ("make the title on slide 3 shorter") are answered
without reading the whole file. An element with no text and no named element inside it (a
chart's canvas, an image) is listed by its id alone. The slide footer (``class="foot"``) repeats
on every slide and is left out. Bounded: at most :data:`MAX_SLIDES` slides and
:data:`MAX_CHARS` characters in all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from html.parser import HTMLParser

#: How the block opens (a reader cuts the block from a stored message by it).
HEADER = "Slide outline (element ids and their text, from the newest version):"
MAX_SLIDES = 40
MAX_CHARS = 2000
#: Characters of one element's text shown.
MAX_TEXT = 60
_CUT = "… (outline cut here; read the file for the rest)"
_SKIP_TEXT_IN = frozenset({"script", "style", "template", "noscript"})
_VOID = frozenset(
    {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta"}
    | {"param", "source", "track", "wbr"}
)


@dataclass
class _Element:
    id: str
    text: list[str] = field(default_factory=list)
    has_named_child: bool = False


@dataclass
class _Open:
    tag: str
    element: _Element | None
    skip: bool


class _OutlineParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.slides: list[list[_Element]] = []
        self._stack: list[_Open] = []
        self._slide_depth: int | None = None

    def _skipping(self) -> bool:
        return any(entry.skip for entry in self._stack)

    def _named(self) -> _Element | None:
        return next((e.element for e in reversed(self._stack) if e.element is not None), None)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = (values.get("class") or "").split()
        if tag == "section" and "slide" in classes and self._slide_depth is None:
            self.slides.append([])
            self._slide_depth = len(self._stack)
            # The slide's own id names the slide, not an element of it.
            self._stack.append(_Open(tag, None, skip=False))
            return
        in_slide = self._slide_depth is not None
        skip = tag in _SKIP_TEXT_IN or "foot" in classes
        element: _Element | None = None
        element_id = values.get("data-superchat-id")
        if in_slide and element_id and not skip and not self._skipping():
            element = _Element(element_id.strip())
            parent = self._named()
            if parent is not None:
                parent.has_named_child = True
            if tag == "img" and values.get("alt"):
                element.text.append(values["alt"] or "")
            self.slides[-1].append(element)
        if tag not in _VOID:
            self._stack.append(_Open(tag, element, skip))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # Recorded, then closed at once: a self-closed tag holds no text of its own.
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        for at in range(len(self._stack) - 1, -1, -1):
            if self._stack[at].tag == tag:
                del self._stack[at:]
                if self._slide_depth is not None and len(self._stack) <= self._slide_depth:
                    self._slide_depth = None
                return

    def handle_data(self, data: str) -> None:
        if self._slide_depth is None or self._skipping():
            return
        named = self._named()
        if named is not None:
            named.text.append(data)


def _clip(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= MAX_TEXT else text[: MAX_TEXT - 1].rstrip() + "…"


def _slide_line(number: int, elements: list[_Element]) -> str:
    parts: list[str] = []
    for element in elements:
        text = _clip("".join(element.text))
        if text:
            parts.append(f'{element.id} "{text}"')
        elif not element.has_named_child:
            parts.append(element.id)
    return f"Slide {number}: " + (" · ".join(parts) if parts else "(no named text)")


def deck_outline(source: str | bytes) -> str | None:
    """The outline block of a deck's HTML, or ``None`` when it has no slides.

    :param source: The deck file (``<section class="slide">`` per slide).
    :returns: :data:`HEADER` and one line per slide, within :data:`MAX_CHARS`.
    """
    text = source.decode("utf-8", "replace") if isinstance(source, bytes) else source
    parser = _OutlineParser()
    parser.feed(text)
    parser.close()
    if not parser.slides:
        return None
    lines = [HEADER]
    size = len(HEADER)
    slides = parser.slides
    for number, elements in enumerate(slides[:MAX_SLIDES], start=1):
        line = _slide_line(number, elements)
        if size + 1 + len(line) > MAX_CHARS - len(_CUT) - 1:
            lines.append(_CUT)
            return "\n".join(lines)
        lines.append(line)
        size += 1 + len(line)
    if len(slides) > MAX_SLIDES:
        lines.append(_CUT)
    return "\n".join(lines)
