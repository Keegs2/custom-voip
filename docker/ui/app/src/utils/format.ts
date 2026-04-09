/**
 * Formats a phone number string into a consistent display form.
 * Handles E.164 (+1XXXXXXXXXX) and plain 10-digit US numbers.
 * Returns the original string if no pattern matches.
 */
export function fmt(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  // E.164 US number: +1 (XXX) XXX-XXXX
  if (digits.length === 11 && digits.startsWith('1')) {
    const area = digits.slice(1, 4);
    const exchange = digits.slice(4, 7);
    const subscriber = digits.slice(7);
    return `+1 (${area}) ${exchange}-${subscriber}`;
  }

  // Plain 10-digit US number: (XXX) XXX-XXXX
  if (digits.length === 10) {
    const area = digits.slice(0, 3);
    const exchange = digits.slice(3, 6);
    const subscriber = digits.slice(6);
    return `(${area}) ${exchange}-${subscriber}`;
  }

  return phone;
}

/**
 * Formats a number as USD currency.
 * Examples: 1234.5 → "$1,234.50", 0.005 → "$0.01"
 */
export function fmtMoney(amount: number, decimals = 2): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

/**
 * Formats a per-minute rate with up to 6 decimal places.
 * Trims trailing zeros while keeping at least 4 significant decimal digits.
 * Example: 0.012400 → "$0.0124/min"
 */
export function fmtRate(ratePerMin: number): string {
  const formatted = ratePerMin.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return `$${formatted}/min`;
}

/**
 * Escapes HTML special characters to prevent XSS when injecting into innerHTML.
 * Prefer React's JSX escaping instead — use this only for legacy interop.
 */
export function escHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Formats seconds as "Xm Ys" or "Xs" for call duration display.
 */
export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
