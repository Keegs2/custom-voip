#!/usr/bin/env python3
"""
ops_commands.py — the ALLOW-LISTED command catalog for revup-ops-agent.

This module is the security boundary of the ops-agent. Everything the console can
execute on a production VM is defined HERE, as a fixed table. There is no dynamic
command construction, no shell, and no free-form passthrough.

The catalog holds two tiers:
  * READ commands  (mutating=False) — original v1 verbs: kamcmd `*.list`/`*.stats`/
    `*.get`/`core.uptime`; ESL `status`/`show`/`uuid_dump`; host `docker ps`/
    `docker logs`/`git rev-parse`/`journalctl`. They observe, never change state.
  * WRITE commands (mutating=True)  — a SMALL, curated set of REVERSIBLE operator
    actions: FS `uuid_kill`/`reloadxml`/`sofia … rescan`/`fsctl loglevel`, a
    synthetic `call.canary` test call, and Kamailio `dispatcher.reload`/
    `dispatcher.set_state`/`htable.sht_set|sht_rm blocked`. Each is chosen because
    an operator can undo it by calling another catalog verb (set the loglevel back,
    reload dispatcher, unblock the IP, re-rescan the profile). See WRITE_COMMAND_IDS
    and the per-command notes.

HARD RULES (enforced structurally, not by convention)
-----------------------------------------------------
1. Every command maps to a FIXED argv (a Python list) or a FIXED ESL verb. Params
   are validated (enum / int-range / strict regex / ipaddress / uuid) BEFORE the
   argv is built. A validated param is substituted as its own argv ELEMENT — never
   concatenated into a string and never passed to a shell.
2. Execution is `subprocess.run(argv, shell=False, ...)` (kamcmd) or the fixed-verb
   ESL client. `shell=True` appears NOWHERE. No value from a request ever reaches a
   shell.
3. WRITE commands are limited to the REVERSIBLE set above. A build-time blocklist
   (assert_no_forbidden_commands) rejects, at import, any catalog id/argv/verb that
   names a destructive or irreversible operation (fsctl shutdown, hupall, sofia
   profile start/stop/restart, arbitrary bgapi, lua/luarun, module load/unload,
   Kamailio core reload, raw shell/pty, PG data/volume touches). A future bad entry
   fails the process loudly instead of shipping.
4. Output is capped (STDOUT_CAP bytes) and every command has a per-command timeout
   so a hung/huge command can neither wedge the agent nor blow memory.
5. Commands are ROLE-GATED. `/healthz` advertises only the ids valid for the
   agent's detected role; `/run` re-checks the role and rejects (400) an id that
   isn't valid for this host. fs.* run only on fs, kamcmd.* only on sbc, a
   `services` host exposes only the host.* commands.

Adding a command later: add one entry to CATALOG with its role, mutating flag, a
param schema, and an argv/esl builder. No other code changes — the dispatcher,
validation, HTTP layer, and blocklist are generic over the table.
"""

import ipaddress
import json
import os
import re
import shutil
import subprocess
import time
import uuid as uuid_mod

from ops_esl import esl_api, esl_bgapi


# --------------------------------------------------------------------------- #
# Roles
# --------------------------------------------------------------------------- #

ROLE_SBC = "sbc"
ROLE_FS = "fs"
ROLE_SERVICES = "services"
VALID_ROLES = (ROLE_SBC, ROLE_FS, ROLE_SERVICES)

# The Kamailio ctl binrpc socket. Its PRESENCE is the primary role signal for an
# SBC (the carrier-monitor already relies on this exact path via a shared volume).
KAMCMD_SOCKET_PATH = os.environ.get(
    "KAMCMD_SOCKET_PATH", "/var/run/kamailio/kamailio_ctl"
).strip() or "/var/run/kamailio/kamailio_ctl"
KAMCMD_SOCKET = "unix:" + KAMCMD_SOCKET_PATH
KAMCMD_BIN = os.environ.get("KAMCMD_BIN", "kamcmd").strip() or "kamcmd"

# Repo path on the VMs (used by host.git_head). Fixed per the deploy model
# (/opt/revup on every VM); overridable only via env, never via request.
REPO_PATH = os.environ.get("OPS_REPO_PATH", "/opt/revup").strip() or "/opt/revup"

# Output + time caps.
STDOUT_CAP = 256 * 1024      # ~256 KB per the contract
DEFAULT_TIMEOUT = 10.0        # seconds, per-command default


# --------------------------------------------------------------------------- #
# Role detection
#
# Precedence:
#   1. OPS_AGENT_ROLE env, if it names a valid role — explicit operator override,
#      the most robust option when a host is ambiguous. Documented in the compose
#      files / .env examples.
#   2. Kamailio ctl socket present  -> sbc   (deterministic filesystem check;
#      the socket only exists where Kamailio runs).
#   3. FreeSWITCH marker present    -> fs    (fs_cli/freeswitch binary on PATH, or
#      OPS_AGENT_ROLE unset but ESL creds provided). We check for the freeswitch
#      binary / fs_cli on PATH, which exist only in/next-to the FS image.
#   4. otherwise                    -> services
#
# Detection runs ONCE at import; the agent then serves exactly that role.
# --------------------------------------------------------------------------- #

def _detect_role() -> str:
    override = os.environ.get("OPS_AGENT_ROLE", "").strip().lower()
    if override in VALID_ROLES:
        return override

    # SBC: the Kamailio control socket is mounted here.
    try:
        if os.path.exists(KAMCMD_SOCKET_PATH):
            return ROLE_SBC
    except OSError:
        pass

    # FS: the FreeSWITCH binary / fs_cli is on PATH only on the media image, or
    # an explicit FS marker file is present. (We intentionally do NOT open a TCP
    # probe to ESL at import time — a slow/refused probe must never delay startup;
    # a binary-on-PATH check is instant and deterministic.)
    if shutil.which("fs_cli") or shutil.which("freeswitch"):
        return ROLE_FS
    if os.environ.get("OPS_AGENT_FS_MARKER", "").strip():
        return ROLE_FS

    return ROLE_SERVICES


ROLE = _detect_role()


# --------------------------------------------------------------------------- #
# Param validation helpers. Each raises ValueError(msg) on bad input; the HTTP
# layer turns that into a 400. They RETURN the validated, canonical value that
# gets placed into argv as its own element.
# --------------------------------------------------------------------------- #

