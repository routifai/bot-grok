"""
Tests for :mod:`omnigent.repl._resume_picker` — the
stderr/stdin interactive picker that ports legacy ``--resume`` to
AP mode.

Three layers:

1. **Pure picker** (:func:`pick_conversation`) driven with
   ``StringIO`` and real pseudo-terminals — covers selection,
   navigation, cancellation, and invalid input. No SDK / store
   involvement.
2. **Store-backed convenience**
   (:func:`pick_conversation_from_store`) against a real
   :class:`SqlAlchemyConversationStore` /
   :class:`SqlAlchemyAgentStore` — covers the agent-id scoping
   and the empty-list / unknown-agent paths the one-shot CLI
   relies on.
3. The SDK-backed convenience (:func:`pick_conversation_from_sdk`)
   is exercised by the chat REPL's e2e flow rather than mocked
   here — same reason the SDK-side ``write_session_log`` isn't
   double-tested in ``test_session_log.py``.
"""

from __future__ import annotations

import io
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass

import pytest

from omnigent.entities import ConversationItem, MessageData
from omnigent.repl._resume_picker import (
    _extract_text_from_content_blocks,
    _last_message_preview_from_dicts,
    _last_message_preview_from_entities,
    _Preview,
    pick_conversation,
    pick_conversation_cross_agent_from_sdk,
    pick_conversation_from_store,
)
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)


@dataclass
class _FakeConversation:
    """
    Minimal stand-in for the SDK's :class:`Conversation` /
    the store's ``Conversation`` entity — the picker only reads
    ``id``, ``title``, and ``created_at`` off the rows.
    """

    id: str
    title: str | None
    created_at: int


@dataclass
class _TtyPickResult:
    """
    Result from driving the resume picker through a pseudo-terminal.

    :param selected: Selected conversation id, e.g. ``"c7934759fbb38c6e5bbecc1903d2c011"``,
        or ``None`` when the picker cancelled.
    :param rendered: Plain rendered picker transcript captured from
        the prompt-toolkit output stream.
    """

    selected: str | None
    rendered: str


def _convs(n: int) -> list[_FakeConversation]:
    """
    Build *n* fake conversations with monotonically increasing
    ids so a reader of the picker output (or a test failure
    message) can tell which row is which.
    """
    return [
        _FakeConversation(
            id=f"conv_{i:04d}_padding_for_truncation",
            title=f"chat-{i}",
            # 2026-01-01 + i days, in seconds.
            created_at=1735689600 + i * 86400,
        )
        for i in range(1, n + 1)
    ]


# ── 1. Pure picker ───────────────────────────────────────


def test_pick_conversation_returns_selected_id() -> None:
    """
    Happy path: user types ``2``, picker returns the second
    row's ``id``. Verifies the legacy numeric fallback remains
    one-based for non-TTY/scripted input even though the visible
    TTY UX now uses a highlighted row.
    """
    conversations = _convs(3)
    out = io.StringIO()
    in_ = io.StringIO("2\n")

    selected = pick_conversation(conversations, agent_name="resume_test", out=out, in_=in_)
    assert selected == conversations[1].id, (
        f"Expected pick of row 2 to return {conversations[1].id!r}, "
        f"got {selected!r}. If row 1 or row 3, the indexing is off."
    )


