# UNIFY Integration Map — Restoring UCaaS on the hardened RCF-V1 base

**Goal (Phase 1):** graft the *additive* UCaaS stack from `Full-System` back on top of the
production-hardened `unified` (= `RCF-V1`) base **without regressing any hardening**.

**Branch facts**
- `unified` == `RCF-V1` (223 commits ahead of Full-System: added hardening **and** deleted UCaaS).
- Worktree `/tmp/revup-fullsystem` == `Full-System` (pre-strip snapshot, full UCaaS).
- Diff direction used throughout: `git diff unified Full-System` → a `-` line is **RCF-V1 (keep)**,
  a `+` line is **Full-System (UCaaS / pre-hardening)**.
- Aggregate churn: **55 A** (UCaaS files absent on unified), **131 D** (hardening files Full-System
  never had), **86 M** (shared files that differ).

**Golden rule:** for every shared (M) file, the reconciliation is *keep the RCF-V1 body, splice the
UCaaS hooks back in*. Never restore an M file by wholesale copy from Full-System — that silently
reverts hardening (and most of the `+` content in M files is **pre-hardening regression**, not UCaaS).

---

## Section A — Files to RESTORE (purely additive; copy as-is, LOW risk)

These exist on Full-System and are absent on `unified` (`git diff --name-status unified Full-System | grep '^A'`).
No merge — straight `git checkout Full-System -- <path>`. They reference shared files reconciled in §B.

### A.1 API routers — `docker/api/src/routers/` (4,048 LOC)
| File | LOC | Notes |
|------|-----|-------|
| `chat.py` | 816 | also drives `/ws/chat` fanout (Redis pub/sub `chat:events`,`chat:typing`) |
| `conference.py` | 810 | conference room CRUD / PIN / participant mgmt |
| `documents.py` | 607 | file storage metadata |
| `extensions.py` | 513 | per-customer extension provisioning (multi-tenant) |
| `ivr.py` | 603 | IVR builder backend (UI page already on unified; router was stripped) |
| `voicemail.py` | 243 | mailbox + greeting mgmt |
| `presence.py` | 184 | presence status; drives `/ws/presence` fanout |
| `webrtc.py` | 130 | Verto credential issuance (needs `greenswitch`/ESL — see §B.2) |
| `api_dids.py` | 142 | API-Calling DIDs (not UCaaS proper, but stripped too; gate to `api`/`hybrid`) |

### A.2 DB schemas — `docker/postgres/init/` (795 LOC) — **ordering is a §B/§C concern**
`10_schema_ucaas.sql` (128), `11_schema_chat.sql` (105), `11b_add_ucaas_type.sql` (28),
`11c_ucaas_enabled_flag.sql` (8), `11d_per_customer_extensions.sql` (18),
`12_multi_tenant_extensions.sql` (27), `13_schema_conferencing.sql` (108),
`15_schema_documents.sql` (51), `17_account_cleanup.sql` (322 — **RENUMBER, see §C-4 / §B.9**).

### A.3 UI — api / types / contexts / lib (2,674 LOC)
`api/{chat,conference,extensions,presence,voicemail,webrtc}.ts`,
`types/{chat,conference,softphone}.ts`,
`contexts/{ChatContext.tsx (379), SoftphoneContext.tsx (554)}`,
`lib/verto.ts` (**1,115** — hand-rolled Verto JSON-RPC client; **no npm dep**, see §B.10).

### A.4 UI pages (7,568 LOC)
`pages/{ChatPage (296), CommunicationsPage (402), ConferencePage (2,493), DocsPage (1,512),
DocumentsPage (2,033), VoicemailPage (832)}.tsx`.

### A.5 UI components (6,905 LOC)
`components/chat/*` (6 files: ConversationList, MessageBubble, MessageInput, MessageThread,
NewConversationModal, TypingIndicator),
`components/softphone/*` (8: ActiveCall, CallHistory, ContactList, DeviceSelector, DialPad,
IncomingCallBanner, PresenceIndicator, SoftphoneWidget),
`components/conference/ConferenceRoom.tsx`.

### A.6 FreeSWITCH configs
**None to add as new files.** `conf/sofia/{verto,...}` — note `verto.conf.xml`,
`conference.conf.xml`, `conference_layouts.conf.xml`, `voicemail.conf.xml`, and `lang/en/en.xml`
**already exist identically on `unified`** (kept during the strip; only the module *loads* were
disabled). So the FS layer is entirely a §B *re-enable* job, not a copy job.

