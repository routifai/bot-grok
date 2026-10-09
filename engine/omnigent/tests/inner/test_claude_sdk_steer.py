"""A message sent while a claude-sdk turn runs reaches that turn (a steer).

The CLI is faked at the SDK client: ``query`` records what is written to its stdin and
``receive_response`` reads what the fake CLI "prints", ending at a ``ResultMessage`` like the
real one. No process and no API call is involved.
"""

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from omnigent.inner import claude_sdk_executor as module
from omnigent.inner.claude_sdk_executor import ClaudeSDKExecutor
from omnigent.inner.executor import ExecutorError, TurnComplete

SESSION = "sess_steer"


class _Result:
    def __init__(self, text: str, tokens: int = 10):
        self.session_id = "cli-session"
        self.result = text
        self.is_error = False
        self.usage = {"input_tokens": tokens, "output_tokens": tokens}


class _User:
    def __init__(self, uuid: str | None, content: str = ""):
        self.uuid = uuid
        self.content = content
        self.parent_tool_use_id = None


class _Cli:
    """The fake CLI: what it prints is queued; what is written to it is recorded."""

    def __init__(self) -> None:
        self.stdout: asyncio.Queue = asyncio.Queue()
        self.writes: list[dict] = []
        self.prompt_written = asyncio.Event()
        self.fail_writes = False

    def print_(self, message) -> None:
        self.stdout.put_nowait(message)


def _sdk(cli: _Cli, options_seen: list):
    class _FakeSDK:
        AssistantMessage = type("AssistantMessage", (), {})
        UserMessage = _User
        SystemMessage = type("SystemMessage", (), {})
        ResultMessage = _Result
        StreamEvent = type("StreamEvent", (), {})
        ClaudeAgentOptions = type(
            "ClaudeAgentOptions",
            (),
            {"__init__": lambda self, **kwargs: self.__dict__.update(kwargs)},
        )

        class ClaudeSDKClient:
            def __init__(self, options):
                options_seen.append(options)

            async def connect(self):
                return None

            async def query(self, prompt, session_id="default"):
                if cli.fail_writes and not isinstance(prompt, str):
                    raise RuntimeError("stdin closed")
                if isinstance(prompt, str):
                    cli.writes.append({"prompt": prompt})
                    cli.prompt_written.set()
                else:
                    async for message in prompt:
                        cli.writes.append(message)

            async def receive_response(self):
                while True:
                    message = await cli.stdout.get()
                    yield message
                    if isinstance(message, _Result):
                        return

            async def disconnect(self):
                return None

    return _FakeSDK


async def _start_turn(executor: ClaudeSDKExecutor, cli: _Cli, options_seen: list):
    events: list = []

    async def consume() -> None:
        with patch.object(module, "_ensure_sdk", return_value=_sdk(cli, options_seen)):
            async for event in executor.run_turn(
                [{"role": "user", "content": "redo the deck", "session_id": SESSION}], [], ""
            ):
                events.append(event)

    task = asyncio.create_task(consume())
    await asyncio.wait_for(cli.prompt_written.wait(), 5)
    for _ in range(100):
        if SESSION in executor._steer_windows:
            break
        await asyncio.sleep(0)
    return task, events


@pytest.mark.asyncio
async def test_a_message_during_the_turn_is_written_to_the_live_cli():
    executor, cli, seen = ClaudeSDKExecutor(), _Cli(), []
    task, events = await _start_turn(executor, cli, seen)

    assert await executor.enqueue_session_message(SESSION, "just redo the deck again") is True

    pushed = cli.writes[-1]
    assert pushed["message"] == {"role": "user", "content": "just redo the deck again"}
    assert pushed["priority"] == "next"  # joins the running turn at its next step
    assert pushed["session_id"] == SESSION
    assert pushed["uuid"] in executor._steer_windows[SESSION].pending

    cli.print_(_User(pushed["uuid"]))  # the CLI took it up mid-turn
    cli.print_(_Result("done once"))
    await asyncio.wait_for(task, 5)

    assert [type(e) for e in events] == [TurnComplete]  # one turn, not two
    assert events[0].response == "done once"
    assert SESSION not in executor._steer_windows


@pytest.mark.asyncio
async def test_the_cli_is_asked_to_echo_user_messages():
    executor, cli, seen = ClaudeSDKExecutor(), _Cli(), []
    task, _ = await _start_turn(executor, cli, seen)
    cli.print_(_Result("ok"))
    await asyncio.wait_for(task, 5)
    assert "replay-user-messages" in seen[0].extra_args