def _pick_with_tty_input(
    conversations: list[_FakeConversation],
    input_chunks: list[bytes],
    *,
    inside_running_loop: bool = False,
) -> _TtyPickResult:
    """
    Run :func:`pick_conversation` against a real pseudo-terminal.

    This exercises the public picker entry point through the same
    prompt-toolkit path users hit in an interactive terminal. The
    helper waits until prompt-toolkit has disabled canonical mode
    before writing bytes, so keypresses are handled as terminal
    input rather than line-buffered text.

    :param conversations: Rows passed to the picker.
    :param input_chunks: Raw terminal keypress chunks to feed
        through the pseudo-terminal, e.g. ``[b"\\x1b[B", b"\\r"]``
        for Down then Enter.
    :param inside_running_loop: When ``True``, invoke the synchronous
        picker from inside an active asyncio loop to match the async
        SDK resume path.
    :returns: Selected id plus rendered output.
    """
    import asyncio as _asyncio
    import os as _os
    import queue as _queue
    import termios
    import threading
    import time

    result_queue: _queue.Queue[str | BaseException | None] = _queue.Queue()
    master_fd, slave_fd = _os.openpty()
    slave_check_fd = _os.dup(slave_fd)
    out = io.StringIO()

    def run_picker() -> None:
        """Run the picker in the background and capture its result."""
        with _os.fdopen(slave_fd, "r", encoding="utf-8", buffering=1) as slave:
            try:
                if inside_running_loop:

                    async def pick_inside_loop() -> str | None:
                        """
                        Call the sync picker while asyncio is active.

                        :returns: Selected conversation id, or ``None``.
                        """
                        return pick_conversation(
                            conversations,
                            agent_name="resume_test",
                            out=out,
                            in_=slave,
                        )

                    selected = _asyncio.run(pick_inside_loop())
                else:
                    selected = pick_conversation(
                        conversations,
                        agent_name="resume_test",
                        out=out,
                        in_=slave,
                    )
            except BaseException as exc:
                result_queue.put(exc)
            else:
                result_queue.put(selected)

    thread = threading.Thread(target=run_picker, daemon=True)
    thread.start()
    try:

        def wait_for_terminal_mode() -> None:
            """Wait until prompt-toolkit has armed terminal input mode."""
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                local_flags = termios.tcgetattr(slave_check_fd)[3]
                if not local_flags & termios.ICANON:
                    return
                time.sleep(0.001)
            pytest.fail("picker did not enter terminal input mode before test input")

        for index, chunk in enumerate(input_chunks):
            wait_for_terminal_mode()
            render_count = out.getvalue().count("Keys:")
            _os.write(master_fd, chunk)
            if index < len(input_chunks) - 1:
                deadline = time.monotonic() + 2
                while (
                    time.monotonic() < deadline and out.getvalue().count("Keys:") <= render_count
                ):
                    time.sleep(0.005)
        thread.join(timeout=2)
        if thread.is_alive():
            pytest.fail(
                f"picker did not finish for tty input {input_chunks!r}; "
                f"rendered output so far:\n{out.getvalue()!r}"
            )
        payload = result_queue.get_nowait()
        if isinstance(payload, BaseException):
            raise payload
        assert payload is None or isinstance(payload, str)
        return _TtyPickResult(selected=payload, rendered=out.getvalue())
    finally:
        for fd in (master_fd, slave_check_fd):
            with suppress(OSError):
                _os.close(fd)


def test_pick_conversation_tty_enter_selects_highlighted_row() -> None:
    """
    Pressing Enter in a real TTY selects the highlighted row.

    This fails if the prompt-toolkit keybinding maps Enter back to
    the legacy empty cancel token, because the public picker would return
    ``None`` instead of the first conversation id.
    """
    conversations = _convs(3)

    result = _pick_with_tty_input(conversations, [b"\r"])

    assert result.selected == conversations[0].id, (
        f"TTY Enter should resume the initially highlighted first "
        f"row ({conversations[0].id!r}), got {result.selected!r}."
    )


def test_pick_conversation_tty_down_then_enter_selects_highlighted_row() -> None:
    """
    Pressing Down then Enter in a real TTY selects the second row.

    The input bytes are the ANSI Down sequence followed by Enter.
    This fails if :func:`pick_conversation` stops routing through
    prompt-toolkit, if Down does not update
    selection, or if Enter does not select the highlighted row.
    """
    conversations = _convs(3)

    result = _pick_with_tty_input(conversations, [b"\x1b[B", b"\r"])

    assert result.selected == conversations[1].id, (
        f"TTY Down then Enter should select row 2 "
        f"({conversations[1].id!r}), got {result.selected!r}."
    )
    chat_lines = [line for line in result.rendered.splitlines() if "chat-" in line][-3:]
    assert len(chat_lines) == 3
    assert not chat_lines[0].lstrip().startswith(">"), (
        f"After Down, row 1 should not remain highlighted. Output:\n{result.rendered!r}"
    )
    assert chat_lines[1].lstrip().startswith(">"), (
        f"After Down, row 2 should be highlighted. Output:\n{result.rendered!r}"
    )


def test_pick_conversation_tty_works_inside_running_event_loop() -> None:
    """
    A TTY picker invoked from an active asyncio loop still runs.

    The SDK-backed resume helpers are async: they await session rows
    and then call the synchronous picker. prompt-toolkit's default
    synchronous runner calls ``asyncio.run()``, which raises in that
    situation unless the picker asks prompt-toolkit to run in a worker
    thread.
    """
    conversations = _convs(3)

    result = _pick_with_tty_input(
        conversations,
        [b"\x1b[B", b"\r"],
        inside_running_loop=True,
    )

    assert result.selected == conversations[1].id, (
        f"TTY picker inside an active asyncio loop should select row 2 "
        f"({conversations[1].id!r}), got {result.selected!r}."
    )


