"""
Phase 5 — async ESL control-plane unit tests (no live FreeSWITCH).

Covers:
  * live-call registry state transitions driven by SYNTHETIC ESL events
  * event-confirmation waiter (wait_for_event)
  * event-confirmed live-call modification (hangup) over a faked command channel
  * graceful degradation: commands return None/False while disconnected, and
    start() never crashes when FS is unreachable / unconfigured
  * reconnect / exponential-backoff supervisor logic

These run with zero infra (no DB/Redis/FS). The integration proof that the
consumer observes REAL FreeSWITCH events lives in tests/integration_esl_netns.py
(run inside the FS network namespace — see the module docstring there).

Run:  python3 -m pytest tests/test_esl_consumer.py -q
"""
import sys
import asyncio
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))

from services import esl_client as esl  # noqa: E402
from services.esl_client import ESLClient, LiveCall  # noqa: E402


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def make_event(fields: dict) -> bytes:
    """Build an ESL event-plain payload (Key: value lines, blank-terminated)."""
    return ("\n".join(f"{k}: {v}" for k, v in fields.items()) + "\n\n").encode()


@pytest.fixture(autouse=True)
def _reset_singleton():
    """Each test gets a clean module singleton."""
    saved = esl._client
    esl._client = None
    yield
    esl._client = saved


# --------------------------------------------------------------------------
# 1. registry state transitions from synthetic events
# --------------------------------------------------------------------------
def test_registry_full_lifecycle():
    c = ESLClient(host="h", password="p")

    c._handle_event_block(make_event({
        "Event-Name": "CHANNEL_CREATE",
        "Unique-ID": "u1",
        "Caller-Caller-ID-Number": "+15551112222",
        "Caller-Destination-Number": "+15553334444",
        "Call-Direction": "outbound",
        "variable_customer_id": "7",
        "variable_product_type": "api",
    }))
    call = c.registry["u1"]
    assert call.state == "created"
    assert call.caller == "+15551112222"
    assert call.dest == "+15553334444"
    assert call.direction == "outbound"
    assert call.customer_id == 7
    assert call.product_type == "api"
    assert call.answered_at is None

    c._handle_event_block(make_event({"Event-Name": "CHANNEL_ANSWER", "Unique-ID": "u1"}))
    assert c.registry["u1"].state == "answered"
    assert c.registry["u1"].answered_at is not None

    c._handle_event_block(make_event({
        "Event-Name": "CHANNEL_EXECUTE_COMPLETE",
        "Unique-ID": "u1",
        "Application": "playback",
        "Application-Data": "ivr/greeting.wav",
    }))
    assert "playback" in c.registry["u1"].last_app

    c._handle_event_block(make_event({
        "Event-Name": "DTMF", "Unique-ID": "u1", "DTMF-Digit": "5",
    }))
    assert c.registry["u1"].last_dtmf == "5"

    c._handle_event_block(make_event({
        "Event-Name": "CHANNEL_HANGUP",
        "Unique-ID": "u1",
        "Hangup-Cause": "NORMAL_CLEARING",
    }))
    assert c.registry["u1"].state == "hungup"
    assert c.registry["u1"].hangup_cause == "NORMAL_CLEARING"
    assert c.registry["u1"].hangup_at is not None


def test_answer_before_create_does_not_lose_state():
    """A late/duplicate CHANNEL_CREATE must not clobber an already-answered call."""
    c = ESLClient(host="h", password="p")
    c._handle_event_block(make_event({"Event-Name": "CHANNEL_ANSWER", "Unique-ID": "u9"}))
    assert c.registry["u9"].state == "answered"
    c._handle_event_block(make_event({"Event-Name": "CHANNEL_CREATE", "Unique-ID": "u9"}))
    assert c.registry["u9"].state == "answered"  # not regressed to "created"


def test_channel_call_uuid_fallback_key():
    c = ESLClient(host="h", password="p")
    c._handle_event_block(make_event({
        "Event-Name": "CHANNEL_CREATE", "Channel-Call-UUID": "cc1",
    }))
    assert "cc1" in c.registry


def test_url_encoded_event_values_are_decoded():
    c = ESLClient(host="h", password="p")
    # "+1 555" url-encoded as %2B1%20555
    c._handle_event_block(make_event({
        "Event-Name": "CHANNEL_CREATE", "Unique-ID": "u2",
        "Caller-Caller-ID-Number": "%2B15550000000",
    }))
    assert c.registry["u2"].caller == "+15550000000"


def test_prune_evicts_old_hungup_calls():
    c = ESLClient(host="h", password="p")
    old = LiveCall(uuid="dead", state="hungup")
    old.hangup_at = 0.0  # epoch — definitely older than TTL
    c.registry["dead"] = old
    c.registry["live"] = LiveCall(uuid="live", state="answered")
    c._last_prune = 0.0
    c._prune_if_due()
    assert "dead" not in c.registry
    assert "live" in c.registry


