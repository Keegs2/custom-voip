import { BrowserRouter, Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { SoftphoneProvider } from './contexts/SoftphoneContext';
import { ChatProvider } from './contexts/ChatContext';
import { RequireAuth } from './components/auth/RequireAuth';
import { RequireAdmin } from './components/auth/RequireAdmin';
import { RequireUcaas } from './components/auth/RequireUcaas';
import { RequireProgrammableVoice } from './components/auth/RequireProgrammableVoice';
import { AppLayout } from './components/layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { RcfPage } from './pages/RcfPage';
import { ApiDidsPage } from './pages/ApiDidsPage';
import { TrunksPage } from './pages/TrunksPage';
import { IvrBuilderPage } from './pages/IvrBuilderPage';
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
import { SippAdminPage } from './pages/admin/SippAdminPage';
// Homer moved to standalone Troubleshooting page
import { TrunksAdminPage } from './pages/admin/TrunksAdminPage';
import { DIDSearchPage } from './pages/admin/DIDSearchPage';
import { UserDetailPage } from './pages/admin/UserDetailPage';
import { OnboardingAdminPage } from './pages/admin/OnboardingAdminPage';
import { CallQualityPage } from './pages/CallQualityPage';
import { AccountPage } from './pages/AccountPage';
// UCaaS communications pages — gated to ucaas/hybrid accounts via Sidebar nav (C-10).
import { CommunicationsPage } from './pages/CommunicationsPage';
import { ChatPage } from './pages/ChatPage';
import { ConferencePage } from './pages/ConferencePage';
import { DocumentsPage } from './pages/DocumentsPage';
import { VoicemailPage } from './pages/VoicemailPage';
// Phase 8 — net-new media/control surfaces. UCaaS ops (live calls, recordings,
// queues, media streams, live conferences) are gated by RequireUcaas; the
// programmable-voice config page is gated by RequireProgrammableVoice (api/hybrid).
import { RecordingsPage } from './pages/RecordingsPage';
import { LiveCallsPage } from './pages/LiveCallsPage';
import { MediaStreamsPage } from './pages/MediaStreamsPage';
import { LiveConferencesPage } from './pages/LiveConferencesPage';
import { QueuesPage } from './pages/QueuesPage';
import { ProgrammableVoicePage } from './pages/ProgrammableVoicePage';

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
        {/* SoftphoneProvider is inside AuthProvider so it can read auth state.
            For non-UCaaS (e.g. rcf) users the backend returns no WebRTC
            credentials, so the softphone stays dormant and renders nothing. */}
        <SoftphoneProvider>
        {/* ChatProvider is inside SoftphoneProvider — both depend on auth. */}
        <ChatProvider>
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
              <Route path="documentation" element={<Navigate to="/docs/rcf" replace />} />
              <Route path="docs/rcf"         element={<RcfDocsPage />} />
              <Route path="docs/api"         element={<ApiDocsPage />} />
              <Route path="docs/integration" element={<Navigate to="/docs/api" replace />} />
              <Route path="call-quality" element={<CallQualityPage />} />
              <Route path="account"          element={<AccountPage />} />

              {/* UCaaS communications — only surfaced in the sidebar for
                  ucaas/hybrid accounts (Sidebar gating, C-10). RCF customers
                  get no nav entry and no softphone chrome. The RequireUcaas
                  guard additionally blocks direct-URL access: an rcf (or any
                  non-UCaaS) user typing /chat, /conference, etc. is redirected
                  to the dashboard and renders ZERO UCaaS content. */}
              <Route
                element={
                  <RequireUcaas>
                    <Outlet />
                  </RequireUcaas>
                }
              >
                <Route path="communications"  element={<CommunicationsPage />} />
                <Route path="chat"            element={<ChatPage />} />
                <Route path="conference"      element={<ConferencePage />} />
                <Route path="documents"       element={<DocumentsPage />} />
                <Route path="voicemail"        element={<VoicemailPage />} />

                {/* Phase 8 — UCaaS media/control operations. Same RequireUcaas
                    gate as the rest of this subtree: an rcf (or any non-UCaaS)
                    user is redirected to the dashboard and renders ZERO of it. */}
                <Route path="live-calls"        element={<LiveCallsPage />} />
                <Route path="recordings"        element={<RecordingsPage />} />
                <Route path="queues"            element={<QueuesPage />} />
                <Route path="media-streams"     element={<MediaStreamsPage />} />
                <Route path="conferences/live"  element={<LiveConferencesPage />} />
              </Route>

              {/* Programmable-voice config — api/hybrid product feature, gated by
                  RequireProgrammableVoice (NOT RequireUcaas). RCF is excluded;
                  a direct-URL attempt redirects to the dashboard. */}
              <Route
                element={
                  <RequireProgrammableVoice>
                    <Outlet />
                  </RequireProgrammableVoice>
                }
              >
                <Route path="programmable-voice" element={<ProgrammableVoicePage />} />
              </Route>

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
                <Route path="sipp"     element={<SippAdminPage />} />
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
        </ChatProvider>
        </SoftphoneProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
