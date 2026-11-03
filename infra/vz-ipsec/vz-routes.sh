#!/bin/bash
# vz-routes.sh — gateway addressing + static routes. Installed to /usr/local/sbin/vz-routes.sh, run by vz-routes.service.
# Idempotent: every command is `replace`/`add-if-missing`; re-run any time with `systemctl restart vz-routes`.
# Reads /etc/vz-ipsec/vz-gateway.env (written by install.sh — validated, no secrets).
# Plan references: §3.1 (forwarded-IP sourcing), §3.2 (static routes, rp_filter), §3.5 (VIP-addressed probes).
set -euo pipefail

ENV_FILE=${VZ_ENV_FILE:-/etc/vz-ipsec/vz-gateway.env}
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${VZ_NIC_IP:?}" "${VZ_IKE_IP:?}" "${VZ_SUBNET_GW:?}" "${VZ_GW_ILB_IP:?}" "${VZ_IF_ID:=42}" "${VZ_TUNNEL_READY:=0}"
IFACE=xfrm-vz
NIC=ens4

log() { echo "vz-routes: $*"; }

# --- xfrm-vz: created by systemd-networkd from 10-xfrm-vz.netdev (§3.2 "IP unnumbered"). Wait briefly for it. ---
for _ in $(seq 1 20); do ip link show "$IFACE" >/dev/null 2>&1 && break; sleep 0.5; done
if ! ip link show "$IFACE" >/dev/null 2>&1; then
    log "WARN: $IFACE not created by systemd-networkd within 10 s — creating it directly (check: networkctl status $IFACE)"
    ip link add "$IFACE" type xfrm if_id "$VZ_IF_ID"
fi
ip link set "$IFACE" mtu 1400 up                       # MTU 1400 (§3.2, §3.4); no address ever (IP-unnumbered)
sysctl -q -w "net.ipv4.conf.$IFACE.rp_filter=2"        # loose RPF on the tunnel iface — needs the iface to exist, hence here not sysctl.d (§3.2)

# --- §3.1 (1): the forwarded IKE IP as a REAL address on ens4 (charon enumerates addresses, not the guest agent's local routes) ---
ip addr replace "$VZ_IKE_IP/32" dev "$NIC"

# --- §3.1 (3): internet via the IKE IP (the VM has no primary external IP); VPC traffic stays NIC-sourced ---
# `onlink` only relaxes the next-hop reachability check (GCE gateways are always on-link); the route itself is the plan's.
ip route replace default via "$VZ_SUBNET_GW" dev "$NIC" src "$VZ_IKE_IP" onlink
ip route replace 10.0.0.0/8     via "$VZ_SUBNET_GW" dev "$NIC" src "$VZ_NIC_IP" onlink
ip route replace 192.168.0.0/16 via "$VZ_SUBNET_GW" dev "$NIC" src "$VZ_NIC_IP" onlink

# --- §3.5: the next-hop ILB address must be LOCAL so VIP-addressed health probes terminate here instead of being forwarded back out ens4 ---
ip route replace local "$VZ_GW_ILB_IP/32" dev lo table local

# --- §3.2 "Static routes": only once Verizon's peer + prefixes are real (install.sh sets VZ_TUNNEL_READY=1) ---
# Every tunnel-related route is tagged `proto 42` so a later run can PRUNE what is no longer wanted (prefix list changed,
# lab teardown, peer changed) without touching the default/VPC routes above. Install first, prune second: no gap.
PROTO=42
wanted=" "
if [ "$VZ_TUNNEL_READY" = "1" ]; then
    : "${VZ_PEER_IP:?}" "${VZ_PREFIXES:?}"
    # /32 host route for Verizon's IKE peer via ens4 — in case it sits inside a declared prefix (which would otherwise route into the tunnel).
    ip route replace "$VZ_PEER_IP/32" via "$VZ_SUBNET_GW" dev "$NIC" src "$VZ_IKE_IP" onlink proto "$PROTO"
    wanted="$wanted$VZ_PEER_IP "
    IFS=',' read -r -a prefixes <<< "$VZ_PREFIXES"
    for p in "${prefixes[@]}"; do
        p=$(echo "$p" | tr -d '[:space:]'); [ -n "$p" ] || continue
        ip route replace "$p" dev "$IFACE" proto "$PROTO"                      # into the tunnel (charon install_routes=no, so this is the only route)
        ip route replace blackhole "$p" metric 200 proto "$PROTO"              # shadow: if xfrm-vz goes away, packets die HERE instead of looping default -> ILB -> this gateway
        wanted="$wanted$p "
    done
    log "tunnel routes installed for: $VZ_PREFIXES (peer $VZ_PEER_IP)"
else
    log "VZ_TUNNEL_READY=0 — peer/prefixes are placeholders; no tunnel routes installed (pre-Verizon bring-up)"
fi
# Prune stale proto-42 routes (dst = first word, or the word after "blackhole"). The line is fed back verbatim to `ip route del`.
ip -o route show proto "$PROTO" 2>/dev/null | while IFS= read -r line; do
    set -- $line; dst=$1; [ "$dst" = blackhole ] && dst=$2
    case "$wanted" in *" ${dst%/32} "*|*" $dst "*) continue ;; esac
    log "pruning stale route: $line"
    # shellcheck disable=SC2086
    ip route del $line || true
done

log "done: $IFACE up mtu 1400; $VZ_IKE_IP/32 on $NIC; default src $VZ_IKE_IP; local $VZ_GW_ILB_IP on lo"
