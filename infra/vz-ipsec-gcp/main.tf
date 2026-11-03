# ============================================================================
# Verizon IPsec — the GCP objects built BY HAND with gcloud on 2026-10-30
# ============================================================================
# Design: docs/VERIZON_IPSEC_TRUNKS_PLAN.md (§2 architecture, §4 resources,
# §4.1 as-built inventory). This stack exists to put those objects under
# OpenTofu state via `import` blocks (imports.tf) AFTER the Verizon turn-up is
# accepted — it creates nothing on its first apply. Read README.md before
# running anything.
#
# Per zone (for_each = local.zones):
#   subnet vz-ipsec-{zone} /28 ─┬─ gw-a VM ── target instance ── {ike-a} L3_DEFAULT rule
#                               └─ gw-b VM ── target instance ── {ike-b} L3_DEFAULT rule
#   gw-a group (primary) + gw-b group (failover) ── {zone}-vz-gw-backend (UDP,
#   HC :8081 /healthz, failover-ratio 0, drop-if-unhealthy) ── {zone}-vz-gw-ilb
#   (the next-hop ILB the tagged routes will point at)
#   EXISTING sbc-group + sbc-standby-group + fs-aware HC ── {zone}-sbc-verizon-backend
#   (UNSPECIFIED, same failover policy) ── {zone}-sbc-verizon-fwd at 10.x.0.251
#   {zone}-vz-sip reserved address — never attached (the gateways 1:1-NAT it)
# Shared: three ingress firewall rules to tag vz-ipsec.
#
# NOT here (and why): see README.md "What this stack does not own".
# ============================================================================

# ----------------------------------------------------------------------------
# Existing objects referenced but NOT managed (data sources)
# ----------------------------------------------------------------------------
data "google_compute_network" "default" {
  name = var.network
}

# The region's `default` subnet — home of the .251 SBC Verizon VIP (same subnet
# as the .250 signaling VIP and the SBC VMs themselves).
data "google_compute_subnetwork" "region_default" {
  for_each = local.zones
  name     = var.network
  region   = each.value.region
}

# The Phase 4b SBC instance groups (active/standby pair). Owned by the pending
# voip-region import (OPENTOFU_PLAN.md §18), referenced here by self_link only.
data "google_compute_instance_group" "sbc_primary" {
  for_each = local.zones
  name     = each.value.sbc_groups.primary
  zone     = each.value.sbc_group_zone
}

data "google_compute_instance_group" "sbc_standby" {
  for_each = local.zones
  name     = each.value.sbc_groups.standby
  zone     = each.value.sbc_group_zone
}

# Project default Compute Engine SA — what gcloud attaches to a VM by default.
data "google_compute_default_service_account" "default" {}

# ----------------------------------------------------------------------------
# Reserved external addresses (9): 6 IKE peer IPs + 3 inside-tunnel SIP IPs
# ----------------------------------------------------------------------------
# These are the values on Verizon's order form. Losing one means a new order
# form and a new tunnel — prevent_destroy on all nine, and `address` is pinned
# so a typo in locals.tf shows up as a (blocked) replacement, never as a
# silent re-reservation.
resource "google_compute_address" "ike" {
  for_each = local.gateways

  name         = each.value.ike_name
  region       = each.value.region
  address      = each.value.ike_ip
  address_type = "EXTERNAL"

  lifecycle {
    prevent_destroy = true
    # The hand-typed gcloud --description text is not recorded in the repo and
    # every address field is immutable (a description diff would plan as a
    # replacement). It carries no behaviour, so it is left as reality has it.
    ignore_changes = [description]
  }
}

resource "google_compute_address" "sip" {
  for_each = local.zones

  name         = "${each.key}-vz-sip"
  region       = each.value.region
  address      = each.value.sip_ip
  address_type = "EXTERNAL"

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description] # gcloud description reads "never attach"; see above
  }
}

# ----------------------------------------------------------------------------
# Gateway subnets — one /28 per zone, Private Google Access on
# ----------------------------------------------------------------------------
# MUST stay out of every Cloud NAT subnet list (plan §4): the gateways' only
# public identity is the forwarded IKE IP (§3.1). East's `ted-auto-dialer-nat`
# is LIST_OF_SUBNETWORKS = default + ted-auto-dialer-subnet; this stack does not
# manage that NAT and must never be extended to.
resource "google_compute_subnetwork" "vz" {
  for_each = local.zones

  name                     = each.value.subnet_name
  region                   = each.value.region
  network                  = data.google_compute_network.default.self_link
  ip_cidr_range            = each.value.subnet_cidr
  private_ip_google_access = true
}

