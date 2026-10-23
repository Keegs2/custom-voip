# ============================================================================
# Encrypted voicemail — Cloud KMS + GCS bucket + least-privilege identity.
# ============================================================================
# Contract: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §2/§8 and
# docs/ENCRYPTED_VOICEMAIL_BUILD_PLAN.md §4. Operator steps, including the
# services VM service-account swap: docs/runbooks/VOICEMAIL_GCP_SETUP.md.
#
# What the API does at runtime. The IAM below grants exactly this:
#   - creates one SOFTWARE key per customer, vm-cust-<customer_id>, in key ring
#     voicemail-prod (ENCRYPT_DECRYPT, rotation 365 d, destroy_scheduled 24 h);
#     reads it; wraps/unwraps per-message DEKs with it (with AAD); lists its
#     versions and destroys them (crypto-erase);
#   - reads/writes/deletes ciphertext objects in gs://voip-voicemail.
# The per-customer keys are created by the API, NOT by this stack.
#
# PERMANENT RESOURCES: Cloud KMS key rings and crypto keys can NEVER be
# deleted in GCP (their names stay reserved forever). A `tofu destroy` of a
# crypto key only removes it from state after scheduling ALL its versions for
# destruction. For the bucket key that makes every stored voicemail
# unreadable. prevent_destroy is set on every stateful resource here. Never
# run `tofu destroy` in this directory.
# ============================================================================

locals {
  vm_api_member = "serviceAccount:${google_service_account.vm_api.email}"

  labels = {
    app        = "revup-voip"
    component  = "voicemail"
    managed-by = "opentofu"
  }

  apis = var.manage_apis ? toset([
    "cloudkms.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com", # option B: impersonated credentials mint tokens here
    "storage.googleapis.com",
  ]) : toset([])

  services_vm_project_roles = var.vm_api_is_services_vm_identity ? toset(var.services_vm_project_roles) : toset([])
}

