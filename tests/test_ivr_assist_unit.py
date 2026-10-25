"""Flow assistant, CRAG side — pure units (no DB, no network).

Covers (contract docs/IVR_ASSIST_INTERFACES.md): the schema copies are
byte-identical to docs/ivr_assist/ and the evaluator is strict; the wire
encoding round trip (§1); number detection and alias tokens (§4.1); draft <->
alias graph conversion (§4); de-aliased rendering (§4.1 / §5.2); the
propose / repair loop (§5.1: at most 2 repairs, issues returned instead of
failing); the TED client's status mapping (§1.1) and that the token never
reaches a log line or an error; config parsing.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path

import httpx
import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import ivr_assist_fake_ted as fake  # noqa: E402
from services.ivr import compiler  # noqa: E402
from services.ivr.assist import aliases, config, pipeline, schema, ted_client  # noqa: E402
from services.ivr.assist import graph as ag  # noqa: E402
from services.ivr.assist.aliases import AliasBook, PromptInfo  # noqa: E402
from services.ivr.compiler import CompileContext, OwnNumber, PromptRef  # noqa: E402

DOCS = REPO / "docs" / "ivr_assist"

BILL, OUTAGE, FRONT, MAILBOX, SELF = ("+16175550101", "+16175550102", "+16175550103",
                                      "+16175550104", "+16175550106")
NUMBERS = [OwnNumber(BILL, "rcf", "Billing line"), OwnNumber(OUTAGE, "rcf", "Outage desk"),
           OwnNumber(FRONT, "rcf", None), OwnNumber(MAILBOX, "voicemail", "Front desk mailbox"),
           OwnNumber(SELF, "ivr", "Main line")]
PROMPTS = [PromptInfo(7, "Main greeting", "Thanks for calling Acme Power."),
           PromptInfo(9, "Holiday notice", None)]


def book(external=()):
    return AliasBook(NUMBERS, {SELF}, PROMPTS, external)


def ctx() -> CompileContext:
    return CompileContext(
        customer_id=11, flow_id=1, version=1,
        prompts={p.id: PromptRef(f"{p.id:064x}", p.name) for p in PROMPTS},
        numbers={n.did: n for n in NUMBERS}, self_dids=frozenset({SELF}))


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def ted(monkeypatch):
    fake.configure_env(monkeypatch)
    t = fake.FakeTed()
    monkeypatch.setattr(ted_client, "TRANSPORT", t.transport())
    return t


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("name", sorted(schema.SCHEMA_FILES.values()))
def test_schema_copies_are_byte_identical_to_the_contract(name):
    assert (schema.SCHEMA_DIR / name).read_bytes() == (DOCS / name).read_bytes()


def test_schema_dir_holds_exactly_the_contract_files():
    assert sorted(p.name for p in schema.SCHEMA_DIR.glob("*.json")) == \
        sorted(p.name for p in DOCS.glob("*.json"))


def test_every_schema_loads_with_only_supported_keywords():
    for name in schema.SCHEMA_FILES:
        assert schema.validator(name).root["$schema"].endswith("2020-12/schema")


def test_unsupported_keyword_is_refused():
    with pytest.raises(schema.SchemaError, match="unsupported"):
        schema.Validator({"type": "object", "properties": {"a": {"format": "uuid"}}})
    with pytest.raises(schema.SchemaError):
        schema.Validator({"$ref": "#/elsewhere"})


def test_ecma_dollar_and_digit_semantics():
    v = schema.Validator({"type": "string", "pattern": "^D[1-9][0-9]{0,2}$"})
    assert v.is_valid("D12")
    assert not v.is_valid("D12\n")              # Python's $ would accept this
    assert not v.is_valid("D1٣")            # Arabic-Indic digit is not \d in ECMA
    w = schema.Validator({"type": "string", "pattern": "^[0-9]{2}$"})
    assert not w.is_valid("12\n")


def test_type_rules_bool_is_not_integer_and_json_equality():
    v = schema.Validator({"type": "integer", "minimum": 1})
    assert v.is_valid(3) and v.is_valid(3.0)
    assert not v.is_valid(True) and not v.is_valid(0) and not v.is_valid(2.5)
    c = schema.Validator({"const": 1})
    assert not c.is_valid(True) and c.is_valid(1)
    u = schema.Validator({"type": "array", "uniqueItems": True})
    assert u.is_valid([1, True]) and not u.is_valid(["a", "a"])


def _contract_request() -> dict:
    return {
        "v": 1, "request_id": "6f1c2a7e-0b3d-4c5e-8f9a-1b2c3d4e5f60",
        "conversation_id": "a93e2b1c-4d5e-4f60-9a1b-2c3d4e5f6071", "round": "propose",
        "message": "Weekdays 8 to 5 Eastern. Press 1 for billing [D1].",
        "history": [{"role": "customer", "text": "hi"}, {"role": "assistant", "text": "ok"}],
        "base": None, "base_new_prompts": [],
        "destinations": [{"alias": "D1", "product": "rcf", "label": "Billing line",
                          "enabled": True, "this_flow": False}],
        "prompts": [{"alias": "P1", "name": "Main greeting", "text": None}],
        "external_numbers": ["N1"], "repair": None,
        "limits": {"max_nodes": 60, "max_new_prompts": 20, "max_prompt_chars": 1000}}


def test_request_schema_accepts_the_contract_example_and_rejects_drift():
    req = _contract_request()
    assert schema.request_errors(req) == []
    for mutate in (lambda r: r.update(extra=1), lambda r: r.update(round="final"),
                   lambda r: r.update(message=""),
                   lambda r: r.update(request_id="6f1c2a7e-0b3d-1c5e-8f9a-1b2c3d4e5f60"),
                   lambda r: r["destinations"][0].update(alias="X1"),
                   lambda r: r.update(external_numbers=["N1", "N1"]),
                   lambda r: r.update(repair={"issues": []}),
                   lambda r: r.update(base={"nodes": [], "edges": []})):
        bad = json.loads(json.dumps(req))
        mutate(bad)
        assert schema.request_errors(bad), bad


def test_response_schema_and_graph_validation():
    payload = _contract_request()
    good = fake.envelope(payload, fake.scripted_result(payload))
    assert schema.response_errors(good) == []
    bad = json.loads(json.dumps(good))
    bad["result"]["graph"]["nodes"][1]["config"]["prompts"] = ["Q1"]
    assert schema.response_errors(bad)[0].startswith("graph:")
    both = json.loads(json.dumps(good))
    both["result"]["question"] = "?"
    assert schema.response_errors(both)                    # oneOf: extra key -> no shape


# ---------------------------------------------------------------------------
# Wire encoding (§1)
# ---------------------------------------------------------------------------
def test_payload_round_trip_base64url_without_padding():
    payload = {"message": "press 1 or 2 <script> \"drop\" éè ☃ \U0001f600",
               "n": [1, None, True]}
    for extra in ("", "a", "ab"):              # all padding lengths
        p = dict(payload, pad=extra)
        enc = ted_client.encode_payload(p)
        assert "=" not in enc and "+" not in enc and "/" not in enc
        assert ted_client.decode_payload(enc) == p
    body = json.loads(ted_client.request_body(payload))
    assert set(body) == {"v", "payload_b64"} and body["v"] == 1


# ---------------------------------------------------------------------------
# Number detection + aliases (§4.1)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("text", [
    "+1 617 555 0101", "(617) 555-0101", "617.555.0101", "16175550101", "6175550101",
    "+16175550101", "1-617-555-0101", "+1 (617) 555-0101", "617-555-0101", "x617-555-0101y"])
def test_every_common_form_of_an_own_number_becomes_its_d_alias(text):
    out = book().alias_text(f"ring {text} now")
    assert "[D1]" in out and not re.search(r"\d{3}", out), out


def test_other_numbers_get_stable_n_aliases_capped_at_20():
    b = book()
    first = b.alias_text("call (508) 555-2199 or 774-404-5256, then (508) 555-2199 again")
    assert first == "call [N1] or [N2], then [N1] again"
    many = " ".join(f"508-555-{3000 + i}" for i in range(25))
    out = b.alias_text(many).split()
    assert out[:18] == [f"[N{i}]" for i in range(3, 21)]
    assert "[number removed]" in " ".join(out[18:])
    assert len(b.external) == 20
    # stable across a new book for the same conversation
    again = AliasBook(NUMBERS, {SELF}, PROMPTS, b.external)
    assert again.alias_text("(508) 555-2199") == "[N1]"


def test_other_digit_runs_and_international_numbers_are_removed():
    b = book()
    assert b.alias_text("account 12345678 ok") == "account [number removed] ok"
    assert b.alias_text("UK +44 20 7946 0958.") == "UK [number removed]."
    assert b.alias_text("local 555-2199") == "local 555-2199"          # 7 digits, separated
    assert b.alias_text("local 5552199") == "local [number removed]"


def test_text_that_is_not_a_number_is_untouched():
    b = book()
    for text in ("Closed 2026-12-25 and 12/25/2026.", "Weekdays 8:00-17:00, 9 to 5.",
                 "press 1, 2 or 0", "up to 1000 characters", "if the caller is from +1617",
                 "[D1] and [N2] stay as they are"):
        assert b.alias_text(text) == text


def test_a_bare_one_before_an_unformatted_number_is_kept():
    assert book().alias_text("press 1 6175550101 then") == "press 1 [D1] then"
    assert book().alias_text("call 1 617 555 0101") == "call [D1]"


def test_destinations_order_labels_and_this_flow():
    dests = book().request_destinations()
    assert [(d["alias"], d["product"], d["label"]) for d in dests] == [
        ("D1", "rcf", "Billing line"), ("D2", "rcf", "Outage desk"),
        ("D3", "rcf", "Forwarding number 3"), ("D4", "voicemail", "Front desk mailbox"),
        ("D5", "ivr", "Main line")]
    assert [d["this_flow"] for d in dests] == [False, False, False, False, True]
    named = AliasBook([OwnNumber(BILL, "rcf", "Line 617-555-0102 backup"),
                       OwnNumber(OUTAGE, "rcf", "Outage")], (), ())
    assert named.request_destinations()[0]["label"] == "Line [D2] backup"


def test_prompts_are_aliased_and_audio_prompts_have_no_text():
    b = AliasBook(NUMBERS, (), [PromptInfo(3, "Call 617-555-0102", "Dial 508 555 2199 now"),
                                PromptInfo(1, "Upload", None)])
    assert b.request_prompts() == [
        {"alias": "P1", "name": "Upload", "text": None},
        {"alias": "P2", "name": "Call [D2]", "text": "Dial [N1] now"}]


def test_more_than_200_own_numbers_are_never_sent_or_treated_as_outside():
    many = [OwnNumber(f"+1617555{i:04d}", "rcf", None) for i in range(205)]
    b = AliasBook(many, (), ())
    assert len(b.request_destinations()) == 200
    assert b.alias_text("+16175550204") == "[number removed]"
    assert b.n_alias("+16175550204") is None


def test_render_and_spoken():
    b = book(["+15085552199"])
    text = "1 goes to [D1], 2 to [N1], then [P1] and [NP2]; [D9] [N4] [P8] [NP9]."
    assert b.render(text, {"NP2": "Main menu"}) == (
        "1 goes to Billing line (617-555-0101), 2 to 508-555-2199, then “Main greeting” "
        "and “Main menu”; one of your numbers an outside number a message a new message.")
    assert b.render("[D3]") == "Forwarding number 3 (617-555-0103)"
    assert b.spoken("Call [D1] or [N1]. [P1] [number removed] Bye .") == \
        "Call 617-555-0101 or 508-555-2199. Bye."
    assert b.render("bad\x00text") == "bad text"


def test_clip_never_cuts_a_token_in_half():
    assert aliases.clip("abc [D12]", 7) == "abc"
    assert aliases.clip("abc [D12]", 9) == "abc [D12]"


# ---------------------------------------------------------------------------
# Graph conversion (§4)
# ---------------------------------------------------------------------------
def draft(nodes, edges):
    return {"schemaVersion": 1, "nodes": nodes, "edges": edges, "viewport": {"x": 1, "y": 2,
                                                                             "zoom": 1}}


def dn(id, type, config=None, label=None, **extra):
    data = {"config": config or {}}
    if label is not None:
        data["label"] = label
    return {"id": id, "type": type, "position": {"x": 10, "y": 20}, "data": data, **extra}


def de(id, s, h, t):
    return {"id": id, "source": s, "sourceHandle": h, "target": t}


FULL = draft(
    [dn("n_start", "entry", label="Start"),
     dn("n_hours", "schedule", {"tz": "America/Chicago",
                                "weekly": {"mon": [["09:00", "17:00"], ["bad", "x"]], "sun": []},
                                "closedDates": ["2026-12-25", "2026-02-30", "2026-12-25"]},
        label="Hours for 617-555-0101"),
     dn("n_menu", "menu", {"prompts": [7, 999, -1], "digits": ["1", "2", "2"], "timeoutSec": 8,
                           "retries": 9, "invalidPrompts": [9]}),
     dn("n_check", "condition", {"mode": "equals", "values": ["(508) 555-2145", "junk"]}),
     dn("n_pre", "condition", {"mode": "prefix", "values": ["+1 617", "+16175550101", "+44"]}),
     dn("n_dial", "dial", {"target": {"kind": "external", "number": "774-404-5256"},
                           "passCallerId": False, "ringTimeoutSec": 25}),
     dn("n_own", "dial", {"target": {"kind": "own", "did": "+16175550102"}}),
     dn("n_gone", "dial", {"target": {"kind": "own", "did": "+19995550000"}}),
     dn("n_vm", "voicemail", {"did": MAILBOX}),
     dn("n_notvm", "voicemail", {"did": BILL}),
     dn("n_back", "goto", {"targetNodeId": "n_menu"}),
     dn("n_bye", "hangup", {}),
     dn("n_future", "sms", {"to": "+16175550101"})],
    [de("e1", "n_start", "next", "n_hours"), de("e2", "n_hours", "open", "n_menu"),
     de("e3", "n_hours", "closed", "n_vm"), de("e4", "n_menu", "d:1", "n_dial"),
     de("e5", "n_menu", "d:3", "n_own"),            # stale digit -> dropped
     de("e6", "n_menu", "d:2", "n_back"), de("e7", "n_menu", "d:2", "n_bye"),  # duplicate
     de("e8", "n_dial", "noAnswer", "n_start"),     # into Start -> dropped
     de("e9", "n_menu", "noInput", "n_future"),     # unknown type -> dropped
     de("e10", "n_check", None, "n_own")])          # no handle on a 2-exit node -> dropped


def test_draft_to_alias_graph():
    b = book()
    g = ag.to_alias_graph(FULL, b, placeholders={-1: "NP1"})
    assert schema.alias_graph_errors(g) == []
    byid = {n["id"]: n for n in g["nodes"]}
    assert "n_future" not in byid and all("position" not in n for n in g["nodes"])
    assert byid["n_hours"]["label"] == "Hours for [D1]"
    assert byid["n_hours"]["config"] == {
        "tz": "America/Chicago", "weekly": {"mon": [{"start": "09:00", "end": "17:00"}],
                                            "sun": []},
        "closedDates": ["2026-12-25"]}
    assert byid["n_menu"]["config"] == {"prompts": ["P1", "NP1"], "digits": ["1", "2"],
                                        "timeoutSec": 8, "invalidPrompts": ["P2"]}
    assert byid["n_check"]["config"] == {"mode": "equals", "values": ["N1"]}
    assert byid["n_pre"]["config"] == {"mode": "prefix", "values": ["+1617"]}
    assert byid["n_dial"]["config"] == {"target": {"kind": "external", "ref": "N2"},
                                        "passCallerId": False, "ringTimeoutSec": 25}
    assert byid["n_own"]["config"] == {"target": {"kind": "own", "ref": "D2"}}
    assert byid["n_gone"]["config"] == {}
    assert byid["n_vm"]["config"] == {"mailbox": "D4"} and byid["n_notvm"]["config"] == {}
    assert byid["n_back"]["config"] == {"targetNodeId": "n_menu"}
    assert g["edges"] == [
        {"source": "n_start", "sourceHandle": "next", "target": "n_hours"},
        {"source": "n_hours", "sourceHandle": "open", "target": "n_menu"},
        {"source": "n_hours", "sourceHandle": "closed", "target": "n_vm"},
        {"source": "n_menu", "sourceHandle": "d:1", "target": "n_dial"},
        {"source": "n_menu", "sourceHandle": "d:2", "target": "n_back"}]
    assert b.external == ["+15085552145", "+17744045256"]
    assert "555" not in json.dumps(g)


def test_seeded_start_or_nothing_is_no_base():
    b = book()
    assert ag.to_alias_graph(compiler.default_graph(), b) is None
    assert ag.to_alias_graph(None, b) is None
    assert ag.to_alias_graph({"nodes": "x"}, b) is None


def test_too_large_base_raises():
    nodes = [dn("n_start", "entry")] + [dn(f"n{i}", "hangup") for i in range(60)]
    with pytest.raises(ag.GraphTooLarge):
        ag.to_alias_graph(draft(nodes, []), book())


def test_alias_to_draft_and_round_trip_compiles_to_the_same_plan():
    b = book()
    original = draft(
        [dn("n_start", "entry", label="Start"),
         dn("n_hours", "schedule", {"tz": "America/New_York",
                                    "weekly": {d: [["08:00", "17:00"]] for d in compiler.DAYS}}),
         dn("n_menu", "menu", {"prompts": [7], "digits": ["1", "2"], "retries": 1}),
         dn("n_dial", "dial", {"target": {"kind": "external", "number": "+17744045256"},
                               "ringTimeoutSec": 20}),
         dn("n_vm", "voicemail", {"did": MAILBOX}), dn("n_bye", "hangup", {"prompts": [9]})],
        [de("a", "n_start", "next", "n_hours"), de("b", "n_hours", "open", "n_menu"),
         de("c", "n_hours", "closed", "n_vm"), de("d", "n_menu", "d:1", "n_dial"),
         de("e", "n_menu", "d:2", "n_bye"), de("f", "n_dial", "noAnswer", "n_vm")])
    alias = ag.to_alias_graph(original, b)
    back = ag.from_alias_graph(alias, b, {})
    assert {n["id"] for n in back["nodes"]} == {n["id"] for n in original["nodes"]}
    assert all(n["position"] == {"x": 0, "y": 0} for n in back["nodes"])
    ids = [e["id"] for e in back["edges"]]
    assert len(set(ids)) == len(ids) and all(re.match(r"^e_[A-Za-z0-9_-]{16}$", i) for i in ids)
    assert compiler.check_graph_shape(back) == []
    a, z = compiler.compile_flow(original, ctx()), compiler.compile_flow(back, ctx())
    assert a.ok and z.ok and a.plan == z.plan


def test_new_prompts_become_negative_placeholders_in_order_and_unknown_refs_fail():
    b = book()
    graph = {"nodes": [{"id": "n_start", "type": "entry", "config": {}},
                       {"id": "n_p", "type": "play", "config": {"prompts": ["NP7", "NP2", "P9"]}},
                       {"id": "n_d", "type": "dial", "config": {"target": {"kind": "own",
                                                                           "ref": "D42"}}},
                       {"id": "n_v", "type": "voicemail", "config": {"mailbox": "D1"}}],
             "edges": [{"source": "n_start", "sourceHandle": "next", "target": "n_p"},
                       {"source": "n_p", "sourceHandle": "next", "target": "n_d"},
                       {"source": "n_d", "sourceHandle": "noAnswer", "target": "n_v"}]}
    np_ids = ag.placeholder_ids([{"key": "NP7"}, {"key": "NP2"}])
    assert np_ids == {"NP7": -1, "NP2": -2}
    assert ag.placeholder_ids([{"key": "NP1"}, {"key": "NP1"}, {"key": "NP3"}]) == \
        {"NP1": -1, "NP3": -2}                    # a repeated key does not leave a gap
    d = ag.from_alias_graph(graph, b, np_ids)
    nodes = {n["id"]: n for n in d["nodes"]}
    assert nodes["n_p"]["data"]["config"]["prompts"] == [-1, -2, ag.UNKNOWN_PROMPT_ID]
    assert "target" not in nodes["n_d"]["data"]["config"]
    result = pipeline.compile_proposal(d, ctx(), [
        {"placeholder_id": -1, "name": "A", "text": "a"},
        {"placeholder_id": -2, "name": "B", "text": "b"}])
    codes = {e.code for e in result.errors}
    assert {"prompt_missing", "transfer_target_required", "voicemail_missing"} <= codes


# ---------------------------------------------------------------------------
# The propose / repair loop (§5.1)
# ---------------------------------------------------------------------------
def inp(message="Press 1 for billing, 2 to call (508) 555-2199.", **kw):
    base = dict(message=message, conversation_id="a93e2b1c-4d5e-4f60-9a1b-2c3d4e5f6071",
                compile_ctx=ctx(), numbers=NUMBERS, prompts=PROMPTS)
    base.update(kw)
    return pipeline.AssistInput(**base)


GOOD = {"kind": "proposal",
        "graph": {"nodes": [{"id": "n_start", "type": "entry", "config": {}},
                            {"id": "n_m", "type": "menu",
                             "config": {"prompts": ["NP1"], "digits": ["1", "2"]}},
                            {"id": "n_b", "type": "dial",
                             "config": {"target": {"kind": "own", "ref": "D1"}}},
                            {"id": "n_x", "type": "dial",
                             "config": {"target": {"kind": "external", "ref": "N1"}}}],
                  "edges": [{"source": "n_start", "sourceHandle": "next", "target": "n_m"},
                            {"source": "n_m", "sourceHandle": "d:1", "target": "n_b"},
                            {"source": "n_m", "sourceHandle": "d:2", "target": "n_x"}]},
        "new_prompts": [{"key": "NP1", "name": "Menu for [D1]",
                         "text": "For billing [D1], press 1. For [N1], press 2. [P1]"}],
        "summary": "1 rings [D1], 2 rings [N1] after [NP1].", "assumptions": ["Uses [P1]."]}
BROKEN = json.loads(json.dumps(GOOD))
BROKEN["graph"]["nodes"][2]["config"]["target"]["ref"] = "D5"     # this flow's own number


def test_a_clean_proposal_is_one_round(ted):
    ted.reset(lambda p: GOOD)
    out = run(pipeline.run(inp(), ted_client.call))
    assert (out.status, out.rounds, len(out.request_ids)) == ("done", 1, 1)
    pub = out.public
    assert pub["kind"] == "proposal" and pub["issues"] == []
    assert pub["new_prompts"] == [{"placeholder_id": -1,
                                   "name": "Menu for Billing line (617-555-0101)",
                                   "text": "For billing 617-555-0101, press 1. For "
                                           "508-555-2199, press 2."}]
    assert pub["summary"] == ("1 rings Billing line (617-555-0101), 2 rings 508-555-2199 after "
                              "“Menu for Billing line (617-555-0101)”.")
    assert pub["assumptions"] == ["Uses “Main greeting”."]
    nodes = {n["id"]: n for n in pub["draft_graph"]["nodes"]}
    assert nodes["n_m"]["data"]["config"]["prompts"] == [-1]
    assert nodes["n_x"]["data"]["config"]["target"] == {"kind": "external",
                                                        "number": "+15085552199"}
    req = ted.requests[0]
    assert req["message"] == "Press 1 for billing, 2 to call [N1]."
    assert req["external_numbers"] == ["N1"] and req["round"] == "propose"
    assert out.external_numbers == ["+15085552199"]


def test_repair_loop_stops_after_two_repairs_and_returns_the_issues(ted):
    ted.reset(lambda p: BROKEN)
    out = run(pipeline.run(inp(), ted_client.call))
    assert out.status == "done" and out.rounds == 3 and len(set(out.request_ids)) == 3
    assert [r["round"] for r in ted.requests] == ["propose", "repair", "repair"]
    assert [i["code"] for i in out.public["issues"]] == ["self_transfer"]
    first, repair = ted.requests[0], ted.requests[1]
    for key in ("message", "history", "destinations", "prompts", "external_numbers",
                "conversation_id", "limits"):
        assert repair[key] == first[key], key
    assert repair["base"] == BROKEN["graph"]
    assert repair["base_new_prompts"] == [{"key": "NP1", "name": "Menu for [D1]",
                                           "text": GOOD["new_prompts"][0]["text"]}]
    assert repair["repair"]["issues"][0]["code"] == "self_transfer"
    assert repair["repair"]["issues"][0]["node_id"] == "n_b"


def test_repair_that_fixes_it_ends_the_loop(ted):
    answers = [BROKEN, GOOD]
    ted.reset(lambda p: answers.pop(0))
    out = run(pipeline.run(inp(), ted_client.call))
    assert out.rounds == 2 and out.public["issues"] == []


def test_a_failed_repair_call_returns_the_last_proposal(ted):
    answers = [BROKEN, (503, {"error": "model_unavailable", "message": "x"})]
    ted.reset(lambda p: answers.pop(0))
    out = run(pipeline.run(inp(), ted_client.call))
    assert out.status == "done" and out.rounds == 2 and out.public["issues"]


def test_a_repair_that_turns_into_a_question_keeps_the_proposal(ted):
    answers = [BROKEN, {"kind": "clarify", "question": "Which?"}]
    ted.reset(lambda p: answers.pop(0))
    out = run(pipeline.run(inp(), ted_client.call))
    assert out.public["kind"] == "proposal" and out.rounds == 2


def test_out_of_time_stops_repairs(ted, monkeypatch):
    ted.reset(lambda p: BROKEN)
    out = run(pipeline.run(inp(), ted_client.call, deadline=0.0))
    assert out.rounds == 1 and out.public["issues"]


@pytest.mark.parametrize("answer,code,retry", [
    ((400, {"error": "bad_request", "message": "x"}), "assistant_failed", None),
    ((401, {"error": "unauthorized", "message": "x"}), "assistant_unavailable", None),
    ((409, {"error": "request_id_reused", "message": "x"}), "assistant_failed", None),
    ((413, {"error": "too_large", "message": "x"}), "assistant_failed", None),
    ((429, {"error": "budget_exhausted", "message": "x", "retry_after_s": 120}),
     "assistant_busy", 120),
    ((429, {"error": "busy", "message": "x"}), "assistant_busy", None),
    ((502, {"error": "model_no_result", "message": "x"}), "assistant_failed", None),
    ((503, {"error": "disabled", "message": "x"}), "assistant_unavailable", None),
    ((503, {"error": "model_unavailable", "message": "x"}), "assistant_unavailable", None),
    ((500, b"oops"), "assistant_unavailable", None),
    ((404, b"<html>"), "assistant_failed", None),
    ((200, b"not json"), "assistant_failed", None),
    ((200, {"v": 1}), "assistant_failed", None),
])
def test_ted_status_mapping(ted, answer, code, retry):
    ted.reset(lambda p: answer)
    out = run(pipeline.run(inp(), ted_client.call))
    assert (out.status, out.error_code, out.retry_after_s, out.rounds) == \
        ("failed", code, retry, 1)


def test_wrong_request_id_and_invalid_graph_are_failures(ted):
    other = "11111111-1111-4111-8111-111111111111"
    ted.reset(lambda p: (200, fake.envelope(dict(p, request_id=other), GOOD)))
    assert run(pipeline.run(inp(), ted_client.call)).error_code == "assistant_failed"
    bad = json.loads(json.dumps(GOOD))
    bad["graph"]["nodes"][1]["config"]["digits"] = ["1", "1"]
    ted.reset(lambda p: bad)
    assert run(pipeline.run(inp(), ted_client.call)).error_code == "assistant_failed"


def test_network_errors_are_unavailable(monkeypatch):
    fake.configure_env(monkeypatch)

    def boom(request):
        raise httpx.ConnectTimeout("slow")

    monkeypatch.setattr(ted_client, "TRANSPORT", httpx.MockTransport(boom))
    assert run(pipeline.run(inp(), ted_client.call)).error_code == "assistant_unavailable"

    def refused(request):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(ted_client, "TRANSPORT", httpx.MockTransport(refused))
    assert run(pipeline.run(inp(), ted_client.call)).error_code == "assistant_unavailable"


def test_unconfigured_ted_is_unavailable(monkeypatch):
    monkeypatch.delenv("TED_BASE_URL", raising=False)
    monkeypatch.delenv("TED_IVR_ASSIST_TOKEN", raising=False)
    assert run(pipeline.run(inp(), ted_client.call)).error_code == "assistant_unavailable"


def test_clarify_and_cannot_build_are_rendered(ted):
    ted.reset(lambda p: {"kind": "clarify", "question": "Should 1 ring [D1] or [D2]?"})
    out = run(pipeline.run(inp(), ted_client.call))
    assert out.public == {"kind": "clarify", "question": "Should 1 ring Billing line "
                                                         "(617-555-0101) or Outage desk "
                                                         "(617-555-0102)?"}
    ted.reset(lambda p: {"kind": "cannot_build", "message": "No texting for [N1]."})
    out = run(pipeline.run(inp(), ted_client.call))
    assert out.public == {"kind": "cannot_build", "message": "No texting for 508-555-2199."}


def test_a_repeated_new_prompt_key_is_listed_once(ted):
    dup = json.loads(json.dumps(GOOD))
    dup["new_prompts"].append({"key": "NP1", "name": "Again", "text": "Twice."})
    ted.reset(lambda p: dup)
    out = run(pipeline.run(inp(), ted_client.call))
    assert [n["placeholder_id"] for n in out.public["new_prompts"]] == [-1]
    assert out.public["new_prompts"][0]["name"].startswith("Menu for")


def test_new_message_problems_become_issues(ted):
    bad = json.loads(json.dumps(GOOD))
    bad["new_prompts"][0]["text"] = "[P1] [NP1]"
    ted.reset(lambda p: bad)
    out = run(pipeline.run(inp(), ted_client.call))
    assert "new_message_empty" in [i["code"] for i in out.public["issues"]]
    assert out.rounds == 3                 # it is fed to the repair rounds too
    assert ted.requests[1]["repair"]["issues"][0]["code"] == "new_message_empty"


def test_base_history_and_limits_in_the_request(ted):
    base = draft([dn("n_start", "entry"), dn("n_d", "dial", {"target": {
        "kind": "external", "number": "+17744045256"}})],
        [de("a", "n_start", "next", "n_d")])
    ted.reset(lambda p: GOOD)
    run(pipeline.run(inp(base_graph=base, max_new_prompts=3, history=[
        ("customer", "Earlier I said 617-555-0102."), ("assistant", "Rings Outage desk "
                                                                   "(617-555-0102).")]),
        ted_client.call))
    req = ted.requests[0]
    assert req["base"]["nodes"][1]["config"]["target"] == {"kind": "external", "ref": "N2"}
    assert req["history"] == [{"role": "customer", "text": "Earlier I said [D2]."},
                              {"role": "assistant", "text": "Rings Outage desk ([D2])."}]
    assert req["limits"] == {"max_nodes": 60, "max_new_prompts": 3, "max_prompt_chars": 1000}
    assert req["external_numbers"] == ["N1", "N2"]


def test_refining_a_proposal_sends_its_new_prompts(ted):
    proposal = run(_proposal(ted))
    ted.reset(lambda p: GOOD)
    run(pipeline.run(inp("Change the menu text.", base_graph=proposal["draft_graph"],
                         base_new_prompts=proposal["new_prompts"],
                         external_numbers=["+15085552199"]), ted_client.call))
    req = ted.requests[0]
    # the stored (customer-facing) name and spoken text are re-aliased
    assert req["base_new_prompts"] == [{"key": "NP1", "name": "Menu for Billing line ([D1])",
                                        "text": "For billing [D1], press 1. For [N1], press 2."}]
    menu = next(n for n in req["base"]["nodes"] if n["id"] == "n_m")
    assert menu["config"]["prompts"] == ["NP1"]


async def _proposal(ted):
    ted.reset(lambda p: GOOD)
    return (await pipeline.run(inp(), ted_client.call)).public


# ---------------------------------------------------------------------------
# The TED client: wire + the token never leaks
# ---------------------------------------------------------------------------
def test_wire_headers_and_no_token_in_logs_or_errors(ted, caplog):
    caplog.set_level(logging.DEBUG)
    ted.reset(lambda p: (401, {"error": "unauthorized", "message": "wrong token"}))
    out = run(pipeline.run(inp(), ted_client.call))
    assert out.error_code == "assistant_unavailable"
    req = ted.wire[0]
    assert req.headers["X-TED-Trigger-Token"] == fake.TOKEN
    assert str(req.url) == fake.BASE_URL + fake.PATH
    assert any(r.levelno == logging.ERROR and "401" in r.getMessage() for r in caplog.records)
    ted.reset(lambda p: GOOD)
    run(pipeline.run(inp(), ted_client.call))
    for record in caplog.records:
        assert fake.TOKEN not in record.getMessage()
    try:
        ted.reset(lambda p: (429, {"error": "busy", "message": "x"}))
        run(ted_client.call(ted_client_payload()))
    except ted_client.TedError as exc:
        assert fake.TOKEN not in str(exc) and fake.TOKEN not in repr(exc.__dict__)


def ted_client_payload():
    return pipeline._Request(inp()).payload("propose", None, [], None)


def test_an_invalid_request_is_never_sent(ted):
    payload = ted_client_payload()
    payload["message"] = ""
    with pytest.raises(ted_client.TedError) as e:
        run(ted_client.call(payload))
    assert e.value.code == "assistant_failed" and ted.wire == []


def test_an_oversized_request_is_never_sent(ted, monkeypatch):
    monkeypatch.setattr(config, "MAX_ENCODED_BODY_BYTES", 100)
    with pytest.raises(ted_client.TedError) as e:
        run(ted_client.call(ted_client_payload()))
    assert e.value.code == "assistant_failed" and ted.wire == []


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("url,ok", [
    ("https://ted.example.com", True), ("https://ted.example.com/", True),
    ("https://ted.example.com:8443/base", True), ("http://localhost:8000", True),
    ("http://127.0.0.1:9000", True), ("http://ted:8000", True),
    ("http://ted.example.com", False), ("ftp://ted.example.com", False),
    ("https://user:pw@ted.example.com", False), ("https://ted.example.com?x=1", False),
    ("not a url", False), ("https://ted.example.com:99999", False), ("", False)])
def test_ted_base_url_validation(monkeypatch, url, ok):
    monkeypatch.setenv("TED_BASE_URL", url)
    assert (config.ted_base_url() is not None) is ok
    if ok:
        assert config.ted_url().endswith("/api/triggers/crag/ivr-assist")
        assert "//api" not in config.ted_url()


def test_token_flag_and_numbers(monkeypatch):
    monkeypatch.setenv("TED_IVR_ASSIST_TOKEN", "has space")
    assert config.ted_token() is None
    monkeypatch.setenv("TED_IVR_ASSIST_TOKEN", "  tok-123  ")
    assert config.ted_token() == "tok-123"
    for raw, want in (("true", True), (" TRUE ", True), ("1", False), ("yes", False), ("", False)):
        monkeypatch.setenv("IVR_ASSIST_ENABLED", raw)
        assert config.enabled() is want
    monkeypatch.setenv("IVR_ASSIST_DAILY_PER_CUSTOMER", "nope")
    assert config.daily_cap() == 40
    monkeypatch.setenv("IVR_ASSIST_DAILY_PER_CUSTOMER", "0")
    assert config.daily_cap() == 1
    monkeypatch.setenv("IVR_ASSIST_TED_TIMEOUT_SECONDS", "600")
    assert config.ted_timeout_s() == config.MAX_TIMEOUT_S
    monkeypatch.delenv("IVR_ASSIST_TED_TIMEOUT_SECONDS")
    assert config.ted_timeout_s() == 60.0
    assert 3 * config.MAX_TIMEOUT_S < config.STALE_AFTER_S
