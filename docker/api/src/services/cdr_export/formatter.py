"""CDR record formatter — ISOLATED so it is a one-file swap.

This module is PURE and SIDE-EFFECT-FREE: no I/O, no DB, no globals mutated.
It turns an asyncpg.Record (or any Mapping / dict-like row supporting
``row[key]``) into a delimited text line. It is the ONLY place that knows the
exported field order and formatting, so changing the layout means editing just
this file (and the SELECT column list in exporter.py to supply any new source
columns).

========================= FULL COLUMN EXPORT =========================
This emits a COMPLETE dump of every data column on the ``cdrs`` table (every
column except the ``exported_at`` watermark). The header row is AUTHORITATIVE:
each field's label is its raw DB column name (snake_case), so the file is
self-describing and downstream consumers pick the columns they need.

When the ``cdrs`` schema grows (a new ADD COLUMN migration), add the column
here (and to exporter.SELECT_COLUMNS) — the drift-guard test in
tests/test_cdr_export.py fails loudly until both are in sync, so "export all
the information we have" holds over time.

Value formatting is type-appropriate (see the helpers below): timestamps ->
ISO-8601 UTC, money DECIMALs -> 6dp, quality NUMERICs -> stored value verbatim,
JSONB -> compact JSON, BOOLEAN -> 'true'/'false', everything else -> str().
Order mirrors exporter.SELECT_COLUMNS. Preview the output with the CLI
`dry-run` subcommand.
=====================================================================

The class is still named ``EquinoxFormatter`` (Equinox is the downstream
ingester) to minimize churn; it now emits the full column set rather than a
placeholder subset.
"""
from __future__ import annotations

import io
import csv
import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Mapping, Optional


# ---------------------------------------------------------------------------
# Value formatters (pure helpers)
# ---------------------------------------------------------------------------

def _fmt_ts(value: Any) -> str:
    """Format a timestamp as deterministic UTC ISO-8601 (e.g. 2026-07-24T15:04:05Z).

    asyncpg returns TIMESTAMPTZ as timezone-aware datetime. We normalize to UTC
    and render without microseconds for a stable, compact representation.
    None -> empty string.
    """
    if value is None:
        return ""
    if isinstance(value, datetime):
        dt = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    # Fallback: stringify whatever it is (defensive; shouldn't happen for TS cols)
    return str(value)


def _fmt_money(value: Any) -> str:
    """Format a Decimal/float money value to 6 decimal places. None -> ''.

    Billing columns (rate_per_min, total_cost, carrier_cost, margin) are
    DECIMAL and may be NULL when a CDR is unrated — those become empty strings.
    """
    if value is None:
        return ""
    if isinstance(value, Decimal):
        return f"{value:.6f}"
    try:
        return f"{float(value):.6f}"
    except (ValueError, TypeError):
        return ""


def _fmt_num(value: Any) -> str:
    """Render a NUMERIC quality/metric value with its STORED precision. None -> ''.

    Unlike _fmt_money (which forces 6dp), this preserves whatever asyncpg hands
    back for NUMERIC columns (mos, jitter_*, packet_loss_pct, r_factor,
    rtp_* rates, ...) — asyncpg maps NUMERIC to Decimal, and str(Decimal) keeps
    the value exactly as stored (e.g. Decimal("4.20") -> "4.20") with no float
    rounding. Falls back to str() for any non-None non-Decimal.
    """
    if value is None:
        return ""
    return str(value)


