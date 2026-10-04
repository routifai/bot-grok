"""Runner-side handler for ``render_card``: validated and returned in-process, no server hop."""

from __future__ import annotations

import json
from typing import Any

from omnigent.superchat.cards.tools import build_card
from omnigent.superchat.feature import HandlerCtx


async def handle_card_tool(_ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Validate and echo a reply card.

    :param _ctx: The call context (unused).
    :param args: Parsed tool arguments.
    :returns: The card as a JSON string.
    """
    return json.dumps(build_card(args), ensure_ascii=False)
