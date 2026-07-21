import { BrowserRouter, Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { SoftphoneProvider } from './contexts/SoftphoneContext';
import { ChatProvider } from './contexts/ChatContext';
import { RequireAuth } from './components/auth/RequireAuth';
import { RequireAdmin } from './components/auth/RequireAdmin';
import { RequireUcaas } from './components/auth/RequireUcaas';
import { RequireVoicemail } from './components/auth/RequireVoicemail';
import { RequireProgrammableVoice } from './components/auth/RequireProgrammableVoice';
import { RouteErrorBoundary } from './components/errors/RouteErrorBoundary';
import { AppLayout } from './components/layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { RcfPage } from './pages/RcfPage';
import { RcfGlassPage } from './pages/rcf-glass/RcfGlassPage';
import { TrunksPage } from './pages/TrunksPage';
import { CallFlowBuilderPage } from './pages/CallFlowBuilderPage';
// Public documentation — the /docs hub + one guide per product. These are
// static content surfaces (no auth-gated API calls), so they live OUTSIDE
// RequireAuth (inside AppLayout) exactly like the public `/` Dashboard, letting
// a logged-out prospect read every guide before creating an account.
import { DocsHubPage } from './pages/docs/DocsHubPage';
import { RcfDocsPage } from './pages/docs/RcfDocsPage';
import { ProgrammableVoiceDocsPage } from './pages/docs/ProgrammableVoiceDocsPage';
import { SipTrunkingDocsPage } from './pages/docs/SipTrunkingDocsPage';
import { UnifiedCommsDocsPage } from './pages/docs/UnifiedCommsDocsPage';
import { AiAgentsDocsPage } from './pages/docs/AiAgentsDocsPage';
import { TollFreeDocsPage } from './pages/docs/TollFreeDocsPage';
import { BillingDocsPage } from './pages/docs/BillingDocsPage';
import { PlatformDocsPage } from './pages/docs/PlatformDocsPage';
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
// Leapfrog wave — in-boundary AI voice agents, toll-free/RespOrg, least-cost outbound.
// All three are admin platform surfaces (RequireAdmin via the Platform shell).
import { AiAgentsAdminPage } from './pages/admin/AiAgentsAdminPage';
import { TollFreeAdminPage } from './pages/admin/TollFreeAdminPage';
import { LcoAdminPage } from './pages/admin/LcoAdminPage';
// Homer moved to standalone Troubleshooting page
import { TrunksAdminPage } from './pages/admin/TrunksAdminPage';
import { DIDSearchPage } from './pages/admin/DIDSearchPage';
import { UserDetailPage } from './pages/admin/UserDetailPage';
import { OnboardingAdminPage } from './pages/admin/OnboardingAdminPage';
import { CallQualityPage } from './pages/CallQualityPage';
import { AccountPage } from './pages/AccountPage';
// Payments demo — exec-facing monetary-system demo (docs/PAYMENTS_SYSTEM_DESIGN.md
// §9). Customer Billing & Payments page (any authenticated customer + admin), plus
// two admin surfaces: the Exec Demo Control Panel and the Revenue/Compliance
// dashboard (both RequireAdmin).
import { PaymentsPage } from './pages/payments/PaymentsPage';
import { PaymentsDemoControlPage } from './pages/admin/payments-demo/PaymentsDemoControlPage';
import { PaymentsDashboardPage } from './pages/admin/payments-demo/PaymentsDashboardPage';
// UCaaS communications pages — gated to ucaas/hybrid accounts via Sidebar nav (C-10).
import { CommunicationsPage } from './pages/CommunicationsPage';
import { ChatPage } from './pages/ChatPage';
import { ConferencePage } from './pages/ConferencePage';
import { CalendarPage } from './pages/CalendarPage';
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

            {/* Public documentation — the /docs hub + one guide per product.
                These are static content (no auth-gated API calls), so they live
                OUTSIDE RequireAuth (but inside AppLayout for the chrome), exactly
                like the public `/` Dashboard. A logged-out prospect can browse
                every guide before signing up. Product-access gating elsewhere is
                unaffected — docs are content only. */}
            <Route path="docs"                        element={<DocsHubPage />} />
            <Route path="docs/rcf"                    element={<RcfDocsPage />} />
            <Route path="docs/programmable-voice"     element={<ProgrammableVoiceDocsPage />} />
            <Route path="docs/sip-trunking"           element={<SipTrunkingDocsPage />} />
            <Route path="docs/unified-communications" element={<UnifiedCommsDocsPage />} />
            <Route path="docs/ai-agents"              element={<AiAgentsDocsPage />} />
            <Route path="docs/toll-free"              element={<TollFreeDocsPage />} />
            <Route path="docs/billing"                element={<BillingDocsPage />} />
            <Route path="docs/platform"               element={<PlatformDocsPage />} />
            {/* Redirects — old docs paths keep working. /docs/api → Programmable
                Voice (the API DIDs product merged into it); /documentation →
                the hub; /docs/integration → Programmable Voice. */}
            <Route path="documentation"     element={<Navigate to="/docs" replace />} />
            <Route path="docs/api"          element={<Navigate to="/docs/programmable-voice" replace />} />
            <Route path="docs/integration"  element={<Navigate to="/docs/programmable-voice" replace />} />

            {/* Protected — all other routes require authentication */}
            <Route element={<RequireAuth />}>
              <Route path="rcf"        element={<RcfPage />} />
              {/* Liquid-glass design-direction PROTOTYPE of the RCF page.
                  Same live data + same forward_to mutation as /rcf; the
                  original is untouched. Navigate directly to compare. */}
              <Route path="rcf-glass"  element={<RcfGlassPage />} />
              {/* API DIDs merged into Programmable Voice — the API numbers ARE the
                  programmable numbers. Old /api-dids links/bookmarks redirect. */}
              <Route path="api-dids"   element={<Navigate to="/programmable-voice" replace />} />
              <Route path="trunks"     element={<TrunksPage />} />
              {/* NOTE: the Universal Call Flow Builder (/flows) is routed
                  FULL-SCREEN, outside AppLayout (see below) — the node graph
                  needs the entire viewport, so it renders its own Sidebar
                  instead of living inside AppLayout's centered max-width box.
                  The /docs/* documentation routes moved OUT of RequireAuth (see
                  the public block above) so prospects can read them. */}
              <Route path="call-quality" element={<CallQualityPage />} />
              {/* Customer Billing & Payments — available to any authenticated
                  customer and to admins (payments is a universal surface, not an
                  account-type product). Reads the real ledger; the demo backend
                  drives it through simulation providers. */}
              <Route path="billing"          element={<PaymentsPage />} />
              <Route path="account"          element={<AccountPage />} />

              {/* UCaaS communications that live INSIDE AppLayout's content
                  column — these pages do NOT render their own Sidebar; they
                  rely on AppLayout's. Only surfaced in the sidebar for
                  ucaas/hybrid accounts (Sidebar gating, C-10). RCF customers
                  get no nav entry and no softphone chrome. The RequireUcaas
                  guard additionally blocks direct-URL access: an rcf (or any
                  non-UCaaS) user typing /communications, etc. is redirected to
                  the dashboard and renders ZERO UCaaS content.

                  NOTE: the full-screen UCaaS pages that render their OWN Sidebar
                  + SoftphoneWidget (chat, conference, documents, voicemail) are
                  routed OUTSIDE AppLayout below — putting them here double-wraps
                  them (second sidebar + AppLayout's centered max-width box),
                  which margins their content into the page center with a gap and
                  a right-edge overflow. */}
              <Route
                element={
                  <RequireUcaas>
                    <Outlet />
                  </RequireUcaas>
                }
              >
                <Route path="communications"  element={<CommunicationsPage />} />
                <Route path="calendar"        element={<CalendarPage />} />

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
                <Route index            element={<Navigate to="carriers" replace />} />
                <Route path="carriers"  element={<CarriersAdminPage />} />
                <Route path="cdrs"      element={<CdrsAdminPage />} />
                <Route path="rates"     element={<RatesAdminPage />} />
                <Route path="tiers"     element={<TiersAdminPage />} />
                <Route path="sipp"      element={<SippAdminPage />} />
                <Route path="dids"      element={<DIDSearchPage />} />
                {/* Leapfrog wave — admin-only (inherits RequireAdmin from this shell) */}
                <Route path="ai-agents" element={<AiAgentsAdminPage />} />
                <Route path="toll-free" element={<TollFreeAdminPage />} />
                <Route path="lco"       element={<LcoAdminPage />} />
              </Route>

              {/* Payments demo — admin surfaces. The Exec Demo Control Panel and
                  the Revenue/Compliance dashboard. Each is individually
                  RequireAdmin-wrapped (they are prominent nav items, not tabs of
                  an existing shell). /admin/payments redirects to the dashboard. */}
              <Route path="admin/payments" element={<Navigate to="/admin/payments/dashboard" replace />} />
              <Route
                path="admin/payments/control"
                element={
                  <RequireAdmin>
                    <PaymentsDemoControlPage />
                  </RequireAdmin>
                }
              />
              <Route
                path="admin/payments/dashboard"
                element={
                  <RequireAdmin>
                    <PaymentsDashboardPage />
                  </RequireAdmin>
                }
              />
            </Route>
          </Route>

          {/* Full-screen pages — outside AppLayout (no max-width/padding).
              Each full-screen page is wrapped in RouteErrorBoundary AFTER its
              guards: a render crash shows the recoverable fallback instead of
              white-screening the SPA (guards themselves are tiny and inert). */}
          <Route
            path="troubleshooting"
            element={
              <RequireAuth>
                <RouteErrorBoundary>
                  <TroubleshootingPage />
                </RouteErrorBoundary>
              </RequireAuth>
            }
          />

          {/* Universal Call Flow Builder — full-screen, outside AppLayout so the
              node graph fills the whole viewport (renders its own Sidebar). The
              legacy /ivr drag-and-drop builder was retired. Admin-gated:
              RequireAuth → RequireAdmin (RequireAdmin must sit inside RequireAuth). */}
          <Route
            path="flows"
            element={
              <RequireAuth>
                <RequireAdmin>
                  <RouteErrorBoundary>
                    <CallFlowBuilderPage />
                  </RouteErrorBoundary>
                </RequireAdmin>
              </RequireAuth>
            }
          />

          {/* Full-screen UCaaS pages — each renders its OWN Sidebar +
              SoftphoneWidget, so they live OUTSIDE AppLayout to avoid a second
              sidebar and AppLayout's centered max-width content box (the cause
              of the center-gap + right-overflow bug). Gating is fully preserved:
              RequireAuth (layout route) → RequireUcaas (children) — an rcf or
              any non-UCaaS user is still redirected to the dashboard and renders
              ZERO UCaaS content, exactly as when they were inside AppLayout.
              RouteErrorBoundary (which renders the Outlet) sits INSIDE the
              guard so a page crash degrades to the in-place fallback. */}
          <Route element={<RequireAuth />}>
            <Route
              element={
                <RequireUcaas>
                  <RouteErrorBoundary />
                </RequireUcaas>
              }
            >
              <Route path="chat"        element={<ChatPage />} />
              <Route path="conference"  element={<ConferencePage />} />
              <Route path="documents"   element={<DocumentsPage />} />
            </Route>

            {/* Voicemail — the standalone Visual Voicemail product. Gated by
                RequireVoicemail (voicemail_enabled === true OR UCaaS/admin),
                NOT RequireUcaas: the flagship voicemail-only customer carries
                only the `voicemail_enabled` entitlement, which the sidebar nav
                already honours — route guard and nav now share ONE predicate
                (components/auth/entitlements.ts). An rcf user with neither
                flag is still bounced to the dashboard. */}
            <Route
              element={
                <RequireVoicemail>
                  <RouteErrorBoundary />
                </RequireVoicemail>
              }
            >
              <Route path="voicemail" element={<VoicemailPage />} />
            </Route>
          </Route>

          {/* Catch-all redirect to home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ChatProvider>
        </SoftphoneProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
