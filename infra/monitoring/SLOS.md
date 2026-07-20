# Service Level Objectives — RCF Production

We are the carrier: an RCF outage is a customer-visible phone outage for
nationwide utility deployments. These three SLOs are the contract the
`infra/monitoring` alerts defend. Review monthly; tighten only with data.

## SLO 1 — Inbound call availability (the product)

| | |
|---|---|
| **SLI** | Fraction of inbound call attempts that reach normal call handling (answered, forwarded-and-ringing, or legitimately busy/no-answer) — i.e. not failed by *our* platform |
| **Objective** | **99.95% monthly** (error budget ≈ 21.9 min/month of full outage) |
| **Measured by (today)** | Proxy: SIP VIP tcp/5060 uptime check (platform reachability). Ground truth: ASR from `cdr_hourly_stats` — `SELECT time_bucket, answered_calls::float/NULLIF(total_calls,0) FROM cdr_hourly_stats` — reviewed weekly |
| **Alert (now)** | `SIP VIP 5060 unreachable` (CRITICAL, pages) |
| **Gap to close (P1)** | Alert on ASR < 50% over 15 min from CDR data (needs the metrics exporter or a scheduled query); per-SBC failover-rate alert from `cdrs.sbc_id` |

## SLO 2 — Post-dial delay (PDD)

| | |
|---|---|
| **SLI** | Time from INVITE arriving at the SBC to first provisional response (180/183) reaching the caller |
| **Objective** | **p95 ≤ 3 s, p99 ≤ 6 s monthly**; hard per-attempt bound is `BRIDGE_PROGRESS_TIMEOUT` (10 s) before failover — a call that rides all 4 failover attempts can see ~40 s worst-case, which is why failover *rate* is also watched under SLO 1 |
| **Measured by (today)** | Homer: INVITE→18x delta per Call-ID (Troubleshooting page / qryn query); spot-check weekly. heplify's `:9096` Prometheus metrics (now scrapeable via `--with-heplify-prom`) carry method/response timing counters for automation |
| **Alert (now)** | None (measurement first — do not alert on an unmeasured SLI) |
| **Gap to close (P1)** | Persist PDD per CDR (FS variable `progress_mediamsec`/bridge timestamps) and alert p95 > 3 s for 30 min |

## SLO 3 — API availability (provisioning + portal)

| | |
|---|---|
| **SLI** | Fraction of `GET /health` probes returning 200 within 10 s |
| **Objective** | **99.9% monthly** (error budget ≈ 43.8 min/month) — deliberately looser than SLO 1: the call path must survive API downtime by design (routing reads PG directly) |
| **Measured by (today)** | API `/health` uptime check, 60 s period, multi-region |
| **Alert (now)** | `API /health failing` (CRITICAL, pages) |
| **Gap to close** | Split "portal down" (UI check, already alerting) from "API degraded" (latency-based burn alert) once request metrics exist |

## Error-budget policy (simple version)

- Budget burned > 50% mid-month → freeze risky deploys to the affected tier;
  prioritize reliability fixes.
- Any page → 15-line postmortem in `docs/runbooks/` (what, impact minutes,
  budget burned, one action item). No blameless-theater paperwork — just the
  four lines that prevent the repeat.
- Track achieved RPO/RTO from every restore drill in
  `docs/runbooks/DB_RESTORE_RUNBOOK.md` alongside these SLOs.
