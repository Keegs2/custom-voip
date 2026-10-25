# Voicemail outage resilience: deploy, verify and rotate the spool key

This is the ordered command list for the owner. Every command is one line. Run them in order, on the machine named in **bold**. Design and threat model: `docs/VOICEMAIL_OUTAGE_RESILIENCE.md`.

**What ships:**
- **Migration 58:** the view `vm_fs_mailbox`.
- **API:** `POST /v1/voicemail/fs/deposit-sealed` and the env `VOICEMAIL_SPOOL_PRIVATE_KEY_B64`.
- **FreeSWITCH Lua** (bind-mounted, live on `git pull`): the zone-replica mailbox check and seal-to-spool.
- **Media compose:**
  - the `vm_spool` volume;
  - the `vm-forwarder` container;
  - the IVR runtime's `IVR_ENABLED` (default off) and `ivr_prompts` volume.
- **vmagent:** the `vm_forwarder` scrape job.
- **SBCs:** no changes.

**Order:** services VM (key, `.env`, 58, API), then the 6 FS nodes, FS-2 first in each zone, then the live check.

**Each step is safe on its own:**
- **The Lua before 58:** it uses today's defaults.
- **FS before the API:** sealed messages wait in the spool and are delivered once the API is ready.
- **A node without the certificate:** today's behaviour (a message left during an outage is lost).

**Downtime:**
- The API rebuild restarts the API for a few seconds.
- Each FS recreate drops the live calls on that node. It is needed once, to mount the two new volumes. Do it in the window.
- `vm-forwarder` and the vmagent reload touch no calls.

---

## 0. Prerequisites

1. The PR is merged into `RCF-V1` in the GitHub UI ("Create a merge commit").
2. Encrypted voicemail v1 is live. `INGEST_SHARED_SECRET` is in the services `.env`, and every FS node has `/opt/revup/secrets/fs-voicemail/vm_ingest.header` (`docs/runbooks/VOICEMAIL_DEPLOY_RUNBOOK.md`).

## 1. Services VM (`services`, East)

1. **services** `cd /opt/revup && sudo git pull` → fast-forward to the merged RCF-V1 commit.
2. **services** `sudo install -d -m 0700 -o root -g root /opt/revup/secrets/vm-spool && echo OK` → `OK`
3. **services** Generate the spool keypair on the VM. The private key never leaves it.
   `sudo sh -c 'umask 077; test ! -e /opt/revup/secrets/vm-spool/spool_key_1.pem && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /opt/revup/secrets/vm-spool/spool_key_1.pem && echo KEY-OK'`
   → `KEY-OK`. No output means the key already exists. Do not overwrite it: messages may be sealed to it.
4. **services** `sudo openssl req -new -x509 -key /opt/revup/secrets/vm-spool/spool_key_1.pem -subj "/CN=crag-vm-spool-1" -days 3650 -out /opt/revup/secrets/vm-spool/spool_cert_1.pem && echo CERT-OK` → `CERT-OK`
5. **services** `sudo openssl x509 -in /opt/revup/secrets/vm-spool/spool_cert_1.pem -noout -subject -enddate -ext subjectKeyIdentifier`
   → `subject=CN = crag-vm-spool-1`, `notAfter=` about 10 years out, and a `Subject Key Identifier` line `XX:XX:…` (20 bytes).
   - Write the SKI down: steps 1.12 and 2.2 compare against it.
   - No SKI line means this openssl did not add one. Stop and tell Claude: FreeSWITCH seals with `-keyid`.
6. **services** `sudo grep -c '^VOICEMAIL_SPOOL_PRIVATE_KEY_B64=' /opt/revup/.env` → `0`. If it is `1`, the line already exists: go to step 8.
7. **services** `sudo sh -c 'printf "VOICEMAIL_SPOOL_PRIVATE_KEY_B64=%s\n" "$(base64 -w0 /opt/revup/secrets/vm-spool/spool_key_1.pem)" >> /opt/revup/.env' && echo OK` → `OK`. The key goes straight from the file into `.env`, never through your clipboard or shell history.
8. **services** `sudo grep -c '^VOICEMAIL_SPOOL_PRIVATE_KEY_B64=LS0t' /opt/revup/.env` → `1`. `LS0t` is base64 for `---`, the start of the PEM.
9. **services** Apply migration 58 on the primary:
   `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/58_vm_outage_resilience.sql`
   → ends with `COMMIT`. It is idempotent: if it stops with `lock timeout`, run it again.
10. **services** `sudo -u postgres psql -d voip -Atc "SELECT has_table_privilege('freeswitch','vm_fs_mailbox','SELECT'), has_table_privilege('grafana_ro','vm_fs_mailbox','SELECT'), (SELECT count(*) FROM vm_fs_mailbox)"`
    → `t|f|<number of live mailboxes>`.
