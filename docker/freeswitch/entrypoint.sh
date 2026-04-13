#!/bin/bash
# FreeSWITCH entrypoint — adds public IP to loopback before starting FS.
#
# WHY: On GCE, the VM's external IP (34.74.71.32) is a 1:1 NAT address.
# Packets from the VM to its own external IP do not loop back through the
# kernel — they go out to the GCE network fabric and get dropped or routed
# asymmetrically. This breaks SIP in-dialog routing: when Kamailio inserts
# a Record-Route with the public IP, FreeSWITCH tries to send ACK/BYE to
# that IP, and the packets never arrive.
#
# FIX: Adding the public IP as a secondary address on the loopback interface
# tells the kernel to deliver those packets locally. This is a standard
# practice for servers behind 1:1 NAT (used by load balancers, anycast, etc).
#
# Since FreeSWITCH uses host networking (network_mode: host), changes to the
# host's network namespace from this container affect all host-network
# containers (including Kamailio). The NET_ADMIN capability is required.

set -e

# Add the public IP to loopback if not already present.
# EXTERNAL_SIP_IP is set in docker-compose.yml (defaults to 34.74.71.32).
PUBLIC_IP="${EXTERNAL_SIP_IP:-34.74.71.32}"

if ! ip addr show dev lo | grep -q "${PUBLIC_IP}"; then
    echo "Adding ${PUBLIC_IP}/32 to loopback interface for local delivery"
    ip addr add "${PUBLIC_IP}/32" dev lo 2>/dev/null || true
else
    echo "Public IP ${PUBLIC_IP} already on loopback"
fi

# Start FreeSWITCH with all original arguments
exec /usr/local/freeswitch/bin/freeswitch "$@"
