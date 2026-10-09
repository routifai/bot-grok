# Build context is the repo root (not this directory) so the omnigent-builder stage below can
# vendor engine/omnigent — see infra/compose/docker-compose.yml, scripts/setup.sh, and the CI
# validate matrix in .github/workflows/publish-server-image.yml. Every other COPY in this file is
# therefore prefixed infra/sandboxes/computer/ except where noted.
#
# ARGs used in a FROM must be declared before the FIRST FROM in the file to stay in scope for it.
ARG OMNIGENT_PYTHON_VERSION=3.12
ARG OMNIGENT_NODE_VERSION=22

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS capture-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libx11-dev \
    libxdamage-dev \
    libxext-dev \
    libxfixes-dev \
    libxtst-dev \
    libpng-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY infra/sandboxes/computer/xcapture.c .
RUN cc -O3 -fPIC -shared -Wall -Wextra -Werror -o libnova-xcapture.so xcapture.c \
    -lX11 -lXext -lXdamage -lXfixes -lXtst -lpng

# ── Omnigent runner builder ──────────────────────────────────────
# Installs the vendored engine/omnigent package (the Nova "computer" runner launcher —
# docs/omnigent-spike.md — execs `omnigent host` in this image) into a standalone venv the final
# stage copies out, mirroring engine/omnigent/deploy/docker/Dockerfile's own builder stage. Kept
# separate from that Dockerfile (rather than building `--target host` and copying from it) so this
# image's own base/build-arg choices don't have to track omnigent's — the recipe is intentionally
# duplicated in miniature, not shared. Pinned to the "-bookworm" variant (not the generic
# "-slim", which currently tracks Debian trixie) so the venv this stage produces is binary-
# compatible with the bookworm-slim base the final stage below uses — a venv's `bin/python` is a
# symlink into the interpreter that created it, which must still exist at runtime.
FROM python:${OMNIGENT_PYTHON_VERSION}-slim-bookworm AS omnigent-builder
ARG PYPI_INDEX_URL=https://pypi.org/simple
ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --index-url ${PYPI_INDEX_URL} --no-cache-dir uv
WORKDIR /build
COPY engine/omnigent/pyproject.toml engine/omnigent/setup.py engine/omnigent/uv.lock ./
COPY engine/omnigent/LICENSE engine/omnigent/NOTICE ./
COPY engine/omnigent/sdks/ ./sdks/
COPY engine/omnigent/omnigent/ ./omnigent/
# Standalone venv copied out whole; UV_PROJECT_ENVIRONMENT points `uv sync` at it directly.
RUN python -m venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:${PATH}"
# Frozen (--frozen) so the sandbox always gets exactly the dependency set the committed
# lockfile pins, never a fresh, unconstrained resolve; non-editable (--no-editable) so the
# install is self-contained bytes in /opt/venv — the final stage copies only that, no /build
# .pth files pointing back into a directory it would otherwise have to carry too.
RUN uv sync --frozen --no-editable --no-dev --index-url ${PYPI_INDEX_URL}
# Data stack for the agent's shell: `python3` there is /usr/local/bin/python3 (this builder's
# system interpreter, copied into the final stage whole with /usr/local/lib/python3.12), not the
# /opt/venv one, so install into it.
# All manylinux wheels: no compiler needed. Agg keeps matplotlib headless.
RUN /usr/local/bin/python3 -m pip install --index-url ${PYPI_INDEX_URL} --no-cache-dir \
    pandas==2.2.3 openpyxl==3.1.5 xlsxwriter==3.2.0 matplotlib==3.9.2 duckdb==1.1.3

