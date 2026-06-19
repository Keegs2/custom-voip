output "test_public_ip" {
  description = "The test VM's external IP — use this for EXTERNAL_SIP_IP/RTP_IP/TURN_HOST in .env, and point the Bandwidth test DID here."
  value       = google_compute_address.test_ip.address
}

output "test_internal_ip" {
  value = var.instance_internal_ip
}

output "ssh_command" {
  value = "gcloud compute ssh ${var.instance_name} --zone=${var.zone}"
}

output "next_steps" {
  value = "Set EXTERNAL_SIP_IP=${google_compute_address.test_ip.address} in /opt/revup/.env (from .env.test.example), then follow docs/TEST_VM_DEPLOY.md Step 3+."
}
