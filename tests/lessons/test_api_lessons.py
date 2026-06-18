"""
API/DB/FreeSWITCH-integration "lessons regression guard" (Phase 0 safety net).

Every test here encodes a hard-won lesson from CLAUDE.md (the project root file
and the per-component CLAUDE.md files). Each test reads the ACTUAL production
source/compose file and FAILS if the documented fix is removed or regressed.
The lesson is quoted verbatim in the test docstring.

This is a tripwire suite: it asserts over real files (plain reads + regex), so it
runs with zero infra (no DB, no Redis, no FreeSWITCH, no FastAPI import). When a
later phase refactors and silently drops one of these protections, the relevant
test goes red and names the lesson.

Un-mechanizable lessons are kept as `pytest.skip` / `xfail` with a documented
reason so they remain visible in the report rather than silently absent.

Run:  python3 -m pytest tests/lessons/test_api_lessons.py -v
"""
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

# Production files under guard.
DATABASE_PY = REPO / "docker" / "api" / "src" / "db" / "database.py"
SECURITY_PY = REPO / "docker" / "api" / "src" / "auth" / "security.py"
ESL_PY = REPO / "docker" / "api" / "src" / "services" / "esl_client.py"
CDRS_PY = REPO / "docker" / "api" / "src" / "routers" / "cdrs.py"
HEALTH_PY = REPO / "docker" / "api" / "src" / "routers" / "health.py"
MIDDLEWARE_AUTH_PY = REPO / "docker" / "api" / "src" / "middleware" / "auth.py"
INBOUND_ROUTER_LUA = REPO / "docker" / "freeswitch" / "scripts" / "inbound_router.lua"
TRUNK_OUTBOUND_LUA = REPO / "docker" / "freeswitch" / "scripts" / "trunk_outbound.lua"
API_OUTBOUND_LUA = REPO / "docker" / "freeswitch" / "scripts" / "api_outbound.lua"
COMPOSE_SERVICES = REPO / "docker-compose.services.yml"
COMPOSE_MEDIA = REPO / "docker-compose.media.yml"


def _read(path: Path) -> str:
    assert path.is_file(), f"guarded file missing: {path}"
    return path.read_text()


def _strip_docs_and_comments(src: str) -> str:
    """Remove triple-quoted strings and # comments so substring assertions match
    CODE only, not prose in docstrings/comments."""
    src = re.sub(r'"""(?:.|\n)*?"""', "", src)
    src = re.sub(r"'''(?:.|\n)*?'''", "", src)
    src = re.sub(r"#.*", "", src)
    return src


def _func_source(src: str, func_name: str) -> str:
    """Extract a top-level `def`/`async def` function body from Python source by
    indentation (good enough for tripwire assertions; no AST import needed)."""
    lines = src.splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.match(rf"\s*(async\s+def|def)\s+{re.escape(func_name)}\s*\(", line):
            start = i
            break
    assert start is not None, f"function {func_name!r} not found"
    indent = len(lines[start]) - len(lines[start].lstrip())
    body = [lines[start]]
    for line in lines[start + 1:]:
        if line.strip() == "":
            body.append(line)
            continue
        cur = len(line) - len(line.lstrip())
        if cur <= indent:
            break
        body.append(line)
    return "\n".join(body)


# ---------------------------------------------------------------------------
# 1. PgBouncer + asyncpg: statement_cache_size=0
# ---------------------------------------------------------------------------
def test_asyncpg_statement_cache_disabled_for_pgbouncer():
    """CLAUDE.md: "PgBouncer + asyncpg: Must use `statement_cache_size=0` —
    PgBouncer transaction mode doesn't support prepared statements." The asyncpg
    pool in database.py MUST set statement_cache_size=0."""
    src = _read(DATABASE_PY)
    init = _func_source(src, "init_db")
    assert "create_pool" in init, "init_db no longer creates the asyncpg pool"
    assert re.search(r"statement_cache_size\s*=\s*0", init), (
        "statement_cache_size=0 missing from asyncpg.create_pool — PgBouncer "
        "transaction-mode pooling will break with prepared-statement errors"
    )


