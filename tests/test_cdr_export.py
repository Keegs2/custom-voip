"""Unit tests for the CDR export forwarder (docker/api/src/services/cdr_export/).

Runnable WITHOUT a live DB or FTP server: ftplib and the asyncpg pool/connection
are faked. Mirrors the repo's file-path/module-load pattern (see
tests/test_homer_pipeline.py) but here we put docker/api/src on sys.path so the
package's intra-package imports (``from db import database``, ``from .config``)
resolve exactly as they do inside the API container (WORKDIR /app == src/).

Run:
    python3 -m pytest tests/test_cdr_export.py -v
"""
import sys
import pathlib
import logging
import ftplib

import pytest

# ---------------------------------------------------------------------------
# Make `services.cdr_export` importable the same way the container sees it:
# the container copies src/ -> /app and runs with /app on the path, so
# `services`, `db`, `routers` are all top-level packages. We replicate that by
# putting docker/api/src on sys.path.
# ---------------------------------------------------------------------------
_SRC = pathlib.Path(__file__).resolve().parents[1] / "docker" / "api" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from services.cdr_export.config import ExportConfig  # noqa: E402
from services.cdr_export.formatter import EquinoxFormatter, FIELDS, _FIELD_DEFS  # noqa: E402
from services.cdr_export import exporter as exp  # noqa: E402
from services.cdr_export.ftp_client import FTPClient  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from decimal import Decimal  # noqa: E402
import re  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeRow(dict):
    """asyncpg.Record-like: supports row[key]. dict already does; subclass for clarity."""
    pass


def make_row(**overrides):
    """Build a CDR row with sensible defaults for EVERY exported column.

    Mirrors exporter.SELECT_COLUMNS (the full cdrs data-column set minus the
    exported_at watermark). Overridable per test.
    """
    base = {
        # base table (05_schema_cdr.sql)
        "id": 1001,
        "uuid": "abc-123-uuid",
        "customer_id": 42,
        "product_type": "rcf",
        "trunk_id": None,
        "direction": "inbound",
        "caller_id": "+16175551234",
        "destination": "+17745559999",
        "destination_prefix": "+17745",
        "start_time": datetime(2026, 7, 24, 15, 4, 5, tzinfo=timezone.utc),
        "answer_time": datetime(2026, 7, 24, 15, 4, 8, tzinfo=timezone.utc),
        "end_time": datetime(2026, 7, 24, 15, 5, 5, tzinfo=timezone.utc),
        "duration_ms": 60000,
        "billable_ms": 57000,
        "rate_per_min": Decimal("0.010000"),
        "total_cost": Decimal("0.009500"),
        "carrier_cost": Decimal("0.004000"),
        "margin": Decimal("0.005500"),
        "rated_at": datetime(2026, 7, 24, 15, 5, 10, tzinfo=timezone.utc),
        "hangup_cause": "NORMAL_CLEARING",
        "sip_code": 200,
        "carrier_used": "primary",
        "traffic_grade": "standard",
        "fraud_score": 0,
        "fraud_flags": None,
        "freeswitch_node": "fs-media-v2",
        "mos": Decimal("4.20"),
        "quality_pct": Decimal("98.50"),
        "jitter_min_ms": Decimal("0.100"),
        "jitter_max_ms": Decimal("3.250"),
        "jitter_avg_ms": Decimal("1.125"),
        "packet_loss_count": 0,
        "packet_total_count": 3000,
        "packet_loss_pct": Decimal("0.00"),
        "flaw_total": 0,
        "r_factor": Decimal("93.00"),
        "rtp_audio_in_raw_bytes": 480000,
        "rtp_audio_in_media_bytes": 476000,
        "rtp_audio_out_raw_bytes": 480000,
        "rtp_audio_out_media_bytes": 476000,
        "rtp_audio_in_packet_count": 3000,
        "rtp_audio_out_packet_count": 3000,
        "rtp_audio_in_jitter_burst_rate": Decimal("0.0000"),
        "rtp_audio_in_jitter_loss_rate": Decimal("0.0000"),
        "rtp_audio_in_mean_interval": Decimal("20.000"),
        "read_codec": "PCMU",
        "write_codec": "PCMU",
        "read_rate": 8000,
        "write_rate": 8000,
        "sip_from_user": "16175551234",
        "sip_to_user": "17745559999",
        "hangup_cause_q850": 16,
        "sip_hangup_disposition": "recv_bye",
        "sip_user_agent": "FreeSWITCH",
        "network_addr": "67.231.2.12",
        "bridge_uuid": "bridge-abc-999",
        # 18_sbc_id_column.sql
        "sbc_id": "sbc-1",
        # 23_onnet_cdr_columns.sql
        "origin_customer_id": 42,
        "terminating_customer_id": 42,
        "on_net": False,
        "on_net_hops": 0,
    }
    base.update(overrides)
    return FakeRow(base)


