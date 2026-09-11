"""Deploy-order guard for the CDR ingest schema (migration 47).

WHY THIS EXISTS
---------------
`47_cdr_stir_outcome.sql` adds `cdrs.stir_outcome` / `cdrs.stir_eff_actual`
and the ingest INSERT in routers/cdrs.py names both. Init scripts only run
on the FIRST initdb, so on production the migration is applied by hand on the
East primary. If the API build ships BEFORE that happens, every CDR INSERT
raises UndefinedColumnError. The ingest contract (CLAUDE.md gotcha #11) is
that /v1/cdrs/ingest ALWAYS answers HTTP 200 — mod_json_cdr must never
retry — so those CDRs would survive only in the media VM's disk log, pending
a manual /ingest/bulk replay, and nothing would shout about it.

Two defences here, neither of them fatal to the API (every other endpoint
must keep serving, and the ingest contract is untouched):

  * `run_startup_check()` — called from the lifespan right after init_db().
    Probes information_schema.columns and logs at CRITICAL, with the exact
    remedy command, when a required column is missing. Never raises.
  * `check_cdr_schema()` — the same probe, exposed through
    GET /health/detailed as the `schema` component.

routers/cdrs.py additionally makes the ingest itself survive the window: on
UndefinedColumnError for one of these columns it retries the INSERT without
them (see `_execute_cdr_insert`). This module is what tells the operator
that this is happening.

    >>> WHEN THE INGEST INSERT GAINS A COLUMN: add it to REQUIRED_CDR_COLUMNS <<<
"""
import logging

from db import database as db

logger = logging.getLogger(__name__)

#: (column, migration file that adds it) — every column the ingest INSERT
#: binds that is NOT part of the base 05_schema_cdr.sql table. Order is the
#: report order.
REQUIRED_CDR_COLUMNS: tuple[tuple[str, str], ...] = (
    ("stir_outcome", "47_cdr_stir_outcome.sql"),
    ("stir_eff_actual", "47_cdr_stir_outcome.sql"),
)

#: Where the init scripts live on every VM (CLAUDE.md: repo path /opt/revup).
MIGRATION_DIR = "/opt/revup/docker/postgres/init"

#: The exact command an operator must run on the East primary (replicates to
#: every zone). Formatted per migration file.
REMEDY_TEMPLATE = "sudo -u postgres psql -d voip -f {dir}/{migration}"

_COLUMNS_SQL = """
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name   = 'cdrs'
       AND column_name  = ANY($1::text[])
"""


def remedies_for(missing: list[str]) -> list[str]:
    """One remedy command per DISTINCT migration file among the missing columns."""
    files: list[str] = []
    for col, mig in REQUIRED_CDR_COLUMNS:
        if col in missing and mig not in files:
            files.append(mig)
    return [REMEDY_TEMPLATE.format(dir=MIGRATION_DIR, migration=m) for m in files]


async def missing_cdr_columns() -> list[str]:
    """Names from REQUIRED_CDR_COLUMNS that `cdrs` does not have. Raises on DB error."""
    rows = await db.fetch_all(_COLUMNS_SQL, [c for c, _ in REQUIRED_CDR_COLUMNS])
    present = {r["column_name"] for r in rows}
    return [c for c, _ in REQUIRED_CDR_COLUMNS if c not in present]


async def check_cdr_schema() -> dict:
    """Probe the schema. Never raises.

    Returns {"status": "ok" | "missing" | "unknown",
             "missing": [column, ...], "remedy": [command, ...],
             "error": str | None}
    """
    try:
        missing = await missing_cdr_columns()
    except Exception as e:  # noqa: BLE001 — a guard must never take the API down
        return {"status": "unknown", "missing": [], "remedy": [],
                "error": f"{type(e).__name__}: {e}"}
    if missing:
        return {"status": "missing", "missing": missing,
                "remedy": remedies_for(missing), "error": None}
    return {"status": "ok", "missing": [], "remedy": [], "error": None}


def describe(result: dict) -> str:
    """One-line rendering for /health/detailed's `schema` component."""
    if result["status"] == "ok":
        return "healthy"
    if result["status"] == "missing":
        return ("degraded: cdrs is missing column(s) " + ", ".join(result["missing"])
                + " — CDR INSERTs fall back to the pre-47 statement; apply on the "
                  "East primary: " + " ; ".join(result["remedy"]))
    return f"unknown: {result.get('error') or 'schema probe failed'}"


async def run_startup_check() -> dict:
    """Lifespan hook: LOUD when the schema is behind the code, never fatal."""
    result = await check_cdr_schema()
    if result["status"] == "missing":
        logger.critical(
            "SCHEMA GUARD: cdrs is missing column(s) %s. The API build is AHEAD of "
            "the database — every CDR INSERT will hit UndefinedColumnError and fall "
            "back to the pre-47 statement (STIR outcome columns dropped) until the "
            "migration is applied. mod_json_cdr still gets HTTP 200 (contract), so "
            "NOTHING will retry. Apply on the East primary NOW (replicates to every "
            "zone): %s",
            ", ".join(result["missing"]), " ; ".join(result["remedy"]),
        )
    elif result["status"] == "unknown":
        logger.warning("SCHEMA GUARD: could not probe cdrs columns (%s); "
                       "GET /health/detailed re-checks on demand", result["error"])
    else:
        logger.info("SCHEMA GUARD: cdrs has every ingest column (%s)",
                    ", ".join(c for c, _ in REQUIRED_CDR_COLUMNS))
    return result
