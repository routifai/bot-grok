# Goals

What Nova is working toward for the person. Ported from Nova's TypeScript
implementation (`packages/adapters/src/muse/goal-tools.ts`,
`goal-proposals.ts`, `goals-context.ts`, `apps/api/src/goals.ts`,
`packages/core/src/muse/proactivity.ts`).

## The shape

A **Goal** is an outcome the person wants over time: a title, description,
optional due date, a check-in schedule (cron strings evaluated in the Goal's
own timezone), a **plan** of ordered **Tasks**, and at most one open
**Proposal** — a plan the person must accept before it takes effect.

A brand-new Goal has no live Tasks: its first plan is a Proposal too, exactly
like a later revision. Accepting a Proposal replaces the Goal's plan; a step
whose `keep_task_id` names an existing Task carries that Task's id, status and
note over (only its position may change) instead of starting it over as a
fresh `pending` Task.

A Task's status is `pending | in_progress | done | blocked | skipped`, with an
optional free-text note. Marking a Task `blocked` with a note is the signal
(`update_task`'s `became_blocked` return) that the person should be asked what
it needs — asking them is a job for the `asks` primitive, not this one.

A Goal's status is `active | paused | cancelled | done`.

## Public API (`__init__.py`)

Entities: `Goal`, `GoalTask`, `GoalProposal`, `ProposedTask`, `TaskStatus`,
`GoalStatus`, `ProposalStatus`.

Service functions (`service.py`) — the only way to mutate a Goal; they
validate input and enforce the "at most one open Proposal" / "plan replaced
wholesale" rules before calling the store:

- `create_goal` — a new Goal plus its first-plan Proposal.
- `propose_plan` — a revised plan; withdraws any Proposal already open.
- `accept_proposal` / `dismiss_proposal` — decide the open Proposal.
- `update_task` — progress only, never the plan's shape.
- `set_status` — lifecycle status and/or check-in schedule.
- `render_goals(goals, max_bytes, focus_goal_id=None)` — the `<goals_active>`
  text block; pure and unit-testable without a store.
- `next_work_at(goal, now, quiet_hours, timezone)` — pure; see "Scheduling"
  below.
- `goal_to_dict` — the wire shape shared by `routes.py` and `tools.py`.

## A Goal's own session

A Goal may have its own Omnigent session for background work on it (its
"Goal log"). `Goal.session_id` is nullable — set once that session exists.
That session is labelled:

- `nova.goal=<goal_id>` — read by `context.py` to switch into single-goal
  mode: render only that Goal, in full, instead of every active Goal.
- `nova.scope=private` — it works on the person's own data (see
  `omnigent.nova._shared.Scope`).

**Creating that session is not this primitive's job** — it belongs to
whatever schedules Goal work (see "Scheduling"). `service.py` only defines
`GOAL_SESSION_LABEL_KEY` and the convention above.

## Scheduling

Not implemented here. `service.next_work_at(goal, now, quiet_hours, timezone)`
is the pure decision a future scheduler needs: `None` if `goal` isn't
`active`; otherwise `now`, pushed to the end of the quiet-hours window
(`"HH:MM-HH:MM"`, may wrap midnight) if `now` falls inside one. DST-safe via
`zoneinfo` — see `tests/nova/goals/test_service.py` for an America/Toronto
transition case. Firing a check-in or a Goal-work turn, and picking
`quiet_hours` from wherever the person's proactivity settings end up living,
are both scheduler concerns.

## Tables

`nova_goals`, `nova_goal_tasks`, `nova_goal_proposals` (see `tables.py`).
Every primary key leads with `workspace_id`; there are no database foreign
keys (`goal_id` relates to `nova_goals.id` by convention only). Status enums
are stored as small integer codes private to this primitive (`tables.py`),
not added to the shared `omnigent/db/enum_codecs.py` table.

## Routes (`/v1/nova/goals`, owner-only)

`GET /goals`, `GET /goals/{goal_id}`, `PATCH /goals/{goal_id}` (status —
`active|paused|cancelled`, not `done`; check-ins), `POST
/goals/proposals/{proposal_id}/accept`, `POST
/goals/proposals/{proposal_id}/dismiss`. Creating a Goal and proposing a plan
happen through the `nova_goals` tool, not a route — only the person decides
whether to accept a plan.

## Tool (`nova_goals`)

One built-in tool, private-scope only, with `action`: `create | propose |
update_task`. A tool call carries no `NovaActor` — `tools.py` resolves the
acting person from `ToolContext.conversation_id` via the global
`ConversationStore` (`omnigent.runtime.get_conversation_store()`): the
conversation's labels must say `Scope.PRIVATE`, and
`get_session_owner(..., owner_only=True)` gives the owner. See `tools.py`'s
module docstring for why (and how) it also builds its own store instead of
taking a `NovaDeps`.

## Context (`goals_active`, priority 30, 8 KB)

Private-scope only. Lists the person's Goals; inside a Goal's own session
(`nova.goal` label present), renders only that Goal, in full.
