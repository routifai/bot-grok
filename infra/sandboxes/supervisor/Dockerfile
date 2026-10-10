# The sandbox supervisor: starts one Computer container per person through the Docker socket.
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}
# Read by npm and pnpm; corepack fetches pnpm itself from the same registry.
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Optional company CA (build secret `ca_bundle`, a PEM file), trusted by corepack and pnpm below.
# Without the secret this is a no-op.
RUN --mount=type=secret,id=ca_bundle,target=/usr/local/share/ca-certificates/ca_bundle.crt,required=false \
    if [ -s /usr/local/share/ca-certificates/ca_bundle.crt ]; then update-ca-certificates; fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
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
