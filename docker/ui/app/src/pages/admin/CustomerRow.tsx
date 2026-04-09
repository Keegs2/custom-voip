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
        className={[
          'cursor-pointer transition-colors',
          isExpanded
            ? 'bg-white/[0.03]'
            : 'hover:bg-white/[0.015]',
        ].join(' ')}
        onClick={() => onToggleExpand(customer.id)}
      >
        <td className="px-4 py-3 border-b border-[#2a2f45]/50 align-middle text-sm">
          <span className="text-[#718096] font-mono text-xs">#{customer.id}</span>
        </td>
        <td className="px-4 py-3 border-b border-[#2a2f45]/50 align-middle text-sm">
          <div className="flex items-center gap-2">
            <span
              className={[
                'w-[6px] h-[6px] rounded-full flex-shrink-0',
                isExpanded ? 'bg-[#3b82f6]' : 'bg-transparent',
              ].join(' ')}
            />
            <span className="text-[#e2e8f0] font-medium">{customer.name}</span>
          </div>
        </td>
        <td className="px-4 py-3 border-b border-[#2a2f45]/50 align-middle text-sm">
          {accountTypeBadge(customer.account_type)}
        </td>
        <td className="px-4 py-3 border-b border-[#2a2f45]/50 align-middle text-sm">
          <span className={customer.balance < 0 ? 'text-red-400' : 'text-[#e2e8f0]'}>
            ${customer.balance.toFixed(2)}
          </span>
        </td>
        <td className="px-4 py-3 border-b border-[#2a2f45]/50 align-middle text-sm">
          {statusBadge(customer.status)}
        </td>
        <td className="px-4 py-3 border-b border-[#2a2f45]/50 align-middle text-sm">
          {gradeBadge(customer.traffic_grade)}
        </td>
        <td className="px-4 py-3 border-b border-[#2a2f45]/50 align-middle text-sm text-[#718096] text-[0.82rem]">
          {customer.created_at
            ? new Date(customer.created_at).toLocaleDateString()
            : '--'}
        </td>
      </tr>

      {/* Expanded row */}
      {isExpanded && (
        <tr>
          <td
            colSpan={colSpan}
            className="bg-[#0f1117] border-b border-[#2a2f45]"
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
          </td>
        </tr>
      )}
    </>
  );
}
