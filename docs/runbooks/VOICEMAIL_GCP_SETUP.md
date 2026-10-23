# Encrypted voicemail: GCP setup runbook (operator)

This runbook covers the GCP side only: KMS, the bucket, the `vm-api` identity and audit logs. It does not cover the app deploy (migration 54, `.env`, compose, FS). That is in the lead's deploy runbook.

- **Code:** `infra/voicemail/` (OpenTofu, state prefix `voip-voicemail`).
- **Contract:** `docs/ENCRYPTED_VOICEMAIL_INTERFACES.md` §2/§8 and `docs/ENCRYPTED_VOICEMAIL_BUILD_PLAN.md` §4.

**Conventions**
- Run commands on the **workstation** unless a step is marked **[services VM]**.
- Every command is one line. Every `gcloud` command passes `--project rugged-night-193017`.
- The project number below is `562404538544`, so the default compute SA is `562404538544-compute@developer.gserviceaccount.com`. Step 1.2 confirms the number.

## 0. Credential decision (read first)

1. **Always first:** do §1–§3. They create the keys, the bucket, `vm-api`, the IAM and the audit logs. Nothing touches a VM.
2. **Option A (preferred):** if you can take a ~10 min overnight window on `services`, which holds the PG primary, use §4A. You stop the VM, run `set-service-account vm-api --scopes cloud-platform`, and start it. After that, only the services VM can use the voicemail keys.
3. **Option B (fallback):** if there is no window yet, use §4B. The VM keeps the default SA with `cloud-platform` scope and impersonates `vm-api`. There is no restart, but **every VM running as the default SA** can mint vm-api tokens. That includes the DB replicas, which hold the wrapped DEKs. Use B only as a bridge to A.
4. **Option C (key file):** §4C. It is blocked today by the org policy `iam.managed.disableServiceAccountKeyCreation` (check 1.9).
5. **Under every option:** the default compute SA never gets a KMS role or a voicemail-bucket role.

---

## 1. Checks (read-only)

1. Confirm you are the active account and that it is a project Owner:
   `gcloud auth list --filter=status:ACTIVE --format='value(account)'`
   → your account.
2. Confirm the project number:
   `gcloud projects describe rugged-night-193017 --format='value(projectNumber)'`
   → `562404538544`. If it differs, replace `562404538544` everywhere below.
3. Check the services VM's SA and scopes:
   `gcloud compute instances describe services --zone us-east1-b --project rugged-night-193017 --format='yaml(serviceAccounts)'`
   → `email: 562404538544-compute@developer.gserviceaccount.com` and `scopes: - https://www.googleapis.com/auth/cloud-platform`.
   - **Write this down.** It is the rollback for §4A.
   - If `cloud-platform` is missing, option B is impossible. Use A.
4. List the default SA's project roles. These are what the services VM loses under option A:
   `gcloud projects get-iam-policy rugged-night-193017 --flatten='bindings[].members' --filter='bindings.members:serviceAccount:562404538544-compute@developer.gserviceaccount.com' --format='value(bindings.role)'`
   → a short list, e.g. `roles/monitoring.viewer`, `roles/logging.logWriter` and `roles/monitoring.metricWriter`.
   - For option A, `services_vm_project_roles` (tfvars) must contain every non-basic role listed here.
   - **If `roles/editor` or `roles/owner` appears:**
     - Every VM in the project can manage KMS keys and read and delete bucket objects. That undermines the isolation this stack builds. Raise it before launch; removing it is a separate change.
     - Option A may also drop permissions you cannot see from this list. Watch 4A's checks (steps 9–16) closely.
5. Check the default SA's binding on the backup bucket. Option A gives vm-api the same:
   `gcloud storage buckets get-iam-policy gs://revup-db-backups --project rugged-night-193017 --flatten='bindings[].members' --filter='bindings.members:562404538544-compute' --format='value(bindings.role)'`
   → `roles/storage.objectAdmin`.
6. Check for firewall rules keyed on service accounts. Option A changes the identity they match:
   `gcloud compute firewall-rules list --project rugged-night-193017 --filter='sourceServiceAccounts:* OR targetServiceAccounts:*' --format='table(name,sourceServiceAccounts.list(),targetServiceAccounts.list())'`
   → `Listed 0 items.` (all VoIP rules are tag-based). Any row naming the default SA: stop and review before option A.
