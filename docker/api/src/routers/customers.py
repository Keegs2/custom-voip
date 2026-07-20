"""Customer management endpoints.

Authorization model (P0 security hardening):
  - Customer records carry balances, credit limits, account-type/limits, and the
    fraud controls (international_calling_enabled, max_concurrent_calls). These are
    all privileged, billing-affecting fields, so every list/create/read-all/
    update/delete/credit operation is ADMIN-ONLY (``require_admin``).
  - The one customer-facing read is ``GET /{id}/balance``: it is tenant-scoped
    via ``get_customer_filter`` so a non-admin may read ONLY their own balance
    (cross-tenant → 404, existence not leaked); admins may read any customer.
  - Money-mutating / destructive admin actions (add_credit, delete_customer)
    emit a structured audit log line (actor + action + target + delta) so a
    credit change or deletion is never silently applied. There is no general
    admin audit TABLE yet (voicemail has its own ``voicemail_access_log``); this
    is the "at minimum structured-log the actor + action + target" contract.
"""
import json
import logging
import uuid
from decimal import Decimal
from fastapi import APIRouter, HTTPException, Depends, Request, Query
from pydantic import BaseModel, field_validator
from typing import Optional
from db import database as db
from auth.dependencies import require_admin, get_customer_filter
from services.webhook_signing import generate_secret
from services import ledger

router = APIRouter()
logger = logging.getLogger(__name__)


async def _audit_admin(action: str, *, actor: dict, target_customer_id: int,
                       detail: Optional[dict] = None, ip: Optional[str] = None) -> None:
    """Audit a privileged customer mutation (credit/delete): structured log line
    PLUS a durable ``admin_audit_log`` row (SOC 2 audit-trail control).

    Best-effort and non-raising on BOTH sinks: an audit failure must never abort
    the underlying admin action, but the action must never be silent either. Emits
    actor identity (from the verified JWT claims), the action, the target
    customer, and a detail dict (e.g. amount + resulting balance for a credit)."""
    try:
        logger.info(
            "ADMIN_AUDIT action=%s actor_user=%s actor_email=%s target_customer=%s detail=%s",
            action,
            actor.get("sub"),
            actor.get("email"),
            target_customer_id,
            detail or {},
        )
    except Exception:  # noqa: BLE001 — auditing must never break the request
        logger.debug("admin audit log emit failed", exc_info=True)
    # Durable row — the queryable SOC 2 audit trail. Non-raising: if the
    # admin_audit_log table is absent (migration not yet applied) or the insert
    # fails, we swallow it so the credit/delete still succeeds.
    try:
        actor_sub = actor.get("sub")
        await db.execute(
            """
            INSERT INTO admin_audit_log
                (actor_user_id, actor_email, action, target_type, target_id, detail, ip_address)
            VALUES ($1::int, $2::text, $3::text, 'customer', $4::text, $5::jsonb, $6::text)
            """,
            int(actor_sub) if actor_sub is not None else None,
            actor.get("email"), action, str(target_customer_id),
            json.dumps(detail) if detail else None, ip,
        )
    except Exception:  # noqa: BLE001 — durable audit is best-effort
        logger.debug("admin audit log persist failed", exc_info=True)


class CustomerCreate(BaseModel):
    name: str
    account_type: str = "rcf"  # rcf, api, trunk, hybrid, ucaas
    credit_limit: float = 0
    traffic_grade: str = "standard"
    daily_limit: float = 500
    cpm_limit: int = 60
    ucaas_enabled: bool = False  # UCaaS add-on for api/trunk/hybrid customers
    voicemail_enabled: bool = False  # Visual Voicemail add-on — orthogonal to account_type
    # --- RCF fraud controls (contract with the telephony/FreeSWITCH RCF path) ---
    # international_calling_enabled gates non-NANP forward/dial destinations; the
    # FreeSWITCH RCF Lua path reads it via a synchronous PG lookup at call time,
    # and rcf.py enforces it at provisioning time (defense in depth).
    international_calling_enabled: bool = False
    max_concurrent_calls: int = 30  # per-customer concurrent-call cap (telephony-enforced)
    webhook_signing_secret: Optional[str] = None  # auto-generated if not provided

    @field_validator("max_concurrent_calls")
    @classmethod
    def _validate_max_concurrent(cls, v: int) -> int:
        if v < 0 or v > 100000:
            raise ValueError("max_concurrent_calls must be between 0 and 100000")
        return v


class CustomerUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    credit_limit: Optional[float] = None
    traffic_grade: Optional[str] = None
    daily_limit: Optional[float] = None
    cpm_limit: Optional[int] = None
    ucaas_enabled: Optional[bool] = None
    voicemail_enabled: Optional[bool] = None
    # RCF fraud controls — admin-toggled per customer (see CustomerCreate).
    international_calling_enabled: Optional[bool] = None
    max_concurrent_calls: Optional[int] = None

    @field_validator("max_concurrent_calls")
    @classmethod
    def _validate_max_concurrent(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and (v < 0 or v > 100000):
            raise ValueError("max_concurrent_calls must be between 0 and 100000")
        return v


@router.get("")
async def list_customers(
    status: Optional[str] = None,
    account_type: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    admin: dict = Depends(require_admin),
):
    """List all customers with optional filters. Admin-only: exposes every
    tenant's balances, limits, and account type."""
    query = """
        SELECT id, name, account_type, balance, credit_limit, status,
               traffic_grade, daily_limit, cpm_limit, fraud_score,
               ucaas_enabled, voicemail_enabled,
               international_calling_enabled, max_concurrent_calls, created_at
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
async def create_customer(customer: CustomerCreate, admin: dict = Depends(require_admin)):
    """Create a new customer. Admin-only: provisioning + sets account_type/limits."""
    # UCaaS account type always has UCaaS enabled implicitly
    ucaas_flag = True if customer.account_type == "ucaas" else customer.ucaas_enabled
    # Visual Voicemail is an add-on orthogonal to account_type — persist the
    # provided boolean as-is, NEVER derive it from account_type.
    voicemail_flag = customer.voicemail_enabled
    # Every customer gets a webhook signing secret so the programmable-voice
    # engine can always sign callbacks. Caller may supply one (e.g. migration),
    # otherwise mint a fresh 256-bit secret.
    signing_secret = customer.webhook_signing_secret or generate_secret()
    result = await db.fetch_one(
        """
        INSERT INTO customers (name, account_type, credit_limit, traffic_grade, daily_limit, cpm_limit, ucaas_enabled, voicemail_enabled, international_calling_enabled, max_concurrent_calls, webhook_signing_secret)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, name, account_type, balance, status, traffic_grade, ucaas_enabled, voicemail_enabled, international_calling_enabled, max_concurrent_calls, created_at
        """,
        customer.name, customer.account_type, customer.credit_limit,
        customer.traffic_grade, customer.daily_limit, customer.cpm_limit, ucaas_flag,
        voicemail_flag, customer.international_calling_enabled,
        customer.max_concurrent_calls, signing_secret
    )
    return dict(result)


@router.get("/{customer_id}")
async def get_customer(customer_id: int, admin: dict = Depends(require_admin)):
    """Get customer by ID. Admin-only: full record incl. balance/limits/fraud
    controls (a non-admin's own limited view is served by /{id}/balance)."""
    result = await db.fetch_one(
        """
        SELECT id, name, account_type, balance, credit_limit, status,
               traffic_grade, daily_limit, cpm_limit, fraud_score,
               ucaas_enabled, voicemail_enabled,
               international_calling_enabled, max_concurrent_calls, created_at
        FROM customers WHERE id = $1
        """,
        customer_id
    )
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)


@router.put("/{customer_id}")
async def update_customer(customer_id: int, customer: CustomerUpdate, admin: dict = Depends(require_admin)):
    """Update customer settings. Admin-only: flips account_type/limits, credit
    limit, and the RCF fraud controls (international calling + concurrency cap)."""
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
        RETURNING id, name, account_type, status, traffic_grade, ucaas_enabled,
                  voicemail_enabled, international_calling_enabled, max_concurrent_calls
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)


