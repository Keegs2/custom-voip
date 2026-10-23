variable "project" {
  description = "GCP project id"
  type        = string
  default     = "rugged-night-193017"
}

variable "region" {
  description = "Location of the key rings and the bucket. Keep with the services VM (East); KMS key and CMEK bucket MUST share a location."
  type        = string
  default     = "us-east1"
}

# --- KMS -----------------------------------------------------------------------

variable "keyring_name" {
  description = "Key ring holding ONLY the per-customer KEKs (vm-cust-<customer_id>) the API creates at runtime. Must match VOICEMAIL_KMS_KEYRING in the services .env."
  type        = string
  default     = "voicemail-prod"
}

variable "bucket_keyring_name" {
  description = "Separate key ring holding ONLY the bucket's CMEK key. vm-api gets no role on it (see main.tf)."
  type        = string
  default     = "voicemail-bucket"
}

variable "bucket_key_name" {
  description = "CMEK key used as the bucket's default encryption key"
  type        = string
  default     = "voip-voicemail-bucket"
}

variable "bucket_key_rotation_period" {
  description = "Automatic rotation of the bucket CMEK key, in seconds with an 's' suffix. 90 d (CIS GCP 1.10). Old versions stay enabled, so existing objects stay readable."
  type        = string
  default     = "7776000s"

  validation {
    condition     = can(regex("^[0-9]+s$", var.bucket_key_rotation_period))
    error_message = "Use seconds with an 's' suffix, e.g. \"7776000s\" (90 days). Minimum 86400s."
  }
}

variable "key_lifecycle_role_id" {
  description = "Project custom role id for the per-customer key lifecycle permissions (bound on the voicemail-prod key ring only)"
  type        = string
  default     = "voicemailKeyLifecycle"
}

# --- Bucket ----------------------------------------------------------------------

variable "bucket_name" {
  description = "GCS bucket for voicemail ciphertext. Must match VOICEMAIL_BUCKET. Bucket names are global; change if taken."
  type        = string
  default     = "voip-voicemail"
}

variable "soft_delete_retention_days" {
  description = "Bucket soft-delete window (days). Deleted/purged ciphertext stays restorable this long. 0 disables; otherwise GCS allows 7-90."
  type        = number
  default     = 7

  validation {
    condition     = var.soft_delete_retention_days == 0 || (var.soft_delete_retention_days >= 7 && var.soft_delete_retention_days <= 90)
    error_message = "soft_delete_retention_days must be 0 or between 7 and 90."
  }
}

# --- Identity --------------------------------------------------------------------

variable "service_account_id" {
  description = "account_id of the dedicated voicemail service account (email = <id>@<project>.iam.gserviceaccount.com)"
  type        = string
  default     = "vm-api"
}

variable "vm_api_is_services_vm_identity" {
  description = "Runbook option A (preferred): vm-api is attached to the services VM and replaces the default compute SA for EVERYTHING on that VM. When true, vm-api also gets the non-voicemail grants the VM's other workloads need (backup bucket, Ops Agent, Grafana). Set false for option B (impersonation) or C (key file), where the VM keeps its current SA."
  type        = bool
  default     = true
}

variable "services_vm_project_roles" {
  description = "Project roles vm-api needs when it is the services VM identity (option A). Mirror what the runbook's pre-check shows the default compute SA holds today, but NEVER add roles/editor or roles/owner."
  type        = list(string)
  default = [
    "roles/logging.logWriter",       # Ops Agent: syslog (revup-alert paging lines)
    "roles/monitoring.metricWriter", # Ops Agent: host metrics + heplify Prometheus scrape
    "roles/monitoring.viewer",       # Grafana "GCP Monitoring" datasource (authenticationType: gce)
  ]

  validation {
    condition     = length(setintersection(toset(var.services_vm_project_roles), toset(["roles/editor", "roles/owner"]))) == 0
    error_message = "Do not give vm-api roles/editor or roles/owner: it would defeat the least-privilege design."
  }
}

variable "backup_bucket_name" {
  description = "Backup bucket the services VM writes (infra/backups). When vm_api_is_services_vm_identity = true, vm-api gets objectAdmin on it so pgBackRest WAL archiving, pg_dump and the CDR archive keep working after the SA swap. Empty = skip."
  type        = string
  default     = "revup-db-backups"
}

variable "impersonator_service_account" {
  description = "Runbook option B: email of the SA the services VM runs as today (default compute SA, 562404538544-compute@developer.gserviceaccount.com). Gets roles/iam.serviceAccountTokenCreator on vm-api only. Empty = option B off."
  type        = string
  default     = ""

  validation {
    condition     = var.impersonator_service_account == "" || can(regex("@.+\\.gserviceaccount\\.com$", var.impersonator_service_account))
    error_message = "impersonator_service_account must be empty or a service account email (…gserviceaccount.com)."
  }
}

# --- Project-level settings ----------------------------------------------------------

variable "manage_apis" {
  description = "Enable cloudkms/iam/iamcredentials/storage APIs from this stack (disable_on_destroy = false, so removing this stack never disables them)"
  type        = bool
  default     = true
}

variable "enable_data_access_audit_logs" {
  description = "Turn on Data Access audit logs (ADMIN_READ, DATA_READ, DATA_WRITE) for cloudkms.googleapis.com and storage.googleapis.com. AUTHORITATIVE per service: replaces any existing audit config (incl. exemptions) for those two services — check first (runbook step 1.8)."
  type        = bool
  default     = true
}

variable "storage_audit_exempted_members" {
  description = "Optional principals exempted from Cloud Storage DATA_READ/DATA_WRITE logs to cut volume (e.g. \"serviceAccount:...\"). Storage audit config is project-wide, not per bucket. KMS has no exemptions on purpose."
  type        = list(string)
  default     = []
}
