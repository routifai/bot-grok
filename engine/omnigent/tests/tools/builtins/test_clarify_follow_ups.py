"""Tests for the ``ask_clarification`` and ``suggest_follow_ups`` card tools."""

import json

import pytest

from omnigent.runner.tool_dispatch import should_dispatch_locally
from omnigent.spec.types import AgentSpec
from omnigent.superchat.cards.tools import (
    AskClarificationTool,
    SuggestFollowUpsTool,
    build_clarification,
    build_follow_ups,
)
from omnigent.superchat.transcript.blocks import project_items
from omnigent.tools.base import ToolContext
from omnigent.tools.manager import ToolManager

_CTX = ToolContext(task_id="", conversation_id="", agent_id="")


def _ask(**args: object) -> dict:
    return json.loads(AskClarificationTool().invoke(json.dumps(args), _CTX))


def _follow(**args: object) -> dict:
    return json.loads(SuggestFollowUpsTool().invoke(json.dumps(args), _CTX))


def test_clarification_builds_an_ask_card_with_option_ids() -> None:
    out = _ask(question="  Which quarter? ", options=["Q1", "Q2", " Q3 "])
    assert out["type"] == "card" and out["card"] == "ask"
    assert out["data"] == {
        "question": "Which quarter?",
        "options": [
            {"id": "opt-1", "label": "Q1"},
            {"id": "opt-2", "label": "Q2"},
            {"id": "opt-3", "label": "Q3"},
        ],
    }
    assert out["fallback"] == "Which quarter?\n\n- Q1\n- Q2\n- Q3"
    assert "End your turn" in out["note"]


@pytest.mark.parametrize(
    ("args", "needle"),
    [
        ({"options": ["a", "b"]}, "question"),
        ({"question": " ", "options": ["a", "b"]}, "question"),
        ({"question": "q", "options": ["only"]}, "2-5"),
        ({"question": "q", "options": list("abcdef")}, "2-5"),
        ({"question": "q"}, "options"),
        ({"question": "q", "options": ["a", 3]}, "string"),
        ({"question": "q", "options": ["a", ""]}, "empty"),
        ({"question": "q", "options": ["a", "A"]}, "repeats"),
        ({"question": "q", "options": ["a", "x" * 61]}, "shorten"),
    ],
)
def test_clarification_rejects_bad_input(args: dict, needle: str) -> None:
    assert needle in build_clarification(args)["error"]


def test_follow_ups_builds_a_chip_card_that_ends_the_turn() -> None:
    out = _follow(suggestions=["Compare with last year", " Show by region "])
    assert out["card"] == "follow_ups" and out["type"] == "card"
    assert out["data"] == {"suggestions": ["Compare with last year", "Show by region"]}
    assert out["fallback"] == "- Compare with last year\n- Show by region"
    assert "no more text" in out["note"]


@pytest.mark.parametrize(
    "suggestions", [[], ["a", "b", "c", "d"], ["ok", ""], "nope", ["x" * 121], ["Same", "same"]]
)
def test_follow_ups_rejects_bad_input(suggestions: object) -> None:
    assert "error" in build_follow_ups({"suggestions": suggestions})


def test_non_object_arguments_are_rejected() -> None:
    for tool in (AskClarificationTool(), SuggestFollowUpsTool()):
        assert "error" in json.loads(tool.invoke("[1]", _CTX))
        assert "error" in json.loads(tool.invoke("{", _CTX))


def test_schemas_bound_the_counts_and_carry_the_muse_rules() -> None:
    ask = AskClarificationTool().get_schema()["function"]
    options = ask["parameters"]["properties"]["options"]
    assert (options["minItems"], options["maxItems"]) == (2, 5)
    assert ask["parameters"]["required"] == ["question", "options"]
    assert "genuinely ambiguous" in ask["description"] and "just proceed" in ask["description"]
    follow = SuggestFollowUpsTool().get_schema()["function"]
    suggestions = follow["parameters"]["properties"]["suggestions"]
    assert (suggestions["minItems"], suggestions["maxItems"]) == (1, 3)
    assert "generic filler" in follow["description"]


