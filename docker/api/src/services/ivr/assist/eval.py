"""Flow assistant eval runner (contract docs/IVR_ASSIST_INTERFACES.md §9).

    python -m services.ivr.assist.eval --cases FILE|-  [--only ID,ID] [--json] [-v]

Runs inside the API container against the TED configured in the environment
(``TED_BASE_URL`` + ``TED_IVR_ASSIST_TOKEN``; ``IVR_ASSIST_ENABLED`` is not
needed — this is an operator tool). It needs NO database: every case brings
its own synthetic customer (numbers, messages) from the case file. The case
file lives in the repo at ``tests/fixtures/ivr_assist/eval_cases.json``, which
is not in the API image — pipe it in with ``--cases -``.

Each case goes through exactly the production path (aliasing, the TED call,
de-aliasing, CRAG's compiler, up to two repair rounds) and is then checked:
  * ``kind``      the result kind (or one of a list of kinds);
  * ``compiles_clean``  a proposal with no compiler errors left;
  * ``calls``     simulated calls (caller, time, keys) through the compiled
                  plan, each reaching the expected ``outcome`` and, for a
                  transfer / voicemail, the expected ``target`` number
                  (optionally ``pass_caller_id``, ``ring_timeout``, and
                  ``says`` = message names the caller must hear).

Exit status: 0 = every case passed, 1 = a case failed, 2 = usage / config.
Prints one line per case and a summary; no phone number of a case is ever
sent to TED (the same aliasing as production).
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional, TextIO

from services.ivr import compiler, simulator
from services.ivr.assist import config, pipeline, ted_client
from services.ivr.assist.aliases import PromptInfo
from services.ivr.compiler import CompileContext, OwnNumber, PromptRef
from utils.phone import normalize_e164

CASES_VERSION = 1


@dataclass
class CaseReport:
    id: str
    passed: bool
    kind: Optional[str] = None
    rounds: int = 0
    issues: int = 0
    calls_ok: int = 0
    calls_total: int = 0
    failures: list[str] = field(default_factory=list)


def load_cases(text: str) -> dict:
    doc = json.loads(text)
    if not isinstance(doc, dict) or doc.get("version") != CASES_VERSION:
        raise ValueError(f"eval cases: expected a version {CASES_VERSION} document")
    if not isinstance(doc.get("contexts"), dict) or not isinstance(doc.get("cases"), list):
        raise ValueError("eval cases: 'contexts' and 'cases' are required")
    return doc


def context_input(ctx: dict, case: dict) -> pipeline.AssistInput:
    """The synthetic customer of a case -> the pipeline input (no DB)."""
    numbers = [OwnNumber(normalize_e164(d["did"]), d["product"], d.get("name"),
                         bool(d.get("enabled", True))) for d in ctx.get("destinations", [])]
    self_dids = frozenset(normalize_e164(d["did"]) for d in ctx.get("destinations", [])
                          if d.get("this_flow"))
    prompts = [PromptInfo(int(p["id"]), p["name"], p.get("text")) for p in ctx.get("prompts", [])]
    refs = {p.id: PromptRef(hashlib.sha256(f"eval-prompt:{p.id}".encode()).hexdigest(), p.name)
            for p in prompts}
    compile_ctx = CompileContext(customer_id=0, flow_id=0, version=1, prompts=refs,
                                 numbers={n.did: n for n in numbers}, self_dids=self_dids)
    history = [(t[0], t[1]) for t in case.get("history", [])]
    return pipeline.AssistInput(
        message=case["message"], conversation_id=str(uuid.uuid4()), compile_ctx=compile_ctx,
        numbers=numbers, prompts=prompts, history=history, base_graph=case.get("base"))


def _target(plan: dict, steps: list[dict]) -> tuple[Optional[str], Optional[dict]]:
    last = steps[-1] if steps else None
    node = plan["nodes"].get(last["node_id"]) if last and last.get("node_id") else None
    if node is None:
        return None, None
    if node["t"] == "transfer":
        return node["dest"].get("e164") or node["dest"].get("did"), node
    if node["t"] == "voicemail":
        return node["did"], node
    return None, node


def check_call(call: dict, compiled: compiler.CompileResult, graph: dict) -> list[str]:
    name = call.get("name") or f"{call.get('caller')} @ {call.get('at')} keys {call.get('digits')}"
    caller_raw = call.get("caller", "anonymous")
    caller = None if caller_raw == "anonymous" else normalize_e164(caller_raw)
    at = datetime.fromisoformat(call["at"].replace("Z", "+00:00"))
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    sim = simulator.simulate(compiled.plan, caller=caller, at=at, digits=call.get("digits", []),
                             prompt_names=compiled.prompt_names,
                             block_names=simulator.block_names_from_graph(graph))
    problems = []
    if sim["outcome"] != call["outcome"]:
        problems.append(f"{name}: outcome {sim['outcome']}, expected {call['outcome']}")
    target, node = _target(compiled.plan, sim["steps"])
    if "target" in call and target != normalize_e164(call["target"]):
        problems.append(f"{name}: reached {target or 'no number'}, expected {call['target']}")
    if node is not None and node["t"] == "transfer":
        if "pass_caller_id" in call and node["pass_caller_id"] != call["pass_caller_id"]:
            problems.append(f"{name}: pass_caller_id {node['pass_caller_id']}")
        if "ring_timeout" in call and node["ring_timeout"] != call["ring_timeout"]:
            problems.append(f"{name}: ring_timeout {node['ring_timeout']}")
    heard = [s for step in sim["steps"] for s in step.get("says", [])]
    for want in call.get("says", []):
        if not any(want.lower() in s.lower() for s in heard):
            problems.append(f"{name}: never hears “{want}”")
    return problems


def evaluate(case: dict, outcome: pipeline.AssistOutcome) -> CaseReport:
    expect = case.get("expect", {})
    report = CaseReport(case["id"], False, rounds=outcome.rounds)
    if outcome.status != "done":
        report.failures.append(f"job failed: {outcome.error_code}")
        return report
    public = outcome.public or {}
    report.kind = public.get("kind")
    kinds = expect.get("kind", "proposal")
    kinds = kinds if isinstance(kinds, list) else [kinds]
    if report.kind not in kinds:
        report.failures.append(f"kind {report.kind}, expected {'/'.join(kinds)}")
    if report.kind == "proposal":
        report.issues = len(public.get("issues") or [])
        if expect.get("compiles_clean", True) and report.issues:
            report.failures.append("issues left: " + "; ".join(
                i["code"] for i in public["issues"][:5]))
        compiled = outcome.compiled
        for call in expect.get("calls", []):
            report.calls_total += 1
            if compiled is None or not compiled.ok:
                report.failures.append(f"{call.get('name', 'call')}: the proposal does not "
                                       "compile")
                continue
            problems = check_call(call, compiled, public["draft_graph"])
            report.failures += problems
            report.calls_ok += not problems
    report.passed = not report.failures
    return report


async def run_case(doc: dict, case: dict, call_ted: pipeline.CallTed) -> CaseReport:
    ctx = doc["contexts"][case["context"]]
    outcome = await pipeline.run(context_input(ctx, case), call_ted)
    return evaluate(case, outcome)


async def run_cases(doc: dict, *, only: Optional[set[str]] = None,
                    call_ted: Optional[pipeline.CallTed] = None, out: TextIO = sys.stdout,
                    as_json: bool = False, verbose: bool = False) -> list[CaseReport]:
    call = call_ted or ted_client.call
    reports = []
    for case in doc["cases"]:
        if only and case["id"] not in only:
            continue
        report = await run_case(doc, case, call)
        reports.append(report)
        if not as_json:
            calls = f" calls={report.calls_ok}/{report.calls_total}" if report.calls_total else ""
            print(f"{'PASS' if report.passed else 'FAIL'}  {report.id:<34} "
                  f"{report.kind or '-':<12} rounds={report.rounds} issues={report.issues}"
                  f"{calls}", file=out)
            if verbose or not report.passed:
                for failure in report.failures:
                    print(f"      - {failure}", file=out)
    passed = sum(r.passed for r in reports)
    if as_json:
        json.dump({"passed": passed, "total": len(reports),
                   "cases": [r.__dict__ for r in reports]}, out, indent=2)
        print(file=out)
    else:
        calls_ok = sum(r.calls_ok for r in reports)
        calls_total = sum(r.calls_total for r in reports)
        print(f"\n{passed}/{len(reports)} cases passed; simulated calls "
              f"{calls_ok}/{calls_total} reached their expected exit", file=out)
    return reports


def main(argv: Optional[list[str]] = None, *, call_ted: Optional[pipeline.CallTed] = None,
         out: TextIO = sys.stdout) -> int:
    parser = argparse.ArgumentParser(prog="python -m services.ivr.assist.eval",
                                     description="Run the Flow assistant eval cases against TED.")
    parser.add_argument("--cases", required=True,
                        help="the eval case file, or - to read it from stdin")
    parser.add_argument("--only", default="", help="comma-separated case ids")
    parser.add_argument("--json", action="store_true", help="print a JSON report")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    if call_ted is None and not config.ted_configured():
        print("TED_BASE_URL and TED_IVR_ASSIST_TOKEN must be set (TED's public URL and the "
              "assist token, from the TED runbook).", file=sys.stderr)
        return 2
    try:
        text = sys.stdin.read() if args.cases == "-" else open(args.cases, encoding="utf-8").read()
        doc = load_cases(text)
    except (OSError, ValueError) as exc:
        print(f"could not read the cases: {exc}", file=sys.stderr)
        return 2
    only = {x.strip() for x in args.only.split(",") if x.strip()} or None
    reports = asyncio.run(run_cases(doc, only=only, call_ted=call_ted, out=out,
                                    as_json=args.json, verbose=args.verbose))
    return 0 if reports and all(r.passed for r in reports) else 1


if __name__ == "__main__":
    sys.exit(main())
