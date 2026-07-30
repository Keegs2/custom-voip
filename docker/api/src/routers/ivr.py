"""IVR flow persistence.

Stores customer-built IVR call flows as a JSON node graph and serves the exact
shapes the React IVR builder consumes (docker/ui/app/src/api/ivr.ts +
types/ivr.ts):

  GET    /ivr          -> IvrFlowListItem[]  (id, name, description, did,
                                              node_count, created_at, updated_at)
  GET    /ivr/{id}     -> IvrFlow            (…, nodes[], entry_node_id)
  POST   /ivr          -> IvrFlow            body: IvrFlowSave
  PUT    /ivr/{id}     -> IvrFlow            body: IvrFlowSave
  DELETE /ivr/{id}     -> 204 No Content

Persistence: `ivr_flows(id, customer_id, name, definition JSONB, is_active,
created_at, updated_at)`. The graph-shaped fields (nodes, entry_node_id,
description, did) live inside `definition`; `name` is its own column so lists
can render without deserializing the whole graph.

Tenant-scoped via get_customer_filter: a non-admin only ever sees/edits their own
customer's flows; cross-tenant / unknown ids return 404 (no existence leak).
Admins may pass ?customer_id to scope reads/creates to a specific customer.
"""
import json
import logging
from typing import Optional, List, Any

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import Response
from pydantic import BaseModel

from db import database as db
from auth.dependencies import get_customer_filter

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models — mirror docker/ui/app/src/types/ivr.ts
# ---------------------------------------------------------------------------

class IvrNode(BaseModel):
    id: str
    type: str
    config: dict = {}
    prompt: Optional[str] = None
    branches: dict = {}


class IvrFlowSave(BaseModel):
    name: str
    description: Optional[str] = None
    did: Optional[str] = None
    nodes: List[IvrNode] = []
    entry_node_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

def _load_definition(raw: Any) -> dict:
    """Parse the JSONB `definition` column into a dict.

    asyncpg returns jsonb as a str by default (no codec registered); guard for a
    dict too in case a json codec is added later, and for NULL/garbage.
    """
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (str, bytes, bytearray)):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _flow_out(row) -> dict:
    """Shape a DB row into the frontend `IvrFlow` object."""
    definition = _load_definition(row["definition"])
    return {
        "id": row["id"],
        "name": row["name"],
        "description": definition.get("description"),
        "did": definition.get("did"),
        "nodes": definition.get("nodes", []),
        "entry_node_id": definition.get("entry_node_id"),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


def _definition_json(flow: IvrFlowSave) -> str:
    """Build the JSONB `definition` payload from an IvrFlowSave body."""
    return json.dumps({
        "description": flow.description,
        "did": flow.did,
        "nodes": [n.model_dump() for n in flow.nodes],
        "entry_node_id": flow.entry_node_id,
    })


async def _get_owned_flow(flow_id: int, customer_filter: int | None):
    """Fetch an IVR flow enforcing tenant isolation.

    404 if the flow does not exist OR belongs to another customer (no
    cross-tenant existence leak). Admins (customer_filter is None) are
    unrestricted. Returns the raw asyncpg row.
    """
    row = await db.fetch_one(
        """
        SELECT id, customer_id, name, definition, is_active, created_at, updated_at
        FROM ivr_flows
        WHERE id = $1::int AND ($2::int IS NULL OR customer_id = $2::int)
        """,
        flow_id, customer_filter,
    )
    if not row:
        raise HTTPException(status_code=404, detail="IVR flow not found")
    return row


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_ivr_flows(
    customer_id: Optional[int] = None,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List IVR flows (IvrFlowListItem[]). Non-admins see only their own."""
    # Non-admins are hard-scoped to their own customer; admins may pass ?customer_id.
    effective_customer = customer_filter if customer_filter is not None else customer_id

    query = """
        SELECT id, customer_id, name, definition, created_at, updated_at
        FROM ivr_flows
    """
    values = []
    if effective_customer is not None:
        query += " WHERE customer_id = $1::int"
        values.append(effective_customer)
    query += " ORDER BY updated_at DESC"

    rows = await db.fetch_all(query, *values)

    out = []
    for row in rows:
        definition = _load_definition(row["definition"])
        out.append({
            "id": row["id"],
            "name": row["name"],
            "description": definition.get("description"),
            "did": definition.get("did"),
            "node_count": len(definition.get("nodes", []) or []),
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        })
    return out


@router.get("/{flow_id}")
async def get_ivr_flow(
    flow_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get a single IVR flow (IvrFlow) with its full node graph."""
    row = await _get_owned_flow(flow_id, customer_filter)
    return _flow_out(row)


@router.post("")
async def create_ivr_flow(
    flow: IvrFlowSave,
    customer_id: Optional[int] = None,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Create an IVR flow and return it (IvrFlow)."""
    # Non-admins create under their own customer; admins must target one via
    # ?customer_id (the flow needs an owner for tenant scoping).
    owner = customer_filter if customer_filter is not None else customer_id
    if owner is None:
        raise HTTPException(status_code=400, detail="customer_id is required")

    row = await db.fetch_one(
        """
        INSERT INTO ivr_flows (customer_id, name, definition)
        VALUES ($1::int, $2::varchar, $3::jsonb)
        RETURNING id, customer_id, name, definition, is_active, created_at, updated_at
        """,
        owner, flow.name, _definition_json(flow),
    )
    return _flow_out(row)


@router.put("/{flow_id}")
async def update_ivr_flow(
    flow_id: int,
    flow: IvrFlowSave,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Replace an IVR flow's name + definition and return it (IvrFlow)."""
    # Ownership gate first (404 cross-tenant/missing).
    await _get_owned_flow(flow_id, customer_filter)

    row = await db.fetch_one(
        """
        UPDATE ivr_flows
        SET name = $2::varchar, definition = $3::jsonb, updated_at = NOW()
        WHERE id = $1::int
        RETURNING id, customer_id, name, definition, is_active, created_at, updated_at
        """,
        flow_id, flow.name, _definition_json(flow),
    )
    return _flow_out(row)


@router.delete("/{flow_id}", status_code=204)
async def delete_ivr_flow(
    flow_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Delete an IVR flow (owner-scoped, 404-no-leak). Returns 204."""
    await _get_owned_flow(flow_id, customer_filter)
    await db.execute("DELETE FROM ivr_flows WHERE id = $1::int", flow_id)
    return Response(status_code=204)
