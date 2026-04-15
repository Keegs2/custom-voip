"""Extension management endpoints for UCaaS.

Extensions map users to phone extensions within a customer account.
Includes directory listing with presence status for BLF/contacts.
"""
import re
import logging
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, field_validator
from typing import Optional
from datetime import datetime

# E.164 format: + followed by 1-15 digits (ITU-T E.164)
_E164_RE = re.compile(r"^\+[1-9]\d{6,14}$")

from db import database as db
from auth.dependencies import get_current_user, require_admin, get_customer_filter

logger = logging.getLogger(__name__)

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


class AutoProvisionRequest(BaseModel):
    customer_id: int


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
        SELECT e.id, e.user_id, e.extension, e.display_name,
               e.assigned_did,
               u.name AS user_name,
               c.name AS customer_name,
               COALESCE(p.status, 'offline') AS presence_status,
               p.status_message AS presence_message,
               e.dnd
        FROM extensions e
        LEFT JOIN users u ON e.user_id = u.id
        LEFT JOIN customers c ON e.customer_id = c.id
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


@router.post("/auto-provision", status_code=201)
async def auto_provision_extensions(
    body: AutoProvisionRequest,
    admin: dict = Depends(require_admin),
):
    """Bulk auto-provision extensions for a customer (admin only).

    Finds all users belonging to the specified customer who do not yet have
    an extension and creates one for each.  Extension numbers are assigned
    sequentially starting from the customer's current max + 1 (base 100).

    Returns the list of newly provisioned extensions.
    """
    # Verify customer exists and has UCaaS access
    cust = await db.fetch_one(
        "SELECT id, account_type, ucaas_enabled FROM customers WHERE id = $1",
        body.customer_id,
    )
    if not cust:
        raise HTTPException(status_code=404, detail="Customer not found")

    has_ucaas = (
        cust["account_type"] == "ucaas"
        or bool(cust.get("ucaas_enabled"))
    )
    if not has_ucaas:
        raise HTTPException(
            status_code=400,
            detail="Customer does not have UCaaS access. Enable ucaas_enabled or set account_type to ucaas first.",
        )

    # Find users without extensions
    users_without_ext = await db.fetch_all(
        """SELECT u.id, u.name
           FROM users u
           LEFT JOIN extensions e ON e.user_id = u.id AND e.customer_id = u.customer_id
           WHERE u.customer_id = $1 AND e.id IS NULL
           ORDER BY u.id""",
        body.customer_id,
    )

    if not users_without_ext:
        return {"provisioned": [], "count": 0, "message": "All users already have extensions"}

    # Get the current max extension for this customer
    max_row = await db.fetch_one(
        "SELECT COALESCE(MAX(CAST(extension AS INTEGER)), 99) AS max_ext "
        "FROM extensions WHERE customer_id = $1",
        body.customer_id,
    )
    next_ext_num = max_row["max_ext"] + 1

    provisioned = []
    for user_row in users_without_ext:
        ext_str = str(next_ext_num)
        # Use ON CONFLICT to gracefully handle races
        row = await db.fetch_one(
            """INSERT INTO extensions (extension, user_id, customer_id, display_name, voicemail_enabled, status)
               VALUES ($1, $2, $3, $4, true, 'active')
               ON CONFLICT (customer_id, extension) DO NOTHING
               RETURNING id, extension, user_id, customer_id, display_name, status, created_at""",
            ext_str, user_row["id"], body.customer_id, user_row["name"],
        )
        if row:
            provisioned.append(dict(row))
            next_ext_num += 1
        else:
            # Conflict — skip ahead and retry this user
            next_ext_num += 1
            row = await db.fetch_one(
                """INSERT INTO extensions (extension, user_id, customer_id, display_name, voicemail_enabled, status)
                   VALUES ($1, $2, $3, $4, true, 'active')
                   ON CONFLICT (customer_id, extension) DO NOTHING
                   RETURNING id, extension, user_id, customer_id, display_name, status, created_at""",
                str(next_ext_num), user_row["id"], body.customer_id, user_row["name"],
            )
            if row:
                provisioned.append(dict(row))
                next_ext_num += 1

    logger.info(
        "Auto-provisioned %d extensions for customer %d",
        len(provisioned), body.customer_id,
    )

    return {
        "provisioned": provisioned,
        "count": len(provisioned),
    }


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
    update_data = body.model_dump(exclude_unset=True)
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