def _enum(name: str, value, choices):
    """Value must be one of `choices` (compared as strings)."""
    sval = "" if value is None else str(value)
    if sval not in choices:
        raise ValueError(
            f"param '{name}' must be one of {sorted(choices)}, got {sval!r}"
        )
    return sval


def _int_range(name: str, value, lo: int, hi: int) -> int:
    """
    Value must be an int (or int-like str) within [lo, hi]. Rejects:
      - bools (bool is an int subclass),
      - floats / numeric strings with a fractional part (e.g. 3.5, "3.5") — these
        are NOT integers and must not be silently truncated,
      - anything non-numeric.
    """
    try:
        # bool is an int subclass — reject explicitly (True/False are not levels).
        if isinstance(value, bool):
            raise ValueError
        if isinstance(value, float):
            # Only an exact integer-valued float is acceptable (e.g. 6.0).
            if not value.is_integer():
                raise ValueError
            ival = int(value)
        elif isinstance(value, int):
            ival = value
        else:
            # Strings / other: parse strictly as an int. int("3.5") raises, which is
            # what we want (a fractional string is not an integer).
            ival = int(str(value).strip())
    except (TypeError, ValueError):
        raise ValueError(f"param '{name}' must be an integer in [{lo},{hi}]")
    if ival < lo or ival > hi:
        raise ValueError(f"param '{name}' must be in [{lo},{hi}], got {ival}")
    return ival


# Strict UUID (FreeSWITCH channel UUIDs are canonical v4 UUIDs). Anchored, so no
# extra tokens can ride along into the ESL verb.
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _uuid(name: str, value) -> str:
    sval = "" if value is None else str(value)
    if not _UUID_RE.match(sval):
        raise ValueError(f"param '{name}' must be a valid UUID")
    return sval


# `journalctl --since` accepts free text; we DO NOT pass free text through. Allow
# only a strict, unambiguous subset that cannot be an option or injection:
#   - ISO-ish absolute:  YYYY-MM-DD[ HH:MM[:SS]]
#   - simple relative:   "<N> <unit> ago"  (unit in a fixed set)
# Anything else is rejected. The value still goes in its OWN argv element (never a
# shell), so this is defense-in-depth on top of shell=False.
_SINCE_ABS_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$"
)
_SINCE_REL_RE = re.compile(
    r"^\d{1,4}\s+(?:second|seconds|minute|minutes|hour|hours|day|days)\s+ago$"
)


def _since(name: str, value) -> str:
    sval = ("" if value is None else str(value)).strip()
    if not sval:
        raise ValueError(f"param '{name}' is required when provided")
    if _SINCE_ABS_RE.match(sval) or _SINCE_REL_RE.match(sval):
        return sval
    raise ValueError(
        f"param '{name}' must be 'YYYY-MM-DD[ HH:MM[:SS]]' or 'N <unit> ago'"
    )


def _ip_or_cidr(name: str, value) -> str:
    """
    Value must parse as a single IP address (v4/v6) or an IP network (CIDR). We use
    the stdlib `ipaddress` module — anything it can't parse is rejected. The
    canonical string form it returns is what goes into the kamcmd argv element (its
    own element, never a shell). `strict=False` lets a host address carry a prefix
    (e.g. 10.0.0.5/32) without erroring; we canonicalize with the network address
    for a CIDR and the plain address for a bare host.

    NOTE: the Kamailio `blocked` htable is keyed on the source IP `$si` (a single
    address) in kamailio.cfg. A bare IP is the normal, matching key. A CIDR is
    accepted and stored verbatim as an htable key for operator record-keeping, but
    ONLY an exact bare-IP key participates in the `$sht(blocked=>$si)` lookup — this
    is documented on kamcmd.htable.block so an operator isn't surprised.
    """
    sval = ("" if value is None else str(value)).strip()
    if not sval:
        raise ValueError(f"param '{name}' must be an IP address or CIDR")
    # Reject anything with whitespace / stray tokens up front (ipaddress would
    # raise anyway, but be explicit — this key becomes an htable key string).
    if any(c.isspace() for c in sval):
        raise ValueError(f"param '{name}' must be a single IP address or CIDR")
    try:
        if "/" in sval:
            net = ipaddress.ip_network(sval, strict=False)
            return str(net)
        return str(ipaddress.ip_address(sval))
    except ValueError:
        raise ValueError(f"param '{name}' must be a valid IP address or CIDR")


# Dispatcher destination address: strict host[:port]. host is an IPv4 literal, or a
# bracketed IPv6 literal, or a DNS name; port (if present) is 1..65535. This is the
# `_address_` arg to `dispatcher.set_state <state> <group> <address>`; dispatcher
# addresses in dispatcher.list are `sip:IP:PORT`, so we ALSO accept an optional
# leading `sip:` scheme and normalize to what kamcmd expects. Anchored — no extra
# tokens can ride in. The validated value is one argv element (never a shell).
_HOST_LABEL = r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)"
_HOSTNAME_RE = re.compile(rf"^{_HOST_LABEL}(?:\.{_HOST_LABEL})*$")
_IPV4_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")


def _dispatcher_address(name: str, value) -> str:
    """
    Validate a dispatcher destination as (optional `sip:`) host[:port], returning
    the `sip:host:port` (or `sip:host`) form kamcmd stores. host must be a valid
    IPv4 literal, a bracketed IPv6 literal, or a DNS hostname; port 1..65535.
    """
    sval = ("" if value is None else str(value)).strip()
    if not sval:
        raise ValueError(f"param '{name}' is required")
    body = sval[4:] if sval.lower().startswith("sip:") else sval

    host = None
    port = None
    if body.startswith("["):
        # Bracketed IPv6: [addr] or [addr]:port
        close = body.find("]")
        if close == -1:
            raise ValueError(f"param '{name}': malformed IPv6 address")
        host_part = body[1:close]
        try:
            ipaddress.IPv6Address(host_part)
        except ValueError:
            raise ValueError(f"param '{name}': invalid IPv6 address")
        host = "[" + host_part + "]"
        rest = body[close + 1:]
        if rest:
            if not rest.startswith(":"):
                raise ValueError(f"param '{name}': junk after IPv6 address")
            port = rest[1:]
    else:
        # host[:port] — split on the LAST colon only (bare IPv6 without brackets is
        # rejected: it is ambiguous with host:port and dispatcher.list uses
        # bracketed form for v6).
        if body.count(":") > 1:
            raise ValueError(
                f"param '{name}': bare IPv6 must be bracketed as [addr]"
            )
        if ":" in body:
            host, port = body.rsplit(":", 1)
        else:
            host = body
        if not (_IPV4_RE.match(host) or _HOSTNAME_RE.match(host)):
            raise ValueError(f"param '{name}': invalid host {host!r}")
        if _IPV4_RE.match(host):
            # Validate each octet 0..255 via ipaddress.
            try:
                ipaddress.IPv4Address(host)
            except ValueError:
                raise ValueError(f"param '{name}': invalid IPv4 address")

    if port is not None:
        if not port.isdigit():
            raise ValueError(f"param '{name}': port must be numeric")
        pnum = int(port)
        if pnum < 1 or pnum > 65535:
            raise ValueError(f"param '{name}': port must be in [1,65535]")
        return f"sip:{host}:{pnum}"
    return f"sip:{host}"


