# STIR/SHAKEN x5u — Self-Hosted Cert Repository

**Goal:** serve our public STI cert (leaf + intermediate) at an ATIS-1000074-compliant HTTPS URL **we own**, so `STIR_CERT_URL` (the x5u in every signed PASSporT) is fully under our control — no dependency on iconectiv's endpoint. Signing itself already works (local crypto test 12/12); this only serves the **public** cert so downstream carriers can fetch our public key to verify us.

> **⚠️ APPROACH CHANGED (2026-08-05): GCS-public is NOT usable — the org enforces Domain Restricted Sharing (`iam.allowedPolicyMemberDomains`), which blocks `allUsers` (HTTP 412). We pivoted to serving the cert from a dedicated, isolated Caddy container on the services VM (public at the firewall layer, which that policy doesn't gate).** The live design + deploy/runbook is in **`infra/stir/README-x5u.md`** + `docker-compose.x5u.yml` + `infra/stir/Caddyfile`. URL: `https://certs.granitevoip.com/stir/8052-2026.pem`. The GCS sections below are retained only as the (blocked) original plan / reference.

## Why self-hosting is fully compliant
STIR/SHAKEN trust comes from (a) the cert chaining to an STI-PA-registered root — **Neustar Root, already in the trust list** — and (b) the cert's TNAuthList (**SPC 8052**) authorizing our TNs. It does **not** come from who hosts the file. The x5u is just a public URL returning the cert; any HTTPS host is valid and many SPs self-host. (RFC 8224/8225; ATIS-1000074 §5.3.1.)

## What we serve (built + validated)
`granite-shaken-8052-x5u.pem` = **leaf (`CN=SHAKEN 8052`) + Neustar CA-2 intermediate**, PEM, leaf first. Root excluded (it's the trust anchor; verifiers already hold it). **Private key is NEVER in this file / bucket / git.** sha256 `1ad51378406ebe72e38b7a45a9856e1d02e6a4ea4eb6dc9a7d446f33360aebf7`; chain verified to Neustar Root; leaf expires 2027-05-08.

## The URL (ATIS-1000074 §5.3.1 — https, :443, no query/path-params/fragment/userinfo)
- **Direct (core):** `https://storage.googleapis.com/granite-stir-x5u/stir/8052-2026.pem`
- **Branded (optional):** `https://certs.granitevoip.com/stir/8052-2026.pem`

Versioned filename (`-2026`) ⇒ the object is **immutable** ⇒ long cache + clean annual rotation (new file, no cache-bust coordination).

## Architecture
**Core requirement:** a **dedicated** GCS bucket with **public-read** on the cert object (the cert is public by design; the bucket holds nothing else). If the org enforces `constraints/storage.publicAccessPrevention`, an admin grants a **per-bucket exception** — low risk, only public certs live here.

**Optional branding/HA layer:** front the bucket with an external HTTPS Load Balancer + backend bucket + Cloud CDN + a Google-managed cert on `certs.granitevoip.com` (Infoblox DNS, same as `trunk.granitevoip.com`). Same public-object requirement; adds a stable branded URL + global edge caching. Purely optional polish — the direct GCS URL is already compliant + highly available.

```
 verifier (any carrier)                        our control
        |  GET https x5u                         |
        v                                         |
 [ optional: HTTPS LB + Cloud CDN + managed cert ]  <-- certs.granitevoip.com
        |                                         |
        v                                         |
 GCS bucket  gs://granite-stir-x5u  (public-read cert object only)
        └─ stir/8052-2026.pem  =  leaf + intermediate  (NO key)
```

## Phases
0. **Artifact — DONE.** Built + validated (`~/Downloads/Granite_STI-CERT-2026/granite-shaken-8052-x5u.pem`). Copy into the repo at `infra/stir/granite-shaken-8052-x5u.pem` (public cert — safe in git) so OpenTofu can manage the upload.
1. **Bucket + object (user runs gcloud — shared GCP).** See commands below.
2. **Validate (Claude).** Fetch the live URL, confirm it returns our exact leaf+intermediate and is ATIS-clean; run a full external-style test: sign a PASSporT with the real key referencing this x5u, fetch the cert **from the URL**, verify.
3. **Wire signing.** Set `STIR_CERT_URL=<the URL>` in each SBC `.env`; canary sign test (live DID **+16174544217** → inspect `Identity` in Homer → confirm it validates).
4. **(Optional) brand it.** HTTPS LB + custom domain + CDN + Infoblox DNS; migrate `STIR_CERT_URL` (forward-only — each PASSporT carries its own x5u, so no break).
5. **Ops.** Cloud Monitoring uptime check + alert on the x5u URL (reuse the existing alerting stack — a down x5u degrades our downstream verification). Rotation runbook (~Apr 2027: new cert → upload `stir/8052-2027.pem` → roll `STIR_CERT_URL`; keep the old object up during the overlap window).
6. **IaC.** Codify the bucket + object (+ LB when branded) in OpenTofu (`infra/`), consistent with `infra/OPENTOFU_PLAN.md`.

## Phase 1 — exact gcloud (project `rugged-night-193017`)
```
gcloud storage buckets create gs://granite-stir-x5u --project=rugged-night-193017 --location=US --uniform-bucket-level-access --no-public-access-prevention
gcloud storage buckets update gs://granite-stir-x5u --versioning
gcloud storage cp granite-shaken-8052-x5u.pem gs://granite-stir-x5u/stir/8052-2026.pem --content-type="application/pem-certificate-chain" --cache-control="public, max-age=86400, immutable"
gcloud storage buckets add-iam-policy-binding gs://granite-stir-x5u --member=allUsers --role=roles/storage.objectViewer
```
→ x5u = `https://storage.googleapis.com/granite-stir-x5u/stir/8052-2026.pem`
(If `create` fails on public-access-prevention, an org admin grants a per-bucket exception, then re-run the IAM binding.)

## Security guarantees
- **Public cert material only.** The EC private key never touches GCS or git; it stays a per-SBC secret at `STIR_KEY_PATH`.
- Dedicated single-purpose bucket → public-read is intended and safe.
- HTTPS only; immutable versioned objects; write access limited to the deploy identity.
- Our **signing** never fetches the x5u (local key), so a bucket outage cannot break our outbound calls — it only affects others verifying us (they fail-open) until it's back.

## Plugs into the existing build
`STIR_CERT_URL` is already templated by `entrypoint.sh` into the PASSporT `x5u` + `info=<...>` (kamailio.cfg Step 8.5). Setting it to the GCS URL is the only change — **no code change**.
