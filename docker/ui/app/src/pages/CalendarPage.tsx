/**
 * Calendar — Unified Comms (v1, read-only).
 *
 * Connect Google Calendar and/or Microsoft 365, then view a unified, read-only
 * calendar (month / week / agenda). Built to the canonical contract in
 * `docs/CALENDAR_INTEGRATION_PLAN.md` §2/§4.
 *
 * React #310: every hook is declared unconditionally at the top, before any
 * early return. The events query is gated with `enabled`, never a conditional
 * hook. The mobile-default view is chosen in the useState initializer via
 * matchMedia (not a conditional hook).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import type { DatesSetArg, EventClickArg, EventInput } from '@fullcalendar/core';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

import { PortalHeader } from './RcfPage';
import { Spinner } from '../components/ui/Spinner';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import { ApiError } from '../api/client';
import {
  disconnect,
  getConnectUrl,
  listConnections,
  listEvents,
} from '../api/calendar';
import type { CalendarEvent, CalendarProvider } from '../types/calendar';
import { CalendarConnectCard } from './calendar/CalendarConnectCard';
import { CalendarEmptyState } from './calendar/CalendarEmptyState';
import { EventDetailPanel } from './calendar/EventDetailPanel';
import { ALL_PROVIDERS, PROVIDER_META } from './calendar/providerMeta';
import './calendar/fullcalendar-theme.css';

/* ─── View model ────────────────────────────────────────────────────────── */

type CalViewKey = 'dayGridMonth' | 'timeGridWeek' | 'listWeek';

const VIEW_OPTIONS: { key: CalViewKey; label: string }[] = [
  { key: 'dayGridMonth', label: 'Month' },
  { key: 'timeGridWeek', label: 'Week' },
  { key: 'listWeek', label: 'Agenda' },
];

type ProviderFilter = CalendarProvider | 'all';

interface DateRange {
  start: string | null;
  end: string | null;
}

/** Returns the default view; mobile starts on the agenda (list) view. */
function initialView(): CalViewKey {
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches) {
    return 'listWeek';
  }
  return 'dayGridMonth';
}

/** Friendly text for a calendar_error code returned by the OAuth callback. */
function humanizeOAuthError(code: string): string {
  switch (code) {
    case 'denied':
      return 'access was denied';
    case 'state_invalid':
      return 'the sign-in link expired — please try again';
    case 'exchange_failed':
      return 'we could not complete the sign-in';
    case 'provider_error':
      return 'the provider returned an error';
    default:
      return code;
  }
}

/* ─── Small inline controls ─────────────────────────────────────────────── */

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
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: '0.76rem',
        fontWeight: active ? 700 : 500,
        color: active ? '#06231f' : '#94a3b8',
        background: active
          ? 'linear-gradient(135deg, #2dd4bf 0%, #14b8a6 100%)'
          : 'transparent',
        boxShadow: active ? '0 2px 10px -3px rgba(45,212,191,0.6)' : 'none',
        transition: 'background 0.15s, color 0.15s',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
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
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        borderRadius: 8,
        border: '1px solid rgba(42,47,69,0.7)',
        background: 'rgba(15,17,23,0.6)',
        color: '#94a3b8',
        cursor: 'pointer',
        padding: 0,
        transition: 'color 0.15s, border-color 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = '#e2e8f0';
        e.currentTarget.style.borderColor = 'rgba(45,212,191,0.45)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = '#94a3b8';
        e.currentTarget.style.borderColor = 'rgba(42,47,69,0.7)';
      }}
    >
      {children}
    </button>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────── */

