#!/usr/bin/env bash
# Sets up a fresh Ubuntu VPS as the Computers host (supervisor + Computer image + Caddy), from
# your machine, over SSH. Safe to re-run: every step checks what is already there.
#
#   SANDBOX_SUPERVISOR_TOKEN=<token> infra/compose/setup-computers-vps.sh <vps-ip> [first-user]
#
# - first-user: the account the provider created with your SSH key (OVH: ubuntu). Used once to
#   create the `deploy` user; afterwards only `deploy` may log in (key only, no root, no passwords).
# - The token must equal the engine's OMNIGENT_COMPUTER_SUPERVISOR_TOKEN.
# - COMPUTERS_HOST defaults to <ip-with-dashes>.sslip.io, so no domain is needed for a test.
# - The source shipped is `git archive HEAD` of this checkout; uncommitted changes are not sent.
# Guide: docs/deploy-split.md.
set -Eeuo pipefail

IP="${1:?Usage: SANDBOX_SUPERVISOR_TOKEN=<token> $0 <vps-ip> [first-user]}"
FIRST_USER="${2:-ubuntu}"
DEPLOY_USER=deploy
: "${SANDBOX_SUPERVISOR_TOKEN:?Set SANDBOX_SUPERVISOR_TOKEN (same value as the engine OMNIGENT_COMPUTER_SUPERVISOR_TOKEN)}"
COMPUTERS_HOST="${COMPUTERS_HOST:-${IP//./-}.sslip.io}"
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
# One shared connection per user for the whole run: many short logins in a row trip the
# firewall's SSH rate limit and fail2ban.
CONTROL_DIR="$(mktemp -d)"
close_ssh() {
  for u in "${FIRST_USER}" "${DEPLOY_USER}"; do
    ssh -O exit -o "ControlPath=${CONTROL_DIR}/%r" "${u}@${IP}" 2>/dev/null || true
  done
  rm -rf "${CONTROL_DIR}"
}
trap close_ssh EXIT
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=15
  -o ControlMaster=auto -o ControlPersist=10m -o "ControlPath=${CONTROL_DIR}/%r")

# Remote scripts, run with sudo on the VPS.
read -r -d '' CREATE_DEPLOY_USER <<'REMOTE' || true
set -Eeuo pipefail
user="$1"
if ! id "$user" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$user"
fi
install -d -m 700 -o "$user" -g "$user" "/home/$user/.ssh"
src="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)/.ssh/authorized_keys"
install -m 600 -o "$user" -g "$user" "$src" "/home/$user/.ssh/authorized_keys"
# Key-only account with no password, so sudo must not ask for one.
echo "$user ALL=(ALL) NOPASSWD:ALL" >"/etc/sudoers.d/90-$user"
chmod 440 "/etc/sudoers.d/90-$user"
visudo -cf "/etc/sudoers.d/90-$user"
REMOTE

