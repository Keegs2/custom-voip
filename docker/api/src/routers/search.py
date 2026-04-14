"""Admin search tools — DID search, user search, and User 360 diagnostic view."""
import asyncio
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
    q: str | None = Query(None, description="Phone number (partial or full). Omit to list all DIDs."),
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    admin: dict = Depends(require_admin),
):
    """Search for a DID across all products (RCF, API, SIP Trunk, UCaaS).

    When ``q`` is provided, normalises the query (strips formatting) and does
    a partial LIKE match against every DID table.  When ``q`` is omitted, all
    DIDs across all products are returned (still paginated via limit/offset).
    """
    # -----------------------------------------------------------------
    # UNION query across all four DID sources.
    # Each branch projects a common shape plus a JSONB 'details' blob
    # carrying product-specific fields.
    #
    # Two variants are built below:
    #   • filtered  — uses a LIKE pattern bound as $1, with $2/$3 for page
    #   • unfiltered — no WHERE clause on the DID, uses $1/$2 for page
    # -----------------------------------------------------------------

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
# User Search — find users by name, email, or extension number
# ---------------------------------------------------------------------------

@router.get("/user")
async def search_users(
    q: str = Query(..., min_length=1, description="Search by name, email, or extension"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    admin: dict = Depends(require_admin),
):
    """Search users by name, email, or extension number.

    Returns basic user info with extension and customer context for each match.
    """
    like_pattern = f"%{q}%"

    search_sql = """
    WITH matched AS (
        SELECT DISTINCT ON (u.id)
            u.id,
            u.name,
            u.email,
            u.customer_id,
            c.name                  AS customer_name,
            e.extension,
            e.assigned_did,
            ps.status               AS presence_status
        FROM users u
        LEFT JOIN customers c       ON c.id = u.customer_id
        LEFT JOIN extensions e      ON e.user_id = u.id AND e.status = 'active'
        LEFT JOIN presence_status ps ON ps.user_id = u.id
        WHERE u.name ILIKE $1
           OR u.email ILIKE $1
           OR e.extension = $2
    )
    SELECT *, COUNT(*) OVER() AS _total
    FROM matched
    ORDER BY name
    LIMIT $3 OFFSET $4
    """

    # For extension search, pass the raw query (exact match on extension).
    # For name/email, the ILIKE handles partial matching.
    rows = await db.fetch_all(search_sql, like_pattern, q, limit, offset)

    total = int(rows[0]["_total"]) if rows else 0

    results = []
    for r in rows:
        results.append({
            "id": r["id"],
            "name": r["name"],
            "email": r["email"],
            "customer_id": r["customer_id"],
            "customer_name": r["customer_name"],
            "extension": r["extension"],
            "assigned_did": r["assigned_did"],
            "presence_status": r["presence_status"],
        })

    return {"results": results, "total": total}


# ---------------------------------------------------------------------------
# User 360 View — comprehensive diagnostic dashboard for a single user
# ---------------------------------------------------------------------------

@router.get("/user/{user_id}/360")
async def user_360_view(
    user_id: int,
    admin: dict = Depends(require_admin),
):
    """Return everything about a user in one request for admin troubleshooting.

    Runs all queries in parallel via asyncio.gather for performance.
    Includes: user info, extension, presence, voicemail counts, chat counts,
    recent calls, registered devices, and product-specific data (RCF numbers,
    API DIDs, SIP trunks) based on the customer's account.
    """

    # -- 1. User info (with customer join) ------------------------------------
    async def fetch_user():
        return await db.fetch_one("""
            SELECT
                u.id,
                u.name,
                u.email,
                u.role,
                u.customer_id,
                c.name          AS customer_name,
                c.account_type,
                c.ucaas_enabled,
                u.status,
                u.created_at,
                u.last_login
            FROM users u
            LEFT JOIN customers c ON c.id = u.customer_id
            WHERE u.id = $1
        """, user_id)

    # -- 2. Extension ---------------------------------------------------------
    async def fetch_extension():
        return await db.fetch_one("""
            SELECT
                id,
                extension,
                assigned_did,
                display_name,
                voicemail_enabled,
                dnd,
                forward_on_busy,
                forward_on_no_answer,
                forward_timeout,
                status
            FROM extensions
            WHERE user_id = $1 AND status = 'active'
        """, user_id)

    # -- 3. Presence ----------------------------------------------------------
    async def fetch_presence():
        return await db.fetch_one("""
            SELECT status, status_message, updated_at
            FROM presence_status
            WHERE user_id = $1
        """, user_id)

    # -- 4. Voicemail counts --------------------------------------------------
    async def fetch_voicemail(ext_id_future):
        ext = await ext_id_future
        if not ext:
            return {"total": 0, "unread": 0}
        ext_id = ext["id"]
        row = await db.fetch_one("""
            SELECT
                COUNT(*)                             AS total,
                COUNT(*) FILTER (WHERE NOT is_read)  AS unread
            FROM voicemails
            WHERE extension_id = $1
        """, ext_id)
        return {"total": int(row["total"]), "unread": int(row["unread"])} if row else {"total": 0, "unread": 0}

    # -- 5. Chat counts -------------------------------------------------------
    async def fetch_chat():
        row = await db.fetch_one("""
            SELECT
                COUNT(DISTINCT cp.conversation_id)  AS total_conversations,
                COALESCE(SUM(
                    CASE WHEN cm.id > COALESCE(cp.last_read_message_id, 0)
                         THEN 1 ELSE 0
                    END
                ), 0)                               AS unread_messages
            FROM chat_participants cp
            LEFT JOIN chat_messages cm
                ON cm.conversation_id = cp.conversation_id
               AND cm.sender_id != cp.user_id
               AND cm.deleted_at IS NULL
            WHERE cp.user_id = $1
        """, user_id)
        return {
            "total_conversations": int(row["total_conversations"]) if row else 0,
            "unread_messages": int(row["unread_messages"]) if row else 0,
        }

    # -- 6. Recent calls (needs extension + DID) ------------------------------
    async def fetch_recent_calls(ext_future):
        ext = await ext_future
        if not ext:
            return []
        # Match on extension number OR assigned DID
        identifiers = [ext["extension"]]
        if ext.get("assigned_did"):
            identifiers.append(ext["assigned_did"])

        rows = await db.fetch_all("""
            SELECT
                uuid,
                direction,
                caller_id,
                destination,
                duration_ms,
                hangup_cause,
                start_time,
                answer_time
            FROM cdrs
            WHERE caller_id = ANY($1) OR destination = ANY($1)
            ORDER BY start_time DESC
            LIMIT 20
        """, identifiers)
        return [dict(r) for r in rows]

    # -- 7. Devices -----------------------------------------------------------
    async def fetch_devices():
        rows = await db.fetch_all("""
            SELECT
                id,
                device_type,
                device_name,
                user_agent,
                registered_at,
                last_seen,
                status
            FROM user_devices
            WHERE user_id = $1
            ORDER BY last_seen DESC NULLS LAST
        """, user_id)
        return [dict(r) for r in rows]

    # -- 8. RCF Numbers (product-specific) ------------------------------------
    async def fetch_rcf_numbers(user_future):
        user = await user_future
        if not user:
            return []
        rows = await db.fetch_all("""
            SELECT
                id,
                did,
                name,
                forward_to,
                enabled,
                ring_timeout,
                failover_to,
                pass_caller_id
            FROM rcf_numbers
            WHERE customer_id = $1
            ORDER BY did
        """, user["customer_id"])
        return [dict(r) for r in rows]

    # -- 9. API DIDs (product-specific) ---------------------------------------
    async def fetch_api_dids(user_future):
        user = await user_future
        if not user:
            return []
        rows = await db.fetch_all("""
            SELECT
                id,
                did,
                voice_url,
                fallback_url,
                voice_method,
                enabled
            FROM api_dids
            WHERE customer_id = $1
            ORDER BY did
        """, user["customer_id"])
        return [dict(r) for r in rows]

    # -- 10. SIP Trunks (product-specific) ------------------------------------
    async def fetch_sip_trunks(user_future):
        user = await user_future
        if not user:
            return []
        rows = await db.fetch_all("""
            SELECT
                t.id,
                t.trunk_name,
                t.max_channels,
                t.cps_limit,
                t.auth_type,
                t.tech_prefix,
                t.enabled,
                (SELECT COUNT(*) FROM trunk_dids td WHERE td.trunk_id = t.id)
                    AS did_count,
                COALESCE(
                    (SELECT jsonb_agg(jsonb_build_object(
                        'ip', host(a.ip_address),
                        'description', a.description
                    ))
                    FROM trunk_auth_ips a WHERE a.trunk_id = t.id),
                    '[]'::jsonb
                ) AS auth_ips
            FROM sip_trunks t
            WHERE t.customer_id = $1
            ORDER BY t.id
        """, user["customer_id"])
        results = []
        for r in rows:
            d = dict(r)
            # Parse auth_ips from jsonb if it came back as a string
            if isinstance(d["auth_ips"], str):
                d["auth_ips"] = orjson.loads(d["auth_ips"])
            results.append(d)
        return results

    # -- Run independent queries in parallel ----------------------------------
    # Extension is fetched first since voicemail and calls depend on it.
    # User is fetched first since product queries depend on customer_id.
    # We use an asyncio.Event-like pattern with a shared future.
    ext_task = asyncio.ensure_future(fetch_extension())
    user_task = asyncio.ensure_future(fetch_user())

    (
        user_row, _, presence_row, voicemail_data, chat_data,
        recent_calls, devices, rcf_rows, api_did_rows, trunk_rows,
    ) = await asyncio.gather(
        user_task,                      # also awaited here to propagate exceptions
        ext_task,                       # also awaited here to propagate exceptions
        fetch_presence(),
        fetch_voicemail(ext_task),
        fetch_chat(),
        fetch_recent_calls(ext_task),
        fetch_devices(),
        fetch_rcf_numbers(user_task),
        fetch_api_dids(user_task),
        fetch_sip_trunks(user_task),
    )

    # -- Validate the user exists ---------------------------------------------
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    ext_row = ext_task.result()

    # -- Assemble response ----------------------------------------------------
    return {
        "user": {
            "id": user_row["id"],
            "name": user_row["name"],
            "email": user_row["email"],
            "role": user_row["role"],
            "customer_id": user_row["customer_id"],
            "customer_name": user_row["customer_name"],
            "account_type": user_row["account_type"],
            "ucaas_enabled": user_row["ucaas_enabled"],
            "status": user_row["status"],
            "created_at": user_row["created_at"],
            "last_login": user_row["last_login"],
        },
        "extension": {
            "id": ext_row["id"],
            "extension": ext_row["extension"],
            "assigned_did": ext_row["assigned_did"],
            "display_name": ext_row["display_name"],
            "voicemail_enabled": ext_row["voicemail_enabled"],
            "dnd": ext_row["dnd"],
            "forward_on_busy": ext_row["forward_on_busy"],
            "forward_on_no_answer": ext_row["forward_on_no_answer"],
            "forward_timeout": ext_row["forward_timeout"],
            "status": ext_row["status"],
        } if ext_row else None,
        "presence": {
            "status": presence_row["status"],
            "status_message": presence_row["status_message"],
            "updated_at": presence_row["updated_at"],
        } if presence_row else None,
        "voicemail": voicemail_data,
        "chat": chat_data,
        "recent_calls": recent_calls,
        "devices": devices,
        "products": {
            "rcf": rcf_rows,
            "api_dids": api_did_rows,
            "trunks": trunk_rows,
        },
    }
