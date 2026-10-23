"""
Core JWT security functions.
Uses python-jose for JWT and bcrypt directly for password hashing.
"""
import os
import bcrypt
from datetime import datetime, timedelta, timezone
from jose import jwt, JWTError

JWT_SECRET = os.getenv("JWT_SECRET_KEY")
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET_KEY environment variable is required")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "480"))  # 8 hours


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def hash_password(plain: str) -> str:
    """Hash a plaintext password with bcrypt."""
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


#: ``typ`` claim of a login session token. Any OTHER token family (e.g. the
#: voicemail playback token, typ "vm-playback", auth/playback.py) must never be
#: accepted as a Bearer session — docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §3.
SESSION_TOKEN_TYPE = "session"


def create_access_token(data: dict) -> str:
    """Create a session JWT (``typ: "session"`` + ``exp``). The caller cannot
    override ``typ``."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)
    to_encode["exp"] = expire
    to_encode["typ"] = SESSION_TOKEN_TYPE
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Decode and validate a SESSION JWT. Raises JWTError on failure.

    A token whose ``typ`` claim is present and is not ``"session"`` is rejected
    (JWTError). Tokens with no ``typ`` at all were issued before the claim
    existed and stay valid until they expire (<= JWT_EXPIRE_MINUTES). Tokens
    carrying an ``aud`` claim are rejected by python-jose itself (no audience
    is expected here).
    """
    claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    if "typ" in claims and claims["typ"] != SESSION_TOKEN_TYPE:
        raise JWTError("not a session token")
    return claims
