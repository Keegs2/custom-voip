"""Core CDR export logic: select unexported CDRs, build a file, ship it, mark them.

Reuses the shared asyncpg pool (db.database) with statement_cache_size=0 and
explicit ::type casts on every parameter (asyncpg + PgBouncer transaction mode).

DELIVERY SEMANTICS — AT LEAST ONCE:
    The FTP upload happens BETWEEN two short DB operations (select, then mark);
    no DB transaction is held open across the upload. If the process crashes
    after a successful upload but before marking the rows exported, the same
    rows are selected again on the next run and re-sent. Downstream MUST dedup
    on the CDR ``uuid`` (call_id) — it is globally unique. We prefer a possible
    duplicate file over a silently-dropped CDR (this is billing data).

SINGLE-INSTANCE GUARD:
    send_batch() takes a TTL-based lease row in ``cdr_export_lock`` (claim and
    release are each a single autocommit UPDATE) so two runners (e.g. the
    run-loop container plus a manual run-once) can never double-send. A
    *session*-level advisory lock is NOT usable here: this app reaches Postgres
    through PgBouncer in transaction pooling mode, where each autocommit
    statement may land on a different backing server connection — so a session
    lock is neither reliably held across the cycle nor safely released (it can
    leak onto a pooled connection and wedge future cycles). The lease is claimed
    only when unheld/expired; if it is held, the run bails with a log line. The
    lease TTL (cfg.lock_ttl_seconds) means a crashed runner auto-recovers once
    the lease expires, and release only clears our own lease (WHERE locked_by).
"""
from __future__ import annotations

import os
import socket
import uuid as uuid_mod
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Sequence

import asyncpg

from db import database as db
from .config import ExportConfig
from .formatter import EquinoxFormatter

logger = logging.getLogger(__name__)

# Line terminator for generated files. CRLF is the safe default for
# carrier/EDI-style ingesters (e.g. Equinox). Configurable later if needed.
LINE_TERMINATOR = "\r\n"

# Columns pulled for export — the COMPLETE set of data columns on the `cdrs`
# table (every column EXCEPT the `exported_at` watermark, which is NULL at
# export time and is the selection cursor). We export all information we store
# per CDR; downstream consumes what it needs. This list is the contract between
# the SELECT and the formatter's source keys (formatter._FIELD_DEFS) — the
# drift-guard test (tests/test_cdr_export.py) fails loudly if a future
# ADD COLUMN on cdrs isn't wired in here.
#
# Order = base-table declaration order (05_schema_cdr.sql) followed by the
# ADD COLUMN migrations in file-number order: 18 (sbc_id), 23 (on-net columns).
# `id` and `start_time` are also required by the watermark/meta (BatchMeta).
SELECT_COLUMNS: tuple[str, ...] = (
    # --- base table (05_schema_cdr.sql), in declaration order ---
    "id",
    "uuid",
    "customer_id",
    "product_type",
    "trunk_id",
    "direction",
    "caller_id",
    "destination",
    "destination_prefix",
    "start_time",
    "answer_time",
    "end_time",
    "duration_ms",
    "billable_ms",
    "rate_per_min",
    "total_cost",
    "carrier_cost",
    "margin",
    "rated_at",
    "hangup_cause",
    "sip_code",
    "carrier_used",
    "traffic_grade",
    "fraud_score",
    "fraud_flags",
    "freeswitch_node",
    "mos",
    "quality_pct",
    "jitter_min_ms",
    "jitter_max_ms",
    "jitter_avg_ms",
    "packet_loss_count",
    "packet_total_count",
    "packet_loss_pct",
    "flaw_total",
    "r_factor",
    "rtp_audio_in_raw_bytes",
    "rtp_audio_in_media_bytes",
    "rtp_audio_out_raw_bytes",
    "rtp_audio_out_media_bytes",
    "rtp_audio_in_packet_count",
    "rtp_audio_out_packet_count",
    "rtp_audio_in_jitter_burst_rate",
    "rtp_audio_in_jitter_loss_rate",
    "rtp_audio_in_mean_interval",
    "read_codec",
    "write_codec",
    "read_rate",
    "write_rate",
    "sip_from_user",
    "sip_to_user",
    "hangup_cause_q850",
    "sip_hangup_disposition",
    "sip_user_agent",
    "network_addr",
    "bridge_uuid",
    # --- 18_sbc_id_column.sql ---
    "sbc_id",
    # --- 23_onnet_cdr_columns.sql ---
    "origin_customer_id",
    "terminating_customer_id",
    "on_net",
    "on_net_hops",
)


