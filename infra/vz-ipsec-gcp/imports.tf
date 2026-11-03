# ============================================================================
# Import blocks — one per object gcloud created on 2026-10-30 (54 total)
# ============================================================================
# Every id is the canonical "projects/.../..." form each resource type documents
# (hashicorp/google 5.x). Nothing in here is applied until the Verizon turn-up
# is accepted; `tofu plan` must then report "54 to import, 0 to add, 0 to
# change, 0 to destroy" — see README.md. Print the ids for eyeballing against
# `gcloud ... describe --format='value(selfLink)'` with:  python3 check_ids.py
#
# Delete this file (or the individual blocks) after the import apply has
# landed in state — import blocks are one-shot, like OPENTOFU_PLAN.md §7.3.
# ============================================================================


# ----------------------------------------------------------------------------
# Reserved external addresses (9)
# ----------------------------------------------------------------------------

import {
  to = google_compute_address.ike["east-a"]
  id = "projects/rugged-night-193017/regions/us-east1/addresses/east-vz-ike-a"
}

import {
  to = google_compute_address.ike["east-b"]
  id = "projects/rugged-night-193017/regions/us-east1/addresses/east-vz-ike-b"
}

import {
  to = google_compute_address.sip["east"]
  id = "projects/rugged-night-193017/regions/us-east1/addresses/east-vz-sip"
}

import {
  to = google_compute_address.ike["west-a"]
  id = "projects/rugged-night-193017/regions/us-west1/addresses/west-vz-ike-a"
}

import {
  to = google_compute_address.ike["west-b"]
  id = "projects/rugged-night-193017/regions/us-west1/addresses/west-vz-ike-b"
}

import {
  to = google_compute_address.sip["west"]
  id = "projects/rugged-night-193017/regions/us-west1/addresses/west-vz-sip"
}

import {
  to = google_compute_address.ike["central-a"]
  id = "projects/rugged-night-193017/regions/us-central1/addresses/central-vz-ike-a"
}

import {
  to = google_compute_address.ike["central-b"]
  id = "projects/rugged-night-193017/regions/us-central1/addresses/central-vz-ike-b"
}

import {
  to = google_compute_address.sip["central"]
  id = "projects/rugged-night-193017/regions/us-central1/addresses/central-vz-sip"
}

# ----------------------------------------------------------------------------
# Gateway subnets (3)
# ----------------------------------------------------------------------------

import {
  to = google_compute_subnetwork.vz["east"]
  id = "projects/rugged-night-193017/regions/us-east1/subnetworks/vz-ipsec-east"
}

import {
  to = google_compute_subnetwork.vz["west"]
  id = "projects/rugged-night-193017/regions/us-west1/subnetworks/vz-ipsec-west"
}

import {
  to = google_compute_subnetwork.vz["central"]
  id = "projects/rugged-night-193017/regions/us-central1/subnetworks/vz-ipsec-central"
}

# ----------------------------------------------------------------------------
# Gateway VMs (6)
# ----------------------------------------------------------------------------

import {
  to = google_compute_instance.gw["east-a"]
  id = "projects/rugged-night-193017/zones/us-east1-b/instances/east-vz-gw-a"
}

import {
  to = google_compute_instance.gw["east-b"]
  id = "projects/rugged-night-193017/zones/us-east1-c/instances/east-vz-gw-b"
}

import {
  to = google_compute_instance.gw["west-a"]
  id = "projects/rugged-night-193017/zones/us-west1-b/instances/west-vz-gw-a"
}

import {
  to = google_compute_instance.gw["west-b"]
  id = "projects/rugged-night-193017/zones/us-west1-c/instances/west-vz-gw-b"
}

import {
  to = google_compute_instance.gw["central-a"]
  id = "projects/rugged-night-193017/zones/us-central1-a/instances/central-vz-gw-a"
}

