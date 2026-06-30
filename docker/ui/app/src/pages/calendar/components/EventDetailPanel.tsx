/**
 * Read-only event detail slide-over (frosted glass). v1 has no create/edit/
 * delete — this panel only displays. Hooks are declared unconditionally at the
 * top (React #310); the panel renders nothing when `event` is null but still
 * runs its hooks.
 *
 * Legibility: the panel uses a dark translucent scrim under the blur so text
 * stays high-contrast over the glass.
 *
 * Security: the description is rendered as escaped text via JSX (NEVER
 * dangerouslySetInnerHTML); external links carry rel="noopener noreferrer".
 */
import { useEffect } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import type {
  AttendeeResponseStatus,
  CalendarEvent,
  EventAttendee,
} from '../../../types/calendar';
import { conferencingLabel, PROVIDER_META } from '../providerMeta';
import { detailFieldLabel, joinButton } from '../styles';

interface EventDetailPanelProps {
  event: CalendarEvent | null;
  onClose: () => void;
}

/* ─── Date/time formatting ──────────────────────────────────────────────── */

/** Parse the date portion of an ISO string as a local date (no tz shift). */
function localDateFromIso(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Human-readable when-string honoring all_day and multi-day spans. */
function formatWhen(event: CalendarEvent): string {
  if (event.all_day) {
    const start = localDateFromIso(event.start);
    const end = localDateFromIso(event.end);
    // All-day end dates are commonly exclusive; treat a same-or-next-day end as
    // a single-day event for display.
    const dayMs = 24 * 60 * 60 * 1000;
    const spanDays = Math.round((end.getTime() - start.getTime()) / dayMs);
    if (spanDays <= 1) return `${formatDate(start)} · All day`;
    const lastDay = new Date(end.getTime() - dayMs);
    return `${formatDate(start)} – ${formatDate(lastDay)} · All day`;
  }

  const start = new Date(event.start);
  const end = new Date(event.end);
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) {
    return `${formatDate(start)} · ${formatTime(start)} – ${formatTime(end)}`;
  }
  return `${formatDate(start)} ${formatTime(start)} – ${formatDate(end)} ${formatTime(end)}`;
}

/* ─── Attendee RSVP styling ─────────────────────────────────────────────── */

function rsvpMeta(
  status: AttendeeResponseStatus,
): { label: string; color: string } | null {
  switch (status) {
    case 'accepted':
      return { label: 'Accepted', color: GLASS.success };
    case 'declined':
      return { label: 'Declined', color: GLASS.danger };
    case 'tentative':
      return { label: 'Maybe', color: GLASS.warning };
    case 'needs_action':
      return { label: 'No response', color: GLASS.textMuted };
    case null:
      return null;
  }
}

function attendeeLabel(a: EventAttendee): string {
  return a.display_name ?? a.email ?? 'Unknown';
}

/* ─── Section helpers ───────────────────────────────────────────────────── */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={detailFieldLabel}>{children}</div>;
}

/* ─── Panel ─────────────────────────────────────────────────────────────── */

