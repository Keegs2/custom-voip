/**
 * products.ts — the dashboard's product switcher, as data.
 *
 * Today only Remote Call Forwarding has a dashboard; the others render in the
 * switcher dimmed with "Soon". To light one up later: flip `live`, list the
 * account types that own it, and render its cards in AccountDashboard where
 * it branches on `activeProduct` — the switcher, its keyboard handling and
 * the "available for this account" rule need no change.
 */
import type { AccountType } from '../../types/customer';

export type DashboardProductId = 'rcf' | 'trunk' | 'voicemail';

export interface DashboardProduct {
  id: DashboardProductId;
  /** Switcher label. */
  label: string;
  /** Header kicker when this product is showing. */
  title: string;
  /** Has a dashboard panel today. */
  live: boolean;
  /** Account types that own the product. */
  accountTypes: readonly AccountType[];
}

export const DASHBOARD_PRODUCTS: readonly DashboardProduct[] = [
  { id: 'rcf', label: 'Call forwarding', title: 'Remote call forwarding', live: true, accountTypes: ['rcf', 'hybrid', 'ucaas'] },
  { id: 'trunk', label: 'SIP Trunking', title: 'SIP trunking', live: false, accountTypes: ['trunk', 'hybrid'] },
  { id: 'voicemail', label: 'Visual Voicemail', title: 'Visual voicemail', live: false, accountTypes: [] },
];

/**
 * Whether a product can be switched to for this account. An unknown account
 * type (e.g. the API omitted it) is treated as RCF — the platform's default.
 */
export function isProductAvailable(product: DashboardProduct, accountType: AccountType | null): boolean {
  if (!product.live) return false;
  return product.accountTypes.includes(accountType ?? 'rcf');
}