@router.delete("/{customer_id}")
async def delete_customer(customer_id: int, admin: dict = Depends(require_admin)):
    """Delete a customer and all associated records. Admin-only + audited.

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
    await _audit_admin("customer_delete", actor=admin, target_customer_id=customer_id)
    return {"status": "deleted", "customer_id": customer_id}


@router.get("/{customer_id}/balance")
async def get_balance(
    customer_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get customer balance and credit info.

    Tenant-scoped: a non-admin may read ONLY their own customer's balance; any
    other id 404s (indistinguishable from missing, so existence is not leaked).
    Admins (customer_filter is None) may read any customer's balance."""
    if customer_filter is not None and customer_id != customer_filter:
        raise HTTPException(status_code=404, detail="Customer not found")
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
async def add_credit(
    customer_id: int,
    amount: float,
    idempotency_key: Optional[str] = Query(
        default=None,
        description="Optional idempotency key; a repeated call with the same key "
                    "posts the credit only ONCE. Omit for a fresh one-shot credit.",
    ),
    admin: dict = Depends(require_admin),
):
    """Add credit to customer balance. Admin-only + audited + LEDGERED.

    This mutates money, so it is restricted to admins and every change is logged
    with the acting admin, the target customer, the amount, and the resulting
    balance — a credit is never applied silently.

    The credit is routed through the append-only ledger (``post_ledger_entry``),
    NOT a direct ``balance = balance + …`` write: the customers.balance cache is
    only ever moved inside the ledger service so the reconciliation invariant
    (SUM(ledger.amount) == balance) holds. entry_type ``topup`` for a positive
    credit, ``adjustment`` for a negative correction; source ``admin``. The op is
    idempotent on ``idempotency_key`` (defaults to a fresh UUID → one-shot).
    Response shape ({id, balance}) is unchanged.
    """
    # Reject NaN/inf and coerce to an EXACT Decimal via str (never let a binary
    # float enter the ledger). The ledger service also rejects raw floats.
    import math
    if not math.isfinite(amount):
        raise HTTPException(status_code=422, detail="amount must be a finite number")
    dec_amount = Decimal(str(amount))

    # Existence check first so a bad id 404s (not a ledger ValueError) — matches
    # the prior behavior where a missing customer returned 404.
    exists = await db.fetch_one("SELECT id FROM customers WHERE id = $1::int", customer_id)
    if not exists:
        raise HTTPException(status_code=404, detail="Customer not found")

    key = idempotency_key or f"admin_credit:{customer_id}:{uuid.uuid4()}"
    # Positive credit → topup; negative correction → adjustment (both source=admin).
    entry_type = "topup" if dec_amount >= 0 else "adjustment"

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            entry = await ledger.post_ledger_entry(
                conn,
                customer_id=customer_id,
                amount=dec_amount,
                entry_type=entry_type,
                source="admin",
                idempotency_key=key,
                metadata={
                    "reason": "admin_credit",
                    "actor_user": admin.get("sub"),
                    "actor_email": admin.get("email"),
                },
            )
    new_balance = entry["balance_after"]

    await _audit_admin(
        "customer_credit",
        actor=admin,
        target_customer_id=customer_id,
        detail={
            "amount": float(dec_amount),
            "new_balance": float(new_balance) if new_balance is not None else None,
            "ledger_entry_id": entry["id"],
            "idempotency_key": key,
        },
    )
    return {"id": customer_id, "balance": new_balance}
