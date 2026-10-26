/**
 * Guides overview — /docs/guides. Two balanced rows (docker/ui/CLAUDE.md §20):
 *
 *   ┌ RCF ─────────┐ ┌ Visual Voicemail ┐ ┌ IVR ─────────┐   what each product does,
 *   │ …  Open guide│ │ …     Open guide │ │ …  Open guide│   where it lives, a link in
 *   └──────────────┘ └──────────────────┘ └──────────────┘
 *   ┌ Find your way around ──────────┐ ┌ Access & help ─────┐
 *   └────────────────────────────────┘ └────────────────────┘
 *
 * Static copy (no API calls): it reads the same for every customer, and each
 * product card says how that product is switched on. Reliability is
 * described generically, as the owner's public-copy rules require.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { BalancedGrid } from '../../../components/layout/kit';
import { IconIVR, IconRCF, IconVoicemail } from '../../../components/icons/ProductIcons';
import { Path, Ui } from './GuideKit';
import { guideHref, type GuideTopic } from './guideTopics';

interface ProductCard {
  topic: GuideTopic;
  name: string;
  icon: ReactNode;
  /** How the product reaches an account. */
  availability: string;
  what: string;
  can: readonly ReactNode[];
  where: readonly string[];
}

const PRODUCTS: readonly ProductCard[] = [
  {
    topic: 'rcf',
    name: 'RCF',
    icon: <IconRCF size={18} />,
    availability: 'Call forwarding',
    what: 'Each of your numbers rings the destination you choose.',
    can: [
      'Change where a number rings, and for how long',
      'Pause and resume forwarding',
      'Show the caller’s number or your own',
      'Request new numbers and releases',
    ],
    where: ['Products', 'RCF'],
  },
  {
    topic: 'voicemail',
    name: 'Visual Voicemail',
    icon: <IconVoicemail size={18} />,
    availability: 'Turned on by Granite',
    what: 'Voicemail you manage in the browser. Each mailbox has its own number.',
    can: [
      'Play, save and download messages',
      'Record or upload greetings',
      'Read transcripts, when Granite turns them on',
      'Messages are encrypted at rest',
    ],
    where: ['Products', 'Visual Voicemail'],
  },
  {
    topic: 'ivr',
    name: 'IVR',
    icon: <IconIVR size={18} />,
    availability: 'Turned on by Granite',
    what: 'Answer calls with a menu you design on a canvas.',
    can: [
      'Greet callers and offer a keypad menu',
      'Route by business hours or by caller',
      'Transfer to your numbers or voicemail',
      'Test a call before you publish',
    ],
    where: ['Products', 'IVR'],
  },
];

const PLACES: readonly { name: string; text: ReactNode }[] = [
  {
    name: 'Dashboard',
    text: (
      <>
        Your numbers, recent calls and call quality at a glance, with shortcuts such as <Ui>Request numbers</Ui> and{' '}
        <Ui>Open call activity</Ui>.
      </>
    ),
  },
  {
    name: 'Products',
    text: <>RCF, plus Visual Voicemail and IVR once they’re on for your account.</>,
  },
  {
    name: 'Insights',
    text: (
      <>
        <Ui>Reporting</Ui>: call reports for any period, as a spreadsheet (CSV) or a PDF summary.
      </>
    ),
  },
  {
    name: 'Support',
    text: (
      <>
        Read-only users only: <Ui>Call Quality</Ui>, your call records and how each call sounded.
      </>
    ),
  },
  {
    name: 'My Account',
    text: <>Your account details, the people on it, and your own name and password. Select your name at the bottom of the sidebar.</>,
  },
  {
    name: 'Coming Soon',
    text: <>Features on the way. Visual Voicemail and IVR move up to Products when they’re turned on for your account.</>,
  },
];

export function OverviewGuide() {
  return (
    <div className="gd-overview">
      <BalancedGrid columns="repeat(3, minmax(0, 1fr))" stackBelow="md" gap="var(--rcf-stack)" label="Products">
        {PRODUCTS.map((p) => (
          <section key={p.topic} className="dl-panel gd-panel gd-product" aria-labelledby={`gd-product-${p.topic}`}>
            <div className="gd-product-head">
              <span className="gd-product-icon" aria-hidden="true">
                {p.icon}
              </span>
              <div className="gd-product-id">
                <h2 id={`gd-product-${p.topic}`} className="gd-product-name">
                  {p.name}
                </h2>
                <span className="dl-tag dl-tag-slate">{p.availability}</span>
              </div>
            </div>
            <p className="gd-product-what">{p.what}</p>
            <ul className="gd-bullets gd-product-can">
              {p.can.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            <div className="gd-product-foot">
              <Path items={p.where} />
              <Link to={guideHref(p.topic)} className="gd-link">
                Open the guide <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </section>
        ))}
      </BalancedGrid>

      <BalancedGrid columns="minmax(0, 1.4fr) minmax(0, 1fr)" stackBelow="md" gap="var(--rcf-stack)">
        <section className="dl-panel gd-panel" aria-labelledby="gd-places">
          <div className="dl-panel-head gd-panel-head">
            <h2 id="gd-places" className="dl-panel-title gd-panel-title">
              Find your way around the sidebar
            </h2>
          </div>
          <dl className="gd-facts gd-places">
            {PLACES.map((p) => (
              <div key={p.name} className="gd-fact">
                <dt>{p.name}</dt>
                <dd>{p.text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="dl-panel gd-panel" aria-labelledby="gd-access">
          <div className="dl-panel-head gd-panel-head">
            <h2 id="gd-access" className="dl-panel-title gd-panel-title">
              Access &amp; help
            </h2>
          </div>
          <dl className="gd-facts">
            <div className="gd-fact">
              <dt>User</dt>
              <dd>Can change settings, manage voicemail, build IVR flows and request numbers.</dd>
            </div>
            <div className="gd-fact">
              <dt>Read-only</dt>
              <dd>Can see everything and listen to voicemail, but can’t change settings or request numbers.</dd>
            </div>
            <div className="gd-fact">
              <dt>Help</dt>
              <dd>
                Contact your Granite account team, or email <strong className="gd-strong">solutions@granitenet.com</strong>{' '}
                with the number and the time of the call.
              </dd>
            </div>
            <div className="gd-fact">
              <dt>Reliability</dt>
              <dd>The service runs in redundant regions with automatic failover.</dd>
            </div>
          </dl>
        </section>
      </BalancedGrid>
    </div>
  );
}
