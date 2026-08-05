/**
 * AttestationChain — compact per-call STIR/SHAKEN attestation display.
 *
 * Renders the call's attestation "story" as a chain:
 *
 *     Caller: <inbound_attest> <✓/✗ verstat>   →   Signed: <signed_attestation>
 *                                                   (source: self | carrier)
 *
 * Self-contained: give it a `callId` and it fetches
 * `GET /cdrs/{callId}/attestation` (tenant-scoped server-side). On 404 — an
 * older, unsigned, or on-net call with no attestation record — it renders a
 * subtle "Not signed / n/a" note, never an error.
 */

import { useQuery } from '@tanstack/react-query';
import { getCallAttestation } from '../../api/stir';
import { ApiError } from '../../api/client';
import { Spinner } from '../ui/Spinner';
import type { CallAttestation } from '../../types/stir';
import {
  attestColor,
  attestLabel,
  attestDescription,
  verstatColor,
  verstatVerdict,
  verstatSourceColor,
  type ColorToken,
} from './attestationColors';

interface AttestationChainProps {
  callId: string;
  /** Skip the fetch (e.g. while a parent drawer is animating closed). */
  enabled?: boolean;
}

// ── Small building blocks ─────────────────────────────────────────────────────

/** A translucent pill in a semantic colour — used for each attestation node. */
function Pill({
  token,
  children,
  title,
}: {
  token: ColorToken;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 6,
        fontSize: '0.72rem',
        fontWeight: 700,
        lineHeight: 1.3,
        color: token.text,
        background: token.bg,
        border: `1px solid ${token.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

/** Uppercase micro-label above a chain node ("Caller" / "Signed"). */
function NodeLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: '0.54rem',
        fontWeight: 700,
        color: '#4a5568',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </span>
  );
}

/** The "→" connector between chain nodes. */
function Arrow() {
  return (
    <span
      aria-hidden="true"
      style={{ color: '#3b82f6', fontSize: '0.9rem', lineHeight: 1, opacity: 0.7, flexShrink: 0 }}
    >
      →
    </span>
  );
}

// ── Verstat glyph ─────────────────────────────────────────────────────────────

function VerstatGlyph({ verstat }: { verstat: string | null | undefined }) {
  const verdict = verstatVerdict(verstat);
  const token = verstatColor(verstat);
  const glyph = verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '–';
  const label = verstat ?? 'No validation';
  return (
    <span
      title={label}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: token.text, fontWeight: 800 }}
    >
      {glyph}
    </span>
  );
}

// ── The chain body (given a resolved record) ──────────────────────────────────

function ChainBody({ att }: { att: CallAttestation }) {
  const inboundToken = attestColor(att.inbound_attest);
  const signedToken = attestColor(att.signed_attestation);
  const sourceToken = verstatSourceColor(att.verstat_source);
  const verstatLabel = att.inbound_verstat ?? 'No validation';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* The chain row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {/* Caller node */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <NodeLabel>Caller</NodeLabel>
          <Pill token={inboundToken} title={`Inbound: ${attestDescription(att.inbound_attest)}`}>
            {attestLabel(att.inbound_attest)}
            <VerstatGlyph verstat={att.inbound_verstat} />
          </Pill>
        </div>

        <Arrow />

        {/* Signed (outbound) node */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <NodeLabel>Signed</NodeLabel>
          <Pill token={signedToken} title={`We signed: ${attestDescription(att.signed_attestation)}`}>
            {attestLabel(att.signed_attestation)}
          </Pill>
        </div>
      </div>

      {/* Sub-notes: verstat verdict + source */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          fontSize: '0.66rem',
          color: '#718096',
        }}
      >
        <span title="Caller verification result">
          Verification:{' '}
          <span style={{ color: verstatColor(att.inbound_verstat).text, fontWeight: 600 }}>
            {verstatLabel}
          </span>
        </span>
        {att.verstat_source && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '1px 7px',
              borderRadius: 5,
              fontSize: '0.6rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: sourceToken.text,
              background: sourceToken.bg,
              border: `1px solid ${sourceToken.border}`,
            }}
            title={
              att.verstat_source === 'carrier'
                ? 'Verification supplied by the carrier'
                : 'Verified by the platform'
            }
          >
            {att.verstat_source}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export function AttestationChain({ callId, enabled = true }: AttestationChainProps) {
  // ALL hooks unconditionally at top (rules-of-hooks — this codebase has been
  // bitten by React #310; never place hooks below early returns).
  const { data, isLoading, error, isError } = useQuery({
    queryKey: ['attestation', callId],
    queryFn: () => getCallAttestation(callId),
    enabled: enabled && callId.length > 0,
    staleTime: 60_000,
    // A missing attestation record (404) is an expected "n/a" state, not a
    // failure — don't retry it, and render it as a subtle note below.
    retry: (failureCount, err) => {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return false;
      return failureCount < 2;
    },
  });

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', fontSize: '0.72rem' }}>
        <Spinner size="xs" /> Loading attestation…
      </div>
    );
  }

  // 404 (no record) or 403 (not this tenant's call) → subtle "not signed / n/a".
  const isNotAvailable = isError && error instanceof ApiError && (error.status === 404 || error.status === 403);
  if (isNotAvailable || (!data && !isError)) {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          fontSize: '0.7rem',
          color: '#64748b',
        }}
        title="No STIR/SHAKEN attestation on record for this call (older, unsigned, or on-net)."
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#475569',
            flexShrink: 0,
          }}
        />
        Not signed / n/a
      </div>
    );
  }

  // Any other error — keep it quiet and inline (this is a supplementary panel).
  if (isError || !data) {
    return (
      <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
        Attestation unavailable
        {error instanceof Error ? ` — ${error.message}` : ''}
      </div>
    );
  }

  return <ChainBody att={data} />;
}
