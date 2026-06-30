/**
 * Data + view-state layer for the Calendar feature.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md) the page does
 * composition + top-level state only; all queries, mutations, the OAuth-return
 * effect, and the FullCalendar imperative wiring live here.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook. The events query is gated with
 * `enabled`, never a conditional hook call.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type FullCalendar from '@fullcalendar/react';
import type { DatesSetArg, EventInput } from '@fullcalendar/core';

import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../api/client';
import {
  disconnect,
  getConnectUrl,
  listConnections,
  listEvents,
} from '../../api/calendar';
import type { CalendarProvider } from '../../types/calendar';
import { ALL_PROVIDERS, PROVIDER_META } from './providerMeta';
import type { CalViewKey, DateRange, ProviderFilter } from './types';

/* ── Helpers ───────────────────────────────────────────────────────────────── */

/** Returns the default view; mobile starts on the agenda (list) view. */
export function initialView(): CalViewKey {
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

/* ── View hook — owns the imperative FullCalendar wiring ──────────────────────── */

export interface UseCalendarViewResult {
  calendarRef: React.MutableRefObject<FullCalendar | null>;
  view: CalViewKey;
  title: string;
  range: DateRange;
  handleDatesSet: (arg: DatesSetArg) => void;
  changeView: (key: CalViewKey) => void;
  goPrev: () => void;
  goNext: () => void;
  goToday: () => void;
}

/**
 * Owns the FullCalendar ref + the current view/title/visible-range, and the
 * imperative nav handlers. Kept out of the page so the page stays compositional.
 */
export function useCalendarView(): UseCalendarViewResult {
  const calendarRef = useRef<FullCalendar | null>(null);
  const [view, setView] = useState<CalViewKey>(initialView);
  const [title, setTitle] = useState('');
  const [range, setRange] = useState<DateRange>({ start: null, end: null });

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    // arg.start/end are Date objects; toISOString() yields tz-aware (UTC) ISO,
    // which the backend requires (date-only startStr would be rejected).
    setRange({ start: arg.start.toISOString(), end: arg.end.toISOString() });
    setTitle(arg.view.title);
  }, []);

  const changeView = useCallback((key: CalViewKey) => {
    setView(key);
    calendarRef.current?.getApi().changeView(key);
  }, []);

  const goPrev = useCallback(() => calendarRef.current?.getApi().prev(), []);
  const goNext = useCallback(() => calendarRef.current?.getApi().next(), []);
  const goToday = useCallback(() => calendarRef.current?.getApi().today(), []);

  return { calendarRef, view, title, range, handleDatesSet, changeView, goPrev, goNext, goToday };
}

/* ── Data hook — connections + events + connect/disconnect ────────────────────── */

export interface UseCalendarDataArgs {
  range: DateRange;
  providerFilter: ProviderFilter;
}

/**
 * Owns the connections + events queries, the disconnect mutation, the OAuth
 * return-handling effect, and every derived value the page renders. The page
 * passes its top-level `range` + `providerFilter` state in.
 */
export function useCalendarData({ range, providerFilter }: UseCalendarDataArgs) {
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const oauthHandledRef = useRef<string | null>(null);
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

  // ── Derived values ──
  const events = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data]);
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
    () => providerResults.filter((p) => !p.ok && p.error !== 'needs_reauth'),
    [providerResults],
  );

  return {
    connections,
    providerResults,
    connectedProviders,
    fcEvents,
    providerWarnings,
    isInitialLoading: connectionsQuery.isLoading,
    isConnectionsError: connectionsQuery.isError,
    hasConnections: connections.length > 0,
    eventsIsError: eventsQuery.isError,
    eventsIsFetching: eventsQuery.isFetching,
    connecting,
    disconnecting: disconnectMutation.isPending
      ? disconnectMutation.variables ?? null
      : null,
    handleConnect,
    handleDisconnect,
  };
}
