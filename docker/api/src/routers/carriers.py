"""Carrier gateway management endpoints (admin only)."""
import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator

from auth.dependencies import require_admin
from db import database as db

router = APIRouter()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CarrierCreate(BaseModel):
    gateway_name: str
    display_name: str
    description: Optional[str] = None
    sip_proxy: str
    port: int = 5060
    transport: str = "UDP"
    auth_type: str = "ip"
    username: Optional[str] = None
    password: Optional[str] = None
    codec_prefs: List[str] = ["PCMU", "PCMA"]
    max_channels: Optional[int] = None
    cps_limit: Optional[int] = None
    product_types: List[str] = []
    is_primary: bool = False
    is_failover: bool = False
    register: bool = False
    caller_id_in_from: bool = True
    enabled: bool = True

    @field_validator("transport")
    @classmethod
    def validate_transport(cls, v: str) -> str:
        v = v.upper()
        if v not in ("UDP", "TCP", "TLS"):
            raise ValueError("transport must be UDP, TCP, or TLS")
        return v

    @field_validator("auth_type")
    @classmethod
    def validate_auth_type(cls, v: str) -> str:
        v = v.lower()
        if v not in ("ip", "credentials", "none"):
            raise ValueError("auth_type must be ip, credentials, or none")
        return v

    @field_validator("gateway_name")
    @classmethod
    def validate_gateway_name(cls, v: str) -> str:
        if not v or len(v) > 50:
            raise ValueError("gateway_name must be 1-50 characters")
        return v


