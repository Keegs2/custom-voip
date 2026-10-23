# infra/monitoring — uptime checks, VM alerts, paging (audit P0-2)

Turns "customers are the monitoring" into GCP-native alerting. Creates:

| Piece | What pages |
|---|---|
| Uptime check: **SIP VIP tcp/5060** (through the NLB) | Inbound call path dark — the page that matters most |
| Uptime check: **API /health** (`:8088`) | Provisioning/portal API down |
| Uptime check: **UI https** (`:8443`, self-signed tolerated) | Customer portal down |
| **VM down** (hypervisor metric absent 5 min) — all 4 VMs | Instance stopped/crashed |
| **SBC primary UNHEALTHY** (per zone, CRITICAL; NLB health-check transition log) | Zone flipped to its standby SBC (Phase 4b active/standby) — calls continue on the standby, redundancy gone. Health-check truth: catches a dead/hung kamailio container as well as VM death, in ~10-12 s + ≤1 min log→alert. Runbook: `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md` §4 |
| **SBC standby UNHEALTHY** (per zone, WARNING; same log family) | No traffic impact — but the zone is one failure from a zone outage. Restore promptly (runbook §6) |
| **Disk > 85%** (per filesystem; needs Ops Agent) | Slot-WAL / ClickHouse / PG disk-fill before it kills PG |
| **Memory > 90%** (needs Ops Agent), **CPU > 90% 15m** | Saturation |
| **`revup-alert` log match** | Any on-VM watchdog: backup/guard unit failures, replication lag, replication-slot WAL, ASR, FreeSWITCH down, vmalert rules. One incident per (VM, kind) — see below |
| Firewall: `voip-uptime-sip` / `voip-uptime-web` | Admits ONLY Google's prober IPv4s to ONLY the probed ports (existing rules stay Bandwidth/office-scoped) |
| Channels: email (required), PagerDuty + SMS (optional), existing Slack + Pub/Sub channels by id | Delivery |

Targets these alerts defend: `SLOS.md` (same directory).

## Pub/Sub channel (CRAG Ops intake)

The shared Pub/Sub notification channel publishes incidents to topic
`monitoring-alerts`; TED's CRAG Ops intake reads that topic. The channel is owned
outside this module (it is the channel TED's observability root references as
`buzz_pubsub_notification_channel`, display name "Buzz alerts (Pub/Sub)"), so this
module attaches it by id through `pubsub_notification_channel_ids`, the same way
as `slack_channel_ids`. It was previously attached in the console only, and every
`tofu apply` removed it from the policies.

**Set `pubsub_notification_channel_ids` in `terraform.tfvars` before the next
apply.** Leaving it empty detaches the channel from every CRAG policy. Find the id
(single line): `gcloud beta monitoring channels list --project=rugged-night-193017 --filter='type="pubsub"' --format='value(name,displayName)'`

## Policy user labels

Every policy carries `user_labels`, which Cloud Monitoring copies into each
notification as `incident.policy_user_labels`. Consumers of the shared topic select
CRAG incidents by `system = "crag"` instead of matching policy names.

| Label | Values | On |
|---|---|---|
| `system` | `crag` | every policy |
| `component` | `sip-vip`, `api`, `ui`, `vm`, `disk`, `memory`, `cpu`, `sbc`, `watchdog` | every policy |
| `zone` | `east`, `west`, `central` | SIP VIP and SBC failover policies (pinned to one zone). Multi-VM policies carry the zone in the incident's resource labels instead |
| `sbc_role` | `primary`, `standby` | SBC failover policies |

## `revup-alert` grouping (label extractors)

The log-match policy matches the logger tag (`revup-alert:` or
`revup-alert[pid]:`), not the bare word, so systemd's own lines about the
`revup-alert@` relay unit are not pages. Two label extractors split incidents and
notifications:

- `host` — the VM name (`labels."compute.googleapis.com/resource_name"`, set by the Ops Agent).
- `kind` — the first word of the page, qualified for families that emit several
  conditions from one VM: `unit-failed unit=<unit>`,
  `vmalert <alertname> FIRING zone=<zone>` / `vmalert API`, `HA standby <ip> is` / `HA standby <ip> lag`,
  `replication-slot slot=<slot> wal_status` / `... retained_bytes`; otherwise the
  first word (`ASR`, `FreeSWITCH`, `test`, `TEST`).

