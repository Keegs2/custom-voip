"""SIP Trunk management endpoints.

Supports call path packages for managing concurrent call capacity per trunk.
CPS (call setup rate) is managed separately via cps_tiers.

Multi-tenant contract (mirrors routers/number_inventory.py):
  - Reads are tenant-scoped: non-admins (customer_filter not None) only ever see
    their own customer's trunks; admins (customer_filter None) are unrestricted.
  - Cross-tenant / missing resources return 404 (never 403) so existence is not
    leaked across tenants.
  - Provisioning / billing-affecting writes (create, capacity/CPS/enabled update,
    delete, call-path assignment, DID assignment/removal) are admin-only
    (require_admin).
  - Auth-IP management (add/remove IPs) is documented customer self-service, so
    trunk OWNERS (and admins) may do it, scoped to their own trunk.
"""
import logging
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, field_validator
from typing import Optional, List
from db import database as db
from db import redis_client as cache
from auth.dependencies import get_customer_filter, get_support_read_filter, require_admin
from utils import phone

logger = logging.getLogger(__name__)

router = APIRouter()


async def _get_owned_trunk(trunk_id: int, customer_filter: int | None) -> dict:
    """Fetch a trunk enforcing tenant isolation via one indexed PK lookup.

    Returns 404 if the trunk does not exist OR belongs to another customer
    (do NOT leak existence cross-tenant with a 403). Admins (customer_filter is
    None) bypass the ownership check. Used to gate every by-id sub-resource
    (detail / ips / dids / stats / call-paths) by parent-trunk ownership.
    """
    row = await db.fetch_one(
        "SELECT id, customer_id FROM sip_trunks WHERE id = $1",
        trunk_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Trunk not found")
    if customer_filter is not None and row["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="Trunk not found")
    return dict(row)


class TrunkCreate(BaseModel):
    customer_id: int
    trunk_name: str
    # Capacity is resolved server-side. Send EITHER cps_tier_id (a trunk-type
    # cps_tiers row: cps_limit + bundled call_paths -> max_channels), OR a custom
    # config (both cps_limit AND max_channels). No misleading defaults — a bad
    # default silently gives new trunks stale capacity that never reflects the
    # customer's purchased tier.
    cps_tier_id: Optional[int] = None
    max_channels: Optional[int] = None
    cps_limit: Optional[int] = None
    auth_type: str = "ip"  # ip, credential, both
    tech_prefix: Optional[str] = None
    # Optional auth IPs to whitelist atomically with the create (validated via the
    # same ::inet cast add_trunk_ip uses; a bad IP rolls back the whole create).
    auth_ips: Optional[List[str]] = None


class TrunkUpdate(BaseModel):
    trunk_name: Optional[str] = None
    max_channels: Optional[int] = None
    cps_limit: Optional[int] = None
    enabled: Optional[bool] = None


class TrunkIP(BaseModel):
    ip_address: str
    description: Optional[str] = None


class TrunkDID(BaseModel):
    did: str

    @field_validator("did")
    @classmethod
    def validate_did(cls, v: str) -> str:
        """Store trunk DIDs as canonical +E.164 (BUG-1 fix).

        A trunk DID is an inbound number the platform OWNS, so it must be stored in
        the exact same canonical form as rcf_numbers.did / api_dids.did. Previously
        the raw string was inserted verbatim; a non-canonical value (e.g. bare
        '6174544217') never matches the number_routing view's `WHERE did = $1`
        point lookup, making the DID invisible to on-net routing. Normalizing here
        (shared utils.phone algorithm) closes that gap at the write path.
        """
        return phone.normalize_e164(v)


class CallPathAssign(BaseModel):
    package_id: int


@router.get("")
async def list_trunks(
    customer_id: Optional[int] = None,
    enabled: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0,
    customer_filter: int | None = Depends(get_support_read_filter),
):
    """List SIP trunks with optional filters.

    Tenants are scoped to their own customer (the caller's customer_id wins,
    the `customer_id` query param is ignored for them); admins and support may
    filter by any `customer_id` or see all. This list carries no secrets (only
    an ip COUNT, never the auth IPs themselves); by-id sub-resources stay
    tenant-scoped via get_customer_filter.
    """
    query = """
        SELECT t.id, t.trunk_name, t.customer_id, t.max_channels, t.cps_limit,
               t.auth_type, t.tech_prefix, t.enabled, t.created_at,
               c.name as customer_name,
               cpp.name as package_name, cpp.call_paths,
               (SELECT COUNT(*) FROM trunk_auth_ips WHERE trunk_id = t.id) as ip_count,
               (SELECT COUNT(*) FROM trunk_dids WHERE trunk_id = t.id) as did_count
        FROM sip_trunks t
        JOIN customers c ON t.customer_id = c.id
        LEFT JOIN call_path_packages cpp ON t.call_path_package_id = cpp.id
        WHERE 1=1
    """
    values = []
    idx = 1

    # Enforce tenant scoping for non-admins; admins may optionally filter by customer_id.
    if customer_filter is not None:
        query += f" AND t.customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1
    elif customer_id is not None:
        query += f" AND t.customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if enabled is not None:
        query += f" AND t.enabled = ${idx}"
        values.append(enabled)
        idx += 1

    query += f" ORDER BY t.created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    results = await db.fetch_all(query, *values)
    return [dict(r) for r in results]


@router.post("")
async def create_trunk(trunk: TrunkCreate, admin: dict = Depends(require_admin)):
    """Create a new SIP trunk. Admin-only: provisioning / billing-affecting.

    Capacity comes from the customer's purchased tier (send `cps_tier_id`, a
    trunk-type `cps_tiers` row) or a custom config (send both `cps_limit` and
    `max_channels`) — never a hardcoded default. Optionally whitelist `auth_ips`
    at creation: the trunk row and its auth-IP rows are inserted in ONE
    transaction, so a bad IP rolls back the whole create.
    """
    # Verify customer
    customer = await db.fetch_one(
        "SELECT id, status FROM customers WHERE id = $1",
        trunk.customer_id
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    # --- Resolve capacity (cps_limit + max_channels) ------------------------
    if trunk.cps_tier_id is not None:
        # Tier-driven: CPS + bundled call paths come from the cps_tiers row.
        tier = await db.fetch_one(
            "SELECT cps_limit, call_paths FROM cps_tiers WHERE id = $1::int AND tier_type = 'trunk'",
            trunk.cps_tier_id
        )
        if not tier:
            raise HTTPException(
                status_code=404,
                detail="Trunk tier not found (no active cps_tiers row of tier_type='trunk' with that id)",
            )
        cps_limit = tier["cps_limit"]
        max_channels = tier["call_paths"]
        if max_channels is None:
            # Defensive: reprice migration 28 (call_paths column populated) not yet
            # applied on this DB. Fall back to an explicit request max_channels, else
            # fail loudly rather than provisioning a 0/NULL-capacity trunk.
            if trunk.max_channels is not None:
                max_channels = trunk.max_channels
            else:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Trunk tier has no bundled call paths — apply the tier "
                        "reprice migration (28_tiers_reprice.sql) or provide "
                        "max_channels / a custom config (cps_limit + max_channels)."
                    ),
                )
    else:
        # Custom config: both dimensions are required (no defaults).
        if trunk.cps_limit is None or trunk.max_channels is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Provide either cps_tier_id, or a custom config with BOTH "
                    "cps_limit and max_channels."
                ),
            )
        cps_limit = trunk.cps_limit
        max_channels = trunk.max_channels

    if cps_limit is None or cps_limit <= 0:
        raise HTTPException(status_code=422, detail="cps_limit must be greater than 0")
    if max_channels is None or max_channels <= 0:
        raise HTTPException(status_code=422, detail="max_channels must be greater than 0")

    # --- Normalize auth IPs (dedupe, preserve order) ------------------------
    # Validation is deferred to the ::inet cast at INSERT time — the exact same
    # mechanism add_trunk_ip relies on — so a malformed IP/CIDR aborts the
    # transaction and rolls back the trunk row too (no half-created trunk).
    auth_ips: List[str] = []
    if trunk.auth_ips:
        seen = set()
        for ip in trunk.auth_ips:
            if ip in seen:
                continue
            seen.add(ip)
            auth_ips.append(ip)

    # --- Create trunk + auth IPs in a SINGLE transaction --------------------
    pool = await db.get_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                result = await conn.fetchrow(
                    """
                    INSERT INTO sip_trunks (customer_id, trunk_name, max_channels, cps_limit, auth_type, tech_prefix)
                    VALUES ($1::int, $2::text, $3::int, $4::int, $5::text, $6::text)
                    RETURNING id, trunk_name, max_channels, cps_limit, enabled, created_at
                    """,
                    trunk.customer_id, trunk.trunk_name, max_channels,
                    cps_limit, trunk.auth_type, trunk.tech_prefix
                )
                trunk_id = result["id"]
                for ip in auth_ips:
                    await conn.execute(
                        """
                        INSERT INTO trunk_auth_ips (trunk_id, ip_address)
                        VALUES ($1::int, $2::inet)
                        """,
                        trunk_id, ip
                    )
    except HTTPException:
        raise
    except Exception as e:
        # A bad IP/CIDR (::inet cast failure) or unique violation rolled the whole
        # create back — surface a clear 422 instead of a raw 500.
        raise HTTPException(
            status_code=422,
            detail=f"Trunk not created — invalid or duplicate auth IP: {e}",
        )

    # Invalidate the trunk_ip:{ip} cache for every inserted IP so FreeSWITCH/
    # Kamailio pick up the new auth entries on the next call (same call add_trunk_ip
    # uses on delete). Post-commit: cache misses are self-healing, so failures here
    # must not fail an already-committed create.
    for ip in auth_ips:
        try:
            await cache.invalidate_trunk_cache(ip)
        except Exception as e:
            logger.warning(f"trunk_ip cache invalidation failed for {ip}: {e}")

    out = dict(result)
    out["auth_ip_count"] = len(auth_ips)
    return out


