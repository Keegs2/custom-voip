"""API Calling endpoints - initiate and control calls.

Implements tiered CPS (Calls Per Second) limits for API calling:
- api_basic: 5 CPS, $0.01/call
- api_standard: 8 CPS, $0.008/call
- api_premium: 15 CPS, $0.005/call
"""
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional
import uuid
import logging
from db import database as db
from db import redis_client as cache
from services.esl_client import originate_call, get_call_status, hangup_call

logger = logging.getLogger(__name__)

router = APIRouter()

# Default API tier settings (fallback if not configured)
DEFAULT_API_CPS_LIMIT = 5
DEFAULT_API_TIER = "api_basic"


class CallCreate(BaseModel):
    from_did: str
    to: str
    webhook_url: Optional[str] = None
    status_callback: Optional[str] = None
    timeout: int = 60
    caller_id: Optional[str] = None


class CallUpdate(BaseModel):
    action: str  # hangup, transfer, hold
    target: Optional[str] = None  # For transfer


@router.post("")
async def create_call(call: CallCreate, background_tasks: BackgroundTasks):
    """Initiate an outbound call via API.

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


@router.get("/{call_id}")
async def get_call(call_id: str):
    """Get call status by ID."""
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
async def update_call(call_id: str, update: CallUpdate):
    """Modify a live call (hangup, transfer, etc.)."""
    # Verify call exists and is active
    active = await db.fetch_one(
        "SELECT uuid, state FROM active_calls WHERE uuid = $1",
        call_id
    )

    if not active:
        raise HTTPException(status_code=404, detail="Active call not found")

    if update.action == "hangup":
        success = await hangup_call(call_id)
        if success:
            return {"call_id": call_id, "action": "hangup", "status": "success"}
        raise HTTPException(status_code=500, detail="Failed to hangup call")

    elif update.action == "transfer":
        if not update.target:
            raise HTTPException(status_code=400, detail="Transfer requires target")
        # Implement transfer via ESL
        raise HTTPException(status_code=501, detail="Transfer not yet implemented")

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
