/**
 * Calendar — Unified Comms (v1, read-only). Liquid-glass (blue) reskin.
 *
 * THIN page: composition + top-level state only. All data fetching, mutations,
 * the OAuth-return effect, and the imperative FullCalendar wiring live in
 * `./calendar/hooks`; styles in `./calendar/styles`; presentational pieces in
 * `./calendar/components`. See docs/FRONTEND_GLASS_REFACTOR.md.
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout — this page does
 * NOT mount its own; it builds glass surfaces on top. The page top offset +
 * gutters come from AppLayout's central padding (no top padding re-applied here).
 *
 * React #310: every hook sits unconditionally at the top, before any early
 * return. The events query is gated with `enabled` inside the data hook, never a
 * conditional hook call.
 */
import { useCallback, useState } from 'react';
import type { EventClickArg } from '@fullcalendar/core';

import { useAuth } from '../contexts/AuthContext';
import { GLASS } from '../components/glass/glass';
import type { CalendarEvent } from '../types/calendar';
import { useCalendarData, useCalendarView } from './calendar/hooks';
import type { ProviderFilter } from './calendar/types';
import { heroBadge, heroEmail, heroSubtitle, heroTitle } from './calendar/styles';
import { CalendarControlsBar } from './calendar/components/CalendarControlsBar';
import { CalendarLegend } from './calendar/components/CalendarLegend';
import { CalendarSurface } from './calendar/components/CalendarSurface';
import { CalendarConnectCard } from './calendar/components/CalendarConnectCard';
import { CalendarEmptyState } from './calendar/components/CalendarEmptyState';
import { EventDetailPanel } from './calendar/components/EventDetailPanel';
import {
  CalendarLoading,
  ConnectionsErrorCard,
  ProviderWarningBanner,
} from './calendar/components/states';

export function CalendarPage() {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const { user } = useAuth();
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  const cal = useCalendarView();
  const data = useCalendarData({ range: cal.range, providerFilter });

  const handleEventClick = useCallback((arg: EventClickArg) => {
    // Single typed cast at the lib boundary: the full CalendarEvent rides along
    // in extendedProps.raw (see fcEvents in hooks.ts).
    const raw = arg.event.extendedProps['raw'] as CalendarEvent;
    setSelectedEvent(raw);
  }, []);

  return (
    <>
      {/* Hero */}
      <header style={{ marginBottom: 32 }}>
        <div style={heroBadge()}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: GLASS.accent, boxShadow: `0 0 8px ${GLASS.accent}` }} />
          <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GLASS.accent }}>
            Unified Comms · Calendar
          </span>
        </div>
        <h1 style={heroTitle()}>Calendar</h1>
        {user?.email && <div style={heroEmail()}>{user.email}</div>}
        <p style={heroSubtitle}>
          View your Google and Microsoft 365 calendars in one place — read-only, private, and always in sync.
        </p>
      </header>

      {/* States → content */}
      {data.isInitialLoading ? (
        <CalendarLoading />
      ) : data.isConnectionsError ? (
        <ConnectionsErrorCard />
      ) : !data.hasConnections ? (
        <CalendarEmptyState onConnect={data.handleConnect} connecting={data.connecting} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <CalendarConnectCard
            connections={data.connections}
            providerResults={data.providerResults}
            onConnect={data.handleConnect}
            onDisconnect={data.handleDisconnect}
            connecting={data.connecting}
            disconnecting={data.disconnecting}
          />

          <ProviderWarningBanner warnings={data.providerWarnings} />

          <CalendarControlsBar
            title={cal.title}
            view={cal.view}
            onChangeView={cal.changeView}
            onPrev={cal.goPrev}
            onNext={cal.goNext}
            onToday={cal.goToday}
            providerFilter={providerFilter}
            onProviderFilter={setProviderFilter}
            connectedProviders={data.connectedProviders}
            busy={data.eventsIsFetching}
          />

          <CalendarLegend connectedProviders={data.connectedProviders} />

          <CalendarSurface
            calendarRef={cal.calendarRef}
            view={cal.view}
            fcEvents={data.fcEvents}
            onDatesSet={cal.handleDatesSet}
            onEventClick={handleEventClick}
            isError={data.eventsIsError}
          />
        </div>
      )}

      {/* Read-only detail slide-over — renders nothing when nothing is selected,
          but its hooks always run (declared at the top of the component). */}
      <EventDetailPanel event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </>
  );
}
