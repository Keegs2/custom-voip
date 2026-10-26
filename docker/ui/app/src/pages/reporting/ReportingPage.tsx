/**
 * ReportingPage — `/reporting`, the customer-facing "how did my calls go?"
 * page (docs/CUSTOMER_REPORTING_DESIGN.md). Laid out with the layout kit
 * (docker/ui/CLAUDE.md §20 — balanced, compact, expandable):
 *
 *   ┌ CompactHeader: Insights / Granite CRAG · Reporting   [Customer ▾]  [Download spreadsheet] [Download PDF summary] ┐
 *   ┌ scope bar (one slim row): Period [This month|…] · Numbers [All numbers ▾] ·  Oct 1 – Oct 22, 2026 · times in … ┐
 *   ┌ Summary: sentence + 5 figures ┐ ┌ Calls over time (chart fills the row) ────────────┐   one row, one height
 *   ┌ Busiest times ┐ ┌ Missed calls & why ┐ ┌ Call quality ┐                                  one row, one height
 *   ┌ Your numbers — 8 rows, "Show all N numbers" opens the rest inside a capped scroll ─┐
 *   ┌ Every call — filters · capped, scrolling table (sticky heads) · pager ─────────────┐
 *   ┌ Words on this page ⌄ (collapsed) ──────────────────────────────────────────────────┐
 *
 * Every card's "What does this mean?" is a collapsed disclosure. Staff pick
 * the customer in the header (a report is always about ONE customer — the
 * API 422s a staff request without customer_id); an admin in "View as
 * Customer" reports on the sidebar's preview customer (named in the crumb
 * with an amber "Staff preview" tag, no picker). Tenants never see a picker
 * and never send customer_id. The downloads are the header's actions.
 *
 * Scope model: ONE `ReportScope` object (dates + browser tz + numbers +
 * staff customer) feeds every query and both exports, so the page, the CSV
 * and the PDF always describe the identical slice of calls.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Info } from 'lucide-react';
import { BalancedGrid, CompactHeader } from '../../components/layout/kit';
import { useAuth } from '../../contexts/AuthContext';
import { listCustomers } from '../../api/customers';
import { downloadReportCsv, reportQuery } from '../../api/reports';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import { saveBlob } from '../../utils/download';
import type { ReportScope } from '../../types/reports';
import { CallList, type CallListFilters } from './CallList';
import { NumbersTable } from './NumbersTable';
import { BusiestCard, Glossary, MissedCard, QualityCard, SummaryHero, TrendCard } from './ReportCards';
import { ReportControls, ReportDownloads } from './ReportControls';
import {
  browserTimeZone,
  fmtLongDate,
  fmtPhone,
  fmtRange,
  presetRange,
  toIsoDate,
  validateRange,
  type DateRange,
  type PeriodPreset,
} from './reportFormat';
import { buildSummarySentence, sentenceText } from './summarySentence';
import { useMyNumbers, useReportNumbers, useReportOverview, useReportTrend } from './useReports';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform-b.css';
import '../../styles/dl-reporting.css';
import { T } from '../../styles/theme';

/** Customers whose accounts have Reporting (mirrors utils/reportingAccess). */
const REPORTABLE_TYPES = ['rcf', 'trunk', 'hybrid'];

const DEFAULT_FILTERS: CallListFilters = { outcome: 'all', direction: 'all' };

/**
 * Route entry. Keyed on the previewed customer so an admin switching the
 * sidebar preview starts a fresh report (numbers, filters) — a remount, not
 * a hook-order change.
 */
export function ReportingPage() {
  const { customerViewMode, effectiveCustomer } = useAuth();
  const key = customerViewMode ? `preview-${effectiveCustomer?.id ?? 'none'}` : 'own';
  return <ReportingView key={key} />;
}

