output "bucket" {
  description = "Backup bucket name — set BACKUP_BUCKET in /etc/revup/backup.env to this"
  value       = google_storage_bucket.db_backups.name
}

output "backup_writer_service_account" {
  description = "Service account granted objectAdmin on the bucket"
  value       = local.backup_writer
}

output "snapshot_policy" {
  description = "Snapshot schedule policy name + attached disks"
  value = {
    policy = google_compute_resource_policy.daily_snapshot.name
    disks  = var.snapshot_disks
  }
}
