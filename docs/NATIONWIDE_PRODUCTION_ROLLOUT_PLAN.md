# RCF Nationwide Production Rollout Plan

**Status:** DRAFT for review — 2026-07-22
**Goal:** Take RCF-V1 from a single live zone (East) to a 3-datacenter nationwide GCP deployment with complete HA/DR (hot/cold + backups), pass full testing, and declare readiness for the first beta customer.
**Branch:** `RCF-V1` (production). The `unified` MVP is on hold (see `project_unified_branch_strategy` memory).

---

## 1. Where we actually are (ground truth, 2026-07-22)

| Area | State | Reality |
|------|-------|---------|
| **East zone (us-east1-b)** | ✅ LIVE | 2 SBCs (`poc-custom-voip` 10.142.0.100, `kam-g2` 10.142.0.101), 1 FreeSWITCH (`fs-media-v2` 192.168.10.2), 1 Services VM (`services` 10.142.0.103 — PG primary + API + UI + Homer). Regional NLB VIP `34.24.133.82`. Carrier traffic flowing. |
| **West zone (us-west1-b)** | 🟡 ~70% BUILT, NOT CUTOVER | VMs exist & running (`west-sbc-1/2`, `west-fs`, `west-db`), static IPs reserved (8.229.41.59 / 136.117.230.166 / 8.229.177.165), regional NLB `35.252.214.40`, Kamailio+FS healthy, `.env` templated, `bypass-vpn` tagged. **Missing:** PG replica, Bandwidth origination whitelist, inbound routing, any live traffic. |
| **Central zone (us-central1-b)** | ⬜ NOT STARTED | Nothing built. |
| **Database** | 🔴 SPOF | Single PG primary in East. **No replica, no WAL archiving, no replication slot.** FreeSWITCH does a per-call PG lookup → if the services VM is lost, all new call routing stops. |
| **Backups** | 🔴 ZERO LIVE | 4 layers fully scaffolded in `infra/backups/` (pg_dump, pgBackRest/WAL-PITR, CDR archive, disk snapshots) + restore runbook — **none applied, never drilled.** Unbounded RPO on the revenue DB today. |
| **Call/SIP monitoring (Homer)** | ✅ LIVE | Homer stack is deployed on the services VM (heplify-server ← HEP from the SBCs → qryn/ClickHouse → Grafana). Per-call SIP tracing + ladder diagrams work — this is *forensics after you go look*. |
| **Ops monitoring / alerting** | 🔴 ZERO LIVE | Distinct from Homer: infra/service **health + paging** (`infra/monitoring/`: uptime checks, VM/disk/mem/CPU alerts, Ops Agent, SLOs) — **not applied.** And nothing *watches* the quality signals — MOS/ASR/PDD are captured in Homer/CDRs but no alert fires on them. Outage detection today = "a customer calls." |
| **HA / DR** | 🟡 PARTIAL | Intra-zone SBC failover works (NLB + 2 SBCs). 1 FS per zone = media SPOF. Multi-zone + DB failover logic exists but **never tested**. |
| **IaC (OpenTofu)** | 🟡 SCAFFOLD | `infra/backups`, `infra/monitoring`, `infra/replica`, `infra/test` modules exist (mostly plan-only/not applied). Multi-region root + `voip-region`/`firewall`/`global-lb` modules are **documented in `OPENTOFU_PLAN.md` but not in the tree**. East is not yet under Tofu state. |

**Inbound model correction (important):** GCP has **no global passthrough UDP NLB**. So the design is *not* a single anycast VIP — each zone gets its **own regional NLB VIP**, and **Bandwidth is configured with all regional VIPs on inbound (origination)** for HA. Outbound is per-zone SBC-IP whitelisting to the nearest PoP.

---

## 2. Target state

