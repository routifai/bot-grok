# syntax=docker/dockerfile:1.7
# The Computer: a headless Ubuntu 24.04 workspace the Muse's runner (`omnigent host`) works in.
# No screen: files, a shell, Python's data stack, Node, the pptx runtime and a headless Chromium
# (Playwright's build) for decks, dashboard PDFs and the browser_* tools.
#
# Build context is the repo root (not this directory) so the omnigent-builder stage below can
# vendor engine/omnigent — see infra/compose/docker-compose.yml, scripts/setup.sh, and the CI
# validate matrix in .github/workflows/publish-server-image.yml. Every COPY of this directory is
# therefore prefixed infra/sandboxes/computer/.
#
# Bases and package sources are build args with public defaults. A company points them at its own
# registry and mirrors in .env (see .env.docker.example); no mirror hostname belongs in this file.
# ARGs used in a FROM must be declared before the FIRST FROM to stay in scope for it.
ARG BASE_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# Node is copied out of the official image (a self-contained binary plus npm/corepack); nothing
# from its Debian userland reaches the final image.
FROM ${NODE_IMAGE} AS node-runtime

# ── Ubuntu base with the package mirror applied ─────────────────────
# APT_MIRROR empty keeps the image's own public sources (archive.ubuntu.com, or ports.ubuntu.com
# on arm64). Set, it replaces every URIs: line in ubuntu.sources (the main archive and security).
FROM ${BASE_IMAGE} AS ubuntu
ARG APT_MIRROR=
ENV DEBIAN_FRONTEND=noninteractive
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|^URIs: .*|URIs: ${APT_MIRROR}|" /etc/apt/sources.list.d/ubuntu.sources; \
    fi

# ── Omnigent runner builder ──────────────────────────────────────
# Installs the vendored engine/omnigent package (the Superchat "computer" runner launcher —
# docs/omnigent-spike.md — execs `omnigent host` in this image) into a standalone venv the final
# stage copies out. Same Ubuntu base as the final stage, so the venv's bin/python symlink
# (/usr/bin/python3.12, noble's own interpreter) is valid at runtime too.
FROM ubuntu AS omnigent-builder
ARG PYPI_INDEX_URL=https://pypi.org/simple
ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=${PYPI_INDEX_URL} \
    UV_DEFAULT_INDEX=${PYPI_INDEX_URL}
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates python3 python3-dev python3-venv \
 && rm -rf /var/lib/apt/lists/*
# uv lives in its own venv here; the final stage takes just its single binary.
RUN python3 -m venv /opt/uv && /opt/uv/bin/pip install --no-cache-dir uv
WORKDIR /build
COPY engine/omnigent/pyproject.toml engine/omnigent/setup.py engine/omnigent/uv.lock ./
COPY engine/omnigent/LICENSE engine/omnigent/NOTICE ./
COPY engine/omnigent/sdks/ ./sdks/
COPY engine/omnigent/omnigent/ ./omnigent/
RUN python3 -m venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never
# Frozen (--frozen) so the sandbox always gets exactly the dependency set the committed
# lockfile pins, never a fresh, unconstrained resolve; non-editable (--no-editable) so the
# install is self-contained bytes in /opt/venv — the final stage copies only that, no /build
# .pth files pointing back into a directory it would otherwise have to carry too.
RUN /opt/uv/bin/uv sync --frozen --no-editable --no-dev --python /usr/bin/python3.12

# ── Data stack for the agent's shell ─────────────────────────────
# `python3` in the Muse's shell is noble's /usr/bin/python3.12; these land in its
# /usr/local/lib/python3.12/dist-packages, copied whole into the final stage. All manylinux
# wheels: no compiler needed. Agg keeps matplotlib headless.
FROM ubuntu AS python-data
ARG PYPI_INDEX_URL=https://pypi.org/simple
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_INDEX_URL=${PYPI_INDEX_URL}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages --no-cache-dir \
    pandas==2.2.3 openpyxl==3.1.5 xlsxwriter==3.2.0 matplotlib==3.9.2 duckdb==1.1.3
# pptx-generator skill (docs: pptx/skill/pptx-generator): python-pptx and markitdown (text
# extraction for its QA step). markitdown pulls magika/onnxruntime wheels; all manylinux.
RUN pip install --break-system-packages --no-cache-dir \
    python-pptx==1.0.2 "markitdown[pptx]==0.1.8"

# ── pptx-generator runtime ───────────────────────────────────────
# PptxGenJS (pinned, with the upstream chart fixes #1531/#1537/#1540 applied from
# pptx/runtime/patches), react-icons, sharp: what the Muse's native-PowerPoint skill requires.
# install.sh is the same script the pipeline test runs. Containers cannot install at runtime, so
# this is the only place these libraries come from. Built on Ubuntu so sharp's prebuilt binaries
# match the final stage's glibc.
FROM ubuntu AS pptx-runtime-builder
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates patch \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
COPY infra/sandboxes/computer/pptx/runtime/ /build/pptx-runtime/
RUN sh /build/pptx-runtime/install.sh /opt/superchat-pptx

# ── Chromium ─────────────────────────────────────────────────────
# Ubuntu's apt `chromium` is a snap stub that cannot run in a container. Playwright's pinned
# Chromium build is used instead (full browser, no headless shell); its shared libraries are
# installed by apt in the final stage. PLAYWRIGHT_DOWNLOAD_HOST empty = Playwright's public CDN.
FROM node-runtime AS chromium-builder
ARG PLAYWRIGHT_VERSION=1.63.0
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ARG PLAYWRIGHT_DOWNLOAD_HOST=
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN if [ -z "${PLAYWRIGHT_DOWNLOAD_HOST}" ]; then unset PLAYWRIGHT_DOWNLOAD_HOST; fi \
 && npx -y "playwright@${PLAYWRIGHT_VERSION}" install --no-shell chromium \
 && chrome="$(ls -d /opt/ms-playwright/chromium-*/chrome-linux*/chrome | head -n 1)" \
 && test -x "$chrome" \
 && ln -s "$chrome" /opt/ms-playwright/chromium

