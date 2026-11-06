# FreeSWITCH: luasocket never loads — the SBC TCP pre-check is off in production (and Redis probably is too)

Found 2026-11-06 during the #168–#174 maintenance window. Status: **open, not fixed.**
This doc describes the problem and the plan for closing it. It changes no code.

Labels: **[V]** = verified (production logs/CDRs read 2026-11-06, or the code at `RCF-V1` `c7f21a2`).
**[I]** = inferred from code and not yet checked on a VM.

## 1. Summary

- **The problem.** On every production FreeSWITCH node, `require("socket")` fails inside mod_lua. The error is `error loading module 'socket.core' from file '/usr/local/freeswitch/scripts/'` [V].
- **What turns off.** Both SBC reachability probes catch this and **fail open**:
  - `sbc_tcp_probe` in `inbound_router.lua` (RCF);
  - `sbc_tcp_probe` in `lib/term_trunks.lua` (trunk/API 8YY egress).
  So the cached 1 s TCP pre-check described in `CLAUDE.md` ("SBC Failover — TCP Pre-Check") and `PRODUCTION_ARCHITECTURE.md` has **never run in production** [V].
- **Why it matters.** The failover loop is still there, so calls complete. What's gone is the **< 1 s detection of a dead SBC target**. Today a dead target costs the whole SIP/`progress_timeout` wait (10 s) per attempt.
- **Root cause.** A path-template bug, not a missing package:
  - `lua.conf.xml` sets `script-directory` to a bare directory with no `?.lua`;
  - mod_lua adds it to `package.path`;
  - Lua's `.lua` searcher then "finds" that directory for any module it doesn't match earlier. It fails to load it and raises an error before the `.so` searcher ever runs.
  - `socket.core` is a C module, so it always reaches that entry.
- **Same cause, likely second casualty.** `redis-lua` needs luasocket, so `lib/redis_client.lua` almost certainly fails the same way. **The Redis-backed features (API CPS tiers via `redis_cps`, `channel_release`, startup checks) are probably fail-open today** [I, verify in §6.1]. Fixing luasocket would switch them on, so that needs its own decision (§5, Part C).

## 2. Evidence (production, 2026-11-06)

| What | Result |
|---|---|
| Warning text (every FS node) | `[WARNING] switch_cpp.cpp:1466 [inbound_router] luasocket unavailable (error loading module 'socket.core' from file '/usr/local/freeswitch/scripts/': …) — SBC TCP pre-check disabled, failing open` [V] |
| Volume over 7 days | `west-fs` 5277, `central-fs` 5196, `fs-media-v2` 5273, roughly one per RCF call (the warning fires once per call) [V] |
| Other Lua errors over 7 days | 0 on all three [V]. Nothing else is masking or masked by it |
| Since when | The image has had it since the probe shipped [I]. The log window only reaches back 7 days, and `RCF-V1` history shows no change to the loading code |
| Local reproduction | A `package.path` of `<good>/?.lua;<bare dir>/;` plus a `mod.lua` that calls `require("mod.core")` gives, word for word, `error loading module 'mod.core' from file '<bare dir>/'`. Setting `package.loaded["mod.core"]` first makes `require("mod")` succeed [V, Lua 5.5 on the Mac; `package.searchpath` and the searcher order are the same as 5.3] |

## 3. Root cause

All of this is at `c7f21a2`.

1. **mod_lua config.** `docker/freeswitch/conf/autoload_configs/lua.conf.xml:20` has
   `<param name="script-directory" value="/usr/local/freeswitch/scripts/"/>`.
   It's a bare directory, not a `…/?.lua` template.
2. **mod_lua adds it to the module search path.** Lua's `package.searchpath` replaces `?` in each template. A template with no `?` yields the template itself, here the directory.
3. **Searcher order.** `require` runs the preload searcher, then the **Lua-file searcher** (`package.path`), then the **C searcher** (`package.cpath`).
   - On Linux, `fopen()` on a directory in read mode succeeds, so the Lua searcher treats the directory as a "readable file". Loading it fails, and `require` raises `error loading module … from file '/usr/local/freeswitch/scripts/'` instead of moving on to the C searcher.
   - Every C module that isn't matched by an earlier `.lua` template reaches that entry, so it can never load through `require`.
4. **Why `require("socket")` gets halfway.**
   - `socket.lua` is a Lua file. The scripts' own prepended `package.path` entries (`/usr/local/share/lua/5.3/?.lua` …, `inbound_router.lua:19`, `lib/redis_client.lua:20`) find it before the bare entry.
   - Its first line, `require("socket.core")`, needs the C searcher, so the Lua searcher reaches the bare entry and raises the error.
   - The scripts also prepend `package.cpath` (`inbound_router.lua:20`). That never helps, because the error is raised in the Lua searcher before the C searcher runs.
5. **It's a known pattern here, fixed only case by case.**
   - CLAUDE.md "Critical Gotchas" #10 describes it.
   - `lib/db_client.lua:7-27` works around it for `luasql.postgres` with `package.loadlib("/usr/local/lib/lua/5.3/luasql/postgres.so", "luaopen_luasql_postgres")`. That's why DB lookups work.
   - Local modules use `loadfile()`.
   - Nobody applied the same workaround to luasocket.
