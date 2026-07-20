"""Payments provider package (Payments Wave 2+ seam).

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §3.

Exposes the vendor-agnostic :class:`PaymentProvider` interface, the normalized
result/event dataclasses, and a process-singleton factory :func:`get_payment_provider`.
Wave 1 resolves ONLY :class:`NoopProvider` (no live rail; every money op refuses)
— the concrete Stripe/x402/MPP providers register here in later waves WITHOUT
touching callers, exactly like the STT/LLM/TTS factories.

DEMO MODE (§9): when ``PAYMENTS_DEMO_MODE=true`` the factory resolves the
SIMULATION rails (``services.payments.demo_providers.Demo{Stripe,X402,Mpp}Provider``)
instead of the no-op, so the exec demo drives the REAL ledger through fake
processors with no live account and no real money. Flip the flag off (and supply
real keys) to swap in the live rails — the callers never change.
"""
import logging
import os
from typing import Optional

from .provider import (
    ChargeResult,
    NoopProvider,
    NormalizedEvent,
    PaymentError,
    PaymentProvider,
    ProviderDisabledError,
    SetupResult,
)

logger = logging.getLogger(__name__)

__all__ = [
    "PaymentProvider",
    "NoopProvider",
    "SetupResult",
    "ChargeResult",
    "NormalizedEvent",
    "PaymentError",
    "ProviderDisabledError",
    "get_payment_provider",
    "set_payment_provider",
    "demo_mode_enabled",
    "get_demo_providers",
    "set_demo_providers",
]

_provider: Optional[PaymentProvider] = None
_demo_providers = None  # lazily-built services.payments.demo_providers.DemoProviders


def demo_mode_enabled() -> bool:
    """True when PAYMENTS_DEMO_MODE is on (env; default false).

    This is the ONE gate for the exec DEMO (§9). When on, the factory resolves the
    simulation providers (Demo{Stripe,X402,Mpp}Provider) instead of the safe
    no-op, and the /v1/payments demo endpoints become active. Read live (not
    cached) so a test/runtime toggle takes effect without a restart.
    """
    return os.getenv("PAYMENTS_DEMO_MODE", "false").strip().lower() in ("1", "true", "yes", "on")


def get_demo_providers():
    """Return the bundle of three simulation rails (built once, process singleton).

    Only meaningful in demo mode; the payments router reaches for ``.stripe`` /
    ``.x402`` / ``.mpp`` directly on the metered/agent endpoints. Kept separate
    from :func:`get_payment_provider` (which returns the default Rail-A provider)
    so the machine rails are addressable without changing the generic seam.
    """
    global _demo_providers
    if _demo_providers is None:
        from .demo_providers import DemoProviders
        _demo_providers = DemoProviders.build()
        logger.info("payments DEMO providers built (stripe/x402/mpp simulation rails)")
    return _demo_providers


def set_demo_providers(bundle) -> None:
    """Override the demo-provider bundle (test seam). Pass ``None`` to reset."""
    global _demo_providers
    _demo_providers = bundle


def get_payment_provider() -> PaymentProvider:
    """Return the configured payment provider (process singleton).

    Resolution order:
      * ``PAYMENTS_DEMO_MODE=true`` → the simulation :class:`DemoStripeProvider`
        (Rail A/C — the exec DEMO's load-bearing card rail). The machine rails
        (x402 / MPP) are reached via :func:`get_demo_providers`.
      * else ``PAYMENT_PROVIDER`` selects a live impl — only ``noop`` ships today
        (no live rail approved), so this resolves :class:`NoopProvider`. Later
        waves add ``stripe`` / ``x402`` / ``stripe_mpp`` branches here WITHOUT
        touching callers.
    """
    global _provider
    if _provider is None:
        if demo_mode_enabled():
            _provider = get_demo_providers().stripe
            logger.info(
                "payment provider initialized: DEMO MODE -> %s enabled=%s",
                _provider.__class__.__name__, _provider.enabled,
            )
        else:
            backend = os.getenv("PAYMENT_PROVIDER", "noop").lower()
            # Future: branch on `backend` to construct StripeProvider /
            # X402Provider / StripeMppProvider. No live rail today → safe no-op.
            _provider = NoopProvider()
            logger.info(
                "payment provider initialized: backend=%s impl=%s enabled=%s",
                backend, _provider.__class__.__name__, _provider.enabled,
            )
    return _provider


def set_payment_provider(provider: Optional[PaymentProvider]) -> None:
    """Override the singleton (test seam / runtime wiring). Pass ``None`` to reset."""
    global _provider
    _provider = provider
