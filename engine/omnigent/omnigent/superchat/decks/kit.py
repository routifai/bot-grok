"""The deck kit: assembles a Nova deck file from the skeleton, a template and the slides.

A deck is one self-contained HTML file (``*.deck.html``): the fixed 1920x1080 skeleton (scale to
fit, navigation, print rules, the Nova Deck Protocol), a template's tokens, theme and Latin-subset
fonts (embedded as data URIs, because the viewer's CSP blocks remote fonts), the shared layout
vocabulary, and the slides the Muse wrote. Only the slides are the Muse's; everything else comes
from here, so every deck starts exact for the PowerPoint export.

Portions modified from nexu-io/open-design
packages/contracts/src/prompts/deck-framework.ts@802708f, Apache-2.0; changes: the skeleton is
``kit/skeleton.html`` (see its header), slides are inserted by this module instead of being
hand-copied by the model, and the template set, tokens and fonts are Nova's (``kit/templates``,
MIT upstream designs; fonts SIL OFL 1.1).
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import re
from dataclasses import dataclass
from functools import cache, lru_cache
from pathlib import Path

KIT_DIR = Path(__file__).parent / "kit"
TEMPLATES_DIR = KIT_DIR / "templates"
FONTS_DIR = KIT_DIR / "fonts"
CHARTS_DIR = KIT_DIR / "charts"
CHARTJS_PATH = KIT_DIR / "vendor" / "chart.js" / "chart.umd.js"

#: The restrained professional theme the Muse starts from unless the request calls for more.
DEFAULT_THEME = "corporate-clean"
PREVIEWS_DIR = KIT_DIR / "previews"
SLOTS_OPEN = "<!-- nova:slides -->"
SLOTS_CLOSE = "<!-- /nova:slides -->"
_FONT_MIME = {".ttf": "font/ttf", ".otf": "font/otf", ".woff2": "font/woff2"}


class KitError(ValueError):
    """The request cannot be turned into a deck (unknown template, bad slides, ...)."""


@dataclass(frozen=True)
class Template:
    """One deck template: a design (palette, type, motifs) over the shared layouts."""

    id: str
    name: str
    description: str
    best_for: str
    category: str
    mode: str
    fonts: tuple[dict[str, object], ...]

    @property
    def directory(self) -> Path:
        return TEMPLATES_DIR / self.id


@lru_cache(maxsize=1)
def templates() -> dict[str, Template]:
    """Every template under ``kit/templates``, by id."""
    found: dict[str, Template] = {}
    for meta in sorted(TEMPLATES_DIR.glob("*/template.json")):
        data = json.loads(meta.read_text("utf-8"))
        found[data["id"]] = Template(
            id=data["id"],
            name=data["name"],
            description=data["description"],
            best_for=data["best_for"],
            category=data["category"],
            mode=data["mode"],
            fonts=tuple(data["fonts"]),
        )
    return found


def theme_dictionary() -> list[dict[str, str]]:
    """The theme dictionary: ``[{id, name, mood, category, mode, best_for}]``, restrained first.

    ``mood`` is the theme's one-line description. The order is stable: professional themes, then
    editorial, bold and dark, each by id.
    """
    order = {"professional": 0, "editorial": 1, "bold": 2, "dark": 3}
    ranked = sorted(templates().values(), key=lambda t: (order.get(t.category, 9), t.id))
    return [
        {
            "id": t.id,
            "name": t.name,
            "mood": t.description,
            "category": t.category,
            "mode": t.mode,
            "best_for": t.best_for,
        }
        for t in ranked
    ]


@cache
def theme_gallery() -> list[dict[str, str]]:
    """The dictionary for the picker: each entry plus its thumbnail as a ``data:`` URI."""
    out = []
    for entry in theme_dictionary():
        path = PREVIEWS_DIR / f"{entry['id']}.webp"
        data = base64.b64encode(path.read_bytes()).decode("ascii") if path.is_file() else ""
        out.append({**entry, "preview": f"data:image/webp;base64,{data}" if data else ""})
    return out


@cache
def _font_faces_css(template_id: str) -> str:
    """The template's ``@font-face`` rules with the font files inlined as data URIs."""
    template = templates()[template_id]
    rules = []
    for font in template.fonts:
        path = FONTS_DIR / str(font["file"])
        mime = _FONT_MIME.get(path.suffix.lower(), "font/ttf")
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        rules.append(
            f'@font-face{{font-family:"{font["family"]}";font-style:{font["style"]};'
            f"font-weight:{font['weight']};font-display:block;"
            f'src:url(data:{mime};base64,{data}) format("truetype")}}'
        )
    return "\n".join(rules)