# --------------------------------------------------------------------------
# 2. event-confirmation waiter
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_wait_for_event_resolves_on_match():
    c = ESLClient(host="h", password="p")
    task = asyncio.create_task(c.wait_for_event(
        lambda e: e.get("Event-Name") == "CHANNEL_ANSWER" and e.get("Unique-ID") == "u1",
        timeout=2.0,
    ))
    await asyncio.sleep(0)  # let the waiter register
    c._handle_event_block(make_event({"Event-Name": "CHANNEL_ANSWER", "Unique-ID": "u1"}))
    ev = await task
    assert ev is not None and ev["Unique-ID"] == "u1"
    assert c._waiters == []  # cleaned up


@pytest.mark.asyncio
async def test_wait_for_event_times_out():
    c = ESLClient(host="h", password="p")
    ev = await c.wait_for_event(lambda e: False, timeout=0.1)
    assert ev is None
    assert c._waiters == []


# --------------------------------------------------------------------------
# 3. event-confirmed live modification (hangup) over a faked command channel
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_hangup_confirmed_via_event():
    c = ESLClient(host="h", password="p")
    c._connected = True
    esl._client = c

    async def fake_api(cmd):
        assert cmd.startswith("uuid_kill u1")
        # let the waiter register, then emit the confirming event
        await asyncio.sleep(0)
        c._handle_event_block(make_event({
            "Event-Name": "CHANNEL_HANGUP", "Unique-ID": "u1",
            "Hangup-Cause": "NORMAL_CLEARING",
        }))
        return "+OK"

    c.api = fake_api  # type: ignore[assignment]
    result = await esl.hangup_call_confirmed("u1", timeout=2.0)
    assert result["ok"] is True
    assert result["confirmed"] is True
    assert result["hangup_cause"] == "NORMAL_CLEARING"


@pytest.mark.asyncio
async def test_hangup_unconfirmed_when_no_event():
    c = ESLClient(host="h", password="p")
    c._connected = True
    esl._client = c

    async def fake_api(cmd):
        return "+OK"  # command accepted but no event arrives

    c.api = fake_api  # type: ignore[assignment]
    result = await esl.hangup_call_confirmed("ughost", timeout=0.2)
    assert result["ok"] is True
    assert result["confirmed"] is False  # never observed CHANNEL_HANGUP


# --------------------------------------------------------------------------
# 4. graceful degradation while disconnected / unconfigured
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_api_returns_none_when_disconnected():
    c = ESLClient(host="h", password="p")
    assert c.connected is False
    assert await c.api("status") is None


@pytest.mark.asyncio
async def test_command_wrappers_degrade_gracefully():
    c = ESLClient(host="h", password="p")  # not connected
    esl._client = c
    assert await esl.hangup_call("u1") is False
    assert await esl.transfer_call("u1", "+15551234567") is False
    assert await esl.send_dtmf("u1", "1234") is False
    assert await esl.originate_call("u1", "+15550001111", "+15552223333", 1) is False
    status = await esl.get_call_status("nope")
    assert status["state"] == "not_found"


def test_configured_flag():
    assert ESLClient(host="h", password="p").configured() is True
    assert ESLClient(host="", password="p").configured() is False
    assert ESLClient(host="h", password=None).configured() is False


@pytest.mark.asyncio
async def test_start_unconfigured_never_crashes():
    c = ESLClient(host="", password=None)
    c.start()
    await asyncio.sleep(0)
    assert c.configured() is False
    assert c.connected is False
    h = c.health()
    assert h["connected"] is False and h["configured"] is False
    await c.stop()


@pytest.mark.asyncio
async def test_get_call_status_reads_registry_first():
    c = ESLClient(host="h", password="p")
    esl._client = c
    c._handle_event_block(make_event({
        "Event-Name": "CHANNEL_ANSWER", "Unique-ID": "u1",
    }))
    status = await esl.get_call_status("u1")
    assert status["source"] == "registry"
    assert status["state"] == "answered"


# --------------------------------------------------------------------------
# 5. reconnect / exponential-backoff supervisor logic
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_supervisor_backoff_is_exponential(monkeypatch):
    c = ESLClient(host="h", password="p")
    attempts = {"n": 0}
    sleeps: list[float] = []

    async def failing_connect():
        attempts["n"] += 1
        raise ConnectionError("refused")

    async def fake_sleep(d):
        sleeps.append(d)
        if len(sleeps) >= 4:
            c._stopping = True
        # return immediately; do NOT call real sleep (avoid recursion)

    monkeypatch.setattr(c, "_connect_and_serve", failing_connect)
    monkeypatch.setattr(esl.asyncio, "sleep", fake_sleep)

    await c._supervise()

    assert attempts["n"] >= 4
    # 1, 2, 4, 8 ... doubling, capped at _BACKOFF_MAX
    assert sleeps[0] == esl._BACKOFF_MIN
    assert sleeps[1] == esl._BACKOFF_MIN * 2
    assert sleeps[2] == esl._BACKOFF_MIN * 4
    assert all(s <= esl._BACKOFF_MAX for s in sleeps)
    assert c.reconnects >= 3


@pytest.mark.asyncio
async def test_disconnect_fails_inflight_commands():
    """When the connection drops, any in-flight command future must be failed so
    callers don't hang forever."""
    c = ESLClient(host="h", password="p")
    c._connected = True
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    c._pending.append(fut)
    c._mark_disconnected()
    assert fut.done()
    with pytest.raises(ConnectionError):
        fut.result()
    assert c.connected is False