7. Check which APIs are enabled:
   `gcloud services list --enabled --project rugged-night-193017 | grep -E 'cloudkms|storage|iamcredentials|iam\.googleapis'`
   → `iam.googleapis.com` and `storage*.googleapis.com` are present. `cloudkms` and `iamcredentials` are probably missing, which §2 fixes.
8. Check the existing audit config. Tofu **replaces** the `cloudkms` and `storage` entries:
   `gcloud projects get-iam-policy rugged-night-193017 --format='json(auditConfigs)'`
   → `{}`.
   - If a `cloudkms.googleapis.com` or `storage.googleapis.com` entry exists, copy its `exemptedMembers` into `storage_audit_exempted_members`.
   - An `allServices` entry is untouched.
9. Check whether SA key creation is blocked (decides option C):
   `gcloud org-policies describe iam.managed.disableServiceAccountKeyCreation --project rugged-night-193017 --effective`
   → `enforce: true`, so option C is unavailable.
10. Check that the names are free:
    - `gcloud storage buckets describe gs://voip-voicemail --project rugged-night-193017` → a 404 / "not found" error.
      - A **403** means another project owns the global name. Pick another `bucket_name` and use it as `VOICEMAIL_BUCKET`.
    - `gcloud iam service-accounts describe vm-api@rugged-night-193017.iam.gserviceaccount.com --project rugged-night-193017` → `NOT_FOUND`.

## 2. Enable APIs

1. `gcloud services enable cloudkms.googleapis.com iamcredentials.googleapis.com --project rugged-night-193017`
   → `Operation "operations/…" finished successfully.`
2. `gcloud kms keyrings list --location us-east1 --project rugged-night-193017 --format='value(name)'`
   → no `voicemail-prod` and no `voicemail-bucket`.
   - If one exists from an earlier attempt, it cannot be deleted. Import it before §3A step 3: `tofu import google_kms_key_ring.voicemail projects/rugged-night-193017/locations/us-east1/keyRings/voicemail-prod`, or `google_kms_key_ring.bucket …/keyRings/voicemail-bucket`.

## 3. Create the resources

Use **either** 3A **or** 3B, not both.

### 3A. OpenTofu (preferred)

Check out or merge the branch that contains `infra/voicemail/` first.

1. `cd /Users/KeGrabhorn/custom-voip/infra/voicemail && tofu init`
   → `OpenTofu has been successfully initialized!`
2. Set tfvars. **Option A:** nothing to do, unless 1.4 listed extra roles. In that case, `cp terraform.tfvars.example terraform.tfvars` and set `services_vm_project_roles`.
   **Option B only:**
   `printf 'vm_api_is_services_vm_identity = false\nimpersonator_service_account = "562404538544-compute@developer.gserviceaccount.com"\n' > terraform.tfvars`
3. `tofu plan -out=/tmp/voicemail.tfplan`
   → `Plan: 20 to add, 0 to change, 0 to destroy.` (option B: `17 to add`).
   - Skim the plan: the only binding that names the `-compute@` SA is option B's `serviceAccountTokenCreator`.
4. `tofu apply /tmp/voicemail.tfplan`
   → `Apply complete! Resources: 20 added, 0 changed, 0 destroyed.` and the outputs.
   - `… API has not been used … or it is disabled`: wait 2 min, then repeat steps 3 and 4.
   - `Service account … does not exist` right after it was created: IAM propagation lag. Repeat steps 3 and 4.
   - `… do not belong to a permitted customer`: Domain Restricted Sharing blocked a member. An org admin must allow it.
5. `tofu output -raw services_env`
   → the `VOICEMAIL_*` lines (option B adds `VOICEMAIL_IMPERSONATE_SA`). Hand them to the app deploy.
6. Commit the new `infra/voicemail/.terraform.lock.hcl`.

### 3B. Pure gcloud (alternative)

Same result as 3A. Do not run 3A afterwards without importing.

1. `gcloud kms keyrings create voicemail-prod --location us-east1 --project rugged-night-193017` → no output.
2. `gcloud kms keyrings create voicemail-bucket --location us-east1 --project rugged-night-193017` → no output.
3. `gcloud kms keys create voip-voicemail-bucket --keyring voicemail-bucket --location us-east1 --project rugged-night-193017 --purpose encryption --protection-level software --rotation-period 90d --next-rotation-time $(date -u -v+90d +%Y-%m-%dT%H:%M:%SZ) --labels app=revup-voip,component=voicemail`
   - This uses macOS `date`. On Linux, use `$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)`.
   - The destroy-scheduled duration keeps the 30 d default.
