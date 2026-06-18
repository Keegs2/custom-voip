"""
Tests for the recording webhook harness (docker/webhook-test/corpus_server.py).

Proves the harness does the two things Phase 0 needs for cross-phase diffing:
  * SERVES the committed corpus TwiML by case name.
  * RECORDS, in order, exactly what a client (the engine) fetched and POSTed:
    method, path, query, and form params.

Two layers:
  1. In-process: drive CorpusRecorder.handle() with the exact request sequence
     voice_webhook.lua issues for an IVR (initial fetch -> Gather digit -> action),
     and assert the recording captures order/method/params.
  2. Over real HTTP (stdlib only): boot the threaded server, POST with urllib,
     assert the served body matches the corpus and the form params were recorded.

No Flask / third-party deps required.
"""
import json
import sys
import urllib.request
from pathlib import Path

import pytest

_HARNESS_DIR = Path(__file__).resolve().parents[2] / "docker" / "webhook-test"
sys.path.insert(0, str(_HARNESS_DIR))
import corpus_server as cs  # noqa: E402

CORPUS_DIR = Path(__file__).resolve().parent / "corpus"


@pytest.fixture
def recorder():
    return cs.CorpusRecorder(CORPUS_DIR)


def test_corpus_loaded(recorder):
    assert "gather_with_say_prompt" in recorder.cases
    assert "say_basic" in recorder.cases
    assert len(recorder.cases) >= 30


def test_serves_corpus_twiml(recorder):
    status, ctype, body = recorder.handle("POST", "/twiml/say_basic", {})
    assert status == 200
    assert "application/xml" in ctype
    assert body == recorder.cases["say_basic"]
    assert "<Say>Hello world</Say>" in body


def test_unknown_case_404(recorder):
    status, _, _ = recorder.handle("POST", "/twiml/does_not_exist", {})
    assert status == 404


def test_records_ivr_flow_in_order(recorder):
    """Simulate the exact request sequence voice_webhook.lua makes for an IVR:
    initial fetch (CallStatus=ringing) -> engine collects a digit -> POST to the
    Gather action URL with Digits. Assert method/params/order are recorded."""
    recorder.program("/handle-key",
                     "<Response><Say>You pressed one</Say><Hangup/></Response>")

    # 1) Initial instruction fetch to the voice_url (engine sends CallStatus=ringing).
    recorder.handle("POST", "/twiml/gather_with_say_prompt", {
        "CallSid": "abc-123", "AccountSid": "7", "From": "+15550001111",
        "To": "+15557654321", "CallStatus": "ringing", "Direction": "inbound",
    })
    # 2) Gather collected digit '1' -> engine POSTs to the action URL with Digits.
    status, _, body = recorder.handle("POST", "/handle-key", {
        "CallSid": "abc-123", "AccountSid": "7", "From": "+15550001111",
        "To": "+15557654321", "CallStatus": "in-progress", "Direction": "inbound",
        "Digits": "1",
    })
    assert status == 200
    assert "You pressed one" in body

    rec = recorder.recording()
    assert [r["seq"] for r in rec] == [0, 1]
    assert [r["method"] for r in rec] == ["POST", "POST"]
    assert [r["path"] for r in rec] == ["/twiml/gather_with_say_prompt", "/handle-key"]
    # Initial fetch carried the ringing status; the action carried the digit.
    assert rec[0]["params"]["CallStatus"] == "ringing"
    assert "Digits" not in rec[0]["params"]
    assert rec[1]["params"]["Digits"] == "1"
    assert rec[1]["params"]["From"] == "+15550001111"


def test_reset_clears_recording(recorder):
    recorder.handle("POST", "/twiml/say_basic", {"CallSid": "x"})
    assert len(recorder.recording()) == 1
    recorder.reset()
    assert recorder.recording() == []


def test_query_params_recorded(recorder):
    recorder.handle("GET", "/twiml/say_basic?CallSid=q1&From=%2B15550009999", {})
    rec = recorder.recording()
    assert rec[0]["query"]["CallSid"] == "q1"
    assert rec[0]["query"]["From"] == "+15550009999"


def test_over_real_http(recorder):
    """Boot the real threaded HTTP server and exercise it with urllib to prove
    end-to-end HTTP fetch+record works (this is what FreeSWITCH's curl does)."""
    import http.server
    import threading

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), cs._make_handler(recorder))
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        body = "CallSid=live-1&From=%2B15551230000&To=%2B15559990000&CallStatus=ringing"
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/twiml/say_basic",
            data=body.encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            served = resp.read().decode()
        assert resp.status == 200
        assert served == recorder.cases["say_basic"]

        # Pull the recording back over HTTP, like a cross-phase diff would.
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/__recording__", timeout=5) as resp:
            rec = json.loads(resp.read().decode())
        assert rec[-1]["method"] == "POST"
        assert rec[-1]["path"] == "/twiml/say_basic"
        assert rec[-1]["params"]["CallSid"] == "live-1"
        assert rec[-1]["params"]["CallStatus"] == "ringing"
    finally:
        server.shutdown()
