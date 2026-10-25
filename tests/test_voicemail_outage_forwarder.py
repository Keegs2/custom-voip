"""docker/vm-forwarder/forwarder.py — the spool replayer (no keys, stdlib).

Drives the REAL module against a temp spool and a real local HTTP server that
plays the API. Proves:
  * the request: POST /v1/voicemail/fs/deposit-sealed, the .cms bytes as the
    body, X-VM-Meta = base64url of the sidecar's EXACT bytes, the ingest
    secret read from the header file (never logged), octet-stream;
  * the response table: 201/200 stored|duplicate -> deleted; 410 -> deleted
    + journaled; 422 -> rejected/ + journaled; 503 / 5xx / 401 / 404 /
    network error / a 2xx without a status -> kept, global backoff, the pass
    stops at the first failure; oldest received_at first; after a NETWORK
    failure the GET / probe retries as soon as East answers, after an HTTP
    failure the full backoff holds;
  * caps: older than 7 days -> dropped (pending AND rejected) + journaled;
    over the byte cap -> oldest rejected first, then oldest pending,
    journaled; leftovers after an hour (.tmp, lone .json deleted, lone .cms
    -> rejected/); a bad sidecar -> rejected/;
  * nothing is sent without a valid header file / API_HOST;
  * the journal and logs carry no caller number or name;
  * /metrics gauges (depth, bytes, oldest age, counters) and /healthz.

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_voicemail_outage_forwarder.py -q
"""
from __future__ import annotations

import base64
import importlib.util
import json
import logging
import os
import threading
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

FORWARDER = Path(__file__).resolve().parents[1] / "docker" / "vm-forwarder" / "forwarder.py"
SECRET = "s3cr3t-" + "x" * 40


def load_module():
    spec = importlib.util.spec_from_file_location("vm_forwarder_under_test", FORWARDER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fwd = load_module()


class FakeAPI:
    """Answers each msg_uuid from a script: {uuid: [(status, body), ...]}."""

    def __init__(self):
        self.requests = []
        self.script: dict[str, list] = {}
        self.default = (201, {"status": "stored", "message_id": 1})
        api = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n)
                meta = self.headers.get("X-VM-Meta", "")
                raw = base64.urlsafe_b64decode(meta + "=" * (-len(meta) % 4)) if meta else b""
                u = json.loads(raw).get("msg_uuid") if raw else None
                api.requests.append({"path": self.path, "headers": dict(self.headers),
                                     "body": body, "meta_raw": raw, "uuid": u})
                steps = api.script.get(u)
                status, payload = steps.pop(0) if steps else api.default
                out = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def log_message(self, *a):
                return

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.05},
                         daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


@pytest.fixture
def api():
    a = FakeAPI()
    yield a
    a.close()


