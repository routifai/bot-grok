# One Muse per person, behind a product mode

This fork turns Rakazo's multi-bot platform into a single personal agent: each person has exactly one Muse, and the only other agents are short-lived Helpers the Muse starts itself. Creating peer bots (the sidebar "+", onboarding bot setup, and the `spawn_bot` / `update_bot` / `archive_bot` / `message_bot` / `handoff_to_bot` tools) is locked, not merely hidden, so there is never a second persistent memory or computer the person has to reason about.

The fork stays a soft fork of elie222/rakazo that is never proposed upstream: Muse behaviour sits behind one product-mode setting and lives in new files and packages that plug into existing entry points with small edits, so upstream fixes keep merging with few conflicts.

## Considered options

- **Keep multi-bot, make the Muse the default.** Rejected: two mental models in one product, and the Meta Muse experience depends on a single relationship.
- **Let the Muse create hidden persistent helper bots.** Rejected: each one would carry its own memory and computer the person cannot see; long-running specialist work becomes a goal the Muse works on instead.
- **Hard fork.** Rejected for now: upstream ships frequent fixes to the runtime, sandbox, and apps that this fork wants to keep.
