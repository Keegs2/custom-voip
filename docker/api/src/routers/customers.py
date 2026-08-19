"""Customer management endpoints."""
from decimal import Decimal
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from db import database as db
from auth.dependencies import get_current_user, get_support_read_filter, require_admin

router = APIRouter()


# ---------------------------------------------------------------------------
# Billing estimate config
# ---------------------------------------------------------------------------
# This platform does NOT do real billing. CDRs are exported to an external
# system (Equinox) which rates and invoices. The "billing estimate" below is a
# READ-ONLY, best-effort projection of monthly recurring charges (MRC) only —
# it never touches CDRs, rate_cdr(), the rates deck, or tier writes.
#
# Pricing model (see docker/postgres/init/07_cps_tiers.sql):
#   - RCF:   flat per-line MRC; a "line" = one row in rcf_numbers for the customer.
#   - Trunk: cps_tiers.monthly_fee (via customers.trunk_tier_id) — a bundled
#            "standard tier" whose fee already includes cps_tiers.call_paths
#            concurrent call paths — PLUS any add-on call-path packages the trunks
#            carry (sip_trunks.call_path_package_id -> call_path_packages.monthly_fee,
#            summed across the customer's trunks) that stack on top of the bundle.
#   - API:   cps_tiers.monthly_fee (via customers.api_tier_id).
RCF_LINE_MRC = Decimal("5.00")
VOICEMAIL_BOX_MRC = Decimal("2.00")  # PLACEHOLDER — confirm with product

_BILLING_DISCLAIMER = (
    "Estimated monthly recurring charges. "
    "Official invoicing is handled by your provider."
)


def _money(value) -> float:
    """Coerce a Decimal / numeric / None money value to a plain float."""
    if value is None:
        return 0.0
    return float(value)