Each (host, kind) is its own incident and its own notification rate limit
(900 s). Before, one page suppressed every other page for 30 minutes. The
incident subject reads `[CRITICAL] On-VM watchdog page — <kind> on <host> (<zone>)`.
Log-based incidents (this policy and the six SBC failover policies) send no
notification when they close; they auto-close 24 h after the last matching line,
so closure is not recovery.

Offline check of the filter and `kind` regexes against every page line the scripts
emit (single line): `python3 infra/monitoring/test_revup_alert_extractors.py`

## Apply (workstation, single lines)

1. `cd /Users/keegan/revup/infra/monitoring && tofu init`
2. `cp terraform.tfvars.example terraform.tfvars` — set `notification_email` (and ideally `pagerduty_service_key`), and `pubsub_notification_channel_ids` (see above)
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

- On any VM with the agent: `logger -p user.err -t revup-alert -- "test page — ignore"` → expect an email (and PagerDuty incident) within ~2–5 min. The subject must read `On-VM watchdog page — test on <that VM> (<zone>)`. No incident at all means the tag filter does not match this VM's syslog format; a subject with an empty kind or host means an extractor missed. Either way, revert the `revup_alert_log` change and re-apply before relying on watchdog paging.
- After the first apply with `pubsub_notification_channel_ids`: confirm the channel is listed on a policy in Cloud Console → Monitoring → Alerting, and that the test page above reaches `monitoring-alerts` with `incident.policy_user_labels.system = "crag"` (TED's Discord relay logs non-`[TED NEXT]` incidents as skipped, which shows they arrived).
- `sudo systemctl stop google-cloud-ops-agent && sleep 660 && sudo systemctl start google-cloud-ops-agent` is NOT a VM-down test (hypervisor metrics continue); to test VM-down semantics use a scratch VM, not production.

## vmalert alerts → pages

vmalert (`voip-vmalert` on the services VM) evaluates the `alert:` rules in
`docker/vmalert/rules/*.yml` (teardown: `SipByeFailureShare`,
`FsStaleChannels`, `SbcDialogLeak`) but has no `-notifier.url` and there is
no Alertmanager. `scripts/vmalert-pager/` closes that gap by reusing the
`revup-alert` log-match path above: a 60s systemd timer polls
`http://127.0.0.1:8880/api/v1/alerts` (the port compose already publishes)
and, for each alert that transitions to `firing` (keyed `alertname|zone`),
emits ONE `revup-alert` (user.err) line:

`vmalert <alertname> FIRING zone=<zone> host=<host>: <summary annotation>`

`pending` never pages; a clear logs an INFO line under `revup-vmalert-pager`
(never the alert tag). If the vmalert API stays unreachable for 5
consecutive polls it pages once ("vmalert API unreachable"). State lives in
`/run/revup/vmalert-pager.state`; tunables in optional
`/etc/revup/vmalert-pager.env` (see the script header).

- Install/refresh (services VM, single line):
  `cd /opt/revup && sudo git pull && sudo bash scripts/vmalert-pager/install_vmalert_pager.sh`
- Check it ran: `sudo systemctl start revup-vmalert-pager.service && journalctl -u revup-vmalert-pager -n 5 --no-pager && sudo cat /run/revup/vmalert-pager.state`
- End-to-end page test: do not lower a rule threshold in production — use
  the same synthetic line as the pipeline test above,
  `logger -p user.err -t revup-alert -- "TEST vmalert pager — ignore"`
  (identical tag/priority to what the pager emits). Parser/transition logic
  is unit-tested offline: `bash scripts/vmalert-pager/test/run_tests.sh`.

## Notes / limitations (honest)

- **SBC failover pages need health-check logging enabled** (one-time, operator
  gcloud from a workstation): the three single-line
  `gcloud compute health-checks update http <hc> --region=<region> --enable-logging`
  commands are in the `sbc_failover.tf` header and runbook §7. GCP health-check
  logging records per-endpoint health-state TRANSITIONS only — no steady-state
  log volume. Until enabled, those two policy families never see an entry
  (vm_down still backstops VM death).
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