function ReportingView() {
  // ── ALL hooks unconditionally at the top (React #310 prevention) ──────────
  const { user, isActualAdmin, customerViewMode, effectiveCustomer } = useAuth();
  const { toastOk, toastErr } = useToast();

  // Staff = real admins. In customer-view mode the API still sees an admin
  // token, so the picker stays (framed as "previewing").
  const isStaffViewer = isActualAdmin;

  const [today] = useState(() => toIsoDate(new Date()));
  const [tz] = useState(browserTimeZone);

  // `?customer=ID` (admin dashboard links) pre-selects the staff customer.
  const [searchParams] = useSearchParams();
  const [pickedCustomerId, setStaffCustomerId] = useState<number | undefined>(() => {
    const raw = searchParams.get('customer');
    return isStaffViewer && raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  });
  // An admin in "View as Customer" reports on the customer picked in the
  // sidebar; otherwise staff pick here.
  const previewCustomer = isStaffViewer && customerViewMode ? effectiveCustomer : null;
  const staffCustomerId = previewCustomer?.id ?? pickedCustomerId;
  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [customRange, setCustomRange] = useState<DateRange | null>(null);
  const [selectedNumbers, setSelectedNumbers] = useState<string[]>([]);
  const [listFilters, setListFilters] = useState<CallListFilters>(DEFAULT_FILTERS);
  const [csvBusy, setCsvBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [csvTruncated, setCsvTruncated] = useState(false);

  const { data: customersData, isLoading: customersLoading } = useQuery({
    queryKey: ['customers-all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 5 * 60 * 1000,
    enabled: isStaffViewer,
  });
  const staffCustomers = useMemo(
    () =>
      (customersData?.items ?? [])
        .filter((c) => REPORTABLE_TYPES.includes(c.account_type))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [customersData],
  );

  const range: DateRange = useMemo(() => {
    if (preset === 'custom') {
      return customRange ?? presetRange('this_month', new Date(`${today}T12:00:00`));
    }
    return presetRange(preset, new Date(`${today}T12:00:00`));
  }, [preset, customRange, today]);

  const customerId = isStaffViewer ? staffCustomerId : undefined;
  const scopeReady = !isStaffViewer || staffCustomerId !== undefined;

  const scope: ReportScope = useMemo(
    () => ({ start: range.start, end: range.end, tz, numbers: selectedNumbers, customer_id: customerId }),
    [range, tz, selectedNumbers, customerId],
  );
  const scopeKey = reportQuery(scope).toString();

  const overview = useReportOverview(scope, scopeReady);
  const trend = useReportTrend(scope, scopeReady);
  const numbers = useReportNumbers(scope, scopeReady);
  const myNumbers = useMyNumbers(customerId, scopeReady);

  const sentence = useMemo(
    () => (overview.data ? buildSummarySentence(overview.data, preset, range, selectedNumbers.length > 0) : null),
    [overview.data, preset, range, selectedNumbers.length],
  );

  const customerName = isStaffViewer
    ? (previewCustomer?.name ?? staffCustomers.find((c) => c.id === staffCustomerId)?.name ?? null)
    : (user?.customer_name ?? null);

  const customError = preset === 'custom' ? validateRange(customStart, customEnd) : null;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handlePresetChange = useCallback(
    (next: PeriodPreset) => {
      if (next === 'custom' && !customStart && !customEnd) {
        // Seed the pickers with whatever is showing now.
        setCustomStart(range.start);
        setCustomEnd(range.end);
        setCustomRange(range);
      }
      setPreset(next);
      setCsvTruncated(false);
    },
    [customStart, customEnd, range],
  );

  const handleCustomChange = useCallback((start: string, end: string) => {
    setCustomStart(start);
    setCustomEnd(end);
    // Only apply a usable range; an invalid draft keeps the last good report on screen.
    if (validateRange(start, end) == null) {
      setCustomRange({ start, end });
      setCsvTruncated(false);
    }
  }, []);

  const handleCustomerChange = useCallback((value: string) => {
    setStaffCustomerId(value ? Number(value) : undefined);
    // Numbers belong to a customer — a new customer starts from "all numbers".
    setSelectedNumbers([]);
    setListFilters(DEFAULT_FILTERS);
    setCsvTruncated(false);
  }, []);

  const handleNumbersChange = useCallback((next: string[]) => {
    setSelectedNumbers(next);
    setCsvTruncated(false);
  }, []);

  async function handleDownloadCsv(): Promise<void> {
    setCsvBusy(true);
    try {
      const result = await downloadReportCsv(scope, listFilters);
      saveBlob(result.blob, result.filename);
      setCsvTruncated(result.truncated);
      const filtered = listFilters.outcome !== 'all' || listFilters.direction !== 'all';
      toastOk(filtered ? 'Spreadsheet downloaded (with your call list filters).' : 'Spreadsheet downloaded.');
    } catch (err) {
      toastErr(
        err instanceof ApiError && err.status === 422
          ? err.message
          : 'We couldn’t make the spreadsheet just now. Please try again in a moment.',
      );
    } finally {
      setCsvBusy(false);
    }
  }

  async function handleDownloadPdf(): Promise<void> {
    if (!overview.data || !sentence) return;
    setPdfBusy(true);
    try {
      // Lazy chunk — react-pdf only loads when someone actually wants a PDF.
      const { renderReportPdf } = await import('./reportPdf');
      const blob = await renderReportPdf({
        customerName,
        rangeLabel: fmtRange(range.start, range.end),
        tz,
        sentence: sentenceText(sentence),
        numbersNote: numbersNote(selectedNumbers),
        overview: overview.data,
        trend: trend.data ?? null,
        numbers: numbers.data ?? null,
      });
      saveBlob(blob, `call-report_${range.start}_${range.end}.pdf`);
      toastOk('PDF summary downloaded.');
    } catch {
      toastErr('We couldn’t make the PDF just now. Please try again in a moment.');
    } finally {
      setPdfBusy(false);
    }
  }

  // ── Derived view state ─────────────────────────────────────────────────────

  const availableFrom = overview.data?.data_available_from ?? null;
  const startsBeforeHistory = availableFrom != null && range.start < availableFrom;
  const noHistoryAtAll = overview.data != null && availableFrom == null;

  const overviewState = {
    data: overview.data,
    isLoading: overview.isLoading,
    error: overview.error,
    refetch: () => void overview.refetch(),
  };

  const crumbTail = previewCustomer?.name ?? 'Granite CRAG';
  const staffTag = isStaffViewer ? (customerViewMode ? 'Staff preview' : 'Staff') : null;

  // Staff (not previewing a sidebar customer) pick the customer in the header.
  const customerPicker =
    isStaffViewer && !previewCustomer ? (
      <div className="rpt-headpick">
        <label className="dl-flabel" htmlFor="rpt-customer">
          {customerViewMode ? 'Previewing' : 'Customer'}
        </label>
        <select
          id="rpt-customer"
          className="dl-input rpt-headpick-select"
          value={staffCustomerId ?? ''}
          onChange={(e) => handleCustomerChange(e.target.value)}
          disabled={customersLoading}
          title="A report always covers one customer. Customers see this page for their own account only."
        >
          <option value="">{customersLoading ? 'Loading customers…' : 'Pick a customer…'}</option>
          {staffCustomers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.account_type.toUpperCase()})
            </option>
          ))}
        </select>
      </div>
    ) : undefined;

  return (
    <div className="dl-scope rpt-scope">
      <div className="dl-shell">
        <CompactHeader
          className="rpt-header fx-load"
          crumb={
            <>
              <span>Insights</span>
              <span className="dl-crumb-sep" aria-hidden="true">/</span>
              <span className="rpt-crumb-tail">{crumbTail}</span>
              {staffTag && <span className="rpt-staff-tag">{staffTag}</span>}
            </>
          }
          title="Reporting"
          subtitle="A simple picture of your calls — how many you had, when they came in, how many were answered and how clear they sounded."
          tools={customerPicker}
          actions={
            scopeReady ? (
              <ReportDownloads
                canDownload={overview.data != null}
                csvBusy={csvBusy}
                pdfBusy={pdfBusy}
                onDownloadCsv={() => void handleDownloadCsv()}
                onDownloadPdf={() => void handleDownloadPdf()}
              />
            ) : undefined
          }
        />

        <div className="dl-stack rpt-body fx-load fx-load-d1">
          {!scopeReady ? (
            <section className="dl-panel">
              <div className="dl-center">
                <div className="dl-center-icon"><Info size={26} aria-hidden="true" /></div>
                <p style={{ margin: 0, fontWeight: 700, color: T.text }}>Pick a customer to see their report</p>
                <p style={{ margin: 0, fontSize: '0.8rem', color: T.textDim }}>
                  Reports are always about one customer’s own calls. Customers see this page for their own account only.
                </p>
              </div>
            </section>
          ) : (
            <>
              <ReportControls
                preset={preset}
                onPresetChange={handlePresetChange}
                range={range}
                customStart={customStart}
                customEnd={customEnd}
                onCustomChange={handleCustomChange}
                customError={customError}
                today={today}
                tz={tz}
                numberOptions={myNumbers.data?.numbers ?? []}
                selectedNumbers={selectedNumbers}
                onNumbersChange={handleNumbersChange}
                numbersLoading={myNumbers.isLoading}
                numbersFailed={myNumbers.isError}
              />

              {csvTruncated && (
                <div className="dl-banner dl-banner-warn rpt-cardmsg" role="status">
                  <span>
                    That’s a lot of calls — your spreadsheet has the first 100,000 only. Pick a shorter period to get
                    the rest.
                  </span>
                  <button type="button" className="rpt-linkbtn" onClick={() => setCsvTruncated(false)}>
                    Dismiss
                  </button>
                </div>
              )}

              {startsBeforeHistory && availableFrom && (
                <div className="dl-note" role="note">
                  <Info size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    We have call history from <strong>{fmtLongDate(availableFrom)}</strong> onward, so this report
                    starts there.
                  </span>
                </div>
              )}
              {noHistoryAtAll && (
                <div className="dl-note" role="note">
                  <Info size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>There’s no call history on this account yet. Once calls start, they’ll show up here.</span>
                </div>
              )}

              {/* Row 1 — the summary leads, the chart takes the row's height. */}
              <BalancedGrid columns="minmax(0, 1fr) minmax(0, 1.6fr)" stackBelow="lg" gap="var(--rcf-stack)">
                <SummaryHero overview={overviewState} sentence={sentence} />
                <TrendCard
                  trend={{ data: trend.data, isLoading: trend.isLoading, error: trend.error, refetch: () => void trend.refetch() }}
                />
              </BalancedGrid>

              {/* Row 2 — three insight cards, one height. */}
              <BalancedGrid columns="repeat(3, minmax(0, 1fr))" stackBelow="lg" gap="var(--rcf-stack)">
                <BusiestCard overview={overviewState} />
                <MissedCard overview={overviewState} />
                <QualityCard overview={overviewState} />
              </BalancedGrid>

              <NumbersTable
                numbers={{ data: numbers.data, isLoading: numbers.isLoading, error: numbers.error, refetch: () => void numbers.refetch() }}
              />

              <CallList key={scopeKey} scope={scope} enabled={scopeReady} filters={listFilters} onFiltersChange={setListFilters} />

              <Glossary />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** PDF subtitle when the report is limited to some numbers. */
function numbersNote(selected: string[]): string | null {
  if (selected.length === 0) return null;
  const shown = [...selected].sort().slice(0, 5).map(fmtPhone).join(', ');
  const more = selected.length > 5 ? ` and ${selected.length - 5} more` : '';
  return `Only these numbers: ${shown}${more}`;
}
