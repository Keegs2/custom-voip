# ============================================================================
# Verizon-prefix objects — NOT YET CREATED, shipped as commented-out stubs
# ============================================================================
# These need Verizon's answers (docs/VERIZON_IPSEC_TRUNKS_PLAN.md §10): the
# IKE peer addresses, the SIP Gateway / ATF-IP signaling prefixes and the media
# prefixes. Nothing exists in GCP for them today, so there is nothing to import
# and no import block. When the prefixes arrive:
#
#   1. Fill verizon_ike_peers / verizon_sip_prefixes / verizon_media_prefixes
#      in terraform.tfvars (CIDRs; /32 for single hosts).
#   2. Uncomment the resources below.
#   3. `tofu plan` — expect ONLY adds: 3 firewall rules + (3 zones × number of
#      prefixes) routes. Any change/destroy on anything else = stop.
#   4. `tofu apply`.
#
# Until the routes exist, nothing reaches the gateways through the tunnels —
# that is the intended "built dark" state (plan §4.1).
#
# The routes are what make this stack's zones independent: all three zones get
# the SAME destination prefixes at the SAME priority, distinguished ONLY by the
# `vz-{zone}` tag on that zone's SBCs and FSes (tag support on next-hop-ILB
# routes was proven 2026-10-30). The tags themselves are on VMs this stack does
# not manage (README.md).
#
# Route names must be RFC1035 (lowercase, digits, dashes), so the CIDR is
# mangled: 198.51.100.0/24 → vz-east-198-51-100-0-24.
# ============================================================================

# locals {
#   verizon_routes = {
#     for pair in setproduct(keys(local.zones), concat(var.verizon_sip_prefixes, var.verizon_media_prefixes)) :
#     "${pair[0]}-${replace(pair[1], "/[./]/", "-")}" => { zone = pair[0], prefix = pair[1] }
#   }
# }
#
# # Verizon SIP + media prefixes → this zone's gateway pair, via the next-hop
# # ILB (gw-a primary, gw-b failover). Priority 100 beats the default route.
# # Caveat (plan §2.3): when BOTH gateways are unhealthy the route is NOT
# # withdrawn — packets drop; nothing falls through to a lower-priority route.
# resource "google_compute_route" "verizon" {
#   for_each = local.verizon_routes
#
#   name         = "vz-${each.key}"
#   network      = data.google_compute_network.default.self_link
#   dest_range   = each.value.prefix
#   priority     = 100
#   tags         = [local.zones[each.value.zone].tag]
#   next_hop_ilb = google_compute_forwarding_rule.gw_ilb[each.value.zone].self_link
# }
#
# # Verizon IKE peers → gateways: IKEv2 (udp/500) + ESP. No udp/4500: the IKE IP
# # is forwarded straight to the VM, so there is no NAT-T (plan §2.1). Add
# # `allow { protocol = "udp" ports = ["4500"] }` only if Verizon insists on it.
# resource "google_compute_firewall" "verizon_ike" {
#   name      = "vz-ipsec-allow-ike"
#   network   = data.google_compute_network.default.self_link
#   direction = "INGRESS"
#   priority  = 1000
#
#   source_ranges = var.verizon_ike_peers
#   target_tags   = ["vz-ipsec"]
#
#   allow {
#     protocol = "udp"
#     ports    = ["500"]
#   }
#
#   allow {
#     protocol = "esp"
#   }
# }
#
# # Verizon signaling prefixes → the SBCs (the source the SBC sees after the
# # gateway's 1:1 NAT is the Verizon address, so this rule, not a gateway rule,
# # is what admits the INVITE to .251). voip-sbc is the existing SBC VM tag.
# resource "google_compute_firewall" "verizon_sip" {
#   name      = "vz-allow-verizon-sip"
#   network   = data.google_compute_network.default.self_link
#   direction = "INGRESS"
#   priority  = 1000
#
#   source_ranges = var.verizon_sip_prefixes
#   target_tags   = ["voip-sbc"]
#
#   allow {
#     protocol = "udp"
#     ports    = ["5060"]
#   }
#
#   allow {
#     protocol = "tcp"
#     ports    = ["5060"]
#   }
# }
#
# # Verizon media prefixes → FreeSWITCH RTP range. voip-media is the existing
# # FS VM tag.
# resource "google_compute_firewall" "verizon_rtp" {
#   name      = "vz-allow-verizon-rtp"
#   network   = data.google_compute_network.default.self_link
#   direction = "INGRESS"
#   priority  = 1000
#
#   source_ranges = var.verizon_media_prefixes
#   target_tags   = ["voip-media"]
#
#   allow {
#     protocol = "udp"
#     ports    = ["16384-49151"]
#   }
# }
