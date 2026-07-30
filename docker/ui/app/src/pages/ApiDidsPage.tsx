/**
 * ApiDidsPage — the customer-facing Programmable Voice portal.
 *
 * Full-width liquid-glass surface in the app blue. Gated to account types that
 * actually have programmable voice ({ api, hybrid }); every other account (and
 * an unauthenticated render) gets a safe "not available" state instead.
 *
 * Sections:
 *   1. API DIDs      — list this customer's API numbers; edit each DID's
 *                      voice / fallback / status-callback webhooks (ApiDidCard).
 *   2. API Keys      — mint / revoke HTTP-Basic key/secret pairs (ApiKeysPanel).
 *   3. Quickstart    — how to authenticate + the base API path (QuickstartNote).
 *
 * React #310: every hook is declared unconditionally at the very top of the
 * component, before any early return. This has bitten this repo three times.
 */

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PortalHeader } from './RcfPage';
import { useAuth } from '../contexts/AuthContext';
import { IconAPI } from '../components/icons/ProductIcons';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { Spinner } from '../components/ui/Spinner';
import { StatCard } from '../components/ui/StatCard';
import { Button } from '../components/ui/Button';
import { listApiDids } from '../api/apiDids';
import type { ApiDid } from '../types/apiDid';
import { ApiDidCard } from './ApiDidCard';
import { ApiKeysPanel } from './programmable-voice/ApiKeysPanel';
import { QuickstartNote } from './programmable-voice/QuickstartNote';

const ACCENT = '#3b82f6';

/** Account types that get the programmable-voice portal. */
const ALLOWED_ACCOUNT_TYPES = new Set(['api', 'hybrid']);

const CARD_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
  gap: 16,
};

