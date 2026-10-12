# Live artifacts

A page (HTML artifact) can keep itself up to date: a schedule runs a Helper in the person's
Computer that re-reads the page's sources and changes only the parts that show source facts.

## Rules

- Trigger: a scheduled task (`kind="live_artifact"`, parent = the artifact's chat, Helper type
  `worker`). "Update now" fires the same task.
- Sources: a list saved with the artifact (web page URL or Computer file path). If empty, the
  first run infers them from the page and the chat and saves them.
- An update works on the newest version and changes facts by `data-superchat-id` only
  (`set-text`). Every update that changes something is one new version, origin `update`.
- A fact part the person changed since the last update is theirs: the update does not overwrite
  it; it becomes a suggestion ("source says X, you wrote Y"). A fact part the person deleted stays
  deleted. A value the person undid is rejected: it is skipped until the source says something
  else.
- No change found: only `checked_at` moves. No version, no message.
- Changes that cannot be placed: one open issue; two runs in a row pause the schedule.
- The run waits while the person is editing (a hand edit in the last 10 minutes).
- A published copy stays pinned unless "follows updates" is on; then each update republishes.
