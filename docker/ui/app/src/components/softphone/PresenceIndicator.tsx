import type { PresenceStatus } from '../../types/softphone';

interface PresenceIndicatorProps {
  status: PresenceStatus;
  size?: number;
  /** Show tooltip on hover */
  showLabel?: boolean;
}

const STATUS_COLORS: Record<PresenceStatus, string> = {
  available: '#22c55e',
  busy:      '#ef4444',
  away:      '#f59e0b',
  dnd:       '#ef4444',
  offline:   '#64748b',
};

const STATUS_LABELS: Record<PresenceStatus, string> = {
  available: 'Available',
  busy:      'Busy',
  away:      'Away',
  dnd:       'Do Not Disturb',
  offline:   'Offline',
};

export function PresenceIndicator({ status, size = 8, showLabel = false }: PresenceIndicatorProps) {
  const color = STATUS_COLORS[status];
  const label = STATUS_LABELS[status];

  return (
    <span
      title={showLabel ? label : undefined}
      aria-label={`Presence: ${label}`}
      className={status === 'available' ? 'sp-presence-available' : undefined}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        // DND gets a pulsing ring to distinguish from busy
        boxShadow: status === 'dnd'
          ? `0 0 0 2px rgba(239,68,68,0.25), 0 0 6px ${color}`
          : `0 0 4px ${color}80`,
      }}
    />
  );
}
