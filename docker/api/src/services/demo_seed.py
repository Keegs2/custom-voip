"""Demo seed + reset + state — isolation layer for the exec payments DEMO (§9).

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §9.

This is the ONLY module that creates/destroys demo data, and it is scoped HARD to
customers flagged ``is_demo = true`` so the demo can never touch a real tenant:

  * :func:`seed_demo` — idempotently creates a DEDICATED demo customer (clearly
    named, e.g. "DEMO — Acme Robotics"), gives it a starting balance via a REAL
    ledger topup, and sets up auto-recharge (threshold/recharge_amount) so the
    call-drain scenario visibly fires it. Returns the demo customer id.
  * :func:`reset_demo` — deletes ONLY rows belonging to is_demo customers
    (ledger_entries / payment_transactions / payment_methods / mpp_sessions /
    auto_recharge_settings / invoices / demo_scenarios) and the demo customers
    themselves. A real customer's data is physically out of scope.
  * :func:`demo_state` — assembles everything the exec dashboard needs for a demo
    customer: balance, recent ledger txns, active MPP sessions, auto-recharge
    status, and revenue-by-rail.

Everything the caller (the payments router) does with these is admin-gated AND
PAYMENTS_DEMO_MODE-gated — this module assumes it is only ever reached in demo mode.
"""
from __future__ import annotations

import json
import logging
import uuid
from decimal import Decimal
from typing import Any, Optional

from db import database as db
from services import ledger

logger = logging.getLogger(__name__)

#: The dedicated demo customer. Clearly named so it is unmistakable in any admin
#: view, and account_type 'api' (programmable voice — the rail the machine-payment
#: story rides on) rather than 'rcf' (RCF must stay simple, no payments UI).
DEMO_CUSTOMER_NAME = "DEMO — Acme Robotics"
DEMO_ACCOUNT_TYPE = "api"

#: Starting balance seeded via a REAL ledger topup (so history is genuine).
DEMO_START_BALANCE = Decimal("250.0000")
#: Auto-recharge: when balance dips below threshold, top up by recharge_amount.
DEMO_AR_THRESHOLD = Decimal("50.0000")
DEMO_AR_AMOUNT = Decimal("100.0000")
DEMO_AR_DAILY_CAP = Decimal("2000.0000")  # == closed-loop cap (design §1)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
async def get_demo_customer_id(name: str = DEMO_CUSTOMER_NAME) -> Optional[int]:
    """Return the id of the named demo customer, or None if not seeded yet."""
    row = await db.fetch_one(
        "SELECT id FROM customers WHERE is_demo = true AND name = $1::text LIMIT 1",
        name,
    )
    return row["id"] if row else None


async def list_demo_customer_ids() -> list[int]:
    """All is_demo customer ids (reset scope)."""
    rows = await db.fetch_all("SELECT id FROM customers WHERE is_demo = true ORDER BY id")
    return [r["id"] for r in rows]


async def record_scenario(customer_id: Optional[int], scenario: str,
                          detail: Optional[dict] = None) -> None:
    """Append a demo-activity audit row (best-effort; never raises)."""
    try:
        await db.execute(
            """
            INSERT INTO demo_scenarios (customer_id, scenario, detail)
            VALUES ($1::int, $2::text, $3::jsonb)
            """,
            customer_id, scenario, json.dumps(detail) if detail else None,
        )
    except Exception:  # noqa: BLE001 — audit is best-effort
        logger.debug("demo scenario record failed", exc_info=True)


