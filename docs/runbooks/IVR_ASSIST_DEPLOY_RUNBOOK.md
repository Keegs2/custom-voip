# Visual IVR Flow assistant: CRAG deploy runbook (2026-10-25)

This runbook turns on the CRAG side of the **Flow assistant**: the customer describes a call flow in plain English, CRAG asks TED for a proposal, validates it with its own compiler, and the builder shows it for the customer to accept. TED owns the AI step and has its own runbook (the TED assist PR); CRAG never talks to a model.

- **Contract:** `docs/IVR_ASSIST_INTERFACES.md` (schemas in `docs/ivr_assist/`).
- **Needs:** Visual IVR already deployed (migrations 59 + 60, `docs/runbooks/IVR_DEPLOY_RUNBOOK.md`), and the TED assist endpoint live. From the TED runbook you need **TED's public URL** and the **CRAG assist token** (for staging and for production).
- **Nothing changes for anyone** until a customer is opted in (§5). The platform switch alone shows nothing: every customer starts opted out.
- **No maintenance window:** only the API and UI containers are recreated (a few seconds; FreeSWITCH and calls are untouched).

Every command is one line and needs sudo. Run them in order, one at a time, on the **services** VM; the expected output follows each →. The token is typed at a hidden prompt (`read -rsp`), never put on a command line, and never printed.

## 0. Merge order (GitHub UI, "Create a merge commit")

