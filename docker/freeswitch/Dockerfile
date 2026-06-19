# FreeSWITCH — RCF-V1 Production Build
# Multi-stage build for optimized production image
# Stripped to Remote Call Forwarding only (no UCaaS/WebRTC/voicemail/conferencing).
#
# Key Features:
# - Built from official SignalWire/FreeSWITCH source
# - mod_lua enabled for dynamic RCF routing via Lua scripts
# - lua-hiredis for Redis connectivity (velocity/caching)
# - luasql-postgres for PostgreSQL connectivity (RCF lookups)
# - Multi-architecture support (AMD64/ARM64)
# - TLS certs provided by CA (not self-signed) — mount at /usr/local/freeswitch/conf/tls/

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
    # mod_av (video support — VP8/H264 for UCaaS conference video-mode=mux)
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

# flite (Phase 7) — built as the SECONDARY/fallback <Say> engine (Piper via
# mod_tts_commandline is primary). Debian's flite1-dev ships the lib + the CMU
# voices (kal/kal16/awb/rms/slt — matching api_voice.lua's FLITE_VOICE_MAP); the
# FreeSWITCH ./configure below detects HAVE_FLITE and compiles mod_flite. Its own
# apt layer keeps it from invalidating the cached source-lib builds above.
RUN apt-get update && apt-get install -y --no-install-recommends \
    flite1-dev \
    && rm -rf /var/lib/apt/lists/*

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
    # TTS (Phase 7) — mod_tts_commandline shells out to an external synthesizer
    # (Piper, installed in the runtime stage). It has NO build deps (it just runs
    # a shell command + reads the resulting WAV via the core file interface), so
    # enabling it is a one-line module add. flite stays disabled (needs libflite).
    sed -i 's|#asr_tts/mod_tts_commandline|asr_tts/mod_tts_commandline|' build/modules.conf.in && \
    # mod_flite — secondary/fallback <Say> engine (flite1-dev installed above).
    sed -i 's|#asr_tts/mod_flite|asr_tts/mod_flite|' build/modules.conf.in && \
    # DSP for DTMF/fax — needed for RCF and UCaaS
    sed -i 's|#applications/mod_spandsp|applications/mod_spandsp|' build/modules.conf.in && \
    # UCaaS (unified): conferencing
    sed -i 's|#applications/mod_conference|applications/mod_conference|' build/modules.conf.in && \
    # Video support: mod_av provides VP8/H264 codec support via ffmpeg/libav
    # Required for conference video-mode=mux (server-side compositing)
    # mod_av is under formats/ in the FreeSWITCH source tree
    sed -i 's|#formats/mod_av|formats/mod_av|' build/modules.conf.in && \
    # UCaaS Tier 1: WebRTC endpoints, voicemail, call center, parking, monitoring
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
# mod_audio_stream — fork call audio (L16) to a WebSocket for AI/transcription.
# (Phase 6: powers the <Stream>/<Connect><Stream> TwiML verbs.)
#
# Built AFTER the FreeSWITCH install so these layers are PURELY ADDITIVE and do
# NOT invalidate the (expensive, cached) FreeSWITCH build above. The module ships
# its WebSocket client (IXWebSocket) as a git submodule, statically linked; its
# only extra build dep is libevent (libssl/zlib/libspeexdsp are already present).
# We point pkg-config at the installed FreeSWITCH so its CMake finds modulesdir.
# =============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    libevent-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --recurse-submodules \
    https://github.com/amigniter/mod_audio_stream.git /usr/src/mod_audio_stream
WORKDIR /usr/src/mod_audio_stream
RUN export PKG_CONFIG_PATH=/usr/local/freeswitch/lib/pkgconfig && \
    mkdir -p build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j$(nproc) && \
    make install && \
    ls -la /usr/local/freeswitch/lib/freeswitch/mod/mod_audio_stream.so

# =============================================================================
# Stage 2: Create minimal production image
# =============================================================================
FROM debian:bookworm-slim AS runtime

LABEL maintainer="Voice Platform Team"
LABEL description="FreeSWITCH RCF-V1 production image — Remote Call Forwarding only"

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
    # mod_av runtime (video — UCaaS conference compositing)
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
    # flite TTS runtime (Phase 7 — fallback <Say> engine; voices kal/kal16/awb/rms/slt)
    libflite1 \
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
    # iproute2 provides the 'ip' command, needed by entrypoint.sh to add
    # the public IP to loopback for GCE hairpin NAT workaround
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

# mod_audio_stream runtime deps: libevent core + pthreads variant (the .so links
# libevent_pthreads). The bundled WebSocket client (libwsc/IXWebSocket) is static.
# Separate RUN so it does not invalidate the cached apt layer above.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libevent-2.1-7 \
    libevent-pthreads-2.1-7 \
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

# Create necessary directories.
# /var/lib/freeswitch/{voicemail,recordings} are symlinked onto the shared
# /media/spool volume at runtime by entrypoint.sh (Phase 4 storage handoff);
# they are created here so the image is valid even when run without the volume.
RUN mkdir -p /var/log/freeswitch/cdr-csv \
    && mkdir -p /var/lib/freeswitch/recordings \
    && mkdir -p /var/lib/freeswitch/storage \
    && mkdir -p /var/lib/freeswitch/db \
    && mkdir -p /var/lib/freeswitch/voicemail \
    && mkdir -p /media/spool/voicemail \
    && mkdir -p /media/spool/recordings \
    && mkdir -p /usr/local/freeswitch/scripts/lib \
    && mkdir -p /usr/local/freeswitch/conf/tls \
    && mkdir -p /etc/freeswitch

# Copy our custom configuration
COPY conf/freeswitch.xml /usr/local/freeswitch/conf/
COPY conf/autoload_configs/ /usr/local/freeswitch/conf/autoload_configs/
COPY conf/dialplan/ /usr/local/freeswitch/conf/dialplan/
COPY conf/directory/ /usr/local/freeswitch/conf/directory/
COPY conf/sofia/ /usr/local/freeswitch/conf/sofia/
# UCaaS: lang/ provides voicemail/say prompts (mod_voicemail, mod_say_en)
COPY conf/lang/ /usr/local/freeswitch/conf/lang/

# Copy Lua scripts for RCF routing
COPY scripts/ /usr/local/freeswitch/scripts/

# Generate self-signed certificates for Verto WSS (dev/default).
# Verto's WSS profile will not bind without a wss.pem, breaking softphone/conference.
# PRODUCTION: prefer mounting CA-issued certs over the self-signed pair, e.g.:
#   volumes:
#     - ./certs/agent.pem:/usr/local/freeswitch/conf/tls/agent.pem
#     - ./certs/wss.pem:/usr/local/freeswitch/conf/tls/wss.pem
RUN openssl req -x509 -newkey rsa:2048 \
    -keyout /usr/local/freeswitch/conf/tls/agent.key \
    -out /usr/local/freeswitch/conf/tls/agent.crt \
    -days 365 -nodes \
    -subj "/C=US/ST=State/L=City/O=VoicePlatform/OU=FreeSWITCH/CN=fs.voiceplatform.local" && \
    cat /usr/local/freeswitch/conf/tls/agent.crt /usr/local/freeswitch/conf/tls/agent.key > /usr/local/freeswitch/conf/tls/agent.pem && \
    cp /usr/local/freeswitch/conf/tls/agent.pem /usr/local/freeswitch/conf/tls/wss.pem && \
    chmod 600 /usr/local/freeswitch/conf/tls/*.key /usr/local/freeswitch/conf/tls/*.pem

# =============================================================================
# Piper neural TTS (Phase 7) — the high-quality, offline, MIT-licensed engine
# behind mod_tts_commandline for the TwiML <Say> verb.
#
# Installed in the RUNTIME stage (not the builder) because Piper ships as a
# self-contained prebuilt release tarball — the `piper` binary + bundled
# libonnxruntime + libpiper_phonemize + espeak-ng-data — so there is nothing to
# compile. We download the tarball for the BUILD ARCH (BuildKit auto-populates
# TARGETARCH: amd64 -> x86_64, arm64 -> aarch64) plus ONE en-US voice model from
# huggingface (en_US-lessac-medium, ~63 MB .onnx + small .onnx.json). This keeps
# the image lean (one voice); add more .onnx/.onnx.json under /opt/piper/voices
# and extend scripts/bin/piper_tts.sh for multi-voice.
#
# IN-IMAGE (no sidecar) is deliberate: a sidecar would hit the documented
# Docker-Desktop FS->bridge network isolation; in-image renders with zero
# network and is locally verifiable. Pinned to a specific Piper release for
# reproducibility. onnxruntime's CPU backend needs libgomp1 (OpenMP) at runtime.
# =============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 xz-utils \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_VOICE=en_US-lessac-medium
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) PIPER_ARCH=x86_64 ;; \
      arm64) PIPER_ARCH=aarch64 ;; \
      *) echo "Unsupported TARGETARCH=${TARGETARCH} for Piper" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${PIPER_ARCH}.tar.gz"; \
    tar -xzf /tmp/piper.tar.gz -C /opt; \
    rm -f /tmp/piper.tar.gz; \
    mkdir -p /opt/piper/voices; \
    curl -fsSL -o "/opt/piper/voices/${PIPER_VOICE}.onnx" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/${PIPER_VOICE}.onnx"; \
    curl -fsSL -o "/opt/piper/voices/${PIPER_VOICE}.onnx.json" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/${PIPER_VOICE}.onnx.json"; \
    # Smoke-test the binary + model at build time so a broken download fails the build.
    echo "piper build smoke test" | LD_LIBRARY_PATH=/opt/piper /opt/piper/piper \
      --model "/opt/piper/voices/${PIPER_VOICE}.onnx" \
      --espeak_data /opt/piper/espeak-ng-data \
      --output_file /tmp/piper_build_test.wav; \
    ls -la /tmp/piper_build_test.wav /opt/piper/piper "/opt/piper/voices/${PIPER_VOICE}.onnx"; \
    rm -f /tmp/piper_build_test.wav
ENV PIPER_DIR=/opt/piper
ENV PIPER_VOICES_DIR=/opt/piper/voices
ENV PIPER_DEFAULT_MODEL=en_US-lessac-medium

# Set Lua path environment variables for mod_lua to find libraries
ENV LUA_PATH="/usr/local/freeswitch/scripts/?.lua;/usr/local/freeswitch/scripts/lib/?.lua;/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;;"
ENV LUA_CPATH="/usr/local/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?.so;;"

# Network ports
# SIP signaling
EXPOSE 5060/udp 5060/tcp
EXPOSE 5080/udp 5080/tcp
EXPOSE 5081/tcp
EXPOSE 5090/udp 5090/tcp
# WebRTC (mod_verto WSS) — UCaaS softphone/conference signaling
EXPOSE 8082/tcp
# Event Socket
EXPOSE 8021/tcp
# RTP media — RCF-V1: expanded for 10K concurrent calls (host networking required)
# Must match rtp-start-port/rtp-end-port in switch.conf.xml
EXPOSE 16384-49151/udp

# Health check defined in docker-compose files (not here) so the ESL password
# can be passed via $ESL_PASSWORD environment variable.

# Copy entrypoint script that adds public IP to loopback before starting FS.
# This solves the GCE hairpin NAT issue: packets from FS to its own public IP
# (e.g., ACK/BYE to Kamailio's Record-Route address) are delivered locally
# instead of being dropped by GCE's network fabric.
COPY entrypoint.sh /usr/local/freeswitch/entrypoint.sh
RUN chmod +x /usr/local/freeswitch/entrypoint.sh

# Start FreeSWITCH via entrypoint.sh, which performs three repo-encoded host
# config steps then `exec`s the freeswitch binary as PID 1:
#   1. add the public IP to loopback (GCE hairpin NAT fix),
#   2. refuse the well-known ClueCon ESL password (Phase 4),
#   3. symlink voicemail/recordings onto the shared /media/spool volume (Phase 4).
# The CMD below is passed through to freeswitch via `exec "$@"`.
#
# CRITICAL: Do NOT use -nonat here. The -nonat flag disables ext-rtp-ip and
# ext-sip-ip processing, causing SDP to contain Docker internal IPs (172.28.x.x)
# instead of the public IP. Bandwidth would send RTP to an unreachable address.
# NAT traversal via ext-rtp-ip/ext-sip-ip is essential in Docker environments.
ENTRYPOINT ["/usr/local/freeswitch/entrypoint.sh"]
CMD ["-nf", "-conf", "/usr/local/freeswitch/conf", "-log", "/var/log/freeswitch", "-db", "/var/lib/freeswitch/db", "-scripts", "/usr/local/freeswitch/scripts"]
