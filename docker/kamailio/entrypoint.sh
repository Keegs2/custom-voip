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

# SBC_SIGNALING_VIP: per-zone INTERNAL passthrough-NLB VIP ("signaling VIP")
# for the TRUE active/standby SBC pair. FreeSWITCH targets this VIP
# (SBC_PROXY_IP in the media VM .env) for B-leg bridging AND for in-dialog
# requests (it is the FS-facing inner Record-Route entry in both presets), so
# FS->SBC traffic always reaches the ONE active SBC and a mid-call SBC death
# no longer strands in-dialog requests on a dead pinned SBC_INTERNAL_IP.
#
# DEFAULT (unset/empty): SBC_INTERNAL_IP. The SIGNALING_VIP token in
# kamailio.cfg then renders to the exact same IP string as today's inner
# Record-Route, and the dedicated listen/alias lines are compiled OUT (the
# mode define below becomes a comment) — the rendered config is byte-identical
# to a pre-HA deploy. Rolling-safe: deploy this code everywhere first (no-op),
# have the operator create the internal NLB, THEN set the var per-SBC.
#
# Set-but-equal (SBC_SIGNALING_VIP == SBC_INTERNAL_IP) is treated as unset so
# a duplicate listen directive is never emitted (Kamailio 5.8 silently merges
# exact-duplicate listens keeping the FIRST one's advertise —
# core/socket_info.c fix_socket_list "removing duplicate addresses" — but we
# refuse to rely on silent-merge semantics on a live platform).
if [ -n "${SBC_SIGNALING_VIP:-}" ] && [ "${SBC_SIGNALING_VIP}" != "${SBC_INTERNAL_IP}" ]; then
  SBC_SIGVIP_MODE_DEFINE="#!define SBC_SIGVIP_DEDICATED"
  SBC_SIGVIP_MODE=dedicated
else
  SBC_SIGNALING_VIP="${SBC_INTERNAL_IP}"
  SBC_SIGVIP_MODE_DEFINE="# SBC_SIGNALING_VIP not set — SIGNALING_VIP renders as SBC_INTERNAL_IP, no dedicated listen/alias emitted"
  SBC_SIGVIP_MODE=fallback
fi

# FREESWITCH_IP_2: OPTIONAL second FreeSWITCH media node (VPC/media-subnet IP,
# same address family as FREESWITCH_IP) for the STRICT ACTIVE/STANDBY media
# pair — the FS mirror of the SBC pair model. When set (and different from
# FREESWITCH_IP):
#   - dispatcher.list group 1 gains a SECOND destination (duid=fs-standby,
#     priority 5) and the FS-1 line's priority becomes 10. Kamailio 5.8 orders
#     dlist[] by DESCENDING priority number (add_dest2list ascending insert +
#     reindex_dests backwards copy — dispatch.c:589-604/803-816), so alg 8
#     ("serial", hash=0 — dispatch.c:2466) always tries FS-1 first and only
#     skips to FS-2 while FS-1 is marked INACTIVE/DISABLED (ds_skip_dst,
#     dispatch.h:51). Strict first-active-by-priority — NOT round-robin.
#   - kamailio.cfg compiles the FS_HA_PAIR blocks in: alg 8 in
#     route[DISPATCH], per-node fsn=1/fsn=2 Record-Route markers, per-node
#     fshealth flags (fs1_up/fs2_up), and fsn-aware in-dialog host resolution.
#
# DEFAULT (unset/empty): FREESWITCH_IP_2 substitutes as FREESWITCH_IP (so the
# __FS_IP_2__ token inside compiled-out #!ifdef blocks still renders to a
# valid address), the FS-2 dispatcher line renders as a comment, the FS-1
# priority renders back to 0, and the mode define renders as a comment —
# single-FS behavior, rolling-safe. Set-but-equal is treated as unset (same
# guard as SBC_SIGNALING_VIP): a duplicate group-1 destination would make the
# "standby" a second route to the SAME box and break per-node health truth.
if [ -n "${FREESWITCH_IP_2:-}" ] && [ "${FREESWITCH_IP_2}" != "${FREESWITCH_IP}" ]; then
  FS_HA_MODE_DEFINE="#!define FS_HA_PAIR"
  FS_HA_MODE=pair
  FS1_PRIORITY=10
  FS2_DISPATCHER_LINE="1 sip:${FREESWITCH_IP_2}:5080 0 5 weight=100;maxload=2000;duid=fs-standby"
