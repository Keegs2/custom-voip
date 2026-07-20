-- Migration: Least-Cost Outbound (LCO) rate deck + carrier policy + lco_route contract
-- ============================================================================
-- Backs the LCO engine (services/lco.py, services/rate_deck.py, routers/lco.py):
--   * carrier_rate_decks       — per-carrier destination-prefix cost, effective-dated,
--                                jurisdiction-aware. Drives cheapest-first selection.
--   * customer_carrier_policy  — per-customer carrier allow/deny + quality (priority)
--                                overrides.
--   * lco_route (VIEW)         — THE telephony contract surface. FreeSWITCH's
--                                synchronous PG path reads this and longest-prefix-
--                                matches it. Columns are FIXED (see below).
--   * lco_decide(destination)  — SQL convenience: returns the failover-ordered,
--                                cheapest-first carrier list for a dialed number
--                                (customer-agnostic base LCO). FS may call this
--                                instead of hand-rolling the longest-prefix match.
--
-- ---- TELEPHONY CONTRACT (do NOT rename/retype without coordinating) ----------
-- View  : lco_route
-- Cols  : prefix VARCHAR, carrier_id INT, pop_ip VARCHAR, x_carrier_value VARCHAR,
--         priority INT, cost_per_min DECIMAL
--   prefix          — destination digits (no '+'); longest match wins.
--   carrier_id      — carrier_gateways.id.
--   pop_ip          — carrier_gateways.sip_proxy (outbound bridge target IP).
--   x_carrier_value — carrier_gateways.gateway_name; the token FS stamps into the
--                     X-Carrier / X-LCO-Route header so Kamailio picks the carrier.
--                     (If Kamailio expects a different token than gateway_name,
--                      tell the API owner — the view maps it in ONE place.)
--   priority        — lower = preferred (quality/steering tie-break before cost).
--   cost_per_min    — carrier cost; cheapest wins when priority ties.
--
-- Recommended FS longest-prefix match (index-served, scales):
--   SELECT * FROM lco_decide('18005551212');            -- ordered failover list
-- or, hand-rolled with generated candidate prefixes ($2 = left-substrings of $1):
--   SELECT carrier_id, pop_ip, x_carrier_value, priority, cost_per_min
--     FROM lco_route
--    WHERE prefix = ANY($2::text[])                     -- equality -> uses idx
--    ORDER BY LENGTH(prefix) DESC, priority ASC, cost_per_min ASC;
-- (Reverse-LIKE `$dest LIKE prefix||'%'` also works but seq-scans the deck.)
-- Per-customer allow/deny + overrides are applied by the API origination path
-- (services.lco.decide_lco_route); the base view/function is customer-agnostic.
--
-- Idempotent + apply-by-hand (see the tollfree migration header for rationale).
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/migrations/2026-07-01_lco_rate_deck.sql
-- ============================================================================
BEGIN;

-- --------------------------------------------------------------------------
-- Carrier rate deck: cost to terminate to a destination prefix, per carrier.
-- Effective-dated + jurisdiction-aware so decks can be versioned without
-- deleting history.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carrier_rate_decks (
    id              BIGSERIAL PRIMARY KEY,
    carrier_id      INT NOT NULL REFERENCES carrier_gateways(id) ON DELETE CASCADE,
    prefix          VARCHAR(20) NOT NULL,               -- destination digits, no '+'
    description     VARCHAR(100),
    cost_per_min    DECIMAL(10,6) NOT NULL DEFAULT 0,
    jurisdiction    VARCHAR(12) NOT NULL DEFAULT 'default'
                        CHECK (jurisdiction IN ('interstate','intrastate','intl','default')),
    priority        INT NOT NULL DEFAULT 100,           -- lower = preferred (quality/steering)
    effective_date  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,                        -- NULL = no expiry
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT carrier_rate_deck_unique UNIQUE (carrier_id, prefix, jurisdiction, effective_date)
);

