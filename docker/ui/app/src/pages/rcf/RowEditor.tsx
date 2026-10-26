/**
 * RowEditor — the expanded per-number configuration panel shared by the admin
 * console (RcfPage) and the customer dashboard (CustomerDashboard). Extracted
 * verbatim from RcfPage; behaviour (draft/baseline sync, instant toggles,
 * customer vs admin field gating) is unchanged.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateRcfEntry } from '../../api/rcf';
import { apiRequest } from '../../api/client';
import type { RcfEntry, RcfUpdate } from '../../types/rcf';
import { useToast } from '../../components/ui/Toast';
import { fmt } from '../../utils/format';
import { normalizeNumberInput } from '../../utils/phone';
import { AZURE_DEEP, INK, INK_DIM, INK_FAINT, MONO } from './theme';

// ─── API helpers ──────────────────────────────────────────────────────────────

async function updateRcfEnabled(id: number, enabled: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { enabled });
}

async function updateRcfPassCallerId(id: number, pass_caller_id: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { pass_caller_id });
}

// ─── LightSwitch — daylight on/off control ────────────────────────────────────

export function LightSwitch({
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

// ─── RowEditor — the expanded configuration panel ─────────────────────────────

export interface RowEditorProps {
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

export function RowEditor({ entry, isAdmin, canEdit, onClose }: RowEditorProps) {
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
    // Same bounds as the API (routers/rcf.py validate_ring_timeout: 5–120 s).
    if (isNaN(rt) || rt < 5 || rt > 120) { toastErr('Ring timeout must be between 5 and 120 seconds'); return; }
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
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        id={`ring-${entry.id}`}
                        type="number"
                        min={5}
                        max={120}
                        className="rcf-input rcf-input-mono"
                        style={{ width: 88, textAlign: 'center' }}
                        value={draft.ring_timeout}
                        disabled={saving}
                        onChange={(e) => set('ring_timeout')(e.target.value)}
                        onKeyDown={onEnterSave}
                      />
                      <span style={{ fontSize: '0.76rem', fontWeight: 600, color: INK_DIM }}>seconds</span>
                    </div>
                    <div className="rcf-help">5–120 seconds</div>
                  </>
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
