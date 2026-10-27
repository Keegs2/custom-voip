/**
 * Report controls — pure presentation; the page owns state.
 *
 *   ReportControls   the slim scope bar (docker/ui/CLAUDE.md §20.1): period
 *                    presets · number picker · "Oct 1 – Oct 22, 2026 · your
 *                    time zone" on ONE row at desktop. Custom dates open
 *                    inline in the same bar (it may wrap to a second line).
 *   ReportDownloads  the two downloads (CSV + PDF summary) — the page puts
 *                    them in the header's action slot.
 */
import { Download, FileText } from 'lucide-react';
import type { MyNumber } from '../../types/reports';
import { NumberPicker } from './NumberPicker';
import { fmtRange, MAX_SPAN_DAYS, PRESET_OPTIONS, type DateRange, type PeriodPreset } from './reportFormat';

interface ReportControlsProps {
  preset: PeriodPreset;
  onPresetChange: (preset: PeriodPreset) => void;
  /** The range the report is currently showing. */
  range: DateRange;
  /** Custom-picker draft values (only used while preset === 'custom'). */
  customStart: string;
  customEnd: string;
  onCustomChange: (start: string, end: string) => void;
  customError: string | null;
  today: string;
  tz: string;

  numberOptions: MyNumber[];
  selectedNumbers: string[];
  onNumbersChange: (next: string[]) => void;
  numbersLoading: boolean;
  numbersFailed: boolean;
  /** Number filtering is off (staff "All customers"), with this reason beside the picker. */
  numbersOffHint?: string;
}

export function ReportControls(props: ReportControlsProps) {
  const {
    preset, onPresetChange, range, customStart, customEnd, onCustomChange, customError, today, tz,
    numberOptions, selectedNumbers, onNumbersChange, numbersLoading, numbersFailed, numbersOffHint,
  } = props;

  return (
    <section className="dl-panel rpt-scopebar" aria-label="Report settings">
      <div className="rpt-scopebar-group">
        <span className="dl-flabel" id="rpt-period-label">Period</span>
        <div className="dlx-seg" role="group" aria-labelledby="rpt-period-label">
          {PRESET_OPTIONS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              className={preset === p.id ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
              onClick={() => onPresetChange(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="rpt-scopebar-group rpt-custom-dates">
          <label className="dl-flabel" htmlFor="rpt-start">From</label>
          <input
            id="rpt-start"
            type="date"
            className="dl-input"
            value={customStart}
            max={today}
            aria-invalid={customError != null}
            aria-describedby="rpt-custom-help"
            onChange={(e) => onCustomChange(e.target.value, customEnd)}
          />
          <label className="dl-flabel" htmlFor="rpt-end">To</label>
          <input
            id="rpt-end"
            type="date"
            className="dl-input"
            value={customEnd}
            min={customStart || undefined}
            max={today}
            aria-invalid={customError != null}
            aria-describedby="rpt-custom-help"
            onChange={(e) => onCustomChange(customStart, e.target.value)}
          />
          <span id="rpt-custom-help" role={customError ? 'alert' : undefined} className="rpt-custom-help">
            {customError ? (
              <span className="dlx4-ferr">{customError}</span>
            ) : (
              <span className="dl-help" style={{ margin: 0 }}>Up to {MAX_SPAN_DAYS} days. Both days are included.</span>
            )}
          </span>
        </div>
      )}

      <NumberPicker
        options={numberOptions}
        selected={selectedNumbers}
        onChange={onNumbersChange}
        loading={numbersLoading}
        failed={numbersFailed}
        offHint={numbersOffHint}
      />

      <p className="rpt-tzline" title={`Showing ${fmtRange(range.start, range.end)}. Times are in your time zone (${tz.replace(/_/g, ' ')}).`}>
        <strong>{fmtRange(range.start, range.end)}</strong> · {zoneWords(tz)}
      </p>
    </section>
  );
}

/** "America/New_York" → "New York time"; "UTC" → "UTC time". The full zone is in the line's tooltip. */
function zoneWords(tz: string): string {
  const city = tz.split('/').pop() ?? tz;
  return `${city.replace(/_/g, ' ')} time`;
}

interface ReportDownloadsProps {
  canDownload: boolean;
  csvBusy: boolean;
  pdfBusy: boolean;
  onDownloadCsv: () => void;
  onDownloadPdf: () => void;
}

/** CSV + PDF summary downloads — the page's primary actions (header, right). */
export function ReportDownloads({ canDownload, csvBusy, pdfBusy, onDownloadCsv, onDownloadPdf }: ReportDownloadsProps) {
  return (
    <>
      <button
        type="button"
        className="dl-btn dl-btn-ghost rpt-dl-btn"
        onClick={onDownloadCsv}
        disabled={!canDownload || csvBusy}
        aria-busy={csvBusy || undefined}
        aria-label={csvBusy ? undefined : 'Download spreadsheet (CSV)'}
        title="Every call in this report as a spreadsheet (CSV), with your call list filters"
      >
        <Download size={14} aria-hidden="true" />
        {csvBusy ? 'Preparing spreadsheet…' : 'Spreadsheet (CSV)'}
      </button>
      <button
        type="button"
        className="dl-btn dl-btn-primary rpt-dl-btn"
        onClick={onDownloadPdf}
        disabled={!canDownload || pdfBusy}
        aria-busy={pdfBusy || undefined}
        aria-label={pdfBusy ? undefined : 'Download PDF summary'}
        title="A one-page PDF summary of this report"
      >
        <FileText size={14} aria-hidden="true" />
        {pdfBusy ? 'Making PDF…' : 'PDF summary'}
      </button>
    </>
  );
}
