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
 * in the header's Customer menu (AdminCustomerPicker — "All customers"
 * pinned on top), and the pick lives in the URL like the other staff pages:
 *
 *   no ?customer     prompt-first — "Select a customer to see their report"
 *   ?customer=<id>   that customer (the API needs customer_id from staff)
 *   ?customer=all    every customer together: every /reports/* call sends
 *                    all_customers=true and no customer_id; the number
 *                    filter is off ("Pick one customer to filter by number" —
 *                    the API 422s numbers there); the numbers table and the
 *                    call list gain a Customer column; the CSV gets one from
 *                    the server; the PDF is titled "All customers".
 *
 * An admin in "View as Customer" reports on the sidebar's preview customer
 * (named in the crumb with an amber "Staff preview" tag, no picker;
 * PreviewPrompt until one is picked). Tenants never see a picker and never
 * send customer_id. The downloads are the header's actions.
 *
 * Scope model: ONE `ReportScope` object (dates + browser tz + numbers +
 * staff customer / all customers) feeds every query and both exports, so
 * the page, the CSV and the PDF always describe the identical slice of
 * calls. The number pick and the call-list filters belong to one scope:
 * they are stored with the scope they were made in and read back only for
 * it, so a new customer (picker, Back, a link) starts from "all numbers".
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Info } from 'lucide-react';
import { AdminCustomerPicker, type AdminCustomerValue } from '../../components/AdminCustomerPicker';
import { AdminScopePrompt } from '../../components/AdminScopePrompt';
import { BalancedGrid, CompactHeader } from '../../components/layout/kit';
import { useAuth } from '../../contexts/AuthContext';
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
import { PreviewPrompt } from '../dashboard/PreviewPrompt';
import { useAdminCustomers } from '../dashboard/adminData';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform-b.css';
import '../../styles/dl-reporting.css';

/** Customers whose accounts have Reporting (mirrors utils/reportingAccess). */
const REPORTABLE_TYPES = ['rcf', 'trunk', 'hybrid'];

const DEFAULT_FILTERS: CallListFilters = { outcome: 'all', direction: 'all' };
const NO_NUMBERS: string[] = [];

const ALL_NUMBERS_ONLY = 'pick one customer to filter by number';

