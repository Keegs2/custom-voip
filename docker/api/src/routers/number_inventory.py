"""DID inventory and lifecycle management endpoints.

Provides a complete DID management system backed by the did_inventory table:
  - Admin: full inventory, stats, Bandwidth sync, manual intake (POST /add
    with carrier-trunk attribution), assign/unassign
  - Customer: browse available numbers, view own numbers, request a number,
    request/cancel release of an assigned number

Carrier attribution (migration 41): every inventory row carries
source ('bandwidth_sync' | 'manual') and an optional carrier_trunk_id FK to
carrier_trunks (migration 40). Manual intake is the first-class path for
non-Bandwidth numbers (e.g. Sinch): admin POSTs a batch to /add attributed to
a carrier trunk, the DIDs land status='available', and the EXISTING
assign->customer->product flow takes over unchanged. source is the sync
OWNERSHIP BOUNDARY — POST /sync only manages rows with source='bandwidth_sync'
(manual rows never appear in its 'removed' report and never get their
metadata overwritten).

Release workflow (request-based): customer POST /{did}/request-release sets
'assigned' -> 'release_requested'; admin approves via POST /{did}/unassign
(accepts 'release_requested') or denies via POST /{did}/cancel-release
(back to 'assigned', also available to the customer to withdraw).

Cross-references Bandwidth TN inventory with internal product tables
(rcf_numbers, api_dids, trunk_dids) and manages the full DID lifecycle.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from db import database as db
from db import redis_client as cache
from auth.dependencies import require_admin, get_current_user, get_customer_filter
from services.bandwidth_client import get_all_tns, _credentials_configured
from utils import phone

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class AssignRequest(BaseModel):
    customer_id: int
    product_type: str
    # Required when product_type='rcf' (the number the DID forwards to — E.164
    # or a 3-6 digit local extension); ignored for every other product type.
    # Enforced in assign_did, not here, because the requirement is conditional.
    forward_to: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("product_type")
    @classmethod
    def validate_product_type(cls, v: str) -> str:
        allowed = ("rcf", "trunk", "api", "ucaas")
        if v not in allowed:
            raise ValueError(f"product_type must be one of {allowed}")
        return v


class UnassignRequest(BaseModel):
    notes: Optional[str] = None


class AddDIDsRequest(BaseModel):
    """Body for POST /add — manual DID intake with carrier-trunk attribution."""
    dids: list[str] = Field(min_length=1, max_length=500)
    carrier_trunk_id: int
    notes: Optional[str] = None


class CarrierTrunkAssociation(BaseModel):
    """Body for PUT /{did}/carrier-trunk.

    carrier_trunk_id is REQUIRED but nullable: an explicit null clears the
    association (back to the implicit-Bandwidth attribution legacy rows carry).
    """
    carrier_trunk_id: Optional[int]


class ReleaseRequest(BaseModel):
    """Body for request-release / cancel-release. Notes are appended to the audit trail."""
    notes: Optional[str] = None


class NumberRequest(BaseModel):
    product_type: str
    notes: Optional[str] = None

    @field_validator("product_type")
    @classmethod
    def validate_product_type(cls, v: str) -> str:
        allowed = ("rcf", "trunk", "api")
        if v not in allowed:
            raise ValueError(f"product_type must be one of {allowed}")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _canonical_did(did: str) -> str:
    """Canonicalize a DID path param to +E.164, or raise a clean 422.

    The DID arrives from the URL (``/{did}/assign`` etc.), so a malformed value is
    a client error — surface 422 instead of letting the ValueError become a 500.
    Uses utils.phone (shared canonical algorithm) so inventory/assignment DIDs
    match the exact form stored by rcf/api/trunk write paths and the routing view.
    """
    try:
        return phone.normalize_e164(did)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


# The inventory-item shape shared by GET /inventory rows and the PUT
# /{did}/carrier-trunk response. carrier/carrier_pop are attribution overlays:
# COALESCE(ct.carrier,'bandwidth') renders legacy rows (carrier_trunk_id NULL)
# as the implicit Bandwidth they came from; carrier_pop stays NULL for them.
_ITEM_COLS = """d.*,
               c.name AS customer_name,
               u.name AS assigned_by_name,
               COALESCE(ct.carrier, 'bandwidth') AS carrier,
               ct.pop AS carrier_pop"""
_ITEM_JOINS = """
          FROM did_inventory d
          LEFT JOIN customers c ON d.customer_id = c.id
          LEFT JOIN users u ON d.assigned_by = u.id
          LEFT JOIN carrier_trunks ct ON d.carrier_trunk_id = ct.id"""


def _compute_sync_sets(
    existing_rows: list, bw_dids: set[str]
) -> tuple[set[str], set[str], set[str]]:
    """Ownership-guarded set arithmetic for POST /sync (pure — unit-testable).

    The sync only MANAGES rows it created (source='bandwidth_sync'); manually
    intaken rows (source='manual', e.g. Sinch DIDs) are invisible to it:
      * new_dids     — in Bandwidth, not in inventory AT ALL (any source), so a
        Bandwidth TN that was manually added earlier is never re-inserted;
      * update_dids  — sync-owned rows still in Bandwidth (metadata refresh).
        A manual row whose DID appears in the Bandwidth feed is left ENTIRELY
        alone — no metadata overwrite (its attribution says another carrier
        hosts it; an admin resolves the conflict, not the sync);
      * removed_dids — sync-owned rows no longer in Bandwidth. Manual rows can
        NEVER appear here regardless of carrier_trunk_id.

    Args:
        existing_rows: mappings with 'did' and 'source' (the full inventory).
        bw_dids: E.164 DIDs currently in the Bandwidth account.

    Returns:
        (new_dids, update_dids, removed_dids)
    """
    existing_dids = {r["did"] for r in existing_rows}
    sync_owned = {r["did"] for r in existing_rows if r["source"] == "bandwidth_sync"}
    return bw_dids - existing_dids, sync_owned & bw_dids, sync_owned - bw_dids


async def _reconcile_product_tables() -> dict:
    """Reconcile did_inventory with actual product tables (rcf_numbers, api_dids, trunk_dids).

    For every DID assigned in a product table, upserts into did_inventory with
    status='assigned' and the correct customer_id/product_type/product_ref_id.

    This is idempotent and safe to run multiple times. It ensures did_inventory
    reflects the ground truth in the product tables, covering:
      - DIDs that existed before did_inventory was created
      - Ported numbers not from Bandwidth
      - Any drift between product tables and did_inventory

    Attribution safety: the ON CONFLICT upsert deliberately touches ONLY
    customer/product/status/assigned_at — never source or carrier_trunk_id, so
    a manually-intaken DID keeps its carrier attribution through reconcile.
    (The INSERT arm creates missing rows with the column defaults:
    source='bandwidth_sync', carrier_trunk_id NULL — implicit Bandwidth,
    the pre-41 behavior for ported/unknown numbers.)
    """
    pool = await db.get_pool()
    reconciled = 0
    by_product = {"rcf": 0, "api": 0, "trunk": 0}

    async with pool.acquire() as conn:
        async with conn.transaction():
            # --- RCF numbers ---
            rcf_rows = await conn.fetch(
                """
                SELECT r.id AS ref_id, r.did, r.customer_id, r.created_at
                  FROM rcf_numbers r
                  JOIN customers c ON r.customer_id = c.id
                """
            )
            for row in rcf_rows:
                await conn.execute(
                    """
                    INSERT INTO did_inventory (did, customer_id, product_type, product_ref_id,
                                               status, assigned_at, updated_at)
                    VALUES ($1, $2, 'rcf', $3, 'assigned', $4, NOW())
                    ON CONFLICT (did) DO UPDATE
                       SET customer_id = EXCLUDED.customer_id,
                           product_type = EXCLUDED.product_type,
                           product_ref_id = EXCLUDED.product_ref_id,
                           status = 'assigned',
                           assigned_at = COALESCE(did_inventory.assigned_at, EXCLUDED.assigned_at),
                           updated_at = NOW()
                    """,
                    row["did"], row["customer_id"], row["ref_id"], row["created_at"],
                )
                by_product["rcf"] += 1

            # --- API DIDs ---
            api_rows = await conn.fetch(
                """
                SELECT a.id AS ref_id, a.did, a.customer_id, a.created_at
                  FROM api_dids a
                  JOIN customers c ON a.customer_id = c.id
                """
            )
            for row in api_rows:
                await conn.execute(
                    """
                    INSERT INTO did_inventory (did, customer_id, product_type, product_ref_id,
                                               status, assigned_at, updated_at)
                    VALUES ($1, $2, 'api', $3, 'assigned', $4, NOW())
                    ON CONFLICT (did) DO UPDATE
                       SET customer_id = EXCLUDED.customer_id,
                           product_type = EXCLUDED.product_type,
                           product_ref_id = EXCLUDED.product_ref_id,
                           status = 'assigned',
                           assigned_at = COALESCE(did_inventory.assigned_at, EXCLUDED.assigned_at),
                           updated_at = NOW()
                    """,
                    row["did"], row["customer_id"], row["ref_id"], row["created_at"],
                )
                by_product["api"] += 1

            # --- Trunk DIDs (join through sip_trunks to get customer_id) ---
            trunk_rows = await conn.fetch(
                """
                SELECT td.id AS ref_id, td.did, t.customer_id, t.created_at
                  FROM trunk_dids td
                  JOIN sip_trunks t ON td.trunk_id = t.id
                  JOIN customers c ON t.customer_id = c.id
                """
            )
            for row in trunk_rows:
                await conn.execute(
                    """
                    INSERT INTO did_inventory (did, customer_id, product_type, product_ref_id,
                                               status, assigned_at, updated_at)
                    VALUES ($1, $2, 'trunk', $3, 'assigned', $4, NOW())
                    ON CONFLICT (did) DO UPDATE
                       SET customer_id = EXCLUDED.customer_id,
                           product_type = EXCLUDED.product_type,
                           product_ref_id = EXCLUDED.product_ref_id,
                           status = 'assigned',
                           assigned_at = COALESCE(did_inventory.assigned_at, EXCLUDED.assigned_at),
                           updated_at = NOW()
                    """,
                    row["did"], row["customer_id"], row["ref_id"], row["created_at"],
                )
                by_product["trunk"] += 1

    reconciled = sum(by_product.values())
    logger.info(
        "Product table reconciliation complete: %d total (rcf=%d, api=%d, trunk=%d)",
        reconciled, by_product["rcf"], by_product["api"], by_product["trunk"],
    )

    return {"reconciled": reconciled, "by_product": by_product}


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

@router.get("/inventory")
async def get_inventory(
    admin: dict = Depends(require_admin),
    status: Optional[str] = Query(None, description="Filter by status"),
    customer_id: Optional[int] = Query(None, description="Filter by customer"),
    product_type: Optional[str] = Query(None, description="Filter by product type"),
    search: Optional[str] = Query(None, description="DID substring search"),
    state: Optional[str] = Query(None, description="Filter by state"),
    carrier: Optional[str] = Query(None, description="Filter by carrier (carrier=bandwidth includes legacy unattributed rows)"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Return the full DID inventory with filters and pagination. Admin only.

    Items carry carrier attribution: carrier (COALESCEd — legacy rows without a
    carrier_trunk_id render as 'bandwidth'), carrier_pop (NULL for implicit
    Bandwidth), carrier_trunk_id, and source ('bandwidth_sync' | 'manual').
    """
    query = f"""
        SELECT {_ITEM_COLS},
               COUNT(*) OVER() AS total_count
        {_ITEM_JOINS}
         WHERE 1=1
    """
    values = []
    idx = 1

    if status is not None:
        query += f" AND d.status = ${idx}"
        values.append(status)
        idx += 1

    if customer_id is not None:
        query += f" AND d.customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if product_type is not None:
        query += f" AND d.product_type = ${idx}"
        values.append(product_type)
        idx += 1

    if search is not None:
        query += f" AND d.did LIKE ${idx}"
        values.append(f"%{search}%")
        idx += 1

    if state is not None:
        query += f" AND d.state = ${idx}"
        values.append(state)
        idx += 1

    if carrier is not None:
        # Match the COALESCEd value so carrier=bandwidth also finds legacy
        # rows with no carrier_trunk_id (implicit Bandwidth).
        query += f" AND COALESCE(ct.carrier, 'bandwidth') = ${idx}"
        values.append(carrier.strip().lower())
        idx += 1

    query += f" ORDER BY d.did LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    total = rows[0]["total_count"] if rows else 0

    items = []
    for r in rows:
        item = dict(r)
        item.pop("total_count", None)
        items.append(item)

    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/stats")
