# FS Media HA Runbook — build + operate the per-zone active/standby FreeSWITCH pair

**Scope:** the Phase 4c media-HA buildout (one hot-standby FreeSWITCH per zone) AND its steady-state operation: pre-window VM build, in-window SBC enrollment, acceptance drills, rollback, and failure-mode expectations. The Kamailio-side mechanics (`FREESWITCH_IP_2`, priority dispatcher selection, per-call `fsn` in-dialog markers, any-FS `/healthz`) are owned by the telephony change — referenced here, specified there.
**Who runs what:** the OPERATOR runs ALL `gcloud` commands from an authed workstation (never on a VM) and ALL VM commands. VM commands are single lines; every destructive VM command is hostname-guarded so a wrong-box paste is a no-op.
**Blueprint / IaC:** `infra/OPENTOFU_PLAN.md` §19. Monitoring enrollment: `infra/monitoring/variables.tf` (`var.instances`) + the NOC dashboards (this PR). Sibling runbook this mirrors: `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md`.
**Legend:** 🟢 SAFE read-only / non-disruptive · 🟠 IMPACT (drops or risks some calls/setups) · 🔴 destructive — read twice.

## 0. Architecture in 60 seconds — and what it does (and does not) buy

Each zone gains a SECOND FreeSWITCH (`{zone}-fs-2`) that runs **fully hot** — containers up, sofia profiles RUNNING, DB connected, metrics flowing — but receives **ZERO new calls while FS-1 is healthy**. This is STRICT active/standby, mirroring the SBC pair model, enforced at the SIP layer (NOT by any GCP load balancer):

