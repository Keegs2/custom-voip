# DB Restore Runbook — Services VM (PostgreSQL 16 + TimescaleDB)

**Audience:** whoever is on the pager when the database is broken or gone.
**Companion:** `scripts/backup/README.md` (how backups are taken).
**Rule zero:** a backup you have not restored is not a backup. Run the
**drill** (last section) this week, then quarterly, and record the results at
the bottom of this file.

Impact reminder while you work: FreeSWITCH does a per-call PostgreSQL DID
lookup through this VM. While PG is down, **100% of new inbound RCF calls
fail** (active calls continue). Restore time is customer-visible outage time.

---

## Which scenario are you in?

| Scenario | Symptom | Use |
|---|---|---|
| A. Bad data change (fat-finger UPDATE/DELETE, bad migration) | PG up, data wrong | **PITR** to just before the change (§2) |
| B. PG corrupt / data dir lost, VM still fine | PG won't start | **pgBackRest restore** latest (§2, skip `--type=time`) |
| C. Whole VM / disk gone | VM unreachable | **New VM → pgBackRest** (§3); disk snapshot as fallback (§4) |
| D. pgBackRest repo unusable | GCS/pgBackRest broken | **pg_dump restore** (§5) — loses up to 24 h |
| E. Need CDRs older than 90 days | Billing dispute | **CDR archive** (§6) — no outage |

Before anything destructive: `sudo -u postgres pgbackrest --stanza=main info`
— confirm what you actually have (newest full/diff, last archived WAL).

---

## 1. Preconditions (all scenarios)

- Stop writers so nothing scribbles during restore (single lines):
  - `sudo docker stop voip-api` (on the services VM)
  - `sudo systemctl stop pgbouncer` (FS DID lookups will fail — this is the outage clock starting)
- Know your target: for PITR you need the timestamp **just before** the damage
  (UTC). CDR `created_at`, API audit logs, or Cloud Logging pin it down.

## 2. PITR / restore in place (scenarios A + B)

1. `sudo systemctl stop postgresql@16-main`
2. Move the old data dir aside (do NOT delete it yet):
   `sudo mv /var/lib/postgresql/16/main /var/lib/postgresql/16/main.broken.$(date -u +%s)`
3. Restore latest (B) — single line:
   `sudo -u postgres pgbackrest --stanza=main restore`
   …or to a point in time (A) — single line (edit the timestamp, UTC):
   `sudo -u postgres pgbackrest --stanza=main --type=time --target="2026-07-01 14:30:00+00" --target-action=promote restore`
4. `sudo systemctl start postgresql@16-main` — PG replays WAL to the target,
   then promotes. Watch: `sudo tail -f /var/log/postgresql/postgresql-16-main.log`
5. Verify (§7), then restart writers:
   `sudo systemctl start pgbouncer` and `sudo docker start voip-api`
6. **Place a test call to the live DID** (+16174544217 → should forward) —
   that is the real "restore worked" check.
7. After a PITR the timeline forked: take a fresh full backup immediately —
   `sudo -u postgres pgbackrest --stanza=main --type=full backup`

## 3. Total VM loss → rebuild (scenario C)

