# Context assembly on Omnigent — findings and implementation plan

Scope: a long-lived **main session** whose prompt is built by a **context assembler** on every wake-up, delegating work to **task sessions** or lighter options, on three harnesses: **Pi (`pi`)**, **Codex (`codex`)** and **Claude SDK (`claude-sdk`)**. The user picks the harness, or we pick it for them. All code references are to Omnigent (`engine/omnigent/omnigent/...`), read on 2026-09-29.

## Vocabulary (only these words)

- **Session**: an Omnigent session. The **main session** talks to the user and lives for months. **Task sessions** do bounded work and live for minutes.
- **Prompt**: what a model receives. **The user's prompt** is what they type. **The assembled prompt** is what the context assembler builds for the main session each time it wakes up.
- **Wake-up**: one run of the main session, triggered by the user's prompt, a finished task, or a timer.
- **Record**: everything Omnigent stores for a session (every item, forever). **Task list**: the durable table of delegated work.

---

## Part 1 — Findings (from the Omnigent code)

### 1.1 How a message reaches a harness today

1. The server stores every item of a session (messages, tool calls, reasoning, compaction markers) and serves them at `GET /v1/sessions/{id}/items`.
2. The runner loads them **once** with `_load_history_as_input` (`runner/app.py` ~5269) and caches them in `_session_histories[conv]` (~8931); later messages are appended to the cache.
3. `_convert_raw_items_to_input` (~5331) starts **at the latest `compaction` item**: that item's `compacted_messages` (or a summary user/assistant pair), then everything after it.
4. The whole list is sent to the harness as the turn input; the adapter turns it into `messages` and calls `executor.run_turn(messages=…)` (`runtime/harnesses/_executor_adapter.py:207`).
5. The executor decides: **fresh state** → use the list; **warm state** → send only what's new and rely on its own memory.

### 1.2 Warm vs fresh, and how to discard

- Every executor implements `close_session(session_key)` to release per-session state (`inner/executor.py`, `Executor.close_session`).
- Omnigent already uses it to force a fresh start: on interrupt Codex "always drop[s] the session (resets thread_id) so the next turn starts a fresh thread and replays full history" (`inner/codex_executor.py` ~4614).
- After `close_session`, the next `run_turn` takes the fresh path and uses the list it is given.

### 1.3 The three harnesses

