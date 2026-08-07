#!/usr/bin/env bash
#
# deploy-sbc-verify.sh — enable STIR/SHAKEN INBOUND verification on ONE Kamailio SBC.
#
# Companion to deploy-sbc-signing.sh (same structure + safety idioms). Turns on
# OUR OWN inbound cryptographic verify (secsipid_check_identity) — Kamailio runs
# its own crypto check on each inbound Identity/PASSporT and records a verstat
# (TN-Validation-Passed/Failed) for Homer/CDR. It is 100% FAIL-OPEN: a failed
# verify NEVER rejects a call — the call always completes; only the annotation
# (and the stir_inbound_verstat metric) reflects the result.
#
# Run AS ROOT on the SBC (after `sudo git pull` in /opt/revup):
#   sudo /opt/revup/infra/stir/deploy-sbc-verify.sh            # wire CA bundle, verify OFF (dark)
#   sudo /opt/revup/infra/stir/deploy-sbc-verify.sh --enable   # turn inbound verify ON
#   sudo /opt/revup/infra/stir/deploy-sbc-verify.sh --disable  # roll verify back OFF (fast revert)
#   sudo /opt/revup/infra/stir/deploy-sbc-verify.sh --status   # show STIR_VERIFY_* env + recent verify logs
#
# PREREQUISITE — deliver the STI-PA trusted-root CA bundle first. Unlike the
# signing key it is NOT a secret (it's the public STI-PA trust list), but it IS a
# config artifact: never in git, delivered out-of-band per-SBC:
#   sudo mkdir -p /opt/revup/secrets && sudo tee /opt/revup/secrets/sti-pa-roots.pem   # paste, then Ctrl-D
#   (default path below; override with CA_SRC=/path). The script REFUSES to enable
#   (when CERT_MODE>0) unless the bundle exists, is non-empty, and parses as one or
#   more PEM CERTIFICATEs — an empty/garbage bundle fails EVERY inbound chain-trust,
#   flooding TN-Validation-Failed (fail-open, so calls still complete — but the
#   metric would be wrong).
#
# INDEPENDENT OF SIGNING. This script touches ONLY STIR_SHAKEN_VERIFY + the three
# STIR_VERIFY_* keys and the CA-file overlay. It NEVER reads or writes
# STIR_SHAKEN_SIGN / STIR_CERT_URL / STIR_KEY_PATH, and it applies the signing
# key overlay (docker-compose.stir-key.yml) WHEN PRESENT so a verify recreate
# never drops a live signing key mount. Verify and signing are independently
# toggleable in either order.
#
# Safe by design: idempotent; verify stays OFF unless --enable; on ANY config
# error it aborts and prints how to revert. Kamailio inbound verify is fail-open.

set -euo pipefail

# ---------------- config (override via environment) ----------------
REPO_DIR="${REPO_DIR:-/opt/revup}"
# STI-PA trusted-root bundle on the SBC (PUBLIC trust list; out-of-band, not git).
CA_SRC="${CA_SRC:-$REPO_DIR/secrets/sti-pa-roots.pem}"
# Fixed in-container path — MUST equal the mount target in docker-compose.stir-cafile.yml.
CA_CONTAINER_PATH="${CA_CONTAINER_PATH:-/etc/kamailio/stir/sti-pa-roots.pem}"
# CertVerify bitmask (libsecsipid). Default 5 = time|custCA — the STIR-correct
# minimum: verify PASSporT iat freshness AND chain the fetched x5u leaf to the
# STI-PA custom roots in CertCAFile. 7 (time|sysCA|custCA) additionally allows the
# OS/web trust store; harmless for STIR because STI certs chain to the STI-PA
# custom roots (NOT web CAs), so sysCA is simply never the anchor that matters.
# 0 = structural + JWT-signature only (NO chain) — the dark default; set >0 here.
CERT_MODE="${CERT_MODE:-5}"
# Overlays. The CA-file overlay is this feature's; the key overlay belongs to
# signing and is applied ONLY IF it already exists (so verify never drops it).
CAFILE_OVERRIDE="${CAFILE_OVERRIDE:-$REPO_DIR/docker-compose.stir-cafile.yml}"
KEY_OVERRIDE="${KEY_OVERRIDE:-$REPO_DIR/docker-compose.stir-key.yml}"
COMPOSE_SBC="$REPO_DIR/docker-compose.sbc.yml"
KAM="voip-kamailio"

