-- ==========================================================================
-- 35_onboarding_kyc.sql
-- onboarding_requests: add the `kyc` JSONB column — FCC Know-Your-Customer
-- data captured on the public intake form.
--
-- REGULATORY BASIS: FCC KYC FNPRM, adopted 2026-04-30 (FCC 26-27).
-- Originating voice service providers must COLLECT, VERIFY, and RETAIN
-- (for 4 YEARS) for ALL customers:
--   - legal name
--   - physical address
--   - government-issued identification number
--   - alternate telephone number
-- and, for HIGH-VOLUME customers, additionally:
--   - intended use of service (marketing, education, political campaign, ...)
--   - the IP address(es) from which calls will be placed
-- (The FCC has not yet fixed the high-volume threshold — comment sought —
--  so high-volume status is self-declared on the form for now.)
--
-- STORED SHAPE (written by routers/onboarding.py, form_version pins it):
--   {
--     "standard": {
--       "legal_business_name", "address_line1", "address_line2"?,
--       "city", "state", "postal_code",
--       "address_is_registered_agent_or_virtual",   -- red-flag self-disclosure
--       "gov_id_type" ('ein'|'state_registration'|'duns'|'other'),
--       "gov_id_number", "state_of_registration"?, "alternate_phone",
--       "website"?
--     },
--     "high_volume": {                               -- null unless high-volume
--       "intended_use", "intended_use_description"?,
--       "originating_ips": [...], "expected_daily_calls"?
--     } | null,
--     "submitted_at": "<ISO-8601 UTC>",
--     "form_version": "fcc-26-27-fnprm-v1"
--   }
--
-- NULLABLE: rows submitted before this migration have no KYC data (kyc IS
-- NULL); the API tolerates them but REQUIRES kyc on all NEW submissions.
--
-- RETENTION: FCC 26-27 requires 4-year retention — do NOT purge onboarding
-- rows (even rejected ones) younger than 4 years. Retention enforcement is
-- operational policy, not implemented in-schema.
--
-- No GIN index: onboarding volume is low, admin reads are by id/status.
--
-- IDEMPOTENT: safe to re-run (ADD COLUMN IF NOT EXISTS; COMMENT is
-- last-writer-wins).
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. Apply MANUALLY on the bare-metal prod primary (services VM,
-- 10.142.0.103), then let it replicate:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/35_onboarding_kyc.sql
-- ==========================================================================

ALTER TABLE onboarding_requests
    ADD COLUMN IF NOT EXISTS kyc JSONB;

COMMENT ON COLUMN onboarding_requests.kyc IS
    'FCC KYC data (FCC 26-27 FNPRM, adopted 2026-04-30): '
    '{standard:{legal_business_name,address_line1,address_line2?,city,state,'
    'postal_code,address_is_registered_agent_or_virtual,gov_id_type,'
    'gov_id_number,state_of_registration?,alternate_phone,website?},'
    'high_volume:{intended_use,intended_use_description?,originating_ips,'
    'expected_daily_calls?}|null,submitted_at,form_version}. '
    'NULL only on rows submitted before KYC capture existed; required on new '
    'submissions. RETAIN 4 YEARS per FCC 26-27 (operational policy — do not '
    'purge rows younger than 4 years, including rejected ones).';

-- No new grants required: `api` already has ALL on onboarding_requests
-- (19_onboarding_requests.sql); a column addition inherits table grants.
