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

# Bandwidth TC3 - GRANITE_911 dedicated E911 emergency trunk (fixed PoPs, same
# for every zone). Defaults are the long-standing GRANITE_911 production IPs, so
# an unset var produces a byte-identical config + dispatcher.list.
#   E911_1 = 67.231.1.137 (Dallas, primary), E911_2 = 67.231.12.71 (Atlanta)
# 911 egresses here (X-Carrier=emergency from FreeSWITCH emergency.lua); also
# dispatcher.list group 6 keepalive so the first 911 INVITE isn't NAT-dropped.
BANDWIDTH_E911_1="${BANDWIDTH_E911_1:-67.231.1.137}"
BANDWIDTH_E911_2="${BANDWIDTH_E911_2:-67.231.12.71}"

# FS_PUBLIC_IP: FreeSWITCH VM's own public IP for RTP media.
# Used in SDP body rewrites. Different from EXTERNAL_SIP_IP (NLB VIP) because
# RTP goes directly to/from FS, not through the NLB.
# Falls back to EXTERNAL_SIP_IP if not set (works when NLB is not used).
FS_PUBLIC_IP="${FS_PUBLIC_IP:-${EXTERNAL_SIP_IP}}"

# STIR/SHAKEN (RFC 8224/8588). DEFAULT-OFF: the secsipid module + routes are only
# compiled in when STIRSHAKEN_PRIVKEY_PATH is set (a signing key is provisioned).
# EXTERNAL PROVISIONING (see report): obtain our SPC token from the Policy
# Administrator (iconectiv) -> get the ES256 signing cert -> mount the private key
# + publish the cert at STIRSHAKEN_CERT_URL -> set these vars. Also register in the
# FCC Robocall Mitigation Database (process, not code).
STIRSHAKEN_PRIVKEY_PATH="${STIRSHAKEN_PRIVKEY_PATH:-}"
STIRSHAKEN_CERT_URL="${STIRSHAKEN_CERT_URL:-}"
STIRSHAKEN_ATTEST_DEFAULT="${STIRSHAKEN_ATTEST_DEFAULT:-A}"
STIRSHAKEN_VERIFY="${STIRSHAKEN_VERIFY:-yes}"
STIRSHAKEN_CACHE_DIR="${STIRSHAKEN_CACHE_DIR:-/var/lib/kamailio/secsipid-cache}"

# TLS listener (5061). DEFAULT-OFF: the #!ifdef WITH_TLS blocks (listen, tls.so,
# tls modparam) compile in ONLY when TLS is enabled — via KAMAILIO_TLS_ENABLED=true
# OR implicitly by Teams (which mandates SIP/TLS). Cert/key paths are env-driven so
# a CA-issued cert (Teams: public CA, CN/SAN = TEAMS_SBC_FQDN) can be mounted;
# defaults are the self-signed dev cert baked into the image (dev/local only).
KAMAILIO_TLS_ENABLED="${KAMAILIO_TLS_ENABLED:-false}"
TLS_CERT_PATH="${TLS_CERT_PATH:-/etc/kamailio/tls/kamailio.crt}"
TLS_KEY_PATH="${TLS_KEY_PATH:-/etc/kamailio/tls/kamailio.key}"

# Microsoft Teams Direct Routing. DEFAULT-OFF: the #!ifdef WITH_TEAMS blocks
# compile in ONLY when TEAMS_DIRECT_ROUTING_ENABLED=true AND TEAMS_SBC_FQDN is set
# (Teams REQUIRES the SBC FQDN — never an IP — in Contact/Record-Route). Enabling
# Teams also forces WITH_TLS on. See report for the M365 tenant / DNS / CA-cert
# provisioning steps.
TEAMS_DIRECT_ROUTING_ENABLED="${TEAMS_DIRECT_ROUTING_ENABLED:-false}"
TEAMS_SBC_FQDN="${TEAMS_SBC_FQDN:-}"
# Stable urn:uuid for the SBC Contact +sip.instance. Generated per-boot (with a
# WARN) if unset while Teams is on — Teams prefers a STABLE value, so set it in .env.
TEAMS_SBC_INSTANCE="${TEAMS_SBC_INSTANCE:-}"
# Teams SIP-proxy FQDNs (Microsoft global default set; a regional set may be used).
TEAMS_SIP_PROXY_1="${TEAMS_SIP_PROXY_1:-sip.pstnhub.microsoft.com}"
TEAMS_SIP_PROXY_2="${TEAMS_SIP_PROXY_2:-sip2.pstnhub.microsoft.com}"
TEAMS_SIP_PROXY_3="${TEAMS_SIP_PROXY_3:-sip3.pstnhub.microsoft.com}"
# Microsoft-published Teams SIP-proxy signaling source ranges (inbound trust).
TEAMS_NET_1="${TEAMS_NET_1:-52.112.0.0/14}"
TEAMS_NET_2="${TEAMS_NET_2:-52.122.0.0/15}"

