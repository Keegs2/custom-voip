# CDR Export Forwarder

Standalone module/process that reads unexported CDRs from PostgreSQL and uploads
them as **Equinox-format** files to a **FileMage** gateway over **plain FTP**
(port 21, internal, behind firewall). Each shipped CDR is watermarked
(`cdrs.exported_at`) so nothing is ever double-sent.

It is **decoupled from the FastAPI app** — never wired into the app lifespan or
routers, so it cannot destabilize the API or its `/health` contract. It runs as
its own process and initializes its own asyncpg pool via the shared
`db.database` module (`statement_cache_size=0`, explicit `::type` casts).

> **Status: scaffold.** The exact ~49-field Equinox layout is not yet available.
> The formatter ships a documented placeholder mapping — see **Format TODO**.

---

## Components

| File | Responsibility |
|------|----------------|
| `config.py` | `ExportConfig.from_env()` — all `CDR_EXPORT_*` env vars with defaults. Side-effect-free. |
| `formatter.py` | `EquinoxFormatter` — **isolated, pure**, one-file swap. `header()/format_record()/trailer()` + module-level `FIELDS`. |
| `ftp_client.py` | `FTPClient` — thin `ftplib` wrapper. `test_connection()`, `upload_bytes()`. Retries transient errors. **Never logs the password.** |
| `exporter.py` | `select_batch` / `build_file` / `send_batch` / `run_once` / `run_loop` / `dry_run`. Lease-based single-instance guard (`cdr_export_lock`). |
| `__main__.py` | argparse CLI: `test-connection`, `dry-run`, `run-once`, `run-loop`. |

DB objects live in `docker/postgres/init/21_cdr_export.sql`
(`cdrs.exported_at`, `idx_cdrs_unexported`, `cdr_export_log`).

---

## Environment variables

All are read by `ExportConfig.from_env()`. Defaults in parentheses.

### Feature flag
| Var | Default | Meaning |
|-----|---------|---------|
| `CDR_EXPORT_ENABLED` | `false` | **Master switch.** When false, `run-once`/`run-loop` no-op with a log line. `test-connection`/`dry-run` still work. |

### FTP / FileMage gateway
| Var | Default | Meaning |
|-----|---------|---------|
| `CDR_EXPORT_FTP_HOST` | `10.142.0.71` | FileMage gateway host. |
| `CDR_EXPORT_FTP_PORT` | `21` | FTP control port. |
| `CDR_EXPORT_FTP_USER` | _(empty)_ | FTP username. |
| `CDR_EXPORT_FTP_PASSWORD` | _(empty)_ | FTP password. **Never logged.** |
| `CDR_EXPORT_FTP_DIR` | `/` | Remote drop directory (cwd after login). |
| `CDR_EXPORT_FTP_PASSIVE` | `true` | Passive mode (recommended behind NAT/firewalls). |
| `CDR_EXPORT_FTP_TLS` | `false` | `false` = plain FTP. `true` = explicit FTPS (`FTP_TLS` + `PROT P`). |
| `CDR_EXPORT_FTP_TIMEOUT` | `30` | Socket timeout (seconds). |

