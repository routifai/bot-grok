"""Runner-side handlers for ``deck_new`` and ``deck_check``: authoring a deck that exports exactly.

``deck_new`` assembles the deck file (skeleton, template, embedded fonts, the Muse's slides) so the
model only ever writes slides; ``deck_check`` measures the laid-out deck in the Computer's Chromium
(the same render the PowerPoint export reads) and reports what would not survive one-to-one.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from omnigent.superchat._handler_http import error
from omnigent.superchat.artifacts import workspace_roots
from omnigent.superchat.decks import kit
from omnigent.superchat.decks.handlers import run_helper
from omnigent.superchat.decks.look import HELPER_REFUSAL, look_card, verify_look
from omnigent.superchat.decks.names import DECK_SUFFIX, is_deck_name

if TYPE_CHECKING:
    from omnigent.superchat.feature import HandlerCtx

_MAX_LISTED = 25
_SEVERITY_BUCKET = {"error": "errors", "warning": "warnings", "note": "notes"}


def _resolve(raw: str, *, must_exist: bool) -> Path | str:
    """The deck file path under a workspace root, or an error sentence."""
    if not is_deck_name(Path(raw).name):
        return f"The file name must end with {DECK_SUFFIX}"
    roots = workspace_roots()
    if not roots:
        return "There is no workspace to write in"
    given = Path(raw).expanduser()
    candidates = [given] if given.is_absolute() else [root / given for root in roots]
    for candidate in candidates:
        try:
            real = candidate.resolve()
        except OSError:
            continue
        if not any(real.is_relative_to(root) for root in roots):
            continue
        if real.is_file() or not must_exist:
            return real
    if must_exist:
        return f"File not found: {raw}"
    return "The path must be inside your workspace"


def _issue_line(issue: dict[str, Any]) -> str:
    where = f"Slide {issue.get('slide')}"
    label = str(issue.get("label") or "")
    if label:
        where += f" ({label.split(' ', 1)[-1]})"
    target = f" [{issue['id']}]" if issue.get("id") else ""
    return f"{where}{target}: {issue.get('message')}"


async def _layout_report(path: Path) -> dict[str, Any]:
    """Measure the deck in Chromium: ``errors``, ``warnings``, ``notes``, ``layout_checked``."""
    result = await run_helper("lint", path)
    if isinstance(result, str):
        return {"layout_checked": False, "layout_note": result}
    buckets: dict[str, list[str]] = {"errors": [], "warnings": [], "notes": []}
    for issue in result.get("issues") or []:
        bucket = _SEVERITY_BUCKET.get(str(issue.get("severity")), "warnings")
        buckets[bucket].append(_issue_line(issue))
    out: dict[str, Any] = {"layout_checked": True, "slides": result.get("slides")}
    for key, lines in buckets.items():
        out[key] = lines[:_MAX_LISTED]
        if len(lines) > _MAX_LISTED:
            out[key].append(f"...and {len(lines) - _MAX_LISTED} more")
    return out


def _verdict(report: dict[str, Any]) -> dict[str, Any]:
    ok = not report.get("errors")
    report["ok"] = ok
    report["next"] = (
        "Layout is clean. Save it with artifact_save, then the person can export it."
        if ok
        else "Fix the errors in the file (edit the slides), then run deck_check again."
    )
    return report


async def handle_deck_new(args: dict[str, Any], ctx: HandlerCtx | None = None) -> str:
    """Assemble a new deck file from a template and the Muse's slides, then check it.

    Only in a look the person chose (:mod:`~omnigent.superchat.decks.look`): otherwise nothing is
    built and the "Which look?" card is returned instead, which ends the turn.
    """
    raw = args.get("path")
    template = args.get("template")
    title = args.get("title")
    slides = args.get("slides")
    if not isinstance(raw, str) or not raw.strip():
        return error("deck_new requires a path ending in .deck.html")
    if not isinstance(title, str) or not title.strip():
        return error("deck_new requires a title")
    if not isinstance(template, str) or template not in kit.templates():
        return error(f"deck_new template must be one of: {', '.join(kit.templates())}")
    check = await verify_look(ctx, args.get("look_from"), template)
    if check.problem is not None:
        if check.in_helper:  # no one would see a card: the Helper reports back, the Muse asks
            return error(f"{HELPER_REFUSAL} ({check.problem})")
        hint = f"{title} {check.message}"
        card = look_card(check.problem, hint, seed=f"{check.chat}|{hint}", avoid=check.declined)
        return json.dumps(card, ensure_ascii=False)
    if not isinstance(slides, str) or not slides.strip():
        return json.dumps(
            {
                "ok": True,
                "written": False,
                "note": (
                    "No slides were given, so nothing was written. "
                    "Call deck_new again with the slides."
                ),
                "layouts": kit.menu(),
            }
        )
    target = _resolve(raw.strip(), must_exist=False)
    if isinstance(target, str):
        return error(target)
    if target.exists():
        return error(
            f"{raw} already exists. Edit its slides in place (never rewrite the whole file), "
            "then run deck_check."
        )
    errors, warnings = kit.check_slides(slides)
    if errors:
        return json.dumps({"ok": False, "written": False, "errors": errors, "warnings": warnings})
    try:
        document = kit.build_deck(template, title, slides)
    except kit.KitError as exc:
        return error(str(exc))
    await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
    await asyncio.to_thread(target.write_text, document, "utf-8")
    report = await _layout_report(target)
    report["errors"] = report.get("errors", [])
    report["warnings"] = warnings + report.get("warnings", [])
    report.update(written=True, path=str(target))
    return json.dumps(_verdict(report))


async def handle_deck_check(args: dict[str, Any]) -> str:
    """Check an existing deck file: structure, ids, and layout in Chromium."""
    raw = args.get("path")
    if not isinstance(raw, str) or not raw.strip():
        return error("deck_check requires the deck's path")
    target = _resolve(raw.strip(), must_exist=True)
    if isinstance(target, str):
        return error(target)
    document = await asyncio.to_thread(target.read_text, "utf-8")
    start = document.find(kit.SLOTS_OPEN)
    end = document.find(kit.SLOTS_CLOSE)
    region = document[start + len(kit.SLOTS_OPEN) : end] if 0 <= start < end else document
    errors, warnings = kit.check_slides(region)
    # A scratch copy keeps the check independent of how the file is served.
    with tempfile.TemporaryDirectory(prefix="nova-deck-check-") as tmp:
        copy = Path(tmp) / "deck.html"
        copy.write_text(document, "utf-8")
        report = await _layout_report(copy)
    report["errors"] = errors + report.get("errors", [])
    report["warnings"] = warnings + report.get("warnings", [])
    report["path"] = str(target)
    return json.dumps(_verdict(report))


async def handle_deck_themes(_args: dict[str, Any]) -> str:
    """The theme dictionary: what the Muse picks from."""
    return json.dumps({"ok": True, "themes": kit.theme_dictionary(), "default": kit.DEFAULT_THEME})


async def handle_deck_theme_set(args: dict[str, Any]) -> str:
    """Swap a workspace deck's theme (slides untouched), then re-check the layout."""
    raw = args.get("path")
    theme_id = args.get("theme_id")
    if not isinstance(raw, str) or not raw.strip():
        return error("deck_theme_set requires the deck's path")
    if not isinstance(theme_id, str) or theme_id not in kit.templates():
        return error(f"deck_theme_set theme_id must be one of: {', '.join(kit.templates())}")
    target = _resolve(raw.strip(), must_exist=True)
    if isinstance(target, str):
        return error(target)
    document = await asyncio.to_thread(target.read_text, "utf-8")
    before = kit.deck_theme_id(document)
    if before == theme_id:
        return json.dumps({"ok": True, "changed": False, "theme": theme_id, "path": str(target)})
    try:
        restyled = kit.restyle_deck(document, theme_id)
    except kit.KitError as exc:
        return error(str(exc))
    await asyncio.to_thread(target.write_text, restyled, "utf-8")
    report = await _layout_report(target)
    report["errors"] = report.get("errors", [])
    report.update(changed=True, theme=theme_id, previous=before, path=str(target))
    return json.dumps(_verdict(report))


async def handle_authoring_tool(
    tool_name: str, args: dict[str, Any], ctx: HandlerCtx | None = None
) -> str:
    """Dispatch ``deck_new`` / ``deck_check`` / ``deck_themes`` / ``deck_theme_set``."""
    try:
        if tool_name == "deck_new":
            return await handle_deck_new(args, ctx)
        if tool_name == "deck_themes":
            return await handle_deck_themes(args)
        if tool_name == "deck_theme_set":
            return await handle_deck_theme_set(args)
        return await handle_deck_check(args)
    except Exception as exc:  # noqa: BLE001
        return error(f"{tool_name} failed: {exc}")


__all__ = [
    "handle_authoring_tool",
    "handle_deck_check",
    "handle_deck_new",
    "handle_deck_theme_set",
    "handle_deck_themes",
]
