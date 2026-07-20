/**
 * TfnTable — frosted, server-paginated toll-free table. The header checkbox
 * toggles selection for every currently-loaded row; per-row selection persists
 * in the page's Set across load-more pages. Pure composition.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { Tfn } from '../../../../types/tollFree';
import { tableWrap, table, th, td } from '../styles';
import { TfnRow } from './TfnRow';

interface TfnTableProps {
  rows: Tfn[];
  selected: Set<string>;
  onToggle: (tfn: string) => void;
  onToggleAllLoaded: () => void;
  onView: (tfn: Tfn) => void;
}

export function TfnTable({ rows, selected, onToggle, onToggleAllLoaded, onView }: TfnTableProps) {
  const allLoadedSelected = rows.length > 0 && rows.every((r) => selected.has(r.tfn));

  return (
    <GlassPanel padding={0}>
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              <th style={{ ...th(), width: 44 }}>
                <input
                  type="checkbox"
                  checked={allLoadedSelected}
                  onChange={onToggleAllLoaded}
                  aria-label="Select all loaded"
                  style={{ width: 15, height: 15, accentColor: GLASS.accent, cursor: 'pointer' }}
                />
              </th>
              <th style={th()}>Toll-Free</th>
              <th style={th()}>Customer</th>
              <th style={th()}>Status</th>
              <th style={th()}>CR</th>
              <th style={th()}>Carrier</th>
              <th style={th()}>RespOrg</th>
              <th style={th(true)}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td style={td({ muted: true })} colSpan={8}>
                  No toll-free numbers match these filters.
                </td>
              </tr>
            ) : (
              rows.map((tfn) => (
                <TfnRow
                  key={tfn.tfn}
                  tfn={tfn}
                  selected={selected.has(tfn.tfn)}
                  onToggleSelect={() => onToggle(tfn.tfn)}
                  onView={() => onView(tfn)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </GlassPanel>
  );
}
