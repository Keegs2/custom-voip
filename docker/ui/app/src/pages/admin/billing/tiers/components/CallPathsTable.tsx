/**
 * CallPathsTable — call-path packages on a frosted-glass table pane.
 * Presentation only.
 */

import { GLASS } from '../../../../../components/glass/glass';
import type { CallPathEntry } from '../../../../../api/trunks';
import { GlassTableWrap } from '../../components/GlassTableWrap';
import { th, td } from '../../styles';

export function CallPathsTable({ packages }: { packages: CallPathEntry[] }) {
  return (
    <GlassTableWrap>
      <thead>
        <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
          <th style={th}>Package</th>
          <th style={th}>Call Paths</th>
          <th style={th}>Monthly Fee</th>
        </tr>
      </thead>
      <tbody>
        {packages.map((p) => (
          <tr key={p.id}>
            <td style={td}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 600, color: GLASS.text }}>{p.name || '--'}</span>
                {p.description && <span style={{ color: GLASS.textMuted, fontSize: '0.74rem' }}>{p.description}</span>}
              </div>
            </td>
            <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{p.call_paths ?? p.paths ?? '--'}</td>
            <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>
              {p.monthly_fee != null ? `$${Number(p.monthly_fee).toFixed(2)}/mo` : '--'}
            </td>
          </tr>
        ))}
      </tbody>
    </GlassTableWrap>
  );
}
