# Deploy Nova on Railway with a Computers VPS

A private test for a few friends. Model usage is billed to **your** Anthropic key, so
keep the sign-up list short.

```
Browser ──►  Railway: nova-app (web + API + worker, one domain)
                                                                       │  OMNIGENT_URL + proxy secret
                                                                       ▼
                                                          Railway: omnigent-engine  ◄── runner in each Computer
                                                                       │  HTTPS + bearer token                (dials the engine's public URL)
                                                                       ▼
                                           OVH VPS (Beauharnois): Caddy ─► supervisor ─► one Docker Computer per Muse
```

| Piece | Where | Repo files |
| --- | --- | --- |
| Web (Vite preview server) | Railway, inside nova-app | `infra/railway/start-nova.sh` |
| API + worker, one service | Railway | `infra/railway/railway.nova.json`, `Dockerfile.nova`, `start-nova.sh` |
| Nova Postgres | Railway plugin | |
| Omnigent engine + its Postgres + a volume | Railway | `infra/railway/railway.engine.json`, `Dockerfile.engine`, `engine.config.yaml.tmpl`, `engine-start.sh` |
| Supervisor, Computer image, Caddy | OVH VPS | `infra/compose/docker-compose.computers.yml`, `Caddyfile.computers`, `.env.computers.example` |

Design choices, and why:

- **API and worker are one Railway service.** Both use `DATA_DIR`, and a Railway volume attaches to
  one service only. `start-nova.sh` runs both processes and exits if either dies, so Railway
  restarts the pair.
- **The engine has a public URL.** The runner inside each Computer, on the VPS, must dial back to
  it, so it cannot be private. Every engine call from Nova carries a shared secret
  (`OMNIGENT_AUTH_HEADER_SECRET`, header auth); runners use short-lived per-launch tokens.
  Nova's API therefore uses the same public URL. Railway private networking
  (`<service>.railway.internal`) is an optional hardening; it only works if the engine listens on
  an address your Railway environment routes privately, which the engine does not set up for you.
- **Engine to supervisor goes over HTTPS with a bearer token (Caddy on the VPS).** Simpler than
  Tailscale here: Railway services cannot join a tailnet without a sidecar. The supervisor refuses
  any `/computers` request without the token, and Caddy forwards nothing else.