# Call Path Packages

@router.get("/call-paths")
async def list_call_path_packages():
    """List all available call path packages.

    Returns active packages sorted by sort_order for display in pricing/selection UI.
    """
    results = await db.fetch_all(
        "SELECT * FROM call_path_packages WHERE is_active = true ORDER BY sort_order"
    )
    return [dict(r) for r in results]


@router.get("/{trunk_id}")
async def get_trunk(
    trunk_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get trunk by ID with call path package info (tenant-scoped)."""
    # Ownership gate first (404 cross-tenant), then enrich with the full row.
    await _get_owned_trunk(trunk_id, customer_filter)
    result = await db.fetch_one(
        """
        SELECT t.*, c.name as customer_name,
               cpp.name as package_name, cpp.call_paths,
               (SELECT COUNT(*) FROM trunk_auth_ips WHERE trunk_id = t.id) as ip_count,
               (SELECT COUNT(*) FROM trunk_dids WHERE trunk_id = t.id) as did_count
        FROM sip_trunks t
        JOIN customers c ON t.customer_id = c.id
        LEFT JOIN call_path_packages cpp ON t.call_path_package_id = cpp.id
        WHERE t.id = $1
        """,
        trunk_id
    )
    if not result:
        raise HTTPException(status_code=404, detail="Trunk not found")
    return dict(result)


@router.put("/{trunk_id}")
async def update_trunk(trunk_id: int, trunk: TrunkUpdate, admin: dict = Depends(require_admin)):
    """Update trunk settings (capacity/CPS/enabled). Admin-only: billing-affecting."""
    updates = []
    values = []
    idx = 1

    for field, value in trunk.model_dump(exclude_none=True).items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    values.append(trunk_id)
    query = f"""
        UPDATE sip_trunks SET {', '.join(updates)}
        WHERE id = ${idx}
        RETURNING id, trunk_name, max_channels, enabled
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="Trunk not found")
    return dict(result)


