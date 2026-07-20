"""Toll-free / RespOrg management endpoints.

An API-first toll-free RespOrg surface backed by `toll_free_numbers` +
`tfn_import_batches` (migration 2026-07-01_tollfree_resporg.sql):

  * list/search TFNs, get one, CR-status           — tenant-scoped (own TFNs)
  * bulk import (idempotent, batched, 100K-scale)   — admin only
  * bulk per-TFN carrier steering (reassignment)    — admin only
  * per-TFN update + CR submit (default-off Somos)  — admin only

Tenant model (see reference_multitenant_authz):
  - Non-admins are forced to their own customer_id and can only READ their TFNs.
  - Ownership lookups raise 404 (never 403) on missing OR cross-tenant, so
    existence is not leaked.
  - Provisioning (import / reassign / update / CR submit) is admin-only.

Live Somos/800 CR submission is a DOCUMENTED, DEFAULT-OFF adapter
(`SOMOS_CR_ENABLED`, default false): with it off, a CR submit records local
workflow intent ('pending') without any external call. Wiring the real RespOrg
transaction is a follow-up (see `_submit_cr_adapter`).
"""
import os
import re
import json
import uuid
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator

from db import database as db
from auth.dependencies import require_admin, get_current_user, get_customer_filter

logger = logging.getLogger(__name__)

router = APIRouter()

# Toll-free Service Access Codes (NANP): assigned + reserved-for-future NPAs.
TOLLFREE_SACS = {
    "800", "833", "844", "855", "866", "877", "888",   # assigned
    "822", "880", "881", "882", "883", "884", "885", "886", "887", "889",  # reserved
}

# Live RespOrg (Somos/800) CR submission adapter — OFF by default. When false,
# CR submit only records local workflow state (no external call).
SOMOS_CR_ENABLED = os.getenv("SOMOS_CR_ENABLED", "false").lower() == "true"

# Bound the per-COPY chunk so a 100K-row import streams into the DB in slices
# rather than materializing one giant statement (memory-bounded).
_COPY_CHUNK = 10_000