def test_pick_conversation_tty_down_crosses_page_boundary() -> None:
    """
    Repeated Down keys in a real TTY move across page boundaries.

    The old picker required an explicit ``n`` page command before
    selecting row 11. The highlighted-row UX must not trap users
    on page 1; pressing Down at the bottom of a page advances to
    the next page and keeps the selection on the first visible row.
    """
    conversations = _convs(15)

    result = _pick_with_tty_input(conversations, [b"\x1b[B"] * 10 + [b"\r"])

    assert result.selected == conversations[10].id, (
        f"After ten Down keys, Enter should select row 11 "
        f"({conversations[10].id!r}), got {result.selected!r}."
    )
    assert "page 2/2" in result.rendered, (
        f"Expected picker to redraw page 2 after moving past row 10. Output:\n{result.rendered!r}"
    )


def test_pick_conversation_renders_initial_highlight_marker() -> None:
    """
    The rendered page marks the highlighted row with ``>`` so the
    user has a visible target for Enter.

    Rich row style is not visible in ``StringIO`` output because
    ANSI styling is stripped there, so this asserts on the plain
    marker. If the marker disappears, non-color terminals
    lose the selection affordance.
    """
    out = io.StringIO()
    in_ = io.StringIO("q\n")

    pick_conversation(_convs(2), agent_name="resume_test", out=out, in_=in_)
    rendered = out.getvalue()
    highlighted_lines = [line for line in rendered.splitlines() if "chat-1" in line]
    assert highlighted_lines and highlighted_lines[0].lstrip().startswith(">"), (
        f"Expected the first row to be marked as highlighted. Output:\n{rendered!r}"
    )
    unhighlighted_lines = [line for line in rendered.splitlines() if "chat-2" in line]
    assert unhighlighted_lines and not unhighlighted_lines[0].lstrip().startswith(">"), (
        f"Expected only the first row to be marked as highlighted. Output:\n{rendered!r}"
    )


def test_pick_conversation_renders_full_conversation_id() -> None:
    """
    The list metadata prints the full conversation id.

    This catches regressions back to the old fixed-width truncation,
    which made similarly prefixed conversation ids hard to distinguish
    in the resume picker.
    """
    conversations = _convs(1)
    out = io.StringIO()
    in_ = io.StringIO("q\n")

    pick_conversation(conversations, agent_name="resume_test", out=out, in_=in_)
    rendered = out.getvalue()

    assert conversations[0].id in rendered, (
        f"Expected full conversation id {conversations[0].id!r} in picker output. "
        f"Output:\n{rendered!r}"
    )


def test_pick_conversation_tty_esc_cancels() -> None:
    """
    Pressing Esc alone in a real TTY cancels the picker.

    The pseudo-terminal stays open while Esc is delivered, so this
    exercises the timeout path that distinguishes Esc from an ANSI
    arrow sequence. If the timeout read regresses to a blocking
    read, the helper times out and this test fails.
    """
    result = _pick_with_tty_input(_convs(2), [b"\x1b"])
    assert result.selected is None


def test_pick_conversation_q_cancels() -> None:
    """
    Typing ``q`` returns ``None`` — the cancel signal the
    callers (chat / one-shot) use to fall through to a fresh
    conversation.
    """
    out = io.StringIO()
    in_ = io.StringIO("q\n")
    selected = pick_conversation(_convs(3), agent_name="x", out=out, in_=in_)
    assert selected is None, (
        f"q should cancel and return None, got {selected!r}. If a row "
        f"id, the QUIT_TOKENS frozenset is missing 'q'."
    )


def test_pick_conversation_enter_selects_in_line_buffered_fallback() -> None:
    """
    Pressing Enter alone in the line-buffered fallback selects
    the highlighted row, matching the real TTY path.

    This catches a mismatch where the TTY path resumes on Enter
    but ``StringIO`` / piped input still treats a blank line as
    cancel.
    """
    conversations = _convs(2)
    out = io.StringIO()
    in_ = io.StringIO("\n")
    selected = pick_conversation(conversations, agent_name="x", out=out, in_=in_)
    assert selected == conversations[0].id, (
        f"Empty input (Enter alone) should select the highlighted "
        f"row {conversations[0].id!r}, got {selected!r}."
    )


