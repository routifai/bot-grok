"""Guard tests for the declarative harness capability model.

Capabilities are declared per harness in ``_BUILTIN_CONTRIBUTION.capabilities``.
These tests assert the declarations stay complete (every built-in harness is
covered) and that the two *derivable* axes (model_family, subagents) do not
contradict the code that actually enforces them, so the table cannot silently
drift.
"""

from __future__ import annotations

from omnigent import harness_plugins as hp
from omnigent.harness_availability import CODEX_CANONICAL_HARNESSES
from omnigent.harness_capabilities import (
    AuthModel,
    EffortFamily,
    Elicitation,
    ForkHistory,
    HarnessCapabilities,
    InstructionDelivery,
    IntegrationMode,
    ModelFamily,
    Resume,
)
from omnigent.harness_plugins import (
    HarnessContribution,
    harness_capabilities,
    harness_catalog,
    harness_setup_steps_by_spelling,
    native_agents,
    valid_harnesses,
)
from omnigent.models.model_override import _CLAUDE_FAMILY_HARNESSES

_NATIVE_MODES = frozenset({IntegrationMode.NATIVE_TUI, IntegrationMode.NATIVE_SERVER})


def test_every_builtin_harness_declares_capabilities() -> None:
    caps = harness_capabilities()
    missing = sorted(valid_harnesses() - set(caps))
    assert not missing, f"harnesses missing a capability declaration: {missing}"


def test_capability_keys_are_valid_harnesses() -> None:
    # No stray capability entry for a non-existent harness id.
    stray = sorted(set(harness_capabilities()) - valid_harnesses())
    assert not stray, f"capability entries for unknown harnesses: {stray}"


def test_native_agents_have_native_integration_mode() -> None:
    caps = harness_capabilities()
    native_harness_ids = {agent.harness for agent in native_agents()}
    for harness in native_harness_ids:
        assert caps[harness].integration_mode in _NATIVE_MODES, harness


def test_model_family_matches_model_override_sets() -> None:
    # model_family is derivable from model_override's family frozensets, so the
    # declaration must not contradict the code that enforces routing.
    for harness, capability in harness_capabilities().items():
        family = capability.model_family
        if harness in _CLAUDE_FAMILY_HARNESSES:
            assert family is ModelFamily.CLAUDE, harness
        elif harness in CODEX_CANONICAL_HARNESSES:
            assert family is ModelFamily.GPT, harness
        else:
            assert family is ModelFamily.MULTI, harness


def test_subagents_matches_its_implementing_mechanism() -> None:
    """``subagents`` is derivable — from the mechanism that implements it.

    A **native** agent with a ``subagent_wrapper_label``: Omnigent intercepts
    the vendor's own spawn and mints the child session.

    Keeping the derivation here means a harness cannot publish a ``subagents``
    capability on ``/v1/harnesses`` that nothing implements, or implement one it
    does not publish.
    """
    subagent_capable = {agent.harness for agent in native_agents() if agent.subagent_wrapper_label}
    for harness, capability in harness_capabilities().items():
        expected = harness in subagent_capable
        assert capability.subagents == expected, harness


def test_native_harnesses_resume_warm() -> None:
    caps = harness_capabilities()
    native_harness_ids = {agent.harness for agent in native_agents()}
    for harness in native_harness_ids:
        assert caps[harness].resume is Resume.WARM_REATTACH, harness


def test_p0_bench_harnesses_declare_interrupt_and_streaming() -> None:
    # The harness bench live-probes these and declares them SUPPORTED for
    # interrupt + streaming; the capability declaration must match so the bench
    # can derive its expected matrix from capabilities without contradiction.
    caps = harness_capabilities()
    for harness in ("claude-sdk", "pi"):
        assert caps[harness].interrupt is True, harness
        assert caps[harness].streaming is True, harness


def test_pi_harness_declares_the_pi_effort_family() -> None:
    """The pi harness advertises pi's 7-level ladder, not "no effort knob"."""
    from omnigent.util.reasoning_effort import EFFORT_VALUES, PI_EFFORTS

    caps = harness_capabilities()
    assert caps["pi"].effort is EffortFamily.PI
    assert caps["pi"].as_dict()["effort"] == "pi"
    assert PI_EFFORTS == EFFORT_VALUES


def test_optional_bench_capabilities_default_to_unknown() -> None:
    capability = HarnessCapabilities(
        IntegrationMode.SDK_IN_PROCESS,
        Elicitation.NONE,
        Resume.COLD_ONLY,
        EffortFamily.NONE,
        ModelFamily.MULTI,
        AuthModel.OWN_AUTH,
        subagents=False,
        interrupt=True,
        streaming=True,
    )

    assert capability.steering is None
    assert capability.live_queue is None
    assert capability.images is None
    assert capability.compaction is None
    # New axes default to their unset value: fork_history=none, shell tool None.
    assert capability.fork_history is ForkHistory.NONE
    assert capability.shell_tool_name is None
    assert capability.shell_tool_prompt is None
    assert capability.instruction_delivery is InstructionDelivery.UNKNOWN
    assert capability.as_dict() == {
        "integration_mode": "sdk-in-process",
        "elicitation": "none",
        "resume": "cold-only",
        "effort": "none",
        "model_family": "multi",
        "auth": "own-auth",
        "subagents": False,
        "interrupt": True,
        "streaming": True,
        "steering": None,
        "live_queue": None,
        "images": None,
        "compaction": None,
        "fork_history": "none",
        "shell_tool_name": None,
        "shell_tool_prompt": None,
        "instruction_delivery": "unknown",
    }


