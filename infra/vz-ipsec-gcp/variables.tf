variable "project" {
  description = "GCP project id (shared with TED — this stack only ever ADDS resources)"
  type        = string
  default     = "rugged-night-193017"
}

variable "region" {
  description = "Provider default region. Every resource here sets its own region/zone explicitly from locals.tf; this only seeds the provider block."
  type        = string
  default     = "us-east1"
}

variable "network" {
  description = "VPC network every object in this stack lives in (the gateway subnets, ILBs, firewall rules and routes all reference it by name)"
  type        = string
  default     = "default"
}

# --- Gateway VM service account ------------------------------------------------
# `gcloud compute instances create` attaches the project's default Compute
# Engine service account with gcloud's default access scopes unless it was run
# with --no-service-account/--no-scopes. The 2026-10-30 build commands are not
# recorded in the repo, so this is modelled as data rather than hard-coded:
#   * scopes = gcloud's DEFAULT_SCOPES (7 entries — note gcloud includes pubsub,
#     the Cloud Console's "default" set does not).
#   * null  = the VMs were created with NO service account; the block is omitted.
# If `tofu plan` shows an in-place change on service_account for the six
# gateways, copy the real values from
#   gcloud compute instances describe east-vz-gw-a --zone=us-east1-b --format='yaml(serviceAccounts)'
# into terraform.tfvars. Never apply a service-account change from this stack:
# it needs a VM stop/start, which allow_stopping_for_update deliberately leaves off.
variable "gateway_service_account" {
  description = "Service account attached to the six gateway VMs: { email = null (project default compute SA) | \"...\", scopes = [...] }. Set the whole variable to null if the VMs have no service account."
  type = object({
    email  = optional(string)
    scopes = list(string)
  })
  default = {
    email = null
    scopes = [
      "https://www.googleapis.com/auth/devstorage.read_only",
      "https://www.googleapis.com/auth/logging.write",
      "https://www.googleapis.com/auth/monitoring.write",
      "https://www.googleapis.com/auth/pubsub",
      "https://www.googleapis.com/auth/service.management.readonly",
      "https://www.googleapis.com/auth/servicecontrol",
      "https://www.googleapis.com/auth/trace.append",
    ]
  }
  nullable = true
}

# --- Verizon-supplied inputs (docs/VERIZON_IPSEC_TRUNKS_PLAN.md §10) -----------
# These drive the three prefix-specific firewall rules and the tagged next-hop-ILB
# routes in verizon_prefixes.tf, which ship COMMENTED OUT because nothing exists
# in GCP yet to import and the values are unknown until Verizon answers. Fill the
# lists in terraform.tfvars, uncomment the resources, `tofu plan` (expect only
# adds), `tofu apply`. Empty lists are the safe default: with the resources
# commented out they are simply unused.
variable "verizon_ike_peers" {
  description = "Verizon IKEv2 peer addresses (CIDR, /32 each) — source ranges for vz-ipsec-allow-ike (udp/500 + ESP to tag vz-ipsec)"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.verizon_ike_peers : can(cidrhost(c, 0))])
    error_message = "Each entry must be a CIDR, e.g. 203.0.113.10/32."
  }
}

variable "verizon_sip_prefixes" {
  description = "Verizon SIP Gateway / ATF-IP SBC signaling prefixes (CIDR) — source ranges for vz-allow-verizon-sip (5060 udp+tcp to tag voip-sbc) and dest_range of the per-zone tagged routes"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.verizon_sip_prefixes : can(cidrhost(c, 0))])
    error_message = "Each entry must be a CIDR, e.g. 198.51.100.0/24."
  }
}

variable "verizon_media_prefixes" {
  description = "Verizon media prefixes (CIDR) — source ranges for vz-allow-verizon-rtp (udp 16384-49151 to tag voip-media) and dest_range of the per-zone tagged routes"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.verizon_media_prefixes : can(cidrhost(c, 0))])
    error_message = "Each entry must be a CIDR, e.g. 198.51.100.0/24."
  }
}
