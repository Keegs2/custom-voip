"""SIPp load testing endpoints (admin only).

This router provides a preset list and a run endpoint for SIPp load tests.
The actual SIPp runner service is not yet deployed, so POST /run returns a
mock result or 503 depending on configuration.
"""
import logging
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from typing import Optional

from auth.dependencies import require_admin

router = APIRouter()
logger = logging.getLogger(__name__)

# Set to the SIPp runner service URL when available (e.g., "http://sipp:8001")
SIPP_SERVICE_URL = os.getenv("SIPP_SERVICE_URL", "")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class SippRunConfig(BaseModel):
    preset_id: Optional[int] = None
    remote_host: str
    remote_port: int = 5060
    call_rate: int = 1
    call_limit: int = 10
    duration_seconds: Optional[int] = None
    scenario: Optional[str] = None
    extra_args: Optional[str] = None

    @field_validator("remote_host")
    @classmethod
    def validate_host(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("remote_host is required")
        return v

    @field_validator("call_rate")
    @classmethod
    def validate_call_rate(cls, v: int) -> int:
        if v < 1 or v > 1000:
            raise ValueError("call_rate must be between 1 and 1000")
        return v

    @field_validator("call_limit")
    @classmethod
    def validate_call_limit(cls, v: int) -> int:
        if v < 1 or v > 100000:
            raise ValueError("call_limit must be between 1 and 100000")
        return v


# ---------------------------------------------------------------------------
# Hardcoded presets
# ---------------------------------------------------------------------------

PRESETS = [
    {
        "id": 1,
        "name": "Registration Test",
        "description": "Send SIP REGISTER requests to verify registration handling. "
                       "Low rate, useful for verifying auth and connectivity.",
        "defaults": {
            "call_rate": 1,
            "call_limit": 10,
            "duration_seconds": 30,
            "scenario": "register",
        },
    },
    {
        "id": 2,
        "name": "Basic Call Test",
        "description": "Place a small number of calls to verify INVITE/BYE flow. "
                       "Each call lasts ~10 seconds with proper RTP.",
        "defaults": {
            "call_rate": 1,
            "call_limit": 5,
            "duration_seconds": 60,
            "scenario": "uac",
        },
    },
    {
        "id": 3,
        "name": "CPS Stress Test",
        "description": "Ramp up call setup rate to test CPS handling and throttling. "
                       "Useful for validating CPS tier enforcement.",
        "defaults": {
            "call_rate": 10,
            "call_limit": 100,
            "duration_seconds": 30,
            "scenario": "uac_short",
        },
    },
    {
        "id": 4,
        "name": "Concurrent Call Load",
        "description": "Establish many concurrent calls to test call path capacity. "
                       "Calls are held open for the full duration.",
        "defaults": {
            "call_rate": 5,
            "call_limit": 50,
            "duration_seconds": 120,
            "scenario": "uac_long",
        },
    },
    {
        "id": 5,
        "name": "404 Rejection Test",
        "description": "Send INVITEs to non-existent destinations to verify proper "
                       "404 handling and that rejected calls are logged correctly.",
        "defaults": {
            "call_rate": 5,
            "call_limit": 20,
            "duration_seconds": 30,
            "scenario": "uac_404",
        },
    },
    {
        "id": 6,
        "name": "OPTIONS Ping",
        "description": "Send SIP OPTIONS requests for keepalive / availability testing. "
                       "Lightweight, no call setup.",
        "defaults": {
            "call_rate": 10,
            "call_limit": 100,
            "duration_seconds": 30,
            "scenario": "options",
        },
    },
]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/presets")
async def list_presets(admin: dict = Depends(require_admin)):
    """Return the list of predefined SIPp test scenarios."""
    return PRESETS


@router.post("/run")
async def run_sipp(config: SippRunConfig, admin: dict = Depends(require_admin)):
    """Run a SIPp test.

    If a SIPp runner service is configured (SIPP_SERVICE_URL env var), the
    request is forwarded to it. Otherwise a 503 is returned indicating the
    runner is not available.
    """
    if not SIPP_SERVICE_URL:
        raise HTTPException(
            status_code=503,
            detail="SIPp runner not configured. Set SIPP_SERVICE_URL to enable live tests.",
        )

    # When the SIPp runner is available, forward the request to it.
    # For now this is a placeholder -- the runner service is not yet deployed.
    try:
        import httpx

        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                f"{SIPP_SERVICE_URL}/run",
                json=config.model_dump(),
            )
            if resp.status_code == 200:
                return resp.json()
            else:
                raise HTTPException(
                    status_code=resp.status_code,
                    detail=f"SIPp runner returned {resp.status_code}: {resp.text}",
                )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail=f"Cannot reach SIPp runner at {SIPP_SERVICE_URL}",
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="SIPp runner timed out (test may still be running)",
        )
