#!/usr/bin/env python3
"""
ops_api.py — the read-only HTTP command API of revup-ops-agent.

Serves exactly two endpoints for the ted-next NOC console:

  GET  /healthz
       -> 200 {"ok": true, "host": "<os hostname>", "role": "sbc|fs|services",
               "commands": [<command_ids valid for this role>]}
       No auth (liveness + capability discovery; leaks no secrets).

  POST /run   (Authorization: Bearer <OPS_AGENT_TOKEN>)
       body {"command_id": str, "params": {...}}
       -> 200 {"command_id","host","ok","exit_code","stdout","stderr","duration_ms"}
       -> 400  unknown/invalid command_id or params
       -> 401  missing/wrong bearer token
       -> 405  wrong method / unknown path

FRAMEWORK CHOICE — stdlib http.server (ThreadingHTTPServer)
-----------------------------------------------------------
The existing poller is stdlib + `requests` only. This API keeps that posture: no
aiohttp, no FastAPI, no new runtime dependency to vet or patch on a carrier VM.
`ThreadingHTTPServer` is more than sufficient for a low-QPS, VPC-internal admin
API (a NOC console issuing occasional reads), and it is trivially auditable — the
whole request path fits on one screen. Each request is short-lived and bounded by
the per-command timeout, so a thread-per-request model can't accumulate. Threads
are fine here because the poller runs on the main thread and this server runs on a
daemon thread; they share only read-only module state (the command CATALOG + role).

SAFETY POSTURE
--------------
- Token compare is `hmac.compare_digest` and FAIL-CLOSED: if OPS_AGENT_TOKEN is
  unset/empty in the environment, EVERY /run is 401. There is no "auth disabled"
  mode. /healthz stays open (no secrets, needed for liveness/discovery).
- The handler catches everything. A bug in a command handler becomes a 500 with a
  short message, never a crashed server. The process only exits on the poller's
  SIGTERM/SIGINT path (this server is a daemon thread).
- Bind host defaults to 0.0.0.0 so the VPC-internal console can reach it; network
  exposure is controlled by a firewall rule (operator's job — documented). We bind
  a single fixed port (OPS_AGENT_PORT, default 8710).
"""

import hmac
import json
import logging
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ops_commands


LOG = logging.getLogger("ops-agent.api")

# Bind config. 0.0.0.0 so the console (another VPC host) can reach it; a firewall
# rule restricts who can. Overridable for tighter binds in special deployments.
BIND_HOST = os.environ.get("OPS_AGENT_BIND", "0.0.0.0").strip() or "0.0.0.0"
try:
    BIND_PORT = int(os.environ.get("OPS_AGENT_PORT", "8710").strip() or "8710")
except (TypeError, ValueError):
    BIND_PORT = 8710

# Max request body we will read for /run. The body is a tiny JSON object; cap it
# hard so a malformed/huge Content-Length can't make us buffer unbounded memory.
MAX_BODY_BYTES = 64 * 1024


def _hostname() -> str:
    """The agent's REAL OS hostname — the console's safety anchor (it verifies
    every response came from the box it targeted). Never fabricated."""
    try:
        return socket.gethostname()
    except OSError:
        return "unknown-host"


def _token_ok(auth_header: str) -> bool:
    """
    Constant-time bearer-token check, FAIL-CLOSED.

    Returns True only when OPS_AGENT_TOKEN is set AND the header is exactly
    'Bearer <that token>'. If the env var is unset/empty, returns False for every
    request (no token configured => no access). Uses hmac.compare_digest to avoid
    leaking length/precise-mismatch timing.
    """
    expected = os.environ.get("OPS_AGENT_TOKEN", "")
    if not expected:
        return False  # fail-closed: no configured token => reject all
    if not auth_header:
        return False
    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    presented = parts[1].strip()
    if not presented:
        return False
    return hmac.compare_digest(presented, expected)


