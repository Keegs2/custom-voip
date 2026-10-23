"""Bounded raw-body reading for voicemail uploads (contract §4.6, plan §3.2).

Audio bodies are read straight from the ASGI stream into ONE pre-sized
``bytearray`` — never ``request.form()`` / ``UploadFile`` (Starlette spools
multipart parts over 1 MB to a temp FILE: plaintext on disk, defect 5).

* ``Content-Length`` present: validated (ASCII digits) and checked against the
  cap BEFORE a single byte is read (413); the buffer is allocated once at the
  declared size and a short body is a 400.
* chunked / no length: a running byte counter refuses the body the moment it
  passes the cap (413) and zeroes what it had read.

Callers zero the returned buffer when done (best effort — D8 is about never
touching disk; RAM scrubbing is a bonus).
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def zero(buf: bytearray | None) -> None:
    if buf:
        buf[:] = bytes(len(buf))


def content_type_is_wav(value: str | None) -> bool:
    """``audio/wav`` (also the common ``audio/x-wav`` / ``audio/wave``
    spellings); parameters after ``;`` are ignored."""
    if not value:
        return False
    media = value.split(";", 1)[0].strip().lower()
    return media in ("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave")


def declared_length(request: Any, cap: int, *, too_large: str) -> int | None:
    """Validate Content-Length against ``cap`` without reading the body."""
    raw = request.headers.get("content-length")
    if raw is None:
        return None
    raw = raw.strip()
    if not raw.isascii() or not raw.isdigit() or len(raw) > 15:
        raise HTTPException(status_code=400, detail="Invalid Content-Length.")
    n = int(raw)
    if n > cap:
        raise HTTPException(status_code=413, detail=too_large)
    return n


async def read_capped_body(request: Any, cap: int, *, too_large: str) -> bytearray:
    """Read the whole request body (<= ``cap`` bytes) into RAM."""
    expected = declared_length(request, cap, too_large=too_large)
    if expected is not None:
        buf = bytearray(expected)
        view = memoryview(buf)
        pos = 0
        try:
            async for chunk in request.stream():
                if not chunk:
                    continue
                n = len(chunk)
                if pos + n > expected:
                    raise HTTPException(status_code=400,
                                        detail="Body is longer than its Content-Length.")
                view[pos:pos + n] = chunk
                pos += n
        except BaseException:
            view.release()
            zero(buf)
            raise
        view.release()
        if pos != expected:
            zero(buf)
            raise HTTPException(status_code=400, detail="Body is shorter than its Content-Length.")
        return buf

    buf = bytearray()
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            if len(buf) + len(chunk) > cap:
                raise HTTPException(status_code=413, detail=too_large)
            buf += chunk
    except BaseException:
        zero(buf)
        raise
    return buf
