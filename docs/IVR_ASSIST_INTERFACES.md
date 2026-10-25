# Visual IVR Flow Assistant — Interface Contract (pinned 2026-10-25)

The **Flow assistant** lets a customer describe a call flow in plain English and see it drawn in
the Visual IVR builder for them to confirm. CRAG owns the builder, the validation and every write.
**TED** owns the single AI step, using the model provider and rules TED already runs; CRAG never
talks to a model directly. This is the first time CRAG calls TED (until now only TED called CRAG).

This contract binds four builds. Where a build needs something it does not say, the build stops
and asks; it does not invent a shape. The JSON Schemas in `docs/ivr_assist/` are normative and
are copied byte-for-byte into TED.

**This repository is public.** Nothing here, in code comments, in tests or in commit messages may
name TED's hostnames, its secret names, its cloud project, or the model vendor. TED's internals
(settings, secret, metering, ledger, prompt) are in TED's own ADR.

## 0. Ownership

| Build | Repo / branch | Owns |
|---|---|---|
| **A — CRAG backend** | `Keegs2/custom-voip` `feat/ivr-assist-backend` | migration `61_ivr_assist.sql`; `docker/api/src/services/ivr/assist/*`; the assist routes (§5); the `simulate` and admin-entitlement extensions; config + compose env; the eval runner and cases (§9); tests; API/postgres docs |
| **B — CRAG portal** | `Keegs2/custom-voip` `feat/ivr-assist-portal` | the builder's Flow assistant panel, keyword guide, proposal preview and accept flow (§7); `docker/ui/*` only |
| **C — TED assist** | `grteng/ted-next` `feat/crag-ivr-assist` | the TED endpoint (§1–§4), the reviewed prompt, metering, caps, ledger, scripted provider, ADR |
| **D — TED admin** | `grteng/ted-next` `feat/crag-ivr-assist-admin` | the per-customer opt-in toggle in CRAG Admin Customer 360 (§8) |

Nobody edits another build's files. Shared files (root `CLAUDE.md`, this contract, the schemas)
change only through the integrator.

## 1. Wire: CRAG → TED

```
POST {TED_BASE_URL}/api/triggers/crag/ivr-assist
X-TED-Trigger-Token: <the CRAG assist token>
Content-Type: application/json
User-Agent: crag-ivr-assist/1
X-Request-Id: <request_id>

{"v": 1, "payload_b64": "<base64url, no padding, of the UTF-8 JSON request (§2)>"}
```

- **Why `/api/triggers/`:** TED's edge sends only `/api/triggers/*` (and carrier webhooks) to its
  backend, and exempts Trigger POSTs from its geography rule. No edge change is needed.
- **The token is dedicated to this endpoint.** TED compares it (constant time) with its own assist
  secret, never with any other Trigger's token. CRAG holds it as `TED_IVR_ASSIST_TOKEN`.
- **Why base64url:** TED's edge runs OWASP WAF rules over JSON request bodies. Customer text
  ("press 1 or 2", quotes, `<`, "drop the call") would trip them and return false 403s. One opaque
  base64url field keeps the WAF on without inspecting customer prose. TED decodes it and treats the
  result as untrusted data. Encoded body ≤ 256 KiB (else TED returns 413).
- **Response:** plain JSON (responses are not WAF-inspected), `Cache-Control: no-store`.
- **Timeouts:** TED bounds each model call at ≤ 40 s and the whole request at ≤ 55 s. CRAG's HTTP
  timeout per call is 60 s.
- **Idempotency:** a repeated `request_id` with the same payload within 24 h returns the stored
  response without a new model call. The same `request_id` with a different payload is 409.

### 1.1 Status codes

