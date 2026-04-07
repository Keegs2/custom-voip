"""CPS Tier Management Endpoints.

Implements tiered CPS (Calls Per Second) limits for SIP Trunks and API Calling.
This system encourages high-volume SIP trunk customers to upgrade to API calling
for higher CPS limits and revenue generation.

TIER STRUCTURE:
SIP Trunks (capped at 10 CPS):
- trunk_free: 5 CPS, $0/month
- trunk_paid: 10 CPS, $49.99/month

API Calling (higher limits, per-call fees):
- api_starter: 25 CPS, $99/month, $0.01/call
- api_professional: 50 CPS, $299/month, $0.008/call
- api_enterprise: 100 CPS, $799/month, $0.005/call
"""
import json

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, field_validator
from typing import Optional, List
from datetime import datetime, timedelta
from decimal import Decimal
from db import database as db
from db import redis_client as cache

router = APIRouter()

# Constants
MAX_TRUNK_CPS = 10  # Hard cap for SIP trunk CPS


# Pydantic Models

class TierResponse(BaseModel):
    """Response model for a CPS tier."""
    id: int
    name: str
    tier_type: str
    cps_limit: int
    monthly_fee: float
    per_call_fee: float
    description: Optional[str] = None
    features: Optional[dict] = None
    is_active: bool
    sort_order: int

    @field_validator('features', mode='before')
    @classmethod
    def parse_features(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        return v


class CustomerTierResponse(BaseModel):
    """Response model for customer tier information."""
    customer_id: int
    customer_name: str
    account_type: str
    trunk_tier: Optional[TierResponse] = None
    api_tier: Optional[TierResponse] = None
    cps_tier_updated_at: Optional[datetime] = None
    upgrade_recommendations: Optional[List[str]] = None


class TierUpdateRequest(BaseModel):
    """Request model for updating customer tiers."""
    trunk_tier_name: Optional[str] = None
    api_tier_name: Optional[str] = None
    change_reason: Optional[str] = None
    changed_by: Optional[str] = "api"

    @field_validator('trunk_tier_name')
    @classmethod
    def validate_trunk_tier(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not v.startswith('trunk_'):
            raise ValueError('Trunk tier name must start with "trunk_"')
        return v

    @field_validator('api_tier_name')
    @classmethod
    def validate_api_tier(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not v.startswith('api_'):
            raise ValueError('API tier name must start with "api_"')
        return v


class CPSUsageResponse(BaseModel):
    """Response model for CPS usage data."""
    customer_id: int
    usage_type: str
    tier_name: Optional[str] = None
    calls_count: int
    peak_cps: float
    period_start: datetime
    period_end: datetime


class TierChangeResponse(BaseModel):
    """Response model for tier change history."""
    id: int
    customer_id: int
    tier_type: str
    old_tier_name: Optional[str] = None
    new_tier_name: str
    change_reason: Optional[str] = None
    changed_by: Optional[str] = None
    effective_at: datetime
    created_at: datetime


class RedisSyncResponse(BaseModel):
    """Response model for Redis sync operation."""
    customer_id: int
    synced_tiers: List[dict]
    success: bool
    message: str


# Helper Functions

async def get_tier_by_name(tier_name: str) -> Optional[dict]:
    """Fetch a tier by its name."""
    result = await db.fetch_one(
        """
        SELECT id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
               description, features, is_active, sort_order
        FROM cps_tiers
        WHERE name = $1 AND is_active = true
        """,
        tier_name
    )
    return dict(result) if result else None


async def get_tier_by_id(tier_id: int) -> Optional[dict]:
    """Fetch a tier by its ID."""
    result = await db.fetch_one(
        """
        SELECT id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
               description, features, is_active, sort_order
        FROM cps_tiers
        WHERE id = $1
        """,
        tier_id
    )
    return dict(result) if result else None


async def get_customer_with_tiers(customer_id: int) -> Optional[dict]:
    """Fetch customer with their current tier information."""
    result = await db.fetch_one(
        """
        SELECT
            c.id AS customer_id,
            c.name AS customer_name,
            c.account_type,
            c.trunk_tier_id,
            c.api_tier_id,
            c.cps_tier_updated_at,
            tt.id AS trunk_tier_pk,
            tt.name AS trunk_tier_name,
            tt.tier_type AS trunk_tier_type,
            tt.cps_limit AS trunk_cps_limit,
            tt.monthly_fee AS trunk_monthly_fee,
            tt.per_call_fee AS trunk_per_call_fee,
            tt.description AS trunk_description,
            tt.features AS trunk_features,
            tt.is_active AS trunk_is_active,
            tt.sort_order AS trunk_sort_order,
            at.id AS api_tier_pk,
            at.name AS api_tier_name,
            at.tier_type AS api_tier_type,
            at.cps_limit AS api_cps_limit,
            at.monthly_fee AS api_monthly_fee,
            at.per_call_fee AS api_per_call_fee,
            at.description AS api_description,
            at.features AS api_features,
            at.is_active AS api_is_active,
            at.sort_order AS api_sort_order
        FROM customers c
        LEFT JOIN cps_tiers tt ON c.trunk_tier_id = tt.id
        LEFT JOIN cps_tiers at ON c.api_tier_id = at.id
        WHERE c.id = $1
        """,
        customer_id
    )
    return dict(result) if result else None


def build_upgrade_recommendations(
    account_type: str,
    trunk_tier_name: Optional[str],
    api_tier_name: Optional[str],
    trunk_cps_limit: Optional[int],
    api_cps_limit: Optional[int]
) -> List[str]:
    """Generate upgrade recommendations based on current tiers."""
    recommendations = []

    # Trunk upgrade recommendations
    if trunk_tier_name:
        if trunk_tier_name == 'trunk_free':
            recommendations.append(
                "Upgrade to trunk_paid ($49.99/mo) for 10 CPS - double your current limit."
            )
        if trunk_cps_limit and trunk_cps_limit >= MAX_TRUNK_CPS:
            recommendations.append(
                "You've reached the maximum trunk CPS (10). "
                "Upgrade to API Calling for up to 100 CPS and advanced features."
            )

    # API upgrade recommendations
    if api_tier_name:
        if api_tier_name == 'api_starter':
            recommendations.append(
                "Upgrade to api_professional ($299/mo) for 50 CPS and lower per-call fees ($0.008 vs $0.01)."
            )
        elif api_tier_name == 'api_professional':
            recommendations.append(
                "Upgrade to api_enterprise ($799/mo) for 100 CPS and the lowest per-call fees ($0.005)."
            )

    # Cross-sell recommendations
    if account_type == 'trunk' and not api_tier_name:
        recommendations.append(
            "Enable API Calling to unlock higher CPS limits, webhooks, and programmatic call control."
        )

    return recommendations


# Endpoints

@router.get("", response_model=List[TierResponse])
async def list_all_tiers(
    is_active: bool = Query(default=True, description="Filter by active status")
):
    """List all available CPS tiers.

    Returns all trunk and API tiers sorted by type and sort_order.
    """
    query = """
        SELECT id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
               description, features, is_active, sort_order
        FROM cps_tiers
    """
    if is_active:
        query += " WHERE is_active = true"
    query += " ORDER BY tier_type, sort_order"

    results = await db.fetch_all(query)
    return [
        TierResponse(
            id=r["id"],
            name=r["name"],
            tier_type=r["tier_type"],
            cps_limit=r["cps_limit"],
            monthly_fee=float(r["monthly_fee"]),
            per_call_fee=float(r["per_call_fee"]),
            description=r["description"],
            features=r["features"],
            is_active=r["is_active"],
            sort_order=r["sort_order"]
        )
        for r in results
    ]


@router.get("/{tier_type}", response_model=List[TierResponse])
async def list_tiers_by_type(
    tier_type: str,
    is_active: bool = Query(default=True, description="Filter by active status")
):
    """List CPS tiers by type (trunk or api).

    Args:
        tier_type: Either 'trunk' or 'api'
        is_active: Filter by active status (default True)
    """
    if tier_type not in ('trunk', 'api'):
        raise HTTPException(
            status_code=400,
            detail="tier_type must be 'trunk' or 'api'"
        )

    query = """
        SELECT id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
               description, features, is_active, sort_order
        FROM cps_tiers
        WHERE tier_type = $1
    """
    values = [tier_type]

    if is_active:
        query += " AND is_active = true"
    query += " ORDER BY sort_order"

    results = await db.fetch_all(query, *values)
    return [
        TierResponse(
            id=r["id"],
            name=r["name"],
            tier_type=r["tier_type"],
            cps_limit=r["cps_limit"],
            monthly_fee=float(r["monthly_fee"]),
            per_call_fee=float(r["per_call_fee"]),
            description=r["description"],
            features=r["features"],
            is_active=r["is_active"],
            sort_order=r["sort_order"]
        )
        for r in results
    ]


@router.get("/customers/{customer_id}", response_model=CustomerTierResponse)
async def get_customer_tiers(customer_id: int):
    """Get customer's current tier information.

    Returns the customer's trunk and API tiers along with upgrade recommendations.
    """
    customer = await get_customer_with_tiers(customer_id)
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    # Build tier response objects
    trunk_tier = None
    if customer["trunk_tier_pk"]:
        trunk_tier = TierResponse(
            id=customer["trunk_tier_pk"],
            name=customer["trunk_tier_name"],
            tier_type=customer["trunk_tier_type"],
            cps_limit=customer["trunk_cps_limit"],
            monthly_fee=float(customer["trunk_monthly_fee"]),
            per_call_fee=float(customer["trunk_per_call_fee"]),
            description=customer["trunk_description"],
            features=customer["trunk_features"],
            is_active=customer["trunk_is_active"],
            sort_order=customer["trunk_sort_order"]
        )

    api_tier = None
    if customer["api_tier_pk"]:
        api_tier = TierResponse(
            id=customer["api_tier_pk"],
            name=customer["api_tier_name"],
            tier_type=customer["api_tier_type"],
            cps_limit=customer["api_cps_limit"],
            monthly_fee=float(customer["api_monthly_fee"]),
            per_call_fee=float(customer["api_per_call_fee"]),
            description=customer["api_description"],
            features=customer["api_features"],
            is_active=customer["api_is_active"],
            sort_order=customer["api_sort_order"]
        )

    # Build upgrade recommendations
    recommendations = build_upgrade_recommendations(
        account_type=customer["account_type"],
        trunk_tier_name=customer.get("trunk_tier_name"),
        api_tier_name=customer.get("api_tier_name"),
        trunk_cps_limit=customer.get("trunk_cps_limit"),
        api_cps_limit=customer.get("api_cps_limit")
    )

    return CustomerTierResponse(
        customer_id=customer["customer_id"],
        customer_name=customer["customer_name"],
        account_type=customer["account_type"],
        trunk_tier=trunk_tier,
        api_tier=api_tier,
        cps_tier_updated_at=customer["cps_tier_updated_at"],
        upgrade_recommendations=recommendations if recommendations else None
    )


@router.put("/customers/{customer_id}", response_model=CustomerTierResponse)
async def update_customer_tiers(customer_id: int, request: TierUpdateRequest):
    """Update customer's CPS tiers.

    Validates tier changes and enforces business rules:
    - Trunk tiers are capped at 10 CPS maximum
    - Customers needing more than 10 CPS must upgrade to API calling

    After update, syncs the new limits to Redis for FreeSWITCH.
    """
    # Verify customer exists
    customer = await get_customer_with_tiers(customer_id)
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    if not request.trunk_tier_name and not request.api_tier_name:
        raise HTTPException(
            status_code=400,
            detail="At least one tier (trunk or api) must be specified"
        )

    updates = []
    values = []
    idx = 1

    # Process trunk tier update
    if request.trunk_tier_name:
        trunk_tier = await get_tier_by_name(request.trunk_tier_name)
        if not trunk_tier:
            raise HTTPException(
                status_code=404,
                detail=f"Trunk tier '{request.trunk_tier_name}' not found"
            )
        if trunk_tier["tier_type"] != "trunk":
            raise HTTPException(
                status_code=400,
                detail=f"Tier '{request.trunk_tier_name}' is not a trunk tier"
            )
        # Validate trunk CPS cap
        if trunk_tier["cps_limit"] > MAX_TRUNK_CPS:
            raise HTTPException(
                status_code=400,
                detail=f"Trunk CPS cannot exceed {MAX_TRUNK_CPS}. "
                       "Upgrade to API calling for higher limits."
            )

        updates.append(f"trunk_tier_id = ${idx}")
        values.append(trunk_tier["id"])
        idx += 1

    # Process API tier update
    if request.api_tier_name:
        api_tier = await get_tier_by_name(request.api_tier_name)
        if not api_tier:
            raise HTTPException(
                status_code=404,
                detail=f"API tier '{request.api_tier_name}' not found"
            )
        if api_tier["tier_type"] != "api":
            raise HTTPException(
                status_code=400,
                detail=f"Tier '{request.api_tier_name}' is not an API tier"
            )

        updates.append(f"api_tier_id = ${idx}")
        values.append(api_tier["id"])
        idx += 1

    # Update the customer
    values.append(customer_id)
    update_query = f"""
        UPDATE customers
        SET {', '.join(updates)}, cps_tier_updated_at = NOW()
        WHERE id = ${idx}
        RETURNING id
    """
    await db.execute(update_query, *values)

    # Log tier changes manually with custom reason/changed_by
    # (The trigger logs with 'system', but we want custom values)
    if request.trunk_tier_name:
        trunk_tier = await get_tier_by_name(request.trunk_tier_name)
        await db.execute(
            """
            INSERT INTO cps_tier_changes
            (customer_id, tier_type, old_tier_id, new_tier_id, change_reason, changed_by)
            VALUES ($1, 'trunk', $2, $3, $4, $5)
            """,
            customer_id,
            customer.get("trunk_tier_id"),
            trunk_tier["id"],
            request.change_reason or "Tier changed via API",
            request.changed_by or "api"
        )

    if request.api_tier_name:
        api_tier = await get_tier_by_name(request.api_tier_name)
        await db.execute(
            """
            INSERT INTO cps_tier_changes
            (customer_id, tier_type, old_tier_id, new_tier_id, change_reason, changed_by)
            VALUES ($1, 'api', $2, $3, $4, $5)
            """,
            customer_id,
            customer.get("api_tier_id"),
            api_tier["id"],
            request.change_reason or "Tier changed via API",
            request.changed_by or "api"
        )

    # Sync to Redis after tier change
    await sync_customer_tiers_to_redis(customer_id)

    # Return updated customer tiers
    return await get_customer_tiers(customer_id)


@router.get("/customers/{customer_id}/usage", response_model=List[CPSUsageResponse])
async def get_customer_cps_usage(
    customer_id: int,
    usage_type: Optional[str] = Query(default=None, description="Filter by 'trunk' or 'api'"),
    start_date: Optional[datetime] = Query(default=None, description="Start of period"),
    end_date: Optional[datetime] = Query(default=None, description="End of period"),
    limit: int = Query(default=100, le=1000, description="Max records to return")
):
    """Get CPS usage history for a customer.

    Returns historical CPS usage data for billing and analytics.
    """
    # Verify customer exists
    customer = await db.fetch_one(
        "SELECT id FROM customers WHERE id = $1",
        customer_id
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    # Default to last 30 days
    if not start_date:
        start_date = datetime.utcnow() - timedelta(days=30)
    if not end_date:
        end_date = datetime.utcnow()

    query = """
        SELECT
            u.customer_id,
            u.usage_type,
            t.name AS tier_name,
            u.calls_count,
            u.peak_cps,
            u.period_start,
            u.period_end
        FROM cps_usage_log u
        LEFT JOIN cps_tiers t ON u.tier_id = t.id
        WHERE u.customer_id = $1
          AND u.period_start >= $2
          AND u.period_end <= $3
    """
    values = [customer_id, start_date, end_date]
    idx = 4

    if usage_type:
        if usage_type not in ('trunk', 'api'):
            raise HTTPException(
                status_code=400,
                detail="usage_type must be 'trunk' or 'api'"
            )
        query += f" AND u.usage_type = ${idx}"
        values.append(usage_type)
        idx += 1

    query += f" ORDER BY u.period_start DESC LIMIT ${idx}"
    values.append(limit)

    results = await db.fetch_all(query, *values)

    return [
        CPSUsageResponse(
            customer_id=r["customer_id"],
            usage_type=r["usage_type"],
            tier_name=r["tier_name"],
            calls_count=r["calls_count"],
            peak_cps=float(r["peak_cps"]) if r["peak_cps"] else 0.0,
            period_start=r["period_start"],
            period_end=r["period_end"]
        )
        for r in results
    ]


@router.get("/customers/{customer_id}/tier-history", response_model=List[TierChangeResponse])
async def get_customer_tier_history(
    customer_id: int,
    tier_type: Optional[str] = Query(default=None, description="Filter by 'trunk' or 'api'"),
    limit: int = Query(default=50, le=200, description="Max records to return")
):
    """Get tier change history for a customer.

    Returns historical tier changes for audit and analytics.
    """
    # Verify customer exists
    customer = await db.fetch_one(
        "SELECT id FROM customers WHERE id = $1",
        customer_id
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    query = """
        SELECT
            tc.id,
            tc.customer_id,
            tc.tier_type,
            old_t.name AS old_tier_name,
            new_t.name AS new_tier_name,
            tc.change_reason,
            tc.changed_by,
            tc.effective_at,
            tc.created_at
        FROM cps_tier_changes tc
        LEFT JOIN cps_tiers old_t ON tc.old_tier_id = old_t.id
        JOIN cps_tiers new_t ON tc.new_tier_id = new_t.id
        WHERE tc.customer_id = $1
    """
    values = [customer_id]
    idx = 2

    if tier_type:
        if tier_type not in ('trunk', 'api'):
            raise HTTPException(
                status_code=400,
                detail="tier_type must be 'trunk' or 'api'"
            )
        query += f" AND tc.tier_type = ${idx}"
        values.append(tier_type)
        idx += 1

    query += f" ORDER BY tc.created_at DESC LIMIT ${idx}"
    values.append(limit)

    results = await db.fetch_all(query, *values)

    return [
        TierChangeResponse(
            id=r["id"],
            customer_id=r["customer_id"],
            tier_type=r["tier_type"],
            old_tier_name=r["old_tier_name"],
            new_tier_name=r["new_tier_name"],
            change_reason=r["change_reason"],
            changed_by=r["changed_by"],
            effective_at=r["effective_at"],
            created_at=r["created_at"]
        )
        for r in results
    ]


@router.post("/customers/{customer_id}/sync-redis", response_model=RedisSyncResponse)
async def sync_tiers_to_redis(customer_id: int):
    """Manually sync customer tier limits to Redis.

    This is typically done automatically after tier changes, but can be
    triggered manually for troubleshooting or recovery scenarios.

    Redis key format: account:{customer_id}:limits (HASH)
    Fields: tier, cps_limit, type
    """
    # Verify customer exists and get tiers
    customer = await get_customer_with_tiers(customer_id)
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    synced_tiers = await sync_customer_tiers_to_redis(customer_id)

    return RedisSyncResponse(
        customer_id=customer_id,
        synced_tiers=synced_tiers,
        success=True,
        message="Tier limits synced to Redis successfully"
    )


# Internal Helper for Redis Sync

async def sync_customer_tiers_to_redis(customer_id: int) -> List[dict]:
    """Sync customer tier limits to Redis for FreeSWITCH to read.

    Key format: account:{customer_id}:limits
    Fields: tier, cps_limit, type

    Returns list of synced tier info for response.
    """
    customer = await get_customer_with_tiers(customer_id)
    if not customer:
        return []

    synced = []

    # Sync trunk tier if present
    if customer.get("trunk_tier_name"):
        await cache.sync_cps_tier_to_redis(
            customer_id=customer_id,
            tier_type="trunk",
            tier_name=customer["trunk_tier_name"],
            cps_limit=customer["trunk_cps_limit"]
        )
        synced.append({
            "type": "trunk",
            "tier": customer["trunk_tier_name"],
            "cps_limit": customer["trunk_cps_limit"]
        })

    # Sync API tier if present
    if customer.get("api_tier_name"):
        await cache.sync_cps_tier_to_redis(
            customer_id=customer_id,
            tier_type="api",
            tier_name=customer["api_tier_name"],
            cps_limit=customer["api_cps_limit"]
        )
        synced.append({
            "type": "api",
            "tier": customer["api_tier_name"],
            "cps_limit": customer["api_cps_limit"]
        })

    return synced
