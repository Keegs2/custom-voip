#!/usr/bin/env bash
#
# refresh-sbc-trust-bundle.sh — pull the published STI-PA trusted-CA bundle
# onto ONE SBC and swap it into the Kamailio verify trust store. Cron-able.
# Companion to refresh-stir-trust-bundle.sh (the services-VM publisher) and
# deploy-sbc-verify.sh (which wires the CA dir mount + CertVerify mode).
#
# Run AS ROOT on the SBC (after `sudo git pull` in /opt/revup):
#   sudo ./refresh-sbc-trust-bundle.sh --install   # fetch + validate + atomic swap (cron mode)
#   sudo ./refresh-sbc-trust-bundle.sh --fetch     # dry-run: fetch + gates only, no swap
#   sudo ./refresh-sbc-trust-bundle.sh --check     # re-validate the installed bundle
#   sudo ./refresh-sbc-trust-bundle.sh --status    # status file + installed summary + verify mode
#
# It fetches https://fs-cert.granitevoip.com/stir/sti-pa-trust-bundle.pem over
# HTTPS (SBCs already have :443 egress — same path secsipid uses for x5u
# fetches), re-runs the SAME validation gates as the publisher (stir-trust-lib
# is shared verbatim), and atomically renames the file inside CA_DIR.
#
# NO KAMAILIO RELOAD/RESTART IS NEEDED — EVER — for a bundle refresh:
#   * libsecsipid re-reads CertCAFile from disk on EVERY verification
#     (secsipidx secsipid.go pubKeyVerify(): os.ReadFile(o.certCAFile) +
#     a fresh x509.CertPool per call; the x5u disk cache only skips the HTTPS
#     fetch, never the chain check). The very next inbound verify uses the new
#     bundle the moment the rename lands.
#   * CA_DIR (the PARENT DIRECTORY) is what docker-compose.stir-cafile.yml
#     bind-mounts — NOT the file. A single-FILE bind mount pins the inode, so
#     an atomic `mv` on the host would leave the container reading the OLD
#     bundle forever. The directory mount is load-bearing: rename inside the
#     dir is visible in-container instantly. Do not change it back.
# This script therefore NEVER restarts anything. The only actions that recreate
# Kamailio are the deploy-sbc-*.sh scripts, run deliberately by an operator.
#
# Fail-safe: ANY gate failure discards the candidate, KEEPS the current bundle,
# writes STATUS=FAIL (+syslog daemon.err), exits non-zero. Inbound verify is
# fail-open regardless — a stale-but-valid bundle only risks a wrong verstat
# annotation, never a dropped call.

set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

# ---------------- config (override via environment) ----------------
REPO_DIR="${REPO_DIR:-/opt/revup}"
BUNDLE_URL="${STIR_TRUST_BUNDLE_URL:-https://fs-cert.granitevoip.com/stir/sti-pa-trust-bundle.pem}"
# CA_DIR MUST equal the bind SOURCE in docker-compose.stir-cafile.yml (and the
# CA_DIR persisted in .env by deploy-sbc-verify.sh). Directory, not file — see
# the inode note above.
CA_DIR="${CA_DIR:-$REPO_DIR/secrets/stir-ca}"
BUNDLE_NAME="sti-pa-trust-bundle.pem"
BUNDLE_PATH="$CA_DIR/$BUNDLE_NAME"
OUR_CHAIN="${OUR_CHAIN:-$REPO_DIR/infra/stir/granite-shaken-8052-x5u.pem}"
# STI-PA CRL (optional; only consumed once CertVerify bit 16 / CertCRLFile is
# activated). Pulled from the same publisher directory as the bundle, validated
# against the repo-pinned CRL signer, installed into the SAME CA_DIR so the
# existing directory mount covers it — no compose change needed.
CRL_NAME="sti-pa-crl.pem"
CRL_PATH="$CA_DIR/$CRL_NAME"
CRL_URL="${STIR_CRL_URL:-${BUNDLE_URL%/*}/$CRL_NAME}"
PINNED_CRL_SIGNER="${PINNED_CRL_SIGNER:-$REPO_DIR/infra/stir/sti-pa-crl-signer.crt}"
CURL_MAX_TIME="${CURL_MAX_TIME:-30}"
STATUS_FILE="${STATUS_FILE:-/var/lib/stir/trust-bundle.status}"
KAM="${KAM:-voip-kamailio}"
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
case "${1:-}" in
  --install) ACTION=install ;;
  --fetch)   ACTION=fetch ;;
  --check)   ACTION=check ;;
  ""|--status) ACTION=status ;;
  -h|--help)
    cat <<'USAGE'