| HTTP | `error` | Meaning | CRAG does |
|---|---|---|---|
| 200 | — | §3 response | continue |
| 400 | `bad_request` | undecodable payload or schema failure (a CRAG bug) | job fails `assistant_failed` |
| 401 | `unauthorized` | token missing / wrong / TED has none configured | job fails `assistant_unavailable`; log ERROR |
| 409 | `request_id_reused` | same id, different payload | job fails `assistant_failed` |
| 413 | `too_large` | encoded body > 256 KiB | job fails `assistant_failed` |
| 429 | `budget_exhausted` / `busy` | TED's daily cap spent / its concurrency limit | job fails `assistant_busy` (`retry_after_s` passed through) |
| 502 | `model_no_result` | two model attempts without one valid result | job fails `assistant_failed` |
| 503 | `disabled` / `model_unavailable` | feature off in TED / model error or timeout | job fails `assistant_unavailable` |

Error bodies are `{"error": "<code>", "message": "<operator-readable>", "retry_after_s": <int>?}`.
CRAG never shows TED's `message` to a customer; it shows its own text for the job error code (§5.3).

## 2. Request (the decoded `payload_b64`)

Normative schema: `docs/ivr_assist/assist_request.schema.json`. `base` and every graph inside are
**alias graphs** (§4, `alias_graph.schema.json`), validated separately.

```jsonc
{
  "v": 1,
  "request_id": "6f1c…",            // UUIDv4, one per TED call
  "conversation_id": "a93e…",       // UUIDv4, one per builder conversation (≤ 24 h)
  "round": "propose",               // "propose" | "repair"
  "message": "Weekdays 8 to 5 Eastern. Press 1 for billing [D1], 2 to report an outage. After hours send them to voicemail.",
  "history": [                      // ≤ 10 earlier turns of THIS conversation, oldest first
    { "role": "customer",  "text": "…" },
    { "role": "assistant", "text": "…" }   // the earlier summary / question / refusal text
  ],
  "base": null,                     // the graph being changed: the current draft, or the proposal being refined
  "base_new_prompts": [],           // the NP prompts `base` references (refining an unaccepted proposal)
  "destinations": [                 // the customer's numbers as aliases — NEVER a phone number
    { "alias": "D1", "product": "rcf",       "label": "Billing line",       "enabled": true, "this_flow": false },
    { "alias": "D2", "product": "voicemail", "label": "Front desk mailbox", "enabled": true, "this_flow": false },
    { "alias": "D3", "product": "ivr",       "label": "Main line",          "enabled": true, "this_flow": true }
  ],
  "prompts": [                      // the customer's existing messages
    { "alias": "P1", "name": "Main greeting", "text": "Thanks for calling Acme Power." },
    { "alias": "P2", "name": "Holiday notice", "text": null }   // uploaded audio: no text
  ],
  "external_numbers": ["N1"],       // aliases for numbers the customer typed that are not theirs
  "repair": null,                   // round "repair": { "issues": [ { "code", "message", "node_id"? } ] }
  "limits": { "max_nodes": 60, "max_new_prompts": 20, "max_prompt_chars": 1000 }
}
```

Rules:
- **No phone numbers, no customer identity.** CRAG replaces every phone number in every text it
  sends (message, history, labels, prompt names/texts, node labels) with an alias token (§4.1).
  `label` is the number's name (`customer_numbers.name`) or, without one, a neutral product phrase
  ("Forwarding number 1", "Mailbox 2"). No customer id, name, email or DID reaches TED.
- **`this_flow: true`** marks the IVR numbers bound to this flow. A transfer there would loop; the
  model must not use them.
- **`round: "repair"`** re-sends the same `message`, `history`, `destinations`, `prompts` and
  `external_numbers`, with `base` = the proposal that failed, `base_new_prompts` = its new prompts,
  and `repair.issues` = CRAG's compiler errors (messages aliased like everything else).
- **`base`** is the alias form of the current draft (positions dropped) for a new request, the
  stored proposal when the customer refines one they have not accepted, or `null` when the draft
  is only the seeded Start block.

## 3. Response (200)

Normative schema: `docs/ivr_assist/assist_response.schema.json`.

