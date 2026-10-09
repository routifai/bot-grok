# Self-hosting Nova

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, CreateOS, or Box). It is not a static site. The marketing site in `apps/www` can be hosted separately.

## Local (source checkout)

Same as the README quick start: `.env` from `.env.example`, Postgres via Compose, `pnpm sandbox:build`, `pnpm dev`, then [http://127.0.0.1:5173](http://127.0.0.1:5173) (or `http://localhost:5173` — both loopback hosts are trusted). Electron: `pnpm --filter @nova/desktop dev` while that stack is up, choosing **Existing instance** with that address. The desktop app's **This computer** option instead installs and runs the published images itself with Docker Compose (see [Published images](#published-images-no-checkout)), using port 45173 by default so it can run alongside `pnpm dev`. If that port is occupied, the app selects and remembers another loopback port. The managed API gets a Docker-assigned loopback port; all desktop traffic uses the web origin.

For source development in WSL, keep the checkout and `data` directory in the Linux filesystem (for example, `~/nova`), and run `pnpm dev` as your normal user. The host-run supervisor matches bot container UID/GID to that user. If Docker Desktop container IPs are unreachable, set `SANDBOX_CONTROL_VIA_LOOPBACK=true` in `.env`; this publishes the token-protected control service on a random loopback port. Leave this unset for the Compose-hosted supervisor.

Compose bot homes mount only their own subdirectory of the application volume using Docker volume semantics. Docker's internal volume paths are never used as host bind mounts.

## Published images (no checkout)

Pull Postgres and the published `ghcr.io/<your-namespace>/nova/app` image into any empty folder.
No clone or image build. Requires Docker Engine 26+ (API 1.45+ for bot home volume subpaths), the
Compose plugin, curl, and OpenSSL.

```bash
mkdir -p nova && cd nova &&
curl -fsSLO <raw-url-of-install-images.sh-in-your-repository> &&
bash install-images.sh
```

The installer downloads `docker-compose.images.yml` and `.env.images.example`, creates `.env` with
random secrets, then pulls and starts the images. It preserves an existing `.env` when rerun. For
the installer secret list, non-reuse rules, and recovery, see
[Self-host secrets checklist](./self-host-secrets.md). To customize the public URL, image tag, or
optional providers before startup, run `bash install-images.sh --prepare-only`, edit `.env`, then
run `bash install-images.sh`. Flags may be combined in either order: `--prepare-only`, `--local`.

`SANDBOX_PROVIDER` defaults to `docker`. The images Compose file runs a sandbox supervisor
(from the app image, on the internal network only) and pulls the published computer image.
Signup and local Docker computers work without an E2B account. Optional remote providers: set
`SANDBOX_PROVIDER` to `e2b`, `daytona`, `createos`, or `box` and add the matching API key. The published-images
Compose stack requires `SANDBOX_SUPERVISOR_TOKEN` for every provider; leave it empty and `compose up` fails closed.

Optional: set `OPENROUTER_API_KEY` or connect a model in the UI after signup.
Auto Review uses that LLM checker by default. To use TypeSafe Jev instead, set
`NOVA_AUTO_REVIEW_PROVIDER=jev` and `TYPESAFE_API_KEY`. Core still runs with neither.

The example defaults to `edge` (main builds). Every publish is multi-arch (`amd64` + `arm64`), so
arm64 hosts need no special tag. Do not assume `latest` is present until a stable release exists.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The first registered user becomes the
deployment owner. Put TLS in front of `:5173` for a public host and set the three public origins to
that HTTPS URL.

Images Compose binds web to loopback (`127.0.0.1:5173`). Terminate TLS on the host and proxy
there. Vite preview same-origin-proxies `/api` and `/rpc`, so do not expose `:3100`. Set
`BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL` to that same HTTPS origin, and set
`NOVA_HOST` to its hostname (for example, `app.example.com`).

```Caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:5173
}
```

Open **Agent computer** on a bot, or send a message that uses the desktop, to see
the local Docker computer. For in-stack Caddy plus remote E2B computers, use the
[production Compose](#public-single-vm-deployment) path and `infra/compose/Caddyfile.prod`
instead of this host proxy.

### Restricted networks / mirror downloads

If the installer, Compose downloads, or image pulls are blocked, use the
[restricted-network guide](./self-host-restricted-network.md) for mirror settings and local files.

### Bot computer resource ceilings

Each Docker computer runs Xvfb, a window manager and a full Chromium driven by an agent that
decides for itself what to open, so it is capped. These defaults provide a starting point for the
Docker computer topology:

| Variable | Default | Accepts |
| --- | --- | --- |
| `NOVA_COMPUTER_MEMORY` | `2g` | `2g`, `1536m`, a byte count. Minimum `6m`, Docker's own floor. Also caps swap, so the ceiling holds. |
| `NOVA_COMPUTER_CPUS` | `2` | Whole or fractional cores, e.g. `1.5` |
| `NOVA_COMPUTER_PIDS_LIMIT` | `2048` | A positive integer |

Set any of them to `0`, `none` or `unlimited` to remove that ceiling. A malformed value fails the
supervisor at startup naming the variable, rather than surfacing later as a failed bot.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` (`openssl rand -hex 16`), plus `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to independent long random strings (32+ characters; 64 hex for `ENCRYPTION_KEY`). Docker sandboxes also need a dedicated `SANDBOX_SUPERVISOR_TOKEN`. Keep existing `ENCRYPTION_KEY` values so stored credentials stay decryptable.
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins).
3. Build the computer image: `pnpm sandbox:build` (Compose also builds it via the `computer` service).
4. `docker compose --env-file .env -f infra/compose/docker-compose.yml up --build`
5. Open the web origin (`http://127.0.0.1:5173` by default). The first registered user becomes the deployment owner.

On Windows, if an older clone with `core.autocrlf=true` leaves the computer pane hung on boot (`bash\r` in sandbox logs): from a clean worktree, set `git config core.autocrlf false`, run `git add --renormalize . && git checkout -- .`, then rebuild with `pnpm sandbox:build`.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Bot computers are sibling containers (`nova/computer:local`) on separate per-bot networks; only the supervisor and screen proxy join each one. The API process does not get an unrestricted Docker socket; the supervisor owns the lifecycle.

Postgres stays on the Compose network only (not published on the host), matching the images
compose. Credentials come from `.env` (`POSTGRES_PASSWORD` is required). Prefer a URI-safe value
(`openssl rand -hex 16`); characters such as `@ : / ? # %` break the interpolated `DATABASE_URL`
inside Compose. Official Postgres images set user, password, and database only on first volume
init, so an existing `pgdata` volume keeps its original identity: keep those values in `.env`, or
change them in place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when
the data is disposable); `docker compose down -v` deletes all Postgres state. For host-side clients
(`pnpm db:migrate`, GUI tools),
add `infra/compose/docker-compose.postgres-host.yml` so Postgres is published on loopback
`127.0.0.1:5433`, or use
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
Do not publish Postgres on a public interface.

