-- grafana_ro — read-only role for the Production NOC Grafana dashboards.
--
-- Backs docker/homer/grafana/provisioning/datasources/postgres.yml (uid
-- voip-cdr-pg). Grafana's infra "Database & Replication" dashboard and the
-- voice-product CDR dashboards connect as this role to the East PRIMARY
-- (10.142.0.103), which holds all zones' CDRs + the replication state.
--
-- Grants are the MINIMUM the dashboards need:
--   * SELECT on the CDR/analytics tables + active_calls + the RCF routing table.
--   * pg_monitor membership so the DB dashboard can read pg_stat_replication
--     (replica lag), pg_stat_activity (connection counts), pg_stat_database,
--     and pg_database_size() WITHOUT superuser. pg_monitor is a built-in role
--     (pg_read_all_stats + pg_read_all_settings + pg_stat_scan_tables).
-- The role is LOGIN + NOSUPERUSER + NOCREATEDB + NOCREATEROLE and has NO write
-- privileges anywhere. Analytics only.
--
-- IDEMPOTENT: role creation is guarded, table grants loop over only the tables
-- that exist (so this is safe on any branch — e.g. did_inventory may be absent
-- on some checkouts), and pg_monitor GRANT is a no-op if already a member.
--
-- PRODUCTION NOTE: Postgres init scripts in this directory ONLY run on the first
-- initdb of a fresh data directory. The production primary already exists, so
-- this migration must be APPLIED MANUALLY on the bare-metal prod primary
-- (services VM, 10.142.0.103):
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/24_grafana_ro.sql
-- Run it as a SUPERUSER (postgres) — GRANT pg_monitor and CREATE ROLE both
-- require it. It replicates to the standbys as a global (roles are cluster-wide),
-- but the grafana datasource only ever connects to the PRIMARY.
--
-- SET THE PASSWORD after creating the role (do NOT commit a password here):
--     sudo -u postgres psql -d voip -c "ALTER ROLE grafana_ro PASSWORD 'THE_PASSWORD_FROM_ENV';"
-- The same value goes in /opt/revup/.env as GRAFANA_DB_PASSWORD (consumed by the
-- voip-cdr-pg datasource via secureJsonData).

-- ---------------------------------------------------------------------------
-- Role — create if missing, and (re)assert the safe attribute set every run.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        -- No password set here on purpose — the operator sets it via ALTER ROLE
        -- (see header). A LOGIN role with no password cannot connect until then,
        -- which is the safe default.
        --
        -- INHERIT is REQUIRED (not NOINHERIT): Grafana runs every query directly
        -- as grafana_ro without issuing SET ROLE. pg_stat_replication's lag
        -- columns (sent/write/flush/replay LSN + *_lag) are gated by
        -- pg_read_all_stats, which is only ACTIVE in the session if the role
        -- INHERITs its pg_monitor membership. With NOINHERIT the DB dashboard
        -- would see replica rows but NULL lag columns — silently useless.
        CREATE ROLE grafana_ro LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE grafana_ro LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- pg_monitor — lets grafana_ro read replication + activity stats (no superuser).
-- ---------------------------------------------------------------------------
GRANT pg_monitor TO grafana_ro;

-- ---------------------------------------------------------------------------
-- Read grants on the analytics surface.
-- ---------------------------------------------------------------------------
-- Loop so a missing optional table (e.g. did_inventory on a lean checkout) does
-- not abort the migration. `rcf_numbers` is this platform's DID→forward_to
-- routing table (the task's "number_routing"); `did_inventory` is the broader
-- number inventory. Both are granted when present.
DO $$
DECLARE
    tbl TEXT;
    read_targets TEXT[] := ARRAY[
        'cdrs',
        'cdr_hourly_stats',
        'cdr_daily_stats',
        'active_calls',
        'number_routing',  -- on-net routing oracle VIEW (22_number_routing.sql)
        'rcf_numbers',     -- RCF DID -> forward_to routing table
        'api_dids',        -- API DIDs (product/DID labels)
        'trunk_dids',      -- trunk DIDs (product/DID labels)
        'did_inventory',   -- full number inventory (optional on some branches)
        'customers'        -- needed to label CDR rows by customer in dashboards
    ];
BEGIN
    FOREACH tbl IN ARRAY read_targets LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = tbl
        ) THEN
            EXECUTE format('GRANT SELECT ON public.%I TO grafana_ro', tbl);
        END IF;
    END LOOP;
END
$$;

-- Schema usage is required to reference the tables above.
GRANT USAGE ON SCHEMA public TO grafana_ro;

-- Make future tables in public readable too, so new analytics tables do not
-- need a manual re-grant. Applies only to tables created by the role running
-- this script (the superuser/owner); harmless if that is the case.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_ro;