def chart_recipes() -> dict[str, str]:
    """The chart slide recipes by name (``chart-bar`` ...): Open Design's templates, ported."""
    return {path.stem: path.read_text("utf-8") for path in sorted(CHARTS_DIR.glob("chart-*.html"))}


def menu() -> str:
    """The layout menu and the chart recipes (what ``deck_new`` returns to the Muse)."""
    recipes = "\n\n".join(
        f"`{name}`:\n\n```html\n{text.strip()}\n```" for name, text in chart_recipes().items()
    )
    heading = "Chart recipes (Open Design's chart templates, ported):"
    return (KIT_DIR / "menu.md").read_text("utf-8").rstrip() + f"\n\n{heading}\n\n{recipes}\n"


@cache
def _chart_runtime() -> str:
    """Chart.js (vendored, MIT) and Nova's defaults for it, as the deck's inline head script."""
    library = CHARTJS_PATH.read_text("utf-8")
    bootstrap = (CHARTS_DIR / "bootstrap.js").read_text("utf-8")
    return (
        "  <script data-nova-chartjs>\n"
        "/* Chart.js (MIT), vendored: never read or edit this block. */\n"
        f"{library}\n"
        "  </script>\n"
        f"  <script data-nova-chartjs-defaults>\n{bootstrap}  </script>\n"
    )


# ---------------------------------------------------------------------------------------------
# Static checks on the slides (before and after assembly); the layout checks run in Chromium.
# ---------------------------------------------------------------------------------------------

_SLIDE_RE = re.compile(r"<section\b[^>]*\bclass\s*=\s*\"[^\"]*\bslide\b[^\"]*\"[^>]*>", re.I)
_ID_RE = re.compile(r"""\bdata-nova-id\s*=\s*["']([^"']*)["']""")
_EXTERNAL_RE = re.compile(
    r"""(?:\bsrc|\bhref|\bposter|\bsrcset|\baction)\s*=\s*["']\s*(?:https?:)?//|url\(\s*["']?\s*(?:https?:)?//|@import""",
    re.I,
)
_FORBIDDEN_TAG_RE = re.compile(r"<\s*(script|iframe|object|embed|link|base|form|meta)\b", re.I)
# The one script a slide may carry: the Chart.js call that draws a chart on its canvas.
_CHART_SCRIPT_RE = re.compile(
    r"<script\b(?=[^>]*\bdata-nova-chart(?:\s|=|>))[^>]*>(.*?)</script\s*>", re.I | re.S
)
_ID_FORMAT = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def check_slides(slides_html: str) -> tuple[list[str], list[str]]:
    """``(errors, warnings)`` for the slides markup: structure, ids, nothing external."""
    errors: list[str] = []
    warnings: list[str] = []
    tags = _SLIDE_RE.findall(slides_html)
    if not tags:
        errors.append('No slides: write each slide as <section class="slide ..."> ... </section>.')
    if slides_html.lower().count("<section") != slides_html.lower().count("</section>"):
        errors.append("A <section> is not closed.")
    for tag in tags:
        if "data-screen-label" not in tag:
            errors.append('A slide has no data-screen-label (for example "02 Problem").')
        if "data-nova-id" not in tag:
            errors.append("A slide has no data-nova-id.")
    plain = _CHART_SCRIPT_RE.sub("", slides_html)
    if _FORBIDDEN_TAG_RE.search(plain):
        errors.append(
            "Slides may not contain <script>, <iframe>, <object>, <embed>, <link>, <base>, "
            "<form> or <meta> (the one exception is <script data-nova-chart>, a chart's data)."
        )
    for script in _CHART_SCRIPT_RE.findall(slides_html):
        if "new Chart(" not in script:
            errors.append(
                "A <script data-nova-chart> must create a Chart.js chart with new Chart(...)."
            )
        if re.search(
            r"\b(fetch|XMLHttpRequest|import|eval|Function|WebSocket)\s*\(|\bdocument\.write",
            script,
        ):
            errors.append(
                "A <script data-nova-chart> may only configure its chart: the data goes in the "
                "script, nothing is fetched or evaluated."
            )
    if _EXTERNAL_RE.search(slides_html):
        errors.append(
            "Slides may not load anything from the web (images, fonts, @import): embed it or "
            "draw it with HTML/CSS/SVG."
        )
    ids = _ID_RE.findall(slides_html)
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        errors.append(f'data-nova-id "{dup}" is used more than once.')
    for bad in sorted({i for i in ids if not _ID_FORMAT.match(i)}):
        errors.append(f'data-nova-id "{bad}" must be lower-case words joined by hyphens.')
    if tags and "active" not in tags[0].split("class=", 1)[-1].split('"')[1].split():
        warnings.append('The first slide should have class="slide active ...".')
    return errors, warnings