class CarrierUpdate(BaseModel):
    display_name: Optional[str] = None
    description: Optional[str] = None
    sip_proxy: Optional[str] = None
    port: Optional[int] = None
    transport: Optional[str] = None
    auth_type: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    codec_prefs: Optional[List[str]] = None
    max_channels: Optional[int] = None
    cps_limit: Optional[int] = None
    product_types: Optional[List[str]] = None
    is_primary: Optional[bool] = None
    is_failover: Optional[bool] = None
    register: Optional[bool] = None
    caller_id_in_from: Optional[bool] = None
    enabled: Optional[bool] = None

    @field_validator("transport")
    @classmethod
    def validate_transport(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.upper()
            if v not in ("UDP", "TCP", "TLS"):
                raise ValueError("transport must be UDP, TCP, or TLS")
        return v

    @field_validator("auth_type")
    @classmethod
    def validate_auth_type(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.lower()
            if v not in ("ip", "credentials", "none"):
                raise ValueError("auth_type must be ip, credentials, or none")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _row_to_dict(row) -> dict:
    """Convert a carrier_gateways row to the frontend-expected shape."""
    d = dict(row)
    # DB stores transport as lowercase; frontend expects uppercase
    if d.get("transport"):
        d["transport"] = d["transport"].upper()
    # DB stores codec_prefs as a comma-separated string; frontend expects an array
    if isinstance(d.get("codec_prefs"), str):
        d["codec_prefs"] = [c.strip() for c in d["codec_prefs"].split(",") if c.strip()]
    # Ensure product_types is always a list
    if d.get("product_types") is None:
        d["product_types"] = []
    return d


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_carriers(admin: dict = Depends(require_admin)):
    """List all carrier gateways."""
    results = await db.fetch_all(
        """
        SELECT id, gateway_name, display_name, description, sip_proxy, port,
               transport, auth_type, username, password, codec_prefs,
               max_channels, cps_limit, product_types, is_primary, is_failover,
               register, caller_id_in_from, enabled, created_at, updated_at
        FROM carrier_gateways
        ORDER BY is_primary DESC, gateway_name
        """
    )
    return [_row_to_dict(r) for r in results]


@router.get("/{carrier_id}")
async def get_carrier(carrier_id: int, admin: dict = Depends(require_admin)):
    """Get a single carrier gateway by ID."""
    result = await db.fetch_one(
        """
        SELECT id, gateway_name, display_name, description, sip_proxy, port,
               transport, auth_type, username, password, codec_prefs,
               max_channels, cps_limit, product_types, is_primary, is_failover,
               register, caller_id_in_from, enabled, created_at, updated_at
        FROM carrier_gateways
        WHERE id = $1
        """,
        carrier_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Carrier gateway not found")
    return _row_to_dict(result)


@router.post("")
async def create_carrier(body: CarrierCreate, admin: dict = Depends(require_admin)):
    """Create a new carrier gateway."""
    # DB stores transport lowercase, codec_prefs as comma-separated string
    transport_db = body.transport.lower()
    codec_str = ",".join(body.codec_prefs) if body.codec_prefs else "PCMU,PCMA"

    try:
        result = await db.fetch_one(
            """
            INSERT INTO carrier_gateways
                (gateway_name, display_name, description, sip_proxy, port,
                 transport, auth_type, username, password, codec_prefs,
                 max_channels, cps_limit, product_types, is_primary, is_failover,
                 register, caller_id_in_from, enabled)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            RETURNING id, gateway_name, display_name, description, sip_proxy, port,
                      transport, auth_type, username, password, codec_prefs,
                      max_channels, cps_limit, product_types, is_primary, is_failover,
                      register, caller_id_in_from, enabled, created_at, updated_at
            """,
            body.gateway_name, body.display_name, body.description,
            body.sip_proxy, body.port, transport_db, body.auth_type,
            body.username, body.password, codec_str,
            body.max_channels, body.cps_limit, body.product_types,
            body.is_primary, body.is_failover, body.register,
            body.caller_id_in_from, body.enabled,
        )
        return _row_to_dict(result)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="Gateway name already exists")
        raise


@router.patch("/{carrier_id}")
async def update_carrier(carrier_id: int, body: CarrierUpdate, admin: dict = Depends(require_admin)):
    """Update a carrier gateway."""
    update_data = body.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Transform values for DB storage
    if "transport" in update_data:
        update_data["transport"] = update_data["transport"].lower()
    if "codec_prefs" in update_data:
        update_data["codec_prefs"] = ",".join(update_data["codec_prefs"])

    updates = []
    values = []
    idx = 1
    for field, value in update_data.items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    values.append(carrier_id)
    query = f"""
        UPDATE carrier_gateways
        SET {', '.join(updates)}, updated_at = NOW()
        WHERE id = ${idx}
        RETURNING id, gateway_name, display_name, description, sip_proxy, port,
                  transport, auth_type, username, password, codec_prefs,
                  max_channels, cps_limit, product_types, is_primary, is_failover,
                  register, caller_id_in_from, enabled, created_at, updated_at
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="Carrier gateway not found")
    return _row_to_dict(result)


@router.delete("/{carrier_id}")
async def delete_carrier(carrier_id: int, admin: dict = Depends(require_admin)):
    """Delete a carrier gateway."""
    result = await db.execute(
        "DELETE FROM carrier_gateways WHERE id = $1", carrier_id
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Carrier gateway not found")
    return {"status": "deleted", "id": carrier_id}


@router.post("/{carrier_id}/test")
async def test_carrier(carrier_id: int, admin: dict = Depends(require_admin)):
    """Test TCP connectivity to a carrier's SIP proxy.

    Opens a TCP connection to the carrier's sip_proxy:port with a 5-second
    timeout and reports reachability + latency.
    """
    row = await db.fetch_one(
        "SELECT id, gateway_name, sip_proxy, port FROM carrier_gateways WHERE id = $1",
        carrier_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Carrier gateway not found")

    host = row["sip_proxy"]
    port = row["port"] or 5060
    tested_at = datetime.now(timezone.utc).isoformat()

    try:
        start = time.perf_counter()
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=5.0,
        )
        latency_ms = round((time.perf_counter() - start) * 1000, 2)
        writer.close()
        await writer.wait_closed()

        return {
            "carrier_id": row["id"],
            "gateway_name": row["gateway_name"],
            "reachable": True,
            "latency_ms": latency_ms,
            "error": None,
            "tested_at": tested_at,
        }
    except asyncio.TimeoutError:
        return {
            "carrier_id": row["id"],
            "gateway_name": row["gateway_name"],
            "reachable": False,
            "latency_ms": None,
            "error": f"Connection timed out after 5s ({host}:{port})",
            "tested_at": tested_at,
        }
    except OSError as exc:
        return {
            "carrier_id": row["id"],
            "gateway_name": row["gateway_name"],
            "reachable": False,
            "latency_ms": None,
            "error": f"Connection failed: {exc}",
            "tested_at": tested_at,
        }
