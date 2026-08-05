#!/bin/bash
set -e

# Template kamailio.cfg — replace __PLACEHOLDER__ with env vars
# This runs before Kamailio starts so the config has real IPs
#
# Why: Kamailio's #!substdef and modparam do NOT support environment
# variables. We template the config at container startup instead.

CONFIG=/etc/kamailio/kamailio.cfg
DISPATCH=/etc/kamailio/dispatcher.list

# Required env vars — fail fast if missing
: "${EXTERNAL_SIP_IP:?EXTERNAL_SIP_IP must be set}"
: "${FREESWITCH_IP:?FREESWITCH_IP must be set}"

# Optional with defaults
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-freeswitch}"
DB_PASS="${DB_PASS:-fs_secret}"
HOMER_IP="${HOMER_IP:-127.0.0.1}"
HEP_CAPTURE_ID="${HEP_CAPTURE_ID:-100}"
SBC_ID="${SBC_ID:-east-sbc-1}"
SBC_INTERNAL_IP="${SBC_INTERNAL_IP:-127.0.0.1}"

# Per-zone Bandwidth egress PoPs. Defaults are the East values, so an East
# redeploy WITHOUT these vars set is byte-identical to the pre-templating config.
#   East:  PRIMARY=67.231.2.12 (Dallas), SECONDARY=216.82.238.134 (LA)
#   West:  PRIMARY=216.82.238.134 (LA),  SECONDARY=67.231.2.12 (Dallas)
# BANDWIDTH_IP_1 = primary (X-Carrier=primary), BANDWIDTH_IP_2 = secondary.
BANDWIDTH_PRIMARY_IP="${BANDWIDTH_PRIMARY_IP:-67.231.2.12}"
BANDWIDTH_SECONDARY_IP="${BANDWIDTH_SECONDARY_IP:-216.82.238.134}"

# Per-zone trusted internal subnets (self-containment: each SBC trusts ONLY
# its own VPC subnet + its own FS media subnet). Defaults are East values.
#   East:  INTERNAL_SUBNET=10.142.0.0/20, MEDIA_SUBNET=192.168.10.0/24
#   West:  INTERNAL_SUBNET=10.138.0.0/20, MEDIA_SUBNET=192.168.20.0/24
INTERNAL_SUBNET="${INTERNAL_SUBNET:-10.142.0.0/20}"
MEDIA_SUBNET="${MEDIA_SUBNET:-192.168.10.0/24}"

# TESTING_IP: trusted external testing source (SIPp NLB failover tests).
# SECURITY: disabled by default. When unset/empty, substitute 255.255.255.255
# — a broadcast address that can never match a real unicast SIP source, so
# the trusted-source check for it is inert. Set explicitly ONLY while testing.
TESTING_IP="${TESTING_IP:-255.255.255.255}"

# BW_CPS_LIMIT: inbound flood backstop — max NEW initial INVITEs per second
# per Bandwidth source IP. Default 100 is well above normal per-PoP traffic
# (backstop, not a traffic shaper), so unset = no behavior change for
# legitimate load.
BW_CPS_LIMIT="${BW_CPS_LIMIT:-100}"

# FS_AWARE_OPTIONS: SIP-honest OPTIONS toggle. Default ON — when the local
# FreeSWITCH is down, the OPTIONS keepalive handler answers EXTERNAL monitors
# (Bandwidth / DNS health checker / customer PBX) with 503 instead of 200 so a
# dead-FS zone drains via carrier/DNS failover (the fail-open NLB can't). Set to
# 0 in the SBC .env to force legacy always-200 behavior with no code change.
#
# Implemented as a COMPILE-TIME define (mirrors WITH_TLS). We substitute the
# __FS_AWARE_OPTIONS_DEFINE__ placeholder LINE with either the real #!define
# (ON) or a comment (OFF), so the OPTIONS handler's `#!ifdef FS_AWARE_OPTIONS`
# block is compiled in/out. Anything other than exactly "0" is treated as ON.
if [ "${FS_AWARE_OPTIONS:-1}" = "0" ]; then
  FS_AWARE_OPTIONS_DEFINE="# FS_AWARE_OPTIONS disabled via env (FS_AWARE_OPTIONS=0) — OPTIONS always 200"
  FS_AWARE_OPTIONS=0
else
  FS_AWARE_OPTIONS_DEFINE="#!define FS_AWARE_OPTIONS"
  FS_AWARE_OPTIONS=1
fi

