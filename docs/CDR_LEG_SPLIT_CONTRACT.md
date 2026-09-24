# CDR A/B leg split — implementation contract (2026-09-23)

Implements all three phases of `docs/CDR_BILLING_REMEDIATION_PLAN.md` in one
release. Owner decisions (2026-09-23): ship everything in one PR, run the
migrations + deploy in tonight's window, and turn the split ON — Equinox is
developing against whatever we send, so no header/contract sign-off gates it.
Where this file and the plan differ, THIS FILE wins.

## Row model

| row | when | `leg` | `call_id` | `leg_attempt` | `direction` | `customer_id` |
|---|---|---|---|---|---|---|
| A-leg | every call (unchanged set of rows) | `'A'` | = own `uuid` | NULL | as today | terminal customer (as today) |
| B-leg | one per **carrier** bridge attempt (answered or not) | `'B'` | A-leg `uuid` | 1..N | `'outbound'` | terminal customer (same as A) |
| legacy | rows written before migration 48 | NULL | NULL | NULL | as stored | as stored |

- **One-row-per-call predicate (all counting / volume / quality / ASR / minutes /
  customer-facing surfaces): `leg IS DISTINCT FROM 'B'`.**
- **Call identity: `COALESCE(call_id, uuid)`.**
- `origin_customer_id`, `terminating_customer_id`, `on_net`, `on_net_hops` are
  call-level facts copied verbatim onto the B row.
- **No B row** for: on-net terminals (trunk-to-PBX delivery, API, local ext),
  hard rejects (603/483), or any B-leg that does not carry `cdr_carrier_leg=true`.
  The split trigger is that explicit flag — never inferred from leg topology.
- Rating rule (for Equinox, documented in the export): **count calls = `leg='A'`
  rows; rate every row on its own `billed_seconds`; never rate a leg by
  reference to its partner.** Unanswered rows have `answered=false`,
  `billed_seconds=0`.

## FreeSWITCH → ingest channel-variable contract (B-leg only)

Set ONLY on carrier dial strings (RCF off-net bridge loop incl. failover
attempts; trunk outbound to carrier), as **per-leg dial-string variables**
(`[var=val]` / `{var=val}` scoped to the B channel) — never `export` without
`nolocal:` and never `set` on the A-leg:

| var | value |
|---|---|
| `cdr_leg` | `B` |
| `cdr_carrier_leg` | `true` |
| `cdr_call_id` | A-leg `uuid` |
| `cdr_leg_attempt` | 1-based attempt number within this call |
| `cdr_direction` | `outbound` |
| `cdr_customer_id`, `cdr_product_type`, `cdr_trunk_id` | as the A-leg's final values |
| `cdr_on_net`, `cdr_on_net_hops`, `cdr_origin_customer_id`, `cdr_terminating_customer_id` | as the A-leg's final values |
| `cdr_inbound_carrier`, `cdr_inbound_carrier_pop`, `cdr_sbc_id` | as the A-leg's final values |

`mod_json_cdr` posts B-leg sessions when `log-b-leg=true`. Ingest decides per
POST:

1. A-leg (no `cdr_leg`, or `cdr_leg=A`): today's path + write `leg='A'`,
   `call_id=uuid`.
2. `cdr_leg=B` AND `cdr_carrier_leg=true` AND `CDR_B_LEG_ROWS` enabled: INSERT a
   B row from the `cdr_*` vars (NEVER from the ingest defaults — a B-leg missing
   `cdr_customer_id`/`cdr_call_id` is logged + dropped, never inserted as
   `customer_id=0` / `direction='inbound'`).
3. Any other B-leg POST: no row (today's early-return), except STIR outcome.
4. STIR outcome UPDATE onto the A-leg: only from an **answered carrier** B-leg.
   Call-attestation UPSERT: A-leg only.

`CDR_B_LEG_ROWS` (API env): ON unless exactly `false` (owner: split on).
`log-b-leg` (FS): the per-zone cutover switch.

## API read-side param (staff only)

`/v1/cdrs` and `/v1/cdrs/summary`: `leg` = `calls` (default — one row per call,
`leg IS DISTINCT FROM 'B'`) | `all` | `b`. Tenants: always `calls` (param
ignored). Reports: always `calls`. B rows carry `leg`, `call_id`, `leg_attempt`
in staff responses; tenant allowlist unchanged (no leg fields needed).

## Customer minutes

Tenant/report minutes = **talk time** computed from the timestamps
(`end_time - answer_time`; 0 if unanswered) — never `duration_ms` (includes
ring) and never `billable_ms` (`rate_cdr()` can overwrite it with increments),
rounded to whole minutes exactly as before (per call ≥1 if answered; totals
rounded once).

## Quality (migration 50, 2026-09 — `docs/CALL_QUALITY_ACCURACY_PLAN.md` §C)

B rows feed the call-level quality columns via `cdr_refresh_call_quality(call_id,
anchor)`. Each leg row carries its OWN per-leg quality (`quality_status`,
`quality_grade`, `mos`, …: A row = caller→platform audio, B row = callee→platform
audio). The A row additionally carries `call_quality_status` / `call_quality_grade` /
`call_mos` / `call_quality_leg` = the WORSE direction of the A row and the ANSWERED
carrier B row (`call_id` = A uuid, `answer_time` set, highest `leg_attempt`); failed
attempts never count. Both the A ingest and the B ingest run the refresh as their own
statement after their INSERT committed, so the result is correct whichever CDR
arrives first (and idempotent on re-ingest). No B row (on-net, trunk/API terminals,
`CDR_B_LEG_ROWS` off) → call quality = A quality. `call_*` are never set on B rows.
B rows may use the pre-50 (60-param) INSERT tier (they keep `leg`); never below it.

