# Maintenance 2026-09-23 — release/2026-09-23-maintenance

One PR, one window. Contents:

| Area | Change | Touches calls? |
|---|---|---|
| Tenant redaction | Customers never receive rates/costs/billable seconds/exact durations; `traffic_grade` hidden | No |
| API Calling | Retired: `API_CALLING_ENABLED` off → `/v1/calls` 404, API DIDs 603; payments demo removed | Lua: calls to API DIDs only |
| Customer Reporting | `/reporting` page + `/v1/reports/*` | No |
| NOC concurrency | Exporter peak gauges, 15s rules, Home/Traffic Status/Call Quality panels | No (sidecar only) |
| CDR billing + A/B split | Migrations 48/49, ms-precision ingest, billing-first export, B-leg rows, one-row-per-call reads | FS: dial-string vars + `mod_json_cdr` reload |

Conventions: every command is `sudo`, single line, from `/opt/revup`, hostname-guarded. **Never run a plain `up -d` on the media stack** — `docker-compose.media.yml` changed the `freeswitch` service (new `API_CALLING_ENABLED` env line), so compose would recreate FreeSWITCH and drop every live call. Always name the service and pass `--no-deps`.

Hostnames: services `services` · East FS `fs-media-v2` (FS-1), `east-fs-2` · West FS `west-fs`, `west-fs-2` · Central FS `central-fs`, `central-fs-2`. SBCs need nothing from this PR.

---

## 0. Before the window (workstation)