4. `gcloud storage service-agent --project rugged-night-193017` → `service-562404538544@gs-project-accounts.iam.gserviceaccount.com`
5. `gcloud kms keys add-iam-policy-binding voip-voicemail-bucket --keyring voicemail-bucket --location us-east1 --project rugged-night-193017 --member serviceAccount:service-562404538544@gs-project-accounts.iam.gserviceaccount.com --role roles/cloudkms.cryptoKeyEncrypterDecrypter` → `Updated IAM policy for key [voip-voicemail-bucket].`
6. `gcloud storage buckets create gs://voip-voicemail --project rugged-night-193017 --location us-east1 --default-storage-class STANDARD --uniform-bucket-level-access --public-access-prevention --soft-delete-duration 7d --default-encryption-key projects/rugged-night-193017/locations/us-east1/keyRings/voicemail-bucket/cryptoKeys/voip-voicemail-bucket` → `Creating gs://voip-voicemail/...`
7. `gcloud iam service-accounts create vm-api --project rugged-night-193017 --display-name "Voicemail API (services VM)"` → `Created service account [vm-api].`
8. `gcloud iam roles create voicemailKeyLifecycle --project rugged-night-193017 --title "Voicemail per-customer key lifecycle" --stage GA --permissions cloudkms.cryptoKeys.create,cloudkms.cryptoKeys.get,cloudkms.cryptoKeys.list,cloudkms.cryptoKeys.update,cloudkms.cryptoKeyVersions.get,cloudkms.cryptoKeyVersions.list,cloudkms.cryptoKeyVersions.destroy` → `Created role [voicemailKeyLifecycle].`
9. `gcloud kms keyrings add-iam-policy-binding voicemail-prod --location us-east1 --project rugged-night-193017 --member serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role projects/rugged-night-193017/roles/voicemailKeyLifecycle`
10. `gcloud kms keyrings add-iam-policy-binding voicemail-prod --location us-east1 --project rugged-night-193017 --member serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role roles/cloudkms.cryptoKeyEncrypterDecrypter`
11. `gcloud storage buckets add-iam-policy-binding gs://voip-voicemail --project rugged-night-193017 --member serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role roles/storage.objectAdmin`
12. **Option A only.** These are the carry-over grants: the backup bucket, plus the roles from 1.4.
    - `gcloud storage buckets add-iam-policy-binding gs://revup-db-backups --project rugged-night-193017 --member serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role roles/storage.objectAdmin`
    - `gcloud projects add-iam-policy-binding rugged-night-193017 --member serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role roles/logging.logWriter --condition=None`
    - `gcloud projects add-iam-policy-binding rugged-night-193017 --member serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role roles/monitoring.metricWriter --condition=None`
    - `gcloud projects add-iam-policy-binding rugged-night-193017 --member serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role roles/monitoring.viewer --condition=None`
13. **Option B only:**
    `gcloud iam service-accounts add-iam-policy-binding vm-api@rugged-night-193017.iam.gserviceaccount.com --project rugged-night-193017 --member serviceAccount:562404538544-compute@developer.gserviceaccount.com --role roles/iam.serviceAccountTokenCreator`
14. **Audit logs:** set these in the Console. Doing it with gcloud means rewriting the whole project IAM policy.
    - Go to IAM & Admin → Audit Logs.
    - Tick **Cloud Key Management Service (KMS)** → Admin Read, Data Read and Data Write → Save.
    - Repeat for **Google Cloud Storage**.

## 4. Credentials

### 4A. Option A: attach vm-api to the services VM (maintenance window)

**Impact while the VM is stopped (~5–10 min):** the PG primary, PgBouncer, API, UI, Homer and Grafana all stop.
- **East:** new calls fail, because East DID lookups and SBC trunk auth read the primary.
- **West/Central:** calls keep routing on the local replicas. CDR ingest and provisioning writes fail. Once FS's 2 retries are exhausted, CDRs land in `/var/log/freeswitch/json_cdr/errors` on each FS.
- **Alerts:** the `infra/monitoring` VM-down and uptime alerts fire.
- **Do not promote `east-db-standby`.** This is a planned stop.

Before the window, §3 must be applied, including the carry-over grants, and 1.4–1.6 must be reviewed.

