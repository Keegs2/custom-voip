variable "project" {
  description = "GCP project id"
  type        = string
  default     = "rugged-night-193017"
}

variable "region" {
  description = "Region for the bucket + snapshot policy (keep with the services VM)"
  type        = string
  default     = "us-east1"
}

variable "zone" {
  description = "Zone of the disks the snapshot schedule attaches to"
  type        = string
  default     = "us-east1-b"
}

variable "bucket_name" {
  description = "GCS bucket for ALL database backup artifacts (pgdump/, pgbackrest/, cdr-archive/). Bucket names are global — change if taken."
  type        = string
  default     = "revup-db-backups"
}

variable "backup_writer_service_account" {
  description = "Service account email the services VM runs as (gets objectAdmin on the bucket). Empty = the project's default compute service account. Verify with: gcloud compute instances describe services --zone us-east1-b --format='value(serviceAccounts[].email)'"
  type        = string
  default     = ""
}

variable "drill_reader_service_account" {
  description = "Optional service account email of the restore-DRILL machine (gets read-only objectViewer). Empty = not created."
  type        = string
  default     = ""
}

variable "snapshot_disks" {
  description = "Zonal persistent disks to attach the daily snapshot schedule to. GCE boot disks are usually named after the VM. Verify with: gcloud compute disks list --zones us-east1-b"
  type        = list(string)
  default     = ["services"]
}

variable "snapshot_retention_days" {
  description = "How long automatic disk snapshots are kept"
  type        = number
  default     = 14
}
