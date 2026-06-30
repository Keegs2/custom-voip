/**
 * DevicesCard — registered SIP endpoints for the user, or an empty hint when
 * none are connected.
 */

import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { fmtRelativeTime } from '../helpers';
import type { Device } from '../types';
import { SectionCard } from './SectionCard';
import { IconDevices } from './icons';

interface DevicesCardProps {
  devices: Device[];
}

export function DevicesCard({ devices }: DevicesCardProps) {
  return (
    <SectionCard accent={GLASS.success} title="Registered Devices" icon={<IconDevices size={16} />}>
      {devices.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 0', color: GLASS.textMuted, fontSize: '0.82rem' }}>
          <span style={{ fontSize: '1.2rem', opacity: 0.3 }}>○</span>
          No SIP endpoints currently registered. The user may not be logged into a softphone or device.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {devices.map((device) => (
            <div
              key={device.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '12px 16px',
                borderRadius: 12,
                background: hexToRgba(GLASS.success, 0.05),
                border: `1px solid ${hexToRgba(GLASS.success, 0.16)}`,
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: GLASS.success, flexShrink: 0, boxShadow: `0 0 6px ${hexToRgba(GLASS.success, 0.6)}` }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: GLASS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {device.user_agent}
                </div>
                <div style={{ fontSize: '0.7rem', color: GLASS.textMuted, marginTop: 2 }}>
                  {device.ip_address} · Registered {fmtRelativeTime(device.registered_at)} · Expires {fmtRelativeTime(device.expires_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