```jsonc
{
  "v": 1,
  "request_id": "6f1c…",
  "result": {
    "kind": "proposal",               // "proposal" | "clarify" | "cannot_build"
    "graph": { /* alias graph, §4 */ },
    "new_prompts": [ { "key": "NP1", "name": "Main menu", "text": "For billing, press 1. To report an outage, press 2." } ],
    "summary": "Callers hear a greeting, then the main menu. During business hours, 1 goes to [D1] …",
    "assumptions": ["You didn't give an outage number, so 2 goes to [D2]. Tell me if that should be another number."]
  },
  // or { "kind": "clarify", "question": "Which number should 'billing' ring: [D1] or [D4]?" }
  // or { "kind": "cannot_build", "message": "I can only build call menus, business hours, transfers and voicemail …" }
  "meta": { "model": "…", "prompt_version": "crag-ivr-assist/1", "attempts": 1, "input_tokens": 1834, "output_tokens": 912 }
}
```

**TED returns a proposal only after these checks pass** (else it retries the model once with the
reasons, then answers 502 `model_no_result`):
1. `graph` validates against `alias_graph.schema.json`.
2. Exactly one `entry` node; node ids unique; every edge's `source`/`target` exists; at most one
   edge per (`source`, `sourceHandle`); no edge targets the `entry` node; every `sourceHandle` is
   one the node's type has (§4.2), and `d:<x>` only for an `x` in that menu's `digits`.
3. Per-type required config (§4.2) present; config keys that the type does not use are absent.
4. Every `P…` ref is in the request's `prompts`; every `NP…` ref is a `new_prompts` key; keys are
   unique; an unreferenced new prompt is dropped.
5. `target.kind: "own"` uses a `D…` that is `enabled` and not `this_flow`; `kind: "external"` uses
   an `N…` from `external_numbers`; `mailbox` is a `D…` whose `product` is `voicemail`;
   `condition` `values` are `+1` area-code prefixes for `prefix` and `N…` for `equals`.
6. Within `limits`; each new prompt's `text` ≤ `max_prompt_chars`.
7. Free text (`summary`, `assumptions`, `question`, `message`, new prompt `name`/`text`) refers to
   numbers and messages only by alias token; any run of 7+ digits is replaced by `[number removed]`.

CRAG still runs its own full compiler on the result; TED's checks only keep obviously broken
output from reaching it.

## 4. Alias graph

Normative schema: `docs/ivr_assist/alias_graph.schema.json`. It is the builder's draft graph
(`IVR_INTERFACES.md` §2) with these changes, so a model never sees an id, a DID or a position:

| §2 draft graph | Alias graph |
|---|---|
| `position`, `viewport`, edge `id`, `data` wrapper | absent; `label` and `config` sit on the node |
| prompt ids (numbers) | `"P<n>"` (existing) or `"NP<n>"` (new, from `new_prompts`) |
| dial `target: {kind:"own", did}` / `{kind:"external", number}` | `target: {kind:"own", ref:"D<n>"}` / `{kind:"external", ref:"N<n>"}` |
| voicemail `config.did` | `config.mailbox: "D<n>"` |
| schedule `weekly.mon: [["09:00","17:00"]]` | `weekly.mon: [{"start":"09:00","end":"17:00"}]` |
| condition `values: ["+16175550100"]` (equals) | `values: ["N<n>"]` |

### 4.1 Alias tokens in free text

In prose fields (message, history, labels, prompt text, summary, assumptions, question) aliases
appear as bracketed tokens matching `\[(D|N|P|NP)[1-9][0-9]{0,2}\]`, e.g. `[D1]`, `[N2]`.

- **Numbers CRAG finds:** CRAG detects NANP numbers in any common form (`+1 617 555 0100`,
  `(617) 555-0100`, `617.555.0100`, `16175550100`, `6175550100`). One of the customer's own DIDs
  becomes its `[D<n>]`. Any other becomes a fresh `[N<n>]` (≤ 20 per conversation, stable within
  it). Any remaining run of 7+ digits becomes `[number removed]`.
