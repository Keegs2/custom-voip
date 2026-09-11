"""Shared owner of the `cdrs` columns that post-05 migrations add.

WHY THIS EXISTS
---------------
Several test modules stand up a throwaway PostgreSQL with an INLINE
`CREATE TABLE cdrs (...)` copied from `docker/postgres/init/05_schema_cdr.sql`.
Every time a migration adds a `cdrs` column that the ingest INSERT binds or a
CDR endpoint SELECTs, each of those hand-maintained copies silently goes stale
and the module starts failing with `UndefinedColumnError` -> HTTP 500.
Hand-patching the inline DDL in each file just relocates the drift; the next
column breaks the same three files again.

So: scratch schemas apply the REAL migration files, exactly the way
`tests/test_carrier_trunks.py` already applies 25 / 40 / 42 / 44. The migration
becomes the single source of truth AND gets its idempotency exercised for free.

`CDR_COLUMN_MIGRATIONS` lists the init scripts that touch ONLY `cdrs`
(`ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS ...` plus, at most, an index and
role-guarded grants) and are therefore safe to replay onto ANY scratch `cdrs`
table, in this order.

    >>> WHEN YOU ADD A `cdrs` COLUMN: append the migration filename here.     <<<
    >>> No test module needs to change.                                       <<<

Deliberately NOT listed — they create other objects, so a module that needs
their `cdrs` columns must apply them explicitly (test_carrier_trunks.py does):
  * `40_carrier_trunks.sql` — adds `cdrs.inbound_carrier` /
    `cdrs.inbound_carrier_pop`, but also creates the `carrier_trunks` table,
    its seeds and the `carrier_trunk_health` view.

KNOWN DEBT (pre-existing, NOT addressed here). `tests/test_cdr_search_filters.py`
and the CDR-list/detail tests in `tests/test_support_role_authz.py` already fail
on `origin/RCF-V1` — verified root cause: their inline `cdrs` predates
migration 23's on-net columns AND migration 40's `inbound_carrier` /
`inbound_carrier_pop`, every one of which `GET /v1/cdrs` selects, so the query
raises UndefinedColumnError and the endpoint 500s. (Adding those six columns to
test_cdr_search_filters.py's inline DDL turns its 17 failures into 22 passes.)
Fixing them is deliberately OUT OF SCOPE here so this branch's test baseline
stays directly comparable to base. The complete follow-up fix is:

  1. apply this helper's migrations in both fixtures, AND
  2. add migration 40's `cdrs.inbound_carrier` / `inbound_carrier_pop`, AND
  3. give `test_cdr_search_filters.py` a `call_attestations` table — it has
     none, and `GET /v1/cdrs` now carries a scalar sub-select against it for
     the STIR intent badge.
"""
from pathlib import Path

INIT_DIR = Path(__file__).resolve().parents[1] / "docker" / "postgres" / "init"

#: Ordered, cdrs-only migrations every scratch schema should replay.
CDR_COLUMN_MIGRATIONS = (
    "23_onnet_cdr_columns.sql",   # origin/terminating customer, on_net, on_net_hops
    "47_cdr_stir_outcome.sql",    # stir_outcome, stir_eff_actual
)


def cdr_column_migration_sql(names=CDR_COLUMN_MIGRATIONS) -> list[str]:
    """The SQL text of each listed migration, in order."""
    out = []
    for name in names:
        path = INIT_DIR / name
        assert path.is_file(), f"missing migration file: {path}"
        out.append(path.read_text())
    return out


async def apply_cdr_column_migrations(conn, *, times: int = 2, names=CDR_COLUMN_MIGRATIONS):
    """Apply every cdrs-column migration on an asyncpg connection.

    `times=2` by default so each file's idempotency (ADD COLUMN IF NOT EXISTS,
    CREATE INDEX IF NOT EXISTS, role-guarded GRANTs) is proven on every run
    that uses this helper — the same convention test_carrier_trunks.py uses for
    25/40/42/44.
    """
    for sql in cdr_column_migration_sql(names):
        for _ in range(times):
            await conn.execute(sql)
