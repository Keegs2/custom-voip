# CDR Billing Remediation — Maintenance Plan

**Status:** Designed, reviewed by three independent expert passes (FreeSWITCH CDR emission, schema/ingest/export, maintenance mechanics). NOT executed.
**Trigger:** the CDR exporter was enabled 2026-09-15 and Equinox integration is in progress.
**Two objectives:** (A) make ring time and unanswered calls structurally unbillable; (B) split forwarded calls into separately-rateable inbound and outbound leg CDRs.

---

## 0. Verdict up front

**Objective A ships tonight. Objective B does not.**

Objective A touches no call path, needs no FreeSWITCH change, and closes the exposure actually measured in production. Objective B turns one call into two rows, which changes the meaning of ~45 Grafana panels, 6 API endpoints and 8 UI surfaces — and its single most dangerous failure mode is a FreeSWITCH channel variable that **does not exist yet** defaulting to `direction='inbound'` at `docker/api/src/routers/cdrs.py:803`.

A wrong split that silently double-bills is far worse than two phases. Two phases costs about a week.

### Measured exposure (30 days, prod, 2026-09-15)

| | value | share |
|---|---:|---|
| calls | 2,523 | |
| unanswered | 62 | 2.5% |
| duration | 7,540 min | |
| billable (talk) | 7,385 min | |
| **ring** | **155 min** | **2.06% of duration** |
| unanswered ring | 14 min | 0.19% |

Ring time is ~2% and only 14 minutes of it is pure unanswered ring. **This is not a fire.** It is worth fixing correctly rather than fast.

---

## 1. What is actually wrong today

### 1.1 The export is a fidelity dump, not a billing contract

`cdr_export/exporter.py:61-129` ships all 59 `cdrs` columns; `formatter.py:139-207` renders them with raw DB column names as headers. `select_batch()` (`exporter.py:165-175`) filters only on `exported_at IS NULL AND end_time < now() - lag`.

There is **no answered flag and no row filter**, and `duration_ms` (`formatter.py:153`) sits three characters from `billable_ms` (`:154`) with identical rendering and no semantic distinction. Equinox is being asked to pick the billable quantity out of a 59-column dump by naming convention.

`billable_ms` itself is correct today — it is FreeSWITCH `billsec` (answer→hangup), written at `cdrs.py:889-890`, independent of `rate_cdr()`.

> **Honest limit.** Ring time cannot be made *structurally* impossible to bill. `start_time`, `answer_time` and `end_time` are all exported, and any two of them reconstruct ring in one subtraction. What is achievable is: one unambiguously-named billable field that is structurally zero on unanswered calls, every non-billable quantity named so nobody would point a rate at it, and a written field contract shipped with the first file. Claiming more would be dishonest.

### 1.2 Second-flooring, and the double-rounding argument

`cdrs.py:886-890` reads `billsec` and `duration` — both **whole seconds** — while FreeSWITCH emits `billmsec` and `mduration` in the same payload (`json_cdr.conf.xml:90-92` has the `channel-vars` whitelist commented out, so every variable is already posted).

Financially this is noise: 2,461 answered calls × 0.5s mean ≈ **20.5 min/month ≈ 0.28%**, biased toward *under*-billing.

The real argument is **double rounding**: FreeSWITCH floors to the second, then Equinox applies its increment — two roundings in opposite directions. A call at 6.02s of real talk lands on either side of a 6-second increment depending on which way the floor went. Sending true milliseconds means exactly one rounding, performed by whoever owns the rate plan.

### 1.3 `rate_cdr()` is a landmine, not a current bug

`05_schema_cdr.sql:213-231` overwrites `billable_ms` with `GREATEST(duration_ms, min_duration)` rounded up to the increment — derived from **ring-inclusive** `duration_ms`, regardless of whether the call answered — and debits `customers.balance`. It is **not run on RCF-V1** (reachable only via admin `POST /v1/cdrs/{uuid}/rate`, `cdrs.py:1785-1788`).

Verify before the window:

```
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT count(*) AS rated FROM cdrs WHERE rated_at IS NOT NULL;"
```

Expect `0`. If not zero, those rows were exported with inflated `billable_ms` and need the corrective re-export in §6.

---

## 2. Phase 1 — tonight

Net effect: the billing contract is fixed, ring time and unanswered calls are structurally zeroed in the feed, and the schema is ready for Phase 3. **Zero new rows. Zero consumer changes required.**

