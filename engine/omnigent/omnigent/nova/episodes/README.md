# Episodes

What Nova has done: one short, dated record per finished task — what the
person asked, what Nova found (a summary), any links, and which tools it
used. Keyed by the person (`NovaActor`), never a bot.

Ported from Nova's TypeScript implementation:
`packages/core/src/muse/episodes.ts` (build/rank/render — pure logic, no I/O)
and `packages/adapters/src/muse/episodes.ts` (the recording rule and the
recall tool's fallback). `_plain_text_from_markdown` in `service.py` is a
light subset of `packages/core/src/markdown-plain.ts`, good enough to flatten
a reply into a plain-text summary — not a full markdown renderer.

## Public surface (`__init__.py`)

- `Episode`, `BuiltEpisode` — the domain types.
- `EpisodeStore` — the store interface, for other primitives that need to
  read a person's episodes (none do yet).
- `build_episode`, `rank_episodes`, `render_episodes` — pure functions.
- `record_turn` — the eligibility check + idempotent upsert.
- `WORK_TOOLS`, `NO_RESPONSE` — the constants the eligibility check uses.

## How an episode gets written

`observer.on_turn_completed(conversation_store, session_id, turn_id)` is
called by the server (one guarded, fire-and-forget call in
`omnigent/server/routes/_sessions/orchestration.py`, right after a turn's
`response.completed` event) and:

1. Reads the session's labels via `conversation_store.get_conversation` and
   skips unless `scope_from_labels(...)` is `Scope.PRIVATE`.
2. Resolves the owning person via `conversation_store.get_session_owner(...,
   owner_only=True)`.
3. Walks the session's most recent items (newest first) back to the
   triggering user message, collecting the final assistant reply and the
   `function_call` tool names used along the way.
4. Calls `service.record_turn`, which only writes an episode when the turn
   used at least one work tool and produced a real, non-empty reply — the
   same rule as the TypeScript `recordEpisode`.

The whole function is wrapped so it can never raise into its caller.

## Tables

| Table           | Key                                    | Notes                                    |
| --------------- | --------------------------------------- | ----------------------------------------- |
| `nova_episodes` | `(workspace_id, id)`                    | Unique on `(workspace_id, session_id, turn_id)` for idempotent recording. |

## Routes (`/v1/nova/episodes`)

- `GET /episodes?limit=` — the caller's episodes, newest first.
- `DELETE /episodes/{episode_id}` — owner only.

## Tool

`nova_recall_episodes` (private sessions only): ranks the person's last 1000
episodes against a query (1-10 results), falling back to the most recent
episodes with a note when nothing matches.

## Context

`context.context_section` contributes up to 3 episodes ranked against the
turn's input, from the person's last 300, under the `past_episodes` key
(private scope only, 3 KiB budget).

## Internal wiring (`_runtime.py`)

`routes.create_router` is the only entry point the server hands the storage
location (`NovaDeps`); `tools.py` and `observer.py` are called without one.
`_runtime.py` holds the one store instance `create_router` builds, so both
can read it. Not part of the public surface.
