"""Customer management endpoints."""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from db import database as db
from auth.dependencies import require_admin
from services.webhook_signing import generate_secret

router = APIRouter()


class CustomerCreate(BaseModel):
    name: str
    account_type: str = "rcf"  # rcf, api, trunk, hybrid, ucaas
    credit_limit: float = 0
    traffic_grade: str = "standard"
    daily_limit: float = 500
    cpm_limit: int = 60
    ucaas_enabled: bool = False  # UCaaS add-on for api/trunk/hybrid customers
    webhook_signing_secret: Optional[str] = None  # auto-generated if not provided


class CustomerUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    credit_limit: Optional[float] = None
    traffic_grade: Optional[str] = None
    daily_limit: Optional[float] = None
    cpm_limit: Optional[int] = None
    ucaas_enabled: Optional[bool] = None


@router.get("")
async def list_customers(
    status: Optional[str] = None,
    account_type: Optional[str] = None,
    limit: int = 100,
    offset: int = 0
):
    """List all customers with optional filters."""
    query = """
        SELECT id, name, account_type, balance, credit_limit, status,
               traffic_grade, daily_limit, cpm_limit, fraud_score,
               ucaas_enabled, created_at
        FROM customers
        WHERE 1=1
    """
    values = []
    idx = 1

    if status is not None:
        query += f" AND status = ${idx}"
        values.append(status)
        idx += 1

    if account_type is not None:
        query += f" AND account_type = ${idx}"
        values.append(account_type)
        idx += 1

    query += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    results = await db.fetch_all(query, *values)
    return [dict(r) for r in results]


@router.post("")
async def create_customer(customer: CustomerCreate):
    """Create a new customer."""
    # UCaaS account type always has UCaaS enabled implicitly
    ucaas_flag = True if customer.account_type == "ucaas" else customer.ucaas_enabled
    # Every customer gets a webhook signing secret so the programmable-voice
    # engine can always sign callbacks. Caller may supply one (e.g. migration),
    # otherwise mint a fresh 256-bit secret.
    signing_secret = customer.webhook_signing_secret or generate_secret()
    result = await db.fetch_one(
        """
        INSERT INTO customers (name, account_type, credit_limit, traffic_grade, daily_limit, cpm_limit, ucaas_enabled, webhook_signing_secret)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, name, account_type, balance, status, traffic_grade, ucaas_enabled, created_at
        """,
        customer.name, customer.account_type, customer.credit_limit,
        customer.traffic_grade, customer.daily_limit, customer.cpm_limit, ucaas_flag,
        signing_secret
    )
    return dict(result)


@router.get("/{customer_id}")
async def get_customer(customer_id: int):
    """Get customer by ID."""
    result = await db.fetch_one(
        """
        SELECT id, name, account_type, balance, credit_limit, status,
               traffic_grade, daily_limit, cpm_limit, fraud_score,
               ucaas_enabled, created_at
        FROM customers WHERE id = $1
        """,
        customer_id
    )
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)


@router.put("/{customer_id}")
async def update_customer(customer_id: int, customer: CustomerUpdate):
    """Update customer settings."""
    updates = []
    values = []
    idx = 1

    for field, value in customer.model_dump(exclude_none=True).items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    values.append(customer_id)
    query = f"""
        UPDATE customers SET {', '.join(updates)}, updated_at = NOW()
        WHERE id = ${idx}
        RETURNING id, name, account_type, status, traffic_grade, ucaas_enabled
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)


@router.delete("/{customer_id}")
async def delete_customer(customer_id: int):
    """Delete a customer and all associated records.

    All DELETEs are wrapped in a single transaction so that a failure
    midway does not leave orphaned records or a half-deleted customer.
    """
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Delete dependent records first (FK constraints)
            await conn.execute("DELETE FROM rcf_numbers WHERE customer_id = $1", customer_id)
            await conn.execute("DELETE FROM api_dids WHERE customer_id = $1", customer_id)
            # Trunk children
            await conn.execute(
                "DELETE FROM trunk_dids WHERE trunk_id IN (SELECT id FROM sip_trunks WHERE customer_id = $1)",
                customer_id,
            )
            await conn.execute(
                "DELETE FROM trunk_auth_ips WHERE trunk_id IN (SELECT id FROM sip_trunks WHERE customer_id = $1)",
                customer_id,
            )
            await conn.execute("DELETE FROM sip_trunks WHERE customer_id = $1", customer_id)
            await conn.execute("DELETE FROM api_credentials WHERE customer_id = $1", customer_id)
            # Delete customer
            result = await conn.execute("DELETE FROM customers WHERE id = $1", customer_id)
            if result == "DELETE 0":
                raise HTTPException(status_code=404, detail="Customer not found")
    return {"status": "deleted", "customer_id": customer_id}


@router.get("/{customer_id}/balance")
async def get_balance(customer_id: int):
    """Get customer balance and credit info."""
    result = await db.fetch_one(
        """
        SELECT id, balance, credit_limit, (balance + credit_limit) as available
        FROM customers WHERE id = $1
        """,
        customer_id
    )
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)


@router.get("/{customer_id}/webhook-secret")
async def get_webhook_secret(customer_id: int, admin: dict = Depends(require_admin)):
    """Return the customer's webhook signing secret (admin only).

    Used by an operator to share the secret with the customer so they can verify
    the `X-Revup-Signature` header on programmable-voice webhook callbacks.
    """
    result = await db.fetch_one(
        "SELECT id, webhook_signing_secret FROM customers WHERE id = $1",
        customer_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    secret = result["webhook_signing_secret"]
    if not secret:
        # Self-heal: a customer predating the migration backfill (should not
        # happen on a fresh init) — mint and persist one now.
        secret = generate_secret()
        await db.execute(
            "UPDATE customers SET webhook_signing_secret = $1, updated_at = NOW() WHERE id = $2",
            secret, customer_id,
        )
    return {
        "customer_id": result["id"],
        "webhook_signing_secret": secret,
        "signature_header": "X-Revup-Signature",
    }


@router.post("/{customer_id}/webhook-secret/rotate")
async def rotate_webhook_secret(customer_id: int, admin: dict = Depends(require_admin)):
    """Rotate (regenerate) the customer's webhook signing secret (admin only).

    Returns the NEW secret. After rotation, callbacks are signed with the new
    secret immediately — the customer must update their verifier in lockstep.
    """
    new_secret = generate_secret()
    result = await db.fetch_one(
        """
        UPDATE customers SET webhook_signing_secret = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, webhook_signing_secret
        """,
        new_secret, customer_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return {
        "customer_id": result["id"],
        "webhook_signing_secret": result["webhook_signing_secret"],
        "signature_header": "X-Revup-Signature",
        "rotated": True,
    }


@router.post("/{customer_id}/credit")
async def add_credit(customer_id: int, amount: float):
    """Add credit to customer balance."""
    result = await db.fetch_one(
        """
        UPDATE customers SET balance = balance + $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, balance
        """,
        amount, customer_id
    )
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)
