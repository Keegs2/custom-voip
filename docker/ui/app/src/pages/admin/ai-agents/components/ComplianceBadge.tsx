/**
 * ComplianceBadge — the headline in-boundary signal. A small glass pill that
 * honestly reports whether ALL of an agent's providers are self-hosted (data
 * stays in the VPC) or a cloud provider was selected (data leaves the boundary).
 *
 * `status`:
 *   - 'loading'  → resolving the authoritative runtime-config
 *   - 'in-vpc'   → data_stays_in_vpc === true (green shield)
 *   - 'cloud'    → data_stays_in_vpc === false (amber cloud)
 *   - 'unknown'  → runtime-config could not be resolved
 */

import { ShieldCheck, Cloud, HelpCircle } from 'lucide-react';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { spinnerRing } from '../styles';

export type ComplianceStatus = 'loading' | 'in-vpc' | 'cloud' | 'unknown';

interface ComplianceBadgeProps {
  status: ComplianceStatus;
  /** Compact form for dense table cells. */
  size?: 'sm' | 'md';
}

export function ComplianceBadge({ status, size = 'md' }: ComplianceBadgeProps) {
  if (status === 'loading') {
    return (
      <span style={pill(GLASS.textMuted, size)}>
        <span style={spinnerRing(GLASS.textMuted, 10)} />
        Checking
      </span>
    );
  }
  if (status === 'unknown') {
    return (
      <span style={pill(GLASS.textFaint, size)}>
        <HelpCircle size={size === 'sm' ? 11 : 13} />
        Unknown
      </span>
    );
  }
  if (status === 'in-vpc') {
    return (
      <span style={pill(GLASS.success, size)} title="Every provider is self-hosted — no data leaves your VPC">
        <ShieldCheck size={size === 'sm' ? 11 : 13} />
        In-boundary
      </span>
    );
  }
  return (
    <span style={pill(GLASS.warning, size)} title="A cloud provider is selected — call data leaves your VPC">
      <Cloud size={size === 'sm' ? 11 : 13} />
      Cloud
    </span>
  );
}

function pill(color: string, size: 'sm' | 'md') {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: size === 'sm' ? '0.6rem' : '0.66rem',
    fontWeight: 800,
    color,
    background: hexToRgba(color, 0.1),
    border: `1px solid ${hexToRgba(color, 0.32)}`,
    borderRadius: 999,
    padding: size === 'sm' ? '3px 9px' : '4px 11px',
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    whiteSpace: 'nowrap' as const,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
  };
}
