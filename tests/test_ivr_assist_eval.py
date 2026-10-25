"""The Flow assistant eval cases + runner (contract docs/IVR_ASSIST_INTERFACES.md §9).

  * the case file (tests/fixtures/ivr_assist/eval_cases.json) is well formed,
    has >= 30 realistic utility requests and covers the vocabulary of §6
    (menus, hours in several time zones, holidays, caller checks, transfers
    with ring time and caller ID, voicemail, go-back, refusals, ambiguous
    destinations that must produce a question);
  * every case's ``reference`` (a known-good TED answer) is schema-valid and,
    replayed through CRAG's real pipeline over the real wire path (fake TED,
    no network), meets every expectation of its case — the expectations are
    reachable, and the runner's checks work;
  * PROPERTY: for every case, no request CRAG sends to TED — propose AND
    repair rounds, with the reference, the contract's scripted provider and a
    deliberately broken provider — contains any phone number;
  * ``python -m services.ivr.assist.eval``: exit codes, stdin, --only, --json.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import re
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import ivr_assist_fake_ted as fake  # noqa: E402
from services import customer_numbers as cn  # noqa: E402
from services.ivr import policy  # noqa: E402
from services.ivr.assist import aliases, pipeline, schema, ted_client  # noqa: E402
from services.ivr.assist import eval as assist_eval  # noqa: E402
from utils.phone import normalize_e164  # noqa: E402

CASES_PATH = REPO / "tests" / "fixtures" / "ivr_assist" / "eval_cases.json"
DOC = assist_eval.load_cases(CASES_PATH.read_text())
CASES = DOC["cases"]
IDS = [c["id"] for c in CASES]


@pytest.fixture
def wire(monkeypatch):
    fake.configure_env(monkeypatch)
    ted = fake.FakeTed()
    monkeypatch.setattr(ted_client, "TRANSPORT", ted.transport())
    return ted


def aliased_message(case) -> str:
    inp = assist_eval.context_input(DOC["contexts"][case["context"]], case)
    return pipeline._Request(inp).message


def reference_script():
    by_message = {aliased_message(c): c["reference"] for c in CASES}
    return lambda payload: by_message[payload["message"]]


# ---------------------------------------------------------------------------
# The case file
# ---------------------------------------------------------------------------
def test_case_file_shape():
    assert len(CASES) >= 30 and len(set(IDS)) == len(IDS)
    for case in CASES:
        assert set(case) <= {"id", "context", "message", "history", "base", "expect",
                             "reference"}, case["id"]
        assert case["context"] in DOC["contexts"], case["id"]
        assert 1 <= len(case["message"]) <= 2000
        kinds = case["expect"].get("kind", "proposal")
        kinds = kinds if isinstance(kinds, list) else [kinds]
        assert set(kinds) <= {"proposal", "clarify", "cannot_build"}
        assert case["reference"]["kind"] in kinds, case["id"]
        if "proposal" in kinds:
            assert case["expect"].get("calls"), f"{case['id']}: a proposal needs calls"
        for call in case["expect"].get("calls", []):
            assert call["outcome"] in ("transfer", "voicemail", "hangup", "limit")
            assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", call["at"])


def test_contexts_are_canonical_and_in_alias_order():
    for name, ctx in DOC["contexts"].items():
        dests = ctx["destinations"]
        for d in dests:
            assert normalize_e164(d["did"]) == d["did"], (name, d)
            assert d["product"] in policy.OWN_TARGET_PRODUCTS
        # listed in the order CRAG assigns D1, D2, … (so the references read naturally)
        assert dests == sorted(dests, key=lambda d: (cn.product_sort_key(d["product"]),
                                                     d["did"])), name


def test_every_reference_is_a_valid_ted_answer():
    for case in CASES:
        payload = {"request_id": "6f1c2a7e-0b3d-4c5e-8f9a-1b2c3d4e5f60"}
        assert schema.response_errors(fake.envelope(payload, case["reference"])) == [], \
            case["id"]


def test_outside_numbers_in_the_cases_pass_the_dial_policy():
    for case in CASES:
        own = {d["did"] for d in DOC["contexts"][case["context"]]["destinations"]}
        for number in aliases.find_numbers(case["message"]):
            if number not in own:
                assert policy.check_external(number).ok, (case["id"], number)


def test_cases_cover_the_vocabulary():
    graphs = [c["reference"]["graph"] for c in CASES if c["reference"]["kind"] == "proposal"]
    nodes = [n for g in graphs for n in g["nodes"]]
    types = {n["type"] for n in nodes}
    assert types == {"entry", "play", "menu", "schedule", "condition", "dial", "voicemail",
                     "goto", "hangup"}
    tzs = {n["config"]["tz"] for n in nodes if n["type"] == "schedule"}
    assert len(tzs) >= 6
    assert any(n["config"].get("closedDates") for n in nodes if n["type"] == "schedule")
    modes = {n["config"]["mode"] for n in nodes if n["type"] == "condition"}
    assert modes == {"anonymous", "prefix", "equals"}
    dials = [n["config"] for n in nodes if n["type"] == "dial"]
    assert any("ringTimeoutSec" in d for d in dials)
    assert {d.get("passCallerId") for d in dials} >= {True, False}
    assert {d["target"]["kind"] for d in dials} == {"own", "external"}
    assert any(n["config"].get("invalidPrompts") for n in nodes if n["type"] == "menu")
    kinds = [c["reference"]["kind"] for c in CASES]
    assert kinds.count("clarify") >= 4 and kinds.count("cannot_build") >= 3
    assert any(c.get("base") for c in CASES) and any(c.get("history") for c in CASES)


# ---------------------------------------------------------------------------
# References through the real pipeline
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_reference_meets_every_expectation(wire, case):
    wire.reset(lambda payload: case["reference"])
    report = asyncio.run(assist_eval.run_case(DOC, case, ted_client.call))
    assert report.passed, report.failures
    assert report.rounds == 1


def test_the_runner_reports_failures(wire):
    case = next(c for c in CASES if c["id"] == "acme-main-menu")
    wrong = json.loads(json.dumps(case["reference"]))
    wrong["graph"]["nodes"][3]["config"]["target"]["ref"] = "D2"    # 1 rings the outage desk
    wire.reset(lambda payload: wrong)
    report = asyncio.run(assist_eval.run_case(DOC, case, ted_client.call))
    assert not report.passed
    assert any("press 1 -> billing: reached +16175550102" in f for f in report.failures)
    wire.reset(lambda payload: {"kind": "cannot_build", "message": "no"})
    report = asyncio.run(assist_eval.run_case(DOC, case, ted_client.call))
    assert report.failures == ["kind cannot_build, expected proposal"]
    wire.reset(lambda payload: (503, {"error": "disabled", "message": "off"}))
    report = asyncio.run(assist_eval.run_case(DOC, case, ted_client.call))
    assert report.failures == ["job failed: assistant_unavailable"]


# ---------------------------------------------------------------------------
# PROPERTY: no phone number ever reaches TED
# ---------------------------------------------------------------------------
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_JOINED = re.compile(r"(?<=\d)[\s().+-]+(?=\d)")


def _leaks(payload: dict, case: dict) -> list[str]:
    body = {k: v for k, v in payload.items() if k not in ("request_id", "conversation_id")}
    ctx = DOC["contexts"][case["context"]]
    known = {d["did"][2:] for d in ctx["destinations"]}
    known |= {n[2:] for n in aliases.find_numbers(case["message"])}
    for turn in case.get("history", []):
        known |= {n[2:] for n in aliases.find_numbers(turn[1])}
    out = []
    for text in fake.any_value(body):
        if aliases.find_numbers(text):
            out.append(f"NANP number in {text!r}")
        joined = _JOINED.sub("", _ISO_DATE.sub("", text))
        if re.search(r"\d{7,}", joined):
            out.append(f"7+ digits in {text!r}")
        digits = re.sub(r"\D", "", text)
        for number in known:
            if number in digits or number[3:] in joined:
                out.append(f"{number} in {text!r}")
    return out


def _broken(payload: dict) -> dict:
    """The scripted provider with every transfer pointed at a non-destination,
    so CRAG must run both repair rounds (whose requests are scanned too)."""
    result = fake.scripted_result(payload)
    if result["kind"] == "proposal":
        for node in result["graph"]["nodes"]:
            if node["type"] == "dial":
                node["config"]["target"]["ref"] = "D199"
    return result


@pytest.mark.parametrize("provider", ["reference", "scripted", "broken"])
def test_no_request_sent_to_ted_contains_a_phone_number(wire, provider):
    script = {"reference": reference_script(), "scripted": fake.scripted_result,
              "broken": _broken}[provider]
    repairs = 0
    for case in CASES:
        wire.reset(script)
        asyncio.run(assist_eval.run_case(DOC, case, ted_client.call))
        assert wire.requests, case["id"]
        for payload in wire.requests:
            assert schema.request_errors(payload) == []
            assert _leaks(payload, case) == [], (case["id"], payload["round"])
            repairs += payload["round"] == "repair"
    if provider == "broken":
        assert repairs >= 2 * 20          # most cases went through both repair rounds


# ---------------------------------------------------------------------------
# The CLI
# ---------------------------------------------------------------------------
def test_main_runs_all_cases_and_exits_zero(wire):
    wire.reset(reference_script())
    out = io.StringIO()
    assert assist_eval.main(["--cases", str(CASES_PATH)], out=out) == 0
    text = out.getvalue()
    assert text.count("PASS ") == len(CASES) and "FAIL" not in text
    assert f"{len(CASES)}/{len(CASES)} cases passed" in text


def test_main_only_json_and_stdin(wire, monkeypatch):
    wire.reset(reference_script())
    monkeypatch.setattr(sys, "stdin", io.StringIO(CASES_PATH.read_text()))
    out = io.StringIO()
    code = assist_eval.main(["--cases", "-", "--only", "acme-main-menu,refuse-sms", "--json"],
                            out=out)
    report = json.loads(out.getvalue())
    assert code == 0 and report["passed"] == 2 and report["total"] == 2
    assert [c["id"] for c in report["cases"]] == ["acme-main-menu", "refuse-sms"]


def test_main_token_from_stdin_and_ted_url_override(wire, monkeypatch, capsys):
    """The owner's staging run: URL on the command line, token as stdin line 1."""
    monkeypatch.setenv("TED_BASE_URL", "https://wrong.invalid")
    monkeypatch.delenv("TED_IVR_ASSIST_TOKEN")
    wire.reset(reference_script())
    monkeypatch.setattr(sys, "stdin", io.StringIO(fake.TOKEN + "\n" + CASES_PATH.read_text()))
    out = io.StringIO()
    code = assist_eval.main(["--ted-url", fake.BASE_URL, "--token-stdin", "--cases", "-",
                             "--only", "acme-main-menu"], out=out)
    assert code == 0 and "PASS  acme-main-menu" in out.getvalue()
    assert wire.wire[0].headers["X-TED-Trigger-Token"] == fake.TOKEN
    assert str(wire.wire[0].url).startswith(fake.BASE_URL)
    assert fake.TOKEN not in out.getvalue() + capsys.readouterr().err
    monkeypatch.setattr(sys, "stdin", io.StringIO("\n"))
    assert assist_eval.main(["--token-stdin", "--cases", str(CASES_PATH)]) == 2


def test_main_exit_codes(wire, monkeypatch, capsys):
    wire.reset(lambda payload: {"kind": "cannot_build", "message": "no"})
    out = io.StringIO()
    assert assist_eval.main(["--cases", str(CASES_PATH), "--only", "acme-main-menu"],
                            out=out) == 1
    assert "FAIL  acme-main-menu" in out.getvalue()
    monkeypatch.delenv("TED_IVR_ASSIST_TOKEN")
    assert assist_eval.main(["--cases", str(CASES_PATH)]) == 2
    assert "TED_BASE_URL and TED_IVR_ASSIST_TOKEN" in capsys.readouterr().err
    fake.configure_env(monkeypatch)
    assert assist_eval.main(["--cases", "/nonexistent/cases.json"]) == 2
