"""CRAG -> TED client for the Flow assistant (contract docs/IVR_ASSIST_INTERFACES.md §1).

    POST {TED_BASE_URL}/api/triggers/crag/ivr-assist
    X-TED-Trigger-Token: <TED_IVR_ASSIST_TOKEN>
    Content-Type: application/json
    User-Agent: crag-ivr-assist/1
    X-Request-Id: <request_id>

    {"v": 1, "payload_b64": "<base64url, no padding, of the UTF-8 JSON request>"}

The request is validated against ``assist_request.schema.json`` (+ ``base``
against the alias graph) BEFORE it is sent — an invalid request is a CRAG bug
and never leaves. A 200 body is validated against ``assist_response.schema.json``
(+ a proposal's ``graph`` against the alias graph) and must echo our
``request_id``. Every other outcome raises ``TedError`` carrying the JOB error
code of §1.1:

    400 bad_request / 409 request_id_reused / 413 too_large / 502 model_no_result
        -> assistant_failed
    401 unauthorized            -> assistant_unavailable (logged at ERROR)
    429 budget_exhausted | busy -> assistant_busy (retry_after_s passed through)
    503 disabled | model_unavailable, timeouts, network errors, other 5xx
        -> assistant_unavailable
    any other status, a non-JSON / invalid 200 body -> assistant_failed

The token is read from the environment for each call and only ever placed in
the request header: it is never logged, never part of an exception message,
never echoed to a client. TED's own error ``message`` is operator-readable
and is logged (truncated), never shown to a customer.
"""
from __future__ import annotations

import base64
import json
import logging
import time
from typing import Any, Optional

import httpx

from services.ivr.assist import config, schema

logger = logging.getLogger(__name__)

#: Test seam: an httpx transport (e.g. ``httpx.MockTransport``) used instead
#: of the network. Production never sets it.
TRANSPORT: Optional[httpx.AsyncBaseTransport] = None

UNAVAILABLE = "assistant_unavailable"
BUSY = "assistant_busy"
FAILED = "assistant_failed"

_FAILED_STATUSES = {400, 409, 413, 502}


class TedError(Exception):
    """A TED call that produced no usable response. ``code`` is the job error code."""

    def __init__(self, code: str, reason: str, *, http_status: Optional[int] = None,
                 retry_after_s: Optional[int] = None):
        super().__init__(f"{code}: {reason}")
        self.code = code
        self.reason = reason
        self.http_status = http_status
        self.retry_after_s = retry_after_s


def encode_payload(payload: dict) -> str:
    """base64url (no padding) of the UTF-8 JSON payload (§1)."""
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode_payload(payload_b64: str) -> dict:
    """The inverse of ``encode_payload`` (TED's side; used by tests and the fake)."""
    pad = "=" * (-len(payload_b64) % 4)
    return json.loads(base64.urlsafe_b64decode(payload_b64 + pad).decode("utf-8"))


def request_body(payload: dict) -> bytes:
    return json.dumps({"v": 1, "payload_b64": encode_payload(payload)},
                      separators=(",", ":")).encode("ascii")


def _safe(text: Any, limit: int = 200) -> str:
    s = text if isinstance(text, str) else ""
    return "".join(ch if ch.isprintable() else " " for ch in s)[:limit]


def _retry_after(body: Any, headers: httpx.Headers) -> Optional[int]:
    value = body.get("retry_after_s") if isinstance(body, dict) else None
    if isinstance(value, bool) or not isinstance(value, int):
        try:
            value = int(headers.get("retry-after", ""))
        except ValueError:
            value = None
    if value is None:
        return None
    return min(max(value, 1), 86_400)


async def call(payload: dict) -> dict:
    """Send one assist request; return the validated 200 body or raise TedError."""
    url, token = config.ted_url(), config.ted_token()
    if url is None or token is None:
        raise TedError(UNAVAILABLE, "TED is not configured")
    request_id = payload.get("request_id", "")
    problems = schema.request_errors(payload)
    if problems:
        logger.error("ivr assist: refusing to send an invalid request %s (%s)", request_id,
                     "; ".join(problems[:3]))
        raise TedError(FAILED, "invalid request (CRAG)")
    body = request_body(payload)
    if len(body) > config.MAX_ENCODED_BODY_BYTES:
        logger.warning("ivr assist: request %s is %d bytes (> %d) — not sent", request_id,
                       len(body), config.MAX_ENCODED_BODY_BYTES)
        raise TedError(FAILED, "request too large")
    headers = {"X-TED-Trigger-Token": token, "Content-Type": "application/json",
               "User-Agent": config.USER_AGENT, "X-Request-Id": request_id}
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=config.ted_timeout_s(), transport=TRANSPORT,
                                     follow_redirects=False) as client:
            resp = await client.post(url, content=body, headers=headers)
    except httpx.TimeoutException as exc:
        logger.warning("ivr assist: TED request %s timed out (%s)", request_id,
                       type(exc).__name__)
        raise TedError(UNAVAILABLE, "timeout") from None
    except httpx.HTTPError as exc:
        logger.warning("ivr assist: TED request %s failed (%s)", request_id,
                       type(exc).__name__)
        raise TedError(UNAVAILABLE, "network error") from None
    ms = int((time.monotonic() - started) * 1000)
    status = resp.status_code
    try:
        data: Any = resp.json()
    except ValueError:
        data = None
    if status != 200:
        ted_error = data.get("error") if isinstance(data, dict) else None
        ted_message = data.get("message") if isinstance(data, dict) else None
        log = logger.error if status == 401 else logger.warning
        log("ivr assist: TED request %s round=%s -> HTTP %s %s in %d ms: %s", request_id,
            payload.get("round"), status, _safe(ted_error, 40), ms, _safe(ted_message))
        if status == 401:
            raise TedError(UNAVAILABLE, "TED rejected the assist token", http_status=401)
        if status == 429:
            raise TedError(BUSY, _safe(ted_error, 40) or "busy", http_status=429,
                           retry_after_s=_retry_after(data, resp.headers))
        if status in _FAILED_STATUSES:
            raise TedError(FAILED, _safe(ted_error, 40) or f"HTTP {status}", http_status=status)
        if status == 503 or status >= 500:
            raise TedError(UNAVAILABLE, _safe(ted_error, 40) or f"HTTP {status}",
                           http_status=status)
        raise TedError(FAILED, f"HTTP {status}", http_status=status)
    if data is None:
        logger.warning("ivr assist: TED request %s -> 200 with a non-JSON body", request_id)
        raise TedError(FAILED, "non-JSON response", http_status=200)
    problems = schema.response_errors(data)
    if problems:
        logger.warning("ivr assist: TED request %s -> 200 that fails the response schema (%s)",
                       request_id, "; ".join(problems[:3]))
        raise TedError(FAILED, "invalid response", http_status=200)
    if data["request_id"] != request_id:
        logger.warning("ivr assist: TED answered request %s with request_id %s", request_id,
                       _safe(data["request_id"], 40))
        raise TedError(FAILED, "request_id mismatch", http_status=200)
    meta = data["meta"]
    logger.info("ivr assist: TED request %s round=%s -> %s in %d ms (attempts=%s, "
                "prompt=%s, tokens in/out=%s/%s)", request_id, payload.get("round"),
                data["result"]["kind"], ms, meta.get("attempts"), _safe(meta.get("prompt_version"), 64),
                meta.get("input_tokens"), meta.get("output_tokens"))
    return data
