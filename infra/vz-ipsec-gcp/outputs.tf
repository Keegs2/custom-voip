output "ike_peer_ips" {
  description = "Reserved IKE peer addresses per gateway (the six Section 1 slots on Verizon's order form)"
  value       = { for k, a in google_compute_address.ike : k => a.address }
}

output "sip_inside_tunnel_ips" {
  description = "Reserved inside-tunnel SIP addresses per zone (what Verizon sees as our SIP source; never attached)"
  value       = { for k, a in google_compute_address.sip : k => a.address }
}

output "gateway_vpc_ips" {
  description = "Gateway VM VPC addresses inside the vz-ipsec /28s"
  value       = { for k, g in local.gateways : k => g.ip }
}

output "gateway_ilb_ips" {
  description = "Per-zone next-hop ILB addresses — the next_hop_ilb of the tagged Verizon routes"
  value       = { for k, r in google_compute_forwarding_rule.gw_ilb : k => r.ip_address }
}

output "gateway_ilb_self_links" {
  description = "Per-zone next-hop ILB forwarding-rule self_links (what a google_compute_route.next_hop_ilb takes)"
  value       = { for k, r in google_compute_forwarding_rule.gw_ilb : k => r.self_link }
}

output "sbc_verizon_vips" {
  description = "Per-zone SBC Verizon VIPs (.251) — what the gateways 1:1-NAT the SIP inside-tunnel IP to"
  value       = { for k, r in google_compute_forwarding_rule.sbc_verizon : k => r.ip_address }
}

output "route_tags" {
  description = "Per-zone network tag the tagged Verizon routes use (applied by hand to that zone's SBC/FS VMs — not managed here)"
  value       = { for k, z in local.zones : k => z.tag }
}