# ----------------------------------------------------------------------------
# Gateway VMs (6) — strongSwan, no external IP, can_ip_forward
# ----------------------------------------------------------------------------
resource "google_compute_instance" "gw" {
  for_each = local.gateways

  name         = each.value.name
  zone         = each.value.zone
  machine_type = "n2-standard-2" # sized for the end state up front (plan §3.6); no post-acceptance resize

  can_ip_forward      = true # emits packets with Verizon source IPs after the stateless 1:1 NAT
  deletion_protection = true
  tags                = local.gateway_tags

  boot_disk {
    initialize_params {
      # Created from the debian-12 family. GCE resolves a family to the dated
      # image that was current on 2026-10-30 (e.g. debian-12-bookworm-v2025MMDD)
      # and that is what import reads back, so `image` is in ignore_changes
      # below — the family is kept here as documentation of what was asked for.
      image = "debian-cloud/debian-12"
      size  = 20
      type  = "pd-balanced"
    }
  }

  # NO access_config: the VM has no primary external IP by design (plan §2.2 /
  # §3.1) — a mis-sourced packet fails loudly instead of leaving as a second
  # public IP Verizon has never seen. network_ip pins the GCE-assigned address
  # so the plan is clean (and so a re-create could never land on a new IP that
  # the ILB health checks and the strongSwan config do not know about).
  network_interface {
    subnetwork = google_compute_subnetwork.vz[each.value.zone_key].self_link
    network_ip = each.value.ip
  }

  # See variables.tf — gcloud's default SA + default scopes unless the build
  # commands said otherwise; null = no service account block at all.
  dynamic "service_account" {
    for_each = var.gateway_service_account == null ? [] : [var.gateway_service_account]
    content {
      email  = coalesce(service_account.value.email, data.google_compute_default_service_account.default.email)
      scopes = service_account.value.scopes
    }
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      # Family → dated image resolution on import (see boot_disk above).
      boot_disk[0].initialize_params[0].image,
      # Host-level metadata (ssh keys, OS Login flags, anything the guest agent
      # or an operator set by hand) is managed outside Tofu, like the .env files.
      metadata,
      # Labels are free-form ops tags; not part of the design.
      labels,
    ]
  }
  # allow_stopping_for_update is deliberately NOT set: any change that would
  # need a stop/start (machine type, service account, nic) must fail at plan
  # time rather than bounce a live tunnel endpoint. Resize = drain first
  # (plan §11 Phase 4), by hand.
}

# ----------------------------------------------------------------------------
# External protocol forwarding: IKE IP → gateway VM (no NAT, dst preserved)
# ----------------------------------------------------------------------------
resource "google_compute_target_instance" "gw" {
  for_each = local.gateways

  name       = "${each.value.name}-ti"
  zone       = each.value.zone
  instance   = google_compute_instance.gw[each.key].self_link
  nat_policy = "NO_NAT"
}

# L3_DEFAULT = every IP protocol (ESP + UDP/500 + the apt/HTTPS replies of plan
# §3.1). The provider docs state L3_DEFAULT requires all_ports = true and may
# only attach to a target instance or an UNSPECIFIED-protocol backend service —
# exactly this shape. `--ports=ALL` was mandatory on the gcloud side too.
resource "google_compute_forwarding_rule" "ike" {
  for_each = local.gateways

  name                  = "${each.value.name}-fwd"
  region                = each.value.region
  load_balancing_scheme = "EXTERNAL"
  ip_protocol           = "L3_DEFAULT"
  all_ports             = true
  ip_address            = google_compute_address.ike[each.key].address
  target                = google_compute_target_instance.gw[each.key].self_link
}

# ----------------------------------------------------------------------------
# Gateway next-hop ILB: 2 unmanaged groups → UDP backend (failover) → ILB rule
# ----------------------------------------------------------------------------
resource "google_compute_instance_group" "gw" {
  for_each = local.gateways

  name      = "${each.value.name}-group"
  zone      = each.value.zone
  instances = [google_compute_instance.gw[each.key].self_link]
}

# HTTP :8081 /healthz served by the gateway health service — passes only while
# that gateway's tunnel AND local datapath are good (plan §3.5). 5s/5s/2/2 ≈ 10 s
# detection, the same cadence as the SBC fs-aware checks.
resource "google_compute_region_health_check" "gw" {
  for_each = local.zones

  name   = "${each.key}-vz-gw-hc"
  region = each.value.region

  check_interval_sec  = 5
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 2

  http_health_check {
    port         = 8081
    request_path = "/healthz"
  }
}

# protocol = UDP, NOT L3_DEFAULT/UNSPECIFIED: GCP refuses an L3_DEFAULT rule as
# a route next hop ("not supported as next hop forwarding rule", proven
# 2026-10-30). A next-hop-ILB route forwards every IP protocol regardless of
# the rule's declared protocol, so UDP is only a label here.
# failover_ratio = 0 + drop_traffic_if_unhealthy: gw-a serves while healthy,
# gw-b only while gw-a is not, nothing sprays both, failback is automatic.
resource "google_compute_region_backend_service" "gw" {
  for_each = local.zones

  name                  = "${each.key}-vz-gw-backend"
  region                = each.value.region
  load_balancing_scheme = "INTERNAL"
  protocol              = "UDP"
  network               = data.google_compute_network.default.self_link
  health_checks         = [google_compute_region_health_check.gw[each.key].self_link]

  backend {
    group = google_compute_instance_group.gw["${each.key}-a"].self_link
  }

  backend {
    group    = google_compute_instance_group.gw["${each.key}-b"].self_link
    failover = true
  }

  failover_policy {
    failover_ratio                       = 0
    drop_traffic_if_unhealthy            = true
    disable_connection_drain_on_failover = true # gcloud --no-connection-drain-on-failover
  }

  lifecycle {
    # google 5.x defaults this to 0 while the API's own default is 300 (the
    # provider changes its default to 300 in 6.0). gcloud did not set it; for a
    # UDP/SIP backend there are no connections to drain, so whatever the API
    # stored is left alone rather than planned into a pointless update.
    ignore_changes = [connection_draining_timeout_sec]
  }
}

