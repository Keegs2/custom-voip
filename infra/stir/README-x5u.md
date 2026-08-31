# STIR/SHAKEN x5u — public HTTPS cert endpoint

Isolated, self-contained Caddy service that serves our public STI certificate
chain so other carriers' STIR/SHAKEN verifiers can fetch it. The URL below is
the `x5u` embedded in every signed PASSporT.

**Served URL:** `https://fs-cert.granitevoip.com/stir/8052-2026.pem`
**On-disk source:** `infra/stir/granite-shaken-8052-x5u.pem` (leaf `CN=SHAKEN 8052`
+ Neustar SHAKEN CA-2 intermediate; **public, no private key** — served verbatim).

**Second served path:** `https://fs-cert.granitevoip.com/stir/sti-pa-trust-bundle.pem`
— the STI-PA trusted-CA list our own SBCs cron-pull for inbound verify
(`refresh-sbc-trust-bundle.sh`). On-disk source `/var/lib/stir/` (ro dir mount
`/srv/stir-trust`), installed/refreshed by `refresh-stir-trust-bundle.sh`; 404s
until first install. Lifecycle: `docs/STIR_TRUST_BUNDLE_RUNBOOK.md`. Everything
else still 404s.

We self-host because org policy (Domain Restricted Sharing) blocks public GCS.
Public reachability here is a **firewall/network** concern, not IAM.

## Deploy (East services VM, repo at `/opt/revup`)

```bash
docker compose -f docker-compose.x5u.yml up -d
```

Only two env vars matter (`X5U_DOMAIN`, `X5U_ACME_EMAIL`) — see
`infra/stir/.env.x5u.example`. Set `X5U_ACME_EMAIL` to a real ops mailbox first.

## Prerequisites (operator, on GCP — not done in this repo)

1. **DNS:** `fs-cert.granitevoip.com  A  34.26.57.37` (the services VM public IP).
   Must exist before first start so the ACME HTTP-01 challenge can validate.
2. **Firewall (VPC ingress to the services VM):**
   - `allow tcp:80 from 0.0.0.0/0` — Let's Encrypt HTTP-01 challenge + HTTP→HTTPS
   - `allow tcp:443 from 0.0.0.0/0` — the HTTPS cert endpoint

   No other new ports.

## How verifiers trust it

Caddy's **automatic HTTPS** obtains a **public Let's Encrypt** certificate for
`X5U_DOMAIN` via the **ACME HTTP-01** challenge on **:80**, then serves HTTPS on
**:443** (and redirects :80→:443). Any standard TLS client (a verifier's HTTPS
fetch of the `x5u`) trusts it via the public Let's Encrypt/ISRG chain — no custom
trust store needed. The issued cert + ACME account persist in the
`x5u_caddy_data` volume so restarts don't re-issue (Let's Encrypt rate limits).

Note: the **served bytes** (our `CN=SHAKEN 8052` STI chain) and the **transport
TLS cert** (Let's Encrypt for `fs-cert.granitevoip.com`) are two different certs —
the STI cert is the payload; the LE cert only secures the connection.

## Response headers on the cert path

Set explicitly in `infra/stir/Caddyfile` on `/stir/8052-2026.pem`:

- `Content-Type: application/pem-certificate-chain`
- `Cache-Control: public, max-age=86400`

`GET /healthz` → `200 ok` (uptime probe). **Everything else → 404.** No directory
listing, no other paths, **no `reverse_proxy`**.

## Isolation from the main stack

- Separate compose file — `docker-compose.services.yml` is **not modified**.
- Own bridge network `x5u-net`; own volumes `x5u_caddy_data` / `x5u_caddy_config`.
  Nothing shared with the services stack (`services-network`, its volumes).
- Publishes **only** host `:80`/`:443` (the UI uses `:8080`/`:8443` — no collision).
  Not host-networking.
- Read-only bind mounts (`Caddyfile`, `infra/stir/`); read-only static file
  server; no proxy; single content path.

## Rotation (yearly STI-cert renewal)

1. Drop the new chain PEM (leaf + intermediate, **no key**) into `infra/stir/`.
2. Add a `handle` block in `infra/stir/Caddyfile` serving it at a **new** path,
   e.g. `/stir/8052-2027.pem` (keep the old path live during cutover so in-flight
   PASSporTs still verify), then `docker compose -f docker-compose.x5u.yml up -d`.
3. Update `STIR_CERT_URL` in the SBCs' `.env` to the new URL and redeploy the SBCs
   (`docker-compose.sbc.yml`). Retire the old path after the old cert's `notAfter`.
