#!/usr/bin/env bash
#
# refresh-stir-trust-bundle.sh — fetch/validate/publish the iconectiv STI-PA
# trusted-CA bundle on the EAST SERVICES VM. Cron-able. Companion to
# refresh-sbc-trust-bundle.sh (which pulls what this publishes) and to
# deploy-sbc-verify.sh (which wires the bundle into Kamailio).
#
# WHY: our own-crypto STIR/SHAKEN inbound verify chains every caller's fetched
# x5u cert to the STI-PA trusted-CA list (multi-CA bundle). That list CHANGES
# (the STI-PA adds/revokes CAs), so it must stay fresh forever. This script is
# the single ingest+publish point: validate hard, install atomically, serve to
# the SBCs over the existing x5u Caddy at
#     https://fs-cert.granitevoip.com/stir/sti-pa-trust-bundle.pem
# (exact-path allowed in infra/stir/Caddyfile; everything else still 404s).
#
# Run AS ROOT on the services VM (after `sudo git pull` in /opt/revup):
#   sudo ./refresh-stir-trust-bundle.sh --install --from-file /path/trucontact-ca-list.pem   # initial manual load
#   sudo ./refresh-stir-trust-bundle.sh --install                    # fetch STIR_TRUST_BUNDLE_URL + install (cron)
#   sudo ./refresh-stir-trust-bundle.sh --fetch                      # dry-run: fetch + gates, NO install
#   sudo ./refresh-stir-trust-bundle.sh --check                      # re-validate the INSTALLED bundle (freshness watchdog)
#   sudo ./refresh-stir-trust-bundle.sh --status                     # show status file + installed summary
#
# VALIDATION GATES (stir-trust-lib.sh — shared verbatim with the SBC script):
# PEM parses; >= MIN_CA_CERTS certs; every cert within validity; the bundle
# anchors OUR OWN chain (openssl verify of the granite-shaken-8052 leaf).
# ANY gate failure => candidate discarded, current bundle KEPT, status FAIL,
# loud stderr + syslog, exit non-zero.
#
# INSTALL is atomic: temp file in the target dir -> gates -> mv (same-fs
# rename). The Caddy publish mount is the DIRECTORY (${STIR_TRUST_DIR}), so the
# rename is immediately visible in-container — no Caddy restart. A dated
# archive copy is kept on every content change.
#
# Idempotent: re-running with an unchanged bundle is a no-op "already current".

set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

# ---------------- config (override via environment) ----------------
REPO_DIR="${REPO_DIR:-/opt/revup}"
# Where the STI-PA list comes from. ACCEPTS EITHER FORM:
#   * the OFFICIAL sticaList.jwt (ES256 JWS, reissued daily) — auto-detected;
#     verified against the repo-pinned STI-PA signer cert, trustList extracted
#     to PEM, then the ordinary gates run on the extraction; or
#   * a plain PEM bundle (fallback / synthetic-test path) — gates run directly.
# The STI-PA download portal (authenticatereg.iconectiv.com/download-lists) is a
# JS app; if a stable machine URL is confirmed (candidates probe under
# https://authenticate-api.iconectiv.com/download/v1/ — see the runbook), set it
# here for full cron automation; until then use --from-file with the browser
# download.
STIR_TRUST_BUNDLE_URL="${STIR_TRUST_BUNDLE_URL:-}"
# Canonical publish dir — ALSO ro-mounted into the x5u Caddy as /srv/stir-trust.
STIR_TRUST_DIR="${STIR_TRUST_DIR:-/var/lib/stir}"
BUNDLE_NAME="sti-pa-trust-bundle.pem"
BUNDLE_PATH="$STIR_TRUST_DIR/$BUNDLE_NAME"
ARCHIVE_DIR="${ARCHIVE_DIR:-$STIR_TRUST_DIR/archive}"
# Our own published chain (leaf + Neustar CA-2 intermediate, in git) — gate G5.
OUR_CHAIN="${OUR_CHAIN:-$REPO_DIR/infra/stir/granite-shaken-8052-x5u.pem}"
# Repo-pinned PUBLIC STI-PA signer certs (both issued by "STI-PA Root
# Certificate 2"): the CA-list JWT signer (CN=STI-PA CA List) and the CRL
# signer (CN=STI-PA CRL). Rotation procedure: runbook "Pinned-cert rotation".
PINNED_LIST_SIGNER="${PINNED_LIST_SIGNER:-$REPO_DIR/infra/stir/sti-pa-calist-signer.crt}"
PINNED_CRL_SIGNER="${PINNED_CRL_SIGNER:-$REPO_DIR/infra/stir/sti-pa-crl-signer.crt}"
# Optional STI-PA CRL (stipaCrl.crl, PEM, reissued DAILY). Ingested in the same
# --install run when a source is given (--crl-from-file or STIR_CRL_URL);
# published alongside the bundle for the SBCs. Absent source = skipped (the CRL
# only matters once CertVerify bit 16 is in use).
STIR_CRL_URL="${STIR_CRL_URL:-}"
CRL_NAME="sti-pa-crl.pem"
CRL_PATH="$STIR_TRUST_DIR/$CRL_NAME"
# Post-install self-probe of the public URL (WARN-only; Caddy serves the dir).
PUBLISH_CHECK_URL="${PUBLISH_CHECK_URL:-https://fs-cert.granitevoip.com/stir/$BUNDLE_NAME}"
CURL_MAX_TIME="${CURL_MAX_TIME:-60}"
STATUS_FILE="${STATUS_FILE:-$STIR_TRUST_DIR/trust-bundle.status}"
TB_REQUIRE_ROOT="${TB_REQUIRE_ROOT:-1}"   # selftest sets 0 with all paths overridden

