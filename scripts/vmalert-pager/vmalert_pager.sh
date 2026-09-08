#!/usr/bin/env bash
# =============================================================================
# vmalert pager — relays FIRING vmalert alerts to the revup-alert page path
# =============================================================================
# Runs every 60s (systemd timer) on the SERVICES VM (where voip-vmalert runs).
# Closes the vmalert delivery gap (docker/vmalert/rules/teardown.yml header):
# vmalert evaluates `alert:` rules but has NO -notifier.url and there is no
# Alertmanager, so a firing alert reached nobody. The platform's ONE
# metric-derived → page path is an on-VM script emitting a syslog line tagged
# `revup-alert` (user.err) → Ops Agent → Cloud Logging → the GCM log-match
# policy (infra/monitoring/main.tf revup_alert_log) → email/Slack. This script
# is that bridge for vmalert. Zero new GCP/Terraform resources.
#
# How it reaches vmalert: docker-compose.services.yml publishes vmalert's
# :8880 to the host (`ports: "8880:8880"`), so the host polls
# http://127.0.0.1:8880/api/v1/alerts with curl. Response shape (verified
# against vmalert v1.103.0 app/vmalert/web.go + web_types.go):
#   {"status":"success","data":{"alerts":[{"name":..,"state":"firing"|"pending",
#     "labels":{"zone":..,..},"annotations":{"summary":..,"description":..},..}]}}
# Inactive alerts are never listed (ruleToAPIAlert skips StateInactive).
# Parsed with python3 (not jq): curl + python3 are the established on-VM
# dependencies (scripts/homer_aliases.sh, scripts/backup/preflight.sh);
# nothing on a VM uses jq.
#
# Paging — transition-based, no flapping storms (same model as fs_watchdog):
#   * Each alert is keyed `alertname|zone`. A key that is `firing` now and was
#     NOT in the state file emits ONE syslog line tagged `revup-alert`:
#       vmalert <alertname> FIRING zone=<zone> host=<host>: <summary|description>
#     (annotation collapsed to a single line, truncated to ~300 chars). The
#     key is then remembered; further ticks while it keeps firing log nothing.
#   * `pending` NEVER pages (it is the `for:` window still running).
#   * A remembered key that is no longer firing emits an INFO recovery line
#     tagged `revup-vmalert-pager` — deliberately NOT the alert tag, so
#     recovery never pages — and is forgotten.
#   * API unreachable / unparseable: do NOT page, do NOT touch the paged set
#     (fail-quiet, keep state). On the VMALERT_PAGER_FAIL_THRESHOLD-th
#     consecutive failure (default 5 ≈ 5 min) emit ONE `revup-alert` line
#     "vmalert API unreachable"; further failures only leave a journal trail;
#     the next successful poll logs an INFO recovery line.
#   * The script exits 0 whenever it did its job (paged or not). Non-zero
#     exits are reserved for the pager itself breaking (missing curl/python3,
#     unwritable state), which the unit's OnFailure=revup-alert@%p.service
#     turns into a generic page.
#
# State: /run/revup/vmalert-pager.state (tmpfs — clean slate on reboot; an
# alert still firing after a reboot re-pages once. Intended.) Format:
#   fails=<n>            consecutive API failures
#   api_paged=<0|1>      "API unreachable" page already emitted
#   paged=<name>|<zone>  one line per currently-paged alert key
# Written atomically (tmp + mv).
#
# Tunables (optional /etc/revup/vmalert-pager.env — none required):
#   VMALERT_PAGER_API_URL         (default http://127.0.0.1:8880/api/v1/alerts)
#   VMALERT_PAGER_FAIL_THRESHOLD  consecutive API failures before paging (default 5)
#   VMALERT_PAGER_TIMEOUT         curl --max-time, seconds               (default 10)
#   VMALERT_PAGER_MAX_MSG         max annotation chars in the page line   (default 300)
#   VMALERT_PAGER_STATE_FILE      (default /run/revup/vmalert-pager.state)
#
# Flags:
#   --dry-run   print the would-be logger lines to stdout instead of calling
#               logger; no root required. Used by test/run_tests.sh together
#               with VMALERT_PAGER_API_URL=file:///... fixtures.
#
# Manual run (single line):  sudo /opt/revup/scripts/vmalert-pager/vmalert_pager.sh
# =============================================================================
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
    case "${arg}" in
        --dry-run) DRY_RUN=1 ;;
        *)
            echo "usage: $0 [--dry-run]" >&2
            exit 2
            ;;
    esac
