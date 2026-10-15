import { Fragment, useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Spinner } from '../components/ui/Spinner';
import { listRcf, updateRcfEntry } from '../api/rcf';
import type { RcfEntry, RcfUpdate } from '../types/rcf';
import { useAuth } from '../contexts/AuthContext';
import { listCustomers } from '../api/customers';
import { fmt } from '../utils/format';
import { normalizeNumberInput } from '../utils/phone';
import { apiRequest } from '../api/client';
import { useToast } from '../components/ui/Toast';
import {
  listAvailableDids,
  listMyDids,
  requestDid,
  requestDidRelease,
  cancelDidRelease,
} from '../api/didInventory';
import type { DidInventoryItem } from '../types/didInventory';
import { Reveal } from '../components/fx/Reveal';
import {
  AZURE, AZURE_DEEP, DEFAULT_PAGE_SIZE, GREEN, INK, INK_DIM, INK_FAINT, INK_SOFT, MONO, RED,
} from './rcf/theme';
import { PaginationControls } from './rcf/PaginationControls';
import { CallActivityTab } from './rcf/CallActivityTab';

// ─── API helpers ──────────────────────────────────────────────────────────────

async function updateRcfEnabled(id: number, enabled: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { enabled });
}

async function updateRcfPassCallerId(id: number, pass_caller_id: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { pass_caller_id });
}

// ─── Types & constants ────────────────────────────────────────────────────────

type SortField = 'did' | 'name' | 'forward_to' | 'customer' | 'status';
type SortDir = 'asc' | 'desc';

// ─── Sort helpers ─────────────────────────────────────────────────────────────

function sortEntries(entries: RcfEntry[], field: SortField, dir: SortDir): RcfEntry[] {
  return [...entries].sort((a, b) => {
    let aVal = '';
    let bVal = '';
    switch (field) {
      case 'did':        aVal = a.did;                  bVal = b.did;                  break;
      case 'name':       aVal = a.name ?? '';            bVal = b.name ?? '';           break;
      case 'forward_to': aVal = a.forward_to;            bVal = b.forward_to;           break;
      case 'customer':   aVal = a.customer_name ?? '';   bVal = b.customer_name ?? '';  break;
      case 'status':     aVal = String(a.enabled);       bVal = String(b.enabled);      break;
    }
    const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ─── LightSwitch — daylight on/off control ────────────────────────────────────

function LightSwitch({
  checked,
  disabled,
  pending,
  onChange,
  title,
  ariaLabel,
}: {
  checked: boolean;
  disabled: boolean;
  pending: boolean;
  onChange: () => void;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled || pending}
      onClick={(e) => { e.stopPropagation(); if (!disabled && !pending) onChange(); }}
      title={title}
      className={checked ? 'rcf-switch rcf-switch-on' : 'rcf-switch'}
      style={pending ? { opacity: 0.55 } : undefined}
    />
  );
}

// ─── StatusPill ───────────────────────────────────────────────────────────────

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled ? 'rcf-pill rcf-pill-on' : 'rcf-pill rcf-pill-off'}>
      {enabled ? 'Active' : 'Disabled'}
    </span>
  );
}

// ─── SortHeader ───────────────────────────────────────────────────────────────

interface SortHeaderProps {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
  /** Optional fixed column width (px) — presentation only, keeps Label from crowding */
  width?: number;
}

