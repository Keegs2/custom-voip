# Lua unit / characterization tests (Phase 0)

Headless tests for the FreeSWITCH `mod_lua` routing scripts. They load the
**real** production scripts (`docker/freeswitch/scripts/*.lua`) inside a mocked
`freeswitch` / `session` / DB sandbox and assert their exact behavior — a
regression baseline of CURRENT behavior before later phases change anything.

## Layout

```
tests/lua/
  mocks/
    freeswitch_mock.lua   -- mocks the `freeswitch` global (consoleLog, API,
                             get/setGlobalVariable)
    session_mock.lua      -- mocks the `session` object (getVariable, setVariable,
                             execute, bridge/export capture, hangup, ready, ...)
    db_mock.lua           -- mocks lib/db_client.lua (+ redis_client/redis_cps)
  helpers.lua             -- sandbox loader: runs the real scripts headless;
                             extract() returns real local helpers byte-for-byte
  spec/
    normalization_spec.lua    -- E.164 normalize_did / to_10digit / normalize_destination
    inbound_router_spec.lua   -- RCF dial strings, CID/Diversion/RPID headers,
                                 session-timer exports, 4-attempt failover ORDER
    trunk_outbound_spec.lua   -- trunk dial string, X-Carrier failover, CID, timers
  busted_shim.lua         -- minimal busted API so specs run under plain `lua`
  run.lua                 -- standalone runner (used when busted isn't installed)
  .busted                 -- config for real busted
```

## Running

Preferred (real busted):

```
luarocks install busted   # once
make test-lua             # or: busted tests/lua/spec
```

Fallback (no busted; uses the bundled shim + plain `lua` 5.3/5.4):

```
make test-lua             # auto-detects: falls back to `lua tests/lua/run.lua`
```

Both run the identical spec files. The specs use only the assertion surface the
shim implements (`assert.are.equal`, `assert.are.same`, `assert.is_true/false`,
`assert.matches`, ...); if you add a spec needing more of luassert, install busted.

## How the harness loads real code

`helpers.run_script(path, opts)` builds a sandbox `_ENV` (inheriting stdlib),
injects the `freeswitch` and `session` mocks, a controlled `os.getenv`, and a
`loadfile` override so the scripts' `load_module("db_client")` returns the mock.
`require("socket")` is forced to fail so the SBC TCP pre-check fails open
deterministically (all bridge attempts run). The script executes top-to-bottom;
tests then assert on the recorder (`rec.bridges`, `rec.set_map`, `rec.exports`,
`rec.hangups`).

`helpers.extract(path, marker, names, opts)` loads the script **truncated** just
before the routing logic and returns the named local functions — byte-for-byte
the shipped `normalize_did` / `to_10digit` / `normalize_destination`, so the
normalization table tests exercise the actual code, not a copy.