# ---------------------------------------------------------------------------
# seed
# ---------------------------------------------------------------------------
async def seed_demo() -> dict[str, Any]:
    """Idempotently seed the demo customer + starting state. Returns a summary.

    Safe to call repeatedly: if the demo customer already exists it is reused (not
    duplicated) and only missing pieces are filled in. All money-in is via the
    ledger, so the seeded balance/history is real ledger data.
    """
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            existing = await conn.fetchrow(
                "SELECT id, balance FROM customers WHERE is_demo = true AND name = $1::text",
                DEMO_CUSTOMER_NAME,
            )
            if existing is None:
                created = await conn.fetchrow(
                    """
                    INSERT INTO customers
                        (name, account_type, balance, credit_limit, status,
                         traffic_grade, daily_limit, cpm_limit, is_demo)
                    VALUES ($1::text, $2::text, 0::numeric, 0::numeric, 'active',
                            'standard', 500::numeric, 60, true)
                    RETURNING id
                    """,
                    DEMO_CUSTOMER_NAME, DEMO_ACCOUNT_TYPE,
                )
                customer_id = created["id"]
                fresh = True
            else:
                customer_id = existing["id"]
                fresh = False

            # Seed the starting balance via a REAL ledger topup (idempotent key so
            # re-seeding never double-credits). source=stripe_crypto to also seed
            # the revenue-by-rail chart with a "B2B USDC top-up" (design §9 story 5).
            await ledger.post_ledger_entry(
                conn,
                customer_id=customer_id,
                amount=DEMO_START_BALANCE,
                entry_type="topup",
                source="stripe_crypto",
                idempotency_key=f"demo_seed_topup:{customer_id}",
                metadata={"reason": "demo_seed", "rail": "usdc_topup"},
            )

            # Auto-recharge settings (enabled, with threshold/amount/daily cap).
            await conn.execute(
                """
                INSERT INTO auto_recharge_settings
                    (customer_id, enabled, threshold, recharge_amount, currency,
                     daily_cap, cooldown_seconds, consecutive_failures)
                VALUES ($1::int, true, $2::numeric, $3::numeric, 'USD',
                        $4::numeric, 60, 0)
                ON CONFLICT (customer_id) DO UPDATE
                    SET enabled = true,
                        threshold = EXCLUDED.threshold,
                        recharge_amount = EXCLUDED.recharge_amount,
                        daily_cap = EXCLUDED.daily_cap,
                        cooldown_seconds = EXCLUDED.cooldown_seconds,
                        disabled_reason = NULL,
                        updated_at = NOW()
                """,
                customer_id, DEMO_AR_THRESHOLD, DEMO_AR_AMOUNT, DEMO_AR_DAILY_CAP,
            )

            # A seeded monthly plan-fee invoice so the invoices panel isn't empty
            # (design §9 story 6). Idempotent-ish: only insert if none for the
            # current month.
            await conn.execute(
                """
                INSERT INTO invoices
                    (customer_id, provider_invoice_id, amount, currency, status,
                     period_start, period_end)
                SELECT $1::int, $2::text, 299.0000::numeric, 'USD', 'paid',
                       date_trunc('month', NOW()), date_trunc('month', NOW()) + INTERVAL '1 month'
                WHERE NOT EXISTS (
                    SELECT 1 FROM invoices
                    WHERE customer_id = $1::int
                      AND period_start = date_trunc('month', NOW())
                )
                """,
                customer_id, f"in_demo_{customer_id}",
            )

    await record_scenario(customer_id, "seed",
                          {"fresh": fresh, "start_balance": float(DEMO_START_BALANCE)})
    balance = await ledger.get_balance(customer_id)
    logger.info("demo seeded: customer_id=%s fresh=%s balance=%s", customer_id, fresh, balance)
    return {
        "customer_id": customer_id,
        "name": DEMO_CUSTOMER_NAME,
        "fresh": fresh,
        "balance": balance,
        "auto_recharge": {
            "enabled": True,
            "threshold": DEMO_AR_THRESHOLD,
            "recharge_amount": DEMO_AR_AMOUNT,
        },
    }


