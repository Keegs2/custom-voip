/**
 * CallsTable — the merged Calls & Quality results table.
 *
 * Columns (2026-10 layout pass, docker/ui/CLAUDE.md §20 — the table FITS the
 * content column at 1440×900 for staff and tenants; narrower, it pans inside
 * its own panel): Time · Leg (staff, All/Carrier legs only) · Customer
 * (staff) · Call (direction icon + product tag) · From · To · Duration
 * (a red "N/A" pill when the call was not answered — the old Status column)
 * · Quality (pill; packet loss in its tooltip) · Loss % (only where the
 * panel has room — a container query: tenants from ~860px of table, staff
 * from ~1200px) · Carrier (staff) · Trunk · Cost Est. (staff). Secondary
 * fields moved OUT of the table into the call-detail modal, which already
 * carried them: the per-direction packet loss (and the Loss % column where
 * it does not fit), the answered/not-answered status pill, the full year of
 * the timestamp (tooltip too). Row click opens the
 * call-detail modal (the old inline expanded-row idiom is gone — the modal
 * carries all of it and more, including the hangup cause, which no longer
 * gets a column but stays in the modal's Call Info and the CSV export).
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
import { useEffect, useState } from 'react';
import { PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { fmt, fmtMoneySmart } from '../../utils/format';
import { gradeLabel, gradeTone, packetLossColor, qualityStatusReason, INK_FAINT } from './quality';
import type { Grade, QualityStatus } from './quality';
import { carrierLabel, isOnNetCall, trunkLabel, EMPTY } from './callsFormat';
import { fmtCallDuration } from '../../utils/callDuration';
import type { Cdr, CdrRowsMode, ProductType, CallDirection } from '../../types/cdr';
import { productTag } from '../../config/products';
import { T } from '../../styles/theme';

/** The ungraded "—" — the Calls page token (dl-platform-b.css), faint on both grounds. */
const GHOST = 'var(--cq-ghost)';

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

/** The table's compact stamp: "10-22 15:16:00" — the year only when it is
    not the current one (the full stamp is the cell's tooltip + the modal). */
function fmtTimeShort(iso: string, thisYear: number): string {
  const full = fmtTime(iso);
  return new Date(iso).getFullYear() === thisYear ? full.slice(5) : full;
}

/** Table phone numbers: NANP drops the "+1 " (the modal keeps it). */
function fmtPhoneShort(raw: string): string {
  const pretty = fmt(raw) || raw || '--';
  return pretty.startsWith('+1 (') ? pretty.slice(3) : pretty;
}