### A.7 Non-restore (skip)
`CONTAINERIZATION_PLAN.md`, `docker/homer/{bootstrap,init-user-db.sh,seed-aliases.sh}` —
Homer scaffolding superseded by RCF-V1's hardened Homer pipeline (commit 075958d); do **not** restore.

---

## Section B — SHARED integration points (exist on BOTH, DIFFER) — reconcile by grafting

### B.1 `docker/api/src/main.py`  *(graft router registrations + WS plumbing)*
- **RCF-V1 has (keep):** `import os, time`; `ENABLE_DOCS` toggle; **`CORS_ORIGINS` env-driven**
  (`os.getenv("CORS_ORIGINS", ...)`); routers `sipp, sbc, homer, onboarding`; `/freeswitch` mount.
- **Full-System adds (graft back):** imports `ivr, extensions, presence, voicemail, webrtc, api_dids,
  chat, conference, documents`; their `include_router(...)` lines (both `/v1/...` and bare prefixes);
  the `PresenceConnectionManager` + `ChatConnectionManager`, `_presence_subscriber`,
  `_chat_subscriber`, `_presence_ttl_cleanup` background tasks, their lifespan create/cancel, and the
  `@app.websocket("/ws/presence")` + `@app.websocket("/ws/chat")` endpoints.
- **Full-System REGRESSIONS to reject:** `allow_origins=["*"]` (keep RCF-V1 `CORS_ORIGINS`);
  dropping `ENABLE_DOCS` (keep the toggle); title churn is cosmetic.
- **Action:** start from RCF-V1 main.py. Add the 9 UCaaS routers to the existing import tuple and add
  matching `include_router` pairs. Append the two WS managers + three background tasks + two
  `@app.websocket` handlers. Wire the three `asyncio.create_task(...)` into the existing `lifespan`
  with cancel-on-shutdown. Do **not** touch CORS/ENABLE_DOCS/`sipp,sbc,homer,onboarding`.

### B.2 `docker/api/requirements.txt` + Dockerfile
- **RCF-V1 has (keep):** explicit `bcrypt>=4.0.0`.
- **Full-System adds (graft):** `pydantic-settings>=2.1.0`, `aiohttp>=3.9.0`, `greenswitch>=0.0.5`
  (ESL client used by `webrtc.py`/voicemail). Full-System dropped the explicit `bcrypt` pin.
- **Action:** keep `bcrypt>=4.0.0` **and** add the three new deps. Verify which UCaaS routers import
  `greenswitch`/`aiohttp` (webrtc, voicemail) so the deps are actually required. API Dockerfile is
  otherwise unchanged (no system-lib additions needed).

### B.3 `docker/freeswitch/Dockerfile`  *(re-enable module builds; KEEP RCF EXPOSE/CMD/healthcheck)*
- **Re-enable (Full-System `+` sed lines):** uncomment build of `applications/mod_conference`,
  `formats/mod_av`, `endpoints/mod_verto`, `endpoints/mod_rtc`, `applications/mod_voicemail`,
  `applications/mod_callcenter`, `applications/mod_valet_parking`, `applications/mod_spy`.
  **Remove** the RCF-V1 explicit-DISABLE seds for those modules.
- **Re-add build/runtime deps for mod_av:** `libavformat-dev`,`libswscale-dev` (builder);
  `libavformat59`,`libswscale6` (runtime).
- **Re-add:** `mkdir -p /var/lib/freeswitch/voicemail`; `COPY conf/lang/ .../conf/lang/`;
  TLS cert generation block (Full-System self-signs `agent.pem`/`wss.pem` for Verto WSS).
  → In production, prefer mounting CA certs (RCF-V1 comment) over self-signed; self-signed is fine
  for dev. Either way Verto needs a `wss.pem`.
- **KEEP RCF-V1 hardening — reject these Full-System changes:**
  - `EXPOSE 16384-49151/udp` (10K calls) — **do not** shrink to `16384-18383`.
  - **No in-Dockerfile `HEALTHCHECK`** — RCF-V1 deliberately removed it so the compose healthcheck can
    pass `-p $ESL_PASSWORD` (lesson `test_fs_healthcheck_uses_esl_password`). Do **not** re-add the
    Full-System `fs_cli -x "status"` healthcheck.
  - Keep RCF-V1 `ENTRYPOINT`/`CMD` and `EXPOSE 8082/tcp` for WSS (RCF-V1 had it commented; uncomment).
