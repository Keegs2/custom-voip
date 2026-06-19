"""Read-only observability for active media-fork sessions — Phase 8.

    GET /v1/media/streams -> {streams:[{call_uuid, frames, bytes, duration_ms, started_at}]}

Lists the audio forks (``mod_audio_stream`` WebSocket sinks) this API worker is
currently consuming, from the in-memory registry maintained by
:func:`services.media.consume_media_stream`.

Tenant scoping limitation: media forks arrive from FreeSWITCH WITHOUT a JWT and
the WS layer does not carry a customer_id, so a stream cannot be tenant-scoped on
its own. We cross-reference the Phase 5 ESL live-call registry by ``call_uuid``:
  * admins (customer_filter None) see ALL active streams;
  * a non-admin sees only streams whose ``call_uuid`` maps to a LiveCall in the
    ESL registry owned by their customer_id. A stream that cannot be correlated
    to a tenant (call not in the registry) is hidden from non-admins — fail
    closed, never leak cross-tenant.

Always degrades gracefully (empty list) — the registry is pure in-memory, so this
never 500s even when FreeSWITCH/ESL is unreachable (on Docker Desktop both the
fork sink and the ESL registry are simply empty).
"""
import logging

from fastapi import APIRouter, Depends

from auth.dependencies import get_customer_filter
from services.media import list_active_streams
from services.esl_client import get_esl_client

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/streams")
async def list_media_streams(
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List active media-fork sessions (tenant-scoped via the ESL registry).

    PROD-3: ``list_active_streams`` unions all workers' forks via Redis, so this
    is consistent across the 4 uvicorn workers (degrades to the local worker's
    view when Redis is down — never 500s).
    """
    streams = await list_active_streams()

    if customer_filter is not None:
        client = get_esl_client()
        scoped = []
        for s in streams:
            call = client.get_call(s["call_uuid"])
            if call is not None and call.customer_id == customer_filter:
                scoped.append(s)
        streams = scoped

    return {"streams": streams}
