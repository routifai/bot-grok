# Pi harness: future work

The Muse can run on Omnigent's `pi` harness (`NOVA_MUSE_HARNESS=pi`, bundle `nova-pi`), including
non-Claude models through OpenRouter. Verified live on a test side chat: search turns,
`start_helper` to a worker, artifacts. Not urgent; pick up when Pi matters.

1. **File card posted by the engine.** A non-Claude Muse (GPT via OpenRouter) skipped the
   `render_card` file card after a Helper finished. Have the engine post the card for a Helper's
   saved files so delivery never depends on the model following the instruction.
2. **Helpers under a Pi Muse.** The switch is total: with `NOVA_MUSE_HARNESS=pi`, the Muse and
   every Helper type (`worker`, `subworker`, `goal`, `teacher`), including scheduled and
   background Helper runs, run on Pi (bundle `nova-pi`); nothing stays on Claude. Open: a
   coordinator worker under a Pi Muse has not yet split a job into subworkers (it did a
   multi-part trip plan alone); check whether that is model or prompt. Verify live that a
   worker's tool-call ids are no longer Anthropic `toolu_` ids.
3. **Provider config from the engine.** OpenRouter only worked once the provider block was placed
   in the Computer's own config home, with the key passed into the Computer. Deliver provider
   config from the engine like the rest, and keep provider keys out of the person's Computer
   (gateway or proxy).
4. **fast/strong per model family.** Done in the engine: on Pi, `fast`/`strong` read
   `OMNIGENT_HELPER_MODEL_FAST_PI` / `OMNIGENT_HELPER_MODEL_STRONG_PI`, and with none set a Pi
   Helper inherits the parent's model (the global Claude ids never apply to Pi). Open: pick the
   Pi ids once a cheap non-Claude model is chosen.
5. **Per-person choice.** Harness and model are chosen by deployment config or API only; add a
   Settings choice that switches the person's Conversation through Omnigent.
6. **Binary attachments on Pi.** PDFs and other binary files are dropped (text and images only).
7. **Goal plan items on Pi.** The `objectives` plan item union (`string | {title}`) collapses to
   the object form on Pi, so plain-text items fail.
8. **Moving an existing Conversation.** Switching replays history to Pi as flat text (tool items
   and images dropped). Fine for new chats; consider a richer replay before switching long
   Conversations.
9. **Instructions on other models.** The Muse and worker instructions were tuned on Claude; check
   each new model (instruction following, made-up links) before offering it.
10. **`tmux` in the Computer image.** Its absence only logs an error when the REPL terminal is
    auto-created.