- **Action:** edit only the `sed` block, the two apt blocks, the mkdir/COPY/TLS lines, and uncomment
  `EXPOSE 8082`. Leave RTP EXPOSE range, ENTRYPOINT, CMD, and the absence of HEALTHCHECK intact.

### B.4 `docker/freeswitch/conf/autoload_configs/modules.conf.xml`
- **Re-enable `<load>`:** `mod_conference`, `mod_voicemail`, `mod_av`, `mod_rtc`, `mod_verto`,
  `mod_valet_parking`. (Their `.conf.xml` already ship on unified — see §A.6.)
- **DO NOT re-enable (lesson regressions):** `mod_local_stream` — guarded by
  `test_fs_mod_local_stream_disabled_and_silence_stream_used`; its `local_stream.conf.xml` does **not**
  exist on either branch → CRIT abort on xml_curl miss. Keep disabled; UCaaS hold-music must use
  `silence_stream://` (or add the missing conf first — see §C-2). Also leave `mod_httapi` and
  `mod_http_cache` **disabled** unless a restored feature needs them and their local conf exists
  (same CRIT-abort gotcha #6).
- **Action:** uncomment exactly the six loads above; leave the local_stream/httapi/http_cache blocks
  commented.

### B.5 `docker/freeswitch/conf/dialplan/public.xml`  *(graft UCaaS extensions only)*
- **Graft these additive extensions (Full-System `+` blocks) into the RCF-V1 file:**
  `local_extension` (default ctx, `^(\d{2,6})$` → `verto.rtc/$1|user/$1` then voicemail),
  `voicemail_check` (`*97`), `conference_room_pin` (`*88{room}P{pin}`), `conference_room` (`*88{room}`,
  `@video` mux), `valet_park` (`*58XX`) / `valet_unpark` (`*59XX`), and `local_extension_public`.
- **REJECT the entangled regressions** Full-System also makes in this file: `X-Carrier=standard/premium/
  backup` (RCF-V1 uses **`primary`/`secondary`** — Kamailio routes on these), `@127.0.0.1:5060`
  (RCF-V1 uses `@${sbc_proxy_ip}:5060`), and the removal of `sip_enable_soa=false` on PSTN/911 bridges.
  Keep RCF-V1's `default_outbound`, `emergency`/911, and all carrier-facing bridges verbatim.
- **Action:** insert only the new `<extension>` blocks; do not modify existing outbound/911 extensions.
  The UCaaS extensions reference `mod_voicemail`/`mod_conference`/`mod_valet_parking` (enabled in §B.4)
  and `customer_domain` from the xml_curl directory (intact, §B.7).

### B.6 `docker/freeswitch/scripts/inbound_router.lua`  *(graft the `ucaas` product branch)*
- **RCF-V1 branches:** `rcf` (L441) → `api` (L817) → `trunk` (L862). **Full-System** additionally has
  `elseif product_type == "ucaas"` (Full-System L699–811, ~112 lines) between `api` and `trunk`.
- **Action:** splice the `ucaas` branch from Full-System **after the `api` branch and before `trunk`**
  in the RCF-V1 file. Safety verified: the ucaas branch sets `proxy_media=true` but lives **outside**
  the `rcf`→`api` region that `test_fs_no_proxy_media_in_rcf_bridge_path` inspects, so the lesson stays
  green. Before committing, confirm the branch uses `sofia/external/...` (not `sofia/gateway/` —
  `test_fs_no_gateway_bridge_syntax`) and contains no `redis`/`require('redis')`/`load_module("redis_client")`
  (`test_inbound_router_has_no_redis_route_logic`). Do not touch the rcf branch or the `redis=DISABLED`
  marker.

### B.7 `docker/freeswitch/conf/sofia/{internal,external}.xml`  *(take NOTHING from Full-System)*
- The diffs here are **pure pre-hardening regression, not UCaaS hooks.** Full-System would: add a
  per-profile `capture-server` (silently ignored — RCF-V1 documents it as global-only), flip the
  internal `<domains>` to `parse="true" alias="true"` (RCF-V1 set `parse="false"` to kill the per-call
  directory 404), rename carriers `primary/secondary`→`standard/premium/backup`, and re-add
  `inbound-late-negotiation` prose.
- Verto/WebRTC does **not** need these profiles changed — Verto runs on its own WSS profile
  (`verto.conf.xml`, identical on both). Static directory users still load under `parse="false"`, and
  dynamic per-customer registration goes through xml_curl `directory` (§B.8), which is intact.
- **Action:** **keep RCF-V1 internal.xml and external.xml unchanged.** Guarded by
  `test_fs_two_sofia_profiles_*`, `test_fs_local_network_acl_loopback_auto_on_both_profiles`,
  `test_fs_minimum_session_expires_90_on_both_profiles`, `test_fs_rtp_keepalive_on_both_profiles`.
  (See §C-1 for the multi-tenant-registration caveat.)

### B.8 Other FS configs — `freeswitch.xml`, `xml_curl.conf.xml`, `directory/default.xml`, `switch.conf.xml`, `sofia.conf.xml`
- All five differ only because **RCF-V1 added** multi-VM/hardening content (env-templated `homer_ip`,
  `hep_capture_id`, `sbc_proxy_ip[_failover]`, 32K RTP range in `freeswitch.xml`; `$${api_host}:$${api_port}`
  directory binding in `xml_curl.conf.xml`; `carrier_primary` default gateway in `directory/default.xml`).
  Full-System has the older/smaller versions. **None carry UCaaS hooks.**
- **Action:** keep all five at RCF-V1. The xml_curl `directory` binding (per-customer extension lookup
  used by the UCaaS dialplan) already exists on RCF-V1 — UCaaS multi-tenant registration works as-is.

### B.9 Postgres init ordering  *(collision at prefix `17`)*
- **RCF-V1-only files:** `11a_schema_did_assignment`, `16_cdr_detail_columns`, **`17_did_inventory`**,
  `18_sbc_id_column`, `19_onboarding_requests`, `20_rcf_max_channels`.
- **UCaaS files to add:** `10,11,11b,11c,11d,12,13,15` and **`17_account_cleanup`**.
- **Collision:** prefix **`17`** is used by both (`17_did_inventory.sql` on RCF-V1 vs
  `17_account_cleanup.sql` from UCaaS). Different filenames → both run (no overwrite), but docker
  entrypoint runs **alphabetically**, so `17_account_cleanup` (…`c`…) runs *before* `17_did_inventory`
  (…`d`…) and before RCF's 18/19/20. `17_account_cleanup` is a **demo-data reset** ("Replaces old test
  customers IDs 1-5", renames Granite) — it must run LAST and is arguably *production-unsafe*.
- **Action:** **renumber UCaaS `17_account_cleanup.sql` → `21_account_cleanup.sql`** (or `99_…`), and
  gate it behind a dev-only flag / exclude from the production init set. All other UCaaS files
  (10–15) slot cleanly after `09_schema_users` and before `14_granite_accounts`/16+. Order check:
  `10 < 11 < 11a < 11b < 11c < 11d < 12 < 13 < 14 < 15` is FK-safe (10 creates extensions/UCaaS
  tables referenced by 11d/12/13). `11b` re-adds the `account_type` CHECK including `'ucaas'`
  (idempotent DROP/ADD) and inserts a Test UCaaS customer id=5 (`ON CONFLICT DO NOTHING`).

### B.10 Compose — `docker-compose.yml`, `docker-compose.media.yml`, `docker-compose.services.yml`
- **Local `docker-compose.yml`:** Full-System sets `VERTO_WS_URL=${VERTO_WS_URL:-ws://...:8082}` on
  the API/UI and maps FS WSS. **Keep RCF-V1's** `CORS_ORIGINS`, `${API_PORT:-8088}`, `${UI_HTTP_PORT:-8080}`
  parametrization (Full-System hardcodes `8088`/`8080`). **Action:** add `VERTO_WS_URL` env passthrough
  for the UI; do not delete RCF-V1 env vars or hardcode ports.
- **`docker-compose.media.yml`:** **does not exist on Full-System** (per-VM composes are RCF-V1-only).
  FS uses `network_mode: host`, so Verto port 8082 is already reachable; just ensure the media VM
  firewall/NLB allows 8082/tcp and `VERTO_WS_URL` points at the media VM. **Keep** the
  `fs_cli -p $ESL_PASSWORD` healthcheck (lessons `test_media_healthcheck_passes_esl_password`,
  `test_fs_healthcheck_uses_esl_password`) and `NET_ADMIN`. No service entries to add.
- **`docker-compose.services.yml`:** unchanged — keep `DATABASE_URL=host.docker.internal:6432`,
  `host.docker.internal:host-gateway`, python-based API healthcheck (lessons
  `test_database_url_targets_pgbouncer_6432`, `test_services_compose_mounts_host_gateway`,
  `test_api_healthcheck_uses_python_not_curl`). The new `/ws/presence`,`/ws/chat` ride the existing
  API container.

### B.11 UI — `App.tsx` + Sidebar/nav + `package.json` + nginx
- **`package.json`:** **identical on both branches (empty diff).** Verto is hand-rolled in `lib/verto.ts`
  (raw WebSocket JSON-RPC). **No npm deps to add.**
- **`docker/ui/nginx.conf`:** **already wired on RCF-V1** — it has `location /ws/verto/` →
  `http://<sbc>:8082/` (wss→ws unwrap) and `location /api/ws/` → `http://api:8000` with
  `Upgrade/Connection` headers. No change needed (confirm the verto upstream IP/host for the target zone).
- **`App.tsx`:** RCF-V1 base already has `AuthProvider`, the sidebar layout, and most routes
  (incl. `ivr`). **Graft:** wrap children in `SoftphoneProvider` then `ChatProvider` (inside
  `AuthProvider`); add routes `voicemail`, `chat`, `conference`, `documents`, `communications` and
  their imports. Manual splice — RCF-V1 restructured routing (e.g. `docs/rcf`, `onboarding`,
  `platform`), so do not overwrite.
- **`Sidebar.tsx`:** RCF-V1 base **already has the gating engine** — `accountTypes`/`adminOnly` on
  `NavItemDef`, and the filter `item.accountTypes.includes(user.account_type)` (L576–584). **Graft:**
  `hasUcaas` (`account_type==='ucaas' || (account_type!=='rcf' && ucaas_enabled===true)`), the
  presence menu + `PresenceIndicator`, and the comms nav items (`Chat`,`Meetings`,`Documents`,
  `Voicemail`,`Communications`) **each tagged `accountTypes: ['ucaas','hybrid']`** (never visible to
  `rcf`). `types/auth.ts` already includes `'ucaas'` and `ucaas_enabled`, so no type changes needed.
- **`tsc --noEmit` before any push** (unused imports break the Docker build — CLAUDE.md testing note).

---

## Section C — CONFLICT / REGRESSION RISKS (with lesson cross-refs)

| # | Risk | Severity | Guard that catches it | Mitigation |
|---|------|----------|-----------------------|------------|
| C-1 | Internal sofia `<domains parse>` — UCaaS multi-tenant Verto registration may want dynamic per-request directory parsing; RCF-V1 set `parse="false"` (kills per-call 404). Wholesale-copying Full-System's `parse="true"` reintroduces the per-call directory fetch error. | **HIGH** | `test_fs_two_sofia_profiles_*`, `local_network_acl`, `minimum_session_expires`, `rtp_keepalive` (all read internal/external.xml) | Keep `parse="false"`. Per-customer extensions register via the xml_curl `directory` binding (§B.8), which loads static + dynamic users without per-request domain PARSE. If a UCaaS registration genuinely needs domain-scoped variables, add them in the directory handler, **not** by flipping `parse`. |
| C-2 | `mod_local_stream` (+`mod_httapi`,`mod_http_cache`) re-enabled by Full-System modules.conf → CRIT module-load abort when xml_curl can't reach the API (no `local_stream.conf.xml`). | **HIGH** | `test_fs_mod_local_stream_disabled_and_silence_stream_used` + gotcha #6 | Leave `mod_local_stream`/`httapi`/`http_cache` commented. UCaaS MOH uses `silence_stream://`. Only enable `mod_local_stream` if you also add a valid `local_stream.conf.xml` first. |
| C-3 | FS Dockerfile regressions ride in with the module re-enables: shrinking RTP `EXPOSE` to `16384-18383`, re-adding the password-less `HEALTHCHECK`, or swapping CMD. | **HIGH** | `test_fs_healthcheck_uses_esl_password`, `test_media_healthcheck_passes_esl_password`, `test_fs_no_nonat_flag_in_cmd` | Edit only the `sed`/apt/COPY/TLS lines; keep `EXPOSE 16384-49151`, no Dockerfile HEALTHCHECK, RCF-V1 ENTRYPOINT/CMD. |
| C-4 | Postgres prefix `17` collision; `17_account_cleanup.sql` runs early and **wipes/replaces customers 1-5** (demo reset) ahead of RCF's `17_did_inventory`/18/19/20. | **HIGH** | (no static guard — DB ordering is runtime) | Renumber to `21_account_cleanup.sql` and exclude from prod init. Validate FK order `10<11<…<15` against `02/09` parents on a throwaway DB before merge. |
| C-5 | `public.xml` carrier-naming + transport regressions (`standard/premium/backup`, `@127.0.0.1`, dropped `sip_enable_soa=false`) bleed in when grafting UCaaS extensions. Kamailio routes on `X-Carrier: primary/secondary` — wrong names = no carrier route. | **HIGH** | `test_fs_no_gateway_bridge_syntax`, `test_fs_session_timer_export_in_lua` (Lua side) + live call test DID | Insert only the new `<extension>` blocks; leave existing outbound/911 extensions byte-for-byte RCF-V1. |
| C-6 | `inbound_router.lua` ucaas branch sets `proxy_media=true`; if pasted inside the rcf→api region it trips the no-proxy_media-in-RCF lesson. | **MED** | `test_fs_no_proxy_media_in_rcf_bridge_path` | Insert the ucaas branch strictly **after** `api` and before `trunk`. Re-scan the pasted block for `sofia/gateway/`, `redis`, `require('redis')`. |
| C-7 | `main.py` CORS reverts to `allow_origins=["*"]` / loses `ENABLE_DOCS` when restoring router registration. | **MED** | (no lesson guard — pure hardening) | Graft router lines into the RCF-V1 body; never replace the CORS/ENABLE_DOCS blocks. |
| C-8 | New WS background tasks (`_presence_subscriber`,`_chat_subscriber`) call `get_client()` on a loop — must not destabilize the always-200 health contract. | **MED** | `test_health_check_does_not_trigger_redis_reconnect`, `test_health_endpoint_always_returns_200` | The WS subscribers are independent of `health.py`'s `_check_redis`; ensure no shared blocking reconnect is introduced into the health path. Subscribers already self-reconnect with backoff. |
| C-9 | `SoftphoneWidget` hooks-below-early-return (React #310, has bitten 3×). | **MED** | `tests/lessons/test_api_lessons.py::test_softphone_hooks_above_early_return` (skipped — eslint rules-of-hooks owns it) | Restore `SoftphoneWidget.tsx` verbatim from Full-System (already fixed there); run eslint rules-of-hooks; never reorder hooks above the early `return null`. |
| C-10 | UCaaS nav/routes visible to `rcf` customers (violates `feedback_rcf_simplicity`: RCF never sees UCaaS). | **MED** | (UI gating logic; no pytest) | Tag every comms nav item `accountTypes: ['ucaas','hybrid']`; gate routes/providers on `hasUcaas`. RCF account → zero UCaaS surface. |
| C-11 | `requirements.txt` drops explicit `bcrypt` pin when adding UCaaS deps. | **LOW** | (transitively via passlib) | Keep `bcrypt>=4.0.0`; add `greenswitch`,`aiohttp`,`pydantic-settings` alongside. |
| C-12 | Verto WSS needs a `wss.pem`; missing cert = Verto WS profile fails to bind, breaking softphone/conference. | **LOW** | (none) | Restore the Dockerfile TLS-gen block (or mount CA certs) so `conf/tls/wss.pem` exists; open 8082/tcp on the media VM. |

---

## Section D — ORDERED restoration checklist

Gate after **every** step: `make test-lessons` (40 guards) + `make test-lua` + relevant pytest stay
**green**; `tsc --noEmit` clean for UI steps. Do not push until the live test DID
(+16174544217 → +17744045256) still forwards (CLAUDE.md testing).

1. **DB schemas (additive).** `git checkout Full-System -- docker/postgres/init/{10,11,11b,11c,11d,12,13,15}*.sql`.
   Restore `17_account_cleanup.sql` **renamed to `21_account_cleanup.sql`** (C-4). Spin up a throwaway
   Postgres, run init in order, confirm no FK/constraint errors and that `11b` ALTER is idempotent.
   *Gate:* lessons green (no DB lesson touched); manual init dry-run clean.
2. **API routers + main.py + requirements.** `git checkout Full-System -- docker/api/src/routers/{chat,
   conference,documents,extensions,ivr,presence,voicemail,webrtc,api_dids}.py`. Graft main.py per §B.1
   (keep CORS/ENABLE_DOCS). Add the 3 deps, keep `bcrypt` (§B.2). `pip install` + `uvicorn` import-boot.
   *Gate:* `test_api_lessons.py` green (health/CDR/JWT/CORS untouched); app imports; `/v1/chat` etc. mount.
3. **FreeSWITCH modules + Dockerfile.** Re-enable the 6 module loads (§B.4) and the Dockerfile
   build seds/deps/COPY-lang/TLS (§B.3); keep RTP EXPOSE range, no HEALTHCHECK, ENTRYPOINT/CMD.
   *Gate:* `test_sip_lessons.py` green (esp. local_stream-disabled, healthcheck, sofia profiles); FS image
   builds; `fs_cli` shows mod_verto/mod_conference/mod_voicemail loaded with no CRIT.
4. **FreeSWITCH dialplan + Lua.** Graft UCaaS `<extension>` blocks into `public.xml` (§B.5, keep carrier
   hardening); splice the `ucaas` branch into `inbound_router.lua` after `api` (§B.6).
   *Gate:* `make test-lua` + `test_sip_lessons.py` green (no-proxy_media-in-RCF, no-gateway-syntax,
   session-timer-export); live RCF call still forwards; a `ucaas` DID routes to extension/voicemail.
5. **Compose wiring.** Add `VERTO_WS_URL` passthrough to `docker-compose.yml` UI (keep RCF env/ports);
   confirm media VM 8082/tcp open and `wss.pem` present; services compose unchanged.
   *Gate:* `test_api_lessons.py` (DATABASE_URL/host-gateway/healthcheck) + `test_sip_lessons.py`
   (NET_ADMIN, media healthcheck) green.
6. **UI types/api/lib/contexts (additive).** `git checkout Full-System -- docker/ui/app/src/{types/{chat,
   conference,softphone}.ts,api/{chat,conference,extensions,presence,voicemail,webrtc}.ts,lib/verto.ts,
   contexts/{ChatContext,SoftphoneContext}.tsx}`.
   *Gate:* `tsc --noEmit` clean.
7. **UI pages + components (additive).** Restore §A.4/§A.5 files.
   *Gate:* `tsc --noEmit` clean.
8. **UI App.tsx + Sidebar graft + RCF gating.** Add providers + routes (§B.11); add comms nav items
   tagged `accountTypes:['ucaas','hybrid']` + `hasUcaas` + presence menu. nginx already wired (§B.11).
   *Gate:* `tsc --noEmit` clean; manual check — **`rcf` login shows zero UCaaS surface** (C-10); a
   `ucaas`/`hybrid` login shows Communications; full `make test` green.

---

## Risk verdict

The restoration is **tractable and mostly additive**: ~30k LOC of UCaaS files copy cleanly (§A), and
the FS config layer is a *re-enable*, not a rewrite, because `verto/conference/voicemail` configs and
`lang/` already survive on `unified`. The danger is concentrated in a handful of **shared M files where
UCaaS hooks are interleaved with pre-hardening regressions** — `main.py` (CORS), the FreeSWITCH
`Dockerfile`/`modules.conf` (mod_local_stream CRIT-abort, RTP EXPOSE, password-less healthcheck),
`public.xml` (carrier naming/`sip_enable_soa`), and the sofia profiles (which need **no** UCaaS change
at all and must be left untouched). The single hard infra collision is the duplicate Postgres `17`
prefix plus a production-unsafe demo-reset script (renumber + gate). If each shared file is edited by
*grafting into the RCF-V1 body* rather than copying from Full-System, and the 40 lesson guards +
`make test-lua` are run as the gate after every step, no hardening regresses. Net assessment:
**moderate risk, fully mitigated by the §D ordering and the existing tripwire suite** — provided the
sofia profiles and the four flagged HIGH-severity items (C-1..C-5) are honored exactly.