# shellcheck source=infra/stir/stir-trust-lib.sh
. "$(cd "$(dirname "$0")" && pwd)/stir-trust-lib.sh"

ok(){   echo "  [OK]   $*"; }
info(){ echo "  [..]   $*"; }
warn(){ echo "  [WARN] $*" >&2; }
die(){  echo "  [FAIL] $*" >&2; tb_write_status FAIL "$ACTION" "$*" "$BUNDLE_PATH"; exit 1; }
trap 'echo "  [FAIL] aborted at line $LINENO — the installed bundle was NOT changed." >&2' ERR

# ---------------- args ----------------
ACTION=""
FROM_FILE=""
CRL_FROM_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) ACTION=install ;;
    --fetch)   ACTION=fetch ;;
    --check)   ACTION=check ;;
    --status)  ACTION=status ;;
    --from-file) shift; FROM_FILE="${1:-}"; [ -n "$FROM_FILE" ] || { echo "--from-file needs a path" >&2; exit 1; } ;;
    --crl-from-file) shift; CRL_FROM_FILE="${1:-}"; [ -n "$CRL_FROM_FILE" ] || { echo "--crl-from-file needs a path" >&2; exit 1; } ;;
    --url)       shift; STIR_TRUST_BUNDLE_URL="${1:-}"; [ -n "$STIR_TRUST_BUNDLE_URL" ] || { echo "--url needs a URL" >&2; exit 1; } ;;
    -h|--help)
      cat <<'USAGE'
refresh-stir-trust-bundle.sh — STI-PA trusted-CA bundle lifecycle (services VM, run as root):
  sudo refresh-stir-trust-bundle.sh --install [--from-file P | --url U] [--crl-from-file C]
                                       fetch + validate + atomic install + publish (bundle, and CRL if sourced)
  sudo refresh-stir-trust-bundle.sh --fetch   [--from-file P | --url U]  dry-run: fetch + validation gates only
  sudo refresh-stir-trust-bundle.sh --check                              re-validate INSTALLED bundle + freshness watchdog
  sudo refresh-stir-trust-bundle.sh --status                             show status file + installed bundle summary
Source precedence: --from-file > --url > $STIR_TRUST_BUNDLE_URL env.
Input is auto-detected: the OFFICIAL sticaList.jwt (ES256; verified against the
repo-pinned STI-PA signer, gates J1 signature / J2 exp+sequence / J3 extraction)
or a plain PEM bundle. Then (all hard): PEM parses; >= MIN_CA_CERTS (default 5);
all certs in validity; bundle anchors OUR granite-shaken-8052 chain. Failure
keeps the current bundle. Optional CRL (stipaCrl.crl via --crl-from-file /
STIR_CRL_URL): pinned-signature + freshness gates, published as sti-pa-crl.pem.
Published to SBCs at https://fs-cert.granitevoip.com/stir/sti-pa-trust-bundle.pem.
USAGE
      exit 0 ;;
    *) echo "unknown argument '$1' (try --help)" >&2; exit 1 ;;
  esac
  shift
