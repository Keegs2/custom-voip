# DB Failover Runbook — promote the East standby when the prod primary is lost

**When:** the `services` VM (prod primary `10.142.0.103`, us-east1-b) is down or unrecoverable.
**Standby:** `east-db-standby` (`10.142.0.87`, us-east1-c) — streaming physical replica, PG16 + TimescaleDB 2.26.3, slot `east_standby`.
**Priority:** restore the **call path** first (FreeSWITCH does a per-call DID lookup against the DB), then the management plane.
**Legend:** 🟢 SAFE · 🟠 IMPACT · 🔴 IRREVERSIBLE.

## 0. Pre-check + fence the old primary
- 🟢 Standby healthy? `sudo -u postgres psql -tAc "SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn();"` → expect `t` + a recent LSN.
- 🔴 **Fence the old primary to prevent split-brain.** If the `services` VM is reachable-but-broken, stop it so it can never accept writes again: `gcloud compute instances stop services --zone=us-east1-b`. Two primaries accepting writes = data corruption.

## 1. Promote the standby (the fast part — seconds)
```
sudo -u postgres pg_ctlcluster 16 main promote
sudo -u postgres psql -tAc "SELECT pg_is_in_recovery();"   # expect f — now a read-write PRIMARY
```
The standby is now the primary at `10.142.0.87:5432` on a new timeline.

## 2. Restore call routing (repoint FreeSWITCH + SBCs) — 🟠
The media/SBC VMs point `DB_HOST` at the dead primary (`10.142.0.103:6432`). Repoint to the new primary. Emergency path is direct‑to‑PG (no PgBouncer; the standby's `max_connections=300` absorbs it):
- On the **FreeSWITCH VM** (and each SBC that queries the DB): set `DB_HOST=10.142.0.87` and `DB_PORT=5432` in `/opt/revup/.env`, then `cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d` (SBCs: `-f docker-compose.sbc.yml`).
- Verify: a test call to `+16174544217` routes → DID lookup works against the new primary. **Call path restored.**

## 3. Restore the management plane (API / UI / Homer)
These ran on the dead `services` VM. Bring them up on the standby VM (or a fresh VM) pointing at the local promoted PG (`DATABASE_URL` → `localhost`/`127.0.0.1:5432`, or a PgBouncer you install there). Non-call-path — do after step 2.

## 4. Re-arm safety on the NEW primary
- 🟢 Backups: the new primary needs its own WAL archiving + base backup. Re-run `sudo /opt/revup/scripts/backup/setup_pgbackrest.sh` (stage 2), `--type=full backup`, `install_backup_timers.sh`. (Same bucket is fine — pgBackRest handles the new timeline.)
  - ⚠️ **Do this promptly.** The promoted box inherits `archive_mode=on` + prod's `archive_command` (copied by `pg_basebackup`), which FAILS until pgBackRest is configured here — validated in the 2026-07-22 test (`archive-push` errored on the new timeline). A failing `archive_command` makes PG **retain WAL** (pg_wal grows). If you can't configure pgBackRest immediately: `sudo -u postgres psql -c "ALTER SYSTEM SET archive_mode=off"` then restart to stop the buildup, and re-enable once pgBackRest is set up.
- 🟢 Monitoring: add the new primary VM to `infra/monitoring` (uptime/VM alerts) + install the Ops Agent.

## 5. Rebuild a new standby
The old `services` primary diverged (different timeline) — rebuild it (or a fresh VM) as the new standby by repeating the Phase 1 clone (`pg_basebackup -R --slot=…` from the promoted primary). If the old standby will never return, drop its slot on the primary so WAL doesn't accumulate: `SELECT pg_drop_replication_slot('east_standby');`.

## Make failover FAST (pre-stage — recommended follow-up)
Today the standby is DB-only, so steps 2–4 take minutes. To turn failover into a ~seconds promote + repoint:
- **Pre-install PgBouncer** on the standby (so `DB_PORT=6432` works the instant it's promoted — no app env change).
- **Pre-clone `/opt/revup` + Docker** on the standby so the API/UI/Homer stack starts immediately.
- **Patroni** for *automatic* promotion + a floating VIP (Phase 4) — removes the human from the loop entirely.

## Caveats
- **Split-brain is the cardinal sin** — always fence the old primary (step 0) before/at promote.
- The `sandbox_replica` slot feeds fs-media; after a promote, re-point or drop it.
- Nothing external points at the DB (Bandwidth → SBCs → FS → DB), so only the internal `DB_HOST` changes — no DNS/carrier work.

## Failover-test log (drill this like the restore — promote on a quiet day, then rebuild)
| Date | Operator | Promote time | Verified read-write + data | Notes |
|---|---|---|---|---|
| 2026-07-22 | Keegan | **0.143 s** (`pg_ctlcluster 16 main promote`) | ✅ read-write (INSERT ok) + data intact (1 customer / 337 cdrs) | Isolated test (prod stayed primary); rebuilt back to a streaming standby via fresh `pg_basebackup` (self-heals). Finding: promoted box inherited prod's `archive_command` but had no pgBackRest config → archiving the new timeline failed (benign in test; Step 4 handles it for real). |