class FakeConn:
    """Records executed SQL and returns scripted results.

    ``fetch_result`` is what fetch() returns (the batch). ``fetchrow`` serves
    TWO callers, disambiguated by SQL text: the lease-claim UPDATE
    (``cdr_export_lock``) returns ``lease_claim`` (a row = lease won, None =
    contended); every other fetchrow (the ``INSERT ... RETURNING id`` for the
    audit log) returns ``fetchrow_result``.
    """

    def __init__(self, fetch_result=None, lease_claim=..., fetchrow_result=None):
        self.fetch_result = fetch_result if fetch_result is not None else []
        # Sentinel default → lease is claimed (a row is returned). Pass
        # lease_claim=None to simulate a contended lease.
        self.lease_claim = {"id": 1} if lease_claim is ... else lease_claim
        self.fetchrow_result = fetchrow_result if fetchrow_result is not None else {"id": 7}
        self.executed = []   # list of (sql, args)

    async def fetch(self, query, *args):
        self.executed.append(("FETCH", query, args))
        return self.fetch_result

    async def fetchrow(self, query, *args):
        self.executed.append(("FETCHROW", query, args))
        if "cdr_export_lock" in query:
            return self.lease_claim
        return self.fetchrow_result

    async def execute(self, query, *args):
        self.executed.append(("EXECUTE", query, args))
        return "OK"


class _AcquireCtx:
    """Async context manager returned by FakePool.acquire()."""

    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class FakePool:
    """Minimal asyncpg.Pool stand-in.

    send_batch and every helper use ``async with pool.acquire() as conn``. We
    also keep the awaitable + ``pool.release(conn)`` form working (harmless,
    unused now) so the fake stays a drop-in for either acquire style.
    """

    def __init__(self, conn):
        self.conn = conn
        self.released = []

    def acquire(self):
        pool = self

        class _Dual:
            # `async with pool.acquire() as c`
            async def __aenter__(_self):
                return pool.conn

            async def __aexit__(_self, *exc):
                return False

            # `c = await pool.acquire()`
            def __await__(_self):
                async def _get():
                    return pool.conn
                return _get().__await__()

        return _Dual()

    async def release(self, conn):
        self.released.append(conn)


class FakeFTP:
    """Injectable FTP client stand-in for send_batch tests."""

    def __init__(self, fail: bool = False):
        self.fail = fail
        self.uploads = []   # list of (filename, data)

    def upload_bytes(self, filename, data):
        if self.fail:
            raise ftplib.error_temp("450 boom (simulated transient FTP failure)")
        self.uploads.append((filename, data))


# ---------------------------------------------------------------------------
# formatter
# ---------------------------------------------------------------------------

def test_formatter_field_count_and_header():
    fmt = EquinoxFormatter()
    header = fmt.header()
    assert header is not None
    # Header column count == FIELDS count == format_record column count.
    assert len(header.split(",")) == len(FIELDS)

    line = fmt.format_record(make_row())
    assert len(line.split(",")) == len(FIELDS)


def test_formatter_key_field_rendering():
    fmt = EquinoxFormatter()
    parts = fmt.format_record(make_row()).split(",")
    field_index = {name: i for i, name in enumerate(FIELDS)}

    # uuid verbatim (header is now the raw column name)
    assert parts[field_index["uuid"]] == "abc-123-uuid"
    # id verbatim
    assert parts[field_index["id"]] == "1001"
    # timestamp -> deterministic UTC ISO-8601 with trailing Z, no microseconds
    assert parts[field_index["start_time"]] == "2026-07-24T15:04:05Z"
    # durations are exported as raw milliseconds now (full-column dump)
    assert parts[field_index["duration_ms"]] == "60000"
    assert parts[field_index["billable_ms"]] == "57000"
    # money -> 6dp
    assert parts[field_index["total_cost"]] == "0.009500"
    assert parts[field_index["margin"]] == "0.005500"


