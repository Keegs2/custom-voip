/**
 * /voicemail — Visual Voicemail. Picks who the page is for and hands off to
 * a KEYED view (switching account or mode remounts instead of changing hook
 * order — React #310):
 *
 *   tenant (user / readonly)          → CustomerVoicemail, own account
 *                                        (readonly: listen + download only)
 *   admin in "View as Customer"       → CustomerVoicemail on the preview
 *                                        customer, with the staff controls
 *                                        (New mailbox, suspend/resume, delete)
 *                                     → PreviewPrompt until one is picked
 *   admin (normal view)               → AdminVoicemailConsole: All customers
 *                                        or one (`?customer=<id>`)
 *   support / login with no account   → their productHome (the API answers
 *                                        403 for support)
 *
 * The product UI lives in pages/voicemail/ (VoicemailWorkspace and friends);
 * styles are `vm-*` in styles/dl-voicemail.css on the daylight `dl-*` system.
 */
import { useCallback, useId, useMemo } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth, type EffectiveCustomer } from '../contexts/AuthContext';
import { productHome } from '../utils/productHome';
import { PreviewPrompt } from './dashboard/PreviewPrompt';
import { useAdminCustomers, type CustomerRow } from './dashboard/adminData';
import { VoicemailWorkspace } from './voicemail/VoicemailWorkspace';
import { staffScope, tenantScope } from './voicemail/voicemailData';
import '../styles/dl-voicemail.css';

export function VisualVoicemailPage() {
  const { user, isAdmin, isActualAdmin, isSupport, customerViewMode, effectiveCustomer } = useAuth();
  if (isSupport) return <Navigate to={productHome(user, isAdmin)} replace />;
  if (!isAdmin && effectiveCustomer) {
    return (
      <CustomerVoicemail
        key={`vm-customer-${effectiveCustomer.id}-${isActualAdmin ? 'staff' : 'tenant'}`}
        customer={effectiveCustomer}
        staff={isActualAdmin}
      />
    );
  }
  if (isActualAdmin && customerViewMode) return <PreviewPrompt />;
  if (isAdmin) return <AdminVoicemailConsole />;
  return <Navigate to={productHome(user, isAdmin)} replace />;
}

/* ─── Customer view (tenant, or staff previewing one) ─────── */

function CustomerVoicemail({ customer, staff }: { customer: EffectiveCustomer; staff: boolean }) {
  const { user } = useAuth();
  const scope = useMemo(() => (staff ? staffScope(customer.id) : tenantScope(customer.id)), [staff, customer.id]);
  const createFor = useMemo(() => ({ id: customer.id, name: customer.name }), [customer.id, customer.name]);
  // Tenant roles: 'user' edits; 'readonly' listens and downloads only.
  const canEdit = staff || user?.role === 'user';

  return (
    <VoicemailWorkspace
      scope={scope}
      viewer={staff ? 'preview' : 'tenant'}
      canEdit={canEdit}
      canManage={staff}
      crumb={customer.name || 'Your account'}
      tag={staff ? 'Staff preview' : null}
      createFor={staff ? createFor : null}
      showCustomer={false}
    />
  );
}

/* ─── Admin console (normal view) ─────────────────────────── */

/** `?customer=` → 'all' (absent / 'all' / junk) or a customer id. */
function parseScope(raw: string | null): number | 'all' {
  if (!raw || !/^\d{1,9}$/.test(raw)) return 'all';
  const id = Number(raw);
  return id > 0 ? id : 'all';
}

function AdminVoicemailConsole() {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const [params, setParams] = useSearchParams();
  const customers = useAdminCustomers(true);
  const value = parseScope(params.get('customer'));
  const scope = useMemo(() => staffScope(value), [value]);

  const select = useCallback(
    (next: number | 'all') => {
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'all') p.delete('customer');
        else p.set('customer', String(next));
        return p;
      });
    },
    [setParams],
  );

  // ── Derived (after all hooks) ──
  const name =
    typeof value === 'number' ? (customers.data?.find((c) => c.id === value)?.name ?? `Customer #${value}`) : null;

  return (
    <VoicemailWorkspace
      key={scope.key}
      scope={scope}
      viewer="admin"
      canEdit
      canManage
      crumb={name ?? 'All customers'}
      tag="Staff"
      createFor={typeof value === 'number' && name ? { id: value, name } : null}
      showCustomer={value === 'all'}
      tools={
        <ScopePicker
          value={value}
          onChange={select}
          customers={customers.data ?? []}
          loading={customers.isLoading}
        />
      }
    />
  );
}

function ScopePicker({
  value,
  onChange,
  customers,
  loading,
}: {
  value: number | 'all';
  onChange: (next: number | 'all') => void;
  customers: readonly CustomerRow[];
  loading: boolean;
}) {
  const id = useId();
  const listed = value === 'all' || customers.some((c) => c.id === value);
  return (
    <div className="vm-scope-pick">
      <label className="dl-flabel" htmlFor={id}>
        Viewing
      </label>
      <select
        id={id}
        className="dl-input vm-scope-select"
        value={String(value)}
        onChange={(e) => onChange(e.target.value === 'all' ? 'all' : Number(e.target.value))}
      >
        <option value="all">All customers</option>
        {!listed && typeof value === 'number' && <option value={value}>{`Customer #${value}`}</option>}
        {loading && customers.length === 0 && <option disabled>Loading customers…</option>}
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.status !== 'active' ? ` (${c.status})` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
