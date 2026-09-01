# STIR/SHAKEN — STI-PA Trusted-CA Bundle Runbook

**What this is:** the operating manual for the iconectiv **STI-PA trusted-CA list** —
the multi-CA trust list our SBCs chain every INBOUND caller's x5u certificate to
when own-crypto verification runs with a chain-validating mode
(`STIR_VERIFY_CERT_MODE=5`). The list **changes over time** (the STI-PA adds and
revokes approved STI-CAs), so this is a *lifecycle*, not a one-time install.

**THE OFFICIAL ARTIFACTS (in hand, verified 2026-08-28).** The STI-PA publishes
these on its public download page (`authenticatereg.iconectiv.com/download-lists`,
no auth):

- **`sticaList.jwt`** — the trusted-CA list as an **ES256-signed JWT**: header
  `{"alg":"ES256","typ":"JWT","x5u":"https://authenticate-api.iconectiv.com/download/v1/certificate/certificateId_<id>.crt"}`,
  payload `{version, sequence, exp, trustList:[<19 PEM roots>]}`. **Reissued
  DAILY with a ~24h `exp`** (measured: issued 23:23Z, exp next day 22:43Z) —
  NOT monthly. Signed by **CN=STI-PA CA List** (issuer *STI-PA Root
  Certificate 2*), whose public cert is **pinned in the repo** at
  `infra/stir/sti-pa-calist-signer.crt` (valid 2025-12 → 2028-12).
- **`stipaCrl.crl`** — the STI-PA revocation list (PEM CRL), also **reissued
  DAILY** (nextUpdate = lastUpdate + 24h). Signed by **CN=STI-PA CRL** (same
  issuer), pinned at `infra/stir/sti-pa-crl-signer.crt`.
- The JWT/CRL artifacts themselves are **runtime data — never committed**
  (they expire daily). Only the two pinned signer certs live in git.

The publisher **auto-detects** its input: feed it the official `sticaList.jwt`
(preferred — cryptographically verified) or a plain PEM bundle (fallback +
synthetic-test path); either way the SBCs only ever consume plain PEM.

**Tooling (all in `infra/stir/`, deployed by the normal `sudo git pull`):**

| Piece | Where it runs | Job |
|---|---|---|
| `refresh-stir-trust-bundle.sh` | East **services** VM | ingest `sticaList.jwt` (J-gates) or PEM → G-gates → atomic install to `/var/lib/stir/` → published by the x5u Caddy; same run ingests+publishes the CRL when sourced |
| `refresh-sbc-trust-bundle.sh` | every **SBC** | pull the published bundle (+CRL) over HTTPS → SAME gates → atomic swap into `/opt/revup/secrets/stir-ca/` |
| `stir-trust-lib.sh` | sourced by both | the shared gates — J1-J3 (JWT), G1-G5 (PEM), C1-C3 (CRL), freshness watchdog |
| `deploy-sbc-verify.sh` | SBC (operator) | one-time wiring of the CA **dir** mount + `CertVerify` mode + verify toggle |
| `trust_bundle_selftest.sh` | anywhere, local | proof of every gate — 35 synthetic checks (incl. metrics emission) + 3 real-artifact checks (auto-skip when `~/Downloads/sticaList.jwt` is absent/expired); run after changing any of the above |
| `sti-pa-calist-signer.crt` / `sti-pa-crl-signer.crt` | in git | the repo-pinned STI-PA signer certs (public material) |

**Flow:**

