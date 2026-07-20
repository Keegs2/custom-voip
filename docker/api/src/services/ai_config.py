"""AI voice-agent configuration: DB loader, provider factory, runtime contract.

An ``ai_agents`` row is the tenant-owned config for one voice agent (prompt,
greeting, provider selections, tools, guardrails). This module turns that row
into a typed :class:`AgentConfig`, wires the three pluggable providers
(STT/LLM/TTS) from it, builds the tool schema the LLM sees, and owns the single
source of truth for the mod_audio_stream WebSocket URL contract.

Compliance is a first-class output here: :meth:`AgentConfig.data_stays_in_vpc`
reports whether EVERY selected provider is self-hosted (in-VPC), so the runtime
and UI can prove "no PHI/CPNI leaves the boundary" for a given agent.

Secrets are NOT stored in the DB. A cloud agent references an env var NAME
(``*_api_key_ref``, e.g. ``OPENAI_API_KEY``); the runtime resolves the actual key
from the process environment. This keeps keys out of the tenant-readable config
and out of any transcript/backup.
"""
from __future__ import annotations

import os
import re
import logging
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urlencode

from db import database as db
from services import stt as stt_mod
from services import llm as llm_mod
from services import tts as tts_mod

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# api_key_ref env-name allow-list (CRITICAL-1)
# ---------------------------------------------------------------------------
# A ``*_api_key_ref`` is a TENANT-SUPPLIED env var NAME the runtime resolves to a
# real key. Resolving an ARBITRARY name is a full-platform-compromise hole: a
# tenant sets ``llm_api_key_ref="JWT_SECRET_KEY"`` (or DATABASE_URL /
# ENVELOPE_LOCAL_KEK / INGEST_SHARED_SECRET / FREESWITCH_ESL_PASSWORD /
# BANDWIDTH_API_CLIENT_SECRET) plus a tenant-controlled ``*_base_url`` pointing at
# their server, and the runtime sends that platform secret as a Bearer header to
# them. So we allow ONLY these env NAMEs: the AI-namespaced ones (operators mint
# per-tenant provider keys here) and the four well-known cloud-provider keys.
_ALLOWED_KEY_ENV_NAMES = frozenset({
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "ELEVENLABS_API_KEY",
})
_ALLOWED_KEY_ENV_RE = re.compile(r"^AI_(LLM|STT|TTS)_[A-Z0-9_]*$")


