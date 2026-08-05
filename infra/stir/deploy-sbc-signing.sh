#!/usr/bin/env bash
#
# deploy-sbc-signing.sh — enable STIR/SHAKEN outbound signing on ONE Kamailio SBC.
#
# Run AS ROOT on the SBC (after `sudo git pull` in /opt/revup):
#   sudo /opt/revup/infra/stir/deploy-sbc-signing.sh            # wire everything, signing OFF (dark)
#   sudo /opt/revup/infra/stir/deploy-sbc-signing.sh --enable   # turn signing ON
#   sudo /opt/revup/infra/stir/deploy-sbc-signing.sh --disable  # roll signing back OFF (fast revert)
#   sudo /opt/revup/infra/stir/deploy-sbc-signing.sh --status   # show current state + recent signing logs
#
# PREREQUISITE — deliver the STI private key first (it is a SECRET, never in git):
#   sudo mkdir -p /opt/revup/secrets && sudo tee /opt/revup/secrets/stir-key.pem   # paste, then Ctrl-D
#   (default path below; override with KEY_SRC=/path). The script REFUSES to enable
#   unless the key's public half matches the cert served at the x5u URL.
#
# Safe by design: idempotent; signing stays OFF unless --enable; on ANY config
# error it aborts and prints how to revert. Kamailio signing is itself fail-open.

set -euo pipefail

# ---------------- config (override via environment) ----------------
REPO_DIR="${REPO_DIR:-/opt/revup}"
X5U_URL="${X5U_URL:-https://fs-cert.granitevoip.com/stir/8052-2026.pem}"
KEY_SRC="${KEY_SRC:-$REPO_DIR/secrets/stir-key.pem}"
KEY_CONTAINER_PATH="${KEY_CONTAINER_PATH:-/etc/kamailio/stir/stir-key.pem}"
OVERRIDE="${OVERRIDE:-$REPO_DIR/docker-compose.stir-key.yml}"
COMPOSE_SBC="$REPO_DIR/docker-compose.sbc.yml"
KAM="voip-kamailio"

ok(){   echo "  [OK]   $*"; }
info(){ echo "  [..]   $*"; }
die(){  echo "  [FAIL] $*" >&2; exit 1; }
trap 'echo "  [FAIL] aborted at line $LINENO — signing was NOT changed beyond any [OK] lines above." >&2' ERR

# ---------------- args ----------------
ACTION=setup
case "${1:-}" in
  ""|--setup) ACTION=setup ;;
  --enable)   ACTION=enable ;;
  --disable)  ACTION=disable ;;
  --status)   ACTION=status ;;
  -h|--help)
    cat <<'USAGE'
deploy-sbc-signing.sh — STIR/SHAKEN signing on one Kamailio SBC (run as root):
  sudo deploy-sbc-signing.sh            wire key + x5u, build, signing OFF (dark)
  sudo deploy-sbc-signing.sh --enable   turn signing ON (recreates kamailio)
  sudo deploy-sbc-signing.sh --disable  roll signing back OFF
  sudo deploy-sbc-signing.sh --status   show state + recent signing logs
Prerequisite: place the STI private key at /opt/revup/secrets/stir-key.pem first.
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
ok "on SBC $(hostname); $KAM present"

# Build the `-f` compose args as a proper array (override included only if it
# exists). Each token is its own element — never one "-f /path" string.
build_compose_args(){ CF=(-f "$COMPOSE_SBC"); [ -f "$OVERRIDE" ] && CF+=(-f "$OVERRIDE"); return 0; }

# ---------------- status ----------------
if [ "$ACTION" = status ]; then
  echo "STIR settings in .env:"; grep -E '^STIR_' .env 2>/dev/null | sed 's/^/    /' || info "none set"
  echo "kamailio:"; docker ps --filter "name=$KAM" --format '    {{.Names}}: {{.Status}}'
  echo "recent signing activity (last 15m):"
  docker logs --since 15m "$KAM" 2>&1 | grep -i 'STIR:' | tail -12 | sed 's/^/    /' || info "none"
  exit 0
fi

# ---------------- disable (fast rollback) ----------------
if [ "$ACTION" = disable ]; then
  sed -i '/^STIR_SHAKEN_SIGN=/d' .env; echo 'STIR_SHAKEN_SIGN=off' >> .env
  build_compose_args
  docker compose "${CF[@]}" up -d kamailio
  sleep 4
  docker exec "$KAM" kamailio -c -f /etc/kamailio/kamailio.cfg >/dev/null 2>&1 \
    || die "config-check failed after disable — inspect 'docker logs $KAM'"
  ok "signing DISABLED; kamailio recreated; config valid"
  exit 0
