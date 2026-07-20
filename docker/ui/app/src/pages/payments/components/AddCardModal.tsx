/**
 * AddCardModal — a SIMULATED Stripe Payment-Element form. It looks and feels like
 * the real hosted element (brand chips, an inert "card" field, expiry) so the
 * demo reads as production, but it is honest: a prominent banner states no real
 * card number is ever entered, and the disabled card field only ever shows a
 * TEST last-4. On submit it mints a `pm_demo_…` token (client-side, never from a
 * PAN) and calls the add-card mutation — exactly the SAQ-A contract the real
 * iframe satisfies (§1.1). Swapping in the real Stripe element is a drop-in.
 *
 * React #310: all hooks unconditionally at the top.
 */

import { useState } from 'react';
import { Modal } from '../../../components/ui/Modal';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { DemoBadge } from '../../../components/payments/DemoBadge';
import { fieldLabel, primaryBtn, ghostBtn } from '../styles';
import { IconCard } from './icons';

/** Realistic test-card presets (Stripe's public test numbers — last4 only). */
const TEST_CARDS = [
  { brand: 'Visa', last4: '4242', color: '#1a4bdb' },
  { brand: 'Mastercard', last4: '4444', color: '#eb6c1c' },
  { brand: 'Amex', last4: '0005', color: '#1d8ecb' },
  { brand: 'Discover', last4: '1117', color: '#e6772e' },
] as const;

interface AddCardModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Submit the chosen brand. The backend's (simulated) Payment Element mints the
   * actual `pm_…` token + last4/expiry from the brand — the modal never sends
   * card digits (SAQ-A).
   */
  onSubmit: (input: { brand: string; make_default: boolean }) => void;
  submitting: boolean;
  /** Whether this would be the first (→ default) card. */
  firstCard: boolean;
}

export function AddCardModal({ open, onClose, onSubmit, submitting, firstCard }: AddCardModalProps) {
  // ── ALL hooks first (React #310) ────────────────────────────────────────────
  const [cardIdx, setCardIdx] = useState(0);
  const [makeDefault, setMakeDefault] = useState(true);

  const card = TEST_CARDS[cardIdx];
  const nextYear = new Date().getFullYear() + 3;

  const submit = () => {
    onSubmit({
      brand: card.brand,
      make_default: firstCard || makeDefault,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a payment method"
      maxWidth="max-w-md"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" onClick={onClose} style={ghostBtn()}>Cancel</button>
          <button type="button" onClick={submit} disabled={submitting} style={primaryBtn(GLASS.accent, submitting)}>
            {submitting ? 'Saving…' : 'Save card'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Honesty banner */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 12,
            background: hexToRgba(GLASS.warning, 0.08),
            border: `1px solid ${hexToRgba(GLASS.warning, 0.28)}`,
          }}
        >
          <DemoBadge size="xs" label="Demo" />
          <span style={{ fontSize: '0.76rem', color: GLASS.textMuted, lineHeight: 1.5 }}>
            No real card number is entered. In production this is a Stripe-hosted element — we only ever receive a <code style={{ fontFamily: 'ui-monospace, monospace', color: GLASS.accentSecondary }}>pm_…</code> token. Pick a test card to simulate.
          </span>
        </div>

        {/* Brand picker */}
        <div>
          <label style={fieldLabel}>Test card</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {TEST_CARDS.map((c, i) => (
              <button
                key={c.brand}
                type="button"
                onClick={() => setCardIdx(i)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '8px 12px',
                  borderRadius: 10,
                  border: `1px solid ${cardIdx === i ? hexToRgba(c.color, 0.6) : 'rgba(255,255,255,0.12)'}`,
                  background: cardIdx === i ? hexToRgba(c.color, 0.14) : 'rgba(255,255,255,0.03)',
                  color: cardIdx === i ? '#fff' : GLASS.textMuted,
                  fontSize: '0.76rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'all 0.15s',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color }} />
                {c.brand}
              </button>
            ))}
          </div>
        </div>

        {/* Simulated (inert) Payment Element */}
        <div>
          <label style={fieldLabel}>Card information</label>
          <div
            style={{
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(8,10,15,0.55)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 14px',
                borderBottom: '1px solid rgba(255,255,255,0.07)',
              }}
            >
              <span style={{ color: GLASS.textMuted }}><IconCard /></span>
              <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: '0.9rem', color: GLASS.text, letterSpacing: '0.06em' }}>
                •••• •••• •••• {card.last4}
              </span>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: card.color }} />
            </div>
            <div style={{ display: 'flex' }}>
              <div style={{ flex: 1, padding: '12px 14px', borderRight: '1px solid rgba(255,255,255,0.07)', fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem', color: GLASS.textMuted }}>
                12 / {String(nextYear).slice(-2)}
              </div>
              <div style={{ flex: 1, padding: '12px 14px', fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem', color: GLASS.textMuted }}>
                CVC •••
              </div>
            </div>
          </div>
          <p style={{ fontSize: '0.68rem', color: GLASS.textFaint, margin: '7px 2px 0' }}>
            This field is inert — it accepts no input. Production mounts the real Stripe iframe here.
          </p>
        </div>

        {/* Default toggle */}
        {!firstCard && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: GLASS.accent, cursor: 'pointer' }}
            />
            <span style={{ fontSize: '0.82rem', color: GLASS.text }}>Set as default payment method</span>
          </label>
        )}
      </div>
    </Modal>
  );
}
