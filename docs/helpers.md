# Helpers

How the assistant delegates work, how scheduled work runs, and what the activity panel shows, as
of 2026-10-17. The decisions are [ADR 0007](adr/0007-the-muse-delegates-multi-step-work.md) (the
assistant delegates multi-step work), [ADR 0005](adr/0005-proactive-work-is-scheduled-helper-runs.md)
(proactive work is scheduled helper runs) and
[ADR 0022](adr/0022-the-orchestrator-narrates-while-helpers-work.md) (the assistant narrates while
helpers work). Where the code lives is the "Helpers" row of
[`engine/README.md`](../engine/README.md).

## Helpers

A helper is a child session the assistant starts for one bounded job while the conversation goes
on. It runs in the same host as its parent and starts in the parent's working directory. The person
can open it from the activity panel and read every step, but cannot write in it.

The assistant starts one with `start_helper` (`superchat/helpers/tools.py`):

| Argument | Meaning |
|---|---|
| `task` | the whole brief; the helper does not see the conversation |
| `title` | 3 to 6 words the person would say |
| `model` | `fast` (the person's Light model) or `strong` (Default, the default) |
| `reasoning` | `low`, `medium` or `high`, or omitted |
| `files` | uploaded file ids |
| `project`, `path` | start in another Project's or file's folder |

The same task from the same chat within 10 seconds is treated as one hand-off. Several calls in one
step run helpers in parallel. The helper's first message is the memory profile followed by the
brief; it can read memory and `session_history` but not write memory.

`message_helper` passes a correction or detail to a helper that is already working; it reads it at
its next step. If the helper finished by then, the message is refused rather than starting a second
task.

Limits:

- **Nesting.** Conversation, then helper, then one level of parts: a `worker` may start
  `subworker`s, which start nothing (`refuse_subagent_nesting` in `superchat/subagents.py`).
- **Concurrency.** 10 live helpers per conversation tree (`OMNIGENT_SUBAGENT_MAX_CONCURRENT`), plus
  each type's `max_sessions`. The count is read from the engine's child-session rows.
- **Step limit.** A conversation turn may make 3 work tool calls (search and fetch, browser, shell
  and files, artifact writes); the next is refused with an instruction to hand the rest to a
  helper (`superchat/step_limit/policy.py`). Memory, cards, scheduling, vault and helper management
  never count. The person saying "do it here" lifts it for that turn. A turn that is refused
  must start the helper in the same turn; one that ends without it is a stall
  ([ADR 0025](adr/0025-act-by-default-tasks-have-state.md)).
- **Approvals.** Sending, posting, deleting, spending, uploading and sharing in the person's name
  ask first, for helpers too (`superchat/approvals/`). A helper's ask is shown where the
  conversation's asks show (`GET /v1/me/asks`) and waits up to 7 days; after 120 seconds the parent
  is told the helper is blocked on the person.

## Helper types

Each bundle declares its types in `engine/agents/templates/agents/<type>/config.yaml`; every type
runs on the bundle's harness. No type pins a model.

| Type | Started by | `max_sessions` | Tools |
|---|---|---|---|
| `worker` | `start_helper` from the assistant | 5 | the work toolset: `sys_os_*`, `artifact_save`, `artifact_list`, `deck_*` authoring, `files_*`, the live-update tools, `memory_search`, `memory_get`, `session_history`, `vault_fill`, plus `start_helper` for parts |
| `subworker` | `start_helper` from a `worker` | 5 | the worker set without `start_helper` |
| `notes` | the engine only, for the daily-note passes | 2 | `daily_note_get`, `daily_note_update`, `memory_*` (read, remember, forget), `session_history` |
| `editor` | the engine only, one per file, when its studio is first used (`POST /v1/artifacts/{id}/chat`, [ADR 0024](adr/0024-the-artifact-studio.md)) | none (outside helper caps and the step limit) | `artifact_save` (with `base_version`), `artifact_list`, `deck_check`, `deck_export`, `files_*`, `sys_os_*`, `session_history`, `memory_search`, `memory_get`, `memory_remember`; never wakes the conversation, never listed as its helper |

## Scheduled runs

Proactive work is a scheduled task bound to the conversation whose fire starts a helper under it
(`server/scheduled/helper_fire.py`): gated on the person's proactivity and quiet hours
(`GET`/`PUT /v1/me/proactivity`), deferred while another proactive run is in flight, retried once
after a failure, and launched on the parent's runner. Its result comes back by the same path as any
helper's, so the assistant decides whether it is worth telling the person. The assistant manages
these tasks with the `sys_scheduled_task_*` tools; a helper can only list them.

Two kinds run without a request from the person:

- **Live page updates** ([artifacts.md](artifacts.md#live-pages)), one task per live page.
- **Daily-note passes** ([context.md](context.md#daily-notes-and-the-working-list)): ad-hoc
  `notes` helpers whose results never wake the conversation.

`GET /v1/me/system-jobs` lists the background jobs the engine runs on its own.

## The wake path

When a helper's turn ends, the runner records its status (`completed`, `failed` or `cancelled`; a
helper with live parts of its own waits for them) and posts a **wake notice** to the chat that
started it: `POST /v1/sessions/{parent}/events` with `is_system_notice: true`, carrying the
helper's final message (up to 4,000 characters, then a pointer to its history) and the names of the
files it saved (`format_subagent_wake_notice_with_result` in `superchat/subagents.py`, posted by
`_deliver_subagent_wake_post` in `runner/app.py`). The post is retried on temporary failures and,
failing that, after the next reconnect or turn.

If the parent is idle, the notice starts a turn, so the assistant speaks without the person
writing. If a parent turn is running, the notice is steered into it or runs next. The transcript
hides the notice and shows the helper as a `helper` block (`session_id`, `title`, `status`).

Two more notice kinds, `progress` (one line per completed helper step) and `flag` (a decision or
surprise the person should hear now), come from ADR 0022; a progress notice wakes an idle parent
at most once every 30 seconds, a flag always. Their contract is in
[conversation.md](conversation.md#the-assistant-narrates-while-helpers-work).

## The activity panel

An activity is one piece of multi-step work, derived on read from sessions and items and never
stored (`superchat/activity/derive.py`). It is either a conversation turn that did real work (at
least 3 steps, a work tool, or more than 60 seconds) or a whole helper task. Each has a title, a
one-line outcome, a status (`in_progress`, `done`, `failed`, `cancelled`), a source (`turn`,
`background`, `scheduled`, `housekeeping`) and plain-language steps. Titles are tidied from the
request or written by the model in the background, at most 8 per read. Daily-note passes fold into
one housekeeping row per local day.

Routes: `GET /v1/sessions/{id}/activities` (`limit` up to 100, `before`, `tz` for day grouping),
`GET /v1/sessions/{id}/activities/{activity_id}`, and `GET /v1/sessions/{id}/activities/stream`;
the family stream also sends `activities.changed`.

### How to register a tool

A step never shows a tool's raw name, only an icon, a plain title and an optional snippet, all from
`TOOL_PRESENTATION` in `web/packages/core/src/tool-presentation.ts`. When a tool is added to the
bundle's allow list, add an entry there with an icon key, a `title(args)` built only from the call's
arguments and a `snippet(output)`, or `tool-presentation.completeness.test.ts` fails. Map a new icon
key in `web/app/src/components/chrome/toolIcons.ts`.