# --------------------------------------------------------------------------- #
# Allow-lists for host.* commands (container names / journald units). These are
# CLOSED sets — a request can only name something already in the set.
# --------------------------------------------------------------------------- #

# Known container names across all VM roles (superset; a given host only runs
# some). host.docker_logs may target any of these; unknown names are rejected.
KNOWN_CONTAINERS = frozenset({
    "voip-kamailio",
    "voip-freeswitch",
    "voip-redis",
    "voip-api",
    "voip-cdr-exporter",
    "voip-ui",
    "voip-carrier-monitor",
    "voip-ops-agent",
    "voip-clickhouse",
    "voip-qryn",
    "voip-heplify-server",
    "voip-grafana",
})

# Known systemd units the operator may want tailed FROM THE HOST journal. Kept to
# infrastructure units relevant to this platform. journalctl-from-a-container is
# best-effort (see JOURNAL_AVAILABLE); when unavailable we report cleanly rather
# than fail. docker_logs covers per-container logs regardless.
KNOWN_UNITS = frozenset({
    "docker",
    "docker.service",
    "pgbouncer",
    "pgbouncer.service",
    "postgresql",
    "postgresql.service",
    "google-guest-agent",
    "google-guest-agent.service",
    "systemd-journald",
    "systemd-journald.service",
})


# --------------------------------------------------------------------------- #
# Command execution primitive (subprocess, shell=False, capped, timed).
# --------------------------------------------------------------------------- #

def _cap(text: str) -> str:
    """Cap a captured stream to STDOUT_CAP bytes, annotating truncation."""
    if text is None:
        return ""
    raw = text.encode("utf-8", "replace")
    if len(raw) <= STDOUT_CAP:
        return text
    trimmed = raw[:STDOUT_CAP].decode("utf-8", "replace")
    return trimmed + f"\n...[truncated at {STDOUT_CAP} bytes]"