1. `gcloud compute instances stop services --zone us-east1-b --project rugged-night-193017` → `Stopping instance(s) services...done.`
2. Run `tofu output -raw option_a_set_service_account_command`, or directly:
   `gcloud compute instances set-service-account services --zone us-east1-b --project rugged-night-193017 --service-account vm-api@rugged-night-193017.iam.gserviceaccount.com --scopes cloud-platform`
   → `Updated [https://www.googleapis.com/compute/v1/projects/rugged-night-193017/zones/us-east1-b/instances/services].`
3. `gcloud compute instances start services --zone us-east1-b --project rugged-night-193017` → `Starting instance(s) services...done.`
4. `gcloud compute instances describe services --zone us-east1-b --project rugged-night-193017 --format='yaml(serviceAccounts)'` → `vm-api@…` and `cloud-platform`.
5. **[services VM]**, about 2 min after the start:
   `curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email`
   → `vm-api@rugged-night-193017.iam.gserviceaccount.com`
6. **[services VM]** `sudo -u postgres psql -tAc "SELECT pg_is_in_recovery()"` → `f`
7. **[services VM]** `sudo systemctl is-active postgresql@16-main pgbouncer` → `active` twice.
8. **[services VM]** `sudo -u postgres psql -X -c "SELECT application_name, client_addr, state, replay_lag FROM pg_stat_replication;"`
   → one row per replica (East standby, West, Central, sandbox), all `streaming`. Give them about 1 min to reconnect.
9. **[services VM]** `sudo docker ps --format '{{.Names}}\t{{.Status}}' | sort` → every container `Up`.
10. **[services VM]** `curl -s http://127.0.0.1:8088/health` → healthy.
11. **[services VM]** `sudo -u postgres pgbackrest --stanza=main check && echo PGBACKREST-OK`
    → `PGBACKREST-OK`. WAL archiving to `gs://revup-db-backups` works as vm-api.
    - **If this fails, roll back now.** Failed archiving fills `pg_wal` on the primary.
12. **[services VM]** `sudo /opt/revup/scripts/backup/preflight.sh`
    → `VM service account: vm-api@…`, `GCS write probe succeeded`, and no `FAIL`.
13. **[services VM]** `sudo systemctl is-active google-cloud-ops-agent && logger -t revup-sa-check "vm-api swap probe"`
    → `active`. Do **not** use the tag `revup-alert`; that one pages.
14. Then on the workstation:
    `gcloud logging read '"vm-api swap probe"' --project rugged-night-193017 --freshness=15m --limit=1 --format='value(timestamp)'`
    → one timestamp. Allow about 2 min.
15. In Grafana, open NOC → Infra overview. The GCP Monitoring panels should draw with no "permission denied".
16. Make a test call to `+16174544217`. It rings `+17744045256` and connects.

**Rollback** (same window shape):
1. `gcloud compute instances stop services --zone us-east1-b --project rugged-night-193017`
2. `gcloud compute instances set-service-account services --zone us-east1-b --project rugged-night-193017 --service-account 562404538544-compute@developer.gserviceaccount.com --scopes cloud-platform` (use the scopes recorded in 1.3).
3. `gcloud compute instances start services --zone us-east1-b --project rugged-night-193017`

**After A, if you bridged with B:**
- Remove `impersonator_service_account` from `terraform.tfvars`, then run `tofu plan -out=/tmp/voicemail.tfplan` → `1 to destroy` (only the tokenCreator binding) → `tofu apply /tmp/voicemail.tfplan`.
- Remove `VOICEMAIL_IMPERSONATE_SA` from the services `.env`.

**OS Login note:** with OS Login, anyone other than a project Owner who SSHes into `services` needs `roles/iam.serviceAccountUser` on vm-api. That role also lets them act as vm-api, so grant it deliberately.

### 4B. Option B: impersonation (no restart)

This needs `cloud-platform` in the scopes from 1.3.

1. Apply §3 with option B's tfvars.
   - If you already applied the default A, add only `impersonator_service_account = "562404538544-compute@developer.gserviceaccount.com"` to `terraform.tfvars`. The plan shows `1 to add`.
   - The A carry-over grants then sit unused and harmless until the A window.
2. **[services VM]** `sudo gcloud kms keys list --keyring voicemail-prod --location us-east1 --project rugged-night-193017 --impersonate-service-account vm-api@rugged-night-193017.iam.gserviceaccount.com`
   → an impersonation `WARNING` line, then `Listed 0 items.`
3. The services `.env` gets `VOICEMAIL_IMPERSONATE_SA=vm-api@rugged-night-193017.iam.gserviceaccount.com`. It is in `tofu output -raw services_env`.