def _fmt_json(value: Any) -> str:
    """Render a JSONB column (fraud_flags) as a compact JSON string. None -> ''.

    asyncpg may hand JSONB back either already-decoded (dict/list) or as the
    raw JSON text (str) depending on codec setup, so handle both: pass a str
    through unchanged; json.dumps a dict/list with no whitespace.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def _fmt_bool(value: Any) -> str:
    """Render a BOOLEAN (on_net) as 'true'/'false'. None -> ''."""
    if value is None:
        return ""
    return "true" if value else "false"


def _fmt_plain(value: Any) -> str:
    """Default renderer: None -> '', everything else -> str(value).

    Used for integers/bigints (durations in ms, counts, byte totals, codes,
    ids, hops) and text columns.
    """
    if value is None:
        return ""
    return str(value)


# ---------------------------------------------------------------------------
# Field definitions
# ---------------------------------------------------------------------------
# Each entry: (output_column_name, source_row_key, value_formatter).
# The output_column_name is the raw DB column name and doubles as the CSV
# header (self-describing file). source_row_key must be a column present in the
# exporter's SELECT (see exporter.SELECT_COLUMNS) — kept identical to the header
# so the drift-guard test can equate the two sets.
#
# ORDER HERE IS AUTHORITATIVE for the exported file layout and mirrors
# exporter.SELECT_COLUMNS (base-table order, then migrations in number order).
# To add a new cdrs column to the export, append it here AND to SELECT_COLUMNS.
_FIELD_DEFS: list[tuple[str, str, Callable[[Any], str]]] = [
    # --- base table (05_schema_cdr.sql), in declaration order ---
    ("id",                             "id",                             _fmt_plain),
    ("uuid",                           "uuid",                           _fmt_plain),
    ("customer_id",                    "customer_id",                    _fmt_plain),
    ("product_type",                   "product_type",                   _fmt_plain),
    ("trunk_id",                       "trunk_id",                       _fmt_plain),
    ("direction",                      "direction",                      _fmt_plain),
    ("caller_id",                      "caller_id",                      _fmt_plain),
    ("destination",                    "destination",                    _fmt_plain),
    ("destination_prefix",             "destination_prefix",             _fmt_plain),
    ("start_time",                     "start_time",                     _fmt_ts),
    ("answer_time",                    "answer_time",                    _fmt_ts),
    ("end_time",                       "end_time",                       _fmt_ts),
    ("duration_ms",                    "duration_ms",                    _fmt_plain),
    ("billable_ms",                    "billable_ms",                    _fmt_plain),
    ("rate_per_min",                   "rate_per_min",                   _fmt_money),
    ("total_cost",                     "total_cost",                     _fmt_money),
    ("carrier_cost",                   "carrier_cost",                   _fmt_money),
    ("margin",                         "margin",                         _fmt_money),
    ("rated_at",                       "rated_at",                       _fmt_ts),
    ("hangup_cause",                   "hangup_cause",                   _fmt_plain),
    ("sip_code",                       "sip_code",                       _fmt_plain),
    ("carrier_used",                   "carrier_used",                   _fmt_plain),
    ("traffic_grade",                  "traffic_grade",                  _fmt_plain),
    ("fraud_score",                    "fraud_score",                    _fmt_plain),
    ("fraud_flags",                    "fraud_flags",                    _fmt_json),
    ("freeswitch_node",                "freeswitch_node",                _fmt_plain),
    ("mos",                            "mos",                            _fmt_num),
    ("quality_pct",                    "quality_pct",                    _fmt_num),
    ("jitter_min_ms",                  "jitter_min_ms",                  _fmt_num),
    ("jitter_max_ms",                  "jitter_max_ms",                  _fmt_num),
    ("jitter_avg_ms",                  "jitter_avg_ms",                  _fmt_num),
    ("packet_loss_count",             "packet_loss_count",              _fmt_plain),
    ("packet_total_count",             "packet_total_count",             _fmt_plain),
    ("packet_loss_pct",                "packet_loss_pct",                _fmt_num),
    ("flaw_total",                     "flaw_total",                     _fmt_plain),
    ("r_factor",                       "r_factor",                       _fmt_num),
    ("rtp_audio_in_raw_bytes",         "rtp_audio_in_raw_bytes",         _fmt_plain),
    ("rtp_audio_in_media_bytes",       "rtp_audio_in_media_bytes",       _fmt_plain),
    ("rtp_audio_out_raw_bytes",        "rtp_audio_out_raw_bytes",        _fmt_plain),
    ("rtp_audio_out_media_bytes",      "rtp_audio_out_media_bytes",      _fmt_plain),
    ("rtp_audio_in_packet_count",      "rtp_audio_in_packet_count",      _fmt_plain),
    ("rtp_audio_out_packet_count",     "rtp_audio_out_packet_count",     _fmt_plain),
    ("rtp_audio_in_jitter_burst_rate", "rtp_audio_in_jitter_burst_rate", _fmt_num),
    ("rtp_audio_in_jitter_loss_rate",  "rtp_audio_in_jitter_loss_rate",  _fmt_num),
    ("rtp_audio_in_mean_interval",     "rtp_audio_in_mean_interval",     _fmt_num),
    ("read_codec",                     "read_codec",                     _fmt_plain),
    ("write_codec",                    "write_codec",                    _fmt_plain),
    ("read_rate",                      "read_rate",                      _fmt_plain),
    ("write_rate",                     "write_rate",                     _fmt_plain),
    ("sip_from_user",                  "sip_from_user",                  _fmt_plain),
    ("sip_to_user",                    "sip_to_user",                    _fmt_plain),
    ("hangup_cause_q850",              "hangup_cause_q850",              _fmt_plain),
    ("sip_hangup_disposition",         "sip_hangup_disposition",         _fmt_plain),
    ("sip_user_agent",                 "sip_user_agent",                 _fmt_plain),
    ("network_addr",                   "network_addr",                   _fmt_plain),
    ("bridge_uuid",                    "bridge_uuid",                    _fmt_plain),
    # --- 18_sbc_id_column.sql ---
    ("sbc_id",                         "sbc_id",                         _fmt_plain),
    # --- 23_onnet_cdr_columns.sql ---
    ("origin_customer_id",             "origin_customer_id",             _fmt_plain),
    ("terminating_customer_id",        "terminating_customer_id",        _fmt_plain),
    ("on_net",                         "on_net",                         _fmt_bool),
    ("on_net_hops",                    "on_net_hops",                    _fmt_plain),
]

# Module-level documentation of column order (output labels). Public API.
FIELDS: list[str] = [name for (name, _src, _fmt) in _FIELD_DEFS]


class EquinoxFormatter:
    """Format asyncpg CDR rows into delimited records — full cdrs column dump.

    Emits every data column of the cdrs table (see _FIELD_DEFS); the header row
    of raw DB column names is authoritative. Pure and unit-testable. Configure
    the delimiter and quoting via the constructor (defaults: comma delimiter,
    minimal quoting).

    Usage:
        fmt = EquinoxFormatter()
        header = fmt.header()                 # str | None
        line   = fmt.format_record(row)       # str (no trailing newline)
        tail   = fmt.trailer(row_count)       # str | None
    """

    def __init__(self, delimiter: str = ",", quote_all: bool = False,
                 include_header: bool = True, include_trailer: bool = False):
        self.delimiter = delimiter
        self.quote_all = quote_all
        self.include_header = include_header
        self.include_trailer = include_trailer

    # -- CSV row rendering -------------------------------------------------
    def _csv_line(self, values: list[str]) -> str:
        """Render one list of already-stringified values as a CSV line.

        Uses the csv module for correct quoting/escaping of delimiters, quotes,
        and newlines embedded in field values. Returns the line WITHOUT a
        trailing newline (the writer joins with the file's line terminator).
        """
        buf = io.StringIO()
        quoting = csv.QUOTE_ALL if self.quote_all else csv.QUOTE_MINIMAL
        writer = csv.writer(
            buf,
            delimiter=self.delimiter,
            quoting=quoting,
            lineterminator="",  # we control line joining in the file builder
        )
        writer.writerow(values)
        return buf.getvalue()

    # -- Public formatter API ---------------------------------------------
    def header(self) -> Optional[str]:
        """Return the header line, or None if headers are disabled."""
        if not self.include_header:
            return None
        return self._csv_line(FIELDS)

    def format_record(self, row: Mapping[str, Any]) -> str:
        """Format a single CDR row (asyncpg.Record / dict-like) into one line.

        ``row`` must support ``row[key]`` lookups for the source keys in
        _FIELD_DEFS. Missing keys are treated as None (empty output) rather
        than raising, so a schema/column mismatch degrades gracefully instead
        of dropping the whole batch.
        """
        values: list[str] = []
        for _name, src_key, formatter in _FIELD_DEFS:
            try:
                raw = row[src_key]
            except (KeyError, IndexError):
                raw = None
            values.append(formatter(raw))
        return self._csv_line(values)

    def trailer(self, row_count: int) -> Optional[str]:
        """Return a trailer line, or None if trailers are disabled.

        Optional trailer records the row count so downstream can validate
        completeness. Disabled by default (include_trailer=False).
        """
        if not self.include_trailer:
            return None
        return self._csv_line(["TRAILER", str(row_count)])
