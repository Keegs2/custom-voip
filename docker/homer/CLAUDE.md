# Homer 10 — SIP Capture & Debugging

## Overview

Homer 10 SIP monitoring stack for real-time SIP trace analysis and call debugging.
Receives HEP (Homer Encapsulation Protocol) packets from Kamailio and FreeSWITCH,
stores them in ClickHouse via qryn (Loki-compatible API), and provides Grafana
dashboards for SIP search and ladder diagram visualization.

This replaces the Homer 7 stack (PostgreSQL + homer-app) with a modern,
ClickHouse-backed architecture that scales better and uses Grafana for UI.

## Components

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| `voip-clickhouse` | clickhouse/clickhouse-server:23.3-alpine | 8123 (internal) | Columnar DB for SIP capture data (replaces Homer 7 Postgres) |
| `voip-qryn` | qxip/qryn:latest | 3100 (Loki API) | Loki-compatible API backed by ClickHouse (replaces homer-app backend) |
| `voip-heplify-server` | ghcr.io/sipcapture/heplify-server:1.60.3 | 9060 UDP/TCP, 9061 TCP | Receives HEP packets, pushes to qryn via Loki push API |
| `voip-grafana` | grafana/grafana-oss:10.4.3 | 3000 (HTTP) | Dashboards for SIP ladder diagrams (now a SECONDARY deep-link target, not the main UI) |

Image tags are pinned in `docker-compose.services.yml` (ClickHouse `23.3-alpine`, Grafana `grafana-oss:10.4.3`, heplify-server `1.60.3`). qryn tracks `:latest`.

## Architecture

```
HEP Sources (Kamailio, FreeSWITCH)
    |
    v  (UDP/TCP port 9060)
heplify-server
    |
    v  (Loki push API)
qryn (:3100)
    |
    v  (ClickHouse native)
clickhouse-server (:8123)
    |
    v  (Loki query API)
Grafana (:3000)
```

heplify-server receives HEP packets and pushes them to qryn's Loki-compatible
push endpoint. qryn stores data in ClickHouse.

**Primary SIP-debug UI is the React app, not Grafana.** The customer-facing
TroubleshootingPage (`docker/ui/app/src/pages/TroubleshootingPage.tsx`) POSTs to
`/api/homer/search`, which nginx proxies to the FastAPI Homer router
(`docker/api/src/routers/homer.py`, mounted at both `/homer` and `/v1/homer`).
A number search reads the ClickHouse **number index** (see "Number index" below)
when it covers the window, else qryn (LogQL) for windows of at most 24 h. The router
then queries ClickHouse **directly on port 8123** for A/B leg correlation and the
multi-Call-ID fetch (bypassing qryn's RE2 LogQL engine, which 500s on large regex
alternations).
Grafana is now a SECONDARY deep-link target for ad-hoc ladder inspection, not the
main entry point.

## A/B leg correlation (how a forwarded call becomes ONE ladder)

FreeSWITCH is a B2BUA: a forwarded call is one A leg (carrier -> FS) plus one B
leg **per carrier bridge attempt** (failover loop), each with its OWN SIP Call-ID.
The only wire link is the `X-CID: <A-leg SIP Call-ID>` header on every B-leg
INVITE (FS dial strings in `inbound_router.lua` / `trunk_outbound.lua`; Kamailio
re-adds it toward carriers), captured at FS-out, SBC-in and SBC-out.

**heplify does NOT correlate legs for us.** heplify-server 1.60.3 sets the Loki
`call_id` label to each packet's OWN Call-ID (`remotelog/loki.go`); `ALEGIDS=X-CID`
produces no A-leg label in qryn/ClickHouse. So the API reads X-CID out of the stored
SIP text itself (`docker/api/src/routers/homer.py` `_correlate_legs`, pure helpers
in `routers/homer_correlation.py`), from three bounded sources:

1. **Harvest (B -> A):** X-CID parsed (header-anchored, case-insensitive:
   `(?mi)^X-CID:[ \t]*([^\r\n]+)`) from every INVITE already fetched. A referenced
   A leg is fetched, so searching the forwarded-to number also pulls the A leg.