@router.put("/{trunk_id}/call-paths")
async def assign_call_path_package(
    trunk_id: int, body: CallPathAssign, admin: dict = Depends(require_admin)
):
    """Assign a call path package to a trunk. Admin-only: capacity/billing-affecting.

    Updates the trunk's call_path_package_id and sets max_channels to match
    the package's call_paths count.

    Args:
        trunk_id: The trunk to update
        body: Contains package_id to assign
    """
    # Verify trunk exists
    trunk = await db.fetch_one(
        "SELECT id FROM sip_trunks WHERE id = $1",
        trunk_id
    )
    if not trunk:
        raise HTTPException(status_code=404, detail="Trunk not found")

    # Look up the package
    package = await db.fetch_one(
        "SELECT id, name, call_paths FROM call_path_packages WHERE id = $1 AND is_active = true",
        body.package_id
    )
    if not package:
        raise HTTPException(status_code=404, detail="Call path package not found or inactive")

    # Update trunk with the package and set max_channels to match
    result = await db.fetch_one(
        """
        UPDATE sip_trunks
        SET call_path_package_id = $1, max_channels = $2
        WHERE id = $3
        RETURNING id, trunk_name, max_channels, call_path_package_id, enabled
        """,
        body.package_id, package["call_paths"], trunk_id
    )

    return {
        **dict(result),
        "package_name": package["name"],
        "call_paths": package["call_paths"]
    }


