"""Carrier gateway management endpoints.

Manages upstream carrier/trunk gateway configurations so admins can
configure carrier connections from the UI instead of editing XML files.
"""
import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from db import database as db

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Table bootstrap
# ---------------------------------------------------------------------------

_table_created = False


async def _ensure_table():
    """Check the carrier_gateways table exists (created by SQL init scripts).
    Seed default gateways if the table is empty."""
    global _table_created
    if _table_created:
        return

    # Table is created by 08_carrier_gateways.sql init script.
    # Just verify it exists — don't try to CREATE (api user lacks permission).
    try:
        await db.fetch_one("SELECT 1 FROM carrier_gateways LIMIT 1")
    except Exception:
        # Table doesn't exist — this means the DB wasn't initialized properly
        logger.error("carrier_gateways table does not exist. Run DB init scripts.")
        _table_created = True
        return

    _table_created = True


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CarrierCreate(BaseModel):
    gateway_name: str
    display_name: str
    description: Optional[str] = None
    sip_proxy: str
    port: int = 5060
    transport: str = "udp"
    auth_type: str = "ip"
    username: Optional[str] = None
    password: Optional[str] = None
    register: bool = False
    caller_id_in_from: bool = True
    codec_prefs: str = "PCMU,PCMA"
    max_channels: Optional[int] = None
    cps_limit: Optional[int] = None
    product_types: List[str] = []
    is_primary: bool = False
    is_failover: bool = False
    enabled: bool = True

    @field_validator("transport")
    @classmethod
    def validate_transport(cls, v: str) -> str:
        if v not in ("udp", "tcp", "tls"):
            raise ValueError("transport must be one of: udp, tcp, tls")
        return v

    @field_validator("auth_type")
    @classmethod
    def validate_auth_type(cls, v: str) -> str:
        if v not in ("ip", "credential", "both"):
            raise ValueError("auth_type must be one of: ip, credential, both")
        return v


class CarrierUpdate(BaseModel):
    gateway_name: Optional[str] = None
    display_name: Optional[str] = None
    description: Optional[str] = None
    sip_proxy: Optional[str] = None
    port: Optional[int] = None
    transport: Optional[str] = None
    auth_type: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    register: Optional[bool] = None
    caller_id_in_from: Optional[bool] = None
    codec_prefs: Optional[str] = None
    max_channels: Optional[int] = None
    cps_limit: Optional[int] = None
    product_types: Optional[List[str]] = None
    is_primary: Optional[bool] = None
    is_failover: Optional[bool] = None
    enabled: Optional[bool] = None

    @field_validator("transport")
    @classmethod
    def validate_transport(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("udp", "tcp", "tls"):
            raise ValueError("transport must be one of: udp, tcp, tls")
        return v

    @field_validator("auth_type")
    @classmethod
    def validate_auth_type(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("ip", "credential", "both"):
            raise ValueError("auth_type must be one of: ip, credential, both")
        return v


# ---------------------------------------------------------------------------
# Connectivity test helper
# ---------------------------------------------------------------------------

async def _test_carrier_connectivity(host: str, port: int) -> tuple[bool, float]:
    """Attempt a TCP connection to the carrier's SIP proxy and measure latency."""
    start = time.perf_counter()
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=5.0
        )
        latency = (time.perf_counter() - start) * 1000
        writer.close()
        await writer.wait_closed()
        return True, round(latency, 2)
    except Exception:
        return False, 0


# ---------------------------------------------------------------------------
# SELECT columns (reused across endpoints)
# ---------------------------------------------------------------------------

_SELECT_COLS = """
    id, gateway_name, display_name, description, sip_proxy, port, transport,
    auth_type, username, password, register, caller_id_in_from, codec_prefs,
    max_channels, cps_limit, product_types, is_primary, is_failover, enabled,
    created_at, updated_at
"""


# ---------------------------------------------------------------------------
# CRUD endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_carriers():
    """List all carrier gateways."""
    await _ensure_table()
    results = await db.fetch_all(
        f"SELECT {_SELECT_COLS} FROM carrier_gateways ORDER BY is_primary DESC, gateway_name"
    )
    return [dict(r) for r in results]


@router.post("", status_code=201)
async def create_carrier(carrier: CarrierCreate):
    """Create a new carrier gateway."""
    await _ensure_table()

    try:
        result = await db.fetch_one(
            f"""
            INSERT INTO carrier_gateways
                (gateway_name, display_name, description, sip_proxy, port, transport,
                 auth_type, username, password, register, caller_id_in_from, codec_prefs,
                 max_channels, cps_limit, product_types, is_primary, is_failover, enabled)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            RETURNING {_SELECT_COLS}
            """,
            carrier.gateway_name, carrier.display_name, carrier.description,
            carrier.sip_proxy, carrier.port, carrier.transport,
            carrier.auth_type, carrier.username, carrier.password,
            carrier.register, carrier.caller_id_in_from, carrier.codec_prefs,
            carrier.max_channels, carrier.cps_limit, carrier.product_types,
            carrier.is_primary, carrier.is_failover, carrier.enabled,
        )
        return dict(result)
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail=f"Gateway name '{carrier.gateway_name}' already exists",
            )
        raise


@router.get("/{carrier_id}")
async def get_carrier(carrier_id: int):
    """Get a single carrier gateway by ID."""
    await _ensure_table()

    result = await db.fetch_one(
        f"SELECT {_SELECT_COLS} FROM carrier_gateways WHERE id = $1",
        carrier_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Carrier gateway not found")
    return dict(result)


@router.put("/{carrier_id}")
async def update_carrier(carrier_id: int, carrier: CarrierUpdate):
    """Update a carrier gateway (partial update)."""
    await _ensure_table()

    data = carrier.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates = []
    values = []
    idx = 1

    for field, value in data.items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    updates.append("updated_at = NOW()")
    values.append(carrier_id)

    query = f"""
        UPDATE carrier_gateways SET {', '.join(updates)}
        WHERE id = ${idx}
        RETURNING {_SELECT_COLS}
    """

    try:
        result = await db.fetch_one(query, *values)
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail=f"Gateway name '{data.get('gateway_name')}' already exists",
            )
        raise

    if not result:
        raise HTTPException(status_code=404, detail="Carrier gateway not found")
    return dict(result)


@router.delete("/{carrier_id}")
async def delete_carrier(carrier_id: int):
    """Delete a carrier gateway."""
    await _ensure_table()

    result = await db.execute(
        "DELETE FROM carrier_gateways WHERE id = $1",
        carrier_id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Carrier gateway not found")

    return {"status": "deleted", "id": carrier_id}


# ---------------------------------------------------------------------------
# Connectivity test endpoint
# ---------------------------------------------------------------------------

@router.post("/{carrier_id}/test")
async def test_carrier(carrier_id: int):
    """Test carrier connectivity by attempting a TCP connection to its SIP proxy."""
    await _ensure_table()

    carrier = await db.fetch_one(
        "SELECT gateway_name, sip_proxy, port FROM carrier_gateways WHERE id = $1",
        carrier_id,
    )
    if not carrier:
        raise HTTPException(status_code=404, detail="Carrier gateway not found")

    reachable, latency_ms = await _test_carrier_connectivity(
        carrier["sip_proxy"], carrier["port"],
    )

    return {
        "gateway_name": carrier["gateway_name"],
        "reachable": reachable,
        "latency_ms": latency_ms,
        "tested_at": datetime.now(timezone.utc).isoformat(),
    }