async def get_stats(admin: dict = Depends(require_admin)):
    """Summary statistics for the DID inventory. Admin only."""
    # Status breakdown
    status_rows = await db.fetch_all(
        "SELECT status, COUNT(*) AS cnt FROM did_inventory GROUP BY status"
    )
    by_status = {r["status"]: r["cnt"] for r in status_rows}

    # Product breakdown (only assigned DIDs)
    product_rows = await db.fetch_all(
        "SELECT product_type, COUNT(*) AS cnt FROM did_inventory "
        "WHERE product_type IS NOT NULL GROUP BY product_type"
    )
    by_product = {r["product_type"]: r["cnt"] for r in product_rows}

    # State breakdown (top 10)
    state_rows = await db.fetch_all(
        "SELECT state, COUNT(*) AS cnt FROM did_inventory "
        "WHERE state IS NOT NULL AND state != '' "
        "GROUP BY state ORDER BY cnt DESC LIMIT 10"
    )
    by_state = {r["state"]: r["cnt"] for r in state_rows}

    # Carrier breakdown — same COALESCE as GET /inventory: legacy rows with no
    # carrier_trunk_id count under 'bandwidth' (implicit).
    carrier_rows = await db.fetch_all(
        "SELECT COALESCE(ct.carrier, 'bandwidth') AS carrier, COUNT(*) AS cnt "
        "FROM did_inventory d "
        "LEFT JOIN carrier_trunks ct ON d.carrier_trunk_id = ct.id "
        "GROUP BY 1"
    )
    by_carrier = {r["carrier"]: r["cnt"] for r in carrier_rows}

    total = sum(by_status.values())
    available = by_status.get("available", 0)
    assigned = by_status.get("assigned", 0)
    reserved = by_status.get("reserved", 0)

    return {
        "total": total,
        "available": available,
        "assigned": assigned,
        "reserved": reserved,
        "by_status": by_status,
        "by_product": by_product,
        "by_state": by_state,
        "by_carrier": by_carrier,
    }


