# ============================================================================
# Monitoring + alerting for the live RCF production (audit P0-2).
# ============================================================================
# Before this module: no metrics, no probes, no paging — outage detection was
# "a customer calls Granite." After: GCP-native uptime checks on the three
# customer-visible front doors, VM-down/disk/memory/CPU alerts on all 4 VMs,
# and a syslog "revup-alert" log-match policy that lets ANY on-VM script/unit
# page by writing one logger line (backups + slot-WAL watchdog use it).
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

locals {
  channels = concat(
    [google_monitoring_notification_channel.email.id],
    google_monitoring_notification_channel.pagerduty[*].id,
    google_monitoring_notification_channel.sms[*].id,
  )
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
locals {
  uptime_checks = {
    "SIP VIP 5060 unreachable (calls failing)" = google_monitoring_uptime_check_config.sip_vip.uptime_check_id
    "API /health failing"                      = google_monitoring_uptime_check_config.api_health.uptime_check_id
    "UI unreachable"                           = google_monitoring_uptime_check_config.ui.uptime_check_id
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  for_each = local.uptime_checks

  display_name          = each.key
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "CRITICAL"

  conditions {
    display_name = each.key
    condition_threshold {
      filter          = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id = \"${each.value}\""
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
    content   = "Uptime probe failing from multiple regions. SIP VIP failing = inbound RCF calls are failing NOW. Triage: NLB backend health, `sudo docker ps` on both SBCs, then Homer. SLO context: infra/monitoring/SLOS.md."
  }
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

  dynamic "conditions" {
    for_each = toset(var.instances)
    content {
      display_name = "VM down: ${conditions.value}"
      condition_absent {
        filter   = "resource.type = \"gce_instance\" AND metric.type = \"compute.googleapis.com/instance/cpu/utilization\" AND metadata.system_labels.name = \"${conditions.value}\""
        duration = "300s"

        aggregations {
          alignment_period   = "60s"
          per_series_aligner = "ALIGN_MEAN"
        }

        trigger {
          count = 1
        }
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "No hypervisor metrics for 5 min — instance stopped, crashed, or the project lost it. An SBC down halves SIP capacity (NLB reroutes); the media VM down = ALL in-zone calls; services VM down = ALL new-call DID lookups fail + portal/API dark."
  }
}

# ----------------------------------------------------------------------------
# Disk > threshold — requires the Ops Agent (scripts/monitoring/).
# The replication slot, ClickHouse and PG can silently fill the services disk.
# ----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "disk_used" {
  display_name          = "Disk used > ${var.disk_percent_threshold}%"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "CRITICAL"

  conditions {
    display_name = "Filesystem used percent"
    condition_threshold {
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/disk/percent_used\" AND metric.labels.state = \"used\" AND NOT metric.labels.device = monitoring.regex.full_match(\"(tmpfs|udev|overlay.*|/dev/loop.*)\")"
      comparison      = "COMPARISON_GT"
      threshold_value = var.disk_percent_threshold
      duration        = "600s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.label.instance_id", "metric.label.device"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "A filesystem crossed ${var.disk_percent_threshold}%. On the services VM check, in order: replication-slot WAL retention (`journalctl -t revup-backup | grep slot-wal`), pg_wal size, ClickHouse volume, /var/backups/revup. PG hitting a full disk = full new-call outage."
  }
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
        group_by_fields      = ["resource.label.instance_id"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Sustained high memory. FreeSWITCH under memory pressure degrades media before it OOMs; on the services VM suspect ClickHouse/qryn first (qryn runs with a 4 GB heap)."
  }
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
        group_by_fields      = ["resource.label.instance_id"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Sustained CPU saturation — capacity ceiling or a runaway process. Per PRODUCTION_ARCHITECTURE.md §13, trigger capacity planning at 70% of rated load; 90% sustained is an incident."
  }
}

# ----------------------------------------------------------------------------
# revup-alert log-match — the on-VM paging hook.
# Anything on any VM can page by writing one syslog line:
#     logger -p user.err -t revup-alert -- "what broke"
# Used today by: backup unit failures (revup-alert@.service) and the
# replication-slot WAL watchdog. Requires the Ops Agent (ships syslog).
# ----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "revup_alert_log" {
  display_name          = "revup-alert (on-VM condition: backups, slot WAL, ...)"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "CRITICAL"

  conditions {
    display_name = "syslog contains revup-alert"
    condition_matched_log {
      filter = "resource.type=\"gce_instance\" AND logName:\"syslog\" AND (jsonPayload.message:\"revup-alert\" OR textPayload:\"revup-alert\")"
    }
  }

  alert_strategy {
    auto_close = "86400s"
    notification_rate_limit {
      period = "1800s"
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "An on-VM watchdog paged. The log line names the failing unit/condition. Backup failures: `journalctl -u <unit>` on the services VM. Slot-WAL: scripts/backup/slot_wal_guard.sh header explains the fix."
  }
}
