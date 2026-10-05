"""Activity titles: wording rules, the title store, and the lazy model-title flow."""

from __future__ import annotations

import json

import pytest

from omnigent.entities import FunctionCallData, MessageData, NewConversationItem
from omnigent.server.background_session_titles import (
    BackgroundSessionTitleCoordinator,
    BackgroundTitleRequest,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.activity.derive import (
    activities_missing_titles,
    list_activities,
    schedule_missing_titles,
)
from omnigent.superchat.activity.titles import (
    ACTIVITY_TITLE_INSTRUCTIONS,
    clean_generated_label,
    clean_generated_title,
    is_generic_title,
    scheduled_display_title,
    split_generated_label,
    strip_reply_filler,
    tidy_request_title,
)

_MODE = {"omnigent.context.mode": "superside-chat"}


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("yo what's tesla stock price?", "What's tesla stock price"),
        ("Hey, can you check my calendar for tomorrow?!", "Check my calendar for tomorrow"),
        ("please summarize this article", "Summarize this article"),
        ("research EV battery makers", "Research EV battery makers"),
        ("## **AI agent** launches, [week 3](http://x.test)", "AI agent launches, week 3"),
        ("yo", None),
        ("", None),
        (None, None),
    ],
)
def test_tidy_request_title(text: str | None, expected: str | None) -> None:
    assert tidy_request_title(text) == expected


def test_tidy_request_title_is_short_and_ends_on_a_word() -> None:
    title = tidy_request_title("compare " + "the quarterly earnings reports " * 6)
    assert title is not None and len(title) <= 60 and title.endswith("…")
    assert not title.removesuffix("…").endswith(" ")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('"check Tesla\'s latest price."', "Check Tesla's latest price"),
        ("Follow AI agent launches", "Follow AI agent launches"),
        ("", None),
        ("a", None),
        ("Here is a very long title that rambles on well past any sensible word limit", None),
        ("Check the price of the Tesla stock and the…", None),
    ],
)
def test_clean_generated_title(raw: str, expected: str | None) -> None:
    assert clean_generated_title(raw) == expected


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Study", "Studied your recent work"),
        ("Check-in (Oct 03 07:00 UTC)", "Checked in on your goals"),
        ("AI agent launches (Oct 03 07:00 UTC) 1a2b3c4d", "AI agent launches"),
        ("tesla news", "Tesla news"),
        ("analyst-3", None),
        ("", None),
    ],
)
def test_scheduled_display_title(name: str, expected: str | None) -> None:
    assert scheduled_display_title(name) == expected


def test_is_generic_title() -> None:
    assert is_generic_title("researcher-1")
    assert is_generic_title("web_fetch_91af03c2")
    assert is_generic_title("__web_research")
    assert not is_generic_title("Tesla price")
    assert not is_generic_title("decade")


def test_activity_titles_are_stored_once_per_turn(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    conv = conversation_store.create_conversation(kind="default")
    assert conversation_store.set_activity_title(conv.id, "resp_a", "Check Tesla's price") is True
    assert conversation_store.set_activity_title(conv.id, "resp_a", "Something else") is False
    assert conversation_store.get_activity_labels(["resp_a", "resp_b"]) == {
        "resp_a": ("Check Tesla's price", None)
    }
    assert conversation_store.get_activity_labels([]) == {}


def test_a_result_summary_is_added_once_to_an_existing_title(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    conv = conversation_store.create_conversation(kind="default")
    assert conversation_store.set_activity_title(conv.id, "resp_a", "Check price") is True
    assert (
        conversation_store.set_activity_title(conv.id, "resp_a", "Other", "Closed at $242") is True
    )
    assert conversation_store.set_activity_title(conv.id, "resp_a", "Other", "Later") is False
    assert conversation_store.get_activity_labels(["resp_a"]) == {
        "resp_a": ("Check price", "Closed at $242")
    }


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Perfect. Here are the 2 most recent emails.", "Here are the 2 most recent emails."),
        ("Great! Your flight is booked.", "Your flight is booked."),
        ("Got it. Sure. The file is saved.", "The file is saved."),
        ("Now I have the details.", None),
        (
            "Working on it — I've sent a request to the helper.",
            "I've sent a request to the helper.",
        ),
        ("Surely this stays.", "Surely this stays."),
        ("Perfectly fine as is.", "Perfectly fine as is."),
    ],
)
def test_reply_filler_is_stripped(text: str, expected: str | None) -> None:
    assert strip_reply_filler(text) == expected


def test_generated_label_carries_an_optional_result_summary() -> None:
    label = clean_generated_label("check tesla's price | tesla closed at $242, up 3% today.")
    assert label == "Check tesla's price | Tesla closed at $242, up 3% today"
    assert split_generated_label(label or "") == (
        "Check tesla's price",
        "Tesla closed at $242, up 3% today",
    )
    assert clean_generated_label("Check price") == "Check price"
    assert clean_generated_label("Check price | Perfect.") == "Check price"
    assert clean_generated_label("Check price | " + "word " * 20) == "Check price"
    assert clean_generated_label(" | only a summary here") is None


