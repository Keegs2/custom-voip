/**
 * CallQualityPage — Platform-wide SIP call quality analysis tool.
 *
 * Sections:
 *   1. Filter bar — customer, trunk, number search, direction, date range, product type
 *   2. Quality overview stat cards — Total Calls, ASR, MOS, Packet Loss, Jitter, R-Factor
 *   3. Quality trend charts — MOS, Packet Loss, Jitter over time
 *   4. Full CDR table — sortable, searchable, paginated with quality columns
 *   5. Call detail panel — slide-out drawer with full RTP/quality/billing data
 */

import { useState, useMemo, useId, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchCdrs, getCdr } from '../api/cdrs';
import { listCustomers } from '../api/customers';
import { listTrunks } from '../api/trunks';
import { Spinner } from '../components/ui/Spinner';
import type { Cdr, CallDirection, ProductType } from '../types/cdr';
import type { Customer } from '../types/customer';
import type { Trunk } from '../types/trunk';

// ---------------------------------------------------------------------------
// Quality colour helpers
// ---------------------------------------------------------------------------

function mosColor(mos: number | null | undefined): string {
  if (mos == null) return '#4a5568';
  if (mos >= 4.0) return '#22c55e';
  if (mos >= 3.5) return '#f59e0b';
  return '#ef4444';
}

function mosBg(mos: number | null | undefined): string {
  if (mos == null) return 'rgba(74,85,104,0.15)';
  if (mos >= 4.0) return 'rgba(34,197,94,0.12)';
  if (mos >= 3.5) return 'rgba(245,158,11,0.12)';
  return 'rgba(239,68,68,0.12)';
}

function rFactorColor(r: number | null | undefined): string {
  if (r == null) return '#4a5568';
  if (r >= 80) return '#22c55e';
  if (r >= 60) return '#f59e0b';
  return '#ef4444';
}

function packetLossColor(pct: number | null | undefined): string {
  if (pct == null) return '#4a5568';
  if (pct <= 1) return '#22c55e';
  if (pct <= 5) return '#f59e0b';
  return '#ef4444';
}

