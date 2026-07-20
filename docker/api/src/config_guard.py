"""Production secret/config guard (PROD-4).

Mirrors the ESL "ClueCon must never be a silent fallback" and the
``JWT_SECRET_KEY`` hard-fail patterns: in production the API must NOT boot with
dev-sentinel secrets that would silently weaken security.

When ``ENV`` (or ``ENVIRONMENT``) is ``production``/``prod`` and any guarded
secret is still its dev sentinel, :func:`assert_production_secrets` raises
``RuntimeError`` (fail-fast, like the JWT guard). Outside production it logs a
loud warning so local dev keeps working but the operator is told.

Guarded secrets:
  * ``TURN_SECRET``        — dev sentinel ``dev-turn-secret-change-me`` (coturn REST creds)
  * ``STORAGE_SECRET_KEY`` — dev sentinel ``minioadmin`` (object storage)
  * ``INGEST_SHARED_SECRET`` — unset (SEC-2 ingest auth) is a production hole
"""
import os
import logging

logger = logging.getLogger(__name__)

# secret env var -> its dev sentinel value that is forbidden in production.
DEV_SENTINELS = {
    "TURN_SECRET": "dev-turn-secret-change-me",
    "STORAGE_SECRET_KEY": "minioadmin",
}

# INGEST_SHARED_SECRET is guarded specially (unset is ALSO a hole, with its own
# message) but a dev-sentinel value must be rejected in production too.
INGEST_DEV_SENTINEL = "dev_ingest_secret_change_me"


def is_production() -> bool:
    """True when the API is told it is running in production via ENV/ENVIRONMENT."""
    env = (os.getenv("ENV") or os.getenv("ENVIRONMENT") or "").strip().lower()
    return env in ("production", "prod")


def find_offenders() -> list[str]:
    """Return a list of human-readable offenders (dev sentinels / unset secrets)."""
    offenders: list[str] = []
    for var, sentinel in DEV_SENTINELS.items():
        if os.getenv(var, sentinel) == sentinel:
            offenders.append(f"{var} is still the dev default")
    ingest = os.getenv("INGEST_SHARED_SECRET", "")
    if not ingest:
        offenders.append("INGEST_SHARED_SECRET is unset (ingest endpoints unauthenticated)")
    elif ingest == INGEST_DEV_SENTINEL:
        offenders.append("INGEST_SHARED_SECRET is still the dev default")
    return offenders


def assert_production_secrets() -> None:
    """Fail-fast in production (loud-warn otherwise) on dev-sentinel secrets."""
    offenders = find_offenders()
    if not offenders:
        return
    detail = "; ".join(offenders)
    if is_production():
        raise RuntimeError(
            "Refusing to start in production with dev-default/unset secrets: "
            f"{detail}. Set real values for TURN_SECRET, STORAGE_SECRET_KEY and "
            "INGEST_SHARED_SECRET in the Services VM .env."
        )
    logger.warning(
        "SECURITY: dev-default/unset secrets detected (%s). Acceptable for local "
        "dev; production (ENV=production) will REFUSE to start until these are set.",
        detail,
    )
