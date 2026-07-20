"""
FreeSWITCH ESL (Event Socket) control plane — Phase 5.

ONE persistent, asyncio-native inbound ESL connection that does BOTH:
  * event consumption  -> drives an authoritative in-memory live-call registry
  * api/bgapi commands -> originate / hangup / transfer / dtmf / status

This replaces the old per-command "open a new TCP socket, auth, send, close"
pattern. There is now a single client pattern across the whole API (calls.py,
trunks.py, conference.py all route through this module).

switchio was evaluated and REJECTED (see PRODUCTION_READINESS_PLAN.md Decision
Log): its only PyPI releases are ancient alphas (0.1.0a0 / 0.1.0a1) that use
`@asyncio.coroutine` (removed in Python 3.11) and an undeclared `six` dep — it
cannot even import on Python 3.12. We own this client instead: zero dependency
risk, native asyncio, no event-loop conflicts.

LOCAL-ENV NOTE: on Docker Desktop (Mac), the bridge-networked API container
cannot reach the host-networked FreeSWITCH ESL — the consumer will simply retry
with backoff and report `connected: false`. This is also correct production
resilience: the API must never block startup or crash because FS is unreachable.
"""
import os
import json
import time
import uuid as uuidlib
import asyncio
import logging
from collections import deque
from dataclasses import dataclass, field, asdict
from typing import Optional, Dict, Any, Callable, Awaitable, List, Deque, Tuple
from urllib.parse import unquote

from db import redis_client as cache

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# PROD-3: cross-worker live-call registry mirror. Each uvicorn worker runs its
# own ESL consumer; FreeSWITCH broadcasts every event to every inbound ESL
# connection, so each worker's in-memory registry is already complete WHILE its
# connection is up. To stay consistent across workers even when one worker's ESL
# connection is briefly down (reconnecting), every registry update is also
# mirrored to Redis (a JSON value per call uuid + an index set, TTL'd so dead
# entries self-expire). Reads (/calls/live) union Redis with the local registry.
# Degrades gracefully to the local registry when Redis is unavailable.
# ---------------------------------------------------------------------------
_REDIS_CALL_PREFIX = "esl:call:"
_REDIS_CALL_INDEX = "esl:calls"
_REDIS_CALL_TTL = int(os.getenv("ESL_CALL_REDIS_TTL", "3600"))

# ---------------------------------------------------------------------------
# Connection settings. FS runs with host networking — the API reaches it via the
# host's VPC IP (FREESWITCH_ESL_HOST). The well-known "ClueCon" password must
# NEVER be a silent fallback (Phase 4): the secret is required from the env and
# commands fail loudly when it is unset, instead of authenticating with a public
# default. The lessons guard (tests/lessons/test_api_lessons.py) enforces both.
# ---------------------------------------------------------------------------
ESL_HOST = os.getenv("FREESWITCH_ESL_HOST", "")
ESL_PORT = int(os.getenv("FREESWITCH_ESL_PORT", "8021"))
ESL_PASSWORD = os.getenv("FREESWITCH_ESL_PASSWORD")

# Events the consumer subscribes to. BACKGROUND_JOB is required to correlate the
# async result of `bgapi originate` (originate must NOT block the shared socket).
SUBSCRIBED_EVENTS = (
    "CHANNEL_CREATE",
    "CHANNEL_ANSWER",
    "CHANNEL_HANGUP",
    "CHANNEL_EXECUTE_COMPLETE",
    "DTMF",
    "PLAYBACK_STOP",
    "BACKGROUND_JOB",
)

# Reconnect backoff bounds (seconds).
_BACKOFF_MIN = 1.0
_BACKOFF_MAX = 30.0

# How long a hung-up call lingers in the registry before it is pruned.
_HUNGUP_TTL_SEC = 300.0
_PRUNE_INTERVAL_SEC = 30.0

# Per-command timeouts.
_CONNECT_TIMEOUT = 5.0
_HANDSHAKE_TIMEOUT = 5.0
_COMMAND_TIMEOUT = 10.0
_ORIGINATE_JOB_TIMEOUT = 90.0


