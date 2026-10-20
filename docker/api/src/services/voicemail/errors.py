"""Exception types for the encrypted-voicemail crypto/KMS/storage layer.

Contract: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §2. Callers map:

* :class:`VoicemailCryptoUnavailable` (and subclasses) -> HTTP 503 — KMS, GCS,
  the database or the configuration is not usable right now. Never fall back
  to storing or serving plaintext.
* :class:`VoicemailIntegrityError` (and subclasses) -> HTTP 500 + an ERROR
  log — an AAD / GCM tag / CRC32C / format check failed, or a stored object is
  missing. The data must never be served.

Messages never contain plaintext, key material or secrets.
"""


class VoicemailCryptoUnavailable(RuntimeError):
    """KMS / GCS / DB / configuration unavailable — callers return 503."""


class VoicemailKeyDestroyed(VoicemailCryptoUnavailable):
    """The customer's key was crypto-erased. Permanent: nothing can be sealed
    or opened under it again (still a 503 for callers that only know the
    parent class)."""


class VoicemailIntegrityError(RuntimeError):
    """AAD / GCM tag / CRC32C mismatch or malformed crypto fields — 500, never serve."""


class VoicemailObjectNotFound(VoicemailIntegrityError):
    """A row says 'stored' but its ciphertext object does not exist."""
