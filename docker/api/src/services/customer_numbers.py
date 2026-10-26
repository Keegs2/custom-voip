"""The ONE definition of "a customer's numbers" (product-agnostic).

Plan: docs/CUSTOMER_NUMBERS_HOLISTIC_PLAN.md §3 (contract §4).

Source: the ``number_routing`` view (22_number_routing.sql + the voicemail arm
from 54_voicemail.sql + the ivr arm from 59_ivr.sql) — one row per
platform-owned DID across EVERY product
arm, the same oracle FreeSWITCH routes on. A product enrolls by adding a
``number_routing`` arm (which FreeSWITCH needs anyway to route the number); it
then appears in Reporting (/reports/numbers, /reports/my-numbers and the
``numbers`` filter), the dashboard, /customers/me ``counts.numbers``,
/numbers/owned, /numbers/my and /search/did with no further backend change.
The enrollment checklist lives in docker/api/src/CLAUDE.md ("Customer
numbers").

Pure: no DB, no FastAPI. Every ``*_sql`` function returns FIXED SQL text built
only from the constants below; callers bind every value (with ``::type``
casts — PgBouncer + statement_cache_size=0).

Ownership rules (plan §3.2):
  * Owned = currently on the account in ANY product, enabled or not. Disabled
    RCF numbers, disabled trunks, suspended mailboxes and mailboxes of a
    customer whose ``voicemail_enabled`` is off are IN (``enabled`` false);
    deleted mailboxes are OUT (54's arm filters ``status <> 'deleted'``); an
    IVR number is IN whether or not its flow is published, the number is
    switched off or the customer's ``ivr_enabled`` is off (``enabled`` false);
    customer status is NOT applied (it is still their number).
  * ``api`` (API Calling, RETIRED) is never one of a customer's numbers in a
    customer-facing list or the admin dashboard counts (HIDDEN_PRODUCTS). The
    arm stays in number_routing (FreeSWITCH must still 603 it), /numbers/my
    and /search/did (admin cleanup).
  * A DID present in two product tables is listed ONCE; FreeSWITCH's STEP-1
    order wins (PRECEDENCE).
  * Never returned to a tenant: ``product_ref_id`` / ``customer_status``
    (number_routing internals) are not even selected here; ``customer_id``
    is selected for the admin /numbers/owned roll-up only and never reaches a
    tenant shape (TENANT_NUMBER_KEYS).
  * History: per-number figures always come from a customer-scoped CDR scan
    intersected with the owned set, so a released number's past calls stay in
    totals but get no number row, and a number moved to another customer never
    exposes the old owner's calls.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Optional

from utils.phone import normalize_e164

#: Never shown to customers as "their numbers". API Calling is RETIRED and
#: reports never listed api DIDs. The api arm stays in number_routing (FS must
#: hard-reject it) and in the admin tools (/numbers/my, /search/did).
HIDDEN_PRODUCTS: tuple[str, ...] = ("api",)

#: Duplicate-DID tie-break = FreeSWITCH STEP-1 order (inbound_router.lua
#: direct-dial lookups: rcf, then api, then trunk, then voicemail, then ivr —
#: 59_ivr.sql). Also the display order of products in every roll-up below;
#: unknown (future) products sort after these, by name.
PRECEDENCE: tuple[str, ...] = ("rcf", "api", "trunk", "voicemail", "ivr")

#: product_type sentinel meaning "no product filter" (GET /cdrs, /cdrs/summary,
#: /cdrs/activity). An empty product_type already meant that.
ALL_PRODUCTS = "all"

#: The keys of one customer-facing number row (GET /reports/my-numbers), in
#: contract order. Nothing else ever reaches a tenant.
TENANT_NUMBER_KEYS: tuple[str, ...] = ("number", "name", "product", "enabled", "forwards_to")

#: 422 detail for a `number` query param that is not a phone number.
BAD_NUMBER_DETAIL = "number must be a phone number"

# Every product name above is inlined into SQL as a literal: keep them to
# plain lowercase words so that can never become an injection vector.
_SQL_WORD = re.compile(r"^[a-z_]+$")
assert all(_SQL_WORD.match(p) for p in HIDDEN_PRODUCTS + PRECEDENCE + (ALL_PRODUCTS,)), \
    "product names are inlined as SQL literals and must match ^[a-z_]+$"

_SQL_ALIAS = re.compile(r"^[a-z_][a-z0-9_]*$")
_SQL_BIND = re.compile(r"^\$[1-9][0-9]?::int$")


# ---------------------------------------------------------------------------
# Canonical numbers (SQL twins of utils.phone.normalize_e164)
# ---------------------------------------------------------------------------
def canonical_e164_sql(expr: str) -> str:
    """SQL twin of utils.phone.normalize_e164 (same CASE as
    31_did_canonicalize.sql) so a CDR's raw caller_id/destination matches the
    canonical DIDs stored in every product table.

    Agrees with the Python rule on every CDR-shaped input (canonical +E.164,
    bare 10-digit NANP, 1+NANP, punctuated NANP). Where they differ the SQL
    side returns the RAW input (an ELSE pass-through), which matches no
    canonical DID — it can drop a call from a number row, never attribute it
    to the wrong number (tests/test_customer_numbers.py pins this).
    """
    digits = f"regexp_replace({expr}, '[^0-9]', '', 'g')"
    return (
        f"(CASE WHEN {expr} ~ '^\\+[1-9][0-9]{{1,14}}$' THEN {expr} "
        f"WHEN {digits} ~ '^1[2-9][0-9]{{9}}$' THEN '+' || {digits} "
        f"WHEN {digits} ~ '^[2-9][0-9]{{9}}$' THEN '+1' || {digits} "
        f"ELSE {expr} END)"
    )


def cdr_customer_number_sql(alias: Optional[str] = None) -> str:
    """Canonical customer-side number of a CDR: ``destination`` for inbound,
    ``caller_id`` for outbound (anything that isn't 'outbound' counts as
    inbound). `alias` qualifies the cdrs columns (None = unqualified, for the
    single-table CDR filter builders)."""
    if alias is not None and not _SQL_ALIAS.match(alias):
        raise ValueError(f"bad SQL alias {alias!r}")
    p = f"{alias}." if alias else ""
    return canonical_e164_sql(
        f"(CASE WHEN {p}direction = 'outbound' THEN {p}caller_id ELSE {p}destination END)")


def parse_number_param(raw: Optional[str]) -> Optional[str]:
    """`number` query param -> canonical +E.164, or None when absent/blank.

    Raises ValueError(BAD_NUMBER_DETAIL) for anything that is not a phone
    number (the routers map it to HTTP 422)."""
    if raw is None or not raw.strip():
        return None
    try:
        return normalize_e164(raw)
    except (ValueError, TypeError) as e:
        raise ValueError(BAD_NUMBER_DETAIL) from e


def product_filter(product_type: Optional[str]) -> Optional[str]:
    """A product_type query param -> the value to filter on, or None for "no
    product filter" (absent, empty, or the ALL_PRODUCTS sentinel)."""
    if product_type is None or not product_type.strip():
        return None
    if product_type.strip().lower() == ALL_PRODUCTS:
        return None
    return product_type