def _more_steps() -> list[NewConversationItem]:
    """Two more tool calls, so the turn has enough steps to count as an Activity."""
    return [
        NewConversationItem(
            type="function_call",
            response_id="resp_1",
            data=FunctionCallData(
                agent="brain", name="web_fetch", arguments="{}", call_id=f"call_{n}"
            ),
        )
        for n in (2, 3)
    ]


async def test_missing_turn_title_is_written_by_the_model_and_used_on_the_next_read(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    chat = conversation_store.create_conversation(kind="default", labels=_MODE)
    conversation_store.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="resp_1",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "yo what's tesla stock price?"}],
                ),
            ),
            NewConversationItem(
                type="function_call",
                response_id="resp_1",
                data=FunctionCallData(
                    agent="brain",
                    name="web_search",
                    arguments=json.dumps({"query": "tesla stock price"}),
                    call_id="call_1",
                ),
            ),
            *_more_steps(),
        ],
    )
    requests: list[BackgroundTitleRequest] = []

    async def generator(request: BackgroundTitleRequest) -> str:
        requests.append(request)
        return "check tesla's latest price."

    coordinator = BackgroundSessionTitleCoordinator(conversation_store, generator)

    [activity] = list_activities(conversation_store, chat.id)
    assert activity.title == "What's tesla stock price"
    missing = activities_missing_titles([activity])
    schedule_missing_titles(
        conversation_store,
        coordinator,
        missing,
        {chat.id: conversation_store.get_conversation(chat.id)},
    )
    await coordinator.wait_for_idle()

    assert len(requests) == 1
    assert requests[0].additional_instructions == ACTIVITY_TITLE_INSTRUCTIONS
    assert "What was done for it:" in requests[0].prompt
    [titled] = list_activities(conversation_store, chat.id)
    assert titled.title == "Check tesla's latest price"
    assert activities_missing_titles([titled]) == []


async def test_a_failed_title_is_not_retried_straight_away(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    chat = conversation_store.create_conversation(kind="default", labels=_MODE)
    calls = 0

    async def generator(_request: BackgroundTitleRequest) -> str:
        nonlocal calls
        calls += 1
        raise RuntimeError("model unavailable")

    coordinator = BackgroundSessionTitleCoordinator(conversation_store, generator)
    conversation = conversation_store.get_conversation(chat.id)
    for _ in range(2):
        coordinator.schedule_activity_title(
            key="resp_x",
            conversation=conversation,
            prompt="check tesla",
            instructions=ACTIVITY_TITLE_INSTRUCTIONS,
            clean=clean_generated_title,
            save=lambda title: title,
        )
        await coordinator.wait_for_idle()
    assert calls == 1


async def test_finished_turn_gets_a_model_written_summary(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    chat = conversation_store.create_conversation(kind="default", labels=_MODE)
    conversation_store.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="resp_1",
                data=MessageData(
                    role="user", content=[{"type": "input_text", "text": "check tesla price"}]
                ),
            ),
            NewConversationItem(
                type="function_call",
                response_id="resp_1",
                data=FunctionCallData(
                    agent="brain", name="web_search", arguments="{}", call_id="call_1"
                ),
            ),
            *_more_steps(),
            NewConversationItem(
                type="message",
                response_id="resp_1",
                data=MessageData(
                    role="assistant",
                    agent="brain",
                    content=[{"type": "output_text", "text": "Perfect. Tesla closed at $242."}],
                ),
            ),
        ],
    )
    prompts: list[str] = []

    async def generator(request: BackgroundTitleRequest) -> str:
        prompts.append(request.prompt)
        return "Check Tesla's price | Tesla closed at $242 today"

    coordinator = BackgroundSessionTitleCoordinator(conversation_store, generator)
    conversation = conversation_store.get_conversation(chat.id)
    [activity] = list_activities(conversation_store, chat.id)
    assert activity.summary == "Tesla closed at $242."
    schedule_missing_titles(
        conversation_store,
        coordinator,
        activities_missing_titles([activity]),
        {chat.id: conversation},
    )
    await coordinator.wait_for_idle()

    assert "Result:\nTesla closed at $242." in prompts[0]
    [done] = list_activities(conversation_store, chat.id)
    assert (done.title, done.summary) == ("Check Tesla's price", "Tesla closed at $242 today")
    assert activities_missing_titles([done]) == []


def test_internal_words_never_reach_titles_or_summaries() -> None:
    from omnigent.superchat.activity.titles import scrub_internal_words

    assert scrub_internal_words("Sub-agent finished the background task in a session") == (
        "finished the task in a chat"
    )
    label = clean_generated_label("Compare approvals | Helper compared three approval flows")
    assert label == "Compare approvals | Compared three approval flows"
    assert tidy_request_title("Ask the helper to compare approvals tools") == (
        "Ask the to compare approvals"
    )
    assert "sub-agent, subagent, helper, background task, session, tool" in (
        ACTIVITY_TITLE_INSTRUCTIONS
    )
