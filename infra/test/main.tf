# ============================================================================
# Test environment — adopt the retired fs-media VM as a single-box test target
# for the full unified stack (real carrier). See docs/TEST_VM_DEPLOY.md.
#
# FIREWALL: tag-REUSE (no duplication). The VM wears the existing prod tags
# (voip-sbc, voip-media) so it INHERITS the already-present rules:
#   allow-ssh-iap (IAP SSH), voip-sip-inbound (5060 Bandwidth+office),
#   voip-rtp (16384-49151), voip-internal, voip-health-check, voip-sipp-local.
# The ONLY net-new rule below is the WebRTC/UI one (Verto + TURN + the office-
# scoped admin UI/API) — ports nothing else in the project opens.
#
# SAFE BY DESIGN:
#  - The VM is ADOPTED via an import block (not recreated). lifecycle ignore_changes
#    covers immutable/externally-managed attributes; `tofu apply` only updates
#    machine_type, network tags, and the attached external IP.
#  - prevent_destroy = true on the VM and the static IP (per OPENTOFU_PLAN.md).
#  - ALWAYS run `tofu plan` first; confirm the VM shows "update in-place" (NOT replace).
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
  tags         = var.network_tags # reuse prod tags + bypass-vpn + voip-test (see variables.tf)

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

# --- The ONE net-new rule: WebRTC (Verto + TURN) + office-scoped admin UI/API ----
# SSH / SIP / RTP / internal are inherited from existing prod rules via the
# voip-sbc + voip-media tags (see variables.tf) — not duplicated here.
# Scoped to your test client IP(s); Verto/TURN ports are not opened by any other rule.
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
