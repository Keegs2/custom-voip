"""
Async PostgreSQL Database Layer with Connection Pooling
Uses asyncpg for maximum performance
"""
import asyncpg
import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Primary connection pool — writes, routing, CDRs (DATABASE_URL).
pool: Optional[asyncpg.Pool] = None

# Inventory read-only connection pool — DID inventory/ownership reads only
# (INVENTORY_READ_URL, a prod read-replica). When INVENTORY_READ_URL is unset
# this points at the SAME object as `pool`, so reads transparently hit the
# primary (today's behavior — a no-op until a replica is wired).
inventory_pool: Optional[asyncpg.Pool] = None

# True when inventory_pool is a distinct replica pool (vs. aliasing `pool`).
_inventory_is_separate: bool = False


def _parse_db_url(database_url: str):
    """Parse a postgresql:// URL into asyncpg connect kwargs.

    asyncpg.create_pool does not accept URL strings directly, so we split the
    URL the same way the primary pool always has. Returns a 5-tuple
    (user, password, host, port, database); falls back to the api defaults if
    the URL does not match.
    """
    import re
    match = re.match(
        r"postgresql://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)",
        database_url
    )
    if match:
        return match.groups()
    return "api", "api_secret", "postgres", "6432", "voip"


async def init_db():
    """Initialize the database connection pools (primary + inventory)."""
    global pool, inventory_pool, _inventory_is_separate

    database_url = os.getenv(
        "DATABASE_URL",
        "postgresql://api:api_secret@postgres:6432/voip"
    )

    user, password, host, port, database = _parse_db_url(database_url)

    pool = await asyncpg.create_pool(
        user=user,
        password=password,
        host=host,
        port=int(port),
        database=database,
        min_size=3,            # Minimum connections in pool
        max_size=25,           # Maximum connections (4 workers × 25 = 100 total for PgBouncer)
        max_inactive_connection_lifetime=300,  # 5 minutes
        command_timeout=30,    # Query timeout
        statement_cache_size=0,  # Required for PgBouncer transaction-mode pooling
    )

    logger.info(f"Database pool created: {host}:{port}/{database}")

    # --- Inventory read pool ---------------------------------------------
    # INVENTORY_READ_URL points at a read-only replica used ONLY by the DID
    # inventory/ownership read paths. If unset/empty, alias the primary pool so
    # inventory reads transparently hit DATABASE_URL (no-op fallback).
    inventory_url = os.getenv("INVENTORY_READ_URL", "").strip()
    if inventory_url:
        inv_user, inv_password, inv_host, inv_port, inv_database = _parse_db_url(inventory_url)
        inventory_pool = await asyncpg.create_pool(
            user=inv_user,
            password=inv_password,
            host=inv_host,
            port=int(inv_port),
            database=inv_database,
            min_size=1,            # Read-only — smaller pool than primary
            max_size=10,
            max_inactive_connection_lifetime=300,
            command_timeout=30,
            statement_cache_size=0,  # Required for PgBouncer transaction-mode pooling
        )
        _inventory_is_separate = True
        logger.info(
            f"Inventory read pool created (separate replica): {inv_host}:{inv_port}/{inv_database}"
        )
    else:
        inventory_pool = pool
        _inventory_is_separate = False
        logger.info(
            f"Inventory read pool falling back to primary (INVENTORY_READ_URL unset): {host}:{port}/{database}"
        )


async def close_db():
    """Close the database connection pools."""
    global pool, inventory_pool, _inventory_is_separate
    # Close the inventory pool first, but only if it's a distinct replica pool.
    # When it aliases the primary, closing it here would double-close `pool`.
    if inventory_pool is not None and _inventory_is_separate:
        await inventory_pool.close()
        logger.info("Inventory read pool closed")
    inventory_pool = None
    _inventory_is_separate = False
    if pool:
        await pool.close()
        pool = None
        logger.info("Database pool closed")


async def get_pool() -> asyncpg.Pool:
    """Get the database pool."""
    if not pool:
        await init_db()
    return pool


async def fetch_one(query: str, *args):
    """Execute query and fetch one row."""
    async with pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def fetch_all(query: str, *args):
    """Execute query and fetch all rows."""
    async with pool.acquire() as conn:
        return await conn.fetch(query, *args)


async def execute(query: str, *args):
    """Execute a query (INSERT, UPDATE, DELETE)."""
    async with pool.acquire() as conn:
        return await conn.execute(query, *args)


async def execute_many(query: str, args_list: list):
    """Execute a query multiple times (batch insert)."""
    async with pool.acquire() as conn:
        return await conn.executemany(query, args_list)


# ---------------------------------------------------------------------------
# Inventory read-only helpers
# ---------------------------------------------------------------------------
# These mirror fetch_one/fetch_all but acquire from the inventory_pool (the
# read replica when INVENTORY_READ_URL is set, otherwise the primary pool).
# READ-ONLY by contract — there is intentionally no inventory execute variant.

async def fetch_one_inventory(query: str, *args):
    """Execute a read-only query against the inventory pool, fetch one row."""
    async with inventory_pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def fetch_all_inventory(query: str, *args):
    """Execute a read-only query against the inventory pool, fetch all rows."""
    async with inventory_pool.acquire() as conn:
        return await conn.fetch(query, *args)