_ALLOWED_STATUS = {
    "spare", "reserved", "assigned", "active", "suspend",
    "disconnect", "transitional", "unavailable", "aging",
}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class TfnImportRequest(BaseModel):
    """Bulk import. `numbers` is a plain list of TFN strings (fast + light for
    tens of thousands per request); shared attributes below apply to all NEW
    rows. Re-import is non-destructive (owner/carrier only filled when unset)."""
    numbers: list[str]
    batch_key: Optional[str] = None           # idempotency key; auto-generated if omitted
    customer_id: Optional[int] = None         # default owner for new rows
    carrier_id: Optional[int] = None          # default inbound carrier steering
    resp_org_id: Optional[str] = None
    status: Optional[str] = None              # default 'spare'

    @field_validator("status")
    @classmethod
    def _validate_status(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in _ALLOWED_STATUS:
            raise ValueError(f"status must be one of {sorted(_ALLOWED_STATUS)}")
        return v


class ReassignCarrierRequest(BaseModel):
    tfns: list[str]
    carrier_id: int


class TfnUpdate(BaseModel):
    customer_id: Optional[int] = None
    carrier_id: Optional[int] = None
    status: Optional[str] = None
    resp_org_id: Optional[str] = None
    template_name: Optional[str] = None
    label: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("status")
    @classmethod
    def _validate_status(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in _ALLOWED_STATUS:
            raise ValueError(f"status must be one of {sorted(_ALLOWED_STATUS)}")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_tfn(raw: str) -> str:
    """Normalize + validate a toll-free number to E.164 (+18XXNXXXXXX).

    Raises ValueError for non-NANP or non-toll-free numbers so bulk import can
    skip + record the row instead of failing the whole batch.
    """
    digits = re.sub(r"\D", "", str(raw or "").strip())
    if len(digits) == 10:
        e164 = "+1" + digits
    elif len(digits) == 11 and digits.startswith("1"):
        e164 = "+" + digits
    else:
        raise ValueError(f"not a NANP number: {str(raw)[:20]!r}")

    npa = e164[2:5]
    if npa not in TOLLFREE_SACS:
        raise ValueError(f"NPA {npa} is not a toll-free SAC")
    if e164[5] in "01":   # NXX first digit must be 2-9
        raise ValueError("invalid NXX (4th digit must be 2-9)")
    return e164


def _tfn_out(row) -> dict:
    """Serialize a toll_free_numbers row (parse cr_data JSONB → dict)."""
    d = dict(row)
    cr = d.get("cr_data")
    if isinstance(cr, str):
        try:
            d["cr_data"] = json.loads(cr)
        except (ValueError, TypeError):
            d["cr_data"] = {}
    return d


async def _get_owned_tfn(tfn: str, customer_filter: Optional[int]):
    """Fetch a TFN scoped to the caller. 404 (never 403) on missing OR
    cross-tenant, so existence is not leaked. Admin (customer_filter=None) sees
    all. Returns the asyncpg row."""
    e164 = _normalize_tfn(tfn)
    row = await db.fetch_one(
        """
        SELECT t.*, c.name AS customer_name, g.gateway_name AS carrier_name
          FROM toll_free_numbers t
          LEFT JOIN customers c ON t.customer_id = c.id
          LEFT JOIN carrier_gateways g ON t.carrier_id = g.id
         WHERE t.tfn = $1 AND ($2::int IS NULL OR t.customer_id = $2)
        """,
        e164, customer_filter,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Toll-free number not found")
    return row


def _dedup_tfns(numbers: list[str]) -> tuple[list[str], list[dict]]:
    """Normalize + validate + de-duplicate an input list in a single pass.

    Returns (unique_valid_tfns, errors_sample). Idempotency-critical: the same
    input always yields the same set, and duplicates collapse (dict keyed by the
    normalized E.164), so re-importing the same list stages the same rows. Pure
    (no DB) — unit-tested directly.
    """
    normalized: dict[str, None] = {}
    errors: list[dict] = []
    for raw in numbers:
        try:
            normalized[_normalize_tfn(raw)] = None
        except ValueError as exc:
            if len(errors) < 50:
                errors.append({"value": str(raw)[:20], "error": str(exc)})
    return list(normalized.keys()), errors


def _batch_out(row, idempotent_replay: bool = False) -> dict:
    d = dict(row)
    errs = d.get("errors")
    if isinstance(errs, str):
        try:
            d["errors"] = json.loads(errs)
        except (ValueError, TypeError):
            d["errors"] = []
    d["idempotent_replay"] = idempotent_replay
    return d


# ---------------------------------------------------------------------------
# Read endpoints (tenant-scoped)
# ---------------------------------------------------------------------------

@router.get("")
async def list_tfns(
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
    status: Optional[str] = Query(None),
    cr_status: Optional[str] = Query(None),
    resp_org_id: Optional[str] = Query(None),
    carrier_id: Optional[int] = Query(None),
    customer_id: Optional[int] = Query(None, description="Admin-only cross-tenant filter"),
    search: Optional[str] = Query(None, description="TFN substring match"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """List/search toll-free numbers. Non-admins see only their own."""
    query = """
        SELECT t.id, t.tfn, t.customer_id, t.status, t.resp_org_id, t.template_name,
               t.effective_date, t.cr_status, t.cr_reference, t.carrier_id,
               t.label, t.notes, t.created_at, t.updated_at,
               c.name AS customer_name, g.gateway_name AS carrier_name,
               COUNT(*) OVER() AS total_count
          FROM toll_free_numbers t
          LEFT JOIN customers c ON t.customer_id = c.id
          LEFT JOIN carrier_gateways g ON t.carrier_id = g.id
         WHERE 1=1
    """
    values: list = []
    idx = 1

    # Tenant scope: non-admins forced to own customer_id; admins may filter.
    if customer_filter is not None:
        query += f" AND t.customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1
    elif customer_id is not None:
        query += f" AND t.customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if status is not None:
        query += f" AND t.status = ${idx}"; values.append(status); idx += 1
    if cr_status is not None:
        query += f" AND t.cr_status = ${idx}"; values.append(cr_status); idx += 1
    if resp_org_id is not None:
        query += f" AND t.resp_org_id = ${idx}"; values.append(resp_org_id); idx += 1
    if carrier_id is not None:
        query += f" AND t.carrier_id = ${idx}"; values.append(carrier_id); idx += 1
    if search is not None:
        query += f" AND t.tfn LIKE ${idx}"; values.append(f"%{re.sub(r'[^0-9+]', '', search)}%"); idx += 1

    query += f" ORDER BY t.tfn LIMIT ${idx} OFFSET ${idx + 1}"
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
async def tfn_stats(
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
    customer_id: Optional[int] = Query(None, description="Admin-only cross-tenant filter"),
):
    """Summary counts for the caller's toll-free inventory."""
    scope = customer_filter if customer_filter is not None else customer_id
    where = ""
    args: list = []
    if scope is not None:
        where = " WHERE customer_id = $1"
        args.append(scope)

    status_rows = await db.fetch_all(
        f"SELECT status, COUNT(*) AS cnt FROM toll_free_numbers{where} GROUP BY status", *args
    )
    cr_rows = await db.fetch_all(
        f"SELECT cr_status, COUNT(*) AS cnt FROM toll_free_numbers{where} GROUP BY cr_status", *args
    )
    by_status = {r["status"]: r["cnt"] for r in status_rows}
    by_cr_status = {r["cr_status"]: r["cnt"] for r in cr_rows}
    return {
        "total": sum(by_status.values()),
        "by_status": by_status,
        "by_cr_status": by_cr_status,
    }


@router.get("/import/{batch_key}")
async def get_import_batch(batch_key: str, admin: dict = Depends(require_admin)):
    """Bulk-import batch status/progress by idempotency key. Admin only."""
    row = await db.fetch_one("SELECT * FROM tfn_import_batches WHERE batch_key = $1", batch_key)
    if not row:
        raise HTTPException(status_code=404, detail="Import batch not found")
    return _batch_out(row)


# ---------------------------------------------------------------------------
# Provisioning endpoints (admin only)
# ---------------------------------------------------------------------------

@router.post("/import")
async def import_tfns(body: TfnImportRequest, admin: dict = Depends(require_admin)):
    """Bulk-import toll-free numbers. Admin only.

    Idempotent + memory-bounded + tenant-safe:
      * `batch_key` is the idempotency handle — re-submitting a COMPLETED key
        returns the prior batch without reprocessing.
      * rows never duplicate (UNIQUE(tfn) + ON CONFLICT); re-import is
        non-destructive (owner/carrier filled only when currently unset).
      * scales to ~100K/request: input is de-duped in one pass, streamed into a
        TEMP staging table via COPY in chunks, then merged with ONE upsert.
    """
    admin_id = int(admin["sub"])
    batch_key = body.batch_key or f"auto-{uuid.uuid4().hex}"

    # Idempotency short-circuit.
    existing = await db.fetch_one(
        "SELECT * FROM tfn_import_batches WHERE batch_key = $1", batch_key
    )
    if existing and existing["status"] == "completed":
        return _batch_out(existing, idempotent_replay=True)

    # Validate referenced FKs up front so we don't fail mid-batch.
    if body.customer_id is not None:
        if not await db.fetch_one("SELECT 1 FROM customers WHERE id = $1", body.customer_id):
            raise HTTPException(status_code=404, detail=f"customer_id {body.customer_id} not found")
    if body.carrier_id is not None:
        if not await db.fetch_one("SELECT 1 FROM carrier_gateways WHERE id = $1", body.carrier_id):
            raise HTTPException(status_code=404, detail=f"carrier_id {body.carrier_id} not found")

    # Normalize + validate + de-dup in a single pass (memory-bounded, idempotent).
    tfns, errors = _dedup_tfns(body.numbers)
    total_input = len(body.numbers)
    valid = len(tfns)
    skipped = total_input - valid
    status_new = body.status or "spare"

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            batch = await conn.fetchrow(
                """
                INSERT INTO tfn_import_batches
                    (batch_key, customer_id, status, total, created_by, errors)
                VALUES ($1::varchar, $2::int, 'running', $3::int, $4::int, $5::jsonb)
                ON CONFLICT (batch_key) DO UPDATE
                   SET status = 'running', total = EXCLUDED.total,
                       customer_id = EXCLUDED.customer_id,
                       errors = EXCLUDED.errors, updated_at = NOW()
                RETURNING id
                """,
                batch_key, body.customer_id, total_input, admin_id, json.dumps(errors),
            )
            batch_id = batch["id"]

            inserted = 0
            updated = 0
            if tfns:
                # Stage into a session-local temp table, COPY in bounded chunks.
                await conn.execute(
                    "CREATE TEMP TABLE _tfn_stage (tfn VARCHAR(20)) ON COMMIT DROP"
                )
                for i in range(0, len(tfns), _COPY_CHUNK):
                    chunk = tfns[i:i + _COPY_CHUNK]
                    await conn.copy_records_to_table(
                        "_tfn_stage", records=((t,) for t in chunk), columns=["tfn"]
                    )

                # Pre-merge: how many staged TFNs already exist (the "updated" set).
                updated = await conn.fetchval(
                    "SELECT COUNT(*) FROM _tfn_stage s "
                    "JOIN toll_free_numbers n ON n.tfn = s.tfn"
                )

                # One merge. Non-destructive on conflict (fill unset owner/carrier;
                # never clobber status). New rows get the shared attributes.
                await conn.execute(
                    """
                    INSERT INTO toll_free_numbers
                        (tfn, customer_id, status, resp_org_id, carrier_id, import_batch_id)
                    SELECT DISTINCT s.tfn, $1::int, $2::varchar, $3::varchar, $4::int, $5::bigint
                      FROM _tfn_stage s
                    ON CONFLICT (tfn) DO UPDATE SET
                        customer_id     = COALESCE(toll_free_numbers.customer_id, EXCLUDED.customer_id),
                        resp_org_id     = COALESCE(toll_free_numbers.resp_org_id, EXCLUDED.resp_org_id),
                        carrier_id      = COALESCE(toll_free_numbers.carrier_id, EXCLUDED.carrier_id),
                        import_batch_id = EXCLUDED.import_batch_id,
                        updated_at      = NOW()
                    """,
                    body.customer_id, status_new, body.resp_org_id, body.carrier_id, batch_id,
                )
                inserted = len(tfns) - updated

            await conn.execute(
                """
                UPDATE tfn_import_batches
                   SET status = 'completed', processed = $1::int, inserted = $2::int,
                       updated = $3::int, skipped = $4::int, failed = 0,
                       completed_at = NOW(), updated_at = NOW()
                 WHERE id = $5::bigint
                """,
                valid, inserted, updated, skipped, batch_id,
            )

    out = await db.fetch_one("SELECT * FROM tfn_import_batches WHERE id = $1", batch_id)
    logger.info(
        "TFN import batch=%s total=%d valid=%d inserted=%d updated=%d skipped=%d by_user=%d",
        batch_key, total_input, valid, inserted, updated, skipped, admin_id,
    )
    return _batch_out(out)


@router.post("/reassign-carrier")
async def reassign_carrier(body: ReassignCarrierRequest, admin: dict = Depends(require_admin)):
    """Bulk per-TFN inbound carrier steering. Admin only. Idempotent (setting the
    same carrier is a no-op) and batched via `tfn = ANY(...)`."""
    carrier = await db.fetch_one(
        "SELECT id, gateway_name FROM carrier_gateways WHERE id = $1", body.carrier_id
    )
    if not carrier:
        raise HTTPException(status_code=404, detail=f"carrier_id {body.carrier_id} not found")

    normalized: list[str] = []
    invalid = 0
    seen: set[str] = set()
    for raw in body.tfns:
        try:
            e164 = _normalize_tfn(raw)
        except ValueError:
            invalid += 1
            continue
        if e164 not in seen:
            seen.add(e164)
            normalized.append(e164)

    updated = 0
    if normalized:
        result = await db.execute(
            "UPDATE toll_free_numbers SET carrier_id = $1, updated_at = NOW() "
            "WHERE tfn = ANY($2::text[])",
            body.carrier_id, normalized,
        )
        # asyncpg status: "UPDATE <n>"
        try:
            updated = int(result.split()[-1])
        except (ValueError, IndexError, AttributeError):
            updated = 0

    logger.info(
        "TFN carrier reassign carrier=%s requested=%d matched=%d invalid=%d by_user=%s",
        body.carrier_id, len(body.tfns), updated, invalid, admin.get("sub"),
    )
    return {
        "carrier_id": body.carrier_id,
        "gateway_name": carrier["gateway_name"],
        "requested": len(body.tfns),
        "updated": updated,
        "not_found": len(normalized) - updated,
        "invalid": invalid,
    }


@router.get("/{tfn}")
async def get_tfn(
    tfn: str,
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Get a single toll-free number (ownership-gated; 404-no-leak)."""
    row = await _get_owned_tfn(tfn, customer_filter)
    return _tfn_out(row)


@router.get("/{tfn}/cr-status")
async def get_cr_status(
    tfn: str,
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """CR (Customer Record) workflow status for a TFN (ownership-gated)."""
    row = await _get_owned_tfn(tfn, customer_filter)
    return {
        "tfn": row["tfn"],
        "cr_status": row["cr_status"],
        "cr_reference": row["cr_reference"],
        "cr_last_submitted_at": row["cr_last_submitted_at"],
        "cr_error": row["cr_error"],
        "resp_org_id": row["resp_org_id"],
        "template_name": row["template_name"],
        "effective_date": row["effective_date"],
        "somos_adapter_enabled": SOMOS_CR_ENABLED,
    }


@router.patch("/{tfn}")
async def update_tfn(tfn: str, body: TfnUpdate, admin: dict = Depends(require_admin)):
    """Update a single TFN's fields (provisioning). Admin only."""
    e164 = _normalize_tfn(tfn)
    update_data = body.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Validate referenced FKs.
    if "customer_id" in update_data and not await db.fetch_one(
        "SELECT 1 FROM customers WHERE id = $1", update_data["customer_id"]
    ):
        raise HTTPException(status_code=404, detail="customer_id not found")
    if "carrier_id" in update_data and not await db.fetch_one(
        "SELECT 1 FROM carrier_gateways WHERE id = $1", update_data["carrier_id"]
    ):
        raise HTTPException(status_code=404, detail="carrier_id not found")

    sets: list[str] = []
    values: list = []
    idx = 1
    for field, value in update_data.items():
        sets.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1
    values.append(e164)

    row = await db.fetch_one(
        f"UPDATE toll_free_numbers SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE tfn = ${idx} RETURNING *",
        *values,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Toll-free number not found")
    return _tfn_out(row)


# ---------------------------------------------------------------------------
# RespOrg CR submission — documented, DEFAULT-OFF adapter
# ---------------------------------------------------------------------------

async def _submit_cr_adapter(tfn: str, cr_data, resp_org_id: Optional[str]) -> dict:
    """External Somos/800 SMS-database CR submission adapter.

    DEFAULT-OFF: unless SOMOS_CR_ENABLED=true, this performs NO external call and
    reports the CR as recorded-but-not-submitted. When enabled, a real RespOrg
    transaction (Somos TFNRegistry / SMS-800 mechanized interface) would go here;
    it is intentionally left unimplemented so nothing can accidentally mutate the
    live 800 database from this build.
    """
    if not SOMOS_CR_ENABLED:
        return {"submitted": False, "reason": "SOMOS_CR_ENABLED is false (adapter disabled)"}
    raise HTTPException(
        status_code=501,
        detail="Live Somos/800 CR submission adapter is enabled but not implemented "
               "in this build. Wire the RespOrg transaction in _submit_cr_adapter.",
    )


@router.post("/{tfn}/cr-submit")
async def submit_cr(tfn: str, admin: dict = Depends(require_admin)):
    """Submit the TFN's Customer Record to the controlling RespOrg. Admin only.

    With the adapter off (default) this records local workflow intent
    ('pending') and returns without any external call.
    """
    row = await _get_owned_tfn(tfn, None)   # admin scope

    adapter = await _submit_cr_adapter(row["tfn"], row["cr_data"], row["resp_org_id"])
    new_status = "submitted" if adapter.get("submitted") else "pending"

    updated = await db.fetch_one(
        """
        UPDATE toll_free_numbers
           SET cr_status = $1, cr_last_submitted_at = NOW(),
               cr_error = NULL, updated_at = NOW()
         WHERE tfn = $2
        RETURNING tfn, cr_status, cr_last_submitted_at, resp_org_id
        """,
        new_status, row["tfn"],
    )
    return {
        "tfn": updated["tfn"],
        "cr_status": updated["cr_status"],
        "cr_last_submitted_at": updated["cr_last_submitted_at"],
        "resp_org_id": updated["resp_org_id"],
        "adapter": adapter,
    }