# STIR/SHAKEN outbound signing toggle. DEFAULT OFF (dark). Same compile-time
# mechanism as FS_AWARE_OPTIONS: substitute the __STIR_SHAKEN_SIGN_DEFINE__ line
# with the real `#!define STIR_SHAKEN_SIGN` (ON) or a comment (OFF), so the
# `#!ifdef STIR_SHAKEN_SIGN` signing block in route[TO_CARRIER] is compiled
# in/out. Anything other than exactly "on" is treated as OFF (fail-safe: a typo
# never silently enables signing on the live carrier path).
if [ "${STIR_SHAKEN_SIGN:-off}" = "on" ]; then
  STIR_SHAKEN_SIGN_DEFINE="#!define STIR_SHAKEN_SIGN"
  STIR_SHAKEN_SIGN=on
else
  STIR_SHAKEN_SIGN_DEFINE="# STIR_SHAKEN_SIGN disabled via env (default off) — no Identity signing"
  STIR_SHAKEN_SIGN=off
fi

# STIR/SHAKEN inbound verification toggle (RESERVED — Phase 2B, no verify code
# yet). DEFAULT OFF. Defined here only so the env contract is consistent; the
# emitted define currently gates nothing (no `#!ifdef STIR_SHAKEN_VERIFY` block
# exists yet). Same mechanism/safety as the sign toggle above.
if [ "${STIR_SHAKEN_VERIFY:-off}" = "on" ]; then
  STIR_SHAKEN_VERIFY_DEFINE="#!define STIR_SHAKEN_VERIFY"
  STIR_SHAKEN_VERIFY=on
else
  STIR_SHAKEN_VERIFY_DEFINE="# STIR_SHAKEN_VERIFY disabled via env (default off) — no inbound verify"
  STIR_SHAKEN_VERIFY=off
fi

# STIR/SHAKEN cert repo URL (x5u) + private-key path. Safe placeholder defaults
# so the #!define always resolves even when signing is OFF (the tokens are only
# referenced inside the STIR_SHAKEN_SIGN ifdef). STIR_KEY_PATH points at the
# runtime-mounted EC P-256 private key (a SECRET — delivered per-SBC like .env,
# NEVER baked into the image). When signing is enabled, set BOTH in the SBC .env.
STIR_CERT_URL="${STIR_CERT_URL:-https://stir-shaken.invalid/cert-not-configured.pem}"
STIR_KEY_PATH="${STIR_KEY_PATH:-/etc/kamailio/stir/stir-key-not-configured.pem}"

# STIR/SHAKEN inbound VERIFY trust anchors (Phase 2B). These feed the secsipid
# `libopt` CertVerify/CertCAFile/CertCAInter modparams that govern whether a
# fetched x5u cert is chained to a trusted STI-CA root (vs. structural-only).
#   STIR_VERIFY_CERT_MODE — libsecsipid CertVerify bitmask. DEFAULT 0 = NO chain
#     validation (structural + JWT-signature only), which is byte-identical to a
#     build with no libopt lines. For true STI-PA trust set 7 (time|sysCA|custCA)
#     or 5 (time|custCA) once the CA bundle below is populated.
#   STIR_VERIFY_CA_FILE  — path to the iconectiv STI-PA trusted-ROOT bundle PEM
#     (the operator delivers this per-SBC like the key; NOT in git). Empty by
#     default; only opened when CertVerify has the custom-CA bit (4) set.
#   STIR_VERIFY_CA_INTER — optional intermediates PEM (bit 8). Empty by default.
# With STIR_SHAKEN_VERIFY off, no verify runs at all, so these are inert.
STIR_VERIFY_CERT_MODE="${STIR_VERIFY_CERT_MODE:-0}"
STIR_VERIFY_CA_FILE="${STIR_VERIFY_CA_FILE:-}"
STIR_VERIFY_CA_INTER="${STIR_VERIFY_CA_INTER:-}"

# Bandwidth TC1/TC2 trunk-config signaling IPs (fixed PoPs, same for every
# zone today — NOT swapped per zone like PRIMARY/SECONDARY). Env-driven for
# maintainability; defaults are the long-standing production values, so an
# unset var produces a byte-identical config and dispatcher.list.
#   TC1 - GraniteTelecommunicationsLLC_01: New York + Atlanta
#   TC2 - GraniteTelecommunicationsLLC_02: Dallas + Los Angeles
BANDWIDTH_TC1_NY="${BANDWIDTH_TC1_NY:-67.231.9.142}"
BANDWIDTH_TC1_ATL="${BANDWIDTH_TC1_ATL:-67.231.13.185}"
BANDWIDTH_TC2_DAL="${BANDWIDTH_TC2_DAL:-67.231.1.188}"
BANDWIDTH_TC2_LA="${BANDWIDTH_TC2_LA:-67.231.4.138}"

