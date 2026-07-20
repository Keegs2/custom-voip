"""Realtime AI voice-agent orchestrator — the in-boundary ConversationRelay.

This is the WebSocket peer that FreeSWITCH ``mod_audio_stream`` connects to (via a
TwiML ``<Connect><Stream url="ws://…/ws/ai-agent?…"/>``). It runs the full
duplex voice loop ENTIRELY inside the platform boundary:

    caller audio (L16 8k, binary WS frames)
        → VAD segments an utterance  (self-hosted, no egress)
        → STT transcribes it         (self-hosted Whisper by default)
        → LLM streams a reply + tool calls  (self-hosted vLLM/Ollama by default)
        → TTS synthesizes the reply  (self-hosted Piper/HTTP by default)
        → audio streamed back to the caller over the SAME WebSocket
            ({"type":"streamAudio",...} — see services/ai_audio)

Wiring OpenAI Realtime / Deepgram / ElevenLabs behind the pluggable providers is a
per-agent CONFIG opt-in; the defaults keep PHI/CPNI in the VPC — the thing the
usage-metered hyperscalers structurally cannot offer.

Robustness contract (a call must NEVER hang):
  * bounded global concurrency (semaphore); overflow → transfer to fallback.
  * every provider call is guarded; LLM/STT/TTS failure → spoken fallback +
    transfer to the agent's fallback destination (or graceful hangup).
  * hard max-duration + max-turns watchdog.
  * barge-in: caller speech cancels the in-flight turn (stops TTS immediately);
    a shallow, paced downlink buffer keeps interruption responsive even though
    mod_audio_stream has no server-side "flush" message.
  * the session NEVER touches the existing call path — it only runs for calls a
    flow/DID explicitly routed to an agent.
"""
from __future__ import annotations

import os
import re
import time
import asyncio
import logging
from typing import Any, Optional

from starlette.websockets import WebSocket, WebSocketState

