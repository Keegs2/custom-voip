#!/usr/bin/env bash
# Create the West (us-west1) regional external passthrough NLB — mirrors East's
# sbc-health-check / sbc-group / sbc-backend / sbc-vip-{udp,tcp}.
#
# Run from a workstation with gcloud authed (NOT on a VM):  bash scripts/create-west-nlb.sh
# Idempotent: safe to re-run — already-existing resources just report and continue.
#
# Prereqs already done: west-sbc-1/2 VMs exist, west-sbc-vip (35.252.214.40) reserved.
set -uo pipefail

PROJECT="${PROJECT:-rugged-night-193017}"
REGION="${REGION:-us-west1}"
ZONE="${ZONE:-us-west1-b}"

run() { echo "+ $*"; "$@" || echo "  (continuing — resource may already exist)"; echo; }

# 1. Regional TCP:5060 health check (mirror sbc-health-check)
run gcloud compute health-checks create tcp west-sbc-health-check \
  --region="$REGION" --port=5060 --check-interval=5s --timeout=5s \
  --healthy-threshold=2 --unhealthy-threshold=3 --project="$PROJECT"

# 2. Unmanaged instance group + the two West SBCs (mirror sbc-group)
run gcloud compute instance-groups unmanaged create west-sbc-group \
  --zone="$ZONE" --project="$PROJECT"
run gcloud compute instance-groups unmanaged add-instances west-sbc-group \
  --zone="$ZONE" --instances=west-sbc-1,west-sbc-2 --project="$PROJECT"

# 3. Regional backend service: EXTERNAL / UNSPECIFIED / CLIENT_IP (mirror sbc-backend)
run gcloud compute backend-services create west-sbc-backend \
  --region="$REGION" --load-balancing-scheme=EXTERNAL --protocol=UNSPECIFIED \
  --session-affinity=CLIENT_IP --health-checks=west-sbc-health-check \
  --health-checks-region="$REGION" --project="$PROJECT"

# 4. Attach the instance group
run gcloud compute backend-services add-backend west-sbc-backend \
  --region="$REGION" --instance-group=west-sbc-group \
  --instance-group-zone="$ZONE" --project="$PROJECT"

# 5. UDP + TCP forwarding rules on the reserved VIP (west-sbc-vip = 35.252.214.40)
run gcloud compute forwarding-rules create west-sbc-vip-udp \
  --region="$REGION" --load-balancing-scheme=EXTERNAL --address=west-sbc-vip \
  --ip-protocol=UDP --ports=5060 --backend-service=west-sbc-backend --project="$PROJECT"
run gcloud compute forwarding-rules create west-sbc-vip-tcp \
  --region="$REGION" --load-balancing-scheme=EXTERNAL --address=west-sbc-vip \
  --ip-protocol=TCP --ports=5060 --backend-service=west-sbc-backend --project="$PROJECT"

echo "=== West NLB build complete. Verify backend health (give it ~30s): ==="
echo "gcloud compute backend-services get-health west-sbc-backend --region=$REGION --project=$PROJECT"
