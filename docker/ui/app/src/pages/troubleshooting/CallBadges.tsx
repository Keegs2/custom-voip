/**
 * CallBadges.tsx — the small presentational atoms a call is drawn with on the
 * Troubleshooting page: result pill, failover-attempts trail, STIR/SHAKEN
 * attestation pill, zone pill, the correlation warning banner and the shared
 * external-link glyph. Used by BOTH the results table and the call-trace
 * modal header, so a call reads identically in either place.
 *
 * Components-only module (react-refresh): pure helpers live in callDisplay.ts.
 */
import { summarizeAttempts, type CorrelationNotice, type LegAttempt } from './callGrouping';
import type { MessageAttestation } from '../../types/stir';
import {
  ATTEST_TONES,
  attestLabel,
  attestDescription,
  verstatVerdict,
  resolveStirBadge,
  type AttestToneKey,
  type ColorToken,
} from '../../components/stir/attestationColors';
import { INK_FAINT, INK_GHOST, MONO, type ZoneInfo } from './callDisplay';

// ─── Status pill ─────────────────────────────────────────────────────────────

/** Final SIP status as a semantic pill on the paper canvas:
 *  2xx green (answered) · 1xx azure (provisional only) · 4xx amber · 5xx red. */
export function StatusPill({ status }: { status: number | null }) {
  if (status === null) {
    return <span className="dlx5-status dlx5-status-none">—</span>;
  }
  let toneClass = 'dlx5-status-none';
  if (status >= 200 && status < 300) toneClass = 'dlx5-status-ok';
  else if (status >= 500) toneClass = 'dlx5-status-err';
  else if (status >= 400) toneClass = 'dlx5-status-warn';
  else if (status >= 100 && status < 200) toneClass = 'dlx5-status-info';
  return <span className={`dlx5-status ${toneClass}`}>{status}</span>;
}

/**
 * Compact failover trail beside the Result pill — only when FS made 2+
 * bridge attempts (e.g. "2 att · 503 → 200"). Full per-attempt detail
 * (ordinal, outcome, Call-ID) lives in the tooltip so the row stays quiet.
 */
export function AttemptsBadge({ attempts }: { attempts: ReadonlyArray<LegAttempt> }) {
  const trail = summarizeAttempts(attempts);
  if (trail === null) return null;
  const detail = attempts
    .map((a, i) => {
      const n = a.attempt ?? i + 1;
      const outcome = a.finalStatus !== null ? String(a.finalStatus) : 'no final response';
      return `#${n}: ${outcome} — ${a.callid}`;
    })
    .join('\n');
  return (
    <span
      className="dlx5-attempts"
      title={`${attempts.length} B-leg bridge attempts (failover)\n${detail}`}
      aria-label={`${attempts.length} bridge attempts: ${trail}`}
    >
      {attempts.length} att · {trail}
    </span>
  );
}

/**
 * Shown when the API reports it could not link every call leg
 * (correlation_status partial/degraded) or truncated the correlation
 * window — a single call may then appear as two rows. The reason line is
 * the API's staff-facing diagnostic, verbatim.
 */
export function CorrelationBanner({ notice }: { notice: CorrelationNotice }) {
  const facts: string[] = [];
  if (notice.status !== null && notice.status !== 'ok') facts.push(`correlation ${notice.status}`);
  if (notice.truncated) facts.push('correlation window truncated');
  return (
    <div className="dl-banner dl-banner-warn dlx5-corr-banner" role="status">
      Some call legs could not be linked — results may show a call split in two.
      <span className="dlx5-corr-detail">
        {facts.join(' · ')}
        {notice.reason !== null ? ` — ${notice.reason}` : ''}
      </span>
    </div>
  );
}

// ─── Zone pill ───────────────────────────────────────────────────────────────

/** HEP-capture zone (East/West/Central); an unmapped capture id shows raw. */
export function ZonePill({ zone }: { zone: ZoneInfo | null }) {
  if (zone === null) return <span style={{ color: INK_GHOST }}>—</span>;
  return (
    <span
      className={zone.known ? 'dlx5-zone' : 'dlx5-zone dlx5-zone-raw'}
      title={zone.known ? `${zone.label} zone` : `Unrecognized HEP capture node id ${zone.label}`}
    >
      {zone.label}
    </span>
  );
}

// ─── Attestation badge ───────────────────────────────────────────────────────

// STIR tones come from the ONE shared palette (components/stir/
// attestationColors — A=green, B=amber, C=gray, div=azure, base-only=amber,
// unsigned=red, none=faint), theme tokens legible on both grounds.

const KNOWN_TONES = new Set<string>(['A', 'B', 'C', 'div', 'base-only', 'unsigned']);

function attestTone(level: string | null | undefined): ColorToken {
  if (level && KNOWN_TONES.has(level)) {
    return ATTEST_TONES[level as AttestToneKey];
  }
  return ATTEST_TONES.none;
}