11. **services** `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build api` → `Started`.
12. **services** `sudo docker exec voip-api python -c "from services.voicemail import spool_crypto as s; k=s.load_spool_keys(); print(len(k), k[0].bits, k[0].ski.hex(':').upper())"`
    → `1 3072 <the SKI from step 5>`. An error naming `VOICEMAIL_SPOOL_PRIVATE_KEY_B64` means the env did not reach the container: recheck steps 7–8, then repeat step 11.
13. **services** `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8088/v1/voicemail/fs/deposit-sealed` → `401`, because the route exists and wants the ingest secret. `404` means the old build is still running.
14. **services** Print the PUBLIC certificate as one line for the FS nodes, and its checksum:
    `sudo base64 -w0 /opt/revup/secrets/vm-spool/spool_cert_1.pem; echo; sudo sha256sum /opt/revup/secrets/vm-spool/spool_cert_1.pem`
    → one long line starting `LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t`, then a checksum line. The certificate is public, so copying it is fine. Never copy the key.

## 2. FreeSWITCH nodes (all 6, in the window, FS-2 first per zone)

The nodes, in order:
1. `east-fs-2`
2. `fs-media-v2`
3. `west-fs-2`
4. `west-fs`
5. `central-fs-2`
6. `central-fs`

Per node:
1. `echo '<the base64 line from 1.14>' | base64 -d | sudo tee /opt/revup/secrets/fs-voicemail/vm_spool_recipients.pem >/dev/null && sudo chmod 0644 /opt/revup/secrets/fs-voicemail/vm_spool_recipients.pem && echo OK` → `OK`
2. `sudo sha256sum /opt/revup/secrets/fs-voicemail/vm_spool_recipients.pem` → the same checksum as 1.14.
3. `cd /opt/revup && sudo git pull` → fast-forward.
4. `cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d freeswitch` → `Recreated`.
   - This mounts `vm_spool` and `ivr_prompts`, and drops this node's calls.
   - If ports stay held: `sudo killall -9 freeswitch`, then repeat this step.
5. `cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d --no-deps --build vm-forwarder` → `Started`. It is a small stdlib image and builds in seconds.
6. `sudo docker kill -s HUP voip-vmagent` → `voip-vmagent`. vmagent reloads `scrape-media.yml` and picks up the new `vm_forwarder` job.
7. Wait about 45 s, then:
   `sudo docker exec voip-freeswitch sh -c 'grep -cE " /var/lib/crag/(vm-spool|ivr-prompts) " /proc/self/mounts; echo "IVR_ENABLED=$IVR_ENABLED"'` → `2`, then `IVR_ENABLED=false`.
8. `sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "lua lib/vm_spool.lua selftest"'`
   → `vm_spool selftest OK: spool mounted, sealed to 1 recipient(s), spool 0 KiB used, <n> KiB free`. Any `FAIL:` names the problem:
   - `spool NOT mounted`: repeat step 4.
   - `recipients file ... missing`: repeat step 1.
9. `sudo docker inspect -f '{{.State.Health.Status}}' voip-vm-forwarder` → `healthy`. It needs about 30 s after step 5.
10. `curl -s http://127.0.0.1:9105/metrics | grep '^vm_spool_messages'` → `vm_spool_messages{state="pending"} 0` and `vm_spool_messages{state="rejected"} 0`.
11. Test call: `+16174544217` rings `+17744045256` and connects (RCF is unaffected on this node).

## 3. Live check (once, after all 6 nodes)

1. Leave a voicemail on any test mailbox DID. It appears in the portal within seconds, the normal path.
2. **the FS node that took the call:** `sudo docker logs voip-freeswitch 2>&1 | grep 'voicemail done' | tail -1` → `result=stored`.
3. **every FS node:** `sudo docker exec voip-vm-forwarder sh -c 'ls -A /var/lib/crag/vm-spool'` → only `audit` and `rejected`. No `.cms` file means nothing is waiting.
4. Optional dashboard tile, with no alert: `sum by (zone, reporting_instance) (vm_spool_messages{state="pending"})` and `max by (zone) (vm_spool_oldest_age_seconds)`.

The outage path itself (API stopped, then replica fallback, seal, restart, delivery with the original time) was proven in the local E2E (`docs/VOICEMAIL_OUTAGE_RESILIENCE.md` §9). No East outage is staged in production.

## 4. During and after an East outage (reference)

- **FS log, outage path:** `sudo docker logs voip-freeswitch 2>&1 | grep -E 'zone replica|SEALED to the spool|could not seal'`.
  - `SEALED` means the message is safe in the spool.
  - `could not seal ... message lost` names why. Fix it with §2 steps 1, 4 or 8.
