/**
 * /ivr — the Visual IVR product (docs/IVR_PRODUCT_PLAN.md §6,
 * docs/IVR_INTERFACES.md §8.2). Lazy-loaded; the flow builder (React Flow)
 * is a second lazy chunk under it, so neither reaches the main bundle.
 *
 * Full-bleed like TroubleshootingPage: rendered OUTSIDE AppLayout with its
 * own <Sidebar /> and the shared collapse tab, so the builder can use every
 * pixel. `.ivr-canvas` re-grounds the daylight `.dl-scope` for that layout.
 *
 * Who it is for — each view is KEYED by its scope, so a customer switch
 * remounts it (React #310; it also drops the builder's store):
 *
 *   tenant (user / readonly)          → own account (readonly = view only)
 *   admin in "View as Customer"       → the preview customer, staff controls
 *                                     → PreviewPrompt until one is picked
 *   admin (normal view)               → console, prompt-first like the RCF console,
 *                                       Voicemail and Reporting:
 *        no ?customer                     the header's Customer picker + "Select a
 *                                         customer to see their IVR" (nothing loads)
 *        ?customer=all                    every customer at a glance (IvrAllCustomers,
 *                                         GET /ivr/admin/overview); a row opens one
 *        ?customer=<id>                   that customer's IVR, builder included
 *   support / no account              → their productHome
 *
 * Routes inside: /ivr (numbers, flows, messages) and /ivr/flows/:flowId
 * (the builder).
 */
import { lazy, Suspense, useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useMatch, useParams, useSearchParams } from 'react-router-dom';
import { AdminCustomerPicker, type AdminCustomerValue } from '../components/AdminCustomerPicker';
import { AdminScopePrompt } from '../components/AdminScopePrompt';
import { CompactHeader } from '../components/layout/kit';
import { Sidebar } from '../components/layout/Sidebar';
import { SidebarCollapseTab } from '../components/layout/SidebarCollapse';
import { useSidebarCollapse } from '../components/layout/useSidebarCollapse';
import { Spinner } from '../components/ui/Spinner';
import { useAuth, type EffectiveCustomer } from '../contexts/AuthContext';
import { productHome } from '../utils/productHome';
import { cn } from '../utils/cn';
import { PreviewPrompt } from './dashboard/PreviewPrompt';
import { useAdminCustomers, type CustomerRow } from './dashboard/adminData';
import { IvrAllCustomers } from './ivr/IvrAllCustomers';
import { IvrHome } from './ivr/IvrHome';
import { IvrWorkspaceContext, useIvrWorkspace, type IvrWorkspace } from './ivr/IvrContext';
import { ivrStaffScope, ivrTenantScope } from './ivr/ivrData';
import '../styles/dl-voicemail.css';
import '../styles/ivr.css';

// The builder is its own chunk: React Flow + the canvas load only when a flow opens.
const FlowBuilderRoute = lazy(() => import('../flow/FlowBuilderRoute').then((m) => ({ default: m.FlowBuilderRoute })));

export function IvrPage() {
  const { collapsed: navCollapsed, toggleCollapsed } = useSidebarCollapse();
  // Focus mode: inside the builder the app sidebar starts tucked away so the
  // canvas gets the width. Session-only — the saved preference (shared with
  // every other page) is never changed by it; the edge tab brings it back.
  const inBuilder = useMatch('/ivr/flows/:flowId') !== null;
  const [builderNavOpen, setBuilderNavOpen] = useState(false);
  const collapsed = inBuilder ? !builderNavOpen : navCollapsed;
  const toggle = inBuilder ? () => setBuilderNavOpen((o) => !o) : toggleCollapsed;
  return (
    <>
      <Sidebar collapsed={collapsed} />
      <SidebarCollapseTab collapsed={collapsed} onToggle={toggle} />
      <div className={cn('dl-scope vm-scope ivr-scope ivr-canvas', collapsed && 'ivr-canvas--collapsed')}>
        <IvrWho />
      </div>
    </>
  );
}

function IvrWho() {
  const { user, isAdmin, isActualAdmin, isSupport, customerViewMode, effectiveCustomer } = useAuth();
  if (isSupport) return <Navigate to={productHome(user, isAdmin)} replace />;
  if (!isAdmin && effectiveCustomer) {
    return (
      <CustomerIvr
        key={`ivr-${effectiveCustomer.id}-${isActualAdmin ? 'staff' : 'tenant'}`}
        customer={effectiveCustomer}
        staff={isActualAdmin}
        readonly={!isActualAdmin && user?.role !== 'user'}
      />
    );
  }
  if (isActualAdmin && customerViewMode) {
    return (
      <div className="ivr-prompt-wrap">
        <PreviewPrompt />
      </div>
    );
  }
  if (isAdmin) return <AdminIvrConsole />;
  return <Navigate to={productHome(user, isAdmin)} replace />;
}

const keepPath = (path: string) => path;

/* ─── Customer view (tenant, or staff previewing one) ─────── */

