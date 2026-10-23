# Voicemail transcription (v1.1) + recording quality: deploy and live test

This is the ordered command list for the owner. Every command is one line. Run them in order, on the machine named in **bold**, and check each output before the next one. Design: `docs/VOICEMAIL_TRANSCRIPTION_PLAN.md`, where §0.1 (owner decisions) wins over everything else.

What ships:
- **Migration 56:** the `voicemail_transcripts` table (encrypted transcripts plus the job queue), two mailbox columns (`transcription_enabled` default **off**, `transcription_language`), a purge trigger and a stats view.
- **API:** the transcription worker. It starts only when the platform flag is on.
  - New endpoints: transcript, snippets, retry, backfill, ops status and requeue.
  - Only admins can switch a mailbox on or off (O2).
- **UI:**
  - inbox snippets and the reading-pane transcript;
  - the admin-only switch in Greeting & settings;
  - corrected marketing copy.
- **FreeSWITCH (`vm_box.lua` only):** the silence stop goes from 5 s to **10 s**, plus a jitter buffer and RTP timer on the voicemail recording leg. RCF and trunk calls are not touched.
- **SBCs:** no changes.

**GCP is already done** (2026-10-23): `speech.googleapis.com` is enabled and `vm-api` holds `roles/speech.client`. No GCP command is needed below.

**Order:**
1. migration 56;
2. API and UI with the flag **off** (nothing is sent anywhere);
3. FS pulls;
4. flag on;
5. smoke test;
6. live test.

**Downtime:**
- Rebuilding `api` restarts it for a few seconds. FS voicemail deposits retry, and CDR posts go to the FS disk fallback. Do it in a quiet moment.
- The FS step is only a `git pull`: no restart and no dropped calls.

---

## 0. Prerequisites
1. The PR is merged into `RCF-V1` in the GitHub UI ("Create a merge commit").
2. You have the test mailbox from the voicemail v1 live test, with its DID `<VM_DID>`.

## 1. Services VM (`services`, East): migration, API, UI with the flag OFF

1. **services** `sudo git -C /opt/revup pull` → fast-forward to the merged RCF-V1 commit.
2. **services** `sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/56_voicemail_transcription.sql` → ends in `COMMIT`, with no `ERROR`. It is safe to re-run.
3. **services** `sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql | grep 56_` → `56_voicemail_transcription | applied`. It replicates to every zone's replica on its own.
4. **services** `sudo grep -c '^VOICEMAIL_TRANSCRIPTION_ENABLED' /opt/revup/.env` → `0`, meaning the flag is off.
5. **services** `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build api` → `voip-api` is recreated. The build pulls in `google-cloud-speech` and takes a minute or two.
6. **services** `curl -s localhost:8088/health` → `{"status":"healthy",...}`
7. **services** `sudo docker logs voip-api --since 3m 2>&1 | grep -ci "transcription: worker started"` → `0`. With the flag off, the worker must not start.
8. **services** `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build ui` → `voip-ui` is recreated. The transcription switch stays hidden while the platform is off.

## 2. FreeSWITCH nodes (all 6): `git pull` only

The jitter buffer, the timer and the 10 s silence stop live in `vm_box.lua`. It is bind-mounted and loaded fresh on every voicemail call, so nothing restarts. A call already recording keeps the old code until it ends.

The nodes, in order: `east-fs-2`, `fs-media-v2`, `west-fs-2`, `west-fs`, `central-fs-2`, `central-fs`.

Per node:
1. `sudo git -C /opt/revup pull` → fast-forward.
2. `grep -c -E 'M.SILENCE_HITS += 10|M.JITTERBUFFER += "60:200"|M.RTP_TIMER_NAME += "soft"' /opt/revup/docker/freeswitch/scripts/lib/vm_box.lua` → `3`.

## 3. Turn transcription on (services VM)

1. **services** `echo 'VOICEMAIL_TRANSCRIPTION_ENABLED=true' | sudo tee -a /opt/revup/.env >/dev/null && echo OK` → `OK`
2. **services** `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d api` → `voip-api` is recreated with no rebuild.
3. **services** `sudo docker exec voip-api python -m services.voicemail.transcription.smoke` → `stt smoke ok: provider=gcp_stt_v2 endpoint=us-speech.googleapis.com location=us model=telephony results=0 billed_ms=1000`
   - The smoke test sends 1 s of generated silence (about $0.0003) and never customer audio.
   - `stt smoke FAILED: stt_permission PermissionDenied` means the IAM binding has not propagated yet. Wait 2 minutes and re-run.
   - `stt_config NotFound` means `VOICEMAIL_KMS_PROJECT` in `.env` is not `rugged-night-193017`.