def test_pick_conversation_eof_cancels() -> None:
    """
    EOF on stdin (``readline()`` returns ``""``) cancels rather
    than looping forever. Important when the picker's stdin is
    a closed pipe — without this the legacy picker would spin.
    """
    out = io.StringIO()
    in_ = io.StringIO()  # empty — readline returns "" immediately
    selected = pick_conversation(_convs(2), agent_name="x", out=out, in_=in_)
    assert selected is None, (
        f"EOF on stdin should cancel and return None, got "
        f"{selected!r}. If the test hangs, line-buffered input is "
        f"looping on empty readline output instead of returning "
        f"None to break the picker loop."
    )


def test_pick_conversation_empty_list_returns_none() -> None:
    """
    An empty conversation list short-circuits to ``None`` and
    prints a message, without entering the input loop.
    """
    out = io.StringIO()
    in_ = io.StringIO("1\n")  # would NOT be read
    selected = pick_conversation([], agent_name="x", out=out, in_=in_)
    assert selected is None
    assert "No prior conversations" in out.getvalue(), (
        f"Empty-list message should mention 'No prior conversations', got {out.getvalue()!r}."
    )


def test_pick_conversation_invalid_input_reprompts() -> None:
    """
    Garbage input (``hello``) prints "Invalid selection." and
    re-reads. Followed by a valid row number, the picker
    eventually returns that row — proving the loop didn't
    abort on the first bad input.
    """
    conversations = _convs(2)
    out = io.StringIO()
    in_ = io.StringIO("hello\n1\n")
    selected = pick_conversation(conversations, agent_name="x", out=out, in_=in_)
    assert selected == conversations[0].id, (
        f"Expected pick of row 1 (after recovering from invalid input), got {selected!r}."
    )
    assert "Invalid selection." in out.getvalue()


def test_pick_conversation_out_of_range_reprompts() -> None:
    """
    A row number that's a valid integer but out-of-bounds
    (``99`` when only 2 rows are visible) is rejected the same
    way as garbage input — print "Invalid selection." and
    re-read. Without this guard the picker would IndexError.
    """
    conversations = _convs(2)
    out = io.StringIO()
    in_ = io.StringIO("99\n2\n")
    selected = pick_conversation(conversations, agent_name="x", out=out, in_=in_)
    assert selected == conversations[1].id, (
        f"After re-prompt, row 2 should select conversations[1] "
        f"({conversations[1].id!r}), got {selected!r}. If the test "
        f"raised IndexError instead, the bounds check on the "
        f"selection branch is missing."
    )
    # Same printed-error contract as the garbage-input case —
    # if this assertion fails, the bounds branch is silently
    # re-prompting (confusing UX) instead of telling the user why.
    assert "Invalid selection." in out.getvalue()


def test_pick_conversation_paginates_with_n() -> None:
    """
    With more than one page of conversations (page size = 10),
    typing ``n`` advances to the next page and ``11`` selects
    the first row of page 2.

    ``n`` and numeric selection are retained as compatibility
    fallbacks for scripted / non-TTY input. Numeric rows remain
    absolute across the whole list so old callers do not change
    meaning after the visible picker moved to a highlighted-row
    UX.
    """
    conversations = _convs(15)
    out = io.StringIO()
    # ``n`` to advance, then absolute row ``11`` (page 2's first
    # entry) to pick conversations[10].
    in_ = io.StringIO("n\n11\n")
    selected = pick_conversation(conversations, agent_name="x", out=out, in_=in_)
    assert selected == conversations[10].id, (
        f"Expected absolute row 11 (page 2's first entry) to "
        f"resolve to conversations[10] ({conversations[10].id!r}), "
        f"got {selected!r}. If None or page 1's id, either the "
        f"page advance didn't fire or the selection branch is "
        f"still treating typed numbers as page-local."
    )


