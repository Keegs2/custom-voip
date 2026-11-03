-- SIP number index (C-IDX-1) — phone number -> SIP Call-ID, filled at ingest.
--
-- WHY: a number search used to be a qryn LogQL substring scan of every
-- stored SIP message in the window ({type="sip"} |~ "<digits>"). A 7-day
-- search read 4.19 GiB of SIP text and died at the 3.73 GiB per-query memory
-- limit (ClickHouse Code 241, 2026-11-03). Call-ID searches were fine: they
-- use qryn's label index. This file gives numbers the same treatment.
--
-- WHAT: one small table of (day, number, role, call_id, first/last ns,
-- final INVITE response code) filled by a MATERIALIZED VIEW on qryn's
-- samples_v3 inserts. The API's number search reads only this table to get
-- Call-IDs, then fetches those calls by Call-ID exactly as before
-- (docker/api/src/routers/homer.py, homer_index.py). heplify and qryn are
-- untouched: qryn already runs its own MV on samples_v3 (metrics_15s_mv).
--
-- PREREQUISITE: materialized_views_ignore_errors = 1 live for qryn's user
-- (docker/homer/clickhouse-users.xml, written in place inside the container
-- and hot-reloaded — never restart ClickHouse for it) so a failing MV leaves
-- an index gap instead of failing qryn's insert.
--
-- APPLY (services VM, single line, idempotent — every statement is
-- IF NOT EXISTS / guarded, so re-running changes nothing):
--   sudo docker exec -i voip-clickhouse clickhouse-client --multiquery < /opt/revup/docker/homer/clickhouse/10_sip_number_index.sql
-- Statement order is the deploy order: coverage table -> index table -> MV
-- -> "MV started" coverage row. Then run the backfill
-- (scripts/homer/backfill_sip_number_index.sh, newest day first).
--
-- ROLLBACK — DROP THE VIEW FIRST, ALONE, AND VERIFY IT IS GONE. Dropping the
-- index table while the MV exists makes EVERY qryn insert fail (Code 60,
-- not covered by materialized_views_ignore_errors) and stops SIP capture.
--   1) sudo docker exec voip-clickhouse clickhouse-client --query "DROP VIEW IF EXISTS qryn.sip_number_index_mv"
--   2) sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() FROM system.tables WHERE database = 'qryn' AND name = 'sip_number_index_mv'"   (must print 0)
--   3) sudo docker exec voip-clickhouse clickhouse-client --multiquery --query "DROP TABLE IF EXISTS qryn.sip_number_index; DROP TABLE IF EXISTS qryn.sip_number_index_coverage"
-- The API notices within 60 s and falls back to the <=24 h scan.
--
-- NORMALIZATION (must match routers/homer_pipeline.normalize_number_needle):
--   user part of every sip:/sips:/tel: URI in the R-URI (requests only),
--   From (f), To (t), P-Asserted-Identity and Diversion -> drop %XX escapes
--   -> strip every non-ASCII-digit. 3..32 digits are kept. An 11-digit
--   number starting with 1 is stored TWICE: as-is and without the 1, so the
--   10-digit needle the API builds ("+1 (508) 728-2017" -> 5087282017) matches
--   exactly (primary key) and a partial that includes the 1 ("15087") matches
--   by substring. Roles (ruri/from/to/pai/diversion) come from the INITIAL
--   INVITE only; every other message stores its numbers as role 'other'.
--
-- INGEST SAFETY: the MV uses only total functions (substring, position,
-- extract/extractAll, replaceRegexpAll, toUInt16OrZero, array lambdas) that
-- return ''/[]/0 on any input — nothing here can throw on bad SIP text, so a
-- malformed or non-SIP row yields zero index rows, never a failed qryn
-- insert. Regex work is bounded: only the header block (before the first
-- blank line, at most 8 KiB) is read, the SDP body is never scanned.
-- Only SIP rows are indexed (first line is a SIP request or status line),
-- and OPTIONS / REGISTER (keepalives, scanners) are skipped.
--
-- IDEMPOTENT BY CONSTRUCTION: AggregatingMergeTree keyed (number, role,
-- call_id) with min / max / argMax only. Re-inserting the same messages
-- (backfill re-run, backfill overlapping the MV) changes nothing after a
-- merge, and every query GROUPs BY call_id anyway, so duplicates are never
-- visible.
--
-- RETENTION: qryn keeps samples 7 days (SAMPLES_DAYS default). Index and
-- coverage rows live 8 days (day + 8), whole day partitions dropped.

