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
# PREREQUISITE — deliver the STI-PA trusted-CA bundle first. Unlike the signing
# key it is NOT a secret (it's the public STI-PA trust list), but it IS a config
# artifact: never in git, delivered out-of-band per-SBC. The lifecycle tooling
# does it for you (see docs/STIR_TRUST_BUNDLE_RUNBOOK.md):
#   sudo /opt/revup/infra/stir/refresh-sbc-trust-bundle.sh --install
# pulls the published bundle from https://fs-cert.granitevoip.com/stir/
# sti-pa-trust-bundle.pem, runs the validation gates, and installs it at the
# default CA_SRC below (override with CA_SRC=/path). This script REFUSES to
# enable (when CERT_MODE>0) unless the bundle exists, is non-empty, and parses
# as one or more PEM CERTIFICATEs — an empty/garbage bundle fails EVERY inbound
# chain-trust, flooding TN-Validation-Failed (fail-open, so calls still complete
# — but the metric would be wrong).
#
# BUNDLE REFRESH NEEDS NO RE-RUN OF THIS SCRIPT: the overlay mounts the CA
# DIRECTORY (CA_DIR) — not the file — so the refresh script's atomic rename is
# visible in-container instantly, and libsecsipid re-reads CertCAFile on every
# verification. Re-run this script only to change the MODE/toggle wiring.
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
# STI-PA trusted-CA bundle on the SBC (PUBLIC trust list; out-of-band, not git;
# installed + refreshed by refresh-sbc-trust-bundle.sh). CA_DIR is the bind
# SOURCE of the overlay's DIRECTORY mount; CA_SRC is the bundle file inside it.
CA_SRC="${CA_SRC:-$REPO_DIR/secrets/stir-ca/sti-pa-trust-bundle.pem}"
CA_DIR="${CA_DIR:-$(dirname "$CA_SRC")}"
# Fixed in-container path — MUST equal the overlay's dir mount target
# (/etc/kamailio/stir/ca) + the bundle filename.
CA_CONTAINER_PATH="${CA_CONTAINER_PATH:-/etc/kamailio/stir/ca/$(basename "$CA_SRC")}"
# CertVerify bitmask (libsecsipid). Bit meanings verified against the secsipidx
# source (secsipid/secsipid.go, consts at lines ~143-148 + pubKeyVerify):
#   1  (1<<0) CertVerifyOptTime    — x5u CERTIFICATE validity window
#             (NotBefore/NotAfter of the fetched leaf; pubKeyVerify time block).
#             NOTE: NOT the PASSporT iat — iat freshness is checked separately
#             and UNCONDITIONALLY in SJWTGetValidPayload ("payload.IAT == 0 ||
#             now > IAT+expire" -> expired token), independent of CertVerify.
#   2  (1<<1) CertVerifyOptSysCA   — OS trust store as chain roots
#   4  (1<<2) CertVerifyOptCustCA  — CertCAFile contents as chain roots
#   8  (1<<3) CertVerifyOptInterCA — CertCAInter file into the intermediates pool
#   16 (1<<4) CertVerifyOptCRL     — leaf serial screened against CertCRLFile
#   32 (1<<5) CertVerifyOptTimeOnly— time check then STOP (no chain) — never use
# Default 5 = time|custCA — the STIR-correct chain mode: leaf validity window +
# chain the fetched x5u to the STI-PA roots in CertCAFile. 7 adds sysCA;
# harmless but pointless (STI certs chain to STI-PA roots, not web CAs).
# 21 = 5|16 adds CRL screening — ONLY set once the CRL lifecycle is live on this
# SBC (refresh scripts publish/pull sti-pa-crl.pem): with bit 16 set, a missing
# CertCRLFile fails every chain-verify, and secsipidx's CRL branch ignores the
# x509.ParseCRL error before dereferencing — a corrupt CRL file would nil-panic
# the Go runtime inside Kamailio. The refresh gates + atomic rename guarantee
# only a validated CRL ever lands on disk; the guard below refuses bit 16
# without a parseable CRL.
# 0 = structural + JWT-signature only (NO chain) — the dark default; set >0 here.
CERT_MODE="${CERT_MODE:-5}"
# STI-PA CRL on the SBC (only consumed with bit 16). Lives in the SAME CA_DIR
# directory mount, so no extra overlay is needed.
CRL_SRC="${CRL_SRC:-$CA_DIR/sti-pa-crl.pem}"
CRL_CONTAINER_PATH="${CRL_CONTAINER_PATH:-/etc/kamailio/stir/ca/$(basename "$CRL_SRC")}"
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
Prerequisite: install the STI-PA trusted-CA bundle first (PUBLIC list, never git):
  sudo /opt/revup/infra/stir/refresh-sbc-trust-bundle.sh --install
