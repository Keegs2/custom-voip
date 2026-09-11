"""Unit tests — STIR egress OUTCOME on CDRs, B-leg update path, sip_code
precedence and freeswitch_node derivation (routers/cdrs.py +
services/stir_outcome.py; migration 47).

Runnable WITHOUT a live DB — same sys.path + fake-db pattern as
tests/test_cdr_onnet_ingest.py, except the fake captures EVERY db.execute
call (the ingest may issue the INSERT and then the attestation UPSERT).

Contract under test (telephony side hands back the ACTUAL egress result):
  * A-leg: variables.stir_outcome =
        "eff=<div|A|B|C|base-only|unsigned>;mode=<...>;identities=<n>;base=<n>;div=<0|1>;stripped=<n>"
    (or the auto-captured sip_rh_X-Stir-Outcome). Stored raw in
    cdrs.stir_outcome ($56) and the eff= token in cdrs.stir_eff_actual ($57).
  * B-leg CDR (mod_json_cdr log-b-leg=true — currently FALSE in
    json_cdr.conf.xml, so this is a forward-compatible guard): NEVER
    inserts a cdrs row; it may
    only UPDATE the A-leg row's two stir columns by the A-leg uuid; if the
    A-leg row is missing (race) -> retry-free no-op; status is still 200.

Run:
    python3 -m pytest tests/test_cdr_stir_outcome.py -v
"""
import asyncio
import pathlib
import re
import sys

import pytest

_SRC = pathlib.Path(__file__).resolve().parents[1] / "docker" / "api" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from db import database as db  # noqa: E402
from routers import cdrs  # noqa: E402
from services import stir_outcome as so  # noqa: E402


OUTCOME = "eff=div;mode=relay;identities=1;base=1;div=1;stripped=0"

# Bind positions of the two new INSERT columns (see cdrs.py $56/$57).
IDX_STIR_OUTCOME = 55
IDX_STIR_EFF_ACTUAL = 56
PARAM_COUNT = 57


class _Capture:
    """Records every db.execute call; a configurable UPDATE result lets tests
    simulate the A-leg-row-missing race ("UPDATE 0")."""

    def __init__(self, update_result="UPDATE 1"):
        self.calls = []            # [(sql, params)]
        self.update_result = update_result
        self.raise_on_update = False

    async def execute(self, sql, *params):
        self.calls.append((sql, params))
        if sql.lstrip().upper().startswith("UPDATE"):
            if self.raise_on_update:
                raise RuntimeError("simulated DB failure")
            return self.update_result
        return "INSERT 0 1"

    @property
    def inserts(self):
        return [(s, p) for s, p in self.calls if "INSERT INTO cdrs" in s]

    @property
    def updates(self):
        return [(s, p) for s, p in self.calls if s.lstrip().upper().startswith("UPDATE")]


@pytest.fixture
def cap(monkeypatch):
    c = _Capture()
    monkeypatch.setattr(db, "execute", c.execute)
    return c


def _a_leg_vars(**overrides):
    v = {
        "uuid": "a-leg-uuid-1",
        "direction": "inbound",
        "product_type": "rcf",
        "destination_number": "+17744045256",
        "caller_id_number": "+15087282017",
        "start_epoch": "1700000000",
        "end_epoch": "1700000030",
        "answer_epoch": "1700000005",
        "duration": "30",
        "billsec": "25",
        "hangup_cause": "NORMAL_CLEARING",
        "customer_id": "20",
    }
    v.update(overrides)
    return v


def _b_leg_body(a_uuid="a-leg-uuid-1", **var_overrides):
    """A B-leg JSON CDR shaped like switch_ivr_generate_json_cdr output for a
    channel that has an originator caller profile (mod_json_cdr's own is_b)."""
    v = {
        "uuid": "b-leg-uuid-1",
        "direction": "outbound",
        "destination_number": "+17744045256",
        "start_epoch": "1700000001",
        "end_epoch": "1700000030",
        "answer_epoch": "1700000005",
        "originating_leg_uuid": a_uuid,
        "sip_rh_X-Stir-Outcome": OUTCOME,
    }
    v.update(var_overrides)
    return {
        "core-uuid": "core-1",
        "switchname": "voiceplatform",
        "variables": v,
        "callflow": [{
            "caller_profile": {
                "uuid": "b-leg-uuid-1",
                "destination_number": "+17744045256",
                "originator": {
                    "originator_caller_profiles": [{"uuid": a_uuid}],
                },
            },
        }],
    }


