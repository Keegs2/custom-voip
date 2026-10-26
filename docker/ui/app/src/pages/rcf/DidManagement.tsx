/**
 * DID management — the customer's number inventory: their assigned numbers
 * (with request / cancel release), pending requests, and the available pool
 * they can request from. Extracted verbatim from RcfPage so both the admin
 * console's "DID Management" tab and the customer dashboard's "Manage
 * numbers" overlay render the same component.
 *
 * Colours are theme tokens (docker/ui/CLAUDE.md §18): `T` / `tMix` and the
 * rcf `theme.ts` palette for inline styles, `.rcf-dialog*` (index.css) for
 * the two confirmation dialogs. Light resolves to exactly the daylight
 * values; dark to the granite set.
 */
import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Spinner } from '../../components/ui/Spinner';
import { Reveal } from '../../components/fx/Reveal';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../components/ui/Toast';
import { fmt } from '../../utils/format';
import { productTag } from '../../config/products';
import {
  listAvailableDids,
  listMyDids,
  requestDid,
  requestDidRelease,
  cancelDidRelease,
} from '../../api/didInventory';
import type { DidInventoryItem } from '../../types/didInventory';
import { extractNpa, extractNxx } from './didFormat';
import { T, TONE, tMix } from '../../styles/theme';
import {
  AZURE_DEEP, DL, GREEN, INK, INK_DIM, INK_FAINT, INK_SOFT, MONO, RED,
} from './theme';

