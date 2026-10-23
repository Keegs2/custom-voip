# Maintenance: merge and deploy every open PR (#144, #145, #147, #148, voicemail)

One window gets everything from GitHub onto the VMs and puts the Sinch redundant trunks in place. Every command is one line. Run them in order, on the machine named in **bold**.

| PR | What | Where it runs |
|---|---|---|
| #144 | Sinch redundant LD/8YY termination trunks (migration 53), TF ingress check back on | services (migration, API, Grafana), all 6 SBCs, FS `git pull` |
| #145 | UI clears its query cache on login/logout (cross-tenant dashboard fix) | services (`ui`) |
| #147 | GitHub Actions CI; CDR-ingest log fix | services (`api`), GitHub settings |
| #148 | CRAG Ops alert prerequisites: `journalctl` in the ops agent, slot-WAL guard paging | services, media and SBC ops agents; `tofu apply` later |
| voicemail | Encrypted voicemail v1 (migration 54) | services (migration, `api`, `ui`); FS `git pull`. Activation is §5, after GCP |
| #146 | Voicemail plan doc | Close it: its commit is inside the voicemail PR |

**Checked before this window (2026-10-23).** On a fresh copy of RCF-V1 at 8b9fa40, the six branches merge with no conflicts in the order of §0. The merged tree is `ce50f70`, and in it:
- **CI:** #147's own CI job, run on Ubuntu 24.04 with Python 3.12, PostgreSQL 16 and Lua 5.3 (the production FreeSWITCH Lua version):
  - pytest: 1127 passed, 0 skipped.
  - All 3 Lua harnesses pass, and `luac5.3 -p` is clean on all 17 FS Lua files.
  - The vmalert-pager tests pass.
- **UI build:** `npm ci && npm run build` on Node 20 passes.
- **Migrations:** on the production Postgres/TimescaleDB image, 01–52, then 53, 54, 53, 54 all applied cleanly. `check_migrations.sql` reports 22–54 all applied.
- **SBCs:** no other PR touches Kamailio, so #144's own Kamailio checks still hold.

**The voicemail code is inert until §5:**
- The API checks whether the voicemail tables exist. Its voicemail endpoints return 503 until GCP and the secrets exist.
- FreeSWITCH reads only the routing view, which has no voicemail rows until an admin creates a mailbox.
- Admins see the Visual Voicemail page now. "New mailbox" fails until §5 is done.

**Downtime**
- **API rebuild:** a few seconds. FS CDR posts retry.
- **Each SBC-1 recreate:** fails the zone over to SBC-2 (about 10–12 s) and back. Established calls survive; setups in flight during the flip are lost.
- **FreeSWITCH:** not recreated in §1–§4. On the media VMs, only name a service; a bare `up -d` would recreate FreeSWITCH (§3).

---

## 0. GitHub: merge in this order ("Create a merge commit")

1. #144 (Sinch)
2. #145
3. #147
4. #148
5. The voicemail PR. It already contains #144, so it merges clean after it.
6. Close #146 with a comment pointing to the voicemail PR.

## 1. Services VM (`services`, East)

1. **services** `cd /opt/revup && git rev-parse --short HEAD` → write it down. This is the rollback point.
2. **services** `cd /opt/revup && sudo git pull` → fast-forward to the new RCF-V1 merge commit.
3. **services** Migration 53 (Sinch):
   `sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/53_sinch_redundant_termination.sql` → no `ERROR`.
4. **services** Migration 54 (voicemail):
   `sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/54_voicemail.sql` → ends with `COMMIT`.
   - On `canceling statement due to lock timeout`, run it again. It is idempotent.
5. **services** `sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql` → every row `applied`, including 53 and 54.
6. **services** `sudo -u postgres psql -d voip -Atc "SELECT application_name, state FROM pg_stat_replication"` → every replica `streaming`. The replicas carry 53/54 to all zones.
7. **services** `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build api ui` → both `Started`.
   - This brings in #144's API, #145's UI, #147's CDR fix and the voicemail API/UI.
   - The API build is a few minutes longer than usual because the Google KMS/GCS libraries are new.