**Known weakness:** every VM running as the default SA can run step 2. That covers the SBCs, all FS nodes, the DB replicas and anything else in the project. Move to A at the next window.

### 4C. Option C: key file (last resort, blocked today)

SA key creation is blocked by `iam.managed.disableServiceAccountKeyCreation` (1.9). If an org admin ever exempts this project:
1. Create the key on the services VM, from a session authenticated as you:
   `sudo gcloud iam service-accounts keys create /opt/revup/secrets/vm-api-key.json --iam-account vm-api@rugged-night-193017.iam.gserviceaccount.com`
2. `sudo chmod 600 /opt/revup/secrets/vm-api-key.json`
3. The app deploy mounts the file read-only into `api` and sets `GOOGLE_APPLICATION_CREDENTIALS`.
4. Rotate the key at least every 90 days, and delete it once you move to A.

## 5. Verify (no app needed)

1. `gcloud kms keyrings list --location us-east1 --project rugged-night-193017 --format='value(name)'` → both `…/keyRings/voicemail-prod` and `…/keyRings/voicemail-bucket`.
2. `gcloud kms keys list --keyring voicemail-prod --location us-east1 --project rugged-night-193017` → `Listed 0 items.` Customer keys `vm-cust-<id>` appear as mailboxes are created.
3. `gcloud kms keys describe voip-voicemail-bucket --keyring voicemail-bucket --location us-east1 --project rugged-night-193017 --format='value(purpose,versionTemplate.protectionLevel,rotationPeriod,destroyScheduledDuration)'` → `ENCRYPT_DECRYPT  SOFTWARE  7776000s  2592000s`
4. `gcloud storage buckets describe gs://voip-voicemail --project rugged-night-193017`. Check for:
   - `default_kms_key: …/cryptoKeys/voip-voicemail-bucket`
   - `location: US-EAST1`
   - `public_access_prevention: enforced`
   - `uniform_bucket_level_access: true`
   - a soft-delete retention of `604800` s
   - versioning not enabled
5. `gcloud kms keyrings get-iam-policy voicemail-prod --location us-east1 --project rugged-night-193017` → exactly 2 bindings, both for `serviceAccount:vm-api@…`:
   - `projects/rugged-night-193017/roles/voicemailKeyLifecycle`
   - `roles/cloudkms.cryptoKeyEncrypterDecrypter`
6. `gcloud kms keyrings get-iam-policy voicemail-bucket --location us-east1 --project rugged-night-193017` → `etag: ACAB` only, with no bindings.
7. `gcloud kms keys get-iam-policy voip-voicemail-bucket --keyring voicemail-bucket --location us-east1 --project rugged-night-193017` → 1 binding: `service-562404538544@gs-project-accounts…` with `cryptoKeyEncrypterDecrypter`.
8. `gcloud storage buckets get-iam-policy gs://voip-voicemail --project rugged-night-193017` → vm-api `roles/storage.objectAdmin`, plus the standard `projectOwner:`/`projectEditor:`/`projectViewer:` legacy bindings every bucket gets. Nothing for `-compute@`.
9. `gcloud iam roles describe voicemailKeyLifecycle --project rugged-night-193017 --format='value(includedPermissions)'` → the 7 `cloudkms.*` permissions from §3B step 8.
10. `gcloud projects get-iam-policy rugged-night-193017 --flatten='bindings[].members' --filter='bindings.members:vm-api@' --format='value(bindings.role)'`
    → A: `roles/logging.logWriter`, `roles/monitoring.metricWriter` and `roles/monitoring.viewer`. B: nothing.
11. `gcloud iam service-accounts get-iam-policy vm-api@rugged-night-193017.iam.gserviceaccount.com --project rugged-night-193017`
    → A: `etag: ACAB` (no bindings). B: `roles/iam.serviceAccountTokenCreator` for the `-compute@` SA.
