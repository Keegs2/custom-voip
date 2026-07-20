#!/bin/sh
# =============================================================================
# coturn entrypoint — env-driven config templating (fail-closed).
# =============================================================================
# WHY (audit finding): coturn cannot expand env vars inside turnserver.conf,
# so the compose-level TURN_SECRET was inert and a COMMITTED dev secret
# ("dev-turn-secret-change-me") was what an internet-reachable TURN relay
# actually authenticated with — a free relay for anyone who reads this repo.
#
# HOW: the committed turnserver.conf no longer contains ANY secret. At
# container start this script builds /tmp/turnserver.runtime.conf from the
# mounted base config + environment, refusing to start when TURN_SECRET is
# missing or still the dev sentinel (unless ALLOW_DEV_TURN_SECRET=true, which
# only the local dev compose sets). Compose runs this via:
#     entrypoint: ["/bin/sh", "/coturn/entrypoint.sh"]
#
# Environment:
#   TURN_SECRET            REQUIRED. Must equal the API's TURN_SECRET.
#   TURN_REALM             default voip.local — must equal the API's TURN_REALM.
#   ALLOW_DEV_TURN_SECRET  "true" ONLY in local dev compose; permits the sentinel.
#   TURN_CLI_PASSWORD      optional; default = random per boot (CLI on loopback).
#   TURN_EXTERNAL_IP       optional; GCE 1:1 NAT needs this = the VM PUBLIC IP,
#                          else relay candidates advertise the VPC-internal IP
#                          and relayed media dies. Media compose passes it.
#   TURN_DENY_PRIVATE      default true: refuse relaying to RFC1918/loopback/
#                          link-local peers (blocks pivoting into the VPC, incl.
#                          the metadata server). Dev compose sets false.
#   TURN_MIN_PORT/MAX_PORT optional relay port range override.
# =============================================================================
set -eu

BASE="${TURN_BASE_CONF:-/etc/coturn/turnserver.conf}"
RUN="/tmp/turnserver.runtime.conf"
DEV_SENTINEL="dev-turn-secret-change-me"

say() { echo "[coturn-entrypoint] $*"; }
fail() { echo "[coturn-entrypoint] FATAL: $*" >&2; exit 1; }

[ -r "$BASE" ] || fail "base config not readable at ${BASE} (is the volume mounted?)"

# --- Fail-closed secret checks ------------------------------------------------
TURN_SECRET="${TURN_SECRET:-}"
[ -n "$TURN_SECRET" ] || fail "TURN_SECRET is not set. Refusing to start a relay without a real secret. Set TURN_SECRET in /opt/revup/.env (openssl rand -hex 32) — it must match the Services VM API's TURN_SECRET."
if [ "$TURN_SECRET" = "$DEV_SENTINEL" ] && [ "${ALLOW_DEV_TURN_SECRET:-false}" != "true" ]; then
    fail "TURN_SECRET is still the committed dev sentinel — an internet-reachable relay with a public secret is a relay-abuse hole. Set a real TURN_SECRET in /opt/revup/.env."
fi

TURN_REALM="${TURN_REALM:-voip.local}"

# CLI password: random per boot unless pinned (CLI is loopback-only below).
if [ -n "${TURN_CLI_PASSWORD:-}" ]; then
    CLI_PW="$TURN_CLI_PASSWORD"
else
    CLI_PW="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

# --- Build the runtime config ---------------------------------------------------
# Strip every directive we own from the base so env always wins and no stale
# committed value can survive.
grep -vE '^[[:space:]]*(static-auth-secret|cli-password|cli-ip|realm|external-ip)=' "$BASE" > "$RUN"

{
    echo ""
    echo "# ---- injected by docker/coturn/entrypoint.sh (env-driven) ----"
    echo "static-auth-secret=${TURN_SECRET}"
    echo "realm=${TURN_REALM}"
    echo "cli-ip=127.0.0.1"
    echo "cli-password=${CLI_PW}"
} >> "$RUN"

if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
    echo "external-ip=${TURN_EXTERNAL_IP}" >> "$RUN"
    say "advertising external-ip=${TURN_EXTERNAL_IP} (GCE 1:1 NAT)"
fi

if [ -n "${TURN_MIN_PORT:-}" ] && [ -n "${TURN_MAX_PORT:-}" ]; then
    grep -vE '^[[:space:]]*(min-port|max-port)=' "$RUN" > "${RUN}.tmp" && mv "${RUN}.tmp" "$RUN"
    {
        echo "min-port=${TURN_MIN_PORT}"
        echo "max-port=${TURN_MAX_PORT}"
    } >> "$RUN"
    say "relay port range ${TURN_MIN_PORT}-${TURN_MAX_PORT}"
fi

if [ "${TURN_DENY_PRIVATE:-true}" = "true" ]; then
    {
        echo "denied-peer-ip=0.0.0.0-0.255.255.255"
        echo "denied-peer-ip=10.0.0.0-10.255.255.255"
        echo "denied-peer-ip=100.64.0.0-100.127.255.255"
        echo "denied-peer-ip=127.0.0.0-127.255.255.255"
        echo "denied-peer-ip=169.254.0.0-169.254.255.255"
        echo "denied-peer-ip=172.16.0.0-172.31.255.255"
        echo "denied-peer-ip=192.168.0.0-192.168.255.255"
    } >> "$RUN"
    say "private/loopback/link-local relay peers DENIED (VPC pivot protection)"
else
    say "TURN_DENY_PRIVATE=false — private peers allowed (dev only)"
fi

# --- Arm turns: TLS automatically when a cert is mounted ------------------------
CERT_DIR="/etc/coturn/certs"
if [ -f "${CERT_DIR}/fullchain.pem" ] && [ -f "${CERT_DIR}/privkey.pem" ]; then
    {
        echo "cert=${CERT_DIR}/fullchain.pem"
        echo "pkey=${CERT_DIR}/privkey.pem"
        echo "cipher-list=\"ECDHE+AESGCM:!aNULL:!MD5\""
    } >> "$RUN"
    [ -f "${CERT_DIR}/dhparam.pem" ] && echo "dh-file=${CERT_DIR}/dhparam.pem" >> "$RUN"
    say "turns: TLS armed from ${CERT_DIR}"
else
    say "no cert at ${CERT_DIR}/fullchain.pem — turns: TLS not armed (plain STUN/TURN only)"
fi

say "starting turnserver (realm=${TURN_REALM}, secret=<redacted>, cli=loopback+random-pw)"
exec turnserver -c "$RUN" "$@"
