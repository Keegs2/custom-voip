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
| `sip_number_index_coverage` | ReplacingMergeTree. One `'mv'` row (when the MV started; never expires) + one `'backfill'` row per completed UTC day (TTL 9 days). |
| `sip_number_index` | AggregatingMergeTree, `PARTITION BY day`, `ORDER BY (number, role, call_id)`, TTL day + 8 days. Columns: `number` (digits), `role`, `call_id` (== qryn's `call_id` label), `first_ns`/`last_ns` (min/max), `final_code` (argMax state: last final INVITE response, 0 = none). |
| `sip_number_index_mv` | MATERIALIZED VIEW `TO sip_number_index` on `samples_v3` inserts. heplify and qryn are untouched (qryn already runs its own `metrics_15s_mv` on the same table). |

- **Extraction** (header block only — before the first blank line, at most 8 KiB; the
  SDP body is never read): the user part of every `sip:`/`sips:`/`tel:` URI in the
  Request-URI, From (`f:`), To (`t:`), P-Asserted-Identity and Diversion; user
  parameters (`;npdi;rn=`) cut; `%XX` dropped; non-digits stripped; 3..32 digits.
  Only SIP rows with a Call-ID (`Call-ID:` / `i:`, trimmed, <= 512 bytes); OPTIONS and
  REGISTER skipped. Contact, display names, SDP and X-headers are not indexed.
- **Roles come from the initial INVITE only** (a request with no To tag): `ruri`,
  `from`, `to`, `pai`, `diversion`. Every other message (responses, ACK, BYE,
  re-INVITE — where a callee-sent request has From/To swapped and R-URI = the
  caller's Contact) stores its numbers with role `other`.
- **Exact-match limitation:** a 10+ digit needle matches the canonical NANP forms
  only (10 digits; an 11-digit 1-prefixed number is stored with and without the 1).
  A dial-9 form (`915087282017`), `011`/`00` international prefixes and
  national-format foreign numbers are stored as dialed, so a full-number search does
  not match them exactly — those legs are still found through the correlated carrier
  leg (X-CID). Partial (< 10 digit) needles still match substrings of every form.
- **Matching:** the API needle is `normalize_number_needle` (strip non-digits;
  exactly 11 digits with a leading 1 -> drop it). Stored: an 11-digit number starting
  with 1 is kept with and without the 1. A **full number (10+ digits) matches
  exactly** — a primary-key lookup — so `5087282017`, `15087282017` and
  `+1 (508) 728-2017` find the same calls. **Shorter needles are partials**
  (substring: `508`, `4217`, `15087`). `number` matches any role incl. `other`;
  `from_user` = From/PAI; `to_user` = To/R-URI (initial INVITE). Fields AND.
  (The <= 24 h scan path keeps the old semantics: substring anywhere in the text.)
- **Lookup SQL** (`routers/homer_index.build_lookup`): the number conditions are an
  explicit `PREWHERE` — ClickHouse 23.3 otherwise moves the `day` predicate there and
  reads every column of every row in the window.
- **No ngram/token bloom filter on `number`:** on a 10-symbol alphabet every
  8192-row granule holds essentially all 1,000 trigrams (EXPLAIN on 2M numbers:
  `Granules: 245/245`). Full numbers use the primary key instead; a partial reads the
  whole index in the window.

**Measured at scale** (local ClickHouse 23.3.22, 30.1M unmerged index rows over 7
days in 147 parts, merges stopped — about the production worst case of ~3M
unmerged rows/day; `scripts/homer/test_sip_number_index_clickhouse.py --scale`),
7-day window, API caps on:

| Lookup | Rows read | Bytes read | Memory | Time |
|---|---|---|---|---|
| full number (10-digit, `+1 …`, `1…` 11-digit), from_user exact, 12-digit international | ~0.57M | 11 MB | ~10 MiB | 8-16 ms |
| same, without PREWHERE | ~0.57M | 48 MB | ~30 MiB | 12-40 ms |
| 4-digit partial `2017` | 30.1M | 2.4 GB | 236 MiB | 223 ms |
| 3-digit partial `508` (10 % of rows start with 508; GROUP BY spills) | 33.3M | 2.9 GB | 517 MiB | 724 ms |

Caps: index lookups `readonly=2`, `max_execution_time` 10 s, `max_memory_usage` 1e9,
`max_bytes_before_external_group_by` 5e8, `max_bytes_to_read` 6e9 (2x over the
30M-row partial). Fetch / correlation reads: 10 s, 1e9, 4e9 bytes (a fetch reads the
SIP of every 8192-row `samples_v3` granule holding a requested call; at its cap the
API says "The matching calls' SIP is too large to load in one page; choose a shorter
window."). Production expectation: full-number searches read tens of MB and answer in
well under 100 ms; partials read the whole index in the window (up to ~2-3 GB, < 1 s).

**Ingest safety.**
- Only total functions in the MV (no JOIN, no parser that can throw), bounded per row
  (8 KiB header, no RE2 `{m,n}` repetition — it made inserts 3x slower). Proven with
  2,010 junk/random-byte/oversized rows and 5,000 SIP-shaped random-byte messages.
- `clickhouse-users.xml` sets **`materialized_views_ignore_errors = 1`** for the
  default profile (the user qryn inserts as). ClickHouse 23.3 hot-reloads the users
  config within seconds; the only obstacle is the single-file bind mount (`git pull`
  writes a new inode, the container keeps the old file), so the deploy writes the
  file in place inside the container — **never restart ClickHouse for it**: a restart
  pauses SIP capture for 10-60 s and nothing buffers it (those traces are lost).
  Verified locally: in-place write -> setting 0 -> 1 within 10 s, no restart. Proven on 23.3.22: a throwing MV and an
  MV over its memory limit (200k-row block at `max_memory_usage` 1.5e9) both leave the
  `samples_v3` insert intact; the failure is logged in `system.query_views_log`
  (`status = 'ExceptionWhileProcessing'`). **An index gap is preferred to trace loss.**
- **It does NOT cover a missing target table or a renamed source column:** an MV whose
  `TO` table was dropped, or `samples_v3.string` renamed by a qryn upgrade, fails EVERY
  qryn insert (Code 60 / 47), setting or not (proven). Hence: rollback drops the MV
  FIRST, and before any qryn image change run the schema check under "Verify".
- **Cost** (local): small qryn batches (200 rows) +~55 us per message (~10 ms per
  insert); a 50k-row / 95 MB block +680 MiB peak memory and +1.1 s; 200k rows / 398 MB
  +1.4 GiB and +5 s. Cost is linear in the block size, so the deploy pre-check below
  gates on qryn's real block sizes.
- **Freshness:** the capability probe compares the newest INVITE in `samples_v3`
  captured 2-15 min ago with the newest index row; if the index is more than 5 min
  behind, `number_index` reads false (searches fall back to the 24 h scan / 422) and
  the API logs an ERROR "number index is NOT filling". A stalled MV never answers
  "no calls".
- **Idempotent:** min/max/argMax only, so re-inserting the same messages (re-run
  backfill, backfill overlapping the MV) changes nothing after a merge.

**Coverage (`index_covered_from`).** The MV start (the later of its
`system.tables.metadata_modification_time`, which survives restarts, and the `'mv'`
coverage row, which never expires) extended back one whole UTC day at a time over
days whose backfill *started after* the MV, never older than today - 7 days.

**Search paths** (`routers/homer.py`): `call_id` -> label path (unchanged); index
present, filling, and `start_time >= index_covered_from` -> index; otherwise the qryn
scan only when `end_time - start_time <= 24 h`, else 422 `window_too_wide`. A
ClickHouse limit -> 422 `search_too_broad`. **Index paging is by call:** 50 calls per
page newest first by each call's first matching message; `oldest_ts_ns` = that first
message of the page's oldest call (correlated legs may hold older rows); the next page
(`before_ns = oldest_ts_ns`) returns older calls whole. A call is never skipped or
repeated; a forwarded call whose legs straddle the cursor can show its correlated legs
on both pages. `has_more` always comes with a non-null `oldest_ts_ns`.

### Pre-deploy check (owner, read-only) — do not deploy if a threshold is exceeded

1. Block sizes and the 24 h average rate: `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() AS inserts_24h, round(count() / 86400, 2) AS per_s, max(written_rows) AS max_rows, quantile(0.99)(written_rows) AS p99_rows, formatReadableSize(max(written_bytes)) AS max_bytes, max(memory_usage) AS max_mem FROM system.query_log WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND has(tables, 'qryn.samples_v3') AND event_time > now() - INTERVAL 1 DAY"`
2. Peak rate per minute (the 24 h average hides bursts): `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT max(c) AS peak_inserts_per_min, max(r) AS peak_rows_per_min FROM (SELECT toStartOfMinute(event_time) AS m, count() AS c, sum(written_rows) AS r FROM system.query_log WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND has(tables, 'qryn.samples_v3') AND event_time > now() - INTERVAL 1 DAY GROUP BY m)"`
3. That the log sees qryn's inserts at all (samples written in the last hour): `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() FROM qryn.samples_v3 WHERE timestamp_ns > toUnixTimestamp64Nano(now64(9)) - 3600000000000"`

Don't deploy if `max_rows` > 50000 or `max_bytes` > 100 MB (the MV would add
> ~700 MiB and > 1 s to such an insert), or `per_s` > 20 or `peak_inserts_per_min` >
1200 (~0.3 core of MV CPU at ~15 ms per insert). Expected on this platform: hundreds of
rows per insert, about one insert per second.

Caveats: `written_rows` also counts the rows qryn's own `metrics_15s_mv` writes, so it
overstates the block size (safe direction). **If `inserts_24h` is about 0 while check 3
shows samples growing, qryn is using async inserts and this check is invalid — stop
and ask; do not deploy.**

### Deploy (services VM, single lines, after Phase 2 of `docs/runbooks/MAINTENANCE_2026-11-03.md`)

Not during SBC flips or another step that loads the services VM. ClickHouse first, then the API.

1. `cd /opt/revup && sudo git pull`
2. Run the pre-check above; stop if a threshold is exceeded.
3. Check the new users file is well-formed XML (a broken file would be rejected by the hot reload): `python3 -c "import sys,xml.dom.minidom;xml.dom.minidom.parse(sys.argv[1])" /opt/revup/docker/homer/clickhouse-users.xml && echo XML_OK`
4. Write it in place inside the container (the compose mount target is `/etc/clickhouse-server/users.d/custom-users.xml`; `git pull` gave the host file a new inode the container cannot see). ClickHouse hot-reloads it, no restart, no ingest pause: `sudo docker exec -i voip-clickhouse sh -c 'cat > /etc/clickhouse-server/users.d/custom-users.xml' < /opt/revup/docker/homer/clickhouse-users.xml`
5. Verify — expect `materialized_views_ignore_errors 1` and `max_memory_usage 4000000000`; do NOT apply the DDL until it reads 1: `sleep 10; sudo docker exec voip-clickhouse clickhouse-client --query "SELECT name, value FROM system.settings WHERE name IN ('materialized_views_ignore_errors','max_memory_usage')"`. Never `docker restart voip-clickhouse` for this: a restart pauses SIP capture 10-60 s with no durable buffer (traces lost).
6. Apply the DDL (coverage table -> index table -> MV -> "MV started" row; idempotent): `sudo docker exec -i voip-clickhouse clickhouse-client --multiquery < /opt/revup/docker/homer/clickhouse/10_sip_number_index.sql`
7. After a minute: rows grow — `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() AS rows, uniqExact(call_id) AS calls FROM qryn.sip_number_index"`; qryn inserts not failing (must be 0) — `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() FROM system.query_log WHERE type = 'ExceptionWhileProcessing' AND query_kind = 'Insert' AND has(tables, 'qryn.samples_v3') AND event_time > now() - INTERVAL 15 MINUTE"`; MV healthy (no `ExceptionWhileProcessing`; p99 under 200 ms, else roll back) — `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT status, count(), quantile(0.99)(view_duration_ms) AS p99_ms, formatReadableSize(max(peak_memory_usage)) AS peak FROM system.query_views_log WHERE view_name = 'qryn.sip_number_index_mv' AND event_time > now() - INTERVAL 15 MINUTE GROUP BY status"`
8. Backfill, newest day first (resumable; re-run the same line after any failure): `sudo bash /opt/revup/scripts/homer/backfill_sip_number_index.sh` — about 15-60 s per day (~0.6 GiB of SIP/day at ~50 MB/s, 2 threads, 5e8 memory per hourly insert), under 10 minutes for 8 days.
9. Rebuild the API: `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build --no-deps api`
10. Verify coverage: `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT kind, day, started_at, index_rows FROM qryn.sip_number_index_coverage FINAL ORDER BY kind, day DESC"`; then a Last-7-days number search in TED/Troubleshooting answers with `search_path: "index"`.

### Verify (read-only, any time)

- Schema the MV relies on (`timestamp_ns` Int64, `string` String) — **also run before any qryn image change**; if `string` is gone or renamed, drop the MV first (Rollback step 1): `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT name, type FROM system.columns WHERE database = 'qryn' AND table = 'samples_v3' FORMAT PrettyCompact"`
- MV health: the `query_views_log` query in Deploy step 6.
- The header Call-ID the index stores equals qryn's `call_id` label (the fetch key; `same` must equal `total`): `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT countIf(JSONExtractString(ts.labels, 'call_id') = s.cid) AS same, count() AS total FROM (SELECT fingerprint, extract(substring(string, 1, 16384), '(?mi)^(?:call-id|i)[ \t]*:[ \t]*([^\r\n]*[^\r\n \t])') AS cid FROM qryn.samples_v3 WHERE timestamp_ns >= toUnixTimestamp64Nano(now64(9)) - 600000000000 AND cid != '' LIMIT 20000) AS s INNER JOIN (SELECT fingerprint, any(labels) AS labels FROM qryn.time_series WHERE fingerprint IN (SELECT fingerprint FROM qryn.samples_v3 WHERE timestamp_ns >= toUnixTimestamp64Nano(now64(9)) - 600000000000) GROUP BY fingerprint) AS ts USING fingerprint SETTINGS max_memory_usage = 1000000000, max_execution_time = 60"`

### Rollback — DROP THE VIEW FIRST

> **Never drop `sip_number_index` while `sip_number_index_mv` exists: every qryn insert
> then fails (Code 60) and SIP capture stops — `materialized_views_ignore_errors` does
> not cover a missing target table.**

1. Drop the view alone: `sudo docker exec voip-clickhouse clickhouse-client --query "DROP VIEW IF EXISTS qryn.sip_number_index_mv"`
2. Verify it is gone (must print 0) and qryn inserts succeed (must print 0): `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() FROM system.tables WHERE database = 'qryn' AND name = 'sip_number_index_mv'"` and `sudo docker exec voip-clickhouse clickhouse-client --query "SELECT count() FROM system.query_log WHERE type = 'ExceptionWhileProcessing' AND query_kind = 'Insert' AND has(tables, 'qryn.samples_v3') AND event_time > now() - INTERVAL 5 MINUTE"`
3. Only then the tables: `sudo docker exec voip-clickhouse clickhouse-client --multiquery --query "DROP TABLE IF EXISTS qryn.sip_number_index; DROP TABLE IF EXISTS qryn.sip_number_index_coverage"`. The API notices within 60 s and falls back to the 24 h scan.
4. API back (only if the API itself misbehaves — the new API works with no index): `cd /opt/revup && sudo git checkout <this PR's merge commit>^1 && sudo docker compose -f docker-compose.services.yml up -d --build --no-deps api` (detached HEAD; `sudo git checkout RCF-V1` before the next deploy). `materialized_views_ignore_errors` can stay on.

### Known low risks (follow-ups)

- **Freshness at night:** if, for 15 min, the only INVITEs captured are scanner INVITEs
  without user digits, the freshness check sees no matching index rows and marks the
  index stale. Fails safe: 7-day number searches answer 422 `window_too_wide`, <= 24 h
  scans still work; it clears on the next normal call.
- **AND searches across UTC midnight:** a call whose matching rows for different needles
  fall on two UTC days can be ordered by the earlier day's row only; a paging edge case
  (the call still appears), not a correctness loss.
- **More than 20 calls tied to the same nanosecond** at a page boundary: only the first
  20 ties stay together (INDEX_TIE_EXTRA); practically impossible with µs HEP stamps.
- **`max_server_memory_usage` ~5e9** — below.

### Follow-up (owner-approved, not in this PR): `max_server_memory_usage`

ClickHouse 23.3 sizes its server-wide memory limit from host RAM (90 % of 32 GB), not the
container's 6G limit, so concurrent queries whose per-query caps sum past 6G are
OOM-killed by the kernel instead of refused. Recommended: a `config.d` file with
`<max_server_memory_usage>5000000000</max_server_memory_usage>` mounted into
`voip-clickhouse`. Not included here: it changes the compose service (any later
`docker compose up -d` would recreate ClickHouse) and needs its own restart window and
a check that the background merges + qryn inserts fit beside a 4e9 query.

### Local proof (not CI — CI has no ClickHouse)

`docker run -d --name crag-ch-idx -p 127.0.0.1:18123:8123 -v "$PWD/docker/homer/clickhouse-users.xml:/etc/clickhouse-server/users.d/custom-users.xml" clickhouse/clickhouse-server:23.3-alpine`, then
`CH_CLIENT="docker exec -i crag-ch-idx clickhouse-client" python3 scripts/homer/test_sip_number_index_clickhouse.py --scale`, then `docker rm -f crag-ch-idx`.
It drops and recreates local databases, checks the users.xml setting, applies the DDL
twice, checks extraction on realistic SIP, fuzzes ingest, proves the failure modes above
(throwing MV, dropped target, schema drift, memory-limit block), runs the backfill
twice plus `--redo`, runs the API's lookup SQL, benchmarks ingest, and (`--scale`) the
30M-row lookups. Run it after any change to the DDL or the lookup SQL.

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
