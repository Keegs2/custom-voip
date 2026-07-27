# revup-ops-agent — carrier poller + read-only NOC command API (single image).
#
# This image serves TWO roles from one process (ops_agent.py):
#   1. The carrier-status poller (unchanged from PR #8): reads Kamailio's LIVE
#      dispatcher state over the shared `ctl` binrpc UNIX socket (via
#      `kamcmd dispatcher.list`) and POSTs a per-carrier up/down snapshot.
#   2. A small, allow-listed, READ-ONLY HTTP command API (default :8710) the
#      ted-next NOC console uses for reads (kamcmd / FreeSWITCH ESL / docker /
#      git / journalctl — all fixed argv, shell=False, role-gated).
#
# It runs on EVERY VM type (SBC / FreeSWITCH / services); role is auto-detected
# (or forced via OPS_AGENT_ROLE) and only that role's commands are exposed.
#
# Base: python:3.12-slim-bookworm — same Debian release (bookworm) as the
# Kamailio SBC image, so `kamcmd` installed from the official Kamailio 5.8 repo
# is version-matched to the Kamailio the agent talks to. App deps are stdlib +
# `requests` only (the HTTP API is stdlib http.server — no new runtime dep).
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# System deps for the agent's command surface:
#   - kamcmd     : from the official Kamailio 5.8 apt repo (same repo + release
#                  the SBC Dockerfile uses); the `kamailio` package provides
#                  /usr/sbin/kamcmd (no lighter split package exists). Used by the
#                  SBC role AND the carrier poller — both talk to the ctl socket.
#   - docker-cli : `docker ps` / `docker logs` for host.docker_ps/docker_logs.
#                  CLI ONLY (no engine). The agent talks to the host Docker daemon
#                  via the mounted /var/run/docker.sock (read-only in compose).
#   - git        : host.git_head (`git -C /opt/revup rev-parse HEAD` + log). The
#                  repo is bind-mounted read-only in compose.
#   - iproute2   : nothing here needs it; NOT installed (the agent opens no sockets
#                  it must configure — it only reads).
# gnupg2/wget/ca-certificates are needed only to add the two apt repo keys and are
# removed afterwards. FreeSWITCH ESL (fs role) uses stdlib sockets — no fs binary
# needed in this image (fs role is selected via OPS_AGENT_ROLE=fs on the FS VMs).
# `requests` (poller HTTP POST) is installed via pip; the command API is stdlib.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gnupg2 wget ca-certificates git \
    && wget -O- https://deb.kamailio.org/kamailiodebkey.gpg | gpg --dearmor > /usr/share/keyrings/kamailio.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio58 bookworm main" > /etc/apt/sources.list.d/kamailio.list \
    && wget -O- https://download.docker.com/linux/debian/gpg | gpg --dearmor > /usr/share/keyrings/docker.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends kamailio docker-ce-cli \
    && pip install --no-cache-dir "requests>=2.31,<3" \
    && apt-get purge -y --auto-remove gnupg2 wget \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Verify the command-surface binaries are present at build time (fail early if a
# package layout ever changes). kamcmd is used by the poller + SBC role; docker +
# git back the host.* commands. (journalctl is optional/best-effort at runtime.)
RUN command -v kamcmd >/dev/null 2>&1 || (echo "kamcmd not found in image" && exit 1) \
    && command -v docker >/dev/null 2>&1 || (echo "docker cli not found in image" && exit 1) \
    && command -v git >/dev/null 2>&1 || (echo "git not found in image" && exit 1)

# The agent is a handful of small stdlib modules copied side-by-side. ops_agent.py
# is the entrypoint; it imports carrier_monitor (UNCHANGED poller) + ops_api +
# ops_commands + ops_esl. carrier_monitor.py is copied verbatim (byte-for-byte the
# PR #8 poller) and can still be run standalone for a poller-only deployment.
COPY carrier_monitor.py /usr/local/bin/carrier_monitor.py
COPY ops_agent.py /usr/local/bin/ops_agent.py
COPY ops_api.py /usr/local/bin/ops_api.py
COPY ops_commands.py /usr/local/bin/ops_commands.py
COPY ops_esl.py /usr/local/bin/ops_esl.py
RUN chmod +x /usr/local/bin/carrier_monitor.py /usr/local/bin/ops_agent.py

# Byte-compile at build time — surfaces any syntax error in the image build, and
# warms .pyc so first request is fast. (WORKDIR so bare `import ops_api` resolves.)
WORKDIR /usr/local/bin
RUN python3 -m py_compile carrier_monitor.py ops_agent.py ops_api.py ops_commands.py ops_esl.py

# Runs as root — deliberately. Two reasons, both necessary and low-risk here:
#   1. The Kamailio `ctl` binrpc socket is mode 0600 owned by the `kamailio` user
#      (ctl module default); root is the only way a separate container reads it
#      without editing kamailio.cfg or coordinating a shared GID across two
#      independently-built images. This mirrors the Kamailio healthcheck exactly.
#   2. host.docker_ps/docker_logs talk to the host Docker daemon via the mounted
#      docker.sock, which is root:docker; root can use it directly.
# The command API is READ-ONLY and allow-listed (no shell, fixed argv, role-gated,
# fail-closed bearer auth) and is meant to sit behind a VPC firewall rule that
# only permits the console host — see the compose files + .env examples.

# The read-only command API listens on OPS_AGENT_PORT (default 8710). EXPOSE is
# documentation only; on the SBC/services VMs the container publishes the port,
# and on the FS VM it uses host networking (see the three compose files).
EXPOSE 8710

ENTRYPOINT ["python3", "/usr/local/bin/ops_agent.py"]
