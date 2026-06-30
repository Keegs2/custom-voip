/**
 * CalendarSurface — the frosted glass panel that holds the FullCalendar grid
 * (or a glass error state when the events range fails to load). The dark-themed
 * FullCalendar CSS (scoped under `.rv-calendar`) is imported here.
 */

import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import type { DatesSetArg, EventClickArg, EventInput } from '@fullcalendar/core';

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { stateIcon } from '../styles';
import '../fullcalendar-theme.css';

interface CalendarSurfaceProps {
  calendarRef: React.MutableRefObject<FullCalendar | null>;
  view: 'dayGridMonth' | 'timeGridWeek' | 'listWeek';
  fcEvents: EventInput[];
  onDatesSet: (arg: DatesSetArg) => void;
  onEventClick: (arg: EventClickArg) => void;
  isError: boolean;
}

export function CalendarSurface({
  calendarRef,
  view,
  fcEvents,
  onDatesSet,
  onEventClick,
  isError,
}: CalendarSurfaceProps) {
  return (
    // overflow:visible so FullCalendar's "+N more" popover is never clipped.
    <GlassPanel padding={14} blur={20} style={{ overflow: 'visible' }}>
      {isError ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 12,
            padding: '40px 0',
          }}
        >
          <div style={stateIcon(GLASS.danger)}>
            <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" style={{ width: 26, height: 26 }}>
              <path d="M11 7v5M11 15.5v.01" />
              <circle cx="11" cy="11" r="9" />
            </svg>
          </div>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: GLASS.text }}>
            Couldn't load events for this range
          </div>
          <div style={{ fontSize: '0.82rem', color: GLASS.textMuted, maxWidth: 360, lineHeight: 1.5 }}>
            Try a different range or refresh the page.
          </div>
        </div>
      ) : (
        <div className="rv-calendar">
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, listPlugin]}
            initialView={view}
            headerToolbar={false}
            editable={false}
            selectable={false}
            dayMaxEvents={3}
            nowIndicator
            height={720}
            expandRows
            events={fcEvents}
            datesSet={onDatesSet}
            eventClick={onEventClick}
            eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
            noEventsContent="No events in this range"
          />
        </div>
      )}
    </GlassPanel>
  );
}
