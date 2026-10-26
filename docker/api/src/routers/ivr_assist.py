"""Visual IVR Flow assistant API (contract docs/IVR_ASSIST_INTERFACES.md §5).

Mounted with the Visual IVR router at ``/v1/ivr`` and ``/ivr`` (main.py), with
the same scope, tenancy and errors as ``routers/ivr.py``: ``ivr_scope`` /
``ivr_writer`` (admin ``?customer_id=``; an admin JWT with ``customer_id =
null`` and no ``?customer_id=`` -> 400; readonly may only read), 403
``ivr_not_enabled`` when the customer is not entitled, 404 for another
tenant's flow or job (no existence leak).

  POST /flows/{id}/assist                   writer  {message, conversation_id?,
                                                     refine_job_id?, draft_graph?}
                                                    -> 202 {job_id, conversation_id}
  GET  /flows/{id}/assist/{job_id}          reader  -> {job_id, conversation_id, status,
                                                        elapsed_ms, result?, error?}
  POST /flows/{id}/assist/{job_id}/outcome  writer  {outcome} -> 204

Errors (``{"detail": <code>, ...}``): 403 ``ivr_assist_not_enabled``, 409
``assist_busy``, 429 ``assist_rate_limited`` (+ ``retry_after_s``), 429
``assist_daily_limit``, 409 ``assist_not_refinable`` / ``assist_not_a_proposal``
/ ``assist_outcome_recorded``, 422 for a message outside 1..2000 characters,
an invalid ``draft_graph`` (``invalid_graph``) or a base too large for the
assistant. The work itself (TED + compile) runs in services/ivr/assist/jobs.py.
"""
from __future__ import annotations

import re
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from routers.ivr import (
    IvrApiError,
    IvrScope,
    _check_draft,
    _pool,
    _require_entitled,
    _scoped_flow,
    ivr_scope,
    ivr_writer,
)
from services.ivr.assist import config, jobs

router = APIRouter()

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class AssistBody(BaseModel):
    message: str
    conversation_id: Optional[str] = None
    refine_job_id: Optional[str] = None
    draft_graph: Optional[dict] = None


class OutcomeBody(BaseModel):
    outcome: Literal["accepted", "discarded"]


def _rejected(exc: jobs.AssistRejected) -> IvrApiError:
    return IvrApiError(exc.status, exc.detail, headers=exc.headers, **exc.extra)


def _clean_message(value: str) -> str:
    text = _CONTROL.sub(" ", value).strip()
    if not 1 <= len(text) <= config.MAX_MESSAGE_CHARS:
        raise HTTPException(status_code=422, detail=(
            f"Describe the call flow in 1 to {config.MAX_MESSAGE_CHARS} characters."))
    return text


@router.post("/flows/{flow_id}/assist", status_code=202)
async def start_assist(flow_id: int, body: AssistBody, scope: IvrScope = Depends(ivr_writer)):
    message = _clean_message(body.message)
    if body.draft_graph is not None and body.refine_job_id is None:
        _check_draft(body.draft_graph)
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        await _scoped_flow(conn, scope, flow_id)
    try:
        return await jobs.submit(
            pool, customer_id=scope.customer_id, user_id=scope.user_id, flow_id=flow_id,
            message=message, conversation_id=body.conversation_id,
            refine_job_id=body.refine_job_id,
            draft_graph=body.draft_graph if body.refine_job_id is None else None)
    except jobs.AssistRejected as exc:
        raise _rejected(exc)


@router.get("/flows/{flow_id}/assist/{job_id}")
async def get_assist(flow_id: int, job_id: str, scope: IvrScope = Depends(ivr_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        await _scoped_flow(conn, scope, flow_id)
        try:
            return await jobs.read_job(conn, scope.customer_id, flow_id, job_id)
        except jobs.AssistRejected as exc:
            raise _rejected(exc)


@router.post("/flows/{flow_id}/assist/{job_id}/outcome", status_code=204)
async def assist_outcome(flow_id: int, job_id: str, body: OutcomeBody,
                         scope: IvrScope = Depends(ivr_writer)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _require_entitled(conn, scope)
        await _scoped_flow(conn, scope, flow_id)
        try:
            await jobs.record_outcome(conn, scope.customer_id, flow_id, job_id, body.outcome)
        except jobs.AssistRejected as exc:
            raise _rejected(exc)
    return Response(status_code=204)
