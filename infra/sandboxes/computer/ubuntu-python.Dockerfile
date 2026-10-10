# syntax=docker/dockerfile:1.7
# Plain Ubuntu with the distro's Python: the base Omnigent's runner (`host`) image is built on for
# the Computer (compose passes it as PYTHON_IMAGE). Point UBUNTU_IMAGE at a registry mirror if needed.
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
FROM ${UBUNTU_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Optional company CA (build secret `ca_bundle`, a PEM file). Without the secret this is a no-op.
RUN --mount=type=secret,id=ca_bundle,target=/usr/local/share/ca-certificates/ca_bundle.crt,required=false \
    if [ -s /usr/local/share/ca-certificates/ca_bundle.crt ]; then update-ca-certificates; fi
# `python` as Omnigent's Dockerfile calls it; pip may install into the system Python (the image is
# the Computer's own, not a shared host).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip python-is-python3 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED
