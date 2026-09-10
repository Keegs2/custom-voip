#!/usr/bin/env bash
# =============================================================================
# Unit tests for vmalert_pager.sh — parser + transition logic, no VM needed.
# =============================================================================
# Drives the pager in --dry-run mode (logger lines printed, not emitted)
# against file:// fixtures via VMALERT_PAGER_API_URL, with the state file
# redirected into a scratch dir. Needs only bash, curl, python3 (the same
# dependencies the pager itself has). Runs unprivileged.
#
# Usage (single line):  bash scripts/vmalert-pager/test/run_tests.sh
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PAGER="${HERE}/../vmalert_pager.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

export VMALERT_PAGER_STATE_FILE="${TMP}/vmalert-pager.state"
export VMALERT_PAGER_TIMEOUT=2
export VMALERT_PAGER_FAIL_THRESHOLD=5
export VMALERT_PAGER_MAX_MSG=300

FIX_A="file://${HERE}/fixture_a.json"          # one firing (east), one pending (west)
FIX_B="file://${HERE}/fixture_b.json"          # nothing firing (pending only)
FIX_C="file://${HERE}/fixture_c_error.json"    # status != success
UNREACH="http://127.0.0.1:1/api/v1/alerts"     # connection refused, instantly

ALERT='^\[revup-alert user.err\] '
INFO='^\[revup-vmalert-pager user.info\] '

failures=0
run() { VMALERT_PAGER_API_URL="$1" bash "${PAGER}" --dry-run; }

# expect <label> <output> <regex> <count>
expect() {
    local label="$1" out="$2" re="$3" want="$4" got
    got="$(printf '%s\n' "${out}" | grep -Ec -- "${re}" || true)"
    if [ "${got}" = "${want}" ]; then
        echo "  ok   ${label}: ${got} line(s) matching ${re}"
    else
        echo "  FAIL ${label}: wanted ${want} line(s) matching ${re}, got ${got}"
        printf '       output was:\n%s\n' "${out}" | sed 's/^/       /'
        failures=$((failures + 1))
    fi
}

echo "== 1. fixture A (one firing, one pending) → exactly one page line"
out="$(run "${FIX_A}")"
expect "A: alert lines" "${out}" "${ALERT}" 1
expect "A: page shape" "${out}" "${ALERT}vmalert SipByeFailureShare FIRING zone=east host=[^ ]+: BYEs are failing in zone east" 1
expect "A: pending never pages" "${out}" "FsStaleChannels" 0
expect "A: no info lines" "${out}" "${INFO}" 0
expect "A: state remembers key" "$(cat "${VMALERT_PAGER_STATE_FILE}")" '^paged=SipByeFailureShare\|east$' 1

echo "== 2. fixture A again (still firing) → no lines"
out="$(run "${FIX_A}")"
expect "A2: total lines" "${out}" "." 0

echo "== 3. fixture B (nothing firing) → exactly one INFO recovery line, no page"
out="$(run "${FIX_B}")"
expect "B: alert lines" "${out}" "${ALERT}" 0
expect "B: recovery line" "${out}" "${INFO}RECOVERED: vmalert SipByeFailureShare no longer firing zone=east" 1
expect "B: state emptied" "$(cat "${VMALERT_PAGER_STATE_FILE}")" '^paged=' 0

echo "== 4. fixture B again → no lines"
out="$(run "${FIX_B}")"
expect "B2: total lines" "${out}" "." 0

echo "== 5. unreachable x4 (+1 malformed body) → no page; 5th failure → one 'API unreachable' page"
for i in 1 2 3 4; do
    out="$(run "${UNREACH}")"
    expect "U${i}: no page" "${out}" "${ALERT}" 0
    expect "U${i}: journal trail" "${out}" "${INFO}vmalert API poll failed .*\(${i} consecutive" 1
done
out="$(run "${FIX_C}")"
expect "U5(malformed): one page" "${out}" "${ALERT}vmalert API unreachable on [^ ]+: .* failed 5 consecutive polls" 1
expect "U5: reason is parse failure" "${out}" "not a vmalert alerts document" 1
out="$(run "${UNREACH}")"
expect "U6: no second page" "${out}" "${ALERT}" 0
expect "U6: still journaling" "${out}" "${INFO}" 1

echo "== 6. API back (fixture B) → one INFO API-recovery line, no page"
out="$(run "${FIX_B}")"
expect "R: alert lines" "${out}" "${ALERT}" 0
expect "R: api recovery" "${out}" "${INFO}RECOVERED: vmalert API reachable again" 1

echo "== 7. paged set survives an API outage (no re-page when the API returns)"
out="$(run "${FIX_A}")"
expect "S1: page once" "${out}" "${ALERT}vmalert SipByeFailureShare FIRING" 1
for i in 1 2 3 4 5 6; do out="$(run "${UNREACH}")"; done
expect "S2: API page on 5th" "$(cat "${VMALERT_PAGER_STATE_FILE}")" '^api_paged=1$' 1
expect "S2: key kept through outage" "$(cat "${VMALERT_PAGER_STATE_FILE}")" '^paged=SipByeFailureShare\|east$' 1
out="$(run "${FIX_A}")"
expect "S3: no re-page after API recovery" "${out}" "${ALERT}" 0
expect "S3: api recovery info" "${out}" "${INFO}RECOVERED: vmalert API reachable again" 1
out="$(run "${FIX_B}")"
expect "S4: alert recovery after outage" "${out}" "${INFO}RECOVERED: vmalert SipByeFailureShare no longer firing" 1

echo "== 8. below-threshold blip → 'blip cleared' INFO, no page"
out="$(run "${UNREACH}")"
out="$(run "${FIX_B}")"
expect "blip: info" "${out}" "${INFO}blip cleared" 1
expect "blip: no page" "${out}" "${ALERT}" 0

echo
if [ "${failures}" -eq 0 ]; then
    echo "ALL TESTS PASSED"
else
    echo "${failures} FAILURE(S)"
    exit 1
fi
