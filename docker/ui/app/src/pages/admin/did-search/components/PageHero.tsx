/**
 * PageHero — the DID feature's title block: accent badge, gradient title,
 * role-aware subtitle, and a "Bandwidth-powered" location chip. Purely
 * presentational.
 */

import { Phone, MapPin } from 'lucide-react';
import { GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { heroIcon, heroBadge, heroTitle, heroSubtitle } from '../styles';

export function PageHero({ isAdmin }: { isAdmin: boolean }) {
  return (
    <header className="glass-rise">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={heroIcon()}>
          <Phone size={21} strokeWidth={1.75} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={heroBadge()}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: GLASS.accent, boxShadow: `0 0 8px ${GLASS.accent}` }} />
            <span style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GLASS.accent }}>
              Number Management
            </span>
          </div>
          <h1 style={heroTitle()}>{isAdmin ? 'DID Inventory' : 'Your Numbers'}</h1>
          <p style={heroSubtitle}>
            {isAdmin
              ? 'Full DID lifecycle management — inventory, assignments, and Bandwidth sync.'
              : 'Browse available numbers and manage your assigned DIDs.'}
          </p>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <GlassChip label="US DID Inventory · Bandwidth-powered" color={GLASS.cyan} icon={<MapPin size={11} />} />
      </div>
    </header>
  );
}
