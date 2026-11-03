# Verizon IPsec Gateway Runbook — bring-up, drills, failover, patching

**Scope:** the six `{zone}-vz-gw-{a,b}` strongSwan gateways (plan `docs/VERIZON_IPSEC_TRUNKS_PLAN.md` §2–§4, §11). Config stack: `infra/vz-ipsec/README.md`. The GCP objects (VMs, protocol forwarding, ILBs, routes, firewall) are the owner's and are only *named* here — every `gcloud` line is run by the owner from a workstation, never on a VM.
**Who runs what:** VM commands are single lines, `sudo` where needed; every state-changing VM command is hostname-guarded so a wrong-box paste is a no-op. `R=/opt/revup/infra/vz-ipsec` in every shell.
**Legend:** 🟢 SAFE read-only · 🟠 IMPACT (moves or risks Verizon traffic in the zone) · 🔴 destructive — read twice.

## 0. The box in 60 seconds

- No Docker. No conntrack. One IKEv2 tunnel (`vz`) per gateway bound to `xfrm-vz` (MTU 1400, no address). Stateless 1:1 NAT in nftables (`table ip vz`): zone SIP IP ⇄ `10.x.0.251`, FS public ⇄ FS NIC. Forward chain drops everything else.
- The VM's only public identity is its protocol-forwarded **IKE IP** on `ens4` (default route `src IKE_IP`). VPC traffic is NIC-sourced.
- gw-a is the next-hop ILB primary, gw-b the failover group; **both tunnels are always up**. The ILB's HC (`:8081/healthz`, 5 s × 2 ≈ 10–12 s) follows `vz-healthd`, which is 200 only while SA + iface + route + nft + no-black-hole + no-drain all hold (README "Health check and drain").
- A flip = the VPC route moving (~10–12 s) + Verizon's own DPD moving its send side. NAT is stateless and identical on both, so established calls survive with a short audio gap (plan §2.3).

### Zone quick reference

| | East | West | Central |
|---|---|---|---|
| gw-a / gw-b | `east-vz-gw-a` 192.168.11.2 (us-east1-b) / `east-vz-gw-b` 192.168.11.3 (us-east1-c) | `west-vz-gw-a` 192.168.21.2 (us-west1-b) / `west-vz-gw-b` 192.168.21.3 (us-west1-c) | `central-vz-gw-a` 192.168.31.**4** (us-central1-**a**) / `central-vz-gw-b` 192.168.31.**5** (us-central1-**f**) |
| IKE IP a / b | 35.231.206.85 / 34.26.69.151 | 8.231.131.118 / 136.66.170.29 | 34.68.252.50 / 34.171.191.175 |
| Next-hop ILB (`{zone}-vz-gw-ilb`) | 192.168.11.4 | 192.168.21.4 | 192.168.31.2 |
| Gateway backend / HC | `east-vz-gw-backend` / `east-vz-gw-hc` | `west-vz-gw-backend` / `west-vz-gw-hc` | `central-vz-gw-backend` / `central-vz-gw-hc` |
| Zone SIP IP → SBC VIP | 34.148.100.185 → 10.142.0.251 | 136.86.242.57 → 10.138.0.251 | 35.184.132.124 → 10.128.0.251 |
| FS-1 / FS-2 public | 34.139.119.135 / 35.196.226.123 | 8.229.177.165 / 35.197.95.171 | 35.253.103.114 / 34.63.100.161 |
| Route tag | `vz-east` | `vz-west` | `vz-central` |

Owner's health view (workstation): `gcloud compute backend-services get-health central-vz-gw-backend --region=us-central1 --project=rugged-night-193017`

## 1. Bring-up per gateway (Phase 1 — before Verizon exists)

SSH is via IAP only (`vz-ipsec-allow-iap-ssh`); the IKE IP never carries SSH.

1. 🟢 Confirm identity: `hostname; ip -o -4 addr show dev ens4; cat /etc/os-release | grep VERSION_ID` → `central-vz-gw-a`, `192.168.31.4/28`, `"12"`.
2. 🟢 Repo present at `/opt/revup` on branch `RCF-V1`: `cd /opt/revup && sudo git pull && git log --oneline -1`
3. 🟠 Write `/opt/revup/.env` from the row in `infra/vz-ipsec/README.md` "Per-gateway values" (peer/prefixes stay `PLACEHOLDER`): `sudo cp /opt/revup/infra/vz-ipsec/env.example /opt/revup/.env && sudo nano /opt/revup/.env`
4. 🟠 Install (hostname-guarded; aborts on Docker, refuses a bad row): `hostname | grep -q '^central-vz-gw-a$' && cd /opt/revup && sudo infra/vz-ipsec/install.sh`
   Expected tail: `tunnel config skipped: peer/prefixes are placeholders`, then the `vz-status.sh` screen with `xfrm-vz` UP mtu 1400, `34.68.252.50/32` on ens4, `default … src 34.68.252.50`, `local 192.168.31.2 dev lo`, health `503` with `failed: ["sa_up","route_ok"]` — **that is correct pre-Verizon** (nothing to peer with; the gateway backend reads unhealthy by design, plan §4.1).
