/**
 * CallQualityPage — Platform-wide SIP call quality analysis tool.
 *
 * Daylight console treatment (see the RCF CONSOLE / DAYLIGHT CONSOLE blocks in
 * index.css and the page-scoped `dlx-*` primitives in styles/dl-call-quality.css).
 *
 * Sections:
 *   1. Quiet header — breadcrumb, Archivo title, inline metrics off loaded data
 *   2. Filter toolbar — customer, trunk, number search, direction, dates, product
 *   3. Quality overview stat strip — Total Calls, ASR, MOS, Packet Loss, Jitter, R-Factor
 *   4. Quality trend charts — MOS, Packet Loss, Jitter daily averages via the
 *      shared <QualityTrendChart> (true-pixel SVG, honest gap rendering —
 *      see components/charts/)
 *   5. Full CDR table — sortable, searchable, paginated with quality columns
 *   6. Call detail sheet — white elevated slide-out with full RTP/quality/billing data
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchCdrs, getCdr } from '../api/cdrs';
import { listCustomers } from '../api/customers';
import { listTrunks } from '../api/trunks';
import { Spinner } from '../components/ui/Spinner';
import { AttestationChain } from '../components/stir/AttestationChain';
import { QualityTrendChart } from '../components/charts/QualityTrendChart';
import type { TrendDomain, TrendPoint } from '../components/charts/QualityTrendChart';
import type { Cdr, CallDirection, ProductType } from '../types/cdr';
import type { Customer } from '../types/customer';
import type { Trunk } from '../types/trunk';
import '../styles/dl-call-quality.css';

// ---------------------------------------------------------------------------
// Daylight palette constants (mirror the .dl-scope CSS vars for inline SVG etc.)
// ---------------------------------------------------------------------------

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

const INK_SOFT = '#46566f';
const INK_DIM = '#5d6f8c';
const INK_FAINT = '#8b99b0';
const AZURE_DEEP = '#1d63dd';

// Status colors — quality semantics only (never decoration). Ink-dark variants
// tuned for legibility on the white paper canvas.
const GOOD = '#15803d';
const WARN = '#b45309';
const BAD = '#b91c1c';

// Trend-chart series strokes — semantic families (MOS green, packet loss
// rose, jitter azure).
const CHART_GREEN = '#16a34a';
const CHART_ROSE = '#be123c';
const CHART_AZURE = AZURE_DEEP;

// ---------------------------------------------------------------------------
// Quality colour helpers — red/amber/green status semantics
// ---------------------------------------------------------------------------

function mosColor(mos: number | null | undefined): string {
  if (mos == null) return INK_FAINT;
  if (mos >= 4.0) return GOOD;
  if (mos >= 3.5) return WARN;
  return BAD;
}

interface QualityTone {
  text: string;
  bg: string;
  border: string;
}

/** Translucent pill tone for a MOS value on the white canvas. */
function mosTone(mos: number | null | undefined): QualityTone {
  if (mos == null) return { text: INK_FAINT, bg: 'rgba(93,111,140,0.08)', border: 'rgba(93,111,140,0.2)' };
  if (mos >= 4.0) return { text: GOOD, bg: 'rgba(22,163,74,0.1)', border: 'rgba(22,163,74,0.26)' };
  if (mos >= 3.5) return { text: WARN, bg: 'rgba(180,83,9,0.09)', border: 'rgba(180,83,9,0.26)' };
  return { text: BAD, bg: 'rgba(220,38,38,0.07)', border: 'rgba(220,38,38,0.26)' };
}

function rFactorColor(r: number | null | undefined): string {
  if (r == null) return INK_FAINT;
  if (r >= 80) return GOOD;
  if (r >= 60) return WARN;
  return BAD;
}

function packetLossColor(pct: number | null | undefined): string {
  if (pct == null) return INK_FAINT;
  if (pct <= 1) return GOOD;
  if (pct <= 5) return WARN;
  return BAD;
}

function jitterColor(ms: number | null | undefined): string {
  if (ms == null) return INK_FAINT;
  if (ms <= 20) return GOOD;
  if (ms <= 50) return WARN;
  return BAD;
}

