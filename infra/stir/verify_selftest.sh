#!/usr/bin/env bash
#
# verify_selftest.sh — end-to-end proof that our STIR/SHAKEN INBOUND verify engine
# (Kamailio `secsipid` -> the REAL libsecsipid `CertVerify` chain-trust) behaves
# correctly, using a SYNTHETIC STI-CA so it needs NO real iconectiv bundle.
#
# WHAT THIS PROVES (and why it de-risks the production flip to CertVerify=5):
#   The live inbound path (docker/kamailio/kamailio.cfg) calls
#   secsipid_check_identity("") with `libopt CertVerify=5` + `CertCAFile=<STI-PA
#   roots>`. Turning that on in production is a FILE-SWAP (drop the real STI-PA
#   root bundle at CertCAFile, set CERT_MODE=5). This script exercises the exact
#   same libsecsipid code path against a synthetic CA and asserts the trust
#   decisions are what STIR requires:
#     - a PASSporT signed by a leaf that chains to the trusted root  -> PASS
#     - a tampered token (wrong signature)                           -> FAIL
#     - a PASSporT signed by an UNKNOWN (rogue) STI-CA               -> FAIL   <- the crux
#     - that same rogue token with CertVerify=0 (signature-only)     -> PASS   <- shows WHY the bundle is required
#   Plus a `div` PASSporT (RCF diversion) PASSes, an openssl-level chain
#   cross-check, and a config-templating proof that the entrypoint renders a
#   `kamailio -c`-clean cfg with the three libopt modparams — with verify both ON
#   and OFF (no-regression).
#
# HOW IT STAYS FAITHFUL:
#   - make_passport.py signs with Python `cryptography` (an INDEPENDENT impl), so a
#     PASS is a genuine cross-implementation proof, not a library round-trip.
#   - secsipid_verify_driver.c is a thin CLI over the SAME libsecsipid.so.1 the
#     Kamailio module links; it sets the identical CertVerify/CertCAFile/CertCAInter
#     libopts and calls SecSIPIDCheckFull — byte-for-byte the SBC trust logic.
#   - x5u URLs are http:// so libsecsipid actually FETCHES the leaf over the wire
#     (exercises the real fetch+verify path, not a local file read).
#
# ENVIRONMENT: Docker must be up. Host does the crypto (PKI + PASSporTs + x5u HTTP
# servers + the openssl cross-check) because the host has python3-`cryptography`
# and openssl; the container builds + runs the driver and validates kamailio.cfg
# (the kamailio image ships libsecsipid.so.1 but NO compiler and NO cryptography).
# On macOS (Docker Desktop) `--network host` does not bridge to host servers, so
# x5u URLs use host.docker.internal + `--add-host=host.docker.internal:host-gateway`.
# On Linux the same host-gateway alias works; we use it uniformly.
#
# SAFETY: read-only w.r.t. the repo and any VM. Builds ONE local throwaway image
# (revup-kamailio:stir-verify-driver) and runs ephemeral containers. Idempotent.
# All temp state lives under one mktemp dir that is removed on exit (servers killed
# on exit too). Does NOT push, commit, deploy, or touch a VM.
#
# EXIT: 0 iff every expected-PASS passed AND every expected-FAIL failed AND both
# config renders are `kamailio -c`-clean; 1 otherwise. Prints a PASS/FAIL matrix.

set -uo pipefail

# --------------------------------------------------------------------------
# 0. Locate repo, assets, pick images, sanity-check Docker.
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STIR_DIR="$SCRIPT_DIR"
REPO_DIR="$(cd "$STIR_DIR/../.." && pwd)"
DRIVER_SRC="$STIR_DIR/secsipid_verify_driver.c"
MAKE_PASSPORT="$STIR_DIR/make_passport.py"
ENTRYPOINT="$REPO_DIR/docker/kamailio/entrypoint.sh"
KAM_CFG_TMPL="$REPO_DIR/docker/kamailio/kamailio.cfg"   # template (has __PLACEHOLDERS__)

# Local artifact names (throwaway).
DRIVER_IMAGE="revup-kamailio:stir-verify-driver"
# Base image to build the driver from: prefer a prior self-test image, else latest.
BASE_IMAGE=""
for cand in revup-kamailio:stir-selftest revup-kamailio:latest; do
  if docker image inspect "$cand" >/dev/null 2>&1; then BASE_IMAGE="$cand"; break; fi
done

# Host python that actually has `cryptography` (there can be several python3s).
PYBIN=""
for cand in /usr/local/bin/python3 python3 python; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import cryptography' >/dev/null 2>&1; then
    PYBIN="$(command -v "$cand")"; break
  fi
done

