"""The Flow assistant job inside the API (contract docs/IVR_ASSIST_INTERFACES.md §5 / §5.1).

One job = one customer message. The API worker that accepts the message runs
the job as an asyncio task (held in ``_TASKS`` — a strong reference, so the
event loop cannot garbage-collect it mid-flight) and keeps ALL state in
``ivr_assist_jobs`` (migration 61), so any API worker answers the poll.

  submit()        POST …/assist: availability (403), per-user rate limit
                  (429), then ONE transaction under a per-customer advisory
                  lock: stale-job sweep, one running job per flow (409), the
                  per-customer daily cap (429), refine / conversation
                  resolution, the 90-day retention batch, INSERT. Then the task.
  _run()          load the customer's context (no connection is held while
                  TED works), pipeline.run(), store the result. A job still
                  'running' after STALE_AFTER_S reads as failed, and a late
                  worker can no longer overwrite it.
  read_job()      GET …/assist/{job_id}
  record_outcome  POST …/assist/{job_id}/outcome (recorded once)
  proposal()      the stored proposal, for simulate with ``assist_job_id``

Deploy-order guard: before migration 61 exists ``schema_present`` is false —
the assistant is unavailable, the summary says so, and the admin endpoints
omit ``ivr_assist_enabled`` (TED then hides its switch). Nothing errors.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from db import database as db
from services.ivr import store, tts
from services.ivr.assist import config, pipeline, ted_client
from services.ivr.assist import graph as ag
from services.ivr.assist.aliases import AliasBook, PromptInfo
from services.ivr.compiler import CompileContext

logger = logging.getLogger(__name__)

#: pg_advisory_xact_lock(ASSIST_LOCK_CLASS, customer_id): serializes a
#: customer's job creation (daily cap, one running job per flow).
ASSIST_LOCK_CLASS = 6101

#: Customer text per job error code (contract §5.3). TED's own message is
#: never shown to a customer.
ERROR_TEXT = {
    ted_client.UNAVAILABLE: "The flow assistant is unavailable right now. "
                            "You can keep building by hand.",
    ted_client.BUSY: "The flow assistant is busy. Try again in a minute.",
    ted_client.FAILED: "The flow assistant couldn't finish that request. "
                       "Try rewording it, or build it by hand.",
}

MSG_JOB_NOT_FOUND = "Flow assistant request not found."
MSG_TOO_LARGE = (f"The flow assistant can work on call flows with up to {config.MAX_NODES} "
                 f"blocks and {config.MAX_EDGES} connections.")

rate_limiter = tts.PreviewLimiter(per_minute=config.RATE_PER_MINUTE, prefix="ivr:assist")

_TASKS: set[asyncio.Task] = set()


class AssistRejected(Exception):
    """An HTTP refusal with optional extra body keys (the router turns it
    into routers.ivr.IvrApiError)."""

    def __init__(self, status: int, detail: str, headers: Optional[dict] = None, **extra):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.headers = headers
        self.extra = extra


# ---------------------------------------------------------------------------
# Schema guard + availability
# ---------------------------------------------------------------------------
_schema = {"present": False, "checked_at": -1e9}


def reset_schema_cache() -> None:
    _schema.update(present=False, checked_at=-1e9)


async def schema_present(conn: Any) -> bool:
    """Is migration 61 applied? Cached for good once true; re-checked every
    60 s while false (so applying 61 needs no API restart)."""
    if _schema["present"]:
        return True
    now = time.monotonic()
    if now - _schema["checked_at"] < 60:
        return False
    _schema["checked_at"] = now
    present = bool(await conn.fetchval(
        "SELECT to_regclass('public.ivr_assist_jobs') IS NOT NULL AND EXISTS ("
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' "
        "AND table_name = 'customers' AND column_name = 'ivr_assist_enabled')"))
    if present:
        _schema["present"] = True
    else:
        logger.warning("ivr assist: migration 61 is not applied — the flow assistant is "
                       "unavailable (sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f "
                       "/opt/revup/docker/postgres/init/61_ivr_assist.sql)")
    return present


async def customer_flags(conn: Any, customer_id: int) -> Optional[dict]:
    """``{ivr_enabled, ivr_assist_enabled}`` (the latter None before 61), or
    None when the customer does not exist."""
    if await schema_present(conn):
        row = await conn.fetchrow("SELECT ivr_enabled, ivr_assist_enabled FROM customers "
                                  "WHERE id = $1::int", customer_id)
        if row is None:
            return None
        return {"ivr_enabled": bool(row["ivr_enabled"]),
                "ivr_assist_enabled": bool(row["ivr_assist_enabled"])}
    row = await conn.fetchrow("SELECT ivr_enabled FROM customers WHERE id = $1::int",
                              customer_id)
    if row is None:
        return None
    return {"ivr_enabled": bool(row["ivr_enabled"]), "ivr_assist_enabled": None}


def available(flags: Optional[dict]) -> bool:
    """``summary.assist.available`` (§5): the platform flag AND TED configured
    AND the customer opted in AND entitled to IVR. The reason is never shown."""
    return bool(flags) and bool(flags["ivr_enabled"]) and bool(flags["ivr_assist_enabled"]) \
        and config.platform_available()


async def set_assist_enabled(conn: Any, customer_id: int, value: bool) -> Optional[bool]:
    if not await schema_present(conn):
        raise AssistRejected(503, "The flow assistant needs database migration 61 first.")
    return await conn.fetchval(
        "UPDATE customers SET ivr_assist_enabled = $1::boolean WHERE id = $2::int "
        "RETURNING ivr_assist_enabled", value, customer_id)


# ---------------------------------------------------------------------------
# Submit (POST /ivr/flows/{id}/assist)
# ---------------------------------------------------------------------------
@dataclass
class JobSpec:
    id: str
    customer_id: int
    flow_id: int
    user_id: Optional[int]
    conversation_id: str
    message: str
    base_graph: Optional[dict]
    base_new_prompts: list[dict] = field(default_factory=list)
    started: float = field(default_factory=time.monotonic)


def _parse_uuid(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value.strip()))
    except ValueError:
        return None


def _stale_sql(where: str) -> str:
    return ("UPDATE ivr_assist_jobs SET status = 'failed', error_code = 'assistant_failed', "
            f"finished_at = now() WHERE {where} AND status = 'running' "
            f"AND created_at < now() - interval '{config.STALE_AFTER_S} seconds'")


async def submit(pool: Any, *, customer_id: int, user_id: Optional[int], flow_id: int,
                 message: str, conversation_id: Optional[str], refine_job_id: Optional[str],
                 draft_graph: Optional[dict]) -> dict:
    """Validate, record and start one job; ``{job_id, conversation_id}``."""
    async with pool.acquire() as conn:
        if not available(await customer_flags(conn, customer_id)):
            raise AssistRejected(403, "ivr_assist_not_enabled")
    allowed, retry_after = await rate_limiter.allow(
        f"u{user_id}" if user_id is not None else f"c{customer_id}")
    if not allowed:
        raise AssistRejected(429, "assist_rate_limited", headers={"Retry-After": str(retry_after)},
                             retry_after_s=retry_after)
    refine_id = None
    if refine_job_id is not None:
        refine_id = _parse_uuid(refine_job_id)
        if refine_id is None:
            raise AssistRejected(404, MSG_JOB_NOT_FOUND)
    wanted_conversation = _parse_uuid(conversation_id) if conversation_id is not None else None
    job_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1::int, $2::int)",
                               ASSIST_LOCK_CLASS, customer_id)
            flow = await conn.fetchrow(
                "SELECT draft_graph FROM call_flows WHERE id = $1::bigint AND customer_id = $2::int",
                flow_id, customer_id)
            if flow is None:
                raise AssistRejected(404, "Call flow not found.")
            await conn.execute(_stale_sql("flow_id = $1::bigint"), flow_id)
            if await conn.fetchval("SELECT 1 FROM ivr_assist_jobs WHERE flow_id = $1::bigint "
                                   "AND status = 'running'", flow_id):
                raise AssistRejected(409, "assist_busy")
            today = await conn.fetchval(
                "SELECT count(*) FROM ivr_assist_jobs WHERE customer_id = $1::int AND "
                "created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
                customer_id)
            if today >= config.daily_cap():
                raise AssistRejected(429, "assist_daily_limit")
            base_graph: Optional[dict]
            base_nps: list[dict] = []
            convo: Optional[str] = None
            if refine_id is not None:
                ref = await conn.fetchrow(
                    "SELECT conversation_id, status, outcome, result FROM ivr_assist_jobs "
                    "WHERE id = $1::uuid AND flow_id = $2::bigint AND customer_id = $3::int",
                    refine_id, flow_id, customer_id)
                if ref is None:
                    raise AssistRejected(404, MSG_JOB_NOT_FOUND)
                public = (_loads(ref["result"]) or {}).get("public") or {}
                if ref["status"] != "done" or public.get("kind") != "proposal" \
                        or ref["outcome"] is not None:
                    raise AssistRejected(409, "assist_not_refinable")
                base_graph = public.get("draft_graph")
                base_nps = list(public.get("new_prompts") or [])
                wanted_conversation = str(ref["conversation_id"])
            else:
                base_graph = draft_graph if draft_graph is not None \
                    else store.loads(flow["draft_graph"])
            try:
                ag.to_alias_graph(base_graph, AliasBook([]),
                                  placeholders={np["placeholder_id"]: "NP1" for np in base_nps})
            except ag.GraphTooLarge:
                raise AssistRejected(422, MSG_TOO_LARGE)
            if wanted_conversation is not None:
                first = await conn.fetchval(
                    "SELECT min(created_at) FROM ivr_assist_jobs WHERE conversation_id = $1::uuid "
                    "AND flow_id = $2::bigint AND customer_id = $3::int",
                    wanted_conversation, flow_id, customer_id)
                if first is not None and (datetime.now(timezone.utc) - first).total_seconds() \
                        < config.CONVERSATION_TTL_S:
                    convo = wanted_conversation
            convo = convo or str(uuid.uuid4())
            await conn.execute(
                "WITH old AS MATERIALIZED (SELECT id FROM ivr_assist_jobs "
                f"WHERE created_at < now() - interval '{config.RETENTION_DAYS} days' "
                f"ORDER BY created_at LIMIT {config.RETENTION_BATCH} FOR UPDATE SKIP LOCKED) "
                "DELETE FROM ivr_assist_jobs j USING old WHERE j.id = old.id")
            await conn.execute(
                "INSERT INTO ivr_assist_jobs (id, customer_id, flow_id, user_id, "
                "conversation_id, status, message) VALUES ($1::uuid, $2::int, $3::bigint, "
                "(SELECT id FROM users WHERE id = $4::int), $5::uuid, 'running', $6::text)",
                job_id, customer_id, flow_id, user_id, convo, message)
    spec = JobSpec(job_id, customer_id, flow_id, user_id, convo, message, base_graph, base_nps)
    start(spec)
    logger.info("ivr assist: job %s started for flow %s (customer %s, user %s)", job_id,
                flow_id, customer_id, user_id)
    return {"job_id": job_id, "conversation_id": convo}


def _loads(value: Any) -> Any:
    if value is None:
        return None
    return json.loads(value) if isinstance(value, (str, bytes, bytearray)) else value


# ---------------------------------------------------------------------------
# The task
# ---------------------------------------------------------------------------
def start(spec: JobSpec) -> asyncio.Task:
    task = asyncio.create_task(_run(spec), name=f"ivr-assist-{spec.id}")
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return task


async def wait_idle() -> None:
    """Wait for every running job task (tests)."""
    while _TASKS:
        await asyncio.gather(*list(_TASKS), return_exceptions=True)


async def shutdown() -> None:
    """Lifespan shutdown: cancel in-flight jobs (each marks itself failed)."""
    tasks = list(_TASKS)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _pool() -> Any:
    return db.pool or await db.get_pool()


async def _run(spec: JobSpec) -> None:
    try:
        pool = await _pool()
        inp = await _load_input(pool, spec)
        outcome = await pipeline.run(inp, ted_client.call,
                                     deadline=spec.started + config.JOB_DEADLINE_S)
        await _store(pool, spec, outcome)
    except asyncio.CancelledError:
        await _fail_quietly(spec)
        raise
    except Exception as exc:  # noqa: BLE001 — a job never takes the worker down
        logger.error("ivr assist: job %s crashed (%s)", spec.id, type(exc).__name__)
        await _fail_quietly(spec)


async def _fail_quietly(spec: JobSpec) -> None:
    try:
        pool = await _pool()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE ivr_assist_jobs SET status = 'failed', error_code = 'assistant_failed', "
                "finished_at = now() WHERE id = $1::uuid AND status = 'running'", spec.id)
    except Exception as exc:  # noqa: BLE001
        logger.error("ivr assist: could not mark job %s failed (%s)", spec.id,
                     type(exc).__name__)


async def _load_input(pool: Any, spec: JobSpec) -> pipeline.AssistInput:
    async with pool.acquire() as conn:
        ctx: CompileContext = await store.load_context(
            conn, customer_id=spec.customer_id, flow_id=spec.flow_id, version=1)
        prompt_rows = await conn.fetch(
            "SELECT id, name, kind, tts_text FROM ivr_prompts WHERE customer_id = $1::int "
            "AND deleted_at IS NULL ORDER BY id", spec.customer_id)
        earlier = await conn.fetch(
            "SELECT message, status, result FROM ivr_assist_jobs WHERE conversation_id = $1::uuid "
            "AND flow_id = $2::bigint AND customer_id = $3::int AND id <> $4::uuid "
            "ORDER BY created_at, id", spec.conversation_id, spec.flow_id, spec.customer_id,
            spec.id)
    history: list[tuple[str, str]] = []
    external: list[str] = []
    for row in earlier:
        result = _loads(row["result"]) or {}
        state = result.get("state") or {}
        if isinstance(state.get("external_numbers"), list):
            external = [n for n in state["external_numbers"] if isinstance(n, str)]
        public = result.get("public") or {}
        if row["status"] != "done" or not public:
            continue
        text = public.get("summary") or public.get("question") or public.get("message")
        history.append(("customer", row["message"]))
        if text:
            history.append(("assistant", text))
    prompts = [PromptInfo(r["id"], r["name"], r["tts_text"] if r["kind"] == "tts" else None)
               for r in prompt_rows]
    return pipeline.AssistInput(
        message=spec.message, conversation_id=spec.conversation_id, compile_ctx=ctx,
        numbers=list(ctx.numbers.values()), prompts=prompts,
        history=history[-config.HISTORY_TURNS:], base_graph=spec.base_graph,
        base_new_prompts=spec.base_new_prompts, external_numbers=external,
        max_new_prompts=max(0, 100 - len(prompt_rows)))


async def _store(pool: Any, spec: JobSpec, outcome: pipeline.AssistOutcome) -> None:
    state: dict[str, Any] = {"external_numbers": outcome.external_numbers}
    if outcome.retry_after_s:
        state["retry_after_s"] = outcome.retry_after_s
    result: dict[str, Any] = {"state": state}
    if outcome.public is not None:
        result["public"] = outcome.public
    error = outcome.error_code if outcome.status == "failed" else None
    async with pool.acquire() as conn:
        stored = await conn.fetchval(
            "UPDATE ivr_assist_jobs SET status = $2::varchar, result = $3::jsonb, "
            "error_code = $4::varchar, rounds = $5::smallint, ted_request_ids = $6::text[], "
            "finished_at = now() WHERE id = $1::uuid AND status = 'running' "
            f"AND created_at > now() - interval '{config.STALE_AFTER_S} seconds' RETURNING id",
            spec.id, outcome.status, store.dumps(result), error, outcome.rounds,
            outcome.request_ids[:3])
        if stored is None:
            await conn.execute(_stale_sql("id = $1::uuid"), spec.id)
            logger.warning("ivr assist: job %s finished after it went stale — kept as failed",
                           spec.id)
            return
    logger.info("ivr assist: job %s %s (%s) after %d TED call(s)", spec.id, outcome.status,
                (outcome.public or {}).get("kind") or error, outcome.rounds)


# ---------------------------------------------------------------------------
# Read / outcome / simulate
# ---------------------------------------------------------------------------
async def _job_row(conn: Any, customer_id: int, flow_id: int, job_id: Any) -> Any:
    jid = _parse_uuid(job_id)
    if jid is None:
        raise AssistRejected(404, MSG_JOB_NOT_FOUND)
    row = await conn.fetchrow(
        "SELECT id, conversation_id, status, result, error_code, outcome, created_at, "
        "finished_at, now() AS now FROM ivr_assist_jobs WHERE id = $1::uuid "
        "AND flow_id = $2::bigint AND customer_id = $3::int", jid, flow_id, customer_id)
    if row is None:
        raise AssistRejected(404, MSG_JOB_NOT_FOUND)
    return row


def _is_stale(row: Any) -> bool:
    return row["status"] == "running" and \
        (row["now"] - row["created_at"]).total_seconds() > config.STALE_AFTER_S


async def read_job(conn: Any, customer_id: int, flow_id: int, job_id: Any) -> dict:
    """GET …/assist/{job_id} (§5)."""
    row = await _job_row(conn, customer_id, flow_id, job_id)
    status, code = row["status"], row["error_code"]
    if _is_stale(row):
        status, code = "failed", ted_client.FAILED
    end = row["finished_at"] if status != "running" and row["finished_at"] else row["now"]
    out: dict[str, Any] = {
        "job_id": str(row["id"]), "conversation_id": str(row["conversation_id"]),
        "status": status,
        "elapsed_ms": max(0, int((end - row["created_at"]).total_seconds() * 1000)),
    }
    result = _loads(row["result"]) or {}
    if status == "done" and result.get("public"):
        out["result"] = result["public"]
    if status == "failed":
        code = code if code in ERROR_TEXT else ted_client.FAILED
        error: dict[str, Any] = {"code": code, "message": ERROR_TEXT[code]}
        retry = (result.get("state") or {}).get("retry_after_s")
        if code == ted_client.BUSY and isinstance(retry, int):
            error["retry_after_s"] = retry
        out["error"] = error
    return out


async def record_outcome(conn: Any, customer_id: int, flow_id: int, job_id: Any,
                         outcome: str) -> None:
    """POST …/outcome: recorded once; the same outcome again is a no-op, a
    different one is 409; only a done proposal has an outcome."""
    row = await _job_row(conn, customer_id, flow_id, job_id)
    public = (_loads(row["result"]) or {}).get("public") or {}
    if row["status"] != "done" or public.get("kind") != "proposal":
        raise AssistRejected(409, "assist_not_a_proposal")
    if row["outcome"] is not None:
        if row["outcome"] == outcome:
            return
        raise AssistRejected(409, "assist_outcome_recorded", outcome=row["outcome"])
    updated = await conn.fetchval(
        "UPDATE ivr_assist_jobs SET outcome = $2::varchar, outcome_at = now() "
        "WHERE id = $1::uuid AND outcome IS NULL AND status = 'done' RETURNING outcome",
        row["id"], outcome)
    if updated is None:  # a concurrent POST won
        current = await conn.fetchval("SELECT outcome FROM ivr_assist_jobs WHERE id = $1::uuid",
                                      row["id"])
        if current != outcome:
            raise AssistRejected(409, "assist_outcome_recorded", outcome=current)
    logger.info("ivr assist: job %s outcome %s", row["id"], outcome)


async def proposal(conn: Any, customer_id: int, flow_id: int, job_id: Any) -> dict:
    """The stored proposal (§5.2 shape) of a done job of this flow."""
    row = await _job_row(conn, customer_id, flow_id, job_id)
    public = (_loads(row["result"]) or {}).get("public") or {}
    if row["status"] != "done" or public.get("kind") != "proposal":
        raise AssistRejected(409, "assist_not_a_proposal")
    return public
