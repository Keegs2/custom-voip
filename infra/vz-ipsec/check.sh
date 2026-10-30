#!/bin/bash
# check.sh — `make check` for the gateway stack.
#
#   On a gateway (after install.sh):      sudo /opt/revup/infra/vz-ipsec/check.sh
#   Anywhere (repo-only static checks):   infra/vz-ipsec/check.sh --local [env-file]
#
# --local: bash -n every script, py_compile the health daemon, render every template through install.sh --render-only
#          with a sample env (default examples/central-vz-gw-a.env = real as-built values, placeholder peer/prefixes, AND a
#          second pass with fake peer/prefixes so the tunnel-mode render is exercised), refuse unresolved `${...}`, refuse any
#          `ct`/`nat`/`masquerade`/`redirect` token in the rendered nftables.conf, and run `nft -c -f` if nft exists.
# gateway: all of the above against the INSTALLED files, plus `nft -c -f /etc/nftables.conf`, `swanctl --list-conns` shows
#          `vz` when tunnel-ready, `systemd-analyze verify` on the units, nf_conntrack not loaded, no Docker, ip_forward=1,
#          xfrm-vz at MTU 1400, /healthz answering, textfile metrics fresh.
set -euo pipefail

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
MODE=gateway
[ "${1:-}" = "--local" ] && { MODE=local; shift; }
SAMPLE_ENV=${1:-$SELF_DIR/examples/central-vz-gw-a.env}

PASS=0; FAIL=0
ok()   { echo "  ok    $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $*"; FAIL=$((FAIL + 1)); }
check() { local desc=$1; shift; if "$@" >/dev/null 2>&1; then ok "$desc"; else fail "$desc"; fi; }

echo "== static: scripts =="
for f in "$SELF_DIR"/install.sh "$SELF_DIR"/check.sh "$SELF_DIR"/vz-routes.sh "$SELF_DIR"/vz-status.sh "$SELF_DIR"/vz-drain.sh; do
    check "bash -n $(basename "$f")" bash -n "$f"
done
check "py_compile vz-healthd.py" python3 -m py_compile "$SELF_DIR/vz-healthd.py"
rm -rf "$SELF_DIR/__pycache__"

# Forbidden-token scan on a rendered nftables.conf (plan §3.3: conntrack must never load => no ct/nat statements).
nft_forbidden() {   # file
    ! grep -vE '^\s*#' "$1" | sed 's/#.*$//' | grep -qwE 'ct|nat|snat|dnat|masquerade|redirect|notrack'
}
render_checks() {   # envfile outdir label
    local env=$1 out=$2 label=$3
    rm -rf "$out"; mkdir -p "$out"
    if bash "$SELF_DIR/install.sh" --render-only "$env" "$out" >"$out/render.log" 2>&1; then ok "render ($label)"; else fail "render ($label): $(tail -3 "$out/render.log" | tr '\n' ' ')"; return; fi
    check "no unresolved \${...} under /etc ($label)" bash -c "! grep -rl '\\\${' '$out/etc' 2>/dev/null | grep -q ."
    check "nftables.conf has no ct/nat tokens ($label)" nft_forbidden "$out/etc/nftables.conf"
    check "nftables.conf has the three chains ($label)" bash -c "grep -q 'chain vz_pre' '$out/etc/nftables.conf' && grep -q 'chain vz_fwd' '$out/etc/nftables.conf' && grep -q 'chain vz_post' '$out/etc/nftables.conf'"
    check "vz-gateway.env rendered ($label)" test -s "$out/etc/vz-ipsec/vz-gateway.env"
    if grep -q '^VZ_TUNNEL_READY=1' "$out/etc/vz-ipsec/vz-gateway.env"; then
        check "swanctl vz.conf rendered ($label)" test -s "$out/etc/swanctl/conf.d/vz.conf"
        check "vz.conf has the §3.2 proposals ($label)" bash -c "grep -q 'proposals = aes256-sha384-ecp256' '$out/etc/swanctl/conf.d/vz.conf' && grep -q 'esp_proposals = aes256gcm16-ecp256' '$out/etc/swanctl/conf.d/vz.conf'"
        check "nftables.conf has both forward accepts ($label)" bash -c "[ \$(grep -c ' accept\$' '$out/etc/nftables.conf') -eq 2 ]"
    else
        check "swanctl vz.conf ABSENT in placeholder mode ($label)" test ! -e "$out/etc/swanctl/conf.d/vz.conf"
        check "nftables.conf has NO forward accepts in placeholder mode ($label)" bash -c "[ \$(grep -c ' accept\$' '$out/etc/nftables.conf') -eq 0 ]"
    fi
    if command -v nft >/dev/null 2>&1; then check "nft -c -f ($label)" nft -c -f "$out/etc/nftables.conf"; else echo "  skip  nft -c -f ($label): nft not installed here"; fi
}

