/**
 * policy.ts — the browser MIRROR of the outside-transfer rule (contract §6,
 * plan D4 "outside transfers are US only"), for instant feedback while a
 * customer types a number. The authority is the server
 * (`services/ivr/policy.py`, which pins the NPA tables with a dated source);
 * publish is gated on the server's verdict, never on this file.
 *
 * Rule (§6):
 *   shape    ^\+1[2-9]\d{2}[2-9]\d{6}$ (+1 NANP)
 *   allowed  the 50 states + DC, US territories (PR 787/939, USVI 340,
 *            Guam 671, CNMI 670, AS 684), US toll-free 800/833/844/855/866/877/888
 *   blocked  Canada, Caribbean / other non-US NANP, 900, 976, N11, 555-01xx,
 *            anything else (unassigned 8YY, non-geographic service codes)
 *
 * NPA tables below: NANPA assignments as of 2026-10 (Canadian and
 * non-US-country codes). A US NPA missing here is allowed by the mirror; the
 * server may still refuse a number it knows is unassigned.
 */
import { fmt } from '../../utils/format.ts';

const NANP_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

/** Canadian geographic NPAs (+ 600/622 non-geographic). */
const CANADA = new Set([
  '204', '226', '236', '249', '250', '257', '263', '273', '289', '306', '343', '354', '365', '367', '368',
  '382', '387', '403', '416', '418', '428', '431', '437', '438', '450', '460', '468', '474', '506', '514',
  '519', '548', '579', '581', '584', '587', '600', '604', '613', '622', '639', '647', '672', '683', '705',
  '709', '742', '753', '778', '780', '782', '807', '819', '825', '867', '873', '879', '902', '905', '942',
]);

/** NANP countries other than the US (Caribbean, Bermuda…). */
const OTHER_NANP_COUNTRIES = new Set([
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784',
  '809', '829', '849', '868', '869', '876',
]);

/** US territories — explicitly allowed (§6). */
export const US_TERRITORY_NPAS = new Set(['787', '939', '340', '671', '670', '684']);

/** US toll-free — allowed. */
export const TOLL_FREE_NPAS = new Set(['800', '833', '844', '855', '866', '877', '888']);

/** Non-geographic / service codes that are never a person's line. */
const SERVICE_NPAS = new Set([
  '500', '521', '522', '523', '524', '525', '526', '527', '528', '529', '533', '544', '566', '577', '588',
  '700', '710', '900', '976',
]);

export type ExternalNumberProblem =
  | 'empty'
  | 'not_us_shape'
  | 'international'
  | 'canada'
  | 'caribbean'
  | 'premium'
  | 'service'
  | 'n11'
  | 'fictional'
  | 'toll_free_unassigned';

export interface ExternalCheck {
  /** Canonical +1 number when the input is at least 10 US digits, else null. */
  e164: string | null;
  problem: ExternalNumberProblem | null;
  /** Customer-readable sentence, null when the number is allowed. */
  message: string | null;
}

/**
 * Normalises what a customer typed ("617 555 0134", "(617) 555-0134",
 * "+1 617…", "1-617…") to +1XXXXXXXXXX when it has the right digit count.
 */
export function toUsE164(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null;
  if (s.startsWith('+') && !s.startsWith('+1')) return null;
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

const MESSAGES: Readonly<Record<ExternalNumberProblem, string>> = {
  empty: 'Enter the 10-digit US number to transfer to.',
  not_us_shape: 'That isn’t a complete US number. Enter 10 digits, like (617) 555-0134.',
  international: 'Transfers can only go to US numbers.',
  canada: 'That’s a Canadian number. Transfers can only go to US numbers.',
  caribbean: 'That area code belongs to a country outside the US. Transfers can only go to US numbers.',
  premium: 'Premium-rate numbers (900 and 976) can’t be dialed from an IVR.',
  service: 'That area code is a special service code, not a phone line.',
  n11: 'Short service codes like 411 or 911 can’t be used as a transfer number.',
  fictional: '555-01xx numbers are reserved for fiction and can’t be dialed.',
  toll_free_unassigned: 'That toll-free prefix isn’t in use. US toll-free numbers start with 800, 833, 844, 855, 866, 877 or 888.',
};

function verdict(e164: string | null, problem: ExternalNumberProblem | null): ExternalCheck {
  return { e164, problem, message: problem ? MESSAGES[problem] : null };
}

/** The §6 rule, mirrored. */
export function checkExternalNumber(raw: string): ExternalCheck {
  const trimmed = raw.trim();
  if (trimmed === '') return verdict(null, 'empty');
  if (trimmed.startsWith('+') && !trimmed.startsWith('+1')) return verdict(null, 'international');
  const e164 = toUsE164(trimmed);
  if (!e164) {
    const digits = trimmed.replace(/\D/g, '');
    return verdict(null, digits.length > 11 ? 'international' : 'not_us_shape');
  }
  const npa = e164.slice(2, 5);
  const nxx = e164.slice(5, 8);
  const line = e164.slice(8);
  if (/^[2-9]11$/.test(npa) || /^[2-9]11$/.test(nxx)) return verdict(e164, 'n11');
  if (!NANP_E164.test(e164)) return verdict(e164, 'not_us_shape');
  if (CANADA.has(npa)) return verdict(e164, 'canada');
  if (OTHER_NANP_COUNTRIES.has(npa)) return verdict(e164, 'caribbean');
  if (npa === '900' || npa === '976' || nxx === '976') return verdict(e164, 'premium');
  if (SERVICE_NPAS.has(npa)) return verdict(e164, 'service');
  if (npa.startsWith('8') && npa[1] === npa[2] && !TOLL_FREE_NPAS.has(npa)) {
    return verdict(e164, 'toll_free_unassigned');
  }
  if (nxx === '555' && line.startsWith('01')) return verdict(e164, 'fictional');
  return verdict(e164, null);
}

export function isE164(value: string): boolean {
  return E164.test(value);
}

/** "+16174544217" → "+1 (617) 454-4217" (the app-wide `fmt`). */
export function prettyNumber(e164: string): string {
  return fmt(e164);
}

/**
 * Caller-check values: a prefix is "+" then 1–15 digits (people type "617"
 * meaning +1617 — normalised here); an exact number must be E.164.
 */
export function normalizeCallerValue(raw: string, mode: 'prefix' | 'equals'): string {
  const s = raw.trim();
  if (s === '') return '';
  const d = s.replace(/\D/g, '');
  if (mode === 'equals') return toUsE164(s) ?? (s.startsWith('+') ? `+${d}` : s);
  if (s.startsWith('+')) return `+${d}`;
  // "617" / "1617" / "617555" → +1-prefixed
  if (d.length >= 1 && d.length <= 10 && d[0] !== '1') return `+1${d}`;
  return `+${d}`;
}

export function callerValueProblem(value: string, mode: 'prefix' | 'equals'): string | null {
  if (mode === 'equals') return isE164(value) ? null : `“${value}” isn’t a full phone number.`;
  return /^\+\d{1,15}$/.test(value) ? null : `“${value}” isn’t a number prefix like +1617.`;
}