# Effective feature state. Teams requires both the flag AND an FQDN; TLS is on when
# explicitly enabled OR implied by Teams.
TEAMS_ON="no"
if [ "$TEAMS_DIRECT_ROUTING_ENABLED" = "true" ] && [ -n "$TEAMS_SBC_FQDN" ]; then
  TEAMS_ON="yes"
fi
TLS_ON="no"
if [ "$KAMAILIO_TLS_ENABLED" = "true" ] || [ "$TEAMS_ON" = "yes" ]; then
  TLS_ON="yes"
fi

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
# TC1/TC2 IPs appear in BOTH kamailio.cfg (#!define + routing/failover) and
# dispatcher.list (keepalive groups 4-5) — template both from the same vars.
sed -i "s|__BANDWIDTH_TC1_NY__|${BANDWIDTH_TC1_NY}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_TC1_ATL__|${BANDWIDTH_TC1_ATL}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_TC2_DAL__|${BANDWIDTH_TC2_DAL}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_TC2_LA__|${BANDWIDTH_TC2_LA}|g" "$CONFIG" "$DISPATCH"
# TC3/E911 IPs appear in kamailio.cfg (#!define + routing/failover) AND
# dispatcher.list (keepalive group 6) — template both from the same vars.
sed -i "s|__BANDWIDTH_E911_1__|${BANDWIDTH_E911_1}|g" "$CONFIG" "$DISPATCH"
sed -i "s|__BANDWIDTH_E911_2__|${BANDWIDTH_E911_2}|g" "$CONFIG" "$DISPATCH"

# ---- STIR/SHAKEN templating (default-OFF) ----
# Inject the WITH_STIRSHAKEN define ONLY when a signing key path is provided.
# When unset, the placeholder becomes a comment and the whole secsipid feature
# (module + params + routes, all inside #!ifdef WITH_STIRSHAKEN) is compiled out.
if [ -n "$STIRSHAKEN_PRIVKEY_PATH" ]; then
  sed -i "s|__STIRSHAKEN_IFDEF__|#!define WITH_STIRSHAKEN|" "$CONFIG"
  mkdir -p "$STIRSHAKEN_CACHE_DIR" 2>/dev/null || true
  chown kamailio:kamailio "$STIRSHAKEN_CACHE_DIR" 2>/dev/null || true
  echo "STIR/SHAKEN ENABLED: privkey=${STIRSHAKEN_PRIVKEY_PATH}, cert=${STIRSHAKEN_CERT_URL}, attest=${STIRSHAKEN_ATTEST_DEFAULT}, verify=${STIRSHAKEN_VERIFY}, cache=${STIRSHAKEN_CACHE_DIR}"
else
  sed -i "s|__STIRSHAKEN_IFDEF__|# STIR/SHAKEN disabled (STIRSHAKEN_PRIVKEY_PATH unset)|" "$CONFIG"
  echo "STIR/SHAKEN disabled (STIRSHAKEN_PRIVKEY_PATH unset)"
fi
# Escape sed-special chars (& | \) so a cert URL / path can't corrupt the sed RHS.
ss_esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
sed -i "s|__STIRSHAKEN_PRIVKEY__|$(ss_esc "$STIRSHAKEN_PRIVKEY_PATH")|g" "$CONFIG"
sed -i "s|__STIRSHAKEN_CERTURL__|$(ss_esc "$STIRSHAKEN_CERT_URL")|g" "$CONFIG"
sed -i "s|__STIRSHAKEN_ATTEST__|${STIRSHAKEN_ATTEST_DEFAULT}|g" "$CONFIG"
sed -i "s|__STIRSHAKEN_VERIFY__|${STIRSHAKEN_VERIFY}|g" "$CONFIG"
sed -i "s|__STIRSHAKEN_CACHEDIR__|$(ss_esc "$STIRSHAKEN_CACHE_DIR")|g" "$CONFIG"

# ---- TLS templating (default-OFF) ----
# Inject #!define WITH_TLS ONLY when TLS is on; otherwise the placeholder becomes a
# comment and the WITH_TLS listener/module/modparam compile out (byte-identical).
if [ "$TLS_ON" = "yes" ]; then
  sed -i "s|__WITH_TLS_IFDEF__|#!define WITH_TLS|" "$CONFIG"
  # Regenerate tls.cfg so a mounted CA cert (TLS_CERT_PATH/TLS_KEY_PATH) is used.
  # Teams requires a PUBLIC-CA cert whose CN/SAN matches TEAMS_SBC_FQDN.
  {
    echo '[server:default]'
    echo 'method = TLSv1.2+'
    echo 'verify_certificate = no'
    echo 'require_certificate = no'
    echo "private_key = ${TLS_KEY_PATH}"
    echo "certificate = ${TLS_CERT_PATH}"
    echo ''
    echo '[client:default]'
    echo 'method = TLSv1.2+'
    echo 'verify_certificate = no'
  } > /etc/kamailio/tls.cfg 2>/dev/null || true
  echo "TLS ENABLED: listener tls:${EXTERNAL_SIP_IP}:5061, cert=${TLS_CERT_PATH}, key=${TLS_KEY_PATH}"