### Step 1 — pause the feed (do this first, before anything else)

```
hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml stop cdr-exporter
hostname | grep -q '^services$' && sudo docker ps -a --filter name=voip-cdr-exporter --format '{{.Names}} {{.Status}}'
```

> **Use `stop`, not the env flag.** The container is `restart: unless-stopped` and `run_loop()` idle-exits when `CDR_EXPORT_ENABLED=false` — flipping the flag produces a restart loop of a no-op container. Because the service sits behind the `cdr-export` compose profile, a later plain `up -d` on the services stack will not resurrect it.

Record the pre-window state:

```
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT count(*) AS unexported, min(start_time), max(start_time) FROM cdrs WHERE exported_at IS NULL;"
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT status, filename, row_count, sent_at FROM cdr_export_log ORDER BY created_at DESC LIMIT 5;"
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT id, locked_by, locked_until FROM cdr_export_lock;"
```

### Step 2 — take a backup you can actually restore from

```
hostname | grep -q '^services$' && sudo -u postgres pgbackrest --stanza=main --type=diff backup
hostname | grep -q '^services$' && sudo -u postgres pgbackrest --stanza=main info
```

Note the UTC timestamp — it is the PITR target. Proven recovery: 2026-07-22 drill restored data in ~15s; the real wiped-data-dir incident recovered in ~4 min with 0 loss.

### Step 3 — migration 48 (columns only, NO index)

New file `docker/postgres/init/48_cdr_call_legs.sql`, following migration 47's form exactly — `ADD COLUMN IF NOT EXISTS`, **no DEFAULT** (metadata-only on a compressed hypertable; a non-NULL default is the form that trips TimescaleDB).

| column | type | semantics |
|---|---|---|
| `leg` | `VARCHAR(1)` | `'A'` ingress / `'B'` egress. **NULL = legacy A-leg** |
| `call_id` | `VARCHAR(64)` | the A-leg channel uuid. On an A-leg, `call_id == uuid` |
| `leg_attempt` | `SMALLINT` | which bridge attempt this B-leg was. NULL on A-legs |

Two conventions that make everything backward-compatible for free:

- **Canonical one-row-per-call predicate: `leg IS DISTINCT FROM 'B'`** — every historical NULL row passes, every A-leg passes.
- **Canonical call identity: `COALESCE(call_id, uuid)`** — retroactively correct on every row ever written.

```
hostname | grep -q '^services$' && cd /opt/revup && sudo git pull
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/48_cdr_call_legs.sql
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "\d+ cdrs" | grep -E "leg|call_id|leg_attempt"
hostname | grep -q '^services$' && sudo -u postgres psql -X -c "SELECT client_addr, state, replay_lag FROM pg_stat_replication;"
```

**Do NOT create `idx_cdrs_call_id` tonight.** `CREATE INDEX` on a hypertable builds per-chunk (~13 weekly chunks) holding a lock throughout; TimescaleDB does not support plain `CONCURRENTLY`. It goes in Phase 2 with `WITH (timescaledb.transaction_per_chunk)`. Nothing reads `call_id` until Phase 3.

**Do NOT attempt a UNIQUE constraint on `uuid`.** A unique index on a hypertable must include every partitioning column, so the only legal shape is `UNIQUE (uuid, start_time)` — which does not give uuid uniqueness. Building one also requires decompressing all 90 days. The application-level `WHERE NOT EXISTS` guard at `cdrs.py:697-699` stays the dedup mechanism.

### Step 4 — API + exporter changes

**Export contract** — six **derived** fields computed in the SELECT, *not stored*. Deriving means historical rows get correct values with zero backfill.

| field | expression |
|---|---|
| `answered` | `(answer_time IS NOT NULL)` |
| `billed_ms` | `CASE WHEN answer_time IS NULL THEN 0 ELSE billable_ms END` |
| `billed_seconds` | `CEIL(billed_ms / 1000.0)` |
| `ring_ms` | `EXTRACT(EPOCH FROM (COALESCE(answer_time, end_time) - start_time)) * 1000` |
| `leg` | column |
| `call_id` | `COALESCE(call_id, uuid)` |

> The `CASE` on `billed_ms` looks redundant — `billable_ms` is already 0 for unanswered calls. It is not. It is the guard that makes a future accidental `rate_cdr()` invocation unable to inject ring time into the billable field. It costs nothing and closes the one path that can.

