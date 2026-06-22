/**
 * Calendar Integration types — Unified Comms (v1, read-only).
 *
 * These mirror the canonical API contract in
 * `docs/CALENDAR_INTEGRATION_PLAN.md` §2 VERBATIM. The backend builds to the
 * same contract; field names, enums and nullability must stay in lockstep.
 *
 * Reconciliations honored (do NOT revert to the earlier frontend-plan names):
 *  - ConnectionStatus = 'connected' | 'needs_reauth' | 'revoked'
 *  - organizer/attendee use `display_name` (+ `email`, both nullable)
 *  - organizer object and organizer.email are nullable
 *  - html_link: string | null
 *  - conferencing: { type, join_url } where type is google_meet | microsoft_teams
 *    | zoom | other | null (UI derives the label from type)
 *  - events response is { events, providers } — the providers[] partial-failure
 *    array MUST be consumed by the UI
 */

/** Calendar providers supported in v1 (direct OAuth, no aggregator). */
export type CalendarProvider = 'google' | 'microsoft';

/**
 * Connection lifecycle status.
 * `needs_reauth` is surfaced to the user as a "Reconnect" affordance.
 */
export type ConnectionStatus = 'connected' | 'needs_reauth' | 'revoked';

/** A single per-user provider connection (`GET /calendar/connections`). */
export interface Connection {
  provider: CalendarProvider;
  account_email: string;
  status: ConnectionStatus;
  scopes: string[];
  connected_at: string;
  /** null until the first successful sync. */
  last_synced_at: string | null;
}

/** Response from `GET /calendar/connect/{provider}`. */
export interface ConnectUrlResponse {
  authorize_url: string;
}

/** Event organizer — the whole object may be null; both fields are nullable. */
export interface EventOrganizer {
  display_name: string | null;
  email: string | null;
}

/** An attendee's RSVP state, or null when the provider omits it. */
export type AttendeeResponseStatus =
  | 'accepted'
  | 'declined'
  | 'tentative'
  | 'needs_action'
  | null;

/** A single event attendee. */
export interface EventAttendee {
  display_name: string | null;
  email: string | null;
  response_status: AttendeeResponseStatus;
}

/** Conferencing provider type; null when the event has no recognized link. */
export type ConferencingType =
  | 'google_meet'
  | 'microsoft_teams'
  | 'zoom'
  | 'other'
  | null;

/** Conferencing details — the whole object may be null. */
export interface Conferencing {
  type: ConferencingType;
  join_url: string | null;
}

/** Provider-reported event status. */
export type CalendarEventStatus = 'confirmed' | 'tentative' | 'cancelled';

/**
 * NormalizedEvent / CalendarEvent — canonical shape, verbatim both sides
 * (plan §2). The single source of truth carried through the calendar library's
 * per-event extended props.
 */
export interface CalendarEvent {
  /** Stable composite id: "{provider}:{calendar_id}:{provider_event_id}". */
  id: string;
  provider: CalendarProvider;
  calendar_id: string;
  /** "" if the provider omits a title (never null). */
  title: string;
  description: string | null;
  /** ISO8601 tz-aware; all_day events use the date at 00:00 in the event tz. */
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  /** The whole object may be null. */
  organizer: EventOrganizer | null;
  /** [] is acceptable in v1. */
  attendees: EventAttendee[];
  status: CalendarEventStatus;
  /** Provider deep link; may be null. */
  html_link: string | null;
  /** The whole object may be null. */
  conferencing: Conferencing | null;
  color: string | null;
}

/** Per-provider partial-failure summary in the events response (§2). */
export interface ProviderResult {
  provider: CalendarProvider;
  ok: boolean;
  count: number;
  /** e.g. "needs_reauth" — surfaced inline as a "Reconnect" affordance. */
  error: string | null;
}

/** Query params for `GET /calendar/events`. */
export interface ListEventsParams {
  /** tz-aware ISO8601, required. */
  start: string;
  /** tz-aware ISO8601, required; must be > start, window <= 62 days. */
  end: string;
  /** Optional single-provider filter. */
  provider?: CalendarProvider;
}

/** Response from `GET /calendar/events` — the aggregate + per-provider status. */
export interface ListEventsResponse {
  /** NormalizedEvent[], sorted by start asc. */
  events: CalendarEvent[];
  /** Partial-failure array — one entry per connected provider. */
  providers: ProviderResult[];
}
