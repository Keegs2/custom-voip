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
import { searchCdrs } from '../api/cdrs';
import type { Cdr } from '../types/cdr';
import {
  listAvailableDids,
  listMyDids,
  requestDid,
  requestDidRelease,
  cancelDidRelease,
} from '../api/didInventory';
import type { DidInventoryItem } from '../types/didInventory';
import { Reveal } from '../components/fx/Reveal';

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

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

// Daylight palette constants (mirror the .rcf-scope CSS vars for inline SVG etc.)
const INK = '#0e1726';
const INK_SOFT = '#46566f';
const INK_DIM = '#5d6f8c';
const INK_FAINT = '#8b99b0';
const AZURE = '#2f7df6';
const AZURE_DEEP = '#1d63dd';
const GREEN = '#15803d';
const RED = '#b91c1c';

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

// ─── PaginationControls ───────────────────────────────────────────────────────

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

function PaginationControls({
  currentPage,
  totalPages,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: PaginationControlsProps) {
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  const pageNumbers: (number | 'ellipsis')[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageNumbers.push(i);
  } else {
    pageNumbers.push(1);
    if (currentPage > 3) pageNumbers.push('ellipsis');
    const rangeStart = Math.max(2, currentPage - 1);
    const rangeEnd = Math.min(totalPages - 1, currentPage + 1);
    for (let i = rangeStart; i <= rangeEnd; i++) pageNumbers.push(i);
    if (currentPage < totalPages - 2) pageNumbers.push('ellipsis');
    pageNumbers.push(totalPages);
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        padding: '14px 20px',
        borderTop: '1px solid var(--rcf-line)',
        background: 'var(--rcf-tint)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: '0.75rem', color: INK_DIM }}>
          Showing{' '}
          <strong style={{ color: INK_SOFT, fontVariantNumeric: 'tabular-nums' }}>{start}–{end}</strong>
          {' '}of{' '}
          <strong style={{ color: INK_SOFT, fontVariantNumeric: 'tabular-nums' }}>{totalItems}</strong>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: '0.7rem', color: INK_FAINT }}>Per page:</span>
          <select
            className="rcf-input"
            value={pageSize}
            onChange={(e) => { onPageSizeChange(Number(e.target.value)); onPageChange(1); }}
            style={{ fontSize: '0.75rem', padding: '4px 28px 4px 8px' }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button
          type="button"
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
          className="rcf-pgbtn"
          aria-label="Previous page"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11 }}>
            <path d="M10 12L6 8l4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {pageNumbers.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`ell-${i}`} style={{ color: INK_FAINT, padding: '0 4px', fontSize: '0.78rem' }}>…</span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              className={currentPage === p ? 'rcf-pgbtn rcf-pgbtn-active' : 'rcf-pgbtn'}
            >
              {p}
            </button>
          ),
        )}

        <button
          type="button"
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          className="rcf-pgbtn"
          aria-label="Next page"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11 }}>
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── Page header ──────────────────────────────────────────────────────────────