# ---------------------------------------------------------------------------
# ESL command-injection guard (boundary defense, defense-in-depth)
# ---------------------------------------------------------------------------
# ESL frames are newline-delimited and terminated by a blank line ("\n\n"). Any
# CR/LF (or NUL) embedded in a command component therefore lets a caller inject
# additional ESL commands. Callers (e.g. routers/calls.py) already validate their
# inputs, but this is the last line of defense so NO command with an embedded
# control char is ever written to the socket, regardless of who built it.
class ESLCommandError(ValueError):
    """Raised when a command contains illegal control characters (injection)."""


def _assert_esl_safe(command: str) -> None:
    """Reject any command containing CR, LF, or NUL before it hits the wire."""
    if command is None:
        raise ESLCommandError("ESL command must not be None")
    if "\r" in command or "\n" in command or "\x00" in command:
        raise ESLCommandError(
            "ESL command contains illegal control characters (possible injection)"
        )


# ---------------------------------------------------------------------------
# Live-call registry
# ---------------------------------------------------------------------------
@dataclass
class LiveCall:
    """Authoritative, event-derived state for one channel."""
    uuid: str
    state: str = "created"          # created | ringing | answered | hungup
    customer_id: Optional[int] = None
    product_type: Optional[str] = None
    direction: Optional[str] = None
    caller: Optional[str] = None
    dest: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    answered_at: Optional[float] = None
    hangup_at: Optional[float] = None
    hangup_cause: Optional[str] = None
    last_app: Optional[str] = None
    last_dtmf: Optional[str] = None
    updated_at: float = field(default_factory=time.time)

    def touch(self) -> None:
        self.updated_at = time.time()


# ---------------------------------------------------------------------------
# Event waiter — used for event-confirmed live-call modification
# ---------------------------------------------------------------------------
@dataclass
class _Waiter:
    predicate: Callable[[Dict[str, str]], bool]
    future: "asyncio.Future"