```
STI-PA public download page (sticaList.jwt + stipaCrl.crl — browser, or URL when confirmed)
        |
services VM: refresh-stir-trust-bundle.sh
        [J1 pinned ES256 signature / J2 exp+sequence / J3 extract 19 roots]
        [G1-G5 PEM gates]  -> /var/lib/stir/sti-pa-trust-bundle.pem (+dated archive incl. raw .jwt)
        [C1-C3 CRL gates]  -> /var/lib/stir/sti-pa-crl.pem
        |                                    (dir ro-mounted into the x5u Caddy)
        v
https://fs-cert.granitevoip.com/stir/sti-pa-trust-bundle.pem   (+ /stir/sti-pa-crl.pem; all else 404)
        |
each SBC (cron): refresh-sbc-trust-bundle.sh [SAME gates] -> /opt/revup/secrets/stir-ca/{sti-pa-trust-bundle.pem,sti-pa-crl.pem}
        |                                    (dir ro-mounted at /etc/kamailio/stir/ca)
        v
Kamailio secsipid: libopt CertCAFile=.../sti-pa-trust-bundle.pem (mode 5)
                   libopt CertCRLFile=.../sti-pa-crl.pem          (only read at mode 21)
```

**Proven end-to-end 2026-08-28 (local, real artifacts):** real `sticaList.jwt` →
J1 ES256 verified against the repo pin → 19 CAs extracted → all G-gates passed —
including **G5: our Neustar SHAKEN Root CA IS in the official list** (chain:
SHAKEN 8052 → Neustar Certified Caller ID SHAKEN CA-2 → Neustar Certified Caller
ID SHAKEN Root CA) → atomic install → served by the real `Caddyfile` (local
Caddy) → SBC-script pull re-ran the gates → **sha256 identical on both ends**
(bundle `1cf50263…`, CRL `8e82fa89…`); byte-flipped JWT rejected by J1.

---

## No reload needed — why (and the one trap)

**A bundle refresh never restarts anything.** libsecsipid re-reads `CertCAFile`
from disk and builds a fresh CA pool **on every verification** — verified against
the secsipidx source (`secsipid.go` `pubKeyVerify()`: `os.ReadFile(o.certCAFile)`
+ `x509.NewCertPool()` per call; the x5u disk cache only skips the HTTPS *fetch*,
never the chain check). The very next inbound verify uses the new bundle the
moment the file swap lands.

**The trap that shaped the design:** Docker single-**file** bind mounts pin the
inode at container start — an atomic `mv` on the host would leave the container
reading the OLD bundle forever. That is why `docker-compose.stir-cafile.yml`
mounts the **parent directory** (`CA_DIR`) and the refresh scripts install via
temp-file + `mv` *inside* that directory (proven live in the local selftest: the
running container saw the renamed file instantly). Do not "simplify" either side.

The only actions that ever recreate Kamailio are the `deploy-sbc-*.sh` scripts —
deliberate, operator-run, one SBC at a time (the NLB covers the brief restart).
If a future change ever *does* require a fleet restart, do it exactly like every
Kamailio rollout: canary one SBC, then the rest one at a time, minutes apart —
never all 6 together. Nothing in this runbook schedules restarts.

## Validation gates (identical on publisher and every SBC)

A candidate installs **only** if ALL pass; any failure keeps the current
bundle, writes `STATUS=FAIL`, logs to syslog, and exits non-zero.

**JWT ingest gates (publisher, when the input is `sticaList.jwt`):**

- **J1 signature** — the ES256 signature verifies against the **repo-pinned**
  `sti-pa-calist-signer.crt` (pure bash+openssl: base64url → raw R||S → DER →
  `openssl dgst -sha256 -verify` over `header.payload`; the payload is never
  parsed before the signature passes). Also enforced: header `alg` must be
  ES256; header `x5u` must match the STI-PA URL pattern
  (`authenticate-api.iconectiv.com/download/v1/certificate/certificateId_*.crt`);
  the pinned cert must itself be within its validity window. Optional
  `TB_X5U_LIVECHECK=1` additionally fetches the header x5u live and requires a
  **byte-match with the pin** — a mismatch means "STI-PA rotated their signing
  cert" and FAILS CLOSED (see *Pinned-cert rotation* below).
