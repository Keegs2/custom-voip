"""Token encryption for the Calendar integration (Fernet, key from env).

OAuth access/refresh tokens are encrypted at rest with Fernet (AES-128-CBC +
HMAC-SHA256, from the `cryptography` package). The key(s) come from the
``CALENDAR_TOKEN_ENC_KEY`` env var:

  * single key  -> one Fernet
  * comma-separated keys -> MultiFernet (KEY ROTATION):
        - the FIRST key encrypts new tokens,
        - ALL keys are tried on decrypt (oldest ciphertext still readable).
    Rotate by prepending a fresh ``Fernet.generate_key()`` and keeping the old
    key around until every row has been re-encrypted (refresh-on-read re-writes
    with the new primary key over time).

If the key is UNSET the feature is DISABLED — the router 503s ``calendar_disabled``
rather than ever storing plaintext tokens. ``encryption_configured()`` lets the
router make that check without importing key material.

Security: never log the key, the plaintext token, or the ciphertext.
"""
import os
import logging
from typing import Optional

from cryptography.fernet import Fernet, MultiFernet, InvalidToken

logger = logging.getLogger(__name__)

# Read once at import. Set per-VM in /opt/revup/.env (Services VM) in production.
_RAW_KEYS = os.getenv("CALENDAR_TOKEN_ENC_KEY", "")

# Lazily-built Fernet/MultiFernet instance (None when no key configured).
_fernet: Optional[MultiFernet] = None
_init_attempted = False
_warned_unset = False


def _build_fernet() -> Optional[MultiFernet]:
    """Construct a MultiFernet from the comma-separated key env, or None.

    Invalid/empty keys are skipped. Returns None when no usable key exists, so
    callers degrade to ``calendar_disabled`` instead of crashing import/startup.
    """
    global _warned_unset
    raw = (_RAW_KEYS or "").strip()
    if not raw:
        if not _warned_unset:
            logger.warning(
                "Calendar integration DISABLED: CALENDAR_TOKEN_ENC_KEY is unset. "
                "The calendar router will 503 'calendar_disabled' — tokens are "
                "NEVER stored in plaintext. Set a Fernet key "
                "(python -c 'from cryptography.fernet import Fernet; "
                "print(Fernet.generate_key().decode())') to enable."
            )
            _warned_unset = True
        return None

    fernets = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            fernets.append(Fernet(token.encode()))
        except (ValueError, TypeError) as exc:
            # Do NOT log the key material itself.
            logger.error(
                "Calendar: ignoring an invalid CALENDAR_TOKEN_ENC_KEY entry (%s)",
                type(exc).__name__,
            )
    if not fernets:
        logger.error(
            "Calendar integration DISABLED: CALENDAR_TOKEN_ENC_KEY contained no "
            "valid Fernet keys."
        )
        return None
    return MultiFernet(fernets)


def _get_fernet() -> Optional[MultiFernet]:
    """Return the cached MultiFernet (building it once), or None if unconfigured."""
    global _fernet, _init_attempted
    if not _init_attempted:
        _fernet = _build_fernet()
        _init_attempted = True
    return _fernet


def encryption_configured() -> bool:
    """True iff a usable encryption key is configured.

    The router calls this to 503 ``calendar_disabled`` before doing any work that
    would require persisting a token, so plaintext is never written.
    """
    return _get_fernet() is not None


def encrypt(plaintext: Optional[str]) -> Optional[str]:
    """Encrypt a token string -> Fernet ciphertext (str). ``None`` -> ``None``.

    Raises RuntimeError if encryption is not configured — callers MUST gate on
    ``encryption_configured()`` first so this never silently no-ops.
    """
    if plaintext is None:
        return None
    f = _get_fernet()
    if f is None:
        raise RuntimeError("calendar_disabled: CALENDAR_TOKEN_ENC_KEY is not configured")
    return f.encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: Optional[str]) -> Optional[str]:
    """Decrypt Fernet ciphertext -> token string. ``None`` -> ``None``.

    Returns None on an undecryptable value (key rotated out / corrupt) rather
    than raising, so a single bad row degrades to needs_reauth instead of 500.
    """
    if ciphertext is None:
        return None
    f = _get_fernet()
    if f is None:
        raise RuntimeError("calendar_disabled: CALENDAR_TOKEN_ENC_KEY is not configured")
    try:
        return f.decrypt(ciphertext.encode()).decode()
    except (InvalidToken, ValueError, TypeError):
        logger.warning("Calendar: failed to decrypt a stored token (key rotated out?)")
        return None
