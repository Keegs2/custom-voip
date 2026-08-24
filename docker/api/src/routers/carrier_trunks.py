"""Carrier trunk registry — admin CRUD over `carrier_trunks` (migration 40).

One row per carrier signaling IP (Bandwidth Dallas/LA, Sinch Denver/Chicago).
The Kamailio SBCs consume this table directly via sqlops as a DB-backed trust
fallback for unknown-source INVITEs:

    SELECT carrier, pop, cps_limit FROM carrier_trunks
    WHERE source_ip = '$si'::inet
      AND direction IN ('inbound','both') AND enabled = true

** CONTRACT: the column names carrier, pop, trunk_group, source_ip, test_tn,
direction, cps_limit, enabled are load-bearing for that SBC SQL — never rename
them here or in the migration. **

All endpoints are ADMIN-ONLY (require_admin): this is carrier infrastructure
config, operated through the TED admin tool over the revup-admin bridge
(admin JWT). Writes land on the East primary and replicate to the zone
replicas the SBCs read.

Endpoints (mounted at /v1/carrier-trunks and /carrier-trunks):
  * GET    ""            — list (filters: carrier, direction, enabled)
  * POST   ""            — create (409 on duplicate source_ip / carrier+pop)
  * GET    /{trunk_id}   — detail
  * PUT    /{trunk_id}   — partial update (carrier itself is immutable)
  * DELETE /{trunk_id}   — delete

House style: raw asyncpg via db helpers, explicit ::type casts on every bound
parameter (asyncpg + PgBouncer transaction pooling), plain dict returns.
source_ip is returned as bare text via host(source_ip) so responses never
carry ipaddress objects.
"""
import ipaddress
import logging
from typing import Literal, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator

from auth.dependencies import require_admin
from db import database as db

logger = logging.getLogger(__name__)

router = APIRouter()

# Columns returned by every endpoint. host(source_ip) renders the INET as bare
# text ('206.146.100.24') for clean JSON in any response class.
_RETURN_COLS = (
    "id, carrier, pop, trunk_group, host(source_ip) AS source_ip, test_tn, "
    "direction, cps_limit, enabled, notes, created_at, updated_at"
)

_DIRECTIONS = ("inbound", "outbound", "both")


# ---------------------------------------------------------------------------
# Validation helpers (shared by create + update models)
# ---------------------------------------------------------------------------

def _validate_ip(v: str) -> str:
    """Require a bare IPv4/IPv6 address (no CIDR — the SBC matches $si exactly)."""
    v = v.strip()
    try:
        return str(ipaddress.ip_address(v))
    except ValueError:
        raise ValueError("source_ip must be a bare IPv4/IPv6 address (no CIDR)")


