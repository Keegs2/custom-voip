"""AI voice-agent config CRUD + the media WebSocket the runtime speaks over.

Multi-tenant: every read/write is scoped to the caller's customer_id (admins,
``customer_filter=None``, may operate across customers). Ownership is gated with
a 404-no-leak helper — the canonical pattern from ``routers/api_dids.py``.

Two routers are exported:
  * ``router``    — REST CRUD + ``/{id}/runtime-config`` (mounted at
                    ``/v1/ai-agents`` and ``/ai-agents``, JWT-required).
  * ``ws_router`` — the ``/ai-agent`` WebSocket (mounted at ``/ws`` →
                    ``/ws/ai-agent``). FreeSWITCH ``mod_audio_stream`` connects
                    here; it authenticates with the shared ingest secret (query
                    param ``k``), NOT a JWT — the same trust boundary as the
                    CDR/voicemail/recording ingest endpoints. ``/ws/*`` is already
                    JWT-exempt in middleware, and Starlette's BaseHTTPMiddleware
                    never runs for WebSocket connections anyway.
"""
import os
import hmac
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, WebSocket
from pydantic import BaseModel, field_validator

from db import database as db
from auth.dependencies import get_customer_filter
from services import ai_config
from services import ai_agent

logger = logging.getLogger(__name__)

router = APIRouter()
ws_router = APIRouter()

# Provider allow-lists (soft — unknown values still resolve to a safe fallback in
# the factories, but we reject obvious typos at the API boundary).
_STT_PROVIDERS = {"whisper_http", "whisper", "self_hosted", "local", "deepgram", "noop", "none", "off"}
_LLM_PROVIDERS = {"openai_compat", "openai", "azure", "azure_openai", "vllm", "ollama", "self_hosted", "local"}
_TTS_PROVIDERS = {"http", "piper", "openedai", "self_hosted", "local", "openai", "elevenlabs", "eleven"}

# Columns returned by list/get (never expose more than config; key refs are env
# NAMES, not secrets, so they are safe to surface for the UI).
_PUBLIC_COLUMNS = """
    id, customer_id, name, enabled, system_prompt, greeting,
    stt_provider, stt_model, stt_language, stt_base_url, stt_api_key_ref,
    llm_provider, llm_model, llm_base_url, llm_api_key_ref, temperature, max_tokens,
    tts_provider, tts_voice, tts_model, tts_base_url, tts_api_key_ref,
    tools, fallback_destination, max_turns, max_duration_seconds,
    barge_in_enabled, store_transcript, created_at, updated_at
"""


# ---------------------------------------------------------------------------
# Validation helpers (shared by create/update)
# ---------------------------------------------------------------------------
import re

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
# LOW-11: re.ASCII so ``\d`` matches ONLY [0-9], never Unicode digits.
_E164_RE = re.compile(r"^\+[1-9]\d{1,14}$", re.ASCII)
_NANP_RE = re.compile(r"^1?[2-9]\d{9}$", re.ASCII)
_EXT_RE = re.compile(r"^\d{3,6}$", re.ASCII)


