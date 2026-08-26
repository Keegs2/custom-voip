# ============================================================================
# SBC failover state — health-check-truth pages for the Phase 4b SBC pairs.
# ============================================================================
# Context: each zone's SBC pair is a true active/standby NLB failover pair on
# BOTH traffic planes (external carrier VIP + internal signaling ILB): the
# primary group holds SBC-1 only, SBC-2 sits in a 1-VM standby group attached
# with --failover (failover-ratio=0, drop-traffic-if-unhealthy, no drain).
# Both planes share the zone's fs-aware HTTP health check (:8080 /healthz,
# 5s interval, unhealthy 2 -> ~10-12 s detection), so they elect the SAME
# active SBC, and ESTABLISHED calls survive a flip (stateless in-dialog
# routing — docker/kamailio/CLAUDE.md §8.10).
# Runbook: docs/SBC_ACTIVE_STANDBY_RUNBOOK.md
#
# These policies alert on the health check's OWN state-transition log entries —
# the exact signal the NLB acts on — replacing the previous CPU-metric-absence
# proxy, which only caught VM death (a dead/hung kamailio container leaves
# hypervisor metrics flowing while the LB silently flips to the standby; that
# gap was documented here and is now closed). The old absence policy is
# DELETED, not kept alongside: the log-based page strictly supersedes it (VM
# death also fails the probe -> transition entry) and is faster (~10-12 s HC
# detection + <=1 min log->alert pipeline vs 2-3 min metric absence). The
# generic vm_down policy (main.tf, 5 min absence) remains the VM-death
# backstop — including the pathological case where HC logging gets disabled.
#
# --- Verified log schema (do NOT guess field names) --------------------------
# Source: https://docs.cloud.google.com/load-balancing/docs/health-check-logging
# (verified 2026-08-26):
#   logName       = "projects/PROJECT_ID/logs/compute.googleapis.com%2Fhealthchecks"
#   resource.type = "gce_instance_group" for instance-group backends, with
#                   resource.labels.instance_group_name carrying the group
#                   (NEG backends use gce_network_endpoint_group — n/a here)
#   jsonPayload.healthCheckProbeResult.healthState / .previousHealthState
#                   — coarse enum: HEALTHY | UNHEALTHY
#   jsonPayload.healthCheckProbeResult.detailedHealthState /
#                   .previousDetailedHealthState — HEALTHY, UNHEALTHY,
#                   DRAINING, TIMEOUT, UNKNOWN
#   jsonPayload.healthCheckProbeResult.{ipAddress, targetIp, targetPort,
#                   probeResultText, probeSourceIp, ...} — per-probe detail
#   Emission: "Logs are generated for endpoint health transition only." —
#   NO steady-state volume; a dying SBC logs one entry per (backend service ×
#   transition). Cheap by construction.
#
# The log entry carries NO instance name/id — the individual SBC is identified
# by its 1-VM instance group (resource.labels.instance_group_name), which in
# this architecture IS the primary/standby distinction (the failover-backend
# design guarantees primary group = primary VM). Deliberately NOT also
# matching healthCheckProbeResult.ipAddress: a second match key that can
# silently diverge (IP reassignment) would turn the filter into a silent
# no-op. Both backend services (external + signaling ILB) attach the same two
# groups, so one filter per group covers transitions seen by either plane.
#
# The filter matches healthState="UNHEALTHY" WITHOUT constraining
# previousHealthState: transition-only emission already makes it fire exactly
# at flip time; detail churn while still unhealthy (e.g. TIMEOUT->UNHEALTHY)
# re-matches but is bounded by the 300 s notification_rate_limit (log-based
# policies REQUIRE a rate limit) and doubles as a "still degraded" nudge;
# requiring previousHealthState="HEALTHY" would risk missing the first entry
# after logging-enable or an UNKNOWN initial state. Because entries are
# transition-only, the incident does NOT re-fire while the SBC stays down and
# auto-closes after 24 h even if still failed over — recovery confirmation is
# get-health / the Grafana "Active SBC per zone" row, NOT incident closure.
#
# Zone-dark (BOTH SBCs unhealthy -> drop-traffic-if-unhealthy darkens the VIP)
# is already paged by the per-zone "SIP VIP {zone} unreachable" uptime
# policies in main.tf — deliberately NOT duplicated here. FreeSWITCH death
# fails the fs-aware HC on BOTH SBCs by design, so it fires the primary +
# standby pages AND the VIP page — the VIP page is the headline in that case.
#
# --- ONE-TIME OPERATOR SETUP (workstation gcloud) ----------------------------
# HC logging is OFF by default; without it these policies never see an entry.
# Enable once per zone's attached health check (single lines; also in runbook
# §7). Logging records per-endpoint health-state TRANSITIONS only:
#   gcloud compute health-checks update http east-sbc-fs-aware-hc --region=us-east1 --enable-logging --project=rugged-night-193017
#   gcloud compute health-checks update http west-sbc-healthz-hc --region=us-west1 --enable-logging --project=rugged-night-193017
#   gcloud compute health-checks update http central-sbc-fs-aware-hc --region=us-central1 --enable-logging --project=rugged-night-193017
# ============================================================================

# Rename, not destroy/create: carry the old CPU-absence policies' state over
# so the swap to log-based conditions applies as an in-place update.
moved {
  from = google_monitoring_alert_policy.sbc_failover
  to   = google_monitoring_alert_policy.sbc_primary_unhealthy
}