1. Recreate the VM (until the OpenTofu import exists, clone specs from
   `CLAUDE.md` GCP topology: e2-standard-4, `default` subnet, internal
   10.142.0.103, tags `lb-health-check,voip-services`, same service account —
   the internal IP matters: every other VM's `.env` points at it).
2. Install matching majors: PG16 + TimescaleDB (same or newer minor than the
   backup source — check `pgbackrest info`), PgBouncer, pgbackrest, Docker.
3. `sudo git clone <repo> /opt/revup` and restore `/opt/revup/.env` from the
   ops secret store (it is not in git — this is why the disk snapshot layer
   also exists).
4. Reinstall backup config: `sudo /opt/revup/scripts/backup/setup_pgbackrest.sh`
   (stage 1 gives you `/etc/pgbackrest/pgbackrest.conf`; skip its ALTER SYSTEM
   guidance until after restore).
5. `sudo systemctl stop postgresql@16-main`, empty the fresh data dir:
   `sudo -u postgres rm -rf /var/lib/postgresql/16/main/*`
6. `sudo -u postgres pgbackrest --stanza=main restore`
7. Start PG, verify (§7), re-point PgBouncer (`/etc/pgbouncer/pgbouncer.ini`
   — mirror of `docker/postgres/pgbouncer.ini`), start API/UI containers:
   `sudo docker compose -f docker-compose.services.yml up -d`
8. Re-run `sudo /opt/revup/scripts/backup/install_backup_timers.sh` and
   `setup_pgbackrest.sh` (second pass) so the NEW VM is itself backed up.

## 4. Disk-snapshot fallback (scenario C when pgBackRest is also gone)

- List snapshots: `gcloud compute snapshots list --filter="sourceDisk~services" --sort-by=~creationTimestamp --limit=5`
- New disk from snapshot: `gcloud compute disks create services-restored --zone=us-east1-b --source-snapshot=<SNAPSHOT_NAME>`
- Attach/boot a VM from it. PG performs crash recovery on start (snapshots
  are crash-consistent). Expect to lose everything after the snapshot time
  (RPO up to 24 h) — then §7, then rebuild the backup stack.

## 5. pg_dump restore (scenario D — last resort, RPO ≤ 24 h)

TimescaleDB logical restores have a REQUIRED sequence — do not skip steps:

1. Fetch newest dump: `gcloud storage ls -r gs://revup-db-backups/pgdump/ | tail -10`
   then `gcloud storage cp gs://revup-db-backups/pgdump/<TS>/voip_<TS>.dump /var/tmp/ && gcloud storage cp gs://revup-db-backups/pgdump/<TS>/globals_<TS>.sql.gz /var/tmp/`
2. Roles first: `zcat /var/tmp/globals_<TS>.sql.gz | sudo -u postgres psql -X`
   (ignore "role already exists" errors on a non-empty cluster)
3. Create the DB shell — single lines:
   - `sudo -u postgres psql -c "CREATE DATABASE voip"`  (drop the broken one first if replacing: `DROP DATABASE voip`)
   - `sudo -u postgres psql -d voip -c "CREATE EXTENSION IF NOT EXISTS timescaledb"`
4. `sudo -u postgres psql -d voip -c "SELECT timescaledb_pre_restore()"`
5. `sudo -u postgres pg_restore -d voip -j 4 /var/tmp/voip_<TS>.dump` —
   ownership restores correctly because step 2 recreated the original roles.
   (Only if you skipped globals and roles are missing, fall back to
   `pg_restore -d voip --no-owner -j 4` and re-grant per
   `docker/postgres/CLAUDE.md`.)
6. `sudo -u postgres psql -d voip -c "SELECT timescaledb_post_restore()"`
7. Verify (§7); recreate any objects newer than the dump from the API audit
   trail; take a full pgBackRest backup once the repo is healthy again.

## 6. CDR archive retrieval (scenario E)

- `gcloud storage ls gs://revup-db-backups/cdr-archive/` — one prefix per month
- `gcloud storage cp gs://revup-db-backups/cdr-archive/2026-05/cdrs_2026-05.csv.gz /var/tmp/`
- Integrity: compare `sha256sum` and row count against the month's `_COMPLETE` marker.
- Query without touching prod: load into any scratch PG:
  `CREATE TABLE cdrs_2026_05 (LIKE cdrs INCLUDING DEFAULTS);` then
  `\copy cdrs_2026_05 FROM PROGRAM 'zcat /var/tmp/cdrs_2026-05.csv.gz' WITH (FORMAT csv, HEADER)`

## 7. Post-restore verification checklist

Run every line; all must look sane before declaring victory:

- `sudo -u postgres psql -d voip -c "SELECT count(*) FROM customers"` — expected order of magnitude?
- `sudo -u postgres psql -d voip -c "SELECT count(*) FROM rcf_numbers"` — the product
- `sudo -u postgres psql -d voip -c "SELECT max(start_time) FROM cdrs"` — **this is your achieved RPO**; write it down
- `sudo -u postgres psql -d voip -c "SELECT did, forward_to FROM rcf_numbers WHERE did='+16174544217'"` — test DID intact
- `curl -s http://127.0.0.1:8088/health` — API up through PgBouncer
- Live test call: +16174544217 must forward to +17744045256
- `sudo -u postgres pgbackrest --stanza=main check` — the restored primary is archiving again

---

## The RESTORE DRILL (run one this week, then quarterly)

Restores fail at 3am because nobody ran them at 3pm. The drill restores prod
backups onto a scratch machine — **zero risk to production**.

1. Target: the sandbox/test VM (`infra/test`) or a temporary e2-standard-4.
   Do NOT run the drill on the services VM.
2. Install PG16 + TimescaleDB + pgbackrest on the target.
3. Copy `/etc/pgbackrest/pgbackrest.conf` from the services VM; the target
   VM's service account needs **read** on the bucket
   (`roles/storage.objectViewer` — grantable via `infra/backups`).
4. Restore with a throwaway data dir — single line:
   `sudo -u postgres pgbackrest --stanza=main --pg1-path=/var/lib/postgresql/16/drill restore`
   (add `--type=time --target="<5 minutes ago>" --target-action=promote` to
   exercise PITR — that is the mode you'll need in anger)
5. Start it on a side port — single line:
   `sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/16/drill -o "-p 5544" start`
6. Run §7's SQL checks against `-p 5544`. Record: restore duration (= your
   real RTO), `max(start_time)` from cdrs (= your real RPO), any surprises.
7. Separately drill the pg_dump path (§5) into a scratch DB at least once a
   year — the TimescaleDB pre/post_restore dance is where people get burned.
8. Tear down, then log it below.

### Drill gotchas (from the 2026-07-22 drill — these correct the steps above)
- **Debian keeps `postgresql.conf` / `pg_hba.conf` in `/etc/postgresql/16/main/`, NOT in the data dir**, so pgBackRest (which backs up only the data dir) does not restore them. `pg_ctl -D <datadir> start` (step 5) then fails with "could not access the server configuration file … postgresql.conf". Instead restore into `/var/lib/postgresql/16/main` (stop + clear the auto-created cluster first) and start with Debian's wrapper: `sudo pg_ctlcluster 16 main start`.
- **Before starting, append to `/etc/postgresql/16/main/postgresql.conf`:** `shared_preload_libraries = 'timescaledb'` (a fresh install doesn't set it → hypertables/`cdrs` unreadable), AND `max_worker_processes` / `max_connections` / `max_locks_per_transaction` / `max_prepared_transactions` / `max_wal_senders` **≥ the primary's** — recovery aborts with "recovery aborted because of insufficient parameter settings" otherwise (prod `max_worker_processes` = 23). **Same requirement applies to the West/Central streaming replicas.**
- WAL replay pulls segments from GCS via `restore_command` (pgBackRest `archive-get`); the target VM's SA needs bucket read — the default compute SA + `--scopes=cloud-platform` inherits the `objectAdmin` grant `infra/backups` makes, so no extra IAM.

### Drill log

| Date | Operator | Layer drilled | Restore time (RTO) | Data as-of (RPO) | Notes |
|---|---|---|---|---|---|
| 2026-07-22 | Keegan | pgBackRest physical (full + WAL) | ~15s data (6s restore + 7s WAL replay); full bare-box DR ~30min (VM create + PG/TimescaleDB install dominated) | ~2min (last txn 16:47:12Z; within 5-min archive_timeout) | ✅ Restored onto a clean e2-standard-4; byte-correct — Granite customer, test DID fwd `+17742184477` (current prod value), 337 cdrs, TimescaleDB intact. Hit the two gotchas above (Debian config layout; recovery params ≥ primary). |
