import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { RequireAuth } from './components/auth/RequireAuth';
import { RequireAdmin } from './components/auth/RequireAdmin';
import { AppLayout } from './components/layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { RcfPage } from './pages/RcfPage';
import { ApiDidsPage } from './pages/ApiDidsPage';
import { TrunksPage } from './pages/TrunksPage';
import { IvrBuilderPage } from './pages/IvrBuilderPage';
import { VisualVoicemailPage } from './pages/VisualVoicemailPage';
import { RcfDocsPage } from './pages/docs/RcfDocsPage';
import { ApiDocsPage } from './pages/docs/ApiDocsPage';
import { TroubleshootingPage } from './pages/TroubleshootingPage';
import { AdminPage } from './pages/admin/AdminPage';
import { PlatformManagementPage } from './pages/admin/PlatformManagementPage';
import { CustomersAdminPage } from './pages/admin/CustomersAdminPage';
import { CustomerAccountPage } from './pages/admin/CustomerAccountPage';
import { CdrsAdminPage } from './pages/admin/CdrsAdminPage';
import { RatesAdminPage } from './pages/admin/RatesAdminPage';
import { TiersAdminPage } from './pages/admin/TiersAdminPage';
import { CarriersAdminPage } from './pages/admin/CarriersAdminPage';
import { StirSummaryPage } from './pages/admin/StirSummaryPage';
// Homer moved to standalone Troubleshooting page
import { TrunksAdminPage } from './pages/admin/TrunksAdminPage';
import { DIDSearchPage } from './pages/admin/DIDSearchPage';
import { UserDetailPage } from './pages/admin/UserDetailPage';
import { OnboardingAdminPage } from './pages/admin/OnboardingAdminPage';
import { CallQualityPage } from './pages/CallQualityPage';
import { MyAccountPage } from './pages/MyAccountPage';

/** Redirects /admin/user/:userId → /admin/customers/users/:userId */
function UserDetailRedirect() {
  const { userId } = useParams<{ userId: string }>();
  return <Navigate to={`/admin/customers/users/${userId}`} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      {/* AuthProvider is inside BrowserRouter so it can call useNavigate */}
      <AuthProvider>
        <Routes>
          {/* Redirect old /login bookmarks to the homepage */}
          <Route path="login" element={<Navigate to="/" replace />} />

          {/* Routes inside the sidebar layout */}
          <Route element={<AppLayout />}>
            {/* Public — homepage is visible without authentication */}
            <Route index element={<DashboardPage />} />

            {/* Protected — all other routes require authentication */}
            <Route element={<RequireAuth />}>
              <Route path="rcf"        element={<RcfPage />} />
              <Route path="api-dids"   element={<ApiDidsPage />} />
              <Route path="trunks"     element={<TrunksPage />} />
              <Route path="ivr"        element={<IvrBuilderPage />} />
              <Route path="voicemail"  element={<VisualVoicemailPage />} />
              <Route path="documentation" element={<Navigate to="/docs/rcf" replace />} />
              <Route path="docs/rcf"         element={<RcfDocsPage />} />
              <Route path="docs/api"         element={<ApiDocsPage />} />
              <Route path="docs/integration" element={<Navigate to="/docs/api" replace />} />
              <Route path="call-quality" element={<CallQualityPage />} />
              {/* Old bookmarks: the standalone Account Settings page is retired —
                  its content lives in MyAccountPage's "Your Account" tab. */}
              <Route path="account"          element={<Navigate to="/my-account" replace />} />
              <Route path="my-account"       element={<MyAccountPage />} />

              {/* Redirects from old standalone paths to their new tab locations */}
              <Route path="admin/did-search" element={<Navigate to="/admin/platform/dids" replace />} />
              <Route path="admin/user" element={<Navigate to="/admin/customers/users" replace />} />
              <Route
                path="admin/user/:userId"
                element={<UserDetailRedirect />}
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
                <Route index                              element={<Navigate to="customers" replace />} />
                <Route path="onboarding"                  element={<OnboardingAdminPage />} />
                <Route path="customers"                   element={<CustomersAdminPage />} />
                <Route path="customers/:customerId"       element={<CustomerAccountPage />} />
                <Route path="trunks"                      element={<TrunksAdminPage />} />
                <Route path="customers/users"             element={<UserDetailPage />} />
                <Route path="customers/users/:userId"     element={<UserDetailPage />} />
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
                <Route path="stir"     element={<StirSummaryPage />} />
                <Route path="dids"     element={<DIDSearchPage />} />
              </Route>
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
