# The plan is visible and the work is alive

> **Status:** Done 2026-10-17 (merge `d18372e18`). Extends [ADR 0022](0022-the-orchestrator-narrates-while-helpers-work.md).

ADR 0022 made the assistant talk while helpers work. In use, the reply still reads flat: one grey line under it ("Done · 0:48"), no sign of what the assistant set out to do, and nothing that says "this is running right now" except a seven-pixel dot. The interaction mock-up showed a plan whose steps tick over and a strip that is visibly alive; the build kept the words and lost the shape. A person waiting on work needs two things at a glance: what the assistant is doing in what order, and that it is doing it now.

## Decision

- **Every multi-step request gets a plan.** Right after its first paragraph, the assistant publishes a plan: three to six steps in the person's words, using the existing living `plan` card (`render_card` kind `plan`, one stable `id` per reply). It updates the same card as steps start and finish, and rewrites it when the plan changes (a step added, dropped or reworded). A one-step request gets no plan. The plan is the assistant's own; helpers' progress and flags are narrated against it, never added to it by the engine.
- **The plan lives in the work strip.** The web draws the reply's living plan inside the work strip under the reply, not as a separate card: done steps checked, the current step with the live mark and its latest progress sentence, steps to come muted. A changed plan animates the change (a new step slides in; a reworded step cross-fades), so the person sees it evolve. The settled strip keeps the plan, collapsed to one line ("4 of 4 done · 2:14"), expandable.
- **Running work is lit.** While the turn or any of its helpers runs, the strip carries the Superchat orb (`components/ai/orb`, the shader orb, in its working state) as its mark and a slow glowing edge in the bot's identity colour, the one colour the monochrome UI allows. The glow stops when the work settles; `prefers-reduced-motion` gets a static edge. The same lit state shows in the conversation header while anything runs, so it is visible when the strip is scrolled away.
- **The strip shows for the assistant's own work too.** A multi-step turn with no helper still gets the strip with its plan and the lit state; ADR 0022's strip appeared only for helpers.

## Consequences

- Engine: none beyond the prompt. The `plan` card exists; the bundle's narration rules gain "publish a plan for multi-step work, keep it current". No new tool, no new event.
- Web: the work strip reads the reply's living `plan` card (the newest render of its `id`) and stops drawing it as a standalone card in that reply; the orb and the glow come from existing components and the bot's identity token. The activity panel stays unchanged.
- A reply whose plan the model forgot still gets the ADR 0022 strip; nothing breaks without a plan.

## Considered options

- **A new `plan_update` tool and plan events.** Rejected: the living `plan` card already carries exactly this (todo, doing, done; updated in place by `id`).
- **The plan in the activity panel.** Rejected: the panel is a view of what ran, closed by default; the plan belongs next to the words that describe it.
- **A coloured accent for "working" separate from the bot colour.** Rejected: the UI is monochrome, and the bot colour is already the one identity colour.
