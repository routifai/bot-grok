> **Historical.** Describes the first version of Teach a task (in-browser recording, `libaiden-xcapture.so`, server-side playbook). It was rebuilt on the engine: see [ADR 0006](../adr/0006-taught-skills-are-recorded-in-the-computer-and-kept-on-the-server.md).

# Teach a task: end-to-end test and fixes

Teach a task lets a person show Aiden how to do something on its computer once, so Aiden can do it
again on its own. This note records how the feature works, how it was tested in the Docker build,
what broke, and what was fixed.

## How it works

1. **Start.** In the full computer view the person clicks **Teach a task**, describes the result
   ("Open the browser and search Google for Acme careers") and clicks **Start recording**. The web
   app boots the computer (`computer.boot`) and starts a session (`skills.start`).
2. **Record.** The person gets control of the screen. A banner shows the goal, a 10-minute timer and
   "bot is watching, not acting". Pointer and keyboard input is captured inside the computer by
   `libaiden-xcapture.so` and stored as the teaching recording.
3. **Stop.** **Stop teaching** ends the session. The recording becomes a playbook (steps, how to
   check, what to return, approval boundaries, failure handling) shown as a skill draft card in the
   Conversation.
4. **Save / Test / Add to routine.** **Save** stores the skill. **Test** runs it once as a safe test
   run (trigger `skill`), and the result is reported in the Conversation.

Main code: `apps/web/src/components/teach/*`, `apps/api/src/taught-skills.ts`,
`packages/adapters/src/teaching-session.ts`, `packages/core/src/teach-recording.ts`,
`packages/core/src/teach-playbook.ts`, `infra/sandboxes/computer/xcapture.c`.

## What was tested

A headless Chrome run against the real Docker stack (`./scripts/setup.sh`), no mocks:

| Step | Result |
| --- | --- |
| Sign up and onboarding (model set in `.env`, so no model step) | Pass |
| Open the computer, **Teach a task**, describe the goal | Pass |
| **Start recording** | Pass |
| Demonstrate: click Google's search box, type "Acme careers", press Enter | Pass: input reached the computer and was recorded |
| **Stop teaching** → skill draft with steps, check, boundaries | Pass |
| **Save** | Pass: stored in `taught_skills` with status `saved` |
| **Test** | Pass after the fixes below: Aiden opened a clean tab, replayed all three steps and confirmed the results page |

## Bugs found and fixed

| # | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| 1 | The first computer boot on macOS failed ("computer home … is not writable by uid 1000"), and the screen stayed on "Failed to fetch" until **Retry screen** | macOS file sharing (Docker Desktop, colima) reports every shared file as owned by whoever looks, so the supervisor (root) saw the new home as root-owned | When the ownership check fails, the supervisor asks as the computer user: the home must look like its own and a probe file must write and delete. A genuinely wrong-owned Linux home still fails. The screen now retries by itself with backoff (`306c34cc`) |
| 2 | With the computer panel open, the conversation was crushed into a narrow column | The context panel stayed open next to the computer panel | The context panel collapses while a side panel is open (`2c3f05e1`) |
| 3 | New users never saw the first-run welcome | Onboarding seeded a greeting and a bot-intro run, so the conversation was never empty | In the Muse edition onboarding seeds nothing; the welcome introduces Aiden (`2c3f05e1`) |
| 4 | **Test** reported success without doing anything | The test run started on the screen the demonstration left behind, saw the expected result and stopped | Test runs are told to leave the current screen first, perform every step and pass the check only from their own steps (`eea74a5e`) |
| 5 | In the Docker build, Aiden's clicks and typing failed with "fetch failed" | In isolated-network Compose mode the supervisor joined a computer's network only when its screen was requested; a run that acted first could not reach the control server | The supervisor joins the computer's network wherever it reaches the computer (`be9312ab`) |

Bugs 1 and 5 were already present in the original codebase; the rest came from the Muse edition.

## How to verify again

1. `./scripts/setup.sh`, sign in, open the computer (monitor icon) and click **Open**.
2. **Teach a task** → describe a small task → **Start recording** → do it on the computer →
   **Stop teaching**.
3. On the draft card click **Save**, then **Test**.
4. Expect the Conversation to report that Aiden reset to a clean state and completed every step.
   To confirm the tool calls:

   ```bash
   docker compose -f infra/compose/docker-compose.yml exec postgres \
     sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select \"createdAt\", payload->>'"'"'name'"'"', payload->>'"'"'outcome'"'"' from events where type='"'"'agent.tool.completed'"'"' order by \"createdAt\" desc limit 10"'
   ```

   `computer_act` rows should be `succeeded`.

## Worth improving next

- **Steps are recorded as screen coordinates** ("Click left button at (640, 373)"). They replay well
  on the same layout but are brittle when a page moves. Describing the target ("the Google search
  box") alongside the coordinates would make skills sturdier.
- **Pop-ups during a demonstration** (for example Google's location prompt) end up on screen but not
  in the steps. A replay should dismiss unexpected dialogs before judging the result.
- **Runs interrupted by a stack restart** stay `running` until their lease expires and they are
  resumed; a new run on the same computer waits behind them. Rebuilding the stack mid-run is a
  developer-only situation, but it looks like a stuck test.
- An automated version of this test (headless browser against a throwaway stack) would catch these
  regressions in CI; today it was run by hand.
