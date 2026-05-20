# Infrastructure as Code Plan — OpenTofu + Ansible

## Executive Summary

OpenTofu manages GCP infrastructure (VMs, NLBs, firewall rules, static IPs).
Ansible manages application deployment (.env templating, git pull, docker compose, health checks).
Together they provide reproducible, idempotent, state-tracked infrastructure for the multi-region VoIP platform.

**Cost: $0** — both tools are free and open source.

---

## Directory Structure

```
revup/
  infra/                                    # OpenTofu — GCP infrastructure
    main.tf                                 # Root: stamps out regions + firewall
    variables.tf                            # Root inputs (project, regions map)
    outputs.tf                              # Root outputs (IPs, VIPs, for Ansible)
    versions.tf                             # OpenTofu + provider version pins
    backend.tf                              # GCS remote state backend
    imports.tf                              # One-time import blocks for East
    production.tfvars                        # Actual values (git-ignored)
    production.tfvars.example               # Checked in, shows expected shape
    modules/
      voip-region/                          # Per-region: VMs, IPs, NLB
        main.tf                             # SBC + FS compute instances
        nlb.tf                              # Regional NLB (instance group, health check, forwarding rules)
        variables.tf                        # All per-region inputs
        outputs.tf                          # IPs, self-links
      firewall/                             # VPC-wide firewall rules (created once)
        main.tf                             # 7 rules: SIP, RTP, health check, internal, admin, HEP, SSH
        variables.tf
        outputs.tf
      global-lb/                            # Phase 2: Geo LB (single anycast VIP)
        main.tf
        variables.tf
        outputs.tf

  ansible/                                  # Ansible — deployment + config management
    ansible.cfg                             # Global config (SSH via IAP, vault, become)
    requirements.yml                        # Galaxy collections (google.cloud, community.docker)
    inventory/
      production/
        hosts.yml                           # All VMs by region and role
        group_vars/
          all.yml                           # Global constants + vault refs
          east.yml, west.yml, central.yml   # Per-region IPs, Bandwidth PoPs
          sbc.yml, media.yml, services.yml  # Per-role compose files, health checks
        host_vars/
          east-sbc-1.yml ... central-sbc-2.yml  # Per-host: SBC_ID, HEP_CAPTURE_ID
    vault/
      production.yml                        # Encrypted: DB_PASS, ESL_PASSWORD, JWT_SECRET
    playbooks/
      setup-vm.yml                          # Initial VM provisioning (run once)
      provision-env.yml                     # Template .env files to all VMs
      deploy-sbc.yml                        # Rolling Kamailio deploy (serial: 1)
      deploy-media.yml                      # FreeSWITCH deploy (with drain procedure)
      deploy-services.yml                   # API + UI + Homer deploy
      deploy-all.yml                        # Full deploy in dependency order
      rollback.yml                          # Rollback to specific git commit
      health-check.yml                      # Non-destructive fleet health check
    roles/
      common/                               # Docker, sysctl, SSH, base packages
      sbc/                                  # Loopback IP, SBC .env template
      media/                                # Kernel tuning, media .env template
      services/                             # PgBouncer, services .env template
      db_replica/                           # Streaming replication, PgBouncer
      deploy/                               # Shared: git pull, docker compose, health check
```

---

## Phased Execution

### Phase 1: Import East (half day)
1. `brew install opentofu`
2. Create GCS state bucket: `gsutil mb -l us-east1 gs://granite-keystone-tofu-state`
3. Write East module config matching current GCP state exactly
4. `tofu init` → `tofu plan` (iterative: fix drift until 0 changes)
5. `tofu apply` (imports existing resources into state)
6. Set up Ansible: `pip install ansible`, create vault, write inventory
7. Run `ansible-playbook playbooks/health-check.yml` to verify connectivity

### Phase 2: Deploy West
1. Add West to `production.tfvars` regions map
2. `tofu plan` → shows ~12 new resources
3. `tofu apply` → creates West VMs, NLB, IPs
4. `ansible-playbook playbooks/setup-vm.yml -l west`
5. `ansible-playbook playbooks/deploy-all.yml -l west`
6. Test SIP connectivity to West NLB VIP

### Phase 3: Deploy Central
Same as Phase 2 for Central.

### Phase 4: Global Geo LB
1. Uncomment `global-lb` module
2. `tofu apply` → creates global anycast VIP
3. Update Bandwidth termination host to global VIP
4. After burn-in, remove regional NLBs

---

## Operator Quick Reference

```bash
# Infrastructure (OpenTofu)
cd infra && tofu plan                              # Preview changes
cd infra && tofu apply                             # Apply changes

# Deployment (Ansible)
cd ansible
ansible-playbook playbooks/deploy-all.yml          # Full deploy
ansible-playbook playbooks/deploy-sbc.yml -l east  # East SBCs only
ansible-playbook playbooks/provision-env.yml       # Update .env files
ansible-playbook playbooks/health-check.yml        # Check everything
ansible-playbook playbooks/rollback.yml -e target_commit=abc1234  # Rollback
```

---

## Safety Guardrails

- `prevent_destroy = true` on all VMs and static IPs
- SBC deploys are `serial: 1` (one at a time, never both down)
- FS deploy pre-kills orphaned processes (host networking gotcha)
- Health checks gate every deployment step
- `tofu plan` always reviewed before `tofu apply`
- Ansible Vault encrypts all secrets (DB_PASS, ESL_PASSWORD, JWT_SECRET)
- `.env` files are mode 0600, never in git

## Detailed Plans

The three expert agents produced complete, production-ready plans:

1. **OpenTofu modules** (telephony expert): Complete HCL for voip-region, firewall, and global-lb modules with all SIP/VoIP considerations (CLIENT_IP affinity, health check timing, dual UDP+TCP forwarding, RTP ranges, host networking, loopback IP). Includes full import strategy for existing East resources.

2. **Ansible deployment** (backend architect): 8 playbooks, 6 roles, Jinja2 .env templates, Ansible Vault secrets management, rolling deploy strategy, drain procedures for FreeSWITCH, rollback playbook, and operator command reference.

3. **Project structure** (general): State management in GCS, variable hierarchy, CI/CD integration with GitHub Actions, Day 1 checklist, and safety guardrails.

Full HCL code and YAML playbooks are documented in the agent outputs and ready to be scaffolded into the repo.
