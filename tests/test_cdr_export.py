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
from services.cdr_export.formatter import EquinoxFormatter, FIELDS  # noqa: E402
from services.cdr_export import exporter as exp  # noqa: E402
from services.cdr_export.ftp_client import FTPClient  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from decimal import Decimal  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeRow(dict):
    """asyncpg.Record-like: supports row[key]. dict already does; subclass for clarity."""
    pass


def make_row(**overrides):
    """Build a CDR row with sensible defaults, overridable per test."""
    base = {
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
        "hangup_cause": "NORMAL_CLEARING",
        "sip_code": 200,
        "carrier_used": "primary",
        "traffic_grade": "standard",
        "freeswitch_node": "fs-media-v2",
        "sbc_id": "sbc-1",
        "rate_per_min": Decimal("0.010000"),
        "total_cost": Decimal("0.009500"),
        "carrier_cost": Decimal("0.004000"),
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

    # uuid / call_id verbatim
    assert parts[field_index["call_id"]] == "abc-123-uuid"
    # timestamp -> deterministic UTC ISO-8601 with trailing Z, no microseconds
    assert parts[field_index["start_time"]] == "2026-07-24T15:04:05Z"
    # duration_ms 60000 -> 60 seconds
    assert parts[field_index["duration_sec"]] == "60"
    # billable_ms 57000 -> 57 seconds
    assert parts[field_index["billable_sec"]] == "57"
    # money -> 6dp
    assert parts[field_index["total_cost"]] == "0.009500"


def test_formatter_none_becomes_empty_string():
    fmt = EquinoxFormatter()
    row = make_row(answer_time=None, trunk_id=None, rate_per_min=None,
                   total_cost=None, carrier_cost=None, sbc_id=None)
    parts = fmt.format_record(row).split(",")
    idx = {name: i for i, name in enumerate(FIELDS)}
    for key in ("answer_time", "trunk_id", "rate_per_min", "total_cost",
                "carrier_cost", "sbc_id"):
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
