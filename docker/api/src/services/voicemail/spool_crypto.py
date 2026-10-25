"""Unseal a spooled voicemail (Visual IVR plan D11 / §7.5, contract
docs/IVR_INTERFACES.md §8.4) — IN MEMORY, never on disk.

FreeSWITCH (``docker/freeswitch/scripts/lib/vm_spool.lua``) seals a message it
could not deposit with the openssl CLI of its runtime image (Debian bookworm,
OpenSSL 3.0.x)::

    openssl cms -encrypt -binary -aes-256-gcm -keyid -outform DER \
        -recip <cert> -keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256 \
        -keyopt rsa_mgf1_md:sha256 [-recip <next cert> ...]

i.e. a CMS **AuthEnvelopedData** (RFC 5083) ContentInfo:

* content: AES-256-GCM (RFC 5084), 12-byte nonce, 16-byte tag (``mac``), a
  fresh content-encryption key per message, no authAttrs (AAD = empty);
* key transport: one KeyTransRecipientInfo per certificate (version 2,
  rid = [0] subjectKeyIdentifier), RSAES-OAEP with SHA-256 and MGF1-SHA-256.

``cryptography`` (the API's existing dependency) has no AuthEnvelopedData
support (its PKCS#7 decryptor handles EnvelopedData + PKCS#1 v1.5 only), so
this module parses the DER with a small, STRICT reader and does the two
primitive operations with ``cryptography``: RSA-OAEP decrypt of the content
key, AES-256-GCM decrypt-and-verify of the content. No subprocess, no openssl
CLI in the API image, the private key never leaves this process, and nothing
is written anywhere: the ciphertext and plaintext are ``bytearray``s the
caller zeroes.

Strictness (an allow-list of exactly what vm_spool.lua produces — anything
else is :class:`SpoolBlobInvalid` -> HTTP 422):
definite-length DER only (no ``-stream`` BER), no trailing bytes, version 0,
no originatorInfo / authAttrs / unauthAttrs, only KeyTransRecipientInfo v2
with an SKI, OAEP parameters spelled out as SHA-256/MGF1-SHA-256 (the SHA-1
defaults are refused), content type id-data, aes256-GCM with a 12-byte nonce
and ICV length 16, a primitive encryptedContent, a 16-byte mac.

Key material — env ``VOICEMAIL_SPOOL_PRIVATE_KEY_B64`` (services VM .env ->
docker-compose.services.yml): base64 of a PEM bundle holding 1..4 RSA private
keys of >= 3072 bits (PKCS#8 ``PRIVATE KEY`` or PKCS#1 ``RSA PRIVATE KEY``,
unencrypted). Several keys = a rotation: the API opens a blob sealed to ANY
of them. Each key is matched to a recipient by its subjectKeyIdentifier
(RFC 5280 §4.2.1.2 method 1: SHA-1 of the subjectPublicKey BIT STRING —
what ``openssl req -x509`` / ``openssl x509`` put in the certificate by
default), so a blob sealed to a key the API does not hold is reported as
"no configured key" (:class:`SpoolNoRecipient`, 503 — the forwarder keeps the
file) rather than "tampered" (422). Unset / unparsable / too-small keys:
:class:`SpoolKeyUnavailable` (503). Parsed once per process per env value;
never logged.

What sealing does NOT give: sender authentication. The recipient certificate
is public, so anyone holding it could build a valid blob — the endpoint's
``X-Ingest-Secret`` (the same gate as the plaintext deposit) is what decides
who may submit one. Sealing protects the audio AT REST on the media VM and on
the wire to the API; the GCM tag protects it against modification.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import os
import re
import threading
from dataclasses import dataclass

from cryptography import x509
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .errors import VoicemailCryptoUnavailable

logger = logging.getLogger(__name__)

ENV_KEY = "VOICEMAIL_SPOOL_PRIVATE_KEY_B64"
MIN_RSA_BITS = 3072
MAX_KEYS = 4
#: Recipients per blob accepted (vm_spool.lua seals to at most 4).
MAX_RECIPIENTS = 4
#: Largest env value accepted (4 PEM keys of 4096 bits are ~13 KB).
MAX_ENV_CHARS = 65536

# DER contents of the OIDs we accept (tag/length stripped).
OID_AUTH_ENVELOPED_DATA = bytes.fromhex("2a864886f70d0109100117")  # 1.2.840.113549.1.9.16.1.23
OID_DATA = bytes.fromhex("2a864886f70d010701")                       # 1.2.840.113549.1.7.1
OID_AES256_GCM = bytes.fromhex("60864801650304012e")                 # 2.16.840.1.101.3.4.1.46
OID_RSAES_OAEP = bytes.fromhex("2a864886f70d010107")                 # 1.2.840.113549.1.1.7
OID_MGF1 = bytes.fromhex("2a864886f70d010108")                       # 1.2.840.113549.1.1.8
OID_SHA256 = bytes.fromhex("608648016503040201")                     # 2.16.840.1.101.3.4.2.1

GCM_NONCE_LEN = 12
GCM_TAG_LEN = 16
CEK_LEN = 32

# DER tags
_SEQ, _SET, _INT, _OCTET, _OID, _NULL = 0x30, 0x31, 0x02, 0x04, 0x06, 0x05


class SpoolBlobInvalid(ValueError):
    """The blob is not a well-formed spool seal, or it fails authentication
    (GCM tag / OAEP) -> HTTP 422 (permanent: the forwarder moves it to
    rejected/). The message never contains plaintext or key material."""


class SpoolKeyUnavailable(VoicemailCryptoUnavailable):
    """No usable spool private key is configured -> HTTP 503 (the forwarder
    keeps the file and retries)."""


class SpoolNoRecipient(SpoolKeyUnavailable):
    """The blob is sealed only to keys this API does not hold (a rotation /
    configuration mistake, not tampering) -> HTTP 503, file kept."""


@dataclass(frozen=True)
class SpoolKey:
    ski: bytes
    key: rsa.RSAPrivateKey
    bits: int


# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------
_PEM_BLOCK_RE = re.compile(
    rb"-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\r?\n.+?\r?\n-----END \1-----", re.S)

_cache_lock = threading.Lock()
_cache: tuple[str, tuple[SpoolKey, ...]] | None = None


def reset_key_cache() -> None:
    global _cache
    with _cache_lock:
        _cache = None


def _parse_keys(raw: str) -> tuple[SpoolKey, ...]:
    if len(raw) > MAX_ENV_CHARS:
        raise SpoolKeyUnavailable(f"{ENV_KEY} is too long")
    compact = "".join(raw.split())
    try:
        pem = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SpoolKeyUnavailable(f"{ENV_KEY} is not base64") from exc
    blocks = [m.group(0) for m in _PEM_BLOCK_RE.finditer(pem)]
    if not blocks:
        raise SpoolKeyUnavailable(f"{ENV_KEY} holds no PEM private key")
    if len(blocks) > MAX_KEYS:
        raise SpoolKeyUnavailable(f"{ENV_KEY} holds more than {MAX_KEYS} keys")
    keys: list[SpoolKey] = []
    for block in blocks:
        try:
            key = serialization.load_pem_private_key(block, password=None)
        except (ValueError, TypeError) as exc:
            raise SpoolKeyUnavailable(f"{ENV_KEY} holds an unreadable private key") from exc
        if not isinstance(key, rsa.RSAPrivateKey):
            raise SpoolKeyUnavailable(f"{ENV_KEY} holds a non-RSA key")
        if key.key_size < MIN_RSA_BITS:
            raise SpoolKeyUnavailable(
                f"{ENV_KEY} holds a {key.key_size}-bit key (minimum {MIN_RSA_BITS})")
        ski = x509.SubjectKeyIdentifier.from_public_key(key.public_key()).digest
        keys.append(SpoolKey(ski=ski, key=key, bits=key.key_size))
    return tuple(keys)


def load_spool_keys() -> tuple[SpoolKey, ...]:
    """The configured spool keys (cached per env value). Raises
    :class:`SpoolKeyUnavailable` when unset or unusable."""
    global _cache
    raw = (os.getenv(ENV_KEY) or "").strip()
    if not raw:
        raise SpoolKeyUnavailable(f"{ENV_KEY} is not set")
    digest = hashlib.sha256(raw.encode("utf-8", "surrogateescape")).hexdigest()
    with _cache_lock:
        if _cache is not None and _cache[0] == digest:
            return _cache[1]
    keys = _parse_keys(raw)
    with _cache_lock:
        _cache = (digest, keys)
    return keys


def spool_keys_configured() -> bool:
    try:
        load_spool_keys()
        return True
    except SpoolKeyUnavailable:
        return False


# ---------------------------------------------------------------------------
# Strict DER reader
# ---------------------------------------------------------------------------
def _bad(why: str) -> SpoolBlobInvalid:
    return SpoolBlobInvalid(why)


def _tlv(buf: memoryview, pos: int, end: int) -> tuple[int, int, int]:
    """One TLV in buf[pos:end] -> (tag, content_start, content_end).
    Definite, minimal-length DER only; low tag numbers only."""
    if pos + 2 > end:
        raise _bad("truncated DER")
    tag = buf[pos]
    if tag & 0x1F == 0x1F:
        raise _bad("unsupported DER tag")
    first = buf[pos + 1]
    pos += 2
    if first < 0x80:
        length = first
    elif first == 0x80:
        raise _bad("indefinite-length encoding is not accepted")
    else:
        n = first & 0x7F
        if n > 4 or pos + n > end:
            raise _bad("bad DER length")
        length = int.from_bytes(buf[pos:pos + n], "big")
        if length < 0x80 or buf[pos] == 0:
            raise _bad("non-minimal DER length")
        pos += n
    if pos + length > end:
        raise _bad("DER length exceeds the data")
    return tag, pos, pos + length


def _expect(buf: memoryview, pos: int, end: int, tag: int, what: str) -> tuple[int, int]:
    t, s, e = _tlv(buf, pos, end)
    if t != tag:
        raise _bad(f"{what}: unexpected DER tag 0x{t:02x}")
    return s, e


def _children(buf: memoryview, start: int, end: int, limit: int = 16) -> list[tuple[int, int, int]]:
    out = []
    pos = start
    while pos < end:
        t, s, e = _tlv(buf, pos, end)
        out.append((t, s, e))
        if len(out) > limit:
            raise _bad("too many DER elements")
        pos = e
    return out


def _small_int(buf: memoryview, s: int, e: int) -> int:
    if e - s < 1 or e - s > 4:
        raise _bad("bad INTEGER")
    return int.from_bytes(buf[s:e], "big", signed=True)


def _is_sha256_alg(buf: memoryview, s: int, e: int) -> bool:
    """AlgorithmIdentifier { sha256 [, NULL] } (both encodings are common)."""
    kids = _children(buf, s, e)
    if not kids or kids[0][0] != _OID or bytes(buf[kids[0][1]:kids[0][2]]) != OID_SHA256:
        return False
    if len(kids) == 1:
        return True
    return len(kids) == 2 and kids[1][0] == _NULL and kids[1][1] == kids[1][2]


def _check_oaep(buf: memoryview, s: int, e: int) -> None:
    """keyEncryptionAlgorithm = rsaesOaep with SHA-256 / MGF1-SHA-256 spelled out."""
    kids = _children(buf, s, e)
    if (len(kids) != 2 or kids[0][0] != _OID
            or bytes(buf[kids[0][1]:kids[0][2]]) != OID_RSAES_OAEP or kids[1][0] != _SEQ):
        raise _bad("key transport is not RSAES-OAEP")
    params = _children(buf, kids[1][1], kids[1][2])
    if len(params) != 2 or params[0][0] != 0xA0 or params[1][0] != 0xA1:
        raise _bad("OAEP parameters must name SHA-256 and MGF1-SHA-256")
    hs, he = _expect(buf, params[0][1], params[0][2], _SEQ, "OAEP hash")
    if not _is_sha256_alg(buf, hs, he):
        raise _bad("OAEP hash is not SHA-256")
    ms, me = _expect(buf, params[1][1], params[1][2], _SEQ, "OAEP MGF")
    mkids = _children(buf, ms, me)
    if (len(mkids) != 2 or mkids[0][0] != _OID or bytes(buf[mkids[0][1]:mkids[0][2]]) != OID_MGF1
            or mkids[1][0] != _SEQ or not _is_sha256_alg(buf, mkids[1][1], mkids[1][2])):
        raise _bad("OAEP mask generation is not MGF1-SHA-256")


@dataclass(frozen=True)
class _Recipient:
    ski: bytes
    encrypted_key: bytes


@dataclass(frozen=True)
class _Parsed:
    recipients: tuple[_Recipient, ...]
    nonce: bytes
    ct_start: int
    ct_end: int
    tag: bytes


def _parse(blob: memoryview) -> _Parsed:
    end = len(blob)
    cs, ce = _expect(blob, 0, end, _SEQ, "ContentInfo")
    if ce != end:
        raise _bad("trailing bytes after the ContentInfo")
    top = _children(blob, cs, ce)
    if (len(top) != 2 or top[0][0] != _OID
            or bytes(blob[top[0][1]:top[0][2]]) != OID_AUTH_ENVELOPED_DATA or top[1][0] != 0xA0):
        raise _bad("not a CMS AuthEnvelopedData")
    as_, ae = _expect(blob, top[1][1], top[1][2], _SEQ, "AuthEnvelopedData")
    if ae != top[1][2]:
        raise _bad("trailing bytes in the [0] content")
    parts = _children(blob, as_, ae)
    # version, recipientInfos, authEncryptedContentInfo, mac — nothing else.
    if len(parts) != 4:
        raise _bad("AuthEnvelopedData must be version, recipientInfos, content, mac")
    (vt, vs, ve), (rt, rs, re_), (et, es, ee), (mt, ms, me) = parts
    if vt != _INT or _small_int(blob, vs, ve) != 0:
        raise _bad("AuthEnvelopedData version must be 0")
    if rt != _SET:
        raise _bad("recipientInfos missing")
    if et != _SEQ:
        raise _bad("authEncryptedContentInfo missing")
    if mt != _OCTET or me - ms != GCM_TAG_LEN:
        raise _bad("mac must be a 16-byte OCTET STRING")

    recipients = []
    for t, s, e in _children(blob, rs, re_, limit=MAX_RECIPIENTS):
        if t != _SEQ:
            raise _bad("only KeyTransRecipientInfo is accepted")
        kt = _children(blob, s, e)
        if len(kt) != 4 or kt[0][0] != _INT or _small_int(blob, kt[0][1], kt[0][2]) != 2:
            raise _bad("KeyTransRecipientInfo must be version 2 (subjectKeyIdentifier)")
        if kt[1][0] != 0x80 or not 1 <= kt[1][2] - kt[1][1] <= 64:
            raise _bad("recipient id must be a subjectKeyIdentifier")
        if kt[2][0] != _SEQ:
            raise _bad("keyEncryptionAlgorithm missing")
        _check_oaep(blob, kt[2][1], kt[2][2])
        if kt[3][0] != _OCTET or not 1 <= kt[3][2] - kt[3][1] <= 1024:
            raise _bad("encryptedKey missing")
        recipients.append(_Recipient(ski=bytes(blob[kt[1][1]:kt[1][2]]),
                                     encrypted_key=bytes(blob[kt[3][1]:kt[3][2]])))
    if not recipients:
        raise _bad("no recipient")

    eci = _children(blob, es, ee)
    if len(eci) != 3:
        raise _bad("authEncryptedContentInfo must carry type, algorithm and content")
    (ct_t, ct_s, ct_e), (alg_t, alg_s, alg_e), (enc_t, enc_s, enc_e) = eci
    if ct_t != _OID or bytes(blob[ct_s:ct_e]) != OID_DATA:
        raise _bad("content type must be id-data")
    if alg_t != _SEQ:
        raise _bad("content encryption algorithm missing")
    alg = _children(blob, alg_s, alg_e)
    if (len(alg) != 2 or alg[0][0] != _OID or bytes(blob[alg[0][1]:alg[0][2]]) != OID_AES256_GCM
            or alg[1][0] != _SEQ):
        raise _bad("content encryption must be AES-256-GCM")
    gcm = _children(blob, alg[1][1], alg[1][2])
    if (len(gcm) != 2 or gcm[0][0] != _OCTET or gcm[0][2] - gcm[0][1] != GCM_NONCE_LEN
            or gcm[1][0] != _INT or _small_int(blob, gcm[1][1], gcm[1][2]) != GCM_TAG_LEN):
        raise _bad("GCM parameters must be a 12-byte nonce and a 16-byte tag")
    if enc_t != 0x80:
        raise _bad("encryptedContent must be a primitive [0]")
    return _Parsed(recipients=tuple(recipients), nonce=bytes(blob[gcm[0][1]:gcm[0][2]]),
                   ct_start=enc_s, ct_end=enc_e, tag=bytes(blob[ms:me]))


_OAEP = padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(),
                     label=None)


def unseal(blob: bytes | bytearray | memoryview,
           keys: tuple[SpoolKey, ...] | None = None) -> bytearray:
    """Decrypt + verify a spool blob; returns the plaintext (the sealed frame)
    as a NEW bytearray the caller must zero when done.

    Raises :class:`SpoolBlobInvalid` (422), :class:`SpoolNoRecipient` /
    :class:`SpoolKeyUnavailable` (503)."""
    if keys is None:
        keys = load_spool_keys()
    view = memoryview(blob)
    try:
        return _unseal(view, keys)
    finally:
        view.release()


def _unseal(view: memoryview, keys: tuple[SpoolKey, ...]) -> bytearray:
    parsed = _parse(view)
    by_ski = {k.ski: k for k in keys}
    match = next(((r, by_ski[r.ski]) for r in parsed.recipients if r.ski in by_ski), None)
    if match is None:
        raise SpoolNoRecipient("the blob is not sealed to any configured spool key")
    recipient, key = match
    try:
        cek = key.key.decrypt(recipient.encrypted_key, _OAEP)
    except ValueError as exc:
        raise _bad("the content key does not decrypt (tampered or corrupt)") from exc
    if len(cek) != CEK_LEN:
        raise _bad("the content key has the wrong length")

    ct = view[parsed.ct_start:parsed.ct_end]
    out = bytearray(len(ct) + 16)
    try:
        decryptor = Cipher(algorithms.AES(cek), modes.GCM(parsed.nonce, parsed.tag)).decryptor()
        n = decryptor.update_into(ct, out)
        decryptor.finalize()   # verifies the tag
    except InvalidTag as exc:
        out[:] = bytes(len(out))
        raise _bad("authentication tag mismatch (tampered or corrupt)") from exc
    except Exception:
        out[:] = bytes(len(out))
        raise
    finally:
        ct.release()
    del out[n:]
    return out