class Env:
    def __init__(self, tmp: Path, port: int, monkeypatch):
        self.spool = tmp / "spool"
        self.spool.mkdir()
        self.header = tmp / "vm_ingest.header"
        self.header.write_text(f"X-Ingest-Secret: {SECRET}\n")
        monkeypatch.setenv("VM_SPOOL_DIR", str(self.spool))
        monkeypatch.setenv("VM_INGEST_HEADER_FILE", str(self.header))
        monkeypatch.setenv("API_HOST", "127.0.0.1")
        monkeypatch.setenv("API_PORT", str(port))
        monkeypatch.setenv("VM_FORWARDER_METRICS_PORT", "0")
        monkeypatch.setenv("VM_FORWARDER_HTTP_TIMEOUT_S", "5")
        self.now = datetime.now(timezone.utc).timestamp()
        self.monkeypatch = monkeypatch

    def forwarder(self, **env):
        for k, v in env.items():
            self.monkeypatch.setenv(k, str(v))
        f = fwd.Forwarder(fwd.Config(), clock=lambda: self.now)
        f.prepare()
        return f

    def put(self, *, age_s: float = 60, size: int = 1000, where: str = "", mailbox_id: int = 7,
            sidecar: bytes | None = None, u: str | None = None) -> str:
        u = u or str(uuid.uuid4())
        d = self.spool / where if where else self.spool
        received = datetime.fromtimestamp(self.now - age_s, timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
        meta = {"v": 1, "msg_uuid": u, "mailbox_id": mailbox_id, "did": "+16175550000",
                "caller_number": "+15085551212", "caller_name": "Jane Caller",
                "received_at": received, "duration_ms": 2000, "zone": "west"}
        (d / f"{u}.json").write_bytes(sidecar if sidecar is not None else
                                      json.dumps(meta, sort_keys=True, separators=(",", ":")).encode())
        (d / f"{u}.cms").write_bytes(b"\x30\x82" + os.urandom(size))
        return u

    def names(self, sub: str = "") -> set[str]:
        d = self.spool / sub if sub else self.spool
        return {p.name for p in d.iterdir() if p.is_file()}

    def journal(self) -> list[dict]:
        p = self.spool / "audit" / "spool-audit.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


@pytest.fixture
def env(tmp_path, api, monkeypatch):
    return Env(tmp_path, api.port, monkeypatch)


def test_request_shape_and_stored(env, api):
    u = env.put()
    sidecar = (env.spool / f"{u}.json").read_bytes()
    blob = (env.spool / f"{u}.cms").read_bytes()
    f = env.forwarder()
    f.run_once()
    assert len(api.requests) == 1
    r = api.requests[0]
    assert r["path"] == "/v1/voicemail/fs/deposit-sealed"
    assert r["headers"]["X-Ingest-Secret"] == SECRET
    assert r["headers"]["Content-Type"] == "application/octet-stream"
    assert "=" not in r["headers"]["X-VM-Meta"]
    assert r["meta_raw"] == sidecar, "X-VM-Meta must be the sidecar's exact bytes"
    assert r["body"] == blob
    assert env.names() == set(), "delivered pair must be deleted"
    assert f.forwarded["stored"] == 1 and f.backoff_s == 0


def test_response_table(env, api):
    s, d, g, rj = (env.put(age_s=400), env.put(age_s=300), env.put(age_s=200), env.put(age_s=100))
    api.script = {s: [(201, {"status": "stored", "message_id": 1})],
                  d: [(200, {"status": "duplicate", "message_id": 1})],
                  g: [(410, {"detail": "dropped: mailbox_deleted"})],
                  rj: [(422, {"detail": "bad_blob: authentication tag mismatch"})]}
    f = env.forwarder()
    f.run_once()
    assert [r["uuid"] for r in api.requests] == [s, d, g, rj], "oldest first"
    assert env.names() == set()
    assert env.names("rejected") == {f"{rj}.cms", f"{rj}.json"}
    events = [(e["event"], e["msg_uuid"]) for e in env.journal()]
    assert ("api_dropped_410", g) in events and ("api_rejected_422", rj) in events
    assert f.forwarded == {"stored": 1, "duplicate": 1, "dropped": 1, "rejected": 1}


@pytest.mark.parametrize("answer", [(503, {"detail": "busy"}), (500, b"oops"), (401, {"detail": "x"}),
                                    (404, {"detail": "Not Found"}), (200, {"detail": "proxy page"}),
                                    (201, b"not json")])
def test_transient_keeps_and_backs_off(env, api, answer):
    first, second = env.put(age_s=200), env.put(age_s=100)
    api.script = {first: [answer]}
    f = env.forwarder()
    f.run_once()
    assert [r["uuid"] for r in api.requests] == [first], "the pass stops at the first failure"
    assert env.names() == {f"{first}.cms", f"{first}.json", f"{second}.cms", f"{second}.json"}
    assert 4 <= f.next_attempt - env.now <= 6.5 and f.send_failures == 1
    f.run_once()                       # still backing off: nothing sent
    assert len(api.requests) == 1
    env.now += 10
    f.run_once()                       # backoff over: both go
    assert [r["uuid"] for r in api.requests][1:] == [first, second]
    assert env.names() == set()


def test_backoff_grows_and_caps(env, api):
    u = env.put()
    api.script = {u: [(503, {})] * 20}
    f = env.forwarder(VM_FORWARDER_BACKOFF_MIN_S=5, VM_FORWARDER_BACKOFF_MAX_S=40)
    seen = []
    for _ in range(6):
        f.run_once()
        seen.append(f.backoff_s)
        env.now = f.next_attempt + 0.01
    assert seen == [5, 10, 20, 40, 40, 40]


def test_network_error_keeps(env, api, monkeypatch):
    u = env.put()
    api.close()
    f = env.forwarder()
    f.run_once()
    assert env.names() == {f"{u}.cms", f"{u}.json"} and f.api_reachable == 0
    assert f.send_failures == 1 and f.last_failure_network


def test_probe_cuts_the_backoff_short_after_a_network_failure(env, api, monkeypatch):
    """East unreachable -> long backoff; the cheap GET / probe retries the
    queue as soon as East answers again (not up to 6 min later)."""
    u = env.put()
    f = env.forwarder(VM_FORWARDER_BACKOFF_MIN_S=200)
    good_port = f.cfg.api_port
    f.cfg.api_port = "1"                       # nothing listens: connection refused
    f.run_once()
    assert f.send_failures == 1 and f.last_failure_network and f.next_attempt - env.now > 100
    env.now += 5
    f.run_once()                               # probe < scan interval since the failure? no: first probe
    assert len(api.requests) == 0              # probe failed (still the dead port)
    f.cfg.api_port = good_port                 # East is back
    env.now += 10
    f.run_once()
    assert [r["uuid"] for r in api.requests] == [u], "retried right after the probe answered"
    assert env.names() == set() and f.backoff_s == 0


def test_no_probe_shortcut_after_an_http_failure(env, api):
    u = env.put()
    api.script = {u: [(503, {"detail": "Spool key is not configured; retry later."})]}
    f = env.forwarder(VM_FORWARDER_BACKOFF_MIN_S=200)
    f.run_once()
    assert not f.last_failure_network
    for _ in range(5):
        env.now += 10
        f.run_once()
    assert len(api.requests) == 1, "the API answered 503: keep the full backoff"


@pytest.mark.parametrize("header", [None, "Authorization: x\n", "X-Ingest-Secret: short\n"])
def test_nothing_sent_without_a_valid_secret(env, api, header):
    u = env.put()
    if header is None:
        env.header.unlink()
    else:
        env.header.write_text(header)
    f = env.forwarder()
    f.run_once()
    assert api.requests == [] and env.names() == {f"{u}.cms", f"{u}.json"}


def test_nothing_sent_without_a_valid_api_host(env, api):
    u = env.put()
    f = env.forwarder(API_HOST="10.0.0.1;id")
    f.run_once()
    assert api.requests == [] and env.names() == {f"{u}.cms", f"{u}.json"}


def test_age_cap_drops_pending_and_rejected(env, api):
    (env.spool / "rejected").mkdir()
    old = env.put(age_s=8 * 86400)
    old_rej = env.put(age_s=9 * 86400, where="rejected")
    fresh = env.put(age_s=6 * 86400)
    api.default = (503, {})
    f = env.forwarder()
    f.run_once()
    assert env.names() == {f"{fresh}.cms", f"{fresh}.json"}
    assert env.names("rejected") == set()
    events = {(e["event"], e["msg_uuid"], e.get("where")) for e in env.journal()}
    assert ("dropped_age", old, "pending") in events and ("dropped_age", old_rej, "rejected") in events
    assert f.dropped["age"] == 2


def test_size_cap_oldest_first_rejected_before_pending(env, api):
    (env.spool / "rejected").mkdir()
    big = 600_000
    r_old = env.put(age_s=500, size=big, where="rejected")
    p_old = env.put(age_s=400, size=big)
    p_mid = env.put(age_s=300, size=big)
    p_new = env.put(age_s=200, size=big)
    api.default = (503, {})
    per = big + 2 + len((env.spool / f"{p_old}.json").read_bytes())
    f = env.forwarder(VM_SPOOL_MAX_BYTES=2 * per + 10)   # room for two pairs only (>= 1 MiB floor)
    f.run_once()
    assert env.names("rejected") == set()
    assert env.names() == {f"{p_mid}.cms", f"{p_mid}.json", f"{p_new}.cms", f"{p_new}.json"}
    dropped = [(e["msg_uuid"], e["where"]) for e in env.journal() if e["event"] == "dropped_size"]
    assert dropped == [(r_old, "rejected"), (p_old, "pending")]


def test_leftovers_and_bad_sidecar(env, api):
    old = env.now - 7200
    lone_cms, lone_json, fresh_tmp = (str(uuid.uuid4()) for _ in range(3))
    (env.spool / f"{lone_cms}.cms").write_bytes(b"x")
    (env.spool / f"{lone_json}.json").write_bytes(b"{}")
    (env.spool / f"{lone_cms}.cms.tmp").write_bytes(b"x")
    (env.spool / f"{fresh_tmp}.json.tmp").write_bytes(b"x")
    for n in (f"{lone_cms}.cms", f"{lone_json}.json", f"{lone_cms}.cms.tmp"):
        os.utime(env.spool / n, (old, old))
    bad = env.put(sidecar=b'{"msg_uuid":"someone-else"}')
    f = env.forwarder()
    f.run_once()
    assert env.names() == {f"{fresh_tmp}.json.tmp"}, "fresh leftovers are left alone"
    assert env.names("rejected") == {f"{lone_cms}.cms", f"{bad}.cms", f"{bad}.json"}
    events = {e["event"] for e in env.journal()}
    assert {"orphan_no_metadata", "rejected_bad_sidecar"} <= events
    assert api.requests == []


def test_journal_and_logs_carry_no_caller_data(env, api, caplog):
    caplog.set_level(logging.INFO)
    g, rj = env.put(age_s=300), env.put(age_s=200)
    api.script = {g: [(410, {"detail": "dropped: mailbox_deleted"})],
                  rj: [(422, {"detail": "bad_blob: x"})]}
    env.put(age_s=10 * 86400)
    f = env.forwarder()
    f.run_once()
    text = (env.spool / "audit" / "spool-audit.jsonl").read_text() + caplog.text
    assert "5085551212" not in text and "Jane" not in text and SECRET not in text
    assert all(set(e) >= {"ts", "event", "msg_uuid", "mailbox_id", "received_at"}
               for e in env.journal())


def test_metrics_and_health(env, api):
    env.put(age_s=3600, size=1000)
    env.put(age_s=60, size=1000)
    api.default = (503, {})
    f = env.forwarder()
    f.run_once()
    text = f.metrics_text()
    assert 'vm_spool_messages{state="pending"} 2' in text
    assert 'vm_spool_messages{state="rejected"} 0' in text
    oldest = [ln for ln in text.splitlines() if ln.startswith("vm_spool_oldest_age_seconds ")]
    assert len(oldest) == 1 and 3599 <= float(oldest[0].split()[1]) <= 3601, oldest
    assert "vm_spool_send_failures_total 1" in text
    assert "vm_spool_api_reachable 1" in text
    for line in text.splitlines():
        assert line.startswith("#") or len(line.split(" ")) == 2, line
    assert f.healthy()
    # the real HTTP endpoint
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    f.cfg.metrics_port = port
    srv = fwd.serve_metrics(f)
    try:
        body = urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=3).read().decode()
        assert "vm_spool_messages" in body
        assert urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=3).status == 200
    finally:
        srv.shutdown()
        srv.server_close()


def test_spool_dirs_are_private(env, api):
    env.forwarder()
    for d in (env.spool, env.spool / "rejected", env.spool / "audit"):
        assert (d.stat().st_mode & 0o777) == 0o700
