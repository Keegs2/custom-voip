"""Thin FTP client wrapper for the CDR export forwarder.

Wraps stdlib ftplib.FTP (plain FTP, default) / ftplib.FTP_TLS (explicit FTPS,
opt-in). Plain FTP on port 21 is the default because the FileMage gateway is
internal and behind the firewall.

SECURITY: the FTP password is NEVER logged. All connection logging goes through
the redacted config; only host/port/user/dir are ever emitted.

This module is blocking (ftplib is synchronous). The exporter calls it via
asyncio.to_thread so it does not block the event loop.
"""
from __future__ import annotations

import io
import time
import ftplib
import logging
from typing import Optional

from .config import ExportConfig

logger = logging.getLogger(__name__)

# Transient FTP/socket errors worth retrying (temporary negative completion,
# dropped connections). Permanent errors (ftplib.error_perm — bad login, no
# such dir, permission denied) are NOT retried.
_TRANSIENT_ERRORS = (ftplib.error_temp, ftplib.error_reply, OSError, EOFError)


class FTPClient:
    """Small synchronous FTP/FTPS client scoped to one export destination."""

    def __init__(self, cfg: ExportConfig, max_attempts: int = 3, backoff_seconds: float = 2.0):
        self.cfg = cfg
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds

    # -- connection -------------------------------------------------------
    def _connect(self) -> ftplib.FTP:
        """Open, log in, set passive mode, and cwd to the configured directory.

        Returns a live ftplib.FTP (or FTP_TLS) handle. Caller is responsible for
        quit()/close(). Never logs the password.
        """
        if self.cfg.ftp_tls:
            ftp: ftplib.FTP = ftplib.FTP_TLS(timeout=self.cfg.ftp_timeout)
        else:
            ftp = ftplib.FTP(timeout=self.cfg.ftp_timeout)

        # connect() then login() (explicit, so FTPS AUTH TLS happens on connect).
        ftp.connect(host=self.cfg.ftp_host, port=self.cfg.ftp_port)
        ftp.login(user=self.cfg.ftp_user, passwd=self.cfg.ftp_password)

        # For explicit FTPS, secure the data channel too.
        if isinstance(ftp, ftplib.FTP_TLS):
            ftp.prot_p()

        ftp.set_pasv(self.cfg.ftp_passive)

        if self.cfg.ftp_dir and self.cfg.ftp_dir not in ("", "/", "."):
            ftp.cwd(self.cfg.ftp_dir)

        logger.info(
            "cdr_export: FTP connected host=%s port=%s user=%s dir=%s tls=%s passive=%s",
            self.cfg.ftp_host, self.cfg.ftp_port, self.cfg.ftp_user,
            self.cfg.ftp_dir, self.cfg.ftp_tls, self.cfg.ftp_passive,
        )
        return ftp

    @staticmethod
    def _quiet_quit(ftp: Optional[ftplib.FTP]) -> None:
        """Best-effort QUIT then close; swallow errors during teardown."""
        if ftp is None:
            return
        try:
            ftp.quit()
        except Exception:
            try:
                ftp.close()
            except Exception:
                pass

    # -- operations -------------------------------------------------------
    def test_connection(self) -> list[str]:
        """Connect, log in, cwd, and list the directory. For the CLI only.

        Returns the directory listing (nlst). Raises on failure so the CLI can
        surface the error. Does NOT upload or touch the DB.
        """
        ftp = None
        try:
            ftp = self._connect()
            try:
                listing = ftp.nlst()
            except ftplib.error_perm as e:
                # 550 on an empty dir is common; treat as empty listing.
                if str(e).startswith("550"):
                    listing = []
                else:
                    raise
            logger.info("cdr_export: FTP test-connection OK — %d entries in dir", len(listing))
            return listing
        finally:
            self._quiet_quit(ftp)

    def upload_bytes(self, filename: str, data: bytes) -> None:
        """STOR ``data`` to ``filename`` in the configured dir (in-memory source).

        Retries up to max_attempts on transient errors with a short backoff.
        Permanent errors (bad login / permission) raise immediately. Raises the
        last error if all attempts fail. Never logs the password.
        """
        last_exc: Optional[BaseException] = None
        for attempt in range(1, self.max_attempts + 1):
            ftp = None
            try:
                ftp = self._connect()
                # Fresh BytesIO per attempt — STOR consumes the stream.
                bio = io.BytesIO(data)
                ftp.storbinary(f"STOR {filename}", bio)
                logger.info(
                    "cdr_export: uploaded %s (%d bytes) to %s:%s%s (attempt %d/%d)",
                    filename, len(data), self.cfg.ftp_host, self.cfg.ftp_port,
                    self.cfg.ftp_dir, attempt, self.max_attempts,
                )
                return
            except ftplib.error_perm as e:
                # Permanent — do not retry (bad credentials, no permission, etc.)
                logger.error(
                    "cdr_export: FTP permanent error uploading %s to %s:%s — %s",
                    filename, self.cfg.ftp_host, self.cfg.ftp_port, e,
                )
                raise
            except _TRANSIENT_ERRORS as e:
                last_exc = e
                logger.warning(
                    "cdr_export: FTP transient error uploading %s to %s:%s "
                    "(attempt %d/%d) — %s",
                    filename, self.cfg.ftp_host, self.cfg.ftp_port,
                    attempt, self.max_attempts, e,
                )
                if attempt < self.max_attempts:
                    time.sleep(self.backoff_seconds * attempt)
            finally:
                self._quiet_quit(ftp)

        # All attempts exhausted.
        logger.error(
            "cdr_export: FTP upload of %s failed after %d attempts",
            filename, self.max_attempts,
        )
        assert last_exc is not None  # loop guarantees this on failure
        raise last_exc
