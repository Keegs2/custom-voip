#!/bin/sh
set -e

PUBLIC_IP="${EXTERNAL_SIP_IP:-}"

if [ -n "${PUBLIC_IP}" ]; then
  if ip addr show | grep -q "${PUBLIC_IP}"; then
    echo "Public IP ${PUBLIC_IP} already on interface"
  else
    echo "Adding ${PUBLIC_IP}/32 to loopback"
    ip addr add "${PUBLIC_IP}/32" dev lo 2>/dev/null || true
  fi
fi

exec /usr/local/freeswitch/bin/freeswitch "$@"