def test_formatter_numeric_quality_renders_stored_value():
    """NUMERIC quality metrics keep their stored precision via str(Decimal)."""
    fmt = EquinoxFormatter()
    parts = fmt.format_record(make_row()).split(",")
    idx = {name: i for i, name in enumerate(FIELDS)}
    # mos NUMERIC(3,2) 4.20 -> "4.20" (no float rounding, no 6dp money coercion)
    assert parts[idx["mos"]] == "4.20"
    assert parts[idx["jitter_avg_ms"]] == "1.125"
    assert parts[idx["rtp_audio_in_mean_interval"]] == "20.000"


def test_formatter_jsonb_fraud_flags_rendering():
    """fraud_flags JSONB -> compact JSON; handles dict, str passthrough, and None."""
    fmt = EquinoxFormatter()
    idx = {name: i for i, name in enumerate(FIELDS)}

    # dict (asyncpg-decoded) -> compact JSON, no whitespace. The comma inside
    # the JSON forces csv to quote the cell, so re-parse to read it back.
    import csv as _csv
    line = fmt.format_record(make_row(fraud_flags={"velocity": True, "n": 3}))
    cell = next(_csv.reader([line]))[idx["fraud_flags"]]
    assert cell == '{"velocity":true,"n":3}'

    # raw JSON string (asyncpg text codec) -> passed through unchanged. The
    # embedded quotes make csv quote the cell, so re-parse to read the value.
    line = fmt.format_record(make_row(fraud_flags='{"a":1}'))
    assert next(_csv.reader([line]))[idx["fraud_flags"]] == '{"a":1}'

    # None -> empty
    parts = fmt.format_record(make_row(fraud_flags=None)).split(",")
    assert parts[idx["fraud_flags"]] == ""


def test_formatter_boolean_on_net_rendering():
    """on_net BOOLEAN -> 'true'/'false', None -> ''."""
    fmt = EquinoxFormatter()
    idx = {name: i for i, name in enumerate(FIELDS)}
    assert fmt.format_record(make_row(on_net=True)).split(",")[idx["on_net"]] == "true"
    assert fmt.format_record(make_row(on_net=False)).split(",")[idx["on_net"]] == "false"
    assert fmt.format_record(make_row(on_net=None)).split(",")[idx["on_net"]] == ""


def test_formatter_none_becomes_empty_string():
    fmt = EquinoxFormatter()
    row = make_row(answer_time=None, trunk_id=None, rate_per_min=None,
                   total_cost=None, carrier_cost=None, sbc_id=None,
                   mos=None, on_net=None, fraud_flags=None, on_net_hops=None)
    parts = fmt.format_record(row).split(",")
    idx = {name: i for i, name in enumerate(FIELDS)}
    for key in ("answer_time", "trunk_id", "rate_per_min", "total_cost",
                "carrier_cost", "sbc_id", "mos", "on_net", "fraud_flags",
                "on_net_hops"):
        assert parts[idx[key]] == "", f"{key} should render as empty string"


def test_formatter_quoting_of_embedded_delimiter():
    """A comma inside a field must be quoted so the column count is preserved."""
    fmt = EquinoxFormatter()
    row = make_row(hangup_cause="WEIRD,CAUSE")
    line = fmt.format_record(row)
    # csv should have quoted the field; re-parsing keeps the field count stable.
    import csv as _csv
    reparsed = next(_csv.reader([line]))
    assert len(reparsed) == len(FIELDS)
    assert "WEIRD,CAUSE" in reparsed


def test_formatter_missing_source_key_degrades_to_empty():
    """A row missing a source column yields empty, not an exception/dropped batch."""
    fmt = EquinoxFormatter()
    row = make_row()
    del row["carrier_cost"]  # simulate a schema/column mismatch
    parts = fmt.format_record(row).split(",")
    idx = {name: i for i, name in enumerate(FIELDS)}
    assert parts[idx["carrier_cost"]] == ""


