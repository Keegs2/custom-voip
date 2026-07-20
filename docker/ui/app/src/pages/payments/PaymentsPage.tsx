/**
 * PaymentsPage — the customer-facing "Billing & Payments" surface.
 *
 * THIN composition only (glass refactor §1): all data comes from the shared
 * polled payments query family (`components/payments/queries.ts`) so the numbers
 * move live during the demo; all mutations come from `./hooks`; every visual
 * piece is a dumb presentational component under `./components`. This page owns
 * only top-level modal state.
 *
 * Layout (top → bottom): balance hero → machine-payments story (x402 + MPP) →
 * transaction ledger → payment methods → auto-recharge → usage → invoices.
 *
 * React #310: EVERY hook is called unconditionally at the very top, before any
 * early return.
 */

import { useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { DemoBadge } from '../../components/payments/DemoBadge';
import {
  useBalance,
  useLedger,
  usePaymentMethods,
  useAutoRecharge,
  useInvoices,
  useUsage,
  useMppSessions,
} from '../../components/payments/queries';
import { GLASS } from '../../components/glass/glass';
import { LEDGER_LIMIT } from './types';
import { useAddCard, useDeleteCard, useTopup, useUpdateAutoRecharge } from './hooks';
import { BalanceHero } from './components/BalanceHero';
import { LedgerCard } from './components/LedgerCard';
import { PaymentMethods } from './components/PaymentMethods';
import { AutoRechargeCard } from './components/AutoRechargeCard';
import { InvoicesCard } from './components/InvoicesCard';
import { UsageCard } from './components/UsageCard';
import { AddCardModal } from './components/AddCardModal';
import { AddFundsModal } from './components/AddFundsModal';
import { PageLoading, PageError } from './components/states';
import { X402Visualizer } from './machine/X402Visualizer';
import { MppAgentTab } from './machine/MppAgentTab';
import { useX402Flow } from './machine/hooks';

const SECTION_GAP = 32;

/** A small labelled section divider so the long scroll stays navigable on stage. */
function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0' }}>
      <span style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: GLASS.textFaint }}>
        {text}
      </span>
      <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, rgba(255,255,255,0.10), transparent)' }} />
    </div>
  );
}

export function PaymentsPage() {
  // ── ALL hooks first (React #310) ────────────────────────────────────────────
  const [addCardOpen, setAddCardOpen] = useState(false);
  const [addFundsOpen, setAddFundsOpen] = useState(false);

  const balanceQ = useBalance();
  const ledgerQ = useLedger(LEDGER_LIMIT);
  const methodsQ = usePaymentMethods();
  const autoRechargeQ = useAutoRecharge();
  const invoicesQ = useInvoices();
  const usageQ = useUsage();
  const mppQ = useMppSessions();

  const addCard = useAddCard(() => setAddCardOpen(false));
  const deleteCard = useDeleteCard();
  const topupM = useTopup(() => setAddFundsOpen(false));
  const updateAutoRecharge = useUpdateAutoRecharge();
  const x402 = useX402Flow();

  // ── Derived (after all hooks) ───────────────────────────────────────────────
  const methods = methodsQ.data ?? [];
  const balance = balanceQ.data?.balance ?? 0;
  const currency = balanceQ.data?.currency ?? 'USD';

  // Only the primary balance read blocks the page; everything else fills in.
  if (balanceQ.isLoading) {
    return (
      <>
        <PageHeader title="Billing & Payments" subtitle="Your prepaid balance, payment methods, and how our rails settle." />
        <PageLoading />
      </>
    );
  }

  if (balanceQ.isError) {
    return (
      <>
        <PageHeader title="Billing & Payments" subtitle="Your prepaid balance, payment methods, and how our rails settle." />
        <PageError message={(balanceQ.error as Error)?.message ?? 'The billing service is unavailable. Try again shortly.'} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Billing & Payments"
        subtitle="Your live prepaid balance, payment methods, auto-recharge, and machine-payment rails — all settling against one real-time ledger."
        actions={<DemoBadge />}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: SECTION_GAP }}>
        {/* Balance hero */}
        <BalanceHero
          balance={balance}
          currency={currency}
          autoRecharge={autoRechargeQ.data}
          onAddFunds={() => setAddFundsOpen(true)}
          isFetching={balanceQ.isFetching}
        />

        {/* Machine payments — the frontier story */}
        <SectionLabel text="Machine payments — the frontier rail" />
        <X402Visualizer state={x402.state} onRun={x402.run} onReset={x402.reset} />
        <MppAgentTab sessions={mppQ.data ?? []} />

        {/* Ledger */}
        <SectionLabel text="Activity" />
        <LedgerCard entries={ledgerQ.data ?? []} isLoading={ledgerQ.isLoading} />

        {/* Methods + auto-recharge */}
        <SectionLabel text="Funding" />
        <PaymentMethods
          methods={methods}
          onAdd={() => setAddCardOpen(true)}
          onDelete={(id) => deleteCard.mutate(id)}
          deletingId={deleteCard.isPending ? (deleteCard.variables ?? null) : null}
        />
        <AutoRechargeCard
          settings={autoRechargeQ.data}
          methods={methods}
          onSave={(u) => updateAutoRecharge.mutate(u)}
          saving={updateAutoRecharge.isPending}
        />

        {/* Usage + invoices */}
        <SectionLabel text="Usage & invoices" />
        {usageQ.data && <UsageCard usage={usageQ.data} />}
        <InvoicesCard invoices={invoicesQ.data ?? []} />
      </div>

      {/* Modals */}
      <AddCardModal
        open={addCardOpen}
        onClose={() => setAddCardOpen(false)}
        onSubmit={(input) => addCard.mutate(input)}
        submitting={addCard.isPending}
        firstCard={methods.length === 0}
      />
      <AddFundsModal
        open={addFundsOpen}
        onClose={() => setAddFundsOpen(false)}
        methods={methods}
        onSubmit={(body) => topupM.mutate(body)}
        submitting={topupM.isPending}
      />
    </>
  );
}
