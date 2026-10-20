# infra/voicemail — KMS, bucket and identity for encrypted voicemail

State: `gs://revup-tofu-state`, prefix `voip-voicemail`. Contract:
`docs/ENCRYPTED_VOICEMAIL_INTERFACES.md` §2/§8. Operator runbook (checks,
apply, the services VM SA swap, verification):
**`docs/runbooks/VOICEMAIL_GCP_SETUP.md`**.

## What it creates (project `rugged-night-193017`, `us-east1`)

| Resource | Notes |
|---|---|
| Key ring `voicemail-prod` | Holds ONLY the per-customer KEKs `vm-cust-<customer_id>`, which **the API creates at runtime** (SOFTWARE, ENCRYPT_DECRYPT, 365 d rotation, 24 h destroy-scheduled). |
| Key ring `voicemail-bucket` + key `voip-voicemail-bucket` | Bucket CMEK key: SOFTWARE, 90 d rotation, 30 d destroy-scheduled. It is in its **own** ring so that vm-api has no role on it (see below). |
| Bucket `gs://voip-voicemail` | US-EAST1, STANDARD, uniform access, public-access prevention enforced, versioning **off**, soft delete **7 d**, default KMS key = the bucket key, `prevent_destroy`. No lifecycle delete rule: the API's retention worker enforces per-mailbox retention. |
| SA `vm-api@rugged-night-193017.iam.gserviceaccount.com` | The only identity that can use the voicemail keys and objects. |
| Custom role `projects/rugged-night-193017/roles/voicemailKeyLifecycle` | Bound on the `voicemail-prod` ring only. |
| Data Access audit logs | ADMIN_READ, DATA_READ and DATA_WRITE for `cloudkms.googleapis.com` and `storage.googleapis.com`. |
| APIs | `cloudkms`, `iam`, `iamcredentials`, `storage` (`disable_on_destroy = false`). |

## IAM granted (and why)

| Who | Role | Scope | Why |
|---|---|---|---|
| vm-api | `voicemailKeyLifecycle` (custom): `cloudkms.cryptoKeys.{create,get,list,update}`, `cloudkms.cryptoKeyVersions.{get,list,destroy}` | ring `voicemail-prod` | create a customer's key on first use, read it, list/destroy its versions for crypto-erase, and update it (e.g. clear rotation after erase). No `setIamPolicy`, no `restore`, no version create/enable/disable. |
| vm-api | `roles/cloudkms.cryptoKeyEncrypterDecrypter` | ring `voicemail-prod` | wrap/unwrap per-message DEKs (with AAD). |
| vm-api | `roles/storage.objectAdmin` | bucket `voip-voicemail` | write/read/delete ciphertext objects. No bucket-level permissions: the API must use `client.bucket(name)`, not `get_bucket()`. |
| GCS service agent `service-562404538544@gs-project-accounts…` | `roles/cloudkms.cryptoKeyEncrypterDecrypter` | key `voip-voicemail-bucket` only | CMEK encrypt/decrypt of every object. |
| vm-api, **option A only** (`vm_api_is_services_vm_identity = true`, the default) | `roles/storage.objectAdmin` on `revup-db-backups`; project `roles/logging.logWriter`, `roles/monitoring.metricWriter`, `roles/monitoring.viewer` | as listed | Option A swaps the services VM's identity **for everything on it**. These keep pgBackRest/WAL archiving, pg_dump, the CDR archive, the Ops Agent (incl. `revup-alert` paging) and Grafana's GCP datasource working. Compare with what the default SA really holds first (runbook 1.4/1.5). |
| the VM's current SA, **option B only** (`impersonator_service_account`) | `roles/iam.serviceAccountTokenCreator` | SA `vm-api` only | no-restart fallback. It is weaker: every VM running as that SA can mint vm-api tokens. |
| default compute SA | **nothing** | | Every VM runs as it (SBCs, FS, DB replicas that hold the wrapped DEKs). |

Why two key rings: a binding on a key ring covers every key in it. If the
bucket key lived in `voicemail-prod`, vm-api's `cryptoKeyVersions.destroy` would
let one API bug or a compromised API host destroy the key that protects
**every** object. With two rings, the per-customer bindings need no IAM conditions.

## Apply (workstation, single lines)

See the runbook §1–§3 for the pre-checks and expected output.

1. `cd /Users/KeGrabhorn/custom-voip/infra/voicemail && tofu init`
2. Optional: `cp terraform.tfvars.example terraform.tfvars`. Only option B or non-default names need it.
3. `tofu plan -out=/tmp/voicemail.tfplan`: expect **20 to add** (option A default) or 17 (option B), with **0 to change and 0 to destroy**.
4. `tofu apply /tmp/voicemail.tfplan`
5. Commit the generated `.terraform.lock.hcl`.

## Safety

- **Cloud KMS key rings and keys can never be deleted** in GCP. Their names stay
  reserved forever. A `tofu destroy` of the bucket key schedules all its versions
  for destruction, which would make every stored voicemail unreadable (you can
  undo it within 30 days with `gcloud kms keys versions restore`).
  `prevent_destroy` is on the key rings, the key, the bucket and the SA.
  **Never run `tofu destroy` here.**
- `google_project_iam_audit_config` is authoritative **per service**. Copy any
  existing KMS/Storage audit exemptions into tfvars first (runbook 1.8).
- Storage Data Access logging is project-wide, so it also logs backup traffic.
  The volume is small. To cut it, use `storage_audit_exempted_members`.
- Soft delete keeps deleted ciphertext for 7 days. Crypto-erase still works
  immediately, because the customer's KEK is destroyed.

## Check during `plan` (written offline, not validated against the provider)

- `google_storage_bucket.soft_delete_policy` needs google provider ≥ 5.22. `~> 5.0` resolves to the latest 5.x.
- `data.google_storage_project_service_account` shows `(known after apply)` on the first plan because of `depends_on`. That is expected.
- Permission names in the custom role. If `tofu apply` rejects one as "not supported in custom roles", the error names it.
- Org policy `iam.allowedPolicyMemberDomains` (Domain Restricted Sharing) is enforced in this org. Project service accounts and the GCS service agent should be allowed. If a binding fails with "do not belong to a permitted customer", an org admin must allow it.
