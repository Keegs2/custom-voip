"""Admin search tools — DID search and user search (RCF-V1)."""
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

    NOTE: This is intentionally NOT utils.phone.normalize_e164. This is the
    READ/search side — a format-agnostic partial-match helper that deliberately
    reduces input to bare digits so a substring `LIKE %digits%` matches DIDs
    regardless of stored formatting or country code (e.g. '617' matches). The
    canonical +E.164 normalizer is only for WRITE paths (what we persist/route on).
    """
    return re.sub(r"[^\d]", "", raw)


@router.get("/did")
async def search_did(
    q: str | None = Query(None, description="Phone number (partial or full). Omit to list all DIDs."),
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    admin: dict = Depends(require_admin),
):
    """Search for a DID across RCF, API Calling, and SIP Trunk products.

    When ``q`` is provided, normalises the query (strips formatting) and does
    a partial LIKE match against every DID table.  When ``q`` is omitted, all
    DIDs across all products are returned (still paginated via limit/offset).
    """
    if q is not None:
        digits = normalize_did_query(q)
        if len(digits) < 3:
            raise HTTPException(
                status_code=400,
                detail="Query must contain at least 3 digits after normalisation",
            )

        like_pattern = f"%{digits}%"

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
        )
        SELECT *, COUNT(*) OVER() AS _total
        FROM matched
        ORDER BY did
        LIMIT $2 OFFSET $3
        """

        rows = await db.fetch_all(search_sql, like_pattern, limit, offset)

    else:
        # No query — list all DIDs across every product table, paginated.
        list_sql = """
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
        )
        SELECT *, COUNT(*) OVER() AS _total
        FROM matched
        ORDER BY did
        LIMIT $1 OFFSET $2
        """

        rows = await db.fetch_all(list_sql, limit, offset)

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


# ---------------------------------------------------------------------------
# User Search — find users by name or email
# ---------------------------------------------------------------------------

@router.get("/user")
async def search_users(
    q: str | None = Query(None, min_length=1, description="Search by name or email"),
    customer_id: int | None = Query(None, description="Filter results to a specific customer"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    admin: dict = Depends(require_admin),
):
    """Search users by name or email.

    Returns basic user info with customer context for each match.

    When ``customer_id`` is provided without ``q``, returns all users for that
    customer.  When both are provided, the text search is scoped to that
    customer only.
    """
    if q is None and customer_id is None:
        raise HTTPException(
            status_code=400,
            detail="At least one of 'q' or 'customer_id' must be provided",
        )

    if q is not None and customer_id is not None:
        # Text search scoped to a specific customer
        like_pattern = f"%{q}%"
        search_sql = """
        WITH matched AS (
            SELECT
                u.id,
                u.name,
                u.email,
                u.customer_id,
                c.name AS customer_name
            FROM users u
            LEFT JOIN customers c ON c.id = u.customer_id
            WHERE u.customer_id = $2
              AND (u.name ILIKE $1 OR u.email ILIKE $1)
        )
        SELECT *, COUNT(*) OVER() AS _total
        FROM matched
        ORDER BY name
        LIMIT $3 OFFSET $4
        """
        rows = await db.fetch_all(search_sql, like_pattern, customer_id, limit, offset)

    elif q is not None:
        # Text search across all customers
        like_pattern = f"%{q}%"
        search_sql = """
        WITH matched AS (
            SELECT
                u.id,
                u.name,
                u.email,
                u.customer_id,
                c.name AS customer_name
            FROM users u
            LEFT JOIN customers c ON c.id = u.customer_id
            WHERE u.name ILIKE $1 OR u.email ILIKE $1
        )
        SELECT *, COUNT(*) OVER() AS _total
        FROM matched
        ORDER BY name
        LIMIT $2 OFFSET $3
        """
        rows = await db.fetch_all(search_sql, like_pattern, limit, offset)

    else:
        # customer_id only — list all users for that customer
        search_sql = """
        WITH matched AS (
            SELECT
                u.id,
                u.name,
                u.email,
                u.customer_id,
                c.name AS customer_name
            FROM users u
            LEFT JOIN customers c ON c.id = u.customer_id
            WHERE u.customer_id = $1
        )
        SELECT *, COUNT(*) OVER() AS _total
        FROM matched
        ORDER BY name
        LIMIT $2 OFFSET $3
        """
        rows = await db.fetch_all(search_sql, customer_id, limit, offset)

    total = int(rows[0]["_total"]) if rows else 0

    results = []
    for r in rows:
        results.append({
            "id": r["id"],
            "name": r["name"],
            "email": r["email"],
            "customer_id": r["customer_id"],
            "customer_name": r["customer_name"],
        })

    return {"results": results, "total": total}


# ---------------------------------------------------------------------------
# List Users by Customer
# ---------------------------------------------------------------------------

@router.get("/user/by-customer/{customer_id}")
async def list_users_by_customer(
    customer_id: int,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    admin: dict = Depends(require_admin),
):
    """Return all users for a specific customer.

    Results are ordered by name.
    """
    list_sql = """
    WITH matched AS (
        SELECT
            u.id,
            u.name,
            u.email,
            u.role,
            u.status,
            u.last_login
        FROM users u
        WHERE u.customer_id = $1
    )
    SELECT *, COUNT(*) OVER() AS _total
    FROM matched
    ORDER BY name
    LIMIT $2 OFFSET $3
    """

    rows = await db.fetch_all(list_sql, customer_id, limit, offset)

    total = int(rows[0]["_total"]) if rows else 0

    results = []
    for r in rows:
        results.append({
            "id": r["id"],
            "name": r["name"],
            "email": r["email"],
            "role": r["role"],
            "status": r["status"],
            "last_login": r["last_login"],
        })

    return {"results": results, "total": total, "customer_id": customer_id}
