# ============================================================================
# stir-trust-lib.sh — SHARED validation gates for the STI-PA trusted-CA bundle
# ============================================================================
# Sourced (never executed) by:
#   refresh-stir-trust-bundle.sh  (services VM — fetch from STI-PA, publish)
#   refresh-sbc-trust-bundle.sh   (each SBC — pull the published copy)
# Both live in infra/stir/ and deploy via the same `git pull`, so the gates can
# never diverge between the publisher and the consumers.
#
# THE GATES (all must pass or the candidate is REJECTED and the currently
# installed bundle is kept untouched):
#   G1  candidate exists and is non-empty
#   G2  every PEM block parses as an X.509 CERTIFICATE (whole-bundle + per-cert)
#   G3  certificate count >= MIN_CA_CERTS (floor; catches truncated downloads)
#   G4  every certificate is currently within its validity window
#       (notBefore <= now < notAfter)
#   G5  the bundle anchors OUR OWN chain: `openssl verify` of the leaf in
#       OUR_CHAIN (infra/stir/granite-shaken-8052-x5u.pem = leaf + Neustar
#       SHAKEN CA-2 intermediate, NO root) against the candidate, with the
#       chain file as -untrusted. Passes only if the candidate contains the
#       Neustar root (or, with -partial_chain, the CA-2 intermediate) — i.e.
#       a list that would fail our own inbound calls can never install.
#
# WARNINGS (never block): any cert expiring within EXPIRY_WARN_DAYS.
#
# Portability: targets Debian (VMs) but runs on macOS for the local selftest —
# GNU/BSD date fallback, sha256sum/shasum fallback, -partial_chain detection.
# ============================================================================
# shellcheck shell=bash

# ---- tunables (override via environment) ----
: "${MIN_CA_CERTS:=5}"            # G3 floor — STI-PA list carries ~15+ CAs; 5 catches truncation
: "${EXPIRY_WARN_DAYS:=30}"       # warn (not fail) when any CA cert expires within this window
: "${STATUS_FILE:=/var/lib/stir/trust-bundle.status}"
: "${SYSLOG_TAG:=stir-trust-bundle}"
# ---- JWT (sticaList.jwt) ingestion tunables ----
# The REAL STI-PA CA list is an ES256 JWT reissued DAILY with a ~24h exp
# (measured 2026-08-28: issued 23:23Z, exp next day 22:43Z). J2 hard-fails an
# expired list and warns when exp is closer than this many seconds (default 6h —
# an about-to-die download; with a 24h lifetime a multi-day threshold would warn
# on every single ingest and mean nothing).
: "${TB_JWT_EXP_WARN_SECS:=21600}"
# The x5u in the JWT header must match this pattern (consistency check against
# the pinned signer; the STI-PA serves its signer cert at this URL scheme).
: "${TB_X5U_PATTERN:=^https://authenticate-api\.iconectiv\.com/download/v1/certificate/certificateId_[0-9]+\.crt$}"
# 1 = also fetch the header x5u live and require BYTE-match with the pinned
# signer (fail closed on mismatch = "STI-PA rotated their signing cert").
# Default 0: works offline/in selftests; the pinned-signature check alone is
# already fail-closed against tampering.
: "${TB_X5U_LIVECHECK:=0}"
# 1 = permit installing a list whose `sequence` is LOWER than the recorded one
# (deliberate operator rollback only; default rejects regression).
: "${TB_ALLOW_SEQ_REGRESSION:=0}"
# CRL freshness: 1 (publisher ingest) = nextUpdate in the past is a HARD fail;
# 0 (SBC pull) = warn only (the mirror may legitimately lag a few hours).
: "${TB_CRL_STRICT:=1}"
# Freshness watchdog (tb_check_freshness): FAIL --check when the installed
# bundle is older than this. The STI-PA reissues daily; the manual-download SLA
# is monthly — 40d = monthly + slack. This is the scream that stops a manual
# mirror from silently lapsing forever.
: "${TB_MAX_BUNDLE_AGE_DAYS:=40}"

# ---- collected results (reset by tb_validate_bundle; read by the sourcing
# ---- refresh scripts, hence the SC2034 waiver) ----
# shellcheck disable=SC2034
TB_FAILURES=()                    # hard gate failures (reasons)
TB_WARNINGS=()                    # non-blocking warnings
# shellcheck disable=SC2034
TB_CERT_COUNT=0
TB_NEXT_EXPIRY=""                 # soonest notAfter across the bundle (ISO-ish)
# ---- JWT/CRL ingest results (set by tb_jwt_ingest / tb_validate_crl; folded
# ---- into the status file by tb_write_status) ----
TB_JWT_SEQ=""                     # trustList `sequence` from the last JWT ingest
TB_JWT_EXP=""                     # trustList `exp` (epoch) from the last JWT ingest
TB_SRC_KIND=""                    # jwt|pem — how the current candidate arrived
TB_MARK_INSTALL=0                 # 1 => tb_write_status stamps INSTALLED_AT=now
# shellcheck disable=SC2034
TB_CRL_NEXTUPDATE=""              # nextUpdate of the last validated CRL