else
  FREESWITCH_IP_2="${FREESWITCH_IP}"
  FS_HA_MODE_DEFINE="# FREESWITCH_IP_2 not set — single-FS zone, FS_HA_PAIR blocks compiled out"
  FS_HA_MODE=single
  FS1_PRIORITY=0
  FS2_DISPATCHER_LINE="# FREESWITCH_IP_2 not set — no standby media destination (strict-pair mode off)"
fi

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

# UDP_MTU: oversized-request UDP->TCP fallback (core udp_mtu +
# udp_mtu_try_proto=TCP — see the activation criteria comment in kamailio.cfg).
# DEFAULT OFF (0): ship-dark safety valve for STIR-signed INVITEs that exceed
# the wire MTU and currently IP-fragment. The param is GLOBAL (also governs
# FS-bound and PBX-bound UDP sends) and Bandwidth's TCP support is unverified
# from our side, so it MUST stay off until the operator completes the Bandwidth
# TCP canary. Sanitize hard: anything non-numeric or <=0 renders the toggle
# OFF (fail-safe — a typo can never flip transport behavior on the live
# carrier path). Same compile-time line-replacement mechanism as
# FS_AWARE_OPTIONS/STIR_SHAKEN_SIGN.
UDP_MTU="${UDP_MTU:-0}"
case "${UDP_MTU}" in
  ''|*[!0-9]*) UDP_MTU=0 ;;
esac
if [ "${UDP_MTU}" -gt 0 ]; then
  UDP_MTU_DEFINE="#!define UDP_MTU_FALLBACK"
else
  UDP_MTU=0
  UDP_MTU_DEFINE="# UDP_MTU disabled via env (default 0) — no udp_mtu/TCP fallback; oversized UDP fragments as before"
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
#   STIR_VERIFY_CRL_FILE — optional STI-PA CRL PEM (bit 16, CertCRLFile;
#     refreshed daily by refresh-sbc-trust-bundle.sh). Empty by default; only
#     opened when CertVerify has the CRL bit (16) set.
# With STIR_SHAKEN_VERIFY off, no verify runs at all, so these are inert.
STIR_VERIFY_CERT_MODE="${STIR_VERIFY_CERT_MODE:-0}"
STIR_VERIFY_CA_FILE="${STIR_VERIFY_CA_FILE:-}"
STIR_VERIFY_CA_INTER="${STIR_VERIFY_CA_INTER:-}"
STIR_VERIFY_CRL_FILE="${STIR_VERIFY_CRL_FILE:-}"

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

# Sinch ORIGINATION signaling IPs (fixed PoPs, same for every zone — Sinch
# round-robins inbound INVITEs to all 3 zone NLB VIPs). Env-driven for
# maintainability; defaults are the production values, so an unset var
# produces the correct trust list and dispatcher.list with NO .env edits
# (deploy = git pull + rebuild). ORIGINATION ONLY — these are inbound trust
# + keepalive targets (dispatcher groups 6-7), never TO_CARRIER egress.
#   Denver:  Trunk Group DNVTCOZIGR2_3278, test TN 5305480845
#   Chicago: Trunk Group CHCGIL24GR4_7412, test TN 5305480846
SINCH_DENVER_IP="${SINCH_DENVER_IP:-206.146.100.24}"
SINCH_CHICAGO_IP="${SINCH_CHICAGO_IP:-206.146.101.39}"

# Sinch TERMINATION signaling IPs (trunk groups registered to all 6 SBC
# public IPs on the Sinch side — DIFFERENT IPs from the origination PoPs
# above). Same env-driven/default posture as SINCH_DENVER_IP. These appear
# ONLY in dispatcher.list (keepalive groups 8-9) — egress selection is
# table-driven (carrier_trunks -> FS X-Carrier-IP), so kamailio.cfg carries
# no define for them and the sed below deliberately targets the dispatcher
# file only.
#   Atlanta LD ("INT"):      TG ATLNGAQSGR2_7214, order 225468139, test TN 2139924610
#   Denver TF ("OSAO" 8YY):  TG DNVTCOZIGR2_3282, order 225468672
SINCH_LD_IP="${SINCH_LD_IP:-206.146.98.26}"
SINCH_TF_IP="${SINCH_TF_IP:-206.146.100.26}"

# FS_PUBLIC_IP: FreeSWITCH VM's own public IP for RTP media.
# Used in SDP body rewrites. Different from EXTERNAL_SIP_IP (NLB VIP) because
# RTP goes directly to/from FS, not through the NLB.
# Falls back to EXTERNAL_SIP_IP if not set (works when NLB is not used).
FS_PUBLIC_IP="${FS_PUBLIC_IP:-${EXTERNAL_SIP_IP}}"