# Egress pre-check hosts — secsipid must reach each caller's x5u over :443. Probe
# our own x5u (always live) + a well-known STI x5u host. Space-separated; WARN
# (not fail) if unreachable. Override via EGRESS_HOSTS="url1 url2".
EGRESS_HOSTS="${EGRESS_HOSTS:-https://fs-cert.granitevoip.com/healthz https://authenticate-api.iconectiv.com/healthz}"

ok(){   echo "  [OK]   $*"; }
info(){ echo "  [..]   $*"; }
warn(){ echo "  [WARN] $*" >&2; }
die(){  echo "  [FAIL] $*" >&2; exit 1; }
trap 'echo "  [FAIL] aborted at line $LINENO — inbound verify was NOT changed beyond any [OK] lines above." >&2' ERR

# ---------------- args ----------------
ACTION=setup
case "${1:-}" in
  ""|--setup) ACTION=setup ;;
  --enable)   ACTION=enable ;;
  --disable)  ACTION=disable ;;
  --status)   ACTION=status ;;
  -h|--help)
    cat <<'USAGE'
deploy-sbc-verify.sh — STIR/SHAKEN INBOUND verify on one Kamailio SBC (run as root):
  sudo deploy-sbc-verify.sh            wire CA bundle + overlay, build, verify OFF (dark)
  sudo deploy-sbc-verify.sh --enable   turn inbound verify ON (recreates kamailio)
  sudo deploy-sbc-verify.sh --disable  roll inbound verify back OFF (fast revert)
  sudo deploy-sbc-verify.sh --status   show STIR_VERIFY_* env + recent verify logs
Prerequisite: place the STI-PA trusted-root bundle at /opt/revup/secrets/sti-pa-roots.pem
first (PUBLIC trust list; out-of-band, never git). Fail-open: verify never drops calls.
Independent of signing — does not touch STIR_SHAKEN_SIGN / the signing key.
USAGE
    exit 0 ;;
  *) die "unknown argument '$1' (try --help)" ;;
esac

# ---------------- preflight (every action) ----------------
[ "$(id -u)" = 0 ]                 || die "run as root:  sudo $0 ${1:-}"
command -v docker >/dev/null       || die "docker not found"
[ -d "$REPO_DIR" ]                 || die "$REPO_DIR not found"
cd "$REPO_DIR"
docker ps --format '{{.Names}}' | grep -qx "$KAM" \
  || die "container '$KAM' is not running here — this is NOT an SBC. Run on an SBC VM."
[ -f "$COMPOSE_SBC" ]              || die "$COMPOSE_SBC missing — did you 'sudo git pull'?"
[ -f "$CAFILE_OVERRIDE" ]          || die "$CAFILE_OVERRIDE missing — did you 'sudo git pull'? (Deliverable B)"
ok "on SBC $(hostname); $KAM present"

# Build the `-f` compose args as a proper array. Base + CA-file overlay always;
# the SIGNING key overlay is included ONLY IF it exists, so recreating kamailio
# for verify NEVER drops a live signing-key mount (verify and signing coexist).
# Each token is its own array element — never one "-f /path" string.
build_compose_args(){
  CF=(-f "$COMPOSE_SBC")
  [ -f "$KEY_OVERRIDE" ]    && CF+=(-f "$KEY_OVERRIDE")
  CF+=(-f "$CAFILE_OVERRIDE")
  return 0
}

# Recreate kamailio with ALL overlays and hard-verify config + health. Shared by
# setup/enable/disable so every path recreates with the identical overlay set and
# never uses --remove-orphans (would delete the base-only sidecars). $1 = a label
# for the log line (e.g. "verify=on"). Uses CA_SRC from the environment so the
# CA-file overlay resolves its bind source.
recreate_and_check(){
  local label="$1"
  build_compose_args
  info "recreating kamailio ($label) with overlays: ${CF[*]} — brief restart; the NLB covers it ..."
  CA_SRC="$CA_SRC" docker compose "${CF[@]}" up -d --build kamailio
  sleep 5
  if ! docker exec "$KAM" kamailio -c -f /etc/kamailio/kamailio.cfg >/tmp/_kamcheck.$$ 2>&1; then
    echo "  ---- kamailio -c output ----"; tail -20 /tmp/_kamcheck.$$ | sed 's/^/  /'; rm -f /tmp/_kamcheck.$$
    die "kamailio config-check FAILED ($label). Revert now:  sudo $0 --disable"
  fi
  rm -f /tmp/_kamcheck.$$
  sleep 2
  local stat
  stat="$(docker ps --filter "name=$KAM" --format '{{.Status}}')"
  echo "$stat" | grep -qi '^up' || die "kamailio is not up after the change: '$stat'. Revert:  sudo $0 --disable"
  ok "config valid + container up ($stat)"
}

