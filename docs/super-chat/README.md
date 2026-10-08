# How Nova's conversation works: Super Chat, Side Chats, Helpers

Nova's conversation backend is **Omnigent** (vendored at `engine/omnigent`)
in the mode `omnigent.context.mode=superside-chat`. The model loop runs on the
**Claude SDK** harness by default, or on **Pi** (the engine's
`OMNIGENT_SUPERCHAT_DEFAULT_AGENT=nova-pi`, which
also runs non-Claude models through OpenRouter; see
[../pi_futur_work.md](../pi_futur_work.md)). Nova's own app (`apps/web`) is the
face; `apps/api` signs people in and passes calls through. Everything a
conversation *is* (messages, side chats, helpers, activity, memory) lives in
Omnigent.

The engine's full contract is
[`engine/omnigent/rollover/SUPERSIDE-CHAT.md`](../../engine/omnigent/rollover/SUPERSIDE-CHAT.md);
its glossary is
[`engine/omnigent/rollover/CONTEXT.md`](../../engine/omnigent/rollover/CONTEXT.md).
This page explains it in Nova's terms. How each screen is wired:
[WIRING.md](WIRING.md). Where a Muse's turns actually run, and how runners
get their keys: [RUNNERS.md](RUNNERS.md). What of the engine we carry but
may drop: [ENGINE-TRIM.md](ENGINE-TRIM.md).

## Words: Nova ↔ engine

| Nova (UI, `CONTEXT.md`) | Engine (Omnigent) | What it is |
|---|---|---|
| Muse | the Super Chat's assistant | The one assistant a person has |
| Conversation | **Super Chat** | The person's one long-running chat; one per person |
| Side chat | **Side Chat** | A short aside opened from the Conversation |
| Helper | **Sub-agent** | Background worker the Muse sends off for one task |
| Helper status | Sub-agent **Activity** status | In progress, Done, Failed, Cancelled |
| Activity panel | **Activity Feed** | Everything the Muse did, newest first, by day |

Nova's "Task" stays what `CONTEXT.md` says (an item in a Goal's plan). It is
not a Helper.

## The Conversation (Super Chat)

- **One per person in a space.** The engine finds or creates it
  (`GET /v1/me/muse`, ADR 0009) the first time the person writes, as an
  Omnigent session labelled `omnigent.context.mode=superside-chat`, on its
  `OMNIGENT_SUPERCHAT_DEFAULT_AGENT` bundle: `nova-claude`
  (`harness: claude-sdk`), or `nova-pi`. A Conversation Nova created before
  that is adopted once, so it is kept. Both bundles are rendered from
  `infra/omnigent/templates/` by `node infra/omnigent/render-agents.mjs`.
- **It never fills up.** When it gets long, or when the person comes back
  after a quiet period (12 hours), Omnigent writes a summary of the older
  part and keeps the recent turns word for word. This is a **Rollover**. The
  full history is still there: the Muse can look things up with its
  `session_history` tool, and the person sees every message.
- **It remembers the person.** Lasting facts (preferences, role, decisions)
  are saved to Memory, either right away when the person states them or by a
  background job (**Upkeep**) that reads recent chats every hour and after
  each Rollover. A short **Memory Profile** is given to the Muse on every
  turn, and to every Helper when it starts.
- **The Muse can speak first.** When a Helper the person asked for finishes,
  its result arrives in the Conversation without the person writing
  anything.

## Side chats

A side chat is a separate, full-size chat for one focused topic, so the
Conversation stays clean.

```
Conversation (Super Chat) ──open──▶ Side chat "Q4 checklist"   (knows our conversation)
                          ──open──▶ Side chat "lunch ideas"    (blank)
```

- **Two ways to start**, chosen once, on the first message:
  - **Knows our conversation** (on): starts from a summary of the
    Conversation plus its most recent turns. The summary is shown in the
    side chat's header ("Started with context").
  - **Off (blank)**: starts with only the Memory Profile ("Started blank").
- **Opened by the person** from "+ New side chat" in the sidebar, or **by
  the Muse** when the person asks ("open a side chat for this"). Either way it
  just appears in the sidebar.
- **One level only.** A side chat can't open another side chat. (A side chat
  can send off Helpers.)
- **Nothing is sent back.** A side chat never reports to the Conversation.
  When the person asks about it, the Muse reads it (shows as an Activity).
- **Archived, never deleted.** After a month without messages a side chat is
  archived: it leaves the main list (an Archived fold shows it) but stays
  readable, by the person and by the Muse. In Nova it opens read-only. (The
  engine also brings an archived chat back if a message is written to it.)

## Helpers and their status

