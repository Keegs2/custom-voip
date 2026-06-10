# OpenTofu + Ansible Infrastructure Plan

## Overview

This plan covers the complete IaC setup for the RCF-V1 VoIP platform:
- **OpenTofu** manages GCP resources (VMs, networking, load balancers, static IPs, firewall rules)
- **Ansible** manages VM configuration (Docker install, .env files, service deployment, PostgreSQL)
- **State** lives in a GCS bucket with locking
- **Existing East region** gets imported, not recreated

GCP Project: `rugged-night-193017`

---

## 1. Directory Structure

```
/Users/keegan/revup/
  infra/                          # All OpenTofu code
    main.tf                       # Root module — calls voip-region + firewall + global-lb
    variables.tf                  # Root variable declarations
    outputs.tf                    # Root outputs (IPs, VIPs, JSON for Ansible)
    providers.tf                  # Google provider + GCS backend config
    versions.tf                   # OpenTofu and provider version constraints
    production.tfvars             # Actual values for production (regions map, machine types)
    import-east.tf                # Import blocks for existing East resources (temporary)
    
    modules/
      voip-region/                # Per-region module (called 3x via for_each)
        main.tf                   # VM instances, static IPs, instance group
        variables.tf              # Module input variables
        outputs.tf                # Module outputs (IPs, instance group self_link)
        sbc.tf                    # SBC VM resources (2 per region)
        freeswitch.tf             # FreeSWITCH + Redis VM
        services.tf               # Services VM (only in East) — conditional
        db-replica.tf             # PG replica VM (West + Central only) — conditional
        instance-group.tf         # Unmanaged instance group for SBC pair
        
      firewall/                   # VPC-wide firewall rules (called once)
        main.tf                   # All firewall rule resources
        variables.tf              # Input: project, network, office CIDRs
        outputs.tf                # Rule names for reference
        
      global-lb/                  # Global External Passthrough NLB (called once)
        main.tf                   # Health check, backend service, forwarding rules
        variables.tf              # Input: instance groups from all regions
        outputs.tf                # Global VIP address
        
  ansible/                        # Ansible playbooks and inventory
    inventory/
      production.yml              # Dynamic inventory from tofu output (or static)
    group_vars/
      all.yml                     # Common variables
      sbc.yml                     # SBC-specific vars
      media.yml                   # FreeSWITCH-specific vars
      services.yml                # Services VM vars
    playbooks/
      site.yml                    # Master playbook — runs all roles
      deploy.yml                  # Application deploy only (git pull + rebuild)
      sbc.yml                     # SBC-only deploy
      media.yml                   # Media server deploy
      services.yml                # Services VM deploy
    roles/
      common/                     # Docker install, kernel tuning, SSH hardening
      sbc/                        # Kamailio .env, docker-compose.sbc.yml deploy
      media/                      # FreeSWITCH .env, docker-compose.media.yml deploy
      services/                   # API/UI/Homer .env, docker-compose.services.yml deploy
      postgres-primary/           # PG primary setup (East only)
      postgres-replica/           # PG streaming replica setup (West, Central)
    templates/
      env.sbc.j2                  # Jinja2 template for SBC .env
      env.media.j2                # Jinja2 template for media .env
      env.services.j2             # Jinja2 template for services .env
```

### File Purposes

| File | Purpose |
|------|---------|
| `infra/main.tf` | Root orchestrator. Calls `voip-region` with `for_each` over the regions map, `firewall` once, `global-lb` once. Wires outputs between modules. |
| `infra/variables.tf` | Declares `project_id`, `regions` map, `office_cidrs`, `bandwidth_cidrs`, common labels. |
| `infra/outputs.tf` | Exports per-region IPs, NLB VIP, structured JSON for Ansible inventory generation. |
| `infra/providers.tf` | Configures `google` provider with project ID and credentials. Configures GCS backend. |
| `infra/versions.tf` | Pins OpenTofu `>= 1.6`, `google` provider `~> 5.0`. |
| `infra/production.tfvars` | The regions map with real values, machine types, IP bases. Checked into git (no secrets). |
| `infra/import-east.tf` | Temporary file with `import {}` blocks for all existing East resources. Deleted after import is clean. |

---

## 2. Provider and Backend Configuration

### `infra/versions.tf`

```hcl
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}
```

### `infra/providers.tf`

```hcl
terraform {
  backend "gcs" {
    bucket = "revup-tofu-state"
    prefix = "production"
  }
}

provider "google" {
  project = var.project_id
  # Region is NOT set here — each resource specifies its own region/zone.
  # Credentials: use GOOGLE_APPLICATION_CREDENTIALS env var or gcloud auth.
}
```

### Bootstrap: Creating the State Bucket

The state bucket cannot be managed by OpenTofu (chicken-and-egg). Create it once manually:

```bash
# One-time setup — run from any machine with gcloud auth
gcloud storage buckets create gs://revup-tofu-state \
  --project=rugged-night-193017 \
  --location=us \
  --uniform-bucket-level-access \
  --public-access-prevention

# Enable versioning (state file backup)
gcloud storage buckets update gs://revup-tofu-state --versioning

# Verify
gcloud storage buckets describe gs://revup-tofu-state
```

**State locking**: The GCS backend provides native locking via a `.tflock` object. No DynamoDB or separate lock table needed (that is AWS-specific). When one `tofu apply` is running, another will block until the lock is released.

**State encryption**: GCS encrypts at rest by default (Google-managed keys). For customer-managed encryption, add a CMEK key from Cloud KMS — not required for Phase 1.

---

## 3. Variable Strategy

### `infra/variables.tf` (Root)

```hcl
variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "regions" {
  description = "Map of region configs. Key is the region short name (east, west, central)."
  type = map(object({
    gcp_region             = string        # e.g., "us-east1"
    gcp_zone               = string        # e.g., "us-east1-b"
    sbc_count              = number        # 2
    sbc_machine_type       = string        # "e2-standard-4"
    fs_machine_type        = string        # "e2-standard-8"
    services_machine_type  = string        # "e2-standard-4" (only if has_services)
    db_machine_type        = string        # "e2-standard-4" (only if has_db_replica)
    has_services           = bool          # true only for East
    has_db_replica         = bool          # true for West, Central (East has primary)
    internal_ip_base       = string        # "10.142.0" for East
    bandwidth_primary_ip   = string        # nearest Bandwidth PoP
    bandwidth_secondary_ip = string        # far Bandwidth PoP
    sbc_ids                = list(string)  # ["east-sbc-1", "east-sbc-2"]
    hep_capture_ids        = list(number)  # [100, 101]
    boot_disk_size_gb      = number        # 50
    fs_disk_size_gb        = number        # 100
  }))
}

variable "office_cidrs" {
  description = "Office IP CIDRs for admin access"
  type        = list(string)
}

variable "bandwidth_cidrs" {
  description = "Bandwidth carrier IP ranges"
  type        = list(string)
  default     = ["67.231.0.0/16", "216.82.224.0/19"]
}

variable "gcp_health_check_cidrs" {
  description = "GCP health check source ranges"
  type        = list(string)
  default     = ["35.191.0.0/16", "130.211.0.0/22"]
}

variable "iap_cidrs" {
  description = "GCP IAP source range for SSH"
  type        = list(string)
  default     = ["35.235.240.0/20"]
}

variable "common_labels" {
  description = "Labels applied to all resources"
  type        = map(string)
  default = {
    project     = "revup"
    environment = "production"
    managed_by  = "opentofu"
  }
}
```

