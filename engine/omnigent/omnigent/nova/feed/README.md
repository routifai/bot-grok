# feed

What Nova tells the person while they're away: a scrollable feed of Posts
(Goal reports and Followed-topic findings), the topics the person asked Nova
to watch, and Ideas (suggestions of things to ask Nova next).

Ported from the TypeScript prototype: `packages/adapters/src/muse/feed-tools.ts`,
`feed-jobs.ts`, `feed-prompts.ts`, `apps/api/src/muse-feed.ts`, and
`packages/adapters/src/muse/ideas.ts` / `packages/db/src/ideas.ts`.

## Public API (`__init__.py`)

- `FeedService(store)` — domain logic: `post`, `list_posts`, `list_topics`,
  `follow_topic`, `unfollow_topic`, `unfollow_topic_by_name`, `list_ideas`,
  `replace_ideas`. Every method takes a `NovaActor` first — the feed is
  owner-private (Rule 3, `../README.md`).
- `digest_schedule(timezone) -> str` — pure; returns the daily digest's RRULE.
  See "Scheduling the daily digest" below.
- `FeedStore` (ABC) / `PostPage` — the store interface, for a test double.
- `FeedPost`, `FollowedTopic`, `Idea`, `IdeaDraft`, `PostKind` — the domain types.

Routes (`routes.py`) and tools (`tools.py`) are picked up by
`omnigent.nova._registry` automatically; other code does not import them
directly.

## Tables (`nova_feed_` prefix)

- `nova_feed_posts` — one row per Post. `kind` is a local int code
  (`goal_report` / `topic`; see `tables.py`'s `POST_KIND_CODES` — not in the
  shared `omnigent/db/enum_codecs.py`, since this primitive owns it).
- `nova_feed_topics` — one row per followed topic. No DB unique constraint on
  `(user_id, topic)`: dedupe is a store-level check (`get_topic_by_name`),
  the same trade-off `SqlProject` makes for per-owner name uniqueness — a
  `NULL` `user_id` in single-user mode makes a real unique index unreliable.
- `nova_feed_ideas` — one row per current Idea. Replaced wholesale on
  `replace_ideas`; there is no partial update.

All three lead their primary key with `workspace_id` and store `id` as
`Uuid16`, per `docs/DATABASE_BEST_PRACTICES.md`. Workspace is read from
`current_workspace_id()` inside `sqlalchemy_store.py`, not threaded through
the public API — the same split `ProjectStore` / `Project` make.

## Routes (`GET/POST /feed*`, mounted under `/v1/nova`)

- `GET /feed` — list the caller's posts, newest first (`?cursor=`).
- `GET /feed/topics` — list the caller's followed topics.
- `POST /feed/topics` — follow a topic (`{"topic": "..."}`).
- `DELETE /feed/topics/{topic_id}` — unfollow a topic.
- `GET /feed/ideas` — list the caller's current ideas.

## Tools (private scope only)

- `nova_follow_topic` — the person asks Nova to keep an eye on something.
- `nova_unfollow_topic` — the person asks Nova to stop.
- `nova_post_to_feed` — writes a topic finding (title, body, `source_url`).
  Intended for a Followed-topic research turn, not ordinary conversation.

Each tool resolves the calling session's owner and scope from
`ToolContext.conversation_id` via the shared `ConversationStore`
(`omnigent.runtime.get_conversation_store()`) and refuses — returning an
error string, never raising — outside a private session. This mirrors
`_shared.identity.actor_from_request`'s lazy-import posture: these tools run
in-process (there is no runner-dispatch counterpart for them), so `invoke`
does the real work directly.

## Scheduling the daily digest

`digest_schedule(timezone)` is a pure function: given the person's IANA
timezone, it returns the RRULE for a once-daily firing
(`"FREQ=DAILY;BYHOUR=9;BYMINUTE=0"`), validating the timezone but touching no
store. Wiring an actual recurring firing is **not done by this primitive**;
the plan, for whoever wires it:

1. **First follow schedules the digest.** When `follow_topic` takes a
   person from 0 to 1 followed topics, create one Omnigent scheduled task
   for them (`omnigent.stores.scheduled_task_store`), named e.g.
   `"nova-feed-digest"`, bound to the person's Nova agent, with
   `rrule=digest_schedule(actor_timezone)` and `timezone=actor_timezone`.
   Mirrors the TypeScript prototype's `scheduleFeedDigestOnFirstTopic`.
2. **The fired prompt.** The scheduled task's `prompt` lists the person's
   currently-followed topics (`FeedService.list_topics`) and instructs the
   agent to research each with its web tools and call `nova_post_to_feed`
   for anything genuinely new, citing a real source — mirrors
   `feed-prompts.ts`'s `renderFeedTopicsTaskPrompt`.
3. **Unfollowing the last topic** should pause or delete that scheduled
   task; **following again** should recreate/resume it. `FeedService` does
   not track "do we currently have a live schedule" — that bookkeeping
   belongs to whichever module owns the scheduled-task row (out of scope
   here; store the scheduled task's id somewhere it can find it again, e.g.
   an Omnigent preference keyed by user, or a column added later to
   `nova_feed_topics`'s owning primitive once a design is chosen).
4. **Timezone changes.** If the person's timezone changes (via the memory
   primitive's profile), the scheduled task's own `timezone` field should be
   updated to match — `digest_schedule` recomputes the same RRULE either way
   since the hour is fixed local time.

No code here creates, updates, or deletes a scheduled task; this is
deliberate per the task brief ("don't wire the scheduler now").

## No context section

Feed does not contribute to `context/`'s per-turn composition — the model
reaches for `nova_follow_topic` / `nova_post_to_feed` on request, and reads
the feed the same way the person does (via the routes), not as ambient
context on every turn.