-- Default-opclass btree on prefix: serves the equality longest-match
-- (prefix = ANY(candidate_prefixes)) — the scalable LCO lookup path.
CREATE INDEX IF NOT EXISTS idx_rate_deck_prefix         ON carrier_rate_decks(prefix);
CREATE INDEX IF NOT EXISTS idx_rate_deck_carrier_prefix ON carrier_rate_decks(carrier_id, prefix);
-- text_pattern_ops supports the baseline savings report's forward `prefix LIKE 'const%'`.
CREATE INDEX IF NOT EXISTS idx_rate_deck_prefix_pat     ON carrier_rate_decks(prefix text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_rate_deck_active         ON carrier_rate_decks(prefix, enabled) WHERE enabled = true;

COMMENT ON TABLE carrier_rate_decks IS
    'Per-carrier destination-prefix cost deck (effective-dated, jurisdiction-aware). Feeds the lco_route contract view and services.lco decisions.';

-- --------------------------------------------------------------------------
-- Per-customer carrier policy: allow/deny + optional quality (priority) override.
--   mode='deny'  -> carrier excluded for this customer (deny always wins).
--   mode='allow' -> if ANY allow rows exist, selection is restricted to them
--                   (whitelist), minus any denies.
--   priority_override -> forces this carrier's rank (lower = preferred) for the
--                        customer regardless of cost (quality steering).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_carrier_policy (
    id                BIGSERIAL PRIMARY KEY,
    customer_id       INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    carrier_id        INT NOT NULL REFERENCES carrier_gateways(id) ON DELETE CASCADE,
    mode              VARCHAR(10) NOT NULL CHECK (mode IN ('allow','deny')),
    priority_override INT,                              -- lower = preferred; NULL = use deck priority
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT customer_carrier_policy_unique UNIQUE (customer_id, carrier_id)
);

CREATE INDEX IF NOT EXISTS idx_ccp_customer ON customer_carrier_policy(customer_id);

-- --------------------------------------------------------------------------
-- lco_route — the telephony contract VIEW (always fresh; no refresh lag).
-- DISTINCT ON collapses effective-dated / multi-jurisdiction rows to ONE current
-- rate per (carrier, prefix): prefer 'default' jurisdiction, then newest
-- effective, then cheapest.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW lco_route AS
SELECT DISTINCT ON (rd.carrier_id, rd.prefix)
       rd.prefix               AS prefix,
       rd.carrier_id           AS carrier_id,
       cg.sip_proxy            AS pop_ip,
       cg.gateway_name         AS x_carrier_value,
       rd.priority             AS priority,
       rd.cost_per_min         AS cost_per_min
  FROM carrier_rate_decks rd
  JOIN carrier_gateways cg ON cg.id = rd.carrier_id
 WHERE rd.enabled = true
   AND cg.enabled = true
   AND rd.effective_date <= NOW()
   AND (rd.expires_at IS NULL OR rd.expires_at > NOW())
 ORDER BY rd.carrier_id, rd.prefix,
          (rd.jurisdiction = 'default') DESC, rd.effective_date DESC, rd.cost_per_min ASC;

COMMENT ON VIEW lco_route IS
    'TELEPHONY CONTRACT: longest-prefix-match this for Least-Cost Outbound. Columns: prefix, carrier_id, pop_ip, x_carrier_value, priority, cost_per_min. See lco_decide().';

-- --------------------------------------------------------------------------
-- lco_decide(destination) — cheapest-first, failover-ordered carrier list for a
-- dialed number. Keeps each carrier's LONGEST matching prefix, then orders by
-- priority then cost. Customer-agnostic (base LCO); the API applies per-customer
-- allow/deny + overrides on top.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lco_decide(p_destination VARCHAR)
RETURNS TABLE(carrier_id INT, pop_ip VARCHAR, x_carrier_value VARCHAR,
              priority INT, cost_per_min DECIMAL, prefix VARCHAR)
LANGUAGE SQL STABLE
AS $$
    WITH digits AS (
        SELECT regexp_replace(COALESCE(p_destination, ''), '\D', '', 'g') AS d
    ),
    cand AS (
        SELECT left(dg.d, g.n) AS p
        FROM digits dg, LATERAL generate_series(1, length(dg.d)) AS g(n)
        WHERE dg.d <> ''
    ),
    matched AS (
        SELECT DISTINCT ON (lr.carrier_id)
               lr.carrier_id, lr.pop_ip, lr.x_carrier_value,
               lr.priority, lr.cost_per_min, lr.prefix
        FROM lco_route lr
        WHERE lr.prefix IN (SELECT p FROM cand)
        ORDER BY lr.carrier_id, LENGTH(lr.prefix) DESC
    )
    SELECT carrier_id, pop_ip, x_carrier_value, priority, cost_per_min, prefix
    FROM matched
    ORDER BY priority ASC, cost_per_min ASC, carrier_id ASC;
$$;

COMMENT ON FUNCTION lco_decide(VARCHAR) IS
    'Cheapest-first, failover-ordered LCO carrier list for a dialed number (base/customer-agnostic). Rows: carrier_id, pop_ip, x_carrier_value, priority, cost_per_min, prefix.';

-- --------------------------------------------------------------------------
-- Grants. FS reads lco_route on the synchronous call path (mirror how other
-- FS-read tables are granted). Base-table SELECT to freeswitch too, so the view
-- resolves regardless of a future security_invoker flip.
-- --------------------------------------------------------------------------
GRANT ALL           ON carrier_rate_decks, customer_carrier_policy TO api;
GRANT SELECT        ON carrier_rate_decks                          TO freeswitch;
GRANT SELECT        ON lco_route                                   TO freeswitch, api;
GRANT USAGE, SELECT ON carrier_rate_decks_id_seq, customer_carrier_policy_id_seq TO api;
GRANT EXECUTE ON FUNCTION lco_decide(VARCHAR) TO freeswitch, api;

COMMIT;
