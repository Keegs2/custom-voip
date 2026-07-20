/**
 * ComplianceGateCard — renders ONE of the three compliance gates (§1) as a
 * GREEN/RED card: PCI SAQ-A, closed-loop prepaid ≤$2k/day, non-custodial crypto.
 * Shows the gate name, the assertion (`detail`), a green/red status chip, and the
 * live evidence the backend returns (an object of key→value facts). This is the
 * "we built this compliant" narrative for execs — legible and confidence-inspiring.
 *
 * Backend shape: { id, name, status: "green" | "red", detail, evidence }.
 */

import { GlassCard, GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { ShieldCheck, ShieldX, Check } from 'lucide-react';
import type { ComplianceGate, ComplianceGateStatus } from '../../../../types/payments';

function statusMeta(status: ComplianceGateStatus): { color: string; label: string; icon: React.ReactNode } {
  if (status === 'green') {
    return { color: GLASS.success, label: 'Verified', icon: <ShieldCheck size={22} strokeWidth={1.8} /> };
  }
  return { color: GLASS.danger, label: 'Violation', icon: <ShieldX size={22} strokeWidth={1.8} /> };
}

/** Turn the backend evidence object into readable "key: value" bullet strings. */
function evidenceLines(evidence?: Record<string, unknown> | null): string[] {
  if (!evidence || typeof evidence !== 'object') return [];
  return Object.entries(evidence).map(([k, v]) => {
    const label = k.replace(/_/g, ' ');
    const value = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
    return `${label}: ${value}`;
  });
}

export function ComplianceGateCard({ gate, index }: { gate: ComplianceGate; index: number }) {
  const meta = statusMeta(gate.status);
  const lines = evidenceLines(gate.evidence);

  return (
    <GlassCard index={index} accent={meta.color} radius={20}>
      <div style={{ padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <span
            style={{
              width: 48,
              height: 48,
              borderRadius: 13,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: hexToRgba(meta.color, 0.13),
              border: `1px solid ${hexToRgba(meta.color, 0.32)}`,
              color: meta.color,
              flexShrink: 0,
            }}
          >
            {meta.icon}
          </span>
          <GlassChip label={meta.label} color={meta.color} dot />
        </div>

        <h3 style={{ fontSize: '1.02rem', fontWeight: 800, color: GLASS.text, margin: '16px 0 0', letterSpacing: '-0.01em', lineHeight: 1.3 }}>
          {gate.name}
        </h3>
        <p style={{ fontSize: '0.85rem', color: GLASS.textMuted, margin: '10px 0 0', lineHeight: 1.5 }}>{gate.detail}</p>

        {/* Evidence */}
        {lines.length > 0 && (
          <ul style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {lines.map((e, i) => (
              <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.78rem', color: GLASS.text, lineHeight: 1.45, fontFamily: 'ui-monospace, monospace' }}>
                <span style={{ color: meta.color, marginTop: 1, flexShrink: 0 }}>
                  <Check size={14} strokeWidth={2.6} />
                </span>
                {e}
              </li>
            ))}
          </ul>
        )}
      </div>
    </GlassCard>
  );
}
