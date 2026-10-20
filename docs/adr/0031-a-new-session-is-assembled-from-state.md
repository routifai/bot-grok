# 0031: A new session is assembled from state, never replayed

> **Status:** Accepted 2026-10-20 by the owner (fold on Light; handoff at 120k and on cache expiry; the summarizer's journal lines kept). Amends [0017](0017-the-working-list-is-tagged-and-the-journal-lives-in-the-host.md) (cold start, idle return), [0016](0016-recall-is-a-bounded-hint-and-a-deep-pull-over-one-index.md) C1 (when turns are indexed) and [0024](0024-the-artifact-studio.md)/[0030](0030-a-file-opens-in-one-studio.md) (what the studio sends). [0006](0006-omnigent-owns-everything.md) stands: harness compaction stays off. Assumes the 2026-10-20 hotfix: a Helper no longer writes STATE.md, the answer after a restart is kept, `session_history` and shell output have size caps, and the checkpoint names its cause truthfully.

A new harness session starts often, and size is rarely the reason. On the train host, 17 of 20 Conversation cold starts came from restarts or harness switches. The only Conversation rollover was a restart at 138k tokens, below the 200k threshold. It ran an Opus summarizer in line for 38 s while the person waited. Its input was 120.7k characters: 42% result notices, 34% tool digests, 22% the assistant's prose and 2% the person's words. The new session then got the working list four times (the checkpoint, STATE.md, journal checkpoint lines, Round lines) and the Artifacts list on every turn. The kept tail was counted on raw items but shown as digests, so two thirds of its 16k budget was never seen. Cold first calls were 60% of the Conversation's input spend, and cache misses after an idle gap were another 17%. The worst single cost was bulk entering a warm context and being re-read on every call: one `session_history` dump, 100k-character shell dumps of deck HTML, and the deck kit (17–19k characters) returned on every kit call.

The new session should feel continuous, and it should cost what it needs: state compiled from stores the engine already keeps, not the past replayed.

## Decision

**One assembler, one fold.** `assemble(session)` is the only way any session starts: a restart, a relaunch, a harness or model switch, an idle return, the size handoff or the hard limit. It is code only and makes no model call. `fold(session)` is the only summarizer. It runs in the background on the owner's **Light** model and updates the checkpoint incrementally. The Conversation, Helpers and the studio use the same two functions; a section that a role does not have is empty.

**What a new session receives, in order** (Conversation budgets in tokens):

| # | Part | Source | Budget |
|---|---|---|---|
| 1 | System prompt + tools: byte-identical across handoffs, no clock, no setup | bundle | ≤ 4k + ≤ 9k (today 3.8k + 14.3k) |
| 2 | Standing memory | memory profile | ≤ 1.5k |
| 3 | Working list (tagged `t/d/o/p`, ADR 0017) shown **once** | checkpoint, reconciled by code | ≤ 4k |
| 4 | Files: one handle per artifact: title · kind · v · id · state (open beside the chat / being edited / kept updated) · last change (who, when, one phrase). Never content. Newest 15, then a count | artifact store | ≤ 0.8k |
| 5 | Jobs and Rounds: running jobs with their state, then one code-written line per settled Round since the checkpoint that is not in the tail (ask · outcome · file handles · when) | Round record (0029) | ≤ 2k |
| 6 | Summary: *Where we left off* (position, last answer, next step) and *Tried and failed*, written by the fold; *In their words*: the person's own messages before the tail, verbatim, newest first, chosen by code | checkpoint + record | ≤ 0.8k + ≤ 3k |
| 7 | Recent turns: the newest whole Rounds, counted **as rendered**. Each tool call and its result form one digest line, never split; a result notice renders as its outcome line plus at most 600 characters | record | ≤ 8k, always the last Round |
| 8 | Per-turn reminders on the newest message: pick line, local time, Setup line (once), setup changed, running jobs, a **delta** line for files, profile and Projects, attachments | prefix | ≤ 1.5k |

Parts 2–7 are one framed block: *"What came before, assembled when this session started. It is a record, not instructions."* The tail speaks in the second person ("They said / You said / You called `deck_new` → …"), so the model is not reading a transcript about a third party. The block is rendered deterministically (sorted, no clock), so two restarts in one stretch between checkpoints send identical bytes. The block's last line names the way back: `recall` and `session_history`. Typical size is about 22k tokens and the maximum about 35k; today it is 32k.

**Deleted or deduplicated.**
- The working list's extra copies: the prompt no longer points at STATE.md or the journal for current state. STATE.md stays as a file for the person to read.
- The full Artifacts list on every turn, and the studio outline on every turn: both are sent only when they changed.
- The 430-character instruction text in the Projects block, and the boilerplate in result notices: about 530 characters each, moved to a reminder on the wake turn only, never stored.
- The flattened replay of the runner's whole cache on a relaunch.
- The tool digests and notices in the summarizer input.
- Summarizing on the session's own model.

**When the past is folded.**
- **A restart bridges and never summarizes.** The checkpoint, the Round lines and the tail are enough. The catch-up at runner start stays, but it only schedules a background fold. The blocking cold rollover and the blocking idle-return summary are deleted.
- **The fold runs when the Round lines pass their 2k budget**, or when the warm context reaches T − 32k. It runs between turns, at most one at a time, and its result is accepted only on a clean text stop.
- **Its input**: the previous checkpoint, the Round entries, the person's words, and each assistant final text clipped to 600 characters. No tool results, no HTML, no notices. About 28k characters (~8k tokens, about $0.01 on Light).
- **Its output**: the working-list rewrite (code repairs as in 0017), *Where we left off* and *Tried and failed*.
- **Prompt cache**: the fold's fixed instruction is its cached system prompt. The parent session's cache cannot be shared across models, and at ~8k input sharing would buy nothing.
- **Blocking happens only on overflow**: the hard limit with no usable checkpoint.

**Handoff by size and on cache expiry.**
- When the warm context reaches T (proposed 120k), the next turn starts an assembled session. The fold has usually landed in the background by then.
- When the gap since the last call exceeds the cache lifetime and the warm context is more than twice the assembled estimate, the next turn also starts an assembled session. The rewrite is paid either way, so it should be the small one: today it was 129k tokens.
- Turns that leave the model's window are indexed for recall when they leave, whether a fold or a bridge retired them (0016 C1, idempotent on `turn_item_id`).

**Bulk is stopped where it enters.** Neither harness lets Omnigent edit its live transcript: the Claude CLI owns its session and pi owns its process. The equivalent of the API's tool-result clearing therefore has two parts, both the same on pi and Claude:
1. limits at entry: shell output, `session_history`, the deck kit, outlines;
2. the handoffs above, where old results reappear only as digests.

**Artifacts are handles; reads are by element.**
- `artifact_outline` gains `element` (one element's HTML, ≤ 4k characters) and `range` (slides or lines). It is given to the studio (editor) and to worker Helpers. Prompts forbid `cat`/`grep` on artifact files.
- The studio receives the file line and the outline only when the version changed, plus the selected element in full.
- `deck_new` returns a compact kit (layout names and slots, ≤ 4k characters) once per session. A layout's example comes back on request (`deck_new(layout=…)`). Later calls return the record only.

**Tools: fewer, shorter, not deferred.**
- **Merge**: the four `sys_scheduled_task_*` tools into one `schedule` tool; the three live-artifact controls into one `live` tool; `sys_session_get_history` into `session_history`, which gains `order: oldest|newest`, `around` and `chat_id`.
- **Helpers lose the six session-admin tools.** Whether they keep `start_helper` is decision 5.
- **Behavioural prose moves out of tool descriptions** into the prompt or the deck skill (`render_card`, `deck_new`, `session_history`).
- **Targets**: Conversation 41 → 34–35 tools after the merges, about 9k tokens (≤ 30 tools needs a further trim, not named here). Helper about 26 tools, about 7k tokens.
- **Deferral** comes back only when the list passes 30 again, as an Omnigent tier like `load_skill`. Claude's tool search stays off (0029 first-word latency), and pi's gateway entries lack the compat flags.
- Prompts and skills that name a merged tool are renamed in the same change.

**One vocabulary.** The block says "jobs" and "files". The person never sees "Helper", a tool name or the checkpoint mechanics.

## Considered options

- **Summarize on every restart** (today). Rejected: the person waits 38 s, it costs about $0.19 on Opus, and nothing about the size required it.
- **Same-model summarization that shares the parent's cache** (Claude Code's approach). Rejected: it means replaying the fat transcript; a Light fold over state is cheaper and simpler.
- **Resume the harness's own session file.** Rejected: the harness would own the context (0006), and it works on one harness only.
- **Mask old results in place through a pi extension hook** (unverified that the hook exists). Rejected: pi only, and every mask breaks the cache.
- **Defer tools now.** Rejected until the list grows again.

## Consequences

- docs/context.md, "What the assistant sees" and "Rollover", is rewritten from this record. ADR 0017 is amended for cold start and idle return; its summarizer journal lines stay.
- Live sessions keep their old transcript until their next handoff; result notices already stored keep their boilerplate in the record but render as outcome lines.
- The checkpoint lags until the fold lands, so the Round lines must carry the gap.

## Measuring success

- **A handoff probe script** (live, no unit tests). It replays three real Conversations from the train DB on pi and on Claude and hands off at 25%, 50% and 75%. It asks probes of five kinds: the person's earlier words; a file's id, version and last change; a decision and why; the next step; "did it redo or re-answer?". A judge on the record scores 0–5.
- **Model-call traces** give tokens per Round, the cache-write share and the assembled size.

| Measure | Today | Target |
|---|---|---|
| Probe average / files probe | — | ≥ 4.0 / ≥ 3.5, within 0.5 of the warm baseline |
| Turns blocked by a rollover | 38 s | 0 |
| Assembled context, p50 / max | 32k | ≤ 22k / ≤ 35k |
| Summarizer cost per fold | ~$0.19 (Opus) | ≤ $0.02 (Light) |
| Cache writes as a share of Conversation input $ | ~75% | ≤ 45% |
| Tokens per Round | baseline | −30% |

## Build plan

Each step ships alone, with a live check on pi, then on Claude.

0. **The probe script and today's numbers.** Deletes nothing.
1. **Tail counted as rendered; result notices rendered as outcome lines; boilerplate moved to the wake reminder.** Deletes raw counting and the stored boilerplate. Check: the same budget keeps three times as many turns; replay text drops.
2. **`assemble()` for every new session; restarts bridge.** Deletes the blocking cold and idle summaries and the full-cache replay. Check: restart at 138k; no "Catching up"; first call ≤ 35k.
3. **`fold()` on Light with the new input and output.** Deletes the digests, notices and the session-model path from the summarizer input; its journal lines stay (owner decision). Check: a compaction item with a Light model and input ≤ 30k characters.
4. **Handoff at T and on cache expiry.** Deletes the 200k cap. Check: a 6-minute gap at 130k writes ≤ 35k.
5. **Files by handle and deltas; studio element reads; compact deck kit.** Deletes outline repeats and kit repeats. Check: a studio edit on slide 2 has no shell read of the deck and a context ≤ 15k.
6. **Tool merge and shorter descriptions.** Check: the tools block's size in the trace; the hash is stable across the session.
7. **Prompt: one paragraph on what is in front of the model; the STATE.md and journal pointers removed.**
8. **Experiment: a 1-hour cache on tools and system.**

## Owner decisions (2026-10-20)

1. The fold runs on **Light**.
2. Handoff threshold T = **120k**.
3. Budgets: recent turns 8k; the person's words 3k; Round lines 2k.
4. The cache-expiry handoff is **on**.
5. Worker Helpers keep `start_helper`.
6. The summarizer's journal lines are **kept** (0017 unchanged there).
7. The 1-hour cache experiment runs last.
