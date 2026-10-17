# The conversation

There is one conversation per person. The assistant talks in it, helpers work under it, and artifacts come out of it. This page is the contract for how a message links to an artifact and how versions link back to messages ([ADR 0021](adr/0021-one-conversation-messages-link-to-artifacts.md)), and for how the assistant narrates while helpers work ([ADR 0022](adr/0022-the-orchestrator-narrates-while-helpers-work.md)). It replaces the side-chat and fork sections of the earlier docs.

## Words

- **Conversation**: the one chat. Its transcript is a list of items: the person's messages, the assistant's replies, cards and notices.
- **Helper**: a child session the assistant starts for a bounded job. It has its own transcript, read only through the activity panel; nothing from it enters the conversation except the assistant's own words about it.
- **Artifact**: a file the assistant saved into the conversation (a deck, a page, a document, a mini app). It has versions.
- **Chip**: the small pointer on a message that says which artifact, and optionally which part of it, the message is about.

## A message links to an artifact

Two kinds of chip, one look.

**Hard scope.** The person selects elements in the canvas editor. The composer carries the editor's chip (`Slide 4 · growth-title`) and the message travels with a `<superchat-element-request>` block ahead of the words. Only those elements change. This exists today and does not change.

**Soft scope.** The person says what to change with nothing selected. The message still gets a chip, filled in by the engine:

1. **Open in the panel.** When an artifact is open beside the chat, the web sends its id and version with the message (`send.context.openArtifact`). The message shows the chip at once (`Q3 Lending Review`). The assistant is told the artifact is open; it is a hint, not a hard scope.
2. **Just made or just edited.** When nothing is open, the engine looks up the artifacts saved or edited in this conversation, newest first, and tells the assistant their names, ids and versions in a short runtime notice at the start of the turn. No model call is spent on this.
3. **By name.** For older artifacts the assistant uses recall and `artifact_list` as it does today.

The chip for cases 2 and 3 appears when the work is done, not when the message is sent: the engine fills it in the moment the turn saves a version of an artifact. That is the honest answer to "which artifact did you mean"; the assistant's first sentence says it in words before that.

**A wrong guess is one tap.** Tapping the chip opens a small list of the conversation's recent artifacts plus "None". Picking one updates the link. If the turn is still running, the engine steers the assistant with one line ("The person means `<name>`"); if the turn is over, the next message carries the corrected link as its hint.

## A version links to a message

Every save is a version: by the assistant from a message (`ai`), by hand in the editor (`manual`), by restore (`restore`), by a live update (`update`). A version saved during a turn records the id of the person's message that started the turn. The version menu in the editor shows it as "from your message · 3 min ago"; choosing it scrolls the conversation to that message. Versions saved by hand have no message and show "edited by hand", as today.

## Contract

Web ↔ engine, additive. Names are final; shapes may grow. The web half is merged (`a2812bace`..`d3e2933e0`); the engine matches these shapes.

**Message item.** The person's message gains an optional field:

```
artifact: null | {
  artifactId: string,
  name: string,            // file name at the time of linking
  version: number | null,  // the version the message produced, once there is one
  how: "open" | "edited" | "chosen"   // open beside the chat / filled in by a save / picked on the chip
}
```

`how: "open"` is set at send time, `"edited"` by the engine when a save happens during the turn, `"chosen"` when the person taps the chip. A change arrives on the family stream as an item update; the web redraws the chip.

**Send.** `chats.send` gains `context?: { openArtifact?: { artifactId: string, version: number } }`. On the wire the context rides at the top level of the message event, beside `data`, so it never lands in the model's input item:

```
{ "type": "message", "data": { "role": "user", "content": "…" },
  "context": { "open_artifact": { "artifact_id": "art_…", "version": 4 } } }
```

The engine turns it into the runtime hint and the `how: "open"` link on the stored item (`artifact: { artifact_id, name, version, how }` in snake_case on the wire).

**Relink.** `chats.setMessageArtifact({ botId, itemId, artifactId: string | null })` → `POST /v1/sessions/{id}/items/{itemId}/artifact` with body `{ "artifact_id": "art_…" | null }`. The engine updates the link (`how: "chosen"`), steers a running turn, and answers with the updated transcript item in the same shape as a transcript page item. `404 not_found` when the item is not the person's message.

**Versions.** `ArtifactVersion` gains `itemId: string | null`, the person's message that led to it; on the wire `all_versions[].item_id`. The engine sets it on every version saved during a turn the person's message started. The web falls back to `turn_item_id` when `item_id` is absent and the version is the conversation's own non-manual save; that fallback goes once the engine sends `item_id`.

**Runtime hint.** A system notice at the start of a turn, never longer than ten lines:

```
Artifacts in this conversation (newest first):
- Q3 Lending Review (deck, v4, art_…) — open beside the chat
- Provisions memo (document, v1, art_…)
```

The hint is derived from the artifact store and the send context. It is not a tool and not a model call.

## The assistant narrates while helpers work

The rules the assistant bundle carries ([ADR 0022](adr/0022-the-orchestrator-narrates-while-helpers-work.md)):

- **Speak first.** One paragraph on what it will do, streamed before any helper starts and before any file is read.
- **Progress is a sentence.** A helper posts a one-line progress notice to its parent at each step it completes. The parent narrates it in one or two sentences in its running reply. The helper's transcript never enters the parent's context.
- **Flags wake the parent.** When a helper chooses between sources, deviates from the ask, or finds something the person should know, it raises a flag; the parent tells the person right away.
- **Decisions, not mechanics.** "I'm using the ledger", not the command that read it. Surprises as soon as they are known. On hand-back, at most three things to look at; the rest goes in the artifact.
- **Questions are answered now.** A message while helpers run is answered on the main turn; the helpers keep going and the reply says so.
- **Drafts are versions.** A helper writing an artifact saves draft versions as it goes, so the work strip under the reply can show the artifact filling in.

Engine contract for this, additive: a `progress` and a `flag` notice kind beside the completion notice (`superchat/helpers`), a throttle of one progress notice per helper step, and the parent's wake handling narrating the notice in its running reply. Web: a work strip under the reply (label, elapsed time, Show details, the artifact strip when a draft exists) and helper cards attached to the message that started them. The activity panel is unchanged.

## What is gone

Side chats, forks, the Chats popover, "Chat with this folder", the fork action on a message, the auto-archive setting, the `side_chat_open` tool, seeds and fork summaries. The removal and its commits are in the [trim log](super-chat/ENGINE-TRIM.md).