export function ApiDidsPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { user, isAdmin } = useAuth();
  const [adminCustomerId, setAdminCustomerId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState('');

  const accountType = user?.account_type ?? null;
  const hasAccess = isAdmin || (accountType !== null && ALLOWED_ACCOUNT_TYPES.has(accountType));
  const canEdit = (user?.role ?? 'user') !== 'readonly';

  // Admins scope by the selector; regular customers are scoped server-side by token.
  const customerId = isAdmin ? adminCustomerId : (user?.customer_id ?? undefined);

  const {
    data: didData,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['api-dids', { customerId }],
    queryFn: () => listApiDids(customerId !== undefined ? { customer_id: customerId } : {}),
    enabled: hasAccess,
  });

  const dids: ApiDid[] = useMemo(() => didData?.items ?? [], [didData]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return dids;
    return dids.filter(
      (d) =>
        d.did.toLowerCase().includes(q) ||
        (d.voice_url ?? '').toLowerCase().includes(q) ||
        (d.customer_name ?? '').toLowerCase().includes(q),
    );
  }, [dids, search]);

  const activeCount = useMemo(() => dids.filter((d) => d.enabled).length, [dids]);

  // The account holder (api/hybrid) manages their own keys here. For admins
  // browsing customers, key management lives in the customer 360 — keep this
  // customer-facing surface unambiguous by only showing it to the holder.
  const showAccountPanels = !isAdmin && hasAccess;

  // ── Early returns AFTER all hooks ─────────────────────────────────────────
  if (!hasAccess) {
    return (
      <div>
        <PortalHeader
          icon={<IconAPI size={24} />}
          title={user?.customer_name ? `${user.customer_name}'s API Calling` : 'API Calling'}
          subtitle="Programmable voice with webhook-driven call control."
          badgeVariant="api"
        />
        <NotAvailableState />
      </div>
    );
  }

  return (
    <div>
      <PortalHeader
        icon={<IconAPI size={24} />}
        title={user?.customer_name ? `${user.customer_name}'s API Calling` : 'API Calling'}
        subtitle="Program your numbers with webhooks — inbound calls POST to your Voice URL and you return TwiML, with status callbacks and API keys to authenticate every request."
        badgeVariant="api"
      />

      {isAdmin && (
        <AdminCustomerSelector
          selectedCustomerId={adminCustomerId}
          onSelect={(id) => {
            setAdminCustomerId(id);
            setSearch('');
          }}
          accent={ACCENT}
          accountTypes={['api', 'hybrid']}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* ── API DIDs section ── */}
        <section>
          <SectionHeading
            title="API Numbers"
            subtitle="Edit the webhooks each number invokes when calls arrive."
          />

          {isLoading ? (
            <div className="flex items-center justify-center gap-3" style={{ padding: '48px 0' }}>
              <Spinner size="sm" />
              <span style={{ color: '#718096', fontSize: '0.9rem' }}>Loading numbers…</span>
            </div>
          ) : isError ? (
            <div className="glass-surface" style={{ padding: '40px 24px', textAlign: 'center', color: '#f87171', fontSize: '0.9rem' }}>
              Failed to load API numbers. Please try again.
            </div>
          ) : dids.length === 0 ? (
            <EmptyDids />
          ) : (
            <>
              {/* Stat row */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                  gap: 12,
                  marginBottom: 18,
                }}
              >
                <StatCard label="Total Numbers" value={dids.length} icon="#" />
                <StatCard label="Active" value={activeCount} icon="●" />
                <StatCard label="Disabled" value={dids.length - activeCount} icon="○" />
              </div>

              {/* Search */}
              <div style={{ marginBottom: 16 }}>
                <input
                  type="search"
                  value={search}
                  placeholder="Search numbers, webhooks…"
                  aria-label="Search API numbers"
                  onChange={(e) => setSearch(e.target.value)}
                  style={{
                    width: '100%',
                    maxWidth: 360,
                    fontSize: '0.85rem',
                    padding: '9px 14px',
                    borderRadius: 9,
                    border: '1px solid rgba(59,130,246,0.16)',
                    background: 'rgba(15,17,23,0.6)',
                    color: '#e2e8f0',
                    outline: 'none',
                  }}
                />
              </div>

              {filtered.length === 0 ? (
                <div className="glass-surface" style={{ padding: '32px 24px', textAlign: 'center' }}>
                  <p style={{ color: '#64748b', fontSize: '0.88rem', margin: '0 0 8px' }}>
                    No numbers match &ldquo;{search}&rdquo;
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => setSearch('')}>
                    Clear filter
                  </Button>
                </div>
              ) : (
                <div style={CARD_GRID}>
                  {filtered.map((did) => (
                    <ApiDidCard key={did.id} did={did} canEdit={canEdit} showCustomer={isAdmin} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        {/* ── API Keys section (account holder only) ── */}
        {showAccountPanels && <ApiKeysPanel canManage={canEdit} />}

        {/* ── Quickstart (account holder only) ── */}
        {showAccountPanels && <QuickstartNote />}
      </div>
    </div>
  );
}

/* ── Section heading ─────────────────────────────────────────────────────── */

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#e2e8f0', margin: 0, letterSpacing: '-0.01em' }}>
        {title}
      </h2>
      <p style={{ fontSize: '0.82rem', color: '#718096', margin: '3px 0 0' }}>{subtitle}</p>
    </div>
  );
}

/* ── Empty state (no DIDs) ───────────────────────────────────────────────── */

function EmptyDids() {
  return (
    <div
      className="glass-surface"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: '56px 24px',
        gap: 14,
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, ${ACCENT}22 0%, ${ACCENT}0d 100%)`,
          border: `1px solid ${ACCENT}33`,
          color: '#60a5fa',
        }}
        aria-hidden="true"
      >
        <IconAPI size={26} />
      </div>
      <div>
        <p style={{ color: '#94a3b8', fontSize: '0.95rem', fontWeight: 600, margin: '0 0 6px' }}>
          No API numbers yet
        </p>
        <p style={{ color: '#475569', fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 380 }}>
          Contact support to provision programmable-voice numbers for your account. Once assigned,
          you can point each number at your webhooks here.
        </p>
      </div>
    </div>
  );
}

/* ── Not-available gate ──────────────────────────────────────────────────── */

function NotAvailableState() {
  return (
    <div
      className="glass-surface"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 24px',
        textAlign: 'center',
        borderRadius: 20,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 24,
          background: `linear-gradient(135deg, ${ACCENT}26 0%, ${ACCENT}0d 100%)`,
          border: `1px solid ${ACCENT}40`,
          color: '#60a5fa',
          boxShadow: `0 0 24px ${ACCENT}2e`,
        }}
        aria-hidden="true"
      >
        <IconAPI size={30} />
      </div>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
        Not available for your account
      </h2>
      <p style={{ fontSize: '0.9rem', color: '#718096', maxWidth: 440, lineHeight: 1.6 }}>
        Programmable Voice (API Calling) is included with API and Hybrid plans. If you&apos;d like to
        add webhook-driven call control to your account, please contact support.
      </p>
    </div>
  );
}
