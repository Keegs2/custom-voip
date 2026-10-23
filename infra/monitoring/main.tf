# ============================================================================
# Monitoring + alerting for the live RCF production (audit P0-2).
# ============================================================================
# Before this module: no metrics, no probes, no paging — outage detection was
# "a customer calls Granite." After: GCP-native uptime checks on the customer-
# visible front doors (all three zones' SIP VIPs + API + UI), VM-down/disk/
# memory/CPU alerts on the 16 always-on production VMs across East/West/Central, and a
# syslog "revup-alert" log-match policy that lets ANY on-VM script/unit page by
# writing one logger line (backups + slot-WAL watchdog use it).
#
# Companion pieces:
#   scripts/monitoring/install_ops_agent.sh  — host metrics + syslog shipping
#   scripts/backup/systemd/revup-alert@.service — unit-failure -> revup-alert
#   infra/monitoring/SLOS.md                 — the targets these alerts defend
# ============================================================================

# ----------------------------------------------------------------------------
# Notification channels
# ----------------------------------------------------------------------------
resource "google_monitoring_notification_channel" "email" {
  display_name = "revup ops email"
  type         = "email"
  labels = {
    email_address = var.notification_email
  }
}

resource "google_monitoring_notification_channel" "pagerduty" {
  count        = var.pagerduty_service_key != "" ? 1 : 0
  display_name = "revup PagerDuty"
  type         = "pagerduty"
  sensitive_labels {
    service_key = var.pagerduty_service_key
  }
}

# SMS requires one-time number verification in the Cloud Console after apply.
resource "google_monitoring_notification_channel" "sms" {
  count        = var.sms_number != "" ? 1 : 0
  display_name = "revup ops SMS"
  type         = "sms"
  labels = {
    number = var.sms_number
  }
}

# Every policy in this module notifies local.channels. The Pub/Sub channel(s)
# (var.pubsub_notification_channel_ids) feed topic monitoring-alerts, which
# TED's CRAG Ops intake reads; they are owned outside this module, so they are
# referenced by id exactly like the Slack channels. Before this variable existed
# the channel was attached in the console only, and every `tofu apply` removed it.
locals {
  channels = concat(
    [google_monitoring_notification_channel.email.id],
    google_monitoring_notification_channel.pagerduty[*].id,
    google_monitoring_notification_channel.sms[*].id,
    var.slack_channel_ids,
    var.pubsub_notification_channel_ids,
  )
}

# ----------------------------------------------------------------------------
# Policy user labels
# ----------------------------------------------------------------------------
# Every policy carries system=crag plus a component, so a consumer of the SHARED
# monitoring-alerts topic (TED's CRAG Ops intake) selects CRAG incidents from
# incident.policy_user_labels instead of a list of policy names. GCM allows only
# lowercase letters, digits, "_" and "-" in label keys and values.
#   component : sip-vip | api | ui | vm | disk | memory | cpu | sbc | watchdog
#   zone      : east | west | central — only on policies pinned to ONE zone
#               (SIP VIPs, SBC pairs). Multi-VM policies take the zone from the
#               incident's resource labels instead.
#   sbc_role  : primary | standby — SBC failover-state policies only
locals {
  policy_labels = {
    system = "crag"
  }
}

# ----------------------------------------------------------------------------
# Firewall: admit Google's uptime probers (IPv4) to exactly the probed ports.
# ----------------------------------------------------------------------------
# The existing rules scope 5060 to Bandwidth+GCP-healthcheck CIDRs and the
# admin web ports to office CIDRs — correct, but it means uptime checks would
# silently fail. These two rules open ONLY the probed ports to ONLY Google's
# published prober addresses (fetched live, so re-apply if checks start
# failing with connection timeouts — Google occasionally adds probers).
data "google_monitoring_uptime_check_ips" "probers" {}

locals {
  prober_ipv4 = [
    for ip in data.google_monitoring_uptime_check_ips.probers.uptime_check_ips :
    "${ip.ip_address}/32" if !strcontains(ip.ip_address, ":")
  ]
}

