/**
 * ProductSelector — the icon-led product rail shared by the two documentation
 * pages (Guides hub at /docs/guides/:product?, API Reference at
 * /docs/api/:product?). Deep-linkable: the active card mirrors the URL param
 * and selecting a card navigates, so links share.
 *
 * Styling: `dlx8-` primitives in src/styles/dl-docs.css (daylight system).
 */

import {
  IconRCF, IconTrunk, IconAPI, IconVoicemail, IconSignal,
} from '../../components/icons/ProductIcons';
import type { GuideProduct, ApiProduct } from './docProducts';

import '../../styles/dl-docs.css';

/* ─── Card metadata ──────────────────────────────────────── */

type DocProduct = GuideProduct | ApiProduct;

interface ProductCardDef {
  name: string;
  tag?: 'Early access' | 'Coming soon';
  icon: React.ReactNode;
  /** One-liner under the name — kept short so four cards sit level. */
  blurb: string;
}

const CARDS: Record<DocProduct, ProductCardDef> = {
  rcf: {
    name: 'RCF',
    icon: <IconRCF size={18} />,
    blurb: 'Remote Call Forwarding — numbers that forward anywhere.',
  },
  trunking: {
    name: 'SIP Trunking',
    icon: <IconTrunk size={18} />,
    blurb: 'IP-authenticated trunks for your PBX or SBC.',
  },
  calling: {
    name: 'API Calling',
    tag: 'Early access',
    icon: <IconAPI size={18} />,
    blurb: 'Programmable voice — place and control calls over REST.',
  },
  voicemail: {
    name: 'Visual Voicemail',
    tag: 'Coming soon',
    icon: <IconVoicemail size={18} />,
    blurb: 'Browser-first voicemail with transcription.',
  },
  telemetry: {
    name: 'CDRs & Telemetry',
    icon: <IconSignal size={18} />,
    blurb: 'Call records with per-call quality metrics.',
  },
};

/* ─── Component ──────────────────────────────────────────── */

export function ProductSelector<P extends DocProduct>({
  products,
  active,
  onSelect,
}: {
  products: readonly P[];
  active: P;
  onSelect: (product: P) => void;
}) {
  return (
    <div className="dlx8-selector" role="tablist" aria-label="Product">
      {products.map(p => {
        const def = CARDS[p];
        const isActive = p === active;
        return (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={isActive ? 'dlx8-pcard dlx8-pcard-active' : 'dlx8-pcard'}
            onClick={() => onSelect(p)}
          >
            <span className="dlx8-pcard-mark" aria-hidden="true" />
            <span className="dlx8-pcard-icon" aria-hidden="true">{def.icon}</span>
            <span className="dlx8-pcard-name-row">
              <span className="dlx8-pcard-name">{def.name}</span>
              {def.tag && <span className="dlx-tag-warn">{def.tag}</span>}
            </span>
            <span className="dlx8-pcard-desc">{def.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}
