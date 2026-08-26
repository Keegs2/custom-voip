# SBC Active/Standby Runbook — operate the per-zone NLB failover pair

**Scope:** steady-state verification, failover drills, rollback, and failure-mode expectations for the Phase 4b SBC HA pairs. The INITIAL migration command sequence is owned by the migration plan (main session) — it is deliberately NOT in this runbook.
**Who runs what:** all `gcloud` commands run from an authed workstation (never on a VM). All VM commands are single lines, and every destructive VM command is hostname-guarded so a wrong-box paste is a no-op.
**Blueprint / IaC:** `infra/OPENTOFU_PLAN.md` §18. Alerting: `infra/monitoring/sbc_failover.tf`. Live view: Grafana → Production NOC → Traffic Status → "Active SBC per zone" (top row).
**Legend:** 🟢 SAFE read-only · 🟠 IMPACT (drops or risks some calls/setups) · 🔴 destructive — read twice.

## 0. Architecture in 60 seconds — and why it is safe

Each zone's two Kamailio SBCs are a TRUE ACTIVE/STANDBY pair enforced by GCP passthrough-NLB **failover backends** on BOTH traffic planes:

- **External (carrier) plane** — the existing per-zone NLB VIP: primary instance group holds SBC-1 only; SBC-2 sits in a single-VM standby group attached with `--failover`. Policy: `failover-ratio=0`, `drop-traffic-if-unhealthy`, `no-connection-drain-on-failover` → ALL traffic to SBC-1 while it is healthy, standby serves ONLY while the primary is unhealthy, failback is automatic and immediate.
- **Internal (signaling) plane** — a NEW per-zone internal passthrough NLB ("signaling VIP", `L3_DEFAULT`/all-ports) over the SAME two groups, SAME health check, SAME policy. FreeSWITCH targets it (`SBC_PROXY_IP` in the media VM `.env`) for outbound B-legs: UDP 5060 SIP + the TCP 5060 pre-check. Both planes share one health check, so they elect the SAME active SBC.
- **Health check** (shared, per zone — DISCOVERY-CONFIRMED 2026-08-26): the **`{east|west|central}-sbc-fs-aware-hc` HTTP checks** (the FS-aware /healthz from the trunk-redundancy work; interval 5s, unhealthy 2 → **~10-12 s detection**). This is BETTER than a plain TCP:5060 probe: a hung Kamailio fails HTTP even while TCP still accepts, and FS-death fails BOTH SBCs → `drop-traffic-if-unhealthy` darkens the zone VIP → Bandwidth retries other zones (the designed zone-level failover). The TCP `sbc-health-check`/`west-`/`central-sbc-health-check` resources exist but are NOT attached to the SBC backend services.
- **Kamailio side:** each SBC binds + inner-Record-Routes the zone's signaling VIP (`SBC_SIGNALING_VIP` env; the entrypoint puts the VIP on `dev lo`). `SBC_PROXY_IP_FAILOVER` on the media VM stays a DIRECT SBC VPC IP (the zone's SBC-1) as an ILB-bypass fallback — see failure modes.

