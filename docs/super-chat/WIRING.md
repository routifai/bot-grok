# Wiring Nova to Omnigent superside-chat

How each Nova screen reaches the engine. Concepts: [README.md](README.md).
Ground rule (engine ADR 0001): **Omnigent owns every capability**. Nova's API
only checks who is asking and passes calls through; it never re-implements
side chats, memory or activity.

```
apps/web ──oRPC──▶ apps/api (auth, ownership) ──HTTP──▶ Omnigent server ──▶ runner ──▶ Claude SDK
                     packages/adapters/src/omnigent/*
```

Code lives in feature files: oRPC routers in `apps/api/src/routers/` (for example
`side-chats.ts`, `computer.ts`, `memory.ts`, `goals.ts`, `feed.ts`), their contracts in
`packages/contracts/src/rpc/` (`chats.ts`, `computer.ts`, ...), and engine relays in
`apps/api/src/engine-*.ts` and `apps/api/src/chats.ts` / `activities.ts`.

## Identity and ownership

- Nova calls Omnigent as the person (`X-Forwarded-Email` + proxy secret, matching the
  engine's `OMNIGENT_AUTH_HEADER_SECRET`).
- One **Super Chat** per person and space, decided by the engine
  (`GET /v1/me/muse`, ADR 0009): Nova's `OmnigentSession` row
  (`botId → omnigentSessionId`) only mirrors what the engine answers, and is
  refreshed from it on each turn. A Conversation Nova started before that is
  claimed once with `POST /v1/me/muse/adopt`.
- Any other session id the app receives (`chatId`) must be a Side Chat of
  that Super Chat (`related_chats`) or a Helper below it (its
  `parent_session_id` chain reaches the Super Chat). Anything else is
  `NOT_FOUND`.

## Screens → calls → engine

| Screen | oRPC | Omnigent |
|---|---|---|
| Conversation: send | existing run path (`runTurnOnOmnigent`) | `POST /v1/sessions/{super}/events` + `/stream` |
| Conversation: read, incl. Muse speaks first (Helper Results) | `chats.transcript({botId})`, refetched on `chats.watch` | `GET /v1/sessions/{super}/transcript` + `GET /v1/sessions/{super}/family/stream` |
| Sidebar Chat List | `chats.list({botId})` | `GET /v1/sessions/{super}/related_chats` |
| "+ New side chat" first send | `chats.createSide({botId, start, text})` | `POST /v1/sessions/{super}/side_chats` |
| "Knows our conversation" hover | `chats.summaryPreview({botId})` | `GET /v1/sessions/{super}/context_summary` |
| Side chat / Helper messages | `chats.transcript({botId, chatId})` | `GET /v1/sessions/{chatId}/transcript` |
| Side chat send | `chats.send({chatId, text})` | `POST /v1/sessions/{chatId}/events` |
| Chat viewed (clears its unread dot) | `chats.markRead({botId, chatId?})` | `POST /v1/sessions/{chatId}/read` `{item_id?}`; emits `chats.changed` |
| Clear conversation | `chats.reset({botId})` | `POST /v1/sessions/{super}/reset` |
| Show earlier messages | `chats.transcript({botId, beforeReset: true})` | `GET /v1/sessions/{super}/transcript?before_reset=true` |
| Search | `search.query` (hits carry `chatId` for a side chat) | `GET /v1/sessions/{super}/items/search?query=…&scope=family` |
| Activity panel | `activities.list({botId, before?, limit?})` | `GET /v1/sessions/{super}/activities` |
| Memory tab | `memory.profile({botId})` | `GET /v1/sessions/{super}/memory/profile` |
| Activity / Helper detail | `activities.get({botId, activityId})` | `GET /v1/sessions/{super}/activities/{id}` |
| Computer screen | `computer.screenUrl({botId})` | `POST /v1/sessions/{super}/computer/screen` `{interactive:false}`; stream relayed by the same-origin screen proxy |
| Take over | `computer.takeover({botId})` | `POST /v1/sessions/{super}/computer/screen` `{interactive:true}` |
| Hand back | `computer.release({botId})` | `POST /v1/sessions/{super}/computer/release` |
| Computer status | thread snapshot `computer` | `GET /v1/sessions/{super}/computer` |

`ChatSummary` (contracts `muse.ts`) maps from `related_chats`:
`id`, `title`, `start` (`with_context` → `withContext`), `summary` (the seed
summary of a with-context chat, else `null`), `archived`, `live` (a turn is
running), `unread`, `updatedAt`.

### Engine route shapes Nova relies on (ADR 0009)

- **Unread.** `related_chats` rows add `unread: bool` and `last_read_at`. `POST /v1/sessions/{id}/read`
  `{item_id?}` marks a chat read (baseline never moves back) and emits `chats.changed`. The sidebar
  dot is `ChatSummary.unread`; a chat in view is marked read on opening, on each `message.done`
  while visible and focused, and when the window regains focus. The root Conversation is not in
  `related_chats` and the session GET only carries `viewer_last_seen` / `viewer_unread` (the
  explicit flag), so its unread stays Nova's (`threads.markUnread` on a reply while the window
  is not focused).