- **Selection:** each zone's Kamailio SBCs learn a second dispatcher destination (`FREESWITCH_IP_2`) with **priority selection**: all new INVITEs go to FS-1; the SBCs' OPTIONS probing declares FS-1 dead within the probe window (seconds — exact interval/threshold per the telephony change) and only then do NEW calls flow to FS-2. **Failback is automatic** — the moment FS-1 answers probes again, new calls return to it.
- **In-dialog routing:** during failover/failback windows **BOTH FS hold live calls** simultaneously (old calls finishing on one, new calls landing on the other). In-dialog requests (ACK/BYE/re-INVITE) follow the per-call **`fsn` marker** each dialog carries in its Route set, so either SBC delivers every in-dialog request to the FS that owns that call — the dispatcher flip never strands an established call's signaling.
- **What this COVERS:** an FS-1 death (container crash, VM death, hung process failing probes) stops being a zone-darkening event — NEW calls complete via FS-2 within the probe window and the zone VIP stays up. **This exact scenario (one FS dead = whole zone dark) is what tonight removes.**
- **What this does NOT cover — know before you need it:**
  - **Established calls on a dying FS are LOST.** FreeSWITCH is the B2BUA media anchor — RTP terminates on the box. When it dies, its calls' audio dies with it; callers hang up and redial (the redial completes via FS-2). This is the industry-standard semantic for media-server HA; nothing tonight changes it.
  - **Both-FS-dead darkens the zone exactly as today:** the (now any-FS) `/healthz` fails on BOTH SBCs → `drop-traffic-if-unhealthy` darkens the zone VIP → Bandwidth retries its other VIPs. Blast radius identical to the current single-FS zone-dark behavior.
  - **API-originated calls (East) do NOT fail over tonight.** The East API's `FREESWITCH_ESL_HOST` pins to `fs-media-v2` (192.168.10.2); ESL originates (`POST /v1/calls`, x402 demo, admin tools) fail while East FS-1 is down even though inbound RCF is riding east-fs-2. ACCEPTED for tonight. One-line future option: make the API's ESL client healthz-aware (try FS-1, fall back to FS-2's ESL on connect failure) — a small `esl_client.py` change, no infra.
  - Services VM / DB / carrier failures — own runbooks, unchanged.

### Zone quick reference

| | East | West | Central |
|---|---|---|---|
| Region / zone | us-east1 / us-east1-b | us-west1 / us-west1-b | us-central1 / us-central1-b |
| FS-1 (ACTIVE) | `fs-media-v2` (192.168.10.2 · ext 34.139.119.135) | `west-fs` (192.168.20.2 · ext 8.229.177.165) | `central-fs` (192.168.30.2 · ext 35.253.103.114) |
| **FS-2 (HOT STANDBY, NEW)** | `east-fs-2` (192.168.10.3 · ext = `east-fs-2-ip`, fill ‡) | `west-fs-2` (192.168.20.3 · ext = `west-fs-2-ip`, fill ‡) | `central-fs-2` (192.168.30.3 · ext = `central-fs-2-ip`, fill ‡) |
| Machine type / subnet / tags (both FS) | e2-standard-8 / `voip-media` / voip-media, bypass-vpn | e2-standard-8 / `voip-media-west` / voip-media, bypass-vpn | e2-standard-8 / `voip-media-central` / voip-media, bypass-vpn |
| NEW reserved IPs | `east-fs-2-ip` (ext) + `east-fs-2-internal` (192.168.10.3) | `west-fs-2-ip` + `west-fs-2-internal` (192.168.20.3) | `central-fs-2-ip` + `central-fs-2-internal` (192.168.30.3) |
| SBC pair (gets `FREESWITCH_IP_2`) | `poc-custom-voip` (primary) / `kam-g2` (standby) | `west-sbc-1` / `west-sbc-2` | `central-sbc-1` / `central-sbc-2` |
| Signaling VIP (healthz probe path) | 10.142.0.250 | 10.138.0.250 | 10.128.0.250 |
| Zone VIP (must NEVER darken in §3) | 34.24.133.82 | 35.252.214.40 | 35.253.133.230 |
| HEP capture ID FS-1 / FS-2 | 200 / **201** | 210 / **211** | 220 / **221** |
| FS-2 `FS_NODE_ID` (metrics `reporting_instance`) | `east-fs-2` | `west-fs-2` | `central-fs-2` |
| Local DB (`DB_HOST`, unchanged — comes with the clone) | 10.142.0.103 | 10.138.0.2 | 10.128.0.2 |

‡ External IPs are GCP-assigned at reservation (Phase A step 1). Record them HERE, in `docker/homer/scripts/ip-alias.lua` (uncomment + fill the two `FreeSWITCH-2` placeholder lines per zone), and in the §19.1 tfvars note.

Commands below are written for **West** (the first zone in the window); substitute this table for Central/East (names, region, zone, subnet, hostnames).

## 1. Phase A — pre-window: build the FS-2 fleet 🟢 (non-disruptive; run for all 3 zones any time before the window)

Nothing in Phase A touches a serving component. The result is a hot, fully-built FS-2 per zone that **receives no traffic because no SBC references it yet**. Mirrors how `west-fs`/`central-fs` themselves were built (machine-image clone — `infra/WEST_ZONE_BUILDOUT.md` Step 4).

1. 🟢 Reserve the external IP (GCP picks the address): `gcloud compute addresses create west-fs-2-ip --region=us-west1 --project=rugged-night-193017`
2. 🟢 Read it back and RECORD it (in §0 ‡ + the `ip-alias.lua` placeholders): `gcloud compute addresses list --project=rugged-night-193017 --filter='name~fs-2' --format='table(name,region,address,status)'`
3. 🟢 Reserve the internal IP on the zone's media subnet: `gcloud compute addresses create west-fs-2-internal --region=us-west1 --subnet=voip-media-west --addresses=192.168.20.3 --project=rugged-night-193017` (if `.3` is somehow taken, omit `--addresses`, read back the assignment, and use THAT value everywhere `FREESWITCH_IP_2`/ip-alias/§0 say `.3`)
4. 🟢 Machine image from the RUNNING FS-1 (no downtime; crash-consistent is fine for a media VM — repo checkout + docker images, no database. Sanity: nothing stateful was ever hand-added to the FS-1s; the East sandbox PG replica lives on the legacy `fs-media` VM, NOT `fs-media-v2`): `gcloud compute machine-images create west-fs-2-image --source-instance=west-fs --source-instance-zone=us-west1-b --project=rugged-night-193017`
5. 🟢 Create the VM — mirrors FS-1 exactly (machine type, media subnet, tags; the reservation NAMES are legal values for `address=`/`private-network-ip=`): `gcloud compute instances create west-fs-2 --zone=us-west1-b --source-machine-image=west-fs-2-image --machine-type=e2-standard-8 --network-interface=subnet=voip-media-west,private-network-ip=192.168.20.3,address=west-fs-2-ip --tags=voip-media,bypass-vpn --project=rugged-night-193017`
   - **`bypass-vpn` is NON-NEGOTIABLE** (dead-VPN blackhole route lesson, `infra/WEST_ZONE_BUILDOUT.md`) and the media subnet keeps the VM out of Cloud NAT (the "Cloud NAT breaks VoIP" lesson). Both are what "mirror FS-1" means.
6. 🟠 (cosmetic) **Identity window:** the clone boots FS-1's full stack with FS-1's `.env`, so for a few minutes it ships metrics/HEP labeled AS FS-1 (duplicate `reporting_instance`/capture-id — cosmetic only; ZERO call impact: no SBC dispatches to it and it originates nothing). SSH in promptly and quiesce (hostname-guarded): `hostname | grep -q '^west-fs-2$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml down` then `hostname | grep -q '^west-fs-2$' && sudo killall -9 freeswitch`
7. 🟢 Pull current code (the merged FS-HA PR): `hostname | grep -q '^west-fs-2$' && cd /opt/revup && sudo git pull`
8. 🟢 Edit `/opt/revup/.env` **per the telephony change's FS-2 `.env` matrix** (that matrix is authoritative). At minimum the IDENTITY fields change from the cloned FS-1 values: `EXTERNAL_SIP_IP` + `EXTERNAL_RTP_IP` = the NEW external IP from step 2, `FS_NODE_ID=west-fs-2`, `HEP_CAPTURE_ID=211` (§0 row). Every zone-shared value (DB_HOST, SBC_PROXY_IP + FAILOVER, FS_ZONE, API_HOST, HOMER_IP, METRICS_ZONE/REMOTE_WRITE_HOST, DB/ESL secrets, OPS_AGENT_TOKEN) stays the cloned zone value unless the matrix says otherwise.
9. 🟢 Rebuild + start HOT: `hostname | grep -q '^west-fs-2$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml build && sudo docker compose -f docker-compose.media.yml up -d`
10. 🟢 Verify hot-idle:
    - `sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p $ESL_PASSWORD -x "sofia status"'` → internal + external profiles RUNNING on the NEW external IP.
    - `curl -s 127.0.0.1:9103/metrics | grep -m1 freeswitch_esl_scrape_ok` → `1` (ESL exporter under the new node id).
    - Google Ops Agent came along in the clone: `sudo systemctl is-active google-cloud-ops-agent` (if not: `sudo bash /opt/revup/scripts/monitoring/install_ops_agent.sh`). This feeds vm_down/disk/memory + the `revup-alert` syslog hook.
    - Grafana → Production NOC → Traffic Status → "CPS per FreeSWITCH": a flat `west-fs-2` series appears (auto — panels aggregate by label). Zero is correct: hot, no traffic.
11. 🟢 Monitoring enrollment (once, after ALL THREE VMs exist — workstation): `tofu apply` in `infra/monitoring` (this PR added the three FS-2 names to `var.instances`; applying before the VMs exist risks vm_down false-pages). On the **services VM**: `cd /opt/revup && sudo git pull` (picks up `ip-alias.lua` with the filled ‡ IPs + the NOC dashboard edits), then `sudo docker compose -f docker-compose.services.yml up -d --no-deps --force-recreate heplify-server` (Lua reloads at start; Grafana re-reads provisioned dashboards on its own).
12. 🟢 CRAG NOC console: the compose stack already runs the read-only `voip-ops-agent` on :8710 with the zone token. Confirm the console-side firewall rule for tcp:8710 is TAG-targeted at `voip-media` (then FS-2 is covered automatically): find it with `gcloud compute firewall-rules list --project=rugged-night-193017 | grep 8710` then `gcloud compute firewall-rules describe <that-rule> --project=rugged-night-193017` — if it enumerates instance IPs instead of tags, add the FS-2 internal IPs. Separately, register the three new hosts in the NOC console's fleet inventory (ted-next side) so they appear in the fleet view.

## 2. Phase B — in-window: enroll FS-2 on the SBCs 🟠 (per zone, order West → Central → East)

Prereq: the telephony FS-HA PR is merged; Phase A done for the zone. Adding `FREESWITCH_IP_2` to an SBC and recreating Kamailio is the ONLY serving-path change tonight. One SBC at a time, **standby SBC first** (its restart moves no traffic), then the primary.

1. 🟢 STANDBY SBC (`west-sbc-2`) — add `FREESWITCH_IP_2=192.168.20.3` to `/opt/revup/.env`, then pull + build: `hostname | grep -q '^west-sbc-2$' && cd /opt/revup && sudo git pull && sudo docker compose -f docker-compose.sbc.yml build kamailio`
2. 🟢 Config gate on the new image + env BEFORE recreating (exact gate command per the telephony PR's deploy note — the `kamailio -c` check against the templated config; do not skip it), then recreate: `hostname | grep -q '^west-sbc-2$' && cd /opt/revup && sudo docker compose -f docker-compose.sbc.yml up -d --force-recreate kamailio`
3. 🟢 Verify on the standby: startup log shows both FS destinations; dispatcher lists FS-1 active-priority and FS-2 (probing state per the telephony PR's `kamcmd dispatcher.list` read); `curl -s 127.0.0.1:8080/healthz` still `OK fs_up=1`.
4. 🟠 PRIMARY SBC (`west-sbc-1`) — same three steps with the `west-sbc-1` guard. Its recreate causes one real ~10-12 s SBC flip to the standby and automatic failback (the known mini-drill from the SBC runbook Phase D). **Expect + acknowledge the "[CRITICAL] West primary SBC UNHEALTHY" page** — that is the SBC alerting working, not a fault. Watch recovery: `gcloud compute backend-services get-health west-sbc-backend --region=us-west1 --project=rugged-night-193017`
5. 🟢 Zone acceptance before drills: place a test call (`+16174544217` → forwards to `+17744045256`) — completes via FS-1 as always; Homer ladder unchanged (FS-1 column).
6. Proceed to §3 drills for THIS zone before starting the next zone (same discipline as the SBC migration: West drills pass → Central → East).

## 3. Phase C — acceptance drills 🔴 (per zone, in-window, right after that zone's Phase B)

The drill proves the whole point of tonight: **FS-1 death no longer darkens the zone.** It deliberately drops one live test call — that loss is EXPECTED and gets logged. West shown.

1. 🟢 Pre-state: `gcloud compute backend-services get-health west-sbc-backend --region=us-west1 --project=rugged-night-193017` → both SBC groups HEALTHY; Grafana Traffic Status shows `west-fs` carrying CPS, `west-fs-2` flat.
2. 🟢 Establish a test call: dial `+16174544217`, confirm two-way audio, KEEP IT UP.
3. 🔴 Kill FS-1's freeswitch container (SIGKILL = crash fidelity; the second command pins it down so Docker's restart policy doesn't race the drill) — hostname-guarded: `hostname | grep -q '^west-fs$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml kill freeswitch && sudo docker compose -f docker-compose.media.yml stop freeswitch`
4. 🟠 **The step-2 call DROPS.** Expected — FS-1 was its media anchor. Log it in §9 ("established call lost — by design").
5. 🟢 NEW call completes via FS-2: dial `+16174544217` again after the probe window (give it ~15-30 s on the first attempt) → two-way audio. Grafana: `west-fs-2` CPS/active-calls come alive. Homer ladder for this call shows the `West-FreeSWITCH-2` column (ip-alias) / capture id 211.
6. 🟢 **THE success criterion — the zone front door never darkens:**
   - `/healthz` stays 200 with FS-2 backing it: from either West FS VM, `curl -s -m2 http://10.138.0.250:8080/healthz` → `OK fs_up=1` (any-FS semantics).
   - SBC health stays green on BOTH planes: re-run the step-1 get-health (and the same with `west-sbc-signaling-backend`) → every instance HEALTHY throughout.
   - The "[CRITICAL] SIP front door DOWN (West)" uptime page must NOT fire, and no SBC failover page fires (the SBCs never went unhealthy). If the VIP page fires, FS-2 did not absorb the zone — stop, restore FS-1 (step 7), investigate before continuing. *(Before tonight, this exact drill darkened the West VIP — that contrast is the acceptance.)*
7. 🟠 Restore FS-1 (orphan gotcha first — host networking): `hostname | grep -q '^west-fs$' && sudo killall -9 freeswitch; hostname | grep -q '^west-fs$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d`
8. 🟢 Confirm automatic failback: once FS-1's profiles are RUNNING and it answers OPTIONS again, a NEW test call lands on FS-1 (Grafana `west-fs` series resumes; Homer column back to `West-FreeSWITCH`). No manual step.
9. 🟢 Confirm the failover-window call survives failback: if a call is still up on FS-2 from step 5 (or place one just before step 7), it must ride to NATURAL hangup after FS-1 returns — its in-dialog requests follow the `fsn` marker to FS-2. Clean teardown in Homer (single BYE/200, no 481/408 burst).
10. 🟢 Log the drill in §9. Repeat this section for Central, then East.

**Optional variant B (VM stop — exercises the vm_down page + hypervisor path; workstation, triple-check name+zone):** replace step 3 with 🔴 `gcloud compute instances stop west-fs --zone=us-west1-b --project=rugged-night-193017` — additionally expect the generic "VM down" page at ~5 min; restore with `gcloud compute instances start west-fs --zone=us-west1-b --project=rugged-night-193017` and let compose restart-policy bring the stack up (verify, else `up -d`).

## 4. Steady-state verification 🟢 (any time; part of the weekly eyeball)

1. **Who is carrying the zone:** Grafana → Traffic Status → "CPS per FreeSWITCH" / "Connected calls" — each zone's FS-1 carries everything, FS-2 flat at 0. FS-2 carrying traffic = you are failed over (or flapping) right now — check FS-1.
2. **Both FS hot:** on each media VM: `sudo docker ps --filter name=voip-freeswitch` healthy + `curl -s 127.0.0.1:9103/metrics | grep -m1 freeswitch_esl_scrape_ok` → `1`.
3. **Dispatcher view (from either SBC):** the telephony PR's `kamcmd dispatcher.list` read — FS-1 active, FS-2 probed-healthy.
4. **Front door:** `curl -s -m2 http://10.138.0.250:8080/healthz` from a zone FS VM → `OK fs_up=1`; and the live test DID `+16174544217` end-to-end.
5. **Tiles:** Infra Overview / NOC Home zone tiles read 6/6 (East) · 5/5 (West) · 5/5 (Central) — any lower number names the missing VM in the panel drill-down.

## 5. Unplanned failover — triage order

1. 🟢 Confirm who is serving: Grafana "CPS per FreeSWITCH" (FS-2 active = failed over) + `kamcmd dispatcher.list` on an SBC. If FS-2 is serving: new calls are completing — you have time. Breathe.
2. 🟢 Place a test call through the zone (`+16174544217`).
3. 🟢 Read the pages: **"VM down" fired** → FS-1 VM is dead/stopped — GCP console. **NO page fired but FS-2 is serving** → container-level FS-1 death (this is the known paging gap — §8): on FS-1, `sudo docker ps -a --filter name=voip-freeswitch` + `sudo docker logs --tail 100 voip-freeswitch`.
4. 🟠 Recover FS-1 (VM start, or the hostname-guarded orphan-gotcha + `up -d` from §3 step 7). Failback is automatic once it answers probes.
5. 🟢 Confirm failback (§3 step 8) and that any call still live on FS-2 rides to natural hangup. Spot-check Homer teardown quality.
6. Established-call complaints from the failure moment are EXPECTED (media anchored — §0); note them in §9, no further action.
7. If BOTH FS are down → the zone is dark exactly as pre-4c: "[CRITICAL] SIP front door DOWN ({zone})" fires, Bandwidth retries other zones. Recover EITHER FS first (any one restores the zone), then the other.

## 6. Rollback — return to single-FS 🟠

Use if dispatcher-priority selection itself is causing harm (flapping, mis-selection). Byte-identical-by-construction: with `FREESWITCH_IP_2` unset, the templated Kamailio config renders exactly the pre-4c single-FS config.

1. 🟠 Per zone, remove `FREESWITCH_IP_2` from `/opt/revup/.env` on BOTH SBCs and recreate kamailio one at a time, **standby first** (same commands + config gate as §2; the primary's recreate again costs one ~10-12 s SBC flip + auto failback).
2. 🟢 Verify: dispatcher shows only FS-1; test call; `/healthz` still `OK fs_up=1` (single-FS semantics).
3. 🟢 The FS-2 VMs idle harmlessly (hot, zero traffic, ~$200/mo each). Leave them running for a retry, or stop them: 🔴 `gcloud compute instances stop west-fs-2 --zone=us-west1-b --project=rugged-night-193017` — if stopping, FIRST remove the three FS-2 names from `infra/monitoring` `var.instances` + the two NOC tile lists and re-apply, or vm_down pages within ~5 min. Do NOT release the reserved IPs (baked into §0/ip-alias/blueprints).
4. 🟢 ip-alias entries and dashboard counts can stay if the VMs stay; revert this PR's monitoring edits only if the rollback is permanent.

## 7. Failure modes — what you will see, what selection does, what you do

| Failure | How you find out | Selection behavior | Call impact | Your move |
|---|---|---|---|---|
| **FS-1 VM dead** (crash/stop/host event) | "VM down" page ~5 min; Grafana FS-2 series comes alive; dispatcher marks FS-1 down | New calls → FS-2 within the probe window; failback automatic on recovery | Established calls on FS-1 LOST (media anchored); setups in flight during the window fail; new calls OK | Start the VM; compose restart-policy restores the stack; confirm failback |
| **FS-1 container dead/hung, VM up** | **NO GCM page (known gap — §8 follow-up)**; Grafana FS-2 serving + FS-1 `freeswitch_esl_scrape_ok` gone; customer redials succeed | Same flip/failback | Same as above | Hostname-guarded orphan-gotcha + `up -d` on FS-1 (§3 step 7) |
| **FS-1 wedged but still answering OPTIONS** (healthy-looking zombie) | Live ASR collapse on Traffic Status; `revup-alert` ASR watchdog; Homer 5xx/timeouts on FS-1 | NO flip — probes pass | New calls failing on FS-1 | FORCE the flip: kill FS-1's container (§3 step 3), fix, restore |
| **FS-2 dead while FS-1 serving** | "VM down" (VM-level) or silent (container-level — same gap); Grafana FS-2 exporter series gone | None — no traffic moves | None | Restore promptly — you are one failure from a zone outage |
| **Both FS dead** | "[CRITICAL] SIP front door DOWN ({zone})" + vm_down pages; both SBCs fail any-FS `/healthz` | drop-traffic-if-unhealthy darkens the zone VIP; Bandwidth retries other zones | ALL in-zone calls fail — exactly the pre-4c single-FS blast radius | All-hands: recover either FS first (any one restores the zone) |
| **Dispatcher flapping (FS-1 marginal — packet loss, load)** | New calls alternating FS-1/FS-2 in Grafana/Homer; intermittent setup failures | Calls split across both FS; established calls stay correct (per-call `fsn` in-dialog) | Some setups fail during flaps | Pin it down: kill FS-1's container to force stable FS-2 service, then fix FS-1 |
| **East FS-1 down — API originates failing** | `POST /v1/calls` 5xx / ESL connect errors while inbound RCF rides east-fs-2 | n/a — API ESL is pinned to `fs-media-v2` (§0, accepted) | API-originated calls fail until FS-1 returns | Restore FS-1; future: healthz-aware ESL fallback in the API |

## 8. Observability map (what fires when) + known gap

| Surface | Signal | Latency | Covers |
|---|---|---|---|
| GCM "VM down (metrics absent)" (`infra/monitoring/main.tf`, now incl. the 3 FS-2 VMs) | Any production VM dark 5 min | ~5-6 min | FS VM death only (either node) |
| GCM "SIP VIP {zone} unreachable" | Whole front door dark — with any-FS healthz this now means BOTH FS (or both SBCs) are dead | ~1-2 min | The zone-dark case only |
| Grafana Traffic Status — "CPS per FreeSWITCH" / connected calls / on-net splits (label-driven, auto-picked-up FS-2 series) | Which FS is carrying each zone, live | ~15 s scrape | Every flip incl. container-level and drills — the PRIMARY detection surface for media failover |
| Infra Overview / NOC Home zone tiles (this PR: East 6, West 5, Central 5) | Per-zone VM-up counts incl. FS-2 | ~5 min smoothed | VM-level presence |
| Homer ladder (`ip-alias.lua`: `FreeSWITCH-2` / `West-FreeSWITCH-2` / `Central-FreeSWITCH-2`; HEP 201/211/221) | Which FS handled a given call | per call | Post-hoc call attribution |
| `revup-alert` ASR watchdog | Calls failing while everything looks healthy | minutes | The zombie-FS case |
| `gcloud compute backend-services get-health ...` | SBC planes (must stay green through FS-1 death) | on demand | Proves the any-FS healthz did its job |

**KNOWN GAP (accepted tonight, file the follow-up):** container-level FS death no longer trips ANY GCM page — the whole point of any-FS healthz is that the VIP stays up, and vm_down only sees VM death. Detection is Grafana + redial behavior until we add a per-FS watchdog. Cheapest fix: a tiny systemd timer on each media VM that fires the existing `revup-alert` syslog hook when `fs_cli status` fails N times (pages via the existing log-match policy, zero new GCP resources); alternatively a VictoriaMetrics-side alert on `freeswitch_esl_scrape_ok == 0` once Grafana alerting is stood up.

## 9. Drill log (append a row per drill/incident — same discipline as the SBC/DB runbooks)

| Date | Zone | Type (planned §3 / variant B / real) | Flip time observed | Established call dropped (expected) | New call via FS-2 OK | VIP stayed up | Failback clean | FS-2 call survived to hangup | Notes |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |
