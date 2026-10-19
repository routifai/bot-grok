# Glossary

One word per thing, as of 2026-10-18. The infrastructure words come from
[ADR 0018](adr/0018-one-vocabulary-engine-host-runner-harness.md); a pull request that introduces a
second word for one of these is sent back. Deprecated words are marked here with what replaced
them; where code still uses one, the entry says so.

- **Activity**: one piece of multi-step work in the activity panel, either a conversation turn that did real work or a whole helper task; derived on read, never stored ([helpers.md](helpers.md#the-activity-panel)); a projection of the record, its rows grouped by Round ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)).
- **Archived**: a session hidden from the default list (`PATCH /v1/sessions/{id}` with `archived: true`); nothing archives on its own.
- **Artifact**: a file the assistant saved with `artifact_save`; saving the same name again in the same conversation adds a version ([artifacts.md](artifacts.md)).
- **Ask**: anything the assistant is waiting on the person for (an approval, a question); open asks are listed by `GET /v1/me/asks`. Not the unit of work: that is a **Round**.
- **Assistant**: the one persistent agent a person has; it owns the conversation, the memory and the host. The canonical word in copy, docs and prompts ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)). Retired words, kept here only: Muse, "Super Chat" and Nova. Code identifiers still say Muse (`/v1/me/muse`, `superchat/muse.py`, `muse_*` names) and super chat until the naming PR of the ADR 0029 train; the stored label value `omnigent.context.mode=superside-chat`, carried by the Conversation and its helpers, stays an identifier.
- **Brief**: the task a helper starts from (`start_helper`'s `task`), with engine facts appended: the folder, the files in play and the preference lines that apply, never the whole profile ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)); the helper does not see the conversation.
- **Checklist**: the model's own list of steps, words only: the Claude harness's native task tools or the `checklist` tool on pi, folded to one `checklist.*` event. Never bound to a Helper; it drives no state, refusal or tick ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)).
- **Checkpoint**: the `compaction` item a rollover stores: a fixed header written by code, the working list, and the kept tail.
- **Chip**: the pointer on a message to the artifact, or part of one, the message is about ([conversation.md](conversation.md)).
- **Claim**: one sentence about the person in long-term memory, with its quote, evidence, kind and confidence (table `memory_claims`).
- **Computer**: old name for **host**, gone from code, config and copy since the rename wave (ADR 0018). The person's word for their host is "your machine"; the web tab is Files.
- **Context brief**: the engine's account, built when the assistant calls `context_brief`, of what the person made before on the subject, what earlier turns and the journal say, standing preferences, open tasks and matching sources ([ADR 0027](adr/0027-super-chat-is-an-agentic-layer.md)). Pulled by judgement, never ordered first ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)).
- **Done criterion**: the evidence a plan step needs before the engine ticks it (`brief`, `helper_done`, `check_ran`, `saved`, `read`, `answered`); the model never ticks a step ([ADR 0027](adr/0027-super-chat-is-an-agentic-layer.md)). Goes with the plan machinery ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)).
- **Not checked**: a check step with no action behind it; the hand-back must say so. Goes with the plan machinery ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)).
- **Session panel**: the panel beside the transcript while work runs: Progress (the plan), Outputs (files made), Used in this conversation (tool kinds).
- **Paused**: a helper state: held at its next tool boundary until resumed; cancelled after thirty minutes unresumed.
- **Comment (on a step)**: a step's text attached to the composer as a chip and sent as structured context with the next message.
- **Conversation**: the one chat between a person and the assistant; code still uses a retired name for it (see **Assistant**).
- **Daily note**: one note per person per local day, kept by background `notes` helper passes; the person's own edits are protected ([context.md](context.md#daily-notes-and-the-working-list)).
- **Deck**: an HTML artifact named `*.deck.html` with 1920x1080 slides, exported to PowerPoint or PDF in the host ([decks.md](decks.md)).
- **Foundation**, **Builder** and **Light**: a person's three model picks per harness, chosen from the catalog by capability and price and overridable in Settings ([ADR 0027](adr/0027-super-chat-is-an-agentic-layer.md)). Picked automatically, Foundation is the dearest priced model, Light the cheapest and Builder the middle one (Foundation's when fewer than three are priced); with nothing priced all three are the connection's default. The Super Chat runs on Foundation; helpers on the category the assistant names, Builder by default; titles, summaries and rerank on Light. Replaces Default and Light; the `fast` and `strong` helper picks are aliases for Light and Foundation for one release.
- **Engine**: the server, one process: the API, the built web, Postgres, sessions, scheduling and the model proxy.
- **Feature**: a folder under `engine/omnigent/superchat/` with a `FEATURE`, registered once in `superchat/features.py`.
- **Fork**: deprecated and removed ([ADR 0021](adr/0021-one-conversation-messages-link-to-artifacts.md)); a message links to an artifact instead.
- **Harness**: the model loop inside a runner, `claude-sdk` or `pi`. Replaces executor, inner, native.
- **Helper**: a child session the assistant starts with `start_helper` for one bounded job; read-only to the person, its result goes back to the chat that started it ([helpers.md](helpers.md)). Replaces sub-agent.
- **Helper type**: what a helper is configured as: `worker`, `subworker` or `notes` (`engine/agents/templates/agents/`).
- **Host**: a person's execution environment, today a Docker container the engine starts (`superchat-host-<key>`, labelled `omnigent.host.owner`); runs `omnigent host`. Replaces Computer, sandbox (as a provider), managed host. In copy it is "your machine".
- **Host provider**: how a host is launched; `docker` today (`engine/omnigent/hosts/docker.py`), set by the server config's `hosts:` block and `OMNIGENT_HOST_PROVIDER`.
- **Journal**: dated lines under `~/workspace/memory/journal/` in the host, written by code from checkpoints, helper results and one entry per settled Round ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)); a copy for search, never read back as state.
- **Kept tail**: the most recent whole turns a checkpoint keeps word for word (up to 16,000 tokens).
- **Knowledge index**: the search index in the host (SQLite with FTS5 and sqlite-vec) over the person's files, the journal and retired conversation turns; behind the `files_*` tools and `recall`.
- **Launch token**: the per-launch credential a host uses for its tunnel and its harness uses at the model proxy; the engine stores only its digest.
- **Live page**: an HTML artifact kept up to date from source files by scheduled helper runs; a **live sheet** is the same for CSV and XLSX cells ([artifacts.md](artifacts.md#live-pages)).
- **Memory profile**: the block of high-confidence claims put in front of every turn; a brief carries only its lines that apply ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)).
- **Project**: a folder under `~/workspace/projects/<slug>/` with a `PROJECT.md` card; the assistant opens one with `open_project`.
- **Recall**: finding earlier work over one index: the `recall` tool when the model asks, and the optional per-turn recall hint ([ADR 0016](adr/0016-recall-is-a-bounded-hint-and-a-deep-pull-over-one-index.md)).
- **Result**: a helper's final message, posted to the chat that started it as a system notice.
- **Rollover**: replacing older turns with a checkpoint when the conversation grows large or the person returns after a long break.
- **Round**: one message from the person through its settlement: no turn running, no Helper running, no result unconsumed. Assigned at write time; every item, Helper session and artifact carries its `round_id`, and the view is a pure fold of its events. A steer joins the running Round, a wake turn belongs to the Round that started the Helper, and scheduled and system runs get hidden Rounds of their own. Stop stops one whole Round ([ADR 0029](adr/0029-a-round-is-recorded-and-the-harness-owns-the-words.md)).
- **Runner**: the per-session process a host launches; runs one harness.
- **Sandbox**: only the OS process jail (bubblewrap). "Sandbox provider" and the server config's `sandbox:` block are old names for the host provider and its `hosts:` block. Some code still says sandbox for the host (`sandbox_id`, `sandbox_provider`, `sandbox_status`, `managed_sandbox_reaper`).
- **Side chat**: deprecated and removed ([ADR 0021](adr/0021-one-conversation-messages-link-to-artifacts.md)); there is one conversation.
- **Steer**: a message sent while a turn runs, delivered into that turn instead of starting a new one.
- **Step limit**: a conversation turn may make 3 work tool calls; the next is refused with an instruction to hand the rest to a helper ([ADR 0007](adr/0007-the-muse-delegates-multi-step-work.md)).
- **Sub-agent**: deprecated, now **helper**; still the engine's word in code.
- **Superchat**: the product.
- **Tenant**: the organisation a request belongs to, sent by a sign-in broker in `X-Omnigent-Tenant`; one conversation per person per tenant.
- **Upkeep**: the background job that extracts claims from what the person wrote.
- **Vault**: saved website logins, sealed in the engine; `vault_request_secret` asks for one, `vault_fill` types it into the host's browser.
- **Wake notice**: the system notice a helper posts to its parent when it finishes; `progress` and `flag` notices are added by [ADR 0022](adr/0022-the-orchestrator-narrates-while-helpers-work.md).
- **Working list**: the tagged lines of the checkpoint (`t-` topic, `d-` decision, `o-` open loop, `p-` preference), copied to `~/workspace/memory/STATE.md`; code calls it the state file.
- **Workspace**: the session's working directory, `/home/superchat/workspace` in the host.
