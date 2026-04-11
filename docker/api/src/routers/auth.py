"""Authentication and user management endpoints."""
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, field_validator
import re
import logging
from typing import Optional
from datetime import datetime, timezone

from db import database as db
from auth.security import verify_password, hash_password, create_access_token
from auth.dependencies import get_current_user, require_admin

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str
    role: str = "user"
    customer_id: Optional[int] = None

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        if not re.match(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$", v):
            raise ValueError("Invalid email address")
        return v.lower()


class UserUpdate(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    name: Optional[str] = None
    role: Optional[str] = None
    customer_id: Optional[int] = None
    status: Optional[str] = None


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    role: str
    customer_id: Optional[int]
    status: str
    created_at: Optional[datetime]
    last_login: Optional[datetime]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _has_ucaas_access(customer_id: int) -> bool:
    """Check whether a customer has UCaaS access (account_type='ucaas' or ucaas_enabled=true)."""
    if customer_id is None:
        return False
    cust = await db.fetch_one(
        "SELECT account_type, ucaas_enabled FROM customers WHERE id = $1",
        customer_id,
    )
    if not cust:
        return False
    return (
        cust["account_type"] == "ucaas"
        or bool(cust.get("ucaas_enabled"))
    )


async def _provision_extension(user_id: int, customer_id: int, display_name: str) -> dict | None:
    """Auto-provision the next available extension for a user within a customer.

    Uses INSERT ... ON CONFLICT to handle race conditions where two users are
    provisioned simultaneously and receive the same next extension number.
    Retries up to 5 times with incrementing extension numbers on conflict.

    Returns the extension row dict, or None if provisioning failed.
    """
    for attempt in range(5):
        # Find the next available extension number for this customer (base 100)
        next_ext_row = await db.fetch_one(
            "SELECT COALESCE(MAX(CAST(extension AS INTEGER)), 99) + 1 AS next_ext "
            "FROM extensions WHERE customer_id = $1",
            customer_id,
        )
        next_ext = str(next_ext_row["next_ext"] + attempt)  # offset by attempt on retry

        row = await db.fetch_one(
            """INSERT INTO extensions (extension, user_id, customer_id, display_name, voicemail_enabled, status)
               VALUES ($1, $2, $3, $4, true, 'active')
               ON CONFLICT (customer_id, extension) DO NOTHING
               RETURNING id, extension, user_id, customer_id, display_name, status, created_at""",
            next_ext, user_id, customer_id, display_name,
        )
        if row:
            logger.info(
                "Auto-provisioned extension %s for user %d (customer %d)",
                next_ext, user_id, customer_id,
            )
            return dict(row)

    logger.warning(
        "Failed to auto-provision extension for user %d (customer %d) after 5 attempts",
        user_id, customer_id,
    )
    return None


# ---------------------------------------------------------------------------
# Public endpoints
# ---------------------------------------------------------------------------

@router.post("/login")
async def login(body: LoginRequest):
    """Authenticate a user and return a JWT access token."""
    row = await db.fetch_one(
        """SELECT u.id, u.email, u.password_hash, u.role, u.customer_id, u.name, u.status,
                  c.name AS customer_name, c.account_type, c.ucaas_enabled
           FROM users u
           LEFT JOIN customers c ON u.customer_id = c.id
           WHERE u.email = $1""",
        body.email,
    )
    if not row:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user = dict(row)

    if user["status"] != "active":
        raise HTTPException(status_code=403, detail="Account is disabled")

    if not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Update last_login timestamp
    await db.execute(
        "UPDATE users SET last_login = $1 WHERE id = $2",
        datetime.now(timezone.utc),
        user["id"],
    )

    token = create_access_token({
        "sub": str(user["id"]),
        "email": user["email"],
        "role": user["role"],
        "customer_id": user["customer_id"],
    })

    # Compute effective UCaaS access from account_type + ucaas_enabled flag
    account_type = user.get("account_type")
    has_ucaas = (
        account_type == "ucaas"
        or (account_type in ("api", "trunk", "hybrid") and user.get("ucaas_enabled"))
    )

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "email": user["email"],
            "name": user["name"],
            "role": user["role"],
            "customer_id": user["customer_id"],
            "customer_name": user.get("customer_name"),
            "account_type": account_type,
            "ucaas_enabled": bool(user.get("ucaas_enabled")),
            "has_ucaas": has_ucaas,
        },
    }


