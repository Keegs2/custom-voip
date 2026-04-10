import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { RcfPage } from './pages/RcfPage';
import { ApiDidsPage } from './pages/ApiDidsPage';
import { TrunksPage } from './pages/TrunksPage';
import { IvrBuilderPage } from './pages/IvrBuilderPage';
import { DocsPage } from './pages/DocsPage';
import { TroubleshootingPage } from './pages/TroubleshootingPage';
import { AdminPage } from './pages/admin/AdminPage';
import { CustomersAdminPage } from './pages/admin/CustomersAdminPage';
import { CustomerAccountPage } from './pages/admin/CustomerAccountPage';
import { CdrsAdminPage } from './pages/admin/CdrsAdminPage';
import { RatesAdminPage } from './pages/admin/RatesAdminPage';
import { TiersAdminPage } from './pages/admin/TiersAdminPage';
import { CarriersAdminPage } from './pages/admin/CarriersAdminPage';
import { SippAdminPage } from './pages/admin/SippAdminPage';
// Homer moved to standalone Troubleshooting page
import { TrunksAdminPage } from './pages/admin/TrunksAdminPage';
import { CallQualityPage } from './pages/CallQualityPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Routes wrapped in the sidebar layout */}
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="rcf"      element={<RcfPage />} />
          <Route path="api-dids" element={<ApiDidsPage />} />
          <Route path="trunks"   element={<TrunksPage />} />
          <Route path="docs"        element={<DocsPage />} />
          <Route path="call-quality" element={<CallQualityPage />} />
          {/* Customer account page — outside AdminPage wrapper for clean layout */}
          <Route path="admin/customers/:customerId" element={<CustomerAccountPage />} />

          {/* Admin nested routes */}
          <Route path="admin" element={<AdminPage />}>
            <Route index            element={<Navigate to="customers" replace />} />
            <Route path="customers" element={<CustomersAdminPage />} />
            <Route path="trunks"    element={<TrunksAdminPage />} />
            <Route path="cdrs"      element={<CdrsAdminPage />} />
            <Route path="rates"     element={<RatesAdminPage />} />
            <Route path="tiers"     element={<TiersAdminPage />} />
            <Route path="carriers"  element={<CarriersAdminPage />} />
            <Route path="sipp"      element={<SippAdminPage />} />
          </Route>
        </Route>

        {/* Full-screen pages — outside AppLayout (no max-width/padding) */}
        <Route path="ivr" element={<IvrBuilderPage />} />
        <Route path="troubleshooting" element={<TroubleshootingPage />} />

        {/* Catch-all redirect to home */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
