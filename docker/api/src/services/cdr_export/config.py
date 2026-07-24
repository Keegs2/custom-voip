"""Environment-driven configuration for the CDR export forwarder.

All settings come from CDR_EXPORT_* environment variables with sane defaults.
Building a config reads os.environ but opens NO connections — import and
construction are side-effect-free.
"""
import os
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    """Parse a boolean env var. Accepts 1/true/yes/on (case-insensitive)."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    """Parse an int env var, falling back to default on missing/garbage."""
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except (ValueError, TypeError):
        logger.warning(
            "cdr_export: %s=%r is not an int; using default %d", name, raw, default
        )
        return default


@dataclass
class ExportConfig:
    """Resolved configuration for one export run.

    Construct via ExportConfig.from_env(). Fields mirror the CDR_EXPORT_* env
    vars documented in the package README and .env.services.example.
    """

    # ---- Feature flag -----------------------------------------------------
    # When False, run-once / run-loop no-op (with a log line). test-connection
    # and dry-run remain usable so the format/connection can be validated before
    # the flag is flipped on.
    enabled: bool = False

    # ---- FTP / FileMage gateway ------------------------------------------
    ftp_host: str = "10.142.0.71"
    ftp_port: int = 21
    ftp_user: str = ""
    ftp_password: str = ""
    ftp_dir: str = "/"
    ftp_passive: bool = True
    # Plain FTP by default (internal, behind firewall). When True, use explicit
    # FTPS (ftplib.FTP_TLS with prot_p()).
    ftp_tls: bool = False
    ftp_timeout: int = 30

    # ---- Batch / watermark behavior --------------------------------------
    batch_size: int = 5000
    # Only export rows whose end_time < now() - lag_seconds, so in-flight ingests
    # (mod_json_cdr POSTs still landing) have settled before a row is shipped.
    lag_seconds: int = 120
    skip_empty: bool = True
    interval_seconds: int = 3600  # run-loop cadence
    # Single-instance lease TTL. A runner claims cdr_export_lock for this long;
    # a crashed runner auto-recovers once the lease expires. Kept safely longer
    # than a worst-case cycle (select + build + FTP upload + mark).
    lock_ttl_seconds: int = 900  # 15 min

    # ---- Filename generation ---------------------------------------------
    filename_prefix: str = "CDR_"
    filename_ext: str = ".csv"
    filename_ts_format: str = "%Y%m%d%H%M%S"

    # ---- Formatter delimiter/quoting (kept here so the CLI/exporter can pass
    #      them into the isolated formatter without importing csv config twice)
    delimiter: str = ","
    quote_all: bool = False

    @classmethod
    def from_env(cls) -> "ExportConfig":
        """Build an ExportConfig from CDR_EXPORT_* environment variables."""
        return cls(
            enabled=_env_bool("CDR_EXPORT_ENABLED", False),
            ftp_host=os.getenv("CDR_EXPORT_FTP_HOST", "10.142.0.71"),
            ftp_port=_env_int("CDR_EXPORT_FTP_PORT", 21),
            ftp_user=os.getenv("CDR_EXPORT_FTP_USER", ""),
            ftp_password=os.getenv("CDR_EXPORT_FTP_PASSWORD", ""),
            ftp_dir=os.getenv("CDR_EXPORT_FTP_DIR", "/"),
            ftp_passive=_env_bool("CDR_EXPORT_FTP_PASSIVE", True),
            ftp_tls=_env_bool("CDR_EXPORT_FTP_TLS", False),
            ftp_timeout=_env_int("CDR_EXPORT_FTP_TIMEOUT", 30),
            batch_size=_env_int("CDR_EXPORT_BATCH_SIZE", 5000),
            lag_seconds=_env_int("CDR_EXPORT_LAG_SECONDS", 120),
            skip_empty=_env_bool("CDR_EXPORT_SKIP_EMPTY", True),
            interval_seconds=_env_int("CDR_EXPORT_INTERVAL_SECONDS", 3600),
            lock_ttl_seconds=_env_int("CDR_EXPORT_LOCK_TTL_SECONDS", 900),
            filename_prefix=os.getenv("CDR_EXPORT_FILENAME_PREFIX", "CDR_"),
            filename_ext=os.getenv("CDR_EXPORT_FILENAME_EXT", ".csv"),
            filename_ts_format=os.getenv("CDR_EXPORT_FILENAME_TS_FORMAT", "%Y%m%d%H%M%S"),
            delimiter=os.getenv("CDR_EXPORT_DELIMITER", ","),
            quote_all=_env_bool("CDR_EXPORT_QUOTE_ALL", False),
        )

    def redacted(self) -> dict:
        """Return a dict of config for logging, with the password redacted.

        NEVER log self.ftp_password directly — use this.
        """
        return {
            "enabled": self.enabled,
            "ftp_host": self.ftp_host,
            "ftp_port": self.ftp_port,
            "ftp_user": self.ftp_user,
            "ftp_password": "***REDACTED***" if self.ftp_password else "(empty)",
            "ftp_dir": self.ftp_dir,
            "ftp_passive": self.ftp_passive,
            "ftp_tls": self.ftp_tls,
            "ftp_timeout": self.ftp_timeout,
            "batch_size": self.batch_size,
            "lag_seconds": self.lag_seconds,
            "skip_empty": self.skip_empty,
            "interval_seconds": self.interval_seconds,
            "lock_ttl_seconds": self.lock_ttl_seconds,
            "filename_prefix": self.filename_prefix,
            "filename_ext": self.filename_ext,
        }