def test_dispatch_and_registration_follow_render_card() -> None:
    assert should_dispatch_locally("ask_clarification")
    assert should_dispatch_locally("suggest_follow_ups")
    spec = AgentSpec(spec_version=1, skills_filter="none")
    mode = {"omnigent.context.mode": "superside-chat"}
    names = ToolManager(spec, labels=mode).get_tool_names()
    assert {"ask_clarification", "suggest_follow_ups"} <= set(names)
    helper = {**mode, "omnigent.subagent": "researcher"}
    helper_names = ToolManager(spec, labels=helper).get_tool_names()
    assert not {"ask_clarification", "suggest_follow_ups"} & set(helper_names)
    plain = ToolManager(spec).get_tool_names()
    assert not {"ask_clarification", "suggest_follow_ups"} & set(plain)


def _call(name: str, call_id: str) -> dict:
    return {
        "id": f"i-{call_id}",
        "type": "function_call",
        "name": name,
        "call_id": call_id,
        "arguments": "{}",
        "created_at": 100,
    }


def _output(call_id: str, payload: dict) -> dict:
    return {
        "id": f"o-{call_id}",
        "type": "function_call_output",
        "call_id": call_id,
        "output": json.dumps(payload),
    }


def test_transcript_projects_both_calls_as_card_blocks() -> None:
    items = [
        _call("ask_clarification", "k1"),
        _output("k1", build_clarification({"question": "Which?", "options": ["A", "B"]})),
        _call("suggest_follow_ups", "k2"),
        _output("k2", build_follow_ups({"suggestions": ["Go deeper"]})),
    ]
    first, second = project_items(items)
    assert first["blocks"][0]["card"]["card"] == "ask"
    assert second["blocks"][0]["card"]["card"] == "follow_ups"
    assert second["blocks"][0]["card"]["data"] == {"suggestions": ["Go deeper"]}
    assert "pending" not in first["blocks"][0]


def test_transcript_skips_unfinished_and_failed_calls() -> None:
    # Instant tools never show a skeleton; a rejected call shows nothing.
    assert project_items([_call("ask_clarification", "k1")]) == []
    failed = [_call("suggest_follow_ups", "k2"), _output("k2", build_follow_ups({}))]
    assert project_items(failed) == []


def test_hidden_control_characters_are_stripped_from_buttons() -> None:
    # Zero-width space, RTL override and a BOM can hide or reorder what a button says.
    out = build_follow_ups({"suggestions": ["Show\u200b it\u202e by region\ufeff"]})
    assert out["data"]["suggestions"] == ["Show it by region"]
    ask = build_clarification({"question": "Q?", "options": ["A\u200b", "B\u2066"]})
    assert [o["label"] for o in ask["data"]["options"]] == ["A", "B"]
    # Stripping must not let two look-alike options through as distinct.
    assert (
        "repeats" in build_clarification({"question": "Q?", "options": ["A", "A\u200b"]})["error"]
    )


def test_text_after_a_follow_ups_card_does_not_replace_the_answer() -> None:
    items = [
        _msg("u1", "user", "How is the backlog?"),
        _msg("a1", "assistant", "It fell from 84 to 61."),
        _call("suggest_follow_ups", "k1"),
        _output("k1", build_follow_ups({"suggestions": ["By auditor"]})),
        _msg("a2", "assistant", "Here are some things you can ask next."),
    ]
    out = project_items(items)
    assert [m["id"] for m in out] == ["u1", "a1", "i-k1"]
    assert out[1]["blocks"][0]["text"] == "It fell from 84 to 61."
    # The chips are the last message, which is what the client keys "latest answer" on.
    assert out[-1]["blocks"][0]["card"]["card"] == "follow_ups"


def test_a_rejected_follow_ups_call_leaves_the_turns_last_text_as_its_answer() -> None:
    items = [
        _msg("u1", "user", "Hi"),
        _msg("a1", "assistant", "First."),
        _call("suggest_follow_ups", "k1"),
        _output("k1", build_follow_ups({})),
        _msg("a2", "assistant", "Second."),
    ]
    assert [m["id"] for m in project_items(items)] == ["u1", "a2"]


def test_text_after_a_clarification_card_is_dropped_too() -> None:
    items = [
        _msg("u1", "user", "Pull the numbers"),
        _msg("a1", "assistant", "I need one thing first."),
        _call("ask_clarification", "k1"),
        _output("k1", build_clarification({"question": "Which?", "options": ["A", "B"]})),
        _msg("a2", "assistant", "Let me know."),
    ]
    assert [m["id"] for m in project_items(items)] == ["u1", "a1", "i-k1"]


def _msg(item_id: str, role: str, text: str) -> dict:
    kind = "output_text" if role == "assistant" else "input_text"
    return {
        "id": item_id,
        "type": "message",
        "role": role,
        "content": [{"type": kind, "text": text}],
        "created_at": 100,
    }
