/**
 * GuideSwitcher — the Guides hub's product switcher: Overview · RCF · Visual
 * Voicemail · IVR as one row of equal, compact cards (2 × 2 on narrow
 * screens). Each card is a real link (deep-linkable, opens in a new tab with
 * a middle click); the current one carries `aria-current="page"`.
 *
 * The look is the docs product card's (`dlx8-pcard`, styles/dl-docs.css) —
 * surface, hairline, azure ring + solid icon tile when active — laid out
 * horizontally to stay one slim row (`gd-switch*`, styles/dl-guides.css).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { IconIVR, IconRCF, IconVoicemail } from '../../../components/icons/ProductIcons';
import { guideHref, type GuideView } from './guideTopics';

interface SwitchItem {
  view: GuideView;
  name: string;
  blurb: string;
  icon: ReactNode;
}

const ITEMS: readonly SwitchItem[] = [
  { view: null, name: 'Overview', blurb: 'Start here', icon: <BookOpen size={17} /> },
  { view: 'rcf', name: 'RCF', blurb: 'Call forwarding', icon: <IconRCF size={17} /> },
  { view: 'voicemail', name: 'Visual Voicemail', blurb: 'Messages and greetings', icon: <IconVoicemail size={17} /> },
  { view: 'ivr', name: 'IVR', blurb: 'Menus and call routing', icon: <IconIVR size={17} /> },
];

export function GuideSwitcher({ active }: { active: GuideView }) {
  return (
    <div className="gd-switch-host">
      <nav className="gd-switch" aria-label="Guides">
        {ITEMS.map((item) => {
          const on = item.view === active;
          return (
            <Link
              key={item.name}
              to={guideHref(item.view)}
              className={on ? 'gd-switch-card gd-switch-on' : 'gd-switch-card'}
              aria-current={on ? 'page' : undefined}
            >
              <span className="gd-switch-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="gd-switch-text">
                <span className="gd-switch-name">{item.name}</span>
                <span className="gd-switch-blurb">{item.blurb}</span>
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
