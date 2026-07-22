# Database Backups — Services VM

**Why this exists:** the 2026-07 platform audit found ZERO backup mechanisms.
The services VM holds the only copy of every customer, DID→forward_to mapping
(the product itself), trunk, rate table, and 90 days of CDRs (billing
evidence). One lost disk = the business's data gone. This directory turns that
into a layered, boring, alertable backup system — encoded in the repo per the
"host config lives in git" rule (PG/PgBouncer run bare on the VM via systemd,
so these are host artifacts installed by scripts, not Docker).

## The layers

| Layer | What | Schedule | Where | Restores |
|---|---|---|---|---|
| 1. `pg_dump` nightly | Logical dump + globals | daily 07:17 UTC | `gs://<bucket>/pgdump/` (35-day lifecycle) | Anywhere, any PG16+TSDB — crude but universal. RPO ≤ 24h |
| 2. **pgBackRest PITR** | Weekly full + daily diff + continuous WAL archiving | full Sun / diff Mon–Sat 05:45 UTC / WAL continuous | `gs://<bucket>/pgbackrest/` (4 fulls retained) | Point-in-time to any second. **RPO ≈ ≤ 5 min** (archive_timeout=300) |
| 3. CDR archive | Month exports of `cdrs` before the 90-day TimescaleDB purge | monthly 1st 06:30 UTC | `gs://<bucket>/cdr-archive/` (kept long-term) | Billing evidence outlives retention |
| 4. Disk snapshots | GCE snapshot schedule on the services boot disk | daily, 14-day retention | GCP snapshots | Whole-VM last resort (crash-consistent) |

Failures page: every unit has `OnFailure=revup-alert@…` → a `revup-alert`
syslog line → Ops Agent → Cloud Logging → the `infra/monitoring` log-match
alert policy → your notification channel. The slot-WAL watchdog
(`slot_wal_guard.sh`, every 15 min) additionally pages BEFORE a dead sandbox
standby's replication slot fills the prod disk.

## Activation — run on the SERVICES VM, in order (single lines)

Prereq once from your workstation: create the bucket + snapshot schedule
(`infra/backups/` — see its README): `cd infra/backups && tofu init && tofu apply`

1. `cd /opt/revup && sudo git pull`
2. `sudo apt-get update && sudo apt-get install -y pgbackrest`
3. `sudo /opt/revup/scripts/backup/preflight.sh` — fix anything it FAILs (esp. VM scopes/IAM)
4. `sudo /opt/revup/scripts/backup/setup_pgbackrest.sh` — applies PG settings; will tell you to restart PG once (`archive_mode` needs it; ~5–10 s of failed new-call lookups, active calls unaffected)
5. `sudo systemctl restart postgresql@16-main` — during a quiet minute
6. `sudo /opt/revup/scripts/backup/setup_pgbackrest.sh` — second pass: stanza-create + end-to-end `check`
7. `sudo -u postgres pgbackrest --stanza=main --type=full backup` — first full, right now
8. `sudo /opt/revup/scripts/backup/install_backup_timers.sh` — installs + enables all timers
9. `sudo systemctl start revup-pgdump.service` — smoke-test the nightly dump immediately
10. `sudo -u postgres /opt/revup/scripts/backup/cdr_archive_monthly.sh` — archive the last two months now

Then **schedule the restore drill** (this week, then quarterly):
`docs/runbooks/DB_RESTORE_RUNBOOK.md`. A backup you have not restored is not
a backup.

## Verifying state (any time)

- `sudo -u postgres pgbackrest --stanza=main info` — backups + WAL archive status
- `systemctl list-timers 'revup-*'` — schedules armed
- `gcloud storage ls gs://revup-db-backups/pgdump/ | tail -5` — recent dumps
- `sudo -u postgres psql -xc "SELECT archived_count, last_archived_time, failed_count FROM pg_stat_archiver"` — WAL archiving healthy (failed_count should not grow)

## Files here

| File | Purpose |
|---|---|
| `pg_dump_nightly.sh` | Layer 1 — nightly `pg_dump -Fc` + globals → GCS, integrity-checked |
| `pgbackrest.conf` | Layer 2 — pgBackRest → GCS config (installed to `/etc/pgbackrest/`) |
| `setup_pgbackrest.sh` | Staged, idempotent pgBackRest bring-up (ALTER SYSTEM + stanza + check) |
| `cdr_archive_monthly.sh` | Layer 3 — idempotent month exports of `cdrs` → GCS |
| `slot_wal_guard.sh` | Replication-slot retained-WAL watchdog → `revup-alert` |
| `install_backup_timers.sh` | Installs `/etc/revup/backup.env`, all systemd units, enables timers |
| `preflight.sh` | Verifies PG settings, scopes/IAM, bucket writability, disk headroom |
| `backup.env.example` | Config template for `/etc/revup/backup.env` (no secrets) |
| `systemd/` | The unit + timer definitions (source of truth for the schedule) |

## Design notes / gotchas

- **GCS auth is keyless** — the VM's attached service account via the metadata
  server (`repo1-gcs-key-type=auto`, `gcloud storage` on the VM). No JSON keys
  on disk. The catch: legacy VMs often carry `devstorage.read_only` scopes,
  which silently blocks writes — `preflight.sh` detects this and prints both
  fixes (scope change = VM restart = brief new-call outage; or a dedicated SA
  key for pgBackRest only).
- **TimescaleDB + pg_dump:** restoring a logical dump REQUIRES
  `timescaledb_pre_restore()` / `timescaledb_post_restore()` and a matching
  TimescaleDB version — the runbook has the exact sequence. pgBackRest restores
  (physical) have no such caveat, which is one more reason it is the primary
  recovery path.
- **`max_slot_wal_keep_size='16GB'`** is set by `setup_pgbackrest.sh`: a dead
  standby now invalidates its slot at 16 GB retained instead of filling the
  prod disk. If that fires, re-clone the sandbox standby
  (`infra/replica/README.md`); the watchdog pages you well before at 8 GiB.
- **Disk snapshots are crash-consistent, not application-consistent.** PG will
  crash-recover from one, but pgBackRest/pg_dump are the authoritative paths;
  snapshots exist to recover the whole VM (OS, PgBouncer config, `.env`).
- **CDR ingest still has a silent-loss path** (API returns 200 on failed
  insert — by design, to stop FS retry storms). Backups can't recover rows
  that never landed; the CDR dead-letter spool is a tracked backend work item.
