/**
 * AutoRechargeCard — the customer's threshold-based auto top-up settings (the
 * Twilio model: WE build the trigger, §4 Rail A). A master toggle plus threshold
 * / recharge-amount inputs and the funding card. Editing is local until "Save",
 * which fires the PUT mutation. Shows the live status + a plain-language preview
 * ("When balance drops below $X, add $Y from ••••1234").
 *
 * The editable form (`AutoRechargeForm`) initializes its local state from props
 * via useState INITIALIZERS (not an effect) to satisfy react-hooks/set-state-in-
 * effect; the wrapper remounts it with a `key` derived from the server settings,
 * so a fresh server payload cleanly re-seeds the form without cascading renders.
 *
 * React #310: all hooks unconditionally at the top of each component.
 */

import { useState } from 'react';
import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { fmtDollars } from '../../../components/payments/format';
import {
  sectionEyebrow,
  sectionTitle,
  sectionDesc,
  fieldLabel,
  toggleTrack,
  toggleKnob,
  primaryBtn,
  MONO,
} from '../styles';
import { IconRecharge } from './icons';
import { rechargeChipShort } from './autoRechargeStatus';
import type { AutoRechargeSettings, AutoRechargeUpdate, PaymentMethod } from '../../../types/payments';

/** Sensible dollar defaults when the backend hasn't set a threshold/amount yet. */
const DEFAULT_THRESHOLD = 50;
const DEFAULT_RECHARGE = 100;
const DEFAULT_DAILY_CAP = 2000;

interface AutoRechargeCardProps {
  settings?: AutoRechargeSettings;
  methods: PaymentMethod[];
  onSave: (update: AutoRechargeUpdate) => void;
  saving: boolean;
}

/** Dollar input bound to a dollar value. */
function DollarField({
  label,
  dollars,
  onChange,
  disabled,
}: {
  label: string;
  dollars: number;
  onChange: (dollars: number) => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ flex: '1 1 150px', minWidth: 130 }}>
      <label style={fieldLabel}>{label}</label>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '9px 12px',
          borderRadius: 10,
          border: `1px solid ${focused ? hexToRgba(GLASS.accent, 0.5) : 'rgba(255,255,255,0.12)'}`,
          background: 'rgba(8,10,15,0.55)',
          boxShadow: focused ? `0 0 0 3px ${hexToRgba(GLASS.accent, 0.12)}` : 'none',
          opacity: disabled ? 0.5 : 1,
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}
      >
        <span style={{ color: GLASS.textMuted, fontFamily: MONO, fontSize: '0.95rem' }}>$</span>
        <input
          type="number"
          min={0}
          step={1}
          disabled={disabled}
          value={Number.isFinite(dollars) ? String(dollars) : ''}
          onChange={(e) => {
            const next = parseFloat(e.target.value);
            onChange(Number.isFinite(next) ? next : 0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: GLASS.text,
            fontSize: '0.95rem',
            fontFamily: MONO,
            fontWeight: 700,
          }}
        />
      </div>
    </div>
  );
}

/**
 * The editable form. All local state is SEEDED from props via useState
 * initializers — the parent remounts this (via `key`) when the server settings
 * change, so there is no state-syncing effect.
 */
