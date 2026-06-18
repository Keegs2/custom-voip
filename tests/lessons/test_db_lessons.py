"""Postgres init "hard-won lessons" regression guard.

These encode init-time failures found by LIVE `docker compose` verification
during the UCaaS unification (Phase 1). Each would abort `initdb` and leave a
half-built database. Static review missed them; only a real fresh init caught
them — so we pin them here.

Run:
    python3 -m pytest tests/lessons/test_db_lessons.py -v
"""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parents[2]
INIT_DIR = REPO / "docker" / "postgres" / "init"


def _create_index_statements(sql):
    """Yield each 'CREATE INDEX ... ;' statement (whitespace-normalized)."""
    for m in re.finditer(r"CREATE\s+(?:UNIQUE\s+)?INDEX.*?;", sql, re.I | re.S):
        yield m.group(0)


def test_no_volatile_function_in_index_predicate():
    """Postgres rejects STABLE/VOLATILE funcs (NOW(), CURRENT_*) in an index
    predicate: 'functions in index predicate must be marked IMMUTABLE', which
    ABORTS initdb. Found live in 13_schema_conferencing.sql
    (`CREATE INDEX ... WHERE start_time > NOW()`). A plain index serves the same
    range queries. Guard every init script."""
    offenders = []
    for f in sorted(INIT_DIR.glob("*.sql")):
        for stmt in _create_index_statements(f.read_text()):
            # NB: no trailing \b — NOW() ends in ')', a non-word char, so a
            # trailing word-boundary would never match and the guard would be vacuous.
            if re.search(r"\bWHERE\b", stmt, re.I) and re.search(
                r"\b(NOW\s*\(\)|CURRENT_DATE|CURRENT_TIMESTAMP|CURRENT_TIME)", stmt, re.I
            ):
                offenders.append(f"{f.name}: {' '.join(stmt.split())[:90]}")
    assert not offenders, (
        "volatile function in a partial-index predicate aborts initdb:\n  "
        + "\n  ".join(offenders)
    )


def test_destructive_demo_reset_not_in_autorun_init():
    """`21_account_cleanup.sql` is a DESTRUCTIVE dev/demo reset (replaces test
    customers 1-5, rewrites their RCF numbers). It assumes the legacy demo seed
    that the hardened RCF-V1 base does NOT have, so it errors mid-init and aborts.
    It must live OUTSIDE docker/postgres/init/ (which auto-runs on initdb) — it
    belongs in docker/postgres/dev-seed/ for manual, opt-in use only."""
    assert not (INIT_DIR / "21_account_cleanup.sql").exists(), (
        "account_cleanup demo-reset must NOT be in the auto-run init/ dir"
    )
    assert (REPO / "docker" / "postgres" / "dev-seed" / "21_account_cleanup.sql").exists(), (
        "account_cleanup should be preserved under docker/postgres/dev-seed/ (manual only)"
    )
