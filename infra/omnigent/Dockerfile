# Superchat's engine: any Omnigent server image (`omnigent-server`, a named build context) plus
# this folder at /opt/bundle (agent bundles, config templates, start script). It builds nothing of
# Omnigent's, so the base can come from Omnigent's own Dockerfile or any variant of it.
# Compose wires it (infra/compose/docker-compose.superchat.yaml); by hand, from the repo root:
#   docker build -t superchat/omnigent-server:local --build-arg OMNIGENT_EXTRAS=memory,postgres \
#     -f engine/omnigent/deploy/docker/Dockerfile engine/omnigent
#   docker build -t superchat/engine:local -f infra/omnigent/Dockerfile \
#     --build-context omnigent-server=docker-image://superchat/omnigent-server:local .
# The context is the repo root: a node stage builds apps/web, and the engine serves the result
# (OMNIGENT_WEB_UI_DIST) with an SPA fallback, so one container is the API and the web.
ARG NODE_IMAGE=node:22-slim

# The web build: apps/web and the workspace packages it uses (the context is trimmed by
# infra/omnigent/Dockerfile.dockerignore).
FROM ${NODE_IMAGE} AS web
# Read by npm and pnpm; corepack fetches pnpm itself from the same registry.
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY} \
    COREPACK_HOME=/usr/local/share/corepack \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    CI=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
# Optional company CA (build secret `ca_bundle`, a PEM file), trusted by apt and npm/pnpm.
# Without the secret this is a no-op.
RUN --mount=type=secret,id=ca_bundle,target=/usr/local/share/ca-certificates/ca_bundle.crt,required=false \
    if [ -s /usr/local/share/ca-certificates/ca_bundle.crt ]; then update-ca-certificates; fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --chmod=755 . .
RUN pnpm install --frozen-lockfile --filter "@superchat/web..."
RUN SUPERCHAT_ALLOW_DEV_SECRETS=1 pnpm --filter @superchat/web build

FROM omnigent-server
COPY infra/omnigent/ /opt/bundle/
COPY --from=web /app/apps/web/dist /opt/web
RUN rm -f /opt/bundle/Dockerfile /opt/bundle/Dockerfile.dockerignore \
 && chmod -R a+rX /opt/bundle /opt/web \
 && chmod 755 /opt/bundle/engine/start.sh \
 && sed -i 's/\r$//' /opt/bundle/engine/start.sh
# The engine serves this bundle at "/" (client routes fall back to index.html; /v1 and /health
# stay the API) and published mini apps at /apps/<slug>.
ENV OMNIGENT_WEB_UI_DIST=/opt/web
CMD ["/opt/bundle/engine/start.sh"]
