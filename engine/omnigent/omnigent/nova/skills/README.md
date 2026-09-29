# skills

What Nova learns to repeat: a saved ``SKILL.md`` recipe per person, and the
Save / Not now offer that gets one saved.

## The loop

1. Nova finishes a multi-step task the person will likely want again, and no
   saved skill already covers it. It calls `nova_offer_skill` once with a
   name, a one-line description, and the steps — never by asking in its
   reply text.
2. The person sees a Save / Not now card (`asks/` lists it via
   `open_offers`, this primitive's public surface — see below).
3. **Save** calls `POST /skills/offers/{id}/save`, which saves the skill and
   marks the offer answered. **Not now** calls the `/dismiss` route instead;
   the name is never re-offered (`SkillService.offer` refuses a duplicate of
   an open or already-declined offer).
4. In a later session, `context.py` lists the person's saved skills by name
   and description; the model calls `nova_load_skill` to fetch one's full
   body and follow it.
5. The person can also paste their own steps, or a whole `SKILL.md`, and ask
   Nova to keep it — `nova_save_skill` saves that directly, no offer card.

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

- `Skill`, `SkillOffer`, `OfferStatus` (`open`/`saved`/`dismissed`) — the
  domain types.
- `SkillService` — `list_skills(actor)`, `get(actor, name)`, `delete(actor, name)`,
  `save(actor, *, name=None, description=None, body=None, content=None)`,
  `offer(actor, *, name, description, body="")`,
  `accept_offer(actor, offer_id)`, `dismiss_offer(actor, offer_id)`,
  `open_offers(actor)`. Bound to one `SkillStore`; talks to nothing
  Omnigent-specific, so it's testable with a fake store.
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

- `nova_offer_skill(name, description, body)` — opens an offer. Returns a
  result telling the model the card is shown and to keep its reply brief.
- `nova_save_skill(content)` or `nova_save_skill(name, description, body)` —
  saves directly, no offer.
- `nova_load_skill(name)` — returns a saved skill's full `content`.

All three resolve the calling session's owner from `ctx.conversation_id`
(`_resolve_private_actor`, duplicated from `memory/tools.py` and
`asks/tools.py` — not yet lifted into `_shared`) and refuse outside a
private session.

## Context (`context.py`)

Private scope only. Key `"skills"`, priority 45, capped to 2 KiB: saved
skill names and one-line descriptions, plus the names of any open offers —
so Nova can see it already offered something and avoid asking again in the
same breath. The actual no-repeat guarantee is `SkillService.offer`'s
database check, not this hint.

## Tables

- `nova_skills` — one row per saved skill. Unique on
  `(workspace_id, user_id, name)`.
- `nova_skill_offers` — one row per offer, `open` until answered `saved` or
  `dismissed`. Indexed for "waiting on you" (`workspace_id, user_id, status,
  created_at, id`) and for the duplicate/no-repeat check
  (`workspace_id, user_id, name, status`).

Neither table carries a database foreign key (Rule R032).
