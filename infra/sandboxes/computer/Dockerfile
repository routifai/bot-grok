# syntax=docker/dockerfile:1.7
# The Computer: Omnigent's own host image (engine/omnigent/deploy/docker/Dockerfile, target `host`:
# the omnigent runner, git, tmux, Node and the harness CLIs) plus what Superchat's Muse needs on
# top. Headless: no display server, no VNC.
#
# `omnigent-host` is a named build context, so this file never rebuilds what Omnigent ships.
# Compose wires it (infra/compose/docker-compose.yml); by hand, from the repo root:
#   docker build -t superchat/omnigent-host:local --target host \
#     -f engine/omnigent/deploy/docker/Dockerfile engine/omnigent
#   docker build -t superchat/computer:local -f infra/sandboxes/computer/Dockerfile \
#     --build-context omnigent-host=docker-image://superchat/omnigent-host:local .
FROM omnigent-host

ARG PYPI_INDEX_URL=https://pypi.org/simple
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Tools the Muse's shell uses beyond the host image's (patch: the pptx runtime install below).
RUN apt-get update \
 && apt-get install -y --no-install-recommends imagemagick jq openssh-client patch \
 && rm -rf /var/lib/apt/lists/*

# Python's data stack and the pptx skill's libraries, in the system Python the Muse's shell runs
# (the supervisor's PATH leaves /opt/venv out). Agg keeps matplotlib headless.
RUN /usr/local/bin/python3 -m pip install --no-cache-dir --break-system-packages \
      --index-url "${PYPI_INDEX_URL}" \
      pandas==2.2.3 openpyxl==3.1.5 xlsxwriter==3.2.0 matplotlib==3.9.2 duckdb==1.1.3 \
      python-pptx==1.0.2 "markitdown[pptx]==0.1.8"
ENV MPLBACKEND=Agg

# Headless Chromium (Playwright's build, with its system libraries) for deck and dashboard export
# and the browser_* tools; `chromium` on PATH is what the superchat-* helpers look up.
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --no-shell chromium \
 && ln -s "$(ls -d /opt/ms-playwright/chromium-*/chrome-linux*/chrome | head -n 1)" /usr/local/bin/chromium \
 && chromium --version \
 && rm -rf /var/lib/apt/lists/* && npm cache clean --force

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
