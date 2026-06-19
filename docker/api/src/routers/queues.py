"""Read-only observability for LIVE FreeSWITCH ``mod_fifo`` queues — Phase 8.

Two endpoints the Phase 8 UI codes against:

    GET /v1/queues          -> {esl_connected, queues:[{name, depth, ...}]}
    GET /v1/queues/{name}   -> {name, depth, members:[...], ...}

Queues are tenant-namespaced on the media server as ``fifo_<customer_id>_<name>``
and have NO backing DB row, so tenant ownership is enforced ENTIRELY from the
queue-name prefix via :mod:`services.fifo_queues` (admin => customer_filter None
=> sees all), exactly like the live-conference endpoints in ``conference.py``.

The ``{name}`` path param is the FULL FreeSWITCH queue name (``fifo_<C>_<sub>``):
the tenant gate (safe-name + ownership) runs BEFORE any ESL call, so a
cross-tenant or injection-laden name is rejected (404) even when FreeSWITCH is
unreachable. The response ``name`` is the prefix-stripped display name.

Local-env note (Docker Desktop): host-net FreeSWITCH cannot be reached over ESL
from the bridge API container, so ``_send_esl_command`` returns None, the parser
degrades to an empty list, and these endpoints return cleanly (200 / empty,
``esl_connected=false``) — never a 500.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException

from auth.dependencies import get_customer_filter
from services.esl_client import _send_esl_command, get_esl_client
from services.fifo_queues import (
    parse_fifo_list,
    scope_queues,
    queue_visible,
    is_safe_queue_name,
    queue_owner_customer_id,
    queue_display_name,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("")
async def list_queues(
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List active FreeSWITCH fifo queues, tenant-scoped by the ``fifo_<C>_``
    name prefix. Non-admins see only their own customer's queues; admins see all.

    Degrades gracefully when ESL is unreachable: empty list + ``esl_connected``
    false — never a 500.
    """
    raw = await _send_esl_command("fifo list")
    queues = scope_queues(parse_fifo_list(raw), customer_filter)
    return {
        "esl_connected": get_esl_client().connected,
        "count": len(queues),
        "queues": queues,
    }


@router.get("/{name}")
async def get_queue(
    name: str,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Live status for a single fifo queue by its FULL FS name (tenant-scoped by
    prefix). Returns depth + the waiting callers as ``members``.

    The tenant gate runs BEFORE any ESL call, so a cross-tenant or unsafe name is
    404 even when FreeSWITCH is unreachable. When the queue exists for the tenant
    but is not currently active in FS (or ESL is down), this returns a clean
    ``depth=0 / members=[]`` snapshot rather than a 404.
    """
    if not is_safe_queue_name(name) or not queue_visible(name, customer_filter):
        # 404 (not 403) so we never leak the existence of another tenant's queue.
        raise HTTPException(status_code=404, detail="Queue not found")

    raw = await _send_esl_command(f"fifo list {name}")
    match = next((q for q in parse_fifo_list(raw) if q["name"] == name), None)

    base = {
        "name": queue_display_name(name),
        "fs_name": name,
        "customer_id": queue_owner_customer_id(name),
        "esl_connected": get_esl_client().connected,
    }
    if match is None:
        return {**base, "is_active": False, "depth": 0, "members": []}
    return {
        **base,
        "is_active": match["depth"] > 0 or bool(match["members"]),
        "depth": match["depth"],
        "members": match["members"],
    }