# A built deck separates what the kit owns from what is the deck's own. The kit owns two marked
# regions (the theme's tokens inside the framework's ``:root``, and the layout vocabulary plus
# theme CSS in the first per-deck ``<style>``) and the embedded-font block. Everything outside
# the markers is the deck's: custom rules, custom tokens and overrides of a theme token (a later
# ``:root { --accent: ... }`` after the markers). A theme switch rewrites only the kit's regions
# and carries the rest over byte for byte, so a token override persists exactly because someone
# wrote it outside the kit's regions: the kit never writes there.
#
# Each open marker carries a hash of the region's content (``sha=``). A region that still matches
# its hash is the kit's and is replaced whole, whatever kit version wrote it. One that does not
# match was edited inside: its extra lines are moved after the close marker, where they are the
# deck's own, when they stay valid CSS there; otherwise the switch is refused (never dropped).
_TOKENS_OPEN = "      /* nova:theme-tokens id={id} sha={sha} */"
_TOKENS_CLOSE = "      /* /nova:theme-tokens */"
_CSS_OPEN = "    /* nova:theme id={id} sha={sha} \u00b7 {name} */"
_CSS_CLOSE = "    /* /nova:theme */"
_DECK_HINT = (
    "    /* Per-deck rules and token overrides (for example :root { --accent: ... }) go below,\n"
    "       after the closing nova:theme marker; a theme switch keeps everything outside the\n"
    "       markers. Do not edit between them. */"
)
_ROOT_RE = re.compile(r"    :root \{.*?\n    \}", re.S)
_TOKENS_RE = re.compile(
    r"      /\* nova:theme-tokens id=([a-z0-9-]+)(?: sha=([0-9a-f]{12}))? \*/\n"
    r"(.*?)\n      /\* /nova:theme-tokens \*/",
    re.S,
)
_CSS_RE = re.compile(
    r"    /\* nova:theme id=([a-z0-9-]+)(?: sha=([0-9a-f]{12}))? \u00b7 [^\n]*?\*/\n"
    r"(.*?)\n    /\* /nova:theme \*/",
    re.S,
)
_THEME_ID_RE = re.compile(r"/\* nova:theme id=([a-z0-9-]+)[ *]")
# Decks saved before the markers existed: one whole ``:root`` and one whole style block.
_LEGACY_STYLE_RE = re.compile(
    r"  <style>\n    /\* [^\n]*? \u00b7 layout vocabulary and theme \*/.*?\n  </style>", re.S
)
_LEGACY_NAME_RE = re.compile(r"/\* ([^\n]*?) \u00b7 layout vocabulary and theme \*/")
_PLACEHOLDER_STYLE_RE = re.compile(
    r"  <style>\n    /\* SLOT: per-deck styles.*?\n  </style>", re.S
)
_FONTS_RE = re.compile(r"  <style data-nova-fonts>.*?\n  </style>\n", re.S)


def _digest(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]


def _tokens_text(template: Template) -> str:
    return (template.directory / "tokens.css").read_text("utf-8").rstrip()


def _css_text(template: Template) -> str:
    theme = (template.directory / "theme.css").read_text("utf-8").strip()
    layouts = (KIT_DIR / "layouts.css").read_text("utf-8").strip()
    return f"{layouts}\n\n{theme}"


def _tokens_region(template: Template) -> str:
    text = _tokens_text(template)
    open_ = _TOKENS_OPEN.format(id=template.id, sha=_digest(text))
    return f"{open_}\n{text}\n{_TOKENS_CLOSE}"


def _css_region(template: Template) -> str:
    text = _css_text(template)
    open_ = _CSS_OPEN.format(id=template.id, sha=_digest(text), name=template.name)
    return f"{open_}\n{text}\n{_CSS_CLOSE}"


def _tokens_block(template: Template) -> str:
    return "    :root {\n" + _tokens_region(template) + "\n    }"


def _style_block(template: Template) -> str:
    return f"  <style>\n{_css_region(template)}\n{_DECK_HINT}\n  </style>"


def _fonts_block(template_id: str) -> str:
    return (
        "  <style data-nova-fonts>\n"
        "/* Embedded fonts (Latin subset, SIL OFL 1.1): never read or edit this block. */\n"
        f"{_font_faces_css(template_id)}\n  </style>\n"
    )