echo "== static: render (sample env: $SAMPLE_ENV) =="
[ -r "$SAMPLE_ENV" ] || { fail "sample env $SAMPLE_ENV not readable"; echo "FAIL=$FAIL"; exit 1; }
TMP=$(mktemp -d)
render_checks "$SAMPLE_ENV" "$TMP/placeholder" "placeholder peer/prefixes"
# Tunnel-mode pass: same env with a fake peer + two fake prefixes (RFC 2544 benchmark space, never routed).
sed -e 's|^VZ_PEER_IP=.*|VZ_PEER_IP=198.18.255.1|' -e 's|^VZ_PREFIXES=.*|VZ_PREFIXES=198.18.0.0/24, 198.18.1.0/24|' "$SAMPLE_ENV" > "$TMP/tunnel.env"
grep -q '^VZ_PEER_IP=' "$TMP/tunnel.env" || echo "VZ_PEER_IP=198.18.255.1" >> "$TMP/tunnel.env"
grep -q '^VZ_PREFIXES=' "$TMP/tunnel.env" || echo "VZ_PREFIXES=198.18.0.0/24, 198.18.1.0/24" >> "$TMP/tunnel.env"
render_checks "$TMP/tunnel.env" "$TMP/tunnel" "fake peer/prefixes"
[ "${KEEP_RENDER:-}" = 1 ] && echo "  (renders kept under $TMP)" || rm -rf "$TMP"