| | `pi` | `codex` | `claude-sdk` |
|---|---|---|---|
| Runs as | `pi --mode rpc --no-session` subprocess (`inner/pi_executor.py`) | Codex app-server thread (`inner/codex_executor.py`) | resident `ClaudeSDKClient` (`inner/claude_sdk_executor.py`) |
| Declared instruction delivery (`harness_plugins.py`) | composed-per-turn | composed-per-turn | composed-session-snapshot |
| While warm | process holds history; new message only | thread holds history; latest message only (`_prompt_for_turn`) | client holds history; trailing user message only |
| New instructions while warm | **restarts the process** whenever the system prompt changes (`_ensure_rpc`) | yes, per turn | **no** — options apply only when a client is created (`_get_or_create_client`) |
| `close_session` | ends the process | drops session + thread id | `_clients.pop` |
| Fresh start uses | flattened text "Conversation so far: role: text…" (`_build_pi_prompt`, `is_first_turn`) | `_build_initial_prompt(messages)` into a new thread | flattened text prefix + latest message (`_build_prompt(resume_session=False)`) |
| Fresh-start cost | a process start | a thread start | a Claude Code process start (seconds) |
| Own compaction | Pi internal | Codex auto-compact | Claude native `/compact` (Omnigent's is bypassed, `runner/app.py` `_handle_claude_sdk_compact`) |
| Vendor memory switch | `context_files: false`, `system_prompt_mode: append\|replace` | per-session private `CODEX_HOME`, but global `AGENTS.md` is symlinked in | `skills_filter: "none"` → `setting_sources=[]` (hides CLAUDE.md, `_resolve_skills_option`) |

Consequence: all three **can** be made to depend only on what we give them; each has a different cost, and Pi and Claude SDK currently rebuild from **flattened text**, losing tool-call structure.

### 1.4 Omnigent pieces we reuse

| Need | Omnigent today |
|---|---|
| Per-wake-up instructions from outside | `runtime/context_provider.py` + `POST /v1/sessions/{id}/deployment-context` (`server/routes/sessions/routes_core.py`), called by the runner in `_append_deployment_context` (`runner/app.py` ~1336); owner-only; fails open |
| Bounded history | `compaction` item + `_convert_raw_items_to_input` |
| Fresh harness | `Executor.close_session` |
| Sub-work in a new session | `sys_session_create` / `sys_session_send` (`tools/builtins/spawn.py`); child tree via `parent_conversation_id` / `root_conversation_id`; per-child harness |
| Wake the main session | `POST /v1/sessions/{id}/events` with `type: "message"`; the runner already posts one when a child finishes (`runner/app.py` ~2447–2487); codex-native children are special-cased (~8373) |
| Guard rails | policies `spawn_bounds` (default 5/turn), `blast_radius`, `headless_subagent_purpose_guard`, `worktree_guard` (`policies/builtins/orchestration.py`) |
| Timers | scheduled tasks (`server/routes/scheduled_tasks.py`) |
| Harness per session | `harness_override` on the conversation; `POST /v1/sessions/{id}/switch-agent` |
| Task tracking | only `session_todos` (display snapshot, max 100, `native/session_todos.py`) — **no durable task list** |

---

## Part 2 — Design

### 2.1 Who knows what

| | Main session | Task session |
|---|---|---|
| Harness knows | only the assembled prompt (+ its own base prompt and tool definitions) | the brief + context pack at start, then its own context |
| Harness lifetime | discarded or revalidated each wake-up (2.4) | warm for the whole task |
| History | record from the latest summary (compaction item) | kept and compacted by the harness |
| Vendor memory | off | off |
| Leaves it | replies to the user, `spawn_task` calls | one `finish_task` report (~1,500 tokens), files by reference |

### 2.2 The assembled prompt

- **Prefix** (stable, cacheable): rules, tool contract, delegation policy, skills catalog, core memory (versioned).
- **Middle** (append-only between summaries): the summary (as the compaction item) + items since it, including task events and reports.
- **Tail** (per wake-up): open tasks recap, recalled memory, the trigger, time.

Prefix and tail travel through the deployment-context hook; the middle is the runner's normal history input.

### 2.3 Record vs prompt

The record keeps everything. The summarizer (a background job) writes our summary **as an Omnigent `compaction` item** once 100 items are unsummarized, folding the oldest 50; it advances a cursor only if no other job moved it (compare-and-set). The runner then loads from that item, so the harness input stays bounded however long the session lives.

### 2.4 Fresh vs warm-while-valid

A harness may stay warm across wake-ups only while its memory equals what we would send:

- **Valid** if the prefix digest is unchanged **and** no new compaction item has landed since it started. Its history is then exactly the record since the summary (append-only).
- **Otherwise** the runner calls `close_session`, and the next wake-up rebuilds from the assembled prompt.
- The **tail** must reach the model without changing the system prompt when we want to stay warm:
  - `codex`: per-turn instructions work while warm → tail in instructions.
  - `pi`: a system-prompt change restarts the process → tail as a tagged block at the start of the user's prompt (the turn input), not in the system prompt.
  - `claude-sdk`: instructions are frozen per client → same as Pi.
  - The tail block must be **transient** (sent, not persisted as the user's text). To verify: the runner's transient-item support (`split_transient_tail` is used by the OpenAI Agents executor).

### 2.5 Delegation ladder

The main session picks the lightest rung that fits; every rung from 3 up writes one task list row, ends with one `finish_task`-shaped report and one wake-up.

1. **Answer** directly.
2. **Tool or workflow** (known steps).
3. **Helper inside the wake-up**: a nested agent with a clean prompt, result returned as a tool result; ≤ 4 in parallel, no nesting, result capped (~12K chars). No new session.
4. **Background helper**: like 3 but outlives the wake-up (new runner feature; later).
5. **Worker from a pool**: reuse a warm task session via `sys_session_send(session_id)`, reset between tasks.
6. **New task session**: `sys_session_create` — own sandbox, permissions, runner, or full isolation.

### 2.6 Choosing the harness

- **User picks** per main session (stored as `harness_override`, changed with `switch-agent`; the next wake-up rebuilds from the record anyway).
- **Auto** when the user doesn't pick:
  - Main session default: `pi` (cheapest fresh start, per-turn instructions).
  - `codex` when recent work is mostly code in a repo.
  - `claude-sdk` for long-document/writing-heavy users, or when the user prefers Claude; runs warm-while-valid to avoid a process start per wake-up.
  - Task sessions pick per task: `codex` for code changes, `claude-sdk` for long documents and complex edits, `pi` for research and light tool use.

---

## Part 3 — Wiring

```
user's prompt ─► server (record) ─► runner
                                     │ 1. deployment-context ─► server ─► assembler ─► prefix + tail
                                     │ 2. history input = record from latest compaction item
                                     │ 3. warm-while-valid? else close_session
                                     ▼
                              executor.run_turn(messages)  (pi | codex | claude-sdk)
                                     │ items ─► record
                                     │ spawn_task ─► task list ─► rung 3 | 5 | 6
                                     ▼
            task finishes ─► finish_task report ─► task list ─► wake-up event ─► main session
            summarizer (scheduled) ─► compaction item ─► runner drops _session_histories[conv]
```

| Component | Lives in | New / existing |
|---|---|---|
| Context assembler (`provide(session) → prefix, tail`) | server process, behind `OMNIGENT_CONTEXT_PROVIDER` (`runtime/context_provider.py`) | new module, existing hook |
| Fresh-prompt label `omnigent.fresh_prompt=true` | session labels | new |
| Warm-while-valid check + `close_session` | `runtime/harnesses/_executor_adapter.py` (already calls `close_session` on shutdown/resync) | new logic |
| Tail as transient turn block (pi, claude-sdk) | runner turn dispatch (`runner/app.py`) | new |
| Summarizer → compaction item + cache drop | scheduled task + `runner/app.py` `_session_histories` | new |
| Omnigent compaction off for flagged sessions | agent spec `compaction` | config |
| Vendor memory off | agent bundles: `context_files: false` (pi), `skills_filter: "none"` (claude-sdk), no global `AGENTS.md` link (codex, `codex_executor` home setup) | config + small change |
| Task list store + routes | server stores + `server/routes` | new |
| `spawn_task`, `finish_task`, `open_result` tools | `tools/builtins/` (server-side) | new, wraps `spawn.py` |
| Server-side wake on terminal child status | server (replaces the runner-posted notice, removes the codex-native exception) | new |
| Helper tool (rung 3) | executor-level nested agent | new |

---

## Part 4 — Implementation plan

Each phase ships on its own and has an acceptance test.

### Phase 0 — Spike the unknowns (2–3 days)
- Does one executor instance serve several sessions on a runner (adapter `_ensure_executor` caching)? Does `close_session` of one session affect others?
- Does closing after every turn drop steering messages queued mid-turn?
- `codex` `_build_initial_prompt`: exact replay format (structured vs text).
- Transient turn block: can the runner send a tail block that is not persisted as the user's text?
- `claude-sdk`: can a fresh client resume from a transcript file built from items (reuse `harnesses/claude_native/main.py` `_ensure_local_claude_resume_transcript`) instead of flattened text?
**Accept:** a written answer with file:line for each.

### Phase 1 — Assembler behind the instructions hook
- Add `OMNIGENT_CONTEXT_PROVIDER=<assembler>`; implement `provide()` returning prefix + tail; stable ordering, byte budgets, untrusted-data framing.
**Accept:** on each of the three harnesses, a wake-up's model input contains the assembler's prefix and tail (checked from the harness process args / request logs).

### Phase 2 — Fresh harness per wake-up + vendor memory off
- Label `omnigent.fresh_prompt`; adapter calls `close_session` after each completed turn on labelled sessions.
- Bundles: `context_files: false`, `skills_filter: "none"`, codex without the global `AGENTS.md` link.
**Accept:** conformance test per harness — wake-up 1 sets a fact only in the prefix; wake-up 2 changes it; the model answers with the new value; a planted host `CLAUDE.md`/`AGENTS.md` never appears in the input.

### Phase 3 — Bounded history
- Summarizer as a scheduled task: fold 50 when 100 are unsummarized, compare-and-set cursor, write a `compaction` item; runner drops `_session_histories[conv]` on that event. Omnigent compaction off for labelled sessions.
**Accept:** a synthetic 3,000-item session keeps harness input under a fixed budget; the record still returns all items.

### Phase 4 — Task list and delegation (rungs 5 and 6)
- Task list store, `spawn_task` (brief: goal, deliverable, harness, depends_on, budget, scope) wrapping `sys_session_create` / `sys_session_send`, `finish_task`, `open_result`, fallback summarizer when a task ends without a report, server-side wake on terminal status. Caps: `spawn_bounds` 5/wake-up, ≤ 4 running per main session, depth 1, retries ≤ 2.
**Accept:** fan-out (2 parallel tasks), dependent chain (T2 waits for T1 and receives its report), failing task (error visible, retry capped), blocked task (question reaches the user, answer resumes the same task session).

### Phase 5 — Harness choice
- UI/API to pick `pi` / `codex` / `claude-sdk` per main session; auto policy (2.6); `switch-agent` between wake-ups.
**Accept:** switching harness mid-life keeps the conversation (next wake-up rebuilds from the record) and the same answer quality on a fixed eval set.

### Phase 6 — Warm-while-valid (cost)
- Prefix digest + compaction marker check; keep warm when valid; tail as transient block for `pi` / `claude-sdk`, via instructions for `codex`.
**Accept:** on `claude-sdk`, median wake-up latency drops (no process start when valid) with identical answers on the eval set; prompt-cache hit rate reported.

### Phase 7 — Structured fresh starts
- `pi`: a `pi-sdk` executor on `pi-agent-core` taking structured messages (fresh `Agent` per wake-up), or a Pi session file; `claude-sdk`: resume transcript built from items; `codex`: structured replay if Phase 0 shows text.
**Accept:** tool calls and images from before a fresh start are still usable by the model (eval: "use the value from the tool result three wake-ups ago").

### Phase 8 — Helper inside the wake-up (rung 3)
- A `run_helper` tool on each executor: nested loop with a clean prompt, parallel ≤ 4, result capped.
**Accept:** research fan-out finishes in one wake-up with no new sessions created.

### Evaluation (runs from Phase 2 on)
Fixed sessions: question answering, single task, fan-out, dependent chain, failing task, a 200-wake-up session. Metrics: tokens per wake-up, prompt-cache hit rate, latency, cost, answer quality vs a single-harness baseline, and how often each ladder rung is used (over-delegation check).

---

## Risks

- Reports are the ceiling on what the main session knows → required `confidence`, `open_question`, files by reference, `open_result`.
- Flattened fresh starts on `pi` / `claude-sdk` until Phase 7 → keep summaries tight and tool results referenced.
- `claude-sdk` process start per wake-up → Phase 6.
- Task session start latency (runner/sandbox) → worker pool (rung 5).
- Over-delegation (multi-agent costs ~15× chat tokens in published results) → ladder + eval.

## Design principles behind this (external sources)

Sub-agents return compressed results, not traces (Anthropic multi-agent research system); stable prefix, append-only context, recite the plan, keep errors visible (Manus); share decisions across dependent work (Cognition); memory outside the prompt, maintained off the hot path (Letta); quality falls with context length well before the limit (Chroma "context rot").