@dataclass
class BatchMeta:
    """Metadata about a built export file (for the audit log + logging)."""
    row_count: int = 0
    byte_size: int = 0
    min_id: Optional[int] = None
    max_id: Optional[int] = None
    min_start_time: Optional[datetime] = None
    max_start_time: Optional[datetime] = None
    ids: list[int] = field(default_factory=list)


@dataclass
class SendResult:
    """Outcome of a send_batch() cycle."""
    status: str                       # 'sent' | 'nothing_to_do' | 'skipped' | 'locked' | 'failed'
    row_count: int = 0
    filename: Optional[str] = None
    log_id: Optional[int] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Batch selection
# ---------------------------------------------------------------------------

async def select_batch(pool: asyncpg.Pool, cfg: ExportConfig) -> list[asyncpg.Record]:
    """Select up to batch_size unexported, settled CDRs, oldest first.

    "Settled" = end_time older than the lag window, so in-flight ingests have
    landed. ORDER BY (start_time, id) matches idx_cdrs_unexported for a cheap
    scan. Every parameter carries an explicit ::type cast for asyncpg/PgBouncer.
    """
    cols = ", ".join(SELECT_COLUMNS)
    query = f"""
        SELECT {cols}
        FROM cdrs
        WHERE exported_at IS NULL
          AND end_time < (now() - (($1::int)::text || ' seconds')::interval)
        ORDER BY start_time, id
        LIMIT $2::int
    """
    async with pool.acquire() as conn:
        return await conn.fetch(query, cfg.lag_seconds, cfg.batch_size)


# ---------------------------------------------------------------------------
# Filename + file building
# ---------------------------------------------------------------------------

def build_filename(cfg: ExportConfig, when: Optional[datetime] = None,
                   suffix: Optional[str] = None) -> str:
    """Build a collision-resistant filename: {prefix}{timestamp}_{suffix}{ext}.

    The short suffix (uuid4 hex fragment by default) prevents collisions when
    two files are produced within the same timestamp resolution second.
    """
    when = when or datetime.now(timezone.utc)
    ts = when.strftime(cfg.filename_ts_format)
    if suffix is None:
        suffix = uuid_mod.uuid4().hex[:8]
    return f"{cfg.filename_prefix}{ts}_{suffix}{cfg.filename_ext}"


def build_file(rows: Sequence[asyncpg.Record], cfg: ExportConfig,
               when: Optional[datetime] = None) -> tuple[str, bytes, BatchMeta]:
    """Render ``rows`` into (filename, data_bytes, meta).

    Pure aside from the timestamp/uuid in the filename. Uses the isolated
    EquinoxFormatter for header/records/trailer. Encodes UTF-8. Computes meta
    (row_count, min/max id, min/max start_time, byte_size, ids list) for the
    audit log and the post-upload watermark UPDATE.
    """
    formatter = EquinoxFormatter(delimiter=cfg.delimiter, quote_all=cfg.quote_all)

    lines: list[str] = []
    header = formatter.header()
    if header is not None:
        lines.append(header)

    ids: list[int] = []
    min_id = max_id = None
    min_ts = max_ts = None

    for row in rows:
        lines.append(formatter.format_record(row))
        rid = row["id"]
        ids.append(rid)
        if min_id is None or rid < min_id:
            min_id = rid
        if max_id is None or rid > max_id:
            max_id = rid
        st = row["start_time"]
        if st is not None:
            if min_ts is None or st < min_ts:
                min_ts = st
            if max_ts is None or st > max_ts:
                max_ts = st

    trailer = formatter.trailer(len(rows))
    if trailer is not None:
        lines.append(trailer)

    # Trailing terminator after the last line too, so every record line
    # (including the last) is newline-delimited.
    text = LINE_TERMINATOR.join(lines)
    if lines:
        text += LINE_TERMINATOR
    data = text.encode("utf-8")

    meta = BatchMeta(
        row_count=len(rows),
        byte_size=len(data),
        min_id=min_id,
        max_id=max_id,
        min_start_time=min_ts,
        max_start_time=max_ts,
        ids=ids,
    )
    filename = build_filename(cfg, when=when)
    return filename, data, meta


# ---------------------------------------------------------------------------
# Audit-log helpers (each is a short, independent DB op — NO long-held txn)
# ---------------------------------------------------------------------------