# ---------------------------------------------------------------------------
# reset — deletes ONLY is_demo data
# ---------------------------------------------------------------------------
async def reset_demo() -> dict[str, Any]:
    """Delete ALL demo-seeded data (and the demo customers). Real tenants untouched.

    Scope is every customer with ``is_demo = true``. Child rows are removed before
    the customers so FK ``ON DELETE RESTRICT`` (ledger_entries / payment_transactions
    / invoices reference customers with RESTRICT) doesn't block the delete. Runs in
    one transaction.
    """
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            ids = await conn.fetch("SELECT id FROM customers WHERE is_demo = true")
            demo_ids = [r["id"] for r in ids]
            if not demo_ids:
                return {"deleted_customers": 0, "customer_ids": []}

            # Child rows first (ledger_entries + payment_transactions + invoices use
            # ON DELETE RESTRICT; the rest CASCADE, but we delete explicitly so the
            # counts are auditable and order-independent).
            await conn.execute("DELETE FROM demo_scenarios WHERE customer_id = ANY($1::int[])", demo_ids)
            await conn.execute("DELETE FROM mpp_sessions WHERE customer_id = ANY($1::int[])", demo_ids)
            await conn.execute("DELETE FROM auto_recharge_settings WHERE customer_id = ANY($1::int[])", demo_ids)
            await conn.execute("DELETE FROM payment_transactions WHERE customer_id = ANY($1::int[])", demo_ids)
            await conn.execute("DELETE FROM payment_methods WHERE customer_id = ANY($1::int[])", demo_ids)
            await conn.execute("DELETE FROM invoices WHERE customer_id = ANY($1::int[])", demo_ids)
            # ledger_entries is APPEND-ONLY for the `api` role (SELECT+INSERT only,
            # no DELETE) — that guarantee protects REAL customers' ledgers. Demo
            # rows are purged via a SECURITY DEFINER function whose WHERE clause is
            # hard-guarded to is_demo customers only, so the app can reset the demo
            # ledger without any DELETE privilege on ledger_entries. It clears rows
            # for ALL is_demo customers (== demo_ids in this txn) before the FK
            # RESTRICT on customer_id would block the customer delete.
            deleted_ledger = await conn.fetchval("SELECT reset_demo_ledger()")
            await conn.execute("DELETE FROM customers WHERE id = ANY($1::int[])", demo_ids)

    logger.info("demo reset: deleted %d demo customer(s) (%d ledger rows): %s",
                len(demo_ids), deleted_ledger or 0, demo_ids)
    return {"deleted_customers": len(demo_ids), "customer_ids": demo_ids,
            "deleted_ledger_entries": deleted_ledger or 0}


# ---------------------------------------------------------------------------
# state — everything the exec dashboard needs
# ---------------------------------------------------------------------------
async def revenue_by_rail(customer_id: Optional[int] = None) -> dict[str, Any]:
    """Money-IN grouped by rail (ledger source), for the revenue dashboard.

    Sums positive ``topup``/``refund``/``promo`` entries by source, plus a total.
    When ``customer_id`` is None, aggregates across all demo customers.
    """
    if customer_id is not None:
        rows = await db.fetch_all(
            """
            SELECT source, COALESCE(SUM(amount), 0)::numeric AS revenue, COUNT(*) AS n
            FROM ledger_entries
            WHERE customer_id = $1::int AND amount > 0
            GROUP BY source ORDER BY revenue DESC
            """,
            customer_id,
        )
    else:
        rows = await db.fetch_all(
            """
            SELECT le.source, COALESCE(SUM(le.amount), 0)::numeric AS revenue, COUNT(*) AS n
            FROM ledger_entries le
            JOIN customers c ON c.id = le.customer_id AND c.is_demo = true
            WHERE le.amount > 0
            GROUP BY le.source ORDER BY revenue DESC
            """,
        )
    # Friendly rail labels for the dashboard.
    labels = {
        "stripe_card": "Card (Stripe)",
        "stripe_crypto": "USDC top-up (Stripe)",
        "stripe_mpp": "Agent tab (Stripe MPP)",
        "x402": "x402 (USDC-on-Base)",
        "admin": "Manual credit",
        "rating": "Usage",
    }
    by_rail = [
        {"rail": r["source"], "label": labels.get(r["source"], r["source"]),
         "revenue": r["revenue"], "count": r["n"]}
        for r in rows
    ]
    total = sum((r["revenue"] for r in rows), Decimal("0"))
    return {"total_revenue": total, "by_rail": by_rail}


