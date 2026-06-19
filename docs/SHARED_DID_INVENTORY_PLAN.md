# Shared DID Inventory — Single Source of Truth + Read-Replica Consumers

Status: **Phases 2–3 IMPLEMENTED + verified** (2026-06-19); Phases 1, 4, 5 pending.
Design for making every environment (and, later, every zone) agree on DID
ownership without separate databases drifting.

> Phases 2–3 (API dual-engine `INVENTORY_READ_URL`, `did_inventory.allocated_env`
> migration, and the `rcf` reconciliation guard) are built and end-to-end verified
> on a local stack: dual-pool falls back to primary when unset (no-op), the guard
> returns 409 cross-env / allows on match / allows untracked DIDs, and the migration
> applies idempotently. They are **dormant until** `INVENTORY_READ_URL` points at a
> replica (Phase 1) — current behavior is unchanged.

## Goal

One authoritative DID **inventory/ownership** record; many consumers that **read**
it. The sandbox (and future West/Central zones) read the truth without ever being
able to corrupt it. Routing and call records stay environment-local.

## Principles (the non-negotiables)

1. **Single source of truth for inventory.** `did_inventory` ownership lives in the
   prod East **primary** only. UNIQUE(did) there is the real guarantee against a DID
   being "owned in two places" — not a cross-database check.
2. **Trust flows one direction: sandbox → prod, never prod → sandbox.** Production
   must never depend (even read-only) on a test box.
3. **Reads are physically read-only.** The sandbox reads a PostgreSQL **streaming
   replica** of prod. A standby cannot accept writes, so "the sandbox can never write
   to prod" is enforced by infrastructure, not discipline.
4. **Inventory is shared; routing + CDRs are local.** `rcf_numbers` (DID→forward_to)
   and `cdrs` are written per-environment. Each environment routes only the DIDs the
   single inventory says are allocated to it.
5. **Allocation is an authoritative act.** Marking a DID for `prod` vs `sandbox` is
   done in the source of truth (prod inventory), because only the owner can allocate.

## Why NOT bidirectional cross-DB checks

- prod→sandbox read makes prod's correctness depend on a test box (anti-pattern).
- Two systems each checking "is it in the other?" is a TOCTOU race — both can pass
  simultaneously. Uniqueness must be enforced in ONE place (the inventory's UNIQUE +
  allocation field), not by mutual peeking.

## Inventory vs routing — the distinction that makes this simple

| Concern | Table | Scope | Writer |
|---|---|---|---|
| Ownership / "who owns what, where" | `did_inventory` | **Shared** (single truth in prod) | prod admin only |
| Call routing (DID→forward_to) | `rcf_numbers` | **Environment-local** | each env locally |
| Call records | `cdrs` | **Environment-local** | each env locally |

"No DID configured in two places" is about **ownership**, and ownership has exactly
one home. The same DID may have *routing rows* in different envs, but the inventory
allocation field says which env is allowed to serve it — checked in one place.

## Target topology

```
        ┌───────────────────────────────┐
        │ PROD East services VM         │
        │ PostgreSQL PRIMARY            │  source of truth: did_inventory (+ all prod data)
        └───────────────┬───────────────┘
              streaming replication (WAL)
                        │
        ┌───────────────▼───────────────┐
        │ East READ REPLICA (standby)   │  physically read-only
        │ PostgreSQL HOT STANDBY        │
        └───────────────┬───────────────┘
                        │ SELECT-only: inventory/ownership over the VPC
        ┌───────────────▼───────────────┐
        │ SANDBOX (test box)            │
        │  • reads inventory  ← replica │
        │  • local PG: rcf_numbers,     │  routing + CDR writes stay local & sandboxed
        │    cdrs (writable)            │
        └───────────────────────────────┘
```

Later: each new zone (West/Central) gets its **own** replica for local FS/Kam reads.
This replica is therefore step 1 of the multi-zone build, not throwaway work.

## Schema change (prod inventory)

Add an allocation field to `did_inventory` (lives in prod, read everywhere):

```sql
ALTER TABLE did_inventory
  ADD COLUMN IF NOT EXISTS allocated_env VARCHAR(20) NOT NULL DEFAULT 'prod';
-- values: 'prod' (serving in prod), 'sandbox' (reserved for the test env),
--         'reserved' (held, not routable anywhere)
```

To test a DID in the sandbox, a **prod** admin sets `allocated_env='sandbox'` on it.
The sandbox reads that and is then allowed to create local routing for it.

## Reconciliation guard (one rule, applied in both envs against the same truth)

When creating/editing `rcf_numbers` routing for a DID:
- **prod** API refuses unless `did_inventory.allocated_env = 'prod'`.
- **sandbox** API refuses unless the **replica's** `did_inventory.allocated_env = 'sandbox'`.

Both read the same inventory, so they can never both "own" the routing.

## API connection model

The API gains a second, **read-only** engine for inventory:

- `DATABASE_URL` (existing) → local/primary writes + routing + CDRs.
- `INVENTORY_READ_URL` (new, optional) → the read replica; used ONLY by the
  number-inventory read paths. If unset, falls back to `DATABASE_URL` (today's
  behavior — so this is a no-op until wired).

Only `did_inventory` **read** endpoints use the inventory engine. Every write and all
routing/CDR access stays on the primary/local engine. asyncpg keeps
`statement_cache_size=0` (PgBouncer) on both.

## Phased implementation

| Phase | What | Touches prod? | Who | Status |
|---|---|---|---|---|
| 1 | Create East **read replica** (wal_level=replica, repl slot+user, standby, pg_hba) | Yes (config reload) | infra runbook (you run on VMs) | TODO |
| 2 | API dual-engine: add `INVENTORY_READ_URL`, route `did_inventory` reads to it (fallback = primary) | No (no-op until set) | code | **DONE + verified** |
| 3 | `did_inventory.allocated_env` migration + reconciliation guard in prod & sandbox APIs | Yes (additive, idempotent) | code + migration | **DONE + verified** |
| 4 | Point sandbox `INVENTORY_READ_URL` at the replica; stop standalone inventory seeding in sandbox | No (sandbox only) | config | TODO (after Phase 1) |
| 5 | (Future) per-zone replicas for West/Central FS/Kam reads | Yes (per zone) | infra | TODO |

**Apply-to-existing-DBs note:** the `allocated_env` migration (`24_did_allocation.sql`)
only runs on a fresh `initdb`. For the already-provisioned prod + sandbox DBs, hand-apply
it once: `sudo docker exec -i voip-postgres psql -U voip -d voip < docker/postgres/init/24_did_allocation.sql`
(idempotent). On prod, also set the test DID(s) to `allocated_env='sandbox'` so the
sandbox is allowed to route them once Phase 1/4 wire the replica.

Phases 2–3 are safe to build first (gated behind env vars, no prod impact) so the
code is ready and locally tested before the replica exists.

## Risks / open decisions

- **Primary config for replication** (`wal_level`, `max_wal_senders`, replication
  slot) needs a reload/restart on the prod primary. Low risk now (prod not carrying
  live traffic), but do it deliberately.
- **Replication lag** (~ms–sub-second): inventory changes reach the sandbox slightly
  late. Fine for ownership data.
- **CDR/write availability during a primary outage** (the one genuinely hard part of
  the multi-zone future): far zones can read from their replica but can't write CDRs
  to the dead primary. Needs local CDR buffering + flush-on-reconnect. Out of scope
  for the sandbox phase; flagged for the zone build.
- **Replica access**: read-only role + VPC firewall (`voip-internal` already permits
  VM-to-VM); credential must be SELECT-only as defense in depth even though the
  standby is already read-only.
```
