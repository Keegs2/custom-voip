"""services/voicemail/spool_crypto.py + sealed.py pure parts (no database).

The unsealer accepts EXACTLY what lib/vm_spool.lua's openssl command makes —
CMS AuthEnvelopedData, AES-256-GCM, RSAES-OAEP SHA-256/MGF1-SHA-256, SKI
recipient ids — and nothing weaker. Proves, with blobs built by the openssl
CLI:
  * round trip (1 and 2 recipients; recipients in either order);
  * downgrades refused (422-class SpoolBlobInvalid): OAEP with the SHA-1
    defaults, PKCS#1 v1.5 key transport, AES-256-CBC EnvelopedData,
    issuerAndSerialNumber recipient ids, BER indefinite length (-stream);
  * a blob for another key -> SpoolNoRecipient (503-class), never 422;
  * key bundle parsing: PKCS#8 and PKCS#1 PEM, 1..4 keys, >= 3072 bits,
    RSA only, base64 with line breaks, cached per env value;
  * the CRAGVMS1 frame parser and the sealed-metadata validator.

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_voicemail_outage_crypto.py -q
"""
from __future__ import annotations

import base64
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
pytest.importorskip("cryptography", reason="cryptography required")

API_SRC = Path(__file__).resolve().parents[1] / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from services.voicemail import sealed, spool_crypto  # noqa: E402
from services.voicemail.meta import MetaError  # noqa: E402

OPENSSL = shutil.which("openssl")
OAEP = ["-keyopt", "rsa_padding_mode:oaep", "-keyopt", "rsa_oaep_md:sha256",
        "-keyopt", "rsa_mgf1_md:sha256"]
PAYLOAD = b"CRAGVMS1\n2\n{}" + b"\x01\x02" * 4000


@pytest.fixture(scope="module")
def ossl(tmp_path_factory):
    if OPENSSL is None:
        pytest.skip("openssl CLI not found")
    root = tmp_path_factory.mktemp("spoolcrypto")

    def run(*args):
        return subprocess.run([OPENSSL, *map(str, args)], check=True, capture_output=True)

    class O:
        pass
    o = O()
    o.root = root
    o.run = run
    o.n = 0

    def make(bits=3072, name=None):
        o.n += 1
        key, cert = root / f"k{o.n}.pem", root / f"c{o.n}.pem"
        run("genpkey", "-algorithm", "RSA", "-pkeyopt", f"rsa_keygen_bits:{bits}", "-out", key)
        run("req", "-new", "-x509", "-key", key, "-subj", f"/CN=t{o.n}", "-days", "2", "-out", cert)
        return key, cert

    def seal(certs, *extra, payload=PAYLOAD, oaep=True, keyid=True, cipher="-aes-256-gcm"):
        o.n += 1
        inp, out = root / f"in{o.n}", root / f"out{o.n}"
        inp.write_bytes(payload)
        args = ["cms", "-encrypt", "-binary", cipher, "-outform", "DER", "-in", inp, "-out", out]
        if keyid:
            args.append("-keyid")
        for c in certs:
            args += ["-recip", c] + (OAEP if oaep else [])
        args += list(extra)
        run(*args)
        return out.read_bytes()

    o.make, o.seal = make, seal
    try:
        o.k1, o.c1 = make()
        o.k2, o.c2 = make()
        o.seal([o.c1])
    except subprocess.CalledProcessError as e:
        pytest.skip(f"openssl cannot build AuthEnvelopedData: {e.stderr[:200]!r}")
    return o


def keys_of(*pems: Path) -> tuple:
    return spool_crypto._parse_keys(base64.b64encode(b"".join(p.read_bytes() for p in pems)).decode())


def test_round_trip_one_and_two_recipients(ossl):
    k1 = keys_of(ossl.k1)
    assert bytes(spool_crypto.unseal(ossl.seal([ossl.c1]), k1)) == PAYLOAD
    for order in ([ossl.c1, ossl.c2], [ossl.c2, ossl.c1]):
        blob = ossl.seal(order)
        assert bytes(spool_crypto.unseal(blob, k1)) == PAYLOAD
        assert bytes(spool_crypto.unseal(blob, keys_of(ossl.k2))) == PAYLOAD


def test_other_key_is_no_recipient_not_invalid(ossl):
    with pytest.raises(spool_crypto.SpoolNoRecipient):
        spool_crypto.unseal(ossl.seal([ossl.c2]), keys_of(ossl.k1))
    assert issubclass(spool_crypto.SpoolNoRecipient, spool_crypto.SpoolKeyUnavailable)


@pytest.mark.parametrize("variant", ["oaep_sha1_defaults", "pkcs1v15", "cbc_enveloped",
                                     "issuer_serial", "stream_ber"])
def test_downgrades_are_refused(ossl, variant):
    k1 = keys_of(ossl.k1)
    try:
        if variant == "oaep_sha1_defaults":
            blob = _seal_raw(ossl, ["-keyid", "-recip", ossl.c1, "-keyopt", "rsa_padding_mode:oaep"])
        elif variant == "pkcs1v15":
            blob = ossl.seal([ossl.c1], oaep=False)
        elif variant == "cbc_enveloped":
            blob = ossl.seal([ossl.c1], cipher="-aes-256-cbc")
        elif variant == "issuer_serial":
            blob = ossl.seal([ossl.c1], keyid=False)
        else:
            blob = ossl.seal([ossl.c1], "-stream")
    except subprocess.CalledProcessError as e:
        pytest.skip(f"this openssl cannot build {variant}: {e.stderr[:120]!r}")
    with pytest.raises(spool_crypto.SpoolBlobInvalid):
        spool_crypto.unseal(blob, k1)


def _seal_raw(ossl, recip_args):
    ossl.n += 1
    inp, out = ossl.root / f"raw{ossl.n}", ossl.root / f"rawo{ossl.n}"
    inp.write_bytes(PAYLOAD)
    ossl.run("cms", "-encrypt", "-binary", "-aes-256-gcm", "-outform", "DER", "-in", inp,
             "-out", out, *recip_args)
    return out.read_bytes()


def test_key_bundle_parsing(ossl):
    pkcs8 = ossl.k1.read_bytes()
    assert b"BEGIN PRIVATE KEY" in pkcs8
    pkcs1 = ossl.root / "pkcs1.pem"
    ossl.run("pkey", "-in", ossl.k2, "-traditional", "-out", pkcs1)
    keys = keys_of(ossl.k1, pkcs1)
    assert len(keys) == 2 and all(k.bits == 3072 and len(k.ski) == 20 for k in keys)
    # base64 with line breaks (base64 without -w0) is fine
    wrapped = base64.encodebytes(pkcs8).decode()
    assert len(spool_crypto._parse_keys(wrapped)) == 1
    small, _ = ossl.make(2048)
    with pytest.raises(spool_crypto.SpoolKeyUnavailable, match="2048-bit"):
        keys_of(small)
    ec = ossl.root / "ec.pem"
    ossl.run("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", ec)
    with pytest.raises(spool_crypto.SpoolKeyUnavailable, match="non-RSA"):
        keys_of(ec)
    with pytest.raises(spool_crypto.SpoolKeyUnavailable, match="more than 4"):
        keys_of(*([ossl.k1] * 5))
    for junk in ("", "%%%", base64.b64encode(b"hello").decode()):
        with pytest.raises(spool_crypto.SpoolKeyUnavailable):
            spool_crypto._parse_keys(junk)


def test_load_spool_keys_env_and_cache(ossl, monkeypatch):
    spool_crypto.reset_key_cache()
    monkeypatch.delenv(spool_crypto.ENV_KEY, raising=False)
    with pytest.raises(spool_crypto.SpoolKeyUnavailable, match="not set"):
        spool_crypto.load_spool_keys()
    assert spool_crypto.spool_keys_configured() is False
    monkeypatch.setenv(spool_crypto.ENV_KEY, base64.b64encode(ossl.k1.read_bytes()).decode())
    a = spool_crypto.load_spool_keys()
    assert spool_crypto.load_spool_keys() is a          # cached
    monkeypatch.setenv(spool_crypto.ENV_KEY, base64.b64encode(ossl.k2.read_bytes()).decode())
    b = spool_crypto.load_spool_keys()
    assert b is not a and b[0].ski != a[0].ski          # env change = new keys
    spool_crypto.reset_key_cache()


def test_unseal_output_is_a_fresh_bytearray(ossl):
    out = spool_crypto.unseal(ossl.seal([ossl.c1]), keys_of(ossl.k1))
    assert isinstance(out, bytearray)
    out[:] = bytes(len(out))  # the caller can zero it


# ---------------------------------------------------------------------------
# sealed.py pure parts
# ---------------------------------------------------------------------------
WAV = b"RIFF" + b"\x00" * 60


@pytest.mark.parametrize("data", [
    b"CRAGVMS2\n2\n{}" + WAV, b"CRAGVMS1\n\n{}" + WAV, b"CRAGVMS1\n02\n{}" + WAV,
    b"CRAGVMS1\n1\n{" + WAV, b"CRAGVMS1\n99999\n{}" + WAV, b"CRAGVMS1\n2x\n{}" + WAV,
    b"CRAGVMS1\n2\n{}RIFF", b"",
])
def test_frame_rejects(data):
    with pytest.raises(spool_crypto.SpoolBlobInvalid):
        sealed.parse_frame(bytearray(data))


def test_frame_accepts():
    meta = b'{"v":1}'
    data = bytearray(b"CRAGVMS1\n7\n" + meta + WAV)
    s, e, w = sealed.parse_frame(data)
    assert bytes(data[s:e]) == meta and bytes(data[w:]) == WAV


def good_meta(**over):
    m = {"v": 1, "msg_uuid": str(uuid.uuid4()), "mailbox_id": 7, "did": "+16175550000",
         "caller_number": "+15085551212", "caller_name": "Jane", "received_at": "2026-10-25T10:11:12Z",
         "duration_ms": 1234, "zone": "west"}
    m.update(over)
    return {k: v for k, v in m.items() if v is not None}


def test_sealed_meta_ok_and_optional_fields():
    m = sealed.parse_sealed_meta(good_meta(caller_name=None, did=None))
    assert m.caller_name is None and m.did is None and m.mailbox_id == 7
    assert m.received_at.isoformat() == "2026-10-25T10:11:12+00:00"
    dm = m.deposit_meta()
    assert dm.caller_id_number == "+15085551212" and dm.call_uuid is None and dm.zone == "west"
    m = sealed.parse_sealed_meta(good_meta(received_at="2026-10-25T10:11:12+00:00",
                                           caller_name="a\x01b  "))
    assert m.caller_name == "a b"


@pytest.mark.parametrize("over", [
    {"v": 2}, {"v": True}, {"msg_uuid": "nope"}, {"mailbox_id": 0}, {"mailbox_id": "7"},
    {"mailbox_id": True}, {"duration_ms": -1}, {"duration_ms": None}, {"received_at": None},
    {"received_at": "2026-10-25 10:11"}, {"received_at": "2026-10-25T10:11:12"},
    {"received_at": "2026-10-25T10:11:12+01:00"}, {"caller_number": 5}, {"zone": "x" * 17},
    {"caller_name": "\ud800"},
])
def test_sealed_meta_rejects(over):
    with pytest.raises(MetaError):
        sealed.parse_sealed_meta(good_meta(**over))