function fmtDurationSec(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * The call's direction + product in one compact cell: a phone-in / phone-out
 * icon (inbound azure — traffic toward us, outbound slate; the word is in
 * the tooltip and for screen readers) and the product tag from the shared
 * catalog (unknown products still read).
 */
function CallType({ dir, pt }: { dir: CallDirection; pt: ProductType }) {
  const inbound = dir === 'inbound';
  const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
  return (
    <span className="cq-type" title={inbound ? 'Inbound' : 'Outbound'}>
      <Icon size={13} strokeWidth={2.2} aria-hidden="true" className={inbound ? 'cq-dir cq-dir-in' : 'cq-dir cq-dir-out'} />
      <span className="cq-sr">{inbound ? 'Inbound' : 'Outbound'} </span>
      <span className="dl-tag">{productTag(pt)}</span>
    </span>
  );
}

interface GradePillProps {
  grade: Grade | null | undefined;
  status: QualityStatus | null | undefined;
  /** MOS to print inside the pill (omitted / null → the grade word). */
  mos?: number | null;
  /** Staff get the technical "not graded" reason in the tooltip. */
  isStaff: boolean;
  /** Packet loss % for the tooltip (the table's old Loss % column). */
  lossPct?: number | null;
}

/**
 * Grade pill — the ONE rendering of a quality grade on the Calls surfaces.
 * One-way audio → red "One-way"; ungraded → "—" with the reason as tooltip.
 */
export function GradePill({ grade, status, mos, isStaff, lossPct }: GradePillProps) {
  const reason = qualityStatusReason(status, isStaff ? 'staff' : 'customer');
  if (grade == null) {
    return (
      <span style={{ color: GHOST }} title={reason ?? undefined} aria-label={reason ?? 'Not graded'}>
        —
      </span>
    );
  }
  const tone = gradeTone(grade);
  const word = gradeLabel(grade, status);
  const text = status === 'no_rtp' || mos == null ? word : mos.toFixed(2);
  return (
    <span
      title={
        status === 'no_rtp'
          ? (reason ?? word)
          : `${word}${mos != null ? ` · MOS ${mos.toFixed(2)}` : ''}${lossPct != null ? ` · ${lossPct.toFixed(2)}% packet loss` : ''}`
      }
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
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        color: T.fieldPlaceholder, // the field's own hint grey
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
  // ALL hooks unconditionally at the top (React #310 prevention).
  const { setScroller, left: panLeft, right: panRight } = usePanEdges();
  const showLeg = isStaff && rowsMode !== 'calls';
  const colCount = (isStaff ? 11 : 8) + (showLeg ? 1 : 0);
  // Below this the table pans inside its panel (never the page).
  const minWidth = (isStaff ? 1040 : 760) + (showLeg ? 60 : 0);
  const thisYear = new Date().getFullYear();

  return (
    <section className={`dl-panel cq-records ${isStaff ? 'cq-records--staff' : 'cq-records--tenant'}`}>
      {/* Quick-filter toolbar — client-side, current page only */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 20px',
          borderBottom: `1px solid ${T.line}`,
          background: T.tint,
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
        <span style={{ fontSize: '0.72rem', color: T.textDim, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {quickFilter
            ? `${cdrs.length.toLocaleString()} of ${pageRowCount.toLocaleString()} on this page`
            : `${cdrs.length.toLocaleString()} on this page`}
        </span>
      </div>

      <div className={`cq-panwrap${panLeft ? ' is-left' : ''}${panRight ? ' is-right' : ''}`}>
        <div ref={setScroller} className="dlx4-tablewrap">
          <table className="cq-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth }}>
            <thead>
              <tr>
                <th className="dl-th">Time</th>
                {showLeg && <th className="dl-th">Leg</th>}
                {isStaff && <th className="dl-th">Customer</th>}
                <th className="dl-th" title="Direction and product">Call</th>
                <th className="dl-th">From</th>
                <th className="dl-th">To</th>
                <th className="dl-th" title="Talk time — N/A when the call was not answered">Duration</th>
                <th className="dl-th" title="Call quality — the worse of the two audio directions; packet loss in the tooltip">Quality</th>
              <th className="dl-th cq-col-loss">Loss %</th>
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
                          <p style={{ fontWeight: 600, margin: 0, color: T.text }}>No records found</p>
                          <p style={{ fontSize: '0.74rem', margin: '4px 0 0' }}>Adjust your filters and search again.</p>
                        </>
                      ) : (
                        <>
                          <p style={{ fontWeight: 600, margin: 0, color: T.text }}>No rows match the quick filter</p>
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
                    ? T.accentText
                    : T.textDim;

                return (
                  <tr
                    key={cdr.uuid}
                    className={isSelected ? 'dl-row dlx-row-active' : 'dl-row'}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onSelect(cdr)}
                  >
                    <td className="dlx-td">
                      <span className="dlx4-mono" style={{ color: T.textDim }} title={fmtTime(cdr.start_time)}>
                        {fmtTimeShort(cdr.start_time, thisYear)}
                      </span>
                    </td>
                    {showLeg && (
                      <td className="dlx-td"><LegBadge cdr={cdr} /></td>
                    )}
                    {isStaff && (
                      <td className="dlx-td">
                        {/* title = the full name when the cell truncates */}
                        <span className="cq-clip cq-clip-customer" style={{ color: T.textDim }} title={customerNames?.[cdr.customer_id]}>
                          {customerNames?.[cdr.customer_id] ?? `#${cdr.customer_id}`}
                        </span>
                      </td>
                    )}
                    <td className="dlx-td"><CallType dir={cdr.direction} pt={cdr.product_type} /></td>
                    <td className="dlx-td">
                      <span style={{ color: T.text, whiteSpace: 'nowrap' }} title={fmt(cdr.caller_id) || cdr.caller_id || undefined}>
                        {fmtPhoneShort(cdr.caller_id)}
                      </span>
                    </td>
                    <td className="dlx-td">
                      <span style={{ color: T.text, whiteSpace: 'nowrap' }} title={fmt(cdr.destination) || cdr.destination || undefined}>
                        {fmtPhoneShort(cdr.destination)}
                      </span>
                    </td>
                    <td className="dlx-td">
                      {answered ? (
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: T.text }}>
                          {fmtCallDuration(cdr, fmtDurationSec)}
                        </span>
                      ) : (
                        <span className="dl-pill dl-pill-off" title="Not answered">N/A</span>
                      )}
                    </td>
                    <td className="dlx-td">
                      <GradePill grade={q.grade} status={q.status} mos={q.mos} isStaff={isStaff} lossPct={lossPct} />
                    </td>
                    <td className="dlx-td cq-col-loss">
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
                    {isStaff && (
                      <td className="dlx-td">
                        {isOnNetCall(cdr) ? (
                          <span className="dl-tag">On-net</span>
                        ) : (
                          <span
                            style={{
                              whiteSpace: 'nowrap',
                              color: carrier === EMPTY ? INK_FAINT : T.text,
                            }}
                          >
                            {carrier}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="dlx-td">
                      <span
                        className="cq-clip cq-clip-trunk"
                        style={{ color: trunk === EMPTY ? INK_FAINT : T.text }}
                        title={trunk === EMPTY ? undefined : trunk}
                      >
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
      </div>
    </section>
  );
}

/**
 * Which edges of the table scroller have more table beyond them — drives the
 * soft "more this way" shades while the table pans inside its panel (it fits
 * at 1440 × 900; narrower windows and the Leg column make it pan).
 */
function usePanEdges(): { setScroller: (el: HTMLDivElement | null) => void; left: boolean; right: boolean } {
  // A callback ref held in state: the effect re-subscribes if the scroller
  // element is ever replaced.
  const [el, setScroller] = useState<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const left = el.scrollLeft > 1;
      const right = max > 1 && el.scrollLeft < max - 1;
      setEdges((cur) => (cur.left === left && cur.right === right ? cur : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [el]);

  return { setScroller, left: edges.left, right: edges.right };
}
