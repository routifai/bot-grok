"""Runner-side handler for ``deck_export``.

Runs where the Computer's Chromium is: fetches the deck from the server, hands it to the
``nova-deck-export`` helper (override with ``NOVA_DECK_EXPORT_HELPER``) and saves the produced
``.pptx`` / ``.pdf`` as a new artifact in the same chat.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

from omnigent.superchat._handler_http import HEX_ID_RE, error, finish, resolve_caller
from omnigent.superchat.artifact_kinds import MAX_ARTIFACT_BYTES
from omnigent.superchat.decks.names import deck_stem, is_deck_name
from omnigent.superchat.decks.tools import DECK_AUTHORING_TOOL_NAMES, DECK_EXPORT_FORMATS
from omnigent.superchat.feature import HandlerCtx

HELPER_ENV = "NOVA_DECK_EXPORT_HELPER"
HELPER_TIMEOUT_S = 180.0
_FORMAT_LABEL = {"pptx": "PowerPoint", "pdf": "PDF"}


async def run_helper(fmt: str, html: Path, out: Path | None = None) -> dict[str, Any] | str:
    """Run the helper (``pptx``/``pdf`` write ``out``, ``lint`` measures): JSON, or a sentence."""
    helper = os.environ.get(HELPER_ENV) or "nova-deck-export"
    try:
        proc = await asyncio.create_subprocess_exec(
            helper,
            "--format",
            fmt,
            "--html",
            str(html),
            *(["--out", str(out)] if out is not None else []),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return "Deck export isn't available on this Computer yet"
    except OSError as exc:
        return f"Deck export couldn't start: {exc}"
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=HELPER_TIMEOUT_S)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return "The export took too long and was stopped"
    lines = [ln for ln in stdout.decode("utf-8", "replace").splitlines() if ln.strip()]
    try:
        data = json.loads(lines[-1]) if lines else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return "The export didn't finish"
    if not data.get("ok"):
        return str(data.get("error") or "The export failed")[:300]
    return data


async def handle_deck_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Run one deck tool: the authoring tools (``deck_new``, ``deck_check``, ``deck_themes``,
    ``deck_theme_set``) write or restyle a deck, ``deck_export`` exports it.

    :param ctx: The call context.
    :param args: Parsed tool arguments.
    :returns: Tool output JSON string (``{"type": "artifact", ...}`` for an export).
    """
    if ctx.tool_name in DECK_AUTHORING_TOOL_NAMES:
        from omnigent.superchat.decks.authoring import handle_authoring_tool

        return await handle_authoring_tool(ctx.tool_name, args)
    return await _export(ctx, args)


async def _export(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """Export a saved deck and save the result as a new artifact (``deck_export``)."""
    caller = await resolve_caller(ctx)
    if isinstance(caller, str):
        return caller
    chat_id = caller.chat_id
    if not chat_id:
        return error("deck_export: no chat to attach to")
    artifact_id = args.get("artifact_id")
    fmt = args.get("format")
    if not isinstance(artifact_id, str) or not HEX_ID_RE.match(artifact_id):
        return error("deck_export requires a valid artifact_id")
    if fmt not in DECK_EXPORT_FORMATS:
        return error("deck_export format must be pptx or pdf")
    try:
        meta_resp = await caller.client.get(f"/v1/artifacts/{artifact_id}", timeout=30.0)
        if meta_resp.status_code >= 400:
            return finish(meta_resp)
        meta = meta_resp.json()
        if meta.get("parent_session_id") != chat_id:
            return error("That deck belongs to a different chat")
        name = str(meta.get("name") or "")
        if not is_deck_name(name):
            return error("That file isn't a deck (decks are saved as *.deck.html)")
        content = await caller.client.get(f"/v1/artifacts/{artifact_id}/content", timeout=60.0)
        if content.status_code >= 400:
            return finish(content)
        html = content.content
        with tempfile.TemporaryDirectory(prefix="nova-deck-") as tmp:
            src = Path(tmp) / "deck.html"
            out = Path(tmp) / f"deck.{fmt}"
            src.write_bytes(html)
            result = await run_helper(fmt, src, out)
            if isinstance(result, str):
                return error(result)
            produced = Path(str(result.get("path") or out))
            if not produced.is_file():
                return error("The export didn't produce a file")
            size = produced.stat().st_size
            if size == 0:
                return error("The export produced an empty file")
            if size > MAX_ARTIFACT_BYTES:
                return error(
                    f"The exported file is too large ({size // (1024 * 1024)} MB; 25 MB max)"
                )
            data = await asyncio.to_thread(produced.read_bytes)
        stem = re.sub(r"[\\/]", "_", deck_stem(name))
        title = f"{str(meta.get('title') or stem)[:230]} ({_FORMAT_LABEL[fmt]})"
        url = (
            f"/v1/artifacts?parent_session_id={chat_id}&name={quote(f'{stem}.{fmt}')}"
            f"&title={quote(title)}"
        )
        resp = await caller.client.post(
            url,
            content=data,
            headers={"Content-Type": "application/octet-stream"},
            timeout=120.0,
        )
    except Exception as exc:  # noqa: BLE001
        return error(f"deck_export failed: {exc}")
    if resp.status_code >= 400:
        return finish(resp)
    return json.dumps({"type": "artifact", **resp.json()})
