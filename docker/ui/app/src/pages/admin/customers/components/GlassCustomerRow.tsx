/**
 * GlassCustomerRow — one customer row inside the frosted customer table. Clicking
 * the row navigates to the customer 360 view. Status / type / grade render via
 * the shared <Badge> primitive. (Glassified successor to the old CustomerRow.)
 */

import { useNavigate } from 'react-router-dom';
import { Badge } from '../../../../components/ui/Badge';
import { GLASS } from '../../../../components/glass/glass';
import type { Customer, AccountType, CustomerStatus, TrafficGrade } from '../../../../types/customer';
import { MONO, td } from '../styles';

function accountTypeBadge(type: AccountType) {
  return <Badge variant={type}>{type.toUpperCase()}</Badge>;
}

function statusBadge(status: CustomerStatus) {
  if (status === 'active') return <Badge variant="active">Active</Badge>;
  if (status === 'suspended') return <Badge variant="suspended">Suspended</Badge>;
  return <Badge variant="closed">Closed</Badge>;
}

function gradeBadge(grade: TrafficGrade) {
  return <Badge variant={grade}>{grade}</Badge>;
}

export function GlassCustomerRow({ customer }: { customer: Customer }) {
  const navigate = useNavigate();

  return (
    <tr
      onClick={() => navigate(`/admin/customers/${customer.id}`)}
      style={{ transition: 'background 0.15s', cursor: 'pointer' }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.04)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
      }}
    >
      <td style={td}>
        <span style={{ color: GLASS.textFaint, fontFamily: MONO, fontSize: '0.78rem' }}>#{customer.id}</span>
      </td>
      <td style={td}>
        <span style={{ color: GLASS.text, fontWeight: 600, fontSize: '0.875rem' }}>{customer.name}</span>
      </td>
      <td style={td}>{accountTypeBadge(customer.account_type)}</td>
      <td style={td}>
        <span
          style={{
            color: customer.balance < 0 ? GLASS.danger : GLASS.text,
            fontVariantNumeric: 'tabular-nums',
            fontSize: '0.875rem',
            fontWeight: customer.balance < 0 ? 600 : 400,
          }}
        >
          ${customer.balance.toFixed(2)}
        </span>
      </td>
      <td style={td}>{statusBadge(customer.status)}</td>
      <td style={td}>{gradeBadge(customer.traffic_grade)}</td>
      <td style={{ ...td, color: GLASS.textFaint, fontSize: '0.82rem' }}>
        {customer.created_at ? new Date(customer.created_at).toLocaleDateString() : '--'}
      </td>
    </tr>
  );
}