# FS_PUBLIC_IP: FreeSWITCH VM's own public IP for RTP media.
# Used in SDP body rewrites. Different from EXTERNAL_SIP_IP (NLB VIP) because
# RTP goes directly to/from FS, not through the NLB.
# Falls back to EXTERNAL_SIP_IP if not set (works when NLB is not used).
FS_PUBLIC_IP="${FS_PUBLIC_IP:-${EXTERNAL_SIP_IP}}"

# Template the config (work on copies since originals are read-only mounts)
cp /etc/kamailio/kamailio.cfg.tmpl "$CONFIG"
cp /etc/kamailio/dispatcher.list.tmpl "$DISPATCH"

sed -i "s|__ADVERTISE_IP__|${EXTERNAL_SIP_IP}|g" "$CONFIG"
sed -i "s|__FS_IP__|${FREESWITCH_IP}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__FS_PUBLIC_IP__|${FS_PUBLIC_IP}|g" "$CONFIG"
sed -i "s|__DB_HOST__|${DB_HOST}|g" "$CONFIG"
sed -i "s|__DB_PORT__|${DB_PORT}|g" "$CONFIG"
sed -i "s|__DB_USER__|${DB_USER}|g" "$CONFIG"
sed -i "s|__DB_PASS__|${DB_PASS}|g" "$CONFIG"
sed -i "s|__HOMER_IP__|${HOMER_IP}|g" "$CONFIG"
sed -i "s|__HEP_CAPTURE_ID__|${HEP_CAPTURE_ID}|g" "$CONFIG"
sed -i "s|__SBC_ID__|${SBC_ID}|g" "$CONFIG"
sed -i "s|__SBC_INTERNAL_IP__|${SBC_INTERNAL_IP}|g" "$CONFIG"
sed -i "s|__BANDWIDTH_PRIMARY_IP__|${BANDWIDTH_PRIMARY_IP}|g" "$CONFIG"
sed -i "s|__BANDWIDTH_SECONDARY_IP__|${BANDWIDTH_SECONDARY_IP}|g" "$CONFIG"
sed -i "s|__INTERNAL_SUBNET__|${INTERNAL_SUBNET}|g" "$CONFIG"
sed -i "s|__MEDIA_SUBNET__|${MEDIA_SUBNET}|g" "$CONFIG"
sed -i "s|__TESTING_IP__|${TESTING_IP}|g" "$CONFIG"
sed -i "s|__BW_CPS_LIMIT__|${BW_CPS_LIMIT}|g" "$CONFIG"
# FS-aware OPTIONS toggle: replace the placeholder LINE with the #!define (ON)
# or a comment (OFF). Replacement text has no '|' so the s|..|..| delimiter is
# safe; '#' and '!' are literal in sed replacement text.
sed -i "s|__FS_AWARE_OPTIONS_DEFINE__|${FS_AWARE_OPTIONS_DEFINE}|" "$CONFIG"
# STIR/SHAKEN toggles: same line-replacement pattern as FS_AWARE_OPTIONS. The
# replacement strings are fixed literals (a #!define or a comment) with no '|',
# '&' or '\', so the s|..|..| delimiter is safe.
sed -i "s|__STIR_SHAKEN_SIGN_DEFINE__|${STIR_SHAKEN_SIGN_DEFINE}|" "$CONFIG"
sed -i "s|__STIR_SHAKEN_VERIFY_DEFINE__|${STIR_SHAKEN_VERIFY_DEFINE}|" "$CONFIG"
# STIR x5u URL + key path. x5u is an ATIS-1000074 §5.3.1 URL (https, no query
# string / fragment / userinfo), so it contains no '|', '&', or '\' — safe for
# the s|..|..| delimiter and literal in the replacement. Escape defensively
# anyway so an unexpected '&' or '\' in an env override can never corrupt sed.
STIR_CERT_URL_ESC=$(printf '%s' "${STIR_CERT_URL}" | sed -e 's/[\\&|]/\\&/g')
STIR_KEY_PATH_ESC=$(printf '%s' "${STIR_KEY_PATH}" | sed -e 's/[\\&|]/\\&/g')
sed -i "s|__STIR_CERT_URL__|${STIR_CERT_URL_ESC}|g" "$CONFIG"
sed -i "s|__STIR_KEY_PATH__|${STIR_KEY_PATH_ESC}|g" "$CONFIG"
# STIR verify trust anchors (Phase 2B). Mode is a plain integer bitmask; the CA
# paths are operator-supplied filesystem paths — escape defensively (same as the
# key path) so an unexpected '&'/'\' can never corrupt the sed replacement. Empty
# defaults substitute an empty string, which libsecsipid ignores when CertVerify
# lacks the corresponding CA bit (default mode 0 = no CA files opened at all).
STIR_VERIFY_CA_FILE_ESC=$(printf '%s' "${STIR_VERIFY_CA_FILE}" | sed -e 's/[\\&|]/\\&/g')
STIR_VERIFY_CA_INTER_ESC=$(printf '%s' "${STIR_VERIFY_CA_INTER}" | sed -e 's/[\\&|]/\\&/g')
sed -i "s|__STIR_VERIFY_CERT_MODE__|${STIR_VERIFY_CERT_MODE}|g" "$CONFIG"
sed -i "s|__STIR_VERIFY_CA_FILE__|${STIR_VERIFY_CA_FILE_ESC}|g" "$CONFIG"
sed -i "s|__STIR_VERIFY_CA_INTER__|${STIR_VERIFY_CA_INTER_ESC}|g" "$CONFIG"
# TC1/TC2 IPs appear in BOTH kamailio.cfg (#!define + routing/failover) and
# dispatcher.list (keepalive groups 4-5) — template both from the same vars.
sed -i "s|__BANDWIDTH_TC1_NY__|${BANDWIDTH_TC1_NY}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_TC1_ATL__|${BANDWIDTH_TC1_ATL}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_TC2_DAL__|${BANDWIDTH_TC2_DAL}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_TC2_LA__|${BANDWIDTH_TC2_LA}|g" "$CONFIG" "$DISPATCH"

