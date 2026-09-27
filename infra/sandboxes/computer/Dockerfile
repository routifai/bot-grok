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
COPY xcapture.c .
RUN cc -O3 -fPIC -shared -Wall -Wextra -Werror -o libaiden-xcapture.so xcapture.c \
    -lX11 -lXext -lXdamage -lXfixes -lXtst -lpng

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
  && groupadd --gid 1000 aiden \
  && useradd --uid 1000 --gid aiden --create-home --shell /bin/bash aiden \
  && mkdir -p /etc/aiden/fluxbox \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage
ENV DISPLAY=:1
ENV HOME=/home/aiden
WORKDIR /home/aiden
# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 start.sh /usr/local/bin/aiden-computer
COPY --chmod=755 control.py /usr/local/bin/aiden-computer-control
COPY --from=capture-builder /build/libaiden-xcapture.so /usr/local/lib/libaiden-xcapture.so
COPY --chmod=755 aiden-browser /usr/local/bin/aiden-browser
COPY --chmod=755 aiden-page-browser /usr/local/bin/aiden-page-browser
COPY --chmod=644 aiden-browser.desktop /usr/share/applications/aiden-browser.desktop
COPY --chmod=644 fluxbox.init /etc/aiden/fluxbox/init
COPY --chmod=644 fluxbox.apps /etc/aiden/fluxbox/apps
COPY --chmod=644 fluxbox.menu /etc/aiden/fluxbox/menu
COPY --chmod=644 embed.html /usr/share/novnc/embed.html
COPY --chmod=644 clipboard-bridge.js /usr/share/novnc/clipboard-bridge.js
COPY --chmod=644 mobile-keyboard.js /usr/share/novnc/mobile-keyboard.js
# Login shells source this after Debian's /etc/profile resets PATH. The home
# volume hides /etc/skel, so ~/.local/bin has to be restored from the image.
COPY --chmod=644 aiden-local-bin.sh /etc/profile.d/aiden-local-bin.sh
# Strip CR so shebangs work even if the build context came from a CRLF checkout.
RUN ldconfig \
  && sed -i 's/\r$//' /usr/local/bin/aiden-computer /usr/local/bin/aiden-computer-control /usr/local/bin/aiden-browser /usr/local/bin/aiden-page-browser \
    /etc/aiden/fluxbox/init /etc/aiden/fluxbox/apps /etc/aiden/fluxbox/menu \
    /etc/profile.d/aiden-local-bin.sh
EXPOSE 7070 6080 6081 6082 6083 6084 6085 6086 6087 6088 6089 6090 6091 6092 6093 6094 6095
USER 1000:1000
CMD ["/usr/local/bin/aiden-computer"]