- **Rendering for the customer** (CRAG, §5.2): `[D<n>]` → `Billing line (617-555-0100)`;
  `[N<n>]` → `617-555-0100`; `[P<n>]` / `[NP<n>]` → the message name in quotes. In a new
  message's spoken `text`, `[D<n>]` / `[N<n>]` become the plain number `617-555-0100`, and
  `[P…]` / `[NP…]` tokens are removed.

### 4.2 Node types (the only verbs)

| `type` (builder label) | Required `config` | Optional `config` | Exits (`sourceHandle`) |
|---|---|---|---|
| `entry` (Start) | — (`{}`) | — | `next` |
| `play` (Play message) | `prompts` | — | `next` |
| `menu` (Menu) | `prompts`, `digits` | `timeoutSec` (1–30, default 5), `retries` (0–5, default 2), `invalidPrompts`, `noInputPrompts` | `d:<digit>` per digit, `noInput`, `noMatch` |
| `schedule` (Business hours) | `tz`, `weekly` | `closedDates` | `open`, `closed` |
| `condition` (Caller check) | `mode`; `values` unless `mode` is `anonymous` | — | `match`, `noMatch` |
| `dial` (Transfer) | `target` | `passCallerId` (default `true`), `ringTimeoutSec` (5–120, default 30) | `noAnswer` |
| `voicemail` (Voicemail) | `mailbox` | — | — (ends the call) |
| `goto` (Go to) | `targetNodeId` | — | — (jumps) |
| `hangup` (Hang up) | — | `prompts` (said before hanging up) | — |

An exit with no edge ends the call there, as in the builder.

## 5. CRAG customer API (Build A serves, Build B consumes)

Same prefix, tenancy and errors as the Visual IVR customer API (`IVR_INTERFACES.md` §8.2):
`ivr_scope` / `ivr_writer`, admin `?customer_id=`, an admin with `customer_id = null` and no
`?customer_id=` gets 400, 403 `ivr_not_enabled` when not entitled.

- **`GET /ivr/summary`** gains `assist: { available: bool }`. `available` = `IVR_ASSIST_ENABLED`
  AND `customers.ivr_assist_enabled` AND `TED_BASE_URL` + `TED_IVR_ASSIST_TOKEN` set. The reason
  is never shown to customers.
- **`POST /ivr/flows/{id}/assist`** (writer) `{ message, conversation_id?, refine_job_id?, draft_graph? }`
  → **202** `{ job_id, conversation_id }`.
  - `message`: 1–2000 characters. `conversation_id`: continue a conversation (same flow, same
    customer, < 24 h old) or omit to start one. `refine_job_id`: refine that job's unaccepted
    proposal (it becomes `base`). Else `draft_graph` (the builder's current in-memory draft, §2
    shape, ≤ the draft size limits) becomes `base`; else the stored draft does.
  - Errors: 403 `ivr_assist_not_enabled` (not `available`); 409 `assist_busy` (a job for this flow
    is running); 429 `assist_rate_limited` `{retry_after_s}` (6 jobs a minute per user);
    429 `assist_daily_limit` (`IVR_ASSIST_DAILY_PER_CUSTOMER` jobs per customer per UTC day,
    default 40); 404 for another tenant's flow or job.
- **`GET /ivr/flows/{id}/assist/{job_id}`** → `{ job_id, conversation_id, status, elapsed_ms, result?, error? }`
  - `status`: `running` | `done` | `failed`. A job still `running` after 300 s reads as `failed`
    `assistant_failed` (the worker died).
  - `result` (when `done`) is one of the shapes in §5.2. `error` (when `failed`) is
    `{ code, message }` with CRAG's customer text (§5.3).
- **`POST /ivr/flows/{id}/assist/{job_id}/outcome`** (writer) `{ outcome: "accepted" | "discarded" }` → 204.
  Recorded once; a later different outcome is 409.