# ---------------------------------------------------------------------------
# filename generation
# ---------------------------------------------------------------------------

def test_build_filename_prefix_ext_and_timestamp():
    cfg = ExportConfig(filename_prefix="CDR_", filename_ext=".csv",
                       filename_ts_format="%Y%m%d%H%M%S")
    when = datetime(2026, 7, 24, 15, 4, 5, tzinfo=timezone.utc)
    name = exp.build_filename(cfg, when=when, suffix="deadbeef")
    assert name == "CDR_20260724150405_deadbeef.csv"


def test_build_filename_uniqueness_same_second():
    """Two files in the same second get different suffixes (no collision)."""
    cfg = ExportConfig()
    when = datetime(2026, 7, 24, 15, 4, 5, tzinfo=timezone.utc)
    a = exp.build_filename(cfg, when=when)
    b = exp.build_filename(cfg, when=when)
    assert a != b
    assert a.startswith("CDR_20260724150405_")
    assert b.startswith("CDR_20260724150405_")


def test_build_filename_respects_custom_prefix_ext():
    cfg = ExportConfig(filename_prefix="EQX-", filename_ext=".txt")
    name = exp.build_filename(cfg, suffix="abcd1234")
    assert name.startswith("EQX-")
    assert name.endswith("_abcd1234.txt")


# ---------------------------------------------------------------------------
# build_file meta
# ---------------------------------------------------------------------------

def test_build_file_meta_from_rows():
    cfg = ExportConfig()
    rows = [
        make_row(id=1001, start_time=datetime(2026, 7, 24, 10, 0, 0, tzinfo=timezone.utc)),
        make_row(id=1005, uuid="u2",
                 start_time=datetime(2026, 7, 24, 11, 0, 0, tzinfo=timezone.utc)),
        make_row(id=1003, uuid="u3",
                 start_time=datetime(2026, 7, 24, 9, 0, 0, tzinfo=timezone.utc)),
    ]
    filename, data, meta = exp.build_file(rows, cfg)

    assert meta.row_count == 3
    assert meta.min_id == 1001
    assert meta.max_id == 1005
    assert meta.ids == [1001, 1005, 1003]
    assert meta.min_start_time == datetime(2026, 7, 24, 9, 0, 0, tzinfo=timezone.utc)
    assert meta.max_start_time == datetime(2026, 7, 24, 11, 0, 0, tzinfo=timezone.utc)
    assert meta.byte_size == len(data)
    assert isinstance(data, bytes)

    # Header + 3 data lines; CRLF-terminated.
    text = data.decode("utf-8")
    assert text.endswith("\r\n")
    non_empty = [ln for ln in text.split("\r\n") if ln]
    assert len(non_empty) == 1 + 3  # header + rows


def test_build_file_empty_rows():
    cfg = ExportConfig()
    filename, data, meta = exp.build_file([], cfg)
    assert meta.row_count == 0
    assert meta.min_id is None and meta.max_id is None
    assert meta.ids == []
    assert filename.startswith("CDR_")


# ---------------------------------------------------------------------------
# send_batch — happy path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_batch_happy_path():
    cfg = ExportConfig(enabled=True, skip_empty=True)
    rows = [make_row(id=1001), make_row(id=1002, uuid="u2")]
    conn = FakeConn(
        fetch_result=rows,
        lease_claim={"id": 1},             # lease UPDATE returns a row → we won it
        fetchrow_result={"id": 55},        # cdr_export_log id
    )
    pool = FakePool(conn)
    fake_ftp = FakeFTP(fail=False)

    result = await exp.send_batch(pool, cfg, ftp_client=fake_ftp)

    assert result.status == "sent"
    assert result.row_count == 2
    assert result.log_id == 55
    assert result.filename and result.filename.startswith("CDR_")

    # STOR called exactly once, with the built bytes.
    assert len(fake_ftp.uploads) == 1
    up_name, up_data = fake_ftp.uploads[0]
    assert up_name == result.filename
    assert isinstance(up_data, bytes) and len(up_data) > 0

    sql_text = " ".join(e[1] for e in conn.executed)
    # lease claimed (single UPDATE on cdr_export_lock with a TTL interval)
    assert "UPDATE cdr_export_lock" in sql_text
    assert "make_interval(secs => $1::int)" in sql_text
    # rows marked exported (watermark UPDATE with id = ANY(...))
    assert "UPDATE cdrs SET exported_at = now()" in sql_text
    assert "id = ANY($1::bigint[])" in sql_text
    # the ids passed to the watermark update are exactly the batch ids
    upd = [e for e in conn.executed if e[0] == "EXECUTE" and "exported_at = now()" in e[1]][0]
    assert upd[2][0] == [1001, 1002]
    # log flipped to 'sent'
    assert "status = 'sent'" in sql_text
    # lease released in the finally (clears our own row)
    assert "cdr_export_lock SET locked_until = NULL" in sql_text


