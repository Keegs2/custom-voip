#!/bin/bash
# vz-drain.sh on|off|status — deliberate failover of THIS gateway (plan §3.5 "drain file", §11 drills).
# Installed to /usr/local/sbin/vz-drain.sh. The drain file lives in /run (tmpfs): a reboot always comes back UNDRAINED.
set -euo pipefail

ENV_FILE=${VZ_ENV_FILE:-/etc/vz-ipsec/vz-gateway.env}
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && . "$ENV_FILE"
DRAIN=${VZ_DRAIN_FILE:-/run/vz-drain}
PORT=${VZ_HEALTH_PORT:-8081}

health() { curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || echo "000"; }

case "${1:-status}" in
    on)
        touch "$DRAIN"
        echo "DRAINED: $DRAIN created on $(hostname)."
        echo "Consequence: /healthz returns 503 within ~2 s -> the next-hop ILB (HC 5 s x 2) moves the zone's Verizon traffic to the"
        echo "other gateway in ~10-12 s. The tunnel itself STAYS UP (Verizon keeps sending here until its own DPD/preference moves it;"
        echo "stateless NAT means replies still work). Undrain with: sudo vz-drain.sh off"
        sleep 3; echo "healthz now: $(health) (expect 503)"
        ;;
    off)
        rm -f "$DRAIN"
        echo "UNDRAINED: $DRAIN removed on $(hostname)."
        echo "Consequence: /healthz returns 200 within ~2 s if every other §3.5 check passes; the ILB fails BACK to this gateway"
        echo "(gw-a is the primary group) in ~10-12 s (failover-ratio 0, no connection drain)."
        sleep 3; echo "healthz now: $(health) (expect 200; if 503 run vz-status.sh — something else is failing)"
        ;;
    status)
        if [ -e "$DRAIN" ]; then echo "drain: ON ($DRAIN present)"; else echo "drain: off"; fi
        echo "healthz: $(health)"
        ;;
    *)
        echo "usage: vz-drain.sh on|off|status" >&2; exit 2
        ;;
esac
