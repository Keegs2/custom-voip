"""Shared harness for the CRAG Admin redesign API tests (TED contract C1-C6).

Extends tests/voicemail_api_harness.Harness (ephemeral PostgreSQL 16 from the
REAL init scripts 02/03/09/17/20/22/24/31/34/39 + 54/56, the api pool as the
runtime ``api`` role, the REAL JWT middleware, customers 101/102/103 and the
users the minted tokens name) with the rest of the real chain these routes
touch:

  cdrs (05's CREATE TABLE + every cdrs-column migration, tests/cdr_schema.py)
  25 carrier_trunk_status        40's view prerequisite
  26 live_trunk_stats            trunk delete removes its rows
  40/41/42/44 carrier_trunks     did_inventory.source / carrier_trunk_id,
                                 priorities, traffic_class
  59/60 Visual IVR               number_routing's current definition (ivr arm)
  + EXTRA_MIGRATIONS             a module's own migration(s), applied TWICE
                                 (idempotency)

Routers mounted at /v1/<x>: customers, trunks, numbers (number_inventory),
carrier-trunks. Each module passes its own PostgreSQL port.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from voicemail_api_harness import Harness, asyncpg  # noqa: E402,F401
from voicemail_db import INIT  # noqa: E402

BASE_MIGRATIONS = (
    "25_carrier_trunk_status.sql",
    "26_live_trunk_stats.sql",
    "40_carrier_trunks.sql",
    "41_did_carrier_source.sql",
    "42_carrier_priorities.sql",
    "44_sinch_termination.sql",
    "59_ivr.sql",
    "60_cdr_ivr.sql",
)


def cdrs_ddl() -> str:
    sql = (INIT / "05_schema_cdr.sql").read_text()
    start = sql.index("CREATE TABLE cdrs (")
    end = sql.index("\n);", start) + 3
    return sql[start:end] + "\nALTER TABLE cdrs ADD COLUMN IF NOT EXISTS sbc_id VARCHAR(30);"


class AdminHarness(Harness):
    #: A module's own migrations (file names in docker/postgres/init), applied
    #: twice after BASE_MIGRATIONS.
    EXTRA_MIGRATIONS: tuple[str, ...] = ()

    async def _setup(self) -> None:
        await super()._setup()
        from cdr_schema import apply_cdr_column_migrations
        conn = await self.owner()
        try:
            await conn.execute(cdrs_ddl())
            await apply_cdr_column_migrations(conn, times=1)
            await conn.execute(
                "GRANT ALL ON cdrs TO api; GRANT USAGE, SELECT ON cdrs_id_seq TO api;")
            for name in BASE_MIGRATIONS:
                await conn.execute((INIT / name).read_text())
            await self.before_extra(conn)
            for _ in range(2):
                for name in self.EXTRA_MIGRATIONS:
                    await conn.execute((INIT / name).read_text())
        finally:
            await conn.close()

    async def before_extra(self, conn) -> None:
        """Hook: seed rows that must exist BEFORE EXTRA_MIGRATIONS run."""

    @staticmethod
    def build_app():
        from fastapi import FastAPI
        from fastapi.responses import ORJSONResponse
        from middleware.auth import JWTAuthMiddleware
        from routers import carrier_trunks, customers, number_inventory, trunks
        app = FastAPI(default_response_class=ORJSONResponse)
        app.add_middleware(JWTAuthMiddleware)
        app.include_router(customers.router, prefix="/v1/customers")
        app.include_router(trunks.router, prefix="/v1/trunks")
        app.include_router(number_inventory.router, prefix="/v1/numbers")
        app.include_router(carrier_trunks.router, prefix="/v1/carrier-trunks")
        return app

    # -- request helpers -------------------------------------------------------
    def get(self, path: str, who: str = "admin", **params):
        return self.run(self.client.get(path, params=params, headers=self.auth(who)))

    def put(self, path: str, body: dict, who: str = "admin"):
        return self.run(self.client.put(path, json=body, headers=self.auth(who)))

    def post(self, path: str, body: dict, who: str = "admin"):
        return self.run(self.client.post(path, json=body, headers=self.auth(who)))

    def delete(self, path: str, who: str = "admin"):
        return self.run(self.client.delete(path, headers=self.auth(who)))

    def sql(self, statement: str, *args):
        return self.run(self.execute(statement, *args))

    def rows(self, statement: str, *args):
        return self.run(self.fetch(statement, *args))

    def val(self, statement: str, *args):
        return self.run(self.fetchval(statement, *args))