resource "google_compute_firewall" "uptime_sip" {
  count       = var.manage_uptime_firewall ? 1 : 0
  name        = "voip-uptime-sip"
  network     = var.network
  direction   = "INGRESS"
  description = "Google Cloud Monitoring uptime probers -> NLB VIP TCP 5060 (managed by infra/monitoring)"

  allow {
    protocol = "tcp"
    ports    = ["5060"]
  }

  source_ranges = local.prober_ipv4
  target_tags   = ["voip-sbc"]
}

resource "google_compute_firewall" "uptime_web" {
  count       = var.manage_uptime_firewall ? 1 : 0
  name        = "voip-uptime-web"
  network     = var.network
  direction   = "INGRESS"
  description = "Google Cloud Monitoring uptime probers -> API/UI ports on the services VM (managed by infra/monitoring)"

  allow {
    protocol = "tcp"
    ports    = [tostring(var.api_port), tostring(var.ui_https_port)]
  }

  source_ranges = local.prober_ipv4
  target_tags   = ["voip-services"]
}

# ----------------------------------------------------------------------------
# Uptime checks — the three customer-visible front doors
# ----------------------------------------------------------------------------
# 1. The SIP VIP via the NLB (TCP, same path as Bandwidth's TCP signaling).
resource "google_monitoring_uptime_check_config" "sip_vip" {
  display_name = "SIP NLB VIP tcp/5060"
  timeout      = "10s"
  period       = "60s"

  tcp_check {
    port = 5060
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project
      host       = var.nlb_vip
    }
  }
}

# 1b. West SIP VIP — same TCP/5060 probe against the West NLB.
resource "google_monitoring_uptime_check_config" "sip_vip_west" {
  display_name = "SIP NLB VIP West tcp/5060"
  timeout      = "10s"
  period       = "60s"

  tcp_check {
    port = 5060
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project
      host       = var.nlb_vip_west
    }
  }
}

# 1c. Central SIP VIP — same TCP/5060 probe against the Central NLB.
resource "google_monitoring_uptime_check_config" "sip_vip_central" {
  display_name = "SIP NLB VIP Central tcp/5060"
  timeout      = "10s"
  period       = "60s"

  tcp_check {
    port = 5060
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project
      host       = var.nlb_vip_central
    }
  }
}

# 2. API /health (FastAPI on the services VM).
resource "google_monitoring_uptime_check_config" "api_health" {
  display_name = "API /health"
  timeout      = "10s"
  period       = "60s"

  http_check {
    port           = var.api_port
    use_ssl        = false
    path           = "/health"
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project
      host       = var.services_public_ip
    }
  }
}

# 3. Customer/admin UI over HTTPS. validate_ssl=false because the cert is
#    self-signed today — flip to true when a CA cert lands.
resource "google_monitoring_uptime_check_config" "ui" {
  display_name = "UI https"
  timeout      = "10s"
  period       = "60s"

  http_check {
    port           = var.ui_https_port
    use_ssl        = true
    validate_ssl   = false
    path           = "/"
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project
      host       = var.services_public_ip
    }
  }
}

