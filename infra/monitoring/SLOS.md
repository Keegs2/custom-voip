# Service Level Objectives — RCF Production

We are the carrier: an RCF outage is a customer-visible phone outage for
nationwide utility deployments. These SLOs (plus the voice-quality SLIs
below) are the contract the `infra/monitoring` alerts defend. Review monthly;
tighten only with data.

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

## Voice quality SLI (call audio, 2026-09)

Source: the per-call grade written by the CDR ingest (`docs/CALL_QUALITY_ACCURACY_PLAN.md` B.2 / C / D, migration `50_cdr_quality_accuracy.sql`). MOS is **our ITU-T G.107 E-model computed from true RTP sequence loss** (RFC 3550 expected − received, FreeSWITCH quality patch v1; FS's `lossrate` on legacy images and history). It is not FreeSWITCH's own MOS estimator, which scored silent calls 4.50. The G.107 ceiling for G.711 at default delay is **4.41**, so a perfectly clean call reads 4.41, not 4.50. Call quality is the **worse direction** of caller→platform (A row) and the answered carrier callee→platform (B row), stored on the A row (`call_quality_*`, `call_mos`).

A call is graded only when there is evidence: answered, ≥ 5 s billable, and either ≥ 250 inbound packets (`rated`) or < 10% of the expected inbound packets while ≥ 50% of the expected packets went out (`no_rtp` = one-way audio, graded **poor**). Everything else (unanswered, short, low sample, no media data, and `no_media` = < 10% in AND < 50% out — no audio either way: a failed/test call or both parties silent, migration 51) is ungraded and is left out of both SLIs' numerators (`no_media` answered calls stay in SLI 2's answered-call denominator).

| Grade | R band (G.109) | Stored 2-dp MOS | Loss at BurstR=1, G.711+PLC |
|---|---|---|---|
| `great` | R ≥ 90 "very satisfied" | ≥ 4.34 | ≤ 0.87% |
| `good` | 80 ≤ R < 90 "satisfied" | ≥ 4.02 | ≤ 4.05% |
| `fair` | 70 ≤ R < 80 "some users dissatisfied" | ≥ 3.60 | ≤ 8.11% |
| `poor` | R < 70, or `call_quality_status='no_rtp'` | < 3.60 | > 8.11% |
| NULL (UI "none") | not graded | — | — |

### SLI 1 — Good-or-better calls

| | |
|---|---|
| **SLI** | % of graded calls whose call grade is `great` or `good` |
| **Objective** | **≥ 97% over 30 days** |
| **Measured by** | Grafana Call Quality #43 (15 min, per zone) and #30 (range snapshot); Home #30 (15 min, all zones). Monthly review runs the SQL below on the primary |
| **Alert (now)** | None. The 15-min stat colours red below 90% and amber below 97% |
| **Gap to close** | A burn-rate alert (for example < 90% over 1 h) through a scheduled PG check. vmalert cannot read PG, so it would use the `media_guard.sh` / `asr_guard.sh` pattern |

```sql
SELECT 100.0 * count(*) FILTER (WHERE call_quality_grade IN ('great','good'))
       / NULLIF(count(*) FILTER (WHERE call_quality_grade IS NOT NULL), 0) AS good_or_better_pct
  FROM cdrs
 WHERE leg IS DISTINCT FROM 'B' AND start_time > now() - interval '30 days';
```

### SLI 2 — One-way audio rate

| | |
|---|---|
| **SLI** | One-way-audio calls (`call_quality_status='no_rtp'`: we sent audio, received none) per 1,000 answered calls of ≥ 5 s. Calls with no audio in either direction (`no_media`) are not one-way and never count or page |
| **Objective** | **≤ 1 per 1,000 over 30 days** |
| **Measured by** | Grafana Home #33 (last hour) and Call Quality #22 (per hour, by direction, plus "partial inbound media") |
| **Alert (now)** | `scripts/backup/media_guard.sh` (every 10 min, `revup-alert` → Cloud Logging page). It pages when ≥ `MEDIA_GUARD_MIN_CALLS` (3) one-way calls make up ≥ `MEDIA_GUARD_MIN_SHARE_PCT` (2%) of graded calls in `MEDIA_GUARD_WINDOW_MIN` (30) minutes. That catches a media-path regression (Cloud NAT / bypass-vpn, SDP `c=`, RTP source IP), not the single stray one-way call a week |
| **Gap to close** | None beyond the monthly review of the SQL below |

```sql
SELECT 1000.0 * count(*) FILTER (WHERE call_quality_status = 'no_rtp')
       / NULLIF(count(*) FILTER (WHERE answer_time IS NOT NULL AND billable_ms >= 5000), 0) AS one_way_per_1000
  FROM cdrs
 WHERE leg IS DISTINCT FROM 'B' AND start_time > now() - interval '30 days';
```

Both queries count A rows only (`leg IS DISTINCT FROM 'B'`, one row per call). No MOS average is part of either SLI: an average hides the poor tail that customers complain about. `tests/test_grafana_quality_sql.py` executes both SQL blocks against migration 50.

## Error-budget policy (simple version)

- Budget burned > 50% mid-month → freeze risky deploys to the affected tier;
  prioritize reliability fixes.
- Any page → 15-line postmortem in `docs/runbooks/` (what, impact minutes,
  budget burned, one action item). No blameless-theater paperwork — just the
  four lines that prevent the repeat.
- Track achieved RPO/RTO from every restore drill in
  `docs/runbooks/DB_RESTORE_RUNBOOK.md` alongside these SLOs.
