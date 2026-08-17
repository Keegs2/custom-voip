"""Live per-call price quoting off the REAL rate deck (shared helper).

Used by the x402 pay-per-call gate on ``POST /v1/calls`` (routers/calls.py) and
by the admin rate lookup (routers/rates.py). Both resolve rates the SAME way the
SQL rating engine does — the ``get_rate()`` longest-prefix function from
``docker/postgres/init/05_schema_cdr.sql`` — so a quoted price always matches
what ``rate_cdr()`` would charge for the first minute.

Quote formula (x402 pay-per-call, PAYMENTS demo):

    total = connect_fee + first_minute

  * ``connect_fee``   — the customer's CPS-tier per-call fee (``cps_tiers.per_call_fee``
    via ``customers.api_tier_id`` — resolved by the caller, calls.py already has it).
    NOTE: this is deliberately the TIER fee, not the rate deck's ``connection_fee``
    column (the deck fee belongs to duration rating; the tier fee is what the
    prepaid path charges per call, so both payment paths price the attempt the
    same way).
  * ``first_minute``  — one minute prepaid at the longest-prefix ``rate_per_min``
    for the dialed destination, from the customer's OUTBOUND rate table
    (``customer_rate_assignments.outbound_rate_table_id``), falling back to the
    default rate table exactly like ``rate_cdr()`` does.

All arithmetic is ``decimal.Decimal`` — exact fixed-point, never floats. The
total is quantized to 4 decimal places (the ledger's DECIMAL(12,4) unit,
ROUND_HALF_UP).

An unrateable destination (no prefix in the deck covers it, or no rate table
exists) returns ``None`` — the router surfaces that honestly as a 422, it does
NOT invent a default rate (unlike ``rate_cdr()``'s 0.01 fallback: a payment
quote must never charge a made-up price).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from db import database as db

logger = logging.getLogger(__name__)

#: Ledger money unit — DECIMAL(12,4).
QUOTE_PLACES = Decimal("0.0001")


@dataclass(frozen=True)
class CallPriceQuote:
    """A live, destination-specific price quote for one API call attempt."""
    destination: str          # canonical dialed number the quote covers
    connect_fee: Decimal      # CPS-tier per-call fee (money unit, 4dp)
    rate_per_min: Decimal     # matched deck rate (as stored, up to 6dp)
    first_minute: Decimal     # 1 minute prepay == rate_per_min
    total: Decimal            # connect_fee + first_minute, quantized to 4dp
    prefix: str               # the deck prefix that matched (longest match)
    rate_table_id: int        # which rate table priced it

    def breakdown(self) -> dict:
        """JSON-safe breakdown (money as exact strings, never binary floats)."""
        return {
            "connect_fee": str(self.connect_fee),
            "rate_per_min": str(self.rate_per_min),
            "first_minute": str(self.first_minute),
            "total": str(self.total),
            "currency": "USD",
            "destination": self.destination,
            "matched_prefix": self.prefix,
            "rate_table_id": self.rate_table_id,
        }


async def get_default_rate_table_id() -> Optional[int]:
    """The default rate table id (``is_default``), else the first table, else None."""
    row = await db.fetch_one(
        "SELECT id FROM rate_tables WHERE is_default = true LIMIT 1")
    if row:
        return row["id"]
    row = await db.fetch_one("SELECT id FROM rate_tables ORDER BY id LIMIT 1")
    return row["id"] if row else None


async def resolve_rate_table_id(customer_id: int) -> Optional[int]:
    """The rate table that prices this customer's OUTBOUND calls.

    Mirrors ``rate_cdr()``: customer assignment first, then the default table.
    """
    row = await db.fetch_one(
        "SELECT outbound_rate_table_id FROM customer_rate_assignments "
        "WHERE customer_id = $1::int",
        customer_id,
    )
    if row and row["outbound_rate_table_id"] is not None:
        return row["outbound_rate_table_id"]
    return await get_default_rate_table_id()


async def lookup_rate(destination: str, rate_table_id: int):
    """Longest-prefix rate row for a destination (``get_rate()`` SQL function).

    Returns the asyncpg Record (rate_per_min, cost_per_min, connection_fee,
    min_duration, increment, prefix) or None when no prefix covers the number.
    """
    clean = destination.lstrip("+")
    return await db.fetch_one(
        "SELECT * FROM get_rate($1::int, $2::varchar)", rate_table_id, clean)


async def quote_call_price(
    *, customer_id: int, destination: str, connect_fee: Decimal,
) -> Optional[CallPriceQuote]:
    """Compute the live pay-per-call quote for ``destination``.

    Returns None when the destination is not rateable (no rate table, or no
    deck prefix matches) — the caller decides how to surface that (422).
    """
    rate_table_id = await resolve_rate_table_id(customer_id)
    if rate_table_id is None:
        logger.warning("x402 quote: no rate tables exist (customer %s)", customer_id)
        return None
    row = await lookup_rate(destination, rate_table_id)
    if not row or row["rate_per_min"] is None:
        return None
    rate_per_min: Decimal = row["rate_per_min"]
    connect = connect_fee.quantize(QUOTE_PLACES, rounding=ROUND_HALF_UP)
    first_minute = rate_per_min
    total = (connect + first_minute).quantize(QUOTE_PLACES, rounding=ROUND_HALF_UP)
    return CallPriceQuote(
        destination=destination,
        connect_fee=connect,
        rate_per_min=rate_per_min,
        first_minute=first_minute,
        total=total,
        prefix=row["prefix"],
        rate_table_id=rate_table_id,
    )
