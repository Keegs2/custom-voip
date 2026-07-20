/**
 * ShellTab — a single glass tab in the admin shell's tab bar. Owns only its own
 * hover state (visual). The active flag is computed by the parent and passed in.
 *
 * React #310: the single hook sits at the very top, before any return.
 */

import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { tabLink, tabActiveDot } from '../styles';

interface ShellTabProps {
  label: string;
  to: string;
  active: boolean;
}

export function ShellTab({ label, to, active }: ShellTabProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <NavLink
      to={to}
      role="tab"
      aria-selected={active}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={tabLink(active, hovered)}
    >
      {active && <span style={tabActiveDot} aria-hidden="true" />}
      {label}
    </NavLink>
  );
}