- **J2 freshness** — `exp` must be in the future (hard fail; the list is
  reissued daily so an expired file = a stale download); WARN when exp is
  < 6h away (`TB_JWT_EXP_WARN_SECS`). `sequence` may never regress vs. the
  recorded installed value (anti-replay; `TB_ALLOW_SEQ_REGRESSION=1` for a
  deliberate operator rollback). `sequence`+`exp` are recorded in the status
  file (`LIST_SEQUENCE`/`LIST_EXP`) — only on a real verified install, so a
  rejected candidate can never poison the regression check.
- **J3 extraction** — the `trustList` array → normalized PEM bundle, which then
  goes through the ordinary G-gates **unchanged**.

**PEM bundle gates (publisher + every SBC — SBCs always consume plain PEM):**

- **G1** exists + non-empty
- **G2** every PEM block parses as an X.509 certificate (whole-bundle + per-cert)
- **G3** cert count ≥ `MIN_CA_CERTS` (default **5**; catches truncated downloads —
  the real STI-PA list carries 19 CAs today)
- **G4** every cert currently within validity (notBefore ≤ now < notAfter);
  WARNs (non-blocking) on anything expiring within 30 days
- **G5** the candidate **anchors OUR OWN chain**: `openssl verify` of the
  `granite-shaken-8052-x5u.pem` leaf against the candidate (chain file as
  `-untrusted`, `-partial_chain` to mirror Go/libsecsipid semantics). A list
  that would fail *our own* inbound calls can never install. **Verified against
  the real list:** our anchor is `CN=Neustar Certified Caller ID SHAKEN Root CA`,
  entry #9 of the official trustList.

**CRL gates (when a CRL source is configured):**

- **C1** parses as a PEM CRL — load-bearing beyond hygiene: libsecsipid's CRL
  branch ignores the `x509.ParseCRL` error and dereferences the result, so a
  corrupt on-disk CRL would panic the Go runtime inside Kamailio. Nothing
  unvalidated ever reaches `CA_DIR`.
- **C2** signature verifies against the repo-pinned `sti-pa-crl-signer.crt`
  (which must itself be in validity)
- **C3** freshness — `lastUpdate` ≤ now; `nextUpdate` in the future (**hard
  fail at the publisher**, WARN-only on the SBC pull, where a few hours of
  mirror lag is legitimate)