1. Merge the PR into `RCF-V1` and confirm: `git fetch origin && git log --oneline -3 origin/RCF-V1`
2. **STIR stack pre-flight (hard gate).** This PR sits on top of the STIR stack (#120/#121/#123). This PR changes nothing on the SBCs, but if the SBCs are not yet RUNNING the STIR Kamailio config, tonight's media `git pull` would ship the STIR FreeSWITCH changes ahead of them (the SBC-before-media X-From-Name constraint). On each SBC: `cd /opt/revup && git merge-base --is-ancestor 5a471e5 HEAD && echo PULLED; sudo docker inspect -f '{{.Created}}' voip-kamailio; git log -1 --format=%cI 5a471e5` — the checkout must contain `5a471e5` (last kamailio.cfg change, PR #123) AND the container must have been created after that. If not, run `docs/runbooks/STIR_STACK_DEPLOY_RUNBOOK.md` §2 (SBCs) FIRST.
3. **Migration inventory (hard gate).** Every migration after first initdb is applied by hand; confirm nothing earlier was missed: `hostname | grep -q '^services$' && cd /opt/revup && sudo git pull && sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql` — every row except 48/49 must read `applied`. Any other `*** MISSING ***`: apply ONLY the missing ones, in number order, in §2 BEFORE 48 (inserts are `ON CONFLICT`-guarded, creates are `IF NOT EXISTS`). View trap: 40, 44 and 45 each `CREATE OR REPLACE VIEW carrier_trunk_health` — if you (re)apply 40 or 44, re-apply 45 right after, or the view regresses/errors. **except 43** (one-shot jitter backfill — read its header; it needs `-v cutoff=<first new-API deploy time>`; never re-run it). 47 is expected MISSING only if the STIR stack's services step (#121) was never done.
4. On `services`, confirm nothing has been rated (else see the plan §6 corrective re-export): `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT count(*) AS rated FROM cdrs WHERE rated_at IS NOT NULL;"` → `0`.
5. Test phone ready. Test DID `+16174544217` → `+17744045256`.

---

## 1. Services VM — pause the feed, back up

1. `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml stop cdr-exporter`
2. `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT count(*) AS unexported, min(start_time), max(start_time) FROM cdrs WHERE exported_at IS NULL;"` (record)
3. `hostname | grep -q '^services$' && sudo -u postgres pgbackrest --stanza=main --type=diff backup && sudo -u postgres pgbackrest --stanza=main info` (record the UTC time = PITR target)

## 2. Services VM — pull + migrations (47 → 48 → 49)

1. `hostname | grep -q '^services$' && cd /opt/revup && sudo git pull && git log --oneline -1`
2. 47 (idempotent; no-op if the STIR stack already applied it): `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/47_cdr_stir_outcome.sql`
3. 48: `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/48_cdr_call_legs.sql`
4. Verify: `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "\d+ cdrs" | grep -E "stir_outcome|stir_eff_actual|leg|call_id|leg_attempt"` → 5 columns.
5. 49 (index + `cdr_hourly_stats` rebuild; **never** with `-1`/`--single-transaction`): `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/49_cdr_call_legs_index_cagg.sql`
6. Verify index valid: `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_cdrs_call_id';"` → `t`
7. Verify CAGG: `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates WHERE view_name = 'cdr_hourly_stats';"` → `f`
8. Replication healthy: `hostname | grep -q '^services$' && sudo -u postgres psql -X -c "SELECT application_name, state, replay_lag FROM pg_stat_replication;"`

If 49 fails: the old CAGG survives (the DROP/CREATE block rolls back). Nothing depends on 49 except the ACD panel's leg-exactness — continue the window and fix 49 afterwards.

## 3. Services VM — rebuild API + UI, reload rules/dashboards

1. `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml build api ui ops-agent`
2. `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --no-deps api ui ops-agent`
3. `hostname | grep -q '^services$' && sudo docker restart voip-vmalert voip-grafana`
4. Health: `curl -s http://127.0.0.1:8088/health/detailed | python3 -m json.tool | grep -A1 '"schema"'` → `healthy`
5. Logs: `sudo docker logs --since 5m voip-api 2>&1 | grep -iE "UndefinedColumn|CRITICAL|ERROR|Application startup complete" | tail -10` → startup complete, no schema errors.
6. API Calling retired: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8088/v1/calls` → `404`
7. vmalert loaded the new group: `curl -s http://127.0.0.1:8880/api/v1/rules | grep -o '"name":"noc_concurrency"'` (from inside the VM network; or check `sudo docker logs --since 2m voip-vmalert`).

## 4. GO / NO-GO — A-leg shape (FS not yet touched)

Place a test call to `+16174544217`, hang up after ~20 s, then:

`hostname | grep -q '^services$' && sudo -u postgres psql -d voip -x -c "SELECT uuid, leg, call_id, leg_attempt, direction, customer_id, product_type, start_time, answer_time, end_time, duration_ms, billable_ms FROM cdrs ORDER BY start_time DESC LIMIT 2;"`

Expect: `leg='A'`, `call_id = uuid`, `leg_attempt` NULL, `billable_ms`/`duration_ms` NOT multiples of 1000 (ms precision), timestamps with sub-second parts. **If wrong → rollback §9 (API only); nothing has shipped to Equinox.**

Portal checks (browser):
- Customer login → Calls/RCF Call Activity: lengths show "about N min", no cost/rate/billable column; detail modal has no billing section.
- Customer → **Reporting** (sidebar, above Guides): summary sentence, charts, CSV download, PDF download.
- Admin → Calls & Quality: "Rows" filter present; styling looks right (lazy-load CSS order change).
- Grafana → Home: "Traffic · Concurrent HWM — 24h" tile; Traffic Status concurrency section; no panel shows a SQL error.

## 5. Media VMs — per FS node

Order: **West** (`west-fs-2` → `west-fs`) → **Central** (`central-fs-2` → `central-fs`) → **East** (`east-fs-2` → `fs-media-v2`). Standby (-2) first. For each node, replace `<HOST>`:

1. Live calls (record; prefer a quiet moment): `hostname | grep -q '^<HOST>$' && sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "show calls count"'`
2. Pull (Lua is bind-mounted and re-read per call — takes effect on the next call: API-DID 603, `[cdr_*]` carrier-leg vars): `hostname | grep -q '^<HOST>$' && cd /opt/revup && sudo git pull && git log --oneline -1`
3. Activate B-leg CDRs (`log-b-leg=true`; module reload, NOT a container restart): `hostname | grep -q '^<HOST>$' && sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "reloadxml" && /usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "reload mod_json_cdr"'` — read the output (fs_cli exits 0 even on `-ERR`).
4. Verify module loaded: `hostname | grep -q '^<HOST>$' && sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "module_exists mod_json_cdr"'` → `true`. If `false`: same command with `-x "load mod_json_cdr"` immediately (no CDRs are written while unloaded).
5. Rebuild the ops sidecar ONLY (peak gauges): `hostname | grep -q '^<HOST>$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d --build --no-deps ops-agent`
6. Peak gauges live: `curl -s http://127.0.0.1:9103/metrics | grep -E "^freeswitch_(calls_active|channels)_peak"`
7. FreeSWITCH untouched: `sudo docker ps --filter name=voip-freeswitch --format '{{.Status}}'` → uptime NOT reset.

After the zone's FS-1 is done, verify real traffic on `services` (wait for a few forwarded calls, or place a test call if it lands in this zone):

`hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT leg, direction, leg_attempt, customer_id, product_type, (answer_time IS NOT NULL) AS answered, freeswitch_node, call_id FROM cdrs WHERE start_time > now() - interval '20 minutes' ORDER BY call_id, leg, leg_attempt LIMIT 30;"`

Expect per off-net forwarded call: one `A` row + ≥1 `B` row(s) with the same `call_id`, B `direction='outbound'`, B `customer_id` = the A row's (never 0), attempts 1..N. On-net / rejected calls: A only.

Leak check (must be 0 rows — a `cdr_*` var on an A-leg would flip its direction):
`hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT count(*) FROM cdrs WHERE leg = 'B' AND (customer_id = 0 OR call_id IS NULL OR direction <> 'outbound') AND start_time > now() - interval '1 hour';"`

Optional live A-leg proof during a call: `sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "show calls"'` → take the A uuid → `-x "uuid_dump <uuid>" | grep cdr_` → no output on the A-leg.

Grafana → Call Quality → "Carrier legs per call — last 24h": Orphan B rows = 0.

**Stop and roll back this node (§9) if**: `customer_id=0` B rows, A-leg `direction` flipped, FS errors in `sudo docker logs --since 10m voip-freeswitch 2>&1 | grep -iE "json_cdr|lua.*error"`, or the ingest logs errors: `sudo docker logs --since 10m voip-api 2>&1 | grep -iE "b-leg|cdr_leg|dropped"`.

## 6. Resume the Equinox feed

1. `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml exec api python -m services.cdr_export test-connection`
2. `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml exec api python -m services.cdr_export dry-run` — header starts `call_id, leg, uuid, customer_id, product_type, direction, answered, billed_seconds, billed_ms, ring_ms, …`; unanswered rows `answered=false`, `billed_seconds=0`.
3. `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml exec api python -m services.cdr_export run-once`
4. `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT status, filename, row_count, sent_at FROM cdr_export_log ORDER BY created_at DESC LIMIT 3;"`
5. `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml --profile cdr-export up -d --no-deps cdr-exporter`

Equinox rule (send with the first file): **count calls = `leg='A'` rows; rate every row on its own `billed_seconds`; `uuid` unique per row; `call_id` groups a call's legs; never rate a leg by reference to its partner.**

## 7. Post-window checks (next morning)

- Orphan-leg panel 0; `B awaiting A` only transient.
- `asr_guard.sh` ran without paging (it now measures every call row incl. trunk outbound — wider than before; watch its first runs).
- Disk: `sudo docker exec voip-freeswitch sh -c 'ls /var/log/freeswitch/json_cdr | wc -l'` on each FS — `log-http-and-disk=true` now writes one file per B-leg attempt too; check retention.
- Session pressure: mod_json_cdr posts synchronously (up to ~19 s per session if the API is slow) and there are now up to N+1 posts per call — watch `show channels count` / the new channels HWM panel.
- `.env` cleanup (nothing reads them now): `PAYMENTS_DEMO_*`, `PAYMENT_PROVIDER`, `AUTO_RECHARGE_MAX_FAILURES`.

## 8. Known behaviour changes

- Customer minutes are talk time (answer → end), whole minutes; customer lists no longer show carrier.
- Granite's billing estimate no longer has the $199 "API Calling" line (hybrid = RCF + SIP Trunking).
- Stale API DIDs answer 603 (declined), not 404.
- Per-zone concurrency thresholds 3,500 / 4,500 calls (≈ max-sessions 10,000 ÷ 2 legs).
- HWM windows fill from tonight onward (no backfill).

## 9. Rollback

| What | How | Time |
|---|---|---|
| B-leg rows only (keep everything else) | per FS: `cd /opt/revup && sudo sed -i 's\|<param name="log-b-leg" value="true"/>\|<param name="log-b-leg" value="false"/>\|' docker/freeswitch/conf/autoload_configs/json_cdr.conf.xml && sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "reloadxml" && /usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "reload mod_json_cdr"'` (file left dirty — `sudo git checkout -- docker/freeswitch/conf/autoload_configs/json_cdr.conf.xml` to re-enable). API-side kill switch: `CDR_B_LEG_ROWS=false` in services `.env` + recreate `api` | seconds / 2 min |
| B rows already written | suppress from the feed without deleting: `sudo -u postgres psql -d voip -c "UPDATE cdrs SET exported_at = now() WHERE leg = 'B' AND exported_at IS NULL;"` | seconds |
| FS Lua | `cd /opt/revup && sudo git checkout <prev-sha> -- docker/freeswitch/scripts` — re-read on the next call, zero dropped calls | seconds |
| API/UI | `cd /opt/revup && sudo git checkout <prev-sha> -- docker/api docker/ui && sudo docker compose -f docker-compose.services.yml build api ui && sudo docker compose -f docker-compose.services.yml up -d --no-deps api ui` — the old API writes fine on the new schema | ~3 min |
| Migrations 48/49 | never `DROP COLUMN`; the three nullable columns are inert. CAGG: re-run `05_schema_cdr.sql`'s CAGG block only if needed | 0 |
| Dashboards / rules | `git checkout <prev-sha> -- docker/homer/grafana docker/vmalert` + `sudo docker restart voip-grafana voip-vmalert` | 1 min |
| Bad data / destructive | pgBackRest PITR to the §1 timestamp | 4–15 min |

`<prev-sha>` = the `RCF-V1` commit before this PR's merge (`0e42e3a`).
