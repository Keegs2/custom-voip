# State lives in the existing tofu state bucket under its own prefix, isolated
# from the backups/monitoring/voicemail stacks and the future region modules.
# (Bucket: gs://revup-tofu-state, versioned — see infra/OPENTOFU_PLAN.md §20.)
terraform {
  backend "gcs" {
    bucket = "revup-tofu-state"
    prefix = "voip-vz-ipsec"
  }
}

provider "google" {
  project = var.project
  region  = var.region
}
