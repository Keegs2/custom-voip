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

echo "Kamailio config templated: ADVERTISE_IP=${EXTERNAL_SIP_IP}, FS=${FREESWITCH_IP}, FS_PUBLIC_IP=${FS_PUBLIC_IP}, DB=${DB_HOST}:${DB_PORT}, Homer=${HOMER_IP}, HEP_ID=${HEP_CAPTURE_ID}, SBC_ID=${SBC_ID}, SBC_INTERNAL_IP=${SBC_INTERNAL_IP}, BW_PRIMARY=${BANDWIDTH_PRIMARY_IP}, BW_SECONDARY=${BANDWIDTH_SECONDARY_IP}, INTERNAL_SUBNET=${INTERNAL_SUBNET}, MEDIA_SUBNET=${MEDIA_SUBNET}"

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
