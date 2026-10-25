# Visual IVR + voicemail outage resilience: deploy runbook (2026-10-25)

This runbook deploys the five CRAG PRs (#157–#161) in one maintenance, turning the IVR call path on (`IVR_ENABLED=true`) in the same FreeSWITCH recreate. TED can ship any time after. The live test (P5, run by the owner) needs no maintenance window, and it can start right after the maintenance, with or without TED (§4). It ends with the test checklist.

- **Plan:** `docs/IVR_PRODUCT_PLAN.md`. **Contract:** `docs/IVR_INTERFACES.md`.
- **Voicemail detail** (key rotation, outage behaviour, rollback): `docs/runbooks/VOICEMAIL_OUTAGE_RESILIENCE_DEPLOY.md`. Its steps are folded in below.

Every command is one line and needs sudo. Run them in order, one at a time; the expected output follows each →. Restarts are fine in the maintenance window.

## 0. Merge order (GitHub UI, "Create a merge commit")

1. `feat/vm-outage-resilience` (voicemail survives an East outage; migration 58)
2. `feat/ivr-backend` (plan + contract, migrations 59/60, API, Piper `tts` sidecar)
3. `feat/ivr-runtime` (FreeSWITCH call engine, gate `IVR_ENABLED`, off by default)
4. `feat/ivr-portal` (the `/ivr` page + builder)
5. `fix/rcf-no-redial-after-noanswer-busy` (#161: RCF stops re-dialing a phone that was busy or rang out). It merges cleanly in any position; it is already merged into #3.

This order was test-merged clean on 2026-10-25.

`IVR_ENABLED=true` is set during this maintenance (§2 step 3), so FreeSWITCH is recreated only once. It is safe early: no IVR number exists yet, and a number answers only after it is assigned as IVR (TED or §4) **and** a flow is published to it. Nothing customer-visible changes until then.

## 1. Services VM (`services`, East)

### Pull, then create the voicemail spool key (once)
1. `cd /opt/revup && sudo git pull` → a fast-forward to the merge commit.
2. `sudo install -d -m 0700 -o root -g root /opt/revup/secrets/vm-spool && echo OK` → `OK`
3. `sudo sh -c 'umask 077; test ! -e /opt/revup/secrets/vm-spool/spool_key_1.pem && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /opt/revup/secrets/vm-spool/spool_key_1.pem && echo KEY-OK'` → `KEY-OK`
4. `sudo openssl req -new -x509 -key /opt/revup/secrets/vm-spool/spool_key_1.pem -subj "/CN=crag-vm-spool-1" -days 3650 -out /opt/revup/secrets/vm-spool/spool_cert_1.pem && echo CERT-OK` → `CERT-OK`
5. `sudo grep -c '^VOICEMAIL_SPOOL_PRIVATE_KEY_B64=' /opt/revup/.env` → `0`. If it prints `1`, skip step 6.
6. `sudo sh -c 'printf "VOICEMAIL_SPOOL_PRIVATE_KEY_B64=%s\n" "$(base64 -w0 /opt/revup/secrets/vm-spool/spool_key_1.pem)" >> /opt/revup/.env' && echo OK` → `OK`
7. `sudo grep -c '^VOICEMAIL_SPOOL_PRIVATE_KEY_B64=LS0t' /opt/revup/.env` → `1`

### Migrations (they replicate to every zone)
8. `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/58_vm_outage_resilience.sql` → `BEGIN … COMMIT`
9. `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/59_ivr.sql` → `BEGIN … COMMIT`
10. `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/60_cdr_ivr.sql` → `BEGIN … COMMIT`
11. `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql` → 58, 59 and 60 show as present.
12. `sudo -u postgres psql -d voip -Atc "SELECT has_table_privilege('freeswitch','vm_fs_mailbox','SELECT'), has_table_privilege('freeswitch','ivr_fs_number','SELECT'), has_table_privilege('freeswitch','call_flows','SELECT')"` → `t|t|f`

### API, TTS sidecar and UI
13. `cd /opt/revup && sudo docker compose -f docker-compose.services.yml build api tts ui` → three images built. The first `tts` build downloads the Piper voices, about 200 MB.
14. `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d tts api ui` → `Started` / `Recreated`.
15. `sudo docker logs voip-tts 2>&1 | grep listening` → `tts listening on :5000 with 3 voices (piper-tts==1.8.0)`
16. `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8088/v1/voicemail/fs/deposit-sealed` → `401` (the route exists; `404` means the old build is still running).
17. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8088/v1/ivr/summary` → `401` (the route exists and needs a login).
18. `sudo docker exec voip-api python -c "from services.voicemail import spool_crypto as s; k=s.load_spool_keys(); print(len(k), k[0].bits)"` → `1 3072`
19. `sudo base64 -w0 /opt/revup/secrets/vm-spool/spool_cert_1.pem; echo; sudo sha256sum /opt/revup/secrets/vm-spool/spool_cert_1.pem` → the PUBLIC certificate as one line, plus its checksum. Keep both for §2.

## 2. Every FreeSWITCH node (6 nodes, standby first in each zone)

The order is: `east-fs-2` → `fs-media-v2` → `west-fs-2` → `west-fs` → `central-fs-2` → `central-fs`.

Step 3 recreates FreeSWITCH and drops that node's calls (window).

1. `echo '<the one-line certificate from §1.19>' | base64 -d | sudo tee /opt/revup/secrets/fs-voicemail/vm_spool_recipients.pem >/dev/null && sudo chmod 0644 /opt/revup/secrets/fs-voicemail/vm_spool_recipients.pem && echo OK` → `OK`
2. `sudo sha256sum /opt/revup/secrets/fs-voicemail/vm_spool_recipients.pem` → the same checksum as §1.19.
3. `cd /opt/revup && sudo git pull && sudo sh -c 'grep -q "^IVR_ENABLED=" .env && sed -i "s/^IVR_ENABLED=.*/IVR_ENABLED=true/" .env || echo "IVR_ENABLED=true" >> .env' && grep '^IVR_ENABLED' .env && sudo docker compose -f docker-compose.media.yml up -d freeswitch` → a fast-forward, `IVR_ENABLED=true`, then `Recreated`. If ports stay held: `sudo killall -9 freeswitch`, then run `cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d freeswitch` again.
4. `cd /opt/revup && sudo docker compose -f docker-compose.media.yml up -d --no-deps --build vm-forwarder` → `Started`.
5. `sudo docker kill -s HUP voip-vmagent` → `voip-vmagent`
6. After about 45 s: `sudo docker exec voip-freeswitch sh -c 'grep -cE " /var/lib/crag/(vm-spool|ivr-prompts) " /proc/self/mounts; echo "IVR_ENABLED=$IVR_ENABLED"; ls /usr/local/freeswitch/scripts/sounds/ivr/'` → `2`, then `IVR_ENABLED=true`, then `goodbye.wav  technical_difficulty.wav`.
7. `sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "lua lib/vm_spool.lua selftest"'` → a line containing `OK`.
8. `sudo docker inspect -f '{{.State.Health.Status}}' voip-vm-forwarder` → `healthy`
9. `sudo docker logs --since 10m voip-freeswitch 2>&1 | grep -E "IVR DID lookup failed|vm_replica" | tail -3` → nothing.
10. Test call: `+16174544217` rings `+17744045256` and connects.
11. RCF no-redial (#161), checked once after the first zone: call `+16174544217` and let `+17744045256` ring out. It rings for one ring cycle only, the caller gets the carrier's no-answer treatment, and `sudo docker logs --since 5m voip-freeswitch 2>&1 | grep 'RCF far end'` → `RCF far end NO_ANSWER on attempt 1/…`.

After all six nodes, leave a voicemail on any test mailbox. It appears in the portal within seconds (the normal path). `sudo docker exec voip-vm-forwarder sh -c 'ls -A /var/lib/crag/vm-spool'` → only `audit` and `rejected`.

## 3. TED (`grteng/ted-next`)

Merge the TED PR (`feat/crag-ivr-admin`) after §1. Ship it the usual TED way: `tedos deploy request`, then staging, then production on the owner's OK. If TED reaches an older CRAG first, its Visual IVR section says "not available on this CRAG release".

## 4. P5 — the live test (owner)

### Set up
No maintenance window is needed: the call path was turned on in §2. Pick **one** of 1a / 1b.

1a. **With TED (after §3):** Customer 360 of the test customer → Visual IVR → **Turn on**. Then **Assign Number** with a spare DID routed to CRAG, as product IVR, named "IVR test".

1b. **Without TED (right after the maintenance)**, on **services**. These use the CRAG admin API directly; assigning a number as IVR also turns IVR on for that customer.
   1. Log in once. It prompts for the admin email and password, and keeps the token in a private file:
      `read -rp 'CRAG admin email: ' E && read -rsp 'password: ' P && echo && curl -s -X POST http://127.0.0.1:8088/v1/auth/login -H 'content-type: application/json' -d "{\"email\":\"$E\",\"password\":\"$P\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' > ~/crag_admin.tok; unset P; chmod 600 ~/crag_admin.tok; wc -c < ~/crag_admin.tok` → a number over 100. An error instead means the login failed.
   2. List spare DIDs:
      `curl -s "http://127.0.0.1:8088/v1/numbers/inventory?status=available&limit=50" -H "authorization: Bearer $(cat ~/crag_admin.tok)" | python3 -c 'import sys,json;d=json.load(sys.stdin);[print(i["did"], i.get("carrier") or "", i.get("state") or "") for i in (d.get("items", []) if isinstance(d, dict) else d)]'` → one DID per line. Pick one the carrier routes to CRAG.
   3. Assign it as IVR to the test customer. Granite Telephony is customer **11**; replace `+1NNNNNNNNNN` with the DID:
      `curl -s -X POST "http://127.0.0.1:8088/v1/numbers/+1NNNNNNNNNN/assign" -H "authorization: Bearer $(cat ~/crag_admin.tok)" -H 'content-type: application/json' -d '{"customer_id":11,"product_type":"ivr","name":"IVR test"}'` → `{"status":"assigned", … "product_type":"ivr", …}`
   4. When you're done with the API: `rm -f ~/crag_admin.tok`
2. **In the portal**, as that customer or View as Customer, open IVR → **New message**, three times:
   - "Welcome": "Thanks for calling."
   - "Menu": "For sales press 1. To leave a message press 2. To hear this again press 9."
   - "Goodbye"
3. **New flow** "IVR test":
   - Start → Play message (Welcome) → Menu (Menu; keys 1, 2, 9).
   - 1 → Transfer to *your* RCF test number `+16174544217`; caller's number shown; No answer → Voicemail (a test mailbox).
   - 2 → Voicemail.
   - 9 → Go to Menu.
   - No key / Wrong key → Hang up (Goodbye).
4. **Test call** in the builder: keys `9 1` → Welcome, Menu twice, then the transfer. Then **Publish**.
5. **IVR page** → the test number → **Choose a flow** → "IVR test". The number now reads "Live · version 1".

### The call path
It is already on in every zone (§2 step 3). The test number answers as soon as step 5 is done; the published version reaches every zone's replica within seconds.

### Calls to make (to the IVR test number)

| # | Do | Expect |
|---|---|---|
| 1 | Call, listen | "Thanks for calling", then the menu |
| 2 | Press 1 while the menu is still playing | The prompt stops immediately (barge-in); `+17744045256` rings showing YOUR number |
| 3 | Press 9 | The menu plays again |
| 4 | Press 5 (not an option) | The menu repeats; after the retries, Goodbye and hang up |
| 5 | Press nothing | After about 5 s the menu repeats; after the retries, Goodbye and hang up |
| 6 | Press 1, don't answer the forward | After the ring time, the test mailbox greeting; leave a message and it appears in Visual Voicemail |
| 7 | Press 2 | Straight to voicemail |
| 8 | In the builder, switch the transfer to "Show this IVR's number", publish, press 1 | The forward shows the IVR number |
| 9 | In the builder, add a Business hours block with closed hours now, publish, call | The closed route plays |
| 10 | In TED, **Switch Off** the number, call | The call is rejected; switch it back on |

### Check the records
- `sudo -u postgres psql -d voip -c "SELECT start_time, ivr_exit, ivr_path, ivr_transfer_to, ivr_seconds FROM cdrs WHERE product_type='ivr' ORDER BY start_time DESC LIMIT 10;"` (services) → one row per call, with the exits matching the table above.
- `grep -l '"product_type":"ivr"' /var/log/freeswitch/json_cdr/*.json 2>/dev/null | tail -1 | xargs grep -o '"rtp_use_timer_name":"[a-z]*"'` inside `voip-freeswitch` → `"rtp_use_timer_name":"soft"` on IVR calls only.
- Troubleshooting ladder for a transfer call: the forward leg went out like any RCF forward (same failover and STIR handling).

### Rollback (any time)
- **One number:** in TED, Switch Off. Or unassign it with `curl -s -X POST "http://127.0.0.1:8088/v1/numbers/+1NNNNNNNNNN/unassign" -H "authorization: Bearer $(cat ~/crag_admin.tok)"`; the customer's flows are kept.
- **One customer:** in TED, Turn Off (data kept).
- **All IVR calls:** set `IVR_ENABLED=false` on each FS node, then `up -d freeswitch` (needs a window). IVR numbers get 603 and nothing else changes.
