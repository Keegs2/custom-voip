import type { Cdr } from '../types/cdr';

/**
 * Escapes a single cell value for CSV: wraps in quotes if it contains
 * commas, double-quotes, or newlines. Doubles any internal double-quotes.
 */
function escapeCell(value: string | number | null | undefined): string {
  const str = value == null ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Converts a 2D array of values into a CSV string.
 */
function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(','));
  return lines.join('\n');
}

/**
 * Triggers a browser download of the given content as a .csv file.
 */
function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const CDR_HEADERS = [
  'UUID',
  'Time',
  'Direction',
  'From',
  'To',
  'Customer ID',
  'Product',
  'Duration (s)',
  'Billable (s)',
  'Total Billed',
  'Carrier Cost',
  'Margin',
  'Hangup Cause',
  'Carrier',
  'SIP Code',
  'Rated',
];

/**
 * Exports an array of CDR records to a CSV file and triggers a browser download.
 */
export function exportCdrsCsv(cdrs: Cdr[]): void {
  const rows = cdrs.map((c) => [
    c.uuid,
    c.start_time,
    c.direction,
    c.caller_id,
    c.destination,
    c.customer_id,
    c.product_type,
    c.duration_seconds,
    c.billable_seconds,
    c.total_cost ?? '',
    c.carrier_cost ?? '',
    c.margin ?? '',
    c.hangup_cause ?? '',
    c.carrier_used ?? '',
    c.sip_code ?? '',
    c.rated_at ? 'Yes' : 'No',
  ]);

  const csv = buildCsv(CDR_HEADERS, rows);
  const dateStr = new Date().toISOString().slice(0, 10);
  downloadCsv(csv, `cdrs_${dateStr}.csv`);
}
