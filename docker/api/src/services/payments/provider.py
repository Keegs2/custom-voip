"""Pluggable payment-provider abstraction (Payments Wave 2+ seam).

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §3 "Provider abstraction (Layer 2)".

A thin, vendor-agnostic interface plus a safe no-op default. The concrete rails
plug in LATER without touching callers:
  * ``StripeProvider``     — Rail A (human card + auto-recharge) / Rail C (crypto top-up)
  * ``X402Provider``       — Rail B (crypto-native, USDC-on-Base, CDP facilitator)
  * ``StripeMppProvider``  — Rail B (machine/agent payments, Shared Payment Tokens)

Outside demo mode this ships ONLY :class:`NoopProvider`: every money-moving
method refuses. There is intentionally NO live provider, NO API key, NO network
call, and NO money movement — this file is purely the seam the rails snap into.

Compliance boundary (design §1) lives BEHIND this interface: a real card provider
MUST collect card data only inside a processor-hosted iframe (PCI SAQ-A) and
store only processor tokens; a crypto provider MUST be non-custodial and use a
hosted facilitator. The interface deliberately traffics in tokens/refs and
NormalizedEvents, never a PAN/CVV.

Amounts crossing this boundary are ``decimal.Decimal`` dollars (the internal
ledger unit). A concrete provider converts Decimal dollars <-> the processor's
native unit (e.g. integer cents, USDC 6-decimals) at ITS boundary — never in the
ledger.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Optional

logger = logging.getLogger(__name__)


class PaymentError(Exception):
    """Base class for payment-provider errors (declines, verification failures)."""


class ProviderDisabledError(PaymentError):
    """Raised by :class:`NoopProvider` — no live payment rail is configured.

    Wave 1 has no processor wired, so any attempt to actually move money must
    fail loudly rather than silently no-op (a silent success would corrupt the
    ledger). Callers that want a soft "is a rail available?" check should read
    :pyattr:`PaymentProvider.enabled` instead of catching this.
    """


@dataclass(frozen=True)
class SetupResult:
    """Outcome of :meth:`PaymentProvider.create_setup` (card-on-file intent).

    ``client_secret`` is the processor-hosted-iframe secret the frontend uses to
    collect card data (PCI SAQ-A); we never see the card. ``provider_customer_id``
    is the token (cus_…) we persist on ``payment_methods``.
    """
    provider: str
    client_secret: Optional[str] = None
    provider_customer_id: Optional[str] = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ChargeResult:
    """Outcome of :meth:`PaymentProvider.charge` / :meth:`refund`.

    ``status`` mirrors ``payment_transactions.status`` (pending/succeeded/failed/
    refunded/disputed). ``provider_ref`` is the processor id (pi_…/ch_…/tx hash)
    persisted for reconciliation. ``amount`` is Decimal dollars.
    """
    provider: str
    provider_ref: Optional[str]
    status: str
    amount: Decimal
    currency: str = "USD"
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NormalizedEvent:
    """A processor webhook normalized to a provider-agnostic shape.

    The webhook ingress (a later wave) verifies the signature, dedupes by
    ``event_id`` (idempotent), maps to a ``payment_transactions`` row, and — on a
    succeeded charge/topup — posts a ledger entry. ``amount`` is Decimal dollars.
    """
    provider: str
    event_id: str
    event_type: str
    provider_ref: Optional[str] = None
    customer_ref: Optional[str] = None
    kind: Optional[str] = None            # topup | charge | refund | dispute
    status: Optional[str] = None          # pending | succeeded | failed | refunded | disputed
    amount: Optional[Decimal] = None
    currency: str = "USD"
    raw: dict[str, Any] = field(default_factory=dict)


class PaymentProvider:
    """Vendor-agnostic payment rail interface.

    A concrete provider implements the four money operations. All are async and
    idempotent by the caller-supplied ``idempotency_key`` (the processor also
    dedupes). Methods must NOT touch the ledger directly — the caller/webhook
    ingress owns turning a succeeded operation into a ledger entry, so the ledger
    stays the single source of truth (design §0).
    """

    #: Stable provider slug (matches ``payment_methods.provider`` /
    #: ``payment_transactions.provider`` and the ``ledger_entries.source`` family).
    name: str = "base"

    #: Whether this provider can actually move money. False for the no-op.
    enabled: bool = False

    async def create_setup(
        self,
        *,
        customer_id: int,
        provider_customer_id: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> SetupResult:
        """Begin a card-on-file setup (e.g. Stripe SetupIntent).

        Returns a :class:`SetupResult` whose ``client_secret`` drives the
        processor-hosted iframe (PCI SAQ-A). Never handles raw card data here.
        """
        raise NotImplementedError

    async def charge(
        self,
        *,
        customer_id: int,
        amount: Decimal,
        idempotency_key: str,
        payment_method_ref: Optional[str] = None,
        provider_customer_id: Optional[str] = None,
        currency: str = "USD",
        metadata: Optional[dict] = None,
    ) -> ChargeResult:
        """Charge a stored payment method (top-up). Off-session for auto-recharge.

        ``idempotency_key`` is passed through to the processor so a retried charge
        never double-bills. Returns a :class:`ChargeResult`; the caller records a
        ``payment_transactions`` row and, on success, posts the ``topup`` entry.
        """
        raise NotImplementedError

    async def refund(
        self,
        *,
        provider_ref: str,
        amount: Optional[Decimal] = None,
        idempotency_key: str,
        metadata: Optional[dict] = None,
    ) -> ChargeResult:
        """Refund a prior charge (full when ``amount`` is None, else partial)."""
        raise NotImplementedError

    async def verify_and_parse_webhook(
        self,
        *,
        headers: dict[str, str],
        body: bytes,
    ) -> NormalizedEvent:
        """Verify a webhook's signature and normalize it.

        MUST raise :class:`PaymentError` on an invalid/forged signature (never
        trust an unverified event). On success returns a :class:`NormalizedEvent`
        the ingress dedupes by ``event_id`` and maps into the ledger.
        """
        raise NotImplementedError


class NoopProvider(PaymentProvider):
    """Default provider for Wave 1 — refuses every money operation.

    No processor is configured, so moving money is impossible and any attempt
    fails loudly with :class:`ProviderDisabledError`. This proves the abstraction
    is wired end-to-end (a caller can resolve a provider and inspect ``enabled``)
    WITHOUT any external dependency, key, or network call.
    """

    name = "noop"
    enabled = False

    async def create_setup(self, **kwargs: Any) -> SetupResult:  # noqa: D102
        raise ProviderDisabledError("no payment provider configured (Wave 1 noop): create_setup unavailable")

    async def charge(self, **kwargs: Any) -> ChargeResult:  # noqa: D102
        raise ProviderDisabledError("no payment provider configured (Wave 1 noop): charge unavailable")

    async def refund(self, **kwargs: Any) -> ChargeResult:  # noqa: D102
        raise ProviderDisabledError("no payment provider configured (Wave 1 noop): refund unavailable")

    async def verify_and_parse_webhook(self, **kwargs: Any) -> NormalizedEvent:  # noqa: D102
        raise ProviderDisabledError("no payment provider configured (Wave 1 noop): webhook verification unavailable")
