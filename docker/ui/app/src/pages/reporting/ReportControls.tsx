/**
 * Report controls slab: period presets (+ custom date pickers), the number
 * picker, and the two downloads. Pure presentation — the page owns state.
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

  canDownload: boolean;
  csvBusy: boolean;
  pdfBusy: boolean;
  onDownloadCsv: () => void;
  onDownloadPdf: () => void;
}

export function ReportControls(props: ReportControlsProps) {
  const {
    preset, onPresetChange, range, customStart, customEnd, onCustomChange, customError, today, tz,
    numberOptions, selectedNumbers, onNumbersChange, numbersLoading, numbersFailed,
    canDownload, csvBusy, pdfBusy, onDownloadCsv, onDownloadPdf,
  } = props;

  return (
    <section className="dl-panel" aria-label="Report settings">
      <div className="dl-panel-body">
        <div className="rpt-controls">
          <div className="rpt-controls-left">
            <div className="dlx4-field">
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

            <NumberPicker
              options={numberOptions}
              selected={selectedNumbers}
              onChange={onNumbersChange}
              loading={numbersLoading}
              failed={numbersFailed}
            />
          </div>

          <div className="rpt-controls-actions">
            <button
              type="button"
              className="dl-btn dl-btn-ghost"
              onClick={onDownloadCsv}
              disabled={!canDownload || csvBusy}
              aria-busy={csvBusy || undefined}
            >
              <Download size={14} aria-hidden="true" />
              {csvBusy ? 'Preparing spreadsheet…' : 'Download spreadsheet (CSV)'}
            </button>
            <button
              type="button"
              className="dl-btn dl-btn-primary"
              onClick={onDownloadPdf}
              disabled={!canDownload || pdfBusy}
              aria-busy={pdfBusy || undefined}
            >
              <FileText size={14} aria-hidden="true" />
              {pdfBusy ? 'Making PDF…' : 'Download PDF summary'}
            </button>
          </div>
        </div>

        {preset === 'custom' && (
          <div className="rpt-custom-dates">
            <div className="dlx4-field">
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
            </div>
            <div className="dlx4-field">
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
            </div>
            <div id="rpt-custom-help" role={customError ? 'alert' : undefined} style={{ paddingBottom: 9 }}>
              {customError ? (
                <span className="dlx4-ferr">{customError}</span>
              ) : (
                <span className="dl-help" style={{ margin: 0 }}>Up to {MAX_SPAN_DAYS} days at a time. Both days are included.</span>
              )}
            </div>
          </div>
        )}

        <div className="rpt-tzline">
          Showing <strong>{fmtRange(range.start, range.end)}</strong> · times are in your time zone ({tz.replace(/_/g, ' ')})
        </div>
      </div>
    </section>
  );
}
