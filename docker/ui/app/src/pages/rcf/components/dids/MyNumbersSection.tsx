/**
 * MyNumbersSection — the customer's assigned DIDs, with NPA/NXX/state/search
 * filtering, an expandable detail row per number, a "Configure Forwarding" jump,
 * and a Release action. Presentational; data + the release flow come from props.
 */

import { Fragment, useMemo, useState } from 'react';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { Spinner } from '../../../../components/ui/Spinner';
import { fmt } from '../../../../utils/format';
import type { DidInventoryItem } from '../../../../types/didInventory';
import type { DidFilterState } from '../../types';
import { applyDidFilters, extractStates, extractNpa, fmtAssignedDate } from '../../utils';
import { BLUE, BLUE_LIGHT } from '../../styles';
import { DidCard, DidSectionHeader, DidStatusBadge, DidTh, DidFilterBar } from './shared';

interface MyNumbersSectionProps {
  items: DidInventoryItem[];
  isLoading: boolean;
  isError: boolean;
  onRelease: (item: DidInventoryItem) => void;
  onSwitchToNumbers: () => void;
}

export function MyNumbersSection({ items, isLoading, isError, onRelease, onSwitchToNumbers }: MyNumbersSectionProps) {
  // ALL hooks unconditionally at top (React #310)
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filters, setFilters] = useState<DidFilterState>({ npa: '', nxx: '', state: '', search: '' });

  const availableStates = useMemo(() => extractStates(items), [items]);
  const filtered = useMemo(() => applyDidFilters(items, filters), [items, filters]);

  if (isLoading) {
    return (
      <DidCard>
        <DidSectionHeader title="My Numbers" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '48px 0', color: '#64748b' }}>
          <Spinner size="sm" />
          <span style={{ fontSize: '0.875rem' }}>Loading your numbers…</span>
        </div>
      </DidCard>
    );
  }

  if (isError) {
    return (
      <DidCard>
        <DidSectionHeader title="My Numbers" />
        <div style={{ padding: '16px 20px', margin: 16, borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', fontSize: '0.85rem' }}>
          Unable to load your numbers. Please try refreshing.
        </div>
      </DidCard>
    );
  }

  return (
    <DidCard delay={0}>
      <DidSectionHeader title="My Numbers" count={items.length} countLabel={items.length === 1 ? 'number' : 'numbers'} />

      {items.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '56px 24px', gap: 14, textAlign: 'center' }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: `linear-gradient(135deg, ${hexToRgba(BLUE, 0.12)} 0%, ${hexToRgba(BLUE, 0.06)} 100%)`, border: `1px solid ${hexToRgba(BLUE, 0.20)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 20px ${hexToRgba(BLUE, 0.10)}` }}>
            <svg viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={1.5} style={{ width: 28, height: 28, opacity: 0.65 }}>
              <path d="M3 5a2 2 0 0 1 2-2h3.28a1 1 0 0 1 .948.684l1.498 4.493a1 1 0 0 1-.502 1.21l-2.257 1.13a11.042 11.042 0 0 0 5.516 5.516l1.13-2.257a1 1 0 0 1 1.21-.502l4.493 1.498a1 1 0 0 1 .684.949V19a2 2 0 0 1-2 2h-1C9.716 21 3 14.284 3 6V5z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p style={{ color: GLASS.textMuted, fontSize: '0.95rem', fontWeight: 600, margin: '0 0 6px' }}>No numbers assigned yet</p>
            <p style={{ color: GLASS.textFaint, fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 360 }}>Browse the available numbers below and request one for your account. Assignments are approved by our team — usually within one business day.</p>
          </div>
        </div>
      ) : (
        <>
          <DidFilterBar filters={filters} onFiltersChange={setFilters} availableStates={availableStates} resultCount={filtered.length} totalCount={items.length} />

          {filtered.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 24px', gap: 10, textAlign: 'center' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth={1.5} style={{ width: 28, height: 28 }}>
                <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p style={{ color: '#64748b', fontSize: '0.85rem', fontWeight: 500, margin: 0 }}>No numbers match these filters</p>
              <button type="button" onClick={() => setFilters({ npa: '', nxx: '', state: '', search: '' })} style={{ background: 'transparent', border: 'none', color: BLUE, fontSize: '0.78rem', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', padding: 0 }}>Clear filters</button>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    <DidTh /><DidTh>DID</DidTh><DidTh>NPA</DidTh><DidTh>City</DidTh><DidTh>State</DidTh><DidTh>Product</DidTh><DidTh>Status</DidTh><DidTh>Assigned</DidTh><DidTh />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item, idx) => {
                    const isExpanded = expandedId === item.id;
                    return (
                      <Fragment key={item.id}>
                        <tr
                          style={{ borderBottom: isExpanded ? 'none' : idx < filtered.length - 1 ? '1px solid rgba(59,130,246,0.06)' : 'none', cursor: 'pointer', background: isExpanded ? 'rgba(59,130,246,0.05)' : 'transparent', transition: 'background 0.15s' }}
                          onClick={() => setExpandedId(isExpanded ? null : item.id)}
                          onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = 'rgba(59,130,246,0.03)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = isExpanded ? 'rgba(59,130,246,0.05)' : 'transparent'; }}
                        >
                          <td style={{ padding: '13px 8px 13px 16px', width: 28 }}>
                            <svg viewBox="0 0 16 16" fill="none" stroke="#475569" strokeWidth={2} strokeLinecap="round" style={{ width: 12, height: 12, transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', display: 'block' }}>
                              <path d="M3 6l5 5 5-5" />
                            </svg>
                          </td>
                          <td style={{ padding: '13px 16px' }}>
                            <div style={{ fontSize: '0.88rem', fontWeight: 700, color: GLASS.text, fontFamily: 'monospace', letterSpacing: '0.02em' }}>{fmt(item.did)}</div>
                            <div style={{ fontSize: '0.63rem', color: '#334155', fontFamily: 'monospace', marginTop: 2, letterSpacing: '0.01em' }}>{item.did}</div>
                          </td>
                          <td style={{ padding: '13px 16px' }}>
                            <span style={{ fontSize: '0.80rem', color: BLUE_LIGHT, fontFamily: 'monospace', fontWeight: 600, letterSpacing: '0.04em' }}>{extractNpa(item.did)}</span>
                          </td>
                          <td style={{ padding: '13px 16px' }}>
                            <span style={{ fontSize: '0.82rem', color: item.city ? GLASS.textMuted : '#2d3748', fontStyle: item.city ? 'normal' : 'italic' }}>{item.city ?? '—'}</span>
                          </td>
                          <td style={{ padding: '13px 16px' }}>
                            <span style={{ fontSize: '0.82rem', color: item.state ? GLASS.textMuted : '#2d3748', fontWeight: item.state ? 600 : 400 }}>{item.state ?? '—'}</span>
                          </td>
                          <td style={{ padding: '13px 16px' }}>
                            <span style={{ fontSize: '0.67rem', fontWeight: 700, color: BLUE_LIGHT, background: hexToRgba(BLUE, 0.10), border: `1px solid ${hexToRgba(BLUE, 0.22)}`, borderRadius: 5, padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{item.product_type ?? 'RCF'}</span>
                          </td>
                          <td style={{ padding: '13px 16px' }}><DidStatusBadge status={item.status} /></td>
                          <td style={{ padding: '13px 16px' }}>
                            <span style={{ fontSize: '0.78rem', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{fmtAssignedDate(item.assigned_at)}</span>
                          </td>
                          <td style={{ padding: '10px 16px' }} onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => onRelease(item)}
                              title="Release this number back to the pool"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 13px', borderRadius: 7, border: '1px solid rgba(239,68,68,0.22)', background: 'rgba(239,68,68,0.10)', color: '#ef4444', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.01em', transition: 'background 0.15s, color 0.15s, border-color 0.15s', whiteSpace: 'nowrap' }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.20)'; e.currentTarget.style.color = '#fca5a5'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.38)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.10)'; e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.22)'; }}
                            >
                              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 10, height: 10 }}><path d="M13 4L4 13M4 4l9 9" strokeLinecap="round" /></svg>
                              Release
                            </button>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr>
                            <td colSpan={9} style={{ padding: '0 20px 20px 20px', background: 'rgba(59,130,246,0.03)', borderBottom: idx < filtered.length - 1 ? '1px solid rgba(59,130,246,0.08)' : 'none' }}>
                              <div style={{ background: 'rgba(15,17,23,0.65)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', border: '1px solid rgba(59,130,246,0.14)', borderRadius: 12, padding: '20px 22px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16, position: 'relative', overflow: 'hidden' }}>
                                <div style={{ position: 'absolute', top: 0, left: 32, right: 32, height: 2, background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.45), transparent)' }} />
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.10em', marginBottom: 6 }}>Number</div>
                                  <div style={{ fontFamily: 'monospace', fontSize: '1.15rem', fontWeight: 800, color: BLUE_LIGHT, letterSpacing: '0.04em' }}>{fmt(item.did)}</div>
                                  <div style={{ fontSize: '0.67rem', color: '#334155', fontFamily: 'monospace', marginTop: 3 }}>{item.did}</div>
                                </div>
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.10em', marginBottom: 6 }}>Location</div>
                                  <div style={{ fontSize: '0.88rem', color: GLASS.text, fontWeight: 600, lineHeight: 1.4 }}>{item.city ?? '—'}{item.state ? `, ${item.state}` : ''}</div>
                                  {item.rate_center && <div style={{ fontSize: '0.73rem', color: '#64748b', marginTop: 3 }}>Rate Center: {item.rate_center}</div>}
                                  {item.lata && <div style={{ fontSize: '0.70rem', color: GLASS.textFaint, marginTop: 1 }}>LATA: {item.lata}</div>}
                                </div>
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.10em', marginBottom: 6 }}>Product</div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <span style={{ display: 'inline-flex', alignSelf: 'flex-start', fontSize: '0.68rem', fontWeight: 700, color: BLUE_LIGHT, background: hexToRgba(BLUE, 0.12), border: `1px solid ${hexToRgba(BLUE, 0.24)}`, borderRadius: 5, padding: '3px 9px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{item.product_type ?? 'RCF'}</span>
                                    <DidStatusBadge status={item.status} />
                                  </div>
                                </div>
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.10em', marginBottom: 6 }}>Assigned Date</div>
                                  <div style={{ fontSize: '0.88rem', color: GLASS.text, fontWeight: 500 }}>{fmtAssignedDate(item.assigned_at)}</div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); onSwitchToNumbers(); }}
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', color: '#fff', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '-0.01em', boxShadow: '0 3px 12px rgba(59,130,246,0.30)', transition: 'filter 0.15s, box-shadow 0.15s', whiteSpace: 'nowrap' }}
                                    onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(1.1)'; e.currentTarget.style.boxShadow = '0 4px 18px rgba(59,130,246,0.45)'; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; e.currentTarget.style.boxShadow = '0 3px 12px rgba(59,130,246,0.30)'; }}
                                  >
                                    Configure Forwarding
                                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 12, height: 12 }}><path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </DidCard>
  );
}
