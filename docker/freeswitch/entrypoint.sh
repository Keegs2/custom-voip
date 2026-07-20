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

# -----------------------------------------------------------------------------
# 4. TTS engine default (Phase 7).
# The <Say> verb (handlers/api_voice.lua) reads the TTS_ENGINE env var. Piper
# (neural, offline) via mod_tts_commandline is the default; export it here when
# unset so (a) the value is visible in `env`, and (b) the freeswitch.xml
# `$${tts_engine}` exec-set global resolves to the SAME value the Lua hook uses.
# Set TTS_ENGINE=flite (and optionally TTS_DEFAULT_VOICE) to fall back to flite.
# -----------------------------------------------------------------------------
export TTS_ENGINE="${TTS_ENGINE:-tts_commandline}"
export TTS_DEFAULT_VOICE="${TTS_DEFAULT_VOICE:-slt}"
echo "entrypoint: TTS_ENGINE=${TTS_ENGINE} TTS_DEFAULT_VOICE=${TTS_DEFAULT_VOICE}"

# -----------------------------------------------------------------------------
# 5. E911 provisioning floor (LIFE SAFETY — H-2 / H-3).
# scripts/emergency.lua presents EMERGENCY_DEFAULT_CALLBACK as the SIP From on a
# 911 leg when a line has no per-line / DB-assigned DID, and attaches
# EMERGENCY_DEFAULT_LOCATION as the dispatchable location (RAY BAUM's Act) when a
# line has no per-line location. Bandwidth E911 REJECTS a 911 INVITE whose From is
# not a real account DID, and an empty dispatchable location is a RAY BAUM's Act
# provisioning failure. So in PRODUCTION both are REQUIRED and we hard-fail startup
# otherwise (mirrors the ESL ClueCon hard-fail above). Dev (no real public
# EXTERNAL_SIP_IP) only WARNS so the local stack still boots.
#
# "Production" is detected exactly like the hairpin-NAT block: a real public
# EXTERNAL_SIP_IP (PUBLIC_IP set and not auto-nat/127.0.0.1). This is the dev
# bypass — a local stack never sets a real public IP.
# -----------------------------------------------------------------------------
IS_PRODUCTION=false
if [ -n "${PUBLIC_IP}" ] && [ "${PUBLIC_IP}" != "auto-nat" ] && [ "${PUBLIC_IP}" != "127.0.0.1" ]; then
  IS_PRODUCTION=true
fi

# Normalize EMERGENCY_DEFAULT_CALLBACK to a 10-digit NANP number: strip non-digits,
# then drop a leading country-code 1 from an 11-digit value.
e911_cb_digits=$(printf '%s' "${EMERGENCY_DEFAULT_CALLBACK:-}" | tr -cd '0-9')
case "${e911_cb_digits}" in
  1??????????) e911_cb_digits=${e911_cb_digits#1} ;;
esac
# Valid NANP DID: NPA [2-9]XX, NXX [2-9]XX, then 4 subscriber digits (10 total).
if printf '%s' "${e911_cb_digits}" | grep -qE '^[2-9][0-9]{2}[2-9][0-9]{6}$'; then
  e911_cb_valid=true
else
  e911_cb_valid=false
fi

if [ "${e911_cb_valid}" != "true" ]; then
  if [ "${IS_PRODUCTION}" = "true" ]; then
    echo "entrypoint: FATAL — EMERGENCY_DEFAULT_CALLBACK is unset or not a valid" >&2
    echo "entrypoint:         10/11-digit NANP DID (got '${EMERGENCY_DEFAULT_CALLBACK:-<unset>}')." >&2
    echo "entrypoint:         Bandwidth E911 rejects a 911 From that is not a real" >&2
    echo "entrypoint:         account DID, so every un-provisioned 911 dial would fail" >&2
    echo "entrypoint:         to reach a PSAP. Set EMERGENCY_DEFAULT_CALLBACK to a real" >&2
    echo "entrypoint:         Granite E911-registered account DID in .env." >&2
    exit 1
  fi
  echo "entrypoint: WARN — EMERGENCY_DEFAULT_CALLBACK unset/invalid; allowed in dev" >&2
  echo "entrypoint:        (no real EXTERNAL_SIP_IP). 911 last-resort callback is" >&2
  echo "entrypoint:        unavailable — set it before carrying production 911 traffic." >&2
fi

# Dispatchable location floor (RAY BAUM's Act). Free-form (Bandwidth by-reference
# key / civic address / location URI), so only require NON-EMPTY here.
if [ -z "${EMERGENCY_DEFAULT_LOCATION:-}" ]; then
  if [ "${IS_PRODUCTION}" = "true" ]; then
    echo "entrypoint: FATAL — EMERGENCY_DEFAULT_LOCATION is empty. RAY BAUM's Act" >&2
    echo "entrypoint:         requires a dispatchable location on every 911 call, and" >&2
    echo "entrypoint:         per-line location wiring is not yet provisioned, so this" >&2
    echo "entrypoint:         default is the floor. Set EMERGENCY_DEFAULT_LOCATION (a" >&2
    echo "entrypoint:         Bandwidth by-reference key or civic address) in .env." >&2
    exit 1
  fi
  echo "entrypoint: WARN — EMERGENCY_DEFAULT_LOCATION empty; allowed in dev. 911 would" >&2
  echo "entrypoint:        have NO dispatchable location — set it before production." >&2
fi

exec /usr/local/freeswitch/bin/freeswitch "$@"
