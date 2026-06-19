variable "project" {
  description = "GCP project ID"
  type        = string
  default     = "rugged-night-193017"
}

variable "region" {
  description = "GCP region for the test VM + static IP"
  type        = string
  default     = "us-east1"
}

variable "zone" {
  description = "GCP zone for the test VM"
  type        = string
  default     = "us-east1-b"
}

variable "network" {
  description = "VPC network the test VM lives on"
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "Subnet for the test VM (fs-media is on the default subnet)"
  type        = string
  default     = "default"
}

# --- Adopt the existing fs-media VM -----------------------------------------
variable "instance_name" {
  description = "Existing VM to adopt as the test box (the retired fs-media)"
  type        = string
  default     = "fs-media"
}

variable "instance_internal_ip" {
  description = "fs-media's existing internal IP (so import does not try to change it)"
  type        = string
  default     = "10.142.0.102"
}

variable "boot_disk_name" {
  description = "Name/self_link of the VM's existing boot disk (usually == instance_name). Confirm via `tofu plan` and override if different."
  type        = string
  default     = "fs-media"
}

variable "machine_type" {
  description = "Machine type for the test box (full all-in-one stack is heavy)"
  type        = string
  default     = "e2-standard-8"
}

variable "network_tags" {
  description = "bypass-vpn is REQUIRED on the default subnet (Cloud NAT trap); voip-test scopes the firewall rules."
  type        = list(string)
  default     = ["bypass-vpn", "voip-test"]
}

# --- Firewall source scoping ------------------------------------------------
variable "bandwidth_cidrs" {
  description = "Bandwidth carrier signaling/media ranges allowed to reach SIP+RTP"
  type        = list(string)
  default     = ["67.231.0.0/16", "216.82.224.0/19"]
}

variable "office_cidrs" {
  description = "YOUR test-client public IP(s) allowed to reach the UI / API / Verto / TURN. REQUIRED — set in terraform.tfvars."
  type        = list(string)
  # no default — must be set so web ports are never world-open
}

variable "turn_relay_range" {
  description = "coturn relay port range (must match docker/coturn/turnserver.conf)"
  type        = string
  default     = "49160-49200"
}
