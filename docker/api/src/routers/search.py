"""Admin search tools — DID search and user search (RCF-V1)."""
import re
import orjson
from fastapi import APIRouter, Depends, HTTPException, Query
from db import database as db
from auth.dependencies import require_admin
from services import customer_numbers as cn

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


#: /search/did rows: every platform-owned DID from the number_routing view
#: (services/customer_numbers.py — rcf, api, trunk, voicemail and any future
#: arm), paged FIRST, then `details` built for the page rows only.
#:   * status  = active/disabled from product_enabled (rcf: rcf_numbers.enabled,
#:     api: api_dids.enabled, trunk: sip_trunks.enabled — identical to the old
#:     per-table UNION; voicemail: mailbox active AND customer entitled).
#:   * details = correlated sub-selects by the view's product_ref_id/trunk_id
#:     with BYTE-IDENTICAL keys to the old per-table query for rcf/api/trunk
#:     (tests/test_customer_numbers.py golden-compares the two); voicemail
#:     {label, mailbox_id, enabled}; a future product {name, enabled}.
#:   * api stays listed (admin cleanup tool).
#: `{where}` is a fixed fragment; `{limit}`/`{offset}` are bind placeholders.
_DID_SEARCH_SQL = """
WITH matched AS (
    SELECT nr.did, nr.product_type, nr.product_ref_id, nr.trunk_id,
           nr.product_name, nr.product_enabled,
           nr.customer_id, c.name AS customer_name
      FROM number_routing nr
      JOIN customers c ON c.id = nr.customer_id
     {where}
),
page AS (
    SELECT m.*, COUNT(*) OVER() AS _total
      FROM matched m
     ORDER BY m.did, {precedence}
     LIMIT {limit} OFFSET {offset}
)
SELECT p.did,
       p.product_type::text AS product,
       p.customer_id,
       p.customer_name,
       CASE WHEN p.product_enabled THEN 'active' ELSE 'disabled' END AS status,
       CASE p.product_type
         WHEN 'rcf' THEN (
           SELECT jsonb_build_object(
                      'name',           r.name,
                      'forward_to',     r.forward_to,
                      'enabled',        r.enabled,
                      'ring_timeout',   r.ring_timeout,
                      'failover_to',    r.failover_to,
                      'pass_caller_id', r.pass_caller_id)
             FROM rcf_numbers r WHERE r.id = p.product_ref_id)
         WHEN 'api' THEN (
           SELECT jsonb_build_object(
                      'voice_url',      a.voice_url,
                      'fallback_url',   a.fallback_url,
                      'voice_method',   a.voice_method,
                      'enabled',        a.enabled)
             FROM api_dids a WHERE a.id = p.product_ref_id)
         WHEN 'trunk' THEN (
           SELECT jsonb_build_object(
                      'trunk_id',       t.id,
                      'trunk_name',     t.trunk_name,
                      'trunk_enabled',  t.enabled,
                      'max_channels',   t.max_channels,
                      'auth_type',      t.auth_type)
             FROM sip_trunks t WHERE t.id = p.trunk_id)
         WHEN 'voicemail' THEN jsonb_build_object(
                      'label',          p.product_name,
                      'mailbox_id',     p.product_ref_id,
                      'enabled',        p.product_enabled)
         ELSE jsonb_build_object(
                      'name',           p.product_name,
                      'enabled',        p.product_enabled)
       END AS details,
       p._total
  FROM page p
 ORDER BY p.did, {page_precedence}
"""


def did_search_sql(with_query: bool) -> str:
    """The /search/did statement: `$1` LIKE pattern (when `with_query`), then
    limit / offset binds."""
    if with_query:
        where, limit, offset = "WHERE nr.did LIKE $1::text", "$2::int", "$3::int"
    else:
        where, limit, offset = "", "$1::int", "$2::int"
    return _DID_SEARCH_SQL.format(
        where=where, limit=limit, offset=offset,
        precedence=cn.precedence_sql("m.product_type"),
        page_precedence=cn.precedence_sql("p.product_type"))


@router.get("/did")
async def search_did(
    q: str | None = Query(None, description="Phone number (partial or full). Omit to list all DIDs."),
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    admin: dict = Depends(require_admin),
):
    """Search for a DID across every product (RCF, API Calling, SIP Trunk,
    Voicemail and any future number_routing arm).

    When ``q`` is provided, normalises the query (strips formatting) and does
    a partial LIKE match on the DID.  When ``q`` is omitted, all DIDs across
    all products are returned (still paginated via limit/offset).
    """
    if q is not None:
        digits = normalize_did_query(q)
        if len(digits) < 3:
            raise HTTPException(
                status_code=400,
                detail="Query must contain at least 3 digits after normalisation",
            )

        like_pattern = f"%{digits}%"
        rows = await db.fetch_all(did_search_sql(True), like_pattern, limit, offset)

    else:
        # No query — list all DIDs across every product, paginated.
        rows = await db.fetch_all(did_search_sql(False), limit, offset)

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
    WHERE (caller_id = $1 OR destination = $1)
      AND leg IS DISTINCT FROM 'B'   -- one row per call (leg split)
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
