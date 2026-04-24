"""CPS tier management endpoints (admin only)."""
import json
import logging
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator

from auth.dependencies import require_admin
from db import database as db

router = APIRouter()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class TierCreate(BaseModel):
    name: str
    tier_type: str
    cps_limit: int
    monthly_fee: float = 0.0
    per_call_fee: float = 0.0
    description: Optional[str] = None
    features: Optional[List[str]] = None
    is_active: bool = True
    sort_order: int = 0

    @field_validator("tier_type")
    @classmethod
    def validate_tier_type(cls, v: str) -> str:
        v = v.lower()
        if v not in ("rcf", "api", "trunk", "all"):
            raise ValueError("tier_type must be rcf, api, trunk, or all")
        return v

    @field_validator("cps_limit")
    @classmethod
    def validate_cps_limit(cls, v: int) -> int:
        if v < 1:
            raise ValueError("cps_limit must be at least 1")
        return v

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 50:
            raise ValueError("name must be 1-50 characters")
        return v


class TierUpdate(BaseModel):
    name: Optional[str] = None
    tier_type: Optional[str] = None
    cps_limit: Optional[int] = None
    monthly_fee: Optional[float] = None
    per_call_fee: Optional[float] = None
    description: Optional[str] = None
    features: Optional[List[str]] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None

    @field_validator("tier_type")
    @classmethod
    def validate_tier_type(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.lower()
            if v not in ("rcf", "api", "trunk", "all"):
                raise ValueError("tier_type must be rcf, api, trunk, or all")
        return v

    @field_validator("cps_limit")
    @classmethod
    def validate_cps_limit(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v < 1:
            raise ValueError("cps_limit must be at least 1")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _tier_row(row) -> dict:
    """Convert a cps_tiers row to the frontend Tier shape."""
    d = dict(row)
    # DB stores features as JSONB object; frontend expects a string array.
    # The seeded data has features like {"cps": 5, "support": "email", "features": [...]}
    # so we extract the inner "features" list if present, otherwise wrap as list.
    raw_features = d.get("features")
    if isinstance(raw_features, dict):
        d["features"] = raw_features.get("features", [])
    elif isinstance(raw_features, list):
        d["features"] = raw_features
    else:
        d["features"] = []
    return d


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/trunk")
async def list_trunk_tiers(admin: dict = Depends(require_admin)):
    """List trunk-type CPS tiers."""
    rows = await db.fetch_all(
        """
        SELECT id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
               description, features, is_active, sort_order,
               created_at, updated_at
        FROM cps_tiers
        WHERE tier_type = 'trunk'
        ORDER BY sort_order, name
        """
    )
    return [_tier_row(r) for r in rows]


@router.get("/api")
async def list_api_tiers(admin: dict = Depends(require_admin)):
    """List API-type CPS tiers."""
    rows = await db.fetch_all(
        """
        SELECT id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
               description, features, is_active, sort_order,
               created_at, updated_at
        FROM cps_tiers
        WHERE tier_type = 'api'
        ORDER BY sort_order, name
        """
    )
    return [_tier_row(r) for r in rows]


@router.get("/{tier_id}")
async def get_tier(tier_id: int, admin: dict = Depends(require_admin)):
    """Get a single CPS tier by ID."""
    row = await db.fetch_one(
        """
        SELECT id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
               description, features, is_active, sort_order,
               created_at, updated_at
        FROM cps_tiers
        WHERE id = $1
        """,
        tier_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Tier not found")
    return _tier_row(row)


@router.get("")
async def list_tiers(admin: dict = Depends(require_admin)):
    """List all CPS tiers."""
    rows = await db.fetch_all(
        """
        SELECT id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
               description, features, is_active, sort_order,
               created_at, updated_at
        FROM cps_tiers
        ORDER BY sort_order, name
        """
    )
    return [_tier_row(r) for r in rows]


@router.post("")
async def create_tier(body: TierCreate, admin: dict = Depends(require_admin)):
    """Create a new CPS tier."""
    # Convert features list to the JSONB format the DB expects
    features_json = json.dumps({"features": body.features or []})

    try:
        row = await db.fetch_one(
            """
            INSERT INTO cps_tiers
                (name, tier_type, cps_limit, monthly_fee, per_call_fee,
                 description, features, is_active, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
            RETURNING id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
                      description, features, is_active, sort_order,
                      created_at, updated_at
            """,
            body.name, body.tier_type, body.cps_limit,
            body.monthly_fee, body.per_call_fee,
            body.description, features_json,
            body.is_active, body.sort_order,
        )
        return _tier_row(row)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="Tier name already exists")
        raise


@router.patch("/{tier_id}")
async def update_tier(tier_id: int, body: TierUpdate, admin: dict = Depends(require_admin)):
    """Update a CPS tier."""
    update_data = body.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Convert features list to JSONB format if present
    if "features" in update_data:
        update_data["features"] = json.dumps({"features": update_data["features"]})

    updates = []
    values = []
    idx = 1
    for field, value in update_data.items():
        if field == "features":
            updates.append(f"features = ${idx}::jsonb")
        else:
            updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    values.append(tier_id)
    query = f"""
        UPDATE cps_tiers
        SET {', '.join(updates)}, updated_at = NOW()
        WHERE id = ${idx}
        RETURNING id, name, tier_type, cps_limit, monthly_fee, per_call_fee,
                  description, features, is_active, sort_order,
                  created_at, updated_at
    """

    row = await db.fetch_one(query, *values)
    if not row:
        raise HTTPException(status_code=404, detail="Tier not found")
    return _tier_row(row)


@router.delete("/{tier_id}")
async def delete_tier(tier_id: int, admin: dict = Depends(require_admin)):
    """Delete a CPS tier.

    Will fail if any customers are still assigned to this tier (FK constraint).
    """
    result = await db.execute("DELETE FROM cps_tiers WHERE id = $1", tier_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Tier not found")
    return {"status": "deleted", "id": tier_id}