function jitterColor(ms: number | null | undefined): string {
  if (ms == null) return '#4a5568';
  if (ms <= 20) return '#22c55e';
  if (ms <= 50) return '#f59e0b';
  return '#ef4444';
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
// Quality Trend Chart (SVG line/area)
// ---------------------------------------------------------------------------

interface TrendPoint {
  date: string;
  label: string;
  value: number | null;
}

interface QualityTrendChartProps {
  points: TrendPoint[];
  accent: string;
  label: string;
  formatY: (v: number) => string;
  yMin?: number;
  yMax?: number;
}

function QualityTrendChart({ points, accent, label, formatY, yMin, yMax }: QualityTrendChartProps) {
  const gradId = useId();

  const validValues = points.map((p) => p.value).filter((v): v is number => v != null);
  const dataMin = validValues.length > 0 ? Math.min(...validValues) : 0;
  const dataMax = validValues.length > 0 ? Math.max(...validValues) : 1;

  const visMin = yMin ?? Math.max(0, dataMin - (dataMax - dataMin) * 0.15);
  const visMax = yMax ?? (dataMax + (dataMax - dataMin) * 0.15 || 1);
  const range = visMax - visMin || 1;

  const W = 500;
  const H = 160;
  const PAD_L = 44;
  const PAD_R = 12;
  const PAD_T = 14;
  const PAD_B = 28;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const coords = points.map((p, i) => ({
    x: PAD_L + (i / Math.max(points.length - 1, 1)) * chartW,
    y: p.value != null
      ? PAD_T + chartH - ((p.value - visMin) / range) * chartH
      : null,
    point: p,
  }));

  function buildPathSegments(): string[] {
    const segments: string[] = [];
    let current: string | null = null;

    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (c.y == null) {
        if (current) { segments.push(current); current = null; }
        continue;
      }
      if (current == null) {
        current = `M ${c.x.toFixed(2)} ${c.y.toFixed(2)}`;
      } else {
        const prev2 = coords[Math.max(i - 2, 0)];
        const prev1 = coords[i - 1];
        const next1 = coords[Math.min(i + 1, coords.length - 1)];
        const p0 = { x: prev2.x, y: prev2.y ?? c.y };
        const p1 = { x: prev1.x, y: prev1.y ?? c.y };
        const p2 = { x: c.x, y: c.y };
        const p3 = { x: next1.x, y: next1.y ?? c.y };
        const t = 0.3;
        const cp1x = p1.x + (p2.x - p0.x) * t;
        const cp1y = p1.y + (p2.y - p0.y) * t;
        const cp2x = p2.x - (p3.x - p1.x) * t;
        const cp2y = p2.y - (p3.y - p1.y) * t;
        current += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
      }
    }
    if (current) segments.push(current);
    return segments;
  }

  const pathSegments = buildPathSegments();
  const firstSegment = pathSegments[0] ?? '';
  const firstStart = coords.find((c) => c.y != null);
  const firstEnd = [...coords].reverse().find((c) => c.y != null);
  const areaPath = firstSegment && firstStart && firstEnd
    ? `${firstSegment} L ${firstEnd.x.toFixed(2)} ${(PAD_T + chartH).toFixed(2)} L ${firstStart.x.toFixed(2)} ${(PAD_T + chartH).toFixed(2)} Z`
    : '';

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    y: PAD_T + chartH - frac * chartH,
    value: visMin + frac * range,
  }));

  const LABEL_EVERY = Math.ceil(points.length / 6);

  return (
    <div style={{ width: '100%' }}>
      <div
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.09em',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          background: 'rgba(10,12,18,0.6)',
          border: '1px solid rgba(42,47,69,0.35)',
          borderRadius: 10,
          padding: '12px 12px 4px',
          overflowX: 'auto',
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 'auto', display: 'block', minHeight: 140 }}
          aria-label={label}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
              <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          {gridLines.map(({ y, value }) => (
            <g key={value}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
              <text x={PAD_L - 6} y={y + 4} textAnchor="end" fontSize={9} fill="#4a5568" fontFamily="system-ui, -apple-system, sans-serif">
                {formatY(value)}
              </text>
            </g>
          ))}

          {areaPath && <path d={areaPath} fill={`url(#${gradId})`} />}

          {pathSegments.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          ))}

          {coords.map((c) => {
            if (c.y == null) return null;
            return (
              <g key={c.point.date}>
                <circle cx={c.x} cy={c.y} r={2.5} fill="#0f1117" stroke={accent} strokeWidth={1.5} />
                <title>{c.point.label}: {c.point.value != null ? formatY(c.point.value) : '—'}</title>
              </g>
            );
          })}

          {coords.map((c, i) => {
            if (i % LABEL_EVERY !== 0) return null;
            return (
              <text key={c.point.date} x={c.x} y={H - 6} textAnchor="middle" fontSize={9} fill="#4a5568" fontFamily="system-ui, -apple-system, sans-serif">
                {c.point.label}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build daily quality buckets from CDR array
// ---------------------------------------------------------------------------

interface DailyQuality {
  date: string;
  label: string;
  avgMos: number | null;
  avgPacketLossPct: number | null;
  avgJitterMs: number | null;
}

function buildDailyQuality(cdrs: Cdr[], startDate: Date, endDate: Date): DailyQuality[] {
  const byDate = new Map<string, { mosSum: number; mosCount: number; plSum: number; plCount: number; jSum: number; jCount: number }>();

  for (const cdr of cdrs) {
    const key = cdr.start_time.slice(0, 10);
    const bucket = byDate.get(key) ?? { mosSum: 0, mosCount: 0, plSum: 0, plCount: 0, jSum: 0, jCount: 0 };
    if (cdr.mos != null) { bucket.mosSum += cdr.mos; bucket.mosCount++; }
    if (cdr.packet_loss_pct != null) { bucket.plSum += cdr.packet_loss_pct; bucket.plCount++; }
    if (cdr.jitter_avg_ms != null) { bucket.jSum += cdr.jitter_avg_ms; bucket.jCount++; }
    byDate.set(key, bucket);
  }

  const slots: DailyQuality[] = [];
  const msPerDay = 86400000;
  const dayCount = Math.round((endDate.getTime() - startDate.getTime()) / msPerDay);

  for (let i = 0; i <= Math.min(dayCount, 60); i++) {
    const d = new Date(startDate.getTime() + i * msPerDay);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const b = byDate.get(key);
    slots.push({
      date: key,
      label,
      avgMos: b && b.mosCount > 0 ? b.mosSum / b.mosCount : null,
      avgPacketLossPct: b && b.plCount > 0 ? b.plSum / b.plCount : null,
      avgJitterMs: b && b.jCount > 0 ? b.jSum / b.jCount : null,
    });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Overview stat cards
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

interface OverviewStatCardProps {
  label: string;
  value: React.ReactNode;
  accent: string;
  sub?: string;
}

function OverviewStatCard({ label, value, accent, sub }: OverviewStatCardProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 12,
        padding: '16px 20px',
        position: 'relative',
        overflow: 'hidden',
        flex: '1 1 140px',
        minWidth: 0,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}99, transparent)`,
        }}
      />
      <div
        style={{
          fontSize: '0.58rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1.2rem',
          fontWeight: 700,
          color: accent,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.65rem', color: '#4a5568', marginTop: 3 }}>{sub}</div>
      )}
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

  function SortIcon({ colKey }: { colKey: SortKey }) {
    if (sort.key !== colKey) return <span style={{ color: '#2d3748', marginLeft: 3 }}>↕</span>;
    return <span style={{ color: '#60a5fa', marginLeft: 3 }}>{sort.dir === 'asc' ? '↑' : '↓'}</span>;
  }

  const thStyle = (key?: SortKey): React.CSSProperties => ({
    padding: '8px 10px',
    textAlign: 'left',
    fontSize: '0.58rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#4a5568',
    borderBottom: '1px solid rgba(42,47,69,0.5)',
    whiteSpace: 'nowrap',
    cursor: key ? 'pointer' : 'default',
    userSelect: 'none',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Search + record count */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <SearchIcon />
          <input
            type="text"
            placeholder="Search by number, UUID, customer, codec, cause…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            style={{
              width: '100%',
              padding: '7px 12px 7px 32px',
              fontSize: '0.8rem',
              borderRadius: 8,
              border: '1px solid rgba(42,47,69,0.7)',
              background: 'rgba(13,15,21,0.9)',
              color: '#e2e8f0',
              outline: 'none',
              boxSizing: 'border-box',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#22c55e'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(42,47,69,0.7)'; }}
          />
        </div>
        <span style={{ fontSize: '0.72rem', color: '#4a5568', whiteSpace: 'nowrap' }}>
          {filtered.length.toLocaleString()} records
        </span>
      </div>

      {/* Table */}
      <div
        style={{
          overflowX: 'auto',
          background: 'rgba(10,12,18,0.5)',
          border: '1px solid rgba(42,47,69,0.35)',
          borderRadius: 10,
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.74rem', color: '#cbd5e0' }}>
          <thead>
            <tr>
              <th style={thStyle('start_time')} onClick={() => toggleSort('start_time')}>Date / Time <SortIcon colKey="start_time" /></th>
              <th style={thStyle()}>Customer</th>
              <th style={thStyle()}>Dir</th>
              <th style={thStyle()}>From</th>
              <th style={thStyle()}>To</th>
              <th style={thStyle('duration_seconds')} onClick={() => toggleSort('duration_seconds')}>Duration <SortIcon colKey="duration_seconds" /></th>
              <th style={thStyle('mos')} onClick={() => toggleSort('mos')}>MOS <SortIcon colKey="mos" /></th>
              <th style={thStyle('packet_loss_pct')} onClick={() => toggleSort('packet_loss_pct')}>Pkt Loss <SortIcon colKey="packet_loss_pct" /></th>
              <th style={thStyle('jitter_avg_ms')} onClick={() => toggleSort('jitter_avg_ms')}>Jitter <SortIcon colKey="jitter_avg_ms" /></th>
              <th style={thStyle('r_factor')} onClick={() => toggleSort('r_factor')}>R-Factor <SortIcon colKey="r_factor" /></th>
              <th style={thStyle()}>Codec</th>
              <th style={thStyle()}>Status</th>
              <th style={thStyle()}>Hangup Cause</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 && (
              <tr>
                <td colSpan={13} style={{ padding: '32px 0', textAlign: 'center', color: '#4a5568', fontSize: '0.82rem' }}>
                  {filtered.length === 0 && cdrs.length === 0
                    ? 'No CDR records found. Adjust the filters and search.'
                    : 'No records match your search.'}
                </td>
              </tr>
            )}
            {pageItems.map((cdr, idx) => {
              const answered = cdr.answer_time != null;
              const startDt = new Date(cdr.start_time);
              const isSelected = cdr.uuid === selectedUuid;
              const customerName = customerMap.get(cdr.customer_id) ?? `#${cdr.customer_id}`;

              return (
                <tr
                  key={cdr.uuid}
                  onClick={() => onSelect(cdr)}
                  style={{
                    borderBottom: '1px solid rgba(42,47,69,0.2)',
                    background: isSelected
                      ? 'rgba(34,197,94,0.07)'
                      : idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                    outline: isSelected ? '1px solid rgba(34,197,94,0.25)' : 'none',
                    outlineOffset: -1,
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.025)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)';
                  }}
                >
                  {/* Date/Time */}
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                    <div style={{ color: '#a0aec0', fontVariantNumeric: 'tabular-nums', fontSize: '0.72rem' }}>
                      {startDt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </div>
                    <div style={{ color: '#4a5568', fontSize: '0.68rem', fontVariantNumeric: 'tabular-nums' }}>
                      {startDt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                    </div>
                  </td>

                  {/* Customer */}
                  <td style={{ padding: '6px 10px', color: '#94a3b8', fontSize: '0.72rem', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {customerName}
                  </td>

                  {/* Direction */}
                  <td style={{ padding: '6px 10px' }}>
                    <span
                      style={{
                        fontSize: '0.58rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: cdr.direction === 'inbound' ? 'rgba(59,130,246,0.15)' : 'rgba(168,85,247,0.15)',
                        color: cdr.direction === 'inbound' ? '#60a5fa' : '#c084fc',
                        border: cdr.direction === 'inbound' ? '1px solid rgba(59,130,246,0.25)' : '1px solid rgba(168,85,247,0.25)',
                      }}
                    >
                      {cdr.direction === 'inbound' ? 'In' : 'Out'}
                    </span>
                  </td>

                  {/* From */}
                  <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#94a3b8', whiteSpace: 'nowrap', fontSize: '0.72rem' }}>
                    {cdr.caller_id || '—'}
                  </td>

                  {/* To */}
                  <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#94a3b8', whiteSpace: 'nowrap', fontSize: '0.72rem' }}>
                    {cdr.destination}
                  </td>

                  {/* Duration */}
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums', color: '#718096', whiteSpace: 'nowrap' }}>
                    {fmtDuration(cdr.duration_seconds)}
                  </td>

                  {/* MOS */}
                  <td style={{ padding: '6px 10px' }}>
                    {cdr.mos != null ? (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '2px 7px',
                          borderRadius: 5,
                          background: mosBg(cdr.mos),
                          color: mosColor(cdr.mos),
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {cdr.mos.toFixed(2)}
                      </span>
                    ) : (
                      <span style={{ color: '#2d3748' }}>—</span>
                    )}
                  </td>

                  {/* Packet Loss */}
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums', color: cdr.packet_loss_pct != null ? packetLossColor(cdr.packet_loss_pct) : '#2d3748' }}>
                    {cdr.packet_loss_pct != null ? `${cdr.packet_loss_pct.toFixed(2)}%` : '—'}
                  </td>

                  {/* Jitter */}
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums', color: cdr.jitter_avg_ms != null ? jitterColor(cdr.jitter_avg_ms) : '#2d3748' }}>
                    {cdr.jitter_avg_ms != null ? `${cdr.jitter_avg_ms.toFixed(1)}ms` : '—'}
                  </td>

                  {/* R-Factor */}
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums', color: rFactorColor(cdr.r_factor) }}>
                    {cdr.r_factor != null ? cdr.r_factor.toFixed(1) : '—'}
                  </td>

                  {/* Codec */}
                  <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#4a5568', fontSize: '0.68rem', whiteSpace: 'nowrap' }}>
                    {cdr.read_codec ?? '—'}
                  </td>

                  {/* Status */}
                  <td style={{ padding: '6px 10px' }}>
                    <span
                      style={{
                        fontSize: '0.58rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: answered ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                        color: answered ? '#4ade80' : '#f87171',
                        border: answered ? '1px solid rgba(34,197,94,0.2)' : '1px solid rgba(239,68,68,0.2)',
                      }}
                    >
                      {answered ? 'Ans' : 'N/A'}
                    </span>
                  </td>

                  {/* Hangup Cause */}
                  <td style={{ padding: '6px 10px', color: '#4a5568', fontFamily: 'monospace', fontSize: '0.68rem', whiteSpace: 'nowrap' }}>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            style={paginationBtnStyle(page === 0)}
          >
            ← Prev
          </button>
          <span style={{ fontSize: '0.72rem', color: '#4a5568', fontVariantNumeric: 'tabular-nums' }}>
            {page + 1} / {pageCount}
          </span>
          <button
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            style={paginationBtnStyle(page >= pageCount - 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

function paginationBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '5px 14px',
    fontSize: '0.72rem',
    borderRadius: 6,
    border: '1px solid rgba(42,47,69,0.6)',
    background: disabled ? 'transparent' : 'rgba(34,197,94,0.08)',
    color: disabled ? '#2d3748' : '#4ade80',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

// ---------------------------------------------------------------------------
// Call Detail Panel (slide-out drawer)
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
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '5px 0',
        borderBottom: '1px solid rgba(42,47,69,0.15)',
        alignItems: 'flex-start',
      }}
    >
      <span
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          width: 128,
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: '0.75rem',
          color: accent ?? '#cbd5e0',
          fontFamily: mono ? 'monospace' : 'inherit',
          wordBreak: 'break-all',
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: '0.58rem',
          fontWeight: 700,
          color: '#22c55e',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          marginBottom: 10,
          paddingBottom: 6,
          borderBottom: '1px solid rgba(34,197,94,0.2)',
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function BigMetric({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div
      style={{
        background: `linear-gradient(135deg, ${color}12 0%, transparent 100%)`,
        border: `1px solid ${color}25`,
        borderRadius: 10,
        padding: '12px 16px',
        flex: '1 1 100px',
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: '0.58rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.62rem', color: '#4a5568', marginTop: 3 }}>{sub}</div>}
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
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxWidth: '95vw',
          height: '100%',
          background: 'linear-gradient(180deg, rgba(22,25,36,0.99) 0%, rgba(13,15,21,1) 100%)',
          borderLeft: '1px solid rgba(42,47,69,0.7)',
          boxShadow: '-16px 0 48px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.5)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            position: 'sticky',
            top: 0,
            background: 'rgba(22,25,36,0.98)',
            backdropFilter: 'blur(8px)',
            zIndex: 1,
          }}
        >
          <div>
            <div style={{ fontSize: '0.58rem', fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 4 }}>
              Call Detail
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: '#4a5568', wordBreak: 'break-all' }}>
              {d.uuid}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close panel"
            style={{
              background: 'none',
              border: '1px solid rgba(42,47,69,0.6)',
              borderRadius: 8,
              color: '#718096',
              cursor: 'pointer',
              padding: '4px 10px',
              fontSize: '0.8rem',
              flexShrink: 0,
              marginTop: 2,
            }}
          >
            ✕
          </button>
        </div>

        {/* Loading indicator */}
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 24px', fontSize: '0.75rem', color: '#718096', borderBottom: '1px solid rgba(42,47,69,0.3)' }}>
            <Spinner size="xs" /> Fetching full detail…
          </div>
        )}

        {/* Body */}
        <div style={{ padding: '20px 24px', flex: 1 }}>
          {/* Big quality metrics */}
          {(d.mos != null || d.r_factor != null) && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
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
                  color={d.quality_pct >= 80 ? '#22c55e' : d.quality_pct >= 60 ? '#f59e0b' : '#ef4444'}
                />
              )}
            </div>
          )}

          <PanelSection title="Call Info">
            <DetailRow label="UUID" value={d.uuid} mono />
            <DetailRow label="Direction" value={
              <span style={{ padding: '1px 8px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 700, background: d.direction === 'inbound' ? 'rgba(59,130,246,0.15)' : 'rgba(168,85,247,0.15)', color: d.direction === 'inbound' ? '#60a5fa' : '#c084fc' }}>
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
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: '0.62rem', color: '#3b82f6', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Audio In (from carrier)</div>
                  {d.rtp_audio_in_raw_bytes != null && <DetailRow label="Raw Bytes" value={fmtBytes(d.rtp_audio_in_raw_bytes)} />}
                  {d.rtp_audio_in_media_bytes != null && <DetailRow label="Media Bytes" value={fmtBytes(d.rtp_audio_in_media_bytes)} />}
                  {d.rtp_audio_in_packet_count != null && <DetailRow label="Packets" value={d.rtp_audio_in_packet_count.toLocaleString()} />}
                  {d.packet_loss_count != null && <DetailRow label="Skipped (lost)" value={d.packet_loss_count.toLocaleString()} />}
                </div>
              )}
              {(d.rtp_audio_out_raw_bytes != null || d.rtp_audio_out_packet_count != null) && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: '0.62rem', color: '#a855f7', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Audio Out (to carrier)</div>
                  {d.rtp_audio_out_raw_bytes != null && <DetailRow label="Raw Bytes" value={fmtBytes(d.rtp_audio_out_raw_bytes)} />}
                  {d.rtp_audio_out_media_bytes != null && <DetailRow label="Media Bytes" value={fmtBytes(d.rtp_audio_out_media_bytes)} />}
                  {d.rtp_audio_out_packet_count != null && <DetailRow label="Packets" value={d.rtp_audio_out_packet_count.toLocaleString()} />}
                </div>
              )}
              {(d.jitter_min_ms != null || d.jitter_max_ms != null || d.jitter_avg_ms != null) && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: '0.62rem', color: '#f59e0b', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Jitter</div>
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
                  <div style={{ fontSize: '0.62rem', color: '#22c55e', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Codecs</div>
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
// Pill selector
// ---------------------------------------------------------------------------

interface PillOption<T extends string> {
  value: T;
  label: string;
}

interface PillSelectorProps<T extends string> {
  options: PillOption<T>[];
  value: T;
  onChange: (v: T) => void;
  accent?: string;
}

function PillSelector<T extends string>({ options, value, onChange, accent = '#22c55e' }: PillSelectorProps<T>) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              padding: '4px 12px',
              fontSize: '0.72rem',
              fontWeight: active ? 700 : 500,
              borderRadius: 20,
              border: active ? `1px solid ${accent}50` : '1px solid rgba(42,47,69,0.6)',
              background: active ? `${accent}18` : 'transparent',
              color: active ? accent : '#4a5568',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section card wrapper
// ---------------------------------------------------------------------------

function SectionCard({ children, accent = '#22c55e' }: { children: React.ReactNode; accent?: string }) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(15,17,23,1) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '24px 28px',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0, left: 40, right: 40, height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          opacity: 0.55,
        }}
      />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function CallQualityPage() {
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

  // When customer changes, reset trunk selection
  useEffect(() => {
    setFilters((prev) => ({ ...prev, trunkId: null }));
  }, [filters.customerId]);

  // Build search params from applied filters
  const searchParams = useMemo(() => ({
    customer_id: appliedFilters.customerId ?? undefined,
    direction: appliedFilters.direction !== 'all' ? appliedFilters.direction : undefined,
    start_from: `${appliedFilters.startDate}T00:00:00`,
    start_to: `${appliedFilters.endDate}T23:59:59`,
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

  const mosPts = dailyQuality.map((d) => ({ date: d.date, label: d.label, value: d.avgMos }));
  const plPts = dailyQuality.map((d) => ({ date: d.date, label: d.label, value: d.avgPacketLossPct }));
  const jPts = dailyQuality.map((d) => ({ date: d.date, label: d.label, value: d.avgJitterMs }));

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

  const inputStyle: React.CSSProperties = {
    padding: '7px 11px',
    fontSize: '0.8rem',
    borderRadius: 8,
    border: '1px solid rgba(42,47,69,0.7)',
    background: 'rgba(13,15,21,0.9)',
    color: '#e2e8f0',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: 'none',
    cursor: 'pointer',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '0.6rem',
    fontWeight: 700,
    color: '#4a5568',
    textTransform: 'uppercase',
    letterSpacing: '0.09em',
    marginBottom: 6,
    display: 'block',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Page header */}
      <div
        style={{
          paddingTop: 8,
          paddingBottom: 28,
          borderBottom: '1px solid rgba(42,47,69,0.6)',
          textAlign: 'center',
        }}
      >
        {/* Icon badge — centered */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            background: 'linear-gradient(135deg, rgba(34,197,94,0.20) 0%, rgba(34,197,94,0.10) 100%)',
            border: '1px solid rgba(34,197,94,0.30)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#22c55e',
            marginBottom: 14,
          }}
          aria-hidden="true"
        >
          <SignalIcon />
        </div>

        {/* Title */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 800,
              color: '#e2e8f0',
              letterSpacing: '-0.02em',
              margin: 0,
              lineHeight: 1.15,
            }}
          >
            Call Quality
          </h1>
        </div>

        {/* Subtitle */}
        <p style={{ fontSize: '0.82rem', color: '#4a5568', margin: 0, marginLeft: 'auto', marginRight: 'auto', letterSpacing: '0.01em' }}>
          SIP call analysis, quality metrics, and RTP diagnostics
        </p>
      </div>

      {/* Filter bar */}
      <div
        style={{
          background: 'linear-gradient(135deg, rgba(26,29,39,0.97) 0%, rgba(15,17,23,1) 100%)',
          border: '1px solid rgba(42,47,69,0.7)',
          borderRadius: 16,
          padding: '24px',
          position: 'relative',
          overflow: 'hidden',
          boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0, left: 40, right: 40, height: 2,
            background: 'linear-gradient(90deg, transparent, rgba(34,197,94,0.6), transparent)',
          }}
        />

        <div
          style={{
            fontSize: '0.58rem',
            fontWeight: 700,
            color: '#22c55e',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            marginBottom: 18,
          }}
        >
          Filters
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, marginBottom: 16 }}>
          {/* Customer */}
          <div>
            <label style={labelStyle}>Customer</label>
            <select
              value={filters.customerId ?? ''}
              onChange={(e) => setFilters((p) => ({ ...p, customerId: e.target.value ? Number(e.target.value) : null }))}
              style={selectStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#22c55e'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(42,47,69,0.7)'; }}
            >
              <option value="">All Customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Trunk */}
          <div>
            <label style={labelStyle}>Trunk</label>
            <select
              value={filters.trunkId ?? ''}
              onChange={(e) => setFilters((p) => ({ ...p, trunkId: e.target.value ? Number(e.target.value) : null }))}
              style={selectStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#22c55e'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(42,47,69,0.7)'; }}
            >
              <option value="">All Trunks</option>
              {trunks.map((t) => (
                <option key={t.id} value={t.id}>{t.trunk_name}</option>
              ))}
            </select>
          </div>

          {/* Number / DID search */}
          <div>
            <label style={labelStyle}>Number / DID</label>
            <input
              type="text"
              placeholder="e.g. +14155551234"
              value={filters.numberSearch}
              onChange={(e) => setFilters((p) => ({ ...p, numberSearch: e.target.value }))}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#22c55e'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(42,47,69,0.7)'; }}
            />
          </div>

          {/* Start Date */}
          <div>
            <label style={labelStyle}>Start Date</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => setFilters((p) => ({ ...p, startDate: e.target.value }))}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#22c55e'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(42,47,69,0.7)'; }}
            />
          </div>

          {/* End Date */}
          <div>
            <label style={labelStyle}>End Date</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => setFilters((p) => ({ ...p, endDate: e.target.value }))}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#22c55e'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(42,47,69,0.7)'; }}
            />
          </div>
        </div>

        {/* Direction + Product type pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginBottom: 20, alignItems: 'flex-start' }}>
          <div>
            <div style={labelStyle}>Direction</div>
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
            <div style={labelStyle}>Product Type</div>
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            type="button"
            onClick={handleSearch}
            disabled={isLoading}
            style={{
              padding: '8px 20px',
              fontSize: '0.82rem',
              fontWeight: 700,
              borderRadius: 8,
              border: '1px solid rgba(34,197,94,0.4)',
              background: 'rgba(34,197,94,0.12)',
              color: '#4ade80',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              opacity: isLoading ? 0.7 : 1,
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => { if (!isLoading) e.currentTarget.style.background = 'rgba(34,197,94,0.2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.12)'; }}
          >
            {isLoading ? <Spinner size="xs" /> : <SearchIconSmall />}
            {isLoading ? 'Loading…' : 'Search'}
          </button>
          <button
            type="button"
            onClick={handleReset}
            style={{
              padding: '8px 16px',
              fontSize: '0.82rem',
              fontWeight: 500,
              borderRadius: 8,
              border: '1px solid rgba(42,47,69,0.6)',
              background: 'transparent',
              color: '#718096',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#e2e8f0'; e.currentTarget.style.borderColor = 'rgba(42,47,69,0.9)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#718096'; e.currentTarget.style.borderColor = 'rgba(42,47,69,0.6)'; }}
          >
            Reset
          </button>
          {cdrData && (
            <span style={{ fontSize: '0.72rem', color: '#4a5568', marginLeft: 4 }}>
              {allCdrs.length.toLocaleString()} of {cdrData.total.toLocaleString()} records
            </span>
          )}
        </div>
      </div>

      {/* Error state */}
      {isError && (
        <div
          style={{
            padding: '14px 18px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.18)',
            color: '#f87171',
            fontSize: '0.82rem',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span>Unable to load CDR data. The CDR service may be unavailable.</span>
          <button
            onClick={() => refetch()}
            style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: '0.76rem', borderRadius: 6, border: '1px solid rgba(239,68,68,0.3)', background: 'transparent', color: '#f87171', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Quality overview cards */}
      <SectionCard accent="#22c55e">
        <div
          style={{
            fontSize: '0.6rem',
            fontWeight: 700,
            color: '#22c55e',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginBottom: 16,
          }}
        >
          Quality Overview
        </div>
        {isLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#718096', fontSize: '0.82rem', padding: '16px 0' }}>
            <Spinner size="xs" /> Computing metrics…
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <OverviewStatCard
              label="Total Calls"
              value={overviewStats.totalCalls.toLocaleString()}
              accent="#60a5fa"
            />
            <OverviewStatCard
              label="ASR"
              value={`${overviewStats.asr}%`}
              accent={overviewStats.asr >= 70 ? '#22c55e' : overviewStats.asr >= 50 ? '#f59e0b' : '#ef4444'}
              sub={`${overviewStats.answeredCalls.toLocaleString()} answered`}
            />
            <OverviewStatCard
              label="Avg MOS"
              value={overviewStats.avgMos != null ? overviewStats.avgMos.toFixed(2) : '—'}
              accent={mosColor(overviewStats.avgMos)}
              sub={overviewStats.avgMos != null ? (overviewStats.avgMos >= 4.0 ? 'Excellent' : overviewStats.avgMos >= 3.5 ? 'Good' : 'Poor') : undefined}
            />
            <OverviewStatCard
              label="Avg Pkt Loss"
              value={overviewStats.avgPacketLossPct != null ? `${overviewStats.avgPacketLossPct.toFixed(2)}%` : '—'}
              accent={packetLossColor(overviewStats.avgPacketLossPct)}
            />
            <OverviewStatCard
              label="Avg Jitter"
              value={overviewStats.avgJitterMs != null ? `${overviewStats.avgJitterMs.toFixed(1)}ms` : '—'}
              accent={jitterColor(overviewStats.avgJitterMs)}
            />
            <OverviewStatCard
              label="Avg R-Factor"
              value={overviewStats.avgRFactor != null ? overviewStats.avgRFactor.toFixed(1) : '—'}
              accent={rFactorColor(overviewStats.avgRFactor)}
            />
          </div>
        )}
      </SectionCard>

      {/* Quality trends */}
      <SectionCard accent="#22c55e">
        <div
          style={{
            fontSize: '0.6rem',
            fontWeight: 700,
            color: '#22c55e',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginBottom: 16,
          }}
        >
          Quality Trends
        </div>
        {isLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#718096', fontSize: '0.82rem', padding: '16px 0' }}>
            <Spinner size="xs" /> Building charts…
          </div>
        ) : allCdrs.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: '#4a5568', fontSize: '0.82rem' }}>
            No CDR data for the selected filters. Adjust the criteria and search again.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <QualityTrendChart
              points={mosPts}
              accent="#22c55e"
              label="MOS Score — Daily Avg"
              formatY={(v) => v.toFixed(2)}
              yMin={1}
              yMax={5}
            />
            <QualityTrendChart
              points={plPts}
              accent="#ef4444"
              label="Packet Loss % — Daily Avg"
              formatY={(v) => `${v.toFixed(2)}%`}
              yMin={0}
            />
            <QualityTrendChart
              points={jPts}
              accent="#f59e0b"
              label="Jitter (avg ms) — Daily"
              formatY={(v) => `${v.toFixed(1)}ms`}
              yMin={0}
            />
          </div>
        )}
      </SectionCard>

      {/* CDR Table */}
      <SectionCard accent="#3b82f6">
        <div
          style={{
            fontSize: '0.6rem',
            fontWeight: 700,
            color: '#3b82f6',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginBottom: 16,
          }}
        >
          CDR Records
          {allCdrs.length > 0 && (
            <span style={{ fontWeight: 400, color: '#4a5568', marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
              — {allCdrs.length.toLocaleString()} records loaded
            </span>
          )}
        </div>
        {isLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#718096', fontSize: '0.82rem', padding: '16px 0' }}>
            <Spinner size="xs" /> Loading records…
          </div>
        ) : (
          <CdrTable
            cdrs={allCdrs}
            customers={customers}
            onSelect={handleSelect}
            selectedUuid={selectedCdr?.uuid ?? null}
          />
        )}
      </SectionCard>

      {/* Call Detail Panel */}
      {selectedCdr && <CallDetailPanel cdr={selectedCdr} onClose={handleClose} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG Icons
// ---------------------------------------------------------------------------

function SignalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" style={{ width: 22, height: 22 }}>
      <path d="M1.5 8.5A15 15 0 0 1 22.5 8.5" />
      <path d="M5.5 12.5a10 10 0 0 1 13 0" />
      <path d="M9.5 16.5a5 5 0 0 1 5 0" />
      <circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="#4a5568"
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
