"""
Webhook signing round-trip + known-answer tests (Phase 3).

Verifies the API/DB half of the shared signing contract with the FreeSWITCH Lua
half. The KNOWN-ANSWER vector below is the cross-check point: the Lua
implementation MUST produce the identical base64 signature for the same inputs.

Algorithm under test (Twilio-style):
  signing_string = url + concat(for each POST param sorted by key: key + value)
  signature      = base64( HMAC_SHA256(secret, signing_string) )

Run:  python3 -m pytest tests/test_webhook_signing.py -q
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))

from services.webhook_signing import (  # noqa: E402
    build_signing_string,
    compute_signature,
    verify_signature,
    generate_secret,
    SIGNATURE_HEADER,
)

# --------------------------------------------------------------------------
# KNOWN-ANSWER VECTOR — diff this against the Lua implementation's output.
# secret = "testsecret"
# url    = "https://example.com/voice"
# params = {"From": "+15551234", "To": "+15555678"}
# signing_string = "https://example.com/voiceFrom+15551234To+15555678"
# --------------------------------------------------------------------------
KA_SECRET = "testsecret"
KA_URL = "https://example.com/voice"
KA_PARAMS = {"From": "+15551234", "To": "+15555678"}
KA_SIGNING_STRING = "https://example.com/voiceFrom+15551234To+15555678"
KA_SIGNATURE = "+Lu6H/dr1/c+r08GN5S/CmXvska+2DZCcySrWXSSPiI="


def test_signing_string_construction():
    assert build_signing_string(KA_URL, KA_PARAMS) == KA_SIGNING_STRING


def test_known_answer_signature():
    """Locks the exact base64 HMAC so the Lua side can be byte-for-byte diffed."""
    assert compute_signature(KA_SECRET, KA_URL, KA_PARAMS) == KA_SIGNATURE


def test_param_order_independent():
    """Params are sorted by key, so input dict ordering must not change output."""
    reordered = {"To": "+15555678", "From": "+15551234"}
    assert compute_signature(KA_SECRET, KA_URL, reordered) == KA_SIGNATURE


def test_round_trip_compute_then_verify():
    secret = generate_secret()
    url = "https://hooks.revup.io/v1/voice/inbound"
    params = {"CallSid": "abc123", "From": "+18005551212", "To": "+16174544217"}
    sig = compute_signature(secret, url, params)
    assert verify_signature(secret, url, params, sig) is True


def test_verify_rejects_tampered_param():
    secret = generate_secret()
    url = "https://hooks.revup.io/v1/voice/inbound"
    params = {"From": "+18005551212", "To": "+16174544217"}
    sig = compute_signature(secret, url, params)
    tampered = dict(params, To="+19998887777")
    assert verify_signature(secret, url, tampered, sig) is False


def test_verify_rejects_wrong_secret():
    url = "https://hooks.revup.io/v1/voice/inbound"
    params = {"From": "+18005551212"}
    sig = compute_signature("secret-a", url, params)
    assert verify_signature("secret-b", url, params, sig) is False


def test_verify_rejects_missing_header():
    assert verify_signature("s", "https://x", {"a": "b"}, None) is False
    assert verify_signature("s", "https://x", {"a": "b"}, "") is False


def test_generated_secret_format():
    s = generate_secret()
    assert len(s) == 64
    assert all(c in "0123456789abcdef" for c in s)
    assert generate_secret() != generate_secret()


def test_signature_header_name():
    assert SIGNATURE_HEADER == "X-Revup-Signature"
