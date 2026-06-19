#!/bin/sh
set -e

# Template the nginx site config — replace __VERTO_PROXY_TARGET__ with the
# Verto (FreeSWITCH mod_verto) WebSocket upstream from the environment.
#
# Why: the /ws/verto/ location proxies wss://.../ws/verto/ down to FreeSWITCH's
# plain ws:// on port 8082. That upstream differs per deployment:
#   - single-host test box: host.docker.internal:8082 (FS on the local host)
#   - production services VM: the media-VM's VPC IP:8082
# nginx's proxy_pass cannot read env vars, so we sed the placeholder at startup.
#
# We use a targeted __PLACEHOLDER__ + sed substitution (NOT envsubst over the
# whole file) so nginx's own runtime $variables ($host, $remote_addr,
# $http_upgrade, $connection_upgrade, $proxy_add_x_forwarded_for, $scheme, the
# $grafana_upstream/$sipp_upstream variable upstreams, ...) are NOT clobbered.
# Same approach as docker/kamailio/entrypoint.sh and docker/freeswitch.

CONF=/etc/nginx/conf.d/rcf-ui.conf

# Default to the single-host local case when unset/empty.
VERTO_PROXY_TARGET="${VERTO_PROXY_TARGET:-host.docker.internal:8082}"

# Idempotent: only substitute while the placeholder is still present. On a
# container restart the conf already holds a real target, so we skip the sed
# (and avoid re-running it against an already-templated file).
if grep -q '__VERTO_PROXY_TARGET__' "$CONF"; then
  # '|' delimiter so a target like host:8082 (no slashes) substitutes cleanly.
  sed -i "s|__VERTO_PROXY_TARGET__|${VERTO_PROXY_TARGET}|g" "$CONF"
  echo "nginx config templated: VERTO_PROXY_TARGET=${VERTO_PROXY_TARGET}"
else
  echo "nginx config already templated (VERTO_PROXY_TARGET placeholder absent) — skipping"
fi

# Hand off to nginx in the foreground (PID 1) so Docker manages its lifecycle.
exec nginx -g 'daemon off;'
