/**
 * SaveButton — the gradient submit button for an Account form. Owns its own
 * hover state (visual only); the accent re-tints the gradient + glow.
 *
 * React #310: the hover hook sits at the very top.
 */

import { useState } from 'react';
import { GLASS } from '../../../components/glass/glass';
import { submitBtn } from '../styles';

export function SaveButton({ saving, label, savingLabel, accent = GLASS.accent }: { saving: boolean; label: string; savingLabel: string; accent?: string }) {
  // ALL hooks first (React #310).
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="submit"
      disabled={saving}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={submitBtn(hovered, saving, accent)}
    >
      {saving ? savingLabel : label}
    </button>
  );
}