@router.post("/sync")
async def sync_from_bandwidth(admin: dict = Depends(require_admin)):
    """Sync the Bandwidth TN inventory into did_inventory. Admin only.

    - New TNs from Bandwidth are inserted with status='available' (and the
      column default source='bandwidth_sync')
    - Existing sync-owned TNs have their metadata (city/state/lata/rate_center)
      updated
    - Sync-owned TNs no longer in Bandwidth are flagged (returned as 'removed'
      — REPORT-ONLY: no status change, no delete; admin reviews)
    - OWNERSHIP GUARD: only rows with source='bandwidth_sync' are managed.
      Manually intaken rows (source='manual', e.g. Sinch DIDs) NEVER appear in
      'removed' and are never metadata-overwritten — even when their DID shows
      up in the Bandwidth feed (that conflict is left for an admin). See
      _compute_sync_sets.
    - Idempotent: safe to run multiple times
    """
    if not _credentials_configured():
        raise HTTPException(
            status_code=503,
            detail="Bandwidth API credentials not configured. "
                   "Set BANDWIDTH_API_CLIENT_ID and BANDWIDTH_API_CLIENT_SECRET.",
        )

    try:
        tns = await get_all_tns()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    if not tns:
        return {"synced": 0, "inserted": 0, "updated": 0, "removed": []}

    # Build a set of E.164 DIDs from Bandwidth for comparison
    bw_dids: set[str] = set()
    bw_map: dict[str, dict] = {}
    for tn in tns:
        e164 = tn.get("fullNumber", "")
        if e164:
            bw_dids.add(e164)
            bw_map[e164] = tn

    # Get all DIDs currently in our inventory (with intake source — the sync
    # ownership boundary) and partition into new/update/removed. Manual rows
    # are guarded out of update + removed by _compute_sync_sets.
    existing_rows = await db.fetch_all("SELECT did, source FROM did_inventory")
    new_dids, update_dids, removed_dids = _compute_sync_sets(existing_rows, bw_dids)

    pool = await db.get_pool()
    inserted = 0
    updated = 0

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Insert new DIDs
            if new_dids:
                insert_args = []
                for did in new_dids:
                    tn = bw_map[did]
                    insert_args.append((
                        did,
                        tn.get("city", "") or None,
                        tn.get("state", "") or None,
                        tn.get("lata", "") or None,
                        tn.get("rateCenter", "") or None,
                    ))
                await conn.executemany(
                    """
                    INSERT INTO did_inventory (did, city, state, lata, rate_center, status)
                    VALUES ($1, $2, $3, $4, $5, 'available')
                    ON CONFLICT (did) DO NOTHING
                    """,
                    insert_args,
                )
                inserted = len(new_dids)

            # Update metadata for sync-owned DIDs that are still in Bandwidth
            # (manual rows excluded — the sync never writes rows it doesn't own)
            if update_dids:
                update_args = []
                for did in update_dids:
                    tn = bw_map[did]
                    update_args.append((
                        tn.get("city", "") or None,
                        tn.get("state", "") or None,
                        tn.get("lata", "") or None,
                        tn.get("rateCenter", "") or None,
                        did,
                    ))
                await conn.executemany(
                    """
                    UPDATE did_inventory
                       SET city = $1, state = $2, lata = $3, rate_center = $4,
                           updated_at = NOW()
                     WHERE did = $5
                    """,
                    update_args,
                )
                updated = len(update_dids)

    # Return removed DIDs as a warning (don't auto-delete; admin reviews)
    removed_list = sorted(removed_dids) if removed_dids else []

    # Reconcile product tables so assigned DIDs from rcf_numbers/api_dids/trunk_dids
    # are reflected in did_inventory (covers ported numbers not from Bandwidth)
    reconcile_result = await _reconcile_product_tables()

    logger.info(
        "Bandwidth sync complete: %d total, %d inserted, %d updated, %d removed from Bandwidth, %d reconciled from product tables",
        len(bw_dids), inserted, updated, len(removed_list), reconcile_result["reconciled"],
    )

    return {
        "synced": len(bw_dids),
        "inserted": inserted,
        "updated": updated,
        "removed": removed_list,
        "reconciled": reconcile_result["reconciled"],
        "reconciled_by_product": reconcile_result["by_product"],
    }


