"""Built-in ``render_card`` tool: show the person a structured card instead of prose.

The model *decides* when a card reads better than text (numbers to compare, a quote, a plan
it will update, a decision with options, sources it read). The tool validates the input
against one small JSON schema per card kind and returns a typed ``{"type": "card", ...}``
payload that clients render with their own component catalog; the required ``fallback``
markdown rides along so the model's history (and any client without the catalog) has text.

The runner dispatches this locally (``_execute_card_tool``); no server round-trip.
"""

from __future__ import annotations

import json
from typing import Any

from omnigent.tools.base import Tool, ToolContext

CARD_TOOL_NAME = "render_card"

_STR: dict[str, Any] = {"type": "string"}
_NUM: dict[str, Any] = {"type": "number"}


def _obj(required: list[str], **props: Any) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": False,
    }


def _shape(schema: dict[str, Any]) -> str:
    """Compact human-readable shape of a JSON schema, e.g. ``{items: [{title, url}]}``."""
    kind = schema.get("type")
    if kind == "object":
        required = set(schema.get("required", ()))
        fields = ", ".join(
            f"{k}{'' if k in required else '?'}: {_shape(v)}"
            for k, v in schema.get("properties", {}).items()
        )
        return "{" + fields + "}"
    if kind == "array":
        return "[" + _shape(schema["items"]) + "]"
    return str(kind)


def _kind_hints() -> str:
    return "; ".join(f"{kind} {_shape(s)}" for kind, s in CARD_DATA_SCHEMAS.items())


# Kinds that are the answer itself. ``plan`` and ``progress`` are living cards the Muse
# re-renders (same ``id``) while it works, so they never end the reply; ``ask`` waits on
# the person's pick.
_TERMINAL_CARDS = frozenset({"sources", "compare", "ask", "chart", "person", "file", "quote"})


def _arr(items: dict[str, Any], *, min_items: int = 1, max_items: int = 50) -> dict[str, Any]:
    return {"type": "array", "items": items, "minItems": min_items, "maxItems": max_items}


# One schema per kind. These are both the model-facing schema and the validator's source.
CARD_DATA_SCHEMAS: dict[str, dict[str, Any]] = {
    "sources": _obj(
        ["items"],
        items=_arr(_obj(["title", "url"], title=_STR, url=_STR, snippet=_STR)),
    ),
    "compare": _obj(
        ["columns", "rows"],
        columns=_arr(_STR, max_items=8),
        rows=_arr(_obj(["label", "cells"], label=_STR, cells=_arr(_STR, max_items=8))),
    ),
    "plan": _obj(
        ["items"],
        items=_arr(
            _obj(
                ["text", "status"],
                text=_STR,
                status={"type": "string", "enum": ["todo", "doing", "done"]},
            )
        ),
    ),
    "ask": _obj(
        ["question", "options"],
        question=_STR,
        options=_arr(_obj(["id", "label"], id=_STR, label=_STR), max_items=8),
        allowFreeText={"type": "boolean"},
    ),
    "quote": _obj(
        ["symbol", "price"],
        symbol=_STR,
        name=_STR,
        price=_NUM,
        currency=_STR,
        change=_NUM,
        changePct=_NUM,
        asOf=_STR,
        source=_STR,
    ),
    "chart": _obj(
        ["kind", "x", "series"],
        kind={"type": "string", "enum": ["line", "bar"]},
        x=_arr(_STR, max_items=120),
        series=_arr(
            _obj(["name", "values"], name=_STR, values=_arr(_NUM, max_items=120)), max_items=4
        ),
        unit=_STR,
    ),
    "person": _obj(["name"], name=_STR, role=_STR, org=_STR, email=_STR, phone=_STR, url=_STR),
    "file": _obj(
        ["name"],
        name=_STR,
        url=_STR,
        kind=_STR,
        size=_NUM,
        artifactId=_STR,
        version=_NUM,
        versions=_NUM,
    ),
    "progress": _obj(
        ["label", "value", "status"],
        label=_STR,
        value={"type": "number", "minimum": 0, "maximum": 100},
        status={"type": "string", "enum": ["running", "done", "failed"]},
    ),
}