def _norm_fallback(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    v = v.strip()
    if v == "":
        return None
    if _CONTROL_RE.search(v):
        raise ValueError("fallback_destination contains illegal control characters")
    if _E164_RE.match(v):
        return v
    if _NANP_RE.match(v):
        return "+" + (v if v.startswith("1") and len(v) == 11 else "1" + v)
    if _EXT_RE.match(v):
        return v
    raise ValueError("fallback_destination must be E.164 (+15551234567) or a 3-6 digit extension")


def _validate_tools(v):
    if v is None:
        return None
    if not isinstance(v, list):
        raise ValueError("tools must be a list")
    for t in v:
        if not isinstance(t, dict):
            raise ValueError("each tool must be an object")
        name = t.get("name") or (t.get("function") or {}).get("name")
        if not name:
            raise ValueError("each tool needs a name")
        http = t.get("http")
        if http is not None:
            if not isinstance(http, dict) or not http.get("url"):
                raise ValueError(f"tool {name}: http block needs a url")
    return v


class AgentCreate(BaseModel):
    customer_id: int
    name: str
    system_prompt: str = "You are a helpful voice assistant answering a phone call. Keep replies short and spoken-friendly."
    greeting: Optional[str] = "Hello, thanks for calling. How can I help you today?"
    enabled: bool = True

    stt_provider: Optional[str] = None
    stt_model: Optional[str] = None
    stt_language: Optional[str] = None
    stt_base_url: Optional[str] = None
    stt_api_key_ref: Optional[str] = None

    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_api_key_ref: Optional[str] = None
    temperature: float = 0.4
    max_tokens: int = 512

    tts_provider: Optional[str] = None
    tts_voice: Optional[str] = None
    tts_model: Optional[str] = None
    tts_base_url: Optional[str] = None
    tts_api_key_ref: Optional[str] = None

    tools: Optional[list] = None
    fallback_destination: Optional[str] = None
    max_turns: int = 40
    max_duration_seconds: int = 600
    barge_in_enabled: bool = True
    store_transcript: bool = True

    @field_validator("name")
    @classmethod
    def _name_nonempty(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("name is required")
        if len(v) > 120:
            raise ValueError("name too long (max 120)")
        return v

    @field_validator("temperature")
    @classmethod
    def _temp_range(cls, v: float) -> float:
        if v < 0 or v > 2:
            raise ValueError("temperature must be between 0 and 2")
        return v

    @field_validator("max_tokens")
    @classmethod
    def _tokens_range(cls, v: int) -> int:
        if v < 16 or v > 4096:
            raise ValueError("max_tokens must be between 16 and 4096")
        return v

    @field_validator("max_turns")
    @classmethod
    def _turns_range(cls, v: int) -> int:
        if v < 1 or v > 200:
            raise ValueError("max_turns must be between 1 and 200")
        return v

    @field_validator("max_duration_seconds")
    @classmethod
    def _dur_range(cls, v: int) -> int:
        if v < 10 or v > 7200:
            raise ValueError("max_duration_seconds must be between 10 and 7200")
        return v

    @field_validator("stt_provider")
    @classmethod
    def _stt_ok(cls, v):
        if v is not None and v.lower() not in _STT_PROVIDERS:
            raise ValueError(f"unknown stt_provider (allowed: {sorted(_STT_PROVIDERS)})")
        return v

    @field_validator("llm_provider")
    @classmethod
    def _llm_ok(cls, v):
        if v is not None and v.lower() not in _LLM_PROVIDERS:
            raise ValueError(f"unknown llm_provider (allowed: {sorted(_LLM_PROVIDERS)})")
        return v

    @field_validator("tts_provider")
    @classmethod
    def _tts_ok(cls, v):
        if v is not None and v.lower() not in _TTS_PROVIDERS:
            raise ValueError(f"unknown tts_provider (allowed: {sorted(_TTS_PROVIDERS)})")
        return v

    @field_validator("fallback_destination")
    @classmethod
    def _fallback_ok(cls, v):
        return _norm_fallback(v)

    @field_validator("tools")
    @classmethod
    def _tools_ok(cls, v):
        return _validate_tools(v)


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    greeting: Optional[str] = None
    enabled: Optional[bool] = None

    stt_provider: Optional[str] = None
    stt_model: Optional[str] = None
    stt_language: Optional[str] = None
    stt_base_url: Optional[str] = None
    stt_api_key_ref: Optional[str] = None

    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_api_key_ref: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None

    tts_provider: Optional[str] = None
    tts_voice: Optional[str] = None
    tts_model: Optional[str] = None
    tts_base_url: Optional[str] = None
    tts_api_key_ref: Optional[str] = None

    tools: Optional[list] = None
    fallback_destination: Optional[str] = None
    max_turns: Optional[int] = None
    max_duration_seconds: Optional[int] = None
    barge_in_enabled: Optional[bool] = None
    store_transcript: Optional[bool] = None

    # Reuse the same validators as create (only fire when the field is provided).
    _temp_range = AgentCreate.__dict__["_temp_range"]
    _tokens_range = AgentCreate.__dict__["_tokens_range"]
    _turns_range = AgentCreate.__dict__["_turns_range"]
    _dur_range = AgentCreate.__dict__["_dur_range"]
    _stt_ok = AgentCreate.__dict__["_stt_ok"]
    _llm_ok = AgentCreate.__dict__["_llm_ok"]
    _tts_ok = AgentCreate.__dict__["_tts_ok"]
    _fallback_ok = AgentCreate.__dict__["_fallback_ok"]
    _tools_ok = AgentCreate.__dict__["_tools_ok"]


async def _get_owned_agent(agent_id: int, customer_filter: int | None) -> dict:
    """Fetch an agent enforcing tenant isolation. 404 if it does not exist OR
    belongs to another customer (existence is never leaked cross-tenant)."""
    row = await db.fetch_one(
        "SELECT id, customer_id FROM ai_agents WHERE id = $1", agent_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="AI agent not found")
    if customer_filter is not None and row["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="AI agent not found")
    return dict(row)


def _serialize(row) -> dict:
    d = dict(row)
    tools = d.get("tools")
    if isinstance(tools, (bytes, bytearray, str)):
        try:
            import orjson
            d["tools"] = orjson.loads(tools)
        except Exception:
            d["tools"] = []
    if d.get("temperature") is not None:
        d["temperature"] = float(d["temperature"])
    return d


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------
@router.get("")
async def list_agents(
    customer_id: Optional[int] = None,
    enabled: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List AI agents. Non-admins are scoped to their own customer."""
    query = f"SELECT {_PUBLIC_COLUMNS} FROM ai_agents WHERE 1=1"
    values = []
    idx = 1
    if customer_filter is not None:
        query += f" AND customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1
    elif customer_id is not None:
        query += f" AND customer_id = ${idx}"
        values.append(customer_id)
        idx += 1
    if enabled is not None:
        query += f" AND enabled = ${idx}"
        values.append(enabled)
        idx += 1
    query += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([max(1, min(limit, 500)), max(0, offset)])
    rows = await db.fetch_all(query, *values)
    return [_serialize(r) for r in rows]


@router.post("")
async def create_agent(
    agent: AgentCreate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Create an AI agent. Non-admins may only create within their own customer;
    the payload's customer_id is forced to the caller's."""
    customer_id = agent.customer_id
    if customer_filter is not None:
        customer_id = customer_filter

    customer = await db.fetch_one(
        "SELECT id, status FROM customers WHERE id = $1", customer_id
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    if customer["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    import orjson
    tools_json = orjson.dumps(agent.tools or []).decode()
    row = await db.fetch_one(
        f"""
        INSERT INTO ai_agents (
            customer_id, name, enabled, system_prompt, greeting,
            stt_provider, stt_model, stt_language, stt_base_url, stt_api_key_ref,
            llm_provider, llm_model, llm_base_url, llm_api_key_ref, temperature, max_tokens,
            tts_provider, tts_voice, tts_model, tts_base_url, tts_api_key_ref,
            tools, fallback_destination, max_turns, max_duration_seconds,
            barge_in_enabled, store_transcript
        ) VALUES (
            $1::int, $2::text, $3::bool, $4::text, $5::text,
            $6::text, $7::text, $8::text, $9::text, $10::text,
            $11::text, $12::text, $13::text, $14::text, $15::numeric, $16::int,
            $17::text, $18::text, $19::text, $20::text, $21::text,
            $22::jsonb, $23::text, $24::int, $25::int,
            $26::bool, $27::bool
        )
        RETURNING {_PUBLIC_COLUMNS}
        """,
        customer_id, agent.name, agent.enabled, agent.system_prompt, agent.greeting,
        agent.stt_provider, agent.stt_model, agent.stt_language, agent.stt_base_url, agent.stt_api_key_ref,
        agent.llm_provider, agent.llm_model, agent.llm_base_url, agent.llm_api_key_ref, agent.temperature, agent.max_tokens,
        agent.tts_provider, agent.tts_voice, agent.tts_model, agent.tts_base_url, agent.tts_api_key_ref,
        tools_json, agent.fallback_destination, agent.max_turns, agent.max_duration_seconds,
        agent.barge_in_enabled, agent.store_transcript,
    )
    return _serialize(row)


@router.get("/{agent_id}")
async def get_agent(
    agent_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get one AI agent (tenant-scoped)."""
    await _get_owned_agent(agent_id, customer_filter)
    row = await db.fetch_one(
        f"SELECT {_PUBLIC_COLUMNS} FROM ai_agents WHERE id = $1", agent_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="AI agent not found")
    return _serialize(row)


@router.put("/{agent_id}")
@router.patch("/{agent_id}")
async def update_agent(
    agent_id: int,
    update: AgentUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Update an AI agent (tenant-scoped, partial)."""
    await _get_owned_agent(agent_id, customer_filter)

    fields = update.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates = []
    values = []
    idx = 1
    for field, value in fields.items():
        if field == "tools":
            import orjson
            updates.append(f"tools = ${idx}::jsonb")
            values.append(orjson.dumps(value).decode())
        else:
            updates.append(f"{field} = ${idx}")
            values.append(value)
        idx += 1
    updates.append("updated_at = NOW()")
    values.append(agent_id)
    query = (
        f"UPDATE ai_agents SET {', '.join(updates)} WHERE id = ${idx} "
        f"RETURNING {_PUBLIC_COLUMNS}"
    )
    row = await db.fetch_one(query, *values)
    if not row:
        raise HTTPException(status_code=404, detail="AI agent not found")
    return _serialize(row)


@router.delete("/{agent_id}")
async def delete_agent(
    agent_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Delete an AI agent (tenant-scoped)."""
    await _get_owned_agent(agent_id, customer_filter)
    result = await db.execute("DELETE FROM ai_agents WHERE id = $1", agent_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="AI agent not found")
    return {"status": "deleted", "agent_id": agent_id}


@router.get("/{agent_id}/runtime-config")
async def get_runtime_config(
    agent_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Resolved runtime view for an agent: the providers that WOULD be used, the
    compliance signal (does data stay in the VPC?), the tool schema the model
    sees, and the exact ``<Connect><Stream>`` TwiML the flow/DID layer must emit
    to route a call here. Tenant-scoped."""
    await _get_owned_agent(agent_id, customer_filter)
    cfg = await ai_config.load_agent_config(agent_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail="AI agent not found")
    providers = ai_config.build_providers(cfg)
    return {
        "agent_id": cfg.id,
        "customer_id": cfg.customer_id,
        "name": cfg.name,
        "enabled": cfg.enabled,
        "stt": {"provider": providers.stt.name, "mode": providers.stt.mode,
                "self_hosted": providers.stt.self_hosted},
        "llm": {"provider": providers.llm.name, "model": providers.llm.model,
                "self_hosted": providers.llm.self_hosted},
        "tts": {"provider": providers.tts.name, "self_hosted": providers.tts.self_hosted},
        "data_stays_in_vpc": providers.data_stays_in_vpc,
        "tools": ai_config.build_tool_schema(cfg),
        "guardrails": {
            "max_turns": cfg.max_turns,
            "max_duration_seconds": cfg.max_duration_seconds,
            "barge_in_enabled": cfg.barge_in_enabled,
            "store_transcript": cfg.store_transcript,
            "fallback_destination": cfg.fallback_destination,
        },
        "ws_path": ai_config.WS_PATH,
        # Flow/DID layer substitutes the real CallSid/AccountSid at call time.
        "connect_twiml_template": ai_config.connect_twiml(
            cfg.id, "{{CallSid}}", cfg.customer_id
        ),
    }


# ---------------------------------------------------------------------------
# Media WebSocket — FreeSWITCH mod_audio_stream connects here
# ---------------------------------------------------------------------------
def _ws_ingest_secret(websocket: WebSocket) -> str:
    """Extract the ingest secret from a WS handshake.

    The ``X-Ingest-Secret`` header is PREFERRED (keeps the secret out of access
    logs); the ``k`` query param is the current mod_audio_stream contract and the
    fallback. Header wins when both are present. FreeSWITCH can be switched to the
    header later without an API change."""
    return (
        websocket.headers.get("x-ingest-secret")
        or websocket.query_params.get(ai_config.WS_PARAM_SECRET)
        or ""
    )


def _ws_secret_ok(websocket: WebSocket) -> bool:
    """Constant-time check of the ingest shared secret on a media WebSocket.

    Mirrors ``auth.ingest.ingest_secret_ok`` — the SAME trust boundary as the
    CDR/voicemail/recording ingest. The secret arrives via the ``X-Ingest-Secret``
    header (preferred) or the ``k`` query param. When ``INGEST_SHARED_SECRET`` is
    unset the connection is allowed in local dev, but REFUSED in production
    (fail-closed; the config guard already refuses to boot prod without it)."""
    secret = os.getenv("INGEST_SHARED_SECRET", "")
    if not secret:
        from config_guard import is_production
        if is_production():
            logger.error(
                "ws ingest: INGEST_SHARED_SECRET is unset in production — refusing WS"
            )
            return False
        return True
    return hmac.compare_digest(_ws_ingest_secret(websocket), secret)


@ws_router.websocket("/ai-agent")
async def ai_agent_ws(websocket: WebSocket):
    """Bidirectional media socket for the AI voice-agent runtime.

    Query params (the contract in services.ai_config):
      agent_id (int, required), call_uuid (str, required),
      customer_id (int, optional hint), k (ingest shared secret).
    """
    qp = websocket.query_params
    if not _ws_secret_ok(websocket):
        # Reject BEFORE accept → clean 403 handshake, no session spun up.
        await websocket.close(code=4401, reason="unauthorized")
        return

    try:
        agent_id = int(qp.get(ai_config.WS_PARAM_AGENT, ""))
    except (TypeError, ValueError):
        await websocket.close(code=4400, reason="missing agent_id")
        return
    call_uuid = (qp.get(ai_config.WS_PARAM_CALL) or "").strip()
    if not call_uuid:
        await websocket.close(code=4400, reason="missing call_uuid")
        return
    customer_hint = None
    try:
        customer_hint = int(qp.get(ai_config.WS_PARAM_CUSTOMER, "")) or None
    except (TypeError, ValueError):
        customer_hint = None

    await websocket.accept()
    logger.info(
        "ai_agent ws: agent=%s call=%s customer_hint=%s", agent_id, call_uuid, customer_hint
    )
    try:
        await ai_agent.run_agent_session(websocket, agent_id, call_uuid, customer_hint)
    except Exception:
        logger.warning("ai_agent ws: session crashed", exc_info=True)
        try:
            await websocket.close(code=1011, reason="internal error")
        except Exception:
            pass
