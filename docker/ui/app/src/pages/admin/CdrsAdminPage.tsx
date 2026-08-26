import { CdrsTab } from './CdrsTab';

interface CdrsAdminPageProps {
  /**
   * When true, the page owns its daylight canvas (`dl-scope` + `dl-shell` +
   * quiet header) — used by the standalone /cdrs route (admin + support),
   * the only live route since the /admin/platform tab shell moved to TED
   * (/admin/platform/cdrs now redirects here). Default false renders the
   * bare tab for embedding inside a shell that owns its own canvas.
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
            {/* The ONE page header — CdrsTab deliberately carries no second
                title so the hierarchy reads header → filter card → results.
                Visibility scope (tenant vs platform) is enforced by the API. */}
            <h1 className="dl-title">CDR Search</h1>
            <p className="dl-sub">
              Call detail records — search, inspect, export.
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