The Docker supervisor is not published as its own image and is not exposed on the host. It runs from
the app image, stays on the internal Compose network, and holds the Docker socket because access to
it is equivalent to control of the Docker host. Docker sandboxes require `SANDBOX_SUPERVISOR_TOKEN`
(API, worker, supervisor). `SCREEN_PROXY_SECRET` signs browser-screen capabilities (API and web
proxy). Keep both distinct from `BETTER_AUTH_SECRET`.

New credentials use versioned AES-GCM with per-record salt and row-bound AAD. Legacy ciphertext stays readable.

On a VPS, put TLS in front of `:5173` (or serve the web build behind your proxy) and set:

```env
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

Cookies and CORS follow those origins.

### Who can sign up

`SIGNUP_MODE` seeds the signup mode on the API's first start. After that the deployment owner
changes it in Settings > Organization > Signups, which is also where pending accounts are approved.

| Mode | Who gets in |
| --- | --- |
| `closed` | Nobody new. |
| `invite` | Emails (or `@domain` entries) in the invite list (`SIGNUP_ALLOWLIST` seeds it; a non-empty value is reapplied on every API start). |
| `domain` | Addresses at the domains in `SIGNUP_DOMAINS`. |
| `approval` | Anyone, but every account waits (no space, Computer or model access) until the owner approves it. Needs no email provider. |
| `open` | Anyone who proves their email. |

Without `SIGNUP_MODE`, the older variables keep their meaning: `SIGNUPS_ENABLED=false` is `closed`
and a non-empty `SIGNUP_ALLOWLIST` is `invite`.

Every account that gets in on its own (`invite`, `domain`, `open`) proves its mailbox with a
six-digit code, so those modes need email delivery: `SMTP_URL`, or `EMAIL_API_URL` and
`EMAIL_API_KEY` for a Resend-compatible HTTPS API, plus `EMAIL_FROM`. A hosted deployment
(`NODE_ENV=production` on a non-loopback `WEB_ORIGIN`; hosted requires `NODE_ENV=production`)
refuses to start with one of those modes and no provider. `approval` and `closed` need none.
Proving a mailbox voids anything attached to that address earlier, including a password, so
someone who pre-registered another person's address gains nothing; the owner signs in by code. If
the account had been used before (it has a space, which is only possible with no mail provider),
its space is **quarantined, not deleted**: its Computers stop, keys, connections, secrets, MCP
servers, messaging links and approval rules are stripped, scheduled and running work is cancelled
(the engine account is paused, which needs the deployment owner to be an engine admin; the API logs a warning when that fails), screen links stop working, published apps stop being served, and the personal organization is detached from everyone and
kept. The account returns to pending. In Settings > Signups the row says "Previous space kept:
confirm it's the same person" and offers **Restore previous space** (re-attaches the space, bots
and memory; keys and links stay gone and routines stay off) or **Discard** (destroys its Computers
and removes it now); approving instead gives a clean space and **resets the engine account** (its sessions, Computer, keys, schedules and long-term memory are deleted), so nothing the earlier holder taught the engine reaches the new space. Only Restore resumes the engine account. Unclaimed quarantined spaces are purged
after 30 days by the worker, Computers first. Context a squatter planted cannot be told from the
person's own, which is why nothing is re-attached until an admin confirms the person. The
deployment owner is exempt. Memberships in any shared organization are removed too (shared
organizations cannot be created or joined in this version).

The first owner is seated by a claim. With `OWNER_SETUP_TOKEN` set, only a sign-up presenting it
(the "Setup token" field) can claim the seat; a hosted deployment with no owner requires the token
in every mode and refuses to start without it, and you should unset it once an owner exists. On a
personal install with email and no token, the first verified mailbox claims it; with neither
email nor token, nobody can. When email arrives later, approved people whose address was never
proved are asked for a code at their next sign-in.

For a personal install on this machine only, `AUTH_ALLOW_UNVERIFIED_EMAIL=true` skips mailbox
proof for the self-serve modes when no provider is configured; a hosted deployment refuses to
start with it, and the API logs a warning while it is on. In development the email emulator is on
by default.

One generic OIDC connection adds a sign-in button: `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`,
`AUTH_OIDC_CLIENT_SECRET`, optionally `AUTH_OIDC_NAME` and `AUTH_OIDC_ALLOWED_DOMAINS`. Register
`<BETTER_AUTH_URL>/api/auth/callback/sso` with the provider. For Microsoft the issuer must
be `https://login.microsoftonline.com/<tenant-guid>/v2.0`; `common`, `organizations` and
`consumers` are refused. With `AUTH_OIDC_ALLOWED_DOMAINS` set, this provider (and only it) may link to an existing
person with the same email, and a sign-in on an unverified account is mailbox proof; without
domains no provider account is linked by email. Entra issuers require the domains, and guests
are refused. Enable the optional `xms_edov` claim on the Entra app registration: when a token
carries it, it must be true. The signup mode applies like any other way in.