5. 🟢 `sudo /opt/revup/infra/vz-ipsec/check.sh` → every line `ok` except the tunnel block (`skip … VZ_TUNNEL_READY=0`) and `/healthz 503`.
6. 🟢 Forwarded-IP sourcing still holds (plan §3.1 proof): `curl -s --max-time 5 https://ifconfig.me; echo` → the IKE IP.
7. 🟢 Crypto driver: `grep -A3 '^name *: rfc4106(gcm(aes))' /proc/crypto | grep driver` → `rfc4106-gcm-aesni`. (If the line is absent before any SA has existed, `sudo modprobe aesni_intel` and re-check after the first SA.)
8. 🟢 Invariants: `lsmod | grep -c nf_conntrack; command -v docker || echo no-docker` → `0`, `no-docker`.

Repeat for all six. Nothing carries traffic until the owner's tagged `--next-hop-ilb` routes and the Verizon firewall rules exist (plan §4.1 "Not yet built").

### 1.1 Installing the PSK (Phase 2, once Verizon assigns it) — never into git/.env

Typed, not pasted into history (`read -rs`), ids from the validated env: `hostname | grep -q '^central-vz-gw-a$' && sudo bash -c 'read -rsp "PSK for this tunnel: " PSK; echo; . /etc/vz-ipsec/vz-gateway.env; printf "secrets {\n    ike-vz {\n        id-1 = %s\n        id-2 = %s\n        secret = \"%s\"\n    }\n}\n" "$VZ_LOCAL_ID" "$VZ_PEER_ID" "$PSK" | install -m 600 -o root -g root /dev/stdin /etc/swanctl/conf.d/secrets.conf && swanctl --load-creds'`
Then: `sudo ls -l /etc/swanctl/conf.d/secrets.conf` → `-rw------- root root`. (Requires `install.sh` to have run with real `VZ_PEER_IP` first so `VZ_PEER_ID` is set in `/etc/vz-ipsec/vz-gateway.env`.)

### 1.2 Turning the tunnel on (Phase 2)

