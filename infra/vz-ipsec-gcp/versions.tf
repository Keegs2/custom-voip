terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source = "hashicorp/google"
      # ~> 5.0 resolves to the latest 5.x, the same constraint as the other
      # standalone stacks (infra/monitoring, infra/voicemail, infra/backups).
      # Nothing here needs 6.x; staying on 5.x keeps the backend-service
      # defaults (balancing_mode, connection_draining_timeout_sec) the ones
      # the other stacks already plan clean against.
      version = "~> 5.0"
    }
  }
}