6. **Not a packaging problem.** `docker/freeswitch/Dockerfile:229` runs `luarocks install luasocket` for Lua 5.3. Runtime `:311-312` copies `/usr/local/lib/lua` and `/usr/local/share/lua`. So `socket/core.so` should be at `/usr/local/lib/lua/5.3/socket/core.so` [I, check in §6.1].

## 4. Blast radius

| Component | Effect today | Confidence |
|---|---|---|
| `inbound_router.lua` `sbc_tcp_probe` / `is_sbc_reachable` (RCF bridge loop, `:1873`, `:1979`) | Always "reachable", never cached. Every attempt is tried | [V] (log) |
| `lib/term_trunks.lua` `sbc_tcp_probe` / `M.is_sbc_reachable` (`:487`), used by `trunk_outbound.lua` / `api_outbound.lua` 8YY `carrier_trunks` loop | Same | [I] (same code; little traffic, so few log lines) |
| `lib/redis_client.lua` `require("redis")` → `redis-lua` → luasocket | Likely logs `Redis library not available: …` and runs with `redis = nil` | [I] |
| `lib/redis_cps.lua` (`api_outbound.lua:91`, `:397`) | Likely logs `redis_cps unavailable, proceeding without CPS check (fail-open)` (`api_outbound.lua:445`). **API per-tier CPS limits are not enforced** | [I] |
| `channel_release.lua`, `startup.lua` (`pcall(require, "redis_client")`) | Likely `Failed to load redis_client…` and nothing done | [I] |
| `trunk_outbound.lua:64` `load_module("redis_client")` | Likely nil. Check what it gates before Part C | [I] |

**Docs that describe behaviour production doesn't have:**
- `CLAUDE.md` "SBC Failover — TCP Pre-Check" step 1;
- `PRODUCTION_ARCHITECTURE.md:100` and `:716`;
- `docker/freeswitch/CLAUDE.md:116` and `:180`;
- `docker/freeswitch/scripts/CLAUDE.md:417-422`;
- `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md:117`, the "Signaling ILB dark" row;
- `docs/VERIZON_IPSEC_TRUNKS_PLAN.md:264`, the worst-case bound mitigation (b).

## 5. What changes operationally once it works, and why that needs care

The probe has been dormant since it shipped. Switching it on is a **behaviour change on the call path**, not a no-op fix.

| Scenario | Today (probe off) | Probe on |
|---|---|---|
| Normal operation | Every attempt goes to `SBC_PROXY_IP` (signaling VIP) first | Same, plus about 2 TCP connects per target per minute per FS (cached 30 s up) |
| Signaling ILB dark, SBCs fine | Each VIP attempt waits `progress_timeout` (10 s), then the SBC-1-direct attempt. **About +10 s of dead air per trunk** | The VIP is marked down in ≤ 1 s and cached 10 s, so attempts go straight to SBC-1 direct |
| Active SBC dies | The ILB flips in about 10–12 s, and attempts in flight time out | Same flip. The probe adds nothing while the VIP itself still accepts connections |
| **TCP 5060 to a target not actually reachable from FS** (firewall, ILB rule, Kamailio not listening) | No effect: SIP is UDP | **Every attempt to that target is skipped.** If both targets fail the probe, RCF returns 503. **This is the risk to rule out before enabling (§6.1)** |

Kamailio listens on `tcp:SIGNALING_VIP:5060` and `tcp:SBC_INTERNAL_IP:5060` (`kamailio.cfg:217`, `:251`) [V]. The signaling ILB was built `L3_DEFAULT` / all ports, explicitly "UDP 5060 SIP + the TCP 5060 pre-check" (`SBC_ACTIVE_STANDBY_RUNBOOK.md:13`, `infra/OPENTOFU_PLAN.md:1811`) [V, design]. **No one has ever run a TCP connect from an FS to either target**, because the probe never did. That's check §6.1-3.

## 6. Plan (for 2026-11-07)

### 6.1 Read-only checks first (owner runs them; one line per FS, 6 nodes)

1. Confirm the module files are where Part B will load them from:
   `hostname | grep -q '^<FS>$' && sudo docker exec voip-freeswitch ls -l /usr/local/lib/lua/5.3/socket/core.so /usr/local/share/lua/5.3/socket.lua`
2. Find out whether Redis is really fail-open (it decides the scope of Part C):
   `hostname | grep -q '^<FS>$' && sudo docker logs --since 168h voip-freeswitch 2>&1 | grep -cE 'Redis library not available|redis_cps unavailable|Failed to load redis_client'`
