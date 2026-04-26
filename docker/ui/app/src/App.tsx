import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { RequireAuth } from './components/auth/RequireAuth';
import { RequireAdmin } from './components/auth/RequireAdmin';
import { AppLayout } from './components/layout/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { RcfPage } from './pages/RcfPage';
import { ApiDidsPage } from './pages/ApiDidsPage';
import { TrunksPage } from './pages/TrunksPage';
import { IvrBuilderPage } from './pages/IvrBuilderPage';
import { RcfDocsPage } from './pages/docs/RcfDocsPage';
import { ApiDocsPage } from './pages/docs/ApiDocsPage';
import { IntegrationDocsPage } from './pages/docs/IntegrationDocsPage';
import { TroubleshootingPage } from './pages/TroubleshootingPage';
import { AdminPage } from './pages/admin/AdminPage';
import { PlatformManagementPage } from './pages/admin/PlatformManagementPage';
import { CustomersAdminPage } from './pages/admin/CustomersAdminPage';
import { CustomerAccountPage } from './pages/admin/CustomerAccountPage';
import { CdrsAdminPage } from './pages/admin/CdrsAdminPage';
import { RatesAdminPage } from './pages/admin/RatesAdminPage';
import { TiersAdminPage } from './pages/admin/TiersAdminPage';
import { CarriersAdminPage } from './pages/admin/CarriersAdminPage';
import { SippAdminPage } from './pages/admin/SippAdminPage';
// Homer moved to standalone Troubleshooting page
import { TrunksAdminPage } from './pages/admin/TrunksAdminPage';
import { DIDSearchPage } from './pages/admin/DIDSearchPage';
import { UserDetailPage } from './pages/admin/UserDetailPage';
import { CallQualityPage } from './pages/CallQualityPage';
import { AccountPage } from './pages/AccountPage';

export function App() {
  return (
    <BrowserRouter>
      {/* AuthProvider is inside BrowserRouter so it can call useNavigate */}
      <AuthProvider>
        <Routes>
          {/* Public route — no auth required */}
          <Route path="login" element={<LoginPage />} />

          {/* Routes wrapped in the sidebar layout — all require authentication */}
          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="rcf"        element={<RcfPage />} />
            <Route path="api-dids"   element={<ApiDidsPage />} />
            <Route path="trunks"     element={<TrunksPage />} />
            <Route path="ivr"        element={<IvrBuilderPage />} />
            <Route path="documentation" element={<Navigate to="/docs/rcf" replace />} />
            <Route path="docs/rcf"         element={<RcfDocsPage />} />
            <Route path="docs/api"         element={<ApiDocsPage />} />
            <Route path="docs/integration" element={<IntegrationDocsPage />} />
            <Route path="call-quality" element={<CallQualityPage />} />
            <Route path="account"          element={<AccountPage />} />

            {/* DID Search — admin-only, standalone (not nested inside AdminPage tabs) */}
            <Route
              path="admin/did-search"
              element={
                <RequireAdmin>
                  <DIDSearchPage />
                </RequireAdmin>
              }
            />

            {/* User 360 View — admin-only support tool */}
            <Route
              path="admin/user/:userId"
              element={
                <RequireAdmin>
                  <UserDetailPage />
                </RequireAdmin>
              }
            />
            <Route
              path="admin/user"
              element={
                <RequireAdmin>
                  <UserDetailPage />
                </RequireAdmin>
              }
            />

            {/* Customer account page — outside AdminPage wrapper for clean layout */}
            <Route
              path="admin/customers/:customerId"
              element={
                <RequireAdmin>
                  <CustomerAccountPage />
                </RequireAdmin>
              }
            />

            {/* Customer Management — nested under AdminPage tab shell */}
            <Route
              path="admin"
              element={
                <RequireAdmin>
                  <AdminPage />
                </RequireAdmin>
              }
            >
              <Route index            element={<Navigate to="customers" replace />} />
              <Route path="customers" element={<CustomersAdminPage />} />
              <Route path="trunks"    element={<TrunksAdminPage />} />
            </Route>

            {/* Platform Management — nested under PlatformManagementPage tab shell */}
            <Route
              path="admin/platform"
              element={
                <RequireAdmin>
                  <PlatformManagementPage />
                </RequireAdmin>
              }
            >
              <Route index           element={<Navigate to="carriers" replace />} />
              <Route path="carriers" element={<CarriersAdminPage />} />
              <Route path="cdrs"     element={<CdrsAdminPage />} />
              <Route path="rates"    element={<RatesAdminPage />} />
              <Route path="tiers"    element={<TiersAdminPage />} />
              <Route path="sipp"     element={<SippAdminPage />} />
            </Route>
          </Route>

          {/* Full-screen pages — outside AppLayout (no max-width/padding) */}
          <Route
            path="troubleshooting"
            element={
              <RequireAuth>
                <TroubleshootingPage />
              </RequireAuth>
            }
          />

          {/* Catch-all redirect to home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
