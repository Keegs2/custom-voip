"""
corpus_server.py -- recording TwiML webhook harness (Phase 0 safety net).

SIBLING to webhook_server.py (which is left untouched). This module exists so we
can, across phases, point the REAL voice_webhook.lua engine at a controlled
endpoint that:

  1. SERVES the committed conformance corpus (tests/twiml/corpus/*.json) as TwiML,
     by case name:   GET|POST /twiml/<case>   ->  that case's input_xml
  2. RECORDS, in order, EXACTLY what the engine fetched and POSTed back:
     method, path, query params, and form params (the form body is how
     voice_webhook.lua sends CallSid/From/To/Digits/DialCallStatus/...).
  3. Lets you program follow-up responses for action/redirect URLs so multi-step
     flows (Gather action, Dial action, Redirect) can be driven end to end.
  4. Exposes the recording for before/after DIFFING:
     GET /__recording__   -> JSON list of recorded requests
     POST /__reset__      -> clear the recording

Zero third-party dependencies (pure stdlib http.server) so it runs on a media/
services VM next to FreeSWITCH with nothing to install, and so the Phase 0 pytest
can drive it without Flask.

The recording LOGIC lives in `CorpusRecorder` (transport-agnostic, unit-testable).
`serve()` wraps it in a threaded HTTP server.

Run standalone:
    python3 docker/webhook-test/corpus_server.py --port 9001
    # then set the API DID's voice_url to http://<host>:9001/twiml/<case>

Cross-phase diff workflow:
    1. POST /__reset__
    2. Place a test call (or many) that hit /twiml/<case>
    3. GET /__recording__ > before.json     (Phase N)
    ... apply Phase N+1 changes ...
    4. repeat -> after.json ; diff before.json after.json
"""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DEFAULT_CORPUS_DIR = Path(__file__).resolve().parents[2] / "tests" / "twiml" / "corpus"
_EMPTY_RESPONSE = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response/>"


class CorpusRecorder:
    """Transport-agnostic core: loads the corpus, records requests, serves TwiML."""

    def __init__(self, corpus_dir: Path = DEFAULT_CORPUS_DIR):
        self.corpus_dir = Path(corpus_dir)
        self.cases = self._load_cases()
        self._lock = threading.Lock()
        self.records = []          # ordered list of recorded requests
        self.programmed = {}       # path -> xml body (for action/redirect follow-ups)

    def _load_cases(self) -> dict:
        cases = {}
        if self.corpus_dir.is_dir():
            for p in self.corpus_dir.glob("*.json"):
                try:
                    fx = json.loads(p.read_text())
                    cases[fx["name"]] = fx["input_xml"]
                except Exception:
                    continue
        return cases

    # -- programming follow-up responses ----------------------------------
    def program(self, path: str, xml: str):
        """Set the TwiML to return when `path` is hit (e.g. a Gather action URL)."""
        self.programmed[path] = xml

    def reset(self):
        with self._lock:
            self.records = []

    def recording(self) -> list:
        with self._lock:
            return list(self.records)

    # -- the single entry point used by any transport ---------------------
    def handle(self, method: str, full_path: str, form_params: dict) -> tuple:
        """Record the request and return (status, content_type, body).

        `form_params` and query params are normalized to {key: value} (last value
        wins, mirroring request.values semantics)."""
        parsed = urlparse(full_path)
        path = parsed.path
        query_params = {k: v[-1] for k, v in parse_qs(parsed.query).items()}

        # Control endpoints are NOT recorded (they are test machinery).
        if path == "/__recording__" and method == "GET":
            return 200, "application/json", json.dumps(self.recording())
        if path == "/__reset__" and method == "POST":
            self.reset()
            return 200, "application/json", json.dumps({"status": "reset"})
        if path == "/health" and method == "GET":
            return 200, "application/json", json.dumps({"status": "ok"})

        with self._lock:
            seq = len(self.records)
            self.records.append({
                "seq": seq,
                "method": method,
                "path": path,
                "query": query_params,
                "params": dict(form_params),
            })

        # Decide the response body.
        if path.startswith("/twiml/"):
            case = path[len("/twiml/"):]
            xml = self.cases.get(case)
            if xml is None:
                return 404, "application/xml", _EMPTY_RESPONSE
            return 200, "application/xml", xml
        if path in self.programmed:
            return 200, "application/xml", self.programmed[path]
        # Unknown path: behave like a webhook that returned an empty Response.
        return 200, "application/xml", _EMPTY_RESPONSE


def _make_handler(recorder: CorpusRecorder):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _read_form(self):
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            ctype = self.headers.get("Content-Type", "")
            if "application/x-www-form-urlencoded" in ctype:
                return {k: v[-1] for k, v in parse_qs(raw.decode("utf-8", "replace")).items()}
            if "application/json" in ctype and raw:
                try:
                    data = json.loads(raw.decode("utf-8", "replace"))
                    return {k: str(v) for k, v in data.items()} if isinstance(data, dict) else {}
                except Exception:
                    return {}
            return {}

        def _respond(self, method):
            form = self._read_form() if method == "POST" else {}
            status, ctype, body = recorder.handle(method, self.path, form)
            payload = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            self._respond("GET")

        def do_POST(self):
            self._respond("POST")

        def log_message(self, *args):
            pass  # quiet

    return Handler


def serve(port: int = 9001, corpus_dir: Path = DEFAULT_CORPUS_DIR):
    recorder = CorpusRecorder(corpus_dir)
    server = ThreadingHTTPServer(("0.0.0.0", port), _make_handler(recorder))
    print(f"corpus_server listening on :{port}; {len(recorder.cases)} corpus cases loaded")
    print("  GET|POST /twiml/<case>   serve corpus TwiML (recorded)")
    print("  GET      /__recording__  dump recorded requests")
    print("  POST     /__reset__      clear recording")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Recording TwiML webhook harness")
    ap.add_argument("--port", type=int, default=9001)
    ap.add_argument("--corpus-dir", type=Path, default=DEFAULT_CORPUS_DIR)
    args = ap.parse_args()
    serve(args.port, args.corpus_dir)
