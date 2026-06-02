#!/usr/bin/env bash
# Apply per-zone, per-role .env values (non-secret infra) to /opt/revup/.env.
#
# Workflow: this lives in the repo, you `git pull` it onto the VM and run it.
# It upserts ONLY the zone-specific keys (IPs / identity / carrier PoPs / subnets).
# Secrets inherited from the cloned image — DB_PASS, ESL_PASSWORD, DB_USER, etc. —
# are NEVER touched here, so they stay as-is.
#
# Usage:  sudo bash scripts/apply-zone-env.sh <role>
#   roles: west-sbc-1 | west-sbc-2 | west-fs   (extend the case block for central-*)
#
# After running, redeploy:
#   SBC:  sudo docker compose -f docker-compose.sbc.yml   up -d --build
#   FS:   sudo docker compose -f docker-compose.media.yml up -d --build
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/revup/.env}"
ROLE="${1:?usage: apply-zone-env.sh <role>  (west-sbc-1|west-sbc-2|west-fs)}"

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found (is this the right VM?)" >&2; exit 1; }

upsert() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"
  else
    echo "${k}=${v}" >> "$ENV_FILE"
  fi
}

# Centralized shared services (East) — same for every zone
HOMER_IP=10.142.0.103
API_HOST=10.142.0.103
# DB_HOST: interim = East primary (cross-region). Flip to the local West replica
# (10.138.0.103) once Step 5 of WEST_ZONE_BUILDOUT.md is done.
DB_HOST=10.142.0.103

case "$ROLE" in
  west-sbc-1|west-sbc-2)
    upsert EXTERNAL_SIP_IP        35.252.214.40       # West regional NLB VIP (added to lo by entrypoint)
    upsert FS_PUBLIC_IP           8.229.177.165       # west-fs public IP (SDP rewrite target)
    upsert FREESWITCH_IP          192.168.20.2        # west-fs internal IP (dispatcher target)
    upsert DB_HOST                "$DB_HOST"
    upsert HOMER_IP               "$HOMER_IP"
    upsert BANDWIDTH_PRIMARY_IP   216.82.238.134      # LA (West's nearest PoP)
    upsert BANDWIDTH_SECONDARY_IP 67.231.2.12         # Dallas (failover)
    upsert INTERNAL_SUBNET        10.138.0.0/20
    upsert MEDIA_SUBNET           192.168.20.0/24
    if [ "$ROLE" = west-sbc-1 ]; then
      upsert SBC_INTERNAL_IP 10.138.0.100
      upsert HEP_CAPTURE_ID  110
      upsert SBC_ID          west-sbc-1
    else
      upsert SBC_INTERNAL_IP 10.138.0.101
      upsert HEP_CAPTURE_ID  111
      upsert SBC_ID          west-sbc-2
    fi
    ;;
  west-fs)
    upsert EXTERNAL_SIP_IP        8.229.177.165       # west-fs public IP (SDP/RTP source)
    upsert EXTERNAL_RTP_IP        8.229.177.165
    upsert DB_HOST                "$DB_HOST"
    upsert API_HOST               "$API_HOST"
    upsert HOMER_IP               "$HOMER_IP"
    upsert SBC_PROXY_IP           10.138.0.100        # west-sbc-1 (outbound bridge target)
    upsert SBC_PROXY_IP_FAILOVER  10.138.0.101        # west-sbc-2 (4-attempt failover)
    upsert TEST_MODE              false
    ;;
  *)
    echo "ERROR: unknown role '$ROLE' (expected west-sbc-1|west-sbc-2|west-fs)" >&2
    exit 1
    ;;
esac

echo "Applied '$ROLE' zone env to $ENV_FILE. Zone keys now:"
grep -E "^(EXTERNAL_SIP_IP|EXTERNAL_RTP_IP|SBC_INTERNAL_IP|FS_PUBLIC_IP|FREESWITCH_IP|SBC_ID|HEP_CAPTURE_ID|DB_HOST|BANDWIDTH_PRIMARY_IP|BANDWIDTH_SECONDARY_IP|INTERNAL_SUBNET|MEDIA_SUBNET|SBC_PROXY_IP|SBC_PROXY_IP_FAILOVER|TEST_MODE)=" "$ENV_FILE"