# Template the config (work on copies since originals are read-only mounts)
cp /etc/kamailio/kamailio.cfg.tmpl "$CONFIG"
cp /etc/kamailio/dispatcher.list.tmpl "$DISPATCH"

sed -i "s|__ADVERTISE_IP__|${EXTERNAL_SIP_IP}|g" "$CONFIG"
# ORDER MATTERS: __FS_IP_2__ MUST be substituted BEFORE __FS_IP__ — the
# __FS_IP__ pattern is a substring of __FS_IP_2__, so the reverse order would
# corrupt the FS-2 token into "<fs1-ip>_2__".
sed -i "s|__FS_IP_2__|${FREESWITCH_IP_2}|g" "$CONFIG"
sed -i "s|__FS_IP__|${FREESWITCH_IP}|g" "$CONFIG" "$DISPATCH"
# Strict active/standby FS pair rendering (see the FREESWITCH_IP_2 block
# above). All replacement strings are fixed shell-built literals containing
# no '|', '&' or '\' — safe for the s|..|..| delimiter.
sed -i "s|__FS1_PRIORITY__|${FS1_PRIORITY}|g" "$DISPATCH"
sed -i "s|__FS2_DISPATCHER_LINE__|${FS2_DISPATCHER_LINE}|" "$DISPATCH"
sed -i "s|__FS_HA_MODE_DEFINE__|${FS_HA_MODE_DEFINE}|" "$CONFIG"
sed -i "s|__FS_PUBLIC_IP__|${FS_PUBLIC_IP}|g" "$CONFIG"
sed -i "s|__DB_HOST__|${DB_HOST}|g" "$CONFIG"
sed -i "s|__DB_PORT__|${DB_PORT}|g" "$CONFIG"
sed -i "s|__DB_USER__|${DB_USER}|g" "$CONFIG"
sed -i "s|__DB_PASS__|${DB_PASS}|g" "$CONFIG"
sed -i "s|__HOMER_IP__|${HOMER_IP}|g" "$CONFIG"
sed -i "s|__HEP_CAPTURE_ID__|${HEP_CAPTURE_ID}|g" "$CONFIG"
sed -i "s|__SBC_ID__|${SBC_ID}|g" "$CONFIG"
sed -i "s|__SBC_INTERNAL_IP__|${SBC_INTERNAL_IP}|g" "$CONFIG"
# Signaling VIP (active/standby HA). Value is SBC_SIGNALING_VIP when set to a
# dedicated ILB VIP, else SBC_INTERNAL_IP (fallback — renders byte-identical
# to the pre-HA config). The mode define compiles the dedicated listen/alias
# lines in (dedicated) or out (fallback) — same line-replacement pattern as
# FS_AWARE_OPTIONS; both replacement strings are fixed literals with no
# '|', '&' or '\'.
sed -i "s|__SIGNALING_VIP__|${SBC_SIGNALING_VIP}|g" "$CONFIG"
sed -i "s|__SBC_SIGVIP_MODE_DEFINE__|${SBC_SIGVIP_MODE_DEFINE}|" "$CONFIG"
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
# UDP MTU fallback toggle + value. Both replacement strings are fixed literals
# (the define/comment line and a sanitized integer) with no '|', '&' or '\'.
# The value is substituted even when the toggle is OFF (renders 0 inside the
# compiled-out #!ifdef block) so no placeholder ever survives templating.
sed -i "s|__UDP_MTU_DEFINE__|${UDP_MTU_DEFINE}|" "$CONFIG"
sed -i "s|__UDP_MTU_VALUE__|${UDP_MTU}|g" "$CONFIG"
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
STIR_VERIFY_CRL_FILE_ESC=$(printf '%s' "${STIR_VERIFY_CRL_FILE}" | sed -e 's/[\\&|]/\\&/g')
sed -i "s|__STIR_VERIFY_CERT_MODE__|${STIR_VERIFY_CERT_MODE}|g" "$CONFIG"
sed -i "s|__STIR_VERIFY_CA_FILE__|${STIR_VERIFY_CA_FILE_ESC}|g" "$CONFIG"
sed -i "s|__STIR_VERIFY_CA_INTER__|${STIR_VERIFY_CA_INTER_ESC}|g" "$CONFIG"
sed -i "s|__STIR_VERIFY_CRL_FILE__|${STIR_VERIFY_CRL_FILE_ESC}|g" "$CONFIG"
# TC1/TC2 IPs appear in BOTH kamailio.cfg (#!define + routing/failover) and
# dispatcher.list (keepalive groups 4-5) — template both from the same vars.
sed -i "s|__BANDWIDTH_TC1_NY__|${BANDWIDTH_TC1_NY}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_TC1_ATL__|${BANDWIDTH_TC1_ATL}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_TC2_DAL__|${BANDWIDTH_TC2_DAL}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_TC2_LA__|${BANDWIDTH_TC2_LA}|g" "$CONFIG" "$DISPATCH"
# Sinch origination IPs appear in BOTH kamailio.cfg (#!define trust +
# attribution) and dispatcher.list (keepalive groups 6-7) — same vars for both
# so trust and keepalive targets stay in lockstep.
sed -i "s|__SINCH_DENVER_IP__|${SINCH_DENVER_IP}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__SINCH_CHICAGO_IP__|${SINCH_CHICAGO_IP}|g" "$CONFIG" "$DISPATCH"
# Sinch TERMINATION IPs appear ONLY in dispatcher.list (keepalive groups
# 8-9) — kamailio.cfg has no define for them (egress is table-driven via
# X-Carrier-IP), so DELIBERATELY only the dispatcher file is templated.
sed -i "s|__SINCH_LD_IP__|${SINCH_LD_IP}|g" "$DISPATCH"
sed -i "s|__SINCH_TF_IP__|${SINCH_TF_IP}|g" "$DISPATCH"

