# On‑Net (Internal) Routing — Design & Implementation Spec

**Status:** APPROVED for build on **`RCF-V1`** (2026‑07‑26). Cross‑customer settlement policy deferred.
**Branch:** `RCF-V1` (production). Do **NOT** build on `unified`.
**Author:** telephony‑systems‑expert review + operator decisions.

## Goal
When a forwarded/placed call's destination is a number the platform **owns** (any product), **short‑circuit the carrier** and deliver the call into that destination DID's own product handler — instead of hairpinning out through Bandwidth and back in.

**Today's behavior (the problem):** a platform DID whose `forward_to` is another platform DID **hairpins** — it egresses to Bandwidth and re‑ingresses as a fresh inbound call, burning an outbound + inbound trunk leg, double carrier cost, ~2× PDD, and two unlinked CDRs. The only "local" check is `inbound_router.lua:425 is_local_extension()` = `^10%d%d$` (legacy 4‑digit ext; dead on RCF‑V1). No "is this destination one of our DIDs?" lookup exists on the call path.

## Confirmed decisions
1. **Billing:** one CDR recording **both** origin + terminal customer; **rate on terminal**. Cross‑customer settlement policy is **deferred** — the CDR records both parties so any downstream model works later.
2. **Caller‑ID:** honor each DID's existing `pass_caller_id`; compose across a chain — **"last `false` hop wins"** (the masking DID closest to the terminal is what shows).
3. **Product‑agnostic + optimized:** one indexed oracle over all product DID tables; extensible to SIP trunking, API/programmable voice, and future products (add‑a‑handler, never rewrite detection).
4. **Disabled terminal DID or detected loop → hard reject** (clean SIP failure; **no** carrier fallback).
5. **MAX_HOPS = 5.**
6. **Route off the PRODUCT tables** (`rcf_numbers` / `api_dids` / `trunk_dids`), **NOT `did_inventory`** — its `product_ref_id`/`customer_id` are reconcile‑maintained and can lag → mis‑route/mis‑bill. `did_inventory` stays inventory‑only.

## 1. The oracle — `number_routing` view (hot‑path lookup)
One `UNION ALL` over the three product DID tables (each already has a **hash index on `did`**: `rcf_numbers.idx_rcf_did_lookup`, `api_dids.idx_api_did_lookup`, `trunk_dids.idx_trunk_did_lookup`). The `WHERE did = $1` equality pushes into each arm's hash index → **3 point lookups + small joins to `customers` = sub‑millisecond**. A DID lives in exactly one product table (each `UNIQUE(did)`), so the view yields **0 or 1 row**.

Canonical columns: `did, product_type, customer_id, product_ref_id, product_enabled, customer_status, forward_to, pass_caller_id, ring_timeout, max_channels, product_name, voice_url, trunk_id`.

**Do NOT filter `enabled`/`active` inside the view** — the resolver must distinguish *"not ours"* (0 rows → keep carrier path) from *"ours but disabled/suspended"* (row present → **hard reject**). The Lua handler decides.

Multi‑zone: the view is defined on the **primary** and inherited by every physical replica automatically — no per‑zone DDL, but the migration must run on the primary and be present before any replica is (re)cloned. It reads each zone's local replica (same lag window the inbound path already lives with). Postgres‑only via existing `db_client.lua` luasql (no Redis); `db_client` builds literal SQL (no prepared statements) so it's already PgBouncer‑compatible.

## 2. Dispatch model — "deliver as if it arrived inbound for that DID"
Refactor the existing `inbound_router.lua` product branches (`rcf` ~L441 / `api` ~L817 / `trunk` ~L862) into **behavior‑preserving** named terminators + a dispatch map:
```
TERMINATORS = { rcf=terminate_rcf, api=terminate_api, trunk=terminate_trunk }   -- future: add here
```
`ctx` threads cross‑hop state: `{ original_caller_number/name, presented_cid, hops, visited(E.164 set), origin_customer_id, origin_did, sip_call_id }`.

**First‑hop inbound is unchanged** (existing cascade + unknown‑DID 404). Seed `ctx` (`visited={inbound DID}`, `hops=0`, `origin_customer_id`, `presented_cid=original_caller`).