def _run(body):
    return asyncio.run(cdrs._process_cdr_body(body))


# ---------------------------------------------------------------------------
# services.stir_outcome — pure parsing / badge
# ---------------------------------------------------------------------------

def test_parse_outcome_full_string():
    d = so.parse_outcome(OUTCOME)
    assert d == {"eff": "div", "mode": "relay", "identities": "1",
                 "base": "1", "div": "1", "stripped": "0"}
    assert so.eff_from_outcome(OUTCOME) == "div"


@pytest.mark.parametrize("eff", ["div", "A", "B", "C", "base-only", "unsigned"])
def test_all_contract_eff_labels_round_trip(eff):
    assert so.eff_from_outcome(f"eff={eff};mode=base") == eff


def test_parse_outcome_malformed():
    assert so.parse_outcome(None) == {}
    assert so.parse_outcome("") == {}
    assert so.parse_outcome("garbage") == {}
    assert so.eff_from_outcome("garbage") is None
    assert so.eff_from_outcome("eff=;mode=relay") is None
    # eff token must be a plain label — spaces/quotes/oversize rejected
    assert so.eff_from_outcome('eff="div x";mode=relay') is None
    assert so.eff_from_outcome("eff=" + "A" * 40) is None
    # salvage what is parseable
    assert so.parse_outcome("junk;eff=A;;=x;mode=") == {"eff": "A"}


def test_extract_outcome_prefers_stir_outcome_then_header_case_insensitive():
    assert so.extract_outcome({"stir_outcome": OUTCOME}) == (OUTCOME, "div")
    assert so.extract_outcome({"sip_rh_X-Stir-Outcome": "eff=A;mode=base"}) == ("eff=A;mode=base", "A")
    assert so.extract_outcome({"sip_rh_X-STIR-OUTCOME": "eff=C;mode=gateway-C"}) == ("eff=C;mode=gateway-C", "C")
    # explicit var wins over the header copy
    assert so.extract_outcome({"stir_outcome": "eff=B", "sip_rh_X-Stir-Outcome": "eff=A"}) == ("eff=B", "B")
    # empty explicit var falls through to the header
    assert so.extract_outcome({"stir_outcome": "", "sip_rh_X-Stir-Outcome": "eff=A"}) == ("eff=A", "A")
    assert so.extract_outcome({}) == (None, None)
    assert so.extract_outcome({"stir_outcome": "   "}) == (None, None)


def test_extract_outcome_urldecodes_only_when_unambiguous():
    """json_cdr.conf.xml sets encode-values=false so values arrive raw; if that
    is ever flipped, mod_json_cdr URL-encodes every channel-var VALUE. Decode
    only when there is no literal '=' but a percent-escaped one is present, so
    a raw value containing '%' is never mangled."""
    assert so.extract_outcome({"stir_outcome": "eff%3Ddiv%3Bmode%3Drelay"}) == (
        "eff=div;mode=relay", "div")
    # raw wins untouched — a literal '=' means it is not encoded
    assert so.extract_outcome({"stir_outcome": "eff=div;note=100%3Dfull"}) == (
        "eff=div;note=100%3Dfull", "div")


def test_extract_outcome_bounds_raw_length():
    raw, eff = so.extract_outcome({"stir_outcome": "eff=A;" + "x" * 1000})
    assert len(raw) == so.MAX_OUTCOME_LEN
    assert eff == "A"


def test_badge_fields_actual_beats_intent():
    b = so.badge_fields("div", "C", "eff=C;mode=gateway-C")
    assert b["stir_badge"] == "C" and b["stir_badge_source"] == "actual"
    assert b["stir_attestation"] == "div"
    assert b["stir_eff_actual"] == "C"
    assert b["stir_outcome"] == "eff=C;mode=gateway-C"


