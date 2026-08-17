"""API Calling endpoints - initiate and control calls.

Implements tiered CPS (Calls Per Second) limits for API calling:
- api_basic: 5 CPS, $0.01/call
- api_standard: 8 CPS, $0.008/call
- api_premium: 15 CPS, $0.005/call

Machine payments (PAYMENTS_DEMO_MODE only — flag off is byte-identical legacy):
``POST /v1/calls`` supports TWO payment paths, selected per-request:

  * PREPAID (default) — the existing flow; in demo mode the per-call fee posts a
    ledger ``usage`` entry (source='rating', key ``api_call_fee:{uuid}``) through
    ``services.ledger`` instead of the raw balance decrement (never both).
  * PAY-PER-CALL (x402) — request header ``PAYMENT-PROTOCOL: x402``: no
    ``PAYMENT-SIGNATURE`` → HTTP 402 with a LIVE price quoted from the real rate
    deck (tier connect fee + first-minute longest-prefix rate); with a signature
    → verify+settle (DemoX402Provider), one negative ``x402`` usage ledger entry
    keyed by the settlement tx hash, then originate. CPS/velocity still apply.

``PAYMENTS_DEMO_FAKE_ORIGINATE=true`` (demo only) short-circuits the real ESL
originate with a minted ``demo_originated`` call record so the flow completes
end-to-end where FreeSWITCH is unreachable (Docker Desktop isolation).
"""
from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends, Request, Response
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
import os
import uuid
import logging
from db import database as db
from db import redis_client as cache
from auth.dependencies import get_customer_filter
from services.esl_client import (
    originate_call, get_call_status, hangup_call, transfer_call, send_dtmf,
)
from services import call_pricing, demo_seed, ledger
from services.payments import PaymentError, demo_mode_enabled, get_demo_providers
from routers.payments import (
    H_PAYMENT_REQUIRED, H_PAYMENT_RESPONSE, H_PAYMENT_SIGNATURE,
)
from utils import phone

logger = logging.getLogger(__name__)

router = APIRouter()

# Default API tier settings (fallback if not configured)
DEFAULT_API_CPS_LIMIT = 5
DEFAULT_API_TIER = "api_basic"

# x402 pay-per-call request headers (v2 response headers come from routers.payments).
H_PAYMENT_PROTOCOL = "PAYMENT-PROTOCOL"   # "x402" selects the pay-per-call path
H_PAYMENT_AMOUNT = "PAYMENT-AMOUNT"       # optional client-declared dollars (must match quote)

#: How long a 402 quote is advertised as valid (informational — the demo is
#: stateless; the price is recomputed server-side on the paid retry anyway).
X402_QUOTE_TTL_SECONDS = 300


def _fake_originate_enabled() -> bool:
    """True when demo mode is on AND PAYMENTS_DEMO_FAKE_ORIGINATE is set.

    Local-dev escape hatch: Docker Desktop isolates the bridge-network API from
    host-network FreeSWITCH, so ESL can't reach FS. With this flag the originate
    is skipped and a realistic ``demo_originated`` call record is minted instead.
    Default false — production with real FS runs the real originate after payment.
    """
    return demo_mode_enabled() and (
        os.getenv("PAYMENTS_DEMO_FAKE_ORIGINATE", "false").strip().lower()
        in ("1", "true", "yes", "on")
    )


class CallCreate(BaseModel):
    from_did: str
    to: str
    webhook_url: Optional[str] = None
    status_callback: Optional[str] = None
    timeout: int = 60
    caller_id: Optional[str] = None


class CallUpdate(BaseModel):
    action: str  # hangup, transfer, dtmf
    target: Optional[str] = None  # For transfer
    digits: Optional[str] = None  # For dtmf


