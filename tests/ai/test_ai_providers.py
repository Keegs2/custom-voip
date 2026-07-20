"""Unit tests for the AI voice-agent provider selection + audio DSP + compliance
signal. Pure/offline: no DB, no network, no FreeSWITCH — mirrors the import
pattern of tests/test_esl_consumer.py.

The point of these tests: prove the COMPLIANCE-DEFAULT wiring is real — an agent
with no explicit config resolves to SELF-HOSTED STT/LLM/TTS (nothing leaves the
VPC), cloud providers are an explicit opt-in, and a missing cloud key degrades
safely instead of forcing egress or crashing a call.

Run:  python3 -m pytest tests/ai/test_ai_providers.py -q
"""
import sys
import base64
from pathlib import Path

import pytest
import orjson

REPO = Path(__file__).resolve().parents[2]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))

from services import ai_audio  # noqa: E402
from services import stt as stt_mod  # noqa: E402
from services import llm as llm_mod  # noqa: E402
from services import tts as tts_mod  # noqa: E402
from services import ai_config  # noqa: E402
from services.ai_config import AgentConfig  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Strip AI_* / provider-key env so factory defaults are deterministic."""
    import os
    for k in list(os.environ):
        if k.startswith("AI_") or k in (
            "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY",
            "INGEST_SHARED_SECRET", "WEBHOOK_ALLOW_HTTP",
        ):
            monkeypatch.delenv(k, raising=False)
    yield


# ---------------------------------------------------------------------------
# STT provider selection (self-hosted default; cloud opt-in; safe fallback)
# ---------------------------------------------------------------------------
def test_stt_default_is_self_hosted_whisper():
    p = stt_mod.get_stt_provider()
    assert isinstance(p, stt_mod.WhisperHTTPProvider)
    assert p.mode == stt_mod.STT_MODE_BATCHED
    assert p.self_hosted is True  # default base_url is localhost


def test_stt_deepgram_requires_key_else_falls_back_to_noop():
    # No key -> must NOT silently pick a cloud provider; degrade to Noop.
    p = stt_mod.get_stt_provider("deepgram")
    assert isinstance(p, stt_mod.NoopSTTProvider)


def test_stt_deepgram_with_key_is_streaming_cloud(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg_secret_key")
    p = stt_mod.get_stt_provider("deepgram")
    assert isinstance(p, stt_mod.DeepgramSTTProvider)
    assert p.mode == stt_mod.STT_MODE_STREAMING
    assert p.self_hosted is False  # cloud egress


def test_stt_unknown_provider_falls_back_to_noop():
    assert isinstance(stt_mod.get_stt_provider("does_not_exist"), stt_mod.NoopSTTProvider)


def test_stt_whisper_public_base_url_flags_egress():
    p = stt_mod.get_stt_provider("whisper_http", base_url="https://api.vendor.com/v1")
    assert isinstance(p, stt_mod.WhisperHTTPProvider)
    assert p.self_hosted is False  # public host => data leaves the VPC


# ---------------------------------------------------------------------------
# LLM provider selection
# ---------------------------------------------------------------------------
def test_llm_default_openai_compat_self_hosted():
    p = llm_mod.get_llm_provider()
    assert isinstance(p, llm_mod.OpenAICompatLLM)
    assert p.self_hosted is True  # default base_url is 127.0.0.1


def test_llm_public_base_url_is_not_self_hosted():
    p = llm_mod.get_llm_provider(base_url="https://api.openai.com/v1", model="gpt-4o-mini")
    assert p.self_hosted is False


def test_llm_azure_wire_selected():
    p = llm_mod.get_llm_provider("azure", base_url="https://my.openai.azure.com",
                                 model="gpt-4o")
    assert isinstance(p, llm_mod.OpenAICompatLLM)
    assert p.azure is True
    assert p.self_hosted is False


# ---------------------------------------------------------------------------
# TTS provider selection
# ---------------------------------------------------------------------------
def test_tts_default_http_self_hosted():
    p = tts_mod.get_tts_provider()
    assert isinstance(p, tts_mod.HTTPTTSProvider)
    assert p.self_hosted is True


def test_tts_openai_without_key_degrades_to_self_hosted():
    p = tts_mod.get_tts_provider("openai")
    assert isinstance(p, tts_mod.HTTPTTSProvider)  # fell back, no egress
    assert p.self_hosted is True


def test_tts_openai_with_key_is_cloud(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    p = tts_mod.get_tts_provider("openai")
    assert isinstance(p, tts_mod.OpenAITTSProvider)
    assert p.self_hosted is False


# ---------------------------------------------------------------------------
# _looks_internal (compliance boundary heuristic)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("url,internal", [
    ("http://127.0.0.1:9000", True),
    ("http://localhost:8001/v1", True),
    ("http://whisper:9000", True),            # bare compose service name
    ("http://10.142.0.5:8000/v1", True),
    ("http://192.168.10.2:8002", True),
    ("http://172.16.3.4:9000", True),
    ("https://api.openai.com/v1", False),
    ("https://api.deepgram.com", False),
    ("http://8.8.8.8:9000", False),
])
def test_looks_internal(url, internal):
    assert stt_mod._looks_internal(url) is internal
    assert llm_mod._looks_internal(url) is internal
    assert tts_mod._looks_internal(url) is internal


# ---------------------------------------------------------------------------
# Compliance signal: data_stays_in_vpc across the provider bundle
# ---------------------------------------------------------------------------
def test_bundle_all_self_hosted_stays_in_vpc():
    cfg = AgentConfig(id=1, customer_id=1, name="a")  # all defaults => self-hosted
    bundle = ai_config.build_providers(cfg)
    assert bundle.data_stays_in_vpc is True


def test_bundle_one_cloud_provider_breaks_vpc_guarantee(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    cfg = AgentConfig(
        id=1, customer_id=1, name="a",
        tts_provider="openai",  # cloud egress
    )
    bundle = ai_config.build_providers(cfg)
    assert bundle.data_stays_in_vpc is False


# ---------------------------------------------------------------------------
# Secret handling: *_api_key_ref is an ALLOW-LISTED ENV NAME, resolved at runtime
# ---------------------------------------------------------------------------
def test_resolve_key_from_allowlisted_ai_env(monkeypatch):
    # An AI_(LLM|STT|TTS)_* env NAME is allow-listed and resolves to the key.
    monkeypatch.setenv("AI_LLM_MY_KEY", "actual-secret-value")
    assert AgentConfig._resolve_key("AI_LLM_MY_KEY") == "actual-secret-value"


def test_resolve_key_from_known_provider_env(monkeypatch):
    # The four well-known cloud-provider key NAMEs are allow-listed too.
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    assert AgentConfig._resolve_key("OPENAI_API_KEY") == "sk-secret"


def test_resolve_key_missing_returns_none():
    assert AgentConfig._resolve_key("AI_LLM_NOT_SET_XYZ") is None
    assert AgentConfig._resolve_key(None) is None


def test_resolve_key_rejects_arbitrary_env_names(monkeypatch):
    """CRITICAL-1: a tenant-supplied *_api_key_ref must NEVER resolve an arbitrary
    platform secret env var. Even when the env var is SET, a non-allow-listed NAME
    resolves to None (no key attached) so the secret can't be exfiltrated as a
    Bearer header to a tenant-controlled base_url."""
    for name in (
        "JWT_SECRET_KEY", "DATABASE_URL", "ENVELOPE_LOCAL_KEK",
        "INGEST_SHARED_SECRET", "FREESWITCH_ESL_PASSWORD",
        "BANDWIDTH_API_CLIENT_SECRET",
    ):
        monkeypatch.setenv(name, "super-secret-value")
        assert AgentConfig._resolve_key(name) is None, name


def test_resolve_key_inline_literal_still_accepted():
    # A tenant inlining its OWN literal key (not an env NAME) stays harmless.
    assert (
        AgentConfig._resolve_key("sk-proj-abcdef0123456789")
        == "sk-proj-abcdef0123456789"
    )


# ---------------------------------------------------------------------------
# Tool schema assembly
# ---------------------------------------------------------------------------
def test_builtin_tools_always_present():
    cfg = AgentConfig(id=1, customer_id=1, name="a")
    names = {t["function"]["name"] for t in ai_config.build_tool_schema(cfg)}
    assert {ai_config.BUILTIN_TRANSFER, ai_config.BUILTIN_DTMF,
            ai_config.BUILTIN_HANGUP, ai_config.BUILTIN_CAPTURE} <= names


def test_custom_tools_merged_and_http_extracted():
    cfg = AgentConfig(
        id=1, customer_id=1, name="a",
        tools=[
            {"name": "lookup_account",
             "description": "look up an account",
             "parameters": {"type": "object", "properties": {"id": {"type": "string"}}},
             "http": {"method": "POST", "url": "https://crm.internal/lookup"}},
        ],
    )
    schema = ai_config.build_tool_schema(cfg)
    names = {t["function"]["name"] for t in schema}
    assert "lookup_account" in names
    # The http block must NOT leak into what the model sees.
    tool = next(t for t in schema if t["function"]["name"] == "lookup_account")
    assert "http" not in tool["function"]
    # But it IS available to the runtime executor.
    m = ai_config.custom_tool_map(cfg)
    assert m["lookup_account"]["http"]["url"] == "https://crm.internal/lookup"


# ---------------------------------------------------------------------------
# Audio DSP + mod_audio_stream framing
# ---------------------------------------------------------------------------
def _pcm(amplitude: int, ms: int, rate: int = 8000) -> bytes:
    import array
    n = int(rate * ms / 1000)
    return array.array("h", [amplitude] * n).tobytes()


def test_rms_silence_vs_loud():
    assert ai_audio.pcm16_rms(_pcm(0, 20)) < 10
    assert ai_audio.pcm16_rms(_pcm(8000, 20)) > 500


def test_resample_changes_length_by_ratio():
    pcm8k = _pcm(1000, 100, rate=8000)          # 800 samples
    up = ai_audio.resample_pcm16(pcm8k, 8000, 16000)
    assert abs(len(up) - len(pcm8k) * 2) <= 4    # ~1600 samples
    same = ai_audio.resample_pcm16(pcm8k, 8000, 8000)
    assert same == pcm8k                          # no-op when rates match


def test_encode_stream_audio_matches_mod_audio_stream_contract():
    pcm = _pcm(1234, 20)
    frame = orjson.loads(ai_audio.encode_stream_audio(pcm, 8000))
    assert frame["type"] == "streamAudio"
    assert frame["data"]["audioDataType"] == "raw"
    assert frame["data"]["sampleRate"] == 8000
    assert base64.b64decode(frame["data"]["audioData"]) == pcm


def test_vad_segments_an_utterance():
    vad = ai_audio.EnergyVAD(ai_audio.VADConfig(sample_rate=8000, rms_threshold=500,
                                                min_speech_ms=200, silence_ms=700))
    events = []
    # 300ms of speech...
    for _ in range(15):
        ev = vad.process(_pcm(8000, 20))
        if ev:
            events.append(ev)
    # ...then 800ms of silence.
    for _ in range(40):
        ev = vad.process(_pcm(0, 20))
        if ev:
            events.append(ev)
    assert ai_audio.VAD_SPEECH_START in events
    assert ai_audio.VAD_SPEECH_END in events
    assert events.index(ai_audio.VAD_SPEECH_START) < events.index(ai_audio.VAD_SPEECH_END)


def test_wav_roundtrip():
    pcm = _pcm(2000, 50, rate=16000)
    wav = ai_audio.pcm16_to_wav(pcm, 16000)
    out, rate = ai_audio.wav_to_pcm16(wav)
    assert rate == 16000
    assert out == pcm


# ---------------------------------------------------------------------------
# WS URL / TwiML contract (single source of truth)
# ---------------------------------------------------------------------------
def test_build_stream_ws_url_contract():
    url = ai_config.build_stream_ws_url(7, "call-xyz", 42,
                                        public_base="ws://svc:8000", include_secret=False)
    assert url.startswith("ws://svc:8000/ws/ai-agent?")
    assert "agent_id=7" in url and "call_uuid=call-xyz" in url and "customer_id=42" in url


def test_connect_twiml_is_well_formed():
    xml = ai_config.connect_twiml(7, "{{CallSid}}", 42, public_base="ws://svc:8000")
    assert xml.startswith("<Response><Connect><Stream url=")
    assert xml.endswith("/></Connect></Response>")
    assert "&amp;" in xml  # query separators escaped for XML
