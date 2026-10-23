# Sinch toll-free origination — maintenance runbook (PR feat/sinch-tf-origination)

Runs in the SAME window as #136 / #137 / #138 (`docs/runbooks/PR_COMPLETION_RUNBOOK_2026-10.md`, shipped in #138). This PR merges cleanly with all three in any order (trial-merged on RCF-V1 @ 47ae879).

## 0. Already done in prod (2026-10-14) — do NOT repeat
- GCP firewall `allow-sinch-sip` = 206.146.100.24, 206.146.101.39, 206.146.98.26, 206.146.100.26, **206.146.98.25, 206.146.100.25** (/32, udp/tcp 5060, tag `voip-sbc`). Media: `voip-rtp` is already 0.0.0.0/0.
- `carrier_trunks` rows 7 `sinch/atlanta-tf-orig` (206.146.98.25) and 8 `sinch/denver-tf-orig` (206.146.100.25): `inbound`, `tollfree`, cps 10.
- Rows 1-4 (bandwidth dallas/la, sinch denver/chicago) relabeled `traffic_class` `any` → `ld`. There are no `any` rows. 8YY termination is therefore `denver-tf` only, and has been since the relabel (live FS code already filters by class).
- 8YY DID check: 0 rows in rcf_numbers / api_dids / trunk_dids, so `TF_INGRESS_ENFORCE=on` cannot break a live number.

## 1. Merge (GitHub UI, "Create a merge commit")
#136 → #137 → #138 (per their runbook gates, incl. the #138 90d EXPLAIN gate) → this PR.

## 2. Services VM (`services`, East primary)
Run the #138 runbook §4 first: its `git pull` also pulls this PR, and its `api` rebuild ships this PR's `homer_pcap.py` alias. Then:
1. `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/52_sinch_tf_origination.sql`
   → `INSERT 0 0` (rows already exist), `CREATE VIEW`, `GRANT`, `GRANT`.
2. `sudo -u postgres psql -d voip -c "SELECT pop, status FROM carrier_trunk_health WHERE pop LIKE '%tf-orig'"`
   → 2 rows (`atlanta-tf-orig`, `denver-tf-orig`). They show as up/passive once traffic flows, never as down.
3. `hostname | grep -q '^services$' && sudo docker restart voip-heplify-server` (loads the new `ip-alias.lua` names; a few seconds of HEP gap).
4. Grafana reloads `noc-home.json` from disk by itself (file provider, about 10s). Check that the NOC home page shows the new "Sinch ATL TF" / "Sinch DEN TF" tiles.

## 3. FreeSWITCH — all 6 nodes (`fs-media-v2`, `east-fs-2`, `west-fs`, `west-fs-2`, `central-fs`, `central-fs-2`)
The scripts are bind-mounted and mod_lua reloads them per call, so this needs NO restart:
- `cd /opt/revup && sudo git pull`
- `sudo docker exec voip-freeswitch grep -c "term_class_blocked" /usr/local/freeswitch/scripts/inbound_router.lua` → `2` or more.

## 4. SBCs — one zone at a time, STANDBY first
Order: `kam-g2` → `poc-custom-voip` → `west-sbc-2` → `west-sbc-1` → `central-sbc-2` → `central-sbc-1`.
Restarting an SBC-1 flips its zone to the standby for about 10-12 s. Established calls survive; setups in flight during the flip are lost.
On each SBC:
1. `cd /opt/revup && sudo git pull && sudo docker compose -f docker-compose.sbc.yml up -d --build kamailio`
2. `sleep 20 && sudo docker exec voip-kamailio kamailio -c -f /etc/kamailio/kamailio.cfg 2>&1 | tail -3` → ends `config file ok, exiting...`
3. `sudo docker logs voip-kamailio 2>&1 | grep -o 'SINCH_TF_ATL=[^,]*, SINCH_TF_DEN=[^,]*, TF_INGRESS_ENFORCE=[a-z]*'`
   → `SINCH_TF_ATL=206.146.98.25, SINCH_TF_DEN=206.146.100.25, TF_INGRESS_ENFORCE=on`
4. SBC-1 only, after it is back up: `sudo docker logs --since 2m voip-kamailio 2>&1 | grep -ciE "ERROR|CRITICAL"` → about 0.

If step 2 fails: `cd /opt/revup && sudo git checkout HEAD~1 -- docker/kamailio && sudo docker compose -f docker-compose.sbc.yml up -d --build kamailio`, then stop and investigate. Do not continue to the next SBC.

## 5. Live checks
1. Call **+16174544217**. It should forward to +17744045256 as before (LD class → Bandwidth).
2. Sinch test numbers (sent by Sinch Translations): provision each as `+18YYNXXXXXX` in `rcf_numbers` (enabled, active customer). Call each one through both trunks (ATL and DEN). In the CDR expect `inbound_carrier=sinch` and `inbound_carrier_pop` = `atlanta-tf-orig` / `denver-tf-orig`.
3. Early check: when a TF RCF number forwards via Bandwidth, the B-leg carries the 8YY number in Diversion (and in From when pass-through is off). Confirm Bandwidth answers the B-leg rather than returning 403/603.
4. Negative check, optional: a Bandwidth-delivered call to an 8YY number should get a `404` with a `TF ingress: ... rule=8yy-on-non-tf-carrier` WARN in `sudo docker logs voip-kamailio`.

## Rollback
- Enforcement only: on each SBC, `echo 'TF_INGRESS_ENFORCE=off' | sudo tee -a /opt/revup/.env && cd /opt/revup && sudo docker compose -f docker-compose.sbc.yml up -d --force-recreate kamailio`. The entrypoint re-renders on start, and with the flag off the enforcement compiles out.
- Strict 8YY termination: re-enable or add a `tollfree` outbound trunk in TED. Relabeling Bandwidth to `any` does NOT make it eligible for 8YY (tollfree is strict by design).
- Full: `cd /opt/revup && sudo git checkout 47ae879 -- docker/kamailio docker/freeswitch/scripts && sudo docker compose -f docker-compose.sbc.yml up -d --build kamailio` (SBCs), FS needs only the checkout. Migration 52 needs no undo: rows + view are additive. After a partial-path checkout, re-attach before the next pull: `cd /opt/revup && sudo git checkout RCF-V1 -- docker/kamailio docker/freeswitch/scripts`.

## Follow-ups — addressed by `feat/sinch-redundant-term` (migration 53)
- Root `CLAUDE.md` Sinch section + `scripts/db/check_migrations.sql` now cover 52 and 53.
- Customer trunk / API outbound 8YY now uses the `tollfree` `carrier_trunks` rows (fail-closed, never Bandwidth); non-8YY unchanged.
- Second TF termination trunk: `sinch/atlanta-tf` (206.146.98.25, priority 45) plus a second LD trunk `sinch/denver-ld` (206.146.100.25, priority 35), seeded `enabled=false` until Sinch confirms the build. They share the .25 IPs with the TF orig rows, which is why 53 replaces UNIQUE(source_ip) with per-direction partial unique indexes.
- `TF_INGRESS_ENFORCE=off` in the SBC `.env` files is replaced by `TF_TEST_TNS=5595335873,5595335908`.
