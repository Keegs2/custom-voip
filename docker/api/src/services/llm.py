"""Pluggable LLM provider for the in-boundary AI voice-agent runtime.

ONE OpenAI-compatible streaming client (``httpx``, no vendor SDK) that talks to
whatever the agent config's ``base_url`` points at:

  * a **self-hosted vLLM / Ollama / llama.cpp / TGI** OpenAI-compatible endpoint
    (the compliance default — the model runs INSIDE the customer's boundary and
    no prompt/PHI/CPNI leaves the VPC), OR
  * OpenAI / Azure OpenAI (explicit opt-in via a cloud ``base_url`` + key).

The wire format is the OpenAI Chat Completions API with ``stream=true`` and
tool/function calling — the de-facto standard every self-hosted server implements
— so swapping the endpoint is a config change, never a code change.

Design goals: stream tokens (low latency to first audio), support tool calls
(the LLM drives real call actions in ai_agent), and NEVER hang the call —
per-request timeouts + graceful error surfacing so the orchestrator can fall back.
"""
from __future__ import annotations

import os
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional

import httpx

logger = logging.getLogger(__name__)


@dataclass
class ToolCall:
    """An assembled tool/function call the model asked for."""
    id: str
    name: str
    arguments: str  # raw JSON string (parsed by the caller with error handling)


@dataclass
class LLMDelta:
    """One streamed step. ``text`` is an incremental token chunk (may be '').
    ``finish_reason`` and ``tool_calls`` are only set on the final delta."""
    text: str = ""
    finish_reason: Optional[str] = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    # Token usage, when the server reports it (self-hosted servers often do via
    # stream_options.include_usage). Drives ai_agent_sessions cost inputs.
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None


class LLMProvider(ABC):
    """Vendor-agnostic streaming chat interface."""
    self_hosted: bool = True
    name: str = "base"
    model: str = ""

    @abstractmethod
    def stream_chat(
        self,
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        temperature: float = 0.4,
        max_tokens: int = 512,
    ) -> AsyncIterator[LLMDelta]:  # pragma: no cover - interface
        ...


class OpenAICompatLLM(LLMProvider):
    """OpenAI-compatible Chat Completions streaming client.

    ``base_url`` should include the API root (e.g. ``http://vllm:8000/v1`` or
    ``https://api.openai.com/v1``). ``api_key`` is optional for self-hosted
    servers; when the endpoint is Azure, pass ``azure=True`` + ``api_version``.
    """
    name = "openai_compat"

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
        self_hosted: bool = True,
        azure: bool = False,
        api_version: str = "2024-02-15-preview",
        extra_headers: Optional[dict] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.self_hosted = self_hosted
        self.azure = azure
        self.api_version = api_version
        self.extra_headers = extra_headers or {}

    def _endpoint_and_headers(self) -> tuple[str, dict, dict]:
        headers = {"Content-Type": "application/json"}
        headers.update(self.extra_headers)
        params: dict = {}
        if self.azure:
            # Azure: {base}/openai/deployments/{model}/chat/completions?api-version=...
            url = f"{self.base_url}/openai/deployments/{self.model}/chat/completions"
            params["api-version"] = self.api_version
            if self.api_key:
                headers["api-key"] = self.api_key
        else:
            url = f"{self.base_url}/chat/completions"
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
        return url, headers, params

    async def stream_chat(
        self,
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        temperature: float = 0.4,
        max_tokens: int = 512,
    ) -> AsyncIterator[LLMDelta]:
        url, headers, params = self._endpoint_and_headers()
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
            # Ask servers that support it to report usage on the final chunk.
            "stream_options": {"include_usage": True},
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        # Accumulators for streamed tool_call fragments (keyed by choice index).
        tool_acc: dict[int, dict] = {}
        finish_reason: Optional[str] = None
        prompt_tokens: Optional[int] = None
        completion_tokens: Optional[int] = None

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                async with client.stream(
                    "POST", url, headers=headers, params=params, json=payload
                ) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode("utf-8", "replace")
                        logger.warning(
                            "LLM[%s] HTTP %d: %s", self.model, resp.status_code, body[:300]
                        )
                        raise LLMError(f"LLM HTTP {resp.status_code}")
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        data = line[len("data:"):].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = _loads(data)
                        except Exception:
                            continue
                        # Usage may arrive on a chunk with empty choices.
                        usage = chunk.get("usage")
                        if isinstance(usage, dict):
                            prompt_tokens = usage.get("prompt_tokens", prompt_tokens)
                            completion_tokens = usage.get(
                                "completion_tokens", completion_tokens
                            )
                        for choice in chunk.get("choices", []) or []:
                            delta = choice.get("delta", {}) or {}
                            if choice.get("finish_reason"):
                                finish_reason = choice["finish_reason"]
                            # Text token(s).
                            content = delta.get("content")
                            if content:
                                yield LLMDelta(text=content)
                            # Streamed tool-call fragments.
                            for tc in delta.get("tool_calls", []) or []:
                                idx = tc.get("index", 0)
                                acc = tool_acc.setdefault(
                                    idx, {"id": "", "name": "", "arguments": ""}
                                )
                                if tc.get("id"):
                                    acc["id"] = tc["id"]
                                fn = tc.get("function", {}) or {}
                                if fn.get("name"):
                                    acc["name"] = fn["name"]
                                if fn.get("arguments"):
                                    acc["arguments"] += fn["arguments"]
        except LLMError:
            raise
        except (httpx.TimeoutException, httpx.HTTPError) as exc:
            logger.warning("LLM[%s] transport error: %s", self.model, exc)
            raise LLMError(str(exc)) from exc

        # Terminal delta: assembled tool calls + usage.
        calls = [
            ToolCall(id=a["id"] or f"call_{i}", name=a["name"], arguments=a["arguments"])
            for i, a in sorted(tool_acc.items())
            if a["name"]
        ]
        yield LLMDelta(
            text="",
            finish_reason=finish_reason or ("tool_calls" if calls else "stop"),
            tool_calls=calls,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )


class LLMError(Exception):
    """Raised on an LLM transport/HTTP failure so ai_agent can fall back."""


def _loads(data):
    try:
        import orjson
        return orjson.loads(data)
    except Exception:
        import json
        return json.loads(data)


def get_llm_provider(
    provider: Optional[str] = None,
    *,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    timeout: Optional[float] = None,
) -> LLMProvider:
    """Construct the per-agent LLM provider.

    Defaults to an OpenAI-compatible client pointed at ``AI_LLM_BASE_URL`` (a
    self-hosted vLLM/Ollama endpoint out of the box). ``provider='azure'`` selects
    the Azure OpenAI wire quirk; everything else uses the standard path.
    """
    provider = (provider or os.getenv("AI_LLM_PROVIDER", "openai_compat")).lower()
    base_url = base_url or os.getenv("AI_LLM_BASE_URL", "http://127.0.0.1:8001/v1")
    model = model or os.getenv("AI_LLM_MODEL", "gpt-4o-mini")
    api_key = api_key or os.getenv("AI_LLM_API_KEY") or None
    if timeout is None:
        try:
            timeout = float(os.getenv("AI_LLM_TIMEOUT", "30"))
        except ValueError:
            timeout = 30.0

    self_hosted = _looks_internal(base_url)
    azure = provider in ("azure", "azure_openai")
    return OpenAICompatLLM(
        base_url=base_url,
        model=model,
        api_key=api_key,
        timeout=timeout,
        self_hosted=self_hosted and not azure,
        azure=azure,
        api_version=os.getenv("AI_LLM_AZURE_API_VERSION", "2024-02-15-preview"),
    )


def _looks_internal(url: str) -> bool:
    """Best-effort: does this base_url stay in the VPC (localhost/RFC1918/*.local/
    bare service name)? Drives the compliance ("no data leaves") signal."""
    import re

    host = re.sub(r"^\w+://", "", url or "").split("/", 1)[0].split(":", 1)[0].lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    if host.endswith(".local") or host.endswith(".internal") or host.endswith(".svc"):
        return True
    if "." not in host:
        return True
    if re.match(r"^10\.", host) or re.match(r"^192\.168\.", host):
        return True
    if re.match(r"^172\.(1[6-9]|2\d|3[01])\.", host):
        return True
    return False