# ---------------------------------------------------------------------------
# Typed config
# ---------------------------------------------------------------------------
@dataclass
class AgentConfig:
    id: int
    customer_id: int
    name: str
    enabled: bool = True
    system_prompt: str = "You are a helpful voice assistant for a phone call."
    greeting: str = "Hello, how can I help you today?"

    # STT
    stt_provider: Optional[str] = None
    stt_model: Optional[str] = None
    stt_language: Optional[str] = None
    stt_base_url: Optional[str] = None
    stt_api_key_ref: Optional[str] = None

    # LLM
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_api_key_ref: Optional[str] = None
    temperature: float = 0.4
    max_tokens: int = 512

    # TTS
    tts_provider: Optional[str] = None
    tts_voice: Optional[str] = None
    tts_model: Optional[str] = None
    tts_base_url: Optional[str] = None
    tts_api_key_ref: Optional[str] = None

    # Behavior / guardrails
    tools: list[dict] = field(default_factory=list)
    fallback_destination: Optional[str] = None   # E.164/ext to transfer to on failure
    max_turns: int = 40
    max_duration_seconds: int = 600
    barge_in_enabled: bool = True
    store_transcript: bool = True                 # per-agent compliance switch

    @staticmethod
    def _resolve_key(ref: Optional[str]) -> Optional[str]:
        """A ``*_api_key_ref`` is an ENV VAR NAME; resolve it to the actual key.

        SECURITY (CRITICAL-1): ``ref`` is tenant-supplied, so an env-NAME lookup is
        ALLOW-LISTED — only ``AI_(LLM|STT|TTS)_*`` names or the four known
        cloud-provider keys are ever resolved via ``os.getenv``. Any other name
        (e.g. ``JWT_SECRET_KEY``, ``DATABASE_URL``) resolves to None (no key
        attached) and is logged, so a tenant can never exfiltrate an arbitrary
        platform secret through the provider Bearer header.

        A tenant that inlines its OWN literal key (not an env NAME) is harmless, so
        that operator-convenience branch is preserved.
        """
        if not ref:
            return None
        # Allow-listed env NAME → resolve from the process environment.
        if ref in _ALLOWED_KEY_ENV_NAMES or _ALLOWED_KEY_ENV_RE.match(ref):
            return os.getenv(ref) or None
        # A bare UPPER_SNAKE token that is NOT allow-listed is an attempt to
        # resolve some other (platform) env var — refuse and log the NAME only.
        if ref.isupper() and " " not in ref:
            logger.warning(
                "ai_config: refusing to resolve non-allow-listed api_key_ref env "
                "name %r (only AI_(LLM|STT|TTS)_* or known provider keys are allowed)",
                ref,
            )
            return None
        # Operator convenience: an accidentally-inlined literal key (not an env
        # name). A tenant inlining its own key is harmless.
        if " " not in ref and len(ref) > 12:
            return ref
        return None

    def build_stt(self) -> stt_mod.STTProvider:
        return stt_mod.get_stt_provider(
            self.stt_provider,
            base_url=self.stt_base_url,
            model=self.stt_model,
            language=self.stt_language,
            api_key=self._resolve_key(self.stt_api_key_ref),
        )

    def build_llm(self) -> llm_mod.LLMProvider:
        return llm_mod.get_llm_provider(
            self.llm_provider,
            base_url=self.llm_base_url,
            model=self.llm_model,
            api_key=self._resolve_key(self.llm_api_key_ref),
        )

    def build_tts(self) -> tts_mod.TTSProvider:
        return tts_mod.get_tts_provider(
            self.tts_provider,
            base_url=self.tts_base_url,
            voice=self.tts_voice,
            model=self.tts_model,
            api_key=self._resolve_key(self.tts_api_key_ref),
        )


@dataclass
class ProviderBundle:
    stt: stt_mod.STTProvider
    llm: llm_mod.LLMProvider
    tts: tts_mod.TTSProvider

    @property
    def data_stays_in_vpc(self) -> bool:
        """True iff STT, LLM AND TTS are all self-hosted (no cloud egress)."""
        return bool(
            getattr(self.stt, "self_hosted", False)
            and getattr(self.llm, "self_hosted", False)
            and getattr(self.tts, "self_hosted", False)
        )


def build_providers(cfg: AgentConfig) -> ProviderBundle:
    """Instantiate the STT/LLM/TTS providers selected by ``cfg`` (never raises;
    each factory degrades to a safe fallback on misconfig)."""
    return ProviderBundle(stt=cfg.build_stt(), llm=cfg.build_llm(), tts=cfg.build_tts())


# ---------------------------------------------------------------------------
# DB loader
# ---------------------------------------------------------------------------
_AGENT_COLUMNS = """
    id, customer_id, name, enabled, system_prompt, greeting,
    stt_provider, stt_model, stt_language, stt_base_url, stt_api_key_ref,
    llm_provider, llm_model, llm_base_url, llm_api_key_ref, temperature, max_tokens,
    tts_provider, tts_voice, tts_model, tts_base_url, tts_api_key_ref,
    tools, fallback_destination, max_turns, max_duration_seconds,
    barge_in_enabled, store_transcript
"""