- **3 self-contained zones** (East, West, Central). SIP + RTP never cross a zone; only PG replication + HEP capture are cross-zone.
- **Per zone:** 2 Kamailio SBCs + 1 FreeSWITCH + 1 PG replica (primary + API + UI + Homer stay East-only).
- **Inbound:** Bandwidth points at all 3 regional VIPs; carrier picks nearest, GCP NLB health-checks each zone's SBC pair.
- **Outbound:** per-zone env-driven PoP (East/Central→Dallas, West→LA) with SBC-level carrier failover.
- **Data safety:** all 4 backup layers live + drilled; East primary + hot standby; per-zone read replicas.
- **Observability:** uptime/alerting/on-call live; SLOs measured (99.95% inbound-call availability, PDD p95 ≤ 3s, 99.9% API).
- **Ops UI lives in `ted-next`, NOT the revup app:** any monitoring/alerting dashboards + ops console are built in Granite's internal **ted-next** application (via its proxy to revup's API + GCP Cloud Monitoring). The revup app stays purely customer/product-facing. See the `project_revup_ops_to_ted` plan.
- **Capacity:** ~500 CPS/zone, load-tested at 120% (600 CPS) before each go-live.

---

## 3. Gap analysis → the work

Two independent tracks. **Track A (data safety/observability) is the most urgent** — East runs live traffic today with unbounded data-loss risk and no outage detection. It does **not** depend on the zone expansion and should go first. **Track B** is the 3-datacenter expansion you asked to finish.

---

## 4. Phased plan

### Phase 0 — Verify + Safety Net (make the *live* zone survivable) — ~1 week — **DO FIRST**
*Addresses: "all required backup servers", removes the two P0 audit findings.*
- **0.1 Live audit:** `gcloud` inventory of actual VMs / IPs / firewall / NLB vs the docs; reconcile any drift. (Docs are detailed but must be confirmed against reality.)
- **0.2 Backups:** apply `infra/backups/` + run the on-VM setup on `services` → nightly pg_dump, pgBackRest full/diff + continuous WAL (RPO ≤ 5 min), CDR archive, daily disk snapshots to `gs://revup-db-backups`.
- **0.3 First restore drill:** execute `docs/runbooks/DB_RESTORE_RUNBOOK.md` on a throwaway VM; **measure and log RTO/RPO** (the drill log is currently empty).
- **0.4 Ops monitoring/alerting** (complementary to Homer, which already does per-call SIP capture): apply `infra/monitoring/` + install Ops Agent on all VMs → uptime checks (SIP VIP, API, UI), VM/disk/mem/CPU alerts, on-call paging. Add a scheduled alert on call-quality SLIs (ASR/PDD/MOS) that Homer+CDRs already capture but nobody watches.
- **Exit:** bounded RPO proven by a real restore; a pathological event pages a human within minutes.

### Phase 1 — Database HA (East primary + hot standby) — ~3–5 days
*Addresses: "hot/cold ... servers"; removes the single biggest availability SPOF.*
- **1.1** Run `infra/replica/prod_enable_replication.sql` on the East primary (replicator role, `inventory_ro`, physical slot, WAL).
- **1.2** Stand up an **East warm/hot standby** streaming from the primary (same mechanism the sandbox replica was designed for).
- **1.3** Failover test: promote the standby, repoint `DB_HOST`, measure. Document the manual runbook; flag Patroni (auto-failover ~30s) as a later hardening.
- **Exit:** losing the primary is a measured, documented ≤30-min recovery — not "total new-call loss."

### Phase 2 — Finish West (2nd datacenter live) — ~1 week
*Addresses: "3 datacenters" (2 of 3).*
- **2.1** Build the **West PG replica** (East primary → `west-db` 10.138.0.103); point West FS/SBCs at the local replica for DID lookups.
- **2.2** Bandwidth dashboard: **whitelist West SBC IPs** (8.229.41.59, 136.117.230.166) for origination (outbound) and **add West's regional VIP** (35.252.214.40) to inbound.
- **2.3** Load test West at 120% (SIPp ~600 CPS); validate per-zone self-containment (SIP + RTP stay in-zone).
- **2.4** Controlled cutover: real test calls land in West; monitor.
- **Exit:** West carries real traffic with inbound HA across East+West; West reads DIDs locally.

### Phase 3 — Build Central (3rd datacenter) — ~1–2 weeks
*Addresses: "3 datacenters" (3 of 3).*
- Create subnet `voip-media-central` (192.168.30.0/24), reserve static IPs, deploy 2 SBC + FS + db VMs (machine-image clone *or* IaC — see Phase 5 decision), regional NLB, `bypass-vpn` tags, `.env` templating (SBC_ID `central-*`, HEP 120/121/220, PoP Dallas).
- PG replica (East → `central-db` 10.128.0.103); Bandwidth whitelist + inbound VIP; load test; cutover.
- **Exit:** nationwide 3-zone footprint live.

