# ============================================================================
# Test environment — adopt the retired fs-media VM as a single-box test target
# for the full unified stack (real carrier). See docs/TEST_VM_DEPLOY.md.
#
# SAFE BY DESIGN:
#  - The VM is ADOPTED via an import block (not recreated). lifecycle ignore_changes
#    covers the immutable/externally-managed attributes so `tofu apply` only updates
#    machine_type, network tags, and the attached external IP.
#  - prevent_destroy = true on the VM and the static IP (per OPENTOFU_PLAN.md).
#  - ALWAYS run `tofu plan` first and confirm the VM shows "update in-place"
#    (NOT "replace"/"destroy"). If it wants to replace, fix boot_disk_name / the
#    network_interface to match the real fs-media before applying.
# ============================================================================

# --- Static external IP for the test box ------------------------------------
resource "google_compute_address" "test_ip" {
  name   = "fs-media-test-ip"
  region = var.region

  lifecycle {
    prevent_destroy = true
  }
}

# --- Adopt fs-media ----------------------------------------------------------
import {
  to = google_compute_instance.test_fs
  id = "projects/${var.project}/zones/${var.zone}/instances/${var.instance_name}"
}

resource "google_compute_instance" "test_fs" {
  name         = var.instance_name
  zone         = var.zone
  machine_type = var.machine_type
  tags         = var.network_tags

  # Allow tofu to stop the VM to change the machine type.
  allow_stopping_for_update = true

  boot_disk {
    source = var.boot_disk_name
  }

  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
    network_ip = var.instance_internal_ip

    access_config {
      nat_ip = google_compute_address.test_ip.address
    }
  }

  lifecycle {
    prevent_destroy = true
    # Adopt-and-manage only machine_type / tags / access_config. Everything else
    # is taken from the existing VM and left alone (prevents accidental replace).
    ignore_changes = [
      metadata,
      metadata_startup_script,
      service_account,
      scheduling,
      labels,
      min_cpu_platform,
      attached_disk,
      can_ip_forward,
      hostname,
      resource_policies,
      enable_display,
      guest_accelerator,
    ]
  }
}

# --- Firewall (scoped by the voip-test tag) ----------------------------------
# SIP signaling from Bandwidth only.
resource "google_compute_firewall" "test_sip" {
  name      = "voip-test-sip"
  network   = var.network
  direction = "INGRESS"

  allow {
    protocol = "udp"
    ports    = ["5060"]
  }
  allow {
    protocol = "tcp"
    ports    = ["5060"]
  }

  source_ranges = var.bandwidth_cidrs
  target_tags   = ["voip-test"]
}

# RTP media from Bandwidth only.
resource "google_compute_firewall" "test_rtp" {
  name      = "voip-test-rtp"
  network   = var.network
  direction = "INGRESS"

  allow {
    protocol = "udp"
    ports    = ["16384-49151"]
  }

  source_ranges = var.bandwidth_cidrs
  target_tags   = ["voip-test"]
}

# SSH — from your workstation AND Google's IAP range (browser "SSH-in-browser").
# Needed because adopting fs-media swapped its tags off voip-media, dropping its
# old SSH allowance; the voip-test rules below only open SIP/RTP/web.
resource "google_compute_firewall" "test_ssh" {
  name      = "voip-test-ssh"
  network   = var.network
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # 35.235.240.0/20 = Google IAP TCP-forwarding range (browser/IAP SSH).
  source_ranges = concat(var.office_cidrs, ["35.235.240.0/20"])
  target_tags   = ["voip-test"]
}

# UI / API / Verto WSS / TURN — from YOUR test client IP(s) only.
resource "google_compute_firewall" "test_web" {
  name      = "voip-test-web"
  network   = var.network
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["8088", "8080", "8082", "8083", "3478", "5349"]
  }
  allow {
    protocol = "udp"
    ports    = ["3478", var.turn_relay_range]
  }

  source_ranges = var.office_cidrs
  target_tags   = ["voip-test"]
}