FROM ubuntu
# Dev tools let bots clone repos and fetch artifacts; containers run uid 1000
# with no privilege escalation, so nothing can be installed at runtime.
# Compilers stay in the builder stages. The lib* block is Chromium's runtime set (Playwright's
# ubuntu24.04 list, without its virtual-display and X font tools).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    ca-certificates \
    procps \
    bash \
    imagemagick \
    curl \
    git \
    jq \
    openssh-client \
    unzip \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    libfontconfig1 \
    libfreetype6 \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
  && rm -rf /var/lib/apt/lists/* \
  # The Muse installs its own Python packages with `pip install --user` (PIP_USER=1); PEP 668's
  # marker would refuse that in a container whose system Python nothing else manages.
  && rm -f /usr/lib/python3.12/EXTERNALLY-MANAGED \
  # Ubuntu's image ships an `ubuntu` user at uid 1000; the Computer user takes that uid.
  && if id -u ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
  && groupadd --gid 1000 superchat \
  && useradd --uid 1000 --gid superchat --create-home --shell /bin/bash superchat
ENV MPLBACKEND=Agg
ENV HOME=/home/superchat
WORKDIR /home/superchat
# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 infra/sandboxes/computer/start.sh /usr/local/bin/superchat-computer
# browser_* tools (OMNIGENT_BROWSER_BACKEND=local): superchat-browser starts headless Chromium
# with a debug port, superchat-page-browser drives it over CDP.
COPY --chmod=755 infra/sandboxes/computer/superchat-browser /usr/local/bin/superchat-browser
COPY --chmod=755 infra/sandboxes/computer/superchat-page-browser /usr/local/bin/superchat-page-browser
COPY --chmod=755 infra/sandboxes/computer/superchat-deck-export /usr/local/bin/superchat-deck-export
# Deck export (`deck_export`: editable PPTX + vector PDF). The page-side capture module and the
# vendored dom-to-pptx browser bundle (MIT, v2.0.1; LICENSE kept next to its .gz) are read by
# superchat-deck-export from this directory. The bundle is committed gzipped and expanded here, so the
# repository carries no 3.8 MB script.
COPY --chmod=644 infra/sandboxes/computer/deck-export/deck-capture-page.js /usr/local/share/superchat/deck-export/deck-capture-page.js
COPY --chmod=644 infra/sandboxes/computer/deck-export/vendor/dom-to-pptx/dom-to-pptx.bundle.js.gz /usr/local/share/superchat/deck-export/dom-to-pptx.bundle.js.gz
COPY --chmod=644 infra/sandboxes/computer/deck-export/vendor/dom-to-pptx/LICENSE /usr/local/share/superchat/deck-export/dom-to-pptx.LICENSE
# Dashboards (`superchat-dashboard`): computes a spec's numbers from the person's files with pandas and
# writes one self-contained HTML page. Chart.js is the decks' vendored copy (MIT, LICENSE beside it).
COPY --chmod=755 infra/sandboxes/computer/superchat-dashboard /usr/local/bin/superchat-dashboard
COPY --chmod=644 infra/sandboxes/computer/dashboard/template.html /usr/local/share/superchat/dashboard/template.html
COPY --chmod=644 engine/omnigent/omnigent/superchat/decks/kit/vendor/chart.js/chart.umd.js /usr/local/share/superchat/dashboard/chart.umd.js
COPY --chmod=644 engine/omnigent/omnigent/superchat/decks/kit/vendor/chart.js/LICENSE.md /usr/local/share/superchat/dashboard/chart.js.LICENSE.md
# Login shells source this after /etc/profile resets PATH. The home
# volume hides /etc/skel, so ~/.local/bin has to be restored from the image.
COPY --chmod=644 infra/sandboxes/computer/superchat-local-bin.sh /etc/profile.d/superchat-local-bin.sh
# The Muse's native-PowerPoint skill (MiniMax-AI/skills pptx-generator, MIT, ported): SKILL.md and
# references the prompt tells the Muse to read.
COPY infra/sandboxes/computer/pptx/skill/pptx-generator/ /usr/local/share/superchat/skills/pptx-generator/

# Headless Chromium: `chromium` on PATH is what superchat-browser, superchat-deck-export and the
# dashboard PDF (through superchat-deck-export) look up.
COPY --from=chromium-builder /opt/ms-playwright /opt/ms-playwright
RUN ln -s /opt/ms-playwright/chromium /usr/local/bin/chromium \
 && if ldd /opt/ms-playwright/chromium | grep 'not found'; then exit 1; fi

# ── Omnigent runner + the Claude Code CLI ──────────────────────────
# Lets the Superchat "computer" sandbox launcher (docs/omnigent-spike.md,
# engine/omnigent/omnigent/onboarding/sandboxes/computer.py) exec `omnigent host` in this image.
# Installed OUTSIDE /home/superchat on purpose: that path is a per-Muse volume mount (empty on first
# run), so anything baked into the image's own copy of it would never actually be there at
# runtime — see engine/omnigent/deploy/docker/Dockerfile's host target for the same pattern.
COPY --from=omnigent-builder /opt/venv /opt/venv
COPY --from=omnigent-builder /opt/uv/bin/uv /usr/local/bin/uv
COPY --from=python-data /usr/local/lib/python3.12/dist-packages /usr/local/lib/python3.12/dist-packages
COPY --from=python-data /usr/local/bin /usr/local/bin
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
# Fixed prefix on NODE_PATH: `require('pptxgenjs')` works from any script the Muse writes.
COPY --from=pptx-runtime-builder /opt/superchat-pptx/node_modules /opt/superchat-pptx/node_modules
ENV NODE_PATH=/opt/superchat-pptx/node_modules
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 # Claude Code CLI: the superchat-claude harness's claude-agent-sdk shells out to this binary to run
 # the Muse's turns. Major-pinned (not "latest") since this image is rebuilt manually, not by
 # CI on every main commit — an unpinned install could jump a breaking major between builds.
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2 \
 # Pi coding agent CLI: the `pi` harness (SUPERCHAT_MUSE_HARNESS=pi, bundle superchat-pi) spawns `pi --mode rpc`.
 # Exact-pinned to the version verified on the host (needs Node >= 22.19).
 && npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@0.87.1 \
 && npm cache clean --force \
 # /usr/local/bin is the only directory on the sandbox supervisor's fixed exec PATH
 # (infra/sandboxes/supervisor/src/index.ts) outside of $HOME, so the venv's entry point is
 # symlinked in rather than requiring a PATH change there.
 && ln -s /opt/venv/bin/omnigent /usr/local/bin/omnigent

# Strip CR so shebangs work even if the build context came from a CRLF checkout.
# COPY --chmod=644 also gives the directory it creates mode 644 (no search bit).
RUN chmod 755 /usr/local/share/superchat /usr/local/share/superchat/deck-export /usr/local/share/superchat/dashboard \
  && chmod -R a+rX /usr/local/share/superchat/skills /opt/superchat-pptx \
  && gzip -dc /usr/local/share/superchat/deck-export/dom-to-pptx.bundle.js.gz > /usr/local/share/superchat/deck-export/dom-to-pptx.bundle.js \
  && chmod 644 /usr/local/share/superchat/deck-export/dom-to-pptx.bundle.js \
  && sed -i 's/\r$//' /usr/local/bin/superchat-computer /usr/local/bin/superchat-browser /usr/local/bin/superchat-page-browser /usr/local/bin/superchat-deck-export /usr/local/bin/superchat-dashboard \
    /etc/profile.d/superchat-local-bin.sh
USER 1000:1000
CMD ["/usr/local/bin/superchat-computer"]
