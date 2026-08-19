-- ==========================================================================
-- 39_users_support_role.sql
-- users: allow role='support' (platform-wide read-only troubleshooting staff).
--
-- Support users authenticate like any other user but carry customer_id=NULL
-- and role='support' in their JWT. The API grants them READ on whitelisted
-- troubleshooting/quality endpoints (CDRs, attestations, Homer traces,
-- customer/trunk lists via require_support_or_admin / get_support_read_filter)
-- and 403s every write. Admin accounts stay reserved for the TED service
-- account + platform operators.
--
-- CONSTRAINT HANDLING: the original CHECK in 09_schema_users.sql is declared
-- inline on the role column, so PostgreSQL auto-named it `users_role_check`
-- ({table}_{column}_check — role is the only CHECK on that column, so no
-- collision suffix). DROP IF EXISTS + ADD by that name is therefore exact.
--
-- IDEMPOTENT: safe to re-run. Each run drops the named constraint and
-- recreates it; every role already present ('admin','user','readonly') is in
-- the new list, so revalidation cannot fail.
--
-- PRODUCTION NOTE: Postgres init scripts here ONLY run on the first initdb of
-- a fresh data directory (fresh volumes run this after 09 and upgrade the
-- constraint). The production primary already exists, so apply MANUALLY on the
-- bare-metal prod primary (services VM, 10.142.0.103), then let it replicate:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/39_users_support_role.sql
-- ==========================================================================

-- Allow role='support' (platform-wide read-only troubleshooting staff).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'user', 'readonly', 'support'));

-- No new grants required: `api` already has ALL on users (09_schema_users.sql);
-- a CHECK constraint change grants nothing new.
