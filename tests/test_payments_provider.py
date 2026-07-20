"""Payments Wave 1 — provider abstraction + billing tenant-isolation tests.

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §3, §6.

Pure/offline (no DB, no network, no processor) — mirrors tests/ai/test_ai_providers.py:
  * The provider factory resolves the safe NoopProvider in Wave 1, and every
    money-moving method REFUSES (raises ProviderDisabledError) — a no-op that
    silently "succeeded" would corrupt the ledger, so refusal is the contract.
  * The abstract PaymentProvider interface exposes exactly the four rails-seam
    methods (create_setup / charge / refund / verify_and_parse_webhook).
  * The billing router's tenant-isolation resolver enforces the multi-tenant
    rule: a non-admin is forced to their own customer (cross-tenant → 404, not
    leaked); an admin must name a customer.

Run:  python3 -m pytest tests/test_payments_provider.py -q
"""
import sys
from decimal import Decimal
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))

from services import payments  # noqa: E402
from services.payments import (  # noqa: E402
    NoopProvider,
    PaymentProvider,
    ProviderDisabledError,
    get_payment_provider,
    set_payment_provider,
)


@pytest.fixture(autouse=True)
def _reset_provider_singleton(monkeypatch):
    """Reset the provider singleton + strip PAYMENT_PROVIDER/PAYMENTS_DEMO_MODE so
    each test is deterministic.

    These tests assert the NON-demo default (the factory resolves NoopProvider).
    PAYMENTS_DEMO_MODE is stripped so they pass even when the demo walkthrough
    (tests/test_payments_demo.py) has exported it into the environment — the two
    suites must coexist regardless of run order/env."""
    monkeypatch.delenv("PAYMENT_PROVIDER", raising=False)
    monkeypatch.delenv("PAYMENTS_DEMO_MODE", raising=False)
    set_payment_provider(None)
    yield
    set_payment_provider(None)


# ---------------------------------------------------------------------------
# Provider factory — Wave 1 resolves the no-op; it is disabled.
# ---------------------------------------------------------------------------
def test_factory_default_is_noop_and_disabled():
    p = get_payment_provider()
    assert isinstance(p, NoopProvider)
    assert p.enabled is False
    assert p.name == "noop"


def test_factory_is_singleton():
    assert get_payment_provider() is get_payment_provider()


def test_unknown_backend_still_resolves_noop():
    # Wave 1 has no live rail — any PAYMENT_PROVIDER value degrades to the no-op
    # (a missing processor must never crash the app or move money).
    import os
    os.environ["PAYMENT_PROVIDER"] = "stripe"
    try:
        set_payment_provider(None)
        assert isinstance(get_payment_provider(), NoopProvider)
    finally:
        os.environ.pop("PAYMENT_PROVIDER", None)


def test_set_provider_override_and_reset():
    class _Fake(PaymentProvider):
        name = "fake"
        enabled = True
    set_payment_provider(_Fake())
    assert get_payment_provider().name == "fake"
    set_payment_provider(None)
    assert isinstance(get_payment_provider(), NoopProvider)


# ---------------------------------------------------------------------------
# NoopProvider — every money operation refuses (loudly, not silently).
# ---------------------------------------------------------------------------
def _run(coro):
    import asyncio
    return asyncio.run(coro)


def test_noop_create_setup_refuses():
    with pytest.raises(ProviderDisabledError):
        _run(NoopProvider().create_setup(customer_id=1))


def test_noop_charge_refuses():
    with pytest.raises(ProviderDisabledError):
        _run(NoopProvider().charge(customer_id=1, amount=Decimal("5"),
                                   idempotency_key="k"))


def test_noop_refund_refuses():
    with pytest.raises(ProviderDisabledError):
        _run(NoopProvider().refund(provider_ref="pi_x", idempotency_key="k"))


def test_noop_webhook_refuses():
    with pytest.raises(ProviderDisabledError):
        _run(NoopProvider().verify_and_parse_webhook(headers={}, body=b""))


def test_provider_disabled_is_a_payment_error():
    from services.payments import PaymentError
    assert issubclass(ProviderDisabledError, PaymentError)


# ---------------------------------------------------------------------------
# Interface shape — the four rails-seam methods exist and are async.
# ---------------------------------------------------------------------------
def test_interface_exposes_rails_seam_methods():
    import inspect
    for m in ("create_setup", "charge", "refund", "verify_and_parse_webhook"):
        assert hasattr(PaymentProvider, m)
        assert inspect.iscoroutinefunction(getattr(PaymentProvider, m))


def test_package_reexports_normalized_types():
    # The seam types the webhook ingress (later wave) depends on are exported.
    for name in ("SetupResult", "ChargeResult", "NormalizedEvent", "PaymentProvider",
                 "NoopProvider", "PaymentError", "ProviderDisabledError"):
        assert hasattr(payments, name), name


# ---------------------------------------------------------------------------
# Billing router — tenant-isolation resolver (multi-tenant authz).
# ---------------------------------------------------------------------------
def _billing():
    # Import lazily so a missing FastAPI doesn't break provider tests.
    from routers import billing
    return billing


def test_billing_nonadmin_forced_to_own_customer():
    b = _billing()
    # Non-admin (filter=7); no explicit id → own.
    assert b._resolve_customer_id(7, None) == 7
    # Non-admin asking for own id → own.
    assert b._resolve_customer_id(7, 7) == 7


def test_billing_nonadmin_cross_tenant_404():
    from fastapi import HTTPException
    b = _billing()
    with pytest.raises(HTTPException) as ei:
        b._resolve_customer_id(7, 8)  # asking for someone else
    assert ei.value.status_code == 404  # existence not leaked (not 403)


def test_billing_admin_must_name_customer():
    from fastapi import HTTPException
    b = _billing()
    # Admin (filter=None) with an explicit id → that id.
    assert b._resolve_customer_id(None, 42) == 42
    # Admin with no id → 400 (no all-tenants view here).
    with pytest.raises(HTTPException) as ei:
        b._resolve_customer_id(None, None)
    assert ei.value.status_code == 400
