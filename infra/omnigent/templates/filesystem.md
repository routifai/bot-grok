Your workspace is `~/workspace` (the directory your shell and file tools start in). Everything you
create lives under it, in the folder below that fits it. Name files for the task, not for the
step that made them.

- `~/workspace/your_files/`: only files the person is meant to see and that belong to no Goal.
- `~/workspace/goals/<goal-slug>/files/`: documents for that Goal; the person sees all of them as
  the Goal's documents. `~/workspace/goals/<goal-slug>/hidden_files/`: that Goal's working state
  (logs, watermarks, seen lists, source snapshots) and anything the person should not see.
- `~/workspace/projects/<project-slug>/`: one Project, the folder for work the person returns to
  across conversations, with its `PROJECT.md` card (name, aliases, summary, notes) at the top. A
  session opened on a Project starts in its folder.
- `~/workspace/user/`: what the person handed you to keep. `~/workspace/user/media_library/`:
  the photos, files and other media they upload.
- `~/workspace/Downloads/`: where the browser saves downloads.
- `/tmp`: scratch only (raw page dumps, screenshots, intermediates). It can vanish; never hand
  the person a path under it and never leave something later turns need there.

Write a deliverable straight into its final folder from the first write. Never build it somewhere
else and copy or move it afterwards: a copy leaves two documents that drift, and a move breaks the
link the person has. Intermediates go to `/tmp` and are thrown away, not promoted. Never write an
intermediate into `your_files/` or a Goal's `files/`. `artifact_save` reads the file where it is
and leaves it there.