async def _insert_export_log(pool: asyncpg.Pool, filename: str, meta: BatchMeta) -> int:
    """Insert a 'pending' cdr_export_log row and return its id."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO cdr_export_log (
                filename, sequence, row_count, byte_size,
                min_id, max_id, min_start_time, max_start_time, status
            )
            VALUES (
                $1::text, $2::bigint, $3::int, $4::int,
                $5::bigint, $6::bigint, $7::timestamptz, $8::timestamptz, 'pending'
            )
            RETURNING id
            """,
            filename,
            meta.max_id,          # sequence watermark := highest id in the file
            meta.row_count,
            meta.byte_size,
            meta.min_id,
            meta.max_id,
            meta.min_start_time,
            meta.max_start_time,
        )
        return row["id"]


async def _mark_rows_exported(pool: asyncpg.Pool, ids: Sequence[int]) -> None:
    """Watermark the shipped CDRs: exported_at = now() WHERE id = ANY(...).

    id is a globally-unique BIGSERIAL, so matching on id alone is unambiguous
    even though the PK is composite (id, start_time).
    """
    if not ids:
        return
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE cdrs SET exported_at = now() WHERE id = ANY($1::bigint[])",
            list(ids),
        )


async def _mark_log_sent(pool: asyncpg.Pool, log_id: int) -> None:
    """Flip the audit-log row to 'sent' with sent_at = now()."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE cdr_export_log SET status = 'sent', sent_at = now() "
            "WHERE id = $1::bigint",
            log_id,
        )


async def _mark_log_failed(pool: asyncpg.Pool, log_id: int, error: str) -> None:
    """Flip the audit-log row to 'failed' and record a (truncated) error."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE cdr_export_log SET status = 'failed', error = $2::text "
            "WHERE id = $1::bigint",
            log_id,
            str(error)[:2000],
        )


# ---------------------------------------------------------------------------
# Single-instance lease (PgBouncer-transaction-mode safe — each op is ONE
# autocommit UPDATE; replaces the session-level advisory lock)
# ---------------------------------------------------------------------------

async def _claim_lease(pool, cfg, owner: str) -> bool:
    """Claim the exporter lease (single autocommit UPDATE). True iff we won it.

    The UPDATE only matches when the lease is unheld or expired, so exactly one
    runner claims it; the loser gets no row back. Safe through PgBouncer
    transaction pooling because it is a single statement (no session state).
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE cdr_export_lock
               SET locked_until = now() + make_interval(secs => $1::int),
                   locked_by = $2::text
             WHERE id = 1
               AND (locked_until IS NULL OR locked_until < now())
            RETURNING id
            """,
            cfg.lock_ttl_seconds, owner,
        )
        return row is not None


async def _release_lease(pool, owner: str) -> None:
    """Release our own lease (single autocommit UPDATE).

    WHERE locked_by = owner ensures we only clear a lease we hold — never one a
    successor claimed after our TTL expired. If we crash before releasing, the
    TTL reclaims it.
    """
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE cdr_export_lock SET locked_until = NULL, locked_by = NULL "
            "WHERE id = 1 AND locked_by = $1::text",
            owner,
        )


# ---------------------------------------------------------------------------
# The full send cycle
# ---------------------------------------------------------------------------