def test_pick_conversation_page_local_number_is_invalid_on_page_two() -> None:
    """
    On page 2 (rows 11-15), typing ``1`` is out of range and
    must re-prompt with "Invalid selection." rather than
    selecting page 1's first row.

    This pins the compatibility numeric contract: a scripted
    caller that sends ``1`` after paging does not silently get a
    different conversation than before the highlighted-row UX.
    """
    conversations = _convs(15)
    out = io.StringIO()
    # ``n`` advances to page 2 (rows 11-15). ``1`` is now out of
    # range — must reprompt. ``11`` then selects page 2's first
    # row to confirm the picker recovered cleanly.
    in_ = io.StringIO("n\n1\n11\n")
    selected = pick_conversation(conversations, agent_name="x", out=out, in_=in_)
    assert selected == conversations[10].id, (
        f"Expected ``11`` (after re-prompt) to select conversations[10], got {selected!r}."
    )
    # The "Invalid selection." line proves the ``1`` was
    # rejected. If absent, the picker silently wrapped or
    # clamped and the contract is broken.
    assert "Invalid selection." in out.getvalue()


def test_pick_conversation_renders_preview_lines_when_provided() -> None:
    """
    When a ``previews`` map is passed, each row's latest-message
    preview shows up in the rendered output.

    Pins the user-visible contract for the ``--resume`` picker's
    preview lines: the user can scan each list item and see what
    each conversation was about without having to pick it first.
    Renders for both user-role and assistant-role previews so the
    glyph mapping is exercised; rows whose previews are ``None``
    (fetch failed or empty conversation) collapse to a single
    muted ``…`` placeholder rather than an empty cell.
    """
    convs = _convs(3)
    previews = {
        convs[0].id: _Preview(role="user", text="My favorite number is 17"),
        convs[1].id: _Preview(role="assistant", text="Here's the patch you asked"),
        # convs[2].id intentionally absent → preview lookup
        # returns None → row 3's preview line shows the ``…``
        # placeholder.
    }
    out = io.StringIO()
    in_ = io.StringIO("q\n")
    pick_conversation(convs, agent_name="x", previews=previews, out=out, in_=in_)
    rendered = out.getvalue()

    # Both preview texts must reach the user. Substring match
    # rather than exact line match because Rich's list layout
    # may wrap long previews across multiple lines on narrow
    # widths — what matters is the user-visible content showed up.
    assert "My favorite number is 17" in rendered, (
        f"Row 1's user preview did not appear in the rendered "
        f"output. Either the preview line wasn't added or "
        f"the preview text was dropped before rendering. "
        f"Output:\n{rendered!r}"
    )
    assert "Here's the patch you asked" in rendered, (
        f"Row 2's assistant preview did not appear in the rendered output. Output:\n{rendered!r}"
    )
    assert "…" in rendered, (
        f"Missing preview placeholder for rows with no latest-message preview. "
        f"Output:\n{rendered!r}"
    )


def test_pick_conversation_no_preview_lines_when_dict_omitted() -> None:
    """
    Pure picker callers (no ``previews`` arg) keep the slim
    compact list layout — preview lines are opt-in.

    Without this contract, every caller would pay for an extra
    line per item even when they have no preview data to show.
    Pinning absence of the preview text catches an accidental
    always-rendered preview row.
    """
    convs = _convs(3)
    out = io.StringIO()
    in_ = io.StringIO("q\n")
    pick_conversation(convs, agent_name="x", out=out, in_=in_)
    rendered = out.getvalue()
    assert "…" not in rendered, (
        f"Picker rendered preview placeholders with no previews dict provided. "
        f"Output:\n{rendered!r}"
    )


def test_last_message_preview_from_dicts_finds_latest_message() -> None:
    """
    The dict-shape extractor walks newest-first and returns the
    first message item with text content.

    Items are passed in ``order="desc"`` shape (newest first),
    so the first match IS the latest message. Verifies the
    extractor: (a) skips non-message items (function_call,
    function_call_output), (b) skips message items with no
    extractable text, (c) preserves role from the first match.
    """
    items = [
        # Newest: assistant text — should be the chosen preview.
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Here's the answer"}],
        },
        # Skipped: tool call (not a message).
        {"type": "function_call", "name": "Bash", "arguments": "{}"},
        # Skipped: message with no text content.
        {"type": "message", "role": "user", "content": []},
        # Older user message — wouldn't be the chosen one even
        # if the assistant message above weren't present.
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "What's the answer?"}],
        },
    ]
    preview = _last_message_preview_from_dicts(items)
    assert preview is not None
    # Role + text from the first match (the assistant message).
    # Failure shape: if user's text shows up here, the walk is
    # going oldest-first instead of newest-first.
    assert preview.role == "assistant"
    assert preview.text == "Here's the answer"


