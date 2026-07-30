import { useNavigate } from 'react-router-dom';
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
  boxShadow: 'inset 0 -1px 0 0 rgba(255,255,255,0.025)',
  verticalAlign: 'middle',
};

export function CustomerRow({ customer }: CustomerRowProps) {
  const navigate = useNavigate();

  return (
    <tr
      className="glass-row-hover"
      onClick={() => navigate(`/admin/customers/${customer.id}`)}
      style={{ cursor: 'pointer' }}
    >
      <td style={tdStyle}>
        <span style={{ color: '#4a5568', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.78rem' }}>
          #{customer.id}
        </span>
      </td>
      <td style={tdStyle}>
        <span
          style={{
            color: '#e2e8f0',
            fontWeight: 600,
            fontSize: '0.875rem',
          }}
        >
          {customer.name}
        </span>
      </td>
      <td style={tdStyle}>{accountTypeBadge(customer.account_type)}</td>
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
