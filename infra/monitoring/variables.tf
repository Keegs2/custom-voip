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
  description = "Passthrough-NLB VIP Bandwidth targets (TCP 5060 probe)"
  type        = string
  default     = "34.24.133.82"
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
  description = "GCE instance names to cover with VM-down / disk / memory / CPU alerts"
  type        = list(string)
  default     = ["poc-custom-voip", "kam-g2", "fs-media-v2", "services"]
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

# --- Thresholds ----------------------------------------------------------------
variable "disk_percent_threshold" {
  description = "Page when any real filesystem exceeds this used%% (replication-slot WAL, ClickHouse and PG can all silently fill the services disk)"
  type        = number
  default     = 85
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