12. `gcloud projects get-iam-policy rugged-night-193017 --format='json(auditConfigs)'` → `cloudkms.googleapis.com` and `storage.googleapis.com`, each with `ADMIN_READ`, `DATA_READ` and `DATA_WRITE`.
13. **Permission smoke test** **[services VM]**. It makes the exact calls the API makes at runtime.
    - It leaves one permanent, empty key, `vm-smoketest`. KMS keys cannot be deleted. The API never touches it.
    - **Option B:** append ` --impersonate-service-account vm-api@rugged-night-193017.iam.gserviceaccount.com` to every `gcloud` line.
    1. `sudo gcloud kms keys create vm-smoketest --keyring voicemail-prod --location us-east1 --project rugged-night-193017 --purpose encryption --protection-level software --destroy-scheduled-duration 1d` → no error.
    2. `echo -n hello | sudo gcloud kms encrypt --key vm-smoketest --keyring voicemail-prod --location us-east1 --project rugged-night-193017 --plaintext-file - --ciphertext-file /dev/shm/vm-smoke.enc` → no output.
    3. `sudo gcloud kms decrypt --key vm-smoketest --keyring voicemail-prod --location us-east1 --project rugged-night-193017 --ciphertext-file /dev/shm/vm-smoke.enc --plaintext-file -` → `hello`
    4. `sudo gcloud kms keys update vm-smoketest --keyring voicemail-prod --location us-east1 --project rugged-night-193017 --update-labels smoke=done` → the key, with `smoke: done`.
    5. `sudo gcloud kms keys versions list --key vm-smoketest --keyring voicemail-prod --location us-east1 --project rugged-night-193017 --format='value(name,state)'` → `…/cryptoKeyVersions/1  ENABLED`
    6. `sudo gcloud kms keys versions destroy 1 --key vm-smoketest --keyring voicemail-prod --location us-east1 --project rugged-night-193017` → `state: DESTROY_SCHEDULED`
    7. `echo probe | sudo gcloud storage cp - gs://voip-voicemail/_probe/services.txt` → `Copying file://- to gs://voip-voicemail/_probe/services.txt`
    8. `sudo gcloud storage objects describe gs://voip-voicemail/_probe/services.txt` → a `kms_key` line ending `…/cryptoKeys/voip-voicemail-bucket/cryptoKeyVersions/1`.
    9. `sudo gcloud storage rm gs://voip-voicemail/_probe/services.txt && sudo rm -f /dev/shm/vm-smoke.enc` → `Removing objects:` … `Completed 1`.
14. **Isolation check, option A only.** On any SBC or FS VM, all of which run as the default SA:
    `sudo gcloud kms keys list --keyring voicemail-prod --location us-east1 --project rugged-night-193017`
    → `PERMISSION_DENIED`.
15. **Data Access logs**, 5–10 min after step 13:
    - `gcloud logging read 'logName="projects/rugged-night-193017/logs/cloudaudit.googleapis.com%2Fdata_access" AND protoPayload.serviceName="cloudkms.googleapis.com"' --project rugged-night-193017 --freshness=1h --limit=10 --format='table(timestamp,protoPayload.methodName,protoPayload.authenticationInfo.principalEmail)'`
      → `Encrypt` and `Decrypt` rows by `vm-api@…`, plus GCS service-agent rows from steps 13.7 and 13.8.
    - Swap in `storage.googleapis.com` → `storage.objects.create`, `get` and `delete` rows by `vm-api@…`.

## 6. Secrets for the app deploy (generate only)

1. `openssl rand -hex 32` → 64 hex characters. This is `INGEST_SHARED_SECRET`. It goes in the services `.env` and in all 6 FS nodes' `/opt/revup/secrets/fs-voicemail/vm_ingest.header`.
2. `openssl rand -hex 32` → a **different** value. This is `VOICEMAIL_PLAYBACK_SECRET`, for the services `.env` only.

Both must differ from each other and from `JWT_SECRET_KEY`. Never commit or paste them. Installing them is part of the app deploy runbook.

## 7. Never / undo

- **Never run `tofu destroy` in `infra/voicemail`.** Key rings and keys are permanent. Destroying the bucket key schedules every version for destruction, which makes every voicemail unreadable.
- **Never grant** KMS roles, or any role on `gs://voip-voicemail`, to the default compute SA.
- **Never grant** `iam.serviceAccountUser` or `iam.serviceAccountTokenCreator` on vm-api casually. Either one lets the holder act as vm-api and decrypt.
- **To undo a bucket-key version destroyed by mistake** (within 30 days):
  1. `gcloud kms keys versions restore <N> --key voip-voicemail-bucket --keyring voicemail-bucket --location us-east1 --project rugged-night-193017`
  2. `gcloud kms keys versions enable <N> --key voip-voicemail-bucket --keyring voicemail-bucket --location us-east1 --project rugged-night-193017`
- **Customer KEKs (`vm-cust-<id>`)** have a 24 h window on purpose. That is the crypto-erase. The same restore command works inside that window.
- **Cost:** about $0.06 per key version per month (the bucket key, one per customer, plus one per rotation), and $0.03 per 10k KMS operations. The audit-log volume is small.