interface RcfPageHeaderProps {
  title: string;
  subtitle: string;
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
function RcfPageHeader({ title, subtitle, total, active, disabled, loaded }: RcfPageHeaderProps) {
  return (
    <header className="rcf-header fx-load">
      <div className="rcf-header-id">
        <div className="rcf-crumb">
          <span>Remote Call Forwarding</span>
          <span className="rcf-crumb-sep" aria-hidden="true">/</span>
          <span>Granite CRAG</span>
        </div>
        <h1 className="rcf-title">{title}</h1>
        <p className="rcf-sub">{subtitle}</p>
      </div>

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

// ─── Time helpers ─────────────────────────────────────────────────────────────

function timeAgo(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ─── Quality colour helpers (daylight palette — green/red semantics only) ─────

function mosLabel(mos: number | null | undefined): { text: string; color: string; dot: string } {
  if (mos == null) return { text: '—', color: INK_FAINT, dot: INK_FAINT };
  if (mos >= 4.0) return { text: 'Great', color: GREEN, dot: '#16a34a' };
  if (mos >= 3.0) return { text: 'OK', color: INK_SOFT, dot: '#94a3b8' };
  return { text: 'Poor', color: RED, dot: '#dc2626' };
}

function carrierDisplayName(carrier: string | null | undefined): string {
  if (!carrier) return '—';
  switch (carrier) {
    case 'carrier_primary': return 'Bandwidth Dallas';
    case 'carrier_secondary': return 'Bandwidth LA';
    default: return carrier.replace(/^carrier_/, '').replace(/_/g, ' ');
  }
}

function callStatusInfo(cdr: Cdr): { label: string; bg: string; color: string; border: string } {
  const GOOD    = { bg: 'rgba(22,163,74,0.1)',   color: GREEN,    border: '1px solid rgba(22,163,74,0.24)' };
  const NEUTRAL = { bg: 'rgba(93,111,140,0.1)',  color: INK_SOFT, border: '1px solid rgba(93,111,140,0.24)' };
  const BAD     = { bg: 'rgba(220,38,38,0.07)',  color: RED,      border: '1px solid rgba(220,38,38,0.22)' };
  const INFO    = { bg: 'rgba(47,125,246,0.09)', color: AZURE_DEEP, border: '1px solid rgba(47,125,246,0.24)' };

  const cause = (cdr.hangup_cause ?? '').toUpperCase();

  // Answered calls (has answer_time and non-zero duration)
  if (cdr.answer_time != null && cdr.duration_seconds > 0) {
    return { label: 'Answered', ...GOOD };
  }

  // Map specific hangup causes to friendly labels
  switch (cause) {
    case 'ORIGINATOR_CANCEL':
      return { label: 'Caller Hung Up', ...NEUTRAL };
    case 'NO_ANSWER':
      return { label: 'No Answer', ...NEUTRAL };
    case 'USER_BUSY':
      return { label: 'Busy', ...BAD };
    case 'CALL_REJECTED':
      return { label: 'Rejected', ...BAD };
    case 'NORMAL_TEMPORARY_FAILURE':
      return { label: 'Unavailable', ...BAD };
    case 'UNALLOCATED_NUMBER':
      return { label: 'Invalid Number', ...BAD };
    case 'NO_ROUTE_DESTINATION':
      return { label: 'No Route', ...BAD };
    case 'RECOVERY_ON_TIMER_EXPIRE':
      return { label: 'Timed Out', ...BAD };
    case 'NORMAL_CLEARING':
      if (cdr.answer_time == null) return { label: 'Not Connected', ...NEUTRAL };
      return { label: 'Answered', ...GOOD };
    default:
      break;
  }

  // SIP error codes
  if (cdr.sip_code != null && cdr.sip_code >= 400) {
    if (cdr.sip_code === 486) return { label: 'Busy', ...BAD };
    if (cdr.sip_code === 487) return { label: 'Cancelled', ...NEUTRAL };
    if (cdr.sip_code === 603) return { label: 'Declined', ...BAD };
    return { label: 'Failed', ...BAD };
  }

  // Fallback: no answer_time and zero duration = never connected
  if (cdr.answer_time == null) {
    return { label: 'No Answer', ...NEUTRAL };
  }

  return { label: 'Answered', ...INFO };
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

// ─── CallActivityTab ──────────────────────────────────────────────────────────

interface CallActivityTabProps {
  customerId: number | undefined;
}

/** Compute aggregate quality stats from a list of CDRs. */
function computeQualityStats(cdrs: Cdr[]) {
  let answered = 0;
  let mosSum = 0;
  let mosCount = 0;
  let durationSum = 0;

  for (const cdr of cdrs) {
    if (cdr.answer_time != null && cdr.duration_seconds > 0) {
      answered++;
      durationSum += cdr.duration_seconds;
    }
    if (cdr.mos != null) {
      mosSum += cdr.mos;
      mosCount++;
    }
  }

  const total = cdrs.length;
  const asr = total > 0 ? (answered / total) * 100 : null;
  const avgMos = mosCount > 0 ? mosSum / mosCount : null;
  const acd = answered > 0 ? durationSum / answered : null;

  return { total, answered, asr, avgMos, acd };
}

// ─── DailyStats type ─────────────────────────────────────────────────────────

interface DailyStats {
  date: string;          // YYYY-MM-DD
  label: string;         // "Mon, Apr 28"
  shortLabel: string;    // "Mon"
  total: number;
  answered: number;
  asr: number | null;    // 0–100, null if no calls
  avgMos: number | null; // 1.0–5.0, null if no MOS data
}

/** Build daily quality summary for the last 7 days. */
function buildDailyDots(cdrs: Cdr[]): DailyStats[] {
  const byDate = new Map<string, { mosSum: number; mosCount: number; total: number; answered: number }>();

  for (const cdr of cdrs) {
    const key = cdr.start_time.slice(0, 10);
    const bucket = byDate.get(key) ?? { mosSum: 0, mosCount: 0, total: 0, answered: 0 };
    bucket.total++;
    if (cdr.answer_time != null && cdr.duration_seconds > 0) bucket.answered++;
    if (cdr.mos != null) { bucket.mosSum += cdr.mos; bucket.mosCount++; }
    byDate.set(key, bucket);
  }

  const result: DailyStats[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const shortLabel = d.toLocaleDateString(undefined, { weekday: 'short' });
    const b = byDate.get(key);

    if (!b || b.total === 0) {
      result.push({ date: key, label, shortLabel, total: 0, answered: 0, asr: null, avgMos: null });
      continue;
    }

    const asr = (b.answered / b.total) * 100;
    const avgMos = b.mosCount > 0 ? b.mosSum / b.mosCount : null;
    result.push({ date: key, label, shortLabel, total: b.total, answered: b.answered, asr, avgMos });
  }
  return result;
}

// ─── WeeklyChart — recolored for the daylight canvas ──────────────────────────

interface WeeklyChartProps {
  days: DailyStats[];
}

const CHART_MOS = '#16a34a';
const CHART_ASR = AZURE;

function WeeklyChart({ days }: WeeklyChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Chart geometry constants
  const W = 600;
  const H = 180;
  const PAD_LEFT = 36;   // room for left Y-axis labels
  const PAD_RIGHT = 36;  // room for right Y-axis labels
  const PAD_TOP = 14;
  const PAD_BOTTOM = 28; // room for X-axis labels
  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  // X positions for 7 evenly spaced data points
  const xPos = (i: number) => PAD_LEFT + (i / 6) * innerW;

  // Y scale helpers: MOS 1–5 on left, ASR 0–100 on right
  const yMos = (v: number) => PAD_TOP + (1 - (v - 1) / 4) * innerH;
  const yAsr = (v: number) => PAD_TOP + (1 - v / 100) * innerH;

  // Build monotone cubic spline paths, skipping gaps where data is null.
  function buildSplinePath(
    points: Array<{ x: number; y: number } | null>,
  ): string {
    const segments: string[] = [];
    let runStart = -1;
    let run: Array<{ x: number; y: number }> = [];

    const flushRun = () => {
      if (run.length === 0) return;
      if (run.length === 1) {
        segments.push(`M ${run[0].x} ${run[0].y}`);
      } else {
        segments.push(monotoneCubicPath(run));
      }
      run = [];
      runStart = -1;
    };

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (pt === null) {
        flushRun();
      } else {
        if (runStart === -1) runStart = i;
        run.push(pt);
      }
    }
    flushRun();
    return segments.join(' ');
  }

  // Monotone cubic interpolation — smooth curves that never overshoot
  function monotoneCubicPath(pts: Array<{ x: number; y: number }>): string {
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    const n = pts.length;
    const dx = pts.map((p, i) => i < n - 1 ? pts[i + 1].x - p.x : 0);
    const dy = pts.map((p, i) => i < n - 1 ? pts[i + 1].y - p.y : 0);
    const m = pts.map((_, i) => i < n - 1 ? dy[i] / dx[i] : 0);
    const t: number[] = new Array(n).fill(0);
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
      const alpha = t[i] / m[i];
      const beta = t[i + 1] / m[i];
      const s = alpha * alpha + beta * beta;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] *= k; t[i + 1] *= k; }
    }
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < n - 1; i++) {
      const cp1x = pts[i].x + dx[i] / 3;
      const cp1y = pts[i].y + t[i] * dx[i] / 3;
      const cp2x = pts[i + 1].x - dx[i] / 3;
      const cp2y = pts[i + 1].y - t[i + 1] * dx[i] / 3;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${pts[i + 1].x.toFixed(2)} ${pts[i + 1].y.toFixed(2)}`;
    }
    return d;
  }

  // Build area fill path: line path + vertical drop to baseline + close
  function buildAreaPath(
    points: Array<{ x: number; y: number } | null>,
    baseline: number,
  ): string {
    const areas: string[] = [];
    let run: Array<{ x: number; y: number }> = [];

    const flushArea = () => {
      if (run.length < 2) { run = []; return; }
      const linePath = monotoneCubicPath(run);
      const closeSegment = ` L ${run[run.length - 1].x.toFixed(2)} ${baseline.toFixed(2)} L ${run[0].x.toFixed(2)} ${baseline.toFixed(2)} Z`;
      areas.push(linePath + closeSegment);
      run = [];
    };

    for (const pt of points) {
      if (pt === null) { flushArea(); } else { run.push(pt); }
    }
    flushArea();
    return areas.join(' ');
  }

  const mosMemo = useMemo(() => {
    const pts = days.map((d, i) =>
      d.avgMos !== null ? { x: xPos(i), y: yMos(d.avgMos) } : null,
    );
    return {
      linePath: buildSplinePath(pts),
      areaPath: buildAreaPath(pts, PAD_TOP + innerH),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const asrMemo = useMemo(() => {
    const pts = days.map((d, i) =>
      d.asr !== null ? { x: xPos(i), y: yAsr(d.asr) } : null,
    );
    return {
      linePath: buildSplinePath(pts),
      areaPath: buildAreaPath(pts, PAD_TOP + innerH),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const hoveredDay = hoveredIdx !== null ? days[hoveredIdx] : null;

  return (
    <div className="rcf-panel" style={{ padding: '18px 20px 16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: '#e4eeff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke={AZURE_DEEP} strokeWidth={1.8} style={{ width: 10, height: 10 }}>
            <polyline points="1,12 5,7 8,9 12,4 15,6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="rcf-panel-title">7-Day Performance</span>
      </div>

      {/* SVG chart — uses viewBox for responsive width */}
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
          aria-label="7-day call quality chart"
        >
          <defs>
            <linearGradient id="mos-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_MOS} stopOpacity="0.14" />
              <stop offset="100%" stopColor={CHART_MOS} stopOpacity="0" />
            </linearGradient>
            <linearGradient id="asr-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_ASR} stopOpacity="0.12" />
              <stop offset="100%" stopColor={CHART_ASR} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* ── Background grid lines ─────────────────────────────── */}
          {[1, 2, 3, 4, 5].map((mosVal) => {
            const y = yMos(mosVal);
            return (
              <line
                key={`mos-grid-${mosVal}`}
                x1={PAD_LEFT} y1={y} x2={PAD_LEFT + innerW} y2={y}
                stroke="rgba(14,23,38,0.05)"
                strokeWidth={1}
              />
            );
          })}

          {/* ── Threshold grid lines (dashed) ─────────────────────── */}
          <line
            x1={PAD_LEFT} y1={yMos(3.0)} x2={PAD_LEFT + innerW} y2={yMos(3.0)}
            stroke="rgba(220,38,38,0.16)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          <line
            x1={PAD_LEFT} y1={yMos(4.0)} x2={PAD_LEFT + innerW} y2={yMos(4.0)}
            stroke="rgba(22,163,74,0.2)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          <line
            x1={PAD_LEFT} y1={yAsr(85)} x2={PAD_LEFT + innerW} y2={yAsr(85)}
            stroke="rgba(47,125,246,0.14)"
            strokeWidth={1}
            strokeDasharray="3 5"
          />
          <line
            x1={PAD_LEFT} y1={yAsr(95)} x2={PAD_LEFT + innerW} y2={yAsr(95)}
            stroke="rgba(47,125,246,0.14)"
            strokeWidth={1}
            strokeDasharray="3 5"
          />

          {/* ── Y-axis labels (left = MOS) ─────────────────────────── */}
          {[1, 2, 3, 4, 5].map((v) => (
            <text
              key={`mos-label-${v}`}
              x={PAD_LEFT - 5}
              y={yMos(v) + 4}
              textAnchor="end"
              fill="#7c8ba3"
              fontSize={8}
              fontFamily={MONO}
            >
              {v}
            </text>
          ))}

          {/* ── Y-axis labels (right = ASR%) ──────────────────────── */}
          {[0, 50, 85, 95, 100].map((v) => (
            <text
              key={`asr-label-${v}`}
              x={PAD_LEFT + innerW + 5}
              y={yAsr(v) + 4}
              textAnchor="start"
              fill="#7c8ba3"
              fontSize={8}
              fontFamily={MONO}
            >
              {v}%
            </text>
          ))}

          {/* ── Axis titles ───────────────────────────────────────── */}
          <text
            x={8}
            y={PAD_TOP + innerH / 2}
            textAnchor="middle"
            fill="#7c8ba3"
            fontSize={7.5}
            fontFamily="system-ui, sans-serif"
            letterSpacing="0.05em"
            transform={`rotate(-90, 8, ${PAD_TOP + innerH / 2})`}
          >
            MOS
          </text>
          <text
            x={W - 6}
            y={PAD_TOP + innerH / 2}
            textAnchor="middle"
            fill="#7c8ba3"
            fontSize={7.5}
            fontFamily="system-ui, sans-serif"
            letterSpacing="0.05em"
            transform={`rotate(90, ${W - 6}, ${PAD_TOP + innerH / 2})`}
          >
            ASR%
          </text>

          {/* ── Area fills ────────────────────────────────────────── */}
          <path d={mosMemo.areaPath} fill="url(#mos-fill)" />
          <path d={asrMemo.areaPath} fill="url(#asr-fill)" />

          {/* ── Line paths ────────────────────────────────────────── */}
          <path
            d={mosMemo.linePath}
            fill="none"
            stroke={CHART_MOS}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={asrMemo.linePath}
            fill="none"
            stroke={CHART_ASR}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* ── X-axis labels + data dots ─────────────────────────── */}
          {days.map((day, i) => {
            const x = xPos(i);
            const hasData = day.total > 0;
            const isHovered = hoveredIdx === i;

            return (
              <g key={day.date}>
                <text
                  x={x}
                  y={H - 4}
                  textAnchor="middle"
                  fill={isHovered ? INK_SOFT : '#8b99b0'}
                  fontSize={8.5}
                  fontFamily="system-ui, sans-serif"
                  style={{ transition: 'fill 0.15s' }}
                >
                  {day.shortLabel}
                </text>

                {/* Invisible wide hit area for hover */}
                <rect
                  x={x - innerW / 14}
                  y={PAD_TOP}
                  width={innerW / 7}
                  height={innerH}
                  fill="transparent"
                  style={{ cursor: hasData ? 'crosshair' : 'default' }}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                />

                {hasData ? (
                  <>
                    {/* MOS dot */}
                    {day.avgMos !== null && (
                      <circle
                        cx={x}
                        cy={yMos(day.avgMos)}
                        r={isHovered ? 4.5 : 3}
                        fill={isHovered ? CHART_MOS : '#ffffff'}
                        stroke={CHART_MOS}
                        strokeWidth={isHovered ? 2 : 1.5}
                        style={{ transition: 'r 0.15s, fill 0.15s' }}
                        onMouseEnter={() => setHoveredIdx(i)}
                        onMouseLeave={() => setHoveredIdx(null)}
                      />
                    )}
                    {/* ASR dot */}
                    {day.asr !== null && (
                      <circle
                        cx={x}
                        cy={yAsr(day.asr)}
                        r={isHovered ? 4.5 : 3}
                        fill={isHovered ? CHART_ASR : '#ffffff'}
                        stroke={CHART_ASR}
                        strokeWidth={isHovered ? 2 : 1.5}
                        style={{ transition: 'r 0.15s, fill 0.15s' }}
                        onMouseEnter={() => setHoveredIdx(i)}
                        onMouseLeave={() => setHoveredIdx(null)}
                      />
                    )}
                    {/* Vertical hover line */}
                    {isHovered && (
                      <line
                        x1={x} y1={PAD_TOP} x2={x} y2={PAD_TOP + innerH}
                        stroke="rgba(14,23,38,0.08)"
                        strokeWidth={1}
                      />
                    )}
                  </>
                ) : (
                  /* No-data marker: subtle hollow circle at chart midpoint */
                  <circle
                    cx={x}
                    cy={PAD_TOP + innerH / 2}
                    r={2.5}
                    fill="none"
                    stroke="rgba(14,23,38,0.15)"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                  />
                )}
              </g>
            );
          })}
        </svg>

        {/* ── Hover tooltip (absolutely positioned over SVG) ─────── */}
        {hoveredDay !== null && hoveredIdx !== null && (
          <div
            style={{
              position: 'absolute',
              left: `clamp(0px, calc(${((hoveredIdx / 6) * 100).toFixed(1)}% - 90px), calc(100% - 200px))`,
              top: 4,
              pointerEvents: 'none',
              background: '#ffffff',
              border: '1px solid #dfe6f0',
              borderRadius: 8,
              padding: '8px 12px',
              minWidth: 190,
              boxShadow: '0 12px 28px -8px rgba(14,23,38,0.28)',
              zIndex: 10,
            }}
          >
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: INK, marginBottom: 6 }}>
              {hoveredDay.label}
            </div>
            {hoveredDay.total === 0 ? (
              <div style={{ fontSize: '0.68rem', color: INK_FAINT }}>No calls recorded</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ fontSize: '0.68rem', color: INK_DIM }}>Calls</span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>
                    {hoveredDay.total}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: AZURE_DEEP }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: CHART_ASR, display: 'inline-block', flexShrink: 0 }} />
                    ASR
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>
                    {hoveredDay.asr !== null ? `${hoveredDay.asr.toFixed(1)}%` : '—'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: GREEN }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: CHART_MOS, display: 'inline-block', flexShrink: 0 }} />
                    MOS
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>
                    {hoveredDay.avgMos !== null ? hoveredDay.avgMos.toFixed(2) : '—'}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="20" height="6" style={{ flexShrink: 0 }}>
            <line x1="0" y1="3" x2="20" y2="3" stroke={CHART_MOS} strokeWidth="2" strokeLinecap="round" />
            <circle cx="10" cy="3" r="2.5" fill="#ffffff" stroke={CHART_MOS} strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: '0.66rem', color: INK_DIM }}>MOS (left axis, 1–5)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="20" height="6" style={{ flexShrink: 0 }}>
            <line x1="0" y1="3" x2="20" y2="3" stroke={CHART_ASR} strokeWidth="2" strokeLinecap="round" />
            <circle cx="10" cy="3" r="2.5" fill="#ffffff" stroke={CHART_ASR} strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: '0.66rem', color: INK_DIM }}>ASR% (right axis, 0–100%)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="14" height="14" style={{ flexShrink: 0 }}>
            <circle cx="7" cy="7" r="4" fill="none" stroke="rgba(14,23,38,0.2)" strokeWidth="1" strokeDasharray="2 2" />
          </svg>
          <span style={{ fontSize: '0.66rem', color: INK_FAINT }}>No data</span>
        </div>
      </div>
    </div>
  );
}

function CallActivityTab({ customerId }: CallActivityTabProps) {
  // ALL hooks unconditionally at top — rules of hooks (#310 prevention)
  const [activitySearch, setActivitySearch] = useState('');
  const [selectedDid, setSelectedDid] = useState<string | null>(null);
  const [didDropdownOpen, setDidDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf-activity', customerId],
    queryFn: () =>
      // No sort params — GET /cdrs doesn't declare any; it always returns
      // ORDER BY start_time DESC (the old sort_by/sort_dir were silently
      // dropped by FastAPI).
      searchCdrs({
        customer_id: customerId,
        product_type: 'rcf',
        limit: 200,
      }),
    enabled: true,
    staleTime: 60_000,
  });

  const { data: rcfData } = useQuery({
    queryKey: ['rcf-dids', customerId],
    queryFn: () => listRcf({ customer_id: customerId, limit: 500 }),
    staleTime: 60_000,
  });
  const rcfEntries: RcfEntry[] = rcfData?.items ?? [];

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!didDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDidDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [didDropdownOpen]);

  const allCalls = data?.items ?? [];

  // Client-side DID filter — applies before search and stats
  const filteredCalls = useMemo(() => {
    if (!selectedDid) return allCalls;
    return allCalls.filter((c) => c.destination === selectedDid);
  }, [allCalls, selectedDid]);

  const stats = useMemo(() => computeQualityStats(filteredCalls), [filteredCalls]);
  const dailyDots = useMemo(() => buildDailyDots(filteredCalls), [filteredCalls]);

  // Table rows: DID filter + search filter stacked
  const calls = useMemo(() => {
    if (!activitySearch.trim()) return filteredCalls;
    const q = activitySearch.trim().toLowerCase();
    return filteredCalls.filter((c) => {
      const fields = [
        c.caller_id,
        c.destination,
        c.hangup_cause,
        c.carrier_used,
        c.start_time,
        c.sip_code?.toString(),
        fmt(c.caller_id),
        fmt(c.destination),
      ];
      return fields.some((f) => f && f.toLowerCase().includes(q));
    });
  }, [filteredCalls, activitySearch]);

  // Selected DID label for display
  const selectedEntry = rcfEntries.find((e) => e.did === selectedDid) ?? null;
  const selectedLabel = selectedEntry
    ? `${fmt(selectedEntry.did)}${selectedEntry.name ? ` — ${selectedEntry.name}` : ''}`
    : null;

  // MOS is quality we measure — green/red thresholds apply.
  // ASR / calls / ACD are informational and stay in the neutral ink scale.
  const avgMosColor =
    stats.avgMos == null ? INK_FAINT
    : stats.avgMos >= 4.0 ? GREEN
    : stats.avgMos >= 3.0 ? INK_SOFT
    : RED;
  const avgMosKeyline =
    stats.avgMos == null ? '#c6d2e4'
    : stats.avgMos >= 4.0 ? '#16a34a'
    : stats.avgMos >= 3.0 ? '#c6d2e4'
    : '#dc2626';

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '64px 0', color: INK_DIM }}>
        <Spinner size="sm" />
        <span style={{ fontSize: '0.875rem' }}>Loading recent calls…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: RED, fontSize: '0.875rem' }}>
        Unable to load call activity. Please try refreshing.
      </div>
    );
  }

  if (allCalls.length === 0) {
    return (
      <div
        className="rcf-panel"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '72px 24px',
          gap: 16,
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
            <path d="M2 12 L5 8 L7 11 L11 5 L13 8 L17 4 L22 9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <p style={{ color: INK, fontSize: '1rem', fontWeight: 700, margin: '0 0 6px' }}>
            No recent calls
          </p>
          <p style={{ color: INK_DIM, fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 360 }}>
            Once calls start flowing, your activity log will light up here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingBottom: 40 }}>

      {/* ── DID Selector bar ───────────────────────────────────── */}
      {rcfEntries.length > 0 && (
        <div
          className="rcf-panel fx-load"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 18px',
            position: 'relative',
            zIndex: 50,
            overflow: 'visible',
            borderColor: selectedDid ? 'rgba(47,125,246,0.4)' : undefined,
          }}
        >
          {/* Left: icon + label */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 7,
                background: '#e4eeff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke={AZURE_DEEP} strokeWidth={1.7} style={{ width: 11, height: 11 }}>
                <path d="M3 5a2 2 0 0 1 2-2h1.28a.8.8 0 0 1 .758.547l.6 1.797a.8.8 0 0 1-.401.968l-.903.452a8.833 8.833 0 0 0 4.413 4.413l.452-.903a.8.8 0 0 1 .968-.401l1.797.6A.8.8 0 0 1 14 11.72V13a2 2 0 0 1-2 2h-.4C5.87 15 1 10.13 1 4.4V4a1 1 0 0 1 1-1h1z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span style={{ fontSize: '0.66rem', fontWeight: 700, color: INK_DIM, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Viewing
            </span>
          </div>

          {/* Centre: custom dropdown */}
          <div ref={dropdownRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <button
              type="button"
              onClick={() => setDidDropdownOpen((o) => !o)}
              className="rcf-input"
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                borderColor: didDropdownOpen ? AZURE : selectedDid ? 'rgba(47,125,246,0.45)' : undefined,
                boxShadow: didDropdownOpen ? '0 0 0 3px rgba(47,125,246,0.16)' : undefined,
                background: '#ffffff',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedDid ? (
                  <span style={{ fontSize: '0.84rem', fontWeight: 700, color: AZURE_DEEP, fontFamily: MONO, letterSpacing: '0.01em' }}>
                    {selectedLabel}
                  </span>
                ) : (
                  <span style={{ fontSize: '0.84rem', fontWeight: 700, color: INK }}>
                    All Numbers
                  </span>
                )}
              </span>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke={selectedDid ? AZURE_DEEP : INK_DIM}
                strokeWidth={2}
                style={{
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                  transform: didDropdownOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.18s',
                }}
              >
                <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* Dropdown panel */}
            {didDropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  right: 0,
                  zIndex: 999,
                  background: '#ffffff',
                  border: '1px solid #d5deeb',
                  borderRadius: 12,
                  overflow: 'hidden',
                  boxShadow: '0 20px 44px -12px rgba(14,23,38,0.32)',
                  animation: 'fx-rise 0.12s ease',
                }}
              >
                {/* All Numbers option */}
                <button
                  type="button"
                  onClick={() => { setSelectedDid(null); setDidDropdownOpen(false); }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '11px 14px',
                    border: 'none',
                    borderBottom: '1px solid var(--rcf-line)',
                    background: !selectedDid ? 'rgba(47,125,246,0.07)' : 'transparent',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                    transition: 'background 0.14s',
                  }}
                  onMouseEnter={(e) => { if (selectedDid) e.currentTarget.style.background = '#f2f7ff'; }}
                  onMouseLeave={(e) => { if (selectedDid) e.currentTarget.style.background = 'transparent'; }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      background: !selectedDid ? '#dfeaff' : '#eef2f8',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      transition: 'background 0.14s',
                    }}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke={!selectedDid ? AZURE_DEEP : INK_DIM} strokeWidth={1.7} style={{ width: 11, height: 11 }}>
                      <rect x="2" y="2" width="5" height="5" rx="1.2" />
                      <rect x="9" y="2" width="5" height="5" rx="1.2" />
                      <rect x="2" y="9" width="5" height="5" rx="1.2" />
                      <rect x="9" y="9" width="5" height="5" rx="1.2" />
                    </svg>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.84rem', fontWeight: 800, color: !selectedDid ? AZURE_DEEP : INK, letterSpacing: '-0.01em' }}>
                      All Numbers
                    </div>
                    <div style={{ fontSize: '0.65rem', color: INK_FAINT, marginTop: 1 }}>
                      Aggregate data for all {rcfEntries.length} number{rcfEntries.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                  {!selectedDid && (
                    <span style={{ marginLeft: 'auto', fontSize: '0.6rem', fontWeight: 700, color: AZURE_DEEP, background: 'rgba(47,125,246,0.1)', border: '1px solid rgba(47,125,246,0.28)', borderRadius: 20, padding: '2px 8px', letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>
                      Active
                    </span>
                  )}
                </button>

                {/* Individual DID options */}
                <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                  {rcfEntries.map((entry) => {
                    const isSelected = selectedDid === entry.did;
                    return (
                      <button
                        key={entry.did}
                        type="button"
                        onClick={() => { setSelectedDid(entry.did); setDidDropdownOpen(false); }}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 14px',
                          border: 'none',
                          borderBottom: '1px solid var(--rcf-line-soft)',
                          background: isSelected ? 'rgba(47,125,246,0.06)' : 'transparent',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          textAlign: 'left',
                          transition: 'background 0.14s',
                        }}
                        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = '#f2f7ff'; }}
                        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                      >
                        {/* Status dot */}
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: entry.enabled ? '#16a34a' : '#dc2626',
                            flexShrink: 0,
                            display: 'inline-block',
                          }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.84rem', fontWeight: 700, color: isSelected ? AZURE_DEEP : INK, fontFamily: MONO, letterSpacing: '0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {fmt(entry.did)}
                          </div>
                          {entry.name && (
                            <div style={{ fontSize: '0.65rem', color: isSelected ? AZURE : INK_DIM, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {entry.name}
                            </div>
                          )}
                        </div>
                        {isSelected && (
                          <svg viewBox="0 0 16 16" fill="none" stroke={AZURE_DEEP} strokeWidth={2.2} style={{ width: 13, height: 13, flexShrink: 0 }}>
                            <path d="M2 8l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Right: count badge + clear button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 700,
                color: INK_DIM,
                background: 'var(--rcf-tint)',
                border: '1px solid var(--rcf-line)',
                borderRadius: 20,
                padding: '3px 9px',
                whiteSpace: 'nowrap',
                letterSpacing: '0.04em',
              }}
            >
              {rcfEntries.length} number{rcfEntries.length !== 1 ? 's' : ''}
            </span>
            {selectedDid && (
              <button
                type="button"
                onClick={() => setSelectedDid(null)}
                title="Back to All Numbers"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  border: '1px solid rgba(47,125,246,0.3)',
                  background: 'rgba(47,125,246,0.07)',
                  color: AZURE_DEEP,
                  cursor: 'pointer',
                  padding: 0,
                  transition: 'background 0.15s, border-color 0.15s',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(47,125,246,0.14)';
                  e.currentTarget.style.borderColor = 'rgba(47,125,246,0.5)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(47,125,246,0.07)';
                  e.currentTarget.style.borderColor = 'rgba(47,125,246,0.3)';
                }}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 10, height: 10 }}>
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Quality stat strip — one slab, left-keyline figures ── */}
      <div className="rcf-panel fx-load fx-load-d1" style={{ padding: '20px 24px' }}>
        <div className="rcf-statline" style={{ marginTop: 0, gap: '12px 36px' }}>
          <div className="rcf-stat">
            <div className="rcf-stat-value" style={{ color: AZURE_DEEP }}>
              {stats.asr != null ? `${stats.asr.toFixed(1)}%` : '—'}
            </div>
            <div className="rcf-stat-label">ASR · answered</div>
          </div>
          <div className="rcf-stat" style={{ borderLeftColor: avgMosKeyline }}>
            <div className="rcf-stat-value" style={{ color: avgMosColor }}>
              {stats.avgMos != null ? stats.avgMos.toFixed(1) : '—'}
            </div>
            <div className="rcf-stat-label">MOS · voice quality</div>
          </div>
          <div className="rcf-stat rcf-stat-dim">
            <div className="rcf-stat-value">{stats.total.toLocaleString()}</div>
            <div className="rcf-stat-label">Calls · period</div>
          </div>
          <div className="rcf-stat rcf-stat-dim">
            <div className="rcf-stat-value">
              {stats.acd != null ? (stats.acd >= 60 ? `${Math.floor(stats.acd / 60)}m ${Math.round(stats.acd % 60)}s` : `${Math.round(stats.acd)}s`) : '—'}
            </div>
            <div className="rcf-stat-label">Avg duration</div>
          </div>
        </div>
      </div>

      {/* ── 7-day performance chart — scroll reveal ────────────── */}
      <Reveal>
        <WeeklyChart days={dailyDots} />
      </Reveal>

      {/* ── Recent calls table — scroll reveal ─────────────────── */}
      <Reveal delay={90}>
      <div className="rcf-panel">
        <div className="rcf-panel-head">
          <span className="rcf-panel-title">Recent Calls</span>
          {selectedDid && selectedLabel && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: '0.65rem',
                fontWeight: 700,
                color: AZURE_DEEP,
                background: 'rgba(47,125,246,0.08)',
                border: '1px solid rgba(47,125,246,0.24)',
                borderRadius: 20,
                padding: '2px 8px 2px 6px',
                whiteSpace: 'nowrap',
                letterSpacing: '0.02em',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: AZURE_DEEP,
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              {selectedLabel}
            </span>
          )}
          <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
            <svg viewBox="0 0 20 20" fill="currentColor" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: '#9aa9c0' }}>
              <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
            </svg>
            <input
              type="text"
              className="rcf-input"
              value={activitySearch}
              onChange={(e) => setActivitySearch(e.target.value)}
              placeholder="Filter by number, date, cause..."
              style={{ width: '100%', padding: '7px 12px 7px 30px', fontSize: '0.8rem' }}
            />
          </div>
          <span
            style={{
              fontSize: '0.68rem',
              fontWeight: 600,
              color: AZURE_DEEP,
              background: 'rgba(47,125,246,0.08)',
              border: '1px solid rgba(47,125,246,0.2)',
              borderRadius: 20,
              padding: '2px 9px',
              flexShrink: 0,
            }}
          >
            {calls.length}{(activitySearch.trim() || selectedDid) ? ` of ${allCalls.length}` : ''} shown
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 580 }}>
            <thead>
              <tr>
                {['Time', 'From', 'To (DID)', 'Carrier Trunk', 'Status', 'Quality'].map((h) => (
                  <th key={h} className="rcf-th" style={{ padding: '11px 14px' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.map((cdr) => {
                const status = callStatusInfo(cdr);
                const quality = mosLabel(cdr.mos);
                return (
                  <tr key={cdr.uuid} className="rcf-row">
                    {/* Time */}
                    <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: '0.78rem', color: INK_DIM, fontVariantNumeric: 'tabular-nums' }}>
                        {timeAgo(cdr.start_time)}
                      </span>
                    </td>

                    {/* From */}
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.82rem', color: INK_SOFT, fontFamily: MONO, fontWeight: 500 }}>
                        {fmt(cdr.caller_id)}
                      </span>
                    </td>

                    {/* To (DID) */}
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.82rem', color: AZURE_DEEP, fontFamily: MONO, fontWeight: 600 }}>
                        {fmt(cdr.destination)}
                      </span>
                    </td>

                    {/* Carrier Trunk */}
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.78rem', color: INK_DIM }}>
                        {carrierDisplayName(cdr.carrier_used)}
                      </span>
                    </td>

                    {/* Status badge */}
                    <td style={{ padding: '12px 14px' }}>
                      <span
                        style={{
                          fontSize: '0.68rem',
                          fontWeight: 700,
                          color: status.color,
                          background: status.bg,
                          border: status.border,
                          borderRadius: 20,
                          padding: '3px 9px',
                          whiteSpace: 'nowrap',
                          letterSpacing: '0.02em',
                        }}
                      >
                        {status.label}
                      </span>
                    </td>

                    {/* Quality dot */}
                    <td style={{ padding: '12px 14px' }}>
                      {cdr.mos != null ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: quality.dot,
                              flexShrink: 0,
                              display: 'inline-block',
                            }}
                          />
                          <span style={{ fontSize: '0.72rem', color: quality.color, fontWeight: 600 }}>
                            {quality.text}
                          </span>
                        </div>
                      ) : (
                        <span style={{ fontSize: '0.72rem', color: '#b6c2d4' }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      </Reveal>
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
}: {
  items: DidInventoryItem[];
  isLoading: boolean;
  isError: boolean;
  onRequest: (item: DidInventoryItem) => void;
  requestingDid: string | null;
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
                    <th className="rcf-th" aria-label="Actions" />
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
  onSwitchTab: (tab: DashboardTab) => void;
}

function DIDManagementTab({ customerId, onSwitchTab }: DIDManagementTabProps) {
  // ALL hooks unconditionally at top — React rules-of-hooks
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

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

  const myItems = myDids ?? [];
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
        />
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function RcfPage() {
  // ── All hooks unconditionally at top (React rules-of-hooks) ──────────────────
  const { user, isAdmin } = useAuth();

  // Tab state
  const [activeTab, setActiveTab] = useState<DashboardTab>('numbers');

  // Admin customer selector
  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);
  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);

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
    if (!isAdmin || adminSelectedCustomer === undefined) return null;
    return adminCustomersData?.items.find((c) => c.id === adminSelectedCustomer)?.name ?? null;
  }, [isAdmin, adminSelectedCustomer, adminCustomersData]);

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

  // Numbers query — always run (enabled unconditionally)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf', customerId, page, pageSize],
    queryFn: () => listRcf({ limit: pageSize, offset: (page - 1) * pageSize, customer_id: customerId }),
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

  function handleCustomerSelect(id: number | undefined) {
    setAdminSelectedCustomer(id);
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

  // Header title: prefer the admin-scoped customer name, then the logged-in
  // customer's name; fall back to the bare console title (admin "All Customers").
  const scopedCustomerName = adminSelectedCustomerName ?? user?.customer_name ?? null;
  const pageTitle = scopedCustomerName ?? 'Call Forwarding Console';

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="rcf-scope">
      <div className="rcf-shell">
        {/* Quiet console header — breadcrumb, title, inline metrics, closing rule */}
        <RcfPageHeader
          title={pageTitle}
          subtitle="Manage forwarding destinations and monitor call health across your numbers."
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
              value={adminSelectedCustomer ?? ''}
              onChange={(e) => handleCustomerSelect(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">All Customers</option>
              {scopeCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.account_type.toUpperCase()})
                </option>
              ))}
            </select>
            {adminSelectedCustomer !== undefined && (
              <button
                type="button"
                onClick={() => handleCustomerSelect(undefined)}
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

        {/* ── Tab navigation ──────────────────────────────────── */}
        <TabBar active={activeTab} onChange={setActiveTab} />

        {/* ── Numbers Tab ─────────────────────────────────────── */}
        {activeTab === 'numbers' && (
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
        {activeTab === 'activity' && (
          <CallActivityTab customerId={customerId} />
        )}

        {/* ── DID Management Tab ───────────────────────────────── */}
        {activeTab === 'dids' && (
          <DIDManagementTab customerId={customerId} onSwitchTab={setActiveTab} />
        )}
      </div>
    </div>
  );
}