**Upgrade note.** The migration marks every existing user who already has a space as verified so
the upgrade does not lock them out. An address squatted under an earlier open, no-SMTP signup that
already had a space therefore becomes verified; review the people list after upgrading.

The API records whether it can send mail in the database at boot, so the worker and other
processes apply the same rule about unverified accounts.

A hosted deployment must set one of `AUTH_TRUSTED_PROXIES` or `AUTH_CLIENT_IP_HEADER` (see the split
deployment guide for Railway) and will not start without it. Behind a reverse proxy set `AUTH_TRUSTED_PROXIES` (its IPs or CIDRs) or `AUTH_CLIENT_IP_HEADER`,
or the rate limiter sees every client as one address. Limits are stored in the database. Sends
are capped per address and network with a looser per-address cap overall; failed password and code
attempts count in short windows, so a lock lifts itself in minutes.

### Verification and password recovery email

Password changes for signed-in users require no email configuration. Forgotten-password recovery
appears on sign-in only when a transactional email provider is available. Nova uses a
provider-neutral contract and ships an SMTP adapter, so Amazon SES, Resend, and self-hosted SMTP
servers use the same configuration:

```env
SMTP_URL=smtps://smtp-user:replace-with-password@smtp.example.com:465
EMAIL_FROM=Nova <no-reply@example.com>
```

