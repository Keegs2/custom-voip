"""Extension management endpoints for UCaaS.

Extensions map users to phone extensions within a customer account.
Includes directory listing with presence status for BLF/contacts.
"""
import re
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, field_validator
from typing import Optional
from datetime import datetime

# E.164 format: + followed by 1-15 digits (ITU-T E.164)
_E164_RE = re.compile(r"^\+[1-9]\d{6,14}$")

from db import database as db
from auth.dependencies import get_current_user, require_admin, get_customer_filter

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ExtensionCreate(BaseModel):
    extension: str
    customer_id: int
    user_id: Optional[int] = None
    display_name: Optional[str] = None
    assigned_did: Optional[str] = None
    voicemail_enabled: bool = True
    voicemail_pin: str = "1234"
    dnd: bool = False
    forward_on_busy: Optional[str] = None
    forward_on_no_answer: Optional[str] = None
    forward_timeout: int = 30

    @field_validator("extension")
    @classmethod
    def validate_extension(cls, v: str) -> str:
        if not v.isdigit() or len(v) < 2 or len(v) > 10:
            raise ValueError("Extension must be 2-10 digits")
        return v

    @field_validator("assigned_did")
    @classmethod
    def validate_assigned_did(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not _E164_RE.match(v):
            raise ValueError(
                "assigned_did must be in E.164 format (e.g. +17745551234)"
            )
        return v

    @field_validator("voicemail_pin")
    @classmethod
    def validate_pin(cls, v: str) -> str:
        if not v.isdigit() or len(v) < 4 or len(v) > 10:
            raise ValueError("Voicemail PIN must be 4-10 digits")
        return v

    @field_validator("forward_timeout")
    @classmethod
    def validate_timeout(cls, v: int) -> int:
        if v < 5 or v > 120:
            raise ValueError("Forward timeout must be between 5 and 120 seconds")
        return v


class ExtensionUpdate(BaseModel):
    user_id: Optional[int] = None
    display_name: Optional[str] = None
    assigned_did: Optional[str] = None
    voicemail_enabled: Optional[bool] = None
    voicemail_pin: Optional[str] = None
    dnd: Optional[bool] = None
    forward_on_busy: Optional[str] = None
    forward_on_no_answer: Optional[str] = None
    forward_timeout: Optional[int] = None
    status: Optional[str] = None

    @field_validator("assigned_did")
    @classmethod
    def validate_assigned_did(cls, v: Optional[str]) -> Optional[str]:
        # Allow explicit empty string to clear the DID
        if v is not None and v != "" and not _E164_RE.match(v):
            raise ValueError(
                "assigned_did must be in E.164 format (e.g. +17745551234)"
            )
        # Normalise empty string to None so the DB stores NULL
        if v == "":
            return None
        return v

    @field_validator("voicemail_pin")
    @classmethod
    def validate_pin(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and (not v.isdigit() or len(v) < 4 or len(v) > 10):
            raise ValueError("Voicemail PIN must be 4-10 digits")
        return v

    @field_validator("forward_timeout")
    @classmethod
    def validate_timeout(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and (v < 5 or v > 120):
            raise ValueError("Forward timeout must be between 5 and 120 seconds")
        return v

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("active", "disabled"):
            raise ValueError("Status must be 'active' or 'disabled'")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _apply_customer_filter(
    query: str,
    values: list,
    idx: int,
    customer_filter: int | None,
) -> tuple[str, list, int]:
    """Append a customer_id WHERE clause if the user is not an admin."""
    if customer_filter is not None:
        query += f" AND e.customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1
    return query, values, idx


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_extensions(
    customer_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List extensions with user name and presence status.

    Non-admin users are automatically scoped to their own customer.
    """
    query = """
        SELECT e.id, e.extension, e.user_id, e.customer_id, e.display_name,
               e.assigned_did,
               e.voicemail_enabled, e.dnd, e.forward_on_busy, e.forward_on_no_answer,
               e.forward_timeout, e.status, e.created_at,
               u.name AS user_name, u.email AS user_email,
               COALESCE(p.status, 'offline') AS presence_status,
               p.status_message AS presence_message
        FROM extensions e
        LEFT JOIN users u ON e.user_id = u.id
        LEFT JOIN presence_status p ON e.user_id = p.user_id
        WHERE 1=1
    """
    values: list = []
    idx = 1

    # Enforce customer scoping for non-admins
    query, values, idx = _apply_customer_filter(query, values, idx, customer_filter)

    # Optional filters
    if customer_id is not None:
        # Admin can explicitly filter by customer_id
        query += f" AND e.customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if status is not None:
        query += f" AND e.status = ${idx}"
        values.append(status)
        idx += 1

    query += f" ORDER BY e.extension ASC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    return [dict(r) for r in rows]


@router.get("/directory")
async def extension_directory(
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List all extensions with presence status for BLF / contacts directory.

    Returns a compact list optimised for phone displays and soft-key panels.
    """
    query = """
        SELECT e.id, e.extension, e.display_name,
               e.assigned_did,
               u.name AS user_name,
               COALESCE(p.status, 'offline') AS presence_status,
               p.status_message AS presence_message,
               e.dnd
        FROM extensions e
        LEFT JOIN users u ON e.user_id = u.id
        LEFT JOIN presence_status p ON e.user_id = p.user_id
        WHERE e.status = 'active'
    """
    values: list = []
    idx = 1

    if customer_filter is not None:
        query += f" AND e.customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1

    query += " ORDER BY e.extension ASC"

    rows = await db.fetch_all(query, *values)
    return [dict(r) for r in rows]


@router.get("/{extension_id}")
async def get_extension(
    extension_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get a single extension with full details."""
    query = """
        SELECT e.id, e.extension, e.user_id, e.customer_id, e.display_name,
               e.assigned_did,
               e.voicemail_enabled, e.voicemail_pin, e.dnd,
               e.forward_on_busy, e.forward_on_no_answer, e.forward_timeout,
               e.status, e.created_at,
               u.name AS user_name, u.email AS user_email,
               COALESCE(p.status, 'offline') AS presence_status,
               p.status_message AS presence_message
        FROM extensions e
        LEFT JOIN users u ON e.user_id = u.id
        LEFT JOIN presence_status p ON e.user_id = p.user_id
        WHERE e.id = $1
    """
    values: list = [extension_id]
    idx = 2

    if customer_filter is not None:
        query += f" AND e.customer_id = ${idx}"
        values.append(customer_filter)

    row = await db.fetch_one(query, *values)
    if not row:
        raise HTTPException(status_code=404, detail="Extension not found")
    return dict(row)


@router.post("", status_code=201)
async def create_extension(
    body: ExtensionCreate,
    admin: dict = Depends(require_admin),
):
    """Create a new extension (admin only).

    Extension numbers must be unique within the customer.
    """
    # Check uniqueness within customer
    existing = await db.fetch_one(
        "SELECT id FROM extensions WHERE customer_id = $1 AND extension = $2",
        body.customer_id, body.extension,
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Extension {body.extension} already exists for this customer",
        )

    # Validate user_id belongs to the same customer if provided
    if body.user_id is not None:
        user_row = await db.fetch_one(
            "SELECT id, customer_id FROM users WHERE id = $1", body.user_id
        )
        if not user_row:
            raise HTTPException(status_code=400, detail="User not found")
        if user_row["customer_id"] != body.customer_id:
            raise HTTPException(
                status_code=400,
                detail="User does not belong to the specified customer",
            )

    # Validate assigned_did uniqueness (nicer error than a DB constraint violation)
    if body.assigned_did is not None:
        did_conflict = await db.fetch_one(
            "SELECT id, extension FROM extensions WHERE assigned_did = $1",
            body.assigned_did,
        )
        if did_conflict:
            raise HTTPException(
                status_code=409,
                detail=f"DID {body.assigned_did} is already assigned to extension {did_conflict['extension']}",
            )

    row = await db.fetch_one(
        """INSERT INTO extensions
               (extension, user_id, customer_id, display_name, assigned_did,
                voicemail_enabled, voicemail_pin, dnd,
                forward_on_busy, forward_on_no_answer, forward_timeout)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id, extension, user_id, customer_id, display_name,
                     assigned_did, voicemail_enabled, dnd, status, created_at""",
        body.extension,
        body.user_id,
        body.customer_id,
        body.display_name,
        body.assigned_did,
        body.voicemail_enabled,
        body.voicemail_pin,
        body.dnd,
        body.forward_on_busy,
        body.forward_on_no_answer,
        body.forward_timeout,
    )
    return dict(row)


@router.put("/{extension_id}")
async def update_extension(
    extension_id: int,
    body: ExtensionUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Update extension settings.

    Non-admin users can only update extensions within their own customer.
    """
    # Verify extension exists and is accessible
    check_query = "SELECT id, customer_id FROM extensions WHERE id = $1"
    check_values: list = [extension_id]
    if customer_filter is not None:
        check_query += " AND customer_id = $2"
        check_values.append(customer_filter)

    existing = await db.fetch_one(check_query, *check_values)
    if not existing:
        raise HTTPException(status_code=404, detail="Extension not found")

    # Validate assigned_did uniqueness if being changed
    update_data = body.model_dump(exclude_none=True)
    if "assigned_did" in update_data and update_data["assigned_did"] is not None:
        did_conflict = await db.fetch_one(
            "SELECT id, extension FROM extensions WHERE assigned_did = $1 AND id != $2",
            update_data["assigned_did"],
            extension_id,
        )
        if did_conflict:
            raise HTTPException(
                status_code=409,
                detail=f"DID {update_data['assigned_did']} is already assigned to extension {did_conflict['extension']}",
            )

    # Build dynamic UPDATE
    updates: list[str] = []
    values: list = []
    idx = 1

    for field, value in update_data.items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    values.append(extension_id)
    query = f"""
        UPDATE extensions SET {', '.join(updates)}
        WHERE id = ${idx}
        RETURNING id, extension, user_id, customer_id, display_name,
                  assigned_did, voicemail_enabled, dnd, forward_on_busy,
                  forward_on_no_answer, forward_timeout, status, created_at
    """
    row = await db.fetch_one(query, *values)
    if not row:
        raise HTTPException(status_code=404, detail="Extension not found")
    return dict(row)


@router.delete("/{extension_id}")
async def delete_extension(
    extension_id: int,
    admin: dict = Depends(require_admin),
):
    """Delete an extension (admin only). Cascades to voicemails and greetings."""
    result = await db.execute("DELETE FROM extensions WHERE id = $1", extension_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Extension not found")
    return {"status": "deleted", "extension_id": extension_id}
