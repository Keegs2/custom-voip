#!/usr/bin/env bash
#
# seed-aliases.sh — Replace all Homer SIP capture aliases via REST API.
#
# Idempotent: deletes every existing alias, then creates the canonical set
# for the current host-networking architecture.
#
# Usage:
#   ./seed-aliases.sh                          # default: http://localhost:9080
#   HOMER_URL=http://homer-webapp:80 ./seed-aliases.sh   # inside Docker network
#
set -euo pipefail

HOMER_URL="${HOMER_URL:-http://localhost:9080}"
HOMER_USER="${HOMER_USER:-admin}"
HOMER_PASS="${HOMER_PASS:-sipcapture}"

# ---------- helpers ----------------------------------------------------------

die()  { echo "FATAL: $*" >&2; exit 1; }
info() { echo "  -> $*"; }

# ---------- discover the correct API prefix ----------------------------------
# Homer 7 ships two possible mount points for the alias CRUD endpoints.
# We probe both and use whichever returns HTTP 200.

discover_alias_path() {
  local token="$1"
  for candidate in "/api/v3/mapping/alias" "/api/v3/alias"; do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer ${token}" \
      "${HOMER_URL}${candidate}")
    if [ "$code" = "200" ] || [ "$code" = "201" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# ---------- authenticate -----------------------------------------------------

echo "Authenticating to Homer at ${HOMER_URL} ..."

AUTH_RESPONSE=$(curl -sf -X POST "${HOMER_URL}/api/v3/auth" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${HOMER_USER}\",\"password\":\"${HOMER_PASS}\"}") \
  || die "Authentication request failed. Is Homer running?"

TOKEN=$(echo "$AUTH_RESPONSE" | jq -r '.token // .data.token // empty')
[ -n "$TOKEN" ] || die "Could not extract JWT token from auth response: ${AUTH_RESPONSE}"

info "Authenticated (token ${TOKEN:0:12}...)"

# ---------- discover alias API path ------------------------------------------

echo "Discovering alias API path ..."
ALIAS_PATH=$(discover_alias_path "$TOKEN") \
  || die "Neither /api/v3/mapping/alias nor /api/v3/alias returned 200."

info "Using alias endpoint: ${ALIAS_PATH}"

# ---------- delete existing aliases ------------------------------------------

echo "Fetching existing aliases ..."

EXISTING=$(curl -sf -H "Authorization: Bearer ${TOKEN}" \
  "${HOMER_URL}${ALIAS_PATH}") \
  || die "Failed to list aliases."

# Homer may wrap the array in {"data":[...]} or return it bare.
ALIAS_IDS=$(echo "$EXISTING" | jq -r '
  if type == "array" then .[].id
  elif .data and (.data | type == "array") then .data[].id
  else empty
  end' 2>/dev/null)

if [ -z "$ALIAS_IDS" ]; then
  info "No existing aliases to delete."
else
  COUNT=$(echo "$ALIAS_IDS" | wc -l | tr -d ' ')
  echo "Deleting ${COUNT} existing alias(es) ..."
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      -H "Authorization: Bearer ${TOKEN}" \
      "${HOMER_URL}${ALIAS_PATH}/${id}")
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
      info "Deleted alias id=${id}"
    else
      echo "  WARNING: DELETE alias id=${id} returned HTTP ${HTTP_CODE}"
    fi
  done <<< "$ALIAS_IDS"
fi

# ---------- create new aliases -----------------------------------------------

# Each line: alias|ip|port
ALIASES=(
  "Bandwidth Dallas (Term)|67.231.2.12|5060"
  "Bandwidth LA (Term)|216.82.238.134|5060"
  "Bandwidth Origination|67.231.9.142|5060"
  "Bandwidth Origination 2|67.231.13.185|5060"
  "Kamailio SBC|0.0.0.0|5060"
  "Kamailio SBC (Public)|34.74.71.32|5060"
  "FreeSWITCH External|10.142.0.100|5090"
  "FreeSWITCH Internal|10.142.0.100|5080"
  "FreeSWITCH External (Public)|34.74.71.32|5090"
  "FreeSWITCH Internal (Public)|34.74.71.32|5080"
)

echo "Creating ${#ALIASES[@]} aliases ..."

FAILURES=0
for entry in "${ALIASES[@]}"; do
  IFS='|' read -r alias_name ip port <<< "$entry"

  PAYLOAD=$(jq -n \
    --arg alias "$alias_name" \
    --arg ip    "$ip" \
    --argjson port "$port" \
    '{
      alias:     $alias,
      ip:        $ip,
      port:      $port,
      mask:      32,
      captureID: "0",
      status:    true
    }')

  HTTP_CODE=$(curl -s -o /tmp/homer_alias_resp -w "%{http_code}" -X POST \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "${HOMER_URL}${ALIAS_PATH}")

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    info "Created: ${alias_name}  (${ip}:${port})"
  else
    BODY=$(cat /tmp/homer_alias_resp 2>/dev/null)
    echo "  ERROR: Failed to create '${alias_name}' — HTTP ${HTTP_CODE}: ${BODY}"
    FAILURES=$((FAILURES + 1))
  fi
done

# ---------- summary ----------------------------------------------------------

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "Done. All ${#ALIASES[@]} aliases created successfully."
else
  echo "Done with ${FAILURES} failure(s) out of ${#ALIASES[@]}."
  exit 1
fi
