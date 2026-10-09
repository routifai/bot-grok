"""Regenerate the theme gallery thumbnails (``kit/previews/<id>.webp``).

Builds the kit's sample deck in each theme, shows one sample slide in the same headless Chromium
the deck tests and the export use (``nova-deck-export``'s ``find_chromium``), and saves a small
WebP. Run it after changing a theme, from ``engine/omnigent``:
``PYTHONPATH=. .venv/bin/python scripts/gen_deck_theme_previews.py``.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

from omnigent.superchat.decks import kit

HELPER = Path(__file__).resolve().parents[3] / "infra/sandboxes/computer/nova-deck-export"
OUT = kit.KIT_DIR / "previews"
#: Which sample slide represents a theme: the numbers slide, on the theme's main surface.
SLIDE_INDEX = 4
WIDTH, HEIGHT = 480, 270


def _chromium() -> str:
    loader = importlib.machinery.SourceFileLoader("nova_deck_export", str(HELPER))
    spec = importlib.util.spec_from_loader("nova_deck_export", loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module.find_chromium()


def _only_slide(slides: str, index: int) -> str:
    """The sample slides with just slide ``index`` kept (and active)."""
    parts = re.split(r"(?=\s*<section\b)", slides)
    sections = [p for p in parts if "<section" in p]
    chosen = sections[index]
    return re.sub(r'class="slide( active)?', 'class="slide active', chosen, count=1).strip()


def main() -> None:
    chrome = _chromium()
    sample = (kit.KIT_DIR / "sample-slides.html").read_text("utf-8")
    slides = _only_slide(sample, SLIDE_INDEX)
    OUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for template_id in kit.templates():
            page = Path(tmp) / f"{template_id}.html"
            deck = kit.build_deck(template_id, "Quarterly review", slides)
            # data-nova-export is what the exporter sets: the stage stays at its authored 1920x1080
            # instead of being scaled to fit (which would leave a letterbox in the picture).
            deck = deck.replace("<html ", "<html data-nova-export ", 1)
            page.write_text(deck, "utf-8")
            shot = Path(tmp) / f"{template_id}.png"
            subprocess.run(
                [
                    chrome,
                    "--headless=new",
                    "--no-sandbox",
                    "--hide-scrollbars",
                    "--force-device-scale-factor=1",
                    "--window-size=1920,1080",
                    "--virtual-time-budget=1500",
                    f"--screenshot={shot}",
                    page.as_uri(),
                ],
                check=True,
                capture_output=True,
                timeout=60,
            )
            with Image.open(shot) as image:
                image.convert("RGB").resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS).save(
                    OUT / f"{template_id}.webp", "WEBP", quality=80, method=6
                )
            print(template_id, (OUT / f"{template_id}.webp").stat().st_size, file=sys.stderr)


if __name__ == "__main__":
    main()