if [ "$MODE" = gateway ]; then
    echo "== gateway: installed files =="
    for f in /etc/vz-ipsec/vz-gateway.env /etc/nftables.conf /etc/strongswan.d/zz-vz.conf /etc/systemd/network/10-xfrm-vz.netdev /etc/systemd/network/10-xfrm-vz.network /etc/sysctl.d/99-vz.conf /etc/modprobe.d/vz-no-conntrack.conf /usr/local/sbin/vz-routes.sh /usr/local/sbin/vz-healthd.py /etc/systemd/system/vz-routes.service /etc/systemd/system/vz-healthd.service; do
        check "present $f" test -s "$f"
    done
    check "no unresolved \${...} in /etc/nftables.conf, vz.conf" bash -c "! grep -l '\\\${' /etc/nftables.conf /etc/swanctl/conf.d/vz.conf 2>/dev/null | grep -q ."
    check "/etc/nftables.conf has no ct/nat tokens" nft_forbidden /etc/nftables.conf
    check "nft -c -f /etc/nftables.conf" nft -c -f /etc/nftables.conf
    check "nft table ip vz is loaded" nft list table ip vz
    check "systemd-analyze verify units" systemd-analyze verify /etc/systemd/system/vz-routes.service /etc/systemd/system/vz-healthd.service
    check "strongswan.service drop-in present" test -s /etc/systemd/system/strongswan.service.d/vz.conf
    check "node_exporter drop-in present" test -s /etc/systemd/system/prometheus-node-exporter.service.d/vz.conf
    # shellcheck disable=SC1091
    . /etc/vz-ipsec/vz-gateway.env
    if [ "${VZ_TUNNEL_READY:-0}" = 1 ]; then
        check "swanctl --list-conns shows vz" bash -c "swanctl --list-conns | grep -q '^vz:'"
        check "secrets.conf present, mode 600" bash -c "[ -f /etc/swanctl/conf.d/secrets.conf ] && [ \$(stat -c %a /etc/swanctl/conf.d/secrets.conf) = 600 ]"
        check "CHILD_SA vz INSTALLED" bash -c "swanctl --list-sas | grep -q 'vz: .*INSTALLED'"
        check "SA algorithms exactly §11 Phase 2" bash -c "swanctl --list-sas | grep -q 'AES_CBC-256/HMAC_SHA2_384_192/PRF_HMAC_SHA2_384/ECP_256' && swanctl --list-sas | grep -q 'AES_GCM_16-256'"
        check "no NAT-T ([4500]/nat-local absent)" bash -c "! swanctl --list-sas | grep -qE '\[4500\]|nat-local|nat-remote'"
        check "ESP outer src = IKE IP" bash -c "ip -s xfrm state | grep -q 'src $VZ_IKE_IP '"
    else
        echo "  skip  tunnel checks: VZ_TUNNEL_READY=0 (pre-Verizon)"
        check "swanctl vz.conf absent in placeholder mode" test ! -e /etc/swanctl/conf.d/vz.conf
    fi
    echo "== gateway: kernel / invariants =="
    check "nf_conntrack NOT loaded (lsmod)" bash -c "[ \$(lsmod | grep -c '^nf_conntrack') -eq 0 ]"
    check "docker absent" bash -c "! command -v docker"
    check "net.ipv4.ip_forward = 1" bash -c "[ \$(sysctl -n net.ipv4.ip_forward) = 1 ]"
    check "xfrm-vz UP mtu 1400" bash -c "ip -o link show xfrm-vz | grep -q 'mtu 1400' && ip -o link show xfrm-vz | grep -q '<[^>]*UP'"
    check "rp_filter(xfrm-vz) = 2" bash -c "[ \$(sysctl -n net.ipv4.conf.xfrm-vz.rp_filter) = 2 ]"
    check "IKE IP on ens4" bash -c "ip -o -4 addr show dev ens4 | grep -q 'inet $VZ_IKE_IP/32'"
    check "default route src = IKE IP" bash -c "ip route show default | grep -q 'src $VZ_IKE_IP'"
    check "ILB address local on lo" bash -c "ip route show table local | grep -q 'local $VZ_GW_ILB_IP dev lo'"
    check "charon install_routes=no honoured (no table 220)" bash -c "[ -z \"\$(ip route show table 220 2>/dev/null)\" ]"
    check "rfc4106-gcm-aesni driver" bash -c "grep -A3 '^name *: rfc4106(gcm(aes))' /proc/crypto | grep -q 'driver *: rfc4106-gcm-aesni'"
    echo "== gateway: health =="
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${VZ_HEALTH_PORT:-8081}/healthz" || echo 000)
    if [ "$code" = 200 ]; then ok "/healthz 200"; elif [ "$code" = 503 ]; then fail "/healthz 503: $(curl -s -m 2 "http://127.0.0.1:${VZ_HEALTH_PORT:-8081}/healthz" | python3 -c 'import json,sys; print(json.load(sys.stdin)["failed"])' 2>/dev/null)"; else fail "/healthz unreachable ($code) — vz-healthd running?"; fi
    check "textfile metrics fresh (<30 s)" bash -c "[ \$(( \$(date +%s) - \$(stat -c %Y /var/lib/node_exporter/textfile_collector/vz_ipsec.prom) )) -lt 30 ]"
    check "node_exporter on ${VZ_NIC_IP}:9100 serves vz_ipsec_healthy" bash -c "curl -s -m 2 http://${VZ_NIC_IP}:9100/metrics | grep -q '^vz_ipsec_healthy'"
    check "node_exporter xfrm collector on" bash -c "curl -s -m 2 http://${VZ_NIC_IP}:9100/metrics | grep -q '^node_xfrm_'"
fi

echo
echo "check.sh: pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
