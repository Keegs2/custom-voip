# Maintenance 2026-11-03 — Verizon platform (dark) + CRAG Admin redesign (#168 #169 #170 #171 #172)

One low-traffic window (ET overnight). The owner runs every command by hand. Structure follows
`docs/runbooks/MAINTENANCE_2026-09-23.md` and `MAINTENANCE_2026-10_ALL_OPEN_PRS.md`.

**Target: `RCF-V1` = `b329831` (`b3298319637eda55fab34696bbd7e2222e2362e9`), the #172 merge commit. Every VM ends on exactly this commit.**
CI passed on `b329831` [V]. It is `caeb2ff` (#168, #169, #170 with #171) plus #172 head `43c8c89`. Apart from
#168/#169 docs and `infra/vz-ipsec/`, its tree equals `43c8c89`'s [V].

Prepared 2026-11-03 read-only.
Labels: **[V]** = checked in git, a PR body or a local run. **[I]** = inferred and not run against
production.

| PR | What | Where it runs |
|---|---|---|
| #168 | Verizon IPsec plan docs | nothing |
| #169 | `infra/vz-ipsec/` gateway on-box stack | nothing in this window. It is installed later on the 6 `*-vz-gw-*` VMs, when Verizon sends the PSK and peer IPs |
| #170 (+ #171) | SBC Verizon mode (dark); the 422 retry fix; peer hand-off reply fix; uncapped carrier hunt; migration 62; Homer aliases; `vz_gateway` scrape job; `vz_ipsec` vmalert rules | DB, services (`api`, `heplify-server`, `vmalert`), all 6 SBCs (`kamailio`, `carrier-monitor`), all 6 media VMs (`git pull`, vmagent HUP) |
| #172 | Admin redesign API (C1–C7); premium (Tier 1) routing; trunk CPS fix; Kamailio header spoof-strip; Equinox `enterprise`→`standard` mapping; migrations 63/64/65 | DB, services (`api`, `cdr-exporter`), all 6 SBCs, all 6 media VMs |

**Pre-window gates (workstation)**
- #172 is merged (`b329831`), and CI is green on it [V, 2026-11-03].
- Confirm that `RCF-V1` has not moved: `git -C ~/custom-voip fetch -q origin && git -C ~/custom-voip rev-parse origin/RCF-V1` → `b3298319…`.
  - If it moved, still deploy `b329831`: the pull lines below fast-forward to that exact SHA.
  - Tell the owner what landed after it.
- TED production shows CRAG Admin › Inventory › **Subscribers** in its "Needs the CRAG update" state.
  TED's CRAG Admin redesign (grteng/ted-next #1475) is in production: the 2026-11-03 17:04Z
  promote (`6fbe3c505`) contains it [V]. TED staging also reads production CRAG, so either works
  for the TED-side checks.

**What does not change in this window**
- **Verizon stays dark.** Do not set any `VERIZON_*` variable and do not enable a Verizon row. With
  the variables unset, every `VERIZON_MODE` block is removed from the rendered `kamailio.cfg`.
- **Owner OpenTofu items from #170 are NOT in this window.**
  - `infra/monitoring` apply: #170 describes it as an in-place update of the `vm_down` policy.
  - `infra/vz-ipsec-gcp` import: acceptance-gated, and the plan must show imports only.
  - #170's body does not require either one before the code. Both monitor or import the gateways,
    which carry no traffic [V, PR body]. Do them on another day.
- **FreeSWITCH is not restarted.** `docker-compose.media.yml`, the FS Dockerfile and the FS XML conf
  are unchanged from `29fd90f` to `b329831`; the only change under `conf/` is `CLAUDE.md` [V].
- **The UI rebuild is optional.** It contains type changes and `index.html` only.

**Expected customer impact**
- 6 NLB transitions: two per zone, about 10–12 s each, during Phase 3. Setups in flight at a
  transition are lost; established calls survive by design (this is unlogged, runbook §8).
- The API recreate takes a few seconds. FS CDR posts retry.
- Pause TED CRAG customer create and edit from step 1.6 to the end of 2.2 (about 2 minutes). Until the
  new API runs, the old API sends `standard`, which 63's CHECK refuses.
- Expect and acknowledge "CRAG · SBC failover state — {zone} primary UNHEALTHY (zone on standby)",
  once per zone.

**Conventions** (CLAUDE.md "Deployment Model")
- **Pinned pull.** CLAUDE.md's `sudo git pull` is written here as `sudo git fetch -q origin && sudo git merge --ff-only b3298319…`.
  - Like a pull, it moves the VM's `RCF-V1` branch forward.
  - Unlike a pull, it stops at exactly `b329831` even if `RCF-V1` moves later.
  - The `test "$(sudo git rev-parse HEAD)" = …` that follows fails the line if HEAD is anything else.
- Every command is one line, uses `sudo`, and runs on the host named in **bold**.
- Commands are hostname-guarded: if the guard does not match, nothing runs and nothing prints.
- Never use backslash continuations.
- Files saved during the window go to `/var/tmp/crag-20261103-*` on the VM where they were made.

**Hosts** (CLAUDE.md, GCP Production Topology)

| Zone | SBC-1 (primary) | SBC-2 (standby) | FS-1 (active) | FS-2 (standby) | DB |
|---|---|---|---|---|---|
| East | `poc-custom-voip` | `kam-g2` | `fs-media-v2` | `east-fs-2` | `services` (primary), `east-db-standby` |
| West | `west-sbc-1` | `west-sbc-2` | `west-fs` | `west-fs-2` | `west-db` |
| Central | `central-sbc-1` | `central-sbc-2` | `central-fs` | `central-fs-2` | `central-db` |

**Zone order** for Phases 3 and 4: **West → Central → East**. East goes last because it holds the
primary and East FS reads the primary directly (2026-09-23 precedent; my choice, change it if
another zone is quieter).

**Duration** (estimates [I]; Kamailio image builds are the main unknown)

| Phase | Estimate |
|---|---|
| 0 Prechecks (read-only; start about 60 min before the window) | 40 min |
| 1 Migrations 62→65 (including the API pre-build) | 15 min |
| 2 Services API | 10 min |
| 3 SBCs (3 zones × about 30 min) | 90 min |
| 4 Media VMs + services sidecars | 35 min |
| 5 Post-checks | 30 min |
| **Total** | **about 3 h 40 min; book 4 h 30 min with buffer** |

**Window record** (fill in as you go)

| Phase | Start (ET) | End (ET) | Result / notes |
|---|---|---|---|
| 0 | | | |
| 1 | | | |
| 2 | | | |
| 3 West / Central / East | | | |
| 4 | | | |
| 5 | | | |

---

## 0. Prechecks: record what is running (read-only, nothing changes)

### 0.1 Every code VM (13: `services`, 6 SBCs, 6 media)

On each host, replace `<HOST>`:

1. **<HOST>** `hostname | grep -q '^<HOST>$' && sudo git -C /opt/revup rev-parse HEAD && sudo git -C /opt/revup rev-parse --abbrev-ref HEAD && sudo git -C /opt/revup status --porcelain`
   - Expect: a SHA, `RCF-V1`, and no `M`/`D` lines.
   - On SBCs the only expected line is `?? docker-compose.stir-key.yml`.
   - **Record the SHA as that VM's `PRE_SHA`.** It is the rollback target.
2. **<HOST>** `hostname | grep -q '^<HOST>$' && sudo grep -c '^VERIZON_' /opt/revup/.env`
   - Expect `0` on all 13 VMs.
3. **<HOST>** `hostname | grep -q '^<HOST>$' && sudo git -C /opt/revup fetch -q origin && sudo git -C /opt/revup log --oneline -1 origin/RCF-V1 && sudo git -C /opt/revup rev-list --count HEAD..b329831`
   - Expect `b329831` (`origin/RCF-V1` may be ahead if someone merged since; we still deploy `b329831`). A fetch changes no files.
4. **Media VMs only** (6). Confirm no FreeSWITCH service definition change:
   `hostname | grep -q '^<HOST>$' && sudo git -C /opt/revup diff --stat HEAD b329831 -- docker-compose.media.yml docker/freeswitch/Dockerfile docker/freeswitch/patches`
   - Expect **empty output**. That is true from `29fd90f` [V].
   - If this VM's `PRE_SHA` is older and the output is not empty, **stop**. That FS needs a planned
     recreate (Gotcha 14), which is not in this runbook.

**Abort if:**
- any VM is dirty (other than the STIR overlay) or not on `RCF-V1`;
- any `VERIZON_*` line exists;
- the 6 SBCs or the 6 media VMs are on different `PRE_SHA`s that you cannot explain.

**Inferred:** the `PRE_SHA` is probably `29fd90f` (#167) or older [I]. If it is older, this window
also ships every change between `PRE_SHA` and `29fd90f`. Read
`git log --oneline <PRE_SHA>..29fd90f` before you continue.

### 0.2 Every SBC (6): STIR overlay and current render

1. **<SBC>** `hostname | grep -q '^<SBC>$' && sudo docker inspect voip-kamailio --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`
   - Expect a comma list that **includes `docker-compose.stir-key.yml`**, for example
     `/opt/revup/docker-compose.sbc.yml,/opt/revup/docker-compose.stir-key.yml`.
   - **If it is missing, stop.** That SBC is already signing nothing (the 2026-10-15 failure mode).
     Fix it on its own first.
2. **<SBC>** `hostname | grep -q '^<SBC>$' && sudo docker inspect voip-kamailio --format '{{range .Mounts}}{{.Destination}} {{end}}' | sudo tee /var/tmp/crag-20261103-kam-mounts-pre.txt`
   - The STIR key mount destination must be in the list.
3. **<SBC>** `hostname | grep -q '^<SBC>$' && sudo grep -E '^(STIR_SHAKEN_SIGN|SBC_SIGNALING_VIP|SBC_PEER_INTERNAL_IP|TF_TEST_TNS)=' /opt/revup/.env`
   - Expect `STIR_SHAKEN_SIGN=on`, both VIP/peer lines set, and `TF_TEST_TNS=5595335873,5595335908`.
4. **<SBC>** `hostname | grep -q '^<SBC>$' && sudo docker exec voip-kamailio cat /etc/kamailio/kamailio.cfg | sudo tee /var/tmp/crag-20261103-kam-pre.cfg >/dev/null && sudo wc -l /var/tmp/crag-20261103-kam-pre.cfg`
5. **<SBC>** `hostname | grep -q '^<SBC>$' && sudo docker exec voip-kamailio kamcmd dispatcher.list | grep -E 'SETID|URI|FLAGS'`
   - Expect groups 1 (FS-1, FS-2) and 10 (peer) `AP`.
   - **No zone may have an FS drained or down. If one has, stop.**
6. **<SBC>** `hostname | grep -q '^<SBC>$' && curl -s -m2 http://127.0.0.1:8080/healthz`
   - Expect `OK fs_up=1` on both SBCs.
   - `DRAINING` means a leftover drain. Clear it or stop.

### 0.3 Services VM: database baseline

1. **services** `hostname | grep -q '^services$' && sudo git -C /opt/revup show b329831:scripts/db/check_migrations.sql | sudo -u postgres psql -d voip -f -`
   - This is the new 22..65 checker, read from the fetched commit; the working tree is not touched.
   - Expect every row up to `61_ivr_assist` `applied`, and `62_verizon_trunks`, `63_admin_redesign`,
     `64_carrier_tier1` and `65_cdr_premium_fallback` `*** MISSING ***`.
   - **Any MISSING at 61 or below: stop.** Production is behind, and applying old migrations is a
     separate decision. Never re-run 43.
2. **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT pid, state, application_name, xact_start, now()-xact_start AS age, left(query,80) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' OR (xact_start < now() - interval '10 seconds' AND state <> 'idle')"`
   - Expect 0 rows, or only known short-lived maintenance sessions.
   - Re-run it immediately before 1.6.
3. **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -Atc "SELECT application_name, state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS bytes_behind, replay_lag FROM pg_stat_replication ORDER BY 1"`
   - Expect 3 rows `streaming` (east standby, west, central), each a few MB behind at most.
   - A missing replica means stop: its zone would run the new Lua against the old schema.
4. **Save `traffic_grade` (63 overwrites it; this file is the only way back):**
   **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "\copy (SELECT id, traffic_grade FROM customers ORDER BY id) TO '/var/tmp/crag-20261103-traffic_grade_pre63.csv' CSV HEADER" && sudo cp -p /var/tmp/crag-20261103-traffic_grade_pre63.csv /root/ && sudo wc -l /var/tmp/crag-20261103-traffic_grade_pre63.csv`
   - Expect `COPY <n>`, and a line count of n+1.
   - Also copy the file off the VM (for example `gcloud compute scp` to your workstation; reading a
     file off a VM is not a deploy).
5. **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT traffic_grade, count(*) FROM customers GROUP BY 1 ORDER BY 1"`
   - Record the counts. Expect only `premium`/`standard`/`economy`/NULL.
6. **STIR mix baseline, per zone, last 60 min** (`stir_eff_actual` is stored on the A-leg row [V],
   migration 47):
   **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -o /var/tmp/crag-20261103-stir-baseline.txt -c "SELECT split_part(freeswitch_node,'-',1) AS zone, stir_eff_actual, count(*) FROM cdrs WHERE start_time > now() - interval '60 minutes' AND leg IS DISTINCT FROM 'B' AND stir_eff_actual IS NOT NULL GROUP BY 1,2 ORDER BY 1,2" && sudo cat /var/tmp/crag-20261103-stir-baseline.txt`
   - Record the shares. Expect `div`/`A`/`C` to dominate, with `unsigned` at or near 0 [I].
7. **Traffic baseline per FS node, last 60 min:**
   **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -o /var/tmp/crag-20261103-traffic-baseline.txt -c "SELECT freeswitch_node, count(*) AS calls, count(answer_time) AS answered FROM cdrs WHERE start_time > now() - interval '60 minutes' AND leg IS DISTINCT FROM 'B' GROUP BY 1 ORDER BY 1" && sudo cat /var/tmp/crag-20261103-traffic-baseline.txt`
8. **Termination rows** (the uncapped hunt matters only above 4 rows per class):
   **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT COALESCE(traffic_class,'any') AS cls, count(*) FROM carrier_trunks WHERE enabled AND direction IN ('outbound','both') GROUP BY 1 ORDER BY 1"`
   - If `ld` + `any` ≤ 4 and `tollfree` ≤ 4, removing the cap changes no call today [I].
9. **CDR exporter state:**
   **services** `hostname | grep -q '^services$' && sudo docker ps -a --filter name=voip-cdr-exporter --format '{{.Names}} {{.Status}} {{.Image}}'`
   - Record whether it is **running**. It shares the `voip-api:latest` image, so an API rebuild alone
     does NOT give it the Equinox `enterprise`→`standard` mapping. It must be recreated [V, compose].
10. **Test numbers ready** (CLAUDE.md, Testing):
    **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT did, forward_to, enabled FROM rcf_numbers WHERE did LIKE '%6174544217' OR did LIKE '%5595335873' OR did LIKE '%5595335908'"`
    - RCF test DID `+16174544217`: note its current `forward_to`. In the 2026-10-23 tests it rang
      `+17744045256`.
    - Sinch origination TNs: `5305480845` (Denver), `5305480846` (Chicago).
    - Toll-free 8XX-T TN: `5595335873` (ATL).
    - Have a customer SIP-trunk test PBX and an 8YY destination ready (owner-supplied; CLAUDE.md
      names none).

**Phase 0 abort criteria (summary):** any of the above fails. Nothing has changed yet; reschedule.

---

## 1. Database: migrations 62 → 63 → 64 → 65 on the East primary (`services`)

**No SBC work may run during this phase.** East FS reads the primary, and a lock wait on top of an
NLB flip compounds call-setup loss.

**Lock timeouts:**
- 63 and 64 set `lock_timeout` 1 s, and 65 sets 3 s. Each is one transaction and idempotent [V].
  On `canceling statement due to lock timeout`, just run the same line again, in a quiet minute.
- 62 sets no `lock_timeout`, and has no `BEGIN` [V]. I add `PGOPTIONS='-c lock_timeout=3s'` and
  `-1` (single transaction) [I]. Both are tested to work with psql 16 locally; it is also idempotent
  (`ON CONFLICT DO NOTHING` plus `CREATE OR REPLACE VIEW`).

**Steps:**

1. **services** `hostname | grep -q '^services$' && cd /opt/revup && sudo git fetch -q origin && sudo git merge --ff-only b3298319637eda55fab34696bbd7e2222e2362e9 && test "$(sudo git rev-parse HEAD)" = b3298319637eda55fab34696bbd7e2222e2362e9 && git log --oneline -1`
   - Expect `b329831 Merge pull request #172 …`. A non-fast-forward or a HEAD mismatch prints an error and stops.
   - Code only: running containers are unchanged. heplify, vmalert and the API read their new files
     only on restart.
2. **Pre-build the API image now**, so the 63→API gap is seconds:
   **services** `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml build api`
   - Expect `Built` / `naming to docker.io/library/voip-api:latest`. The running `voip-api` keeps its
     old image until Phase 2.
3. **Stop the CDR exporter**, only if 0.3.9 showed it running. This keeps `enterprise` out of
   Equinox until the new formatter runs:
   **services** `hostname | grep -q '^services$' && sudo docker stop voip-cdr-exporter`
   - Unexported CDRs wait (`exported_at IS NULL`) and go in the next run.
4. **Migration 62:**
   **services** `hostname | grep -q '^services$' && sudo -u postgres env PGOPTIONS='-c lock_timeout=3s' psql -d voip -v ON_ERROR_STOP=on -1 -f /opt/revup/docker/postgres/init/62_verizon_trunks.sql`
   - Expect `INSERT 0 6`, `INSERT 0 3`, `CREATE VIEW`, then the `GRANT` lines, and no `ERROR`. A
     re-run shows `INSERT 0 0`.
   - Verify:
     **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT pop, direction, enabled, host(source_ip) FROM carrier_trunks WHERE carrier='verizon' ORDER BY pop, direction"`
     → 6 rows, all `enabled = f`, all on `192.0.2.x`.
5. Re-run the 0.3.2 `pg_stat_activity` line. It must return 0 rows. **Announce the TED customer
   edit freeze now.**
6. **Migration 63:**
   **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/63_admin_redesign.sql`
   - Expect exactly `BEGIN`, `SET`, `DO`, `DO`, `UPDATE 0`, `ALTER TABLE`, `COMMIT` [V, local
     PG16 run].
   - Verify:
     **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT traffic_grade, count(*) FROM customers GROUP BY 1"`
     → one row, `enterprise`, total = the 0.3.5 total.
   - **Go straight on to 1.7, 1.8, then Phase 2.**
7. **Migration 64:**
   **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/64_carrier_tier1.sql`
   - Expect `BEGIN`, `SET`, `DO`, `COMMENT`, `COMMIT`.
   - Verify:
     **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT carrier, tier1, count(*) FROM carrier_trunks GROUP BY 1,2 ORDER BY 1,2"`
     → `bandwidth | t`, `sinch | f`, `verizon | f`.
   - The new API selects `tier1`, so 64 must precede Phase 2 [V, 64 header].
8. **Migration 65:**
   **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/65_cdr_premium_fallback.sql`
   - Expect `BEGIN`, `SET`, `ALTER TABLE`, `COMMENT`, `DO`, `COMMIT`.
   - If it times out twice, go to Phase 2 anyway and retry 65 after 2.2. 65 is order-independent of
     the API: the ingest skips the UPDATE while the column is missing [V, 65 header].
9. **Gate:**
   **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql`
   - Every row `applied`, including 62, 63, 64 and 65.
10. **Replica catch-up**, before any media pull (Phase 4). Run the 0.3.3 line: all 3 rows
    `streaming`, with `bytes_behind` near 0.
    - Optional replica-side proof, on **east-db-standby**, **west-db** and **central-db** (the Postgres
      layout on the replicas is assumed to match the primary [I]):
      `sudo -u postgres psql -d voip -Atc "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name='carrier_trunks' AND column_name='tier1'), (SELECT count(*) FROM information_schema.columns WHERE table_name='cdrs' AND column_name='term_premium_fallback'), (SELECT string_agg(DISTINCT traffic_grade, ',') FROM customers), (SELECT count(*) FROM carrier_trunks WHERE carrier='verizon')"`
      → `1|1|enterprise|6`.

**Stop / abort:**
- Any `ERROR` other than a lock timeout.
- A lock timeout that repeats 3 times. Find the blocker with the 0.3.2 line. Do not
  `pg_terminate_backend` an unknown client.
- `check_migrations` does not show 62–65 applied.

**Rollback (Phase 1):**
- **62, 64, 65: leave them applied.** They are additive: disabled rows, a superset view, a column
  with a default, and a nullable column. Old Lua and the old API ignore them. Never drop `tier1` or
  `term_premium_fallback` [V, headers].
- **Gotcha 16:** if 53 (or 40..53) is ever re-applied, re-apply **62 last**.
- **63:** leave it applied unless the API is also rolled back. Then restore `traffic_grade` from the
  saved file, which puts back the old 3-value CHECK, the old values and the default
  `standard` [V, local PG16 run]:
  **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -1 -c "SET LOCAL lock_timeout = '1s'" -c "CREATE TEMP TABLE tg_restore (id int, traffic_grade varchar(10))" -c "\copy tg_restore FROM '/var/tmp/crag-20261103-traffic_grade_pre63.csv' CSV HEADER" -c "ALTER TABLE customers DROP CONSTRAINT customers_traffic_grade_check" -c "UPDATE customers c SET traffic_grade = r.traffic_grade FROM tg_restore r WHERE c.id = r.id" -c "UPDATE customers SET traffic_grade = 'standard' WHERE traffic_grade = 'enterprise'" -c "ALTER TABLE customers ADD CONSTRAINT customers_traffic_grade_check CHECK (traffic_grade IN ('premium', 'standard', 'economy'))" -c "ALTER TABLE customers ALTER COLUMN traffic_grade SET DEFAULT 'standard'"`
  - Expect `SET`, `CREATE TABLE`, `COPY <n>`, `ALTER TABLE`, `UPDATE <n>`, `UPDATE <k>`,
    `ALTER TABLE`, `ALTER TABLE`. It is all-or-nothing: any error rolls back the whole thing.
  - Customers created after 63 (not in the file) become `standard`.
  - Afterwards `check_migrations` reports `63_admin_redesign` MISSING. A later re-run of 63 remaps
    everyone to `enterprise` again.
  - Do this only together with the API rollback (2.R). The new API and TED's redesigned CRAG Admin send `enterprise`,
    which the old CHECK refuses.

---

## 2. Services VM: API immediately after 63 (`services`)

1. **services** `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --no-deps --force-recreate api`
   - It uses the image pre-built in 1.2. Expect `Recreated` / `Started` within about 10 s.
   - If 1.2 was skipped, use the CLAUDE.md form:
     `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build --no-deps api`.
2. **Health:**
   - **services** `curl -s http://127.0.0.1:8088/health` → contains `"database":"ok"`.
   - **services** `curl -s http://127.0.0.1:8088/health/detailed | python3 -m json.tool | grep -A1 '"schema"'` → `healthy`.
   - **services** `sudo docker logs --since 5m voip-api 2>&1 | grep -iE "UndefinedColumn|CRITICAL|ERROR|Application startup complete" | tail -20`
     → `Application startup complete`, and no `UndefinedColumn` or `CRITICAL`.
3. **TED-side read** (browser, TED production, CRAG Admin):
   - **Inventory › Subscribers** loads rows and drift cards. It no longer shows "Needs the CRAG
     update".
   - **Carriers:** the table shows a Tier 1 column, with Bandwidth on.
   - Open one customer: its traffic pattern shows **Enterprise**.
   - Then **lift the TED customer edit freeze.**
4. **CDR exporter** (only if it was running in 0.3.9): recreate it on the new image.
   **services** `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml --profile cdr-export up -d --no-deps --force-recreate cdr-exporter`
5. **Equinox mapping is live:**
   **services** `hostname | grep -q '^services$' && sudo docker exec voip-api python -c "from services.cdr_export.formatter import _fmt_traffic_grade as f; print(f('enterprise'), f('premium'), f('standard'))"`
   - Expect `standard premium standard`.
   - Repeat the same line with `voip-cdr-exporter` in place of `voip-api` if it is running.
6. If 65 was deferred in 1.8, run it now and re-run 1.9.
7. Optional: `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build --no-deps ui` (type changes only).

**Stop / abort:**
- `/health` not ok after 60 s.
- Schema errors in the log.
- TED Subscribers or Carriers return errors (rather than the old "Needs the CRAG update" state).

**Rollback (2.R):**
- **services** `hostname | grep -q '^services$' && cd /opt/revup && sudo git checkout <services PRE_SHA> && sudo docker compose -f docker-compose.services.yml up -d --build --no-deps api`
  - Then recreate `cdr-exporter` as in 2.4.
- The old API creates customers as `standard`, which 63's CHECK refuses. Either restore 63 (the
  Phase 1 rollback command), or keep customer creates frozen until you roll forward again.
- Return to the target with `sudo git checkout RCF-V1 && test "$(sudo git rev-parse HEAD)" = b3298319637eda55fab34696bbd7e2222e2362e9`, plus the same
  rebuild.

---

## 3. SBCs: zone by zone, standby first (West → Central → East)

This is one image carrying #170, #171 and #172 together. **Never work on two zones at once.**
Carriers spread calls over all 3 VIPs, so the other two zones must be serving.

**Why pull and rebuild are one line:**
- `entrypoint.sh` is baked into the image [V, Dockerfile], and the template is bind-mounted.
- A restart between the pull and the rebuild would render the new template with the old
  entrypoint: unrendered `__VERIZON_*__` tokens and a parse failure [I].
- The line below derives the compose file list from the running container (Gotcha 15). It refuses
  to pull unless `docker-compose.stir-key.yml` is in that list.

**Per-SBC rebuild line** (`<SBC>` = the host):
`hostname | grep -q '^<SBC>$' && cd /opt/revup && F=$(sudo docker inspect voip-kamailio --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' | sed 's/,/ -f /g') && echo "F=$F" && echo "$F" | grep -q 'docker-compose.stir-key.yml' && sudo git fetch -q origin && sudo git merge --ff-only b3298319637eda55fab34696bbd7e2222e2362e9 && test "$(sudo git rev-parse HEAD)" = b3298319637eda55fab34696bbd7e2222e2362e9 && sudo docker compose -f $F up -d --build kamailio || echo "STOPPED - read the output above"`

**Per-SBC gate block** (run each line after the rebuild):
- G1 `sleep 20; sudo docker exec voip-kamailio kamailio -c -f /etc/kamailio/kamailio.cfg`
  → `config file ok, exiting...`.
  - Without the sleep it races the entrypoint and reports a bogus parse error (Gotcha 15).
- G2 `sudo docker inspect voip-kamailio --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`
  → still includes `docker-compose.stir-key.yml`.
- G3 `sudo docker inspect voip-kamailio --format '{{range .Mounts}}{{.Destination}} {{end}}' | diff /var/tmp/crag-20261103-kam-mounts-pre.txt - && echo MOUNTS-SAME`
  → `MOUNTS-SAME`.
- G4 `sudo docker logs voip-kamailio 2>&1 | grep -oE 'STIR_SHAKEN_SIGN=[a-z]+|SBC_PEER_HANDOFF=[a-z]+|VERIZON_MODE=[a-z]+' | sort -u`
  → `SBC_PEER_HANDOFF=on`, `STIR_SHAKEN_SIGN=on` and **`VERIZON_MODE=off`** (the dark proof).
- G5 `sudo docker logs voip-kamailio 2>&1 | grep -E 'WARNING: Verizon|ERROR: unresolved' | head`
  → nothing.
- G6 `sudo docker exec voip-kamailio kamcmd corex.list_sockets | grep -c '\.251'` → `0`.
- G7 `sudo docker exec voip-kamailio cat /etc/kamailio/kamailio.cfg | diff /var/tmp/crag-20261103-kam-pre.cfg - | grep -ci verizon`
  → `0`.
  - Optional: inspect `... | diff /var/tmp/crag-20261103-kam-pre.cfg - | head -80`. Expect only
    #171's 422/Session-Expires lines, the `remove_hf("X-Trunk-ID")`-family strips, the
    `$avp(carrier_ip)`/`cf_ru`/`cf_du` lines and the `route[REPLY_SRC]` change [V, PR bodies].
- G8 `sudo docker exec voip-kamailio kamcmd dispatcher.list | grep -E 'SETID|URI|FLAGS'`
  → groups 1 and 10 `AP`, and **no `SETID: 13`** [I, output format].
- G9 `curl -s -m2 http://127.0.0.1:8080/healthz` → `OK fs_up=1`.
- G10 **<SBC>** `hostname | grep -q '^<SBC>$' && cd /opt/revup && F=$(sudo docker inspect voip-kamailio --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' | sed 's/,/ -f /g') && sudo docker compose -f $F up -d --build --no-deps carrier-monitor`
  → `voip-carrier-monitor` `Started`. It never touches Kamailio: it has no `depends_on` [V].

**Zone queries** (on **services**; `<zone>` = `west`, `central` or `east`):
- **Zone traffic:**
  `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT freeswitch_node, count(*) AS calls, count(answer_time) AS answered FROM cdrs WHERE start_time > now() - interval '15 minutes' AND leg IS DISTINCT FROM 'B' AND freeswitch_node LIKE '<zone>-%' GROUP BY 1"`
- **Zone STIR mix:**
  `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT stir_eff_actual, count(*) FROM cdrs WHERE start_time > now() - interval '15 minutes' AND leg IS DISTINCT FROM 'B' AND stir_eff_actual IS NOT NULL AND freeswitch_node LIKE '<zone>-%' GROUP BY 1 ORDER BY 2 DESC"`
- **Last calls:**
  `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT start_time, freeswitch_node, product_type, destination, carrier_used, hangup_cause, stir_eff_actual FROM cdrs WHERE start_time > now() - interval '10 minutes' AND leg IS DISTINCT FROM 'B' ORDER BY start_time DESC LIMIT 15"`

### Per zone (do West, then Central, then East)

| Zone | Standby (do first) | Primary | `gcloud` backend (optional, workstation, read-only) |
|---|---|---|---|
| West | `west-sbc-2` | `west-sbc-1` | `gcloud compute backend-services get-health west-sbc-backend --region=us-west1 --project=rugged-night-193017` |
| Central | `central-sbc-2` | `central-sbc-1` | `gcloud compute backend-services get-health central-sbc-backend --region=us-central1 --project=rugged-night-193017` |
| East | `kam-g2` | `poc-custom-voip` | `gcloud compute backend-services get-health sbc-backend --region=us-east1 --project=rugged-night-193017` |

1. **Standby** (carries no traffic, so no flip): run the rebuild line, then G1–G10.
   - Stop on any gate failure; rollback 3.R applies to this SBC only.
2. **Drain the primary**, which moves both planes to the rebuilt standby (flip 1, about 10–12 s):
   **<primary>** `hostname | grep -q '^<primary>$' && sudo docker exec voip-kamailio kamcmd htable.seti maint drain 1 && sleep 2 && curl -s -m2 http://127.0.0.1:8080/healthz`
   - Expect `DRAINING maint=1`. The drain auto-expires after 1 h (dead-man switch).
   - About 30 s later, on the **standby**: `sudo docker exec voip-kamailio kamcmd dlg.stats_active`
     should be rising. Optionally confirm with the `gcloud` line.
   - Acknowledge the "primary UNHEALTHY (zone on standby)" page.
3. **Canary through the rebuilt standby** (about 10 min):
   - **RCF:** call `+16174544217`. It rings its 0.3.10 `forward_to`, with two-way audio.
   - **Sinch origination:** call `5305480845` or `5305480846`.
   - **Toll-free origination:** call `5595335873` (ATL).
   - **SIP-trunk outbound:** a call from the test PBX, pointed at this zone's VIP.
   - **Carriers spread inbound calls over all 3 VIPs.** Use "Last calls" to confirm which
     `freeswitch_node` took each call, and repeat until one lands in `<zone>-fs-1` (or `-fs-2`).
   - "Zone traffic": calls keep being answered at the baseline rate.
   - On the standby: `sudo docker logs --since 10m voip-kamailio 2>&1 | grep -E 'ERROR|no branches for forwarding|CARRIER_FAILURE' | tail -20`
     → no new burst.
   - **Canary stop:** run
     `hostname | grep -q '^<primary>$' && sudo docker exec voip-kamailio kamcmd htable.delete maint drain`
     on the primary. Traffic returns to the old primary in about 10–12 s. Then roll back the standby
     (3.R).
4. **Primary** (still drained, so its rebuild causes no extra flip): run the rebuild line, then
   G1–G10.
   - The new container starts with an empty `maint` table. Once `/healthz` passes, it **fails back
     automatically** (flip 2, about 10–12 s).
   - If it does not start, the zone simply stays on the rebuilt standby. Roll back the primary or
     fix it.
5. **Zone verification** (about 10–15 min) **before the next zone:**
   - G9 on both SBCs: `OK fs_up=1`. The NOC primary card is green.
   - On the primary, `dlg.stats_active` tracks calls. The standby's count stays elevated for up to
     2 h (ghost dialogs). **Never `dlg.end_dlg` them.**
   - G8 on both: group 10 (peer) `AP`.
   - **Zone STIR mix** vs the 0.3.6 baseline: the same signed shares, and no rise in `unsigned` or
     `base-only`.
   - Homer: no 481/408 bursts on BYEs.
   - One RCF test call that lands in this zone succeeds.

**Stop / abort (Phase 3):**
- G1 not `config file ok`.
- G2/G3: the STIR overlay or key mount is missing.
- G4: `VERIZON_MODE` is not `off`.
- G6/G8: a `.251` socket or `SETID: 13` exists.
- `/healthz` is not OK.
- A failed test call.
- Any `unsigned` share above baseline.
- Do not continue to the next zone after any of these.

**Rollback (3.R), per SBC** (the strips, the 422 fix and the dark Verizon code revert together):
1. **<SBC>** `hostname | grep -q '^<SBC>$' && cd /opt/revup && sudo git checkout <that SBC's PRE_SHA> && F=$(sudo docker inspect voip-kamailio --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' | sed 's/,/ -f /g') && echo "$F" | grep -q 'docker-compose.stir-key.yml' && sudo docker compose -f $F up -d --build kamailio`
2. G1, G2, G3, then the same line for `carrier-monitor`.
3. Rebuilding a primary is one flip; do it drained (step 2) if it is still serving.
4. If that zone's media VMs were already pulled (Phase 4), roll them back too. Their CPS-skip
   trusts `X-Trunk-ID` only because the new SBC strips received copies [V, #172 body].
5. Return later with `sudo git checkout RCF-V1 && test "$(sudo git rev-parse HEAD)" = b3298319637eda55fab34696bbd7e2222e2362e9` in the same line as the
   rebuild.

---

## 4. Media VMs: `git pull`, vmagent reload (after ALL 6 SBCs are done), then the services sidecars

Order: `west-fs-2` → `west-fs` → `central-fs-2` → `central-fs` → `east-fs-2` → `fs-media-v2`.

**What this phase changes:**
- The Lua is bind-mounted and takes effect on the next call (Gotcha 14).
- **No FreeSWITCH restart and no `up -d` without a service name.** `docker-compose.media.yml` did not
  change in #170 or #172 [V; 0.1.4 re-checked it against each VM's `PRE_SHA`].
- Live behaviour changes:
  - the uncapped hunt (#170);
  - premium routing (inert until a customer is set to Premium);
  - the trunk CPS fix (#172).

**Per node** (`<FS>`):
1. **<FS>** `hostname | grep -q '^<FS>$' && sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "show calls count"'`
   - Record the count.
2. **<FS>** `hostname | grep -q '^<FS>$' && cd /opt/revup && sudo git fetch -q origin && sudo git merge --ff-only b3298319637eda55fab34696bbd7e2222e2362e9 && test "$(sudo git rev-parse HEAD)" = b3298319637eda55fab34696bbd7e2222e2362e9 && git log --oneline -1`
   - Expect `b329831`.
3. **<FS>** `hostname | grep -q '^<FS>$' && sudo docker kill -s HUP voip-vmagent && sleep 5 && curl -s http://127.0.0.1:8429/targets | grep -c vz_gateway`
   - Expect ≥ 1: this zone's 2 gateways, `up=0` until #169 is installed, which is harmless.
   - **If `0`:** `scrape-media.yml` is a single-file bind mount. `git pull` replaces the file, and a
     HUP can re-read the old copy the container still holds [I].
   - Then recreate only vmagent:
     `hostname | grep -q '^<FS>$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d --no-deps --force-recreate vmagent`,
     and re-run the curl.
4. **<FS>** `sudo docker ps --filter name=voip-freeswitch --format '{{.Status}}'`
   - The uptime is NOT reset.
5. **<FS>** `sudo docker logs --since 10m voip-freeswitch 2>&1 | grep -iE "lua.*(error|fail)|term_trunks failed|db_client" | tail -20`
   - Expect no new errors.
6. **After each zone's FS-1** (FS-2 takes no calls): one RCF test call that lands in this zone.
   Then check which termination path ran (the `term_trunks_source` channel variable is in the
   on-disk JSON CDRs only, not in `cdrs` [V]):
   **<FS>** `hostname | grep -q '^<FS>$' && sudo docker exec voip-freeswitch sh -c 'cd /var/log/freeswitch/json_cdr && ls -t | head -300 | xargs grep -hoE "term_trunks_source\"[^,}]*" 2>/dev/null | sort | uniq -c'`
   - Expect only `db`, never `fallback` on new calls. The exact JSON spacing is inferred [I]; any
     line containing `fallback` is the signal.

**Services sidecars for #170** (once, after all 6 nodes; the order relative to the code does not
matter [I], and #170 lists them under its services step):

7. **services** `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml restart heplify-server`
   - heplify reads `ip-alias.lua` only at start [V, docker/homer/CLAUDE.md].
   - Check that HEP keeps flowing: a new test call shows in Homer. The `Vz*` names stay inert until
     Verizon traffic exists.
8. **services** `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml restart vmalert && sleep 10 && curl -s http://127.0.0.1:8880/api/v1/rules | grep -o '"name":"vz_ipsec"'`
   - Expect `"name":"vz_ipsec"`. The rules directory is bind-mounted, so a restart is enough.
   - Then `curl -s http://127.0.0.1:8880/api/v1/alerts | grep -c VzIpsec` → `0`. The "ever healthy"
     guard keeps gateways that were never turned up from paging [V, PR body].

**Stop / abort:**
- A pull that is not fast-forward.
- The FS uptime reset.
- Lua errors.
- Any `fallback`.
- Failed test calls.

**Rollback (Phase 4), per node:**
`hostname | grep -q '^<FS>$' && cd /opt/revup && sudo git checkout <that node's PRE_SHA> && sudo docker kill -s HUP voip-vmagent`
- It takes effect on the next call. The old Lua ignores `tier1`, the new cache key
  `term_trunks2_<zone>` and the `traffic_grade` values [V, #172 body].
- **Premium routing only:** set customers back to Enterprise in TED, or run
  `UPDATE carrier_trunks SET tier1 = true` on **services** (premium then behaves like enterprise).
  There is no code rollback.
- heplify/vmalert: run `sudo git checkout <PRE_SHA> -- docker/homer/scripts docker/vmalert` on
  **services**, then the same restarts.

---

## 5. Post-checks (about 30 min)

1. **Test calls per zone.** Repeat each until "Last calls" shows one landing in each of `west`,
   `central` and `east`:
   - **RCF forward:** `+16174544217` → its `forward_to`, two-way audio, clean hang-up.
   - **SIP trunk outbound:** a test PBX call to a PSTN number, and one to an 8YY number (fail-closed
     to the Sinch TF rows).
   - **Toll-free:** inbound `5595335873`, plus an RCF or trunk call to an 8YY destination.
2. **CDR checks** (**services**):
   - `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT start_time, freeswitch_node, product_type, direction, customer_id, traffic_grade, carrier_used, term_premium_fallback, stir_eff_actual, hangup_cause FROM cdrs WHERE start_time > now() - interval '30 minutes' AND leg IS DISTINCT FROM 'B' ORDER BY start_time DESC LIMIT 25"`
     - RCF rows show `traffic_grade = enterprise`.
     - SIP-trunk outbound rows show the same value as before the window (the script default;
       #172 says it exports as `standard`) [I].
     - `term_premium_fallback` is NULL for every Enterprise customer.
     - `stir_eff_actual` is populated on carrier-bound calls.
   - `term_trunks_source`: step 4.6 on each FS-1. Only `db`.
   - `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT traffic_grade, count(*) FROM customers GROUP BY 1"`
     → `enterprise` only (plus any customer you deliberately set to Premium).
   - **Fleet STIR mix:** the 0.3.6 query with `15 minutes` in place of `60 minutes`. It matches the
     baseline shares.
3. **Equinox export sample:**
   - Step 2.5 again: `standard premium standard`.
   - Then the preview:
     **services** `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml exec -T api python -m services.cdr_export dry-run | grep -E '^  ' | cut -d, -f32 | sort | uniq -c`
     - The header line contributes `traffic_grade` (column 32 of 89, which confirms the alignment).
     - Data rows show `standard` (and `premium` only for a Premium customer), and **never
       `enterprise`**.
     - Caveats [I]: the preview shows the oldest unexported 20 rows, which can predate 63. A quoted
       field containing a comma would shift columns; trust the header count.
4. **Carrier health:**
   **services** `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -Atc "SELECT duid, status, trunk_enabled FROM carrier_trunk_health ORDER BY 1"`
   - Every duid that was up before is still `up`.
   - The Verizon rows (if listed) are `down` with `trunk_enabled = f`, and there are no
     `verizon-unmapped-*` rows (no group 13 is probing).
   - The NOC carrier board renders.
5. **TED CRAG Admin pages** (production):
   - **Inventory › Subscribers:** rows and drift cards. Note any drift counts for follow-up; do not
     fix them tonight.
   - **Carriers:** the Tier 1 column (Bandwidth on), and zone cards showing an Enterprise order **and**
     a Premium order.
   - **Pricing › Traffic tiers:** enabled, with Enterprise and Premium per customer. No "Needs the
     CRAG update".
6. **Optional premium smoke** (owner choice):
   - Set one test customer to **Premium** in Traffic tiers, wait 60 s for the trunk cache, and place
     an RCF test call.
     - LD: `carrier_used` is Bandwidth and `term_premium_fallback` is NULL.
     - 8YY: `term_premium_fallback = t` is **expected**, because no toll-free row is Tier 1.
   - Set the customer back to Enterprise afterwards.
7. **Close out:**
   - Record the end time.
   - Leave `/var/tmp/crag-20261103-*` and `/root/crag-20261103-traffic_grade_pre63.csv` in place for
     at least 30 days.
   - Next morning: the 2026-09-23 §7 checks, plus vmalert showing no `VzIpsec*`.

---

## 6. Do NOT

- **Run migrations during Phase 3 SBC flips** (or any SBC drain).
- **`git pull` an SBC without rebuilding in the same line.** Use the Phase 3 rebuild line only.
- **Use `-f docker-compose.sbc.yml` alone** on a Kamailio recreate. This includes #171's original
  deploy command and the 2026-10 record's §2.3 form; both drop the STIR key (Gotcha 15).
- **Set, edit or remove any `VERIZON_*` variable, or enable a Verizon `carrier_trunks` or
  `carrier_gateways` row.** Turn-up is a later, separate change.
- **Run the owner's tofu items** (`infra/monitoring` apply, `infra/vz-ipsec-gcp` import) in this
  window. #170 does not make either a prerequisite for the code.
- **Install #169 on the gateways** in this window.
- **Drain or rebuild two zones at once**, or rebuild an SBC while its zone has an FS drained or down.
- **Run `docker compose up -d` on a media VM without `--no-deps <service>`**, or restart FreeSWITCH.
- **Pull a media VM before all 6 SBCs are done.** The CPS fix depends on the header strip.
- **Re-run 43, or re-apply 53 after 62** (Gotcha 16: re-apply 62 last).
- **Drop `carrier_trunks.tier1` or `cdrs.term_premium_fallback`.**
- **Sweep ghost dialogs** with `kamcmd dlg.end_dlg` or `dlg.terminate_dlg`.
- **Run `docker-compose.x5u.yml` with `--remove-orphans`.**

## 7. Rollback summary

| What | How | Time | Safe to leave applied? |
|---|---|---|---|
| Migrations 62 / 64 / 65 | none | 0 | **yes**: additive and ignored by old code |
| Migration 63 + `traffic_grade` | the Phase 1 restore line (old CHECK, saved values, default `standard`) | 1 min | yes, unless the API is rolled back |
| API (+ cdr-exporter) | 2.R: `git checkout <PRE_SHA>`, then `up -d --build --no-deps api`, then recreate `cdr-exporter` | about 5 min | n/a |
| An SBC | 3.R: `git checkout <PRE_SHA>`, then the Gotcha 15 rebuild and G1–G3. A primary rebuild is one flip | about 5–8 min per SBC | n/a |
| FS Lua / vmagent | the Phase 4 rollback line, per node | seconds | n/a |
| Premium routing only | Enterprise in TED, or `UPDATE carrier_trunks SET tier1 = true` | 1 min | n/a |
| heplify / vmalert | `git checkout <PRE_SHA> -- docker/homer/scripts docker/vmalert`, then restart both | 1 min | n/a |

## Open questions for the owner (before the window)

1. Are the VMs' `PRE_SHA`s `29fd90f`? If older, or if `check_migrations` shows anything at 61 or
   below MISSING, the scope is larger than this runbook.
2. Is `voip-cdr-exporter` running in production? Steps 1.3 and 2.4 apply only if it is.
3. Which SIP-trunk test PBX/trunk and which 8YY destination should the outbound tests use?
4. Is the zone order West → Central → East acceptable?
5. Do you want the optional premium smoke (5.6) tonight?
