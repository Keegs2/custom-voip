/**
 * CallsTable — the merged Calls & Quality results table.
 *
 * Column union of the CDR Search table and the Call Quality table: Time,
 * Customer (staff), Product, Dir, From, To, Duration, Quality pill, Loss %,
 * Status, Carrier (staff), Trunk, Cost Est. (staff). Row click opens the call-detail
 * modal (the old inline expanded-row idiom is gone — the modal carries all
 * of it and more, including the hangup cause, which no longer gets a column
 * but stays in the modal's Call Info and the CSV export).
 *
 * Carrier/Trunk cells render via the shared callsFormat.ts mapping (also
 * used by the modal + CSV): inbound rows show the origination carrier+PoP,
 * outbound rows the terminating carrier_used fold, on-net rows an "On-net"
 * pill. Trunk resolves id → name from the page's already-fetched
 * /v1/trunks list (no per-row fetches); em dash for RCF calls.
 *
 * Tenants: the API withholds carrier/routing fields and exact seconds
 * (services/tenant_redaction.py), so the Carrier column is staff-only and
 * Duration renders whole minutes via utils/callDuration.ts.
 *
 * Leg column (staff, only when the Rows filter is All legs / Carrier legs):
 * a small badge — "A" for the call row, "B #n" for carrier bridge attempt n,
 * em dash for pre-split legacy rows. Hidden in the default Calls mode, so the
 * default staff table and every tenant table render exactly as before.
 *
 * Quality column (docs/CALL_QUALITY_ACCURACY_PLAN.md §E.4): the pill is the
 * CALL grade (`call_quality_grade`, the worse audio direction) with the call
 * MOS; one-way audio reads a red "One-way"; ungraded calls read "—" with the
 * reason in the tooltip. Carrier B rows (staff All-legs / Carrier-legs views)
 * carry no call grade, so they show their own leg grade. Loss % renders only
 * for rated rows (`quality_status === 'rated'`) — never a number for a call
 * that was not measured. Grades come from quality.ts only.
 *
 * Cost is labeled "Cost Est." — RCF-V1 billing is estimates-only by design;
 * the billing of record is Equinox (title attr says so).
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
import { gradeLabel, gradeTone, packetLossColor, qualityStatusReason, INK_FAINT } from './quality';
import type { Grade, QualityStatus } from './quality';
import { carrierLabel, isOnNetCall, trunkLabel, EMPTY } from './callsFormat';
import { fmtCallDuration } from '../../utils/callDuration';
import type { Cdr, CdrRowsMode, ProductType, CallDirection } from '../../types/cdr';

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

interface GradePillProps {
  grade: Grade | null | undefined;
  status: QualityStatus | null | undefined;
  /** MOS to print inside the pill (omitted / null → the grade word). */
  mos?: number | null;
  /** Staff get the technical "not graded" reason in the tooltip. */
  isStaff: boolean;
}

/**
 * Grade pill — the ONE rendering of a quality grade on the Calls surfaces.
 * One-way audio → red "One-way"; ungraded → "—" with the reason as tooltip.
 */
export function GradePill({ grade, status, mos, isStaff }: GradePillProps) {
  const reason = qualityStatusReason(status, isStaff ? 'staff' : 'customer');
  if (grade == null) {
    return (
      <span style={{ color: '#b6c2d4' }} title={reason ?? undefined} aria-label={reason ?? 'Not graded'}>
        —
      </span>
    );
  }
  const tone = gradeTone(grade);
  const word = gradeLabel(grade, status);
  const text = status === 'no_rtp' || mos == null ? word : mos.toFixed(2);
  return (
    <span
      title={status === 'no_rtp' ? (reason ?? word) : `${word}${mos != null ? ` · MOS ${mos.toFixed(2)}` : ''}`}
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
      {text}
    </span>
  );
}

/** Row → the grade the Quality column shows (call grade; leg grade on B rows). */
function rowGrade(cdr: Cdr): { grade: Grade | null; status: QualityStatus | null; mos: number | null } {
  if (cdr.leg === 'B') {
    return { grade: cdr.quality_grade ?? null, status: cdr.quality_status ?? null, mos: cdr.mos ?? null };
  }
  return {
    grade: cdr.call_quality_grade ?? null,
    status: cdr.call_quality_status ?? null,
    mos: cdr.call_mos ?? null,
  };
}

