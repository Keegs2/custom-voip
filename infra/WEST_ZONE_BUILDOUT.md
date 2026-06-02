# West Zone (us-west1-b) Buildout — Living Runbook + Automation Map

> **Purpose.** A reproducible, step-by-step record of the West zone buildout, captured
> as we execute it. Two jobs:
> 1. **Runbook** — exact `gcloud` commands + decisions, so Central (us-central1-b) is a
>    copy-paste-and-substitute job.
> 2. **Automation map** — every resource below lists its eventual OpenTofu resource type
>    and `tofu import` ID, so we can adopt this hand-built zone into IaC without
>    recreating it (see `infra/OPENTOFU_PLAN.md` for the module/import strategy).
>
> Status legend: ✅ done · 🔄 in progress · ⬜ pending. Update as we go.

## Ground Facts

| Item | Value |
|------|-------|
| GCP Project | `rugged-night-193017` |
| VPC | `default` (custom mode) |
| Region / Zone | `us-west1` / `us-west1-b` (Oregon) |
| Primary Bandwidth PoP (this zone) | LA `216.82.238.134` |
| Secondary (failover) | Dallas `67.231.2.12` |
| **No on-prem / VPN** | Pure GCP. VMs egress via their own static external IP. No Cloud NAT for SIP/RTP VMs. |

### Address & identity plan (West)

| Role | VM name | Internal IP | External IP (static) | Subnet | Tags | SBC_ID / HEP |
|------|---------|-------------|----------------------|--------|------|--------------|
| SBC-1 | `west-sbc-1` | 10.138.0.100 | `west-sbc-1-ip` = 8.229.41.59 | default (us-west1) | voip-sbc, lb-health-check, **bypass-vpn** | west-sbc-1 / 110 |
| SBC-2 | `west-sbc-2` | 10.138.0.101 | `west-sbc-2-ip` = 136.117.230.166 | default (us-west1) | voip-sbc, lb-health-check, **bypass-vpn** | west-sbc-2 / 111 |
| FreeSWITCH | `west-fs` | 192.168.20.2 | `west-fs-ip` = 8.229.177.165 | voip-media-west | voip-media, **bypass-vpn** | — |
| PG replica | `west-db` | 10.138.0.103 | ephemeral | default (us-west1) | voip-services, **bypass-vpn** | — |