- **Spool depth on a node:** `curl -s http://127.0.0.1:9105/metrics | grep -E '^vm_spool_(messages|oldest_age_seconds)'`.
- **After East returns:** the forwarder sees it within about 10 s and drains oldest first: `sudo docker logs voip-vm-forwarder 2>&1 | grep -E 'reachable again|delivered' | tail`.
- **Drops and rejects journal** (no caller data): `sudo docker exec voip-vm-forwarder tail -20 /var/lib/crag/vm-spool/audit/spool-audit.jsonl`.
- **API-side drops** (mailbox deleted, full, suspended):
  `sudo -u postgres psql -d voip -Atc "SELECT created_at, mailbox_id, detail->>'reason' FROM voicemail_access_log WHERE action='spool_drop' ORDER BY id DESC LIMIT 20"` on **services**.

## 5. Rollback

1. Leave the key in `.env`; the old API ignores it.
2. **every FS node:** check the spool is empty first (§3 step 3). A sealed file left behind is delivered only by a forwarder and a new API.
3. Revert the PR in GitHub, then on each node: `cd /opt/revup && sudo git pull && sudo docker compose -f docker-compose.media.yml stop vm-forwarder`. The Lua reverts at once (bind mount). The volumes stay and are harmless.
4. **services** (optional) `sudo -u postgres psql -d voip -c "DROP VIEW IF EXISTS vm_fs_mailbox;"`

## 6. Key rotation (any time; no message is ever stranded)

The API opens a blob sealed to any key in its bundle, so the API always learns the new key **first**.

1. **services** `sudo sh -c 'umask 077; test ! -e /opt/revup/secrets/vm-spool/spool_key_2.pem && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /opt/revup/secrets/vm-spool/spool_key_2.pem && echo KEY-OK'` → `KEY-OK`
2. **services** `sudo openssl req -new -x509 -key /opt/revup/secrets/vm-spool/spool_key_2.pem -subj "/CN=crag-vm-spool-2" -days 3650 -out /opt/revup/secrets/vm-spool/spool_cert_2.pem && echo CERT-OK` → `CERT-OK`
3. **services** Put both keys in the API (old + new):
   `sudo sh -c 'B=$(cat /opt/revup/secrets/vm-spool/spool_key_1.pem /opt/revup/secrets/vm-spool/spool_key_2.pem | base64 -w0); sed -i "s|^VOICEMAIL_SPOOL_PRIVATE_KEY_B64=.*|VOICEMAIL_SPOOL_PRIVATE_KEY_B64=$B|" /opt/revup/.env' && echo OK` → `OK`
4. **services** `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d api` → `Recreated`.
5. **services** `sudo docker exec voip-api python -c "from services.voicemail import spool_crypto as s; print([x.ski.hex(':').upper() for x in s.load_spool_keys()])"` → two SKIs: the old one and `spool_cert_2`'s.
6. **services** `sudo base64 -w0 /opt/revup/secrets/vm-spool/spool_cert_2.pem; echo; sudo sha256sum /opt/revup/secrets/vm-spool/spool_cert_2.pem` → the new certificate as one line, plus its checksum.
7. **every FS node** Seal to the new certificate from now on:
   `echo '<line from 6>' | base64 -d | sudo tee /opt/revup/secrets/fs-voicemail/vm_spool_recipients.pem >/dev/null && sudo sha256sum /opt/revup/secrets/fs-voicemail/vm_spool_recipients.pem`
   → the checksum from step 6. FreeSWITCH reads the file on every seal, so no restart is needed.
8. **every FS node** `sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "lua lib/vm_spool.lua selftest"'` → `... OK ...`
9. **every FS node** Wait until nothing sealed to the old key remains:
   `sudo docker exec voip-vm-forwarder sh -c 'ls /var/lib/crag/vm-spool/*.cms 2>/dev/null | wc -l'` → `0` on all 6. With no outage since step 7 it already is.
10. **services** Drop the old key from the API:
    `sudo sh -c 'B=$(base64 -w0 /opt/revup/secrets/vm-spool/spool_key_2.pem); sed -i "s|^VOICEMAIL_SPOOL_PRIVATE_KEY_B64=.*|VOICEMAIL_SPOOL_PRIVATE_KEY_B64=$B|" /opt/revup/.env' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d api` → `Recreated`.
11. **services** Repeat step 5 → one SKI, `spool_cert_2`'s.
12. **services** `sudo shred -u /opt/revup/secrets/vm-spool/spool_key_1.pem && echo OK` → `OK`

If a blob sealed to a key the API no longer holds ever arrives, the API answers `503` and the file stays in the spool. It is never discarded as "bad". The API log names the case: `not sealed to any configured spool key`. Put the old key back in the bundle (step 3) to deliver it.