### `infra/production.tfvars`

```hcl
project_id = "rugged-night-193017"

office_cidrs = ["YOUR.OFFICE.IP/32"]  # Replace with actual office IP

regions = {
  east = {
    gcp_region             = "us-east1"
    gcp_zone               = "us-east1-b"
    sbc_count              = 2
    sbc_machine_type       = "e2-standard-4"
    fs_machine_type        = "e2-standard-8"
    services_machine_type  = "e2-standard-4"
    db_machine_type        = "e2-standard-4"
    has_services           = true
    has_db_replica         = false   # East has primary, not replica
    internal_ip_base       = "10.142.0"
    bandwidth_primary_ip   = "67.231.2.12"
    bandwidth_secondary_ip = "216.82.238.134"
    sbc_ids                = ["east-sbc-1", "east-sbc-2"]
    hep_capture_ids        = [100, 101]
    boot_disk_size_gb      = 50
    fs_disk_size_gb        = 100
  }

  west = {
    gcp_region             = "us-west1"
    gcp_zone               = "us-west1-b"
    sbc_count              = 2
    sbc_machine_type       = "e2-standard-4"
    fs_machine_type        = "e2-standard-8"
    services_machine_type  = "e2-standard-4"
    db_machine_type        = "e2-standard-4"
    has_services           = false
    has_db_replica         = true
    internal_ip_base       = "10.138.0"
    bandwidth_primary_ip   = "216.82.238.134"
    bandwidth_secondary_ip = "67.231.2.12"
    sbc_ids                = ["west-sbc-1", "west-sbc-2"]
    hep_capture_ids        = [110, 111]
    boot_disk_size_gb      = 50
    fs_disk_size_gb        = 100
  }

  central = {
    gcp_region             = "us-central1"
    gcp_zone               = "us-central1-b"
    sbc_count              = 2
    sbc_machine_type       = "e2-standard-4"
    fs_machine_type        = "e2-standard-8"
    services_machine_type  = "e2-standard-4"
    db_machine_type        = "e2-standard-4"
    has_services           = false
    has_db_replica         = true
    internal_ip_base       = "10.128.0"
    bandwidth_primary_ip   = "67.231.2.12"
    bandwidth_secondary_ip = "216.82.238.134"
    sbc_ids                = ["central-sbc-1", "central-sbc-2"]
    hep_capture_ids        = [120, 121]
    boot_disk_size_gb      = 50
    fs_disk_size_gb        = 100
  }
}
```

### Sensitive Variables

Secrets (DB passwords, ESL password, JWT key) are NOT in OpenTofu. They live in:
1. **Ansible vault** (encrypted at rest, decrypted at deploy time)
2. **GCP Secret Manager** (Phase 2 — VMs pull secrets at boot)
3. **The .env files** on each VM (not in git, deployed by Ansible)

OpenTofu only creates the infrastructure skeleton. Ansible populates the secrets.

---

## 4. Root Configuration (`main.tf`)

```hcl
# =============================================================================
# Root Module — Orchestrates all VoIP infrastructure
# =============================================================================

# Per-region VoIP infrastructure (SBCs, FreeSWITCH, IPs, instance groups)
module "region" {
  source   = "./modules/voip-region"
  for_each = var.regions

  project_id  = var.project_id
  region_name = each.key
  config      = each.value
  labels      = var.common_labels
}

# VPC-wide firewall rules (one set covers all regions)
module "firewall" {
  source = "./modules/firewall"

  project_id              = var.project_id
  network                 = "default"
  bandwidth_cidrs         = var.bandwidth_cidrs
  gcp_health_check_cidrs  = var.gcp_health_check_cidrs
  iap_cidrs               = var.iap_cidrs
  office_cidrs            = var.office_cidrs
  zone_subnet_cidrs       = [for r in var.regions : "${r.internal_ip_base}.0/20"]
}

# Global External Passthrough NLB (Phase 2 — uncomment when West deploys)
# module "global_lb" {
#   source = "./modules/global-lb"
#
#   project_id      = var.project_id
#   instance_groups = { for k, v in module.region : k => v.sbc_instance_group }
#   health_check_id = module.firewall.sbc_health_check_id  # Or create in LB module
# }
```

**Why `global_lb` is commented out**: The East region currently uses a regional NLB (34.24.133.82). The global LB replaces it in Phase 2 when West deploys. Uncommenting and applying creates the global LB. The regional LB import block handles the existing one.

### `infra/outputs.tf`

```hcl
# Per-region outputs
output "region_sbc_external_ips" {
  description = "SBC external IPs per region"
  value       = { for k, v in module.region : k => v.sbc_external_ips }
}

output "region_sbc_internal_ips" {
  description = "SBC internal IPs per region"
  value       = { for k, v in module.region : k => v.sbc_internal_ips }
}

output "region_fs_external_ip" {
  description = "FreeSWITCH external IP per region"
  value       = { for k, v in module.region : k => v.fs_external_ip }
}

output "region_fs_internal_ip" {
  description = "FreeSWITCH internal IP per region"
  value       = { for k, v in module.region : k => v.fs_internal_ip }
}

output "region_services_external_ip" {
  description = "Services VM external IP (East only)"
  value       = { for k, v in module.region : k => v.services_external_ip if v.services_external_ip != null }
}

output "region_instance_groups" {
  description = "SBC instance group self_links per region"
  value       = { for k, v in module.region : k => v.sbc_instance_group }
}

# Structured JSON for Ansible consumption
output "ansible_inventory" {
  description = "Complete inventory data for Ansible dynamic inventory script"
  value = {
    for region_name, region_mod in module.region : region_name => {
      sbcs = [
        for i in range(var.regions[region_name].sbc_count) : {
          name        = var.regions[region_name].sbc_ids[i]
          external_ip = region_mod.sbc_external_ips[i]
          internal_ip = region_mod.sbc_internal_ips[i]
          hep_id      = var.regions[region_name].hep_capture_ids[i]
        }
      ]
      freeswitch = {
        external_ip = region_mod.fs_external_ip
        internal_ip = region_mod.fs_internal_ip
      }
      services = region_mod.services_external_ip
      bandwidth_primary_ip   = var.regions[region_name].bandwidth_primary_ip
      bandwidth_secondary_ip = var.regions[region_name].bandwidth_secondary_ip
    }
  }
}
```

