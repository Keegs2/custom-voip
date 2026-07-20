/**
 * IpSection — authorized PBX IP management for one trunk, inside the expanded
 * detail. Data + mutations live in `useIpManager`.
 */

import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS } from '../../../../components/glass/glass';
import { useIpManager } from '../hooks';
import {
  sectionLabel,
  spinnerRing,
  loadingHint,
  itemRow,
  itemValue,
  removeBtn,
  emptyHint,
} from '../styles';

export function IpSection({ trunkId }: { trunkId: number }) {
  const { ips, isLoading, newIp, newIpDesc, isAdding, isDeleting, setNewIp, setNewIpDesc, add, remove } =
    useIpManager(trunkId);

  return (
    <div>
      <div style={sectionLabel()}>Authorized PBX IPs</div>

      {isLoading && (
        <div style={loadingHint}>
          <span style={spinnerRing()} /> Loading IPs…
        </div>
      )}

      {ips && ips.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {ips.map((ip) => (
            <div key={ip.id} style={itemRow}>
              <span style={itemValue}>{ip.ip_address}</span>
              {ip.description && <span style={{ fontSize: '0.75rem', color: GLASS.textMuted }}>{ip.description}</span>}
              <button
                type="button"
                onClick={() => {
                  if (!confirm(`Remove IP ${ip.ip_address}?`)) return;
                  remove(ip.id);
                }}
                disabled={isDeleting}
                style={{ ...removeBtn, opacity: isDeleting ? 0.5 : 1 }}
                title="Remove IP"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {ips && ips.length === 0 && !isLoading && <div style={emptyHint}>No IPs configured.</div>}

      <form onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: '0 0 180px' }}>
          <FormField
            label="IP Address"
            value={newIp}
            onChange={(e) => setNewIp((e.target as HTMLInputElement).value)}
            placeholder="192.168.1.1"
          />
        </div>
        <div style={{ flex: 1 }}>
          <FormField
            label="Description (optional)"
            value={newIpDesc}
            onChange={(e) => setNewIpDesc((e.target as HTMLInputElement).value)}
            placeholder="Main PBX"
          />
        </div>
        <Button type="submit" variant="ghost" size="sm" loading={isAdding}>
          + Add IP
        </Button>
      </form>
    </div>
  );
}