done
[ -n "$ACTION" ] || ACTION=status

# ---------------- preflight ----------------
if [ "$TB_REQUIRE_ROOT" = 1 ] && [ "$ACTION" != status ] && [ "$(id -u)" != 0 ]; then
  echo "  [FAIL] run as root:  sudo $0 --$ACTION" >&2; exit 1
fi
command -v openssl >/dev/null || { echo "  [FAIL] openssl not found" >&2; exit 1; }

# ---------------- status ----------------
if [ "$ACTION" = status ]; then
  tb_show_status "$BUNDLE_PATH"
  echo "publish URL: $PUBLISH_CHECK_URL"
  if [ -s "$CRL_PATH" ]; then
    echo "CRL:         present ($CRL_PATH; nextUpdate $(openssl crl -in "$CRL_PATH" -noout -nextupdate 2>/dev/null | cut -d= -f2))"
  else
    echo "CRL:         not installed (only needed for CertVerify bit 16)"
  fi
  echo "archives:    $(find "$ARCHIVE_DIR" \( -name '*.pem' -o -name '*.jwt' \) 2>/dev/null | wc -l | tr -d ' ') in $ARCHIVE_DIR"
  exit 0
fi

echo "== STI-PA trust bundle $ACTION on $(hostname) =="
mkdir -p "$STIR_TRUST_DIR"

# ---------------- check (validate what's installed + freshness watchdog) ----
if [ "$ACTION" = check ]; then
  [ -s "$BUNDLE_PATH" ] || die "no installed bundle at $BUNDLE_PATH — run --install first"
  CHECK_OK=1
  tb_validate_bundle "$BUNDLE_PATH" "$OUR_CHAIN" || CHECK_OK=0
  # staleness watchdog: with the STI-PA reissuing DAILY, this is what stops a
  # manual-download mirror from silently lapsing (FAIL beyond the monthly SLA).
  tb_check_freshness || CHECK_OK=0
  for w in "${TB_WARNINGS[@]+"${TB_WARNINGS[@]}"}"; do warn "$w"; done
  if [ "$CHECK_OK" = 1 ]; then
    tb_write_status OK check "installed bundle healthy ($TB_CERT_COUNT certs, next expiry: ${TB_NEXT_EXPIRY:-n/a})" "$BUNDLE_PATH"
    ok "installed bundle healthy ($TB_CERT_COUNT certs)"
    exit 0
  else
    printf '  [FAIL] %s\n' "${TB_FAILURES[@]}" >&2
    die "INSTALLED bundle failed validation/freshness (${#TB_FAILURES[@]} failure(s)) — inbound verify trust is at risk; re-ingest a fresh sticaList.jwt from the STI-PA (see docs/STIR_TRUST_BUNDLE_RUNBOOK.md)"
  fi
fi