---

## 5. Module: `voip-region`

### `modules/voip-region/variables.tf`

```hcl
variable "project_id" {
  type = string
}

variable "region_name" {
  description = "Short name: east, west, central"
  type        = string
}

variable "config" {
  description = "Region configuration object from root regions map"
  type = object({
    gcp_region             = string
    gcp_zone               = string
    sbc_count              = number
    sbc_machine_type       = string
    fs_machine_type        = string
    services_machine_type  = string
    db_machine_type        = string
    has_services           = bool
    has_db_replica         = bool
    internal_ip_base       = string
    bandwidth_primary_ip   = string
    bandwidth_secondary_ip = string
    sbc_ids                = list(string)
    hep_capture_ids        = list(number)
    boot_disk_size_gb      = number
    fs_disk_size_gb        = number
  })
}

variable "labels" {
  type = map(string)
}
```

### `modules/voip-region/sbc.tf`

```hcl
# Static external IPs for SBCs
resource "google_compute_address" "sbc_external" {
  count        = var.config.sbc_count
  name         = "${var.region_name}-sbc-${count.index + 1}-ip"
  project      = var.project_id
  region       = var.config.gcp_region
  address_type = "EXTERNAL"
}

# Static internal IPs for SBCs
resource "google_compute_address" "sbc_internal" {
  count        = var.config.sbc_count
  name         = "${var.region_name}-sbc-${count.index + 1}-internal"
  project      = var.project_id
  region       = var.config.gcp_region
  address_type = "INTERNAL"
  subnetwork   = "projects/${var.project_id}/regions/${var.config.gcp_region}/subnetworks/default"
  address      = "${var.config.internal_ip_base}.${100 + count.index}"
}

# SBC VM instances
resource "google_compute_instance" "sbc" {
  count        = var.config.sbc_count
  name         = "${var.region_name}-sbc-${count.index + 1}"
  project      = var.project_id
  zone         = var.config.gcp_zone
  machine_type = var.config.sbc_machine_type

  tags = ["voip-sbc"]

  labels = merge(var.labels, {
    role   = "sbc"
    region = var.region_name
    sbc_id = var.config.sbc_ids[count.index]
  })

  boot_disk {
    initialize_params {
      image = "projects/cos-cloud/global/images/family/cos-stable"
      size  = var.config.boot_disk_size_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = "projects/${var.project_id}/regions/${var.config.gcp_region}/subnetworks/default"
    network_ip = google_compute_address.sbc_internal[count.index].address
    access_config {
      nat_ip = google_compute_address.sbc_external[count.index].address
    }
  }

  metadata = {
    ssh-keys = ""  # Use IAP tunneling, not public SSH keys
  }

  service_account {
    scopes = ["cloud-platform"]
  }

  scheduling {
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
  }

  lifecycle {
    prevent_destroy = true
  }
}
```

**Note on boot image**: The actual VMs use Ubuntu or Debian with Docker installed. The image above (`cos-stable`) is Container-Optimized OS. Replace with the actual image family used for existing VMs. To find it:

```bash
gcloud compute instances describe poc-custom-voip --zone=us-east1-b \
  --format='get(disks[0].source)'
```

### `modules/voip-region/freeswitch.tf`

```hcl
resource "google_compute_address" "fs_external" {
  name         = "${var.region_name}-fs-ip"
  project      = var.project_id
  region       = var.config.gcp_region
  address_type = "EXTERNAL"
}

resource "google_compute_address" "fs_internal" {
  name         = "${var.region_name}-fs-internal"
  project      = var.project_id
  region       = var.config.gcp_region
  address_type = "INTERNAL"
  subnetwork   = "projects/${var.project_id}/regions/${var.config.gcp_region}/subnetworks/default"
  address      = "${var.config.internal_ip_base}.102"
}

resource "google_compute_instance" "freeswitch" {
  name         = "${var.region_name}-fs"
  project      = var.project_id
  zone         = var.config.gcp_zone
  machine_type = var.config.fs_machine_type

  tags = ["voip-media"]

  labels = merge(var.labels, {
    role   = "freeswitch"
    region = var.region_name
  })

  boot_disk {
    initialize_params {
      image = "projects/cos-cloud/global/images/family/cos-stable"
      size  = var.config.fs_disk_size_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = "projects/${var.project_id}/regions/${var.config.gcp_region}/subnetworks/default"
    network_ip = google_compute_address.fs_internal.address
    access_config {
      nat_ip = google_compute_address.fs_external.address
    }
  }

  service_account {
    scopes = ["cloud-platform"]
  }

  scheduling {
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
  }

  lifecycle {
    prevent_destroy = true
  }
}
```

### `modules/voip-region/services.tf`

```hcl
# Services VM — only created in the region with has_services = true (East)
resource "google_compute_address" "services_external" {
  count        = var.config.has_services ? 1 : 0
  name         = "${var.region_name}-services-ip"
  project      = var.project_id
  region       = var.config.gcp_region
  address_type = "EXTERNAL"
}

resource "google_compute_address" "services_internal" {
  count        = var.config.has_services ? 1 : 0
  name         = "${var.region_name}-services-internal"
  project      = var.project_id
  region       = var.config.gcp_region
  address_type = "INTERNAL"
  subnetwork   = "projects/${var.project_id}/regions/${var.config.gcp_region}/subnetworks/default"
  address      = "${var.config.internal_ip_base}.103"
}

resource "google_compute_instance" "services" {
  count        = var.config.has_services ? 1 : 0
  name         = "${var.region_name}-services"
  project      = var.project_id
  zone         = var.config.gcp_zone
  machine_type = var.config.services_machine_type

  tags = ["voip-services"]

  labels = merge(var.labels, {
    role   = "services"
    region = var.region_name
  })

  boot_disk {
    initialize_params {
      image = "projects/cos-cloud/global/images/family/cos-stable"
      size  = var.config.boot_disk_size_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = "projects/${var.project_id}/regions/${var.config.gcp_region}/subnetworks/default"
    network_ip = google_compute_address.services_internal[0].address
    access_config {
      nat_ip = google_compute_address.services_external[0].address
    }
  }

  service_account {
    scopes = ["cloud-platform"]
  }

  lifecycle {
    prevent_destroy = true
  }
}
```

### `modules/voip-region/db-replica.tf`