@router.post("/reconcile")
async def reconcile_product_tables(admin: dict = Depends(require_admin)):
    """Reconcile did_inventory with product tables. Admin only.

    Scans rcf_numbers, api_dids, and trunk_dids and upserts every assigned DID
    into did_inventory. Useful for initial setup or after manual DB changes,
    without needing Bandwidth API credentials.

    Idempotent: safe to run multiple times.
    """
    result = await _reconcile_product_tables()
    return {
        "status": "ok",
        "reconciled": result["reconciled"],
        "by_product": result["by_product"],
    }


@router.post("/add")
async def add_dids(body: AddDIDsRequest, admin: dict = Depends(require_admin)):
    """Manually intake a batch of DIDs with carrier-trunk attribution. Admin only.

    The first-class intake path for non-Bandwidth numbers (e.g. Sinch DIDs):
    every DID in the batch is attributed to the given carrier_trunks row and
    lands status='available' / source='manual' in the pool — the existing
    assign->customer->product flow takes over unchanged. Intake requires an
    ENABLED trunk (404 otherwise): new numbers must map to a live carrier path.

    Entries are normalized with the shared canonical E.164 helper (bare
    10-digit NANP gets +1; '+CC' international preserved) and deduped within
    the batch (first occurrence wins). Un-normalizable entries are reported
    back verbatim in 'invalid'; DIDs already in inventory (any source) are
    left untouched and reported in 'skipped_existing'.

    Response envelope (TED UI contract — EXACT):
        {"added": [e164...], "skipped_existing": [e164...],
         "invalid": [raw_input...], "count": <len(added)>}
    """
    trunk = await db.fetch_one(
        "SELECT id, carrier, pop, enabled FROM carrier_trunks WHERE id = $1::int",
        body.carrier_trunk_id,
    )
    if not trunk:
        raise HTTPException(status_code=404, detail="Carrier trunk not found")
    if not trunk["enabled"]:
        raise HTTPException(
            status_code=404,
            detail=f"Carrier trunk {body.carrier_trunk_id} is disabled",
        )

    # Normalize with the SAME canonical helper every other DID write path uses;
    # collect un-normalizable entries (verbatim) instead of failing the batch.
    normalized: list[str] = []
    invalid: list[str] = []
    seen: set[str] = set()
    for raw in body.dids:
        try:
            e164 = phone.normalize_e164(raw)
        except ValueError:
            invalid.append(raw)
            continue
        if e164 not in seen:
            seen.add(e164)
            normalized.append(e164)

    added: list[str] = []
    if normalized:
        try:
            rows = await db.fetch_all(
                """
                INSERT INTO did_inventory (did, status, source, carrier_trunk_id, notes)
                SELECT d, 'available', 'manual', $2::int, $3::text
                  FROM unnest($1::varchar[]) AS d
                ON CONFLICT (did) DO NOTHING
                RETURNING did
                """,
                normalized, body.carrier_trunk_id, body.notes,
            )
        except asyncpg.ForeignKeyViolationError:
            # Trunk deleted between the check above and the insert.
            raise HTTPException(status_code=404, detail="Carrier trunk not found")
        added_set = {r["did"] for r in rows}
        added = [d for d in normalized if d in added_set]

    skipped_existing = [d for d in normalized if d not in set(added)]

    logger.info(
        "Manual DID intake: added=%d skipped=%d invalid=%d trunk=%s/%s (id=%d) by admin=%s",
        len(added), len(skipped_existing), len(invalid),
        trunk["carrier"], trunk["pop"], body.carrier_trunk_id, admin.get("email"),
    )

    return {
        "added": added,
        "skipped_existing": skipped_existing,
        "invalid": invalid,
        "count": len(added),
    }


