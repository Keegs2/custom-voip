# ============================================================================
# The ONE per-zone map. Everything in main.tf / imports.tf is derived from it.
# ============================================================================
# Values are the 2026-10-30 as-built ground truth from
# docs/VERIZON_IPSEC_TRUNKS_PLAN.md §2.2 / §4.1 (what gcloud actually created),
# NOT a design target: import ids in imports.tf and the resource names below
# must match reality byte-for-byte or the import plan shows changes.
#
# Per zone:
#   region         GCP region
#   tag            network tag the zone's SBC/FS VMs carry for the tagged routes
#                  (the tag itself is applied to VMs this stack does not manage)
#   subnet_name    the gateway /28 (`vz-ipsec-{zone}`), Private Google Access on,
#                  NOT in any Cloud NAT subnet list
#   subnet_cidr    its range
#   ilb_ip         the next-hop ILB rule `{zone}-vz-gw-ilb` (inside the /28)
#   sip_ip         `{zone}-vz-sip`, the inside-tunnel SIP address Verizon sees
#                  (reserved, NEVER attached; the gateways 1:1-NAT it to sbc_vip)
#   sbc_vip        `.251` in the region's `default` subnet — the SBC Verizon VIP
#   sbc_group_zone zone of the EXISTING SBC instance groups (both live in -b)
#   sbc_groups     the EXISTING primary/standby SBC groups (Phase 4b HA) — data
#                  sources, not managed here
#   sbc_hc         the EXISTING regional fs-aware :8080 /healthz check — not
#                  managed here (East/Central `*-fs-aware-hc`, West `*-healthz-hc`)
#   sbc_backend    name of the SBC Verizon VIP backend service (East has no
#                  zone prefix, like the signaling ILB convention)
#   sbc_fwd        name of its L3_DEFAULT forwarding rule
#   gateways       a/b = the two gateway VMs: zone (two different zones of the
#                  region; Central landed in -a/-f because -b/-c were out of
#                  n2-standard-2 stock), VPC ip inside the /28 (auto-assigned by
#                  GCE at create time, pinned here so the plan is clean), and
#                  ike_ip = the reserved `{zone}-vz-ike-{a|b}` address attached
#                  by protocol forwarding (= the VM's only public identity)
locals {
  zones = {
    east = {
      region         = "us-east1"
      tag            = "vz-east"
      subnet_name    = "vz-ipsec-east"
      subnet_cidr    = "192.168.11.0/28"
      ilb_ip         = "192.168.11.4"
      sip_ip         = "34.148.100.185"
      sbc_vip        = "10.142.0.251"
      sbc_group_zone = "us-east1-b"
      sbc_groups     = { primary = "sbc-group", standby = "sbc-standby-group" }
      sbc_hc         = "east-sbc-fs-aware-hc"
      sbc_backend    = "sbc-verizon-backend"
      sbc_fwd        = "sbc-verizon-fwd"
      gateways = {
        a = { zone = "us-east1-b", ip = "192.168.11.2", ike_ip = "35.231.206.85" }
        b = { zone = "us-east1-c", ip = "192.168.11.3", ike_ip = "34.26.69.151" }
      }
    }
    west = {
      region         = "us-west1"
      tag            = "vz-west"
      subnet_name    = "vz-ipsec-west"
      subnet_cidr    = "192.168.21.0/28"
      ilb_ip         = "192.168.21.4"
      sip_ip         = "136.86.242.57"
      sbc_vip        = "10.138.0.251"
      sbc_group_zone = "us-west1-b"
      sbc_groups     = { primary = "west-sbc-group", standby = "west-sbc-standby-group" }
      sbc_hc         = "west-sbc-healthz-hc"
      sbc_backend    = "west-sbc-verizon-backend"
      sbc_fwd        = "west-sbc-verizon-fwd"
      gateways = {
        a = { zone = "us-west1-b", ip = "192.168.21.2", ike_ip = "8.231.131.118" }
        b = { zone = "us-west1-c", ip = "192.168.21.3", ike_ip = "136.66.170.29" }
      }
    }
    central = {
      region         = "us-central1"
      tag            = "vz-central"
      subnet_name    = "vz-ipsec-central"
      subnet_cidr    = "192.168.31.0/28"
      ilb_ip         = "192.168.31.2"
      sip_ip         = "35.184.132.124"
      sbc_vip        = "10.128.0.251"
      sbc_group_zone = "us-central1-b"
      sbc_groups     = { primary = "central-sbc-group", standby = "central-sbc-standby-group" }
      sbc_hc         = "central-sbc-fs-aware-hc"
      sbc_backend    = "central-sbc-verizon-backend"
      sbc_fwd        = "central-sbc-verizon-fwd"
      gateways = {
        a = { zone = "us-central1-a", ip = "192.168.31.4", ike_ip = "34.68.252.50" }
        b = { zone = "us-central1-f", ip = "192.168.31.5", ike_ip = "34.171.191.175" }
      }
    }
  }

  # Flattened per-gateway map, keyed "east-a" ... "central-b". Every per-VM
  # resource (address, instance, target instance, protocol-forwarding rule,
  # instance group) for_eaches over this so there is one definition, not six.
  gateways = merge([
    for zk, z in local.zones : {
      for side, g in z.gateways : "${zk}-${side}" => {
        zone_key = zk
        side     = side
        name     = "${zk}-vz-gw-${side}"  # VM; "-ti", "-fwd", "-group" are derived
        ike_name = "${zk}-vz-ike-${side}" # reserved external address
        region   = z.region
        zone     = g.zone
        ip       = g.ip
        ike_ip   = g.ike_ip
      }
    }
  ]...)

  # The google provider (5.x) has no data source for REGIONAL health checks
  # (data.google_compute_health_check is global-only), so the existing fs-aware
  # SBC checks are referenced by their self_link, built the way the API returns
  # it. health_checks is a set hashed on the relative path, so this matches the
  # imported value exactly and plans clean.
  sbc_hc_self_link = {
    for zk, z in local.zones :
    zk => "https://www.googleapis.com/compute/v1/projects/${var.project}/regions/${z.region}/healthChecks/${z.sbc_hc}"
  }

  gateway_tags = ["bypass-vpn", "vz-ipsec"]
}