# Trunk IPs

@router.post("/{trunk_id}/ips")
async def add_trunk_ip(
    trunk_id: int, ip: TrunkIP, customer_filter: int | None = Depends(get_customer_filter)
):
    """Add an authorized IP to a trunk. Customer self-service: trunk OWNERS (and
    admins) may manage their own trunk's auth IPs; ownership-gated (404 cross-tenant).
    """
    # Ownership gate also verifies the trunk exists (404 if missing/cross-tenant).
    await _get_owned_trunk(trunk_id, customer_filter)

    try:
        result = await db.fetch_one(
            """
            INSERT INTO trunk_auth_ips (trunk_id, ip_address, description)
            VALUES ($1, $2::inet, $3)
            RETURNING id, ip_address::text, description
            """,
            trunk_id, ip.ip_address, ip.description
        )
        return dict(result)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="IP already exists for this trunk")
        raise


@router.get("/{trunk_id}/ips")
async def list_trunk_ips(
    trunk_id: int, customer_filter: int | None = Depends(get_customer_filter)
):
    """List all IPs for a trunk (ownership-gated read)."""
    await _get_owned_trunk(trunk_id, customer_filter)
    results = await db.fetch_all(
        "SELECT id, ip_address::text, description FROM trunk_auth_ips WHERE trunk_id = $1",
        trunk_id
    )
    return [dict(r) for r in results]


@router.delete("/{trunk_id}/ips/{ip_id}")
async def delete_trunk_ip(
    trunk_id: int, ip_id: int, customer_filter: int | None = Depends(get_customer_filter)
):
    """Remove an IP from a trunk. Customer self-service: trunk OWNERS (and admins)
    may manage their own trunk's auth IPs; ownership-gated (404 cross-tenant).
    """
    await _get_owned_trunk(trunk_id, customer_filter)
    # Get IP before delete for cache invalidation
    ip_row = await db.fetch_one(
        "SELECT ip_address::text as ip FROM trunk_auth_ips WHERE id = $1 AND trunk_id = $2",
        ip_id, trunk_id
    )

    result = await db.execute(
        "DELETE FROM trunk_auth_ips WHERE id = $1 AND trunk_id = $2",
        ip_id, trunk_id
    )

    if ip_row:
        await cache.invalidate_trunk_cache(ip_row["ip"])

    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="IP not found")
    return {"status": "deleted"}


# Trunk DIDs

@router.post("/{trunk_id}/dids")
async def add_trunk_did(trunk_id: int, did: TrunkDID, admin: dict = Depends(require_admin)):
    """Assign a DID to a trunk. Admin-only: provisioning."""
    trunk = await db.fetch_one("SELECT id FROM sip_trunks WHERE id = $1", trunk_id)
    if not trunk:
        raise HTTPException(status_code=404, detail="Trunk not found")

    try:
        result = await db.fetch_one(
            """
            INSERT INTO trunk_dids (trunk_id, did)
            VALUES ($1, $2)
            RETURNING id, did
            """,
            trunk_id, did.did
        )
        return dict(result)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="DID already assigned")
        raise