class OpsHandler(BaseHTTPRequestHandler):
    # Advertise HTTP/1.1 but we close each connection (Connection: close below) to
    # keep the threading model simple and predictable.
    protocol_version = "HTTP/1.1"
    server_version = "revup-ops-agent/1"

    # Silence the default stderr access-log spam; route through our logger at DEBUG
    # so it doesn't drown the poller's INFO lines. (Structured line, no secrets.)
    def log_message(self, fmt, *args):  # noqa: A003 - matches base signature
        LOG.debug("http %s - %s", self.address_string(), fmt % args)

    # ---- response helpers ------------------------------------------------- #

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError) as exc:
            # Client hung up mid-response — nothing to do, just don't crash.
            LOG.debug("client dropped before response completed: %s", exc)

    # ---- routing ---------------------------------------------------------- #

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            if self.path.split("?", 1)[0] == "/healthz":
                return self._handle_healthz()
            return self._send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:  # noqa: BLE001 - never let the handler crash
            LOG.exception("unhandled error in GET %s", self.path)
            return self._send_json(500, {"ok": False, "error": str(exc)})

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            if self.path.split("?", 1)[0] == "/run":
                return self._handle_run()
            return self._send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:  # noqa: BLE001 - never let the handler crash
            LOG.exception("unhandled error in POST %s", self.path)
            return self._send_json(500, {"ok": False, "error": str(exc)})

    # ---- handlers --------------------------------------------------------- #

    def _handle_healthz(self):
        # No auth: liveness + capability discovery. Advertises ONLY the command
        # ids valid for this host's detected role.
        self._send_json(200, {
            "ok": True,
            "host": _hostname(),
            "role": ops_commands.ROLE,
            "commands": ops_commands.commands_for_role(ops_commands.ROLE),
        })

    def _read_body(self):
        """Read up to MAX_BODY_BYTES of request body. Returns bytes (maybe empty).
        Rejects an over-large declared Content-Length by reading only the cap."""
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            return b""
        to_read = min(length, MAX_BODY_BYTES)
        return self.rfile.read(to_read)

    def _handle_run(self):
        host = _hostname()

        # 1) AUTH FIRST — fail-closed bearer check before doing anything else.
        if not _token_ok(self.headers.get("Authorization", "")):
            return self._send_json(401, {
                "ok": False,
                "host": host,
                "error": "unauthorized",
            })

        # 2) Parse + validate the JSON body.
        raw = self._read_body()
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError):
            return self._send_json(400, {
                "ok": False, "host": host, "error": "invalid JSON body",
            })
        if not isinstance(data, dict):
            return self._send_json(400, {
                "ok": False, "host": host, "error": "body must be a JSON object",
            })

        command_id = data.get("command_id")
        params = data.get("params", {})
        if not isinstance(command_id, str) or not command_id:
            return self._send_json(400, {
                "ok": False, "host": host,
                "error": "command_id (string) is required",
            })
        if params is None:
            params = {}
        if not isinstance(params, dict):
            return self._send_json(400, {
                "ok": False, "host": host, "error": "params must be an object",
            })

        # 3) Dispatch. run_command raises ValueError for unknown id / role
        #    mismatch / bad params -> 400. Execution failures come back inside the
        #    result dict (ok=False), NOT as exceptions.
        try:
            result = ops_commands.run_command(
                command_id, params, ops_commands.ROLE
            )
        except ValueError as exc:
            LOG.info("rejected /run %s: %s", command_id, exc)
            return self._send_json(400, {
                "ok": False, "host": host, "command_id": command_id,
                "error": str(exc),
            })

        LOG.info(
            "ran %s ok=%s exit=%s dur=%dms",
            command_id, result["ok"], result["exit_code"], result["duration_ms"],
        )
        return self._send_json(200, {
            "command_id": command_id,
            "host": host,
            "ok": result["ok"],
            "exit_code": result["exit_code"],
            "stdout": result["stdout"],
            "stderr": result["stderr"],
            "duration_ms": result["duration_ms"],
        })


def serve_forever():
    """
    Start the HTTP API and block serving it. Intended to run on a DAEMON thread
    started by the ops-agent entrypoint; the poller owns the main thread + signal
    handling, so when the poller exits on SIGTERM the process ends and this daemon
    thread is torn down cleanly.

    Never raises out: a bind failure is logged loudly and the thread exits, but the
    poller (the agent's primary duty) keeps running — the command API being down
    must not take carrier monitoring down with it.
    """
    try:
        httpd = ThreadingHTTPServer((BIND_HOST, BIND_PORT), OpsHandler)
    except OSError as exc:
        LOG.error(
            "ops-agent API failed to bind %s:%d (%s) — command API disabled, "
            "poller continues", BIND_HOST, BIND_PORT, exc,
        )
        return

    # Daemonize worker threads so in-flight requests never block shutdown.
    httpd.daemon_threads = True
    LOG.info(
        "ops-agent API listening on %s:%d role=%s token=%s commands=%d",
        BIND_HOST, BIND_PORT, ops_commands.ROLE,
        "set" if os.environ.get("OPS_AGENT_TOKEN") else "<UNSET-FAILCLOSED>",
        len(ops_commands.commands_for_role(ops_commands.ROLE)),
    )
    try:
        httpd.serve_forever(poll_interval=0.5)
    except Exception as exc:  # noqa: BLE001 - keep the process alive regardless
        LOG.exception("ops-agent API serve loop exited unexpectedly: %s", exc)


def start_in_background() -> threading.Thread:
    """Spawn the API server on a daemon thread and return it."""
    t = threading.Thread(target=serve_forever, name="ops-api", daemon=True)
    t.start()
    return t