# ---------------------------------------------------------------------------
# The owned set
# ---------------------------------------------------------------------------
def precedence_sql(column: str) -> str:
    """ORDER BY key for duplicate-DID tie-breaks (PRECEDENCE, unknown last)."""
    if not _SQL_ALIAS.match(column.replace(".", "_", 1)):
        raise ValueError(f"bad SQL column {column!r}")
    whens = " ".join(f"WHEN '{p}' THEN {i}" for i, p in enumerate(PRECEDENCE, 1))
    return f"CASE {column} {whens} ELSE 99 END"


def _hidden_sql(column: str) -> str:
    if not HIDDEN_PRODUCTS:
        return "TRUE"
    literals = ", ".join("'" + p + "'" for p in HIDDEN_PRODUCTS)
    return f"{column} NOT IN ({literals})"


def not_hidden_sql(column: str) -> str:
    """Predicate: ``column`` is not a HIDDEN product, NULL-safe (a NULL
    product — e.g. a did_inventory row without one — passes). For
    customer-facing lists that read product columns directly (GET
    /numbers/my, tenant branch) rather than through ``owned_numbers_sql``."""
    if not _SQL_ALIAS.match(column.replace(".", "_", 1)):
        raise ValueError(f"bad SQL column {column!r}")
    if not HIDDEN_PRODUCTS:
        return "TRUE"
    literals = ", ".join("'" + p + "'" for p in HIDDEN_PRODUCTS)
    return f"({column} IS NULL OR {column} NOT IN ({literals}))"