import {
  to = google_compute_instance.gw["central-b"]
  id = "projects/rugged-night-193017/zones/us-central1-f/instances/central-vz-gw-b"
}

# ----------------------------------------------------------------------------
# Target instances (6)
# ----------------------------------------------------------------------------

import {
  to = google_compute_target_instance.gw["east-a"]
  id = "projects/rugged-night-193017/zones/us-east1-b/targetInstances/east-vz-gw-a-ti"
}

import {
  to = google_compute_target_instance.gw["east-b"]
  id = "projects/rugged-night-193017/zones/us-east1-c/targetInstances/east-vz-gw-b-ti"
}

import {
  to = google_compute_target_instance.gw["west-a"]
  id = "projects/rugged-night-193017/zones/us-west1-b/targetInstances/west-vz-gw-a-ti"
}

import {
  to = google_compute_target_instance.gw["west-b"]
  id = "projects/rugged-night-193017/zones/us-west1-c/targetInstances/west-vz-gw-b-ti"
}

import {
  to = google_compute_target_instance.gw["central-a"]
  id = "projects/rugged-night-193017/zones/us-central1-a/targetInstances/central-vz-gw-a-ti"
}

import {
  to = google_compute_target_instance.gw["central-b"]
  id = "projects/rugged-night-193017/zones/us-central1-f/targetInstances/central-vz-gw-b-ti"
}

# ----------------------------------------------------------------------------
# External protocol-forwarding rules on the IKE IPs (6)
# ----------------------------------------------------------------------------

import {
  to = google_compute_forwarding_rule.ike["east-a"]
  id = "projects/rugged-night-193017/regions/us-east1/forwardingRules/east-vz-gw-a-fwd"
}

import {
  to = google_compute_forwarding_rule.ike["east-b"]
  id = "projects/rugged-night-193017/regions/us-east1/forwardingRules/east-vz-gw-b-fwd"
}

import {
  to = google_compute_forwarding_rule.ike["west-a"]
  id = "projects/rugged-night-193017/regions/us-west1/forwardingRules/west-vz-gw-a-fwd"
}

import {
  to = google_compute_forwarding_rule.ike["west-b"]
  id = "projects/rugged-night-193017/regions/us-west1/forwardingRules/west-vz-gw-b-fwd"
}

import {
  to = google_compute_forwarding_rule.ike["central-a"]
  id = "projects/rugged-night-193017/regions/us-central1/forwardingRules/central-vz-gw-a-fwd"
}

import {
  to = google_compute_forwarding_rule.ike["central-b"]
  id = "projects/rugged-night-193017/regions/us-central1/forwardingRules/central-vz-gw-b-fwd"
}

# ----------------------------------------------------------------------------
# Unmanaged instance groups (6)
# ----------------------------------------------------------------------------

import {
  to = google_compute_instance_group.gw["east-a"]
  id = "projects/rugged-night-193017/zones/us-east1-b/instanceGroups/east-vz-gw-a-group"
}

import {
  to = google_compute_instance_group.gw["east-b"]
  id = "projects/rugged-night-193017/zones/us-east1-c/instanceGroups/east-vz-gw-b-group"
}

import {
  to = google_compute_instance_group.gw["west-a"]
  id = "projects/rugged-night-193017/zones/us-west1-b/instanceGroups/west-vz-gw-a-group"
}

import {
  to = google_compute_instance_group.gw["west-b"]
  id = "projects/rugged-night-193017/zones/us-west1-c/instanceGroups/west-vz-gw-b-group"
}

import {
  to = google_compute_instance_group.gw["central-a"]
  id = "projects/rugged-night-193017/zones/us-central1-a/instanceGroups/central-vz-gw-a-group"
}

import {
  to = google_compute_instance_group.gw["central-b"]
  id = "projects/rugged-night-193017/zones/us-central1-f/instanceGroups/central-vz-gw-b-group"
}

# ----------------------------------------------------------------------------
# Gateway health checks (3)
# ----------------------------------------------------------------------------

