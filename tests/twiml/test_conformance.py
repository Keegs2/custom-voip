"""
TwiML conformance regression baseline (Phase 0 safety net).

For every committed fixture in tests/twiml/corpus/*.json this test:

  1. Runs the REAL parser from docker/freeswitch/scripts/voice_webhook.lua
     (via lua_parser_harness.lua, which slices parse_xml out of the production
     file at run time -- no copy, no modification) over the fixture's input_xml,
     and asserts the parsed verb tree equals the committed `expected_parse`.
     => If a later phase changes the parser, the diff shows up HERE.

  2. Feeds the parsed tree through trace_model.approximate_trace() and asserts
     it equals the committed `expected_trace`.
     => Locks the documented execution semantics (fetch/POST order + params).

These are CHARACTERIZATION assertions: `expected_*` is whatever the engine does
TODAY, including the cases labeled classification="known-bug". When Phase 3 fixes
a bug, the fix flips exactly one fixture (regenerate with regen_corpus.py) and the
diff is the proof of what changed.

GAP (documented honestly): the parser runs for real; the EXECUTOR does not. The
executor needs a live FreeSWITCH session/ESL/carrier, unavailable in CI. So step
2 asserts a Python re-statement of execute_verbs (trace_model), not the engine
itself. See trace_model.py's module docstring.

Run:  python3 -m pytest tests/twiml/test_conformance.py -v
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import trace_model as tm  # noqa: E402

CORPUS_DIR = Path(__file__).resolve().parent / "corpus"
FIXTURES = sorted(CORPUS_DIR.glob("*.json"))
FIXTURE_IDS = [f.stem for f in FIXTURES]

# All 8 currently-implemented verbs (per voice_webhook.lua execute_verbs).
IMPLEMENTED_VERBS = {"Say", "Play", "Gather", "Dial", "Pause", "Hangup", "Redirect", "Reject"}

_LUA = tm.lua_available()
_requires_lua = pytest.mark.skipif(not _LUA, reason="`lua` interpreter not on PATH; cannot run the real parser")


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


@pytest.fixture(scope="module")
def corpus():
    assert FIXTURES, f"No corpus fixtures found in {CORPUS_DIR}"
    return {f.stem: _load(f) for f in FIXTURES}


@_requires_lua
@pytest.mark.parametrize("path", FIXTURES, ids=FIXTURE_IDS)
def test_real_parser_matches_committed_parse(path):
    """The live voice_webhook.lua parser output must match the committed baseline."""
    fx = _load(path)
    actual = tm.run_parser(fx["input_xml"])
    # Normalize through JSON so dict ordering / types match the committed form.
    actual = json.loads(json.dumps(actual))
    assert actual == fx["expected_parse"], (
        f"REAL parser output drifted for '{fx['name']}'.\n"
        f"  classification={fx['classification']}\n"
        f"  If this drift is an intentional Phase 3 fix, regenerate the corpus "
        f"(python3 tests/twiml/regen_corpus.py) and review the diff.\n"
        f"  expected={json.dumps(fx['expected_parse'])}\n"
        f"  actual  ={json.dumps(actual)}"
    )


@pytest.mark.parametrize("path", FIXTURES, ids=FIXTURE_IDS)
def test_trace_model_matches_committed_trace(path):
    """The execution-trace model must reproduce the committed trace from the parse.

    Runs WITHOUT lua: drives trace_model from the committed expected_parse so the
    execution semantics stay pinned even on a box with no Lua interpreter."""
    fx = _load(path)
    parse = fx["expected_parse"]
    verbs = parse["verbs"] if parse.get("ok") else []
    trace = tm.approximate_trace(verbs, fx["base_url"])
    trace = json.loads(json.dumps(trace))
    assert trace == fx["expected_trace"], (
        f"Execution-trace model drifted for '{fx['name']}'.\n"
        f"  expected={json.dumps(fx['expected_trace'])}\n"
        f"  actual  ={json.dumps(trace)}"
    )


def test_all_eight_verbs_covered(corpus):
    """The corpus must exercise every implemented verb at least once."""
    seen = set()
    for fx in corpus.values():
        parse = fx["expected_parse"]
        if not parse.get("ok"):
            continue
        for v in parse["verbs"]:
            seen.add(v["verb"])
            for c in v.get("children", []):
                seen.add(c["verb"])
    # Number appears only as a Dial child; not a top-level verb but part of coverage.
    missing = IMPLEMENTED_VERBS - seen
    assert not missing, f"Corpus does not cover these verbs: {sorted(missing)}"


def test_known_bug_cases_are_documented(corpus):
    """Every known-bug fixture must carry a non-empty `ideal` explaining the fix
    Phase 3 should make. This keeps characterization honest."""
    known_bugs = {n: fx for n, fx in corpus.items() if fx["classification"] == "known-bug"}
    assert known_bugs, "Expected at least one known-bug characterization case."
    for name, fx in known_bugs.items():
        assert fx["ideal"].strip(), f"known-bug '{name}' must document its ideal behavior"


def test_classification_values_valid(corpus):
    for name, fx in corpus.items():
        assert fx["classification"] in ("correct", "known-bug"), (
            f"{name}: bad classification {fx['classification']!r}"
        )