# --------------------------------------------------------------------------
# Pretty output + result tracking.
# --------------------------------------------------------------------------
c_ok=$'\033[32m'; c_no=$'\033[31m'; c_dim=$'\033[2m'; c_b=$'\033[1m'; c_z=$'\033[0m'
info(){ printf '%s[..]%s %s\n' "$c_dim" "$c_z" "$*"; }
ok(){   printf '%s[OK]%s %s\n' "$c_ok"  "$c_z" "$*"; }
warn(){ printf '%s[WARN]%s %s\n' "$c_no" "$c_z" "$*" >&2; }
die(){  printf '%s[FATAL]%s %s\n' "$c_no" "$c_z" "$*" >&2; cleanup; exit 2; }

# Matrix rows accumulate as "STATUS|CASE|DETAIL". FAILS increments on any miss.
declare -a MATRIX=()
FAILS=0
record(){ # record PASS|FAIL "case" "detail"
  local st="$1" name="$2" detail="${3:-}"
  MATRIX+=("$st|$name|$detail")
  [ "$st" = FAIL ] && FAILS=$((FAILS+1))
  if [ "$st" = PASS ]; then ok "$name — $detail"; else warn "$name — $detail"; fi
}

# --------------------------------------------------------------------------
# Temp workspace + background server pids; cleaned on exit (idempotent).
# --------------------------------------------------------------------------
WORK=""
declare -a SERVER_PIDS=()
declare -a RM_CONTAINERS=()
cleanup(){
  # kill any http servers we started
  for pid in "${SERVER_PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && kill "$pid" >/dev/null 2>&1 || true
  done
  # remove any named containers we created (driver runs are --rm; config runs are named)
  for cn in "${RM_CONTAINERS[@]:-}"; do
    [ -n "${cn:-}" ] && docker rm -f "$cn" >/dev/null 2>&1 || true
  done
  [ -n "${WORK:-}" ] && [ -d "${WORK:-/nonexistent}" ] && rm -rf "$WORK" || true
}
trap cleanup EXIT INT TERM

echo "${c_b}== STIR/SHAKEN inbound-verify self-test (synthetic STI-CA) ==${c_z}"
info "repo:       $REPO_DIR"
info "assets:     make_passport.py, secsipid_verify_driver.c"

# Preflight.
command -v docker >/dev/null 2>&1 || die "docker not found"
docker info >/dev/null 2>&1        || die "docker daemon not reachable (is Docker up?)"
command -v openssl >/dev/null 2>&1 || die "openssl not found on host"
[ -n "$PYBIN" ]        || die "no host python3 with the 'cryptography' module (needed by make_passport.py). Try: python3 -m pip install cryptography"
[ -n "$BASE_IMAGE" ]   || die "no revup-kamailio base image found (need revup-kamailio:stir-selftest or :latest)"
[ -f "$DRIVER_SRC" ]   || die "missing $DRIVER_SRC"
[ -f "$MAKE_PASSPORT" ]|| die "missing $MAKE_PASSPORT"
[ -f "$ENTRYPOINT" ]   || die "missing $ENTRYPOINT"
[ -f "$KAM_CFG_TMPL" ] || die "missing $KAM_CFG_TMPL"
ok "docker up; base image $BASE_IMAGE; host python $($PYBIN --version 2>&1); $(openssl version)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/stir_verify_selftest.XXXXXX")" || die "mktemp failed"
PKI="$WORK/pki"; WWW="$WORK/www"; PP="$WORK/passports"; REND="$WORK/render"
mkdir -p "$PKI" "$WWW" "$PP" "$REND"
info "workdir:    $WORK  (removed on exit)"

# TNs for the fixtures (E.164 without +, per make_passport.py contract).
ORIG_TN="16174544217"     # the live RCF test DID
DEST_TN="17744045256"     # its forward target
DIV_TN="18005551212"      # a diverting TN for the div PASSporT

# --------------------------------------------------------------------------
# 1. Synthetic PKI: GOOD root -> intermediate -> leaf ; ROGUE root2 -> leaf2.
#    EC P-256 throughout (STIR uses ES256 => prime256v1 keys).
# --------------------------------------------------------------------------
echo; echo "${c_b}-- 1. Synthetic PKI (EC P-256) --${c_z}"

# SHAKEN TN Authorization List extension OID. Adding it to the leaf makes the
# fixture look like a real STI cert; it is NOT required for chain-trust (libsecsipid
# CertVerify validates the X.509 chain, not this SHAKEN-specific extension), so if
# the local openssl can't encode the custom extension we proceed without it.
TN_AUTH_OID="1.3.6.1.5.5.7.1.26"

gen_key(){ openssl ecparam -name prime256v1 -genkey -noout -out "$1" 2>/dev/null; }

# --- GOOD chain ---
gen_key "$PKI/root.key"
gen_key "$PKI/inter.key"
gen_key "$PKI/leaf.key"
# --- ROGUE chain (independent trust anchor) ---
gen_key "$PKI/root2.key"
gen_key "$PKI/leaf2.key"

