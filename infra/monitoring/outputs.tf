output "notification_channels" {
  description = "Channel ids wired to every policy"
  value       = local.channels
}

output "uptime_check_ids" {
  description = "Uptime check ids (SIP VIP / API / UI)"
  value = {
    sip_vip = google_monitoring_uptime_check_config.sip_vip.uptime_check_id
    api     = google_monitoring_uptime_check_config.api_health.uptime_check_id
    ui      = google_monitoring_uptime_check_config.ui.uptime_check_id
  }
}

output "prober_source_ranges_count" {
  description = "How many Google prober IPv4s the uptime firewall rules admit"
  value       = length(local.prober_ipv4)
}
