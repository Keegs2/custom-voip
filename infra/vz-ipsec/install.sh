#!/bin/bash
# install.sh — configure a Verizon IPsec gateway VM from the repo (plan docs/VERIZON_IPSEC_TRUNKS_PLAN.md §3, §11).
#
#   On the gateway, as root, after `cd /opt/revup && sudo git pull`:
#       sudo /opt/revup/infra/vz-ipsec/install.sh
#   Render only (no root, no apt, no systemd — used by check.sh and for local review):
#       infra/vz-ipsec/install.sh --render-only <env-file> <out-dir>
#
# Idempotent: safe to re-run for upgrades. Reads /opt/revup/.env (same path convention as every other VM in the fleet),
# validates every variable of the env contract (README), refuses placeholders EXCEPT VZ_PEER_IP / VZ_PREFIXES — those may
# still be placeholders during pre-Verizon bring-up, in which case everything is installed but the swanctl connection file
# is left out ("tunnel config skipped").
#
# Never writes a secret. The PSK is /etc/swanctl/conf.d/secrets.conf, created by the operator (README "Where the PSK lives").
set -euo pipefail

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=/opt/revup/.env
RENDER_ONLY=0
OUT=""                       # render root ("" = the real filesystem)

if [ "${1:-}" = "--render-only" ]; then
    RENDER_ONLY=1; ENV_FILE=${2:?env file}; OUT=${3:?out dir}; mkdir -p "$OUT"
fi

# ----------------------------------------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------------------------------------
die()  { echo "install.sh: ERROR: $*" >&2; exit 1; }
warn() { echo "install.sh: WARN: $*" >&2; WARNINGS=$((WARNINGS + 1)); }
info() { echo "install.sh: $*"; }
WARNINGS=0
REBOOT_NEEDED=0

is_placeholder() {   # value looks unset / unfilled
    local v=${1:-}
    [ -z "$v" ] && return 0
    printf '%s' "$v" | grep -qiE 'placeholder|changeme|replace|todo|tbd|<|>|x\.x|example' && return 0
    return 1
}
is_ipv4() { printf '%s' "${1:-}" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1; local o; IFS=. read -r -a o <<< "$1"; for n in "${o[@]}"; do [ "$n" -le 255 ] || return 1; done; }
is_cidr() { local ip=${1%%/*} len=${1#*/}; [ "$1" = "$ip" ] && len=32; is_ipv4 "$ip" && [ "$len" -ge 0 ] 2>/dev/null && [ "$len" -le 32 ]; }

