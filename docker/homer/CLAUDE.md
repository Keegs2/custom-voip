# Homer — SIP Capture & Debugging

## Overview

Homer 7 SIP monitoring stack for real-time SIP trace analysis and call debugging.
Receives HEP (Homer Encapsulation Protocol) packets from Kamailio and FreeSWITCH,
stores them in a dedicated PostgreSQL instance, and provides a web UI for SIP
ladder diagrams and call flow visualization.

## Components

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| `voip-homer-db` | postgres:14-alpine | 5432 (internal) | Dedicated PG for SIP capture data (separate from voip DB) |
| `voip-heplify-server` | ghcr.io/sipcapture/heplify-server | 9060 UDP/TCP, 9061 TCP | Receives HEP packets, writes to homer-db |
| `voip-homer-webapp` | ghcr.io/sipcapture/homer-app | 9080 (HTTP) | Web UI for SIP trace search and ladder diagrams |

## HEP Sources & Capture IDs

Each SIP component sends HEP packets with a unique capture_id for identification in Homer:

| Source | capture_id | HEP Target | Config Location |
|--------|-----------|------------|-----------------|
| Kamailio SBC | 100 | $HOMER_IP:9060 UDP | kamailio.cfg (`siptrace` module) |
| FreeSWITCH internal profile | 200 | $HOMER_IP:9060 UDP | sofia/internal.xml (`capture-server`) |
| FreeSWITCH external profile | 201 | $HOMER_IP:9060 UDP | sofia/external.xml (`capture-server`) |

**Multi-zone capture IDs:** East=100/200/201, West=110/210/211, Central=120/220/221.

## Files

| File | Purpose |
|------|---------|
| `init-user-db.sh` | Docker entrypoint init script for homer-db (creates required schemas) |
| `bootstrap/` | Homer webapp bootstrap config (dashboard layouts, user settings) |
| `seed-aliases.sh` | Seeds Homer node aliases for the capture IDs |

## Configuration

Homer DB password is set via `HOMER_DB_PASS` env var (default: `homerSeven`).
The heplify-server connects to homer-db using the `root` user.

## Accessing Homer

- **Local dev:** http://localhost:9080
- **Production:** http://<services-vm-ip>:9080 (via IAP tunnel or NLB)
- **Default login:** admin / sipcapture

## Centralized vs Per-Zone

**Phase 1 (current):** Single Homer stack on the services VM in us-east1-b. All zones
send HEP packets to this centralized instance. Cross-region HEP is UDP, fire-and-forget,
~5 Mbps per zone — negligible cost and no call quality impact.

**Phase 2 (optional):** Per-zone Homer if HEP volume becomes a concern. Homer supports
multi-node aggregation for cross-zone SIP trace queries.

## Using Homer for Debugging

1. Open Homer webapp
2. Search by Call-ID, From/To number, or time range
3. Click a call to see the SIP ladder diagram
4. Ladder shows all SIP messages across Kamailio (100) and FreeSWITCH (200/201)
5. Use this to debug: one-way audio, call setup failures, 4xx/5xx errors, codec mismatches