```hcl
# PG replica VM — only created in regions with has_db_replica = true (West, Central)
resource "google_compute_address" "db_internal" {
  count        = var.config.has_db_replica ? 1 : 0
  name         = "${var.region_name}-db-internal"
  project      = var.project_id
  region       = var.config.gcp_region
  address_type = "INTERNAL"
  subnetwork   = "projects/${var.project_id}/regions/${var.config.gcp_region}/subnetworks/default"
  address      = "${var.config.internal_ip_base}.103"
}

resource "google_compute_instance" "db_replica" {
  count        = var.config.has_db_replica ? 1 : 0
  name         = "${var.region_name}-db"
  project      = var.project_id
  zone         = var.config.gcp_zone
  machine_type = var.config.db_machine_type

  tags = ["voip-db"]

  labels = merge(var.labels, {
    role   = "db-replica"
    region = var.region_name
  })

  boot_disk {
    initialize_params {
      image = "projects/cos-cloud/global/images/family/cos-stable"
      size  = var.config.fs_disk_size_gb  # Same size as FS for DB storage
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = "projects/${var.project_id}/regions/${var.config.gcp_region}/subnetworks/default"
    network_ip = google_compute_address.db_internal[0].address
    access_config {}  # Ephemeral external IP for updates/SSH
  }

  service_account {
    scopes = ["cloud-platform"]
  }

  lifecycle {
    prevent_destroy = true
  }
}
```

### `modules/voip-region/instance-group.tf`

```hcl
# Unmanaged instance group containing the SBC pair for this region
resource "google_compute_instance_group" "sbc_group" {
  name    = "sbc-group-${var.region_name}"
  project = var.project_id
  zone    = var.config.gcp_zone

  instances = [for sbc in google_compute_instance.sbc : sbc.self_link]

  named_port {
    name = "sip-udp"
    port = 5060
  }

  named_port {
    name = "sip-tcp"
    port = 5060
  }
}
```

### `modules/voip-region/outputs.tf`

```hcl
output "sbc_external_ips" {
  value = [for addr in google_compute_address.sbc_external : addr.address]
}

output "sbc_internal_ips" {
  value = [for addr in google_compute_address.sbc_internal : addr.address]
}

output "fs_external_ip" {
  value = google_compute_address.fs_external.address
}

output "fs_internal_ip" {
  value = google_compute_address.fs_internal.address
}

output "services_external_ip" {
  value = var.config.has_services ? google_compute_address.services_external[0].address : null
}

output "services_internal_ip" {
  value = var.config.has_services ? google_compute_address.services_internal[0].address : null
}

output "sbc_instance_group" {
  value = google_compute_instance_group.sbc_group.self_link
}
```

---

## 6. Module: `firewall`

### `modules/firewall/main.tf`

```hcl
# Bandwidth carrier SIP inbound
resource "google_compute_firewall" "voip_sip_inbound" {
  name    = "voip-sip-inbound"
  project = var.project_id
  network = var.network

  allow {
    protocol = "udp"
    ports    = ["5060"]
  }
  allow {
    protocol = "tcp"
    ports    = ["5060"]
  }

  source_ranges = var.bandwidth_cidrs
  target_tags   = ["voip-sbc"]
}

# GCP health check probes
resource "google_compute_firewall" "voip_health_check" {
  name    = "voip-health-check"
  project = var.project_id
  network = var.network

  allow {
    protocol = "tcp"
    ports    = ["5060"]
  }

  source_ranges = var.gcp_health_check_cidrs
  target_tags   = ["voip-sbc"]
}

# RTP media (FreeSWITCH)
resource "google_compute_firewall" "voip_rtp" {
  name    = "voip-rtp"
  project = var.project_id
  network = var.network

  allow {
    protocol = "udp"
    ports    = ["16384-49151"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["voip-media"]
}

# Admin web access (API, UI, Homer)
resource "google_compute_firewall" "voip_web_admin" {
  name    = "voip-web-admin"
  project = var.project_id
  network = var.network

  allow {
    protocol = "tcp"
    ports    = ["8080", "8443", "8088", "9080"]
  }

  source_ranges = var.office_cidrs
  target_tags   = ["voip-services"]
}

# Internal VPC traffic between zones
resource "google_compute_firewall" "voip_internal" {
  name    = "voip-internal"
  project = var.project_id
  network = var.network

  allow {
    protocol = "tcp"
  }
  allow {
    protocol = "udp"
  }
  allow {
    protocol = "icmp"
  }

  source_ranges = var.zone_subnet_cidrs
  target_tags   = ["voip-sbc", "voip-media", "voip-services", "voip-db"]
}

# PG replication
resource "google_compute_firewall" "voip_pg_replication" {
  name    = "voip-pg-replication"
  project = var.project_id
  network = var.network

  allow {
    protocol = "tcp"
    ports    = ["5432"]
  }

  source_ranges = var.zone_subnet_cidrs
  target_tags   = ["voip-db"]
}

# SSH via IAP tunneling
resource "google_compute_firewall" "allow_ssh_iap" {
  name    = "allow-ssh-iap"
  project = var.project_id
  network = var.network

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.iap_cidrs
  target_tags   = ["voip-sbc", "voip-media", "voip-services", "voip-db"]
}
```

---

## 7. Import Strategy -- Step by Step

### 7.1 Resources to Import

The existing East region has these GCP resources that must be imported into state:

| Resource Type | GCP Name | OpenTofu Address |
|---|---|---|
| VM | `poc-custom-voip` | `module.region["east"].google_compute_instance.sbc[0]` |
| VM | `kam-g2` | `module.region["east"].google_compute_instance.sbc[1]` |
| VM | `fs-media` | `module.region["east"].google_compute_instance.freeswitch` |
| VM | `services` | `module.region["east"].google_compute_instance.services[0]` |
| Static IP | (SBC-1 external) | `module.region["east"].google_compute_address.sbc_external[0]` |
| Static IP | (SBC-2 external) | `module.region["east"].google_compute_address.sbc_external[1]` |
| Static IP | (FS external) | `module.region["east"].google_compute_address.fs_external` |
| Static IP | (Services external) | `module.region["east"].google_compute_address.services_external[0]` |
| Instance Group | `sbc-group` | `module.region["east"].google_compute_instance_group.sbc_group` |
| Forwarding Rule | `sbc-vip-udp` | (Regional NLB — may manage separately or let it go when global LB replaces it) |
| Forwarding Rule | `sbc-vip-tcp` | (Regional NLB) |
| Backend Service | `sbc-backend` | (Regional NLB) |
| Health Check | `sbc-health-check` | (Regional NLB) |
| Firewall rules | Multiple `voip-*` rules | `module.firewall.google_compute_firewall.*` |

### 7.2 Finding Resource IDs