### Batch / watermark
| Var | Default | Meaning |
|-----|---------|---------|
| `CDR_EXPORT_BATCH_SIZE` | `5000` | Max CDRs per file. |
| `CDR_EXPORT_LAG_SECONDS` | `120` | Only export rows with `end_time < now() - lag`, so in-flight ingests have settled. |
| `CDR_EXPORT_SKIP_EMPTY` | `true` | If no rows are due, do nothing (don't ship an empty file). |
| `CDR_EXPORT_INTERVAL_SECONDS` | `3600` | `run-loop` cadence. |
| `CDR_EXPORT_LOCK_TTL_SECONDS` | `900` | Single-instance lease TTL (`cdr_export_lock`). A crashed runner auto-recovers after this. Keep it safely longer than a worst-case cycle. |

### Filename
| Var | Default | Meaning |
|-----|---------|---------|
| `CDR_EXPORT_FILENAME_PREFIX` | `CDR_` | Filename prefix. |
| `CDR_EXPORT_FILENAME_EXT` | `.csv` | Filename extension. |
| `CDR_EXPORT_FILENAME_TS_FORMAT` | `%Y%m%d%H%M%S` | `strftime` for the timestamp segment. |

Filenames are `{prefix}{timestamp}_{8hex}{ext}` — the short uuid suffix avoids
collisions within the same second.

### Formatter (optional)
| Var | Default | Meaning |
|-----|---------|---------|
| `CDR_EXPORT_DELIMITER` | `,` | Field delimiter. |
| `CDR_EXPORT_QUOTE_ALL` | `false` | `true` = quote every field; `false` = minimal quoting. |

Plus the standard `DATABASE_URL` (same PgBouncer connection string the API uses).

---

## CLI commands

Run **inside the API container** on the services VM (WORKDIR is `/app`, which is
`src/`, so the module path is `services.cdr_export`):

```bash
# 1. FTP reachability + credentials + drop-dir listing (SAFE: no DB, no send)
sudo docker compose -f docker-compose.services.yml exec api \
  python -m services.cdr_export test-connection

# 2. Preview the next file: filename + first ~20 lines + row count
#    (SAFE: read-only — selects a batch, builds the file, uploads NOTHING,
#     marks NOTHING)
sudo docker compose -f docker-compose.services.yml exec api \
  python -m services.cdr_export dry-run

# 3. One real send cycle (respects CDR_EXPORT_ENABLED)
sudo docker compose -f docker-compose.services.yml exec api \
  python -m services.cdr_export run-once

# 4. Scheduled loop (respects CDR_EXPORT_ENABLED) — normally run as the
#    opt-in `cdr-exporter` compose service, not by hand
sudo docker compose -f docker-compose.services.yml exec api \
  python -m services.cdr_export run-loop
```

### Scheduled runner (opt-in compose service)

`docker-compose.services.yml` defines a `cdr-exporter` service that reuses the
API image and runs `run-loop`. It is gated behind the `cdr-export` profile, so
it does **not** start by default:

```bash
# Start ONLY the scheduled exporter (after setting CDR_EXPORT_* in .env, incl.
# CDR_EXPORT_ENABLED=true):
sudo docker compose -f docker-compose.services.yml --profile cdr-export up -d cdr-exporter

# Logs:
sudo docker compose -f docker-compose.services.yml logs -f cdr-exporter
```

---

## Staged first-send procedure

Do these **in order**. The first two are safe; only step 3 sends data.

1. **`test-connection`** — confirms the FileMage host/port/creds and drop dir.
   Fix credentials/firewall before proceeding.
2. **`dry-run`** — preview the exact file that would be sent (filename + first
   lines). **Reconcile the format with the real Equinox template here** before
   any real send (see Format TODO). Nothing is uploaded or marked.
3. **`run-once`** with `CDR_EXPORT_ENABLED=true` — ships exactly one batch.
   Verify the file landed on the FileMage side and that the rows are now
   watermarked:
   ```sql
   SELECT status, filename, row_count, sent_at FROM cdr_export_log ORDER BY created_at DESC LIMIT 5;
   SELECT count(*) FROM cdrs WHERE exported_at IS NULL;   -- should drop by row_count
   ```
4. Once verified, enable the scheduled `cdr-exporter` service (above).

---

## Delivery semantics — at least once

The FTP upload happens **between** two short DB operations (select, then mark);
no DB transaction is held open across the upload. If the process crashes **after**
a successful upload but **before** the watermark UPDATE, the same rows are
selected again next run and **re-sent**. Therefore:

> **Downstream MUST dedup on the CDR `uuid` (the `call_id` field).** It is a
> globally-unique BIGSERIAL-backed identifier. We deliberately prefer a possible
> duplicate file over a silently-dropped CDR — this is billing data.

A **single-instance guard** (a **TTL-based lease** row in `cdr_export_lock`)
ensures two runners (e.g. the loop container plus a manual `run-once`) never
double-send concurrently; the loser of the lease logs and skips its cycle. A
session-level advisory lock is deliberately **not** used: this app reaches
Postgres through **PgBouncer in transaction pooling mode**, where consecutive
autocommit statements can land on different backing server connections — so a
session lock is neither reliably held across the cycle nor safely released (it
can leak onto a pooled connection and silently wedge all future export cycles).
Claiming and releasing the lease are each a single autocommit `UPDATE`, which
**is** safe through transaction pooling. The lease TTL
(`CDR_EXPORT_LOCK_TTL_SECONDS`, default 900s) means a crashed runner
auto-recovers once the lease expires; release only clears the runner's own lease
(`WHERE locked_by = <owner>`).

---

## Compression / retention caveat

The `cdrs` hypertable **compresses chunks after 1 day** and has a **90-day
retention policy** (`05_schema_cdr.sql`). Implications:

- **Export promptly.** Any CDR still `exported_at IS NULL` after **90 days is
  dropped by retention and will never be exported.** Keep the loop running and
  watch `cdr_export_log` for `failed` rows and a growing unexported backlog:
  ```sql
  SELECT count(*), min(start_time) FROM cdrs WHERE exported_at IS NULL;
  ```
- The watermark UPDATE writes `exported_at` on already-inserted rows. On
  compressed chunks this still works (TimescaleDB supports DML on compressed
  chunks), but heavy back-marking of very old compressed data is slower — the
  lag/loop cadence keeps the working set on recent, uncompressed chunks.

---

## Format TODO

**The exact ~49-field Equinox specification is not yet available.** `formatter.py`
ships a **reasonable placeholder** CSV mapping from the confirmed `cdrs` columns
(call_id, timestamps, caller/destination, duration/billable seconds, hangup
cause, sip code, carrier, sbc, product/customer, and money fields). It is marked:

```python
# TODO: reconcile field order/format with the real ~49-field Equinox template
#       before go-live.
```

Before go-live, confirm with the operator and edit **only** `formatter.py`
(field order/labels, header/trailer presence, timestamp format, duration units,
money formatting) plus, if new source columns are needed, `SELECT_COLUMNS` in
`exporter.py`. The formatter is intentionally the single swap point.

### What the operator still needs to provide
- FileMage **FTP credentials** (`CDR_EXPORT_FTP_USER` / `CDR_EXPORT_FTP_PASSWORD`)
  and confirmation of the **host/port** (`10.142.0.71:21` assumed).
- The **remote drop directory** (`CDR_EXPORT_FTP_DIR`).
- The **real ~49-field Equinox field spec** (order, labels, formats) and the
  **filename convention** Equinox expects (prefix/extension/timestamp/sequence).
- Whether Equinox wants a **header row** and/or **trailer/checksum** record.
- Whether the transport must be **FTPS** (`CDR_EXPORT_FTP_TLS=true`) rather than
  plain FTP.