3. **TCP 5060 reachability to both bridge targets**, from the FS host (FS uses host networking, so this is FS's own path). `<VIP>` / `<SBC1>` = East `10.142.0.250` / `10.142.0.100`, West `10.138.0.250` / `10.138.0.100`, Central `10.128.0.250` / `10.128.0.100`:
   `hostname | grep -q '^<FS>$' && for t in <VIP> <SBC1>; do timeout 2 bash -c "</dev/tcp/$t/5060" && echo "$t tcp/5060 OPEN" || echo "$t tcp/5060 CLOSED"; done`
   - Expect `OPEN` for both targets on all 6 nodes.
   - **Any `CLOSED` blocks Part B in that zone.** Fix the path first (firewall or ILB rule), which is owner GCP work.

### 6.2 Part B: make the probe load luasocket (code; this repo)

- **New `docker/freeswitch/scripts/lib/luasocket.lua`**, loaded with `loadfile()` like every other local lib:
  - If `package.loaded["socket.core"]` is nil, call `package.loadlib("/usr/local/lib/lua/5.3/socket/core.so", "luaopen_socket_core")`, falling back to `/usr/lib/lua/5.3/socket/core.so`. Put the result in `package.loaded["socket.core"]`.
  - Then `require("socket")`. `socket.lua` is found through the scripts' prepended `package.path`, and its own `require("socket.core")` is satisfied from `package.loaded`, so no searcher runs.
  - Return `socket`, or `nil, err`.
  - Setting `package.loaded` directly sidesteps the broken searcher entirely. This is the same technique `db_client.lua` already uses in production.
- **Both `sbc_tcp_probe` copies** (`inbound_router.lua:439`, `lib/term_trunks.lua:375`) call the lib instead of `pcall(require, "socket")`. They keep today's fail-open and warn-once behaviour if it still returns nil.
- **Runtime kill switch, no restart:**
  - Both copies return `nil` (fail open, exactly today's behaviour) when the FS global `sbc_tcp_precheck` is `off`.
  - `fs_cli -x "global_setvar sbc_tcp_precheck=off"` takes effect on the next call. It resets on FS restart, so the default stays "on".
  - This is the instant rollback.
- **Scope rule: Part B must not change Redis.**
  - `redis_client.lua` is untouched. `package.loaded` is per Lua state, and each mod_lua script run has its own state.
  - So preloading `socket.core` inside the probe's state can't switch Redis on in `trunk_outbound` / `api_outbound`, whose `redis_client` load runs earlier in their own scripts [I, the harness must prove it].
- **Tests** (`tests/lua/`, Lua 5.3 in CI; the Mac's `lua` is 5.5):
  - Reproduce the production failure by prepending a bare-directory entry to `package.path` in the harness. Assert that `require("socket")` fails and `lib/luasocket.lua` succeeds.
  - Assert that the kill switch gives fail-open, and that a probe to a closed port returns `false` (cached "down" for 10 s).
  - Extend `tests/lua/onnet_router_harness.lua` and `tests/lua/term_trunks_harness.lua`, which already stub SBC reachability.
- **Docs:** fix the list in §4 in the same PR, so the docs match the shipped behaviour.

### 6.3 Part C: Redis (separate PR, owner decision)

Fixing luasocket for `redis_client` switches on code that has probably never run in production:
- API CPS tiers (`redis_cps` default limits by tier, `lib/redis_cps.lua:56-67`);
- `channel_release` counters;
- startup checks.

Before anyone enables it:
- confirm the §6.1-2 result;
- list each Redis key the code reads (`account:{id}:limits` …) and whether anything populates it today;
- decide per feature: enforce, keep fail-open, or delete the dead code.

CLAUDE.md "Redis code removed from inbound_router.lua (RCF-V1)" already records that redis-lua had threading problems inside mod_lua, so "just turn it on" is not safe.

### 6.4 Part D: root fix (later window, needs an FS restart)

- Change `lua.conf.xml` `script-directory` to `/usr/local/freeswitch/scripts/?.lua`, which is the template form mod_lua expects.
- That removes the bare entry for every script and makes Gotcha #10 obsolete. The `loadfile` / `loadlib` workarounds can then go in a cleanup PR.
- It's a mod_lua config change, so FS has to restart. That makes it a planned FS recreate in a window (CLAUDE.md gotchas 1–2, the `killall -9 freeswitch` orphan check).
- Not urgent once Part B is in.

### 6.5 Deploy for Part B (overnight window; Lua is bind-mounted)

1. §6.1 shows all `OPEN`.
2. Per FS, in zone order: pinned `git pull` only. Lua takes effect on the next call, with **no FS restart and no `up -d`**.
3. Right after the first node, watch for 5 minutes:
   - `luasocket unavailable` count → 0 on new calls;
   - `fs_cli -x "global_getvar sbc_health_<VIP>"` → `up:<epoch>`;
   - **no** `SKIPPED — SBC … unreachable` lines;
   - test calls on the Granite Telephony RCF DIDs complete. (`+16174544217` is an IVR now; RCF tests use `+15595335908` and friends.)
4. Rollback, in order: `global_setvar sbc_tcp_precheck=off` on the node (instant), then `git checkout <PRE_SHA>`.

## 7. Open questions for the owner

1. Is Part B (probe only, Redis untouched, with a kill switch) the right first scope?
2. Part C: do you want the Redis-backed features enforced, kept fail-open, or removed? It depends on §6.1-2.
3. Part D: schedule it, or leave the per-module workarounds in place for now?
