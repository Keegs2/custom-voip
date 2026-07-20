# ============================================================================
# Backup infrastructure — GCS bucket + GCE disk snapshot schedule.
# ============================================================================
# Consumed by scripts/backup/ on the services VM (pg_dump nightly, pgBackRest
# full/diff + WAL archiving, monthly CDR archive). See scripts/backup/README.md
# for the end-to-end activation order.
#
# SAFE BY DESIGN: prevent_destroy on the bucket (it holds the only copies of
# the business's data outside the services VM). Never run `tofu destroy` here.
# ============================================================================

# --- The backup bucket -------------------------------------------------------
resource "google_storage_bucket" "db_backups" {
  name          = var.bucket_name
  location      = upper(var.region)
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Versioning: fat-finger/ransomware insurance — deleted or overwritten
  # objects survive as noncurrent versions for 14 days (rule below).
  versioning {
    enabled = true
  }

  # pgdump/: nightly logical dumps — 35 days is ~5 weekly restore points
  # beyond the pgBackRest window.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age            = 35
      matches_prefix = ["pgdump/"]
    }
  }

  # cdr-archive/: billing evidence — never auto-deleted; goes cold to cut cost.
  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
    condition {
      age            = 90
      matches_prefix = ["cdr-archive/"]
    }
  }

  # Bound the cost of versioning: purge noncurrent versions after 14 days.
  # (pgBackRest expiry + the pgdump lifecycle both generate noncurrent objects.)
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 14
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# --- IAM: the services VM writes backups ------------------------------------
data "google_compute_default_service_account" "default" {}

locals {
  backup_writer = var.backup_writer_service_account != "" ? var.backup_writer_service_account : data.google_compute_default_service_account.default.email
}

# objectAdmin (not just Creator): pgBackRest must DELETE expired backups and
# the preflight probe cleans up after itself.
resource "google_storage_bucket_iam_member" "backup_writer" {
  bucket = google_storage_bucket.db_backups.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${local.backup_writer}"
}

# Read-only access for the restore-drill machine (optional).
resource "google_storage_bucket_iam_member" "drill_reader" {
  count  = var.drill_reader_service_account != "" ? 1 : 0
  bucket = google_storage_bucket.db_backups.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${var.drill_reader_service_account}"
}

# --- Daily disk snapshots (layer 4 — whole-VM last resort) -------------------
# Crash-consistent; PG crash-recovers from them. They also capture what git
# does NOT hold: /opt/revup/.env, PgBouncer/PostgreSQL host config, TLS certs.
resource "google_compute_resource_policy" "daily_snapshot" {
  name   = "revup-services-daily-snapshot"
  region = var.region

  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "08:00" # UTC — after the 05:45 pgBackRest / 07:17 pgdump windows
      }
    }
    retention_policy {
      max_retention_days    = var.snapshot_retention_days
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      storage_locations = [var.region]
      guest_flush       = false
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_disk_resource_policy_attachment" "snapshots" {
  for_each = toset(var.snapshot_disks)

  name = google_compute_resource_policy.daily_snapshot.name
  disk = each.value
  zone = var.zone
}