@router.get("/{trunk_id}/dids")
async def list_trunk_dids(
    trunk_id: int, customer_filter: int | None = Depends(get_customer_filter)
):
    """List all DIDs for a trunk (ownership-gated read)."""
    await _get_owned_trunk(trunk_id, customer_filter)
    results = await db.fetch_all(
        "SELECT id, did FROM trunk_dids WHERE trunk_id = $1",
        trunk_id
    )
    return [dict(r) for r in results]


@router.get("/{trunk_id}/stats")
async def get_trunk_stats(
    trunk_id: int, customer_filter: int | None = Depends(get_customer_filter)
):
    """Get real-time stats for a trunk (ownership-gated read)."""
    from services.esl_client import _send_esl_command

    # Get trunk info; fold the tenant predicate into the existing lookup so a
    # non-owner gets 404 (no cross-tenant leak) without an extra round-trip.
    trunk = await db.fetch_one(
        """
        SELECT id, max_channels, cps_limit FROM sip_trunks
        WHERE id = $1 AND ($2::int IS NULL OR customer_id = $2)
        """,
        trunk_id, customer_filter
    )
    if not trunk:
        raise HTTPException(status_code=404, detail="Trunk not found")

    # Get current channel count from FreeSWITCH ESL
    # Count channels where trunk_id matches (set by Lua scripts)
    current_channels = 0
    try:
        response = await _send_esl_command("show channels as json")
        if response:
            import json
            # Parse the JSON from ESL response (skip headers)
            json_start = response.find("{")
            if json_start >= 0:
                data = json.loads(response[json_start:])
                rows = data.get("rows", [])
                # Get trunk DIDs once for matching
                trunk_dids = await db.fetch_all(
                    "SELECT did FROM trunk_dids WHERE trunk_id = $1",
                    trunk_id
                )
                did_list = [d["did"].replace("+", "") for d in (trunk_dids or [])]

                seen_calls = set()
                for row in rows:
                    if str(row.get("callstate", "")) in ("HANGUP", "DOWN"):
                        continue
                    call_uuid = row.get("call_uuid", row.get("uuid", ""))
                    if call_uuid in seen_calls:
                        continue
                    # Check all fields that might contain the trunk DID
                    fields_to_check = [
                        row.get("name", ""),
                        row.get("cid_name", ""),
                        row.get("cid_num", ""),
                        row.get("initial_cid_name", ""),
                        row.get("initial_cid_num", ""),
                        row.get("dest", ""),
                        row.get("initial_dest", ""),
                    ]
                    for field in fields_to_check:
                        clean = field.replace("+", "")
                        if any(d in clean for d in did_list):
                            current_channels += 1
                            seen_calls.add(call_uuid)
                            break
    except Exception as e:
        logger.warning(f"ESL channel count failed: {e}")

    # Get recent CDR stats
    stats = await db.fetch_one(
        """
        SELECT
            COUNT(*) as total_calls,
            COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
            AVG(duration_ms) FILTER (WHERE answer_time IS NOT NULL) as avg_duration_ms,
            SUM(total_cost) as total_cost
        FROM cdrs
        WHERE trunk_id = $1 AND start_time > NOW() - INTERVAL '1 hour'
        """,
        trunk_id
    )

    return {
        "trunk_id": trunk_id,
        "current_channels": current_channels or 0,
        "max_channels": trunk["max_channels"],
        "channel_utilization": f"{((current_channels or 0) / trunk['max_channels'] * 100):.1f}%",
        "cps_limit": trunk["cps_limit"],
        "last_hour": {
            "total_calls": stats["total_calls"] or 0,
            "answered_calls": stats["answered_calls"] or 0,
            "asr": f"{(stats['answered_calls'] or 0) / max(stats['total_calls'] or 1, 1) * 100:.1f}%",
            "avg_duration_sec": (stats["avg_duration_ms"] or 0) / 1000,
            "total_cost": float(stats["total_cost"] or 0)
        }
    }