**Why established calls survive an SBC death:** in-dialog routing is STATELESS (`docker/kamailio/CLAUDE.md` §8.10, PR #71) — in-dialog requests (ACK/BYE/re-INVITE) are routed from information carried in the Route set (`;fs=` dispatch), not from per-SBC dialog state, so WHICHEVER SBC the VIP delivers to can relay them. Media never touches the SBCs (RTP is FS↔carrier). So when an SBC dies: audio continues uninterrupted, and hangups signal correctly through the survivor. **What is lost:** call setups in flight during the ~10-12 s flip (INVITE transactions living on the dead SBC). UDP INVITE retransmits landing on the standby can self-recover some of these; the rest fail and the caller redials. This "established survive, setups-in-flight lost" semantic is the industry-standard HA bar for SBC pairs.

**What this does NOT protect (know before you need it):** FreeSWITCH death (zone-wide — BOTH SBCs fail the fs-aware HC, the VIP goes dark by design and Bandwidth retries other zones, see §6), the services VM / DB (own runbooks: `docs/runbooks/DB_FAILOVER_RUNBOOK.md`), and carrier PoP failure (Kamailio's own 5xx carrier failover + Bandwidth multi-VIP handle that).

### Zone quick reference

| | East | West | Central |
|---|---|---|---|
| Region / zone | us-east1 / us-east1-b | us-west1 / us-west1-b | us-central1 / us-central1-b |
| PRIMARY SBC (VM) | `poc-custom-voip` (10.142.0.100) | `west-sbc-1` (10.138.0.100) | `central-sbc-1` (10.128.0.100) |
| STANDBY SBC (VM) | `kam-g2` (10.142.0.101) | `west-sbc-2` (10.138.0.101) | `central-sbc-2` (10.128.0.101) |
| External VIP | 34.24.133.82 | 35.252.214.40 | 35.253.133.230 |
| Signaling VIP (ILB) | 10.142.0.250 † | 10.138.0.250 † | 10.128.0.250 † |
| Backend service (ext) | `sbc-backend` | `west-sbc-backend` | `central-sbc-backend` |
| Backend service (ILB) | `sbc-signaling-backend` | `west-sbc-signaling-backend` | `central-sbc-signaling-backend` |
| Primary / standby group | `sbc-group` / `sbc-standby-group` | `west-sbc-group` / `west-sbc-standby-group` | `central-sbc-group` / `central-sbc-standby-group` |
| Health check (attached, HTTP fs-aware) | `east-sbc-fs-aware-hc` | `west-sbc-fs-aware-hc` | `central-sbc-fs-aware-hc` |
| FreeSWITCH VM | `fs-media-v2` | `west-fs` | `central-fs` |

† Confirm the reserved signaling VIPs (authoritative over this table): `gcloud compute addresses list --project=rugged-night-193017 --filter='name~signaling' --format='table(name,region,address)'`

All commands below are written for **East**; substitute the row above for West/Central (names, region, zone, hostnames).

## 1. Steady-state verification 🟢 (run any time; part of the weekly eyeball)

1. **Which SBC is the LB serving?** `gcloud compute backend-services get-health sbc-backend --region=us-east1 --project=rugged-night-193017`
   - **Healthy steady state:** BOTH groups listed, every instance `healthState: HEALTHY`. Traffic goes to the PRIMARY group whenever it has a healthy instance — a HEALTHY standby is idle by design, not broken.
   - **Failed-over state:** primary instance `UNHEALTHY` (or the VM gone), standby `HEALTHY` → the zone is running on the standby.
2. **Signaling plane agrees:** `gcloud compute backend-services get-health sbc-signaling-backend --region=us-east1 --project=rugged-night-193017` — must show the same picture as step 1 (same health check; a disagreement means an LB-plane problem, not an SBC problem).
3. **Grafana:** Traffic Status → "Active SBC per zone" — exactly one green card per zone (the primary), idle standby neutral at 0. Green on the standby card = you are failed over right now.
4. **On an SBC** 🟢: `sudo docker ps --filter name=voip-kamailio` and `curl -s 127.0.0.1:8080/metrics | grep -m3 kamailio_dialog_active_dialogs`
5. **From the FS VM (signaling-VIP dataplane + pre-check path)** 🟢: `nc -vz -w1 10.142.0.250 5060` → expect `succeeded` (this is exactly the TCP pre-check FS runs before bridging).
6. **End-to-end** 🟢: call the live test DID `+16174544217` → it must forward to `+17744045256`.

## 2. Planned failover drill 🟠 (quiet hours; loses setups in flight during the two ~10-12 s flips)

Do this per zone after any Kamailio/LB change, and on a monthly cadence. East shown; the drill exercises failover, established-call survival, new-call service on the standby, and automatic failback.

1. 🟢 Pre-state: run §1 steps 1+3 — primary serving, both healthy.
2. 🟢 Establish a test call: dial `+16174544217`, confirm two-way audio, KEEP IT UP for the whole drill.
3. 🟠 Stop Kamailio on the PRIMARY (hostname-guarded; the guard makes a wrong-box paste a silent no-op): `hostname | grep -q '^poc-custom-voip$' && cd /opt/revup && sudo docker compose -f docker-compose.sbc.yml stop kamailio`
4. 🟢 Watch the flip (re-run until it shows primary UNHEALTHY + standby HEALTHY — expect ~10-12 s detection, up to ~30 s for the CLI to reflect it): `gcloud compute backend-services get-health sbc-backend --region=us-east1 --project=rugged-night-193017`
5. 🟢 Verify the ESTABLISHED call: audio still flowing on the step-2 call (it never touched the dead SBC's media — there is none), then hang it up and confirm it tears down cleanly (BYE relays via the standby — §8.10 stateless in-dialog; no ~30 s zombie, no 481/408 burst in Homer).
6. 🟢 Verify NEW calls: dial `+16174544217` again → completes via the standby. Grafana top row: standby card goes green.
7. 🟠 Restore the primary: `hostname | grep -q '^poc-custom-voip$' && cd /opt/revup && sudo docker compose -f docker-compose.sbc.yml start kamailio`
8. 🟢 Watch automatic failback (~10-12 s after Kamailio answers its fs-aware /healthz; NO manual step — `failover-ratio=0` + no drain reverts traffic the moment the primary is healthy): re-run the step-4 command until primary is HEALTHY again, then place one more test call and confirm the Grafana primary card re-greens within ~10 min (the panel window).
9. 🟢 Log it in §8.

**Expected alert behavior during this drill:** NO GCM page — the primary VM stays up (hypervisor metrics flow), and the zone VIP stays reachable (that is the point). The flip is visible only in get-health + the Grafana row. If the SIP VIP uptime page DOES fire during a drill, the standby did not take over — stop and investigate.

## 3. Mid-call kill drill 🔴 (full-fidelity: VM death while calls are up)

Variant A (container SIGKILL — no VM-death page, faster to run): as §2 but step 3 uses `hostname | grep -q '^poc-custom-voip$' && cd /opt/revup && sudo docker compose -f docker-compose.sbc.yml kill kamailio`

Variant B (VM stop — exercises the page + hypervisor path; workstation, triple-check name+zone before Enter):
1. 🟢 §2 steps 1–2 (pre-state + establish the call).
2. 🔴 `gcloud compute instances stop poc-custom-voip --zone=us-east1-b --project=rugged-night-193017`
3. 🟢 Same verifications as §2 steps 4–6. ADDITIONALLY expect the GCM page **"[CRITICAL] East primary SBC DOWN — zone failed over to standby kam-g2"** within ~2–3 min (and the generic "VM down" at ~5 min).
4. 🟠 `gcloud compute instances start poc-custom-voip --zone=us-east1-b --project=rugged-night-193017`
5. 🟢 After boot, on the primary: `sudo docker ps --filter name=voip-kamailio` (compose restart policy should bring Kamailio up; if not: `cd /opt/revup && sudo docker compose -f docker-compose.sbc.yml up -d`). Then confirm failback per §2 step 8 and that the incidents auto-resolve.

## 4. Unplanned failover — triage order

1. 🟢 Confirm what the LB thinks (§1 steps 1–2). If the standby is serving: calls are flowing — you have time. Breathe.
2. 🟢 Place a new test call through the zone (`+16174544217`).
3. 🟢 Read the page: VM-death page fired → GCP console for the instance (crashed/stopped/host event). No page but Grafana shows the standby green → Kamailio died or hung with the VM up: on the primary, `sudo docker ps -a --filter name=voip-kamailio` + `sudo docker logs --tail 100 voip-kamailio`.
4. 🟠 Recover the primary (VM start, or `hostname | grep -q '^poc-custom-voip$' && cd /opt/revup && sudo docker compose -f docker-compose.sbc.yml up -d`). Failback is automatic.
5. 🟢 Confirm failback (§2 step 8) and spot-check teardown quality in Homer (no 481/408 bursts).
6. If the STANDBY is also unhealthy → the zone front door is dark: the "SIP VIP unreachable" page fires; Bandwidth's retry against the other zones' VIPs limits blast radius. Zone recovery is now the incident — both SBCs, then §6's "both SBCs dead" row.

## 5. Rollback — return to pre-Phase-4b active/active 🟠

Use when active/standby itself is causing harm. Order matters: **a VM may not sit in two instance groups attached to the same backend service**, so remove the failover backends BEFORE re-adding SBC-2 to the primary group. East shown; repeat per zone from the §0 table.

1. 🟠 Detach the standby group from the external backend service: `gcloud compute backend-services remove-backend sbc-backend --region=us-east1 --instance-group=sbc-standby-group --instance-group-zone=us-east1-b --project=rugged-night-193017`
2. 🟠 Detach it from the signaling backend service too: `gcloud compute backend-services remove-backend sbc-signaling-backend --region=us-east1 --instance-group=sbc-standby-group --instance-group-zone=us-east1-b --project=rugged-night-193017`
3. 🟠 Put SBC-2 back in the primary group (restores 2-way CLIENT_IP distribution immediately): `gcloud compute instance-groups unmanaged add-instances sbc-group --zone=us-east1-b --instances=kam-g2 --project=rugged-night-193017`
4. 🟢 Clear the (now-inert) failover policy so config matches behavior: `gcloud compute backend-services update sbc-backend --region=us-east1 --no-drop-traffic-if-unhealthy --project=rugged-night-193017` (same for `sbc-signaling-backend`; do NOT pass `--connection-drain-on-failover` — draining-on-failover is unsupported on non-TCP backend services and the flag can error).
5. 🟠 Repoint FreeSWITCH at the direct SBC IPs: on the media VM edit `/opt/revup/.env` → `SBC_PROXY_IP=10.142.0.100` and `SBC_PROXY_IP_FAILOVER=10.142.0.101`, then recreate FS. **This restart DROPS the zone's active calls** — maintenance window. Orphan gotcha first, then up: `hostname | grep -q '^fs-media-v2$' && sudo killall -9 freeswitch; hostname | grep -q '^fs-media-v2$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d`
6. 🟢 Health check: nothing to revert (migration never changed the attached `*-sbc-fs-aware-hc` checks).
7. 🟢 Leave in place, harmless: the signaling ILB (unused once FS points at direct IPs — do NOT delete the reserved VIP; it is baked into blueprints/envs) and Kamailio's `SBC_SIGNALING_VIP` listen/alias (telephony owner removes it on their own schedule).
8. 🟢 Verify: get-health shows TWO instances in `sbc-group`, both HEALTHY; test call; Grafana top row will show BOTH cards green as calls spread — expected in active/active.
9. Update `infra/monitoring` if rollback is permanent (the "SBC failover state" pages assume a designated primary): set `sbc_failover_pairs = {}` in `terraform.tfvars` and `tofu apply`.

## 6. Failure modes — what you will see, what the LB does, what you do

| Failure | How you find out | LB behavior | Call impact | Your move |
|---|---|---|---|---|
| **Primary VM dead** (crash/stop/host event) | GCM "[CRITICAL] {zone} primary SBC DOWN" ~2–3 min; get-health UNHEALTHY; Grafana standby card green | Both planes flip to standby in ~6 s | Established calls SURVIVE; setups in flight during the flip lost (UDP retransmits recover some); new calls via standby | Recover the VM (§4); failback automatic |
| **Kamailio dead/hung, VM up** (container OOM/crash, wedged process not accepting TCP) | NO VM page (hypervisor metrics still flow). Grafana row + get-health show it; VIP uptime stays green | Same ~10-12 s flip (fs-aware /healthz refused/timed out) | Same as above | Restart the container (hostname-guarded, §4 step 4) |
| **Kamailio wedged but still ACCEPTING TCP** (worst case: healthy-looking zombie) | Live ASR collapse on Traffic Status; ASR watchdog `revup-alert` page; customer reports | NO flip — health check passes | New calls failing on the primary | FORCE the flip: stop Kamailio on the primary (§2 step 3), fix, then restore |
| **FreeSWITCH dead (zone-wide)** | vm_down page (~5 min) / FS-aware OPTIONS-503 toward carrier probes / zone ASR to zero | BOTH SBCs fail the fs-aware HC → `drop-traffic-if-unhealthy` darkens the zone VIP (no spraying a dead-media zone); Bandwidth retries its other VIPs | ALL in-zone calls fail; established media dead | Zone-level failover only: Bandwidth retries its other VIPs on failure. Recover FS (`sudo killall -9 freeswitch` orphan gotcha, then compose up) |
| **Signaling ILB dark, SBCs fine** (forwarding-rule/backend misconfig, rare LB dataplane issue) | Outbound forwards briefly slow then continue; FS logs show pre-check failing on `SBC_PROXY_IP` | External plane unaffected (inbound fine) | FS TCP pre-check marks the VIP dead in <1 s (cached 10 s) → falls back to `SBC_PROXY_IP_FAILOVER` (SBC-1 DIRECT IP) → outbound B-legs continue | Verify the ILB trio exists (`gcloud compute forwarding-rules describe sbc-signaling-fwd --region=us-east1 --project=rugged-night-193017`); restore it; no FS restart needed for the fallback itself |
| **Standby VM dead, primary fine** | vm_down page ~5 min (the failover page watches primaries only) | None — no traffic moves | None | Restore it promptly — you are one failure from a zone outage |
| **Both SBCs dead** | "[CRITICAL] SIP front door DOWN ({zone})" uptime page; both failover + vm_down pages | drop-traffic-if-unhealthy → VIP goes dark (no spraying dead backends) | Zone dark; Bandwidth retries other zones' VIPs | All-hands: recover either SBC first (any one restores the zone), then the other |

## 7. Observability map (what fires when)

| Surface | Signal | Latency | Covers |
|---|---|---|---|
| GCM "SBC failover state — {zone} primary down" (`infra/monitoring/sbc_failover.tf`) | Primary SBC VM stopped reporting hypervisor metrics | ~2–3 min | VM death only (by design — same metric family as vm_down) |
| GCM "VM down (metrics absent)" | Any production VM dark 5 min | ~5–6 min | Primary AND standby AND everything else |
| GCM "SIP VIP {zone} unreachable" | Whole front door dark (both SBCs) | ~1–2 min | Total zone signaling failure |
| Grafana Traffic Status "Active SBC per zone" | Which SBC owns live dialogs (10 m window) | ~15 s scrape | Every flip, including container-level and drills |
| `gcloud compute backend-services get-health ...` | Authoritative LB election | on demand | Ground truth for both planes |
| `revup-alert` ASR watchdog | Calls failing while everything looks "healthy" | minutes | The healthy-zombie case |

## 8. Drill log (append a row per drill/incident — same discipline as the DB runbook)

| Date | Zone | Type (planned §2 / kill §3 / real) | Flip time observed | Established call survived | Setups lost noted | Failback clean | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## 9. One-time migration (active/active → active/standby) — historical record

Executed per zone, West → Central → East, off-peak. Prerequisites: the `feat/sbc-active-standby` PR merged; SBC images rebuilt on the new code (a no-op until `SBC_SIGNALING_VIP` is set).

**Phase A — discovery 🟢 (once, before anything):** confirm live resource names/shapes; the §0 table is authoritative only after this check.
1. `gcloud compute forwarding-rules list --project=rugged-night-193017 --format='table(name,region,IPAddress,IPProtocol,portRange,backendService)'`
2. `gcloud compute backend-services list --project=rugged-night-193017 --format='table(name,region,protocol,healthChecks,sessionAffinity)'` — if a zone has SEPARATE UDP and TCP backend services, Phase C steps 4–5 must be applied to EACH.
3. `gcloud compute health-checks list --project=rugged-night-193017 --format='table(name,region,type,tcpHealthCheck.port,checkIntervalSec,unhealthyThreshold)'` — note global vs regional (regional needs `--region` on update).
4. `gcloud compute instance-groups list --project=rugged-night-193017`

**Phase B — SBC code deploy 🟢 (all 6 SBCs, one at a time, no env change yet):** standard pull + build + `kamailio -c` gate + recreate. Behavior is byte-identical with the env unset (proven in the PR).

**Phase C — per-zone GCP (West shown; substitute the §0 table for other zones):**
1. 🟢 Reserve the signaling VIP: `gcloud compute addresses create west-sbc-signaling-vip --region=us-west1 --subnet=default --addresses=10.138.0.250 --project=rugged-night-193017` (if taken, omit `--addresses` and read back the assignment; update `.env`s, `ip-alias.lua`, and the §0 table accordingly)
2. 🟢 Create the standby group: `gcloud compute instance-groups unmanaged create west-sbc-standby-group --zone=us-west1-b --project=rugged-night-193017`
3. 🟠 Move SBC-2 out of the serving group (flows pinned to it rehash to SBC-1; established calls survive via stateless in-dialog, setups in flight on SBC-2 may drop): `gcloud compute instance-groups unmanaged remove-instances west-sbc-group --zone=us-west1-b --instances=west-sbc-2 --project=rugged-night-193017` then `gcloud compute instance-groups unmanaged add-instances west-sbc-standby-group --zone=us-west1-b --instances=west-sbc-2 --project=rugged-night-193017`
4. 🟢 ~~Health-check retune~~ SKIPPED (discovery 2026-08-26): the attached `*-sbc-fs-aware-hc` HTTP checks are already 5s/unhealthy-2 (~10-12 s detection) and are shared with live inbound — left untouched. Optional later tightening: `gcloud compute health-checks update http west-sbc-fs-aware-hc --region=us-west1 --check-interval=3s --timeout=2s --project=rugged-night-193017`
5. 🟠 External plane failover: `gcloud compute backend-services add-backend west-sbc-backend --region=us-west1 --instance-group=west-sbc-standby-group --instance-group-zone=us-west1-b --failover --project=rugged-night-193017` then `gcloud compute backend-services update west-sbc-backend --region=us-west1 --failover-ratio=0 --drop-traffic-if-unhealthy --no-connection-drain-on-failover --project=rugged-night-193017` (discovery 2026-08-26: each zone has ONE `UNSPECIFIED`-protocol backend service serving both UDP+TCP rules — nothing to repeat)
6. 🟢 Signaling ILB (same fs-aware HC as the external plane so BOTH planes elect the SAME active SBC): `gcloud compute backend-services create west-sbc-signaling-backend --region=us-west1 --load-balancing-scheme=INTERNAL --protocol=UNSPECIFIED --health-checks=west-sbc-fs-aware-hc --health-checks-region=us-west1 --project=rugged-night-193017` · add primary `gcloud compute backend-services add-backend west-sbc-signaling-backend --region=us-west1 --instance-group=west-sbc-group --instance-group-zone=us-west1-b --project=rugged-night-193017` · add standby `gcloud compute backend-services add-backend west-sbc-signaling-backend --region=us-west1 --instance-group=west-sbc-standby-group --instance-group-zone=us-west1-b --failover --project=rugged-night-193017` · policy `gcloud compute backend-services update west-sbc-signaling-backend --region=us-west1 --failover-ratio=0 --drop-traffic-if-unhealthy --no-connection-drain-on-failover --project=rugged-night-193017` · rule `gcloud compute forwarding-rules create west-sbc-signaling-fwd --region=us-west1 --load-balancing-scheme=INTERNAL --network=default --subnet=default --address=west-sbc-signaling-vip --ip-protocol=L3_DEFAULT --ports=ALL --backend-service=west-sbc-signaling-backend --project=rugged-night-193017`
7. 🟢 Verify both planes elect SBC-1: §1 steps 1–2.

**Phase D — per-zone env cutover:**
1. 🟢 STANDBY SBC first: add `SBC_SIGNALING_VIP=10.138.0.250` to `/opt/revup/.env`, recreate kamailio (config gate), confirm startup log shows `SIGNALING_VIP=… (dedicated)` and `ip addr show dev lo` has the VIP.
2. 🟠 PRIMARY SBC same change — its restart causes one real ~6 s flip to the standby and automatic failback (an unplanned mini-drill; watch §1 step 1 recover).
3. 🟠 Media VM: `/opt/revup/.env` → `SBC_PROXY_IP=10.138.0.250` and `SBC_PROXY_IP_FAILOVER=10.138.0.100`, then recreate FS (DROPS the zone's active calls — maintenance window): `hostname | grep -q '^west-fs$' && sudo killall -9 freeswitch; hostname | grep -q '^west-fs$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d --force-recreate`
4. 🟢 Acceptance: test call completes; Homer shows the B-leg INVITE arriving at the signaling VIP and the 200 OK toward FS carrying `Record-Route: <sip:10.138.0.250:5060;r2=on;fs=5090;lr>`; far-end hangup draws a single BYE 200 OK (no retransmit storm); `kamcmd dlg.stats_active` returns to 0.

**Phase E — drills:** §2 planned failover, then §3 variant A, in the migrated zone before starting the next zone. Log in §8.
