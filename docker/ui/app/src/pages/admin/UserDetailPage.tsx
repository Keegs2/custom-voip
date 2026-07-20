/**
 * UserDetailPage — admin "User Lookup" / 360 view. THIN page: composition +
 * top-level navigation state only. All data, mutations, styling and the
 * presentational pieces live in the co-located `user-detail/` feature folder
 * (see docs/FRONTEND_GLASS_REFACTOR.md). The ambient liquid-glass backdrop is
 * mounted app-wide by AppLayout — this page just builds glass surfaces on top.
 *
 * Three states, driven by URL + selection:
 *   1. Customer picker  — no selection, no :userId
 *   2. User list        — a customer is selected
 *   3. 360 view         — a user is selected (or deep-linked via :userId)
 *
 * React #310: every hook is declared unconditionally at the top, before any
 * conditional rendering.
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { GLASS } from '../../components/glass/glass';
import type { Customer as PlatformCustomer } from '../../types/customer';
import { CustomerPickerTable } from './user-detail/components/CustomerPickerTable';
import { UserLookupPanel } from './user-detail/components/UserLookupPanel';
import { User360View } from './user-detail/components/User360View';
import { BackButton } from './user-detail/components/states';
import { kicker } from './user-detail/styles';

export function UserDetailPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { userId: userIdParam } = useParams<{ userId: string }>();
  const navigate = useNavigate();

  const urlUserId = userIdParam ? parseInt(userIdParam, 10) : null;
  const [selectedUserId, setSelectedUserId] = useState<number | null>(
    urlUserId && !Number.isNaN(urlUserId) ? urlUserId : null,
  );
  const [selectedCustomer, setSelectedCustomer] = useState<PlatformCustomer | null>(null);

  function handleSelectCustomer(customer: PlatformCustomer) {
    setSelectedCustomer(customer);
    setSelectedUserId(null);
  }

  function handleSelectUser(id: number) {
    setSelectedUserId(id);
    navigate(`/admin/customers/users/${id}`, { replace: true });
  }

  function handleBackToUsers() {
    setSelectedUserId(null);
    navigate('/admin/customers/users', { replace: true });
  }

  function handleBackToCustomers() {
    setSelectedUserId(null);
    setSelectedCustomer(null);
    navigate('/admin/customers/users', { replace: true });
  }

  const show360View = selectedUserId != null;
  const showUserList = !show360View && selectedCustomer != null;
  const showCustomerPicker = !show360View && selectedCustomer == null;

  return (
    <div>
      {/* ── State 1: Customer picker ────────────────────────── */}
      {showCustomerPicker && <CustomerPickerTable onSelectCustomer={handleSelectCustomer} />}

      {/* ── State 2: User list for selected customer ─────────── */}
      {showUserList && selectedCustomer && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <BackButton label="Back to customers" onClick={handleBackToCustomers} />

          <div>
            <span style={kicker('#a855f7')}>Customer</span>
            <h2 style={{ margin: '4px 0 0', fontSize: '1.05rem', fontWeight: 700, color: GLASS.text, letterSpacing: '-0.01em' }}>
              {selectedCustomer.name}
            </h2>
          </div>

          <UserLookupPanel onSelectUser={handleSelectUser} customerId={selectedCustomer.id} />
        </div>
      )}

      {/* ── State 3: 360 View ────────────────────────────────── */}
      {show360View && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <BackButton
            label={selectedCustomer != null ? `Back to ${selectedCustomer.name} users` : 'Back to customers'}
            onClick={selectedCustomer != null ? handleBackToUsers : handleBackToCustomers}
          />
          <User360View userId={selectedUserId!} />
        </div>
      )}
    </div>
  );
}
