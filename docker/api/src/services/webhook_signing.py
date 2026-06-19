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
import ipaddress
import secrets
import socket
from typing import Mapping
from urllib.parse import urlparse

# Header name carrying the signature on every webhook POST.
SIGNATURE_HEADER = "X-Revup-Signature"

# ---------------------------------------------------------------------------
# SSRF guard for CUSTOMER-supplied webhook URLs (SHOULD-FIX c)
# ---------------------------------------------------------------------------
# Customers set voice_url / status_callback freely. Before our voice engine (or
# any API-side fetch) POSTs a signed webhook to one of those URLs, it MUST run it
# through is_safe_webhook_url() so a customer cannot aim us at internal infra —
# most dangerously the cloud metadata endpoint 169.254.169.254 (GCP/AWS creds),
# or loopback / RFC1918 services on the VPC.
_BLOCKED_WEBHOOK_HOSTNAMES = {
    "localhost",
    "metadata",
    "metadata.google.internal",
}


def _ip_is_internal(ip: "ipaddress._BaseAddress") -> bool:
    """True for any address a customer webhook must never reach."""
    return (
        ip.is_private          # RFC1918 / fc00:: etc.
        or ip.is_loopback      # 127.0.0.0/8, ::1
        or ip.is_link_local    # 169.254.0.0/16 (incl. cloud metadata)
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified   # 0.0.0.0
    )


def is_safe_webhook_url(url: str, *, resolve: bool = True) -> bool:
    """Return True iff ``url`` is a safe destination for a customer webhook POST.

    Blocks non-http(s) schemes, the cloud metadata host (169.254.169.254 and the
    metadata hostnames), loopback, link-local, RFC1918/private, reserved,
    multicast and unspecified addresses. When ``resolve`` is True (default) the
    hostname is DNS-resolved and every resolved address is checked too, so a name
    that points at an internal IP (DNS-rebinding-to-internal) is also rejected.

    This is the explicit hook the signing/fetch path must call; it returns a bool
    rather than raising so callers can log + skip the offending URL cleanly.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    if parsed.scheme not in ("http", "https"):
        return False

    host = parsed.hostname
    if not host:
        return False
    if host.lower() in _BLOCKED_WEBHOOK_HOSTNAMES:
        return False

    # Literal IP host — check directly without DNS.
    try:
        return not _ip_is_internal(ipaddress.ip_address(host))
    except ValueError:
        pass  # not a literal IP — fall through to DNS resolution

    if not resolve:
        return True

    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        # Unresolvable host: fail closed (we cannot prove it is external).
        return False
    for info in infos:
        addr = info[4][0].split("%")[0]  # strip any IPv6 zone id
        try:
            if _ip_is_internal(ipaddress.ip_address(addr)):
                return False
        except ValueError:
            continue
    return True


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