### Phase 4 — Multi-zone failover + DR validation — ~1 week
*Addresses: "required testing"; proves HA/DR before beta.*
- Chaos matrix: kill an SBC (intra-zone reroute), kill an FS (in-zone impact), take a **full zone** offline (Bandwidth reroutes to other regional VIPs), fail over the **DB primary**.
- Cross-zone restore drill; measure everything against the SLOs.
- **Exit:** every failure mode has a proven, timed recovery inside SLO.

### Phase 5 — IaC consolidation (AFTER deployment) — ~3–5 days
*Addresses: repeatable, safe "full production ... through GCP".*
- Write the OpenTofu root + `voip-region`/`firewall`/`global-lb` modules (code is spec'd in `OPENTOFU_PLAN.md`), **import East/West/Central** (`prevent_destroy`) into `gs://revup-tofu-state`.
- **Decided:** runs AFTER the 3 zones are live (keep expansion momentum). Accept the interim hand-built drift; import once deployed.

### Phase 6 — Media HA: 2nd FS per zone — IN SCOPE for beta — ~1–2 weeks
- Remove the 1-FS-per-zone SPOF: **2 FS per zone**. West/Central are built with 2 FS from the start (Phase 2/3); East gets a 2nd FS retrofit here.
- Kamailio dispatcher health-probes both in-zone FS (OPTIONS) and fails over between them; shared object storage for any stateful media (recordings/CDRs — RCF bridging itself is stateless).

### Phase 7 — Beta-readiness gate + report — ~2–3 days
*Addresses: "report being ready for our first beta customer".*
- Full E2E test pass (per-zone call matrix, all Phase-4 failovers, a live backup/restore, alerts actually firing).
- Sign-off checklist: all P0s closed, SLOs measured, runbooks drilled, on-call established, capacity headroom confirmed.
- **Deliverable:** a "Beta Readiness Report" stating go/no-go with the measured numbers.

---

## 5. Recommended sequence & rough timeline

```
Week 1        Phase 0  (safety net: backups + ops monitoring + restore drill)   ← START HERE
Week 1–2      Phase 1  (East DB hot standby + failover test)
Week 2–3      Phase 2  (finish West → live, built with 2 FS)
Week 3–5      Phase 3  (build Central → live, built with 2 FS)
Week 4–5      Phase 6  (media HA: add 2nd FS to East + in-zone FS failover/health)
Week 5–6      Phase 4  (multi-zone + DR chaos testing)
Week 6–7      Phase 7  (beta-readiness gate + report — gate = all 3 DCs fully deployed w/ HA/DR)
Week 7+       Phase 5  (IaC consolidation — AFTER deployment)
```
**~6–7 weeks** to beta-ready (media HA in scope adds ~1 week). Phase 0 alone (~1 week) closes the highest-risk gap regardless of how fast the expansion goes.

## 6. Top risks / callouts
- **Live-traffic exposure now:** until Phase 0 ships, a services-VM disk loss = permanent loss of every DID→forward mapping, customer, rate, and 90 days of CDRs. This is the single most urgent item.
- **Bandwidth lead time:** origination whitelisting / inbound VIP changes are carrier-side and can take 1–5 business days — request early in each zone's phase.
- **`bypass-vpn` tag** is mandatory on every egress VM (was missing on West initially) — bake into templating.
- **Media SPOF** (1 FS/zone) is the last un-redundant tier; acceptable for beta only if explicitly accepted.
- **IaC drift:** East + West were built by hand; longer we wait to import, the more reconciliation later.

## 7. Decisions (locked 2026-07-22)
1. **Safety net first** — start Phase 0 immediately, before pushing West/Central live. ✅
2. **IaC consolidation: AFTER** the 3 zones are deployed (keep expansion momentum; import East/West/Central once live) — Phase 5 runs last.
3. **Media HA (2nd FS per zone): IN SCOPE for beta** — every zone runs 2 FreeSWITCH; West/Central built with 2 FS, East retrofit. No single-FS-per-zone in the beta footprint.
4. **Beta gate = fully deployed across all 3 datacenters** (East + West + Central) with HA/DR complete. Not customer-count-gated; "ready" = nationwide 3-DC deployment proven.
