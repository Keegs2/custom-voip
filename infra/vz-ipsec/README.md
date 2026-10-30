# infra/vz-ipsec — Verizon IKEv2 gateway stack (six Debian 12 VMs)

**What this is:** the on-box configuration for the `{zone}-vz-gw-{a,b}` strongSwan gateways that terminate Verizon's IKEv2 tunnels in GCP for RCF-V1 (SIP Gateway 2-Way + ATF-IP). Design + spec: `docs/VERIZON_IPSEC_TRUNKS_PLAN.md` (§2 architecture, §3 gateway configuration, §4.1 as-built, §11 build order). Operations: `docs/runbooks/VERIZON_GATEWAY_RUNBOOK.md`.

Each gateway is a plain Debian 12 VM — **no Docker, no compose** (plan §3.3: Docker loads conntrack + iptables NAT, which would silently break the stateless NAT). Deploy is the fleet convention: repo at `/opt/revup`, `sudo git pull`, run `install.sh`. One `.env` per VM at `/opt/revup/.env`, no secrets in it.

What a gateway does (plan §2, §3): owns a protocol-forwarded public **IKE IP** on `ens4`; runs one IKEv2/ESP tunnel to Verizon bound to the IP-unnumbered **`xfrm-vz`** interface (MTU 1400); translates **1:1, statelessly** between what Verizon sees (zone SIP IP, FS public IPs) and the VPC (SBC Verizon VIP `.251`, FS NIC IPs) with nftables payload mangling; forwards nothing else; and answers the next-hop ILB's health check on **:8081** only while the whole datapath is good.

## Files

| Repo file | Installed to | What |
|---|---|---|
| `install.sh` | — | Idempotent installer (run as root after `git pull`). Also `--render-only ENV OUTDIR` for review/CI. |
| `check.sh` | — | `make check`: static checks anywhere (`--local`), full checks on a gateway (`nft -c`, `swanctl --list-conns`, `systemd-analyze verify`, invariants, health). |
| `env.example` | `/opt/revup/.env` (operator copies) | The env contract, every variable commented. |
| `examples/central-vz-gw-a.env` | — | Sample used by `check.sh --local` (real as-built values, placeholder peer/prefixes). |
| `templates/swanctl.conf.tmpl` | `/etc/swanctl/conf.d/vz.conf` (0600) | Connection `vz`, exactly plan §3.2. **Omitted** while peer/prefixes are placeholders. |
| `templates/secrets.conf.example` | — (never installed) | Shape of the operator-created PSK file. |
| `templates/charon.conf` | `/etc/strongswan.d/zz-vz.conf` | charon: fast dead-peer detection (~26 s), `install_routes=no`, `install_virtual_ip=no`, `interfaces_use=ens4`. |
| `templates/10-xfrm-vz.netdev.tmpl`, `10-xfrm-vz.network` | `/etc/systemd/network/` | `xfrm-vz`: `Kind=xfrm`, `InterfaceId=42`, `Independent=yes`, MTU 1400, no address. networkd manages **only** this interface; ens4 stays on the GCE guest DHCP path. |
| `templates/nftables.conf.tmpl` | `/etc/nftables.conf` | Plan §3.3 rule-for-rule (+ `counter` on each rule for `vz-status.sh`). No `ct`/`nat` anywhere. Pre-Verizon render omits the two forward accepts (policy drop stands). |
| `sysctl.d/99-vz.conf` | `/etc/sysctl.d/99-vz.conf` | `ip_forward=1`, `rp_filter=2`, redirects off. (`xfrm-vz` rp_filter is set by `vz-routes.sh` once the iface exists.) |
| `modprobe.d/vz-no-conntrack.conf` | `/etc/modprobe.d/` | `blacklist` **and** `install … /bin/false` for nf_conntrack, nf_nat, nft_ct/nat, xt_* — refuses conntrack even as a dependency. |
| `templates/chrony-google.sources` | `/etc/chrony/sources.d/vz-google.sources` | chrony → metadata server. |
| `vz-routes.sh` + `systemd/vz-routes.service` | `/usr/local/sbin/`, `/etc/systemd/system/` | Oneshot after network-online, before charon: IKE IP on ens4; default route `src IKE_IP`; `10/8` + `192.168/16` `src NIC_IP`; ILB address `local` on `lo`; per-prefix `dev xfrm-vz` + `blackhole … metric 200`; `/32` peer host route. |
| `vz-healthd.py` + `systemd/vz-healthd.service` | `/usr/local/sbin/`, `/etc/systemd/system/` | `GET /healthz` on `0.0.0.0:8081` (plan §3.5) + node_exporter textfile `vz_ipsec.prom`. |
| `vz-status.sh`, `vz-drain.sh` | `/usr/local/sbin/` | One-screen status; drain on/off. |
| `systemd/strongswan.service.d/vz.conf` | `/etc/systemd/system/strongswan.service.d/` | Orders charon after `vz-routes`. |
| `systemd/prometheus-node-exporter.service.d/vz.conf.tmpl` | `/etc/systemd/system/prometheus-node-exporter.service.d/vz.conf` | `--collector.xfrm`, textfile dir, listen on the NIC IP only. |
| (generated) | `/etc/vz-ipsec/vz-gateway.env` (0640) | Validated, normalised, secret-free copy of the contract that the units read. Never edit; re-run `install.sh`. |