> **⚠️ `bypass-vpn` is REQUIRED on every VM that needs internet/carrier egress.** The
> `default` VPC has a leftover `0.0.0.0/0` route to a dead VPN tunnel; untagged VMs
> black-hole all external traffic (can't reach Bandwidth OR github.com). The `bypass-vpn`
> tag selects the direct-internet-gateway route. Add it at `gcloud compute instances create`
> time (`--tags=voip-sbc,lb-health-check,bypass-vpn`). Remediate an existing VM with
> `gcloud compute instances add-tags <vm> --zone=us-west1-b --tags=bypass-vpn`. (West VMs
> were initially created without it on 2026-06-02 and timed out — fixed via add-tags.)
| Geo LB VIP | — | — | global anycast (reserve) | — | — | — |

Machine types (per `GCP_DEPLOYMENT_PLAN.md`): SBC `e2-standard-4`, FS `e2-standard-8`,
DB `e2-standard-4`.

---

## Pre-flight Verification (✅ 2026-06-02)

All conflict checks passed before creating anything:

| Check | Command | Result |
|-------|---------|--------|
| Media CIDR vs Cloud Build peering | `gcloud compute addresses list --filter=name=cloud-build-pool` | Reservation is `192.168.0.0/20`; `192.168.20.0/24` is outside it ✅ |
| us-west1 subnet exists? | `gcloud compute networks subnets list --filter=region:us-west1` | `default` `10.138.0.0/20` already present → **reuse** ✅ |
| Internal firewall model | `gcloud compute firewall-rules describe voip-internal` | `sourceTags`-based (voip-sbc/voip-media/voip-services) → tag-driven, no edits ✅ |
| us-west1 NAT router | `gcloud compute routers list --filter=region:us-west1` | none → media subnet stays NAT-free ✅ |

**Firewall conclusion:** all VoIP rules are tag-targeted and VPC-global; `default-allow-internal`
(`10.128.0.0/9`) already permits East↔West replication (tcp:5432). **No new firewall rules,
no source-range edits.** West inherits everything by carrying the tags in the table above.

---

## Step 1 — East proven on the new env-driven code ✅
Both East SBCs redeployed (`commit 24169ab`), `healthy`, `kamcmd` working, dispatcher active
path (FS + Dallas + LA) all `AP`, backward-compat confirmed (East still BW_PRIMARY=Dallas). The
multi-zone env-driven Kamailio config (`BANDWIDTH_PRIMARY_IP`/`SECONDARY_IP`, `INTERNAL_SUBNET`/
`MEDIA_SUBNET`) ships with East defaults, so an unset value reproduces East behavior.

## Step 2 — West network ✅ (2026-06-02)
Created `voip-media-west` (192.168.20.0/24) and reserved static IPs:
west-sbc-1-ip=8.229.41.59, west-sbc-2-ip=136.117.230.166, west-fs-ip=8.229.177.165.


```bash
PROJECT=rugged-night-193017

# Media subnet for FreeSWITCH (the us-west1 "default" subnet 10.138.0.0/20 is reused as-is)
gcloud compute networks subnets create voip-media-west \
  --network=default --region=us-west1 --range=192.168.20.0/24 --project=$PROJECT

# Static external IPs for the 3 SIP/RTP VMs
gcloud compute addresses create west-sbc-1-ip west-sbc-2-ip west-fs-ip \
  --region=us-west1 --project=$PROJECT

# Capture assigned IPs (record them in the table above)
gcloud compute addresses list --regions=us-west1 --project=$PROJECT \
  --format="table(name,address,status)"
```

**Tofu import map:**
- `voip-media-west` → `google_compute_subnetwork.voip_media_west` — import `projects/rugged-night-193017/regions/us-west1/subnetworks/voip-media-west`
- `west-sbc-1-ip` / `west-sbc-2-ip` / `west-fs-ip` → `google_compute_address.west_*` — import `projects/rugged-night-193017/regions/us-west1/addresses/<name>`
- `default` (us-west1 subnet) → already exists; import as data source or existing `google_compute_subnetwork`.

> Assigned IPs: west-sbc-1-ip = `8.229.41.59` · west-sbc-2-ip = `136.117.230.166` · west-fs-ip = `8.229.177.165`

## Step 6 — Deploy & configure West stack ✅ (2026-06-02)
West SBCs + FS deployed via repo pull + `apply-zone-env.sh` + rebuild. Both SBCs
`healthy`, VIP `35.252.214.40` on `lo` (entrypoint, commit `b810be9`), Kamailio bound.
West FS `RUNNING` with `Ext-RTP/SIP-IP=8.229.177.165`. Fixes along the way:
- `bypass-vpn` tag was required on all egress VMs (added via `add-tags`) — see warning above.
- Kamailio image was missing `iproute2` (commit `a3ef776`) — entrypoint loopback add needs `ip`.
- East SBCs rebuilt to pick up the in-code loopback (reboot-hardened); test call confirmed.

## Step 3 — West regional NLB (mirror East), then Bandwidth dual-VIP ⬜ NEXT
**Decision (corrected):** GCP has NO global passthrough UDP NLB (canonical CLAUDE.md). Each
zone gets its own **regional** external passthrough NLB VIP; Bandwidth is configured with
BOTH regional VIPs on its inbound (origination) side for HA. Bandwidth termination
(outbound) is IP-only — whitelist the West SBC public IPs (8.229.41.59, 136.117.230.166).
West NLB VIP already reserved: `west-sbc-vip` = 35.252.214.40. Build a regional NLB
(`west-sbc-group` + `west-sbc-backend` + `west-sbc-vip-udp/tcp`, TCP:5060 health check,
CLIENT_IP affinity) mirroring East's `sbc-group`/`sbc-backend`/`sbc-vip-*`.
- Tofu: `google_compute_region_backend_service.west_sbc`, `google_compute_region_health_check`,
  `google_compute_forwarding_rule.west_sbc_{udp,tcp}`, `google_compute_instance_group.west_sbc`.
Reserve global anycast VIP → global backend service (CLIENT_IP affinity, TCP:5060 health check)
→ add East instance group → validate East via VIP alongside regional NLB → whitelist VIP on
Bandwidth (termination host). Commands captured here when executed.
- Tofu: `google_compute_global_address.geo_vip`, `google_compute_region_backend_service` /
  `google_compute_backend_service` (global), `google_compute_health_check.sbc_5060`,
  `google_compute_global_forwarding_rule` (udp + tcp).

## Step 4 — West VMs (clone machine images from East) ✅ (2026-06-02)
Created machine images `east-sbc-image` / `east-fs-image` from the running East VMs, then
instantiated `west-sbc-1` (10.138.0.100), `west-sbc-2` (10.138.0.101), `west-fs`
(192.168.20.2) with the tags/IPs/subnets in the table above. `west-db` (Step 5) is a fresh
build, not a clone. West NLB VIP reserved: `west-sbc-vip` = **35.252.214.40**.
- Tofu: `google_compute_machine_image.east_sbc/east_fs`, `google_compute_instance.west_*`.

### Step 4b — NLB VIP on loopback: NOW IN CODE (commit `b810be9`)
GCP passthrough NLBs require the VIP on the backend's `dev lo`. This used to be a manual,
**un-persisted** `ip addr add` on each SBC (would be lost on reboot; absent on clones). It is
now done by `docker/kamailio/entrypoint.sh` (adds `${EXTERNAL_SIP_IP}/32` to `lo`,
idempotent) with `NET_ADMIN` in `docker-compose.sbc.yml` and `USER root` + `-u/-g` drop in the
Dockerfile. **No manual host step.** Pull + rebuild applies it; East is hardened by the same
pull (its VIP is now persisted in code). Per-zone, only `/opt/revup/.env` is set on the VM
(secrets + zone IPs — can't be committed).

### West per-VM `.env` values (the only on-VM step)
- **west-sbc-1:** EXTERNAL_SIP_IP=35.252.214.40, SBC_INTERNAL_IP=10.138.0.100, FS_PUBLIC_IP=8.229.177.165, FREESWITCH_IP=192.168.20.2, DB_HOST=10.142.0.103 (interim East primary → 10.138.0.103 after Step 5), HOMER_IP=10.142.0.103, HEP_CAPTURE_ID=110, SBC_ID=west-sbc-1, BANDWIDTH_PRIMARY_IP=216.82.238.134, BANDWIDTH_SECONDARY_IP=67.231.2.12, INTERNAL_SUBNET=10.138.0.0/20, MEDIA_SUBNET=192.168.20.0/24
- **west-sbc-2:** same, but SBC_INTERNAL_IP=10.138.0.101, HEP_CAPTURE_ID=111, SBC_ID=west-sbc-2
- **west-fs:** EXTERNAL_SIP_IP=8.229.177.165, EXTERNAL_RTP_IP=8.229.177.165, DB_HOST=10.142.0.103 (interim), API_HOST=10.142.0.103, HOMER_IP=10.142.0.103, SBC_PROXY_IP=10.138.0.100, SBC_PROXY_IP_FAILOVER=10.138.0.101, TEST_MODE=false
- Keep inherited secrets (DB_PASS, ESL_PASSWORD) and DB_USER/DB_PORT/DB_NAME/REDIS_*/API_PORT as cloned from East.

## Step 5 — West PG streaming replica ⬜
Bare-metal PostgreSQL replica of the East primary (replication slot + role on East, `pg_hba`
for `10.138.0.0/20`, `pg_basebackup`, standby tuning on `west-db`), local PgBouncer on
`west-db:6432`. (Not OpenTofu-managed — secrets/PG live outside IaC; document procedure here.)

## Step 6 — Deploy & configure West stack ⬜
Per-role `.env` (West values: `BANDWIDTH_PRIMARY_IP=216.82.238.134`, `INTERNAL_SUBNET=10.138.0.0/20`,
`MEDIA_SUBNET=192.168.20.0/24`, `SBC_ID`/`HEP_CAPTURE_ID` per table) → compose up per VM.

## Step 7 — Validate West in isolation ⬜
Test call directly through a West SBC → FS → Bandwidth (LA primary); confirm in Homer the
egress goes to `216.82.238.134` first and `X-Inbound-TC: tc4`.

## Step 8 — Add West to Geo LB + Bandwidth origination ⬜
Add West instance group to the Geo LB backend; whitelist the two West SBC public IPs as
Bandwidth origination hosts (dash).

## Step 9 — Cutover ⬜
Bandwidth termination → Geo VIP; East SBC `EXTERNAL_SIP_IP` → Geo VIP (rebuild); retire East
regional NLB (`34.24.133.82`).

## Step 10 — Failover testing ⬜
Kill one SBC (intra-zone), kill a zone (cross-zone reroute), kill a carrier PoP (Kamailio
failover to secondary). Verify Homer per-zone capture IDs (110/111).

---

## Notes for OpenTofu adoption
- East resources get **imported** (not recreated) — `prevent_destroy = true` on all VMs/IPs
  per `infra/OPENTOFU_PLAN.md`. West can be **created fresh** by Tofu OR built by hand (as here)
  and imported. This runbook records exact attributes to make either path exact.
- Reuse this file as the template for Central: substitute `us-central1` / `10.128.0.0/20` /
  `192.168.30.0/24` (verify CIDR) / `central-sbc-{1,2}` / HEP `120`/`121` / primary PoP Dallas.
