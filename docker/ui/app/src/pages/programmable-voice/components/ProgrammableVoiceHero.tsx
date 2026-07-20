/**
 * ProgrammableVoiceHero — the page's title block. Left-aligned glass hero in the
 * app blue, mirroring the RcfGlass reference (no top margin; the layout owns the
 * top offset).
 */

import { IconAPI } from '../../../components/icons/ProductIcons';
import { GLASS } from '../../../components/glass/glass';
import { heroBadge, heroTitle, heroSubtitle } from '../styles';

export function ProgrammableVoiceHero({ title }: { title: string }) {
  return (
    <header style={{ marginBottom: 28 }}>
      <div style={heroBadge()}>
        <span style={{ display: 'inline-flex', color: GLASS.accent }}><IconAPI size={13} /></span>
        <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GLASS.accent }}>
          Programmable Voice
        </span>
      </div>
      <h1 style={heroTitle()}>{title}</h1>
      <p style={heroSubtitle}>
        Program your numbers with webhooks — inbound calls POST to your Voice URL and you return TwiML,
        with real-time status callbacks and a signing secret to verify every request.
      </p>
    </header>
  );
}