4. **services**, about 40 s after step 2: `sudo docker logs voip-api --since 2m 2>&1 | grep -c "transcription: worker started"` → `4`, one per uvicorn worker.

## 4. Live test (internal test mailbox only)

1. **UI as admin:** go to Visual Voicemail, pick the test mailbox, open **Greeting & settings**, set **Transcription** to **On** with English (US), then **Save**. The toast says "Transcription is on…".
2. **Phone:** call `<VM_DID>`, wait for the beep, and leave about 20 s with a few distinctive words (a street name, a number). Then hang up.
3. **Phone:** call again and leave about 70 s, so the message is split into two pieces. **Pause for 6–7 s in the middle**: the call must NOT cut you off (the 10 s silence stop).
4. **Phone:** call again, say nothing after the beep, and wait. You should be disconnected about **10 s** after the beep. The message shows "No speech detected", and no Google call is made for it.
5. **UI (inbox):**
   - each message shows "Transcribing…", then a snippet, within about 10–30 s;
   - the reading pane shows the full text under **Transcript**;
   - recording quality should be at least as good as before.
6. **services** `sudo docker logs voip-api --since 15m 2>&1 | grep "voicemail transcription: message="` → one line per message, with `status=done` (or `empty` for the silent one) and `chunks=2` for the long one.
7. **services** `sudo docker logs voip-api --since 30m 2>&1 | grep -ci "<a distinctive word you said>"` → `0`. Transcript text is never logged.
8. **services** `sudo docker exec voip-api ls -A /tmp` → no output.
9. **services** `sudo -u postgres psql -d voip -c "SELECT action, count(*) FROM voicemail_access_log WHERE action LIKE 'transcri%' AND created_at > now() - interval '1 hour' GROUP BY 1"` → `transcribe` and `transcript_view` rows.
10. **UI as admin:** delete one test message and empty it from Trash. Then **services** `sudo -u postgres psql -d voip -At -c "SELECT count(*) FROM voicemail_transcripts t LEFT JOIN voicemail_messages m ON m.id = t.message_id WHERE m.id IS NULL"` → `0`. No transcript outlives its message.
11. **UI as a tenant user** (or admin "View as Customer"): the transcript is visible; Greeting & settings shows "Transcription · On — English (US)" with no switch.

Optional ops view: **services** `curl -s -H "Authorization: Bearer <admin token>" localhost:8088/v1/voicemail/transcription/status`. It shows counts by status, billed minutes over 24 h against the 1000 min/day cap, and failures by code.

## 5. Rollback

1. **Stop sending to Google** (seconds; no data lost):
   - **services** `sudo sed -i '/^VOICEMAIL_TRANSCRIPTION_ENABLED=/d' /opt/revup/.env && cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d api`
   - The worker stops and the switches hide. Existing transcripts stay readable.
2. **FS recording changes:** revert the FS commit (`git revert` in the repo, merge, then `sudo git -C /opt/revup pull` on each FS node). To keep the 10 s silence stop but drop only the jitter buffer, remove both `setv` lines together. Never remove the buffer without the timer, or the timer without the buffer.
3. **Code:** check out the previous commit and run `up -d --build api ui`. The v1 code tolerates migration 56.
4. **Schema:** leave 56 in place.
5. **GCP** (only if transcription is being abandoned; shared project):
   - `gcloud projects remove-iam-policy-binding rugged-night-193017 --member=serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role=roles/speech.client --condition=None` removes only our binding.
   - **Never** disable `speech.googleapis.com`: another team's identity also holds `roles/speech.client`.

## Notes
- **Who controls it:**
  - New mailboxes default to **off** (O1). Only admins switch it on, per mailbox (O2).
  - **Transcribe earlier messages** (admin) queues up to 200 messages that arrived while the switch was off.
- **When the switch counts:** a message is checked against the mailbox's switch when the worker first sees it, about one poll (10 s) after it is stored. A message left a few seconds before you switch on may therefore still be transcribed.
- **Cost:** $0.016/min, billed per second.
  - The 10 s silent tail and all-silent messages are trimmed and never sent.
  - The rolling cap is 1000 billed min/day (`VOICEMAIL_STT_DAILY_MINUTES_CAP`). At the cap, jobs wait; they are never dropped.
- **Billing record:**
  - Each transcription writes a `transcribe` audit row with `billed_ms`, which is the per-customer usage record for a future add-on fee.
  - A forced re-run overwrites the row's `billed_ms` but adds a new audit row.