tb_sha256(){ # <file> -> hex digest
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

tb_date_epoch(){ # <openssl date string, e.g. "May  8 14:02:24 2026 GMT"> -> epoch
  local d="$1"
  date -u -d "$d" +%s 2>/dev/null \
    || date -u -j -f '%b %e %T %Y %Z' "$d" +%s 2>/dev/null \
    || echo ""
}

tb_cert_count(){ # <file> -> number of BEGIN CERTIFICATE blocks
  grep -c 'BEGIN CERTIFICATE' "$1" 2>/dev/null || true
}

tb_split_certs(){ # <bundle> <outdir> — writes cert0001.pem, cert0002.pem, ...
  awk -v dir="$2" '
    /-----BEGIN CERTIFICATE-----/ { n++; f=sprintf("%s/cert%04d.pem", dir, n) }
    f { print > f }
    /-----END CERTIFICATE-----/   { if (f) close(f); f="" }
  ' "$1"
}

# tb_validate_bundle <candidate.pem> <our_chain.pem>
# Runs ALL gates, fills TB_FAILURES/TB_WARNINGS/TB_CERT_COUNT/TB_NEXT_EXPIRY.
# Returns 0 only if every gate passed. Prints one line per gate.
tb_validate_bundle(){
  local cand="$1" our_chain="$2"
  local split_dir now_epoch soonest="" soonest_str=""
  TB_FAILURES=(); TB_WARNINGS=(); TB_CERT_COUNT=0; TB_NEXT_EXPIRY=""
  now_epoch=$(date -u +%s)

  # -- G1: exists + non-empty --------------------------------------------
  if [ ! -s "$cand" ]; then
    TB_FAILURES+=("G1: candidate missing or empty ($cand)")
    echo "  [GATE] G1 exists+non-empty: FAIL"
    return 1   # nothing further can run without bytes
  fi
  echo "  [GATE] G1 exists+non-empty: ok ($(wc -c < "$cand" | tr -d ' ') bytes)"

  # -- G2: PEM parses (whole bundle + every individual block) ------------
  local parse_ok=1
  if ! openssl crl2pkcs7 -nocrl -certfile "$cand" >/dev/null 2>&1; then
    parse_ok=0
    TB_FAILURES+=("G2: bundle does not parse as PEM CERTIFICATE(s) (openssl crl2pkcs7)")
  fi
  split_dir=$(mktemp -d "${TMPDIR:-/tmp}/tb_split.XXXXXX")
  tb_split_certs "$cand" "$split_dir"
  local n_files=0 c
  for c in "$split_dir"/cert*.pem; do
    [ -e "$c" ] || break
    n_files=$((n_files + 1))
    if ! openssl x509 -noout -in "$c" >/dev/null 2>&1; then
      parse_ok=0
      TB_FAILURES+=("G2: block $(basename "$c") is not a valid X.509 certificate")
    fi
  done
  # shellcheck disable=SC2034  # read by the sourcing refresh scripts
  TB_CERT_COUNT=$n_files
  local n_begin
  n_begin=$(tb_cert_count "$cand")
  if [ "$n_files" -ne "$n_begin" ]; then
    parse_ok=0
    TB_FAILURES+=("G2: $n_begin BEGIN markers but only $n_files complete blocks (truncated?)")
  fi
  if [ "$parse_ok" = 1 ]; then echo "  [GATE] G2 PEM parse: ok ($n_files certificate blocks)"
  else echo "  [GATE] G2 PEM parse: FAIL"; fi

  # -- G3: count floor ----------------------------------------------------
  if [ "$n_files" -ge "$MIN_CA_CERTS" ]; then
    echo "  [GATE] G3 count >= $MIN_CA_CERTS: ok ($n_files)"
  else
    TB_FAILURES+=("G3: only $n_files cert(s), floor is MIN_CA_CERTS=$MIN_CA_CERTS (truncated download?)")
    echo "  [GATE] G3 count >= $MIN_CA_CERTS: FAIL ($n_files)"
  fi

  # -- G4: every cert within validity window ------------------------------
  local validity_ok=1 nb_str na_str nb_ep na_ep subj
  for c in "$split_dir"/cert*.pem; do
    [ -e "$c" ] || break
    # skip blocks G2 already flagged unparseable
    openssl x509 -noout -in "$c" >/dev/null 2>&1 || continue
    subj=$(openssl x509 -noout -subject -in "$c" 2>/dev/null | sed 's/^subject=//')
    if ! openssl x509 -checkend 0 -noout -in "$c" >/dev/null 2>&1; then
      validity_ok=0
      TB_FAILURES+=("G4: EXPIRED cert in bundle: $subj")
    fi
    nb_str=$(openssl x509 -noout -startdate -in "$c" 2>/dev/null | cut -d= -f2)
    nb_ep=$(tb_date_epoch "$nb_str")
    if [ -n "$nb_ep" ] && [ "$nb_ep" -gt "$now_epoch" ]; then
      validity_ok=0
      TB_FAILURES+=("G4: NOT-YET-VALID cert in bundle (notBefore $nb_str): $subj")
    fi
    na_str=$(openssl x509 -noout -enddate -in "$c" 2>/dev/null | cut -d= -f2)
    na_ep=$(tb_date_epoch "$na_str")
    if [ -n "$na_ep" ]; then
      if [ -z "$soonest" ] || [ "$na_ep" -lt "$soonest" ]; then
        soonest=$na_ep; soonest_str=$na_str
      fi
      if [ "$na_ep" -lt $((now_epoch + EXPIRY_WARN_DAYS * 86400)) ] && [ "$na_ep" -ge "$now_epoch" ]; then
        TB_WARNINGS+=("cert expires within ${EXPIRY_WARN_DAYS}d ($na_str): $subj")
      fi
    fi
  done
  TB_NEXT_EXPIRY="$soonest_str"
  if [ "$validity_ok" = 1 ]; then echo "  [GATE] G4 validity window: ok (soonest notAfter: ${soonest_str:-n/a})"
  else echo "  [GATE] G4 validity window: FAIL"; fi

  # -- G5: candidate must anchor OUR OWN chain ----------------------------
  # OUR_CHAIN is leaf + intermediate (no root). Extract the leaf (first block)
  # and verify it against the candidate as the ONLY trust store, with the full
  # chain file supplying the intermediate as -untrusted. -partial_chain (when
  # available) mirrors Go x509 semantics (libsecsipid): any pool cert may
  # anchor, self-signed not required.
  if [ ! -s "$our_chain" ]; then
    TB_FAILURES+=("G5: our-chain reference missing ($our_chain) — cannot prove the bundle trusts OUR cert")
    echo "  [GATE] G5 anchors-our-chain: FAIL (reference chain missing)"
  else
    local our_dir verify_args verify_out
    our_dir=$(mktemp -d "${TMPDIR:-/tmp}/tb_our.XXXXXX")
    tb_split_certs "$our_chain" "$our_dir"
    verify_args=(-CAfile "$cand" -untrusted "$our_chain")
    if openssl verify -help 2>&1 | grep -q partial_chain; then
      verify_args=(-partial_chain "${verify_args[@]}")
    fi
    if verify_out=$(openssl verify "${verify_args[@]}" "$our_dir/cert0001.pem" 2>&1); then
      echo "  [GATE] G5 anchors-our-chain: ok ($verify_out)"
    else
      TB_FAILURES+=("G5: bundle does NOT anchor our own STI chain — our root is missing from the candidate ($(echo "$verify_out" | tr '\n' ' '))")
      echo "  [GATE] G5 anchors-our-chain: FAIL"
    fi
    rm -rf "$our_dir"
  fi

  rm -rf "$split_dir"

  local w
  for w in "${TB_WARNINGS[@]+"${TB_WARNINGS[@]}"}"; do echo "  [WARN] $w" >&2; done
  [ "${#TB_FAILURES[@]}" -eq 0 ]
}

# ============================================================================
# JWT ingestion — the OFFICIAL STI-PA artifact (sticaList.jwt)
# ============================================================================
# The STI-PA publishes the trusted-CA list as a compact ES256 JWS:
#   header  {"alg":"ES256","typ":"JWT","x5u":"https://authenticate-api.iconectiv.com/download/v1/certificate/certificateId_<id>.crt"}
#   payload {"version":"1.0","sequence":N,"exp":<epoch>,"trustList":["-----BEGIN CERTIFICATE-----\n...", ...]}
# We verify the signature against a REPO-PINNED copy of the STI-PA "CA List"
# signing cert (infra/stir/sti-pa-calist-signer.crt — public material, itself
# issued by "STI-PA Root Certificate 2"), then extract trustList into a plain
# PEM bundle and hand it to the ordinary G1–G5 gates. Pure bash+openssl by
# design: the refresh scripts' only runtime dependencies stay openssl+coreutils
# (python3 is a selftest-only dependency), so publisher/SBC/selftest behave
# identically.

tb_is_jwt(){ # <file> -> 0 if it looks like a compact JWS (base64url h.p.s)
  local first dots
  first=$(head -c 3 "$1" 2>/dev/null)
  [ "$first" = "eyJ" ] || return 1
  dots=$(head -1 "$1" | tr -cd '.' | wc -c | tr -d ' ')
  [ "$dots" = 2 ]
}

tb_b64url_dec(){ # <base64url string> -> raw bytes on stdout
  local s="${1//-/+}"
  s="${s//_//}"
  case $(( ${#s} % 4 )) in
    2) s="$s==" ;;
    3) s="$s=" ;;
    1) return 1 ;;
  esac
  printf '%s' "$s" | openssl base64 -d -A
}

tb_hex2bin(){ # <hex string> -> raw bytes on stdout (bash printf emits NULs fine)
  local h="$1" i
  for (( i=0; i<${#h}; i+=2 )); do printf '%b' "\\x${h:$i:2}"; done
}

tb_ecsig_raw2der(){ # <raw 64-byte R||S sig file> <out DER file> (JWS -> openssl)
  local hex r s rl sl body
  hex=$(od -An -v -tx1 "$1" | tr -d ' \n')
  [ ${#hex} -eq 128 ] || return 1
  r=${hex:0:64}; s=${hex:64:64}
  # minimal positive DER INTEGERs: strip leading 00 bytes, re-pad if high bit set
  while [ ${#r} -gt 2 ] && [ "${r:0:2}" = "00" ]; do r=${r:2}; done
  while [ ${#s} -gt 2 ] && [ "${s:0:2}" = "00" ]; do s=${s:2}; done
  case $r in [89a-f]*) r="00$r" ;; esac
  case $s in [89a-f]*) s="00$s" ;; esac
  rl=$(printf '%02x' $(( ${#r} / 2 ))); sl=$(printf '%02x' $(( ${#s} / 2 )))
  body="02${rl}${r}02${sl}${s}"
  tb_hex2bin "30$(printf '%02x' $(( ${#body} / 2 )))${body}" > "$2"
}

# tb_jwt_ingest <sticaList.jwt> <pinned-signer.crt> <out-bundle.pem>
# Gates J1 (pinned ES256 signature + x5u consistency + signer validity window),
# J2 (exp freshness + sequence regression vs the status file), J3 (trustList ->
# PEM extraction). Fills TB_JWT_SEQ/TB_JWT_EXP and appends to TB_FAILURES/
# TB_WARNINGS. Returns non-zero on ANY gate failure; the payload is never
# trusted (parsed for J2/J3) until the signature has passed.
tb_jwt_ingest(){
  local jwt="$1" pin="$2" out="$3"
  local tok dots h64 p64 s64 rest hdr x5u now_epoch
  local wdir hdr_ok=1
  TB_FAILURES=(); TB_WARNINGS=(); TB_JWT_SEQ=""; TB_JWT_EXP=""
  now_epoch=$(date -u +%s)
  wdir=$(mktemp -d "${TMPDIR:-/tmp}/tb_jwt.XXXXXX")

  # ---- J1: structure + pinned-signer ES256 signature -----------------------
  tok=$(tr -d '[:space:]' < "$jwt")
  dots=${tok//[^.]/}
  if [ ${#dots} -ne 2 ]; then
    TB_FAILURES+=("J1: not a compact JWS (expected header.payload.signature)")
    echo "  [GATE] J1 signature: FAIL (structure)"; rm -rf "$wdir"; return 1
  fi
  h64=${tok%%.*}; rest=${tok#*.}; p64=${rest%%.*}; s64=${rest#*.}
  if ! hdr=$(tb_b64url_dec "$h64" 2>/dev/null) || [ -z "$hdr" ]; then
    TB_FAILURES+=("J1: JWT header does not base64url-decode")
    echo "  [GATE] J1 signature: FAIL (header decode)"; rm -rf "$wdir"; return 1
  fi
  printf '%s' "$hdr" | grep -q '"alg"[[:space:]]*:[[:space:]]*"ES256"' || {
    TB_FAILURES+=("J1: header alg is not ES256 (algorithm confusion refused): $hdr"); hdr_ok=0; }
  x5u=$(printf '%s' "$hdr" | grep -o '"x5u"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  if [ -z "$x5u" ] || ! printf '%s' "$x5u" | grep -Eq "$TB_X5U_PATTERN"; then
    TB_FAILURES+=("J1: header x5u '${x5u:-<missing>}' does not match the expected STI-PA URL pattern ($TB_X5U_PATTERN)"); hdr_ok=0
  fi
  # pinned signer cert: present, parses, currently valid
  local nb_str nb_ep
  if [ ! -s "$pin" ] || ! openssl x509 -noout -in "$pin" >/dev/null 2>&1; then
    TB_FAILURES+=("J1: pinned STI-PA signer cert missing/unparseable ($pin)"); hdr_ok=0
  else
    openssl x509 -checkend 0 -noout -in "$pin" >/dev/null 2>&1 || {
      TB_FAILURES+=("J1: pinned STI-PA signer cert has EXPIRED ($pin) — re-pin from the STI-PA (verify against STI-PA Root Certificate 2 first)"); hdr_ok=0; }
    nb_str=$(openssl x509 -noout -startdate -in "$pin" 2>/dev/null | cut -d= -f2)
    nb_ep=$(tb_date_epoch "$nb_str")
    if [ -n "$nb_ep" ] && [ "$nb_ep" -gt "$now_epoch" ]; then
      TB_FAILURES+=("J1: pinned STI-PA signer cert not yet valid (notBefore $nb_str)"); hdr_ok=0
    fi
  fi
  if [ "$hdr_ok" != 1 ]; then
    echo "  [GATE] J1 signature: FAIL (pre-checks)"; rm -rf "$wdir"; return 1
  fi
  # the actual ES256 verification: sig(base64url raw R||S) -> DER, then
  # openssl dgst -verify over the exact signing input "header.payload"
  printf '%s.%s' "$h64" "$p64" > "$wdir/input"
  if ! tb_b64url_dec "$s64" > "$wdir/sig.raw" 2>/dev/null \
     || ! tb_ecsig_raw2der "$wdir/sig.raw" "$wdir/sig.der" \
     || ! openssl x509 -pubkey -noout -in "$pin" > "$wdir/pub.pem" 2>/dev/null \
     || ! openssl dgst -sha256 -verify "$wdir/pub.pem" -signature "$wdir/sig.der" "$wdir/input" >/dev/null 2>&1; then
    TB_FAILURES+=("J1: ES256 signature verification FAILED against the pinned STI-PA signer ($pin). If the STI-PA rotated their signing cert, verify the new one against 'STI-PA Root Certificate 2' and re-pin; otherwise this file is tampered/corrupt.")
    echo "  [GATE] J1 signature: FAIL"; rm -rf "$wdir"; return 1
  fi
  # optional live pin cross-check: the header x5u must serve EXACTLY our pin
  if [ "$TB_X5U_LIVECHECK" = 1 ]; then
    if curl -fsS --max-time 30 -o "$wdir/x5u.live" "$x5u" 2>/dev/null; then
      if cmp -s "$wdir/x5u.live" "$pin"; then
        echo "  [GATE] J1 x5u live byte-match: ok"
      else
        TB_FAILURES+=("J1: LIVE x5u ($x5u) does NOT byte-match the pinned signer — the STI-PA rotated their signing cert. FAIL CLOSED: verify the new cert chains to 'STI-PA Root Certificate 2', then replace infra/stir/sti-pa-calist-signer.crt and redeploy.")
        echo "  [GATE] J1 signature: FAIL (x5u rotation detected)"; rm -rf "$wdir"; return 1
      fi
    else
      TB_WARNINGS+=("J1: x5u live-check enabled but fetch failed ($x5u) — proceeding on the pinned signature alone")
    fi
  fi
  echo "  [GATE] J1 signature: ok (ES256 verified against pinned $(basename "$pin"); x5u pattern ok)"

  # ---- J2: freshness + sequence --------------------------------------------
  local payload exp seq prev_seq j2_ok=1
  payload=$(tb_b64url_dec "$p64" 2>/dev/null)
  exp=$(printf '%s' "$payload" | grep -o '"exp"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
  seq=$(printf '%s' "$payload" | grep -o '"sequence"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
  if [ -z "$exp" ]; then
    TB_FAILURES+=("J2: payload has no numeric exp"); j2_ok=0
  elif [ "$exp" -le "$now_epoch" ]; then
    TB_FAILURES+=("J2: list EXPIRED (exp $exp <= now $now_epoch) — the STI-PA reissues DAILY; download/fetch a fresh sticaList.jwt")
    j2_ok=0
  elif [ $(( exp - now_epoch )) -lt "$TB_JWT_EXP_WARN_SECS" ]; then
    TB_WARNINGS+=("J2: list exp is only $(( (exp - now_epoch) / 60 )) min away — ingest a fresher copy soon")
  fi
  TB_JWT_EXP="$exp"; TB_JWT_SEQ="$seq"
  prev_seq=$(tb_status_get LIST_SEQUENCE)
  if [ -n "$seq" ] && [ -n "$prev_seq" ] && [ "$seq" -lt "$prev_seq" ] 2>/dev/null; then
    if [ "$TB_ALLOW_SEQ_REGRESSION" = 1 ]; then
      TB_WARNINGS+=("J2: sequence REGRESSION $prev_seq -> $seq permitted by TB_ALLOW_SEQ_REGRESSION=1")
    else
      TB_FAILURES+=("J2: sequence REGRESSION — candidate sequence $seq < installed $prev_seq (replay of an older list?). Set TB_ALLOW_SEQ_REGRESSION=1 only for a deliberate rollback.")
      j2_ok=0
    fi
  fi
  if [ "$j2_ok" = 1 ]; then
    echo "  [GATE] J2 freshness: ok (sequence ${seq:-n/a}, exp ${exp:-n/a} = $(( (exp - now_epoch) / 3600 ))h out)"
  else
    echo "  [GATE] J2 freshness: FAIL"; rm -rf "$wdir"; return 1
  fi

  # ---- J3: trustList -> PEM bundle ------------------------------------------
  printf '%s' "$payload" \
    | sed -e 's/.*"trustList"[[:space:]]*:[[:space:]]*\[//' -e 's/\].*//' \
    | tr ',' '\n' \
    | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' \
    | awk '{ gsub(/\\n/, "\n"); print }' \
    | awk 'NF' > "$out"
  if [ -s "$out" ] && grep -q 'BEGIN CERTIFICATE' "$out"; then
    echo "  [GATE] J3 extraction: ok ($(tb_cert_count "$out") certificate blocks -> $out)"
  else
    TB_FAILURES+=("J3: trustList extraction produced no PEM certificates")
    echo "  [GATE] J3 extraction: FAIL"; rm -rf "$wdir"; return 1
  fi
  # shellcheck disable=SC2034
  TB_SRC_KIND=jwt
  rm -rf "$wdir"
  local w
  for w in "${TB_WARNINGS[@]+"${TB_WARNINGS[@]}"}"; do echo "  [WARN] $w" >&2; done
  return 0
}

# ============================================================================
# CRL — the STI-PA certificate revocation list (stipaCrl.crl, PEM, DAILY)
# ============================================================================
# tb_validate_crl <crl.pem> <pinned-crl-signer.crt>
# Gates: C1 parses as a PEM CRL; C2 signature verifies against the pinned
# STI-PA CRL signing cert (subject CN=STI-PA CRL, issuer STI-PA Root
# Certificate 2, pinned at infra/stir/sti-pa-crl-signer.crt) which must itself
# be within validity; C3 freshness — lastUpdate <= now, and nextUpdate in the
# future (HARD fail when TB_CRL_STRICT=1 [publisher ingest], warn when 0 [SBC
# pull: the mirror may lag a few hours]). These gates are LOAD-BEARING beyond
# hygiene: libsecsipid's CRL branch (secsipidx secsipid.go pubKeyVerify, the
# CertVerifyOptCRL block) IGNORES the x509.ParseCRL error and dereferences the
# result — a corrupt CRL file on an SBC would nil-panic the Go runtime inside
# Kamailio (cgo panic = process abort). Nothing unvalidated may ever land in
# CA_DIR.
tb_validate_crl(){
  local crl="$1" pin="$2"
  local lu_str nu_str lu_ep nu_ep now_epoch crl_ok=1
  TB_FAILURES=(); TB_WARNINGS=(); TB_CRL_NEXTUPDATE=""
  now_epoch=$(date -u +%s)

  if [ ! -s "$crl" ] || ! openssl crl -in "$crl" -noout >/dev/null 2>&1; then
    TB_FAILURES+=("C1: candidate does not parse as a PEM CRL ($crl)")
    echo "  [GATE] C1 CRL parse: FAIL"; return 1
  fi
  echo "  [GATE] C1 CRL parse: ok"

  if [ ! -s "$pin" ] || ! openssl x509 -noout -in "$pin" >/dev/null 2>&1; then
    TB_FAILURES+=("C2: pinned STI-PA CRL signer cert missing/unparseable ($pin)"); crl_ok=0
  elif ! openssl x509 -checkend 0 -noout -in "$pin" >/dev/null 2>&1; then
    TB_FAILURES+=("C2: pinned STI-PA CRL signer cert has EXPIRED ($pin) — re-pin (verify against STI-PA Root Certificate 2 first)"); crl_ok=0
  elif ! openssl crl -in "$crl" -noout -verify -CAfile "$pin" >/dev/null 2>&1; then
    TB_FAILURES+=("C2: CRL signature does NOT verify against the pinned STI-PA CRL signer ($pin) — tampered/corrupt, or the STI-PA rotated the CRL signing cert (re-pin after verifying against their Root 2)"); crl_ok=0
  fi
  if [ "$crl_ok" = 1 ]; then echo "  [GATE] C2 CRL signature: ok (pinned $(basename "$pin"))"
  else echo "  [GATE] C2 CRL signature: FAIL"; return 1; fi

  lu_str=$(openssl crl -in "$crl" -noout -lastupdate 2>/dev/null | cut -d= -f2)
  nu_str=$(openssl crl -in "$crl" -noout -nextupdate 2>/dev/null | cut -d= -f2)
  lu_ep=$(tb_date_epoch "$lu_str"); nu_ep=$(tb_date_epoch "$nu_str")
  # shellcheck disable=SC2034  # read by the sourcing refresh scripts
  TB_CRL_NEXTUPDATE="$nu_str"
  if [ -n "$lu_ep" ] && [ "$lu_ep" -gt "$now_epoch" ]; then
    TB_FAILURES+=("C3: CRL lastUpdate is in the FUTURE ($lu_str) — clock skew or forgery"); crl_ok=0
  fi
  if [ -n "$nu_ep" ] && [ "$nu_ep" -le "$now_epoch" ]; then
    if [ "$TB_CRL_STRICT" = 1 ]; then
      TB_FAILURES+=("C3: CRL is STALE (nextUpdate $nu_str is past; the STI-PA reissues daily) — fetch a fresh stipaCrl.crl"); crl_ok=0
    else
      TB_WARNINGS+=("C3: CRL nextUpdate $nu_str is past — mirror lag; still installing (revocation data ages gracefully)")
    fi
  fi
  if [ "$crl_ok" = 1 ]; then echo "  [GATE] C3 CRL freshness: ok (lastUpdate $lu_str, nextUpdate $nu_str)"
  else echo "  [GATE] C3 CRL freshness: FAIL"; fi
  local w
  for w in "${TB_WARNINGS[@]+"${TB_WARNINGS[@]}"}"; do echo "  [WARN] $w" >&2; done
  [ "$crl_ok" = 1 ]
}

# ---- status-file helpers ---------------------------------------------------
tb_status_get(){ # <KEY> -> value from the current status file (empty if none)
  [ -f "$STATUS_FILE" ] || return 0
  sed -n "s/^$1=//p" "$STATUS_FILE" 2>/dev/null | head -1
}

# tb_check_freshness — the staleness watchdog for `--check` on the PUBLISHER.
# Appends to TB_FAILURES/TB_WARNINGS (does not reset — run after
# tb_validate_bundle). FAIL when the last install is older than
# TB_MAX_BUNDLE_AGE_DAYS (the manual-download flow's lapse alarm); WARN when the
# recorded list exp has passed (expected within a day on the manual flow — the
# PEM trust itself stays valid; it means the MIRROR is behind the daily reissue).
tb_check_freshness(){
  local installed_at list_exp now_epoch age_days
  now_epoch=$(date -u +%s)
  installed_at=$(tb_status_get INSTALLED_AT)
  list_exp=$(tb_status_get LIST_EXP)
  if [ -z "$installed_at" ]; then
    TB_WARNINGS+=("freshness: no INSTALLED_AT recorded yet (pre-JWT-era install) — age watchdog armed on the next --install")
    return 0
  fi
  age_days=$(( (now_epoch - installed_at) / 86400 ))
  if [ "$age_days" -gt "$TB_MAX_BUNDLE_AGE_DAYS" ]; then
    TB_FAILURES+=("freshness: installed bundle is ${age_days}d old (> TB_MAX_BUNDLE_AGE_DAYS=$TB_MAX_BUNDLE_AGE_DAYS) — the refresh flow has LAPSED; re-ingest a fresh sticaList.jwt now")
    return 1
  fi
  if [ -n "$list_exp" ] && [ "$list_exp" -le "$now_epoch" ] 2>/dev/null; then
    TB_WARNINGS+=("freshness: recorded list exp has passed (installed ${age_days}d ago) — mirror is behind the STI-PA daily reissue (fine within the ${TB_MAX_BUNDLE_AGE_DAYS}d SLA)")
  fi
  return 0
}

# ============================================================================
# Prometheus metrics emission — node_exporter textfile collector (STRICTLY
# fail-safe / additive)
# ============================================================================
# tb_emit_metrics <OK|FAIL> [bundle_file]
# Writes a .prom textfile (atomic: temp + mv, world-readable) for the
# node_exporter --collector.textfile.directory. Called from tb_write_status —
# i.e. on EVERY script action (install/fetch/check, success AND failure), so
# the daily --check cron doubles as the periodic re-emit. Every metric that can
# go stale is an epoch TIMESTAMP, not a boolean: if this file ever freezes
# (refresh broken, emission broken), the dashboard ages into yellow/red instead
# of showing forever-healthy — that failure mode is designed out.
#
# FAIL-SAFE CONTRACT: this function returns 0 on every path and swallows every
# error. A metrics problem must NEVER fail (or even warn) a trust refresh.
#
# TB_METRICS_DIR: override the output dir; empty (default) derives
# <dir of STATUS_FILE>/metrics — /var/lib/stir/metrics on the VMs (the exact
# host path docker-compose.services.yml bind-mounts into node_exporter), and
# the selftest's temp dir when STATUS_FILE is overridden. Set to "none" to
# disable emission entirely.
: "${TB_METRICS_DIR:=}"
TB_METRICS_FILE_NAME="stir_trust_bundle.prom"

tb_prom_line(){ # <name> <value> <help> — emits nothing unless value is numeric
  case "${2:-}" in ''|*[!0-9]*) return 0 ;; esac
  printf '# HELP %s %s\n# TYPE %s gauge\n%s %s\n' "$1" "$3" "$1" "$1" "$2"
}

tb_emit_metrics(){
  local st="${1:-FAIL}" bundle="${2:-}"
  local mdir out tmp now inst_at cnt lexp nexp_ep crl_file crl_ep leaf_ep last_ok run_ok
  mdir="${TB_METRICS_DIR:-$(dirname "$STATUS_FILE")/metrics}"
  [ "$mdir" != none ] || return 0
  out="$mdir/$TB_METRICS_FILE_NAME"
  now=$(date -u +%s)
  mkdir -p "$mdir" 2>/dev/null || return 0
  tmp=$(mktemp "$mdir/.prom.XXXXXX" 2>/dev/null) || return 0
  # status-file provenance (tb_write_status has just rewritten it)
  inst_at=$(tb_status_get INSTALLED_AT)
  cnt=$(tb_status_get CERT_COUNT)
  lexp=$(tb_status_get LIST_EXP)
  nexp_ep=$(tb_date_epoch "$(tb_status_get NEXT_EXPIRY)")
  if [ "$st" = OK ]; then
    run_ok=1; last_ok=$now
  else
    # carry the previous success timestamp forward across failures
    run_ok=0
    last_ok=$(awk '$1=="stir_trust_refresh_last_success_timestamp_seconds"{print $2}' "$out" 2>/dev/null | head -1)
  fi
  # the CRL is installed as a sibling of the bundle (publisher AND SBC layouts)
  crl_ep=""
  if [ -n "$bundle" ]; then
    crl_file="$(dirname "$bundle")/sti-pa-crl.pem"
    if [ -s "$crl_file" ]; then
      crl_ep=$(tb_date_epoch "$(openssl crl -in "$crl_file" -noout -nextupdate 2>/dev/null | cut -d= -f2)")
    fi
  fi
  # our own signing leaf (first cert of OUR_CHAIN = CN=SHAKEN 8052) notAfter
  leaf_ep=""
  if [ -n "${OUR_CHAIN:-}" ] && [ -s "${OUR_CHAIN:-}" ]; then
    leaf_ep=$(tb_date_epoch "$(openssl x509 -in "$OUR_CHAIN" -noout -enddate 2>/dev/null | cut -d= -f2)")
  fi
  {
    tb_prom_line stir_trust_bundle_installed_timestamp_seconds "$inst_at" \
      "Epoch of the last VERIFIED trust-bundle install (status INSTALLED_AT; watchdog SLA TB_MAX_BUNDLE_AGE_DAYS=40d)."
    tb_prom_line stir_trust_bundle_ca_count "$cnt" \
      "Certificates in the installed STI-PA trust bundle (official list carries 19 today; G3 floor MIN_CA_CERTS)."
    tb_prom_line stir_trust_bundle_next_ca_expiry_timestamp_seconds "$nexp_ep" \
      "Soonest notAfter across the installed bundle's CA certs."
    tb_prom_line stir_sticalist_expiry_timestamp_seconds "$lexp" \
      "exp claim of the last ingested sticaList.jwt (STI-PA reissues DAILY, ~24h lifetime; past exp = mirror behind the daily reissue)."
    tb_prom_line stir_crl_next_update_timestamp_seconds "$crl_ep" \
      "nextUpdate of the installed STI-PA CRL (absent = CRL not installed; only consumed at CertVerify bit 16)."
    tb_prom_line stir_leaf_cert_expiry_timestamp_seconds "$leaf_ep" \
      "notAfter of our own SHAKEN leaf (granite-shaken-8052; renewal due ~2027-04-01, expires 2027-05-08)."
    tb_prom_line stir_trust_refresh_last_run_timestamp_seconds "$now" \
      "Epoch of the last refresh-script run that wrote status (any action, OK or FAIL)."
    tb_prom_line stir_trust_refresh_last_run_status "$run_ok" \
      "1 = the last refresh-script run wrote STATUS=OK, 0 = FAIL."
    tb_prom_line stir_trust_refresh_last_success_timestamp_seconds "$last_ok" \
      "Epoch of the last STATUS=OK run (carried forward across failed runs)."
  } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 0; }
  chmod 0644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$out" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  return 0
}

# tb_write_status <OK|FAIL> <action> <detail> [bundle_file]
# Atomic key=value status file + syslog line. NEVER fails the caller.
tb_write_status(){
  local st="$1" action="$2" detail="$3" bundle="${4:-}"
  local dir tmp sha="" cnt="" exp="${TB_NEXT_EXPIRY:-}"
  local src_kind seq lexp inst_at
  dir=$(dirname "$STATUS_FILE")
  mkdir -p "$dir" 2>/dev/null || true
  if [ -n "$bundle" ] && [ -s "$bundle" ]; then
    sha=$(tb_sha256 "$bundle"); cnt=$(tb_cert_count "$bundle")
  fi
  # JWT-ingest provenance: recorded from THIS run ONLY when the caller marked a
  # real install (TB_MARK_INSTALL=1, set on content install AND on the verified
  # already-current no-op). Everything else (check/status/fetch dry-runs and —
  # critically — FAIL paths) carries the existing values forward, so a REJECTED
  # candidate's sequence can never poison the regression check.
  if [ "$TB_MARK_INSTALL" = 1 ] && [ -n "$TB_SRC_KIND" ]; then
    src_kind="$TB_SRC_KIND"; seq="$TB_JWT_SEQ"; lexp="$TB_JWT_EXP"
  else
    src_kind=$(tb_status_get SOURCE_KIND); seq=$(tb_status_get LIST_SEQUENCE); lexp=$(tb_status_get LIST_EXP)
  fi
  if [ "$TB_MARK_INSTALL" = 1 ]; then inst_at=$(date -u +%s)
  else inst_at=$(tb_status_get INSTALLED_AT); fi
  tmp=$(mktemp "$dir/.status.XXXXXX" 2>/dev/null) || return 0
  {
    echo "STATUS=$st"
    echo "ACTION=$action"
    echo "TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "DETAIL=$detail"
    echo "BUNDLE_SHA256=$sha"
    echo "CERT_COUNT=$cnt"
    echo "NEXT_EXPIRY=$exp"
    echo "SOURCE_KIND=$src_kind"
    echo "LIST_SEQUENCE=$seq"
    echo "LIST_EXP=$lexp"
    echo "INSTALLED_AT=$inst_at"
    echo "HOST=$(hostname)"
  } > "$tmp"
  mv -f "$tmp" "$STATUS_FILE"
  if [ "$st" = OK ]; then
    logger -t "$SYSLOG_TAG" -p daemon.info "$action OK: $detail" 2>/dev/null || true
  else
    logger -t "$SYSLOG_TAG" -p daemon.err "$action FAIL: $detail" 2>/dev/null || true
  fi
  # Prometheus textfile emission — strictly additive; can never fail the caller.
  tb_emit_metrics "$st" "$bundle" || true
}

tb_show_status(){ # pretty-print the status file + a live summary of <installed bundle>
  local bundle="${1:-}"
  echo "status file ($STATUS_FILE):"
  if [ -f "$STATUS_FILE" ]; then sed 's/^/    /' "$STATUS_FILE"
  else echo "    (none — refresh has never run here)"; fi
  if [ -n "$bundle" ]; then
    echo "installed bundle ($bundle):"
    if [ -s "$bundle" ]; then
      echo "    present: $(tb_cert_count "$bundle") cert(s), sha256 $(tb_sha256 "$bundle")"
    else
      echo "    ABSENT — not installed yet"
    fi
  fi
}