resource "google_compute_forwarding_rule" "gw_ilb" {
  for_each = local.zones

  name                  = "${each.key}-vz-gw-ilb"
  region                = each.value.region
  load_balancing_scheme = "INTERNAL"
  ip_protocol           = "UDP"
  all_ports             = true
  network               = data.google_compute_network.default.self_link
  subnetwork            = google_compute_subnetwork.vz[each.key].self_link
  backend_service       = google_compute_region_backend_service.gw[each.key].self_link
  ip_address            = each.value.ilb_ip
}

# ----------------------------------------------------------------------------
# SBC Verizon VIP (.251): new backend over the EXISTING SBC groups + fs-aware HC
# ----------------------------------------------------------------------------
# The proven signaling-ILB pattern (OPENTOFU_PLAN.md §18): zero touch on the
# live signaling backend, same two groups, same health check, same failover
# policy, one L3_DEFAULT/all-ports rule (all-ports also lets PMTU ICMP reach
# the SBC). Reads unhealthy until Kamailio binds :8080 on the .251 VIP.
resource "google_compute_region_backend_service" "sbc_verizon" {
  for_each = local.zones

  name                  = each.value.sbc_backend
  region                = each.value.region
  load_balancing_scheme = "INTERNAL"
  protocol              = "UNSPECIFIED"
  network               = data.google_compute_network.default.self_link
  health_checks         = [local.sbc_hc_self_link[each.key]]

  backend {
    group = data.google_compute_instance_group.sbc_primary[each.key].self_link
  }

  backend {
    group    = data.google_compute_instance_group.sbc_standby[each.key].self_link
    failover = true
  }

  failover_policy {
    failover_ratio                       = 0
    drop_traffic_if_unhealthy            = true
    disable_connection_drain_on_failover = true
  }

  lifecycle {
    ignore_changes = [connection_draining_timeout_sec] # see gw backend above
  }
}

resource "google_compute_forwarding_rule" "sbc_verizon" {
  for_each = local.zones

  name                  = each.value.sbc_fwd
  region                = each.value.region
  load_balancing_scheme = "INTERNAL"
  ip_protocol           = "L3_DEFAULT"
  all_ports             = true
  network               = data.google_compute_network.default.self_link
  subnetwork            = data.google_compute_subnetwork.region_default[each.key].self_link
  backend_service       = google_compute_region_backend_service.sbc_verizon[each.key].self_link
  ip_address            = each.value.sbc_vip
}

# ----------------------------------------------------------------------------
# Firewall — the three Verizon-independent rules (tag vz-ipsec, all zones)
# ----------------------------------------------------------------------------
# The prefix-specific rules (vz-ipsec-allow-ike / vz-allow-verizon-sip /
# vz-allow-verizon-rtp) wait for Verizon's prefixes: verizon_prefixes.tf.

# No public SSH on the IKE IP — IAP TCP forwarding only.
resource "google_compute_firewall" "iap_ssh" {
  name      = "vz-ipsec-allow-iap-ssh"
  network   = data.google_compute_network.default.self_link
  direction = "INGRESS"
  priority  = 1000

  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["vz-ipsec"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# GCP health-check prober ranges → the gateway health endpoint.
resource "google_compute_firewall" "hc" {
  name      = "vz-ipsec-allow-hc"
  network   = data.google_compute_network.default.self_link
  direction = "INGRESS"
  priority  = 1000

  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  target_tags   = ["vz-ipsec"]

  allow {
    protocol = "tcp"
    ports    = ["8081"]
  }
}

# Forwarded traffic from the SBC/FS subnets (and gateway-to-gateway) → gateways:
# the three regions' `default` ranges, the three media subnets, the three
# gateway /28s. All protocols — SIP, RTP, ICMP (PMTU), and the gw-a↔gw-b
# loopback-tunnel drill of plan §11.
resource "google_compute_firewall" "internal_fwd" {
  name      = "vz-ipsec-allow-internal-fwd"
  network   = data.google_compute_network.default.self_link
  direction = "INGRESS"
  priority  = 1000

  source_ranges = [
    "10.142.0.0/20", "10.138.0.0/20", "10.128.0.0/20",       # default subnet, East/West/Central
    "192.168.10.0/24", "192.168.20.0/24", "192.168.30.0/24", # voip-media{,-west,-central}
    "192.168.11.0/28", "192.168.21.0/28", "192.168.31.0/28", # vz-ipsec-{east,west,central}
  ]
  target_tags = ["vz-ipsec"]

  allow {
    protocol = "all"
  }
}