For Resend, use `smtp.resend.com`, username `resend`, and an API key as the password. For Amazon
SES, use the regional SMTP endpoint and SES SMTP credentials; these are different from ordinary AWS
access keys. Verify the sender/domain with the provider before testing delivery. Keep credentials in
`.env`, never in tracked files. `smtps://` uses implicit TLS; `smtp://` is also supported but requires
STARTTLS. Nova rejects configuration that disables TLS or certificate verification.

Local source development can use the offline email emulator instead. It captures email without
contacting a provider:

```env
EMAIL_EMULATOR=true
```

The emulator is forcibly disabled when `NODE_ENV=production` and requires the API to bind to a
loopback host. In `NODE_ENV=development`, captured messages are available from
`http://127.0.0.1:3100/api/dev/emails` with cache disabled; the API logs only delivery
metadata, never reset tokens. The inbox route is not registered in test, staging, or production.

### Logging

Backend services write structured logs to stdout. `LOG_LEVEL` is `debug`, `info`, `warn`, `error`,
or `off` (default `info`). Production defaults to `LOG_FORMAT=json`; development defaults to pretty
unless you set `json` or `pretty`.

Axiom is optional. Set both `AXIOM_TOKEN` and `AXIOM_DATASET` for ingest to one shared dataset.
Services set `service.name` (`nova-api`, `nova-worker`, `nova-sandbox-supervisor`). A partial
Axiom config logs a one-time warning and stays off. `AXIOM_EDGE` is a regional hostname;
`AXIOM_EDGE_URL` must be https and wins when both are set.

Compose passes these into the API, worker, and supervisor. Computer containers do not receive them.