# ---------------- CRL phase (runs after a successful bundle install) --------
# The STI-PA CRL is reissued DAILY (nextUpdate = +24h). Same lifecycle: pinned-
# signature + freshness gates -> atomic install -> published by the same Caddy
# at /stir/sti-pa-crl.pem for the SBC pull. Skipped when no source is
# configured — the CRL is only consumed once CertVerify bit 16 (CertCRLFile) is
# activated. Gate failures are FATAL (a bad CRL must scream) but the bundle
# install above has already completed and is unaffected.
install_crl_phase(){
  local crl_cand crl_sha
  if [ -z "$CRL_FROM_FILE" ] && [ -z "$STIR_CRL_URL" ]; then
    info "CRL: no source (--crl-from-file / STIR_CRL_URL) — skipped (only needed once CertVerify bit 16 is active)"
    return 0
  fi
  crl_cand=$(mktemp "$STIR_TRUST_DIR/.crlcand.XXXXXX")
  # shellcheck disable=SC2064  # expand now: capture this candidate's path
  trap "rm -f '$crl_cand'; echo '  [FAIL] aborted in CRL phase — bundle install above already completed; installed CRL NOT changed.' >&2" ERR
  if [ -n "$CRL_FROM_FILE" ]; then
    [ -s "$CRL_FROM_FILE" ] || { rm -f "$crl_cand"; die "CRL: --crl-from-file $CRL_FROM_FILE missing or empty (bundle phase above completed OK)"; }
    cp "$CRL_FROM_FILE" "$crl_cand"
    info "CRL candidate from local file: $CRL_FROM_FILE"
  else
    info "CRL: fetching $STIR_CRL_URL ..."
    curl -fsS --max-time "$CURL_MAX_TIME" -o "$crl_cand" "$STIR_CRL_URL" \
      || { rm -f "$crl_cand"; die "CRL fetch failed: $STIR_CRL_URL (bundle phase above completed OK; installed CRL kept)"; }
  fi
  info "CRL gates (pinned signer $(basename "$PINNED_CRL_SIGNER"), strict freshness) ..."
  if ! TB_CRL_STRICT=1 tb_validate_crl "$crl_cand" "$PINNED_CRL_SIGNER"; then
    printf '  [FAIL] %s\n' "${TB_FAILURES[@]}" >&2
    rm -f "$crl_cand"
    die "CRL candidate REJECTED (bundle phase above completed OK; installed CRL kept untouched)"
  fi
  if [ -s "$CRL_PATH" ] && [ "$(tb_sha256 "$crl_cand")" = "$(tb_sha256 "$CRL_PATH")" ]; then
    ok "CRL already current (sha256 match; nextUpdate ${TB_CRL_NEXTUPDATE:-n/a})"
    rm -f "$crl_cand"
    return 0
  fi
  chmod 0644 "$crl_cand"
  crl_sha=$(tb_sha256 "$crl_cand")
  mv -f "$crl_cand" "$CRL_PATH"                    # atomic same-fs rename
  mkdir -p "$ARCHIVE_DIR"
  cp "$CRL_PATH" "$ARCHIVE_DIR/${CRL_NAME%.pem}.$(date -u +%Y%m%d-%H%M%SZ).pem"
  ok "CRL installed -> $CRL_PATH (sha256 $crl_sha, nextUpdate ${TB_CRL_NEXTUPDATE:-n/a}) — published at ${PUBLISH_CHECK_URL%/*}/$CRL_NAME"
  return 0
}

# ---------------- fetch / install ----------------
# 1) acquire the candidate into a temp file IN THE TARGET DIR (same-fs rename)
CAND=$(mktemp "$STIR_TRUST_DIR/.candidate.XXXXXX")
CAND_JWT="$CAND.jwt"
cleanup(){ rm -f "$CAND" "$CAND_JWT"; }
trap 'cleanup; echo "  [FAIL] aborted at line $LINENO — the installed bundle was NOT changed." >&2' ERR

if [ -n "$FROM_FILE" ]; then
  [ -s "$FROM_FILE" ] || die "--from-file $FROM_FILE missing or empty"
  cp "$FROM_FILE" "$CAND"
  info "candidate from local file: $FROM_FILE"
elif [ -n "$STIR_TRUST_BUNDLE_URL" ]; then
  info "fetching $STIR_TRUST_BUNDLE_URL ..."
  curl -fsS --max-time "$CURL_MAX_TIME" -o "$CAND" "$STIR_TRUST_BUNDLE_URL" \
    || die "fetch failed: $STIR_TRUST_BUNDLE_URL (network/auth?) — current bundle kept"
  ok "fetched $(wc -c < "$CAND" | tr -d ' ') bytes"
else
  die "no source: pass --from-file <path> (the sticaList.jwt browser download) or --url / STIR_TRUST_BUNDLE_URL"
fi

# 1b) input-type autodetect: the OFFICIAL sticaList.jwt vs a plain PEM bundle.
# For JWT: gates J1 (ES256 vs the repo-pinned STI-PA signer + x5u consistency)
# J2 (exp freshness + sequence anti-regression) J3 (trustList -> PEM), then the
# extracted PEM becomes the candidate for the unchanged G1–G5 gates below.
if tb_is_jwt "$CAND"; then
  info "input is a JWT (official STI-PA sticaList) — running J-gates against pinned signer $PINNED_LIST_SIGNER ..."
  mv "$CAND" "$CAND_JWT"
  : > "$CAND"
  if ! tb_jwt_ingest "$CAND_JWT" "$PINNED_LIST_SIGNER" "$CAND"; then
    printf '  [FAIL] %s\n' "${TB_FAILURES[@]}" >&2
    die "JWT REJECTED (${#TB_FAILURES[@]} J-gate failure(s)) — current bundle kept untouched"
  fi
  ok "JWT verified (sequence ${TB_JWT_SEQ:-n/a}, exp ${TB_JWT_EXP:-n/a}); trustList extracted to PEM"