## The per-gateway `.env` contract (`/opt/revup/.env`)

All required unless marked optional. `install.sh` refuses to run with a placeholder in anything **except** `VZ_PEER_IP` / `VZ_PREFIXES` (pre-Verizon bring-up: everything is installed, the swanctl connection is left out, the forward chain has no accepts, and it prints `tunnel config skipped: peer/prefixes are placeholders`).

| Variable | Meaning | Plan |
|---|---|---|
| `VZ_ZONE` | `east` / `west` / `central` | §2.2 |
| `VZ_GW` | `a` / `b` (a = ILB primary group, b = failover) | §2.3 |
| `VZ_NIC_IP` | ens4 VPC IP on `vz-ipsec-{zone}` (192.168.x1.0/28) | §4.1 |
| `VZ_IKE_IP` | this gateway's protocol-forwarded public IKE IP (`{zone}-vz-ike-{gw}`) | §2.1, §3.1 |
| `VZ_SUBNET_GW` | the /28's gateway (`192.168.x1.1`) | §3.1 |
| `VZ_GW_ILB_IP` | zone next-hop ILB address — added as a `local` route on `lo` for VIP-addressed health probes | §3.5, §4.1 |
| `VZ_ZONE_SIP` | zone in-tunnel SIP source IP (`{zone}-vz-sip`, never attached) | §2.1 |
| `VZ_SBC_VIP` | SBC Verizon VIP `10.x.0.251` | §2.1 |
| `VZ_SBC1_IP`, `VZ_SBC2_IP` | the two SBCs' VPC IPs (may source in-dialog traffic) | §3.3 |
| `VZ_FS1_NIC`, `VZ_FS1_PUB`, `VZ_FS2_NIC`, `VZ_FS2_PUB` | FS media NIC ⇄ existing public IP pairs | §2.1 |
| `VZ_PEER_IP` | Verizon's IKE peer for this tunnel — **PLACEHOLDER until the SE answers** | §10 |
| `VZ_PREFIXES` | comma list of Verizon SIP + media prefixes — **PLACEHOLDER until the SE answers** | §10 |
| `VZ_PEER_ID` (optional) | Verizon's IKE-ID; default `VZ_PEER_IP` | §3.2 |
| `VZ_LOCAL_ID` (optional) | our IKE-ID; default `VZ_IKE_IP` | §3.2 |
| `VZ_IF_ID` (optional) | xfrm interface id; default `42` | §3.2 |
| `VZ_DRAIN_FILE` (optional) | default `/run/vz-drain` (tmpfs — a reboot always comes back undrained) | §3.5 |

### Per-gateway values (as-built 2026-10-30, plan §2.2 + §4.1) — copy one row

