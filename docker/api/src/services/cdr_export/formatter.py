"""Equinox record formatter — ISOLATED so it is a one-file swap.

This module is PURE and SIDE-EFFECT-FREE: no I/O, no DB, no globals mutated.
It turns an asyncpg.Record (or any Mapping / dict-like row supporting
``row[key]``) into a delimited text line. It is the ONLY place that knows the
Equinox field order and formatting, so swapping to the real spec means editing
just this file (and the SELECT column list in exporter.py to supply any new
source columns).

============================ FORMAT TODO ============================
# TODO: reconcile field order/format with the real ~49-field Equinox template
#       before go-live.
The exact 49-field Equinox specification is NOT yet available. The FIELDS list
below is a REASONABLE PLACEHOLDER mapping built from the confirmed cdrs columns.
Field ORDER, HEADER/TRAILER presence, timestamp format, duration units
(seconds vs ms vs HH:MM:SS), and money formatting all need to be confirmed
against Equinox's real template + filename convention before the first
production send. Preview the current output with the CLI `dry-run` subcommand.
====================================================================
"""
from __future__ import annotations

import io
import csv
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


def _fmt_ms_to_sec(value: Any) -> str:
    """Convert an integer millisecond value to whole seconds (floor). None -> ''."""
    if value is None:
        return ""
    try:
        return str(int(value) // 1000)
    except (ValueError, TypeError):
        return ""


def _fmt_money(value: Any) -> str:
    """Format a Decimal/float money value to 6 decimal places. None -> ''.

    Billing columns (rate_per_min, total_cost, ...) are DECIMAL and may be NULL
    when a CDR is unrated — those become empty strings.
    """
    if value is None:
        return ""
    if isinstance(value, Decimal):
        return f"{value:.6f}"
    try:
        return f"{float(value):.6f}"
    except (ValueError, TypeError):
        return ""


def _fmt_plain(value: Any) -> str:
    """Default renderer: None -> '', everything else -> str(value)."""
    if value is None:
        return ""
    return str(value)


# ---------------------------------------------------------------------------
# Field definitions
# ---------------------------------------------------------------------------
# Each entry: (output_column_name, source_row_key, value_formatter)
# The output_column_name doubles as the CSV header. source_row_key must be a
# column present in the exporter's SELECT (see exporter.SELECT_COLUMNS).
#
# ORDER HERE IS AUTHORITATIVE for the exported file layout.
# TODO: replace with the real ~49-field Equinox order/labels before go-live.
_FIELD_DEFS: list[tuple[str, str, Callable[[Any], str]]] = [
    ("call_id",            "uuid",               _fmt_plain),
    ("start_time",         "start_time",         _fmt_ts),
    ("answer_time",        "answer_time",        _fmt_ts),
    ("end_time",           "end_time",           _fmt_ts),
    ("direction",          "direction",          _fmt_plain),
    ("caller_id",          "caller_id",          _fmt_plain),
    ("destination",        "destination",        _fmt_plain),
    ("destination_prefix", "destination_prefix", _fmt_plain),
    ("duration_sec",       "duration_ms",        _fmt_ms_to_sec),
    ("billable_sec",       "billable_ms",        _fmt_ms_to_sec),
    ("hangup_cause",       "hangup_cause",       _fmt_plain),
    ("sip_code",           "sip_code",           _fmt_plain),
    ("carrier_used",       "carrier_used",       _fmt_plain),
    ("traffic_grade",      "traffic_grade",      _fmt_plain),
    ("product_type",       "product_type",       _fmt_plain),
    ("customer_id",        "customer_id",        _fmt_plain),
    ("trunk_id",           "trunk_id",           _fmt_plain),
    ("sbc_id",             "sbc_id",             _fmt_plain),
    ("freeswitch_node",    "freeswitch_node",    _fmt_plain),
    ("rate_per_min",       "rate_per_min",       _fmt_money),
    ("total_cost",         "total_cost",         _fmt_money),
    ("carrier_cost",       "carrier_cost",       _fmt_money),
]

# Module-level documentation of column order (output labels). Public API.
FIELDS: list[str] = [name for (name, _src, _fmt) in _FIELD_DEFS]


class EquinoxFormatter:
    """Format asyncpg CDR rows into Equinox delimited records.

    Pure and unit-testable. Configure the delimiter and quoting via the
    constructor (defaults: comma delimiter, minimal quoting).

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

        Placeholder trailer records the row count so downstream can validate
        completeness. Real Equinox trailer format (if any) is TBD.
        """
        if not self.include_trailer:
            return None
        return self._csv_line(["TRAILER", str(row_count)])
