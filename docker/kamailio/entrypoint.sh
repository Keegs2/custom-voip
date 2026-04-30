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

echo "Kamailio config templated: ADVERTISE_IP=${EXTERNAL_SIP_IP}, FS=${FREESWITCH_IP}, FS_PUBLIC_IP=${FS_PUBLIC_IP}, DB=${DB_HOST}:${DB_PORT}, Homer=${HOMER_IP}, HEP_ID=${HEP_CAPTURE_ID}, SBC_ID=${SBC_ID}, SBC_INTERNAL_IP=${SBC_INTERNAL_IP}"

# Start Kamailio with all original arguments
exec /usr/sbin/kamailio "$@"
