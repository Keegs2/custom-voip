"""Auto-recharge trigger — the "Twilio model" top-up (Payments §4 Rail A / §9).

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §4 Rail A ("auto-recharge"), §9 story 2.

Stripe has NO native auto-recharge — WE build the trigger. This service is the
REAL logic (the demo drives it with simulated usage, but the branch structure is
production-shaped and provider-agnostic):

    balance crosses threshold
        → off-session charge(recharge_amount) on the default card
            → on SUCCESS: post a `topup` ledger entry (idempotency-keyed) so the
              balance tops up and a payment_transactions row records the charge.
            → on DECLINE: set dunning state (consecutive_failures++, disabled_reason)
              exactly per the design — insufficient_funds prompts a new card,
              authentication_required prompts on-session re-auth; disable after N
              consecutive failures.

Guardrails baked in (all from the ledger/compliance design):
  * IDEMPOTENT top-up — the ledger entry + the payment_transactions row are keyed
    so a retried/raced trigger never double-tops-up.
  * COOLDOWN — a successful trigger won't re-fire within ``cooldown_seconds``
    (avoids a top-up storm while the balance-cache read lags).
  * DAILY CAP — the sum of today's auto-recharge top-ups is capped at
    ``daily_cap`` (which the design keeps ≤ the closed-loop $2k/day cap, §1).
  * OFF THE CALL PATH — this runs from the ledger/demo layer, never inline with
    call setup, so a top-up can never block a call (design §5).

The charge goes through the configured :class:`PaymentProvider` (the demo's
``DemoStripeProvider`` today; the live ``StripeProvider`` later) — this module is
UNCHANGED when the provider is swapped.
"""
from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional

import asyncpg

from db import database as db
from services import ledger
from services.payments import PaymentError, get_payment_provider

logger = logging.getLogger(__name__)

#: Disable auto-recharge after this many consecutive off-session declines (design
#: §4: "disable after N consecutive failures"). Env-tunable, sensible default.
MAX_CONSECUTIVE_FAILURES = int(os.getenv("AUTO_RECHARGE_MAX_FAILURES", "3"))


@dataclass
class RechargeOutcome:
    """What happened when we evaluated (and maybe fired) auto-recharge.

    ``action`` is one of:
      * ``charged``        — a top-up succeeded; ``amount``/``ledger_entry_id``/
                             ``provider_ref``/``new_balance`` are set.
      * ``skipped``        — no action needed (disabled / above threshold / in
                             cooldown / daily cap hit / no card); ``reason`` says which.
      * ``declined``       — the off-session charge was declined; ``reason`` is the
                             decline code and dunning state was updated.
    """
    action: str
    reason: Optional[str] = None
    amount: Optional[Decimal] = None
    new_balance: Optional[Decimal] = None
    ledger_entry_id: Optional[int] = None
    provider_ref: Optional[str] = None
    consecutive_failures: int = 0
    disabled: bool = False


async def _todays_recharge_total(conn: asyncpg.Connection, customer_id: int) -> Decimal:
    """Sum of today's auto-recharge top-ups (for the daily-cap check).

    Counts ``topup`` ledger entries whose metadata marks them auto-recharge, for
    the current UTC day. Keeps the demo/prod honest against the closed-loop cap.
    """
    row = await conn.fetchrow(
        """
        SELECT COALESCE(SUM(amount), 0)::numeric AS total
        FROM ledger_entries
        WHERE customer_id = $1::int
          AND entry_type = 'topup'
          AND created_at >= date_trunc('day', NOW())
          AND metadata->>'reason' = 'auto_recharge'
        """,
        customer_id,
    )
    return row["total"] if row else Decimal("0")


