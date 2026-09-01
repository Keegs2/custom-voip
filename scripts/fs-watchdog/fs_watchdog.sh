#!/usr/bin/env bash
# =============================================================================
# FreeSWITCH container/ESL watchdog — pages when the media stack dies on THIS VM
# =============================================================================
# Runs every 60s (systemd timer) on every MEDIA VM — FS-1 and FS-2 alike.
# Closes the FS-media-HA paging gap (docs/FS_MEDIA_HA_RUNBOOK.md §8): a
# container-level FreeSWITCH death fails over silently — the any-FS /healthz
# keeps the zone VIP up (so no "SIP front door DOWN" page) and the GCM vm_down
# alert only sees VM death. Traffic rides the other FS; NOBODY was paged.
# This watchdog is what pages the human.
#
# Checks, in order (first failure wins):
#   1. container  `docker inspect` on ${FS_WATCHDOG_CONTAINER} (voip-freeswitch)
#                 reports .State.Running == true
#   2. ESL        fs_cli INSIDE the container answers `-x status` with the
#                 switch "UP" banner. CLAUDE.md gotcha #1: fs_cli REQUIRES
#                 `-p $ESL_PASSWORD`. The secret never touches this process,
#                 its argv, or any log: the command string is SINGLE-quoted so
#                 $ESL_PASSWORD expands from the CONTAINER's own environment.
#                 A wrong/absent ESL_PASSWORD therefore (correctly) pages too.
#
# Paging — transition-based, no flapping storms:
#   * On the FS_WATCHDOG_FAIL_THRESHOLD-th consecutive failed tick (default 2,
#     i.e. ~2 min) it emits ONE syslog line tagged `revup-alert` (user.err).
#     The Ops Agent ships it to Cloud Logging where the existing
#     infra/monitoring log-match policy pages (itself rate-limited 30m).
#     Zero new GCP/Terraform resources.
#   * Further failed ticks log only an untagged `revup-fs-watchdog` journal
#     trail (no page, no storm).
#   * On return to healthy it emits an INFO recovery line (revup-fs-watchdog
#     tag — deliberately NOT the alert tag, so recovery never pages).
#   * The script exits 0 on a *detected* FS failure — detecting that IS its
#     job. Non-zero exits are reserved for the watchdog itself breaking, which
#     the unit's OnFailure=revup-alert@%p.service turns into a generic page.
#
# State: /run/revup/fs-watchdog.state (tmpfs — clean slate on reboot; if FS is
# still dead after a reboot the counter re-trips and pages again. Intended.)
#
# Tunables (optional /etc/revup/fs-watchdog.env — none required):
#   FS_WATCHDOG_CONTAINER       container to watch      (default voip-freeswitch)
#   FS_WATCHDOG_FAIL_THRESHOLD  consecutive failed ticks before paging (default 2)
#   FS_WATCHDOG_TIMEOUT         per-check timeout, seconds             (default 10)
#
# Manual run:  sudo /opt/revup/scripts/fs-watchdog/fs_watchdog.sh
# =============================================================================
set -euo pipefail

[ -f /etc/revup/fs-watchdog.env ] && . /etc/revup/fs-watchdog.env
FS_WATCHDOG_CONTAINER="${FS_WATCHDOG_CONTAINER:-voip-freeswitch}"
FS_WATCHDOG_FAIL_THRESHOLD="${FS_WATCHDOG_FAIL_THRESHOLD:-2}"
FS_WATCHDOG_TIMEOUT="${FS_WATCHDOG_TIMEOUT:-10}"

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run with sudo (needs docker)" >&2
    exit 1
fi

STATE_DIR=/run/revup
STATE_FILE="${STATE_DIR}/fs-watchdog.state"
mkdir -p "${STATE_DIR}"
HOST="$(hostname)"

# --- previous state (fails=N, paged=0|1) -------------------------------------
prev_fails=0
prev_paged=0
if [ -f "${STATE_FILE}" ]; then
    # State file is machine-written key=value (see printf below) — safe to source.
    # shellcheck disable=SC1090
    . "${STATE_FILE}" || true
    prev_fails="${fails:-0}"
    prev_paged="${paged:-0}"
fi

# --- checks ------------------------------------------------------------------
reason=""

running="$(timeout "${FS_WATCHDOG_TIMEOUT}" docker inspect -f '{{.State.Running}}' "${FS_WATCHDOG_CONTAINER}" 2>/dev/null || true)"
if [ "${running}" != "true" ]; then
    reason="container ${FS_WATCHDOG_CONTAINER} not running (state=${running:-absent})"
else
    # Capture output THEN grep: under pipefail, grep -q closing the pipe early
    # can SIGPIPE docker exec into a bogus non-zero status (false page).
    esl_out="$(timeout "${FS_WATCHDOG_TIMEOUT}" docker exec "${FS_WATCHDOG_CONTAINER}" sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x status' 2>/dev/null || true)"
    if ! printf '%s' "${esl_out}" | grep -q "UP"; then
        reason="container running but ESL unresponsive (fs_cli -x status gave no UP banner within ${FS_WATCHDOG_TIMEOUT}s — FS hung/booting, ESL dead, or ESL_PASSWORD mismatch)"
    fi
fi

# --- transition logic --------------------------------------------------------
if [ -z "${reason}" ]; then
    if [ "${prev_paged}" = "1" ]; then
        logger -t revup-fs-watchdog -- "RECOVERED: FreeSWITCH healthy again on ${HOST} (container running, ESL answering) after ${prev_fails} failed check(s). Expect automatic dispatcher failback within the probe window."
    elif [ "${prev_fails}" != "0" ]; then
        logger -t revup-fs-watchdog -- "blip cleared on ${HOST}: healthy again after ${prev_fails} failed check(s) (below page threshold ${FS_WATCHDOG_FAIL_THRESHOLD})"
    fi
    printf 'fails=0\npaged=0\n' > "${STATE_FILE}"
    exit 0
fi

fails=$((prev_fails + 1))
paged="${prev_paged}"

if [ "${paged}" = "0" ] && [ "${fails}" -ge "${FS_WATCHDOG_FAIL_THRESHOLD}" ]; then
    logger -p user.err -t revup-alert -- "FreeSWITCH DOWN on ${HOST}: ${reason} — ${fails} consecutive failed checks (~${fails} min). Zone media should be riding the OTHER FS (Grafana Traffic Status: Active FS row / CPS per FreeSWITCH) — or the zone is one failure from dark if this was the standby. Triage: sudo docker ps -a --filter name=${FS_WATCHDOG_CONTAINER} + sudo docker logs --tail 100 ${FS_WATCHDOG_CONTAINER}; recover per docs/FS_MEDIA_HA_RUNBOOK.md §5 (orphan gotcha: sudo killall -9 freeswitch before compose up -d)."
    paged=1
else
    logger -t revup-fs-watchdog -- "unhealthy on ${HOST} (${fails} consecutive, threshold ${FS_WATCHDOG_FAIL_THRESHOLD}, paged=${paged}): ${reason}"
fi

printf 'fails=%s\npaged=%s\n' "${fails}" "${paged}" > "${STATE_FILE}"
exit 0
