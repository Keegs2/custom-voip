/**
 * TrunksTable — the dense list of trunks inside a frosted glass panel. Each row
 * is a <TrunkRow> that expands to reveal IP/DID/connection management.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { Trunk } from '../../../../types/trunk';
import { TrunkRow } from './TrunkRow';
import { COL_COUNT } from '../types';
import { th } from '../styles';

interface TrunksTableProps {
  trunks: Trunk[];
  expandedId: number | null;
  onToggleExpand: (id: number) => void;
  onToggleEnabled: (trunk: Trunk) => void;
  onDelete: (trunk: Trunk) => void;
}

const HEADERS = ['ID', 'Trunk Name', 'Customer', 'Auth Type', 'Max Ch.', 'CPS', 'IPs', 'DIDs', 'Status', 'Actions'];

export function TrunksTable({ trunks, expandedId, onToggleExpand, onToggleEnabled, onDelete }: TrunksTableProps) {
  return (
    <GlassPanel padding={0} blur={20}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
              {HEADERS.map((h, i) => (
                <th key={h} style={i === HEADERS.length - 1 ? { ...th, textAlign: 'right' } : th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trunks.length === 0 ? (
              <tr>
                <td colSpan={COL_COUNT} style={{ padding: '48px 16px', textAlign: 'center', color: GLASS.textMuted, fontSize: '0.875rem', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  No trunks found.
                </td>
              </tr>
            ) : (
              trunks.map((trunk) => (
                <TrunkRow
                  key={trunk.id}
                  trunk={trunk}
                  isExpanded={expandedId === trunk.id}
                  onToggleExpand={onToggleExpand}
                  onToggleEnabled={onToggleEnabled}
                  onDelete={onDelete}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </GlassPanel>
  );
}