def _row_to_config(row) -> AgentConfig:
    d = dict(row)
    tools = d.get("tools")
    if isinstance(tools, (bytes, bytearray, str)):
        try:
            import orjson
            tools = orjson.loads(tools)
        except Exception:
            tools = []
    if not isinstance(tools, list):
        tools = []
    return AgentConfig(
        id=d["id"],
        customer_id=d["customer_id"],
        name=d.get("name") or f"agent-{d['id']}",
        enabled=bool(d.get("enabled", True)),
        system_prompt=d.get("system_prompt") or AgentConfig.system_prompt,
        greeting=d.get("greeting") or AgentConfig.greeting,
        stt_provider=d.get("stt_provider"),
        stt_model=d.get("stt_model"),
        stt_language=d.get("stt_language"),
        stt_base_url=d.get("stt_base_url"),
        stt_api_key_ref=d.get("stt_api_key_ref"),
        llm_provider=d.get("llm_provider"),
        llm_model=d.get("llm_model"),
        llm_base_url=d.get("llm_base_url"),
        llm_api_key_ref=d.get("llm_api_key_ref"),
        temperature=float(d.get("temperature") if d.get("temperature") is not None else 0.4),
        max_tokens=int(d.get("max_tokens") or 512),
        tts_provider=d.get("tts_provider"),
        tts_voice=d.get("tts_voice"),
        tts_model=d.get("tts_model"),
        tts_base_url=d.get("tts_base_url"),
        tts_api_key_ref=d.get("tts_api_key_ref"),
        tools=tools,
        fallback_destination=d.get("fallback_destination"),
        max_turns=int(d.get("max_turns") or 40),
        max_duration_seconds=int(d.get("max_duration_seconds") or 600),
        barge_in_enabled=bool(d.get("barge_in_enabled", True)),
        store_transcript=bool(d.get("store_transcript", True)),
    )


async def load_agent_config(agent_id: int) -> Optional[AgentConfig]:
    """Load an agent's config by id. Returns None if it does not exist. Tenant
    ownership is enforced by the caller (the WS handler binds the session to
    ``row.customer_id`` — the authoritative owner)."""
    row = await db.fetch_one(
        f"SELECT {_AGENT_COLUMNS} FROM ai_agents WHERE id = $1", agent_id
    )
    if not row:
        return None
    return _row_to_config(row)


# ---------------------------------------------------------------------------
# Tool schema for the LLM
# ---------------------------------------------------------------------------
# Built-in tools map to real call actions in ai_agent (ESL). Custom tools come
# from the agent's `tools` JSONB (each an OpenAI function schema, optionally with
# an {"http": {...}} block the runtime calls). The names below are the contract
# ai_agent dispatches on.
BUILTIN_TRANSFER = "transfer_call"
BUILTIN_DTMF = "send_dtmf"
BUILTIN_HANGUP = "end_call"
BUILTIN_CAPTURE = "capture_result"
BUILTIN_TOOL_NAMES = {BUILTIN_TRANSFER, BUILTIN_DTMF, BUILTIN_HANGUP, BUILTIN_CAPTURE}

_BUILTIN_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": BUILTIN_TRANSFER,
            "description": (
                "Transfer the live call to a human or another destination. Use for "
                "escalation or when the caller asks for a person."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "destination": {
                        "type": "string",
                        "description": "E.164 number (e.g. +15551234567) or internal extension.",
                    },
                    "reason": {"type": "string", "description": "Short reason for the transfer."},
                },
                "required": ["destination"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": BUILTIN_DTMF,
            "description": "Send DTMF tones on the call (navigate an IVR, enter a code).",
            "parameters": {
                "type": "object",
                "properties": {
                    "digits": {"type": "string", "description": "Digits 0-9*#A-D to send."}
                },
                "required": ["digits"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": BUILTIN_HANGUP,
            "description": "End the call. Use after saying goodbye or resolving the request.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {"type": "string", "description": "Why the call is ending."}
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": BUILTIN_CAPTURE,
            "description": (
                "Record structured data collected during the call (name, account "
                "number, intent, disposition). Does not end the call."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "data": {"type": "object", "description": "Key/value data to persist."}
                },
                "required": ["data"],
            },
        },
    },
]


