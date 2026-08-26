# ============================================================================
# SBC failover state — a zone's PRIMARY SBC is down (Phase 4b active/standby).
# ============================================================================
# Context: each zone's SBC pair is a true active/standby NLB failover pair
# (primary group = SBC-1, standby group = SBC-2 attached with --failover;
# failover-ratio=0, drop-traffic-if-unhealthy, no drain). When the primary
# dies, the external NLB + the signaling ILB flip to the standby in ~6s
# (shared tcp:5060 health check, 3s/2s/2/2) and ESTABLISHED calls survive the
# flip (stateless in-dialog routing — docker/kamailio/CLAUDE.md §8.10). This
# page therefore means: "zone X is running on its STANDBY SBC — calls
# continue, but the zone has NO SBC redundancy left."
#
# Metric family: same as vm_down — absence of the hypervisor CPU series
# (compute.googleapis.com/instance/cpu/utilization), which needs no agent and
# goes dark within a minute of the instance stopping/crashing/being lost.
# One policy per zone (mirrors the per-zone SIP-VIP uptime policies) so the
# incident names the zone and both VMs. Duration 120s: the hypervisor series
# is 1-minute-sampled, so 120s is the tightest ">60s down" that does not flap
# on ingest jitter (a 60s absence window on a 60s-sampled series false-fires
# on late points); it also pages ~3 minutes before the generic vm_down (300s).
#
# Honest limits (same family limits as vm_down): this fires on VM death, NOT
# on a hung-but-running kamailio — the VM keeps writing hypervisor metrics
# while the NLB health check fails and the standby silently takes over. That
# state is visible on the Grafana Traffic Status "Active SBC per zone" row and
# via `gcloud compute backend-services get-health <zone backend> --region=...`.
# Runbook: docs/SBC_ACTIVE_STANDBY_RUNBOOK.md
# ============================================================================

resource "google_monitoring_alert_policy" "sbc_failover" {
  for_each = var.sbc_failover_pairs

  display_name          = "SBC failover state — ${each.key} primary down (zone on standby)"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "CRITICAL"

  conditions {
    display_name = "${each.key} primary SBC (${each.value.primary}) hypervisor metrics absent"
    condition_absent {
      filter   = "resource.type = \"gce_instance\" AND metric.type = \"compute.googleapis.com/instance/cpu/utilization\" AND metadata.system_labels.name = \"${each.value.primary}\""
      duration = "120s"

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
    subject   = "[CRITICAL] ${title(each.key)} primary SBC DOWN — zone failed over to standby ${each.value.standby}"
    content   = "The ${each.key} zone's PRIMARY SBC (${each.value.primary}) stopped reporting hypervisor metrics for 2 minutes — the VM is stopped, crashed, or lost. The NLB failover policy should already have flipped the zone (external VIP + signaling ILB) to the standby SBC ${each.value.standby} in ~6s.\nIMPACT: established calls SURVIVE the flip (stateless in-dialog routing, docker/kamailio/CLAUDE.md §8.10); call setups in flight during the ~6s flip were lost (UDP INVITE retransmits may self-recover); the zone is now running WITHOUT SBC redundancy until the primary returns.\nDO (in order): 1) confirm the standby took over — `gcloud compute backend-services get-health ${each.value.backend} --region=${each.value.region}` shows ${each.value.primary} UNHEALTHY + ${each.value.standby} HEALTHY, and the Grafana Traffic Status \"Active SBC per zone\" row goes green on ${each.value.standby}; 2) place a new test call through the zone; 3) recover the primary (GCP console; if it boots, `sudo docker ps` for the kamailio container). Failback is automatic (~6s) once its tcp:5060 health check passes — no manual step.\nRunbook: docs/SBC_ACTIVE_STANDBY_RUNBOOK.md"
  }
}