- **`POST /ivr/flows/{id}/simulate`** gains optional `assist_job_id`. When present, `draft_graph` is
  ignored and that job's proposal is simulated, its new messages standing in as prompts by name.

### 5.1 The job (server side)

One job = one customer message. The worker runs in the API process (an `asyncio` task holding a
strong reference) and keeps all state in `ivr_assist_jobs`, so any API worker can answer the GET.

1. Build the request: alias the customer's destinations, prompts, `base`, history (the last 10
   turns of this conversation from earlier jobs) and the message (§4.1).
2. Call TED (`round: "propose"`).
3. On a proposal: de-alias to a §2 graph (§5.2) and compile it with the customer's real context
   plus the new messages as synthetic prompts. On compiler errors, call TED again with
   `round: "repair"`; at most **2** repairs. A proposal that still has errors is returned anyway with
   them in `issues`: the customer can fix the rest by hand.
4. Store the result, the TED `request_id`s and the rounds used; mark `done` (or `failed`).

### 5.2 Result shapes (customer-facing, de-aliased)

```jsonc
{ "kind": "proposal",
  "draft_graph": { /* IVR_INTERFACES §2; every node position {x:0,y:0}; new messages are NEGATIVE prompt ids */ },
  "new_prompts": [ { "placeholder_id": -1, "name": "Main menu", "text": "For billing, press 1. …" } ],
  "summary": "Callers hear … 1 goes to Billing line (617-555-0100) …",
  "assumptions": ["…"],
  "issues": [],            // compiler errors left after repairs (Issue[]); usually empty
  "warnings": [] }         // compiler warnings (Issue[])
{ "kind": "clarify", "question": "Which number should 'billing' ring: Billing line (617-555-0100) or Accounts (617-555-0199)?" }
{ "kind": "cannot_build", "message": "…" }
```

- Node ids come from the model's ids; CRAG keeps those of nodes that already exist in `base`, so
  the builder can show what changed. Edge ids are new (`e_<nanoid>`).
- Placeholder ids are `-1 … -20` in `new_prompts` order. They are never saved: the builder
  replaces them with real prompt ids before the draft is written (§7).

### 5.3 Job error codes (customer text is CRAG's)

| `code` | Customer text |
|---|---|
| `assistant_unavailable` | "The flow assistant is unavailable right now. You can keep building by hand." |
| `assistant_busy` | "The flow assistant is busy. Try again in a minute." |
| `assistant_failed` | "The flow assistant couldn't finish that request. Try rewording it, or build it by hand." |

## 6. Vocabulary (the keyword guide and the prompt share it)

The builder's "What can I say?" guide (Build B) and TED's reviewed prompt (Build C) both teach this
table. Customers can write freely; these are the words the assistant understands best.

| To get | Say things like | Builds |
|---|---|---|
| A greeting or announcement | "greet callers with …", "say …", "play …", "announce …" | Play message |
| A menu | "press 1 for billing, 2 for outages", "menu options", "if they press 3 …" | Menu |
| Menu behaviour | "repeat the menu twice", "wait 8 seconds", "if they don't press anything …", "if they press a wrong key …" | Menu retries / timeout / no key / wrong key |
| Opening hours | "business hours", "weekdays 8 to 5", "Monday–Friday 9–6, Saturday 10–2", "after hours", "on weekends", "closed on Dec 25" | Business hours |
| A time zone | "Eastern", "Central", "Mountain", "Arizona", "Pacific", "Alaska", "Hawaii", "Puerto Rico" | Business hours `tz` |
| Who is calling | "if the caller is from 617", "if the caller's number is …", "blocked or private callers" | Caller check |
| A transfer | "transfer to …", "send them to …", "forward to …", "ring …", a name from **Your numbers**, or a US number | Transfer |
| Caller ID on a transfer | "show the caller's number", "show our number instead" | Transfer `passCallerId` |
| Ring time | "ring for 20 seconds", "if nobody answers …" | Transfer ring time / no-answer exit |
| Voicemail | "send them to voicemail", "let them leave a message in the Front desk mailbox" | Voicemail |
| Going back | "go back to the main menu", "start over", "return to the greeting" | Go to |
| Ending | "hang up", "say goodbye and hang up", "end the call" | Hang up |

