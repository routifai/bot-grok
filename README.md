# Aiden

![Aiden — AI teammates you actually own](./docs/readme-hero.png)

Aiden is one personal AI that works on your **Goals** in the background, with its own computer to
use a browser and shell, and comes back when it needs you. It runs on the web, as an Electron
desktop app, and through an Expo mobile app. Bring your own model and computer provider, or run
the complete stack locally.

## What Aiden gives you

- **Goals** — hand Aiden an outcome, not a one-off prompt. It plans Tasks, works on them in the
  background, and checks in on the schedule you set.
- **Feed** — what Aiden has done and found, newest first, without you having to ask.
- **Waiting on you** — every open question or approval Aiden needs, in one list, answerable from
  anywhere.
- **Ideas** — suggestions for what to ask next, drawn from your Goals and recent conversation.
- **Library** — everything Aiden has made for you, from the conversation and every Goal, in one
  place.
- **Its own computer** — a sandboxed browser and shell so Aiden can actually do the work, not just
  describe it.
- Bring-your-own model credentials, and app integrations through connected tools and MCP.

## Get started

Setup, configuration, and deployment are covered in [docs/SETUP.md](./docs/SETUP.md).

## Developer setup

You need Node.js 22.22.2 or newer in the 22.x line, Node.js 24.x, or Node.js 26+; pnpm 9; and
Docker.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), create an account, connect a model, and start
talking to your Aiden.

```text
apps/       web, api, worker, desktop, mobile, and public website
packages/   domain, contracts, persistence, adapters, UI, and test tooling
infra/      local services and computer images
docs/       architecture, operations, and release guides
```

Common checks:

```bash
pnpm lint
pnpm check
pnpm test
pnpm test:integration
pnpm test:e2e
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development workflow and test matrix.

## Documentation

- [Setup](./docs/SETUP.md)
- [Self-hosting](./docs/self-host.md)
- [Self-host secrets](./docs/self-host-secrets.md)
- [Computer runtime and isolation](./docs/computer-runtime.md)
- [Desktop releases](./docs/desktop-release.md)
- [Mobile releases](./docs/mobile-release.md)
- [Performance testing](./docs/performance.md)

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull
request. For security vulnerabilities, follow [SECURITY.md](./SECURITY.md) instead of filing a
public issue.

Aiden is licensed under the [Apache License 2.0](./LICENSE).
