> **Historical.** This was the original build plan for the Muse edition (soft fork, in-process executor, the reference agent ports). The product now runs on the Omnigent engine; for the current design read [CONTEXT.md](../../CONTEXT.md), [docs/adr/](../adr) and [docs/super-chat/](../super-chat/README.md). Paths such as `executor.ts` no longer exist.

# Muse edition — implementation plan

Turn Aiden into a single proactive personal agent in the shape of established personal agents: one **Muse** per person that pursues **Goals** in the background, comes back with **Asks**, and keeps a **Feed**, **Ideas**, and a **Library**.

This plan is written for implementation agents (Claude Sonnet 5, model id `claude-sonnet-5`) working in parallel as a **backend** stream and a **frontend** stream. Each work package below is sized for one agent in one isolated worktree.

## Read first (every agent)

1. `CONTEXT.md` — the glossary. Use its words (Muse, Helper, Goal, Task, Proposal, Ask, Conversation, Goal log, Check-in, Proactivity, Feed, Post, Followed topic, Idea, Library) in code comments, copy, and PRs. Never call the Muse a "bot" in new copy.
2. `docs/adr/0001-one-muse-per-person.md` — why bot creation is locked and why this is a soft fork.
3. `AGENTS.md` — repo rules. They all apply. The ones that matter most here: minimal UI and copy, one source of truth, reuse existing primitives, `import type` at top level, semantic tokens only (no hex in components), deterministic offline tests.

## Ground rules

- **Reuse before building.** For every piece, first use what Aiden already has, then port from an open-source reference agent (MIT, Python), and only then write something new. Each package below says which is which. If you find existing code that does the job and the plan says "new", use the existing code and say so in your report.
- **Our fork (ADR 0002).** Muse logic goes in its own modules (e.g. `packages/adapters/src/muse/`); refactor upstream files when that makes the code cleaner. This used to mean gating everything behind `AIDEN_PRODUCT_MODE=muse` and keeping the old multi-bot behaviour intact when the mode was off (package B0); that flag and the old mode it guarded have since been deleted outright (see B0 below), so there is no other mode left to preserve.
- **Naming in code.** The glossary **Task** is `GoalTask` in code (the upstream `Task` model is an unrelated request record and keeps its name). Database tables use the upstream convention (`@@map("goal_tasks")`).
- **the reference agent ports.** When copying prompt text or logic from the reference agent, keep a one-line comment at the top of the file: `// Adapted from the reference agent (MIT) — reference/<path>`.
- **Out of scope for v1:** mobile screens (mobile keeps working with the Conversation only), spending limits, parallel Goal work, payments.

## Commands

```bash
pnpm db:generate          # after schema changes
pnpm db:migrate           # needs Postgres up with the postgres-host overlay
pnpm test                 # vitest, offline
pnpm check                # typecheck (turbo)
pnpm lint                 # biome
pnpm dev                  # full stack on :3100 / :5173
```

Migrations go in `packages/db/prisma/migrations/<timestamp>_<name>/migration.sql` (see the latest folder for the format).

## Decisions this plan implements

| # | Decision |
|---|---|
| 1 | One Muse per person. Peer-bot creation is locked; the Muse only starts Helpers (`run_subagent`). |
| 2 | Soft fork behind a product mode; never proposed upstream. |
| 3 | Goals are big outcomes only. Tasks always belong to a Goal. Routines stay a separate feature. |
| 4 | The Muse marks Task progress itself; any change to a plan's shape, including the first plan, is a Proposal the person accepts. One open Proposal per Goal. |
| 5 | Everything waiting on the person is an Ask, listed in one "Waiting on you" list, answerable anywhere. |
| 6 | Proactivity off / low / normal / high (every 4h / 1h / 20m), quiet hours (default 22:00–08:00), wake on answered Asks and on Check-ins. No spending cap. |
| 7 | Background work happens in a per-Goal Goal log; the Conversation gets a short report. Goal work sees its Goal log, the Conversation summary, and shared memory. |
| 8 | At most one Goal is worked on at a time; the Conversation always goes first. |
| 9 | Screens: Conversation, Goals, Waiting on you, Feed, Ideas, Library. |
| 10 | Feed = open Asks pinned on top, then Posts (Goal reports and Followed-topic findings). |
| 11 | Goal work follows the same approval rules as the Conversation. |
| 12 | Web and Electron first. |
| 13 | Onboarding: Aiden's steps + name and face; ends by asking for the first Goal. Face is the new Muse avatar, default color sky `#0090FF`. |

