# Contributing to Superchat

Thanks for helping improve Superchat. Keep changes focused and testable.

## Run locally

Follow the [source checkout setup](README.md#local-development-source-checkout) for prerequisites,
required secrets, and startup commands.

## Checks before you open a PR

| Command | When to run |
| --- | --- |
| `pnpm test` | Default. Units and properties for the web and the shared packages. No live model-provider calls. |
| `pnpm check` | TypeScript (`tsc`) across the monorepo. |
| `pnpm lint` | Biome lint and format check. |

CI runs `pnpm lint`, `pnpm check`, production builds and `pnpm test` on every PR.

## Adding a UI language

The web UI uses Lingui catalogs. To add a locale, register it in
`apps/web/lingui.config.ts`, `apps/web/src/lib/ui-locale.ts`, and
`apps/web/src/lib/i18n.ts`, then run `pnpm --filter @superchat/web intl:extract`, fill the new
`apps/web/src/locales/<locale>/messages.po` catalog, and validate it with
`pnpm --filter @superchat/web intl:compile`. Keep message IDs, placeholders, JSX markers, and
ICU plural branches intact; do not commit generated `*.js`/`*.mjs` catalog files.

Update the locale unit tests for the new locale.

## Secrets and configuration

- **Never** commit `.env` files or secrets.
- **Never** paste API keys, tokens, or passwords in issues or PRs.
- Use placeholders in examples (`your-openrouter-key`, etc.).

Turns run on the Omnigent engine; `pnpm dev` proxies to it at `OMNIGENT_URL`.

**Integrations** can use [Composio](https://composio.dev/) or Pipedream Connect as optional managed
app catalogs. Users can also install HTTPS MCP servers (including Treg) and bounded OpenAPI tool
sources. Connector tests must stay deterministic and offline. Never put connector credentials in
capability config, fixtures, logs, or snapshots; use the encrypted secret store and fake placeholders.

## Pull requests

- Keep PRs small and easy to review.
- Target the `main` branch.
- Describe why the change is needed, what changed, and **how you tested** (e.g. `pnpm test`, manual steps).
- Link related issues when applicable.

## Contact

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities. For everything else, open an
issue.
