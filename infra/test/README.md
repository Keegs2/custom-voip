# infra/test — single-VM test environment (OpenTofu)

Automates the GCP prep for the all-in-one test box (see `docs/TEST_VM_DEPLOY.md`):
it **adopts the retired `fs-media` VM** under IaC, resizes it, adds the `bypass-vpn`
(Cloud-NAT fix) + `voip-test` tags, attaches a static external IP, and creates the
scoped firewall rules. This is the first OpenTofu in the repo — the foundation for
the broader IaC in `infra/OPENTOFU_PLAN.md`.

## What it manages
| Resource | Notes |
|----------|-------|
| `google_compute_address.test_ip` | Static external IP (`fs-media-test-ip`), `prevent_destroy` |
| `google_compute_instance.test_fs` | **Imported** fs-media — manages machine_type, tags, external IP only; `prevent_destroy`, broad `ignore_changes` so it's adopted, never recreated |
| `google_compute_firewall.test_sip` / `_rtp` | SIP 5060 + RTP 16384-49151 from Bandwidth ranges only |
| `google_compute_firewall.test_web` | UI/API/Verto/TURN from **your** `office_cidrs` only |

## Usage
```
cd infra/test
cp terraform.tfvars.example terraform.tfvars   # set office_cidrs (curl ifconfig.me)
tofu init
tofu plan          # ⚠️ CONFIRM the VM shows "update in-place", NOT "replace"/"destroy"
tofu apply
tofu output test_public_ip
```
Then start the VM and deploy the stack per `docs/TEST_VM_DEPLOY.md` (Step 3+),
using `tofu output test_public_ip` as `EXTERNAL_SIP_IP`.

## Safety
- State is isolated under the `voip-test` prefix in `gs://revup-tofu-state`.
- `prevent_destroy = true` on the VM and IP (matches the repo rule: never `tofu destroy` a VM/IP). To "tear down" a test, **stop** the VM (`gcloud compute instances stop fs-media --zone=us-east1-b`) rather than destroy it.
- The `import` block is idempotent — once adopted, it's a no-op on subsequent applies (you can leave it or remove it).
- If `tofu plan` wants to **replace** the VM, do NOT apply: fix `boot_disk_name` / the `network_interface` in `terraform.tfvars` to match the real fs-media first.

## Prereqs
- `gcloud auth application-default login` (provider credentials).
- The `gs://revup-tofu-state` bucket exists (per OPENTOFU_PLAN.md). If not, create it once: `gsutil mb -l us gs://revup-tofu-state && gsutil versioning set on gs://revup-tofu-state`, or comment out the `backend "gcs"` block in `backend.tf` to use local state.
