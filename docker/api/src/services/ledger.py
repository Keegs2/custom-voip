"""Append-only ledger service — the monetary spine (Payments Wave 1).

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §0-§2, §7 Wave 1.

This module is the ONE place that writes ``customers.balance``. Every money
event (topup, usage, fee, refund, adjustment, promo, chargeback) is recorded as
an immutable row in ``ledger_entries``, and the ``customers.balance`` column is a
CACHE that is updated in the SAME transaction as the entry insert. That keeps the
reconciliation invariant true at all times::

    SUM(ledger_entries.amount WHERE customer_id = C) == customers.balance(C)

(for balance movement produced by this system — see the migration's note about a
customer's pre-ledger opening balance).

╔══════════════════════════════════════════════════════════════════════════╗
║  RULE — NOTHING writes ``customers.balance`` directly outside this module ║
║  (and the SQL ``rate_cdr()`` function, which does the same insert+update  ║
║  atomically in-database). ``balance = balance ± …`` anywhere else silently ║
║  breaks the reconciliation invariant. Route ALL balance changes through   ║
║  ``post_ledger_entry``.                                                    ║
╚══════════════════════════════════════════════════════════════════════════╝

Properties:
  * IDEMPOTENT — ``idempotency_key`` is UNIQUE. Re-posting the same key returns
    the EXISTING entry and does NOT double-apply (no double-charge / double-credit).
  * TRANSACTIONAL — the entry insert + balance-cache update run in one DB
    transaction. ``balance_after`` snapshots the resulting balance.
  * APPEND-ONLY — the ``api`` DB role is granted SELECT+INSERT only on
    ``ledger_entries`` (no UPDATE/DELETE), so a posted entry can never be mutated.

Amounts are ``decimal.Decimal`` (asyncpg maps DECIMAL(12,4) <-> Decimal) —
exact fixed-point, never floats. Positive = money IN, negative = money OUT.
"""
import logging
from decimal import Decimal
from typing import Any, Optional, Union

import asyncpg

from db import database as db

logger = logging.getLogger(__name__)

# Mirrors the CHECK constraints in the 2026-07-20_payments_ledger.sql migration.
ENTRY_TYPES = frozenset(
    {"topup", "usage", "fee", "refund", "adjustment", "promo", "chargeback"}
)
SOURCES = frozenset(
    {"stripe_card", "stripe_crypto", "stripe_mpp", "x402", "admin", "rating"}
)

# Columns returned for a ledger entry (kept in one place so reads/writes agree).
_ENTRY_COLUMNS = (
    "id, customer_id, amount, currency, entry_type, source, "
    "idempotency_key, external_ref, balance_after, metadata, created_at"
)


def _to_decimal(amount: Union[Decimal, int, str]) -> Decimal:
    """Coerce a caller-supplied amount to Decimal WITHOUT going through float.

    Accepts Decimal (preferred), int, or a numeric string. A float is rejected:
    binary floats are not exact and must never enter the ledger (design "never
    floats" rule). Callers holding a float must ``str()`` or ``Decimal(...)`` it
    at their boundary first.
    """
    if isinstance(amount, Decimal):
        return amount
    if isinstance(amount, bool):  # bool is an int subclass — reject explicitly
        raise TypeError("ledger amount must be Decimal/int/str, not bool")
    if isinstance(amount, int):
        return Decimal(amount)
    if isinstance(amount, str):
        return Decimal(amount)
    raise TypeError(
        f"ledger amount must be Decimal, int, or numeric str (got {type(amount).__name__}); "
        "floats are rejected to keep the ledger exact"
    )


