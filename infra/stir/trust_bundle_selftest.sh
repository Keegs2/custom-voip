#!/usr/bin/env bash
#
# trust_bundle_selftest.sh — SYNTHETIC end-to-end proof of the STI-PA trust
# bundle lifecycle tooling (refresh-stir-trust-bundle.sh + refresh-sbc-trust-
# bundle.sh + stir-trust-lib.sh). Runs ENTIRELY locally: no prod, no network
# beyond 127.0.0.1, no root — every canonical path is overridden into a temp
# dir via the scripts' env knobs (that overridability exists for exactly this).
#
# WHAT IT BUILDS (openssl, throwaway EC P-256 PKI):
#   * A synthetic analog of OUR chain: Root-G -> Intermediate-G -> Leaf-G, with
#     our_chain.pem = leaf+intermediate (root NOT included — mirroring the real
#     infra/stir/granite-shaken-8052-x5u.pem, which carries leaf + Neustar CA-2
#     but not the Neustar root).
#   * Synthetic "STI-PA list" bundles: GOOD (4 foreign CAs + Root-G), CORRUPT
#     (mangled base64), MISSING-OUR-ROOT, EXPIRED-member, NOT-YET-VALID-member,
#     and a GOOD-v2 (6 certs) for update/dry-run tests.
#
# WHAT IT PROVES (the task's gate matrix):
#   good bundle installs atomically (+archive, +status OK, +sha match)
#   re-run is idempotent (no reinstall, no duplicate archive)
#   corrupt PEM rejected, installed bundle untouched, status FAIL, exit != 0
#   bundle missing our root rejected (G5)
#   expired / not-yet-valid member rejected (G4)
#   cert-count floor rejected (G3, via MIN_CA_CERTS)
#   --fetch is a pure dry-run; --check and --status are accurate
#   SBC script: pulls over HTTP(S stand-in), same gates, atomic swap, keeps the
#   old bundle on a corrupt publish and on fetch failure
#   JWT ingestion (synthetic ES256 sticaList analog, signed with openssl):
#     valid signed JWT verifies + extracts + installs; tampered payload,
#     expired exp, wrong signer, sequence regression, and bad x5u all REJECTED
#   CRL lifecycle (synthetic openssl-ca CRL): valid CRL publishes + SBC-pulls;
#     corrupt / stale / wrong-signer CRLs rejected, installed CRL kept
#   REAL-ARTIFACT section (auto-skips unless ~/Downloads/sticaList.jwt +
#     stipaCrl.crl exist and are unexpired): the actual STI-PA JWT verifies
#     against the repo-pinned signer, 19 CAs extract, G5 anchors OUR chain;
#     a byte-flipped copy is rejected; the real CRL passes its pinned gates.
#     (The artifacts themselves are runtime data reissued daily — NEVER in git;
#     only the STI-PA signer certs are committed.)
#
# Usage:  ./trust_bundle_selftest.sh        (exit 0 = all pass)