from db import database as db
from services import ai_audio
from services import ai_config
from services.ai_config import AgentConfig, ProviderBundle
from services import stt as stt_mod
from services.esl_client import (
    transfer_call_confirmed,
    send_dtmf_confirmed,
    hangup_call_confirmed,
    get_esl_client,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tunables (env). Reported to the lead for docker-compose.services.yml + .env.
# ---------------------------------------------------------------------------
def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


STREAM_SAMPLE_RATE = _env_int("AI_STREAM_SAMPLE_RATE", 8000)   # MUST match FS STREAM_SAMPLE_RATE
MAX_CONCURRENT = _env_int("AI_MAX_CONCURRENT_SESSIONS", 50)
MAX_CONCURRENT_PER_CUSTOMER = _env_int("AI_MAX_CONCURRENT_PER_CUSTOMER", 10)
SEND_CHUNK_MS = _env_int("AI_TTS_SEND_CHUNK_MS", 100)
SEND_PACING = _env_float("AI_TTS_PACING", 0.9)                 # <1.0 keeps in-flight buffer shallow
MAX_TOOL_ITERS = _env_int("AI_MAX_TOOL_ITERS", 3)
NO_INPUT_SEC = _env_float("AI_NO_INPUT_SEC", 10.0)
MAX_NO_INPUT = _env_int("AI_MAX_NO_INPUT", 2)
AGENTS_ENABLED = os.getenv("AI_AGENTS_ENABLED", "true").lower() == "true"
CLEAR_MSG = os.getenv("AI_AUDIO_CLEAR_MSG", "")               # optional barge-in flush for forks that support it

# Global concurrency gate (lazily created inside the loop).
_semaphore: Optional[asyncio.Semaphore] = None
# Per-customer live-session counts (MEDIUM-8). Single-threaded asyncio makes the
# non-awaiting admission (read cap → acquire global slot → increment) atomic, so a
# plain dict is a correct, lock-free per-tenant cap.
_active_by_customer: dict[int, int] = {}


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    return _semaphore


# Destination validation for the transfer tool (anti-injection / anti-spoof):
# E.164, NANP 10/11-digit, or a 3-6 digit internal extension.
# LOW-11: re.ASCII so ``\d`` matches ONLY [0-9] (not Unicode digits) — a
# non-ASCII digit must never sneak into a phone number bound for the ESL wire.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_E164_RE = re.compile(r"^\+[1-9]\d{1,14}$", re.ASCII)
_NANP_RE = re.compile(r"^1?[2-9]\d{9}$", re.ASCII)
_EXT_RE = re.compile(r"^\d{3,6}$", re.ASCII)
_DTMF_RE = re.compile(r"^[0-9A-Da-d\*#]{1,32}$", re.ASCII)

# ---------------------------------------------------------------------------
# Toll-fraud destination policy (HIGH-3)
# ---------------------------------------------------------------------------
# A caller can prompt-inject the LLM into calling transfer_call("+2348…") — or a
# high-cost NANP Caribbean/premium number — for international/premium toll fraud.
# Before any transfer we gate the destination on the OWNING customer's
# ``customers.international_calling_enabled`` fraud flag. This mirrors the RCF
# call-time fraud control (same NPA list — keep them consistent).
#
# High-cost NANP NPAs that bill like international even though they are ``+1``
# (Caribbean/Atlantic + North-American premium). Blocked when intl is disabled.
_HIGH_COST_NANP_NPAS = frozenset({
    "242", "246", "264", "268", "284", "340", "345", "441", "473", "649", "658",
    "664", "721", "758", "767", "784", "809", "829", "849", "868", "869", "876",
    "900", "976",
})
# Premium / pay-per-call NANP NPAs — blocked even WITH international enabled
# (they are scam/premium-rate, never a legitimate international destination).
_PREMIUM_NANP_NPAS = frozenset({"900", "976"})


def _valid_destination(value: str) -> Optional[str]:
    if not value:
        return None
    v = value.strip()
    if _CONTROL_RE.search(v):
        return None
    if _E164_RE.match(v):
        return v
    if _NANP_RE.match(v):
        return "+" + (v if v.startswith("1") and len(v) == 11 else "1" + v)
    if _EXT_RE.match(v):
        return v
    return None


def _destination_allowed(dest: Optional[str], intl_enabled: bool) -> bool:
    """Pure fraud-policy check for an already-normalized destination (HIGH-3).

    * Internal extensions (no leading ``+``) are never toll destinations → allowed.
    * NANP (``+1`` + 10 digits): premium NPAs (900/976) are ALWAYS blocked; other
      high-cost NANP NPAs are blocked unless the customer has international enabled.
    * International (non-NANP E.164): allowed only when international is enabled.
    """
    if not dest:
        return False
    if not dest.startswith("+"):
        return True  # internal extension / non-PSTN token
    is_nanp = dest.startswith("+1") and len(dest) == 12
    if is_nanp:
        npa = dest[2:5]
        if npa in _PREMIUM_NANP_NPAS:
            return False
        if not intl_enabled and npa in _HIGH_COST_NANP_NPAS:
            return False
        return True
    # Non-NANP E.164 == international.
    return intl_enabled


async def _fraud_check_destination(dest: Optional[str], customer_id: Optional[int]) -> bool:
    """Gate ``dest`` on the owning customer's ``international_calling_enabled`` flag
    (HIGH-3). Only PSTN E.164 needs the DB lookup; extensions are always allowed.
    Fails CLOSED (deny) if the flag cannot be read."""
    if not dest:
        return False
    if not dest.startswith("+"):
        return True  # extension — no toll exposure, no lookup needed
    intl_enabled = False
    try:
        row = await db.fetch_one(
            "SELECT international_calling_enabled FROM customers WHERE id = $1::int",
            customer_id,
        )
        intl_enabled = bool(row["international_calling_enabled"]) if row else False
    except Exception:
        logger.warning(
            "ai_agent: international-flag lookup failed for customer=%s — denying %s",
            customer_id, dest, exc_info=True,
        )
        intl_enabled = False
    return _destination_allowed(dest, intl_enabled)


def _loads(data):
    try:
        import orjson
        return orjson.loads(data)
    except Exception:
        import json
        try:
            return json.loads(data)
        except Exception:
            return {}


# ---------------------------------------------------------------------------
# Entry point (called by routers/ai_agents.py after WS accept + auth)
# ---------------------------------------------------------------------------
async def run_agent_session(
    websocket: WebSocket, agent_id: int, call_uuid: str, customer_id_hint: Optional[int]
) -> None:
    """Load config, bound concurrency, and run one agent session. Owns cleanup.

    The authoritative tenant owner is ``ai_agents.customer_id`` (NOT the query
    hint) — the session row and all tenant scoping bind to it.
    """
    if not AGENTS_ENABLED:
        await _safe_close(websocket, 1013, "AI agents disabled")
        return

    cfg = None
    try:
        cfg = await ai_config.load_agent_config(agent_id)
    except Exception:
        logger.warning("ai_agent: config load failed for agent=%s", agent_id, exc_info=True)

    if cfg is None or not cfg.enabled:
        logger.info("ai_agent: agent %s missing/disabled — closing", agent_id)
        await _safe_close(websocket, 1011, "agent unavailable")
        return

    sem = _get_semaphore()
    cust = cfg.customer_id
    # Admission control (MEDIUM-8). Both caps are checked WITHOUT queuing a live
    # call: per-customer first (a noisy tenant can't monopolize the global pool),
    # then the global slot via a REAL, non-blocking semaphore acquire. The check
    # and acquire do not await between them, so in single-threaded asyncio no other
    # session can take the slot in between — no reliance on the private ``_value``.
    if _active_by_customer.get(cust, 0) >= MAX_CONCURRENT_PER_CUSTOMER:
        logger.warning(
            "ai_agent: per-customer cap (%d) reached for customer %s — falling back for call %s",
            MAX_CONCURRENT_PER_CUSTOMER, cust, call_uuid,
        )
        await _overflow_fallback(cfg, call_uuid)
        await _safe_close(websocket, 1013, "at capacity")
        return
    if sem.locked():  # global cap reached (value == 0)
        logger.warning("ai_agent: at global capacity (%d) — falling back for call %s",
                        MAX_CONCURRENT, call_uuid)
        await _overflow_fallback(cfg, call_uuid)
        await _safe_close(websocket, 1013, "at capacity")
        return
    await sem.acquire()  # immediate (a free slot was just confirmed, no await gap)
    _active_by_customer[cust] = _active_by_customer.get(cust, 0) + 1
    try:
        providers = ai_config.build_providers(cfg)
        session = AgentSession(websocket, cfg, providers, call_uuid)
        await session.run()
    finally:
        sem.release()
        remaining = _active_by_customer.get(cust, 0) - 1
        if remaining > 0:
            _active_by_customer[cust] = remaining
        else:
            _active_by_customer.pop(cust, None)


class AgentSession:
    """One live call ↔ agent conversation."""

    def __init__(self, websocket: WebSocket, cfg: AgentConfig,
                 providers: ProviderBundle, call_uuid: str):
        self.ws = websocket
        self.cfg = cfg
        self.providers = providers
        self.call_uuid = call_uuid
        self.customer_id = cfg.customer_id

        # Conversation state (OpenAI messages) + transcript for persistence.
        self.messages: list[dict] = [{"role": "system", "content": cfg.system_prompt}]
        self.transcript: list[dict] = []
        self.result: dict = {}                # capture_result payload
        self.tool_log: list[dict] = []        # summary of tool calls
        self.outcome: str = "completed"
        self.status: str = "active"

        # Cost inputs.
        self.turn_count = 0
        self.stt_seconds = 0.0
        self.llm_prompt_tokens = 0
        self.llm_completion_tokens = 0
        self.tts_characters = 0

        # Runtime control.
        self._done = asyncio.Event()
        self._turn_task: Optional[asyncio.Task] = None
        self._recv_task: Optional[asyncio.Task] = None
        self._stt_task: Optional[asyncio.Task] = None
        self._speaking = False
        self._user_text_q: asyncio.Queue[str] = asyncio.Queue()
        self._utt_q: asyncio.Queue[bytes] = asyncio.Queue()   # batched STT: raw PCM utterances
        self._stt_stream: Optional[stt_mod.STTStream] = None
        self._vad = ai_audio.vad_from_env(STREAM_SAMPLE_RATE)
        self._session_row_id: Optional[int] = None
        self._started = time.time()
        self._deadline = self._started + max(30, cfg.max_duration_seconds)
        self._barge_enabled = cfg.barge_in_enabled

        self._tool_schema = ai_config.build_tool_schema(cfg)
        self._custom_tools = ai_config.custom_tool_map(cfg)

    # -------------------------------------------------------------- lifecycle
    async def run(self) -> None:
        await self._persist_start()
        try:
            # Streaming STT opens a live socket up front; batched has none.
            if self.providers.stt.mode == stt_mod.STT_MODE_STREAMING:
                try:
                    self._stt_stream = await self.providers.stt.open_stream(
                        self.call_uuid, STREAM_SAMPLE_RATE
                    )
                except Exception:
                    logger.warning("ai_agent: STT stream open failed — degrading", exc_info=True)

            self._recv_task = asyncio.create_task(self._receive_loop())
            self._stt_task = asyncio.create_task(self._stt_worker())
            await self._greet()
            await self._brain_loop()
        except Exception:
            logger.warning("ai_agent: session error for call %s", self.call_uuid, exc_info=True)
            self.outcome = "failed"
        finally:
            await self._teardown()

    async def _teardown(self) -> None:
        self._done.set()
        for task in (self._turn_task, self._recv_task, self._stt_task):
            if task and not task.done():
                task.cancel()
        for task in (self._turn_task, self._recv_task, self._stt_task):
            if task:
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        if self._stt_stream is not None:
            try:
                await self._stt_stream.close()
            except Exception:
                pass
        await self._persist_end()
        await _safe_close(self.ws, 1000, "session ended")

    # ------------------------------------------------------------- receive/VAD
    async def _receive_loop(self) -> None:
        """Pull WS frames: binary → audio (VAD + STT), text → control events."""
        try:
            while not self._done.is_set():
                message = await self.ws.receive()
                mtype = message.get("type")
                if mtype == "websocket.disconnect":
                    break
                pcm = message.get("bytes")
                if pcm:
                    await self._on_audio(pcm)
                    continue
                text = message.get("text")
                if text:
                    self._on_control_text(text)
        except (asyncio.CancelledError, Exception):
            pass
        finally:
            # Caller/media hung up — end the session.
            self._done.set()
            # Unblock the brain loop if it is waiting.
            try:
                self._user_text_q.put_nowait("")
            except Exception:
                pass

    async def _on_audio(self, pcm: bytes) -> None:
        # Feed streaming STT (if any).
        if self._stt_stream is not None:
            await self._stt_stream.send_audio(pcm)

        # VAD drives barge-in always, and utterance segmentation for batched STT.
        event = self._vad.process(pcm)
        if event == ai_audio.VAD_SPEECH_START:
            if self._barge_enabled and self._turn_active():
                await self._barge()
        elif event == ai_audio.VAD_SPEECH_END:
            if self.providers.stt.mode == stt_mod.STT_MODE_BATCHED:
                utt = self._vad.take_utterance()
                if utt:
                    self.stt_seconds += ai_audio.frame_ms(utt, STREAM_SAMPLE_RATE) / 1000.0
                    try:
                        self._utt_q.put_nowait(utt)
                    except Exception:
                        pass

    def _on_control_text(self, text: str) -> None:
        # mod_audio_stream mostly signals via FreeSWITCH events, but some builds
        # send text frames; parse defensively and ignore unknown shapes.
        data = _loads(text)
        if isinstance(data, dict) and data.get("type") in ("disconnect", "stop", "close"):
            self._done.set()

    # ------------------------------------------------------------- STT worker
    async def _stt_worker(self) -> None:
        try:
            if self.providers.stt.mode == stt_mod.STT_MODE_STREAMING and self._stt_stream:
                async for tr in self._stt_stream.results():
                    if tr.is_final and tr.text.strip():
                        await self._push_user_text(tr.text.strip())
            else:
                while not self._done.is_set():
                    utt = await self._utt_q.get()
                    if not utt:
                        continue
                    text = ""
                    try:
                        text = await self.providers.stt.transcribe(utt, STREAM_SAMPLE_RATE)
                    except Exception:
                        logger.debug("ai_agent: transcribe error", exc_info=True)
                    if text and text.strip():
                        await self._push_user_text(text.strip())
        except (asyncio.CancelledError, Exception):
            pass

    async def _push_user_text(self, text: str) -> None:
        """Enqueue a finalized caller utterance. A new utterance always PREEMPTS
        an in-flight turn (latest-utterance-wins / barge)."""
        if self._turn_active():
            await self._barge()
        await self._user_text_q.put(text)

    # ------------------------------------------------------------- brain loop
    async def _brain_loop(self) -> None:
        no_input = 0
        while not self._done.is_set():
            if time.time() >= self._deadline:
                self.outcome = "max_duration"
                await self._safe_speak("Thank you for calling. Goodbye.")
                break
            text = await self._next_user_text(NO_INPUT_SEC)
            if self._done.is_set():
                break
            if text is None:
                # Idle: re-prompt a couple of times, then end.
                no_input += 1
                if no_input > MAX_NO_INPUT:
                    self.outcome = "no_input"
                    await self._safe_speak("I didn't hear anything, so I'll let you go. Goodbye.")
                    break
                await self._safe_speak("Are you still there? How can I help?")
                continue
            if not text:
                continue
            no_input = 0
            self.turn_count += 1
            if self.turn_count > self.cfg.max_turns:
                self.outcome = "max_turns"
                await self._safe_speak(
                    "Let me connect you with someone who can help further."
                )
                await self._transfer_fallback()
                break
            self._turn_task = asyncio.create_task(self._run_turn(text))
            try:
                await self._turn_task
            except asyncio.CancelledError:
                pass  # barge-in preempted this turn; process the next utterance
            except Exception:
                logger.warning("ai_agent: turn error", exc_info=True)
                await self._fallback("turn error")
                break
            finally:
                self._turn_task = None
            if self.outcome in ("transferred", "hangup", "completed_by_tool", "failed"):
                break

    async def _next_user_text(self, timeout: float) -> Optional[str]:
        """Return the LATEST queued utterance (draining stale ones), or None on
        idle timeout."""
        try:
            first = await asyncio.wait_for(self._user_text_q.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
        latest = first
        # Drain any additional queued utterances — only the newest matters.
        while True:
            try:
                latest = self._user_text_q.get_nowait()
            except asyncio.QueueEmpty:
                break
        return latest

    def _turn_active(self) -> bool:
        return self._turn_task is not None and not self._turn_task.done()

    async def _barge(self) -> None:
        """Interrupt the agent immediately: cancel the in-flight turn, best-effort
        flush the media buffer (mod_audio_stream has no documented flush, so we
        rely on the shallow paced buffer + optional clear message + uuid_break)."""
        task = self._turn_task
        if task and not task.done():
            task.cancel()
        self._speaking = False
        if CLEAR_MSG:
            await self._safe_send(CLEAR_MSG)
        try:
            await get_esl_client().api(f"uuid_break {self.call_uuid} all")
        except Exception:
            pass

    # ------------------------------------------------------------- greeting/turn
    async def _greet(self) -> None:
        greeting = (self.cfg.greeting or "").strip()
        if not greeting:
            return
        self.messages.append({"role": "assistant", "content": greeting})
        self.transcript.append({"role": "assistant", "text": greeting, "ts": time.time()})
        self._turn_task = asyncio.create_task(self._speak_text(greeting))
        try:
            await self._turn_task
        except asyncio.CancelledError:
            pass
        finally:
            self._turn_task = None

    async def _run_turn(self, user_text: str) -> None:
        """One conversational turn: LLM (streamed, spoken) + tool loop."""
        self.messages.append({"role": "user", "content": user_text})
        self.transcript.append({"role": "user", "text": user_text, "ts": time.time()})

        for _ in range(MAX_TOOL_ITERS):
            spoken, tool_calls = await self._llm_stream_and_speak()
            if spoken.strip():
                self.transcript.append(
                    {"role": "assistant", "text": spoken, "ts": time.time()}
                )
            if not tool_calls:
                self.messages.append({"role": "assistant", "content": spoken})
                return
            # Record the assistant tool-call message (OpenAI format).
            self.messages.append({
                "role": "assistant",
                "content": spoken or None,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": tc.arguments},
                    }
                    for tc in tool_calls
                ],
            })
            terminal = await self._exec_tools(tool_calls)
            if terminal:
                return
            # Loop again so the model can respond to the tool results.
        # Tool-iteration cap hit — stop cleanly.

    async def _llm_stream_and_speak(self):
        """Stream the LLM reply; speak complete sentences as they arrive (low
        time-to-first-audio). Returns (spoken_text, tool_calls)."""
        from services.llm import LLMError

        buffer = ""
        spoken = ""
        tool_calls: list = []
        try:
            stream = self.providers.llm.stream_chat(
                self.messages,
                tools=self._tool_schema,
                temperature=self.cfg.temperature,
                max_tokens=self.cfg.max_tokens,
            )
            async for delta in stream:
                if delta.text:
                    buffer += delta.text
                    # Speak at sentence boundaries to pipeline synth with generation.
                    sentence, buffer = _pop_sentence(buffer)
                    while sentence:
                        spoken += sentence
                        await self._speak_text(sentence)
                        sentence, buffer = _pop_sentence(buffer)
                if delta.finish_reason:
                    if delta.prompt_tokens:
                        self.llm_prompt_tokens += delta.prompt_tokens
                    if delta.completion_tokens:
                        self.llm_completion_tokens += delta.completion_tokens
                    tool_calls = delta.tool_calls or []
            # Flush any trailing partial sentence.
            if buffer.strip():
                spoken += buffer
                await self._speak_text(buffer)
        except LLMError:
            logger.warning("ai_agent: LLM error — fallback", exc_info=False)
            await self._fallback("llm error")
            raise asyncio.CancelledError()  # end the turn
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("ai_agent: LLM turn crashed — fallback", exc_info=True)
            await self._fallback("llm crash")
            raise asyncio.CancelledError()
        return spoken, tool_calls

    # ------------------------------------------------------------- tools → ESL
    async def _exec_tools(self, tool_calls) -> bool:
        """Execute the model's tool calls. Returns True if the session should end
        (transfer/hangup). Appends tool results for non-terminal tools."""
        terminal = False
        for tc in tool_calls:
            args = _loads(tc.arguments) if tc.arguments else {}
            if not isinstance(args, dict):
                args = {}
            name = tc.name
            self.tool_log.append({"name": name, "args": args, "ts": time.time()})
            result = "ok"
            try:
                if name == ai_config.BUILTIN_TRANSFER:
                    dest = _valid_destination(str(args.get("destination", "")))
                    if not dest:
                        result = "invalid destination"
                    elif not await _fraud_check_destination(dest, self.customer_id):
                        # HIGH-3: prompt-injection toll-fraud guard. Deny (don't
                        # transfer); the tool result feeds back so the agent's
                        # normal fallback handles it.
                        logger.warning(
                            "ai_agent: blocked transfer to disallowed destination %s "
                            "for customer %s (call %s)",
                            dest, self.customer_id, self.call_uuid,
                        )
                        result = "destination not permitted"
                    else:
                        await transfer_call_confirmed(self.call_uuid, dest, timeout=8.0)
                        self.outcome = "transferred"
                        self.result.setdefault("transfer_destination", dest)
                        terminal = True
                        result = f"transferred to {dest}"
                elif name == ai_config.BUILTIN_DTMF:
                    digits = str(args.get("digits", "")).strip()
                    if not _DTMF_RE.match(digits):
                        result = "invalid digits"
                    else:
                        await send_dtmf_confirmed(self.call_uuid, digits, timeout=5.0)
                        result = f"sent {digits}"
                elif name == ai_config.BUILTIN_HANGUP:
                    self.outcome = "completed_by_tool"
                    terminal = True
                    result = "call ended"
                elif name == ai_config.BUILTIN_CAPTURE:
                    data = args.get("data")
                    if isinstance(data, dict):
                        self.result.update(data)
                    result = "captured"
                elif name in self._custom_tools:
                    result = await self._exec_http_tool(name, args)
                else:
                    result = f"unknown tool {name}"
            except Exception:
                logger.warning("ai_agent: tool %s failed", name, exc_info=True)
                result = "tool error"
            # Provide the tool result back to the model (non-terminal continues).
            self.messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": str(result)[:2000],
            })
        if terminal and self.outcome == "completed_by_tool":
            await hangup_call_confirmed(self.call_uuid, timeout=5.0)
        elif terminal and self.outcome == "transferred":
            pass  # already transferred
        return terminal

    async def _exec_http_tool(self, name: str, args: dict) -> str:
        """Call an agent-configured webhook tool (allow-listed in ai_agents.tools).

        Only URLs the tenant configured are reachable; HTTPS is enforced unless
        ``WEBHOOK_ALLOW_HTTP=true`` (dev). This is the "look up data via an allowed
        webhook" capability — the data source stays under the customer's control.

        SECURITY (CRITICAL-2): unlike a provider ``*_base_url`` (which legitimately
        targets in-boundary RFC1918/loopback self-hosted inference), a custom-tool
        URL is an OUTBOUND integration to a customer/public service with NO
        in-boundary requirement — so every URL is run through the platform SSRF
        guard (``is_safe_webhook_url``, DNS-rebinding-aware) to block the cloud
        metadata endpoint, loopback, and RFC1918 targets BEFORE any fetch. Header
        values are used VERBATIM: there is NO ``${ENV}`` expansion (that was a
        second arbitrary-env-exfil path).
        """
        spec = self._custom_tools.get(name, {}).get("http", {})
        url = spec.get("url", "")
        method = (spec.get("method") or "POST").upper()
        if not url:
            return "tool not configured"
        allow_http = os.getenv("WEBHOOK_ALLOW_HTTP", "").lower() == "true"
        if not (url.startswith("https://") or (allow_http and url.startswith("http://"))):
            return "tool url must be https"
        if _CONTROL_RE.search(url):
            return "invalid tool url"
        # SSRF guard: block metadata/loopback/RFC1918 (DNS-rebinding-aware). Runs in
        # a thread because it may DNS-resolve (getaddrinfo is blocking).
        from services.webhook_signing import is_safe_webhook_url
        if not await asyncio.to_thread(is_safe_webhook_url, url):
            logger.warning("ai_agent: refusing SSRF-unsafe tool url for tool %s", name)
            return "tool url is not permitted"
        import httpx

        headers = {"Content-Type": "application/json"}
        for k, v in (spec.get("headers") or {}).items():
            # Header values are used verbatim — NO ${ENV} expansion (that was an
            # arbitrary-env exfiltration vector). A tenant may still set a literal
            # token here for its own webhook.
            headers[str(k)] = str(v)
        try:
            timeout = float(spec.get("timeout", 8.0))
        except (TypeError, ValueError):
            timeout = 8.0
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                if method == "GET":
                    resp = await client.get(url, params=args, headers=headers)
                else:
                    resp = await client.request(method, url, json=args, headers=headers)
            body = resp.text[:2000]
            return f"HTTP {resp.status_code}: {body}"
        except Exception:
            logger.warning("ai_agent: http tool %s failed", name, exc_info=True)
            return "tool request failed"

    # ------------------------------------------------------------- TTS out
    async def _speak_text(self, text: str) -> None:
        """Synthesize ``text`` and stream it to the caller, paced so barge-in stays
        responsive. Cancellable (barge cancels the enclosing turn task)."""
        text = (text or "").strip()
        if not text:
            return
        self.tts_characters += len(text)
        self._speaking = True
        try:
            async for pcm_native in self.providers.tts.synthesize(text, self.cfg.tts_voice):
                if not pcm_native:
                    continue
                rate = getattr(self.providers.tts, "sample_rate", 24000)
                pcm8k = ai_audio.resample_pcm16(pcm_native, rate, STREAM_SAMPLE_RATE)
                for chunk in ai_audio.iter_pcm_chunks(pcm8k, SEND_CHUNK_MS, STREAM_SAMPLE_RATE):
                    if self._done.is_set():
                        return
                    await self._safe_send(ai_audio.encode_stream_audio(chunk, STREAM_SAMPLE_RATE))
                    # Pace slightly under real-time so the module's buffer stays
                    # shallow → interruption drops <~1 chunk of already-sent audio.
                    dur = ai_audio.frame_ms(chunk, STREAM_SAMPLE_RATE) / 1000.0
                    await asyncio.sleep(max(0.0, dur * SEND_PACING))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("ai_agent: speak failed", exc_info=True)
        finally:
            self._speaking = False

    async def _safe_speak(self, text: str) -> None:
        """Speak without letting a TTS failure abort the caller flow."""
        try:
            await self._speak_text(text)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("ai_agent: safe_speak failed", exc_info=True)

    async def _safe_send(self, payload) -> None:
        try:
            if isinstance(payload, (bytes, bytearray)):
                await self.ws.send_text(payload.decode("utf-8"))
            else:
                await self.ws.send_text(payload)
        except Exception:
            self._done.set()

    # ------------------------------------------------------------- fallbacks
    async def _fallback(self, reason: str) -> None:
        """A provider failed — apologize and transfer to the configured fallback
        (or hang up). Never leaves the caller in dead air."""
        logger.info("ai_agent: fallback (%s) for call %s", reason, self.call_uuid)
        self.outcome = "failed"
        self.status = "failed"
        try:
            await self._speak_text(
                "I'm sorry, I'm having trouble right now. Let me connect you with someone."
            )
        except Exception:
            pass
        await self._transfer_fallback()
        self._done.set()

    async def _transfer_fallback(self) -> None:
        dest = _valid_destination(self.cfg.fallback_destination or "")
        # HIGH-3: even the agent-configured fallback is gated on the fraud flag so
        # a mis-provisioned international/premium fallback can't be used for toll
        # fraud; deny → fall through to a graceful hangup.
        if dest and await _fraud_check_destination(dest, self.customer_id):
            try:
                await transfer_call_confirmed(self.call_uuid, dest, timeout=8.0)
                if self.outcome not in ("failed",):
                    self.outcome = "transferred"
                self.result.setdefault("fallback_destination", dest)
                return
            except Exception:
                logger.warning("ai_agent: fallback transfer failed", exc_info=True)
        try:
            await hangup_call_confirmed(self.call_uuid, timeout=5.0)
        except Exception:
            pass

    # ------------------------------------------------------------- persistence
    async def _persist_start(self) -> None:
        try:
            row = await db.fetch_one(
                """
                INSERT INTO ai_agent_sessions
                    (agent_id, call_uuid, customer_id, status, started_at)
                VALUES ($1::int, $2::text, $3::int, $4::text, NOW())
                RETURNING id
                """,
                self.cfg.id, self.call_uuid, self.customer_id, "active",
            )
            if row:
                self._session_row_id = row["id"]
        except Exception:
            logger.debug("ai_agent: session start persist failed", exc_info=True)

    async def _persist_end(self) -> None:
        if self._session_row_id is None:
            return
        transcript_json = None
        if self.cfg.store_transcript:
            try:
                import orjson
                transcript_json = orjson.dumps(self.transcript).decode()
            except Exception:
                transcript_json = None
        try:
            import orjson
            tool_json = orjson.dumps(self.tool_log).decode()
            result_json = orjson.dumps(self.result).decode()
        except Exception:
            tool_json, result_json = "[]", "{}"
        final_status = "failed" if self.status == "failed" else "completed"
        try:
            await db.execute(
                """
                UPDATE ai_agent_sessions SET
                    ended_at = NOW(),
                    status = $2::text,
                    outcome = $3::text,
                    turn_count = $4::int,
                    transcript = $5::jsonb,
                    tool_calls = $6::jsonb,
                    result = $7::jsonb,
                    stt_seconds = $8::numeric,
                    llm_prompt_tokens = $9::int,
                    llm_completion_tokens = $10::int,
                    tts_characters = $11::int
                WHERE id = $1::int
                """,
                self._session_row_id, final_status, self.outcome, self.turn_count,
                transcript_json, tool_json, result_json,
                round(self.stt_seconds, 2), self.llm_prompt_tokens,
                self.llm_completion_tokens, self.tts_characters,
            )
        except Exception:
            logger.debug("ai_agent: session end persist failed", exc_info=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_SENTENCE_END_RE = re.compile(r"[.!?]['\")\]]?\s")


def _pop_sentence(buffer: str) -> tuple[str, str]:
    """Split off the first complete sentence (>= a few chars) from ``buffer``.
    Returns (sentence_or_empty, remainder). Speaking per-sentence pipelines TTS
    with LLM generation so the caller hears the first words sooner."""
    if len(buffer) < 8:
        return "", buffer
    m = _SENTENCE_END_RE.search(buffer)
    if not m:
        # Speak on a hard newline too (list items, etc.).
        nl = buffer.find("\n")
        if nl >= 8:
            return buffer[: nl + 1], buffer[nl + 1:]
        return "", buffer
    end = m.end()
    return buffer[:end], buffer[end:]


async def _overflow_fallback(cfg: AgentConfig, call_uuid: str) -> None:
    """At-capacity path: transfer the call to the agent's fallback (or hang up).
    HIGH-3: the fallback destination is fraud-gated too."""
    dest = _valid_destination(cfg.fallback_destination or "")
    try:
        if dest and await _fraud_check_destination(dest, cfg.customer_id):
            await transfer_call_confirmed(call_uuid, dest, timeout=8.0)
        else:
            await hangup_call_confirmed(call_uuid, timeout=5.0)
    except Exception:
        logger.debug("ai_agent: overflow fallback failed", exc_info=True)


async def _safe_close(websocket: WebSocket, code: int, reason: str) -> None:
    try:
        if websocket.client_state != WebSocketState.DISCONNECTED:
            await websocket.close(code=code, reason=reason)
    except Exception:
        pass