refresh-sbc-trust-bundle.sh — pull the STI-PA trusted-CA bundle onto one SBC (run as root):
  sudo refresh-sbc-trust-bundle.sh --install   fetch published bundle + gates + atomic swap (cron)
  sudo refresh-sbc-trust-bundle.sh --fetch     dry-run: fetch + validation gates, no swap
  sudo refresh-sbc-trust-bundle.sh --check     re-validate the installed bundle
  sudo refresh-sbc-trust-bundle.sh --status    show status + installed summary + verify mode
--install also pulls the published STI-PA CRL (sti-pa-crl.pem) when available:
pinned-signature + freshness gates, atomic swap into the same CA_DIR. CRL
problems are FATAL only when CertVerify bit 16 is active in .env (mode 21).
No Kamailio restart is ever performed: libsecsipid re-reads CertCAFile per call,
and the CA directory (not the file) is bind-mounted, so the atomic rename is
picked up by the very next inbound verification.
USAGE
    exit 0 ;;
  *) echo "unknown argument '$1' (try --help)" >&2; exit 1 ;;
esac

# ---------------- preflight ----------------
if [ "$TB_REQUIRE_ROOT" = 1 ] && [ "$ACTION" != status ] && [ "$(id -u)" != 0 ]; then
  echo "  [FAIL] run as root:  sudo $0 --$ACTION" >&2; exit 1
fi
command -v openssl >/dev/null || { echo "  [FAIL] openssl not found" >&2; exit 1; }

verify_mode_line(){ grep -E '^STIR_(SHAKEN_VERIFY|VERIFY_CERT_MODE)=' "$REPO_DIR/.env" 2>/dev/null | tr '\n' ' ' || true; }

# Is CertVerify bit 16 (CRL check, libsecsipid CertVerifyOptCRL) active in this
# SBC's .env? Governs how loud a CRL pull failure is: bit set = the verifier
# READS the CRL file per call, so a broken refresh must scream; unset = the file
# is never opened, a missing/stale CRL is informational.
crl_mode_active(){
  local m
  m=$(sed -n 's/^STIR_VERIFY_CERT_MODE=//p' "$REPO_DIR/.env" 2>/dev/null | head -1)
  [ -n "$m" ] && [ $(( m & 16 )) -ne 0 ] 2>/dev/null
}

# ---------------- status ----------------
if [ "$ACTION" = status ]; then
  tb_show_status "$BUNDLE_PATH"
  echo "verify mode (.env): $(verify_mode_line)"
  echo "source URL: $BUNDLE_URL"
  if [ -s "$CRL_PATH" ]; then
    echo "CRL: present ($CRL_PATH; nextUpdate $(openssl crl -in "$CRL_PATH" -noout -nextupdate 2>/dev/null | cut -d= -f2))"
  else
    echo "CRL: not installed (only needed for CertVerify bit 16)"
  fi
  exit 0
fi

echo "== STI-PA trust bundle $ACTION on $(hostname) =="

# Pre-staging is allowed (bundle can land before verify is wired), but warn if
# this doesn't look like an SBC — likely a wrong-box paste.
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$KAM"; then
  ok "on SBC $(hostname); $KAM present"
