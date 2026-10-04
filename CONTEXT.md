# Aiden (Muse edition)

A personal agent: one persistent AI companion per person that works toward their goals on its own and comes back when it needs them.

## Language

**Muse**:
The one persistent agent a person has. It owns the conversation, the memory, and the computer, and it is the only agent the person talks to or manages.
_Avoid_: bot, assistant, Chief, teammate

**Computer**:
The Muse's own machine: its screen, files, and browser. Each Muse has exactly one, and every turn the Muse takes runs inside it. The person can watch its screen.
_Avoid_: sandbox, container, runner, desktop

**Take over**:
The person taking control of the Computer's screen to click and type themselves, then handing it back. While the person is in control, the Muse does not act on the Computer.
_Avoid_: control lease, interactive mode, remote control

**Helper**:
A short-lived task executor the Muse starts for one piece of work. It does not inherit the Conversation: it starts with its brief, what the Muse remembers about the person, and a short summary of the Conversation that the Conversation hands it; it can look up exact past messages when it needs them. It cannot talk to the person, and ends when its work is done; its result goes back to the chat that started it. Its status shows as an Activity. In the engine it is a Sub-agent.
_Avoid_: subagent, sub-bot, peer bot, worker

**Goal**:
An outcome the person wants and has handed to the Muse to pursue over time. It has a plan of Tasks and may have a due date and a check-in schedule. Quick errands are not Goals; they are just done in conversation.
_Avoid_: project, objective, tracker

**Task**:
One item in a Goal's plan: something the Muse does, or waits on the person for. A Task always belongs to exactly one Goal.
_Avoid_: step, to-do, errand

**Proposal**:
A change to the shape of a Goal's plan (adding, removing, or reordering Tasks, or a Goal's first plan) that the Muse suggests and the person accepts or dismisses. The Muse may mark a Task's progress on its own, but never reshapes a plan without an accepted Proposal.
_Avoid_: suggestion, plan edit, draft

**Ask**:
Anything the Muse is waiting on the person for: approving an action, answering a question, accepting a Proposal, or unblocking a Task. An Ask is open until the person answers it or it is withdrawn; answering it anywhere closes it everywhere.
_Avoid_: notification, approval card, request, inbox item

**Conversation**:
The one ongoing chat between the person and their Muse. Background Goal work never happens here; it only reports back here.
_Avoid_: thread, chat, main thread

**Side chat**:
A separate, full-size chat the person (or the Muse, when asked) opens from the Conversation for one focused topic. It starts either knowing the Conversation (a summary plus recent turns) or blank (only what the Muse remembers about the person), sends nothing back, and can't open another side chat. See `docs/super-chat/README.md`.
_Avoid_: thread, sub-chat, fork, branch

**Archived**:
A side chat with no messages for a month: hidden from the main list under an Archived fold, still readable by the person and the Muse, and back in the list when the person writes in it. Never deleted.
_Avoid_: closed, deleted, discarded

**Activity**:
One piece of multi-step work the Muse did — a Conversation or side chat turn that used tools, or a Helper's whole task — with a title, an outcome, a status (in progress, done, failed, cancelled) and plain-language steps. Listed in the Activity panel. Not the same as a Goal log, which is the history of one Goal.
_Avoid_: run, job, event

**Goal log**:
The working history of one Goal: every step the Muse took on it, with its own memory of what happened. The person can read it but doesn't chat in it.
_Avoid_: goal thread, activity, transcript

**Feed**:
What the Muse tells the person, newest first: open Asks pinned on top, then Posts.
_Avoid_: timeline, activity, news

**Post**:
One item in the Feed: either a report of what the Muse did on a Goal, or a finding about a Followed topic. Every Post links to where it came from (a Goal log or a web source).
_Avoid_: update, card, story

**Followed topic**:
A subject the person asked the Muse to keep an eye on ("follow AI agent news"). The Muse researches it daily and writes Posts about what's new. Added and removed by saying so in the Conversation.
_Avoid_: feed instruction, subscription, interest

**Idea**:
A suggestion of something the person could ask the Muse next, drawn from their Goals, memory, and recent Conversation. Tapping one sends it as a message.
_Avoid_: prompt suggestion, recommendation, next step

**Skill**:
A task the person taught the Muse by doing it once on the Computer. The Muse turns the recording into a draft (steps, what changes each time, what to ask first); the person reviews and saves it, and the Muse can then run it again with different inputs.
_Avoid_: macro, recording, playbook

**Library**:
Everything the Muse has made for the person (pages, documents, files), from the Conversation and every Goal log, in one place, with the Skills it has been taught.
_Avoid_: files, artifacts, attachments, gallery

**Check-in**:
A scheduled moment when the Muse reaches out about a Goal (a short nudge or question) without doing work on it. Set per Goal, e.g. "weekdays 07:30".
_Avoid_: reminder, ping, status update

**Proactivity**:
How eagerly the Muse works on Goals on its own: off, low, normal, or high. Paused during quiet hours. Never affects conversations the person starts.
_Avoid_: autonomy level, frequency, aggressiveness

## Relationships

- A person has exactly one **Muse**
- A **Muse** starts zero or more **Helpers**; a **Helper** belongs to exactly one **Muse** and never outlives the work it was started for
- A person has zero or more **Goals**; each **Goal** has an ordered plan of one or more **Tasks**
- A **Task** belongs to exactly one **Goal**; there are no standalone **Tasks**
- A **Goal** has at most one open **Proposal** at a time; the Muse keeps working on the still-valid **Tasks** while it waits
- Every open **Proposal** is an **Ask**; so is every **Task** blocked on the person
- The Muse works on a **Goal** unprompted when its **Proactivity** timer fires or when an answered **Ask** unblocks a **Task**; a **Check-in** only reaches out
- A **Muse** has exactly one **Conversation**; each **Goal** has exactly one **Goal log**
- Work on a **Goal** is recorded in its **Goal log**; the **Conversation** receives only a short report and any **Asks**
- While working a **Goal**, the Muse sees that **Goal log**, the **Conversation**'s summary, and its shared memory, but not other **Goal logs**
- The Muse works on at most one **Goal** at a time; the others wait their turn, and the **Conversation** always goes first
- The **Feed** shows every open **Ask** on top; it is the same **Ask** as in the waiting list and the **Conversation**, not a copy
- Work on a **Goal** follows the same approval rules as the **Conversation**; anything needing approval becomes an **Ask**
- An **Ask** may block one **Task**, or nothing (a standalone question in conversation); the Muse keeps working on whatever it doesn't block

## Example dialogue

> **Dev:** "Can the person create a second **Muse** for work stuff?"
> **Domain expert:** "No. There is one **Muse**. If work needs parallel effort, the **Muse** starts **Helpers**; they never show up as something the person chats with."

## Flagged ambiguities

- "bot" appears throughout the existing code and UI for what is now the **Muse**. Resolved: in conversation and new copy, say **Muse**; "bot" survives only as a legacy code name.
- "Task" in the existing code is an internal record of one request and its runs, which is not a **Task** in this glossary. Resolved: in conversation and copy, **Task** means only a plan item of a **Goal**; the legacy internal record keeps its code name to avoid a wide, low-value rename.
- "Routine" (a scheduled prompt with no end) is not a **Goal**. A recurring chore stays a Routine; an outcome with a plan is a **Goal**.