def test_last_message_preview_from_dicts_skips_meta_messages() -> None:
    """
    Dict-shape resume previews never render hidden meta messages.

    SDK list-items responses are already flattened dicts. When the
    newest row is ``is_meta=True``, the picker must fall through to
    the latest visible message instead of showing raw skill context.
    """
    items = [
        {
            "type": "message",
            "role": "user",
            "is_meta": True,
            "content": [{"type": "input_text", "text": "<skill>hidden</skill>"}],
        },
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Visible answer"}],
        },
    ]
    preview = _last_message_preview_from_dicts(items)
    assert preview is not None
    assert preview.role == "assistant"
    assert preview.text == "Visible answer"


def test_last_message_preview_from_entities_skips_meta_messages() -> None:
    """
    Entity-shape resume previews never render hidden meta messages.

    Store-backed resume uses :class:`ConversationItem` entities rather
    than flattened SDK dicts. Pin the same newest-non-meta behavior
    for that path.
    """
    items = [
        ConversationItem(
            id="00f7a759442a8656f0cdbc9951cf7c1a",
            type="message",
            status="completed",
            response_id="turn_skill",
            created_at=2,
            data=MessageData(
                role="user",
                content=[{"type": "input_text", "text": "<skill>hidden</skill>"}],
                is_meta=True,
            ),
        ),
        ConversationItem(
            id="54abbec68f5c80d43d1ec374c48c730d",
            type="message",
            status="completed",
            response_id="turn_visible",
            created_at=1,
            data=MessageData(
                role="assistant",
                agent="assistant",
                content=[{"type": "output_text", "text": "Visible answer"}],
            ),
        ),
    ]
    preview = _last_message_preview_from_entities(items)
    assert preview is not None
    assert preview.role == "assistant"
    assert preview.text == "Visible answer"


def test_last_message_preview_from_dicts_returns_none_for_empty() -> None:
    """
    No message items → no preview. Equivalent to "conversation
    has only tool calls" — picker shows the ``…`` placeholder
    for these rows.
    """
    items = [
        {"type": "function_call", "name": "Bash", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "c1", "output": "ok"},
    ]
    assert _last_message_preview_from_dicts(items) is None


def test_extract_text_from_content_blocks_truncates_long_text() -> None:
    """
    Long preview text gets truncated with a trailing ``…`` so
    one verbose conversation doesn't crowd out every other row's
    preview. The legacy picker did the same (``_normalise_resume_preview_text``
    in cli.py); same UX here.
    """
    long_text = "a" * 200
    out = _extract_text_from_content_blocks([{"type": "input_text", "text": long_text}])
    # Should be exactly _PREVIEW_DISPLAY_CHARS (60) chars
    # ending in ``…`` — the truncate cuts at chars-1 then
    # appends the ellipsis.
    assert len(out) == 60
    assert out.endswith("…")


def test_extract_text_from_content_blocks_collapses_whitespace() -> None:
    """
    Multi-line / multi-space text collapses to a single tidy
    line so preview metadata doesn't break out of its item.
    A user message with embedded newlines would otherwise
    render as multiple lines that push the list layout around.
    """
    out = _extract_text_from_content_blocks(
        [{"type": "input_text", "text": "first line\n\nsecond  line\t\tthird"}]
    )
    assert out == "first line second line third"


# ── 2. Store-backed convenience ──────────────────────────


def test_pick_conversation_from_store_unknown_agent_returns_none(
    db_uri: str,
) -> None:
    """Unknown names return an empty picker result, not an unscoped list."""
    conv_store = SqlAlchemyConversationStore(db_uri)
    out = io.StringIO()
    in_ = io.StringIO()
    selected = pick_conversation_from_store(
        conv_store,
        agent_name="never_registered",
        out=out,
        in_=in_,
    )
    assert selected is None
    assert "No prior conversations" in out.getvalue()


