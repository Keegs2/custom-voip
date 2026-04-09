"""SIP Trunk management endpoints.

Supports call path packages for managing concurrent call capacity per trunk.
CPS (call setup rate) is managed separately via cps_tiers.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from db import database as db
from db import redis_client as cache

router = APIRouter()


class TrunkCreate(BaseModel):
    customer_id: int
    trunk_name: str
    max_channels: int
    cps_limit: int = 5
    auth_type: str = "ip"  # ip, credential, both
    tech_prefix: Optional[str] = None


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


class CallPathAssign(BaseModel):
    package_id: int


@router.get("")
async def list_trunks(
    customer_id: Optional[int] = None,
    enabled: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0
):
    """List all SIP trunks with optional filters."""
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

    if customer_id is not None:
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
async def create_trunk(trunk: TrunkCreate):
    """Create a new SIP trunk."""
    # Verify customer
    customer = await db.fetch_one(
        "SELECT id, status FROM customers WHERE id = $1",
        trunk.customer_id
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    result = await db.fetch_one(
        """
        INSERT INTO sip_trunks (customer_id, trunk_name, max_channels, cps_limit, auth_type, tech_prefix)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, trunk_name, max_channels, cps_limit, enabled, created_at
        """,
        trunk.customer_id, trunk.trunk_name, trunk.max_channels,
        trunk.cps_limit, trunk.auth_type, trunk.tech_prefix
    )
    return dict(result)


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
async def get_trunk(trunk_id: int):
    """Get trunk by ID with call path package info."""
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
async def update_trunk(trunk_id: int, trunk: TrunkUpdate):
    """Update trunk settings."""
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
async def assign_call_path_package(trunk_id: int, body: CallPathAssign):
    """Assign a call path package to a trunk.

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
async def add_trunk_ip(trunk_id: int, ip: TrunkIP):
    """Add an authorized IP to a trunk."""
    # Verify trunk exists
    trunk = await db.fetch_one("SELECT id FROM sip_trunks WHERE id = $1", trunk_id)
    if not trunk:
        raise HTTPException(status_code=404, detail="Trunk not found")

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
async def list_trunk_ips(trunk_id: int):
    """List all IPs for a trunk."""
    results = await db.fetch_all(
        "SELECT id, ip_address::text, description FROM trunk_auth_ips WHERE trunk_id = $1",
        trunk_id
    )
    return [dict(r) for r in results]


@router.delete("/{trunk_id}/ips/{ip_id}")
async def delete_trunk_ip(trunk_id: int, ip_id: int):
    """Remove an IP from a trunk."""
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
async def add_trunk_did(trunk_id: int, did: TrunkDID):
    """Assign a DID to a trunk."""
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
async def list_trunk_dids(trunk_id: int):
    """List all DIDs for a trunk."""
    results = await db.fetch_all(
        "SELECT id, did FROM trunk_dids WHERE trunk_id = $1",
        trunk_id
    )
    return [dict(r) for r in results]


@router.get("/{trunk_id}/stats")
async def get_trunk_stats(trunk_id: int):
    """Get real-time stats for a trunk."""
    from services.esl_client import _send_esl_command

    # Get trunk info
    trunk = await db.fetch_one(
        "SELECT id, max_channels, cps_limit FROM sip_trunks WHERE id = $1",
        trunk_id
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
                for row in rows:
                    # Check if this channel belongs to this trunk
                    # trunk_id is set as a channel variable by the Lua scripts
                    if str(row.get("callstate", "")) not in ("HANGUP", "DOWN"):
                        # Check presence_data or accountcode for trunk association
                        cid_name = row.get("cid_name", "")
                        dest = row.get("dest", "")
                        # Get trunk DIDs for this trunk
                        trunk_dids = await db.fetch_all(
                            "SELECT did FROM trunk_dids WHERE trunk_id = $1",
                            trunk_id
                        )
                        did_list = [d["did"].replace("+", "") for d in (trunk_dids or [])]
                        # Match if destination or caller matches a trunk DID
                        clean_dest = dest.replace("+", "")
                        if clean_dest in did_list or any(d in dest for d in did_list):
                            current_channels += 1
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