def _run_argv(argv, timeout: float):
    """
    Run a FIXED argv with shell=False. Returns
    (ok, exit_code, stdout, stderr). Never raises — a missing binary / timeout is
    reported as ok=False with a nonzero exit_code and a diagnostic on stderr.

    ok == (exit_code == 0). `argv[0]` must be an absolute path or a bare binary
    name resolved via PATH by execvp — NOT a shell string.
    """
    try:
        proc = subprocess.run(
            argv,
            shell=False,               # NEVER a shell — hard invariant
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return False, 127, "", f"executable not found: {argv[0]}"
    except subprocess.TimeoutExpired:
        return False, 124, "", f"command timed out after {timeout:.0f}s"
    except OSError as exc:
        return False, 126, "", f"failed to execute {argv[0]}: {exc}"

    return (
        proc.returncode == 0,
        proc.returncode,
        _cap(proc.stdout),
        _cap(proc.stderr),
    )


def _kamcmd_argv(*verb):
    """Build a fixed kamcmd argv against the pinned ctl socket."""
    return [KAMCMD_BIN, "-s", KAMCMD_SOCKET, *verb]


def _run_esl(verb: str, timeout: float):
    """Adapt the ESL client to the (ok, exit_code, stdout, stderr) shape."""
    ok, out, err = esl_api(verb, timeout=timeout)
    # ESL has no OS exit code; synthesize one (0 ok, 1 error) for a uniform
    # response shape. A FreeSWITCH "-ERR ..." body still returns ok=True at the
    # transport level (the command ran); callers inspect stdout for -ERR/+OK.
    return ok, (0 if ok else 1), _cap(out), _cap(err)


# --------------------------------------------------------------------------- #
# journalctl availability probe (best-effort in a container).
#
# journalctl works in a container only if the host journal is mounted read-only
# (/var/log/journal + /etc/machine-id) AND the journalctl binary is present. We
# detect that at import: binary on PATH and a persistent journal dir present. If
# not available, host.journalctl returns a clean "unavailable" result (ok=False,
# a descriptive stderr) instead of failing the request — docker_logs still covers
# container logs. This is the documented, safe-feasible behavior.
# --------------------------------------------------------------------------- #

def _journal_available() -> bool:
    if not shutil.which("journalctl"):
        return False
    # A mounted persistent host journal shows up as /var/log/journal/<machine-id>.
    try:
        return os.path.isdir("/var/log/journal") and any(
            os.scandir("/var/log/journal")
        )
    except OSError:
        return False


JOURNAL_AVAILABLE = _journal_available()


def _journalctl_run(params, timeout):
    unit = _enum("unit", params.get("unit"), KNOWN_UNITS)
    lines = _int_range("lines", params.get("lines", 100), 1, 500)
    since_raw = params.get("since")
    argv = [
        "journalctl",
        "--no-pager",
        "-u", unit,
        "-n", str(lines),
    ]
    if since_raw is not None and str(since_raw).strip() != "":
        argv += ["--since", _since("since", since_raw)]

    if not JOURNAL_AVAILABLE:
        # Graceful, documented degradation — not an error the console must handle
        # as a crash. exit_code 125 == "unavailable in this deployment".
        return (
            False,
            125,
            "",
            "host.journalctl unavailable in this container "
            "(host journal not mounted; use host.docker_logs for container logs)",
        )
    return _run_argv(argv, timeout)


# --------------------------------------------------------------------------- #
# git_head is two commands stitched into one readable result.
# --------------------------------------------------------------------------- #

def _git_head_run(_params, timeout):
    ok1, code1, sha, err1 = _run_argv(
        ["git", "-C", REPO_PATH, "rev-parse", "HEAD"], timeout
    )
    if not ok1:
        return ok1, code1, sha, err1
    ok2, code2, desc, err2 = _run_argv(
        ["git", "-C", REPO_PATH, "log", "-1", "--format=%cs %s"], timeout
    )
    out = sha.strip()
    if ok2 and desc.strip():
        out = out + "\n" + desc.strip()
    return ok2, code2, _cap(out), (err2 if not ok2 else "")


# --------------------------------------------------------------------------- #
# The CATALOG.
#
# Each entry:
#   role : which role may run it
#   run  : callable(params: dict, timeout: float) -> (ok, exit_code, stdout, stderr)
#          The callable is responsible for validating params (raising ValueError
#          on bad input) and building the FIXED argv / ESL verb.
#   timeout (optional) : override DEFAULT_TIMEOUT.
# --------------------------------------------------------------------------- #

# Spec builders. `mutating` marks a WRITE command (default False = READ). The flag
# rides in the spec dict so the dispatcher/HTTP layer and the ted backend/audits can
# distinguish reads from writes; it is ALSO surfaced as the module-level frozenset
# WRITE_COMMAND_IDS (derived from the catalog at import). Both mechanisms are
# provided — see report.
def _sbc(fn, timeout=DEFAULT_TIMEOUT, mutating=False):
    return {"role": ROLE_SBC, "run": fn, "timeout": timeout, "mutating": mutating}


def _fsr(fn, timeout=DEFAULT_TIMEOUT, mutating=False):
    return {"role": ROLE_FS, "run": fn, "timeout": timeout, "mutating": mutating}


def _host(fn, timeout=DEFAULT_TIMEOUT, mutating=False):
    # role None = all roles
    return {"role": None, "run": fn, "timeout": timeout, "mutating": mutating}


# ---- SBC (kamcmd over the ctl socket) ------------------------------------- #

_STATS_GROUPS = frozenset({"sl", "tmx", "dialog", "shmem", "core"})
_HTABLES = frozenset({"blocked", "bw_cps", "trunk_cps", "failedauth", "ipreputation"})


def _kam_dispatcher_list(_p, t):
    return _run_argv(_kamcmd_argv("dispatcher.list"), t)


def _kam_core_uptime(_p, t):
    return _run_argv(_kamcmd_argv("core.uptime"), t)


def _kam_tm_stats(_p, t):
    return _run_argv(_kamcmd_argv("tm.stats"), t)


def _kam_dlg_stats_active(_p, t):
    return _run_argv(_kamcmd_argv("dlg.stats_active"), t)


def _kam_stats_fetch(p, t):
    group = _enum("group", p.get("group"), _STATS_GROUPS)
    # `stats.fetch <group>` — the group is a validated enum placed as its own argv
    # element. kamcmd renders that group's counters.
    return _run_argv(_kamcmd_argv("stats.fetch", group), t)


def _kam_htable_dump(p, t):
    table = _enum("table", p.get("table"), _HTABLES)
    return _run_argv(_kamcmd_argv("htable.dump", table), t)


# ---- SBC WRITE verbs (kamcmd over the ctl socket) ------------------------- #
#
# All reversible:
#   dispatcher.reload    — re-reads dispatcher.list from disk; undo = edit + reload.
#   dispatcher.set_state — flips one destination's admin state; undo = set_state
#                          back (typically "ap"=active+probing) or dispatcher.reload.
#   htable.sht_set blocked <ip> 1 / htable.sht_rm blocked <ip> — block/unblock a
#                          source IP in the SAME `blocked` htable kamailio.cfg uses
#                          (`$sht(blocked=>$si)=1`, autoexpire=300s). Exact inverses.
#
# dispatcher.set_state signature (Kamailio 5.8 dispatcher RPC):
#     dispatcher.set_state <state> <group> <address>
# state ∈ {a,i,t,d} optionally + "p" (probing): a=active, i=inactive, t=trying,
# d=disabled; e.g. "ap","ip". group is the integer setid (1..5 here). address is
# the destination SIP URI, e.g. sip:67.231.2.12:5060.

# The block htable NAME + value semantics, confirmed from docker/kamailio/
# kamailio.cfg: `modparam("htable","htable","blocked=>size=12;autoexpire=300")`
# and the guard `if ($sht(blocked=>$si) != $null)` / setter `$sht(blocked=>$si)=1`.
_BLOCK_HTABLE = "blocked"
_BLOCK_VALUE = "1"

# Valid dispatcher.set_state tokens (base state, plus optional trailing "p"). We
# allow-list the base + probing variants explicitly rather than regex-permit
# arbitrary trailing chars.
_DS_STATES = frozenset({
    "a", "i", "t", "d",         # active / inactive / trying / disabled
    "ap", "ip", "tp", "dp",     # …each with probing on
})

# Dispatcher setids present in dispatcher.list (group 1 = FS, 2..5 = Bandwidth PoP
# keepalive groups). Range-checked; an out-of-range group is rejected before argv.
_DS_GROUP_MIN = 1
_DS_GROUP_MAX = 64  # generous upper bound; real groups are 1..5, but never negative


def _kam_dispatcher_reload(_p, t):
    return _run_argv(_kamcmd_argv("dispatcher.reload"), t)


def _kam_dispatcher_set_state(p, t):
    state = _enum("state", p.get("state"), _DS_STATES)
    group = _int_range("group", p.get("group"), _DS_GROUP_MIN, _DS_GROUP_MAX)
    address = _dispatcher_address("address", p.get("address"))
    # dispatcher.set_state <state> <group> <address> — each a validated argv element.
    return _run_argv(
        _kamcmd_argv("dispatcher.set_state", state, str(group), address), t
    )


def _kam_htable_block(p, t):
    key = _ip_or_cidr("key", p.get("key"))
    # htable.sht_set <table> <key> <value> — write 1 into the `blocked` htable, the
    # exact table+value kamailio.cfg tests. Fixed table + fixed value; key validated.
    return _run_argv(
        _kamcmd_argv("htable.sht_set", _BLOCK_HTABLE, key, _BLOCK_VALUE), t
    )


def _kam_htable_unblock(p, t):
    key = _ip_or_cidr("key", p.get("key"))
    # htable.sht_rm <table> <key> — delete the key from `blocked`. Exact inverse of
    # block.
    return _run_argv(_kamcmd_argv("htable.sht_rm", _BLOCK_HTABLE, key), t)


# ---- FS (local ESL, read-only api verbs) ---------------------------------- #

_FS_PROFILES = frozenset({"internal", "external"})


def _fs_sofia_status(_p, t):
    return _run_esl("sofia status", t)


def _fs_sofia_status_profile(p, t):
    profile = _enum("profile", p.get("profile"), _FS_PROFILES)
    return _run_esl(f"sofia status profile {profile}", t)


def _fs_show_channels(_p, t):
    return _run_esl("show channels as json", t)


def _fs_show_calls(_p, t):
    return _run_esl("show calls as json", t)


def _fs_uuid_dump(p, t):
    uuid = _uuid("uuid", p.get("uuid"))
    return _run_esl(f"uuid_dump {uuid}", t)


def _fs_status(_p, t):
    return _run_esl("status", t)


# ---- FS WRITE verbs (local ESL, reversible) ------------------------------- #
#
# All reversible:
#   uuid_kill <uuid>          — hangs up ONE live channel by strict UUID. The undo
#                               of a call is placing it again; a stuck/abusive
#                               channel is exactly what an operator needs to clear.
#                               (NOT hupall — that mass-kills and is hard-excluded.)
#   reloadxml                 — re-reads XML config into memory. Idempotent; undo =
#                               reloadxml again after fixing config. Does NOT restart
#                               anything or drop calls.
#   sofia profile <p> rescan  — reloads gateway/profile config WITHOUT restarting the
#                               profile (no socket teardown, live calls preserved).
#                               undo = rescan again. profile ∈ {internal, external}.
#                               (rescan, NOT restart/stop/start — those are excluded.)
#   fsctl loglevel <n>        — sets the global console/log verbosity 0..7. Purely
#                               observational side effect. Reversible by calling it
#                               again with the default (FS_DEFAULT_LOGLEVEL = 6,
#                               "info" — FreeSWITCH's normal default). The agent is
#                               stateless req/resp, so there is NO auto-revert timer;
#                               "revert" == run fs.loglevel with level 6.

# FreeSWITCH default console loglevel. Levels: 0=CONSOLE,1=ALERT,2=CRIT,3=ERR,
# 4=WARNING,5=NOTICE,6=INFO,7=DEBUG. 6 (INFO) is FS's normal running level, so it is
# the natural "revert" value an operator passes to undo a temporary bump to 7 (DEBUG).
FS_DEFAULT_LOGLEVEL = 6


def _fs_uuid_kill(p, t):
    uuid = _uuid("uuid", p.get("uuid"))
    # uuid_kill <uuid> — no cause argument (kept minimal; FS uses NORMAL_CLEARING).
    # Fixed verb + strict-UUID argument as its own token in the ESL string.
    return _run_esl(f"uuid_kill {uuid}", t)


def _fs_reloadxml(_p, t):
    return _run_esl("reloadxml", t)


def _fs_sofia_rescan(p, t):
    profile = _enum("profile", p.get("profile"), _FS_PROFILES)
    # sofia profile <profile> rescan — reload config without bouncing the profile.
    return _run_esl(f"sofia profile {profile} rescan", t)


def _fs_loglevel(p, t):
    level = _int_range("level", p.get("level"), 0, 7)
    # fsctl loglevel <n> — global log verbosity. `fsctl loglevel` is the switch-wide
    # setter (vs `console loglevel`, which only affects the local console sink);
    # fsctl is the correct reversible verb for an out-of-band operator changing the
    # running level, and it is explicitly NOT one of the excluded fsctl subcommands
    # (shutdown/hupall/etc — see the blocklist).
    return _run_esl(f"fsctl loglevel {level}", t)


# ---- FS canary test call (bgapi originate + bounded poll) ----------------- #
#
# call.canary places a SYNTHETIC test call to the platform's known test DID and
# reports a verdict (ANSWERED / NO-ANSWER / FAILED+cause). It proves the live
# egress path (FS -> SBC -> Bandwidth -> PSTN forward) end-to-end without a human.
#
# HOW IT STAYS SAFE / IDENTIFIABLE:
#   - Destination is the FIXED test DID CANARY_DEST (+16174544217), which CLAUDE.md
#     documents as the live test DID that forwards to +17744045256. It is NEVER
#     taken from request params.
#   - We set our OWN origination_uuid so we can poll THAT exact channel and so the
#     CDR carries a stable id. We also set channel var `canary=1` (+ optional
#     `canary_tag`) so the CDR is unambiguously a synthetic test and downstream
#     rating/audits can exclude it from customer billing. (This agent does not touch
#     the rating path; the tag is the identification contract.)
#   - Origination uses `bgapi originate` (non-blocking) so the HTTP request never
#     hangs; we then poll `uuid_exists`/`uuid_getvar` on our origination_uuid for up
#     to CANARY_POLL_SECONDS and kill the channel at the end so a canary never lingers
#     as a real billable call.
#   - The originate line mirrors the API's own outbound convention
#     (docker/api/src/services/esl_client.py): external profile through the SBC proxy
#     `sofia/external/<dest>@<SBC_PROXY_IP>:5060`, `origination_caller_id_number`,
#     `sip_h_X-Carrier=primary`, `ignore_early_media=true`. App leg is `&park` so the
#     answered state is briefly observable by the poll; we kill it on first answer.
#
# The originate VERB is assembled from the fixed DID + env (SBC_PROXY_IP), never from
# free request input; the ONLY request-derived value is an optional short tag, which
# is strictly sanitized to [A-Za-z0-9_-] before it is placed in a channel var.

CANARY_DEST = os.environ.get("CANARY_DEST", "+16174544217").strip() or "+16174544217"
# Primary SBC proxy IP — same env var the API/FS outbound path uses. Default to
# loopback so a dev box degrades to a clear FAILED verdict rather than misrouting.
CANARY_SBC_PROXY = (
    os.environ.get("SBC_PROXY_IP", "127.0.0.1").strip() or "127.0.0.1"
)
CANARY_CARRIER = "primary"          # X-Carrier: Dallas primary (matches API default)
CANARY_POLL_SECONDS = float(
    os.environ.get("CANARY_POLL_SECONDS", "30").strip() or "30"
)
CANARY_POLL_INTERVAL = 1.0          # seconds between uuid polls
CANARY_ORIG_TIMEOUT = 25            # seconds FS waits for answer (< poll budget)

_CANARY_TAG_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def _canary_tag(value) -> str:
    """Optional short tag placed into the `canary_tag` channel var. Strict charset;
    empty/None -> "" (omitted). Never anything that could break the var list."""
    if value is None:
        return ""
    sval = str(value).strip()
    if sval == "":
        return ""
    if not _CANARY_TAG_RE.match(sval):
        raise ValueError(
            "param 'tag' must be 1-40 chars of [A-Za-z0-9_-]"
        )
    return sval


def _fs_canary(p, t):
    """
    Originate a synthetic canary call and return a verdict. The (ok, exit_code,
    stdout, stderr) contract is preserved: stdout is a compact human/JSON verdict,
    ok=True ONLY when the canary ANSWERED. NO-ANSWER and FAILED come back ok=False
    with a descriptive stdout/stderr so the console shows a clear result rather than
    a 500.
    """
    tag = _canary_tag(p.get("tag"))

    # Our own origination UUID — lets us poll this exact channel and stamps the CDR.
    orig_uuid = str(uuid_mod.uuid4())

    # Channel variables. All values here are FIXED or already-validated (orig_uuid is
    # a generated UUID; tag passed _canary_tag). Comma-separated {var=val,...} block.
    varlist = [
        f"origination_uuid={orig_uuid}",
        f"origination_caller_id_number={CANARY_DEST}",
        "origination_caller_id_name=canary",
        "canary=1",
        "direction=outbound",
        "ignore_early_media=true",
        f"originate_timeout={CANARY_ORIG_TIMEOUT}",
        f"sip_h_X-Carrier={CANARY_CARRIER}",
    ]
    if tag:
        varlist.append(f"canary_tag={tag}")
    varblock = ",".join(varlist)

    dest = f"sofia/external/{CANARY_DEST}@{CANARY_SBC_PROXY}:5060"
    # bgapi originate {vars}dest &park — background so the HTTP call returns fast.
    # App is `&park` (NOT &hangup): when the carrier/destination answers, FS parks
    # the answered leg, holding Answer-State=answered long enough for our ~1s poll to
    # observe it reliably (a &hangup can flip answered->destroyed inside one poll
    # interval and be missed). We break on the FIRST answered read and IMMEDIATELY
    # uuid_kill, so a parked canary is held for at most one poll interval (~1s) before
    # teardown — never a lingering billable call. `park` is a benign, allow-listed
    # app; nothing about it is destructive. Verb is fixed apart from the
    # validated/fixed pieces above.
    originate_cmd = f"originate {{{varblock}}}{dest} &park"

    started = time.monotonic()
    # We poll our OWN origination_uuid (below), not the bgapi Job-UUID, so the
    # returned job id is intentionally unused — the bgapi call is just the
    # non-blocking spawn.
    ok_bg, _job_uuid, err_bg = esl_bgapi(originate_cmd, timeout=t)
    if not ok_bg:
        return (
            False, 1, f"canary FAILED: could not start originate ({err_bg})",
            err_bg or "bgapi originate failed",
        )

    # Poll our origination_uuid with read-only verbs (no event subscription needed —
    # we own the UUID). Classification:
    #   - uuid_getvar Answer-State == "answered" while the channel is live -> ANSWERED
    #   - channel appeared then disappeared before we saw "answered"       -> FAILED-fast
    #     is NOT it; it progressed, so we report NO-ANSWER only if budget ran out.
    #     A channel that came up and then vanished without answering is reported as
    #     NO-ANSWER (it reached the carrier but the far end did not answer/complete).
    #   - channel never appeared at all within budget                      -> FAILED
    #   - budget exhausted while still ringing                             -> NO-ANSWER
    # We do NOT read a hangup cause off a destroyed channel (not possible without
    # event subscription); the verdict is derived from the observed live states.
    deadline = started + CANARY_POLL_SECONDS
    answered = False
    last_state = ""
    saw_channel = False

    while time.monotonic() < deadline:
        ok_ex, out_ex, _ = esl_api(f"uuid_exists {orig_uuid}", timeout=5.0)
        exists = ok_ex and out_ex.strip().lower().startswith("true")
        if exists:
            saw_channel = True
            # Check answer state on the live channel.
            ok_st, out_st, _ = esl_api(
                f"uuid_getvar {orig_uuid} Answer-State", timeout=5.0
            )
            st = (out_st or "").strip().lower()
            if st:
                last_state = st
            if st == "answered":
                answered = True
                break
        elif saw_channel:
            # Channel existed and is now gone -> call completed/failed. If it had
            # reached "answered" we'd have broken above; getting here means it ended
            # without our seeing an answered state (short call or early failure).
            break
        time.sleep(CANARY_POLL_INTERVAL)

    # Always clean up: if our channel is somehow still up (e.g. answered and we
    # broke), kill it so a canary never becomes a lingering billable call.
    esl_api(f"uuid_kill {orig_uuid}", timeout=5.0)

    duration = time.monotonic() - started
    verdict = {
        "canary": True,
        "origination_uuid": orig_uuid,
        "dest": CANARY_DEST,
        "tag": tag,
        "answered": answered,
        "last_answer_state": last_state,
        "elapsed_s": round(duration, 1),
    }
    if answered:
        verdict["verdict"] = "ANSWERED"
        return True, 0, json.dumps(verdict), ""
    if saw_channel:
        # It progressed (reached the carrier) but never answered within budget.
        verdict["verdict"] = "NO-ANSWER"
        return False, 1, json.dumps(verdict), "canary NO-ANSWER"
    # Never saw the channel come up at all -> origination failed fast.
    verdict["verdict"] = "FAILED"
    return False, 1, json.dumps(verdict), "canary FAILED: no channel"


# ---- host / docker (all roles) -------------------------------------------- #

def _host_docker_ps(_p, t):
    return _run_argv(["docker", "ps", "--format", "{{json .}}"], t)


def _host_docker_logs(p, t):
    container = _enum("container", p.get("container"), KNOWN_CONTAINERS)
    tail = _int_range("tail", p.get("tail", 100), 1, 500)
    # docker logs --tail N <container> ; each token its own argv element.
    return _run_argv(["docker", "logs", "--tail", str(tail), container], t)


def _host_journalctl(p, t):
    return _journalctl_run(p, t)


# Canary needs a timeout above its poll budget so the per-command watchdog never
# fires before the canary itself finishes and cleans up.
_CANARY_TIMEOUT = CANARY_POLL_SECONDS + 10.0


CATALOG = {
    # SBC — READ
    "kamcmd.dispatcher_list": _sbc(_kam_dispatcher_list),
    "kamcmd.core_uptime": _sbc(_kam_core_uptime),
    "kamcmd.tm_stats": _sbc(_kam_tm_stats),
    "kamcmd.dlg_stats_active": _sbc(_kam_dlg_stats_active),
    "kamcmd.stats_fetch": _sbc(_kam_stats_fetch),
    "kamcmd.htable_dump": _sbc(_kam_htable_dump),
    # SBC — WRITE (reversible)
    "kamcmd.dispatcher.reload": _sbc(_kam_dispatcher_reload, mutating=True),
    "kamcmd.dispatcher.set_state": _sbc(_kam_dispatcher_set_state, mutating=True),
    "kamcmd.htable.block": _sbc(_kam_htable_block, mutating=True),
    "kamcmd.htable.unblock": _sbc(_kam_htable_unblock, mutating=True),
    # FS — READ
    "fs.sofia_status": _fsr(_fs_sofia_status),
    "fs.sofia_status_profile": _fsr(_fs_sofia_status_profile),
    "fs.show_channels": _fsr(_fs_show_channels),
    "fs.show_calls": _fsr(_fs_show_calls),
    "fs.uuid_dump": _fsr(_fs_uuid_dump),
    "fs.status": _fsr(_fs_status),
    # FS — WRITE (reversible)
    "fs.uuid_kill": _fsr(_fs_uuid_kill, mutating=True),
    "fs.reloadxml": _fsr(_fs_reloadxml, mutating=True),
    "fs.sofia_rescan": _fsr(_fs_sofia_rescan, mutating=True),
    "fs.loglevel": _fsr(_fs_loglevel, mutating=True),
    "call.canary": _fsr(_fs_canary, timeout=_CANARY_TIMEOUT, mutating=True),
    # host / all roles — READ
    "host.docker_ps": _host(_host_docker_ps),
    "host.git_head": _host(_git_head_run),
    "host.docker_logs": _host(_host_docker_logs),
    "host.journalctl": _host(_host_journalctl),
}


# --------------------------------------------------------------------------- #
# WRITE_COMMAND_IDS — the mutating set, derived from the catalog at import. Provided
# ALONGSIDE the per-spec `mutating` flag (both mechanisms) so the ted backend/audits
# can pick either: check `CATALOG[id]["mutating"]`, or membership in this frozenset.
# --------------------------------------------------------------------------- #

WRITE_COMMAND_IDS = frozenset(
    cid for cid, spec in CATALOG.items() if spec.get("mutating")
)


def is_mutating(command_id: str) -> bool:
    """True iff command_id is a WRITE (mutating) command."""
    spec = CATALOG.get(command_id)
    return bool(spec and spec.get("mutating"))


# --------------------------------------------------------------------------- #
# BUILD-TIME HARD EXCLUSION.
#
# A structural backstop over the WHOLE catalog: at import, scan every command's id
# AND the argv/ESL verb it would build for a representative param set, and assert
# that none names a destructive or irreversible operation. This makes a future bad
# entry (e.g. someone adding `fsctl shutdown` or an arbitrary-bgapi passthrough)
# fail the process at startup instead of shipping. It is defense-in-depth on top of
# the fixed-verb design — the catalog CANNOT quietly gain a dangerous verb.
# --------------------------------------------------------------------------- #

# Forbidden patterns, matched (case-insensitively) as REGEXES against each
# command_id AND against the argv/verb text each command produces. Regexes (not bare
# substrings) so tokens match on WORD BOUNDARIES and cannot false-positive against a
# legitimate verb — e.g. `\bstop\b` must NOT trip on "sofia status", and we do not
# use a bare "-c " (which collided with git's "-C"). shell=False is already a hard
# structural invariant, so this is defense-in-depth focused on dangerous VERBS, not
# on shell-metacharacter hunting. Ordered by area: FS lifecycle / mass ops /
# scripting / module control; Kamailio core+config reload; raw shell/pty; PG data.
_FORBIDDEN_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in (
    # FreeSWITCH destructive / irreversible
    r"\bshutdown\b",
    r"\bhupall\b",
    r"\bfsctl\s+crash\b",
    r"\bfsctl\s+reclaim_mem\b",
    # sofia profile lifecycle: stop/start/restart (NOT rescan/status). Word-bounded
    # so "status" is safe; matches "sofia profile <p> stop|start|restart".
    r"\bprofile\s+\w+\s+(?:stop|start|restart)\b",
    r"\bsofia\s+(?:stop|start|restart)\b",
    # module load/unload/reload
    r"\b(?:un)?load\s+mod_",
    r"\breload\s+mod_",
    # embedded scripting engines
    r"\blua(?:run|file)?\b",
    r"\bjsrun\b",
    r"\bjavascript\b",
    # Kamailio core / config / process control (NOT dispatcher.reload/htable.*)
    r"\bcore\.(?:kill|shm|ppdefines|arg)\b",
    r"\bcfg\.reload\b",
    r"\bapp\.reload\b",
    r"\bcorex\.",
    # raw shell / pty  (token-anchored; won't hit paths like /opt/revup)
    r"\bbash\b",
    r"\b/bin/sh\b",
    r"\bsystem\s",
    r"\bpty\b",
    r"\bexec\b",
    # PG data / volumes / destructive docker
    r"\bpostgres\b",
    r"\bpgdata\b",
    r"/var/lib/postgresql",
    r"\bpsql\b",
    r"\bdocker\s+volume\b",
    r"\bdocker\s+rm\b",
    r"\bdocker\s+kill\b",
    r"\brm\s+-rf\b",
))