async def demo_state(customer_id: Optional[int] = None) -> dict[str, Any]:
    """Assemble the full exec-dashboard state for the demo customer.

    Returns balance, recent ledger transactions, active MPP sessions,
    auto-recharge status, payment methods, invoices, revenue-by-rail, and a recent
    scenario-activity trail. When ``customer_id`` is None, resolves the default
    seeded demo customer (returns ``seeded: false`` if none).
    """
    if customer_id is None:
        customer_id = await get_demo_customer_id()
    if customer_id is None:
        return {"seeded": False}

    cust = await db.fetch_one(
        "SELECT id, name, account_type, balance, credit_limit, is_demo FROM customers WHERE id = $1::int",
        customer_id,
    )
    if cust is None:
        return {"seeded": False}

    txns = await db.fetch_all(
        """
        SELECT id, amount, currency, entry_type, source, external_ref,
               balance_after, metadata, created_at
        FROM ledger_entries WHERE customer_id = $1::int
        ORDER BY id DESC LIMIT 20
        """,
        customer_id,
    )
    sessions = await db.fetch_all(
        """
        SELECT id, provider_session_id, spend_limit, total_charged, charge_count,
               status, label, settlement_ref, created_at, settled_at
        FROM mpp_sessions WHERE customer_id = $1::int
        ORDER BY id DESC LIMIT 10
        """,
        customer_id,
    )
    ar = await db.fetch_one(
        """
        SELECT enabled, threshold, recharge_amount, currency, daily_cap,
               cooldown_seconds, consecutive_failures, last_triggered_at, disabled_reason
        FROM auto_recharge_settings WHERE customer_id = $1::int
        """,
        customer_id,
    )
    methods = await db.fetch_all(
        """
        SELECT id, provider, provider_pm_id, brand, last4, exp_month, exp_year,
               is_default, status
        FROM payment_methods WHERE customer_id = $1::int AND status = 'active'
        ORDER BY is_default DESC, id ASC
        """,
        customer_id,
    )
    invoices = await db.fetch_all(
        """
        SELECT id, provider_invoice_id, amount, currency, status, period_start, period_end
        FROM invoices WHERE customer_id = $1::int ORDER BY id DESC LIMIT 6
        """,
        customer_id,
    )
    activity = await db.fetch_all(
        "SELECT scenario, detail, created_at FROM demo_scenarios WHERE customer_id = $1::int ORDER BY id DESC LIMIT 12",
        customer_id,
    )
    revenue = await revenue_by_rail(customer_id)

    # Parse the JSONB metadata columns (asyncpg returns them as text).
    def _row(r):
        d = dict(r)
        if "metadata" in d and isinstance(d["metadata"], str):
            try:
                d["metadata"] = json.loads(d["metadata"])
            except (ValueError, TypeError):
                pass
        if "detail" in d and isinstance(d["detail"], str):
            try:
                d["detail"] = json.loads(d["detail"])
            except (ValueError, TypeError):
                pass
        return d

    return {
        "seeded": True,
        "customer": dict(cust),
        "balance": cust["balance"],
        "transactions": [_row(t) for t in txns],
        "mpp_sessions": [dict(s) for s in sessions],
        "auto_recharge": dict(ar) if ar else None,
        "payment_methods": [dict(m) for m in methods],
        "invoices": [dict(i) for i in invoices],
        "revenue": revenue,
        "activity": [_row(a) for a in activity],
    }