# ---------------------------------------------------------------------------
# 2. CDR ingest endpoint ALWAYS returns 200
# ---------------------------------------------------------------------------
def test_cdr_ingest_never_returns_non_200():
    """CLAUDE.md: "CDR ingest always returns 200: The `/v1/cdrs/ingest` endpoint
    must ALWAYS return 200 to prevent FreeSWITCH mod_json_cdr retry storms.
    Handle errors internally." The ingest handler and its processor must not
    raise and must not set a non-200 status_code."""
    src = _read(CDRS_PY)
    for fn in ("ingest_cdr", "_process_cdr_body"):
        body = _strip_docs_and_comments(_func_source(src, fn))
        # No bare/explicit raises that would escape to FastAPI (-> 500).
        assert not re.search(r"\braise\b", body), (
            f"{fn} contains a `raise` — CDR ingest must catch errors internally "
            f"and always return 200"
        )
        # No HTTPException construction (-> non-200).
        assert "HTTPException" not in body, (
            f"{fn} references HTTPException — must return a 200 dict instead"
        )
        # No explicit non-200 status_code set in these handlers.
        for m in re.finditer(r"status_code\s*=\s*(\d+)", body):
            assert m.group(1) == "200", f"{fn} sets status_code={m.group(1)} (must be 200)"
    # ingest_cdr wraps body parsing in try/except returning a dict.
    ingest = _func_source(src, "ingest_cdr")
    assert "try:" in ingest and "except" in ingest, "ingest_cdr lost its try/except guard"


# ---------------------------------------------------------------------------
# 3. asyncpg CDR INSERT uses explicit ::type casts
# ---------------------------------------------------------------------------
def test_cdr_insert_uses_explicit_type_casts():
    """CLAUDE.md: "asyncpg explicit type casts: All CDR INSERT parameters need
    explicit `::type` casts for asyncpg/PgBouncer compatibility." The big CDR
    INSERT binds $1..$49 — each must carry an explicit cast."""
    src = _read(CDRS_PY)
    # Spot-check the boundary params and the overall cast density.
    assert re.search(r"\$1::\w+", src), "missing explicit cast on $1"
    assert re.search(r"\$49::\w+", src), "missing explicit cast on $49 (49-param INSERT)"
    cast_params = set(re.findall(r"\$(\d+)::\w+", src))
    assert len(cast_params) >= 49, (
        f"expected >=49 explicitly-cast positional params in the CDR INSERT, "
        f"found {len(cast_params)}"
    )


def test_cdr_insert_has_duplicate_guard():
    """CLAUDE.md (api): "Duplicate detection via `WHERE NOT EXISTS`". The CDR
    INSERT must keep its NOT EXISTS dedup guard so retried/duplicate CDRs are
    skipped rather than double-inserted."""
    src = _read(CDRS_PY)
    assert "NOT EXISTS" in src, "CDR INSERT lost its WHERE NOT EXISTS duplicate guard"


# ---------------------------------------------------------------------------
# 4. ESL password handling
# ---------------------------------------------------------------------------
def test_media_healthcheck_passes_esl_password():
    """CLAUDE.md: "ESL password in health checks: `fs_cli` needs `-p
    $ESL_PASSWORD`. Without it, health check fails, Docker restarts FS..." The
    media compose healthcheck must invoke fs_cli with -p $ESL_PASSWORD."""
    src = _read(COMPOSE_MEDIA)
    assert re.search(r"fs_cli\s+-p\s+\$ESL_PASSWORD", src), (
        "media VM healthcheck no longer passes -p $ESL_PASSWORD to fs_cli"
    )


def test_api_esl_uses_freeswitch_esl_password_env():
    """docker/api CLAUDE.md: ESL client reads `FREESWITCH_ESL_PASSWORD`. The API
    ESL client must source the password from that env var (must match FS)."""
    src = _read(ESL_PY)
    assert 'os.getenv("FREESWITCH_ESL_PASSWORD"' in src, (
        "esl_client no longer reads FREESWITCH_ESL_PASSWORD from env"
    )


def test_esl_password_has_no_insecure_default():
    """Phase 4 (DONE): the insecure ESL default 'ClueCon' was removed.

    esl_client.py must read FREESWITCH_ESL_PASSWORD from env with NO fallback to
    the well-known public default — a missing secret fails loudly instead of
    silently authenticating with a password every FreeSWITCH ships with."""
    src = _read(ESL_PY)
    assert not re.search(r'getenv\(\s*"FREESWITCH_ESL_PASSWORD"\s*,\s*"ClueCon"', src), (
        "esl_client still defaults FREESWITCH_ESL_PASSWORD to 'ClueCon'"
    )
    # And no CODE path (ignoring docstrings/comments) may hardcode the default.
    code = _strip_docs_and_comments(src)
    assert '"ClueCon"' not in code and "'ClueCon'" not in code, (
        "esl_client still references the insecure 'ClueCon' default in code"
    )


