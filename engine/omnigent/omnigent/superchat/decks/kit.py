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
import html
import json
import re
from dataclasses import dataclass
from functools import cache, lru_cache
from pathlib import Path

KIT_DIR = Path(__file__).parent / "kit"
TEMPLATES_DIR = KIT_DIR / "templates"
CHARTS_DIR = KIT_DIR / "charts"
CHARTJS_PATH = KIT_DIR / "vendor" / "chart.js" / "chart.umd.js"

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
            fonts=tuple(data["fonts"]),
        )
    return found


def template_summaries() -> list[dict[str, str]]:
    """``[{id, name, description, best_for}]`` for the Muse to choose from."""
    return [
        {"id": t.id, "name": t.name, "description": t.description, "best_for": t.best_for}
        for t in templates().values()
    ]


@cache
def _font_faces_css(template_id: str) -> str:
    """The template's ``@font-face`` rules with the font files inlined as data URIs."""
    template = templates()[template_id]
    rules = []
    for font in template.fonts:
        path = template.directory / "fonts" / str(font["file"])
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


def build_deck(template_id: str, title: str, slides_html: str | None = None) -> str:
    """The complete deck document for ``template_id`` with ``slides_html`` (or a sample cover)."""
    template = templates().get(template_id)
    if template is None:
        raise KitError(f"Unknown template '{template_id}'. Use one of: {', '.join(templates())}")
    slides = (slides_html or (KIT_DIR / "slides.html").read_text("utf-8")).strip("\n")
    skeleton = (KIT_DIR / "skeleton.html").read_text("utf-8")
    tokens = (template.directory / "tokens.css").read_text("utf-8").rstrip()
    theme = (template.directory / "theme.css").read_text("utf-8").strip()
    layouts = (KIT_DIR / "layouts.css").read_text("utf-8").strip()

    deck = skeleton.replace(
        "<title><!-- SLOT: deck title --></title>",
        f"<title>{html.escape(title.strip())}</title>",
        1,
    )
    root = re.search(r"    :root \{.*?\n    \}", deck, re.S)
    if root is None:
        raise KitError("skeleton: theme token block not found")
    deck = deck[: root.start()] + "    :root {\n" + tokens + "\n    }" + deck[root.end() :]
    styles = re.search(r"  <style>\n    /\* SLOT: per-deck styles.*?\n  </style>", deck, re.S)
    if styles is None:
        raise KitError("skeleton: per-deck style block not found")
    head = f"  <style>\n    /* {template.name} · layout vocabulary and theme */"
    block = f"{head}\n{layouts}\n\n{theme}\n  </style>"
    deck = deck[: styles.start()] + block + deck[styles.end() :]
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
    fonts = (
        "  <style data-nova-fonts>\n"
        "/* Embedded fonts (Latin subset, SIL OFL 1.1): never read or edit this block. */\n"
        f"{_font_faces_css(template_id)}\n  </style>\n"
    )
    return deck.replace("</body>", fonts + "</body>", 1)