@pytest.mark.asyncio
async def test_a_steer_that_missed_the_turn_is_answered_inside_the_same_turn():
    executor, cli, seen = ClaudeSDKExecutor(), _Cli(), []
    task, events = await _start_turn(executor, cli, seen)

    assert await executor.enqueue_session_message(SESSION, "and make it blue") is True
    uuid = cli.writes[-1]["uuid"]

    # The model was already answering: the turn ends first, then the CLI runs the steer.
    cli.print_(_Result("first answer", tokens=10))
    await asyncio.sleep(0.05)
    assert not task.done()  # still reading: an answer is owed
    assert SESSION in executor._steer_windows and executor._steer_windows[SESSION].open

    cli.print_(_User(uuid))
    cli.print_(_Result("blue answer", tokens=5))
    await asyncio.wait_for(task, 5)

    assert len(events) == 1 and isinstance(events[0], TurnComplete)
    assert events[0].usage["input_tokens"] == 15  # both runs are billed
    assert not executor._steer_windows


@pytest.mark.asyncio
async def test_a_second_steer_during_the_followup_is_read_too():
    executor, cli, seen = ClaudeSDKExecutor(), _Cli(), []
    task, events = await _start_turn(executor, cli, seen)
    await executor.enqueue_session_message(SESSION, "one")
    first = cli.writes[-1]["uuid"]
    cli.print_(_Result("r1"))
    await asyncio.sleep(0.02)
    cli.print_(_User(first))
    await asyncio.sleep(0.02)
    assert await executor.enqueue_session_message(SESSION, "two") is True
    second = cli.writes[-1]["uuid"]
    cli.print_(_Result("r2"))
    await asyncio.sleep(0.02)
    cli.print_(_User(second))
    cli.print_(_Result("r3"))
    await asyncio.wait_for(task, 5)
    assert len(events) == 1 and isinstance(events[0], TurnComplete)


@pytest.mark.asyncio
async def test_no_steer_is_accepted_once_the_turn_is_over_or_before_it_started():
    executor, cli, seen = ClaudeSDKExecutor(), _Cli(), []
    assert await executor.enqueue_session_message(SESSION, "too early") is False

    task, events = await _start_turn(executor, cli, seen)
    cli.print_(_Result("ok"))
    await asyncio.wait_for(task, 5)

    assert await executor.enqueue_session_message(SESSION, "too late") is False
    assert [w for w in cli.writes if "uuid" in w] == []  # nothing was written to the CLI


@pytest.mark.asyncio
async def test_a_failed_push_is_refused_so_the_message_waits_for_the_next_turn():
    executor, cli, seen = ClaudeSDKExecutor(), _Cli(), []
    task, events = await _start_turn(executor, cli, seen)
    cli.fail_writes = True

    assert await executor.enqueue_session_message(SESSION, "lost?") is False
    assert not executor._steer_windows[SESSION].pending  # the stream will not wait for it

    cli.print_(_Result("ok"))
    await asyncio.wait_for(task, 5)
    assert isinstance(events[0], TurnComplete)


@pytest.mark.asyncio
async def test_a_steer_the_cli_never_takes_up_drops_the_client_instead_of_hanging():
    executor, cli, seen = ClaudeSDKExecutor(), _Cli(), []
    task, events = await _start_turn(executor, cli, seen)
    await executor.enqueue_session_message(SESSION, "ghost")

    with patch.object(module, "_STEER_FOLLOWUP_TIMEOUT_S", 0.05):
        cli.print_(_Result("answer"))
        await asyncio.wait_for(task, 5)

    assert isinstance(events[0], TurnComplete)
    assert SESSION not in executor._clients  # the next turn rebuilds from history


def test_the_executor_claims_the_live_queue():
    assert ClaudeSDKExecutor().supports_live_message_queue() is True


def test_message_text_reads_string_and_block_content():
    assert module._message_text({"content": "hi"}) == "hi"
    assert module._message_text({"content": [{"type": "text", "text": "a"}, {"type": "x"}]}) == "a"
    assert module._message_text({"content": None}) == ""


@pytest.mark.asyncio
async def test_an_error_result_still_ends_the_turn():
    executor, cli, seen = ClaudeSDKExecutor(), _Cli(), []
    task, events = await _start_turn(executor, cli, seen)
    bad = _Result("boom")
    bad.is_error = True
    cli.print_(bad)
    await asyncio.wait_for(task, 5)
    assert isinstance(events[0], ExecutorError)