**Freshness watchdog (publisher `--check`):** FAILS when the last verified
install is older than `TB_MAX_BUNDLE_AGE_DAYS` (default **40** = the monthly
manual SLA + slack) — this is what stops a manual-download mirror from silently
lapsing. A recorded `LIST_EXP` in the past only WARNs (expected within a day on
the manual flow — the PEM roots stay valid for years; it just means the mirror
is behind the STI-PA's daily reissue).

---

## 1. Acquisition — the official artifacts

**Source:** the STI-PA public download page
`https://authenticatereg.iconectiv.com/download-lists` (no login). Download
**`sticaList.jwt`** (the trusted-CA list) and **`stipaCrl.crl`** (the CRL).
Because the JWT `exp` is ~24h, ingest it the **same day** you download it.

**Machine URL (wanted, unconfirmed):** the page is a JS app, but the JWT's own
`x5u` proves a public API scheme at
`https://authenticate-api.iconectiv.com/download/v1/…` (the signer cert is
served at `/download/v1/certificate/certificateId_646623.crt` — fetchable, no
auth). A direct URL for the list itself would enable the fully-hands-off daily
cron. Probe **from the services VM** (this network path matters — some networks
get TCP-reset by iconectiv's edge; the VM egress may be allowed):

```
for p in calist ca-list sticalist sticaList sticaList.jwt calist/sticaList.jwt crl stipaCrl.crl crl/stipaCrl.crl; do echo "== $p"; curl -sS -o /tmp/probe.$$ -w '%{http_code} %{size_download}b\n' --max-time 15 "https://authenticate-api.iconectiv.com/download/v1/$p"; sleep 2; done; rm -f /tmp/probe.$$
```

If one returns the JWT (starts with `eyJ`): set it as `STIR_TRUST_BUNDLE_URL`
in the publisher cron below (and the CRL URL as `STIR_CRL_URL`) — the pipeline
is already correct for URL input (auto-detects JWT vs PEM). If none works, the
**manual browser download is the primary flow** (below) and the age watchdog
guarantees it can't silently lapse. *(Probed 2026-08-28 from a dev network:
every request to `authenticate-api.iconectiv.com` — including the known-good
x5u — was TCP-reset, so the URL could not be confirmed off-VM; the browser page
works. Re-probe from the services VM.)*

Get the files onto the services VM however you normally move files to it, e.g.
paste: `sudo mkdir -p /tmp/stir && sudo tee /tmp/stir/sticaList.jwt` (paste the
JWT, Ctrl-D), same for `stipaCrl.crl`.

## 2. First install — services VM (publisher)

```
cd /opt/revup && sudo git pull
sudo /opt/revup/infra/stir/refresh-stir-trust-bundle.sh --fetch --from-file /tmp/stir/sticaList.jwt
sudo /opt/revup/infra/stir/refresh-stir-trust-bundle.sh --install --from-file /tmp/stir/sticaList.jwt --crl-from-file /tmp/stir/stipaCrl.crl
sudo docker compose -f docker-compose.x5u.yml up -d
curl -s https://fs-cert.granitevoip.com/stir/sti-pa-trust-bundle.pem | head -3
curl -s -o /dev/null -w '%{http_code}\n' https://fs-cert.granitevoip.com/stir/sti-pa-crl.pem
sudo /opt/revup/infra/stir/refresh-stir-trust-bundle.sh --status
```

- `--fetch` first = dry-run of the gates; `--install` is the real one. Expect
  the J1/J2/J3 lines (ES256 verified, sequence/exp recorded, 19 roots
  extracted) then G1–G5, then C1–C3 for the CRL.
- The `docker compose ... up -d` is **one-time** (adds the `/var/lib/stir` ro
  mount to the x5u Caddy; it also picks up the `/stir/sti-pa-crl.pem` route
  from the updated Caddyfile). It prints an *orphan containers* warning for the
  services stack — **ignore it and NEVER add `--remove-orphans`** (it would
  delete the API/UI/Homer stack; same rule as every x5u deploy).
- The first `curl` must return `-----BEGIN CERTIFICATE-----`; the second `200`.

## 3. First install — canary SBC, then fleet

Canary (pick one, e.g. `kam-g2`):

```
cd /opt/revup && sudo git pull
sudo /opt/revup/infra/stir/refresh-sbc-trust-bundle.sh --install
sudo /opt/revup/infra/stir/refresh-sbc-trust-bundle.sh --status
```

Expected: `all gates passed`, `installed -> /opt/revup/secrets/stir-ca/sti-pa-trust-bundle.pem`,
and (since verify is still dark) `bundle pre-staged for deploy-sbc-verify.sh`.
Then run the same two commands on the other 5 SBCs.

**Migration note (SBCs that ran the pre-2026-08-19 dark verify setup):** the CA
overlay changed from a single-file mount (`CA_SRC`, `/opt/revup/secrets/sti-pa-roots.pem`)
to a directory mount (`CA_DIR`, `/opt/revup/secrets/stir-ca/`). After `git pull`,
one plain `sudo /opt/revup/infra/stir/deploy-sbc-verify.sh` (setup mode, verify
stays off) rewrites `.env` and recreates Kamailio with the new mount. The
activation step below does this anyway via `--enable`.

## 4. Cron — keep it fresh forever

**Cadence rationale:** the STI-PA reissues BOTH artifacts **daily** (JWT exp
≈ +24h, CRL nextUpdate = +24h). So: a **daily** `--install` when the machine
URL is confirmed (unchanged trustList content is a no-op — the roots
themselves change rarely; the daily reissue mostly refreshes exp/signature),
plus a **daily** `--check` as the watchdog either way. On the manual flow the
practical SLA is a **monthly** browser re-download (the PEM roots stay valid;
you're only aging the mirror) — enforced by the 40-day age watchdog, which
turns a lapsed manual flow into a FAILING daily cron line instead of silence.

**Services VM** — `/etc/cron.d/stir-trust-bundle` (pick ONE of the first two jobs):

```
printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nSTIR_TRUST_BUNDLE_URL=<STI-PA-CALIST-URL>\nSTIR_CRL_URL=<STI-PA-CRL-URL>\n17 4 * * * root /opt/revup/infra/stir/refresh-stir-trust-bundle.sh --install >>/var/log/stir-trust-refresh.log 2>&1\n47 4 * * * root /opt/revup/infra/stir/refresh-stir-trust-bundle.sh --check >>/var/log/stir-trust-refresh.log 2>&1\n' | sudo tee /etc/cron.d/stir-trust-bundle
```

- If the STI-PA URLs are automatable (see the §1 probe): keep the `--install`
  line (daily 04:17 fetch of JWT + CRL) — set both URLs.
- If the list is only a manual browser download: DELETE the `--install` line and
  both URL lines; keep the daily `--check` (04:47) — it re-validates the
  installed bundle AND fails loudly once the last verified install is > 40 days
  old. Re-run step 2 with `--from-file` **monthly** (or on STI-PA change
  notices). Do NOT wire a CRL in manual mode (it goes stale in 24h and the
  publisher gate would then correctly reject it — the CRL only matters for
  mode 21, below).

**Each SBC** — `/etc/cron.d/stir-trust-bundle`, daily pull ~1h after the
publisher, minute-staggered per SBC (purely to spread load/logs — a pull never
restarts anything, so simultaneity is safe, just noisy):

```
printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n%s 5 * * * root /opt/revup/infra/stir/refresh-sbc-trust-bundle.sh --install >>/var/log/stir-trust-refresh.log 2>&1\n' <MINUTE> | sudo tee /etc/cron.d/stir-trust-bundle
```

| SBC | `<MINUTE>` | | SBC | `<MINUTE>` |
|---|---|---|---|---|
| poc-custom-voip (east-sbc-1) | 5 | | west-sbc-2 | 35 |
| kam-g2 (east-sbc-2) | 15 | | central-sbc-1 | 45 |
| west-sbc-1 | 25 | | central-sbc-2 | 55 |

## 5. Watching it / failure response

- **Status file:** `cat /var/lib/stir/trust-bundle.status` — key=value:
  `STATUS=OK|FAIL`, `ACTION`, `TIMESTAMP`, `DETAIL`, `BUNDLE_SHA256`,
  `CERT_COUNT`, `NEXT_EXPIRY`. Or just `--status` on either script.
- **Syslog:** tag `stir-trust-bundle` (`daemon.err` on failure):
  `grep stir-trust-bundle /var/log/syslog | tail`.
- **Log file:** `tail -50 /var/log/stir-trust-refresh.log`.
- **Grafana:** the *Trust & Certificates* row on the STIR/SHAKEN NOC board
  (`noc-stir-shaken`) — Prometheus metrics + blackbox probes, see §5c
  *Observability* below.

**On FAIL:** the previous bundle is still installed and serving — inbound verify
keeps working on yesterday's trust; nothing is call-affecting (verify is
fail-open regardless). Read `DETAIL`:
- `fetch failed` (SBC) → check the services VM published copy
  (`refresh-stir-trust-bundle.sh --status`) and SBC :443 egress.
- `J1` → the JWT's signature does not verify against the pinned signer:
  tampered/corrupt download, or the STI-PA rotated their signing cert → see
  *Pinned-cert rotation* below. Never bypass.
- `J2: list EXPIRED` → the downloaded `sticaList.jwt` is past its ~24h exp —
  download a fresh copy (same day you ingest it).
- `J2: sequence REGRESSION` → the candidate is OLDER than what's installed
  (replay?). Only override with `TB_ALLOW_SEQ_REGRESSION=1` for a deliberate,
  understood rollback.
- `G2/G3` → truncated/garbled download; re-fetch/re-download.
- `G4` → a CA in the list is expired/not-yet-valid — usually a stale list; get a
  fresh one from the STI-PA page.
- `G5` → **the list no longer contains our Neustar root** (today: entry #9,
  `Neustar Certified Caller ID SHAKEN Root CA`). Highest-priority
  investigation: either a bad/partial list (re-download) or the STI-PA actually
  delisted Neustar — in which case our OWN cert is at risk and Granite needs a
  new STI-CA. Do not force-install.
- `C1/C2/C3` → CRL problems: corrupt (C1), wrong/rotated signer (C2), stale
  (C3 — remember it reissues daily). The bundle install is unaffected; the
  previous CRL is kept.
- `freshness: … LAPSED` on `--check` → the manual re-download SLA was missed
  (> 40 days since the last verified install). Re-run step 2 now.
- `--check` FAIL on the *installed* bundle → certs in the installed list have
  since expired; refresh from the source.

## 5b. Pinned-cert rotation (STI-PA signer changed)

The J1/C2 gates trust exactly two repo-pinned PUBLIC certs:
`infra/stir/sti-pa-calist-signer.crt` (CN=STI-PA CA List, valid → 2028-12) and
`infra/stir/sti-pa-crl-signer.crt` (CN=STI-PA CRL, valid → 2028-10). If the
STI-PA rotates a signer (J1/C2 starts failing on a KNOWN-fresh download, or
`TB_X5U_LIVECHECK=1` reports a pin mismatch):

1. Fetch the new signer cert from the JWT's own `x5u` URL
   (`https://authenticate-api.iconectiv.com/download/v1/certificate/certificateId_<newid>.crt`).
2. **Verify it before trusting it:** subject must be the same STI-PA CN, issuer
   `CN=STI-PA Root Certificate 2`, and the signature must chain to the STI-PA
   Root 2 cert (obtain that root from the STI-PA / cross-check with another
   SHAKEN operator — do NOT trust the first HTTPS response alone):
   `openssl verify -partial_chain -CAfile sti-pa-root2.pem new-signer.crt` —
   at minimum compare `openssl x509 -noout -subject -issuer -dates -serial`
   against the STI-PA's published notice.
3. Replace the pinned file in the repo, commit, PR, merge; `sudo git pull` on
   the services VM (the SBCs don't use the JWT pins; only C2's CRL pin matters
   fleet-wide, delivered by the same pull).
4. Re-run `--install` with a fresh download; J1/C2 must pass again.

Both pins expire 2028 — expect a planned rotation then; the J1 gate will start
failing with "pinned STI-PA signer cert has EXPIRED", which is this procedure.

## 5c. Observability — Prometheus metrics + the NOC "Trust & Certificates" row

**What exists:** every `refresh-*-trust-bundle.sh` run (any action, OK **and**
FAIL — so the daily `--check` cron doubles as the periodic re-emit) writes a
Prometheus textfile via `tb_emit_metrics` in `stir-trust-lib.sh`:

- **Path (services VM):** `/var/lib/stir/metrics/stir_trust_bundle.prom` —
  derived as `<status-file dir>/metrics`; override with `TB_METRICS_DIR`
  (`TB_METRICS_DIR=none` disables). Written atomically (temp + `mv`), mode
  0644.
- **Strictly fail-safe:** emission swallows every error and can NEVER fail (or
  even warn) a trust refresh — proven by selftest TM3. The SBC script emits the
  same file on SBCs (`/var/lib/stir/metrics/`); nothing scrapes it there today —
  harmless, and a ready-made hook if SBC node_exporters ever grow a textfile
  collector.
- **Pickup:** `docker-compose.services.yml` runs node_exporter with
  `--collector.textfile.directory=/var/lib/stir/metrics` (dedicated ro bind
  mount — docker auto-creates the host dir, no manual VM command), and the
  services vmagent's existing `node` job scrapes :9100 into VictoriaMetrics.
- **Design note:** everything that can go stale is an epoch **timestamp**, not
  a boolean — if the refresh (or the emission itself) silently freezes, the
  tiles AGE into yellow/red instead of reading forever-healthy.
  (`node_textfile_mtime_seconds{file="stir_trust_bundle.prom"}` is the
  emission's own freshness signal if you ever need it.)

| Metric (all gauges) | Meaning |
|---|---|
| `stir_trust_bundle_installed_timestamp_seconds` | epoch of the last VERIFIED install (`INSTALLED_AT`; the 40d watchdog's clock) |
| `stir_trust_bundle_ca_count` | certs in the installed bundle (19 today) |
| `stir_trust_bundle_next_ca_expiry_timestamp_seconds` | soonest notAfter across the bundle's CAs |
| `stir_sticalist_expiry_timestamp_seconds` | `exp` of the last ingested `sticaList.jwt` (daily, ~24h) |
| `stir_crl_next_update_timestamp_seconds` | installed CRL's nextUpdate (absent = CRL not installed) |
| `stir_leaf_cert_expiry_timestamp_seconds` | OUR leaf `CN=SHAKEN 8052` notAfter (2027-05-08; renew ~2027-04-01) |
| `stir_trust_refresh_last_run_timestamp_seconds` | epoch of the last script run that wrote status |
| `stir_trust_refresh_last_run_status` | 1 = last run STATUS=OK, 0 = FAIL |
| `stir_trust_refresh_last_success_timestamp_seconds` | epoch of the last OK run (carried across failures) |

Additionally the services blackbox-exporter probes the **public** x5u URLs
(`docker/vmagent/scrape-services.yml`): `probe_success{service="x5u (fs-cert)"}`
(= `/healthz`, endpoint up) and `probe_success{service="x5u trust bundle"}`
(= the exact bundle URL the SBC crons pull; 404 until the first install).

**The tiles** (bottom row of Grafana board `noc-stir-shaken`, datasource
VictoriaMetrics) and how they map to the **§6 pre-canary checklist**:

| Tile | Green means | §6 prereq it proves |
|---|---|---|
| Trust bundle age (40d watchdog) | verified install < 30d old (yellow 30–40d, red = watchdog LAPSED) | prereq 1/2 — publisher ingest is current |
| sticaList exp | list `exp` still ahead (red = mirror behind the daily reissue — fine within the 40d SLA, but re-ingest same-day before flipping verify ON) | prereq 1 — ingest freshness |
| Trusted CAs in bundle | ≥ 19 (yellow 5–18 = smaller than the known list — investigate before canary) | prereq 1 — `CERT_COUNT=19` |
| Last trust-refresh run | last publisher action wrote STATUS=OK | prereq 1 — gates passing |
| CRL freshness | inside its 24h window; **gray "not installed" is the EXPECTED state until mode 21** | mode-21 precondition only |
| Our leaf cert (SHAKEN 8052) | > 60d to notAfter (yellow < 60d = start renewal, §7) | outbound signing stays valid through the canary |
| x5u endpoint | public Caddy answering over HTTPS | carriers can fetch our chain; SBCs can pull |
| Trust bundle published | the SBC-pull URL serves the bundle (red + endpoint UP = never installed / trust mount missing) | prereq 2 — published for the SBC crons |

**Pre-canary read:** bundle age green · CA count 19 · last run OK · both x5u
tiles green ⇒ the trust side of §6 is satisfied (CRL may stay "not installed"
for mode 5). Any red tile: resolve via §5's failure table first.

**Deploy (services VM, one-time — all single-line):**

```
cd /opt/revup && sudo git pull
sudo docker compose -f docker-compose.services.yml up -d node-exporter
sudo docker compose -f docker-compose.services.yml restart vmagent
sudo /opt/revup/infra/stir/refresh-stir-trust-bundle.sh --check
curl -s http://localhost:9100/metrics | grep ^stir_
sudo docker compose -f docker-compose.services.yml restart grafana
```

- `up -d node-exporter` recreates it with the textfile flag + mount (creates
  `/var/lib/stir/metrics` if absent); `restart vmagent` reloads the scrape file
  (adds the two x5u blackbox targets); the `--check` writes the first `.prom`
  (and is harmless — same command as the daily cron); the `curl` must print the
  `stir_*` series; the grafana restart re-provisions the updated dashboard
  (skip it if the provider's auto-reload has already picked it up).
- Nothing here touches call flow: node_exporter/vmagent/grafana are
  monitoring-plane only, and the x5u Caddy is not restarted.

## 6. ACTIVATION — turning own-crypto inbound verify ON (chain mode)

Prereqs — every link of this chain is now **proven** (34/34 selftest + the real
`sticaList.jwt`/`stipaCrl.crl` run end-to-end locally on 2026-08-28, G5
confirming our Neustar root in the official list):

1. The publisher has ingested the **official, ES256-verified** STI-PA list
   (step 2; `--status` shows `SOURCE_KIND=jwt`, `CERT_COUNT=19`).
2. The bundle is installed on the SBC (step 3) and the daily crons are in
   place (step 4).
3. Verify code already deployed dark (PR #58).

One canary SBC first — this is the first time `CertVerify=5` governs the
verstat metric. Mode 5 = bits 1+4, verified against the secsipidx source:
bit 1 = the fetched x5u **certificate's validity window** (NOT the PASSporT
`iat`, which libsecsipid checks unconditionally regardless of mode), bit 4 =
chain the x5u to the STI-PA roots in `CertCAFile`:

```
sudo /opt/revup/infra/stir/deploy-sbc-verify.sh --enable
sudo /opt/revup/infra/stir/deploy-sbc-verify.sh --status
```

(`CERT_MODE=5` is the script default; it hard-refuses if the bundle is missing/
garbage, applies the key overlay if present so signing is untouched, recreates
kamailio, and hard-checks the config. Rollback is `--disable`.)

**Mode 21 (5 + CRL bit 16) — later, deliberate step.** Only after (a) the CRL
URL is confirmed automatable so the daily publisher cron keeps it inside its
24h nextUpdate, and (b) every SBC's daily pull is landing `sti-pa-crl.pem`.
Then: `sudo CERT_MODE=21 /opt/revup/infra/stir/deploy-sbc-verify.sh --enable`
(the script hard-refuses bit 16 without a parseable CRL on disk — libsecsipid
would panic on a corrupt CRL and fail every verify on a missing one; the gated
lifecycle is what makes bit 16 safe). Note secsipid's CRL check is
**serial-only screening** of the leaf against the STI-PA's consolidated CRL —
useful, not a full revocation infrastructure; without it, revocation still
degrades safely because the STI-PA removes a compromised CA from the daily
trustList itself, which mode 5 picks up on the next refresh.

**Observe on the canary (24h suggested):**
- `--status` shows `STIR verify: PASS/FAIL` lines; place a test call to
  **+16174544217** from a normal mobile.
- `call_attestations` / the admin attestation UI / the Grafana STIR board:
  inbound rows should show **verstat source=self** (self wins precedence over
  carrier-PAI), overwhelmingly `TN-Validation-Passed` for major-carrier callers.
- A `TN-Validation-Failed` flood = trust/egress problem (bad bundle, blocked
  :443), NOT dropped calls — verify is 100% fail-open. `--disable` reverts in
  one command while investigating.

**Fleet:** repeat `--enable` + a spot-check on the remaining 5 SBCs, one at a
time (each is a brief kamailio recreate behind its NLB).

## 7. Related: our own STI cert renewal (separate lifecycle)

The *outbound* leaf `CN=SHAKEN 8052` expires **2027-05-08** — renewal steps and
the 2027-04-01 calendar-reminder note live in
`docs/STIR_SHAKEN_IMPLEMENTATION_PLAN.md` ("Cert renewal"). The trust bundle in
THIS runbook is the *inbound* trust store; the two rotate independently (but the
G5 gate ties them: after a renewal onto a different STI-CA, confirm the new
issuer's root is in the bundle before the old cert lapses).
