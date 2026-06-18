# SIPp Integration Scenarios (Phase 0)

Best-effort SIP integration tests that drive real calls through the local
`docker compose` stack (Kamailio SBC -> FreeSWITCH). They capture the CURRENT
SIP ladder for each product so later phases can regression-check call flow.

| Scenario | Product | Models |
|---|---|---|
| `uac_short_call.xml` | generic | INVITE+SDP, answer, hold, BYE (pre-existing) |
| `rcf_inbound.xml` | RCF | Bandwidth -> SBC -> FS -> forwarded PSTN party |
| `api_inbound.xml` | API voice | inbound DID answered locally by `voice_webhook.lua` |
| `trunk_outbound.xml` | SIP trunk | IP-authed PBX -> SBC -> FS -> carrier |

## Running against the local stack

1. Bring up the stack from the repo root:

   ```
   docker compose up -d
   ```

   (Local dev compose runs Kamailio + FreeSWITCH + Redis + Postgres + API.)

2. The SIPp image (`docker/sipp`) already `COPY`s `scenarios/` to
   `/app/scenarios`. Run a scenario from a SIPp container on the compose
   network so it can reach the SBC. Example (RCF inbound, one call):

   ```
   docker compose run --rm sipp \
     sipp kamailio:5060 -sf /app/scenarios/rcf_inbound.xml \
       -s 16174544217 -d 3000 -m 1 -trace_err -trace_msg
   ```

   - `-s <number>`  the To user (DID for inbound, PSTN dest for trunk outbound)
   - `-d <ms>`      hold/talk time before BYE
   - `-m 1`         stop after 1 call
   - target host    `kamailio:5060` on the compose net, or the NLB VIP in prod

3. Inspect the ladder in Homer (capture IDs: Kamailio=100, FreeSWITCH=200) or
   with `-trace_msg`.

## Data preconditions (why a call may 404 / 403 instead of 200)

These scenarios are **integration** tests — they need provisioned data:

- **RCF** (`rcf_inbound.xml`): the `-s` DID must exist in `rcf_numbers` with a
  `forward_to` that actually answers. The repo's documented live test DID is
  `+16174544217 -> +17744045256` (CLAUDE.md "Testing"). For a self-contained
  test, point `forward_to` at the FreeSWITCH echo app `9196` or run a second
  SIPp UAS as the forwarded party.
- **API** (`api_inbound.xml`): the `-s` DID must exist in `api_dids` with a
  reachable `voice_url` returning a `<Response>` document.
- **Trunk** (`trunk_outbound.xml`): the **SIPp source IP** must be in
  `trunk_auth_ips` for an enabled trunk (set `TESTING_IP` in the SBC `.env` for
  local testing), and the From user must be a DID in `trunk_dids` for that trunk.

## What needs the full stack (cannot run headless here)

Running these end-to-end requires the actual containers (SBC + FS + Postgres +
the carrier or a UAS standing in for it) and provisioned DB rows. In a CI box
without that, treat these as **authored, validated SIP** (the XML is well-formed
and the ladders match CLAUDE.md's call flow) and run them in an environment that
has the stack up. To run a fully local loop with no carrier:

1. Provision an RCF DID whose `forward_to` is `9196` (FreeSWITCH echo).
2. `rcf_inbound.xml -s <that DID>` — you get answer + 2-way echo + BYE, exercising
   the inbound INVITE -> Lua route -> bridge -> in-dialog BYE path through Kamailio.