# The ONE allowed bgapi is the canary originate. Any OTHER 'bgapi' in a built verb
# is forbidden. We check bgapi specially so the canary's fixed originate is exempt
# while an arbitrary-bgapi entry would trip the assertion.
_ALLOWED_BGAPI_COMMAND_IDS = frozenset({"call.canary"})

# Representative params to exercise each command's builder during the audit. For a
# read/enumerated command we pass a VALID value so the builder runs and we can scan
# the argv it produces; commands not listed are exercised with {}.
_AUDIT_PARAMS = {
    "kamcmd.stats_fetch": {"group": "core"},
    "kamcmd.htable_dump": {"table": "blocked"},
    "kamcmd.dispatcher.set_state": {
        "state": "ap", "group": 2, "address": "sip:67.231.2.12:5060",
    },
    "kamcmd.htable.block": {"key": "203.0.113.7"},
    "kamcmd.htable.unblock": {"key": "203.0.113.7"},
    "fs.sofia_status_profile": {"profile": "internal"},
    "fs.uuid_dump": {"uuid": "00000000-0000-4000-8000-000000000000"},
    "fs.uuid_kill": {"uuid": "00000000-0000-4000-8000-000000000000"},
    "fs.sofia_rescan": {"profile": "internal"},
    "fs.loglevel": {"level": 6},
    "host.docker_logs": {"container": "voip-kamailio"},
    "host.journalctl": {"unit": "docker", "lines": 10},
    # call.canary intentionally NOT auto-executed here (it would place a real call);
    # its verb shape is asserted separately below from a dry render.
}