Optional:

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or none, e2b, daytona, createos, box. Keep fake only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause the bot computer after 10 minutes idle
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
MAX_TOOL_CALLS_PER_TURN=  # optional Pi turn tool-call fuse; unset/0 = unlimited
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
CREATEOS_SANDBOX_API_KEY= # when SANDBOX_PROVIDER=createos
BOX_API_KEY=              # when SANDBOX_PROVIDER=box
```

To use an operator-controlled OpenAI-compatible server such as Ollama, LM Studio, llama.cpp, or
MLX, list its model IDs and an endpoint that both the API and worker processes can reach:

```env
NOVA_LOCAL_MODELS=qwen3:4b,llama3.1:8b,qwen3-vl
NOVA_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
NOVA_LOCAL_CONTEXT_WINDOW=32768
NOVA_LOCAL_MAX_TOKENS=4096
# Optional: model ids on this endpoint that accept images (screenshot computer tools).
NOVA_LOCAL_VISION_MODELS=qwen3-vl
```

The loopback default is suitable when running Nova from a source checkout. From containers,
prefer a stable LAN RFC1918 address (not Compose service DNS alone). On Docker Desktop,
`host.docker.internal` also works.
On Docker Desktop, a bot computer shell can often reach services bound to host `127.0.0.1`
through that same hostname. Do not run sensitive unauthenticated services on loopback while
bots run, or firewall / block that path. Linux does not get `host.docker.internal` the same
way by default.
Only configure an endpoint you control: prompts, attachments, and tool results sent to that model
leave Nova through this URL. Leave `NOVA_LOCAL_MODELS` blank to disable the provider.

Each user can also connect their own OpenAI-compatible endpoint from **Connect a model** /
**Settings → Models** on web and mobile. Choose **OpenAI-compatible**, enter the server base URL
(for example `http://127.0.0.1:8000/v1`), the exact model id, and an optional API key.
Public hosts and ordinary hostnames need `NOVA_OPENAI_COMPAT_ALLOW_PUBLIC=1` and HTTPS.
Literal private IP, loopback, and `host.docker.internal` targets do not. If that endpoint's model
accepts images, enable **Supports images** under **Advanced** when connecting so attachments and
screenshot computer tools stay available. Existing connections default to disabled. For centrally
managed endpoints, the deployment-wide fallback remains
`NOVA_OPENAI_COMPATIBLE_VISION_MODELS=gpt4o-vision,llava`.

Remote MCP defaults to public HTTPS. The deployment owner can attach a server on the same LAN
or Docker network. Set `MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker to allow it for
every user. Cloud metadata addresses stay blocked. Leave the flag unset on public installs.

For servers that accept standard `reasoning_effort`, enable **Supports thinking** under
**Advanced** when connecting. The setting is saved on the connection (no env var or restart).
Existing connections default to disabled. Reconnect former Qwen-list or deployment-local models
via **Settings → Models** and turn it on; the old environment list is no longer read.

Enabled connections default to medium thinking. Web and desktop expose **Thinking** in a bot's
advanced settings; mobile inherits the same backend policy. Nova sends standard
`reasoning_effort` (`minimal`, `low`, `medium`, `high`, or `none` when off); the server owns
model-specific translation. Leave **Supports thinking** off when the server lacks standard effort
support. Existing token limits still apply; effort is not a separate reasoning-token budget.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

Optional messaging platforms (iMessage, Slack, WhatsApp, Telegram, Feishu/Lark) mount when their env credentials are set — see `.env.example`. Point a Feishu/Lark bot event subscription at `/api/v1/messaging/webhook/lark` (webhook/HTTP inbound only; do not enable long connection). Groups stay iMessage-only.

## Choosing a computer provider

The Electron desktop app is a client of the same API. Docker and E2B still apply. On first launch, Electron asks the deployment owner whether bots should keep using Docker or run on this Mac as you. `SANDBOX_PROVIDER=desktop` is a separate, explicit provider that always runs commands on the service host.

- **Published images** (`docker-compose.images.yml`) default to `SANDBOX_PROVIDER=docker` with a
  local supervisor and a published computer image. No E2B account required.
  Optional: set `e2b`, `daytona`, `createos`, or `box` plus the matching API key for remote computers.
- **Docker** is the quick-start default for published images and for a source checkout / full local
  Compose stack. Workspace bots share a persistent Team Computer by default; Private computers are
  optional. Keep the supervisor private, as the included Compose files do.
- **E2B** runs bot computers away from the Nova host and is a good choice for public or multi-user
  production deployments. Nova checkpoints the portable workspace and browser-profile directory to
  `DATA_DIR`; the E2B disk is a runtime cache, not the durable source of truth.
- **Daytona** provides the same remote-computer contract through Daytona sandboxes. Configure
  `DAYTONA_API_KEY` and optionally `DAYTONA_API_URL` / `DAYTONA_TARGET` / `DAYTONA_SNAPSHOT`.
- **CreateOS** provides the same remote-computer contract through CreateOS desktop sandboxes.
  Configure `CREATEOS_SANDBOX_API_KEY` and optionally `CREATEOS_SANDBOX_BASE_URL`,
  `CREATEOS_SANDBOX_SHAPE`, or `CREATEOS_SANDBOX_ROOTFS`. Nova defaults to
  `https://api.sb.createos.sh`, `s-2vcpu-2gb`, and `desktop:1`.
