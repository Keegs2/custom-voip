# State for the test environment lives in the existing tofu state bucket under its
# own prefix, isolated from production state. (Bucket: gs://revup-tofu-state, versioned.)
#
# If you'd rather start with local state, comment this block out and run `tofu init`.
terraform {
  backend "gcs" {
    bucket = "revup-tofu-state"
    prefix = "voip-test"
  }
}

provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}
