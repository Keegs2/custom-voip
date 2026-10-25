-- ==========================================================================
-- 58_vm_outage_resilience.sql
-- Voicemail survives an East outage (Visual IVR plan D11, §7.5) — the
-- zone-local mailbox check FreeSWITCH falls back to when the East API cannot
-- answer GET /v1/voicemail/fs/mailbox/{id}.
--
-- Contract: docs/IVR_INTERFACES.md §8.4; design:
-- docs/VOICEMAIL_OUTAGE_RESILIENCE.md. Requires 54_voicemail.sql.
--
-- WHAT THIS DOES (one transaction, idempotent — CREATE OR REPLACE + guarded
-- grants, so a re-run is a no-op):
--   1. VIEW vm_fs_mailbox — ONE row per live (status <> 'deleted') mailbox:
--        mailbox_id, did, customer_id, status, accepting, max_message_seconds,
--        reason
--      `accepting` / `reason` are the SAME rules as the API's
--      GET /fs/mailbox/{id} (docker/api/src/services/voicemail/mailboxes.py:
--      MAILBOX_SELECT's per-mailbox stats + accepting_state()):
--        * not accepting, reason 'inactive' — mailbox status <> 'active' OR
--          the customer's voicemail_enabled is false (inactive wins over full);
--        * not accepting, reason 'full' — live (untrashed) stored messages
--          >= max_messages, OR stored bytes INCLUDING trash >= max_bytes;
--        * else accepting, reason NULL.
--      The caps are per-mailbox columns (voicemail_boxes.max_messages /
--      max_bytes / max_message_seconds, 54). If accepting_state() or
--      MAILBOX_SELECT ever change, change this view in the same PR —
--      tests/test_voicemail_outage_migration58.py compares the two over every
--      branch. A deleted mailbox has NO row (the API answers 404 for it), so
--      FreeSWITCH plays `unavailable` exactly as on a 404.
--      `reason` is not in the contract's column list (§8.4): FreeSWITCH needs
--      it to choose `mailbox_full` vs `unavailable`, the same choice it makes
--      from the API's `reason`. Appended last so the contract columns keep
--      their order.
--   2. Grants, role-guarded (an unguarded GRANT aborts the migration on a
--      cluster without the role — see 47's header): freeswitch = SELECT on
--      the view ONLY. The view runs with its owner's rights, so FreeSWITCH
--      still has NO grant on any voicemail_* table (54) — it sees six
--      routing facts per mailbox and nothing else (no caller data, no
--      counts, no PIN, no greeting). api, grafana_ro and PUBLIC get nothing:
--      24_grafana_ro's ALTER DEFAULT PRIVILEGES hands grafana_ro SELECT on
--      every new relation the superuser creates, views included, so the
--      REVOKE is load-bearing, not cosmetic.
--
-- COST: FreeSWITCH reads it only when the East API lookup has failed (an
-- outage), as an id point lookup on voicemail_boxes plus a scan of that one
-- mailbox's stored messages (idx_vm_messages_mailbox_created; <= max_messages
-- + trash rows) — the same plan as the API's MAILBOX_SELECT.
--
-- LOCKING: CREATE OR REPLACE VIEW takes ACCESS EXCLUSIVE on the view only
-- (a new object on first apply). No table is locked or rewritten; nothing on
-- the RCF/trunk call path reads this view. lock_timeout makes a re-run fail
-- fast instead of queueing behind a reader of the view; on a timeout, just
-- re-run the file.
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. Apply MANUALLY on the bare-metal East primary (services VM,
-- 10.142.0.103) as a SUPERUSER; it replicates to every zone replica:
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/58_vm_outage_resilience.sql
-- Apply BEFORE the media VMs pull the FreeSWITCH Lua that reads it. Order
-- does not matter for safety: the Lua treats a missing view (or relation
-- permission error) as "replica unavailable" and keeps today's defaults, and
-- the API never reads the view.
--
-- Verification (after applying):
--     sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql
--     sudo -u postgres psql -d voip -c "SELECT has_table_privilege('freeswitch', 'vm_fs_mailbox', 'SELECT') AS fs_select, has_table_privilege('grafana_ro', 'vm_fs_mailbox', 'SELECT') AS grafana_select;"
--   Expect fs_select = t, grafana_select = f.
--
-- Down (safe at any time; FreeSWITCH then falls back to today's defaults):
--     DROP VIEW IF EXISTS vm_fs_mailbox;
-- ==========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. vm_fs_mailbox — mirror of MAILBOX_SELECT (stats) + accepting_state().
--    Keep the two in lock-step (see the header).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vm_fs_mailbox AS
SELECT
    b.id                                                        AS mailbox_id,
    b.did                                                       AS did,
    b.customer_id                                               AS customer_id,
    b.status                                                    AS status,
    -- accepting_state(): inactive (status / entitlement) first, then full.
    CASE
        WHEN b.status <> 'active' OR NOT c.voicemail_enabled THEN false
        WHEN COALESCE(s.message_count, 0) >= b.max_messages
          OR COALESCE(s.bytes_used, 0) >= b.max_bytes          THEN false
        ELSE true
    END                                                         AS accepting,
    b.max_message_seconds                                       AS max_message_seconds,
    CASE
        WHEN b.status <> 'active' OR NOT c.voicemail_enabled THEN 'inactive'
        WHEN COALESCE(s.message_count, 0) >= b.max_messages
          OR COALESCE(s.bytes_used, 0) >= b.max_bytes          THEN 'full'
        ELSE NULL
    END::varchar(16)                                            AS reason
  FROM voicemail_boxes b
  JOIN customers c ON c.id = b.customer_id
  -- MAILBOX_SELECT's per-mailbox stats, verbatim: live = untrashed stored
  -- messages; bytes = every stored message INCLUDING trash.
  LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE m.deleted_at IS NULL) AS message_count,
               sum(m.size_bytes)                            AS bytes_used
          FROM voicemail_messages m
         WHERE m.mailbox_id = b.id AND m.status = 'stored'
  ) s ON true
 WHERE b.status <> 'deleted';

COMMENT ON VIEW vm_fs_mailbox IS
    'FreeSWITCH zone-replica fallback for GET /v1/voicemail/fs/mailbox/{id} '
    '(58_vm_outage_resilience.sql). accepting/reason mirror '
    'services/voicemail/mailboxes.py accepting_state(); change both together.';

-- ---------------------------------------------------------------------------
-- 2. Grants (role-guarded, pattern of 54/56).
-- ---------------------------------------------------------------------------
REVOKE ALL ON vm_fs_mailbox FROM PUBLIC;
DO $$
DECLARE
    r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['api', 'grafana_ro'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON vm_fs_mailbox FROM %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freeswitch') THEN
        REVOKE ALL ON vm_fs_mailbox FROM freeswitch;
        GRANT SELECT ON vm_fs_mailbox TO freeswitch;
    END IF;
END $$;

COMMIT;