1. 🟠 Fill `VZ_PEER_IP` and `VZ_PREFIXES` in `/opt/revup/.env` (SE answers, plan §10 #1/#2), then `hostname | grep -q '^central-vz-gw-a$' && cd /opt/revup && sudo infra/vz-ipsec/install.sh` → no "skipped" line; `swanctl --list-conns` shows `vz`.
2. 🟠 Install the PSK (§1.1). `start_action = start` initiates immediately; `swanctl --initiate --child vz` if you want to watch it.
3. 🟢 `sudo swanctl --list-sas` → `vz: #N, ESTABLISHED … AES_CBC-256/HMAC_SHA2_384_192/PRF_HMAC_SHA2_384/ECP_256` and child `vz: … INSTALLED, TUNNEL … AES_GCM_16-256 … ECP_256`.
4. 🟢 `sudo /opt/revup/infra/vz-ipsec/check.sh` → all `ok`, `/healthz 200`. Owner: backend `get-health` shows gw-a HEALTHY.

## 2. Steady-state verification 🟢 (any time, per gateway)

1. `sudo vz-status.sh` — one screen: SAs, `xfrm-vz`, routes, nft counters, xfrm_stat, health JSON, drain, invariants.
2. `curl -s http://127.0.0.1:8081/healthz; echo` → `{"healthy":true,"failed":[],…}`.
3. Through the ILB address as the probers see it: `curl -s -m2 -o /dev/null -w '%{http_code}\n' http://192.168.31.2:8081/healthz` (from the gateway itself: local route; from an SBC/FS in the zone: the ILB).
4. `sudo nft list table ip vz | grep counter` — packets/bytes on each translation and accept rule move while calls flow.
5. `awk '$2!=0' /proc/net/xfrm_stat` — `XfrmOutNoStates` and `XfrmInStateSeqError` must not climb.
6. Owner: `get-health` on the zone's gateway backend → gw-a HEALTHY, gw-b HEALTHY.

## 3. Phase 1 drills — no Verizon needed (plan §11 Phase 1)

Goal: prove the datapath (NAT, MTU, fragmentation, pps capacity) and the HC → ILB → failback mechanics before the order form is even answered, using gw-a ⇄ gw-b as a back-to-back tunnel with a lab PSK. The lab "Verizon" range is **198.18.0.0/24** (RFC 2544 benchmark space, never routed on the internet). Run it per zone; the §3.4 pps load test needs the SIPp/iperf box and is West-only (`west-loadtest` 10.138.0.3).

### 3.1 Lab topology

- **gw-a** = production-shaped gateway with `VZ_PEER_IP` = gw-b's IKE IP and `VZ_PREFIXES=198.18.0.0/24`. West only, additionally disguise the loadtest VM as FS-2 so the forward rules admit it: `VZ_FS2_NIC=10.138.0.3`, `VZ_FS2_PUB=198.18.1.2` (install.sh warns "not a 192.168.x address" — expected in the lab).
- **gw-b** = production-shaped gateway with `VZ_PEER_IP` = gw-a's IKE IP and the same `VZ_PREFIXES`, **plus runtime-only lab state that a reboot erases**: `198.18.0.10/32` on `lo` (the fake Verizon SBC) and host routes for the zone SIP IP / FS public IPs / `198.18.1.2` via `xfrm-vz`. gw-b's own NAT never matches lab traffic (its `pre` chain only rewrites the zone SIP / FS public destinations, its `post` chain only platform sources), so packets from `198.18.0.10` ride the tunnel untranslated.
- Flow: FS (or loadtest) → `198.18.0.x` → tagged VPC route → ILB → **gw-a** (`post`: NIC → public) → tunnel → **gw-b** (local delivery to `198.18.0.10`) and back the same way (`pre` on gw-a: public → NIC). Both gateways are healthy, so the ILB keeps gw-a primary and the drain drill (§3.5) can move it.
- Owner pre-reqs (workstation; all temporary, named `vz-lab-*`, deleted in §3.6): (a) firewall `vz-lab-allow-ike`: sources = the zone's two IKE IPs → tag `vz-ipsec`, `udp:500,esp`; (b) the zone's placeholder tagged route `198.18.0.0/24 --next-hop-ilb {zone}-vz-gw-ilb --tags vz-{zone}` (plan §11 Phase 1 "placeholders for Verizon prefixes"); (c) firewall `vz-lab-allow-fake-vz`: `198.18.0.0/24` → tags `voip-media` (+ `voip-loadtest` in West) `icmp,udp,tcp`; (d) West only: add tag `vz-west` to `west-loadtest` for the duration. Hairpin to a protocol-forwarded IP from inside the VPC is the one thing the §3.1 proof did not cover — if IKE never answers (§8), stop and ask before improvising with NIC-IP peers (not production-identical).

### 3.2 Bring the lab tunnel up

1. 🟠 On gw-a: `hostname | grep -q '^central-vz-gw-a$' && sudo sed -i -e 's|^VZ_PEER_IP=.*|VZ_PEER_IP=34.171.191.175|' -e 's|^VZ_PREFIXES=.*|VZ_PREFIXES=198.18.0.0/24|' /opt/revup/.env && cd /opt/revup && sudo infra/vz-ipsec/install.sh`
2. 🟠 On gw-b: `hostname | grep -q '^central-vz-gw-b$' && sudo sed -i -e 's|^VZ_PEER_IP=.*|VZ_PEER_IP=34.68.252.50|' -e 's|^VZ_PREFIXES=.*|VZ_PREFIXES=198.18.0.0/24|' /opt/revup/.env && cd /opt/revup && sudo infra/vz-ipsec/install.sh`
3. 🟠 Lab PSK — generate on gw-a, print once, paste into §1.1 on BOTH boxes (ids differ per box: gw-a `id-1`=its IKE IP `id-2`=gw-b's, and vice-versa — §1.1 derives them from each box's env): `openssl rand -base64 48`
4. 🟢 Both: `sudo swanctl --list-sas` → `ESTABLISHED` / `INSTALLED` within seconds. `sudo /opt/revup/infra/vz-ipsec/check.sh` → all `ok`, `/healthz 200` on both. Owner: `get-health` both HEALTHY.
5. 🟠 On gw-b, the fake Verizon SBC (runtime only): `hostname | grep -q '^central-vz-gw-b$' && . <(sudo cat /etc/vz-ipsec/vz-gateway.env) && sudo ip addr add 198.18.0.10/32 dev lo && sudo ip route add $VZ_ZONE_SIP/32 dev xfrm-vz && sudo ip route add $VZ_FS1_PUB/32 dev xfrm-vz && sudo ip route add $VZ_FS2_PUB/32 dev xfrm-vz && ip route show dev xfrm-vz`
   (West: also `sudo ip route add 198.18.1.2/32 dev xfrm-vz`.)

### 3.3 NAT + MTU + fragmentation proofs (plan §3.3, §3.4, §11 Phase 2 rehearsal)

Use the FS path — pre-§8 the SBCs do not yet own `.251` on `lo`, so the SIP path is only provable after the platform PR.

1. 🟢 Translation both ways — on the zone FS VM (host, not container): `ping -c3 198.18.0.10` → replies. Meanwhile on gw-a `sudo nft list table ip vz | grep counter` → the `post` FS-1 rule and the `pre` FS-1 rule both count 3; on gw-b `sudo tcpdump -ni xfrm-vz -c3 icmp` shows `35.253.103.114 > 198.18.0.10` (the FS **public** IP, not the NIC — the §2.1 design).
2. 🟢 Checksums are fixed by the kernel (§3.3): on gw-b `sudo tcpdump -ni xfrm-vz -vv -c2 icmp 2>&1 | grep -o 'cksum [^)]*)'` → `(correct)`. On gw-a `sudo nft --debug=netlink list table ip vz 2>&1 | grep -c 'csum_flags 0x1'` → ≥ 6 (one per payload write).
3. 🟢 MTU 1400 on the tunnel: on gw-b `ping -M do -s 1372 -c2 -I 198.18.0.10 35.253.103.114` passes; `ping -M do -s 1373 -c2 -I 198.18.0.10 35.253.103.114` fails with `message too long, mtu=1400`.
4. 🟢 Outer ESP: DF clear + src = IKE IP: on gw-a `sudo tcpdump -ni ens4 -v -c4 esp 2>&1 | grep -E 'flags|ESP'` → `flags [none]` (never `[DF]`) and `34.68.252.50 > 34.171.191.175: ESP`. Also `sudo ip -s xfrm state | grep '^src'` → `src 34.68.252.50 dst 34.171.191.175` on the outbound SA.
5. 🟢 1430-byte UDP "INVITE" arrives as two ≤1400-byte fragments (the §3.4 trap and fix). On the FS VM add the §3.4 per-destination MTU hint by hand (the platform PR does this permanently): `sudo ip route add 198.18.0.0/24 via 192.168.30.1 dev ens4 mtu lock 1400`. Listener on gw-b: `python3 -c 'import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(("198.18.0.10",5060));d,a=s.recvfrom(4096);print(len(d),a)'` (blocks). Capture on gw-a: `sudo tcpdump -ni ens4 -c2 'host 198.18.0.10 and (ip[6:2] & 0x3fff != 0)'`. Send from the FS VM: `python3 -c 'import socket;socket.socket(socket.AF_INET,socket.SOCK_DGRAM).sendto(b"A"*1430,("198.18.0.10",5060))'`. Expect: the capture shows two fragments (`offset 0, flags [+]` ≤1400 B, then `offset 1376`), the listener prints `1430 ('35.253.103.114', …)`. Without the `mtu lock` route the same send leaves at 1458 B with DF and never arrives — run it once to see the failure, then put the route back. Remove at teardown: `sudo ip route del 198.18.0.0/24 via 192.168.30.1 dev ens4 mtu lock 1400`.
6. 🟢 conntrack never loaded during any of this: on both gateways `lsmod | grep -c nf_conntrack` → `0`.
7. 🟢 DPD idle-only: `sudo tcpdump -ni ens4 -c3 'udp port 500'` while traffic flows → nothing; stop traffic → one INFORMATIONAL exchange every ~5 s. Rekeys land in `journalctl -u strongswan` at ~54 min (child) / ~7.5 h (IKE) — leave the lab up long enough to see one child rekey.

### 3.4 Capacity load test (West only, plan §3.6) 🟠 loadtest VM + gw-a CPU

1. On `west-loadtest`: `sudo apt-get install -y iperf3 && iperf3 -s -B 10.138.0.3` (it is "FS-2" to gw-a: `198.18.1.2` → `10.138.0.3`).
2. On gw-b (temporary; purged in §3.6): `sudo apt-get install -y iperf3` then RTP-shaped UDP, 200-byte payloads, one direction ≈ 1,000 calls (100 k pps): `iperf3 -u -c 198.18.1.2 -B 198.18.0.10 -l 200 -b 160M -t 60` and bidirectional `… --bidir`.
3. On gw-a during the run: `mpstat -P ALL 5 3` (apt `sysstat`) or `top -1` — **all inbound decrypt for a tunnel lands on one CPU** (ESP has no ports); record the softirq % of the hottest vCPU at 100 k pps each way and `awk '$2!=0' /proc/net/xfrm_stat` (no `XfrmInStateSeqError` — `replay_window = 128` is the §3.2 reason). Pass bar: no loss reported by iperf3 and the hottest vCPU < 70 %; otherwise the §3.6 resize note applies before acceptance.
4. Optional call-shaped signaling: SIPp UAS on loadtest (`sipp -sn uas -i 10.138.0.3 -p 5060`), SIPp UAC on gw-b (`sipp -sn uac -i 198.18.0.10 -p 5060 198.18.1.2:5060 -r 10 -m 200`) — the banked harness caveat (teardown vs the topology-hiding SBC) does not apply because the UAS is the plain loadtest box.

### 3.5 Failover drill with the drain file 🟠 (control plane; traffic-level survival is a Phase 2 item)

In the lab the fake Verizon sits *on gw-b*, so once the ILB moves to gw-b, FS→198.18.0.10 traffic is sent by gw-b into the tunnel toward gw-a and is correctly dropped there (not a platform destination). The drill therefore verifies HC → ILB → failback timing, not call survival.

1. 🟢 Pre-state: both `check.sh` all-ok; owner `get-health` gw-a HEALTHY, gw-b HEALTHY. Start a 1/s ping on the FS VM: `ping -i1 198.18.0.10` (keep it running; it is the traffic witness).
2. 🟠 Drain gw-a: `hostname | grep -q '^central-vz-gw-a$' && sudo vz-drain.sh on` → prints the consequence and `healthz now: 503`. Note the time.
3. 🟢 Owner: re-run `get-health` until gw-a UNHEALTHY, gw-b HEALTHY — expect ~10–12 s. The ping on the FS stops replying at the moment the route moves (gw-b has no path back to the FS for lab traffic — expected). `sudo nft list table ip vz | grep counter` on gw-b: the `iifname "ens4"` accept rule now counts the FS pings → the ILB really moved.
4. 🟢 Tunnel stayed up through the drain on both: `sudo swanctl --list-sas | grep -c INSTALLED` → `1` on each. (Drain never touches charon.)
5. 🟠 Undrain: `hostname | grep -q '^central-vz-gw-a$' && sudo vz-drain.sh off` → `healthz now: 200`. Owner: `get-health` → gw-a HEALTHY again in ~10–12 s, and the FS ping resumes (**automatic failback** — `failover-ratio 0`, no connection drain). Record both durations in §9.
6. 🟠 Hard variant (rehearses §5's charon kill): `hostname | grep -q '^central-vz-gw-a$' && sudo systemctl kill -s SIGKILL strongswan` → `/healthz` 503 (`sa_up`) within 2 s, ILB moves; on **gw-b** `journalctl -u strongswan -f` shows DPD retransmits and the peer declared dead after ~26 s (plan §3.2: `retransmit_timeout 2.0 / base 1.5 / tries 4`), then `dpd_action = restart` re-initiating until gw-a is back. Restore: `sudo systemctl start strongswan` → SA re-established, `/healthz` 200, ILB fails back.

### 3.6 Teardown — no lab config survives 🔴

Order matters: platform side first, then the gateways, then verify.

1. Owner (workstation): delete `vz-lab-allow-ike`, `vz-lab-allow-fake-vz`; remove tag `vz-west` from `west-loadtest`; leave the `198.18.0.0/24` placeholder route only if it is still the agreed placeholder — it is replaced by the real Verizon prefixes in Phase 2 either way.
2. FS VM: `sudo ip route del 198.18.0.0/24 via 192.168.30.1 dev ens4 mtu lock 1400 2>/dev/null; ip route | grep -c 198.18` → `0`.
3. gw-b runtime lab state: `hostname | grep -q '^central-vz-gw-b$' && sudo ip addr del 198.18.0.10/32 dev lo && sudo ip route flush dev xfrm-vz && sudo apt-get purge -y iperf3 sipp 2>/dev/null; ip addr show lo | grep -c 198.18` → `0`. (`ip route flush dev xfrm-vz` removes the hand-added lab host routes; step 4's `vz-routes` prunes every `proto 42` tunnel route — prefix, blackhole, peer — that the placeholder env no longer wants.)
4. Both gateways, back to the pre-Verizon state (removes the swanctl connection, the forward accepts, the prefix + peer routes; tears the lab SA down): `hostname | grep -q '^central-vz-gw-a$' && sudo sed -i -e 's|^VZ_PEER_IP=.*|VZ_PEER_IP=PLACEHOLDER|' -e 's|^VZ_PREFIXES=.*|VZ_PREFIXES=PLACEHOLDER|' -e 's|^VZ_FS2_NIC=.*|VZ_FS2_NIC=192.168.30.3|' -e 's|^VZ_FS2_PUB=.*|VZ_FS2_PUB=34.63.100.161|' /opt/revup/.env && cd /opt/revup && sudo infra/vz-ipsec/install.sh` (same on gw-b with its guard; West: restore the real FS-2 values `192.168.20.3` / `35.197.95.171`.) Expected: `tunnel config skipped` and `pruning stale route: …` lines for the lab prefix/blackhole/peer routes. `install.sh` hot-reloads charon on a config-only change (the `vz` connection is unloaded, the lab IKE_SA may linger until its rekey), so finish it: `sudo systemctl restart strongswan && sleep 2 && sudo swanctl --list-sas` → empty.
5. Lab PSK: `hostname | grep -q '^central-vz-gw-a$' && sudo rm -f /etc/swanctl/conf.d/secrets.conf && sudo swanctl --load-creds` (same on gw-b). The real PSK is a new file in Phase 2.
6. Verify nothing lab-ish remains, on both: `sudo grep -rl '198\.18\.' /etc/swanctl /etc/nftables.conf /etc/vz-ipsec /opt/revup/.env 2>/dev/null; ip route | grep -E 'xfrm-vz|198\.18|blackhole'; sudo swanctl --list-conns; dpkg -l iperf3 sipp 2>/dev/null | grep '^ii'` → all four empty. Then `sudo /opt/revup/infra/vz-ipsec/check.sh` → pre-Verizon shape (§1 step 5). Reboot one gateway (owner's window) and re-run `vz-status.sh` to prove the lab state did not persist.

## 4. Phase 2 turn-up checks with Verizon (plan §11 Phase 2, per gateway, all six tunnels)

After §1.2 on every gateway. Record each line in §9.

1. 🟢 `sudo swanctl --list-sas` shows exactly `AES_CBC-256/HMAC_SHA2_384_192/PRF_HMAC_SHA2_384/ECP_256` and `AES_GCM_16-256/ECP_256` on every gateway. One-liner: `sudo swanctl --list-sas | grep -oE 'AES_CBC-256/HMAC_SHA2_384_192/PRF_HMAC_SHA2_384/ECP_256|AES_GCM_16-256/ECP_256' | sort -u | wc -l` → `2`. No `[4500]` / `nat-local` anywhere in the output (no NAT-T; plan §11 Phase 0 "remaining check").
2. 🟢 tcpdump: DF clear on outer ESP: `sudo tcpdump -ni ens4 -v -c4 esp 2>&1 | grep -c 'flags \[DF\]'` → `0`.
3. 🟢 `ping -M do -s 1372` passes, `-s 1373` fails (MTU 1400): from the zone FS VM to a Verizon media address inside `VZ_PREFIXES` (Verizon's SE names one that answers ICMP; otherwise their SIP SBC): `ping -M do -s 1372 -c2 <vz-host>` / `ping -M do -s 1373 -c2 <vz-host>` → with the §3.4 `mtu lock 1400` route in place the second fails locally with `mtu=1400`.
4. 🟢 DPD only when idle; rekeys at ~7.5 h / ~54 min: `sudo tcpdump -ni ens4 'udp port 500'` is silent while calls flow and shows one INFORMATIONAL every ~5 s when idle; `journalctl -u strongswan --since -8h | grep -E 'rekey|CHILD_SA vz'` shows child rekeys ~54 min apart and an IKE rekey at ~7.5 h.
5. 🟢 `ip -s xfrm state` outer src = IKE IP: `sudo ip -s xfrm state | grep '^src'` → `src <IKE_IP> dst <peer>` on the out SA. `ip route show table local | grep <IKE_IP>` → both the guest agent's `proto 66` local route and the kernel's address route. `lsmod | grep -c nf_conntrack` == 0. tcpdump of a 1430-B UDP INVITE from the SBC arriving as two ≤1400-B fragments (proves §3.4): on the gateway `sudo tcpdump -ni ens4 -c2 'src host 10.x.0.251 and (ip[6:2] & 0x3fff != 0)'` while a real (or Homer-replayed) >1400 B INVITE goes out — two fragments, first ≤1400 B.
6. 🟢 U1/U2 traces (plan §8.6) — SIP-side, owned by the platform PR; not a gateway check.
7. 🟠 Failover drill **with Verizon live**, per zone — §5 below. Repeat with a hard stop of charon (measures the §3.2 detection time).

## 5. Failover drill with Verizon live 🟠 (quiet hours; per zone; monthly + after any gateway change)

1. 🟢 Pre-state: §2 on both gateways; owner `get-health` gw-a HEALTHY, gw-b HEALTHY. Establish a Verizon test call (TFN or DID, plan Phase 3 list) and keep it up through the flip; start a second phone ringing just before step 2 (in-flight case).
2. 🟠 Drain gw-a: `hostname | grep -q '^central-vz-gw-a$' && sudo vz-drain.sh on`. Note the time.
3. 🟢 Owner `get-health` until gw-a UNHEALTHY / gw-b HEALTHY (~10–12 s). Our outbound (SBC/FS → Verizon) now leaves via **gw-b**; Verizon keeps sending on **tunnel A** until its own DPD/preference fires — **measure that** (plan §2.3, §10 #15): on gw-a `sudo nft list table ip vz | grep -A1 'chain vz_pre'` counters keep moving until Verizon switches; on gw-b the same counters start. Established call: audio gap = the time between the two; record it. In-flight ringing call: note whether it completes or must be redialed.
4. 🟢 Established call survives (stateless NAT on both): hang up normally → Homer shows a single BYE/200. New call via gw-b completes.
5. 🟠 Undrain: `hostname | grep -q '^central-vz-gw-a$' && sudo vz-drain.sh off` → ILB fails back in ~10–12 s; Verizon moves back on its own schedule. Record.
6. 🟠 Hard-stop variant (detection time, plan §3.2): `hostname | grep -q '^central-vz-gw-a$' && sudo systemctl kill -s SIGKILL strongswan` — `/healthz` 503 in ≤2 s, ILB moves in ~10–12 s; Verizon declares tunnel A dead on **its** timers (ask for them, §10). Restore `sudo systemctl start strongswan`; SA re-establishes (`keyingtries = 0`), ILB fails back. Record both numbers.
7. 🟢 Log it in §9.

**Expected alerting:** the gateway backend HC-log page fires within ~1 min of step 2 — that is the alert working. Nothing else should fire.

## 6. Patching a gateway (OS updates, config upgrades, resizes) 🟠 — drain first, ONE gateway at a time

1. 🟢 Both gateways healthy (§2 / owner `get-health`). Never patch while the other gateway is unhealthy.
2. 🟠 `hostname | grep -q '^central-vz-gw-a$' && sudo vz-drain.sh on` → wait for owner `get-health` to show the flip (~10–12 s) **and** for Verizon to move (watch the `pre` counters go quiet, §5 step 3).
3. 🟠 Patch: `sudo apt-get update && sudo apt-get -y upgrade` (kernel/strongSwan updates → `sudo reboot`; a reboot clears the drain, so re-apply it right after boot if you still need the box out), or config: `cd /opt/revup && sudo git pull && sudo infra/vz-ipsec/install.sh`. A resize is a stop/start by the owner — drain first exactly the same way.
4. 🟢 `sudo /opt/revup/infra/vz-ipsec/check.sh` → all `ok` except `/healthz 503` with only `not_drained` failed.
5. 🟠 `sudo vz-drain.sh off` → 200 → failback. Owner `get-health` both HEALTHY. Then the other gateway.

## 7. Rollback

- **Config regression after `git pull` + `install.sh`:** drain, `cd /opt/revup && sudo git checkout <last-good-sha> -- infra/vz-ipsec && sudo infra/vz-ipsec/install.sh`, `check.sh`, undrain. The installer only overwrites its own files, so the directory *is* the rollback unit. Restore the branch afterwards: `sudo git checkout RCF-V1 -- infra/vz-ipsec`.
- **Bad `.env` row:** `install.sh` refuses it before touching anything (validator). If a wrong-but-valid row got in, fix `.env` and re-run — every route/address is `replace`d, the generated `/etc/vz-ipsec/vz-gateway.env` is rewritten.
- **Take a gateway out for good (until fixed):** `sudo vz-drain.sh on` is enough — the ILB routes around it and nothing on the box is lost. Do not stop `vz-healthd`: a dead HC is the same signal but you lose the `failed[]` detail.
- **Zone-level:** both gateways unhealthy = the VPC route is NOT withdrawn, packets drop (plan §2.3 caveat). Verizon then fails over by *its* Term Routing to another zone. Nothing to do on the box; fix the cause.

## 8. Troubleshooting

| Symptom | Where to look | Likely cause / fix |
|---|---|---|
| `/healthz` 503 `sa_up` | `sudo swanctl --list-sas`, `journalctl -u strongswan -n50` | No PSK (`no shared key found`): §1.1. `NO_PROPOSAL_CHOSEN`: Verizon's profile ≠ `aes256-sha384-ecp256` / `aes256gcm16-ecp256` — confirm IKE v2 H19 RM Opt2 with the SE, do not loosen proposals. `AUTHENTICATION_FAILED`: IKE-ID mismatch — set `VZ_PEER_ID`/`VZ_LOCAL_ID` to what Verizon uses ("General IKE-ID", plan §3.2). Silence: firewall `vz-ipsec-allow-ike` missing or peer wrong. |
| `swanctl` shows `[4500]` or `nat-local` | `sudo swanctl --list-sas` | NAT detected → UDP encap → §3.4 MTU margin gone. Means the IKE IP is not the real source: `ip -4 addr show ens4` must list `IKE_IP/32`; `ip route show default` must say `src IKE_IP`; `systemctl restart vz-routes`. Also `mobike = no`, `encap = no` must be in `/etc/swanctl/conf.d/vz.conf`. |
| 503 `route_ok` | `ip route show dev xfrm-vz`, `ip route get <prefix>` | Pre-Verizon placeholder (expected), or `vz-routes` failed: `systemctl status vz-routes`, `journalctl -u vz-routes`. If the blackhole (`metric 200`) wins, `xfrm-vz` is gone: `networkctl status xfrm-vz`, `systemctl restart systemd-networkd vz-routes`. |
| 503 `xfrm_up` | `ip -d link show xfrm-vz` | Interface missing (networkd not running / `.netdev` not applied → `networkctl reload`) or MTU ≠ 1400 (something re-set it: `ip link set xfrm-vz mtu 1400`). |
| 503 `nft_ok` | `sudo nft -c -f /etc/nftables.conf`, `systemctl status nftables` | Ruleset failed to load — a `ct`/`nat` token would fail *because* conntrack is refused (correct!). Fix the template, never the blacklist. |
| 503 `nostates_ok` | `awk '$2!=0' /proc/net/xfrm_stat`, `sudo ip xfrm policy` | Packets routed into `xfrm-vz` with no SA to carry them: tunnel down/rekey hiccup, or `if_id` mismatch (`VZ_IF_ID` vs `InterfaceId` — both 42). Resolves itself when the SA is back; persistent = `swanctl --list-sas` vs `ip xfrm state` disagree → `systemctl restart strongswan` (drained). |
| 503 `not_drained` | `ls -l /run/vz-drain` | Somebody drained it: `sudo vz-drain.sh off` when intended. |
| HC fails but `curl 127.0.0.1:8081/healthz` is 200 | `ip route show table local \| grep <ILB_IP>`, `ss -ltnp \| grep 8081` | ILB address not local (probe gets forwarded out ens4): `systemctl restart vz-routes`. Firewall `vz-ipsec-allow-hc` (35.191.0.0/16, 130.211.0.0/22 → tcp:8081) missing. |
| Calls one-way / no audio via Verizon | gw: `sudo nft list table ip vz \| grep counter`; FS: SDP `c=` | `pre`/`post` FS counters not moving → Verizon routes media to an address that is not `VZ_FS*_PUB` (plan §2.1 open question → fallback design), or the FS public IP changed. Both FS rules must count. |
| SIP from Verizon reaches the gateway but not the SBC | gw `pre` counter moves, `fwd` accept does not | Source not in `VZ_PREFIXES` (forward drops it) → get the full prefix list from the SE; or `.251` backend unhealthy (Kamailio `:8080` bind, plan §4.1). |
| INVITE > 1400 B from us never answered | Homer retransmits; gw `tcpdump -ni ens4 'ip[6:2] & 0x3fff != 0'` sees no fragments | The §3.4 `mtu lock 1400` per-destination route is missing on that SBC/FS (platform PR) — the SBC sends 1458 B DF and the ICMP never reaches Kamailio. |
| `XfrmInStateSeqError` climbing | `/proc/net/xfrm_stat`, node_exporter xfrm panel | Replay-window drops under reorder: `replay_window = 128` present in vz.conf? Verizon ECMP burst larger than 128 → discuss with SE before raising. |
| `lsmod` shows `nf_conntrack` | `lsmod \| grep nf_`, `dpkg -l \| grep -E 'docker\|containerd'` | Something loaded it before the blacklist (Docker, iptables tooling). Remove the cause, `modprobe -r`, else reboot (drained). This gateway is invalid until it reads 0 (plan §3.3). |
| apt / curl hang (no internet) | `ip route show default`, `curl --interface <IKE_IP> https://ifconfig.me` | Default route lost `src IKE_IP` (DHCP re-bound): `systemctl restart vz-routes`. West/Central have no Cloud NAT — the forwarded IP is the only internet path (plan §4.1). |
| charon logs `rfc4106` software fallback / high CPU | `grep -A3 'rfc4106(gcm' /proc/crypto` | Driver not `rfc4106-gcm-aesni`: `modprobe aesni_intel`; if the VM type lacks AES-NI exposure, that is a machine-type problem (n2-standard-2 has it). |

## 9. Drill log

| Date | Zone | Drill (§3.5 lab / §5 live / §5 hard-stop / §6 patch) | Flip detected (s) | Verizon moved (s) | Audio gap (s) | In-flight call | Failback (s) | Notes |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