def test_badge_fields_intent_fallback_and_none():
    b = so.badge_fields("div", None, None)
    assert b["stir_badge"] == "div" and b["stir_badge_source"] == "intent"
    b = so.badge_fields(None, None, None)
    assert b["stir_badge"] is None and b["stir_badge_source"] is None
    assert set(b) == {"stir_attestation", "stir_eff_actual", "stir_outcome",
                      "stir_badge", "stir_badge_source"}


# ---------------------------------------------------------------------------
# B-leg detection rule
# ---------------------------------------------------------------------------

def test_b_leg_detected_via_callflow_originator():
    body = _b_leg_body()
    del body["variables"]["originating_leg_uuid"]
    assert so.b_leg_a_uuid(body) == "a-leg-uuid-1"


def test_b_leg_detected_via_originating_leg_uuid_only():
    body = {"variables": {"uuid": "b", "direction": "outbound",
                          "originating_leg_uuid": "a-leg-uuid-9"}}
    assert so.b_leg_a_uuid(body) == "a-leg-uuid-9"


def test_other_leg_unique_id_alone_is_not_a_b_leg():
    """`other_leg_unique_id` does NOT exist as a FreeSWITCH channel variable —
    `Other-Leg-Unique-ID` is assembled at event time (switch_caller.c:383-385
    via switch_channel.c:2749) and is an EVENT header only. It is accepted as
    an A-leg-uuid RESOLVER (if the telephony side sets it in Lua) but must
    NEVER on its own classify a body as a B-leg: a var FreeSWITCH never sets is
    a pure false-positive surface, and a false positive drops a billable row."""
    body = {"variables": {"uuid": "b", "direction": "outbound",
                          "other_leg_unique_id": "a-leg-uuid-7"}}
    assert so.b_leg_a_uuid(body) is None


def test_other_leg_unique_id_is_used_as_a_resolver_once_detection_fired():
    """Detection comes from the originator profile; the A-leg uuid may then be
    resolved from any of the resolver vars, including this one."""
    body = {"variables": {"uuid": "b", "other_leg_unique_id": "a-leg-uuid-7"},
            "callflow": [{"caller_profile": {
                "uuid": "b", "originator": {"originator_caller_profiles": []}}}]}
    assert so.b_leg_a_uuid(body) == "a-leg-uuid-7"


def test_outbound_direction_alone_is_an_a_leg():
    """API/ESL-originated first legs are direction=outbound A-legs: they carry
    no originator profile and no originating_leg_uuid -> must INSERT."""
    body = {"variables": {"uuid": "api-a-leg", "direction": "outbound",
                          "bridge_uuid": "the-second-leg"}}
    assert so.b_leg_a_uuid(body) is None


@pytest.mark.parametrize("var", ["signal_bond", "bridge_uuid"])
def test_bridge_partner_vars_never_classify_an_a_leg_as_b(var):
    """BILLING-CRITICAL. switch_ivr_bridge.c sets BOTH `bridge_uuid` (:1763 and
    :1766) and `signal_bond` (:1764 and :1767) on BOTH legs of every bridge, so
    either one used as a DETECTOR would classify every bridged RCF A-leg as a
    B-leg and silently drop its billable row. They are resolvers only."""
    body = {"variables": _a_leg_vars(**{var: "the-other-leg"})}
    assert so.b_leg_a_uuid(body) is None


def test_realistic_bridged_rcf_a_leg_is_inserted(cap):
    """The shape a real answered RCF CDR actually has — originatee profile,
    both bridge-partner vars, the mirrored last_bridge_* status — must still
    take the INSERT path."""
    body = {
        "core-uuid": "core-1",
        "switchname": "voiceplatform",
        "variables": _a_leg_vars(
            signal_bond="b-leg-uuid-1",
            bridge_uuid="b-leg-uuid-1",
            last_bridge_proto_specific_hangup_cause="sip:200",
            sip_hangup_disposition="send_bye",
            stir_outcome=OUTCOME,
        ),
        "callflow": [{"caller_profile": {
            "uuid": "a-leg-uuid-1",
            "originatee": {"originatee_caller_profiles": [{"uuid": "b-leg-uuid-1"}]},
        }}],
    }
    assert so.b_leg_a_uuid(body, own_uuid="a-leg-uuid-1") is None
    r = _run(body)
    assert r["status"] == "ok"
    assert len(cap.inserts) == 1 and not cap.updates
    _, p = cap.inserts[0]
    assert p[IDX_STIR_OUTCOME] == OUTCOME
    assert p[14] == 200          # $15 sip_code from last_bridge_*


def test_self_referential_b_leg_falls_back_to_insert(cap):
    """A channel cannot be its own originator. If the resolved A-leg uuid
    equals the body's own uuid the classification is incoherent, and the safe
    direction is to keep the billable row."""
    body = _b_leg_body(a_uuid="b-leg-uuid-1")   # originator uuid == own uuid
    assert so.b_leg_a_uuid(body, own_uuid="b-leg-uuid-1") is None
    r = _run(body)
    assert r["status"] == "ok"
    assert len(cap.inserts) == 1 and not cap.updates


def test_inbound_a_leg_with_originatee_is_not_a_b_leg():
    body = {"variables": _a_leg_vars(),
            "callflow": [{"caller_profile": {
                "uuid": "a-leg-uuid-1",
                "originatee": {"originatee_caller_profiles": [{"uuid": "b-leg-uuid-1"}]},
            }}]}
    assert so.b_leg_a_uuid(body) is None


def test_b_leg_with_unresolvable_a_uuid_returns_empty_string():
    body = {"callflow": [{"caller_profile": {"uuid": "b", "originator": {"originator_caller_profiles": []}}}],
            "variables": {"uuid": "b"}}
    assert so.b_leg_a_uuid(body) == ""


# ---------------------------------------------------------------------------
# Ingest — A-leg paths
# ---------------------------------------------------------------------------

def test_a_leg_with_stir_outcome_binds_raw_and_eff(cap):
    body = {"variables": _a_leg_vars(stir_outcome=OUTCOME)}
    r = _run(body)
    assert r["status"] == "ok"
    assert len(cap.inserts) == 1 and not cap.updates
    sql, p = cap.inserts[0]
    assert len(p) == PARAM_COUNT
    assert p[IDX_STIR_OUTCOME] == OUTCOME
    assert p[IDX_STIR_EFF_ACTUAL] == "div"
    assert "stir_outcome, stir_eff_actual" in sql
    assert "$56::text" in sql and "$57::text" in sql
    assert max(int(x) for x in re.findall(r"\$(\d+)", sql)) == PARAM_COUNT


def test_a_leg_with_auto_copied_response_header(cap):
    """mod_sofia copies sip_rh_* from the B-leg to the A-leg partner on any
    final response (sip_copy_custom_headers default) — accepted as-is."""
    body = {"variables": _a_leg_vars(**{"sip_rh_X-Stir-Outcome": "eff=A;mode=reorig;identities=1"})}
    r = _run(body)
    assert r["status"] == "ok"
    _, p = cap.inserts[0]
    assert p[IDX_STIR_OUTCOME] == "eff=A;mode=reorig;identities=1"
    assert p[IDX_STIR_EFF_ACTUAL] == "A"


def test_a_leg_without_stir_outcome_binds_null(cap):
    r = _run({"variables": _a_leg_vars()})
    assert r["status"] == "ok"
    _, p = cap.inserts[0]
    assert len(p) == PARAM_COUNT
    assert p[IDX_STIR_OUTCOME] is None
    assert p[IDX_STIR_EFF_ACTUAL] is None


def test_a_leg_malformed_outcome_keeps_raw_drops_eff(cap):
    r = _run({"variables": _a_leg_vars(stir_outcome="not-a-kv-string")})
    assert r["status"] == "ok"
    _, p = cap.inserts[0]
    assert p[IDX_STIR_OUTCOME] == "not-a-kv-string"
    assert p[IDX_STIR_EFF_ACTUAL] is None


def test_a_leg_intent_path_untouched_when_outcome_present(cap):
    """The intent-derived call_attestations UPSERT still runs alongside."""
    r = _run({"variables": _a_leg_vars(stir_outcome=OUTCOME,
                                        stir_attest_intent="div",
                                        stir_inbound_signed="1")})
    assert r["status"] == "ok"
    sqls = [s for s, _ in cap.calls]
    assert any("INSERT INTO call_attestations" in s for s in sqls)
    assert any("INSERT INTO cdrs" in s for s in sqls)


# ---------------------------------------------------------------------------
# Ingest — B-leg paths (never INSERT)
# ---------------------------------------------------------------------------

def test_b_leg_updates_a_leg_row_and_never_inserts(cap):
    r = _run(_b_leg_body())
    assert r["status"] == "b_leg"
    assert r["detail"] == "updated"
    assert r["a_leg_uuid"] == "a-leg-uuid-1"
    assert r["stir_eff_actual"] == "div"
    assert not cap.inserts
    assert len(cap.updates) == 1
    sql, p = cap.updates[0]
    assert "UPDATE cdrs" in sql
    assert "stir_outcome" in sql and "stir_eff_actual" in sql
    assert "$1::varchar" in sql and "$2::text" in sql and "$3::text" in sql
    assert p == ("a-leg-uuid-1", OUTCOME, "div")
    # no call_attestations write from a B-leg
    assert not any("call_attestations" in s for s, _ in cap.calls)


def test_b_leg_without_a_leg_row_is_retry_free_noop(cap, caplog):
    cap.update_result = "UPDATE 0"
    with caplog.at_level("INFO"):
        r = _run(_b_leg_body())
    assert r["status"] == "b_leg"
    assert r["detail"] == "a-leg row not found"
    assert len(cap.updates) == 1          # exactly one attempt, no retry
    assert not cap.inserts
    assert any("not present yet" in m for m in caplog.messages)


def test_b_leg_without_outcome_is_noop(cap):
    body = _b_leg_body()
    del body["variables"]["sip_rh_X-Stir-Outcome"]
    r = _run(body)
    assert r["status"] == "b_leg" and r["detail"] == "no stir_outcome"
    assert not cap.calls


def test_b_leg_unresolvable_a_uuid_is_noop(cap):
    body = _b_leg_body()
    body["callflow"][0]["caller_profile"]["originator"] = {"originator_caller_profiles": []}
    del body["variables"]["originating_leg_uuid"]
    r = _run(body)
    assert r["status"] == "b_leg" and r["detail"] == "unresolved A-leg uuid"
    assert not cap.calls


def test_b_leg_db_failure_is_swallowed(cap):
    cap.raise_on_update = True
    r = _run(_b_leg_body())
    assert r["status"] == "b_leg" and r["detail"] == "update failed"
    assert not cap.inserts


def test_b_leg_explicit_stir_outcome_var_also_accepted(cap):
    body = _b_leg_body()
    del body["variables"]["sip_rh_X-Stir-Outcome"]
    body["variables"]["stir_outcome"] = "eff=unsigned;mode=base;identities=0"
    r = _run(body)
    assert r["detail"] == "updated" and r["stir_eff_actual"] == "unsigned"


def test_bulk_tallies_b_legs_separately(monkeypatch):
    """/ingest/bulk counts B-legs in their own bucket, never as errors."""
    c = _Capture()
    monkeypatch.setattr(db, "execute", c.execute)

    class _Req:
        async def json(self):
            return [{"variables": _a_leg_vars(stir_outcome=OUTCOME)}, _b_leg_body()]

    res = asyncio.run(cdrs.ingest_cdr_bulk(_Req()))
    assert res["ok"] == 1 and res["b_leg"] == 1 and res["error"] == 0
    assert res["failed"] == []


# ---------------------------------------------------------------------------
# sip_code precedence
# ---------------------------------------------------------------------------

