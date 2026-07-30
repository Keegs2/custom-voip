"""API-credential management for programmable-voice customers.

Lets a customer mint / list / revoke the API key-pairs they use for
machine-to-machine access to the programmable-voice REST API (see
auth/api_key.py for how these are verified on requests).

Contract (tenant-scoped via get_customer_filter; admin may pass ?customer_id):
  GET    ""       -> [{ id, api_key, label, status, created_at,
                        last_used_at, status_callback_url }]   (never the secret)
  POST   ""       body: { label?, status_callback_url? }
                  -> { id, api_key, api_secret, label, created_at }
                     (api_secret is shown ONCE; only its bcrypt hash is stored)
  DELETE "/{id}"  -> revoke (enabled=false); owner-scoped 404-no-leak

`status` is derived from the existing `enabled` column: true -> 'active',
false -> 'revoked'. The secret is never persisted in plaintext and is never
returned after creation.
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from db import database as db
from auth.dependencies import get_customer_filter
from auth.security import hash_password
from auth.api_key import generate_api_key, generate_api_secret

logger = logging.getLogger(__name__)

router = APIRouter()


class CredentialCreate(BaseModel):
    label: Optional[str] = None
    status_callback_url: Optional[str] = None


def _status_of(enabled: bool) -> str:
    return "active" if enabled else "revoked"


def _credential_out(row) -> dict:
    """Shape a row for the list response. NEVER includes the secret/hash."""
    return {
        "id": row["id"],
        "api_key": row["api_key"],
        "label": row["label"],
        "status": _status_of(row["enabled"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "last_used_at": row["last_used_at"].isoformat() if row["last_used_at"] else None,
        "status_callback_url": row["status_callback_url"],
    }


async def _get_owned_credential(cred_id: int, customer_filter: int | None):
    """Fetch a credential enforcing tenant isolation (404 cross-tenant/missing)."""
    row = await db.fetch_one(
        """
        SELECT id, customer_id
        FROM api_credentials
        WHERE id = $1::int AND ($2::int IS NULL OR customer_id = $2::int)
        """,
        cred_id, customer_filter,
    )
    if not row:
        raise HTTPException(status_code=404, detail="API credential not found")
    return row


@router.get("")
async def list_credentials(
    customer_id: Optional[int] = None,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List the caller's API credentials (secret is never returned)."""
    # Non-admins are hard-scoped to their own customer; admins may pass ?customer_id.
    effective_customer = customer_filter if customer_filter is not None else customer_id

    query = """
        SELECT id, api_key, label, enabled, created_at, last_used_at,
               status_callback_url
        FROM api_credentials
    """
    values = []
    if effective_customer is not None:
        query += " WHERE customer_id = $1::int"
        values.append(effective_customer)
    query += " ORDER BY created_at DESC"

    rows = await db.fetch_all(query, *values)
    return [_credential_out(r) for r in rows]


@router.post("")
async def create_credential(
    body: CredentialCreate,
    customer_id: Optional[int] = None,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Generate a new API credential. The api_secret is returned ONCE.

    Only the bcrypt hash of the secret is stored; it can never be retrieved
    afterwards. Returns { id, api_key, api_secret, label, created_at }.
    """
    # Non-admins create under their own customer; admins target one via ?customer_id.
    owner = customer_filter if customer_filter is not None else customer_id
    if owner is None:
        raise HTTPException(status_code=400, detail="customer_id is required")

    # Verify the target customer exists (FK would 500 otherwise; give a clean 404).
    exists = await db.fetch_one(
        "SELECT 1 FROM customers WHERE id = $1::int", owner
    )
    if not exists:
        raise HTTPException(status_code=404, detail="Customer not found")

    api_key = generate_api_key()
    api_secret = generate_api_secret()
    secret_hash = hash_password(api_secret)

    row = await db.fetch_one(
        """
        INSERT INTO api_credentials
            (customer_id, api_key, api_secret_hash, label, status_callback_url, enabled)
        VALUES ($1::int, $2::varchar, $3::varchar, $4::varchar, $5::varchar, true)
        RETURNING id, api_key, label, created_at
        """,
        owner, api_key, secret_hash, body.label, body.status_callback_url,
    )

    return {
        "id": row["id"],
        "api_key": row["api_key"],
        "api_secret": api_secret,   # shown ONCE — never stored/returned again
        "label": row["label"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


@router.delete("/{cred_id}", status_code=204)
async def revoke_credential(
    cred_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Revoke a credential (sets status='revoked' via enabled=false).

    Owner-scoped, 404-no-leak. Revocation is a soft-disable so the row (and its
    audit trail / last_used_at) is preserved and the api_key can never be reused.
    """
    await _get_owned_credential(cred_id, customer_filter)
    await db.execute(
        "UPDATE api_credentials SET enabled = false WHERE id = $1::int",
        cred_id,
    )
    return None
