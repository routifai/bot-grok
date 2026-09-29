# skills

What Nova learns to repeat: a saved ``SKILL.md`` recipe per person, and the
Save / Not now offer that gets one saved.

## The loop

1. Nova finishes a multi-step task the person will likely want again, and no
   saved skill already covers it. It calls `nova_offer_skill` once with a
   name, a one-line description, and the steps — never by asking in its
   reply text. The call only reaches a card if it clears every gate in
   `gate.py` (see below) — the prompt asks nicely, the server enforces it.
2. The person sees a Save / Not now card (`asks/` lists it via
   `open_offers`, this primitive's public surface — see below) — an
   **update** card, not Save/Not-now-for-a-new-skill, when the offer ranks as
   clearly similar to one already saved (`offer_kind`/`target_skill` below).
3. **Save** calls `POST /skills/offers/{id}/save`, which saves (or, for an
   update offer, replaces the target's body, keeping its name) and marks the
   offer answered. **Not now** calls the `/dismiss` route instead; the name
   is never re-offered (`SkillService.offer` refuses a duplicate of an open
   or already-declined offer).
4. In a later session, `context.py` lists the person's saved skills by name
   and description; the model calls `nova_load_skill` to fetch one's full
   body and follow it.
5. The person can also paste their own steps, or a whole `SKILL.md`, and ask
   Nova to keep it — `nova_save_skill` saves that directly, no offer card.

## The offer gate (`gate.py`)

A bad offer taught the product owner nothing: Nova called `nova_offer_skill`
after a turn where a chart tool had errored eight times, for a one-off
research question. `SkillService.offer` now refuses unless every rule below
holds, each with a short, specific `OmnigentError` naming the rule and what
would qualify — cheap heuristics, no LLM call:

1. **Never after a failed turn.** `tools.py` reads this turn's conversation
   items (mirrors `episodes.observer`'s walk back to the triggering user
   message) and refuses if more of this turn's tool-call results errored
   than succeeded, or the last `gate.FAILURE_STREAK_LAST_N` (3) all did.
   `gate._is_error_output` recognizes a built-in tool's `{"error": ...}`, an
   MCP `"Error: ..."` string, and the MCP `isError` envelope.
2. **A procedure, not a topic.** `gate.has_procedure_shape` requires a
   "Steps"/"Procedure" heading with at least `gate.MIN_PROCEDURE_STEPS` (3)
   numbered/bulleted lines, plus a "When to use" line — a name or body that
   just restates a question topic doesn't qualify.
3. **Evidence of reuse.** `gate.has_reuse_evidence` allows the offer only if
   the person's last `gate.REUSE_LOOKBACK_EPISODES` (200) episodes contain at
   least `gate.REUSE_MIN_MATCHES` (2) that rank against the proposed
   name/description (via `episodes.rank_episodes`) above
   `gate.REUSE_MATCH_THRESHOLD`; or the tool's optional `reason` is `"asked"`
   or `"corrected"` **and** `gate.has_instruction_or_correction_cue` finds an
   actual instruction/correction phrase in the turn's latest user message
   (an unverified `reason` alone is not evidence).
4. **Improve before creating.** `gate.find_similar_skill` checks the
   person's saved skills; if one ranks at or above `gate.SIMILARITY_THRESHOLD`,
   the offer becomes `offer_kind=update` against that skill (its own name,
   not the proposed one) instead of a new one — the caller cannot request
   update mode directly.

Ports the behaviour of Nova's TypeScript prototype: `parseSkillMd` /
`buildSkillMd` (`packages/core/src/agent-skill.ts`), `offer_skill`
(`packages/adapters/src/muse/skill-offer.ts`), and `skill_create` /
`skill_read` (`packages/adapters/src/skill-tools.ts`) — keyed by the person
(`NovaActor`) instead of a bot, and as durable rows from the moment they
exist rather than message blocks.

## Reaching the model: a context section + a tool, not Omnigent's own skill files

Omnigent already has a skill mechanism (`omnigent/tools/builtins/load_skill.py`,
`omnigent/inner/bundle_skills.py`): agent-bundle and host-directory
`SKILL.md` files, discovered per harness at launch and (for the Claude
harnesses) wired through `--plugin-dir`. That mechanism is per-agent-bundle
and mostly static; making a person's saved skills ride it would mean writing
their skills to disk per session, on every harness, and keeping that in sync
as they save, accept, or delete one — a much larger integration for a
per-person, frequently-changing set of rows that already lives in the
database.

Instead, saved skills reach the model the same way every other Nova
primitive does: `context.py` lists names and one-line descriptions (so the
model knows what exists without spending tokens on bodies it won't use), and
`nova_load_skill` fetches one body on demand. This works identically on
every harness Omnigent supports — it rides the same `ContextRequest` /
built-in-tool path as `nova_remember` and `nova_ask_user` — with no
per-harness wiring at all.

## Public API (`omnigent.nova.skills`)

- `Skill`, `SkillOffer`, `OfferStatus` (`open`/`saved`/`dismissed`),
  `OfferKind` (`new`/`update`) — the domain types. `SkillOffer.target_skill`
  names the skill an `update` offer would replace; `None` for `new`.
- `SkillService` — `list_skills(actor)`, `get(actor, name)`, `delete(actor, name)`,
  `save(actor, *, name=None, description=None, body=None, content=None)`,
  `offer(actor, *, name, description, body="", reason=None, turn_failed=False,
  latest_user_message="", episode_store=None)` — see "The offer gate" above
  for what each extra argument feeds — `accept_offer(actor, offer_id)`
  (replaces the target's body for an `update` offer instead of creating a
  skill), `dismiss_offer(actor, offer_id)`, `open_offers(actor)`. Bound to one
  `SkillStore`; reads `episodes` (via `episode_store`, or
  `omnigent.nova.episodes.runtime_store()` by default) only for gate 3.
- `parse_skill_md(content) -> ParsedSkill` / `build_skill_md(name, description, body) -> str` —
  the same two directions as the TypeScript `parseSkillMd`/`buildSkillMd`,
  built on a real YAML parser (PyYAML) rather than a hand-rolled one, since
  Nova only ever reads/writes `name` and `description` — no arbitrary
  frontmatter to round-trip.
- `NAME_MAX_CHARS` (80), `DESCRIPTION_MAX_CHARS` (2000), `CONTENT_MAX_CHARS`
  (100,000) — the same bounds as the TypeScript prototype.
- `create_store(storage_location) -> SkillStore` — the store factory.
- `open_offers(actor) -> list[SkillOffer]` — the person's open offers.
  Public specifically so `asks/` can list skill offers alongside its own
  Asks without reaching into this primitive's internals (`nova/README.md`
  rule 1); `asks/` isn't wired to call it yet.

## Routes (mounted under `/v1/nova`)

- `GET /skills` — list the caller's saved skills.
- `GET /skills/{name}` / `DELETE /skills/{name}` — fetch or delete one by
  exact name.
- `GET /skills/offers` — the caller's open offers.
- `POST /skills/offers/{offer_id}/save` — accept: saves the skill.
- `POST /skills/offers/{offer_id}/dismiss` — decline: nothing is saved.

All require a resolved actor (`actor_from_request`); 401 otherwise, 404 for
anything missing or owned by someone else.

## Tools

- `nova_offer_skill(name, description, body, reason=None)` — opens an offer,
  subject to the gate above; `reason` is one of `"repeated"`/`"asked"`/
  `"corrected"`, only `"asked"`/`"corrected"` ever bypass gate 3, and only
  when the turn's own words back it up. Returns `{"status": "offer_shown",
  "offer_kind": ..., "target_skill": ...}`, or `{"error": "..."}` naming the
  rule that refused it.
- `nova_save_skill(content)` or `nova_save_skill(name, description, body)` —
  saves directly, no offer, no gate.
- `nova_load_skill(name)` — returns a saved skill's full `content`.

All three resolve the calling session's owner from `ctx.conversation_id` via
`omnigent.nova._shared.private_actor` and refuse outside a private session.

## Context (`context.py`)

Private scope only. Key `"skills"`, priority 45, capped to 2 KiB: saved
skill names and one-line descriptions, plus the names of any open offers
(an update offer shown as `"<name> (update)"`) — so Nova can see it already
offered something and avoid asking again in the same breath. The actual
no-repeat guarantee is `SkillService.offer`'s database check, not this hint.

## Tables

- `nova_skills` — one row per saved skill. Unique on
  `(workspace_id, user_id, name)`.
- `nova_skill_offers` — one row per offer, `open` until answered `saved` or
  `dismissed`. `offer_kind` (`new`/`update`) and `target_skill` record what
  gate 4 decided; accepting an `update` offer replaces `nova_skills.content`
  in place rather than inserting a row. Indexed for "waiting on you"
  (`workspace_id, user_id, status, created_at, id`) and for the
  duplicate/no-repeat check (`workspace_id, user_id, name, status`).

Neither table carries a database foreign key (Rule R032).
