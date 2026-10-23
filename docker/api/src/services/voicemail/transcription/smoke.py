"""Speech-to-Text smoke test (docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §8.3).

Run inside the API container (services VM, after the API deploy):

    sudo docker exec voip-api python -m services.voicemail.transcription.smoke

* Validates the configuration REGARDLESS of the platform flag (so it can be
  run before switching transcription on).
* Sends ONLY 1.0 s of generated digital silence — never customer data — at
  a cost of ~1 s (Google rounds each request up to 1 s).
* Prints one line and exits 0:
    stt smoke ok: provider=gcp_stt_v2 endpoint=us-speech.googleapis.com location=us model=telephony results=0 billed_ms=1000
  or exits 1:
    stt smoke FAILED: <code> <ExceptionClass>
  (``stt_permission PermissionDenied`` = the speech.client binding has not
  propagated yet or is missing; ``stt_config NotFound`` = check
  VOICEMAIL_STT_PROJECT; ``config TranscriptionUnavailable`` = an env
  problem, listed on the next lines).
"""
from __future__ import annotations

import asyncio
import sys

from . import config as tconfig
from .provider import SttError, get_stt_provider, pin_library_loggers


async def run(out=None) -> int:
    out = out or sys.stdout
    pin_library_loggers()
    try:
        cfg = tconfig.require_valid()
    except tconfig.TranscriptionUnavailable:
        print("stt smoke FAILED: config TranscriptionUnavailable", file=out)
        for problem in tconfig.problems():
            print(f"  - {problem}", file=out)
        return 1
    try:
        provider = get_stt_provider()
        outcome = await provider.smoke()
    except SttError as exc:
        print(f"stt smoke FAILED: {exc.code} {exc.source}", file=out)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"stt smoke FAILED: unexpected {type(exc).__name__}", file=out)
        return 1
    endpoint = cfg.endpoint if not cfg.is_fake else "in-process"
    print(f"stt smoke ok: provider={outcome.provider} endpoint={endpoint} "
          f"location={outcome.location} model={outcome.model} "
          f"results={len(outcome.segments)} billed_ms={outcome.billed_ms}", file=out)
    return 0


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
