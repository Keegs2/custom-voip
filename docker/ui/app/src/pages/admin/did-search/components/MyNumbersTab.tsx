/**
 * MyNumbersTab — read-only list of the DIDs assigned to the calling customer's
 * account. No actions. Reads data through the feature hook.
 *
 * React #310: the data hook sits unconditionally at the top.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { fmt } from '../../../../utils/format';
import { useMyNumbersData } from '../hooks';
import {
  panelToolbar, countText, countStrong, tableWrap, table, th, td, didCell, dash, notesCell,
} from '../styles';
import { StatusBadge, ProductPill, EnvBadge } from './Chips';
import { LoadingRow, EmptyRow } from './states';

const COLS = 8;

export function MyNumbersTab() {
  const { items, isLoading } = useMyNumbersData();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <GlassPanel padding={0} blur={20}>
        <div style={panelToolbar}>
          <span style={countText}>
            <strong style={countStrong}>{items.length}</strong> numbers assigned to your account
          </span>
        </div>

        <div style={tableWrap}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th()}>DID</th>
                <th style={th()}>City</th>
                <th style={th()}>State</th>
                <th style={th()}>Product</th>
                <th style={th()}>Status</th>
                <th style={th()}>Environment</th>
                <th style={th()}>Assigned</th>
                <th style={th()}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <LoadingRow colSpan={COLS} />
              ) : items.length === 0 ? (
                <EmptyRow colSpan={COLS} message="No numbers are currently assigned to your account" />
              ) : (
                items.map((item) => (
                  <tr key={item.id}>
                    <td style={td()}><span style={didCell}>{fmt(item.did)}</span></td>
                    <td style={td({ muted: true })}>{item.city ?? '—'}</td>
                    <td style={td({ muted: true })}>{item.state ?? '—'}</td>
                    <td style={td()}>{item.product_type ? <ProductPill type={item.product_type} /> : <span style={dash}>—</span>}</td>
                    <td style={td()}><StatusBadge status={item.status} /></td>
                    <td style={td()}><EnvBadge env={item.allocated_env} /></td>
                    <td style={td({ muted: true })}>{item.assigned_at ? new Date(item.assigned_at).toLocaleDateString() : '—'}</td>
                    <td style={td({ muted: true })}><span style={notesCell}>{item.notes ?? '—'}</span></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </GlassPanel>
    </div>
  );
}
