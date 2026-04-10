"""Authentication and user management endpoints."""
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, field_validator
import re
from typing import Optional
from datetime import datetime, timezone

from db import database as db
from auth.security import verify_password, hash_password, create_access_token
from auth.dependencies import get_current_user, require_admin

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
# Public endpoints
# ---------------------------------------------------------------------------

@router.post("/login")
async def login(body: LoginRequest):
    """Authenticate a user and return a JWT access token."""
    row = await db.fetch_one(
        "SELECT id, email, password_hash, role, customer_id, name, status FROM users WHERE email = $1",
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

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "email": user["email"],
            "name": user["name"],
            "role": user["role"],
            "customer_id": user["customer_id"],
        },
    }


# ---------------------------------------------------------------------------
# Protected endpoints
# ---------------------------------------------------------------------------

@router.get("/me")
async def get_me(user: dict = Depends(get_current_user)):
    """Return fresh user info from the database (not cached JWT claims)."""
    row = await db.fetch_one(
        """SELECT id, email, name, role, customer_id, status, created_at, last_login
           FROM users WHERE id = $1""",
        int(user["sub"]),
    )
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return dict(row)


@router.post("/register")
async def register_user(body: RegisterRequest, admin: dict = Depends(require_admin)):
    """Create a new user (admin only)."""
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
    return dict(row)


@router.get("/users")
async def list_users(admin: dict = Depends(require_admin)):
    """List all users with their associated customer name (admin only)."""
    rows = await db.fetch_all(
        """SELECT u.id, u.email, u.name, u.role, u.customer_id, u.status,
                  u.created_at, u.last_login, c.name AS customer_name
           FROM users u
           LEFT JOIN customers c ON u.customer_id = c.id
           ORDER BY u.created_at DESC"""
    )
    return [dict(r) for r in rows]


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