## Map: what exists, what is ported, what is new

| Need | Aiden already has (reuse) | the reference agent (port) | New |
|---|---|---|---|
| Waking without the person | Graphile jobs, `background-job-handlers.ts`, `job-reconciler.ts`, `routine.wakeup` | — | `goal.advance`, `goal.checkin` job handlers |
| Check-in schedules | `Routine.crons` + `timezone`, `schedule-tools.ts`, `RoutineSchedule.tsx` | — | reuse the same cron shape on Goal |
| Background work prompt | turn execution in `executor.ts` | `ADVANCE_GOAL_PROMPT`, `CHECK_IN_PROMPT` in `reference/prompts.py` | — |
| Goal / Task statuses, proposal flow | — | `reference/goals/store.py` (statuses, proposal), `reference/tools/goal_tools.py` (tool actions) | Prisma models + `goals` tool |
| Plan in every turn | `scratchpad-context.ts` pattern | goal `render()` format | `goals-context.ts` |
| Asks (approve, question) | `kind: "ask"` message blocks, `approval-ask.ts`, `AskCard.tsx`, `threads.answer` RPC | — | Proposal + blocked-Task asks reuse the same block; `asks.list` query |
| Proactivity dial, quiet hours | — | `reference/server/service.py` (`proactivity`, `interval_seconds`, `in_quiet_hours`) | fields on the Muse + gate in job handler |
| Serial Goal work | Graphile named queues | — | one queue per Muse |
| Helpers | `run_subagent` | — | — |
| Push when an Ask opens | `notifications.registerPush`, VAPID web push | — | trigger on new Ask |
| Library | `apps/web/src/pages/Artifacts.tsx`, `artifacts.*` RPCs | — | include Goal-log artifacts |
| Feed / Ideas | — | feed + ideas behaviour in `reference/server/service.py` (`feed_posts`, ideas) | `Post`, `FollowedTopic`, `Idea` + daily jobs |
| Avatar with states | `packages/ui-web/src/bot-avatar.tsx` (`BotAvatar`, `data-working`), avatar studio (color picker only) | idle / working / waiting state idea (`web/src/components/Avatar.tsx`) | Muse face (Aiden the lion, see DESIGN.md) replacing the Grok mascot shapes in muse mode + `waiting` state |
| Onboarding | `apps/web/src/pages/Onboarding.tsx`, `apps/api/src/onboarding.ts` | first-run order (your name → Muse name → face → model) | name + face step, first-Goal handoff |

## Work packages

IDs: `B` = backend agent, `F` = frontend agent. "Depends on" lists what must be merged first. Contract package B1 is the hand-off point: once it lands, the frontend builds against the real types while backend implements them.

### Phase 0 — Foundations

**B0 · Product mode** — ✅ done, later removed
- The `AIDEN_PRODUCT_MODE` flag (`resolveProductMode`/`isMuseMode` in `packages/core/src/product-mode.ts`, `productMode` on the API env and the `me`/`bootstrap` payload) let the old multi-bot mode coexist with Muse during the port. Once the port was verified, the old mode and the flag were deleted outright: Muse is now the only behaviour, unconditionally.