def _render_argv_text(command_id: str) -> str:
    """
    Produce the argv/verb TEXT a command would run, WITHOUT executing anything, for
    the exclusion scan. We monkeypatch the two execution primitives to capture their
    argument instead of running it, invoke the command's builder with representative
    params, and return the captured text. Any builder error is surfaced (fail loud).

    For call.canary we do NOT invoke the builder (it would originate a real call);
    instead we render its known fixed verb shape directly from the module constants.
    """
    global _run_argv, _run_esl  # noqa: PLW0603 - deliberate, scoped, restored below

    if command_id == "call.canary":
        # Mirror the exact fixed pieces _fs_canary assembles (dest + &hangup). No
        # request input is involved; this is the verb the canary can ever emit.
        dest = f"sofia/external/{CANARY_DEST}@{CANARY_SBC_PROXY}:5060"
        return f"bgapi originate {{...}}{dest} &park ; uuid_exists ; uuid_kill"

    captured = {"text": ""}

    def _cap_argv(argv, _timeout):
        captured["text"] = " ".join(str(a) for a in argv)
        return True, 0, "", ""

    def _cap_esl(verb, _timeout):
        captured["text"] = str(verb)
        return True, 0, "", ""

    orig_argv, orig_esl = _run_argv, _run_esl
    _run_argv, _run_esl = _cap_argv, _cap_esl
    try:
        spec = CATALOG[command_id]
        params = _AUDIT_PARAMS.get(command_id, {})
        spec["run"](params, DEFAULT_TIMEOUT)
    finally:
        _run_argv, _run_esl = orig_argv, orig_esl
    return captured["text"]


