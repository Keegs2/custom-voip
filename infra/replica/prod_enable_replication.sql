-- ==========================================================================
-- prod_enable_replication.sql  —  run ONCE on the PROD primary (services VM).
--
-- Enables a physical read-replica (the sandbox standby) to stream from prod.
-- NO restart required: wal_level=replica, max_wal_senders/slots, hot_standby
-- are already set, and PG already listens on the VPC IP (verified 2026-06-19).
-- This creates the roles + slot only; the pg_hba line + reload is a file edit
-- documented in infra/replica/README.md.
--
-- Invoke (substitute strong ALPHANUMERIC passwords — no ':' or '\' so the
-- standby's .pgpass parses cleanly):
--   sudo -u postgres psql -v repl_pw=REPLPASS -v invro_pw=INVROPASS \
--        -f prod_enable_replication.sql
--
-- Idempotent: safe to re-run (uses NOT EXISTS guards via \gexec).
-- ==========================================================================
\set ON_ERROR_STOP on

-- 1) Streaming replication role (used by the standby's walreceiver).
SELECT format('CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD %L', :'repl_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator')
\gexec

-- 2) Read-only role the SANDBOX API uses to read inventory FROM the standby
--    (the standby is a copy of prod, so this role + its grants replicate to it).
SELECT format('CREATE ROLE inventory_ro WITH LOGIN PASSWORD %L', :'invro_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inventory_ro')
\gexec

-- 3) Durable physical replication slot — retains WAL while the standby is
--    disconnected so it can always catch back up (drop it if the standby is
--    ever decommissioned, or unused WAL will accumulate on prod).
SELECT pg_create_physical_replication_slot('sandbox_replica')
  WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'sandbox_replica');

-- 4) Least-privilege read grants for inventory_ro, in the voip database.
\connect voip
GRANT CONNECT ON DATABASE voip TO inventory_ro;
GRANT USAGE ON SCHEMA public TO inventory_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO inventory_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO inventory_ro;

\echo '--- roles + slot ---'
SELECT rolname, rolreplication FROM pg_roles WHERE rolname IN ('replicator','inventory_ro') ORDER BY 1;
SELECT slot_name, slot_type, active FROM pg_replication_slots WHERE slot_name = 'sandbox_replica';
