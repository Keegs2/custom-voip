# infra/vz-ipsec-gcp — Verizon IPsec GCP objects (import-only until acceptance)

The Verizon IPsec trunking design (`docs/VERIZON_IPSEC_TRUNKS_PLAN.md`) was built
**by hand with gcloud on 2026-10-30** in all three zones. This standalone stack is
the OpenTofu definition of exactly those objects, with an `import` block for every
one of them, so that after the Verizon turn-up is accepted they land in state
without being touched. Its first apply creates nothing; it records.

State: `gs://revup-tofu-state`, prefix `voip-vz-ipsec` (own root module, own state —
a plan here can never touch the monitoring/voicemail/backups stacks or the pending
`voip-region` import; `infra/OPENTOFU_PLAN.md` §20).

## What it owns (54 objects)

| Per zone (× East / West / Central) | Names |
|---|---|
| 3 reserved external IPs — 2 IKE peers + 1 inside-tunnel SIP (never attached) | `{zone}-vz-ike-a`, `{zone}-vz-ike-b`, `{zone}-vz-sip` |
| 1 gateway subnet /28, Private Google Access on, not NATed | `vz-ipsec-{zone}` |
| 2 gateway VMs (n2-standard-2, Debian 12, no external IP, `can_ip_forward`, deletion-protected, tags `bypass-vpn` + `vz-ipsec`) | `{zone}-vz-gw-a` / `-b` (two zones of the region; Central is `-a`/`-f`) |
| 2 target instances + 2 external L3_DEFAULT all-ports protocol-forwarding rules on the IKE IPs | `{zone}-vz-gw-{a,b}-ti`, `{zone}-vz-gw-{a,b}-fwd` |
| 2 unmanaged instance groups (gw-a primary, gw-b failover) | `{zone}-vz-gw-{a,b}-group` |
| 1 regional HTTP :8081 `/healthz` check (5s/5s/2/2) | `{zone}-vz-gw-hc` |
| 1 INTERNAL/UDP backend service, failover-ratio 0, drop-if-unhealthy, no drain | `{zone}-vz-gw-backend` |
| 1 next-hop ILB forwarding rule (UDP, all ports, in the /28) | `{zone}-vz-gw-ilb` = 192.168.11.4 / 21.4 / 31.2 |
| 1 SBC Verizon VIP backend service over the EXISTING SBC groups + fs-aware HC (INTERNAL/UNSPECIFIED, same failover policy) | `sbc-verizon-backend` / `west-…` / `central-…` |
| 1 SBC Verizon VIP forwarding rule (L3_DEFAULT, all ports, region `default` subnet) | `sbc-verizon-fwd` / `west-…` / `central-…` = 10.142/138/128.0.251 |

| Shared | Names |
|---|---|
| 3 ingress firewall rules to tag `vz-ipsec` | `vz-ipsec-allow-iap-ssh` (IAP → tcp/22), `vz-ipsec-allow-hc` (GCP probers → tcp/8081), `vz-ipsec-allow-internal-fwd` (SBC/FS/gateway subnets → all) |

Every name, IP and zone comes from the ONE map in `locals.tf` (`local.zones`), which
is the as-built ground truth from the plan's §2.2 / §4.1 — change it only when GCP
reality changes. The per-gateway resources `for_each` over the derived
`local.gateways` ("east-a" … "central-b").

## What this stack does NOT own (and why)

- **The `vz-{zone}` network tags on the 12 production SBC/FS VMs** (East
  `poc-custom-voip`, `kam-g2`, `fs-media-v2`, `east-fs-2`; West `west-sbc-1/2`,
  `west-fs`, `west-fs-2`; Central `central-sbc-1/2`, `central-fs`, `central-fs-2`).
  Those VMs are not under Tofu yet (Phase 5 import of the `voip-region` module). The
  tag belongs to each VM's `tags` list and will be defined there when the VMs are
  imported; until then it stays a gcloud fact. `output.route_tags` records the names.
- **The existing SBC instance groups and fs-aware health checks** that the
  `.251` backends point at (`sbc-group`, `sbc-standby-group`, `east-sbc-fs-aware-hc`,
  `west-sbc-healthz-hc`, `central-sbc-fs-aware-hc`, …). Referenced by data source /
  self_link only; they are Phase 4b resources (`OPENTOFU_PLAN.md` §18).
- **The three Verizon-prefix firewall rules and the tagged `next_hop_ilb` routes**
  (`vz-ipsec-allow-ike`, `vz-allow-verizon-sip`, `vz-allow-verizon-rtp`,
  `vz-{zone}-<prefix>`). Not created yet — they need Verizon's peer IPs and prefixes
  (plan §10). They ship as **commented-out stubs** in `verizon_prefixes.tf` with
  their variables (`verizon_ike_peers`, `verizon_sip_prefixes`,
  `verizon_media_prefixes`) already declared: fill tfvars, uncomment, plan (adds
  only), apply.