@router.put("/{did}/carrier-trunk")
async def set_did_carrier_trunk(
    did: str,
    body: CarrierTrunkAssociation,
    admin: dict = Depends(require_admin),
):
    """Re-associate a DID with a carrier trunk (or clear it). Admin only.

    carrier_trunk_id=null clears the association — the DID reverts to the
    implicit-Bandwidth attribution legacy rows carry. Unlike /add (intake of
    NEW numbers, which demands an enabled trunk), re-association accepts a
    disabled trunk: attribution is metadata, and correcting it must not be
    blocked by a trunk being administratively down.

    Returns the updated inventory item (same shape as GET /inventory items).
    """
    e164 = _canonical_did(did)

    if body.carrier_trunk_id is not None:
        trunk = await db.fetch_one(
            "SELECT id FROM carrier_trunks WHERE id = $1::int",
            body.carrier_trunk_id,
        )
        if not trunk:
            raise HTTPException(status_code=404, detail="Carrier trunk not found")

    try:
        result = await db.execute(
            """
            UPDATE did_inventory
               SET carrier_trunk_id = $1::int,
                   updated_at = NOW()
             WHERE did = $2::varchar
            """,
            body.carrier_trunk_id, e164,
        )
    except asyncpg.ForeignKeyViolationError:
        # Trunk deleted between the check above and the update.
        raise HTTPException(status_code=404, detail="Carrier trunk not found")
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail=f"DID {e164} not found in inventory")

    logger.info(
        "DID carrier-trunk set: did=%s trunk_id=%s by admin=%s",
        e164, body.carrier_trunk_id, admin.get("email"),
    )

    row = await db.fetch_one(
        f"SELECT {_ITEM_COLS} {_ITEM_JOINS} WHERE d.did = $1::varchar", e164
    )
    return dict(row)


@router.post("/{did}/assign")
async def assign_did(
    did: str,
    body: AssignRequest,
    admin: dict = Depends(require_admin),
):
    """Assign a DID to a customer for a specific product. Admin only.

    For RCF: also creates the rcf_numbers record, which REQUIRES a valid
    forward_to (rcf_forward_to_e164_chk: +E.164 or a 3-6 digit local extension
    — migration 31). Validated up front so a bad destination is a 422, never a
    CheckViolationError 500. Ignored for non-rcf product types.
    Changes status from 'available' (or 'reserved') to 'assigned'.
    """
    e164 = _canonical_did(did)
    admin_user_id = int(admin["sub"])

    # RCF destination — validate BEFORE any DB work (fail fast, client error).
    rcf_forward_to: Optional[str] = None
    if body.product_type == "rcf":
        if body.forward_to is None or not body.forward_to.strip():
            raise HTTPException(
                status_code=422,
                detail="forward_to is required when assigning as RCF — the number the DID forwards to",
            )
        try:
            # Shared canonical helper (utils.phone): a bare 3-6 digit local
            # extension is kept verbatim, anything else must normalize to
            # +E.164 — exactly the two forms rcf_forward_to_e164_chk accepts.
            rcf_forward_to = phone.normalize_forward_destination(body.forward_to)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"invalid forward_to '{body.forward_to}': must be a phone number "
                    "(E.164 like +17744045256, or a bare 10-digit US number) "
                    "or a 3-6 digit local extension"
                ),
            )

    # Verify customer exists and is active
    customer = await db.fetch_one(
        "SELECT id, name, status FROM customers WHERE id = $1",
        body.customer_id,
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    if customer["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    # Verify DID exists in inventory and is assignable
    inv = await db.fetch_one(
        "SELECT id, status, customer_id FROM did_inventory WHERE did = $1",
        e164,
    )
    if not inv:
        raise HTTPException(status_code=404, detail=f"DID {e164} not found in inventory")
    if inv["status"] == "assigned":
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} is already assigned to customer_id={inv['customer_id']}",
        )
    if inv["status"] not in ("available", "reserved"):
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} has status '{inv['status']}' and cannot be assigned",
        )

    pool = await db.get_pool()
    product_ref_id = None

    async with pool.acquire() as conn:
        async with conn.transaction():
            # For RCF: create the rcf_numbers record
            if body.product_type == "rcf":
                try:
                    rcf_row = await conn.fetchrow(
                        """
                        INSERT INTO rcf_numbers (customer_id, did, name, forward_to, pass_caller_id, enabled, ring_timeout)
                        VALUES ($1, $2, $3, $4, true, true, 30)
                        RETURNING id
                        """,
                        body.customer_id, e164, f"DID {e164}", rcf_forward_to,
                    )
                    product_ref_id = rcf_row["id"]
                except asyncpg.CheckViolationError as e:
                    # Defense-in-depth: a value the app-level validation missed
                    # (or a future constraint) is still a client error, not a 500.
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"DID {e164} was rejected by rcf_numbers constraint "
                            f"'{e.constraint_name}' — forward_to must be +E.164 "
                            "or a 3-6 digit local extension"
                        ),
                    )
                except Exception as e:
                    if "unique" in str(e).lower():
                        raise HTTPException(
                            status_code=409,
                            detail=f"DID {e164} already exists in rcf_numbers",
                        )
                    raise

            # Update did_inventory
            await conn.execute(
                """
                UPDATE did_inventory
                   SET customer_id = $1,
                       product_type = $2,
                       product_ref_id = $3,
                       status = 'assigned',
                       assigned_at = $4,
                       assigned_by = $5,
                       notes = $6,
                       updated_at = $4
                 WHERE did = $7
                """,
                body.customer_id,
                body.product_type,
                product_ref_id,
                datetime.now(timezone.utc),
                admin_user_id,
                body.notes,
                e164,
            )

    # Invalidate relevant caches
    await cache.cache_delete("bandwidth:tns")

    logger.info(
        "DID assigned: did=%s, customer=%s (%d), product=%s, by_user=%d",
        e164, customer["name"], body.customer_id, body.product_type, admin_user_id,
    )

    return {
        "status": "assigned",
        "did": e164,
        "customer_id": body.customer_id,
        "customer_name": customer["name"],
        "product_type": body.product_type,
        "product_ref_id": product_ref_id,
    }


