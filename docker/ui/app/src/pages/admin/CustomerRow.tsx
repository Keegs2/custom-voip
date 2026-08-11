/**
 * CustomerRow — one clickable row in the admin customers table.
 * Daylight console styling (`dl-*` primitives); used only by
 * CustomersAdminPage, which owns the surrounding panel + table.
 */
import { useNavigate } from 'react-router-dom';
import type { Customer, AccountType, CustomerStatus, TrafficGrade } from '../../types/customer';

interface CustomerRowProps {
  customer: Customer;
}

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

function accountTypeTag(type: AccountType) {
  return <span className="dl-tag">{type.toUpperCase()}</span>;
}

function statusPill(status: CustomerStatus) {
  if (status === 'active') return <span className="dl-pill dl-pill-on">Active</span>;
  if (status === 'suspended') return <span className="dl-pill dl-pill-off">Suspended</span>;
  return <span className="dl-tag dl-tag-slate">Closed</span>;
}

function gradeTag(grade: TrafficGrade) {
  return <span className="dl-tag dl-tag-slate">{grade}</span>;
}

export function CustomerRow({ customer }: CustomerRowProps) {
  const navigate = useNavigate();

  return (
    <tr
      className="dl-row"
      onClick={() => navigate(`/admin/customers/${customer.id}`)}
      style={{ cursor: 'pointer' }}
    >
      <td className="dlx-td">
        <span style={{ color: 'var(--rcf-ink-dim)', fontFamily: MONO, fontSize: '0.76rem' }}>
          #{customer.id}
        </span>
      </td>
      <td className="dlx-td">
        <span style={{ color: 'var(--rcf-ink)', fontWeight: 700, fontSize: '0.85rem' }}>
          {customer.name}
        </span>
      </td>
      <td className="dlx-td">{accountTypeTag(customer.account_type)}</td>
      <td className="dlx-td">{statusPill(customer.status)}</td>
      <td className="dlx-td">{gradeTag(customer.traffic_grade)}</td>
      <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.78rem' }}>
        {customer.created_at
          ? new Date(customer.created_at).toLocaleDateString()
          : '--'}
      </td>
    </tr>
  );
}