export function EventDetailPanel({ event, onClose }: EventDetailPanelProps) {
  // Close on Escape — hook declared unconditionally before any early return.
  useEffect(() => {
    if (!event) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [event, onClose]);

  if (!event) return null;

  const meta = PROVIDER_META[event.provider];
  const joinUrl = event.conferencing?.join_url ?? null;
  const accent = event.color ?? GLASS.accent;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      role="dialog"
      aria-modal="true"
      aria-label="Event details"
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
      />

      {/* Slide-over panel — dark scrim + blur (glass) with a blue accent edge */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(440px, 100vw)',
          background:
            'linear-gradient(180deg, rgba(22,25,34,0.92) 0%, rgba(15,17,23,0.95) 100%)',
          backdropFilter: 'blur(24px) saturate(160%)',
          WebkitBackdropFilter: 'blur(24px) saturate(160%)',
          borderLeft: `1px solid ${hexToRgba(GLASS.accent, 0.22)}`,
          boxShadow: '-16px 0 48px rgba(0,0,0,0.55)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'rv-cal-slide-in 0.22s ease',
        }}
      >
        <style>{`@keyframes rv-cal-slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>

        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '22px 24px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 3,
              background: accent,
              marginTop: 6,
              flexShrink: 0,
              boxShadow: `0 0 8px ${accent}80`,
            }}
            aria-hidden="true"
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              style={{
                fontSize: '1.05rem',
                fontWeight: 700,
                color: GLASS.text,
                lineHeight: 1.3,
                margin: 0,
                wordBreak: 'break-word',
              }}
            >
              {event.title || 'Untitled event'}
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: meta.color }}>
                {meta.short}
              </span>
              {event.status !== 'confirmed' && (
                <span
                  style={{
                    fontSize: '0.62rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: event.status === 'cancelled' ? GLASS.danger : GLASS.warning,
                  }}
                >
                  {event.status}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 9,
              border: 'none',
              background: 'transparent',
              color: GLASS.textMuted,
              cursor: 'pointer',
              fontSize: '0.95rem',
              lineHeight: 1,
              padding: 0,
              transition: 'background-color 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = GLASS.text; e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = GLASS.textMuted; e.currentTarget.style.background = 'transparent'; }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(255,255,255,0.14) transparent',
          }}
        >
          {/* When */}
          <div>
            <FieldLabel>When</FieldLabel>
            <div style={{ fontSize: '0.85rem', color: GLASS.text, lineHeight: 1.5 }}>
              {formatWhen(event)}
            </div>
          </div>

          {/* Location */}
          {event.location && (
            <div>
              <FieldLabel>Location</FieldLabel>
              <div style={{ fontSize: '0.85rem', color: '#cbd5e0', lineHeight: 1.5, wordBreak: 'break-word' }}>
                {event.location}
              </div>
            </div>
          )}

          {/* Conferencing — Join button */}
          {joinUrl && (
            <a href={joinUrl} target="_blank" rel="noopener noreferrer" style={joinButton()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 15, height: 15 }}>
                <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {conferencingLabel(event.conferencing?.type ?? null)}
            </a>
          )}

          {/* Organizer */}
          {event.organizer && (event.organizer.display_name || event.organizer.email) && (
            <div>
              <FieldLabel>Organizer</FieldLabel>
              <div style={{ fontSize: '0.85rem', color: '#cbd5e0', lineHeight: 1.4 }}>
                {event.organizer.display_name ?? event.organizer.email}
                {event.organizer.display_name && event.organizer.email && (
                  <span style={{ color: GLASS.textMuted, fontSize: '0.78rem' }}> · {event.organizer.email}</span>
                )}
              </div>
            </div>
          )}

          {/* Attendees */}
          {event.attendees.length > 0 && (
            <div>
              <FieldLabel>Attendees ({event.attendees.length})</FieldLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {event.attendees.map((a, i) => {
                  const rsvp = rsvpMeta(a.response_status);
                  return (
                    <div
                      key={a.email ?? `${i}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}
                    >
                      <span
                        style={{
                          fontSize: '0.8rem',
                          color: '#cbd5e0',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={a.email ?? undefined}
                      >
                        {attendeeLabel(a)}
                      </span>
                      {rsvp && (
                        <span
                          style={{
                            flexShrink: 0,
                            fontSize: '0.62rem',
                            fontWeight: 700,
                            color: rsvp.color,
                            background: hexToRgba(rsvp.color, 0.12),
                            border: `1px solid ${hexToRgba(rsvp.color, 0.28)}`,
                            borderRadius: 6,
                            padding: '2px 7px',
                          }}
                        >
                          {rsvp.label}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Description — escaped text only, never innerHTML */}
          {event.description && (
            <div>
              <FieldLabel>Description</FieldLabel>
              <div
                style={{
                  fontSize: '0.82rem',
                  color: GLASS.textMuted,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {event.description}
              </div>
            </div>
          )}
        </div>

        {/* Footer — open in provider */}
        {event.html_link && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <a
              href={event.html_link}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontSize: '0.8rem',
                fontWeight: 600,
                color: meta.color,
                textDecoration: 'none',
              }}
            >
              {meta.openLabel}
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 12, height: 12 }}>
                <path d="M6 3h7v7M13 3 4 12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