def _validate_name(v: str, field: str, max_len: int) -> str:
    v = v.strip().lower()
    if not v or len(v) > max_len:
        raise ValueError(f"{field} must be 1-{max_len} characters")
    return v


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CarrierTrunkCreate(BaseModel):
    carrier: str
    pop: str
    trunk_group: Optional[str] = None
    source_ip: str
    test_tn: Optional[str] = None
    direction: Literal["inbound", "outbound", "both"] = "inbound"
    cps_limit: int = 100
    enabled: bool = True
    notes: Optional[str] = None

    @field_validator("carrier")
    @classmethod
    def validate_carrier(cls, v: str) -> str:
        return _validate_name(v, "carrier", 50)

    @field_validator("pop")
    @classmethod
    def validate_pop(cls, v: str) -> str:
        return _validate_name(v, "pop", 50)

    @field_validator("source_ip")
    @classmethod
    def validate_source_ip(cls, v: str) -> str:
        return _validate_ip(v)

    @field_validator("trunk_group")
    @classmethod
    def validate_trunk_group(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if len(v) > 100:
            raise ValueError("trunk_group must be at most 100 characters")
        return v or None

    @field_validator("test_tn")
    @classmethod
    def validate_test_tn(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if len(v) > 20:
            raise ValueError("test_tn must be at most 20 characters")
        return v or None

    @field_validator("cps_limit")
    @classmethod
    def validate_cps_limit(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("cps_limit must be > 0")
        return v


class CarrierTrunkUpdate(BaseModel):
    """Partial update. `carrier` is intentionally NOT updatable — a trunk row's
    carrier identity is fixed; re-homing an IP to another carrier is a
    delete + create (keeps the (carrier, pop) uniqueness story simple)."""
    pop: Optional[str] = None
    trunk_group: Optional[str] = None
    source_ip: Optional[str] = None
    test_tn: Optional[str] = None
    direction: Optional[Literal["inbound", "outbound", "both"]] = None
    cps_limit: Optional[int] = None
    enabled: Optional[bool] = None
    notes: Optional[str] = None

    @field_validator("pop")
    @classmethod
    def validate_pop(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return _validate_name(v, "pop", 50)

    @field_validator("source_ip")
    @classmethod
    def validate_source_ip(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return _validate_ip(v)

    @field_validator("trunk_group")
    @classmethod
    def validate_trunk_group(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and len(v.strip()) > 100:
            raise ValueError("trunk_group must be at most 100 characters")
        return v.strip() if v is not None else None

    @field_validator("test_tn")
    @classmethod
    def validate_test_tn(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and len(v.strip()) > 20:
            raise ValueError("test_tn must be at most 20 characters")
        return v.strip() if v is not None else None

    @field_validator("cps_limit")
    @classmethod
    def validate_cps_limit(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v <= 0:
            raise ValueError("cps_limit must be > 0")
        return v


# ---------------------------------------------------------------------------
# 409 mapping — one distinct detail per named UNIQUE constraint (migration 40).
# ---------------------------------------------------------------------------

def _conflict_409(exc: asyncpg.UniqueViolationError) -> HTTPException:
    constraint = exc.constraint_name or ""
    if "source_ip" in constraint:
        return HTTPException(status_code=409, detail="source_ip already exists")
    if "carrier_pop" in constraint:
        return HTTPException(
            status_code=409, detail="carrier + pop combination already exists")
    return HTTPException(status_code=409, detail="duplicate carrier trunk")


# ---------------------------------------------------------------------------
# Endpoints (all admin-only)
# ---------------------------------------------------------------------------

@router.get("")
async def list_carrier_trunks(
    carrier: Optional[str] = None,
    direction: Optional[str] = None,
    enabled: Optional[bool] = None,
    admin: dict = Depends(require_admin),
):
    """List carrier trunks with optional filters (carrier / direction / enabled)."""
    query = f"SELECT {_RETURN_COLS} FROM carrier_trunks WHERE 1=1"
    values: list = []
    idx = 1

    if carrier is not None:
        query += f" AND carrier = ${idx}::varchar"
        values.append(carrier.strip().lower())
        idx += 1
    if direction is not None:
        if direction not in _DIRECTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"direction must be one of {', '.join(_DIRECTIONS)}")
        query += f" AND direction = ${idx}::varchar"
        values.append(direction)
        idx += 1
    if enabled is not None:
        query += f" AND enabled = ${idx}::bool"
        values.append(enabled)
        idx += 1

    query += " ORDER BY carrier, pop"
    rows = await db.fetch_all(query, *values)
    return {"trunks": [dict(r) for r in rows], "count": len(rows)}


@router.post("")
async def create_carrier_trunk(
    body: CarrierTrunkCreate, admin: dict = Depends(require_admin),
):
    """Create a carrier trunk. 409 on duplicate source_ip or (carrier, pop)."""
    try:
        row = await db.fetch_one(
            f"""
            INSERT INTO carrier_trunks
                (carrier, pop, trunk_group, source_ip, test_tn,
                 direction, cps_limit, enabled, notes)
            VALUES ($1::varchar, $2::varchar, $3::varchar, $4::inet, $5::varchar,
                    $6::varchar, $7::int, $8::bool, $9::text)
            RETURNING {_RETURN_COLS}
            """,
            body.carrier, body.pop, body.trunk_group, body.source_ip,
            body.test_tn, body.direction, body.cps_limit, body.enabled,
            body.notes,
        )
    except asyncpg.UniqueViolationError as e:
        raise _conflict_409(e)

    logger.info(
        "carrier-trunks: created id=%s %s/%s ip=%s direction=%s by admin=%s",
        row["id"], body.carrier, body.pop, body.source_ip, body.direction,
        admin.get("email"),
    )
    return dict(row)


@router.get("/{trunk_id}")
async def get_carrier_trunk(trunk_id: int, admin: dict = Depends(require_admin)):
    """Get one carrier trunk by id."""
    row = await db.fetch_one(
        f"SELECT {_RETURN_COLS} FROM carrier_trunks WHERE id = $1::int",
        trunk_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Carrier trunk not found")
    return dict(row)


@router.put("/{trunk_id}")
async def update_carrier_trunk(
    trunk_id: int, body: CarrierTrunkUpdate, admin: dict = Depends(require_admin),
):
    """Partially update a carrier trunk (only the fields present in the body).

    exclude_unset (not exclude_none) so the nullable fields (trunk_group,
    test_tn, notes) can be explicitly cleared with null. 409 when the new
    source_ip or (carrier, pop) collides with another row.
    """
    update_data = body.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Explicit per-column casts (asyncpg + PgBouncer: no type inference).
    casts = {
        "pop": "varchar", "trunk_group": "varchar", "source_ip": "inet",
        "test_tn": "varchar", "direction": "varchar", "cps_limit": "int",
        "enabled": "bool", "notes": "text",
    }
    updates = []
    values: list = []
    idx = 1
    for field, value in update_data.items():
        updates.append(f"{field} = ${idx}::{casts[field]}")
        values.append(value)
        idx += 1

    values.append(trunk_id)
    query = f"""
        UPDATE carrier_trunks
        SET {', '.join(updates)}, updated_at = NOW()
        WHERE id = ${idx}::int
        RETURNING {_RETURN_COLS}
    """
    try:
        row = await db.fetch_one(query, *values)
    except asyncpg.UniqueViolationError as e:
        raise _conflict_409(e)

    if not row:
        raise HTTPException(status_code=404, detail="Carrier trunk not found")
    logger.info(
        "carrier-trunks: updated id=%s fields=%s by admin=%s",
        trunk_id, ",".join(update_data), admin.get("email"),
    )
    return dict(row)


@router.delete("/{trunk_id}")
async def delete_carrier_trunk(trunk_id: int, admin: dict = Depends(require_admin)):
    """Delete a carrier trunk."""
    result = await db.execute(
        "DELETE FROM carrier_trunks WHERE id = $1::int", trunk_id
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Carrier trunk not found")
    logger.info("carrier-trunks: deleted id=%s by admin=%s",
                trunk_id, admin.get("email"))
    return {"status": "deleted", "id": trunk_id}
