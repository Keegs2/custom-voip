"""Visual IVR simulator (services/ivr/simulator.py) over the golden plans.

Cases live in tests/fixtures/ivr/expectations.json ("simulations"): caller,
instant, keys -> outcome + the node of every transcript step. Hours checks use
zoneinfo, so the DST cases (2026-03-08 spring forward, 2026-11-01 fall back in
America/New_York) are exact.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from services.ivr import simulator  # noqa: E402

FIXTURES = REPO / "tests" / "fixtures" / "ivr"
EXPECT = json.loads((FIXTURES / "expectations.json").read_text())
CASES = [(name, i, case) for name, e in EXPECT.items() if not name.startswith("_")
         for i, case in enumerate(e["simulations"])]
CONTEXT = json.loads((FIXTURES / "context.json").read_text())


def plan(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.plan.json").read_text())


def _at(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def test_cases_cover_the_interesting_fixtures():
    names = {n for n, _, _ in CASES}
    assert {"menu_repeat_goto", "hours_dst_closed_dates", "caller_modes",
            "goto_chain_and_restart", "hold_loop_warning", "all_blocks_defaults"} <= names


@pytest.mark.parametrize("name,i,case", CASES, ids=[f"{n}-{i}" for n, i, _ in CASES])
def test_simulation_case(name, i, case):
    caller = None if case["caller"] == "anonymous" else case["caller"]
    out = simulator.simulate(plan(name), caller=caller, at=_at(case["at"]),
                             digits=case["digits"])
    assert out["outcome"] == case["outcome"]
    path = [s["node_id"] for s in out["steps"]]
    if "path" in case:
        assert path == case["path"]
    else:
        assert len(path) == case["path_len"]
    for step in out["steps"]:
        assert set(step) == {"node_id", "kind", "says", "note"}


def test_says_uses_the_prompt_names_in_order():
    names = {"n_play": {"prompts": ["Welcome", "Please hold", "Welcome (copy)"]},
             "n_bye": {"prompts": ["Goodbye"]}}
    out = simulator.simulate(plan("play_then_hangup"), caller=None,
                             at=datetime(2026, 10, 26, tzinfo=timezone.utc),
                             prompt_names=names)
    assert [s["says"] for s in out["steps"]] == [["Welcome", "Please hold", "Welcome (copy)"],
                                                 ["Goodbye"]]


def test_menu_failure_prompts_and_last_failure_type_decides_the_exit():
    p = plan("menu_repeat_goto")
    p["nodes"]["n_menu"]["on_nomatch"] = "n_vm"
    names = {"n_menu": {"prompts": ["Main menu"], "invalid_prompts": ["Not an option"],
                        "noinput_prompts": ["Still there?"]}}
    out = simulator.simulate(p, caller="+12125550123", at=datetime(2026, 10, 26,
                             tzinfo=timezone.utc), digits=["5", "5", "5", "5"],
                             prompt_names=names)
    menu_steps = [s for s in out["steps"] if s["node_id"] == "n_menu"]
    assert len(menu_steps) == 4                       # 1 try + 3 retries
    assert all(s["says"] == ["Main menu", "Not an option"] for s in menu_steps)
    assert out["outcome"] == "voicemail"              # last failure = nomatch
    out2 = simulator.simulate(p, caller=None, at=datetime(2026, 10, 26, tzinfo=timezone.utc),
                              digits=["5", "5", "5"], prompt_names=names)
    assert out2["steps"][-2]["says"] == ["Main menu", "Still there?"]
    assert out2["outcome"] == "hangup"                # last failure = no input


def test_hours_state_dst_and_closed_dates():
    node = plan("hours_dst_closed_dates")["nodes"]["n_hours"]
    # Monday 2026-03-09 09:30 EDT (UTC-4) open; the same UTC time a week earlier
    # is 08:30 EST (UTC-5) -> closed.
    assert simulator.hours_state(node, _at("2026-03-09T13:30:00Z"))[0] is True
    assert simulator.hours_state(node, _at("2026-03-02T13:30:00Z"))[0] is False
    is_open, reason = simulator.hours_state(node, _at("2026-12-25T15:00:00Z"))
    assert is_open is False and "closed date" in reason
    # end is exclusive: 17:00 local Monday is closed, 16:59 open
    assert simulator.hours_state(node, _at("2026-10-26T20:59:00Z"))[0] is True
    assert simulator.hours_state(node, _at("2026-10-26T21:00:00Z"))[0] is False
    # naive instants are UTC
    assert simulator.hours_state(node, datetime(2026, 10, 26, 20, 59))[0] is True


def test_caller_matching():
    n = {"mode": "prefix", "values": ["+1617"]}
    assert simulator.caller_matches(n, "+16175550100")
    assert simulator.caller_matches(n, "6175550100")          # canonicalised
    assert not simulator.caller_matches(n, "+15085550100")
    assert not simulator.caller_matches(n, None)
    assert simulator.caller_matches({"mode": "anonymous", "values": []}, "Anonymous")
    assert simulator.caller_matches({"mode": "anonymous", "values": []}, None)
    assert not simulator.caller_matches({"mode": "anonymous", "values": []}, "+16175550100")
    assert simulator.caller_matches({"mode": "equals", "values": ["+16175550100"]},
                                    "(617) 555-0100")


def test_limit_and_unknown_node_and_pretty_number():
    p = plan("hold_loop_warning")
    p["limits"]["max_steps"] = 3
    out = simulator.simulate(p, caller=None, at=datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert out["outcome"] == "limit" and len(out["steps"]) == 4
    out = simulator.simulate({"start": "n_x", "nodes": {"n_x": {"t": "future"}},
                              "limits": {"max_steps": 5}}, caller=None,
                             at=datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert out["outcome"] == "hangup"
    assert simulator.pretty_number("+17744045256") == "+1 774-404-5256"
    assert simulator.pretty_number("+447911123456") == "+447911123456"


def test_transfer_note_names_blocks_and_own_number_kind_not_ids():
    """The note is customer-facing: no node ids, no internal product codes."""
    p = {"v": 1, "start": "n_x", "limits": {"max_steps": 200, "max_seconds": 1800},
         "prompts": [], "nodes": {
             "n_x": {"t": "transfer", "dest": {"kind": "own", "did": "+16175550101",
                                              "product": "rcf"},
                     "pass_caller_id": True, "ring_timeout": 30, "on_noanswer": "n_vm"},
             "n_vm": {"t": "voicemail", "did": "+16175550102"}}}
    graph = {"nodes": [{"id": "n_x", "type": "dial", "data": {"label": "Sales"}},
                       {"id": "n_vm", "type": "voicemail", "data": {"label": "  "}}]}
    names = simulator.block_names_from_graph(graph)
    assert names == {"n_x": "Sales", "n_vm": "Voicemail"}
    out = simulator.simulate(p, caller=None, at=datetime(2026, 10, 26, tzinfo=timezone.utc),
                             block_names=names)
    note = out["steps"][0]["note"]
    assert "your call forwarding number" in note and "rcf" not in note
    assert "continues at “Voicemail”." in note and "n_vm" not in note
    out = simulator.simulate(p, caller=None, at=datetime(2026, 10, 26, tzinfo=timezone.utc))
    assert "on the No answer route." in out["steps"][0]["note"]
