/**
 * GlassCustomerTable — the customer list rendered as a dense table inside a
 * frosted glass panel. Renders the empty state inline when there are no rows.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import type { Customer } from '../../../../types/customer';
import { COL_COUNT } from '../types';
import { th, emptyCell } from '../styles';
import { GlassCustomerRow } from './GlassCustomerRow';

interface GlassCustomerTableProps {
  customers: Customer[];
  searched: boolean;
}

export function GlassCustomerTable({ customers, searched }: GlassCustomerTableProps) {
  return (
    <GlassPanel padding={0} blur={20}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
              <th style={th}>ID</th>
              <th style={th}>Name</th>
              <th style={th}>Type</th>
              <th style={th}>Balance</th>
              <th style={th}>Status</th>
              <th style={th}>Grade</th>
              <th style={th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td colSpan={COL_COUNT} style={emptyCell}>
                  {searched ? 'No customers match your search.' : 'No customers found.'}
                </td>
              </tr>
            ) : (
              customers.map((customer) => <GlassCustomerRow key={customer.id} customer={customer} />)
            )}
          </tbody>
        </table>
      </div>
    </GlassPanel>
  );
}