fi

# ================ setup / enable ================
echo "== STIR/SHAKEN $ACTION on $(hostname) =="

# 1) key present and looks like a private key
[ -f "$KEY_SRC" ] || die "signing key not found at $KEY_SRC — deliver it there first (SECRET, never git). See:  $0 --help"
grep -q 'PRIVATE KEY' "$KEY_SRC" || die "$KEY_SRC does not look like a PEM private key"

# 2) x5u is live AND this key matches the cert it serves (wrong key => abort)
info "verifying the key against the live x5u ($X5U_URL) ..."
LIVE_PUB="$(curl -fsS --max-time 15 "$X5U_URL" 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null | openssl sha256 2>/dev/null | awk '{print $NF}')"
[ -n "$LIVE_PUB" ] || die "could not fetch/parse the cert at the x5u ($X5U_URL) — is the endpoint live and reachable from here?"
KEY_PUB="$(openssl pkey -in "$KEY_SRC" -pubout 2>/dev/null | openssl sha256 2>/dev/null | awk '{print $NF}')"
[ -n "$KEY_PUB" ] || die "could not read the private key at $KEY_SRC"
[ "$KEY_PUB" = "$LIVE_PUB" ] || die "KEY DOES NOT MATCH the x5u cert — wrong key. Aborting (signatures would fail validation)."
ok "key pairs with the live x5u certificate"

# 3) perms — readable only by the in-container kamailio user
KUID="$(docker exec "$KAM" id -u kamailio 2>/dev/null)" || die "could not read the kamailio uid from $KAM"
chown "$KUID" "$KEY_SRC"; chmod 600 "$KEY_SRC"
ok "key perms locked (uid $KUID, mode 600)"

# 4) key-mount override (idempotent; docker-compose.sbc.yml is left untouched)
printf 'services:\n  kamailio:\n    volumes:\n      - %s:%s:ro\n' "$KEY_SRC" "$KEY_CONTAINER_PATH" > "$OVERRIDE"
ok "key-mount override written ($OVERRIDE)"

# 5) .env — point kamailio at the x5u + key
sed -i '/^STIR_CERT_URL=/d;/^STIR_KEY_PATH=/d' .env
{ echo "STIR_CERT_URL=$X5U_URL"; echo "STIR_KEY_PATH=$KEY_CONTAINER_PATH"; } >> .env
ok ".env -> x5u URL + key path"

# 6) sign toggle for this action
if [ "$ACTION" = enable ]; then SIGN=on; else SIGN=off; fi
sed -i '/^STIR_SHAKEN_SIGN=/d' .env; echo "STIR_SHAKEN_SIGN=$SIGN" >> .env

# 7) build (installs secsipid) + (re)create, then HARD-verify config + health
info "building + starting kamailio (signing=$SIGN) — brief restart; the NLB covers it ..."
build_compose_args
docker compose "${CF[@]}" up -d --build kamailio
sleep 5
if ! docker exec "$KAM" kamailio -c -f /etc/kamailio/kamailio.cfg >/tmp/_kamcheck.$$ 2>&1; then
  echo "  ---- kamailio -c output ----"; tail -20 /tmp/_kamcheck.$$ | sed 's/^/  /'; rm -f /tmp/_kamcheck.$$
  die "kamailio config-check FAILED (signing=$SIGN). Revert now:  sudo $0 --disable"
fi
rm -f /tmp/_kamcheck.$$
sleep 2
STAT="$(docker ps --filter "name=$KAM" --format '{{.Status}}')"
echo "$STAT" | grep -qi '^up' || die "kamailio is not up after the change: '$STAT'. Revert:  sudo $0 --disable"
ok "config valid + container up ($STAT)"

# 8) report
echo
if [ "$SIGN" = on ]; then
  ok "STIR/SHAKEN signing is ENABLED on $(hostname)."
  info "Place a test call to +16174544217, then:  sudo $0 --status"
  info "Look for a 'STIR: signed ...' line, then grab that call's outbound INVITE from Homer."
else
  ok "Dark deploy complete on $(hostname): key mounted, x5u wired, secsipid installed, signing OFF."
  info "Place a NORMAL call to confirm no regression, then enable:  sudo $0 --enable"
fi
