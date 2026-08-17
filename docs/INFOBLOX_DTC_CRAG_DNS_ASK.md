# Infoblox DTC — `crag.granitevoip.com` (AMENDED ASK v2 — topology geo-steering)

**To:** Granite Infrastructure / DNS team
**From:** Telephony Engineering (Keegan)
**Amends:** the pending DTC request for `crag.granitevoip.com` (originally round-robin). Everything from the original ask still applies **except the load-balancing method** — please build it as **Topology** per below.

## Objective

One customer-facing SIP hostname, `crag.granitevoip.com`, that steers each customer's SIP trunk to the **geographically nearest healthy** Granite voice zone — not round-robin. Health behavior is unchanged from the original ask: a zone whose media core is down answers SIP OPTIONS with 503 and must leave rotation within TTL.

## DTC objects (unchanged from v1)

| Object | Value |
|---|---|
| DTC Server 1 — `crag-east` | `34.24.133.82` (us-east1 VIP) |
| DTC Server 2 — `crag-west` | `35.252.214.40` (us-west1 VIP) |
| DTC Server 3 — `crag-central` | `35.253.133.230` (us-central1 VIP) |
| Health monitor | **SIP OPTIONS to public UDP/5060, expect 200** (our SBCs answer 200 when the zone is healthy, **503 when its media core is down** — that 503 must mark the server down) |
| LBDN | `crag.granitevoip.com`, **A record, TTL 30** |
| Optional | `_sip._udp.crag.granitevoip.com` SRV → the same pool |

Pools: one per zone (`east-pool`/`central-pool`/`west-pool`), each containing its single zone server. (Structure them as three pools so topology rules can target pools; if your NIOS pattern prefers rules→servers directly, equivalent is fine.)

## CHANGED: load-balancing method = Topology

LBDN/pool LB method: **Topology**, with a ruleset evaluated in order (NIOS "first match with an available destination" — this is what composes geo-steering with the health monitor: a matched-but-unhealthy zone falls through to the next rule).

**Topology ruleset `crag-geo`, in order:**

1. **Subnet rules — known customers (we supply and maintain this list).** Each onboarded SIP trunk customer authenticates by source IP, so we hold an authoritative registry of their public prefixes and will assign each a home zone at provisioning. Initial list to be supplied by us at cutover in the form `prefix → pool`; expect ongoing adds (one rule per customer prefix). These give deterministic steering regardless of which resolver the customer uses.
2. **Geography rules — regional catch-all** (requires a MaxMind GeoIP2 or GeoLite2 City/Country database loaded in NIOS — please confirm which you have licensed; GeoLite2 is acceptable):
   - `west-pool`: WA OR CA NV ID MT WY UT CO AZ NM AK HI
   - `central-pool`: ND SD NE KS OK TX MN IA MO AR LA WI IL
   - `east-pool`: everything else US + default-US
   - Non-US: `east-pool` (international trunks are rare; East is the services hub)
3. **Fallback rule — any healthy zone** (global availability / all-pools) so a query never goes unanswered while at least one zone is up.

**ECS:** if the grid's NIOS version supports preferring the EDNS Client Subnet address for DTC decisions, please enable it — most of our customers resolve from their own networks so it's a minor win, but it costs nothing.

## Still needed from you (unchanged from v1)

1. Confirm DTC licensing on the grid and **SIP OPTIONS monitor support** (fallback if unsupported: we can expose an HTTP `/healthz` publicly instead — tell us and we'll adjust).
2. Confirm public DNS authority for `crag.granitevoip.com` (zone `granitevoip.com` is ours; the LBDN needs to be served authoritatively by the DTC-enabled members).
3. **Your monitor source IPs** — we will then open GCP firewall for those IPs to the three VIPs on **UDP/5060** before you enable monitors.
4. NEW: confirm the GeoIP database (product + update cadence) available for geography rules.

## After you build

We will: supply the initial customer subnet→pool list, verify steering from East/Central/West vantage points, verify the 503→pull behavior per zone (we can fail a zone's media core on demand in a maintenance window), then move customer onboarding to the hostname.

---

## PHASE 2 (build now, cut over later): second LBDN for carrier origination — `orig.granitevoip.com`

Bandwidth's SIP-peer portal accepts DNS hosts in "Voice IP addresses / DNS hosts", so the SAME DTC infrastructure can eventually steer carrier-originated traffic (RCF and all inbound DIDs) — but with its own LBDN and ruleset, kept separate from the customer-trunk hostname for independent blast radius and per-audience rules.

**Please build alongside Phase 1 (same pools, same monitors):**

| Object | Value |
|---|---|
| LBDN 2 | `orig.granitevoip.com`, A record, TTL 30, LB method **Topology** |
| Ruleset `orig-geo` | (1) **Subnet rules for Bandwidth's PoPs** — their edge resolvers are the query sources, and we know their ranges: Dallas `67.231.2.12`, Los Angeles `216.82.238.134`, plus the TC1 (NY/ATL) and TC2 (DAL/LA) PoP addresses we will supply as a prefix list. Map: LA/TC2-LA → `west-pool`; DAL/TC2-DAL → `central-pool`; NY/ATL → `east-pool`. (2) Geography rules as in Phase 1. (3) Global-availability fallback. |
| Response size | If DTC supports returning MULTIPLE ordered A records for this LBDN, return the selected pool's VIP first with the other healthy VIPs after it (see migration note). Single-record is acceptable if not. |

**Why separate from `crag.granitevoip.com`:** carrier ingress and customer ingress have different steering rules (known carrier PoPs vs per-customer prefixes), different change cadence, and we want per-audience monitoring and the ability to drain one audience without the other.

**Cutover plan (ours, not yours — for context):** Phase 1 (customer trunks) proves DTC in production first. Then, in the Bandwidth portal, we set the origination host list to `orig.granitevoip.com` FIRST followed by the three static VIPs — Bandwidth walks the list with sequential failover, so DNS becomes the steered primary and the static IPs remain a safety net. No flag-day.

**Open items we own before cutover (tracked, not blocking your build):**
- Confirm with Bandwidth how their proxies resolve DNS hosts (per-call vs cached, TTL 30 honored, single vs multiple A records consumed, SRV support).
- Supply you the authoritative Bandwidth PoP prefix list for the subnet rules.

*Questions → Keegan (Telephony Engineering). The SBC-side 200/503 OPTIONS behavior is already live in all six SBCs (`FS_AWARE_OPTIONS`).*
