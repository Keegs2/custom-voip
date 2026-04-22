#!/bin/bash
# FreeSWITCH entrypoint — RCF-V1 Production Build
#
# LOOPBACK IP HACK (NAT environments only):
# On cloud platforms with 1:1 NAT (GCE, AWS, some vCenter setups), the VM's
# external/public IP is not assigned to any real interface. Packets from the VM
# to its own public IP go out to the cloud network fabric and get dropped or
# routed asymmetrically. This breaks SIP in-dialog routing: when Kamailio inserts
# a Record-Route with the public IP, FreeSWITCH tries to send ACK/BYE to that IP,
# and the packets never arrive.
#
# FIX: Adding the public IP as a secondary address on the loopback interface
# tells the kernel to deliver those packets locally. This is standard practice
# for servers behind 1:1 NAT (load balancers, anycast, etc).
#
# ON-PREM WITH DIRECTLY-ASSIGNED IPs: This is a no-op. If the public IP is
# already assigned to a real interface (eth0, ens4, etc.), the check below
# detects it and skips the loopback addition. The entrypoint passes through
# directly to FreeSWITCH.
#
# Since FreeSWITCH uses host networking (network_mode: host), changes to the
# host's network namespace from this container affect all host-network
# containers (including Kamailio). The NET_ADMIN capability is required.

set -e

# EXTERNAL_SIP_IP is set in docker-compose.yml (e.g., 34.74.71.32).
# If not set, skip the loopback hack entirely (on-prem or unconfigured).
PUBLIC_IP="${EXTERNAL_SIP_IP:-}"

if [ -n "${PUBLIC_IP}" ]; then
    # Check if this IP is already assigned to ANY interface (not just loopback).
    # On on-prem with directly-assigned IPs, it will be on eth0/ens4/etc.
    # On cloud NAT, it won't be on any interface and needs to be added to lo.
    if ip addr show | grep -q "${PUBLIC_IP}"; then
        echo "Public IP ${PUBLIC_IP} already assigned to an interface — no loopback hack needed"
    else
        echo "NAT environment detected: adding ${PUBLIC_IP}/32 to loopback for local delivery"
        ip addr add "${PUBLIC_IP}/32" dev lo 2>/dev/null || true
    fi
else
    echo "EXTERNAL_SIP_IP not set — skipping loopback IP hack (on-prem mode)"
fi

# Start FreeSWITCH with all original arguments
exec /usr/local/freeswitch/bin/freeswitch "$@"