def owned_numbers_sql(customer_bind: Optional[str]) -> str:
    """One row per owned DID: number, name, product, forwards_to, enabled,
    customer_id — for one customer (`customer_bind`, e.g. ``"$1::int"``) or,
    with None, every customer (admin roll-up only).

    `WHERE nr.customer_id = $n` is pushed into every UNION ALL arm of the view
    (the same pushdown FreeSWITCH relies on for `did`), so each arm reads its
    customer index: idx_rcf_customer, idx_api_did_customer,
    idx_trunks_customer -> idx_trunk_dids_trunk (migration 57),
    idx_voicemail_boxes_customer, idx_ivr_numbers_customer (migration 59).
    The result is a tiny set; callers wrap it
    in a CTE (`owned`) and join CDRs to it, never the other way round.
    """
    where = [_hidden_sql("nr.product_type")]
    if customer_bind is not None:
        if not _SQL_BIND.match(customer_bind):
            raise ValueError(f"customer_bind must look like '$1::int', got {customer_bind!r}")
        where.append(f"nr.customer_id = {customer_bind}")
    return f"""
    SELECT DISTINCT ON (nr.did)
           nr.did::text                        AS number,
           nr.product_name::text               AS name,
           nr.product_type::text               AS product,
           nr.forward_to::text                 AS forwards_to,
           COALESCE(nr.product_enabled, false) AS enabled,
           nr.customer_id                      AS customer_id
      FROM number_routing nr
     WHERE {' AND '.join(where)}
     ORDER BY nr.did, {precedence_sql('nr.product_type')}"""


def count_by_product_sql(customer_bind: str) -> str:
    """Owned numbers per product for one customer: rows (product, n)."""
    return (f"SELECT o.product, count(*)::int AS n "
            f"FROM ({owned_numbers_sql(customer_bind)}\n) o GROUP BY o.product")


def owned_counts_sql() -> str:
    """Owned numbers per (customer, product), all customers (admin only):
    rows (customer_id, product, total, enabled)."""
    return (f"SELECT o.customer_id, o.product, count(*)::int AS total, "
            f"count(*) FILTER (WHERE o.enabled)::int AS enabled "
            f"FROM ({owned_numbers_sql(None)}\n) o GROUP BY 1, 2 ORDER BY 1, 2")


# ---------------------------------------------------------------------------
# Shaping (pure)
# ---------------------------------------------------------------------------
def product_sort_key(product: str) -> tuple[int, str]:
    """PRECEDENCE order, then unknown (future) products by name."""
    try:
        return (PRECEDENCE.index(product), "")
    except ValueError:
        return (len(PRECEDENCE), product)


def ordered_by_product(counts: Mapping[str, Any]) -> dict[str, Any]:
    """A {product: value} dict in display order (PRECEDENCE, then by name)."""
    return {p: counts[p] for p in sorted(counts, key=product_sort_key)}


def shape_number(row: Mapping[str, Any]) -> dict[str, Any]:
    """An owned_numbers_sql row -> the customer-facing number row
    (TENANT_NUMBER_KEYS). `forwards_to` is non-null only for rcf."""
    return {
        "number": row["number"],
        "name": row["name"],
        "product": row["product"],
        "enabled": bool(row["enabled"]),
        "forwards_to": row["forwards_to"] if row["product"] == "rcf" else None,
    }


def numbers_count(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """count_by_product_sql rows -> {"total", "by_product"} (zero-count
    products omitted; api never present — HIDDEN_PRODUCTS is applied in SQL)."""
    by_product = {r["product"]: int(r["n"]) for r in rows if int(r["n"] or 0) > 0}
    return {"total": sum(by_product.values()), "by_product": ordered_by_product(by_product)}


def shape_owned_counts(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """owned_counts_sql rows -> the GET /numbers/owned body."""
    total = enabled = 0
    by_product: dict[str, dict[str, int]] = {}
    customers: dict[int, dict[str, Any]] = {}
    for r in rows:
        cid, product = int(r["customer_id"]), r["product"]
        n, on = int(r["total"]), int(r["enabled"])
        total += n
        enabled += on
        agg = by_product.setdefault(product, {"total": 0, "enabled": 0})
        agg["total"] += n
        agg["enabled"] += on
        cust = customers.setdefault(
            cid, {"customer_id": cid, "total": 0, "enabled": 0, "by_product": {}})
        cust["total"] += n
        cust["enabled"] += on
        cust["by_product"][product] = {"total": n, "enabled": on}
    for cust in customers.values():
        cust["by_product"] = ordered_by_product(cust["by_product"])
    return {
        "total": total,
        "enabled": enabled,
        "by_product": ordered_by_product(by_product),
        "customers": [customers[c] for c in sorted(customers)],
    }