read -r -d '' SWAP_AND_DOCKER <<'REMOTE' || true
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
# Small VMs: swap keeps the image build and a busy Computer from being OOM-killed.
if ! swapon --show=NAME --noheadings | grep -q . && [ "$(awk '/MemTotal/{print int($2/1048576)}' /proc/meminfo)" -lt 8 ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo "4G swap added"
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" >/etc/apt/sources.list.d/docker.list
  if apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin; then
    echo "Docker installed from Docker's repository"
  else
    # A brand-new Ubuntu release can be missing from Docker's repository for a while.
    rm -f /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker.io docker-compose-v2 docker-buildx
    echo "Docker installed from Ubuntu's repository"
  fi
fi
REMOTE

step() { printf '\n==> %s\n' "$*"; }
# Arguments are remote commands; they expand on the VPS on purpose.
# shellcheck disable=SC2029
as_deploy() { ssh "${SSH_OPTS[@]}" "${DEPLOY_USER}@${IP}" "$@"; }

step "1/6 Deploy user, swap and Docker (as ${FIRST_USER}, skipped if deploy already works)"
if as_deploy true 2>/dev/null; then
  echo "deploy can already log in"
else
  ssh "${SSH_OPTS[@]}" "${FIRST_USER}@${IP}" sudo bash -s -- "${DEPLOY_USER}" <<<"${CREATE_DEPLOY_USER}"
  as_deploy true
  echo "deploy can log in"
fi

as_deploy sudo bash -s <<<"${SWAP_AND_DOCKER}"
as_deploy sudo docker compose version

step "2/6 Ship the source (git archive HEAD)"
git -C "${REPO_ROOT}" archive --format=tar HEAD | gzip -1 | as_deploy \
  'set -e; rm -rf ~/nova.new; mkdir ~/nova.new; tar -xzf - -C ~/nova.new; rm -rf ~/nova.old; if [ -d ~/nova ]; then mv ~/nova ~/nova.old; fi; mv ~/nova.new ~/nova; rm -rf ~/nova.old'
echo "shipped $(git -C "${REPO_ROOT}" rev-parse --short HEAD)"

step "3/6 Docker daemon defaults and host hardening (SSH key only, firewall: 22, 80, 443)"
as_deploy 'sudo install -m 644 ~/nova/infra/compose/docker-daemon.json /etc/docker/daemon.json && sudo systemctl restart docker'
# Never ban the machine running this setup (its address as the VPS sees it).
# shellcheck disable=SC2016 # SSH_CONNECTION is read on the VPS.
admin_ip="$(as_deploy 'echo "${SSH_CONNECTION%% *}"')"
as_deploy "sudo DEPLOY_USER=${DEPLOY_USER} FAIL2BAN_IGNORE_IP=${admin_ip} bash ~/nova/infra/compose/harden-host.sh"
as_deploy true
echo "fresh SSH session as deploy works after hardening"

step "4/6 Write ~/nova/.env.computers (token sent over SSH, not on the command line)"
cpus="$(as_deploy nproc)"
# DOCKER_GID is read on the VPS, hence the single quotes below.
# shellcheck disable=SC2016
{
  echo "COMPUTERS_HOST=${COMPUTERS_HOST}"
  echo "SANDBOX_SUPERVISOR_TOKEN=${SANDBOX_SUPERVISOR_TOKEN}"
  echo "NOVA_COMPUTER_MEMORY=${NOVA_COMPUTER_MEMORY:-2g}"
  echo "NOVA_COMPUTER_CPUS=${NOVA_COMPUTER_CPUS:-${cpus}}"
  echo "NOVA_COMPUTER_PIDS_LIMIT=${NOVA_COMPUTER_PIDS_LIMIT:-2048}"
} | as_deploy 'umask 077; cat >~/nova/.env.computers; echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >>~/nova/.env.computers'

step "5/6 Build and start (the Computer image takes a while the first time)"
# Caddy bind-mounts its config from ~/nova, which step 2 replaces with a fresh copy; recreate it
# so it reads the new file instead of the old, deleted one.
as_deploy 'cd ~/nova && sudo docker compose --env-file .env.computers -f infra/compose/docker-compose.computers.yml up -d --build && sudo docker compose --env-file .env.computers -f infra/compose/docker-compose.computers.yml up -d --force-recreate caddy && sudo docker builder prune -f >/dev/null'

step "6/6 Check https://${COMPUTERS_HOST}"
for _ in $(seq 1 30); do
  if curl -fsS "https://${COMPUTERS_HOST}/health" >/dev/null 2>&1; then break; fi
  sleep 5
done
curl -fsS "https://${COMPUTERS_HOST}/health" && echo
code="$(curl -s -o /dev/null -w '%{http_code}' "https://${COMPUTERS_HOST}/computers")"
if [ "${code}" != 401 ]; then
  echo "Expected 401 from /computers without a token, got ${code}" >&2
  exit 1
fi
echo "/computers refuses requests without the token (401)"
echo
echo "Done. Set the engine's OMNIGENT_COMPUTER_SUPERVISOR_URL to https://${COMPUTERS_HOST}"
