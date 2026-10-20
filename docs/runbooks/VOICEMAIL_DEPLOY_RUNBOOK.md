# Encrypted voicemail v1: deploy and first live test

This is the ordered command list for the owner. GCP setup comes first and is in `docs/runbooks/VOICEMAIL_GCP_SETUP.md`. This runbook starts once GCP is done. Every command is one line. Run them in order, on the machine named in **bold**.

What ships:
- **Migration 54:** the voicemail tables plus the `voicemail` arm of `number_routing`.
- **API:** `/v1/voicemail/*` and the retention worker.
- **UI:** the `/voicemail` page and the admin "New mailbox" flow.
- **FreeSWITCH:** the Lua voicemail path, prompts, the RAM recording tmpfs, `core 0`, and the secret directory mount.
- **SBCs:** no changes.

**Order matters:** GCP → services VM (secrets, migration, API/UI) → the 6 FS nodes → test.
- Before migration 54 is applied, the FS voicemail code is inert: the `number_routing` arm returns 0 rows.
- Before the FS secret file exists, a voicemail call plays "unavailable"; RCF and trunk calls are untouched.

**Downtime:**
- Rebuilding the services VM's `api` restarts the API for a few seconds. CDR posts from FS retry.
- Each FS recreate drops the live calls on that node. Do it in the window, FS-2 first in each zone.

---

## 0. Prerequisites (done once)

1. PR merged into `RCF-V1` in the GitHub UI ("Create a merge commit").
2. `docs/runbooks/VOICEMAIL_GCP_SETUP.md` §1–§5 done:
   - keyring `voicemail-prod`
   - bucket `voip-voicemail`
   - SA `vm-api` with option A (SA swap) or option B (impersonation)
   - audit logs on
3. Pick the test number: a DID that is in `did_inventory` with status `available` and already routes to us (any spare Bandwidth DID pointed at our VIPs). Write it down as `<VM_DID>`.

## 1. Services VM (`services`, East)

1. **services** `cd /opt/revup && sudo git pull` → fast-forward to the merged RCF-V1 commit.
2. **services** `sudo grep -c -E '^(VOICEMAIL_|INGEST_SHARED_SECRET)' /opt/revup/.env` → `0`. If it isn't 0, the lines already exist: edit them, don't append.
3. **services** `printf '%s\n' 'VOICEMAIL_KMS_PROVIDER=gcpkms' 'VOICEMAIL_KMS_PROJECT=rugged-night-193017' 'VOICEMAIL_KMS_LOCATION=us-east1' 'VOICEMAIL_KMS_KEYRING=voicemail-prod' 'VOICEMAIL_BUCKET=voip-voicemail' | sudo tee -a /opt/revup/.env >/dev/null && echo OK` → `OK`
4. **services** (option B only) `echo 'VOICEMAIL_IMPERSONATE_SA=vm-api@rugged-night-193017.iam.gserviceaccount.com' | sudo tee -a /opt/revup/.env >/dev/null && echo OK` → `OK`
5. **services** `printf 'INGEST_SHARED_SECRET=%s\nVOICEMAIL_PLAYBACK_SECRET=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" | sudo tee -a /opt/revup/.env >/dev/null && echo OK` → `OK`. Both secrets are generated on the VM and never pass through your clipboard or shell history.
6. **services** `sudo grep -c -E '^(VOICEMAIL_KMS_PROVIDER|VOICEMAIL_KMS_PROJECT|VOICEMAIL_KMS_LOCATION|VOICEMAIL_KMS_KEYRING|VOICEMAIL_BUCKET|INGEST_SHARED_SECRET|VOICEMAIL_PLAYBACK_SECRET)=' /opt/revup/.env` → `7`.
7. **services** Apply migration 54 on the primary:
   `sudo -u postgres psql -d voip -v ON_ERROR_STOP=1 -f /opt/revup/docker/postgres/init/54_voicemail.sql`
   → ends with `COMMIT`.
   - It sets `lock_timeout 5s` because it briefly locks `customers` and the routing view, so it fails fast rather than queueing calls.
   - If it stops with `canceling statement due to lock timeout`, run it again. It is idempotent; running it twice is verified.
8. **services** `sudo -u postgres psql -d voip -Atc "SELECT count(*) FROM number_routing WHERE product_type='voicemail'"` → `0`.
9. **services** Check the replicas got it (replication carries it to all zones):
   `sudo -u postgres psql -d voip -Atc "SELECT application_name, state, replay_lag FROM pg_stat_replication"`
   → every replica `streaming`.
10. **services** `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build api ui`
    → both `Started`. The API image build takes a few minutes longer than usual: the Google KMS/GCS libraries are new.
11. **services** `curl -s http://127.0.0.1:8088/health` → `"database":"ok"`.
12. **services** `curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Ingest-Secret: wrong-wrong-wrong-wrong-wrong-wrong-xx' http://127.0.0.1:8088/v1/voicemail/fs/mailbox/1` → `401`. A `503` means `INGEST_SHARED_SECRET` didn't reach the container: recheck steps 5–6, then repeat step 10.
13. **services** `sudo docker exec voip-api sh -c 'mount | grep " /tmp "; ulimit -c'` → a `tmpfs on /tmp` line and `0`.
14. **services** Copy the ingest secret for the FS nodes. It prints one 64-hex value; paste it only into step 2.3 below:
    `sudo grep '^INGEST_SHARED_SECRET=' /opt/revup/.env | cut -d= -f2`

## 2. FreeSWITCH nodes (all 6, in the window, FS-2 first per zone)

The nodes, in order:
1. `east-fs-2`
2. `fs-media-v2`
3. `west-fs-2`
4. `west-fs`
5. `central-fs-2`
6. `central-fs`

Per node:
1. `sudo install -d -m 0700 -o root -g root /opt/revup/secrets/fs-voicemail && echo OK` → `OK`
2. `sudo sh -c 'umask 077; read -r S; printf "X-Ingest-Secret: %s\n" "$S" > /opt/revup/secrets/fs-voicemail/vm_ingest.header'`. The command waits for input: paste the secret from 1.14 and press Enter.
3. `sudo stat -c '%a %U:%G %s' /opt/revup/secrets/fs-voicemail/vm_ingest.header` → `600 root:root 82`. 82 bytes means the header line plus newline with a 64-hex secret.
4. `cd /opt/revup && sudo git pull` → fast-forward.
5. `cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d freeswitch`
   → `Recreated`. This drops this node's calls. If ports stay held: `sudo killall -9 freeswitch`, then repeat this step.
6. Wait about 45 s, then:
   `sudo docker exec voip-freeswitch sh -c 'grep " /dev/shm/vm " /proc/self/mounts; ulimit -c; test -r /run/revup/vm_ingest.header && echo header-ok'`
   → a `tmpfs /dev/shm/vm tmpfs rw,nosuid,nodev,noexec,...,size=524288k,mode=700` line, then `0`, then `header-ok`.
7. `sudo docker logs voip-freeswitch 2>&1 | grep 'Voicemail:'` → `tmpfs /dev/shm/vm mounted, swept` and `ingest header file present`.
8. Test call: `+16174544217` rings `+17744045256` and connects. This confirms RCF is unaffected on this node.

No FS image rebuild is needed: the Lua, prompts and compose changes are all bind-mounted or compose-level.

## 3. First live test

1. **Portal:** log in as admin → sidebar **Visual Voicemail** → **New mailbox**.
   - Pick the customer (or use View as Customer on it). Pick `<VM_DID>` from the number list, give it a name, and optionally set a PIN.
   - → mailbox created, status Active.
   - **What happens behind it:**
     - The DID becomes `assigned`/`voicemail`.
     - `customers.voicemail_enabled` becomes true.
     - The customer's KMS key `vm-cust-<id>` is created.
2. **Workstation** `gcloud kms keys list --keyring voicemail-prod --location us-east1 --project rugged-night-193017 --format='value(name)'` → one `.../cryptoKeys/vm-cust-<id>`.
3. **Portal:** Greeting & settings → **Add a greeting** → record about 5 s → Save and use it.
   - The greeting is encrypted, then stored in the bucket.
4. **Phone:** call `<VM_DID>` from a cell phone.
   - You hear your greeting, then a beep. Leave a 10–20 s message and hang up.
5. **Portal:** refresh `/voicemail` → the message is in Inbox with your caller ID.
   - Press **Play**: it plays, and it's marked read. Try **Download**, **Save**, **Delete**, then **Restore**.
6. **Workstation** `gcloud storage ls -l gs://voip-voicemail/c/ --recursive --project rugged-night-193017` → the greeting (`.../g/<uuid>.enc`) and the message (`.../m/<uuid>.enc`). Objects are ciphertext; there's no `.wav` anywhere.
7. **Workstation** `gcloud logging read 'logName="projects/rugged-night-193017/logs/cloudaudit.googleapis.com%2Fdata_access" AND protoPayload.serviceName="cloudkms.googleapis.com"' --project rugged-night-193017 --freshness=1h --limit=10 --format='table(timestamp,protoPayload.methodName,protoPayload.authenticationInfo.principalEmail)'`
   → `Encrypt` (deposit) and `Decrypt` (playback, greeting fetch) rows by `vm-api@…`.
8. **services** `sudo -u postgres psql -d voip -c "SELECT action, source, message_id, created_at FROM voicemail_access_log ORDER BY id DESC LIMIT 8"` → `key_create`, `mailbox_create`, `greeting_upload`, `greeting_fs_fetch`, `deposit`, and one `play` per play press.
9. **RAM check, on the FS node that took the call.** The CDR shows the node in `freeswitch_node`: `sudo -u postgres psql -d voip -Atc "SELECT freeswitch_node FROM cdrs WHERE product_type='voicemail' ORDER BY start_time DESC LIMIT 1"`.
   - On that node, run `sudo docker exec voip-freeswitch sh -c 'ls -A /dev/shm/vm | wc -l'` → `0`.
   - Then `sudo find / -xdev -name '*.wav' -newer /opt/revup/.git/FETCH_HEAD 2>/dev/null | grep -v /opt/revup/docker/freeswitch/scripts/sounds` → nothing.
10. **Optional on-net test (RCF → mailbox):**
    - Set an RCF number's forward to `<VM_DID>` in the portal, call the RCF number, and leave a message. It lands in the mailbox with no carrier leg. The CDR shows `on_net=true`, `product_type=voicemail`.
    - Then set the forward back. Don't use `+16174544217` unless you restore `+17744045256` right after.

## 4. Rollback

The steps are independent; roll back only what misbehaves.
- **UI/API:** `cd /opt/revup && sudo git checkout <previous RCF-V1 sha> -- docker/api docker/ui && sudo docker compose -f docker-compose.services.yml up -d --build api ui`, then `sudo git checkout RCF-V1 -- docker/api docker/ui` once fixed. The schema can stay: migration 54 is additive.
- **Voicemail calls only:** suspend the mailbox in the portal. The DID then rejects 603, and nothing else changes.
- **FS:** `sudo rm /opt/revup/secrets/fs-voicemail/vm_ingest.header`. Voicemail calls then play "unavailable"; RCF and trunk are untouched. No recreate needed.

## 5. Notes for the owner

- **Billing (D5):** voicemail calls rate to $0 in `rate_cdr()`. The Equinox CDR export still contains them, with `product_type=voicemail` and real `billed_seconds`, so Equinox must skip `product_type=voicemail` until voicemail pricing is decided.
- **CDR timing:** a voicemail CDR's end time includes the upload after hangup. That's normally under 1 s, and up to about 50 s if the API is down.
- **Prompts:** the default greeting and the "mailbox full" and "unavailable" prompts are robotic espeak-ng placeholders in `docker/freeswitch/scripts/sounds/vm/`. To replace one, use an 8 kHz mono 16-bit WAV with the same name, then `git pull`. No restart.
- **Retention:** messages auto-delete 90 days after arrival, and trash after 30 days. The worker runs every 15 min inside the API.
- **Customer delete:** deleting a customer that has, or ever had, voicemail returns 409. A crypto-erase keeps a key tombstone row.