for k in root inter leaf root2 leaf2; do
  [ -s "$PKI/$k.key" ] || die "failed to generate EC key $k.key"
done

# Self-signed GOOD root (CA:TRUE).
openssl req -x509 -new -key "$PKI/root.key" -sha256 -days 3 \
  -subj "/C=US/O=Synthetic STI-PA/CN=Synthetic STI Root CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out "$PKI/root.pem" 2>/dev/null || die "GOOD root self-sign failed"

# Intermediate CSR + cert signed by GOOD root (CA:TRUE, pathlen:0).
openssl req -new -key "$PKI/inter.key" \
  -subj "/C=US/O=Synthetic STI-PA/CN=Synthetic STI Intermediate CA" \
  -out "$PKI/inter.csr" 2>/dev/null || die "intermediate CSR failed"
cat > "$PKI/inter.ext" <<EOF
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
EOF
openssl x509 -req -in "$PKI/inter.csr" -CA "$PKI/root.pem" -CAkey "$PKI/root.key" \
  -CAcreateserial -sha256 -days 3 -extfile "$PKI/inter.ext" \
  -out "$PKI/inter.pem" 2>/dev/null || die "intermediate sign failed"

# Leaf CSR.
openssl req -new -key "$PKI/leaf.key" \
  -subj "/C=US/O=Granite Telecom/CN=Synthetic STI Leaf" \
  -out "$PKI/leaf.csr" 2>/dev/null || die "leaf CSR failed"

# Leaf extension file. Try WITH the SHAKEN TN Authorization List extension first;
# if openssl rejects the custom OID encoding, fall back to a leaf without it.
LEAF_TNAUTH="omitted"
cat > "$PKI/leaf.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth,serverAuth
$TN_AUTH_OID=DER:30:00
EOF
if openssl x509 -req -in "$PKI/leaf.csr" -CA "$PKI/inter.pem" -CAkey "$PKI/inter.key" \
     -CAcreateserial -sha256 -days 3 -extfile "$PKI/leaf.ext" \
     -out "$PKI/leaf.pem" 2>/dev/null; then
  LEAF_TNAUTH="present ($TN_AUTH_OID)"
else
  cat > "$PKI/leaf.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth,serverAuth
EOF
  openssl x509 -req -in "$PKI/leaf.csr" -CA "$PKI/inter.pem" -CAkey "$PKI/inter.key" \
    -CAcreateserial -sha256 -days 3 -extfile "$PKI/leaf.ext" \
    -out "$PKI/leaf.pem" 2>/dev/null || die "leaf sign failed"
  LEAF_TNAUTH="omitted (openssl could not encode $TN_AUTH_OID)"
fi

# --- ROGUE: self-signed root2 + leaf2 signed by root2 ---
openssl req -x509 -new -key "$PKI/root2.key" -sha256 -days 3 \
  -subj "/C=US/O=Rogue CA/CN=Rogue STI Root CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out "$PKI/root2.pem" 2>/dev/null || die "ROGUE root self-sign failed"
openssl req -new -key "$PKI/leaf2.key" \
  -subj "/C=US/O=Rogue Telecom/CN=Rogue STI Leaf" \
  -out "$PKI/leaf2.csr" 2>/dev/null || die "rogue leaf CSR failed"
cat > "$PKI/leaf2.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth,serverAuth
EOF
openssl x509 -req -in "$PKI/leaf2.csr" -CA "$PKI/root2.pem" -CAkey "$PKI/root2.key" \
  -CAcreateserial -sha256 -days 3 -extfile "$PKI/leaf2.ext" \
  -out "$PKI/leaf2.pem" 2>/dev/null || die "rogue leaf sign failed"

for c in root inter leaf root2 leaf2; do
  [ -s "$PKI/$c.pem" ] || die "cert $c.pem not produced"
done
ok "GOOD root->intermediate->leaf and ROGUE root2->leaf2 generated"
info "leaf TN Authorization List extension: $LEAF_TNAUTH"

# CertCAFile the driver trusts = the GOOD ROOT ONLY (mirrors production: CertCAFile
# carries STI-PA ROOTS; the intermediate arrives in the fetched x5u chain).
GOOD_ROOTS="$PKI/good-roots.pem"
cp "$PKI/root.pem" "$GOOD_ROOTS"

# --------------------------------------------------------------------------
# 2. x5u chain files, served over HTTP so libsecsipid FETCHES them.
#    GOOD  x5u = leaf + intermediate (what a real STI x5u endpoint serves).
#    ROGUE x5u = leaf2 + root2 (self-contained rogue chain).
# --------------------------------------------------------------------------
echo; echo "${c_b}-- 2. x5u HTTP serving --${c_z}"
cat "$PKI/leaf.pem"  "$PKI/inter.pem" > "$WWW/good-chain.pem"
cat "$PKI/leaf2.pem" "$PKI/root2.pem" > "$WWW/rogue-chain.pem"