@router.post("/{did}/unassign")
async def unassign_did(
    did: str,
    body: UnassignRequest = UnassignRequest(),
    admin: dict = Depends(require_admin),
):
    """Unassign a DID from a customer. Admin only.

    Removes the product record (rcf_numbers, etc.) and sets status back to 'available'.
    Accepts 'assigned', 'reserved', and 'release_requested' — the latter makes this
    endpoint the admin APPROVAL of a customer release request (see /request-release).
    """
    e164 = _canonical_did(did)
    admin_user_id = int(admin["sub"])

    # Verify DID is currently assigned (or pending release approval)
    inv = await db.fetch_one(
        "SELECT id, status, customer_id, product_type, product_ref_id FROM did_inventory WHERE did = $1",
        e164,
    )
    if not inv:
        raise HTTPException(status_code=404, detail=f"DID {e164} not found in inventory")
    if inv["status"] not in ("assigned", "reserved", "release_requested"):
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} has status '{inv['status']}' and is not currently assigned",
        )

    pool = await db.get_pool()

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Remove the product record based on product_type
            product_type = inv["product_type"]
            if product_type == "rcf":
                await conn.execute("DELETE FROM rcf_numbers WHERE did = $1", e164)
            elif product_type == "api":
                await conn.execute("DELETE FROM api_dids WHERE did = $1", e164)
            elif product_type == "trunk":
                await conn.execute("DELETE FROM trunk_dids WHERE did = $1", e164)

            # Reset did_inventory
            now = datetime.now(timezone.utc)
            await conn.execute(
                """
                UPDATE did_inventory
                   SET customer_id = NULL,
                       product_type = NULL,
                       product_ref_id = NULL,
                       status = 'available',
                       assigned_at = NULL,
                       assigned_by = NULL,
                       notes = $1,
                       updated_at = $2
                 WHERE did = $3
                """,
                body.notes,
                now,
                e164,
            )

    # Invalidate caches
    if inv["product_type"] == "rcf":
        await cache.invalidate_rcf_cache(e164)
    await cache.cache_delete("bandwidth:tns")

    logger.info(
        "DID unassigned: did=%s, was_customer=%s, was_product=%s, by_user=%d",
        e164, inv["customer_id"], inv["product_type"], admin_user_id,
    )

    return {
        "status": "unassigned",
        "did": e164,
        "previous_customer_id": inv["customer_id"],
        "previous_product_type": inv["product_type"],
    }


# ---------------------------------------------------------------------------
# Customer-facing endpoints
# ---------------------------------------------------------------------------

