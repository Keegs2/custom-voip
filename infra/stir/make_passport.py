#!/usr/bin/env python3
"""
make_passport.py — build a SHAKEN (or div) PASSporT / Identity header value.

INDEPENDENT of libsecsipid on purpose: we sign the ES256 JWS with Python's
`cryptography` (a different implementation than the Go libsecsipid that VERIFIES
it in the self-test). If the library accepts a PASSporT built by an unrelated
signer, that is a stronger proof than round-tripping one library against itself.

Emits the full SIP `Identity` header VALUE (compact JWS + the SHAKEN params):
    <base64url(header)>.<base64url(payload)>.<base64url(sig)>;info=<x5u>;alg=ES256;ppt=<ppt>

ATIS-1000074 SHAKEN PASSporT:
  header : {"alg":"ES256","typ":"passport","ppt":"shaken","x5u":"<url>"}
  payload: {"attest":"A","dest":{"tn":["<to>"]},"iat":<iat>,
            "orig":{"tn":"<from>"},"origid":"<uuid>"}
For a diversion ("div") PASSporT: ppt="div", payload adds "div":{"tn":["<divtn>"]}.

Usage:
  make_passport.py --key leaf.key --x5u <URL> --orig <tn> --dest <tn>
                   [--ppt shaken|div] [--attest A|B|C] [--iat <epoch>]
                   [--div <tn>] [--origid <uuid>]
Prints the Identity header value to stdout.
"""
import argparse
import base64
import json
import sys
import time
import uuid

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, utils as asym_utils
except Exception as e:  # pragma: no cover
    sys.stderr.write(
        "make_passport.py: python 'cryptography' is required "
        "(pip install cryptography). Import error: %s\n" % e
    )
    sys.exit(3)


def b64url(data: bytes) -> str:
    """base64url without padding, per JWS."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def der_to_raw_p256(der_sig: bytes) -> bytes:
    """
    Convert an ASN.1/DER ECDSA signature (what cryptography emits) to the raw
    fixed-width R||S JOSE form ES256 requires (2 x 32 bytes for P-256).
    """
    r, s = asym_utils.decode_dss_signature(der_sig)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", required=True, help="EC P-256 signing private key (PEM)")
    ap.add_argument("--x5u", required=True, help="x5u URL embedded in the header")
    ap.add_argument("--orig", required=True, help="originating TN (E.164, no +)")
    ap.add_argument("--dest", required=True, help="destination TN (E.164, no +)")
    ap.add_argument("--ppt", default="shaken", choices=["shaken", "div"])
    ap.add_argument("--attest", default="A", choices=["A", "B", "C"])
    ap.add_argument("--iat", type=int, default=None, help="issued-at epoch (default now)")
    ap.add_argument("--div", default=None, help="diverting TN for ppt=div")
    ap.add_argument("--origid", default=None, help="origid UUID (default random)")
    args = ap.parse_args()

    with open(args.key, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        sys.stderr.write("make_passport.py: key is not an EC private key\n")
        return 3

    iat = args.iat if args.iat is not None else int(time.time())
    origid = args.origid or str(uuid.uuid4())

    header = {
        "alg": "ES256",
        "ppt": args.ppt,
        "typ": "passport",
        "x5u": args.x5u,
    }
    payload = {
        "attest": args.attest,
        "dest": {"tn": [args.dest]},
        "iat": iat,
        "orig": {"tn": args.orig},
        "origid": origid,
    }
    if args.ppt == "div":
        # Diversion PASSporT carries the diverting number.
        divtn = args.div or args.orig
        payload["div"] = {"tn": [divtn]}

    # Compact JWS. json separators keep it tight; SHAKEN doesn't require sorted
    # keys, but stable ordering makes the fixtures reproducible.
    signing_header = b64url(
        json.dumps(header, separators=(",", ":"), sort_keys=True).encode()
    )
    signing_payload = b64url(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    )
    signing_input = (signing_header + "." + signing_payload).encode("ascii")

    der_sig = key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    raw_sig = der_to_raw_p256(der_sig)
    jws = signing_header + "." + signing_payload + "." + b64url(raw_sig)

    # Full SIP Identity header value: compact JWS + SHAKEN params.
    identity = "%s;info=<%s>;alg=ES256;ppt=%s" % (jws, args.x5u, args.ppt)
    sys.stdout.write(identity + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
