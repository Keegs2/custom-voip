# infra/monitoring — uptime checks, VM alerts, paging (audit P0-2)

Turns "customers are the monitoring" into GCP-native alerting. Creates:

| Piece | What pages |
|---|---|
| Uptime check: **SIP VIP tcp/5060** (through the NLB) | Inbound call path dark — the page that matters most |
| Uptime check: **API /health** (`:8088`) | Provisioning/portal API down |
| Uptime check: **UI https** (`:8443`, self-signed tolerated) | Customer portal down |
| **VM down** (hypervisor metric absent 5 min) — all 4 VMs | Instance stopped/crashed |
| **SBC failover state** (per zone; primary SBC's hypervisor metric absent 2 min) | Zone flipped to its standby SBC (Phase 4b active/standby) — calls continue, redundancy gone. Runbook: `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md` |
| **Disk > 85%** (per filesystem; needs Ops Agent) | Slot-WAL / ClickHouse / PG disk-fill before it kills PG |
| **Memory > 90%** (needs Ops Agent), **CPU > 90% 15m** | Saturation |
| **`revup-alert` log match** | Any on-VM watchdog: backup failures, replication-slot WAL, future scripts |
| Firewall: `voip-uptime-sip` / `voip-uptime-web` | Admits ONLY Google's prober IPv4s to ONLY the probed ports (existing rules stay Bandwidth/office-scoped) |
| Channels: email (required), PagerDuty + SMS (optional) | Delivery |

Targets these alerts defend: `SLOS.md` (same directory).

## Apply (workstation, single lines)

1. `cd /Users/keegan/revup/infra/monitoring && tofu init`
2. `cp terraform.tfvars.example terraform.tfvars` — set `notification_email` (and ideally `pagerduty_service_key`)
3. `tofu plan` — expect ~12 adds (3 uptime checks, 8 policies/channels, 2 firewall rules), zero destroys
4. `tofu apply`
5. If you set `sms_number`: verify the number in Cloud Console → Monitoring → Alerting → Notification channels (GCP blocks SMS until verified).

## Ops Agent (required for disk/memory alerts + `revup-alert` paging)

Run on **each of the 4 VMs** (single line):

`cd /opt/revup && sudo git pull && sudo bash scripts/monitoring/install_ops_agent.sh`

The agent's defaults do everything we need: host metrics (cpu/mem/disk/net)
and syslog shipping (which carries the `revup-alert` lines). On the
**services VM only**, optionally also scrape heplify's Prometheus metrics:

`sudo bash /opt/revup/scripts/monitoring/install_ops_agent.sh --with-heplify-prom`

## Test the pipeline end-to-end (do this after apply)

- On any VM with the agent: `logger -p user.err -t revup-alert -- "test page — ignore"` → expect an email (and PagerDuty incident) within ~2–5 min.
- `sudo systemctl stop google-cloud-ops-agent && sleep 660 && sudo systemctl start google-cloud-ops-agent` is NOT a VM-down test (hypervisor metrics continue); to test VM-down semantics use a scratch VM, not production.

## Notes / limitations (honest)

- **Uptime probers vs firewall:** GCP probes come from Google's published
  public ranges, not the health-check CIDRs. This module opens exactly the
  probed ports to exactly those IPv4s (fetched live via
  `google_monitoring_uptime_check_ips`). If Google adds probers and checks
  start timing out, re-run `tofu apply` to refresh the rule.
- **SIP check depth:** TCP:5060 through the NLB proves VIP → NLB → SBC
  reachability (what Bandwidth sees). It does NOT prove UDP delivery or
  FS-behind-SBC health — that is the P1 "dispatcher-aware health agent" item
  (audit #15). The Kamailio dispatcher already fails over FS internally.
- **heplify metrics (`:9096`)**: heplify-server exports Prometheus metrics
  (HEP packet rates, method/response counts). The compose file now publishes
  them loopback-only (`127.0.0.1:9096`); `--with-heplify-prom` makes the Ops
  Agent scrape → Managed Prometheus (`prometheus.googleapis.com/...` metrics).
  Useful later for call-rate SLO alerts; deliberately NOT part of the P0
  paging set.
- **MOS is in CDRs but unwatched** — per-call MOS/R-factor lands in
  PostgreSQL, not in a metrics system. Watching it belongs with the P1
  metrics work (exporter or scheduled query), tracked in SLOS.md.
