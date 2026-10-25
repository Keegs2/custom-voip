"""Visual IVR compiler (services/ivr/compiler.py) — golden fixtures + the review fixes.

Golden fixtures: ``tests/fixtures/ivr/<name>.graph.json`` (contract §2) compile
against ``tests/fixtures/ivr/context.json`` to EXACTLY
``tests/fixtures/ivr/<name>.plan.json`` (contract §3). P2's Lua engine harness
consumes the same plan files. Regenerate (then REVIEW the diff by hand) with
``IVR_REGEN_GOLDEN=1 JWT_SECRET_KEY=x python -m pytest tests/test_ivr_compiler.py``.

The review of the unified branch's ``flow/compile/ivr.ts`` found: reversed
prompt order, silently dropped loops, edges of deleted digits still routing,
a deletable Start, unvalidated dial targets and empty prompts passing — each
has a test below.
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from services.ivr import compiler  # noqa: E402
from services.ivr.compiler import (  # noqa: E402
    CompileContext, OwnNumber, PromptRef, compile_flow,
)

FIXTURES = REPO / "tests" / "fixtures" / "ivr"
NAMES = sorted(p.name[:-len(".graph.json")] for p in FIXTURES.glob("*.graph.json"))
EXPECT = json.loads((FIXTURES / "expectations.json").read_text())


def load_context() -> CompileContext:
    c = json.loads((FIXTURES / "context.json").read_text())
    return CompileContext(
        customer_id=c["customer_id"], flow_id=c["flow_id"], version=c["version"],
        prompts={int(k): PromptRef(v["sha256"], v["name"]) for k, v in c["prompts"].items()},
        numbers={n["did"]: OwnNumber(n["did"], n["product"], n["name"], n["enabled"])
                 for n in c["numbers"]},
        self_dids=frozenset(c["self_dids"]))


CTX = load_context()


def graph(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.graph.json").read_text())


def codes(issues) -> list[str]:
    return [i.code for i in issues]


# ---------------------------------------------------------------------------
# Golden fixtures
# ---------------------------------------------------------------------------
def test_there_are_at_least_ten_fixtures_covering_every_block_type():
    assert len(NAMES) >= 10
    types = {n["type"] for name in NAMES for n in graph(name)["nodes"]}
    assert types == set(compiler.NODE_TYPES)
    assert set(NAMES) <= set(EXPECT)


@pytest.mark.parametrize("name", NAMES)
def test_golden_plan(name):
    result = compile_flow(graph(name), CTX)
    assert result.ok, [e.as_dict() for e in result.errors]
    plan_path = FIXTURES / f"{name}.plan.json"
    if os.getenv("IVR_REGEN_GOLDEN") == "1":
        plan_path.write_text(json.dumps(result.plan, indent=2) + "\n")
    assert result.plan == json.loads(plan_path.read_text())
    assert [[w.code, w.node_id, w.handle] for w in result.warnings] == EXPECT[name]["warnings"]


@pytest.mark.parametrize("name", NAMES)
def test_golden_plan_contract_invariants(name):
    """Contract §3: ids, digits, shas, E.164, pointers, prompt prefetch list."""
    plan = json.loads((FIXTURES / f"{name}.plan.json").read_text())
    assert plan["v"] == 1 and plan["compiler"] == "ivr-1"
    assert plan["limits"] == {"max_steps": 200, "max_seconds": 1800}
    nodes = plan["nodes"]
    assert plan["start"] in nodes
    used: list[str] = []
    for node_id, node in nodes.items():
        assert compiler.ID_RE.match(node_id)
        assert node["t"] in ("play", "menu", "hours", "caller", "transfer", "voicemail", "hangup")
        for p in compiler.pointers(node):
            assert p is None or p in nodes
        for key in ("prompts", "invalid_prompts", "noinput_prompts"):
            for sha in node.get(key, []):
                assert compiler.SHA_RE.match(sha)
                used.append(sha)
        if node["t"] == "menu":
            assert all(compiler.DIGIT_RE.match(d) for d in node["digits"])
        if node["t"] == "transfer":
            num = node["dest"].get("e164") or node["dest"]["did"]
            assert re.match(r"^\+1[2-9]\d{2}[2-9]\d{6}$", num)
        if node["t"] == "voicemail":
            assert re.match(r"^\+1[2-9]\d{2}[2-9]\d{6}$", node["did"])
    assert sorted(set(used)) == sorted(plan["prompts"])
    assert len(plan["prompts"]) == len(set(plan["prompts"]))


@pytest.mark.parametrize("name", NAMES)
def test_no_customer_free_text_in_plan(name):
    g = graph(name)
    text = json.dumps(compile_flow(g, CTX).plan)
    labels = {n["data"]["label"] for n in g["nodes"]}
    names = {p.name for p in CTX.prompts.values()} | {n.name for n in CTX.numbers.values() if n.name}
    for s in labels | names:
        assert s not in text, s


def test_compile_is_deterministic_and_does_not_mutate_the_graph():
    g = graph("all_blocks_defaults")
    before = copy.deepcopy(g)
    a = compile_flow(g, CTX).plan
    b = compile_flow(g, CTX).plan
    assert a == b and json.dumps(a) == json.dumps(b)
    assert g == before


# ---------------------------------------------------------------------------
# Review fixes
# ---------------------------------------------------------------------------
def test_fix_prompt_order_is_kept():
    plan = compile_flow(graph("play_then_hangup"), CTX).plan
    p = CTX.prompts
    assert plan["nodes"]["n_play"]["prompts"] == [p[101].sha256, p[108].sha256, p[109].sha256]
    menu = json.loads((FIXTURES / "menu_pruned_edges.plan.json").read_text())["nodes"]["n_menu"]
    assert menu["prompts"] == [p[102].sha256, p[101].sha256]


def test_fix_goto_loop_compiles_to_a_back_pointer():
    plan = compile_flow(graph("menu_repeat_goto"), CTX).plan
    assert plan["nodes"]["n_menu"]["digits"]["9"] == "n_menu"
    assert "n_repeat" not in plan["nodes"]          # goto is compiled away


def test_fix_deleted_digit_edge_is_pruned_and_never_routes():
    result = compile_flow(graph("menu_pruned_edges"), CTX)
    menu = result.plan["nodes"]["n_menu"]
    assert set(menu["digits"]) == {"1", "0"}
    assert "n_three" not in result.plan["nodes"]       # the pruned edge's 900 target
    assert ("connection_pruned", "n_menu", "d:3") in [(w.code, w.node_id, w.handle)
                                                       for w in result.warnings]


def test_fix_start_cannot_be_deleted_or_duplicated_or_targeted():
    g = graph("voicemail_direct")
    no_start = {**g, "nodes": [n for n in g["nodes"] if n["type"] != "entry"]}
    assert codes(compile_flow(no_start, CTX).errors) == ["start_missing"]
    assert codes(compiler.check_graph_shape(no_start)) == ["start_missing"]
    two = {**g, "nodes": g["nodes"] + [{"id": "n_s2", "type": "entry", "data": {"config": {}}}]}
    assert "start_duplicate" in codes(compiler.check_graph_shape(two))
    back = copy.deepcopy(g)
    back["edges"].append({"id": "e_b", "source": "n_msg", "sourceHandle": "next",
                          "target": "n_start"})
    back["edges"] = [e for e in back["edges"] if e["target"] != "n_vm"] + [back["edges"][-1]]
    assert "connection_to_start" in codes(compile_flow(back, CTX).errors)


def test_fix_unconnected_start_is_an_error():
    g = graph("voicemail_direct")
    g["edges"] = [e for e in g["edges"] if e["source"] != "n_start"]
    r = compile_flow(g, CTX)
    assert ("start_unconnected", "n_start", "next") in [(e.code, e.node_id, e.handle)
                                                         for e in r.errors]


def _dial_graph(target, **cfg) -> dict:
    return {"schemaVersion": 1, "nodes": [
        {"id": "n_start", "type": "entry", "data": {"config": {}}},
        {"id": "n_x", "type": "dial", "data": {"config": {"target": target, **cfg}}}],
        "edges": [{"id": "e1", "source": "n_start", "sourceHandle": "next", "target": "n_x"}]}


@pytest.mark.parametrize("target,code", [
    ({"kind": "external", "number": "+14165550123"}, "not_us"),            # Toronto
    ({"kind": "external", "number": "+18765550123"}, "not_us"),            # Jamaica
    ({"kind": "external", "number": "+19005550123"}, "premium"),
    ({"kind": "external", "number": "+442071234567"}, "not_us"),
    ({"kind": "external", "number": "+16174115555"}, "special_number"),     # N11 exchange
    ({"kind": "external", "number": ""}, "number_required"),
    ({"kind": "own", "did": "+16175550888"}, "not_own_number"),             # not theirs
    ({"kind": "own", "did": "+16175550501"}, "not_own_number"),             # api (retired)
    ({"kind": "own", "did": "+16175550999"}, "self_transfer"),
    ({"kind": "sip", "uri": "sip:evil@example.com"}, "transfer_target_required"),
    (None, "transfer_target_required"),
])
def test_fix_dial_targets_are_validated(target, code):
    r = compile_flow(_dial_graph(target), CTX)
    assert not r.ok
    assert code in codes(r.errors)


def test_dial_caller_id_is_boolean_only_and_ring_bounded():
    t = {"kind": "own", "did": "+16175550101"}
    assert "transfer_caller_id_invalid" in codes(compile_flow(
        _dial_graph(t, passCallerId="+15555550100"), CTX).errors)
    assert "transfer_ring_invalid" in codes(compile_flow(
        _dial_graph(t, ringTimeoutSec=4), CTX).errors)
    assert "transfer_ring_invalid" in codes(compile_flow(
        _dial_graph(t, ringTimeoutSec=121), CTX).errors)
    # an extra "callerId" key is simply ignored — it never reaches the plan
    plan = compile_flow(_dial_graph(t, callerId="+19005550123"), CTX).plan
    assert "callerId" not in json.dumps(plan) and "+19005550123" not in json.dumps(plan)


def test_dial_to_a_disabled_own_number_is_a_warning():
    r = compile_flow(_dial_graph({"kind": "own", "did": "+16175550102"}), CTX)
    assert r.ok and "transfer_target_off" in codes(r.warnings)


def _play_graph(prompts) -> dict:
    return {"schemaVersion": 1, "nodes": [
        {"id": "n_start", "type": "entry", "data": {"config": {}}},
        {"id": "n_p", "type": "play", "data": {"config": {"prompts": prompts}}}],
        "edges": [{"id": "e1", "source": "n_start", "sourceHandle": "next", "target": "n_p"}]}


@pytest.mark.parametrize("prompts,code", [
    ([], "prompts_required"),
    (None, "prompts_required"),
    ([999], "prompt_missing"),                 # not the customer's / deleted
    (["abc"], "prompt_missing"),
    ([101] * 11, "prompts_too_many"),
    ("101", "prompts_invalid"),
])
def test_fix_empty_or_unknown_prompts_fail(prompts, code):
    assert code in codes(compile_flow(_play_graph(prompts), CTX).errors)


def test_menu_validation():
    g = graph("menu_repeat_goto")
    menu = next(n for n in g["nodes"] if n["id"] == "n_menu")
    for bad, code in [({"digits": []}, "menu_digits_required"),
                      ({"digits": ["1", "1"]}, "menu_digits_invalid"),
                      ({"digits": ["A"]}, "menu_digits_invalid"),
                      ({"timeoutSec": 0}, "menu_timeout_invalid"),
                      ({"timeoutSec": 31}, "menu_timeout_invalid"),
                      ({"retries": 6}, "menu_retries_invalid"),
                      ({"retries": True}, "menu_retries_invalid")]:
        g2 = copy.deepcopy(g)
        m2 = next(n for n in g2["nodes"] if n["id"] == "n_menu")
        m2["data"]["config"].update(bad)
        assert code in codes(compile_flow(g2, CTX).errors), bad
    assert menu["data"]["config"]["digits"] == ["1", "2", "9"]


def test_menu_with_no_connected_key_is_an_error():
    g = graph("menu_repeat_goto")
    g["edges"] = [e for e in g["edges"] if not e["sourceHandle"].startswith("d:")]
    assert "menu_unconnected" in codes(compile_flow(g, CTX).errors)


def test_schedule_validation():
    base = graph("hours_dst_closed_dates")
    for bad, code in [({"tz": "Europe/London"}, "schedule_timezone_invalid"),
                      ({"weekly": {"mon": [["17:00", "09:00"]]}}, "schedule_hours_invalid"),
                      ({"weekly": {"mon": [["9:00", "17:00"]]}}, "schedule_hours_invalid"),
                      ({"weekly": {"monday": [["09:00", "17:00"]]}}, "schedule_hours_invalid"),
                      ({"weekly": {"mon": [["09:00", "10:00"]] * 5}}, "schedule_hours_invalid"),
                      ({"weekly": {"mon": [["24:00", "24:00"]]}}, "schedule_hours_invalid"),
                      ({"closedDates": ["2026-02-30"]}, "schedule_dates_invalid"),
                      ({"closedDates": "2026-12-25"}, "schedule_dates_invalid")]:
        g = copy.deepcopy(base)
        next(n for n in g["nodes"] if n["id"] == "n_hours")["data"]["config"].update(bad)
        assert code in codes(compile_flow(g, CTX).errors), bad
    g = copy.deepcopy(base)
    next(n for n in g["nodes"] if n["id"] == "n_hours")["data"]["config"]["weekly"] = {}
    r = compile_flow(g, CTX)
    assert r.ok and "schedule_never_open" in codes(r.warnings)


def test_every_pinned_timezone_compiles():
    for tz in compiler.TIMEZONES:
        g = graph("hours_dst_closed_dates")
        next(n for n in g["nodes"] if n["id"] == "n_hours")["data"]["config"]["tz"] = tz
        assert compile_flow(g, CTX).plan["nodes"]["n_hours"]["tz"] == tz


def test_condition_validation():
    base = graph("caller_modes")
    for nid, bad, code in [("n_vip", {"values": []}, "caller_values_required"),
                           ("n_vip", {"values": ["not a number"]}, "caller_value_invalid"),
                           ("n_local", {"values": ["617"]}, "caller_value_invalid"),
                           ("n_local", {"values": ["+1617"] * 51}, "caller_values_invalid"),
                           ("n_vip", {"mode": "regex"}, "caller_mode_invalid")]:
        g = copy.deepcopy(base)
        next(n for n in g["nodes"] if n["id"] == nid)["data"]["config"].update(bad)
        assert code in codes(compile_flow(g, CTX).errors), bad
    g = copy.deepcopy(base)
    next(n for n in g["nodes"] if n["id"] == "n_anon")["data"]["config"]["values"] = ["+1"]
    r = compile_flow(g, CTX)
    assert r.ok and "caller_values_ignored" in codes(r.warnings)
    assert r.plan["nodes"]["n_anon"]["values"] == []


def test_voicemail_must_be_one_of_the_customers_boxes():
    g = graph("voicemail_direct")
    vm = next(n for n in g["nodes"] if n["id"] == "n_vm")
    for did in ("+16175550101", "+16175550888", "", None):   # an rcf DID, foreign, empty
        vm["data"]["config"]["did"] = did
        assert "voicemail_missing" in codes(compile_flow(g, CTX).errors), did
    vm["data"]["config"]["did"] = "+16175550202"              # theirs, but switched off
    r = compile_flow(g, CTX)
    assert r.ok and "voicemail_off" in codes(r.warnings)


def test_goto_validation():
    g = graph("goto_chain_and_restart")
    g1 = copy.deepcopy(g)
    next(n for n in g1["nodes"] if n["id"] == "n_g2")["data"]["config"]["targetNodeId"] = "n_g1"
    assert "goto_loop" in codes(compile_flow(g1, CTX).errors)
    g2 = copy.deepcopy(g)
    next(n for n in g2["nodes"] if n["id"] == "n_g1")["data"]["config"]["targetNodeId"] = "n_gone"
    assert "goto_target_missing" in codes(compile_flow(g2, CTX).errors)
    g3 = copy.deepcopy(g)
    next(n for n in g3["nodes"] if n["id"] == "n_g1")["data"]["config"]["targetNodeId"] = "n_g1"
    assert "goto_loop" in codes(compile_flow(g3, CTX).errors)


def test_silent_loop_is_an_error():
    g = graph("caller_modes")
    for e in g["edges"]:
        if e["source"] == "n_anon" and e["sourceHandle"] == "noMatch":
            e["target"] = "n_vip"                 # caller checks spinning forever
    r = compile_flow(g, CTX)
    assert "loop_silent" in codes(r.errors)


def test_duplicate_edges_and_dangling_edges():
    g = graph("voicemail_direct")
    g2 = copy.deepcopy(g)
    g2["edges"].append({"id": "e_dup", "source": "n_msg", "sourceHandle": "next",
                        "target": "n_msg"})
    assert "connection_duplicate" in codes(compile_flow(g2, CTX).errors)
    g3 = copy.deepcopy(g)
    g3["edges"].append({"id": "e_d", "source": "n_deleted", "sourceHandle": "next",
                        "target": "n_vm"})
    r = compile_flow(g3, CTX)
    assert r.ok and "connection_dangling" in codes(r.warnings)


def test_shape_limits_and_ids():
    many = {"schemaVersion": 1, "nodes": [{"id": "n_start", "type": "entry"}] + [
        {"id": f"n_{i}", "type": "hangup"} for i in range(200)], "edges": []}
    assert "too_many_blocks" in codes(compiler.check_graph_shape(many))
    bad_id = {"schemaVersion": 1, "nodes": [{"id": "n_start", "type": "entry"},
                                             {"id": "${evil}", "type": "play"}], "edges": []}
    assert "block_id_invalid" in codes(compiler.check_graph_shape(bad_id))
    dup = {"schemaVersion": 1, "nodes": [{"id": "n_start", "type": "entry"},
                                          {"id": "n_start", "type": "play"}], "edges": []}
    assert "block_id_duplicate" in codes(compiler.check_graph_shape(dup))
    assert codes(compiler.check_graph_shape({"schemaVersion": 2, "nodes": [], "edges": []}))[0] \
        == "graph_version"
    assert codes(compiler.check_graph_shape([])) == ["graph_invalid"]


def test_unknown_block_type_is_rejected_when_reachable():
    g = _play_graph([101])
    g["nodes"][1]["type"] = "webhook"
    g["nodes"][1]["data"]["config"] = {"url": "http://169.254.169.254/"}
    r = compile_flow(g, CTX)
    assert "block_unknown" in codes(r.errors) and r.plan is None


def test_default_graph_is_just_start_and_fails_compile_until_connected():
    g = compiler.default_graph()
    assert compiler.check_graph_shape(g) == []
    assert codes(compile_flow(g, CTX).errors) == ["start_unconnected"]


def test_issue_shape():
    i = compiler.Issue("c", "m", "n_x", "d:1")
    assert i.as_dict() == {"code": "c", "message": "m", "node_id": "n_x", "handle": "d:1"}
    assert compiler.Issue("c", "m").as_dict() == {"code": "c", "message": "m"}


def test_plan_summary_has_no_free_text():
    plan = compile_flow(graph("all_blocks_defaults"), CTX).plan
    s = compiler.plan_summary(plan)
    assert s["blocks"] == len(plan["nodes"])
    assert s["destinations"] == ["+18002345678", "+16175550401", "+16175550201"]
    assert s["by_type"]["transfer"] == 2