-- 1) Coverage: which days the backfill completed, and when the MV started.
--    The API derives index_covered_from from this table + system.tables.
CREATE TABLE IF NOT EXISTS qryn.sip_number_index_coverage
(
    kind        LowCardinality(String),   -- 'mv' | 'backfill'
    day         Date,                     -- backfilled UTC day ('mv': day created)
    started_at  DateTime64(3, 'UTC'),     -- backfill: before its first INSERT
    finished_at DateTime64(3, 'UTC'),
    index_rows  UInt64,
    note        String
)
ENGINE = ReplacingMergeTree(finished_at)
ORDER BY (kind, day)
-- Only backfill rows expire. The single 'mv' row must outlive any TTL: if it
-- were deleted, re-applying this file would write a new one at "now" and
-- collapse index_covered_from to the re-apply time.
TTL toDate(finished_at) + INTERVAL 9 DAY DELETE WHERE kind = 'backfill';

-- 2) The index.
CREATE TABLE IF NOT EXISTS qryn.sip_number_index
(
    day        Date,
    number     String,                                  -- digits only
    role       LowCardinality(String),                  -- ruri|from|to|pai|diversion (initial INVITE) | other
    call_id    String,                                  -- == qryn call_id label
    first_ns   SimpleAggregateFunction(min, Int64),
    last_ns    SimpleAggregateFunction(max, Int64),
    final_code AggregateFunction(argMax, UInt16, Int64) -- last final INVITE response (0 = none seen)
)
ENGINE = AggregatingMergeTree
PARTITION BY day
ORDER BY (number, role, call_id)
TTL day + INTERVAL 8 DAY
SETTINGS ttl_only_drop_parts = 1, index_granularity = 8192;

-- 3) The materialized view. The SELECT between the BEGIN/END markers is
--    also the backfill's SELECT: scripts/homer/backfill_sip_number_index.sh
--    reads it from this file and replaces the BACKFILL_RANGE marker with a
--    timestamp_ns range, so the MV and the backfill can never drift.
CREATE MATERIALIZED VIEW IF NOT EXISTS qryn.sip_number_index_mv
TO qryn.sip_number_index
AS
-- BEGIN sip_number_index extract
SELECT
    day,
    tupleElement(pair, 2) AS number,
    tupleElement(pair, 1) AS role,
    call_id,
    min(ts) AS first_ns,
    max(ts) AS last_ns,
    argMaxState(code, code_ts) AS final_code
