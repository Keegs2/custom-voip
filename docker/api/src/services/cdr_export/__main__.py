"""CLI entry point for the CDR export forwarder.

Run INSIDE the API container (WORKDIR /app, so src/ is the import root):

    python -m services.cdr_export test-connection   # FTP connect+login+list only
    python -m services.cdr_export dry-run            # preview file, no upload/mark
    python -m services.cdr_export run-once           # one real send (needs flag)
    python -m services.cdr_export run-loop           # scheduled loop (needs flag)

`test-connection` and `dry-run` are SAFE to run unconfigured/with the feature
flag off (dry-run is read-only; test-connection touches only the FTP server).
`run-once` and `run-loop` respect CDR_EXPORT_ENABLED and no-op when it is false.
"""
from __future__ import annotations

import sys
import asyncio
import logging
import argparse

from .config import ExportConfig


def _setup_logging() -> None:
    """Match the app's logging format (main.py) for consistent container logs."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )


logger = logging.getLogger("services.cdr_export")


# ---------------------------------------------------------------------------
# Subcommand implementations
# ---------------------------------------------------------------------------

def _cmd_test_connection(cfg: ExportConfig) -> int:
    """FTP connect + login + list the drop dir. No DB, no upload. Synchronous."""
    from .ftp_client import FTPClient

    logger.info("cdr_export: test-connection — config=%s", cfg.redacted())
    client = FTPClient(cfg)
    try:
        listing = client.test_connection()
    except Exception as e:
        logger.error("cdr_export: test-connection FAILED — %s", e)
        print(f"FTP CONNECTION FAILED: {e}", file=sys.stderr)
        return 1

    print("FTP CONNECTION OK")
    print(f"  host={cfg.ftp_host} port={cfg.ftp_port} user={cfg.ftp_user} "
          f"dir={cfg.ftp_dir} tls={cfg.ftp_tls} passive={cfg.ftp_passive}")
    print(f"  directory listing ({len(listing)} entries):")
    for entry in listing[:100]:
        print(f"    {entry}")
    if len(listing) > 100:
        print(f"    ... and {len(listing) - 100} more")
    return 0


async def _cmd_dry_run(cfg: ExportConfig) -> int:
    """Select a batch, build the file, print filename + first lines. No upload."""
    from .exporter import dry_run

    logger.info("cdr_export: dry-run (read-only; no upload, no marking)")
    filename, preview, row_count = await dry_run(cfg, preview_lines=20)
    if row_count == 0:
        print("DRY-RUN: no unexported CDRs settled past the lag window — nothing to export.")
        return 0

    print(f"DRY-RUN: would build {filename}  ({row_count} rows)")
    print("  --- first %d lines --------------------------------------------" % len(preview))
    for line in preview:
        print(f"  {line}")
    print("  ---------------------------------------------------------------")
    print("  (NOTHING uploaded, NO rows marked exported.)")
    return 0


async def _cmd_run_once(cfg: ExportConfig) -> int:
    """One real send cycle (respects CDR_EXPORT_ENABLED)."""
    from .exporter import run_once

    result = await run_once(cfg)
    print(f"RUN-ONCE: status={result.status} rows={result.row_count} "
          f"file={result.filename or '-'}")
    if result.status == "failed":
        print(f"  error: {result.error}", file=sys.stderr)
        return 1
    return 0


async def _cmd_run_loop(cfg: ExportConfig) -> int:
    """Scheduled loop (respects CDR_EXPORT_ENABLED). Blocks until interrupted."""
    from .exporter import run_loop

    try:
        await run_loop(cfg)
    except KeyboardInterrupt:
        logger.info("cdr_export: run-loop interrupted — exiting")
    return 0


# ---------------------------------------------------------------------------
# Argument parsing / dispatch
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m services.cdr_export",
        description="CDR export forwarder — ships unexported CDRs to the FileMage FTP gateway.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("test-connection", help="FTP connect+login+list the drop dir (safe; no DB, no send).")
    sub.add_parser("dry-run", help="Preview the next export file — no upload, no marking (safe, read-only).")
    sub.add_parser("run-once", help="Perform one real export cycle (respects CDR_EXPORT_ENABLED).")
    sub.add_parser("run-loop", help="Run the scheduled export loop (respects CDR_EXPORT_ENABLED).")
    return parser


def main(argv: list[str] | None = None) -> int:
    _setup_logging()
    parser = _build_parser()
    args = parser.parse_args(argv)
    cfg = ExportConfig.from_env()

    if args.command == "test-connection":
        return _cmd_test_connection(cfg)
    if args.command == "dry-run":
        return asyncio.run(_cmd_dry_run(cfg))
    if args.command == "run-once":
        return asyncio.run(_cmd_run_once(cfg))
    if args.command == "run-loop":
        return asyncio.run(_cmd_run_loop(cfg))

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