def test_pick_conversation_from_store_scopes_by_agent_name(
    db_uri: str,
) -> None:
    """The store-backed picker scopes by bound agent name."""
    conv_store = SqlAlchemyConversationStore(db_uri)
    agent_store = SqlAlchemyAgentStore(db_uri)
    agent_store.create(
        agent_id="e9b83f6f16155dc05644581c7041f53b",
        name="agent_one",
        bundle_location="e9b83f6f16155dc05644581c7041f53b/dummy",
    )
    agent_store.create(
        agent_id="92b6ac2f8ecd0752b4c88d4f8b692be1",
        name="agent_two",
        bundle_location="92b6ac2f8ecd0752b4c88d4f8b692be1/dummy",
    )
    # No conversations are bound to either name, so the scoped list is empty.
    out = io.StringIO()
    in_ = io.StringIO()
    selected = pick_conversation_from_store(
        conv_store,
        agent_name="agent_one",
        out=out,
        in_=in_,
    )
    assert selected is None
    assert "No prior conversations" in out.getvalue(), (
        f"Expected 'No prior conversations' for an agent with no "
        f"task-linked conversations, got {out.getvalue()!r}. If the "
        f"picker entered the input loop, the agent-name filter is not "
        f"applying."
    )


def test_pick_conversation_from_store_finds_session_scoped_agent_by_name(
    db_uri: str,
) -> None:
    """Session-scoped agents with no template row remain resumable by name."""
    conv_store = SqlAlchemyConversationStore(db_uri)
    created = conv_store.create_session_with_agent(
        agent_id="ca2bab107b2b200f0512ef5285de4dee",
        agent_name="session_scoped_resume_agent",
        agent_bundle_location="ca2bab107b2b200f0512ef5285de4dee/dummy",
        agent_description=None,
        title="resume me",
    )

    out = io.StringIO()
    selected = pick_conversation_from_store(
        conv_store,
        agent_name="session_scoped_resume_agent",
        out=out,
        in_=io.StringIO("1\n"),
    )

    assert selected == created.conversation.id
    assert "resume me" in out.getvalue()


# ── Runtime badge ─────────────────────────────────────────


@dataclass
class _BadgeRow:
    """
    Minimal stand-in for a SessionListItem in the badge tests.

    The badge function only reads ``labels``; everything else on
    the picker row is ignored. Mirrors the real SDK shape (id /
    title / created_at present) so a future picker change that
    starts looking at other fields fails the test rather than
    silently passing.
    """

    id: str = "e1f7c651c9f97fac088ea70ef633409d"
    title: str | None = "test"
    created_at: int = 0
    labels: Mapping[str, str] | None = None
    # The owner filter in the cross-agent picker reads ``owner``; the
    # badge tests ignore it. Defaulted so existing rows are unaffected.
    owner: str | None = None
    # Host the session's runner was launched on; the wrapper picker
    # drops rows bound to a different host. ``None`` mirrors rows
    # that were never bound (kept by the filter).
    host_id: str | None = None


# ── Cross-agent picker entry point ────────────────────────


class _FakeSessionsNamespace:
    """Stub mimicking :class:`omnigent_client.SessionsNamespace`.

    Picker switched to the Sessions API so wrapper-only sessions (no
    task rows) still appear. Captures the kwargs each ``list`` call
    was made with for assertions."""

    def __init__(self, rows: list[_BadgeRow]) -> None:
        """:param rows: Session rows the stub returns."""
        self._rows = rows
        self.last_kwargs: dict[str, object] | None = None

    async def list(self, **kwargs: object) -> list[_BadgeRow]:
        """Return the configured rows; record the kwargs."""
        self.last_kwargs = kwargs
        return self._rows


class _FakeConversationsNamespace:
    """Stub mimicking :class:`omnigent_client.ConversationsNamespace`.

    Only ``list_items`` is used (by the preview fetch); list lives on
    sessions now."""

    async def list_items(self, *args: object, **kwargs: object) -> list[object]:
        """
        Stub for the picker's preview prefetch. Empty list means
        every row renders ``"…"`` in the preview line, which is
        fine for these tests.

        :param args: Ignored.
        :param kwargs: Ignored.
        :returns: Empty list.
        """
        del args, kwargs
        return []


class _FakeAPClient:
    """Stub :class:`omnigent_client.OmnigentClient` exposing
    ``.sessions`` (for list) and ``.conversations`` (for list_items)."""

    def __init__(self, rows: list[_BadgeRow]) -> None:
        """:param rows: Rows the sessions namespace will return."""
        self.sessions = _FakeSessionsNamespace(rows)
        self.conversations = _FakeConversationsNamespace()