@pytest.mark.asyncio
async def test_send_batch_nothing_to_do_when_empty_and_skip():
    cfg = ExportConfig(enabled=True, skip_empty=True)
    conn = FakeConn(fetch_result=[], lease_claim={"id": 1})
    pool = FakePool(conn)
    fake_ftp = FakeFTP(fail=False)

    result = await exp.send_batch(pool, cfg, ftp_client=fake_ftp)

    assert result.status == "nothing_to_do"
    assert result.row_count == 0
    # No upload, no export-log insert, no watermark.
    assert fake_ftp.uploads == []
    sql_text = " ".join(e[1] for e in conn.executed)
    assert "INSERT INTO cdr_export_log" not in sql_text
    assert "exported_at = now()" not in sql_text
    # lease still released in the finally
    assert "cdr_export_lock SET locked_until = NULL" in sql_text


@pytest.mark.asyncio
async def test_send_batch_bails_when_lease_contended():
    cfg = ExportConfig(enabled=True)
    # lease UPDATE matches no row (held by another runner) → claim returns None.
    conn = FakeConn(fetch_result=[make_row()], lease_claim=None)
    pool = FakePool(conn)
    fake_ftp = FakeFTP(fail=False)

    result = await exp.send_batch(pool, cfg, ftp_client=fake_ftp)

    assert result.status == "locked"
    assert fake_ftp.uploads == []
    # We attempted exactly one thing: the lease-claim UPDATE. No select, no
    # export-log insert, no watermark update — we bailed right after the claim.
    assert not any(e[0] == "FETCH" for e in conn.executed)          # no select_batch
    assert not any("INSERT INTO cdr_export_log" in e[1] for e in conn.executed)
    assert not any("exported_at = now()" in e[1] for e in conn.executed)
    # And the lease-release UPDATE must NOT run (we never held the lease).
    assert not any("locked_until = NULL" in e[1] for e in conn.executed)
    # The only recorded statement is the claim itself.
    assert any("UPDATE cdr_export_lock" in e[1] and "make_interval" in e[1]
               for e in conn.executed)


# ---------------------------------------------------------------------------
# send_batch — FTP failure path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_batch_ftp_failure_does_not_mark_rows():
    cfg = ExportConfig(enabled=True, skip_empty=True)
    rows = [make_row(id=2001), make_row(id=2002, uuid="u2")]
    conn = FakeConn(
        fetch_result=rows,
        lease_claim={"id": 1},
        fetchrow_result={"id": 99},
    )
    pool = FakePool(conn)
    fake_ftp = FakeFTP(fail=True)   # upload raises

    result = await exp.send_batch(pool, cfg, ftp_client=fake_ftp)

    assert result.status == "failed"
    assert result.log_id == 99
    assert result.error  # error string recorded on the result

    sql_text = " ".join(e[1] for e in conn.executed)
    # Rows are NOT marked exported (they must retry next run).
    assert "exported_at = now()" not in sql_text
    # export-log row flipped to 'failed' with an error string.
    assert "status = 'failed'" in sql_text
    failed_upd = [e for e in conn.executed
                  if e[0] == "EXECUTE" and "status = 'failed'" in e[1]][0]
    assert "boom" in failed_upd[2][1]  # the error text was recorded
    # lease still released even on the failure path (finally)
    assert "cdr_export_lock SET locked_until = NULL" in sql_text


# ---------------------------------------------------------------------------
# ftp_client — password redaction
# ---------------------------------------------------------------------------

