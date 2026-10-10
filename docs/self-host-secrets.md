# Self-host secrets checklist

Credentials for the Docker stack. `./scripts/setup.sh` ([SETUP.md](./SETUP.md)) generates the
required ones; this page documents them for manual setup.

Never commit `.env`, paste secret values into issues or PRs, or overwrite an existing `.env`
without a backup.

## Required (setup.sh fills blanks)

| Key | Generate with | Role |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` | Postgres role password (keep it URI-safe) |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` | sign-in and session signing |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | encrypts stored credentials at rest |
| `SCREEN_PROXY_SECRET` | `openssl rand -hex 32` | signs short-lived proxy capabilities |
| `OMNIGENT_PROXY_SECRET` | `openssl rand -hex 32` | signs API to engine calls |
| `OMNIGENT_VAULT_KEY` | `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '='` | seals saved model keys |

Use independent values; never reuse one string across keys. `SUPERCHAT_UPDATER_TOKEN` (only with
the prod overlay's updater) must also be distinct. Empty required keys fail closed at Compose
validate time.

Existing `pgdata` volumes keep the user, password and database from first init. Keep those values
in `.env`, or change them in place with `ALTER ROLE`; recreate the volume only after a backup
(`docker compose down -v` deletes all Postgres state). Rotating `ENCRYPTION_KEY` or
`OMNIGENT_VAULT_KEY` after secrets were stored makes them unreadable.

## Optional (leave blank if unused)

| Key(s) | When needed |
| --- | --- |
| `ANTHROPIC_API_KEY` | models without LiteLLM |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` | models through a LiteLLM proxy (the engine switches to it when set) |
| `OPENROUTER_API_KEY` | OpenRouter models |
| `TAVILY_API_KEY` | web search |
| `COMPOSIO_API_KEY` | app-integration catalog |
| `SMTP_URL` | email delivery for sign-up modes other than `closed` on a hosted deployment |

## Recovery

- Lost `.env`: restore from backup only. New random secrets on a volume that still holds Postgres
  data desynchronize the password and the encrypted material.
- Moving hosts: copy `.env` and volumes together and treat `.env` as secret material in transit.

## Related

- [Setup](./SETUP.md)