8. **services** `cd /opt/revup && sudo docker compose -f docker-compose.services.yml restart grafana heplify-server` (#144).
9. **services** `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --no-deps --build ops-agent` (#148).
10. **services** `sudo /opt/revup/scripts/backup/install_backup_timers.sh` (#148: installs the slot-WAL guard unit).
11. **services** Checks:
    - `curl -s http://127.0.0.1:8088/health` → `"database":"ok"`.
    - `sudo docker exec voip-ops-agent journalctl -u revup-asr-guard -n 5 --no-pager` → recent guard lines, not "unavailable".
    - `sudo -u postgres psql -d voip -Atc "SELECT duid, status, trunk_enabled FROM carrier_trunk_health ORDER BY 1"` → the two new duids, with `trunk_enabled` = `f`.
12. **Portal** (#145):
    - Log in as admin and open the dashboard, then log out.
    - Log in as a customer and confirm the dashboard shows only that customer's numbers.
    - The NOC map shows the two new Sinch trunks grey, not red.

## 2. SBCs (all 6), standby first, zone by zone

Order:
1. `kam-g2`
2. `poc-custom-voip`
3. `west-sbc-2`
4. `west-sbc-1`
5. `central-sbc-2`
6. `central-sbc-1`

Per SBC:
1. `grep -n '^TF_' /opt/revup/.env` → `TF_INGRESS_ENFORCE=off`.
2. `sudo sed -i 's/^TF_INGRESS_ENFORCE=off$/TF_TEST_TNS=5595335873,5595335908/' /opt/revup/.env && grep -n '^TF_' /opt/revup/.env` → only the `TF_TEST_TNS=…` line.
3. `cd /opt/revup && sudo git pull && sudo docker compose -f docker-compose.sbc.yml up -d --build --force-recreate kamailio carrier-monitor`
   → both `Recreated`. This covers #144's Kamailio and #148's ops agent.
4. Wait about 20 s, then:
   `sudo docker logs voip-kamailio 2>&1 | grep -E 'config file ok|TF_INGRESS_ENFORCE=on, TF_TEST_TNS=5595335873,5595335908'` → both lines.
5. After both SBCs of a zone are done, make two test calls:
   - `+16174544217` rings `+17744045256` (RCF).
   - The ATL test number `5595335873` connects.

## 3. Media VMs (all 6), FS-2 first per zone

Order:
1. `east-fs-2`
2. `fs-media-v2`
3. `west-fs-2`
4. `west-fs`
5. `central-fs-2`
6. `central-fs`

Per node:
1. `cd /opt/revup && sudo git pull`
   - FS re-reads the Lua on every call, so #144's trunk selection is live immediately. The voicemail Lua is inert.
2. `cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d --no-deps --build ops-agent` (#148).
   - This does NOT recreate FreeSWITCH. Don't run `up -d` without a service name here: FreeSWITCH's compose settings changed (voicemail RAM disk, secret mount), so a bare `up -d` would recreate it and drop the node's calls. That recreate belongs to §5.
3. After each zone, make one test call: `+16174544217` rings `+17744045256`.

## 4. Sinch redundant trunks online

Do this once Sinch confirms that both redundant trunks are built.
- `trunk_group` is a label only; nothing on the call path reads it. Leave it as `NULL` if Sinch hasn't sent the IDs.
- The rows start disabled. Enabling one takes effect on FS within 60 s (trunk cache) and on Kamailio on the next call. Nothing is redeployed.

1. **services** `sudo -u postgres psql -d voip -c "UPDATE carrier_trunks SET enabled = true, trunk_group = '<DENVER_LD_TG>', updated_at = now() WHERE carrier = 'sinch' AND pop = 'denver-ld'"` → `UPDATE 1`
2. **services** `sudo -u postgres psql -d voip -c "UPDATE carrier_trunks SET enabled = true, trunk_group = '<ATLANTA_TF_TG>', updated_at = now() WHERE carrier = 'sinch' AND pop = 'atlanta-tf'"` → `UPDATE 1`
3. **services** `sudo -u postgres psql -d voip -c "UPDATE carrier_gateways SET enabled = true, updated_at = now() WHERE gateway_name IN ('sinch_denver_ld','sinch_atlanta_tf')"` → `UPDATE 2`
4. **services** `sudo -u postgres psql -d voip -Atc "SELECT pop, host(source_ip), direction, traffic_class, enabled, priority FROM carrier_trunks WHERE carrier='sinch' ORDER BY priority, pop"`
   → `denver-ld` and `atlanta-tf` show `t`.
   - LD order: Bandwidth 10/20, `atlanta-ld` 30, `denver-ld` 35.
   - 8YY order: `denver-tf` 40, `atlanta-tf` 45.
5. **services** About 2 minutes later: `sudo -u postgres psql -d voip -Atc "SELECT duid, status, trunk_enabled FROM carrier_trunk_health WHERE duid LIKE 'sinch%' ORDER BY 1"`
   → the two new duids `up` with `t`. If a duid stays `down`, Sinch isn't answering our OPTIONS on that trunk yet: send them the SBC public IPs.
6. **Optional: one test call per new trunk.** They are backups, so normal calls only reach them on failover. To force one:
   - Move it to the front in every zone. **Every call of that class uses it until you restore it.**
   - Place one call, then restore.
   - In Homer, confirm two things: the INVITE left from the SBC's public IP (not the VIP), and Sinch answered our BYE with `200`.

   **denver-ld (LD).** Call `+16174544217`:
   - Front: `sudo -u postgres psql -d voip -c "UPDATE carrier_trunks SET priority_east=1, priority_west=1, priority_central=1 WHERE carrier='sinch' AND pop='denver-ld'"`
   - Restore: `sudo -u postgres psql -d voip -c "UPDATE carrier_trunks SET priority_east=35, priority_west=35, priority_central=35 WHERE carrier='sinch' AND pop='denver-ld'"`

   **atlanta-tf (8YY).** Call an RCF test number whose forward is an 8YY number:
   - Front: `sudo -u postgres psql -d voip -c "UPDATE carrier_trunks SET priority_east=1, priority_west=1, priority_central=1 WHERE carrier='sinch' AND pop='atlanta-tf'"`
   - Restore: `sudo -u postgres psql -d voip -c "UPDATE carrier_trunks SET priority_east=45, priority_west=45, priority_central=45 WHERE carrier='sinch' AND pop='atlanta-tf'"`

   Wait 60 s after each change for the FS trunk cache.
7. **Take a trunk out instantly** if it misbehaves: `sudo -u postgres psql -d voip -c "UPDATE carrier_trunks SET enabled = false, updated_at = now() WHERE carrier = 'sinch' AND pop = '<pop>'"`

## 5. Voicemail activation (after the GCP setup; same window or later)

1. **GCP (owner):** `docs/runbooks/VOICEMAIL_GCP_SETUP.md`.
2. **services:** `docs/runbooks/VOICEMAIL_DEPLOY_RUNBOOK.md` §1, steps 2–6, which add the `.env` lines and generate the two secrets on the VM.
   - Skip steps 1 and 7–9: the pull and migration 54 were done in §1 above.
   - Then `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d api`, which recreates the API with the new `.env`.
   - Then that runbook's steps 11–14.
3. **FS nodes:** the deploy runbook's §2, per node, in its order. Skip step 4; the pull was done in §3 above.
   - Its step 5 is the FreeSWITCH recreate, which drops that node's calls.
4. **Live test:** the deploy runbook's §3.

## 6. After the window (no downtime)

- **#148 (owner, GCP):** in `infra/monitoring`, set `pubsub_notification_channel_ids` in `terraform.tfvars` to the console-made channel's full resource name **first**. Then `tofu plan`: expect label, filter and rate-limit changes and the channel attached, with no policy deleted. Then `tofu apply`.
- **#147 (GitHub settings):**
  - Make `api-tests` and `ui-build` required checks on RCF-V1.
  - Set Actions workflow permissions to a read-only `GITHUB_TOKEN`.
  - Require approval for workflows from outside contributors.
- **Equinox:** skip `product_type=voicemail` before the first voicemail CDR is exported.
- **Sinch:** when Sinch's real toll-free numbers are live, delete the `TF_TEST_TNS` line on each SBC (standby first), run `up -d --force-recreate kamailio`, and disable the two test `rcf_numbers` rows.

## 7. Rollback

Roll back only what misbehaves; the pieces are independent.

- **SBC (TF check):** put `TF_INGRESS_ENFORCE=off` back in place of the `TF_TEST_TNS` line in `.env`, then `cd /opt/revup && sudo docker compose -f docker-compose.sbc.yml up -d --force-recreate kamailio`.
- **A Sinch trunk:** §4 step 7.
- **API/UI:** `cd /opt/revup && sudo git checkout <rollback sha> -- docker/api docker/ui && sudo docker compose -f docker-compose.services.yml up -d --build api ui`. Once fixed, return with `sudo git checkout RCF-V1 -- docker/api docker/ui`.
- **FS Lua:** `cd /opt/revup && sudo git checkout <rollback sha> -- docker/freeswitch/scripts` on that node. It takes effect on the next call.
- **Migrations 53/54:** none needed. Both are additive, and the new trunk rows stay disabled until §4.
