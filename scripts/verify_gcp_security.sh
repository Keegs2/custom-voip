#!/usr/bin/env bash
# =============================================================================
# READ-ONLY GCP firewall exposure verification (audit P0-6 "verify-and-close").
# =============================================================================
# We cannot see live firewall state from the repo, so this script checks it
# for you: it lists every enabled INGRESS allow rule and grades the exposure
# of the ports that must NEVER be internet-reachable (Grafana 3000, qryn 3100,
# HEP 9060/9061, ClickHouse 8123, Redis 6379, ESL 8021, PG 5432/6432, coturn
# CLI 5766) plus the ones that must stay tightly scoped (UI/API 8080/8443/8088
# to office+uptime probers; SIP 5060/5061 to Bandwidth+healthcheck+probers;
# SSH 22 to IAP).
#
# READ-ONLY: the only API call is `gcloud compute firewall-rules list`.
#
# Usage (single line, workstation or any VM with gcloud):
#   bash /opt/revup/scripts/verify_gcp_security.sh
# Options via env:
#   PROJECT=rugged-night-193017   (default)
#   OFFICE_CIDRS="1.2.3.4/32,5.6.7.0/24"  — your office ranges; sources inside
#       them are treated as trusted for the admin-web ports.
#
# Exit codes: 0 = clean, 1 = warnings only, 2 = FAIL findings present.
# =============================================================================
set -euo pipefail

PROJECT="${PROJECT:-rugged-night-193017}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "== revup GCP firewall exposure check — project ${PROJECT} — $(date -u +%FT%TZ) =="
gcloud compute firewall-rules list --project "$PROJECT" --format=json > "$TMP"

OFFICE_CIDRS="${OFFICE_CIDRS:-}" python3 - "$TMP" << 'PY'
import ipaddress
import json
import os
import sys

rules = json.load(open(sys.argv[1]))

# ---- trusted source classes -------------------------------------------------
RFC1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
IAP = ["35.235.240.0/20"]
GCP_HC = ["35.191.0.0/16", "130.211.0.0/22"]
BANDWIDTH = ["67.231.0.0/16", "216.82.224.0/19"]
OFFICE = [c.strip() for c in os.environ.get("OFFICE_CIDRS", "").split(",") if c.strip()]

def nets(cidrs):
    return [ipaddress.ip_network(c) for c in cidrs]

TRUST_INTERNAL = nets(RFC1918 + IAP + GCP_HC)
TRUST_ADMIN = nets(RFC1918 + IAP + OFFICE)
TRUST_SIP = nets(RFC1918 + GCP_HC + BANDWIDTH)

def classify_source(src, trusted):
    try:
        n = ipaddress.ip_network(src)
    except ValueError:
        return "unknown"
    if n.prefixlen == 0:
        return "world"
    return "trusted" if any(n.subnet_of(t) for t in trusted if n.version == t.version) else "untrusted"

# ---- the policy: port -> (label, trust class, world-is) ----------------------
# world-is: severity when 0.0.0.0/0 reaches the port.
POLICY = {
    3000:  ("Grafana",            TRUST_ADMIN,    "FAIL"),
    3100:  ("qryn (no auth)",     TRUST_ADMIN,    "FAIL"),
    9096:  ("heplify metrics",    TRUST_INTERNAL, "FAIL"),
    9060:  ("HEP ingest",         TRUST_INTERNAL, "FAIL"),
    9061:  ("HEP ingest TCP",     TRUST_INTERNAL, "FAIL"),
    8123:  ("ClickHouse",         TRUST_INTERNAL, "FAIL"),
    6379:  ("Redis",              TRUST_INTERNAL, "FAIL"),
    8021:  ("FreeSWITCH ESL",     TRUST_INTERNAL, "FAIL"),
    5432:  ("PostgreSQL",         TRUST_INTERNAL, "FAIL"),
    6432:  ("PgBouncer",          TRUST_INTERNAL, "FAIL"),
    5766:  ("coturn CLI",         TRUST_INTERNAL, "FAIL"),
    8080:  ("UI HTTP",            TRUST_ADMIN,    "FAIL"),
    8443:  ("UI HTTPS",           TRUST_ADMIN,    "WARN"),
    8088:  ("API",                TRUST_ADMIN,    "FAIL"),
    9080:  ("admin web (legacy)", TRUST_ADMIN,    "FAIL"),
    5060:  ("SIP",                TRUST_SIP,      "WARN"),
    5061:  ("SIP TLS",            TRUST_SIP,      "WARN"),
    22:    ("SSH",                nets(IAP + RFC1918 + OFFICE), "FAIL"),
}

