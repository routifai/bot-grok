# Asks

What's waiting on the person: an approval, a question with a few choices, a
plan to accept, a skill to save, or a task blocked until they weigh in.
Answering one anywhere closes it everywhere — "Waiting on you" is a plain
database view, not a cache.

Ports the behaviour of Nova's TypeScript prototype (`apps/api/src/muse-asks.ts`,
the `ask_user` tool in `packages/adapters/src/builtin-tools.ts` /
`pi-runtime.ts`, and `apps/web/src/pages/muse/asks/useAsks.ts`), but as a
first-class table rather than a view over message blocks: an Ask here is a
durable row from the moment it opens.

## Why it exists

Omnigent's own pending elicitations (`omnigent/runtime/pending_elicitations.py`)
live in process memory: "when the Omnigent process dies… every parked awaiter
die[s]." A policy approval or an `ask_user` question asked five minutes before
a restart would otherwise vanish with no trace. Asks makes them durable.

## Owns

- `nova_asks` — one row per Ask: id, `user_id`/`workspace_id`, `session_id`,
  `kind`, `text`, `detail`, `actions_json` (0-4 short options), `status`
  (open/answered/expired), `answer`, `elicitation_id` (the Omnigent
  elicitation it mirrors, if any), `goal_id`/`task_id`, `created_at`,
  `answered_at`.

## Public API (`__init__.py`)

- `Ask`, `AskKind` (`approval` / `question` / `proposal` / `blocked_task` /
  `skill_offer`), `AskStatus`, `AskAction` — the domain types.
- `AskService` — `open_ask(...)`, `answer(actor, ask_id, answer)`,
  `list_open(actor)`, `expire_for_session(session_id)`. Bound to one
  `AskStore`; talks to nothing Omnigent-specific, so it's testable with a
  fake store.
- `AskStore` — the store interface, for anything that wants to fake it.
- `create_store(storage_location)` — builds an `AskStore`; `routes.py` calls
  this directly with `NovaDeps.storage_location`.
- `_runtime_store()` / `_runtime_service()` (private) — the process's
  cached store/service, built from the ambient `ConversationStore`'s
  database (`omnigent.runtime.get_conversation_store`). Used by `tools.py`,
  `context.py` and `bridge.py`, none of which have request-scoped
  dependency injection of their own — mirrors `omnigent/nova/memory`'s
  `_runtime_store()`. Tests that need an isolated store monkeypatch this
  function directly rather than relying on the ambient conversation store,
  since it is cached for the process.

## The elicitation bridge (`bridge.py`)

Two directions, both crossing into Omnigent runtime internals that Nova does
not own:

1. **An elicitation fires → an Ask opens.** `on_session_event()` hooks the
   single chokepoint every server-emitted SSE event passes through
   (`omnigent.runtime.session_stream.publish`), right next to that module's
   existing `pending_elicitations.record_publish` call. On a
   `response.elicitation_request` for a Nova **private** session
   (`nova.scope == "private"`), it opens an `AskKind.APPROVAL` Ask with
   `elicitation_id` set, offering `accept` / `decline` — the same two
   verdicts `ElicitationResult.action` accepts, so the person's answer is
   usable verbatim when resolving. A project-scoped session's elicitations
   are untouched: they keep going through the web ApprovalCard, since a
   project's collaborators — not just its owner — may need to answer them.
   Idempotent: a republished event for an already-mirrored elicitation
   (`ix_nova_asks_elicitation`, unique per workspace) is a no-op.

2. **The person answers → the elicitation resolves.** `routes.py` calls
   `bridge.on_answered(ask, answer)` right after `AskService.answer`
   persists the answer.
   - **Still live** (same server process; `pending_elicitations.lookup`
     still holds it): resolved via `_resolve_elicitation`, the exact
     function the web ApprovalCard's resolve endpoint and the in-band
     `approval` session event both use — same harness-Future resolution,
     same sidebar-clear broadcast, same best-effort runner forward.
   - **Gone** (server restarted, or resolved elsewhere while the Ask sat
     unanswered — `pending_elicitations` is in-memory only, so this is
     indistinguishable from "answered after a restart" and is handled the
     same safe way): the answer is delivered as an ordinary user message
     instead. Dispatched immediately if the session's runner is currently
     connected; otherwise persisted as plain history, the same as any other
     message sent to an offline host today — Asks does not relaunch a cold
     session.

**Durability after restart:** the Ask row survives regardless of what
happens to the in-process elicitation. Answering always succeeds and is
always recorded; only the *delivery* path (live resolve vs. message
fallback) depends on whether the original elicitation is still parked.

Guarded call site outside `nova/asks/` (the only one): the five lines in
`omnigent/runtime/session_stream.py`'s `publish()`, immediately after the
existing `pending_elicitations.record_publish(conversation_id, event)` line.

## The tool (`tools.py`)

`nova_ask_user` — `question` (≤240 chars) plus 2-4 unique `options` (≤80
chars each). Private scope only (checked at invoke time against the calling
session's labels, since a built-in tool has no scope of its own). Opens a
`AskKind.QUESTION` Ask and returns a result telling the model to stop
talking and wait for the person's choice — it does not pause the harness
turn itself, the same non-blocking shape as Nova's TypeScript `ask_user`.

## Context (`context.py`)

Private scope only. Up to five open Asks as a short bulleted list under the
`waiting_on_you` key (priority 60, 1 KiB budget), so Nova checks what's
already pending before asking again.
