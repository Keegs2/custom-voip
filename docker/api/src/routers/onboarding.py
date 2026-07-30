"""Onboarding pipeline for new RCF customer requests.

This app stores the public signup form and tracks a lightweight status.
Billing accounts + provisioning are handled by an EXTERNAL system (integrated
later); "completed" is a STATUS-ONLY transition here — it does NOT create any
customer/user/RCF/DID records.

Workflow: pending → completed  (↘ rejected)
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
import re

from db import database as db
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


class CompleteRequest(BaseModel):
    notes: Optional[str] = None


class RejectRequest(BaseModel):
    reason: Optional[str] = None


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
               cb.name AS completed_by_name,
               COUNT(*) OVER() AS total_count
          FROM onboarding_requests o
          LEFT JOIN users rv ON o.reviewed_by = rv.id
          LEFT JOIN users cb ON o.completed_by = cb.id
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
               cb.name AS completed_by_name
          FROM onboarding_requests o
          LEFT JOIN users rv ON o.reviewed_by = rv.id
          LEFT JOIN users cb ON o.completed_by = cb.id
         WHERE o.id = $1
        """,
        request_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Onboarding request not found")
    return dict(result)


@router.post("/{request_id}/complete")
async def complete_onboarding(
    request_id: int,
    body: CompleteRequest,
    admin: dict = Depends(require_admin),
):
    """Mark an onboarding request complete. Requires status='pending'. Admin only.

    Status-only transition: does NOT create any customer/user/RCF/DID records
    (billing + provisioning are handled by an external system).
    """
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
            detail=f"Cannot complete: request is '{existing['status']}', expected 'pending'",
        )

    now = datetime.now(timezone.utc)
    result = await db.fetch_one(
        """
        UPDATE onboarding_requests
           SET status = 'completed',
               completed_by = $1::int,
               completed_at = $2::timestamptz,
               admin_notes = $3,
               updated_at = $2::timestamptz
         WHERE id = $4::int
         RETURNING id, status, completed_at
        """,
        admin_id, now, body.notes, request_id,
    )
    logger.info("Onboarding completed: request=%d, by_admin=%d", request_id, admin_id)
    return dict(result)


@router.post("/{request_id}/reject")
async def reject_onboarding(
    request_id: int,
    body: RejectRequest,
    admin: dict = Depends(require_admin),
):
    """Reject an onboarding request. Admin only."""
    admin_id = int(admin["sub"])

    existing = await db.fetch_one(
        "SELECT id, status FROM onboarding_requests WHERE id = $1",
        request_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Onboarding request not found")
    if existing["status"] in ("completed", "rejected"):
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
