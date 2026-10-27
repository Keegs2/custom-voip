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
 *   admin (normal view)               → AdminVoicemailConsole, prompt-first
 *                                        like the RCF console, Reporting and IVR:
 *        no ?customer                   the header's "Viewing" picker + "Select a
 *                                        customer to see their voicemail" (nothing loads)
 *        ?customer=all                  every customer's mailboxes
 *        ?customer=<id>                 that customer
 *   support / login with no account   → their productHome (the API answers
 *                                        403 for support)
 *
 * The product UI lives in pages/voicemail/ (VoicemailWorkspace and friends);
 * styles are `vm-*` in styles/dl-voicemail.css on the daylight `dl-*` system,
 * themed light / dark through the `--t-*` tokens (docker/ui/CLAUDE.md §18).
 */
import { useCallback, useId, useMemo, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { AdminCustomerPicker, type AdminCustomerValue } from '../components/AdminCustomerPicker';
import { AdminScopePrompt } from '../components/AdminScopePrompt';
import { CompactHeader } from '../components/layout/kit';
import { useAuth, type EffectiveCustomer } from '../contexts/AuthContext';
import { productHome } from '../utils/productHome';
import { PreviewPrompt } from './dashboard/PreviewPrompt';
import { useAdminCustomers, type CustomerRow } from './dashboard/adminData';
import { EncryptionBadge } from './voicemail/EncryptionBadge';
import { VoicemailWorkspace } from './voicemail/VoicemailWorkspace';
import { staffScope, tenantScope } from './voicemail/voicemailData';
import '../styles/dl-voicemail.css';

const SUBTITLE = 'Listen to messages, set your greeting, and keep every mailbox tidy — from any browser.';

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

/** `?customer=` → null (absent / junk: nothing chosen yet), 'all', or a customer id. */
function parseScope(raw: string | null): AdminCustomerValue {
  if (raw === 'all') return 'all';
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

function AdminVoicemailConsole() {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const [params, setParams] = useSearchParams();
  const customers = useAdminCustomers(true);
  const value = parseScope(params.get('customer'));

  const select = useCallback(
    (next: number | 'all') => {
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        p.set('customer', String(next));
        return p;
      });
    },
    [setParams],
  );

  // ── Derived (after all hooks) ──
  const listed = typeof value === 'number' ? customers.data?.find((c) => c.id === value) : undefined;
  const name = typeof value === 'number' ? (listed?.name ?? `Customer #${value}`) : null;
  const picker = (
    <ScopePicker value={value} onChange={select} customers={customers.data} loading={customers.isLoading} error={customers.isError} />
  );

  if (value === null) return <VoicemailScopePrompt picker={picker} />;

  return (
    <AdminVoicemailWorkspace
      key={value === 'all' ? 'all' : `c-${value}`}
      value={value}
      name={name}
      picker={picker}
    />
  );
}

/** One scope's workspace — keyed by the caller, so a switch remounts it. */
function AdminVoicemailWorkspace({ value, name, picker }: { value: number | 'all'; name: string | null; picker: ReactNode }) {
  const scope = useMemo(() => staffScope(value), [value]);
  return (
    <VoicemailWorkspace
      scope={scope}
      viewer="admin"
      canEdit
      canManage
      crumb={name ?? 'All customers'}
      tag="Staff"
      createFor={typeof value === 'number' && name ? { id: value, name } : null}
      showCustomer={value === 'all'}
      tools={picker}
    />
  );
}

/** Nothing chosen yet: the workspace's header (with the picker) over the prompt card. Nothing loads. */
function VoicemailScopePrompt({ picker }: { picker: ReactNode }) {
  return (
    <div className="dl-scope vm-scope">
      <div className="dl-shell vm-shell">
        <CompactHeader
          className="vm-header fx-load"
          crumb={
            <>
              <span>Visual Voicemail</span>
              <span className="vm-staff-tag">Staff</span>
            </>
          }
          title="Voicemail"
          titleAside={<EncryptionBadge />}
          subtitle={SUBTITLE}
          tools={picker}
        />
        <div className="vm-body fx-load fx-load-d1">
          <AdminScopePrompt title="Select a customer to see their voicemail" pickerLabel="Viewing" />
        </div>
      </div>
    </div>
  );
}

function ScopePicker({
  value,
  onChange,
  customers,
  loading,
  error,
}: {
  value: AdminCustomerValue;
  onChange: (next: number | 'all') => void;
  customers: readonly CustomerRow[] | undefined;
  loading: boolean;
  error: boolean;
}) {
  const id = useId();
  return (
    <div className="vm-scope-pick">
      <label className="dl-flabel" htmlFor={id}>
        Viewing
      </label>
      <AdminCustomerPicker
        id={id}
        className="dl-input vm-scope-select"
        value={value}
        onChange={onChange}
        customers={customers}
        loading={loading}
        error={error}
      />
    </div>
  );
}