# ---------------------------------------------------------------------------
# Protected endpoints
# ---------------------------------------------------------------------------

@router.get("/me")
async def get_me(user: dict = Depends(get_current_user)):
    """Return fresh user info from the database (not cached JWT claims)."""
    row = await db.fetch_one(
        """SELECT u.id, u.email, u.name, u.role, u.customer_id, u.status,
                  u.created_at, u.last_login, c.name AS customer_name,
                  c.account_type, c.ucaas_enabled
           FROM users u
           LEFT JOIN customers c ON u.customer_id = c.id
           WHERE u.id = $1""",
        int(user["sub"]),
    )
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    result = dict(row)
    # Compute effective UCaaS access from account_type + ucaas_enabled flag
    account_type = result.get("account_type")
    result["has_ucaas"] = (
        account_type == "ucaas"
        or (account_type in ("api", "trunk", "hybrid") and result.get("ucaas_enabled"))
    )
    return result


@router.post("/register")
async def register_user(body: RegisterRequest, admin: dict = Depends(require_admin)):
    """Create a new user (admin only).

    If the user's customer has UCaaS access (account_type='ucaas' or
    ucaas_enabled=true), an extension is automatically provisioned and
    returned in the response under the ``extension`` key.
    """
    # Check for duplicate email
    existing = await db.fetch_one("SELECT id FROM users WHERE email = $1", body.email)
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    # Validate role
    if body.role not in ("admin", "user", "readonly"):
        raise HTTPException(status_code=400, detail="Invalid role. Must be admin, user, or readonly")

    hashed = hash_password(body.password)
    row = await db.fetch_one(
        """INSERT INTO users (email, password_hash, name, role, customer_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, email, name, role, customer_id, status, created_at, last_login""",
        body.email, hashed, body.name, body.role, body.customer_id,
    )
    result = dict(row)

    # Auto-provision extension for UCaaS-enabled customers
    if body.customer_id and await _has_ucaas_access(body.customer_id):
        ext = await _provision_extension(result["id"], body.customer_id, body.name)
        result["extension"] = ext
    else:
        result["extension"] = None

    return result


@router.get("/users")
async def list_users(admin: dict = Depends(require_admin)):
    """List all users with their associated customer name (admin only)."""
    rows = await db.fetch_all(
        """SELECT u.id, u.email, u.name, u.role, u.customer_id, u.status,
                  u.created_at, u.last_login, c.name AS customer_name,
                  c.account_type, c.ucaas_enabled
           FROM users u
           LEFT JOIN customers c ON u.customer_id = c.id
           ORDER BY u.created_at DESC"""
    )
    results = []
    for r in rows:
        d = dict(r)
        account_type = d.get("account_type")
        d["has_ucaas"] = (
            account_type == "ucaas"
            or (account_type in ("api", "trunk", "hybrid") and d.get("ucaas_enabled"))
        )
        results.append(d)
    return results


@router.put("/users/{user_id}")
async def update_user(user_id: int, body: UserUpdate, admin: dict = Depends(require_admin)):
    """Update a user's details (admin only). If password is provided it will be re-hashed."""
    updates = []
    values = []
    idx = 1

    for field, value in body.model_dump(exclude_none=True).items():
        if field == "password":
            updates.append(f"password_hash = ${idx}")
            values.append(hash_password(value))
        else:
            if field == "role" and value not in ("admin", "user", "readonly"):
                raise HTTPException(status_code=400, detail="Invalid role")
            if field == "status" and value not in ("active", "disabled"):
                raise HTTPException(status_code=400, detail="Invalid status")
            updates.append(f"{field} = ${idx}")
            values.append(value)
        idx += 1

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    values.append(user_id)
    query = f"""
        UPDATE users SET {', '.join(updates)}
        WHERE id = ${idx}
        RETURNING id, email, name, role, customer_id, status, created_at, last_login
    """
    row = await db.fetch_one(query, *values)
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return dict(row)


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, admin: dict = Depends(require_admin)):
    """Delete a user (admin only). Cannot delete yourself."""
    if str(user_id) == admin["sub"]:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    result = await db.execute("DELETE FROM users WHERE id = $1", user_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "deleted", "user_id": user_id}
