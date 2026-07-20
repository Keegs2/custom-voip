/**
 * AddFundsModal — the "Add funds" flow with two rails: a card top-up (Rail A/C)
 * and a "Pay with USDC" stablecoin option (Rail C — large B2B prepay, §4). Quick
 * preset chips + a custom amount; the rail switch swaps the funding source and
 * the settle copy. Submits a `POST /topup` with `rail` set accordingly.
 *
 * React #310: all hooks unconditionally at the top.
 */

import { useState } from 'react';
import { Modal } from '../../../components/ui/Modal';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { DemoBadge } from '../../../components/payments/DemoBadge';
import { fmtDollars } from '../../../components/payments/format';
import { fieldLabel, primaryBtn, ghostBtn, MONO } from '../styles';
import { IconCard, IconCoins } from './icons';
import { TOPUP_PRESETS, type AddFundsRail } from '../types';
import type { PaymentMethod, TopupRequest } from '../../../types/payments';

interface AddFundsModalProps {
  open: boolean;
  onClose: () => void;
  methods: PaymentMethod[];
  onSubmit: (body: TopupRequest) => void;
  submitting: boolean;
}

export function AddFundsModal({ open, onClose, methods, onSubmit, submitting }: AddFundsModalProps) {
  // ── ALL hooks first (React #310) ────────────────────────────────────────────
  const [rail, setRail] = useState<AddFundsRail>('card');
  const [amount, setAmount] = useState<number>(100);
  const [pmId, setPmId] = useState<string>('');

  const defaultCard = methods.find((m) => m.is_default) ?? methods[0];
  const fundingId = pmId || (defaultCard ? String(defaultCard.id) : '');
  const canSubmit = amount > 0 && (rail === 'stablecoin' || Boolean(fundingId));

  const submit = () => {
    // Backend body: { amount: <dollars>, rail: 'card' | 'usdc' }. The card rail
    // charges the account's default card server-side; the stablecoin option
    // settles on the USDC rail.
    const body: TopupRequest = { amount, rail: rail === 'card' ? 'card' : 'usdc' };
    onSubmit(body);
  };

  const railColor = rail === 'card' ? GLASS.accent : GLASS.accentSecondary;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add funds"
      maxWidth="max-w-md"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" onClick={onClose} style={ghostBtn()}>Cancel</button>
          <button type="button" onClick={submit} disabled={submitting || !canSubmit} style={primaryBtn(railColor, submitting || !canSubmit)}>
            {submitting ? 'Processing…' : `Add ${fmtDollars(amount)}`}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Rail switch */}
        <div style={{ display: 'flex', gap: 10 }}>
          {(['card', 'stablecoin'] as const).map((r) => {
            const active = rail === r;
            const c = r === 'card' ? GLASS.accent : GLASS.accentSecondary;
            return (
              <button
                key={r}
                type="button"
                onClick={() => setRail(r)}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '12px 14px',
                  borderRadius: 12,
                  border: `1px solid ${active ? hexToRgba(c, 0.5) : 'rgba(255,255,255,0.12)'}`,
                  background: active ? hexToRgba(c, 0.12) : 'rgba(255,255,255,0.03)',
                  color: active ? '#fff' : GLASS.textMuted,
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'all 0.15s',
                }}
              >
                <span style={{ color: active ? c : GLASS.textMuted }}>{r === 'card' ? <IconCard /> : <IconCoins />}</span>
                {r === 'card' ? 'Card' : 'Pay with USDC'}
              </button>
            );
          })}
        </div>

        {/* Amount presets */}
        <div>
          <label style={fieldLabel}>Amount</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {TOPUP_PRESETS.map((p) => {
              const active = amount === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(p)}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 10,
                    border: `1px solid ${active ? hexToRgba(railColor, 0.5) : 'rgba(255,255,255,0.12)'}`,
                    background: active ? hexToRgba(railColor, 0.14) : 'rgba(255,255,255,0.03)',
                    color: active ? '#fff' : GLASS.text,
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    fontFamily: MONO,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {fmtDollars(p, 0)}
                </button>
              );
            })}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '10px 13px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(8,10,15,0.55)',
            }}
          >
            <span style={{ color: GLASS.textMuted, fontFamily: MONO, fontSize: '1rem' }}>$</span>
            <input
              type="number"
              min={1}
              step={1}
              value={amount > 0 ? String(amount) : ''}
              onChange={(e) => {
                const next = parseFloat(e.target.value);
                setAmount(Number.isFinite(next) ? next : 0);
              }}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: GLASS.text,
                fontSize: '1rem',
                fontFamily: MONO,
                fontWeight: 700,
              }}
            />
          </div>
        </div>

        {/* Funding source */}
        {rail === 'card' ? (
          <div>
            <label style={fieldLabel}>Charge to</label>
            <select
              value={fundingId}
              disabled={methods.length === 0}
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
              }}
            >
              {methods.length === 0 && <option value="">Add a card first</option>}
              {methods.map((m) => (
                <option key={String(m.id)} value={String(m.id)}>
                  {m.brand} •••• {m.last4}{m.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 12,
              background: hexToRgba(GLASS.accentSecondary, 0.07),
              border: `1px solid ${hexToRgba(GLASS.accentSecondary, 0.22)}`,
              fontSize: '0.8rem',
              color: GLASS.textMuted,
              lineHeight: 1.55,
            }}
          >
            Settles as USDC via Stripe's stablecoin acceptance → USD credited to the ledger. Stripe custodies the crypto, so the platform stays fully non-custodial (§1.3). 1.5% fee · no chargebacks.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <DemoBadge size="xs" />
        </div>
      </div>
    </Modal>
  );
}