# ---------------- status ----------------
if [ "$ACTION" = status ]; then
  echo "STIR verify settings in .env:"
  grep -E '^STIR_(SHAKEN_VERIFY|VERIFY_)' .env 2>/dev/null | sed 's/^/    /' || info "none set"
  echo "CA bundle ($CA_SRC):"
  if [ -s "$CA_SRC" ]; then
    n=$(grep -c 'BEGIN CERTIFICATE' "$CA_SRC" 2>/dev/null || echo 0)
    echo "    present, ${n} PEM CERTIFICATE block(s)"
  else
    info "absent or empty"
  fi
  echo "kamailio:"; docker ps --filter "name=$KAM" --format '    {{.Names}}: {{.Status}}'
  echo "recent inbound-verify activity (last 15m):"
  docker logs --since 15m "$KAM" 2>&1 | grep -iE 'STIR verify:|STIR verstat:' | tail -12 | sed 's/^/    /' || info "none"
  echo "  (fail-open: a FAIL never drops a call — annotation/metric only.)"
  exit 0
fi

# ---------------- disable (fast rollback) ----------------
# Flip STIR_SHAKEN_VERIFY off and recreate. Leaves STIR_VERIFY_* keys + the CA
# mount in place (inert with verify off) so re-enabling is one flag. Does NOT
# touch signing.
if [ "$ACTION" = disable ]; then
  sed -i '/^STIR_SHAKEN_VERIFY=/d' .env; echo 'STIR_SHAKEN_VERIFY=off' >> .env
  recreate_and_check "verify=off"
  ok "inbound verify DISABLED; kamailio recreated; config valid (signing untouched)"
  exit 0
fi

# ================ setup / enable ================
echo "== STIR/SHAKEN inbound verify $ACTION on $(hostname) =="

# 1) HARD GUARD (when CERT_MODE>0): the CA bundle must exist, be non-empty, and
#    parse as one-or-more PEM CERTIFICATEs. Rationale: with a chain-validating
#    mode, an empty/garbage bundle fails EVERY inbound Identity's chain-trust →
#    a flood of TN-Validation-Failed. Fail-open keeps calls up, but the metric
#    lies. With CERT_MODE=0 (no chain) the bundle is never opened, so skip.
if [ "$CERT_MODE" -gt 0 ] 2>/dev/null; then
  [ -f "$CA_SRC" ] || die "CA bundle not found at $CA_SRC — deliver the STI-PA trusted-root list there first (PUBLIC, out-of-band, never git). See:  $0 --help"
  [ -s "$CA_SRC" ] || die "CA bundle $CA_SRC is EMPTY — an empty bundle fails every inbound chain-trust. Deliver the real STI-PA root list."
  # Prefer crl2pkcs7 (accepts a multi-cert bundle in one shot); fall back to a
  # per-block x509 parse. Either proves >=1 real PEM CERTIFICATE, not garbage.
  if openssl crl2pkcs7 -nocrl -certfile "$CA_SRC" >/dev/null 2>&1; then
    :
  elif openssl x509 -in "$CA_SRC" -noout >/dev/null 2>&1; then
    :
  else
    die "CA bundle $CA_SRC does not parse as PEM CERTIFICATE(s) — refusing to enable a chain-validating mode with a garbage bundle (would flood TN-Validation-Failed). Fix the file, or set CERT_MODE=0 for a structural-only dark run."
  fi
  NCERTS=$(grep -c 'BEGIN CERTIFICATE' "$CA_SRC" 2>/dev/null || echo 0)
  ok "CA bundle valid: $NCERTS PEM CERTIFICATE block(s) in $CA_SRC (CERT_MODE=$CERT_MODE)"
