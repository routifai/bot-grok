# Context and memory

What the assistant sees on each turn, how a year-long conversation stays inside the model's window,
and what it remembers, as of 2026-10-17. The code paths are the "Memory and recall" row of
[`engine/README.md`](../engine/README.md); paths below are relative to `engine/omnigent/`. The
decisions are [ADR 0006](adr/0006-omnigent-owns-everything.md) (the engine owns context, the harness
only runs the loop), [ADR 0016](adr/0016-recall-is-a-bounded-hint-and-a-deep-pull-over-one-index.md)
(recall) and [ADR 0017](adr/0017-the-working-list-is-tagged-and-the-journal-lives-in-the-host.md)
(the working list and the journal).

## What the assistant sees each turn

In the order the model reads it:

1. **System prompt.** The bundle's `AGENTS.md` (see [architecture.md](architecture.md#where-the-system-prompt-lives)),
   framework instructions, and on `claude-sdk` a tool-naming note. Fixed for the life of a warm
   harness session.
2. **Tool definitions.** What the bundle's `tools.allow` list leaves.
3. **History.** Either the harness's warm session, or a replay of the stored items from the latest
   checkpoint on: the checkpoint header, the working list, the kept tail, then the items since,
   with each tool call replayed as one digest line (`context/tool_digest.py`).
