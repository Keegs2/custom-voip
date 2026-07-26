-- ==========================================================================
-- 22_number_routing.sql
-- On-net (internal) routing oracle: the `number_routing` view.
--
-- Single UNION ALL over the three product DID tables (rcf_numbers / api_dids /
-- trunk_dids) joined to `customers`, exposing one canonical column set so the
-- FreeSWITCH Lua resolver can answer a single question on the call path:
-- "is this destination number one of OUR DIDs, and if so, whose / which product?"
--
-- Each product DID table already has a UNIQUE(did) + a hash index on `did`
-- (idx_rcf_did_lookup / idx_api_did_lookup / idx_trunk_did_lookup), so a
-- `WHERE did = $1` equality against this view pushes into each arm's hash
-- index -> 3 point lookups + small joins to customers = sub-millisecond, and
-- yields exactly 0 or 1 row (a DID lives in at most one product table).
--
-- DESIGN RULE (do NOT change): this view is deliberately UNFILTERED on
-- enabled/active. The resolver must distinguish:
--   * "not ours"  (0 rows)            -> keep the existing carrier path
--   * "ours but disabled/suspended"   (row present, product_enabled=false or
--                                       customer_status<>'active') -> HARD REJECT
-- Filtering enabled/active here would collapse those two cases into "0 rows"
-- and silently send a disabled on-net DID back out to the carrier. The Lua
-- handler (db_client.resolve_destination + inbound_router terminators) owns the
-- enabled/active decision. See docs/ONNET_ROUTING_DESIGN.md sections 1, 2, 6.
--
-- Route off the PRODUCT tables, NOT did_inventory: did_inventory's
-- product_ref_id / customer_id are reconcile-maintained and can lag, which
-- would mis-route / mis-bill. did_inventory stays inventory-only.
--
-- PRODUCTION NOTE: Postgres init scripts in this directory ONLY run on the
-- first initdb of a fresh data directory. The production primary already
-- exists, so this migration must be APPLIED MANUALLY on the bare-metal prod
-- primary (services VM, 10.142.0.103):
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/22_number_routing.sql
-- A view is a schema object and replicates to every physical standby
-- automatically (it must exist on the primary BEFORE any replica is re-cloned).
-- It reads each zone's LOCAL replica -- same lag window the inbound path
-- already lives with.
--
-- Canonical columns (all three arms produce identical types; NULLs are cast so
-- UNION ALL type resolution is unambiguous):
--   did, product_type, customer_id, product_ref_id, product_enabled,
--   customer_status, forward_to, pass_caller_id, ring_timeout, max_channels,
--   product_name, voice_url, fallback_url, trunk_id
-- ==========================================================================

CREATE OR REPLACE VIEW number_routing AS
    -- ---- RCF ------------------------------------------------------------
    SELECT
        r.did                          AS did,
        'rcf'::varchar(20)             AS product_type,
        r.customer_id                  AS customer_id,
        r.id                           AS product_ref_id,
        r.enabled                      AS product_enabled,
        c.status                       AS customer_status,
        r.forward_to                   AS forward_to,
        r.pass_caller_id               AS pass_caller_id,
        r.ring_timeout                 AS ring_timeout,
        r.max_channels                 AS max_channels,
        r.name                         AS product_name,
        NULL::varchar(512)             AS voice_url,
        NULL::varchar(512)             AS fallback_url,
        NULL::int                      AS trunk_id
    FROM rcf_numbers r
    JOIN customers c ON c.id = r.customer_id

    UNION ALL

    -- ---- API DID --------------------------------------------------------
    SELECT
        a.did                          AS did,
        'api'::varchar(20)             AS product_type,
        a.customer_id                  AS customer_id,
        a.id                           AS product_ref_id,
        a.enabled                      AS product_enabled,
        c.status                       AS customer_status,
        NULL::varchar(20)              AS forward_to,
        NULL::boolean                  AS pass_caller_id,
        NULL::int                      AS ring_timeout,
        NULL::int                      AS max_channels,
        NULL::varchar(100)             AS product_name,
        a.voice_url                    AS voice_url,
        a.fallback_url                 AS fallback_url,
        NULL::int                      AS trunk_id
    FROM api_dids a
    JOIN customers c ON c.id = a.customer_id

    UNION ALL

    -- ---- Trunk DID ------------------------------------------------------
    -- product_enabled comes from sip_trunks.enabled (trunk DIDs have no
    -- per-DID enable flag); max_channels / product_name also come from the
    -- parent trunk. customer_id resolves via the trunk.
    SELECT
        td.did                         AS did,
        'trunk'::varchar(20)           AS product_type,
        t.customer_id                  AS customer_id,
        td.id                          AS product_ref_id,
        t.enabled                      AS product_enabled,
        c.status                       AS customer_status,
        NULL::varchar(20)              AS forward_to,
        NULL::boolean                  AS pass_caller_id,
        NULL::int                      AS ring_timeout,
        t.max_channels                 AS max_channels,
        t.trunk_name                   AS product_name,
        NULL::varchar(512)             AS voice_url,
        NULL::varchar(512)             AS fallback_url,
        td.trunk_id                    AS trunk_id
    FROM trunk_dids td
    JOIN sip_trunks t ON t.id = td.trunk_id
    JOIN customers c ON c.id = t.customer_id;

-- Hot-path read access for the FreeSWITCH Lua resolver and the API.
GRANT SELECT ON number_routing TO freeswitch, api;

-- Verification (run manually after applying on the primary):
--   Confirm 0/1-row point lookup and that each arm uses its DID hash index:
--     EXPLAIN SELECT * FROM number_routing WHERE did = '+16174544217';
--   Expect three `Index Scan using idx_{rcf,api,trunk}_did_lookup` nodes.