async def compute_billing_estimate(conn, customer_id: int) -> dict:
    """Compute a READ-ONLY estimated monthly bill for one customer.

    MRC only — no usage/CDR charges. Only the line items relevant to the
    customer's ``account_type`` are included:
      - rcf            -> RCF line
      - trunk/hybrid   -> SIP Trunking line (CPS tier + call paths)
      - api/hybrid     -> API Calling line (CPS tier)

    ``conn`` is a live asyncpg connection (pool-acquired by the caller) so the
    whole estimate reads from a single connection. All money is returned as
    ``float``; all params carry explicit ``::type`` casts for asyncpg/PgBouncer.
    """
    row = await conn.fetchrow(
        "SELECT account_type FROM customers WHERE id = $1::int",
        customer_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    account_type = row["account_type"]

    line_items: list[dict] = []
    total = Decimal("0")

    # --- RCF -----------------------------------------------------------------
    # RCF numbers can be provisioned on ANY account_type (e.g. a hybrid customer
    # that also owns RCF numbers), so drive the line item off the ACTUAL
    # provisioned line count — not the account_type label. Always run the COUNT;
    # include the line when the customer has RCF numbers, OR when the account is
    # pure-RCF (so a 0-line RCF account still shows an RCF line).
    line_row = await conn.fetchrow(
        "SELECT COUNT(*)::int AS n FROM rcf_numbers WHERE customer_id = $1::int",
        customer_id,
    )
    lines = line_row["n"]
    if lines > 0 or account_type == "rcf":
        subtotal = RCF_LINE_MRC * lines
        total += subtotal
        line_items.append({
            "product": "rcf",
            "label": "Remote Call Forwarding",
            "qty": lines,
            "unit": "line",
            "unit_price": _money(RCF_LINE_MRC),
            "subtotal": _money(subtotal),
        })

    # --- SIP Trunking --------------------------------------------------------
    if account_type in ("trunk", "hybrid"):
        # CPS tier MRC via customers.trunk_tier_id -> cps_tiers.monthly_fee.
        # Trunk tiers now BUNDLE a block of call paths (cps_tiers.call_paths); the
        # tier fee already includes that bundle. Add-on packages stack on top.
        tier_row = await conn.fetchrow(
            """
            SELECT t.name AS name, t.monthly_fee AS monthly_fee,
                   t.call_paths AS call_paths
            FROM customers c
            LEFT JOIN cps_tiers t ON c.trunk_tier_id = t.id
            WHERE c.id = $1::int
            """,
            customer_id,
        )
        tier_name = tier_row["name"] if tier_row and tier_row["name"] else "none"
        tier_fee = Decimal(str(tier_row["monthly_fee"])) if tier_row and tier_row["monthly_fee"] is not None else Decimal("0")
        tier_call_paths = tier_row["call_paths"] if tier_row and tier_row["call_paths"] is not None else 0

        # Call-path MRC: each trunk carries its own package FK
        # (sip_trunks.call_path_package_id -> call_path_packages.monthly_fee).
        # Sum the package fees across all of the customer's trunks, and total
        # the concurrent call paths those packages provide.
        cp_row = await conn.fetchrow(
            """
            SELECT COALESCE(SUM(p.monthly_fee), 0) AS fee,
                   COALESCE(SUM(p.call_paths), 0)::int AS paths
            FROM sip_trunks s
            JOIN call_path_packages p ON s.call_path_package_id = p.id
            WHERE s.customer_id = $1::int
            """,
            customer_id,
        )
        cp_fee = Decimal(str(cp_row["fee"])) if cp_row and cp_row["fee"] is not None else Decimal("0")
        cp_paths = cp_row["paths"] if cp_row and cp_row["paths"] is not None else 0

        subtotal = tier_fee + cp_fee
        total += subtotal
        line_items.append({
            "product": "trunk",
            "label": "SIP Trunking",
            "subtotal": _money(subtotal),
            "components": [
                {"label": f"CPS tier — {tier_name} (incl. {tier_call_paths} paths)", "amount": _money(tier_fee)},
                {"label": f"Add-on call paths ({cp_paths})", "amount": _money(cp_fee)},
            ],
        })

    # --- API Calling ---------------------------------------------------------
    if account_type in ("api", "hybrid"):
        tier_row = await conn.fetchrow(
            """
            SELECT t.name AS name, t.monthly_fee AS monthly_fee
            FROM customers c
            LEFT JOIN cps_tiers t ON c.api_tier_id = t.id
            WHERE c.id = $1::int
            """,
            customer_id,
        )
        tier_name = tier_row["name"] if tier_row and tier_row["name"] else "none"
        tier_fee = Decimal(str(tier_row["monthly_fee"])) if tier_row and tier_row["monthly_fee"] is not None else Decimal("0")

        subtotal = tier_fee
        total += subtotal
        line_items.append({
            "product": "api",
            "label": "API Calling",
            "subtotal": _money(subtotal),
            "components": [
                {"label": f"CPS tier — {tier_name}", "amount": _money(tier_fee)},
            ],
        })

    # --- Visual Voicemail (NOT YET BUILT) ------------------------------------
    # The VVM product does not exist on this branch — there is no voicemail /
    # mailbox table in the schema — so the voicemail line is intentionally
    # OMITTED. When the product ships, switch it on here with a box count like:
    #
    #   vm_row = await conn.fetchrow(
    #       "SELECT COUNT(*)::int AS n FROM voicemail_boxes WHERE customer_id = $1::int",
    #       customer_id,
    #   )
    #   boxes = vm_row["n"]
    #   if boxes:
    #       subtotal = VOICEMAIL_BOX_MRC * boxes
    #       total += subtotal
    #       line_items.append({
    #           "product": "voicemail",
    #           "label": "Visual Voicemail",
    #           "qty": boxes,
    #           "unit": "mailbox",
    #           "unit_price": _money(VOICEMAIL_BOX_MRC),
    #           "subtotal": _money(subtotal),
    #       })

    return {
        "currency": "USD",
        "disclaimer": _BILLING_DISCLAIMER,
        "account_type": account_type,
        "line_items": line_items,
        "total_monthly_estimate": _money(total),
    }


class CustomerCreate(BaseModel):
    name: str
    account_type: str = "rcf"  # rcf, api, trunk, hybrid, ucaas
    credit_limit: float = 0
    traffic_grade: str = "standard"
    daily_limit: float = 500
    cpm_limit: int = 60
    ucaas_enabled: bool = False  # UCaaS add-on for api/trunk/hybrid customers


class CustomerUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    credit_limit: Optional[float] = None
    traffic_grade: Optional[str] = None
    daily_limit: Optional[float] = None
    cpm_limit: Optional[int] = None
    ucaas_enabled: Optional[bool] = None


@router.get("")
async def list_customers(
    status: Optional[str] = None,
    account_type: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    customer_filter: int | None = Depends(get_support_read_filter),
    user: dict = Depends(get_current_user),
):
    """List customers with optional filters.

    Admins see every row with the full column set. Support sees every row but
    SLIM (financial/ops columns — balance, credit_limit, fraud_score,
    daily_limit, cpm_limit — are withheld). Tenant users see only their own
    row, also slim. Same response shape otherwise (id + name for dropdowns).
    """
    if user.get("role") == "admin":
        select_cols = """id, name, account_type, balance, credit_limit, status,
               traffic_grade, daily_limit, cpm_limit, fraud_score,
               ucaas_enabled, created_at"""
    else:
        select_cols = """id, name, account_type, status,
               traffic_grade, ucaas_enabled, created_at"""

    query = f"""
        SELECT {select_cols}
        FROM customers
        WHERE 1=1
    """
    values = []
    idx = 1

    if customer_filter is not None:
        query += f" AND id = ${idx}"
        values.append(customer_filter)
        idx += 1

    if status is not None:
        query += f" AND status = ${idx}"
        values.append(status)
        idx += 1

    if account_type is not None:
        query += f" AND account_type = ${idx}"
        values.append(account_type)
        idx += 1

    query += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    results = await db.fetch_all(query, *values)
    return [dict(r) for r in results]


@router.post("")
async def create_customer(customer: CustomerCreate, admin: dict = Depends(require_admin)):
    """Create a new customer. Admin-only: provisioning."""
    # UCaaS account type always has UCaaS enabled implicitly
    ucaas_flag = True if customer.account_type == "ucaas" else customer.ucaas_enabled
    result = await db.fetch_one(
        """
        INSERT INTO customers (name, account_type, credit_limit, traffic_grade, daily_limit, cpm_limit, ucaas_enabled)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, name, account_type, balance, status, traffic_grade, ucaas_enabled, created_at
        """,
        customer.name, customer.account_type, customer.credit_limit,
        customer.traffic_grade, customer.daily_limit, customer.cpm_limit, ucaas_flag
    )
    return dict(result)


# NOTE: This literal `/me` route MUST be declared BEFORE the dynamic
# `/{customer_id}` route below. FastAPI matches routes in declaration order;
# if `/{customer_id}` came first, a request to `/me` would try to parse "me"
# as an int and fail with a 422 instead of reaching this handler.
@router.get("/me")
async def get_my_customer(user: dict = Depends(get_current_user)):
    """Return the authenticated caller's OWN customer record + product counts.

    Scope is derived ONLY from the JWT (never a client-supplied id). A caller
    with no associated customer (e.g. a pure platform admin) gets a 404 so we
    never leak the existence of other customers.
    """
    customer_id = user.get("customer_id")
    if customer_id is None:
        raise HTTPException(status_code=404, detail="No customer associated with this account")

    row = await db.fetch_one(
        """
        SELECT id, name, account_type, status, traffic_grade,
               daily_limit, cpm_limit,
               ucaas_enabled, created_at
        FROM customers WHERE id = $1::int
        """,
        customer_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="No customer associated with this account")

    rcf_count = await db.fetch_one(
        "SELECT COUNT(*)::int AS n FROM rcf_numbers WHERE customer_id = $1::int",
        customer_id,
    )
    api_count = await db.fetch_one(
        "SELECT COUNT(*)::int AS n FROM api_dids WHERE customer_id = $1::int",
        customer_id,
    )
    trunk_count = await db.fetch_one(
        "SELECT COUNT(*)::int AS n FROM sip_trunks WHERE customer_id = $1::int",
        customer_id,
    )

    c = dict(row)
    return {
        "id": c["id"],
        "name": c["name"],
        "account_type": c["account_type"],
        "status": c["status"],
        "traffic_grade": c["traffic_grade"],
        "daily_limit": c["daily_limit"],
        "cpm_limit": c["cpm_limit"],
        "ucaas_enabled": c["ucaas_enabled"],
        "created_at": c["created_at"].isoformat() if c["created_at"] is not None else None,
        "counts": {
            "rcf": rcf_count["n"],
            "api_dids": api_count["n"],
            "trunks": trunk_count["n"],
        },
    }


# NOTE: like `/me` above, this literal `/me/billing` route MUST be declared
# BEFORE the dynamic `/{customer_id}/billing` route below, or FastAPI would try
# to parse "me" as an int and 422 before reaching this handler.
@router.get("/me/billing")
async def get_my_billing(user: dict = Depends(get_current_user)):
    """Estimated monthly recurring charges for the caller's OWN customer.

    READ-ONLY projection (MRC only). Scope comes exclusively from the JWT; a
    caller with no associated customer gets a 404 (no leak of other customers).
    Official invoicing is handled externally (Equinox) — this is an estimate.
    """
    customer_id = user.get("customer_id")
    if customer_id is None:
        raise HTTPException(status_code=404, detail="No customer associated with this account")

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        return await compute_billing_estimate(conn, customer_id)


@router.get("/{customer_id}")
async def get_customer(customer_id: int, admin: dict = Depends(require_admin)):
    """Get customer by ID (admin only — full row incl. financials; customers
    read their own record via /me)."""
    result = await db.fetch_one(
        """
        SELECT id, name, account_type, balance, credit_limit, status,
               traffic_grade, daily_limit, cpm_limit, fraud_score,
               ucaas_enabled, created_at
        FROM customers WHERE id = $1
        """,
        customer_id
    )
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)


