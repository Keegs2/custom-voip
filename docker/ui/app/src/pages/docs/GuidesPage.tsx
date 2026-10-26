/**
 * Guides — the customer help hub (/docs/guides/:topic?).
 *
 * Customers only: an overview, then one guide per product — RCF, Visual
 * Voicemail, IVR — written from what a tenant `user` / `readonly` can see and
 * do today. Staff guides live elsewhere. Content: pages/docs/guides/*; rules
 * for editing it: docker/ui/CLAUDE.md §7 "Guides".
 *
 * Layout (docker/ui/CLAUDE.md §20): a one-row CompactHeader, the product
 * switcher as one slim row of cards, then the guide — tasks as expandable
 * rows beside "At a glance" + "Questions & fixes" (one balanced row).
 *
 * Routing: no slug = the overview; `rcf` / `voicemail` / `ivr` = a guide;
 * anything else (incl. the retired `trunking` / `calling` slugs) redirects to
 * the overview. `#<task id>` opens one task (GuideKit). No API calls.
 *
 * React #310: hooks (useParams) run unconditionally at the top.
 */
import { Navigate, useParams } from 'react-router-dom';
import { CompactHeader } from '../../components/layout/kit';
import { GuideSwitcher } from './guides/GuideSwitcher';
import { OverviewGuide } from './guides/OverviewGuide';
import { RcfGuide } from './guides/RcfGuide';
import { VoicemailGuide } from './guides/VoicemailGuide';
import { IvrGuide } from './guides/IvrGuide';
import { isGuideTopic, type GuideTopic, type GuideView } from './guides/guideTopics';

import '../../styles/dl-docs.css';
import '../../styles/dl-guides.css';

const GUIDES: Record<GuideTopic, () => React.ReactNode> = {
  rcf: RcfGuide,
  voicemail: VoicemailGuide,
  ivr: IvrGuide,
};

const TITLES: Record<GuideTopic, string> = {
  rcf: 'RCF guide',
  voicemail: 'Visual Voicemail guide',
  ivr: 'IVR guide',
};

export function GuidesPage() {
  // Hooks unconditionally at the top (React #310).
  const { product } = useParams<{ product: string }>();

  // Unknown slug → the overview (old bookmarks: /docs/guides/trunking, /calling).
  if (product !== undefined && !isGuideTopic(product)) {
    return <Navigate to="/docs/guides" replace />;
  }

  const active: GuideView = isGuideTopic(product) ? product : null;
  const Guide = active === null ? OverviewGuide : GUIDES[active];

  return (
    <div className="dl-scope dlx-docs gd-scope">
      <div className="dl-shell gd-shell">
        <CompactHeader
          className="fx-load"
          crumb={
            <>
              <span>Guides</span>
              <span className="dl-crumb-sep" aria-hidden="true">
                /
              </span>
              <span className="gd-crumb-tail">{active === null ? 'Overview' : TITLES[active]}</span>
            </>
          }
          title="Guides"
          subtitle="Step-by-step help for call forwarding (RCF), Visual Voicemail and IVR."
        />

        <div className="fx-load fx-load-d1">
          <GuideSwitcher active={active} />
          {/* Keyed by guide so open tasks reset on a switch. */}
          <div key={active ?? 'overview'} className="gd-body">
            <Guide />
          </div>
        </div>
      </div>
    </div>
  );
}
