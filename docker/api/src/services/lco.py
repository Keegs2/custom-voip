"""Least-Cost Outbound (LCO) decision engine.

Given a destination number, produce an ordered, cheapest-first list of candidate
carriers to try (with failover fallbacks), honoring per-customer carrier
allow/deny and quality (priority) overrides.

Two consumers, per the telephony CONTRACT:
  (a) FreeSWITCH's synchronous PG path reads the `lco_route` VIEW / `lco_decide()`
      SQL function directly (see docker/postgres/migrations/2026-07-01_lco_rate_deck.sql).
      That path is customer-agnostic (base LCO).
  (b) The call-origination API path calls `decide_lco_route()` here to get a
      customer-aware ordered list and stamp an `X-LCO-Route` header
      (`lco_header_value()`), so Kamailio/FS can steer to the chosen carrier.

Design: the ranking/selection logic is split into PURE functions
(`generate_candidate_prefixes`, `collapse_longest_prefix_per_carrier`,
`rank_lco_candidates`) that are unit-tested with zero infra. `decide_lco_route`
is the thin async wrapper that fetches from Postgres and calls them.
"""
import re
import logging
from typing import Optional

from db import database as db

logger = logging.getLogger(__name__)

# The header the origination path stamps so downstream (Kamailio/FS) can observe
# and honor the LCO decision.  Kept as a module constant so callers agree on it.
LCO_HEADER = "X-LCO-Route"

# Longest sane E.164 length; bounds candidate-prefix generation.
_MAX_E164_DIGITS = 15


# ---------------------------------------------------------------------------
# Pure helpers (no DB — unit-tested directly)
# ---------------------------------------------------------------------------

def digits_only(value: str) -> str:
    """Strip everything but digits (drops '+', spaces, punctuation)."""
    return re.sub(r"\D", "", value or "")


def generate_candidate_prefixes(destination: str, max_len: int = _MAX_E164_DIGITS) -> list[str]:
    """All left-substrings of the dialed digits, shortest→longest.

    e.g. '1800555' -> ['1','18','180','1800','18005','180055','1800555'].
    These are the candidate prefixes for an equality longest-match
    (`prefix = ANY(candidates)`), which is index-served (vs. a reverse-LIKE
    seq scan).  Bounded to `max_len` so a pathological input can't explode.
    """
    d = digits_only(destination)
    n = min(len(d), max_len)
    return [d[:i] for i in range(1, n + 1)]


def collapse_longest_prefix_per_carrier(rows: list[dict]) -> list[dict]:
    """Keep only each carrier's LONGEST-prefix (most specific) matching rate.

    `rows` are rate rows already filtered to prefixes that match the dialed
    number.  A carrier may match several prefixes (e.g. '1800' and '18005');
    only the most specific rate applies.
    """
    best: dict[int, dict] = {}
    for r in rows:
        cid = r["carrier_id"]
        cur = best.get(cid)
        if cur is None or len(str(r["prefix"])) > len(str(cur["prefix"])):
            best[cid] = r
    return list(best.values())


def rank_lco_candidates(
    candidates: list[dict],
    deny_carrier_ids: Optional[set] = None,
    allow_carrier_ids: Optional[set] = None,
    priority_overrides: Optional[dict] = None,
) -> list[dict]:
    """Filter by per-customer policy and order cheapest-first.

    Ordering key: (priority ASC, cost_per_min ASC, carrier_id ASC).
      - Equal priorities (the default) ⇒ pure cheapest-first.
      - A lower priority (deck priority OR a per-customer override) pins a
        preferred/quality carrier ahead of cheaper ones — "quality overrides".

    Policy:
      - deny always excludes a carrier.
      - if `allow_carrier_ids` is a non-empty set, selection is restricted to it
        (whitelist); pass None for "no whitelist / all allowed".
    Returns NEW dicts (does not mutate inputs); each carries the effective
    `priority` actually used for ranking.
    """
    deny = set(deny_carrier_ids or ())
    allow = set(allow_carrier_ids) if allow_carrier_ids else None
    overrides = priority_overrides or {}

    ranked: list[dict] = []
    for c in candidates:
        cid = c["carrier_id"]
        if cid in deny:
            continue
        if allow is not None and cid not in allow:
            continue
        eff_priority = overrides.get(cid, c.get("priority", 100))
        out = dict(c)
        out["priority"] = eff_priority
        ranked.append(out)

    ranked.sort(key=lambda c: (
        c.get("priority", 100),
        float(c.get("cost_per_min") or 0),
        c["carrier_id"],
    ))
    return ranked


