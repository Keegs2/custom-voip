/**
 * IvrBuilderPage — the visual IVR flow designer's portal page.
 *
 * The builder ships in Phase 2, so the page is a quiet daylight header plus a
 * composed coming-soon state — same copy and semantics as the original
 * placeholder, restyled into the shared DAYLIGHT CONSOLE system (`dl-*`
 * classes in index.css; page-scoped `dlx-*` in dl-portal-pages.css).
 *
 * React #310: every hook is called unconditionally at the top, before any
 * early return.
 */

import { useAuth } from '../contexts/AuthContext';
import { IconIVR } from '../components/icons/ProductIcons';
import '../styles/dl-portal-pages.css';

/* ─── Design tokens (mirror the .dl-scope CSS vars) ─── */
const INK = '#0e1726';
const INK_DIM = '#5d6f8c';

export function IvrBuilderPage() {
  // ── ALL hooks unconditionally at the top — React #310 guard ──
  useAuth(); // ensure authenticated

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        {/* Quiet page header — breadcrumb, calm title, one-line description */}
        <header className="dl-header fx-load">
          <div className="dl-header-id">
            <div className="dl-crumb">
              <span>IVR Builder</span>
              <span className="dl-crumb-sep" aria-hidden="true">/</span>
              <span>Granite CRAG</span>
            </div>
            <h1 className="dl-title">IVR Builder</h1>
            <p className="dl-sub">Visual drag-and-drop IVR flow designer.</p>
          </div>
        </header>

        {/* Coming-soon state */}
        <div className="dl-panel fx-load fx-load-d1">
          <div className="dl-center">
            <div className="dl-center-icon" aria-hidden="true">
              <IconIVR size={28} />
            </div>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: INK, margin: 0 }}>
              Coming in Phase 2
            </h2>
            <p
              style={{
                fontSize: '0.84rem',
                color: INK_DIM,
                maxWidth: 460,
                lineHeight: 1.6,
                margin: '0 0 8px',
              }}
            >
              Visual IVR flow builder with drag-and-drop nodes, DTMF menus,
              time-based routing, and webhook integration are under active development.
            </p>
            <div className="dl-tag" style={{ padding: '6px 14px', fontSize: '0.68rem' }}>
              Coming soon
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