**On‑net decision lives inside `terminate_rcf` at the branch point (~L465)** — today a 2‑way (local‑ext vs PSTN) becomes 3‑way:
1. `is_local_extension(forward_to)` → existing `user/ext` bridge (unchanged).
2. `dest = resolve_destination(E164(forward_to))`:
   - `dest` present **and** `product_enabled` **and** `customer_status='active'` → **ON‑NET**: `TERMINATORS[dest.product_type](dest, ctx)`.
   - `dest` present but disabled/suspended → **HARD REJECT**.
   - `dest` nil (0 rows) → genuinely off‑net → existing **4‑attempt carrier failover loop** (unchanged).

**RCF chain resolution** is one case of this: when `dest.product_type=='rcf'`, follow `forward_to` again — repeated **in‑memory DB lookups, no SIP emitted** — until a terminal (local ext / off‑net PSTN / trunk DID / API DID). **Exactly one B‑leg** is ever emitted, to the terminal. Loop check + `hops>MAX_HOPS` inside the loop.

## 3. Per‑product internal termination
| Terminal destination | Behavior | Carrier legs |
|---|---|---|
| **RCF DID** (chain ends off‑net PSTN) | chain resolves in‑memory; single bridge via existing carrier failover loop | **1** (the real call — correct) |
| **RCF → local ext** | `user/<ext>@domain` bridge | 0 |
| **SIP‑trunk DID** | internal bridge to the customer PBX via `X-PBX-Dest` (Kamailio relays to PBX, **never Bandwidth**) | 0 |
| **API DID** | answered on‑platform; `voice_webhook.lua` runs | 0 (unless the app itself `<Dial>`s out) |

"On‑net" = no carrier **hairpin** for the forwarding/handoff. A chain terminating at a real PSTN phone still needs the **one** legit carrier leg (the actual call). We eliminate the redundant *first* egress+re‑ingress.

## 4. Billing / CDR
`mod_json_cdr` is A‑leg‑only → **one CDR per logical call** already. Set `customer_id` = **terminal** customer, so `rate_cdr()` is **unchanged** (it already rates `customer_id`). New idempotent columns (migration mirrors `16_`/`18_`): `origin_customer_id`, `terminating_customer_id`, `on_net BOOLEAN DEFAULT false`, `on_net_hops SMALLINT` + a partial index on `origin_customer_id`. FS sets `origin_customer_id` at first hop and `customer_id`/`terminating_customer_id`/`on_net`/`on_net_hops` at the terminal. Off‑net calls: `origin_customer_id==customer_id`, `on_net=false` (backward‑compatible).

`cdrs.py` `_process_cdr_body`: +4 additive `variables.get(...)` extractions + 4 INSERT params with **explicit `::type` casts** (`$N::int/::bool/::smallint`). Ingest still always returns 200.

## 5. Caller‑ID composition
Carry one `presented_cid` through `ctx`, seeded with the original caller. At each RCF hop with flag `P` and DID `D`: if `P` (pass=true) leave `presented_cid` unchanged (transparent); if `false`, `presented_cid := D` (that DID masks). **Last `false` hop wins.** At the terminal, reuse the existing CID machinery (`effective_caller_id_number`, `X-Original-CID`→PAI, `Remote-Party-ID`, `Diversion`) with `ctx.presented_cid`. Outbound From stays the terminal DID for Bandwidth auth; presented identity flows via PAI/RPID as today.

## 6. Loop / limits / hard‑reject / fraud
- **Loop:** `visited` set (E.164 of every DID entered, seeded with inbound DID); re‑entry → immediate hard reject. Fully in‑memory — **no SIP emitted for a loop**, so Kamailio never sees it.
- **MAX_HOPS=5:** `ctx.hops>5` → hard reject.
- **Hard reject codes:** disabled/suspended terminal → `hangup("CALL_REJECTED")` (603); loop/hop‑limit → `hangup("EXCHANGE_ROUTING_ERROR")` (483). Set `lua_routed=true` so the dialplan doesn't mask with 404. Never fall through to carrier.
- **`max_channels`:** enforce **once on the terminal DID** (not intermediate hops — they emit no B‑leg).

## 7. Gotchas to NOT trip (preserve)
- Exactly **one** carrier B‑leg for an off‑net terminal → the double‑RR/`r2=on`, session‑timer normalization, and SOA handling are exercised exactly as today. Internal hops emit no carrier SIP.
- Trunk terminal uses `X-PBX-Dest` (not `X-Carrier`). Don't set `X-Carrier` on a trunk terminal.
- RCF terminal keeps **default media** (no `proxy_media`); trunk terminal keeps `proxy_media=true`. On‑net changes *which terminator runs*, not its media mode.
- Keep passing `sip_call_id` as `X-CID` on the terminal bridge so Homer correlates A‑leg↔terminal even across products.
- Postgres‑only (no Redis in the RCF path).