def lco_header_value(routes: list[dict]) -> Optional[str]:
    """Build the `X-LCO-Route` header value from the ranked routes.

    Format: "<x_carrier_value>;pop=<pop_ip>;rate=<cost_per_min>;n=<count>"
    (primary route + how many fallbacks are available). Returns None when there
    is no route (caller then omits the header and falls back to default routing).
    """
    if not routes:
        return None
    top = routes[0]
    rate = top.get("cost_per_min")
    try:
        rate_s = f"{float(rate):.6f}" if rate is not None else "na"
    except (TypeError, ValueError):
        rate_s = "na"
    return (
        f"{top.get('x_carrier_value') or top.get('carrier_id')}"
        f";pop={top.get('pop_ip') or ''}"
        f";rate={rate_s}"
        f";n={len(routes)}"
    )


# ---------------------------------------------------------------------------
# DB-backed decision (async)
# ---------------------------------------------------------------------------

async def load_customer_policy(customer_id: int) -> tuple[set, Optional[set], dict]:
    """Return (deny_ids, allow_ids_or_None, priority_overrides) for a customer."""
    rows = await db.fetch_all(
        "SELECT carrier_id, mode, priority_override "
        "FROM customer_carrier_policy WHERE customer_id = $1",
        customer_id,
    )
    deny = {r["carrier_id"] for r in rows if r["mode"] == "deny"}
    allow_list = [r["carrier_id"] for r in rows if r["mode"] == "allow"]
    allow = set(allow_list) if allow_list else None
    overrides = {
        r["carrier_id"]: r["priority_override"]
        for r in rows if r["priority_override"] is not None
    }
    return deny, allow, overrides


async def decide_lco_route(destination: str, customer_id: Optional[int] = None) -> list[dict]:
    """Cheapest-first ordered carrier list for a destination.

    Reads the `lco_route` contract view with an index-served equality longest
    match, collapses to each carrier's most-specific rate, then applies the
    customer's allow/deny + quality overrides and ranks.

    Returns a list of dicts:
      {carrier_id, x_carrier_value, pop_ip, cost_per_min, priority, prefix}
    ordered best-first (index 0 = the carrier to try first).  Empty list when no
    rate deck covers the destination (caller falls back to default routing).
    """
    candidates_prefixes = generate_candidate_prefixes(destination)
    if not candidates_prefixes:
        return []

    rows = await db.fetch_all(
        """
        SELECT carrier_id, x_carrier_value, pop_ip, priority, cost_per_min, prefix
          FROM lco_route
         WHERE prefix = ANY($1::text[])
        """,
        candidates_prefixes,
    )
    if not rows:
        return []

    per_carrier = collapse_longest_prefix_per_carrier([dict(r) for r in rows])

    deny: set = set()
    allow: Optional[set] = None
    overrides: dict = {}
    if customer_id is not None:
        try:
            deny, allow, overrides = await load_customer_policy(customer_id)
        except Exception:
            # Fail-open on policy read errors: better to route (base LCO) than to
            # drop the call. Logged for visibility.
            logger.warning("LCO policy read failed for customer %s; using base LCO",
                           customer_id, exc_info=True)

    return rank_lco_candidates(per_carrier, deny, allow, overrides)
