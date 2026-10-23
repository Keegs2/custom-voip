"""Voicemail transcription (v1.1) — contract docs/VOICEMAIL_TRANSCRIPTION_PLAN.md
(owner decisions §0.1 override the rest of it).

A background worker in every API process transcribes stored voicemail with
Google Cloud Speech-to-Text V2 (sync ``Recognize``, ``us``), seals each
transcript under the customer's existing KMS KEK
(``services.voicemail.seal_transcript``, AAD ``vmt:``) and stores the
ciphertext on its ``voicemail_transcripts`` row (migration 56). Plaintext audio
and transcript text exist only in RAM (D8).

    config    env parsing, the platform flag, ``available()`` (plan §12)
    document  the transcript JSON document that gets sealed (plan §5)

Importing this package needs no GCP credentials, imports no Google library and
makes no network call.

    from services.voicemail.transcription import config, document
    config.available()            # summary.transcription_available
    config.SUPPORTED_LANGUAGES    # ("en-US", "es-US", "fr-CA")
"""
from . import config, document
from .config import (
    DEFAULT_LANGUAGE,
    SUPPORTED_LANGUAGES,
    TranscriptionUnavailable,
    available,
    platform_enabled,
)

__all__ = [
    "config", "document",
    "DEFAULT_LANGUAGE", "SUPPORTED_LANGUAGES", "TranscriptionUnavailable",
    "available", "platform_enabled",
]
