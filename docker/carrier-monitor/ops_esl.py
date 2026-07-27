#!/usr/bin/env python3
"""
ops_esl.py — minimal, READ-ONLY FreeSWITCH ESL client for the ops-agent.

The revup-ops-agent runs co-located with FreeSWITCH on the media VMs and needs to
issue a HANDFUL of read-only `api <cmd>` commands (sofia status, show channels,
uuid_dump, …) over the LOCAL Event Socket (127.0.0.1:8021). This is the same
inband/blocking auth + `api <cmd>` handshake the API's async `esl_client.py` uses,
re-implemented here **synchronously** (blocking sockets) because the ops-agent's
command handlers run on plain threads — there is no asyncio event loop in this
process, and pulling one in just for a few local socket reads would be gratuitous.

DESIGN / SAFETY
---------------
- This client exposes EXACTLY ONE public entry point, `esl_api()`, which runs a
  fixed, caller-supplied FreeSWITCH `api` verb string. The ops-agent NEVER builds
  that string from request params by concatenation — the command catalog maps each
  allow-listed command_id to a FIXED verb (optionally with ONE regex-validated
  argument, e.g. a strict-UUID for `uuid_dump`). There is deliberately NO
  free-form / passthrough command path.
- ESL `api` is request/response and read-only for the verbs we use; we do NOT use
  `bgapi`, do NOT subscribe to events, and do NOT send anything that mutates call
  state. The catalog is the security boundary; this module is just transport.
- Every failure mode (connect refused, auth reject, timeout, socket error) returns
  a structured (ok, output, error) tuple — it NEVER raises to the caller and never
  blocks longer than the supplied timeout. Robustness parity with the poller.

The ESL text protocol used here:
    1. connect TCP to host:port
    2. server sends "Content-Type: auth/request"
    3. client sends "auth <password>\n\n"
    4. server replies "+OK accepted" (or "-ERR ...")
    5. client sends "api <cmd>\n\n"
    6. server replies with a "Content-Type: api/response" event whose
       "Content-Length:" header gives the exact body length; we read that many
       bytes so the reply is captured in full (large `show channels as json`
       payloads span many TCP segments).
"""

import os
import socket


# Local ESL endpoint. FreeSWITCH runs host-networked on the media VM and the
# ops-agent is host-networked alongside it, so the Event Socket is reachable on
# the loopback of the shared host network namespace.
ESL_HOST = os.environ.get("ESL_HOST", "127.0.0.1").strip() or "127.0.0.1"
try:
    ESL_PORT = int(os.environ.get("ESL_PORT", "8021").strip() or "8021")
except (TypeError, ValueError):
    ESL_PORT = 8021
# Password: FreeSWITCH's event_socket.conf password. Same var the FS container
# uses (ESL_PASSWORD). Default matches FreeSWITCH's out-of-box "ClueCon" so a
# dev stack works, but production sets ESL_PASSWORD to a real secret.
ESL_PASSWORD = os.environ.get("ESL_PASSWORD", "ClueCon")

# Read chunk size when draining the socket.
_RECV_CHUNK = 65536


def _recv_until(sock, marker: bytes, deadline_budget: float) -> bytes:
    """
    Read from `sock` until `marker` appears in the accumulated buffer or the
    socket closes. Bounded by the socket's own timeout (set by the caller). Used
    to read the auth prompt and header blocks (which end in a blank line).
    """
    buf = b""
    while marker not in buf:
        chunk = sock.recv(_RECV_CHUNK)
        if not chunk:
            break  # peer closed
        buf += chunk
        if len(buf) > 4 * 1024 * 1024:
            break  # safety: never unbounded-buffer a header scan
    return buf


def esl_api(command: str, timeout: float = 10.0):
    """
    Run a single FreeSWITCH `api <command>` over the local Event Socket and return
    (ok: bool, output: str, error: str).

    `command` is a FIXED verb string chosen by the command catalog (never built
    from untrusted input by string interpolation). `ok` is True only when the full
    handshake succeeded and an api/response body was read; `output` is the response
    body (may be empty for a valid empty result), `error` is a short diagnostic on
    failure. Never raises.
    """
    if not command or not command.strip():
        return False, "", "empty ESL command"

    sock = None
    try:
        # A single deadline: connect + auth + command + read must all finish
        # within `timeout`. We set it as the socket timeout so any single blocking
        # op that stalls unblocks; the catalog's per-command timeout is the outer
        # bound and this matches it.
        sock = socket.create_connection((ESL_HOST, ESL_PORT), timeout=timeout)
        sock.settimeout(timeout)

        # 1) auth prompt
        prompt = _recv_until(sock, b"auth/request", timeout)
        if b"auth/request" not in prompt:
            return False, "", "ESL: no auth/request prompt"

        # 2) authenticate
        sock.sendall(b"auth " + ESL_PASSWORD.encode("utf-8", "replace") + b"\n\n")
        auth_reply = _recv_until(sock, b"\n\n", timeout)
        if b"+OK" not in auth_reply:
            # Do NOT echo the password or full reply; just a fixed diagnostic.
            return False, "", "ESL: authentication rejected"

        # 3) send the api command
        sock.sendall(b"api " + command.encode("utf-8", "replace") + b"\n\n")

        # 4) read the api/response: first the event header block (ends in a blank
        #    line), then exactly Content-Length body bytes.
        header = b""
        while b"\n\n" not in header:
            chunk = sock.recv(_RECV_CHUNK)
            if not chunk:
                break
            header += chunk
            if len(header) > 1024 * 1024:
                break  # header block should be tiny; bail if it isn't

        head_part, sep, rest = header.partition(b"\n\n")
        content_length = 0
        for line in head_part.split(b"\n"):
            if line.lower().startswith(b"content-length:"):
                try:
                    content_length = int(line.split(b":", 1)[1].strip())
                except (TypeError, ValueError):
                    content_length = 0
                break

        body = rest
        # Keep reading until we have the full declared body.
        while content_length and len(body) < content_length:
            chunk = sock.recv(_RECV_CHUNK)
            if not chunk:
                break
            body += chunk

        if content_length:
            body = body[:content_length]

        text = body.decode("utf-8", "replace")
        return True, text, ""

    except socket.timeout:
        return False, "", f"ESL: timed out after {timeout:.0f}s"
    except ConnectionRefusedError:
        return False, "", f"ESL: connection refused to {ESL_HOST}:{ESL_PORT}"
    except OSError as exc:
        return False, "", f"ESL: socket error: {exc}"
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
