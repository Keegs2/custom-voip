/**
 * CustomerAccountPage — the customer 360 view (routed at
 * /admin/customers/:customerId). THIN page: composition + top-level state only.
 *
 * All data/mutations live in ./customer-account/hooks.ts; styles in styles.ts;
 * presentational pieces in ./customer-account/components/. The heavy per-product
 * service sections (RCF/API/trunk/UCaaS/edit form) are reused from their own
 * sibling modules and rendered inside glass SectionPanels.
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout — this page does
 * not mount its own. React #310: every hook sits above any early return.
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useCustomerAccount } from './customer-account/hooks';
import { BackButton, ErrorState, LoadingState } from './customer-account/components/states';
import { AccountHeader } from './customer-account/components/AccountHeader';
import { AccountDetailView } from './customer-account/components/AccountDetailView';
import { EditFormPanel } from './customer-account/components/EditFormPanel';

const COLUMN: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

export function CustomerAccountPage() {
  // ── ALL hooks first (React #310) ────────────────────────────────────────────
  const { customerId: customerIdParam } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);

  const customerId = parseInt(customerIdParam ?? '', 10);
  const { query, deleteMutation } = useCustomerAccount(customerId);
  const { data: customer, isLoading, isError } = query;

  const goBack = () => navigate('/admin/customers');

  function handleDelete() {
    if (!customer) return;
    if (
      !confirm(
        `Delete customer "${customer.name}" and ALL associated records (RCF, trunks, DIDs)?\n\nThis cannot be undone.`,
      )
    )
      return;
    deleteMutation.mutate();
  }

  function handleSaved() {
    setIsEditing(false);
    qc.invalidateQueries({ queryKey: ['customer', customerId] });
  }

  // ── Early returns (after all hooks) ─────────────────────────────────────────
  if (isLoading) return <LoadingState />;
  if (isError || !customer) return <ErrorState onBack={goBack} />;

  return (
    <div style={COLUMN}>
      <div>
        <BackButton onClick={goBack} />
      </div>

      <AccountHeader customer={customer} />

      {isEditing ? (
        <EditFormPanel customer={customer} onCancel={() => setIsEditing(false)} onSaved={handleSaved} />
      ) : (
        <AccountDetailView
          customer={customer}
          onEdit={() => setIsEditing(true)}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
