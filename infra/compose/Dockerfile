# syntax=docker/dockerfile:1.7
# One image for the api, worker and web services (Compose runs each with its own command).
# Only those three apps and the packages they use are installed: the desktop, mobile and marketing
# workspaces keep just their manifests so the lockfile matches.
# Bases and package sources are build args with public defaults; a company sets its own registry
# and mirrors in .env (see .env.docker.example).
ARG BASE_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# Node is copied out of the official image (a self-contained binary plus npm/corepack).
FROM ${NODE_IMAGE} AS node-runtime

FROM ${BASE_IMAGE}
# APT_MIRROR empty keeps Ubuntu's public sources; set, it replaces every URIs: line.
ARG APT_MIRROR=
# Read by npm and pnpm; corepack fetches pnpm itself from the same registry.
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME=/pnpm \
    COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY} \
    COREPACK_HOME=/usr/local/share/corepack \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    DEBIAN_FRONTEND=noninteractive \
    CI=1
# Prisma needs OpenSSL at runtime; CA certificates for HTTPS to model and integration providers.
# Ubuntu's image ships an `ubuntu` user at uid 1000; it becomes `node`, the user this image runs as.
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|^URIs: .*|URIs: ${APT_MIRROR}|" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && usermod --login node --home /home/node --move-home ubuntu \
 && groupmod --new-name node ubuntu
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable
WORKDIR /app

# Normalize modes: a restrictive host umask (e.g. 077 on hardened hosts) would otherwise
# leave the copied tree unreadable to USER node at runtime.
COPY --chmod=755 . .

# The pnpm store lives in a build cache, so it speeds up rebuilds without landing in the image.
RUN --mount=type=cache,id=superchat-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --package-import-method copy \
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
USER node
CMD ["pnpm", "--filter", "@superchat/api", "start"]