else
  sed -i "s|__WITH_TLS_IFDEF__|# TLS disabled (KAMAILIO_TLS_ENABLED!=true and Teams off)|" "$CONFIG"
  echo "TLS disabled (KAMAILIO_TLS_ENABLED!=true and Teams off)"
fi

# ---- Microsoft Teams Direct Routing templating (default-OFF) ----
if [ "$TEAMS_ON" = "yes" ]; then
  # Generate a per-boot instance UUID if none supplied (WARN: prefer a stable one).
  if [ -z "$TEAMS_SBC_INSTANCE" ]; then
    TEAMS_SBC_INSTANCE="urn:uuid:$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo 00000000-0000-0000-0000-000000000000)"
    echo "TEAMS WARN: TEAMS_SBC_INSTANCE unset — generated ${TEAMS_SBC_INSTANCE} for this boot. Set a STABLE urn:uuid in .env."
  fi
  sed -i "s|__WITH_TEAMS_IFDEF__|#!define WITH_TEAMS|" "$CONFIG"
  # Teams string constants. ss_esc (defined above for STIR) guards sed-special
  # chars; the | delimiter keeps CIDR slashes safe.
  sed -i "s|__TEAMS_SBC_FQDN__|$(ss_esc "$TEAMS_SBC_FQDN")|g" "$CONFIG"
  sed -i "s|__TEAMS_SBC_INSTANCE__|$(ss_esc "$TEAMS_SBC_INSTANCE")|g" "$CONFIG"
  sed -i "s|__TEAMS_SIP_PROXY_1__|$(ss_esc "$TEAMS_SIP_PROXY_1")|g" "$CONFIG"
  sed -i "s|__TEAMS_SIP_PROXY_2__|$(ss_esc "$TEAMS_SIP_PROXY_2")|g" "$CONFIG"
  sed -i "s|__TEAMS_SIP_PROXY_3__|$(ss_esc "$TEAMS_SIP_PROXY_3")|g" "$CONFIG"
  sed -i "s|__TEAMS_NET_1__|$(ss_esc "$TEAMS_NET_1")|g" "$CONFIG"
  sed -i "s|__TEAMS_NET_2__|$(ss_esc "$TEAMS_NET_2")|g" "$CONFIG"
  # Teams OPTIONS keepalive (dispatcher group 7). Kept OUT of the committed
  # dispatcher.list so that file is byte-identical when Teams is off; appended to
  # the runtime copy ONLY when enabled.
  {
    echo ""
    echo "# ---- Group 7: Microsoft Teams SIP proxies (OPTIONS keepalive; Teams ON) ----"
    echo "7 sip:${TEAMS_SIP_PROXY_1}:5061;transport=tls 0 0 weight=100;duid=teams-proxy-1"
    echo "7 sip:${TEAMS_SIP_PROXY_2}:5061;transport=tls 0 0 weight=100;duid=teams-proxy-2"
    echo "7 sip:${TEAMS_SIP_PROXY_3}:5061;transport=tls 0 0 weight=100;duid=teams-proxy-3"
  } >> "$DISPATCH"
  echo "TEAMS ENABLED: SBC_FQDN=${TEAMS_SBC_FQDN}, proxies=${TEAMS_SIP_PROXY_1}/${TEAMS_SIP_PROXY_2}/${TEAMS_SIP_PROXY_3}, nets=${TEAMS_NET_1},${TEAMS_NET_2}"
else
  # When off, the __TEAMS_*__ placeholders remain ONLY inside #!ifdef WITH_TEAMS
  # blocks (which the preprocessor removes), so they never reach the parser.
  sed -i "s|__WITH_TEAMS_IFDEF__|# Teams Direct Routing disabled (TEAMS_DIRECT_ROUTING_ENABLED!=true or TEAMS_SBC_FQDN unset)|" "$CONFIG"
  echo "Teams Direct Routing disabled (TEAMS_DIRECT_ROUTING_ENABLED!=true or TEAMS_SBC_FQDN unset)"
fi

echo "Kamailio config templated: ADVERTISE_IP=${EXTERNAL_SIP_IP}, FS=${FREESWITCH_IP}, FS_PUBLIC_IP=${FS_PUBLIC_IP}, DB=${DB_HOST}:${DB_PORT}, Homer=${HOMER_IP}, HEP_ID=${HEP_CAPTURE_ID}, SBC_ID=${SBC_ID}, SBC_INTERNAL_IP=${SBC_INTERNAL_IP}, BW_PRIMARY=${BANDWIDTH_PRIMARY_IP}, BW_SECONDARY=${BANDWIDTH_SECONDARY_IP}, INTERNAL_SUBNET=${INTERNAL_SUBNET}, MEDIA_SUBNET=${MEDIA_SUBNET}, TLS=${TLS_ON}, TEAMS=${TEAMS_ON}"

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
