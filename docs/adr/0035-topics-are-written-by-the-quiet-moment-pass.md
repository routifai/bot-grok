# 0035: Topics are written by the quiet-moment pass

> **Status:** Accepted 2026-10-23 by the owner, from the clickable mock-up (Home topics, pick-up card, Topics panel). Defaults chosen: topics cover 7 days, Home opens on the last 48 hours, the panel lives in the dock, topic watch is out of scope (its own record later). Builds on [0017](0017-the-working-list-is-tagged-and-the-journal-lives-in-the-host.md) and [0005](0005-proactive-work-is-scheduled-helper-runs.md).

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
| `last_touched_at`, `status` | Newest event; `open` or `closed` |

The engine stores topics in one table per owner (`superchat/topics/`, its own capability folder: store, routes, tool, handler). `topics_update` upserts by `key`: a field passed replaces the stored one, `events` are merged and deduplicated, `last_touched_at` is the newest event. Code validates sizes and kinds and trims; it never asks a model to repair. A topic untouched for 7 days drops out of every list but is kept; a `closed` one is hidden.

**The pass sees what it is updating.** The quiet brief lists the person's current topics (key, title, `left_off`, last touched) so the Helper updates by key instead of inventing a near-duplicate. When the person has no topics yet, the brief also carries the last 7 daily notes, so the first pass after this ships seeds the list from history.

**The web shows them in two places.**

- **Home:** "Pick up where you left off" under the composer: one card per topic with when, a 7-day strip of days touched, title, `left_off` and source counts. A toggle switches between the last 48 hours (default) and this week. The home's contour ground lifts into a peak under each card, higher for recent and busy topics.
- **Topics panel:** a lightbulb in the dock opens a panel listing `events` newest first, grouped by day, so one topic can appear on several days. A row expands to its last covered lines and first open item, with *Pick up in chat*.

**Picking up stays in the one Conversation.** A pick calls `POST /v1/me/topics/{key}/pick`. The engine appends one `topic` card item to the Conversation (no turn starts, nothing is sent to the model now) and the web renders it: where we left off, what we covered, still open, and the starters. A starter fills the composer and the person edits or sends it. The card is part of the record, so the next turn sees what was picked, and recall pulls anything older. No session is created and no prompt is injected.

**Wording.** "Topics" and "Pick up where you left off". Nothing the person sees mentions the pass, a Helper or a tool.

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
- Topic watch (a scheduled run that checks open topics against mail, calendar and the web and messages only on a real change) is the next record; the topic's card already has a place for its "New" line.