**Reorder the header** so the billing block comes first: `call_id, leg, uuid, customer_id, product_type, direction, answered, billed_seconds, billed_ms, ring_ms, duration_ms, billable_ms, start_time, answer_time, end_time, caller_id, destination, carrier_used, on_net, origin_customer_id, terminating_customer_id, hangup_cause, sip_code`, then the remaining fidelity columns unchanged. **This is only free while Equinox has not pinned a mapping. Do it now or never.**

Keep `SELECT_COLUMNS` as pure column names so the drift guard at `tests/test_cdr_export.py:706` keeps working; add a sibling `SELECT_DERIVED` of `(alias, sql_expr)` and extend the guard to assert `FIELDS == SELECT_COLUMNS ∪ derived aliases`.

**Unanswered calls: export them, with an explicit zero.** Completeness is reconcilable, omission is not — `cdr_export_log.row_count` is Equinox's only way to verify it received everything. A `WHERE answer_time IS NOT NULL` is four words nobody reviews again; `billed_seconds = 0` is visible on every row of every file. Volume is 62 rows/30d. Failed calls have real downstream users (ASR, disputes, fraud patterns).

**Ingest** — `cdrs.py:886-890`: `billsec` → `billmsec`, `duration` → `mduration`. Write `leg='A'`, `call_id=uuid` on every A-leg.

**Three-tier INSERT fallback — non-negotiable.** Append `leg, call_id, leg_attempt` as `$58/$59/$60` at the **tail** of both lists in `_cdr_insert_sql()` so `$1..$57` never renumber, and extend `_execute_cdr_insert` to full (60) → pre-48 (57) → pre-47 (55), each a strict tail-truncation. Add all three to `REQUIRED_CDR_COLUMNS` in `db/schema_check.py:39-42`.

> Without this, an API build reaching a VM before migration 48 raises `UndefinedColumnError` on every call, the catch-all at `cdrs.py:1159-1161` swallows it, the endpoint returns 200 per gotcha #11, and **every CDR in the fleet is silently lost**. Calls complete normally. Backups cannot recover rows that never landed.

Casts: `$58::varchar, $59::varchar, $60::smallint` — all nullable, so explicit casts are mandatory (asyncpg raises `AmbiguousParameterError` inferring from `None`).

### Step 5 — deploy and gate

```
hostname | grep -q '^services$' && cd /opt/revup && sudo git pull && sudo docker compose -f docker-compose.services.yml up -d --build api && date -u +%Y-%m-%dT%H:%M:%SZ
curl -s http://127.0.0.1:8088/health && echo && curl -s http://127.0.0.1:8088/health/detailed
hostname | grep -q '^services$' && sudo docker logs --tail 200 voip-api 2>&1 | grep -iE "UndefinedColumn|schema|ERROR|CRITICAL"
```

`components.schema` must read `healthy`.

**Go/no-go gate — place a live test call** to `+16174544217` (forwards to `+17744045256`), then:

```
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -x -c "SELECT uuid, leg, call_id, start_time, answer_time, end_time, duration_ms, billable_ms, direction, customer_id, product_type FROM cdrs ORDER BY start_time DESC LIMIT 3;"
```

Expect `leg='A'`, `call_id = uuid`, and `billable_ms` now carrying sub-second precision. If the shape is wrong you are still fully rolled back by a `git checkout` + rebuild, with **nothing shipped to Equinox**.

### Step 6 — verify the feed shape, then resume

```
hostname | grep -q '^services$' && sudo docker compose -f docker-compose.services.yml exec api python -m services.cdr_export test-connection
hostname | grep -q '^services$' && sudo docker compose -f docker-compose.services.yml exec api python -m services.cdr_export dry-run
```

`dry-run` prints the filename and first ~20 lines **including the authoritative header row**. This is the proof that the column set and values are what Equinox expects, before a single byte ships. Confirm with Equinox, then:

```
hostname | grep -q '^services$' && sudo docker compose -f docker-compose.services.yml exec api python -m services.cdr_export run-once
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT status, filename, row_count, sent_at FROM cdr_export_log ORDER BY created_at DESC LIMIT 3;"
hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml --profile cdr-export up -d cdr-exporter
```

---

## 3. Phase 2 — this week (no window needed)

Apply the canonical predicate `AND leg IS DISTINCT FROM 'B'` across every consumer. **Every one of these is provably a no-op while no B-leg rows exist** — you can verify each against live production data and confirm the numbers are unchanged. That is the entire point of doing it before Phase 3.

