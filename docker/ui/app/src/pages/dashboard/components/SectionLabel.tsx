/**
 * SectionLabel — the small uppercase blue eyebrow above each dashboard section.
 */

import type { ReactNode } from 'react';
import { sectionLabel } from '../styles';

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div style={sectionLabel}>{children}</div>;
}
