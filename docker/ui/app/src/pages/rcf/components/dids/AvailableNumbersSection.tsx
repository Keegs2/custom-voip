/**
 * AvailableNumbersSection — the self-serve pool of unassigned DIDs the customer
 * can request. Region-sorted, NPA/NXX/state/search filterable, with a per-row
 * Request action. Presentational; the request flow comes from props.
 */

import { useMemo, useState } from 'react';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { Spinner } from '../../../../components/ui/Spinner';
import { fmt } from '../../../../utils/format';
import type { DidInventoryItem } from '../../../../types/didInventory';
import type { DidFilterState } from '../../types';
import { applyDidFilters, extractStates, extractNpa } from '../../utils';
import { BLUE, BLUE_LIGHT } from '../../styles';
import { DidCard, DidSectionHeader, DidTh, DidFilterBar } from './shared';

interface AvailableNumbersSectionProps {
  items: DidInventoryItem[];
  isLoading: boolean;
  isError: boolean;
  onRequest: (item: DidInventoryItem) => void;
  requestingDid: string | null;
}

export function AvailableNumbersSection({ items, isLoading, isError, onRequest, requestingDid }: AvailableNumbersSectionProps) {
  // ALL hooks unconditionally at top (React #310)
  const [filters, setFilters] = useState<DidFilterState>({ npa: '', nxx: '', state: '', search: '' });

  const availableStates = useMemo(() => extractStates(items), [items]);
  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        const stateA = a.state ?? '';
        const stateB = b.state ?? '';
        if (stateA !== stateB) return stateA.localeCompare(stateB);
        return (a.city ?? '').localeCompare(b.city ?? '');
      }),
    [items],
  );
  const filtered = useMemo(() => applyDidFilters(sortedItems, filters), [sortedItems, filters]);

  if (isLoading) {
    return (
      <DidCard delay={160}>
        <DidSectionHeader title="Available Numbers" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '48px 0', color: '#64748b' }}>
          <Spinner size="sm" />
          <span style={{ fontSize: '0.875rem' }}>Loading available numbers…</span>
        </div>
      </DidCard>
    );
  }

  if (isError) {
    return (
      <DidCard delay={160}>
        <DidSectionHeader title="Available Numbers" />
        <div style={{ padding: '16px 20px', margin: 16, borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', fontSize: '0.85rem' }}>
          Unable to load available numbers. Please try refreshing.
        </div>
      </DidCard>
    );
  }

  return (
    <DidCard delay={160}>
      <DidSectionHeader title="Available Numbers" count={filtered.length} countLabel={filtered.length === 1 ? 'number available' : 'numbers available'} />

      {items.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '56px 24px', gap: 14, textAlign: 'center' }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: `linear-gradient(135deg, ${hexToRgba(BLUE, 0.10)} 0%, ${hexToRgba(BLUE, 0.05)} 100%)`, border: `1px solid ${hexToRgba(BLUE, 0.16)}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={1.5} style={{ width: 26, height: 26, opacity: 0.5 }}>
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M9 12h6M12 9v6" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <p style={{ color: GLASS.textMuted, fontSize: '0.95rem', fontWeight: 600, margin: '0 0 6px' }}>No numbers available right now</p>
            <p style={{ color: GLASS.textFaint, fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 360 }}>Our team is provisioning additional numbers. Check back soon or contact support to request a specific area code.</p>
          </div>
        </div>
      ) : (
        <>
          <DidFilterBar filters={filters} onFiltersChange={setFilters} availableStates={availableStates} resultCount={filtered.length} totalCount={items.length} />

          {filtered.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', gap: 10, textAlign: 'center' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth={1.5} style={{ width: 32, height: 32 }}>
                <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p style={{ color: '#64748b', fontSize: '0.88rem', fontWeight: 500, margin: 0 }}>No numbers match these filters</p>
              <button type="button" onClick={() => setFilters({ npa: '', nxx: '', state: '', search: '' })} style={{ background: 'transparent', border: 'none', color: BLUE, fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', padding: 0 }}>Clear filters</button>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    <DidTh>DID</DidTh><DidTh>NPA</DidTh><DidTh>State</DidTh><DidTh>City</DidTh><DidTh>Rate Center</DidTh><DidTh>Action</DidTh>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item, idx) => {
                    const isRequesting = requestingDid === item.did;
                    return (
                      <tr
                        key={item.id}
                        style={{ borderBottom: idx < filtered.length - 1 ? '1px solid rgba(59,130,246,0.06)' : 'none', transition: 'background 0.15s' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.04)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <td style={{ padding: '13px 16px' }}>
                          <div style={{ fontSize: '0.88rem', fontWeight: 700, color: GLASS.text, fontFamily: 'monospace', letterSpacing: '0.02em' }}>{fmt(item.did)}</div>
                          <div style={{ fontSize: '0.63rem', color: '#334155', fontFamily: 'monospace', marginTop: 2 }}>{item.did}</div>
                        </td>
                        <td style={{ padding: '13px 16px' }}>
                          <span style={{ fontSize: '0.80rem', fontFamily: 'monospace', fontWeight: 600, color: BLUE_LIGHT, background: hexToRgba(BLUE, 0.08), border: `1px solid ${hexToRgba(BLUE, 0.16)}`, borderRadius: 5, padding: '2px 7px', letterSpacing: '0.06em', display: 'inline-block' }}>{extractNpa(item.did)}</span>
                        </td>
                        <td style={{ padding: '13px 16px' }}>
                          <span style={{ fontSize: '0.82rem', color: item.state ? GLASS.textMuted : '#2d3748', fontWeight: item.state ? 700 : 400 }}>{item.state ?? '—'}</span>
                        </td>
                        <td style={{ padding: '13px 16px' }}>
                          <span style={{ fontSize: '0.82rem', color: item.city ? GLASS.textMuted : '#2d3748', fontStyle: item.city ? 'normal' : 'italic' }}>{item.city ?? '—'}</span>
                        </td>
                        <td style={{ padding: '13px 16px' }}>
                          <span style={{ fontSize: '0.78rem', color: '#64748b' }}>{item.rate_center ?? '—'}</span>
                        </td>
                        <td style={{ padding: '10px 16px' }}>
                          <button
                            type="button"
                            onClick={() => onRequest(item)}
                            disabled={isRequesting}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: 'none', background: isRequesting ? 'rgba(59,130,246,0.25)' : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', color: '#fff', fontSize: '0.75rem', fontWeight: 700, cursor: isRequesting ? 'not-allowed' : 'pointer', fontFamily: 'inherit', letterSpacing: '0.02em', boxShadow: isRequesting ? 'none' : '0 3px 12px rgba(59,130,246,0.30)', transition: 'background 0.15s, box-shadow 0.15s, filter 0.15s', whiteSpace: 'nowrap' }}
                            onMouseEnter={(e) => { if (!isRequesting) { e.currentTarget.style.filter = 'brightness(1.12)'; e.currentTarget.style.boxShadow = '0 4px 18px rgba(59,130,246,0.45)'; } }}
                            onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; e.currentTarget.style.boxShadow = isRequesting ? 'none' : '0 3px 12px rgba(59,130,246,0.30)'; }}
                          >
                            {isRequesting ? (
                              <svg viewBox="0 0 16 16" style={{ width: 11, height: 11, animation: 'glass-spin 0.7s linear infinite' }}>
                                <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={2} />
                                <path d="M8 2a6 6 0 0 1 6 6" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11 }}>
                                <circle cx="8" cy="8" r="6" />
                                <path d="M8 5v6M5 8h6" strokeLinecap="round" />
                              </svg>
                            )}
                            {isRequesting ? 'Requesting…' : 'Request'}
                          </button>
                        </td>
                      </tr>
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