echo "Kamailio config templated: ADVERTISE_IP=${EXTERNAL_SIP_IP}, FS=${FREESWITCH_IP}, FS_PUBLIC_IP=${FS_PUBLIC_IP}, DB=${DB_HOST}:${DB_PORT}, Homer=${HOMER_IP}, HEP_ID=${HEP_CAPTURE_ID}, SBC_ID=${SBC_ID}, SBC_INTERNAL_IP=${SBC_INTERNAL_IP}, BW_PRIMARY=${BANDWIDTH_PRIMARY_IP}, BW_SECONDARY=${BANDWIDTH_SECONDARY_IP}, INTERNAL_SUBNET=${INTERNAL_SUBNET}, MEDIA_SUBNET=${MEDIA_SUBNET}, FS_AWARE_OPTIONS=${FS_AWARE_OPTIONS}, STIR_SHAKEN_SIGN=${STIR_SHAKEN_SIGN}, STIR_SHAKEN_VERIFY=${STIR_SHAKEN_VERIFY}, STIR_CERT_URL=${STIR_CERT_URL}, STIR_VERIFY_CERT_MODE=${STIR_VERIFY_CERT_MODE}, STIR_VERIFY_CA_FILE=${STIR_VERIFY_CA_FILE:-<unset>}"

# Add the NLB VIP (EXTERNAL_SIP_IP / ADVERTISE_IP) to the loopback interface.
#
# Why: GCP external passthrough Network Load Balancers deliver packets with the
# destination still set to the NLB VIP. The VM kernel only accepts them if the
# VIP is a local address, and Kamailio's `listen=udp:ADVERTISE_IP:5060` can only
# bind to it if it is local too. Adding VIP/32 to `dev lo` satisfies both.
#
# This replaces the old, un-persisted manual `ip addr add` step that was run by
# hand on each SBC VM (not in git, not in any systemd unit, not in instance
# metadata). Doing it here makes the VIP survive reboot AND be present on freshly
# cloned SBCs in new zones — no manual step required.
#
# Mirrors docker/freeswitch/entrypoint.sh. Requires the NET_ADMIN capability
# (docker-compose.sbc.yml) and the entrypoint running as root (Dockerfile USER
# root; Kamailio then drops to the kamailio user via the -u/-g CMD flags).
# Idempotent: host-net loopback state persists across container restarts, so the
# guard skips the add when the VIP is already present.
VIP="${EXTERNAL_SIP_IP}"
if ip addr show | grep -q "${VIP}"; then
  echo "NLB VIP ${VIP} already on interface"
else
  echo "Adding ${VIP}/32 to loopback"
  ip addr add "${VIP}/32" dev lo 2>/dev/null || true
fi

# Start Kamailio with all original arguments
exec /usr/sbin/kamailio "$@"