@router.get("/{customer_id}/billing")
async def get_customer_billing(customer_id: int, admin: dict = Depends(require_admin)):
    """Admin: estimated monthly recurring charges for any customer.

    READ-ONLY projection (MRC only); official invoicing is external (Equinox).
    404 if the customer does not exist.
    """
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        return await compute_billing_estimate(conn, customer_id)


@router.put("/{customer_id}")
async def update_customer(
    customer_id: int, customer: CustomerUpdate, admin: dict = Depends(require_admin)
):
    """Update customer settings. Admin-only: billing/limits-affecting."""
    updates = []
    values = []
    idx = 1

    for field, value in customer.model_dump(exclude_none=True).items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    values.append(customer_id)
    query = f"""
        UPDATE customers SET {', '.join(updates)}, updated_at = NOW()
        WHERE id = ${idx}
        RETURNING id, name, account_type, status, traffic_grade, ucaas_enabled
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)


@router.delete("/{customer_id}")
async def delete_customer(customer_id: int, admin: dict = Depends(require_admin)):
    """Delete a customer and all associated records. Admin-only: deprovisioning.

    All DELETEs are wrapped in a single transaction so that a failure
    midway does not leave orphaned records or a half-deleted customer.
    """
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Delete dependent records first (FK constraints)
            await conn.execute("DELETE FROM rcf_numbers WHERE customer_id = $1", customer_id)
            await conn.execute("DELETE FROM api_dids WHERE customer_id = $1", customer_id)
            # Trunk children
            await conn.execute(
                "DELETE FROM trunk_dids WHERE trunk_id IN (SELECT id FROM sip_trunks WHERE customer_id = $1)",
                customer_id,
            )
            await conn.execute(
                "DELETE FROM trunk_auth_ips WHERE trunk_id IN (SELECT id FROM sip_trunks WHERE customer_id = $1)",
                customer_id,
            )
            await conn.execute("DELETE FROM sip_trunks WHERE customer_id = $1", customer_id)
            await conn.execute("DELETE FROM api_credentials WHERE customer_id = $1", customer_id)
            # Delete customer
            result = await conn.execute("DELETE FROM customers WHERE id = $1", customer_id)
            if result == "DELETE 0":
                raise HTTPException(status_code=404, detail="Customer not found")
    return {"status": "deleted", "customer_id": customer_id}


@router.get("/{customer_id}/balance")
async def get_balance(customer_id: int, admin: dict = Depends(require_admin)):
    """Get customer balance and credit info (admin only — financial data)."""
    result = await db.fetch_one(
        """
        SELECT id, balance, credit_limit, (balance + credit_limit) as available
        FROM customers WHERE id = $1
        """,
        customer_id
    )
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)


@router.post("/{customer_id}/credit")
async def add_credit(customer_id: int, amount: float, admin: dict = Depends(require_admin)):
    """Add credit to customer balance. Admin-only: financial write."""
    result = await db.fetch_one(
        """
        UPDATE customers SET balance = balance + $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, balance
        """,
        amount, customer_id
    )
    if not result:
        raise HTTPException(status_code=404, detail="Customer not found")
    return dict(result)
