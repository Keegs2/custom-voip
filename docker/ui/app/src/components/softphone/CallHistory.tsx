import { useEffect, useState } from 'react';
import { searchCdrs } from '../../api/cdrs';
import { useSoftphone } from '../../contexts/SoftphoneContext';
import type { Cdr } from '../../types/cdr';

const IconInbound = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconOutbound = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="m19.5 4.5-15 15m0 0h11.25m-11.25 0V8.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconMissed = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="M6 18 18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function formatDuration(seconds: number): string {
  if (seconds === 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);

  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

type CallFilter = 'all' | 'inbound' | 'outbound' | 'missed';

export function CallHistory() {
  const { credentials, makeCall, connectionState } = useSoftphone();
  const [cdrs, setCdrs] = useState<Cdr[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<CallFilter>('all');

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    searchCdrs({ limit: 50, sort_by: 'start_time', sort_dir: 'desc' })
      .then((result) => {
        if (!cancelled) setCdrs(result.items);
      })
      .catch(() => {
        if (!cancelled) setCdrs([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const filtered = cdrs.filter((cdr) => {
    if (filter === 'all') return true;
    if (filter === 'inbound') return cdr.direction === 'inbound';
    if (filter === 'outbound') return cdr.direction === 'outbound';
    if (filter === 'missed') return cdr.direction === 'inbound' && (cdr.billable_seconds === 0 || cdr.hangup_cause === 'NO_ANSWER');
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>
      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '0 0 10px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {(['all', 'inbound', 'outbound', 'missed'] as CallFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              flex: 1,
              padding: '5px 4px',
              borderRadius: 7,
              fontSize: '0.65rem',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              background: filter === f ? 'rgba(59,130,246,0.15)' : 'transparent',
              border: filter === f ? '1px solid rgba(59,130,246,0.30)' : '1px solid transparent',
              color: filter === f ? '#60a5fa' : '#475569',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 6 }}>
        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <div style={{ width: 20, height: 20, border: '2px solid rgba(255,255,255,0.1)', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#334155', fontSize: '0.8rem', padding: '24px 16px' }}>
            No calls found
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {filtered.map((cdr) => {
              const isMissed = cdr.direction === 'inbound' && (cdr.billable_seconds === 0 || cdr.hangup_cause === 'NO_ANSWER');
              const remoteParty = cdr.direction === 'outbound' ? cdr.destination : cdr.caller_id;
              const remoteName = cdr.direction === 'outbound' ? cdr.destination : cdr.caller_id;
              const canCallBack = connectionState === 'registered' && credentials !== null;

              return (
                <div
                  key={cdr.uuid}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 6px',
                    borderRadius: 8,
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  {/* Direction icon */}
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      background: isMissed ? 'rgba(239,68,68,0.10)'
                        : cdr.direction === 'inbound' ? 'rgba(34,197,94,0.10)'
                        : 'rgba(59,130,246,0.10)',
                      color: isMissed ? '#ef4444'
                        : cdr.direction === 'inbound' ? '#22c55e'
                        : '#3b82f6',
                    }}
                  >
                    {isMissed ? <IconMissed /> : cdr.direction === 'inbound' ? <IconInbound /> : <IconOutbound />}
                  </div>

                  {/* Details */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: isMissed ? '#f87171' : '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {remoteName !== remoteParty ? remoteName : remoteParty}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {remoteParty} · {formatDuration(cdr.billable_seconds)}
                    </div>
                  </div>

                  {/* Date + call back */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                    <div style={{ fontSize: '0.65rem', color: '#334155' }}>
                      {formatDate(cdr.start_time)}
                    </div>
                    {canCallBack && (
                      <button
                        type="button"
                        onClick={() => void makeCall(remoteParty)}
                        aria-label={`Call back ${remoteParty}`}
                        style={{
                          background: 'rgba(34,197,94,0.10)',
                          border: '1px solid rgba(34,197,94,0.20)',
                          borderRadius: 5,
                          color: '#22c55e',
                          fontSize: '0.6rem',
                          fontWeight: 600,
                          padding: '2px 6px',
                          cursor: 'pointer',
                        }}
                      >
                        Call
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