A Helper is a background worker the Muse sends off for one task (research,
a written file, a multi-step check) while the conversation goes on. The Muse
starts one with `start_helper`; a per-turn step limit pushes long work to
Helpers (ADR 0007).

```
 Muse ──launch (type + brief)──▶ Helper ── works ──▶ Result ──▶ back to the chat that launched it
   ▲                                  │
   └──────── status: In progress ─────┘   Done │ Failed │ Cancelled
```

- **Launched by type**: `worker` (the general Helper; may coordinate one level
  of further workers), `goal` and `teacher`, each defined in the agent bundle
  with its own limits. The Muse picks only `fast` or `strong` for the model
  (mapped in engine config); see `docs/adr/0007`.
- **Starts fresh**: only the **Brief** the Muse writes plus the Memory
  Profile, never a copy of the conversation.
- **Status** (from the Activity Feed):

  | Status | Meaning | Shown |
  |---|---|---|
  | In progress | Still working | Live line with its latest step |
  | Done | Finished; its Result was delivered | Outcome line |
  | Failed | Stopped with an error | Reason |
  | Cancelled | Stopped on the person's request | — |

- **Result**: the Helper's final message, delivered to the chat that launched
  it (the Conversation, or a side chat). If that side chat was archived in
  the meantime, it goes to the Conversation instead. When the person asked
  for the work, the Muse tells them right away.
- **Visible, read-only.** The person can open any Helper and read every step,
  but can't write to it. Only the chat that launched it can stop it, and only
  when the person asks.
- **Nesting**: a Helper may coordinate one more level of Helpers; no deeper.

## The Activity panel

Every piece of multi-step work is one **Activity**: a chat turn that used
tools, or a Helper's whole task. Each has a title (what was asked), a
one-line outcome, a status, a time, and **Steps** in plain words ("Searched
memory for 'Q4'", "Launched a helper to check totals"). The panel lists them
newest first, grouped by day; opening one shows its Steps.

A Step never shows the tool's raw name — only an icon, a plain-language
title, and (when there's something worth showing) a short snippet of the
result, never the full call/result trace. All three come from one registry,
`TOOL_PRESENTATION` in `packages/core/src/tool-presentation.ts`.

**How to register a tool**: when a tool is added to Nova's agent bundle
(`infra/omnigent/agents/nova-claude/`) or the engine's always-on
superside-chat tools (`ALWAYS_ON_SUPERSIDE_CHAT_TOOLS`, same file), add an
entry to `TOOL_PRESENTATION` with an icon (`ToolIconKey`), a `title(args)`
derived only from the call's arguments, and a `snippet(output)` — or
`tool-presentation.completeness.test.ts` fails the build. Map any new
`ToolIconKey` to a lucide icon in `apps/web/src/pages/muse/chrome/toolIcons.ts`.

## Settings

| What | Where | Production | For testing |
|---|---|---|---|
| Refresh after quiet period | `OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS` (host) | 43200 (12 h) | 60 |
| Archive side chats after | `OMNIGENT_SIDE_CHAT_ARCHIVE_AFTER_SECONDS` (server) | 2592000 (30 days) | 60-3600 |
| Daily Study per Conversation, plus quiet-moment daily notes | `OMNIGENT_PROACTIVE_PROVISION=1` (server) | on | — |
| Helpers at once | `OMNIGENT_SUBAGENT_MAX_CONCURRENT` (host) + each type's `max_sessions` | 10 | — |
| Upkeep model | server `--config` `llm:` block | required for Upkeep | — |
| Memory search | `OMNIGENT_MEMORY_EMBEDDINGS_MODEL` + its key (server) | `openai/text-embedding-3-small` | — |
| Web search | `TAVILY_API_KEY` on the host, plus `OMNIGENT_RUNNER_ENV_PASSTHROUGH=TAVILY_API_KEY` so it reaches runners | required for `web_search` | — |

Nova's own side of the gateway (`packages/adapters/src/omnigent/env.ts`'s
`omnigentSuperChatConfigFromEnv`):

| What | Where | Default |
|---|---|---|
| Turn timeout | `OMNIGENT_TURN_TIMEOUT_MS` | 300000 (5 min) |
| Run lease duration | `OMNIGENT_LEASE_DURATION_MS` | 300000 (5 min) |
| `chats.messages` page size | `OMNIGENT_CHATS_PAGE_SIZE` | 50 |

## What this replaced

Nova's own engine package (`omnigent/nova`: notes memory, feed, episodes,
goals, asks, skills, and the per-turn context provider) is no longer in the
engine. Memory, recall and activity come from Omnigent's own layer above.
Nova features that relied on the `nova_*` tools (Feed posts, Goal planning by
the Muse, Asks, Skills) need to be rebuilt on this layer; see WIRING.md.