Limits the guide states: US numbers only (no Canada, Caribbean, 900/976 or 555-01xx); up to 12
menu keys; a message is up to 1000 characters; the assistant never publishes — you do.

Example requests the guide offers (click to use):
1. "Greet callers, then: press 1 for billing, press 2 to report an outage, press 0 for the front desk. If nobody presses anything, repeat the menu once, then send them to voicemail."
2. "Weekdays 8am to 5pm Eastern, ring the front desk for 25 seconds and go to voicemail if nobody answers. After hours and on weekends, play our after-hours message and send them to voicemail."
3. "If the caller is blocked or private, say we don't accept anonymous calls and hang up. Otherwise go to the main menu."

**Disclosure** (shown above the message box):
"The assistant drafts a flow from your description. Your description and the names of your numbers
and messages are processed by an AI service; phone numbers are replaced with placeholders first.
Nothing changes until you accept, and nothing goes live until you publish."

**Naming:** the UI says "Flow assistant". It never names a model or vendor.

## 7. Builder (Build B)

- The **Flow assistant** panel opens from the builder toolbar (a side sheet on narrow screens) when
  `summary.assist.available`. Admin preview with `customer_id = null` shows the existing
  `PreviewPrompt`, not the panel.
- **Send** posts §5 with the in-memory draft, then polls the job every 1.5 s (stop after 300 s).
  The transcript shows the customer's messages and the assistant's summaries, questions and
  refusals.
- **A proposal** shows read-only on the canvas, laid out with the builder's Tidy-up layout, and its
  blocks appear one at a time in calling order (no animation under `prefers-reduced-motion`). A
  banner shows the summary, the assumptions, the new messages (each with **Listen**, via
  `tts-preview` with the chosen voice), any `issues`, and **Accept**, **Refine** (keeps the
  conversation, sends `refine_job_id`), **Discard**, and **Try a test call** (simulate with
  `assist_job_id`).
- **Accept:** create each new message with `POST /ivr/prompts/tts` (`name`, `text`, the chosen
  voice), replace the placeholder ids, apply Tidy-up positions, and replace the draft as **one
  undoable change that autosave writes** (not a "loaded, already saved" replace). Then post
  `outcome: accepted`. A message that fails to create stops the accept with the error; messages
  already created are reused on retry. **Discard** posts `outcome: discarded`.
- **Nothing publishes.** The customer still uses Publish.
- Theming follows `docker/ui/CLAUDE.md` §18 (light and dark).

## 8. Per-customer opt-in (Builds A and D)

- `customers.ivr_assist_enabled BOOLEAN NOT NULL DEFAULT false` (migration 61).
- `GET /ivr/admin/customers/{customer_id}` gains `ivr_assist_enabled`.
- `PUT /ivr/admin/customers/{customer_id}/entitlement` accepts `{ enabled?: bool, assist_enabled?: bool }`
  (at least one) → `{ ivr_enabled, ivr_assist_enabled }`. Turning IVR off leaves the assist flag as
  it is; the assistant also needs IVR, so it is unavailable either way.
- TED's Customer 360 Visual IVR section shows a **Flow assistant** switch when the CRAG response has
  `ivr_assist_enabled` (an older CRAG hides it), with the §6 disclosure in its confirmation.

## 9. Data, config and verification

