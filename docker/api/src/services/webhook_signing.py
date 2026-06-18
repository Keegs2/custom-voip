"""
Webhook request signing for the programmable-voice product (Twilio-style).

This module is the API/DB half of a signing contract shared with the FreeSWITCH
Lua side. Both halves MUST produce byte-for-byte identical signatures.

SHARED SIGNING CONTRACT
-----------------------
Given:
  - secret  = customer's `webhook_signing_secret` (TEXT in the customers table)
  - url     = the full webhook URL the request is POSTed to
  - params  = the POST body parameters (key -> value)

Compute:
  signing_string = url + concat(for each POST param sorted by key: key + value)
  signature      = base64( HMAC_SHA256(secret, signing_string) )

FreeSWITCH sends `signature` in the `X-Revup-Signature` header on every webhook
POST. Customers (and our own verifier) recompute it from the secret + request to
authenticate the request and detect tampering.

Notes on the algorithm (must match the Lua side exactly):
  * Params are sorted by key using plain bytewise/lexicographic ordering of the
    UTF-8 key strings (Python's default str sort, Lua's table.sort default).
  * Each param contributes `key` immediately followed by `value`, with NO
    separators between key, value, or successive pairs.
  * Multi-valued params are NOT part of the contract (each key appears once),
    matching Twilio's documented scheme.
  * HMAC uses SHA-256; the digest is standard (non-URL-safe) base64 WITH padding.
"""
import base64
import hashlib
import hmac
import secrets
from typing import Mapping

# Header name carrying the signature on every webhook POST.
SIGNATURE_HEADER = "X-Revup-Signature"


def generate_secret() -> str:
    """Generate a fresh 256-bit signing secret as 64 lowercase hex chars.

    Matches the format the SQL backfill produces
    (`encode(gen_random_bytes(32), 'hex')`) so secrets look identical whether
    minted by Postgres or the API.
    """
    return secrets.token_hex(32)


def build_signing_string(url: str, params: Mapping[str, str]) -> str:
    """Build the canonical signing string: url + concat(sorted key+value)."""
    concatenated = "".join(
        f"{key}{params[key]}" for key in sorted(params.keys())
    )
    return f"{url}{concatenated}"


def compute_signature(secret: str, url: str, params: Mapping[str, str]) -> str:
    """Return base64(HMAC_SHA256(secret, url + concat(sorted key+value)))."""
    signing_string = build_signing_string(url, params)
    digest = hmac.new(
        secret.encode("utf-8"),
        signing_string.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def verify_signature(
    secret: str,
    url: str,
    params: Mapping[str, str],
    header: str,
) -> bool:
    """Constant-time check of a received `X-Revup-Signature` header value.

    Returns True iff `header` equals the signature we compute from
    (secret, url, params). Uses `hmac.compare_digest` to avoid timing leaks.
    A missing/None header is treated as a failed verification.
    """
    if not secret or header is None:
        return False
    expected = compute_signature(secret, url, params)
    return hmac.compare_digest(expected, header)
