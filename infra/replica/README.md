# Phase 1 — Sandbox read-replica of the prod DID inventory

Stands up a PostgreSQL **physical streaming standby** of the prod East primary,
co-located on the sandbox VM, so the sandbox reads the real DID inventory
read-only and can never write back to prod. See `docs/SHARED_DID_INVENTORY_PLAN.md`.

Ground truth (verified 2026-06-19): prod is bare-metal **PG16 + TimescaleDB
2.26.3**, `wal_level=replica`, listens on the VPC IP `10.142.0.103:5432` — so
**no prod restart is needed**. Sandbox VPC IP: `10.142.0.102`.

## Step 1 — Prod primary (services VM, `10.142.0.103`)

Pick two strong **alphanumeric** passwords (no `:` or `\`). Create the roles + slot:

```
sudo -u postgres psql -v repl_pw=REPLPASS -v invro_pw=INVROPASS -f /opt/revup/infra/replica/prod_enable_replication.sql
```

Allow the standby to stream (one `pg_hba` line, then **reload** — not restart):

```
echo "host replication replicator 10.142.0.102/32 scram-sha-256" | sudo tee -a /etc/postgresql/16/main/pg_hba.conf
```
```
sudo -u postgres psql -c "SELECT pg_reload_conf();"
```

## Step 2 — Sandbox VM (`fs-media` / `34.24.231.249`)

Put the secrets + replica wiring in `/opt/revup/.env` (NOT git):

```
REPL_PASSWORD=REPLPASS
REPLICA_PRIMARY_HOST=10.142.0.103
INVENTORY_READ_URL=postgresql://inventory_ro:INVROPASS@postgres-replica:5432/voip
```

Pull, then start the standby (it clones prod via `pg_basebackup` on first boot):

```
cd /opt/revup && sudo git pull && sudo docker compose --profile replica up -d --build postgres-replica
```

Watch it clone + reach streaming:

```
sudo docker logs -f voip-postgres-replica   # expect "clone complete; starting as hot standby"
```

## Step 3 — Verify replication

On **prod**, the slot should be active and streaming:
```
sudo -u postgres psql -xc "SELECT slot_name, active, wal_status FROM pg_replication_slots WHERE slot_name='sandbox_replica'; SELECT application_name, state, sync_state, replay_lag FROM pg_stat_replication;"
```

On the **sandbox**, the standby should be in recovery and serving reads:
```
sudo docker exec voip-postgres-replica su-exec postgres psql -tAc "SELECT pg_is_in_recovery();"   # expect t
sudo docker exec voip-postgres-replica su-exec postgres psql -d voip -tAc "SELECT count(*) FROM did_inventory;"
```

End-to-end lag check — write on prod, read on the replica:
```
# prod:
sudo -u postgres psql -d voip -c "UPDATE did_inventory SET allocated_env=allocated_env WHERE did=(SELECT did FROM did_inventory LIMIT 1);"
# sandbox (should reflect within ~1s):
sudo docker exec voip-postgres-replica su-exec postgres psql -d voip -xc "SELECT now()-pg_last_xact_replay_timestamp() AS replay_lag;"
```

## Step 4 — Point the API at the replica

With `INVENTORY_READ_URL` set (Step 2), recreate the API so its inventory reads +
the allocation guard consult the replica (prod's source of truth):

```
cd /opt/revup && sudo docker compose up -d api
```
```
sudo docker logs voip-api 2>&1 | grep "Inventory read pool"   # expect "(separate replica)" now, not "falling back"
```

To formally allocate the test DID to the sandbox (so the guard permits routing it),
set it on **prod** (the owner): `UPDATE did_inventory SET allocated_env='sandbox' WHERE did='+17743260301';`

## Notes / ops

- The standby image is pinned to `timescale/timescaledb:2.26.3-pg16` to match prod's
  TimescaleDB exactly (physical standby must boot identical extension binaries).
  Replica PG is 16.13 — must be **>=** prod's PG16 minor; bump the tag if prod is newer.
- The `sandbox_replica` slot retains WAL on prod while the standby is down. If you
  retire the sandbox, drop it: `SELECT pg_drop_replication_slot('sandbox_replica');`
- The standby is read-only; the sandbox keeps its own writable `voip-postgres` for
  routing + CDRs. `DATABASE_URL` → local writable; `INVENTORY_READ_URL` → replica.
