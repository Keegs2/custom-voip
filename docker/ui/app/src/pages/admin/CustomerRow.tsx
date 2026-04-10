import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import type { Customer, AccountType, CustomerStatus, TrafficGrade } from '../../types/customer';

interface CustomerRowProps {
  customer: Customer;
}

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

const tdStyle: React.CSSProperties = {
  padding: '13px 16px',
  borderBottom: '1px solid rgba(42,47,69,0.45)',
  verticalAlign: 'middle',
};

export function CustomerRow({ customer }: CustomerRowProps) {
  return (
    <tr
      style={{ transition: 'background 0.15s' }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.018)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
      }}
    >
      <td style={tdStyle}>
        <span style={{ color: '#4a5568', fontFamily: 'monospace', fontSize: '0.78rem' }}>
          #{customer.id}
        </span>
      </td>
      <td style={tdStyle}>
        <Link
          to={`/admin/customers/${customer.id}`}
          style={{
            color: '#e2e8f0',
            fontWeight: 600,
            fontSize: '0.875rem',
            textDecoration: 'none',
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color = '#93c5fd';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color = '#e2e8f0';
          }}
        >
          {customer.name}
        </Link>
      </td>
      <td style={tdStyle}>{accountTypeBadge(customer.account_type)}</td>
      <td style={tdStyle}>
        <span
          style={{
            color: customer.balance < 0 ? '#f87171' : '#e2e8f0',
            fontVariantNumeric: 'tabular-nums',
            fontSize: '0.875rem',
            fontWeight: customer.balance < 0 ? 600 : 400,
          }}
        >
          ${customer.balance.toFixed(2)}
        </span>
      </td>
      <td style={tdStyle}>{statusBadge(customer.status)}</td>
      <td style={tdStyle}>{gradeBadge(customer.traffic_grade)}</td>
      <td style={{ ...tdStyle, color: '#4a5568', fontSize: '0.82rem' }}>
        {customer.created_at
          ? new Date(customer.created_at).toLocaleDateString()
          : '--'}
      </td>
    </tr>
  );
}
