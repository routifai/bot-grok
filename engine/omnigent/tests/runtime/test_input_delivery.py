"""The server's memory of how messages sent mid-turn were taken."""

from omnigent.runtime import input_delivery as delivery


def test_steer_and_queued_are_remembered_and_a_started_turn_forgets_queued() -> None:
    delivery.record("s1", "a", "steer", now=0)
    delivery.record("s1", "b", "queued", now=0)
    assert delivery.delivered_for("s1", session_running=True, now=1) == {
        "a": "steer",
        "b": "queued",
    }
    delivery.record("s1", "b", "turn", now=2)
    assert delivery.delivered_for("s1", session_running=True, now=2) == {"a": "steer"}
    delivery.forget("s1")
    assert delivery.delivered_for("s1", session_running=True) == {}


def test_a_queued_message_stops_counting_once_the_session_is_idle_past_the_grace() -> None:
    delivery.record("s2", "q", "queued", now=100)
    idle = delivery.delivered_for
    assert idle("s2", session_running=False, now=100 + delivery.QUEUED_GRACE_S - 1) == {
        "q": "queued"
    }
    assert idle("s2", session_running=False, now=100 + delivery.QUEUED_GRACE_S + 1) == {}
    assert idle("s2", session_running=True, now=100 + 1000) == {"q": "queued"}
    delivery.forget("s2")


def test_each_session_keeps_a_bounded_number() -> None:
    for n in range(80):
        delivery.record("s3", f"m{n}", "steer", now=0)
    kept = delivery.delivered_for("s3", session_running=True, now=0)
    assert len(kept) == 50 and "m79" in kept and "m0" not in kept
    delivery.forget("s3")