/** A translucent wash of a `var()` colour that isn't a theme token (the DL palette). */
function mixVar(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

// ─── DIDManagementTab ─────────────────────────────────────────────────────────

// ── Filter bar ────────────────────────────────────────────────────────────────

interface DidFilterState {
  npa: string;
  nxx: string;
  state: string;
  search: string;
}

interface DidFilterBarProps {
  filters: DidFilterState;
  onFiltersChange: (filters: DidFilterState) => void;
  availableStates: string[];
  resultCount: number;
  totalCount: number;
  compact?: boolean;
}

function DidFilterBar({
  filters,
  onFiltersChange,
  availableStates,
  resultCount,
  totalCount,
  compact = false,
}: DidFilterBarProps) {
  const hasActive = filters.npa || filters.nxx || filters.state || filters.search;

  // Inline toolbar label — same voice as the Numbers-tab NPA filter.
  const labelStyle: React.CSSProperties = {
    fontSize: '0.68rem',
    fontWeight: 700,
    color: INK_DIM,
    whiteSpace: 'nowrap',
    letterSpacing: '0.06em',
  };

  return (
    <div
      style={{
        padding: compact ? '12px 16px' : '14px 20px',
        borderBottom: '1px solid var(--rcf-line)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        background: 'var(--rcf-tint)',
      }}
    >
      {/* Free text search — leads the toolbar, same composition as the Numbers tab */}
      <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
        <span
          aria-hidden="true"
          style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: T.fieldPlaceholder, display: 'flex', alignItems: 'center', pointerEvents: 'none' }}
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
            <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <input
          type="text"
          className="rcf-input"
          value={filters.search}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
          placeholder="Filter by city, rate center, or number…"
          aria-label="Search numbers"
          style={{ width: '100%', padding: '9px 12px 9px 36px' }}
        />
      </div>

      {/* NPA (area code) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <label style={labelStyle}>NPA</label>
        <input
          type="text"
          className="rcf-input rcf-input-mono"
          value={filters.npa}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 3);
            onFiltersChange({ ...filters, npa: v });
          }}
          placeholder="617"
          maxLength={3}
          inputMode="numeric"
          title="Filter by area code (NPA)"
          style={{
            width: 58,
            padding: '9px 8px',
            textAlign: 'center',
            letterSpacing: '0.08em',
            color: filters.npa.length === 3 ? AZURE_DEEP : undefined,
            borderColor: filters.npa.length === 3 ? tMix('accent-line', 55) : undefined,
          }}
        />
      </div>

      {/* NXX (exchange) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <label style={labelStyle}>NXX</label>
        <input
          type="text"
          className="rcf-input rcf-input-mono"
          value={filters.nxx}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 3);
            onFiltersChange({ ...filters, nxx: v });
          }}
          placeholder="454"
          maxLength={3}
          inputMode="numeric"
          title="Filter by exchange (NXX)"
          style={{
            width: 58,
            padding: '9px 8px',
            textAlign: 'center',
            letterSpacing: '0.08em',
            color: filters.nxx.length === 3 ? AZURE_DEEP : undefined,
            borderColor: filters.nxx.length === 3 ? tMix('accent-line', 55) : undefined,
          }}
        />
      </div>

      {/* State */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <label style={labelStyle}>STATE</label>
        <select
          className="rcf-input"
          value={filters.state}
          onChange={(e) => onFiltersChange({ ...filters, state: e.target.value })}
          aria-label="Filter by state"
          style={{ padding: '9px 32px 9px 12px', minWidth: 96, fontSize: '0.8rem' }}
        >
          <option value="">All</option>
          {availableStates.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* Result count pill — azure only when a filter narrows the set */}
      <div style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            fontSize: '0.72rem',
            fontWeight: 600,
            color: hasActive ? AZURE_DEEP : INK_DIM,
            background: hasActive ? tMix('accent-line', 8) : T.surface,
            border: `1px solid ${hasActive ? tMix('accent-line', 22) : DL.ctlBorder}`,
            borderRadius: 20,
            padding: '5px 13px',
            whiteSpace: 'nowrap',
            letterSpacing: '0.02em',
            transition: 'color var(--rcf-ease), background var(--rcf-ease), border-color var(--rcf-ease)',
          }}
        >
          {hasActive ? `${resultCount} of ${totalCount} shown` : `${totalCount} total`}
        </span>

        {/* Clear all */}
        {hasActive && (
          <button
            type="button"
            onClick={() => onFiltersChange({ npa: '', nxx: '', state: '', search: '' })}
            style={{
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: INK_DIM,
              fontSize: '0.72rem',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/** Apply DID filters (AND logic) to an array of inventory items */
function applyDidFilters(items: DidInventoryItem[], filters: DidFilterState): DidInventoryItem[] {
  return items.filter((item) => {
    if (filters.npa && extractNpa(item.did) !== filters.npa) return false;
    if (filters.nxx && extractNxx(item.did) !== filters.nxx) return false;
    if (filters.state && item.state !== filters.state) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const matches =
        item.did.includes(q) ||
        (item.city ?? '').toLowerCase().includes(q) ||
        (item.rate_center ?? '').toLowerCase().includes(q) ||
        fmt(item.did).toLowerCase().includes(q);
      if (!matches) return false;
    }
    return true;
  });
}

/** Extract unique sorted states from an array of inventory items */
function extractStates(items: DidInventoryItem[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    if (item.state) set.add(item.state);
  }
  return [...set].sort();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function didStatusBadge(status: DidInventoryItem['status']): React.ReactNode {
  const styles: Record<
    DidInventoryItem['status'],
    { bg: string; color: string; border: string; label: string }
  > = {
    available:   { bg: T.accentTint,                 color: AZURE_DEEP, border: tMix('accent-line', 28),  label: 'Available' },
    assigned:    { bg: TONE.ok.bg,                   color: GREEN,      border: tMix('ok-solid', 28),     label: 'Assigned' },
    reserved:    { bg: tMix('neutral-fg', 12),       color: INK_SOFT,   border: tMix('neutral-fg', 30),   label: 'Pending Approval' },
    porting_in:  { bg: tMix('accent-text', 7),       color: AZURE_DEEP, border: tMix('accent-text', 24),  label: 'Porting In' },
    porting_out: { bg: tMix('accent-text', 7),       color: AZURE_DEEP, border: tMix('accent-text', 24),  label: 'Porting Out' },
    suspended:   { bg: TONE.danger.bg,               color: RED,        border: TONE.danger.border,       label: 'Suspended' },
    // Sky pending state — the release is in flight, awaiting engineering review
    release_requested: { bg: mixVar(DL.skySolid, 8), color: DL.sky,    border: mixVar(DL.skySolid, 28),  label: 'Release Requested' },
  };
  const s = styles[status] ?? styles.available;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: '0.64rem',
        fontWeight: 700,
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 999,
        padding: '3px 10px',
        whiteSpace: 'nowrap',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: s.color,
          flexShrink: 0,
          display: 'inline-block',
        }}
      />
      {s.label}
    </span>
  );
}

function fmtAssignedDate(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Panel wrapper shared across sections — scroll-revealed slab ───────────────

function DidCard({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  return (
    <Reveal delay={delay} className="rcf-panel">
      {children}
    </Reveal>
  );
}

// ── Section header bar ────────────────────────────────────────────────────────

function DidSectionHeader({
  title,
  count,
  countLabel,
  right,
}: {
  title: string;
  count?: number;
  countLabel?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="rcf-panel-head">
      <span className="rcf-panel-title">{title}</span>
      {count !== undefined && (
        <span className="rcf-count">
          {count} {countLabel ?? ''}
        </span>
      )}
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  );
}

// ── Th helper for DID tables ──────────────────────────────────────────────────

function DidTh({ children }: { children?: React.ReactNode }) {
  return <th className="rcf-th">{children}</th>;
}

// ── Request confirmation modal ────────────────────────────────────────────────

interface RequestModalProps {
  did: DidInventoryItem | null;
  onConfirm: (did: DidInventoryItem) => void;
  onCancel: () => void;
  isPending: boolean;
}

function RequestModal({ did, onConfirm, onCancel, isPending }: RequestModalProps) {
  if (!did) return null;
  return (
    <div
      className="rcf-dialog-scrim"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        animation: 'fx-fade 0.15s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !isPending) onCancel(); }}
    >
      <div
        className="rcf-dialog"
        style={{
          borderRadius: 14,
          padding: '30px 32px 26px',
          maxWidth: 420,
          width: '100%',
          position: 'relative',
          animation: 'fx-rise 0.2s ease',
          fontFamily: '"Public Sans", "IBM Plex Sans", -apple-system, sans-serif',
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: DL.iconWash,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 18,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.6} style={{ width: 24, height: 24, stroke: AZURE_DEEP }}>
            <path d="M3 5a2 2 0 0 1 2-2h3.28a1 1 0 0 1 .948.684l1.498 4.493a1 1 0 0 1-.502 1.21l-2.257 1.13a11.042 11.042 0 0 0 5.516 5.516l1.13-2.257a1 1 0 0 1 1.21-.502l4.493 1.498a1 1 0 0 1 .684.949V19a2 2 0 0 1-2 2h-1C9.716 21 3 14.284 3 6V5z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div style={{ fontSize: '1.05rem', fontWeight: 800, color: INK, marginBottom: 8, letterSpacing: '-0.02em', fontFamily: '"Archivo", "IBM Plex Sans", sans-serif' }}>
          Request this number?
        </div>
        <div style={{ fontSize: '0.84rem', color: INK_SOFT, marginBottom: 18, lineHeight: 1.6 }}>
          You are requesting{' '}
          <span style={{ color: AZURE_DEEP, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {fmt(did.did)}
          </span>
          {did.city || did.state ? (
            <>
              {' '}({[did.city, did.state].filter(Boolean).join(', ')})
            </>
          ) : null}
          {' '}for your account. An admin will review and approve the assignment.
        </div>

        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: DL.noteWash,
            border: `1px solid ${tMix('accent-line', 20)}`,
            marginBottom: 22,
            fontSize: '0.78rem',
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: AZURE_DEEP, fontWeight: 700 }}>Note: </span>
          <span style={{ color: INK_SOFT }}>
            Granite reviews requests — you’ll see this number under Pending Requests until it’s approved.
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="rcf-btn rcf-btn-ghost"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rcf-btn rcf-btn-primary"
            onClick={() => onConfirm(did)}
            disabled={isPending}
          >
            {isPending && (
              <svg viewBox="0 0 16 16" style={{ width: 13, height: 13, animation: 'fx-spin 0.7s linear infinite' }}>
                <circle cx="8" cy="8" r="6" fill="none" style={{ stroke: tMix('text-on-accent', 35) }} strokeWidth={2} />
                <path d="M8 2a6 6 0 0 1 6 6" style={{ stroke: T.textOnAccent }} strokeWidth={2} fill="none" strokeLinecap="round" />
              </svg>
            )}
            {isPending ? 'Requesting…' : 'Confirm Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Request-release confirmation modal ────────────────────────────────────────
// Non-destructive: forwarding keeps working until an administrator approves the
// release, so this is a simple confirm — no destructive-action theatrics.

interface RequestReleaseModalProps {
  did: DidInventoryItem | null;
  onConfirm: (did: DidInventoryItem) => void;
  onCancel: () => void;
  isPending: boolean;
}

function RequestReleaseModal({ did, onConfirm, onCancel, isPending }: RequestReleaseModalProps) {
  if (!did) return null;
  return (
    <div
      className="rcf-dialog-scrim rcf-dialog-scrim-strong"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backdropFilter: 'blur(5px)',
        WebkitBackdropFilter: 'blur(5px)',
        animation: 'fx-fade 0.15s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !isPending) onCancel(); }}
    >
      <div
        className="rcf-dialog rcf-dialog-strong"
        style={{
          borderRadius: 14,
          padding: '30px 32px 26px',
          maxWidth: 440,
          width: '100%',
          position: 'relative',
          animation: 'fx-rise 0.2s ease',
          fontFamily: '"Public Sans", "IBM Plex Sans", -apple-system, sans-serif',
        }}
      >
        {/* Outbound-arrow icon — a request leaving for review */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: DL.iconWash,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 18,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.7} style={{ width: 24, height: 24, stroke: AZURE_DEEP }}>
            <path d="M7 17L17 7M17 7H9M17 7v8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div style={{ fontSize: '1.08rem', fontWeight: 800, color: INK, marginBottom: 6, letterSpacing: '-0.02em', fontFamily: '"Archivo", "IBM Plex Sans", sans-serif' }}>
          Request Number Release
        </div>

        {/* DID displayed prominently — body font per the table standard */}
        <div
          style={{
            fontSize: '1.3rem',
            fontWeight: 700,
            color: AZURE_DEEP,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.01em',
            marginBottom: 16,
          }}
        >
          {fmt(did.did)}
        </div>

        <div style={{ fontSize: '0.83rem', color: INK_SOFT, marginBottom: 14, lineHeight: 1.6 }}>
          Release requests are routed to Granite engineering for review — call forwarding
          continues to work until the release is approved.
        </div>

        <div
          style={{
            padding: '13px 16px',
            borderRadius: 10,
            background: tMix('accent-line', 5),
            border: `1px solid ${tMix('accent-line', 18)}`,
            marginBottom: 24,
            fontSize: '0.81rem',
            lineHeight: 1.6,
          }}
        >
          <span style={{ color: AZURE_DEEP, fontWeight: 700 }}>Note: </span>
          <span style={{ color: INK_SOFT }}>
            You can cancel the request at any time before it is approved. Once approved,
            the number returns to the available pool and forwarding stops.
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="rcf-btn rcf-btn-ghost"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rcf-btn rcf-btn-primary"
            onClick={() => onConfirm(did)}
            disabled={isPending}
          >
            {isPending && (
              <svg viewBox="0 0 16 16" style={{ width: 13, height: 13, animation: 'fx-spin 0.7s linear infinite' }}>
                <circle cx="8" cy="8" r="6" fill="none" style={{ stroke: tMix('text-on-accent', 35) }} strokeWidth={2} />
                <path d="M8 2a6 6 0 0 1 6 6" style={{ stroke: T.textOnAccent }} strokeWidth={2} fill="none" strokeLinecap="round" />
              </svg>
            )}
            {isPending ? 'Submitting…' : 'Request Release'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── My Numbers section ────────────────────────────────────────────────────────

interface MyNumbersSectionProps {
  items: DidInventoryItem[];
  isLoading: boolean;
  isError: boolean;
  /**
   * Request Release / Cancel Request are shown only to the tenant `user` role
   * (like Request on Available Numbers) — readonly tenants and staff never
   * see them; the API answers 403 to anyone else.
   */
  canRelease: boolean;
  onRequestRelease: (item: DidInventoryItem) => void;
  onCancelRelease: (item: DidInventoryItem) => void;
  cancelingDid: string | null;
  onSwitchToNumbers: () => void;
}

function MyNumbersSection({
  items,
  isLoading,
  isError,
  canRelease,
  onRequestRelease,
  onCancelRelease,
  cancelingDid,
  onSwitchToNumbers,
}: MyNumbersSectionProps) {
  // ALL hooks unconditionally at top
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filters, setFilters] = useState<DidFilterState>({ npa: '', nxx: '', state: '', search: '' });

  const availableStates = useMemo(() => extractStates(items), [items]);

  const filtered = useMemo(() => applyDidFilters(items, filters), [items, filters]);

  if (isLoading) {
    return (
      <DidCard>
        <DidSectionHeader title="My Numbers" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '48px 0', color: INK_DIM }}>
          <Spinner size="sm" />
          <span style={{ fontSize: '0.875rem' }}>Loading your numbers…</span>
        </div>
      </DidCard>
    );
  }

  if (isError) {
    return (
      <DidCard>
        <DidSectionHeader title="My Numbers" />
        <div style={{ padding: '16px 20px', margin: 16, borderRadius: 10, background: tMix('danger-solid', 6), border: `1px solid ${tMix('danger-solid', 20)}`, color: RED, fontSize: '0.85rem' }}>
          Unable to load your numbers. Please try refreshing.
        </div>
      </DidCard>
    );
  }

  return (
    <DidCard delay={0}>
      <DidSectionHeader
        title="My Numbers"
        count={items.length}
        countLabel={items.length === 1 ? 'number' : 'numbers'}
      />

      {items.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '56px 24px',
            gap: 14,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: DL.iconWash,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.5} style={{ width: 28, height: 28, stroke: AZURE_DEEP }}>
              <path d="M3 5a2 2 0 0 1 2-2h3.28a1 1 0 0 1 .948.684l1.498 4.493a1 1 0 0 1-.502 1.21l-2.257 1.13a11.042 11.042 0 0 0 5.516 5.516l1.13-2.257a1 1 0 0 1 1.21-.502l4.493 1.498a1 1 0 0 1 .684.949V19a2 2 0 0 1-2 2h-1C9.716 21 3 14.284 3 6V5z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p style={{ color: INK, fontSize: '0.95rem', fontWeight: 700, margin: '0 0 6px' }}>
              No numbers assigned yet
            </p>
            <p style={{ color: INK_DIM, fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 360 }}>
              Browse the available numbers below and request one for your account. Assignments are approved by our team — usually within one business day.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Filter bar */}
          <DidFilterBar
            filters={filters}
            onFiltersChange={setFilters}
            availableStates={availableStates}
            resultCount={filtered.length}
            totalCount={items.length}
          />

          {filtered.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '40px 24px',
                gap: 10,
                textAlign: 'center',
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.5} style={{ width: 28, height: 28, stroke: DL.slateSoft }}>
                <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p style={{ color: INK_SOFT, fontSize: '0.85rem', fontWeight: 500, margin: 0 }}>
                No numbers match these filters
              </p>
              <button
                type="button"
                onClick={() => setFilters({ npa: '', nxx: '', state: '', search: '' })}
                style={{ background: 'transparent', border: 'none', color: AZURE_DEEP, fontSize: '0.78rem', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', padding: 0 }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    <th className="rcf-th" style={{ width: 34, padding: '11px 4px 11px 18px' }} aria-label="Expand" />
                    <DidTh>Number</DidTh>
                    <DidTh>Location</DidTh>
                    <DidTh>Product</DidTh>
                    <DidTh>Status</DidTh>
                    <DidTh>Assigned</DidTh>
                    {canRelease && <th className="rcf-th" aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => {
                    const isExpanded = expandedId === item.id;
                    const location = [item.city, item.state].filter(Boolean).join(', ');
                    const pendingRelease = item.status === 'release_requested';
                    return (
                      <Fragment key={item.id}>
                        <tr
                          className={`rcf-row rcf-nrow${isExpanded ? ' rcf-nrow-open' : ''}`}
                          role="button"
                          tabIndex={0}
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedId(isExpanded ? null : item.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(isExpanded ? null : item.id); }
                            if (e.key === 'Escape' && isExpanded) { e.preventDefault(); setExpandedId(null); }
                          }}
                        >
                          {/* Chevron affordance — same glyph family as the Numbers table */}
                          <td style={{ padding: '15px 4px 15px 18px', width: 34 }}>
                            <svg
                              viewBox="0 0 16 16"
                              fill="none"
                              strokeWidth={1.75}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className={`rcf-chev${isExpanded ? ' rcf-chev-open' : ''}`}
                              style={{ width: 13, height: 13, stroke: isExpanded ? AZURE_DEEP : INK_FAINT }}
                            >
                              <path d="M6 3l5 5-5 5" />
                            </svg>
                          </td>

                          {/* Number — quiets to slate while a release is pending */}
                          <td style={{ padding: '15px 16px', whiteSpace: 'nowrap' }}>
                            <span style={{ fontSize: '0.92rem', fontWeight: 600, color: pendingRelease ? INK_SOFT : INK, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
                              {fmt(item.did)}
                            </span>
                          </td>

                          {/* Location — city/state merged, quiet em-dash when unknown */}
                          <td style={{ padding: '15px 16px' }}>
                            <span style={{ fontSize: '0.85rem', color: location ? INK_SOFT : DL.slateMute, whiteSpace: 'nowrap' }}>
                              {location || '—'}
                            </span>
                          </td>

                          <td style={{ padding: '15px 16px' }}>
                            <span className="dl-tag">{productTag(item.product_type ?? 'rcf')}</span>
                          </td>
                          <td style={{ padding: '15px 16px' }}>
                            {didStatusBadge(item.status)}
                          </td>
                          <td style={{ padding: '15px 16px' }}>
                            <span style={{ fontSize: '0.8rem', color: INK_DIM, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {fmtAssignedDate(item.assigned_at)}
                            </span>
                          </td>

                          {/* Release action — request flow (pending state shows Cancel); tenant `user` role only */}
                          {canRelease && (
                          <td style={{ padding: '11px 18px 11px 16px', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                            {pendingRelease ? (
                              <button
                                type="button"
                                className="rcf-btn rcf-btn-ghost"
                                style={{ padding: '7px 14px', fontSize: '0.74rem', gap: 6, whiteSpace: 'nowrap', color: AZURE_DEEP, borderColor: tMix('accent-line', 35) }}
                                onClick={() => onCancelRelease(item)}
                                disabled={cancelingDid === item.did}
                                title="Withdraw the pending release request — the number stays assigned"
                              >
                                {cancelingDid === item.did ? (
                                  <svg viewBox="0 0 16 16" style={{ width: 11, height: 11, animation: 'fx-spin 0.7s linear infinite' }}>
                                    <circle cx="8" cy="8" r="6" fill="none" style={{ stroke: tMix('accent-line', 30) }} strokeWidth={2} />
                                    <path d="M8 2a6 6 0 0 1 6 6" style={{ stroke: AZURE_DEEP }} strokeWidth={2} fill="none" strokeLinecap="round" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 11, height: 11 }}>
                                    <path d="M6 4L2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 0 7H8" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                )}
                                Cancel Request
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="rcf-btn rcf-btn-ghost"
                                style={{ padding: '7px 14px', fontSize: '0.74rem', gap: 6, whiteSpace: 'nowrap' }}
                                onClick={() => onRequestRelease(item)}
                                title="Request release of this number — reviewed by Granite engineering"
                              >
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 11, height: 11 }}>
                                  <path d="M4 12L12 4M12 4H6M12 4v6" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                                Request Release
                              </button>
                            )}
                          </td>
                          )}
                        </tr>

                        {/* Expanded detail panel */}
                        {isExpanded && (
                          <tr>
                            <td
                              colSpan={canRelease ? 7 : 6}
                              style={{
                                padding: '0 20px 20px 20px',
                                background: DL.well,
                              }}
                            >
                              {/* Detail panel */}
                              <div
                                style={{
                                  background: T.surface,
                                  border: `1px solid ${DL.rule}`,
                                  borderRadius: 12,
                                  padding: '20px 22px',
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                                  gap: 16,
                                  position: 'relative',
                                  overflow: 'hidden',
                                  boxShadow: DL.detailShadow,
                                }}
                              >
                                {/* Top accent line */}
                                <div
                                  style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 32,
                                    right: 32,
                                    height: 2,
                                    background: `linear-gradient(90deg, transparent, ${DL.detailLine}, transparent)`,
                                  }}
                                />

                                {/* DID large */}
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: INK_FAINT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                    Number
                                  </div>
                                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color: AZURE_DEEP, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>
                                    {fmt(item.did)}
                                  </div>
                                  {/* Raw E.164 — detail context only */}
                                  <div style={{ fontSize: '0.68rem', color: INK_DIM, fontFamily: MONO, marginTop: 3 }}>
                                    {item.did}
                                  </div>
                                </div>

                                {/* Location */}
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: INK_FAINT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                    Location
                                  </div>
                                  <div style={{ fontSize: '0.88rem', color: INK, fontWeight: 600, lineHeight: 1.4 }}>
                                    {item.city ?? '—'}
                                    {item.state ? `, ${item.state}` : ''}
                                  </div>
                                  {item.rate_center && (
                                    <div style={{ fontSize: '0.73rem', color: INK_DIM, marginTop: 3 }}>
                                      Rate Center: {item.rate_center}
                                    </div>
                                  )}
                                  {item.lata && (
                                    <div style={{ fontSize: '0.7rem', color: INK_FAINT, marginTop: 1 }}>
                                      LATA: {item.lata}
                                    </div>
                                  )}
                                </div>

                                {/* Product & Status */}
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: INK_FAINT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                    Product
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                                    <span className="dl-tag">{productTag(item.product_type ?? 'rcf')}</span>
                                    {didStatusBadge(item.status)}
                                  </div>
                                </div>

                                {/* Assigned date */}
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: INK_FAINT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                    Assigned Date
                                  </div>
                                  <div style={{ fontSize: '0.88rem', color: INK, fontWeight: 500 }}>
                                    {fmtAssignedDate(item.assigned_at)}
                                  </div>
                                </div>

                                {/* Configure Forwarding link */}
                                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                                  <button
                                    type="button"
                                    className="rcf-btn rcf-btn-primary"
                                    style={{ padding: '8px 16px', fontSize: '0.78rem' }}
                                    onClick={(e) => { e.stopPropagation(); onSwitchToNumbers(); }}
                                  >
                                    Configure Forwarding
                                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 12, height: 12 }}>
                                      <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </DidCard>
  );
}

// ── Pending Requests section ──────────────────────────────────────────────────

function PendingRequestsSection({ items }: { items: DidInventoryItem[] }) {
  if (items.length === 0) return null;

  return (
    <DidCard delay={80}>
      <DidSectionHeader
        title="Pending Requests"
        count={items.length}
        countLabel="pending"
      />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 440 }}>
          <thead>
            <tr>
              <DidTh>Number</DidTh>
              <DidTh>Location</DidTh>
              <DidTh>Requested</DidTh>
              <DidTh>Status</DidTh>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const location = [item.city, item.state].filter(Boolean).join(', ');
              return (
                <tr key={item.id} className="rcf-row">
                  {/* Number — softened: not active until the request is approved */}
                  <td style={{ padding: '15px 16px', whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: '0.92rem', fontWeight: 600, color: INK_SOFT, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
                      {fmt(item.did)}
                    </span>
                  </td>
                  <td style={{ padding: '15px 16px' }}>
                    <span style={{ fontSize: '0.85rem', color: location ? INK_SOFT : DL.slateMute, whiteSpace: 'nowrap' }}>
                      {location || '—'}
                    </span>
                  </td>
                  <td style={{ padding: '15px 16px' }}>
                    <span style={{ fontSize: '0.8rem', color: INK_DIM, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {fmtAssignedDate(item.assigned_at)}
                    </span>
                  </td>
                  <td style={{ padding: '15px 16px' }}>
                    {didStatusBadge(item.status)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </DidCard>
  );
}

// ── Available Numbers section ─────────────────────────────────────────────────

function AvailableNumbersSection({
  items,
  isLoading,
  isError,
  onRequest,
  requestingDid,
  canRequest,
  isStaff,
}: {
  items: DidInventoryItem[];
  isLoading: boolean;
  isError: boolean;
  onRequest: (item: DidInventoryItem) => void;
  requestingDid: string | null;
  /** True only for the tenant `user` role — staff and readonly tenants never request. */
  canRequest: boolean;
  /** Real role is admin/support — picks the view-only note's wording. */
  isStaff: boolean;
}) {
  // ALL hooks unconditionally at top
  const [filters, setFilters] = useState<DidFilterState>({ npa: '', nxx: '', state: '', search: '' });

  const availableStates = useMemo(() => extractStates(items), [items]);

  // Sort by state by default so customers can scan regionally
  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        const stateA = a.state ?? '';
        const stateB = b.state ?? '';
        if (stateA !== stateB) return stateA.localeCompare(stateB);
        const cityA = a.city ?? '';
        const cityB = b.city ?? '';
        return cityA.localeCompare(cityB);
      }),
    [items],
  );

  const filtered = useMemo(() => applyDidFilters(sortedItems, filters), [sortedItems, filters]);

  if (isLoading) {
    return (
      <DidCard delay={160}>
        <DidSectionHeader title="Available Numbers" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '48px 0', color: INK_DIM }}>
          <Spinner size="sm" />
          <span style={{ fontSize: '0.875rem' }}>Loading available numbers…</span>
        </div>
      </DidCard>
    );
  }

  if (isError) {
    return (
      <DidCard delay={160}>
        <DidSectionHeader title="Available Numbers" />
        <div style={{ padding: '16px 20px', margin: 16, borderRadius: 10, background: tMix('danger-solid', 6), border: `1px solid ${tMix('danger-solid', 20)}`, color: RED, fontSize: '0.85rem' }}>
          Unable to load available numbers. Please try refreshing.
        </div>
      </DidCard>
    );
  }

  return (
    <DidCard delay={160}>
      <DidSectionHeader
        title="Available Numbers"
        count={filtered.length}
        countLabel={filtered.length === 1 ? 'number available' : 'numbers available'}
      />
      {!canRequest && (
        // Inset like the rest of the panel (it used to touch the left edge).
        <p style={{ margin: 0, padding: '12px 20px', fontSize: '0.8rem', color: INK_DIM }}>
          {isStaff
            ? 'View only — staff assign numbers to customers from the number inventory tool.'
            : 'View only — your account has read-only access. Ask your account administrator to request numbers.'}
        </p>
      )}

      {items.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '56px 24px',
            gap: 14,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: DL.iconWash,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.5} style={{ width: 26, height: 26, stroke: AZURE_DEEP }}>
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M9 12h6M12 9v6" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <p style={{ color: INK, fontSize: '0.95rem', fontWeight: 700, margin: '0 0 6px' }}>
              No numbers available right now
            </p>
            <p style={{ color: INK_DIM, fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 360 }}>
              Our team is provisioning additional numbers. Check back soon or contact support to request a specific area code.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Filter bar */}
          <DidFilterBar
            filters={filters}
            onFiltersChange={setFilters}
            availableStates={availableStates}
            resultCount={filtered.length}
            totalCount={items.length}
          />

          {filtered.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px 24px',
                gap: 10,
                textAlign: 'center',
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.5} style={{ width: 32, height: 32, stroke: DL.slateSoft }}>
                <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p style={{ color: INK_SOFT, fontSize: '0.88rem', fontWeight: 500, margin: 0 }}>
                No numbers match these filters
              </p>
              <button
                type="button"
                onClick={() => setFilters({ npa: '', nxx: '', state: '', search: '' })}
                style={{ background: 'transparent', border: 'none', color: AZURE_DEEP, fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', padding: 0 }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                <thead>
                  <tr>
                    <DidTh>Number</DidTh>
                    <DidTh>Location</DidTh>
                    <DidTh>Rate Center</DidTh>
                    {canRequest && <th className="rcf-th" aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => {
                    const isRequesting = requestingDid === item.did;
                    const location = [item.city, item.state].filter(Boolean).join(', ');
                    return (
                      <tr key={item.id} className="rcf-row">
                        <td style={{ padding: '15px 16px', whiteSpace: 'nowrap' }}>
                          <span style={{ fontSize: '0.92rem', fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
                            {fmt(item.did)}
                          </span>
                        </td>

                        {/* Location — city/state merged (list is pre-sorted by state) */}
                        <td style={{ padding: '15px 16px' }}>
                          <span style={{ fontSize: '0.85rem', color: location ? INK_SOFT : DL.slateMute, whiteSpace: 'nowrap' }}>
                            {location || '—'}
                          </span>
                        </td>
                        <td style={{ padding: '15px 16px' }}>
                          <span style={{ fontSize: '0.8rem', color: INK_DIM, whiteSpace: 'nowrap' }}>
                            {item.rate_center ?? '—'}
                          </span>
                        </td>
                        {canRequest && (
                        <td style={{ padding: '11px 18px 11px 16px', textAlign: 'right' }}>
                          <button
                            type="button"
                            className="rcf-btn rcf-btn-primary"
                            // No glow in-table — a column of shadowed CTAs reads heavy
                            style={{ padding: '7px 16px', fontSize: '0.75rem', boxShadow: 'none' }}
                            onClick={() => onRequest(item)}
                            disabled={isRequesting}
                          >
                            {isRequesting ? (
                              <svg viewBox="0 0 16 16" style={{ width: 11, height: 11, animation: 'fx-spin 0.7s linear infinite' }}>
                                <circle cx="8" cy="8" r="6" fill="none" style={{ stroke: tMix('text-on-accent', 35) }} strokeWidth={2} />
                                <path d="M8 2a6 6 0 0 1 6 6" style={{ stroke: T.textOnAccent }} strokeWidth={2} fill="none" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11 }}>
                                <circle cx="8" cy="8" r="6" />
                                <path d="M8 5v6M5 8h6" strokeLinecap="round" />
                              </svg>
                            )}
                            {isRequesting ? 'Requesting…' : 'Request'}
                          </button>
                        </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </DidCard>
  );
}

// ── DIDManagementTab (root) ───────────────────────────────────────────────────

export interface DIDManagementTabProps {
  customerId: number | undefined;
  /**
   * Admin viewing ONE customer: GET /numbers/my returns every assigned DID
   * platform-wide for admins, so narrow it to this account client-side.
   * Undefined for tenants (the API already scopes them).
   */
  filterToCustomer?: number;
  /** "Configure forwarding" on an assigned number — show the numbers list. */
  onShowNumbers: () => void;
}

export function DIDManagementTab({ customerId, filterToCustomer, onShowNumbers }: DIDManagementTabProps) {
  // ALL hooks unconditionally at top — React rules-of-hooks
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  // Only the tenant `user` role may request numbers, or request / cancel a
  // release — the API 403s everyone else. Staff assign numbers in the
  // inventory tool; readonly tenants are view-only. Keyed on the REAL role
  // (user.role, as canEdit is), so an admin in customer-view mode — still
  // role 'admin' — never sees Request or Request Release.
  const { user, isActualAdmin, isSupport } = useAuth();
  const canRequest = user?.role === 'user';

  // Request modal state
  const [requestTarget, setRequestTarget] = useState<DidInventoryItem | null>(null);
  // Release modal state
  const [releaseTarget, setReleaseTarget] = useState<DidInventoryItem | null>(null);

  const {
    data: myDids,
    isLoading: myLoading,
    isError: myError,
  } = useQuery({
    queryKey: ['my-dids', customerId],
    queryFn: () => listMyDids(),
    staleTime: 30_000,
  });

  const {
    data: availableDids,
    isLoading: availLoading,
    isError: availError,
  } = useQuery({
    queryKey: ['available-dids'],
    queryFn: () => listAvailableDids({ limit: 200 }),
    staleTime: 30_000,
  });

  const requestMutation = useMutation({
    mutationFn: (did: string) => requestDid(did),
    onSuccess: (_data, did) => {
      void queryClient.invalidateQueries({ queryKey: ['my-dids'] });
      void queryClient.invalidateQueries({ queryKey: ['available-dids'] });
      setRequestTarget(null);
      toastOk(`Number requested — ${fmt(did)} is pending admin approval`);
    },
    onError: (err: Error) => {
      setRequestTarget(null);
      toastErr(err.message ?? 'Failed to request number');
    },
  });

  const releaseRequestMutation = useMutation({
    mutationFn: (did: string) => requestDidRelease(did),
    onSuccess: (_data, did) => {
      void queryClient.invalidateQueries({ queryKey: ['my-dids'] });
      setReleaseTarget(null);
      toastOk(`Release requested — ${fmt(did)} is pending review`);
    },
    onError: (err: Error) => {
      setReleaseTarget(null);
      // 409 = wrong status (e.g. already requested) — surface the API detail
      toastErr(err.message ?? 'Failed to request release');
    },
  });

  const cancelReleaseMutation = useMutation({
    mutationFn: (did: string) => cancelDidRelease(did),
    onSuccess: (_data, did) => {
      void queryClient.invalidateQueries({ queryKey: ['my-dids'] });
      toastOk(`Release request canceled — ${fmt(did)} stays assigned`);
    },
    onError: (err: Error) => {
      toastErr(err.message ?? 'Failed to cancel release request');
    },
  });

  const myItems = useMemo(() => {
    const all = myDids ?? [];
    return filterToCustomer === undefined ? all : all.filter((d) => d.customer_id === filterToCustomer);
  }, [myDids, filterToCustomer]);
  const availItems = availableDids ?? [];

  // My Numbers shows active DIDs: assigned + pending-release (still forwarding)
  const assignedItems = useMemo(
    () => myItems.filter((d) => d.status === 'assigned' || d.status === 'release_requested'),
    [myItems],
  );
  const pendingItems = useMemo(
    () => myItems.filter((d) => d.status === 'reserved'),
    [myItems],
  );

  function handleRequestClick(item: DidInventoryItem) {
    setRequestTarget(item);
  }

  function handleConfirmRequest(item: DidInventoryItem) {
    requestMutation.mutate(item.did);
  }

  function handleRequestReleaseClick(item: DidInventoryItem) {
    setReleaseTarget(item);
  }

  function handleConfirmReleaseRequest(item: DidInventoryItem) {
    releaseRequestMutation.mutate(item.did);
  }

  function handleCancelRelease(item: DidInventoryItem) {
    cancelReleaseMutation.mutate(item.did);
  }

  return (
    <>
      {/* Request confirmation modal */}
      {requestTarget && (
        <RequestModal
          did={requestTarget}
          onConfirm={handleConfirmRequest}
          onCancel={() => setRequestTarget(null)}
          isPending={requestMutation.isPending}
        />
      )}

      {/* Request-release confirmation modal */}
      {releaseTarget && (
        <RequestReleaseModal
          did={releaseTarget}
          onConfirm={handleConfirmReleaseRequest}
          onCancel={() => setReleaseTarget(null)}
          isPending={releaseRequestMutation.isPending}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Section 1: My Numbers (assigned) */}
        <MyNumbersSection
          items={assignedItems}
          isLoading={myLoading}
          isError={myError}
          canRelease={canRequest}
          onRequestRelease={handleRequestReleaseClick}
          onCancelRelease={handleCancelRelease}
          cancelingDid={cancelReleaseMutation.isPending ? (cancelReleaseMutation.variables ?? null) : null}
          onSwitchToNumbers={onShowNumbers}
        />

        {/* Section 2: Pending Requests */}
        <PendingRequestsSection items={pendingItems} />

        {/* Section 3: Available Numbers */}
        <AvailableNumbersSection
          items={availItems}
          isLoading={availLoading}
          isError={availError}
          onRequest={handleRequestClick}
          requestingDid={requestMutation.isPending ? (requestMutation.variables ?? null) : null}
          canRequest={canRequest}
          isStaff={isActualAdmin || isSupport}
        />
      </div>
    </>
  );
}