async def _post_in_conn(
    conn: asyncpg.Connection,
    *,
    customer_id: int,
    amount: Decimal,
    entry_type: str,
    source: str,
    idempotency_key: str,
    currency: str,
    external_ref: Optional[str],
    metadata: Optional[dict],
) -> tuple[asyncpg.Record, bool]:
    """Core insert+balance-update, run inside an EXISTING transaction.

    Returns ``(entry_record, created)`` where ``created`` is False when the
    idempotency key already existed (the existing row is returned unchanged and
    the balance is NOT touched again).

    Concurrency: two racing posts with the same key can both pass an existence
    pre-check, so we rely on the DB. The INSERT uses ``ON CONFLICT
    (idempotency_key) DO NOTHING``; if it inserted nothing, another txn won the
    race and we read+return the winner's row. This makes the operation exactly
    once per key even under concurrency.
    """
    metadata_json = None
    if metadata is not None:
        import json
        metadata_json = json.dumps(metadata)

    # 1) Fast path: entry already exists → return it, do NOT re-apply.
    existing = await conn.fetchrow(
        f"SELECT {_ENTRY_COLUMNS} FROM ledger_entries WHERE idempotency_key = $1::text",
        idempotency_key,
    )
    if existing is not None:
        return existing, False

    # 2) Atomically move the balance cache and capture the resulting balance.
    #    This is the ONLY balance write in the Python layer (rate_cdr() does the
    #    equivalent in SQL). Uses explicit ::type casts for asyncpg/PgBouncer.
    row = await conn.fetchrow(
        """
        UPDATE customers
        SET balance = balance + $1::numeric, updated_at = NOW()
        WHERE id = $2::int
        RETURNING balance
        """,
        amount, customer_id,
    )
    if row is None:
        # No such customer — surface a clear error; the FK would also reject the
        # entry insert, but this gives a precise message and avoids a partial op.
        raise ValueError(f"customer {customer_id} not found")
    new_balance: Decimal = row["balance"]

    # 3) Append the immutable entry. ON CONFLICT guards the concurrent-double-post
    #    race: if a competitor inserted this key between step 1 and here, we insert
    #    nothing and must UNDO our balance move, then return the competitor's row.
    inserted = await conn.fetchrow(
        f"""
        INSERT INTO ledger_entries
            (customer_id, amount, currency, entry_type, source,
             idempotency_key, external_ref, balance_after, metadata)
        VALUES
            ($1::int, $2::numeric, $3::text, $4::text, $5::text,
             $6::text, $7::text, $8::numeric, $9::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING {_ENTRY_COLUMNS}
        """,
        customer_id, amount, currency, entry_type, source,
        idempotency_key, external_ref, new_balance, metadata_json,
    )
    if inserted is None:
        # Lost the race: another txn already posted this key. Revert the balance
        # move we just did so we don't double-apply, then return the winner.
        await conn.execute(
            """
            UPDATE customers
            SET balance = balance - $1::numeric, updated_at = NOW()
            WHERE id = $2::int
            """,
            amount, customer_id,
        )
        winner = await conn.fetchrow(
            f"SELECT {_ENTRY_COLUMNS} FROM ledger_entries WHERE idempotency_key = $1::text",
            idempotency_key,
        )
        return winner, False

    return inserted, True


