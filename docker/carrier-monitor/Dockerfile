# Carrier-trunk connectivity monitor — SBC sidecar.
#
# Small, self-contained sidecar that reads Kamailio's LIVE dispatcher state over
# the shared `ctl` binrpc UNIX socket (via `kamcmd dispatcher.list`) and POSTs a
# per-carrier up/down snapshot to the central API. Runs on every SBC VM
# alongside the `kamailio` service (docker-compose.sbc.yml).
#
# Base: python:3.12-slim-bookworm — same Debian release (bookworm) as the
# Kamailio SBC image, so `kamcmd` installed from the official Kamailio 5.8 repo
# is version-matched to the Kamailio the sidecar talks to. Python 3 + requests
# are the only app deps (kept intentionally minimal).
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install kamcmd from the official Kamailio 5.8 apt repo (same repo + release
# the SBC Dockerfile uses). The `kamailio` package provides /usr/sbin/kamcmd;
# there is no lighter split package for it. gnupg2/wget/ca-certificates are
# only needed to add the repo key and are removed afterwards to keep the image
# small. `requests` is installed via pip (no system HTTP deps needed).
RUN apt-get update \
    && apt-get install -y --no-install-recommends gnupg2 wget ca-certificates \
    && wget -O- https://deb.kamailio.org/kamailiodebkey.gpg | gpg --dearmor > /usr/share/keyrings/kamailio.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio58 bookworm main" > /etc/apt/sources.list.d/kamailio.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends kamailio \
    && pip install --no-cache-dir "requests>=2.31,<3" \
    && apt-get purge -y --auto-remove gnupg2 wget \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Verify kamcmd is present at build time (fail the build early if the package
# layout ever changes) — the whole sidecar is useless without it.
RUN command -v kamcmd >/dev/null 2>&1 || (echo "kamcmd not found in image" && exit 1)

COPY carrier_monitor.py /usr/local/bin/carrier_monitor.py
RUN chmod +x /usr/local/bin/carrier_monitor.py

# Runs as root — deliberately, and safely here. The Kamailio `ctl` binrpc socket
# is created mode 0600 owned by the `kamailio` user (ctl module default). The
# ONLY way for a separate container to read it without touching kamailio.cfg or
# coordinating a shared GID across two independently-built images is to connect
# as root (root bypasses the 0600 perms). This mirrors EXACTLY how the existing
# Kamailio container healthcheck reaches the same socket (`docker exec` runs
# `kamcmd` as root). The sidecar is low-risk as root because it opens NO network
# listeners — it only READS a local UNIX socket and makes OUTBOUND HTTPS POSTs.
# (If you prefer an unprivileged sidecar, add `modparam("ctl","mode",0660)` +
# `modparam("ctl","group","<gid>")` to kamailio.cfg and run this container in a
# matching group — a local-control-only change with no SIP-routing impact.)

# No network ports exposed — the sidecar only makes OUTBOUND HTTP POSTs and reads
# a local UNIX socket. It never listens.

ENTRYPOINT ["python3", "/usr/local/bin/carrier_monitor.py"]
