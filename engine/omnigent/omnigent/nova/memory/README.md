# memory

What Nova remembers: durable notes about the person and for itself, plus the
person's timezone.

## Owns

Two markdown notes per person, each with an append-only revision history:

- **`nova`** — Nova's own notes to itself ("My notes" in the UI).
- **`about_you`** — what Nova knows about the person ("About you" in the UI).

A note has a `path` (almost always the default, `"MEMORY.md"`) and a
`content` string. Saving a note never overwrites history: the previous
content is kept as a numbered revision.

Also a tiny **profile** per person — `timezone` (IANA, validated) and
`display_name` — because turn context needs the timezone and nothing else in
Nova owns it yet.

Ports the behaviour of Nova's TypeScript `MarkdownMemoryStore`
(`packages/memory/src/index.ts`) and `loadAgentMemoryContext`
(`packages/adapters/src/memory-context.ts`), keyed by the person
(`NovaActor`) instead of a bot — Nova keeps one assistant per person.

## Public API (`omnigent.nova.memory`)

- `NoteKind`, `MemoryNote`, `MemoryRevision`, `Profile` — the domain types.
- `get_profile(actor) -> Profile` / `set_timezone(actor, timezone) -> Profile`.
- `render_memory(notes, max_bytes) -> str` — notes rendered into context
  text: newest first, one `## <kind>: <path> (revision N)` heading per note,
  a heading never split across the budget.
- `remember(actor, content, kind, path=DEFAULT_PATH, *, store) -> MemoryNote`
  (in `service.py`) — appends a line/paragraph to a note, creating it when
  missing. This is the tool's and any future caller's "remember this".
- `create_store(storage_location) -> MemoryStore` — the store factory.
- `DEFAULT_PATH` — `"MEMORY.md"`.

## Routes (mounted under `/v1/nova`)

- `GET /memory` — list the caller's notes.
- `PUT /memory/{note_id}` — replace a note's content; records a new revision.
- `GET /memory/export` — every note as one markdown document.
- `GET /memory/profile` / `PUT /memory/profile` — read/set the timezone.

All require a resolved actor (`actor_from_request`); 401 otherwise.

## Tool

`nova_remember` (`tools.py`) — appends a fact to the calling session's
owner's memory. Resolves the owner from the tool's `conversation_id` via
Omnigent's conversation store (`get_conversation` for the session's scope
label, `get_session_owner` for who it belongs to — the same grant Omnigent
already uses to attribute session cost). Refuses when the session's scope
(`scope_from_labels`) is not `Scope.PRIVATE`, or when it has no owner.

## Tables

- `nova_memory_notes` — one row per person per `(kind, path)`: current
  content and revision counter. Unique on `(workspace_id, user_id, kind, path)`.
- `nova_memory_revisions` — append-only; primary key
  `(workspace_id, note_id, revision)`.
- `nova_memory_profiles` — one row per person: `(workspace_id, user_id)` primary key.

No table carries a database foreign key (Rule R032); `note_id` on
`nova_memory_revisions` is an application-enforced reference to
`nova_memory_notes.id`.

## Note for `_shared`

`context/provider.py` already calls `memory.get_profile(actor)` expecting a
plain function reachable from the package with no `NovaDeps` in hand. Nothing
in `_shared` currently threads a storage location to code running outside a
route handler (a tool invocation, the context provider), so this primitive
resolves it from Omnigent's already-initialized conversation store instead
(see `_runtime_store()` in `__init__.py`). If a second primitive needs the
same thing, it's worth promoting that resolution into `_shared` rather than
duplicating it.
