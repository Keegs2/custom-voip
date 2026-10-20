"""Per-process, non-blocking admission counters for the voicemail paths that
hold plaintext audio in RAM (plan §3.2 memory budget).

Each uvicorn worker process (4) has its own counters, so a limit of N here is
~4N platform-wide. ``try_acquire`` never waits: callers answer 503 +
``Retry-After`` instead of queueing (FreeSWITCH retries deposits; the UI shows
"temporarily unavailable"). Event-loop thread only — no awaits inside, so no
lock is needed, and nothing binds to a particular event loop.
"""
from __future__ import annotations


class NonBlockingLimiter:
    def __init__(self, limit: int):
        self.limit = limit
        self.in_use = 0

    def try_acquire(self) -> bool:
        if self.in_use >= self.limit:
            return False
        self.in_use += 1
        return True

    def release(self) -> None:
        if self.in_use > 0:
            self.in_use -= 1
