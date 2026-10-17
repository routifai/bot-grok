# Architecture decision records

One file per decision, numbered in order. A superseded record keeps its file with a status line at the top. Add a record when a change alters a boundary, a vocabulary, a data model or a user-facing rule; log pure removals in `../engine-trim.md` and cite the record that allowed them.

| # | Decision | Status |
|---|---|---|
| [0001](0001-one-muse-per-person.md) | One Muse per person | Current (the product-mode switch it mentions is gone) |
| [0002](0002-own-the-fork.md) | Own the fork | Superseded by 0003 |
| [0003](0003-superchat-is-standalone.md) | Superchat is standalone | Current |
| [0004](0004-engine-owns-the-host.md) | The engine owns the host | Current |
| [0005](0005-proactive-work-is-scheduled-helper-runs.md) | Proactive work is scheduled helper runs | Current |
| [0006](0006-omnigent-owns-everything.md) | Omnigent owns everything; the engine only runs the model loop | Current; moved from the engine's own records 2026-10-17, side chats gone after 0021 |
| [0007](0007-the-muse-delegates-multi-step-work.md) | The Muse delegates multi-step work | Current; narration added by 0022 |
| [0008](0008-projects-are-folders-the-muse-opens.md) | Projects are folders the Muse opens | Current |
| [0009](0009-the-engine-is-the-whole-backend.md) | The engine is the whole backend | Current |
| [0010](0010-a-fork-is-a-side-chat-with-an-anchor.md) | A fork is a side chat with an anchor | Superseded by 0021 |
| [0011](0011-a-deck-is-an-html-file-exported-in-the-host.md) | A deck is an HTML file exported in the host | Current |
| [0012](0012-native-powerpoint-is-a-second-deck-path.md) | Native PowerPoint is a second deck path | Current |
| [0013](0013-deck-charts-are-chartjs-exported-as-native-charts.md) | Deck charts are Chart.js exported as native charts | Current |
| [0014](0014-files-live-in-the-host.md) | Files live in the host | Current; uploads go through the engine, not a Superchat API |
| [0015](0015-no-app-server-the-web-talks-to-the-engine.md) | No app server: the web talks to the engine | Current |
| [0016](0016-recall-is-a-bounded-hint-and-a-deep-pull-over-one-index.md) | Recall is a bounded hint and a deep pull over one index | Current |
| [0017](0017-the-working-list-is-tagged-and-the-journal-lives-in-the-host.md) | The working list is tagged and the journal lives in the host | Current |
| [0018](0018-one-vocabulary-engine-host-runner-harness.md) | One vocabulary: engine, host, runner, harness | Done 2026-10-17 (rename wave, `9d4fd977d`..`a2cbfb745`) |
| [0019](0019-repository-layout-and-layers.md) | Repository layout and layers | Done 2026-10-17 (moves, flatten, docs, layer contracts in CI) |
| [0020](0020-the-engine-keeps-only-what-superchat-runs.md) | The engine keeps only what Superchat runs | Done 2026-10-17; log in [`docs/engine-trim.md`](../engine-trim.md) |
| [0021](0021-one-conversation-messages-link-to-artifacts.md) | One conversation: messages link to artifacts | Done 2026-10-17; amended by 0024 (both halves; contract in [`docs/conversation.md`](../conversation.md)) |
| [0022](0022-the-orchestrator-narrates-while-helpers-work.md) | The orchestrator narrates while helpers work | Done 2026-10-17 (engine notices, bundle rules, web work strip); updated after review the same day: progress wakes an idle parent, helpers save drafts |
| [0023](0023-the-plan-is-visible-and-the-work-is-alive.md) | The plan is visible and the work is alive | Done 2026-10-17 (plan in the work strip, lit state, header pill; merge `d18372e18`); updated after review the same day: plan id across wake turns, outcome on the strip, one clock |
| [0024](0024-the-artifact-studio.md) | The artifact studio | Accepted 2026-10-17, refined after review the same day (engine shape, concurrency rules, web rules); amends 0021 |

The pages that explain the current system are listed in [../README.md](../README.md).
