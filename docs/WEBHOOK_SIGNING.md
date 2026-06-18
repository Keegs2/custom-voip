# Webhook Signing — Verifying `X-Revup-Signature`

Every programmable-voice webhook POST that Revup sends to your URL carries an
`X-Revup-Signature` header. Verify it to confirm the request genuinely came from
Revup and was not tampered with in transit.

## The Signature

Revup signs each request with **HMAC-SHA256** (Twilio-style) using your
per-account **webhook signing secret**:

```
signing_string = full_webhook_url + concat(for each POST param sorted by key: key + value)
signature      = base64( HMAC_SHA256(webhook_signing_secret, signing_string) )
```

- `full_webhook_url` — the exact URL the request was POSTed to (scheme, host,
  path, and any query string), as configured on the DID.
- POST params are sorted by key (lexicographic/bytewise on the UTF-8 key), then
  each contributes `key` immediately followed by `value` with **no separators**.
- The digest is standard base64 (with padding), placed verbatim in
  `X-Revup-Signature`.

## Getting / Rotating Your Secret

Your secret lives on your customer account. An operator can fetch or rotate it:

```bash
# Fetch (admin JWT required)
curl -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.revup.io/v1/customers/<CUSTOMER_ID>/webhook-secret

# Rotate — returns a NEW secret; update your verifier in lockstep
curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.revup.io/v1/customers/<CUSTOMER_ID>/webhook-secret/rotate
```

## Verification Recipe

### Python

```python
import base64, hashlib, hmac

def verify(secret: str, url: str, params: dict, header: str) -> bool:
    signing_string = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    digest = hmac.new(secret.encode(), signing_string.encode(), hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, header or "")
```

In FastAPI/Flask, build `params` from the POST form body and `url` from the
full request URL, then compare against `request.headers["X-Revup-Signature"]`.

### Node.js

```js
const crypto = require("crypto");

function verify(secret, url, params, header) {
  const signingString =
    url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signingString)
    .digest("base64");
  return (
    header &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header))
  );
}
```

## Known-Answer Test Vector

Use this to validate your implementation before going live:

| Field | Value |
|---|---|
| `secret` | `testsecret` |
| `url` | `https://example.com/voice` |
| `params` | `{"From": "+15551234", "To": "+15555678"}` |
| `signing_string` | `https://example.com/voiceFrom+15551234To+15555678` |
| **`X-Revup-Signature`** | `+Lu6H/dr1/c+r08GN5S/CmXvska+2DZCcySrWXSSPiI=` |

If your code produces that exact base64 string, it matches Revup's signer.

## Notes

- Always compare with a constant-time function (`hmac.compare_digest` /
  `crypto.timingSafeEqual`) to avoid timing side-channels.
- Reject requests whose signature does not match.
- After a secret rotation, the new secret takes effect immediately for all
  subsequent callbacks.
