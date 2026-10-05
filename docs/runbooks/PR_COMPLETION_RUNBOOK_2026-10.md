# PR completion runbook — #136, #137, #138 (+ STIR From pass-through, optional)

**Written:** 2026-10-05, against `origin/RCF-V1` @ `47ae879` (everything up to it is already live on all VMs).
**Supersedes:** the untracked `docs/runbooks/STIR_STACK_DEPLOY_RUNBOOK.md` (2026-09-10). Its Phases 1–3 (#121/#120/#122) shipped with the 2026-09-23..25 maintenance. Only its Phase 5 (From pass-through) was never done; it is §5 here.

| PR | What | Touches prod | Deploy |
|---|---|---|---|
| #137 | CRAG / FS-HA doc corrections | no | none |
| #136 | root CLAUDE.md refresh + `check_migrations.sql` covers 50/51 | no | none (the script is used in §3) |
| #138 | Admin Call Forwarding Console + `GET /v1/cdrs/activity`, plus the 2026-10-05 fixes (only the `user` role can request numbers, Python is the only source of bucket edges, UTC retry when the tz is rejected) | services VM only | rebuild `api` + `ui`, no migrations, no SBC/FS change |

**Order:** §1 workstation (any time) → §2 EXPLAIN gate (any time, read-only) → §3 merge → §4 services VM (window) → §5 optional STIR canary (window) → §6 cleanup.
All VM commands: `sudo`, single line, run from `/opt/revup`, hostname-guarded.

---

## 1. Workstation — commit, push, local check (no prod impact)

1. Commit and push the #136 header fix:
   `cd /Users/KeGrabhorn/custom-voip/.claude/worktrees/docs && git commit -am "docs(db): check_migrations header says 22..51 once" && git push`
   → PR #136 shows 2 commits.
2. Commit and push the #138 fixes (API gate + bucket edges + tests, UI readonly/tz fallback, the EXPLAIN script, this runbook):
   `cd /Users/KeGrabhorn/custom-voip/.claude/worktrees/ui-admin && git add -A && git commit -m "fix(rcf-ui): user-only number requests, Python-owned bucket edges, UTC tz fallback; EXPLAIN script + completion runbook" && git push`
   → PR #138 shows 2 commits. Verified before hand-off: API suite 917 passed, `tsc -b --noEmit` clean, eslint clean on changed files, `npm run build` OK.
3. Local browser check of #138 (Docker Desktop running):
   `cd /Users/KeGrabhorn/custom-voip/.claude/worktrees/ui-admin && JWT_SECRET_KEY=localdev docker compose up -d --build postgres redis api ui`
   Add a customer `user` and a `readonly` login (password `admin123`, same hash as the seeded admin):
   `docker exec voip-postgres psql -U voip -d voip -c "insert into users (email,password_hash,customer_id,role,name,status) select e, (select password_hash from users where email='admin@customvoip.com'), (select id from customers order by id limit 1), r, n, 'active' from (values ('user@test.local','user','Test User'),('ro@test.local','readonly','Test RO')) v(e,r,n) on conflict do nothing"`
   Open `https://localhost:8443` (self-signed cert) and check:
   - `admin@customvoip.com` / `admin123` → RCF page title **Administrative Call Forwarding Console**. Nothing loads until you pick from the dropdown. **All Customers** → Call Activity renders all four ranges (24h/7d/30d/90d); empty data is fine, zero-filled bars are expected. DID Management with All Customers asks you to pick one customer. No Request button.
   - `user@test.local` → no customer dropdown. Call Activity loads. DID Management shows **Request** on available numbers.
   - `ro@test.local` → no Request button; note reads "your account has read-only access".
   - Customer view (admin toggle) → still no Request button.
   Tear down: `docker compose down -v`

## 2. EXPLAIN gate for 90d "All Customers" (read-only, any time, run on a REPLICA)

The query really executes, so run it on `west-db`, not the East primary. The single-line form needs no pull:

`hostname | grep -q '^west-db$' && sudo -u postgres psql -d voip -c "SET statement_timeout = '30s'; EXPLAIN (ANALYZE, BUFFERS, TIMING) WITH f AS (SELECT (width_bucket(start_time, ARRAY(SELECT g AT TIME ZONE 'America/New_York' FROM generate_series(date_trunc('week', ((now() AT TIME ZONE 'America/New_York')::date - 89)::timestamp), date_trunc('week', (now() AT TIME ZONE 'America/New_York')::date::timestamp), interval '1 week') AS g)) - 1) AS b, (answer_time IS NOT NULL AND COALESCE(duration_ms, 0) > 0) AS ans, call_quality_grade AS grade, call_quality_status AS qstatus, call_mos::float8 AS mos, duration_ms::float8 AS dur_ms FROM cdrs WHERE start_time >= ((now() AT TIME ZONE 'America/New_York')::date - 89)::timestamp AT TIME ZONE 'America/New_York' AND start_time < ((now() AT TIME ZONE 'America/New_York')::date + 1)::timestamp AT TIME ZONE 'America/New_York' AND leg IS DISTINCT FROM 'B' AND product_type = 'rcf'::varchar) SELECT (GROUPING(b) = 1) AS is_total, b, count(*) AS calls, count(*) FILTER (WHERE ans) AS answered, count(*) FILTER (WHERE grade IS NOT NULL) AS graded, count(*) FILTER (WHERE grade IN ('great', 'good')) AS good_or_better, count(*) FILTER (WHERE grade = 'poor') AS poor, count(*) FILTER (WHERE qstatus = 'no_rtp') AS one_way, percentile_cont(0.5) WITHIN GROUP (ORDER BY mos) FILTER (WHERE grade IS NOT NULL AND qstatus = 'rated' AND mos IS NOT NULL) AS median_mos, avg(dur_ms) FILTER (WHERE ans) / 1000.0 AS avg_duration_sec FROM f GROUP BY GROUPING SETS ((b), ());" | tail -4`

(After §4, the faithful constant-bound version is `sudo -u postgres psql -d voip -f /opt/revup/scripts/db/explain_cdr_activity_90d.sql`.)

Read the `Execution Time:` line. The endpoint's limit is 8 s (`CDR_ACTIVITY_STATEMENT_TIMEOUT_MS`):
- **< 3 s** → pass, go on.
- **3–8 s** → pass, but the 90d All Customers view will be slow. Note it for a follow-up (cap All Customers at 30d, or a continuous aggregate).
- **> 8 s or cancelled** → **do not merge #138.** The 90d All Customers view would always 503. Hand back for a cap before merging.

## 3. Merge (GitHub UI, "Create a merge commit")

Order: **#137 → #136 → #138.** Each should show `MERGEABLE` (they touch different files).
`git fetch origin && git log --oneline -6 origin/RCF-V1` → three new merge commits on top of `47ae879`. Note the `#138` merge SHA (call it `NEW`); the rollback point is `47ae879`.

## 4. Services VM (`services`, 10.142.0.103) — maintenance window

Impact: the API and UI restart (~20–40 s). The customer portal/API is unavailable during that time, and CDR posts from FS during it fail and are retried by mod_json_cdr. No SIP/RTP impact.

1. Pull:
   `hostname | grep -q '^services$' && cd /opt/revup && sudo git pull`
   → fast-forward to `NEW`; files under `docker/api`, `docker/ui`, `tests`, `scripts/db`, `docs`, `CLAUDE.md`, `PRODUCTION_ARCHITECTURE.md`.
2. Migration pre-flight (from #136; read-only):
   `sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql`
   → every row `applied` (22..51). #138 needs no new migration; any `*** MISSING ***` is pre-existing drift. Stop and report it, don't fix it in this window.
3. Build:
   `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml build api ui`
   → both images build; the UI build runs `tsc` + eslint gates.
4. Recreate API + UI only:
   `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --no-deps api ui`
5. Verify:
   - `sudo docker logs --since 3m voip-api 2>&1 | grep -E "Application startup complete|CRITICAL|Traceback" | tail -5` → `Application startup complete.`, no CRITICAL/Traceback.
   - `curl -s http://127.0.0.1:8088/health/detailed | python3 -m json.tool | grep -A1 '"schema"'` → `healthy`.
   - `curl -s http://127.0.0.1:8088/openapi.json | grep -o '/v1/cdrs/activity' | head -1` → `/v1/cdrs/activity`.
   - `sudo docker ps --filter name=voip-ui --filter name=voip-api --format '{{.Names}} {{.Status}}'` → both `Up`.
6. CDR exporter (shares the `voip-api` image; flag-off in prod). Only if this prints a line:
   `sudo docker ps --filter name=voip-cdr-exporter --format '{{.Names}}'`
   then: `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml --profile cdr-export up -d --no-deps cdr-exporter`
7. Live check: call **+16174544217** (check its current target first: `sudo -u postgres psql -d voip -c "select did, forward_to, enabled from rcf_numbers where did like '%6174544217'"`). Then in the portal as admin:
   - RCF → pick the customer → Call Activity, 24h → the call appears in Recent Calls (≤ 60 s cache) with an absolute date-time, and in the current hour's bar.
   - All Customers → 90d → loads (if it 503s, see §2).
   - DID Management → no Request button for admin.
8. No other VM needs a pull. #136/#137 are docs only, and nothing under `docker/freeswitch`, `docker/kamailio` or `docker/postgres/init` changed. Pulling them later is harmless.

**Rollback (#138):** `hostname | grep -q '^services$' && cd /opt/revup && sudo git checkout 47ae879 && sudo docker compose -f docker-compose.services.yml build api ui && sudo docker compose -f docker-compose.services.yml up -d --no-deps api ui`
No schema to undo. Re-attach the branch once fixed: `cd /opt/revup && sudo git checkout RCF-V1 && sudo git pull`.

## 5. OPTIONAL — STIR: RCF From pass-through canary (window; drops the zone's active calls)

Ships **off**. Turning it on sends the original caller's TN and display name in `From` on `pass_caller_id=true` forwards. Carrier (Bandwidth) acceptance of a non-account From TN is **unverified**. Skip this section unless you want that behaviour.

**State check (read-only, any time):**
- STIR outcome is landing (#120–#122 live): on `services`: `sudo -u postgres psql -d voip -c "select count(*) filter (where stir_outcome is not null) as with_outcome, count(*) as total from cdrs where start_time > now() - interval '1 day'"` → `with_outcome` > 0.
- Gate still off, on each FS (`west-fs`, `west-fs-2`, `central-fs`, `central-fs-2`, `fs-media-v2`, `east-fs-2`): `sudo docker exec voip-freeswitch sh -c 'echo RCF_FROM_PASSTHROUGH=${RCF_FROM_PASSTHROUGH:-unset}'` → `off`.

**Canary, one zone (start with the quietest; example West FS-1):**
1. `hostname | grep -q '^west-fs$' && echo 'RCF_FROM_PASSTHROUGH=on' | sudo tee -a /opt/revup/.env`
2. Recreate FS (host-network orphan gotcha first):
   `hostname | grep -q '^west-fs$' && sudo killall -9 freeswitch; hostname | grep -q '^west-fs$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d --force-recreate freeswitch`
3. `sudo docker exec voip-freeswitch sh -c 'echo RCF_FROM_PASSTHROUGH=${RCF_FROM_PASSTHROUGH:-unset}'` → `on`.
4. Canary call per Bandwidth PoP this zone egresses (West = LA; Central/East = Dallas). Dial the pass-through test DID from a phone **not** on our Bandwidth account. **Pass:** the call completes and the callee sees the original caller's number. In Homer, the carrier-facing INVITE has `From: "<caller>" <sip:+1caller@VIP>`, `Diversion` = the RCF DID, and PAI unchanged. **Fail:** 403/400/603 from Bandwidth.
5. On fail, roll back at once: `hostname | grep -q '^west-fs$' && sudo sed -i '/^RCF_FROM_PASSTHROUGH=/d' /opt/revup/.env`, then repeat step 2.
6. On pass, do the same on that zone's FS-2, then the next zone (Central → East: `central-fs`/`central-fs-2`, `fs-media-v2`/`east-fs-2`).

## 6. Cleanup (workstation, after §3)

- The untracked `docs/runbooks/STIR_STACK_DEPLOY_RUNBOOK.md` in the main checkout is superseded by this file. Delete it when you're satisfied: `rm /Users/KeGrabhorn/custom-voip/docs/runbooks/STIR_STACK_DEPLOY_RUNBOOK.md`
- The main checkout sits on the merged `feat/noc-concurrent-calls`; move it: `cd /Users/KeGrabhorn/custom-voip && git checkout RCF-V1 && git pull`
- Stale worktrees for merged branches (`docs`, `ui-admin` after merge, `quality`, `reporting`, `retire-api`, `ladder`, `pin-fs`, `nomedia`, `sessiontimer`, `release`, `agent-a82dc08433694df53`): `git worktree list`, then `git worktree remove .claude/worktrees/<name>` for each.

## 7. Not in this window (open follow-ups)

- **The global readonly write guard** lives only on the parked `chore/remediation-2026-09-02` branch (never merged). #138 closes the number-request hole only. Rebasing that branch also means renaming `46_metrics_roles.sql` → `52_…`.
- `POST /numbers/{did}/request` doesn't check the UPDATE row count: two customers racing for one DID both get 200 and only one row is updated.
- The September list: K1 (stop sending X-CID to carriers); the Kamailio "cannot apply msg changes after adding record-route header" error on FS refresh re-INVITEs; services VM memory spikes (cap/pin qryn + heplify); CDR retention 90 d → 13 mo; `forward_to` on CDRs; B-leg `freeswitch_node` = `<zone>-fs`; the legacy fs-media sandbox VM cost.