| surface | count | notes |
|---|---:|---|
| `call-quality.json` | 26 panels | 16 double, 6 skew (a B-leg carries its own RTP stats → two samples measuring different legs), ACD reads the CAGG |
| `noc-home.json` | 11 panels | 5 double, 6 skew |
| `traffic-status.json` panels 63-66 | 4 | already filter `direction='inbound'` — **add the leg predicate anyway**; do not let four billing-adjacent tiles depend on a channel var set in a Lua file |
| `cdrs.py:1403` `_build_cdr_filters` | 1 | **fixes list + count + all three summary groupings at once** |
| `trunks.py:568`, `sbc.py:26`, `search.py:228`, `calls.py:586` | 4 | |
| UI: CallsKpiStrip, CallsPage, CdrSummaryView, QualityTrendsSection, RcfPage, TrunkCard/TrunksPage | 8 | **RcfPage is the highest customer-visible risk** — Call Activity would show every call twice |
| `scripts/backup/asr_guard.sh:40-45` | 1 | **paging path — do not let it depend on `direction`** |
| `call-quality.json:1684` (ACD) | 1 | add `AND direction='inbound'` — free, `direction` is already a CAGG GROUP BY key |

Also: create `idx_cdrs_call_id` with `transaction_per_chunk`; add an orphan-leg Grafana panel; add `48_cdr_call_legs.sql` to `tests/cdr_schema.py:52`.

> **UI contract trap.** Adding a `leg` param to `cdrSearchQuery` (`api/cdrs.ts:39`) without adding it to `_build_cdr_filters` and the endpoint signature is a **silent no-op** — FastAPI drops undeclared query params. Both ends, same PR.

**Do NOT touch `cdr_hourly_stats`.** It is a continuous aggregate with no WHERE clause; its query cannot be `ALTER`ed and the repair is DROP + re-materialize 90 days. Because `direction` is already a GROUP BY key, a `direction='outbound'` B-leg extends it harmlessly. Fix its two consumers instead.

---

## 4. Phase 3 — gated, after Phase 2 lands

### 4.1 The blocker

`set_var()` is **A-leg only** (`inbound_router.lua:1405`). Every attribution variable the ingest depends on is an A-leg channel var. Combined with the ingest defaults:

- `cdrs.py:803` — `direction` defaults to `'inbound'`
- `cdrs.py:804` — `product_type` defaults to `'trunk'`
- `cdrs.py:848` — `customer_id` defaults to `0`

**A B-leg CDR emitted today lands as `direction='inbound'`, `product_type='trunk'`, `customer_id=0`.** That is the mechanism by which this change silently double-bills. In severity order it would: corrupt `cdr_hourly_stats` irreversibly, page the on-call via `asr_guard.sh`, double the four minutes tiles, and ship `customer_id=0` rows to Equinox.

`direction='outbound'` on the carrier leg is the single highest-stakes value in the entire change.

### 4.2 The dormant half that already exists

The ingest has a complete B-leg classifier (`cdrs.py:786-804` → `stir_outcome.py:279-309`) written for `log-b-leg=true`. It **never INSERTs** — it converts every B-leg into a STIR-outcome UPDATE on the A-leg row. So flipping `log-b-leg` today produces **zero rows and silently swallows every B-leg**.

That is a blocker *and* a gift: it is a completely safe way to get real B-leg payloads flowing in production before writing a row.

> `cdr-leg=a` at `json_cdr.conf.xml:59` is **not a real mod_json_cdr parameter** — it is inert. The only live leg filter is `log-b-leg=false` at `:102`, whose comment misleadingly says *"Disable base64 encoding"*. Two of three comments in that block are attributed to the wrong parameters. Do not make this change by reading the comments.

### 4.3 The failover storm

Every bridge attempt is a separate session reaching mod_json_cdr. RCF's loop is **4 trunks × 2 SBCs = 8 attempts** (`inbound_router.lua:433-434`, `:1512-1529`); legacy fallback 4; trunk/api 2. Naive `log-b-leg=true` = **up to 9 POSTs for one call**, 8 of them unbillable carrier rejections.

**Nobody has measured the real distribution.** That measurement is the first deliverable of Phase 3, and it is what the West canary is for.