# Pure alias so the final stage can COPY node out of a version-pinned image without a build arg
# inside a COPY --from (which cannot expand them).
FROM node:${OMNIGENT_NODE_VERSION}-slim AS node-runtime

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
# Dev tools let bots clone repos and fetch artifacts; containers run uid 1000
# with no privilege escalation, so nothing can be installed at runtime.
# Compilers stay in the builder stage; heavier toolchains are a separate call.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    xterm \
    xdotool \
    x11-utils \
    x11-xserver-utils \
    imagemagick \
    novnc \
    websockify \
    python3 \
    ca-certificates \
    procps \
    bash \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    dbus-x11 \
    xdg-utils \
    curl \
    git \
    jq \
    openssh-client \
    unzip \
  && rm -rf /var/lib/apt/lists/* \
  # Debian's novnc package creates an unused `nova` system account (from OpenStack Nova)
  # that owns no files; drop it so the Computer user can take the name.
  && if id -u nova >/dev/null 2>&1; then userdel nova; fi \
  && if getent group nova >/dev/null; then groupdel nova; fi \
  && groupadd --gid 1000 nova \
  && useradd --uid 1000 --gid nova --create-home --shell /bin/bash nova \
  && mkdir -p /etc/nova/fluxbox \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage
ENV DISPLAY=:1
ENV MPLBACKEND=Agg
ENV HOME=/home/nova
WORKDIR /home/nova
# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 infra/sandboxes/computer/start.sh /usr/local/bin/nova-computer
COPY --chmod=755 infra/sandboxes/computer/control.py /usr/local/bin/nova-computer-control
COPY --from=capture-builder /build/libnova-xcapture.so /usr/local/lib/libnova-xcapture.so
COPY --chmod=755 infra/sandboxes/computer/nova-browser /usr/local/bin/nova-browser
COPY --chmod=755 infra/sandboxes/computer/nova-page-browser /usr/local/bin/nova-page-browser
COPY --chmod=755 infra/sandboxes/computer/nova-recorder /usr/local/bin/nova-recorder
COPY --chmod=644 infra/sandboxes/computer/nova-recorder.js /usr/local/share/nova/nova-recorder.js
COPY --chmod=644 infra/sandboxes/computer/nova-browser.desktop /usr/share/applications/nova-browser.desktop
COPY --chmod=644 infra/sandboxes/computer/fluxbox.init /etc/nova/fluxbox/init
COPY --chmod=644 infra/sandboxes/computer/fluxbox.apps /etc/nova/fluxbox/apps
COPY --chmod=644 infra/sandboxes/computer/fluxbox.menu /etc/nova/fluxbox/menu
COPY --chmod=644 infra/sandboxes/computer/embed.html /usr/share/novnc/embed.html
COPY --chmod=644 infra/sandboxes/computer/clipboard-bridge.js /usr/share/novnc/clipboard-bridge.js
COPY --chmod=644 infra/sandboxes/computer/mobile-keyboard.js /usr/share/novnc/mobile-keyboard.js
# Login shells source this after Debian's /etc/profile resets PATH. The home
# volume hides /etc/skel, so ~/.local/bin has to be restored from the image.
COPY --chmod=644 infra/sandboxes/computer/nova-local-bin.sh /etc/profile.d/nova-local-bin.sh

# ── Omnigent runner + the Claude Code CLI ──────────────────────────
# Lets the Nova "computer" sandbox launcher (docs/omnigent-spike.md,
# engine/omnigent/omnigent/onboarding/sandboxes/computer.py) exec `omnigent host` in this image.
# Installed OUTSIDE /home/nova on purpose: that path is a per-Muse volume mount (empty on first
# run), so anything baked into the image's own copy of it would never actually be there at
# runtime — see engine/omnigent/deploy/docker/Dockerfile's host target for the same pattern.
#
# The venv's bin/python is a symlink chain ending at the exact interpreter path that created it
# (/usr/local/bin/python3.12 in the -slim-bookworm builder); this debian:bookworm-slim base has no
# Python 3.12 of its own (bookworm's apt python3 is 3.11, and omnigent requires >=3.12), so that
# interpreter — and the shared library and stdlib it needs to run at all — has to come along too.
COPY --from=omnigent-builder /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=omnigent-builder /usr/local/bin/python3 /usr/local/bin/python3
COPY --from=omnigent-builder /usr/local/bin/python /usr/local/bin/python
COPY --from=omnigent-builder /usr/local/lib/libpython3.12.so.1.0 /usr/local/lib/libpython3.12.so.1.0
COPY --from=omnigent-builder /usr/local/lib/libpython3.12.so /usr/local/lib/libpython3.12.so
COPY --from=omnigent-builder /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=omnigent-builder /opt/venv /opt/venv
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 # Claude Code CLI: the nova-claude harness's claude-agent-sdk shells out to this binary to run
 # the Muse's turns. Major-pinned (not "latest") since this image is rebuilt manually, not by
 # CI on every main commit — an unpinned install could jump a breaking major between builds.
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2 \
 # Pi coding agent CLI: the `pi` harness (NOVA_MUSE_HARNESS=pi, bundle nova-pi) spawns `pi --mode rpc`.
 # Exact-pinned to the version verified on the host (needs Node >= 22.19).
 && npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@0.87.1 \
 # /usr/local/bin is the only directory on the sandbox supervisor's fixed exec PATH
 # (infra/sandboxes/supervisor/src/index.ts) outside of $HOME, so the venv's entry points are
 # symlinked in rather than requiring a PATH change there.
 && ln -s /opt/venv/bin/omnigent /usr/local/bin/omnigent \
 && ln -s /opt/venv/bin/uv /usr/local/bin/uv

# Strip CR so shebangs work even if the build context came from a CRLF checkout.
# COPY --chmod=644 also gives the directory it creates mode 644 (no search bit), which left
# the recorder's page script unreadable to USER 1000.
RUN ldconfig \
  && chmod 755 /usr/local/share/nova \
  && sed -i 's/\r$//' /usr/local/bin/nova-computer /usr/local/bin/nova-computer-control /usr/local/bin/nova-browser /usr/local/bin/nova-page-browser /usr/local/bin/nova-recorder \
    /etc/nova/fluxbox/init /etc/nova/fluxbox/apps /etc/nova/fluxbox/menu \
    /etc/profile.d/nova-local-bin.sh
EXPOSE 7070 6080 6081 6082 6083 6084 6085 6086 6087 6088 6089 6090 6091 6092 6093 6094 6095
USER 1000:1000
CMD ["/usr/local/bin/nova-computer"]
