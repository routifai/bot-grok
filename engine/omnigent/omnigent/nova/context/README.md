# context

Builds what the model should know on each turn: Nova's static instructions,
the current date/time, and every other primitive's context section, capped
and merged into one string. No tables — this primitive is pure composition
over what `_shared/section.py` calls `ContextRequest` / `ContextSection`.

Replaces the TypeScript prototype's HTTP context endpoint
(`packages/adapters/src/omnigent/context-provider.ts`) and the fixed
instruction lines in `packages/adapters/src/executor/run-prompt.ts`
(`MUSE_VOICE_INSTRUCTION`, `MUSE_GOALS_INSTRUCTION`, the `offer_skill` line,
and `userTurnInstructions`' ordering).

## Public API (`__init__.py`)

- `compose(request: ContextRequest) -> str` — the static instructions, the
  current date/time in `request.timezone`, then every section from
  `_registry.section_providers()` (called concurrently; a failing provider is
  logged and skipped), ordered by priority, each wrapped `<{key}>…</{key}>`,
  each capped to its own `max_bytes`, the whole capped at 48 KiB by dropping
  lowest-priority sections first. One preamble line marks the tagged sections
  as data, not instructions. The result is redacted with `request.secrets`.
- `provide(owner_user_id, labels, turn_input, session_id, workspace_id=0) -> str`
  — the in-process replacement for the old HTTP provider: builds a
  `ContextRequest` (actor from `owner_user_id`, scope from `labels` via
  `scope_from_labels`, timezone from `omnigent.nova.memory.get_profile` when
  that primitive exists, else `"UTC"`) and returns `compose(...)`. Returns
  `""` when `owner_user_id` is `None`. The maintainer wires this into
  `omnigent/runtime/context_provider.py`; nothing here imports that module.

## Files

- `instructions.py` — Nova's static instructions as plain text constants,
  ported from the TypeScript prototype and updated to the new tool names
  (`nova_remember`, `nova_recall_episodes`, `nova_goals`, `nova_ask_user`,
  `nova_follow_topic`, `nova_post_to_feed`).
- `composer.py` — `compose`.
- `provider.py` — `provide`.

## Rules this primitive follows

- Pulls, never pushes: it only reads `_registry.section_providers()`. It
  never imports another primitive's tables or store directly (Rule 2 in
  `../README.md`).
- A primitive that wants private data left out of a non-private session
  enforces that itself, inside its own `context_section` — this primitive
  only orders and caps what it is handed.
