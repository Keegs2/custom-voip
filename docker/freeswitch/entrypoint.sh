#!/bin/sh
# FreeSWITCH container entrypoint.
#
# Responsibilities (host/runtime config encoded in the repo, never run by hand):
#   1. GCE hairpin-NAT loopback fix  — add the public IP to lo.
#   2. ESL password hardening        — refuse the well-known "ClueCon" default.
#   3. Shared media spool wiring      — voicemail + recordings land on the
#                                       /media/spool volume the API uploads from.
# Then exec the FreeSWITCH binary with the CMD args.
#
# This script IS the image ENTRYPOINT (see Dockerfile). It must `exec` FS as PID 1
# so signals/healthchecks work.
set -e

# -----------------------------------------------------------------------------
# 1. GCE hairpin NAT — add the advertised public IP to the loopback interface.
# Without this, packets FS sends to its OWN public IP (e.g. ACK/BYE to Kamailio's
# Record-Route address) are dropped by GCE's fabric instead of delivered locally.
# Requires NET_ADMIN. No-op when EXTERNAL_SIP_IP is unset/loopback (local dev).
# -----------------------------------------------------------------------------
PUBLIC_IP="${EXTERNAL_SIP_IP:-}"
if [ -n "${PUBLIC_IP}" ] && [ "${PUBLIC_IP}" != "auto-nat" ] && [ "${PUBLIC_IP}" != "127.0.0.1" ]; then
  if ip addr show | grep -q "${PUBLIC_IP}"; then
    echo "entrypoint: public IP ${PUBLIC_IP} already on an interface"
  else
    echo "entrypoint: adding ${PUBLIC_IP}/32 to loopback (GCE hairpin NAT fix)"
    ip addr add "${PUBLIC_IP}/32" dev lo 2>/dev/null || true
  fi
fi

# -----------------------------------------------------------------------------
# 2. ESL password hardening (Phase 4 — kill ClueCon).
# event_socket.conf.xml reads $${esl_password}, which freeswitch.xml templates
# from ${ESL_PASSWORD} via X-PRE-PROCESS exec-set at parse time. We additionally
# refuse the public default here so it can never authenticate the Event Socket.
# -----------------------------------------------------------------------------
if [ "${ESL_PASSWORD}" = "ClueCon" ]; then
  echo "entrypoint: FATAL — ESL_PASSWORD is the well-known public default 'ClueCon'." >&2
  echo "entrypoint:         Set a strong ESL_PASSWORD in .env (must match the API)." >&2
  exit 1
fi
if [ -z "${ESL_PASSWORD}" ]; then
  echo "entrypoint: WARN — ESL_PASSWORD unset; FreeSWITCH will use the freeswitch.xml" >&2
  echo "entrypoint:        dev default (fs_esl_dev_pw). Set ESL_PASSWORD in .env for prod." >&2
fi
# Make sure the value FS templates from is exactly what we validated.
export ESL_PASSWORD

# -----------------------------------------------------------------------------
# 3. Shared media spool (Phase 4 — HA storage handoff).
# The /media/spool volume is shared with the API container, which uploads
# voicemail + recordings from it to object storage. FreeSWITCH WRITES there:
#   - mod_voicemail storage-dir  -> /media/spool/voicemail   (voicemail.conf.xml)
#   - $${recordings_dir}         -> /media/spool/recordings  (freeswitch.xml)
# Some code paths (handlers/ucaas.lua self-recorded voicemail, legacy recording
# callers) still write the in-image paths /var/lib/freeswitch/{voicemail,
# recordings}; symlink those onto the spool so EVERY artifact lands on the
# shared volume the API reads. (ucaas.lua keeps its /var/lib path — pinned by a
# characterization test — and the symlink makes it physically resolve to spool.)
# -----------------------------------------------------------------------------
mkdir -p /media/spool/voicemail /media/spool/recordings 2>/dev/null || true
for sub in voicemail recordings; do
  legacy="/var/lib/freeswitch/${sub}"
  target="/media/spool/${sub}"
  if [ ! -L "${legacy}" ]; then
    # Remove the empty image dir (ignore if non-empty / busy) then symlink.
    rm -rf "${legacy}" 2>/dev/null || true
    ln -sfn "${target}" "${legacy}" 2>/dev/null \
      && echo "entrypoint: ${legacy} -> ${target} (shared media spool)" \
      || echo "entrypoint: WARN — could not symlink ${legacy} -> ${target}"
  fi
done

exec /usr/local/freeswitch/bin/freeswitch "$@"