else
  warn "container '$KAM' not running here — pre-staging only (is this really an SBC?)"
fi

# ---------------- CRL pull (after a successful bundle install) --------------
# Loudness escalates with actual use: when CertVerify bit 16 is active the CRL
# file is read by libsecsipid on every verification (and secsipidx's CRL branch
# dereferences the ParseCRL result WITHOUT checking the parse error — a corrupt
# on-disk CRL would nil-panic Go inside Kamailio), so any CRL problem is FATAL
# then; while dark it's informational. Validation is TB_CRL_STRICT=0 here: a
# just-past nextUpdate on a mirror is a WARN (the publisher gate is the strict
# one) — revocation data degrades gracefully, garbage never installs.
crl_pull_phase(){
  local crl_cand crl_sha
  crl_cand=$(mktemp "$CA_DIR/.crlcand.XXXXXX")
  if ! curl -fsS --max-time "$CURL_MAX_TIME" -o "$crl_cand" "$CRL_URL" 2>/dev/null; then
    rm -f "$crl_cand"
    if crl_mode_active; then
      die "CRL fetch failed ($CRL_URL) while CertVerify bit 16 is ACTIVE — verifier reads $CRL_PATH per call; check the publisher (refresh-stir-trust-bundle.sh --status) and :443 egress (bundle phase above completed OK)"
    fi
    info "CRL: not published/fetchable ($CRL_URL) — skipped (CertVerify bit 16 not active here)"
    return 0
  fi
  if ! TB_CRL_STRICT=0 tb_validate_crl "$crl_cand" "$PINNED_CRL_SIGNER"; then
    printf '  %s\n' "${TB_FAILURES[@]/#/[FAIL] }" >&2
    rm -f "$crl_cand"
    if crl_mode_active; then
      die "published CRL REJECTED while CertVerify bit 16 is ACTIVE — installed CRL kept (bundle phase above completed OK)"
    fi
    warn "published CRL rejected — installed CRL kept; bit 16 not active so this is non-fatal here (fix the publisher)"
    return 0
  fi
  if [ -s "$CRL_PATH" ] && [ "$(tb_sha256 "$crl_cand")" = "$(tb_sha256 "$CRL_PATH")" ]; then
    ok "CRL already current (nextUpdate ${TB_CRL_NEXTUPDATE:-n/a})"
    rm -f "$crl_cand"
    return 0
  fi
  chmod 0644 "$crl_cand"
  crl_sha=$(tb_sha256 "$crl_cand")
  mv -f "$crl_cand" "$CRL_PATH"                    # atomic rename inside the mounted dir
  ok "CRL installed -> $CRL_PATH (sha256 $crl_sha, nextUpdate ${TB_CRL_NEXTUPDATE:-n/a})"
  return 0
}

# ---------------- check ----------------
if [ "$ACTION" = check ]; then
  [ -s "$BUNDLE_PATH" ] || die "no installed bundle at $BUNDLE_PATH — run --install first"
  if tb_validate_bundle "$BUNDLE_PATH" "$OUR_CHAIN"; then
    tb_write_status OK check "installed bundle healthy ($TB_CERT_COUNT certs, next expiry: ${TB_NEXT_EXPIRY:-n/a})" "$BUNDLE_PATH"
    ok "installed bundle healthy ($TB_CERT_COUNT certs)"
    if [ -s "$CRL_PATH" ] && ! TB_CRL_STRICT=0 tb_validate_crl "$CRL_PATH" "$PINNED_CRL_SIGNER"; then
      printf '  %s\n' "${TB_FAILURES[@]/#/[FAIL] }" >&2
      if crl_mode_active; then
        die "installed CRL failed validation while CertVerify bit 16 is ACTIVE — re-pull: sudo $0 --install"
      fi
      warn "installed CRL failed validation (bit 16 not active — non-fatal); re-pull with --install"
    fi
    exit 0
  else
    printf '  [FAIL] %s\n' "${TB_FAILURES[@]}" >&2
    die "INSTALLED bundle failed validation (${#TB_FAILURES[@]} gate failure(s)) — see docs/STIR_TRUST_BUNDLE_RUNBOOK.md"
  fi