/**
 * Subtle "not confirmed on wire" marker appended to an intent-only badge: a
 * hollow ring glyph, muted, with the explanation in the tooltip. Badges
 * confirmed by Kamailio's outcome carry no marker — silence means verified.
 */
function IntentMark() {
  return (
    <span
      aria-label="intent, not confirmed on wire"
      style={{ color: INK_FAINT, marginLeft: 3, fontSize: '0.62rem', fontWeight: 600, lineHeight: 1 }}
    >
      ◌
    </span>
  );
}

/**
 * Compact STIR/SHAKEN badge for a call. One pill; the fuller story — caller
 * attestation + verstat ✓/✗ + source — is stashed in the `title` on hover.
 *
 * Rendering:
 *   - base `A`/`B`/`C` → the single semantic-coloured letter (A=green, B=amber,
 *     C=gray).
 *   - `div` (diversion / forwarded call) → `div` is only the *mechanism*, so we
 *     surface the level the call actually CARRIES: a two-tone "A→div" chain pill,
 *     the carried level tinted by the caller's `inbound_attest` (A=green/B=amber/
 *     C=gray) followed by the azure `div`. If `inbound_attest` is unknown, we fall
 *     back to a plain azure `div`.
 *   - an out-of-band value (e.g. a runtime "unsigned") → a muted "unsigned".
 *   - `null` (no stored attestation: legacy / pre-deploy / signing-off) → a
 *     subtle muted "—", never an error.
 */
export function AttestationBadge({ attestation }: { attestation: MessageAttestation | null }) {
  if (attestation === null) {
    return (
      <span
        title="No STIR/SHAKEN attestation on record for this call (legacy, unsigned, or pre-deploy)."
        style={{ fontSize: '0.78rem', fontFamily: MONO, color: INK_GHOST }}
      >
        —
      </span>
    );
  }

  // Compose the hover "story": what the caller presented (attestation + verstat
  // verdict glyph + source) and what we signed. Kept terse — one line per fact.
  const verdict = verstatVerdict(attestation.inbound_verstat);
  const verstatGlyph = verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '–';
  const callerAttest = attestation.inbound_attest
    ? `${attestLabel(attestation.inbound_attest)} (${attestDescription(attestation.inbound_attest)})`
    : 'none';
  const verstatText = attestation.inbound_verstat ?? 'No validation';
  const sourceText = attestation.verstat_source
    ? ` [${attestation.verstat_source}]`
    : '';
  // Which fact the badge shows: the ACTUAL wire outcome Kamailio reported
  // (stir_badge_source='actual') or, for calls that predate the outcome
  // hand-off, the INTENT we asked for. Intent-only badges get a subtle marker
  // + tooltip; confirmed ones carry none.
  const badge = resolveStirBadge(attestation);
  const isIntent = badge.source === 'intent';
  const wireLine =
    badge.source === 'actual'
      ? `On wire: ${attestLabel(badge.level)} (${attestDescription(badge.level)})${badge.mode ? ` · mode=${badge.mode}` : ''} — ${badge.note}`
      : `Signed (intent): ${attestLabel(badge.level)} (${attestDescription(badge.level)}) — ${badge.note}`;
  const title = [
    `Caller: ${callerAttest}`,
    `Verification: ${verstatGlyph} ${verstatText}${sourceText}`,
    wireLine,
  ].join('\n');

  const signed = badge.level;

  // `div` is only the *mechanism*. The meaningful signal is the attestation the
  // call actually carries — the caller's preserved level (`inbound_attest`). So
  // for a diversion we render a two-tone chain pill "A→div": the carried level
  // coloured by the CALLER's attestation, then the azure `div` mechanism. If the
  // caller's level is unknown (edge case) we fall back to a plain azure `div`.
  if (signed === 'div' && attestation.inbound_attest !== null) {
    const carried = attestTone(attestation.inbound_attest);
    const divTone = ATTEST_TONES.div;
    return (
      <span
        className="dlx5-attest"
        title={title}
        style={{ background: carried.bg, borderColor: carried.border }}
      >
        <span style={{ color: carried.text }}>{attestLabel(attestation.inbound_attest)}</span>
        <span style={{ color: INK_FAINT, margin: '0 1px' }}>→</span>
        <span style={{ color: divTone.text }}>div</span>
        {isIntent && <IntentMark />}
      </span>
    );
  }

  // Base A/B/C/div(no-caller) plus the wire-outcome labels base-only/unsigned:
  // the single semantic-coloured label. Any other value (a label this build
  // doesn't know yet) renders muted rather than in a hard semantic colour.
  const isKnownLevel = !!signed && KNOWN_TONES.has(signed);
  const tone = isKnownLevel ? attestTone(signed) : ATTEST_TONES.none;
  return (
    <span
      className="dlx5-attest"
      title={title}
      style={{ background: tone.bg, borderColor: tone.border, color: tone.text }}
    >
      {signed ? attestLabel(signed) : 'unsigned'}
      {isIntent && <IntentMark />}
    </span>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────

export function ExternalIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