class _RecordingFTP:
    """Stub ftplib.FTP capturing what would be sent; asserts we never crash."""

    def __init__(self, *a, **k):
        self.calls = []

    def connect(self, host=None, port=None):
        self.calls.append(("connect", host, port))

    def login(self, user=None, passwd=None):
        self.calls.append(("login", user, passwd))

    def set_pasv(self, flag):
        self.calls.append(("set_pasv", flag))

    def cwd(self, d):
        self.calls.append(("cwd", d))

    def nlst(self, *a):
        return ["existing_file_1.csv", "existing_file_2.csv"]

    def storbinary(self, cmd, fp):
        self.calls.append(("storbinary", cmd, fp.read()))

    def quit(self):
        self.calls.append(("quit",))

    def close(self):
        self.calls.append(("close",))


def test_ftp_password_never_logged_on_connect(monkeypatch, caplog):
    secret = "SuperSecretHunter2!"
    cfg = ExportConfig(
        ftp_host="10.142.0.71", ftp_port=21, ftp_user="equinox",
        ftp_password=secret, ftp_dir="/drop", ftp_tls=False,
    )
    monkeypatch.setattr(ftplib, "FTP", _RecordingFTP)

    client = FTPClient(cfg)
    with caplog.at_level(logging.DEBUG, logger="services.cdr_export.ftp_client"):
        listing = client.test_connection()

    assert listing == ["existing_file_1.csv", "existing_file_2.csv"]
    # The password must not appear in ANY captured log record.
    all_logs = "\n".join(r.getMessage() for r in caplog.records)
    assert secret not in all_logs
    # And the redacted config helper must not leak it either.
    assert secret not in str(cfg.redacted())
    assert cfg.redacted()["ftp_password"] == "***REDACTED***"


def test_ftp_password_never_logged_on_upload(monkeypatch, caplog):
    secret = "AnotherSecret#42"
    cfg = ExportConfig(
        ftp_host="10.142.0.71", ftp_port=21, ftp_user="equinox",
        ftp_password=secret, ftp_dir="/drop", ftp_tls=False,
    )
    monkeypatch.setattr(ftplib, "FTP", _RecordingFTP)

    client = FTPClient(cfg)
    with caplog.at_level(logging.DEBUG, logger="services.cdr_export.ftp_client"):
        client.upload_bytes("CDR_test.csv", b"a,b,c\r\n1,2,3\r\n")

    all_logs = "\n".join(r.getMessage() for r in caplog.records)
    assert secret not in all_logs
    # Upload success should have been logged (filename + byte count), sans secret.
    assert any("uploaded CDR_test.csv" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# Schema drift guard (DB-less): the export projection MUST stay == the full set
# of cdrs data columns. A future ADD COLUMN that isn't wired into SELECT_COLUMNS
# + the formatter fails HERE, honoring "export all the information we store".
# Pure/regex-based — parses the init SQL files, no DB.
# ---------------------------------------------------------------------------

# tests/ -> repo root -> docker/postgres/init
_INIT = pathlib.Path(__file__).resolve().parents[1] / "docker" / "postgres" / "init"

# The watermark column is the selection cursor (NULL at export time); it is
# deliberately NOT exported.
_WATERMARK_EXCLUDED = {"exported_at"}

# Non-column tokens that can start a line inside the CREATE TABLE body.
_NOT_A_COLUMN = {"primary", "constraint", "unique", "check", "foreign", "like"}


def _cdrs_base_columns() -> list[str]:
    """Parse column names from the base `CREATE TABLE cdrs (...)` in 05_schema_cdr.sql.

    Takes the body between `CREATE TABLE cdrs (` and its matching close paren,
    then the first identifier of each definition line (skipping blanks, `--`
    comments, and table-constraint lines like PRIMARY KEY).
    """
    sql = (_INIT / "05_schema_cdr.sql").read_text()
    m = re.search(r"CREATE\s+TABLE\s+cdrs\s*\((.*?)\n\)\s*;", sql, re.IGNORECASE | re.DOTALL)
    assert m, "could not locate CREATE TABLE cdrs (...) block in 05_schema_cdr.sql"
    body = m.group(1)
    cols: list[str] = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith("--"):
            continue
        # strip trailing inline comment, then take the first token
        line = line.split("--", 1)[0].strip().rstrip(",")
        if not line:
            continue
        tok = line.split()[0]
        if tok.lower() in _NOT_A_COLUMN:
            continue
        if re.fullmatch(r"[a-z_][a-z0-9_]*", tok):
            cols.append(tok)
    return cols


def _cdrs_added_columns(filename: str) -> list[str]:
    """Extract every `ADD COLUMN [IF NOT EXISTS] <name>` from a migration file.

    The `(?!IF\\s+NOT\\s+EXISTS)` lookahead stops the optional IF-NOT-EXISTS
    group from backtracking and capturing the keyword `IF` as the column name
    (migration 23 uses the bare `ADD COLUMN IF NOT EXISTS <name>` form).
    """
    sql = (_INIT / filename).read_text()
    return re.findall(
        r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?!IF\s+NOT\s+EXISTS)([a-z_][a-z0-9_]*)",
        sql, re.IGNORECASE,
    )


