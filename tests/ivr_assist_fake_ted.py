"""A fake TED for the Flow assistant tests (no network): an ``httpx.MockTransport``.

It plays TED's side of docs/IVR_ASSIST_INTERFACES.md §1-§3 strictly:
  * checks the wire (POST, path, the dedicated token header, Content-Type,
    User-Agent, X-Request-Id == the payload's request_id, body = exactly
    ``{"v": 1, "payload_b64": ...}`` with base64url WITHOUT padding);
  * decodes the payload and validates it against the normative request
    schema (+ ``base`` against the alias graph) — 400 ``bad_request`` if not;
  * records every decoded request (``requests``) for assertions;
  * answers with ``script(payload)``: a ``result`` dict (wrapped in the 200
    envelope with the request_id echoed and a ``meta`` block), or a tuple
    ``(status, body)`` for an error / a hand-made response.

``scripted_result`` is TED's scripted provider (contract §9), usable as a
script: ``?`` -> clarify, ``#cannot`` -> cannot_build, else Start -> Play NP1
-> Menu NP2 with keys 1..k for the first k <= 9 usable destinations.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any, Callable, Optional, Union

import httpx

API_SRC = Path(__file__).resolve().parents[1] / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from services.ivr.assist import schema  # noqa: E402

TOKEN = "test-assist-token-0123456789abcdef"
BASE_URL = "https://ted.invalid"
PATH = "/api/triggers/crag/ivr-assist"

Script = Callable[[dict], Union[dict, tuple]]


def envelope(payload: dict, result: dict, attempts: int = 1) -> dict:
    return {"v": 1, "request_id": payload["request_id"], "result": result,
            "meta": {"model": "scripted", "prompt_version": "crag-ivr-assist/1",
                     "attempts": attempts, "input_tokens": 100, "output_tokens": 50}}


def scripted_result(payload: dict) -> dict:
    """TED's deterministic scripted provider (contract §9)."""
    message = payload["message"]
    if "?" in message:
        return {"kind": "clarify", "question": "Which number should billing ring?"}
    if "#cannot" in message:
        return {"kind": "cannot_build", "message": "I can only build call menus."}
    usable = [d for d in payload["destinations"] if d["enabled"] and not d["this_flow"]][:9]
    nodes = [{"id": "n_start", "type": "entry", "config": {}},
             {"id": "n_hello", "type": "play", "config": {"prompts": ["NP1"]}}]
    edges = [{"source": "n_start", "sourceHandle": "next", "target": "n_hello"}]
    new_prompts = [{"key": "NP1", "name": "Greeting", "text": "Thanks for calling."}]
    if not usable:
        nodes.append({"id": "n_bye", "type": "hangup", "config": {}})
        edges.append({"source": "n_hello", "sourceHandle": "next", "target": "n_bye"})
    else:
        digits = [str(i + 1) for i in range(len(usable))]
        nodes.append({"id": "n_menu", "type": "menu",
                      "config": {"prompts": ["NP2"], "digits": digits}})
        nodes.append({"id": "n_bye", "type": "hangup", "config": {}})
        edges += [{"source": "n_hello", "sourceHandle": "next", "target": "n_menu"},
                  {"source": "n_menu", "sourceHandle": "noInput", "target": "n_bye"},
                  {"source": "n_menu", "sourceHandle": "noMatch", "target": "n_bye"}]
        for i, d in enumerate(usable):
            nid = f"n_d{i + 1}"
            if d["product"] == "voicemail":
                nodes.append({"id": nid, "type": "voicemail", "config": {"mailbox": d["alias"]}})
            else:
                nodes.append({"id": nid, "type": "dial",
                              "config": {"target": {"kind": "own", "ref": d["alias"]}}})
            edges.append({"source": "n_menu", "sourceHandle": f"d:{i + 1}", "target": nid})
        new_prompts.append({"key": "NP2", "name": "Main menu", "text": "Please choose."})
    return {"kind": "proposal", "graph": {"nodes": nodes, "edges": edges},
            "new_prompts": new_prompts, "summary": "A greeting and a menu.", "assumptions": []}


class FakeTed:
    def __init__(self, script: Optional[Script] = None, token: str = TOKEN):
        self.script: Script = script or scripted_result
        self.token = token
        self.requests: list[dict] = []
        self.wire: list[httpx.Request] = []

    def reset(self, script: Optional[Script] = None) -> None:
        self.script = script or scripted_result
        self.requests.clear()
        self.wire.clear()

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @staticmethod
    def _error(status: int, code: str, message: str = "", **extra) -> httpx.Response:
        return httpx.Response(status, json={"error": code, "message": message or code, **extra})

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.wire.append(request)
        assert request.method == "POST"
        assert request.url.path == PATH, request.url
        if request.headers.get("X-TED-Trigger-Token") != self.token:
            return self._error(401, "unauthorized")
        assert request.headers["Content-Type"] == "application/json"
        assert request.headers["User-Agent"] == "crag-ivr-assist/1"
        body = json.loads(request.content)
        assert set(body) == {"v", "payload_b64"} and body["v"] == 1, body
        b64 = body["payload_b64"]
        assert "=" not in b64 and "+" not in b64 and "/" not in b64, "base64url, no padding"
        payload = json.loads(base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)))
        assert request.headers["X-Request-Id"] == payload["request_id"]
        problems = schema.request_errors(payload)
        if problems:
            return self._error(400, "bad_request", "; ".join(problems))
        self.requests.append(payload)
        answer = self.script(payload)
        if isinstance(answer, tuple):
            status, out = answer
            if isinstance(out, (bytes, str)):
                return httpx.Response(status, content=out)
            return httpx.Response(status, json=out)
        return httpx.Response(200, json=envelope(payload, answer),
                              headers={"Cache-Control": "no-store"})


def configure_env(monkeypatch, *, enabled: bool = True) -> None:
    """Point the assistant at the fake TED (the token is fake too)."""
    monkeypatch.setenv("IVR_ASSIST_ENABLED", "true" if enabled else "false")
    monkeypatch.setenv("TED_BASE_URL", BASE_URL)
    monkeypatch.setenv("TED_IVR_ASSIST_TOKEN", TOKEN)
    monkeypatch.setenv("IVR_ASSIST_TED_TIMEOUT_SECONDS", "10")


def any_value(obj: Any):
    """Every string inside a JSON-like value (for leak scans)."""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from any_value(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from any_value(v)
