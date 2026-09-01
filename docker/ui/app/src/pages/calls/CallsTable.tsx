/**
 * CallsTable — the merged Calls & Quality results table.
 *
 * Column union of the CDR Search table and the Call Quality table: Time,
 * Customer (staff), Product, Dir, From, To, Duration, MOS pill, Loss %,
 * Status, Hangup, Cost (staff). Row click opens the call-detail modal
 * (the old inline expanded-row idiom is gone — the modal carries all of it
 * and more).
 *
 * The toolbar carries the Call Quality page's free-text quick filter. It is
 * deliberately CLIENT-SIDE over the CURRENT PAGE's rows (matching number /
 * UUID / cause / codec / customer) and labeled as such — a server-side
 * number filter is the Destination Prefix field in the filter bar. Rows are
 * filtered by the parent so the KPI strip stays honest about page scope.
 *
 * Styling: shared DAYLIGHT CONSOLE system — `dl-*` (index.css), `dlx-*`
 * (dl-admin.css), `dlx4-*` (dl-platform-b.css). Horizontal scroll INSIDE the
 * panel at laptop widths (dlx4-tablewrap).
 */
import { fmt, fmtMoneySmart } from '../../utils/format';
import { mosTone, packetLossColor, INK_FAINT } from './quality';
import type { Cdr, ProductType, CallDirection } from '../../types/cdr';

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
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function DirectionTag({ dir }: { dir: CallDirection }) {
  // Inbound reads azure (traffic toward us), outbound reads neutral slate.
  return <span className={dir === 'inbound' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>{dir}</span>;
}

function ProductTag({ pt }: { pt: ProductType }) {
  return <span className="dl-tag">{pt.toUpperCase()}</span>;
}

function MosPill({ mos }: { mos: number | null | undefined }) {
  if (mos == null) return <span style={{ color: '#b6c2d4' }}>—</span>;
  const tone = mosTone(mos);
  return (
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
      {mos.toFixed(2)}
    </span>
  );
}

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

interface CallsTableProps {
  /** Rows to render — the parent already applied the page quick filter. */
  cdrs: Cdr[];
  /** Row count on the page BEFORE the quick filter (for the toolbar readout). */
  pageRowCount: number;
  /** Map from customer_id to customer name for display (staff only). */
  customerNames?: Record<number, string>;
  /** Quick-filter text (client-side, this page only). */
  quickFilter: string;
  onQuickFilterChange: (value: string) => void;
  onSelect: (cdr: Cdr) => void;
  selectedUuid: string | null;
  /** Admin or support — Customer + Cost columns render only for staff. */
  isStaff: boolean;
}

export function CallsTable({
  cdrs,
  pageRowCount,
  customerNames,
  quickFilter,
  onQuickFilterChange,
  onSelect,
  selectedUuid,
  isStaff,
}: CallsTableProps) {
  return (
    <section className="dl-panel">
      {/* Quick-filter toolbar — client-side, current page only */}
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
        <div style={{ position: 'relative', flex: 1, maxWidth: 400 }}>
          <SearchIcon />
          <input
            type="text"
            aria-label="Quick filter the loaded page"
            placeholder="Quick filter this page — number, UUID, cause, codec…"
            value={quickFilter}
            onChange={(e) => onQuickFilterChange(e.target.value)}
            className="dl-input"
            style={{ width: '100%', padding: '7px 12px 7px 32px', fontSize: '0.8rem' }}
          />
        </div>
        <span style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {quickFilter
            ? `${cdrs.length.toLocaleString()} of ${pageRowCount.toLocaleString()} on this page`
            : `${cdrs.length.toLocaleString()} on this page`}
        </span>
      </div>

      <div className="dlx4-tablewrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: isStaff ? 1080 : 900 }}>
          <thead>
            <tr>
              <th className="dl-th">Time</th>
              {isStaff && <th className="dl-th">Customer</th>}
              <th className="dl-th">Product</th>
              <th className="dl-th">Dir</th>
              <th className="dl-th">From</th>
              <th className="dl-th">To</th>
              <th className="dl-th">Duration</th>
              <th className="dl-th">MOS</th>
              <th className="dl-th">Loss %</th>
              <th className="dl-th">Status</th>
              <th className="dl-th">Hangup</th>
              {isStaff && <th className="dl-th">Cost</th>}
            </tr>
          </thead>
          <tbody>
            {cdrs.length === 0 && (
              <tr>
                <td colSpan={isStaff ? 12 : 10} style={{ padding: 20 }}>
                  <div className="dl-empty">
                    {pageRowCount === 0 ? (
                      <>
                        <p style={{ fontWeight: 600, margin: 0, color: 'var(--rcf-ink)' }}>No records found</p>
                        <p style={{ fontSize: '0.74rem', margin: '4px 0 0' }}>Adjust your filters and search again.</p>
                      </>
                    ) : (
                      <>
                        <p style={{ fontWeight: 600, margin: 0, color: 'var(--rcf-ink)' }}>No rows match the quick filter</p>
                        <p style={{ fontSize: '0.74rem', margin: '4px 0 0' }}>
                          It only scans this page — clear it or use Destination Prefix to search server-side.
                        </p>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {cdrs.map((cdr) => {
              const answered = cdr.answer_time != null;
              const isSelected = cdr.uuid === selectedUuid;
              const hangupOk = cdr.hangup_cause === 'NORMAL_CLEARING';
              const billedColor =
                cdr.total_cost != null && cdr.total_cost > 0
                  ? 'var(--rcf-azure-deep)'
                  : 'var(--rcf-ink-dim)';

              return (
                <tr
                  key={cdr.uuid}
                  className={isSelected ? 'dl-row dlx-row-active' : 'dl-row'}
                  style={{ cursor: 'pointer' }}
                  onClick={() => onSelect(cdr)}
                >
                  <td className="dlx-td">
                    <span className="dlx4-mono" style={{ color: 'var(--rcf-ink-dim)' }}>
                      {fmtTime(cdr.start_time)}
                    </span>
                  </td>
                  {isStaff && (
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {customerNames?.[cdr.customer_id] ?? `#${cdr.customer_id}`}
                    </td>
                  )}
                  <td className="dlx-td"><ProductTag pt={cdr.product_type} /></td>
                  <td className="dlx-td"><DirectionTag dir={cdr.direction} /></td>
                  <td className="dlx-td">
                    <span style={{ color: 'var(--rcf-ink)', whiteSpace: 'nowrap' }}>
                      {fmt(cdr.caller_id) || cdr.caller_id || '--'}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span style={{ color: 'var(--rcf-ink)', whiteSpace: 'nowrap' }}>
                      {fmt(cdr.destination) || cdr.destination || '--'}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--rcf-ink)' }}>
                      {fmtDurationSec(cdr.duration_seconds)}
                    </span>
                  </td>
                  <td className="dlx-td"><MosPill mos={cdr.mos} /></td>
                  <td className="dlx-td">
                    <span
                      style={{
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 600,
                        color: cdr.packet_loss_pct != null ? packetLossColor(cdr.packet_loss_pct) : INK_FAINT,
                      }}
                    >
                      {cdr.packet_loss_pct != null ? `${cdr.packet_loss_pct.toFixed(2)}%` : '—'}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span className={answered ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
                      {answered ? 'Ans' : 'N/A'}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span
                      style={{
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        color: hangupOk ? 'var(--rcf-green)' : 'var(--rcf-red)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {cdr.hangup_cause || '--'}
                    </span>
                  </td>
                  {isStaff && (
                    <td className="dlx-td">
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: billedColor }}>
                        {fmtMoneySmart(cdr.total_cost)}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