- **Box by ASCII** provides a managed Linux desktop through `BOX_API_KEY` and optionally
  `BOX_API_URL`. Nova always creates or resumes boxes with `noEnv: true`, keeps the portable
  workspace under `/home/user/nova-home`, and refreshes a two-hour TTL. Box uses the shared Linux
  desktop runtime and protected port routes for concurrent bot desktops. Each bot has its own
  persistent Chrome profile; logins are not shared between bots.
- **Desktop provider** / **This Mac** runs commands on the API/worker host. Docker stays the default.
  The Electron app asks once; if you choose This Mac, bots can use working directories under your home
  folder. Do not enable it on a public or shared service. macOS does not show its own permission
  dialog for this.
- **Fake** is only an emulator for verification.
- **None** boots the product without a computer host (fallback when Docker/supervisor is not
  configured, or when a remote provider is selected without its API key).

For provider configuration and health checks, see the [provider setup guide](./self-host-sandbox-providers.md).

## Backup

```bash
./scripts/backup.sh
```

This dumps Postgres (`pg_dump`) and archives `data/` into `backups/<stamp>/`. A missing
`data/` produces an empty archive; database or archive errors fail the backup. Discard the
output directory of any failed run.

## Public single-VM deployment

`infra/compose/docker-compose.prod.yml` runs the hosted product with Postgres, the API, worker, web app,
and automatic HTTPS through Caddy. It uses E2B for bot computers, so the VM never exposes a Docker
supervisor or browser containers.

Before deploying to a new Ubuntu host, create and verify a key-only `deploy` account, then apply the
idempotent host-hardening baseline. It disables SSH passwords and root login, rate-limits SSH, allows
only SSH/HTTP/HTTPS through UFW, enables fail2ban, unattended security updates, AppArmor, audit rules,
and conservative kernel/network protections. Keep the provider console open until a fresh SSH login
succeeds after the script reloads SSH.

```bash
sudo DEPLOY_USER=deploy bash infra/compose/harden-host.sh
```

The production host also uses `infra/compose/docker-daemon.json` to enable live restore, bounded local
container logs, default no-new-privileges, and the kernel NAT path instead of Docker's userland proxy.

1. Point an `A`/`AAAA` record such as `app.example.com` at the VM and allow inbound TCP 80/443 and
   UDP 443. If you use Cloudflare, enable the proxy with **Full (strict)** TLS and copy
   `Caddyfile.cloudflare.example` to an operator-controlled path outside the public checkout. Set
   `CADDYFILE_PATH` to that absolute path. The example drops application requests that do not come
   from Cloudflare's [published IP ranges](https://www.cloudflare.com/ips/); reconcile those ranges
   whenever Cloudflare publishes a change. A Cloudflare Tunnel can replace the public web listeners.
2. Clone the repository on the VM and create a root `.env` with production-only values. At minimum set
   `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`,
   `OPENROUTER_API_KEY`, the API key for your selected sandbox provider,
   `NOVA_HOST`, and the three public origins. Set `NOVA_DEPLOY_DIR` when the checkout is not at
   the supported Linux default, `/srv/nova`. Use URL-safe random values for database credentials.
3. Keep registration allowlisted while the service is private:

```env
NODE_ENV=production
NOVA_HOST=app.example.com
# Optional operator-owned override, for example the Cloudflare allowlist file:
# CADDYFILE_PATH=/etc/nova/Caddyfile.prod
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=owner@example.com,reviewer@example.com
# e2b, daytona, or box
SANDBOX_PROVIDER=e2b
WAKEUP_DRIVER=graphile
DATA_DIR=/data
# Absolute path of this checkout as the Docker daemon sees it. /srv/nova is the Linux default;
# set this explicitly for every other layout (for example Docker Desktop's VM-mounted paths).
NOVA_DEPLOY_DIR=/srv/nova
NOVA_IMAGE_TAG=local
```

