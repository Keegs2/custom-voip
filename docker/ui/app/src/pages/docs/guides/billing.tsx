/**
 * Billing & Payments — product guide content (PRODUCTS.md § Billing & Payments).
 */

import { Wallet } from 'lucide-react';
import type { ProductGuideData } from '../types';
import { GUIDE_ACCENTS } from './registry';
import { P, H3, IC, B, Callout } from '../components/text';
import { NoteCards } from '../components/apiRefs';

const ACCENT = GUIDE_ACCENTS.billing;

export const billingGuide: ProductGuideData = {
  slug: 'billing',
  icon: Wallet,
  eyebrow: 'Product Guide',
  title: 'Billing & Payments',
  subtitle: 'Prepaid balance with automatic top-ups — pay only for what you use.',
  accent: ACCENT,

  plainEnglish: (
    <>
      Shale is pay-as-you-go on a prepaid balance. You add funds, calls draw down the balance, and — if you turn
      it on — your card is charged automatically to top up when the balance runs low, so service never stops. You
      can pay by card, and (for automated/machine use) even settle per request. Everything is transparent: every
      charge is a line item you can see.
    </>
  ),

  whoItsFor: [
    <>Every customer — this is how you pay for whatever products you use.</>,
  ],

  features: [
    {
      title: 'Prepaid balance with a full ledger',
      body: 'Every top-up and every usage charge is an immutable line item you can audit.',
    },
    {
      title: 'Auto-recharge',
      body: 'Set a threshold and an amount; when your balance drops below the threshold, your saved card is charged to top it back up. Failed charges get a graceful retry/notify (dunning) flow.',
    },
    {
      title: 'Usage billing',
      body: 'Per-minute and per-request usage is metered and reflected in your balance in real time.',
    },
    {
      title: 'Machine payments',
      body: (
        <>
          Automated clients and AI agents can pay per request using modern rails (stablecoin over the{' '}
          <IC>x402</IC> protocol, or Stripe's Machine Payments Protocol) — so an agent can literally pay for
          itself as it works.
        </>
      ),
    },
    {
      title: 'Invoices & revenue view',
      body: 'Invoices for recurring plan fees, and a revenue view for admins.',
    },
  ],

  howItWorks: (
    <>
      Your card is stored safely with our payment processor — Shale never sees or stores your card number. Your
      real-time balance is the source of truth for whether calls are allowed; the payment rails simply top it up.
      Auto-recharge watches your balance and charges your card off-session when it crosses your threshold.
    </>
  ),

  gettingStarted: [
    { title: 'Add a payment method', body: 'Save a card securely through the processor\'s hosted form.' },
    { title: 'Set auto-recharge', body: 'Choose your top-up threshold and amount.' },
    { title: "You're done", body: 'The balance keeps itself full — service simply never stops.' },
  ],

  developers: {
    summary: 'Append-only idempotent ledger, pluggable payment rails, and three compliance lines (SAQ-A, closed-loop, non-custodial).',
    endpoints: [
      { method: 'GET', path: '/api/v1/billing/balance', description: 'Current real-time balance (a cache of the ledger).' },
      { method: 'GET', path: '/api/v1/billing/ledger', description: 'The append-only, auditable line-item ledger.' },
      { method: 'POST', path: '/api/v1/payments/auto-recharge', description: 'Configure the auto-recharge threshold and amount.' },
    ],
    body: () => (
      <>
        <P>
          An <B>append-only, idempotent ledger</B> is the authority; <IC>customers.balance</IC> is a cache updated
          only alongside a ledger entry. Payment rails are pluggable providers (Stripe card + auto-recharge,
          x402/USDC, Stripe MPP) behind one interface.
        </P>

        <H3>Compliance by design</H3>
        <P>The design is built to stay inside three compliance lines:</P>
        <NoteCards
          accent={ACCENT}
          items={[
            { title: 'PCI SAQ-A', body: 'Card data lives only in the processor\'s iframe — Shale never touches a card number, keeping payments in the SAQ-A boundary.' },
            { title: 'Closed-loop prepaid', body: 'The balance is only spendable on Shale services, so it is a closed-loop prepaid instrument, not stored value.' },
            { title: 'Non-custodial crypto', body: 'We never hold customer crypto — stablecoin settlement is non-custodial over x402.' },
          ]}
        />

        <H3>The ledger is the source of truth</H3>
        <P>
          Whether a call is allowed is decided by the real-time balance, which is a cache of the immutable ledger.
          Every write is idempotent, so a retried top-up or usage debit can never double-charge or double-count.
          Reconciliation is a straight replay of the ledger.
        </P>

        <Callout accent={ACCENT}>
          Managed under <IC>/v1/billing</IC> and <IC>/v1/payments</IC>. Holding funds requires legal sign-off and
          is treated as an explicit gate before the relevant feature goes live.
        </Callout>
      </>
    ),
  },
};
