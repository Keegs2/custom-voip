# Plan: one product-agnostic list of a customer's numbers (voicemail first)

> **Build status (lead, 2026-10-23):** the owner asked for voicemail numbers on every customer page and a holistic, product-agnostic account view. The build follows this plan, with the §7 defaults adopted: no voicemail billing line (D5); a call that reaches voicemail counts as answered, labelled "Answered by voicemail"; dashboard call cards cover every product on the account; a forward to voicemail is attributed to the dialed number. These are presentation choices the owner can flip later.

Worktree: `/Users/KeGrabhorn/custom-voip/.claude/worktrees/numbers-holistic` (branch `feat/customer-numbers-holistic` = RCF-V1 @ 1aa0104). All paths below are relative to that root.

## 0. Summary

- **Root cause (confirmed).** Reporting builds "the customer's numbers" from a hard-coded `rcf_numbers` + `trunk_dids` union (`docker/api/src/routers/reports.py:104-122`). "Every call" is a separate scan that filters only on `customer_id` (`:131-149`). Voicemail CDRs carry `customer_id` = the mailbox owner, so they are counted in totals, but the mailbox DID is never one of the customer's numbers.
- **The dashboard is worse.** Its numbers list, Numbers KPI and every call card are pinned to RCF (`/rcf`, `counts.rcf`, `product_type=rcf`), so voicemail calls do not appear there at all.
- **Recommendation: no new view.** `number_routing` (22, plus the voicemail arm from 54) becomes the single source of "a customer's numbers", read through ONE new API helper, `docker/api/src/services/customer_numbers.py`. A future product enrolls by adding a `number_routing` arm, which FreeSWITCH needs anyway to route the number. It then shows up in Reporting, the dashboard, `/customers/me`, the admin counts, DID search and `/numbers/my` with no further backend change.
- **Migration.** None is required for correctness. One optional index migration is recommended: `57_trunk_dids_trunk_index.sql`. The trunk arm is the only arm of the owned set without an index on its customer path.
- **API.** Additive changes only. Deploy order: API first, then UI. The UI sends `product_type=all`, which an old API would treat as a literal product and return 0 calls.

---

## 1. Inventory: everything that lists, counts, filters or attributes a customer's numbers