@router.get("/available")
async def get_available(
    user: dict = Depends(get_current_user),
    state: Optional[str] = Query(None, description="Filter by state"),
    city: Optional[str] = Query(None, description="Filter by city"),
    area_code: Optional[str] = Query(None, description="Filter by area code (3 digits)"),
    search: Optional[str] = Query(None, description="DID substring search"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Browse available DIDs. Accessible by any authenticated user."""
    query = """
        SELECT did, city, state, rate_center,
               COUNT(*) OVER() AS total_count
          FROM did_inventory
         WHERE status = 'available'
    """
    values = []
    idx = 1

    if state is not None:
        query += f" AND state = ${idx}"
        values.append(state)
        idx += 1

    if city is not None:
        query += f" AND city ILIKE ${idx}"
        values.append(f"%{city}%")
        idx += 1

    if area_code is not None:
        # Area code is the 3 digits after +1 in E.164
        query += f" AND did LIKE ${idx}"
        values.append(f"+1{area_code}%")
        idx += 1

    if search is not None:
        query += f" AND did LIKE ${idx}"
        values.append(f"%{search}%")
        idx += 1

    query += f" ORDER BY did LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    total = rows[0]["total_count"] if rows else 0

    items = []
    for r in rows:
        items.append({
            "did": r["did"],
            "city": r["city"],
            "state": r["state"],
            "rate_center": r["rate_center"],
        })

    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/my")
async def get_my_numbers(
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get all DIDs assigned to the current user's customer. Any authenticated user.

    Uses a UNION query so that even if did_inventory hasn't been synced/reconciled
    yet, customers still see their real numbers from the product tables
    (rcf_numbers, api_dids, trunk_dids).
    """
    customer_id = customer_filter
    if customer_id is None:
        # Admin: show all assigned DIDs from did_inventory + product tables
        rows = await db.fetch_all(
            """
            SELECT did, product_type, status, city, state,
                   assigned_at, notes, customer_id, customer_name
              FROM (
                SELECT d.did, d.product_type, d.status, d.city, d.state,
                       d.assigned_at, d.notes, d.customer_id,
                       c.name AS customer_name
                  FROM did_inventory d
                  LEFT JOIN customers c ON d.customer_id = c.id
                 WHERE d.status IN ('assigned', 'reserved', 'release_requested')
                UNION
                SELECT r.did, 'rcf' AS product_type, 'assigned' AS status,
                       NULL AS city, NULL AS state,
                       r.created_at AS assigned_at, NULL AS notes,
                       r.customer_id,
                       c.name AS customer_name
                  FROM rcf_numbers r
                  JOIN customers c ON r.customer_id = c.id
                 WHERE r.did NOT IN (
                       SELECT di.did FROM did_inventory di
                        WHERE di.status IN ('assigned', 'reserved', 'release_requested'))
                UNION
                SELECT a.did, 'api' AS product_type, 'assigned' AS status,
                       NULL AS city, NULL AS state,
                       a.created_at AS assigned_at, NULL AS notes,
                       a.customer_id,
                       c.name AS customer_name
                  FROM api_dids a
                  JOIN customers c ON a.customer_id = c.id
                 WHERE a.did NOT IN (
                       SELECT di.did FROM did_inventory di
                        WHERE di.status IN ('assigned', 'reserved', 'release_requested'))
                UNION
                SELECT td.did, 'trunk' AS product_type, 'assigned' AS status,
                       NULL AS city, NULL AS state,
                       t.created_at AS assigned_at, NULL AS notes,
                       t.customer_id,
                       c.name AS customer_name
                  FROM trunk_dids td
                  JOIN sip_trunks t ON td.trunk_id = t.id
                  JOIN customers c ON t.customer_id = c.id
                 WHERE td.did NOT IN (
                       SELECT di.did FROM did_inventory di
                        WHERE di.status IN ('assigned', 'reserved', 'release_requested'))
              ) combined
             ORDER BY did
             LIMIT 500
            """
        )
    else:
        rows = await db.fetch_all(
            """
            SELECT did, product_type, status, city, state,
                   assigned_at, notes, customer_id, customer_name
              FROM (
                SELECT d.did, d.product_type, d.status, d.city, d.state,
                       d.assigned_at, d.notes, d.customer_id,
                       c.name AS customer_name
                  FROM did_inventory d
                  LEFT JOIN customers c ON d.customer_id = c.id
                 WHERE d.customer_id = $1
                   AND d.status IN ('assigned', 'reserved', 'release_requested')
                UNION
                SELECT r.did, 'rcf' AS product_type, 'assigned' AS status,
                       NULL AS city, NULL AS state,
                       r.created_at AS assigned_at, NULL AS notes,
                       r.customer_id,
                       c.name AS customer_name
                  FROM rcf_numbers r
                  JOIN customers c ON r.customer_id = c.id
                 WHERE r.customer_id = $1
                   AND r.did NOT IN (
                       SELECT di.did FROM did_inventory di
                        WHERE di.customer_id = $1)
                UNION
                SELECT a.did, 'api' AS product_type, 'assigned' AS status,
                       NULL AS city, NULL AS state,
                       a.created_at AS assigned_at, NULL AS notes,
                       a.customer_id,
                       c.name AS customer_name
                  FROM api_dids a
                  JOIN customers c ON a.customer_id = c.id
                 WHERE a.customer_id = $1
                   AND a.did NOT IN (
                       SELECT di.did FROM did_inventory di
                        WHERE di.customer_id = $1)
                UNION
                SELECT td.did, 'trunk' AS product_type, 'assigned' AS status,
                       NULL AS city, NULL AS state,
                       t.created_at AS assigned_at, NULL AS notes,
                       t.customer_id,
                       c.name AS customer_name
                  FROM trunk_dids td
                  JOIN sip_trunks t ON td.trunk_id = t.id
                  JOIN customers c ON t.customer_id = c.id
                 WHERE t.customer_id = $1
                   AND td.did NOT IN (
                       SELECT di.did FROM did_inventory di
                        WHERE di.customer_id = $1)
              ) combined
             ORDER BY did
            """,
            customer_id,
        )

    return [dict(r) for r in rows]


@router.post("/{did}/request")
async def request_number(
    did: str,
    body: NumberRequest,
    user: dict = Depends(get_current_user),
):
    """Customer requests a number. Changes status to 'reserved'.

    Admin reviews and approves (via /assign) or the system auto-approves.
    """
    e164 = _canonical_did(did)
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    if customer_id is None and user.get("role") != "admin":
        raise HTTPException(
            status_code=400,
            detail="User is not associated with a customer account",
        )

    # Verify the DID is available
    inv = await db.fetch_one(
        "SELECT id, status FROM did_inventory WHERE did = $1",
        e164,
    )
    if not inv:
        raise HTTPException(status_code=404, detail=f"DID {e164} not found in inventory")
    if inv["status"] != "available":
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} is not available (current status: {inv['status']})",
        )

    # Reserve the DID for this customer
    now = datetime.now(timezone.utc)
    await db.execute(
        """
        UPDATE did_inventory
           SET customer_id = $1,
               product_type = $2,
               status = 'reserved',
               assigned_at = $3,
               assigned_by = $4,
               notes = $5,
               updated_at = $3
         WHERE did = $6 AND status = 'available'
        """,
        customer_id,
        body.product_type,
        now,
        user_id,
        body.notes or f"Requested by user {user.get('email', user_id)}",
        e164,
    )

    logger.info(
        "DID requested: did=%s, customer_id=%s, product=%s, user=%d",
        e164, customer_id, body.product_type, user_id,
    )

    return {
        "status": "reserved",
        "did": e164,
        "customer_id": customer_id,
        "product_type": body.product_type,
        "message": "Number reserved. An administrator will review and complete the assignment.",
    }