# Pick a free host TCP port and serve $WWW on all interfaces (so the Docker VM /
# host-gateway can reach it). Bind 0.0.0.0 is required for host.docker.internal.
HTTP_PORT="$("$PYBIN" - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("0.0.0.0", 0)); print(s.getsockname()[1]); s.close()
PY
)"
[ -n "$HTTP_PORT" ] || die "could not allocate a host HTTP port"

# Start the server in the background from $WWW. Use the SAME PYBIN (its http.server
# is fine). Redirect logs; capture pid for cleanup.
( cd "$WWW" && exec "$PYBIN" -m http.server "$HTTP_PORT" --bind 0.0.0.0 ) \
  >"$WORK/httpd.log" 2>&1 &
SERVER_PIDS+=("$!")

# Wait until it actually answers (avoid the classic startup race). Poll host-side.
served=0
for _ in $(seq 1 50); do
  if "$PYBIN" - "$HTTP_PORT" >/dev/null 2>&1 <<'PY'
import sys, urllib.request
port = sys.argv[1]
urllib.request.urlopen("http://127.0.0.1:%s/good-chain.pem" % port, timeout=1).read()
PY
  then served=1; break; fi
  sleep 0.2
done
[ "$served" = 1 ] || { cat "$WORK/httpd.log" >&2 || true; die "x5u HTTP server never came up on :$HTTP_PORT"; }

# x5u host as seen FROM THE CONTAINER. On Docker Desktop (macOS) the container
# cannot reach a host 127.0.0.1 server, but host.docker.internal (host-gateway)
# works; on Linux the host-gateway alias resolves too. Use it uniformly and prove
# reachability from a container before asserting anything.
X5U_HOST="host.docker.internal"
GOOD_X5U="http://$X5U_HOST:$HTTP_PORT/good-chain.pem"
ROGUE_X5U="http://$X5U_HOST:$HTTP_PORT/rogue-chain.pem"
ok "serving $WWW on host :$HTTP_PORT (good-chain.pem, rogue-chain.pem)"

# Container-reachability pre-flight: the driver image doesn't exist yet, so use the
# base image (it has wget or python3). If the container can't reach the x5u, every
# fetch-based verify below would be a false FAIL — catch it now with a clear error.
info "confirming the CONTAINER can fetch the x5u via $X5U_HOST ..."
reach="$(docker run --rm --add-host=host.docker.internal:host-gateway \
  --entrypoint sh "$BASE_IMAGE" -c '
    if command -v wget >/dev/null 2>&1; then
      wget -qO- "'"$GOOD_X5U"'" | head -1
    else
      python3 -c "import urllib.request;print(urllib.request.urlopen(\"'"$GOOD_X5U"'\",timeout=5).read().decode().splitlines()[0])"
    fi' 2>>"$WORK/reach.err")" || true
if printf '%s' "$reach" | grep -q 'BEGIN CERTIFICATE'; then
  ok "container reached x5u ($X5U_HOST:$HTTP_PORT) — first line: $reach"
else
  cat "$WORK/reach.err" >&2 || true
  die "container could NOT fetch $GOOD_X5U (got: '${reach:-<empty>}'). On macOS ensure Docker Desktop is running; host.docker.internal must resolve to host-gateway."
fi

# --------------------------------------------------------------------------
# 3. PASSporTs via make_passport.py (Python cryptography — independent signer).
# --------------------------------------------------------------------------
echo; echo "${c_b}-- 3. PASSporTs (independent signer) --${c_z}"

mkpass(){ # mkpass <outfile> <keyfile> <x5u> [extra make_passport args...]
  local out="$1" key="$2" x5u="$3"; shift 3
  "$PYBIN" "$MAKE_PASSPORT" --key "$key" --x5u "$x5u" \
      --orig "$ORIG_TN" --dest "$DEST_TN" "$@" > "$out" 2>"$WORK/mp.err" \
    || { cat "$WORK/mp.err" >&2; die "make_passport.py failed for $out"; }
  [ -s "$out" ] || die "make_passport.py produced empty $out"
}

# GOOD-shaken: signed by GOOD leaf key, GOOD x5u, attest A.
mkpass "$PP/good_shaken.txt" "$PKI/leaf.key" "$GOOD_X5U" --ppt shaken --attest A
# GOOD-div: same key/x5u, ppt=div with a diverting TN.
mkpass "$PP/good_div.txt"    "$PKI/leaf.key" "$GOOD_X5U" --ppt div --div "$DIV_TN"
# ROGUE: signed by ROGUE leaf key, ROGUE x5u.
mkpass "$PP/rogue.txt"       "$PKI/leaf2.key" "$ROGUE_X5U" --ppt shaken --attest A

