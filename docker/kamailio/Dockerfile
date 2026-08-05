# Kamailio SBC - Front-end security and rate limiting
# Production-ready configuration for high-volume voice platform
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install Kamailio 5.8.x from official repos
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg2 \
    wget \
    ca-certificates \
    curl \
    iproute2 \
    && wget -O- https://deb.kamailio.org/kamailiodebkey.gpg | gpg --dearmor > /usr/share/keyrings/kamailio.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio58 bookworm main" > /etc/apt/sources.list.d/kamailio.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    # Core Kamailio
    kamailio \
    # TLS support
    kamailio-tls-modules \
    # Redis for distributed rate limiting
    kamailio-redis-modules \
    # JSON handling
    kamailio-json-modules \
    # STIR/SHAKEN — secsipid.so + secsipid_proc.so (pulls libsecsipid1
    # transitively). secsipid.so auto-loads secsipid_proc.so in its child-init
    # callback (do NOT `loadmodule secsipid_proc.so`); the package only needs to
    # be on disk. Signing (Identity/PASSporT) is env-gated OFF by default —
    # see kamailio.cfg STIR_SHAKEN_SIGN + route[TO_CARRIER].
    kamailio-secsipid-modules \
    # Utils (pike, htable, etc)
    kamailio-utils-modules \
    # Extra modules (uac, dialog, etc)
    kamailio-extra-modules \
    # Presence (if needed for SUBSCRIBE)
    kamailio-presence-modules \
    # XML operations
    kamailio-xml-modules \
    # PostgreSQL database support (for trunk IP auth, sqlops queries)
    kamailio-postgres-modules \
    # Outbound module for NAT
    kamailio-outbound-modules \
    # Websocket (if WebRTC needed later)
    kamailio-websocket-modules \
    # NOTE: xhttp_prom (the Prometheus /metrics exporter used on :8080) is ALREADY
    # provided by the installed kamailio packages above — there is NO separate
    # "kamailio-prometheus-modules" package in the 5.8 repo. Do not re-add one.
    # Cleanup
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Create required directories
RUN mkdir -p /run/kamailio \
    && mkdir -p /var/log/kamailio \
    && mkdir -p /etc/kamailio/tls \
    # STIR/SHAKEN secsipid on-disk x5u cert cache (secsipid modparam cache_dir).
    # Owned by the kamailio user because Kamailio drops privileges to it (-u/-g).
    # Only written by the future verify path (Phase 2B); signing needs no fetch,
    # but the dir must exist so cache_dir is valid at load time.
    && mkdir -p /var/lib/kamailio/secsipid_cache \
    && chown -R kamailio:kamailio /run/kamailio /var/log/kamailio /etc/kamailio /var/lib/kamailio

# Copy configuration templates (entrypoint.sh will template these at startup)
COPY kamailio.cfg /etc/kamailio/kamailio.cfg.tmpl
COPY dispatcher.list /etc/kamailio/dispatcher.list.tmpl

# Copy and install entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Create TLS configuration file (will use self-signed certs for dev)
RUN echo '[server:default]' > /etc/kamailio/tls.cfg && \
    echo 'method = TLSv1.2+' >> /etc/kamailio/tls.cfg && \
    echo 'verify_certificate = no' >> /etc/kamailio/tls.cfg && \
    echo 'require_certificate = no' >> /etc/kamailio/tls.cfg && \
    echo 'private_key = /etc/kamailio/tls/kamailio.key' >> /etc/kamailio/tls.cfg && \
    echo 'certificate = /etc/kamailio/tls/kamailio.crt' >> /etc/kamailio/tls.cfg && \
    echo '' >> /etc/kamailio/tls.cfg && \
    echo '[client:default]' >> /etc/kamailio/tls.cfg && \
    echo 'method = TLSv1.2+' >> /etc/kamailio/tls.cfg && \
    echo 'verify_certificate = no' >> /etc/kamailio/tls.cfg

# Generate self-signed certificate for development
RUN openssl req -x509 -newkey rsa:4096 -keyout /etc/kamailio/tls/kamailio.key \
    -out /etc/kamailio/tls/kamailio.crt -days 365 -nodes \
    -subj "/C=US/ST=State/L=City/O=VoicePlatform/OU=SBC/CN=sbc.voiceplatform.local" \
    && chmod 600 /etc/kamailio/tls/kamailio.key \
    && chown kamailio:kamailio /etc/kamailio/tls/*

# Config validation skipped — config is templated at runtime by entrypoint.sh
# RUN kamailio -c /etc/kamailio/kamailio.cfg || echo "Config validation skipped (modules not available in build)"

# SIP ports: 5060 (UDP/TCP), 5061 (TLS)
EXPOSE 5060/udp 5060/tcp 5061/tcp
# Prometheus metrics scrape endpoint (xhttp_prom listener — see kamailio.cfg).
# Documentation only; the listener binds SBC_INTERNAL_IP:8080 + 127.0.0.1:8080
# on the host network (network_mode: host), so this EXPOSE is informational.
EXPOSE 8080/tcp

# Health check using kamcmd over the ctl binrpc UNIX socket.
# -s pins the socket path (matches the ctl "binrpc" modparam in kamailio.cfg and
# kamcmd's compiled-in default /var/run/kamailio/kamailio_ctl; /var/run -> /run).
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD kamcmd -s unix:/var/run/kamailio/kamailio_ctl core.uptime || exit 1

# Run the entrypoint as root so it can add the NLB VIP to loopback
# (`ip addr add` needs root even with NET_ADMIN). Kamailio itself does NOT run as
# root: it drops to the kamailio user/group via the -u/-g CMD flags below, so the
# SIP worker processes are unprivileged exactly as before (when USER kamailio was
# set here). See entrypoint.sh for the loopback rationale.
USER root

# Entrypoint templates the config, adds the NLB VIP to loopback, then exec's
# kamailio with CMD args
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Start Kamailio in foreground with debug output
# -DD = don't daemonize, dump core on crash
# -E = log to stderr
# -u/-g = drop privileges to the kamailio user/group (entrypoint runs as root for
#         the loopback VIP add; Kamailio's workers must not stay root)
CMD ["-DD", "-E", "-f", "/etc/kamailio/kamailio.cfg", "-M", "512", "-m", "16", "-u", "kamailio", "-g", "kamailio"]