function AutoRechargeForm({ settings, methods, onSave, saving }: Required<Pick<AutoRechargeCardProps, 'methods' | 'onSave' | 'saving'>> & { settings: AutoRechargeSettings }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [threshold, setThreshold] = useState(settings.threshold ?? DEFAULT_THRESHOLD);
  const [amount, setAmount] = useState(settings.recharge_amount ?? DEFAULT_RECHARGE);
  const [pmId, setPmId] = useState<string>(settings.payment_method_id != null ? String(settings.payment_method_id) : '');

  const fundingCard = methods.find((m) => String(m.id) === pmId) ?? methods.find((m) => m.is_default);
  const cap = settings.daily_cap ?? DEFAULT_DAILY_CAP;

  const save = () => {
    const pmNum = pmId ? Number(pmId) : null;
    onSave({
      enabled,
      threshold,
      recharge_amount: amount,
      payment_method_id: Number.isFinite(pmNum as number) ? pmNum : null,
    });
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={sectionEyebrow()}>Never miss a call · Rail A</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: GLASS.accent }}><IconRecharge /></span>
            <h2 style={sectionTitle}>Auto-recharge</h2>
            <GlassChip label={rechargeChipShort(settings).label} color={rechargeChipShort(settings).color} dot />
          </div>
          <p style={sectionDesc}>
            When your balance falls below the threshold, we charge your card off-session to top it back up — off the call path, so a recharge never blocks a call.
          </p>
        </div>

        {/* Master toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle auto-recharge"
          onClick={() => setEnabled((v) => !v)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          <span style={toggleTrack(enabled)}>
            <span style={toggleKnob(enabled)} />
          </span>
        </button>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DollarField label="When balance drops below" dollars={threshold} onChange={setThreshold} disabled={!enabled} />
        <DollarField label="Add this amount" dollars={amount} onChange={setAmount} disabled={!enabled} />
        <div style={{ flex: '1 1 180px', minWidth: 150 }}>
          <label style={fieldLabel}>Funding card</label>
          <select
            value={pmId}
            disabled={!enabled || methods.length === 0}
            onChange={(e) => setPmId(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(8,10,15,0.55)',
              color: GLASS.text,
              fontSize: '0.85rem',
              fontFamily: 'inherit',
              outline: 'none',
              cursor: 'pointer',
              opacity: !enabled ? 0.5 : 1,
            }}
          >
            {methods.length === 0 && <option value="">No cards on file</option>}
            {methods.map((m) => (
              <option key={String(m.id)} value={String(m.id)}>
                {m.brand} •••• {m.last4}
                {m.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Plain-language preview + compliance cap */}
      <div
        style={{
          marginTop: 18,
          padding: '14px 16px',
          borderRadius: 12,
          background: enabled ? hexToRgba(GLASS.accent, 0.06) : 'rgba(255,255,255,0.03)',
          border: `1px solid ${enabled ? hexToRgba(GLASS.accent, 0.2) : 'rgba(255,255,255,0.08)'}`,
        }}
      >
        <div style={{ fontSize: '0.84rem', color: GLASS.text, lineHeight: 1.5 }}>
          {enabled ? (
            <>
              When balance drops below <strong style={{ fontFamily: MONO, color: GLASS.accent }}>{fmtDollars(threshold)}</strong>, add{' '}
              <strong style={{ fontFamily: MONO, color: GLASS.accent }}>{fmtDollars(amount)}</strong>
              {fundingCard ? (
                <> from <strong>{fundingCard.brand} •••• {fundingCard.last4}</strong>.</>
              ) : (
                <> once a card is on file.</>
              )}
            </>
          ) : (
            <>Auto-recharge is off. Your balance will not top up automatically.</>
          )}
        </div>
        <div style={{ fontSize: '0.7rem', color: GLASS.textFaint, marginTop: 6 }}>
          Closed-loop cap: max {fmtDollars(cap, 0)} auto-recharged per day (keeps us inside the FinCEN prepaid exclusion).
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" onClick={save} disabled={saving} style={primaryBtn(GLASS.accent, saving)}>
          {saving ? 'Saving…' : 'Save auto-recharge'}
        </button>
      </div>
    </>
  );
}

/** Key derived from the server settings — remounts the form on a fresh payload. */
function settingsKey(s?: AutoRechargeSettings): string {
  if (!s) return 'loading';
  return `${s.enabled}:${s.threshold ?? ''}:${s.recharge_amount ?? ''}:${s.payment_method_id ?? ''}:${s.disabled_reason ?? ''}:${s.consecutive_failures}`;
}

export function AutoRechargeCard({ settings, methods, onSave, saving }: AutoRechargeCardProps) {
  return (
    <GlassPanel padding="24px 26px" radius={20}>
      {settings ? (
        <AutoRechargeForm key={settingsKey(settings)} settings={settings} methods={methods} onSave={onSave} saving={saving} />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 2px', color: GLASS.textMuted, fontSize: '0.85rem' }}>
          <span
            style={{
              width: 15,
              height: 15,
              borderRadius: '50%',
              border: `2px solid ${hexToRgba(GLASS.accent, 0.25)}`,
              borderTopColor: GLASS.accent,
              animation: 'glass-spin 0.7s linear infinite',
              display: 'inline-block',
            }}
          />
          Loading auto-recharge…
        </div>
      )}
    </GlassPanel>
  );
}
