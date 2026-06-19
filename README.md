# revup — Voice Platform (branch directory)

> **`main` is the shared-ancestor / default branch and is NOT a deployed system.**
> It is the pre-split history and is far behind active work. The live systems and
> all current development are on **`RCF-V1`** and **`unified`** — start there.

## Branches

| Branch | What it is | Deployed | Has UCaaS / WebRTC? |
|---|---|---|---|
| **`RCF-V1`** | **Production** Remote Call Forwarding platform — RCF + SIP trunks + API-calling backend, hardened for live carrier traffic. Deployed as 4 VMs in GCP `us-east1-b`. | **Production** | No |
| **`unified`** | RCF-V1 base **+** the full UCaaS stack (WebRTC/Verto softphone, voicemail, conferencing, chat/presence, IVR builder, call recordings, queues) **+** a read-only replica of prod's DID inventory. Runs on a single all-in-one **sandbox** VM. | Sandbox | Yes |
| `Full-System` | **Legacy.** Superseded by `unified` — `unified` descends from it and is 255+ commits ahead; Full-System has nothing `unified` lacks. Safe to archive. | No | Yes (legacy) |
| `main` (this branch) | Shared ancestor / default branch. Stale (behind `unified`). Not deployed. | No | — |

## Where to go

```bash
git checkout RCF-V1     # production: RCF only, 4-VM GCP deploy
git checkout unified    # full stack: RCF-V1 + UCaaS, single-VM sandbox
```

Each of those branches has a **detailed README** describing exactly what is built
there, how it deploys, and its service inventory. To read one without switching:

```bash
git show RCF-V1:README.md
git show unified:README.md
```

## Key rule

RCF customers only ever see RCF. UCaaS surfaces (api/trunk/hybrid/ucaas account
types) live on `unified`. **Production stays RCF-only until UCaaS is promoted.**
