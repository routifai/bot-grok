# syntax=docker/dockerfile:1.7
# The Computer: Omnigent's own host image (engine/omnigent/deploy/docker/Dockerfile, target `host`:
# the omnigent runner, git, tmux, Node and the harness CLIs) plus what Superchat's Muse needs on
# top. Headless: no display server, no VNC. The host image's base is Omnigent's PYTHON_IMAGE, which
# Compose sets to plain Ubuntu with the distro's Python (ubuntu-python.Dockerfile).
#
# `omnigent-host` is a named build context, so this file never rebuilds what Omnigent ships.
# Compose wires it (infra/compose/docker-compose.superchat.yaml); by hand, from the repo root:
#   docker build -t superchat/omnigent-host:local --target host --build-arg MINIMAL_HOST=1 \
#     -f engine/omnigent/deploy/docker/Dockerfile engine/omnigent
#   docker build -t superchat/computer:local -f infra/sandboxes/computer/Dockerfile \
#     --build-context omnigent-host=docker-image://superchat/omnigent-host:local .
# Chromium alone, out of Playwright's image (a registry image, so it comes through the same
# mirror as the bases); only this stage reads it, the Computer gets none of its other browsers.
ARG CHROMIUM_IMAGE=mcr.microsoft.com/playwright/python:v1.63.0-noble@sha256:72bd171a9ffc2b4b59532aaa6210e21014d07093120dc25528870c0b840da1f0
FROM ${CHROMIUM_IMAGE} AS chromium-source
RUN mkdir /out && cp -a /ms-playwright/chromium-[0-9]* /out/

FROM omnigent-host

ARG PYPI_INDEX_URL=https://pypi.org/simple
ENV PIP_DISABLE_PIP_VERSION_CHECK=1

# Optional company CA (build secret `ca_bundle`, a PEM file), trusted by apt, pip and npm below.
# Without the secret this is a no-op.
RUN --mount=type=secret,id=ca_bundle,target=/usr/local/share/ca-certificates/ca_bundle.crt,required=false \
    if [ -s /usr/local/share/ca-certificates/ca_bundle.crt ]; then update-ca-certificates; fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

# Tools the Muse's shell uses beyond the host image's (patch: the pptx runtime install below).
RUN apt-get update \
 && apt-get install -y --no-install-recommends imagemagick jq openssh-client patch \
 && rm -rf /var/lib/apt/lists/*

# Python's data stack and the pptx skill's libraries, in the system Python the Muse's shell runs
# (the supervisor's PATH leaves /opt/venv out): /usr/local/bin's on python-slim, /usr/bin's on
# Ubuntu. PyYAML is there for the engine's host-config write (`python3 -c` with yaml). Agg keeps
# matplotlib headless.
RUN PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin python3 -m pip install --no-cache-dir --break-system-packages \
      --index-url "${PYPI_INDEX_URL}" \
      pandas==2.2.3 openpyxl==3.1.5 xlsxwriter==3.2.0 matplotlib==3.9.2 duckdb==1.1.3 \
      python-pptx==1.0.2 "markitdown[pptx]==0.1.8" pyyaml==6.0.2
ENV MPLBACKEND=Agg

# Headless Chromium for deck and dashboard export and the browser_* tools; `chromium` on PATH is
# what the superchat-* helpers look up. Its system libraries come from apt (Playwright's own list),
# fonts so decks render the same as in the person's browser.
COPY --from=chromium-source /out/ /opt/chromium/
RUN set -eu; \
    ln -sf "$(ls -d /opt/chromium/chromium-*/chrome-linux*/chrome | head -n1)" /usr/local/bin/chromium; \
    npx -y "playwright@1.63.0" install-deps chromium; \
    apt-get update; \
    apt-get install -y --no-install-recommends fonts-liberation fonts-dejavu-core fonts-noto-color-emoji; \
    rm -rf /var/lib/apt/lists/*; npm cache clean --force; \
    chromium --version

# The pptx-generator runtime (PptxGenJS with its pinned fixes, react-icons, sharp), on NODE_PATH so
# `require('pptxgenjs')` works from any script the Muse writes.
COPY infra/sandboxes/computer/pptx/runtime/ /tmp/pptx-runtime/
RUN sh /tmp/pptx-runtime/install.sh /opt/superchat-pptx \
 && rm -rf /tmp/pptx-runtime && npm cache clean --force
ENV NODE_PATH=/opt/superchat-pptx/node_modules

# pi pinned to the version the superchat-pi bundle is verified against (Node >= 22.19).
RUN npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@0.87.1 \
 && npm cache clean --force \
 && ln -sf /opt/venv/bin/omnigent /usr/local/bin/omnigent

# Superchat's helpers and the skill files the Muse's prompt points at. --chmod keeps them readable
# under a restrictive host umask.
COPY --chmod=755 infra/sandboxes/computer/start.sh /usr/local/bin/superchat-computer
COPY --chmod=755 infra/sandboxes/computer/superchat-browser infra/sandboxes/computer/superchat-page-browser \
     infra/sandboxes/computer/superchat-deck-export infra/sandboxes/computer/superchat-dashboard /usr/local/bin/
COPY --chmod=644 infra/sandboxes/computer/superchat-local-bin.sh /etc/profile.d/superchat-local-bin.sh
COPY --chmod=644 infra/sandboxes/computer/deck-export/deck-capture-page.js \
     infra/sandboxes/computer/deck-export/vendor/dom-to-pptx/dom-to-pptx.bundle.js.gz /usr/local/share/superchat/deck-export/
COPY --chmod=644 infra/sandboxes/computer/deck-export/vendor/dom-to-pptx/LICENSE /usr/local/share/superchat/deck-export/dom-to-pptx.LICENSE
COPY --chmod=644 infra/sandboxes/computer/dashboard/template.html /usr/local/share/superchat/dashboard/template.html
COPY --chmod=644 engine/omnigent/omnigent/superchat/decks/kit/vendor/chart.js/chart.umd.js /usr/local/share/superchat/dashboard/chart.umd.js
COPY --chmod=644 engine/omnigent/omnigent/superchat/decks/kit/vendor/chart.js/LICENSE.md /usr/local/share/superchat/dashboard/chart.js.LICENSE.md
COPY infra/sandboxes/computer/pptx/skill/pptx-generator/ /usr/local/share/superchat/skills/pptx-generator/

# The Computer user is uid 1000 with its home at /home/superchat (a per-Muse volume at runtime).
# CRs are stripped so the helpers' shebangs work from a CRLF checkout.
RUN find /usr/local/share/superchat -type d -exec chmod 755 {} + \
 && chmod -R a+rX /usr/local/share/superchat /opt/superchat-pptx \
 && gzip -d /usr/local/share/superchat/deck-export/dom-to-pptx.bundle.js.gz \
 && sed -i 's/\r$//' /usr/local/bin/superchat-* /etc/profile.d/superchat-local-bin.sh \
 && if id -u ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
 && groupadd --gid 1000 superchat \
 && useradd --uid 1000 --gid superchat --create-home --shell /bin/bash superchat
ENV HOME=/home/superchat
WORKDIR /home/superchat
USER 1000:1000
CMD ["/usr/local/bin/superchat-computer"]
