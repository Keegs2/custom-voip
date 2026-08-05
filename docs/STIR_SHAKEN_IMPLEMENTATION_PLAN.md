# STIR/SHAKEN Implementation Plan — On-Switch Signing at Kamailio (`secsipid`)

**Goal:** Sign the outbound SIP `Identity` header (PASSporT) at the Kamailio carrier border for every product — **Trunk = A**, **API = A**, **RCF = `div`** (diversion, RFC 8946 / ATIS-1000085) — using the Kamailio **`secsipid`** module and Granite's own STI certificate, deployable dark and testable with live calls.

**Signing approach chosen:** self-host `secsipid` at Kamailio for ALL products (this is the implementation-heavy path and the only one that can produce the RCF `div` chain, which Bandwidth's Hosted Signing cannot). Bandwidth Hosted Signing remains a fallback for trunk/API if self-sign proves hard.

**Deploy model:** git push → per-SBC `git pull` + rebuild `kamailio` (all 6 SBCs, canary West/East first). Cert + private key are **secrets** delivered per-SBC like `.env` (never in git). Config is env-templated by `entrypoint.sh`.

**Scope (updated 2026-08-05 — do both directions, one canary):** one build delivers BOTH outbound signing (`STIR_SHAKEN_SIGN`) and inbound cryptographic verification (`STIR_SHAKEN_VERIFY`), independently env-toggled, so a **single Phase-4 canary exercises sign + verify together** rather than two separate touches of the live path. Inbound Identity *capture* (Tasks 1.4/2.4) was already core; this promotes the *crypto* check (`secsipid_check_identity`, now Phase 2B) out of old Phase 5. Rationale: we're cert-gated on signing either way (P1–P3), so deferring verify buys no earlier launch; and the captured header is already in hand. Verification = **own crypto, DECIDED 2026-08-05** (full independence; Bandwidth-consume kept only as fallback). Two costs accepted: (a) verify makes an **outbound HTTPS _client_ call** to fetch x5u certs (Phase 2B.3 — a client egress dependency, NOT a TLS server/listener/own-cert on the box; almost certainly already open given external IPs + `bypass-vpn` + GCP allow-all egress, confirm with one read-only `curl`); (b) verify sits on the **latency-sensitive inbound INVITE path**, so it MUST be cache-warmed + `timeout`-bounded + **fail-open** — a verify failure never rejects or delays a call.

**Ground-truth anchors (verified this session):**
- Signing attach point: `docker/kamailio/kamailio.cfg:2052` — inside `route[TO_CARRIER]`, **after** `msg_apply_changes()` (:1890) and `record_route_preset()` (:1927), **before** the relay callbacks (:2061-2065). Appending `Identity` here is the same mechanism/position as the existing `X-CID` append (:2051).
- Signing inputs already present at that line: `orig` = `$var(pai_user)` (:1969-1977), `dest` = `$rU`. Carrier already selected (`$var(carrier_ip)` :1806) — signing is carrier-independent.
- RCF diverting-number data already present: `Diversion` header rebuilt at `kamailio.cfg:1857-1861`; `X-Original-CID` at FS `inbound_router.lua:686-695`.
- Per-product attestation basis exists: Trunk ownership check `trunk_outbound.lua:274-326`; API ownership/tenant-scope `calls.py:86-118`; RCF div data `inbound_router.lua:663-702`.
- Header-ordering gotchas (CLAUDE.md §8.2/8.4/8.8): `record_route` AFTER `msg_apply_changes`; Contact BEFORE `msg_apply_changes`; `topoh` off — `append_hf("Identity: …")` at :2052 is safe.
- Per-zone self-containment: `TO_CARRIER` is byte-identical on all 6 SBCs; cert/key must exist on every SBC (or a shared signer per zone). Signing is local-key (no egress); verify needs outbound HTTPS for x5u.

---

## PREREQUISITES — Granite/user-driven (GATE; code builds without them but can't produce valid signatures)

- **P1. SPC token** from iconectiv (STI-PA). ✅ **DONE** — Neustar validated it during cert issuance (2026-08). Consumed at enrollment; not needed again at signing runtime.
- **P2. STI certificate + private key** — ✅ **ISSUED by Neustar** (approved STI-CA), 2026-08: a 3-cert chain (Granite company **leaf** + Neustar **Intermediate** STI-CA + Neustar **Root** STI-CA, root registered with iconectiv STI-PA), delivered as a zip. Expires **365 days** from issuance → calendar a renewal. **CONFIRM:** the matching **private key** (generated for the CSR) is saved on our side — Neustar never had it and cannot re-send it; the zip is **cert-only**. This key → each SBC at `STIR_KEY_PATH`.
- **P3. Public x5u HTTPS cert-repo URL** — ❓ **STILL NEEDED (the one open CA item).** The zip is the cert to build/sign with; the signed `Identity` must carry an `x5u` pointing to a **publicly fetchable** copy of the leaf (best practice: leaf + intermediate PEM). Either **Neustar hosts it → get the URL** (likely the info the coworker has), or **we self-host** leaf+intermediate as static PEM over HTTPS (public GCS/static endpoint — NOT on the SBCs). Must satisfy ATIS-1000074 §5.3.1: `https`, port 443/8443, **no** query string / path params / fragment / userinfo.
- **P4. Attestation policy** confirmed: A for owned DIDs (trunk/API); `div` for RCF; B/C fallbacks for unverified caller-ID.
- **P5. Compliance gates:** own-cert rule (FCC Eighth R&O, live since 2025-09-18 — must sign with Granite's own cert); RMD filing current + "fully implemented."

---

## PHASE 0 — Spikes — ✅ RESOLVED (2026-08-04)

- **Task 0.1 — `div` PASSporT support in `secsipid` → RESOLVED: YES, via `secsipid_sign`.** `secsipid_add_identity()` does base SHAKEN only (correct for Trunk=A/API=A). For RCF `div`, the module ships a **generic JWT signer `secsipid_sign(headers_json, payload_json, keyPath)`** (C entry `SecSIPIDSignJSONHP`) that signs *exactly* the JSON you hand it → build the `div` header+payload in `$var`s and sign, then `append_hf` it as a 2nd `Identity`. Confirmed by Kamailio lead D-C. Mierla (sr-users). **NO sidecar, NO extra module, NO vendor.** Div contingency removed.
- **Task 0.2 — Module packaging → RESOLVED.** Add **`kamailio-secsipid-modules`** to the second `apt-get install` block in `docker/kamailio/Dockerfile` (from the `deb.kamailio.org/kamailio58` repo, alongside `kamailio-json-modules` — pulls `libsecsipid1` transitively; clean apt-only, no compile). Confirm load via `kamailio -c` in the Phase 4 canary.

## PHASE 1 — Kamailio module + signing config *(telephony-systems-expert)* — ✅ IMPLEMENTED + VERIFIED (dark, 2026-08-05)

- **Task 1.1 — Image:** `docker/kamailio/Dockerfile` — install the `secsipid` module package (per 0.2).
- **Task 1.2 — Module load + params + templating:** `kamailio.cfg` — `loadmodule "secsipid.so"`; modparams (`cache_dir`, `cache_expire=3600`, `timeout=5`, `expire=300`, `libopt` if needed). Add env-templated tokens (like `SBC_INTERNAL_IP`) for `STIR_CERT_URL` (x5u), `STIR_KEY_PATH`, and a toggle `STIR_SHAKEN_SIGN` (default **off**). Wire them in `entrypoint.sh` + `docker-compose.sbc.yml` + `.env.sbc.example`.
- **Task 1.3 — Signing block in `TO_CARRIER`:** insert at `kamailio.cfg:2052` (after `msg_apply_changes`/`record_route_preset`, before relay callbacks), guarded by `#!ifdef`/env `STIR_SHAKEN_SIGN`:
  - **Trunk/API (base):** `secsipid_add_identity($var(pai_user), $rU, "<attest>", "", "STIR_CERT_URL", "STIR_KEY_PATH")` where `<attest>` = `$hdr(X-Attestation)` (default `B` if absent).
  - **RCF (`div`)** — triggered by `Diversion` present (or `X-Attestation: div`): (1) **re-emit the preserved inbound Identity** `append_hf("Identity: $dlg_var(inbound_identity)\r\n")` — captured per Task 1.4/2.4 (RFC 8946 MUST-preserve); (2) build the div JSON in `$var`s — header `{"alg":"ES256","ppt":"div","typ":"passport","x5u":"STIR_CERT_URL"}`, payload `{"orig":{"tn":"<original caller>"},"dest":{"tn":["$rU"]},"div":{"tn":"$var(div_user)"},"iat":<epoch>}` (`div` = forwarding RCF DID from `:1858`); (3) `secsipid_sign($var(div_hdr),$var(div_pl),"STIR_KEY_PATH")`, **check `$secsipid(ret)>=0` and fail-open** (relay unsigned rather than drop); (4) `append_hf("Identity: $secsipid(val)\r\n")`.
  - **RCF `div` — UNSIGNED-inbound fallback (POLICY, Granite 2026-08-05 — MANDATORY):** if the leg is marked `div` but the inbound call arrived **unsigned** (no `X-In-Identity` to chain), do NOT emit a bare div and do NOT coerce to `B` — sign a **base PASSporT at attestation `C` (Gateway)**. The calling number is the original PSTN caller, a number we neither own nor authenticated and hold no Identity for, so `C` is the only honest level (`B` would over-claim a partial-attestation relationship we don't have). Guard `orig` so we never sign `orig.tn:"+"`; fail-open to unsigned on any signing error. (Trunk/API keep their FS-provided `A`/`B`; the general whitelist-coercion default stays `B` for *those* only — there we authenticated the customer. Implemented in `kamailio.cfg` Step 8.5: the div-no-base branch calls `secsipid_add_identity(...,"C",...)` explicitly.)
  - Ensure `orig`/`dest`/`div` are canonical `+E.164`, `iat` a fresh integer epoch, JSON escaped via `$var` ops. Respect header ordering; do NOT move Contact/`msg_apply_changes`; leave the double-RR/`r2` logic untouched.
- **Task 1.4 — Capture inbound Identity (A-leg, `request_route` Bandwidth path)** *(telephony)*: **NEW — core, not deferred.** RFC 8946 requires preserving the original SHAKEN `Identity` to chain a `div`, but it does NOT survive our Kamailio→FS→Kamailio B2BUA round-trip today (greenfield). On the inbound INVITE from Bandwidth: `if (is_present_hf("Identity")) $dlg_var(inbound_identity) = $hdr(Identity);` and pass it to FS as a custom header `X-In-Identity` so FS can echo it on the B-leg (A-leg and B-leg are different dialogs across the B2BUA — the carry-through-FS is what re-correlates it). At `TO_CARRIER`, read it back (`$hdr(X-In-Identity)` → the `$dlg_var(inbound_identity)` used in 1.3) and `remove_hf("X-In-Identity")` before relay.

## PHASE 2 — FreeSWITCH attestation propagation *(telephony + backend)* — ✅ IMPLEMENTED + VERIFIED (Tasks 2.1/2.3/2.4; 2.2 API deferred with the gated Coming-Soon product)

- **Task 2.1 — Trunk** *(telephony)*: `trunk_outbound.lua` — set `sip_h_X-Attestation=A` when the DID-ownership check passes (`:274-282`) or the fallback-to-owned-DID case (`:294-316`); `B` otherwise.
- **Task 2.2 — API** *(backend + telephony)*: the ownership/tenant-scope check is in `calls.py:86-118`. Propagate an attestation marker through `services/esl_client.py` `originate_call` (as a channel var / SIP header var), and have `api_outbound.lua` set `sip_h_X-Attestation=A` from it.
- **Task 2.3 — RCF `div`** *(telephony)*: `inbound_router.lua` `terminate_rcf` — confirm `Diversion` + diverting DID are set (`:686-695`) and mark the leg so `TO_CARRIER` takes the `div` path (e.g. set `sip_h_X-Attestation=div` or rely on Diversion presence). Do NOT assert A on the original caller's number.
- **Task 2.4 — Echo inbound Identity through FS** *(telephony)*: **NEW — pairs with 1.4.** Ensure FreeSWITCH carries `X-In-Identity` from the inbound A-leg onto the outbound B-leg INVITE (set `sip_h_X-In-Identity` on the bridge / export the var) so Kamailio can re-emit the original SHAKEN Identity at `TO_CARRIER`. Without this the `div` has no base to chain (RFC 8946: MUST NOT add div to an INVITE with no Identity).

## PHASE 2B — Inbound cryptographic verification *(telephony)* — promoted from old Phase 5

- **Task 2B.1 — Verify on the Bandwidth inbound path:** in `request_route` (where Task 1.4 already captures `Identity`), when `STIR_SHAKEN_VERIFY=on` and an inbound `Identity` is present, call `secsipid_check_identity(...)` with a bounded `timeout` against the shared `cache_dir` (certs cached `cache_expire=3600`, so only the first call per new cert blocks on the x5u HTTPS fetch). Map the result → `verstat` (`TN-Validation-Passed` / `-Failed` / `No-TN-Validation`).
- **Task 2B.2 — Fail-open (hard rule):** missing/invalid Identity, cert-fetch timeout, or module error ⇒ mark the call unverified and **route it normally**. Verification is annotate-only — it NEVER sends a 4xx or adds blocking delay. Log the outcome for observability.
- **Task 2B.3 — Egress (pairs with Phase 3.2):** verify makes an outbound HTTPS/443 **client** call (libcurl inside the host-networked Kamailio container) to CA-hosted x5u repos. This needs **no TLS server, no `:443` listener, and no cert of our own** — it is NOT "setting up HTTPS" on the box. GCP default egress is allow-all and the SBCs have external IPs + `bypass-vpn` direct-to-internet routing, so outbound 443 is almost certainly already open. **Pre-check (user, read-only, per SBC host — host networking = same egress as the container):** `curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 https://<x5u-host>/` returns an HTTP code ⇒ egress + DNS + TLS all work. Confirm no egress-deny firewall rule blocks 443; allow-list the chosen STI-CA cert host once the CA (P2) is picked.
- **Task 2B.4 — Verify-vs-consume → DECIDED (user, 2026-08-05): OWN crypto for full independence.** We run `secsipid_check_identity()` ourselves and fetch x5u certs directly. Bandwidth's free inbound verification is kept ONLY as a documented fallback if egress ever proves impractical — nothing is consumed from Bandwidth in the built path.
- **Task 2B.5 — Trust anchors for verify:** validating INBOUND calls requires trusting the certs of *other* carriers' STI-CAs, so secsipid's verify must load the full **iconectiv STI-PA trusted-root list** (root bundle + CRL), NOT just our Neustar root (leaf 3, which only covers Neustar-signed inbound). Obtain/refresh the STI-PA CA list and point secsipid's validation store at it. Signing (our outbound) needs nothing beyond the Neustar cert/key + x5u.

## PHASE 3 — Secrets / cert delivery (user-driven, per-SBC)

**CERT MATERIALS RECEIVED (2026-08, Neustar/TruContact) — reviewed + crypto-validated locally (12/12, `attest A/C` + `div` sign & verify vs the published chain; tamper rejected).** In `~/Downloads/Granite_STI-CERT-2026/`:
- **Leaf + full chain:** `f66fa2f67c26804d8d82c0c7e7ec3ab7.cer` = leaf `CN=SHAKEN 8052, O=Granite Telecommunications LLC` → `Neustar SHAKEN CA-2` → `Neustar SHAKEN Root CA`. EC **P-256 / ES256**. **SPC/OCN = 8052** (TNAuthList). Valid **2026-05-08 → 2027-05-08** (calendar renewal ~Apr 2027).
- **⚠️ CORRECT private key = `private_key (bba972c7-3f2d-46cd-8c8e-0ef24bafa180).pem`** (unencrypted, pairs with the leaf). The plainly-named `private_key.pem`/`csrprod.pem` are a DIFFERENT non-issued enrollment attempt — DO NOT USE (PASSporTs would fail validation). The `.p12` didn't extract; not needed.

- **Task 3.1 — key delivery:** rename the correct key (e.g. `stir-8052.key`), deliver per-SBC OUT of git (like `.env`), mount read-only at `STIR_KEY_PATH`; uncomment the key volume in `docker-compose.sbc.yml` + set `STIR_KEY_PATH` in each `.env`.
- **Task 3.2 — x5u (`STIR_CERT_URL`) — the one OPEN item:** get our leaf's PUBLIC download URL from the TruContact portal (`authenticateapp.iconectiv.com`) — Neustar-hosted pattern `https://authenticate-api.iconectiv.com/download/v1/certificate/certificateId_<OURID>.crt`. MUST be publicly fetchable (no auth) + satisfy ATIS-1000074 §5.3.1 (https, no query/fragment/userinfo). *(Note: the STI-PA CA path reset when tested unauth'd — confirm OUR cert URL is public; else self-host leaf+intermediate PEM on a public HTTPS endpoint, e.g. a GCS bucket.)*
- **Task 3.3 — verify trust bundle (`STIR_VERIFY_CA_FILE`):** for inbound verify to trust OTHER carriers, load the iconectiv STI-PA trusted-root list (not just our Neustar root) + set `STIR_VERIFY_CERT_MODE=7`. Until then verify stays mode-0 (structural) or off.
- **Task 3.4 — Egress:** SBCs need outbound HTTPS only for the **verify** x5u fetch (host reachable: iconectiv TLS OK). Signing needs no egress.

## PHASE 4 — Deploy + verify (canary, per-SBC)

- **Task 4.1:** On one canary SBC: `git pull` + rebuild `kamailio`; `kamailio -c` config-check passes; container healthy; **calls still route with signing OFF** (dark deploy).
- **Task 4.2:** Set **`STIR_SHAKEN_SIGN=on` and `STIR_SHAKEN_VERIFY=on`** on the canary; place test calls — trunk (live DID **+16174544217**), an API call, an RCF forward — and inspect the **outbound** `Identity` header in **Homer** for each, **plus** the **inbound** verstat/verification outcome on the Bandwidth leg (one canary, both directions).
- **Task 4.3:** Verify the PASSporT actually **validates** (secsipid_check_identity locally, an external STIR/SHAKEN verifier, or Bandwidth inbound verification). Confirm attestation per product: **trunk A, API A, RCF `div` chain** (inbound Identity preserved + our `div`). Also confirm the **inbound** path sets a sane `verstat` on a call arriving with a valid Identity, and **fails open** (call completes, marked unverified) on one with a missing/bad Identity.
- **Task 4.4:** Confirm **NO call-path regression** — setup + teardown clean on all three products (TO_CARRIER is the sensitive path; recall the BYE-481 double-RR lessons). Check Homer for clean 200/ACK/BYE.
- **Task 4.5:** Roll `STIR_SHAKEN_SIGN=on` + the new image to the remaining 5 SBCs (West → East → Central), re-verifying one signed call per zone.

## PHASE 5 — Surface verstat to the terminating party (DEFERRED, optional)

- NOTE: both inbound Identity **capture** (Tasks 1.4/2.4) and inbound **crypto verification** (Phase 2B) are now CORE — done + canaried alongside signing. What remains deferred here is only **propagating the verstat result onward to the terminating party** (`P-Attestation-Indicator`/`verstat` to a trunk customer's PBX, or onto the RCF forwarded-to leg). Lower value + unclear consumer for RCF (the downstream carrier re-attests on its own B-leg anyway), so it can follow Phase 4 without gating launch.

---

## FINAL REVIEW CHECKLIST (Claude verifies after execution, before "ready to test")

- [ ] `secsipid` module loads on all 6 SBCs; `kamailio -c` passes everywhere.
- [ ] Signing block is at the correct point (after `msg_apply_changes`/`record_route_preset`, before relay); header ordering + double-RR/`r2` untouched.
- [ ] `X-Attestation` propagated from all three product Lua paths; RCF takes the `div` path (never A on a foreign number).
- [ ] Cert/key present per SBC at `STIR_KEY_PATH`; `STIR_CERT_URL` (x5u) set + reachable; **signature validates** externally.
- [ ] Attestation correct per product in a live test: trunk **A**, API **A**, RCF **`div`** (+ preserved inbound Identity). **RCF forward of an UNSIGNED inbound call → base attest `C` (Gateway)**, never B, never bare div (Granite policy 2026-08-05).
- [ ] `STIR_SHAKEN_SIGN` toggle works (dark deploy → enable); default-off honored.
- [ ] **No call-path regression** — live call setup + teardown clean across trunk/API/RCF (Homer confirms).
- [ ] **Inbound verify works + fails open** — valid inbound Identity → sane `verstat`; missing/bad Identity or x5u timeout → call still completes (annotate-only). `STIR_SHAKEN_VERIFY` toggle honored; x5u egress reachable + cached.
- [ ] Brief runbook note added to CLAUDE.md (where signing happens, the env vars, the div nuance).

## KEY RISKS / OPEN QUESTIONS
1. ~~Does `secsipid` support `div`?~~ **RESOLVED (2026-08-04):** yes via `secsipid_sign` + `append_hf`, no sidecar/vendor.
2. **A-leg↔B-leg inbound-Identity correlation across the FS B2BUA** (Tasks 1.4/2.4) — now the #1 design element: carry inbound `Identity` to FS as `X-In-Identity` and echo it on the B-leg so the `div` has a base to chain. Prove in Phase 1 with a real forwarded call in Homer. (If a given RCF forward truly has no inbound Identity, emit base-only per policy — never a bare `div`.)
3. **Cert prerequisite (P1–P3)** is the true gate — no valid signatures until Granite's SPC token + STI cert + x5u are in hand. Build can proceed dark in parallel.
4. **`secsipid_sign` JSON hygiene** — canonical `+E.164` for orig/dest/div, integer `iat`, JSON escaping via `$var` ops, `$secsipid(ret)` checked + fail-open. Low risk (string plumbing); unit-check in the canary.
5. **Live-path sensitivity** — TO_CARRIER is the most critical route; every change is dark-deployed + canaried, signing env-toggled.
6. **6-SBC secret distribution** — private key on every SBC; consider a shared per-zone signer later if key sprawl is a concern.
7. **Multi-hop RCF (RCF→RCF)** — each hop's `div` = the prior `dest`; the in-memory chain resolver knows every hop if we extend beyond single diversion.
8. **Inbound verify on the live path (NEW, 2026-08-05)** — folding verification forward puts a cert-fetch on the inbound INVITE path; mitigate with the `secsipid` cache (`cache_expire=3600`) + bounded `timeout` + strict fail-open, and prefer consuming Bandwidth's verification if SBC HTTPS egress is unwanted. Adds an egress dependency (Phase 2B.3 / 3.2) the signing path does not have.
