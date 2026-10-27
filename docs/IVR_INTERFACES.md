# Visual IVR + Voicemail Resilience — Interface Contract (pinned 2026-10-25)

This is the **binding contract between the parallel builds.** The plan is `docs/IVR_PRODUCT_PLAN.md`; decision IDs (D1–D11) refer to it.

- Any change to a shape below is a contract change. Note it in "Changes" at the bottom, and tell every consumer.
- Nothing here is optional unless it says so.
- All SQL follows the house migration style:
  - idempotent
  - role-guarded grants
  - applied by hand on the East primary
  - a header block with the apply command

---

## 0. Ownership (who edits what)

| Build | Branch (off `RCF-V1`) | Owns (only these files/dirs) |
|---|---|---|
| **P1 Backend** | `feat/ivr-backend` | `docker/postgres/init/59_ivr.sql`, `60_cdr_ivr.sql`; `scripts/db/check_migrations.sql` (also adds the 58 check, §6.1); `docker/api/**` **except** `routers/voicemail.py`, `services/voicemail/**` and `auth/ingest.py`; `docker/tts/**` (new); `docker-compose.services.yml` (tts service + IVR env lines only); `docker-compose.yml` (tts in dev); `docker/api/**/CLAUDE.md`; `docs/IVR_*.md` |
| **P2 Runtime** | `feat/ivr-runtime` | `docker/freeswitch/scripts/inbound_router.lua`, `lib/db_client.lua`, new `lib/ivr_engine.lua`, `lib/ivr_prompts.lua`, `lib/media_leg.lua`, `lib/schedule.lua`, `lib/rules.lua`, `sounds/ivr/**`; `tests/lua/ivr_*.lua` (new) and extensions to `tests/lua/onnet_router_harness.lua`; `docker/freeswitch/**/CLAUDE.md` |
| **P2V Voicemail resilience** | `feat/vm-outage-resilience` | `docker/postgres/init/58_vm_outage_resilience.sql`; `lib/vm_box.lua`, `lib/vm_deposit.lua`, new `lib/vm_spool.lua`, `lib/vm_replica.lua`; `docker/api/src/routers/voicemail.py` (the `/fs/` section only), `docker/api/src/services/voicemail/**`, `tests/test_voicemail_outage_*.py` (new), `tests/lua/voicemail_harness.lua`; `docker/vm-forwarder/**` (new); **all** of `docker-compose.media.yml` (including P2's `IVR_ENABLED` + `ivr_prompts` volume, §7); `docker-compose.services.yml` (one env line, §8.4); `docker/api/Dockerfile` (only if the openssl CLI is needed); `docs/VOICEMAIL_OUTAGE_RESILIENCE.md`, `docs/runbooks/VOICEMAIL_OUTAGE_RESILIENCE_DEPLOY.md` |
| **P3 Portal** | `feat/ivr-portal` | `docker/ui/**` |
| **P4 TED** | `ted-next` `feat/crag-ivr-admin` (off `origin/main`) | the TED repo only |

- **Root files:** root `CLAUDE.md`, `PRODUCTION_ARCHITECTURE.md` and `README.md` are edited only by the orchestrator, at the end.
- **Shared files:** if a build needs a file it doesn't own, it asks the orchestrator.
- **`media_leg` and voicemail:** `lib/media_leg.lua` is created by P2. `vm_box.lua` is **not** switched to use it in this project, to avoid cross-PR coupling; that is a follow-up.

---

## 1. Database (`59_ivr.sql`, P1)

Types are PostgreSQL. `did` values are E.164 `+1XXXXXXXXXX` (`varchar(20)`).

```sql
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ivr_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS call_flows (
  id                   BIGSERIAL PRIMARY KEY,
  customer_id          INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product              VARCHAR(20) NOT NULL DEFAULT 'ivr' CHECK (product IN ('ivr')),
  name                 VARCHAR(100) NOT NULL,
  draft_graph          JSONB NOT NULL,            -- §2 (UI shape)
  revision             INT NOT NULL DEFAULT 1,    -- optimistic lock, +1 per draft write
  published_version_id BIGINT NULL,               -- FK to call_flow_versions(id), added after both exist
  created_by           INT NULL, updated_by INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_flow_versions (     -- immutable once inserted
  id               BIGSERIAL PRIMARY KEY,
  flow_id          BIGINT NOT NULL REFERENCES call_flows(id) ON DELETE CASCADE,
  version          INT NOT NULL,                  -- 1,2,3… per flow
  graph            JSONB NOT NULL,                -- the draft_graph that was published
  plan             JSONB NOT NULL,                -- §3 (what FreeSWITCH executes)
  compiler_version VARCHAR(20) NOT NULL,          -- e.g. 'ivr-1'
  published_by     INT NULL,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_id, version)
);

CREATE TABLE IF NOT EXISTS ivr_numbers (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  did          VARCHAR(20) NOT NULL UNIQUE,
  name         VARCHAR(100) NULL,
  flow_id      BIGINT NULL REFERENCES call_flows(id) ON DELETE SET NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,     -- admin kill switch (TED)
  max_channels INT NOT NULL DEFAULT 10 CHECK (max_channels BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ivr_prompts (
  id          BIGSERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  kind        VARCHAR(10) NOT NULL CHECK (kind IN ('tts','upload','recording')),
  tts_text    TEXT NULL, tts_voice VARCHAR(40) NULL,      -- kind='tts' only
  sha256      CHAR(64) NOT NULL,                          -- → ivr_prompt_audio
  duration_ms INT NOT NULL, bytes INT NOT NULL,
  deleted_at  TIMESTAMPTZ NULL,                           -- soft delete (versions may still reference)
  created_by INT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ivr_prompt_audio (       -- content-addressed, shared, immutable
  sha256     CHAR(64) PRIMARY KEY,                  -- lowercase hex of the exact WAV bytes
  wav        BYTEA NOT NULL,                        -- RIFF/WAVE, PCM16 LE, mono, 8000 Hz (§4)
  bytes      INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 1.1 Existing objects that change
- **`did_inventory` product CHECK:** gains `'ivr'`, using the name-agnostic swap pattern from `54_voicemail.sql:96-140`.
- **`number_routing`:** `CREATE OR REPLACE` the whole view, with the existing four arms **byte-for-byte**, plus:
  ```sql
  UNION ALL
  SELECT n.did, 'ivr'::varchar(20), n.customer_id, n.id AS product_ref_id,
         (n.enabled AND c.ivr_enabled AND f.published_version_id IS NOT NULL) AS product_enabled,
         c.status, NULL::varchar(20), NULL::boolean, NULL::int,
         n.max_channels, n.name::varchar(100), NULL::varchar(512), NULL::varchar(512), NULL::int
  FROM ivr_numbers n JOIN customers c ON c.id = n.customer_id
  LEFT JOIN call_flows f ON f.id = n.flow_id;
  ```
  Re-assert the existing grants. **Safety:** an old FS (pre-P2) never sees an `ivr` row until TED assigns the first IVR number (P4), and P2 deploys before that.
- **New view `ivr_fs_number`.** This is FreeSWITCH's **only** read path for IVR, with exactly one row per IVR DID:
  ```sql
  CREATE OR REPLACE VIEW ivr_fs_number AS
  SELECT n.did, n.id AS ivr_number_id, n.customer_id, n.max_channels,
         (n.enabled AND c.ivr_enabled AND c.status = 'active') AS enabled,
         f.id AS flow_id, v.version AS flow_version, v.plan::text AS plan_json
  FROM ivr_numbers n
  JOIN customers c ON c.id = n.customer_id
  LEFT JOIN call_flows f ON f.id = n.flow_id
  LEFT JOIN call_flow_versions v ON v.id = f.published_version_id;
  ```
  P1 confirms the `customers.status` value used elsewhere for "active" and keeps it consistent with the other arms' semantics.
- **`rate_cdr()`:** `product_type = 'ivr'` rates to **zero** and never debits, the same treatment as `voicemail` in 54. Re-declare the function byte-for-byte plus the branch.
- **Grants:**
  - `freeswitch`: SELECT on `ivr_fs_number` and `ivr_prompt_audio` **only**.
  - `api`: full DML on the new tables and sequences.
  - `grafana_ro`: nothing on the new tables. REVOKE from PUBLIC.

### 1.2 `60_cdr_ivr.sql` (P1)
- **New nullable columns on `cdrs`:**

  | Column | Type |
  |---|---|
  | `ivr_flow_id` | BIGINT |
  | `ivr_flow_version` | INT |
  | `ivr_exit` | VARCHAR(16) |
  | `ivr_path` | VARCHAR(512) |
  | `ivr_transfer_to` | VARCHAR(20) |
  | `ivr_seconds` | INT |

- **Ingest:** `routers/cdrs.py` maps the channel variables from §5 onto them on the A-leg row. Absent variables become NULL, and every other product is unchanged.

---

## 2. Draft graph JSON (UI ⇄ API; `call_flows.draft_graph`, `call_flow_versions.graph`)

```jsonc
{
  "schemaVersion": 1,
  "nodes": [ { "id": "n_<nanoid>", "type": "<NodeType>", "position": {"x": 0, "y": 0},
               "data": { "label": "optional display name", "config": { /* per type */ } } } ],
  "edges": [ { "id": "e_<nanoid>", "source": "<node id>", "sourceHandle": "<handle>", "target": "<node id>" } ],
  "viewport": { "x": 0, "y": 0, "zoom": 1 }        // optional
}
```

- **Ids:** `^[A-Za-z0-9_-]{1,40}$`.
- **Edges:** at most **one** edge per (`source`, `sourceHandle`), and no edge may target `entry`.
- **Unknown fields** are ignored by the server and preserved round-trip in the draft.

| `type` (UI label) | `config` | Out handles |
|---|---|---|
| `entry` (Start) | `{}` | `next` |
| `play` (Play message) | `{ "prompts": [promptId, …] }` (1–10) | `next` |
| `menu` (Menu) | `{ "prompts": [promptId…] (1–10), "digits": ["1","2",…] (subset of 0-9 * #, 1–12, unique), "timeoutSec": 5 (1–30), "retries": 2 (0–5), "invalidPrompts": [promptId…]?, "noInputPrompts": [promptId…]? }` | `d:<digit>` for each digit in `digits`, `noInput`, `noMatch` |
| `schedule` (Business hours) | `{ "tz": TZ, "weekly": { "mon": [["09:00","17:00"], …], …, "sun": [] }, "closedDates": ["YYYY-MM-DD", …] }` | `open`, `closed` |
| `condition` (Caller check) | `{ "mode": "prefix"\|"equals"\|"anonymous", "values": ["+1617", …] }` (values: 1–50; empty for anonymous) | `match`, `noMatch` |
| `dial` (Transfer) | `{ "target": {"kind":"own","did":"+1…"} \| {"kind":"external","number":"+1…"}, "passCallerId": true, "ringTimeoutSec": 30 (5–120) }` | `noAnswer` |
| `voicemail` (Voicemail) | `{ "did": "+1…" }` (one of the customer's voicemail DIDs) | — (terminal) |
| `goto` (Go to) | `{ "targetNodeId": "<node id>" }` | — |
| `hangup` (Hang up) | `{ "prompts": [promptId…]? }` | — |

- **`promptId`** = `ivr_prompts.id` (number), owned by the flow's customer and not deleted.
- **`TZ`** must be one of these. The list is pinned, and P2's `lib/schedule.lua` table must contain all of them:
  `America/New_York`, `America/Detroit`, `America/Chicago`, `America/Denver`, `America/Phoenix`, `America/Los_Angeles`, `America/Anchorage`, `Pacific/Honolulu`, `America/Puerto_Rico` (UTC−4, no DST).
- **Time ranges:**
  - `"HH:MM"` 24-hour, start < end, within one day. Use `"24:00"` as end-of-day.
  - Up to 4 ranges per day; overlaps are merged by the compiler.

---

## 3. Plan JSON (compiler output; `call_flow_versions.plan`; read by FreeSWITCH)

Only the **server** compiler (`services/ivr/compiler.py`) writes this. FreeSWITCH trusts nothing else.

```jsonc
{
  "v": 1,
  "compiler": "ivr-1",
  "flow_id": 12, "version": 3, "customer_id": 11,
  "start": "n_a1",
  "limits": { "max_steps": 200, "max_seconds": 1800 },
  "prompts": ["<sha256>", …],                     // every sha referenced below, deduped (prefetch list)
  "nodes": {
    "n_a1": { "t": "play",   "prompts": ["<sha>"], "next": "n_m1" },
    "n_m1": { "t": "menu",   "prompts": ["<sha>"], "digits": { "1": "n_x", "2": "n_y" },
              "timeout_ms": 5000, "retries": 2,
              "invalid_prompts": ["<sha>"], "noinput_prompts": ["<sha>"],
              "on_noinput": "n_z", "on_nomatch": "n_z" },
    "n_h1": { "t": "hours",  "tz": "America/New_York",
              "weekly": { "mon": [[540, 1020]], …, "sun": [] },   // minutes since local midnight, [start,end)
              "closed_dates": ["2026-12-25"], "open": "n_a1", "closed": "n_c1" },
    "n_c1": { "t": "caller", "mode": "prefix", "values": ["+1617"], "match": "n_x", "nomatch": "n_y" },
    "n_x":  { "t": "transfer",
              "dest": { "kind": "external", "e164": "+1…" }
                    | { "kind": "own", "did": "+1…", "product": "rcf"|"voicemail"|"ivr"|"trunk" },
              "pass_caller_id": true, "ring_timeout": 30, "on_noanswer": "n_vm" },
    "n_vm": { "t": "voicemail", "did": "+1…" },
    "n_z":  { "t": "hangup", "prompts": ["<sha>"] }
  }
}
```

- **Every value is pre-validated.**
  - Node ids match `^[A-Za-z0-9_-]{1,40}$`.
  - Digits match `^[0-9*#]$`.
  - Each sha is `^[0-9a-f]{64}$` and exists in `ivr_prompt_audio`.
  - Every E.164 passes §6.
  - Every `next`/branch value is a node id in `nodes`, or `null`, which means hang up (no prompt).
- **`goto` is compiled away.** Pointers aim at the target directly, and cycles are allowed. At runtime, `max_steps` counts node entries, and exceeding it gives `ivr_exit=limit`.
- **No customer free text appears anywhere in the plan.** Labels and names stay in `graph`.
- **Menu semantics, as FS implements them** (`play_and_get_digits`, barge-in):
  1. Play the prompts and wait `timeout_ms` for 1 digit.
  2. On no input, play `noinput_prompts` (if any) and retry. On a digit not in `digits`, play `invalid_prompts` (if any) and retry.
  3. After `retries` re-prompts are exhausted, go to `on_noinput` or `on_nomatch`, according to the **last** failure type.
- **Transfer semantics:**
  - **`external`:** the RCF egress path with `forward_to = e164`. Covers the US rule (§6), the SBC×carrier loop, STIR, B-leg CDR, and `pass_caller_id` (false ⇒ From = the IVR DID).
  - **`own`:** the on-net resolver from the dialed DID (an RCF chain, a voicemail DID → `terminate_vvm`, an IVR DID → another IVR with the hop limit, a trunk DID → trunk delivery).
  - **No answer:** if the far end doesn't answer within `ring_timeout`, or every attempt fails or is busy, the call continues at `on_noanswer`. When that is `null`, the call hangs up.
  - **Answered:** when the transfer is answered and later ends, the call ends.
- **Voicemail:** equivalent to `transfer` `own` with `product: "voicemail"` and no `on_noanswer`.

---

## 4. Prompt audio

- **Format:** canonical RIFF/WAVE, `fmt ` PCM (1), 1 channel, 8000 Hz, 16-bit, a single `data` chunk. `sha256` is computed over the **exact stored bytes**.
- **Limits:** ≤ 120 s per prompt (≈ 1.92 MB). Per customer: ≤ 100 live prompts and ≤ 50 MB of distinct audio.
- **TTS:** rendered by the `tts` sidecar (P1, §8.1), then resampled and written to that exact format by the API, so the sha is deterministic for the same input. The cache key is `sha256(f"{engine_version}|{voice}|{text}")` → lookup.
- **Uploads and recordings:** the browser sends PCM16 WAV, via the voicemail recorder/transcoder pipeline (`pages/voicemail/audio/*`). The API re-validates and rewrites the canonical header, and rejects any other format with 422.
- **FS cache** (P2, `lib/ivr_prompts.lua`):
  - **Path:** `/var/lib/crag/ivr-prompts/<sha256>.wav` (volume `ivr_prompts`, §7).
  - **On a miss:**
    1. `SELECT encode(wav,'hex') FROM ivr_prompt_audio WHERE sha256 = $1` on the **local replica**.
    2. Hex-decode it.
    3. Verify the sha256 and the header.
    4. Write `<sha>.tmp.<uuid>` and `rename`.
  - **Prefetch:** all `plan.prompts` are fetched **before answer**.
  - **On any failure**, the call plays the system `sounds/ivr/technical_difficulty.wav`, hangs up, and sets `ivr_exit=error`.
- **System prompts** ship in the repo at `docker/freeswitch/scripts/sounds/ivr/` (P2), as 8 kHz WAV:
  - `technical_difficulty.wav` ("We're sorry, we're experiencing technical difficulties. Please try again later. Goodbye.")
  - `goodbye.wav`

---

## 5. FreeSWITCH call path + CDR variables (P2)

### 5.1 Gate
`IVR_ENABLED` (env, media VMs) is on only if exactly `true` (case-insensitive, trimmed); the default is off. It is parsed like `API_CALLING_ENABLED` (`inbound_router.lua:151-174`).
- **Off:** an IVR DID, direct or as an on-net terminal, gets `CALL_REJECTED` (603) with `lua_routed=true`. There is never a carrier hairpin.
- **On:** `TERMINATORS.ivr = terminate_ivr`.

### 5.2 Lookup
`db_client.lookup_ivr_did(did)` reads `ivr_fs_number` once, at call start.
- **No row:** "not ours".
- **`enabled = false` or `plan_json IS NULL`:** 603.

### 5.3 Media
`lib/media_leg.lua`:
- **Exports:** `M.prepare(session)`, which sets `rtp_timer_name=soft` and `jitterbuffer_msec=60:200` **before** `answer`. These are the same values as `vm_box.lua`.
- **Scope:** only `terminate_ivr` calls it.

### 5.4 Concurrency
`limit hash ivr <did> <max_channels>`. When over the limit, the call gets 486 Busy with `ivr_exit=limit`.

### 5.5 Channel variables → `cdrs` columns (A-leg)
| Variable | Value |
|---|---|
| `product_type` | `ivr` |
| `customer_id` | IVR owner |
| `ivr_flow_id` / `ivr_flow_version` | from `ivr_fs_number` |
| `ivr_exit` | `transfer` \| `voicemail` \| `hangup` \| `caller_hangup` \| `timeout` \| `error` \| `limit` |
| `ivr_path` | `>`-joined node ids and choices, e.g. `n_a1>n_m1:1>n_x`, truncated at 512 with a trailing `…` |
| `ivr_transfer_to` | E.164 of the last transfer target (external or own DID), if any |
| `ivr_seconds` | integer seconds from answer to the transfer start, or to the end |

- **Transfer B-legs:** these use the existing leg-split variables (`cdr_*`), with `cdr_product_type=ivr`.
- **Rating:** `rate_cdr()` rates them to zero (§1.1).

### 5.6 Budgets
- `max_steps` and `max_seconds` from the plan.
- A transfer counts once.
- Exceeding either budget plays `goodbye.wav`, then hangs up with `ivr_exit=limit`.

---

## 6. Dial policy (P1 enforces at publish; P2 re-checks E.164 shape at call time)

**External target (D4, US only):**
- **Shape:** `^\+1[2-9]\d{2}[2-9]\d{6}$` (+1 NANP).
- **Allowed:**
  - the 50 states and DC
  - US territories (PR 787/939, USVI 340, Guam 671, CNMI 670, AS 684)
  - US toll-free 8YY (800/833/844/855/866/877/888)
- **Blocked:**
  - Canadian NPAs and Caribbean/other non-US NANP NPAs
  - 900, 976, N11 and 555-01xx
  - anything else
- **Source:** P1 pins the NPA tables in `services/ivr/policy.py` with a dated source comment.
- **Own target:** `did` must be in the customer's **current** numbers (`services/customer_numbers.py`), with `product` ∈ {`rcf`,`voicemail`,`ivr`,`trunk`}, at publish time.
  - **At call time:** the on-net resolver's own enabled/ownership semantics apply. If ownership changed since publish, the call is hard-rejected the same way as a disabled terminal.
  - **Self-transfer:** an IVR transferring to its **own** DID is a compile error.
- **Caller ID:** `passCallerId` is boolean only. **No** custom caller ID exists.

---

## 7. `docker-compose.media.yml` (P2V edits on behalf of P2 and P2V)

**`freeswitch` service:**
- **Environment:** add `IVR_ENABLED=${IVR_ENABLED:-false}`.
- **Volumes:** add `ivr_prompts:/var/lib/crag/ivr-prompts` (P2) and `vm_spool:/var/lib/crag/vm-spool` (P2V).

**New `vm-forwarder` service (P2V):**
- `build: ./docker/vm-forwarder`
- `network_mode: host`
- `restart: unless-stopped`
- **Mounts:** `vm_spool:/var/lib/crag/vm-spool` plus the existing ingest header file, read-only.
- **Environment:** `API_HOST`/`API_PORT`, the same as FS.

**Top-level `volumes:`** add `ivr_prompts` and `vm_spool`.

Recreating the FS container mounts the new volumes; this is a one-time owner deploy step.

---

## 8. HTTP APIs

All paths are under `/v1`. JSON request and response bodies use snake_case. Errors are `{"detail": …}`.

### 8.1 TTS sidecar (P1, internal only)
- **Request:** `POST http://tts:5000/synthesize` with body `{ "text": str (≤ 1000 chars), "voice": str }`.
- **Responses:**
  - `200 audio/wav` (any rate; the API resamples)
  - `400`
  - `503`
- **`GET /voices`** returns `[{ "id": "en_US-…", "label": "…", "gender": "female"|"male", "license": "…" }]`.
- **Network:** no published port; reached on `services-network` only.

### 8.2 Customer IVR API (P1 serves, P3 consumes)

**Scope:** tenant-scoped like voicemail's `vm_scope`.
- `readonly` users can GET only.
- **Admins** pass `?customer_id=` and may act on any customer's resources.
- **An admin with `customer_id = null` and no `?customer_id=`** gets **400 `customer_id required`**. The UI shows the `PreviewPrompt` instead.

**Entitlement gate:** every route except `GET /ivr/summary` returns **403 `ivr_not_enabled`** when the customer isn't entitled.

**Endpoints:**
- `GET /ivr/summary` → `{ enabled: bool, numbers: IvrNumber[], flows: FlowSummary[], limits: {...} }`
- **Flows:**
  - `GET /ivr/flows` → `FlowSummary[]`
  - `POST /ivr/flows` `{ name, draft_graph? }` → `Flow` (201). It is seeded with an `entry` node if `draft_graph` is omitted.
  - `GET /ivr/flows/{id}` → `Flow`
  - `PUT /ivr/flows/{id}` `{ name?, draft_graph?, revision }` → `Flow`. A stale `revision` gives **409** `{detail:"stale_revision", current_revision}`.
  - `DELETE /ivr/flows/{id}` → 204. If any `ivr_numbers.flow_id` references it, the response is **409** `flow_in_use`.
  - `POST /ivr/flows/{id}/validate` `{ draft_graph? }` → `{ ok: bool, errors: Issue[], warnings: Issue[] }`. `draft_graph` defaults to the stored draft.
  - `POST /ivr/flows/{id}/publish` `{ revision }` → `{ version, published_at, plan_summary }`. It compiles the stored draft at that `revision`. On errors it returns **422** `{ detail:"invalid_flow", errors: Issue[] }`.
  - `GET /ivr/flows/{id}/versions` → `[{ version, published_at, published_by_email? }]`
  - `GET /ivr/flows/{id}/versions/{v}` → `{ version, graph, published_at }`
  - `POST /ivr/flows/{id}/versions/{v}/restore` `{ revision }` → `Flow`. It copies the graph into the draft and does not publish.
  - `POST /ivr/flows/{id}/simulate` `{ draft_graph?, caller: "+1…"|"anonymous", at: ISO8601, digits: ["1","9",…] }` → `{ steps: SimStep[], outcome }`. Each `SimStep` is `{ node_id, kind, says: [promptName…], note }`.
- **Numbers:**
  - `GET /ivr/numbers` → `IvrNumber[]`
  - `PUT /ivr/numbers/{id}` `{ name?, flow_id? }` → `IvrNumber`. The flow must belong to the same customer.
- **Destinations:**
  - `GET /ivr/destinations` → `{ groups: [{ product: "rcf"|"voicemail"|"ivr"|"trunk", label, numbers: [{ did, name, enabled, detail }] }] }`
  - `detail` is human text, e.g. "Forwards to +1 774-404-5256", "Mailbox: Front desk" or "IVR: Main line".
  - The source is `customer_numbers`.
- **Prompts:**
  - `GET /ivr/prompts` → `Prompt[]`
  - `POST /ivr/prompts/tts` `{ name, text, voice }` → `Prompt` (201)
  - `POST /ivr/prompts/upload` (`multipart`: `name`, `file` WAV) → `Prompt` (201)
  - `PATCH /ivr/prompts/{id}` `{ name }`
  - `DELETE /ivr/prompts/{id}` → 204. A prompt used by any **draft** gives **409** `prompt_in_use` `{flows:[…]}`. A prompt used only by old versions is soft-deleted and its audio is kept.
  - `POST /ivr/prompts/tts-preview` `{ text, voice }` → `audio/wav`. Not stored. Rate-limited to 30/min per user.
  - `POST /ivr/prompts/{id}/playback-token` → `{ url }`. The URL is short-TTL and signed like voicemail greetings; `GET` returns `audio/wav`.
- **Voices:** `GET /ivr/voices` → the sidecar's voice list (cached).

**Shapes:**

| Shape | Fields |
|---|---|
| `IvrNumber` | `{ id, did, name, flow_id, flow_name, enabled, max_channels, published: bool }` |
| `FlowSummary` | `{ id, name, revision, published_version, published_at, updated_at, numbers: [did…] }` |
| `Flow` | `FlowSummary` + `{ draft_graph }` |
| `Prompt` | `{ id, name, kind, tts_text?, tts_voice?, duration_ms, bytes, created_at }` |
| `Issue` | `{ code, message, node_id?, handle? }` (`message` is customer-readable English) |

### 8.3 Admin API for TED (P1 serves, P4 consumes; `require_admin`)
- `GET /ivr/admin/customers/{customer_id}` → `{ ivr_enabled, numbers: IvrNumber[], flows: FlowSummary[] }`
- `PUT /ivr/admin/customers/{customer_id}/entitlement` `{ enabled: bool }` → `{ ivr_enabled }`. Turning it off makes every number 603 at FS (via `number_routing` / `ivr_fs_number`); data is kept.
- `PUT /ivr/admin/numbers/{id}` `{ enabled?, max_channels?, name? }` → `IvrNumber` (the kill switch)
- `GET /ivr/admin/flows/{id}/versions` and `GET /ivr/admin/flows/{id}/versions/{v}`: read-only.
- `GET /ivr/admin/overview` → `{ customers: [{ customer_id, name, status, ivr_enabled, flows_total, flows_published, numbers_bound, last_published_at }] }` — the CRAG admin "All customers" view (added 2026-10-27, additive): every customer with `ivr_enabled` OR ≥ 1 flow, sorted by name case-insensitively. `flows_published` = flows with `published_version_id` set; `numbers_bound` = `ivr_numbers` with `flow_id` set (any state); `last_published_at` = newest live version's `published_at` (ISO) or null.
- **Inventory:** the existing `POST /v1/numbers/assign` (`number_inventory.py`) gains `product_type: "ivr"` with an optional `name`.
  - It creates an `ivr_numbers` row, sets `did_inventory` to assigned with `product_type='ivr'`, and sets `customers.ivr_enabled=true` if it was false. That is the same side-effect rule as voicemail at `:914`.
  - Unassign removes the `ivr_numbers` row and frees the DID.
  - Both are allowed only when the DID isn't in `number_routing` under another product.
- **Onboarding:** `onboarding.py` products accept `"ivr"`, with `{ "ivr": { "number_count": 1-20, "notes": str? } }`, and `form_version` becomes `products-v2`. `products-v1` is still accepted.

### 8.4 Voicemail resilience API (P2V)
- **`POST /v1/voicemail/fs/deposit-sealed`**, with `require_ingest_secret` (the same header file as the current deposit).
  - **Body:** `application/octet-stream`, the CMS (DER) blob.
  - **Headers:** `X-VM-Meta`, which is base64url JSON `{ msg_uuid, mailbox_id, did, caller_number, caller_name?, received_at (ISO8601 UTC), duration_ms, zone }`.
  - **Responses:**
    - `201 stored`
    - `200 duplicate`, idempotent on `msg_uuid`
    - `410 dropped`: the mailbox was deleted or is no longer accepting. This is audited.
    - `422 bad_blob`: permanent. The forwarder moves the file to `rejected/`.
    - `503`: retry.
  - **Unsealing:** in memory, with the spool private key. The message then goes through the **existing** deposit pipeline, with `received_at` preserved.
- **The spool private key:** the PEM in env `VOICEMAIL_SPOOL_PRIVATE_KEY_B64` (base64 of PEM; ≥ 3072-bit RSA). This is P2V's single env line in `docker-compose.services.yml`, placed directly after `INGEST_SHARED_SECRET`.
  - **Unset:** `deposit-sealed` returns 503, and the forwarder keeps retrying, so nothing is lost.
  - **Public certificate(s):** on media VMs, via `/opt/revup/secrets/fs-voicemail/vm_spool_recipients.pem` (one or more certificates, for rotation). This is in the same secrets directory already mounted for `vm_ingest.header`, and P2V confirms the mount path.
- **The `vm_fs_mailbox` view** (in `58_vm_outage_resilience.sql`): `mailbox_id, did, customer_id, status, accepting, max_message_seconds`.
  - `accepting` is computed with the **same** rules as `GET /fs/mailbox/{id}` (caps from `services/voicemail/limits.py`, mirrored in SQL).
  - Grant: `freeswitch` SELECT only.

---

## 9. Verification hooks every build must expose
- **P1:**
  - `pytest` green.
  - Compiler golden fixtures in `tests/fixtures/ivr/*.json` (pytest lives at the repo-root `tests/`, P1 owns `tests/test_ivr_*.py` + `tests/fixtures/ivr/**`): graph → plan. P2's engine harness consumes the **same** plan fixtures.
- **P2:**
  - A Lua harness `tests/lua/ivr_engine_harness.lua` (house style: see `tests/lua/voicemail_harness.lua`, `onnet_router_harness.lua`; local `lua` is 5.5, prod is 5.3, so avoid 5.4+ features) with a fake session.
  - The RCF egress byte-identity harness.
  - The guard test: no non-validated string reaches `session:execute`.
- **P2V:**
  - Local end-to-end: API down → seal → API up → delivered, with original time.
  - A no-plaintext-on-disk scan.
  - Idempotent replay.
- **P3:** `tsc -b`, `vite build`, eslint, `check-theme-tokens --literals` = 0, and theme-harness shots in both themes at 1440 and 390 for admin, admin-preview, tenant and readonly.
- **P4:** the TED test suites from its AGENTS.md, with the catalog counts updated.

---

## Changes
- 2026-10-25: initial pin (orchestrator).
- 2026-10-25 (orchestrator, from P4 TED; applied by P1):
  - **Assign route path.** §8.3's "POST /v1/numbers/assign" means the EXISTING `POST /v1/numbers/{did}/assign` and `POST /v1/numbers/{did}/unassign` in `number_inventory.py`; they gain `product_type: "ivr"` (+ optional `name`). No new route.
  - **Clearing a number's name.** `PUT /v1/ivr/admin/numbers/{id}` accepts `"name": null` to clear the name; an absent `name` leaves it unchanged (`model_fields_set`). The customer `PUT /v1/ivr/numbers/{id}` behaves the same way.
  - **Voicemail assign body unchanged.** Voicemail assignment keeps `label`; only `ivr` assignment uses `name`.
- 2026-10-25 (P1 as built — deviations / additions, all additive):
  - **`number_routing` ivr arm** casts `n.id::int AS product_ref_id`: `ivr_numbers.id` is BIGSERIAL but the view column is INT (22's rcf arm), and `CREATE OR REPLACE VIEW` refuses a type change.
  - **Extra guards in 59:** `ivr_numbers_did_e164_chk`; composite FKs `ivr_numbers (flow_id, customer_id) → call_flows (id, customer_id) ON DELETE SET NULL (flow_id)` (a number can only bind its own customer's flow) and `call_flows (published_version_id, id) → call_flow_versions (id, flow_id)` (a flow publishes only its own version), with the UNIQUE targets they need; a BEFORE UPDATE trigger makes `call_flow_versions` immutable; `ivr_prompts.sha256 REFERENCES ivr_prompt_audio`; sha / size / tts-field CHECKs. 59 refuses to run without 54.
  - **CDR ingest (§1.2):** the `ivr_*` vars land on the A-leg row via ONE guarded `UPDATE … WHERE uuid AND start_time` after the INSERT, only when an `ivr_*` var is present (other products: no extra statement; the 73-param INSERT is untouched). The six columns are appended to the CDR export.
  - **readonly** may also POST `validate`, `simulate` and `playback-token` (they change nothing; voicemail lets readonly mint playback tokens too). Every other write is 403.
  - **Bodies:** `flow_in_use` carries `numbers: [did…]`; `invalid_flow` also carries `warnings`; a draft write without exactly one Start (or malformed ids / > 200 blocks / > 512 KB) is 422 `invalid_graph` + `errors`. `playback-token` returns `{url, expires_in}`. `simulate` → `outcome` is one of `transfer | voicemail | hangup | limit`. `plan_summary` = `{blocks, prompts, by_type, destinations, warnings}`.
  - **Limits:** `limits` (summary) also has `max_flows` (100 flows per customer, enforced on create) and `tts_preview_per_minute`. Uploads: optional multipart `kind` (`upload` default | `recording`); any PCM16 WAV 8-48 kHz mono/stereo is canonicalised.
  - **TTS:** the sidecar's `/voices` items also carry `version` (engine + model hash) — the render cache key's `engine_version`; `GET /v1/ivr/voices` strips it. Piper renders are not bit-identical run to run (VITS noise): determinism holds WAV → canonical bytes, and the render cache maps repeat text to the first render's audio.
  - **Playback** tokens reuse `VOICEMAIL_PLAYBACK_SECRET` (new kind `ivr_prompt`, so they can never play voicemail).
  - **Admin scope:** an admin JWT that carries its own `customer_id` acts on it when `?customer_id=` is absent; only `customer_id = null` + no param is the 400.
  - **`customer_numbers.PRECEDENCE`** = `rcf, api, trunk, voicemail, ivr` — assumes P2's STEP-1 lookup puts ivr last (it only matters for a DID in two product tables, which the assign drift guard prevents).
  - **Onboarding:** a client may echo `form_version` (`products-v1` + `ivr` → 422); the server always stamps `products-v2`.
