"""IVR product limits (plan docs/IVR_PRODUCT_PLAN.md §1 "Limits", contract §4).

One place for every bound the API enforces; ``GET /v1/ivr/summary`` returns
``public_limits()`` so the portal shows the same numbers it is held to.
"""
from __future__ import annotations

#: Canonical prompt audio: 8 kHz mono PCM16 (contract §4).
AUDIO_RATE = 8000
#: <= 120 s per prompt; the canonical WAV is then <= 1,920,044 bytes
#: (migration 59's ivr_prompt_audio_bytes_chk).
MAX_PROMPT_SECONDS = 120
#: Shortest prompt accepted (a 1-sample WAV is not a message).
MIN_PROMPT_MS = 100
#: Per customer: live (not soft-deleted) prompts, and DISTINCT audio bytes.
MAX_PROMPTS_PER_CUSTOMER = 100
MAX_AUDIO_BYTES_PER_CUSTOMER = 50 * 1024 * 1024
#: Raw upload body cap (a 120 s 48 kHz stereo PCM16 WAV is ~23 MB; the
#: browser pipeline sends 8/16 kHz mono, <= 3.9 MB).
MAX_UPLOAD_BYTES = 24 * 1024 * 1024

#: Flows: blocks per flow, edges, serialized draft size, flows per customer.
MAX_NODES = 200
MAX_EDGES = 1000
MAX_GRAPH_BYTES = 512 * 1024
MAX_FLOWS_PER_CUSTOMER = 100
MAX_PROMPTS_PER_BLOCK = 10

#: Runtime budgets written into every plan (contract §3 ``limits``).
MAX_STEPS = 200
MAX_SECONDS = 1800

#: TTS text length (contract §8.1) and the preview rate limit (§8.2).
MAX_TTS_CHARS = 1000
TTS_PREVIEW_PER_MINUTE = 30

#: Names (flows, prompts, numbers).
MAX_NAME_CHARS = 100


def public_limits() -> dict:
    """The limits a customer can see (GET /v1/ivr/summary ``limits``)."""
    return {
        "max_prompts": MAX_PROMPTS_PER_CUSTOMER,
        "max_audio_bytes": MAX_AUDIO_BYTES_PER_CUSTOMER,
        "max_prompt_seconds": MAX_PROMPT_SECONDS,
        "max_blocks": MAX_NODES,
        "max_flows": MAX_FLOWS_PER_CUSTOMER,
        "max_call_seconds": MAX_SECONDS,
        "max_steps": MAX_STEPS,
        "max_tts_chars": MAX_TTS_CHARS,
        "tts_preview_per_minute": TTS_PREVIEW_PER_MINUTE,
    }