def assert_no_forbidden_commands():
    """
    Fail LOUDLY (AssertionError) at import if any catalog command_id, or the
    argv/verb it renders, contains a forbidden (destructive/irreversible) token, or
    uses bgapi outside the single allowed canary. Called once at module import.
    """
    for command_id, spec in CATALOG.items():
        text = _render_argv_text(command_id)
        haystacks = (command_id, text)

        for hay in haystacks:
            for pat in _FORBIDDEN_PATTERNS:
                if pat.search(hay):
                    raise AssertionError(
                        f"catalog command {command_id!r} matches forbidden pattern "
                        f"{pat.pattern!r} (in {hay!r}) — refusing to start"
                    )
            if "bgapi" in hay.lower() and (
                command_id not in _ALLOWED_BGAPI_COMMAND_IDS
            ):
                raise AssertionError(
                    f"catalog command {command_id!r} uses bgapi but is not the "
                    f"allowed canary — refusing to start"
                )

    # Sanity: every WRITE id is a real catalog entry and vice-versa (flag <-> set).
    derived = frozenset(
        cid for cid, spec in CATALOG.items() if spec.get("mutating")
    )
    if derived != WRITE_COMMAND_IDS:
        raise AssertionError(
            "WRITE_COMMAND_IDS out of sync with the catalog mutating flags"
        )


