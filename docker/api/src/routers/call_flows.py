"""Universal Call Flow Builder — product-agnostic flow store (admin-only).

The Call Flow Builder edits one portable node-graph (the CallFlowDoc, see
docs/CALL_FLOW_BUILDER_PLAN.md §2.2) per product. This router is the CRUD/publish
surface over the generalized ``call_flows`` table (migration 27): the editable
graph (``flow_graph``) is the source of truth, ``compiled`` holds the compiled
product artifact, and ``status``/``version`` track the draft→publish lifecycle.

The RUNTIME is unchanged. On publish, the (client-side, P0) compiler's output is
written into the existing per-product sink — for ``ivr``/``api`` that is an
``ivr_flows`` row, so ``/ivr/{sink_ref}/xml`` + ``api_voice.lua`` serve the flow
with ZERO runtime change. ``sink_ref`` records the published sink row id.

Every endpoint is admin-only (``require_admin``). All flow-graph fields are
JSONB in / JSON out, stored verbatim. Conventions mirror ivr.py /
number_inventory.py: asyncpg positional ``$N`` params with explicit ``::jsonb``
casts (PgBouncer transaction mode → ``statement_cache_size=0``).
"""
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, field_validator

from db import database as db
from auth.dependencies import require_admin

logger = logging.getLogger(__name__)

router = APIRouter()

# Products that map cleanly onto the builder. Mirrors the table CHECK constraint.
VALID_PRODUCTS = {"ivr", "rcf", "trunk", "api", "conference", "ucaas"}

# Products whose publish writes the existing IVR sink (ivr_flows.flow_config).
IVR_SINK_PRODUCTS = {"ivr", "api"}

# Column projection for every CallFlow read/return (matches the CallFlow JSON).
_COLUMNS = (
    "id, product, name, customer_id, entry, flow_graph, compiled, "
    "status, version, sink_ref, created_at, updated_at"
)

_JSON_FIELDS = ("entry", "flow_graph", "compiled")


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------

def _serialize(row: Any) -> dict:
    """Convert a call_flows row into the CallFlow JSON shape.

    asyncpg may hand back JSONB columns as either ``str`` or already-decoded
    objects depending on codecs; normalize the JSON fields to objects so the
    wire contract is stable.
    """
    out = dict(row)
    for field in _JSON_FIELDS:
        val = out.get(field)
        if isinstance(val, str):
            out[field] = json.loads(val)
    return out


# ---------------------------------------------------------------------------
# Pydantic models (inline, Pydantic V2)
# ---------------------------------------------------------------------------

class CallFlowCreate(BaseModel):
    product: str
    name: str
    customer_id: Optional[int] = None
    entry: dict = {}
    flow_graph: dict
    compiled: Optional[dict] = None

    @field_validator("product")
    @classmethod
    def _valid_product(cls, v: str) -> str:
        if v not in VALID_PRODUCTS:
            raise ValueError(
                f"product must be one of {sorted(VALID_PRODUCTS)}"
            )
        return v


class CallFlowUpdate(BaseModel):
    name: Optional[str] = None
    entry: Optional[dict] = None
    flow_graph: dict
    compiled: Optional[dict] = None


class CallFlowPublish(BaseModel):
    compiled: dict


# ---------------------------------------------------------------------------
# CRUD endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_call_flows(
    product: Optional[str] = None,
    customer_id: Optional[int] = None,
    limit: int = 100,
    offset: int = 0,
    admin: dict = Depends(require_admin),
):
    """List call flows, optionally filtered by product and customer_id."""
    query = f"SELECT {_COLUMNS}, COUNT(*) OVER() AS total_count FROM call_flows WHERE 1=1"
    values: list[Any] = []
    idx = 1

    if product is not None:
        query += f" AND product = ${idx}"
        values.append(product)
        idx += 1
    if customer_id is not None:
        query += f" AND customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    query += f" ORDER BY updated_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    total = rows[0]["total_count"] if rows else 0
    items = []
    for r in rows:
        item = _serialize(r)
        item.pop("total_count", None)
        items.append(item)
    return {"items": items, "total": total}


@router.post("")
async def create_call_flow(
    flow: CallFlowCreate,
    admin: dict = Depends(require_admin),
):
    """Create a new draft call flow (status='draft', version=1)."""
    if flow.customer_id is not None:
        customer = await db.fetch_one(
            "SELECT id FROM customers WHERE id = $1", flow.customer_id
        )
        if not customer:
            raise HTTPException(status_code=404, detail="Customer not found")

    row = await db.fetch_one(
        f"""
        INSERT INTO call_flows (product, name, customer_id, entry, flow_graph, compiled)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
        RETURNING {_COLUMNS}
        """,
        flow.product,
        flow.name,
        flow.customer_id,
        json.dumps(flow.entry),
        json.dumps(flow.flow_graph),
        json.dumps(flow.compiled) if flow.compiled is not None else None,
    )
    return _serialize(row)