**B1 · Contracts (hand-off to frontend)** — ✅ done
- Shapes in `packages/contracts/src/muse.ts`: `Goal`, `GoalTask`, `GoalProposal`, `Ask` (a view over a pending ask/choice block: `id` = message id, `runId`, `kind`, `goalId`, `goalTitle`, `text`, `detail`, `choices`, `input`), `Post`, `Feed` (asks + posts), `FollowedTopic`, `Idea`, `MuseSettings` (+ `DEFAULT_MUSE_SETTINGS`), `MuseState`, `DEFAULT_MUSE_COLOR`.
- Procedures appended to `rpc.ts`: `goals.list/get/update/acceptProposal/dismissProposal/log`, `asks.list/count/answer`, `feed.list`, `ideas.list/refresh`, `topics.list/remove`, `muse.settings/updateSettings`. There is no `goals.create`: Goals are created by talking to the Muse (the `goals` tool, B4).
- The API implements them in `router.ts` behind a `museOnly` guard (NOT_FOUND unless muse mode) and serves **sample data** from `apps/api/src/muse-preview.ts` (in-memory; accepting a Proposal or answering an Ask changes it). Each backend package replaces its part of the preview; delete the file when all are real.
- Tests: `muse-preview.test.ts` validates the sample data against the schemas and the Proposal/Ask flow.

### Refactor — own the run engine (ADR 0002)

**R1 · Split `executor.ts`** — before B2/B5/B8
- Behaviour-preserving split of `packages/adapters/src/executor.ts` (~5,700 lines) into focused modules under `packages/adapters/src/executor/` (e.g. prompt assembly, context assembly, tool dispatch, run lifecycle/finalize, approvals replay), with `executor.ts` kept as a thin entry that re-exports the same public API. No logic changes; every existing test passes unchanged. Muse work (B2, B5, B8) then lands in the relevant module, with Muse-specific logic in `packages/adapters/src/muse/`.

### Phase 1 — One Muse

**B2 · Lock peer bots** — depends on B0
- In muse mode, remove `spawn_bot`, `update_bot`, `archive_bot`, `message_bot`, `handoff_to_bot`, `create_space` from the tool list given to the runtime (filter where the tool list is assembled; keep `run_subagent`). Check `pi-runtime.ts`, `scripted-runtime.ts`, and `executor.ts` for every place the list is built.
- Guard `bots.create`, `bots.duplicate`, `bots.restore` RPCs in `router.ts`: in muse mode, reject when the person already has a live bot.
- Add the Helper instruction to the Muse's system prompt parts (`executor.ts` prompt assembly): use `run_subagent` for independent parallel work; never create bots.
- Acceptance: scripted-runtime test shows the tools are absent in muse mode and present otherwise; RPC test for the create guard.

**F1 · Single-Muse shell** — depends on B1
- In muse mode, remove the bot list, the "+" new-bot entry, bot duplicate/archive in `BotContextMenu.tsx`, and group chat entry points. The app opens straight into the Muse's Conversation.
- Add rail entries in `AppRail.tsx`: Conversation, Goals, Feed, Library (Ideas lives inside Feed, "Waiting on you" opens from the avatar). Build each screen as its own file under `apps/web/src/pages/muse/`; `Shell.tsx` only routes to them.
- Replace "bot" with the Muse's name or "Muse" in any copy the person sees in muse mode.
- Acceptance: web test opens `/app` in muse mode and asserts no bot list and the four rail entries.

### Phase 2 — Goals

**B3 · Goal schema** — depends on B1
- Prisma models: `Goal` (spaceId, userId, botId, title, description, status `active | paused | done | cancelled`, due, checkInCrons `String[]`, timezone, lastWorkedAt, nextWorkAt, createdAt, updatedAt), `GoalTask` (goalId, idx, title, status, note, updatedAt), `GoalProposal` (goalId, reason, tasks JSON, status `open | accepted | dismissed`, askMessageId, createdAt). Partial unique index: one `open` proposal per goal.
- `Thread`: add nullable `goalId String? @unique` with relation. A Goal log is a `Thread` with `goalId` set and `botId` null (bot threads keep `botId` unique as today).
- Migration + `pnpm db:generate`.
- Acceptance: migration applies on a fresh DB and on your existing one.

