# Objectives

An objective is an outcome a person hands to an agent to pursue over time, owned by one
parent session (the Conversation). It has a plan of tasks, an optional due date and, when
created with a cadence, a parent-bound scheduled task that advances it as a Helper run (see
[Helper-bound tasks](AUTOMATIONS.md#helper-bound-tasks)).

**Plan and proposals.** A task is `pending`, `in_progress`, `done`, `blocked` or `skipped`;
tasks are updated in place. The shape of the plan (add, remove, reorder) changes only by
accepting a proposal: a full ordered list whose items may keep an existing task id. At most one
proposal is open per objective; a new one dismisses the previous. Accepting applies the list
atomically: kept tasks keep id, status and note; new items start `pending`; absent tasks are
removed. A first plan is a proposal too.

**Statuses.** `active`, `paused`, `done`, `archived`. Moving away from `active` pauses the
cadence task; a fire for an objective that is not `active` records a `skipped` run with
`error_code: objective_inactive`. Gating (proactivity, quiet hours, one run at a time) and the
failed-fire retry are the normal parent-bound ones.

## REST (owner-scoped; another user's objective is a 404)

| Method | Path | Body / notes |
| --- | --- | --- |
| `POST` | `/v1/objectives` | `{parent_session_id, title, description?, due?, plan?: [{title}], reason?, rrule?, timezone?}`. With `rrule`, also creates the `goal` scheduled task. |
| `GET` | `/v1/objectives` | `?parent_session_id=` -> `{"objectives": [...]}` |
| `GET` | `/v1/objectives/{id}` | one objective |
| `PATCH` | `/v1/objectives/{id}` | `{title?, description?, status?, due?}` |
| `PATCH` | `/v1/objectives/{id}/tasks/{task_id}` | `{status?, note?}` |
| `POST` | `/v1/objectives/{id}/proposals` | `{reason, plan: [{id?, title}]}` (creates or replaces the open one) |
| `POST` | `/v1/objectives/{id}/proposals/{pid}/accept` / `dismiss` | returns the objective; 409 if not open |
| `GET` | `/v1/objectives/{id}/log` | `?limit=` -> `{"log": [{run_id, status, scheduled_at, fired_at, finished_at, error_code, attempt, conversation_id, result}]}` newest first |

An objective is `{id, parent_session_id, title, description, status, due, scheduled_task_id,
created_at, updated_at, plan: [{id, title, status, note}], open_proposal: {id, reason, plan:
[{id|null, title}], status, created_at} | null}`.

## Agent tools

In superside-chat sessions: `objective_create` (title, description, plan, cadence RRULE, due),
`objective_get`, `objective_list`, `objective_update_task`, `objective_propose`. A Helper gets
only get, update_task and propose, and only for objectives of its own parent session. Accepting
a proposal is the person's action (the route), not a tool. The `goal` Sub-agent Type lives in
the product bundle (`infra/omnigent/templates/agents/goal`).
