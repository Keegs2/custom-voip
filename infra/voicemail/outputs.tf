output "keyring_id" {
  description = "Per-customer KEK key ring (vm-cust-<customer_id> keys are created here by the API)"
  value       = google_kms_key_ring.voicemail.id
}

output "bucket_name" {
  description = "Voicemail ciphertext bucket — VOICEMAIL_BUCKET"
  value       = google_storage_bucket.voicemail.name
}

output "bucket_kms_key_id" {
  description = "Bucket default CMEK key (separate key ring; vm-api has no role on it)"
  value       = google_kms_crypto_key.bucket.id
}

output "vm_api_service_account_email" {
  description = "Dedicated voicemail service account"
  value       = google_service_account.vm_api.email
}

output "gcs_service_agent" {
  description = "GCS service agent granted encrypt/decrypt on the bucket key only"
  value       = data.google_storage_project_service_account.gcs.email_address
}

# Non-secret .env lines for /opt/revup/.env on the services VM. The two secrets
# (VOICEMAIL_PLAYBACK_SECRET, INGEST_SHARED_SECRET) are NOT here — see the runbook.
output "services_env" {
  description = "Paste into /opt/revup/.env on the services VM (tofu output -raw services_env)"
  value = join("\n", compact([
    "VOICEMAIL_KMS_PROVIDER=gcpkms",
    "VOICEMAIL_KMS_PROJECT=${var.project}",
    "VOICEMAIL_KMS_LOCATION=${var.region}",
    "VOICEMAIL_KMS_KEYRING=${google_kms_key_ring.voicemail.name}",
    "VOICEMAIL_BUCKET=${google_storage_bucket.voicemail.name}",
    var.impersonator_service_account != "" ? "VOICEMAIL_IMPERSONATE_SA=${google_service_account.vm_api.email}" : "",
  ]))
}

output "option_a_set_service_account_command" {
  description = "Option A: run while the services VM is STOPPED (maintenance window; it holds the PG primary)"
  value       = "gcloud compute instances set-service-account services --zone us-east1-b --project ${var.project} --service-account ${google_service_account.vm_api.email} --scopes cloud-platform"
}
