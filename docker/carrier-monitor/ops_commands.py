#!/usr/bin/env python3
"""
ops_commands.py — the ALLOW-LISTED, READ-ONLY command catalog for revup-ops-agent.

This module is the security boundary of the ops-agent. Everything the console can
execute on a production VM is defined HERE, as a fixed table. There is no dynamic
command construction, no shell, and no free-form passthrough.

HARD RULES (enforced structurally, not by convention)
-----------------------------------------------------
1. Every command maps to a FIXED argv (a Python list) or a FIXED ESL verb. Params
   are validated (enum / int-range / strict regex) BEFORE the argv is built. A
   validated param is substituted as its own argv ELEMENT — never concatenated
   into a string and never passed to a shell.
2. Execution is `subprocess.run(argv, shell=False, ...)`. `shell=True` appears
   NOWHERE. No value from a request ever reaches a shell.
3. Every command is READ-ONLY. Nothing in v1 mutates SBC/FS/host state. (kamcmd
   verbs are all `*.list`/`*.stats`/`*.get`/`core.uptime`; ESL verbs are all
   `status`/`show`/`uuid_dump`; host verbs are `docker ps`/`docker logs`/`git
   rev-parse`/`journalctl`.)
4. Output is capped (STDOUT_CAP bytes) and every command has a per-command timeout
   so a hung/huge command can neither wedge the agent nor blow memory.
5. Commands are ROLE-GATED. `/healthz` advertises only the ids valid for the
   agent's detected role; `/run` re-checks the role and rejects (400) an id that
   isn't valid for this host. A `services` host exposes only the host.* commands.

Adding a command later: add one entry to CATALOG with its role, a param schema,
and an argv/esl builder. No other code changes — the dispatcher, validation, and
HTTP layer are generic over the table.
"""

import os
import re
import shutil
import subprocess
import time

from ops_esl import esl_api


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
    """Value must be an int (or int-like str) within [lo, hi]."""
    try:
        # Reject bools (bool is an int subclass) and floats-with-fraction.
        if isinstance(value, bool):
            raise ValueError
        ival = int(value)
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

def _sbc(fn, timeout=DEFAULT_TIMEOUT):
    return {"role": ROLE_SBC, "run": fn, "timeout": timeout}


def _fsr(fn, timeout=DEFAULT_TIMEOUT):
    return {"role": ROLE_FS, "run": fn, "timeout": timeout}


def _host(fn, timeout=DEFAULT_TIMEOUT):
    return {"role": None, "run": fn, "timeout": timeout}  # role None = all roles


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


CATALOG = {
    # SBC
    "kamcmd.dispatcher_list": _sbc(_kam_dispatcher_list),
    "kamcmd.core_uptime": _sbc(_kam_core_uptime),
    "kamcmd.tm_stats": _sbc(_kam_tm_stats),
    "kamcmd.dlg_stats_active": _sbc(_kam_dlg_stats_active),
    "kamcmd.stats_fetch": _sbc(_kam_stats_fetch),
    "kamcmd.htable_dump": _sbc(_kam_htable_dump),
    # FS
    "fs.sofia_status": _fsr(_fs_sofia_status),
    "fs.sofia_status_profile": _fsr(_fs_sofia_status_profile),
    "fs.show_channels": _fsr(_fs_show_channels),
    "fs.show_calls": _fsr(_fs_show_calls),
    "fs.uuid_dump": _fsr(_fs_uuid_dump),
    "fs.status": _fsr(_fs_status),
    # host / all roles
    "host.docker_ps": _host(_host_docker_ps),
    "host.git_head": _host(_git_head_run),
    "host.docker_logs": _host(_host_docker_logs),
    "host.journalctl": _host(_host_journalctl),
}


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