- **Engine database: Postgres** (the engine's Docker/Railway recipe is Postgres-based), plus a
  Railway volume at `/data` for its files.

## 0. Before you start

You need: a GitHub copy of this repo that Railway can read, a Railway account,
an OVH account, a domain you control, an Anthropic API key, and an SMTP account to send verification
mail (Resend is the easy one, see section 5).

Generate the secrets once, on your own machine, and keep them in a password manager:

```bash
openssl rand -hex 32   # run once per secret listed in the table in section 4
openssl rand -base64 32   # only for OMNIGENT_VAULT_KEY
```

## 1. Computers VPS (OVH, Beauharnois, Ubuntu 24.04)

1. In the OVHcloud control panel order a VPS (the VPS-4 plan), location **Beauharnois (Canada)**,
   image **Ubuntu 24.04**, and add your SSH public key. Note the public IPv4 address.
   Pick a size that fits `friends x AIDEN_COMPUTER_MEMORY` plus about 3 GB.
2. DNS: at your domain registrar add an **A record** `computers.<your-domain>` pointing at that IP.
3. First login. OVH creates a default user (shown in the order mail, often `ubuntu`); then create
   the deploy user the hardening script expects:

   ```bash
   ssh <default-user>@<vps-ip>
   sudo adduser --disabled-password --gecos "" deploy
   sudo mkdir -p /home/deploy/.ssh
   sudo cp ~/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
   sudo chown -R deploy:deploy /home/deploy/.ssh && sudo chmod 700 /home/deploy/.ssh
   sudo usermod -aG sudo deploy
   ```

   Open a **second** terminal and check `ssh deploy@<vps-ip>` works before continuing.
4. Install Docker (official repository) and Git:

   ```bash
   sudo apt-get update && sudo apt-get install -y ca-certificates curl git
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
   sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
   ```

   Do not add `deploy` to the `docker` group; use `sudo docker ...` (the group is root-equivalent).
5. Clone and harden (blocks SSH passwords and root login, opens only SSH, 80 and 443):

   ```bash
   git clone <your-repo-url> nova && cd nova
   sudo DEPLOY_USER=deploy bash infra/compose/harden-host.sh
   ```
6. Configure and start:

   ```bash
   cp .env.computers.example .env.computers
   sed -i "s/^SANDBOX_SUPERVISOR_TOKEN=.*/SANDBOX_SUPERVISOR_TOKEN=$(openssl rand -hex 32)/" .env.computers
   sed -i "s/^DOCKER_GID=.*/DOCKER_GID=$(stat -c %g /var/run/docker.sock)/" .env.computers
   nano .env.computers      # set COMPUTERS_HOST; adjust AIDEN_COMPUTER_* if needed
   grep SANDBOX_SUPERVISOR_TOKEN .env.computers   # copy this value for Railway
   sudo docker compose --env-file .env.computers -f infra/compose/docker-compose.computers.yml up -d --build
   ```

   The first build takes 10 to 20 minutes (the Computer image contains a desktop and Chromium).
7. Check: `curl https://computers.<your-domain>/health` returns `{"ok":true,...}`, and
   `curl -i https://computers.<your-domain>/computers` returns **401** (the token is required).

## 2. Railway: databases, engine, API + worker

Create a Railway project, then:

1. **Add two Postgres databases** (New, Database, PostgreSQL). Rename them `nova-db` and `engine-db`.
2. **Engine service.** New, GitHub repo, choose this repo. Name it `omnigent-engine`.
   Settings: Root directory `/`; Config-as-code file path `/infra/railway/railway.engine.json`.
   Add a **Volume** mounted at `/data`. Settings, Networking: Generate Domain (note the URL,
   `https://<engine>.up.railway.app`). Set the variables in section 4, then deploy.
   First boot runs the database migrations; `/health` turning green means it is up.
3. **Nova service.** New, GitHub repo, same repo. Name it `nova-app`.
   Config-as-code file path `/infra/railway/railway.nova.json`. Add a **Volume** at `/data`.
   Networking: Generate Domain; the target port is the web server on `$PORT` (Railway sets it).
   Set the variables in section 4, then deploy. The start command applies Prisma migrations before
   starting the API and the worker.

The agent bundle (`nova-claude`) is baked into the engine image from `infra/omnigent/agents`, so
there is no upload step. If you edit `infra/omnigent/templates`, run
`node infra/omnigent/render-agents.mjs`, commit, and redeploy the engine.

## 3. Web on Railway (same service as the API)

The Nova web app runs in the same Railway service as the API and the worker
(`infra/railway/start-nova.sh`): the web server listens on Railway's `$PORT` and proxies `/api`,
`/rpc` and `/novnc` to the API on `127.0.0.1:3100` inside the container. One public domain, no
cross-site cookies, and live streams stay open. Vercel is not used: it cannot keep the chat
streams open or proxy the live screen.

**Known gap (phase 2):** the live Computer screen and Take over need the web server to reach the
Computer's screen port, which the supervisor publishes on the VPS loopback only. Until a secure
relay through the VPS's Caddy is added, everything else works but the Screen view stays empty.

## 4. Variables: which service, and where the value comes from

Names only below; never commit values.

| Variable | Set on | Value / source |
| --- | --- | --- |
| `DATABASE_URL` | nova-app | Reference: `${{nova-db.DATABASE_URL}}` |
| `DATABASE_URL` | omnigent-engine | Reference: `${{engine-db.DATABASE_URL}}` (the entrypoint accepts Railway's `postgresql://` form) |
| `NODE_ENV` | nova-app | `production` |
| `API_HOST` / `API_PORT` / `PORT` | nova-app | `0.0.0.0` / `3100` / `3100` |
| `DATA_DIR` | nova-app | `/data` (the volume) |
| `BETTER_AUTH_SECRET` | nova-app | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | nova-app | `openssl rand -hex 32` (64 hex chars); keep it forever or stored credentials become unreadable |
| `SCREEN_PROXY_SECRET` | nova-app | `openssl rand -hex 32` |
| `BETTER_AUTH_URL`, `WEB_ORIGIN`, `API_URL` | nova-app | The nova-app public origin, e.g. `https://app.<your-domain>` (all three identical) |
| `SANDBOX_PROVIDER` | nova-app | `none` (the engine owns Computers; the API never talks to the supervisor) |
| `WAKEUP_DRIVER` | nova-app | `graphile` |
| `OMNIGENT_URL` | nova-app | Engine public URL, `https://<engine>.up.railway.app` |
| `OMNIGENT_PROXY_SECRET` | nova-app | Same value as the engine's `OMNIGENT_AUTH_HEADER_SECRET` |
| `ANTHROPIC_API_KEY` | nova-app | Your key (makes the Claude harness show as available) |
| `SIGNUPS_ENABLED`, `SIGNUP_ALLOWLIST` | nova-app | `true`; comma-separated emails (see section 5) |
| `SMTP_URL`, `EMAIL_FROM` | nova-app | From your mail provider (see section 5) |
| `ENGINE_PUBLIC_URL` | omnigent-engine | Engine's own public URL (the runners dial it) |
| `OMNIGENT_AUTH_HEADER_SECRET` | omnigent-engine | `openssl rand -hex 32`; equals nova-app `OMNIGENT_PROXY_SECRET` |
| `OMNIGENT_COMPUTER_SUPERVISOR_URL` | omnigent-engine | `https://computers.<your-domain>` |
| `OMNIGENT_COMPUTER_SUPERVISOR_TOKEN` | omnigent-engine | Equals `SANDBOX_SUPERVISOR_TOKEN` in the VPS `.env.computers` |
| `OMNIGENT_VAULT_KEY` | omnigent-engine | `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | omnigent-engine | Your key. This is the engine's model connection and is also passed to every Computer's runner |
| `TAVILY_API_KEY`, `OPENROUTER_API_KEY` | omnigent-engine | Optional; passed to runners when set |
| `NOVA_CLAUDE_MODEL`, `OMNIGENT_HELPER_MODEL_FAST`, `OMNIGENT_HELPER_MODEL_STRONG` | omnigent-engine | Optional; defaults are baked in `Dockerfile.engine` |
| `OMNIGENT_SUBAGENT_MAX_CONCURRENT` | omnigent-engine | Optional cap on parallel Helpers |

Baked-in engine defaults (no need to set): header auth with the `X-Omnigent-Tenant` header,
default agent `nova-claude`, sandbox provider `computer`, home root `/data` (must equal the
supervisor's data dir, which it does), proactive Study on.

## 5. First login and inviting friends

Signup is controlled by the Nova API, not by the engine:

- The **first** account to register becomes the deployment owner.
- `SIGNUP_ALLOWLIST` is a comma-separated list of exact emails or `@domain` entries. A non-empty
  value is applied on **every** API start and replaces the stored list. Only listed people can
  register. Leave `SIGNUPS_ENABLED=true` (it is only read the first time the API starts).
- With a non-empty allowlist, **SMTP is required for every account after the first**; they
  must verify their email. Without SMTP only the first account can register. Easiest: a free Resend
  account, `SMTP_URL=smtps://resend:<api-key>@smtp.resend.com:465` and
  `EMAIL_FROM="Nova <no-reply@<your-domain>>"` after verifying the domain with Resend.
- Order: set the allowlist and SMTP **before the first start**, register yourself first, then add
  friends by editing `SIGNUP_ALLOWLIST` on Railway (the service restarts and applies it).
- Not recommended: an empty allowlist leaves registration open to anyone who finds the URL, and
  they would spend your key.

## 6. How the web reaches the API

The browser only talks to the Nova service's own domain, with relative `/api` and `/rpc` paths and
first-party cookies. Set `BETTER_AUTH_URL`, `WEB_ORIGIN` and `API_URL` on the Nova service to that
domain. Long-lived streams (`threads.subscribe`, `chats.watch`, `memory.watch` under `/rpc/`) are
proxied by the web server inside the container, so nothing in front buffers or cuts them.

## 7. Check it works

1. Open the nova-app URL, register (owner), and send a message to your Muse.
2. First message creates the Computer on the VPS; allow a minute. On the VPS:
   `sudo docker ps` shows an `aiden-bot-...` container.
3. Logs: Railway, service, Deployments, View logs. VPS:
   `sudo docker compose --env-file .env.computers -f infra/compose/docker-compose.computers.yml logs -f supervisor`.
   Logs rotate (10 MB x 3 per service).

## 8. Costs (rough, check current pricing)

- Railway: Hobby plan about 5 USD/month plus usage; expect roughly 10 to 25 USD/month for two small
  services, two Postgres and two volumes.
- OVH VPS: roughly 10 to 30 USD/month depending on plan.
- Domain: about 10 to 15 USD/year. 
- Anthropic: pay as you go, billed to your key. Each friend runs a desktop Computer; a busy agent can
  cost several dollars per day. Set a spend limit in the Anthropic console.

## 9. Updates, backup, tear-down

- Update Railway: push to the branch Railway tracks (or Redeploy). Update the VPS:
  `git pull && sudo docker compose --env-file .env.computers -f infra/compose/docker-compose.computers.yml up -d --build`.
  A rebuilt Computer image replaces each Computer on its next use; homes are kept.
- Backup: Railway Postgres (use Railway backups or `pg_dump` with the public connection string)
  for **both** databases, the engine `/data` volume, and the Nova `/data` volume. On the VPS the
  Computer homes are in the `nova-computers_computers-data` Docker volume:
  `sudo docker run --rm -v nova-computers_computers-data:/d -v "$PWD":/b busybox tar czf /b/computers-data.tgz -C /d .`
- Tear down: delete the Railway project, then on the VPS
  `sudo docker compose --env-file .env.computers -f infra/compose/docker-compose.computers.yml down -v`
  and delete the VPS in OVH and the DNS record. Revoke or rotate the Anthropic key.