export function CalendarPage() {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const { user } = useAuth();
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const calendarRef = useRef<FullCalendar | null>(null);
  const oauthHandledRef = useRef<string | null>(null);

  const [view, setView] = useState<CalViewKey>(initialView);
  const [title, setTitle] = useState('');
  const [range, setRange] = useState<DateRange>({ start: null, end: null });
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [connecting, setConnecting] = useState<CalendarProvider | null>(null);

  const connectionsQuery = useQuery({
    queryKey: ['calendar', 'connections'],
    queryFn: listConnections,
  });
  const connections = useMemo(
    () => connectionsQuery.data ?? [],
    [connectionsQuery.data],
  );

  const eventsQuery = useQuery({
    queryKey: [
      'calendar',
      'events',
      { start: range.start, end: range.end, provider: providerFilter },
    ],
    queryFn: () =>
      listEvents({
        start: range.start as string,
        end: range.end as string,
        provider: providerFilter === 'all' ? undefined : providerFilter,
      }),
    enabled: connections.length > 0 && range.start !== null && range.end !== null,
    placeholderData: keepPreviousData,
  });

  const disconnectMutation = useMutation({
    mutationFn: (provider: CalendarProvider) => disconnect(provider),
    onSuccess: (_data, provider) => {
      toastOk(`${PROVIDER_META[provider].short} disconnected`);
      void queryClient.invalidateQueries({ queryKey: ['calendar', 'connections'] });
      void queryClient.invalidateQueries({ queryKey: ['calendar', 'events'] });
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // ── OAuth return handling: toast + invalidate + clean the URL ──
  useEffect(() => {
    const connected = searchParams.get('calendar_connected');
    const error = searchParams.get('calendar_error');
    if (!connected && !error) return;

    const key = `${connected ?? ''}|${error ?? ''}`;
    if (oauthHandledRef.current === key) return;
    oauthHandledRef.current = key;

    if (connected) {
      const meta = PROVIDER_META[connected as CalendarProvider];
      toastOk(`${meta ? meta.label : connected} connected`);
    } else if (error) {
      toastErr(`Calendar connection failed — ${humanizeOAuthError(error)}.`);
    }
    void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    navigate('/calendar', { replace: true });
  }, [searchParams, navigate, queryClient, toastOk, toastErr]);

  // ── Handlers ──
  const handleConnect = useCallback(
    async (provider: CalendarProvider) => {
      setConnecting(provider);
      try {
        const { authorize_url } = await getConnectUrl(provider, '/calendar');
        // Full-page redirect into the provider's OAuth consent screen.
        window.location.assign(authorize_url);
      } catch (err) {
        setConnecting(null);
        toastErr(
          err instanceof ApiError
            ? err.message
            : 'Could not start the connection. Please try again.',
        );
      }
    },
    [toastErr],
  );

  const handleDisconnect = useCallback(
    (provider: CalendarProvider) => {
      if (
        !window.confirm(
          `Disconnect ${PROVIDER_META[provider].label}? Calendar access will be revoked.`,
        )
      ) {
        return;
      }
      disconnectMutation.mutate(provider);
    },
    [disconnectMutation],
  );

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    // arg.start/end are Date objects; toISOString() yields tz-aware (UTC) ISO,
    // which the backend requires (date-only startStr would be rejected).
    setRange({ start: arg.start.toISOString(), end: arg.end.toISOString() });
    setTitle(arg.view.title);
  }, []);

  const handleEventClick = useCallback((arg: EventClickArg) => {
    // Single typed cast at the lib boundary: the full CalendarEvent rides along
    // in extendedProps.raw (see fcEvents below).
    const raw = arg.event.extendedProps['raw'] as CalendarEvent;
    setSelectedEvent(raw);
  }, []);

  const changeView = useCallback((key: CalViewKey) => {
    setView(key);
    calendarRef.current?.getApi().changeView(key);
  }, []);

  const goPrev = useCallback(() => calendarRef.current?.getApi().prev(), []);
  const goNext = useCallback(() => calendarRef.current?.getApi().next(), []);
  const goToday = useCallback(() => calendarRef.current?.getApi().today(), []);

  // ── Derived values (after all hooks) ──
  const events = useMemo(
    () => eventsQuery.data?.events ?? [],
    [eventsQuery.data],
  );
  const providerResults = useMemo(
    () => eventsQuery.data?.providers ?? [],
    [eventsQuery.data],
  );

  const connectedProviders = useMemo(
    () => ALL_PROVIDERS.filter((p) => connections.some((c) => c.provider === p)),
    [connections],
  );

  const fcEvents: EventInput[] = useMemo(
    () =>
      events.map((ev) => {
        const color = ev.color ?? PROVIDER_META[ev.provider].color;
        return {
          id: ev.id,
          title: ev.title || 'Untitled event',
          start: ev.start,
          end: ev.end,
          allDay: ev.all_day,
          backgroundColor: `${color}33`,
          borderColor: color,
          textColor: '#e2e8f0',
          extendedProps: { raw: ev },
        };
      }),
    [events],
  );

  // Non-reauth provider failures (reauth is surfaced by the connections bar).
  const providerWarnings = useMemo(
    () =>
      providerResults.filter((p) => !p.ok && p.error !== 'needs_reauth'),
    [providerResults],
  );

  const isInitialLoading = connectionsQuery.isLoading;
  const hasConnections = connections.length > 0;

  return (
    <div style={{ paddingTop: 20 }}>
      <PortalHeader
        icon={<CalendarDays size={24} strokeWidth={1.8} />}
        title="Calendar"
        subtitle="View your Google and Microsoft 365 calendars in one place — read-only, private, and always in sync."
        badgeVariant="calendar"
        userEmail={user?.email}
      />

      {isInitialLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: '#718096',
            fontSize: '0.875rem',
            padding: '48px 0',
            justifyContent: 'center',
          }}
        >
          <Spinner size="sm" /> Loading your calendars…
        </div>
      )}

      {connectionsQuery.isError && (
        <div
          style={{
            padding: '16px 20px',
            borderRadius: 12,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.22)',
            color: '#f87171',
            fontSize: '0.875rem',
          }}
        >
          Unable to load your calendar connections. Please try refreshing the page.
        </div>
      )}

      {!isInitialLoading && !connectionsQuery.isError && !hasConnections && (
        <CalendarEmptyState onConnect={handleConnect} connecting={connecting} />
      )}

      {!isInitialLoading && !connectionsQuery.isError && hasConnections && (
        <>
          <CalendarConnectCard
            connections={connections}
            providerResults={providerResults}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            connecting={connecting}
            disconnecting={
              disconnectMutation.isPending
                ? disconnectMutation.variables ?? null
                : null
            }
          />

          {providerWarnings.length > 0 && (
            <div
              style={{
                padding: '10px 16px',
                marginBottom: 16,
                borderRadius: 10,
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.22)',
                color: '#f59e0b',
                fontSize: '0.78rem',
              }}
            >
              {providerWarnings
                .map((p) => `${PROVIDER_META[p.provider].short} events are temporarily unavailable`)
                .join(' · ')}
              .
            </div>
          )}

          {/* ── Controls row ── */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 12,
              marginBottom: 16,
            }}
          >
            {/* prev / today / next + title */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <NavIconButton label="Previous" onClick={goPrev}>
                <ChevronLeft size={16} />
              </NavIconButton>
              <button
                type="button"
                onClick={goToday}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  border: '1px solid rgba(42,47,69,0.7)',
                  background: 'rgba(15,17,23,0.6)',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: '0.76rem',
                  fontWeight: 600,
                }}
              >
                Today
              </button>
              <NavIconButton label="Next" onClick={goNext}>
                <ChevronRight size={16} />
              </NavIconButton>
              <span
                style={{
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  color: '#e2e8f0',
                  marginLeft: 6,
                  letterSpacing: '-0.01em',
                }}
              >
                {title}
              </span>
              {eventsQuery.isFetching && <Spinner size="xs" />}
            </div>

            <div style={{ flex: 1 }} />

            {/* Provider filter — only when more than one provider is connected */}
            {connectedProviders.length > 1 && (
              <div
                style={{
                  display: 'flex',
                  gap: 2,
                  padding: 3,
                  borderRadius: 10,
                  background: 'rgba(15,17,23,0.6)',
                  border: '1px solid rgba(42,47,69,0.7)',
                }}
              >
                <SegButton active={providerFilter === 'all'} onClick={() => setProviderFilter('all')}>
                  All
                </SegButton>
                {connectedProviders.map((p) => (
                  <SegButton
                    key={p}
                    active={providerFilter === p}
                    onClick={() => setProviderFilter(p)}
                  >
                    {PROVIDER_META[p].short}
                  </SegButton>
                ))}
              </div>
            )}

            {/* View switcher */}
            <div
              style={{
                display: 'flex',
                gap: 2,
                padding: 3,
                borderRadius: 10,
                background: 'rgba(15,17,23,0.6)',
                border: '1px solid rgba(42,47,69,0.7)',
              }}
            >
              {VIEW_OPTIONS.map((opt) => (
                <SegButton
                  key={opt.key}
                  active={view === opt.key}
                  onClick={() => changeView(opt.key)}
                >
                  {opt.label}
                </SegButton>
              ))}
            </div>
          </div>

          {/* Color legend */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginBottom: 14,
              flexWrap: 'wrap',
            }}
          >
            {connectedProviders.map((p) => (
              <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: PROVIDER_META[p].color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: '0.72rem', color: '#718096', fontWeight: 600 }}>
                  {PROVIDER_META[p].label}
                </span>
              </span>
            ))}
          </div>

          {/* Calendar */}
          <div
            className="rv-calendar"
            style={{
              background: 'rgba(19, 21, 29, 0.72)',
              border: '1px solid rgba(45, 212, 191, 0.16)',
              borderRadius: 16,
              padding: 16,
            }}
          >
            {eventsQuery.isError ? (
              <div style={{ padding: '48px 0', textAlign: 'center', color: '#f87171', fontSize: '0.85rem' }}>
                Unable to load events for this range. Try a different range or refresh.
              </div>
            ) : (
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
                datesSet={handleDatesSet}
                eventClick={handleEventClick}
                eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
                noEventsContent="No events in this range"
              />
            )}
          </div>
        </>
      )}

      {/* Read-only detail slide-over — renders nothing when nothing is selected,
          but its hooks always run (declared at the top of the component). */}
      <EventDetailPanel event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </div>
  );
}
