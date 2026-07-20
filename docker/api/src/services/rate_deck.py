"""Carrier rate-deck management helpers (parsing + bulk load).

Separated from routers/lco.py so the CSV parsing is a PURE function (unit-tested
with zero infra) and the batched DB upsert is reusable.

CSV row shape (header optional, order-flexible when a header is present):
    prefix,cost_per_min[,jurisdiction][,priority][,description]

Examples:
    1800,0.0090
    1,0.0125,interstate,50,US Interstate
    44,0.0200,intl,,United Kingdom
"""
import csv
import io
import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)

_VALID_JURISDICTIONS = ("interstate", "intrastate", "intl", "default")
_KNOWN_HEADERS = {"prefix", "cost_per_min", "jurisdiction", "priority", "description"}


def normalize_prefix(raw: str) -> str:
    """Strip a rate-deck prefix to bare digits (drop '+', spaces, punctuation)."""
    return re.sub(r"\D", "", (raw or "").strip())


def parse_rate_csv(text: str) -> tuple[list[dict], list[dict]]:
    """Parse CSV rate-deck text into (records, errors) — PURE, no DB.

    Returns:
      records: list of {prefix, cost_per_min, jurisdiction, priority, description}
               already normalized/validated and de-duplicated on
               (prefix, jurisdiction) with the LAST occurrence winning.
      errors:  list of {line, value, error} (capped sample) for bad rows.

    Robust to an optional header line, blank lines, and '#'/'//' comments. A
    malformed row is skipped and recorded — one bad line never fails the batch.
    """
    records: dict[tuple, dict] = {}
    errors: list[dict] = []

    if not text or not text.strip():
        return [], []

    lines = text.splitlines()

    # Detect + consume a header line if the first non-comment line looks like one.
    start_idx = 0
    header: Optional[list[str]] = None
    for i, line in enumerate(lines):
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("//"):
            continue
        first = [c.strip().lower() for c in next(csv.reader([line]))]
        if set(first) & _KNOWN_HEADERS and not _looks_numeric(first):
            header = first
            start_idx = i + 1
        else:
            start_idx = i
        break

    col = {name: idx for idx, name in enumerate(header)} if header else None

    for lineno, line in enumerate(lines[start_idx:], start=start_idx + 1):
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("//"):
            continue
        try:
            fields = next(csv.reader([line]))
        except Exception:
            _append_error(errors, lineno, line, "unparseable CSV row")
            continue

        try:
            rec = _row_to_record(fields, col)
        except ValueError as exc:
            _append_error(errors, lineno, line, str(exc))
            continue

        records[(rec["prefix"], rec["jurisdiction"])] = rec

    return list(records.values()), errors


def _looks_numeric(fields: list[str]) -> bool:
    """True if the 2nd field parses as a float (so it's data, not a header)."""
    if len(fields) < 2:
        return False
    try:
        float(fields[1])
        return True
    except (TypeError, ValueError):
        return False


def _row_to_record(fields: list[str], col: Optional[dict]) -> dict:
    """Map one CSV field list to a normalized rate-deck record. Raises ValueError."""
    def get(name: str, pos: int) -> str:
        if col is not None and name in col and col[name] < len(fields):
            return fields[col[name]].strip()
        if col is None and pos < len(fields):
            return fields[pos].strip()
        return ""

    prefix = normalize_prefix(get("prefix", 0))
    if not prefix:
        raise ValueError("missing/empty prefix")

    cost_raw = get("cost_per_min", 1)
    try:
        cost = float(cost_raw)
    except (TypeError, ValueError):
        raise ValueError(f"invalid cost_per_min {cost_raw!r}")
    if cost < 0:
        raise ValueError("cost_per_min must be non-negative")

    jurisdiction = (get("jurisdiction", 2) or "default").lower()
    if jurisdiction not in _VALID_JURISDICTIONS:
        raise ValueError(f"invalid jurisdiction {jurisdiction!r}")

    priority_raw = get("priority", 3)
    if priority_raw:
        try:
            priority = int(priority_raw)
        except (TypeError, ValueError):
            raise ValueError(f"invalid priority {priority_raw!r}")
    else:
        priority = 100

    description = get("description", 4) or None

    return {
        "prefix": prefix,
        "cost_per_min": cost,
        "jurisdiction": jurisdiction,
        "priority": priority,
        "description": description,
    }


def _append_error(errors: list[dict], lineno: int, line: str, msg: str, cap: int = 50):
    if len(errors) < cap:
        errors.append({"line": lineno, "value": line.strip()[:64], "error": msg})


def records_to_csv(rows: list[dict]) -> str:
    """Serialize rate rows back to CSV (used for round-trip / export)."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["prefix", "cost_per_min", "jurisdiction", "priority", "description"])
    for r in rows:
        w.writerow([
            r.get("prefix", ""),
            r.get("cost_per_min", ""),
            r.get("jurisdiction", "default"),
            r.get("priority", 100),
            r.get("description", "") or "",
        ])
    return buf.getvalue()


# ---------------------------------------------------------------------------
# DB-backed batched bulk upsert (async). Kept out of the pure section.
# ---------------------------------------------------------------------------

async def bulk_upsert_rate_deck(conn, carrier_id: int, records: list[dict],
                                effective_date) -> dict:
    """Batched, idempotent upsert of rate rows for one carrier + effective_date.

    Uses executemany with ON CONFLICT on the natural key
    (carrier_id, prefix, jurisdiction, effective_date) so re-running the same
    deck updates in place (never duplicates). `conn` is an asyncpg connection
    already inside a transaction. Returns {processed}.
    Explicit ::type casts on every bound param for asyncpg/PgBouncer.
    """
    if not records:
        return {"processed": 0}

    args = [
        (
            carrier_id,
            r["prefix"],
            r["description"],
            r["cost_per_min"],
            r["jurisdiction"],
            r["priority"],
            effective_date,
        )
        for r in records
    ]

    await conn.executemany(
        """
        INSERT INTO carrier_rate_decks
            (carrier_id, prefix, description, cost_per_min, jurisdiction, priority, effective_date)
        VALUES ($1::int, $2::varchar, $3::varchar, $4::numeric, $5::varchar, $6::int, $7::timestamptz)
        ON CONFLICT (carrier_id, prefix, jurisdiction, effective_date) DO UPDATE
           SET cost_per_min = EXCLUDED.cost_per_min,
               priority     = EXCLUDED.priority,
               description  = EXCLUDED.description,
               enabled      = true,
               updated_at   = NOW()
        """,
        args,
    )
    return {"processed": len(records)}