# ----------------------------------------------------------------------------
# CRITICAL — the zone's PRIMARY SBC went UNHEALTHY: the LB flipped both planes
# to the standby. Calls continue on the standby; SBC redundancy is gone.
# NOTE: §2/§3 runbook drills (container stop/kill on the primary) now FIRE
# this page — that is correct behavior; expect + acknowledge it during drills.
# ----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "sbc_primary_unhealthy" {
  for_each = var.sbc_failover_pairs

  display_name          = "SBC failover state — ${each.key} primary UNHEALTHY (zone on standby)"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "CRITICAL"

  conditions {
    display_name = "${each.key} primary SBC (${each.value.primary}) health-check transition to UNHEALTHY"
    condition_matched_log {
      filter = "logName=\"projects/${var.project}/logs/compute.googleapis.com%2Fhealthchecks\" AND resource.type=\"gce_instance_group\" AND resource.labels.instance_group_name=\"${each.value.primary_group}\" AND jsonPayload.healthCheckProbeResult.healthState=\"UNHEALTHY\""
    }
  }

  alert_strategy {
    auto_close = "86400s"
    notification_rate_limit {
      period = "300s"
    }
  }

  documentation {
    mime_type = "text/markdown"
    subject   = "[CRITICAL] ${title(each.key)} primary SBC UNHEALTHY — zone running on standby ${each.value.standby}"
    content   = "The ${each.key} zone's PRIMARY SBC (${each.value.primary}) transitioned to UNHEALTHY on the fs-aware health check (${each.value.health_check}) — the NLB failover policy flips BOTH planes (external VIP + signaling ILB) to the standby ${each.value.standby} within ~10-12 s of the fault. Calls are flowing on the standby right now.\nIMPACT: established calls SURVIVE the flip (stateless in-dialog routing, docker/kamailio/CLAUDE.md §8.10); setups in flight during the flip were lost (UDP INVITE retransmits self-recover some); the zone is running WITHOUT SBC redundancy until the primary passes its health check again.\nCAUSE is anything the fs-aware /healthz sees: kamailio container dead/hung, the VM dead (vm_down also pages at ~5 min), or FreeSWITCH dead — FS death fails BOTH SBCs and darkens the zone VIP by design; if the \"SIP front door DOWN (${title(each.key)})\" page also fired, work THAT incident.\nDO (in order): 1) ground truth — `gcloud compute backend-services get-health ${each.value.backend} --region=${each.value.region} --project=${var.project}` (signaling plane: same command with ${each.value.ilb_backend}) — expect ${each.value.primary} UNHEALTHY + ${each.value.standby} HEALTHY; 2) place a test call through the zone (+16174544217); 3) recover the primary per the runbook triage order. Failback is automatic (~10-12 s) once its health check passes — confirm via get-health/Grafana, NOT incident closure (transition-only logs; the incident just auto-closes after 24 h).\nRunbook: docs/SBC_ACTIVE_STANDBY_RUNBOOK.md §4 (unplanned failover — triage order)."
  }
}

# ----------------------------------------------------------------------------
# WARNING — the zone's STANDBY SBC went UNHEALTHY while the primary serves.
# No traffic moved, but the zone is now one failure from a zone outage.
# ----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "sbc_standby_unhealthy" {
  for_each = var.sbc_failover_pairs

  display_name          = "SBC failover state — ${each.key} standby UNHEALTHY (redundancy degraded)"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "WARNING"

  conditions {
    display_name = "${each.key} standby SBC (${each.value.standby}) health-check transition to UNHEALTHY"
    condition_matched_log {
      filter = "logName=\"projects/${var.project}/logs/compute.googleapis.com%2Fhealthchecks\" AND resource.type=\"gce_instance_group\" AND resource.labels.instance_group_name=\"${each.value.standby_group}\" AND jsonPayload.healthCheckProbeResult.healthState=\"UNHEALTHY\""
    }
  }

  alert_strategy {
    auto_close = "86400s"
    notification_rate_limit {
      period = "300s"
    }
  }

  documentation {
    mime_type = "text/markdown"
    subject   = "[WARNING] ${title(each.key)} standby SBC UNHEALTHY — redundancy degraded (primary still serving)"
    content   = "The ${each.key} zone's STANDBY SBC (${each.value.standby}) transitioned to UNHEALTHY on the fs-aware health check (${each.value.health_check}). NO traffic impact — the primary (${each.value.primary}) is serving, and the standby carries traffic only during failover.\nIMPACT: SBC redundancy in ${each.key} is GONE — if the primary fails now, drop-traffic-if-unhealthy darkens the zone VIP and Bandwidth retries its other zones (zone outage for new inbound). Restore the standby promptly; do not sit on this one.\nNOTE: if the primary page fired at the same time, FreeSWITCH is likely dead (the fs-aware check fails BOTH SBCs) — work the \"SIP front door DOWN (${title(each.key)})\" incident instead.\nDO: 1) ground truth — `gcloud compute backend-services get-health ${each.value.backend} --region=${each.value.region} --project=${var.project}`; 2) on ${each.value.standby}: `sudo docker ps -a --filter name=voip-kamailio` + `sudo docker logs --tail 100 voip-kamailio`; VM dead -> start it (vm_down also pages at ~5 min); container dead -> hostname-guarded compose up per the runbook.\nRunbook: docs/SBC_ACTIVE_STANDBY_RUNBOOK.md §6 (\"Standby VM dead, primary fine\" row)."
  }
}