Run these commands to get the exact IDs needed for import blocks:

```bash
# VMs — format: projects/{project}/zones/{zone}/instances/{name}
gcloud compute instances list --project=rugged-night-193017 \
  --format='table(name,zone,machineType,networkInterfaces[0].networkIP,networkInterfaces[0].accessConfigs[0].natIP)'

# Static IPs — need to check if they are reserved or ephemeral
gcloud compute addresses list --project=rugged-night-193017 \
  --format='table(name,region,address,addressType,status)'

# Instance groups
gcloud compute instance-groups list --project=rugged-night-193017 \
  --format='table(name,zone,size)'

# Forwarding rules (NLB)
gcloud compute forwarding-rules list --project=rugged-night-193017 \
  --format='table(name,region,IPAddress,IPProtocol,portRange)'

# Backend services
gcloud compute backend-services list --project=rugged-night-193017 \
  --format='table(name,backends,protocol)'

# Health checks
gcloud compute health-checks list --project=rugged-night-193017 \
  --format='table(name,type,checkIntervalSec)'

# Firewall rules
gcloud compute firewall-rules list --project=rugged-night-193017 \
  --format='table(name,direction,sourceRanges,targetTags,allowed)'
```

### 7.3 Import Block Syntax

Create `infra/import-east.tf` with blocks like these. The `id` format is GCP-specific per resource type.

```hcl
# =============================================================================
# TEMPORARY: Import blocks for existing East region resources
# Delete this file after import is clean and state is verified.
# =============================================================================

# --- VMs ---
import {
  to = module.region["east"].google_compute_instance.sbc[0]
  id = "projects/rugged-night-193017/zones/us-east1-b/instances/poc-custom-voip"
}

import {
  to = module.region["east"].google_compute_instance.sbc[1]
  id = "projects/rugged-night-193017/zones/us-east1-b/instances/kam-g2"
}

import {
  to = module.region["east"].google_compute_instance.freeswitch
  id = "projects/rugged-night-193017/zones/us-east1-b/instances/fs-media"
}

import {
  to = module.region["east"].google_compute_instance.services[0]
  id = "projects/rugged-night-193017/zones/us-east1-b/instances/services"
}

# --- Static IPs (only if they are reserved, not ephemeral) ---
# If the IPs are ephemeral (gcloud addresses list shows nothing), skip these
# and let OpenTofu reserve new static IPs. Then reassign them to the VMs.
#
# import {
#   to = module.region["east"].google_compute_address.sbc_external[0]
#   id = "projects/rugged-night-193017/regions/us-east1/addresses/NAME-FROM-GCLOUD"
# }

# --- Instance Group ---
import {
  to = module.region["east"].google_compute_instance_group.sbc_group
  id = "projects/rugged-night-193017/zones/us-east1-b/instanceGroups/sbc-group"
}

# --- Firewall Rules ---
import {
  to = module.firewall.google_compute_firewall.voip_sip_inbound
  id = "projects/rugged-night-193017/global/firewalls/voip-sip-inbound"
}

import {
  to = module.firewall.google_compute_firewall.voip_health_check
  id = "projects/rugged-night-193017/global/firewalls/voip-health-check"
}

import {
  to = module.firewall.google_compute_firewall.voip_rtp
  id = "projects/rugged-night-193017/global/firewalls/voip-rtp"
}

import {
  to = module.firewall.google_compute_firewall.voip_web_admin
  id = "projects/rugged-night-193017/global/firewalls/voip-web-admin"
}

import {
  to = module.firewall.google_compute_firewall.voip_internal
  id = "projects/rugged-night-193017/global/firewalls/voip-internal"
}

import {
  to = module.firewall.google_compute_firewall.voip_pg_replication
  id = "projects/rugged-night-193017/global/firewalls/voip-pg-replication"
}

import {
  to = module.firewall.google_compute_firewall.allow_ssh_iap
  id = "projects/rugged-night-193017/global/firewalls/allow-ssh-iap"
}
```

### 7.4 The Import Cycle

This is the critical iterative process. It will take multiple passes.

**Step 1: First plan (expect failures)**
```bash
cd /Users/keegan/revup/infra
tofu init
tofu plan -var-file=production.tfvars
```

The first plan will show that OpenTofu wants to CREATE everything (it does not know about existing resources yet).

**Step 2: Add import blocks and plan again**
```bash
tofu plan -var-file=production.tfvars
```

Now OpenTofu will try to import the resources and compare them to your config. The plan will show DIFFERENCES between your config and the actual GCP state. Common mismatches:

- **VM name**: Your config says `east-sbc-1` but the real VM is named `poc-custom-voip`. Fix: use the actual name or accept that tofu will want to replace it. For existing VMs, match the real name.
- **Machine type**: Config says `e2-standard-4` but the VM is `e2-medium`. Fix: update tfvars.
- **Boot image**: Config specifies one image but the VM was created from a different one. Fix: use `data` source to reference the existing disk, or set `image` to match.
- **Tags**: VM might not have `voip-sbc` tag. Fix: plan will show "add tag" — this is safe.
- **Labels**: New labels get added — safe.

**Step 3: Fix config to match reality**

For each difference in the plan output:
- If the change is SAFE (add label, add tag) — accept it
- If the change would REPLACE the VM (rename, change boot disk) — fix your config to match the existing resource
- If the change would MODIFY in-place (change machine type) — decide if you want to keep the existing size or resize

**Step 4: Repeat until plan shows 0 changes for imported resources**

```bash
tofu plan -var-file=production.tfvars
# Output should show:
# module.region["east"]... — no changes
# module.region["west"]... — will be created (6 resources)
# module.region["central"]... — will be created (6 resources)
```

**Step 5: Apply the import**
```bash
tofu apply -var-file=production.tfvars
```

This imports East into state AND creates West/Central (if you are ready). To import East ONLY without creating new regions, temporarily remove West and Central from the `production.tfvars` regions map, then add them back later.

### 7.5 Handling Name Mismatches

The existing VMs have inconsistent names: `poc-custom-voip`, `kam-g2`, `fs-media`, `services`. The new naming convention is `east-sbc-1`, `east-sbc-2`, `east-fs`, `east-services`.

**Option A: Accept existing names (recommended for Phase 1)**

Create a `local` block in the voip-region module that maps count index to the actual VM name:

```hcl
variable "vm_name_overrides" {
  description = "Override VM names for imported resources"
  type = object({
    sbc_names     = optional(list(string))
    fs_name       = optional(string)
    services_name = optional(string)
  })
  default = {}
}

locals {
  sbc_names     = var.vm_name_overrides.sbc_names != null ? var.vm_name_overrides.sbc_names : [for i in range(var.config.sbc_count) : "${var.region_name}-sbc-${i + 1}"]
  fs_name       = var.vm_name_overrides.fs_name != null ? var.vm_name_overrides.fs_name : "${var.region_name}-fs"
  services_name = var.vm_name_overrides.services_name != null ? var.vm_name_overrides.services_name : "${var.region_name}-services"
}
```

