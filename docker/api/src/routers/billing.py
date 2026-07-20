"""Billing read endpoints — tenant-scoped balance + append-only ledger history.

Payments Wave 1 (read-only). Design: docs/PAYMENTS_SYSTEM_DESIGN.md §2, §6.

These are READ-ONLY views over the ledger built in Wave 1. There is NO money
movement here (top-ups, refunds, auto-recharge, payment methods land in later
waves behind the provider abstraction). The two endpoints let a tenant see their
own real-time balance and their own immutable ledger history.

Authorization (the canonical multi-tenant pattern — reference_multitenant_authz):
  * ``customer_filter: int | None = Depends(get_customer_filter)`` on every
    endpoint. Admin → None (may read any customer via ?customer_id=); non-admin →
    their own customer_id, and any other id 404s (existence not leaked).
  * A non-admin can NEVER read another tenant's balance or ledger.

Mounted in main.py at ``/v1/billing`` and ``/billing`` (report the include lines
to the lead — this file does not edit main.py).
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth.dependencies import get_customer_filter
from services import ledger

logger = logging.getLogger(__name__)

router = APIRouter()


def _resolve_customer_id(customer_filter: Optional[int], requested: Optional[int]) -> int:
    """Resolve which customer_id to read, enforcing tenant isolation.

    * Non-admin (customer_filter is not None): forced to their OWN customer. A
      ``customer_id`` query param that differs 404s (indistinguishable from
      missing → existence not leaked); an omitted/matching one is fine.
    * Admin (customer_filter is None): must specify ``customer_id`` (there is no
      "all tenants" ledger view here); omitting it is a 400.
    """
    if customer_filter is not None:
        if requested is not None and requested != customer_filter:
            raise HTTPException(status_code=404, detail="Customer not found")
        return customer_filter
    if requested is None:
        raise HTTPException(
            status_code=400,
            detail="customer_id query param is required for admin billing reads",
        )
    return requested


@router.get("/balance")
async def get_billing_balance(
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Return a customer's real-time balance (the ledger's cached balance).

    Tenant-scoped: a non-admin reads only their own balance; a cross-tenant id
    404s. Admins pass ``?customer_id=``.
    """
    cid = _resolve_customer_id(customer_filter, customer_id)
    balance = await ledger.get_balance(cid)
    if balance is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return {"customer_id": cid, "balance": balance, "currency": "USD"}


@router.get("/ledger")
async def get_billing_ledger(
    customer_id: Optional[int] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    cursor: Optional[int] = Query(default=None, ge=1),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Return a customer's append-only ledger history, newest first, keyset-paged.

    Tenant-scoped exactly like ``/balance``. ``cursor`` is the ``id`` of the last
    entry from the previous page (only entries with ``id < cursor`` are returned);
    ``next_cursor`` in the response is the value to pass for the following page,
    or null on the last page.
    """
    cid = _resolve_customer_id(customer_filter, customer_id)
    page = await ledger.get_ledger(cid, limit=limit, cursor=cursor)
    return {
        "customer_id": cid,
        "entries": page["entries"],
        "next_cursor": page["next_cursor"],
    }
