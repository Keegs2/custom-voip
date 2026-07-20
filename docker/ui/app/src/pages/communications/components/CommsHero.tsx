/**
 * The centered hero for the Communications hub: a frosted accent ring around
 * the headset glyph, a gradient title, and a supporting line. Purely
 * presentational; all styling comes from styles.ts.
 */

import { GLASS } from '../../../components/glass/glass';
import { heroWrap, heroIconRing, heroTitle, heroSubtitle } from '../styles';
import { IconHeadset } from './icons';

export function CommsHero() {
  return (
    <header style={heroWrap}>
      <div style={heroIconRing()}>
        <IconHeadset size={34} color={GLASS.accent} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <h1 style={heroTitle()}>Communications</h1>
        <p style={heroSubtitle}>
          Your unified communications hub — chat, meetings, documents, and voicemail.
        </p>
      </div>
    </header>
  );
}
