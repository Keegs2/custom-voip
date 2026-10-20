"""Voicemail retention worker (contract §4.7).

An asyncio task started from ``main.py``'s lifespan in EVERY uvicorn worker
process (4); a transaction-scoped PostgreSQL advisory lock
(``pg_try_advisory_xact_lock``, safe under PgBouncer transaction pooling —
a session lock would leak across pooled server connections) makes sure only
ONE process sweeps at a time. Every 15 min (first run 30-90 s after start,
jittered so the workers do not collide), in batches, it purges — object
delete FIRST, then row -> 'purged' with every crypto field nulled:

  messages   expired      status='stored' AND expires_at < now()
             trash        status='stored' AND deleted_at < now() - 30 days
             pending      status='pending' AND created_at < now() - 1 h
                          (and no live deposit lease)
             failed       status='failed' AND created_at < now() - 10 min
                          (grace: FreeSWITCH's retries take a failed row over
                          within ~1 min; the sweep never races them)
             mailbox_deleted  any non-purged row of a 'deleted' mailbox
             key_destroyed    any non-purged row of a crypto-erased customer
                          (covers a deposit that raced the erase)
  greetings  pending / failed / mailbox_deleted / key_destroyed (same rules)

Each batch runs in ONE transaction: ``SELECT ... FOR UPDATE SKIP LOCKED``
(so a concurrent restore/takeover can never interleave between the object
delete and the row update), object deletes, the guarded UPDATE and one
``retention_purge`` audit row per mailbox. A failed object delete leaves its
row for the next run (it is never marked purged without its object gone).

Needs NO KMS — only the object store and the database. Missing tables (54 not
applied), an unconfigured/unavailable object store or a DB outage are logged
and retried next interval; the task never raises out of its loop.
``voicemail_access_log`` is never modified.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
from typing import Any

from db import database as db

from .mailboxes import (
    _audit_purged,
    delete_objects,
    greeting_key_of,
    mark_purged,
    message_key_of,
)

logger = logging.getLogger(__name__)

INTERVAL_S = 15 * 60
INITIAL_DELAY_RANGE_S = (30.0, 90.0)
BATCH = 100
RUN_BUDGET_S = 300.0
TRASH_DAYS = 30
PENDING_MAX_AGE = "1 hour"
FAILED_GRACE = "10 minutes"
#: pg_try_advisory_xact_lock key ("vm_ret").
LOCK_KEY = 0x766D5F726574

_LEASE_LIVE = ("(m.status = 'pending' AND m.deposit_lease_until IS NOT NULL "
               "AND m.deposit_lease_until > now())")
_DELETED_BOXES = "(SELECT id FROM voicemail_boxes WHERE status = 'deleted')"
_ERASED_BOXES = ("(SELECT b.id FROM voicemail_boxes b JOIN voicemail_customer_keys k "
                 "ON k.customer_id = b.customer_id WHERE k.status = 'destroyed')")

#: (kind, arm, WHERE predicate over alias m / g)
ARMS: tuple[tuple[str, str, str], ...] = (
    ("message", "expired", "m.status = 'stored' AND m.expires_at < now()"),
    ("message", "trash",
     f"m.status = 'stored' AND m.deleted_at < now() - interval '{TRASH_DAYS} days'"),
    ("message", "pending",
     f"m.status = 'pending' AND m.created_at < now() - interval '{PENDING_MAX_AGE}' "
     f"AND NOT {_LEASE_LIVE}"),
    ("message", "failed",
     f"m.status = 'failed' AND m.created_at < now() - interval '{FAILED_GRACE}'"),
    ("message", "mailbox_deleted",
     f"m.status <> 'purged' AND NOT {_LEASE_LIVE} AND m.mailbox_id IN {_DELETED_BOXES}"),
    ("message", "key_destroyed",
     f"m.status <> 'purged' AND NOT {_LEASE_LIVE} AND m.mailbox_id IN {_ERASED_BOXES}"),
    ("greeting", "pending",
     f"m.status = 'pending' AND m.created_at < now() - interval '{PENDING_MAX_AGE}'"),
    ("greeting", "failed",
     f"m.status = 'failed' AND m.created_at < now() - interval '{FAILED_GRACE}'"),
    ("greeting", "mailbox_deleted", f"m.status <> 'purged' AND m.mailbox_id IN {_DELETED_BOXES}"),
    ("greeting", "key_destroyed", f"m.status <> 'purged' AND m.mailbox_id IN {_ERASED_BOXES}"),
)

_SELECT = {
    "message": ("SELECT m.id, m.msg_uuid, m.mailbox_id, m.customer_id, m.status "
                "FROM voicemail_messages m WHERE {pred} ORDER BY m.id LIMIT $1::int "
                "FOR UPDATE OF m SKIP LOCKED"),
    "greeting": ("SELECT m.id, m.greeting_uuid, m.mailbox_id, m.customer_id, m.status "
                 "FROM voicemail_greetings m WHERE {pred} ORDER BY m.id LIMIT $1::int "
                 "FOR UPDATE OF m SKIP LOCKED"),
}


def enabled() -> bool:
    return (os.getenv("VOICEMAIL_RETENTION_ENABLED") or "true").strip().lower() != "false"


async def _sweep_arm(pool: Any, kind: str, arm: str, pred: str, deadline: float,
                     counts: dict) -> bool:
    """Purge one arm in batches. Returns False when the object store is
    unavailable (the rest of the run is skipped: it would fail the same way).
    A row whose own delete keeps failing only ends THIS arm for this run (it
    sorts first, so retrying it in a loop would make no progress) — later
    arms still run."""
    loop = asyncio.get_running_loop()
    key_of = message_key_of if kind == "message" else greeting_key_of
    select_sql = _SELECT[kind].format(pred=pred)
    while loop.time() < deadline:
        async with pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(select_sql, BATCH)
                if not rows:
                    return True
                deleted = await delete_objects(
                    ((r["id"], key_of(r)) for r in rows),
                    budget_s=max(0.0, deadline - loop.time()))
                updated = await mark_purged(conn, kind, deleted.done)
                if updated:
                    await _audit_purged(conn, kind, updated, reason="retention", source="system",
                                        info=None)
        counts[f"{kind}:{arm}"] = counts.get(f"{kind}:{arm}", 0) + len(updated)
        if deleted.failed:
            counts["deferred"] = counts.get("deferred", 0) + deleted.failed
            return not deleted.store_down
        if len(rows) < BATCH:
            return True
    return True


async def sweep_once(*, budget_s: float = RUN_BUDGET_S) -> dict:
    """One sweep (if this process wins the advisory lock). Returns counts;
    ``{"skipped": reason}`` when it did not run. Never raises for DB/storage
    trouble (logged)."""
    pool = db.pool
    if pool is None:
        return {"skipped": "no database pool"}
    loop = asyncio.get_running_loop()
    deadline = loop.time() + budget_s
    counts: dict[str, int] = {}
    try:
        async with pool.acquire() as lock_conn:
            tx = lock_conn.transaction()
            await tx.start()
            try:
                if not await lock_conn.fetchval(
                        "SELECT pg_try_advisory_xact_lock($1::bigint)", LOCK_KEY):
                    return {"skipped": "another worker is sweeping"}
                if not await lock_conn.fetchval(
                        "SELECT to_regclass('public.voicemail_messages') IS NOT NULL"):
                    return {"skipped": "migration 54 not applied"}
                for kind, arm, pred in ARMS:
                    if loop.time() >= deadline:
                        break
                    if not await _sweep_arm(pool, kind, arm, pred, deadline, counts):
                        logger.warning("voicemail retention: object store unavailable — "
                                       "run cut short, retrying next interval")
                        break
            finally:
                await tx.rollback()  # releases the xact lock; nothing was written on it
    except Exception as exc:  # noqa: BLE001 — never kill the loop
        logger.error("voicemail retention sweep failed: %s: %s", type(exc).__name__, exc)
        counts["error"] = 1
        return counts
    purged = sum(v for k, v in counts.items() if ":" in k)
    if purged or counts.get("deferred"):
        logger.info("voicemail retention: purged %d rows %s", purged, counts)
    return counts


async def run_forever() -> None:
    """Lifespan task body: jittered first run, then every INTERVAL_S."""
    await asyncio.sleep(random.uniform(*INITIAL_DELAY_RANGE_S))
    while True:
        try:
            await sweep_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("voicemail retention: unexpected error")
        await asyncio.sleep(INTERVAL_S)