def build_deck(template_id: str, title: str, slides_html: str | None = None) -> str:
    """The complete deck document for ``template_id`` with ``slides_html`` (or a sample cover)."""
    template = templates().get(template_id)
    if template is None:
        raise KitError(f"Unknown template '{template_id}'. Use one of: {', '.join(templates())}")
    slides = (slides_html or (KIT_DIR / "slides.html").read_text("utf-8")).strip("\n")
    skeleton = (KIT_DIR / "skeleton.html").read_text("utf-8")

    deck = skeleton.replace(
        "<title><!-- SLOT: deck title --></title>",
        f"<title>{html.escape(title.strip())}</title>",
        1,
    )
    root = _ROOT_RE.search(deck)
    if root is None:
        raise KitError("skeleton: theme token block not found")
    deck = deck[: root.start()] + _tokens_block(template) + deck[root.end() :]
    styles = _PLACEHOLDER_STYLE_RE.search(deck)
    if styles is None:
        raise KitError("skeleton: per-deck style block not found")
    deck = deck[: styles.start()] + _style_block(template) + deck[styles.end() :]
    region = re.search(
        r"      <!-- SLOT: slides.*?(?=    </div>\n  </div>\n\n  <!-- Framework chrome)",
        deck,
        re.S,
    )
    if region is None:
        raise KitError("skeleton: slide region not found")
    deck = (
        deck[: region.start()]
        + f"      {SLOTS_OPEN}\n{slides}\n      {SLOTS_CLOSE}\n\n"
        + deck[region.end() :]
    )
    deck = deck.replace("</head>", _chart_runtime() + "</head>", 1)
    return deck.replace("</body>", _fonts_block(template_id) + "</body>", 1)


def _head(document: str) -> str:
    """The document up to ``</head>``: where the kit's markers live (slides cannot fake them)."""
    end = document.find("</head>")
    return document if end < 0 else document[:end]


def deck_theme_id(document: str) -> str | None:
    """The id of the theme a built deck carries (from its marker), if it is one of ours."""
    head = _head(document)
    found = _THEME_ID_RE.search(head)
    if found is not None:
        return found.group(1) if found.group(1) in templates() else None
    legacy = _LEGACY_NAME_RE.search(head)
    if legacy is None:
        return None
    return next((t.id for t in templates().values() if t.name == legacy.group(1)), None)


_INEXACT = "this deck's theme can't be swapped exactly; ask Nova to restyle it"
_EDITED = (
    "this deck's theme block was edited inside, in a way that can't be kept; "
    "ask Nova to restyle it"
)


def _only(
    pattern: re.Pattern[str], text: str, *, opens: str = "", closes: str = ""
) -> re.Match[str]:
    """The one match; zero, several or (given the markers) nested or stray markers are refused."""
    if (opens and text.count(opens) != 1) or (closes and text.count(closes) != 1):
        raise KitError(_INEXACT)
    found = list(pattern.finditer(text))
    if len(found) != 1:
        raise KitError(_INEXACT)
    return found[0]


def _extras(found: str, pristine: str) -> str:
    """The lines of ``found`` that are not (the kit's) ``pristine`` lines, in order."""
    spare: dict[str, int] = {}
    for line in pristine.splitlines():
        if line.strip():
            spare[line.strip()] = spare.get(line.strip(), 0) + 1
    kept = []
    for line in found.splitlines():
        key = line.strip()
        if not key:
            continue
        if spare.get(key, 0) > 0:
            spare[key] -= 1
        else:
            kept.append(line)
    return "\n".join(kept)


_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
_DECL_RE = re.compile(r"^\s*--[a-zA-Z0-9_-]+\s*:[^;{}]*;\s*$")


def _valid_tokens(extras: str) -> bool:
    """Extra token lines are still whole ``--name: value;`` declarations (or comments)."""
    return all(
        not line.strip() or _DECL_RE.match(line)
        for line in _COMMENT_RE.sub("", extras).splitlines()
    )


def _valid_css(extras: str) -> bool:
    """Extra CSS is whole top-level rules: braces close, nothing bare sits between them."""
    depth = 0
    for char in _COMMENT_RE.sub("", extras):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth < 0:
                return False
        elif char == ";" and depth == 0:
            return False
    stripped = _COMMENT_RE.sub("", extras).strip()
    return depth == 0 and (not stripped or stripped.endswith("}"))


