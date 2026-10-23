"""Encrypted-voicemail configuration — env parsing + fail-closed checks.

Contract: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §2 (env list) and §3 (secrets).
Read LIVE on every call (same convention as ``src/config.py``): a test
``monkeypatch.setenv`` or a container restart with a new ``.env`` takes effect
without code changes. Parsing never raises; the ``require_*`` helpers raise
:class:`VoicemailCryptoUnavailable` when the configuration cannot be used, so
every voicemail path fails CLOSED (503) instead of degrading to plaintext.

Production env (services ``.env`` -> ``docker-compose.services.yml`` -> ``api``):

==========================  =================  =====================================
VOICEMAIL_KMS_PROVIDER      ``gcpkms``         only ``gcpkms`` is valid in production
VOICEMAIL_KMS_PROJECT       (required)         GCP project id holding the keyring
VOICEMAIL_KMS_LOCATION      ``us-east1``
VOICEMAIL_KMS_KEYRING       ``voicemail-prod``
VOICEMAIL_BUCKET            ``voip-voicemail``
VOICEMAIL_IMPERSONATE_SA    (optional)         SA email to impersonate from ADC
VOICEMAIL_PLAYBACK_SECRET   (required, >=32)   must differ from JWT_SECRET_KEY
INGEST_SHARED_SECRET        (required, >=32)   FreeSWITCH ``X-Ingest-Secret``
==========================  =================  =====================================

Dev/CI ONLY (deliberately NOT passed through docker-compose.services.yml, so
production can never select them):

* ``VOICEMAIL_ALLOW_LOCAL_KMS=true`` — permits ``VOICEMAIL_KMS_PROVIDER=local``
  (HKDF-derived per-customer keys from ``VOICEMAIL_LOCAL_MASTER_KEY``, base64
  of 32 random bytes) and ``VOICEMAIL_STORAGE=memory`` (in-process object
  store). Even with the flag, both are refused when ``ENV`` or
  ``ENVIRONMENT`` is ``production`` (belt and braces).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

from .errors import VoicemailCryptoUnavailable

DEFAULT_KMS_PROVIDER = "gcpkms"
DEFAULT_KMS_LOCATION = "us-east1"
DEFAULT_KMS_KEYRING = "voicemail-prod"
DEFAULT_BUCKET = "voip-voicemail"
DEFAULT_STORAGE = "gcs"

KMS_PROVIDERS = ("gcpkms", "local")
STORAGE_BACKENDS = ("gcs", "memory")

#: Minimum length of the shared/playback secrets (contract §2/§3).
MIN_SECRET_CHARS = 32

# Resource-name components are interpolated into KMS resource paths, so they
# are validated strictly (no '/', no whitespace) — a bad value is a config
# error, never a path-injection vector.
_PROJECT_RE = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", re.ASCII)
_LOCATION_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}", re.ASCII)
_KEYRING_RE = re.compile(r"[A-Za-z0-9_-]{1,63}", re.ASCII)
_BUCKET_RE = re.compile(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", re.ASCII)
_SA_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.ASCII)


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


@dataclass(frozen=True)
class VoicemailConfig:
    """A parsed snapshot of the voicemail env. Unvalidated — see require_*."""

    kms_provider: str
    kms_project: str
    kms_location: str
    kms_keyring: str
    bucket: str
    impersonate_sa: str
    storage_backend: str
    allow_local: bool
    production_env: bool
    local_master_key_b64: str

    @property
    def keyring_name(self) -> str:
        return (f"projects/{self.kms_project}/locations/{self.kms_location}"
                f"/keyRings/{self.kms_keyring}")

    def crypto_key_name(self, customer_id: int) -> str:
        return f"{self.keyring_name}/cryptoKeys/vm-cust-{int(customer_id)}"

    @property
    def local_backends_permitted(self) -> bool:
        """Local KMS / memory store: explicit opt-in AND not a production env."""
        return self.allow_local and not self.production_env


def load_config() -> VoicemailConfig:
    """Snapshot the voicemail env (never raises)."""
    return VoicemailConfig(
        kms_provider=_env("VOICEMAIL_KMS_PROVIDER", DEFAULT_KMS_PROVIDER).lower(),
        kms_project=_env("VOICEMAIL_KMS_PROJECT"),
        kms_location=_env("VOICEMAIL_KMS_LOCATION", DEFAULT_KMS_LOCATION),
        kms_keyring=_env("VOICEMAIL_KMS_KEYRING", DEFAULT_KMS_KEYRING),
        bucket=_env("VOICEMAIL_BUCKET", DEFAULT_BUCKET),
        impersonate_sa=_env("VOICEMAIL_IMPERSONATE_SA"),
        storage_backend=_env("VOICEMAIL_STORAGE", DEFAULT_STORAGE).lower(),
        allow_local=_env("VOICEMAIL_ALLOW_LOCAL_KMS").lower() == "true",
        production_env=(_env("ENV").lower() == "production"
                        or _env("ENVIRONMENT").lower() == "production"),
        local_master_key_b64=_env("VOICEMAIL_LOCAL_MASTER_KEY"),
    )


def require_gcp_kms_config(cfg: VoicemailConfig) -> None:
    """Raise VoicemailCryptoUnavailable unless the Cloud KMS settings are usable."""
    if not cfg.kms_project:
        raise VoicemailCryptoUnavailable("VOICEMAIL_KMS_PROJECT is not set")
    if not _PROJECT_RE.fullmatch(cfg.kms_project):
        raise VoicemailCryptoUnavailable("VOICEMAIL_KMS_PROJECT is not a valid GCP project id")
    if not _LOCATION_RE.fullmatch(cfg.kms_location):
        raise VoicemailCryptoUnavailable("VOICEMAIL_KMS_LOCATION is invalid")
    if not _KEYRING_RE.fullmatch(cfg.kms_keyring):
        raise VoicemailCryptoUnavailable("VOICEMAIL_KMS_KEYRING is invalid")
    if cfg.impersonate_sa and not _SA_EMAIL_RE.fullmatch(cfg.impersonate_sa):
        raise VoicemailCryptoUnavailable("VOICEMAIL_IMPERSONATE_SA is not a service-account email")


def require_gcs_config(cfg: VoicemailConfig) -> None:
    """Raise VoicemailCryptoUnavailable unless the GCS settings are usable."""
    if not _BUCKET_RE.fullmatch(cfg.bucket or ""):
        raise VoicemailCryptoUnavailable("VOICEMAIL_BUCKET is not a valid bucket name")
    if cfg.impersonate_sa and not _SA_EMAIL_RE.fullmatch(cfg.impersonate_sa):
        raise VoicemailCryptoUnavailable("VOICEMAIL_IMPERSONATE_SA is not a service-account email")
    if cfg.kms_project and not _PROJECT_RE.fullmatch(cfg.kms_project):
        raise VoicemailCryptoUnavailable("VOICEMAIL_KMS_PROJECT is not a valid GCP project id")


def require_local_backends_permitted(cfg: VoicemailConfig, what: str) -> None:
    """Refuse the dev-only local KMS / memory store unless explicitly allowed."""
    if cfg.production_env:
        raise VoicemailCryptoUnavailable(
            f"{what} is refused: ENV/ENVIRONMENT=production (dev/CI only)")
    if not cfg.allow_local:
        raise VoicemailCryptoUnavailable(
            f"{what} is refused: VOICEMAIL_ALLOW_LOCAL_KMS is not 'true' (dev/CI only)")


# ---------------------------------------------------------------------------
# Shared secrets (contract §2/§3). Return None when unusable — the auth
# modules turn that into a fail-closed 503 + ERROR log. Never logged.
# ---------------------------------------------------------------------------
def ingest_secret() -> str | None:
    """INGEST_SHARED_SECRET if set and >= 32 chars, else None (fail closed)."""
    value = os.getenv("INGEST_SHARED_SECRET") or ""
    return value if len(value) >= MIN_SECRET_CHARS else None


def playback_secret() -> str | None:
    """VOICEMAIL_PLAYBACK_SECRET if >= 32 chars AND different from
    JWT_SECRET_KEY, else None (fail closed)."""
    value = os.getenv("VOICEMAIL_PLAYBACK_SECRET") or ""
    if len(value) < MIN_SECRET_CHARS:
        return None
    if value == (os.getenv("JWT_SECRET_KEY") or ""):
        return None
    return value