# Parse KEY=VALUE lines (only VZ_*), strip optional surrounding quotes, ignore comments. No `source` — nothing executes.
load_env() {
    [ -r "$ENV_FILE" ] || die "$ENV_FILE not found/readable (copy env.example there and fill the row for this gateway)"
    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue ;; esac
        line=${line#export }
        key=${line%%=*}; val=${line#*=}
        printf '%s' "$key" | grep -qE '^VZ_[A-Z0-9_]+$' || continue
        val=${val%%[[:space:]]#*}                         # trailing " # comment"
        val=$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
        printf -v "$key" '%s' "$val"
    done < "$ENV_FILE"
}

# ----------------------------------------------------------------------------------------------------------------------
# 1. env contract (README) — validate everything
# ----------------------------------------------------------------------------------------------------------------------
load_env
: "${VZ_IF_ID:=42}" "${VZ_DRAIN_FILE:=/run/vz-drain}"
VZ_ZONE=${VZ_ZONE:-}; VZ_GW=${VZ_GW:-}
VZ_PEER_IP=${VZ_PEER_IP:-}; VZ_PREFIXES=${VZ_PREFIXES:-}; VZ_PEER_ID=${VZ_PEER_ID:-}; VZ_LOCAL_ID=${VZ_LOCAL_ID:-}

REQUIRED_IPS="VZ_NIC_IP VZ_IKE_IP VZ_SUBNET_GW VZ_GW_ILB_IP VZ_ZONE_SIP VZ_SBC_VIP VZ_SBC1_IP VZ_SBC2_IP VZ_FS1_NIC VZ_FS1_PUB VZ_FS2_NIC VZ_FS2_PUB"
for v in $REQUIRED_IPS; do
    is_placeholder "${!v:-}" && die "$v is unset or a placeholder in $ENV_FILE (only VZ_PEER_IP / VZ_PREFIXES may be placeholders)"
    is_ipv4 "${!v}" || die "$v='${!v}' is not an IPv4 address"
done
case "$VZ_ZONE" in east|west|central) ;; *) die "VZ_ZONE='$VZ_ZONE' must be east|west|central" ;; esac
case "$VZ_GW"   in a|b) ;; *) die "VZ_GW='$VZ_GW' must be a|b" ;; esac
printf '%s' "$VZ_IF_ID" | grep -qE '^[0-9]+$' || die "VZ_IF_ID='$VZ_IF_ID' must be an integer"
[ "$VZ_IF_ID" -gt 0 ] || die "VZ_IF_ID must be > 0 (0 means 'any interface' to xfrm)"
case "$VZ_DRAIN_FILE" in /run/*) ;; *) warn "VZ_DRAIN_FILE='$VZ_DRAIN_FILE' is not under /run — a reboot will NOT clear the drain" ;; esac
[ "$VZ_NIC_IP" != "$VZ_IKE_IP" ] || die "VZ_NIC_IP and VZ_IKE_IP must differ (§3.1: the IKE IP is the forwarded public address)"
[ "$VZ_ZONE_SIP" != "$VZ_IKE_IP" ] || die "VZ_ZONE_SIP must differ from VZ_IKE_IP (§1.2: SIP source != IKE peer)"
for v in VZ_SBC_VIP VZ_SBC1_IP VZ_SBC2_IP; do case "${!v}" in 10.*) ;; *) warn "$v='${!v}' is not a 10.x address — expected the zone's VPC addressing" ;; esac; done
for v in VZ_NIC_IP VZ_GW_ILB_IP VZ_SUBNET_GW VZ_FS1_NIC VZ_FS2_NIC; do case "${!v}" in 192.168.*) ;; *) warn "$v='${!v}' is not a 192.168.x address — expected a media/gateway subnet address" ;; esac; done

# Tunnel inputs: placeholders allowed (pre-Verizon); real values must be well-formed.
TUNNEL_READY=1
PREFIX_LIST=""
if is_placeholder "$VZ_PEER_IP"; then
    TUNNEL_READY=0
else
    is_ipv4 "$VZ_PEER_IP" || die "VZ_PEER_IP='$VZ_PEER_IP' is not an IPv4 address"
    [ "$VZ_PEER_IP" != "$VZ_IKE_IP" ] || die "VZ_PEER_IP equals VZ_IKE_IP"
fi
if is_placeholder "$VZ_PREFIXES"; then
    TUNNEL_READY=0
else
    # Normalise the prefix list ("a/24, b/28" -> "a/24,b/28") and validate each entry.
    IFS=',' read -r -a _p <<< "$VZ_PREFIXES"
    for p in "${_p[@]}"; do
        p=$(printf '%s' "$p" | tr -d '[:space:]'); [ -n "$p" ] || continue
        is_cidr "$p" || die "VZ_PREFIXES entry '$p' is not an IPv4 prefix (a.b.c.d/nn)"
        PREFIX_LIST="${PREFIX_LIST:+$PREFIX_LIST,}$p"
    done
    [ -n "$PREFIX_LIST" ] || die "VZ_PREFIXES is empty"
fi
: "${VZ_PEER_ID:=$VZ_PEER_IP}" "${VZ_LOCAL_ID:=$VZ_IKE_IP}"
if [ "$TUNNEL_READY" = 1 ]; then
    is_placeholder "$VZ_PEER_ID" && die "VZ_PEER_ID is a placeholder"
    is_placeholder "$VZ_LOCAL_ID" && die "VZ_LOCAL_ID is a placeholder"
fi
# nft anonymous-set literal for the forward rules: `{ a/24, b/28 }`
VZ_PREFIX_SET="{ $(printf '%s' "$PREFIX_LIST" | sed 's/,/, /g') }"
VZ_NE_XFRM_FLAG=""   # set after apt install (feature-detected); rendered into the node_exporter drop-in
for v in VZ_ZONE VZ_GW VZ_NIC_IP VZ_IKE_IP VZ_SUBNET_GW VZ_GW_ILB_IP VZ_ZONE_SIP VZ_SBC_VIP VZ_SBC1_IP VZ_SBC2_IP VZ_FS1_NIC VZ_FS1_PUB VZ_FS2_NIC VZ_FS2_PUB VZ_PEER_IP VZ_PEER_ID VZ_LOCAL_ID VZ_IF_ID VZ_DRAIN_FILE VZ_PREFIX_SET PREFIX_LIST VZ_NE_XFRM_FLAG; do
    case "${!v}" in *'|'*|*'&'*|*'\'*) die "$v contains a character the renderer cannot escape (| & \\)" ;; esac
done

info "zone=$VZ_ZONE gw=$VZ_GW nic=$VZ_NIC_IP ike=$VZ_IKE_IP ilb=$VZ_GW_ILB_IP tunnel_ready=$TUNNEL_READY"

# ----------------------------------------------------------------------------------------------------------------------
# 2. renderer — `${VZ_X}` substitution with sed; refuses any unresolved `${...}` in the output
# ----------------------------------------------------------------------------------------------------------------------
RENDER_VARS="VZ_ZONE VZ_GW VZ_NIC_IP VZ_IKE_IP VZ_SUBNET_GW VZ_GW_ILB_IP VZ_ZONE_SIP VZ_SBC_VIP VZ_SBC1_IP VZ_SBC2_IP VZ_FS1_NIC VZ_FS1_PUB VZ_FS2_NIC VZ_FS2_PUB VZ_PEER_IP VZ_PEER_ID VZ_LOCAL_ID VZ_IF_ID VZ_DRAIN_FILE VZ_PREFIX_SET VZ_NE_XFRM_FLAG"
render() {   # render SRC DST [MODE]  — DST is an absolute system path; honoured under $OUT in --render-only
    local src=$1 dst="$OUT$2" mode=${3:-0644} tmp args=()
    for v in $RENDER_VARS; do args+=(-e "s|\${$v}|${!v}|g"); done
    tmp=$(mktemp)
    sed "${args[@]}" "$src" > "$tmp"
    if grep -q '\${' "$tmp"; then
        die "unresolved placeholders in $dst: $(grep -o '\${[A-Za-z0-9_]*}' "$tmp" | sort -u | tr '\n' ' ')"
    fi
    mkdir -p "$(dirname "$dst")"
    install -m "$mode" "$tmp" "$dst"; rm -f "$tmp"
}
put() {      # put SRC DST [MODE] — verbatim copy
    local dst="$OUT$2"; mkdir -p "$(dirname "$dst")"; install -m "${3:-0644}" "$1" "$dst"
}
file_hash() { [ -r "$1" ] && sha256sum "$1" | cut -c1-16 || echo none; }

# ----------------------------------------------------------------------------------------------------------------------
# 3. pre-flight (real install only)
# ----------------------------------------------------------------------------------------------------------------------
if [ "$RENDER_ONLY" = 0 ]; then
    [ "$(id -u)" = 0 ] || die "run as root (sudo)"
    # shellcheck disable=SC1091
    . /etc/os-release 2>/dev/null || true
    [ "${ID:-}" = debian ] && [ "${VERSION_ID:-}" = 12 ] || warn "not Debian 12 (${PRETTY_NAME:-unknown}) — this stack is validated on Debian 12 only (strongSwan 5.9.8, nft 1.0.6, kernel 6.1)"
    # §3.3: Docker loads conntrack + iptables NAT and would break the stateless NAT. Hard stop.
    if command -v docker >/dev/null 2>&1 || dpkg -s docker.io >/dev/null 2>&1 || dpkg -s docker-ce >/dev/null 2>&1 || dpkg -s containerd.io >/dev/null 2>&1; then
        die "Docker/containerd is installed on this gateway — forbidden (plan §3.3). Remove it (apt-get purge docker.io docker-ce containerd.io) and reboot before installing."
    fi
    ip link show ens4 >/dev/null 2>&1 || die "no ens4 interface — the templates (charon interfaces_use, routes, sysctl) assume the GCE primary NIC is ens4"
    ip -o -4 addr show dev ens4 | grep -q "inet $VZ_NIC_IP/" || warn "ens4 does not carry VZ_NIC_IP=$VZ_NIC_IP — wrong .env row for this VM?"
    [ "$VZ_ZONE-vz-gw-$VZ_GW" = "$(hostname)" ] || warn "hostname '$(hostname)' != '$VZ_ZONE-vz-gw-$VZ_GW' — wrong .env row for this VM? (continuing)"
fi

# ----------------------------------------------------------------------------------------------------------------------
# 4. packages
# ----------------------------------------------------------------------------------------------------------------------
if [ "$RENDER_ONLY" = 0 ]; then
    export DEBIAN_FRONTEND=noninteractive
    info "apt: installing strongswan-swanctl charon-systemd nftables chrony prometheus-node-exporter (+ tcpdump curl for the runbook)"
    apt-get update -q
    apt-get install -y -q strongswan-swanctl charon-systemd nftables chrony prometheus-node-exporter tcpdump curl
    # The legacy ipsec.conf starter would run a SECOND charon — this stack is swanctl/charon-systemd only.
    if dpkg -s strongswan-starter >/dev/null 2>&1; then
        warn "strongswan-starter (legacy ipsec.conf daemon) is installed — purging it; only charon-systemd may run charon"
        systemctl disable --now strongswan-starter.service 2>/dev/null || true
        apt-get purge -y -q strongswan-starter
    fi
    # §3.2: AES-GCM must be the AES-NI driver, not generic software GCM (~10x slower).
    n=$(grep -c rfc4106 /proc/crypto || true)
    drv=$(grep -A3 '^name *: rfc4106(gcm(aes))' /proc/crypto | grep -m1 'driver' | awk '{print $3}' || true)
    if [ "$n" = 0 ]; then
        warn "no rfc4106 entry in /proc/crypto yet — AES-NI driver not registered (try: modprobe aesni_intel; re-check after the first SA)"
    elif [ "$drv" != "rfc4106-gcm-aesni" ]; then
        warn "rfc4106(gcm(aes)) driver is '${drv:-?}' not 'rfc4106-gcm-aesni' — software GCM, expect ~10x lower throughput (§3.2)"
    else
        info "crypto: rfc4106-gcm-aesni present"
    fi
fi

# ----------------------------------------------------------------------------------------------------------------------
# 5. render + install files
# ----------------------------------------------------------------------------------------------------------------------
T=$SELF_DIR/templates
CHARON_BEFORE=$(file_hash "$OUT/etc/strongswan.d/zz-vz.conf")

# Validated, normalised, secret-free env for the units (vz-routes.sh, vz-healthd, node_exporter).
mkdir -p "$OUT/etc/vz-ipsec"
{
    echo "# generated by infra/vz-ipsec/install.sh from $ENV_FILE on $(date -u +%FT%TZ) — do not edit, re-run install.sh"
    for v in VZ_ZONE VZ_GW VZ_NIC_IP VZ_IKE_IP VZ_SUBNET_GW VZ_GW_ILB_IP VZ_ZONE_SIP VZ_SBC_VIP VZ_SBC1_IP VZ_SBC2_IP VZ_FS1_NIC VZ_FS1_PUB VZ_FS2_NIC VZ_FS2_PUB VZ_IF_ID VZ_DRAIN_FILE; do echo "$v=${!v}"; done
    echo "VZ_TUNNEL_READY=$TUNNEL_READY"
    if [ "$TUNNEL_READY" = 1 ]; then echo "VZ_PEER_IP=$VZ_PEER_IP"; echo "VZ_PEER_ID=$VZ_PEER_ID"; echo "VZ_LOCAL_ID=$VZ_LOCAL_ID"; echo "VZ_PREFIXES=$PREFIX_LIST"; else echo "VZ_PEER_IP="; echo "VZ_PREFIXES="; fi
    echo "VZ_HEALTH_PORT=8081"
    echo "VZ_TEXTFILE=/var/lib/node_exporter/textfile_collector/vz_ipsec.prom"
} > "$OUT/etc/vz-ipsec/vz-gateway.env.tmp"
install -m 0640 "$OUT/etc/vz-ipsec/vz-gateway.env.tmp" "$OUT/etc/vz-ipsec/vz-gateway.env"; rm -f "$OUT/etc/vz-ipsec/vz-gateway.env.tmp"

render "$T/10-xfrm-vz.netdev.tmpl"      /etc/systemd/network/10-xfrm-vz.netdev
put    "$T/10-xfrm-vz.network"          /etc/systemd/network/10-xfrm-vz.network
put    "$SELF_DIR/sysctl.d/99-vz.conf"  /etc/sysctl.d/99-vz.conf
put    "$SELF_DIR/modprobe.d/vz-no-conntrack.conf" /etc/modprobe.d/vz-no-conntrack.conf
put    "$T/charon.conf"                 /etc/strongswan.d/zz-vz.conf
put    "$T/chrony-google.sources"       /etc/chrony/sources.d/vz-google.sources

if [ "$TUNNEL_READY" = 1 ]; then
    render "$T/swanctl.conf.tmpl" /etc/swanctl/conf.d/vz.conf 0600
    render "$T/nftables.conf.tmpl" /etc/nftables.conf 0644
else
    # Pre-Verizon: no connection (nothing to peer with) and a forward chain with NO accept rules (policy drop stands).
    rm -f "$OUT/etc/swanctl/conf.d/vz.conf"
    tmpl=$(mktemp)
    awk 'NR==1 {print; print "# PRE-VERIZON RENDER (install.sh): VZ_PREFIXES is a placeholder -> both forward accept rules omitted; forward policy drop stands."; next} /\$\{VZ_PREFIX_SET\}/ {next} {print}' "$T/nftables.conf.tmpl" > "$tmpl"
    render "$tmpl" /etc/nftables.conf 0644
    rm -f "$tmpl"
    info "tunnel config skipped: peer/prefixes are placeholders"
fi

put "$SELF_DIR/vz-routes.sh"   /usr/local/sbin/vz-routes.sh  0755
put "$SELF_DIR/vz-status.sh"   /usr/local/sbin/vz-status.sh  0755
put "$SELF_DIR/vz-drain.sh"    /usr/local/sbin/vz-drain.sh   0755
put "$SELF_DIR/vz-healthd.py"  /usr/local/sbin/vz-healthd.py 0755
put "$SELF_DIR/systemd/vz-routes.service"  /etc/systemd/system/vz-routes.service
put "$SELF_DIR/systemd/vz-healthd.service" /etc/systemd/system/vz-healthd.service
put "$SELF_DIR/systemd/strongswan.service.d/vz.conf" /etc/systemd/system/strongswan.service.d/vz.conf
# node_exporter xfrm collector: Debian 12 ships node_exporter 1.5.0, which has NO --collector.xfrm (added in 1.6;
# bookworm-backports carries nothing newer — checked 2026-10-30) and exits on the unknown flag. Feature-detect it so
# node_exporter always starts; vz-healthd exports the two xfrm_stat counters that matter (XfrmOutNoStates,
# XfrmInStateSeqError) itself, so the alert rules keep a source either way.
VZ_NE_XFRM_FLAG=""
if [ "$RENDER_ONLY" = 0 ] && /usr/bin/prometheus-node-exporter --help 2>&1 | grep -q -- '--collector.xfrm'; then
    VZ_NE_XFRM_FLAG="--collector.xfrm"
elif [ "$RENDER_ONLY" = 0 ]; then
    warn "node_exporter $(/usr/bin/prometheus-node-exporter --version 2>&1 | head -1 | awk '{print $3}') has no --collector.xfrm (needs >= 1.6) — kernel node_xfrm_* metrics unavailable; vz-healthd's vz_ipsec_xfrm_*_total counters cover the alerts"
fi
render "$SELF_DIR/systemd/prometheus-node-exporter.service.d/vz.conf.tmpl" /etc/systemd/system/prometheus-node-exporter.service.d/vz.conf
mkdir -p "$OUT/var/lib/node_exporter/textfile_collector"

if [ "$RENDER_ONLY" = 1 ]; then
    info "render-only: files written under $OUT (tunnel_ready=$TUNNEL_READY)"
    exit 0
fi

# ----------------------------------------------------------------------------------------------------------------------
# 6. activate — networkd netdev -> vz-routes -> nftables -> strongswan -> vz-healthd (then node_exporter, chrony)
# ----------------------------------------------------------------------------------------------------------------------
sysctl --system >/dev/null
if lsmod | grep -q '^nf_conntrack'; then
    warn "nf_conntrack is LOADED (something loaded it before the blacklist) — trying to unload"
    for m in nft_ct nft_nat nft_chain_nat nf_nat nf_conntrack_netlink nf_conntrack; do modprobe -r "$m" 2>/dev/null || true; done
    if lsmod | grep -q '^nf_conntrack'; then warn "nf_conntrack still loaded — REBOOT REQUIRED before this gateway is valid (§3.3)"; REBOOT_NEEDED=1; fi
fi
systemctl daemon-reload

# networkd owns ONLY xfrm-vz (10-xfrm-vz.* match that name alone); ens4 keeps the GCE guest-agent/DHCP path.
if ls /etc/systemd/network/*.network 2>/dev/null | grep -v 10-xfrm-vz >/dev/null; then
    info "note: other networkd .network files exist: $(ls /etc/systemd/network/*.network | grep -v 10-xfrm-vz | tr '\n' ' ')"
fi
systemctl enable --now systemd-networkd.service >/dev/null
# wait-online would block network-online.target for up to 120 s waiting for interfaces networkd does not manage.
if systemctl is-enabled systemd-networkd-wait-online.service >/dev/null 2>&1; then systemctl disable systemd-networkd-wait-online.service >/dev/null 2>&1 || true; fi
networkctl reload
systemctl enable vz-routes.service >/dev/null
systemctl restart vz-routes.service

nft -c -f /etc/nftables.conf || die '/etc/nftables.conf failed nft -c — not loading it'
systemctl enable nftables.service >/dev/null
systemctl restart nftables.service

systemctl enable strongswan.service >/dev/null
if [ "$(file_hash /etc/strongswan.d/zz-vz.conf)" != "$CHARON_BEFORE" ] || ! systemctl is-active --quiet strongswan.service; then
    info "charon: (re)starting (charon.conf changed or daemon not running) — existing SAs on this gateway are torn down"
    systemctl restart strongswan.service
else
    swanctl --load-all --noprompt || warn "swanctl --load-all reported a problem (see above)"
fi
if [ "$TUNNEL_READY" = 1 ]; then
    if [ ! -f /etc/swanctl/conf.d/secrets.conf ]; then
        warn "NO PSK: /etc/swanctl/conf.d/secrets.conf is missing — the SA cannot come up. Create it (README 'Where the PSK lives') then: swanctl --load-creds; swanctl --initiate --child vz"
    else
        m=$(stat -c %a /etc/swanctl/conf.d/secrets.conf); [ "$m" = 600 ] || { warn "secrets.conf mode is $m — fixing to 600"; chmod 600 /etc/swanctl/conf.d/secrets.conf; }
    fi
fi

systemctl enable vz-healthd.service >/dev/null
systemctl restart vz-healthd.service
systemctl enable prometheus-node-exporter.service >/dev/null
systemctl restart prometheus-node-exporter.service
systemctl enable chrony.service >/dev/null 2>&1 || true
chronyc reload sources >/dev/null 2>&1 || systemctl restart chrony.service || true

# ----------------------------------------------------------------------------------------------------------------------
# 7. summary
# ----------------------------------------------------------------------------------------------------------------------
echo
info "install complete: warnings=$WARNINGS tunnel_ready=$TUNNEL_READY reboot_needed=$REBOOT_NEEDED"
[ "$TUNNEL_READY" = 1 ] || info "tunnel config skipped: peer/prefixes are placeholders (fill VZ_PEER_IP + VZ_PREFIXES in $ENV_FILE and re-run)"
[ "$REBOOT_NEEDED" = 0 ] || info "REBOOT REQUIRED (nf_conntrack still loaded)"
sleep 2
/usr/local/sbin/vz-status.sh