Then in `production.tfvars` for east:
```hcl
  east = {
    # ... other fields ...
    vm_name_overrides = {
      sbc_names     = ["poc-custom-voip", "kam-g2"]
      fs_name       = "fs-media"
      services_name = "services"
    }
  }
```

**Option B: Rename VMs later**

GCP does not support renaming VMs in-place. To rename: stop VM, create snapshot, create new VM from snapshot with new name, delete old VM. Do this during a maintenance window.

---

## 8. State Management

### 8.1 Remote State in GCS

State file location: `gs://revup-tofu-state/production/default.tfstate`

The `prefix = "production"` in the backend config means the state file lives at that path prefix. If you later need a staging environment, use a different prefix or a different workspace.

### 8.2 Common State Commands

```bash
# List all resources in state
tofu state list

# Show details of a specific resource
tofu state show 'module.region["east"].google_compute_instance.sbc[0]'

# Remove a resource from state WITHOUT destroying it
# (useful if you need to restructure modules)
tofu state rm 'module.region["east"].google_compute_instance.sbc[0]'

# Move a resource in state (refactoring)
tofu state mv 'module.region["east"].google_compute_instance.sbc[0]' \
  'module.region["east"].google_compute_instance.sbc["poc-custom-voip"]'

# Pull remote state to local file for inspection
tofu state pull > state-backup.json

# Force unlock (only if a lock is stuck — rare)
tofu force-unlock LOCK_ID
```

### 8.3 Handling State Drift

If someone makes a manual change in GCP console or via `gcloud`:

```bash
# Refresh state to pick up manual changes
tofu refresh -var-file=production.tfvars

# Then plan to see drift
tofu plan -var-file=production.tfvars
```

The plan output will show what OpenTofu wants to change to bring GCP back in line with the config. Decide per-change:
- **Accept the drift**: Update your `.tf` files to match the manual change
- **Revert the drift**: Run `tofu apply` to undo the manual change

### 8.4 Backup Strategy

- **GCS versioning** is enabled on the state bucket. Every `tofu apply` creates a new version. You can restore previous state via `gsutil`.
- **Before risky operations**, manually pull state:
  ```bash
  tofu state pull > /tmp/state-backup-$(date +%Y%m%d-%H%M%S).json
  ```
- **Never edit state JSON manually.** Use `tofu state` commands or `tofu import`.

---

## 9. CI/CD Integration

### 9.1 Workflow Overview

```
Developer pushes code
    |
    +--> Application code change (docker/*, docker-compose.*)
    |       |
    |       +--> Ansible deploys to VMs (git pull + rebuild)
    |            No Tofu involved.
    |
    +--> Infrastructure change (infra/*)
            |
            +--> PR triggers `tofu plan` (GitHub Actions, optional)
            +--> Plan output posted as PR comment
            +--> Human reviews plan, approves PR
            +--> Merge triggers `tofu apply` (or manual apply)
```

### 9.2 Application Deploy Flow (No OpenTofu)

Day-to-day development does NOT touch OpenTofu. The existing deploy workflow stays:

```bash
# Developer pushes code
git push origin RCF-V1

# SSH to each VM and pull
ssh sbc-1
cd /opt/revup && sudo git pull && sudo docker compose -f docker-compose.sbc.yml up -d --build

# Or: Ansible playbook (preferred)
cd /Users/keegan/revup/ansible
ansible-playbook playbooks/deploy.yml -l sbc
```

### 9.3 Infrastructure Change Flow

When you need to add a region, resize a VM, or change firewall rules:

1. Edit files in `infra/`
2. Run `tofu plan -var-file=production.tfvars` locally
3. Review the plan output carefully
4. Create a PR with the changes
5. After review, run `tofu apply -var-file=production.tfvars` from your local machine (or a CI runner)

### 9.4 GitHub Actions (Phase 2 -- Optional)

A basic CI pipeline for infrastructure PRs:

```yaml
# .github/workflows/tofu-plan.yml
name: OpenTofu Plan
on:
  pull_request:
    paths:
      - 'infra/**'

jobs:
  plan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write  # For Workload Identity Federation

    steps:
      - uses: actions/checkout@v4

      - name: Setup OpenTofu
        uses: opentofu/setup-opentofu@v1
        with:
          tofu_version: "1.6.0"

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: 'projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github'
          service_account: 'tofu-ci@rugged-night-193017.iam.gserviceaccount.com'

      - name: Tofu Init
        working-directory: infra
        run: tofu init

      - name: Tofu Plan
        working-directory: infra
        run: tofu plan -var-file=production.tfvars -no-color -out=tfplan 2>&1 | tee plan.txt

      - name: Post Plan to PR
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const plan = fs.readFileSync('infra/plan.txt', 'utf8');
            const truncated = plan.length > 60000 ? plan.slice(0, 60000) + '\n... (truncated)' : plan;
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `## OpenTofu Plan\n\`\`\`\n${truncated}\n\`\`\``
            });
```

**GCP Authentication for CI**: Use Workload Identity Federation (no service account key file). Create:
1. A Workload Identity Pool for GitHub
2. A service account `tofu-ci@rugged-night-193017.iam.gserviceaccount.com` with `roles/compute.admin` and `roles/storage.objectAdmin`
3. Bind the pool to the service account with an attribute condition on the repo name

### 9.5 Should `tofu plan` Run in CI on PRs?

**Yes, but not in Phase 1.** Focus on getting the import right first. Add CI later when the team is comfortable with OpenTofu. The value of CI plan-on-PR is:
- Everyone sees what infrastructure changes a PR makes before merging
- Prevents accidental destroys
- Catches config errors early

**Never run `tofu apply` automatically on merge.** Infrastructure applies should always be a deliberate human action, at least for now.

---

## 10. Day 1 Checklist

### Phase 0: Prerequisites (30 minutes)

```bash
# 1. Install OpenTofu
brew install opentofu

# 2. Verify
tofu version

# 3. Authenticate to GCP
gcloud auth application-default login --project=rugged-night-193017

# 4. Create the state bucket
gcloud storage buckets create gs://revup-tofu-state --project=rugged-night-193017 --location=us --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://revup-tofu-state --versioning
```

### Phase 1: Scaffold the Project (1-2 hours)

```bash
# 5. Create directory structure
mkdir -p /Users/keegan/revup/infra/modules/voip-region
mkdir -p /Users/keegan/revup/infra/modules/firewall
mkdir -p /Users/keegan/revup/infra/modules/global-lb