## 8. Extensibility contract (a future product)
1. **Enroll in the oracle:** add one `UNION ALL` arm to `number_routing` exposing the canonical columns (nulls for irrelevant product‑specific ones). The product's DID table must have `UNIQUE(did)` + a **hash index on `did`**.
2. **A terminator** `terminate_<product>(dest_routing, ctx)` that delivers the call, sets terminal `customer_id`/`terminating_customer_id`/`on_net`, applies `ctx.presented_cid`, enforces its concurrency, sets `lua_routed=true`; register in `TERMINATORS`.
Detection, hop loop, loop/hop‑limit/reject, and CDR emission are product‑agnostic and untouched.

## 9. Implementation plan (file‑by‑file, on RCF‑V1)
1. **`docker/postgres/init/22_number_routing.sql`** (new; verify next free number) — the view + `GRANT SELECT ... TO freeswitch, api`. Run on the **primary** (manual in prod; init scripts only run on first `initdb`). `EXPLAIN` the `WHERE did=$1` query → confirm 3× `Index Scan using idx_*_did_lookup`.
2. **`docker/postgres/init/23_onnet_cdr_columns.sql`** (new) — idempotent `ALTER … ADD COLUMN IF NOT EXISTS` for the 4 CDR columns + partial index.
3. **`docker/freeswitch/scripts/lib/db_client.lua`** — `M.resolve_destination(did)` mirroring `lookup_rcf` (validate_did → the §1 query via `sql_string` → single row or nil; **no** enabled/active filter in SQL).
4. **`docker/freeswitch/scripts/inbound_router.lua`** — extract `terminate_rcf/api/trunk`, build `TERMINATORS`, thread `ctx`; insert the on‑net decision + chain loop at the RCF branch point; move `max_channels` to the terminal; set the CDR/CID channel vars; hard‑reject helper. **Behavior‑preserving for off‑net calls.**
5. **`docker/api/src/routers/cdrs.py`** — +4 additive INSERT params (`::type` casts).
6. **CLAUDE.md updates:** root Call Flow + Account Types; `docker/freeswitch/scripts/CLAUDE.md` (retire the "only local check is 10xx" model, add terminators/oracle); `docker/postgres/CLAUDE.md` (view + CDR cols); `docker/api/**/CLAUDE.md` (CDR carries origin+terminating customer).

## 10. Validation (before push/deploy)
Provision A→B test‑DID pairs per product (origin customer O, terminal T) and assert in Homer/CDRs:
- **RCF→RCF→PSTN:** one carrier INVITE (to the PSTN #), **zero** re‑ingress, **one** CDR `origin=O, customer=terminating=T, on_net=true, on_net_hops=2`, rated on T.
- **RCF→trunk:** zero carrier INVITEs; one internal bridge to T's PBX; one CDR.
- **RCF→API:** answered on‑platform, app runs; zero carrier leg unless the app dials out.
- **Loop** (A↔B): 483 / `EXCHANGE_ROUTING_ERROR`, no SIP to Bandwidth.
- **Disabled terminal:** 603 / `CALL_REJECTED`, no carrier fallback.
- **Hop limit** (6‑DID chain): reject at hop 6.
- **Regression (off‑net):** unchanged 4‑attempt carrier path; `on_net=false`.

## 11. Open questions (not blocking the build)
- **Cross‑customer settlement (deferred):** rate‑on‑terminal means the terminal customer pays for a call the origin DID forwarded. Fine same‑customer; a settlement/forwarding‑fee question when origin≠terminal. CDR records both → decide the model later.
- **Replica lag on brand‑new DIDs:** a DID enabled seconds ago may resolve "not ours" on a cross‑region replica for ~130 ms and take the carrier path (still works, never mis‑bills).
- **Trunk terminal reachability:** PBX down = call fails cleanly (per decision #4). `rcf_numbers.failover_to` (unused today) is a future terminal‑failover hook.
- **API voice app that `<Dial>`s a platform DID** re‑enters as a fresh call, not covered by `visited`/`hops` — separate concern for the API product.

## Deploy (after validation, operator‑run)
Build here → operator tests → **operator pushes to the repo** → update all deployed FreeSWITCH nodes (`git pull` + rebuild `docker-compose.media.yml` per zone) and apply the two SQL migrations on the **primary** (replicates to all zones).