class ESLClient:
    """A single persistent inbound ESL connection: events + commands.

    Lifecycle:
      start()  -> spawn the supervisor task (non-blocking, never raises)
      stop()   -> cancel + close
    The supervisor reconnects forever with exponential backoff. Command methods
    (api/bgapi/originate/...) degrade to a graceful failure (None/False) while
    disconnected — they never raise on connectivity.
    """

    def __init__(
        self,
        host: str = ESL_HOST,
        port: int = ESL_PORT,
        password: Optional[str] = ESL_PASSWORD,
    ):
        self.host = host
        self.port = port
        self.password = password

        self.registry: Dict[str, LiveCall] = {}

        # Connection state
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._connected: bool = False
        self._supervisor: Optional[asyncio.Task] = None
        self._stopping: bool = False
        self._write_lock = asyncio.Lock()

        # Command correlation: FIFO of (futures) for command/reply + api/response
        self._pending: Deque["asyncio.Future"] = deque()
        # bgapi job correlation: Job-UUID -> future resolved by BACKGROUND_JOB
        self._jobs: Dict[str, "asyncio.Future"] = {}
        # Event-confirmation waiters
        self._waiters: List[_Waiter] = []

        # Health
        self.last_event_ts: Optional[float] = None
        self.last_connect_ts: Optional[float] = None
        self.last_error: Optional[str] = None
        self.reconnects: int = 0
        self._last_prune: float = 0.0

        # PROD-3: fire-and-forget Redis-mirror tasks (kept referenced so they are
        # not GC'd mid-flight). Only created when Redis is actually up.
        self._mirror_tasks: set = set()

    # ------------------------------------------------------------------ public
    @property
    def connected(self) -> bool:
        return self._connected

    def configured(self) -> bool:
        return bool(self.host and self.password)

    def start(self) -> None:
        """Spawn the supervisor task. Non-blocking; safe to call even when FS is
        unreachable or unconfigured (the task just idles/retries)."""
        if self._supervisor and not self._supervisor.done():
            return
        self._stopping = False
        self._supervisor = asyncio.create_task(self._supervise(), name="esl-consumer")

    async def stop(self) -> None:
        self._stopping = True
        if self._supervisor:
            self._supervisor.cancel()
            try:
                await self._supervisor
            except asyncio.CancelledError:
                pass
        await self._close_conn()

    def health(self) -> Dict[str, Any]:
        return {
            "configured": self.configured(),
            "connected": self._connected,
            "last_event_ts": self.last_event_ts,
            "last_connect_ts": self.last_connect_ts,
            "reconnects": self.reconnects,
            "live_calls": sum(1 for c in self.registry.values() if c.state != "hungup"),
            "tracked_calls": len(self.registry),
            "last_error": self.last_error,
        }

    def get_call(self, call_uuid: str) -> Optional[LiveCall]:
        self._prune_if_due()
        return self.registry.get(call_uuid)

    def snapshot(self) -> List[Dict[str, Any]]:
        self._prune_if_due()
        return [asdict(c) for c in self.registry.values()]

    # ------------------------------------------------------ supervisor / connect
    async def _supervise(self) -> None:
        """Connect → serve → on any failure, backoff and retry. Forever."""
        backoff = _BACKOFF_MIN
        while not self._stopping:
            if not self.configured():
                # Nothing to connect to / no secret. Idle, re-check periodically;
                # never busy-loop, never crash.
                self.last_error = "ESL not configured (host/password missing)"
                await asyncio.sleep(_BACKOFF_MAX)
                continue
            try:
                await self._connect_and_serve()
                # Clean disconnect (e.g. disconnect-notice) — reset backoff.
                backoff = _BACKOFF_MIN
            except asyncio.CancelledError:
                break
            except Exception as e:  # noqa: BLE001 — supervisor must never die
                self.last_error = f"{type(e).__name__}: {e}"
                logger.warning(
                    "ESL connection to %s:%s failed (%s) — reconnecting in %.1fs",
                    self.host, self.port, self.last_error, backoff,
                )
            finally:
                self._mark_disconnected()
            if self._stopping:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _BACKOFF_MAX)
            self.reconnects += 1

    async def _connect_and_serve(self) -> None:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(self.host, self.port), timeout=_CONNECT_TIMEOUT
        )
        self._reader, self._writer = reader, writer
        try:
            # --- handshake (synchronous reads; reader loop not running yet) ---
            headers, _ = await asyncio.wait_for(
                self._read_message(), timeout=_HANDSHAKE_TIMEOUT
            )
            if headers.get("Content-Type") != "auth/request":
                raise ConnectionError(f"unexpected greeting: {headers}")

            writer.write(f"auth {self.password}\n\n".encode())
            await writer.drain()
            headers, _ = await asyncio.wait_for(
                self._read_message(), timeout=_HANDSHAKE_TIMEOUT
            )
            if "+OK" not in headers.get("Reply-Text", ""):
                raise ConnectionError(f"ESL auth failed: {headers.get('Reply-Text')}")

            # Subscribe to the event set (plain text format).
            writer.write(f"event plain {' '.join(SUBSCRIBED_EVENTS)}\n\n".encode())
            await writer.drain()
            headers, _ = await asyncio.wait_for(
                self._read_message(), timeout=_HANDSHAKE_TIMEOUT
            )
            if "+OK" not in headers.get("Reply-Text", ""):
                raise ConnectionError(f"event subscribe failed: {headers.get('Reply-Text')}")

            self._mark_connected()
            logger.info("ESL consumer connected to %s:%s", self.host, self.port)

            # --- serve: single reader loop multiplexes events + replies ---
            await self._reader_loop()
        finally:
            await self._close_conn()

    async def _reader_loop(self) -> None:
        while not self._stopping:
            headers, body = await self._read_message()
            ctype = headers.get("Content-Type", "")

            if ctype in ("command/reply", "api/response"):
                self._resolve_command(headers, body)
            elif ctype == "text/event-plain":
                self._handle_event_block(body)
            elif ctype == "text/disconnect-notice":
                logger.info("ESL received disconnect-notice")
                return
            elif ctype == "text/rude-rejection":
                raise ConnectionError("ESL rude-rejection (ACL/auth)")
            # else: ignore (log/auth already handled in handshake)

    # ------------------------------------------------------------ wire protocol
    async def _read_message(self) -> Tuple[Dict[str, str], bytes]:
        """Read one ESL frame: a header block (until blank line), then a body of
        Content-Length bytes if present. Raises on EOF."""
        assert self._reader is not None
        headers: Dict[str, str] = {}
        while True:
            line = await self._reader.readline()
            if not line:
                raise ConnectionError("ESL EOF")
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            if text == "":
                break
            if ":" in text:
                k, v = text.split(":", 1)
                headers[k.strip()] = v.strip()
        body = b""
        clen = headers.get("Content-Length")
        if clen:
            try:
                body = await self._reader.readexactly(int(clen))
            except asyncio.IncompleteReadError as e:
                raise ConnectionError("ESL truncated body") from e
        return headers, body

    @staticmethod
    def _parse_event(body: bytes) -> Dict[str, str]:
        """Parse an event-plain payload (URL-encoded `Key: value` lines) into a
        dict. Only the leading header block is needed for our purposes."""
        event: Dict[str, str] = {}
        for raw in body.decode("utf-8", "replace").split("\n"):
            line = raw.rstrip("\r")
            if line == "":
                break  # blank line separates event headers from any event body
            if ":" in line:
                k, v = line.split(":", 1)
                event[k.strip()] = unquote(v.strip())
        return event

    # ------------------------------------------------------ command correlation
    def _resolve_command(self, headers: Dict[str, str], body: bytes) -> None:
        if not self._pending:
            return
        fut = self._pending.popleft()
        if not fut.done():
            fut.set_result((headers, body.decode("utf-8", "replace")))

    async def _send(self, line: str) -> Tuple[Dict[str, str], str]:
        """Send a raw command line and await its command/reply or api/response.
        Returns (headers, body_text). Raises if not connected."""
        if not self._connected or self._writer is None:
            raise ConnectionError("ESL not connected")
        loop = asyncio.get_running_loop()
        fut: "asyncio.Future" = loop.create_future()
        async with self._write_lock:
            self._pending.append(fut)
            self._writer.write(f"{line}\n\n".encode())
            await self._writer.drain()
        return await asyncio.wait_for(fut, timeout=_COMMAND_TIMEOUT)

    async def api(self, command: str) -> Optional[str]:
        """Blocking `api` command. Returns the response body text, or None when
        disconnected / on error. Use only for fast commands (uuid_*, show, ...)."""
        try:
            _assert_esl_safe(command)  # boundary defense: no CR/LF/NUL on the wire
        except ESLCommandError as e:
            logger.error("ESL api() rejected unsafe command: %s", e)
            return None
        if not self._connected:
            logger.warning("ESL api('%s') skipped — not connected", command.split()[0])
            return None
        try:
            _headers, body = await self._send(f"api {command}")
            return body
        except Exception as e:  # noqa: BLE001
            logger.error("ESL api('%s') error: %s", command, e)
            return None

    async def bgapi(self, command: str, timeout: float = _ORIGINATE_JOB_TIMEOUT) -> Optional[str]:
        """Non-blocking `bgapi` command: submit the job, then await its
        BACKGROUND_JOB result over the same socket (does NOT stall the reader the
        way a blocking `api originate` would). Returns the job result body."""
        try:
            _assert_esl_safe(command)  # boundary defense: no CR/LF/NUL on the wire
        except ESLCommandError as e:
            logger.error("ESL bgapi() rejected unsafe command: %s", e)
            return None
        if not self._connected:
            logger.warning("ESL bgapi('%s') skipped — not connected", command.split()[0])
            return None
        job_uuid = str(uuidlib.uuid4())
        loop = asyncio.get_running_loop()
        job_fut: "asyncio.Future" = loop.create_future()
        self._jobs[job_uuid] = job_fut
        try:
            reply_fut: "asyncio.Future" = loop.create_future()
            async with self._write_lock:
                self._pending.append(reply_fut)
                self._writer.write(
                    f"bgapi {command}\nJob-UUID: {job_uuid}\n\n".encode()
                )
                await self._writer.drain()
            headers, _ = await asyncio.wait_for(reply_fut, timeout=_COMMAND_TIMEOUT)
            if "+OK" not in headers.get("Reply-Text", ""):
                self._jobs.pop(job_uuid, None)
                logger.error("ESL bgapi submit rejected: %s", headers.get("Reply-Text"))
                return None
            return await asyncio.wait_for(job_fut, timeout=timeout)
        except Exception as e:  # noqa: BLE001
            logger.error("ESL bgapi('%s') error: %s", command, e)
            return None
        finally:
            self._jobs.pop(job_uuid, None)

    # ------------------------------------------------------- event confirmation
    async def wait_for_event(
        self,
        predicate: Callable[[Dict[str, str]], bool],
        timeout: float = 5.0,
    ) -> Optional[Dict[str, str]]:
        """Resolve when an incoming event matches `predicate`. Used to confirm a
        live-call modification actually took effect (event-confirmed, not
        fire-and-forget). Returns the matching event, or None on timeout."""
        loop = asyncio.get_running_loop()
        fut: "asyncio.Future" = loop.create_future()
        waiter = _Waiter(predicate=predicate, future=fut)
        self._waiters.append(waiter)
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            if waiter in self._waiters:
                self._waiters.remove(waiter)

    # --------------------------------------------------------- event processing
    def _handle_event_block(self, body: bytes) -> None:
        event = self._parse_event(body)
        name = event.get("Event-Name", "")
        self.last_event_ts = time.time()

        if name == "BACKGROUND_JOB":
            self._resolve_job(event, body)
        else:
            self._update_registry(name, event)

        # Fire any event-confirmation waiters.
        if self._waiters:
            for waiter in list(self._waiters):
                try:
                    if waiter.predicate(event) and not waiter.future.done():
                        waiter.future.set_result(event)
                        self._waiters.remove(waiter)
                except Exception:  # noqa: BLE001 — a bad predicate must not kill the loop
                    logger.debug("ESL waiter predicate raised", exc_info=True)

        self._prune_if_due()

    def _resolve_job(self, event: Dict[str, str], body: bytes) -> None:
        job_uuid = event.get("Job-UUID")
        fut = self._jobs.get(job_uuid) if job_uuid else None
        if fut is None or fut.done():
            return
        # The job result is the event body (after the event headers' blank line).
        text = body.decode("utf-8", "replace")
        idx = text.find("\n\n")
        result = text[idx + 2:].strip() if idx >= 0 else text.strip()
        fut.set_result(result)

    def _update_registry(self, name: str, event: Dict[str, str]) -> None:
        call_uuid = event.get("Unique-ID") or event.get("Channel-Call-UUID")
        if not call_uuid:
            return

        call = self.registry.get(call_uuid)

        if name == "CHANNEL_CREATE":
            if call is None:
                call = LiveCall(uuid=call_uuid)
                self.registry[call_uuid] = call
            # Only CHANNEL_ANSWER / CHANNEL_HANGUP advance past "created"; a late
            # CHANNEL_CREATE (duplicate) must not clobber an answered call.
            if call.state not in ("answered", "hungup"):
                call.state = "created"
            call.caller = event.get("Caller-Caller-ID-Number") or call.caller
            call.dest = (
                event.get("Caller-Destination-Number")
                or event.get("Channel-Destination-Number")
                or call.dest
            )
            call.direction = event.get("Call-Direction") or call.direction
            cust = event.get("variable_customer_id")
            if cust and cust.isdigit():
                call.customer_id = int(cust)
            call.product_type = event.get("variable_product_type") or call.product_type
            call.touch()

        elif name == "CHANNEL_ANSWER":
            if call is None:
                call = LiveCall(uuid=call_uuid)
                self.registry[call_uuid] = call
            call.state = "answered"
            call.answered_at = time.time()
            call.touch()

        elif name == "CHANNEL_HANGUP":
            if call is None:
                call = LiveCall(uuid=call_uuid)
                self.registry[call_uuid] = call
            call.state = "hungup"
            call.hangup_at = time.time()
            call.hangup_cause = event.get("Hangup-Cause") or call.hangup_cause
            call.touch()

        elif name == "CHANNEL_EXECUTE_COMPLETE":
            if call is not None:
                app = event.get("Application", "")
                data = event.get("Application-Data", "")
                call.last_app = (f"{app} {data}".strip()) or call.last_app
                call.touch()

        elif name == "DTMF":
            if call is not None:
                call.last_dtmf = event.get("DTMF-Digit") or call.last_dtmf
                call.touch()

        elif name == "PLAYBACK_STOP":
            if call is not None:
                call.touch()

        # PROD-3: mirror the updated call to Redis for cross-worker consistency.
        touched = self.registry.get(call_uuid)
        if touched is not None:
            self._mirror_call_to_redis(touched)

    # ----------------------------------------------------------- redis mirror
    def _mirror_call_to_redis(self, call: "LiveCall") -> None:
        """Schedule a best-effort write-through of ``call`` to Redis (PROD-3).

        No-ops instantly when Redis is down (inspects the module-level client
        directly, never get_client(), so a dead Redis cannot trigger a blocking
        reconnect) or when there is no running event loop (e.g. the synchronous
        unit tests) — so it never spawns dangling tasks in tests.
        """
        if cache.client is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(self._redis_write_call(asdict(call)))
        self._mirror_tasks.add(task)
        task.add_done_callback(self._mirror_tasks.discard)

    async def _redis_write_call(self, snap: Dict[str, Any]) -> None:
        rc = cache.client
        if rc is None:
            return
        try:
            uuid_ = snap.get("uuid")
            if not uuid_:
                return
            # Hung-up calls expire after the prune TTL; live calls keep the long TTL.
            ttl = int(_HUNGUP_TTL_SEC) if snap.get("state") == "hungup" else _REDIS_CALL_TTL
            await rc.set(f"{_REDIS_CALL_PREFIX}{uuid_}", json.dumps(snap), ex=ttl)
            await rc.sadd(_REDIS_CALL_INDEX, uuid_)
        except Exception:  # noqa: BLE001
            logger.debug("ESL redis mirror write failed", exc_info=True)

    async def live_snapshot(self) -> List[Dict[str, Any]]:
        """Cross-worker live-call snapshot (PROD-3): union of this worker's
        in-memory registry and the Redis-mirrored calls of all workers, deduped by
        uuid (the entry with the newer ``updated_at`` wins). Degrades to the local
        registry when Redis is unavailable — never raises."""
        self._prune_if_due()
        combined: Dict[str, Dict[str, Any]] = {}

        rc = cache.client
        if rc is not None:
            try:
                uuids = await rc.smembers(_REDIS_CALL_INDEX)
                for u in uuids:
                    raw = await rc.get(f"{_REDIS_CALL_PREFIX}{u}")
                    if raw is None:
                        try:
                            await rc.srem(_REDIS_CALL_INDEX, u)
                        except Exception:  # noqa: BLE001
                            pass
                        continue
                    try:
                        combined[u] = json.loads(raw)
                    except Exception:  # noqa: BLE001
                        continue
            except Exception:  # noqa: BLE001
                logger.debug("ESL redis snapshot read failed", exc_info=True)

        # Overlay the local registry where it is at least as fresh (broadcast
        # usually makes the local view complete; Redis fills momentary gaps).
        for c in self.registry.values():
            d = asdict(c)
            prev = combined.get(c.uuid)
            if prev is None or d.get("updated_at", 0) >= prev.get("updated_at", 0):
                combined[c.uuid] = d

        return list(combined.values())

    # ------------------------------------------------------------------ pruning
    def _prune_if_due(self) -> None:
        now = time.time()
        if now - self._last_prune < _PRUNE_INTERVAL_SEC:
            return
        self._last_prune = now
        stale = [
            u for u, c in self.registry.items()
            if c.state == "hungup"
            and c.hangup_at is not None
            and now - c.hangup_at > _HUNGUP_TTL_SEC
        ]
        for u in stale:
            self.registry.pop(u, None)

    # -------------------------------------------------------------- conn state
    def _mark_connected(self) -> None:
        self._connected = True
        self.last_connect_ts = time.time()
        self.last_error = None

    def _mark_disconnected(self) -> None:
        self._connected = False
        # Fail any in-flight commands so callers don't hang.
        while self._pending:
            fut = self._pending.popleft()
            if not fut.done():
                fut.set_exception(ConnectionError("ESL disconnected"))
        for fut in list(self._jobs.values()):
            if not fut.done():
                fut.set_exception(ConnectionError("ESL disconnected"))
        self._jobs.clear()

    async def _close_conn(self) -> None:
        self._mark_disconnected()
        if self._writer is not None:
            try:
                self._writer.close()
                await asyncio.wait_for(self._writer.wait_closed(), timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
        self._reader = None
        self._writer = None


# ---------------------------------------------------------------------------
# Module-level singleton + thin backward-compatible wrappers. Every caller in
# the codebase (calls.py, trunks.py, conference.py) routes through this ONE
# client — there is no second ESL pattern.
# ---------------------------------------------------------------------------
_client: Optional[ESLClient] = None


def get_esl_client() -> ESLClient:
    global _client
    if _client is None:
        _client = ESLClient()
    return _client


async def start_esl_consumer() -> ESLClient:
    """Called from the FastAPI lifespan. Spawns the consumer without blocking or
    crashing startup if FS is unreachable."""
    client = get_esl_client()
    if not client.configured():
        logger.warning(
            "FREESWITCH_ESL_HOST/PASSWORD not fully configured — ESL consumer "
            "will idle until configured; commands will fail gracefully"
        )
    client.start()
    return client


async def stop_esl_consumer() -> None:
    global _client
    if _client is not None:
        await _client.stop()


async def _send_esl_command(command: str) -> Optional[str]:
    """Backward-compatible low-level helper: run a blocking `api` command over
    the shared persistent connection. Returns the response text or None."""
    return await get_esl_client().api(command)


async def originate_call(
    uuid: str,
    from_did: str,
    to: str,
    customer_id: int,
    traffic_grade: str = "standard",
    webhook_url: str = "",
    timeout: int = 60,
) -> bool:
    """Originate an outbound call via `bgapi` (non-blocking on the shared socket).

    Uses sofia/external/dest@proxy so Kamailio applies ext-sip-ip (public IP) to
    the outbound INVITE's Via/Contact/SDP. The X-Carrier header is 'primary'
    (Dallas) — all products share the 2-carrier model; traffic_grade is only a
    channel var and does NOT select the carrier.
    """
    carrier = "primary"
    vars_str = ",".join([
        f"origination_uuid={uuid}",
        f"origination_caller_id_number={from_did}",
        f"customer_id={customer_id}",
        f"product_type=api",
        f"direction=outbound",
        f"traffic_grade={traffic_grade}",
        f"outbound_api=true",
        f"webhook_url={webhook_url}",
        f"ignore_early_media=true",
        f"originate_timeout={timeout}",
        f"sip_h_X-Carrier={carrier}",
    ])

    if os.getenv("TEST_MODE") == "true":
        command = f"originate {{{vars_str}}}loopback/{to}/default &lua(outbound_api.lua)"
    else:
        sbc_proxy = os.getenv("SBC_PROXY_IP", "127.0.0.1")
        command = (
            f"originate {{{vars_str}}}sofia/external/{to}@{sbc_proxy}:5060 "
            f"&lua(outbound_api.lua)"
        )

    logger.info("Originating call: %s to %s", uuid, to)
    response = await get_esl_client().bgapi(command, timeout=float(timeout) + 30.0)
    if response and "+OK" in response:
        logger.info("Call originated successfully: %s", uuid)
        return True
    logger.error("Call origination failed: %s", response)
    return False


async def get_call_status(call_id: str) -> Dict:
    """Return live call status. Reads the event-derived registry FIRST (the
    authoritative, real-time source), falling back to `uuid_dump` when the call
    is not tracked (e.g. just after a fresh connect, before events arrived)."""
    client = get_esl_client()
    call = client.get_call(call_id)
    if call is not None:
        status: Dict[str, Any] = {
            "state": call.state,
            "source": "registry",
            "customer_id": call.customer_id,
            "caller": call.caller,
            "destination": call.dest,
            "direction": call.direction,
            "answered_at": call.answered_at,
            "hangup_cause": call.hangup_cause,
            "last_app": call.last_app,
            "last_dtmf": call.last_dtmf,
        }
        if call.state == "answered":
            status["answer_state"] = "answered"
        return status

    # Fallback: poll FreeSWITCH directly.
    response = await client.api(f"uuid_dump {call_id}")
    if not response or "-ERR" in response:
        return {"state": "not_found", "source": "uuid_dump"}

    status = {"state": "active", "source": "uuid_dump"}
    for line in response.split("\n"):
        if ":" in line:
            key, value = line.split(":", 1)
            key = key.strip().lower()
            value = value.strip()
            if key == "channel_state":
                status["state"] = value.lower()
            elif key == "answer_state":
                status["answer_state"] = value.lower()
    return status


async def hangup_call(call_id: str, cause: str = "NORMAL_CLEARING") -> bool:
    """Hangup a call by UUID (fire-and-forget). For event-confirmed hangup use
    hangup_call_confirmed()."""
    response = await get_esl_client().api(f"uuid_kill {call_id} {cause}")
    if response and "+OK" in response:
        logger.info("Call hung up: %s", call_id)
        return True
    return False


async def hangup_call_confirmed(
    call_id: str, cause: str = "NORMAL_CLEARING", timeout: float = 5.0
) -> Dict[str, Any]:
    """Hangup a call AND confirm by observing the CHANNEL_HANGUP event for this
    uuid. Returns {ok, confirmed, hangup_cause}."""
    client = get_esl_client()

    async def _do():
        return await client.api(f"uuid_kill {call_id} {cause}")

    # Start waiting for the hangup event BEFORE issuing the kill to avoid a race.
    wait_task = asyncio.create_task(client.wait_for_event(
        lambda e: (
            e.get("Event-Name") == "CHANNEL_HANGUP"
            and (e.get("Unique-ID") == call_id or e.get("Channel-Call-UUID") == call_id)
        ),
        timeout=timeout,
    ))
    response = await _do()
    ok = bool(response and "+OK" in response)
    event = await wait_task
    confirmed = event is not None
    # The registry is also updated by the same event.
    call = client.get_call(call_id)
    return {
        "ok": ok,
        "confirmed": confirmed,
        "hangup_cause": (event or {}).get("Hangup-Cause")
        or (call.hangup_cause if call else None),
    }


async def transfer_call(call_id: str, destination: str) -> bool:
    """Transfer a call to a new destination (fire-and-forget)."""
    response = await get_esl_client().api(f"uuid_transfer {call_id} {destination}")
    return bool(response and "+OK" in response)


async def transfer_call_confirmed(
    call_id: str, destination: str, dialplan: str = "XML", context: str = "default",
    timeout: float = 5.0,
) -> Dict[str, Any]:
    """Transfer a call into a dialplan extension and confirm via the resulting
    CHANNEL_EXECUTE_COMPLETE(transfer) event for this uuid."""
    client = get_esl_client()
    wait_task = asyncio.create_task(client.wait_for_event(
        lambda e: (
            e.get("Event-Name") == "CHANNEL_EXECUTE_COMPLETE"
            and e.get("Application") == "transfer"
            and (e.get("Unique-ID") == call_id or e.get("Channel-Call-UUID") == call_id)
        ),
        timeout=timeout,
    ))
    response = await client.api(f"uuid_transfer {call_id} {destination} {dialplan} {context}")
    ok = bool(response and "+OK" in response)
    event = await wait_task
    return {"ok": ok, "confirmed": event is not None}


async def redirect_call_confirmed(
    call_id: str, voice_url: str, extension: Optional[str] = None,
    context: str = "default", timeout: float = 5.0,
) -> Dict[str, Any]:
    """Redirect a live programmable-voice call to NEW TwiML: set the channel's
    voice_url var, then transfer it back into the voice engine extension so it
    re-fetches. Confirmed via the resulting transfer EXECUTE_COMPLETE event."""
    client = get_esl_client()
    ext = extension or os.getenv("VOICE_ENGINE_EXTENSION", "api_voice")
    # Update the URL the voice engine will fetch on re-entry.
    await client.api(f"uuid_setvar {call_id} voice_url {voice_url}")
    return await transfer_call_confirmed(
        call_id, ext, dialplan="XML", context=context, timeout=timeout
    )


async def send_dtmf(call_id: str, digits: str) -> bool:
    """Send DTMF digits to a call (fire-and-forget)."""
    response = await get_esl_client().api(f"uuid_send_dtmf {call_id} {digits}")
    return bool(response and "+OK" in response)


async def send_dtmf_confirmed(
    call_id: str, digits: str, timeout: float = 5.0
) -> Dict[str, Any]:
    """Send DTMF AND confirm the send_dtmf application completed on this uuid."""
    client = get_esl_client()
    wait_task = asyncio.create_task(client.wait_for_event(
        lambda e: (
            e.get("Event-Name") == "CHANNEL_EXECUTE_COMPLETE"
            and e.get("Application") in ("send_dtmf", "queue_dtmf")
            and (e.get("Unique-ID") == call_id or e.get("Channel-Call-UUID") == call_id)
        ),
        timeout=timeout,
    ))
    response = await client.api(f"uuid_send_dtmf {call_id} {digits}")
    ok = bool(response and "+OK" in response)
    event = await wait_task
    return {"ok": ok, "confirmed": event is not None}