fi

# ---------------- fetch / install ----------------
mkdir -p "$CA_DIR"
CAND=$(mktemp "$CA_DIR/.candidate.XXXXXX")
cleanup(){ rm -f "$CAND"; }
trap 'cleanup; echo "  [FAIL] aborted at line $LINENO — the installed bundle was NOT changed." >&2' ERR

info "fetching $BUNDLE_URL ..."
curl -fsS --max-time "$CURL_MAX_TIME" -o "$CAND" "$BUNDLE_URL" \
  || die "fetch failed: $BUNDLE_URL — current bundle kept (check :443 egress + that the services VM has published: refresh-stir-trust-bundle.sh --status)"
ok "fetched $(wc -c < "$CAND" | tr -d ' ') bytes"

info "running validation gates (same gates as the publisher) ..."
if ! tb_validate_bundle "$CAND" "$OUR_CHAIN"; then
  printf '  [FAIL] %s\n' "${TB_FAILURES[@]}" >&2
  die "candidate REJECTED (${#TB_FAILURES[@]} gate failure(s)) — current bundle kept untouched"
fi
ok "all gates passed ($TB_CERT_COUNT certs, next expiry: ${TB_NEXT_EXPIRY:-n/a})"

if [ "$ACTION" = fetch ]; then
  tb_write_status OK fetch "candidate valid ($TB_CERT_COUNT certs) — NOT installed (dry-run)" "$BUNDLE_PATH"
  ok "dry-run complete — candidate valid, nothing swapped"
  cleanup
  exit 0
fi

# idempotence
if [ -s "$BUNDLE_PATH" ] && [ "$(tb_sha256 "$CAND")" = "$(tb_sha256 "$BUNDLE_PATH")" ]; then
  # shellcheck disable=SC2034  # consumed by tb_write_status (stamps INSTALLED_AT + provenance)
TB_MARK_INSTALL=1
  tb_write_status OK install "already current ($TB_CERT_COUNT certs, no change)" "$BUNDLE_PATH"
  ok "already current — installed bundle is identical (sha256 match); nothing to do"
  crl_pull_phase
  cleanup
  exit 0
fi

# atomic swap inside the bind-mounted DIRECTORY (visible in-container instantly)
chmod 0644 "$CAND"
NEW_SHA=$(tb_sha256 "$CAND")
mv -f "$CAND" "$BUNDLE_PATH"
trap 'echo "  [FAIL] aborted at line $LINENO" >&2' ERR
# shellcheck disable=SC2034  # consumed by tb_write_status (stamps INSTALLED_AT + provenance)
TB_MARK_INSTALL=1
tb_write_status OK install "installed $TB_CERT_COUNT certs (sha256 $NEW_SHA)" "$BUNDLE_PATH"
ok "installed -> $BUNDLE_PATH ($TB_CERT_COUNT certs, sha256 $NEW_SHA)"
crl_pull_phase

# report pickup state — informational only, NEVER a restart
echo
MODE_LINE=$(verify_mode_line)
if echo "$MODE_LINE" | grep -q 'STIR_SHAKEN_VERIFY=on' && echo "$MODE_LINE" | grep -Eq 'STIR_VERIFY_CERT_MODE=[1-9]'; then
  ok "LIVE PICKUP: verify is ON with chain validation — the next inbound verification reads the new bundle (libsecsipid re-reads CertCAFile per call; no reload needed)"
elif [ -n "$MODE_LINE" ]; then
  info "verify not fully enabled here ($MODE_LINE) — bundle staged; it goes live with deploy-sbc-verify.sh --enable"
else
  info "verify not configured here yet — bundle pre-staged for deploy-sbc-verify.sh"
fi