# ---------------------------------------------------------------------------
# 5. JWT_SECRET_KEY required (API fails to start without it)
# ---------------------------------------------------------------------------
def test_jwt_secret_required_at_import():
    """CLAUDE.md: "JWT_SECRET_KEY — Required, API fails to start without it."
    security.py must raise at import time when JWT_SECRET_KEY is unset."""
    src = _read(SECURITY_PY)
    assert 'os.getenv("JWT_SECRET_KEY")' in src, "JWT secret no longer read from env"
    assert re.search(r"if\s+not\s+JWT_SECRET\s*:", src), "missing the 'if not JWT_SECRET' guard"
    assert re.search(r"raise\s+RuntimeError", src), (
        "security.py no longer raises RuntimeError when JWT_SECRET_KEY is missing — "
        "API would start with an undefined signing key"
    )


# ---------------------------------------------------------------------------
# 6. DATABASE_URL uses PgBouncer (6432) / host.docker.internal
# ---------------------------------------------------------------------------
def test_database_url_targets_pgbouncer_6432():
    """CLAUDE.md: "DATABASE_URL — API uses `host.docker.internal:6432` (PgBouncer
    on host, API in bridge network)." The services compose default must point at
    host.docker.internal:6432, NOT Postgres' native 5432."""
    src = _read(COMPOSE_SERVICES)
    m = re.search(r"DATABASE_URL=\$\{DATABASE_URL:-(postgresql://[^\}]+)\}", src)
    assert m, "DATABASE_URL default not found in docker-compose.services.yml"
    default_url = m.group(1)
    assert "host.docker.internal:6432" in default_url, (
        f"DATABASE_URL default must use host.docker.internal:6432 (PgBouncer); got {default_url}"
    )
    assert ":5432" not in default_url, "DATABASE_URL points at native Postgres 5432, not PgBouncer 6432"


def test_services_compose_mounts_host_gateway():
    """docker/api CLAUDE.md: API reaches bare-metal PgBouncer via
    `host.docker.internal:host-gateway` extra_hosts. That mapping must stay."""
    src = _read(COMPOSE_SERVICES)
    assert "host.docker.internal:host-gateway" in src, (
        "services compose lost the host.docker.internal:host-gateway extra_hosts mapping"
    )


# ---------------------------------------------------------------------------
# 7. Redis code removed from inbound_router.lua (fail-open elsewhere)
# ---------------------------------------------------------------------------
_REDIS_ROUTE_CACHE_CALLS = [
    "get_rcf_cache", "set_rcf_cache",   # route cache
    "check_prefix",                      # fraud prefix check
    "velocity_check",                    # CPM/daily velocity
]


def test_inbound_router_has_no_redis_route_logic():
    """CLAUDE.md: "Redis code removed from inbound_router.lua (RCF-V1)... The
    Redis route cache, fraud prefix check, and velocity limiting were deleted."
    inbound_router.lua must not load a redis client or call any of those Redis
    route-cache/fraud/velocity functions."""
    src = _read(INBOUND_ROUTER_LUA)
    assert 'load_module("redis_client")' not in src, (
        "inbound_router.lua re-loaded redis_client — Redis was deleted in RCF-V1"
    )
    assert not re.search(r'require\(\s*[\'"]redis[\'"]\s*\)', src), (
        "inbound_router.lua re-introduced require('redis')"
    )
    for call in _REDIS_ROUTE_CACHE_CALLS:
        assert call not in src, (
            f"inbound_router.lua calls Redis function `{call}` — route cache / "
            f"fraud / velocity were removed in RCF-V1 (redis-lua threading bug)"
        )
    # Positive marker that the disable is intentional and documented.
    assert "redis=DISABLED" in src, "inbound_router.lua lost its 'redis=DISABLED' marker"


def test_trunk_and_api_outbound_still_load_redis_fail_open():
    """CLAUDE.md: "trunk_outbound/api_outbound still load redis_client fail-open."
    Confirms the contrast: the OTHER outbound scripts deliberately keep Redis.
    (If this changes, the Redis-removal lesson's scope needs revisiting.)"""
    for path in (TRUNK_OUTBOUND_LUA, API_OUTBOUND_LUA):
        src = _read(path)
        assert 'load_module("redis_client")' in src, (
            f"{path.name} no longer loads redis_client — the RCF-V1 lesson said "
            f"trunk/api outbound retain fail-open Redis"
        )