1. `feat/ivr-assist-backend` (this: migration 61, the API, the eval runner).
2. `feat/ivr-assist-portal` (the builder's Flow assistant panel). It shows nothing until `summary.assist.available` is true, so it may ship in the same pull.

TED's two PRs (the assist endpoint, and the Customer 360 switch) ship the usual TED way, in any order relative to these. TED shows its Flow assistant switch only once this CRAG build answers with `ivr_assist_enabled`.

## 1. Pull and apply migration 61 (replicates to every zone)

1. `cd /opt/revup && sudo git pull` → a fast-forward to the merge commit.
2. `cd /opt/revup && hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/61_ivr_assist.sql` → `BEGIN`, `SET`, `DO`, `ALTER TABLE`, `CREATE TABLE`, `DO`, four `CREATE INDEX`, four `COMMENT`, `REVOKE`, `DO`, `COMMIT`. (Running it again is harmless: `NOTICE … already exists, skipping` lines, then `COMMIT`. A `lock timeout` error just means a busy moment: run it again.)
3. `cd /opt/revup && hostname | grep -q '^services$' && sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql | grep -E '59_ivr|60_cdr_ivr|61_ivr_assist'` → three lines, each `| applied`.
4. `cd /opt/revup && sudo -u postgres psql -d voip -Atc "SELECT has_table_privilege('api','ivr_assist_jobs','INSERT'), has_table_privilege('freeswitch','ivr_assist_jobs','SELECT'), has_table_privilege('grafana_ro','ivr_assist_jobs','SELECT')"` → `t|f|f`

## 2. The `.env` lines (services VM)

5. `cd /opt/revup && sudo grep -cE '^(IVR_ASSIST_ENABLED|TED_BASE_URL|TED_IVR_ASSIST_TOKEN|IVR_ASSIST_DAILY_PER_CUSTOMER|IVR_ASSIST_TED_TIMEOUT_SECONDS)=' .env` → `0`. If it prints more than `0` (an earlier attempt), remove them first: `cd /opt/revup && sudo sed -i -E '/^(IVR_ASSIST_ENABLED|TED_BASE_URL|TED_IVR_ASSIST_TOKEN|IVR_ASSIST_DAILY_PER_CUSTOMER|IVR_ASSIST_TED_TIMEOUT_SECONDS)=/d' .env && echo REMOVED` → `REMOVED`, then run step 5 again.
6. TED's public URL, from the TED runbook (it starts with `https://`). **For the pilot use TED staging; switch to production in §9 after the go-ahead:** `cd /opt/revup && read -rp 'TED public URL (https://...): ' TEDURL && printf 'TED_BASE_URL=%s\n' "$TEDURL" | sudo tee -a .env >/dev/null && unset TEDURL && echo OK` → `OK`
7. The CRAG assist token for the SAME TED environment as step 6 (staging for the pilot), from the TED runbook (typing is hidden): `cd /opt/revup && read -rsp 'TED assist token (hidden): ' TEDTOK && echo && printf 'TED_IVR_ASSIST_TOKEN=%s\n' "$TEDTOK" | sudo tee -a .env >/dev/null && unset TEDTOK && echo OK` → an empty line, then `OK`
8. `cd /opt/revup && printf 'IVR_ASSIST_ENABLED=true\nIVR_ASSIST_DAILY_PER_CUSTOMER=40\nIVR_ASSIST_TED_TIMEOUT_SECONDS=60\n' | sudo tee -a .env >/dev/null && echo OK` → `OK`
9. `cd /opt/revup && sudo grep -E '^(IVR_ASSIST_ENABLED|TED_BASE_URL|IVR_ASSIST_DAILY_PER_CUSTOMER|IVR_ASSIST_TED_TIMEOUT_SECONDS)=' .env && sudo grep -c '^TED_IVR_ASSIST_TOKEN=[!-~]' .env` → `TED_BASE_URL=https://…`, `IVR_ASSIST_ENABLED=true`, `IVR_ASSIST_DAILY_PER_CUSTOMER=40`, `IVR_ASSIST_TED_TIMEOUT_SECONDS=60`, then `1` (the token is there; it is not printed).
10. `cd /opt/revup && sudo stat -c '%a %U' .env` → `600 root`. If it shows a wider mode (for example `644`), run `cd /opt/revup && sudo chmod 600 .env && echo OK` → `OK` (every compose command already runs with sudo).

## 3. Rebuild and recreate the API and the UI

11. `cd /opt/revup && sudo docker compose -f docker-compose.services.yml build api ui` → the `voip-api` and `voip-ui` images are built (the builder's Flow assistant panel ships in `ui`, from #164).
12. `cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d api ui` → `Container voip-api  Recreated` and `Container voip-ui  Recreated`, then `Started`.
13. About 20 s later: `sudo docker inspect -f '{{.State.Health.Status}}' voip-api` → `healthy` (`starting`: wait 10 s and run it again).
14. `sudo docker exec voip-api python -c "from services.ivr.assist import config; print(config.enabled(), config.ted_configured(), config.daily_cap(), config.ted_timeout_s())"` → `True True 40 60.0`. `True False …` means the URL is not a usable `https://` URL or the token is empty: fix step 6 or 7 (remove the line with the step-5 `sed`, then re-add it), then step 12 again.
15. `sudo docker exec voip-api python -c "from services.ivr.assist import schema; print(sorted(n for n in schema.SCHEMA_FILES if schema.validator(n)))"` → `['alias_graph', 'request', 'response']`

## 4. The eval (no customer involved; it runs TED's model, so it uses TED's budget)

The eval sends 36 realistic utility requests (each with its own made-up customer, never a real number) through exactly the production path and checks each answer: the kind of result, a clean compile, and test calls reaching the expected place. Run it against **TED staging** first.

16. Against TED staging (its public URL and its CRAG assist token, from the TED runbook; typing the token is hidden): `cd /opt/revup && read -rp 'TED staging public URL (https://...): ' TEDURL && read -rsp 'TED staging assist token (hidden): ' TEDTOK && echo && { printf '%s\n' "$TEDTOK"; cat tests/fixtures/ivr_assist/eval_cases.json; } | sudo docker exec -i voip-api python -m services.ivr.assist.eval --ted-url "$TEDURL" --token-stdin --cases -; echo "eval exit status $?"; unset TEDURL TEDTOK` → one line per case, for example `PASS  acme-main-menu  proposal  rounds=1 issues=0 calls=4/4`, a `FAIL` line followed by the reasons for any case that missed, then `36/36 cases passed; simulated calls 59/59 reached their expected exit` and `eval exit status 0`. (`1` = at least one case failed: keep the output for the TED owner; `2` = the URL or token was not usable.)
17. One production case, to prove the production URL and token (one request): `cd /opt/revup && sudo docker exec -i voip-api python -m services.ivr.assist.eval --only acme-main-menu --cases - < tests/fixtures/ivr_assist/eval_cases.json; echo "eval exit status $?"` → `PASS  acme-main-menu …`, `1/1 cases passed …`, `eval exit status 0`. `FAIL … job failed: assistant_unavailable` means TED refused the token or is unreachable: check step 7 against the TED runbook.
18. (Optional, the full run against production TED) `cd /opt/revup && sudo docker exec -i voip-api python -m services.ivr.assist.eval --cases - < tests/fixtures/ivr_assist/eval_cases.json; echo "eval exit status $?"` → as step 16.

## 5. Opt in the test customer (Granite Telephony, customer 11)

Customer 11 must already have Visual IVR on (the IVR live test turned it on).

19. **In TED:** Customer 360 → customer **11** → Visual IVR → **Flow assistant** → on (confirm the disclosure).
20. `cd /opt/revup && sudo -u postgres psql -d voip -Atc "SELECT id, ivr_enabled, ivr_assist_enabled FROM customers WHERE id = 11"` → `11|t|t`

**Without TED's switch** (if that TED PR is not out yet), use the CRAG admin API on services instead of step 19:

   1. Log in once (it prompts for the admin email and password and keeps the token in a private file): `read -rp 'CRAG admin email: ' E && read -rsp 'password: ' P && echo && curl -s -X POST http://127.0.0.1:8088/v1/auth/login -H 'content-type: application/json' -d "{\"email\":\"$E\",\"password\":\"$P\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' > ~/crag_admin.tok; unset P; chmod 600 ~/crag_admin.tok; wc -c < ~/crag_admin.tok` → a number over 100.
   2. `curl -s -X PUT "http://127.0.0.1:8088/v1/ivr/admin/customers/11/entitlement" -H "authorization: Bearer $(cat ~/crag_admin.tok)" -H 'content-type: application/json' -d '{"assist_enabled":true}'` → `{"ivr_enabled":true,"ivr_assist_enabled":true}`
   3. Then step 20.

## 6. Check it end to end (customer 11)

21. In the portal, as customer 11 (or View as Customer for customer 11), open IVR → any flow → the toolbar shows **Flow assistant**. Send "Play a short greeting and hang up." → within about 30 s a proposal appears with a new message; **Discard** it (nothing is saved until Accept, and nothing goes live until Publish).
22. The same through the API (with `~/crag_admin.tok` from §5; makes one throwaway flow): `curl -s "http://127.0.0.1:8088/v1/ivr/summary?customer_id=11" -H "authorization: Bearer $(cat ~/crag_admin.tok)" | python3 -c 'import sys,json;print(json.load(sys.stdin)["assist"])'` → `{'available': True}`
23. `curl -s -X POST "http://127.0.0.1:8088/v1/ivr/flows?customer_id=11" -H "authorization: Bearer $(cat ~/crag_admin.tok)" -H 'content-type: application/json' -d '{"name":"Flow assistant smoke test"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' > ~/assist_flow.id; cat ~/assist_flow.id` → a flow id (a number).
24. `curl -s -X POST "http://127.0.0.1:8088/v1/ivr/flows/$(cat ~/assist_flow.id)/assist?customer_id=11" -H "authorization: Bearer $(cat ~/crag_admin.tok)" -H 'content-type: application/json' -d '{"message":"Play a short greeting and hang up."}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])' > ~/assist_job.id; cat ~/assist_job.id` → a job id (a UUID).
25. About 30 s later: `curl -s "http://127.0.0.1:8088/v1/ivr/flows/$(cat ~/assist_flow.id)/assist/$(cat ~/assist_job.id)?customer_id=11" -H "authorization: Bearer $(cat ~/crag_admin.tok)" | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d.get("result") or {};print(d["status"], r.get("kind"), len(r.get("issues") or []), d.get("error"))'` → `done proposal 0 None`. `running None 0 None`: wait 10 s and run it again. `failed None 0 {…}`: the code says why (`assistant_unavailable` = TED unreachable or the token was refused; `assistant_busy` = TED's budget or concurrency limit).
26. `sudo docker logs --since 10m voip-api 2>&1 | grep 'ivr assist:' | tail -4` → lines like `ivr assist: job … started for flow …`, `ivr assist: TED request … round=propose -> proposal in … ms …`, `ivr assist: job … done (proposal) after 1 TED call(s)`.
27. Clean up: `curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "http://127.0.0.1:8088/v1/ivr/flows/$(cat ~/assist_flow.id)?customer_id=11" -H "authorization: Bearer $(cat ~/crag_admin.tok)"` → `204`
28. `rm -f ~/assist_flow.id ~/assist_job.id ~/crag_admin.tok && echo OK` → `OK`

## 7. Rollback (any time, no window)

- **One customer:** in TED, Customer 360 → Flow assistant → off. (Or the admin API as in §5 with `{"assist_enabled":false}` → `{"ivr_enabled":true,"ivr_assist_enabled":false}`.) The builder hides the panel at its next load.
- **Everyone:** `cd /opt/revup && sudo sed -i 's/^IVR_ASSIST_ENABLED=.*/IVR_ASSIST_ENABLED=false/' .env && sudo docker compose -f docker-compose.services.yml up -d api` → `Container voip-api  Recreated`, `Started`. Then step 14 → `False True 40 60.0`. Jobs in flight on the old container are cancelled and read as failed; every customer's opt-in stays as it was for later.
- **Never** drop `ivr_assist_jobs` or `customers.ivr_assist_enabled`. Jobs older than 90 days are deleted automatically.

## 8. Rotating the token

When TED rotates the CRAG assist token (TED runbook): `cd /opt/revup && sudo sed -i '/^TED_IVR_ASSIST_TOKEN=/d' .env && echo REMOVED` → `REMOVED`, then step 7 with the new token, then step 12 and step 17.

## 9. Switch from TED staging to TED production (after the pilot)

Do this only after the TED production promotion and the owner's go-ahead. TED production has its own token.

29. `cd /opt/revup && sudo sed -i -E '/^(TED_BASE_URL|TED_IVR_ASSIST_TOKEN)=/d' .env && echo REMOVED` → `REMOVED`
30. Step 6 with TED's **production** URL, then step 7 with the **production** token, then step 9 (`TED_BASE_URL=https://…` shows the production URL).
31. Step 12, step 14 (`True True 40 60.0`), then step 17 → `1/1 cases passed`.
