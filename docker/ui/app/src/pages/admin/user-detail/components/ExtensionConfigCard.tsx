/**
 * ExtensionConfigCard — the read-only grid of an extension's settings
 * (number, DID, voicemail, DND, busy/no-answer forwards, timeout).
 */

import type { ReactNode } from 'react';
import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { ExtensionInfo } from '../types';
import { MONO, fieldTile, fieldTileLabel } from '../styles';
import { SectionCard } from './SectionCard';
import { IconGear } from './icons';

interface ExtensionConfigCardProps {
  extension: ExtensionInfo;
}

const mono = (v: string, color: string = GLASS.text): ReactNode => (
  <span style={{ fontFamily: MONO, color }}>{v}</span>
);

const none = (label: string): ReactNode => (
  <span style={{ color: GLASS.textFaint, fontStyle: 'italic' }}>{label}</span>
);

export function ExtensionConfigCard({ extension }: ExtensionConfigCardProps) {
  const fields: Array<{ label: string; value: ReactNode }> = [
    { label: 'Extension', value: <span style={{ fontFamily: MONO, color: '#60a5fa', fontSize: '0.95rem', fontWeight: 700 }}>{extension.number}</span> },
    { label: 'Assigned DID', value: extension.did ? mono(fmt(extension.did)) : none('None') },
    { label: 'Voicemail', value: extension.voicemail_enabled ? <span style={{ color: GLASS.success, fontWeight: 600 }}>Enabled</span> : <span style={{ color: GLASS.textMuted }}>Disabled</span> },
    { label: 'Do Not Disturb', value: extension.dnd ? <span style={{ color: GLASS.danger, fontWeight: 600 }}>On</span> : <span style={{ color: GLASS.textMuted }}>Off</span> },
    { label: 'Forward on Busy', value: extension.forward_on_busy ? mono(fmt(extension.forward_on_busy)) : none('Not configured') },
    { label: 'Forward on No Answer', value: extension.forward_on_no_answer ? mono(fmt(extension.forward_on_no_answer)) : none('Not configured') },
    { label: 'Forward Timeout', value: extension.forward_timeout_sec != null ? <span style={{ color: GLASS.textMuted }}>{extension.forward_timeout_sec}s</span> : none('—') },
  ];

  return (
    <SectionCard accent="#0ea5e9" title="Extension Configuration" icon={<IconGear />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {fields.map(({ label, value }) => (
          <div key={label} style={fieldTile}>
            <div style={fieldTileLabel}>{label}</div>
            <div style={{ fontSize: '0.85rem' }}>{value}</div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
