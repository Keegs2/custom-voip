"""RCF (Remote Call Forwarding) endpoints."""
import re
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator
from typing import Optional
from db import database as db
from db import redis_client as cache

router = APIRouter()
logger = logging.getLogger(__name__)

# E.164 pattern: + followed by 1-15 digits
E164_PATTERN = re.compile(r'^\+[1-9]\d{1,14}$')

# NANP 10-digit (e.g., 5087282017) or 11-digit with leading 1 (e.g., 15087282017)
NANP_PATTERN = re.compile(r'^1?[2-9]\d{9}$')

# Local extension pattern: 3-6 digits (typical PBX extensions like 1001, 1002, etc.)
LOCAL_EXTENSION_PATTERN = re.compile(r'^\d{3,6}$')


def validate_e164(phone: str) -> str:
    """Validate and normalize phone number to E.164 format (DIDs only).
    Accepts E.164 (+15087282017), 11-digit (15087282017), or 10-digit (5087282017).
    """
    if E164_PATTERN.match(phone):
        return phone
    if NANP_PATTERN.match(phone):
        digits = phone if phone.startswith('1') and len(phone) == 11 else '1' + phone
        return '+' + digits
    raise ValueError(
        f"Invalid phone number: '{phone}'. "
        "Accepted formats: +15087282017, 15087282017, or 5087282017"
    )


def validate_forward_destination(dest: str) -> str:
    """Validate forward-to destination: accepts E.164 or local extensions.

    For local Zoiper/FreeSWITCH testing, we need to support:
    - E.164 numbers: +15551234567 (PSTN destinations)
    - Local extensions: 1001, 1002, 1003 (3-6 digit PBX extensions)

    Args:
        dest: Destination number (E.164 or local extension)

    Returns:
        Validated destination string

    Raises:
        ValueError: If destination doesn't match any valid pattern
    """
    # Accept E.164 format
    if E164_PATTERN.match(dest):
        return dest

    # Accept NANP 10/11-digit and normalize to E.164
    if NANP_PATTERN.match(dest):
        digits = dest if dest.startswith('1') and len(dest) == 11 else '1' + dest
        return '+' + digits

    # Accept local extensions (3-6 digits, e.g., 1001, 1002)
    if LOCAL_EXTENSION_PATTERN.match(dest):
        return dest

    raise ValueError(
        f"Invalid destination: '{dest}'. "
        "Accepted formats: +15087282017, 15087282017, 5087282017, or extension (1001)"
    )


class RCFCreate(BaseModel):
    customer_id: int
    did: str
    forward_to: str
    pass_caller_id: bool = True
    ring_timeout: int = 30
    failover_to: Optional[str] = None

    @field_validator('did')
    @classmethod
    def validate_did(cls, v: str) -> str:
        """DID must be E.164 format (this is the inbound number)."""
        return validate_e164(v)

    @field_validator('forward_to')
    @classmethod
    def validate_forward_to_number(cls, v: str) -> str:
        """Forward destination can be E.164 or local extension."""
        return validate_forward_destination(v)

    @field_validator('failover_to')
    @classmethod
    def validate_failover(cls, v: Optional[str]) -> Optional[str]:
        """Failover destination can be E.164 or local extension."""
        if v is not None:
            return validate_forward_destination(v)
        return v

    @field_validator('ring_timeout')
    @classmethod
    def validate_ring_timeout(cls, v: int) -> int:
        if v < 5 or v > 120:
            raise ValueError("ring_timeout must be between 5 and 120 seconds")
        return v