FROM
(
    SELECT
        timestamp_ns AS ts,
        toDate(toDateTime(intDiv(timestamp_ns, 1000000000), 'UTC')) AS day,
        -- First line from the raw text: a cheap SIP test before any header
        -- work (anchored, stops at the first line break). No {m,n} bound here:
        -- RE2 expands bounded repetition into a huge automaton (measured 3x
        -- slower inserts).
        extract(string, '^([^\\r\\n]*)') AS line1,
        startsWith(line1, 'SIP/2.0 ') AS is_resp,
        match(line1, '^[A-Za-z]+ [^ ]+ SIP/2\\.0$') AS is_req,
        -- Header block only: up to the blank line, at most 8 KiB (position()
        -- scans in place, no copy). The SDP body is never read.
        substring(string, 1, if(position(string, '\r\n\r\n') BETWEEN 1 AND 8192, position(string, '\r\n\r\n'), 8192)) AS hdr,
        upper(extract(hdr, '(?mi)^cseq[ \\t]*:[ \\t]*[0-9]+[ \\t]+([A-Za-z]+)')) AS cseq_method,
        extract(hdr, '(?mi)^(?:call-id|i)[ \\t]*:[ \\t]*([^\\r\\n]*[^\\r\\n \\t])') AS call_id,
        if(is_resp, toUInt16OrZero(substring(line1, 9, 3)), toUInt16(0)) AS code,
        if(is_resp AND code >= 200 AND code NOT IN (401, 407) AND cseq_method = 'INVITE', ts, toInt64(0)) AS code_ts,
        -- Header values per role ('\n'-joined, compact forms f: t: included).
        if(is_req, line1, '') AS v_ruri,
        arrayStringConcat(extractAll(hdr, '(?mi)^(?:from|f)[ \\t]*:([^\\r\\n]*)'), '\n') AS v_from,
        arrayStringConcat(extractAll(hdr, '(?mi)^(?:to|t)[ \\t]*:([^\\r\\n]*)'), '\n') AS v_to,
        arrayStringConcat(extractAll(hdr, '(?mi)^p-asserted-identity[ \\t]*:([^\\r\\n]*)'), '\n') AS v_pai,
        arrayStringConcat(extractAll(hdr, '(?mi)^diversion[ \\t]*:([^\\r\\n]*)'), '\n') AS v_div,
        -- Roles are only meaningful on the INITIAL INVITE (a request with no
        -- To tag): on a callee-sent BYE / re-INVITE From and To are swapped
        -- and the R-URI is the caller's Contact. Every other message stores
        -- its numbers with role 'other' — still found by `number`, never by
        -- from_user / to_user.
        is_req AND cseq_method = 'INVITE' AND startsWith(line1, 'INVITE ') AND NOT match(v_to, '(?i);[ \\t]*tag[ \\t]*=') AS is_initial,
        -- URI user parts -> digits -> stored forms, per role (the role list is
        -- a lambda ARGUMENT: capturing a column inside a lambda makes
        -- ClickHouse copy it per array element). sip:/sips: need
        -- a user@ (a host-only URI such as sip:67.231.2.12 yields nothing),
        -- and user parameters (npdi, rn=...) are cut at the first semicolon.
        arrayMap((r, v) -> arrayMap(n -> (r, n), arrayFilter(n -> length(n) BETWEEN 3 AND 32, arrayFlatten(arrayMap(d -> if(length(d) = 11 AND startsWith(d, '1'), [d, substring(d, 2)], [d]), arrayMap(u -> replaceRegexpAll(replaceRegexpAll(u, '%[0-9A-Fa-f]{2}', ''), '[^0-9]', ''), arrayConcat(extractAll(v, '(?i)\\bsips?:([^@>,;?\\s]+)[^@>,?\\s]*@'), extractAll(v, '(?i)\\btel:([^;>,?\\s]+)'))))))), if(is_initial, ['ruri', 'from', 'to', 'pai', 'diversion'], ['other', 'other', 'other', 'other', 'other']), [v_ruri, v_from, v_to, v_pai, v_div]) AS per_role,
        arrayDistinct(arrayFlatten(per_role)) AS pairs
    FROM qryn.samples_v3
    WHERE (is_req OR is_resp)
      AND call_id != ''
      AND length(call_id) <= 512
      AND cseq_method NOT IN ('OPTIONS', 'REGISTER')
      /*BACKFILL_RANGE*/
)
ARRAY JOIN pairs AS pair
GROUP BY day, number, role, call_id
-- END sip_number_index extract
;

-- 4) Record when the MV started capturing (first apply only). The API also
--    reads the MV's own creation time from system.tables and uses the LATER
--    of the two, so a recreated MV can never overstate coverage.
INSERT INTO qryn.sip_number_index_coverage (kind, day, started_at, finished_at, index_rows, note)
SELECT 'mv', today(), now64(3, 'UTC'), now64(3, 'UTC'), 0, 'materialized view created'
WHERE (SELECT count() FROM qryn.sip_number_index_coverage WHERE kind = 'mv') = 0;
