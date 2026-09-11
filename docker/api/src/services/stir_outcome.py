"""STIR/SHAKEN egress OUTCOME — parse + badge derivation (shared serializer).

Two attestation facts exist per carrier-bound call:

  * INTENT  — what FreeSWITCH *asked* Kamailio to sign (`stir_attest_intent`
              + `stir_inbound_signed` → `call_attestations.signed_attestation`,
              derived at ingest in routers/cdrs.py::_store_call_attestation).
  * ACTUAL  — what Kamailio *really did on the wire*, handed back to
              FreeSWITCH as the `X-Stir-Outcome` response header and surfaced
              on the A-leg as channel var `stir_outcome` (or, when B-leg CDRs
              are enabled, as `sip_rh_X-Stir-Outcome` on the B-leg JSON).

Wire format of the outcome value (contract with the telephony side):

    eff=<div|A|B|C|base-only|unsigned>;mode=<relay|passthrough-div|reorig|
    gateway-C|base|pbx>;identities=<n>;base=<n>;div=<0|1>;stripped=<n>

The ingest stores the raw string in `cdrs.stir_outcome` and the `eff=` token
in `cdrs.stir_eff_actual` (migration 47). Everything here is a pure function
so it is unit-testable without a DB and can be shared by every endpoint that
renders the attestation badge (CDR list/detail, per-call attestation, Homer
trace search) — ONE serializer, so the UI never sees drifting shapes.

Badge rule:  `stir_badge` = ACTUAL when present, else INTENT.
             `stir_badge_source` = "actual" | "intent" | None.
"""
from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import unquote_plus

# Raw outcome strings are bounded before they hit the TEXT column: a hostile
# or buggy header must never bloat a CDR row.
MAX_OUTCOME_LEN = 255

# The `eff=` token must look like a level label. Value-AGNOSTIC on purpose
# (the dashboards are too): a future label such as `base-only` or `unsigned`
# stores fine; only garbage (spaces, quotes, oversize) is rejected.
_EFF_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9\-]{0,15}$")

# Known labels as emitted by Kamailio's kamailio_stir_attest_signed{attestation=…}.
# Informational only — parsing does NOT gate on this set.
KNOWN_EFF_LABELS = ("div", "A", "B", "C", "base-only", "unsigned")

# Channel-var names an outcome may arrive under (checked in this order).
#   stir_outcome           — FS-side var set from the X-Stir-Outcome header.
#   sip_rh_X-Stir-Outcome  — mod_sofia's automatic response-header capture on
#                            the B-leg, copied to the A-leg partner on any
#                            final response when sip_copy_custom_headers is
#                            unset/true (sofia.c nua_r_invite handling).
OUTCOME_VAR_PRIMARY = "stir_outcome"
OUTCOME_VAR_HEADER = "sip_rh_x-stir-outcome"  # matched case-insensitively

# mod_sofia's response-header capture is real and reaches the A-leg WITHOUT any
# Lua (verified against FreeSWITCH master, src/mod/endpoints/mod_sofia):
#   mod_sofia.h:120   #define SOFIA_SIP_RESPONSE_HEADER_PREFIX "sip_rh_"
#   sofia.c:6780      if (status > 199) sofia_glue_set_extra_headers(session, sip,
#                         SOFIA_SIP_RESPONSE_HEADER_PREFIX);      <- B-leg
#   sofia.c:6787-6797 unless sip_copy_custom_headers is explicitly false, every
#                     var named sip_rh_* is transferred to the partner (A-leg).
#   mod_sofia.h:1137  sofia_test_extra_headers() admits "X-*" (but not "X-FS-*"),
#                     so `X-Stir-Outcome` is captured; `X-FS-…` would NOT be.
# We set no `sip_copy_custom_headers` anywhere in docker/freeswitch, so the copy
# is active. The explicit `stir_outcome` channel var still wins when present.


def _maybe_urldecode(s: str) -> str:
    """Undo mod_json_cdr value URL-encoding, but ONLY when it is unambiguous.

    `json_cdr.conf.xml` sets `encode-values=false`, so channel-var VALUES reach
    us raw (`eff=div;mode=relay;...`). If that param is ever flipped,
    mod_json_cdr URL-encodes every value and the outcome would arrive as
    `eff%3Ddiv%3Bmode%3Drelay`. Decode only when the string has NO literal `=`
    but does carry a percent-escaped one — so a legitimate raw value that
    happens to contain a `%` is never mangled.
    """
    if "=" not in s and ("%3D" in s or "%3d" in s):
        try:
            return unquote_plus(s)
        except Exception:  # noqa: BLE001 - never let a decode kill an ingest
            return s
    return s