set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SVC="$HERE/refresh-stir-trust-bundle.sh"
SBC="$HERE/refresh-sbc-trust-bundle.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/tbself.XXXXXX")
PKI="$WORK/pki"
HTTP_PID=""
cleanup(){ [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

c_g=$'\033[32m'; c_r=$'\033[31m'; c_b=$'\033[1m'; c_z=$'\033[0m'
PASS=0; FAIL=0
record(){ # PASS|FAIL <name> <detail>
  if [ "$1" = PASS ]; then PASS=$((PASS+1)); echo "  ${c_g}[PASS]${c_z} $2 — $3"
  else FAIL=$((FAIL+1)); echo "  ${c_r}[FAIL]${c_z} $2 — $3"; fi
}
sha(){ if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

# --------------------------------------------------------------------------
# 0. synthetic PKI
# --------------------------------------------------------------------------
echo "${c_b}== 0. building synthetic PKI in $WORK ==${c_z}"
mkdir -p "$PKI"
genkey(){ openssl ecparam -name prime256v1 -genkey -noout -out "$1" 2>/dev/null; }
selfca(){ # <key> <out.pem> <cn> [extra req args...]
  local key="$1" out="$2" cn="$3"; shift 3
  openssl req -x509 -new -key "$key" -subj "/C=US/O=Synthetic STI-PA/CN=$cn" \
    -days 3650 "$@" -out "$out" 2>/dev/null
}
for i in 1 2 3 4 5; do genkey "$PKI/ca$i.key"; selfca "$PKI/ca$i.key" "$PKI/ca$i.pem" "Synthetic Foreign STI-CA $i"; done
# our analog chain: root-G -> inter-G -> leaf-G
genkey "$PKI/rootg.key"; selfca "$PKI/rootg.key" "$PKI/rootg.pem" "Synthetic Granite Root (Neustar-root analog)"
genkey "$PKI/interg.key"
openssl req -new -key "$PKI/interg.key" -subj "/C=US/O=Synthetic Neustar/CN=Synthetic SHAKEN CA-2 analog" -out "$PKI/interg.csr" 2>/dev/null
printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' > "$PKI/ca.ext"
openssl x509 -req -in "$PKI/interg.csr" -CA "$PKI/rootg.pem" -CAkey "$PKI/rootg.key" -CAcreateserial -days 1825 -extfile "$PKI/ca.ext" -out "$PKI/interg.pem" 2>/dev/null
genkey "$PKI/leafg.key"
openssl req -new -key "$PKI/leafg.key" -subj "/C=US/O=Granite analog/CN=SHAKEN 8052 analog" -out "$PKI/leafg.csr" 2>/dev/null
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n' > "$PKI/leaf.ext"
openssl x509 -req -in "$PKI/leafg.csr" -CA "$PKI/interg.pem" -CAkey "$PKI/interg.key" -CAcreateserial -days 365 -extfile "$PKI/leaf.ext" -out "$PKI/leafg.pem" 2>/dev/null
cat "$PKI/leafg.pem" "$PKI/interg.pem" > "$PKI/our_chain.pem"   # leaf+inter, NO root (like the real x5u file)
if [ -s "$PKI/our_chain.pem" ]; then record PASS "pki build" "5 foreign CAs + root/inter/leaf analog chain"
else record FAIL "pki build" "openssl generation failed"; exit 1; fi
narch(){ find "$1" -name '*.pem' 2>/dev/null | wc -l | tr -d ' '; }

# expired + not-yet-valid members (openssl >= 3.4: req -not_before/-not_after;
# NOT combined with -days, they conflict)
dated_ca(){ # <key> <out.pem> <cn> <not_before> <not_after>
  openssl req -x509 -new -key "$1" -subj "/C=US/O=Synthetic STI-PA/CN=$3" \
    -not_before "$4" -not_after "$5" -out "$2" 2>/dev/null \
  && openssl x509 -noout -in "$2" 2>/dev/null
}
DATED_OK=1
genkey "$PKI/old.key"
dated_ca "$PKI/old.key" "$PKI/expired.pem" "Synthetic EXPIRED STI-CA" 20240101000000Z 20250101000000Z || DATED_OK=0
genkey "$PKI/fut.key"
dated_ca "$PKI/fut.key" "$PKI/future.pem" "Synthetic NOT-YET-VALID STI-CA" 20300101000000Z 20310101000000Z || DATED_OK=0
[ "$DATED_OK" = 1 ] || echo "  [WARN] this openssl lacks req -not_before/-not_after — G4 tests will be SKIPPED"

# bundles
B="$WORK/bundles"; mkdir -p "$B"
cat "$PKI"/ca{1,2,3,4}.pem "$PKI/rootg.pem"              > "$B/good.pem"          # 5 certs incl. our root
cat "$PKI"/ca{1,2,3,4}.pem "$PKI/rootg.pem" "$PKI/ca5.pem" > "$B/good_v2.pem"     # 6 certs (an "STI-PA added a CA" update)
cat "$PKI"/ca{1,2,3,4,5}.pem                             > "$B/no_our_root.pem"   # 5 certs, our root ABSENT
awk 'NR==8{print "CORRUPTEDLINE!!notbase64@@@"} NR!=8{print}' "$B/good.pem" > "$B/corrupt.pem"
if [ "$DATED_OK" = 1 ]; then
  cat "$B/good.pem" "$PKI/expired.pem" > "$B/expired_member.pem"
  cat "$B/good.pem" "$PKI/future.pem"  > "$B/future_member.pem"
fi

# --------------------------------------------------------------------------
# 1. services-VM script (refresh-stir-trust-bundle.sh) — env-overridden paths
# --------------------------------------------------------------------------
echo; echo "${c_b}== 1. services-VM publisher gates ==${c_z}"
SVC_DIR="$WORK/services-var"      # stands in for /var/lib/stir
SVC_ENV=(env TB_REQUIRE_ROOT=0 STIR_TRUST_DIR="$SVC_DIR" OUR_CHAIN="$PKI/our_chain.pem" \
         PUBLISH_CHECK_URL="http://127.0.0.1:9/unreachable" REPO_DIR="$WORK/norepo")
CANON="$SVC_DIR/sti-pa-trust-bundle.pem"
STATUSF="$SVC_DIR/trust-bundle.status"

run_svc(){ local rc; "${SVC_ENV[@]}" "$SVC" "$@" >"$WORK/last.log" 2>&1; rc=$?; return $rc; }
show_tail(){ sed 's/^/      /' "$WORK/last.log" | tail -6; }

# T1: good installs
if run_svc --install --from-file "$B/good.pem" && [ "$(sha "$CANON")" = "$(sha "$B/good.pem")" ] \
   && grep -q '^STATUS=OK' "$STATUSF" && [ "$(narch "$SVC_DIR/archive")" = 1 ]; then
  record PASS "T1 good --install" "installed + archived + status OK + sha match"
else record FAIL "T1 good --install" "see log"; show_tail; fi

# T2: idempotent re-run
if run_svc --install --from-file "$B/good.pem" && grep -q "already current" "$WORK/last.log" \
   && [ "$(narch "$SVC_DIR/archive")" = 1 ]; then
  record PASS "T2 idempotent re-run" "'already current', no duplicate archive"
else record FAIL "T2 idempotent re-run" "see log"; show_tail; fi

PRE_SHA=$(sha "$CANON")
# T3: corrupt PEM rejected
if ! run_svc --install --from-file "$B/corrupt.pem" && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q '^STATUS=FAIL' "$STATUSF"; then
  record PASS "T3 corrupt PEM rejected" "exit!=0, installed bundle untouched, status FAIL"
else record FAIL "T3 corrupt PEM rejected" "see log"; show_tail; fi

# T4: missing-our-root rejected (G5)
if ! run_svc --install --from-file "$B/no_our_root.pem" && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q 'G5' "$WORK/last.log"; then
  record PASS "T4 missing-our-root rejected" "G5 anchors-our-chain gate fired"
else record FAIL "T4 missing-our-root rejected" "see log"; show_tail; fi

# T5/T6: expired / not-yet-valid member rejected (G4)
if [ "$DATED_OK" = 1 ]; then
  if ! run_svc --install --from-file "$B/expired_member.pem" && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q 'G4: EXPIRED' "$WORK/last.log"; then
    record PASS "T5 expired member rejected" "G4 expiry gate fired"
  else record FAIL "T5 expired member rejected" "see log"; show_tail; fi
  if ! run_svc --install --from-file "$B/future_member.pem" && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q 'G4: NOT-YET-VALID' "$WORK/last.log"; then
    record PASS "T6 not-yet-valid member rejected" "G4 notBefore gate fired"
  else record FAIL "T6 not-yet-valid member rejected" "see log"; show_tail; fi
else
  echo "  [SKIP] T5/T6 (openssl too old for dated cert generation)"
fi

# T7: count floor (G3)
if ! env MIN_CA_CERTS=99 "${SVC_ENV[@]:1}" "$SVC" --install --from-file "$B/good.pem" >"$WORK/last.log" 2>&1 \
   && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q 'G3' "$WORK/last.log"; then
  record PASS "T7 count floor rejected" "MIN_CA_CERTS=99 -> G3 gate fired"
else record FAIL "T7 count floor rejected" "see log"; show_tail; fi

# T8: --fetch is a pure dry-run (valid NEW candidate, canonical unchanged)
if run_svc --fetch --from-file "$B/good_v2.pem" && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q 'dry-run' "$WORK/last.log"; then
  record PASS "T8 --fetch dry-run" "candidate validated, nothing installed"
else record FAIL "T8 --fetch dry-run" "see log"; show_tail; fi

# T9: --check + --status accurate
if run_svc --check && grep -q '^STATUS=OK' "$STATUSF" && run_svc --status && grep -q 'STATUS=OK' "$WORK/last.log" \
   && grep -q "5 cert(s)" "$WORK/last.log"; then
  record PASS "T9 --check/--status" "installed bundle healthy; status readable + accurate"
else record FAIL "T9 --check/--status" "see log"; show_tail; fi

# --------------------------------------------------------------------------
# 2. SBC script (refresh-sbc-trust-bundle.sh) — pulls from a local publisher
# --------------------------------------------------------------------------
echo; echo "${c_b}== 2. SBC puller (local HTTP stand-in for the x5u Caddy) ==${c_z}"
PUB="$WORK/publish"; mkdir -p "$PUB"
cp "$B/good.pem" "$PUB/sti-pa-trust-bundle.pem"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$PUB" >/dev/null 2>&1 &
HTTP_PID=$!
sleep 1
SBC_CA="$WORK/sbc-ca"             # stands in for /opt/revup/secrets/stir-ca
SBC_STATUS="$WORK/sbc-var/trust-bundle.status"
SBC_ENV=(env TB_REQUIRE_ROOT=0 CA_DIR="$SBC_CA" OUR_CHAIN="$PKI/our_chain.pem" \
         STATUS_FILE="$SBC_STATUS" REPO_DIR="$WORK/norepo" \
         STIR_TRUST_BUNDLE_URL="http://127.0.0.1:$PORT/sti-pa-trust-bundle.pem")
run_sbc(){ local rc; "${SBC_ENV[@]}" "$SBC" "$@" >"$WORK/last.log" 2>&1; rc=$?; return $rc; }
SBC_BUNDLE="$SBC_CA/sti-pa-trust-bundle.pem"

# T10: pull + install
if run_sbc --install && [ "$(sha "$SBC_BUNDLE")" = "$(sha "$B/good.pem")" ] && grep -q '^STATUS=OK' "$SBC_STATUS"; then
  record PASS "T10 SBC pull+install" "fetched over HTTP, gates passed, atomic swap into CA_DIR"
else record FAIL "T10 SBC pull+install" "see log"; show_tail; fi

# T11: idempotent
if run_sbc --install && grep -q "already current" "$WORK/last.log"; then
  record PASS "T11 SBC idempotent" "'already current' on unchanged publish"
else record FAIL "T11 SBC idempotent" "see log"; show_tail; fi

# T12: publisher serves an UPDATE -> SBC picks it up
cp "$B/good_v2.pem" "$PUB/sti-pa-trust-bundle.pem"
if run_sbc --install && [ "$(sha "$SBC_BUNDLE")" = "$(sha "$B/good_v2.pem")" ]; then
  record PASS "T12 SBC update pickup" "new 6-cert list swapped in atomically"
else record FAIL "T12 SBC update pickup" "see log"; show_tail; fi

# T13: corrupt publish rejected, old bundle kept
cp "$B/corrupt.pem" "$PUB/sti-pa-trust-bundle.pem"
if ! run_sbc --install && [ "$(sha "$SBC_BUNDLE")" = "$(sha "$B/good_v2.pem")" ] && grep -q '^STATUS=FAIL' "$SBC_STATUS"; then
  record PASS "T13 SBC corrupt publish rejected" "gates fired, previous bundle kept, status FAIL"
else record FAIL "T13 SBC corrupt publish rejected" "see log"; show_tail; fi

# T14: fetch failure (publisher down) keeps bundle + fails loudly
kill "$HTTP_PID" 2>/dev/null; wait "$HTTP_PID" 2>/dev/null; HTTP_PID=""
if ! run_sbc --install && [ "$(sha "$SBC_BUNDLE")" = "$(sha "$B/good_v2.pem")" ] && grep -q 'fetch failed' "$WORK/last.log"; then
  record PASS "T14 SBC fetch failure" "exit!=0, bundle kept, loud error"
else record FAIL "T14 SBC fetch failure" "see log"; show_tail; fi

# T15: SBC --check + --status accurate after the failure (bundle itself healthy)
if run_sbc --check && grep -q '^STATUS=OK' "$SBC_STATUS" && run_sbc --status && grep -q '6 cert(s)' "$WORK/last.log"; then
  record PASS "T15 SBC --check/--status" "installed bundle re-validates OK; status accurate"
else record FAIL "T15 SBC --check/--status" "see log"; show_tail; fi

# --------------------------------------------------------------------------
# 3. JWT ingestion (synthetic ES256 sticaList analog)
# --------------------------------------------------------------------------
echo; echo "${c_b}== 3. JWT ingestion gates (synthetic signed sticaList) ==${c_z}"

b64url(){ openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# synthetic STI-PA signer analog (the "pin") + an unrelated wrong-signer key
genkey "$PKI/pin.key";  selfca "$PKI/pin.key"  "$PKI/pin.crt"  "Synthetic STI-PA CA List"
genkey "$PKI/evil.key"

# mk_jwt <signer.key> <bundle.pem> <sequence> <exp_epoch> <out.jwt> [x5u]
# bash+openssl sign; python3 only for JSON assembly + DER->raw sig conversion
# (python3 is already a selftest dependency for the HTTP stand-in).
mk_jwt(){
  local key="$1" pem="$2" seq="$3" exp="$4" out="$5"
  local x5u="${6:-https://authenticate-api.iconectiv.com/download/v1/certificate/certificateId_000001.crt}"
  local d="$WORK/jwtbuild"; mkdir -p "$d"
  python3 - "$pem" "$seq" "$exp" > "$d/payload.json" <<'PY'
import json, sys
pem = open(sys.argv[1]).read()
certs, cur = [], []
for line in pem.splitlines():
    if not line.strip(): continue
    cur.append(line)
    if 'END CERTIFICATE' in line:
        certs.append('\n'.join(cur) + '\n'); cur = []
print(json.dumps({"version": "1.0", "sequence": int(sys.argv[2]),
                  "exp": int(sys.argv[3]), "trustList": certs},
                 separators=(',', ':')), end='')
PY
  local h64 p64 s64
  h64=$(printf '{"alg":"ES256","typ":"JWT","x5u":"%s"}' "$x5u" | b64url)
  p64=$(b64url < "$d/payload.json")
  printf '%s.%s' "$h64" "$p64" > "$d/input"
  openssl dgst -sha256 -sign "$key" -out "$d/sig.der" "$d/input" 2>/dev/null
  python3 - "$d/sig.der" > "$d/sig.raw" <<'PY'
import sys
der = open(sys.argv[1], 'rb').read()
i = 2
if der[1] & 0x80: i = 2 + (der[1] & 0x7f)
def readint(d, i):
    assert d[i] == 2
    l = d[i+1]; v = d[i+2:i+2+l]
    return v.lstrip(b'\x00'), i + 2 + l
r, i = readint(der, i); s, i = readint(der, i)
sys.stdout.buffer.write(r.rjust(32, b'\x00') + s.rjust(32, b'\x00'))
PY
  s64=$(b64url < "$d/sig.raw")
  printf '%s.%s.%s' "$h64" "$p64" "$s64" > "$out"
}

NOW=$(date -u +%s)
SVC_ENV_J=("${SVC_ENV[@]}" PINNED_LIST_SIGNER="$PKI/pin.crt")
run_svcj(){ local rc; "${SVC_ENV_J[@]}" "$SVC" "$@" >"$WORK/last.log" 2>&1; rc=$?; return $rc; }

# TJ1: valid signed JWT verifies, extracts, installs; provenance recorded
mk_jwt "$PKI/pin.key" "$B/good_v2.pem" 3 $((NOW + 86400)) "$B/tj1.jwt"
if run_svcj --install --from-file "$B/tj1.jwt" && [ "$(sha "$CANON")" = "$(sha "$B/good_v2.pem")" ] \
   && grep -q '^LIST_SEQUENCE=3$' "$STATUSF" && grep -q '^SOURCE_KIND=jwt$' "$STATUSF"; then
  record PASS "TJ1 valid JWT installs" "ES256 verified, trustList extracted byte-exact, seq recorded"
else record FAIL "TJ1 valid JWT installs" "see log"; show_tail; fi
PRE_SHA=$(sha "$CANON")
PRE_SEQ=$(sed -n 's/^LIST_SEQUENCE=//p' "$STATUSF")

# TJ2: tampered payload -> signature check must reject
awk -F. '{ p=$2; mid=int(length(p)/2); c=substr(p,mid,1); r=(c=="A"?"B":"A");
           printf "%s.%s%s%s.%s", $1, substr(p,1,mid-1), r, substr(p,mid+1), $3 }' \
  "$B/tj1.jwt" > "$B/tj2_tampered.jwt"
if ! run_svcj --install --from-file "$B/tj2_tampered.jwt" && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q 'J1' "$WORK/last.log"; then
  record PASS "TJ2 tampered payload rejected" "J1 signature gate fired, bundle untouched"
else record FAIL "TJ2 tampered payload rejected" "see log"; show_tail; fi

# TJ3: expired exp -> rejected (valid signature)
mk_jwt "$PKI/pin.key" "$B/good_v2.pem" 3 $((NOW - 100)) "$B/tj3_expired.jwt"
if ! run_svcj --install --from-file "$B/tj3_expired.jwt" && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q 'J2: list EXPIRED' "$WORK/last.log"; then
  record PASS "TJ3 expired exp rejected" "J2 freshness gate fired"
else record FAIL "TJ3 expired exp rejected" "see log"; show_tail; fi

# TJ4: wrong signer -> rejected
mk_jwt "$PKI/evil.key" "$B/good_v2.pem" 4 $((NOW + 86400)) "$B/tj4_wrongsigner.jwt"
if ! run_svcj --install --from-file "$B/tj4_wrongsigner.jwt" && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q 'J1: ES256 signature verification FAILED' "$WORK/last.log"; then
  record PASS "TJ4 wrong-signer rejected" "pinned-signer check fired"
else record FAIL "TJ4 wrong-signer rejected" "see log"; show_tail; fi

# TJ5: sequence regression (installed=3, candidate=2) -> rejected
mk_jwt "$PKI/pin.key" "$B/good.pem" 2 $((NOW + 86400)) "$B/tj5_regress.jwt"
if ! run_svcj --install --from-file "$B/tj5_regress.jwt" && [ "$(sha "$CANON")" = "$PRE_SHA" ] \
   && grep -q 'sequence REGRESSION' "$WORK/last.log" && [ "$(sed -n 's/^LIST_SEQUENCE=//p' "$STATUSF")" = "$PRE_SEQ" ]; then
  record PASS "TJ5 sequence regression rejected" "J2 anti-replay fired; recorded seq unpoisoned"
else record FAIL "TJ5 sequence regression rejected" "see log"; show_tail; fi

# TJ6: near-exp WARNs but still installs (new content, seq moves forward)
mk_jwt "$PKI/pin.key" "$B/good.pem" 4 $((NOW + 3600)) "$B/tj6_nearexp.jwt"
if run_svcj --install --from-file "$B/tj6_nearexp.jwt" && [ "$(sha "$CANON")" = "$(sha "$B/good.pem")" ] && grep -q 'exp is only' "$WORK/last.log"; then
  record PASS "TJ6 near-exp warns + installs" "WARN emitted, install proceeded (not a hard gate)"
else record FAIL "TJ6 near-exp warns + installs" "see log"; show_tail; fi
PRE_SHA=$(sha "$CANON")

# TJ7: x5u outside the STI-PA URL pattern -> rejected
mk_jwt "$PKI/pin.key" "$B/good_v2.pem" 5 $((NOW + 86400)) "$B/tj7_badx5u.jwt" "https://evil.example.com/cert.crt"
if ! run_svcj --install --from-file "$B/tj7_badx5u.jwt" && [ "$(sha "$CANON")" = "$PRE_SHA" ] && grep -q 'x5u' "$WORK/last.log"; then
  record PASS "TJ7 bad x5u rejected" "header x5u pattern gate fired"
else record FAIL "TJ7 bad x5u rejected" "see log"; show_tail; fi

# TJ8: freshness watchdog — --check FAILs when the install is older than
# TB_MAX_BUNDLE_AGE_DAYS (backdate INSTALLED_AT in the status file), and
# recovers to OK on the next real install
sed -i.bak "s/^INSTALLED_AT=.*/INSTALLED_AT=$((NOW - 50 * 86400))/" "$STATUSF" && rm -f "$STATUSF.bak"
if ! run_svcj --check && grep -q 'LAPSED' "$WORK/last.log" \
   && run_svcj --install --from-file "$B/tj6_nearexp.jwt" && run_svcj --check; then
  record PASS "TJ8 age watchdog" "--check screams at 50d-old install; fresh --install clears it"
else record FAIL "TJ8 age watchdog" "see log"; show_tail; fi

# --------------------------------------------------------------------------
# 4. CRL lifecycle (synthetic openssl-ca CRL)
# --------------------------------------------------------------------------
echo; echo "${c_b}== 4. CRL gates + publish/pull ==${c_z}"

genkey "$PKI/crlpin.key"; selfca "$PKI/crlpin.key" "$PKI/crlpin.crt" "Synthetic STI-PA CRL"

# mk_crl <signer.key> <signer.pem> <out.pem> [extra openssl-ca args]
mk_crl(){
  local key="$1" cert="$2" out="$3"; shift 3
  local d; d=$(mktemp -d "$PKI/crlca.XXXXXX")
  touch "$d/index.txt"; echo 01 > "$d/crlnumber"
  printf '[ca]\ndefault_ca=myca\n[myca]\ndatabase=%s/index.txt\ncrlnumber=%s/crlnumber\ndefault_md=sha256\ndefault_crl_days=1\n' "$d" "$d" > "$d/ca.cnf"
  openssl ca -config "$d/ca.cnf" -gencrl -keyfile "$key" -cert "$cert" "$@" -out "$out" 2>/dev/null
}
mk_crl "$PKI/crlpin.key" "$PKI/crlpin.crt" "$B/crl_good.pem"
mk_crl "$PKI/ca1.key"    "$PKI/ca1.pem"    "$B/crl_wrongsigner.pem"
STALE_OK=1
mk_crl "$PKI/crlpin.key" "$PKI/crlpin.crt" "$B/crl_stale.pem" -crlsec 1 || STALE_OK=0
sleep 2
awk 'NR==4{print "CORRUPTEDCRL!!"} NR!=4{print}' "$B/crl_good.pem" > "$B/crl_corrupt.pem"

SVC_ENV_C=("${SVC_ENV_J[@]}" PINNED_CRL_SIGNER="$PKI/crlpin.crt")
run_svcc(){ local rc; "${SVC_ENV_C[@]}" "$SVC" "$@" >"$WORK/last.log" 2>&1; rc=$?; return $rc; }
SVC_CRL="$SVC_DIR/sti-pa-crl.pem"

# TC1: valid CRL installs alongside the (already-current) bundle
if run_svcc --install --from-file "$B/tj6_nearexp.jwt" --crl-from-file "$B/crl_good.pem" \
   && [ "$(sha "$SVC_CRL")" = "$(sha "$B/crl_good.pem")" ] && grep -q 'CRL installed' "$WORK/last.log"; then
  record PASS "TC1 valid CRL installs" "C1-C3 gates passed, atomic install, published alongside bundle"
else record FAIL "TC1 valid CRL installs" "see log"; show_tail; fi
CRL_SHA=$(sha "$SVC_CRL")

# TC2: corrupt CRL rejected (installed CRL kept, loud non-zero exit)
if ! run_svcc --install --from-file "$B/tj6_nearexp.jwt" --crl-from-file "$B/crl_corrupt.pem" \
   && [ "$(sha "$SVC_CRL")" = "$CRL_SHA" ] && grep -q 'C1' "$WORK/last.log"; then
  record PASS "TC2 corrupt CRL rejected" "C1 parse gate fired, installed CRL kept"
else record FAIL "TC2 corrupt CRL rejected" "see log"; show_tail; fi

# TC3: stale CRL (nextUpdate past) rejected at the publisher (strict)
if [ "$STALE_OK" = 1 ]; then
  if ! run_svcc --install --from-file "$B/tj6_nearexp.jwt" --crl-from-file "$B/crl_stale.pem" \
     && [ "$(sha "$SVC_CRL")" = "$CRL_SHA" ] && grep -q 'C3.*STALE' "$WORK/last.log"; then
    record PASS "TC3 stale CRL rejected" "C3 strict freshness gate fired at publisher"
  else record FAIL "TC3 stale CRL rejected" "see log"; show_tail; fi
else
  echo "  [SKIP] TC3 (this openssl lacks ca -crlsec)"
fi

# TC4: wrong-signer CRL rejected
if ! run_svcc --install --from-file "$B/tj6_nearexp.jwt" --crl-from-file "$B/crl_wrongsigner.pem" \
   && [ "$(sha "$SVC_CRL")" = "$CRL_SHA" ] && grep -q 'C2' "$WORK/last.log"; then
  record PASS "TC4 wrong-signer CRL rejected" "C2 pinned-signature gate fired"
else record FAIL "TC4 wrong-signer CRL rejected" "see log"; show_tail; fi

# TC5: SBC pulls the published CRL in the same --install as the bundle
cp "$CANON" "$PUB/sti-pa-trust-bundle.pem"
cp "$SVC_CRL" "$PUB/sti-pa-crl.pem"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$PUB" >/dev/null 2>&1 &
HTTP_PID=$!
sleep 1
SBC_ENV_C=(env TB_REQUIRE_ROOT=0 CA_DIR="$SBC_CA" OUR_CHAIN="$PKI/our_chain.pem" \
           STATUS_FILE="$SBC_STATUS" REPO_DIR="$WORK/norepo" PINNED_CRL_SIGNER="$PKI/crlpin.crt" \
           STIR_TRUST_BUNDLE_URL="http://127.0.0.1:$PORT/sti-pa-trust-bundle.pem")
run_sbcc(){ local rc; "${SBC_ENV_C[@]}" "$SBC" "$@" >"$WORK/last.log" 2>&1; rc=$?; return $rc; }
SBC_CRL="$SBC_CA/sti-pa-crl.pem"
if run_sbcc --install && [ "$(sha "$SBC_CRL")" = "$(sha "$SVC_CRL")" ] && [ "$(sha "$SBC_BUNDLE")" = "$(sha "$CANON")" ]; then
  record PASS "TC5 SBC CRL pull" "bundle + CRL both pulled in one cron pass, gates re-run on the SBC"
else record FAIL "TC5 SBC CRL pull" "see log"; show_tail; fi

# TC6: corrupt published CRL -> SBC keeps old CRL; non-fatal while bit 16 dark
cp "$B/crl_corrupt.pem" "$PUB/sti-pa-crl.pem"
if run_sbcc --install && [ "$(sha "$SBC_CRL")" = "$(sha "$SVC_CRL")" ] && grep -q 'CRL rejected' "$WORK/last.log"; then
  record PASS "TC6 SBC corrupt CRL non-fatal" "old CRL kept, loud WARN, exit 0 (bit 16 dark)"
else record FAIL "TC6 SBC corrupt CRL non-fatal" "see log"; show_tail; fi

# TC7: same corrupt publish with CertVerify bit 16 ACTIVE (.env mode 21) ->
# FATAL (the verifier reads the CRL per call; a broken refresh must scream)
mkdir -p "$WORK/repo16"; printf 'STIR_VERIFY_CERT_MODE=21\nSTIR_SHAKEN_VERIFY=on\n' > "$WORK/repo16/.env"
SBC_ENV_16=(env TB_REQUIRE_ROOT=0 CA_DIR="$SBC_CA" OUR_CHAIN="$PKI/our_chain.pem" \
            STATUS_FILE="$SBC_STATUS" REPO_DIR="$WORK/repo16" PINNED_CRL_SIGNER="$PKI/crlpin.crt" \
            STIR_TRUST_BUNDLE_URL="http://127.0.0.1:$PORT/sti-pa-trust-bundle.pem")
if ! "${SBC_ENV_16[@]}" "$SBC" --install >"$WORK/last.log" 2>&1 \
   && [ "$(sha "$SBC_CRL")" = "$(sha "$SVC_CRL")" ] && grep -q 'bit 16 is ACTIVE' "$WORK/last.log"; then
  record PASS "TC7 corrupt CRL FATAL under bit 16" "escalation works: exit!=0 when the CRL is live-consumed"
else record FAIL "TC7 corrupt CRL FATAL under bit 16" "see log"; show_tail; fi
kill "$HTTP_PID" 2>/dev/null; wait "$HTTP_PID" 2>/dev/null; HTTP_PID=""

# --------------------------------------------------------------------------
# 5. REAL STI-PA artifacts (auto-skips when absent/expired — never in git)
# --------------------------------------------------------------------------
echo; echo "${c_b}== 5. real STI-PA artifacts (optional) ==${c_z}"
REAL_JWT="${REAL_JWT:-$HOME/Downloads/sticaList.jwt}"
REAL_CRL="${REAL_CRL:-$HOME/Downloads/stipaCrl.crl}"
REPO_ROOT=$(cd "$HERE/../.." && pwd)
REAL_PIN="$REPO_ROOT/infra/stir/sti-pa-calist-signer.crt"
REAL_CRL_PIN="$REPO_ROOT/infra/stir/sti-pa-crl-signer.crt"
REAL_CHAIN="$REPO_ROOT/infra/stir/granite-shaken-8052-x5u.pem"

real_jwt_fresh(){
  [ -s "$REAL_JWT" ] && [ -s "$REAL_PIN" ] || return 1
  python3 - "$REAL_JWT" <<'PY'
import base64, json, sys, time
p = open(sys.argv[1]).read().strip().split('.')[1]
exp = json.loads(base64.urlsafe_b64decode(p + '=' * (-len(p) % 4)))['exp']
sys.exit(0 if exp > time.time() else 1)
PY
}

if real_jwt_fresh; then
  RSVC="$WORK/real-var"
  RENV=(env TB_REQUIRE_ROOT=0 STIR_TRUST_DIR="$RSVC" OUR_CHAIN="$REAL_CHAIN" \
        PINNED_LIST_SIGNER="$REAL_PIN" PINNED_CRL_SIGNER="$REAL_CRL_PIN" \
        PUBLISH_CHECK_URL="http://127.0.0.1:9/unreachable" REPO_DIR="$WORK/norepo" \
        STATUS_FILE="$RSVC/trust-bundle.status")
  # R1: the REAL sticaList.jwt verifies against the REAL pin, extracts, and the
  # extraction passes G1-G5 against OUR REAL granite-shaken-8052 chain
  if "${RENV[@]}" "$SVC" --install --from-file "$REAL_JWT" >"$WORK/last.log" 2>&1 \
     && grep -q 'G5 anchors-our-chain: ok' "$WORK/last.log" \
     && [ "$(grep -c 'BEGIN CERTIFICATE' "$RSVC/sti-pa-trust-bundle.pem")" -ge 15 ]; then
    record PASS "R1 REAL sticaList.jwt end-to-end" "$(grep -c 'BEGIN CERTIFICATE' "$RSVC/sti-pa-trust-bundle.pem") CAs; Neustar root anchors our chain (G5)"
  else record FAIL "R1 REAL sticaList.jwt end-to-end" "see log"; show_tail; fi
  # R2: byte-flipped REAL JWT must be rejected by the signature gate
  awk -F. '{ p=$2; mid=int(length(p)/2); c=substr(p,mid,1); r=(c=="A"?"B":"A");
             printf "%s.%s%s%s.%s", $1, substr(p,1,mid-1), r, substr(p,mid+1), $3 }' \
    "$REAL_JWT" > "$B/real_tampered.jwt"
  RSHA=$(sha "$RSVC/sti-pa-trust-bundle.pem")
  if ! "${RENV[@]}" "$SVC" --install --from-file "$B/real_tampered.jwt" >"$WORK/last.log" 2>&1 \
     && [ "$(sha "$RSVC/sti-pa-trust-bundle.pem")" = "$RSHA" ] && grep -q 'J1' "$WORK/last.log"; then
    record PASS "R2 tampered REAL JWT rejected" "J1 fired on a byte-flipped official artifact"
  else record FAIL "R2 tampered REAL JWT rejected" "see log"; show_tail; fi
  # R3: the REAL CRL against the REAL pinned CRL signer (skip if nextUpdate past)
  real_crl_fresh(){
    local nu ep
    [ -s "$REAL_CRL" ] || return 1
    nu=$(openssl crl -in "$REAL_CRL" -noout -nextupdate 2>/dev/null | cut -d= -f2)
    [ -n "$nu" ] || return 1
    ep=$(date -u -d "$nu" +%s 2>/dev/null || date -u -j -f '%b %e %T %Y %Z' "$nu" +%s 2>/dev/null) || return 1
    [ -n "$ep" ] && [ "$ep" -gt "$(date -u +%s)" ]
  }
  if real_crl_fresh; then
    if "${RENV[@]}" "$SVC" --install --from-file "$REAL_JWT" --crl-from-file "$REAL_CRL" >"$WORK/last.log" 2>&1 \
       && [ "$(sha "$RSVC/sti-pa-crl.pem")" = "$(sha "$REAL_CRL")" ]; then
      record PASS "R3 REAL stipaCrl.crl installs" "pinned signature + freshness verified on the official CRL"
    else record FAIL "R3 REAL stipaCrl.crl installs" "see log"; show_tail; fi
  else
    echo "  [SKIP] R3 (real CRL absent or past nextUpdate — reissued daily)"
  fi
else
  echo "  [SKIP] R1-R3 (no fresh ~/Downloads/sticaList.jwt — the STI-PA reissues it daily; synthetic JWT coverage above still proves every gate)"
fi

# --------------------------------------------------------------------------
echo; echo "${c_b}== RESULT: $PASS passed, $FAIL failed ==${c_z}"
[ "$FAIL" -eq 0 ]
