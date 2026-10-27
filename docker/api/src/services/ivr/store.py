"""IVR SQL + row shaping shared by routers/ivr.py and number_inventory.py.

Every statement binds its values with explicit ``::type`` casts (PgBouncer
transaction pooling, ``statement_cache_size=0``). JSONB arrives as text (no
asyncpg codec is registered) and is decoded here.
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable, Optional

import asyncpg
from fastapi import HTTPException

from services import customer_numbers as cn
from services.ivr.compiler import CompileContext, OwnNumber, PromptRef
from utils.phone import normalize_e164

#: pg_advisory_xact_lock(IVR_LOCK_CLASS, customer_id): serializes a customer's
#: prompt create/delete (limits, audio GC) with its publishes.
IVR_LOCK_CLASS = 5901

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

MSG_NUMBER_UNAVAILABLE = "That number isn't available to assign."
MSG_NUMBER_IN_USE = "That number is already in use by another product."
MSG_CUSTOMER_NOT_FOUND = "Customer not found."


def loads(value: Any) -> Any:
    """JSONB column -> Python (asyncpg hands JSONB over as text)."""
    if isinstance(value, (str, bytes, bytearray)):
        return json.loads(value)
    return value


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def clean_name(value: Any, *, field: str = "Name", required: bool = True,
               max_chars: int = 100) -> Optional[str]:
    """A customer-entered display name: trimmed, 1..max chars, no control
    characters. Only ever stored and shown back — never put in a plan."""
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise HTTPException(status_code=422, detail=f"{field} is required.")
        return None
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail=f"{field} must be text.")
    name = " ".join(value.split())
    if _CONTROL.search(name) or len(name) > max_chars:
        raise HTTPException(status_code=422,
                            detail=f"{field} must be at most {max_chars} characters.")
    return name


# ---------------------------------------------------------------------------
# Shapes (contract §8.2)
# ---------------------------------------------------------------------------
NUMBER_SELECT = """
SELECT n.id, n.did, n.name, n.flow_id, f.name AS flow_name, n.enabled, n.max_channels,
       n.customer_id, (f.published_version_id IS NOT NULL) AS published
  FROM ivr_numbers n
  LEFT JOIN call_flows f ON f.id = n.flow_id
"""
NUMBER_FIELDS = ("id", "did", "name", "flow_id", "flow_name", "enabled", "max_channels",
                 "published")

FLOW_SUMMARY_SELECT = """
SELECT f.id, f.name, f.revision, v.version AS published_version, v.published_at, f.updated_at,
       f.customer_id,
       COALESCE((SELECT array_agg(n.did ORDER BY n.did) FROM ivr_numbers n
                  WHERE n.flow_id = f.id), ARRAY[]::varchar[]) AS numbers
  FROM call_flows f
  LEFT JOIN call_flow_versions v ON v.id = f.published_version_id
"""
FLOW_SUMMARY_FIELDS = ("id", "name", "revision", "published_version", "published_at",
                       "updated_at", "numbers")

PROMPT_SELECT = """
SELECT p.id, p.name, p.kind, p.tts_text, p.tts_voice, p.duration_ms, p.bytes, p.created_at,
       p.sha256, p.customer_id
  FROM ivr_prompts p
