/**
 * DropdownOption — one selectable available-TN row in the DID search dropdown.
 * Owns only its hover state (visual). Uses mousedown so selection fires before
 * the input's blur closes the dropdown.
 */

import { useState } from 'react';
import { GLASS } from '../../../../components/glass/glass';
import { MONO, dropdownOption } from '../styles';
import type { AvailableTN } from '../types';

interface DropdownOptionProps {
  tn: AvailableTN;
  highlighted: boolean;
  onSelect: (tn: AvailableTN) => void;
}

export function DropdownOption({ tn, highlighted, onSelect }: DropdownOptionProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect(tn);
      }}
      style={dropdownOption(highlighted || hovered)}
    >
      <span style={{ fontFamily: MONO, fontSize: '0.82rem', color: GLASS.text, minWidth: 130 }}>{tn.tn}</span>
      <span style={{ fontSize: '0.75rem', color: GLASS.textMuted }}>
        {tn.city}, {tn.state}
      </span>
    </div>
  );
}
