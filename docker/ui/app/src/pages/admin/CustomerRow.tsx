import { Badge } from '../../components/ui/Badge';
import { CustomerExpandedView } from './CustomerExpandedView';
import { CustomerEditForm } from './CustomerEditForm';
import type { Customer, AccountType, CustomerStatus, TrafficGrade } from '../../types/customer';

interface CustomerRowProps {
  customer: Customer;
  isExpanded: boolean;
  isEditing: boolean;
  onToggleExpand: (id: number) => void;
  onStartEdit: (id: number) => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  colSpan: number;
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

export function CustomerRow({
  customer,
  isExpanded,
  isEditing,
  onToggleExpand,
  onStartEdit,
  onCancelEdit,
  onSaved,
  colSpan,
}: CustomerRowProps) {
  return (
    <>
      {/* Main row */}
      <tr
        style={{
          cursor: 'pointer',
          transition: 'background 0.15s',
          background: isExpanded ? 'rgba(59,130,246,0.06)' : 'transparent',
        }}
        onMouseEnter={(e) => {
          if (!isExpanded) {
            (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.018)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isExpanded) {
            (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
          }
        }}
        onClick={() => onToggleExpand(customer.id)}
      >
        <td
          style={{
            padding: '13px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
            verticalAlign: 'middle',
          }}
        >
          <span style={{ color: '#4a5568', fontFamily: 'monospace', fontSize: '0.78rem' }}>
            #{customer.id}
          </span>
        </td>
        <td
          style={{
            padding: '13px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
            verticalAlign: 'middle',
          }}
        >
          <div className="flex items-center gap-2.5">
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                flexShrink: 0,
                background: isExpanded ? '#3b82f6' : 'transparent',
                boxShadow: isExpanded ? '0 0 6px #3b82f6' : 'none',
                transition: 'background 0.2s, box-shadow 0.2s',
              }}
            />
            <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.875rem' }}>
              {customer.name}
            </span>
          </div>
        </td>
        <td
          style={{
            padding: '13px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
            verticalAlign: 'middle',
          }}
        >
          {accountTypeBadge(customer.account_type)}
        </td>
        <td
          style={{
            padding: '13px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
            verticalAlign: 'middle',
          }}
        >
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
        <td
          style={{
            padding: '13px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
            verticalAlign: 'middle',
          }}
        >
          {statusBadge(customer.status)}
        </td>
        <td
          style={{
            padding: '13px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
            verticalAlign: 'middle',
          }}
        >
          {gradeBadge(customer.traffic_grade)}
        </td>
        <td
          style={{
            padding: '13px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
            verticalAlign: 'middle',
            color: '#4a5568',
            fontSize: '0.82rem',
          }}
        >
          {customer.created_at
            ? new Date(customer.created_at).toLocaleDateString()
            : '--'}
        </td>
      </tr>

      {/* Expanded panel */}
      {isExpanded && (
        <tr>
          <td
            colSpan={colSpan}
            style={{
              padding: 0,
              borderBottom: '1px solid rgba(42,47,69,0.6)',
              background: 'linear-gradient(135deg, rgba(19,21,29,0.98) 0%, rgba(15,17,23,1) 100%)',
            }}
          >
            {/* Inner card with left accent border */}
            <div
              style={{
                borderLeft: '3px solid #3b82f6',
                margin: '0',
              }}
            >
              {isEditing ? (
                <CustomerEditForm
                  customer={customer}
                  onCancel={onCancelEdit}
                  onSaved={onSaved}
                />
              ) : (
                <CustomerExpandedView
                  customer={customer}
                  onEdit={() => onStartEdit(customer.id)}
                />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
