import { CdrsTab } from './CdrsTab';

interface CdrsAdminPageProps {
  /**
   * When true, the page owns its daylight canvas (`dl-scope` + `dl-shell` +
   * quiet header) — used by the standalone /cdrs route (admin + support).
   * Default false: the /admin/platform/cdrs tab renders inside
   * PlatformManagementPage's shell, which owns the canvas, so the tab
   * contributes content only (double-shelling would break the layout).
   */
  standalone?: boolean;
}

export function CdrsAdminPage({ standalone = false }: CdrsAdminPageProps) {
  if (!standalone) return <CdrsTab />;

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        {/* ── Quiet page header — mirrors the PlatformManagementPage idiom ── */}
        <header className="dl-header fx-load">
          <div className="dl-header-id">
            <div className="dl-crumb">
              <span>Support</span>
              <span className="dl-crumb-sep" aria-hidden="true">/</span>
              <span>Granite CRAG</span>
            </div>
            <h1 className="dl-title">CDR Search</h1>
            <p className="dl-sub">
              Platform-wide call detail records — search, inspect, export.
            </p>
          </div>
        </header>

        <div className="fx-load fx-load-d1">
          <CdrsTab />
        </div>
      </div>
    </div>
  );
}