async def evaluate_and_recharge(
    customer_id: int,
    *,
    trigger: str = "balance_check",
    force: bool = False,
) -> RechargeOutcome:
    """Evaluate a customer's balance against their auto-recharge settings and,
    if warranted, fire an off-session top-up.

    This is the single entry point the ledger layer / demo call-drain calls after
    usage is posted. It is safe to call frequently: it short-circuits when
    disabled, above threshold, in cooldown, or over the daily cap.

    Args:
        customer_id: the tenant to evaluate.
        trigger: free-form label recorded in metadata (e.g. ``call_drain``).
        force: skip the ``balance < threshold`` gate (still honors cooldown/cap/
            card checks) — used by an explicit "recharge now" action.

    Returns:
        A :class:`RechargeOutcome`.
    """
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        # Load settings + the current balance in one shot. FOR UPDATE on the
        # settings row serializes concurrent triggers for the same customer so two
        # racing usage posts can't both fire a charge.
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                SELECT ars.id, ars.enabled, ars.threshold, ars.recharge_amount,
                       ars.payment_method_id, ars.currency, ars.daily_cap,
                       ars.cooldown_seconds, ars.consecutive_failures,
                       ars.last_triggered_at, ars.disabled_reason,
                       c.balance AS balance,
                       (ars.last_triggered_at IS NOT NULL
                        AND ars.last_triggered_at > NOW() - make_interval(secs => ars.cooldown_seconds)
                       ) AS in_cooldown
                FROM auto_recharge_settings ars
                JOIN customers c ON c.id = ars.customer_id
                WHERE ars.customer_id = $1::int
                FOR UPDATE OF ars
                """,
                customer_id,
            )
            if row is None:
                return RechargeOutcome("skipped", reason="not_configured")
            if not row["enabled"]:
                return RechargeOutcome("skipped", reason="disabled")
            threshold = row["threshold"]
            recharge_amount = row["recharge_amount"]
            if threshold is None or recharge_amount is None or recharge_amount <= 0:
                return RechargeOutcome("skipped", reason="incomplete_settings")
            balance = row["balance"]
            if not force and balance is not None and balance >= threshold:
                return RechargeOutcome("skipped", reason="above_threshold")
            # ``force`` is an explicit "recharge now" action (e.g. the demo decline
            # button, or a manual retry) — it bypasses BOTH the threshold gate and
            # the cooldown. The automatic path (force=False) still honors cooldown
            # so a top-up can't storm while the balance-cache read lags.
            if not force and row["in_cooldown"]:
                return RechargeOutcome("skipped", reason="cooldown")

            # Daily cap (closed-loop, design §1): don't exceed daily_cap of
            # auto-recharge top-ups today.
            daily_cap = row["daily_cap"]
            if daily_cap is not None:
                today_total = await _todays_recharge_total(conn, customer_id)
                if today_total + recharge_amount > daily_cap:
                    return RechargeOutcome("skipped", reason="daily_cap_reached")

            # Resolve the default/selected payment method (its provider refs).
            pm = await conn.fetchrow(
                """
                SELECT id, provider, provider_pm_id, provider_customer_id, status
                FROM payment_methods
                WHERE customer_id = $1::int
                  AND ($2::bigint IS NULL OR id = $2::bigint)
                  AND status = 'active'
                ORDER BY (id = $2::bigint) DESC, is_default DESC, id ASC
                LIMIT 1
                """,
                customer_id, row["payment_method_id"],
            )
            if pm is None:
                return RechargeOutcome("skipped", reason="no_payment_method")

            settings_id = row["id"]
            currency = row["currency"] or "USD"

        # --- Charge OUTSIDE the settings-lock txn (the network/provider call may
        #     be slow; we don't hold a row lock across it). Idempotency on the key
        #     keeps a retry safe. ---------------------------------------------
        provider = get_payment_provider()
        # Stable-per-trigger key: bucketed by customer + the pre-charge balance so
        # a genuine retry of THIS trigger dedupes, but a later distinct dip fires
        # fresh. A UUID suffix guarantees uniqueness across separate crossings.
        charge_key = f"auto_recharge:{customer_id}:{uuid.uuid4()}"
        try:
            result = await provider.charge(
                customer_id=customer_id,
                amount=recharge_amount,
                idempotency_key=charge_key,
                payment_method_ref=pm["provider_pm_id"],
                provider_customer_id=pm["provider_customer_id"],
                currency=currency,
                metadata={"reason": "auto_recharge", "trigger": trigger},
            )
        except PaymentError as e:
            # Off-session decline → dunning. insufficient_funds / authentication_required.
            decline_code = getattr(e, "decline_code", None) or "card_declined"
            return await _record_decline(customer_id, settings_id, decline_code, str(e))

        # --- SUCCESS: record the transaction + post the topup ledger entry in ONE
        #     DB transaction (so a crash can't leave a charge without a credit). --
        entry_id, new_balance = await _apply_successful_topup(
            customer_id=customer_id,
            settings_id=settings_id,
            amount=recharge_amount,
            currency=currency,
            provider=provider.name,
            provider_ref=result.provider_ref,
            charge_key=charge_key,
            trigger=trigger,
            raw=result.raw,
        )
        logger.info(
            "auto-recharge fired: customer=%s amount=%s provider=%s ref=%s new_balance=%s",
            customer_id, recharge_amount, provider.name, result.provider_ref, new_balance,
        )
        return RechargeOutcome(
            action="charged",
            amount=recharge_amount,
            new_balance=new_balance,
            ledger_entry_id=entry_id,
            provider_ref=result.provider_ref,
            consecutive_failures=0,
            disabled=False,
        )


async def _apply_successful_topup(
    *,
    customer_id: int,
    settings_id: int,
    amount: Decimal,
    currency: str,
    provider: str,
    provider_ref: Optional[str],
    charge_key: str,
    trigger: str,
    raw: dict[str, Any],
) -> tuple[int, Optional[Decimal]]:
    """Persist a succeeded auto-recharge: payment_transactions + topup ledger entry
    + reset dunning + stamp last_triggered_at — all atomic."""
    import json

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # 1) payment_transactions (idempotent on the charge key).
            await conn.execute(
                """
                INSERT INTO payment_transactions
                    (customer_id, provider, provider_ref, kind, amount, currency,
                     status, idempotency_key, raw_event)
                VALUES ($1::int, $2::text, $3::text, 'topup', $4::numeric, $5::text,
                        'succeeded', $6::text, $7::jsonb)
                ON CONFLICT (idempotency_key) DO NOTHING
                """,
                customer_id, provider, provider_ref, amount, currency,
                charge_key, json.dumps(raw) if raw else None,
            )
            # 2) topup ledger entry (money IN, positive). Same txn → the charge and
            #    the credit are inseparable. Ledger source is the card rail.
            entry = await ledger.post_ledger_entry(
                conn,
                customer_id=customer_id,
                amount=amount,
                entry_type="topup",
                source="stripe_card",
                idempotency_key=charge_key,
                currency=currency,
                external_ref=provider_ref,
                metadata={"reason": "auto_recharge", "trigger": trigger,
                          "provider": provider},
            )
            # 3) reset dunning + stamp the trigger time.
            await conn.execute(
                """
                UPDATE auto_recharge_settings
                SET consecutive_failures = 0, disabled_reason = NULL,
                    last_triggered_at = NOW(), updated_at = NOW()
                WHERE id = $1::bigint
                """,
                settings_id,
            )
    return entry["id"], entry.get("balance_after")


async def _record_decline(
    customer_id: int, settings_id: int, decline_code: str, message: str,
) -> RechargeOutcome:
    """Update dunning state after an off-session decline (design §4 Rail A).

    Increments consecutive_failures, sets a human-readable disabled_reason, and
    DISABLES auto-recharge once the failure count reaches the max — after which a
    human must fix the card and re-enable. A ``payment_transactions`` row records
    the failed attempt for the dashboard.
    """
    import json

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                UPDATE auto_recharge_settings
                SET consecutive_failures = consecutive_failures + 1,
                    disabled_reason = $2::text,
                    enabled = CASE WHEN consecutive_failures + 1 >= $3::int
                                   THEN false ELSE enabled END,
                    updated_at = NOW()
                WHERE id = $1::bigint
                RETURNING consecutive_failures, enabled
                """,
                settings_id, f"{decline_code}: {message}", MAX_CONSECUTIVE_FAILURES,
            )
            failures = row["consecutive_failures"] if row else 0
            disabled = (not row["enabled"]) if row else False
            # Record the failed charge attempt (unique key so it's queryable).
            await conn.execute(
                """
                INSERT INTO payment_transactions
                    (customer_id, provider, provider_ref, kind, amount, currency,
                     status, idempotency_key, raw_event)
                VALUES ($1::int, 'stripe', NULL, 'charge', 0::numeric, 'USD',
                        'failed', $2::text, $3::jsonb)
                ON CONFLICT (idempotency_key) DO NOTHING
                """,
                customer_id,
                f"auto_recharge_decline:{customer_id}:{uuid.uuid4()}",
                json.dumps({"decline_code": decline_code, "message": message}),
            )
    logger.warning(
        "auto-recharge DECLINED: customer=%s code=%s failures=%s disabled=%s",
        customer_id, decline_code, failures, disabled,
    )
    return RechargeOutcome(
        action="declined",
        reason=decline_code,
        consecutive_failures=failures,
        disabled=disabled,
    )