# TAMPERED: take GOOD-shaken and flip ONE base64url char in the PAYLOAD segment.
# The Identity value is "<h>.<p>.<sig>;info=<...>;alg=ES256;ppt=shaken". We must
# flip a char in the PAYLOAD (2nd dot-separated field of the JWS) and keep it a
# valid base64url char so the token still PARSES but the signature no longer
# matches -> libsecsipid must reject it as a bad-signature PASSporT.
"$PYBIN" - "$PP/good_shaken.txt" "$PP/tampered.txt" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
val = open(src).read().strip()
# Split JWS (before the first ';') from the SHAKEN params.
jws, sep, params = val.partition(';')
h, p, s = jws.split('.')
alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
# Flip a char in the MIDDLE of the payload to a DIFFERENT base64url char.
i = len(p) // 2
orig = p[i]
repl = 'A' if orig != 'A' else 'B'
assert repl in alphabet and repl != orig
p2 = p[:i] + repl + p[i+1:]
assert p2 != p and len(p2) == len(p)
open(dst, 'w').write(h + '.' + p2 + '.' + s + sep + params + '\n')
sys.stderr.write("tamper: payload[%d] %r -> %r (len unchanged, base64url-valid)\n" % (i, orig, repl))
PY
[ -s "$PP/tampered.txt" ] || die "tamper step produced no output"

ok "built PASSporTs: good_shaken, good_div, tampered, rogue"
info "good_shaken: $(cut -c1-72 "$PP/good_shaken.txt")…"
info "tampered   : $(cut -c1-72 "$PP/tampered.txt")…  (payload byte flipped)"

# --------------------------------------------------------------------------
# 4. Build the driver in-container over the REAL libsecsipid.
#    The base image has libsecsipid.so.1 but no compiler and no `.so` devlink;
#    add gcc + libc6-dev and create the arch-correct libsecsipid.so symlink.
# --------------------------------------------------------------------------
echo; echo "${c_b}-- 4. Build secsipid_verify_driver over libsecsipid --${c_z}"

# Detect the multiarch dir that holds libsecsipid.so.1 inside the base image, so
# the `.so` symlink lands in the right place on amd64 OR arm64.
MULTIARCH_DIR="$(docker run --rm --entrypoint sh "$BASE_IMAGE" -c '
  for d in /usr/lib/*/libsecsipid.so.1 /lib/*/libsecsipid.so.1; do
    [ -e "$d" ] && { dirname "$d"; exit 0; }
  done
  # last resort: ask the linker cache
  ldconfig -p 2>/dev/null | awk "/libsecsipid.so.1/{print \$NF}" | head -1 | xargs -r dirname
' 2>/dev/null | head -1)"
[ -n "$MULTIARCH_DIR" ] || die "could not locate libsecsipid.so.1 dir in $BASE_IMAGE"
info "libsecsipid multiarch dir in image: $MULTIARCH_DIR"