# 6. Create all .tf files per this plan (versions.tf, providers.tf, variables.tf, etc.)
# 7. Create production.tfvars with East region only (West and Central commented out)

# 8. Initialize
cd /Users/keegan/revup/infra
tofu init
```

### Phase 2: Discover Existing Resources (1 hour)

```bash
# 9. Run all the gcloud discovery commands from Section 7.2
# 10. Record exact VM names, IPs, machine types, disk images, tags
# 11. Check which IPs are reserved vs ephemeral:
gcloud compute addresses list --project=rugged-night-193017

# 12. Check exact firewall rule names:
gcloud compute firewall-rules list --project=rugged-night-193017
```

### Phase 3: Write East Config to Match Reality (2-4 hours)

```bash
# 13. Update module config to match ACTUAL VM attributes
#     (names, machine types, disk sizes, images, tags)
# 14. Add vm_name_overrides for poc-custom-voip, kam-g2, fs-media, services
# 15. Write import blocks in import-east.tf

# 16. First plan — expect many diffs
tofu plan -var-file=production.tfvars

# 17. Fix config to eliminate diffs (iterative)
# 18. Repeat until plan shows ONLY tag/label additions (safe in-place changes)
```

### Phase 4: Import East (30 minutes)

```bash
# 19. Apply — imports existing resources into state
tofu apply -var-file=production.tfvars

# 20. Verify state
tofu state list
tofu state show 'module.region["east"].google_compute_instance.sbc[0]'

# 21. Plan again — should show 0 changes
tofu plan -var-file=production.tfvars
# "No changes. Your infrastructure matches the configuration."

# 22. Delete import-east.tf (import blocks are one-time-use)
rm import-east.tf
```

### Phase 5: Add West Region (when ready)

```bash
# 23. Uncomment west in production.tfvars
# 24. Plan — should show ~8 new resources (2 SBCs + 1 FS + IPs + instance group)
tofu plan -var-file=production.tfvars

# 25. Review the plan carefully — only CREATE, no DESTROY/MODIFY on East
# 26. Apply
tofu apply -var-file=production.tfvars

# 27. Configure VMs with Ansible
cd /Users/keegan/revup/ansible
ansible-playbook playbooks/site.yml -l west
```

### Phase 6: Add Central Region (when ready)

Same as Phase 5, but for central.

---

## 11. Safety Guardrails

### 11.1 `prevent_destroy` Lifecycle

Already shown in the module code above. Every VM and static IP has:

```hcl
lifecycle {
  prevent_destroy = true
}
```

This means `tofu destroy` or any plan that would destroy these resources will FAIL with an error. To actually destroy them (decommission), you must first remove the lifecycle block, plan, then apply.

### 11.2 Protecting Against Accidental `tofu destroy`

1. **`prevent_destroy`** on all VMs, static IPs, and the instance group
2. **Never run `tofu destroy`** without explicit intent. There is no "undo".
3. **State bucket versioning** lets you recover state if something goes wrong
4. **CI plan output** shows exactly what will be destroyed before anyone approves

### 11.3 Zero-Downtime VM Changes

**Scenario: Need to resize a VM (e.g., e2-standard-4 to e2-standard-8)**

GCP supports in-place machine type change with a stop/start:

```hcl
# Change machine_type in tfvars, then plan
# Plan will show: ~ machine_type: "e2-standard-4" => "e2-standard-8"
# This is a MODIFY, not a REPLACE — VM stays, just restarts
```

OpenTofu will stop the VM, resize, and start it. Brief downtime (~30 seconds). For zero-downtime:
1. Resize SBC-1 (SBC-2 handles all traffic)
2. Wait for SBC-1 to come back healthy in the NLB
3. Resize SBC-2

For FreeSWITCH (no redundancy within a zone): drain calls to another region first, then resize.

**Scenario: Need to change boot disk image (forces VM replacement)**

Use `create_before_destroy`:

```hcl
lifecycle {
  create_before_destroy = true
  # Temporarily remove prevent_destroy for this operation
}
```

This creates the new VM first, then destroys the old one. But be careful: the new VM gets a different instance ID and might get a different IP unless you use static IPs (which we do).

Actually, for VMs with static IPs, `create_before_destroy` will FAIL because the IP is already in use. In that case:
1. Create the new VM with a temporary IP
2. Drain traffic from the old VM
3. Delete the old VM (releases the IP)
4. Reassign the static IP to the new VM

This is a manual migration, not a simple `tofu apply`.

### 11.4 The `-target` Escape Hatch

If you need to apply changes to one resource without touching others:

```bash
# Only apply changes to the East SBC-1 VM
tofu apply -var-file=production.tfvars \
  -target='module.region["east"].google_compute_instance.sbc[0]'
```

Use sparingly. It can leave state inconsistent if dependencies are not applied.

### 11.5 Plan File Workflow (Recommended for Production)

Always save the plan and apply the exact plan you reviewed:

```bash
# Save plan to file
tofu plan -var-file=production.tfvars -out=plan.tfplan

# Review it
tofu show plan.tfplan

# Apply the EXACT plan (no re-planning)
tofu apply plan.tfplan
```

This prevents drift between "what I reviewed" and "what got applied."

---

## 12. Ansible Integration Detail

### 12.1 Inventory Generation

After `tofu apply`, generate Ansible inventory from outputs:

```bash
# Output structured JSON
cd /Users/keegan/revup/infra
tofu output -json ansible_inventory > ../ansible/inventory/tofu_output.json
```

Or use a dynamic inventory script (`ansible/inventory/tofu_inventory.py`) that runs `tofu output` on the fly.

A simpler approach for Phase 1: maintain a static `production.yml` inventory and update it manually when infrastructure changes (which is rare).

### 12.2 Static Inventory Example

```yaml
# ansible/inventory/production.yml
all:
  children:
    sbc:
      hosts:
        east-sbc-1:
          ansible_host: 34.74.71.32
          sbc_id: east-sbc-1
          hep_capture_id: 100
          external_sip_ip: 34.24.133.82  # VIP
          freeswitch_ip: 192.168.10.2
          bandwidth_primary_ip: 67.231.2.12
          bandwidth_secondary_ip: 216.82.238.134
        east-sbc-2:
          ansible_host: 35.243.136.35
          sbc_id: east-sbc-2
          hep_capture_id: 101
          external_sip_ip: 34.24.133.82  # VIP
          freeswitch_ip: 192.168.10.2
          bandwidth_primary_ip: 67.231.2.12
          bandwidth_secondary_ip: 216.82.238.134

    media:
      hosts:
        east-fs:
          ansible_host: 34.139.119.135
          external_sip_ip: 34.139.119.135
          sbc_proxy_ip: 10.142.0.100
          db_host: 10.142.0.103

    services:
      hosts:
        east-services:
          ansible_host: 34.26.57.37
          freeswitch_esl_host: 192.168.10.2
