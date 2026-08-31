variable "project" {
  description = "GCP project id"
  type        = string
  default     = "rugged-night-193017"
}

variable "region" {
  description = "Primary region (East)"
  type        = string
  default     = "us-east1"
}

variable "network" {
  description = "VPC network for the uptime-prober firewall rules"
  type        = string
  default     = "default"
}

# --- What we probe (East ground truth per CLAUDE.md, 2026-04-30) -------------
variable "nlb_vip" {
  description = "East passthrough-NLB VIP Bandwidth targets (TCP 5060 probe)"
  type        = string
  default     = "34.24.133.82"
}

variable "nlb_vip_west" {
  description = "West passthrough-NLB VIP (TCP 5060 probe)"
  type        = string
  default     = "35.252.214.40"
}

variable "nlb_vip_central" {
  description = "Central passthrough-NLB VIP (TCP 5060 probe)"
  type        = string
  default     = "35.253.133.230"
}

variable "services_public_ip" {
  description = "Services VM public IP (API + UI probes)"
  type        = string
  default     = "34.26.57.37"
}

variable "api_port" {
  description = "API host port on the services VM (plain HTTP /health)"
  type        = number
  default     = 8088
}

variable "ui_https_port" {
  description = "UI HTTPS host port on the services VM (self-signed today, so validate_ssl=false)"
  type        = number
  default     = 8443
}

variable "instances" {
  description = "GCE instance names to cover with VM-down / disk / memory / CPU alerts (16 always-on production VMs across the 3 zones incl. the Phase 4c *-fs-2 media-HA hot standbys — apply only AFTER those VMs exist; the idle west-loadtest test box is excluded so it never false-pages when stopped)"
  type        = list(string)
  default = [
    # East (us-east1) — east-fs-2 = media-HA hot standby (Phase 4c)
    "poc-custom-voip", "kam-g2", "fs-media-v2", "east-fs-2", "services", "east-db-standby",
    # West (us-west1) — west-loadtest excluded: idle/banked test box, would false-page when stopped
    "west-sbc-1", "west-sbc-2", "west-fs", "west-fs-2", "west-db",
    # Central (us-central1)
    "central-sbc-1", "central-sbc-2", "central-fs", "central-fs-2", "central-db",
  ]
}

variable "sbc_failover_pairs" {
  description = "Per-zone SBC active/standby pairs (Phase 4b HA). Drives the per-zone log-based 'SBC failover state' policies (sbc_failover.tf). primary/standby = VM names (incident text only); primary_group/standby_group = the 1-VM unmanaged instance groups whose health-check transition logs identify each SBC (resource.labels.instance_group_name — HC log entries carry no instance name); backend/ilb_backend/region feed the incident's get-health ground-truth commands; health_check = the attached HC that needs logging enabled once (commands in the sbc_failover.tf header + runbook §7)."
  type = map(object({
    primary       = string
    standby       = string
    primary_group = string
    standby_group = string
    backend       = string
    ilb_backend   = string
    health_check  = string
    region        = string
  }))
  default = {
    east = {
      primary       = "poc-custom-voip"
      standby       = "kam-g2"
      primary_group = "sbc-group"
      standby_group = "sbc-standby-group"
      backend       = "sbc-backend"
      ilb_backend   = "sbc-signaling-backend"
      health_check  = "east-sbc-fs-aware-hc"
      region        = "us-east1"
    }
    west = {
      primary       = "west-sbc-1"
      standby       = "west-sbc-2"
      primary_group = "west-sbc-group"
      standby_group = "west-sbc-standby-group"
      backend       = "west-sbc-backend"
      ilb_backend   = "west-sbc-signaling-backend"
      health_check  = "west-sbc-healthz-hc"
      region        = "us-west1"
    }
    central = {
      primary       = "central-sbc-1"
      standby       = "central-sbc-2"
      primary_group = "central-sbc-group"
      standby_group = "central-sbc-standby-group"
      backend       = "central-sbc-backend"
      ilb_backend   = "central-sbc-signaling-backend"
      health_check  = "central-sbc-fs-aware-hc"
      region        = "us-central1"
    }
  }
}

# --- Who gets paged -----------------------------------------------------------
variable "notification_email" {
  description = "REQUIRED — ops email address that receives all alerts"
  type        = string
}

variable "pagerduty_service_key" {
  description = "Optional PagerDuty Events v2 integration key; empty = no PagerDuty channel"
  type        = string
  default     = ""
  sensitive   = true
}

variable "sms_number" {
  description = "Optional SMS number (E.164, e.g. +15085551234). NOTE: GCP requires verifying the number in the Cloud Console after apply before SMS delivery starts."
  type        = string
  default     = ""
}

variable "slack_channel_ids" {
  description = "Existing Slack notification channel IDs (console-created, full resource names) added to every alert policy. Console-managed — NOT created by this module."
  type        = list(string)
  default     = []
}

# --- Thresholds ----------------------------------------------------------------
variable "disk_percent_threshold" {
  description = "CRITICAL page when any real filesystem exceeds this used%% (replication-slot WAL, ClickHouse and PG can all silently fill the services disk)"
  type        = number
  default     = 85
}

variable "disk_warn_percent_threshold" {
  description = "WARNING (keep-an-eye) when a real filesystem exceeds this used%% — fires before the critical threshold so the disk can be triaged early"
  type        = number
  default     = 78
}

variable "memory_percent_threshold" {
  description = "Page when VM memory used%% exceeds this for 10 minutes"
  type        = number
  default     = 90
}

variable "cpu_utilization_threshold" {
  description = "Page when VM CPU exceeds this fraction for 15 minutes"
  type        = number
  default     = 0.9
}

variable "manage_uptime_firewall" {
  description = "Create the firewall rules that admit Google's uptime probers to VIP:5060 (voip-sbc) and the API/UI ports (voip-services). Required for the uptime checks to pass, since those ports are otherwise restricted to Bandwidth/office CIDRs."
  type        = bool
  default     = true
}
