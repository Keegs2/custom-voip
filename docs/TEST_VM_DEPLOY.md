# Test VM Deploy — Full Unified Stack on One Box (real carrier)

Stand up the **entire unified platform on a single VM** for end-to-end testing,
**including real Bandwidth calls**. One VM is enough — Kamailio (SBC) + FreeSWITCH +
Postgres + Redis + API + UI + MinIO + coturn + Homer all run via the local
all-in-one `docker-compose.yml`.

**Why a single Linux VM is the right test target:** on Docker Desktop the
host-net (FreeSWITCH) ↔ bridge (API) paths can't talk, so ESL / xml_curl / CDR /
voicemail+recording notify / the audio-stream WebSocket fork were only ever
verified inside the FS netns. On a real Linux VM `network_mode: host` works, so
this test exercises those cross-component paths for the first time.

> **Reuse target:** the retired **`fs-media`** VM (`10.142.0.102`, stopped). It was
> replaced by `fs-media-v2` and is free. ⚠️ It is on the **`default` subnet**, which
> is subject to **Cloud NAT** — the exact thing that broke audio originally. You MUST
> add the **`bypass-vpn`** network tag (Step 1) or external RTP will fail.

> **What this single box does NOT test:** the multi-VM SBC path (NLB + double
> Record-Route `r2=on` + cross-SBC failover) — Kamailio and FS are co-located here,
> so in-dialog routing stays on loopback. That hardened path is unchanged from
> production and guarded by `tests/lessons/`; to exercise it live you'd point a
> separate SBC VM at this FS (a later step, not needed for feature/carrier testing).

---

## Step 1 — GCP prep (run from your workstation; needs gcloud auth)

Resize the box (the full stack is heavy), tag it to bypass Cloud NAT, give it a
stable public IP, then start it. Single-line commands (zone `us-east1-b`):

```
gcloud compute instances set-machine-type fs-media --zone=us-east1-b --machine-type=e2-standard-8
gcloud compute instances add-tags fs-media --zone=us-east1-b --tags=bypass-vpn,voip-test
gcloud compute addresses create fs-media-test-ip --region=us-east1
gcloud compute instances delete-access-config fs-media --zone=us-east1-b --access-config-name="external-nat" 2>/dev/null; gcloud compute instances add-access-config fs-media --zone=us-east1-b --access-config-name="external-nat" --address=$(gcloud compute addresses describe fs-media-test-ip --region=us-east1 --format='value(address)')
gcloud compute instances start fs-media --zone=us-east1-b
```

Note the public IP it gets (`fs-media-test-ip`) — that's `EXTERNAL_SIP_IP` below.

## Step 2 — Firewall (scope tightly)

```
gcloud compute firewall-rules create voip-test-sip --network=default --target-tags=voip-test --allow=udp:5060,tcp:5060 --source-ranges=67.231.0.0/16,216.82.224.0/19
gcloud compute firewall-rules create voip-test-rtp --network=default --target-tags=voip-test --allow=udp:16384-49151 --source-ranges=67.231.0.0/16,216.82.224.0/19
gcloud compute firewall-rules create voip-test-web --network=default --target-tags=voip-test --allow=tcp:8088,tcp:8080,tcp:8082,tcp:8083,udp:3478,tcp:3478,tcp:5349,udp:49160-49200 --source-ranges=YOUR.OFFICE.IP/32
```

- SIP/RTP open only to Bandwidth's signaling ranges.
- Web/Verto/TURN open only to **your** test client IP(s). Widen the TURN relay
  range to match `docker/coturn/turnserver.conf` if you changed it.

## Step 3 — Deploy on the VM (your standard workflow)

```
gcloud compute ssh fs-media --zone=us-east1-b
sudo git -C /opt/revup fetch origin && sudo git -C /opt/revup checkout unified && sudo git -C /opt/revup pull
sudo cp /opt/revup/.env.test.example /opt/revup/.env
sudo nano /opt/revup/.env      # fill every REPLACE_* (see the template's REQUIRED notes)
sudo docker compose -f /opt/revup/docker-compose.yml up -d --build
```

Generate the secrets the template asks for: `openssl rand -hex 32` (JWT),
`openssl rand -hex 24` (ESL/INGEST/TURN). `EXTERNAL_SIP_IP`/`EXTERNAL_RTP_IP`/
`FS_PUBLIC_IP`/`TURN_HOST`/`VERTO_WS_URL` all use the Step-1 public IP.

> If the box is < e2-standard-8, trim the FreeSWITCH `deploy.limits` in
> `docker-compose.yml` (8 CPU/16 G) before `up`, or resize larger.

## Step 4 — Point Bandwidth at the test VM

This is the one piece outside the repo. Use a **dedicated test DID** (do NOT reuse
the production DID `+16174544217`, which routes to the prod NLB):
- In the Bandwidth portal, route a test TN's inbound SIP to `EXTERNAL_SIP_IP:5060` (UDP),
  and add that IP to the test SIP peer's allowed origination, OR use a separate test peer
  (`BANDWIDTH_SIP_PEER_ID` in `.env`).
- Outbound auth uses the test DID as the From number (already handled by the RCF/api Lua).

## Step 5 — Verify (on the VM)

```
sudo docker compose ps                                                # all services Up/healthy
sudo docker exec voip-postgres psql -U voip -d voip -c "select did,forward_to from rcf_numbers;"
sudo docker exec voip-freeswitch /usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "sofia status"
sudo docker exec voip-kamailio kamcmd dispatcher.list                 # FS group up
curl -s http://localhost:8088/health                                  # {"status":"healthy"...}
```

Then:
1. **Inbound real call** → dial the test DID → confirm two-way audio (this is the
   Cloud-NAT/RTP check; if one-way/no audio, the `bypass-vpn` tag or `EXTERNAL_*_IP`
   is wrong).
2. **Outbound / programmable voice / IVR / recording / conference / Verto softphone**
   via the UI at `http://EXTERNAL_SIP_IP:8080`.
3. **SIP ladder** in Homer for the call to confirm signaling.
4. **Recordings** land in MinIO and play back in the UI (validates FS→API multipart
   ingest over the real bridge — the path Docker Desktop couldn't test).

## Single-box networking notes (why the env values above)

- Kamailio listens/advertises on the **public IP** (carrier-facing) and routes to FS
  at **127.0.0.1:5080**; FS routes back to Kamailio at **127.0.0.1:5060**
  (`SBC_PROXY_IP=127.0.0.1`). `SBC_INTERNAL_IP=127.0.0.1` so the inner Record-Route
  is local. The entrypoints add the public IP to `lo` (hairpin NAT) so each service
  can reach the advertised address locally — `NET_ADMIN` is already in the compose.
- `API_HOST`/`API_PORT` (FS→API) resolve to the published API on `localhost:8088`;
  API→FS ESL uses `host.docker.internal:host-gateway` (works on Linux). No change needed.
- `TEST_MODE=false` enables real carrier bridging; flip to `true` for a tone-only smoke test.

## Teardown

`gcloud compute instances stop fs-media --zone=us-east1-b` (keeps the disk). Release
the static IP with `gcloud compute addresses delete fs-media-test-ip --region=us-east1`
if you don't want to keep paying for it.
