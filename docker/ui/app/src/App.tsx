import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { RequireAuth } from './components/auth/RequireAuth';
import { RequireAdmin } from './components/auth/RequireAdmin';
import { RequireSupportOrAdmin } from './components/auth/RequireSupportOrAdmin';
import { AppLayout } from './components/layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { RcfPage } from './pages/RcfPage';
import { ApiDidsPage } from './pages/ApiDidsPage';
import { TrunksPage } from './pages/TrunksPage';
import { IvrBuilderPage } from './pages/IvrBuilderPage';
import { VisualVoicemailPage } from './pages/VisualVoicemailPage';
import { GuidesPage } from './pages/docs/GuidesPage';
import { ApiDocsPage } from './pages/docs/ApiDocsPage';
import { TroubleshootingPage } from './pages/TroubleshootingPage';
import { CdrsAdminPage } from './pages/admin/CdrsAdminPage';
import { PaymentsDemoControlPage } from './pages/admin/payments-demo/PaymentsDemoControlPage';
import { CallQualityPage } from './pages/CallQualityPage';
import { MyAccountPage } from './pages/MyAccountPage';

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
              <Route path="documentation" element={<Navigate to="/docs/guides" replace />} />
              {/* Old bookmark: the standalone RCF guide is now the Guides hub's RCF tab */}
              <Route path="docs/rcf"                element={<Navigate to="/docs/guides/rcf" replace />} />
              <Route path="docs/guides/:product?"   element={<GuidesPage />} />
              <Route path="docs/api/:product?"      element={<ApiDocsPage />} />
              <Route path="docs/integration"        element={<Navigate to="/docs/api" replace />} />
              <Route path="call-quality" element={<CallQualityPage />} />
              {/* Standalone CDR search — admin + support roles. Platform +
                  customer administration now lives in TED (the CRAG console);
                  the revup /admin tree was removed, but CDR Search stays here
                  as a support-facing tool. */}
              <Route
                path="cdrs"
                element={
                  <RequireSupportOrAdmin>
                    <CdrsAdminPage standalone />
                  </RequireSupportOrAdmin>
                }
              />
              {/* Old bookmarks: the standalone Account Settings page is retired —
                  its content lives in MyAccountPage's "Your Account" tab. */}
              <Route path="account"          element={<Navigate to="/my-account" replace />} />
              <Route path="my-account"       element={<MyAccountPage />} />

              {/* Old bookmark: the platform CDRs tab is now the standalone /cdrs page. */}
              <Route path="admin/platform/cdrs" element={<Navigate to="/cdrs" replace />} />

              {/* Machine Payments Demo — standalone daylight page (no tab shell).
                  The only surviving /admin route; the rest moved to TED. */}
              <Route
                path="admin/payments-demo"
                element={
                  <RequireAdmin>
                    <PaymentsDemoControlPage />
                  </RequireAdmin>
                }
              />
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
