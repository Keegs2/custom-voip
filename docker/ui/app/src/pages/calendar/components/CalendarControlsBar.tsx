/**
 * CalendarControlsBar — the prev/today/next + title cluster, the optional
 * provider filter, and the Month / Week / Agenda view switcher, all inside one
 * frosted glass panel. Stateless; driven entirely by props from the page.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import type { CalendarProvider } from '../../../types/calendar';
import { PROVIDER_META } from '../providerMeta';
import type { CalViewKey, ProviderFilter } from '../types';
import { VIEW_OPTIONS } from '../types';
import {
  controlsRow,
  navCluster,
  navIconBtn,
  navTitle,
  segBtn,
  segGroup,
  spinner,
  todayBtn,
} from '../styles';

interface CalendarControlsBarProps {
  title: string;
  view: CalViewKey;
  onChangeView: (key: CalViewKey) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  providerFilter: ProviderFilter;
  onProviderFilter: (p: ProviderFilter) => void;
  connectedProviders: CalendarProvider[];
  busy: boolean;
}

function NavIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={navIconBtn}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = GLASS.text;
        e.currentTarget.style.borderColor = hexToRgba(GLASS.accent, 0.45);
        e.currentTarget.style.background = hexToRgba(GLASS.accent, 0.1);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = GLASS.textMuted;
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
      }}
    >
      {children}
    </button>
  );
}

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} style={segBtn(active)}>
      {children}
    </button>
  );
}

export function CalendarControlsBar({
  title,
  view,
  onChangeView,
  onPrev,
  onNext,
  onToday,
  providerFilter,
  onProviderFilter,
  connectedProviders,
  busy,
}: CalendarControlsBarProps) {
  return (
    <GlassPanel padding="14px 16px">
      <div style={controlsRow}>
        {/* prev / today / next + title */}
        <div style={navCluster}>
          <NavIconButton label="Previous" onClick={onPrev}>
            <ChevronLeft size={16} />
          </NavIconButton>
          <button type="button" onClick={onToday} style={todayBtn}>
            Today
          </button>
          <NavIconButton label="Next" onClick={onNext}>
            <ChevronRight size={16} />
          </NavIconButton>
          <span style={navTitle}>{title}</span>
          {busy && <span style={spinner()} />}
        </div>

        <div style={{ flex: 1 }} />

        {/* Provider filter — only when more than one provider is connected */}
        {connectedProviders.length > 1 && (
          <div style={segGroup}>
            <SegButton active={providerFilter === 'all'} onClick={() => onProviderFilter('all')}>
              All
            </SegButton>
            {connectedProviders.map((p) => (
              <SegButton key={p} active={providerFilter === p} onClick={() => onProviderFilter(p)}>
                {PROVIDER_META[p].short}
              </SegButton>
            ))}
          </div>
        )}

        {/* View switcher */}
        <div style={segGroup}>
          {VIEW_OPTIONS.map((opt) => (
            <SegButton key={opt.key} active={view === opt.key} onClick={() => onChangeView(opt.key)}>
              {opt.label}
            </SegButton>
          ))}
        </div>
      </div>
    </GlassPanel>
  );
}