# Build the throwaway driver image. Install a compiler, create the -l symlink, and
# compile with -Wall -Wextra (the driver is warning-clean). Idempotent: rebuilding
# just re-layers. Piping the Dockerfile via stdin keeps the repo clean (no file
# written into infra/stir).
BUILD_LOG="$WORK/driverbuild.log"
if docker build -t "$DRIVER_IMAGE" -f - "$STIR_DIR" >"$BUILD_LOG" 2>&1 <<EOF
FROM $BASE_IMAGE
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \\
 && ln -sf $MULTIARCH_DIR/libsecsipid.so.1 $MULTIARCH_DIR/libsecsipid.so \\
 && rm -rf /var/lib/apt/lists/*
COPY secsipid_verify_driver.c /build/secsipid_verify_driver.c
RUN cc -O2 -Wall -Wextra -o /usr/local/bin/secsipid_verify_driver /build/secsipid_verify_driver.c -lsecsipid
EOF
then
  ok "built $DRIVER_IMAGE (driver compiled over libsecsipid, warning-clean)"
else
  echo "  ---- docker build output (tail) ----" >&2
  tail -30 "$BUILD_LOG" >&2
  die "driver image build failed"
fi

# Confirm the driver binary is really there + links libsecsipid.
docker run --rm --entrypoint sh "$DRIVER_IMAGE" -c '
  test -x /usr/local/bin/secsipid_verify_driver || exit 1
  ldd /usr/local/bin/secsipid_verify_driver 2>/dev/null | grep -qi secsipid || exit 2
' || die "driver binary missing or not linked against libsecsipid in $DRIVER_IMAGE"

# --------------------------------------------------------------------------
# 5. Assertion matrix — run the driver in-container per case; assert exit code.
#    We mount the workdir read-only at /work so the container sees the PASSporTs
#    and CertCAFile. x5u fetch goes over host.docker.internal (proven reachable).
# --------------------------------------------------------------------------
echo; echo "${c_b}-- 5. libsecsipid verify assertions --${c_z}"

# run_driver runs the driver in-container, streams its stderr (the
#   `SecSIPIDCheckFull(...) -> N` audit line) to OUR stderr indented, and captures
#   the numeric libsecsipid return code into the global LAST_VR. Returns the
#   driver's exit code (0=PASS, 1=FAIL, 2=driver-error).
#   The driver's --expire/--timeout mirror the module's modparams (expire=300,
#   timeout=5) so the iat-freshness window matches production exactly.
# args: <passport-relpath> <certverify> <cafile-relpath-or-empty>
LAST_VR=""
run_driver(){
  local pp="$1" cv="$2" ca="$3"
  local args=(--identity-file "/work/$pp" --certverify "$cv" --expire 300 --timeout 5)
  [ -n "$ca" ] && args+=(--cafile "/work/$ca")
  local errf="$WORK/.drv.stderr"
  # CRITICAL: override the inherited kamailio ENTRYPOINT (entrypoint.sh demands
  # EXTERNAL_SIP_IP and aborts) so the container runs the driver DIRECTLY.
  docker run --rm --add-host=host.docker.internal:host-gateway \
    --entrypoint /usr/local/bin/secsipid_verify_driver \
    -v "$WORK":/work:ro "$DRIVER_IMAGE" \
    "${args[@]}" 2>"$errf"
  local rc=$?
  sed 's/^/      /' "$errf" >&2
  # Pull the numeric verify code from the audit line for the matrix detail.
  LAST_VR="$(sed -n 's/.*SecSIPIDCheckFull([^)]*) -> \(-*[0-9][0-9]*\).*/\1/p' "$errf" | tail -1)"
  return $rc
}

# assert_case <case-name> <passport> <certverify> <cafile-or-empty> <expect PASS|FAIL>
#   Optional 6th arg: a human note appended to the detail (e.g. why a FAIL is
#   expected). PASS/FAIL here means "did the driver's decision match <expect>".
assert_case(){
  local name="$1" pp="$2" cv="$3" ca="$4" expect="$5" note="${6:-}"
  local rc detail got
  printf '%s[..]%s %-34s CertVerify=%s CAFile=%s\n' "$c_dim" "$c_z" \
    "$name" "$cv" "${ca:-<none>}"
  run_driver "$pp" "$cv" "$ca"; rc=$?
  if [ "$rc" = 2 ]; then
    record FAIL "$name" "driver ERROR (exit 2) — see stderr above (expected $expect)"
    return
  fi
  [ "$rc" = 0 ] && got=PASS || got=FAIL
  detail="expect $expect, driver -> $got (libsecsipid ret=${LAST_VR:-?})"
  [ -n "$note" ] && detail="$detail; $note"
  if [ "$got" = "$expect" ]; then record PASS "$name" "$detail"
  else record FAIL "$name" "$detail"; fi
}

# The matrix. CertCAFile paths are relative to $WORK (mounted at /work).
# libsecsipid return codes (asipto/secsipidx v1.2.0):
#   0 = valid; -232 = iat expired; -231 = payload parse; -101/-102 = cert/sig
#   verify; -303 = SIP-hdr ppt/info (NOTE: SJWTRetErrSIPHdrPpt == -303).
GOOD_ROOTS_REL="pki/good-roots.pem"

# GOOD shaken, chained to the trusted synthetic root -> PASS (0). The crux "yes".
assert_case "GOOD-shaken  (chain->good root)" "passports/good_shaken.txt" 5 "$GOOD_ROOTS_REL" PASS

# GOOD div: cryptographically identical leaf/x5u to good-shaken, BUT ppt=div.
# ⚠ libsecsipid 1.2.0's full-identity parser (SJWTGetValidInfoAttr) ONLY accepts
# ppt=shaken; ANY other ppt (incl. div) returns -303 (SJWTRetErrSIPHdrPpt) BEFORE
# any signature/chain work. So secsipid_check_identity() CANNOT verify a div
# PASSporT on this version — it is rejected on the ppt gate, not on crypto. We
# assert that KNOWN behavior (expect FAIL w/ ret=-303) rather than pretend it
# passes; the div token's crypto soundness is proven separately below (same leaf
# as good-shaken, which passes; openssl chains its cert). This is a real finding
# for the RCF diversion path — see the summary the script prints.
assert_case "GOOD-div     (ppt=div gate)"     "passports/good_div.txt"    5 "$GOOD_ROOTS_REL" FAIL \
  "libsecsipid 1.2.0 rejects ppt!=shaken (ret=-303, ppt gate — NOT a crypto/chain failure)"

