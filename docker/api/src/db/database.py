"""
Async PostgreSQL Database Layer with Connection Pooling
Uses asyncpg for maximum performance
"""
import asyncpg
import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Connection pool
pool: Optional[asyncpg.Pool] = None


async def init_db():
    """Initialize the database connection pool."""
    global pool

    database_url = os.getenv(
        "DATABASE_URL",
        "postgresql://api:api_secret@postgres:6432/voip"
    )

    # Parse URL for asyncpg (it doesn't accept URLs directly)
    # Format: postgresql://user:pass@host:port/db
    import re
    match = re.match(
        r"postgresql://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)",
        database_url
    )
    if match:
        user, password, host, port, database = match.groups()
    else:
        user, password, host, port, database = "api", "api_secret", "postgres", "6432", "voip"

    pool = await asyncpg.create_pool(
        user=user,
        password=password,
        host=host,
        port=int(port),
        database=database,
        min_size=10,           # Minimum connections in pool
        max_size=100,          # Maximum connections
        max_inactive_connection_lifetime=300,  # 5 minutes
        command_timeout=30,    # Query timeout
    )

    logger.info(f"Database pool created: {host}:{port}/{database}")


async def close_db():
    """Close the database connection pool."""
    global pool
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
