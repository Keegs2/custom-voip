"""RCF (Remote Call Forwarding) endpoints.

Multi-tenant contract (mirrors routers/api_dids.py):
  - Reads are tenant-scoped: non-admins (customer_filter not None) only ever see
    their own customer's RCF numbers; admins (customer_filter None) are unrestricted.
  - Cross-tenant / missing resources return 404 (never 403) so existence is not
    leaked across tenants.
  - forward_to / ring_timeout edits (PUT/PATCH) are documented customer
    self-service (the RcfPage edits these inline), so OWNERS may edit their own
    number; gated to the resolved row's customer_id.
  - Create / delete are admin-only (provisioning).
"""
import os
import re
import logging
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, field_validator
from typing import Optional
from db import database as db
from db import redis_client as cache
from auth.dependencies import get_customer_filter, require_admin

router = APIRouter()
logger = logging.getLogger(__name__)


async def _get_owned_rcf(identifier: str, customer_filter: int | None) -> dict:
    """Resolve an RCF row by numeric id OR E.164 DID and enforce tenant isolation.
    404 if it does not exist OR belongs to another customer (do not leak existence
    cross-tenant). Returns the resolved row (id, did, customer_id)."""
    if identifier.isdigit():
        row = await db.fetch_one(
            "SELECT id, did, customer_id FROM rcf_numbers WHERE id = $1",
            int(identifier),
        )
    else:
        row = await db.fetch_one(
            "SELECT id, did, customer_id FROM rcf_numbers WHERE did = $1",
            identifier,
        )
    if not row:
        raise HTTPException(status_code=404, detail="RCF number not found")
    if customer_filter is not None and row["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="RCF number not found")
    return dict(row)

# --- Reconciliation guard configuration ------------------------------------
# DEPLOY_ENV identifies which environment this API instance serves. The guard
# refuses to configure routing for a DID the shared inventory has allocated to
# a different environment (e.g. configuring a prod-owned DID in the sandbox).
DEPLOY_ENV = (os.getenv("DEPLOY_ENV", "prod").strip().lower() or "prod")

# Escape hatch: set INVENTORY_GUARD_ENFORCE=false to disable the guard entirely
# (e.g. if a replica hiccup ever causes trouble). Default on.
INVENTORY_GUARD_ENFORCE = (
    os.getenv("INVENTORY_GUARD_ENFORCE", "true").strip().lower()
    not in ("false", "0", "no", "off")
)


async def _enforce_allocation_guard(did: str) -> None:
    """Reject configuring routing for a DID owned by a different environment.

    Reads did_inventory via the INVENTORY pool (the replica/source-of-truth when
    INVENTORY_READ_URL is set, otherwise the primary). Decision table:

      - guard disabled (INVENTORY_GUARD_ENFORCE=false) -> ALLOW (debug log)
      - inventory lookup errors (replica unreachable)  -> ALLOW (fail open + warn)
      - no inventory row for the DID                    -> ALLOW (untracked/local DID)
      - row.allocated_env == DEPLOY_ENV                 -> ALLOW
      - row.allocated_env != DEPLOY_ENV                 -> REJECT (HTTP 409)
    """
    if not INVENTORY_GUARD_ENFORCE:
        logger.debug(
            "Inventory allocation guard disabled (INVENTORY_GUARD_ENFORCE=false); allowing did=%s",
            did,
        )
        return

    try:
        row = await db.fetch_one_inventory(
            "SELECT allocated_env FROM did_inventory WHERE did = $1", did
        )
    except Exception as e:
        # Never let a replica/inventory hiccup block provisioning — fail open.
        logger.warning(
            "Inventory allocation guard lookup failed for did=%s (%s); failing open (allow)",
            did, e,
        )
        return

    if not row:
        # Untracked DID: not in the shared inventory, so we cannot enforce
        # ownership (covers seeded/local scratch DIDs). Allow.
        return

    allocated_env = row["allocated_env"]
    if allocated_env != DEPLOY_ENV:
        raise HTTPException(
            status_code=409,
            detail=(
                f"DID {did} is allocated to environment '{allocated_env}'; "
                f"cannot configure routing in '{DEPLOY_ENV}'."
            ),
        )

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


def _is_international(dest: Optional[str]) -> bool:
    """True when a (already-normalized) forward destination is international.

    A destination is international when it is E.164 (``+...``) but NOT NANP. NANP
    is normalized upstream to ``+1`` followed by exactly 10 digits (12 chars).
    Local PBX extensions (no leading ``+``) are never international."""
    if not dest:
        return False
    if not dest.startswith("+"):
        return False  # local extension / non-E.164 — treated as domestic/local
    if dest.startswith("+1") and len(dest) == 12:
        return False  # NANP (+1 + 10 digits) is domestic
    return True


def _enforce_international_policy(intl_enabled: bool, *destinations: Optional[str]) -> None:
    """Provisioning-time fraud guard (complements telephony's call-time check):
    refuse to save an international forward/failover destination unless the owning
    customer has international calling enabled. Raises 403 with an actionable
    message. This is defense in depth — the FreeSWITCH RCF path also reads
    ``customers.international_calling_enabled`` at call time."""
    if intl_enabled:
        return
    for dest in destinations:
        if _is_international(dest):
            raise HTTPException(
                status_code=403,
                detail=(
                    f"International destination '{dest}' is not permitted: this "
                    "account does not have international calling enabled. Contact "
                    "support to enable international destinations for this account."
                ),
            )


class RCFCreate(BaseModel):
    customer_id: int
    did: str
    name: Optional[str] = None
    forward_to: str
    pass_caller_id: bool = True
    ring_timeout: int = 30
    failover_to: Optional[str] = None
    max_channels: int = 0

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

    @field_validator('max_channels')
    @classmethod
    def validate_max_channels(cls, v: int) -> int:
        """0 = unlimited, 1-100 = enforced concurrent call limit per DID."""
        if v < 0 or v > 100:
            raise ValueError("max_channels must be between 0 (unlimited) and 100")
        return v


class RCFUpdate(BaseModel):
    name: Optional[str] = None
    forward_to: Optional[str] = None
    pass_caller_id: Optional[bool] = None
    ring_timeout: Optional[int] = None
    failover_to: Optional[str] = None
    enabled: Optional[bool] = None
    max_channels: Optional[int] = None

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

    @field_validator('max_channels')
    @classmethod
    def validate_max_channels(cls, v: Optional[int]) -> Optional[int]:
        """0 = unlimited, 1-100 = enforced concurrent call limit per DID."""
        if v is not None and (v < 0 or v > 100):
            raise ValueError("max_channels must be between 0 (unlimited) and 100")
        return v


class RCFResponse(BaseModel):
    """Response model for RCF operations."""
    id: int
    did: str
    name: Optional[str] = None
    forward_to: str
    pass_caller_id: bool
    enabled: bool
    ring_timeout: Optional[int] = None
    failover_to: Optional[str] = None
    max_channels: int = 0
    customer_id: Optional[int] = None
    customer_name: Optional[str] = None


@router.post("")
async def create_rcf(rcf: RCFCreate, admin: dict = Depends(require_admin)):
    """Create a new RCF number. Admin-only: provisioning.

    SEC-3 note: api_dids gates create on did_inventory ownership to stop a tenant
    claiming another tenant's DID. That cross-tenant claim path is unreachable
    here because creation is admin-only (require_admin); admins are trusted to
    target any customer via the payload. The DID-vs-environment ownership check is
    still enforced below via _enforce_allocation_guard (shared inventory)."""
    # Verify customer exists and is active
    customer = await db.fetch_one(
        "SELECT id, status, international_calling_enabled FROM customers WHERE id = $1",
        rcf.customer_id
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    if customer["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    # Fraud guard (defense in depth): refuse an international forward/failover
    # destination unless this customer has international calling enabled.
    _enforce_international_policy(
        customer["international_calling_enabled"], rcf.forward_to, rcf.failover_to
    )

    # Reconciliation guard: refuse if the shared inventory allocates this DID
    # to a different environment. rcf.did is already validated to E.164.
    await _enforce_allocation_guard(rcf.did)

    try:
        result = await db.fetch_one(
            """
            INSERT INTO rcf_numbers (customer_id, did, name, forward_to, pass_caller_id, ring_timeout, failover_to, max_channels)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, did, name, forward_to, pass_caller_id, enabled, ring_timeout, failover_to, max_channels, created_at
            """,
            rcf.customer_id, rcf.did, rcf.name, rcf.forward_to, rcf.pass_caller_id,
            rcf.ring_timeout, rcf.failover_to, rcf.max_channels
        )
        return dict(result)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="DID already exists")
        raise


@router.get("/{did}")
async def get_rcf(
    did: str,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get RCF config by DID (tenant-scoped)."""
    # Ownership gate first (404 cross-tenant), then enrich.
    await _get_owned_rcf(did, customer_filter)
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


@router.put("/{identifier}")
async def update_rcf(
    identifier: str,
    rcf: RCFUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
) -> RCFResponse:
    """Update RCF settings by ID (numeric) or DID (E.164 string).

    Customer self-service: trunk/RCF OWNERS (and admins) may edit their own
    number; ownership-gated (404 cross-tenant) for both id and DID identifiers."""
    updates = []
    values = []
    idx = 1

    update_data = rcf.model_dump(exclude_none=True)

    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Ownership gate (404 cross-tenant) AND resolves the row's id/DID in one
    # lookup — the identifier may be a numeric rcf_numbers.id or the E.164 DID.
    owned = await _get_owned_rcf(identifier, customer_filter)

    # Reconciliation guard: refuse if the shared inventory allocates the resolved
    # DID to a different environment.
    await _enforce_allocation_guard(owned["did"])

    # Fraud guard (defense in depth): if this update sets an international
    # forward/failover destination, the owning customer must have international
    # calling enabled. Only pay for the customer lookup when a target is actually
    # international.
    new_forward = update_data.get("forward_to")
    new_failover = update_data.get("failover_to")
    if _is_international(new_forward) or _is_international(new_failover):
        cust = await db.fetch_one(
            "SELECT international_calling_enabled FROM customers WHERE id = $1",
            owned["customer_id"],
        )
        intl_enabled = bool(cust["international_calling_enabled"]) if cust else False
        _enforce_international_policy(intl_enabled, new_forward, new_failover)

    for field, value in update_data.items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    # Update by the resolved primary key (ownership already verified above).
    values.append(owned["id"])
    query = f"""
        UPDATE rcf_numbers SET {', '.join(updates)}
        WHERE id = ${idx}
        RETURNING id, did, name, forward_to, pass_caller_id, enabled, ring_timeout, failover_to, max_channels, customer_id
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="RCF number not found")

    # Invalidate Redis cache so FreeSWITCH picks up the new forward_to on the next call
    await cache.invalidate_rcf_cache(result["did"])
    logger.info(f"RCF updated: did={result['did']}, fields={list(update_data.keys())}, cache invalidated")

    # Fetch customer name for complete response
    customer = await db.fetch_one(
        "SELECT name FROM customers WHERE id = $1",
        result["customer_id"]
    )

    return RCFResponse(
        id=result["id"],
        did=result["did"],
        name=result["name"],
        forward_to=result["forward_to"],
        pass_caller_id=result["pass_caller_id"],
        enabled=result["enabled"],
        ring_timeout=result["ring_timeout"],
        failover_to=result["failover_to"],
        max_channels=result["max_channels"],
        customer_id=result["customer_id"],
        customer_name=customer["name"] if customer else None
    )


@router.patch("/{identifier}")
async def patch_rcf(
    identifier: str,
    rcf: RCFUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
) -> RCFResponse:
    """Partial update for RCF settings (alias for PUT; same ownership gate)."""
    return await update_rcf(identifier, rcf, customer_filter)


@router.delete("/{identifier}")
async def delete_rcf(identifier: str, admin: dict = Depends(require_admin)):
    """Delete an RCF number by ID (numeric) or DID (E.164 string).

    Admin-only: provisioning. The allocation guard is intentionally NOT applied
    on delete (removing routing for a foreign-env DID is always safe)."""
    if identifier.isdigit():
        # Lookup DID first for cache invalidation, then delete by ID
        row = await db.fetch_one(
            "SELECT did FROM rcf_numbers WHERE id = $1", int(identifier)
        )
        if not row:
            raise HTTPException(status_code=404, detail="RCF number not found")
        did = row["did"]
        await db.execute("DELETE FROM rcf_numbers WHERE id = $1", int(identifier))
    else:
        did = identifier
        result = await db.execute("DELETE FROM rcf_numbers WHERE did = $1", did)
        if result == "DELETE 0":
            raise HTTPException(status_code=404, detail="RCF number not found")

    await cache.invalidate_rcf_cache(did)
    return {"status": "deleted", "did": did}


@router.get("")
async def list_rcf(
    customer_id: Optional[int] = None,
    enabled: Optional[bool] = None,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List RCF numbers. Non-admins are scoped to their own customer."""
    query = """
        SELECT r.id, r.did, r.name, r.forward_to, r.pass_caller_id, r.enabled,
               r.ring_timeout, r.failover_to, r.max_channels, r.customer_id,
               c.name as customer_name
        FROM rcf_numbers r
        JOIN customers c ON r.customer_id = c.id
        WHERE 1=1
    """
    values = []
    idx = 1

    # Enforce tenant scoping for non-admins; admins may filter by customer_id.
    if customer_filter is not None:
        query += f" AND r.customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1
    elif customer_id is not None:
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