# ----------------------------------------------------------------------------
# Alert policies — uptime failures
# ----------------------------------------------------------------------------
# Each front door carries its own severity + headline + summary. SIP VIPs and
# the API are CRITICAL (calls / provisioning). The operator UI is WARNING —
# unreachable UI blocks admin access but does NOT affect live calls.
# component/zone become the policy's user labels (see "Policy user labels").
locals {
  uptime_checks = {
    "SIP VIP East unreachable" = {
      check_id  = google_monitoring_uptime_check_config.sip_vip.uptime_check_id
      severity  = "CRITICAL"
      component = "sip-vip"
      zone      = "east"
      subject   = "CRAG · SIP front door DOWN (East) — inbound calls are failing"
      content   = "**What happened:** The East SIP VIP (34.24.133.82:5060) is unreachable from Google's probers — inbound RCF calls into East are failing right now.\n\n**Impact:** the carrier cannot deliver calls into this region.\n\n**What to do:** check the East NLB backend health, then `sudo docker ps` on both East SBCs, then Homer. SLOs: infra/monitoring/SLOS.md"
    }
    "SIP VIP West unreachable" = {
      check_id  = google_monitoring_uptime_check_config.sip_vip_west.uptime_check_id
      severity  = "CRITICAL"
      component = "sip-vip"
      zone      = "west"
      subject   = "CRAG · SIP front door DOWN (West) — inbound calls are failing"
      content   = "**What happened:** The West SIP VIP (35.252.214.40:5060) is unreachable from Google's probers — inbound RCF calls into West are failing right now.\n\n**Impact:** the carrier cannot deliver calls into this region.\n\n**What to do:** check the West NLB backend health, then `sudo docker ps` on both West SBCs, then Homer. SLOs: infra/monitoring/SLOS.md"
    }
    "SIP VIP Central unreachable" = {
      check_id  = google_monitoring_uptime_check_config.sip_vip_central.uptime_check_id
      severity  = "CRITICAL"
      component = "sip-vip"
      zone      = "central"
      subject   = "CRAG · SIP front door DOWN (Central) — inbound calls are failing"
      content   = "**What happened:** The Central SIP VIP (35.253.133.230:5060) is unreachable from Google's probers — inbound RCF calls into Central are failing right now.\n\n**Impact:** the carrier cannot deliver calls into this region.\n\n**What to do:** check the Central NLB backend health, then `sudo docker ps` on both Central SBCs, then Homer. SLOs: infra/monitoring/SLOS.md"
    }
    "API backend /health failing" = {
      check_id  = google_monitoring_uptime_check_config.api_health.uptime_check_id
      severity  = "CRITICAL"
      component = "api"
      zone      = ""
      subject   = "CRAG · API backend DOWN — provisioning + CDR ingest affected"
      content   = "**What happened:** The services-VM API /health probe is failing — the REST API is down. Live calls still route (FreeSWITCH reads PG directly), but provisioning, the portal backend, and CDR ingest are affected (FreeSWITCH buffers CDRs to disk and retries).\n\n**What to do:** `sudo docker compose -f docker-compose.services.yml ps api` on the services VM and check its logs. SLOs: infra/monitoring/SLOS.md"
    }
    "Operator UI unreachable" = {
      check_id  = google_monitoring_uptime_check_config.ui.uptime_check_id
      severity  = "WARNING"
      component = "ui"
      zone      = ""
      subject   = "CRAG · Operator portal (UI) unreachable — calls unaffected"
      content   = "**What happened:** The operator UI is unreachable from Google's probers. Live calls are UNAFFECTED; this only blocks admin/portal access.\n\n**What to do:** `sudo docker compose -f docker-compose.services.yml ps ui` on the services VM; check nginx + the TLS cert. Keep an eye on it — escalate if it persists."
    }
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  for_each = local.uptime_checks

  display_name          = each.key
  combiner              = "OR"
  notification_channels = local.channels
  severity              = each.value.severity

  conditions {
    display_name = each.key
    condition_threshold {
      filter          = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id = \"${each.value.check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "60s"

      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    subject   = each.value.subject
    content   = each.value.content
  }

  # zone = "" (API/UI: probes of the services VM, not of a zone) is left out.
  user_labels = merge(local.policy_labels, {
    for key, value in {
      component = each.value.component
      zone      = each.value.zone
    } : key => value if value != ""
  })
}

# ----------------------------------------------------------------------------
# VM down — hypervisor CPU metric goes absent when an instance stops/crashes.
# Works with no agent installed.
# ----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "vm_down" {
  display_name          = "VM down (metrics absent)"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "CRITICAL"

  # ONE condition covers every instance (grouped by name) instead of one
  # condition per VM. GCP caps conditions at 6 per policy, so per-instance
  # enumeration would break at 14 VMs. Absence of the hypervisor CPU metric for
  # any matched instance fires; the incident labels which one. Add/remove VMs by
  # editing var.instances — no condition-count ceiling.
  conditions {
    display_name = "Hypervisor metrics absent (any production VM)"
    condition_absent {
      filter   = "resource.type = \"gce_instance\" AND metric.type = \"compute.googleapis.com/instance/cpu/utilization\" AND metadata.system_labels.name = monitoring.regex.full_match(\"${join("|", var.instances)}\")"
      duration = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
        group_by_fields    = ["metadata.system_labels.name"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    subject   = "CRAG · Production VM DOWN — $${metadata.system_labels.name} ($${resource.label.zone})"
    content   = "**What happened:** No hypervisor metrics for 5 minutes from $${metadata.system_labels.name} ($${resource.label.zone}) — the instance is stopped, crashed, or lost by the project.\n\n**Impact:** an SBC = the zone runs on its standby SBC (NLB failover); a media VM = the zone's Kamailio dispatcher flips NEW calls to the other FS within the probe window, but established calls on the dead FS DROP (media anchored — docs/FS_MEDIA_HA_RUNBOOK.md); BOTH media VMs = ALL in-zone calls fail (zone VIP darkens, Bandwidth retries other zones); the services VM = ALL new-call DID lookups fail + portal/API dark.\n\n**What to do:** check the instance in the GCP console. If it is running, the Ops Agent or the Docker stack is down (`sudo docker ps`)."
  }

  user_labels = merge(local.policy_labels, { component = "vm" })
}

# ----------------------------------------------------------------------------
# Disk > threshold — requires the Ops Agent (scripts/monitoring/).
# The replication slot, ClickHouse and PG can silently fill the services disk.
# ----------------------------------------------------------------------------
locals {
  # Shared by the disk WARNING + CRITICAL tiers (real filesystems only).
  disk_filter = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/disk/percent_used\" AND metric.labels.state = \"used\" AND NOT metric.labels.device = monitoring.regex.full_match(\"(tmpfs|udev|overlay.*|/dev/loop.*)\")"
}

# CRITICAL — a filesystem is nearly full; a PG/ClickHouse outage is imminent.
resource "google_monitoring_alert_policy" "disk_used" {
  display_name          = "Disk critically full (>${var.disk_percent_threshold}%)"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "CRITICAL"

  conditions {
    display_name = "Filesystem used percent (critical)"
    condition_threshold {
      filter          = local.disk_filter
      comparison      = "COMPARISON_GT"
      threshold_value = var.disk_percent_threshold
      duration        = "600s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metadata.system_labels.name", "metric.label.device"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    subject   = "CRAG · Disk almost full on $${metadata.system_labels.name} — over ${var.disk_percent_threshold}% used"
    content   = "**What happened:** A real filesystem on $${metadata.system_labels.name} (device $${metric.label.device}) crossed ${var.disk_percent_threshold}% used.\n\n**Impact:** PG hitting a full disk = full new-call outage; ClickHouse/qryn stop ingesting.\n\n**What to do (services VM, in order):** replication-slot WAL (`journalctl -t revup-backup | grep slot-wal`), pg_wal size, ClickHouse volume, /var/backups/revup."
  }

  user_labels = merge(local.policy_labels, { component = "disk" })
}

# WARNING — a filesystem is filling; triage before it becomes critical.
resource "google_monitoring_alert_policy" "disk_warning" {
  display_name          = "Disk filling (>${var.disk_warn_percent_threshold}%)"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "WARNING"

  conditions {
    display_name = "Filesystem used percent (warning)"
    condition_threshold {
      filter          = local.disk_filter
      comparison      = "COMPARISON_GT"
      threshold_value = var.disk_warn_percent_threshold
      duration        = "600s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metadata.system_labels.name", "metric.label.device"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    subject   = "CRAG · Disk filling on $${metadata.system_labels.name} — over ${var.disk_warn_percent_threshold}% used"
    content   = "**What happened:** A real filesystem on $${metadata.system_labels.name} (device $${metric.label.device}) crossed ${var.disk_warn_percent_threshold}% used and is trending toward full — keep an eye on it (this fires before the critical page at ${var.disk_percent_threshold}%).\n\n**What to do:** find what is growing — replication-slot WAL, ClickHouse volume, or /var/backups/revup on the services VM."
  }

  user_labels = merge(local.policy_labels, { component = "disk" })
}

# ----------------------------------------------------------------------------
# Memory > threshold (Ops Agent metric)
# ----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "memory_used" {
  display_name          = "Memory used > ${var.memory_percent_threshold}%"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "WARNING"

  conditions {
    display_name = "Memory used percent"
    condition_threshold {
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/memory/percent_used\" AND metric.labels.state = \"used\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.memory_percent_threshold
      duration        = "600s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metadata.system_labels.name"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    subject   = "CRAG · High memory on $${metadata.system_labels.name} — over ${var.memory_percent_threshold}% for 10m"
    content   = "**What happened:** Sustained high memory on $${metadata.system_labels.name} (over ${var.memory_percent_threshold}% used for 10 minutes) — keep an eye on it.\n\n**Note:** FreeSWITCH under memory pressure degrades media before it OOMs; on the services VM suspect ClickHouse/qryn first (qryn runs a 4 GB heap)."
  }

  user_labels = merge(local.policy_labels, { component = "memory" })
}

# ----------------------------------------------------------------------------
# CPU sustained (hypervisor metric — works without the agent)
# ----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "cpu_high" {
  display_name          = "CPU > ${var.cpu_utilization_threshold * 100}% for 15m"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "WARNING"

  conditions {
    display_name = "CPU utilization"
    condition_threshold {
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"compute.googleapis.com/instance/cpu/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.cpu_utilization_threshold
      duration        = "900s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metadata.system_labels.name"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    subject   = "CRAG · High CPU on $${metadata.system_labels.name} — over ${var.cpu_utilization_threshold * 100}% for 15m"
    content   = "**What happened:** Sustained CPU saturation on $${metadata.system_labels.name} (over ${var.cpu_utilization_threshold * 100}% for 15 minutes) — a capacity ceiling or a runaway process. Keep an eye on it.\n\n**What to do:** per PRODUCTION_ARCHITECTURE.md §13, trigger capacity planning at 70% of rated load; 90% sustained is an incident."
  }

  user_labels = merge(local.policy_labels, { component = "cpu" })
}

# ----------------------------------------------------------------------------
# revup-alert log-match — the on-VM paging hook.
# Anything on any VM can page by writing one syslog line:
#     logger -p user.err -t revup-alert -- "what broke"
# Used today by: backup unit failures (revup-alert@.service), the replication
# and replication-slot WAL guards, the ASR guard (scripts/backup/), the
# FreeSWITCH watchdog (scripts/fs-watchdog/) and the vmalert pager
# (scripts/vmalert-pager/). Requires the Ops Agent (ships syslog, raw line in
# jsonPayload.message, e.g. "... revup-alert: ASR 23% over 15m ...").
#
# Matching + grouping:
#   - The filter matches the logger TAG ("revup-alert:" or "revup-alert[pid]:"),
#     not the bare word, so systemd's own lines about the relay unit
#     ("Starting revup-alert@revup-pgdump.service ...") no longer count as pages.
#   - label_extractors split incidents and notifications per (host, kind):
#     "Each combination of extracted values is treated as a separate rule for
#     the purposes of triggering notifications" (AlertPolicy LogMatch API ref).
#     host = the VM name; kind = the page's first word, qualified for families
#     that emit several different conditions from one VM, so each condition is
#     its own rule:
#       unit-failed unit=<unit>                 each failed backup/guard unit
#       vmalert <alertname> FIRING zone=<zone>  each rule in each zone (the
#                                               pager keys alerts name|zone)
#       vmalert API                             pager lost the vmalert API
#       HA standby <ip> is | HA standby <ip> lag   disconnected vs lagging
#       replication-slot slot=<s> wal_status | ... retained_bytes
#       ASR | FreeSWITCH | test | TEST          everything else: first word
#     The kind regex is checked offline against every page text the scripts
#     emit: python3 infra/monitoring/test_revup_alert_extractors.py
#   - notification_rate_limit 900 s (was 1800 s for the whole policy). Before
#     the extractors the policy was one rule, so after any page a second,
#     different watchdog line (another guard, another VM) could go unnotified
#     for up to 30 minutes. Now the
#     limit only spaces out repeats of the SAME (host, kind): the guards re-emit
#     every 5-15 min while a condition persists, so 900 s (the slowest guard's
#     cadence) gives at most 4 notifications/hour per condition, and bounds the
#     delay to 15 min even if per-combination limiting behaves differently from
#     the API reference.
# Log-based incidents never notify on close (notification prompts are always
# [OPENED]); they auto-close 24 h after the last matching line. Closure is not
# recovery — re-check the condition named in the line.
# ----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "revup_alert_log" {
  display_name          = "On-VM watchdog page (backups · replication · slot-WAL · ASR)"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "CRITICAL"

  conditions {
    display_name = "syslog contains revup-alert"
    condition_matched_log {
      filter = "resource.type=\"gce_instance\" AND logName:\"syslog\" AND (jsonPayload.message=~\"revup-alert[^@ :]*: \" OR textPayload=~\"revup-alert[^@ :]*: \")"
      label_extractors = {
        host = "EXTRACT(labels.\"compute.googleapis.com/resource_name\")"
        kind = "REGEXP_EXTRACT(jsonPayload.message, \"revup-alert[^@ :]*: +((?:vmalert [^ ]+ FIRING zone=|vmalert |unit-failed unit=|HA standby [^ ]+ |replication-slot slot=[^ ]+ )?[^ =]+)\")"
      }
    }
  }

  alert_strategy {
    auto_close = "86400s"
    notification_rate_limit {
      period = "900s"
    }
  }

  # Email/Slack/Pub/Sub text. The raw page line is NOT shown here on purpose:
  # every label extractor is part of the incident grouping key, so extracting
  # the message (which carries changing numbers) would open a new incident and
  # notification on every re-emit. The page TYPE (kind) is stable per
  # condition, so the body explains each type in plain words instead.
  documentation {
    mime_type = "text/markdown"
    subject   = "CRAG · Watchdog page: $${log.extracted_label.kind} on $${log.extracted_label.host} ($${resource.label.zone})"
    content   = <<-EOT
      **Page type: $${log.extracted_label.kind}** · **VM: $${log.extracted_label.host}** ($${resource.label.zone})

      A script on that VM sent this page. Find its page type below. The exact message it wrote is on the incident page (**View incident** → the matched log line).

      - **test** or **TEST**: a test page sent by hand. **No action needed.**
      - **unit-failed unit=…**: a backup or guard job failed on that VM. Run `sudo journalctl -u <unit> -n 50` there.
      - **replication-slot slot=…**: a database replica's slot is holding WAL on the primary, so the primary's disk can fill. Check that the replica is connected; details in `scripts/backup/slot_wal_guard.sh`.
      - **HA standby …**: the database hot standby is disconnected or lagging. Check `pg_stat_replication` on the primary.
      - **ASR**: the call answer rate collapsed. Check carrier routes and Homer for failing calls.
      - **FreeSWITCH**: FreeSWITCH is down on that media VM. See `docs/FS_MEDIA_HA_RUNBOOK.md` §5.
      - **vmalert … FIRING zone=…**: a metrics alert rule is firing in that zone. See `docker/vmalert/rules`.
      - **vmalert API**: the pager lost contact with vmalert, so metric alerts are blind until it is back.

      Each VM and page type is its own incident. It closes by itself 24 h after the last page and never sends an "all clear", so closed does not mean recovered.
    EOT
  }

  user_labels = merge(local.policy_labels, { component = "watchdog" })
}
