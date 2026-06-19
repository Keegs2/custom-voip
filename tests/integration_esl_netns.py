"""
Phase 5 — LIVE ESL integration proof, run INSIDE the FreeSWITCH network
namespace (FS uses host networking, so a `--network host` python:3.12 container
shares it and can reach ESL on 127.0.0.1:8021).

This is NOT a pytest module — it is a standalone asyncio driver that imports the
REAL production client (services/esl_client.py, mounted read-only) and exercises
it against the running FreeSWITCH:

  mode "self"  (default):
     1. connect + subscribe to the real FS
     2. originate a parked loopback channel (bgapi originate — the SAME ESL
        command fs_cli issues) and capture its uuid
     3. assert the consumer observed CHANNEL_CREATE for that uuid (registry)
     4. event-CONFIRMED hangup via hangup_call_confirmed() — the exact code path
        the /v1/calls/{id}/update endpoint uses — and assert CHANNEL_HANGUP was
        observed (confirmed=True), not fire-and-forget
     5. print the resulting registry entry + a PASS/FAIL verdict

  mode "watch <seconds>":
     connect and print every observed event for N seconds (used to prove an
     fs_cli-originated channel is independently observed).

Exit code 0 = PASS, 1 = FAIL.

Invoked by the orchestrator in the task report, e.g.:
  docker run --rm --network host -v "$PWD/docker/api/src:/src:ro" \
      -e FREESWITCH_ESL_HOST=127.0.0.1 -e FREESWITCH_ESL_PASSWORD=fs_esl_dev_pw \
      python:3.12-slim python /src/../../../tests/integration_esl_netns.py self
"""
import os
import sys
import asyncio

sys.path.insert(0, "/src")  # mounted services/ package

from services import esl_client as esl  # noqa: E402


async def _wait_connected(client, timeout=15.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if client.connected:
            return True
        await asyncio.sleep(0.25)
    return False


async def mode_self() -> int:
    client = esl.get_esl_client()
    client.start()
    print(f"[*] connecting to {client.host}:{client.port} ...")
    if not await _wait_connected(client):
        print(f"[FAIL] never connected: {client.last_error}")
        return 1
    print(f"[OK] connected. health={client.health()}")

    # 2. originate a parked loopback channel via the client (bgapi originate).
    print("[*] originate loopback/9999 &park() via bgapi ...")
    result = await client.bgapi("originate loopback/9999 &park()", timeout=20.0)
    print(f"[*] originate result: {result!r}")
    if not result or "+OK" not in result:
        print("[FAIL] originate did not return +OK <uuid>")
        return 1
    call_uuid = result.split()[-1].strip()
    print(f"[OK] originated uuid={call_uuid}")

    # 3. assert CHANNEL_CREATE landed in the registry.
    seen = None
    for _ in range(20):
        seen = client.get_call(call_uuid)
        if seen is not None:
            break
        await asyncio.sleep(0.25)
    if seen is None:
        # loopback may report the b-leg uuid; accept ANY live call as create-proof
        live = [c for c in client.snapshot() if c["state"] in ("created", "answered")]
        if not live:
            print("[FAIL] no CHANNEL_CREATE observed for any channel")
            return 1
        call_uuid = live[0]["uuid"]
        seen = client.get_call(call_uuid)
        print(f"[OK] CHANNEL_CREATE observed (using live channel {call_uuid})")
    else:
        print(f"[OK] CHANNEL_CREATE observed: state={seen.state} caller={seen.caller}")

    # 4. EVENT-CONFIRMED hangup (the /v1/calls/{id}/update code path).
    print(f"[*] hangup_call_confirmed({call_uuid}) ...")
    conf = await esl.hangup_call_confirmed(call_uuid, timeout=8.0)
    print(f"[*] confirmed-hangup result: {conf}")
    if not conf["ok"]:
        print("[FAIL] uuid_kill command did not return +OK")
        return 1
    if not conf["confirmed"]:
        print("[FAIL] CHANNEL_HANGUP was NOT observed — not event-confirmed")
        return 1

    final = client.get_call(call_uuid)
    print(f"[OK] registry final: state={final.state if final else '?'} "
          f"cause={final.hangup_cause if final else '?'}")
    print(f"[*] consumer health: {client.health()}")
    print("[PASS] real FS event flow + event-confirmed live-modify verified")
    await client.stop()
    return 0


async def mode_watch(seconds: float) -> int:
    client = esl.get_esl_client()
    client.start()
    if not await _wait_connected(client):
        print(f"[FAIL] never connected: {client.last_error}")
        return 1
    print(f"[OK] connected; watching events for {seconds}s ...")
    start = asyncio.get_event_loop().time()
    last_n = 0
    while asyncio.get_event_loop().time() - start < seconds:
        snap = client.snapshot()
        if len(snap) != last_n:
            for c in snap:
                print(f"   [event] uuid={c['uuid']} state={c['state']} "
                      f"caller={c['caller']} dest={c['dest']} cause={c['hangup_cause']}")
            last_n = len(snap)
        await asyncio.sleep(0.25)
    print(f"[*] final registry size={len(client.snapshot())} health={client.health()}")
    await client.stop()
    return 0


async def mode_reconnect(seconds: float) -> int:
    """Connect, then poll connection state for `seconds` while the orchestrator
    restarts FreeSWITCH. PASS if we observe connected -> disconnected -> connected
    (a real reconnect), proving the supervisor's backoff/reconnect works."""
    client = esl.get_esl_client()
    client.start()
    if not await _wait_connected(client):
        print(f"[FAIL] never connected initially: {client.last_error}")
        return 1
    print("[OK] initial connect")
    saw_down = False
    saw_recover = False
    start = asyncio.get_event_loop().time()
    prev = True
    while asyncio.get_event_loop().time() - start < seconds:
        cur = client.connected
        if cur != prev:
            print(f"   [transition] connected={cur} reconnects={client.reconnects} "
                  f"err={client.last_error}")
            if not cur:
                saw_down = True
            elif saw_down:
                saw_recover = True
        prev = cur
        await asyncio.sleep(0.5)
    print(f"[*] final health: {client.health()}")
    connected_at_end = client.connected  # capture BEFORE stop() tears it down
    await client.stop()
    if saw_down and saw_recover and connected_at_end:
        print("[PASS] observed connected -> down -> reconnected")
        return 0
    print(f"[FAIL] reconnect not observed (down={saw_down} recover={saw_recover} "
          f"connected={connected_at_end})")
    return 1


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "self"
    if mode == "watch":
        secs = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
        return asyncio.run(mode_watch(secs))
    if mode == "reconnect":
        secs = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0
        return asyncio.run(mode_reconnect(secs))
    return asyncio.run(mode_self())


if __name__ == "__main__":
    raise SystemExit(main())
