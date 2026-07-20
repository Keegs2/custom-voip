/**
 * CallActivityTab — the Call Activity dashboard: a DID scope selector, four
 * quality stat tiles (ASR / MOS / Total / ACD), the 7-day performance chart,
 * and a searchable recent-calls table. Data + derived stats come from
 * `useCallActivity`; only the local UI state (search, selected DID, dropdown)
 * lives here. All surfaces are frosted glass.
 */

import { useRef, useState } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { RcfEntry } from '../../../../types/rcf';
import { useCallActivity, useOutsideClose } from '../../hooks';
import { timeAgo, mosLabel, carrierDisplayName, callStatusInfo } from '../../utils';
import { BLUE, BLUE_LIGHT, activityTh } from '../../styles';
import { LoadingState, ErrorState } from '../states';
import { WeeklyChart } from './WeeklyChart';

interface CallActivityTabProps {
  customerId: number | undefined;
}

export function CallActivityTab({ customerId }: CallActivityTabProps) {
  // ALL hooks unconditionally at top (React #310)
  const [activitySearch, setActivitySearch] = useState('');
  const [selectedDid, setSelectedDid] = useState<string | null>(null);
  const [didDropdownOpen, setDidDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  useOutsideClose(dropdownRef, didDropdownOpen, () => setDidDropdownOpen(false));

  const { isLoading, isError, allCalls, rcfEntries, stats, dailyDots, calls } = useCallActivity({
    customerId,
    selectedDid,
    activitySearch,
  });

  const selectedEntry: RcfEntry | null = rcfEntries.find((e) => e.did === selectedDid) ?? null;
  const selectedLabel = selectedEntry ? `${fmt(selectedEntry.did)}${selectedEntry.name ? ` — ${selectedEntry.name}` : ''}` : null;

  const asrColor = '#60a5fa';
  const avgMosColor =
    stats.avgMos == null ? '#4a5568'
    : stats.avgMos >= 4.0 ? '#22c55e'
    : stats.avgMos >= 3.0 ? '#f59e0b'
    : '#ef4444';
  const acdColor = '#fbbf24';

  if (isLoading) return <LoadingState label="Loading recent calls…" />;
  if (isError) return <ErrorState message="Unable to load call activity. Please try refreshing." />;

  if (allCalls.length === 0) {
    return (
      <GlassPanel padding="72px 24px">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center' }}>
          <div style={{ width: 60, height: 60, borderRadius: 15, background: `linear-gradient(135deg, ${hexToRgba(BLUE, 0.14)} 0%, ${hexToRgba(BLUE, 0.06)} 100%)`, border: `1px solid ${hexToRgba(BLUE, 0.22)}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={1.5} style={{ width: 28, height: 28, opacity: 0.6 }}>
              <path d="M2 12 L5 8 L7 11 L11 5 L13 8 L17 4 L22 9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p style={{ color: GLASS.textMuted, fontSize: '1rem', fontWeight: 600, margin: '0 0 6px' }}>No recent calls</p>
            <p style={{ color: GLASS.textFaint, fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 360 }}>Once calls start flowing, your activity log will light up here.</p>
          </div>
        </div>
      </GlassPanel>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* ── DID scope selector ───────────────────────────────── */}
      {rcfEntries.length > 0 && (
        <GlassPanel padding="12px 18px" accent={selectedDid ? BLUE : GLASS.accent} style={{ position: 'relative', zIndex: 50 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <div style={{ width: 26, height: 26, borderRadius: 7, background: hexToRgba(BLUE, 0.12), border: `1px solid ${hexToRgba(BLUE, 0.24)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg viewBox="0 0 16 16" fill="none" stroke={BLUE_LIGHT} strokeWidth={1.7} style={{ width: 11, height: 11 }}>
                  <path d="M3 5a2 2 0 0 1 2-2h1.28a.8.8 0 0 1 .758.547l.6 1.797a.8.8 0 0 1-.401.968l-.903.452a8.833 8.833 0 0 0 4.413 4.413l.452-.903a.8.8 0 0 1 .968-.401l1.797.6A.8.8 0 0 1 14 11.72V13a2 2 0 0 1-2 2h-.4C5.87 15 1 10.13 1 4.4V4a1 1 0 0 1 1-1h1z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <span style={{ fontSize: '0.68rem', fontWeight: 600, color: GLASS.textMuted, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Viewing</span>
            </div>

            <div ref={dropdownRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
              <button
                type="button"
                onClick={() => setDidDropdownOpen((o) => !o)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 12px',
                  borderRadius: 10,
                  border: `1px solid ${didDropdownOpen ? hexToRgba(BLUE, 0.55) : hexToRgba(BLUE, 0.20)}`,
                  background: didDropdownOpen ? hexToRgba(BLUE, 0.08) : selectedDid ? hexToRgba(BLUE, 0.05) : 'rgba(15,17,23,0.5)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  boxShadow: didDropdownOpen ? `0 0 0 3px ${hexToRgba(BLUE, 0.12)}` : 'none',
                  transition: 'border-color 0.18s, background 0.18s, box-shadow 0.18s',
                  outline: 'none',
                  minWidth: 0,
                }}
              >
                <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedDid ? (
                    <span style={{ fontSize: '0.84rem', fontWeight: 700, color: BLUE_LIGHT, fontFamily: 'monospace', letterSpacing: '0.01em' }}>{selectedLabel}</span>
                  ) : (
                    <span style={{ fontSize: '0.84rem', fontWeight: 700, color: GLASS.text }}>All Numbers</span>
                  )}
                </span>
                <svg viewBox="0 0 16 16" fill="none" stroke={selectedDid ? BLUE_LIGHT : '#64748b'} strokeWidth={2} style={{ width: 12, height: 12, flexShrink: 0, transform: didDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.18s' }}>
                  <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {didDropdownOpen && (
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 999, background: 'rgba(15,17,23,0.97)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: `1px solid ${hexToRgba(BLUE, 0.22)}`, borderRadius: 12, overflow: 'hidden', boxShadow: '0 16px 40px -8px rgba(0,0,0,0.7)' }}>
                  <button
                    type="button"
                    onClick={() => { setSelectedDid(null); setDidDropdownOpen(false); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', border: 'none', borderBottom: '1px solid rgba(42,47,69,0.6)', background: !selectedDid ? hexToRgba(BLUE, 0.08) : 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', transition: 'background 0.14s' }}
                    onMouseEnter={(e) => { if (selectedDid) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                    onMouseLeave={(e) => { if (selectedDid) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 7, background: !selectedDid ? hexToRgba(BLUE, 0.18) : 'rgba(255,255,255,0.05)', border: `1px solid ${!selectedDid ? hexToRgba(BLUE, 0.35) : 'rgba(255,255,255,0.08)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <svg viewBox="0 0 16 16" fill="none" stroke={!selectedDid ? BLUE_LIGHT : '#64748b'} strokeWidth={1.7} style={{ width: 11, height: 11 }}>
                        <rect x="2" y="2" width="5" height="5" rx="1.2" />
                        <rect x="9" y="2" width="5" height="5" rx="1.2" />
                        <rect x="2" y="9" width="5" height="5" rx="1.2" />
                        <rect x="9" y="9" width="5" height="5" rx="1.2" />
                      </svg>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.84rem', fontWeight: 800, color: !selectedDid ? BLUE_LIGHT : GLASS.text, letterSpacing: '-0.01em' }}>All Numbers</div>
                      <div style={{ fontSize: '0.65rem', color: GLASS.textFaint, marginTop: 1 }}>Aggregate data for all {rcfEntries.length} number{rcfEntries.length !== 1 ? 's' : ''}</div>
                    </div>
                    {!selectedDid && (
                      <span style={{ marginLeft: 'auto', fontSize: '0.6rem', fontWeight: 700, color: BLUE_LIGHT, background: hexToRgba(BLUE, 0.15), border: `1px solid ${hexToRgba(BLUE, 0.30)}`, borderRadius: 20, padding: '2px 8px', letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>Active</span>
                    )}
                  </button>

                  <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                    {rcfEntries.map((entry) => {
                      const isSelected = selectedDid === entry.did;
                      return (
                        <button
                          key={entry.did}
                          type="button"
                          onClick={() => { setSelectedDid(entry.did); setDidDropdownOpen(false); }}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', border: 'none', borderBottom: '1px solid rgba(42,47,69,0.35)', background: isSelected ? hexToRgba(BLUE, 0.07) : 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', transition: 'background 0.14s' }}
                          onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                          onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: entry.enabled ? '#4ade80' : '#ef4444', flexShrink: 0, boxShadow: entry.enabled ? '0 0 6px rgba(74,222,128,0.6)' : 'none', display: 'inline-block' }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '0.84rem', fontWeight: 700, color: isSelected ? BLUE_LIGHT : GLASS.text, fontFamily: 'monospace', letterSpacing: '0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(entry.did)}</div>
                            {entry.name && <div style={{ fontSize: '0.65rem', color: isSelected ? hexToRgba(BLUE_LIGHT, 0.7) : '#64748b', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</div>}
                          </div>
                          {isSelected && (
                            <svg viewBox="0 0 16 16" fill="none" stroke={BLUE_LIGHT} strokeWidth={2.2} style={{ width: 13, height: 13, flexShrink: 0 }}>
                              <path d="M2 8l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#64748b', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20, padding: '3px 9px', whiteSpace: 'nowrap', letterSpacing: '0.04em' }}>
                {rcfEntries.length} number{rcfEntries.length !== 1 ? 's' : ''}
              </span>
              {selectedDid && (
                <button
                  type="button"
                  onClick={() => setSelectedDid(null)}
                  title="Back to All Numbers"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: `1px solid ${hexToRgba(BLUE, 0.30)}`, background: hexToRgba(BLUE, 0.08), color: BLUE_LIGHT, cursor: 'pointer', padding: 0, transition: 'background 0.15s, border-color 0.15s', flexShrink: 0 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = hexToRgba(BLUE, 0.16); e.currentTarget.style.borderColor = hexToRgba(BLUE, 0.5); }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = hexToRgba(BLUE, 0.08); e.currentTarget.style.borderColor = hexToRgba(BLUE, 0.30); }}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 10, height: 10 }}>
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </GlassPanel>
      )}

      {/* ── Quality stat tiles ───────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <StatTile color={asrColor} label="ASR" sub="answer seizure ratio" value={stats.asr != null ? `${stats.asr.toFixed(1)}%` : '—'} icon={
          <svg viewBox="0 0 16 16" fill="none" stroke={asrColor} strokeWidth={2} style={{ width: 13, height: 13 }}><path d="M2 8l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        } />
        <StatTile color={avgMosColor} label="MOS" sub="voice quality (1–5)" value={stats.avgMos != null ? stats.avgMos.toFixed(1) : '—'} icon={
          <svg viewBox="0 0 16 16" fill="none" stroke={avgMosColor} strokeWidth={1.8} style={{ width: 13, height: 13 }}><path d="M2 10c0-3.3 2.7-6 6-6s6 2.7 6 6" strokeLinecap="round" /><circle cx="8" cy="10" r="1.5" fill={avgMosColor} stroke="none" /></svg>
        } />
        <StatTile color="#60a5fa" label="Total Calls" sub="calls this period" value={stats.total.toLocaleString()} icon={
          <svg viewBox="0 0 16 16" fill="none" stroke="#60a5fa" strokeWidth={1.8} style={{ width: 13, height: 13 }}><path d="M3 5a2 2 0 0 1 2-2h1.28a.8.8 0 0 1 .758.547l.6 1.797a.8.8 0 0 1-.401.968l-.903.452a8.833 8.833 0 0 0 4.413 4.413l.452-.903a.8.8 0 0 1 .968-.401l1.797.6A.8.8 0 0 1 14 11.72V13a2 2 0 0 1-2 2h-.4C5.87 15 1 10.13 1 4.4V4a1 1 0 0 1 1-1h1z" strokeLinecap="round" strokeLinejoin="round" /></svg>
        } />
        <StatTile color={acdColor} label="ACD" sub="avg call duration" value={stats.acd != null ? (stats.acd >= 60 ? `${Math.floor(stats.acd / 60)}m ${Math.round(stats.acd % 60)}s` : `${Math.round(stats.acd)}s`) : '—'} icon={
          <svg viewBox="0 0 16 16" fill="none" stroke={acdColor} strokeWidth={1.8} style={{ width: 13, height: 13 }}><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        } />
      </div>

      {/* ── 7-day chart ──────────────────────────────────────── */}
      <WeeklyChart days={dailyDots} />

      {/* ── Recent calls table ───────────────────────────────── */}
      <GlassPanel padding={0}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(59,130,246,0.08)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Recent Calls</span>
          {selectedDid && selectedLabel && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.65rem', fontWeight: 700, color: BLUE_LIGHT, background: hexToRgba(BLUE, 0.10), border: `1px solid ${hexToRgba(BLUE, 0.25)}`, borderRadius: 20, padding: '2px 8px 2px 6px', whiteSpace: 'nowrap', letterSpacing: '0.02em', flexShrink: 0 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: BLUE_LIGHT, display: 'inline-block', flexShrink: 0, boxShadow: `0 0 5px ${hexToRgba(BLUE_LIGHT, 0.7)}` }} />
              {selectedLabel}
            </span>
          )}
          <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
            <svg viewBox="0 0 20 20" fill="currentColor" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: '#334155' }}>
              <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
            </svg>
            <input
              type="text"
              value={activitySearch}
              onChange={(e) => setActivitySearch(e.target.value)}
              placeholder="Filter by number, date, cause..."
              style={{ width: '100%', boxSizing: 'border-box', padding: '7px 12px 7px 30px', fontSize: '0.8rem', color: GLASS.text, background: 'rgba(15,17,23,0.5)', border: '1px solid rgba(59,130,246,0.12)', borderRadius: 10, outline: 'none', transition: 'border-color 0.2s, box-shadow 0.2s' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.4)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.10)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.12)'; e.currentTarget.style.boxShadow = 'none'; }}
            />
          </div>
          <span style={{ fontSize: '0.68rem', fontWeight: 600, color: BLUE, background: hexToRgba(BLUE, 0.10), border: `1px solid ${hexToRgba(BLUE, 0.20)}`, borderRadius: 20, padding: '2px 9px', flexShrink: 0 }}>
            {calls.length}{(activitySearch.trim() || selectedDid) ? ` of ${allCalls.length}` : ''} shown
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 580 }}>
            <thead>
              <tr style={{ background: 'rgba(59,130,246,0.04)', borderBottom: '1px solid rgba(59,130,246,0.10)' }}>
                {['Time', 'From', 'To (DID)', 'Carrier Trunk', 'Status', 'Quality'].map((h) => (
                  <th key={h} style={activityTh}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.map((cdr, idx) => {
                const status = callStatusInfo(cdr);
                const quality = mosLabel(cdr.mos);
                return (
                  <tr key={cdr.uuid} style={{ borderBottom: idx < calls.length - 1 ? '1px solid rgba(59,130,246,0.05)' : 'none' }}>
                    <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: '0.78rem', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{timeAgo(cdr.start_time)}</span>
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.82rem', color: GLASS.textMuted, fontFamily: 'monospace', fontWeight: 500 }}>{fmt(cdr.caller_id)}</span>
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.82rem', color: BLUE_LIGHT, fontFamily: 'monospace', fontWeight: 600 }}>{fmt(cdr.destination)}</span>
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.78rem', color: '#64748b' }}>{carrierDisplayName(cdr.carrier_used)}</span>
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: status.color, background: status.bg, border: status.border, borderRadius: 20, padding: '3px 9px', whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>{status.label}</span>
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      {cdr.mos != null ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: quality.dot, flexShrink: 0, boxShadow: `0 0 6px ${quality.dot}`, display: 'inline-block' }} />
                          <span style={{ fontSize: '0.72rem', color: quality.color, fontWeight: 600 }}>{quality.text}</span>
                        </div>
                      ) : (
                        <span style={{ fontSize: '0.72rem', color: '#334155' }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </GlassPanel>
    </div>
  );
}

// ── StatTile ─────────────────────────────────────────────────────────────────

function StatTile({ color, label, sub, value, icon }: { color: string; label: string; sub: string; value: string; icon: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(19,21,29,0.72)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: `1px solid ${color}22`, borderRadius: 16, padding: '18px 18px', position: 'relative', overflow: 'hidden', boxShadow: `0 8px 32px -8px rgba(0,0,0,0.5), 0 0 0 1px ${color}0a` }}>
      <div style={{ position: 'absolute', top: -36, right: -36, width: 100, height: 100, borderRadius: '50%', background: `radial-gradient(circle, ${color}18 0%, transparent 70%)`, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', top: 0, left: 24, right: 24, height: 2, background: `linear-gradient(90deg, transparent, ${color}55, transparent)` }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: `${color}18`, border: `1px solid ${color}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{icon}</div>
        <span style={{ fontSize: '0.55rem', fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.85 }}>{label}</span>
      </div>
      <div style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 900, color, letterSpacing: '-0.04em', lineHeight: 1, marginBottom: 3, fontVariantNumeric: 'tabular-nums', textShadow: `0 0 28px ${color}44` }}>{value}</div>
      <div style={{ fontSize: '0.68rem', color: '#64748b', lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
}
