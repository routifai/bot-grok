<p align="center">
  <img src="./apps/web/public/favicon.svg" alt="" width="96" height="96" />
</p>

<h1 align="center">Nova</h1>

<p align="center"><strong>Your AI, already on it.</strong></p>

Nova is one personal AI that works for you. Hand it a goal and it plans the work, does it in the
background on its own computer, and checks in when it needs you. It lives in the browser, on your
desktop and on your phone.

## What Nova does

- **Goals.** Give Nova an outcome, not a prompt: "prep the Q3 client portfolio review." It
  proposes a plan, you approve it, and it keeps working on it and reports back on your schedule.
- **Its own computer.** A private desktop with a browser, files and a shell, so Nova actually does
  the work. Watch it live, or take over whenever you want.
- **Waiting on you.** Every question and approval Nova needs, in one place, answered in a tap.
- **Feed.** What Nova finished while you were away, plus news on the topics you follow.
- **Ideas.** Things Nova could start for you next, drawn from your goals and conversations.
- **Library.** Every page, document and file Nova has made, with live previews.
- **Your models.** Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible server such as
  LiteLLM, vLLM or Ollama.

## Run it

New here? Follow **[QUICKSTART.md](./QUICKSTART.md)**: from zero to your own Nova, step by step.

With Docker (Docker Desktop or colima):

```bash
git clone <your-repo-url> nova
cd nova
./scripts/setup.sh
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173). The first account you create owns the
install. Everything else (models, ports, troubleshooting, updating) is in
[docs/SETUP.md](./docs/SETUP.md).

Inside the code, packages, containers and settings keep the internal name `aiden`
(for example `@aiden/web`, `AIDEN_LOCAL_MODELS`).

## Develop

Node.js 22.22.2+ (or 24.x / 26+), pnpm 9 and Docker.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

```text
apps/       web, api, worker, desktop, mobile
packages/   domain, contracts, database, adapters, UI kit, test tooling
infra/      local services and the computer image
docs/       setup, design and architecture notes
```

Before a change lands:

```bash
pnpm lint
pnpm check
pnpm test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow and [SECURITY.md](./SECURITY.md) to
report a vulnerability.

## License

[Apache License 2.0](./LICENSE).