Severity:
- **S1**: customer-visible data is missing or wrong (the owner's complaint).
- **S2**: the view is incomplete or staff-only.
- **S3**: labels, docs, cosmetic.

### Backend (`docker/api/src`)

| # | file:line | Today | Voicemail / any product missing? | Impact | Sev | Action |
|---|---|---|---|---|---|---|
| B1 | `routers/reports.py:104-122` `_OWNED_CTES` | `rcf_numbers` ∪ `trunk_dids` via `sip_trunks.customer_id`, `DISTINCT ON` with rcf winning | Yes: voicemail and every future product | VM number missing from the "Your numbers" table and the picker; it cannot be used in the `numbers` filter | **S1** | Replace with `customer_numbers.owned_numbers_sql('$1::int')` |
| B2 | `reports.py:83-99` `_canon_sql`, `_NUMBER_SQL` | E.164 CASE (twin of 31) on destination (inbound) or caller_id (outbound) | n/a | Rule is right; only reports can use it today | S3 | Move to `customer_numbers` (reports keeps aliases); cdrs reuses it |
| B3 | `reports.py:131-149` `_BASE_CTE` | `c.customer_id = $1` over any product | Includes VM calls (correct) | Explains "VM calls in every call" | — | Add `c.product_type AS product` |
| B4 | `reports.py:402-443` `/reports/numbers` | One row per owned number (from B1) | Yes, through B1 | VM row absent; dashboard Busiest card and per-number "Last 7 days" also miss it | **S1** | Fixed by B1; shape unchanged, `product` gains new values |
| B5 | `reports.py:446-454` `/reports/my-numbers` | `{number, name, product}` from B1 | Yes | Reporting picker lacks VM | **S1** | Fixed by B1; add `enabled`, `forwards_to`; becomes the dashboard's list too |
| B6 | `reports.py:470-500` `_CALL_COLS` / `_shape_call` + `services/reporting.py:216-221` `outcome_fields` | Outcome is answered/missed only | VM-answered call reads plain "Answered" | Customer can't tell a call went to voicemail | S2 | Add `product` to call rows; label "Answered by voicemail" |
| B7 | `routers/customers.py:346-383` `/me` counts | `{rcf, api_dids, trunks}` | Yes | My Account "Your Numbers" has no voicemail | S2 | Add `counts.numbers {total, by_product}` |
| B8 | `customers.py:80-95` + `:172-192` billing estimate | RCF line from `rcf_numbers`; VM line commented out, with a stale comment saying "no voicemail table" | Intentional (decision D5: no voicemail pricing) | — | S3 | Keep D5 (owner decision O1); fix the stale comment |
| B9 | `routers/cdrs.py:2323-2348` `/cdrs/activity` (`product_type` default `"rcf"` at :2328) | Product filter defaults to rcf; omitting the param still filters rcf | Yes: an "all products" request is impossible | Dashboard KPIs, call volume and quality exclude VM | **S1** | Accept `product_type=all` (and `""`) as "no filter"; default stays `rcf` |
| B10 | `cdrs.py:1892-1989` `_build_cdr_filters` (used by `/cdrs` :1992, `/summary` :2136) | `destination` is a LIKE prefix; no "customer's number" filter | Outbound trunk calls can't be filtered by the customer's DID | The account-wide activity picker would miss outbound | S2 | Add `number` (canonical exact, customer-side number) and the `all` sentinel |
| B11 | `services/cdr_activity.py:166-243` `build_activity_query` | `product_type` / `destination` | Same as B9/B10 | Same | S2 | Add `number=None`; treat `all` as no filter |
| B12 | `routers/number_inventory.py:1164-1317` `/numbers/my` | `did_inventory` ∪ per-product fallback arms (voicemail arm already present: :1176-1193, :1247-1260) | No, but each product is a hand-written arm | Next product needs another arm | S3 | Replace the fallback arms with one `number_routing` arm |
| B13 | `number_inventory.py:448-496` `/stats`, `:373-445` `/inventory`, `:225-366` reconcile | Read from `did_inventory`, product-generic; reconcile already covers voicemail | No | — | — | No change (reconcile and assign/unassign stay per product by design) |
| B14 | `routers/search.py:27-200` `/search/did` (admin/TED) | UNION of rcf/api/trunk with product-specific `details` | Yes: voicemail and future products | Admin DID search can't find mailbox DIDs | S2 | Base the rows on `number_routing`; keep details identical for existing products |
| B15 | `search.py:203-254` `/did/{did}/calls` | caller OR destination | Already product-agnostic | — | — | None |
| B16 | NEW: admin platform number counts | (UI uses `did_inventory?product_type=rcf`, 1000-row page) | Yes; `did_inventory` also lags (`POST /rcf` and `POST /trunks/{id}/dids` never write it) | Admin dashboard counts are RCF-only, capped and laggy | S2 | New `GET /v1/numbers/owned` (admin), built on `number_routing` |
| B17 | `routers/rcf.py`, `routers/trunks.py` | Product consoles | By design | — | — | None |
| B18 | `services/tenant_redaction.py:78-80` | `product_type` is on the tenant allowlist | — | — | — | None (VM CDRs already pass redaction) |

FreeSWITCH evidence: CDR attribution happens in `docker/freeswitch/scripts/inbound_router.lua`.
- `:2146-2151` (`dispatch_terminal`) sets `customer_id` / `product_type` to the TERMINAL (the mailbox owner, `voicemail`).
- Direct dial reaches it through `lookup_voicemail_did` (`:787-818`).
- An on-net RCF forward to voicemail reaches it through the chain loop (`:2219-2299`) to `terminate_vvm` (`:2067`).
- The CDR `destination` is FS `destination_number`, which is the dialed (first-hop) DID; the Lua chain resolves in memory. Verify after deploy (section 6.6).

Grafana: no dashboard JSON under `docker/homer/grafana/dashboards/**` references `rcf_numbers`, `trunk_dids`, `number_routing` or `product_type` (grep count 0 everywhere). They are NOC-level, so nothing to change.

### UI (`docker/ui/app/src`)

| # | file:line | Today | Missing | Impact | Sev | Action |
|---|---|---|---|---|---|---|
| U1 | `pages/dashboard/accountData.ts:100-105` `useAccountNumbers` | `GET /rcf` (cap 100) | VM and trunk numbers | "Your numbers" card has no VM | **S1** | New `useAccountAllNumbers` (`/reports/my-numbers`), merged with the `/rcf` rows |
| U2 | `accountData.ts:85-98` (`counts.rcf`) + `AccountDashboardView.tsx:105-124` numberFeed | Numbers KPI = RCF count | VM | KPI undercounts | **S1** | Numbers total = unified list; Forwarding/Paused counted from rcf rows (exact, no "100+") |
| U3 | `accountData.ts:135-148` (`product_type:'rcf'` at :143) | 7-day activity is RCF-only | VM (and trunk) calls | Calls/Answered/Sounded-good KPIs, Volume and Quality cards miss VM | **S1** | `product_type:'all'`, new query key |
| U4 | `accountData.ts:194-210` (`product_type:'rcf'` at :202) | Recent calls RCF-only | VM calls | Recent card misses VM | **S1** | Drop the product filter, new key |
| U5 | `pages/dashboard/NumbersCard.tsx` (whole file; rows `RcfEntry` at :29-41, :101-122, :223-282) | RCF rows only, RowEditor, Forwarding/Paused chips | Non-RCF rows | — | **S1** | Unified rows (section 5.1) |
| U6 | `KpiCards.tsx:246-280` | Numbers + Forwarding copy is RCF | Product mix | — | S2 | Numbers context shows the product mix |
| U7 | `CallCards.tsx:240-334` (RecentCard), `:371-419` (BusiestCard) | Outcome via `callStatusInfo`; labels from RCF entries | VM outcome label; product label | — | S2 | Section 5.1 |
| U8 | `pages/rcf/callOutcome.ts:49-80` `callStatusInfo` | Answered/cause words | "Voicemail" | — | S2 | VM answered → "Voicemail" (INFO tone) |
| U9 | `pages/rcf/CallActivityTab.tsx:71-141`, `ActivityDidPicker.tsx:13-20`, `activityFormat.didLabel` | RCF list + `product_type:'rcf'` + `destination` | VM/trunk in the dashboard overlay | Overlay ("Every call to your numbers") misses VM | S2 | New `scope` prop (section 5.2) |
| U10 | `pages/dashboard/quickActions.tsx:40-75` | "Manage all numbers" → `/rcf` | VM link | — | S3 | Product-aware labels; "Open voicemail" |
| U11 | `adminData.ts:104-139` (`product_type=rcf` inventory), `AdminDashboard.tsx:153-205`, `AdminCards.tsx:80-240` (CustomersCard), `:311-357` (InventoryCard) | Platform/per-customer counts RCF-only, from `did_inventory` | VM, trunk | Admin counts not holistic | S2 | `GET /numbers/owned`; generic product lines |
| U12 | `types/reports.ts:12` `ReportProduct`, `:199-207` `MyNumber` | `'rcf'\|'trunk'\|'api'` | `voicemail` + new fields | Type drift | S2 | Widen + optional fields |
| U13 | `pages/reporting/NumberPicker.tsx:133-141`, `NumbersTable.tsx:79-103`, `ReportPdfDocument.tsx:~119` | No product shown | Product label | VM row unlabeled | S2 | Product tag |
| U14 | `pages/MyAccountPage.tsx:447-462` (tiles), `:823-847` (Products tab), `:1140-1147` (header) + `types/account.ts:22-26` | rcf / trunks / api tiles | VM | My Account misses VM | S2 | Tiles from `counts.numbers.by_product`; Voicemail section |
| U15 | `pages/calls/CallsFilterBar.tsx:225-238`, `CallsTable.tsx:77-79`, `types/cdr.ts:5` | Product filter RCF/(API)/Trunk | Voicemail option | Can't filter VM calls | S2 | Add option; catalog tags |
| U16 | `pages/rcf/DidManagement.tsx:801,930` | Raw `product_type ?? 'RCF'` tag | Label | Shows "voicemail" lowercase | S3 | Catalog tag |
| U17 | `pages/voicemail/*` (`NewMailboxDialog.tsx`, `MailboxSettings.tsx`) | Mailbox create/delete/suspend invalidate `['voicemail']` only | Number lists stay stale | — | S3 | Also invalidate the account-numbers keys |
| U18 | `RcfPage.tsx` / `rcf/CustomerNumbersPage.tsx` / `RoutingBoard` | RCF product pages | By design | Per-number stats (`/reports/numbers`) gain on-net RCF→VM calls automatically | — | None |
| U19 | `components/layout/Sidebar.tsx` | Visual Voicemail already gated per account via `/voicemail/summary` | — | — | — | None |
| U20 | `pages/dashboard/products.ts` (header product switcher) | VM is a link when on | — | — | — | None |

---

## 2. Root-cause confirmation (Granite, customer 1, hybrid)

1. **Voicemail CDRs belong to Granite.** FS stamps `customer_id` = mailbox owner and `product_type = 'voicemail'` for both direct dial and on-net forward (`inbound_router.lua:2146-2151`). 54's `rate_cdr` header (`54_voicemail.sql:498-502`) confirms `direction='inbound'`.
2. **"Every call" is product-blind.** `_BASE_CTE` (`reports.py:131-149`) filters only `c.customer_id = $1` and the time window, so overview, trend and calls include VM CDRs.
3. **"The customer's numbers" is not.** `_OWNED_CTES` (`reports.py:107-122`) unions only `rcf_numbers` and `trunk_dids`. `voicemail_boxes` (54) is not read, so:
   - `/reports/numbers` (`:402-421`, `FROM sel LEFT JOIN st`) has no VM row;
   - `/reports/my-numbers` (`:446-448`) has no VM option;
   - `numbers=<vm DID>` is dropped by `sel` (`:124-127`) and narrows to nothing.
4. **The dashboard is RCF-pinned everywhere** (U1–U4).
5. **The contract doc encodes the bug.** `docs/CUSTOMER_REPORTING_DESIGN.md:44-46,161-162` says numbers = rcf + trunk DIDs.

---

## 3. Target design

### 3.1 Options

| Source | Pros | Cons | Verdict |
|---|---|---|---|
| **`number_routing` view** | Already the product-agnostic oracle FS routes on. One arm per product and a new product must add one anyway. Unfiltered on enabled (disabled numbers stay owned). Voicemail arm drops deleted mailboxes. `api` has SELECT. The API already uses it as an ownership guard (`services/voicemail/mailboxes.py:275`). Works before and after 54 with no schema probe. | Call-path view, so API readers must not need column changes. Carries the retired `api` arm. | **Chosen** |
| `did_inventory` | Has lifecycle statuses | Lags: `POST /rcf` and `POST /trunks/{id}/dids` never write it, only reconcile does. 22's header explicitly forbids routing off it. Mixes requests (`reserved`) with ownership. | Rejected as the owner source (it stays the request/lifecycle source in `/numbers/my`) |
| New `customer_numbers` view (migration 57) | SQL-level single rule | A dependent view makes any future `DROP`/re-type of `number_routing` need CASCADE (friction on a call-path object), plus extra grants and a migration. Gains nothing over a Python helper reading the same view. | Rejected |

### 3.2 The helper: `docker/api/src/services/customer_numbers.py` (NEW, pure, no DB)

```python
"""The ONE definition of "a customer's numbers" (product-agnostic).
Source: the number_routing view (22 + 54 voicemail arm) — one row per
platform-owned DID across every product arm (the oracle FreeSWITCH routes on).
A product enrolls by adding a number_routing arm; it then appears in Reporting,
the dashboard, /customers/me, /numbers/owned, /numbers/my and /search/did."""

#: Never shown to customers as "their numbers". API Calling is RETIRED; reports
#: never listed api DIDs. The api arm stays in number_routing (FS must 603 it).
HIDDEN_PRODUCTS: tuple[str, ...] = ("api",)
#: Duplicate-DID tie-break = FreeSWITCH STEP-1 order (inbound_router.lua:807-818).
PRECEDENCE: tuple[str, ...] = ("rcf", "api", "trunk", "voicemail")
#: product_type sentinel meaning "no product filter" (cdrs, cdr_activity).
ALL_PRODUCTS = "all"
# import-time assert: every entry matches ^[a-z_]+$ (they are inlined as SQL literals)

def canonical_e164_sql(expr: str) -> str: ...      # moved verbatim from reports._canon_sql

def cdr_customer_number_sql(alias: str | None = None) -> str:
    """Canonical customer-side number of a CDR: destination for inbound,
    caller_id for outbound (anything not 'outbound' is inbound)."""

def owned_numbers_sql(customer_bind: str | None) -> str:
    return f"""
    SELECT DISTINCT ON (nr.did)
           nr.did::text                        AS number,
           nr.product_name::text               AS name,
           nr.product_type::text               AS product,
           nr.forward_to::text                 AS forwards_to,
           COALESCE(nr.product_enabled, false) AS enabled,
           nr.customer_id                      AS customer_id
      FROM number_routing nr
     WHERE nr.product_type NOT IN ('api')                   -- from HIDDEN_PRODUCTS
       {"AND nr.customer_id = " + customer_bind if customer_bind else ""}
     ORDER BY nr.did, CASE nr.product_type WHEN 'rcf' THEN 1 WHEN 'api' THEN 2
                      WHEN 'trunk' THEN 3 WHEN 'voicemail' THEN 4 ELSE 99 END"""
```

Ownership rules:
- **Owned** = currently on the account in any product, enabled or not.
  - Disabled RCF numbers, suspended mailboxes and disabled trunks: included (`enabled=false`).
  - Mailboxes with `voicemail_enabled=false`: included, `enabled=false`.
  - Deleted mailboxes: excluded (the 54 arm filters `status <> 'deleted'`).
  - Customer status: not applied (it's still their number).
- **History.** Per-number figures always come from `base`, which is scoped to the customer's own CDRs, intersected with owned numbers.
  - Released numbers: past calls still count in totals, trend and the call list, but get no number row and can't be picked. This is unchanged, and deliberate: a released DID may be reassigned, and showing it as "yours" would mislead.
  - A number moved to another customer never exposes the old owner's calls, because `base` is customer-scoped.
- **Attribution of an on-net forward to voicemail.** The call belongs to the number the caller dialed: CDR `destination` = the first-hop RCF DID. For a same-customer RCF→VM forward, the call appears under the RCF number row, labelled "Answered by voicemail". The VM number's row counts direct dials only. This matches today's RCF→RCF on-net behaviour and what the customer expects ("calls to my main line"). The owner can override.
- **`api` is hidden** from every customer-facing list, and from admin dashboard counts. It is kept in `number_routing` (FS), `/numbers/my` and `/search/did` (admin cleanup, unchanged behaviour).
- **Tenant redaction.** New exposed fields are `enabled` and `forwards_to` (rcf only), already visible via `/rcf`. `product_ref_id` and `customer_status` are never returned to tenants; `customer_id` appears only on the admin `/numbers/owned`.

### 3.3 Performance (report path)

`WHERE nr.customer_id = $1` is pushed into every `UNION ALL` arm (the same pushdown FS relies on for `did`). Index per arm:

| Arm | Index used |
|---|---|
| rcf | `idx_rcf_customer` (02:45), customers PK |
| api | `idx_api_did_customer` (03:35) |
| trunk | `idx_trunks_customer` (02:60), then `trunk_dids` join on `trunk_id`: **no index** (only `UNIQUE(did)` + hash(did), 02:77-84), so Seq Scan. Fixed by migration 57. |
| voicemail | `idx_voicemail_boxes_customer` (54:195) |

The owned set stays a tiny CTE. The CDR scan is unchanged on `idx_cdrs_customer_time`, so `test_report_scan_uses_customer_time_index` stays green. Binds keep explicit `::int` casts.

### 3.4 Migration 57 (recommended, independent of the API build)

`docker/postgres/init/57_trunk_dids_trunk_index.sql`:

```sql
-- 57_trunk_dids_trunk_index.sql — index trunk_dids(trunk_id): the number_routing
-- trunk arm's customer path (services/customer_numbers.py reads number_routing
-- WHERE customer_id = $1; rcf/api/voicemail arms have customer_id indexes, the
-- trunk arm reaches sip_trunks via idx_trunks_customer but joined trunk_dids by
-- Seq Scan). Also serves trunks.py did_count sub-selects + the sip_trunks
-- ON DELETE CASCADE. NOT the FS point lookup (idx_trunk_did_lookup).
-- SHARE lock on trunk_dids for the build: blocks writes (admin DID assign) for
-- ms, never reads. Fail fast; re-run on timeout. Idempotent.
-- Apply (East primary, replicates):
--   sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/57_trunk_dids_trunk_index.sql
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS idx_trunk_dids_trunk ON trunk_dids (trunk_id);
COMMIT;
```

Related changes:
- `scripts/db/check_migrations.sql`: header becomes `22..57`; add the row `('57_trunk_dids_trunk_index', to_regclass('public.idx_trunk_dids_trunk') IS NOT NULL)`.
- `docker/postgres/CLAUDE.md`: add a 57 row. In the 22 row add: "also the API's customer-numbers oracle; arms must keep customer_id / product_name (customer-safe label) / product_enabled / forward_to semantics".
- Root `CLAUDE.md` gotcha 16: "(22..53)" becomes "(22..57)".

### 3.5 How a future product enrolls (put this checklist in `docker/api/src/CLAUDE.md`)

1. **Migration** (product table, then `CREATE OR REPLACE VIEW number_routing`):
   - add one arm with all existing arms verbatim, same column list and types;
   - arm columns: `product_type='<p>'`, `customer_id`, `product_ref_id`, `product_enabled` (the customer-visible on/off), `product_name` (a **customer-safe label**), `forward_to` (NULL unless it forwards);
   - `did_inventory_product_type_check += '<p>'`;
   - a `check_migrations` row.
2. **FreeSWITCH**: `terminate_<p>` plus a `TERMINATORS` entry.
3. **Automatic from there**: Reporting numbers/picker/filter, dashboard numbers card + Numbers KPI + activity picker, `/customers/me counts.numbers`, `/numbers/owned`, `/numbers/my`, `/search/did` (generic details).
4. **Optional UI polish**: one entry in `src/config/products.ts`. Unknown products render with a title-cased fallback.
5. **Per-product by design** (not lists of numbers): `number_inventory` assign/unassign/reconcile, `rate_cdr`, the billing estimate line, the product's own console page.

---

## 4. API contract (all additive)

1. **`GET /v1/reports/my-numbers`** (tenant: own; staff: `customer_id` required). Same scoping; order by number; cap 5000.
   ```json
   {"numbers": [
     {"number": "+16174544217", "name": "Main line", "product": "rcf", "enabled": true, "forwards_to": "+17744045256"},
     {"number": "+15085550100", "name": "Voicemail", "product": "voicemail", "enabled": true, "forwards_to": null},
     {"number": "+16175550202", "name": "alpha", "product": "trunk", "enabled": true, "forwards_to": null}]}
   ```
   `forwards_to` is non-null only for rcf. The list is now shared by the Reporting picker AND the Dashboard. Chosen over `/numbers/my` because that endpoint is admin-all-customers with no `customer_id` param and mixes in requests. Chosen over a new route because the scoping is already right for "View as Customer" (staff + `customer_id`), and two pages reading one list can't disagree.
2. **`GET /v1/reports/numbers`**: shape unchanged; rows now include every visible product (`product` ∈ rcf | trunk | voicemail | future).
3. **`GET /v1/reports/calls`** (+ `calls.csv`):
   - each call gains `"product": "<cdrs.product_type>"`;
   - `outcome_label` = `"Answered by voicemail"` when answered and `product == "voicemail"` (`outcome` stays `"answered"`);
   - CSV columns are unchanged; the Outcome cell carries the new label.
4. **`GET /v1/customers/me`**:
   - `counts` gains `"numbers": {"total": 5, "by_product": {"rcf": 3, "trunk": 1, "voicemail": 1}}`;
   - zero-count products are omitted and `api` is hidden;
   - `rcf` / `api_dids` / `trunks` are unchanged;
   - no new per-product top-level keys (that would reintroduce per-product enrollment).
5. **`GET /v1/cdrs/activity`**:
   - `product_type=all` (or empty) means no product filter; default still `rcf`;
   - NEW `number` (any phone format, canonicalized with `utils.phone.normalize_e164`, 422 `"number must be a phone number"` if invalid) matches `cdr_customer_number_sql() = $n::varchar`;
   - `destination` is unchanged; both may be combined (AND).
6. **`GET /v1/cdrs`, `/v1/cdrs/summary`**: same `number` param and `all` sentinel, through `_build_cdr_filters(..., number=None)`. Tenants are allowed; it only narrows within their own `customer_id`.
7. **NEW `GET /v1/numbers/owned`** (admin only, `require_admin`; declared near `/stats`, no route clash):
   ```json
   {"total": 130, "enabled": 127,
    "by_product": {"rcf": {"total": 120, "enabled": 118}, "trunk": {"total": 7, "enabled": 7}, "voicemail": {"total": 3, "enabled": 2}},
    "customers": [{"customer_id": 1, "total": 12, "enabled": 11,
                   "by_product": {"rcf": {"total": 10, "enabled": 9}, "trunk": {"total": 1, "enabled": 1}, "voicemail": {"total": 1, "enabled": 1}}}]}
   ```
   SQL: `SELECT customer_id, product, count(*)::int, count(*) FILTER (WHERE enabled)::int FROM (<owned_numbers_sql(None)>) o GROUP BY 1,2 ORDER BY 1,2`.
8. **`GET /v1/search/did`** (admin): rows come from `number_routing` JOIN customers.
   - `status` = `CASE WHEN nr.product_enabled THEN 'active' ELSE 'disabled' END` (identical to today for rcf/api/trunk).
   - `details` by product:
     - rcf/api/trunk: correlated sub-selects by `nr.product_ref_id`, **byte-identical keys to today**:
       - rcf: `name`, `forward_to`, `enabled`, `ring_timeout`, `failover_to`, `pass_caller_id`;
       - api: `voice_url`, `fallback_url`, `voice_method`, `enabled`;
       - trunk: `trunk_id`, `trunk_name`, `trunk_enabled`, `max_channels`, `auth_type`.
     - voicemail: `{label, mailbox_id, enabled}`.
     - else: `{name, enabled}`.
   - `api` stays included (admin tool).
9. **`GET /v1/numbers/my`**: shape unchanged.
   - The rcf/api/trunk/voicemail fallback arms (both paths) become ONE arm: `SELECT nr.did, nr.product_type, 'assigned', NULL, NULL, NULL::timestamptz, NULL, nr.customer_id, c.name FROM number_routing nr JOIN customers c ...`, with the same `NOT IN did_inventory` predicates as today.
   - Fallback-only rows now carry `assigned_at: null`.
   - The `voicemail_schema_present` probe is dropped. `api` is still included.

---

## 5. UI design (keep the existing `ad-` / `dl-` / `rpt-` visual language)

**Shared product catalog** — NEW `src/config/products.ts`:

| id | `label` | `tag` | on / off word | Order / notes |
|---|---|---|---|---|
| rcf | Call forwarding | RCF | Forwarding / Paused | 1 |
| api | API Calling | API | — | 2; `hidden: !API_CALLING_ENABLED` |
| trunk | SIP trunk | Trunk | Active / Off | 3 |
| voicemail | Voicemail | Voicemail | Taking messages / Off | 4 |

Helpers: `productInfo(id)` (unknown id → title-cased label, upper-case tag, Active/Off), `productLabel()`, `productTag()`, `compareProducts()`. The `products.ts` switcher stays as is.

Every surface below must work for: tenant, readonly, admin one-customer, and admin "View as Customer" (`customer_id = null`, staff endpoints + `customer_id`).

### 5.1 Dashboard account view (`AccountDashboardView`, `NumbersCard`, `KpiCards`, `CallCards`, `accountData.ts`)

**Data**
- `useAccountAllNumbers(scope)`:
  - key `['account-numbers', customerId, staff ? 'staff' : 'self']`;
  - calls `getMyNumbers(staff ? customerId : undefined)`;
  - `retry:false`, `staleTime:60s`;
  - export `invalidateAccountNumbers(qc)`, which invalidates `['account-numbers']` and `['reports','my-numbers']`.
- `toNumberRows(myNumbers, rcfEntries, {voicemailHref})` → `NumberRow {number, name, product, enabled, forwardsTo, rcf: RcfEntry|null, href: string|null}`:
  - rcf rows attach their `RcfEntry` by `numberKey`;
  - an rcf row past the 100-row `/rcf` cap is read-only, with a "Manage in call forwarding" hint;
  - if my-numbers fails, rows = RCF entries only (today's view).
- `useWeekActivity`: `product_type:'all'`, key `['dash-activity','all-products', customerId ?? 'all', tz]`.
- `useRecentCalls`: no `product_type`, key `['dash-recent-calls','all-products', …]`.

**Numbers KPI**
- `total` = rows.length;
- `forwarding` = rcf rows enabled; `paused` = rcf rows disabled;
- `partial` = false when sourced from my-numbers;
- context = product mix when there is more than one product ("11 forwarding · 1 voicemail · 1 SIP trunk"), else the current copy;
- Forwarding card: when there are 0 rcf rows, context reads "No call forwarding numbers".

**NumbersCard**
- Rows sort by DID, as today.
- Column header: "Forwards to" when every row is rcf (byte-identical for RCF-only accounts), else "Where calls go".
- Chips: All · Forwarding · Paused (only if rcf rows exist) · one chip per other product present ("Voicemail 1").
- **rcf row**: unchanged (RowEditor; `isAdmin` admin fields).
- **voicemail row**:
  - "Where calls go" = **Voicemail** / faint "Callers leave a message";
  - status = Taking messages / Off with the existing `ad-status-on/off` dot;
  - the row is a link (`ad-chev-go` arrow; click/Enter navigates). Target: tenant and preview `/voicemail`; admin viewer `/voicemail?customer=<id>`;
  - aria-label "…, voicemail. Open voicemail".
- **trunk row**: "Your phone system" / faint "SIP trunk"; status Active/Off; not interactive (no tabIndex, no chevron).
- Card sub: "Select a number to change where it rings." plus ", or open its voicemail." when VM rows exist.
- Footer: "View all N numbers" → the `/rcf` console stays when the account has only rcf. With multiple products: "Manage call forwarding →" (/rcf or the admin console).
- New CSS: `.ad-prodtag` (small brand-blue pill) and `.ad-row-link` in `styles/account-dashboard.css`.

**Call cards**
- `callStatusInfo`: `product_type === 'voicemail' && answer_time != null` → `{label:'Voicemail', ...INFO}`. This also applies in the Call activity table.
- `BusiestCard`: takes `rows`; adds "· Voicemail" to the sub-label for non-rcf rows.
- `RecentCard`: no change beyond the outcome.

**Overlay**: `<CallActivityTab customerId={id} scope="account" numbers={rows} />`.

**Quick actions**
- Customer: "Manage all numbers" keeps its label for rcf-only accounts, else "Manage call forwarding". Add "Open voicemail" (sub "Messages and greetings") when `voicemailOn`.
- Admin: add "Voicemail console" → `voicemailConsoleHref(id)` (new helper in `adminLinks.ts`) when `voicemailOn`.

### 5.2 `CallActivityTab` (+ `ActivityDidPicker`, `activityFormat.didLabel`)

- New props: `scope?: 'rcf' | 'account'` (default `'rcf'`, so the RCF console is byte-identical) and `numbers?: readonly {number, name, product}[]`.
- **rcf scope**: today's behaviour (listRcf, `product_type:'rcf'`, `destination`).
- **account scope**:
  - the `listRcf` query is disabled via `enabled:` (hooks stay unconditional);
  - the picker comes from `numbers` and shows a product tag for non-rcf;
  - activity: `product_type:'all'`, `number:<selected>`;
  - table: `searchCdrs({customer_id, number, …})` with no product filter;
  - query keys include `scope`.
- `ActivityDidPicker` / `didLabel` take a generic `{did|number, name}` shape.
- Admin All-customers overlay: `scope="account"` with no `numbers` → static "All Numbers".

### 5.3 Admin dashboard (`adminData.ts`, `AdminDashboard.tsx`, `AdminCards.tsx`)

- Replace `useRcfInventory` / `toPlatformNumberCounts` / `INVENTORY_PAGE` with `useOwnedNumbers()` → `GET /numbers/owned`, key `['admin-dash','owned-numbers']`.
- Numbers KPI: `total` = owned.total; forwarding = `by_product.rcf.enabled`; paused = `rcf.total − rcf.enabled`; exact, so no "+" and no "First 1,000 listed".
- CustomersCard: Numbers column = per-customer total (all products, with a `title` tooltip of the mix); Paused = rcf total − enabled (exact).
- PausedCard unchanged (`/rcf?enabled=false` list).
- InventoryCard: one line per visible product in `/numbers/stats.by_product`, in catalog order.
- Activity + recent: all products (via the hooks above).

### 5.4 Reporting (`types/reports.ts`, `NumberPicker`, `NumbersTable`, `CallList`, `ReportPdfDocument`, `Glossary`)

- Types: `ReportProduct = 'rcf' | 'trunk' | 'api' | 'voicemail' | (string & {})`; `MyNumber` gains `enabled?: boolean`, `forwards_to?: string | null`; `ReportCallRow` gains `product?: string`.
- Picker: a product tag on each option when the options span more than one product.
- NumbersTable / PDF: number subline = `name` plus " · Voicemail" (catalog label) for non-rcf.
- CallList: shows the server `outcome_label` unchanged.
- Glossary entry: "Answered by voicemail — the call reached your voicemail; it counts as answered."

### 5.5 My Account (`MyAccountPage.tsx`, `types/account.ts`)

- `counts.numbers?: {total: number; by_product: Record<string, number>}`.
- Overview "Your Numbers": one tile per product in `by_product` ("Call forwarding numbers", "Voicemail numbers", "SIP trunk numbers"), keeping the "SIP trunks" (trunk count) tile and the API gating. Old API (field absent) → today's tiles.
- Header metrics: add per-product number metrics.
- Products tab: a `VoicemailProductSection` when `by_product.voicemail > 0`, listing number, label and On/Off pill with an "Open voicemail" link. Data: `getMyNumbers()` filtered to voicemail.
- Admin preview still shows `NoCustomerNotice` (`/customers/me` is self-scoped). Pre-existing; out of scope.

### 5.6 Calls & Quality and DID management

- `types/cdr.ts`: `ProductType` adds `'voicemail'`; `CdrSearchParams` adds `number?: string`; `product_type` may be `'all'`. Update `cdrSearchQuery` and `getCdrActivity`.
- `CallsFilterBar` gets a `<option value="voicemail">Voicemail</option>`: always for staff; for tenants only when `useVoicemailSummary(tenantScope(id)).data?.enabled`.
- `ProductTag` and `DidManagement` tags use `productTag()`.

### 5.7 Voicemail pages

On success of mailbox create (`NewMailboxDialog`), delete and suspend/resume (`MailboxSettings`), call `invalidateAccountNumbers(queryClient)`. Do NOT add it to `invalidateVoicemail()`, which runs on every message action.

---

## 6. Work split (parallel; disjoint file ownership)

### 6.1 Backend agent (python-backend-architect) owns

- **Code**
  - `docker/api/src/services/customer_numbers.py` (NEW)
  - `routers/reports.py`, `services/reporting.py`
  - `routers/customers.py`
  - `routers/cdrs.py`, `services/cdr_activity.py`
  - `routers/number_inventory.py`, `routers/search.py`
- **DB**
  - `docker/postgres/init/57_trunk_dids_trunk_index.sql` (NEW)
  - `scripts/db/check_migrations.sql`
- **Tests**
  - `tests/test_customer_numbers.py` (NEW)
  - `tests/test_reports.py`, `tests/test_tenant_redaction.py`, `tests/test_api_calling_retired.py`
  - `tests/test_cdr_activity.py`, `tests/test_cdr_search_filters.py`, `tests/test_support_role_authz.py`
  - (`tests/test_voicemail_api.py` only if a `/numbers/my` assertion changes)
- **Docs**
  - `docs/CUSTOMER_REPORTING_DESIGN.md` (lines 44-46, 133-134, 161-163 + new fields)
  - `docker/api/CLAUDE.md` (Reports / Number Inventory / CDR tables)
  - `docker/api/src/CLAUDE.md` (Reporting "customer's number" paragraph, new "Customer numbers" section + enrollment checklist, search/number_inventory notes)
  - `docker/postgres/CLAUDE.md`
  - root `CLAUDE.md` (gotcha 16 range; one line under On-Net: "number_routing is also the API's customer-numbers oracle")
  - Fix the stale comment at `customers.py:172-176`.

### 6.2 UI agent (frontend-fullstack-expert) owns

- **New file**: `src/config/products.ts`.
- **Types**: `types/reports.ts`, `types/cdr.ts`, `types/cdrActivity.ts`, `types/account.ts`.
- **API modules**: `api/cdrs.ts`.
- **Dashboard**: `pages/dashboard/{accountData.ts, AccountDashboardView.tsx, NumbersCard.tsx, KpiCards.tsx, CallCards.tsx, quickActions.tsx, adminLinks.ts, adminData.ts, AdminDashboard.tsx, AdminCards.tsx}`.
- **RCF components**: `pages/rcf/{CallActivityTab.tsx, ActivityDidPicker.tsx, activityFormat.ts, callOutcome.ts, DidManagement.tsx}`.
- **Reporting**: `pages/reporting/{NumberPicker.tsx, NumbersTable.tsx, ReportPdfDocument.tsx, ReportCards.tsx (Glossary)}`.
- **Other pages**: `pages/MyAccountPage.tsx`, `pages/calls/{CallsFilterBar.tsx, CallsTable.tsx}`, `pages/voicemail/{NewMailboxDialog.tsx, MailboxSettings.tsx}`.
- **Styles**: `styles/account-dashboard.css`, `styles/dl-reporting.css`.
- **Docs**: `docker/ui/CLAUDE.md` (§5 modules, §7 dashboard/reporting, §9 types, new "Products catalog" note).

**Shared contract** = section 4. The UI types every new field as optional and degrades to today's behaviour when it is absent.

### 6.3 Backend tests (CI: `pytest tests -q -rsx` + `check_no_skips.py`; no skips; PG16 via `TEST_PG_BIN`)

1. **`tests/test_tenant_redaction.py` (constants only, other importers unaffected).**
   - Split `_SCHEMA` into `_CDR_SCHEMA` (cdrs, call_attestations, active_calls) and `_PRODUCT_SCHEMA` (customers, rcf_numbers, api_dids, sip_trunks, trunk_dids). Keep `_SCHEMA = "CREATE ROLE api …;" + _CDR_SCHEMA + _PRODUCT_SCHEMA + grants` (functionally identical; it's imported by six modules).
   - In this module's OWN fixture only, then add:
     - `CREATE ROLE freeswitch`;
     - `ALTER TABLE rcf_numbers ADD ring_timeout INT DEFAULT 30, ADD max_channels INT DEFAULT 0`;
     - `ALTER TABLE api_dids ADD enabled BOOLEAN DEFAULT true, ADD voice_url VARCHAR(512), ADD fallback_url VARCHAR(512)`;
     - `ALTER TABLE sip_trunks ADD enabled BOOLEAN DEFAULT true`;
     - and run the REAL `docker/postgres/init/22_number_routing.sql`.
   - Assert tenant `/customers/me` `counts.numbers == {"total":1,"by_product":{"rcf":1}}`.
2. **`tests/test_reports.py`.**
   - Fixture uses the REAL chain: `voicemail_db.apply_prerequisites` (02,03,09,17,20,22,24,31,34), then `apply_voicemail_schema` (54, 56), then 57, then `_CDR_SCHEMA` + `apply_cdr_column_migrations` + the index.
   - Grant cdrs/call_attestations/active_calls to api (no blanket GRANT, which would widen 54's access-log grants).
   - Seed for CID_A: `voicemail_enabled=true`; mailbox A_VM `+16175550404` (active); A_VM_OFF `+16175550505` (suspended); a deleted box on `+16175550606`; an `api_dids` row `+16175550707` (hidden).
   - Seed CDRs on **2026-09-15** (outside AUG, to limit churn):
     - v01: direct to A_VM, `product_type='voicemail'`, answered;
     - v02: on-net, destination A_MAIN, product voicemail, answered, `on_net=true`, `origin_customer_id=A`;
     - v03: to the deleted box DID (counted in totals, no number row).
   - Update exact expectations:
     - AUG `/numbers` gains the A_VM and A_VM_OFF rows with 0 calls (`grade` "none");
     - `/my-numbers` gains them plus `enabled`/`forwards_to` for all rows, and never A_VM_GONE or the api DID.
   - New tests:
     - SEP `/numbers`: A_VM calls=1; A_MAIN includes v02;
     - `numbers=A_VM` filter narrows to v01; B with `numbers=A_VM` gets an empty result;
     - `/calls` `product` field + "Answered by voicemail" (JSON and CSV);
     - overview SEP totals include v03;
     - `assert_report_safe` on every new body.
3. **`tests/test_customer_numbers.py`** (NEW, port **55481**, real chain + 54 + 56 + 57).
   - Helper semantics: disabled rcf in; suspended box `enabled=false`; `voicemail_enabled=false` → `enabled=false`; deleted box out; api out; other customer out; DID planted in two tables → one row, rcf wins.
   - `EXPLAIN` of `owned_numbers_sql('$1::int')` with `enable_seqscan=off` names `idx_rcf_customer`, `idx_api_did_customer`, `idx_trunks_customer`, `idx_trunk_dids_trunk`, `idx_voicemail_boxes_customer`, and has no `Seq Scan on (rcf_numbers|trunk_dids|voicemail_boxes|api_dids)`.
   - 57 applied twice (idempotent); `check_migrations.sql` reports `57_trunk_dids_trunk_index` applied.
   - `cdr_customer_number_sql` canonicalization parity with `utils.phone.normalize_e164` over a table of inputs.
   - `GET /v1/numbers/owned`: shape, exact counts, admin-only (user/readonly/support → 403).
   - `/v1/numbers/my`: fallback row from `number_routing` (rcf row not in `did_inventory` appears with `assigned_at` null; voicemail row present).
   - `/v1/search/did`: voicemail row with details. Golden-compare rcf/api/trunk `details` + `status` against the OLD query text (copied into the test) on the same DB.
   - `/v1/customers/me`: `counts.numbers` on the real schema.
4. **`tests/test_api_calling_retired.py::test_me_counts_api_dids_zero_when_off`.**
   - Extend the mock: the new numbers query (use `db.fetch_all`; patch it to return `[{"product":"rcf","n":4}]`).
   - Expected counts gain `numbers`. Assert the numbers SQL contains `NOT IN ('api')` with the flag both off and on.
5. **`tests/test_cdr_activity.py` + `tests/test_cdr_search_filters.py`.**
   - `product_type=all` and `product_type=` include rcf + trunk (+ a seeded voicemail row); omitting it still means rcf only.
   - `number` matches inbound by destination and outbound by a canonicalized 10-digit caller_id; junk → 422.
   - Tenant can't widen; `/summary` honours `number`; the sargable-plan test still passes with `number` set.
6. **`tests/test_support_role_authz.py`**: add `/v1/numbers/owned` to the support-403 admin surfaces list.

### 6.4 UI checks

- `cd docker/ui/app && npm run build` (`tsc -b && vite build`) must pass.
- `npx eslint <changed files>`: no new errors, and React-hooks rules must hold. Full `npm run lint` already fails on existing code and is not in CI.
- Manual matrix:
  - Granite tenant (hybrid: RCF + VM + trunk);
  - RCF-only tenant with no VM: the card must look byte-identical (header "Forwards to", chips All/Forwarding/Paused, same KPI values);
  - readonly tenant;
  - admin All customers;
  - admin `?customer=1`;
  - admin View as Customer (Granite);
  - trunk-only account (no-product prompt unchanged);
  - old-API tolerance (new fields absent → today's behaviour).

### 6.5 Sequencing and deploy

- **Both agents start immediately**, against section 4. The UI uses contract-shaped fixtures and optional fields.
- **Deploy order:**
  1. Migration 57: any time, independent; then run `check_migrations`.
  2. API rebuild on the services VM.
  3. UI rebuild.
  The UI must not ship before the API (`product_type=all` and `/numbers/owned`).
- **Rollback:** UI, then API. The index is harmless to leave.

### 6.6 Post-deploy verification (single-line, East primary, read-only)

```
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT product_type, count(*) FROM number_routing WHERE customer_id = 1 GROUP BY 1 ORDER BY 1;"
hostname | grep -q '^services$' && sudo -u postgres psql -d voip -c "SELECT start_time, direction, destination, on_net, origin_customer_id FROM cdrs WHERE customer_id = 1 AND product_type = 'voicemail' AND leg IS DISTINCT FROM 'B' AND start_time > now() - interval '30 days' ORDER BY start_time DESC LIMIT 20;"
```

The second query confirms the on-net attribution premise: on-net rows must show `destination` = the RCF DID. Then check Granite's Reporting "Your numbers" and the dashboard card show the mailbox DID labelled Voicemail.

---

## 7. Owner decisions (defaults proposed)

- **O1. Billing estimate.** Default: **no voicemail line** (D5 stands); only the stale code comment is fixed.
- **O2. Answer rate.** A call that reached voicemail counts as **answered**, labelled "Answered by voicemail". The alternative (count it as missed, "went to voicemail") would change answer-rate maths on every page.
- **O3. Dashboard call cards** cover **every product on the account**, including SIP-trunk calls for hybrid accounts, matching Reporting's "every call". The alternative is RCF + voicemail only.
- **Design default to confirm:** a forward to voicemail is attributed to the **dialed number** (section 3.2).

## 8. Known limitations (documented, not fixed here)

- **Cross-customer on-net forward to voicemail** (customer B's RCF number → customer A's mailbox): the CDR's `customer_id` is A. B never sees the call. A sees it in totals with no number row, and the call row's `to` shows B's DID. This is pre-existing on-net attribution, tied to the deferred "cross-customer on-net settlement policy" (`docs/ENCRYPTED_VOICEMAIL_BUILD_PLAN.md:178`).
- **Admin `/rcf` console Call activity** stays `product_type=rcf`, so it excludes on-net RCF→VM calls. The dashboard overlay, Reporting and the per-number stats include them. Follow-up: filter the console by "calls on RCF numbers".
- **Voicemail minutes** include greeting, recording and deposit time (FS CDR timing; usually under 1 s of deposit).
- **My Account in admin "View as Customer"** still shows the no-customer notice (pre-existing).

### Critical Files for Implementation
- /Users/KeGrabhorn/custom-voip/.claude/worktrees/numbers-holistic/docker/api/src/routers/reports.py
- /Users/KeGrabhorn/custom-voip/.claude/worktrees/numbers-holistic/docker/postgres/init/54_voicemail.sql (the `number_routing` definition the new helper reads; do not edit)
- /Users/KeGrabhorn/custom-voip/.claude/worktrees/numbers-holistic/docker/api/src/routers/cdrs.py (+ docker/api/src/services/cdr_activity.py)
- /Users/KeGrabhorn/custom-voip/.claude/worktrees/numbers-holistic/docker/ui/app/src/pages/dashboard/accountData.ts (+ NumbersCard.tsx, AccountDashboardView.tsx)
- /Users/KeGrabhorn/custom-voip/.claude/worktrees/numbers-holistic/tests/test_reports.py (+ tests/test_tenant_redaction.py, tests/voicemail_db.py)