@router.get("/{flow_id}")
async def get_call_flow(
    flow_id: int,
    admin: dict = Depends(require_admin),
):
    """Get a single call flow by id."""
    row = await db.fetch_one(
        f"SELECT {_COLUMNS} FROM call_flows WHERE id = $1", flow_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call flow not found")
    return _serialize(row)


@router.put("/{flow_id}")
async def update_call_flow(
    flow_id: int,
    flow: CallFlowUpdate,
    admin: dict = Depends(require_admin),
):
    """Update a draft call flow. Stays 'draft'; bumps version."""
    existing = await db.fetch_one(
        "SELECT id FROM call_flows WHERE id = $1", flow_id
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Call flow not found")

    updates = ["flow_graph = $1::jsonb"]
    values: list[Any] = [json.dumps(flow.flow_graph)]
    idx = 2

    if flow.name is not None:
        updates.append(f"name = ${idx}")
        values.append(flow.name)
        idx += 1
    if flow.entry is not None:
        updates.append(f"entry = ${idx}::jsonb")
        values.append(json.dumps(flow.entry))
        idx += 1
    if flow.compiled is not None:
        updates.append(f"compiled = ${idx}::jsonb")
        values.append(json.dumps(flow.compiled))
        idx += 1

    updates.append("status = 'draft'")
    updates.append("version = version + 1")
    updates.append("updated_at = now()")
    values.append(flow_id)

    row = await db.fetch_one(
        f"UPDATE call_flows SET {', '.join(updates)} WHERE id = ${idx} RETURNING {_COLUMNS}",
        *values,
    )
    return _serialize(row)


@router.post("/{flow_id}/publish")
async def publish_call_flow(
    flow_id: int,
    body: CallFlowPublish,
    admin: dict = Depends(require_admin),
):
    """Publish a call flow: write the compiled artifact to the product sink,
    then mark the flow 'published' and record sink_ref.

    For ivr/api: upsert an ``ivr_flows`` row (``flow_config`` = compiled) so the
    existing runtime (``/ivr/{sink_ref}/xml`` + ``api_voice.lua``) serves it with
    no change. For other products: persist ``compiled`` + mark published; the
    sink write is a documented TODO (P2+) — their runtimes are NOT touched here.

    The ivr_flows upsert + call_flows update run in one transaction.
    """
    flow = await db.fetch_one(
        "SELECT id, product, name, customer_id, entry, sink_ref FROM call_flows WHERE id = $1",
        flow_id,
    )
    if not flow:
        raise HTTPException(status_code=404, detail="Call flow not found")

    product = flow["product"]
    name = flow["name"]
    customer_id = flow["customer_id"]
    sink_ref = flow["sink_ref"]
    compiled_json = json.dumps(body.compiled)

    # Resolve a DID from the entry binding, if present (entry kind='did').
    entry = flow["entry"]
    if isinstance(entry, str):
        entry = json.loads(entry) if entry else {}
    did = None
    if isinstance(entry, dict) and entry.get("kind") == "did":
        did = entry.get("did")

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            if product in IVR_SINK_PRODUCTS:
                # ivr_flows.customer_id is NOT NULL — require an owning customer.
                if customer_id is None:
                    raise HTTPException(
                        status_code=400,
                        detail="customer_id is required to publish an ivr/api flow to the IVR sink",
                    )
                if sink_ref is not None:
                    updated_sink = await conn.fetchrow(
                        """
                        UPDATE ivr_flows
                        SET flow_config = $1::jsonb, name = $2, customer_id = $3,
                            did = COALESCE($4, did), is_active = true, updated_at = NOW()
                        WHERE id = $5
                        RETURNING id
                        """,
                        compiled_json, name, customer_id, did, sink_ref,
                    )
                    if updated_sink is None:
                        # Sink row referenced by sink_ref no longer exists — recreate.
                        sink_ref = None
                if sink_ref is None:
                    new_sink = await conn.fetchrow(
                        """
                        INSERT INTO ivr_flows (customer_id, did, name, flow_config)
                        VALUES ($1, $2, $3, $4::jsonb)
                        RETURNING id
                        """,
                        customer_id, did, name, compiled_json,
                    )
                    sink_ref = new_sink["id"]

                # P1 FIX (verified P0 bug): repoint the bound DID's voice_url at
                # the IVR webhook so a freshly published ivr/api flow is actually
                # reachable. Mirrors ivr.py:_update_did_voice_url EXACTLY (same
                # URL format) so inbound routing behaves identically. Done inside
                # this same transaction. ivr DIDs may have no api_dids row →
                # UPDATE 0 → log + skip (never 500).
                if did:
                    webhook_url = f"http://api:8000/ivr/webhook/{sink_ref}"
                    upd = await conn.execute(
                        "UPDATE api_dids SET voice_url = $1 WHERE did = $2",
                        webhook_url, did,
                    )
                    if upd == "UPDATE 0":
                        logger.info(
                            "publish flow %s: DID %s has no api_dids row; "
                            "voice_url not repointed (sink_ref=%s)",
                            flow_id, did, sink_ref,
                        )
                    else:
                        logger.info(
                            "publish flow %s: DID %s voice_url -> %s",
                            flow_id, did, webhook_url,
                        )
            # else: non-IVR products — no sink write yet (P2+ TODO). compiled is
            # still persisted on call_flows below so the artifact is not lost.

            row = await conn.fetchrow(
                f"""
                UPDATE call_flows
                SET compiled = $1::jsonb, status = 'published', sink_ref = $2,
                    updated_at = now()
                WHERE id = $3
                RETURNING {_COLUMNS}
                """,
                compiled_json, sink_ref, flow_id,
            )

    return _serialize(row)


@router.delete("/{flow_id}", status_code=204)
async def delete_call_flow(
    flow_id: int,
    admin: dict = Depends(require_admin),
):
    """Delete a call flow. Returns 204. (The product sink row, if any, is left
    intact so a published runtime keeps serving until explicitly removed.)"""
    result = await db.execute("DELETE FROM call_flows WHERE id = $1", flow_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Call flow not found")
    return Response(status_code=204)
