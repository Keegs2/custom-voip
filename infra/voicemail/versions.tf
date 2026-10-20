terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source = "hashicorp/google"
      # >= 5.22 needed for google_storage_bucket.soft_delete_policy; ~> 5.0
      # resolves to the latest 5.x, same constraint as the other stacks.
      version = "~> 5.0"
    }
  }
}
