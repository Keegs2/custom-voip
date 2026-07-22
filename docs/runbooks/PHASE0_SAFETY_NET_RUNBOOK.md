# Phase 0 — Safety Net Activation Runbook (LIVE PROD)

**Goal:** arm backups + ops monitoring + on-call paging on the live East stack, then prove recovery with a restore drill.
**Verified apply-ready 2026-07-22** (backups + monitoring modules audited, no code blockers).
**Legend:** 🟢 SAFE (no call-path impact) · 🟠 DISRUPTIVE (customer-visible, schedule it) · 🔴 IRREVERSIBLE.

> Workstation note: `tofu` is not installed here — use `terraform` (provider already initialized), or install OpenTofu. Backend/HCL work with both.

## Inputs the operator must provide
1. **Alert email** (required — monitoring `tofu apply` fails without it).
2. **PagerDuty Events v2 integration key** (strongly recommended — email alone doesn't wake anyone).
3. *(optional)* SMS number (E.164) — must be verified in Cloud Console after apply.
4. **Two lookups to confirm before backups apply:**
   - services VM service-account: `gcloud compute instances describe services --zone us-east1-b --project rugged-night-193017 --format='value(serviceAccounts[].email)'`
   - services boot-disk name: `gcloud compute disks list --zones us-east1-b --project rugged-night-193017`
   (If SA ≠ default compute SA or disk ≠ `services`, set `backup_writer_service_account` / `snapshot_disks` in `infra/backups/terraform.tfvars`.)
5. **One maintenance window (~10 min)** for the single disruptive step (PG `archive_mode` restart, ~5–10s new-call outage; active calls unaffected).

## Recommended order: MONITORING FIRST, then BACKUPS
Rationale: backup *failure* paging reuses monitoring's `revup-alert` log-match policy + the Ops Agent. Stand up paging first so a backup failure actually alerts someone. Monitoring is also lower-risk (no PG restart).

---

## Step 0 — Prerequisite: land the ops assets on the production branch  (🟢 SAFE)
The backups/monitoring/replica IaC + on-VM scripts + DR runbook currently exist **only on `unified`**; the prod VMs track **RCF-V1** and deploy via `git pull`. Until these are on RCF-V1, every on-VM step below fails. They are pure ops additions (no call-path or UCaaS code) → low-risk to port.
Surgical port (review the diff before pushing):
```
git checkout RCF-V1
git checkout unified -- infra/backups infra/monitoring infra/replica scripts/backup scripts/monitoring docs/runbooks/DB_RESTORE_RUNBOOK.md docs/runbooks/PHASE0_SAFETY_NET_RUNBOOK.md docs/NATIONWIDE_PRODUCTION_ROLLOUT_PLAN.md
git commit -m "ops: backups + monitoring + replica IaC/scripts for Phase 0 safety net"
git push origin RCF-V1
```
Then `cd /opt/revup && sudo git pull` on each prod VM brings the scripts. (The workstation `tofu apply` can run from either checkout; only the on-VM scripts strictly must be on RCF-V1.)

---

## Step 1 — Ops monitoring + paging  (🟢 mostly SAFE)
From `/Users/keegan/revup/infra/monitoring`:
1. 🟢 `terraform init` (no-op; backend `gs://revup-tofu-state/voip-monitoring`).
2. 🟢 `cp terraform.tfvars.example terraform.tfvars` → set `notification_email`, `pagerduty_service_key` (+ `sms_number` if used). Everything else is defaulted correct for East.
3. 🟢 `terraform plan` → expect **~13 adds, 0 destroy, 0 change**. Confirm the 2 prober firewall rules target `voip-sbc`/`voip-services` and `prober_source_ranges_count` > 0.
4. 🟠 (additive only) `terraform apply` → uptime checks, 8 alert policies, channels, **2 new firewall rules** (open probed ports to Google prober IPs only — does not narrow existing Bandwidth/office rules; no service restart). These prober rules ARE required — no existing rule admits Cloud Monitoring probers.
5. 🟢 On **each** of `poc-custom-voip`, `kam-g2`, `fs-media-v2`, `services`: `cd /opt/revup && sudo git pull && sudo bash scripts/monitoring/install_ops_agent.sh` — restarts ONLY the Ops Agent, never the call path. (On `services`, optional second run `--with-heplify-prom`.)
6. 🟢 If SMS used: verify the number in Console → Monitoring → Notification channels.
**Verify:** Metrics Explorer shows `agent.googleapis.com/disk/percent_used` for all 4 hosts; fire a real page test → `logger -p user.err -t revup-alert -- "test page — ignore"` on any VM → email/PagerDuty within ~2–5 min; 3 uptime checks green. (Do NOT stop a prod VM/agent to "test" VM-down.)

---

## Step 2 — Backups (4 layers)  (🟢 except one 🟠 restart)
From `/Users/keegan/revup/infra/backups` (workstation):
1. 🟢 Confirm the two lookups above; set tfvars only if defaults are wrong (bucket `revup-db-backups`, project/region/zone defaulted correct).
2. 🟢 `terraform init && terraform plan` → expect ~5 adds, 0 destroy. Any destroy → STOP.
3. 🟢 `terraform apply` → creates bucket `gs://revup-db-backups` + IAM (`storage.objectAdmin` on services SA) + daily snapshot policy attached to the disk. **Layer 4 (snapshots) armed now**, zero VM impact.

On the **services** VM:
4. 🟢 `cd /opt/revup && sudo git pull && sudo apt-get update && sudo apt-get install -y pgbackrest` (confirm version ≥ 2.38).
5. 🟢 `sudo /opt/revup/scripts/backup/preflight.sh` — **fix every FAIL first.** Most likely FAIL = VM access scopes (`devstorage.read_only`). If so, widen scopes with `gcloud compute instances set-service-account services --zone=us-east1-b --scopes=cloud-platform` — **this needs a VM stop/start (🟠 full new-call outage); fold it into the maintenance window in step 7.** (Or, no-restart fallback: an SA key file — worse posture.)
6. 🟢 `sudo /opt/revup/scripts/backup/setup_pgbackrest.sh` (stage 1) — installs conf, `ALTER SYSTEM` + reload. Stops before the restart if `archive_mode` was off.
7. 🟠 **[maintenance window]** `sudo systemctl restart postgresql@16-main` (~5–10s new-call outage). *If you did the scope stop/start in step 5, that already restarted PG — re-run preflight after boot and skip this.*
8. 🟢 `sudo /opt/revup/scripts/backup/setup_pgbackrest.sh` (stage 2) — creates `main` stanza + `pgbackrest check` (verifies a WAL lands in GCS). **Layer 2 WAL live.**
9. 🟢 `sudo -u postgres pgbackrest --stanza=main --type=full backup` — the PITR base (online, minutes).
10. 🟢 `sudo /opt/revup/scripts/backup/install_backup_timers.sh` — installs `/etc/revup/backup.env` (confirm `BACKUP_BUCKET=revup-db-backups`), units, enables timers. **Layers 1, 2-schedule, 3, slot-guard armed.**
11. 🟢 Smoke-test: `sudo systemctl start revup-pgdump.service && journalctl -u revup-pgdump.service -n 30 --no-pager` (layer 1); `sudo -u postgres /opt/revup/scripts/backup/cdr_archive_monthly.sh` (layer 3).
**Verify:** `systemctl list-timers 'revup-*'` shows pgdump / cdr-archive / slot-wal-guard / pgbackrest-full / pgbackrest-diff; `sudo -u postgres pgbackrest --stanza=main info` shows a full + archive range; `pg_stat_archiver.failed_count` not climbing.

---

## Step 3 — First restore drill  (🟢 on a THROWAWAY VM — never prod)
1. 🟢 Stand up a scratch `e2-standard-4` (us-east1-b); install PG16 + TimescaleDB (≥ prod minor) + pgbackrest. Grant its SA read on the bucket (`drill_reader_service_account` in backups tfvars → `terraform apply`, additive).
2. 🟢 Copy `/etc/pgbackrest/pgbackrest.conf` to the drill VM. Restore into a throwaway path + side port:
   `sudo -u postgres pgbackrest --stanza=main --pg1-path=/var/lib/postgresql/16/drill --type=time --target="<5 min ago UTC>" --target-action=promote restore` → start on `-p 5544`.
   (pgBackRest is *physical* — no `timescaledb_pre/post_restore()` needed. That dance is ONLY for the pg_dump logical path.)
3. 🟢 Verify on 5544: counts on customers/rcf_numbers, test DID +16174544217 intact, `max(start_time)` from cdrs.
4. 🟢 **Record RTO** (restore start → queries accepted) and **RPO** (`max(start_time)` vs now; target ≤ 5 min) in the drill-log table at the bottom of `docs/runbooks/DB_RESTORE_RUNBOOK.md` (currently empty). Drill the pg_dump logical path at least annually.
5. 🔴 (drill VM only) tear down the scratch VM. Prod untouched.

---

## Step 4 — Close the call-quality alerting gap  (🟢 no new infra)
The paging layer defends *reachability*, not *call quality* — **ASR/PDD/MOS don't page today** (the flagship SLO's real risk). Closed by `scripts/backup/asr_guard.sh` + `scripts/backup/systemd/revup-asr-guard.{service,timer}`, which mirror the existing `slot_wal_guard.sh` pattern: every ~10 min, query trailing-15-min inbound ASR from `cdrs`; if volume ≥ `ASR_GUARD_MIN_VOLUME` (default 20) and ASR < `ASR_GUARD_ASR_FLOOR` (default 50) percent, emit a `revup-alert` syslog line → lands on the CRITICAL log-match policy already provisioned in Step 1. `install_backup_timers.sh` (Step 2.10) installs + enables `revup-asr-guard.timer` alongside the other guards — zero Terraform change. **Verify:** `systemctl list-timers 'revup-*'` lists `revup-asr-guard`; force a run with `sudo systemctl start revup-asr-guard.service && journalctl -u revup-asr-guard.service -n 20 --no-pager` (expect an `asr-guard:` info line). (PDD needs FS to persist it per-CDR first; MOS can get the same treatment after ASR proves the pattern.)

---

## Done when
- Uptime/VM/disk/mem/CPU alerts live + a test page delivered; ✅ all 4 layers armed; ✅ one restore drill with RTO/RPO logged; ✅ ASR guard paging. Then Phase 0 is complete → proceed to Phase 1 (East DB hot standby).
