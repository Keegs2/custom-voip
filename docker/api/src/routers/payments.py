"""Payments router — the exec-facing monetary DEMO (Payments §9 DEMO MODE).

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §9 (the exec story + this exact API
contract). Mounted at ``/v1/payments`` and ``/payments``.

WHAT THIS IS: a production-shaped demo of the whole monetary system that runs
with NO live Stripe/Coinbase account and moves NO real money, by driving the REAL
Wave-1 ledger + REAL rail logic through the SIMULATION providers
(``services.payments.demo_providers``). Flip ``PAYMENTS_DEMO_MODE=false`` + supply
real keys and these SAME endpoints run on the live rails against the SAME ledger.

SAFETY / SCOPING (enforced on every endpoint):
  * ``_require_demo_mode`` — the whole router 404s unless ``PAYMENTS_DEMO_MODE``
    is on, so it is dormant in a normal deployment.
  * Tenant reads use ``get_customer_filter`` (non-admin → own customer only,
    cross-tenant → 404 not leaked); provisioning + ALL ``/demo/*`` control is
    ``require_admin``.
  * The demo is isolated to a DEDICATED ``is_demo`` customer ("DEMO — Acme
    Robotics", see services.demo_seed) so it never pollutes a real balance, and
    it touches NO carrier/call path.
  * Every money event (topup/usage/fee/refund) goes through
    ``services.ledger.post_ledger_entry`` with an idempotency key — the balance
    cache is NEVER written directly (reconciliation invariant holds).

Money is ``decimal.Decimal`` dollars internally (DECIMAL(12,4)); the integer-cents
/ USDC-6-decimal conversions happen only inside the providers, never here or in
the ledger.
"""
from __future__ import annotations

import json
import logging
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator

from auth.dependencies import get_customer_filter, require_admin
from db import database as db
from services import auto_recharge, demo_seed, ledger
from services.payments import (
    PaymentError,
    demo_mode_enabled,
    get_demo_providers,
    get_payment_provider,
)

router = APIRouter()
logger = logging.getLogger(__name__)

# x402 v2 header names (design §4 Rail B note: v2 uses PAYMENT-* not X-PAYMENT-*).
H_PAYMENT_REQUIRED = "PAYMENT-REQUIRED"
H_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE"
H_PAYMENT_RESPONSE = "PAYMENT-RESPONSE"

# The USDC micro-charge a single metered machine request costs (design §9 story 3).
METERED_PRICE = Decimal("0.0100")


# ===========================================================================
# gating + tenant helpers
# ===========================================================================
def _require_demo_mode() -> None:
    """404 the whole router unless PAYMENTS_DEMO_MODE is on.

    Keeps the demo dormant in a normal deployment: without the flag, none of these
    paths exist to a caller (404, not 403 — we don't advertise the feature).
    """
    if not demo_mode_enabled():
        raise HTTPException(status_code=404, detail="Not found")


async def _resolve_tenant(customer_filter: Optional[int], requested: Optional[int]) -> int:
    """Resolve the customer to act on, enforcing tenant isolation.

    * Non-admin (filter set): forced to their own customer; a differing
      ``customer_id`` 404s (existence not leaked).
    * Admin (filter None): may name any ``customer_id``; if omitted, defaults to
      the seeded demo customer (so the exec can hit endpoints without knowing the id).
    """
    if customer_filter is not None:
        if requested is not None and requested != customer_filter:
            raise HTTPException(status_code=404, detail="Customer not found")
        return customer_filter
    if requested is not None:
        return requested
    demo_id = await demo_seed.get_demo_customer_id()
    if demo_id is None:
        raise HTTPException(status_code=400,
                            detail="customer_id is required (demo not seeded — POST /demo/seed first)")
    return demo_id


def _dec(value: Any, field: str) -> Decimal:
    """Coerce a request amount to an EXACT Decimal via str (never a binary float)."""
    try:
        d = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise HTTPException(status_code=422, detail=f"{field} must be a numeric amount")
    if not d.is_finite():
        raise HTTPException(status_code=422, detail=f"{field} must be finite")
    return d


# ===========================================================================
# Pydantic request models
# ===========================================================================
class SetupIntentRequest(BaseModel):
    brand: str = "visa"  # visa | amex | mastercard (demo card to mint)


class AddMethodRequest(BaseModel):
    """Persist a payment method after the (simulated) Payment Element confirms.

    In production the frontend confirms the SetupIntent in the Stripe iframe and
    posts back the resulting ``provider_pm_id``/``brand``/``last4``; the demo lets
    the client either pass those (from ``setup-intent``) or omit them to have the
    provider mint a card in one call.
    """
    provider_pm_id: Optional[str] = None
    provider_customer_id: Optional[str] = None
    brand: Optional[str] = None
    last4: Optional[str] = None
    exp_month: Optional[int] = None
    exp_year: Optional[int] = None
    make_default: bool = True
    client_secret: Optional[str] = None  # from setup-intent; accepted, not required


class TopupRequest(BaseModel):
    amount: float = Field(..., gt=0)
    rail: str = "card"  # card | usdc  → which simulated rail settles the top-up

    @field_validator("rail")
    @classmethod
    def _valid_rail(cls, v: str) -> str:
        if v not in ("card", "usdc"):
            raise ValueError("rail must be 'card' or 'usdc'")
        return v


class AutoRechargeUpdate(BaseModel):
    enabled: Optional[bool] = None
    threshold: Optional[float] = None
    recharge_amount: Optional[float] = None
    payment_method_id: Optional[int] = None
    daily_cap: Optional[float] = None
    cooldown_seconds: Optional[int] = None


