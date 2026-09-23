"""API feature flags (env-driven, read LIVE — never cached at import).

Single home for product on/off switches. Each helper re-reads the environment
on every call so a test (``monkeypatch.setenv``) or a container restart with a
new ``.env`` takes effect without code changes.

API_CALLING_ENABLED
    The "API Calling" product (account_type ``api``: ``/v1/calls`` originate,
    API CPS tiers, per-call API tier fees, API DID assignment, API product
    intake) was RETIRED 2026-09. The code is KEPT but switched OFF. The product
    is ON only when the env var is exactly ``true`` (case-insensitive, surrounding
    whitespace ignored); unset / empty / anything else (``1``, ``yes``, ``on``)
    is OFF. RCF and SIP Trunking never consult this flag.

    Mirrors the FreeSWITCH env var of the same name and the UI constant
    ``docker/ui/app/src/config/features.ts::API_CALLING_ENABLED`` — to restore
    the product, flip all three.

CDR_B_LEG_ROWS
    CDR A/B leg split (docs/CDR_LEG_SPLIT_CONTRACT.md). When ON, a carrier
    B-leg CDR (``cdr_leg=B`` + ``cdr_carrier_leg=true``) posted by
    mod_json_cdr (``log-b-leg=true``, the per-zone FS cutover switch) is
    INSERTed as its own ``leg='B'`` row. ON unless the env var is exactly
    ``false`` (case-insensitive, surrounding whitespace ignored) — owner
    decision 2026-09-23: the split ships ON. OFF = B-legs never insert (they
    only feed the answered-carrier-leg STIR outcome UPDATE), i.e. the
    pre-split behavior.
"""
import os

from fastapi import HTTPException

#: Human-facing reason returned (422 detail) when a retired API-Calling input
#: is rejected. Tests and the UI match on this substring.
API_CALLING_RETIRED_MESSAGE = "API Calling is retired"


def api_calling_enabled() -> bool:
    """True only when ``API_CALLING_ENABLED`` is exactly "true" (trimmed, any case)."""
    return os.getenv("API_CALLING_ENABLED", "").strip().lower() == "true"


def require_api_calling_enabled() -> None:
    """FastAPI dependency: 404 (indistinguishable from an unmounted route) when OFF.

    Defense in depth for routers that main.py already declines to mount while
    the product is retired — a test app or a future re-mount cannot re-expose
    the endpoint without the flag.
    """
    if not api_calling_enabled():
        raise HTTPException(status_code=404, detail="Not Found")


def cdr_b_leg_rows_enabled() -> bool:
    """True unless ``CDR_B_LEG_ROWS`` is exactly "false" (trimmed, any case)."""
    return os.getenv("CDR_B_LEG_ROWS", "").strip().lower() != "false"
