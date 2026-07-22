# State lives in the existing tofu state bucket under its own prefix.
# (Bucket: gs://revup-tofu-state, versioned — see infra/OPENTOFU_PLAN.md.)
terraform {
  backend "gcs" {
    bucket = "revup-tofu-state"
    prefix = "voip-monitoring"
  }
}

provider "google" {
  project = var.project
  region  = var.region
}
