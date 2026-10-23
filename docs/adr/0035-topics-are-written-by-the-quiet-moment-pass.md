# 0035: Topics are written by the quiet-moment pass

> **Status:** Accepted 2026-10-23 by the owner, from the clickable mock-up (Home topics, pick-up card, Topics panel). Defaults chosen: topics cover 7 days, Home opens on the last 48 hours, the panel lives in the dock, topic watch filtering decided here and built next. Builds on [0017](0017-the-working-list-is-tagged-and-the-journal-lives-in-the-host.md) and [0005](0005-proactive-work-is-scheduled-helper-runs.md).

One Conversation for a year leaves the person without the cues other chat apps give for free: a list of session titles to scan and the last few messages under each. People asked for those cues back ("where was I on Polaris?") without giving up the single Conversation. The data already exists: the quiet-moment pass writes today's note (*What we talked about*, *Decisions*, *Promised*, *Open loops*) 20 minutes after the person goes quiet, the working list carries `t-` and `o-` tags, and the journal has dated lines. Nothing shows it.

## Decision

**A topic is a record the quiet-moment pass keeps.** The same `notes` Helper run that updates the daily note also updates the person's topics with one Helper-only tool, `topics_update`. No new model call, no new schedule, no new gating: the pass already respects proactivity, quiet hours and its per-day cap. A topic is:

| Field | What it holds |
|---|---|
| `key` | Stable slug, reused when the topic comes back (the working list's `t-` tag when one exists) |
| `title` | 2 to 5 words, the person's terms, written like an Activity title |
| `left_off` | One sentence: where it stands now |
| `covered` | Up to 6 dated lines `{date, kind, text, file?}`, `kind` one of Decided, Made, Found, Asked |
| `open` | Up to 4 lines `{kind, text}`, `kind` Open or Promised (from the note's open loops and promises) |
| `starters` | 2 or 3 next requests in the person's voice, each one line, never sent on their own |
| `events` | Dated one-line moments `{at, line}` (newest 12 kept), the source of the panel's by-day list |
| `sources` | Counts of chats, files and emails it drew on |
| `watch` | `{people, terms, refs}` for topic watch (see Signal filtering); stored now, read by the next wave |
| `last_touched_at`, `status` | Newest event; `open` or `closed` |

The engine stores topics in one table per owner (`superchat/topics/`, its own capability folder: store, routes, tool, handler). `topics_update` upserts by `key`: a field passed replaces the stored one, `events` are merged and deduplicated, `last_touched_at` is the newest event. Code validates sizes and kinds and trims; it never asks a model to repair. A topic untouched for 7 days drops out of every list but is kept; a `closed` one is hidden.

**The pass sees what it is updating.** The quiet brief lists the person's current topics (key, title, `left_off`, last touched) so the Helper updates by key instead of inventing a near-duplicate. When the person has no topics yet, the brief also carries the last 7 daily notes, so the first pass after this ships seeds the list from history.

**The web shows them in two places.**

- **Home:** "Pick up where you left off" under the composer: one card per topic with when, a 7-day strip of days touched, title, `left_off` and source counts. A toggle switches between the last 48 hours (default) and this week. The home's contour ground lifts into a peak under each card, higher for recent and busy topics.
- **Topics panel:** a lightbulb in the dock opens a panel listing `events` newest first, grouped by day, so one topic can appear on several days. A row expands to its last covered lines and first open item, with *Pick up in chat*.

**Picking up stays in the one Conversation.** A pick calls `POST /v1/me/topics/{key}/pick`. The engine appends one `topic` card item to the Conversation (no turn starts, nothing is sent to the model now) and the web renders it: where we left off, what we covered, still open, and the starters. A starter fills the composer and the person edits or sends it. The card is part of the record, so the next turn sees what was picked, and recall pulls anything older. No session is created and no prompt is injected.

**Wording.** "Topics" and "Pick up where you left off". Nothing the person sees mentions the pass, a Helper or a tool.

## Signal filtering: how topic watch decides what is worth saying

Decided here, built in the next wave. Topics are the filter: a signal from mail, calendar, files or the web matters only if it moves a topic the person is working on. Everything else waits for the daily brief or is dropped. The pipeline narrows in five stages; the cheap stages are code, a model sees only what survives them, and the last word is a code rule.

**1. Watch list (written with the topic).** Each open topic carries a `watch` field the quiet pass fills alongside it: the **people** involved (names, email addresses), the **terms** that identify it (project, client, deal names; at most 8), and **hard references** (email thread ids, calendar event ids, file ids the topic already touched). Code adds references it already knows from the topic's sources. A topic closed or untouched for 7 days stops being watched.

**2. Collect (code, no model).** A hidden scheduled run of kind `topic_watch` (0005; hourly during the person's working hours, gated by proactivity and quiet hours like every proactive run) reads only what changed since its last cursor, per source: new mail, new or changed calendar events, changed files in the person's Computer, and the web only for topics marked as needing it (markets, news). Read-only; one cursor per source per person.

**3. Match (code, no model).** An item survives only if it hits a topic:

| Strength | Rule |
|---|---|
| Strong | It is in a watched thread, meeting or file (hard reference) |
| Medium | A watched person sent it, attends it or edited it, **and** it contains a watched term |
| Weak | It contains two or more distinct watched terms of one topic |

Before matching, code drops noise: bulk and no-reply senders, newsletters (list headers), auto-replies, the person's own sent mail, plain accept or tentative calendar responses, and anything already seen. Each item keeps the topic it matched; an item matching nothing is counted and dropped.

**4. Judge (Light model, structured, no tools).** Surviving items go in one batched call per run with each topic's `left_off` and open items. Item text is fenced as data, never instructions. For each item the model returns a fixed shape that code validates:

`{topic_key, relevance: 0-3, change: answers_open_item | new_deadline | blocker | new_info | none, urgency: now | today | brief, why: one line}`

**5. Decide (code rules).** Nothing reaches the person unless `relevance ≥ 2` and `change ≠ none`.

- **Message now** when the change answers an open item, blocks one, or brings a deadline inside 24 hours, and the urgency is `now`, and mark the topic (below) so its "New" line shows whether or not the message is read. Quiet hours hold the message until they end.
- **Mark the topic** in every other kept case: the topic gets its "New" line (the green tag on Home and in the pick-up card) and the item goes into the next daily brief. No message.
- **Limits:** one message per topic per 3 hours; per day at most 1 (low), 3 (balanced) or 6 (eager) by the proactivity level; the same thread never surfaces twice.

**Learning from the person.** A proactive message carries *Not useful*. Pressing it mutes that sender or term for that topic (a stored rule code applies at stage 3); acting on a message (opening, replying, picking up the topic) keeps its weight. Mutes are listed in Settings and can be removed.

**Every run is accountable.** Each run records its counts per stage (collected, matched, judged, surfaced, marked) and the reason for each surfaced item, so a quiet day can be told apart from a broken watch. The judge's call is in the model-call log like every other.

## Considered options

- **Generate a topic summary when it is clicked.** Rejected: a model call per click is slow, and the pass already reads the same turns.
- **Cluster session history in the engine (embeddings).** Rejected for now: one Conversation has no sessions to cluster, and the notes Helper already names what was covered.
- **Put topics in the daily note.** Rejected: a topic spans days; the note is one day.
- **Extend `daily_note_update` with topics.** Rejected: two capabilities in one tool, and the folder rule says one capability per folder.
- **Open a new session per topic.** Rejected: it breaks the one Conversation (0021).

## Consequences

- An engine rebuild and a bundle render (the `notes` Helper gets `topics_update`); no host change.
- Topics appear only after a quiet pass has run; the first pass seeds from the last 7 notes.
- The pass's output now carries topics: health is visible in the model-call log of each quiet pass (topics written, keys reused vs new).
- Topic watch is decided above and built next; this wave already stores each topic's `watch` field, so the watch starts with history. The card already has a place for its "New" line.
- Mail and calendar signals need a connector with change cursors; until one exists, topic watch runs on files and the web only.

## Amended 2026-10-23 (build)

- **The next turn also gets a one-line note.** A warm session holds its own history and is sent only the person's new message, so it never reads a card the engine appended between turns. A pick therefore also marks the Conversation, and the next turn starts with one line naming the picked topic's title and key, cleared once read (the same one-shot pattern as the person moving a chat). The card stays the record; a session assembled from the record reads it there.
- **The pick is recorded outside any turn.** Its items carry a `recorded_` response id: no Activity row, no turn link, and the runner's crash recovery never starts a turn for them.
- **Home opens after a break.** The app opens on Home when the person returns after 4 hours or more away (and on a first visit); otherwise it opens on the Conversation as before. The Conversation has a Home button to go back.
- **Home is always the first screen** (owner, 2026-10-23), replacing the 4-hour rule above: every load opens on Home; "Continue the conversation" (or scrolling or swiping on past Home's end) slides the Conversation in, and its Home button slides Home back. A message link, a send from Home and a picked-up topic still land in the Conversation.

**Seed pass (owner, 2026-10-23).** A person with no topics should not wait for their next quiet moment to see Home filled. Once per engine process, for each person active in the last 7 days who has no topics, the quiet-moment job starts one `notes` run that reads the last 7 days of the Conversation and the last 7 daily notes and writes topics only (`SEED_PROMPT`); the same proactivity and quiet-hours gates apply.

**Amended 2026-10-23 (owner): Super Chat keeps a picked topic current itself.** A pick also marks the Conversation's active topic (key and pick time) until another pick replaces it or 3 hours pass. The Conversation gets `topics_update`, scoped to that topic: the engine refuses a call from the Conversation for any other key or after the 3 hours, and Helpers keep full access. The pick's one-line note carries the topic as last written (fenced as data) and asks for the update once the work on it is done in a turn: what was done moves from open to covered (dated today), a new `left_off`, new starters and one event, then the turn ends; the prompt says the same for a topic the person picked up. Home and the Topics panel re-read topics when shown, when opened and when a turn ends. No extra background run: the quiet pass remains the sweep for everything else.
