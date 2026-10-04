"""Tests for the taught-skill document, replay text and distill brief."""

from __future__ import annotations

import pytest

from omnigent.superchat.taught_skills.doc import (
    build_brief,
    describe_action,
    normalize_doc,
    pick_brief_keyframes,
    render_skill,
    resolve_inputs,
)

DOC = {
    "name": "Search a product",
    "goal": "Find a product and report its price",
    "preconditions": ["On {{site}}"],
    "inputs": [
        {"name": "Product Name", "label": "Product", "default": "laptop stand"},
        {"name": "site", "default": ""},
    ],
    "steps": [
        {
            "intent": "Search for {{product_name}}",
            "check": "Results mention {{product_name}}",
            "approval": False,
            "keyframe": "k2",
            "hint": {"role": "searchbox", "name": "Search", "ignored": "x"},
        },
        "Open the first result",
        {"intent": "  "},
    ],
}


def test_normalize_cleans_inputs_steps_and_hints() -> None:
    doc = normalize_doc(DOC, keyframes={"k2"})
    assert [i["name"] for i in doc["inputs"]] == ["product_name", "site"]
    assert doc["inputs"][1]["label"] == "Site"
    assert len(doc["steps"]) == 2
    assert doc["steps"][0]["keyframe"] == "k2"
    assert doc["steps"][0]["hint"] == {"role": "searchbox", "name": "Search"}
    assert doc["steps"][1]["check"] == ""


def test_normalize_drops_unknown_keyframes_and_rejects_empty() -> None:
    assert normalize_doc(DOC, keyframes=set())["steps"][0]["keyframe"] is None
    with pytest.raises(ValueError, match="name"):
        normalize_doc({"steps": ["x"]})
    with pytest.raises(ValueError, match="step"):
        normalize_doc({"name": "n", "steps": []})


def test_resolve_inputs_falls_back_to_demo_default_and_reports_missing() -> None:
    doc = normalize_doc(DOC)
    values, missing = resolve_inputs(doc, {"product_name": "desk lamp", "site": " "})
    assert values == {"product_name": "desk lamp"}
    assert missing == ["site"]
    values, _ = resolve_inputs(doc, {})
    assert values["product_name"] == "laptop stand"


def test_render_fills_placeholders_and_marks_approvals() -> None:
    raw = {**DOC, "steps": [{**DOC["steps"][0]}, {"intent": "Buy it", "approval": True}]}
    doc = normalize_doc(raw)
    text = render_skill(doc, {"product_name": "desk lamp", "site": "shop.example"})
    assert "1. Search for desk lamp" in text
    assert "Check: Results mention desk lamp" in text
    assert "On shop.example" in text
    assert "Ask the person to approve" in text.split("2. Buy it")[1]
    assert 'Hint: role "searchbox", name "Search"' in text
    assert "take over" in text


def test_brief_numbers_actions_and_never_carries_secrets() -> None:
    actions = [
        {"seq": 1, "kind": "navigate", "url": "https://shop.example/", "keyframe": "k1"},
        {"seq": 2, "kind": "type", "value": "shoes", "role": "searchbox", "name": "Search"},
        {"seq": 3, "kind": "secret", "role": "textbox", "name": "Password"},
    ]
    brief = build_brief("a" * 32, "buy shoes", actions)
    assert "skill_id: " + "a" * 32 in brief
    assert '2. typed "shoes" into searchbox "Search"' in brief
    assert '3. typed a secret into textbox "Password"' in brief
    assert "[frame k1]" in brief
    assert describe_action({"kind": "check", "checked": False, "role": "checkbox"}).startswith(
        "unchecked"
    )


def test_pick_brief_keyframes_keeps_first_and_last() -> None:
    actions = [{"keyframe": f"k{i}"} for i in range(1, 21)]
    picked = pick_brief_keyframes(actions, limit=4)
    assert picked[0] == "k1" and picked[-1] == "k20" and len(picked) == 4
    assert pick_brief_keyframes(actions[:3]) == ["k1", "k2", "k3"]