async def _get_owned_active_call(call_id: str, customer_filter: int | None) -> dict:
    """Fetch an active call enforcing tenant isolation.

    Returns 404 if the call is not active OR belongs to another customer (do NOT
    leak existence cross-tenant with a 403). Admins (customer_filter is None) are
    unrestricted.
    """
    active = await db.fetch_one(
        "SELECT uuid, customer_id, state FROM active_calls WHERE uuid = $1::uuid",
        call_id,
    )
    if not active:
        raise HTTPException(status_code=404, detail="Active call not found")
    if customer_filter is not None and active["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="Active call not found")
    return dict(active)


@router.post("")
async def create_call(
    call: CallCreate,
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Initiate an outbound call via API.

    Tenant-scoped: a non-admin caller (JWT or API key) may only originate from an
    API DID owned by their own customer. Admins may originate from any DID.
    Enforces tiered CPS limits before allowing call origination.
    Returns 429 with upgrade recommendations if over CPS limit.

    DEMO MODE ONLY (PAYMENTS_DEMO_MODE — flag off, this endpoint is byte-identical
    legacy): sending ``PAYMENT-PROTOCOL: x402`` switches this request to the
    pay-per-call path — 402 + live quote without a ``PAYMENT-SIGNATURE``, settle +
    originate with one. JWT auth is still required first (402 only for authed
    callers), and CPS/velocity limits apply on BOTH paths.
    """
    # BUG-2 fix: canonicalize BOTH numbers before use (shared utils.phone rule).
    # from_did is stored canonical (+E.164) in api_dids, so a raw/10-digit input
    # ('6174544217') must be normalized BEFORE the `WHERE a.did = $1` match or the
    # lookup misses and returns a false 404. `to` is normalized for idempotency and
    # a canonical CDR destination (FreeSWITCH normalizes again on the B-leg — safe).
    # A malformed number is a client error -> clean 422, not a downstream 500.
    try:
        from_did = phone.normalize_e164(call.from_did)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid from_did: {exc}")
    try:
        to = phone.normalize_forward_destination(call.to)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid destination 'to': {exc}")

    # Verify the from DID belongs to an API customer and get tier info
    did_info = await db.fetch_one(
        """
        SELECT
            a.customer_id,
            a.voice_url,
            c.status,
            c.traffic_grade,
            c.api_tier_id,
            t.name AS api_tier_name,
            t.cps_limit AS api_cps_limit,
            t.per_call_fee
        FROM api_dids a
        JOIN customers c ON a.customer_id = c.id
        LEFT JOIN cps_tiers t ON c.api_tier_id = t.id
        WHERE a.did = $1::varchar AND a.enabled = true
        """,
        from_did
    )

    if not did_info:
        raise HTTPException(status_code=404, detail="From DID not found or not enabled")

    customer_id = did_info["customer_id"]

    # Tenant scope: non-admins may only originate from their OWN DID. Return 404
    # (not 403) so a tenant cannot probe which DIDs belong to other customers.
    if customer_filter is not None and customer_id != customer_filter:
        raise HTTPException(status_code=404, detail="From DID not found or not enabled")

    if did_info["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    # Get CPS limit from tier (use default if not configured)
    api_tier_name = did_info.get("api_tier_name") or DEFAULT_API_TIER
    api_cps_limit = did_info.get("api_cps_limit") or DEFAULT_API_CPS_LIMIT
    per_call_fee = float(did_info.get("per_call_fee") or 0.01)
    # Exact-decimal twin of the fee for the payment paths (asyncpg returns
    # DECIMAL as Decimal; mirror the `or 0.01` default without touching float).
    per_call_fee_dec = did_info.get("per_call_fee") or Decimal("0.01")

    # Check CPS limit using sliding window
    cps_allowed, current_cps = await cache.check_cps_limit(
        customer_id=customer_id,
        cps_limit=api_cps_limit,
        tier_type="api"
    )

    if not cps_allowed:
        # Build upgrade message based on current tier
        upgrade_message = _get_upgrade_message(api_tier_name, current_cps, api_cps_limit)

        logger.warning(
            f"CPS limit exceeded for customer {customer_id}: "
            f"{current_cps}/{api_cps_limit} (tier: {api_tier_name})"
        )

        raise HTTPException(
            status_code=429,
            detail={
                "error": "CPS limit exceeded",
                "current_cps": current_cps,
                "cps_limit": api_cps_limit,
                "tier": api_tier_name,
                "upgrade_message": upgrade_message
            }
        )

    # Generate call UUID
    call_uuid = str(uuid.uuid4())

    # Check velocity limits (calls per minute - separate from CPS)
    velocity = await cache.get_velocity(customer_id)
    if velocity["calls_per_minute"] >= 120:  # API customers get higher limits
        raise HTTPException(status_code=429, detail="Rate limit exceeded (calls per minute)")

    # ---- PAY-PER-CALL (x402) path — demo-gated, header-selected. ----------
    # CPS + velocity checks above already ran (payment never bypasses limits).
    # Flag off → the header is ignored and the legacy flow below is untouched.
    if (demo_mode_enabled()
            and request.headers.get(H_PAYMENT_PROTOCOL, "").strip().lower() == "x402"):
        return await _x402_pay_per_call(
            request, response,
            call_uuid=call_uuid, call=call, from_did=from_did, to=to,
            customer_id=customer_id, per_call_fee=per_call_fee_dec,
            api_tier_name=api_tier_name, did_info=did_info,
        )

    # Store call in active_calls table with tier info for billing (canonical numbers)
    await db.execute(
        """
        INSERT INTO active_calls (uuid, customer_id, product_type, direction, caller_id, destination)
        VALUES ($1, $2, 'api', 'outbound', $3, $4)
        """,
        call_uuid, customer_id, from_did, to
    )

    # Originate call via FreeSWITCH ESL
    try:
        if _fake_originate_enabled():
            # Demo short-circuit (Docker Desktop: ESL can't reach FS locally).
            await _mint_demo_originate(call_uuid, customer_id, from_did, to)
            call_status = "demo_originated"
        else:
            success = await originate_call(
                uuid=call_uuid,
                from_did=from_did,
                to=to,
                customer_id=customer_id,
                traffic_grade=did_info["traffic_grade"],
                webhook_url=call.webhook_url or did_info["voice_url"],
                timeout=call.timeout
            )

            if not success:
                raise HTTPException(status_code=500, detail="Failed to originate call")
            call_status = "initiated"

    except Exception as e:
        # Clean up active call record
        await db.execute("DELETE FROM active_calls WHERE uuid = $1", call_uuid)
        raise HTTPException(status_code=500, detail=f"Call failed: {str(e)}")

    # Increment velocity counter
    await cache.incr_with_ttl(f"vel:{customer_id}:cpm", 60)

    # Schedule per-call fee billing in background
    background_tasks.add_task(
        apply_per_call_fee,
        call_uuid=call_uuid,
        customer_id=customer_id,
        per_call_fee=per_call_fee,
        api_tier_name=api_tier_name
    )

    return {
        "call_id": call_uuid,
        "status": call_status,
        "from": from_did,
        "to": to,
        "tier": api_tier_name,
        "per_call_fee": per_call_fee
    }


# ===========================================================================
# x402 pay-per-call (PAYMENTS_DEMO_MODE only)
# ===========================================================================
async def _mint_demo_originate(
    call_uuid: str, customer_id: int, from_did: str, to: str,
) -> None:
    """Fake-originate short-circuit: mark the active call ``demo_originated``.

    Only reachable when ``_fake_originate_enabled()`` (demo mode + explicit
    PAYMENTS_DEMO_FAKE_ORIGINATE flag). Logs + records a demo_scenarios audit row
    so the demo trail shows the call was minted, not carried.
    """
    await db.execute(
        "UPDATE active_calls SET state = 'demo_originated' WHERE uuid = $1", call_uuid)
    logger.info(
        "DEMO fake-originate: minted call %s %s -> %s (customer=%s) — real ESL "
        "originate skipped (PAYMENTS_DEMO_FAKE_ORIGINATE)",
        call_uuid, from_did, to, customer_id,
    )
    await demo_seed.record_scenario(
        customer_id, "demo_originate",
        {"call_uuid": call_uuid, "from": from_did, "to": to})


def _x402_challenge_payload(
    response: Response, quote: call_pricing.CallPriceQuote, resource: str,
    api_tier_name: str, error: str = "payment required",
) -> dict:
    """Build the HTTP 402 challenge: PAYMENT-REQUIRED header + JSON body.

    The price is LIVE — quoted per destination from the real rate deck (tier
    connect fee + first-minute longest-prefix rate). Money renders as exact
    decimal strings. ``expires_at`` is informational: the demo challenge is
    stateless and the price is recomputed server-side on the paid retry.
    """
    x402 = get_demo_providers().x402
    challenge = x402.build_challenge(amount=quote.total, resource=resource)
    response.status_code = 402
    response.headers[H_PAYMENT_REQUIRED] = challenge.header_value
    expires_at = (datetime.now(timezone.utc)
                  + timedelta(seconds=X402_QUOTE_TTL_SECONDS)).isoformat()
    price = quote.breakdown()
    price["tier"] = api_tier_name
    return {
        "error": error,
        "price": price,
        "asset": challenge.asset,
        "network": challenge.network,
        "amount_minor": challenge.amount_minor,
        "pay_to": challenge.pay_to,
        "resource": challenge.resource,
        "nonce": challenge.nonce,
        "expires_at": expires_at,
        "how_to_pay": (
            f"Sign an EIP-3009 USDC authorization for {quote.total} USD "
            f"({challenge.amount_minor} USDC minor units) to {challenge.pay_to} "
            f"on {challenge.network}, then retry this exact request with the "
            f"signed authorization in the {H_PAYMENT_SIGNATURE} header "
            f"(optionally declare the amount in {H_PAYMENT_AMOUNT})."
        ),
    }


async def _x402_pay_per_call(
    request: Request,
    response: Response,
    *,
    call_uuid: str,
    call: CallCreate,
    from_did: str,
    to: str,
    customer_id: int,
    per_call_fee: Decimal,
    api_tier_name: str,
    did_info: dict,
) -> dict:
    """The x402 pay-per-call flow for POST /v1/calls (demo-gated by the caller).

    Steps (CPS/velocity already enforced by create_call):
      1. Quote the LIVE price for the dialed destination off the real rate deck.
         Unrateable → 422 (honest: we will not charge a made-up price).
      2. No PAYMENT-SIGNATURE → HTTP 402 challenge (PAYMENT-REQUIRED header +
         price breakdown body).
      3. With a signature → recompute the price server-side (never trust the
         client); an optional client-declared PAYMENT-AMOUNT must match exactly
         or the request is re-challenged with 402.
      4. verify_and_settle via DemoX402Provider. The demo tx hash is
         deterministic over (resource, signature, amount), so the settlement is
         naturally keyed: a REPLAY of the same signed authorization maps to the
         same ledger idempotency key → rejected with 409 (a payment
         authorization funds exactly one call; we return the original call_id).
      5. Originate (or demo-mint), THEN post ONE negative ``usage`` ledger entry
         (source='x402', key ``x402:{tx_hash}``) — matching the sign convention
         of /v1/payments/demo/metered and the agent-usage demo scenario: the
         on-chain settlement is money-in consumed in the same step, so the
         ledger records the consumption side, with the tx hash as external_ref
         (the funding evidence). Originate failure → 500 and NO ledger post (the
         customer is not charged for a call that never launched).
      6. 200 with the call payload + a ``payment`` block + PAYMENT-RESPONSE
         header (tx hash). Status stays 200 to match the legacy success shape.
    """
    quote = await call_pricing.quote_call_price(
        customer_id=customer_id, destination=to, connect_fee=per_call_fee)
    if quote is None:
        raise HTTPException(
            status_code=422,
            detail=(f"destination not rateable: no rate covers '{to}' in the "
                    "active rate deck — cannot quote an x402 price"),
        )

    resource = f"/v1/calls#to={to}"
    signature = request.headers.get(H_PAYMENT_SIGNATURE)
    if not signature:
        # Step 2 — challenge with the live quote.
        return _x402_challenge_payload(response, quote, resource, api_tier_name)

    # Step 3 — optional client-declared amount must match the recomputed quote.
    declared = request.headers.get(H_PAYMENT_AMOUNT)
    if declared is not None:
        try:
            declared_amount = Decimal(declared.strip())
        except (InvalidOperation, ValueError):
            declared_amount = None
        if declared_amount is None or declared_amount != quote.total:
            return _x402_challenge_payload(
                response, quote, resource, api_tier_name,
                error=(f"payment amount mismatch: declared {declared!r}, "
                       f"current quote for {to} is {quote.total} USD — re-sign "
                       "at the quoted amount"),
            )

    # Step 4 — verify + settle (simulated CDP facilitator).
    x402 = get_demo_providers().x402
    try:
        settle = await x402.verify_and_settle(
            amount=quote.total, resource=resource, payment_signature=signature)
    except PaymentError as e:
        raise HTTPException(status_code=402, detail=f"x402 verification failed: {e}")

    # Replay guard: the same signed authorization always settles to the same tx
    # hash → same idempotency key. If that key already funded a call, refuse.
    idem = f"x402:{settle.tx_hash}"
    existing = await db.fetch_one(
        "SELECT id, metadata, created_at FROM ledger_entries "
        "WHERE idempotency_key = $1::text", idem)
    if existing is not None:
        try:
            prior = json.loads(existing["metadata"]) if existing["metadata"] else {}
        except (TypeError, ValueError):
            prior = {}
        raise HTTPException(
            status_code=409,
            detail={
                "error": "x402 payment replay",
                "message": ("this signed authorization already funded a call — "
                            "sign a fresh authorization to place another"),
                "tx_hash": settle.tx_hash,
                "original_call_id": prior.get("call_uuid"),
                "ledger_entry_id": existing["id"],
            },
        )

    # Step 5 — launch the call, then post the single x402 usage entry.
    await db.execute(
        """
        INSERT INTO active_calls (uuid, customer_id, product_type, direction, caller_id, destination)
        VALUES ($1, $2, 'api', 'outbound', $3, $4)
        """,
        call_uuid, customer_id, from_did, to,
    )
    try:
        if _fake_originate_enabled():
            await _mint_demo_originate(call_uuid, customer_id, from_did, to)
            call_status = "demo_originated"
        else:
            success = await originate_call(
                uuid=call_uuid, from_did=from_did, to=to,
                customer_id=customer_id, traffic_grade=did_info["traffic_grade"],
                webhook_url=call.webhook_url or did_info["voice_url"],
                timeout=call.timeout,
            )
            if not success:
                raise HTTPException(status_code=500, detail="Failed to originate call")
            call_status = "initiated"
    except Exception as e:
        await db.execute("DELETE FROM active_calls WHERE uuid = $1", call_uuid)
        raise HTTPException(status_code=500, detail=f"Call failed: {str(e)}")

    entry = await ledger.post_ledger_entry(
        customer_id, amount=-quote.total, entry_type="usage", source="x402",
        idempotency_key=idem, external_ref=settle.tx_hash,
        metadata={
            "reason": "x402_pay_per_call", "call_uuid": call_uuid,
            "from": from_did, "to": to, "tier": api_tier_name,
            "connect_fee": str(quote.connect_fee),
            "first_minute": str(quote.first_minute),
            "rate_per_min": str(quote.rate_per_min),
            "matched_prefix": quote.prefix,
            "amount_minor": settle.amount_minor, "asset": settle.asset,
            "network": settle.network, "payer": settle.payer,
        },
    )

    await cache.incr_with_ttl(f"vel:{customer_id}:cpm", 60)
    await demo_seed.record_scenario(
        customer_id, "agent_usage",
        {"rail": "x402_call", "call_uuid": call_uuid, "to": to,
         "amount": float(quote.total), "tx_hash": settle.tx_hash})

    logger.info(
        "x402 pay-per-call settled: call=%s customer=%s to=%s amount=%s tx=%s",
        call_uuid, customer_id, to, quote.total, settle.tx_hash,
    )
    response.headers[H_PAYMENT_RESPONSE] = settle.header_value
    price = quote.breakdown()
    price["tier"] = api_tier_name
    return {
        "call_id": call_uuid,
        "status": call_status,
        "from": from_did,
        "to": to,
        "tier": api_tier_name,
        "payment": {
            "protocol": "x402",
            "amount": str(quote.total),
            "currency": "USD",
            "asset": settle.asset,
            "network": settle.network,
            "amount_minor": settle.amount_minor,
            "tx_hash": settle.tx_hash,
            "payer": settle.payer,
            "breakdown": price,
            "ledger_entry_id": entry["id"],
            "balance": str(entry["balance_after"]) if entry.get("balance_after") is not None else None,
        },
    }


@router.get("/{call_id}")
async def get_call(
    call_id: str,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get call status by ID.

    Tenant-scoped: a non-admin caller only sees calls tied to their own customer.
    Cross-tenant / unknown call_ids return 404 (existence is not leaked).
    """
    # Check active calls first. Fold the tenant predicate into the WHERE so a
    # cross-tenant uuid simply misses (admin passes NULL -> no restriction).
    active = await db.fetch_one(
        """
        SELECT uuid, customer_id, product_type, direction, caller_id, destination,
               start_time, answer_time, state
        FROM active_calls
        WHERE uuid = $1::uuid AND ($2::int IS NULL OR customer_id = $2::int)
        """,
        call_id, customer_filter
    )

    if active:
        # Get real-time status from FreeSWITCH
        fs_status = await get_call_status(call_id)
        return {
            "call_id": call_id,
            "status": fs_status.get("state", active["state"]),
            "direction": active["direction"],
            "from": active["caller_id"],
            "to": active["destination"],
            "start_time": str(active["start_time"]),
            "answer_time": str(active["answer_time"]) if active["answer_time"] else None,
        }

    # Check CDRs for completed calls (same tenant predicate).
    cdr = await db.fetch_one(
        """
        SELECT uuid, direction, caller_id, destination, start_time,
               answer_time, end_time, duration_ms, hangup_cause
        FROM cdrs
        WHERE uuid = $1::uuid AND ($2::int IS NULL OR customer_id = $2::int)
        ORDER BY start_time DESC LIMIT 1
        """,
        call_id, customer_filter
    )

    if cdr:
        return {
            "call_id": call_id,
            "status": "completed",
            "direction": cdr["direction"],
            "from": cdr["caller_id"],
            "to": cdr["destination"],
            "start_time": str(cdr["start_time"]),
            "end_time": str(cdr["end_time"]),
            "duration_seconds": (cdr["duration_ms"] or 0) / 1000,
            "hangup_cause": cdr["hangup_cause"]
        }

    raise HTTPException(status_code=404, detail="Call not found")


@router.post("/{call_id}/update")
async def update_call(
    call_id: str,
    update: CallUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Modify a live call (hangup, transfer, dtmf).

    Tenant-scoped: a non-admin caller may only control calls tied to their own
    customer (404-no-leak). Supported actions: hangup, transfer, dtmf.
    """
    # Ownership gate: 404 if the call is not active OR belongs to another tenant.
    await _get_owned_active_call(call_id, customer_filter)

    if update.action == "hangup":
        success = await hangup_call(call_id)
        if success:
            return {"call_id": call_id, "action": "hangup", "status": "success"}
        raise HTTPException(status_code=500, detail="Failed to hangup call")

    elif update.action == "transfer":
        if not update.target:
            raise HTTPException(status_code=400, detail="Transfer requires target")
        success = await transfer_call(call_id, update.target)
        if success:
            return {
                "call_id": call_id,
                "action": "transfer",
                "target": update.target,
                "status": "success",
            }
        raise HTTPException(status_code=500, detail="Failed to transfer call")

    elif update.action == "dtmf":
        if not update.digits:
            raise HTTPException(status_code=400, detail="DTMF requires digits")
        success = await send_dtmf(call_id, update.digits)
        if success:
            return {
                "call_id": call_id,
                "action": "dtmf",
                "digits": update.digits,
                "status": "success",
            }
        raise HTTPException(status_code=500, detail="Failed to send DTMF")

    else:
        raise HTTPException(status_code=400, detail=f"Unknown action: {update.action}")


# Helper Functions

def _get_upgrade_message(tier_name: str, current_cps: int, cps_limit: int) -> str:
    """Generate upgrade recommendation message based on current tier.

    Args:
        tier_name: Current tier name
        current_cps: Current CPS count
        cps_limit: Current CPS limit

    Returns:
        Upgrade recommendation message
    """
    messages = {
        "api_basic": (
            f"Your current plan (Basic) allows {cps_limit} CPS. "
            "Upgrade to Standard ($299/mo) for 8 CPS and lower per-call fees ($0.008)."
        ),
        "api_standard": (
            f"Your current plan (Standard) allows {cps_limit} CPS. "
            "Upgrade to Premium ($799/mo) for 15 CPS and the lowest per-call fees ($0.005)."
        ),
        "api_premium": (
            f"Your current plan (Premium) allows {cps_limit} CPS. "
            "You are on the highest tier. Contact sales for custom volume pricing."
        ),
    }

    return messages.get(
        tier_name,
        f"CPS limit ({cps_limit}) exceeded. Contact support to upgrade your plan."
    )


async def apply_per_call_fee(
    call_uuid: str,
    customer_id: int,
    per_call_fee: float,
    api_tier_name: str
) -> bool:
    """Apply per-call fee to customer balance.

    This is called as a background task after call initiation.
    The fee is applied immediately on call attempt (not on answer).

    DEMO MODE (PAYMENTS_DEMO_MODE): the fee posts ONE ledger ``usage`` entry
    (source='rating' — telephony usage, same bucket the rating engine uses;
    idempotency key ``api_call_fee:{call_uuid}``) via services.ledger, which
    updates the balance atomically in the same transaction. The raw decrement
    below is NOT also applied — never both (no double charge). Flag off → the
    legacy raw decrement runs untouched and the ledger is never called.

    Args:
        call_uuid: The call UUID for logging
        customer_id: Customer ID to charge
        per_call_fee: Per-call fee from the tier
        api_tier_name: Tier name for logging

    Returns:
        True if fee applied successfully
    """
    if per_call_fee <= 0:
        return True  # No fee to apply

    if demo_mode_enabled():
        try:
            fee = Decimal(str(per_call_fee)).quantize(
                Decimal("0.0001"), rounding=ROUND_HALF_UP)
            entry = await ledger.post_ledger_entry(
                customer_id, amount=-fee, entry_type="usage", source="rating",
                idempotency_key=f"api_call_fee:{call_uuid}",
                metadata={"reason": "api_call_fee", "call_uuid": call_uuid,
                          "tier": api_tier_name},
            )
            logger.info(
                "Applied per-call fee (ledger): customer=%s, call=%s, fee=$%s, "
                "tier=%s, new_balance=$%s",
                customer_id, call_uuid, fee, api_tier_name, entry.get("balance_after"),
            )
            return True
        except Exception as e:
            logger.error(f"Error posting per-call fee ledger entry for call {call_uuid}: {e}")
            return False

    try:
        # Deduct fee from customer balance
        result = await db.fetch_one(
            """
            UPDATE customers
            SET balance = balance - $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, balance
            """,
            per_call_fee, customer_id
        )

        if result:
            logger.info(
                f"Applied per-call fee: customer={customer_id}, "
                f"call={call_uuid}, fee=${per_call_fee:.4f}, "
                f"tier={api_tier_name}, new_balance=${result['balance']:.4f}"
            )
            return True
        else:
            logger.error(f"Failed to apply per-call fee: customer {customer_id} not found")
            return False

    except Exception as e:
        logger.error(f"Error applying per-call fee for call {call_uuid}: {e}")
        return False


async def log_cps_usage(
    customer_id: int,
    usage_type: str,
    tier_id: Optional[int],
    calls_count: int,
    peak_cps: float,
    period_start,
    period_end
) -> bool:
    """Log CPS usage metrics to database for billing and analytics.

    Args:
        customer_id: Customer ID
        usage_type: 'trunk' or 'api'
        tier_id: The tier ID (can be None)
        calls_count: Total calls in period
        peak_cps: Peak CPS observed
        period_start: Period start timestamp
        period_end: Period end timestamp

    Returns:
        True if logged successfully
    """
    try:
        await db.execute(
            """
            INSERT INTO cps_usage_log
            (customer_id, tier_id, usage_type, calls_count, peak_cps, period_start, period_end)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            customer_id, tier_id, usage_type, calls_count, peak_cps, period_start, period_end
        )
        return True
    except Exception as e:
        logger.error(f"Failed to log CPS usage: {e}")
        return False