async def send_batch(pool: asyncpg.Pool, cfg: ExportConfig, ftp_client=None) -> SendResult:
    """Run one export cycle: lease → select → build → log → upload → mark.

    Steps (see module docstring for at-least-once + single-instance rationale):
      1. Claim the export lease (bail 'locked' if another runner holds it).
      2. select_batch(); if empty and skip_empty → 'nothing_to_do'.
      3. build_file().
      4. INSERT cdr_export_log (status 'pending').
      5. FTP upload_bytes().
         - success → mark rows exported + log 'sent' → 'sent'.
         - failure → log 'failed' (rows LEFT unexported → retry next run) → 'failed'.
      6. Always release the lease (finally); a crash lets the TTL reclaim it.

    ``ftp_client`` is injectable for testing; defaults to a real FTPClient.
    The blocking FTP upload is run via asyncio.to_thread so the event loop is
    not blocked.
    """
    # Lazy imports so this module stays import-safe (no ftplib/socket at import)
    import asyncio
    from .ftp_client import FTPClient

    if ftp_client is None:
        ftp_client = FTPClient(cfg)

    owner = f"{socket.gethostname()}:{os.getpid()}"
    if not await _claim_lease(pool, cfg, owner):
        logger.warning("cdr_export: export lease held by another runner — skipping this cycle")
        return SendResult(status="locked")
    try:
        # --- select ------------------------------------------------------
        rows = await select_batch(pool, cfg)
        if not rows:
            if cfg.skip_empty:
                logger.info("cdr_export: no unexported CDRs settled past lag — nothing to do")
                return SendResult(status="nothing_to_do", row_count=0)
            logger.info("cdr_export: no rows, but skip_empty is False — building empty file")

        # --- build -------------------------------------------------------
        filename, data, meta = build_file(rows, cfg)
        logger.info(
            "cdr_export: built %s — %d rows, %d bytes, id range [%s..%s]",
            filename, meta.row_count, meta.byte_size, meta.min_id, meta.max_id,
        )

        # --- audit log (pending) ----------------------------------------
        log_id = await _insert_export_log(pool, filename, meta)

        # --- upload (NO db txn held across this) -------------------------
        try:
            await asyncio.to_thread(ftp_client.upload_bytes, filename, data)
        except Exception as e:
            # Upload failed → do NOT mark rows; they retry next run.
            logger.exception("cdr_export: FTP upload failed for %s", filename)
            await _mark_log_failed(pool, log_id, repr(e))
            return SendResult(
                status="failed", row_count=meta.row_count,
                filename=filename, log_id=log_id, error=str(e),
            )

        # --- upload succeeded → watermark rows + mark log sent ----------
        await _mark_rows_exported(pool, meta.ids)
        await _mark_log_sent(pool, log_id)
        logger.info(
            "cdr_export: SENT %s — %d CDRs marked exported (log id=%s)",
            filename, meta.row_count, log_id,
        )
        return SendResult(
            status="sent", row_count=meta.row_count,
            filename=filename, log_id=log_id,
        )
    finally:
        # Always release our lease, even on error. If this fails, the TTL
        # (cfg.lock_ttl_seconds) reclaims it — no leak wedges future cycles.
        try:
            await _release_lease(pool, owner)
        except Exception:
            logger.warning("cdr_export: failed to release export lease (TTL will reclaim)")


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

async def run_once(cfg: ExportConfig) -> SendResult:
    """Perform exactly one export cycle (respects the CDR_EXPORT_ENABLED flag).

    Initializes its own asyncpg pool via the shared db.database.init_db(), runs
    send_batch(), and closes the pool. When the flag is off, no-ops with a log.
    """
    if not cfg.enabled:
        logger.info(
            "cdr_export: CDR_EXPORT_ENABLED is false — run-once is a no-op. "
            "(test-connection / dry-run still work.)"
        )
        return SendResult(status="skipped")

    logger.info("cdr_export: run-once starting — config=%s", cfg.redacted())
    await db.init_db()
    try:
        pool = await db.get_pool()
        return await send_batch(pool, cfg)
    finally:
        await db.close_db()


async def run_loop(cfg: ExportConfig) -> None:
    """Run send_batch() on a fixed interval (respects CDR_EXPORT_ENABLED).

    Simple asyncio.sleep loop — deliberately NO APScheduler / new dependency.
    Each iteration is guarded: an exception in one cycle is logged and the loop
    continues after the sleep. When the flag is off, logs once and returns
    (so the container doesn't spin) — flip the flag and restart to enable.
    """
    if not cfg.enabled:
        logger.warning(
            "cdr_export: CDR_EXPORT_ENABLED is false — run-loop will idle-exit. "
            "Set CDR_EXPORT_ENABLED=true and restart to enable scheduled exports."
        )
        return

    logger.info(
        "cdr_export: run-loop starting — interval=%ds, config=%s",
        cfg.interval_seconds, cfg.redacted(),
    )
    import asyncio
    await db.init_db()
    try:
        pool = await db.get_pool()
        while True:
            try:
                result = await send_batch(pool, cfg)
                logger.info("cdr_export: cycle complete — status=%s rows=%d",
                            result.status, result.row_count)
            except Exception:
                logger.exception("cdr_export: unexpected error in export cycle; continuing")
            await asyncio.sleep(cfg.interval_seconds)
    finally:
        await db.close_db()


async def dry_run(cfg: ExportConfig, preview_lines: int = 20) -> tuple[Optional[str], list[str], int]:
    """Select a batch and build the file, but DO NOT upload or mark. Read-only.

    Returns (filename, first N preview lines, row_count). Used by the CLI to
    preview the format before the first real send. Safe to run unconfigured
    (ignores the enabled flag — it never uploads or writes).
    """
    await db.init_db()
    try:
        pool = await db.get_pool()
        rows = await select_batch(pool, cfg)
        if not rows:
            logger.info("cdr_export: dry-run selected 0 unexported CDRs (nothing to preview)")
            return None, [], 0
        filename, data, meta = build_file(rows, cfg)
        text = data.decode("utf-8", errors="replace")
        all_lines = text.splitlines()
        preview = all_lines[:preview_lines]
        return filename, preview, meta.row_count
    finally:
        await db.close_db()