function fmtDuration(sec: number): string {
  if (sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Quality trend chart configuration — y-domains + formatters.
// MOS renders on its fixed 1–5 scale; packet loss and jitter auto-scale
// (padded to the data). Module-scope constants so the chart's geometry memo
// keeps stable inputs.
// ---------------------------------------------------------------------------

const MOS_DOMAIN: TrendDomain = { min: 1, max: 5 };
const LOSS_DOMAIN: TrendDomain = { min: 0, max: 'auto' };
const JITTER_DOMAIN: TrendDomain = { min: 0, max: 'auto' };

const fmtMosValue = (v: number): string => v.toFixed(2);
const fmtMosTick = (v: number): string => String(Math.round(v));
const fmtLossValue = (v: number): string => `${v.toFixed(2)}%`;
const fmtLossTick = (v: number): string => `${parseFloat(v.toFixed(3))}%`;
const fmtJitterValue = (v: number): string => `${v.toFixed(1)} ms`;
const fmtJitterTick = (v: number): string => `${parseFloat(v.toFixed(1))}`;

// ---------------------------------------------------------------------------
// Build daily quality buckets from CDR array — one slot for EVERY day of the
// selected range (continuous axis; days without data stay null and render as
// honest gaps), plus per-day sample counts so the chart tooltips can show
// how many calls each average summarizes.
// ---------------------------------------------------------------------------

interface DailyQuality {
  date: string;
  /** All CDRs bucketed to this day (answered or not). */
  totalCalls: number;
  avgMos: number | null;
  mosCount: number;
  avgPacketLossPct: number | null;
  plCount: number;
  avgJitterMs: number | null;
  jCount: number;
}

function buildDailyQuality(cdrs: Cdr[], startDate: Date, endDate: Date): DailyQuality[] {
  const byDate = new Map<string, { calls: number; mosSum: number; mosCount: number; plSum: number; plCount: number; jSum: number; jCount: number }>();

  for (const cdr of cdrs) {
    const key = cdr.start_time.slice(0, 10);
    const bucket = byDate.get(key) ?? { calls: 0, mosSum: 0, mosCount: 0, plSum: 0, plCount: 0, jSum: 0, jCount: 0 };
    bucket.calls++;
    if (cdr.mos != null) { bucket.mosSum += cdr.mos; bucket.mosCount++; }
    if (cdr.packet_loss_pct != null) { bucket.plSum += cdr.packet_loss_pct; bucket.plCount++; }
    if (cdr.jitter_avg_ms != null) { bucket.jSum += cdr.jitter_avg_ms; bucket.jCount++; }
    byDate.set(key, bucket);
  }

  const slots: DailyQuality[] = [];
  const msPerDay = 86400000;
  const dayCount = Math.round((endDate.getTime() - startDate.getTime()) / msPerDay);

  // Cover the FULL selected range (the old 60-day cap silently truncated the
  // axis); 365 is a defensive ceiling against absurd ranges.
  for (let i = 0; i <= Math.min(dayCount, 365); i++) {
    const key = new Date(startDate.getTime() + i * msPerDay).toISOString().slice(0, 10);
    const b = byDate.get(key);
    slots.push({
      date: key,
      totalCalls: b?.calls ?? 0,
      avgMos: b && b.mosCount > 0 ? b.mosSum / b.mosCount : null,
      mosCount: b?.mosCount ?? 0,
      avgPacketLossPct: b && b.plCount > 0 ? b.plSum / b.plCount : null,
      plCount: b?.plCount ?? 0,
      avgJitterMs: b && b.jCount > 0 ? b.jSum / b.jCount : null,
      jCount: b?.jCount ?? 0,
    });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Overview stats
// ---------------------------------------------------------------------------

interface OverviewStats {
  totalCalls: number;
  answeredCalls: number;
  asr: number;
  avgMos: number | null;
  avgPacketLossPct: number | null;
  avgJitterMs: number | null;
  avgRFactor: number | null;
}

function computeOverviewStats(cdrs: Cdr[]): OverviewStats {
  let answered = 0;
  let mosSum = 0; let mosCount = 0;
  let plSum = 0; let plCount = 0;
  let jSum = 0; let jCount = 0;
  let rSum = 0; let rCount = 0;

  for (const cdr of cdrs) {
    if (cdr.answer_time != null) answered++;
    if (cdr.mos != null) { mosSum += cdr.mos; mosCount++; }
    if (cdr.packet_loss_pct != null) { plSum += cdr.packet_loss_pct; plCount++; }
    if (cdr.jitter_avg_ms != null) { jSum += cdr.jitter_avg_ms; jCount++; }
    if (cdr.r_factor != null) { rSum += cdr.r_factor; rCount++; }
  }

  return {
    totalCalls: cdrs.length,
    answeredCalls: answered,
    asr: cdrs.length > 0 ? Math.round((answered / cdrs.length) * 100) : 0,
    avgMos: mosCount > 0 ? mosSum / mosCount : null,
    avgPacketLossPct: plCount > 0 ? plSum / plCount : null,
    avgJitterMs: jCount > 0 ? jSum / jCount : null,
    avgRFactor: rCount > 0 ? rSum / rCount : null,
  };
}

interface StatFigureProps {
  label: string;
  value: React.ReactNode;
  /** Value + keyline color. Status colors read as status; anything else renders neutral. */
  color?: string;
  dim?: boolean;
}

/** One left-keyline figure in the quality stat strip. Status colors carry
    onto the keyline; informational figures keep the default azure (or the
    quiet neutral hairline when `dim`). */
function StatFigure({ label, value, color, dim = false }: StatFigureProps) {
  const isStatus = color === GOOD || color === WARN || color === BAD;
  // No-data figures (faint em-dash) drop to the quiet neutral keyline too.
  const isDim = dim || color === INK_FAINT;
  return (
    <div
      className={isDim ? 'dlx-stat dlx-stat-dim' : 'dlx-stat'}
      style={isStatus && !isDim ? { borderLeftColor: color } : undefined}
    >
      <div className="dlx-stat-value" style={color ? { color } : undefined}>{value}</div>
      <div className="dlx-stat-label">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CDR Table (sortable, searchable, paginated)
// ---------------------------------------------------------------------------

type SortKey = 'start_time' | 'duration_seconds' | 'mos' | 'packet_loss_pct' | 'jitter_avg_ms' | 'r_factor';

interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

interface CdrTableProps {
  cdrs: Cdr[];
  customers: Customer[];
  onSelect: (cdr: Cdr) => void;
  selectedUuid: string | null;
}

/** Sort direction glyph for a sortable column header. */
function SortGlyph({ colKey, sort }: { colKey: SortKey; sort: SortState }) {
  if (sort.key !== colKey) return <span style={{ color: '#b6c2d4', marginLeft: 3 }}>↕</span>;
  return <span style={{ color: AZURE_DEEP, marginLeft: 3 }}>{sort.dir === 'asc' ? '↑' : '↓'}</span>;
}

function CdrTable({ cdrs, customers, onSelect, selectedUuid }: CdrTableProps) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'start_time', dir: 'desc' });
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const customerMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of customers) m.set(c.id, c.name);
    return m;
  }, [customers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cdrs;
    return cdrs.filter((c) =>
      c.caller_id.toLowerCase().includes(q) ||
      c.destination.toLowerCase().includes(q) ||
      (c.hangup_cause ?? '').toLowerCase().includes(q) ||
      c.uuid.toLowerCase().includes(q) ||
      c.direction.includes(q) ||
      (c.read_codec ?? '').toLowerCase().includes(q) ||
      (customerMap.get(c.customer_id) ?? '').toLowerCase().includes(q)
    );
  }, [cdrs, search, customerMap]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: number | string | null;
      let bv: number | string | null;
      switch (sort.key) {
        case 'start_time': av = a.start_time; bv = b.start_time; break;
        case 'duration_seconds': av = a.duration_seconds; bv = b.duration_seconds; break;
        case 'mos': av = a.mos ?? -1; bv = b.mos ?? -1; break;
        case 'packet_loss_pct': av = a.packet_loss_pct ?? -1; bv = b.packet_loss_pct ?? -1; break;
        case 'jitter_avg_ms': av = a.jitter_avg_ms ?? -1; bv = b.jitter_avg_ms ?? -1; break;
        case 'r_factor': av = a.r_factor ?? -1; bv = b.r_factor ?? -1; break;
        default: av = a.start_time; bv = b.start_time;
      }
      const cmp = av! < bv! ? -1 : av! > bv! ? 1 : 0;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sort]);

  const pageCount = Math.ceil(sorted.length / PAGE_SIZE);
  const pageItems = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'desc' }
    );
    setPage(0);
  }

  const thClass = (key?: SortKey): string => {
    if (!key) return 'dl-th';
    return sort.key === key ? 'dl-th dlx-th-sort dlx-th-active' : 'dl-th dlx-th-sort';
  };

  return (
    <>
      {/* Search + record count toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 20px',
          borderBottom: '1px solid var(--rcf-line)',
          background: 'var(--rcf-tint)',
        }}
      >
        <div style={{ position: 'relative', flex: 1, maxWidth: 380 }}>
          <SearchIcon />
          <input
            type="text"
            placeholder="Search by number, UUID, customer, codec, cause…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="dl-input"
            style={{ width: '100%', padding: '7px 12px 7px 32px', fontSize: '0.8rem' }}
          />
        </div>
        <span style={{ fontSize: '0.72rem', color: INK_DIM, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {filtered.length.toLocaleString()} records
        </span>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem', color: INK_SOFT }}>
          <thead>
            <tr>
              <th className={thClass('start_time')} style={{ padding: '10px 12px' }} onClick={() => toggleSort('start_time')}>Date / Time <SortGlyph colKey="start_time" sort={sort} /></th>
              <th className={thClass()} style={{ padding: '10px 12px' }}>Customer</th>
              <th className={thClass()} style={{ padding: '10px 12px' }}>Dir</th>
              <th className={thClass()} style={{ padding: '10px 12px' }}>From</th>
              <th className={thClass()} style={{ padding: '10px 12px' }}>To</th>
              <th className={thClass('duration_seconds')} style={{ padding: '10px 12px' }} onClick={() => toggleSort('duration_seconds')}>Duration <SortGlyph colKey="duration_seconds" sort={sort} /></th>
              <th className={thClass('mos')} style={{ padding: '10px 12px' }} onClick={() => toggleSort('mos')}>MOS <SortGlyph colKey="mos" sort={sort} /></th>
              <th className={thClass('packet_loss_pct')} style={{ padding: '10px 12px' }} onClick={() => toggleSort('packet_loss_pct')}>Pkt Loss <SortGlyph colKey="packet_loss_pct" sort={sort} /></th>
              <th className={thClass('jitter_avg_ms')} style={{ padding: '10px 12px' }} onClick={() => toggleSort('jitter_avg_ms')}>Jitter <SortGlyph colKey="jitter_avg_ms" sort={sort} /></th>
              <th className={thClass('r_factor')} style={{ padding: '10px 12px' }} onClick={() => toggleSort('r_factor')}>R-Factor <SortGlyph colKey="r_factor" sort={sort} /></th>
              <th className={thClass()} style={{ padding: '10px 12px' }}>Codec</th>
              <th className={thClass()} style={{ padding: '10px 12px' }}>Status</th>
              <th className={thClass()} style={{ padding: '10px 12px' }}>Hangup Cause</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 && (
              <tr>
                <td colSpan={13} style={{ padding: '20px' }}>
                  <div className="dl-empty">
                    {filtered.length === 0 && cdrs.length === 0
                      ? 'No CDR records found. Adjust the filters and search.'
                      : 'No records match your search.'}
                  </div>
                </td>
              </tr>
            )}
            {pageItems.map((cdr) => {
              const answered = cdr.answer_time != null;
              const startDt = new Date(cdr.start_time);
              const isSelected = cdr.uuid === selectedUuid;
              const customerName = customerMap.get(cdr.customer_id) ?? `#${cdr.customer_id}`;
              const tone = mosTone(cdr.mos);

              return (
                <tr
                  key={cdr.uuid}
                  className={isSelected ? 'dl-row dlx-row-active' : 'dl-row'}
                  onClick={() => onSelect(cdr)}
                  style={{ cursor: 'pointer' }}
                >
                  {/* Date/Time */}
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                    <div style={{ color: INK_SOFT, fontVariantNumeric: 'tabular-nums', fontSize: '0.74rem', fontWeight: 600 }}>
                      {startDt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </div>
                    <div style={{ color: INK_DIM, fontSize: '0.68rem', fontVariantNumeric: 'tabular-nums' }}>
                      {startDt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                    </div>
                  </td>

                  {/* Customer */}
                  <td style={{ padding: '8px 12px', color: INK_SOFT, fontSize: '0.74rem', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {customerName}
                  </td>

                  {/* Direction */}
                  <td style={{ padding: '8px 12px' }}>
                    <span className={cdr.direction === 'inbound' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>
                      {cdr.direction === 'inbound' ? 'In' : 'Out'}
                    </span>
                  </td>

                  {/* From */}
                  <td style={{ padding: '8px 12px', fontFamily: MONO, color: INK_SOFT, whiteSpace: 'nowrap', fontSize: '0.74rem', fontWeight: 500 }}>
                    {cdr.caller_id || '—'}
                  </td>

                  {/* To */}
                  <td style={{ padding: '8px 12px', fontFamily: MONO, color: AZURE_DEEP, whiteSpace: 'nowrap', fontSize: '0.74rem', fontWeight: 600 }}>
                    {cdr.destination}
                  </td>

                  {/* Duration */}
                  <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums', color: INK_DIM, whiteSpace: 'nowrap' }}>
                    {fmtDuration(cdr.duration_seconds)}
                  </td>

                  {/* MOS */}
                  <td style={{ padding: '8px 12px' }}>
                    {cdr.mos != null ? (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 20,
                          background: tone.bg,
                          border: `1px solid ${tone.border}`,
                          color: tone.text,
                          fontVariantNumeric: 'tabular-nums',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {cdr.mos.toFixed(2)}
                      </span>
                    ) : (
                      <span style={{ color: '#b6c2d4' }}>—</span>
                    )}
                  </td>

                  {/* Packet Loss */}
                  <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: cdr.packet_loss_pct != null ? packetLossColor(cdr.packet_loss_pct) : '#b6c2d4' }}>
                    {cdr.packet_loss_pct != null ? `${cdr.packet_loss_pct.toFixed(2)}%` : '—'}
                  </td>

                  {/* Jitter */}
                  <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: cdr.jitter_avg_ms != null ? jitterColor(cdr.jitter_avg_ms) : '#b6c2d4' }}>
                    {cdr.jitter_avg_ms != null ? `${cdr.jitter_avg_ms.toFixed(1)}ms` : '—'}
                  </td>

                  {/* R-Factor */}
                  <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: cdr.r_factor != null ? rFactorColor(cdr.r_factor) : '#b6c2d4' }}>
                    {cdr.r_factor != null ? cdr.r_factor.toFixed(1) : '—'}
                  </td>

                  {/* Codec */}
                  <td style={{ padding: '8px 12px', fontFamily: MONO, color: INK_DIM, fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                    {cdr.read_codec ?? '—'}
                  </td>

                  {/* Status */}
                  <td style={{ padding: '8px 12px' }}>
                    <span className={answered ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
                      {answered ? 'Ans' : 'N/A'}
                    </span>
                  </td>

                  {/* Hangup Cause */}
                  <td style={{ padding: '8px 12px', color: INK_DIM, fontFamily: MONO, fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                    {cdr.hangup_cause ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            justifyContent: 'center',
            padding: '12px 20px',
            borderTop: '1px solid var(--rcf-line)',
          }}
        >
          <button
            type="button"
            className="dlx-pgbtn"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← Prev
          </button>
          <span style={{ fontSize: '0.74rem', color: INK_DIM, fontVariantNumeric: 'tabular-nums' }}>
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="dlx-pgbtn"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >
            Next →
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Call Detail Sheet (slide-out white panel)
// ---------------------------------------------------------------------------

interface CallDetailPanelProps {
  cdr: Cdr;
  onClose: () => void;
}

function DetailRow({ label, value, mono = false, accent }: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  accent?: string;
}) {
  return (
    <div className="dlx-drow">
      <span className="dlx-drow-label">{label}</span>
      <span
        className="dlx-drow-value"
        style={{
          color: accent,
          fontFamily: mono ? MONO : undefined,
          fontWeight: accent ? 700 : undefined,
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="dlx-sheet-section">
      <div className="dlx-sheet-section-title">{title}</div>
      {children}
    </div>
  );
}

function BigMetric({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="dl-tile" style={{ flex: '1 1 100px', padding: '12px 14px' }}>
      <div className="dl-tile-label">{label}</div>
      <div className="dl-tile-value" style={{ color, fontSize: '1.5rem' }}>{value}</div>
      {sub && <div className="dl-tile-hint">{sub}</div>}
    </div>
  );
}

function CallDetailPanel({ cdr, onClose }: CallDetailPanelProps) {
  const { data: detail, isLoading } = useQuery({
    queryKey: ['cdr', cdr.uuid],
    queryFn: () => getCdr(cdr.uuid),
    initialData: cdr,
    staleTime: 30_000,
  });

  const d = detail ?? cdr;

  const sipCodeStr = d.sip_code != null ? String(d.sip_code) : null;
  const billableFmt = d.billable_seconds > 0 ? fmtDuration(d.billable_seconds) : '—';
  const costFmt = d.total_cost != null ? `$${d.total_cost.toFixed(4)}` : '—';
  const rateFmt = d.rate_per_min != null ? `$${d.rate_per_min.toFixed(4)}/min` : '—';

  return (
    <div className="dlx-sheet-backdrop" onClick={onClose}>
      <div className="dlx-sheet" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="dlx-sheet-head">
          <div style={{ minWidth: 0 }}>
            <div className="dlx-sheet-eyebrow">Call Detail</div>
            <div style={{ fontFamily: MONO, fontSize: '0.7rem', color: INK_DIM, wordBreak: 'break-all', marginTop: 6 }}>
              {d.uuid}
            </div>
          </div>
          <button type="button" className="dlx-sheet-close" onClick={onClose} aria-label="Close panel">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 12, height: 12 }}>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Loading indicator */}
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 22px', fontSize: '0.75rem', color: INK_DIM, borderBottom: '1px solid var(--rcf-line-soft)' }}>
            <Spinner size="xs" /> Fetching full detail…
          </div>
        )}

        {/* Body */}
        <div style={{ padding: '20px 22px', flex: 1 }}>
          {/* Big quality metrics */}
          {(d.mos != null || d.r_factor != null) && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 22, flexWrap: 'wrap' }}>
              {d.mos != null && (
                <BigMetric
                  label="MOS Score"
                  value={d.mos.toFixed(2)}
                  sub={d.mos >= 4.0 ? 'Excellent' : d.mos >= 3.5 ? 'Good' : 'Poor'}
                  color={mosColor(d.mos)}
                />
              )}
              {d.r_factor != null && (
                <BigMetric
                  label="R-Factor"
                  value={d.r_factor.toFixed(1)}
                  sub={d.r_factor >= 80 ? 'Good' : d.r_factor >= 60 ? 'Fair' : 'Poor'}
                  color={rFactorColor(d.r_factor)}
                />
              )}
              {d.quality_pct != null && (
                <BigMetric
                  label="Quality %"
                  value={`${d.quality_pct.toFixed(1)}%`}
                  color={d.quality_pct >= 80 ? GOOD : d.quality_pct >= 60 ? WARN : BAD}
                />
              )}
            </div>
          )}

          <PanelSection title="Call Info">
            <DetailRow label="UUID" value={d.uuid} mono />
            <DetailRow label="Direction" value={
              <span className={d.direction === 'inbound' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>
                {d.direction}
              </span>
            } />
            <DetailRow label="Product Type" value={d.product_type} />
            <DetailRow label="Trunk ID" value={d.trunk_id} mono />
            <DetailRow label="Caller ID" value={d.caller_id} mono />
            <DetailRow label="Destination" value={d.destination} mono />
            <DetailRow label="Start Time" value={new Date(d.start_time).toLocaleString()} />
            <DetailRow label="Answer Time" value={d.answer_time ? new Date(d.answer_time).toLocaleString() : null} />
            <DetailRow label="End Time" value={d.end_time ? new Date(d.end_time).toLocaleString() : null} />
            <DetailRow label="Duration" value={fmtDuration(d.duration_seconds)} />
            <DetailRow label="Billable Duration" value={billableFmt} />
            <DetailRow label="Hangup Cause" value={d.hangup_cause} mono />
            <DetailRow label="SIP Code" value={sipCodeStr} />
            <DetailRow label="Carrier Used" value={d.carrier_used} />
            <DetailRow label="Traffic Grade" value={d.traffic_grade} />
          </PanelSection>

          <PanelSection title="STIR / SHAKEN">
            <AttestationChain callId={d.uuid} />
          </PanelSection>

          {(d.mos != null || d.r_factor != null || d.flaw_total != null || d.packet_loss_pct != null) && (
            <PanelSection title="Quality Metrics">
              {d.mos != null && <DetailRow label="MOS Score" value={d.mos.toFixed(3)} accent={mosColor(d.mos)} />}
              {d.r_factor != null && <DetailRow label="R-Factor" value={d.r_factor.toFixed(2)} accent={rFactorColor(d.r_factor)} />}
              {d.quality_pct != null && <DetailRow label="Quality %" value={`${d.quality_pct.toFixed(2)}%`} />}
              {d.flaw_total != null && <DetailRow label="Flaw Total" value={d.flaw_total.toLocaleString()} />}
              {d.packet_loss_count != null && <DetailRow label="Packets Lost" value={d.packet_loss_count.toLocaleString()} />}
              {d.packet_total_count != null && <DetailRow label="Packets Total" value={d.packet_total_count.toLocaleString()} />}
              {d.packet_loss_pct != null && (
                <DetailRow label="Packet Loss %" value={`${d.packet_loss_pct.toFixed(3)}%`} accent={packetLossColor(d.packet_loss_pct)} />
              )}
            </PanelSection>
          )}

          {(d.rtp_audio_in_raw_bytes != null || d.rtp_audio_out_raw_bytes != null || d.jitter_avg_ms != null) && (
            <PanelSection title="RTP Statistics">
              {(d.rtp_audio_in_raw_bytes != null || d.rtp_audio_in_packet_count != null) && (
                <div style={{ marginBottom: 12 }}>
                  <div className="dlx-sheet-subhead">Audio In (from carrier)</div>
                  {d.rtp_audio_in_raw_bytes != null && <DetailRow label="Raw Bytes" value={fmtBytes(d.rtp_audio_in_raw_bytes)} />}
                  {d.rtp_audio_in_media_bytes != null && <DetailRow label="Media Bytes" value={fmtBytes(d.rtp_audio_in_media_bytes)} />}
                  {d.rtp_audio_in_packet_count != null && <DetailRow label="Packets" value={d.rtp_audio_in_packet_count.toLocaleString()} />}
                  {d.packet_loss_count != null && <DetailRow label="Skipped (lost)" value={d.packet_loss_count.toLocaleString()} />}
                </div>
              )}
              {(d.rtp_audio_out_raw_bytes != null || d.rtp_audio_out_packet_count != null) && (
                <div style={{ marginBottom: 12 }}>
                  <div className="dlx-sheet-subhead">Audio Out (to carrier)</div>
                  {d.rtp_audio_out_raw_bytes != null && <DetailRow label="Raw Bytes" value={fmtBytes(d.rtp_audio_out_raw_bytes)} />}
                  {d.rtp_audio_out_media_bytes != null && <DetailRow label="Media Bytes" value={fmtBytes(d.rtp_audio_out_media_bytes)} />}
                  {d.rtp_audio_out_packet_count != null && <DetailRow label="Packets" value={d.rtp_audio_out_packet_count.toLocaleString()} />}
                </div>
              )}
              {(d.jitter_min_ms != null || d.jitter_max_ms != null || d.jitter_avg_ms != null) && (
                <div style={{ marginBottom: 12 }}>
                  <div className="dlx-sheet-subhead">Jitter</div>
                  {d.jitter_min_ms != null && <DetailRow label="Min" value={`${d.jitter_min_ms.toFixed(2)}ms`} />}
                  {d.jitter_max_ms != null && <DetailRow label="Max" value={`${d.jitter_max_ms.toFixed(2)}ms`} />}
                  {d.jitter_avg_ms != null && <DetailRow label="Avg (mean interval)" value={`${d.jitter_avg_ms.toFixed(2)}ms`} />}
                  {d.rtp_audio_in_mean_interval != null && <DetailRow label="Mean Interval" value={`${d.rtp_audio_in_mean_interval.toFixed(2)}ms`} />}
                  {d.rtp_audio_in_jitter_burst_rate != null && <DetailRow label="Jitter Burst Rate" value={d.rtp_audio_in_jitter_burst_rate.toFixed(4)} />}
                  {d.rtp_audio_in_jitter_loss_rate != null && <DetailRow label="Jitter Loss Rate" value={d.rtp_audio_in_jitter_loss_rate.toFixed(4)} />}
                </div>
              )}
              {(d.read_codec != null || d.write_codec != null) && (
                <div>
                  <div className="dlx-sheet-subhead">Codecs</div>
                  {d.read_codec != null && <DetailRow label="Read Codec" value={d.read_codec} mono />}
                  {d.write_codec != null && <DetailRow label="Write Codec" value={d.write_codec} mono />}
                </div>
              )}
            </PanelSection>
          )}

          <PanelSection title="Billing">
            <DetailRow label="Rate / Min" value={rateFmt} />
            <DetailRow label="Total Cost" value={costFmt} />
          </PanelSection>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

interface FilterState {
  customerId: number | null;
  trunkId: number | null;
  numberSearch: string;
  direction: CallDirection | 'all';
  startDate: string;
  endDate: string;
  productType: ProductType | 'all';
}

function getDefaultFilters(): FilterState {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  return {
    customerId: null,
    trunkId: null,
    numberSearch: '',
    direction: 'all',
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    productType: 'all',
  };
}

// ---------------------------------------------------------------------------
// Segmented pill selector
// ---------------------------------------------------------------------------

interface PillOption<T extends string> {
  value: T;
  label: string;
}

interface PillSelectorProps<T extends string> {
  options: PillOption<T>[];
  value: T;
  onChange: (v: T) => void;
}

function PillSelector<T extends string>({ options, value, onChange }: PillSelectorProps<T>) {
  return (
    <div className="dlx-seg">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={active ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quiet page header — breadcrumb, Archivo title, inline metrics off data the
// page already loads (no extra API calls). Metrics show em-dashes until the
// CDR search resolves.
// ---------------------------------------------------------------------------

interface PageHeaderProps {
  stats: OverviewStats;
  loaded: boolean;
}

function CallQualityHeader({ stats, loaded }: PageHeaderProps) {
  return (
    <header className="dl-header fx-load">
      <div className="dl-header-id">
        <div className="dl-crumb">
          <span>Call Quality</span>
          <span className="dl-crumb-sep" aria-hidden="true">/</span>
          <span>Granite CRAG</span>
        </div>
        <h1 className="dl-title">Call Quality</h1>
        <p className="dl-sub">
          Platform-wide SIP call analysis — MOS, packet loss, jitter, and RTP diagnostics for every call.
        </p>
      </div>

      <div className="dl-metrics">
        <div className="dl-metric">
          <div className="dl-metric-value">{loaded ? stats.totalCalls.toLocaleString() : '—'}</div>
          <div className="dl-metric-label">Calls</div>
        </div>
        <div className="dl-metric">
          <div className="dl-metric-value">{loaded && stats.totalCalls > 0 ? `${stats.asr}%` : '—'}</div>
          <div className="dl-metric-label">ASR</div>
        </div>
        <div className="dl-metric">
          <div className="dl-metric-value">{loaded && stats.avgMos != null ? stats.avgMos.toFixed(2) : '—'}</div>
          <div className="dl-metric-label">Avg MOS</div>
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function CallQualityPage() {
  // ALL hooks unconditionally at top — rules of hooks (#310 prevention)
  const [filters, setFilters] = useState<FilterState>(getDefaultFilters);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(getDefaultFilters);
  const [selectedCdr, setSelectedCdr] = useState<Cdr | null>(null);

  // Fetch reference data for dropdowns
  const { data: customersData } = useQuery({
    queryKey: ['customers', 'all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 120_000,
  });

  const { data: trunksData } = useQuery({
    queryKey: ['trunks', 'all', filters.customerId],
    queryFn: () => listTrunks({ customer_id: filters.customerId ?? undefined, limit: 500 }),
    staleTime: 120_000,
  });

  const customers: Customer[] = customersData?.items ?? [];
  const trunks: Trunk[] = trunksData?.items ?? [];

  // When customer changes, reset trunk selection. Pre-existing behavior kept
  // verbatim through the daylight conversion (visual-only pass) — the lint
  // finding predates it and refactoring the filter flow is out of scope here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFilters((prev) => ({ ...prev, trunkId: null }));
  }, [filters.customerId]);

  // Build search params from applied filters. The API's declared params are
  // `start_date`/`end_date` (the old `start_from`/`start_to` names were
  // silently dropped by FastAPI → permanent last-24h default). Local
  // wall-clock day bounds are normalized to ISO UTC inside searchCdrs.
  const searchParams = useMemo(() => ({
    customer_id: appliedFilters.customerId ?? undefined,
    direction: appliedFilters.direction !== 'all' ? appliedFilters.direction : undefined,
    start_date: `${appliedFilters.startDate}T00:00:00`,
    end_date: `${appliedFilters.endDate}T23:59:59`,
    product_type: appliedFilters.productType !== 'all' ? appliedFilters.productType : undefined,
    limit: 1000,
  }), [appliedFilters]);

  const { data: cdrData, isLoading, isError, refetch } = useQuery({
    queryKey: ['callQualityCdrs', searchParams],
    queryFn: () => searchCdrs(searchParams),
    staleTime: 60_000,
  });

  // Client-side filter by trunk and number search
  const allCdrs: Cdr[] = useMemo(() => {
    let items = cdrData?.items ?? [];

    if (appliedFilters.trunkId != null) {
      const trunkStr = String(appliedFilters.trunkId);
      items = items.filter((c) => c.trunk_id === trunkStr);
    }

    if (appliedFilters.numberSearch.trim()) {
      const q = appliedFilters.numberSearch.trim().toLowerCase();
      items = items.filter((c) =>
        c.caller_id.includes(q) || c.destination.includes(q)
      );
    }

    return items;
  }, [cdrData, appliedFilters.trunkId, appliedFilters.numberSearch]);

  const overviewStats = useMemo(() => computeOverviewStats(allCdrs), [allCdrs]);

  const startDateObj = useMemo(() => new Date(`${appliedFilters.startDate}T00:00:00`), [appliedFilters.startDate]);
  const endDateObj = useMemo(() => new Date(`${appliedFilters.endDate}T23:59:59`), [appliedFilters.endDate]);

  const dailyQuality = useMemo(() => buildDailyQuality(allCdrs, startDateObj, endDateObj), [allCdrs, startDateObj, endDateObj]);

  // One TrendPoint series per metric — value + per-day sample size for the
  // chart tooltips ("N of M calls scored").
  const trendPoints = useMemo(() => ({
    mos: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.avgMos, sampleCount: d.mosCount, totalCalls: d.totalCalls })),
    loss: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.avgPacketLossPct, sampleCount: d.plCount, totalCalls: d.totalCalls })),
    jitter: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.avgJitterMs, sampleCount: d.jCount, totalCalls: d.totalCalls })),
  }), [dailyQuality]);

  const handleSelect = useCallback((cdr: Cdr) => {
    setSelectedCdr((prev) => (prev?.uuid === cdr.uuid ? null : cdr));
  }, []);

  const handleClose = useCallback(() => setSelectedCdr(null), []);

  function handleSearch() {
    setAppliedFilters({ ...filters });
  }

  function handleReset() {
    const defaults = getDefaultFilters();
    setFilters(defaults);
    setAppliedFilters(defaults);
  }

  const sectionLoading = (message: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: INK_DIM, fontSize: '0.82rem', padding: '20px' }}>
      <Spinner size="xs" /> {message}
    </div>
  );

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        {/* Quiet console header — breadcrumb, title, inline metrics, closing rule */}
        <CallQualityHeader stats={overviewStats} loaded={!isLoading && !isError} />

        <div className="dl-stack" style={{ paddingBottom: 24 }}>

          {/* ── Filter toolbar ─────────────────────────────────────── */}
          <div className="dl-panel fx-load fx-load-d1">
            <div className="dl-panel-head">
              <span className="dl-panel-title">Filters</span>
              {cdrData && (
                <span className="dl-count" style={{ marginLeft: 'auto' }}>
                  {allCdrs.length.toLocaleString()} of {cdrData.total.toLocaleString()} records
                </span>
              )}
            </div>
            <div className="dl-panel-body">
              <div className="dlx-filter-grid" style={{ marginBottom: 16 }}>
                {/* Customer */}
                <div>
                  <label className="dl-flabel" htmlFor="cq-customer">Customer</label>
                  <select
                    id="cq-customer"
                    value={filters.customerId ?? ''}
                    onChange={(e) => setFilters((p) => ({ ...p, customerId: e.target.value ? Number(e.target.value) : null }))}
                    className="dl-input"
                    style={{ width: '100%' }}
                  >
                    <option value="">All Customers</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>

                {/* Trunk */}
                <div>
                  <label className="dl-flabel" htmlFor="cq-trunk">Trunk</label>
                  <select
                    id="cq-trunk"
                    value={filters.trunkId ?? ''}
                    onChange={(e) => setFilters((p) => ({ ...p, trunkId: e.target.value ? Number(e.target.value) : null }))}
                    className="dl-input"
                    style={{ width: '100%' }}
                  >
                    <option value="">All Trunks</option>
                    {trunks.map((t) => (
                      <option key={t.id} value={t.id}>{t.trunk_name}</option>
                    ))}
                  </select>
                </div>

                {/* Number / DID search */}
                <div>
                  <label className="dl-flabel" htmlFor="cq-number">Number / DID</label>
                  <input
                    id="cq-number"
                    type="text"
                    placeholder="e.g. +14155551234"
                    value={filters.numberSearch}
                    onChange={(e) => setFilters((p) => ({ ...p, numberSearch: e.target.value }))}
                    className="dl-input dl-input-mono"
                    style={{ width: '100%' }}
                  />
                </div>

                {/* Start Date */}
                <div>
                  <label className="dl-flabel" htmlFor="cq-start">Start Date</label>
                  <input
                    id="cq-start"
                    type="date"
                    value={filters.startDate}
                    onChange={(e) => setFilters((p) => ({ ...p, startDate: e.target.value }))}
                    className="dl-input"
                    style={{ width: '100%', colorScheme: 'light' }}
                  />
                </div>

                {/* End Date */}
                <div>
                  <label className="dl-flabel" htmlFor="cq-end">End Date</label>
                  <input
                    id="cq-end"
                    type="date"
                    value={filters.endDate}
                    onChange={(e) => setFilters((p) => ({ ...p, endDate: e.target.value }))}
                    className="dl-input"
                    style={{ width: '100%', colorScheme: 'light' }}
                  />
                </div>
              </div>

              {/* Direction + Product type pills */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 32px', marginBottom: 18, alignItems: 'flex-start' }}>
                <div>
                  <div className="dl-flabel">Direction</div>
                  <PillSelector<CallDirection | 'all'>
                    options={[
                      { value: 'all', label: 'All' },
                      { value: 'inbound', label: 'Inbound' },
                      { value: 'outbound', label: 'Outbound' },
                    ]}
                    value={filters.direction}
                    onChange={(v) => setFilters((p) => ({ ...p, direction: v }))}
                  />
                </div>
                <div>
                  <div className="dl-flabel">Product Type</div>
                  <PillSelector<ProductType | 'all'>
                    options={[
                      { value: 'all', label: 'All' },
                      { value: 'rcf', label: 'RCF' },
                      { value: 'trunk', label: 'Trunk' },
                      { value: 'api', label: 'API' },
                    ]}
                    value={filters.productType}
                    onChange={(v) => setFilters((p) => ({ ...p, productType: v }))}
                  />
                </div>
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="dl-btn dl-btn-primary"
                  onClick={handleSearch}
                  disabled={isLoading}
                >
                  {isLoading ? <Spinner size="xs" /> : <SearchIconSmall />}
                  {isLoading ? 'Loading…' : 'Search'}
                </button>
                <button
                  type="button"
                  className="dl-btn dl-btn-ghost"
                  onClick={handleReset}
                >
                  Reset
                </button>
              </div>
            </div>
          </div>

          {/* ── Error state ────────────────────────────────────────── */}
          {isError && (
            <div className="dl-banner dl-banner-err" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span>Unable to load CDR data. The CDR service may be unavailable.</span>
              <button
                type="button"
                className="dl-btn dl-btn-danger"
                style={{ marginLeft: 'auto', padding: '5px 14px', fontSize: '0.76rem' }}
                onClick={() => refetch()}
              >
                Retry
              </button>
            </div>
          )}

          {/* ── Quality overview stat strip ────────────────────────── */}
          <div className="dl-panel fx-load fx-load-d2">
            <div className="dl-panel-head">
              <span className="dl-panel-title">Quality Overview</span>
            </div>
            {isLoading ? (
              sectionLoading('Computing metrics…')
            ) : (
              <div className="dl-panel-body">
                <div className="dlx-statline">
                  <StatFigure
                    label="Total calls"
                    value={overviewStats.totalCalls.toLocaleString()}
                    dim
                  />
                  <StatFigure
                    label={`ASR · ${overviewStats.answeredCalls.toLocaleString()} answered`}
                    value={overviewStats.totalCalls > 0 ? `${overviewStats.asr}%` : '—'}
                    color={AZURE_DEEP}
                  />
                  <StatFigure
                    label="MOS · voice quality"
                    value={overviewStats.avgMos != null ? overviewStats.avgMos.toFixed(2) : '—'}
                    color={mosColor(overviewStats.avgMos)}
                  />
                  <StatFigure
                    label="Avg packet loss"
                    value={overviewStats.avgPacketLossPct != null ? `${overviewStats.avgPacketLossPct.toFixed(2)}%` : '—'}
                    color={packetLossColor(overviewStats.avgPacketLossPct)}
                  />
                  <StatFigure
                    label="Avg jitter"
                    value={overviewStats.avgJitterMs != null ? `${overviewStats.avgJitterMs.toFixed(1)}ms` : '—'}
                    color={jitterColor(overviewStats.avgJitterMs)}
                  />
                  <StatFigure
                    label="Avg R-Factor"
                    value={overviewStats.avgRFactor != null ? overviewStats.avgRFactor.toFixed(1) : '—'}
                    color={rFactorColor(overviewStats.avgRFactor)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── Quality trends ─────────────────────────────────────── */}
          <div className="dl-panel fx-load fx-load-d3">
            <div className="dl-panel-head">
              <span className="dl-panel-title">Quality Trends</span>
            </div>
            {isLoading ? (
              sectionLoading('Building charts…')
            ) : allCdrs.length === 0 ? (
              <div style={{ padding: 20 }}>
                <div className="dl-empty">
                  No CDR data for the selected filters. Adjust the criteria and search again.
                </div>
              </div>
            ) : (
              <div className="dl-panel-body">
                <div className="dlx-chart-grid">
                  <QualityTrendChart
                    points={trendPoints.mos}
                    accent={CHART_GREEN}
                    title="MOS"
                    domain={MOS_DOMAIN}
                    formatValue={fmtMosValue}
                    formatTick={fmtMosTick}
                  />
                  <QualityTrendChart
                    points={trendPoints.loss}
                    accent={CHART_ROSE}
                    title="Packet Loss %"
                    domain={LOSS_DOMAIN}
                    formatValue={fmtLossValue}
                    formatTick={fmtLossTick}
                  />
                  <QualityTrendChart
                    points={trendPoints.jitter}
                    accent={CHART_AZURE}
                    title="Jitter (ms)"
                    domain={JITTER_DOMAIN}
                    formatValue={fmtJitterValue}
                    formatTick={fmtJitterTick}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── CDR Table ──────────────────────────────────────────── */}
          <div className="dl-panel fx-load fx-load-d3">
            <div className="dl-panel-head">
              <span className="dl-panel-title">CDR Records</span>
              {allCdrs.length > 0 && (
                <span className="dl-count">{allCdrs.length.toLocaleString()} loaded</span>
              )}
            </div>
            {isLoading ? (
              sectionLoading('Loading records…')
            ) : (
              <CdrTable
                cdrs={allCdrs}
                customers={customers}
                onSelect={handleSelect}
                selectedUuid={selectedCdr?.uuid ?? null}
              />
            )}
          </div>
        </div>
      </div>

      {/* Call Detail Sheet */}
      {selectedCdr && <CallDetailPanel cdr={selectedCdr} onClose={handleClose} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG Icons
// ---------------------------------------------------------------------------

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="#9aa9c0"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        width: 14,
        height: 14,
        position: 'absolute',
        left: 10,
        top: '50%',
        transform: 'translateY(-50%)',
        pointerEvents: 'none',
      }}
    >
      <circle cx="6.5" cy="6.5" r="4" />
      <path d="M11 11l2.5 2.5" />
    </svg>
  );
}

function SearchIconSmall() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
      <circle cx="6.5" cy="6.5" r="4" />
      <path d="M11 11l2.5 2.5" />
    </svg>
  );
}
