#!/usr/bin/env bash
# =============================================================================
# One-way / no-inbound-RTP watchdog — pages when calls connect but carry no audio
# =============================================================================
# THE GAP (docs/CALL_QUALITY_ACCURACY_PLAN.md §F): a media-path regression — a
# Cloud NAT pool IP replacing a media VM's 1:1 external IP, a lost bypass-vpn
# tag, a Docker/private IP leaking into SDP c=, RTP sourced from the wrong IP —
# answers EVERY call and bills it, while one or both parties hear silence.
# Signalling, ASR and every uptime check stay green. Before migration 50 even
# the quality numbers hid it: FreeSWITCH scored zero inbound RTP as MOS 4.50.
#
# Since migration 50 each A row carries call_quality_status (worse direction of
# caller->platform and the answered carrier callee->platform leg), and
# 'no_rtp' = answered >= 5 s with < 10% of the expected inbound packets.
#
# This watchdog (every 10 min via systemd timer) counts, over the trailing
# $MEDIA_GUARD_WINDOW_MIN minutes of CALLS (one row per call:
# `leg IS DISTINCT FROM 'B'`), the one-way calls vs all graded calls. It pages —
# one `revup-alert` syslog line, the platform's existing PG -> page path
# (Ops Agent -> Cloud Logging -> revup_alert_log policy) — only when BOTH
#   one_way >= MEDIA_GUARD_MIN_CALLS  AND  100*one_way/graded >= MEDIA_GUARD_MIN_SHARE_PCT.
# The single real one-way call a week seen in production does not page; a
# NAT/SDP regression (which hits every call) pages within one timer tick.
#
# Deploy-order safe (like asr_guard's HAS_LEG): until migration 50 adds
# cdrs.call_quality_status the guard exits 0 silently, so a `git pull` that
# lands before the migration can never become a failing unit that pages.
#
# Tunables (/etc/revup/backup.env, defaults in brackets):
#   MEDIA_GUARD_WINDOW_MIN [30]  MEDIA_GUARD_MIN_CALLS [3]  MEDIA_GUARD_MIN_SHARE_PCT [2]
#
# Manual run (single line):   sudo /opt/revup/scripts/backup/media_guard.sh
# Dry run (prints the page line instead of calling logger; info lines go to
# stderr):                     sudo /opt/revup/scripts/backup/media_guard.sh --dry-run
# =============================================================================
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
    esac
done

[ -f /etc/revup/backup.env ] && . /etc/revup/backup.env
MEDIA_GUARD_WINDOW_MIN="${MEDIA_GUARD_WINDOW_MIN:-30}"
MEDIA_GUARD_MIN_CALLS="${MEDIA_GUARD_MIN_CALLS:-3}"
MEDIA_GUARD_MIN_SHARE_PCT="${MEDIA_GUARD_MIN_SHARE_PCT:-2}"

# Integers only: they are inlined into SQL / bash arithmetic below.
for v in MEDIA_GUARD_WINDOW_MIN MEDIA_GUARD_MIN_CALLS MEDIA_GUARD_MIN_SHARE_PCT; do
    if ! [[ "${!v}" =~ ^[0-9]+$ ]]; then
        echo "media-guard: $v='${!v}' is not a non-negative integer" >&2
        exit 2
    fi
done

# Re-exec as postgres (peer auth on the services VM). MEDIA_GUARD_SKIP_SUDO=1
# is for the test harness only (it connects via PGHOST/PGPORT/PGUSER).
if [ "$(id -un)" != "postgres" ] && [ "${MEDIA_GUARD_SKIP_SUDO:-0}" != "1" ]; then
    exec sudo -u postgres -- "$0" "$@"
fi

DB="${BACKUP_DB:-voip}"

info() {
    if [ "$DRY_RUN" = "1" ]; then
        echo "$*" >&2
    else
        logger -t revup-backup -- "$*"
    fi
}

# -d voip is REQUIRED (cdrs lives there; see asr_guard.sh).
HAS_Q50="$(psql -d "$DB" -X -tA -c \
    "SELECT count(*) FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'cdrs'
       AND column_name = 'call_quality_status'")"
if [ "${HAS_Q50:-0}" = "0" ]; then
    exit 0      # migration 50 not applied yet — nothing to judge, no page
fi

# one_way|graded|carriers — A rows (one per call) that ENDED in the window.
ROW="$(psql -d "$DB" -X -tA -F'|' -c \
    "SELECT count(*) FILTER (WHERE call_quality_status = 'no_rtp') AS one_way,
            count(*) FILTER (WHERE call_quality_status IN ('rated','no_rtp')) AS graded,
            COALESCE(string_agg(DISTINCT COALESCE(inbound_carrier,'bandwidth') || '/' || COALESCE(inbound_carrier_pop,'-'), ',')
              FILTER (WHERE call_quality_status = 'no_rtp'), '') AS where_
       FROM cdrs
      WHERE leg IS DISTINCT FROM 'B'
        AND end_time > now() - make_interval(mins => ${MEDIA_GUARD_WINDOW_MIN})")"

ONE_WAY="${ROW%%|*}"
REST="${ROW#*|}"
GRADED="${REST%%|*}"
WHERE_="${REST#*|}"

if [ "${GRADED:-0}" = "0" ]; then
    info "media-guard: no graded calls in the last ${MEDIA_GUARD_WINDOW_MIN}m — nothing to check"
    exit 0
fi

info "media-guard: one_way=${ONE_WAY} graded=${GRADED} window=${MEDIA_GUARD_WINDOW_MIN}m"

if [ "$ONE_WAY" -ge "$MEDIA_GUARD_MIN_CALLS" ] \
   && [ $((100 * ONE_WAY)) -ge $((MEDIA_GUARD_MIN_SHARE_PCT * GRADED)) ]; then
    LINE="one-way-audio calls=${ONE_WAY}/${GRADED} window=${MEDIA_GUARD_WINDOW_MIN}m carriers=${WHERE_} — check media path (Cloud NAT/bypass-vpn, SDP c=, RTPs source IP) + Homer"
    if [ "$DRY_RUN" = "1" ]; then
        echo "$LINE"
    else
        logger -p user.err -t revup-alert -- "$LINE"
    fi
    # exit 0, NOT 1: the guard paged its own specific line. Non-zero would trip
    # the unit's OnFailure and page a second, generic "unit-failed" line.
    exit 0
fi

exit 0
