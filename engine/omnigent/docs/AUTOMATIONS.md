# Automations (scheduled tasks)

An automation is a saved instruction that fires an agent session on a recurring schedule. Each firing creates a real session, bound to an agent, that runs a stored prompt -- so "triage new issues every weekday at 9" or "summarize yesterday's alerts each morning" runs without anyone at the keyboard.

"Automations" is the user-facing name in the web UI. Everywhere else the feature is called a **scheduled task**: the REST paths (`/v1/scheduled-tasks`), the agent tools (`sys_scheduled_task_*`), the database tables (`scheduled_tasks`, `scheduled_task_runs`), and the code. This guide uses whichever name matches the surface being described.

## Creating an automation

There are three surfaces, all writing the same rows.

**Web UI.** Open the `/tasks` page (sidebar: *Automations*, or the command palette: *Go to Automations*). The create dialog takes the schedule, the agent, the prompt, and optionally a model and reasoning effort. When the server supports managed sandboxes, the host picker also offers a new sandbox for each run. Each row shows the schedule and, when armed, a live relative next-run time. The API exposes the last run's status as `last_run_status`; the row does not display it.

**REST API.** `POST /v1/scheduled-tasks`. Required: `name`, `prompt`, `rrule`, and `agent_id` (optional when `parent_session_id` is set; see [Helper-bound tasks](#helper-bound-tasks)). Optional: `timezone` (defaults to `UTC`), `model_override`, `reasoning_effort`, `permission_mode`, `max_cost_usd`, `workspace`, `host_id`, `execution_target` (defaults to `connected_host`). Unknown fields are rejected. For `connected_host`, the two optional targeting fields are not independent: sending a `workspace` without a `host_id` is a 400 (`host_id required when workspace is set`), because only a host can resolve a path. Sending neither is fine -- the fire resolves both. Existing managed sandbox hosts cannot be pinned or automatically selected for connected-host runs.

To provision a fresh sandbox per firing, set `execution_target: "managed_sandbox"` and omit `host_id` and `workspace`. This requires managed sandboxes to be configured on the server; otherwise creation is rejected. Each sandbox uses the server's normal runner-idle and provider keepalive settings.

```jsonc
{
  "name": "nightly triage",
  "prompt": "Triage issues opened since yesterday and post a summary.",
  "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  "agent_id": "ag_...",
  "timezone": "Asia/Tokyo",
  "permission_mode": "acceptEdits",
  "max_cost_usd": 2.00
}
```

`permission_mode` is available only for Claude Code (`claude-native`) agents. It accepts `default`, `auto`, `acceptEdits`, `plan`, `dontAsk`, or `bypassPermissions`; omitting it uses the agent default. Automations are unattended, so prompting modes such as `default` and `plan` can leave a run waiting for approval. Choose an auto-running mode only when its permission level is appropriate for the task.

`max_cost_usd` is a positive per-firing budget. Each fired session gets its own cost-budget policy, which blocks subsequent requests and tool calls once recorded spend reaches the cap. It does not interrupt an in-progress model turn: spend can overshoot before the next check, and denying a native tool call does not terminate the turn. Omit the field to attach no automation-specific cap; other applicable policies still apply.

**Agent tools.** An agent can manage automations itself with `sys_scheduled_task_create`, `sys_scheduled_task_list`, `sys_scheduled_task_update`, and `sys_scheduled_task_delete` -- so an agent can schedule its own follow-up work. The create and update tools expose the same `permission_mode`, `max_cost_usd`, and `execution_target` controls.

## Schedules are RRULEs, not cron

A schedule is an [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545) recurrence rule evaluated in the task's IANA timezone.

| Intent | `rrule` |
| --- | --- |
| Every hour | `FREQ=HOURLY` |
| Daily at 09:00 local | `FREQ=DAILY;BYHOUR=9;BYMINUTE=0` |
| Weekdays at 09:00 local | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0` |

The rule is anchored at midnight of the local day, which gives occurrences a deterministic wall-clock phase: an hourly rule fires on the hour, a daily rule at its `BYHOUR`/`BYMINUTE`.

Beyond syntax checks, create and update reject these cases with a 400:

- **Sub-hour gaps in the validation sample.** The validator checks consecutive occurrences from a fixed UTC anchor, stopping when it reaches an occurrence at least 25 hours after the first or samples 2,000 occurrences. It rejects gaps below one hour within that sample. Irregular recurrence sets can contain shorter gaps later, so passing validation does not guarantee an hourly minimum for every future firing or a bound on cost.
- **Never fires.**
- **Fires only once.** A schedule that cannot recur is not a schedule.

Two timing caveats are worth knowing:

- **DST.** A wall-clock time that does not exist on a spring-forward day maps to whichever instant the timezone database resolves it to, and a time that occurs twice on a fall-back day picks the earlier one. Either way a schedule slips by at most an hour across a DST edge.
- **`INTERVAL>1` rules** (biweekly, interval-monthly) tie their phase to the day the timer last re-armed, because the anchor is midnight of the query day rather than a stored start date. A server restart on a different weekday can slip such a rule by one period. `INTERVAL=1` rules are unaffected.

`next_run_at` in an API response is computed by the live scheduler and is authoritative. Do not recompute it client-side; a client cannot reproduce the server's anchor for `INTERVAL>1` rules.

## What happens when a task fires

1. **The row is re-read.** The armed timer is never trusted. A task deleted or paused between arming and firing is a no-op.
2. **The launch target is resolved.** A `managed_sandbox` task checks that managed launches are available; its fresh sandbox is provisioned during launch. For `connected_host`, a task with no pinned `host_id` uses the owner's most-recently-active live host, chosen at fire time. A task with no pinned `workspace` starts the runner in that host's home directory, which is what makes chat-only, research, and MCP-only automations possible. A pinned host that is missing or offline -- or an owner with no live host at all -- records a **failed** run rather than a running one (`error_code` `host_offline`, `host_not_found`, or `no_online_host`).
3. **A session is created**, bound to the task's agent and carrying any `model_override`, `reasoning_effort`, and supported `permission_mode`. Connected-host sessions carry the resolved workspace and host; managed-sandbox sessions are bound to their new sandbox during launch. If `max_cost_usd` is set, a per-session cost-budget policy is attached before the prompt is dispatched.
4. **Ownership is granted.** The new session gets a `LEVEL_OWNER` grant for the task's owner (a reserved local user in single-user and OSS deployments). Without the grant the run would be invisible.
5. **The runner launches and the prompt is dispatched**, so the agent actually works. A seeded prompt with no launched runner would just sit in history.
6. **The run is recorded** in `scheduled_task_runs`, and `last_run_at` and `last_run_conversation_id` are stamped on the task.

Firing is fire-and-forget: the guard steps run synchronously so a dead fire costs nothing, then session creation and launch move to a background task and the scheduler re-arms immediately. A failure in that background work is logged and never crashes the scheduler.

## Run history

`GET /v1/scheduled-tasks/{id}/runs` returns history in descending `scheduled_at` order as `{"runs": [...], "next_cursor": ...}`. The `limit` query parameter defaults to 100 and accepts 1–1,000. Pass the returned `next_cursor` as `after` to fetch the next page; a null cursor marks the end. For example, request `/runs?limit=1`, then `/runs?limit=1&after=<next_cursor>`.

Each run carries `status`, `scheduled_at`, `fired_at`, `finished_at`, `conversation_id` (the session the fire created), `error_code`, and `attempt` (1, or 2 for the retry of a failed Helper-bound fire). The free-text `error` blob is deliberately not returned; `error_code` is the queryable classification.

| `status` | Meaning |
| --- | --- |
| `running` | Dispatched; the turn is in flight. |
| `succeeded` | The dispatched turn finished. |
| `failed` | The firing or the turn failed; see `error_code`. |
| `skipped` | The firing was deliberately not attempted -- for example an unsupported `execution_target`. |

`ScheduledTaskRun` also declares a `scheduled` status, but no code path writes it: a run row is created at dispatch, so `running` is the earliest state a client can observe.

## Lifecycle

A task is `active`, `paused`, or `deleted`. `PATCH /v1/scheduled-tasks/{id}` changes supported mutable fields and can move a task between `active` and `paused`; it cannot set `deleted` (use `DELETE`). Omitting a field normally leaves it unchanged. Moving a task to a different `agent_id` clears `model_override`, `reasoning_effort`, and `permission_mode` unless the same request resends them, because a harness switch invalidates the settings stored beside the agent -- so re-pin an automation's execution controls in the request that switches its agent, or it fires the new agent on defaults. `max_cost_usd` is not agent-bound and survives the switch. Sending `permission_mode: null` clears the permission override, and `max_cost_usd: null` clears the cost cap. An explicit `null` for `workspace` or `host_id` is rejected -- the rejection is on the presence of the key, so it applies even to a task where that field is currently unset; there is no direct null-based way to clear either one.

Switching to `execution_target: "managed_sandbox"` clears both stored pins. Omit the `host_id` and `workspace` keys entirely in that PATCH, even if their values would be null. Switching back to `connected_host` leaves both unset unless the request supplies new pins, so the next fire resolves the owner's live host and its home directory.

`POST /v1/scheduled-tasks/{id}/run` fires a task immediately and returns 202. It does not disturb the recurring schedule, which makes it the way to test a new automation without waiting for its next occurrence.

## Helper-bound tasks

A task can be bound to a parent session so its fires report back to it instead of producing free-standing sessions.

**Fields.** `parent_session_id` and `agent_type` (create and PATCH; both or neither). The parent must exist and be owned by the caller, and `agent_type` must be a sub-agent Type declared by the parent's agent. `agent_id` may be omitted on create: the parent's agent is used. `PATCH` with both set to `null` unbinds the task. The `sys_scheduled_task_create` / `_update` tools take the same two fields, and `parent_session_id: "self"` means the calling session (the runner substitutes its id). The `sys_scheduled_task_*` tools are not offered to sub-agent sessions and are refused if called from one.

**What a fire does.** It creates the session as a sub-agent child of the parent, like `sys_session_create`: `kind="sub_agent"`, the parent's agent and runner, `sub_agent_name` = `agent_type`, the parent's context-mode labels, a dispatch id label, and the label `omnigent.subagent.scheduled_task_id`. The prompt is dispatched to the parent's runner (no host resolution; a parent with no connected runner is a failed run). On the child's first turn the runner registers its Result for the parent wake, so when the Helper finishes its Result wakes the parent through the normal sub-agent path (a Result the parent never drained is also recovered after a runner restart). The run's `conversation_id` is the Helper session, titled `<agent_type>:<task name>` (Activity shows the task name). The task owner is granted ownership of the child, like a `sys_session_create` child, so owner-scoped routes such as `memory/profile` work. The server relay is subscribed before the prompt is dispatched, so the run flips to `succeeded`/`failed` when the Helper's turn ends.

**Gating.** Per owner, in `GET/PUT /v1/me/proactivity` (`{"proactivity": "off|low|normal", "quiet_start": "HH:MM", "quiet_end": "HH:MM", "timezone": "<IANA>"}`; defaults `normal`, no quiet hours, `UTC`). Applies only to Helper-bound tasks. A gated fire records a `skipped` run with an `error_code`:

- `proactivity: off` -> `proactivity_off`; nothing runs.
- Inside quiet hours (local window, may cross midnight) -> `quiet_hours_deferred`; one re-fire is armed for the end of the window.
- Another Helper-bound run of the same owner still `running` (or launching) -> `owner_busy_deferred`; re-fire in 5 minutes, up to 3 times, then `owner_busy` (skipped).
- `proactivity: low` behaves like `normal` except that a failed fire is not retried.

**Retry.** A failed launch (no connected parent runner, dispatch error, session create error) records a `failed` run and arms one retry 10 minutes later, recorded as a new run with `attempt` 2; a failure of the retry is not retried. A run force-failed by the stale-run backstop (6 hours `running`) is retried the same way. Failures that cannot succeed on retry (`parent_not_found`, `invalid_agent_type`) are not retried.

Deferred and retry re-fires are in-process timers: a server restart drops them (the recurring schedule is unaffected), and at most one is pending per task.

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/scheduled-tasks` | Create a task. |
| `GET` | `/v1/scheduled-tasks` | List tasks; `?parent_session_id=<id>` narrows to tasks bound to that session. |
| `GET` | `/v1/scheduled-tasks/{id}` | Read one task. |
| `PATCH` | `/v1/scheduled-tasks/{id}` | Update fields, or pause/resume. |
| `DELETE` | `/v1/scheduled-tasks/{id}` | Delete a task. |
| `POST` | `/v1/scheduled-tasks/{id}/run` | Run now (202). |
| `GET` | `/v1/scheduled-tasks/{id}/runs` | Run history. |
| `GET` / `PUT` | `/v1/me/proactivity` | The caller's proactivity level and quiet hours. |

A task response carries `id`, `name`, `prompt`, `rrule`, `owner_user_id`, `agent_id`, `timezone`, `created_at`, `model_override`, `reasoning_effort`, `permission_mode`, `max_cost_usd`, `workspace`, `host_id`, `execution_target`, `state`, `parent_session_id`, `agent_type`, `last_run_at`, `last_run_status`, `last_run_conversation_id`, `next_run_at`, and `updated_at`.

## Current limits

The scheduler is the timing engine only, and its behavior is deliberately simple:

- **Missed fires are not replayed.** On startup the scheduler arms the next future occurrence of every active task; occurrences that passed while the server was down are gone. There is no backfill or replay.
- **No automatic retry, except for Helper-bound tasks.** A failed run is recorded and visible in history; the retry policy is that the next occurrence fires normally. A Helper-bound task gets one extra retry (see below).
- **Overlapping fires are skipped.** If the previous firing of the same task is still being dispatched when the next tick arrives, the tick is dropped. No run row is recorded for it, so a dropped tick leaves no trace in history beyond the server log.
- **Late ticks are skipped.** A tick arriving more than 30 seconds after its scheduled time (a blocked event loop, for instance) is skipped rather than fired late.
- **One scheduler per server process.** Timers are in-process with no distributed leasing, so a multi-replica deployment would fire each task once per replica. Shared session-create orchestration is the intended path for that.
- **Execution targets.** Runs use either a connected host with an existing workspace or a fresh managed sandbox. Reusing an existing managed sandbox is not supported. Git branch selection at fire time is not available: `base_branch` is rejected as an unknown API field. A stored row with an unsupported `execution_target` records a `skipped` run with `error_code` `unsupported_target`.

## Related

- [Agent YAML spec](AGENT_YAML_SPEC.md) -- defining the agent an automation binds to.
- [Policies](POLICIES.md) -- gates and spend caps that apply to sessions an automation creates.