function SortHeader({ label, field, currentField, currentDir, onSort, width }: SortHeaderProps) {
  const isActive = currentField === field;
  return (
    <th
      onClick={() => onSort(field)}
      aria-sort={isActive ? (currentDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`rcf-th rcf-th-sort${isActive ? ' rcf-th-active' : ''}`}
      style={width !== undefined ? { width } : undefined}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {label}
        <span style={{ fontSize: '0.72rem', lineHeight: 1, opacity: isActive ? 1 : 0.45 }}>
          {isActive ? (currentDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </span>
    </th>
  );
}

// ─── RowEditor — the expanded configuration panel ─────────────────────────────

interface RowEditorProps {
  entry: RcfEntry;
  isAdmin: boolean;
  canEdit: boolean;
  onClose: () => void;
}

interface DraftState {
  name: string;
  forward_to: string;
  failover_to: string;
  ring_timeout: string;
  max_channels: string;
}

function draftFromEntry(entry: RcfEntry): DraftState {
  return {
    name: entry.name ?? '',
    forward_to: entry.forward_to,
    failover_to: entry.failover_to ?? '',
    ring_timeout: String(entry.ring_timeout),
    max_channels: String(entry.max_channels),
  };
}

function sameDraft(a: DraftState, b: DraftState): boolean {
  return (
    a.name === b.name &&
    a.forward_to === b.forward_to &&
    a.failover_to === b.failover_to &&
    a.ring_timeout === b.ring_timeout &&
    a.max_channels === b.max_channels
  );
}

function RowEditor({ entry, isAdmin, canEdit, onClose }: RowEditorProps) {
  // ALL hooks unconditionally at the top (rules-of-hooks — React #310 guard)
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [draft, setDraft] = useState<DraftState>(() => draftFromEntry(entry));
  const [baseline, setBaseline] = useState<DraftState>(() => draftFromEntry(entry));

  // Re-sync the draft when the SAVED text/number fields change server-side
  // (own save round-trip, or another admin's edit) — render-time "adjust
  // state on prop change" pattern. Deliberately compares only the batched
  // fields, so instant enabled/caller-ID toggles never clobber in-flight edits.
  const fresh = draftFromEntry(entry);
  if (!sameDraft(fresh, baseline)) {
    setBaseline(fresh);
    setDraft(fresh);
  }

  const saveMutation = useMutation({
    mutationFn: (patch: RcfUpdate) => updateRcfEntry(entry.id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      void queryClient.invalidateQueries({ queryKey: ['rcf-dids'] });
      toastOk(`Saved — ${fmt(entry.did)} configuration updated`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to save'),
  });

  const enableMutation = useMutation({
    mutationFn: (enabled: boolean) => updateRcfEnabled(entry.id, enabled),
    onSuccess: (_, enabled) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      toastOk(enabled ? `${fmt(entry.did)} enabled` : `${fmt(entry.did)} disabled`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  const callerIdMutation = useMutation({
    mutationFn: (pass: boolean) => updateRcfPassCallerId(entry.id, pass),
    onSuccess: (_, pass) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      toastOk(pass ? `Caller ID pass-through enabled for ${fmt(entry.did)}` : `Caller ID will show ${fmt(entry.did)} instead`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  const dirty = useMemo(() => {
    if ((draft.name.trim() || null) !== (entry.name ?? null)) return true;
    if (draft.forward_to.trim() !== entry.forward_to) return true;
    if ((draft.failover_to.trim() || null) !== (entry.failover_to ?? null)) return true;
    if (draft.ring_timeout.trim() !== String(entry.ring_timeout)) return true;
    // max_channels is admin-set only — never part of a customer's diff.
    if (isAdmin && draft.max_channels.trim() !== String(entry.max_channels)) return true;
    return false;
  }, [draft, entry, isAdmin]);

  const handleSave = useCallback(() => {
    const patch: RcfUpdate = {};

    const trimmedName = draft.name.trim();
    if ((trimmedName || null) !== (entry.name ?? null)) patch.name = trimmedName || null;

    const fwd = normalizeNumberInput(draft.forward_to);
    if (!fwd) { toastErr('Forwarding destination cannot be empty'); return; }
    if (fwd !== entry.forward_to) patch.forward_to = fwd;

    const failRaw = draft.failover_to.trim();
    const fo = failRaw === '' ? null : normalizeNumberInput(failRaw);
    if (fo !== (entry.failover_to ?? null)) patch.failover_to = fo;

    const rt = parseInt(draft.ring_timeout, 10);
    if (isNaN(rt) || rt < 5 || rt > 600) { toastErr('Ring timeout must be between 5 and 600 seconds'); return; }
    if (rt !== entry.ring_timeout) patch.ring_timeout = rt;

    // Admin-only field — the API rejects max_channels from non-admins (403),
    // so the payload must never carry it for customer users.
    if (isAdmin) {
      const mc = parseInt(draft.max_channels, 10);
      if (isNaN(mc) || mc < 0 || mc > 100) { toastErr('Max concurrent calls must be between 0 and 100'); return; }
      if (mc !== entry.max_channels) patch.max_channels = mc;
    }

    if (Object.keys(patch).length === 0) return;
    saveMutation.mutate(patch);
  }, [draft, entry, isAdmin, saveMutation, toastErr]);

  const handleCancel = useCallback(() => {
    setDraft(draftFromEntry(entry));
  }, [entry]);

  const saving = saveMutation.isPending;
  const set = (field: keyof DraftState) => (value: string) =>
    setDraft((d) => ({ ...d, [field]: value }));
  const onEnterSave = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && dirty && !saving) { e.preventDefault(); handleSave(); }
  };

  // List responses may omit created_at — guard against Invalid Date.
  const createdMs = entry.created_at ? new Date(entry.created_at).getTime() : NaN;
  const createdDate = Number.isFinite(createdMs)
    ? new Date(createdMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  return (
    <div
      className="rcf-xpanel"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div className="rcf-xgrid">
        {/* ── Routing column ──────────────────────────────────────────── */}
        <div>
          <div className="rcf-xsection-title">Routing</div>
          <div className="rcf-xfields">
            {/* Forwarding destination — the primary edit */}
            <div>
              <label className="rcf-flabel" htmlFor={`fwd-${entry.id}`}>Forwarding destination</label>
              {canEdit ? (
                <input
                  id={`fwd-${entry.id}`}
                  type="tel"
                  className="rcf-input rcf-input-mono"
                  style={{ width: '100%', fontSize: '1.02rem', fontWeight: 700, padding: '10px 14px', color: AZURE_DEEP }}
                  value={draft.forward_to}
                  placeholder="+1XXXXXXXXXX"
                  disabled={saving}
                  onChange={(e) => set('forward_to')(e.target.value)}
                  onKeyDown={onEnterSave}
                />
              ) : (
                <div className="rcf-static rcf-input-mono" style={{ fontSize: '1.02rem', color: AZURE_DEEP }}>
                  {fmt(entry.forward_to)}
                </div>
              )}
              <div className="rcf-help">Calls to {fmt(entry.did)} ring this number.</div>
            </div>

            {/* Failover destination */}
            <div>
              <label className="rcf-flabel" htmlFor={`failover-${entry.id}`}>Failover destination</label>
              {canEdit ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    id={`failover-${entry.id}`}
                    type="tel"
                    className="rcf-input rcf-input-mono"
                    style={{ flex: 1, minWidth: 0 }}
                    value={draft.failover_to}
                    placeholder="Optional — rings if primary fails"
                    disabled={saving}
                    onChange={(e) => set('failover_to')(e.target.value)}
                    onKeyDown={onEnterSave}
                  />
                  {draft.failover_to !== '' && (
                    <button
                      type="button"
                      className="rcf-btn rcf-btn-ghost"
                      style={{ padding: '7px 12px', fontSize: '0.72rem' }}
                      onClick={() => set('failover_to')('')}
                      title="Clear failover destination"
                    >
                      Clear
                    </button>
                  )}
                </div>
              ) : (
                <div className="rcf-static rcf-input-mono" style={{ color: entry.failover_to ? INK : INK_FAINT }}>
                  {entry.failover_to ? fmt(entry.failover_to) : 'None'}
                </div>
              )}
            </div>

            {/* Label */}
            <div>
              <label className="rcf-flabel" htmlFor={`label-${entry.id}`}>Label</label>
              {canEdit ? (
                <input
                  id={`label-${entry.id}`}
                  type="text"
                  className="rcf-input"
                  style={{ width: '100%' }}
                  value={draft.name}
                  placeholder="Name this line — e.g. Boston office"
                  disabled={saving}
                  onChange={(e) => set('name')(e.target.value)}
                  onKeyDown={onEnterSave}
                />
              ) : (
                <div className="rcf-static" style={{ color: entry.name ? INK : INK_FAINT, fontStyle: entry.name ? 'normal' : 'italic' }}>
                  {entry.name ?? 'No label'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Behavior column ─────────────────────────────────────────── */}
        <div>
          <div className="rcf-xsection-title">Behavior</div>
          <div className="rcf-xfields">
            {/* Enabled — instant toggle (existing mutation pattern) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <LightSwitch
                checked={entry.enabled}
                disabled={!canEdit}
                pending={enableMutation.isPending}
                onChange={() => enableMutation.mutate(!entry.enabled)}
                title={canEdit ? (entry.enabled ? 'Click to disable' : 'Click to enable') : undefined}
                ariaLabel="Forwarding enabled"
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.84rem', fontWeight: 700, color: INK }}>Forwarding {entry.enabled ? 'enabled' : 'disabled'}</div>
                <div className="rcf-help" style={{ marginTop: 1 }}>
                  {entry.enabled ? 'Inbound calls are being forwarded.' : 'Inbound calls are rejected while disabled.'}
                </div>
              </div>
            </div>

            {/* Caller ID pass-through — instant toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <LightSwitch
                checked={entry.pass_caller_id}
                disabled={!canEdit}
                pending={callerIdMutation.isPending}
                onChange={() => callerIdMutation.mutate(!entry.pass_caller_id)}
                title={canEdit ? (entry.pass_caller_id ? 'Showing original caller ID — click to show your DID instead' : 'Showing your DID — click to pass through original caller ID') : undefined}
                ariaLabel="Caller ID pass-through"
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.84rem', fontWeight: 700, color: INK }}>
                  Caller ID: {entry.pass_caller_id ? 'pass-through' : 'show this DID'}
                </div>
                <div className="rcf-help" style={{ marginTop: 1 }}>
                  {entry.pass_caller_id
                    ? 'The destination sees the original caller’s number.'
                    : `The destination sees ${fmt(entry.did)} on every call.`}
                </div>
              </div>
            </div>

            {/* Ring timeout + max concurrent — two-up */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 140px', minWidth: 120 }}>
                <label className="rcf-flabel" htmlFor={`ring-${entry.id}`}>Ring timeout</label>
                {canEdit ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      id={`ring-${entry.id}`}
                      type="number"
                      min={5}
                      max={600}
                      className="rcf-input rcf-input-mono"
                      style={{ width: 88, textAlign: 'center' }}
                      value={draft.ring_timeout}
                      disabled={saving}
                      onChange={(e) => set('ring_timeout')(e.target.value)}
                      onKeyDown={onEnterSave}
                    />
                    <span style={{ fontSize: '0.76rem', fontWeight: 600, color: INK_DIM }}>seconds</span>
                  </div>
                ) : (
                  <div className="rcf-static">{entry.ring_timeout}s</div>
                )}
              </div>
              <div style={{ flex: '1 1 160px', minWidth: 140 }}>
                <label className="rcf-flabel" htmlFor={`maxch-${entry.id}`}>Max concurrent calls</label>
                {canEdit && isAdmin ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        id={`maxch-${entry.id}`}
                        type="number"
                        min={0}
                        max={100}
                        className="rcf-input rcf-input-mono"
                        style={{ width: 88, textAlign: 'center' }}
                        value={draft.max_channels}
                        disabled={saving}
                        onChange={(e) => set('max_channels')(e.target.value)}
                        onKeyDown={onEnterSave}
                      />
                      <span style={{ fontSize: '0.76rem', fontWeight: 600, color: INK_DIM }}>
                        {parseInt(draft.max_channels, 10) === 0 ? 'no limit' : 'calls'}
                      </span>
                    </div>
                    <div className="rcf-help">0 = no limit</div>
                  </>
                ) : (
                  <>
                    {/* Admin-set capacity — customers see the fact, not a control */}
                    <div className="rcf-static">{entry.max_channels === 0 ? 'No limit' : entry.max_channels}</div>
                    {canEdit && <div className="rcf-help">Set by Granite — contact support to change.</div>}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Facts + actions ───────────────────────────────────────────── */}
      <div className="rcf-xfacts">
        <div>
          <div className="rcf-fact-label">Number</div>
          <div className="rcf-fact-value" style={{ fontFamily: MONO }}>{entry.did}</div>
        </div>
        <div>
          <div className="rcf-fact-label">Created</div>
          <div className="rcf-fact-value">{createdDate}</div>
        </div>
        {isAdmin && (
          <div>
            <div className="rcf-fact-label">Customer</div>
            <div className="rcf-fact-value">{entry.customer_name ?? `ID ${entry.customer_id}`}</div>
          </div>
        )}
        {canEdit && (
          <div className="rcf-xactions">
            <button
              type="button"
              className="rcf-btn rcf-btn-ghost"
              disabled={!dirty || saving}
              onClick={handleCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rcf-btn rcf-btn-primary"
              disabled={!dirty || saving}
              onClick={handleSave}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── NumberRow — collapsed row + expanded configuration panel ─────────────────

interface NumberRowProps {
  entry: RcfEntry;
  isAdmin: boolean;
  canEdit: boolean;
  expanded: boolean;
  onToggle: () => void;
  onCollapse: () => void;
}

function NumberRow({ entry, isAdmin, canEdit, expanded, onToggle, onCollapse }: NumberRowProps) {
  const colSpan = isAdmin ? 6 : 5;

  return (
    <>
      <tr
        className={`rcf-row rcf-nrow${expanded ? ' rcf-nrow-open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
          if (e.key === 'Escape' && expanded) { e.preventDefault(); onCollapse(); }
        }}
      >
        {/* Chevron affordance */}
        <td style={{ padding: '15px 4px 15px 18px', width: 34 }}>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke={expanded ? AZURE_DEEP : INK_FAINT}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`rcf-chev${expanded ? ' rcf-chev-open' : ''}`}
            style={{ width: 13, height: 13 }}
          >
            <path d="M6 3l5 5-5 5" />
          </svg>
        </td>

        {/* Number — muted when disabled so state reads before the pill */}
        <td style={{ padding: '15px 16px', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: '0.92rem', fontWeight: 600, color: entry.enabled ? INK : INK_SOFT, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
            {fmt(entry.did)}
          </span>
        </td>

        {/* Forwards to — azure means "this forward is live"; disabled goes quiet */}
        <td style={{ padding: '15px 16px', whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <svg viewBox="0 0 16 10" fill="none" style={{ width: 14, height: 9, flexShrink: 0, opacity: 0.55 }} aria-hidden="true">
              <line x1="1" y1="5" x2="13" y2="5" stroke={INK_DIM} strokeWidth={1.5} strokeLinecap="round" />
              <path d="M10 2l3 3-3 3" stroke={INK_DIM} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: '0.92rem', fontWeight: 600, color: entry.enabled ? AZURE_DEEP : INK_DIM, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
              {fmt(entry.forward_to)}
            </span>
          </span>
        </td>

        {/* Label */}
        <td style={{ padding: '15px 16px' }}>
          <span
            style={{
              display: 'block',
              maxWidth: 280,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: '0.85rem',
              color: entry.name ? INK_SOFT : '#a7b3c8',
              fontStyle: entry.name ? 'normal' : 'italic',
            }}
          >
            {entry.name ?? 'No label'}
          </span>
        </td>

        {/* Status */}
        <td style={{ padding: '15px 16px' }}>
          <StatusPill enabled={entry.enabled} />
        </td>

        {/* Customer (admin only) */}
        {isAdmin && (
          <td style={{ padding: '15px 16px' }}>
            <span
              style={{
                fontSize: '0.74rem',
                fontWeight: 600,
                color: INK_DIM,
                background: 'rgba(47,125,246,0.06)',
                border: '1px solid rgba(47,125,246,0.16)',
                borderRadius: 6,
                padding: '2px 9px',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.customer_name ?? `ID ${entry.customer_id}`}
            </span>
          </td>
        )}
      </tr>

      {/* Expanded configuration panel — animated one-shot, inside table flow */}
      {expanded && (
        <tr>
          <td colSpan={colSpan} style={{ padding: 0, borderTop: 'none' }}>
            <div className="rcf-xwrap">
              <div>
                <RowEditor entry={entry} isAdmin={isAdmin} canEdit={canEdit} onClose={onCollapse} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Page header ──────────────────────────────────────────────────────────────

interface RcfPageHeaderProps {
  title: string;
  subtitle: string;
  /** Secondary scope context shown as the last breadcrumb segment
      (admin: the selected customer / "All Customers"). */
  context?: string | null;
  /** False before an admin picks a scope — no figures to show yet. */
  showMetrics: boolean;
  /** Total forwards on the account (server total). */
  total: number;
  /** Enabled / disabled counts from the loaded entries. */
  active: number;
  disabled: number;
  /** False while the entries query is still loading or errored. */
  loaded: boolean;
}

/**
 * Quiet console header — set directly on the paper canvas, no framing card.
 * A small product breadcrumb, a calm Archivo title, a one-line description,
 * and the key figures as inline metrics separated by hairline rules. A single
 * 1px rule closes the zone. The only accent is the small azure tick on the
 * breadcrumb. Uses only data already loaded by the page.
 */
function RcfPageHeader({ title, subtitle, context, showMetrics, total, active, disabled, loaded }: RcfPageHeaderProps) {
  return (
    <header className="rcf-header fx-load">
      <div className="rcf-header-id">
        <div className="rcf-crumb">
          <span>Remote Call Forwarding</span>
          <span className="rcf-crumb-sep" aria-hidden="true">/</span>
          <span>Granite CRAG</span>
          {context && (
            <>
              <span className="rcf-crumb-sep" aria-hidden="true">/</span>
              <span className="rcf-crumb-context">{context}</span>
            </>
          )}
        </div>
        <h1 className="rcf-title">{title}</h1>
        <p className="rcf-sub">{subtitle}</p>
      </div>

      {showMetrics && (
        <div className="rcf-metrics">
          <div className="rcf-metric">
            <div className="rcf-metric-value">{loaded ? total.toLocaleString() : '—'}</div>
            <div className="rcf-metric-label">Forwards</div>
          </div>
          <div className="rcf-metric">
            <div className="rcf-metric-value">{loaded ? active.toLocaleString() : '—'}</div>
            <div className="rcf-metric-label">Enabled</div>
          </div>
          {loaded && disabled > 0 && (
            <div className="rcf-metric">
              <div className="rcf-metric-value">{disabled.toLocaleString()}</div>
              <div className="rcf-metric-label">Disabled</div>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

// ─── Empty states ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      className="rcf-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 24px',
        gap: 16,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 14,
          background: '#e4eeff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 4,
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke={AZURE_DEEP} strokeWidth={1.6} style={{ width: 30, height: 30 }}>
          <path d="M3 5a2 2 0 0 1 2-2h3.28a1 1 0 0 1 .948.684l1.498 4.493a1 1 0 0 1-.502 1.21l-2.257 1.13a11.042 11.042 0 0 0 5.516 5.516l1.13-2.257a1 1 0 0 1 1.21-.502l4.493 1.498a1 1 0 0 1 .684.949V19a2 2 0 0 1-2 2h-1C9.716 21 3 14.284 3 6V5z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div>
        <p style={{ color: INK, fontSize: '1rem', fontWeight: 700, margin: '0 0 6px' }}>
          No numbers configured yet
        </p>
        <p style={{ color: INK_DIM, fontSize: '0.82rem', margin: 0, lineHeight: 1.6 }}>
          Contact support to provision Remote Call Forwarding numbers for your account.
        </p>
      </div>
    </div>
  );
}

function SearchEmptyState({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div
      className="rcf-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '60px 24px',
        gap: 12,
        textAlign: 'center',
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        style={{ width: 36, height: 36, color: '#b6c2d4', marginBottom: 4 }}
      >
        <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p style={{ color: INK_SOFT, fontSize: '0.9rem', fontWeight: 500, margin: 0 }}>
        No numbers match &ldquo;{query}&rdquo;
      </p>
      <button
        type="button"
        onClick={onClear}
        style={{
          background: 'transparent',
          border: 'none',
          color: AZURE_DEEP,
          fontSize: '0.8rem',
          cursor: 'pointer',
          textDecoration: 'underline',
          fontFamily: 'inherit',
          padding: 0,
        }}
      >
        Clear filter
      </button>
    </div>
  );
}

// ─── Tab types ────────────────────────────────────────────────────────────────

type DashboardTab = 'numbers' | 'activity' | 'dids';

/**
 * Admin console scope — what the admin has chosen to look at.
 *   null      → nothing selected yet (the page opens empty; no data loads)
 *   'all'     → every customer's RCF numbers
 *   number    → one customer account id
 * Tenants never use this: they are always scoped to their own account.
 */
type AdminScope = null | 'all' | number;

// ─── ScopePrompt — the admin console's quiet pre-selection state ─────────────

function ScopePrompt({ message }: { message: string }) {
  return (
    <div className="rcf-panel rcf-scope-prompt fx-load fx-load-d2" role="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" strokeLinecap="round" />
      </svg>
      <p className="rcf-scope-prompt-title">{message}</p>
      <p className="rcf-scope-prompt-sub">Use the <strong>Viewing</strong> menu above to choose a customer, or All Customers.</p>
    </div>
  );
}

// ─── TabBar ───────────────────────────────────────────────────────────────────

interface TabBarProps {
  active: DashboardTab;
  onChange: (tab: DashboardTab) => void;
}

function TabBar({ active, onChange }: TabBarProps) {
  const tabs: { id: DashboardTab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'numbers',
      label: 'Numbers',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <rect x="2" y="2" width="5" height="5" rx="1.5" />
          <rect x="9" y="2" width="5" height="5" rx="1.5" />
          <rect x="2" y="9" width="5" height="5" rx="1.5" />
          <rect x="9" y="9" width="5" height="5" rx="1.5" />
        </svg>
      ),
    },
    {
      id: 'activity',
      label: 'Call Activity',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <path d="M2 12 L4 8 L6 10 L9 5 L11 7 L14 3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      id: 'dids',
      label: 'DID Management',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <path d="M5 8h6M8 5v6" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  return (
    <div className="rcf-tabs fx-load fx-load-d1" role="tablist">
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={isActive ? 'rcf-tab rcf-tab-active' : 'rcf-tab'}
          >
            <span
              style={{
                display: 'inline-flex',
                color: isActive ? 'var(--rcf-azure-deep)' : 'inherit',
                transition: 'color 0.15s ease',
              }}
            >
              {tab.icon}
            </span>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── DIDManagementTab ─────────────────────────────────────────────────────────

// ── E.164 helpers ─────────────────────────────────────────────────────────────

/** Extract NPA (area code) from E.164 +1NPANXXXXXX */
function extractNpa(did: string): string {
  return did.replace(/^\+1/, '').substring(0, 3);
}

/** Extract NXX (exchange) from E.164 +1NPANXXXXXX */
function extractNxx(did: string): string {
  return did.replace(/^\+1/, '').substring(3, 6);
}

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
          style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9aa9c0', display: 'flex', alignItems: 'center', pointerEvents: 'none' }}
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
            borderColor: filters.npa.length === 3 ? 'rgba(47,125,246,0.55)' : undefined,
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
            borderColor: filters.nxx.length === 3 ? 'rgba(47,125,246,0.55)' : undefined,
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
            background: hasActive ? 'rgba(47,125,246,0.08)' : '#ffffff',
            border: `1px solid ${hasActive ? 'rgba(47,125,246,0.22)' : '#d5deeb'}`,
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
    available:   { bg: 'rgba(47,125,246,0.09)',  color: AZURE_DEEP, border: 'rgba(47,125,246,0.28)',  label: 'Available' },
    assigned:    { bg: 'rgba(22,163,74,0.1)',    color: GREEN,      border: 'rgba(22,163,74,0.28)',   label: 'Assigned' },
    reserved:    { bg: 'rgba(93,111,140,0.12)',  color: INK_SOFT,   border: 'rgba(93,111,140,0.3)',   label: 'Pending Approval' },
    porting_in:  { bg: 'rgba(29,99,221,0.07)',   color: AZURE_DEEP, border: 'rgba(29,99,221,0.24)',   label: 'Porting In' },
    porting_out: { bg: 'rgba(29,99,221,0.07)',   color: AZURE_DEEP, border: 'rgba(29,99,221,0.24)',   label: 'Porting Out' },
    suspended:   { bg: 'rgba(220,38,38,0.07)',   color: RED,        border: 'rgba(220,38,38,0.26)',   label: 'Suspended' },
    // Sky pending state — the release is in flight, awaiting engineering review
    release_requested: { bg: 'rgba(2,132,199,0.08)', color: '#0369a1', border: 'rgba(2,132,199,0.28)', label: 'Release Requested' },
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
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(10,16,28,0.45)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        animation: 'fx-fade 0.15s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !isPending) onCancel(); }}
    >
      <div
        style={{
          background: '#ffffff',
          border: '1px solid #dfe6f0',
          borderTop: `4px solid ${AZURE}`,
          borderRadius: 14,
          padding: '30px 32px 26px',
          maxWidth: 420,
          width: '100%',
          position: 'relative',
          boxShadow: '0 24px 64px -12px rgba(14,23,38,0.4)',
          animation: 'fx-rise 0.2s ease',
          fontFamily: '"Public Sans", "IBM Plex Sans", -apple-system, sans-serif',
          color: INK,
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: '#e4eeff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 18,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke={AZURE_DEEP} strokeWidth={1.6} style={{ width: 24, height: 24 }}>
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
            background: '#eef4ff',
            border: '1px solid rgba(47,125,246,0.2)',
            marginBottom: 22,
            fontSize: '0.78rem',
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: AZURE_DEEP, fontWeight: 700 }}>Note: </span>
          <span style={{ color: INK_SOFT }}>
            This number will be marked as pending until an administrator approves the request. You will be notified once it is assigned.
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
                <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={2} />
                <path d="M8 2a6 6 0 0 1 6 6" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
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
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(10,16,28,0.5)',
        backdropFilter: 'blur(5px)',
        WebkitBackdropFilter: 'blur(5px)',
        animation: 'fx-fade 0.15s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !isPending) onCancel(); }}
    >
      <div
        style={{
          background: '#ffffff',
          border: '1px solid #dfe6f0',
          borderTop: `4px solid ${AZURE}`,
          borderRadius: 14,
          padding: '30px 32px 26px',
          maxWidth: 440,
          width: '100%',
          position: 'relative',
          boxShadow: '0 24px 64px -12px rgba(14,23,38,0.45)',
          animation: 'fx-rise 0.2s ease',
          fontFamily: '"Public Sans", "IBM Plex Sans", -apple-system, sans-serif',
          color: INK,
        }}
      >
        {/* Outbound-arrow icon — a request leaving for review */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: '#e4eeff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 18,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke={AZURE_DEEP} strokeWidth={1.7} style={{ width: 24, height: 24 }}>
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
            background: 'rgba(47,125,246,0.05)',
            border: '1px solid rgba(47,125,246,0.18)',
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
                <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={2} />
                <path d="M8 2a6 6 0 0 1 6 6" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
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
  onRequestRelease: (item: DidInventoryItem) => void;
  onCancelRelease: (item: DidInventoryItem) => void;
  cancelingDid: string | null;
  onSwitchToNumbers: () => void;
}

function MyNumbersSection({
  items,
  isLoading,
  isError,
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
        <div style={{ padding: '16px 20px', margin: 16, borderRadius: 10, background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: RED, fontSize: '0.85rem' }}>
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
              background: '#e4eeff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke={AZURE_DEEP} strokeWidth={1.5} style={{ width: 28, height: 28 }}>
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
              <svg viewBox="0 0 24 24" fill="none" stroke="#b6c2d4" strokeWidth={1.5} style={{ width: 28, height: 28 }}>
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
                    <th className="rcf-th" aria-label="Actions" />
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
                              stroke={isExpanded ? AZURE_DEEP : INK_FAINT}
                              strokeWidth={1.75}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className={`rcf-chev${isExpanded ? ' rcf-chev-open' : ''}`}
                              style={{ width: 13, height: 13 }}
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
                            <span style={{ fontSize: '0.85rem', color: location ? INK_SOFT : '#a7b3c8', whiteSpace: 'nowrap' }}>
                              {location || '—'}
                            </span>
                          </td>

                          <td style={{ padding: '15px 16px' }}>
                            <span className="dl-tag">{item.product_type ?? 'RCF'}</span>
                          </td>
                          <td style={{ padding: '15px 16px' }}>
                            {didStatusBadge(item.status)}
                          </td>
                          <td style={{ padding: '15px 16px' }}>
                            <span style={{ fontSize: '0.8rem', color: INK_DIM, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {fmtAssignedDate(item.assigned_at)}
                            </span>
                          </td>

                          {/* Release action — request flow (pending state shows Cancel) */}
                          <td style={{ padding: '11px 18px 11px 16px', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                            {pendingRelease ? (
                              <button
                                type="button"
                                className="rcf-btn rcf-btn-ghost"
                                style={{ padding: '7px 14px', fontSize: '0.74rem', gap: 6, whiteSpace: 'nowrap', color: AZURE_DEEP, borderColor: 'rgba(47,125,246,0.35)' }}
                                onClick={() => onCancelRelease(item)}
                                disabled={cancelingDid === item.did}
                                title="Withdraw the pending release request — the number stays assigned"
                              >
                                {cancelingDid === item.did ? (
                                  <svg viewBox="0 0 16 16" style={{ width: 11, height: 11, animation: 'fx-spin 0.7s linear infinite' }}>
                                    <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(47,125,246,0.3)" strokeWidth={2} />
                                    <path d="M8 2a6 6 0 0 1 6 6" stroke={AZURE_DEEP} strokeWidth={2} fill="none" strokeLinecap="round" />
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
                        </tr>

                        {/* Expanded detail panel */}
                        {isExpanded && (
                          <tr>
                            <td
                              colSpan={7}
                              style={{
                                padding: '0 20px 20px 20px',
                                background: '#f7fafd',
                              }}
                            >
                              {/* Detail panel */}
                              <div
                                style={{
                                  background: '#ffffff',
                                  border: '1px solid #dfe6f0',
                                  borderRadius: 12,
                                  padding: '20px 22px',
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                                  gap: 16,
                                  position: 'relative',
                                  overflow: 'hidden',
                                  boxShadow: '0 8px 22px -14px rgba(14,23,38,0.25)',
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
                                    background: 'linear-gradient(90deg, transparent, rgba(47,125,246,0.5), transparent)',
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
                                    <span className="dl-tag">{item.product_type ?? 'RCF'}</span>
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
                    <span style={{ fontSize: '0.85rem', color: location ? INK_SOFT : '#a7b3c8', whiteSpace: 'nowrap' }}>
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
        <div style={{ padding: '16px 20px', margin: 16, borderRadius: 10, background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: RED, fontSize: '0.85rem' }}>
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
        <p style={{ margin: '0 0 14px', fontSize: '0.8rem', color: INK_DIM }}>
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
              background: '#e4eeff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke={AZURE_DEEP} strokeWidth={1.5} style={{ width: 26, height: 26 }}>
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
              <svg viewBox="0 0 24 24" fill="none" stroke="#b6c2d4" strokeWidth={1.5} style={{ width: 32, height: 32 }}>
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
                          <span style={{ fontSize: '0.85rem', color: location ? INK_SOFT : '#a7b3c8', whiteSpace: 'nowrap' }}>
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
                                <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={2} />
                                <path d="M8 2a6 6 0 0 1 6 6" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
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

interface DIDManagementTabProps {
  customerId: number | undefined;
  /**
   * Admin viewing ONE customer: GET /numbers/my returns every assigned DID
   * platform-wide for admins, so narrow it to this account client-side.
   * Undefined for tenants (the API already scopes them).
   */
  filterToCustomer?: number;
  onSwitchTab: (tab: DashboardTab) => void;
}

function DIDManagementTab({ customerId, filterToCustomer, onSwitchTab }: DIDManagementTabProps) {
  // ALL hooks unconditionally at top — React rules-of-hooks
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  // Only the tenant `user` role may request numbers — the API 403s everyone
  // else. Staff assign numbers in the inventory tool; readonly tenants are
  // view-only. Keyed on the REAL role (user.role, as canEdit is), so an
  // admin in customer-view mode — still role 'admin' — never sees Request.
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
          onRequestRelease={handleRequestReleaseClick}
          onCancelRelease={handleCancelRelease}
          cancelingDid={cancelReleaseMutation.isPending ? (cancelReleaseMutation.variables ?? null) : null}
          onSwitchToNumbers={() => onSwitchTab('numbers')}
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

// ─── Main Page ────────────────────────────────────────────────────────────────

/** `<select>` value → AdminScope ('' = placeholder, 'all', or a customer id). */
function parseScope(value: string): AdminScope {
  if (value === '') return null;
  if (value === 'all') return 'all';
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

export function RcfPage() {
  // ── All hooks unconditionally at top (React rules-of-hooks) ──────────────────
  const { user, isAdmin } = useAuth();

  // Tab state
  const [activeTab, setActiveTab] = useState<DashboardTab>('numbers');

  // Admin scope — starts EMPTY (null): nothing loads until the admin picks
  // "All Customers" or one account. Tenants are always ready (own account).
  const [adminScope, setAdminScope] = useState<AdminScope>(null);
  const scopeReady = !isAdmin || adminScope !== null;
  const adminCustomerId = typeof adminScope === 'number' ? adminScope : undefined;
  // customer_id filter for every scoped query: the admin's pick (undefined =
  // All Customers) or the tenant's own account.
  const customerId = isAdmin ? adminCustomerId : (user?.customer_id ?? undefined);

  // Customer list for the admin scope selector + the header title. Same query
  // key as other admin pages so React Query dedupes it. Only runs for admins.
  const { data: adminCustomersData } = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled: isAdmin,
    staleTime: 60_000,
  });
  const scopeCustomers = useMemo(
    () => (adminCustomersData?.items ?? []).filter((c) => ['rcf', 'hybrid'].includes(c.account_type)),
    [adminCustomersData],
  );
  const adminSelectedCustomerName = useMemo(() => {
    if (!isAdmin || adminCustomerId === undefined) return null;
    return adminCustomersData?.items.find((c) => c.id === adminCustomerId)?.name ?? null;
  }, [isAdmin, adminCustomerId, adminCustomersData]);

  // Numbers tab state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sortField, setSortField] = useState<SortField>('did');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [npaFilter, setNpaFilter] = useState('');
  // Expandable-row state — one row open at a time
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Numbers query — gated on scope: an admin opening the page must NOT pull
  // every customer's numbers before choosing what to look at.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf', customerId ?? 'all', page, pageSize],
    queryFn: () => listRcf({ limit: pageSize, offset: (page - 1) * pageSize, customer_id: customerId }),
    enabled: scopeReady,
  });

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  // Derived Numbers tab values
  const rawEntries: RcfEntry[] = useMemo(() => data?.items ?? [], [data]);
  const serverTotal: number = data?.total ?? 0;

  const filteredEntries = useMemo(() => {
    let result = rawEntries;
    if (npaFilter.length === 3) {
      result = result.filter((e) => extractNpa(e.did) === npaFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (e) =>
          e.did.includes(q) ||
          e.forward_to.toLowerCase().includes(q) ||
          (e.name ?? '').toLowerCase().includes(q) ||
          (e.customer_name ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [rawEntries, searchQuery, npaFilter]);

  const sortedEntries = useMemo(
    () => sortEntries(filteredEntries, sortField, sortDir),
    [filteredEntries, sortField, sortDir],
  );

  const role = user?.role ?? 'user';
  // readonly (customer view-only) and support (platform read-only) never edit.
  const canEdit = role !== 'readonly' && role !== 'support';
  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize));
  const activeCount = useMemo(() => rawEntries.filter((e) => e.enabled).length, [rawEntries]);
  const disabledCount = useMemo(() => rawEntries.filter((e) => !e.enabled).length, [rawEntries]);

  // ── Handlers ──────────────────────────────────────────────────────────────────

  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(value.trim());
      setPage(1);
    }, 250);
  }

  function handleScopeSelect(scope: AdminScope) {
    setAdminScope(scope);
    setPage(1);
    setSearchInput('');
    setSearchQuery('');
    setNpaFilter('');
    setExpandedId(null);
  }

  function handlePageChange(p: number) {
    setPage(p);
    setExpandedId(null);
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  // Header: admins get a FIXED console title with the scope as breadcrumb
  // context; tenants keep their account name (unchanged behavior).
  const pageTitle = isAdmin
    ? 'Administrative Call Forwarding Console'
    : (user?.customer_name ?? 'Call Forwarding Console');
  const headerContext = !isAdmin
    ? null
    : adminScope === 'all'
      ? 'All Customers'
      : adminCustomerId !== undefined
        ? (adminSelectedCustomerName ?? `Customer ${adminCustomerId}`)
        : null;
  const pageSubtitle = isAdmin && !scopeReady
    ? 'Select a customer to manage their forwarding destinations and monitor call health.'
    : 'Manage forwarding destinations and monitor call health across your numbers.';

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="rcf-scope">
      <div className="rcf-shell">
        {/* Quiet console header — breadcrumb, title, inline metrics, closing rule */}
        <RcfPageHeader
          title={pageTitle}
          subtitle={pageSubtitle}
          context={headerContext}
          showMetrics={scopeReady}
          total={serverTotal}
          active={activeCount}
          disabled={disabledCount}
          loaded={!isLoading && !isError}
        />

        {/* Admin customer scope — light select mirroring AdminCustomerSelector */}
        {isAdmin && (
          <div className="rcf-scopebar fx-load fx-load-d1">
            <span className="rcf-scopebar-label">Viewing</span>
            <select
              className="rcf-input"
              style={{ minWidth: 260, fontSize: '0.84rem' }}
              aria-label="Customer scope"
              value={adminScope === null ? '' : String(adminScope)}
              onChange={(e) => handleScopeSelect(parseScope(e.target.value))}
            >
              <option value="" disabled>Select a customer…</option>
              <option value="all">All Customers</option>
              {scopeCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.account_type.toUpperCase()})
                </option>
              ))}
            </select>
            {adminScope !== null && (
              <button
                type="button"
                onClick={() => handleScopeSelect(null)}
                style={{
                  fontSize: '0.72rem',
                  color: INK_DIM,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                  fontFamily: 'inherit',
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* ── Admin pre-selection: nothing loads, nothing renders ── */}
        {!scopeReady && <ScopePrompt message="Select a customer to view their call forwarding numbers" />}

        {/* ── Tab navigation ──────────────────────────────────── */}
        {scopeReady && <TabBar active={activeTab} onChange={setActiveTab} />}

        {/* ── Numbers Tab ─────────────────────────────────────── */}
        {scopeReady && activeTab === 'numbers' && (
          <>
            {/* Toolbar: Search + NPA filter + count */}
            {!isLoading && !isError && (
              <div className="fx-load fx-load-d2" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {/* Search bar */}
                <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      left: 13,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#9aa9c0',
                      display: 'flex',
                      alignItems: 'center',
                      pointerEvents: 'none',
                    }}
                  >
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                      <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <input
                    type="text"
                    className="rcf-input"
                    value={searchInput}
                    onChange={(e) => handleSearchInput(e.target.value)}
                    placeholder="Filter by DID, name, or destination…"
                    style={{ width: '100%', padding: '9px 36px' }}
                  />
                  {searchInput && (
                    <button
                      type="button"
                      onClick={() => { setSearchInput(''); setSearchQuery(''); }}
                      style={{
                        position: 'absolute',
                        right: 10,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'rgba(47,125,246,0.08)',
                        border: '1px solid rgba(47,125,246,0.2)',
                        borderRadius: 5,
                        color: AZURE_DEEP,
                        cursor: 'pointer',
                        padding: '2px 5px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 10, height: 10 }}>
                        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* NPA (area code) filter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <label style={{ fontSize: '0.68rem', fontWeight: 700, color: INK_DIM, whiteSpace: 'nowrap', letterSpacing: '0.06em' }}>
                    NPA
                  </label>
                  <input
                    type="text"
                    className="rcf-input rcf-input-mono"
                    value={npaFilter}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 3);
                      setNpaFilter(v);
                      setPage(1);
                    }}
                    placeholder="617"
                    maxLength={3}
                    inputMode="numeric"
                    title="Filter by area code (NPA)"
                    style={{
                      width: 58,
                      textAlign: 'center',
                      letterSpacing: '0.08em',
                      color: npaFilter.length === 3 ? AZURE_DEEP : undefined,
                      borderColor: npaFilter.length === 3 ? 'rgba(47,125,246,0.55)' : undefined,
                    }}
                  />
                  {npaFilter && (
                    <button
                      type="button"
                      onClick={() => { setNpaFilter(''); setPage(1); }}
                      style={{
                        background: 'rgba(47,125,246,0.07)',
                        border: '1px solid rgba(47,125,246,0.18)',
                        borderRadius: 5,
                        color: AZURE_DEEP,
                        cursor: 'pointer',
                        padding: '3px 5px',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                      title="Clear NPA filter"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 9, height: 9 }}>
                        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Count pill (shows filtered subset when a filter is active) */}
                {serverTotal > 0 && (searchQuery || npaFilter.length === 3) && filteredEntries.length !== rawEntries.length && (
                  <div
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      color: AZURE_DEEP,
                      background: 'rgba(47,125,246,0.08)',
                      border: '1px solid rgba(47,125,246,0.22)',
                      borderRadius: 20,
                      padding: '5px 13px',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {`${filteredEntries.length} of ${serverTotal} shown`}
                  </div>
                )}
              </div>
            )}

            {/* Loading */}
            {isLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: INK_DIM, fontSize: '0.875rem', padding: '48px 0', justifyContent: 'center' }}>
                <Spinner size="sm" />
                <span>Loading your numbers…</span>
              </div>
            )}

            {/* Error */}
            {isError && (
              <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.22)', color: RED, fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: 10 }}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16, flexShrink: 0 }}>
                  <circle cx="8" cy="8" r="7" />
                  <path d="M8 5v3.5M8 10.5v.5" strokeLinecap="round" />
                </svg>
                Unable to load RCF numbers. Please try refreshing the page.
              </div>
            )}

            {/* Empty (no numbers at all) */}
            {!isLoading && !isError && rawEntries.length === 0 && <EmptyState />}

            {/* Search empty state */}
            {!isLoading && !isError && rawEntries.length > 0 && sortedEntries.length === 0 && searchQuery && (
              <SearchEmptyState query={searchQuery} onClear={() => { setSearchInput(''); setSearchQuery(''); }} />
            )}

            {/* Expandable-row number table — both admin and customer views */}
            {!isLoading && !isError && sortedEntries.length > 0 && (
              <div className="rcf-panel fx-load fx-load-d3">
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: isAdmin ? 760 : 640 }}>
                    <thead>
                      <tr>
                        <th className="rcf-th" style={{ width: 34, padding: '11px 4px 11px 18px' }} aria-label="Expand" />
                        <SortHeader label="Number"      field="did"        width={190} currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Forwards To" field="forward_to" width={230} currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Label"       field="name"                   currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Status"      field="status"     width={120} currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        {isAdmin && (
                          <SortHeader label="Customer" field="customer" currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedEntries.map((entry) => (
                        <NumberRow
                          key={entry.id}
                          entry={entry}
                          isAdmin={isAdmin}
                          canEdit={canEdit}
                          expanded={expandedId === entry.id}
                          onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                          onCollapse={() => setExpandedId(null)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                {serverTotal > pageSize && (
                  <PaginationControls
                    currentPage={page}
                    totalPages={totalPages}
                    pageSize={pageSize}
                    totalItems={serverTotal}
                    onPageChange={handlePageChange}
                    onPageSizeChange={(size) => { setPageSize(size); handlePageChange(1); }}
                  />
                )}
              </div>
            )}
          </>
        )}

        {/* ── Call Activity Tab ────────────────────────────────── */}
        {/* Keyed per scope so a DID / range picked under one customer
            never carries over to the next. */}
        {scopeReady && activeTab === 'activity' && (
          <CallActivityTab key={`activity-${customerId ?? 'all'}`} customerId={customerId} />
        )}

        {/* ── DID Management Tab ───────────────────────────────── */}
        {/* Inventory actions are per account — "All Customers" asks for one. */}
        {scopeReady && activeTab === 'dids' && (
          isAdmin && adminScope === 'all' ? (
            <ScopePrompt message="Select a single customer to manage their DIDs" />
          ) : (
            <DIDManagementTab
              customerId={customerId}
              filterToCustomer={isAdmin ? adminCustomerId : undefined}
              onSwitchTab={setActiveTab}
            />
          )
        )}
      </div>
    </div>
  );
}