4. Build the images from your checkout and start the stack, then verify its public health endpoint:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  build --build-arg GIT_SHA=$(git rev-parse HEAD)
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never
curl --fail https://app.example.com/health
```

**Build, do not pull, for a first deployment.** `NOVA_IMAGE_TAG` ships as `local`, a tag no
registry serves, so the commands above build `api`, `worker`, and `web` from the checkout you just
cloned.

Passing `GIT_SHA` is what makes `GET /health` report a `"revision"`; a locally built image has no
other way to know its commit. Prebuilt images from the registry bake it in at publish time, so when
you switch to a release tag you should leave `GIT_SHA` unset — a value in `.env` would override what
the image already knows.

Once a release has been published you can switch this host to prebuilt images by setting
`NOVA_IMAGE_TAG` to that release tag and running `pull` followed by `up -d --wait --pull never`.
See [Published images and tags](#published-images-and-tags) for the tag contract.

The root `.env` is excluded from both Git and the Docker build context. The database, application data,
and Caddy certificates live in named Docker volumes.

The production Compose file pins Postgres and Caddy to multi-architecture manifest digests, and the
published application build pins its base-image digest. Refresh those pins deliberately when taking
base-image security updates; changing only the visible major tag does not change the content while
a digest is present.

For the single-VM production layout, install `infra/compose/backup-prod.sh` as
`/usr/local/sbin/nova-backup` and enable the supplied `nova-backup.timer`. It creates a verified
Postgres custom-format dump plus an application-data archive under `/var/backups/nova`, with mode
`0600` and seven-day rotation. These local snapshots help with operator mistakes but are not a
substitute for an encrypted off-host backup or provider snapshot.

The scheduled backup uses `/srv/nova` by default. For another deployment directory, set
`NOVA_DEPLOY_DIR=/absolute/path/to/checkout` in a root-owned `/etc/nova/backup.env`
(mode `0600`). The service reads this optional file on each run; the script uses the selected
checkout's `.env` and production Compose file. If the stack was started with a custom `-p`,
set the same `COMPOSE_PROJECT_NAME` in that file. For a manual run, export these variables instead.
When updating an existing backup installation, reinstall both the script and service unit,
then run `systemctl daemon-reload`.

## Restore

For backups created by `scripts/backup.sh`, use an empty `nova` database in the development
Compose stack, with application services stopped. The SQL import runs in one transaction and
stops on the first error, including conflicts with existing tables. Files are restored and
application services started only after the import succeeds. This script does not consume the
production snapshot's custom-format `nova.dump` or `appdata.tgz`.

```bash
./scripts/restore.sh backups/<stamp>
```

## Upgrade

A Compose deployment on a published release tag upgrades by moving that tag:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
```

A deployment on the default `local` tag has no registry to pull from, so it upgrades by rebuilding
the checkout instead:

```bash
git pull
GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never --build api worker web
```

`up --wait` does not report success until the new API is healthy and the worker and web containers
are running. The API's start command runs `prisma migrate deploy` before it serves, so migration
failure keeps health red. A failed CLI recreate does not auto-roll back; recover with the previous
`NOVA_IMAGE_TAG` (or rebuild `local`) and `up -d --wait --pull never`.

Source checkouts (not Compose) still upgrade the old way: pull, rebuild with
`GIT_SHA=$(git rev-parse HEAD)`, run `pnpm --filter @nova/db migrate`, then restart API and worker.
Product contracts stay compatible across cloud and self-hosted.

### Space privacy-boundary migration

Before upgrading across migration `20260830200000_space_scope_names_and_user_credentials`, check
that every existing model and voice credential still belongs to a member of its Space. This query
uses the pre-migration `workspaceId` column name and must return no rows:

```sql
SELECT 'model' AS credential_type, credential."id", credential."userId",
       credential."workspaceId" AS "spaceId"
FROM "user_model_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL
UNION ALL
SELECT 'voice', credential."id", credential."userId", credential."workspaceId"
FROM "user_voice_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL;
```

