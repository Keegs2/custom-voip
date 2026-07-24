"""CDR Export Forwarder.

Standalone module/process that reads unexported CDRs from PostgreSQL and uploads
them as Equinox-format files to a FileMage gateway over plain FTP (port 21,
internal, behind firewall), watermarking each CDR so nothing is double-sent.

This package is INTENTIONALLY decoupled from the FastAPI app: it is never wired
into the app lifespan or routers, so it can never destabilize the API or its
health contract. It runs as its own process (see __main__.py) and initializes
its own asyncpg pool via the shared db.database module.

Importing this package has ZERO side effects — no DB or FTP connection is opened
at import time.
"""