```

### 12.3 Role: Common (all VMs)

```yaml
# ansible/roles/common/tasks/main.yml
- name: Install Docker
  apt:
    name: [docker.io, docker-compose-plugin]
    state: present
    update_cache: yes

- name: Add user to docker group
  user:
    name: "{{ ansible_user }}"
    groups: docker
    append: yes

- name: Clone/update revup repo
  git:
    repo: https://github.com/YOUR_ORG/revup.git
    dest: /opt/revup
    version: RCF-V1

- name: Apply kernel tuning
  script: /opt/revup/scripts/kernel_tune.sh
```

### 12.4 Role: SBC

```yaml
# ansible/roles/sbc/tasks/main.yml
- name: Template SBC .env
  template:
    src: env.sbc.j2
    dest: /opt/revup/.env
    mode: '0600'

- name: Build and start Kamailio
  shell: |
    cd /opt/revup
    sudo docker compose -f docker-compose.sbc.yml up -d --build
```

---

## 13. OpenTofu vs Existing Resources -- Decision Matrix

| Existing Resource | Action | Rationale |
|---|---|---|
| 4 VMs (poc-custom-voip, kam-g2, fs-media, services) | **Import** | Running production traffic. Cannot recreate. |
| Static IPs (if reserved) | **Import** | Bandwidth has them whitelisted. Cannot change. |
| Ephemeral IPs | **Reserve + Import** | Reserve them as static first, then import. |
| Instance group (sbc-group) | **Import** | NLB backend references it. |
| Regional NLB (34.24.133.82) | **Import or skip** | Will be replaced by global LB in Phase 2. Import if you want Tofu to manage the transition. Skip if you will just delete it manually later. |
| Firewall rules | **Import** | Want all rules in code for auditability. |
| VPC and subnets | **Skip** | Using `default` VPC. Do not import GCP-managed defaults. Reference them by name. |
| Service accounts | **Skip for now** | Phase 2 concern. |

---

## 14. Module: `global-lb` (Phase 2)

### `modules/global-lb/main.tf`

```hcl
# Global static IP (anycast)
resource "google_compute_global_address" "sip_vip" {
  name    = "sip-global-vip"
  project = var.project_id
}

# Health check for SBC backends
resource "google_compute_health_check" "sbc" {
  name    = "sbc-health-check-global"
  project = var.project_id

  tcp_health_check {
    port = 5060
  }

  check_interval_sec  = 5
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3
}

# Backend service (global, UDP)
resource "google_compute_backend_service" "sbc" {
  name                  = "sbc-backend-global"
  project               = var.project_id
  protocol              = "UNSPECIFIED"  # Required for NLB passthrough
  load_balancing_scheme = "EXTERNAL"
  session_affinity      = "CLIENT_IP"
  health_checks         = [google_compute_health_check.sbc.id]

  dynamic "backend" {
    for_each = var.instance_groups
    content {
      group = backend.value
    }
  }
}

# Forwarding rule — UDP 5060
resource "google_compute_global_forwarding_rule" "sip_udp" {
  name                  = "sip-global-udp"
  project               = var.project_id
  ip_address            = google_compute_global_address.sip_vip.address
  ip_protocol           = "UDP"
  port_range            = "5060"
  load_balancing_scheme = "EXTERNAL"
  target                = google_compute_backend_service.sbc.id
}

# Forwarding rule — TCP 5060
resource "google_compute_global_forwarding_rule" "sip_tcp" {
  name                  = "sip-global-tcp"
  project               = var.project_id
  ip_address            = google_compute_global_address.sip_vip.address
  ip_protocol           = "TCP"
  port_range            = "5060"
  load_balancing_scheme = "EXTERNAL"
  target                = google_compute_backend_service.sbc.id
}
```

### `modules/global-lb/outputs.tf`

```hcl
output "global_vip" {
  description = "Global anycast VIP for SIP traffic"
  value       = google_compute_global_address.sip_vip.address
}
```

**Important**: The Global External Passthrough NLB for UDP may require the Premium Tier network and specific API enablement. Verify with:
```bash
gcloud compute forwarding-rules describe sbc-vip-udp --region=us-east1 --project=rugged-night-193017
```

---

## 15. Git Integration

### What Gets Committed

```
infra/                 # ALL .tf files — committed
infra/production.tfvars # Committed (no secrets, just machine types and IP bases)
infra/.terraform/       # NOT committed (gitignore already covers this)
infra/*.tfstate         # NOT committed (gitignore already covers this)
infra/*.tfplan          # NOT committed (add to gitignore)
```

### Additions to `.gitignore`

```
# OpenTofu
infra/.terraform/
infra/*.tfstate
infra/*.tfstate.backup
infra/*.tfplan
infra/.terraform.lock.hcl  # OR commit this for reproducible provider versions
```

Actually, `.terraform.lock.hcl` SHOULD be committed. It pins exact provider versions like a lockfile. Add this exception:

```
# OpenTofu
infra/.terraform/
infra/*.tfstate
infra/*.tfstate.backup
infra/*.tfplan
# DO commit .terraform.lock.hcl (provider version pinning)
```

---

## 16. Cost of This Approach

| Item | One-time effort | Ongoing effort |
|---|---|---|
| Write module code | 4-6 hours | 0 |
| Import existing East | 2-4 hours (iterative) | 0 |
| Deploy new region | 30 min (add to tfvars, apply) | 0 |
| Write Ansible roles | 4-6 hours | Minimal |
| Deploy app update | 0 (Ansible handles it) | 5 min per deploy |
| Add firewall rule | 0 | 5 min (edit .tf, plan, apply) |

**Total initial investment**: ~2-3 days
**Payoff**: Every subsequent region is a 30-minute operation instead of a full day of `gcloud` commands.

---

## 17. What OpenTofu Does NOT Manage

| Concern | Managed By |
|---|---|
| Docker images on VMs | Ansible (git pull + docker compose build) |
| .env files on VMs | Ansible (template + deploy) |
| PostgreSQL data/schema | Ansible (pg_basebackup for replicas, migrations via API) |
| Bandwidth carrier config | Manual (dashboard or API, separate from infra) |
| DNS records | Manual or separate Tofu config (when ready) |
| SSL certificates | Let's Encrypt via certbot (Ansible role) |
| Secrets rotation | Ansible vault or GCP Secret Manager |
| Application code deploys | Ansible + git |

This separation is intentional. OpenTofu handles the "what metal exists" question. Ansible handles the "what runs on the metal" question. They meet at the VM: Tofu creates it, Ansible configures it.
