# infra/backups — bucket + disk-snapshot schedule for DB backups

Creates, in project `rugged-night-193017`:

- `gs://revup-db-backups` — versioned, public-access-prevented bucket holding
  `pgdump/` (35-day lifecycle), `pgbackrest/` (pgBackRest-managed expiry) and
  `cdr-archive/` (kept, Coldline after 90 days). `prevent_destroy` set.
- IAM: `roles/storage.objectAdmin` on the bucket for the services VM's
  service account (keyless auth via metadata — no key files).
- `revup-services-daily-snapshot` — daily GCE disk snapshot schedule
  (08:00 UTC, 14-day retention) attached to the `services` boot disk.

Consumed by `scripts/backup/` on the services VM. Restore procedures:
`docs/runbooks/DB_RESTORE_RUNBOOK.md`.

## Apply (from your workstation, single lines)

1. `cd /Users/keegan/revup/infra/backups && tofu init`
2. Verify ground truth first: `gcloud compute disks list --zones us-east1-b --project rugged-night-193017` and `gcloud compute instances describe services --zone us-east1-b --project rugged-night-193017 --format='value(serviceAccounts[].email)'` — if the disk is not named `services` or the VM runs a non-default SA, set `snapshot_disks` / `backup_writer_service_account` in `terraform.tfvars` (see the example file).
3. `tofu plan` — expect ~5 adds, zero changes/destroys.
4. `tofu apply`

## Safety

- `prevent_destroy = true` on the bucket and snapshot policy. Never run
  `tofu destroy` here — this stack IS the disaster recovery.
- The bucket enforces `public_access_prevention` and uniform bucket-level
  access; only the VM service account (and project admins) can read it.