def build_tool_schema(cfg: AgentConfig) -> list[dict]:
    """Assemble the OpenAI ``tools`` array: built-ins the agent enables + custom
    tools from config. If ``cfg.tools`` is empty, all built-ins are offered.

    A custom tool entry may be either a full ``{"type":"function","function":{...}}``
    object or a compact ``{"name","description","parameters","http":{...}}`` — the
    ``http`` block (method/url) is stripped from what the model sees (it is only
    used by the runtime to execute the call)."""
    schema: list[dict] = list(_BUILTIN_TOOL_SCHEMAS)
    for t in cfg.tools or []:
        if not isinstance(t, dict):
            continue
        if t.get("type") == "function" and isinstance(t.get("function"), dict):
            fn = {k: v for k, v in t["function"].items()}
            schema.append({"type": "function", "function": fn})
        elif t.get("name"):
            schema.append({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("parameters", {"type": "object", "properties": {}}),
                },
            })
    return schema


def custom_tool_map(cfg: AgentConfig) -> dict[str, dict]:
    """Return {tool_name: {"http": {...}}} for custom tools that carry an http
    execution block (the runtime calls these; built-ins are handled in-process)."""
    out: dict[str, dict] = {}
    for t in cfg.tools or []:
        if not isinstance(t, dict):
            continue
        name = t.get("name") or (t.get("function") or {}).get("name")
        http = t.get("http")
        if name and isinstance(http, dict):
            out[name] = {"http": http}
    return out


# ---------------------------------------------------------------------------
# WebSocket URL contract (single source of truth)
# ---------------------------------------------------------------------------
# The telephony/flow layer routes a call to an agent by forking its audio to this
# URL via TwiML <Connect><Stream url="..."/> (mod_audio_stream). The query params
# below are the CONTRACT the runtime reads. `k` carries INGEST_SHARED_SECRET so
# only FreeSWITCH can open a session (constant-time checked, same trust boundary
# as the CDR/voicemail/recording ingest).
WS_PATH = "/ws/ai-agent"
WS_PARAM_AGENT = "agent_id"
WS_PARAM_CALL = "call_uuid"
WS_PARAM_CUSTOMER = "customer_id"
WS_PARAM_SECRET = "k"


def build_stream_ws_url(agent_id: int, call_uuid: str, customer_id: int,
                        public_base: Optional[str] = None,
                        include_secret: bool = True) -> str:
    """Build the ``<Stream url=...>`` the flow/webhook layer must emit.

    ``public_base`` defaults to ``AI_WS_PUBLIC_BASE`` (e.g.
    ``ws://<services-vm-ip>:8000`` in prod). The flow compiler substitutes the
    real ``call_uuid`` (the TwiML CallSid) and ``customer_id`` (AccountSid) when
    it renders this for a specific call."""
    base = (public_base or os.getenv("AI_WS_PUBLIC_BASE", "ws://127.0.0.1:8000")).rstrip("/")
    params = {
        WS_PARAM_AGENT: agent_id,
        WS_PARAM_CALL: call_uuid,
        WS_PARAM_CUSTOMER: customer_id,
    }
    if include_secret:
        secret = os.getenv("INGEST_SHARED_SECRET", "")
        if secret:
            params[WS_PARAM_SECRET] = secret
    return f"{base}{WS_PATH}?{urlencode(params)}"


def connect_twiml(agent_id: int, call_uuid: str, customer_id: int,
                  public_base: Optional[str] = None) -> str:
    """The exact TwiML a DID's voice_url / a Call Flow 'AI Agent' node must return
    to hand a call to this agent. Bidirectional media (Connect owns the call)."""
    url = build_stream_ws_url(agent_id, call_uuid, customer_id, public_base)
    # Escape & for XML attribute correctness.
    url_xml = url.replace("&", "&amp;")
    return f'<Response><Connect><Stream url="{url_xml}"/></Connect></Response>'