# Run the audit at import — a bad catalog entry stops the agent from starting.
assert_no_forbidden_commands()


def commands_for_role(role: str):
    """Sorted list of command_ids valid for `role` (role None entries = all)."""
    ids = [
        cid for cid, spec in CATALOG.items()
        if spec["role"] is None or spec["role"] == role
    ]
    return sorted(ids)


def is_valid_for_role(command_id: str, role: str) -> bool:
    spec = CATALOG.get(command_id)
    if spec is None:
        return False
    return spec["role"] is None or spec["role"] == role


def run_command(command_id: str, params: dict, role: str):
    """
    Validate + execute an allow-listed command for the given role.

    Returns a dict: {ok, exit_code, stdout, stderr, duration_ms}.
    Raises ValueError for an unknown command_id, a role mismatch, or invalid
    params — the HTTP layer maps ValueError to 400. Any EXECUTION failure (missing
    binary, timeout, nonzero exit) is NOT an exception: it comes back in the dict
    with ok=False so the console sees a structured result, not a 500.
    """
    spec = CATALOG.get(command_id)
    if spec is None:
        raise ValueError(f"unknown command_id: {command_id!r}")
    if not (spec["role"] is None or spec["role"] == role):
        raise ValueError(
            f"command_id {command_id!r} is not permitted on role {role!r}"
        )
    if not isinstance(params, dict):
        raise ValueError("params must be an object")

    timeout = float(spec.get("timeout") or DEFAULT_TIMEOUT)
    started = time.monotonic()
    # The `run` callable validates params (may raise ValueError -> 400) then
    # executes. Execution errors are caught inside _run_argv/_run_esl and surface
    # as ok=False, never as an exception.
    ok, exit_code, stdout, stderr = spec["run"](params, timeout)
    duration_ms = int((time.monotonic() - started) * 1000)

    return {
        "ok": bool(ok),
        "exit_code": int(exit_code),
        "stdout": stdout or "",
        "stderr": stderr or "",
        "duration_ms": duration_ms,
    }