@router.post("/{did}/request-release")
async def request_release(
    did: str,
    body: ReleaseRequest = ReleaseRequest(),
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Request release of an assigned DID. Customer self-service (admin also allowed).

    Sets status 'assigned' -> 'release_requested'. An admin then APPROVES via
    POST /{did}/unassign (which accepts 'release_requested') or DENIES via
    POST /{did}/cancel-release. Non-admins may only act on their own customer's
    DIDs — cross-tenant / unknown DIDs return 404 (no existence leak, house
    authz style per routers/rcf.py).
    """
    e164 = _canonical_did(did)
    user_id = int(user["sub"])

    inv = await db.fetch_one(
        "SELECT id, status, customer_id, product_type FROM did_inventory WHERE did = $1",
        e164,
    )
    # 404-no-leak: to a non-admin, a DID owned by another tenant is
    # indistinguishable from a DID that does not exist (checked BEFORE the
    # status guard so 409s can't leak cross-tenant state either).
    if not inv or (customer_filter is not None and inv["customer_id"] != customer_filter):
        raise HTTPException(status_code=404, detail=f"DID {e164} not found in inventory")
    if inv["status"] == "release_requested":
        raise HTTPException(
            status_code=409,
            detail=f"Release already requested for DID {e164} — awaiting admin review",
        )
    if inv["status"] != "assigned":
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} has status '{inv['status']}' and cannot be released",
        )

    now = datetime.now(timezone.utc)
    audit = f"[{now.isoformat()}] Release requested by {user.get('email', user_id)} (user {user_id})"
    if body.notes:
        audit += f": {body.notes}"

    result = await db.execute(
        """
        UPDATE did_inventory
           SET status = 'release_requested',
               notes = COALESCE(notes || E'\\n', '') || $1,
               updated_at = $2
         WHERE did = $3 AND status = 'assigned'
        """,
        audit, now, e164,
    )
    if result == "UPDATE 0":
        # Lost a race: status changed between the guard and the update.
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} is no longer in 'assigned' status",
        )

    logger.info(
        "DID release requested: did=%s, customer_id=%s, product=%s, by_user=%d",
        e164, inv["customer_id"], inv["product_type"], user_id,
    )

    return {
        "status": "release_requested",
        "did": e164,
        "customer_id": inv["customer_id"],
        "product_type": inv["product_type"],
        "message": "Release requested. An administrator will review and complete the release.",
    }


@router.post("/{did}/cancel-release")
async def cancel_release(
    did: str,
    body: ReleaseRequest = ReleaseRequest(),
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Cancel a pending release request. Customer self-service (admin also allowed).

    Sets status 'release_requested' -> 'assigned'. This is also the admin DENY
    action for a customer release request. Same 404-no-leak tenant guard as
    request-release.
    """
    e164 = _canonical_did(did)
    user_id = int(user["sub"])

    inv = await db.fetch_one(
        "SELECT id, status, customer_id, product_type FROM did_inventory WHERE did = $1",
        e164,
    )
    if not inv or (customer_filter is not None and inv["customer_id"] != customer_filter):
        raise HTTPException(status_code=404, detail=f"DID {e164} not found in inventory")
    if inv["status"] != "release_requested":
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} has status '{inv['status']}' — no pending release request to cancel",
        )

    now = datetime.now(timezone.utc)
    audit = f"[{now.isoformat()}] Release request cancelled by {user.get('email', user_id)} (user {user_id})"
    if body.notes:
        audit += f": {body.notes}"

    result = await db.execute(
        """
        UPDATE did_inventory
           SET status = 'assigned',
               notes = COALESCE(notes || E'\\n', '') || $1,
               updated_at = $2
         WHERE did = $3 AND status = 'release_requested'
        """,
        audit, now, e164,
    )
    if result == "UPDATE 0":
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} is no longer in 'release_requested' status",
        )

    logger.info(
        "DID release request cancelled: did=%s, customer_id=%s, product=%s, by_user=%d",
        e164, inv["customer_id"], inv["product_type"], user_id,
    )

    return {
        "status": "assigned",
        "did": e164,
        "customer_id": inv["customer_id"],
        "product_type": inv["product_type"],
        "message": "Release request cancelled. The number remains assigned.",
    }