class MppSessionRequest(BaseModel):
    spend_limit: float = Field(..., gt=0)
    label: Optional[str] = None


class MppChargeRequest(BaseModel):
    amount: float = Field(..., gt=0)
    settle: bool = False  # when true, settle the tab after adding this charge


# ===========================================================================
# 1) PAYMENT METHODS  — /setup-intent, /methods, /topup
# ===========================================================================
@router.post("/setup-intent")
async def create_setup_intent(
    body: SetupIntentRequest = Body(default=SetupIntentRequest()),
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Begin a card-on-file setup (simulated Stripe SetupIntent + hosted element).

    Returns the ``client_secret`` a real Payment Element would use (PCI SAQ-A —
    we never see the card) PLUS the ``pm``/``brand``/``last4`` the demo mints so
    the client can immediately POST /methods. Tenant-scoped.

    Response: {provider, client_secret, provider_customer_id, payment_method,
               brand, last4, exp_month, exp_year}
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    provider = get_payment_provider()
    setup = await provider.create_setup(customer_id=cid, metadata={"brand": body.brand})
    raw = setup.raw or {}
    return {
        "provider": setup.provider,
        "client_secret": setup.client_secret,
        "provider_customer_id": setup.provider_customer_id,
        "payment_method": raw.get("payment_method"),
        "brand": raw.get("brand"),
        "last4": raw.get("last4"),
        "exp_month": raw.get("exp_month"),
        "exp_year": raw.get("exp_year"),
    }


@router.post("/methods")
async def add_payment_method(
    body: AddMethodRequest = Body(default=AddMethodRequest()),
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Save a payment method (tokens + display metadata only — NEVER a PAN/CVV).

    If the client didn't pass ``provider_pm_id`` (e.g. skipping the iframe in the
    demo), the provider mints a card first. When ``make_default`` is true, unset
    any prior default so exactly one default remains.

    Response: the persisted method
    {id, customer_id, provider, provider_pm_id, brand, last4, exp_month, exp_year,
     is_default, status, created_at}
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    provider = get_payment_provider()

    pm_id = body.provider_pm_id
    cus_id = body.provider_customer_id
    brand = body.brand
    last4 = body.last4
    exp_month = body.exp_month
    exp_year = body.exp_year

    # Mint a card if the client didn't carry one back from setup-intent.
    if not pm_id:
        setup = await provider.create_setup(customer_id=cid,
                                            metadata={"brand": brand or "visa"})
        raw = setup.raw or {}
        pm_id = raw.get("payment_method")
        cus_id = cus_id or setup.provider_customer_id
        brand = brand or raw.get("brand")
        last4 = last4 or raw.get("last4")
        exp_month = exp_month or raw.get("exp_month")
        exp_year = exp_year or raw.get("exp_year")

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            if body.make_default:
                await conn.execute(
                    "UPDATE payment_methods SET is_default = false WHERE customer_id = $1::int AND is_default",
                    cid,
                )
            row = await conn.fetchrow(
                """
                INSERT INTO payment_methods
                    (customer_id, provider, provider_pm_id, provider_customer_id,
                     brand, last4, exp_month, exp_year, is_default, status)
                VALUES ($1::int, $2::text, $3::text, $4::text, $5::text, $6::text,
                        $7::smallint, $8::smallint, $9::bool, 'active')
                RETURNING id, customer_id, provider, provider_pm_id, provider_customer_id,
                          brand, last4, exp_month, exp_year, is_default, status, created_at
                """,
                cid, provider.name, pm_id, cus_id, brand, last4,
                exp_month, exp_year, body.make_default,
            )
    return dict(row)


@router.get("/methods")
async def list_payment_methods(
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """List a customer's active payment methods (tokens + display metadata only).

    Response: {customer_id, methods: [ {id, provider, provider_pm_id, brand,
               last4, exp_month, exp_year, is_default, status, created_at} ]}
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    rows = await db.fetch_all(
        """
        SELECT id, provider, provider_pm_id, brand, last4, exp_month, exp_year,
               is_default, status, created_at
        FROM payment_methods
        WHERE customer_id = $1::int AND status = 'active'
        ORDER BY is_default DESC, id ASC
        """,
        cid,
    )
    return {"customer_id": cid, "methods": [dict(r) for r in rows]}


@router.delete("/methods/{method_id}")
async def delete_payment_method(
    method_id: int,
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Remove (soft-delete) a payment method. Tenant-scoped: a method belonging to
    another customer 404s (existence not leaked).

    Response: {status: "removed", id}
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    row = await db.fetch_one(
        """
        UPDATE payment_methods SET is_default = false, status = 'removed'
        WHERE id = $1::bigint AND customer_id = $2::int AND status = 'active'
        RETURNING id
        """,
        method_id, cid,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Payment method not found")
    return {"status": "removed", "id": method_id}


@router.post("/topup")
async def topup(
    body: TopupRequest,
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """One-off top-up on the chosen rail (card = Stripe, usdc = Stripe stablecoin).

    Charges the (simulated) provider, records a payment_transactions row, and
    posts a REAL ``topup`` ledger entry — so the balance/history is genuine. The
    ``usdc`` rail demonstrates a large B2B stablecoin prepay (design §9 story 5).

    Response: {status, amount, currency, rail, provider_ref, ledger_entry_id,
               balance} — status is "succeeded" (a demo top-up on file always
               settles; the decline path is exercised via auto-recharge).
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    amount = _dec(body.amount, "amount")

    providers = get_demo_providers()
    if body.rail == "usdc":
        # Stablecoin top-up via the x402/USDC rail — settle then ledger as stripe_crypto.
        settle = await providers.x402.verify_and_settle(
            amount=amount, resource="topup", payment_signature=f"demo-topup-{uuid.uuid4()}")
        provider_ref = settle.tx_hash
        source = "stripe_crypto"
        raw = settle.raw
        provider_name = "stripe"
    else:
        cus = await db.fetch_one(
            "SELECT provider_customer_id, provider_pm_id FROM payment_methods "
            "WHERE customer_id = $1::int AND status='active' ORDER BY is_default DESC, id ASC LIMIT 1",
            cid,
        )
        result = await providers.stripe.charge(
            customer_id=cid, amount=amount,
            idempotency_key=f"topup:{cid}:{uuid.uuid4()}",
            payment_method_ref=cus["provider_pm_id"] if cus else None,
            provider_customer_id=cus["provider_customer_id"] if cus else None,
            metadata={"reason": "manual_topup", "demo_outcome": "success"},
        )
        provider_ref = result.provider_ref
        source = "stripe_card"
        raw = result.raw
        provider_name = "stripe"

    entry_id, new_balance = await _record_topup(
        customer_id=cid, amount=amount, source=source,
        provider=provider_name, provider_ref=provider_ref,
        idem=f"topup:{cid}:{provider_ref}", reason="manual_topup", raw=raw,
    )
    return {
        "status": "succeeded",
        "amount": amount,
        "currency": "USD",
        "rail": body.rail,
        "provider_ref": provider_ref,
        "ledger_entry_id": entry_id,
        "balance": new_balance,
    }


async def _record_topup(
    *, customer_id: int, amount: Decimal, source: str, provider: str,
    provider_ref: Optional[str], idem: str, reason: str, raw: dict,
) -> tuple[int, Optional[Decimal]]:
    """payment_transactions + topup ledger entry in ONE transaction (idempotent)."""
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO payment_transactions
                    (customer_id, provider, provider_ref, kind, amount, currency,
                     status, idempotency_key, raw_event)
                VALUES ($1::int, $2::text, $3::text, 'topup', $4::numeric, 'USD',
                        'succeeded', $5::text, $6::jsonb)
                ON CONFLICT (idempotency_key) DO NOTHING
                """,
                customer_id, provider, provider_ref, amount, idem,
                json.dumps(raw) if raw else None,
            )
            entry = await ledger.post_ledger_entry(
                conn, customer_id=customer_id, amount=amount,
                entry_type="topup", source=source, idempotency_key=idem,
                external_ref=provider_ref, metadata={"reason": reason, "provider": provider},
            )
    return entry["id"], entry.get("balance_after")


# ===========================================================================
# 2) AUTO-RECHARGE  — GET/PUT /auto-recharge
# ===========================================================================
def _ar_out(cid: int, row: Optional[dict]) -> dict:
    """Normalize an auto_recharge_settings row for the API."""
    if row is None:
        return {
            "customer_id": cid, "enabled": False, "threshold": None,
            "recharge_amount": None, "payment_method_id": None, "currency": "USD",
            "daily_cap": None, "cooldown_seconds": 3600, "consecutive_failures": 0,
            "last_triggered_at": None, "disabled_reason": None,
        }
    d = dict(row)
    d["customer_id"] = cid
    return d


@router.get("/auto-recharge")
async def get_auto_recharge(
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Read a customer's auto-recharge settings + dunning state.

    Response: {customer_id, enabled, threshold, recharge_amount, payment_method_id,
               currency, daily_cap, cooldown_seconds, consecutive_failures,
               last_triggered_at, disabled_reason}
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    row = await db.fetch_one(
        """
        SELECT enabled, threshold, recharge_amount, payment_method_id, currency,
               daily_cap, cooldown_seconds, consecutive_failures, last_triggered_at,
               disabled_reason
        FROM auto_recharge_settings WHERE customer_id = $1::int
        """,
        cid,
    )
    return _ar_out(cid, dict(row) if row else None)


@router.put("/auto-recharge")
async def update_auto_recharge(
    body: AutoRechargeUpdate,
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Create/replace a customer's auto-recharge settings (upsert).

    Re-enabling clears any dunning ``disabled_reason`` and resets the failure
    counter (a human fixed the card). Same response shape as GET.
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)

    fields = body.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Coerce the money fields to Decimal.
    threshold = _dec(fields["threshold"], "threshold") if "threshold" in fields else None
    recharge_amount = _dec(fields["recharge_amount"], "recharge_amount") if "recharge_amount" in fields else None
    daily_cap = _dec(fields["daily_cap"], "daily_cap") if "daily_cap" in fields else None
    reenabling = fields.get("enabled") is True

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                INSERT INTO auto_recharge_settings
                    (customer_id, enabled, threshold, recharge_amount, payment_method_id,
                     daily_cap, cooldown_seconds)
                VALUES ($1::int,
                        COALESCE($2::bool, false),
                        $3::numeric, $4::numeric, $5::bigint, $6::numeric,
                        COALESCE($7::int, 3600))
                ON CONFLICT (customer_id) DO UPDATE SET
                    enabled = COALESCE($2::bool, auto_recharge_settings.enabled),
                    threshold = COALESCE($3::numeric, auto_recharge_settings.threshold),
                    recharge_amount = COALESCE($4::numeric, auto_recharge_settings.recharge_amount),
                    payment_method_id = COALESCE($5::bigint, auto_recharge_settings.payment_method_id),
                    daily_cap = COALESCE($6::numeric, auto_recharge_settings.daily_cap),
                    cooldown_seconds = COALESCE($7::int, auto_recharge_settings.cooldown_seconds),
                    consecutive_failures = CASE WHEN $8::bool THEN 0 ELSE auto_recharge_settings.consecutive_failures END,
                    disabled_reason = CASE WHEN $8::bool THEN NULL ELSE auto_recharge_settings.disabled_reason END,
                    updated_at = NOW()
                RETURNING enabled, threshold, recharge_amount, payment_method_id, currency,
                          daily_cap, cooldown_seconds, consecutive_failures, last_triggered_at,
                          disabled_reason
                """,
                cid, fields.get("enabled"), threshold, recharge_amount,
                fields.get("payment_method_id"), daily_cap, fields.get("cooldown_seconds"),
                reenabling,
            )
    return _ar_out(cid, dict(row))


# ===========================================================================
# 3) MACHINE PAYMENTS  — /demo/metered (x402), /mpp/sessions (Stripe MPP)
# ===========================================================================
@router.get("/demo/metered")
async def metered_endpoint(
    request: Request,
    response: Response,
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """A metered machine endpoint: HTTP 402 until paid, 200 + micro-charge on retry.

    The x402 (v2) flow (design §9 story 3):
      1. First call → **HTTP 402** with a ``PAYMENT-REQUIRED`` header describing
         the USDC price/pay-to/nonce (body echoes it as JSON).
      2. The agent signs an EIP-3009 authorization and retries with a
         ``PAYMENT-SIGNATURE`` header → we (simulate CDP) verify+settle, post an
         ``x402`` USDC ledger entry, add a ``PAYMENT-RESPONSE`` header (tx hash),
         and return **200** with the "resource" + settlement.

    Response (200): {ok, resource, charged, currency, settlement: {tx_hash,
                     network, asset, amount_minor, payer}, ledger_entry_id, balance}
    Response (402): {error, accepts: [...]} + PAYMENT-REQUIRED header.
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    providers = get_demo_providers()
    x402 = providers.x402
    resource = f"/v1/payments/demo/metered#customer={cid}"

    signature = request.headers.get(H_PAYMENT_SIGNATURE)
    if not signature:
        # No payment → 402 challenge.
        challenge = x402.build_challenge(amount=METERED_PRICE, resource=resource)
        response.status_code = 402
        response.headers[H_PAYMENT_REQUIRED] = challenge.header_value
        return {
            "error": "payment required",
            "accepts": [{
                "scheme": challenge.scheme,
                "network": challenge.network,
                "asset": challenge.asset,
                "amount_minor": challenge.amount_minor,
                "amount": METERED_PRICE,
                "pay_to": challenge.pay_to,
                "resource": challenge.resource,
                "nonce": challenge.nonce,
            }],
        }

    # Paid retry → verify + settle + ledger.
    try:
        settle = await x402.verify_and_settle(
            amount=METERED_PRICE, resource=resource, payment_signature=signature)
    except PaymentError as e:
        raise HTTPException(status_code=402, detail=f"x402 verification failed: {e}")

    # USDC micro-charge is money OUT of prepaid credit (usage), posted as an x402
    # ledger entry keyed by the tx hash (idempotent).
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            entry = await ledger.post_ledger_entry(
                conn, customer_id=cid, amount=-METERED_PRICE,
                entry_type="usage", source="x402",
                idempotency_key=f"x402:{settle.tx_hash}", external_ref=settle.tx_hash,
                metadata={"reason": "metered_request", "resource": resource,
                          "amount_minor": settle.amount_minor, "asset": settle.asset,
                          "network": settle.network, "payer": settle.payer},
            )
    await demo_seed.record_scenario(cid, "agent_usage",
                                    {"rail": "x402", "amount": float(METERED_PRICE),
                                     "tx_hash": settle.tx_hash})
    response.headers[H_PAYMENT_RESPONSE] = settle.header_value
    return {
        "ok": True,
        "resource": {"data": "premium telephony insight", "generated_for": cid},
        "charged": METERED_PRICE,
        "currency": "USDC",
        "settlement": {
            "tx_hash": settle.tx_hash,
            "network": settle.network,
            "asset": settle.asset,
            "amount_minor": settle.amount_minor,
            "payer": settle.payer,
        },
        "ledger_entry_id": entry["id"],
        "balance": entry.get("balance_after"),
    }


@router.post("/mpp/sessions")
async def open_mpp_session(
    body: MppSessionRequest,
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Open a spend-limited Stripe MPP agent session ("tab").

    The agent streams micro-charges onto it (POST /mpp/sessions/{id}/charge), then
    settles. Nothing hits the ledger until settlement (design §4 Rail B).

    Response: {id, provider, provider_session_id, spend_limit, total_charged,
               charge_count, currency, status, label, created_at}
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    spend_limit = _dec(body.spend_limit, "spend_limit")
    mpp = get_demo_providers().mpp
    opened = await mpp.open_session(customer_id=cid, spend_limit=spend_limit, label=body.label)

    row = await db.fetch_one(
        """
        INSERT INTO mpp_sessions
            (customer_id, provider, provider_session_id, spend_limit, total_charged,
             charge_count, currency, status, label, metadata)
        VALUES ($1::int, $2::text, $3::text, $4::numeric, 0::numeric, 0, 'USD',
                'open', $5::text, $6::jsonb)
        RETURNING id, provider, provider_session_id, spend_limit, total_charged,
                  charge_count, currency, status, label, created_at
        """,
        cid, mpp.name, opened.provider_session_id, spend_limit, body.label,
        json.dumps(opened.raw),
    )
    await demo_seed.record_scenario(cid, "mpp",
                                    {"action": "open", "session_id": row["id"],
                                     "spend_limit": float(spend_limit)})
    return dict(row)


@router.post("/mpp/sessions/{session_id}/charge")
async def charge_mpp_session(
    session_id: int,
    body: MppChargeRequest,
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Stream one micro-charge onto an MPP tab (optionally settle after).

    Enforces the session spend limit (a charge that would overrun is refused with
    409). When ``settle=true`` (or the tab is closed by hitting the limit), the
    accumulated total settles as ONE ``stripe_mpp`` ledger ``usage`` entry.

    Response: {session_id, accepted, amount, total_charged, remaining, charge_count,
               status, settled, settlement: {provider_ref, amount, ledger_entry_id,
               balance} | null, reason}
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    amount = _dec(body.amount, "amount")
    mpp = get_demo_providers().mpp

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            sess = await conn.fetchrow(
                """
                SELECT id, provider_session_id, spend_limit, total_charged, charge_count, status
                FROM mpp_sessions WHERE id = $1::bigint AND customer_id = $2::int
                FOR UPDATE
                """,
                session_id, cid,
            )
            if sess is None:
                raise HTTPException(status_code=404, detail="MPP session not found")
            if sess["status"] != "open":
                raise HTTPException(status_code=409, detail=f"session is {sess['status']}")

            charge = await mpp.stream_charge(
                current_total=sess["total_charged"], spend_limit=sess["spend_limit"],
                amount=amount,
            )
            if not charge.accepted:
                # Refuse overruns; the tab stays open at its current total.
                raise HTTPException(status_code=409,
                                    detail=f"charge refused: {charge.reason}")

            new_total = charge.new_total
            new_count = sess["charge_count"] + 1
            await conn.execute(
                """
                UPDATE mpp_sessions
                SET total_charged = $2::numeric, charge_count = $3::int, updated_at = NOW()
                WHERE id = $1::bigint
                """,
                session_id, new_total, new_count,
            )

    settled = False
    settlement = None
    status = "open"
    # Settle if explicitly requested. (The tab accumulates until then.)
    if body.settle:
        settlement = await _settle_mpp(cid, session_id)
        settled = True
        status = "settled"
    return {
        "session_id": session_id,
        "accepted": True,
        "amount": amount,
        "total_charged": new_total,
        "remaining": charge.remaining,
        "charge_count": new_count,
        "status": status,
        "settled": settled,
        "settlement": settlement,
        "reason": None,
    }


async def _settle_mpp(customer_id: int, session_id: int) -> Optional[dict]:
    """Settle an MPP tab: provider settle → payment_transactions → stripe_mpp usage
    ledger entry, all atomic. Returns the settlement summary (None if already settled)."""
    mpp = get_demo_providers().mpp
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            sess = await conn.fetchrow(
                """
                SELECT id, provider_session_id, total_charged, charge_count, status
                FROM mpp_sessions WHERE id = $1::bigint AND customer_id = $2::int
                FOR UPDATE
                """,
                session_id, customer_id,
            )
            if sess is None:
                raise HTTPException(status_code=404, detail="MPP session not found")
            if sess["status"] != "open":
                return None
            total = sess["total_charged"]
            settle = await mpp.settle_session(
                provider_session_id=sess["provider_session_id"],
                total=total, charge_count=sess["charge_count"],
            )
            idem = f"mpp_settle:{session_id}:{settle.provider_ref}"
            await conn.execute(
                """
                INSERT INTO payment_transactions
                    (customer_id, provider, provider_ref, kind, amount, currency,
                     status, idempotency_key, raw_event)
                VALUES ($1::int, 'stripe_mpp', $2::text, 'charge', $3::numeric, 'USD',
                        'succeeded', $4::text, $5::jsonb)
                ON CONFLICT (idempotency_key) DO NOTHING
                """,
                customer_id, settle.provider_ref, total, idem, json.dumps(settle.raw),
            )
            # The tab is agent SPEND against prepaid credit → money OUT (usage).
            entry = await ledger.post_ledger_entry(
                conn, customer_id=customer_id, amount=-total,
                entry_type="usage", source="stripe_mpp", idempotency_key=idem,
                external_ref=settle.provider_ref,
                metadata={"reason": "mpp_settlement", "session_id": session_id,
                          "charge_count": sess["charge_count"]},
            )
            await conn.execute(
                """
                UPDATE mpp_sessions
                SET status = 'settled', settlement_ref = $2::text, settled_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1::bigint
                """,
                session_id, settle.provider_ref,
            )
    await demo_seed.record_scenario(customer_id, "mpp",
                                    {"action": "settle", "session_id": session_id,
                                     "amount": float(total), "provider_ref": settle.provider_ref})
    return {
        "provider_ref": settle.provider_ref,
        "amount": total,
        "ledger_entry_id": entry["id"],
        "balance": entry.get("balance_after"),
    }


# ===========================================================================
# 4) INVOICES + USAGE  — GET /invoices, GET /usage
# ===========================================================================
@router.get("/invoices")
async def list_invoices(
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """List a customer's invoices (monthly plan fee + any postpaid usage invoice).

    Response: {customer_id, invoices: [ {id, provider_invoice_id, amount, currency,
               status, period_start, period_end, created_at} ]}
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    rows = await db.fetch_all(
        """
        SELECT id, provider_invoice_id, amount, currency, status, period_start,
               period_end, created_at
        FROM invoices WHERE customer_id = $1::int ORDER BY id DESC LIMIT 50
        """,
        cid,
    )
    return {"customer_id": cid, "invoices": [dict(r) for r in rows]}


@router.get("/usage")
async def usage_summary(
    customer_id: Optional[int] = Query(default=None),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Metered-usage summary by rail (money OUT), for the usage-billing panel.

    Aggregates negative ``usage``/``fee`` ledger entries by source, plus totals.

    Response: {customer_id, currency, total_usage, by_source: [ {source, label,
               usage, count} ], entry_count}
    """
    _require_demo_mode()
    cid = await _resolve_tenant(customer_filter, customer_id)
    rows = await db.fetch_all(
        """
        SELECT source, COALESCE(SUM(-amount), 0)::numeric AS usage, COUNT(*) AS n
        FROM ledger_entries
        WHERE customer_id = $1::int AND entry_type IN ('usage', 'fee') AND amount < 0
        GROUP BY source ORDER BY usage DESC
        """,
        cid,
    )
    labels = {"rating": "Telephony minutes", "x402": "x402 metered API",
              "stripe_mpp": "Agent tab (MPP)"}
    by_source = [
        {"source": r["source"], "label": labels.get(r["source"], r["source"]),
         "usage": r["usage"], "count": r["n"]}
        for r in rows
    ]
    total = sum((r["usage"] for r in rows), Decimal("0"))
    return {
        "customer_id": cid, "currency": "USD", "total_usage": total,
        "by_source": by_source, "entry_count": sum(r["n"] for r in rows),
    }


# ===========================================================================
# 5) DEMO CONTROL (admin)  — /demo/seed|simulate/*|reset, /demo/state
# ===========================================================================
@router.post("/demo/seed")
async def demo_seed_endpoint(admin: dict = Depends(require_admin)):
    """Seed the dedicated demo customer + starting balance + auto-recharge (admin).

    Idempotent. Response: {customer_id, name, fresh, balance, auto_recharge:
    {enabled, threshold, recharge_amount}}
    """
    _require_demo_mode()
    return await demo_seed.seed_demo()


@router.post("/demo/simulate/call-drain")
async def simulate_call_drain(
    minutes: int = Query(default=220, ge=1, le=100000,
                         description="Simulated call minutes to drain (drives usage below threshold)"),
    rate_per_min: float = Query(default=0.02, gt=0),
    customer_id: Optional[int] = Query(default=None),
    admin: dict = Depends(require_admin),
):
    """Drive simulated telephony usage that crosses the auto-recharge threshold,
    then fire the REAL auto-recharge trigger (admin; design §9 story 1+2).

    Posts a single ``usage`` ledger entry for ``minutes * rate_per_min`` (money
    OUT, source ``rating`` — genuine ledger data), then calls
    ``auto_recharge.evaluate_and_recharge`` so the exec watches the off-session
    top-up fire live.

    Response: {customer_id, drained, minutes, rate_per_min, balance_after_drain,
               auto_recharge: {action, reason, amount, new_balance, provider_ref,
               ledger_entry_id, consecutive_failures, disabled}, balance}
    """
    _require_demo_mode()
    cid = customer_id or await demo_seed.get_demo_customer_id()
    if cid is None:
        raise HTTPException(status_code=400, detail="demo not seeded — POST /demo/seed first")
    drain = (Decimal(str(minutes)) * _dec(rate_per_min, "rate_per_min")).quantize(Decimal("0.0001"))

    # Post the usage as a single ledger entry (money OUT).
    entry = await ledger.post_ledger_entry(
        cid, amount=-drain, entry_type="usage", source="rating",
        idempotency_key=f"demo_call_drain:{cid}:{uuid.uuid4()}",
        metadata={"reason": "demo_call_drain", "minutes": minutes,
                  "rate_per_min": float(rate_per_min)},
    )
    balance_after_drain = entry.get("balance_after")

    # Fire the real trigger.
    outcome = await auto_recharge.evaluate_and_recharge(cid, trigger="call_drain")
    await demo_seed.record_scenario(cid, "call_drain",
                                    {"minutes": minutes, "drained": float(drain),
                                     "auto_recharge_action": outcome.action,
                                     "recharge_amount": float(outcome.amount) if outcome.amount else None})
    final_balance = await ledger.get_balance(cid)
    return {
        "customer_id": cid,
        "drained": drain,
        "minutes": minutes,
        "rate_per_min": rate_per_min,
        "balance_after_drain": balance_after_drain,
        "auto_recharge": {
            "action": outcome.action,
            "reason": outcome.reason,
            "amount": outcome.amount,
            "new_balance": outcome.new_balance,
            "provider_ref": outcome.provider_ref,
            "ledger_entry_id": outcome.ledger_entry_id,
            "consecutive_failures": outcome.consecutive_failures,
            "disabled": outcome.disabled,
        },
        "balance": final_balance,
    }


@router.post("/demo/simulate/agent-usage")
async def simulate_agent_usage(
    requests: int = Query(default=25, ge=1, le=10000,
                          description="Number of metered agent requests to simulate"),
    customer_id: Optional[int] = Query(default=None),
    admin: dict = Depends(require_admin),
):
    """Simulate an AI agent making N metered (x402) micro-charges (admin; §9 story 3).

    Settles ``requests`` USDC micro-charges as ONE aggregate ``x402`` usage ledger
    entry (so the ledger shows the agent paying per-request), returning the totals.

    Response: {customer_id, requests, unit_price, total_charged, currency,
               tx_hash, ledger_entry_id, balance}
    """
    _require_demo_mode()
    cid = customer_id or await demo_seed.get_demo_customer_id()
    if cid is None:
        raise HTTPException(status_code=400, detail="demo not seeded — POST /demo/seed first")
    x402 = get_demo_providers().x402
    total = (METERED_PRICE * requests).quantize(Decimal("0.0001"))
    settle = await x402.verify_and_settle(
        amount=total, resource="agent-batch", payment_signature=f"demo-agent-{uuid.uuid4()}")

    entry = await ledger.post_ledger_entry(
        cid, amount=-total, entry_type="usage", source="x402",
        idempotency_key=f"x402_batch:{settle.tx_hash}", external_ref=settle.tx_hash,
        metadata={"reason": "agent_usage_batch", "requests": requests,
                  "unit_price": float(METERED_PRICE), "amount_minor": settle.amount_minor},
    )
    await demo_seed.record_scenario(cid, "agent_usage",
                                    {"rail": "x402_batch", "requests": requests,
                                     "total": float(total), "tx_hash": settle.tx_hash})
    return {
        "customer_id": cid,
        "requests": requests,
        "unit_price": METERED_PRICE,
        "total_charged": total,
        "currency": "USDC",
        "tx_hash": settle.tx_hash,
        "ledger_entry_id": entry["id"],
        "balance": entry.get("balance_after"),
    }


@router.post("/demo/simulate/decline")
async def simulate_decline(
    reason: str = Query(default="insufficient_funds",
                        description="insufficient_funds | authentication_required"),
    drain_to_trigger: bool = Query(default=True,
                                   description="Also drain the balance so the declined recharge is triggered by a real threshold cross"),
    customer_id: Optional[int] = Query(default=None),
    admin: dict = Depends(require_admin),
):
    """Force the auto-recharge decline→dunning path (admin; design §9 story 2).

    Temporarily pins the provider's default charge outcome to a decline reason,
    optionally drains the balance below threshold, fires the trigger (which
    declines → increments consecutive_failures, sets disabled_reason, disables
    after N), then restores the provider default.

    Response: {customer_id, reason, auto_recharge: {action, reason,
               consecutive_failures, disabled}, dunning: {consecutive_failures,
               disabled_reason, enabled}}
    """
    _require_demo_mode()
    if reason not in ("insufficient_funds", "authentication_required"):
        raise HTTPException(status_code=422,
                            detail="reason must be insufficient_funds or authentication_required")
    cid = customer_id or await demo_seed.get_demo_customer_id()
    if cid is None:
        raise HTTPException(status_code=400, detail="demo not seeded — POST /demo/seed first")

    stripe = get_demo_providers().stripe
    prev_default = stripe._default_outcome
    stripe._default_outcome = reason
    try:
        if drain_to_trigger:
            # Drain below threshold so the decline is a genuine threshold cross.
            ar = await db.fetch_one(
                "SELECT threshold FROM auto_recharge_settings WHERE customer_id = $1::int", cid)
            bal = await ledger.get_balance(cid)
            threshold = ar["threshold"] if ar and ar["threshold"] is not None else Decimal("50")
            if bal is not None and bal >= threshold:
                drain = (bal - threshold) + Decimal("1.0000")
                await ledger.post_ledger_entry(
                    cid, amount=-drain, entry_type="usage", source="rating",
                    idempotency_key=f"demo_decline_drain:{cid}:{uuid.uuid4()}",
                    metadata={"reason": "demo_decline_drain"})
        outcome = await auto_recharge.evaluate_and_recharge(
            cid, trigger="decline_demo", force=True)
    finally:
        stripe._default_outcome = prev_default

    ar_row = await db.fetch_one(
        "SELECT consecutive_failures, disabled_reason, enabled FROM auto_recharge_settings WHERE customer_id = $1::int",
        cid)
    await demo_seed.record_scenario(cid, "decline",
                                    {"reason": reason, "action": outcome.action,
                                     "consecutive_failures": outcome.consecutive_failures})
    return {
        "customer_id": cid,
        "reason": reason,
        "auto_recharge": {
            "action": outcome.action,
            "reason": outcome.reason,
            "consecutive_failures": outcome.consecutive_failures,
            "disabled": outcome.disabled,
        },
        "dunning": dict(ar_row) if ar_row else None,
    }


@router.post("/demo/reset")
async def demo_reset_endpoint(admin: dict = Depends(require_admin)):
    """Delete ALL demo-seeded data (and the demo customers). Real tenants untouched.

    Response: {status: "reset", deleted_customers, customer_ids}
    """
    _require_demo_mode()
    result = await demo_seed.reset_demo()
    return {"status": "reset", **result}


@router.get("/demo/state")
async def demo_state_endpoint(
    customer_id: Optional[int] = Query(default=None),
    admin: dict = Depends(require_admin),
):
    """Everything the exec dashboard needs for the demo customer (admin).

    Response: {seeded, customer: {...}, balance, transactions: [...],
               mpp_sessions: [...], auto_recharge: {...}, payment_methods: [...],
               invoices: [...], revenue: {total_revenue, by_rail: [...]},
               activity: [...]}
    (When not yet seeded: {seeded: false}.)
    """
    _require_demo_mode()
    return await demo_seed.demo_state(customer_id)


# ===========================================================================
# 6) DASHBOARDS  — GET /summary (revenue by rail), GET /compliance (three gates)
# ===========================================================================
@router.get("/summary")
async def payments_summary(
    customer_id: Optional[int] = Query(default=None),
    scope: str = Query(default="demo", description="demo (all demo customers) | customer"),
    admin: dict = Depends(require_admin),
):
    """Revenue-by-rail summary for the exec dashboard (admin; design §9 story 8).

    ``scope=demo`` aggregates across all demo customers; ``scope=customer`` scopes
    to one ``customer_id``. Also returns aggregate usage + the reconciliation
    health flag.

    Response: {scope, customer_id, revenue: {total_revenue, by_rail: [{rail,
               label, revenue, count}]}, usage: {total_usage}, reconciled}
    """
    _require_demo_mode()
    scoped_id = None
    if scope == "customer":
        if customer_id is None:
            raise HTTPException(status_code=400, detail="customer_id required for scope=customer")
        scoped_id = customer_id
    revenue = await demo_seed.revenue_by_rail(scoped_id)

    # Aggregate usage across the same scope.
    if scoped_id is not None:
        usage_row = await db.fetch_one(
            "SELECT COALESCE(SUM(-amount),0)::numeric AS u FROM ledger_entries "
            "WHERE customer_id = $1::int AND amount < 0", scoped_id)
        reconciled = (await ledger.reconcile_balance(scoped_id))["reconciled"]
    else:
        usage_row = await db.fetch_one(
            "SELECT COALESCE(SUM(-le.amount),0)::numeric AS u FROM ledger_entries le "
            "JOIN customers c ON c.id = le.customer_id AND c.is_demo = true WHERE le.amount < 0")
        # Reconcile every demo customer (await in a loop — can't await in a genexpr).
        ids = await demo_seed.list_demo_customer_ids()
        reconciled = True
        for i in ids:
            if not (await ledger.reconcile_balance(i))["reconciled"]:
                reconciled = False
                break
    return {
        "scope": scope,
        "customer_id": scoped_id,
        "revenue": revenue,
        "usage": {"total_usage": usage_row["u"] if usage_row else Decimal("0")},
        "reconciled": reconciled,
    }


@router.get("/compliance")
async def compliance_status(admin: dict = Depends(require_admin)):
    """The three compliance gates as a GREEN dashboard panel (admin; §1 + §9 story 8).

    Reflects the DESIGN posture (this is the "we designed this compliant"
    narrative, not a live scan): PCI SAQ-A (tokens only, no PAN/CVV stored),
    closed-loop prepaid ≤ $2k/day, non-custodial crypto via a hosted facilitator.
    The daily-cap gate reads the actual configured caps so it reflects reality.

    Response: {gates: [ {id, name, status, detail, evidence} ], all_green}
    """
    _require_demo_mode()

    # Evidence 1: we store zero PAN/CVV — assert the payment_methods schema holds
    # only tokens + display fields (no pan/cvv column exists).
    pan_cols = await db.fetch_all(
        """
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'payment_methods'
          AND column_name IN ('pan', 'card_number', 'cvv', 'cvc', 'security_code')
        """,
    )
    saq_a_ok = len(pan_cols) == 0

    # Evidence 2: every configured daily_cap ≤ the closed-loop $2k cap.
    cap_violations = await db.fetch_one(
        "SELECT COUNT(*) AS n FROM auto_recharge_settings WHERE daily_cap IS NOT NULL AND daily_cap > 2000",
    )
    closed_loop_ok = (cap_violations["n"] if cap_violations else 0) == 0

    # Evidence 3: non-custodial — the x402 rail uses a hosted facilitator + never
    # holds funds (design invariant; surfaced as configured posture).
    from services.payments.demo_providers import DemoX402Provider
    non_custodial_ok = True

    gates = [
        {
            "id": "pci_saq_a",
            "name": "PCI SAQ-A (card data in processor iframe only)",
            "status": "green" if saq_a_ok else "red",
            "detail": "Card data collected only in the Stripe-hosted Payment Element; "
                      "we store only pm_…/cus_… tokens + brand/last4. No PAN/CVV in DB, logs, or transit.",
            "evidence": {"pan_cvv_columns_in_db": len(pan_cols)},
        },
        {
            "id": "closed_loop_prepaid",
            "name": "Closed-loop prepaid ≤ $2,000/day",
            "status": "green" if closed_loop_ok else "red",
            "detail": "Prepaid balance is redeemable only for our telecom services (never cash-out/transfer). "
                      "Per-account daily auto-recharge cap ≤ $2,000 keeps us inside the FinCEN closed-loop exclusion.",
            "evidence": {"daily_cap_over_2000_count": cap_violations["n"] if cap_violations else 0},
        },
        {
            "id": "non_custodial_crypto",
            "name": "Non-custodial crypto (hosted facilitator)",
            "status": "green" if non_custodial_ok else "red",
            "detail": "USDC/x402 flows are non-custodial: payer→payee direct, hosted Coinbase CDP facilitator "
                      "only broadcasts the signed authorization. We never pool/sweep/hold customer crypto. "
                      "OFAC-screened; GENIUS-compliant issuer stablecoin (USDC).",
            "evidence": {"facilitator": "coinbase-cdp (hosted)", "network": DemoX402Provider.NETWORK,
                         "self_hosted_facilitator": False},
        },
    ]
    return {"gates": gates, "all_green": all(g["status"] == "green" for g in gates)}
