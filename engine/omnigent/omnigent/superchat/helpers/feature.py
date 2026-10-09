"""Registration of the Helpers primitive (the ``start_helper`` tool)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.context.labels import is_superside_chat
from omnigent.superchat.feature import Feature, ToolManagerCtx
from omnigent.superchat.helpers.handlers import handle_start_helper, helper_type_for
from omnigent.superchat.helpers.saved_files import note_saved_file
from omnigent.superchat.helpers.tools import START_HELPER_TOOL_NAME, StartHelperTool

if TYPE_CHECKING:
    from omnigent.tools.base import Tool


def _tools(labels: Mapping[str, str] | None, ctx: ToolManagerCtx) -> list[Tool]:
    """Offered only where a Helper type is declared: the Muse, or a coordinating worker."""
    if not is_superside_chat(labels) or helper_type_for(ctx.spec) is None:
        return []
    return [StartHelperTool()]


HELPERS_FEATURE = Feature(
    name="helpers",
    tools=_tools,
    handlers={START_HELPER_TOOL_NAME: handle_start_helper},
    on_result=note_saved_file,
)
