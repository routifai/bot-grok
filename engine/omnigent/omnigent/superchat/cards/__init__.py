"""Reply cards (``render_card``): validated and rendered by the client, Super Chat only.

Layout: ``tools`` (tool def + card schemas + validation), ``handlers`` (runner side).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.cards.handlers import handle_card_tool
from omnigent.superchat.cards.tools import CARD_TOOL_NAME
from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx, is_super_chat

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """``render_card`` for the Super Chat itself (never a Helper)."""
    from omnigent.superchat.cards.tools import RenderCardTool

    return [RenderCardTool()] if is_super_chat(labels) else []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.superchat.cards.routes import create_cards_router

    app.include_router(
        create_cards_router(auth_provider=deps.auth_provider), prefix="/v1", tags=["cards"]
    )


FEATURE = Feature(
    name="cards", tools=_tools, handlers={CARD_TOOL_NAME: handle_card_tool}, install=_install
)
