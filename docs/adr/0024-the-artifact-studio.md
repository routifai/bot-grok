# The artifact studio

> **Status:** Accepted 2026-10-17. Amends [ADR 0021](0021-one-conversation-messages-link-to-artifacts.md): edits made while a file is open go to that file's own chat, not to the Conversation. Mock-up: https://claude.ai/artifact/PrNmCjw77Yq3odNyyYgHZJ

ADR 0021 put every message in the one Conversation and linked messages to artifacts with a chip. For editing a file, that is the wrong shape. A run of changes to one deck ("bar chart", "biggest first", "shares on the bars") fills Super Chat with talk nobody needs there, and the assistant's context with it. When the person comes back to the deck a day later, those changes are scattered between other topics, and the history of the file is not where the file is. People edit a file in one place, by talking and by hand, and expect that place to remember.

## Decision

- **Opening is not editing.** The file card opens the file beside Super Chat, as today: read, present, export.
- **Editing opens the studio.** *Edit*, or starting to type in the panel's "Ask superchat to change this file…", opens the file in a full-window studio over the app: the slide navigator, the canvas editor that exists today (`features/artifacts/editor`, unchanged), its inspector, and the file's own chat beside them. "‹ Super Chat" closes it and returns to where the person was.
- **One chat per file, for its whole life.** Each file has one studio chat, kept across every version and every visit. It holds the person's requests and the assistant's replies, the person's hand edits as one line each ("You made the title larger"), and a marker for every version saved. Selecting an element on the canvas scopes the next request with the existing element chip (`Slide 3 · region-chart`).
- **Isolated from Super Chat.** The studio chat never appears in the Conversation's transcript and never enters its context. The Conversation learns only that the file has a newer version, through the artifact hint it already gets at the start of each turn (ADR 0021). A message sent in Super Chat about a file still links with the chip, as in ADR 0021.
- **Versions point into the studio.** A version saved from the studio records the studio message that led to it; the version menu says "From this chat" or "By you", and choosing a version shows it and highlights that message. Restore saves a new version, as today.

## Engine shape

- The studio chat is a session: a child of the Conversation, kind `sub_agent`, with the label `superchat.artifact_chat` set to the file's identity (`user_id`, Conversation, file name: the triple that already groups a file's versions). One session per file; the engine finds or creates it (`GET`/`POST /v1/artifacts/{id}/chat`). It runs the same bundle as the Conversation through a helper type `editor` (strong model, the artifact and file tools, no `start_helper`), with a prompt that names the file and its current version.
- Each turn starts with the file's current version as context (the same runtime hint, scoped to this file), so the chat always edits the newest bytes, including hand edits saved in between.
- Hand edits from the canvas are recorded as runtime notice items in the studio session (`[you] <what changed> · v<version>`), so the assistant knows what the person changed and the history shows it.
- Saves from the studio go through `artifact_save` into the same file, so versions, the card and the Library update as they do now. `all_versions[].item_id` points at the studio item.
- The studio session does not wake the Conversation, is not listed among its Helpers, and its turns do not show in the Conversation's work strip. Its activity shows under the file in the activity panel, which is otherwise unchanged.

## Consequences

- Web: a studio surface (`features/artifacts/studio`) that hosts the existing editor and a chat column, opened from the panel's Edit and composer. The panel's composer no longer sends to the Conversation. The editor itself does not change.
- Engine: the `editor` helper type, the find-or-create route, the label, hand-edit notices. No new table: the session store and the artifact store hold everything.
- ADR 0021's "soft scope" in the panel (sending with `context.open_artifact` from the panel) is replaced by the studio. The relink route and the chip on Super Chat messages stay.
- A file made outside a Conversation (uploaded, or from the Library) gets a studio chat the first time someone edits it.

## Considered options

- **The file's thread as a filter of the Conversation** (the first mock-up). Rejected: the edits still land in Super Chat and in its context, which is what the person wanted gone.
- **Side chats as before ADR 0021.** Rejected: a general second place to talk was the problem; this is one place per file, opened only to edit it.
- **The chat in the side panel, beside Super Chat.** Rejected: two conversations on screen at once read as one; the studio gives the file the whole window while it is being edited.