@cache
def _legacy_kits() -> dict[str, list[dict[str, str]]]:
    """The block texts every released kit wrote before the markers existed, by theme id."""
    return json.loads((KIT_DIR / "legacy.json").read_text("utf-8"))


def _adopt_markers(document: str, template: Template) -> str:
    """A deck saved before the markers existed, with the kit's regions marked and the rest kept.

    The block is recognised against every released kit text for its theme (the kit has changed
    since); what the deck added around it is kept in place. A block edited inside keeps its extra
    lines after the markers when they stay valid there, and is refused otherwise.
    """
    candidates = [
        *_legacy_kits().get(template.id, []),
        {"tokens": _tokens_text(template), "css": _css_text(template)},
    ]
    head = f"    /* {template.name} \u00b7 layout vocabulary and theme */\n"
    root = _only(_ROOT_RE, document)
    block = root.group(0)
    exact = max(
        (c for c in candidates if c["tokens"] in block),
        key=lambda c: len(c["tokens"]),
        default=None,
    )
    if exact is not None:
        block = block.replace(exact["tokens"], _tokens_region(template), 1)
    else:
        inner = block[len("    :root {\n") : -len("\n    }")]
        best = min(candidates, key=lambda c: len(_extras(inner, c["tokens"])))
        extras = _extras(inner, best["tokens"])
        if not _valid_tokens(extras):
            raise KitError(_EDITED)
        block = (
            "    :root {\n"
            + _tokens_region(template)
            + ("\n" + extras if extras else "")
            + "\n    }"
        )
    document = document[: root.start()] + block + document[root.end() :]
    style = _only(_LEGACY_STYLE_RE, document)
    text = style.group(0)
    exact = max(
        (c for c in candidates if head + c["css"] in text),
        key=lambda c: len(c["css"]),
        default=None,
    )
    if exact is not None:
        text = text.replace(head + exact["css"], _css_region(template), 1)
    else:
        inner = text[len("  <style>\n" + head) : -len("\n  </style>")]
        best = min(candidates, key=lambda c: len(_extras(inner, c["css"])))
        extras = _extras(inner, best["css"])
        if not _valid_css(extras):
            raise KitError(_EDITED)
        text = (
            f"  <style>\n{_css_region(template)}\n{extras}\n  </style>"
            if extras
            else (f"  <style>\n{_css_region(template)}\n  </style>")
        )
    return document[: style.start()] + text + document[style.end() :]


def _refresh(
    document: str,
    pattern: re.Pattern[str],
    new_region: str,
    *,
    opens: str,
    closes: str,
    pristine_for: dict[str, str],
    valid: object,
) -> str:
    """Replace one kit region by the new theme's; keep the deck's lines of an edited one."""
    found = _only(pattern, document, opens=opens, closes=closes)
    theme_id, sha, content = found.group(1), found.group(2), found.group(3)
    intact = sha == _digest(content) if sha else content == pristine_for.get(theme_id)
    extras = ""
    if not intact:
        extras = _extras(content, pristine_for.get(theme_id, ""))
        if not valid(extras):  # type: ignore[operator]
            raise KitError(_EDITED)
    tail = f"\n{extras}" if extras else ""
    return document[: found.start()] + new_region + tail + document[found.end() :]


def restyle_deck(document: str, template_id: str) -> str:
    """The deck with its theme swapped; the kit's regions and fonts change, all else stays.

    :raises KitError: for an unknown theme, or a deck whose kit regions cannot be found exactly
        or were edited in a way that cannot be kept; it is then restyled by asking the Muse.
    """
    template = templates().get(template_id)
    if template is None:
        raise KitError(f"Unknown theme '{template_id}'. Use one of: {', '.join(templates())}")
    if _THEME_ID_RE.search(_head(document)) is None:
        current = deck_theme_id(document)
        if current is None:
            raise KitError(_INEXACT)
        document = _adopt_markers(document, templates()[current])
    out = _refresh(
        document,
        _TOKENS_RE,
        _tokens_region(template),
        opens="/* nova:theme-tokens id=",
        closes="/* /nova:theme-tokens */",
        pristine_for={t.id: _tokens_text(t) for t in templates().values()},
        valid=_valid_tokens,
    )
    out = _refresh(
        out,
        _CSS_RE,
        _css_region(template),
        opens="/* nova:theme id=",
        closes="/* /nova:theme */",
        pristine_for={t.id: _css_text(t) for t in templates().values()},
        valid=_valid_css,
    )
    fonts = _only(_FONTS_RE, out, opens="<style data-nova-fonts>")
    return out[: fonts.start()] + _fonts_block(template_id) + out[fonts.end() :]
