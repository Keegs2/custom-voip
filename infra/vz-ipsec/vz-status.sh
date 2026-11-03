#!/bin/bash
# vz-status.sh — one-screen status of this Verizon IPsec gateway. Installed to /usr/local/sbin/vz-status.sh. Read-only.
# Sections: identity, SAs, xfrm iface, routes, nft counters, xfrm_stat, health JSON, drain, invariants.
set -euo pipefail

ENV_FILE=${VZ_ENV_FILE:-/etc/vz-ipsec/vz-gateway.env}
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && . "$ENV_FILE"
PORT=${VZ_HEALTH_PORT:-8081}
DRAIN=${VZ_DRAIN_FILE:-/run/vz-drain}
IFACE=xfrm-vz

hr() { printf '\n== %s ==\n' "$1"; }

hr "gateway"
echo "host=$(hostname) zone=${VZ_ZONE:-?} gw=${VZ_GW:-?} nic=${VZ_NIC_IP:-?} ike=${VZ_IKE_IP:-?} ilb=${VZ_GW_ILB_IP:-?} tunnel_ready=${VZ_TUNNEL_READY:-?}"
echo "peer=${VZ_PEER_IP:-?} prefixes=${VZ_PREFIXES:-<none>} zone_sip=${VZ_ZONE_SIP:-?} sbc_vip=${VZ_SBC_VIP:-?}"

hr "IKE / CHILD SAs (swanctl --list-sas)"
if command -v swanctl >/dev/null 2>&1; then
    swanctl --list-sas 2>&1 | sed 's/^/  /' || true
    [ -z "$(swanctl --list-sas 2>/dev/null)" ] && echo "  (no SAs)"
    echo "  conns loaded: $(swanctl --list-conns 2>/dev/null | grep -c 'IKEv2' || true)"
else
    echo "  swanctl not installed"
fi

hr "xfrm interface ($IFACE)"
ip -d link show "$IFACE" 2>&1 | sed 's/^/  /' || true
echo "  rp_filter($IFACE)=$(sysctl -n net.ipv4.conf."$IFACE".rp_filter 2>/dev/null || echo n/a) ip_forward=$(sysctl -n net.ipv4.ip_forward)"

hr "routes"
echo "  main table (default / VPC / tunnel / blackhole):"
ip route show | grep -E '^default|^10\.0\.0\.0/8|^192\.168\.0\.0/16|xfrm-vz|blackhole' | sed 's/^/    /' || true
echo "  ens4 addresses:"; ip -o -4 addr show dev ens4 | awk '{print "    "$4}'
echo "  local ILB probe address on lo:"; ip route show table local | grep -F "${VZ_GW_ILB_IP:-__}" | sed 's/^/    /' || echo "    MISSING"

hr "nftables (table ip vz, counters)"
if nft list table ip vz >/dev/null 2>&1; then
    nft list table ip vz | grep -E 'chain|counter' | sed 's/^/  /'
else
    echo "  table ip vz NOT loaded"
fi

hr "xfrm_stat (non-zero only)"
awk '$2 != 0 {print "  "$1" "$2}' /proc/net/xfrm_stat 2>/dev/null || echo "  n/a"
echo "  (XfrmOutNoStates = black-holed outbound, XfrmInStateSeqError = replay drops)"

hr "health (GET :$PORT/healthz)"
code=$(curl -s -m 2 -o /tmp/vz-health.$$ -w '%{http_code}' "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || echo 000)
echo "  HTTP $code"
if [ -s /tmp/vz-health.$$ ]; then
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("  healthy:",d["healthy"]," failed:",d["failed"]); [print("   ",k,json.dumps(v)) for k,v in d["checks"].items()]' /tmp/vz-health.$$ 2>/dev/null || cat /tmp/vz-health.$$
fi
rm -f /tmp/vz-health.$$

hr "drain"
if [ -e "$DRAIN" ]; then echo "  ON ($DRAIN present) -> HC 503 on purpose"; else echo "  off"; fi

hr "invariants"
echo "  nf_conntrack loaded: $(lsmod | grep -c '^nf_conntrack' || true) (must be 0)"
echo "  docker present: $(command -v docker >/dev/null 2>&1 && echo YES-BAD || echo no)"
echo "  rfc4106 driver: $(grep -A3 '^name *: rfc4106' /proc/crypto 2>/dev/null | grep -m1 driver | awk '{print $3}' || echo none) (want rfc4106-gcm-aesni)"
echo "  units: $(for u in systemd-networkd vz-routes nftables strongswan vz-healthd prometheus-node-exporter chrony; do printf '%s=%s ' "$u" "$(systemctl is-active "$u" 2>/dev/null)"; done)"