def test_sip_code_prefers_sip_term_status():
    assert cdrs._derive_sip_code({"sip_term_status": "487",
                                  "proto_specific_hangup_cause": "sip:200"}, answered=True) == 487


def test_sip_code_proto_specific_then_last_bridge():
    assert cdrs._derive_sip_code({"proto_specific_hangup_cause": "sip:486"}, answered=False) == 486
    assert cdrs._derive_sip_code({"last_bridge_proto_specific_hangup_cause": "sip:503"}, answered=False) == 503
    # A-leg carries neither; the B-leg (callee) hung up first -> mirrored 200
    assert cdrs._derive_sip_code({"last_bridge_proto_specific_hangup_cause": "sip:200",
                                  "sip_hangup_disposition": "send_bye"}, answered=True) == 200


def test_sip_code_answered_call_with_no_status_records_200():
    """The production symptom: answered, FS sent the BYE, no sip_term_status."""
    assert cdrs._derive_sip_code({"sip_hangup_disposition": "send_bye",
                                  "hangup_cause": "NORMAL_CLEARING"}, answered=True) == 200
    # answered beats a stale invite-failure status
    assert cdrs._derive_sip_code({"sip_invite_failure_status": "503"}, answered=True) == 200


def test_sip_code_unanswered_failure_and_none():
    assert cdrs._derive_sip_code({"sip_invite_failure_status": "503"}, answered=False) == 503
    assert cdrs._derive_sip_code({}, answered=False) is None
    assert cdrs._derive_sip_code({"proto_specific_hangup_cause": "q850:16"}, answered=False) is None


def test_ingest_binds_sip_code_200_for_answered_send_bye(cap):
    body = {"variables": _a_leg_vars(sip_hangup_disposition="send_bye")}
    _run(body)
    _, p = cap.inserts[0]
    assert p[14] == 200          # $15 sip_code


def test_ingest_binds_sip_code_null_for_unanswered_no_status(cap):
    body = {"variables": _a_leg_vars(answer_epoch="0", billsec="0")}
    _run(body)
    _, p = cap.inserts[0]
    assert p[9] is None          # $10 answer_time
    assert p[14] is None         # $15 sip_code


# ---------------------------------------------------------------------------
# freeswitch_node derivation
# ---------------------------------------------------------------------------

def test_fs_node_prefers_explicit_var():
    assert cdrs._derive_fs_node({"switchname": "voiceplatform"},
                                {"fs_node": "west-fs-2", "sip_local_network_addr": "192.168.10.2"}) == "west-fs-2"
    assert cdrs._derive_fs_node({}, {"fs_zone": "central"}) == "central"


def test_fs_node_ignores_shared_default_switchname_then_uses_media_ip():
    assert cdrs._derive_fs_node({"switchname": "voiceplatform"},
                                {"sip_local_network_addr": "192.168.20.2"}) == "west-fs"
    assert cdrs._derive_fs_node({"switchname": "voiceplatform"},
                                {"local_media_ip": "192.168.30.3"}) == "central-fs"
    assert cdrs._derive_fs_node({}, {"advertised_media_ip": "192.168.10.2"}) == "east-fs"


def test_fs_node_uses_distinct_switchname_and_core_uuid_fallbacks():
    assert cdrs._derive_fs_node({"switchname": "west-fs"}, {}) == "west-fs"
    assert cdrs._derive_fs_node({"switchname": "voiceplatform", "core-uuid": "abc"}, {}) == "abc"
    assert cdrs._derive_fs_node({}, {}) is None
    # the old (never-present) event header name is NOT consulted
    assert cdrs._derive_fs_node({}, {"FreeSWITCH-Hostname": "fs-media-v2"}) is None


def test_ingest_binds_freeswitch_node(cap):
    body = {"switchname": "voiceplatform",
            "variables": _a_leg_vars(sip_local_network_addr="192.168.10.2")}
    _run(body)
    _, p = cap.inserts[0]
    assert p[17] == "east-fs"    # $18 freeswitch_node
