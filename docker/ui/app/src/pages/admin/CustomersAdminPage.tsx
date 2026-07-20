/**
 * CustomersAdminPage — THIN page: composition + top-level state only.
 *
 * Renders inside the `AdminPage` tab shell (which owns the page header, tab bar,
 * and the app-wide layout padding), so this page starts straight at its controls
 * bar. All data fetching + the create mutation live in `./customers/hooks`; every
 * surface is built from the canonical blue glass kit; styles live in
 * `./customers/styles`. See docs/FRONTEND_GLASS_REFACTOR.md.
 *
 * React #310: every hook is called unconditionally at the top, before any return.
 */

import { useState } from 'react';
import { Pagination } from '../../components/ui/Pagination';
import { useCustomersList, useCreateCustomer } from './customers/hooks';
import { PAGE_SIZE } from './customers/types';
import { CustomersControlsBar } from './customers/components/CustomersControlsBar';
import { CreateCustomerForm } from './customers/components/CreateCustomerForm';
import { GlassCustomerTable } from './customers/components/GlassCustomerTable';
import { CustomerTableSkeleton, StateCard } from './customers/components/states';
import { IconError } from './customers/components/icons';

export function CustomersAdminPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  const { items, total, isLoading, isError, hasData } = useCustomersList({
    search: committedSearch,
    offset,
  });

  const create = useCreateCustomer(() => setShowCreateForm(false));

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    setCommittedSearch(search);
  }

  function toggleCreate() {
    setShowCreateForm((v) => {
      if (v) create.reset();
      return !v;
    });
  }

  function cancelCreate() {
    setShowCreateForm(false);
    create.reset();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <CustomersControlsBar
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={handleSearch}
        showCreateForm={showCreateForm}
        onToggleCreate={toggleCreate}
        total={total}
        hasData={hasData}
      />

      {showCreateForm && (
        <CreateCustomerForm
          form={create.form}
          isPending={create.isPending}
          updateField={create.updateField}
          onSubmit={create.submit}
          onCancel={cancelCreate}
        />
      )}

      {isLoading ? (
        <CustomerTableSkeleton />
      ) : isError ? (
        <StateCard
          icon={<IconError />}
          title="Couldn't load customers"
          body="The request failed. Check your connection and try again."
        />
      ) : (
        <>
          <GlassCustomerTable customers={items} searched={committedSearch.length > 0} />
          <Pagination
            shown={items.length + offset}
            total={total}
            onLoadMore={() => setOffset((o) => o + PAGE_SIZE)}
          />
        </>
      )}
    </div>
  );
}