import {
  to = google_compute_region_health_check.gw["east"]
  id = "projects/rugged-night-193017/regions/us-east1/healthChecks/east-vz-gw-hc"
}

import {
  to = google_compute_region_health_check.gw["west"]
  id = "projects/rugged-night-193017/regions/us-west1/healthChecks/west-vz-gw-hc"
}

import {
  to = google_compute_region_health_check.gw["central"]
  id = "projects/rugged-night-193017/regions/us-central1/healthChecks/central-vz-gw-hc"
}

# ----------------------------------------------------------------------------
# Gateway backend services (3)
# ----------------------------------------------------------------------------

import {
  to = google_compute_region_backend_service.gw["east"]
  id = "projects/rugged-night-193017/regions/us-east1/backendServices/east-vz-gw-backend"
}

import {
  to = google_compute_region_backend_service.gw["west"]
  id = "projects/rugged-night-193017/regions/us-west1/backendServices/west-vz-gw-backend"
}

import {
  to = google_compute_region_backend_service.gw["central"]
  id = "projects/rugged-night-193017/regions/us-central1/backendServices/central-vz-gw-backend"
}

# ----------------------------------------------------------------------------
# Gateway next-hop ILB forwarding rules (3)
# ----------------------------------------------------------------------------

import {
  to = google_compute_forwarding_rule.gw_ilb["east"]
  id = "projects/rugged-night-193017/regions/us-east1/forwardingRules/east-vz-gw-ilb"
}

import {
  to = google_compute_forwarding_rule.gw_ilb["west"]
  id = "projects/rugged-night-193017/regions/us-west1/forwardingRules/west-vz-gw-ilb"
}

import {
  to = google_compute_forwarding_rule.gw_ilb["central"]
  id = "projects/rugged-night-193017/regions/us-central1/forwardingRules/central-vz-gw-ilb"
}

# ----------------------------------------------------------------------------
# SBC Verizon VIP backend services (3)
# ----------------------------------------------------------------------------

import {
  to = google_compute_region_backend_service.sbc_verizon["east"]
  id = "projects/rugged-night-193017/regions/us-east1/backendServices/sbc-verizon-backend"
}

import {
  to = google_compute_region_backend_service.sbc_verizon["west"]
  id = "projects/rugged-night-193017/regions/us-west1/backendServices/west-sbc-verizon-backend"
}

import {
  to = google_compute_region_backend_service.sbc_verizon["central"]
  id = "projects/rugged-night-193017/regions/us-central1/backendServices/central-sbc-verizon-backend"
}

# ----------------------------------------------------------------------------
# SBC Verizon VIP forwarding rules (3)
# ----------------------------------------------------------------------------

import {
  to = google_compute_forwarding_rule.sbc_verizon["east"]
  id = "projects/rugged-night-193017/regions/us-east1/forwardingRules/sbc-verizon-fwd"
}

import {
  to = google_compute_forwarding_rule.sbc_verizon["west"]
  id = "projects/rugged-night-193017/regions/us-west1/forwardingRules/west-sbc-verizon-fwd"
}

import {
  to = google_compute_forwarding_rule.sbc_verizon["central"]
  id = "projects/rugged-night-193017/regions/us-central1/forwardingRules/central-sbc-verizon-fwd"
}

# ----------------------------------------------------------------------------
# Firewall rules (3, global)
# ----------------------------------------------------------------------------

import {
  to = google_compute_firewall.iap_ssh
  id = "projects/rugged-night-193017/global/firewalls/vz-ipsec-allow-iap-ssh"
}

import {
  to = google_compute_firewall.hc
  id = "projects/rugged-night-193017/global/firewalls/vz-ipsec-allow-hc"
}

import {
  to = google_compute_firewall.internal_fwd
  id = "projects/rugged-night-193017/global/firewalls/vz-ipsec-allow-internal-fwd"
}
