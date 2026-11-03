#!/usr/bin/env python3
"""Print every import id in imports.tf so it can be eyeballed against GCP.

No cloud calls, no Terraform: it only parses imports.tf. For each block it
prints the resource address, the import id, and the single-line gcloud
`describe --format='value(selfLink)'` command whose output must END with
that id (selfLink = https://www.googleapis.com/compute/v1/ + id).

    python3 check_ids.py            # table
    python3 check_ids.py --gcloud   # one describe command per object (paste-ready)
    python3 check_ids.py --ids      # bare ids only
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_FLAG = "--project={project}"

# resource-kind segment in the id -> (gcloud group, scope flag)
KINDS = {
    "addresses": ("compute addresses", "--region={scope}"),
    "subnetworks": ("compute networks subnets", "--region={scope}"),
    "instances": ("compute instances", "--zone={scope}"),
    "targetInstances": ("compute target-instances", "--zone={scope}"),
    "forwardingRules": ("compute forwarding-rules", "--region={scope}"),
    "instanceGroups": ("compute instance-groups unmanaged", "--zone={scope}"),
    "healthChecks": ("compute health-checks", "--region={scope}"),
    "backendServices": ("compute backend-services", "--region={scope}"),
    "firewalls": ("compute firewall-rules", ""),
}

BLOCK_RE = re.compile(r'import\s*\{\s*to\s*=\s*(?P<to>[^\n]+?)\s*\n\s*id\s*=\s*"(?P<id>[^"]+)"\s*\n\s*\}', re.S)
ID_RE = re.compile(
    r"^projects/(?P<project>[^/]+)/(?:(?P<scope_kind>regions|zones)/(?P<scope>[^/]+)|global)/(?P<kind>[^/]+)/(?P<name>[^/]+)$"
)


def parse(path):
    text = open(path, encoding="utf-8").read()
    return [(m.group("to").strip(), m.group("id")) for m in BLOCK_RE.finditer(text)]


def gcloud_cmd(import_id):
    m = ID_RE.match(import_id)
    if not m:
        return f"# unrecognised id format: {import_id}"
    kind = m.group("kind")
    if kind not in KINDS:
        return f"# no gcloud mapping for kind {kind}: {import_id}"
    group, scope_flag = KINDS[kind]
    flag = scope_flag.format(scope=m.group("scope")) if scope_flag else ""
    proj = PROJECT_FLAG.format(project=m.group("project"))
    return f"gcloud {group} describe {m.group('name')} {flag} {proj} --format='value(selfLink)'".replace("  ", " ")


def main(argv):
    mode = argv[1] if len(argv) > 1 else "--table"
    blocks = parse(os.path.join(HERE, "imports.tf"))
    if not blocks:
        print("no import blocks found in imports.tf", file=sys.stderr)
        return 1
    ids = [i for _, i in blocks]
    dupes = {i for i in ids if ids.count(i) > 1}
    if mode == "--ids":
        for _, i in blocks:
            print(i)
    elif mode == "--gcloud":
        print("# each command's selfLink must end with the id in the comment above it")
        for to, i in blocks:
            print(f"# {to}  ->  {i}")
            print(gcloud_cmd(i))
    else:
        w = max(len(to) for to, _ in blocks)
        for to, i in blocks:
            print(f"{to:<{w}}  {i}")
    print(f"\n{len(blocks)} import blocks", file=sys.stderr)
    if dupes:
        print(f"DUPLICATE ids: {sorted(dupes)}", file=sys.stderr)
        return 2
    bad = [i for i in ids if not ID_RE.match(i)]
    if bad:
        print(f"ids not in projects/... form: {bad}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