4. **The per-turn prefix.** Built fresh by `superchat/prompt_prefix.py` (`turn_prefix_blocks`) and
   put in front of the person's latest message, for the model only; never stored, so it never
   reaches the transcript, a summary, search or memory upkeep. Read top to bottom:
   - on a message that answers a question card, the pick line first: `They picked Pitch Deck.
     Continue the task; do not plan it again.`
     ([ADR 0025](adr/0025-act-by-default-tasks-have-state.md));
   - the person's local time (from the timezone in `GET /v1/me/proactivity`, UTC if unknown), and
     one gap line on the first message back from an idle break;
   - feature notes, such as "the person edited this file by hand" (see
     [artifacts.md](artifacts.md#write-back));
   - the open tasks, one line each: `Open task: deck "RBC vs TD" · look Pitch Deck · data: mock ·
     next: build`;
   - the Projects list: one line per `PROJECT.md` card under `~/workspace/projects/`, the 15 most
     recent plus the open one;
   - the memory profile (below);
   - attached files' text in an `<attachment_context>` block, framed as data.
5. **The person's message**, as stored, with any image blocks.

The **context brief** is not in the prefix: it is the result of the Conversation's `context_brief`
tool ([ADR 0027](adr/0027-super-chat-is-an-agentic-layer.md), `superchat/context_brief/`). The
runner starts building it when the message is accepted (a Conversation-only `message_prefix` that
adds no block; a runtime notice starts none) and keeps it per session and message until the turn
ends or two minutes pass, so the call returns at once and a second call gets the same text. It
reads, in parallel within 1.5 seconds, what we made before (artifact groups whose name or title
shares the message's subject words, newest version, the deck's look from its task, who saved it and
when), the Conversation's open tasks and last five done ones with their decision (the tasks view),
earlier work (the recall pull with the planner's sub-queries, planned once per message, as at most
six dated pointers; none with recall off), the top three matching files with their page count, and
the working list's `p-` lines on the subject (the memory profile is only pointed to). A part that
fails or is late is left out. It renders as plain lines under four headings, at most 40 lines and
2,500 characters, fenced as data. Helpers and a file's studio never get it.

The memory profile and Projects blocks go in full on a cold start or when they changed; otherwise
each is one line ("Standing memory unchanged since the last message."). The per-turn prefix exists
because a harness's system prompt is frozen per warm session, and changing it would force a cold
start and break prompt caching. Any failure building a block drops that block; no block can fail a
turn. Helpers carry the same `superside-chat` label and get the same prefix.

## Rollover

When the conversation grows, the engine replaces older turns with a **checkpoint** and keeps recent
turns word for word. The full history stays stored: the person sees every message and the
assistant can read any of it with `session_history`. The harness's own compaction is switched off
(`DISABLE_AUTO_COMPACT` on `claude-sdk`, `compaction.enabled=false` on `pi`) so two compactors never
fight.

| Trigger | Rule | Blocks the turn? |
|---|---|---|
| Size | after a turn, the reported context reaches 60% of the window, capped at 200,000 tokens; 100,000 when the window is unknown; never below 100,000 unless 80% of a known window is lower (`context/rollover.py`, `resolve_rollover_threshold`) | no, runs in the background |
| Hard limit | the last known fill is 95% of the window or more | no wait: the turn cold-starts from the previous checkpoint plus the newest whole turns that fit, and a rollover is scheduled |
| Idle return | first message after 12 hours (`OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS`, default 43200) | no summarizer call unless the items since the checkpoint exceed the kept tail; the turn cold-starts from the stored checkpoint with a gap line |
| Manual | `/compact` | no |
| Reset | `POST /v1/sessions/{id}/reset` | a checkpoint with no summary |

One rollover runs per session at a time; across processes a stale write is refused with 409. The
summarizer reads the window as one quoted transcript (tool results clipped), rewrites the previous
working list rather than appending, and returns 3 to 10 dated journal lines. Code then reconciles
the rewrite against the previous list (`context/state_file.py`, `reconcile`): it applies pending
`state_close` calls, puts back word for word any entry the rewrite lost (counted as a repair, never
a rejection), carries missing dates forward, cuts entries over 400 characters, fits the list into
4,000 tokens by evicting closed and merged entries first and open preferences last (evicted lines
go to the journal), and marks stale entries. The checkpoint keeps the most recent whole turns that
fit 16,000 tokens (the last turn always). A turn that ran while the summary was being written is not
lost: the checkpoint covers the record only up to its anchor. A failed rollover is logged and
retried by a later turn; it never fails the turn that triggered it.

After a checkpoint is stored, memory upkeep is scheduled for the owner, and the runner copies the
working list and journal lines into the host (below).

## Memory and upkeep

Long-term memory is a set of **claims** per person (table `memory_claims`, store in
`stores/memory_store/`, service in `memory/service.py`). Memory belongs to the person: the
conversation and every helper read the same set, and the owner is always resolved from the calling
session on the server, never from tool arguments.

A claim is one sentence with a `kind` (`preference`, `instruction`, `fact`, `decision`, `person`,
`project`, `working_style`, `commitment`), the person's exact quote, evidence links, `stated` or
`inferred` explicitness (confidence 0.9 or 0.4 to start), a reinforcement count, an optional
`valid_until` past which it reads as expired, and a status (`active`, `superseded`, `expired`,
`forgotten`). A claim the person edited is `person_authored` and is never overwritten: a
replacement is added beside it. Search is a txtai index (`memory/index.py`) over active claims,
hybrid BM25 plus embeddings when the embeddings model (`OMNIGENT_MEMORY_EMBEDDINGS_MODEL`, default
`openai/text-embedding-3-small`) has a key, keyword-only otherwise. Without the engine's `memory`
extra the memory routes are not mounted and the tools say memory is not configured; the engine
image installs it.

Claims are written two ways:

- **By the model, right away**, with `memory_remember` (a near-duplicate reinforces instead of
  adding), and removed with `memory_forget` (plan first, then confirm). `memory_search`,
  `memory_get` and `memory_explain` read. The rules for what is worth saving are in the system
  prompt.
- **By upkeep, in the background** (`memory/upkeep.py`, scheduled by `server/memory_upkeep.py`):
  after each rollover of a conversation, and on an hourly sweep of recently active owners, at most
  4 owners at a time and one run per person. Only the person's own words since the last successful
  run are evidence; helper sessions, scheduled runs and system notices never are. Fewer than 3
  substantive new messages skips the run. Each candidate must quote the cited message verbatim,
  stay under 500 characters, and not look like a secret or a one-off request. A similar existing
  claim is reinforced (+0.05 stated, +0.2 inferred), kept beside, or superseded only when the model
  names which claim. Upkeep runs on the owner's Light model.

The **memory profile** (`MemoryService.profile`) is what goes in front of every turn and every new
helper brief: active claims of every kind except `person`, with confidence 0.75 or more (a single
inferred claim stays out until it is confirmed), grouped by kind, newest-reinforced first,
`decision` claims dropped after 30 days without reinforcement, capped at about 6,000 characters,
between `[Standing memory about the user ...]` and `[End of standing memory]`. The person reads and
edits claims through `/v1/sessions/{id}/memory/...` (owner only).

## Recall

Finding earlier work is split by cost ([ADR 0016](adr/0016-recall-is-a-bounded-hint-and-a-deep-pull-over-one-index.md)):

- **The deep pull.** The `recall` tool (`superchat/knowledge/recall.py`) takes up to three
  `queries` plus optional `project`, `file`, `chat`, `since` and `until` filters, and searches four
  sources in one fused ranking: `files`, `journal`, `conversation` (retired turns) and `memory`
  (claims, fetched from the engine). Each sub-query runs BM25 and vectors; hits are fused with
  reciprocal rank fusion; a conversation hit loses half its score every 90 days, never all of it;
  near-duplicates collapse into the newest. Every hit is dated and carries an id for
  `recall_get`: `i_<item>` (a turn), `ep_<passage>` (a journal passage), `f_<file>@<page>`,
  `c_<claim>`. `session_history` still reads exact earlier items of the chat.
- **Recall in the context brief.** Nothing from recall is in the per-turn prefix (ADR 0027); the
  `context_brief` tool carries it. Unless the person turns recall off (`PUT /v1/me/recall-hint`
  with `{"recall_hint": "off"}`; on by default), a planner call on the cheap model decides once per
  message whether anything earlier is needed and writes up to three sub-queries within 0.6
  seconds; past that, code derives them from the message (`superchat/recall_hint/hint.py`,
  `turn_plan`). Runtime notices, acknowledgements and card picks get no planner call. Turns still
  in the window are excluded, and nothing is listed when the best score is under the floor.

## The knowledge index in the host

The person's files and their index live in the host
([ADR 0014](adr/0014-files-live-in-the-host.md)). The index is SQLite with FTS5 (BM25) and
sqlite-vec on the home volume at `~/.superchat/knowledge`, kept by one background thread
(`superchat/knowledge/indexer.py`, `runtime.py`). It covers `~/workspace/your_files/`,
`~/workspace/memory/` and each `goals/<goal>/files/` folder, plus the `conversation` source: one
passage per turn, written when a checkpoint retires the turn (`runner/memory/sync.py`), with only
the person's own words and the assistant's reply, never the prefix blocks.

A file is keyword-searchable as soon as it is parsed into passages, then embedded through the
engine's model proxy so no key enters the host; an owner without an embedding connection gets
keyword search with the reason. The model reads it with the `files_*` tools (`files_search`,
`files_vsearch`, `files_query`, `files_get`, `files_multi_get`, `files_read_page`,
`files_status`) and `recall`. The engine holds no file data: its `/v1/sessions/{id}/knowledge/*`
routes relay to the host.

An attached PDF, text, Markdown, CSV or XLSX file under `your_files/uploads/` is read into the
`<attachment_context>` block of its message (up to 8 files and 48,000 characters); one that is too
long becomes a one-line manifest pointing at `files_query` and `files_get`.

## Daily notes and the working list

- **The working list** is the tagged list inside each checkpoint (`context/state_file.py`). Every
  task, decision, open loop and preference is one line, `- [t-launch-budget · 2026-10-09] text`,
  with kinds `t-` topic, `d-` decision, `o-` open loop and `p-` preference. The tag is the entry's
  identity and the date when it was last touched. An open entry other than a preference untouched
  for 30 days renders ` · stale?`, a rendering, never stored. The assistant closes a wrong entry
  with `state_close`, applied at the next checkpoint.
- **The journal and `STATE.md`.** After each checkpoint the runner appends the journal lines and the
  evicted entries to `~/workspace/memory/journal/YYYY-MM-DD.md` and writes the working list to
  `~/workspace/memory/STATE.md` (`runner/memory/files.py`, `sync.py`). Each settled Round adds
  one entry (ask, outcome, files, Helpers, folder, duration) and a delivered hand edit a line.
  Each line names its chat and, written by code, what the work touched (files, project). The folder is a projection: nothing in the engine reads it back as
  state, it is rebuilt from the stored checkpoints when missing, and the index makes it searchable.
- **Daily notes** (`superchat/daily_notes/`): one per person per local day, stored in the engine
  (`/v1/me/daily-notes`), with sections for what was talked about, decisions, promises and open
  loops. A section the person edited is only appended to. They are kept by background `notes`
  helpers whose results never wake the conversation (`quiet_moment.py`): a quiet-moment pass when
  the conversation has been idle for 20 minutes (`OMNIGENT_QUIET_MOMENT_IDLE_SECONDS`) after at
  least 3 messages, at most 4 a day; a final pass in the local evening; then a nightly reflection
  ("Dreaming", which may update `working_style` claims) and a People pass. Nothing runs while the
  person's proactivity is off or in their quiet hours. The day's note and reflection are also
  written into that day's journal file.
