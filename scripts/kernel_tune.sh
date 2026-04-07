#!/bin/bash
# Kernel Tuning for High-Volume Voice Platform
# Run on the VCenter VM host (not in containers)
#
# Usage: sudo ./kernel_tune.sh
#
set -e

echo "=== Voice Platform Kernel Tuning ==="
echo "Optimizing for high-volume SIP/RTP traffic..."

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (sudo)"
   exit 1
fi

# Create sysctl config
cat > /etc/sysctl.d/99-voip.conf << 'EOF'
# Voice Platform Kernel Tuning
# Optimized for high-volume SIP/RTP traffic

# Network core settings
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 65536
net.core.somaxconn = 65535
net.core.optmem_max = 65536

# UDP buffer sizes (critical for RTP)
net.ipv4.udp_rmem_min = 16384
net.ipv4.udp_wmem_min = 16384
net.ipv4.udp_mem = 65536 131072 262144

# TCP settings
net.ipv4.tcp_rmem = 4096 1048576 16777216
net.ipv4.tcp_wmem = 4096 1048576 16777216
net.ipv4.tcp_max_syn_backlog = 65536
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_tw_buckets = 2000000

# Connection tracking (for NAT)
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_tcp_timeout_established = 3600
net.netfilter.nf_conntrack_udp_timeout = 60
net.netfilter.nf_conntrack_udp_timeout_stream = 180

# Local port range (for outbound connections)
net.ipv4.ip_local_port_range = 10000 65535

# Virtual memory
vm.swappiness = 10
vm.dirty_ratio = 20
vm.dirty_background_ratio = 5

# File handles
fs.file-max = 2097152
fs.nr_open = 2097152

# inotify limits (for file watching)
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
EOF

# Apply sysctl settings
sysctl --system

# Update ulimits
cat > /etc/security/limits.d/99-voip.conf << 'EOF'
# Voice Platform Limits
* soft nofile 1048576
* hard nofile 1048576
* soft nproc 65535
* hard nproc 65535
* soft memlock unlimited
* hard memlock unlimited
* soft core unlimited
* hard core unlimited
root soft nofile 1048576
root hard nofile 1048576
EOF

# Disable transparent huge pages (can cause latency spikes)
if [ -f /sys/kernel/mm/transparent_hugepage/enabled ]; then
    echo never > /sys/kernel/mm/transparent_hugepage/enabled
    echo never > /sys/kernel/mm/transparent_hugepage/defrag
fi

# Create systemd service to apply THP settings on boot
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=basic.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'

[Install]
WantedBy=basic.target
EOF

systemctl daemon-reload
systemctl enable disable-thp

echo ""
echo "=== Kernel tuning complete ==="
echo "Settings applied:"
echo "  - UDP/TCP buffer sizes increased"
echo "  - Connection tracking optimized"
echo "  - File descriptor limits increased"
echo "  - Transparent huge pages disabled"
echo ""
echo "Reboot recommended for all changes to take effect."