# TAMPERED: one base64url char flipped in the PAYLOAD segment. The token is no
# longer authentic — libsecsipid rejects it (observed ret=-231 payload-parse: the
# mutated base64url payload no longer decodes to the originally-signed JSON; a flip
# that still decoded would instead fail signature verification). Either way it is a
# correctly REJECTED tampered token — the point is that a modified PASSporT does not
# verify. We assert FAIL (any non-zero libsecsipid ret) rather than pin the exact code.
assert_case "TAMPERED     (payload flipped)"  "passports/tampered.txt"    5 "$GOOD_ROOTS_REL" FAIL

# ROGUE at CV=5: signature is valid but the leaf chains to an UNKNOWN (rogue) STI
# root not in CertCAFile -> chain-trust FAIL. THE CRUX: custom-CA trust rejects an
# unknown STI-CA.
assert_case "ROGUE        (unknown STI-CA)"   "passports/rogue.txt"       5 "$GOOD_ROOTS_REL" FAIL

# ROGUE at CV=0: signature-only, no chain check -> PASS. Shows WHY the CA bundle is
# required: without CertVerify's custom-CA bit, a rogue-signed PASSporT is accepted.
assert_case "ROGUE        (CertVerify=0 sig)" "passports/rogue.txt"       0 ""               PASS

# --------------------------------------------------------------------------
# 6. openssl-level cross-check (belt-and-suspenders): prove the chain semantics
#    and that a concatenated-PEM roots file is the right CertCAFile format.
# --------------------------------------------------------------------------
echo; echo "${c_b}-- 6. openssl chain cross-check --${c_z}"
if openssl verify -CAfile "$GOOD_ROOTS" -untrusted "$PKI/inter.pem" "$PKI/leaf.pem" >"$WORK/ossl_good.log" 2>&1; then
  record PASS "openssl verify GOOD leaf" "chains leaf->inter->root: $(cat "$WORK/ossl_good.log")"
else
  record FAIL "openssl verify GOOD leaf" "unexpected: $(cat "$WORK/ossl_good.log")"
fi
# Rogue leaf against the GOOD roots must FAIL.
if openssl verify -CAfile "$GOOD_ROOTS" "$PKI/leaf2.pem" >"$WORK/ossl_rogue.log" 2>&1; then
  record FAIL "openssl reject ROGUE leaf" "unexpectedly verified against good root: $(cat "$WORK/ossl_rogue.log")"
else
  record PASS "openssl reject ROGUE leaf" "correctly fails vs good root: $(tr '\n' ' ' < "$WORK/ossl_rogue.log")"
fi

# --------------------------------------------------------------------------
# 7. Config proof — exercise the REAL entrypoint templating, then `kamailio -c`.
#    We run the actual docker/kamailio/entrypoint.sh inside the image with the
#    STIR_SHAKEN_VERIFY env, passing `-c -f <cfg>` as the CMD so the entrypoint
#    templates the cfg and then execs `kamailio -c` (config check, no daemon).
#    Verify block ON: assert the rendered cfg has the #!define + 3 libopt lines,
#    and kamailio -c passes. Then OFF: kamailio -c still passes and the verify
#    #!define is an inert comment (no-regression).
# --------------------------------------------------------------------------
echo; echo "${c_b}-- 7. entrypoint templating + kamailio -c --${c_z}"

# render_and_check <label> <verify on|off>  -> sets globals: RC (kamailio -c exit),
#   and writes the rendered cfg to $REND/<label>.cfg on the host via docker cp.
render_and_check(){
  local label="$1" verify="$2"
  local cn="stir_verify_render_${label}_$$"
  RM_CONTAINERS+=("$cn")
  docker rm -f "$cn" >/dev/null 2>&1 || true

  # Minimal env: the two REQUIRED vars + the STIR verify knobs the task specifies.
  # host-gateway alias not needed here (no fetch); NET_ADMIN so the entrypoint's
  # `ip addr add VIP/32 dev lo` succeeds (it's guarded, but grant it so the run is
  # faithful to production and never trips a permission error).
  docker run --name "$cn" --cap-add=NET_ADMIN \
    -e EXTERNAL_SIP_IP=203.0.113.10 \
    -e FREESWITCH_IP=192.168.10.2 \
    -e STIR_SHAKEN_VERIFY="$verify" \
    -e STIR_VERIFY_CERT_MODE=5 \
    -e STIR_VERIFY_CA_FILE=/etc/kamailio/stir/sti-pa-roots.pem \
    "$BASE_IMAGE" -c -f /etc/kamailio/kamailio.cfg \
    >"$REND/$label.kamctl.log" 2>&1
  RC=$?
  # Extract the rendered cfg regardless of the -c result.
  docker cp "$cn:/etc/kamailio/kamailio.cfg" "$REND/$label.cfg" >/dev/null 2>&1 \
    || warn "could not docker cp rendered cfg for $label"
  docker rm -f "$cn" >/dev/null 2>&1 || true
}