else
  # shellcheck disable=SC2034  # read by tb_write_status
  TB_SRC_KIND=pem
  info "input is plain PEM (fallback/synthetic path) — J-gates skipped"
fi

# 2) validation gates (shared lib) — ALL must pass
info "running validation gates ..."
if ! tb_validate_bundle "$CAND" "$OUR_CHAIN"; then
  printf '  [FAIL] %s\n' "${TB_FAILURES[@]}" >&2
  die "candidate REJECTED (${#TB_FAILURES[@]} gate failure(s)) — current bundle kept untouched"
fi
ok "all gates passed ($TB_CERT_COUNT certs, next expiry: ${TB_NEXT_EXPIRY:-n/a})"

# 3) dry-run stops here
if [ "$ACTION" = fetch ]; then
  tb_write_status OK fetch "candidate valid ($TB_CERT_COUNT certs) — NOT installed (dry-run)" "$BUNDLE_PATH"
  ok "dry-run complete — candidate valid, nothing installed. To install:  sudo $0 --install ${FROM_FILE:+--from-file $FROM_FILE}"
  cleanup
  exit 0
fi

# 4) idempotence: unchanged content is a no-op (still a VERIFIED refresh — the
#    J/G gates just passed — so it counts for the freshness watchdog: mark it)
if [ -s "$BUNDLE_PATH" ] && [ "$(tb_sha256 "$CAND")" = "$(tb_sha256 "$BUNDLE_PATH")" ]; then
  # shellcheck disable=SC2034  # consumed by tb_write_status (stamps INSTALLED_AT + provenance)
TB_MARK_INSTALL=1
  tb_write_status OK install "already current ($TB_CERT_COUNT certs, no change)" "$BUNDLE_PATH"
  ok "already current — installed bundle is identical (sha256 match); nothing to do"
  install_crl_phase
  cleanup
  exit 0
fi

# 5) atomic install + dated archive (the raw JWT is archived too when the
#    source was the official artifact — the exact signed bytes, for audit)
chmod 0644 "$CAND"
NEW_SHA=$(tb_sha256 "$CAND")
mv -f "$CAND" "$BUNDLE_PATH"                       # atomic same-fs rename
trap 'echo "  [FAIL] aborted at line $LINENO" >&2' ERR
mkdir -p "$ARCHIVE_DIR"
STAMP=$(date -u +%Y%m%d-%H%M%SZ)
ARCHIVE="$ARCHIVE_DIR/${BUNDLE_NAME%.pem}.$STAMP.pem"
cp "$BUNDLE_PATH" "$ARCHIVE"
[ -s "$CAND_JWT" ] && cp "$CAND_JWT" "$ARCHIVE_DIR/sticaList.$STAMP.jwt"
# shellcheck disable=SC2034  # consumed by tb_write_status (stamps INSTALLED_AT + provenance)
TB_MARK_INSTALL=1
tb_write_status OK install "installed $TB_CERT_COUNT certs (sha256 $NEW_SHA)" "$BUNDLE_PATH"
ok "installed -> $BUNDLE_PATH ($TB_CERT_COUNT certs, sha256 $NEW_SHA)"
ok "archived  -> $ARCHIVE"
install_crl_phase

# 6) publish self-probe (WARN-only — requires the Caddy trust mount, see
#    docker-compose.x5u.yml; the SBC pull will also catch a broken publish)
if curl -fsS --max-time 15 -o /dev/null "$PUBLISH_CHECK_URL" 2>/dev/null; then
  REMOTE_SHA=$(curl -fsS --max-time 15 "$PUBLISH_CHECK_URL" 2>/dev/null | tb_sha256 /dev/stdin || echo "")
  if [ "$REMOTE_SHA" = "$NEW_SHA" ]; then
    ok "publish verified: $PUBLISH_CHECK_URL serves the new bundle"
  else
    warn "publish serves DIFFERENT content (CDN/browser cache or stale Caddy mount?) — SBC pulls will pick it up within Cache-Control max-age"
  fi
else
  warn "publish URL not reachable from here ($PUBLISH_CHECK_URL) — if the x5u Caddy hasn't been recreated with the trust mount yet, run: sudo docker compose -f docker-compose.x5u.yml up -d   (NEVER add --remove-orphans)"
fi

echo
ok "SBCs pull this automatically (refresh-sbc-trust-bundle.sh cron). No restarts anywhere: libsecsipid re-reads CertCAFile on every verification."
