/**
 * PaymentMethods — the saved cards-on-file list + "Add card" entry point. Cards
 * store ONLY provider tokens (pm_…) and cosmetic brand/last4 — never a PAN/CVV
 * (SAQ-A gate, §1.1). The add flow opens a SIMULATED Payment-Element form
 * (AddCardModal) that mints a demo token; a real Stripe iframe drops in behind
 * the same contract with zero UI churn.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { DemoBadge } from '../../../components/payments/DemoBadge';
import { sectionEyebrow, sectionTitle, sectionDesc, methodCard, cardBrandGlyph, ghostBtn } from '../styles';
import { IconCard, IconPlus, IconTrash } from './icons';
import type { PaymentMethod } from '../../../types/payments';

interface PaymentMethodsProps {
  methods: PaymentMethod[];
  onAdd: () => void;
  onDelete: (id: number | string) => void;
  deletingId?: number | string | null;
}

export function PaymentMethods({ methods, onAdd, onDelete, deletingId }: PaymentMethodsProps) {
  return (
    <GlassPanel padding="24px 26px" radius={20}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={sectionEyebrow()}>Cards on file · Stripe</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={sectionTitle}>Payment methods</h2>
            <DemoBadge size="xs" label="Demo · tokens only" />
          </div>
          <p style={sectionDesc}>
            Card details are collected only inside a Stripe-hosted element. We store nothing but the <code style={{ fontFamily: 'ui-monospace, monospace', color: GLASS.accentSecondary }}>pm_…</code> token — never a card number.
          </p>
        </div>
        <button type="button" onClick={onAdd} style={ghostBtn(GLASS.accent, true)}>
          <IconPlus />
          Add card
        </button>
      </div>

      {methods.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
            padding: '28px 20px',
            textAlign: 'center',
            color: GLASS.textMuted,
          }}
        >
          <span style={{ color: GLASS.accent }}><IconCard /></span>
          <div style={{ fontSize: '0.85rem' }}>No cards yet. Add a demo card to enable card top-ups and auto-recharge.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {methods.map((m) => (
            <div key={String(m.id)} style={methodCard(m.is_default)}>
              <span style={cardBrandGlyph}>{(m.brand || 'CARD').toUpperCase().slice(0, 6)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: GLASS.text, fontFamily: 'ui-monospace, monospace' }}>
                  •••• •••• •••• {m.last4}
                </div>
                <div style={{ fontSize: '0.72rem', color: GLASS.textMuted, marginTop: 2 }}>
                  {m.brand} · exp {String(m.exp_month).padStart(2, '0')}/{String(m.exp_year).slice(-2)}
                  {m.is_default && (
                    <span style={{ marginLeft: 8, color: GLASS.accent, fontWeight: 700, fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Default
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onDelete(m.id)}
                disabled={deletingId === m.id}
                aria-label="Remove card"
                title="Remove card"
                style={{
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.10)',
                  color: GLASS.textMuted,
                  cursor: deletingId === m.id ? 'not-allowed' : 'pointer',
                  opacity: deletingId === m.id ? 0.5 : 1,
                  transition: 'color 0.15s, border-color 0.15s',
                }}
              >
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
      )}
    </GlassPanel>
  );
}