def test_community_capabilities_cannot_override_builtin() -> None:
    # `capabilities` is part of the collision-key set, so a community plugin that
    # declares capabilities for a built-in harness id is rejected rather than
    # silently overriding the built-in declaration (last-wins in _merge_dict).
    evil = HarnessContribution(
        name="omnigent-evil",
        capabilities={
            "claude-sdk": HarnessCapabilities(
                IntegrationMode.SDK_IN_PROCESS,
                Elicitation.NONE,
                Resume.COLD_ONLY,
                EffortFamily.NONE,
                ModelFamily.MULTI,
                AuthModel.OWN_AUTH,
                subagents=False,
                interrupt=False,
                streaming=False,
            )
        },
    )
    error = hp._validate_community_contribution(
        evil, entry_point_name="evil", existing=(hp._BUILTIN_CONTRIBUTION,)
    )
    assert error is not None
    assert "claude-sdk" in error


def test_catalog_rows_include_capabilities() -> None:
    rows = harness_catalog()
    caps = harness_capabilities()
    for row in rows:
        if row["id"] in caps:
            assert "capabilities" in row, row["id"]
            # JSON-serializable: values are primitives, not enums.
            for value in row["capabilities"].values():
                assert value is None or isinstance(value, (str, bool))


def test_catalog_rows_carry_setup_steps() -> None:
    """Every row exposes an ordered, JSON-serializable setup checklist."""
    rows = {row["id"]: row for row in harness_catalog()}
    for row in rows.values():
        assert "setup_steps" in row, row["id"]
        assert len(row["setup_steps"]) >= 1
        for step in row["setup_steps"]:
            assert step["kind"] in ("install", "auth")
            assert step["action"] in ("install", "command", "setup", "auth")
            # JSON-serializable primitives only.
            for value in step.values():
                assert value is None or isinstance(value, str)
    # Codex keeps its setup checklist (resolved by spelling, it is not a picker
    # row): install (one-click) then a UI-authable auth step. The step opens the
    # credential form (action "auth"); its subscription option still carries the
    # `codex login` command.
    codex = harness_setup_steps_by_spelling()["codex"]
    assert [s["action"] for s in codex] == ["install", "auth"]
    assert codex[1]["command"] == "codex login"


def test_setup_steps_by_spelling_covers_native_and_installable_ids() -> None:
    """The by-spelling map resolves the ids a session declares, not just picker
    rows — native wrappers and installable non-picker ids included."""
    by_spelling = harness_setup_steps_by_spelling()
    # Native wrappers (what a session actually declares) resolve to steps...
    for native in ("codex-native", "claude-native"):
        assert native in by_spelling, native
        assert len(by_spelling[native]) >= 1
    # ...and match their bare-id counterpart's steps (same ui_setup_steps source).
    assert by_spelling["codex-native"] == by_spelling["codex"]
    # Installable ids that are NOT picker rows still resolve.
    assert "codex" in by_spelling


def test_fork_history_axis_matches_canonical_declarations() -> None:
    """fork_history is the source of truth for the server's fork-history gating.

    The two frozensets in ``_sessions/common`` are DERIVED from this axis; the
    canonical harness id is in the rebuild set iff it declares REBUILD. (The set
    also carries reversed ``native-<x>`` spellings — asserted separately below.)
    """
    from omnigent.server.routes._sessions.common import _FORK_HISTORY_NATIVE_HARNESSES

    for harness, capability in harness_capabilities().items():
        fh = capability.fork_history
        assert (harness in _FORK_HISTORY_NATIVE_HARNESSES) == (fh is ForkHistory.REBUILD), harness


def test_fork_history_derivation_preserves_prior_membership() -> None:
    """The derived sets are a superset of the pre-1.8 hand-maintained literals.

    Behavior-preservation pin: the exact pre-derivation membership (canonical ids
    PLUS the reversed ``native-<x>`` spellings the literals carried) must still be
    present, or a fork silently loses history. The derived set may add extra
    reversed spellings that canonicalize into it (harmless at the read site).
    """
    from omnigent.server.routes._sessions.common import _FORK_HISTORY_NATIVE_HARNESSES

    prior_rebuild = frozenset({"claude-native", "native-claude"})
    assert prior_rebuild <= _FORK_HISTORY_NATIVE_HARNESSES


def test_reversed_native_spellings_classify_fork_history() -> None:
    """Reversed ``native-<x>`` spellings that don't canonicalize are still gated.

    A reversed spelling such as ``native-claude`` must classify the same as its
    canonical ``claude-native`` id. The read sites match on the canonicalized id, so the
    derived sets must contain these literal spellings — this guards the
    regression where an identically-behaving reversed-spelling agent silently
    loses fork history. Mirrors test_fork_reversed_native_spelling_carry_gating.
    """
    from omnigent.harness_aliases import canonicalize_harness
    from omnigent.server.routes._sessions.common import _FORK_HISTORY_NATIVE_HARNESSES

    assert canonicalize_harness("native-claude") in _FORK_HISTORY_NATIVE_HARNESSES


def test_native_tui_harnesses_declare_shell_tool_provocation() -> None:
    """Native-TUI harnesses the bench tool-probes declare a shell-tool prompt.

    The bench derives its provocation from these fields (was a hardcoded table);
    a prompt must carry the ``omnigent-bench-ok`` placeholder the probe
    token-swaps.
    """
    caps = harness_capabilities()
    for harness, capability in caps.items():
        if capability.integration_mode is not IntegrationMode.NATIVE_TUI:
            continue
        assert capability.shell_tool_name, harness
        assert capability.shell_tool_prompt, harness
        assert "omnigent-bench-ok" in capability.shell_tool_prompt, harness


def test_every_canonical_harness_declares_instruction_delivery() -> None:
    caps = harness_capabilities()
    for harness in valid_harnesses():
        assert caps[harness].instruction_delivery is not InstructionDelivery.UNKNOWN, harness