function CustomerIvr({ customer, staff, readonly }: { customer: EffectiveCustomer; staff: boolean; readonly: boolean }) {
  const workspace = useMemo<IvrWorkspace>(
    () => ({
      scope: staff ? ivrStaffScope(customer.id) : ivrTenantScope(customer.id),
      viewer: staff ? 'preview' : 'tenant',
      staff,
      canEdit: staff || !readonly,
      customerName: customer.name || 'Your account',
      href: keepPath,
    }),
    [customer.id, customer.name, staff, readonly],
  );
  return (
    <IvrWorkspaceContext.Provider value={workspace}>
      <IvrRoutes />
    </IvrWorkspaceContext.Provider>
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

const IVR_SUBTITLE = 'Design what callers hear when they dial your IVR numbers — menus, business hours and transfers.';

function AdminIvrConsole() {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const [params, setParams] = useSearchParams();
  const customers = useAdminCustomers(true);
  const value = parseScope(params.get('customer'));
  const customerId = typeof value === 'number' ? value : null;
  const pickerId = useId();

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

  const name =
    customerId !== null ? (customers.data?.find((c) => c.id === customerId)?.name ?? `Customer #${customerId}`) : null;

  const workspace = useMemo<IvrWorkspace | null>(
    () =>
      customerId === null
        ? null
        : {
            scope: ivrStaffScope(customerId),
            viewer: 'admin',
            staff: true,
            canEdit: true,
            customerName: name ?? `Customer #${customerId}`,
            href: (path: string) => `${path}${path.includes('?') ? '&' : '?'}customer=${customerId}`,
          },
    [customerId, name],
  );

  const picker = (
    <CustomerPicker
      id={pickerId}
      value={value}
      onChange={select}
      customers={customers.data}
      loading={customers.isLoading}
      error={customers.isError}
    />
  );

  if (value === null) {
    // Nothing chosen yet: header + prompt; any inner path (an old builder link) lands here.
    return (
      <Routes>
        <Route index element={<IvrScopePrompt picker={picker} />} />
        <Route path="*" element={<Navigate to="/ivr" replace />} />
      </Routes>
    );
  }
  if (value === 'all' || !workspace) {
    return (
      <Routes>
        <Route index element={<IvrAllCustomers picker={picker} />} />
        <Route path="*" element={<Navigate to="/ivr?customer=all" replace />} />
      </Routes>
    );
  }
  return (
    <IvrWorkspaceContext.Provider value={workspace}>
      <IvrRoutes key={workspace.scope.key} staffPicker={picker} />
    </IvrWorkspaceContext.Provider>
  );
}

/** The /ivr header (crumb · title · the Customer picker) over the "pick a customer" card. Nothing loads. */
function IvrScopePrompt({ picker }: { picker: ReactNode }) {
  return (
    <div className="dl-shell ivr-shell">
      <CompactHeader
        className="ivr-header fx-load"
        crumb={
          <>
            <span>IVR</span>
            <span className="vm-staff-tag">Staff</span>
          </>
        }
        title="IVR"
        subtitle={IVR_SUBTITLE}
        tools={picker}
      />
      <div className="ivr-sections fx-load fx-load-d1">
        <AdminScopePrompt title="Select a customer to see their IVR" pickerLabel="Customer" />
      </div>
    </div>
  );
}

function CustomerPicker({
  id,
  value,
  onChange,
  customers,
  loading,
  error,
}: {
  id: string;
  value: AdminCustomerValue;
  onChange: (next: number | 'all') => void;
  customers: readonly CustomerRow[] | undefined;
  loading: boolean;
  error: boolean;
}) {
  return (
    <div className="ivr-scope-pick">
      <label className="ivr-label" htmlFor={id}>
        Customer
      </label>
      <AdminCustomerPicker
        id={id}
        className="dl-input ivr-scope-select"
        value={value}
        onChange={onChange}
        customers={customers}
        loading={loading}
        error={error}
      />
    </div>
  );
}

/* ─── Inner routes ────────────────────────────────────────── */

function IvrRoutes({ staffPicker }: { staffPicker?: ReactNode }) {
  return (
    <Routes>
      <Route index element={<IvrHome staffPicker={staffPicker} />} />
      <Route
        path="flows/:flowId"
        element={
          <Suspense fallback={<BuilderFallback />}>
            <FlowIdRoute />
          </Suspense>
        }
      />
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}

function HomeRedirect() {
  const { href } = useIvrWorkspace();
  return <Navigate to={href('/ivr')} replace />;
}

function FlowIdRoute() {
  const { flowId } = useParams();
  const id = flowId && /^\d{1,12}$/.test(flowId) ? Number(flowId) : null;
  if (id === null) return <HomeRedirect />;
  // Keyed: opening another flow is a fresh builder (fresh store, fresh history).
  return <FlowBuilderRoute key={id} flowId={id} />;
}

function BuilderFallback() {
  return (
    <div className="ivr-route-fallback" role="status" aria-label="Loading the builder">
      <Spinner /> Loading the builder…
    </div>
  );
}
