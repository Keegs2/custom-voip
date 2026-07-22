#!/usr/bin/env bash
# =============================================================================
# Call-quality watchdog — pages when inbound ASR collapses (calls silently fail)
# =============================================================================
# THE GAP (audit finding): the monitoring module (infra/monitoring) pages on
# *reachability* — VIP/VM/disk/mem/CPU. Nothing pages when the front door is up
# but calls are dying downstream: a bad carrier route, a Homer/SDP break, or a
# forward_to that answers with a 5xx. Answer-Seizure-Ratio (ASR = answered /
# seized) is the flagship-SLO signal, and it can crater to single digits with
# every uptime check still green.
#
# This watchdog (every ~10 min via systemd timer): computes the trailing-15-min
# INBOUND ASR from the cdrs hypertable. When there is enough volume to trust the
# number ($ASR_GUARD_MIN_VOLUME) AND ASR is below the floor ($ASR_GUARD_ASR_FLOOR),
# it emits a "revup-alert" syslog line — Cloud Monitoring's log-match policy
# (infra/monitoring) pages on that tag. No traffic (or too little to be
# meaningful) exits quietly: a quiet night is not an outage.
#
# ASR = answered / total, where answered = answer_time IS NOT NULL. Both figures
# come from a single trailing-window scan of cdrs (direction='inbound').
#
# Manual run (single line):  sudo /opt/revup/scripts/backup/asr_guard.sh
# =============================================================================
set -euo pipefail

[ -f /etc/revup/backup.env ] && . /etc/revup/backup.env
ASR_GUARD_MIN_VOLUME="${ASR_GUARD_MIN_VOLUME:-20}" # min inbound calls in 15m to page
ASR_GUARD_ASR_FLOOR="${ASR_GUARD_ASR_FLOOR:-50}"   # page below this ASR percent

if [ "$(id -un)" != "postgres" ]; then
    exec sudo -u postgres -- "$0" "$@"
fi

# asr_percent|volume  over the trailing 15 minutes of inbound calls.
# asr is NULL when volume is 0 (NULLIF guards the divide) — treated as no-traffic.
ROW="$(psql -X -tA -F'|' -c \
    "SELECT round(100.0 * count(*) FILTER (WHERE answer_time IS NOT NULL)
                  / NULLIF(count(*), 0)),
            count(*)
     FROM cdrs
     WHERE direction = 'inbound'
       AND start_time > now() - interval '15 minutes'")"

ASR="${ROW%%|*}"
VOL="${ROW##*|}"

# No traffic (empty/NULL ASR) → nothing to judge. Quiet exit, no page.
if [ -z "$ASR" ]; then
    logger -t revup-backup -- "asr-guard: no inbound traffic in the last 15m — nothing to check"
    exit 0
fi

# Always log an info line — Cloud Logging keeps the ASR trend.
logger -t revup-backup -- "asr-guard: inbound asr=${ASR}% volume=${VOL} window=15m"

if [ "$VOL" -ge "$ASR_GUARD_MIN_VOLUME" ] && [ "$ASR" -lt "$ASR_GUARD_ASR_FLOOR" ]; then
    logger -p user.err -t revup-alert -- "ASR ${ASR}% over 15m (vol=${VOL}) — inbound calls failing, check carrier/route/Homer"
    exit 1
fi

exit 0