Common to all three zones: `VZ_IF_ID=42`, `VZ_DRAIN_FILE=/run/vz-drain`, `VZ_PEER_IP=PLACEHOLDER`, `VZ_PREFIXES=PLACEHOLDER` (until Verizon's SE delivers §10 #1/#2).

| Gateway | `VZ_ZONE` | `VZ_GW` | `VZ_NIC_IP` | `VZ_IKE_IP` | `VZ_SUBNET_GW` | `VZ_GW_ILB_IP` |
|---|---|---|---|---|---|---|
| `east-vz-gw-a` (us-east1-b) | east | a | 192.168.11.2 | 35.231.206.85 | 192.168.11.1 | 192.168.11.4 |
| `east-vz-gw-b` (us-east1-c) | east | b | 192.168.11.3 | 34.26.69.151 | 192.168.11.1 | 192.168.11.4 |
| `west-vz-gw-a` (us-west1-b) | west | a | 192.168.21.2 | 8.231.131.118 | 192.168.21.1 | 192.168.21.4 |
| `west-vz-gw-b` (us-west1-c) | west | b | 192.168.21.3 | 136.66.170.29 | 192.168.21.1 | 192.168.21.4 |
| `central-vz-gw-a` (us-central1-**a**) | central | a | 192.168.31.**4** | 34.68.252.50 | 192.168.31.1 | 192.168.31.**2** |
| `central-vz-gw-b` (us-central1-**f**) | central | b | 192.168.31.**5** | 34.171.191.175 | 192.168.31.1 | 192.168.31.**2** |

Zone values (identical on a and b):

| Zone | `VZ_ZONE_SIP` | `VZ_SBC_VIP` | `VZ_SBC1_IP` | `VZ_SBC2_IP` | `VZ_FS1_NIC` | `VZ_FS1_PUB` | `VZ_FS2_NIC` | `VZ_FS2_PUB` |
|---|---|---|---|---|---|---|---|---|
| east | 34.148.100.185 | 10.142.0.251 | 10.142.0.100 | 10.142.0.101 | 192.168.10.2 | 34.139.119.135 | 192.168.10.3 | 35.196.226.123 |
| west | 136.86.242.57 | 10.138.0.251 | 10.138.0.100 | 10.138.0.101 | 192.168.20.2 | 8.229.177.165 | 192.168.20.3 | 35.197.95.171 |
| central | 35.184.132.124 | 10.128.0.251 | 10.128.0.100 | 10.128.0.101 | 192.168.30.2 | 35.253.103.114 | 192.168.30.3 | 34.63.100.161 |

Note the Central quirks: gw-a/gw-b are in us-central1-**a**/**f** at 192.168.31.**4**/**5** and the ILB is 192.168.31.**2** (b/c were stocked out of n2-standard-2; plan §2.2).

## Install / upgrade / rollback

**Install** (per gateway, as root; the repo is already cloned at `/opt/revup` on the VM):

1. Write `/opt/revup/.env` from `env.example` with this gateway's row (above). No secrets in it.
2. `cd /opt/revup && sudo git pull && sudo infra/vz-ipsec/install.sh`
3. `sudo infra/vz-ipsec/check.sh`

`install.sh` validates the contract, aborts if Docker is present, installs `strongswan-swanctl charon-systemd nftables chrony prometheus-node-exporter` (+ `tcpdump curl` for the runbook), purges the legacy `strongswan-starter` if found, checks `/proc/crypto` for `rfc4106-gcm-aesni` (warns on software GCM — ~10× slower, plan §3.2), renders the templates, refuses any unresolved `${…}`, applies sysctl, then enables/starts in order: `systemd-networkd` (creates `xfrm-vz`) → `vz-routes` → `nftables` (after `nft -c`) → `strongswan` → `vz-healthd` → node_exporter/chrony, and ends with `vz-status.sh`. Boot-time ordering is in the units themselves; `nftables.service` keeps Debian's early (`network-pre`) slot — the ruleset matches interfaces by name and needs nothing to exist first.

**Upgrade:** drain first (one gateway at a time — runbook §5), then `sudo git pull && sudo infra/vz-ipsec/install.sh`. charon is restarted **only** when `zz-vz.conf` changed or it was not running; otherwise the connection is hot-reloaded with `swanctl --load-all`. Undrain after `check.sh` passes.

**Rollback:** drain, `cd /opt/revup && sudo git checkout <previous-good-sha> -- infra/vz-ipsec && sudo infra/vz-ipsec/install.sh`, `check.sh`, undrain, then `sudo git checkout RCF-V1 -- infra/vz-ipsec` once the fix is in. The installer only ever overwrites its own files, so rolling back the directory rolls back the box.

## Health check and drain (plan §3.5)

`vz-healthd` serves `GET /healthz` on `0.0.0.0:8081`. The next-hop ILB's HC (`{zone}-vz-gw-hc`, 5 s / 2 failures) probes the **ILB address**, which `vz-routes.sh` makes local on `lo` — without that, `ip_forward` would forward the probe back out ens4. `200` only when ALL hold; otherwise `503` with a JSON body listing `failed`:

| Check | Means |
|---|---|
| `sa_up` | `swanctl --list-sas --raw` shows CHILD_SA `vz` `INSTALLED` |
| `xfrm_up` | `xfrm-vz` is UP with MTU 1400 |
| `route_ok` | `ip route get <first prefix>` resolves via `xfrm-vz` (false while prefixes are placeholders — expected pre-Verizon) |
| `nft_ok` | `nft list table ip vz` succeeds |
| `nostates_ok` | `XfrmOutNoStates` in `/proc/net/xfrm_stat` did not increase in the last 30 s (black-hole detector) |
| `not_drained` | `/run/vz-drain` absent |

Not a check, on purpose: inbound ESP byte growth (Verizon will likely use only its preferred tunnel).

The same booleans go to `/var/lib/node_exporter/textfile_collector/vz_ipsec.prom` every 2 s (`vz_ipsec_sa_up{zone,gw}`, `vz_ipsec_xfrm_up`, `vz_ipsec_route_ok`, `vz_ipsec_nft_ok`, `vz_ipsec_nostates_ok`, `vz_ipsec_drained`, `vz_ipsec_healthy`, plus `vz_ipsec_udp_encap` and the raw `vz_ipsec_xfrm_out_no_states_total`). node_exporter (NIC IP `:9100`) also runs `--collector.xfrm` for the kernel counters (`node_xfrm_in_state_seq_error` = replay drops, `node_xfrm_out_no_states` = black hole). Adding the six gateways as scrape targets to the monitoring stack is a separate change.

**Drain** = deliberate failover: `sudo vz-drain.sh on` touches the drain file → `/healthz` 503 within ~2 s → the ILB moves the zone's Verizon traffic to the other gateway in ~10–12 s. The tunnel stays up (Verizon keeps sending on it until its own DPD/preference moves; the stateless NAT means replies still work from either box). `sudo vz-drain.sh off` → 200 → automatic failback to gw-a (`failover-ratio 0`, no drain). The file is in `/run`, so a reboot comes back undrained.

## Where the PSK lives

`/etc/swanctl/conf.d/secrets.conf`, mode `0600 root:root`, **created by the operator on each gateway** — never in git, OpenTofu, or `/opt/revup/.env` (plan §3.2). One tunnel = one PSK; `id-1` = our IKE IP, `id-2` = Verizon's peer, so the secret binds to this tunnel only. Shape: `templates/secrets.conf.example`. The runbook §1 has the paste-ready command (reads the PSK with `read -rs` so it never lands in shell history). After writing it: `sudo swanctl --load-creds`. `install.sh` warns (does not fail) when the file is missing or not 0600 in tunnel mode.

## Invariants (check.sh enforces)

- `lsmod | grep -c nf_conntrack` == 0 and no Docker — ever (§3.3, §11 Phase 2).
- No `ct`/`nat`/`masquerade`/`redirect`/`notrack` token in `/etc/nftables.conf`.
- `xfrm-vz` UP MTU 1400, no address; IKE IP on ens4; default route `src IKE_IP`; ILB address local on `lo`; routing table 220 empty (charon installs no routes).
- SA algorithms exactly `AES_CBC-256/HMAC_SHA2_384_192/PRF_HMAC_SHA2_384/ECP_256` + `AES_GCM_16-256/ECP_256`; no `[4500]`/`nat-local` (no NAT-T — the §3.4 MTU arithmetic has 4 bytes of margin).