(lands it at /opt/revup/secrets/stir-ca/sti-pa-trust-bundle.pem; the cron keeps it
fresh with no restarts). Fail-open: verify never drops calls.
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
# for the log line (e.g. "verify=on"). Uses CA_DIR from the environment so the
# CA-dir overlay resolves its bind source.
recreate_and_check(){
  local label="$1"
  build_compose_args
  info "recreating kamailio ($label) with overlays: ${CF[*]} — brief restart; the NLB covers it ..."
  CA_DIR="$CA_DIR" docker compose "${CF[@]}" up -d --build kamailio
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
  [ -f "$CA_SRC" ] || die "CA bundle not found at $CA_SRC — install it first:  sudo $REPO_DIR/infra/stir/refresh-sbc-trust-bundle.sh --install   (pulls the published STI-PA list + runs the validation gates). See:  $0 --help"
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

# 1b) HARD GUARD for CRL mode (bit 16): the CRL must exist and PARSE. This is
#     stricter than hygiene — secsipidx's pubKeyVerify CRL branch ignores the
#     x509.ParseCRL error and dereferences the result, so a corrupt CertCRLFile
#     nil-panics the Go runtime inside Kamailio (cgo panic = process abort),
#     and a MISSING file fails every chain-verify (SJWTRetErrCertNoCRLFile).
if [ $(( CERT_MODE & 16 )) -ne 0 ] 2>/dev/null; then
  [ -s "$CRL_SRC" ] || die "CERT_MODE=$CERT_MODE has the CRL bit (16) but $CRL_SRC is missing/empty — pull it first:  sudo $REPO_DIR/infra/stir/refresh-sbc-trust-bundle.sh --install   (requires the publisher to be serving /stir/sti-pa-crl.pem), or drop to CERT_MODE=5"
  openssl crl -in "$CRL_SRC" -noout >/dev/null 2>&1 \
    || die "$CRL_SRC does not parse as a PEM CRL — refusing bit 16 (a corrupt CertCRLFile would PANIC libsecsipid inside Kamailio; secsipidx pubKeyVerify ignores the ParseCRL error). Re-pull with refresh-sbc-trust-bundle.sh --install"
  if ! openssl crl -in "$CRL_SRC" -noout -nextupdate 2>/dev/null | grep -q '=' ; then
    warn "could not read CRL nextUpdate — check the file"
  fi
  ok "CRL valid for bit 16: $CRL_SRC (nextUpdate $(openssl crl -in "$CRL_SRC" -noout -nextupdate 2>/dev/null | cut -d= -f2))"
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
sed -i '/^STIR_VERIFY_CERT_MODE=/d;/^STIR_VERIFY_CA_FILE=/d;/^STIR_VERIFY_CA_INTER=/d;/^STIR_VERIFY_CRL_FILE=/d' .env
{ echo "STIR_VERIFY_CERT_MODE=$CERT_MODE"; echo "STIR_VERIFY_CA_FILE=$CA_CONTAINER_PATH"; echo "STIR_VERIFY_CA_INTER="; echo "STIR_VERIFY_CRL_FILE=$CRL_CONTAINER_PATH"; } >> .env
ok ".env -> CERT_MODE=$CERT_MODE, CA_FILE=$CA_CONTAINER_PATH, CA_INTER=<empty>, CRL_FILE=$CRL_CONTAINER_PATH (read only when CERT_MODE has bit 16)"

# 4) CA_DIR must reach docker compose so the CA-dir overlay resolves its bind
#    source. Persist it in .env (idempotent) as well as exporting it for the
#    recreate below. Directory mount (NOT the file): the refresh cron swaps the
#    bundle by atomic rename inside CA_DIR, and a single-file bind mount would
#    pin the old inode. Drop any legacy CA_SRC line from the pre-dir-mount era.
mkdir -p "$CA_DIR"
sed -i '/^CA_DIR=/d;/^CA_SRC=/d' .env; echo "CA_DIR=$CA_DIR" >> .env
ok ".env -> CA_DIR=$CA_DIR (CA-dir overlay bind source; bundle file: $CA_SRC)"

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
