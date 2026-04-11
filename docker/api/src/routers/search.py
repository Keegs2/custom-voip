"""Global DID Search — admin support tool for finding any DID across all products."""
import re
import orjson
from fastapi import APIRouter, Depends, HTTPException, Query
from db import database as db
from auth.dependencies import require_admin

router = APIRouter()


def normalize_did_query(raw: str) -> str:
    """Strip everything except digits from the search input.

    Accepts any common format:
        +16174544217, (617) 454-4217, 617-454-4217, 6174544217
    Returns the bare digit string for use in a SQL LIKE clause.
    """
    return re.sub(r"[^\d]", "", raw)


@router.get("/did")
async def search_did(
    q: str = Query(..., min_length=3, description="Phone number (partial or full)"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    admin: dict = Depends(require_admin),
):
    """Search for a DID across all products (RCF, API, SIP Trunk, UCaaS).

    Normalises the query (strips formatting), then does a partial LIKE match
    against every DID table.  Returns product-specific details and the owning
    customer for each hit.
    """
    digits = normalize_did_query(q)
    if len(digits) < 3:
        raise HTTPException(
            status_code=400,
            detail="Query must contain at least 3 digits after normalisation",
        )

    like_pattern = f"%{digits}%"

    # -----------------------------------------------------------------
    # UNION query across all four DID sources.
    # Each branch projects a common shape plus a JSONB 'details' blob
    # carrying product-specific fields.
    # -----------------------------------------------------------------
    search_sql = """
    WITH matched AS (
        -- RCF
        SELECT
            r.did,
            'rcf'::text              AS product,
            c.id                     AS customer_id,
            c.name                   AS customer_name,
            CASE WHEN r.enabled THEN 'active' ELSE 'disabled' END AS status,
            jsonb_build_object(
                'name',           r.name,
                'forward_to',     r.forward_to,
                'enabled',        r.enabled,
                'ring_timeout',   r.ring_timeout,
                'failover_to',    r.failover_to,
                'pass_caller_id', r.pass_caller_id
            ) AS details
        FROM rcf_numbers r
        JOIN customers c ON c.id = r.customer_id
        WHERE r.did LIKE $1

        UNION ALL

        -- API Calling
        SELECT
            a.did,
            'api'::text              AS product,
            c.id                     AS customer_id,
            c.name                   AS customer_name,
            CASE WHEN a.enabled THEN 'active' ELSE 'disabled' END AS status,
            jsonb_build_object(
                'voice_url',      a.voice_url,
                'fallback_url',   a.fallback_url,
                'voice_method',   a.voice_method,
                'enabled',        a.enabled
            ) AS details
        FROM api_dids a
        JOIN customers c ON c.id = a.customer_id
        WHERE a.did LIKE $1

        UNION ALL

        -- SIP Trunk
        SELECT
            td.did,
            'trunk'::text            AS product,
            c.id                     AS customer_id,
            c.name                   AS customer_name,
            CASE WHEN t.enabled THEN 'active' ELSE 'disabled' END AS status,
            jsonb_build_object(
                'trunk_id',       t.id,
                'trunk_name',     t.trunk_name,
                'trunk_enabled',  t.enabled,
                'max_channels',   t.max_channels,
                'auth_type',      t.auth_type
            ) AS details
        FROM trunk_dids td
        JOIN sip_trunks t ON t.id = td.trunk_id
        JOIN customers c  ON c.id = t.customer_id
        WHERE td.did LIKE $1

        UNION ALL

        -- UCaaS (extension with assigned DID)
        SELECT
            e.assigned_did           AS did,
            'ucaas'::text            AS product,
            c.id                     AS customer_id,
            c.name                   AS customer_name,
            e.status,
            jsonb_build_object(
                'extension',      e.extension,
                'display_name',   e.display_name,
                'assigned_did',   e.assigned_did
            ) AS details
        FROM extensions e
        JOIN customers c ON c.id = e.customer_id
        WHERE e.assigned_did IS NOT NULL
          AND e.assigned_did LIKE $1
    )
    SELECT *, COUNT(*) OVER() AS _total
    FROM matched
    ORDER BY did
    LIMIT $2 OFFSET $3
    """

    rows = await db.fetch_all(search_sql, like_pattern, limit, offset)

    total = int(rows[0]["_total"]) if rows else 0

    results = []
    for r in rows:
        results.append({
            "did": r["did"],
            "product": r["product"],
            "customer_id": r["customer_id"],
            "customer_name": r["customer_name"],
            "status": r["status"],
            "details": r["details"] if isinstance(r["details"], dict) else (orjson.loads(r["details"]) if r["details"] else {}),
        })

    return {"results": results, "total": total}


@router.get("/did/{did}/calls")
async def did_call_history(
    did: str,
    limit: int = Query(50, ge=1, le=200),
    admin: dict = Depends(require_admin),
):
    """Return recent call history for a specific DID.

    Matches the DID against both the caller and callee (destination) fields
    in the CDR table.  Returns newest-first.
    """
    # Normalise: ensure E.164 with +1 prefix for exact match
    digits = normalize_did_query(did)
    if not digits:
        raise HTTPException(status_code=400, detail="Invalid DID")

    # Build the canonical +1 form if the caller passed raw digits
    if len(digits) == 10:
        canonical = f"+1{digits}"
    elif len(digits) == 11 and digits.startswith("1"):
        canonical = f"+{digits}"
    else:
        canonical = f"+{digits}" if not did.startswith("+") else did

    cdr_sql = """
    SELECT
        uuid,
        direction,
        caller_id   AS caller,
        destination  AS callee,
        duration_ms,
        hangup_cause,
        start_time,
        answer_time,
        product_type,
        customer_id,
        sip_code,
        carrier_used,
        total_cost
    FROM cdrs
    WHERE caller_id = $1 OR destination = $1
    ORDER BY start_time DESC
    LIMIT $2
    """

    rows = await db.fetch_all(cdr_sql, canonical, limit)
    return {
        "did": canonical,
        "calls": [dict(r) for r in rows],
        "count": len(rows),
    }
