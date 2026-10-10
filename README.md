# superchat

## Architecture

```mermaid
flowchart LR
  web["web app"] -- oRPC --> api["API"]
  api -- HTTP --> engine["engine (Omnigent)"]
  api --- db[("Postgres: superchat_db")]
  engine --- db
  engine -- provisions --> sup["sandbox supervisor"]
  sup --> box
  engine -- "host + runner" --> box
  subgraph box["Computer (one container per person)"]
    runner["runner + harness (Claude SDK or Pi)"]
    files["workspace files + search index"]
    chromium["headless Chromium (deck and dashboard export)"]
  end
```

- **web** (`apps/web`): the interface. One Conversation, its side chats and forks, the dock
  (Inbox, Mini Apps, Automations, Files) and the Activity panel. It only renders state and sends
  intent.
- **API** (`apps/api`): sign-in, accounts and authorization. It checks who is asking and passes
  each call to the engine; it holds no agent logic.
- **engine** (`engine/omnigent`): the agent server. It owns sessions, the Conversation and side
  chats, Helpers, memory, approvals, artifacts, scheduled tasks (Automations), the model layer and
  the agent bundle (`infra/omnigent`). Any website can drive it.
- **supervisor** (`infra/sandboxes/supervisor`): starts and stops each person's Computer.
- **Computer** (`infra/sandboxes/computer`): a container per person where the agent actually runs.
  It holds the person's files, indexes them for search, and renders decks and dashboards to
  PowerPoint and PDF with a headless browser. The agent has no desktop or browser control.
- **Postgres**: one database, `superchat_db`, with the API and the engine in their own schemas.

## Requests

1. The person sends a message in the web app; the API checks the session and forwards it to the
   engine.
2. The engine runs a turn in the person's Computer: the runner calls the model, the tools run there
   (files, shell, Python, export), and long or multi-step work goes to Helpers.
3. Results stream back to the web app as events: the reply, cards, artifacts and Activity.
4. Anything that acts in the person's name waits in the Inbox for approval.

## Layout

| Path | What |
|---|---|
| `apps/web` | web app |
| `apps/api` | API |
| `apps/worker` | background jobs for the API |
| `packages/*` | shared contracts, adapters, UI, database client |
| `engine/omnigent` | engine |
| `infra/omnigent` | agent instructions and tool bundle |
| `infra/sandboxes` | supervisor and Computer image |

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for third-party credits.