- **The Cloud NAT `ted-auto-dialer-nat`**, the `default` network/subnets, the SBC
  signaling ILBs. Shared-project (TED) resources; referenced, never managed.
- **Anything on the gateways**: strongSwan/swanctl config, NAT rules, the health
  service, and above all the **IKE PSKs — never here, never in git**; they live only
  in swanctl secrets on the gateways.

## Import procedure (acceptance-gated — do not run before the Verizon good-to-go)

The owner runs this from the workstation (single lines). Nothing here needs a VM.

1. `cd infra/vz-ipsec-gcp && tofu init` — GCS backend, prefix `voip-vz-ipsec`.
2. Optional: `python3 check_ids.py --gcloud` prints one `describe --format='value(selfLink)'`
   per object; each selfLink must END with the id shown above it. `--ids` prints bare ids.
3. `tofu plan` — the ONLY acceptable summary is
   **`Plan: 54 to import, 0 to add, 0 to change, 0 to destroy.`**
   (`terraform.tfvars` may be absent; every default is the as-built value.)
4. `tofu apply` — writes the 54 objects into state. Nothing in GCP changes.
5. Delete the blocks in `imports.tf` (import blocks are one-shot) and `tofu plan`
   once more: **`No changes.`**

### If the plan shows anything other than 54 imports

Stop. Do not apply. A `change` or `destroy` means the HCL and reality disagree —
reconcile the HCL, never let Tofu "fix" a live tunnel endpoint. How to read it:

| Plan says | Meaning | Fix |
|---|---|---|
| `must be replaced` on an address / VM / subnet | a pinned value (`address`, `network_ip`, `ip_cidr_range`, zone, disk type) in `locals.tf`/`main.tf` differs from GCP | `prevent_destroy` already blocks it; copy the real value from `gcloud … describe` into the HCL |
| in-place `service_account` change on the six VMs | gcloud attached different scopes (or no SA) than `var.gateway_service_account` assumes | paste `gcloud compute instances describe … --format='yaml(serviceAccounts)'` into `terraform.tfvars` (or set the variable to `null`); never apply it — it would need a stop/start |
| in-place `description` change on anything | gcloud was run with a `--description` the repo does not record | copy the text into the resource, or add `description` to that resource's `ignore_changes` (already done for the nine addresses) |
| `failover_policy.disable_connection_drain_on_failover: true → false` | the API stored `false` for a UDP/UNSPECIFIED backend despite `--no-connection-drain-on-failover` | set it to `false` in `main.tf` for that backend — reality wins |
| `nic_type`, `boot_disk.initialize_params.size/type`, `tags` on a VM | the VM was built with other values than the plan's §4 table | copy the real value; a `type`/`nic_type` change is a replacement (blocked) |
| anything `to add` | an object in `main.tf` has no import block, or its id does not match | fix `imports.tf` (ids must be the exact `projects/…` form); `check_ids.py` lists them |
| a data source error (`sbc-group` / `*-fs-aware-hc` not found) | the Phase 4b names in `locals.tf` are wrong for that zone | confirm with `gcloud compute instance-groups unmanaged list` / `gcloud compute health-checks list --format='table(name,region,type)'` |

What is already tolerated so the plan is clean: the boot image resolves from the
`debian-12` family to a dated image on import (`ignore_changes` on `image`); VM
`metadata` and `labels` are ops-managed outside Tofu; backend-service
`connection_draining_timeout_sec` is left as the API has it (google 5.x defaults it
to 0, the API to 300; meaningless for UDP/SIP).

## Never destroy

`prevent_destroy` is on all nine addresses (they are on Verizon's order form — losing
one means a new form and a new tunnel) and on the six gateway VMs (which also carry
GCE `deletion_protection`). Never run `tofu destroy` here or in any stack
(`OPENTOFU_PLAN.md` §11). To retire an object, remove it from state with
`tofu state rm` first and delete it by hand, deliberately.

## Later changes through this stack

- Gateway resize (plan §11 Phase 4): drain the gateway first (HC fails → ILB moves),
  then change `machine_type` — the plan will refuse without `allow_stopping_for_update`;
  that refusal is intentional. Do the stop/resize/start by hand behind the drain, then
  update the HCL to match.
- Verizon prefixes: `verizon_prefixes.tf` (see above). The routes are three
  identical destination+priority sets distinguished only by the `vz-{zone}` tag, so
  each zone's traffic stays in its own tunnel pair.
- The `voip-region` Phase 5 import may later absorb the `.251` backends/rules next to
  the signaling ILBs; if so, `tofu state mv` them across prefixes rather than
  re-importing.