2. **ClickHouse scan (A -> B):** `qryn.samples_v3` restricted to each A call's own
   setup window `[first INVITE - 1 s, first final INVITE response + 2 s]`
   (in-progress call -> search end), `multiSearchAny` over <= 50 A Call-IDs per
   query, `extract()` of the X-CID value, fingerprint -> `call_id` via
   `qryn.time_series` (primary-key lookup). Finds the B legs of a masked caller.
3. **CDR cross-check:** `cdrs` rows with `leg='B'` and `call_id` = the A uuid (the
   A uuid IS the inbound SIP Call-ID: internal profile
   `inbound-use-callid-as-uuid=true`); the B `uuid` is the B SIP Call-ID. Finds a B
   leg whose INVITE capture was lost; supplies `leg_attempt`.

Every leg of every multi-leg call is then fetched by Call-ID (chunked, paginated).
The response carries `legs` (`role` / `a_callid` / `attempt`) and
`correlation_status` (`ok` | `partial` | `degraded`) + `correlation_reason` — a
failed or capped lookup is reported, never silently swallowed. There is no
window-wide `|~ "X-CID:"` qryn scan (the old one saw only the newest ~300 carrier
legs platform-wide) and no ">50 Call-IDs -> skip correlation" rule.
`GET /v1/homer/pcap?correlated=true` uses the same engine (all legs exported).

Verify the ClickHouse assumptions on the services VM (read-only):
`sudo docker exec voip-clickhouse clickhouse-client --query "SHOW CREATE TABLE qryn.samples_v3"`
(the scan relies on `timestamp_ns` being the ORDER BY / partition key and the
SIP text living in `string`), and
`sudo docker exec voip-clickhouse clickhouse-client --query "SELECT extract('A: 1\r\nx-cid: abc@h  \r\nB: 2', '(?mi)^X-CID:[ \\t]*([^\\r\\n]+)')"`
(must print `abc@h  ` — inline `(?mi)` flags honored by ClickHouse RE2).

## Number index (indexed number search, 2026-11-03)

**Why.** A number search was a qryn text scan of every stored SIP message in the
window (`{type="sip"} |~ "<digits>"`). On 2026-11-03 a 7-day search for
5087282017 read 4.19 GiB of SIP text and died at the 3.73 GiB per-query limit
(ClickHouse Code 241) -> qryn 500 -> API 502. Call-ID searches were fine: they
use qryn's label index. The index gives numbers the same shape.

**What.** `docker/homer/clickhouse/10_sip_number_index.sql` creates, in the `qryn`
database:

| Object | Role |
|---|---|
| `sip_number_index_coverage` | ReplacingMergeTree. One `'mv'` row (when the MV started) + one `'backfill'` row per completed UTC day. TTL 9 days. |
| `sip_number_index` | AggregatingMergeTree, `PARTITION BY day`, `ORDER BY (number, role, call_id)`, TTL day + 8 days. Columns: `number` (digits), `role` (`ruri`/`from`/`to`/`pai`/`diversion`), `call_id` (== qryn's `call_id` label), `first_ns`/`last_ns` (min/max), `final_code` (argMax state: last final INVITE response, 0 = none). |
| `sip_number_index_mv` | MATERIALIZED VIEW `TO sip_number_index` on `samples_v3` inserts. heplify and qryn are untouched (qryn already runs its own `metrics_15s_mv` on the same table). |

- **Extraction** (header block only — before the first blank line, at most 16 KiB; the
  SDP body is never read): the user part of every `sip:`/`sips:`/`tel:` URI in the
  Request-URI (requests only), From (`f:`), To (`t:`), P-Asserted-Identity and
  Diversion (several URIs per header handled); user parameters (`;npdi;rn=`) cut;
  `%XX` dropped; non-digits stripped; 3..32 digits kept. Only SIP rows (request or
  status first line) with a Call-ID (`Call-ID:` / `i:`, trimmed, <= 512 bytes);
  OPTIONS and REGISTER skipped. Contact, display names, SDP and X-headers are not
  indexed (a deliberate narrowing vs the old scan, which matched anywhere).
- **Normalization rule** (must stay identical to `routers/homer_pipeline.normalize_number_needle`):
  an 11-digit number starting with 1 is stored twice, as-is and without the 1. The
  API's needle (strip non-digits; exactly 11 digits with a leading 1 -> drop it) is
  matched by substring (`number LIKE '%<needle>%'`), so `5087282017`,
  `15087282017`, `+1 (508) 728-2017` and partials like `508`, `4217`, `15087` all
  find the same calls.
- **Roles:** `number` matches any role; `from_user` = From or PAI; `to_user` = To or
  R-URI. Several fields AND (the same call must match each).
- **No ngram/token bloom filter on `number`:** on a 10-symbol alphabet every
  8192-row granule holds essentially all 1,000 trigrams, so it skips nothing
  (EXPLAIN on 2M numbers: `Granules: 245/245` for `%508%` and `%5087282%`). The
  index is small instead (one row per distinct number/role/Call-ID per day), and a
  partial reads only the `number` column of the days in the window.
- **Ingest safety:** only total functions (no `JOIN`, no parser that can throw);
  bad text yields zero rows. Proven locally against ClickHouse 23.3.22 with 2,010
  junk/random-byte/oversized rows and 5,000 SIP-shaped random-byte messages: every
  insert succeeded. A throwing MV would fail qryn's insert and drop capture, so
  keep it that way (root `CLAUDE.md` Gotcha 18).
- **Ingest cost (local benchmark):** about 10-15 ms of ClickHouse CPU per qryn
  insert batch plus 5-7 us per message (+14 ms on a 200-row insert; 6.7 us/message
  at 20k-row inserts). At one qryn insert per second that is about 1.5% of one core.
  Measure the real insert rate with the read-only query under "Verify".
- **Idempotent:** min/max/argMax only, so re-inserting the same messages (a re-run
  backfill, the backfill overlapping the MV) changes nothing after a merge, and every
  read groups by `call_id`.

**Coverage (`index_covered_from`).** The MV start (the later of its
`system.tables.metadata_modification_time`, which survives restarts, and the `'mv'`
coverage row) extended back one whole UTC day at a time over days whose backfill
*started after* the MV, never older than today - 7 days. Before the backfill it is the
MV creation time; after a full backfill it is midnight UTC 7 days back. `GET
/v1/homer/search/capabilities` reports it.

**Search paths** (`routers/homer.py`, pure helpers `routers/homer_index.py`): `call_id`
-> label path (unchanged); index present and `start_time >= index_covered_from` ->
index (50 calls per page, newest first, whole calls per page, then the unchanged
fetch-by-Call-ID + correlation); otherwise the qryn scan only when `end_time -
start_time <= 24 h`, else 422 `window_too_wide`. A ClickHouse limit -> 422
`search_too_broad`. Index/capability reads run `readonly=2` with
`max_execution_time` 5 s, `max_memory_usage` 5e8, `max_bytes_to_read` 1e9; the
fetch/correlation reads 10 s / 2e9 / 4e9. qryn takes no per-query settings, so the
scan's cap is the 24 h window (~0.6 GiB/day in production vs the 3.73 GiB limit) and
a relayed memory/limit error maps to `search_too_broad`.

### Deploy (services VM, single lines, after Phase 2 of `docs/runbooks/MAINTENANCE_2026-11-03.md`)

Not during SBC flips or another step that loads the services VM. ClickHouse first, then the API.

1. `cd /opt/revup && sudo git pull`
2. Apply the DDL (tables -> MV -> "MV started" row; idempotent): `sudo docker exec -i voip-clickhouse clickhouse-client --multiquery < /opt/revup/docker/homer/clickhouse/10_sip_number_index.sql`
3. Check the MV is filling and qryn inserts are not failing (wait a minute):
   `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() AS rows, uniqExact(call_id) AS calls FROM qryn.sip_number_index"` (grows) and
   `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() FROM system.query_log WHERE type = 'ExceptionWhileProcessing' AND query_kind = 'Insert' AND has(tables, 'qryn.samples_v3') AND event_time > now() - INTERVAL 15 MINUTE"` (must be 0).
4. Backfill, newest day first (resumable; re-run the same line after any failure): `sudo bash /opt/revup/scripts/homer/backfill_sip_number_index.sh`. Expected: about 15-60 s per day (about 0.6 GiB of SIP per day at ~50 MB/s with 2 threads, plus 24 hourly statements), under 10 minutes for the 8 days.
5. Rebuild the API: `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build --no-deps api`
6. Verify: coverage `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT kind, day, started_at, index_rows FROM qryn.sip_number_index_coverage FINAL ORDER BY kind, day DESC"`; then a Last-7-days number search in TED/the Troubleshooting page answers with `search_path: "index"` (API log: no `window_too_wide`).

### Verify (read-only, any time)

- Schema the MV relies on (`timestamp_ns` Int64, `string` String): `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT name, type FROM system.columns WHERE database = 'qryn' AND table = 'samples_v3' FORMAT PrettyCompact"`
- qryn insert rate (MV cost = inserts per second x ~15 ms): `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() AS inserts_last_hour, round(avg(written_rows)) AS rows_per_insert FROM system.query_log WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND has(tables, 'qryn.samples_v3') AND event_time > now() - INTERVAL 1 HOUR"`
- MV time per insert: `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count(), round(avg(view_duration_ms), 1), max(view_duration_ms) FROM system.query_views_log WHERE view_name = 'qryn.sip_number_index_mv' AND event_time > now() - INTERVAL 1 HOUR"`
- The header Call-ID the index stores equals qryn's `call_id` label (the fetch key; `same` must equal `total`): `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT countIf(JSONExtractString(ts.labels, 'call_id') = s.cid) AS same, count() AS total FROM (SELECT fingerprint, extract(substring(string, 1, 16384), '(?mi)^(?:call-id|i)[ \t]*:[ \t]*([^\r\n]*[^\r\n \t])') AS cid FROM qryn.samples_v3 WHERE timestamp_ns >= toUnixTimestamp64Nano(now64(9)) - 600000000000 AND cid != '' LIMIT 20000) AS s INNER JOIN (SELECT fingerprint, any(labels) AS labels FROM qryn.time_series WHERE fingerprint IN (SELECT fingerprint FROM qryn.samples_v3 WHERE timestamp_ns >= toUnixTimestamp64Nano(now64(9)) - 600000000000) GROUP BY fingerprint) AS ts USING fingerprint SETTINGS max_memory_usage = 1000000000, max_execution_time = 60"`

### Rollback

1. `sudo docker exec voip-clickhouse clickhouse-client --multiquery --query "DROP VIEW IF EXISTS qryn.sip_number_index_mv; DROP TABLE IF EXISTS qryn.sip_number_index; DROP TABLE IF EXISTS qryn.sip_number_index_coverage"` (MV first). The API notices within 60 s and falls back to the 24 h scan.
2. API back (only if the API itself misbehaves — the new API works with no index): `cd /opt/revup && sudo git checkout <this PR's merge commit>^1 && sudo docker compose -f docker-compose.services.yml up -d --build --no-deps api` (detached HEAD; `sudo git checkout RCF-V1` before the next deploy).

### Local proof (not CI — CI has no ClickHouse)

`docker run -d --name crag-ch-idx -p 127.0.0.1:18123:8123 clickhouse/clickhouse-server:23.3-alpine`, then
`CH_CLIENT="docker exec -i crag-ch-idx clickhouse-client" python3 scripts/homer/test_sip_number_index_clickhouse.py`, then `docker rm -f crag-ch-idx`.
It drops and recreates the local `qryn` database, applies the DDL twice, checks the MV
extraction on realistic SIP (compact headers, `tel:`, `+1` forms, npdi, `%2B`,
LF-only), fuzzes ingest, runs the backfill twice plus `--redo`, runs the API's lookup
SQL, and prints the ingest benchmark. Run it after any change to the DDL.

## HEP Sources & Capture IDs

Each SIP component sends HEP packets with a unique capture_id for identification:

| Source | capture_id | HEP Target | Config Location |
|--------|-----------|------------|-----------------|
| Kamailio SBC | 100 | $HOMER_IP:9060 UDP | kamailio.cfg (`siptrace` module) |
| FreeSWITCH (all profiles) | 200 | $HOMER_IP:9060 UDP | sofia.conf.xml `global_settings` (`capture-server`) |

**NOTE:** mod_sofia only supports a single global capture-server with one capture_id.
Per-profile capture-server params are silently ignored by FreeSWITCH (the config parser
does not recognize `capture-server` in profile `<settings>`, only in `<global_settings>`).
Both internal and external profiles share capture_id=200.

**Multi-zone capture IDs:** East=100/200, West=110/210, Central=120/220. Media-HA FS-2 nodes (Phase 4c hot standbys `east-fs-2`/`west-fs-2`/`central-fs-2`): **201/211/221** — set via `HEP_CAPTURE_ID` in each FS-2 `.env` so ladders distinguish which FS handled a call (confirm against the FS-2 `.env` matrix at deploy).

HEP sources (Kamailio and FreeSWITCH) are unchanged from Homer 7 -- they still
send HEP to port 9060 on the services VM. Only the backend storage and UI changed.

## Files

| File | Purpose |
|------|---------|
| `clickhouse-users.xml` | ClickHouse user config (passwordless default user for internal Docker network) |
| `clickhouse/10_sip_number_index.sql` | Number index DDL: coverage table, `qryn.sip_number_index`, the MV on `samples_v3`. Hand-applied, idempotent (see "Number index") |
| `grafana/provisioning/datasources/qryn.yml` | Auto-provisions qryn as Loki datasource in Grafana |
| `grafana/provisioning/dashboards/dashboards.yml` | Auto-provisions dashboard directory in Grafana |
| `grafana/dashboards/homer/sip-search.json` | SIP search dashboard with logs, table, and flow diagram panels (in the `homer/` subdir so its provider does not recurse into the `noc/` NOC dashboards) |
| `grafana/dashboards/noc/*.json` | Production NOC dashboards (infra + voice-product), provisioned into the "Production NOC" Grafana folder by a second dashboards provider |
| `scripts/ip-alias.lua` | heplify-server Lua script: rewrites HEP SrcIP/DstIP to friendly node names before Loki labels are generated |

## NOC dashboards reading `cdrs` — one row per call (A/B leg split, 2026-09-23)

Since migration 48 `cdrs` holds one A row per call (`leg='A'`, `call_id=uuid`) plus one **B row per carrier bridge attempt** (`leg='B'`, `call_id`=A-leg uuid, `leg_attempt` 1..N, `direction='outbound'`, its own RTP stats); pre-48 rows have `leg IS NULL`. Contract: `docs/CDR_LEG_SPLIT_CONTRACT.md`.

- **Every** SQL panel/target that reads `cdrs` (datasource `voip-cdr-pg`) MUST carry `leg IS DISTINCT FROM 'B'` (alias-qualified, e.g. `c.leg ...`) — counts, ASR, minutes, on-net %, carrier splits AND call-level quality (the `call_quality_*` / `call_mos` columns live on the A row only). A new panel without it double-counts every carrier call. Filtering `direction='inbound'` is NOT a substitute. Leg-level (per-direction) quality panels are the deliberate exception listed below; they still spell the A-side predicate (as a `caller_side` label, or `(leg IS DISTINCT FROM 'B' OR leg = 'B')` when both directions are pooled) so the rule stays greppable.
- The panels are the predicate's only home: the `leg` column must exist (migration 48 applied on the primary) BEFORE these dashboards are deployed, or every cdrs panel errors.
- Leg-aware panels: call-quality.json id 76 "Carrier legs per call — last 24h (orphan-leg check)" (Diagnostics row): B rows, calls with ≥1 B, max/avg `leg_attempt`, orphan B rows (no A row, call started >3h ago — must be 0, red otherwise) and "B awaiting A" (in-progress calls — A CDR posts at hangup; informational).
- Also leg-aware (quality **by direction**, 2026-09): call-quality.json ids 21 (loss p95), 20 (RFC 3550 jitter p50/p95), 13 (loss distribution), 22 (one-way audio per hour + partial inbound media) and noc-home.json ids 31/32 (loss / jitter p95, both directions pooled). caller→platform = the A row (what the callee hears), callee→platform = the carrier B rows (what the caller hears). They count legs, never calls.
- `cdr_hourly_stats` (continuous aggregate) has no `leg` dimension. Its only dashboard consumer is call-quality.json id 3 (ACD), filtered `direction='inbound'` so B rows (all `outbound`) drop out. Any new CAGG consumer needs the same filter unless the aggregate is recreated with the leg predicate.
- Counting vs rating: minutes/volume panels = A rows only. B rows carry their own `billed_seconds` for rating (Equinox); no NOC panel shows "billed" totals today — if one is added, decide per-leg rating semantics explicitly rather than reusing the A-only predicate.

## NOC call-quality panels (2026-09, `docs/CALL_QUALITY_ACCURACY_PLAN.md` E.1)

The quality panels read the honest columns from migration 50. They need `50_cdr_quality_accuracy.sql` applied on the primary BEFORE the dashboards are deployed, otherwise `quality_status` / `call_quality_*` are undefined and the panels error.

- **Grades, one definition (plan D):** great ≥ 4.34 · good ≥ 4.02 · fair ≥ 3.60 · poor < 3.60 or one-way audio (`no_rtp` = < 10% of expected packets in while ≥ 50% went out). `no_media` (migration 51: < 10% in AND < 50% out — no audio either way, failed/test calls or both parties silent) is NOT graded: it lands in #30 "Not graded" and is never counted by #11 One-way / #22 / noc-home #33. They apply to the stored 2-dp E-model MOS. Grafana literals are 3.60 / 4.02 / 4.34. Never reintroduce the old 3.5 / 4.0 / 4.3 cuts.
- **Graded predicates only:** call-level panels use `leg IS DISTINCT FROM 'B' AND call_quality_grade IS NOT NULL` (or `call_quality_status='rated'` for MOS percentiles). Leg-level panels use `quality_status = 'rated'` (plus `no_rtp` for one-way). The old ad-hoc floors `billable_ms >= 10000 AND rtp_audio_in_packet_count >= 500` are gone; `quality_status` replaces them.
- **No MOS averages anywhere.** Use shares (Good+ %), percentiles (p50 / p10 MOS, p95 loss and jitter), distributions and one-way counts. `quality_pct` and `jitter_min_ms` are deprecated (always NULL). `r_factor` is no longer a relabelled MOS, but it is not charted. `jitter_max_ms` is not charted either.
- **Jitter panels stay empty until FS images carry quality patch v1.** Legacy images and history write `jitter_avg_ms` NULL. The old FS variance-derived peak survives only as `fs_jitter_max_std_ms` (diagnostic).
- **call-quality.json:** #43 Good-or-better calls 15m · #12 Call MOS p50/p10 · #21 True loss p95 by direction · #20 RFC 3550 jitter by direction · #11 Call grade distribution (Great / Good / Fair / Poor (audio) / One-way audio) · #13 Loss distribution (barchart, 7 bands) · #22 One-way audio per hour + partial inbound media · #30 Graded-call snapshot. **noc-home.json** Voice row: #30 Good+ 15m · #31 Loss p95 15m · #32 Jitter p95 15m · #33 One-way audio 1h.
- SLIs built on these panels: `infra/monitoring/SLOS.md` "Voice quality SLI". No paging on quality (owner decision): one-way audio is dashboard-only.
- `tests/test_grafana_quality_sql.py` runs every edited panel's SQL (macros substituted) against an ephemeral PG16 with migrations 50 + 51 (seeds include `no_media` calls) and asserts the result shapes, the leg predicate, the thresholds and that no MOS average exists. Run it after any quality-panel edit.

## Key Configuration

- **heplify-server** uses `DBSHEMA=mock` and `DBDRIVER=mock` -- it does NOT write to a database directly. Instead it pushes to qryn's Loki push endpoint (`LOKIURL`).
- **`LOKIALLOWOUTOFORDER=true` is REQUIRED.** heplify-server's Loki client (remotelog/loki.go) keeps a single global `lastPktTime`; with the default `false`, any HEP packet arriving out of timestamp order gets its timestamp REPLACED with `time.Now()` (and poisons `lastPktTime`, cascading onto subsequent packets). Symptom: rows with full-nanosecond entropy, 15-20ms late, INVITEs sorting after their own 100 Trying in the ladder. Real HEP capture timestamps are µs precision (stored ns values end in `000`). The guard exists for genuine Grafana Loki; qryn/ClickHouse accepts out-of-order writes, so disabling the guard is safe here.
- **ALEGIDS=X-CID** is set but does **NOT** give us leg correlation: heplify-server 1.60.3's Loki push labels every packet with its OWN Call-ID (`call_id` label) and never emits an A-leg label. A/B correlation is done by the API from the X-CID header text — see "A/B leg correlation" above.
- **qryn** connects to ClickHouse on port 8123 (HTTP interface) with the default user (no password).
- **Grafana** has anonymous viewer access enabled and serves from `/grafana/` subpath for reverse proxy compatibility.
- **Flow panel plugin** (`qxip-flow-panel`) is installed at Grafana startup for SIP ladder diagrams.
- **IP aliasing** via Lua script (`scripts/ip-alias.lua`). heplify-server's Lua engine calls `SetHEPField("SrcIP", name)` to rewrite raw IPs to friendly names (e.g. "SBC-1", "FreeSWITCH", "Services") before Loki label generation. This means `src_ip`/`dst_ip` labels carry friendly names with zero Grafana dashboard changes. To add or change aliases, edit the `aliases` table in `ip-alias.lua` and restart heplify-server.
  - **East-only hardcode:** the `aliases` table currently lists only East-zone IPs (SBC-1/SBC-2 VPC + external, FreeSWITCH VPC + external, Services, SBC-VIP). **Every new zone MUST add its SBC/FS IPs here** or the SIP ladder shows raw IPs instead of node names for that zone.

## Accessing Homer 10

- **Local dev:** http://localhost:3000/grafana/
- **Production:** http://<services-vm-ip>:3000/grafana/ (via IAP tunnel or NLB)
- **Default login:** admin / sipcapture (set via `GRAFANA_ADMIN_PASSWORD` env var)
- **Anonymous access:** Viewer role enabled for embedding in our UI

## Centralized vs Per-Zone

**Phase 1 (current):** Single Homer stack on the services VM in us-east1-b. All zones
send HEP packets to this centralized instance. Cross-region HEP is UDP, fire-and-forget,
~5 Mbps per zone -- negligible cost and no call quality impact.

**Phase 2 (optional):** Per-zone ClickHouse if HEP volume becomes a concern. qryn
supports ClickHouse clustering for distributed queries.

## Using Homer 10 for Debugging

1. Open Grafana at :3000/grafana/
2. Navigate to Homer > SIP Search dashboard
3. Enter Call-ID, From User, or To User in the filter variables
4. Logs panel shows SIP messages in time order
5. Table panel shows parsed SIP fields (method, src_ip, dst_ip, sip_code)
6. Flow panel shows SIP ladder diagram for a specific Call-ID
7. Use this to debug: one-way audio, call setup failures, 4xx/5xx errors, codec mismatches

## Migration Notes (Homer 7 to Homer 10)

- Homer 7 PostgreSQL data is NOT migrated -- old SIP captures are lost on upgrade
- The `homer-db` (postgres:14-alpine) container and `homer_db_data` volume are removed
- The `homer-webapp` (homer-app) container is removed
- heplify-server image is the same but reconfigured for Loki push instead of Postgres
- HEP sources need zero changes -- same ports, same protocol