else
  info "CERT_MODE=0 (structural + JWT-signature only, no chain) — CA bundle not required; verify will not open it"
fi

# 2) EGRESS pre-check: secsipid must fetch each caller's x5u over :443. Confirm
#    outbound HTTPS works from THIS SBC. Read-only HEAD-ish GET, 5s cap, output
#    discarded. LOUD WARN (not a hard fail) if a host is unreachable — a firewall
#    that blocks :443 egress would make every self-verify time out → fail-open
#    FAIL flood, but that's an operational warning, not a reason to refuse setup.
info "egress pre-check (outbound :443 for x5u fetch) ..."
EGRESS_OK=0
for u in $EGRESS_HOSTS; do
  if curl -sS --max-time 5 -o /dev/null "$u" 2>/dev/null; then
    ok "reachable: $u"
    EGRESS_OK=1
  else
    warn "unreachable: $u (secsipid x5u fetch may time out → fail-open FAILs)"
  fi
done
[ "$EGRESS_OK" = 1 ] || warn "NO egress host reachable — verify will fail-open on EVERY call until outbound :443 works. Enabling anyway (fail-open is safe); FIX egress before trusting the metric."

# 3) .env — point kamailio at the CA bundle + mode. Container path is FIXED and
#    MUST equal the overlay's mount target. We rewrite all three STIR_VERIFY_*
#    keys idempotently. STIR_VERIFY_CA_INTER stays empty: STI x5u endpoints serve
#    their OWN intermediate in the fetched chain (x5u = leaf+intermediate), so the
#    intermediate arrives with the caller's cert — CertCAFile carries the ROOTS only.
sed -i '/^STIR_VERIFY_CERT_MODE=/d;/^STIR_VERIFY_CA_FILE=/d;/^STIR_VERIFY_CA_INTER=/d' .env
{ echo "STIR_VERIFY_CERT_MODE=$CERT_MODE"; echo "STIR_VERIFY_CA_FILE=$CA_CONTAINER_PATH"; echo "STIR_VERIFY_CA_INTER="; } >> .env
ok ".env -> CERT_MODE=$CERT_MODE, CA_FILE=$CA_CONTAINER_PATH, CA_INTER=<empty>"

# 4) CA_SRC must reach docker compose so the CA-file overlay resolves its bind
#    source. Persist it in .env (idempotent) as well as exporting it for the
#    recreate below — a bind mount with a missing SOURCE makes Compose refuse to
#    start, and we already validated the file exists in step 1 (when CERT_MODE>0).
sed -i '/^CA_SRC=/d' .env; echo "CA_SRC=$CA_SRC" >> .env
ok ".env -> CA_SRC=$CA_SRC (CA-file overlay bind source)"

# 5) verify toggle for this action (default off on setup; on for --enable). This
#    is the ONLY key that flips call behavior; STIR_SHAKEN_SIGN is never touched.
if [ "$ACTION" = enable ]; then VERIFY=on; else VERIFY=off; fi
sed -i '/^STIR_SHAKEN_VERIFY=/d' .env; echo "STIR_SHAKEN_VERIFY=$VERIFY" >> .env

# 6) build (installs secsipid) + (re)create with ALL overlays, then HARD-verify.
recreate_and_check "verify=$VERIFY"

# 7) report
echo
if [ "$VERIFY" = on ]; then
  ok "STIR/SHAKEN INBOUND verify is ENABLED on $(hostname) (CERT_MODE=$CERT_MODE)."
  info "FAIL-OPEN: a failed verify NEVER drops a call — it only records TN-Validation-Failed + the metric."
  info "Place a test call to +16174544217, then:  sudo $0 --status"
  info "Look for a 'STIR verify: PASS/FAIL ...' line; cross-check the verstat in Homer / the CDR."
  info "Signing is independent and UNCHANGED (STIR_SHAKEN_SIGN not touched by this script)."
else
  ok "Dark deploy complete on $(hostname): CA bundle mounted, secsipid installed, inbound verify OFF."
  info "Call path is byte-identical to before. Place a NORMAL call to confirm no regression, then:  sudo $0 --enable"
  info "Signing is independent and UNCHANGED (STIR_SHAKEN_SIGN not touched by this script)."
fi