def extract_outcome_raw(variables: dict) -> Optional[str]:
    """Pull the raw outcome string out of a FreeSWITCH `variables` dict.

    Prefers the explicit `stir_outcome` channel var, then any key equal to
    `sip_rh_X-Stir-Outcome` ignoring case (mod_sofia preserves the header's
    wire case, so `X-Stir-Outcome` vs `X-STIR-Outcome` must both hit).
    Empty / whitespace-only -> None. Never raises.
    """
    if not isinstance(variables, dict):
        return None
    val = variables.get(OUTCOME_VAR_PRIMARY)
    if val is None or not str(val).strip():
        val = None
        for k, v in variables.items():
            if isinstance(k, str) and k.lower() == OUTCOME_VAR_HEADER:
                val = v
                break
    if val is None:
        return None
    # Bound BEFORE decoding so a hostile megabyte header cannot be expanded in
    # memory, then bound again after (decoding only ever shrinks, but be exact).
    s = _maybe_urldecode(str(val)[: MAX_OUTCOME_LEN * 4]).strip()
    if not s:
        return None
    return s[:MAX_OUTCOME_LEN]


def parse_outcome(raw: Optional[str]) -> dict[str, str]:
    """Parse `k=v;k=v` into a lower-keyed dict. Malformed pieces are skipped.

    "eff=div;mode=relay;identities=1" -> {"eff": "div", "mode": "relay", ...}
    None / "" / "garbage" -> {} (or whatever k=v pairs were salvageable).
    """
    out: dict[str, str] = {}
    if not raw:
        return out
    for piece in str(raw).split(";"):
        piece = piece.strip()
        if not piece or "=" not in piece:
            continue
        k, _, v = piece.partition("=")
        k = k.strip().lower()
        v = v.strip()
        if k and v:
            out[k] = v
    return out


def eff_from_outcome(raw: Optional[str]) -> Optional[str]:
    """The `eff=` token of an outcome string, or None when absent/malformed."""
    eff = parse_outcome(raw).get("eff")
    if eff and _EFF_TOKEN_RE.match(eff):
        return eff
    return None


def extract_outcome(variables: dict) -> tuple[Optional[str], Optional[str]]:
    """(stir_outcome raw, stir_eff_actual) from a `variables` dict."""
    raw = extract_outcome_raw(variables)
    return raw, eff_from_outcome(raw)


def badge_fields(
    signed_attestation: Optional[str],
    stir_eff_actual: Optional[str],
    stir_outcome: Optional[str],
) -> dict[str, Any]:
    """The shared attestation-badge payload.

    Returned keys (identical on every endpoint that carries a badge):
      stir_attestation   — INTENT-derived level (call_attestations.signed_attestation)
      stir_eff_actual    — ACTUAL wire level (`eff=` token) or null
      stir_outcome       — raw outcome string or null
      stir_badge         — actual when present, else intent, else null
      stir_badge_source  — "actual" | "intent" | null
    """
    if stir_eff_actual:
        badge, source = stir_eff_actual, "actual"
    elif signed_attestation:
        badge, source = signed_attestation, "intent"
    else:
        badge, source = None, None
    return {
        "stir_attestation": signed_attestation,
        "stir_eff_actual": stir_eff_actual,
        "stir_outcome": stir_outcome,
        "stir_badge": badge,
        "stir_badge_source": source,
    }


# ---------------------------------------------------------------------------
# B-leg CDR detection (mod_json_cdr `log-b-leg=true` mode)
# ---------------------------------------------------------------------------
# BILLING-CRITICAL. A body classified as a B-leg is NEVER inserted, so a false
# positive is a LOST BILLABLE ROW. Every signal below was verified against the
# FreeSWITCH master source (signalwire/freeswitch, src/), not from memory:
#
#  * mod_json_cdr's OWN a/b decision, and its only one:
#        mod_json_cdr.c:454  is_b = channel && switch_channel_get_originator_caller_profile(channel);
#    and with `log-b-leg=false` it returns before posting anything:
#        mod_json_cdr.c:455-460  if (!globals.log_b && is_b) { ... return SWITCH_STATUS_SUCCESS; }
#    docker/freeswitch/conf/autoload_configs/json_cdr.conf.xml ships
#    log-b-leg=false, so TODAY no B-leg CDR is ever posted at all; this path is
#    the forward-compatible guard for the day that flips (or for a call that
#    sets SWITCH_FORCE_PROCESS_CDR_VARIABLE).
#
#  * switch_ivr_generate_json_cdr renders exactly that originator profile, so
#    the same predicate is available in the JSON body:
#        switch_ivr.c:3491  cJSON_AddItemToObject(j_main_cp, "originator", j_o);
#        switch_ivr.c:3494  cJSON_AddItemToObject(j_o, "originator_caller_profiles", j_o_profiles);
#        switch_ivr.c:3222  cJSON_AddItemToObject(json, "uuid", ...)   (per profile)
#    The A-leg of a bridge carries the MIRROR key instead — never "originator":
#        switch_ivr.c:3508  "originatee" / switch_ivr.c:3511 "originatee_caller_profiles"
#
#  * `originating_leg_uuid` is set on the PEER (B) channel ONLY. Sole
#    assignment repo-wide:
#        switch_ivr_originate.c:3217
#            switch_channel_set_variable(oglobals.originate_status[i].peer_channel,
#                                        "originating_leg_uuid",
#                                        switch_core_session_get_uuid(a_session));
#    (the originating A-leg gets `originated_legs` at :3219 instead). Safe as a
#    second detector.
#
# Signals deliberately NOT used as detectors:
#  * `signal_bond`  — switch_ivr_bridge.c:1764 AND :1767 set it on BOTH legs.
#  * `bridge_uuid`  — switch_ivr_bridge.c:1763 AND :1766 set it on BOTH legs.
#    Either one as a detector would classify EVERY bridged RCF A-leg as a B-leg
#    and drop the billable row. They are A-leg-uuid RESOLVERS only.
#  * `other_leg_unique_id` — DOES NOT EXIST in FreeSWITCH. `Other-Leg-Unique-ID`
#    is assembled at event time (switch_caller.c:383-385 via
#    switch_channel.c:2749) and is an EVENT header only, so it can never appear
#    in a mod_json_cdr `variables` dict. Kept as a RESOLVER purely so the
#    telephony side can set it explicitly in Lua if it wants to; it is not a
#    trigger, because a var FreeSWITCH never sets is a pure false-positive
#    surface.
#  * `direction == "outbound"` — API/ESL-originated FIRST legs are outbound
#    A-legs.
#
# Final safety interlock: if the resolved "A-leg" uuid equals the body's own
# uuid the classification is incoherent, and we fall back to the A-leg INSERT
# path. The failure direction is always "keep the billable row".