/** "A" / "B #attempt" leg badge; em dash on legacy (pre-split) rows. */
function LegBadge({ cdr }: { cdr: Cdr }) {
  if (cdr.leg === 'A') {
    return <span className="dl-tag" title="Call row (A-leg)">A</span>;
  }
  if (cdr.leg === 'B') {
    return (
      <span
        className="dl-tag dl-tag-slate"
        title={cdr.leg_attempt != null ? `Carrier bridge attempt ${cdr.leg_attempt}` : 'Carrier bridge attempt'}
        style={{ whiteSpace: 'nowrap' }}
      >
        B{cdr.leg_attempt != null ? ` #${cdr.leg_attempt}` : ''}
      </span>
    );
  }
  return <span style={{ color: INK_FAINT }} title="Legacy row (pre leg split)">—</span>;
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
  /** Map from trunk id (stringified) to trunk name for the Trunk column —
      the page's already-fetched /v1/trunks list; NO per-row fetches. */
  trunkNames?: Record<string, string>;
  /** Quick-filter text (client-side, this page only). */
  quickFilter: string;
  onQuickFilterChange: (value: string) => void;
  onSelect: (cdr: Cdr) => void;
  selectedUuid: string | null;
  /** Admin or support — Customer + Cost columns render only for staff. */
  isStaff: boolean;
  /** Committed row model — the Leg column shows for staff when not 'calls'. */
  rowsMode?: CdrRowsMode;
}

export function CallsTable({
  cdrs,
  pageRowCount,
  customerNames,
  trunkNames,
  quickFilter,
  onQuickFilterChange,
  onSelect,
  selectedUuid,
  isStaff,
  rowsMode = 'calls',
}: CallsTableProps) {
  const showLeg = isStaff && rowsMode !== 'calls';
  const colCount = (isStaff ? 13 : 10) + (showLeg ? 1 : 0);
  const minWidth = (isStaff ? 1240 : 940) + (showLeg ? 70 : 0);

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
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth }}>
          <thead>
            <tr>
              <th className="dl-th">Time</th>
              {showLeg && <th className="dl-th">Leg</th>}
              {isStaff && <th className="dl-th">Customer</th>}
              <th className="dl-th">Product</th>
              <th className="dl-th">Dir</th>
              <th className="dl-th">From</th>
              <th className="dl-th">To</th>
              <th className="dl-th">Duration</th>
              <th className="dl-th" title="Call quality — the worse of the two audio directions">Quality</th>
              <th className="dl-th">Loss %</th>
              <th className="dl-th">Status</th>
              {isStaff && <th className="dl-th">Carrier</th>}
              <th className="dl-th">Trunk</th>
              {isStaff && (
                <th className="dl-th" title="Estimated cost — billing of record is Equinox">
                  Cost Est.
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {cdrs.length === 0 && (
              <tr>
                <td colSpan={colCount} style={{ padding: 20 }}>
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
              const carrier = carrierLabel(cdr);
              const q = rowGrade(cdr);
              const lossPct = cdr.quality_status === 'rated' ? (cdr.packet_loss_pct ?? null) : null;
              const trunk = trunkLabel(cdr.trunk_id, trunkNames);
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
                  {showLeg && (
                    <td className="dlx-td"><LegBadge cdr={cdr} /></td>
                  )}
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
                      {fmtCallDuration(cdr, fmtDurationSec)}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <GradePill grade={q.grade} status={q.status} mos={q.mos} isStaff={isStaff} />
                  </td>
                  <td className="dlx-td">
                    <span
                      style={{
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 600,
                        color: lossPct != null ? packetLossColor(lossPct) : INK_FAINT,
                      }}
                    >
                      {lossPct != null ? `${lossPct.toFixed(2)}%` : '—'}
                    </span>
                  </td>
                  <td className="dlx-td">
                    <span className={answered ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
                      {answered ? 'Ans' : 'N/A'}
                    </span>
                  </td>
                  {isStaff && (
                    <td className="dlx-td">
                      {isOnNetCall(cdr) ? (
                        <span className="dl-tag">On-net</span>
                      ) : (
                        <span
                          style={{
                            whiteSpace: 'nowrap',
                            color: carrier === EMPTY ? INK_FAINT : 'var(--rcf-ink)',
                          }}
                        >
                          {carrier}
                        </span>
                      )}
                    </td>
                  )}
                  <td
                    className="dlx-td"
                    style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    <span style={{ color: trunk === EMPTY ? INK_FAINT : 'var(--rcf-ink)' }}>
                      {trunk}
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