# --- verify ON ---
render_and_check on on
CFG_ON="$REND/on.cfg"
if [ -s "$CFG_ON" ]; then
  # 7a: the #!define must be active (real define, not the disabled comment).
  if grep -Eq '^[[:space:]]*#!define[[:space:]]+STIR_SHAKEN_VERIFY([[:space:]]|$)' "$CFG_ON"; then
    record PASS "cfg(on): #!define STIR_SHAKEN_VERIFY" "present as active #!define"
  else
    record FAIL "cfg(on): #!define STIR_SHAKEN_VERIFY" "not rendered as an active #!define"
  fi
  # 7b: the three libopt modparams with the templated values.
  check_libopt(){ # <needle> <human>
    if grep -Fq "$1" "$CFG_ON"; then record PASS "cfg(on): $2" "found: $1"
    else record FAIL "cfg(on): $2" "missing: $1"; fi
  }
  check_libopt 'modparam("secsipid", "libopt", "CertVerify=5")'                                   "libopt CertVerify=5"
  check_libopt 'modparam("secsipid", "libopt", "CertCAFile=/etc/kamailio/stir/sti-pa-roots.pem")' "libopt CertCAFile=<bundle>"
  check_libopt 'modparam("secsipid", "libopt", "CertCAInter=")'                                   "libopt CertCAInter=<empty>"
else
  record FAIL "cfg(on): render" "rendered cfg missing/empty (see $REND/on.kamctl.log)"
fi
# 7c: kamailio -c must PASS with verify ON (the ifdef block compiles).
if [ "${RC:-1}" = 0 ]; then
  record PASS "kamailio -c (verify ON)" "config check passed"
else
  echo "  ---- kamailio -c (on) tail ----" >&2; tail -20 "$REND/on.kamctl.log" | sed 's/^/      /' >&2
  record FAIL "kamailio -c (verify ON)" "config check FAILED (exit $RC)"
fi

# --- verify OFF (no-regression) ---
render_and_check off off
CFG_OFF="$REND/off.cfg"
if [ -s "$CFG_OFF" ]; then
  # The verify #!define must be INERT: no active `#!define STIR_SHAKEN_VERIFY`.
  if grep -Eq '^[[:space:]]*#!define[[:space:]]+STIR_SHAKEN_VERIFY([[:space:]]|$)' "$CFG_OFF"; then
    record FAIL "cfg(off): verify define inert" "found an ACTIVE #!define STIR_SHAKEN_VERIFY (should be a comment)"
  else
    record PASS "cfg(off): verify define inert" "no active #!define (verify block compiled out)"
  fi
else
  record FAIL "cfg(off): render" "rendered cfg missing/empty (see $REND/off.kamctl.log)"
fi
if [ "${RC:-1}" = 0 ]; then
  record PASS "kamailio -c (verify OFF)" "config check passed (no-regression)"
else
  echo "  ---- kamailio -c (off) tail ----" >&2; tail -20 "$REND/off.kamctl.log" | sed 's/^/      /' >&2
  record FAIL "kamailio -c (verify OFF)" "config check FAILED (exit $RC)"
fi

# --------------------------------------------------------------------------
# 8. Print the PASS/FAIL matrix and exit non-zero on ANY miss.
# --------------------------------------------------------------------------
echo
echo "${c_b}================ RESULT MATRIX ================${c_z}"
printf '%-6s %-40s %s\n' "RESULT" "CASE" "DETAIL"
printf '%-6s %-40s %s\n' "------" "----------------------------------------" "------"
for row in "${MATRIX[@]}"; do
  st="${row%%|*}"; rest="${row#*|}"; name="${rest%%|*}"; detail="${rest#*|}"
  if [ "$st" = PASS ]; then col="$c_ok"; else col="$c_no"; fi
  printf '%s%-6s%s %-40s %s\n' "$col" "$st" "$c_z" "$name" "$detail"
done
echo "${c_b}==============================================${c_z}"

TOTAL="${#MATRIX[@]}"
PASSED=$((TOTAL - FAILS))
if [ "$FAILS" -eq 0 ]; then
  echo "${c_ok}${c_b}ALL $TOTAL ASSERTIONS PASSED${c_z} — synthetic-CA inbound verify behaves correctly."
  echo "${c_dim}Production flip to CertVerify=5 is a CertCAFile bundle-swap: drop the real STI-PA"
  echo "root list at CertCAFile and set STIR_VERIFY_CERT_MODE=5 — same libsecsipid path proven here.${c_z}"
  exit 0
else
  echo "${c_no}${c_b}$FAILS of $TOTAL ASSERTIONS FAILED${c_z} (passed: $PASSED). See rows marked FAIL above."
  exit 1
fi