"""


def number_out(row: Any) -> dict:
    out = {k: row[k] for k in NUMBER_FIELDS}
    out["published"] = bool(out["published"])
    return out


def flow_summary_out(row: Any) -> dict:
    out = {k: row[k] for k in FLOW_SUMMARY_FIELDS}
    out["numbers"] = list(out["numbers"] or [])
    return out


def prompt_out(row: Any) -> dict:
    out = {"id": row["id"], "name": row["name"], "kind": row["kind"],
           "duration_ms": row["duration_ms"], "bytes": row["bytes"],
           "created_at": row["created_at"]}
    if row["kind"] == "tts":
        out["tts_text"] = row["tts_text"]
        out["tts_voice"] = row["tts_voice"]
    return out


async def list_numbers(conn: Any, customer_id: int) -> list[dict]:
    rows = await conn.fetch(NUMBER_SELECT + " WHERE n.customer_id = $1::int ORDER BY n.did",
                            customer_id)
    return [number_out(r) for r in rows]


async def list_flows(conn: Any, customer_id: int) -> list[dict]:
    rows = await conn.fetch(FLOW_SUMMARY_SELECT + " WHERE f.customer_id = $1::int "
                            "ORDER BY f.name, f.id", customer_id)
    return [flow_summary_out(r) for r in rows]


# ---------------------------------------------------------------------------
# Admin all-customers overview (GET /admin/overview) — one read-only query
# ---------------------------------------------------------------------------
#: One row per customer that is entitled (customers.ivr_enabled) OR has at
#: least one flow, sorted by name case-insensitively (then id). Per customer:
#:   flows_total       call_flows rows.
#:   flows_published   flows with a live published version
#:                     (published_version_id set — the same test as
#:                     IvrNumber.published; publish is its only writer and
#:                     nothing unpublishes).
#:   numbers_bound     ivr_numbers rows bound to a flow (flow_id set),
#:                     whatever the number's / flow's / entitlement state.
#:   last_published_at newest published_at of the customer's LIVE versions =
#:                     its most recent publish (publish always flips the flow
#:                     to the version it just inserted; a deleted flow's
#:                     versions go with it). NULL = never published.
#: Each aggregate is one GROUP BY pass (call_flows + the live version by PK;
#: ivr_numbers via idx_ivr_numbers_flow's predicate), then hash-joined.
ADMIN_OVERVIEW_SQL = """
WITH fl AS (
    SELECT f.customer_id,
           count(*)::int                      AS flows_total,
           count(f.published_version_id)::int AS flows_published,
           max(v.published_at)                AS last_published_at
      FROM call_flows f
      LEFT JOIN call_flow_versions v ON v.id = f.published_version_id
     GROUP BY f.customer_id
),
nb AS (
    SELECT n.customer_id, count(*)::int AS numbers_bound
      FROM ivr_numbers n
     WHERE n.flow_id IS NOT NULL
     GROUP BY n.customer_id
)
SELECT c.id AS customer_id, c.name, c.status, c.ivr_enabled,
       COALESCE(fl.flows_total, 0)     AS flows_total,
       COALESCE(fl.flows_published, 0) AS flows_published,
       COALESCE(nb.numbers_bound, 0)   AS numbers_bound,
       fl.last_published_at
  FROM customers c
  LEFT JOIN fl ON fl.customer_id = c.id
  LEFT JOIN nb ON nb.customer_id = c.id
 WHERE c.ivr_enabled OR fl.customer_id IS NOT NULL
 ORDER BY lower(c.name), c.id
