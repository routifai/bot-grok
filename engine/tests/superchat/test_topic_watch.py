"""Topic watch's code stages (ADR 0035): noise, match, the judge's validation and decide."""

from __future__ import annotations

import json

import pytest

from omnigent.superchat.topic_watch.judge import parse_verdicts
from omnigent.superchat.topic_watch.rules import (
    DROP,
    HOLD,
    MARK,
    MESSAGE,
    Item,
    Ledger,
    Match,
    Verdict,
    WatchedTopic,
    decide,
    match,
    noise_reason,
)

POLARIS = WatchedTopic(
    key="polaris",
    title="Polaris pricing",
    people=("Ana Ruiz <ana@acme.test>",),
    terms=("Polaris", "partner tier", "Q4 price list"),
    refs=("thread-77",),
)
NOW = 1_800_000_000


def _mail(**fields: object) -> Item:
    base: dict[str, object] = {
        "source": "mail",
        "id": "m1",
        "title": "Re: numbers",
        "text_excerpt": "",
        "at": NOW,
    }
    return Item(**{**base, **fields})  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("item", "reason"),
    [
        (_mail(from_self=True), "own"),
        (_mail(sender="Acme <no-reply@acme.test>"), "no_reply"),
        (_mail(sender="news@acme.test", headers={"List-Unsubscribe": "<x>"}), "list"),
        (_mail(sender="ana@acme.test", headers={"Precedence": "bulk"}), "bulk"),
        (_mail(sender="ana@acme.test", headers={"Auto-Submitted": "auto-replied"}), "auto_reply"),
        (_mail(sender="ana@acme.test", title="Out of office: back Monday"), "auto_reply"),
        (Item("calendar", "e1", "Polaris review", "", NOW, response="accepted"), "calendar_reply"),
        (_mail(sender="Ana Ruiz <ana@acme.test>", headers={"Auto-Submitted": "no"}), None),
        (
            Item("calendar", "e2", "Polaris review", "Can we move it?", NOW, response="tentative"),
            None,
        ),
    ],
)
def test_noise(item: Item, reason: str | None) -> None:
    assert noise_reason(item) == reason


def test_match_strengths_and_mutes() -> None:
    topics = [POLARIS]
    strong = match(_mail(thread_ref="THREAD-77"), topics)
    assert strong is not None and strong.strength == "strong"
    medium = match(_mail(sender="ana@acme.test", text_excerpt="the polaris deck"), topics)
    assert medium is not None and medium.strength == "medium"
    weak = match(_mail(text_excerpt="Polaris moves to the partner tier."), topics)
    assert weak is not None and weak.strength == "weak"
    # One term alone, or a term inside another word, is not a match.
    assert match(_mail(text_excerpt="Polaris launch party"), topics) is None
    assert match(_mail(text_excerpt="polarisation and the partner tier"), topics) is None
    # A watched person without a term is not enough.
    assert match(_mail(sender="Ana Ruiz <ana@acme.test>", text_excerpt="lunch?"), topics) is None
    # Mutes from Not useful apply per topic.
    by_sender = [{"topic_key": "polaris", "sender": "ANA@acme.test"}]
    assert match(_mail(sender="ana@acme.test", text_excerpt="polaris"), topics, by_sender) is None
    by_term = [{"topic_key": "polaris", "term": "partner tier"}]
    assert match(_mail(text_excerpt="Polaris partner tier"), topics, by_term) is None
    # A web item matches only the topic it was fetched for.
    other = WatchedTopic(key="other", title="Other", terms=("Polaris", "partner tier"))
    web = Item("web", "w1", "Polaris partner tier news", "", NOW, topic_key="other")
    found = match(web, [POLARIS, other])
    assert found is not None and found.topic_key == "other"


def _verdict(change: str = "blocker", urgency: str = "now", relevance: int = 3) -> Verdict:
    return Verdict("polaris", relevance, change, urgency, "Ana says the price list is blocked.")


def _decide(verdict: Verdict, ledger: Ledger, *, quiet: bool = False, thread: str = "t1") -> str:
    item = _mail(id=f"m-{thread}", thread_ref=thread)
    return decide(verdict, item, now=NOW, quiet=quiet, proactivity="normal", ledger=ledger).action


def test_decide_rules_and_limits() -> None:
    assert _decide(_verdict(relevance=1), Ledger()) == DROP
    assert _decide(_verdict(change="none"), Ledger()) == DROP
    assert _decide(_verdict(change="new_info"), Ledger()) == MARK
    assert _decide(_verdict(urgency="today"), Ledger()) == MARK
    assert _decide(_verdict(), Ledger(), quiet=True) == HOLD

    ledger = Ledger()
    assert _decide(_verdict(), ledger, thread="t1") == MESSAGE
    # The same topic within 3 hours, and the same thread ever again, only mark.
    assert _decide(_verdict(), ledger, thread="t2") == MARK
    ledger.topic_last.clear()
    assert _decide(_verdict(), ledger, thread="t1") == MARK
    # The daily cap of the proactivity level (normal: 3).
    capped = Ledger(today=3)
    assert _decide(_verdict(), capped) == MARK
    low = decide(
        _verdict(), _mail(), now=NOW, quiet=False, proactivity="low", ledger=Ledger(today=1)
    )
    assert low.action == MARK


def test_parse_verdicts_keeps_only_the_fixed_shape() -> None:
    batch = [
        (_mail(id="a"), Match("polaris", "strong", "ref")),
        (_mail(id="b"), Match("polaris", "weak", "terms")),
        (_mail(id="c"), Match("polaris", "weak", "terms")),
    ]
    entries = [
        {"item": 1, "topic_key": "polaris", "relevance": 3, "change": "blocker",
         "urgency": "now", "why": "  Blocked\n on legal. "},
        {"item": 2, "topic_key": "other", "relevance": 2, "change": "new_info",
         "urgency": "today", "why": "x"},
        {"item": 3, "topic_key": "polaris", "relevance": True, "change": "new_info",
         "urgency": "today", "why": "x"},
        {"item": 1, "topic_key": "polaris", "relevance": 0, "change": "none",
         "urgency": "brief", "why": "duplicate"},
    ]  # fmt: skip
    verdicts, invalid = parse_verdicts("```json\n" + json.dumps(entries) + "\n```", batch)
    assert list(verdicts) == [0]
    assert verdicts[0].why == "Blocked on legal." and verdicts[0].change == "blocker"
    assert invalid == 2
    assert parse_verdicts("Sure! Here you go.", batch) == ({}, 3)
