/**
 * CustomersAdminPage — searchable, paginated customer list + inline create
 * form (/admin/customers).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * page-scoped `dlx-*` primitives in styles/dl-admin.css). Renders INSIDE the
 * AdminPage shell, which owns the paper canvas (`dl-scope`) — this page
 * contributes only the toolbar, the create-form panel, and the table panel.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCustomers, createCustomer } from '../../api/customers';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { CustomerRow } from './CustomerRow';
import type { AccountType, TrafficGrade } from '../../types/customer';
import '../../styles/dl-admin.css';

const PAGE_SIZE = 25;
const COL_COUNT = 6;

interface CreateFormState {
  name: string;
  account_type: AccountType;
  traffic_grade: TrafficGrade;
  daily_limit: string;
  cpm_limit: string;
  ucaas_enabled: boolean;
}

const INITIAL_CREATE: CreateFormState = {
  name: '',
  account_type: 'rcf',
  traffic_grade: 'standard',
  daily_limit: '500',
  cpm_limit: '60',
  ucaas_enabled: false,
};

/** Vertical label + dl-input field group (create form). */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span className="dl-flabel">{label}</span>
      {children}
    </div>
  );
}

export function CustomersAdminPage() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState<CreateFormState>(INITIAL_CREATE);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customers', { search: committedSearch, offset }],
    queryFn: () =>
      listCustomers({ search: committedSearch, limit: PAGE_SIZE, offset }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createCustomer({
        name: createForm.name.trim(),
        account_type: createForm.account_type,
        traffic_grade: createForm.traffic_grade,
        daily_limit: parseFloat(createForm.daily_limit) || 0,
        cpm_limit: parseInt(createForm.cpm_limit, 10) || 0,
        // Only send ucaas_enabled for account types where it's meaningful
        ...(createForm.account_type !== 'rcf' && createForm.account_type !== 'ucaas'
          ? { ucaas_enabled: createForm.ucaas_enabled }
          : {}),
      }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      setCreateForm(INITIAL_CREATE);
      setShowCreateForm(false);
      toastOk(`Customer "${created.name}" created`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    setCommittedSearch(search);
  }

  function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.name.trim()) {
      toastErr('Name is required');
      return;
    }
    createMutation.mutate();
  }

  function updateCreateForm<K extends keyof CreateFormState>(key: K, value: CreateFormState[K]) {
    setCreateForm((prev) => ({ ...prev, [key]: value }));
  }

  const shown = (data?.items ?? []).length + offset;
  const total = data?.total ?? 0;

  return (
    <div className="dl-stack">
      {/* ── Toolbar — search + create toggle ── */}
      <div className="dlx-toolbar" style={{ marginBottom: 0 }}>
        <form onSubmit={handleSearch} className="dlx-toolbar-form">
          <input
            type="search"
            className="dl-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers…"
            style={{ flex: 1, maxWidth: 400 }}
          />
          <button type="submit" className="dl-btn dl-btn-ghost" style={{ flexShrink: 0 }}>
            Search
          </button>
        </form>
        <button
          type="button"
          className="dl-btn dl-btn-primary"
          onClick={() => setShowCreateForm((v) => !v)}
          style={{ flexShrink: 0, marginLeft: 'auto' }}
        >
          {showCreateForm ? 'Cancel' : '+ New Customer'}
        </button>
      </div>

      {/* ── Create form ── */}
      {showCreateForm && (
        <section className="dl-panel">
          <div className="dl-panel-head">
            <h2 className="dl-panel-title">New Customer</h2>
          </div>
          <form onSubmit={handleCreateSubmit} className="dl-panel-body">
            <div className="dlx-form-grid">
              <Field label="Name">
                <input
                  className="dl-input"
                  value={createForm.name}
                  onChange={(e) => updateCreateForm('name', e.target.value)}
                  placeholder="Acme Corp"
                  required
                />
              </Field>
              <Field label="Account Type">
                <select
                  className="dl-input"
                  value={createForm.account_type}
                  onChange={(e) => {
                    const newType = e.target.value as AccountType;
                    updateCreateForm('account_type', newType);
                    // Reset ucaas_enabled when switching to a type where it doesn't apply
                    if (newType === 'rcf' || newType === 'ucaas') {
                      updateCreateForm('ucaas_enabled', false);
                    }
                  }}
                >
                  <option value="rcf">RCF</option>
                  <option value="api">API</option>
                  <option value="trunk">Trunk</option>
                  <option value="hybrid">Hybrid</option>
                  <option value="ucaas">UCaaS</option>
                </select>
              </Field>
              <Field label="Traffic Grade">
                <select
                  className="dl-input"
                  value={createForm.traffic_grade}
                  onChange={(e) =>
                    updateCreateForm('traffic_grade', e.target.value as TrafficGrade)
                  }
                >
                  <option value="standard">Standard</option>
                  <option value="premium">Premium</option>
                  <option value="economy">Economy</option>
                </select>
              </Field>
              {/* Rate-limiting fields — hidden for RCF accounts */}
              {createForm.account_type !== 'rcf' && (
                <>
                  <Field label="Daily Limit ($)">
                    <input
                      className="dl-input"
                      type="number"
                      min="0"
                      step="0.01"
                      value={createForm.daily_limit}
                      onChange={(e) => updateCreateForm('daily_limit', e.target.value)}
                    />
                  </Field>
                  <Field label="CPM Limit">
                    <input
                      className="dl-input"
                      type="number"
                      min="0"
                      value={createForm.cpm_limit}
                      onChange={(e) => updateCreateForm('cpm_limit', e.target.value)}
                    />
                  </Field>
                </>
              )}
            </div>

            {/* UCaaS add-on toggle — only relevant for api/trunk/hybrid */}
            {(createForm.account_type === 'api' || createForm.account_type === 'trunk' || createForm.account_type === 'hybrid') && (
              <div
                className={createForm.ucaas_enabled ? 'dlx-checkrow dlx-checkrow-on' : 'dlx-checkrow'}
                style={{ marginTop: 16 }}
                onClick={() => updateCreateForm('ucaas_enabled', !createForm.ucaas_enabled)}
              >
                <input
                  id="create-ucaas-enabled"
                  type="checkbox"
                  checked={createForm.ucaas_enabled}
                  onChange={(e) => updateCreateForm('ucaas_enabled', e.target.checked)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: 15, height: 15, accentColor: 'var(--rcf-azure)', cursor: 'pointer', flexShrink: 0 }}
                />
                <label
                  htmlFor="create-ucaas-enabled"
                  style={{
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    color: createForm.ucaas_enabled ? 'var(--rcf-azure-deep)' : 'var(--rcf-ink-soft)',
                    cursor: 'pointer',
                    transition: 'color 0.15s ease',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  UCaaS Enabled
                </label>
                <span style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', marginLeft: 4 }}>
                  Grants softphone, chat, and voicemail access
                </span>
              </div>
            )}

            <div
              style={{
                display: 'flex',
                gap: 10,
                marginTop: 20,
                paddingTop: 20,
                borderTop: '1px solid var(--rcf-line)',
              }}
            >
              <button
                type="submit"
                className="dl-btn dl-btn-primary"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? 'Creating…' : 'Create Customer'}
              </button>
              <button
                type="button"
                className="dl-btn dl-btn-ghost"
                onClick={() => {
                  setShowCreateForm(false);
                  setCreateForm(INITIAL_CREATE);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {/* ── Loading / error states ── */}
      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'var(--rcf-ink-dim)',
            fontSize: '0.85rem',
            padding: '48px 0',
          }}
        >
          <Spinner /> Loading customers…
        </div>
      )}

      {isError && (
        <div className="dl-banner dl-banner-err">Failed to load customers.</div>
      )}

      {/* ── Table ── */}
      {data && (
        <>
          <section className="dl-panel">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    {['ID', 'Name', 'Type', 'Status', 'Grade', 'Created'].map((h) => (
                      <th key={h} className="dl-th">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data.items ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={COL_COUNT} style={{ padding: 0 }}>
                        <div className="dl-empty" style={{ border: 'none', borderRadius: 0 }}>
                          No customers found.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    (data.items ?? []).map((customer) => (
                      <CustomerRow key={customer.id} customer={customer} />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Pagination — "shown of total" + load more ── */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: '0.8rem',
              color: 'var(--rcf-ink-dim)',
            }}
          >
            <span>
              Showing{' '}
              <span style={{ color: 'var(--rcf-ink)', fontWeight: 700 }}>{shown}</span> of{' '}
              <span style={{ color: 'var(--rcf-ink)', fontWeight: 700 }}>{total}</span>
            </span>
            {shown < total && (
              <button
                type="button"
                className="dl-btn dl-btn-ghost"
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                Load More
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
