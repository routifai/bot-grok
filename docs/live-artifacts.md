# Live pages

A page (HTML artifact) that keeps itself up to date: an Automation re-reads the page's sources and
changes only the parts that show source facts. Live sheets follow the same rules for cells.
Terms are in `CONTEXT.md` (Automation, Live page, Live sheet).

## Rules

- Trigger: a source file changing in the Computer (debounced ~2 minutes), the schedule as a safety
  net (`kind="live_artifact"` scheduled task, parent = the page's chat, Helper type `worker`), and
  "Update now". The Computer polls the modified time of the sources of live pages (every ~30 s,
  `runner/live/`, nothing is seen while it sleeps) and reports changes to the engine, which debounces
  per page and starts the run; a run already going is looked at again after another debounce.
  `on_change` (default true) turns it off per page.
- Sources: files in the person's Computer for now (no web). If none are given, the first run
  infers them from the page and the chat and saves them.
- An update works on the newest version and changes facts by `data-superchat-id` only
  (`set-text`). Every update that changes something is one new version, origin `update`.
- The person's own note ("What to update") is read by every run.
- A fact part the person changed since the last update is theirs: the update does not overwrite
  it; it becomes a suggestion ("source says X, you wrote Y"). A fact part the person deleted stays
  deleted. A value the person undid is declined until the source says something else.
- No change found: only `checked_at` moves. No version, no chat message; the run shows as
  "checked, nothing new" where the Automation is listed and at the end of the version menu.
- Changes that cannot be placed: one open issue; two such runs in a row pause the schedule.
- The run waits while the person is editing (a hand edit in the last 10 minutes).
- A scheduled run's result is final: the Muse passes it on, never redoes it.

## Running

- Several Automations may run at once while the Computer has room: a fixed cap of 3 first, then a
  cap that follows the Computer's free memory and load (never more than ~6), and 1 while the
  person is chatting. A run that is due is queued, never dropped.
- A failed run (after its retry) shows "Last update failed · Retry" on the page and a mark in the
  Automations list. Three failed runs in a row pause the Automation and post one note in the
  Conversation with the reason and Resume. The note comes from the engine, not the Muse.

## Seeing and fixing

- Every Automation, live pages included, is listed in the Automations panel with its last run.
  A row expands to its last 20 runs; each run opens in the Activity view (steps and outcome) and
  links to the version it made.
- The Library shows a "Live" badge and a "Live" filter.
- Fixing: edit the schedule, sources and note in the page's popover or by asking the Muse (it can
  read the whole setup); "Start fresh" forgets the parts it wrote and the declined values; "Stop
  updating" removes the Automation and keeps the versions.

## Offering

- The Muse offers "Keep this page updated" once, as a follow-up chip, only when it judges the page
  will go stale. It never turns updates on by itself.

## Publishing

- A published live page follows updates by default; an update with suggestions, unplaced changes
  or a failure is held back and asks the person first. Hand edits still need a manual publish.

## Known limits

- One engine process: the scheduler's timers are per process, so two engine replicas would fire
  every run twice. A per-run database lease is needed before scaling out.
- No per-Automation cost yet; no admin view; documents and decks cannot be live.

## Build order

1. Engine: never drop live runs, cap 3 at once, failure state and pause after 3, engine-written
   pause note.
2. Automations list with live pages and run history (Activity view), Library badge and filter,
   "nothing new" trace.
3. "What to update" note, "Start fresh", Muse can read the setup, the follow-up chip offer.
4. File-change trigger from the Computer.
5. Published copy follows updates, holding back unusual ones.
6. Dynamic cap from the Computer's load; 1 while chatting.
7. Live sheets.