def _all_cdrs_columns() -> list[str]:
    """Full ordered cdrs data-column list from schema + migrations, minus watermark.

    Base table order (05), then ADD COLUMNs in file-number order (16, 18, 23),
    de-duplicated (16 re-declares columns already present in the base table via
    IF NOT EXISTS — they keep their base-table position). exported_at (from 21)
    is excluded: it is the export cursor, never emitted.
    """
    seen: set[str] = set()
    ordered: list[str] = []
    for col in (
        _cdrs_base_columns()
        + _cdrs_added_columns("16_cdr_detail_columns.sql")
        + _cdrs_added_columns("18_sbc_id_column.sql")
        + _cdrs_added_columns("23_onnet_cdr_columns.sql")
    ):
        if col in _WATERMARK_EXCLUDED or col in seen:
            continue
        seen.add(col)
        ordered.append(col)
    return ordered


def test_schema_parse_smoke():
    """Sanity: the regex parser actually finds the columns we know exist."""
    base = _cdrs_base_columns()
    # a representative spread across the CREATE TABLE body
    for col in ("id", "uuid", "start_time", "total_cost", "fraud_flags",
                "mos", "bridge_uuid"):
        assert col in base, f"parser missed base column {col!r}"
    assert "exported_at" not in base            # 21 is a migration, not base
    assert _cdrs_added_columns("18_sbc_id_column.sql") == ["sbc_id"]
    assert set(_cdrs_added_columns("23_onnet_cdr_columns.sql")) == {
        "origin_customer_id", "terminating_customer_id", "on_net", "on_net_hops",
    }


def test_select_columns_equal_full_cdrs_schema():
    """exporter.SELECT_COLUMNS == every cdrs data column (excl. exported_at)."""
    schema_cols = set(_all_cdrs_columns())
    select_cols = set(exp.SELECT_COLUMNS)

    missing = schema_cols - select_cols   # a new column not wired into export
    extra = select_cols - schema_cols     # a projected column with no schema home
    assert not missing, f"cdrs columns missing from SELECT_COLUMNS: {sorted(missing)}"
    assert not extra, f"SELECT_COLUMNS has columns not in the cdrs schema: {sorted(extra)}"
    assert "exported_at" not in select_cols

    # No duplicate projections.
    assert len(exp.SELECT_COLUMNS) == len(select_cols)


def test_formatter_source_keys_match_select_columns():
    """Every formatter source key is a SELECTed column, and all cols are formatted.

    source keys ⊆ SELECT_COLUMNS (no phantom source), and (for a complete dump)
    every SELECTed column has a formatter entry, so nothing we pull is dropped.
    """
    source_keys = [src for (_name, src, _fmt) in _FIELD_DEFS]
    source_set = set(source_keys)
    select_set = set(exp.SELECT_COLUMNS)

    assert source_set <= select_set, (
        f"formatter references non-selected columns: {sorted(source_set - select_set)}"
    )
    assert select_set <= source_set, (
        f"selected columns with no formatter entry: {sorted(select_set - source_set)}"
    )
    # Header labels are the raw DB column names (self-describing file).
    assert FIELDS == source_keys
    # No duplicate field defs.
    assert len(source_keys) == len(source_set)