# Rules whose whole point is admitting Google uptime probers to probed ports.
UPTIME_RULES = ("voip-uptime-sip", "voip-uptime-web")
UPTIME_PORTS = {5060, 8088, 8443}
# World-open by design (not graded): RTP + TURN media, auth/SDP protects them.
EXPECTED_WORLD = {
    "udp": [(16384, 49151), (3478, 3478), (5349, 5349), (49152, 65535), (49160, 49200)],
    "tcp": [(3478, 3478), (5349, 5349)],
}

def port_in(port, spec):
    if "-" in spec:
        lo, hi = spec.split("-")
        return int(lo) <= port <= int(hi)
    return port == int(spec)

def expected_world(proto, spec):
    def rng(s):
        return (int(s.split("-")[0]), int(s.split("-")[1])) if "-" in s else (int(s), int(s))
    lo, hi = rng(spec)
    return any(lo >= a and hi <= b for a, b in EXPECTED_WORLD.get(proto, []))

findings = []  # (severity, message)
for rule in rules:
    if rule.get("disabled"):
        continue
    if rule.get("direction") != "INGRESS" or "allowed" not in rule:
        continue
    name = rule["name"]
    sources = rule.get("sourceRanges", []) or []
    if rule.get("sourceTags") or rule.get("sourceServiceAccounts"):
        continue  # tag/SA-scoped == VPC-internal by construction
    targets = rule.get("targetTags") or ["ALL-INSTANCES"]
    for allowed in rule["allowed"]:
        proto = allowed.get("IPProtocol", "all")
        specs = allowed.get("ports") or ["0-65535"]
        if proto not in ("tcp", "udp", "all"):
            continue
        for port, (label, trusted, world_sev) in POLICY.items():
            hits = [s for s in specs if port_in(port, s)]
            if not hits:
                continue
            if proto == "udp" and port not in (5060, 9060):
                continue  # graded ports are TCP services except SIP + HEP
            if name in UPTIME_RULES and port in UPTIME_PORTS:
                findings.append(("PASS", f"{label} :{port} <- rule '{name}' (Google uptime probers — expected)"))
                continue
            for src in sources:
                cls = classify_source(src, trusted)
                spec = hits[0]
                if cls == "world":
                    if expected_world(proto, spec):
                        continue
                    findings.append((world_sev, f"{label} :{port}/{proto} OPEN TO WORLD via rule '{name}' (ports {spec}, targets {','.join(targets)})"))
                elif cls == "untrusted":
                    findings.append(("WARN", f"{label} :{port}/{proto} allowed from {src} via rule '{name}' — not in the trusted set for this port (targets {','.join(targets)}); if this is an office/testing IP, set OFFICE_CIDRS to silence"))
                else:
                    findings.append(("PASS", f"{label} :{port}/{proto} <- {src} via '{name}' (trusted)"))

# Wide-open catch-all rules (protocol all / huge ranges from world).
for rule in rules:
    if rule.get("disabled") or rule.get("direction") != "INGRESS" or "allowed" not in rule:
        continue
    if "0.0.0.0/0" in (rule.get("sourceRanges") or []):
        for allowed in rule["allowed"]:
            if allowed.get("IPProtocol") == "all" or (
                allowed.get("IPProtocol") in ("tcp",) and not allowed.get("ports")
            ):
                findings.append(("FAIL", f"rule '{rule['name']}' allows ALL {allowed.get('IPProtocol')} from the WORLD (targets {','.join(rule.get('targetTags') or ['ALL-INSTANCES'])})"))

order = {"FAIL": 0, "WARN": 1, "PASS": 2}
findings.sort(key=lambda f: order[f[0]])
seen = set()
counts = {"FAIL": 0, "WARN": 0, "PASS": 0}
for sev, msg in findings:
    if (sev, msg) in seen:
        continue
    seen.add((sev, msg))
    counts[sev] += 1
    print(f"{sev:4}  {msg}")

print(f"\n== result: {counts['FAIL']} FAIL, {counts['WARN']} WARN, {counts['PASS']} PASS ==")
if counts["FAIL"]:
    print("Remediate FAILs now — single-line pattern to rescope a rule:")
    print("  gcloud compute firewall-rules update <RULE_NAME> --source-ranges=10.0.0.0/8,<OFFICE_CIDR>")
    print("Or delete a hand-made hole:  gcloud compute firewall-rules delete <RULE_NAME>")
    sys.exit(2)
sys.exit(1 if counts["WARN"] else 0)
PY