async def post_ledger_entry(
    conn_or_customer_id: Union[asyncpg.Connection, int],
    *,
    amount: Union[Decimal, int, str],
    entry_type: str,
    source: str,
    idempotency_key: str,
    customer_id: Optional[int] = None,
    currency: str = "USD",
    external_ref: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict[str, Any]:
    """Post one money event to the ledger (idempotent, transactional).

    The FIRST positional arg is either:
      * an ``asyncpg.Connection`` already inside a transaction — the entry insert
        and balance update join the CALLER's transaction (use this from
        ``add_credit`` / the per-call-fee path so the whole operation is atomic
        with any sibling writes). When you pass a connection you MUST also pass
        ``customer_id=`` as a keyword.
      * an ``int`` customer_id — this function opens its own connection +
        transaction and posts standalone.

    Args:
        amount: signed Decimal/int/str. Positive = money IN, negative = money
            OUT. Floats are rejected (kept exact).
        entry_type: one of ENTRY_TYPES.
        source: one of SOURCES.
        idempotency_key: globally-unique key. Re-posting the same key returns the
            existing entry and does NOT re-apply (no double-charge/credit).
        customer_id: required when the first arg is a connection; ignored (must
            match) when the first arg is the id itself.
        currency: ISO code, default 'USD'.
        external_ref: processor/on-chain reference (pi_…/tx hash), optional.
        metadata: JSON-serialisable dict, optional.

    Returns:
        The ledger entry as a dict (existing row if the key was already present).

    Raises:
        ValueError on unknown entry_type/source, missing customer, or a bad
        amount coercion.
    """
    if entry_type not in ENTRY_TYPES:
        raise ValueError(f"invalid entry_type {entry_type!r}; must be one of {sorted(ENTRY_TYPES)}")
    if source not in SOURCES:
        raise ValueError(f"invalid source {source!r}; must be one of {sorted(SOURCES)}")
    if not idempotency_key:
        raise ValueError("idempotency_key is required (idempotency is mandatory)")

    dec_amount = _to_decimal(amount)

    if isinstance(conn_or_customer_id, int):
        cid = conn_or_customer_id
        if customer_id is not None and customer_id != cid:
            raise ValueError("customer_id kwarg conflicts with positional customer_id")
        pool = await db.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                entry, _created = await _post_in_conn(
                    conn,
                    customer_id=cid,
                    amount=dec_amount,
                    entry_type=entry_type,
                    source=source,
                    idempotency_key=idempotency_key,
                    currency=currency,
                    external_ref=external_ref,
                    metadata=metadata,
                )
        return dict(entry)

    # First arg is a live connection — join the caller's transaction. The caller
    # is responsible for the surrounding ``async with conn.transaction()``.
    conn = conn_or_customer_id
    if customer_id is None:
        raise ValueError("customer_id keyword is required when passing a connection")
    entry, _created = await _post_in_conn(
        conn,
        customer_id=customer_id,
        amount=dec_amount,
        entry_type=entry_type,
        source=source,
        idempotency_key=idempotency_key,
        currency=currency,
        external_ref=external_ref,
        metadata=metadata,
    )
    return dict(entry)


async def get_balance(customer_id: int) -> Optional[Decimal]:
    """Return the cached balance for a customer, or None if the customer is absent.

    This reads the ``customers.balance`` cache (the authoritative real-time value
    the call path uses). Use :func:`reconcile_balance` to prove it equals the
    ledger sum.
    """
    row = await db.fetch_one(
        "SELECT balance FROM customers WHERE id = $1::int", customer_id
    )
    return row["balance"] if row else None


async def reconcile_balance(customer_id: int) -> dict[str, Any]:
    """Compute ledger_sum vs balance cache for a customer (reconciliation check).

    Returns ``{customer_id, ledger_sum, balance, reconciled}`` where
    ``reconciled`` is True when the summed ledger entries equal the cached
    balance. ``ledger_sum`` is the SUM of this system's posted entries; on a DB
    with pre-ledger balances the two differ by the opening balance until a
    backfill seed is posted (see migration note).
    """
    row = await db.fetch_one(
        """
        SELECT c.balance AS balance,
               COALESCE(l.ledger_sum, 0)::numeric AS ledger_sum
        FROM customers c
        LEFT JOIN (
            SELECT customer_id, SUM(amount) AS ledger_sum
            FROM ledger_entries
            WHERE customer_id = $1::int
            GROUP BY customer_id
        ) l ON l.customer_id = c.id
        WHERE c.id = $1::int
        """,
        customer_id,
    )
    if not row:
        return {"customer_id": customer_id, "ledger_sum": None, "balance": None,
                "reconciled": False}
    return {
        "customer_id": customer_id,
        "ledger_sum": row["ledger_sum"],
        "balance": row["balance"],
        "reconciled": row["ledger_sum"] == row["balance"],
    }


async def get_ledger(
    customer_id: int,
    *,
    limit: int = 50,
    cursor: Optional[int] = None,
) -> dict[str, Any]:
    """Read a customer's ledger history, newest first, keyset-paginated.

    Args:
        customer_id: the tenant whose entries to read.
        limit: page size (clamped 1..500).
        cursor: opaque cursor = the ``id`` of the last entry from the previous
            page; only entries with ``id < cursor`` are returned. None = first page.

    Returns:
        ``{"entries": [...], "next_cursor": <id or None>}``. ``next_cursor`` is
        the id to pass as ``cursor`` for the following page, or None when the last
        page was returned.
    """
    limit = max(1, min(int(limit), 500))
    values: list[Any] = [customer_id]
    query = (
        f"SELECT {_ENTRY_COLUMNS} FROM ledger_entries "
        "WHERE customer_id = $1::int"
    )
    if cursor is not None:
        query += " AND id < $2::bigint"
        values.append(int(cursor))
        query += " ORDER BY id DESC LIMIT $3::int"
    else:
        query += " ORDER BY id DESC LIMIT $2::int"
    # Fetch one extra to know whether another page exists.
    values.append(limit + 1)

    rows = await db.fetch_all(query, *values)
    entries = [dict(r) for r in rows]
    next_cursor: Optional[int] = None
    if len(entries) > limit:
        entries = entries[:limit]
        next_cursor = entries[-1]["id"]
    return {"entries": entries, "next_cursor": next_cursor}
