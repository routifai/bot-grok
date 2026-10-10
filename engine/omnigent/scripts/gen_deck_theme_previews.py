"""Regenerate the theme gallery thumbnails (``kit/previews/<id>.webp``).

Builds two of the kit's sample slides in each theme, renders them in the same headless Chromium
the deck tests and the export use (``nova-deck-export``'s ``find_chromium``), and saves a small
WebP: the cover as a card over the main surface, at 2x the size a picker tile draws it. Run it
after changing a theme, from ``engine/omnigent``:
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

from PIL import Image, ImageDraw, ImageFilter

from omnigent.superchat.decks import kit

HELPER = Path(__file__).resolve().parents[3] / "infra/sandboxes/computer/nova-deck-export"
OUT = kit.KIT_DIR / "previews"
#: A thumbnail shows two sample slides at once: the theme's main surface (the agenda: title type,
#: cards, accent) behind its cover (the bold surface and display face), so light and dark themes,
#: and themes that share a cover colour, still read apart at a glance.
BACK_SLIDE, FRONT_SLIDE = "agenda", "cover"
WIDTH, HEIGHT = 640, 360
#: The cover's size and inset in the picture, as fractions of the picture.
FRONT_SCALE, FRONT_INSET = 0.56, 0.06


def _chromium() -> str:
    loader = importlib.machinery.SourceFileLoader("nova_deck_export", str(HELPER))
    spec = importlib.util.spec_from_loader("nova_deck_export", loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module.find_chromium()


def _only_slide(slides: str, slide_id: str) -> str:
    """The sample slide ``slide_id`` alone (and active)."""
    parts = re.split(r"(?=\s*<section\b)", slides)
    chosen = next(p for p in parts if f'data-nova-id="{slide_id}"' in p.split(">", 1)[0])
    return re.sub(r'class="slide( active)?', 'class="slide active', chosen, count=1).strip()


def _shoot(chrome: str, tmp: Path, template_id: str, slide: str, name: str) -> Image.Image:
    """One slide of the theme, rendered at its authored 1920x1080."""
    page = tmp / f"{name}.html"
    deck = kit.build_deck(template_id, "Quarterly review", slide)
    # data-nova-export is what the exporter sets: the stage stays at its authored 1920x1080
    # instead of being scaled to fit (which would leave a letterbox in the picture).
    page.write_text(deck.replace("<html ", "<html data-nova-export ", 1), "utf-8")
    shot = tmp / f"{name}.png"
    subprocess.run(
        [
            chrome,
            "--headless=new",
            "--no-sandbox",
            "--hide-scrollbars",
            f"--user-data-dir={tmp / 'profile'}",
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
        return image.convert("RGB")


def _compose(back: Image.Image, front: Image.Image) -> Image.Image:
    """The cover as a rounded card over the main surface, bottom right, with a soft shadow."""
    scale = 2  # draw at 2x, then downsample once for clean edges
    width, height = WIDTH * scale, HEIGHT * scale
    canvas = back.resize((width, height), Image.Resampling.LANCZOS)
    fw, fh = round(width * FRONT_SCALE), round(height * FRONT_SCALE)
    card = front.resize((fw, fh), Image.Resampling.LANCZOS)
    x = width - fw - round(width * FRONT_INSET)
    y = height - fh - round(height * FRONT_INSET * 16 / 9)
    radius = round(fh * 0.045)
    mask = Image.new("L", (fw, fh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, fw - 1, fh - 1), radius, fill=255)
    shadow = Image.new("L", (width, height), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x, y + 10, x + fw, y + fh + 10), radius, fill=90)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    canvas = Image.composite(Image.new("RGB", canvas.size, (0, 0, 0)), canvas, shadow)
    canvas.paste(card, (x, y), mask)
    return canvas.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)


def main() -> None:
    chrome = _chromium()
    sample = (kit.KIT_DIR / "sample-slides.html").read_text("utf-8")
    back_slide, front_slide = _only_slide(sample, BACK_SLIDE), _only_slide(sample, FRONT_SLIDE)
    OUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        for template_id in kit.templates():
            back = _shoot(chrome, tmp, template_id, back_slide, f"{template_id}-back")
            front = _shoot(chrome, tmp, template_id, front_slide, f"{template_id}-front")
            out = OUT / f"{template_id}.webp"
            _compose(back, front).save(out, "WEBP", quality=82, method=6)
            print(template_id, out.stat().st_size, file=sys.stderr)


if __name__ == "__main__":
    main()
