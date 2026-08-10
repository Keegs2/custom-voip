-- ==========================================================================
-- 36_onboarding_products.sql
-- onboarding_requests: add the `products` JSONB column — product-aware
-- intake. Applicants select one or more products (rcf / trunk / api /
-- voicemail) and supply the setup information each selected product needs
-- to provision (e.g. trunk signaling IPs — the platform is IP-peering only,
-- no REGISTER auth, so the PBX/SBC public IPs are required up front).
--
-- STORED SHAPE (written by routers/onboarding.py, form_version pins it):
--   {
--     "selected": ["rcf"|"trunk"|"api"|"voicemail", ...],   -- >=1, no dupes
--     "rcf": {                                  -- present iff 'rcf' selected
--       "did_count", "porting", "current_carrier"?, "forwarding_setup"
--     } | null,
--     "trunk": {                              -- present iff 'trunk' selected
--       "signaling_ips": [...],               -- 1-10, IP/CIDR validated
--       "concurrent_call_paths",              -- 1-1000
--       "pbx_vendor"?, "dids_needed"?
--     } | null,
--     "api": {                                  -- present iff 'api' selected
--       "use_case", "expected_cps"?, "webhook_url"?, "needs_numbers"
--     } | null,
--     "voicemail": {                      -- present iff 'voicemail' selected
--       "mailbox_count",                      -- 1-10000
--       "attach_to"                -- 'existing_numbers'|'new_numbers'|'unsure'
--     } | null,
--     "form_version": "products-v1"
--   }
--
-- NULLABLE: rows submitted before this migration have no products data
-- (products IS NULL); the API tolerates them but REQUIRES products on all
-- NEW submissions.
--
-- LEGACY COLUMNS: the top-level RCF-ish columns (did_count, porting,
-- current_carrier, forwarding_setup) become NULLABLE — non-RCF submissions
-- have no values for them. When 'rcf' IS selected, the API backfills them
-- from products.rcf so old admin queries stay meaningful.
--
-- No GIN index: onboarding volume is low, admin reads are by id/status.
--
-- IDEMPOTENT: safe to re-run (ADD COLUMN IF NOT EXISTS; DROP NOT NULL is a
-- no-op on an already-nullable column; COMMENT is last-writer-wins).
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. Apply MANUALLY on the bare-metal prod primary (services VM,
-- 10.142.0.103), then let it replicate:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/36_onboarding_products.sql
-- ==========================================================================

ALTER TABLE onboarding_requests
    ADD COLUMN IF NOT EXISTS products JSONB;

-- Non-RCF submissions carry no legacy RCF fields.
ALTER TABLE onboarding_requests ALTER COLUMN did_count DROP NOT NULL;
ALTER TABLE onboarding_requests ALTER COLUMN porting DROP NOT NULL;
ALTER TABLE onboarding_requests ALTER COLUMN forwarding_setup DROP NOT NULL;

COMMENT ON COLUMN onboarding_requests.products IS
    'Product-aware intake (products-v1): '
    '{selected:[rcf|trunk|api|voicemail,...],'
    'rcf:{did_count,porting,current_carrier?,forwarding_setup}|null,'
    'trunk:{signaling_ips,concurrent_call_paths,pbx_vendor?,dids_needed?}|null,'
    'api:{use_case,expected_cps?,webhook_url?,needs_numbers}|null,'
    'voicemail:{mailbox_count,attach_to}|null,form_version}. '
    'Each product block is present iff selected. NULL only on rows submitted '
    'before product selection existed; required on new submissions. Legacy '
    'top-level columns (did_count/porting/current_carrier/forwarding_setup) '
    'are backfilled from products.rcf when rcf is selected.';

-- No new grants required: `api` already has ALL on onboarding_requests
-- (19_onboarding_requests.sql); a column addition inherits table grants.
