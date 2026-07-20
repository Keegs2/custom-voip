/**
 * CdrSection — the sortable / searchable / paginated CDR table inside a frosted
 * glass panel. View state (search, sort, page) is owned by `useCdrTableView`;
 * this component is presentation + wiring only.
 */

import { useState } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import type { Cdr } from '../../../types/cdr';
import type { Customer } from '../../../types/customer';
import type { SortKey } from '../types';
import { useCdrTableView } from '../hooks';
import { jitterColor, mosBg, mosColor, packetLossColor, rFactorColor, fmtDuration } from '../quality';
import { IconSearch } from './icons';
import {
  sectionLabel,
  inlineState,
  spinnerRing,
  tableSearchWrap,
  tableSearchInput,
  tableWrap,
  th,
  tdBase,
  rowStyle,
  badge,
  metricPill,
  paginationBtn,
  MONO,
} from '../styles';

interface CdrSectionProps {
  cdrs: Cdr[];
  customers: Customer[];
  isLoading: boolean;
  onSelect: (cdr: Cdr) => void;
  selectedUuid: string | null;
}

function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <span style={{ color: GLASS.textFaint, marginLeft: 3 }}>↕</span>;
  return <span style={{ color: GLASS.accent, marginLeft: 3 }}>{dir === 'asc' ? '↑' : '↓'}</span>;
}