**B4 · `goals` tool** — depends on B3
- Port the action set from `reference/tools/goal_tools.py`: `create` (title, description, due, check-in → creates Goal + first plan as a Proposal, not live Tasks), `get`, `list`, `update_task` (status + note; progress only), `propose` (reason + full revised task list). Plan-shape changes only through `propose`.
- Tool definition in `builtin-tools.ts` next to `scratchpad_*`; handler in a new `packages/adapters/src/goal-tools.ts` following `scratchpad-tools.ts`; dispatch from `executor.ts` the same way `scratchpad_add` is dispatched (around line 2751).
- A `propose` or a first plan posts an ask block (reuse `buildApprovalAskBlock`'s shape; actions `accept` / `dismiss`) into the Conversation and links it in `GoalProposal.askMessageId`. A new proposal withdraws the previous open one (mark its ask block `withdrawn`).
- `update_task` with `blocked` and a note that needs the person posts an ask block of kind `blocked_task`.
- Acceptance: scripted-runtime tests for each action; proposal accept via `threads.answer` replaces the Task list; dismiss leaves it; only one open proposal.

**B5 · Goals in context** — depends on B3
- New `packages/adapters/src/goals-context.ts` modelled on `scratchpad-context.ts`: active Goals with their Tasks and statuses, wrapped as data (`<goals_active>…</goals_active>`), capped (e.g. 8 KB). Render format adapted from the reference agent `Goal.render()`.
- Add it to the `Promise.all` context assembly in `executor.ts` (next to `scratchpadContext`) only in muse mode.
- In a Goal-log turn, also include the Conversation thread's `historyCompactionSummary` as data (decision 7), and include only that Goal in full.
- Acceptance: unit tests for rendering and the byte cap; executor test that a Goal-log turn gets the Conversation summary and not other Goal logs.

**B6 · Goal RPCs** — depends on B3, B4
- Implement `goals.*` from B1 in `apps/api/src/router.ts` via a new `apps/api/src/goals.ts`. `acceptProposal`/`dismissProposal` share one code path with the ask answer from B4.
- Acceptance: RPC tests, including authorization (space and user scoping like existing routes).

**F2 · Goals screen** — depends on B1 (build on contracts), wire to B6
- `pages/muse/Goals.tsx`: list of Goals (status, next Task, due, check-in). Goal detail: the plan (Tasks with status), the open Proposal with Accept / Dismiss (reuse `AskCard.tsx`), and a read-only Goal log view reusing the existing thread message rendering from `chat-ui`.
- Check-in editor reuses `RoutineSchedule.tsx`.
- New Goal is created by talking to the Muse; the screen has no create form in v1.
- Acceptance: web test renders a seeded Goal with a Proposal and accepts it.

### Phase 3 — Proactivity

**B7 · Muse settings** — depends on B3
- Store `proactivity` (default `normal`) and `quietHours` (default `22:00-08:00`) on the Muse (bot settings or a small `muse_settings` table; prefer an existing per-bot settings location if one fits). Port `interval_seconds` and `in_quiet_hours` from `reference/server/service.py` to `packages/core/src/muse/proactivity.ts` with tests (intervals: low 4h, normal 1h, high 20m; quiet window may wrap midnight).
- Implement `muse.settings.*`.

**B8 · Background Goal work** — depends on B4, B5, B7
- Job handlers in a new `packages/adapters/src/goal-jobs.ts`, registered in `background-job-handlers.ts`:
  - `goal.advance {goalId}` — skip if the goal isn't `active`, proactivity is `off`, or we're in quiet hours (reschedule to the window's end). Otherwise run a turn in the Goal log thread with `ADVANCE_GOAL_PROMPT` (ported, adapted to the `goals` tool actions). When the turn ends, post a short report to the Conversation and a `Post` (kind `goal_report`), then schedule the next `goal.advance` by proactivity.
  - `goal.checkin {goalId}` — run a turn with `CHECK_IN_PROMPT` (ported) whose message goes to the Conversation; schedule the next cron occurrence (reuse the cron logic behind `Routine.nextRunAt`).
- Serial work: enqueue both with Graphile `queueName: "muse:<botId>"` so at most one runs per Muse. Before starting, if a Conversation run is active for this Muse, reschedule `+60s` (the Conversation goes first).
- Wake on answer: when an ask linked to a Goal (proposal or blocked Task) is answered, enqueue `goal.advance` now.
- Reconcile on boot: extend `job-reconciler.ts` so every active Goal has its next job.
- Acceptance: tests with the scripted runtime for skip rules, quiet-hour reschedule, serial queue name, Conversation-first reschedule, wake-on-answer.

**F3 · Proactivity controls** — depends on B1, wire to B7
- In the Muse's settings: a four-step Proactivity control and a quiet-hours range. Nothing else.

### Phase 4 — Asks

**B9 · Asks list** — depends on B4
- `asks.list` / `asks.count`: pending `kind: "ask"` blocks across the Muse's Conversation and all its Goal logs, newest first, mapped to the `Ask` view type. Answering keeps using `threads.answer` (one source of truth: the message block). Add an index or a narrow query if the JSON scan is slow; measure first.
- Send a web push (existing push service) when a new Ask is created in a Goal log, since the person isn't watching that thread.
- Emit the existing realtime event so the count updates live.

**F4 · Waiting on you** — depends on B1, wire to B9
- The Muse avatar shows the open-Ask count; tapping it opens a sheet listing every Ask, each rendered with `AskCard.tsx` and answerable in place; each links to where it came from (Conversation or Goal).

### Phase 5 — Feed, Ideas, Library

**B10 · Posts and Followed topics** — depends on B8
- Models `Post` (botId, kind `goal_report | topic`, title, body, goalId?, sourceUrl?, createdAt) and `FollowedTopic` (botId, topic, createdAt).
- Tools `follow_topic` / `unfollow_topic` (new, small, next to `remember`).
- Job `feed.daily` at 07:00 in the person's timezone: for each Followed topic, `web_search` + a short summary → `Post` (kind `topic`) with the source URL. Behaviour and prompt adapted from the reference agent's feed posts.
- `feed.list` returns open Asks first, then Posts.

**B11 · Ideas** — depends on B5
- `Idea` model (botId, text, area, createdAt), replaced wholesale on refresh. Job `ideas.refresh` daily and after a Goal changes status; one model call over active Goals, memory, and the Conversation summary returning 6 short ideas (prompt adapted from the reference agent's ideas). `ideas.refresh` RPC for manual refresh.

**F5 · Feed** — depends on B1, wire to B10
- `pages/muse/Feed.tsx`: open Asks pinned (same `AskCard`), then Posts; each Post links to its Goal log or source. Ideas section at the bottom (F6).

**F6 · Ideas** — depends on B1, wire to B11
- Chips grouped by area; tapping one sends it as a message in the Conversation and switches to it.

**F7 · Library** — depends on F1
- Reuse `pages/Artifacts.tsx` as the Library screen. Make sure it lists artifacts from Goal logs too (backend: confirm `artifacts.list` is space-scoped, not thread-scoped; fix in `apps/api/src/artifacts.ts` if not).

### Phase 6 — Face and first run

**F8 · Muse face** — depends on B1
- Add the Muse face to `packages/ui-web/src/bot-avatar.tsx` as a new variant, drawn as Aiden, an original vinyl-toy lion (see DESIGN.md "The Muse"). In muse mode it replaces the shipped mascot shapes (`GROK_SHAPES`) everywhere: the Muse always wears this face, and the avatar studio offers only the color. Upstream shapes stay untouched for non-muse mode. States: `idle` (breathe + blink), `working` (sway, spark spins; reuse the existing `data-working` from `ACTIVE_RUN_STATUSES`), `waiting` (hop + Ask count badge, driven by `asks.count`). Honour `prefers-reduced-motion`. Colors come from the identity color and `@aiden/ui-tokens`; no new hex in components except the identity color default (`DEFAULT_MUSE_COLOR`) defined once.

**F9 · Onboarding** — depends on F8, B4
- Extend `pages/Onboarding.tsx` (and `apps/api/src/onboarding.ts` if the server drives steps): your name → Muse name → color of the Muse face (sky default) → model → land in the Conversation, where the Muse's first message asks for the first Goal. When the person answers, the Muse calls `goals.create`, which posts the first plan as a Proposal (B4).

## Parallel schedule

```
B0 ─► B1 ──────────────────────────────────────────────► (frontend starts here)
 │     ├─► B2
 │     ├─► B3 ─► B4 ─► B6
 │     │     ├─► B5 ──────────────► B11
 │     │     └─► B7 ─► B8 ─► B10
 │     │           B4 ─► B9
 │     └─► F1 ─► F7
 │         F2, F3, F4, F5, F6, F8 (build on contracts, wire when backend lands)
 └──────────────────────────────── F8 ─► F9 (needs B4)
```

Waves:
1. Done: B0, B1.
2. Done: Frontend F1–F9 (plus the design passes in DESIGN.md).
3. Backend, in parallel: R1, B3, B7.
4. Backend, in parallel: B2, B4, B5, B9 (replace preview asks).
5. Backend, in parallel: B6 (replace preview goals), B8, B11 (replace preview ideas).
6. Backend: B10 (replace preview feed/topics); delete `muse-preview.ts`.
7. End-to-end check (below).

## Orchestration notes

- Run each package as its own subagent with `isolation: "worktree"` and model `sonnet` (Sonnet 5). Give it this file, `CONTEXT.md`, the ADR, and its package section. One package per agent; an agent refuses scope outside its package and reports it instead.
- Backend agents own `packages/db`, `packages/adapters`, `packages/core`, `apps/api`, `apps/worker`, and the backend half of `packages/contracts`. Frontend agents own `apps/web` and `packages/ui-web`. Only B1 edits contracts in wave 1; later contract changes go through a backend agent.
- Every package ends with: `pnpm test`, `pnpm check`, `pnpm lint` green, a short report (what was reused, what was ported with source paths, what was new and why), and no secrets or `.env` changes.
- Merge order follows the waves. After each wave, run `pnpm db:migrate` and `pnpm dev` once to catch integration breaks early.

## End-to-end check (definition of done)

On a fresh account:
1. Onboarding asks your name, the Muse's name and face (sky by default) and model, then opens the Conversation, where the Muse asks for a first Goal.
2. "I want conversational Japanese before my Kyoto trip in December" → the Muse drafts a plan; it appears as a Proposal in the Conversation, in Waiting on you, and on top of the Feed. Accepting it in any one place clears all three.
3. The avatar hops with a count while the Proposal is open, sways while the Muse works, rests when idle.
4. With proactivity `high`, the Goal is worked on within 20 minutes in its Goal log; the Conversation gets a short report; a Post appears in the Feed. Nothing runs during quiet hours.
5. A Task that needs you becomes a blocked-Task Ask with a push notification; answering it wakes the Goal immediately.
6. Two Goals never run at the same time, and a message you send while a Goal runs is handled first.
7. "Follow AI agent news" adds a Followed topic; the next daily run writes a Post with a source link.
8. Ideas shows six suggestions; tapping one sends it.
9. Library shows files made in both the Conversation and Goal logs.
10. There is no way to create a second bot in the UI, and the Muse has no bot-creation tools.