**Migration `61_ivr_assist.sql`** (applied on the primary, replicates):
- `customers.ivr_assist_enabled` (§8).
- `ivr_assist_jobs`: `id UUID PK`, `customer_id`, `flow_id` (FK, cascade), `user_id`,
  `conversation_id UUID`, `status` (`running|done|failed`), `message TEXT` (the customer's own words,
  un-aliased, ≤ 2000), `result JSONB`, `error_code`, `rounds SMALLINT`, `ted_request_ids TEXT[]`,
  `outcome` (`accepted|discarded|NULL`), `created_at`, `finished_at`, `outcome_at`. Indexes for the
  daily cap (`customer_id, created_at`) and the running-job check (`flow_id` where running).
  Rows older than 90 days are deleted opportunistically when a job is created. Only the `api` role
  is granted; `freeswitch` gets nothing.

**CRAG env** (`docker-compose.services.yml` `api`, defaults safe):
`IVR_ASSIST_ENABLED` (`false`), `TED_BASE_URL` (unset), `TED_IVR_ASSIST_TOKEN` (unset; a secret,
`.env` only), `IVR_ASSIST_DAILY_PER_CUSTOMER` (`40`), `IVR_ASSIST_TED_TIMEOUT_SECONDS` (`60`).

**Verification hooks:**
- **CRAG tests** use a fake TED (no network): encoding round trip, aliasing and de-aliasing,
  number detection, the repair loop, caps, flags, tenancy and IDOR, job staleness, outcome,
  simulate with `assist_job_id`, admin opt-in.
- **TED scripted provider** (local and tests only): deterministic and always valid for any request.
  A message containing `?` returns `clarify`; one containing `#cannot` returns `cannot_build`;
  otherwise a proposal: Start → Play `NP1` "Thanks for calling." → Menu `NP2` with keys `1…k` for
  the first `k ≤ 9` destinations that are enabled and not `this_flow` (Transfer `own` for
  rcf/ivr/trunk, Voicemail for voicemail mailboxes), `noInput`/`noMatch` → Hang up. With no usable
  destination it returns Start → Play → Hang up.
- **Eval** (Build A): `tests/fixtures/ivr_assist/eval_cases.json` (≥ 30 realistic utility
  requests with destinations and expectations: compiles clean, and simulated calls reach the
  expected exit) and `python -m services.ivr.assist.eval` inside the API container, run by the
  owner against TED staging. It needs no database.

## Changes

- 2026-10-25 — first version.
- 2026-10-25 — settled during the build (all four builds implement these; wire shapes unchanged):
  - **§1 wire:** the envelope is exactly `{v, payload_b64}`, and padded base64 is refused (400). `X-Request-Id` is only for TED's logs; the payload's `request_id` decides idempotency. TED checks the token before the switch, so a disabled TED without a token answers 401, not 503 (CRAG maps both to `assistant_unavailable`). A settled response replays whatever its status; a duplicate still running answers 429 `busy` with `retry_after_s: 10`.
  - **§2:** `limits.max_new_prompts` is min(20, 100 − the customer's live prompts), so accepting can never pass the prompt cap. History carries only finished turns.
  - **§3 transforms (never a 502):** TED turns integral floats into integers, drops unreferenced new prompts, drops an EMPTY `values` on an `anonymous` caller check, and replaces formatted NANP numbers and 7+ digit runs in free text and node labels with `[number removed]`.
  - **§5 extra responses:** 409 `assist_not_refinable` (refining a job that isn't an open proposal); 409 `assist_not_a_proposal` (outcome or simulate on a job that isn't a finished proposal); 409 `assist_outcome_recorded` with `outcome` (a different outcome after one is recorded; the same one again is 204); 422 for a message outside 1–2000 characters or an invalid/oversized `draft_graph`; 503 for the admin PUT with `assist_enabled` before migration 61. A job error `assistant_busy` carries `retry_after_s`. An unknown, foreign or > 24 h `conversation_id` silently starts a new conversation; the response carries the id in use.
  - **§8:** TED's switch can always turn the assistant OFF, even while Visual IVR is off; only turning it on needs Visual IVR.
