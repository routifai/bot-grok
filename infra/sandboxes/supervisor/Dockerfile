# Bases and package sources are build args with public defaults; a company sets its own registry
# and mirrors in .env (see .env.docker.example).
ARG BASE_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# Node is copied out of the official image (a self-contained binary plus npm/corepack).
FROM ${NODE_IMAGE} AS node-runtime

FROM ${BASE_IMAGE}
# APT_MIRROR empty keeps Ubuntu's public sources; set, it replaces every URIs: line.
ARG APT_MIRROR=
# Read by pnpm; corepack fetches pnpm itself from the same registry.
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV DEBIAN_FRONTEND=noninteractive \
    COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY}
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|^URIs: .*|URIs: ${APT_MIRROR}|" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches patches
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/logging packages/logging
COPY infra/sandboxes/supervisor infra/sandboxes/supervisor
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@superchat/sandbox-supervisor..."
WORKDIR /app/infra/sandboxes/supervisor
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
