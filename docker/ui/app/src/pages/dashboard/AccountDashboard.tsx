/**
 * AccountDashboard — the `/dashboard` route entry. Picks who the dashboard is
 * for and hands off to a keyed view (so switching accounts or modes remounts
 * instead of changing hook order — React #310):
 *
 *   tenant                          → AccountDashboardView viewer="tenant" (own account)
 *   admin in "View as Customer"     → AccountDashboardView viewer="preview" (the
 *                                     preview customer), or PreviewPrompt until one is picked
 *   admin (normal view)             → AdminDashboard (All customers | one customer, ?customer=)
 *   support / no account            → their productHome
 *
 * The cards, data hooks and styles are shared: AccountDashboardView.tsx,
 * AdminDashboard.tsx, accountData.ts / adminData.ts, account-dashboard.css.
 */
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { productHome } from '../../utils/productHome';
import { AccountDashboardView } from './AccountDashboardView';
import { AdminDashboard } from './AdminDashboard';
import { PreviewPrompt } from './PreviewPrompt';

export function AccountDashboard() {
  const { user, isAdmin, isActualAdmin, isSupport, customerViewMode, effectiveCustomer } = useAuth();
  if (effectiveCustomer) {
    return (
      <AccountDashboardView
        key={`customer-${effectiveCustomer.id}`}
        customer={effectiveCustomer}
        viewer={isActualAdmin || isSupport ? 'preview' : 'tenant'}
      />
    );
  }
  if (isActualAdmin && customerViewMode) return <PreviewPrompt />;
  if (isAdmin) return <AdminDashboard />;
  // Support and logins without an account have no dashboard; productHome
  // never points either of them back here.
  return <Navigate to={productHome(user, isAdmin)} replace />;
}
