"""Onboarding pipeline for new RCF customer requests.

Workflow: pending → billing_verified → [approve triggers provisioning] → active
          ↘ rejected (at any pre-active point)
"""
import json
import secrets
import string
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
import re

from db import database as db
from db import redis_client as cache
from auth.security import hash_password
from auth.dependencies import require_admin

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class OnboardingSubmit(BaseModel):
    company_name: str
    contact_name: str
    email: str
    phone: str
    did_count: str
    porting: str
    current_carrier: Optional[str] = None
    forwarding_setup: str
    monthly_volume: str
    timeline: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        if not re.match(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$", v):
            raise ValueError("Invalid email address")
        return v.lower().strip()

    @field_validator("company_name", "contact_name", "phone", "did_count",
                     "porting", "forwarding_setup", "monthly_volume", "timeline")
    @classmethod
    def validate_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip()


class DIDConfig(BaseModel):
    did: str
    forward_to: str

    @field_validator("did")
    @classmethod
    def validate_did(cls, v: str) -> str:
        cleaned = re.sub(r"[^\d+]", "", v)
        if not re.match(r"^\+1\d{10}$", cleaned):
            raise ValueError("DID must be E.164 format (+1NPANXXXXXX)")
        return cleaned

    @field_validator("forward_to")
    @classmethod
    def validate_forward_to(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("forward_to cannot be empty")
        return v


class BillingVerifyRequest(BaseModel):
    notes: Optional[str] = None


class ApproveRequest(BaseModel):
    dids: list[DIDConfig]
    admin_notes: Optional[str] = None

    @field_validator("dids")
    @classmethod
    def validate_dids_not_empty(cls, v: list[DIDConfig]) -> list[DIDConfig]:
        if not v:
            raise ValueError("At least one DID configuration is required")
        return v


class RejectRequest(BaseModel):
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _generate_temp_password(length: int = 12) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%"
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("")
async def submit_onboarding_request(body: OnboardingSubmit):
    """Submit a new onboarding request. Public endpoint (no auth required)."""
    result = await db.fetch_one(
        """
        INSERT INTO onboarding_requests
            (company_name, contact_name, email, phone, did_count, porting,
             current_carrier, forwarding_setup, monthly_volume, timeline)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, status, created_at
        """,
        body.company_name, body.contact_name, body.email, body.phone,
        body.did_count, body.porting, body.current_carrier,
        body.forwarding_setup, body.monthly_volume, body.timeline,
    )
    logger.info("Onboarding request submitted: id=%d, company=%s, email=%s",
                result["id"], body.company_name, body.email)
    return dict(result)


@router.get("")
async def list_onboarding_requests(
    admin: dict = Depends(require_admin),
    status: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    """List onboarding requests with optional status filter. Admin only."""
    query = """
        SELECT o.*,
               rv.name AS reviewed_by_name,
               bv.name AS billing_verified_by_name,
               COUNT(*) OVER() AS total_count
          FROM onboarding_requests o
          LEFT JOIN users rv ON o.reviewed_by = rv.id
          LEFT JOIN users bv ON o.billing_verified_by = bv.id
         WHERE 1=1
    """
    values: list = []
    idx = 1

    if status is not None:
        query += f" AND o.status = ${idx}"
        values.append(status)
        idx += 1

    query += f" ORDER BY o.created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    total = rows[0]["total_count"] if rows else 0

    items = []
    for r in rows:
        item = dict(r)
        item.pop("total_count", None)
        items.append(item)

    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{request_id}")
async def get_onboarding_request(
    request_id: int,
    admin: dict = Depends(require_admin),
):
    """Get a single onboarding request with full details. Admin only."""
    result = await db.fetch_one(
        """
        SELECT o.*,
               rv.name AS reviewed_by_name,
               bv.name AS billing_verified_by_name
          FROM onboarding_requests o
          LEFT JOIN users rv ON o.reviewed_by = rv.id
          LEFT JOIN users bv ON o.billing_verified_by = bv.id
         WHERE o.id = $1
        """,
        request_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Onboarding request not found")
    return dict(result)


@router.post("/{request_id}/verify-billing")
async def verify_billing(
    request_id: int,
    body: BillingVerifyRequest,
    admin: dict = Depends(require_admin),
):
    """Mark billing as verified. Requires status='pending'. Admin only."""
    admin_id = int(admin["sub"])

    existing = await db.fetch_one(
        "SELECT id, status FROM onboarding_requests WHERE id = $1",
        request_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Onboarding request not found")
    if existing["status"] != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot verify billing: request is '{existing['status']}', expected 'pending'",
        )

    now = datetime.now(timezone.utc)
    result = await db.fetch_one(
        """
        UPDATE onboarding_requests
           SET status = 'billing_verified',
               billing_verified_by = $1,
               billing_verified_at = $2,
               billing_notes = $3,
               updated_at = $2
         WHERE id = $4
         RETURNING id, status, billing_verified_at
        """,
        admin_id, now, body.notes, request_id,
    )
    logger.info("Billing verified for onboarding request %d by user %d", request_id, admin_id)
    return dict(result)


@router.post("/{request_id}/approve")
async def approve_onboarding(
    request_id: int,
    body: ApproveRequest,
    admin: dict = Depends(require_admin),
):
    """Approve and atomically provision all resources.

    Single transaction:
    1. Create customer (account_type='rcf')
    2. Create user account (temp password)
    3. For each DID: create rcf_numbers + update did_inventory
    4. Update onboarding_request to 'active'
    5. Invalidate Redis caches

    Returns generated credentials (shown once to admin).
    """
    admin_id = int(admin["sub"])

    # Validate current state
    existing = await db.fetch_one(
        "SELECT * FROM onboarding_requests WHERE id = $1",
        request_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Onboarding request not found")
    if existing["status"] != "billing_verified":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot approve: request is '{existing['status']}', expected 'billing_verified'",
        )

    # Check for duplicate email
    dup_user = await db.fetch_one(
        "SELECT id FROM users WHERE email = $1",
        existing["email"],
    )
    if dup_user:
        raise HTTPException(
            status_code=409,
            detail=f"A user with email '{existing['email']}' already exists",
        )

    # Validate all DIDs are available
    for did_cfg in body.dids:
        inv = await db.fetch_one(
            "SELECT id, status FROM did_inventory WHERE did = $1",
            did_cfg.did,
        )
        if not inv:
            raise HTTPException(
                status_code=404,
                detail=f"DID {did_cfg.did} not found in inventory",
            )
        if inv["status"] not in ("available", "reserved"):
            raise HTTPException(
                status_code=409,
                detail=f"DID {did_cfg.did} is not available (status: {inv['status']})",
            )

    # Generate temp password
    temp_password = _generate_temp_password()
    hashed_password = hash_password(temp_password)

    now = datetime.now(timezone.utc)
    pool = await db.get_pool()

    # Mark as provisioning for visibility
    await db.execute(
        "UPDATE onboarding_requests SET status = 'provisioning', updated_at = $1 WHERE id = $2",
        now, request_id,
    )

    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                # 1. Create customer
                customer_row = await conn.fetchrow(
                    """
                    INSERT INTO customers (name, account_type, credit_limit, traffic_grade)
                    VALUES ($1, 'rcf', 0, 'standard')
                    RETURNING id, name, status
                    """,
                    existing["company_name"],
                )
                customer_id = customer_row["id"]

                # 2. Create user account
                user_row = await conn.fetchrow(
                    """
                    INSERT INTO users (email, password_hash, name, role, customer_id)
                    VALUES ($1, $2, $3, 'user', $4)
                    RETURNING id, email, name
                    """,
                    existing["email"], hashed_password,
                    existing["contact_name"], customer_id,
                )
                user_id = user_row["id"]

                # 3. For each DID: create rcf_numbers + update did_inventory
                provisioned_dids = []
                for did_cfg in body.dids:
                    rcf_row = await conn.fetchrow(
                        """
                        INSERT INTO rcf_numbers
                            (customer_id, did, name, forward_to, pass_caller_id, enabled, ring_timeout)
                        VALUES ($1, $2, $3, $4, true, true, 30)
                        RETURNING id
                        """,
                        customer_id, did_cfg.did,
                        f"DID {did_cfg.did}", did_cfg.forward_to,
                    )

                    await conn.execute(
                        """
                        UPDATE did_inventory
                           SET customer_id = $1,
                               product_type = 'rcf',
                               product_ref_id = $2,
                               status = 'assigned',
                               assigned_at = $3,
                               assigned_by = $4,
                               notes = 'Onboarding provisioning',
                               updated_at = $3
                         WHERE did = $5
                        """,
                        customer_id, rcf_row["id"], now, admin_id, did_cfg.did,
                    )

                    provisioned_dids.append({
                        "did": did_cfg.did,
                        "forward_to": did_cfg.forward_to,
                        "rcf_id": rcf_row["id"],
                    })

                # 4. Update onboarding_request to active
                provisioning_json = [
                    {"did": d.did, "forward_to": d.forward_to}
                    for d in body.dids
                ]
                await conn.execute(
                    """
                    UPDATE onboarding_requests
                       SET status = 'active',
                           customer_id = $1,
                           user_id = $2,
                           reviewed_by = $3,
                           reviewed_at = $4,
                           admin_notes = $5,
                           provisioning_config = $6::jsonb,
                           updated_at = $4
                     WHERE id = $7
                    """,
                    customer_id, user_id, admin_id, now,
                    body.admin_notes,
                    json.dumps(provisioning_json),
                    request_id,
                )

    except Exception:
        # Rollback status on failure
        await db.execute(
            "UPDATE onboarding_requests SET status = 'billing_verified', updated_at = $1 WHERE id = $2",
            datetime.now(timezone.utc), request_id,
        )
        raise

    # 5. Invalidate Redis caches
    for did_cfg in body.dids:
        await cache.invalidate_rcf_cache(did_cfg.did)
    await cache.cache_delete("bandwidth:tns")

    logger.info(
        "Onboarding approved: request=%d, customer=%d, user=%d, dids=%d, by_admin=%d",
        request_id, customer_id, user_id, len(body.dids), admin_id,
    )

    return {
        "status": "active",
        "request_id": request_id,
        "customer": {
            "id": customer_id,
            "name": existing["company_name"],
        },
        "user": {
            "id": user_id,
            "email": existing["email"],
            "name": existing["contact_name"],
            "temp_password": temp_password,
        },
        "dids": provisioned_dids,
    }


@router.post("/{request_id}/reject")
async def reject_onboarding(
    request_id: int,
    body: RejectRequest,
    admin: dict = Depends(require_admin),
):
    """Reject an onboarding request. Can be done at any pre-active stage. Admin only."""
    admin_id = int(admin["sub"])

    existing = await db.fetch_one(
        "SELECT id, status FROM onboarding_requests WHERE id = $1",
        request_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Onboarding request not found")
    if existing["status"] in ("active", "rejected"):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot reject: request is already '{existing['status']}'",
        )

    now = datetime.now(timezone.utc)
    result = await db.fetch_one(
        """
        UPDATE onboarding_requests
           SET status = 'rejected',
               rejected_by = $1,
               rejected_at = $2,
               rejection_reason = $3,
               updated_at = $2
         WHERE id = $4
         RETURNING id, status
        """,
        admin_id, now, body.reason, request_id,
    )
    logger.info("Onboarding rejected: request=%d, by_admin=%d", request_id, admin_id)
    return dict(result)