Rating stays correct automatically — failed attempts have `answer_time IS NULL` → `billed_ms = 0`. **Counting does not.** Hence `leg_attempt`, and hence the rule for Equinox: **count only `leg='A'` rows; rate every row on its own `billed_seconds`.**

### 4.4 Required FreeSWITCH exports

In the branch that builds a carrier dial string: `direction=outbound`, `product_type`, `customer_id`, `trunk_id`, `on_net`, `on_net_hops`, `origin_customer_id`, `terminating_customer_id`, `inbound_carrier`, `inbound_carrier_pop`, `sbc_id`, `leg_attempt`.

> ⚠ `export` sets the variable on the A-leg **as well as** propagating it. For per-leg values (`direction`, `leg_attempt`) use `export nolocal:<var>=<val>`. Getting this wrong flips every inbound row to `direction='outbound'` and re-rates existing inbound calls on the outbound table. **Verify `nolocal:` on a test call before trusting it.**

### 4.5 Column semantics once a call is two rows

- `customer_id` stays the **terminal** customer on **both** rows — migration 23's contract is load-bearing for every customer-scoped query and the CAGG's `GROUP BY customer_id`. The tempting A=origin/B=terminal split silently re-attributes every existing query.
- `origin_customer_id`, `terminating_customer_id`, `on_net`, `on_net_hops` are **call-level facts, copied verbatim onto both rows**.
- Per-leg attribution rides on `leg` + `direction`.
- Per-leg customer settlement, if ever wanted, is a **reporting decision at Equinox** — migration 23 already anticipated this.

### 4.6 On-net: no split

| case | rows |
|---|---:|
| on-net terminal = API DID | 1 (zero B-legs by construction) |
| on-net terminal = trunk DID (PBX delivery) | 1 — B-leg exists but touches no carrier |
| on-net chain, terminal off-net PSTN | 2 |
| local extension | 1 |
| hard reject (603/483) or all attempts fail (503) | 1 |

**The split trigger must be an explicit flag set by the branch that builds a carrier dial string — never inferred from leg topology.** "B-leg exists" ≠ "carrier leg".

### 4.7 Cutover

The two sides are independently safe **in either order** — API-first with `log-b-leg=false` means no B-leg bodies arrive; FS-first with the current early-return means B-legs land in `_apply_b_leg_stir_outcome` which never inserts. **The cutover is one parameter**, `log-b-leg` at `json_cdr.conf.xml:102`, revertible in seconds, per zone.

Flip **West only** first (lowest traffic, and `west-loadtest` has the banked SIPp harness). Measure 24h: B-leg vs A-leg row count, `direction` distribution, `customer_id=0` count, attestation row count, POST rate. Then East and Central.

> **Two canary traps.** (1) `log-b-leg=true` is *not* observationally neutral today — `_apply_b_leg_stir_outcome` will begin UPDATEing A-leg `stir_outcome` from **failed** attempts, last-POST-wins, regressing a correctly-captured winner. Gate that UPDATE behind "answered carrier leg" first. (2) mod_json_cdr posts **synchronously** from the session's reporting handler — a slow API holds a session thread up to `timeout×(1+retries) + delay×retries` ≈ 19s. Multiplying CDR count multiplies that exposure.

Also gate `_store_call_attestation` (`cdrs.py:528`) to `leg='A'` only — it UPSERTs on `ON CONFLICT (call_id)` and would otherwise create a second attestation row per call, doubling `GET /v1/stir/stats`.

---

## 5. The Equinox conversation — needed before Phase 3

`cdr_export/exporter.py:6-13` explicitly promises: *"Downstream MUST dedup on the CDR `uuid` — it is globally unique."* **Leg splitting breaks that promise.** This is a two-party change.

What Equinox needs to agree to:

1. **`uuid` stays unique per row** — it is the FreeSWITCH *channel* uuid, and A/B legs are different channels. Dedup on `uuid` still works.
2. **`call_id` is the new call-level correlation key.** `COALESCE(call_id, uuid)` is correct on every historical row.
3. **Count calls as `leg='A'` rows only. Rate every row on its own `billed_seconds`.**
4. **Never rate a leg by reference to its partner** — then a lost partner costs reporting completeness, never money.
5. **Unanswered rows arrive with `answered=false` and `billed_seconds=0`** and must never be rated. Reconcile the first three files: rows with `answered='false' AND rated_amount > 0` must be zero.

---

## 6. Rollback

