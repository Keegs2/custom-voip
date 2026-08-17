"""Simulation payment providers — the exec DEMO rails (Payments §9 DEMO MODE).

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §9. These drive the REAL ledger + REAL
rail logic through SIMULATION so execs can see every flow end-to-end with **no
live Stripe/Coinbase account and no real money**. They implement the SAME
:class:`PaymentProvider` interface the live rails will implement, so when real
keys land we swap the provider and NOTHING else changes (§9 "Swap-to-production
path").

Three concrete demo rails, all behind :class:`PaymentProvider`:
  * :class:`DemoStripeProvider` — Rail A/C. Mints realistic ``seti_…``/``pm_…``/
    ``pi_…`` ids, adds realistic ~300ms latency, and supports a CONFIGURABLE
    charge outcome (``success`` | ``insufficient_funds`` | ``authentication_required``)
    so the exec can show the happy path AND the decline→dunning path. Also
    synthesizes a normalized ``payment_intent.succeeded`` / ``payment_failed``
    webhook event.
  * :class:`DemoX402Provider` — Rail B (crypto-native). Simulates the x402 v2
    challenge → verify → settle handshake, mints a fake on-chain tx-hash, and
    speaks USDC 6-decimal minor units at its boundary.
  * :class:`DemoMppProvider` — Rail B (machine/agent). Opens a spend-limited
    session ("tab"), accumulates streamed micro-charges, and settles the tab as
    one ``pi_…`` charge.

None of these touch the ledger directly — exactly like a real provider, the
caller/webhook ingress owns turning a succeeded op into a ledger entry, keeping
the ledger the single source of truth (design §0). Amounts crossing the boundary
are :class:`decimal.Decimal` DOLLARS (the internal ledger unit); each provider
converts dollars <-> its native unit (integer cents, USDC 6-decimals) at ITS
seam, never in the ledger.

Everything here is deterministic-ish and offline: no network, no API key. The
only "realism" side effect is a small ``asyncio.sleep`` to mimic processor
latency; it is env-tunable and can be zeroed for tests.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Optional

from .provider import (
    ChargeResult,
    NormalizedEvent,
    PaymentError,
    PaymentProvider,
    SetupResult,
)

logger = logging.getLogger(__name__)

# --- realism knobs (env-tunable; default to convincing values) --------------
#: Simulated processor round-trip latency in milliseconds (charge/setup/refund).
#: Set PAYMENTS_DEMO_LATENCY_MS=0 in tests to make the walkthrough instant.
_LATENCY_MS = int(os.getenv("PAYMENTS_DEMO_LATENCY_MS", "300"))

#: Card brands the demo mints from, with a plausible display last4. Visa/Amex
#: called out in the brief; a Mastercard is included for variety.
_DEMO_CARD_BRANDS: dict[str, str] = {
    "visa": "4242",
    "amex": "0005",
    "mastercard": "4444",
}

#: The decline reasons the demo can produce, mapped to the normalized failure
#: shape a real Stripe off-session decline returns (design §4 Rail A dunning).
DECLINE_REASONS = frozenset({"insufficient_funds", "authentication_required"})

#: USDC has 6 decimals on-chain; the x402 rail speaks these minor units.
USDC_DECIMALS = 6


async def _simulate_latency(scale: float = 1.0) -> None:
    """Sleep a realistic fraction of the configured processor latency."""
    if _LATENCY_MS > 0:
        await asyncio.sleep((_LATENCY_MS / 1000.0) * scale)


def _rand_token(prefix: str, nbytes: int = 12) -> str:
    """Mint a realistic Stripe-style opaque id, e.g. ``pi_3Q7Xa2Kf...``."""
    # Stripe ids are base62-ish; secrets.token_hex is close enough for a demo and
    # is obviously non-guessable / unique.
    return f"{prefix}_{secrets.token_hex(nbytes)}"


def _to_cents(amount: Decimal) -> int:
    """Dollars -> integer cents at the (would-be) Stripe boundary."""
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _to_usdc_minor(amount: Decimal) -> int:
    """Dollars (1 USD == 1 USDC for the demo) -> USDC 6-decimal minor units."""
    return int((amount * (10 ** USDC_DECIMALS)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _fake_tx_hash(seed: str) -> str:
    """Deterministic 0x… 32-byte hash for a given seed (looks like an EVM txid)."""
    return "0x" + hashlib.sha256(seed.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Rail A/C — Stripe card + auto-recharge + crypto top-up (simulated)
# ---------------------------------------------------------------------------
class DemoStripeProvider(PaymentProvider):
    """Simulated Stripe rail — cards, off-session auto-recharge, refunds, webhooks.

    Realistic ids (``seti_…`` / ``pm_…`` / ``pi_…`` / ``re_…`` / ``cus_…``),
    realistic latency, and a CONFIGURABLE charge outcome so the exec can walk the
    happy path AND the decline→dunning path from the demo control panel.

    Outcome is chosen per-charge via ``metadata["demo_outcome"]`` (one of
    ``success`` / ``insufficient_funds`` / ``authentication_required``); absent
    that, it defaults to ``success``. The ``PAYMENTS_DEMO_DECLINE`` env can force
    a default decline reason for a whole session (the ``simulate/decline`` button
    can also just pass the metadata).
    """

    name = "stripe"          # matches payment_methods.provider / ledger source 'stripe_card'
    enabled = True

    def __init__(self, default_outcome: Optional[str] = None):
        # An operator can pin a default outcome for the whole session (e.g. to
        # demo a payment processor outage); per-charge metadata overrides it.
        self._default_outcome = default_outcome or os.getenv("PAYMENTS_DEMO_DEFAULT_OUTCOME", "success")

    async def create_setup(
        self,
        *,
        customer_id: int,
        provider_customer_id: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> SetupResult:
        """Simulate a Stripe SetupIntent + a saved PaymentMethod.

        A real setup returns a ``client_secret`` the hosted Payment Element (PCI
        SAQ-A) uses to collect the card; WE never see the card. The demo mints the
        same shape PLUS the ``pm_…``/``brand``/``last4`` the frontend would learn
        AFTER the element confirms — so the demo can persist a usable method in one
        call (no real iframe). ``metadata`` may carry ``brand`` to pick the card.
        """
        await _simulate_latency(0.5)
        meta = metadata or {}
        brand = (meta.get("brand") or "visa").lower()
        if brand not in _DEMO_CARD_BRANDS:
            brand = "visa"
        last4 = _DEMO_CARD_BRANDS[brand]
        cus = provider_customer_id or _rand_token("cus", 10)
        pm = _rand_token("pm", 12)
        seti = _rand_token("seti", 12)
        # exp a couple years out, realistic
        exp_year = time.gmtime().tm_year + 3
        return SetupResult(
            provider=self.name,
            client_secret=f"{seti}_secret_{secrets.token_hex(8)}",
            provider_customer_id=cus,
            raw={
                "object": "setup_intent",
                "id": seti,
                "status": "succeeded",
                "payment_method": pm,
                "brand": brand,
                "last4": last4,
                "exp_month": 12,
                "exp_year": exp_year,
                "customer": cus,
            },
        )

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
        """Simulate an off-session PaymentIntent (a top-up / auto-recharge charge).

        Latency ~300ms. Outcome from ``metadata['demo_outcome']`` (else the
        session default). On decline we RAISE :class:`PaymentError` carrying the
        Stripe-style decline ``code`` so the auto-recharge trigger can branch to
        dunning exactly like a real ``requires_payment_method`` off-session decline.
        """
        await _simulate_latency(1.0)
        meta = metadata or {}
        outcome = (meta.get("demo_outcome") or self._default_outcome or "success").lower()
        cents = _to_cents(amount)
        pi = _rand_token("pi", 12)

        if outcome in DECLINE_REASONS:
            # A real off-session decline returns a PaymentIntent in
            # requires_payment_method with a decline code — model that as an error
            # the caller maps to dunning.
            err = PaymentError(f"card_declined:{outcome}")
            err.decline_code = outcome           # type: ignore[attr-defined]
            err.provider_ref = pi                # type: ignore[attr-defined]
            err.amount = amount                  # type: ignore[attr-defined]
            err.raw = {                          # type: ignore[attr-defined]
                "object": "payment_intent", "id": pi, "status": "requires_payment_method",
                "amount": cents, "currency": currency.lower(),
                "last_payment_error": {"code": outcome, "type": "card_error"},
            }
            raise err

        return ChargeResult(
            provider=self.name,
            provider_ref=pi,
            status="succeeded",
            amount=amount,
            currency=currency,
            raw={
                "object": "payment_intent", "id": pi, "status": "succeeded",
                "amount": cents, "amount_received": cents, "currency": currency.lower(),
                "payment_method": payment_method_ref,
                "customer": provider_customer_id,
                "livemode": False,
            },
        )

    async def refund(
        self,
        *,
        provider_ref: str,
        amount: Optional[Decimal] = None,
        idempotency_key: str,
        metadata: Optional[dict] = None,
    ) -> ChargeResult:
        """Simulate a full/partial refund of a prior ``pi_…`` charge."""
        await _simulate_latency(1.0)
        re_id = _rand_token("re", 12)
        amt = amount if amount is not None else Decimal("0")
        return ChargeResult(
            provider=self.name,
            provider_ref=re_id,
            status="refunded",
            amount=amt,
            currency="USD",
            raw={
                "object": "refund", "id": re_id, "status": "succeeded",
                "payment_intent": provider_ref,
                "amount": _to_cents(amt) if amount is not None else None,
            },
        )

    async def verify_and_parse_webhook(
        self,
        *,
        headers: dict[str, str],
        body: bytes,
    ) -> NormalizedEvent:
        """Synthesize + normalize a Stripe webhook (demo signature is trusted).

        The real ingress verifies the ``Stripe-Signature`` HMAC; the demo instead
        parses a minimal synthetic event body ``{type, id, pi, amount_cents,
        outcome}`` (produced by the demo control endpoints) into the SAME
        :class:`NormalizedEvent` the live ingress emits, so the downstream
        ledger-posting path is identical. A malformed body raises PaymentError.
        """
        import json

        try:
            evt = json.loads(body.decode() or "{}")
        except (ValueError, UnicodeDecodeError) as e:
            raise PaymentError(f"malformed demo webhook body: {e}")

        etype = evt.get("type") or "payment_intent.succeeded"
        succeeded = etype == "payment_intent.succeeded"
        cents = evt.get("amount_cents")
        amount = (Decimal(cents) / 100) if cents is not None else None
        return NormalizedEvent(
            provider=self.name,
            event_id=evt.get("id") or _rand_token("evt", 12),
            event_type=etype,
            provider_ref=evt.get("pi") or evt.get("payment_intent"),
            customer_ref=evt.get("customer"),
            kind="topup",
            status="succeeded" if succeeded else "failed",
            amount=amount,
            currency=evt.get("currency", "USD"),
            raw=evt,
        )


# ---------------------------------------------------------------------------
# Rail B — x402 crypto-native (USDC-on-Base), simulated CDP facilitator
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class X402Challenge:
    """The 402 challenge a metered endpoint returns before payment (x402 v2).

    ``header_value`` is what we put in the ``PAYMENT-REQUIRED`` response header;
    the agent signs an EIP-3009 authorization and retries with ``PAYMENT-SIGNATURE``.
    """
    scheme: str
    network: str
    asset: str
    pay_to: str
    amount_minor: int        # USDC 6-decimal minor units
    resource: str
    nonce: str
    header_value: str


@dataclass(frozen=True)
class X402Settlement:
    """Result of verifying + settling an x402 payment (simulated CDP settle)."""
    verified: bool
    tx_hash: str
    amount: Decimal          # dollars, for the ledger
    amount_minor: int        # USDC minor units, for the PAYMENT-RESPONSE header
    network: str
    asset: str
    payer: str
    header_value: str        # value for the PAYMENT-RESPONSE header
    raw: dict[str, Any] = field(default_factory=dict)


class DemoX402Provider(PaymentProvider):
    """Simulated x402 rail — challenge / verify / settle over USDC-on-Base.

    Non-custodial by design (design §1 gate): funds move payer→payee directly and
    the facilitator only broadcasts a signed authorization; the demo models that
    as "mint a tx-hash". Speaks USDC 6-decimal minor units at its boundary and
    uses the x402 **v2** header names (``PAYMENT-REQUIRED`` / ``PAYMENT-SIGNATURE``
    / ``PAYMENT-RESPONSE``).

    The generic ``charge()`` is implemented (settle a given amount) so the rail
    fits the interface; the metered-endpoint flow uses :meth:`build_challenge` +
    :meth:`verify_and_settle`.
    """

    name = "x402"            # ledger source 'x402'
    enabled = True

    #: The demo receiving wallet (a real deployment reads this from CDP config).
    PAY_TO = os.getenv("PAYMENTS_DEMO_X402_WALLET", "0xR3vUpDemoWa11et000000000000000000000000")
    NETWORK = os.getenv("PAYMENTS_DEMO_X402_NETWORK", "base-mainnet")
    ASSET = "USDC"

    def build_challenge(self, *, amount: Decimal, resource: str) -> X402Challenge:
        """Build the 402 challenge for a metered request (no latency — synchronous).

        Returns the parts the router puts into the ``PAYMENT-REQUIRED`` header and
        the JSON body. ``amount`` is dollars → converted to USDC minor units.
        """
        minor = _to_usdc_minor(amount)
        nonce = secrets.token_hex(16)
        # A compact, human-inspectable v2 challenge value (the real header is a
        # base64 JSON per the x402 spec; a readable form is clearer for a demo).
        header_value = (
            f"x402 scheme=exact network={self.NETWORK} asset={self.ASSET} "
            f"amount={minor} pay_to={self.PAY_TO} resource={resource} nonce={nonce}"
        )
        return X402Challenge(
            scheme="exact",
            network=self.NETWORK,
            asset=self.ASSET,
            pay_to=self.PAY_TO,
            amount_minor=minor,
            resource=resource,
            nonce=nonce,
            header_value=header_value,
        )

    async def verify_and_settle(
        self,
        *,
        amount: Decimal,
        resource: str,
        payment_signature: str,
        payer: Optional[str] = None,
    ) -> X402Settlement:
        """Simulate CDP facilitator ``/verify`` + ``/settle`` for a paid retry.

        In production this posts the client's EIP-3009 signed authorization to the
        hosted Coinbase CDP facilitator, which verifies it and broadcasts the
        USDC transfer on Base, returning a tx hash. The demo accepts any non-empty
        signature, mints a deterministic tx-hash, and returns the settlement the
        router uses to (a) post an ``x402`` ledger entry and (b) fill the
        ``PAYMENT-RESPONSE`` header. Raises PaymentError on a missing signature.
        """
        if not payment_signature:
            raise PaymentError("x402 verify failed: empty PAYMENT-SIGNATURE")
        await _simulate_latency(1.5)  # on-chain settle is a touch slower
        minor = _to_usdc_minor(amount)
        payer_addr = payer or ("0x" + hashlib.sha256(payment_signature.encode()).hexdigest()[:40])
        tx = _fake_tx_hash(f"{resource}:{payment_signature}:{minor}")
        header_value = (
            f"x402 tx={tx} network={self.NETWORK} asset={self.ASSET} "
            f"amount={minor} payer={payer_addr}"
        )
        return X402Settlement(
            verified=True,
            tx_hash=tx,
            amount=amount,
            amount_minor=minor,
            network=self.NETWORK,
            asset=self.ASSET,
            payer=payer_addr,
            header_value=header_value,
            raw={
                "facilitator": "coinbase-cdp-demo", "verified": True,
                "settlement": {"tx_hash": tx, "network": self.NETWORK,
                               "asset": self.ASSET, "amount_minor": minor,
                               "payer": payer_addr, "pay_to": self.PAY_TO},
            },
        )

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
        """Settle a fixed USDC amount (interface conformance; used rarely)."""
        meta = metadata or {}
        resource = meta.get("resource", "generic")
        settle = await self.verify_and_settle(
            amount=amount, resource=resource,
            payment_signature=meta.get("payment_signature", "demo-sig"),
        )
        return ChargeResult(
            provider=self.name,
            provider_ref=settle.tx_hash,
            status="succeeded",
            amount=amount,
            currency="USD",
            raw=settle.raw,
        )

    async def create_setup(self, **kwargs: Any) -> SetupResult:  # noqa: D102
        # x402 is non-custodial and stateless per-request — there is no
        # card-on-file setup. Return a benign, empty setup so the interface holds.
        return SetupResult(provider=self.name, raw={"note": "x402 has no card-on-file setup"})

    async def refund(self, **kwargs: Any) -> ChargeResult:  # noqa: D102
        # On-chain payments have no chargebacks; a refund is a new reverse transfer.
        raise PaymentError("x402 refunds are a manual reverse transfer (out of demo scope)")

    async def verify_and_parse_webhook(self, **kwargs: Any) -> NormalizedEvent:  # noqa: D102
        raise PaymentError("x402 has no webhook in the demo (settlement is synchronous)")


# ---------------------------------------------------------------------------
# Rail B — Stripe MPP agent "tab" (simulated)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class MppOpen:
    """Result of opening a spend-limited MPP session (agent tab)."""
    provider: str
    provider_session_id: str
    spend_limit: Decimal
    currency: str = "USD"
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MppCharge:
    """Result of streaming one micro-charge onto the tab."""
    provider: str
    accepted: bool
    amount: Decimal
    new_total: Decimal
    remaining: Decimal
    reason: Optional[str] = None       # set when accepted is False (e.g. limit reached)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MppSettle:
    """Result of settling the accumulated tab as one charge."""
    provider: str
    provider_ref: str                  # pi_… for the settlement
    amount: Decimal
    charge_count: int
    raw: dict[str, Any] = field(default_factory=dict)


class DemoMppProvider(PaymentProvider):
    """Simulated Stripe MPP rail — the agent "tab" (design §4 Rail B / §9 story 4).

    An autonomous agent opens a spend-limited session, streams batched
    micro-charges as it consumes minutes/requests, then the tab settles as ONE
    ``pi_…`` charge (Shared Payment Token model — appears as a normal Stripe
    payment). This provider is PURE arithmetic + id minting; the ROUTER owns the
    ``mpp_sessions`` row and posts the ledger entry, so the ledger stays the
    source of truth.
    """

    name = "stripe_mpp"      # ledger source 'stripe_mpp'
    enabled = True

    async def open_session(
        self, *, customer_id: int, spend_limit: Decimal, label: Optional[str] = None,
    ) -> MppOpen:
        """Open a spend-limited agent session; mints a ``mpp_sess_…`` handle."""
        await _simulate_latency(0.5)
        sess = _rand_token("mpp_sess", 12)
        return MppOpen(
            provider=self.name,
            provider_session_id=sess,
            spend_limit=spend_limit,
            raw={"object": "mpp_session", "id": sess, "status": "open",
                 "spend_limit_cents": _to_cents(spend_limit), "label": label},
        )

    async def stream_charge(
        self, *, current_total: Decimal, spend_limit: Decimal, amount: Decimal,
    ) -> MppCharge:
        """Add one micro-charge to the tab, enforcing the spend limit.

        Returns ``accepted=False`` (with a reason) if the charge would exceed the
        session's spend limit — the tab never overruns its ceiling. Otherwise the
        new running total + remaining budget are returned. Fast (light latency)
        because agents stream many of these.
        """
        await _simulate_latency(0.2)
        proposed = current_total + amount
        if amount <= 0:
            return MppCharge(self.name, False, amount, current_total,
                             spend_limit - current_total, reason="non_positive_amount")
        if proposed > spend_limit:
            return MppCharge(self.name, False, amount, current_total,
                             spend_limit - current_total, reason="spend_limit_reached")
        return MppCharge(
            provider=self.name, accepted=True, amount=amount, new_total=proposed,
            remaining=spend_limit - proposed,
            raw={"object": "mpp_charge", "amount_cents": _to_cents(amount),
                 "running_total_cents": _to_cents(proposed)},
        )

    async def settle_session(
        self, *, provider_session_id: str, total: Decimal, charge_count: int,
    ) -> MppSettle:
        """Settle the accumulated tab as one ``pi_…`` charge."""
        await _simulate_latency(1.0)
        pi = _rand_token("pi", 12)
        return MppSettle(
            provider=self.name, provider_ref=pi, amount=total, charge_count=charge_count,
            raw={"object": "payment_intent", "id": pi, "status": "succeeded",
                 "amount": _to_cents(total), "mpp_session": provider_session_id,
                 "charge_count": charge_count},
        )

    # --- interface conformance (the tab flow uses the methods above) ---------
    async def charge(
        self, *, customer_id: int, amount: Decimal, idempotency_key: str,
        payment_method_ref: Optional[str] = None, provider_customer_id: Optional[str] = None,
        currency: str = "USD", metadata: Optional[dict] = None,
    ) -> ChargeResult:  # noqa: D102
        settle = await self.settle_session(
            provider_session_id=(metadata or {}).get("session", _rand_token("mpp_sess", 8)),
            total=amount, charge_count=(metadata or {}).get("charge_count", 1),
        )
        return ChargeResult(self.name, settle.provider_ref, "succeeded", amount, "USD", settle.raw)

    async def create_setup(self, **kwargs: Any) -> SetupResult:  # noqa: D102
        return SetupResult(provider=self.name, raw={"note": "MPP session opened via open_session"})

    async def refund(self, **kwargs: Any) -> ChargeResult:  # noqa: D102
        raise PaymentError("MPP refunds are out of demo scope")

    async def verify_and_parse_webhook(self, **kwargs: Any) -> NormalizedEvent:  # noqa: D102
        raise PaymentError("MPP settlement is synchronous in the demo (no webhook)")


# ---------------------------------------------------------------------------
# Demo provider bundle — resolved by the factory when PAYMENTS_DEMO_MODE=true.
# ---------------------------------------------------------------------------
@dataclass
class DemoProviders:
    """The three demo rails, resolved together (factory returns this in demo mode).

    ``stripe`` is the default :class:`PaymentProvider` (Rail A/C — the load-bearing
    card rail). ``x402`` and ``mpp`` are the machine rails the payments router
    reaches for directly on the metered/agent endpoints.
    """
    stripe: DemoStripeProvider
    x402: DemoX402Provider
    mpp: DemoMppProvider

    @classmethod
    def build(cls) -> "DemoProviders":
        return cls(
            stripe=DemoStripeProvider(),
            x402=DemoX402Provider(),
            mpp=DemoMppProvider(),
        )