_JSON_TYPES: dict[str, type | tuple[type, ...]] = {
    "string": str,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _check(value: Any, schema: dict[str, Any], path: str) -> str | None:
    """Return the first violation of the supported JSON-schema subset, or ``None``."""
    kind = schema["type"]
    expected = _JSON_TYPES[kind]
    if not isinstance(value, expected) or (kind == "number" and isinstance(value, bool)):
        return f"{path} must be a {kind}"
    if "enum" in schema and value not in schema["enum"]:
        return f"{path} must be one of {', '.join(schema['enum'])}"
    if kind == "number":
        if "minimum" in schema and value < schema["minimum"]:
            return f"{path} must be >= {schema['minimum']}"
        if "maximum" in schema and value > schema["maximum"]:
            return f"{path} must be <= {schema['maximum']}"
    if kind == "array":
        if not schema["minItems"] <= len(value) <= schema["maxItems"]:
            return f"{path} needs {schema['minItems']}-{schema['maxItems']} items"
        for i, item in enumerate(value):
            if (err := _check(item, schema["items"], f"{path}[{i}]")) is not None:
                return err
    if kind == "object":
        props = schema["properties"]
        for key in schema["required"]:
            if key not in value:
                return f"{path}.{key} is required"
        for key, item in value.items():
            if key not in props:
                return f"{path}.{key} is not allowed"
            if (err := _check(item, props[key], f"{path}.{key}")) is not None:
                return err
    return None


def card_catalog() -> list[dict[str, Any]]:
    """
    The render_card catalog: every card kind with the JSON schema of its ``data``.

    :returns: ``[{"kind", "ends_reply", "data_schema"}]`` in catalog order; ``ends_reply`` is
        true for answer cards and false for living cards (plan, progress) updated in place.
    """
    return [
        {"kind": kind, "ends_reply": kind in _TERMINAL_CARDS, "data_schema": schema}
        for kind, schema in CARD_DATA_SCHEMAS.items()
    ]


def build_card(args: dict[str, Any]) -> dict[str, Any]:
    """
    Validate ``render_card`` arguments and build the typed result payload.

    :param args: Parsed tool arguments.
    :returns: ``{"type": "card", "card", "id"?, "title"?, "data", "fallback"}``, or
        ``{"error": "..."}`` describing the first problem so the model can retry.
    """
    card = args.get("card")
    if card not in CARD_DATA_SCHEMAS:
        return {"error": f"card must be one of {', '.join(CARD_DATA_SCHEMAS)}"}
    fallback = args.get("fallback")
    if not isinstance(fallback, str) or not fallback.strip():
        return {"error": "fallback must be a non-empty markdown string"}
    for key in ("id", "title"):
        if key in args and not isinstance(args[key], str):
            return {"error": f"{key} must be a string"}
    err = _check(args.get("data"), CARD_DATA_SCHEMAS[card], "data")
    if err is not None:
        return {"error": err}
    out: dict[str, Any] = {"type": "card", "card": card}
    out.update({key: args[key] for key in ("id", "title") if args.get(key)})
    out["data"] = args["data"]
    out["fallback"] = fallback.strip()
    # The model reacts to a tool result; without this it adds a line repeating the card.
    # Plan/progress cards are updated in place mid-work, so they must not stop the turn.
    if card in _TERMINAL_CARDS:
        out["note"] = (
            "Shown to the person. A card ends your reply: end your turn now, with no more text."
        )
    else:
        out["note"] = "Shown to the person. Do not repeat it in text; carry on with the work."
    return out


class RenderCardTool(Tool):
    """Show the person one structured card; the runner dispatches it locally."""

    @classmethod
    def name(cls) -> str:
        """:returns: The tool name."""
        return CARD_TOOL_NAME

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Show the person a card instead of prose, only when it reads better than text: "
            "numbers to compare (compare), a market quote (quote), a plan you will update "
            "(plan), a decision with options (ask), sources you read (sources), a series "
            "(chart), a contact (person), a file (file), long-running work (progress). "
            "Otherwise write normally. `data` is an object whose shape depends on `card` "
            f"(`?` = optional): {_kind_hints()}. "
            "`fallback` is a complete markdown summary of the card, used where it cannot be "
            "drawn and kept in your history; never repeat the card's content in your reply, "
            "add one line of context at most, before the card; the card ends your reply. "
            "Reuse the same `id` to update a plan or progress card in place."
        )

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "card": {"type": "string", "enum": list(CARD_DATA_SCHEMAS)},
                        "id": {
                            "type": "string",
                            "description": "Stable id; reuse it to update the card in place.",
                        },
                        "title": {"type": "string", "description": "Optional short heading."},
                        "data": {
                            "type": "object",
                            "description": "Card payload; shapes are in the tool description.",
                        },
                        "fallback": {
                            "type": "string",
                            "description": "Markdown summary of the whole card.",
                        },
                    },
                    "required": ["card", "data", "fallback"],
                    "additionalProperties": False,
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        """
        Validate *arguments* and return the card payload as JSON.

        :param arguments: JSON-encoded arguments from the LLM.
        :param ctx: Unused.
        :returns: JSON string: the card payload, or ``{"error": ...}``.
        """
        try:
            args = json.loads(arguments)
        except json.JSONDecodeError:
            return json.dumps({"error": "arguments must be a JSON object"})
        if not isinstance(args, dict):
            return json.dumps({"error": "arguments must be a JSON object"})
        return json.dumps(build_card(args), ensure_ascii=False)