"""


def admin_overview_out(row: Any) -> dict:
    published = row["last_published_at"]
    return {
        "customer_id": row["customer_id"],
        "name": row["name"],
        "status": row["status"],
        "ivr_enabled": bool(row["ivr_enabled"]),
        "flows_total": row["flows_total"],
        "flows_published": row["flows_published"],
        "numbers_bound": row["numbers_bound"],
        "last_published_at": published.isoformat() if published is not None else None,
    }


async def admin_overview(conn: Any) -> list[dict]:
    return [admin_overview_out(r) for r in await conn.fetch(ADMIN_OVERVIEW_SQL)]


# ---------------------------------------------------------------------------
# Compile context (prompts + current numbers + this flow's own numbers)
# ---------------------------------------------------------------------------
async def load_context(conn: Any, *, customer_id: int, flow_id: int,
                       version: int) -> CompileContext:
    prompts = await conn.fetch(
        "SELECT id, name, sha256 FROM ivr_prompts "
        "WHERE customer_id = $1::int AND deleted_at IS NULL", customer_id)
    numbers = await conn.fetch(cn.owned_numbers_sql("$1::int"), customer_id)
    own = await conn.fetch("SELECT did FROM ivr_numbers WHERE flow_id = $1::bigint", flow_id)
    return CompileContext(
        customer_id=customer_id, flow_id=flow_id, version=version,
        prompts={r["id"]: PromptRef(r["sha256"].strip(), r["name"]) for r in prompts},
        numbers={r["number"]: OwnNumber(r["number"], r["product"], r["name"],
                                        bool(r["enabled"])) for r in numbers},
        self_dids=frozenset(r["did"] for r in own))


def prompt_ids_in_graph(graph: Any) -> set[int]:
    """Every prompt id a draft graph references (any block, any prompt list)."""
    found: set[int] = set()
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        return found
    for node in graph["nodes"]:
        data = node.get("data") if isinstance(node, dict) else None
        cfg = data.get("config") if isinstance(data, dict) else None
        if not isinstance(cfg, dict):
            continue
        for key in ("prompts", "invalidPrompts", "noInputPrompts"):
            items = cfg.get(key)
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, int) and not isinstance(item, bool):
                        found.add(item)
                    elif isinstance(item, str) and item.isascii() and item.isdigit():
                        found.add(int(item))
    return found


def own_transfer_dids(plan: Any) -> set[str]:
    """DIDs a plan transfers to (own targets) — for the self-transfer check."""
    out: set[str] = set()
    nodes = plan.get("nodes", {}) if isinstance(plan, dict) else {}
    for node in nodes.values():
        if node.get("t") == "transfer" and node.get("dest", {}).get("kind") == "own":
            out.add(node["dest"]["did"])
    return out


# ---------------------------------------------------------------------------
# Number inventory: assign / unassign (routers/number_inventory.py)
# ---------------------------------------------------------------------------
async def ivr_schema_present(conn: Any) -> bool:
    return bool(await conn.fetchval("SELECT to_regclass('public.ivr_numbers') IS NOT NULL"))


async def assign_number(pool: Any, *, customer_id: int, did: str, name: Optional[str],
                        actor_user_id: Optional[int], notes: Optional[str],
                        allowed_statuses: Iterable[str] = ("available", "reserved")) -> int:
    """Claim ``did`` as an IVR number of ``customer_id`` (contract §8.3).

    One transaction: the did_inventory row is locked and must be in
    ``allowed_statuses``; the DID must not be routed by any product yet
    (number_routing — the same drift guard as voicemail); then the
    ivr_numbers row, the inventory assignment and customers.ivr_enabled=true
    (if it was false — the voicemail side-effect rule). Returns the new
    ivr_numbers.id. Raises HTTPException 409 / 422.
    """
    e164 = normalize_e164(did)
    clean = clean_name(name, field="Name", required=False)
    async with pool.acquire() as conn:
        try:
            async with conn.transaction():
                inv = await conn.fetchrow(
                    "SELECT status FROM did_inventory WHERE did = $1::varchar FOR UPDATE", e164)
                if inv is None or inv["status"] not in tuple(allowed_statuses):
                    raise HTTPException(status_code=409, detail=MSG_NUMBER_UNAVAILABLE)
                if await conn.fetchval(
                        "SELECT 1 FROM number_routing WHERE did = $1::varchar LIMIT 1", e164):
                    raise HTTPException(status_code=409, detail=MSG_NUMBER_IN_USE)
                number_id = await conn.fetchval(
                    "INSERT INTO ivr_numbers (customer_id, did, name) "
                    "VALUES ($1::int, $2::varchar, $3::varchar) RETURNING id",
                    customer_id, e164, clean)
                await conn.execute(
                    """
                    UPDATE did_inventory
                       SET customer_id = $1::int, product_type = 'ivr',
                           product_ref_id = $2::int, status = 'assigned',
                           assigned_at = now(),
                           assigned_by = (SELECT id FROM users WHERE id = $3::int),
                           notes = $4::text, updated_at = now()
                     WHERE did = $5::varchar
                    """,
                    customer_id, number_id, actor_user_id, notes, e164)
                await conn.execute(
                    "UPDATE customers SET ivr_enabled = true "
                    "WHERE id = $1::int AND NOT ivr_enabled", customer_id)
        except asyncpg.UniqueViolationError:
            raise HTTPException(status_code=409, detail=MSG_NUMBER_IN_USE)
        except asyncpg.CheckViolationError:
            raise HTTPException(status_code=422, detail="That isn't a valid phone number.")
    return int(number_id)