export function CdrSection({ cdrs, customers, isLoading, onSelect, selectedUuid }: CdrSectionProps) {
  const view = useCdrTableView(cdrs, customers);
  const [searchFocused, setSearchFocused] = useState(false);

  const sortable = (key: SortKey) => ({
    onClick: () => view.toggleSort(key),
    style: th(true),
  });

  return (
    <GlassPanel padding="24px 26px">
      <div style={{ ...sectionLabel(), marginBottom: 16 }}>
        CDR Records
        {cdrs.length > 0 && (
          <span style={{ fontWeight: 400, color: GLASS.textMuted, marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
            — {cdrs.length.toLocaleString()} records loaded
          </span>
        )}
      </div>

      {isLoading ? (
        <div style={inlineState}>
          <span style={spinnerRing()} /> Loading records…
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Search + record count */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={tableSearchWrap(searchFocused)}>
              <IconSearch stroke={searchFocused ? GLASS.accent : GLASS.textFaint} />
              <input
                type="text"
                placeholder="Search by number, UUID, customer, codec, cause…"
                value={view.search}
                onChange={(e) => view.setSearch(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                style={tableSearchInput}
              />
            </div>
            <span style={{ fontSize: '0.72rem', color: GLASS.textMuted, whiteSpace: 'nowrap' }}>
              {view.filteredCount.toLocaleString()} records
            </span>
          </div>

          {/* Table */}
          <div style={tableWrap}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.74rem', color: '#cbd5e0' }}>
              <thead>
                <tr>
                  <th {...sortable('start_time')}>Date / Time <SortIcon active={view.sort.key === 'start_time'} dir={view.sort.dir} /></th>
                  <th style={th(false)}>Customer</th>
                  <th style={th(false)}>Dir</th>
                  <th style={th(false)}>From</th>
                  <th style={th(false)}>To</th>
                  <th {...sortable('duration_seconds')}>Duration <SortIcon active={view.sort.key === 'duration_seconds'} dir={view.sort.dir} /></th>
                  <th {...sortable('mos')}>MOS <SortIcon active={view.sort.key === 'mos'} dir={view.sort.dir} /></th>
                  <th {...sortable('packet_loss_pct')}>Pkt Loss <SortIcon active={view.sort.key === 'packet_loss_pct'} dir={view.sort.dir} /></th>
                  <th {...sortable('jitter_avg_ms')}>Jitter <SortIcon active={view.sort.key === 'jitter_avg_ms'} dir={view.sort.dir} /></th>
                  <th {...sortable('r_factor')}>R-Factor <SortIcon active={view.sort.key === 'r_factor'} dir={view.sort.dir} /></th>
                  <th style={th(false)}>Codec</th>
                  <th style={th(false)}>Status</th>
                  <th style={th(false)}>Hangup Cause</th>
                </tr>
              </thead>
              <tbody>
                {view.pageItems.length === 0 && (
                  <tr>
                    <td colSpan={13} style={{ padding: '32px 0', textAlign: 'center', color: GLASS.textMuted, fontSize: '0.82rem' }}>
                      {view.filteredCount === 0 && cdrs.length === 0
                        ? 'No CDR records found. Adjust the filters and search.'
                        : 'No records match your search.'}
                    </td>
                  </tr>
                )}
                {view.pageItems.map((cdr, idx) => {
                  const answered = cdr.answer_time != null;
                  const startDt = new Date(cdr.start_time);
                  const isSelected = cdr.uuid === selectedUuid;
                  const customerName = view.customerMap.get(cdr.customer_id) ?? `#${cdr.customer_id}`;
                  const dirColor = cdr.direction === 'inbound' ? GLASS.accent : '#c084fc';

                  return (
                    <tr key={cdr.uuid} onClick={() => onSelect(cdr)} style={rowStyle(isSelected, idx % 2 === 0)}>
                      {/* Date/Time */}
                      <td style={{ ...tdBase, whiteSpace: 'nowrap' }}>
                        <div style={{ color: GLASS.text, fontVariantNumeric: 'tabular-nums', fontSize: '0.72rem' }}>
                          {startDt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </div>
                        <div style={{ color: GLASS.textMuted, fontSize: '0.68rem', fontVariantNumeric: 'tabular-nums' }}>
                          {startDt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                        </div>
                      </td>

                      {/* Customer */}
                      <td style={{ ...tdBase, color: '#94a3b8', fontSize: '0.72rem', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {customerName}
                      </td>

                      {/* Direction */}
                      <td style={tdBase}>
                        <span style={badge(dirColor)}>{cdr.direction === 'inbound' ? 'In' : 'Out'}</span>
                      </td>

                      {/* From */}
                      <td style={{ ...tdBase, fontFamily: MONO, color: '#94a3b8', whiteSpace: 'nowrap', fontSize: '0.72rem' }}>
                        {cdr.caller_id || '—'}
                      </td>

                      {/* To */}
                      <td style={{ ...tdBase, fontFamily: MONO, color: '#94a3b8', whiteSpace: 'nowrap', fontSize: '0.72rem' }}>
                        {cdr.destination}
                      </td>

                      {/* Duration */}
                      <td style={{ ...tdBase, fontVariantNumeric: 'tabular-nums', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                        {fmtDuration(cdr.duration_seconds)}
                      </td>

                      {/* MOS */}
                      <td style={tdBase}>
                        {cdr.mos != null ? (
                          <span style={{ ...metricPill(mosColor(cdr.mos)), background: mosBg(cdr.mos) }}>{cdr.mos.toFixed(2)}</span>
                        ) : (
                          <span style={{ color: GLASS.textFaint }}>—</span>
                        )}
                      </td>

                      {/* Packet Loss */}
                      <td style={{ ...tdBase, fontVariantNumeric: 'tabular-nums', color: cdr.packet_loss_pct != null ? packetLossColor(cdr.packet_loss_pct) : GLASS.textFaint }}>
                        {cdr.packet_loss_pct != null ? `${cdr.packet_loss_pct.toFixed(2)}%` : '—'}
                      </td>

                      {/* Jitter */}
                      <td style={{ ...tdBase, fontVariantNumeric: 'tabular-nums', color: cdr.jitter_avg_ms != null ? jitterColor(cdr.jitter_avg_ms) : GLASS.textFaint }}>
                        {cdr.jitter_avg_ms != null ? `${cdr.jitter_avg_ms.toFixed(1)}ms` : '—'}
                      </td>

                      {/* R-Factor */}
                      <td style={{ ...tdBase, fontVariantNumeric: 'tabular-nums', color: rFactorColor(cdr.r_factor) }}>
                        {cdr.r_factor != null ? cdr.r_factor.toFixed(1) : '—'}
                      </td>

                      {/* Codec */}
                      <td style={{ ...tdBase, fontFamily: MONO, color: GLASS.textMuted, fontSize: '0.68rem', whiteSpace: 'nowrap' }}>
                        {cdr.read_codec ?? '—'}
                      </td>

                      {/* Status */}
                      <td style={tdBase}>
                        <span style={badge(answered ? GLASS.success : GLASS.danger)}>{answered ? 'Ans' : 'N/A'}</span>
                      </td>

                      {/* Hangup Cause */}
                      <td style={{ ...tdBase, color: GLASS.textMuted, fontFamily: MONO, fontSize: '0.68rem', whiteSpace: 'nowrap' }}>
                        {cdr.hangup_cause ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {view.pageCount > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
              <button disabled={view.page === 0} onClick={() => view.setPage(Math.max(0, view.page - 1))} style={paginationBtn(view.page === 0)}>
                ← Prev
              </button>
              <span style={{ fontSize: '0.72rem', color: GLASS.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                {view.page + 1} / {view.pageCount}
              </span>
              <button disabled={view.page >= view.pageCount - 1} onClick={() => view.setPage(Math.min(view.pageCount - 1, view.page + 1))} style={paginationBtn(view.page >= view.pageCount - 1)}>
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </GlassPanel>
  );
}