async def test_cross_agent_picker_lists_without_agent_id_filter() -> None:
    """
    :func:`pick_conversation_cross_agent_from_sdk` must call the
    SDK list endpoint with ``agent_id=None`` so all runtimes are
    visible. A regression that scoped to a single agent would
    defeat the purpose of the cross-agent picker the top-level
    ``omnigent resume`` depends on.
    """
    import io

    from omnigent.repl._resume_picker import pick_conversation_cross_agent_from_sdk

    client = _FakeAPClient(rows=[])  # empty list → picker prints "no prior"
    out = io.StringIO()
    # Empty stdin → readline returns "" → picker cancels cleanly.
    result = await pick_conversation_cross_agent_from_sdk(client, out=out, in_=io.StringIO(""))
    assert result is None
    # Verify the picker hit the cross-agent code path on the Sessions API
    # (server-side ``has_agent_id`` / ownership gates apply).
    assert client.sessions.last_kwargs == {
        "limit": 200,
        "agent_id": None,
        "agent_name": None,
        "order": "desc",
        "visibility": "mine",
        "kind": None,
    }


# ── Workspace metadata ───────────────────────────────────────


# ── Cross-agent picker — owner filter ────────────────────
#
# ``omnigent resume`` (no id) lists the server's ACL-scoped sessions,
# which include ones merely shared with the caller. Resume is
# owner-only, so the picker drops rows the caller does not own. Reuses
# the ``_FakeAPClient`` / ``_BadgeRow`` fakes above.


def _owned_and_shared_rows() -> list[_BadgeRow]:
    """A shared row (owned by someone else) then the caller's own row."""
    return [
        _BadgeRow(
            id="5bcf1e3b9a1c4d2e8f0a1b2c3d4e5f60",
            title="bob's shared chat",
            owner="bob@example.com",
            labels={},
        ),
        _BadgeRow(
            id="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
            title="my own chat",
            owner="me@example.com",
            labels={},
        ),
    ]


async def test_cross_agent_picker_drops_sessions_not_owned_by_caller() -> None:
    """
    With ``owner_user_id`` set, sessions merely shared with the caller are
    dropped — only their own sessions are listed and selectable. Resume is
    owner-only, so a shared row would be a dead end.
    """
    client = _FakeAPClient(rows=_owned_and_shared_rows())
    out = io.StringIO()

    # After filtering to "me@example.com" only the owned row survives, so
    # row 1 is that owned session.
    selected = await pick_conversation_cross_agent_from_sdk(
        client,
        owner_user_id="me@example.com",
        out=out,
        in_=io.StringIO("1\n"),
    )

    assert selected == "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    rendered = out.getvalue()
    assert "my own chat" in rendered
    # The shared row must not appear at all.
    assert "bob's shared chat" not in rendered
    assert "5bcf1e3b9a1c4d2e8f0a1b2c3d4e5f60" not in rendered


async def test_cross_agent_picker_lists_everything_when_owner_unknown() -> None:
    """
    ``owner_user_id=None`` (identity unresolved, or a permissionless
    single-user server) leaves the list unfiltered — the pre-existing
    behavior. Both rows are listed, so resume never silently hides
    sessions when it can't tell who the caller is.
    """
    client = _FakeAPClient(rows=_owned_and_shared_rows())
    out = io.StringIO()

    # No filter → row 1 is still the (shared) row the server returned first.
    selected = await pick_conversation_cross_agent_from_sdk(
        client,
        owner_user_id=None,
        out=out,
        in_=io.StringIO("1\n"),
    )

    assert selected == "5bcf1e3b9a1c4d2e8f0a1b2c3d4e5f60"
    rendered = out.getvalue()
    assert "bob's shared chat" in rendered
    assert "my own chat" in rendered


# ── Host scoping and transient-429 retry ─────────────────────────────


class _RateLimitedThenOkSessionsNamespace(_FakeSessionsNamespace):
    """Sessions stub whose first ``fail_times`` list calls raise 429."""

    def __init__(self, rows: list[_BadgeRow], fail_times: int) -> None:
        """:param fail_times: Number of leading calls that rate-limit."""
        super().__init__(rows)
        self.remaining_429 = fail_times
        self.calls = 0

    async def list(self, **kwargs: object) -> list[_BadgeRow]:
        """Raise ``RateLimitedError`` until the budget is exhausted."""
        from omnigent_client import RateLimitedError

        assert kwargs["visibility"] == "mine"
        self.calls += 1
        if self.remaining_429 > 0:
            self.remaining_429 -= 1
            raise RateLimitedError("rate limited", 429, "rate_limited")
        return await super().list(**kwargs)
