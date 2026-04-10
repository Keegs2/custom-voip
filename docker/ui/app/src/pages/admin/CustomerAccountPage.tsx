import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCustomer, deleteCustomer } from '../../api/customers';
import { getCustomerTier } from '../../api/tiers';
import { apiRequest } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { CustomerEditForm } from './CustomerEditForm';
import { CustomerRcfSection } from './CustomerRcfSection';
import { CustomerApiSection } from './CustomerApiSection';
import { CustomerTrunkSection } from './CustomerTrunkSection';
import type { Customer } from '../../types/customer';

interface AddCreditResponse {
  balance: number;
}

// ---- Stat card ----

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  accent?: string;
}

function StatCard({ label, value, accent = '#3b82f6' }: StatCardProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 14,
        padding: '20px 24px',
        position: 'relative',
        overflow: 'hidden',
        flex: '1 1 140px',
        minWidth: 0,
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}99, transparent)`,
        }}
      />
      <div
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1.05rem',
          fontWeight: 700,
          color: '#e2e8f0',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ---- Section card wrapper ----

interface SectionCardProps {
  children: React.ReactNode;
  accent?: string;
}

function SectionCard({ children, accent = '#3b82f6' }: SectionCardProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(15,17,23,1) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '28px 32px',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 40,
          right: 40,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          opacity: 0.55,
        }}
      />
      {children}
    </div>
  );
}

// ---- Account detail view ----

interface AccountDetailViewProps {
  customer: Customer;
  onEdit: () => void;
  onDelete: () => void;
}

function AccountDetailView({ customer, onEdit, onDelete }: AccountDetailViewProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [creditAmount, setCreditAmount] = useState('');

  const { data: tierData, isLoading: tierLoading } = useQuery({
    queryKey: ['customerTier', customer.id],
    queryFn: () => getCustomerTier(customer.id),
  });

  const addCreditMutation = useMutation({
    mutationFn: (amount: number) =>
      apiRequest<AddCreditResponse>(
        'POST',
        `/customers/${customer.id}/credit?amount=${amount}`,
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['customer', customer.id] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      toastOk(
        `Added $${parseFloat(creditAmount).toFixed(2)} credit. New balance: $${data.balance.toFixed(2)}`,
      );
      setCreditAmount('');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleAddCredit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseFloat(creditAmount);
    if (!amount || amount <= 0) {
      toastErr('Enter a valid amount');
      return;
    }
    addCreditMutation.mutate(amount);
  }

  const showRcf = customer.account_type === 'rcf' || customer.account_type === 'hybrid';
  const showApi = customer.account_type === 'api' || customer.account_type === 'hybrid';
  const showTrunk = customer.account_type === 'trunk' || customer.account_type === 'hybrid';

  const tier = tierData?.tier;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Account overview stat cards */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        <StatCard
          label="Balance"
          accent={customer.balance < 0 ? '#ef4444' : '#22c55e'}
          value={
            <span style={{ color: customer.balance < 0 ? '#f87171' : '#4ade80' }}>
              ${customer.balance.toFixed(2)}
            </span>
          }
        />
        <StatCard
          label="Credit Limit"
          value={`$${customer.credit_limit.toFixed(2)}`}
        />
        <StatCard
          label="Daily Limit"
          value={customer.daily_limit != null ? `$${customer.daily_limit.toFixed(2)}` : '--'}
        />
        <StatCard
          label="CPM Limit"
          value={customer.cpm_limit != null ? String(customer.cpm_limit) : '--'}
        />
        <StatCard
          label="Fraud Score"
          accent={customer.fraud_score > 70 ? '#ef4444' : '#3b82f6'}
          value={
            <span style={{ color: customer.fraud_score > 70 ? '#f87171' : '#e2e8f0' }}>
              {customer.fraud_score ?? 0}
            </span>
          }
        />
        <StatCard
          label="Created"
          value={
            customer.created_at
              ? new Date(customer.created_at).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })
              : '--'
          }
        />
      </div>

      {/* CPS Tier line */}
      {tierLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', fontSize: '0.8rem' }}>
          <Spinner size="xs" /> Loading tier…
        </div>
      )}
      {!tierLoading && tier && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: '0.82rem',
            color: '#718096',
          }}
        >
          <span
            style={{
              fontSize: '0.6rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.09em',
              color: '#4a5568',
            }}
          >
            CPS Tier:
          </span>
          <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{tier.name}</span>
          <span style={{ color: '#4a5568' }}>—</span>
          <span>{tier.cps_limit} CPS</span>
        </div>
      )}

      {/* Actions bar */}
      <SectionCard accent="#3b82f6">
        <div
          style={{
            fontSize: '0.6rem',
            fontWeight: 700,
            color: '#3b82f6',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginBottom: 20,
          }}
        >
          Account Actions
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Button variant="primary" size="sm" onClick={onEdit}>
            Edit Customer
          </Button>

          {/* Add Credit form */}
          <form
            onSubmit={handleAddCredit}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <input
              type="number"
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value)}
              placeholder="Amount ($)"
              step="0.01"
              min="0.01"
              style={{
                fontSize: '0.82rem',
                padding: '7px 12px',
                borderRadius: 8,
                width: 130,
                border: '1px solid rgba(42,47,69,0.8)',
                background: 'rgba(13,15,21,0.9)',
                color: '#e2e8f0',
                outline: 'none',
                transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = '#22c55e';
                e.currentTarget.style.boxShadow = '0 0 0 3px rgba(34,197,94,0.12)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
            <Button
              type="submit"
              variant="success"
              size="sm"
              loading={addCreditMutation.isPending}
            >
              Add Credit
            </Button>
          </form>

          {/* Delete — pushed to the right */}
          <div style={{ marginLeft: 'auto' }}>
            <Button variant="danger" size="sm" onClick={onDelete}>
              Delete Customer
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* Service sections */}
      {showRcf && (
        <SectionCard accent="#22c55e">
          <CustomerRcfSection customerId={customer.id} />
        </SectionCard>
      )}

      {showApi && (
        <SectionCard accent="#a855f7">
          <CustomerApiSection customerId={customer.id} />
        </SectionCard>
      )}

      {showTrunk && (
        <SectionCard accent="#f59e0b">
          <CustomerTrunkSection customerId={customer.id} />
        </SectionCard>
      )}
    </div>
  );
}

// ---- CustomerAccountPage ----

export function CustomerAccountPage() {
  const { customerId: customerIdParam } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [isEditing, setIsEditing] = useState(false);

  const customerId = parseInt(customerIdParam ?? '', 10);

  const {
    data: customer,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => getCustomer(customerId),
    enabled: !isNaN(customerId),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteCustomer(customerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toastOk('Customer deleted');
      navigate('/admin/customers', { replace: true });
    },
    onError: (err: Error) => toastErr(err.message),
  });

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

  // ---- Loading state ----
  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: '80px 0',
          color: '#718096',
          fontSize: '0.9rem',
        }}
      >
        <Spinner /> Loading customer…
      </div>
    );
  }

  // ---- Error state ----
  if (isError || !customer) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingTop: 8 }}>
        <button
          onClick={() => navigate('/admin/customers')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: 'none',
            color: '#718096',
            fontSize: '0.85rem',
            cursor: 'pointer',
            padding: '4px 0',
            width: 'fit-content',
          }}
        >
          <LeftArrow /> Back to Customers
        </button>
        <div
          style={{
            padding: '16px 20px',
            borderRadius: 12,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: '#f87171',
            fontSize: '0.875rem',
          }}
        >
          Failed to load customer. The account may not exist.
        </div>
      </div>
    );
  }

  // ---- Derived display values ----
  const accountTypeAccent: Record<string, string> = {
    rcf: '#22c55e',
    api: '#a855f7',
    trunk: '#f59e0b',
    hybrid: '#3b82f6',
  };
  const headerAccent = accountTypeAccent[customer.account_type] ?? '#3b82f6';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingTop: 8 }}>

      {/* Back button */}
      <div>
        <button
          onClick={() => navigate('/admin/customers')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: '1px solid rgba(42,47,69,0.5)',
            borderRadius: 8,
            color: '#718096',
            fontSize: '0.82rem',
            cursor: 'pointer',
            padding: '6px 14px',
            transition: 'color 0.15s, border-color 0.15s, background 0.15s',
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget;
            el.style.color = '#e2e8f0';
            el.style.borderColor = 'rgba(59,130,246,0.4)';
            el.style.background = 'rgba(59,130,246,0.06)';
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget;
            el.style.color = '#718096';
            el.style.borderColor = 'rgba(42,47,69,0.5)';
            el.style.background = 'none';
          }}
        >
          <LeftArrow />
          Customers
        </button>
      </div>

      {/* Header card */}
      <div
        style={{
          background: 'linear-gradient(135deg, rgba(30,33,48,0.95) 0%, rgba(19,21,29,0.98) 100%)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 18,
          padding: '32px 40px',
          position: 'relative',
          overflow: 'hidden',
          boxShadow: '0 8px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        {/* Gradient accent top border */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: `linear-gradient(90deg, transparent 0%, ${headerAccent}99 40%, ${headerAccent} 50%, ${headerAccent}99 60%, transparent 100%)`,
          }}
        />

        {/* Radial glow in corner */}
        <div
          style={{
            position: 'absolute',
            top: -60,
            right: -60,
            width: 240,
            height: 240,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${headerAccent}12 0%, transparent 70%)`,
            pointerEvents: 'none',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
          {/* Customer icon */}
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: `linear-gradient(135deg, ${headerAccent}25 0%, ${headerAccent}10 100%)`,
              border: `1px solid ${headerAccent}35`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: headerAccent,
              flexShrink: 0,
              boxShadow: `0 0 20px ${headerAccent}20`,
            }}
          >
            <UserIcon />
          </div>

          {/* Name + badges */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <h1
                style={{
                  fontSize: '1.75rem',
                  fontWeight: 800,
                  color: '#e2e8f0',
                  letterSpacing: '-0.025em',
                  margin: 0,
                  lineHeight: 1.15,
                }}
              >
                {customer.name}
              </h1>
              <Badge variant={customer.status}>
                {customer.status.charAt(0).toUpperCase() + customer.status.slice(1)}
              </Badge>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Badge variant={customer.account_type}>
                {customer.account_type.toUpperCase()}
              </Badge>
              <Badge variant={customer.traffic_grade}>
                {customer.traffic_grade}
              </Badge>
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: '0.78rem',
                  color: '#4a5568',
                  letterSpacing: '0.04em',
                }}
              >
                #{customer.id}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Edit form or detail view */}
      {isEditing ? (
        <SectionCard accent="#3b82f6">
          <div
            style={{
              fontSize: '0.6rem',
              fontWeight: 700,
              color: '#3b82f6',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: 4,
            }}
          >
            Edit Customer
          </div>
          <CustomerEditForm
            customer={customer}
            onCancel={() => setIsEditing(false)}
            onSaved={handleSaved}
          />
        </SectionCard>
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

// ---- Inline SVG icons ----

function LeftArrow() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 14, height: 14, flexShrink: 0 }}
    >
      <path d="M10 3L5 8l5 5" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 26, height: 26 }}
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