class RCFUpdate(BaseModel):
    forward_to: Optional[str] = None
    pass_caller_id: Optional[bool] = None
    ring_timeout: Optional[int] = None
    failover_to: Optional[str] = None
    enabled: Optional[bool] = None

    @field_validator('forward_to')
    @classmethod
    def validate_forward_to(cls, v: Optional[str]) -> Optional[str]:
        """Forward destination can be E.164 or local extension."""
        if v is not None:
            return validate_forward_destination(v)
        return v

    @field_validator('failover_to')
    @classmethod
    def validate_failover(cls, v: Optional[str]) -> Optional[str]:
        """Failover destination can be E.164 or local extension."""
        if v is not None:
            return validate_forward_destination(v)
        return v

    @field_validator('ring_timeout')
    @classmethod
    def validate_ring_timeout(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and (v < 5 or v > 120):
            raise ValueError("ring_timeout must be between 5 and 120 seconds")
        return v


class RCFResponse(BaseModel):
    """Response model for RCF operations."""
    id: int
    did: str
    forward_to: str
    pass_caller_id: bool
    enabled: bool
    ring_timeout: Optional[int] = None
    failover_to: Optional[str] = None
    customer_id: Optional[int] = None
    customer_name: Optional[str] = None


@router.post("")
async def create_rcf(rcf: RCFCreate):
    """Create a new RCF number."""
    # Verify customer exists and is active
    customer = await db.fetch_one(
        "SELECT id, status FROM customers WHERE id = $1",
        rcf.customer_id
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    if customer["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    try:
        result = await db.fetch_one(
            """
            INSERT INTO rcf_numbers (customer_id, did, forward_to, pass_caller_id, ring_timeout, failover_to)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, did, forward_to, pass_caller_id, enabled, created_at
            """,
            rcf.customer_id, rcf.did, rcf.forward_to, rcf.pass_caller_id,
            rcf.ring_timeout, rcf.failover_to
        )
        return dict(result)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="DID already exists")
        raise


@router.get("/{did}")
async def get_rcf(did: str):
    """Get RCF config by DID."""
    result = await db.fetch_one(
        """
        SELECT r.*, c.name as customer_name, c.traffic_grade
        FROM rcf_numbers r
        JOIN customers c ON r.customer_id = c.id
        WHERE r.did = $1
        """,
        did
    )
    if not result:
        raise HTTPException(status_code=404, detail="RCF number not found")
    return dict(result)


@router.put("/{did}")
async def update_rcf(did: str, rcf: RCFUpdate) -> RCFResponse:
    """Update RCF settings.

    Updates the RCF configuration for a DID and invalidates the Redis cache
    to ensure the next inbound call routes to the new destination.

    Args:
        did: The DID to update (E.164 format, e.g., +15551234567)
        rcf: Update payload with fields to modify

    Returns:
        Updated RCF record with customer information

    Raises:
        400: No fields provided to update
        404: RCF number not found
        422: Validation error (invalid E.164 format, invalid ring_timeout)
    """
    updates = []
    values = []
    idx = 1

    update_data = rcf.model_dump(exclude_none=True)

    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    for field, value in update_data.items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    values.append(did)
    query = f"""
        UPDATE rcf_numbers SET {', '.join(updates)}
        WHERE did = ${idx}
        RETURNING id, did, forward_to, pass_caller_id, enabled, ring_timeout, failover_to, customer_id
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="RCF number not found")

    # Invalidate Redis cache so FreeSWITCH picks up the new forward_to on the next call
    await cache.invalidate_rcf_cache(did)
    logger.info(f"RCF updated: did={did}, fields={list(update_data.keys())}, cache invalidated")

    # Fetch customer name for complete response
    customer = await db.fetch_one(
        "SELECT name FROM customers WHERE id = $1",
        result["customer_id"]
    )

    return RCFResponse(
        id=result["id"],
        did=result["did"],
        forward_to=result["forward_to"],
        pass_caller_id=result["pass_caller_id"],
        enabled=result["enabled"],
        ring_timeout=result["ring_timeout"],
        failover_to=result["failover_to"],
        customer_id=result["customer_id"],
        customer_name=customer["name"] if customer else None
    )


@router.patch("/{did}")
async def patch_rcf(did: str, rcf: RCFUpdate) -> RCFResponse:
    """Partial update for RCF settings (alias for PUT).

    This is an alias for the PUT endpoint, following REST conventions
    where PATCH is used for partial updates.
    """
    return await update_rcf(did, rcf)


@router.delete("/{did}")
async def delete_rcf(did: str):
    """Delete an RCF number."""
    result = await db.execute(
        "DELETE FROM rcf_numbers WHERE did = $1",
        did
    )

    # Invalidate cache
    await cache.invalidate_rcf_cache(did)

    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="RCF number not found")
    return {"status": "deleted", "did": did}


@router.get("")
async def list_rcf(customer_id: Optional[int] = None, enabled: Optional[bool] = None):
    """List RCF numbers with optional filters."""
    query = """
        SELECT r.id, r.did, r.forward_to, r.enabled, r.customer_id,
               c.name as customer_name
        FROM rcf_numbers r
        JOIN customers c ON r.customer_id = c.id
        WHERE 1=1
    """
    values = []
    idx = 1

    if customer_id is not None:
        query += f" AND r.customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if enabled is not None:
        query += f" AND r.enabled = ${idx}"
        values.append(enabled)
        idx += 1

    query += " ORDER BY r.created_at DESC LIMIT 100"

    results = await db.fetch_all(query, *values)
    return [dict(r) for r in results]
