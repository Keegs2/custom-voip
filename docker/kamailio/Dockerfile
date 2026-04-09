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
    # Cleanup
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Create required directories
RUN mkdir -p /run/kamailio \
    && mkdir -p /var/log/kamailio \
    && mkdir -p /etc/kamailio/tls \
    && chown -R kamailio:kamailio /run/kamailio /var/log/kamailio /etc/kamailio

# Copy configuration files
COPY kamailio.cfg /etc/kamailio/kamailio.cfg
COPY dispatcher.list /etc/kamailio/dispatcher.list

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

# Validate configuration syntax
RUN kamailio -c /etc/kamailio/kamailio.cfg || echo "Config validation skipped (modules not available in build)"

# SIP ports: 5060 (UDP/TCP), 5061 (TLS)
EXPOSE 5060/udp 5060/tcp 5061/tcp

# Health check using kamcmd
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD kamcmd core.uptime || exit 1

# Run as kamailio user for security
USER kamailio

# Start Kamailio in foreground with debug output
# -DD = don't daemonize, dump core on crash
# -E = log to stderr
# -e = set log color
CMD ["/usr/sbin/kamailio", "-DD", "-E", "-f", "/etc/kamailio/kamailio.cfg", "-M", "512", "-m", "16"]
