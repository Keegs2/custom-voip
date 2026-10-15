-- EXPLAIN for GET /v1/cdrs/activity as the RCF admin console sends it:
--   staff (admin/support), range=90d, "All Customers" (no customer_id),
--   tz=America/New_York, product_type=rcf, no destination.
-- The statement below is byte-for-byte services/cdr_activity.py
-- build_activity_query() for those params, with the binds substituted:
--   $1 lo, $2 hi, $3 bucket-start instants (ascending timestamptz[]), $4 'rcf'.
-- The binds are computed "as of now" exactly like compute_window(): NY local
-- today; lo = NY midnight 89 days back; hi = next NY midnight; edges = NY
-- Monday midnights from the Monday on/before lo through this week's Monday.
-- They are materialised with \gset first so the planner sees CONSTANTS (as
-- with the API's bound parameters -> custom plan, plan-time chunk exclusion),
-- not now()-relative stable expressions.
--
-- Run (read-only; EXPLAIN ANALYZE executes the SELECT):
--   sudo -u postgres psql -d voip -f /opt/revup/scripts/db/explain_cdr_activity_90d.sql

SELECT ((now() AT TIME ZONE 'America/New_York')::date - 89)::timestamp AT TIME ZONE 'America/New_York' AS lo,
       ((now() AT TIME ZONE 'America/New_York')::date + 1)::timestamp AT TIME ZONE 'America/New_York' AS hi,
       ARRAY(SELECT g AT TIME ZONE 'America/New_York'
               FROM generate_series(date_trunc('week', ((now() AT TIME ZONE 'America/New_York')::date - 89)::timestamp),
                                    date_trunc('week', (now() AT TIME ZONE 'America/New_York')::date::timestamp),
                                    interval '1 week') AS g)::text AS edges
\gset
\echo lo = :lo
\echo hi = :hi
\echo edges = :edges

SET statement_timeout = '30s';

EXPLAIN (ANALYZE, BUFFERS, TIMING)
WITH f AS (
    SELECT (width_bucket(start_time, :'edges'::timestamptz[]) - 1) AS b,
           (answer_time IS NOT NULL AND COALESCE(duration_ms, 0) > 0) AS ans,
           call_quality_grade AS grade,
           call_quality_status AS qstatus,
           call_mos::float8 AS mos,
           duration_ms::float8 AS dur_ms
      FROM cdrs
     WHERE start_time >= :'lo'::timestamptz AND start_time < :'hi'::timestamptz AND leg IS DISTINCT FROM 'B' AND product_type = 'rcf'::varchar
)
SELECT (GROUPING(b) = 1) AS is_total,
       b,
       count(*) AS calls,
       count(*) FILTER (WHERE ans) AS answered,
       count(*) FILTER (WHERE grade IS NOT NULL) AS graded,
       count(*) FILTER (WHERE grade IN ('great', 'good')) AS good_or_better,
       count(*) FILTER (WHERE grade = 'poor') AS poor,
       count(*) FILTER (WHERE qstatus = 'no_rtp') AS one_way,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY mos)
           FILTER (WHERE grade IS NOT NULL AND qstatus = 'rated' AND mos IS NOT NULL)
           AS median_mos,
       avg(dur_ms) FILTER (WHERE ans) / 1000.0 AS avg_duration_sec
  FROM f
 GROUP BY GROUPING SETS ((b), ());
