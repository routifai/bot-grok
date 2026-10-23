# 0037: The daily brief is a scheduled page

> **Status:** Accepted 2026-10-23 by the owner, from the Routines mock-up (morning brief window). Builds on [0005](0005-proactive-work-is-scheduled-helper-runs.md), [0035](0035-topics-are-written-by-the-quiet-moment-pass.md) and [0036](0036-proactive-messages-go-through-one-outbox.md).

People want to open the app and see what needs them today without asking. Generating that on click takes minutes; generating it on a schedule means it is ready. Reacting to every calendar or mail change is its own product and waits until we know which sources really shape a brief.

## Decision

**One scheduled task per person, kind `daily_brief`.** Created on first use with weekdays at 7:30 in the person's time zone; the person changes the time or turns it off in Automations like any other. It runs as a scheduled Helper (0005) under every existing gate: proactivity, quiet hours, one proactive run at a time. **Refresh now** on the brief uses the existing run-now route.

**What it reads, in order, and nothing else:** yesterday's and today's daily note (open loops, promised), open topics and their "New" lines (0035), today's calendar and unread mail when a connector is connected, and the person's standing memory. Item text from mail and the web is fenced as data.

**What it writes: one page, one line.**

- A page artifact, "Brief · Fri 23 Oct", one new version per run: **Needs you today** (at most 3, each with the reason and a ready draft or next step, never sent), **Your day** (meetings with one line of prep each), **Since yesterday** (what moved on open topics), **Worth knowing** (at most 3). An empty section is left out, and a day with nothing reads "Nothing needs you today".
- One proactive message (0036, kind `brief`, urgency `brief`): the first line of *Needs you today* and the page link.

**Where the person sees it.** On Home, the latest brief is the first card in "Pick up where you left off", marked "Brief" with its time; it opens the page. Older briefs are the page's versions.

## Considered options

- **Generate on click.** Rejected as the default: minutes of waiting at the moment the person wants to start; kept as Refresh now.
- **Rebuild on every calendar or mail change.** Deferred: hard to keep correct (it does not know what the person already did), and topic watch already covers urgent changes.
- **A chat message with the whole brief.** Rejected: it buries the Conversation; the page is a file the person can reopen and the message is one line.

## Consequences

- Engine and bundle change (the brief prompt and kind); no host change.
- Mail and calendar sections appear only for people with a connector; without one the brief runs on notes and topics.
- Cost: one Builder-model run per person per weekday; skipped when proactivity is off.
