/**
 * ThemeToggle — the light/dark switch for the signed-in app.
 *
 * One real <button> in three seats (all styled in styles/app-shell.css):
 *   - 'sidebar' : the user footer's action row, beside Sign out — icon +
 *                 visible text ("Switch to dark")
 *   - 'topbar'  : the mobile topbar, right edge (40px touch target, icon)
 *   - 'edge'    : a slim tab under the collapse tab while the desktop
 *                 sidebar is collapsed (the footer is off-canvas then; icon)
 *
 * The icon shows where the click takes you (sun = go light, moon = go
 * dark) and the accessible name says it in words: "Switch to dark theme"
 * (it contains the visible text, WCAG 2.5.3).
 */
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

export interface ThemeToggleProps {
  placement: 'sidebar' | 'topbar' | 'edge';
}

const CLASS_BY_PLACEMENT: Record<ThemeToggleProps['placement'], string> = {
  sidebar: 'sb-action sb-theme-toggle',
  topbar: 'sb-iconbtn sb-theme-toggle',
  edge: 'theme-edge-tab',
};

export function ThemeToggle({ placement }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} theme`;
  const Icon = next === 'light' ? Sun : Moon;
  const size = placement === 'topbar' ? 18 : placement === 'edge' ? 14 : 13;

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={placement === 'sidebar' ? undefined : label}
      className={CLASS_BY_PLACEMENT[placement]}
    >
      <Icon size={size} strokeWidth={2} aria-hidden="true" />
      {placement === 'sidebar' && <span>Switch to {next}</span>}
    </button>
  );
}
