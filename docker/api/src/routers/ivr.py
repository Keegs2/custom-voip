"""Visual IVR product API (contract docs/IVR_INTERFACES.md §8.2 customer, §8.3 admin).

Mounted at ``/v1/ivr`` and ``/ivr`` (main.py). The UI calls ``/api/v1/ivr/...``
(nginx strips ``/api``).

Scope (the voicemail ``vm_scope`` pattern, §8.2):
  * admin    — ``?customer_id=`` picks the customer and may act on any of its
               resources; an admin JWT with ``customer_id = null`` and no
               ``?customer_id=`` => 400 ``customer_id required`` (the portal's
               "View as Customer" preview shows its PreviewPrompt instead).
  * user     — scoped to the JWT ``customer_id``; another customer's
               ``customer_id`` param or object => 404 (no existence leak).
  * readonly — reads (GET), plus the read-only POSTs validate / simulate /
               playback-token; every write => 403.
  * support  — 403 (no customer).
Entitlement: every route except ``GET /summary`` => 403 ``ivr_not_enabled``
while ``customers.ivr_enabled`` is false. ``GET .../prompts/{id}/audio`` is
JWT-exempt (middleware) and verifies the ``?t=`` playback token.

Security model (fixes the unified branch's holes):
  * the browser never supplies executable logic — publish compiles the
    STORED draft at the given revision on the server (services/ivr/compiler);
  * a number can only be bound to a flow of the same customer (checked here
    and by 59's composite FK); there is no "repoint a DID" route at all;
  * no URLs, no webhooks, no free-form caller ID; transfer targets go through
    the dial policy (US only, own numbers from the customer's CURRENT list);
  * no customer free text in the plan (names/labels/TTS text stay in tables).

Business logic lives in ``services/ivr/``; this module is the HTTP surface,
scoping and transactions. 4xx ``detail`` strings are short user-facing
sentences, except the machine codes the contract pins (``ivr_not_enabled``,
``stale_revision``, ``flow_in_use``, ``prompt_in_use``, ``invalid_flow``,
``invalid_graph``, ``customer_id required``).
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import ORJSONResponse
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user, require_admin
from auth.playback import (
    PLAYBACK_TTL_SECONDS,
    PlaybackNotConfigured,
    PlaybackTokenError,
    mint_playback_token,
    verify_playback_token,
)
from db import database as db
from services import customer_numbers as cn
from services.ivr import audio as ivr_audio
from services.ivr import compiler, limits, simulator, store, tts
from services.ivr.assist import jobs as assist_jobs
from services.ivr.assist import pipeline as assist_pipeline
from utils.phone import normalize_e164

logger = logging.getLogger(__name__)

router = APIRouter()

INT64_MAX = 9_223_372_036_854_775_807
URL_PREFIX = "/api/v1/ivr"
PLAYBACK_KIND = "ivr_prompt"

MSG_NO_CUSTOMER = "Your account is not linked to a customer."
MSG_SUPPORT = "IVR is not available to support accounts."
MSG_READONLY = "Read-only accounts can't change the IVR."
MSG_NOT_FOUND = "Not found."
MSG_FLOW_NOT_FOUND = "Call flow not found."
MSG_VERSION_NOT_FOUND = "That version doesn't exist."
MSG_NUMBER_NOT_FOUND = "IVR number not found."
MSG_PROMPT_NOT_FOUND = "Message not found."
MSG_TTS_DOWN = "Text-to-speech is temporarily unavailable. Try again in a few minutes."
MSG_TTS_REJECTED = "That text can't be read aloud. Try different wording."
MSG_BAD_VOICE = "Choose one of the available voices."
MSG_AUDIO_UNAVAILABLE = "Audio is temporarily unavailable. Try again in a few minutes."
MSG_RETRY = "Something changed while saving. Please try again."


# ===========================================================================
# Errors with extra body fields ({"detail": ..., "current_revision": 3})
# ===========================================================================
class IvrApiError(HTTPException):
    """An HTTPException whose JSON body carries extra keys next to ``detail``
    (contract §8.2: stale_revision + current_revision, invalid_flow + errors,
    prompt_in_use + flows). main.py registers ``ivr_error_handler``; without it
    FastAPI still answers ``{"detail": <code>}``."""

    def __init__(self, status_code: int, detail: str, headers: dict | None = None, **extra):
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.extra = extra


async def ivr_error_handler(request: Request, exc: IvrApiError) -> ORJSONResponse:
    return ORJSONResponse({"detail": exc.detail, **exc.extra}, status_code=exc.status_code,
                          headers=exc.headers)


def _invalid_flow(errors: list[compiler.Issue], warnings: list[compiler.Issue] = ()) -> IvrApiError:
    return IvrApiError(422, "invalid_flow", errors=[e.as_dict() for e in errors],
                       warnings=[w.as_dict() for w in warnings])


# ===========================================================================
# Scope
# ===========================================================================
@dataclass(frozen=True)
class IvrScope:
    role: str
    user_id: Optional[int]
    customer_id: int  # the customer acted on (admin: the param / own claim)

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) < 12:
        return int(value)
    return None


async def ivr_scope(request: Request, customer_id: Optional[int] = Query(None)) -> IvrScope:
    user = await get_current_user(request)
    role = user.get("role")
    user_id = _int_or_none(user.get("sub"))
    if role == "admin":
        cid = customer_id if customer_id is not None else _int_or_none(user.get("customer_id"))
        if cid is None or cid <= 0:
            raise HTTPException(status_code=400, detail="customer_id required")
        return IvrScope("admin", user_id, cid)
    if role == "support":
        raise HTTPException(status_code=403, detail=MSG_SUPPORT)
    if role in ("user", "readonly"):
        own = _int_or_none(user.get("customer_id"))
        if own is None or own <= 0:
            raise HTTPException(status_code=403, detail=MSG_NO_CUSTOMER)
        if customer_id is not None and customer_id != own:
            raise HTTPException(status_code=404, detail=MSG_NOT_FOUND)
        return IvrScope(role, user_id, own)
    raise HTTPException(status_code=403, detail="Not allowed.")


async def ivr_writer(scope: IvrScope = Depends(ivr_scope)) -> IvrScope:
    if scope.role == "readonly":
        raise HTTPException(status_code=403, detail=MSG_READONLY)
    return scope


async def _pool():
    pool = db.pool or await db.get_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="The service is temporarily unavailable.")
    return pool


async def _require_entitled(conn: Any, scope: IvrScope) -> None:
    row = await conn.fetchrow("SELECT ivr_enabled FROM customers WHERE id = $1::int",
                              scope.customer_id)
    if row is None:
        raise HTTPException(status_code=404, detail=store.MSG_CUSTOMER_NOT_FOUND)
    if not row["ivr_enabled"]:
        raise HTTPException(status_code=403, detail="ivr_not_enabled")


def _id64(value: int, detail: str) -> int:
    if not 1 <= value <= INT64_MAX:
        raise HTTPException(status_code=404, detail=detail)
    return value


def _graph_bytes_ok(graph: Any) -> None:
    if len(store.dumps(graph).encode("utf-8")) > limits.MAX_GRAPH_BYTES:
        raise IvrApiError(422, "invalid_graph", errors=[compiler.Issue(
            "graph_too_large", "This call flow is too large to save.").as_dict()])


def _check_draft(graph: Any) -> None:
    """Structural checks every draft write must pass (never a missing Start)."""
    _graph_bytes_ok(graph)
    issues = compiler.check_graph_shape(graph)
    if issues:
        raise IvrApiError(422, "invalid_graph", errors=[i.as_dict() for i in issues])


# ===========================================================================
# Flow helpers
# ===========================================================================
async def _flow_out(conn: Any, flow_id: int) -> dict:
    row = await conn.fetchrow(store.FLOW_SUMMARY_SELECT + " WHERE f.id = $1::bigint", flow_id)
    out = store.flow_summary_out(row)
    out["draft_graph"] = store.loads(
        await conn.fetchval("SELECT draft_graph FROM call_flows WHERE id = $1::bigint", flow_id))
    return out


async def _scoped_flow(conn: Any, scope: IvrScope, flow_id: int, *,
                       for_update: bool = False) -> Any:
    _id64(flow_id, MSG_FLOW_NOT_FOUND)
    row = await conn.fetchrow(
        "SELECT id, customer_id, name, revision, draft_graph, published_version_id "
        "FROM call_flows WHERE id = $1::bigint AND customer_id = $2::int"
        + (" FOR UPDATE" if for_update else ""), flow_id, scope.customer_id)
    if row is None:
        raise HTTPException(status_code=404, detail=MSG_FLOW_NOT_FOUND)
    return row


async def _next_version(conn: Any, flow_id: int) -> int:
    return int(await conn.fetchval(
        "SELECT COALESCE(max(version), 0) + 1 FROM call_flow_versions WHERE flow_id = $1::bigint",
        flow_id))


async def _compile(conn: Any, scope: IvrScope, flow_id: int, graph: Any,
                   version: int, new_prompts: Optional[list] = None) -> compiler.CompileResult:
    ctx = await store.load_context(conn, customer_id=scope.customer_id, flow_id=flow_id,
                                   version=version)
    if new_prompts:
        # A Flow assistant proposal: its new messages (negative placeholder
        # ids) stand in as prompts by name. Simulate only — never published.
        return assist_pipeline.compile_proposal(graph, ctx, new_prompts)
    return compiler.compile_flow(graph, ctx)


def _stale(current_revision: int) -> IvrApiError:
    return IvrApiError(409, "stale_revision", current_revision=current_revision)


# ===========================================================================
# Summary
# ===========================================================================
@router.get("/summary")
async def summary(scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        flags = await assist_jobs.customer_flags(conn, scope.customer_id)
        if flags is None:
            if scope.is_admin:
                raise HTTPException(status_code=404, detail=store.MSG_CUSTOMER_NOT_FOUND)
            return {"enabled": False, "numbers": [], "flows": [],
                    "limits": limits.public_limits(), "assist": {"available": False}}
        enabled = flags["ivr_enabled"]
        # Flow assistant (docs/IVR_ASSIST_INTERFACES.md §5). Why it is
        # unavailable (flag, opt-in, TED, IVR off) is never shown.
        assist = {"available": assist_jobs.available(flags)}
        if not enabled and not scope.is_admin:
            return {"enabled": False, "numbers": [], "flows": [],
                    "limits": limits.public_limits(), "assist": assist}
        return {"enabled": enabled, "numbers": await store.list_numbers(conn, scope.customer_id),
                "flows": await store.list_flows(conn, scope.customer_id),
                "limits": limits.public_limits(), "assist": assist}


# ===========================================================================
# Flows
# ===========================================================================
class FlowCreate(BaseModel):
    name: str
    draft_graph: Optional[dict] = None


class FlowUpdate(BaseModel):
    name: Optional[str] = None
    draft_graph: Optional[dict] = None
    revision: int


class ValidateBody(BaseModel):
    draft_graph: Optional[dict] = None


class RevisionBody(BaseModel):
    revision: int


class SimulateBody(BaseModel):
    draft_graph: Optional[dict] = None
    caller: str
    at: datetime
    digits: list[str] = Field(default_factory=list, max_length=50)
    #: Flow assistant (IVR_ASSIST_INTERFACES §5): simulate that job's proposal
    #: instead of draft_graph, its new messages standing in as prompts.
    assist_job_id: Optional[str] = None


@router.get("/flows")
async def list_flows(scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        return await store.list_flows(conn, scope.customer_id)


@router.post("/flows", status_code=201)
async def create_flow(body: FlowCreate, scope: IvrScope = Depends(ivr_writer)):
    name = store.clean_name(body.name, field="Name")
    graph = body.draft_graph if body.draft_graph is not None else compiler.default_graph()
    _check_draft(graph)
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _require_entitled(conn, scope)
            await conn.execute("SELECT pg_advisory_xact_lock($1::int, $2::int)",
                               store.IVR_LOCK_CLASS, scope.customer_id)
            count = await conn.fetchval(
                "SELECT count(*) FROM call_flows WHERE customer_id = $1::int", scope.customer_id)
            if count >= limits.MAX_FLOWS_PER_CUSTOMER:
                raise HTTPException(status_code=409, detail=(
                    f"You can have at most {limits.MAX_FLOWS_PER_CUSTOMER} call flows. "
                    "Delete one first."))
            flow_id = await conn.fetchval(
                "INSERT INTO call_flows (customer_id, name, draft_graph, created_by, updated_by) "
                "VALUES ($1::int, $2::varchar, $3::jsonb, $4::int, $4::int) RETURNING id",
                scope.customer_id, name, store.dumps(graph), scope.user_id)
        return await _flow_out(conn, flow_id)


@router.get("/flows/{flow_id}")
async def get_flow(flow_id: int, scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        await _scoped_flow(conn, scope, flow_id)
        return await _flow_out(conn, flow_id)


@router.put("/flows/{flow_id}")
async def update_flow(flow_id: int, body: FlowUpdate, scope: IvrScope = Depends(ivr_writer)):
    fields = body.model_fields_set
    name = store.clean_name(body.name, field="Name") if "name" in fields else None
    if "draft_graph" in fields:
        if body.draft_graph is None:
            raise IvrApiError(422, "invalid_graph", errors=[compiler.Issue(
                "graph_invalid", "The call flow could not be read.").as_dict()])
        _check_draft(body.draft_graph)
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _require_entitled(conn, scope)
            current = await _scoped_flow(conn, scope, flow_id, for_update=True)
            if current["revision"] != body.revision:
                raise _stale(current["revision"])
            await conn.execute(
                "UPDATE call_flows SET name = COALESCE($1::varchar, name), "
                "draft_graph = COALESCE($2::jsonb, draft_graph), revision = revision + 1, "
                "updated_by = $3::int, updated_at = now() WHERE id = $4::bigint",
                name, store.dumps(body.draft_graph) if "draft_graph" in fields else None,
                scope.user_id, flow_id)
        return await _flow_out(conn, flow_id)


@router.delete("/flows/{flow_id}", status_code=204)
async def delete_flow(flow_id: int, scope: IvrScope = Depends(ivr_writer)):
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _require_entitled(conn, scope)
            await _scoped_flow(conn, scope, flow_id, for_update=True)
            bound = await conn.fetch(
                "SELECT did FROM ivr_numbers WHERE flow_id = $1::bigint ORDER BY did", flow_id)
            if bound:
                raise IvrApiError(409, "flow_in_use", numbers=[r["did"] for r in bound])
            await conn.execute("DELETE FROM call_flows WHERE id = $1::bigint", flow_id)
    return Response(status_code=204)


@router.post("/flows/{flow_id}/validate")
async def validate_flow(flow_id: int, body: Optional[ValidateBody] = None,
                        scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        flow = await _scoped_flow(conn, scope, flow_id)
        graph = body.draft_graph if body is not None and body.draft_graph is not None \
            else store.loads(flow["draft_graph"])
        _graph_bytes_ok(graph)
        result = await _compile(conn, scope, flow_id, graph, await _next_version(conn, flow_id))
    return {"ok": result.ok, "errors": [e.as_dict() for e in result.errors],
            "warnings": [w.as_dict() for w in result.warnings]}


@router.post("/flows/{flow_id}/publish")
async def publish_flow(flow_id: int, body: RevisionBody, scope: IvrScope = Depends(ivr_writer)):
    """Compile the STORED draft at ``revision`` and publish it — ONE transaction:
    lock the flow, check the revision, compile + dial policy, check every
    prompt's audio is stored (and KEY SHARE-lock it against the audio GC),
    insert the immutable version, flip published_version_id. Any failure
    rolls everything back (no version row, the old version stays live)."""
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _require_entitled(conn, scope)
            flow = await _scoped_flow(conn, scope, flow_id, for_update=True)
            if flow["revision"] != body.revision:
                raise _stale(flow["revision"])
            await conn.execute("SELECT pg_advisory_xact_lock($1::int, $2::int)",
                               store.IVR_LOCK_CLASS, scope.customer_id)
            version = await _next_version(conn, flow_id)
            graph = store.loads(flow["draft_graph"])
            result = await _compile(conn, scope, flow_id, graph, version)
            if not result.ok:
                raise _invalid_flow(result.errors, result.warnings)
            plan = result.plan
            shas = list(plan["prompts"])
            present = {r["sha256"].strip() for r in await conn.fetch(
                "SELECT sha256 FROM ivr_prompt_audio WHERE sha256 = ANY($1::char(64)[]) "
                "FOR KEY SHARE", shas)} if shas else set()
            if set(shas) - present:
                raise _invalid_flow([compiler.Issue(
                    "prompt_audio_missing",
                    "A message's audio is missing. Re-create the message and publish again.")])
            row = await conn.fetchrow(
                "INSERT INTO call_flow_versions (flow_id, version, graph, plan, compiler_version, "
                "published_by) VALUES ($1::bigint, $2::int, $3::jsonb, $4::jsonb, $5::varchar, "
                "$6::int) RETURNING id, published_at",
                flow_id, version, store.dumps(graph), store.dumps(plan),
                compiler.COMPILER_VERSION, scope.user_id)
            await conn.execute(
                "UPDATE call_flows SET published_version_id = $1::bigint WHERE id = $2::bigint",
                row["id"], flow_id)
    logger.info("ivr: flow %s published as version %s by user %s (customer %s)", flow_id,
                version, scope.user_id, scope.customer_id)
    return {"version": version, "published_at": row["published_at"],
            "plan_summary": compiler.plan_summary(plan, result.warnings)}


async def _versions(conn: Any, flow_id: int, viewer: Optional[IvrScope]) -> list[dict]:
    rows = await conn.fetch(
        "SELECT v.version, v.published_at, u.email, u.customer_id AS user_customer_id "
        "FROM call_flow_versions v LEFT JOIN users u ON u.id = v.published_by "
        "WHERE v.flow_id = $1::bigint ORDER BY v.version DESC", flow_id)
    out = []
    for r in rows:
        # Tenants see who published only when it was someone of their own
        # account (an admin publishing on their behalf stays anonymous).
        email = r["email"]
        if viewer is not None and not viewer.is_admin \
                and r["user_customer_id"] != viewer.customer_id:
            email = None
        out.append({"version": r["version"], "published_at": r["published_at"],
                    "published_by_email": email})
    return out


async def _version(conn: Any, flow_id: int, version: int) -> dict:
    if not 1 <= version <= 2_147_483_647:
        raise HTTPException(status_code=404, detail=MSG_VERSION_NOT_FOUND)
    row = await conn.fetchrow(
        "SELECT version, graph, published_at FROM call_flow_versions "
        "WHERE flow_id = $1::bigint AND version = $2::int", flow_id, version)
    if row is None:
        raise HTTPException(status_code=404, detail=MSG_VERSION_NOT_FOUND)
    return {"version": row["version"], "graph": store.loads(row["graph"]),
            "published_at": row["published_at"]}


@router.get("/flows/{flow_id}/versions")
async def list_versions(flow_id: int, scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        await _scoped_flow(conn, scope, flow_id)
        return await _versions(conn, flow_id, scope)


@router.get("/flows/{flow_id}/versions/{version}")
async def get_version(flow_id: int, version: int, scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        await _scoped_flow(conn, scope, flow_id)
        return await _version(conn, flow_id, version)


@router.post("/flows/{flow_id}/versions/{version}/restore")
async def restore_version(flow_id: int, version: int, body: RevisionBody,
                          scope: IvrScope = Depends(ivr_writer)):
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _require_entitled(conn, scope)
            flow = await _scoped_flow(conn, scope, flow_id, for_update=True)
            if flow["revision"] != body.revision:
                raise _stale(flow["revision"])
            old = await _version(conn, flow_id, version)
            await conn.execute(
                "UPDATE call_flows SET draft_graph = $1::jsonb, revision = revision + 1, "
                "updated_by = $2::int, updated_at = now() WHERE id = $3::bigint",
                store.dumps(old["graph"]), scope.user_id, flow_id)
        return await _flow_out(conn, flow_id)


@router.post("/flows/{flow_id}/simulate")
async def simulate_flow(flow_id: int, body: SimulateBody, scope: IvrScope = Depends(ivr_scope)):
    caller_raw = body.caller.strip()
    if caller_raw.lower() == "anonymous":
        caller: Optional[str] = None
    else:
        try:
            caller = normalize_e164(caller_raw)
        except ValueError:
            raise HTTPException(status_code=422,
                                detail="Caller must be a phone number or \"anonymous\".")
    for d in body.digits:
        if not isinstance(d, str) or not compiler.DIGIT_RE.match(d):
            raise HTTPException(status_code=422, detail="Keys must be 0-9, * or #.")
    at = body.at if body.at.tzinfo is not None else body.at.replace(tzinfo=timezone.utc)
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        flow = await _scoped_flow(conn, scope, flow_id)
        new_prompts: list = []
        if body.assist_job_id is not None:
            try:
                proposal = await assist_jobs.proposal(conn, scope.customer_id, flow_id,
                                                      body.assist_job_id)
            except assist_jobs.AssistRejected as exc:
                raise IvrApiError(exc.status, exc.detail, headers=exc.headers, **exc.extra)
            graph = proposal.get("draft_graph")
            new_prompts = list(proposal.get("new_prompts") or [])
        else:
            graph = body.draft_graph if body.draft_graph is not None \
                else store.loads(flow["draft_graph"])
        _graph_bytes_ok(graph)
        result = await _compile(conn, scope, flow_id, graph, await _next_version(conn, flow_id),
                                new_prompts)
    if not result.ok:
        raise _invalid_flow(result.errors, result.warnings)
    return simulator.simulate(result.plan, caller=caller, at=at, digits=body.digits,
                              prompt_names=result.prompt_names,
                              block_names=simulator.block_names_from_graph(graph))


# ===========================================================================
# Numbers
# ===========================================================================
class NumberUpdate(BaseModel):
    name: Optional[str] = None
    flow_id: Optional[int] = None


@router.get("/numbers")
async def list_numbers(scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        return await store.list_numbers(conn, scope.customer_id)


@router.put("/numbers/{number_id}")
async def update_number(number_id: int, body: NumberUpdate,
                        scope: IvrScope = Depends(ivr_writer)):
    fields = body.model_fields_set
    _id64(number_id, MSG_NUMBER_NOT_FOUND)
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _require_entitled(conn, scope)
            number = await conn.fetchrow(
                "SELECT id, did FROM ivr_numbers WHERE id = $1::bigint AND customer_id = $2::int "
                "FOR UPDATE", number_id, scope.customer_id)
            if number is None:
                raise HTTPException(status_code=404, detail=MSG_NUMBER_NOT_FOUND)
            if "flow_id" in fields:
                await _bind_flow(conn, scope, number, body.flow_id)
            if "name" in fields:
                await conn.execute(
                    "UPDATE ivr_numbers SET name = $1::varchar, updated_at = now() "
                    "WHERE id = $2::bigint",
                    store.clean_name(body.name, field="Name", required=False), number_id)
        row = await conn.fetchrow(store.NUMBER_SELECT + " WHERE n.id = $1::bigint", number_id)
    return store.number_out(row)


async def _bind_flow(conn: Any, scope: IvrScope, number: Any, flow_id: Optional[int]) -> None:
    if flow_id is not None:
        _id64(flow_id, MSG_FLOW_NOT_FOUND)
        flow = await conn.fetchrow(
            "SELECT f.id, v.plan FROM call_flows f "
            "LEFT JOIN call_flow_versions v ON v.id = f.published_version_id "
            "WHERE f.id = $1::bigint AND f.customer_id = $2::int FOR SHARE OF f",
            flow_id, scope.customer_id)
        if flow is None:
            raise HTTPException(status_code=404, detail=MSG_FLOW_NOT_FOUND)
        if flow["plan"] is not None and number["did"] in store.own_transfer_dids(
                store.loads(flow["plan"])):
            raise HTTPException(status_code=422, detail=(
                "That call flow transfers callers to this number, which would loop. "
                "Change the flow first."))
    await conn.execute("UPDATE ivr_numbers SET flow_id = $1::bigint, updated_at = now() "
                       "WHERE id = $2::bigint", flow_id, number["id"])


# ===========================================================================
# Destinations (the transfer / voicemail picker, D3)
# ===========================================================================
_GROUP_LABELS = {"rcf": "Forwarding numbers", "voicemail": "Voicemail boxes",
                 "ivr": "IVR numbers", "trunk": "SIP trunk numbers"}


@router.get("/destinations")
async def destinations(scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        rows = await conn.fetch(cn.owned_numbers_sql("$1::int"), scope.customer_id)
        flows = {r["did"]: r["flow_name"] for r in await conn.fetch(
            "SELECT n.did, f.name AS flow_name FROM ivr_numbers n "
            "LEFT JOIN call_flows f ON f.id = n.flow_id WHERE n.customer_id = $1::int",
            scope.customer_id)}
    groups: dict[str, list[dict]] = {}
    for r in rows:
        product = r["product"]
        if product not in _GROUP_LABELS:
            continue
        if product == "rcf":
            detail = (f"Forwards to {simulator.pretty_number(r['forwards_to'])}"
                      if r["forwards_to"] else "Not forwarding yet")
        elif product == "voicemail":
            detail = f"Mailbox: {r['name'] or r['number']}"
        elif product == "ivr":
            detail = f"IVR: {flows.get(r['number']) or 'no call flow yet'}"
        else:
            detail = f"SIP trunk: {r['name'] or 'unnamed trunk'}"
        groups.setdefault(product, []).append(
            {"did": r["number"], "name": r["name"], "enabled": bool(r["enabled"]),
             "detail": detail})
    ordered = sorted(groups, key=cn.product_sort_key)
    return {"groups": [{"product": p, "label": _GROUP_LABELS[p], "numbers": groups[p]}
                       for p in ordered]}


# ===========================================================================
# Prompts
# ===========================================================================
class PromptTts(BaseModel):
    name: str
    text: str
    voice: str


class PromptPatch(BaseModel):
    name: str


class TtsPreview(BaseModel):
    text: str
    voice: str


def _clean_tts_text(text: Any) -> str:
    if not isinstance(text, str):
        raise HTTPException(status_code=422, detail="Type the words to say.")
    clean = re.sub(r"[ \t\r\n]+", " ", text).strip()
    if not clean:
        raise HTTPException(status_code=422, detail="Type the words to say.")
    if re.search(r"[\x00-\x1f\x7f]", clean):
        raise HTTPException(status_code=422, detail="The text contains characters that can't "
                                                    "be read aloud.")
    if len(clean) > limits.MAX_TTS_CHARS:
        raise HTTPException(status_code=422, detail=(
            f"Text-to-speech messages can be at most {limits.MAX_TTS_CHARS} characters."))
    return clean


async def _voice_version(voice: Any) -> str:
    if not isinstance(voice, str) or not voice:
        raise HTTPException(status_code=422, detail=MSG_BAD_VOICE)
    try:
        version = await tts.voice_version(voice)
    except tts.TtsUnavailable as exc:
        logger.warning("ivr tts: voices unavailable: %s", tts.describe_unavailable(exc))
        raise HTTPException(status_code=503, detail=MSG_TTS_DOWN, headers={"Retry-After": "10"})
    if version is None:
        raise HTTPException(status_code=422, detail=MSG_BAD_VOICE)
    return version


async def _render(text: str, voice: str) -> ivr_audio.CanonicalAudio:
    try:
        return await tts.synthesize(text, voice)
    except tts.TtsRejected:
        raise HTTPException(status_code=422, detail=MSG_TTS_REJECTED)
    except tts.TtsUnavailable as exc:
        logger.warning("ivr tts: synthesize failed: %s", tts.describe_unavailable(exc))
        raise HTTPException(status_code=503, detail=MSG_TTS_DOWN, headers={"Retry-After": "10"})


async def _store_prompt(pool: Any, scope: IvrScope, *, name: str, kind: str,
                        canon: Optional[ivr_audio.CanonicalAudio], sha: Optional[str],
                        tts_text: Optional[str] = None, tts_voice: Optional[str] = None,
                        rerender=None) -> dict:
    """Insert a prompt (and its audio if new) under the customer's lock with
    the §4 limits. ``canon`` = fresh audio; ``sha`` = a render-cache hit that
    must still be stored (else ``rerender()`` produces the audio)."""
    for attempt in (1, 2):
        async with pool.acquire() as conn:
            try:
                async with conn.transaction():
                    await _require_entitled(conn, scope)
                    await conn.execute("SELECT pg_advisory_xact_lock($1::int, $2::int)",
                                       store.IVR_LOCK_CLASS, scope.customer_id)
                    if canon is None:
                        size = await conn.fetchval(
                            "SELECT bytes FROM ivr_prompt_audio WHERE sha256 = $1::char(64) "
                            "FOR KEY SHARE", sha)
                        if size is None:
                            raise _Rerender()
                        audio_sha, audio_bytes = sha, int(size)
                    else:
                        audio_sha, audio_bytes = canon.sha256, canon.bytes
                    live = await conn.fetchval(
                        "SELECT count(*) FROM ivr_prompts WHERE customer_id = $1::int "
                        "AND deleted_at IS NULL", scope.customer_id)
                    if live >= limits.MAX_PROMPTS_PER_CUSTOMER:
                        raise HTTPException(status_code=409, detail=(
                            f"You can have at most {limits.MAX_PROMPTS_PER_CUSTOMER} messages. "
                            "Delete one first."))
                    used = await conn.fetchrow(
                        "SELECT COALESCE(sum(a.bytes), 0)::bigint AS total, "
                        "       bool_or(a.sha256 = $2::char(64)) AS has_it "
                        "  FROM ivr_prompt_audio a WHERE a.sha256 IN ("
                        "       SELECT DISTINCT sha256 FROM ivr_prompts "
                        "        WHERE customer_id = $1::int AND deleted_at IS NULL)",
                        scope.customer_id, audio_sha)
                    extra = 0 if used["has_it"] else audio_bytes
                    if int(used["total"]) + extra > limits.MAX_AUDIO_BYTES_PER_CUSTOMER:
                        raise HTTPException(status_code=409, detail=(
                            "Your messages have reached the 50 MB audio limit. Delete some "
                            "messages first."))
                    if canon is not None:
                        await conn.execute(
                            "INSERT INTO ivr_prompt_audio (sha256, wav, bytes) "
                            "VALUES ($1::char(64), $2::bytea, $3::int) ON CONFLICT (sha256) DO NOTHING",
                            canon.sha256, canon.wav, canon.bytes)
                    prompt_id = await conn.fetchval(
                        "INSERT INTO ivr_prompts (customer_id, name, kind, tts_text, tts_voice, "
                        "sha256, duration_ms, bytes, created_by) VALUES ($1::int, $2::varchar, "
                        "$3::varchar, $4::text, $5::varchar, $6::char(64), $7::int, $8::int, "
                        "$9::int) RETURNING id",
                        scope.customer_id, name, kind, tts_text, tts_voice, audio_sha,
                        ivr_audio.duration_ms_of(audio_bytes), audio_bytes, scope.user_id)
                row = await conn.fetchrow(store.PROMPT_SELECT + " WHERE p.id = $1::bigint",
                                          prompt_id)
                return store.prompt_out(row)
            except _Rerender:
                if rerender is None:
                    raise HTTPException(status_code=503, detail=MSG_RETRY)
                canon = await rerender()
            except asyncpg.ForeignKeyViolationError:
                # The shared audio row was garbage-collected between our
                # INSERT ... DO NOTHING and the prompt INSERT: store it again.
                if attempt == 2 or (canon is None and rerender is None):
                    raise HTTPException(status_code=503, detail=MSG_RETRY)
                if canon is None:
                    canon = await rerender()
    raise HTTPException(status_code=503, detail=MSG_RETRY)


class _Rerender(Exception):
    pass


@router.get("/prompts")
async def list_prompts(scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        rows = await conn.fetch(store.PROMPT_SELECT + " WHERE p.customer_id = $1::int "
                                "AND p.deleted_at IS NULL ORDER BY p.name, p.id",
                                scope.customer_id)
    return [store.prompt_out(r) for r in rows]


@router.post("/prompts/tts", status_code=201)
async def create_tts_prompt(body: PromptTts, scope: IvrScope = Depends(ivr_writer)):
    name = store.clean_name(body.name, field="Name")
    text = _clean_tts_text(body.text)
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
    version = await _voice_version(body.voice)
    key = tts.cache_key(version, body.voice, text)
    sha = await tts.cached_sha(key)
    canon = None if sha else await _render(text, body.voice)

    async def rerender() -> ivr_audio.CanonicalAudio:
        tts.forget(key)
        return await _render(text, body.voice)

    out = await _store_prompt(pool, scope, name=name, kind="tts", canon=canon, sha=sha,
                              tts_text=text, tts_voice=body.voice, rerender=rerender)
    stored = await _prompt_sha(pool, out["id"])
    await tts.remember(key, stored)
    return out


async def _prompt_sha(pool: Any, prompt_id: int) -> str:
    async with pool.acquire() as conn:
        return (await conn.fetchval("SELECT sha256 FROM ivr_prompts WHERE id = $1::bigint",
                                    prompt_id)).strip()


@router.post("/prompts/upload", status_code=201)
async def upload_prompt(request: Request, scope: IvrScope = Depends(ivr_writer)):
    length = request.headers.get("content-length")
    if length is None or not length.isdigit():
        raise HTTPException(status_code=411, detail="Upload size is required.")
    if int(length) > limits.MAX_UPLOAD_BYTES + 65536:
        raise HTTPException(status_code=413, detail="That file is too large.")
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
    try:
        form = await request.form(max_files=1, max_fields=4)
    except Exception:  # noqa: BLE001 — malformed multipart
        raise HTTPException(status_code=422, detail="Upload a WAV file and a name.")
    upload = form.get("file")
    if upload is None or isinstance(upload, str):
        raise HTTPException(status_code=422, detail="Upload a WAV file and a name.")
    name = store.clean_name(form.get("name"), field="Name")
    kind = form.get("kind") or "upload"
    if kind not in ("upload", "recording"):
        raise HTTPException(status_code=422, detail="Kind must be upload or recording.")
    data = await upload.read(limits.MAX_UPLOAD_BYTES + 1)
    await upload.close()
    if len(data) > limits.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="That file is too large.")
    try:
        canon = ivr_audio.canonicalize(data)
    except ivr_audio.AudioError as exc:
        raise HTTPException(status_code=422, detail=exc.detail)
    return await _store_prompt(pool, scope, name=name, kind=kind, canon=canon, sha=None)


@router.patch("/prompts/{prompt_id}")
async def rename_prompt(prompt_id: int, body: PromptPatch, scope: IvrScope = Depends(ivr_writer)):
    name = store.clean_name(body.name, field="Name")
    _id64(prompt_id, MSG_PROMPT_NOT_FOUND)
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        updated = await conn.fetchval(
            "UPDATE ivr_prompts SET name = $1::varchar, updated_at = now() "
            "WHERE id = $2::bigint AND customer_id = $3::int AND deleted_at IS NULL RETURNING id",
            name, prompt_id, scope.customer_id)
        if updated is None:
            raise HTTPException(status_code=404, detail=MSG_PROMPT_NOT_FOUND)
        row = await conn.fetchrow(store.PROMPT_SELECT + " WHERE p.id = $1::bigint", prompt_id)
    return store.prompt_out(row)


@router.delete("/prompts/{prompt_id}", status_code=204)
async def delete_prompt(prompt_id: int, scope: IvrScope = Depends(ivr_writer)):
    """409 ``prompt_in_use`` while any DRAFT uses it; soft delete (audio kept)
    while a published version plays it; else delete the row and garbage-
    collect the audio once no prompt and no version references it."""
    _id64(prompt_id, MSG_PROMPT_NOT_FOUND)
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _require_entitled(conn, scope)
            await conn.execute("SELECT pg_advisory_xact_lock($1::int, $2::int)",
                               store.IVR_LOCK_CLASS, scope.customer_id)
            prompt = await conn.fetchrow(
                "SELECT id, sha256 FROM ivr_prompts WHERE id = $1::bigint AND customer_id = $2::int "
                "AND deleted_at IS NULL FOR UPDATE", prompt_id, scope.customer_id)
            if prompt is None:
                raise HTTPException(status_code=404, detail=MSG_PROMPT_NOT_FOUND)
            flows = await conn.fetch(
                "SELECT id, name, draft_graph FROM call_flows WHERE customer_id = $1::int "
                "ORDER BY name, id", scope.customer_id)
            users = [{"id": f["id"], "name": f["name"]} for f in flows
                     if prompt_id in store.prompt_ids_in_graph(store.loads(f["draft_graph"]))]
            if users:
                raise IvrApiError(409, "prompt_in_use", flows=users)
            sha = prompt["sha256"].strip()
            in_versions = await conn.fetchval(
                "SELECT EXISTS (SELECT 1 FROM call_flow_versions v JOIN call_flows f "
                "ON f.id = v.flow_id WHERE f.customer_id = $1::int "
                "AND v.plan -> 'prompts' ? $2::text)", scope.customer_id, sha)
            if in_versions:
                await conn.execute("UPDATE ivr_prompts SET deleted_at = now(), updated_at = now() "
                                   "WHERE id = $1::bigint", prompt_id)
            else:
                await conn.execute("DELETE FROM ivr_prompts WHERE id = $1::bigint", prompt_id)
                await _gc_audio(conn, sha)
    return Response(status_code=204)


async def _gc_audio(conn: Any, sha: str) -> None:
    """Delete shared audio nothing references any more. Locks the audio row
    FIRST, so a concurrent publish (KEY SHARE) or prompt insert (FK) is
    either seen by the checks below or blocked until this commits."""
    locked = await conn.fetchval(
        "SELECT 1 FROM ivr_prompt_audio WHERE sha256 = $1::char(64) FOR UPDATE", sha)
    if not locked:
        return
    referenced = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM ivr_prompts WHERE sha256 = $1::char(64)) "
        "OR EXISTS (SELECT 1 FROM call_flow_versions WHERE plan -> 'prompts' ? $2::text)",
        sha, sha)
    if not referenced:
        await conn.execute("DELETE FROM ivr_prompt_audio WHERE sha256 = $1::char(64)", sha)


@router.post("/prompts/tts-preview")
async def tts_preview(body: TtsPreview, scope: IvrScope = Depends(ivr_writer)):
    text = _clean_tts_text(body.text)
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
    allowed, retry_after = await tts.preview_limiter.allow(
        f"u{scope.user_id}" if scope.user_id is not None else f"c{scope.customer_id}")
    if not allowed:
        raise HTTPException(status_code=429, detail="Too many previews. Wait a minute and try "
                            "again.", headers={"Retry-After": str(retry_after)})
    version = await _voice_version(body.voice)
    key = tts.cache_key(version, body.voice, text)
    wav = None
    sha = await tts.cached_sha(key)
    if sha:
        async with pool.acquire() as conn:
            wav = await conn.fetchval(
                "SELECT wav FROM ivr_prompt_audio WHERE sha256 = $1::char(64)", sha)
    if wav is None:
        wav = (await _render(text, body.voice)).wav
    return Response(content=bytes(wav), media_type="audio/wav",
                    headers={"Cache-Control": "no-store"})


@router.post("/prompts/{prompt_id}/playback-token")
async def prompt_playback_token(prompt_id: int, scope: IvrScope = Depends(ivr_scope)):
    _id64(prompt_id, MSG_PROMPT_NOT_FOUND)
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        ok = await conn.fetchval(
            "SELECT 1 FROM ivr_prompts WHERE id = $1::bigint AND customer_id = $2::int "
            "AND deleted_at IS NULL", prompt_id, scope.customer_id)
    if not ok:
        raise HTTPException(status_code=404, detail=MSG_PROMPT_NOT_FOUND)
    try:
        token = mint_playback_token(PLAYBACK_KIND, prompt_id, scope.customer_id,
                                    scope.user_id if scope.user_id is not None else "unknown")
    except PlaybackNotConfigured:
        logger.error("ivr playback: VOICEMAIL_PLAYBACK_SECRET is not usable — 503")
        raise HTTPException(status_code=503, detail=MSG_AUDIO_UNAVAILABLE)
    return {"url": f"{URL_PREFIX}/prompts/{prompt_id}/audio?t={token}",
            "expires_in": PLAYBACK_TTL_SECONDS}


@router.api_route("/prompts/{prompt_id}/audio", methods=["GET", "HEAD"])
async def prompt_audio(prompt_id: int, request: Request, t: Optional[str] = Query(None)):
    try:
        claims = verify_playback_token(t or "", PLAYBACK_KIND, prompt_id)
    except PlaybackTokenError:
        raise HTTPException(status_code=401, detail="Playback link expired or invalid.")
    except PlaybackNotConfigured:
        raise HTTPException(status_code=503, detail=MSG_AUDIO_UNAVAILABLE)
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT a.wav, a.bytes FROM ivr_prompts p "
            "JOIN customers c ON c.id = p.customer_id "
            "JOIN ivr_prompt_audio a ON a.sha256 = p.sha256 "
            "WHERE p.id = $1::bigint AND p.customer_id = $2::int AND p.deleted_at IS NULL "
            "AND c.ivr_enabled", prompt_id, claims["cid"])
    if row is None:
        raise HTTPException(status_code=404, detail=MSG_PROMPT_NOT_FOUND)
    headers = {"Cache-Control": "no-store", "Content-Disposition": "inline"}
    if request.method == "HEAD":
        return Response(status_code=200, media_type="audio/wav",
                        headers={**headers, "Content-Length": str(row["bytes"])})
    return Response(content=bytes(row["wav"]), media_type="audio/wav", headers=headers)


@router.get("/voices")
async def voices(scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
    try:
        return [tts.public_voice(v) for v in await tts.list_voices()]
    except tts.TtsUnavailable as exc:
        logger.warning("ivr tts: voices unavailable: %s", tts.describe_unavailable(exc))
        raise HTTPException(status_code=503, detail=MSG_TTS_DOWN, headers={"Retry-After": "10"})


# ===========================================================================
# Admin (TED, §8.3) — require_admin
# ===========================================================================
class EntitlementBody(BaseModel):
    """At least one of ``enabled`` (IVR, §8.3) and ``assist_enabled`` (the
    Flow assistant opt-in, IVR_ASSIST_INTERFACES §8). A body with only
    ``enabled`` is exactly the pre-assistant request."""
    enabled: Optional[bool] = None
    assist_enabled: Optional[bool] = None


class AdminNumberUpdate(BaseModel):
    enabled: Optional[bool] = None
    max_channels: Optional[int] = Field(default=None, ge=1, le=500)
    name: Optional[str] = None


@router.get("/admin/overview")
async def admin_overview(admin: dict = Depends(require_admin)):
    """Admin "All customers": every customer with IVR on or at least one flow
    -> ``{customers: [{customer_id, name, status, ivr_enabled, flows_total,
    flows_published, numbers_bound, last_published_at}]}`` (store.py defines
    each count). Read-only, one query."""
    pool = await _pool()
    async with pool.acquire() as conn:
        return {"customers": await store.admin_overview(conn)}


@router.get("/admin/customers/{customer_id}")
async def admin_customer(customer_id: int, admin: dict = Depends(require_admin)):
    pool = await _pool()
    async with pool.acquire() as conn:
        flags = await assist_jobs.customer_flags(conn, _admin_customer_id(customer_id))
        if flags is None:
            raise HTTPException(status_code=404, detail=store.MSG_CUSTOMER_NOT_FOUND)
        out = {"ivr_enabled": flags["ivr_enabled"],
               "numbers": await store.list_numbers(conn, customer_id),
               "flows": await store.list_flows(conn, customer_id)}
        # Before migration 61 the key is absent, so TED hides its switch (§8).
        if flags["ivr_assist_enabled"] is not None:
            out["ivr_assist_enabled"] = flags["ivr_assist_enabled"]
        return out


def _admin_customer_id(customer_id: int) -> int:
    if not 1 <= customer_id <= 2_147_483_647:
        raise HTTPException(status_code=404, detail=store.MSG_CUSTOMER_NOT_FOUND)
    return customer_id


@router.put("/admin/customers/{customer_id}/entitlement")
async def admin_entitlement(customer_id: int, body: EntitlementBody,
                            admin: dict = Depends(require_admin)):
    """``{enabled?, assist_enabled?}`` -> ``{ivr_enabled, ivr_assist_enabled}``.
    Turning IVR off leaves the assistant opt-in as it is (the assistant also
    needs IVR, so it is unavailable either way)."""
    fields = body.model_fields_set
    if "enabled" in fields and body.enabled is None:
        raise HTTPException(status_code=422, detail="enabled must be true or false.")
    if "assist_enabled" in fields and body.assist_enabled is None:
        raise HTTPException(status_code=422, detail="assist_enabled must be true or false.")
    if body.enabled is None and body.assist_enabled is None:
        raise HTTPException(status_code=422, detail="Send enabled and/or assist_enabled.")
    cid = _admin_customer_id(customer_id)
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            if body.assist_enabled is not None:
                try:
                    updated = await assist_jobs.set_assist_enabled(conn, cid,
                                                                   body.assist_enabled)
                except assist_jobs.AssistRejected as exc:
                    raise HTTPException(status_code=exc.status, detail=exc.detail)
                if updated is None:
                    raise HTTPException(status_code=404, detail=store.MSG_CUSTOMER_NOT_FOUND)
            if body.enabled is not None and await conn.fetchval(
                    "UPDATE customers SET ivr_enabled = $1::boolean WHERE id = $2::int "
                    "RETURNING ivr_enabled", body.enabled, cid) is None:
                raise HTTPException(status_code=404, detail=store.MSG_CUSTOMER_NOT_FOUND)
            flags = await assist_jobs.customer_flags(conn, cid)
    if flags is None:
        raise HTTPException(status_code=404, detail=store.MSG_CUSTOMER_NOT_FOUND)
    logger.info("ivr: customer %s entitlement set to ivr=%s assist=%s by admin %s", customer_id,
                flags["ivr_enabled"], flags["ivr_assist_enabled"], admin.get("sub"))
    out = {"ivr_enabled": flags["ivr_enabled"]}
    if flags["ivr_assist_enabled"] is not None:
        out["ivr_assist_enabled"] = flags["ivr_assist_enabled"]
    return out


@router.put("/admin/numbers/{number_id}")
async def admin_update_number(number_id: int, body: AdminNumberUpdate,
                              admin: dict = Depends(require_admin)):
    fields = body.model_fields_set
    _id64(number_id, MSG_NUMBER_NOT_FOUND)
    if "enabled" in fields and body.enabled is None:
        raise HTTPException(status_code=422, detail="enabled must be true or false.")
    if "max_channels" in fields and body.max_channels is None:
        raise HTTPException(status_code=422, detail="max_channels must be 1-500.")
    name = store.clean_name(body.name, field="Name", required=False) if "name" in fields \
        else None
    pool = await _pool()
    async with pool.acquire() as conn:
        updated = await conn.fetchval(
            "UPDATE ivr_numbers SET "
            "enabled = CASE WHEN $1::boolean THEN $2::boolean ELSE enabled END, "
            "max_channels = CASE WHEN $3::boolean THEN $4::int ELSE max_channels END, "
            "name = CASE WHEN $5::boolean THEN $6::varchar ELSE name END, "
            "updated_at = now() WHERE id = $7::bigint RETURNING id",
            "enabled" in fields, body.enabled, "max_channels" in fields, body.max_channels,
            "name" in fields, name, number_id)
        if updated is None:
            raise HTTPException(status_code=404, detail=MSG_NUMBER_NOT_FOUND)
        row = await conn.fetchrow(store.NUMBER_SELECT + " WHERE n.id = $1::bigint", number_id)
    logger.info("ivr: number %s updated by admin %s (%s)", number_id, admin.get("sub"),
                ",".join(sorted(fields)))
    return store.number_out(row)


async def _admin_flow(conn: Any, flow_id: int) -> None:
    _id64(flow_id, MSG_FLOW_NOT_FOUND)
    if not await conn.fetchval("SELECT 1 FROM call_flows WHERE id = $1::bigint", flow_id):
        raise HTTPException(status_code=404, detail=MSG_FLOW_NOT_FOUND)


@router.get("/admin/flows/{flow_id}/versions")
async def admin_list_versions(flow_id: int, admin: dict = Depends(require_admin)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _admin_flow(conn, flow_id)
        return await _versions(conn, flow_id, None)


@router.get("/admin/flows/{flow_id}/versions/{version}")
async def admin_get_version(flow_id: int, version: int, admin: dict = Depends(require_admin)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _admin_flow(conn, flow_id)
        return await _version(conn, flow_id, version)