/** `?customer=` → null (absent / junk: nothing chosen yet), 'all', or a customer id. */
function parseStaffScope(raw: string | null): AdminCustomerValue {
  if (raw === 'all') return 'all';
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

/** A value remembered together with the report scope it belongs to. */
interface ScopedValue<T> {
  owner: string;
  value: T;
}

/**
 * Route entry. Keyed on the previewed customer so an admin switching the
 * sidebar preview starts a fresh report (numbers, filters) — a remount, not
 * a hook-order change. An admin in "View as Customer" with nothing picked
 * yet gets the PreviewPrompt, like every other customer page.
 */
export function ReportingPage() {
  const { isActualAdmin, customerViewMode, effectiveCustomer } = useAuth();
  if (isActualAdmin && customerViewMode && !effectiveCustomer) return <PreviewPrompt />;
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

  // An admin in "View as Customer" reports on the customer picked in the
  // sidebar; otherwise staff pick in the header, and the pick is the URL's
  // `?customer=` (dashboard links deep-link it; Back steps through picks).
  const previewCustomer = isStaffViewer && customerViewMode ? effectiveCustomer : null;
  const staffPicks = isStaffViewer && !previewCustomer;
  const [searchParams, setSearchParams] = useSearchParams();
  const staffValue: AdminCustomerValue = staffPicks ? parseStaffScope(searchParams.get('customer')) : null;
  const allMode = staffValue === 'all';

  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [customRange, setCustomRange] = useState<DateRange | null>(null);
  const [numbersPick, setNumbersPick] = useState<ScopedValue<string[]>>({ owner: '', value: NO_NUMBERS });
  const [filtersPick, setFiltersPick] = useState<ScopedValue<CallListFilters>>({ owner: '', value: DEFAULT_FILTERS });
  const [csvBusy, setCsvBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [csvTruncated, setCsvTruncated] = useState(false);

  const customers = useAdminCustomers(staffPicks);
  // Reportable accounts, plus a deep-linked customer of another type so the
  // menu can still name it.
  const staffCustomers = useMemo(() => {
    const all = customers.data ?? [];
    return all.filter((c) => REPORTABLE_TYPES.includes(c.account_type) || c.id === staffValue);
  }, [customers.data, staffValue]);

  const range: DateRange = useMemo(() => {
    if (preset === 'custom') {
      return customRange ?? presetRange('this_month', new Date(`${today}T12:00:00`));
    }
    return presetRange(preset, new Date(`${today}T12:00:00`));
  }, [preset, customRange, today]);

  const customerId = !isStaffViewer
    ? undefined
    : (previewCustomer?.id ?? (typeof staffValue === 'number' ? staffValue : undefined));
  const scopeReady = !isStaffViewer || customerId !== undefined || allMode;
  // Whose report this is — the number pick and the call-list filters belong to it.
  const scopeOwner = allMode ? 'all' : String(customerId ?? 'self');
  const selectedNumbers = !allMode && numbersPick.owner === scopeOwner ? numbersPick.value : NO_NUMBERS;
  const listFilters = filtersPick.owner === scopeOwner ? filtersPick.value : DEFAULT_FILTERS;

  const scope: ReportScope = useMemo(
    () =>
      allMode
        ? { start: range.start, end: range.end, tz, numbers: NO_NUMBERS, all_customers: true }
        : { start: range.start, end: range.end, tz, numbers: selectedNumbers, customer_id: customerId },
    [allMode, range, tz, selectedNumbers, customerId],
  );
  const scopeKey = reportQuery(scope).toString();

  const overview = useReportOverview(scope, scopeReady);
  const trend = useReportTrend(scope, scopeReady);
  const numbers = useReportNumbers(scope, scopeReady);
  // No number picker on All customers, so no number list either.
  const myNumbers = useMyNumbers(customerId, scopeReady && !allMode);

  const sentence = useMemo(
    () =>
      overview.data
        ? buildSummarySentence(overview.data, preset, range, selectedNumbers.length > 0, allMode ? 'all' : 'own')
        : null,
    [overview.data, preset, range, selectedNumbers.length, allMode],
  );

  const customerName = !isStaffViewer
    ? (user?.customer_name ?? null)
    : allMode
      ? 'All customers'
      : (previewCustomer?.name ??
        (customerId !== undefined
          ? (customers.data?.find((c) => c.id === customerId)?.name ?? `Customer #${customerId}`)
          : null));

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

  // A new customer starts from "all numbers" and default filters on its own:
  // those picks are stored with the scope they were made in.
  const handleCustomerChange = useCallback(
    (next: number | 'all') => {
      setSearchParams((prev) => {
        const p = new URLSearchParams(prev);
        p.set('customer', String(next));
        return p;
      });
      setCsvTruncated(false);
    },
    [setSearchParams],
  );

  const handleNumbersChange = useCallback(
    (next: string[]) => {
      setNumbersPick({ owner: scopeOwner, value: next });
      setCsvTruncated(false);
    },
    [scopeOwner],
  );

  const handleFiltersChange = useCallback(
    (next: CallListFilters) => setFiltersPick({ owner: scopeOwner, value: next }),
    [scopeOwner],
  );

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
        allCustomers: allMode,
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

  // The crumb names whose report it is (staff); tenants keep the brand.
  const crumbTail = (isStaffViewer ? customerName : null) ?? 'Granite CRAG';
  const staffTag = isStaffViewer ? (customerViewMode ? 'Staff preview' : 'Staff') : null;

  // Staff (not previewing a sidebar customer) pick the customer in the header.
  const customerPicker = staffPicks ? (
    <div className="rpt-headpick">
      <label className="dl-flabel" htmlFor="rpt-customer">
        Customer
      </label>
      <AdminCustomerPicker
        id="rpt-customer"
        className="dl-input rpt-headpick-select"
        value={staffValue}
        onChange={handleCustomerChange}
        customers={staffCustomers}
        loading={customers.isLoading}
        error={customers.isError}
        title="A report covers one customer, or all customers together. Customers see this page for their own account only."
      />
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
          subtitle={
            allMode
              ? 'Every customer’s calls in one picture — how many there were, when they came in, how many were answered and how clear they sounded.'
              : 'A simple picture of your calls — how many you had, when they came in, how many were answered and how clear they sounded.'
          }
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
            <AdminScopePrompt title="Select a customer to see their report" pickerLabel="Customer" />
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
                numbersOffHint={allMode ? ALL_NUMBERS_ONLY : undefined}
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
                  <span>
                    {allMode
                      ? 'There’s no call history on any customer’s numbers yet. Once calls start, they’ll show up here.'
                      : 'There’s no call history on this account yet. Once calls start, they’ll show up here.'}
                  </span>
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
                <BusiestCard overview={overviewState} allCustomers={allMode} />
                <MissedCard overview={overviewState} />
                <QualityCard overview={overviewState} />
              </BalancedGrid>

              <NumbersTable
                numbers={{ data: numbers.data, isLoading: numbers.isLoading, error: numbers.error, refetch: () => void numbers.refetch() }}
                allCustomers={allMode}
              />

              <CallList key={scopeKey} scope={scope} enabled={scopeReady} filters={listFilters} onFiltersChange={handleFiltersChange} />

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
