# FreeSWITCH Built from SignalWire Source with mod_lua Support
# Multi-stage build for optimized production image
#
# Key Features:
# - Built from official SignalWire/FreeSWITCH source
# - mod_lua enabled for dynamic RCF routing via Lua scripts
# - lua-hiredis for Redis connectivity (velocity/caching)
# - luasql-postgres for PostgreSQL connectivity (RCF lookups)
# - Multi-architecture support (AMD64/ARM64)

# =============================================================================
# Stage 1: Build FreeSWITCH and dependencies from source
# =============================================================================
FROM debian:bookworm AS builder

LABEL maintainer="Voice Platform Team"
LABEL description="FreeSWITCH build stage with mod_lua"

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Build tools
    build-essential \
    cmake \
    automake \
    autoconf \
    libtool-bin \
    pkg-config \
    git \
    wget \
    ca-certificates \
    # General libraries
    libssl-dev \
    zlib1g-dev \
    libdb-dev \
    unixodbc-dev \
    libncurses5-dev \
    libexpat1-dev \
    libgdbm-dev \
    bison \
    erlang-dev \
    libtpl-dev \
    libtiff5-dev \
    uuid-dev \
    # Core FreeSWITCH
    libpcre2-dev \
    libedit-dev \
    libsqlite3-dev \
    libcurl4-openssl-dev \
    nasm \
    # Core codecs
    libogg-dev \
    libspeex-dev \
    libspeexdsp-dev \
    # mod_enum
    libldns-dev \
    # mod_av (video support)
    libavformat-dev \
    libswscale-dev \
    # mod_lua - critical for RCF routing
    liblua5.3-dev \
    lua5.3 \
    # mod_opus
    libopus-dev \
    # mod_pgsql
    libpq-dev \
    # mod_sndfile
    libsndfile1-dev \
    libflac-dev \
    libvorbis-dev \
    # mod_shout (MP3 streaming)
    libshout3-dev \
    libmpg123-dev \
    libmp3lame-dev \
    # mod_spandsp (DTMF/T.38)
    libjpeg-dev \
    # Lua libraries for Redis and PostgreSQL (build deps)
    libhiredis-dev \
    luarocks \
    && rm -rf /var/lib/apt/lists/*

# Clone FreeSWITCH source and dependencies
# Use full clone for libks to get git tags (needed for cmake)
WORKDIR /usr/src
RUN git clone --depth 1 https://github.com/signalwire/freeswitch.git /usr/src/freeswitch
RUN git clone https://github.com/signalwire/libks.git /usr/src/libs/libks
RUN git clone --depth 1 https://github.com/freeswitch/sofia-sip.git /usr/src/libs/sofia-sip
RUN git clone --depth 1 https://github.com/freeswitch/spandsp.git /usr/src/libs/spandsp
RUN git clone --depth 1 https://github.com/signalwire/signalwire-c.git /usr/src/libs/signalwire-c

# Build libks
# Note: libks uses git describe for version, fetch tags if shallow clone causes issues
WORKDIR /usr/src/libs/libks
RUN git fetch --tags 2>/dev/null || true && \
    cmake . -DCMAKE_INSTALL_PREFIX=/usr -DWITH_LIBBACKTRACE=1 \
    && make -j$(nproc) \
    && make install

# Build sofia-sip
WORKDIR /usr/src/libs/sofia-sip
RUN ./bootstrap.sh \
    && ./configure CFLAGS="-g -ggdb" --with-pic --with-glib=no --without-doxygen --disable-stun --prefix=/usr \
    && make -j$(nproc) \
    && make install

# Build spandsp
WORKDIR /usr/src/libs/spandsp
RUN ./bootstrap.sh \
    && ./configure CFLAGS="-g -ggdb" --with-pic --prefix=/usr \
    && make -j$(nproc) \
    && make install

# Build signalwire-c
WORKDIR /usr/src/libs/signalwire-c
RUN PKG_CONFIG_PATH=/usr/lib/pkgconfig cmake . -DCMAKE_INSTALL_PREFIX=/usr \
    && make -j$(nproc) \
    && make install

# Configure FreeSWITCH modules
WORKDIR /usr/src/freeswitch

# Enable required modules in modules.conf
RUN sed -i 's|#applications/mod_commands|applications/mod_commands|' build/modules.conf.in && \
    sed -i 's|#applications/mod_dptools|applications/mod_dptools|' build/modules.conf.in && \
    sed -i 's|#applications/mod_db|applications/mod_db|' build/modules.conf.in && \
    sed -i 's|#applications/mod_hash|applications/mod_hash|' build/modules.conf.in && \
    sed -i 's|#applications/mod_httapi|applications/mod_httapi|' build/modules.conf.in && \
    sed -i 's|#applications/mod_curl|applications/mod_curl|' build/modules.conf.in && \
    sed -i 's|#applications/mod_http_cache|applications/mod_http_cache|' build/modules.conf.in && \
    # Codecs
    sed -i 's|#codecs/mod_opus|codecs/mod_opus|' build/modules.conf.in && \
    sed -i 's|#codecs/mod_g729|codecs/mod_g729|' build/modules.conf.in && \
    sed -i 's|#codecs/mod_amr|codecs/mod_amr|' build/modules.conf.in && \
    # Dialplan
    sed -i 's|#dialplans/mod_dialplan_xml|dialplans/mod_dialplan_xml|' build/modules.conf.in && \
    # Endpoints
    sed -i 's|#endpoints/mod_sofia|endpoints/mod_sofia|' build/modules.conf.in && \
    sed -i 's|#endpoints/mod_loopback|endpoints/mod_loopback|' build/modules.conf.in && \
    # Event handlers
    sed -i 's|#event_handlers/mod_event_socket|event_handlers/mod_event_socket|' build/modules.conf.in && \
    sed -i 's|#event_handlers/mod_cdr_csv|event_handlers/mod_cdr_csv|' build/modules.conf.in && \
    sed -i 's|#event_handlers/mod_json_cdr|event_handlers/mod_json_cdr|' build/modules.conf.in && \
    # Formats
    sed -i 's|#formats/mod_sndfile|formats/mod_sndfile|' build/modules.conf.in && \
    sed -i 's|#formats/mod_native_file|formats/mod_native_file|' build/modules.conf.in && \
    sed -i 's|#formats/mod_shout|formats/mod_shout|' build/modules.conf.in && \
    sed -i 's|#formats/mod_local_stream|formats/mod_local_stream|' build/modules.conf.in && \
    sed -i 's|#formats/mod_tone_stream|formats/mod_tone_stream|' build/modules.conf.in && \
    # Languages - CRITICAL: mod_lua for RCF routing
    sed -i 's|#languages/mod_lua|languages/mod_lua|' build/modules.conf.in && \
    # Loggers
    sed -i 's|#loggers/mod_console|loggers/mod_console|' build/modules.conf.in && \
    sed -i 's|#loggers/mod_logfile|loggers/mod_logfile|' build/modules.conf.in && \
    # Say
    sed -i 's|#say/mod_say_en|say/mod_say_en|' build/modules.conf.in && \
    # XML handlers
    sed -i 's|#xml_int/mod_xml_curl|xml_int/mod_xml_curl|' build/modules.conf.in && \
    # TTS - disabled mod_flite as it requires additional deps
    # To enable, install libflite1 and libflite-dev
    # sed -i 's|#asr_tts/mod_flite|asr_tts/mod_flite|' build/modules.conf.in && \
    # Conferencing
    sed -i 's|#applications/mod_conference|applications/mod_conference|' build/modules.conf.in && \
    # DSP for DTMF/fax
    sed -i 's|#applications/mod_spandsp|applications/mod_spandsp|' build/modules.conf.in && \
    # Video support: mod_av provides VP8/H264 codec support via ffmpeg/libav
    # Required for conference video-mode=mux (server-side compositing)
    # mod_av is under formats/ in the FreeSWITCH source tree
    sed -i 's|#formats/mod_av|formats/mod_av|' build/modules.conf.in && \
    # UCaaS Tier 1: WebRTC, voicemail, call center, parking, monitoring
    sed -i 's|#endpoints/mod_verto|endpoints/mod_verto|' build/modules.conf.in && \
    sed -i 's|#endpoints/mod_rtc|endpoints/mod_rtc|' build/modules.conf.in && \
    sed -i 's|#applications/mod_voicemail|applications/mod_voicemail|' build/modules.conf.in && \
    sed -i 's|#applications/mod_callcenter|applications/mod_callcenter|' build/modules.conf.in && \
    sed -i 's|#applications/mod_valet_parking|applications/mod_valet_parking|' build/modules.conf.in && \
    sed -i 's|#applications/mod_spy|applications/mod_spy|' build/modules.conf.in

# Bootstrap and configure FreeSWITCH
RUN ./bootstrap.sh -j

# Configure with Lua 5.3 support
RUN ./configure \
    --prefix=/usr/local/freeswitch \
    --enable-portable-binary \
    --disable-dependency-tracking \
    --with-lua=lua5.3

# Build and install FreeSWITCH
RUN make -j$(nproc) && make install

# Install Lua libraries for Redis and PostgreSQL
# These are required by the Lua scripts for RCF routing
# Note: lua-hiredis has Lua 5.1 API compatibility issues with 5.3
# Using redis-lua (pure Lua) instead, and luasql-postgres for DB access
# redis-lua requires luasocket for network connectivity
RUN luarocks install luasocket && \
    luarocks install redis-lua && \
    luarocks install luasql-postgres PGSQL_INCDIR=/usr/include/postgresql

# =============================================================================
# Stage 2: Create minimal production image
# =============================================================================
FROM debian:bookworm-slim AS runtime

LABEL maintainer="Voice Platform Team"
LABEL description="FreeSWITCH production image with mod_lua for RCF routing"

ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core runtime libraries
    libssl3 \
    libsqlite3-0 \
    libcurl4 \
    libedit2 \
    libpcre2-8-0 \
    libtpl0 \
    uuid-runtime \
    libldns3 \
    libavformat59 \
    libswscale6 \
    libodbc2 \
    unixodbc \
    # Codec libraries
    libogg0 \
    libspeex1 \
    libspeexdsp1 \
    libopus0 \
    # Media libraries
    libsndfile1 \
    libflac12 \
    libvorbis0a \
    libvorbisenc2 \
    libshout3 \
    libmpg123-0 \
    libmp3lame0 \
    # Lua runtime - CRITICAL for mod_lua
    lua5.3 \
    liblua5.3-0 \
    # Redis client library for Lua
    libhiredis0.14 \
    # PostgreSQL client library
    libpq5 \
    # SpanDSP dependencies
    libjpeg62-turbo \
    libtiff6 \
    # Utilities
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy FreeSWITCH installation from builder
COPY --from=builder /usr/local/freeswitch /usr/local/freeswitch

# Copy shared libraries that FreeSWITCH needs
# Libraries may be in /usr/lib/ or /usr/lib/x86_64-linux-gnu/ depending on arch
COPY --from=builder /usr/lib/*sofia* /usr/lib/
COPY --from=builder /usr/lib/*spandsp* /usr/lib/
COPY --from=builder /usr/lib/*ks* /usr/lib/
COPY --from=builder /usr/lib/*signalwire* /usr/lib/
# Arch-specific libs: copy from whatever arch dir exists in the builder
# This handles both x86_64-linux-gnu and aarch64-linux-gnu
RUN --mount=from=builder,source=/usr/lib,target=/tmp/builder-usr-lib \
    ARCH_DIR=$(basename $(ls -d /tmp/builder-usr-lib/*-linux-gnu 2>/dev/null | head -1) 2>/dev/null) && \
    if [ -n "$ARCH_DIR" ] && [ -d "/tmp/builder-usr-lib/$ARCH_DIR" ]; then \
      mkdir -p /usr/lib/$ARCH_DIR && \
      cp -a /tmp/builder-usr-lib/$ARCH_DIR/*sofia* /usr/lib/$ARCH_DIR/ 2>/dev/null; \
      cp -a /tmp/builder-usr-lib/$ARCH_DIR/*spandsp* /usr/lib/$ARCH_DIR/ 2>/dev/null; \
      cp -a /tmp/builder-usr-lib/$ARCH_DIR/*ks* /usr/lib/$ARCH_DIR/ 2>/dev/null; \
      cp -a /tmp/builder-usr-lib/$ARCH_DIR/*signalwire* /usr/lib/$ARCH_DIR/ 2>/dev/null; \
    fi; true

# Copy Lua libraries from luarocks
COPY --from=builder /usr/local/lib/lua /usr/local/lib/lua
COPY --from=builder /usr/local/share/lua /usr/local/share/lua

# Update library cache
RUN ldconfig

# Create necessary directories
RUN mkdir -p /var/log/freeswitch/cdr-csv \
    && mkdir -p /var/lib/freeswitch/recordings \
    && mkdir -p /var/lib/freeswitch/storage \
    && mkdir -p /var/lib/freeswitch/db \
    && mkdir -p /var/lib/freeswitch/voicemail \
    && mkdir -p /usr/local/freeswitch/scripts/lib \
    && mkdir -p /usr/local/freeswitch/conf/tls \
    && mkdir -p /etc/freeswitch

# Copy our custom configuration
COPY conf/freeswitch.xml /usr/local/freeswitch/conf/
COPY conf/autoload_configs/ /usr/local/freeswitch/conf/autoload_configs/
COPY conf/dialplan/ /usr/local/freeswitch/conf/dialplan/
COPY conf/directory/ /usr/local/freeswitch/conf/directory/
COPY conf/sofia/ /usr/local/freeswitch/conf/sofia/

# Copy Lua scripts for RCF routing
COPY scripts/ /usr/local/freeswitch/scripts/

# Generate self-signed certificates for TLS
RUN openssl req -x509 -newkey rsa:2048 \
    -keyout /usr/local/freeswitch/conf/tls/agent.key \
    -out /usr/local/freeswitch/conf/tls/agent.crt \
    -days 365 -nodes \
    -subj "/C=US/ST=State/L=City/O=VoicePlatform/OU=FreeSWITCH/CN=fs.voiceplatform.local" && \
    cat /usr/local/freeswitch/conf/tls/agent.crt /usr/local/freeswitch/conf/tls/agent.key > /usr/local/freeswitch/conf/tls/agent.pem && \
    cp /usr/local/freeswitch/conf/tls/agent.pem /usr/local/freeswitch/conf/tls/wss.pem && \
    chmod 600 /usr/local/freeswitch/conf/tls/*.key /usr/local/freeswitch/conf/tls/*.pem

# Set Lua path environment variables for mod_lua to find libraries
ENV LUA_PATH="/usr/local/freeswitch/scripts/?.lua;/usr/local/freeswitch/scripts/lib/?.lua;/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;;"
ENV LUA_CPATH="/usr/local/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?.so;;"

# Network ports
# SIP signaling
EXPOSE 5060/udp 5060/tcp
EXPOSE 5080/udp 5080/tcp
EXPOSE 5081/tcp
EXPOSE 5090/udp 5090/tcp
# WebRTC (mod_verto WSS)
EXPOSE 8082/tcp
# Event Socket
EXPOSE 8021/tcp
# RTP media (must match rtp-start-port/rtp-end-port in switch.conf.xml
# and the port mapping in docker-compose.yml)
EXPOSE 16384-18383/udp

# Health check using fs_cli
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD /usr/local/freeswitch/bin/fs_cli -x "status" 2>/dev/null | grep -q "UP" || exit 1

# Start FreeSWITCH in foreground with custom config directory
# Must specify all of: -conf, -log, -db together
# CRITICAL: Do NOT use -nonat here. The -nonat flag disables ext-rtp-ip and
# ext-sip-ip processing, causing SDP to contain Docker internal IPs (172.28.x.x)
# instead of the public IP. Bandwidth would send RTP to an unreachable address.
# NAT traversal via ext-rtp-ip/ext-sip-ip is essential in Docker environments.
CMD ["/usr/local/freeswitch/bin/freeswitch", "-nc", "-nf", "-conf", "/usr/local/freeswitch/conf", "-log", "/var/log/freeswitch", "-db", "/var/lib/freeswitch/db", "-scripts", "/usr/local/freeswitch/scripts"]
