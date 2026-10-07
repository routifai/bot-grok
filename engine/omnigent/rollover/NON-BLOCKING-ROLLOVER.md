# Rollover never blocks the next message

How a superside-chat session compacts its context without making the next message wait.

## The problem

When a turn ends over the rollover threshold, the runner starts the summarizer as a background task (`_schedule_superside_chat_threshold_rollover` → `_maybe_superside_chat_threshold_rollover` in `runner/app.py`). The turn that triggered it was never blocked. The next one was: `_consume_superside_chat_pending_refresh`, which runs at the top of every turn, awaited the in-flight rollover task for up to `_SUPERSIDE_CHAT_ROLLOVER_WAIT_TIMEOUT_S` (60s). The message was accepted at once, but its reply stalled behind the summarizer.

## The fix

### 1. The next turn does not wait

`_consume_superside_chat_pending_refresh` now skips the wait. The turn dispatches on the current state:
- **Warm client:** it still holds the full history.
- **Cold replay:** the checkpoint has not been written yet, so the replay is the full history.

The rollover threshold sits below the model's window, so one more turn fits.

When the summary finishes while that turn is still running, the existing deferred drop handles it. `_drop_superside_chat_warm_client(defer_if_active=True)` puts the session in `_superside_chat_pending_refresh`, and the following turn drops the warm client and starts from the compacted context.

### 2. Waiting only at the hard limit

The turn waits (bounded, 60s) only when dispatching could overflow. That means the last reported context tokens are at least `HARD_CONTEXT_WINDOW_FRACTION` (0.95) of the model window (`exceeds_hard_context_limit` in `superchat/rollover.py`; `_superside_chat_at_hard_context_limit` in the runner). The tokens come from the runner's last turn usage, falling back to the `omnigent.last_context_tokens` label; the window comes from `omnigent.last_context_window`. If either is unknown, it does not wait.

### 3. One rollover at a time

`_schedule_superside_chat_threshold_rollover` does not start a second task while one is pending for the session. A skipped trigger is re-checked on the next turn that ends over the threshold.

### 4. A turn during the summary is not lost

Removing the wait exposed an existing bug. The checkpoint (`compaction` item) is written when the summarizer **finishes**, but it summarises the record only up to its `last_item_id` anchor, captured when the rollover **started**. A turn that ran in between sits after the anchor and before the checkpoint.

Both readers used to take "everything after the latest compaction item", which silently dropped that turn:
- the cold replay (`_convert_raw_items_to_input`, `runner/app.py`);
- the next rollover's input (`_fetch_items_since_last_compaction`, `superchat/rollover.py`).

Both now use `split_at_latest_compaction` (`context/rollover.py`). It returns the items after the anchor that precede the checkpoint, minus the checkpoint itself, plus everything after it. A missing or synthetic anchor, such as a native forwarder's `compact_boundary_*`, falls back to the old behaviour.

```
record:   … A(anchor) B C [compaction last_item_id=A] D …
before:   D …              (B and C lost)
now:      B C D …
```

## What still waits

- **Idle rollover.** The first turn after 12h idle awaits `roll_over_session` inline (`_maybe_superside_chat_idle_rollover`), on purpose, so stale context is refreshed before dispatch.
- **Native harnesses.** `build_post_compaction_tail` (claude-native, codex-native) still treats everything before the compaction item as the tail and could repeat items that landed during a rollover. Superside-chat on claude-sdk and pi does not use that path.

## Tests

- **`tests/runner/test_superside_chat_rollover_scheduling.py`:** the wait rules (no wait below the hard limit, a bounded wait at it), one task per session, and the deferred drop applied at the next turn.
- **`tests/superchat/test_rollover.py`:** the hard-limit rule, and a turn during a rollover appearing in the next summary.
- **`tests/context/test_rollover.py`:** `split_at_latest_compaction`, including items between the anchor and the checkpoint.
