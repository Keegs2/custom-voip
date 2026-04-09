import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCustomers, createCustomer } from '../../api/customers';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { Pagination } from '../../components/ui/Pagination';
import { TableWrap, Table, Thead, Th } from '../../components/ui/Table';
import { FormField } from '../../components/ui/FormField';
import { useToast } from '../../components/ui/ToastContext';
import { CustomerRow } from './CustomerRow';
import type { AccountType, TrafficGrade } from '../../types/customer';

const PAGE_SIZE = 25;
const COL_COUNT = 7;

interface CreateFormState {
  name: string;
  account_type: AccountType;
  traffic_grade: TrafficGrade;
  credit_limit: string;
  daily_limit: string;
  cpm_limit: string;
}

const INITIAL_CREATE: CreateFormState = {
  name: '',
  account_type: 'rcf',
  traffic_grade: 'standard',
  credit_limit: '0',
  daily_limit: '500',
  cpm_limit: '60',
};

export function CustomersAdminPage() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState<CreateFormState>(INITIAL_CREATE);
  const [expandedCustomerId, setExpandedCustomerId] = useState<number | null>(null);
  const [editingCustomerId, setEditingCustomerId] = useState<number | null>(null);

  // ----- Data fetching -----

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customers', { search: committedSearch, offset }],
    queryFn: () =>
      listCustomers({ search: committedSearch, limit: PAGE_SIZE, offset }),
  });

  // ----- Mutations -----

  const createMutation = useMutation({
    mutationFn: () =>
      createCustomer({
        name: createForm.name.trim(),
        account_type: createForm.account_type,
        traffic_grade: createForm.traffic_grade,
        credit_limit: parseFloat(createForm.credit_limit) || 0,
        daily_limit: parseFloat(createForm.daily_limit) || 0,
        cpm_limit: parseInt(createForm.cpm_limit, 10) || 0,
      }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      setCreateForm(INITIAL_CREATE);
      setShowCreateForm(false);
      toastOk(`Customer "${created.name}" created`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // ----- Handlers -----

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    setCommittedSearch(search);
  }

  function handleToggleExpand(id: number) {
    if (expandedCustomerId === id) {
      // Collapse: also exit edit mode
      setExpandedCustomerId(null);
      setEditingCustomerId(null);
    } else {
      setExpandedCustomerId(id);
      setEditingCustomerId(null);
    }
  }

  function handleStartEdit(id: number) {
    setEditingCustomerId(id);
  }

  function handleCancelEdit() {
    setEditingCustomerId(null);
  }

  function handleSaved() {
    setEditingCustomerId(null);
  }

  function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.name.trim()) {
      toastErr('Name is required');
      return;
    }
    createMutation.mutate();
  }

  function updateCreateForm<K extends keyof CreateFormState>(
    key: K,
    value: CreateFormState[K],
  ) {
    setCreateForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 min-w-[200px]">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers…"
            className="text-[0.88rem] px-3 py-[7px] rounded-lg border border-[#2a2f45] bg-[#1e2130] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096] max-w-xs w-full"
          />
          <Button type="submit" variant="ghost" size="sm">
            Search
          </Button>
        </form>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowCreateForm((v) => !v)}
        >
          {showCreateForm ? 'Cancel' : '+ New Customer'}
        </Button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <form
          onSubmit={handleCreateSubmit}
          className="mb-5 p-4 bg-[#1e2130] border border-[#2a2f45] rounded-[10px]"
        >
          <div className="text-[0.63rem] font-bold text-[#718096] uppercase tracking-[0.9px] mb-3">
            New Customer
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <FormField
              label="Name"
              value={createForm.name}
              onChange={(e) =>
                updateCreateForm('name', (e.target as HTMLInputElement).value)
              }
              placeholder="Acme Corp"
              required
            />
            <FormField
              label="Account Type"
              as="select"
              value={createForm.account_type}
              onChange={(e) =>
                updateCreateForm(
                  'account_type',
                  (e.target as HTMLSelectElement).value as AccountType,
                )
              }
            >
              <option value="rcf">RCF</option>
              <option value="api">API</option>
              <option value="trunk">Trunk</option>
              <option value="hybrid">Hybrid</option>
            </FormField>
            <FormField
              label="Traffic Grade"
              as="select"
              value={createForm.traffic_grade}
              onChange={(e) =>
                updateCreateForm(
                  'traffic_grade',
                  (e.target as HTMLSelectElement).value as TrafficGrade,
                )
              }
            >
              <option value="standard">Standard</option>
              <option value="premium">Premium</option>
              <option value="economy">Economy</option>
            </FormField>
            <FormField
              label="Credit Limit ($)"
              type="number"
              min="0"
              step="0.01"
              value={createForm.credit_limit}
              onChange={(e) =>
                updateCreateForm('credit_limit', (e.target as HTMLInputElement).value)
              }
            />
            <FormField
              label="Daily Limit ($)"
              type="number"
              min="0"
              step="0.01"
              value={createForm.daily_limit}
              onChange={(e) =>
                updateCreateForm('daily_limit', (e.target as HTMLInputElement).value)
              }
            />
            <FormField
              label="CPM Limit"
              type="number"
              min="0"
              value={createForm.cpm_limit}
              onChange={(e) =>
                updateCreateForm('cpm_limit', (e.target as HTMLInputElement).value)
              }
            />
          </div>
          <div className="flex gap-2 mt-3 pt-3 border-t border-[#2a2f45]">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={createMutation.isPending}
            >
              Create Customer
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowCreateForm(false);
                setCreateForm(INITIAL_CREATE);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Loading / error states */}
      {isLoading && (
        <div className="flex items-center gap-2 text-[#718096] py-8">
          <Spinner /> Loading customers…
        </div>
      )}

      {isError && (
        <p className="text-red-400 text-sm py-4">Failed to load customers.</p>
      )}

      {/* Table */}
      {data && (
        <>
          <TableWrap>
            <Table>
              <Thead>
                <tr>
                  <Th>ID</Th>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Balance</Th>
                  <Th>Status</Th>
                  <Th>Grade</Th>
                  <Th>Created</Th>
                </tr>
              </Thead>
              <tbody>
                {data.items.length === 0 ? (
                  <tr>
                    <td
                      colSpan={COL_COUNT}
                      className="px-[14px] py-8 text-center text-[#718096] text-sm"
                    >
                      No customers found.
                    </td>
                  </tr>
                ) : (
                  data.items.map((customer) => (
                    <CustomerRow
                      key={customer.id}
                      customer={customer}
                      isExpanded={expandedCustomerId === customer.id}
                      isEditing={editingCustomerId === customer.id}
                      onToggleExpand={handleToggleExpand}
                      onStartEdit={handleStartEdit}
                      onCancelEdit={handleCancelEdit}
                      onSaved={handleSaved}
                      colSpan={COL_COUNT}
                    />
                  ))
                )}
              </tbody>
            </Table>
          </TableWrap>

          <Pagination
            shown={data.items.length + offset}
            total={data.total}
            onLoadMore={() => setOffset((o) => o + PAGE_SIZE)}
          />
        </>
      )}
    </div>
  );
}
