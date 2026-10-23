"""In-process, RAM-only LRU for decrypted voicemail audio (plan §3.3, D8).

Why: a browser ``<audio>`` element issues many HTTP Range requests per
playback. Decrypting per request costs a GCS download + a KMS unwrap each
time (build-plan defect 9). Instead the plaintext is decrypted ONCE per
playback token (``jti``) and every Range request of that token is served from
this cache until the token expires.

Budget (uvicorn runs 4 worker processes, one cache each):
  * playback  : 64 MB per process (~256 MB total), entries live <= the
                token's remaining lifetime (<= 120 s);
  * FS greeting fetch: 16 MB per process, 30 s TTL (a burst of calls to one
                mailbox plays the same greeting without one KMS decrypt each).

Single-threaded by construction: every method runs on the event-loop thread
(no awaits inside), so no lock is needed. Nothing here touches the disk; the
bytes die with the entry (Python cannot scrub immutable ``bytes`` — RAM-only
is the guarantee, not zeroisation).

``get_or_load`` collapses concurrent misses for the same key in one process
into ONE load (the second Range request of a token waits for the first
decrypt instead of starting another).
"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Hashable


class PlaintextCache:
    def __init__(self, max_bytes: int, *, clock: Callable[[], float] = time.monotonic):
        self.max_bytes = int(max_bytes)
        self._clock = clock
        self._items: "OrderedDict[Hashable, tuple[bytes, float, Any]]" = OrderedDict()
        self._bytes = 0
        self._inflight: dict[Hashable, asyncio.Future] = {}

    # -- introspection (tests / metrics) ------------------------------------
    @property
    def bytes_used(self) -> int:
        return self._bytes

    def __len__(self) -> int:
        return len(self._items)

    def __contains__(self, key: Hashable) -> bool:
        return self.get(key) is not None

    # -- core ----------------------------------------------------------------
    def _drop(self, key: Hashable) -> None:
        entry = self._items.pop(key, None)
        if entry is not None:
            self._bytes -= len(entry[0])

    def purge_expired(self) -> None:
        now = self._clock()
        for key in [k for k, (_, exp, _t) in self._items.items() if exp <= now]:
            self._drop(key)

    def get(self, key: Hashable) -> bytes | None:
        entry = self._items.get(key)
        if entry is None:
            return None
        data, expires, _tag = entry
        if expires <= self._clock():
            self._drop(key)
            return None
        self._items.move_to_end(key)
        return data

    def get_tag(self, key: Hashable) -> Any:
        entry = self._items.get(key)
        return entry[2] if entry is not None else None

    def put(self, key: Hashable, data: bytes, ttl_s: float, tag: Any = None) -> bool:
        """Store ``data`` for ``ttl_s`` seconds. Returns False (not cached)
        when it alone exceeds the budget or ttl_s <= 0."""
        size = len(data)
        if ttl_s <= 0 or size > self.max_bytes:
            return False
        self._drop(key)
        self.purge_expired()
        while self._items and self._bytes + size > self.max_bytes:
            oldest = next(iter(self._items))
            self._drop(oldest)
        self._items[key] = (bytes(data), self._clock() + ttl_s, tag)
        self._bytes += size
        return True

    def evict(self, predicate: Callable[[Hashable, Any], bool]) -> int:
        """Drop every entry whose (key, tag) matches. Returns the count."""
        doomed = [k for k, (_, _e, tag) in self._items.items() if predicate(k, tag)]
        for key in doomed:
            self._drop(key)
        return len(doomed)

    def clear(self) -> None:
        self._items.clear()
        self._bytes = 0

    async def get_or_load(self, key: Hashable, loader: Callable[[], Awaitable[bytes]],
                          ttl_s: float, tag: Any = None) -> tuple[bytes, bool]:
        """Return ``(data, loaded_now)``. On a miss runs ``loader`` once per
        key per process (concurrent callers await the same load) and caches
        the result. A loader exception propagates to every waiter and nothing
        is cached."""
        cached = self.get(key)
        if cached is not None:
            return cached, False
        pending = self._inflight.get(key)
        if pending is not None:
            return await asyncio.shield(pending), False
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._inflight[key] = fut
        try:
            data = await loader()
        except BaseException as exc:
            if not fut.done():
                fut.set_exception(exc)
                fut.exception()  # mark retrieved: no "never retrieved" warning
            raise
        else:
            self.put(key, data, ttl_s, tag)
            if not fut.done():
                fut.set_result(data)
            return data, True
        finally:
            self._inflight.pop(key, None)