- **Family search.** `GET /v1/sessions/{id}/items/search?query=…&scope=family` →
  `{data:[{session_id, message_id, role, created_at, text, item}]}` for the Conversation and its side
  chats. A hit whose `session_id` is not the root becomes `SearchHit.chatId`; the web deep link is
  `?chat=<chatId>&m=<messageId>`.
- **Reset.** `POST /v1/sessions/{id}/reset` (owner, Super Chat only, 409 `conflict` while a turn runs)
  → `{session_id, reset_item_id, created_at}`. Family event `chat.reset {chat_id, item_id}` →
  `FamilyEvent.chatReset`; clients refetch. The transcript response has `reset: {item_id, created_at}|null`,
  stops (`has_more: false`) at the reset, and `?before_reset=true` pages the older history
  (`ThreadMessagePage.reset`, `chats.transcript({beforeReset})`). The 409 reaches the client as
  `CONFLICT` ("Wait for Nova to finish, then clear.").
- **Live.** The transcript response has `live: bool` → `ThreadMessagePage.running`; the session GET
  is no longer read for it.
- **Side chat creation.** `POST /v1/sessions/{id}/side_chats` retries the first message itself and
  answers `first_message_error` + `first_message_error_code` when it still fails. Nova does not
  retry; `ChatSummary.firstMessageErrorCode` opens the chat in the "Didn't send" state, to resend there.
- **Redaction.** The engine redacts engine-known secrets (secret-named env vars, vault values) on
  transcript, items, search, related chats, activities, feed and asks, so Nova passes those through.
  Nova still redacts what the engine does not: the Goal log (`redactThreadMessages`), the memory
  profile, claims and daily notes (`redactMemoryProfile`), and engine error bodies in thrown errors.

The single switch is "Omnigent connection configured": `OMNIGENT_URL` +
`OMNIGENT_PROXY_SECRET` set on api and worker. Computer ownership:
[RUNNERS.md](RUNNERS.md).

## Slices

### E1 · Engine (`engine/omnigent`)

| Change | Why |
|---|---|
| `POST /v1/sessions/{id}/side_chats` `{start, title?, first_message?}`: the refusal rules, fork or blank create, host binding, first message; `side_chat_open` calls this route too | One implementation for the tool and the app |
| Stamp `omnigent.side_chat.start` (`with_context`/`blank`) on creation | `ChatSummary.start` |
| `related_chats` entries add `start`, `summary` (seed summary or `null`), `live` | `ChatSummary` without extra calls |
| `GET /v1/sessions/{id}/context_summary` → `{summary, created_at}` or `{summary: null}` | "Knows our conversation" hover |

### A1 · App backend (`packages/*`, `apps/api`, `apps/worker`, `infra/omnigent`)

| Change | Why |
|---|---|
| Agent bundle `nova-claude` = Super Chat bundle (claude-sdk, Nova prompt, one general Helper type `worker` with `fast`/`strong` models, ADR 0007); `nova-pi` is a second bundle from the same templates, chosen by the engine's `OMNIGENT_SUPERCHAT_DEFAULT_AGENT=nova-pi`, with the Muse and every Helper type on Pi; drop `nova-openai`, `nova-codex` and every `nova_*` tool | Claude SDK by default; the `nova_*` tools are gone from the engine |
| Gateway creates the Super Chat with the mode label; replaces a session without it | Turns the capability on |
| Remove the context-provider route (`/internal/omnigent/context`) and `context-provider.ts` | The engine no longer calls it; memory comes from Omnigent |
| Implement `chats.*` and add `activities.list` / `activities.get` (contracts + router + adapter client) with the ownership rule above | Side chats, Helper status, Activity panel |
| Read the Conversation from the transcript and refetch on the family stream (ADR 0009); no mirror job | "Muse speaks first" shows in the Conversation |
| Remove the engine picker and `engine.*` routes | One engine |

### U1 · Web (`apps/web`)

| Change | Why |
|---|---|
| Chat List and side chats live on the real `chats.*` (no code change beyond removing dev-only fallbacks) | Already built against the contract |
| Side chat header: "Started with context" (expands to `summary`) or "Started blank" | Agreed design |
| Activity panel (right side): one line per Activity (status, title, live step or outcome), grouped by day; opening one shows its Steps; a Helper opens read-only with its messages | Activity Feed + Helper status |

## Acceptance (live, Claude Haiku)

1. First message creates a Super Chat with the mode label; reply appears.
2. "+ New side chat" with the switch on answers from the Conversation; off does not.
3. Ask the Muse to "research X in the background" (a `worker` Helper): the Activity panel shows
   it In progress, then Done; the Result appears in the Conversation without
   a new message from the person.
4. Open the Helper from the panel: messages are visible, no composer.
5. Archived side chat shows under the Archived fold and opens read-only.
