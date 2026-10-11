# The app image: the api, worker and web server, run together in one container by
# infra/app/start.sh (Compose and Railway alike). Only those three apps and the packages they use
# are installed: the desktop, mobile and marketing workspaces keep just their manifests
# so the lockfile matches.
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}
# Read by npm and pnpm; corepack fetches pnpm itself from the same registry.
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME=/pnpm \
    COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY} \
    COREPACK_HOME=/usr/local/share/corepack \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    CI=1
# Prisma needs OpenSSL at runtime; CA certificates for HTTPS to model and integration providers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
# Optional company CA (build secret `ca_bundle`, a PEM file), trusted by apt, npm, pnpm and
# Prisma's engine download below. Without the secret this is a no-op.
RUN --mount=type=secret,id=ca_bundle,target=/usr/local/share/ca-certificates/ca_bundle.crt,required=false \
    if [ -s /usr/local/share/ca-certificates/ca_bundle.crt ]; then update-ca-certificates; fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app

# Normalize modes: a restrictive host umask (e.g. 077 on hardened hosts) would otherwise
# leave the copied tree unreadable to USER node at runtime.
COPY --chmod=755 . .

RUN pnpm install --frozen-lockfile \
      --filter "@superchat/api..." --filter "@superchat/worker..." --filter "@superchat/web..."
RUN pnpm --filter @superchat/db generate
RUN SUPERCHAT_ALLOW_DEV_SECRETS=1 pnpm --filter @superchat/web build
# The pnpm corepack fetched as root stays readable, so USER node never downloads it again.
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp \
 && chmod -R a+rX /usr/local/share/corepack

ARG GIT_SHA
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
EXPOSE 3100 5173 7091
# Railway mounts its volume root-owned: run that service with RAILWAY_RUN_UID=0.
USER node
CMD ["bash", "infra/app/start.sh"]