done

# Optional operator overrides (see Tunables above); absent on a stock install.
# shellcheck source=/dev/null
[ -f /etc/revup/vmalert-pager.env ] && . /etc/revup/vmalert-pager.env
VMALERT_PAGER_API_URL="${VMALERT_PAGER_API_URL:-http://127.0.0.1:8880/api/v1/alerts}"
VMALERT_PAGER_FAIL_THRESHOLD="${VMALERT_PAGER_FAIL_THRESHOLD:-5}"
VMALERT_PAGER_TIMEOUT="${VMALERT_PAGER_TIMEOUT:-10}"
VMALERT_PAGER_MAX_MSG="${VMALERT_PAGER_MAX_MSG:-300}"
VMALERT_PAGER_STATE_FILE="${VMALERT_PAGER_STATE_FILE:-/run/revup/vmalert-pager.state}"

if [ "${DRY_RUN}" = "0" ] && [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run with sudo (writes ${VMALERT_PAGER_STATE_FILE}; use --dry-run to test unprivileged)" >&2
    exit 1
fi

# Missing tooling is the pager being broken, not vmalert — exit non-zero so
# OnFailure pages the generic line instead of silently counting "API failures".
for bin in curl python3; do
    if ! command -v "${bin}" > /dev/null 2>&1; then
        echo "ERROR: ${bin} not found — the pager cannot poll/parse vmalert" >&2
        exit 1
    fi
done

STATE_FILE="${VMALERT_PAGER_STATE_FILE}"
mkdir -p "$(dirname "${STATE_FILE}")"
HOST="$(hostname)"

# --- output ------------------------------------------------------------------
emit() { # emit <priority> <tag> <message>
    if [ "${DRY_RUN}" = "1" ]; then
        printf '[%s %s] %s\n' "$2" "$1" "$3"
    else
        logger -p "$1" -t "$2" -- "$3"
    fi
}
page() { emit user.err revup-alert "$1"; }
info() { emit user.info revup-vmalert-pager "$1"; }

# --- previous state ----------------------------------------------------------
prev_fails=0
prev_api_paged=0
prev_keys=""
if [ -f "${STATE_FILE}" ]; then
    prev_fails="$(grep -m1 '^fails=' "${STATE_FILE}" | cut -d= -f2- || true)"
    prev_api_paged="$(grep -m1 '^api_paged=' "${STATE_FILE}" | cut -d= -f2- || true)"
    prev_keys="$(grep '^paged=' "${STATE_FILE}" | cut -d= -f2- || true)"
fi
case "${prev_fails}" in '' | *[!0-9]*) prev_fails=0 ;; esac
case "${prev_api_paged}" in 0 | 1) ;; *) prev_api_paged=0 ;; esac

# Exact-line set membership: is_in <key> <newline-separated set>
is_in() { printf '%s\n' "$2" | grep -qxF -- "$1"; }

# write_state <fails> <api_paged> <newline-separated keys>  — atomic
write_state() {
    local tmp="${STATE_FILE}.tmp.$$"
    {
        printf 'fails=%s\napi_paged=%s\n' "$1" "$2"
        printf '%s\n' "$3" | sed -e '/^$/d' -e 's/^/paged=/'
    } > "${tmp}"
    mv -f "${tmp}" "${STATE_FILE}"
}

# --- poll --------------------------------------------------------------------
# Emits one "<name>|<zone>\t<message>" line per FIRING alert, sorted, deduped.
# Exit 2 = not a healthy vmalert response (bad JSON / status != success).
# Name/zone are sanitised to [A-Za-z0-9_.:-] so the state file and the
# `alertname|zone` key stay single-token; the message is whitespace-collapsed.
PARSER='
import json, re, sys
maxlen = int(sys.argv[1])
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(2)
if not isinstance(doc, dict) or doc.get("status") != "success":
    sys.exit(2)