The migration renames columns used by the API and worker and is therefore a coordinated cutover,
not an online rolling migration. Stop the old API and worker, apply the migration, and start the new
versions together. Its lock waits are bounded so contention fails the migration instead of leaving
application traffic queued indefinitely.

### Published images and tags

`.github/workflows/publish-server-image.yml` publishes to `ghcr.io/<owner>/<repo>/…`, derived from
`${{ github.repository }}` rather than hardcoded, so a fork's CI fills the fork's own namespace. For
this repository that is:

| Image | Contents |
| --- | --- |
| `ghcr.io/<your-namespace>/nova/app` | api, worker, web, and sandbox supervisor — one image, multiple commands |
| `ghcr.io/<your-namespace>/nova/computer` | Linux desktop used as each bot computer |

`infra/compose/docker-compose.images.yml` is the no-checkout path for those app and computer tags
plus Postgres. The supervisor runs from the app image on the internal network only (not a separate
published supervisor image, and no host port). Production Compose (`docker-compose.prod.yml`) can
also pull the same app tags once `NOVA_IMAGE_TAG` is set to a published value.

If you publish your own images, set `NOVA_IMAGE` to your namespace — your CI cannot publish into
someone else's.

| Tag | Published on | Moves? |
| --- | --- | --- |
| `local` | nothing — built locally by `up --build` | rebuilt in place |
| `vX.Y.Z`, `vX.Y` | release tags | conventionally no / on patch releases |
| `latest` | stable `vX.Y.Z` tags only (not prereleases) | yes, to the newest stable release |
| `sha-<full-commit>` | every push and manual run | source-addressed |
| `edge` | pushes to main | yes, to the newest main build |

Every publish, including `edge` from main merges, is multi-arch (`amd64` + `arm64`): each
architecture builds natively on its own runner and one manifest is assembled per image. Until a
stable `vX.Y.Z` has been published, the registry may only have `edge` and `sha-*` tags; do not pin
`latest` unless that tag exists in the registry.

Building the images yourself does not need QEMU. `docker compose up --build` builds for the host's
own architecture, and publishing multi-arch images should do what `publish-server-image.yml` does:
build each architecture on a native runner (GitHub Actions provides `ubuntu-24.04-arm` for public
repositories) and merge the digests into one manifest. QEMU emulation (`docker/setup-qemu-action`,
`binfmt`) still works if you have no native arm64 machine, but it is many times slower, hours
rather than minutes for the `computer` image.

Rollback never contacts the registry: redeploy the previous tag from the local Docker cache with
`NOVA_IMAGE_TAG`, so a later tag move cannot change rollback content. Do not prune the previous
application image until the next update has been accepted.

To populate the registry the first time, run the workflow manually (`workflow_dispatch`) or push a
`v*` tag. A manual run produces `sha-<full-commit>`; only a stable `vX.Y.Z` tag (no prerelease
suffix) produces `latest`, and any `v*` tag produces semver tags.

## Other deployment layouts

API and worker need always-on processes; serverless request handlers are not sufficient. Use a
Node.js version supported by the root `package.json`, Postgres 16 and a persistent `DATA_DIR` volume shared by API and worker, with encrypted off-host
backups. The current home store uses a local filesystem, so deployments on separate hosts need a
shared filesystem; an object-storage adapter is not available yet.

Use the same HTTPS origin for the web app, `/api`, and `/rpc`. Preserve the authenticated screen
proxy routes. Choose a [computer provider](#choosing-a-computer-provider) appropriate to the
service's trust boundary. `SIGNUP_MODE` applies on the API's first start. A non-empty
`SIGNUP_ALLOWLIST` applies on every API start.
The optional marketing site in `apps/www` can be hosted separately.

## Connect mobile clients

The iOS and Android app can also point at a self-hosted origin at runtime. On the sign-in screen, tap **Use a custom server** and enter the same HTTPS origin as `WEB_ORIGIN` (for example `https://app.example.com`). Store builds still default to `EXPO_PUBLIC_API_URL`; the in-app setting is an override for people running their own API. Changing the server signs the device out of any previous session.
