/**
 * CdrTable — the CDR results table with expandable per-call detail.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, the admin
 * `dlx-*` layer in dl-admin.css, and the page-scoped `dlx4-*` layer in
 * styles/dl-platform-b.css). One white `dl-panel` slab; rows are `dl-row`
 * and the open row carries the azure keyline. Direction/product/SBC render
 * as daylight tags; the rated state keeps its green-ok / amber-warn
 * semantics. Expansion + local rated tracking are unchanged.
 *
 * Laptop widths: all 14 columns are kept — the table scrolls HORIZONTALLY
 * inside the card (`dlx4-tablewrap`), never past the panel edge.
 *
 * Money: em dash for unrated/absent cost/margin (fmtMoneySmart), color only
 * on meaningful nonzero values.
 */
import { useState, useCallback } from 'react';
import { fmt, fmtMoneySmart } from '../../utils/format';
import { CdrExpandedRow } from './CdrExpandedRow';
import type { Cdr, ProductType, CallDirection } from '../../types/cdr';

const COLUMN_COUNT = 14;

/** Table timestamps render in the operator's LOCAL timezone (matches the
    local-time filter pickers, so what you search is what you read). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function fmtDurationSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function DirectionTag({ dir }: { dir: CallDirection }) {
  // Inbound reads azure (traffic toward us), outbound reads neutral slate.
  return <span className={dir === 'inbound' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>{dir}</span>;
}

function ProductTag({ pt }: { pt: ProductType }) {
  return <span className="dl-tag">{pt.toUpperCase()}</span>;
}

function SbcTag({ sbcId }: { sbcId: string | null | undefined }) {
  if (!sbcId) return <span style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)' }}>--</span>;
  // Heuristic (unchanged): ids ending in "2" get the second-SBC tone.
  const isSbc2 = /2$/.test(sbcId);
  // Shorten display: strip the zone prefix so it fits in the column (the
  // full id stays visible in the expanded-row SIP detail).
  const label = sbcId.replace(/^(east|west|central)-/, '');
  return <span className={isSbc2 ? 'dl-tag dlx4-tag-sky' : 'dl-tag'}>{label}</span>;
}

interface CdrTableProps {
  cdrs: Cdr[];
  /** Map from customer_id to customer name for display. */
  customerNames?: Record<number, string>;
}

export function CdrTable({ cdrs, customerNames }: CdrTableProps) {
  const [expandedUuid, setExpandedUuid] = useState<string | null>(null);
  // Local override: track which CDRs have been rated in this session
  const [localRated, setLocalRated] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((uuid: string) => {
    setExpandedUuid((prev) => (prev === uuid ? null : uuid));
  }, []);

  const handleRated = useCallback((uuid: string) => {
    setLocalRated((prev) => new Set([...prev, uuid]));
  }, []);

  if (cdrs.length === 0) {
    return (
      <div className="dl-empty">
        <p style={{ fontWeight: 600, margin: 0, color: 'var(--rcf-ink)' }}>No records found</p>
        <p style={{ fontSize: '0.74rem', margin: '4px 0 0' }}>Adjust your filters and search again.</p>
      </div>
    );
  }

  return (
    <section className="dl-panel">
      <div className="dlx4-tablewrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1080 }}>
          <thead>
            <tr>
              <th className="dl-th">Time</th>
              <th className="dl-th">Dir</th>
              <th className="dl-th">From</th>
              <th className="dl-th">To</th>
              <th className="dl-th">Customer</th>
              <th className="dl-th">Product</th>
              <th className="dl-th">Duration</th>
              <th className="dl-th">Billed</th>
              <th className="dl-th">Cost</th>
              <th className="dl-th">Margin</th>
              <th className="dl-th">Hangup</th>
              <th className="dl-th">Carrier</th>
              <th className="dl-th">SBC</th>
              <th className="dl-th">Status</th>
            </tr>
          </thead>
          <tbody>
            {cdrs.map((cdr) => {
              const isExpanded = expandedUuid === cdr.uuid;
              const isRated = cdr.rated_at != null || localRated.has(cdr.uuid);
              // Color only meaningful nonzero money — null (unrated) and $0
              // both read neutral, not red/green.
              const marginColor =
                cdr.margin == null || cdr.margin === 0
                  ? 'var(--rcf-ink-dim)'
                  : cdr.margin > 0 ? 'var(--rcf-green)' : 'var(--rcf-red)';
              const billedColor =
                cdr.total_cost != null && cdr.total_cost > 0
                  ? 'var(--rcf-azure-deep)'
                  : 'var(--rcf-ink-dim)';
              const hangupOk = cdr.hangup_cause === 'NORMAL_CLEARING';

              return [
                <tr
                  key={cdr.uuid}
                  className={isExpanded ? 'dl-row dlx4-row-open' : 'dl-row'}
                  style={{ cursor: 'pointer' }}
                  onClick={() => toggleExpand(cdr.uuid)}
                >
                  <td className="dlx-td">
                    <span className="dlx4-mono" style={{ color: 'var(--rcf-ink-dim)' }}>
                      {fmtTime(cdr.start_time)}
                    </span>
                  </td>
                  <td className="dlx-td"><DirectionTag dir={cdr.direction} /></td>
                  <td className="dlx-td">
                    <span style={{ color: 'var(--rcf-ink)' }}>
                      {fmt(cdr.caller_id) || cdr.caller_id || '--'}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span style={{ color: 'var(--rcf-ink)' }}>
                      {fmt(cdr.destination) || cdr.destination || '--'}
                    </span>
                  </td>
                  <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>
                    {customerNames?.[cdr.customer_id] ?? `#${cdr.customer_id}`}
                  </td>
                  <td className="dlx-td"><ProductTag pt={cdr.product_type} /></td>
                  <td className="dlx-td">
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--rcf-ink)' }}>
                      {fmtDurationSec(cdr.duration_seconds)}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: billedColor }}>
                      {fmtMoneySmart(cdr.total_cost)}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--rcf-ink-dim)' }}>
                      {fmtMoneySmart(cdr.carrier_cost)}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: marginColor }}>
                      {fmtMoneySmart(cdr.margin)}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span
                      style={{
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        color: hangupOk ? 'var(--rcf-green)' : 'var(--rcf-red)',
                      }}
                    >
                      {cdr.hangup_cause || '--'}
                    </span>
                  </td>
                  <td className="dlx-td" style={{ fontSize: '0.76rem', color: 'var(--rcf-ink-dim)' }}>
                    {cdr.carrier_used || '--'}
                  </td>
                  <td className="dlx-td"><SbcTag sbcId={cdr.sbc_id} /></td>
                  <td className="dlx-td">
                    {isRated ? (
                      <span className="dl-tag dlx4-tag-green">Rated</span>
                    ) : (
                      <span className="dl-tag dlx4-tag-amber">Unrated</span>
                    )}
                  </td>
                </tr>,

                isExpanded && (
                  <CdrExpandedRow
                    key={`${cdr.uuid}-expand`}
                    cdr={cdr}
                    colSpan={COLUMN_COUNT}
                    onRated={handleRated}
                  />
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