| change | action | time |
|---|---|---|
| export contract | redeploy previous `voip-api` image for `cdr-exporter`; Equinox supersedes by `uuid` | ~2-3 min |
| migration 48 | **never `DROP COLUMN`** — a rewrite on a compressed hypertable. Rollback = stop writing them. Three nullable columns are inert | 0 |
| API | `sudo git checkout <prev-sha> -- docker/api && sudo docker compose -f docker-compose.services.yml up -d --build api` | ~2-3 min |
| FS Lua (Phase 3) | `git checkout` — **bind-mounted and re-read per call**, so the next call uses the old logic, zero dropped calls | seconds |
| B-leg rows already written | suppress from the feed without deleting: `UPDATE cdrs SET exported_at = now() WHERE leg = 'B' AND exported_at IS NULL;` | seconds |
| bad data / destructive DDL | PITR — no down-migrations exist. Full-cluster operation, stops PG | ~4-15 min |

### Corrective re-export, if Equinox needs one

Do **not** `UPDATE cdrs SET exported_at = NULL` over a range: it is DML on compressed chunks (compression fires at 1 day), it re-arms `idx_cdrs_unexported`, and a partial failure interleaves corrected and normal rows into the same file with nothing distinguishing them.

Instead add a one-shot backfill mode that claims the same `cdr_export_lock` lease, selects by explicit `start_time` range **ignoring `exported_at`**, writes under a `CDR_RESEND_` prefix and distinct log status, and **never writes `exported_at`** — so the live watermark is never perturbed and a crash mid-backfill is a no-op.

---

## 7. Half-deployed states

| state | consequence |
|---|---|
| migration 48 applied, old API | **harmless** — columns unused. This is the safe place to park if the window runs short |
| new API, migration missing, **with** tiered fallback | CDRs land minus the new columns; ERROR logged with the remedy; `/health/detailed` degraded |
| new API, migration missing, **without** fallback | **every CDR silently lost.** The 200 contract hides it. Unacceptable |
| new exporter, Equinox mapped to old header | harmless **now** (not yet mapped), breaking **later**. This is the window |
| FS flipped, API without B-leg insert | **safe** — no rows written |
| FS flipped, API inserting, dashboards unfixed | **the state to avoid.** Every NOC volume number doubles; `asr_guard` may page; Equinox gets rows nobody downstream agreed to |
| one zone updated, others not | **benign and indefinitely sustainable** — zones are self-contained. With the feed paused it costs only a growing backlog |

**Retention deadline:** any CDR still `exported_at IS NULL` after **90 days** is dropped by retention and can never be exported. A paused feed is safe for a night or a week, not a quarter.

---

## 8. Open items found during review (not in scope, worth tickets)

1. **`cdr_hourly_stats` may be mostly empty.** Created `WITH NO DATA` with a 3-hour rolling refresh and no explicit `materialized_only`; TimescaleDB flipped that default in 2.13 and prod runs 2.26.3. `call-quality.json` panel 3's ACD may be reading a nearly-empty aggregate. Smoke test: open that panel; blank beyond ~3h back means history was never backfilled.
2. **`stir_outcome` / `stir_eff_actual` are not in the Equinox export at all** — `SELECT_COLUMNS` stops at `inbound_carrier_pop`, and the drift guard only parses migrations 16/18/23/40 so it does not catch the omission.
3. **`TrunksPage.tsx:249` "Minutes today"** is bound to `minutes_today`, which `trunks.py` never returns. The tile always renders 0. Do **not** wire it to `SUM(duration_ms)` during this work.
4. **`cdr_daily_stats` is dead** — nothing writes or reads it.
5. **`bridge_uuid` falls back to `call_uuid`** (`cdrs.py:974`), polluting it with the self-uuid on unbridged calls.
6. **Replica lag is only alerted for `east-db-standby`** — `west-db` and `central-db` lag is unmonitored.
7. **Both HA runbook drill tables are empty** despite drills having been run.

---

## 9. Execution order summary

1. Pause exporter · record backlog
2. pgBackRest diff · note PITR target
3. Migration 48 (columns only) · verify replication
4. Rebuild + restart API · `components.schema` healthy
5. **Live test call → go/no-go**
6. `dry-run` → confirm header with Equinox → `run-once` → verify → restart loop
7. *(this week)* Phase 2 predicates — each verifiable as a no-op against live data
8. *(gated)* Phase 3 — FS exports, West canary, measure 24h, then East/Central