# ---------------------------------------------------------------------------
# 8. Health endpoint must not block on Redis reconnects; always 200
# ---------------------------------------------------------------------------
def test_health_check_does_not_trigger_redis_reconnect():
    """CLAUDE.md / commit 4fd78da: "health probes must never trigger blocking
    Redis reconnects." _check_redis must inspect the existing client only and
    must NOT call get_client() (which would reconnect on every probe)."""
    src = _read(HEALTH_PY)
    check = _strip_docs_and_comments(_func_source(src, "_check_redis"))
    assert "get_client(" not in check, (
        "_check_redis calls get_client() — a down Redis would force a blocking "
        "reconnect on every health probe"
    )
    assert "cache.client" in check, "_check_redis no longer inspects the existing module-level client"


def test_health_endpoint_always_returns_200():
    """CLAUDE.md / health.py: "Always returns HTTP 200 — Redis being down is
    'degraded', not fatal... Docker must not restart-loop the API." The health
    handler must not raise or set a non-200 status."""
    src = _read(HEALTH_PY)
    handler = _strip_docs_and_comments(_func_source(src, "health_check"))
    assert not re.search(r"\braise\b", handler), "health_check raises — must always return 200"
    assert "HTTPException" not in handler, "health_check uses HTTPException — must return a 200 dict"


def test_api_healthcheck_uses_python_not_curl():
    """commit ed6b832: "API healthcheck probe: image has no curl — probe with the
    image's own Python." The services compose API healthcheck must use python,
    not curl (curl is absent from the slim image -> permanent unhealthy)."""
    src = _read(COMPOSE_SERVICES)
    # Find the api service healthcheck test line.
    assert re.search(r'test:\s*\["CMD",\s*"python"', src), (
        "API healthcheck no longer probes with python — a curl-based probe fails "
        "on the curl-less slim image"
    )


# ---------------------------------------------------------------------------
# 9. JWT middleware exempts the CDR ingest endpoints (FreeSWITCH has no token)
# ---------------------------------------------------------------------------
def test_jwt_middleware_exempts_cdr_ingest():
    """docker/api CLAUDE.md: "Paths ending with `/cdrs/ingest` or
    `/cdrs/ingest/bulk`" are auth-exempt; FreeSWITCH calls them with no JWT.
    Losing this exemption would 401 every CDR POST."""
    src = _read(MIDDLEWARE_AUTH_PY)
    assert 'endswith("/cdrs/ingest")' in src and 'endswith("/cdrs/ingest/bulk")' in src, (
        "JWT middleware no longer exempts /cdrs/ingest — FreeSWITCH CDR POSTs would 401"
    )


def test_jwt_middleware_exempts_freeswitch_paths():
    """docker/api CLAUDE.md: "/freeswitch/* paths (FreeSWITCH internal
    endpoints)" are auth-exempt (xml_curl gateway). Must remain exempt."""
    src = _read(MIDDLEWARE_AUTH_PY)
    assert 'startswith("/freeswitch/")' in src, (
        "JWT middleware no longer exempts /freeswitch/* — mod_xml_curl would get 401s"
    )


# ---------------------------------------------------------------------------
# Un-mechanizable lessons -- kept visible as documented skips
# ---------------------------------------------------------------------------
@pytest.mark.skip(reason=(
    "Un-mechanizable by static read: 'Host networking orphans — run "
    "`sudo killall -9 freeswitch` before restart.' This is an operational "
    "runbook step, not encoded in repo source. Tracked here so it stays visible."
))
def test_freeswitch_orphan_port_cleanup():
    pass


@pytest.mark.skip(reason=(
    "Un-mechanizable by static read: 'xml_curl fallback — modules without local "
    "config (mod_local_stream) CRIT abort.' Verifying requires booting FreeSWITCH "
    "with the API unreachable and observing no CRIT. Belongs in an integration "
    "harness, not a file-read tripwire."
))
def test_xml_curl_fallback_no_crit_abort():
    pass


@pytest.mark.skip(reason=(
    "Un-mechanizable by static read: 'SoftphoneWidget hooks — ALL React hooks "
    "must be above early return nulls (React #310).' This is a frontend (docker/ui) "
    "lint-level invariant, out of scope for the API/DB/FS lessons guard; belongs "
    "to the frontend test suite / eslint rules-of-hooks."
))
def test_softphone_hooks_above_early_return():
    pass
