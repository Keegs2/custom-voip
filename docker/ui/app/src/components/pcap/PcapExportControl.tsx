/**
 * PcapExportControl — one-click PCAP download of a call's captured SIP
 * signaling, with the privacy-critical "Show internal" toggle.
 *
 * Privacy model (the reason this component exists as one unit):
 *   - Toggle OFF (the DEFAULT, always): the export contains ONLY edge
 *     signaling (our SBCs ↔ carrier/customer side). Internal topology is
 *     absent — this is the normal troubleshooting artifact, safe to hand to
 *     carriers/customers.
 *   - Toggle ON: the full capture through our network, every internal hop,
 *     private IPs included. For Granite engineers only — never share it.
 *
 * The toggle is component-local state and is NEVER persisted: every fresh
 * mount (each row expand on the Troubleshooting page) starts back at the
 * safe edge-only default.
 *
 * API: GET /v1/homer/pcap (api/homer.ts downloadPcap — pinned to exactly
 * call_id/internal/correlated). Errors surface the server's human-readable
 * `detail` verbatim, inline (the Troubleshooting page's banner idiom). The
 * specific 404 "no edge packets — may be on-net; retry with internal=true"
 * case, hit while the toggle is off, additionally offers a one-click
 * "Show internal & retry".
 */
import { useCallback, useId, useState } from 'react';
import { downloadPcap } from '../../api/homer';
import { ApiError } from '../../api/client';
import { saveBlob } from '../../utils/download';
import { Spinner } from '../ui/Spinner';

const HELPER_OFF =
  'Edge-only capture (SBC ↔ carrier/customer) — safe to share externally.';
const HELPER_ON =
  'Full internal path — includes private IPs and internal hops; do not share outside Granite.';

interface PcapError {
  /** Server `detail`, human-readable — rendered verbatim. */
  message: string;
  /** HTTP status, or null for network/unknown failures. */
  status: number | null;
}

interface PcapExportControlProps {
  /** The call's SIP Call-ID (the ladder/search representative Call-ID). */
  callId: string;
}

export function PcapExportControl({ callId }: PcapExportControlProps) {
  // ALL hooks unconditionally at the top — React #310 prevention.
  // `internal` intentionally defaults false and has no persistence: a fresh
  // expand must always start with the externally-safe edge-only export.
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PcapError | null>(null);
  const toggleId = useId();

  const run = useCallback(
    async (useInternal: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const { blob, filename } = await downloadPcap(callId, useInternal);
        saveBlob(blob, filename);
      } catch (err) {
        if (err instanceof ApiError) {
          setError({ message: err.message, status: err.status });
        } else {
          setError({
            message: err instanceof Error ? err.message : 'PCAP download failed.',
            status: null,
          });
        }
      } finally {
        setBusy(false);
      }
    },
    [callId],
  );

  // The on-net edge case: the edge-only export found nothing because the call
  // may never have touched the network edge. Invite the internal retry —
  // detected off the server's own wording so unrelated 404s don't trigger it.
  const suggestInternal =
    error !== null &&
    !internal &&
    error.status === 404 &&
    /internal\s*=\s*true|on-?net/i.test(error.message);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '9px 18px',
        background: 'var(--rcf-card)',
        borderBottom: '1px solid var(--rcf-line)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="dl-btn dl-btn-ghost"
        onClick={() => void run(internal)}
        disabled={busy}
        style={{ flexShrink: 0 }}
      >
        {busy ? <Spinner size="xs" /> : <DownloadIcon />}
        {busy ? 'Preparing…' : 'Download PCAP'}
      </button>

      <label
        htmlFor={toggleId}
        title={internal ? HELPER_ON : HELPER_OFF}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          cursor: busy ? 'default' : 'pointer',
          fontSize: '0.76rem',
          fontWeight: 600,
          color: 'var(--rcf-ink-soft)',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        <input
          id={toggleId}
          type="checkbox"
          checked={internal}
          disabled={busy}
          onChange={(e) => setInternal(e.target.checked)}
          style={{ width: 14, height: 14, accentColor: 'var(--rcf-azure)', cursor: 'inherit' }}
        />
        Show internal
      </label>

      {/* Always-visible privacy stakes — the copy IS the safeguard. */}
      <span
        aria-live="polite"
        style={{
          fontSize: '0.7rem',
          lineHeight: 1.4,
          color: internal ? '#b45309' : 'var(--rcf-ink-dim)',
          fontWeight: internal ? 600 : 400,
          minWidth: 0,
        }}
      >
        {internal ? HELPER_ON : HELPER_OFF}
      </span>

      {error !== null && (
        <div
          className="dl-banner dl-banner-err"
          role="alert"
          style={{
            flexBasis: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            fontSize: '0.76rem',
          }}
        >
          <span style={{ minWidth: 0 }}>{error.message}</span>
          {suggestInternal && (
            <button
              type="button"
              className="dl-btn dl-btn-ghost"
              disabled={busy}
              onClick={() => {
                setInternal(true);
                void run(true);
              }}
              style={{ flexShrink: 0 }}
            >
              Show internal &amp; retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1={12} y1={3} x2={12} y2={15} />
    </svg>
  );
}
