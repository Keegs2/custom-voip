"""API Calling endpoints - initiate and control calls.

Implements tiered CPS (Calls Per Second) limits for API calling:
- api_basic: 5 CPS, $0.01/call
- api_standard: 8 CPS, $0.008/call
- api_premium: 15 CPS, $0.005/call
"""
from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel, field_validator
from typing import Optional
import re
import uuid
import logging
from decimal import Decimal
from db import database as db
from db import redis_client as cache
from auth.dependencies import get_customer_filter
from services import ledger
from services.esl_client import (
    originate_call,
    get_call_status,
    hangup_call_confirmed,
    transfer_call_confirmed,
    redirect_call_confirmed,
    send_dtmf_confirmed,
    get_esl_client,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Default API tier settings (fallback if not configured)
DEFAULT_API_CPS_LIMIT = 5
DEFAULT_API_TIER = "api_basic"

# E.164: '+' then 1-15 digits (leading digit 1-9). This is the ONLY accepted form
# for the phone-number fields that flow into the FreeSWITCH ESL originate string.
# LOW-11: re.ASCII so ``\d`` matches ONLY [0-9] (never Unicode digits).
_E164_RE = re.compile(r"^\+[1-9]\d{1,14}$", re.ASCII)
# NANP 10-digit (5087282017) or 11-digit with leading 1 (15087282017) — normalized
# to E.164 for caller convenience, same as rcf.validate_e164.
_NANP_RE = re.compile(r"^1?[2-9]\d{9}$", re.ASCII)
# Any ASCII control char (NUL..US, DEL) — includes CR/LF/TAB. NONE of these may
# reach the ESL originate string: an embedded newline is an ESL command-injection
# vector (see esl_client._assert_esl_safe for the boundary defense).
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# MEDIUM-7: a live-call CONTROL command (uuid_transfer/uuid_send_dtmf/uuid_kill)
# is built as space-delimited ESL args, so a value with an embedded SPACE injects
# extra args (e.g. target "9999 XML public" overrides the dialplan/context and
# re-routes the call). The newline guard (_assert_esl_safe) does NOT stop spaces —
# these token regexes do. A transfer target is a single number/extension token; a
# DTMF string is only dial digits.
_XFER_TARGET_RE = re.compile(r"^[0-9A-D*#+]+$", re.ASCII)
_DTMF_DIGITS_RE = re.compile(r"^[0-9A-D*#]+$", re.ASCII)

# Whitelisted FreeSWITCH hangup causes for uuid_kill's optional cause arg. Anything
# outside this set is rejected so `cause` cannot smuggle extra ESL args (the causes
# are the canonical switch_channel_cause2str names — all bare UPPER_SNAKE tokens).
_HANGUP_CAUSES = frozenset({
    "UNSPECIFIED", "UNALLOCATED_NUMBER", "NO_ROUTE_TRANSIT_NET",
    "NO_ROUTE_DESTINATION", "CHANNEL_UNACCEPTABLE", "CALL_AWARDED_DELIVERED",
    "NORMAL_CLEARING", "USER_BUSY", "NO_USER_RESPONSE", "NO_ANSWER",
    "SUBSCRIBER_ABSENT", "CALL_REJECTED", "NUMBER_CHANGED",
    "REDIRECTION_TO_NEW_DESTINATION", "EXCHANGE_ROUTING_ERROR",
    "DESTINATION_OUT_OF_ORDER", "INVALID_NUMBER_FORMAT", "FACILITY_REJECTED",
    "RESPONSE_TO_STATUS_ENQUIRY", "NORMAL_UNSPECIFIED",
    "NORMAL_CIRCUIT_CONGESTION", "NETWORK_OUT_OF_ORDER",
    "NORMAL_TEMPORARY_FAILURE", "SWITCH_CONGESTION", "ACCESS_INFO_DISCARDED",
    "REQUESTED_CHAN_UNAVAIL", "PRE_EMPTED", "FACILITY_NOT_SUBSCRIBED",
    "OUTGOING_CALL_BARRED", "INCOMING_CALL_BARRED", "BEARERCAPABILITY_NOTAUTH",
    "BEARERCAPABILITY_NOTAVAIL", "SERVICE_UNAVAILABLE",
    "BEARERCAPABILITY_NOTIMPL", "CHAN_NOT_IMPLEMENTED",
    "FACILITY_NOT_IMPLEMENTED", "SERVICE_NOT_IMPLEMENTED",
    "INVALID_CALL_REFERENCE", "INCOMPATIBLE_DESTINATION",
    "INVALID_MSG_UNSPECIFIED", "MANDATORY_IE_MISSING", "MESSAGE_TYPE_NONEXIST",
    "WRONG_MESSAGE", "IE_NONEXIST", "INVALID_IE_CONTENTS", "WRONG_CALL_STATE",
    "RECOVERY_ON_TIMER_EXPIRE", "MANDATORY_IE_LENGTH_ERROR", "PROTOCOL_ERROR",
    "INTERWORKING", "ORIGINATOR_CANCEL", "CRASH", "SYSTEM_SHUTDOWN",
    "LOSE_RACE", "MANAGER_REQUEST", "BLIND_TRANSFER", "ATTENDED_TRANSFER",
    "ALLOTTED_TIMEOUT", "USER_CHALLENGE", "MEDIA_TIMEOUT", "PICKED_OFF",
    "USER_NOT_REGISTERED", "PROGRESS_TIMEOUT", "GATEWAY_DOWN",
})


def _validate_transfer_target(value: str) -> str:
    """Validate a transfer ``target`` (MEDIUM-7): a single E.164/NANP number
    (normalized) or a bare extension token — NEVER anything with a space, which
    would inject dialplan/context args into ``uuid_transfer``. Raises 400."""
    v = (value or "").strip()
    if not v:
        raise HTTPException(status_code=400, detail="Transfer requires target")
    if _CONTROL_RE.search(v):
        raise HTTPException(status_code=400, detail="target contains illegal characters")
    if _E164_RE.match(v) or _NANP_RE.match(v):
        try:
            return _normalize_e164(v, "target")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    if _XFER_TARGET_RE.match(v):
        return v
    raise HTTPException(
        status_code=400,
        detail="target must be an E.164 number or a bare extension (digits/A-D/*/#)",
    )


def _validate_redirect_target(value: str) -> str:
    """Validate a redirect ``target`` (new voice_url). It flows into
    ``uuid_setvar <uuid> voice_url <url>``, so it must be a clean http(s) URL with
    no whitespace/control chars (MEDIUM-7). Raises 400."""
    v = (value or "").strip()
    if not v:
        raise HTTPException(status_code=400, detail="Redirect requires target (new TwiML URL)")
    if _CONTROL_RE.search(v) or any(ch.isspace() for ch in v):
        raise HTTPException(
            status_code=400, detail="target URL contains illegal whitespace/control characters"
        )
    if not (v.startswith("http://") or v.startswith("https://")):
        raise HTTPException(status_code=400, detail="redirect target must be an http(s) URL")
    return v


def _normalize_e164(value: str, field: str) -> str:
    """Validate + normalize a phone number to E.164 for ESL origination.

    Rejects control characters (CR/LF injection) and anything that is not a clean
    E.164 / NANP number. Raises ValueError (→ 422) on any violation so a malformed
    or malicious value never reaches FreeSWITCH."""
    if value is None:
        raise ValueError(f"{field} is required")
    v = value.strip()
    if not v:
        raise ValueError(f"{field} must not be empty")
    if _CONTROL_RE.search(v):
        raise ValueError(f"{field} contains illegal control characters")
    if _E164_RE.match(v):
        return v
    if _NANP_RE.match(v):
        digits = v if v.startswith("1") and len(v) == 11 else "1" + v
        return "+" + digits
    raise ValueError(
        f"{field} must be E.164 (e.g. +15087282017); got an invalid value"
    )


def _validate_callback_url(value: Optional[str], field: str) -> Optional[str]:
    """Validate an optional webhook/callback URL destined for the ESL vars.

    Must be an http(s) URL with no control characters (the value is embedded in
    the originate channel-vars string; a CR/LF would be an injection vector)."""
    if value is None:
        return None
    v = value.strip()
    if v == "":
        return None
    if _CONTROL_RE.search(v):
        raise ValueError(f"{field} contains illegal control characters")
    if not (v.startswith("http://") or v.startswith("https://")):
        raise ValueError(f"{field} must be an http(s) URL")
    return v


class CallCreate(BaseModel):
    from_did: str
    to: str
    webhook_url: Optional[str] = None
    status_callback: Optional[str] = None
    timeout: int = 60
    caller_id: Optional[str] = None

    @field_validator("from_did", "to")
    @classmethod
    def _validate_required_phone(cls, v: str, info) -> str:
        """from_did and to are E.164 (they flow into the ESL originate string)."""
        return _normalize_e164(v, info.field_name)

    @field_validator("caller_id")
    @classmethod
    def _validate_caller_id(cls, v: Optional[str]) -> Optional[str]:
        """Optional presented caller ID must be E.164 if provided (anti-spoof +
        anti-injection)."""
        if v is None or v.strip() == "":
            return None
        return _normalize_e164(v, "caller_id")

    @field_validator("webhook_url", "status_callback")
    @classmethod
    def _validate_urls(cls, v: Optional[str], info) -> Optional[str]:
        return _validate_callback_url(v, info.field_name)

    @field_validator("timeout")
    @classmethod
    def _validate_timeout(cls, v: int) -> int:
        if v < 1 or v > 600:
            raise ValueError("timeout must be between 1 and 600 seconds")
        return v


class CallUpdate(BaseModel):
    action: str  # hangup | transfer | redirect | dtmf
    target: Optional[str] = None      # transfer destination / redirect TwiML URL
    digits: Optional[str] = None      # for action=dtmf
    cause: Optional[str] = None       # for action=hangup (default NORMAL_CLEARING)
    confirm_timeout: float = 5.0      # seconds to wait for the confirming event

    @field_validator("digits")
    @classmethod
    def _validate_digits(cls, v: Optional[str]) -> Optional[str]:
        """DTMF digits are 0-9/A-D/*/# only (MEDIUM-7: no spaces → no
        uuid_send_dtmf arg injection)."""
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not _DTMF_DIGITS_RE.match(v):
            raise ValueError("digits must contain only 0-9, A-D, *, #")
        return v

    @field_validator("cause")
    @classmethod
    def _validate_cause(cls, v: Optional[str]) -> Optional[str]:
        """Hangup cause must be a recognized FreeSWITCH cause (MEDIUM-7: whitelist,
        so `cause` cannot smuggle extra uuid_kill args)."""
        if v is None:
            return None
        v = v.strip().upper()
        if not v:
            return None
        if v not in _HANGUP_CAUSES:
            raise ValueError("cause is not a recognized hangup cause")
        return v


@router.post("")
async def create_call(
    call: CallCreate,
    background_tasks: BackgroundTasks,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Initiate an outbound call via API.

    Tenant-scoped (SEC): a non-admin may ONLY originate from a DID their own
    customer owns. Without this, any authenticated user could originate calls on
    another tenant's DID — toll fraud, caller-ID spoofing, and draining the
    victim's balance (the owner resolved from the DID row is who gets billed).
    A cross-tenant from_did returns the same 404 as an unknown DID (no leak).

    Enforces tiered CPS limits before allowing call origination.
    Returns 429 with upgrade recommendations if over CPS limit.
    """
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
        WHERE a.did = $1 AND a.enabled = true
        """,
        call.from_did
    )

    if not did_info:
        raise HTTPException(status_code=404, detail="From DID not found or not enabled")
    # SEC-3 ownership gate: a non-admin may only originate from their own DID. A
    # cross-tenant DID is treated as "not found" so its existence is not leaked
    # (mirrors api_dids._get_owned_did / calls._deny_cross_tenant).
    if customer_filter is not None and did_info["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="From DID not found or not enabled")
    if did_info["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    customer_id = did_info["customer_id"]

    # Get CPS limit from tier (use default if no tier configured)
    api_tier_name = did_info.get("api_tier_name") or DEFAULT_API_TIER
    api_cps_limit = did_info.get("api_cps_limit") or DEFAULT_API_CPS_LIMIT
    per_call_fee = float(did_info.get("per_call_fee") or 0.01)

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

    # Store call in active_calls table with tier info for billing
    await db.execute(
        """
        INSERT INTO active_calls (uuid, customer_id, product_type, direction, caller_id, destination)
        VALUES ($1, $2, 'api', 'outbound', $3, $4)
        """,
        call_uuid, customer_id, call.from_did, call.to
    )

    # Originate call via FreeSWITCH ESL
    try:
        success = await originate_call(
            uuid=call_uuid,
            from_did=call.from_did,
            to=call.to,
            customer_id=customer_id,
            traffic_grade=did_info["traffic_grade"],
            webhook_url=call.webhook_url or did_info["voice_url"],
            timeout=call.timeout
        )

        if not success:
            raise HTTPException(status_code=500, detail="Failed to originate call")

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
        "status": "initiated",
        "from": call.from_did,
        "to": call.to,
        "tier": api_tier_name,
        "per_call_fee": per_call_fee
    }


@router.get("/live")
async def list_live_calls(
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List LIVE calls from the Phase 5 ESL in-memory live-call registry.

    Tenant-scoped: non-admins (``customer_filter`` set) see only calls tagged
    with their own customer_id; admins (None) see all. Hung-up calls (still
    lingering in the registry within their prune TTL) are excluded — this is the
    in-progress view.

    Degrades gracefully when ESL is disconnected: the registry is in-memory and
    is NOT cleared on disconnect, so this returns the last-known calls with
    ``esl_connected=false`` rather than erroring — never a 500.

    PROD-3: cross-worker consistency. Reads come from ``live_snapshot()`` which
    unions this worker's in-memory registry with the Redis-mirrored calls written
    by all workers, so the result is consistent across the 4 uvicorn workers even
    if one worker's ESL connection is momentarily reconnecting. Degrades to the
    local registry when Redis is unavailable — never a 500.
    """
    client = get_esl_client()
    calls = []
    for c in await client.live_snapshot():
        if c.get("state") == "hungup":
            continue
        if customer_filter is not None and c.get("customer_id") != customer_filter:
            continue
        calls.append({
            "uuid": c.get("uuid"),
            "customer_id": c.get("customer_id"),
            "caller": c.get("caller"),
            "dest": c.get("dest"),
            "direction": c.get("direction"),
            "state": c.get("state"),
            "answered_at": c.get("answered_at"),
        })
    return {
        "esl_connected": client.connected,
        "count": len(calls),
        "calls": calls,
    }


async def _resolve_call_owner(call_id: str) -> Optional[int]:
    """Resolve the customer_id that owns ``call_id`` for tenant scoping (SEC-1).

    Reads, in order of authority for a LIVE call: the ESL live-call registry
    (event-derived, real-time), then the ``active_calls`` table (API-originated
    calls), then ``cdrs`` (completed calls). Returns None when the call is unknown
    or has no customer_id (e.g. an inbound call with no customer channel var) —
    callers treat None as "deny for non-admins" to avoid cross-tenant leakage.
    """
    client = get_esl_client()
    live = client.get_call(call_id)
    if live is not None and live.customer_id is not None:
        return live.customer_id
    row = await db.fetch_one(
        "SELECT customer_id FROM active_calls WHERE uuid = $1", call_id
    )
    if row and row["customer_id"] is not None:
        return row["customer_id"]
    row = await db.fetch_one(
        "SELECT customer_id FROM cdrs WHERE uuid = $1 ORDER BY start_time DESC LIMIT 1",
        call_id,
    )
    if row:
        return row["customer_id"]
    return None


def _deny_cross_tenant(owner: Optional[int], customer_filter: Optional[int]) -> None:
    """404 when a non-admin (``customer_filter`` set) does not own the call.

    Mirrors recordings.py / media.py: a cross-tenant id is indistinguishable from
    a missing one (404) so call existence is never leaked across tenants.
    """
    if customer_filter is not None and owner != customer_filter:
        raise HTTPException(status_code=404, detail="Call not found")


@router.get("/{call_id}")
async def get_call(
    call_id: str,
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Get call status by ID. Tenant-scoped: a non-admin may only read calls
    owned by their own customer (cross-tenant → 404)."""
    # SEC-1: resolve the owning customer and deny cross-tenant reads first.
    owner = await _resolve_call_owner(call_id)
    _deny_cross_tenant(owner, customer_filter)

    # Check active calls first
    active = await db.fetch_one(
        """
        SELECT uuid, customer_id, product_type, direction, caller_id, destination,
               start_time, answer_time, state
        FROM active_calls WHERE uuid = $1
        """,
        call_id
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

    # Check CDRs for completed calls
    cdr = await db.fetch_one(
        """
        SELECT uuid, direction, caller_id, destination, start_time,
               answer_time, end_time, duration_ms, hangup_cause
        FROM cdrs WHERE uuid = $1
        ORDER BY start_time DESC LIMIT 1
        """,
        call_id
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
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Modify a LIVE call, event-confirmed (not fire-and-forget).

    Each action issues the ESL command over the persistent control connection
    and then waits to observe the resulting CHANNEL event (HANGUP for hangup,
    transfer EXECUTE_COMPLETE for transfer/redirect, send_dtmf EXECUTE_COMPLETE
    for dtmf). The response reports `confirmed: true/false` so callers know the
    switch actually applied the change.

    Actions:
      - hangup   : uuid_kill (optional `cause`)
      - transfer : uuid_transfer to `target` extension
      - redirect : point the call at new TwiML (`target` = voice_url), then
                   transfer it back into the voice engine to re-fetch
      - dtmf     : uuid_send_dtmf `digits`
    """
    # SEC-1: resolve the owning customer and deny cross-tenant control first, so a
    # non-owner can never hangup/transfer/redirect/DTMF another tenant's live call.
    owner = await _resolve_call_owner(call_id)
    _deny_cross_tenant(owner, customer_filter)

    # Verify call exists and is active
    active = await db.fetch_one(
        "SELECT uuid, state FROM active_calls WHERE uuid = $1",
        call_id
    )

    if not active:
        raise HTTPException(status_code=404, detail="Active call not found")

    action = update.action
    timeout = max(0.5, min(update.confirm_timeout, 30.0))

    if action == "hangup":
        result = await hangup_call_confirmed(
            call_id, cause=update.cause or "NORMAL_CLEARING", timeout=timeout
        )
        if not result["ok"]:
            raise HTTPException(status_code=500, detail="Failed to hangup call")
        return {
            "call_id": call_id, "action": "hangup", "status": "success",
            "confirmed": result["confirmed"], "hangup_cause": result["hangup_cause"],
        }

    elif action == "transfer":
        # MEDIUM-7: reject a target that could inject extra uuid_transfer args.
        target = _validate_transfer_target(update.target)
        result = await transfer_call_confirmed(call_id, target, timeout=timeout)
        if not result["ok"]:
            raise HTTPException(status_code=500, detail="Failed to transfer call")
        return {
            "call_id": call_id, "action": "transfer", "target": target,
            "status": "success", "confirmed": result["confirmed"],
        }

    elif action == "redirect":
        # MEDIUM-7: redirect target flows into uuid_setvar — require a clean URL.
        target = _validate_redirect_target(update.target)
        result = await redirect_call_confirmed(call_id, target, timeout=timeout)
        if not result["ok"]:
            raise HTTPException(status_code=500, detail="Failed to redirect call")
        return {
            "call_id": call_id, "action": "redirect", "voice_url": target,
            "status": "success", "confirmed": result["confirmed"],
        }

    elif action == "dtmf":
        if not update.digits:
            raise HTTPException(status_code=400, detail="DTMF requires digits")
        result = await send_dtmf_confirmed(call_id, update.digits, timeout=timeout)
        if not result["ok"]:
            raise HTTPException(status_code=500, detail="Failed to send DTMF")
        return {
            "call_id": call_id, "action": "dtmf", "digits": update.digits,
            "status": "success", "confirmed": result["confirmed"],
        }

    else:
        raise HTTPException(status_code=400, detail=f"Unknown action: {action}")


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

    Args:
        call_uuid: The call UUID for logging
        customer_id: Customer ID to charge
        per_call_fee: Per-call fee from the tier
        api_tier_name: Tier name for logging

    Returns:
        True if fee applied successfully

    The fee is routed through the append-only ledger (``post_ledger_entry``) as a
    NEGATIVE ``fee`` entry (source ``rating``), NOT a direct ``balance = balance -
    …`` write — the customers.balance cache is only ever moved inside the ledger
    service so the reconciliation invariant holds. The idempotency key is
    ``api_call_fee:{call_uuid}`` so a retried background task can NEVER double-charge.
    """
    if per_call_fee <= 0:
        return True  # No fee to apply

    try:
        # Coerce the tier fee (a float from tier config) to an EXACT Decimal via
        # str; usage/fee is money OUT so the ledger amount is negative.
        fee = Decimal(str(per_call_fee))
        entry = await ledger.post_ledger_entry(
            customer_id,
            amount=-fee,
            entry_type="fee",
            source="rating",
            idempotency_key=f"api_call_fee:{call_uuid}",
            metadata={"reason": "api_per_call_fee", "call_uuid": call_uuid,
                      "tier": api_tier_name},
        )
        new_balance = entry["balance_after"]
        logger.info(
            f"Applied per-call fee: customer={customer_id}, "
            f"call={call_uuid}, fee=${float(fee):.4f}, "
            f"tier={api_tier_name}, new_balance="
            f"{f'${float(new_balance):.4f}' if new_balance is not None else 'n/a'}"
        )
        return True

    except ValueError as e:
        # ledger raises ValueError when the customer does not exist.
        logger.error(f"Failed to apply per-call fee: {e} (call {call_uuid})")
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
