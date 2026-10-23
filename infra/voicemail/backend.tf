# State lives in the existing tofu state bucket under its own prefix,
# isolated from the backups/monitoring stacks and future region modules.
# (Bucket: gs://revup-tofu-state, versioned — see infra/OPENTOFU_PLAN.md.)
terraform {
  backend "gcs" {
    bucket = "revup-tofu-state"
    prefix = "voip-voicemail"
  }
}

provider "google" {
  project = var.project
  region  = var.region
}