# A-leg-uuid RESOLVERS, most authoritative first. Presence here does NOT make a
# body a B-leg (see above) — these are only consulted once `is_b` is already
# true from an originator profile / `originating_leg_uuid`.
_A_LEG_UUID_VARS = (
    "originating_leg_uuid",   # FS core: set on originated peer channels only
    "other_leg_unique_id",    # not native to FS; honoured if Lua sets it
    "bridge_uuid",            # bridge-time partner uuid (both legs)
    "signal_bond",            # pre-bridge partner uuid (both legs)
)

# Detectors — a body is a B-leg only if one of these fires.
_B_LEG_DETECTOR_VARS = ("originating_leg_uuid",)


def _iter_caller_profiles(body: dict):
    callflow = body.get("callflow")
    if isinstance(callflow, dict):
        callflow = [callflow]
    if not isinstance(callflow, list):
        return
    for entry in callflow:
        if isinstance(entry, dict):
            cp = entry.get("caller_profile")
            if isinstance(cp, dict):
                yield cp


def originator_uuid(body: dict) -> Optional[str]:
    """uuid of the ORIGINATOR (A-leg) profile embedded in a B-leg JSON CDR.

    None  -> no originator profile anywhere (mod_json_cdr would call this an
             A-leg).
    ""    -> an originator profile IS present (definitively a B-leg) but no
             uuid could be read out of it.
    """
    for cp in _iter_caller_profiles(body):
        orig = cp.get("originator")
        if not isinstance(orig, dict) or not orig:
            continue
        profiles = orig.get("originator_caller_profiles")
        if isinstance(profiles, list):
            for p in profiles:
                if isinstance(p, dict) and p.get("uuid"):
                    return str(p["uuid"])
        if orig.get("uuid"):
            return str(orig["uuid"])
        return ""  # originator present but uuid-less: still a B-leg
    return None


def b_leg_a_uuid(body: dict, own_uuid: Optional[str] = None) -> Optional[str]:
    """If `body` is a B-leg CDR, return the A-leg uuid it belongs to.

    Returns None when the body is an A-leg (caller must take the INSERT path),
    or "" when it is unmistakably a B-leg but the A-leg uuid could not be
    resolved (caller must then no-op, never INSERT).

    `own_uuid` is the uuid the caller already extracted for this body. When
    given, a resolved A-leg uuid identical to it is treated as an incoherent
    classification and the body is reported as an A-leg — the safe direction,
    because dropping an A-leg loses a billable row.
    """
    variables = body.get("variables") or {}
    if not isinstance(variables, dict):
        variables = {}

    def _var(name: str) -> str:
        v = variables.get(name)
        return str(v).strip() if v is not None else ""

    orig = originator_uuid(body)
    is_b = orig is not None or any(_var(v) for v in _B_LEG_DETECTOR_VARS)
    if not is_b:
        return None

    a_uuid = orig or next((_var(v) for v in _A_LEG_UUID_VARS if _var(v)), "")
    if own_uuid and a_uuid and str(a_uuid) == str(own_uuid):
        # A channel cannot be its own originator. Something is malformed —
        # keep the row.
        return None
    return a_uuid