alerts = (doc.get("data") or {}).get("alerts") or []
clean = lambda s: re.sub(r"[^A-Za-z0-9_.:-]", "_", str(s)) or "-"
seen = {}
for a in alerts:
    if not isinstance(a, dict) or a.get("state") != "firing":
        continue
    labels = a.get("labels") or {}
    ann = a.get("annotations") or {}
    msg = ann.get("summary") or ann.get("description") or "(no summary/description annotation)"
    msg = re.sub(r"\s+", " ", str(msg)).strip()
    if len(msg) > maxlen:
        msg = msg[: maxlen - 3].rstrip() + "..."
    key = clean(a.get("name") or "unknown") + "|" + clean(labels.get("zone") or "-")
    seen.setdefault(key, msg)
for key in sorted(seen):
    print(key + "\t" + seen[key])
'

fetch_ok=1
reason=""
firing=""
if ! body="$(curl -sS -f --max-time "${VMALERT_PAGER_TIMEOUT}" "${VMALERT_PAGER_API_URL}" 2>&1)"; then
    fetch_ok=0
    reason="$(printf '%s' "${body}" | tr '\n' ' ' | cut -c1-200)"
    reason="curl failed: ${reason:-no output}"
elif ! firing="$(printf '%s' "${body}" | python3 -c "${PARSER}" "${VMALERT_PAGER_MAX_MSG}")"; then
    fetch_ok=0
    reason="response is not a vmalert alerts document (bad JSON or status != success)"
fi

# --- API failure path: fail-quiet, keep the paged set --------------------------
if [ "${fetch_ok}" = "0" ]; then
    fails=$((prev_fails + 1))
    api_paged="${prev_api_paged}"
    n_keys="$(printf '%s\n' "${prev_keys}" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "${api_paged}" = "0" ] && [ "${fails}" -ge "${VMALERT_PAGER_FAIL_THRESHOLD}" ]; then
        page "vmalert API unreachable on ${HOST}: ${VMALERT_PAGER_API_URL} failed ${fails} consecutive polls (~${fails} min) — ${reason}. Firing teardown alerts (docker/vmalert/rules) are NOT being relayed to this page path; ${n_keys} previously-paged alert(s) kept as paged. Triage: sudo docker ps -a --filter name=voip-vmalert + sudo docker logs --tail 50 voip-vmalert"
        api_paged=1
    else
        info "vmalert API poll failed on ${HOST} (${fails} consecutive, threshold ${VMALERT_PAGER_FAIL_THRESHOLD}, api_paged=${api_paged}): ${reason}"
    fi
    write_state "${fails}" "${api_paged}" "${prev_keys}"
    exit 0
fi

# --- API healthy: recovery of the API itself -----------------------------------
if [ "${prev_api_paged}" = "1" ]; then
    info "RECOVERED: vmalert API reachable again on ${HOST} after ${prev_fails} failed poll(s); resuming alert relay"
elif [ "${prev_fails}" != "0" ]; then
    info "blip cleared on ${HOST}: vmalert API reachable again after ${prev_fails} failed poll(s) (below page threshold ${VMALERT_PAGER_FAIL_THRESHOLD})"
fi

# --- transitions: newly firing → page; no longer firing → INFO recovery --------
new_keys=""
while IFS=$'\t' read -r key msg; do
    [ -z "${key}" ] && continue
    new_keys="${new_keys}${key}"$'\n'
    if ! is_in "${key}" "${prev_keys}"; then
        name="${key%%|*}"
        zone="${key#*|}"
        page "vmalert ${name} FIRING zone=${zone} host=${HOST}: ${msg}"
    fi
done <<< "${firing}"

while IFS= read -r key; do
    [ -z "${key}" ] && continue
    if ! is_in "${key}" "${new_keys}"; then
        name="${key%%|*}"
        zone="${key#*|}"
        info "RECOVERED: vmalert ${name} no longer firing zone=${zone} host=${HOST}"
    fi
done <<< "${prev_keys}"

write_state 0 0 "${new_keys}"
exit 0