echo "Kamailio config templated: ADVERTISE_IP=${EXTERNAL_SIP_IP}, FS=${FREESWITCH_IP}, FS2=${FREESWITCH_IP_2} (${FS_HA_MODE}), FS_PUBLIC_IP=${FS_PUBLIC_IP}, DB=${DB_HOST}:${DB_PORT}, Homer=${HOMER_IP}, HEP_ID=${HEP_CAPTURE_ID}, SBC_ID=${SBC_ID}, SBC_INTERNAL_IP=${SBC_INTERNAL_IP}, SIGNALING_VIP=${SBC_SIGNALING_VIP} (${SBC_SIGVIP_MODE}), BW_PRIMARY=${BANDWIDTH_PRIMARY_IP}, BW_SECONDARY=${BANDWIDTH_SECONDARY_IP}, SINCH_DENVER=${SINCH_DENVER_IP}, SINCH_CHICAGO=${SINCH_CHICAGO_IP}, SINCH_LD=${SINCH_LD_IP}, SINCH_TF=${SINCH_TF_IP}, INTERNAL_SUBNET=${INTERNAL_SUBNET}, MEDIA_SUBNET=${MEDIA_SUBNET}, FS_AWARE_OPTIONS=${FS_AWARE_OPTIONS}, STIR_SHAKEN_SIGN=${STIR_SHAKEN_SIGN}, STIR_SHAKEN_VERIFY=${STIR_SHAKEN_VERIFY}, STIR_CERT_URL=${STIR_CERT_URL}, STIR_VERIFY_CERT_MODE=${STIR_VERIFY_CERT_MODE}, STIR_VERIFY_CA_FILE=${STIR_VERIFY_CA_FILE:-<unset>}"

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

# Add the signaling VIP (internal passthrough NLB) to loopback — dedicated
# mode only. Same rationale/mechanism as the external VIP above: the internal
# NLB delivers packets with dst still set to the ILB VIP, and Kamailio's
# `listen=udp:SIGNALING_VIP:5060` must be able to BIND it at startup (a
# listen on a non-local address is a fatal startup error). GCP's guest agent
# does program a local route for ILB backends, but we must not depend on
# guest-agent timing/ordering relative to container start.
#
# NOTE the guard grep matches " ${IP}/" (with CIDR slash), NOT the bare IP:
# the signaling VIP lives in the SAME subnet as the VM NIC IP (e.g. ILB VIP
# 10.138.0.10 is a bare-substring PREFIX of NIC 10.138.0.100), so a bare
# grep could false-match the longer address, skip the add, and crash-loop
# Kamailio on the listen bind. In fallback mode
# SBC_SIGNALING_VIP == SBC_INTERNAL_IP (the NIC address, already present) —
# nothing to add.
if [ "${SBC_SIGVIP_MODE}" = "dedicated" ]; then
  if ip addr show | grep -q " ${SBC_SIGNALING_VIP}/"; then
    echo "Signaling VIP ${SBC_SIGNALING_VIP} already on interface"
  else
    echo "Adding signaling VIP ${SBC_SIGNALING_VIP}/32 to loopback"
    ip addr add "${SBC_SIGNALING_VIP}/32" dev lo 2>/dev/null || true
  fi
fi

# Start Kamailio with all original arguments
exec /usr/sbin/kamailio "$@"
