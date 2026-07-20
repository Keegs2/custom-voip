# State lives in the existing tofu state bucket under its own prefix,
# isolated from the test env and future region modules.
# (Bucket: gs://revup-tofu-state, versioned — see infra/OPENTOFU_PLAN.md.)
terraform {
  backend "gcs" {
    bucket = "revup-tofu-state"
    prefix = "voip-backups"
  }
}

provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}
