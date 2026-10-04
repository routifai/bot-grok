# Taught skills are recorded in the Computer and kept on the server

Teaching the Muse a task used to record pointer coordinates in the browser tab and keep the draft in Nova's database. We rebuilt it on the engine, following ADR 0004 and 0005: while the person holds control, a small recorder inside the Computer's browser reports semantic actions (click, type, select, navigate, with the element's role, accessible name and a selector hint) and a downscaled screenshot after each. On stop, the engine pulls the trace and keyframes out, deletes them from the Computer, stores them on its server, and starts a `teacher` Helper that writes a draft skill (intent-level steps with a check each, approval points, typed inputs with the demonstrated value as default). The draft is versioned on the server; the person reviews, edits, tests and saves it; the Muse runs it with `skill_run`, which returns the skill text with the run's inputs filled in. Nova only relays and renders.

## Considered options

- **Keep recording coordinates and screenshots from Nova's side.** Rejected: coordinates break on any layout change, and Nova cannot see inside the engine's Computer.
- **Run the recorder in the engine and poll the page.** Rejected: only code in the page sees the real element and its secret fields, so redaction has to happen there.
- **Have the teacher's result wake the Conversation.** Rejected: the person reviews the draft themselves; a wake only adds a turn that says nothing.

## Consequences

- Secrets (password, one-time code, card fields, anything marked secret) are redacted in the page: the value is never read, the trace says "typed a secret into <field>", and no keyframe is taken while a password field is visible or focused or the URL looks like a login. A vault that fills secrets at replay, by name and outside the model's context, is not built yet: until then a login is the person's to enter.
- The engine gains a generic recording capability on sandbox providers next to the screen, and a skills store; any product can use both.
- The Computer keeps nothing of a recording after stop.
