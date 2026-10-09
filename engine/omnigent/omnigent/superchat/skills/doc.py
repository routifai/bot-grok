"""Taught skills: the draft document, the brief that distills a recording, and replay text.

Pure functions, no I/O. A skill document is a dict::

    {
      "name": "Search a product",
      "goal": "Find a product on the shop site and report its price",
      "preconditions": ["Signed in to the shop"],
      "inputs": [{"name": "product", "label": "Product", "default": "laptop stand"}],
      "steps": [
        {"intent": "Search for {{product}}", "check": "Results list shows matching items",
         "approval": false, "keyframe": "k2",
         "hint": {"role": "searchbox", "name": "Search products", "selector": "#q"}}
      ],
      "returns": "The cheapest matching price"
    }

``{{input}}`` placeholders in preconditions and steps are filled from the run's inputs.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

MAX_STEPS = 60
MAX_INPUTS = 12
_NAME_MAX = 80
_TEXT_MAX = 300
_HINT_KEYS = ("role", "name", "selector", "url")
_INPUT_NAME_RE = re.compile(r"[^a-z0-9_]+")
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-z][a-z0-9_]*)\s*\}\}")
MAX_BRIEF_KEYFRAMES = 6


def _text(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _text_list(raw: Any, limit: int) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [t for t in (_text(item, _TEXT_MAX) for item in raw) if t][:limit]


def _normalize_input(raw: Any) -> dict[str, str] | None:
    if isinstance(raw, str):
        raw = {"name": raw}
    if not isinstance(raw, dict):
        return None
    name = _INPUT_NAME_RE.sub("_", str(raw.get("name", "")).strip().lower()).strip("_")
    if not name or not name[0].isalpha():
        return None
    out = {
        "name": name[:31],
        "label": _text(raw.get("label"), 80) or name.replace("_", " ").capitalize(),
        "default": _text(raw.get("default"), 200),
    }
    description = _text(raw.get("description"), _TEXT_MAX)
    if description:
        out["description"] = description
    return out


def _normalize_step(raw: Any, keyframes: set[str] | None) -> dict[str, Any] | None:
    if isinstance(raw, str):
        raw = {"intent": raw}
    if not isinstance(raw, dict):
        return None
    intent = _text(raw.get("intent"), _TEXT_MAX)
    if not intent:
        return None
    step: dict[str, Any] = {
        "intent": intent,
        "check": _text(raw.get("check"), _TEXT_MAX),
        "approval": bool(raw.get("approval")),
        "keyframe": None,
    }
    frame = raw.get("keyframe")
    if isinstance(frame, str) and (keyframes is None or frame in keyframes):
        step["keyframe"] = frame
    hint = raw.get("hint")
    if isinstance(hint, dict):
        clean = {k: _text(hint.get(k), 160) for k in _HINT_KEYS if _text(hint.get(k), 160)}
        if clean:
            step["hint"] = clean
    return step


def normalize_doc(raw: Any, *, keyframes: set[str] | None = None) -> dict[str, Any]:
    """
    Validate and tidy a skill document.

    :param raw: The document as written by the Helper or edited by the person.
    :param keyframes: Keyframe names that exist; a step's other references are dropped.
        ``None`` keeps any well-formed reference.
    :returns: The normalized document.
    :raises ValueError: When the document has no name or no usable step.
    """
    if not isinstance(raw, dict):
        raise ValueError("a skill document must be an object")
    name = _text(raw.get("name"), _NAME_MAX)
    if not name:
        raise ValueError("a skill needs a name")
    raw_steps = raw.get("steps")
    steps = [
        s
        for s in (_normalize_step(item, keyframes) for item in (raw_steps or []))
        if s is not None
    ][:MAX_STEPS]
    if not steps:
        raise ValueError("a skill needs at least one step")
    inputs: list[dict[str, str]] = []
    for item in raw.get("inputs") or []:
        normalized = _normalize_input(item)
        if normalized and all(normalized["name"] != i["name"] for i in inputs):
            inputs.append(normalized)
    return {
        "name": name,
        "goal": _text(raw.get("goal"), 500),
        "preconditions": _text_list(raw.get("preconditions"), 10),
        "inputs": inputs[:MAX_INPUTS],
        "steps": steps,
        "returns": _text(raw.get("returns"), 500),
    }


def resolve_inputs(
    doc: Mapping[str, Any], provided: Mapping[str, Any] | None
) -> tuple[dict[str, str], list[str]]:
    """
    Fill a skill's inputs for one run.

    :param doc: A normalized document.
    :param provided: Values for this run by input name; a blank value falls back to the demo
        default the skill was taught with.
    :returns: ``(values, missing)``; ``missing`` names inputs with neither a value nor a default.
    """
    values: dict[str, str] = {}
    missing: list[str] = []
    given = provided or {}
    for item in doc.get("inputs", []):
        name = item["name"]
        value = _text(given.get(name), 500) or item.get("default", "")
        if value:
            values[name] = value
        else:
            missing.append(name)
    return values, missing


def _fill(text: str, values: Mapping[str, str]) -> str:
    return _PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), m.group(0)), text)


_RUN_NOTES = (
    "Work through the steps in order with the browser tools, finding elements by role and "
    "name; a hint is only a hint, never a coordinate. After each step check its Check before "
    "moving on. Ask the person before any step marked as needing approval. If a step cannot "
    "be done or its check fails, stop, say what you see and what you need, and ask the person "
    "to take over the Computer if they have to do it; continue once they hand it back. Never "
    "guess a password or code; a login or secret is the person's to enter."
)


def render_skill(doc: Mapping[str, Any], values: Mapping[str, str] | None = None) -> str:
    """
    The skill as the text a turn follows, with inputs filled in.

    :param doc: A normalized document.
    :param values: Input values from :func:`resolve_inputs`.
    :returns: Markdown the Muse reads at the start of a run.
    """
    filled = values or {}
    lines = [f"# {doc['name']}"]
    if doc.get("goal"):
        lines += ["", f"Goal: {doc['goal']}"]
    if doc.get("preconditions"):
        lines += ["", "Before you start:"]
        lines += [f"- {_fill(p, filled)}" for p in doc["preconditions"]]
    if doc.get("inputs"):
        lines += ["", "Inputs:"]
        for item in doc["inputs"]:
            value = filled.get(item["name"], "(not given)")
            lines.append(f"- {item['label']} ({item['name']}): {value}")
    lines += ["", "Steps:"]
    for number, step in enumerate(doc["steps"], start=1):
        lines.append(f"{number}. {_fill(step['intent'], filled)}")
        if step.get("check"):
            lines.append(f"   Check: {_fill(step['check'], filled)}")
        if step.get("approval"):
            lines.append("   Ask the person to approve before you do this.")
        hint = step.get("hint")
        if hint:
            parts = [f'{k} "{hint[k]}"' for k in ("role", "name") if hint.get(k)]
            if hint.get("selector"):
                parts.append(f"selector {hint['selector']}")
            if hint.get("url"):
                parts.append(f"page {hint['url']}")
            lines.append(f"   Hint: {', '.join(parts)}")
    if doc.get("returns"):
        lines += ["", f"Return: {_fill(doc['returns'], filled)}"]
    lines += ["", _RUN_NOTES]
    return "\n".join(lines)


def describe_action(action: Mapping[str, Any]) -> str:
    """One recorded action as a plain sentence for the distilling Helper."""
    kind = action.get("kind")
    role = action.get("role") or "element"
    name = action.get("name") or action.get("label") or action.get("placeholder") or ""
    target = f'{role} "{name}"' if name else role
    if kind == "navigate":
        return f"opened {action.get('url', '')}"
    if kind == "type":
        return f'typed "{action.get("value", "")}" into {target}'
    if kind == "secret":
        return f"typed a secret into {target}"
    if kind == "select":
        return f'chose "{action.get("value", "")}" in {target}'
    if kind == "check":
        return f"{'checked' if action.get('checked') else 'unchecked'} {target}"
    if kind == "key":
        return f"pressed {action.get('key', 'a key')} in {target}"
    if kind == "file":
        return f"chose a file in {target}"
    if kind == "submit":
        return f"submitted {target}"
    text = f' (text "{action["text"]}")' if action.get("text") and not name else ""
    return f"clicked {target}{text}"


def pick_brief_keyframes(
    actions: list[Mapping[str, Any]], limit: int = MAX_BRIEF_KEYFRAMES
) -> list[str]:
    """Keyframe names worth showing the Helper: first, last, and evenly spread between."""
    names = list(dict.fromkeys(a["keyframe"] for a in actions if a.get("keyframe")))
    if len(names) <= limit:
        return names
    step = (len(names) - 1) / (limit - 1)
    return list(dict.fromkeys(names[round(i * step)] for i in range(limit)))


def build_brief(skill_id: str, goal: str, actions: list[Mapping[str, Any]]) -> str:
    """
    The text Brief for the teacher Helper: the goal and the numbered recorded actions.

    :param skill_id: The skill to save the draft to.
    :param goal: What the person said they were teaching.
    :param actions: The recording's ordered actions.
    :returns: The Brief text (keyframe images are attached separately).
    """
    lines = [
        f"skill_id: {skill_id}",
        f"The person taught this: {goal}",
        "",
        "What they did, in order (frame k# is a screenshot taken after that action):",
    ]
    for action in actions:
        frame = f" [frame {action['keyframe']}]" if action.get("keyframe") else ""
        selector = f" (selector {action['selector']})" if action.get("selector") else ""
        lines.append(f"{action.get('seq', '?')}. {describe_action(action)}{selector}{frame}")
    if not actions:
        lines.append("(nothing was recorded)")
    lines += ["", "Write the draft with skill_draft_save."]
    return "\n".join(lines)