# --- APIs --------------------------------------------------------------------
# Enabling an already-enabled API is a no-op. disable_on_destroy = false: removing
# this stack must never switch off Storage/IAM for the rest of the project.
resource "google_project_service" "apis" {
  for_each = local.apis

  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# --- Key rings ---------------------------------------------------------------
# Two rings on purpose:
#   voicemail-prod   holds ONLY the per-customer KEKs. vm-api has key lifecycle
#                    and encrypt/decrypt here (bindings below).
#   voicemail-bucket holds ONLY the bucket CMEK key. vm-api has NO role here, so
#                    an API bug or a compromised API host cannot destroy or use
#                    the key that protects every object in the bucket. Only the
#                    GCS service agent can use it.
# Key rings cannot be deleted in GCP; prevent_destroy documents that.
resource "google_kms_key_ring" "voicemail" {
  name     = var.keyring_name
  location = var.region

  depends_on = [google_project_service.apis]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_key_ring" "bucket" {
  name     = var.bucket_keyring_name
  location = var.region

  depends_on = [google_project_service.apis]

  lifecycle {
    prevent_destroy = true
  }
}

# --- Bucket CMEK key ---------------------------------------------------------
# Layer 1 of 2: GCS encrypts every object with this key at rest. Layer 2 is the
# API's per-message AES-256-GCM DEK wrapped by the per-customer KEK. Crypto-erase
# of a customer destroys their KEK only; this key is never destroyed.
resource "google_kms_crypto_key" "bucket" {
  name            = var.bucket_key_name
  key_ring        = google_kms_key_ring.bucket.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = var.bucket_key_rotation_period

  # 30 days (the GCP default, set explicitly): the longest undo window if a
  # version is ever scheduled for destruction by mistake. ForceNew. Do not change.
  destroy_scheduled_duration = "2592000s"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  labels = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

# The GCS service agent (service-<project number>@gs-project-accounts...) does
# the CMEK encrypt/decrypt for the bucket. It must hold the role BEFORE the
# bucket is created with a default KMS key (depends_on on the bucket).
# Reading this data source also creates the service agent if it does not exist yet.
data "google_storage_project_service_account" "gcs" {
  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key_iam_member" "gcs_agent_bucket_key" {
  crypto_key_id = google_kms_crypto_key.bucket.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

# --- The voicemail bucket ----------------------------------------------------
resource "google_storage_bucket" "voicemail" {
  name          = var.bucket_name
  location      = upper(var.region)
  storage_class = "STANDARD"
  force_destroy = false

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Versioning OFF: a purge or crypto-erase must not leave noncurrent copies.
  # Soft delete (below) is the bounded undo window instead.
  versioning {
    enabled = false
  }

  # Deleted objects stay restorable for N days (ciphertext only; a destroyed
  # customer KEK makes them unreadable regardless).
  soft_delete_policy {
    retention_duration_seconds = var.soft_delete_retention_days * 86400
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.bucket.id
  }

  # No lifecycle Delete rule on purpose: retention is per mailbox (1-3650 days,
  # default 90) and is enforced by the API's retention worker, which also
  # updates the DB rows. A bucket-wide age rule would delete objects the DB
  # still references.

  labels = local.labels

  depends_on = [google_kms_crypto_key_iam_member.gcs_agent_bucket_key]

  lifecycle {
    prevent_destroy = true
  }
}

# --- vm-api: the dedicated voicemail identity --------------------------------
resource "google_service_account" "vm_api" {
  account_id   = var.service_account_id
  display_name = "Voicemail API (services VM)"
  description  = "Encrypted voicemail: per-customer KMS keys in ${var.keyring_name} + objects in gs://${var.bucket_name}. Do not reuse."

  depends_on = [google_project_service.apis]

  lifecycle {
    prevent_destroy = true
  }
}

# Least-privilege key lifecycle. No setIamPolicy, no restore, no
# cryptoKeyVersions.create/update (no manual rotation, enable or disable),
# no key ring create.
resource "google_project_iam_custom_role" "vm_key_lifecycle" {
  role_id     = var.key_lifecycle_role_id
  title       = "Voicemail per-customer key lifecycle"
  description = "vm-api on the ${var.keyring_name} key ring: create/read per-customer KEKs, list and destroy their versions (crypto-erase)."
  stage       = "GA"

  permissions = [
    "cloudkms.cryptoKeys.create",         # first mailbox of a customer: CreateCryptoKey vm-cust-<id> (checked on the key ring)
    "cloudkms.cryptoKeys.get",            # GetCryptoKey: primary version / state after AlreadyExists
    "cloudkms.cryptoKeys.list",           # reconciliation of keys vs voicemail_customer_keys
    "cloudkms.cryptoKeys.update",         # UpdateCryptoKey, e.g. clear rotation on erase so no fresh version appears later
    "cloudkms.cryptoKeyVersions.get",     # verify DESTROY_SCHEDULED after erase
    "cloudkms.cryptoKeyVersions.list",    # crypto-erase: enumerate every ENABLED/DISABLED version
    "cloudkms.cryptoKeyVersions.destroy", # crypto-erase: DestroyCryptoKeyVersion
  ]
}

resource "google_kms_key_ring_iam_member" "vm_api_key_lifecycle" {
  key_ring_id = google_kms_key_ring.voicemail.id
  role        = google_project_iam_custom_role.vm_key_lifecycle.name
  member      = local.vm_api_member
}

# useToEncrypt / useToDecrypt: wrap and unwrap DEKs (AAD) with any key in the ring.
resource "google_kms_key_ring_iam_member" "vm_api_encrypt_decrypt" {
  key_ring_id = google_kms_key_ring.voicemail.id
  role        = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member      = local.vm_api_member
}

# Objects only, on this bucket only. No bucket get/update/IAM (the API must use
# client.bucket(name), not get_bucket(), which needs storage.buckets.get).
resource "google_storage_bucket_iam_member" "vm_api_objects" {
  bucket = google_storage_bucket.voicemail.name
  role   = "roles/storage.objectAdmin"
  member = local.vm_api_member
}

# NOTE: nothing here is granted to the default compute service account. Every
# VM in the project runs as that SA (SBCs, FS nodes, DB replicas, which hold
# the wrapped DEKs). Granting it KMS or bucket roles would let any of them
# decrypt voicemail.

# --- Option A carry-over: vm-api becomes the services VM identity ------------
# Attaching vm-api to the services VM (runbook option A) REPLACES the default
# compute SA for everything on that VM, not only the API container. These
# grants keep the VM's other keyless (metadata-server) workloads working:
#   - backup bucket objectAdmin: pgBackRest archive_command (WAL) and full/diff
#     backups, pg_dump nightly, the CDR archive (scripts/backup/). Without it
#     WAL archiving fails and pg_wal grows on the PG primary until the disk fills.
#   - logging.logWriter + monitoring.metricWriter: Ops Agent (syslog including
#     the revup-alert paging lines, disk/memory metrics, heplify scrape).
#   - monitoring.viewer: Grafana "GCP Monitoring" datasource (GCE auth).
# Before the swap, compare with what the default SA really holds (runbook 1.4/1.5).
resource "google_project_iam_member" "vm_api_services_vm" {
  for_each = local.services_vm_project_roles

  project = var.project
  role    = each.value
  member  = local.vm_api_member
}

# Additive (iam_member). infra/backups keeps its own binding for the default SA
# on the same bucket. Do not also point infra/backups' backup_writer_service_account
# at vm-api, or two stacks would own the same binding.
resource "google_storage_bucket_iam_member" "vm_api_backup_writer" {
  count = var.vm_api_is_services_vm_identity && var.backup_bucket_name != "" ? 1 : 0

  bucket = var.backup_bucket_name
  role   = "roles/storage.objectAdmin"
  member = local.vm_api_member
}

# --- Option B: impersonation from the VM's current SA (no restart) ----------
# Weaker: EVERY VM running as the impersonator SA can mint vm-api tokens.
# Meant as a temporary bridge until an option A window. Remove it afterwards
# by setting impersonator_service_account = "".
resource "google_service_account_iam_member" "vm_api_impersonator" {
  count = var.impersonator_service_account != "" ? 1 : 0

  service_account_id = google_service_account.vm_api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.impersonator_service_account}"
}

# --- Data Access audit logs (off by default in GCP) -------------------------
# google_project_iam_audit_config is AUTHORITATIVE for its service: it replaces
# any existing auditConfigs entry (incl. exemptions) for that service. An
# "allServices" entry, if any, is left alone. Logs land in the _Default log
# bucket (30-day retention).
#   KMS: every CreateCryptoKey/Get/List/Encrypt/Decrypt/Destroy by vm-api and by
#        the GCS service agent. Deliberately no exemptions.
#   GCS: project-wide (GCS has no per-bucket audit config), so it also logs the
#        backup traffic (pgBackRest WAL pushes etc.). Volume is small; exempt
#        noisy principals via storage_audit_exempted_members if needed.
resource "google_project_iam_audit_config" "kms" {
  count = var.enable_data_access_audit_logs ? 1 : 0

  project = var.project
  service = "cloudkms.googleapis.com"

  audit_log_config {
    log_type = "ADMIN_READ"
  }
  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

resource "google_project_iam_audit_config" "storage" {
  count = var.enable_data_access_audit_logs ? 1 : 0

  project = var.project
  service = "storage.googleapis.com"

  audit_log_config {
    log_type = "ADMIN_READ"
  }
  audit_log_config {
    log_type         = "DATA_READ"
    exempted_members = var.storage_audit_exempted_members
  }
  audit_log_config {
    log_type         = "DATA_WRITE"
    exempted_members = var.storage_audit_exempted_members
  }
}
