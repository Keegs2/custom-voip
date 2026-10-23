/**
 * quickActions.tsx — what the dashboard's Quick actions card lists, per
 * audience. The card itself (AccountCards.QuickActionsCard) only renders.
 *
 *   customer (tenant / staff preview)  request or manage numbers · call activity · [voicemail] ·
 *                                      report · all numbers ("Manage call forwarding" when the
 *                                      account has other products too)
 *   admin, one customer                view as this customer · numbers console · [voicemail
 *                                      console] · call activity · Calls & Quality · Reporting ·
 *                                      Troubleshooting
 *   ([…] only while Visual Voicemail is on for the account)
 *   admin, all customers               numbers console · call activity · Calls & Quality ·
 *                                      Reporting · Troubleshooting
 *
 * Admin hrefs come from adminLinks.ts; their sub-lines say whether the page
 * opens on the customer or on its own picker (READS_CUSTOMER_PARAM).
 */
import type { ReactNode } from 'react';
import { Activity, BarChart3, Eye, ListChecks, PhoneIncoming, Plus, Search, Voicemail } from 'lucide-react';
import {
  READS_CUSTOMER_PARAM,
  TROUBLESHOOTING_HREF,
  callsHref,
  rcfConsoleHref,
  reportingHref,
  voicemailConsoleHref,
} from './adminLinks';

export interface QuickAction {
  key: string;
  label: string;
  sub: string;
  icon: ReactNode;
  run: { to: string } | { onClick: () => void };
}

const ICON = { size: 16, strokeWidth: 2.2 } as const;

export interface CustomerQuickActionsArgs {
  numbersLabel: string;
  onNumbers: () => void;
  onActivity: () => void;
  showReports: boolean;
  /** The account has numbers on products other than call forwarding. */
  multiProduct?: boolean;
  /** Where "Open voicemail" goes, or null/absent when voicemail is off. */
  voicemailHref?: string | null;
}

/** The customer dashboard's actions (tenant and staff preview). */
export function customerQuickActions({
  numbersLabel,
  onNumbers,
  onActivity,
  showReports,
  multiProduct = false,
  voicemailHref = null,
}: CustomerQuickActionsArgs): QuickAction[] {
  const actions: QuickAction[] = [
    {
      key: 'numbers',
      label: numbersLabel,
      sub: 'New numbers, releases and open requests',
      icon: <Plus {...ICON} />,
      run: { onClick: onNumbers },
    },
    {
      key: 'activity',
      label: 'Open call activity',
      sub: 'Every call, by number and time range',
      icon: <PhoneIncoming {...ICON} />,
      run: { onClick: onActivity },
    },
  ];
  if (voicemailHref) {
    actions.push({
      key: 'voicemail',
      label: 'Open voicemail',
      sub: 'Messages and greetings',
      icon: <Voicemail {...ICON} />,
      run: { to: voicemailHref },
    });
  }
  if (showReports) {
    actions.push({
      key: 'reports',
      label: 'Download a report',
      sub: 'Spreadsheet or PDF for any period',
      icon: <BarChart3 {...ICON} />,
      run: { to: '/reporting' },
    });
  }
  actions.push({
    key: 'all',
    // /rcf is the call forwarding manager — name it that once other products share the account.
    label: multiProduct ? 'Manage call forwarding' : 'Manage all numbers',
    sub: 'The full list, with sorting and paging',
    icon: <ListChecks {...ICON} />,
    run: { to: '/rcf' },
  });
  return actions;
}

export interface AdminCustomerActionsArgs {
  customerId: number;
  customerName: string;
  onViewAsCustomer: () => void;
  onActivity: () => void;
  /** Visual Voicemail is on for this customer — adds the voicemail console. */
  voicemailOn?: boolean;
}

/** The admin's actions for ONE customer. */
export function adminCustomerActions({
  customerId,
  customerName,
  onViewAsCustomer,
  onActivity,
  voicemailOn = false,
}: AdminCustomerActionsArgs): QuickAction[] {
  const voicemail: QuickAction[] = voicemailOn
    ? [
        {
          key: 'voicemail',
          label: 'Voicemail console',
          sub: `${customerName}’s mailboxes and messages`,
          icon: <Voicemail {...ICON} />,
          run: { to: voicemailConsoleHref(customerId) },
        },
      ]
    : [];
  return [
    {
      key: 'view-as',
      label: 'View as this customer',
      sub: `See the app exactly as ${customerName} does`,
      icon: <Eye {...ICON} />,
      run: { onClick: onViewAsCustomer },
    },
    {
      key: 'console',
      label: 'Numbers console',
      sub: 'Every number, with admin fields, sorting and paging',
      icon: <ListChecks {...ICON} />,
      run: { to: rcfConsoleHref(customerId) },
    },
    ...voicemail,
    {
      key: 'activity',
      label: 'Open call activity',
      sub: 'Calls by number and time range',
      icon: <PhoneIncoming {...ICON} />,
      run: { onClick: onActivity },
    },
    {
      key: 'calls',
      label: 'Calls & Quality',
      sub: READS_CUSTOMER_PARAM.calls ? `Search ${customerName}’s calls` : `Search calls — pick ${customerName} in Customer`,
      icon: <Activity {...ICON} />,
      run: { to: callsHref(customerId) },
    },
    {
      key: 'reports',
      label: 'Reporting',
      sub: READS_CUSTOMER_PARAM.reporting ? `Reports for ${customerName}` : `Reports — pick ${customerName} in Customer`,
      icon: <BarChart3 {...ICON} />,
      run: { to: reportingHref(customerId) },
    },
    {
      key: 'trace',
      label: 'Troubleshooting',
      sub: 'Trace a call by number or Call-ID',
      icon: <Search {...ICON} />,
      run: { to: TROUBLESHOOTING_HREF },
    },
  ];
}

/** The admin's actions across every customer. */
export function adminPlatformActions({ onActivity }: { onActivity: () => void }): QuickAction[] {
  return [
    {
      key: 'console',
      label: 'Numbers console',
      sub: 'Every customer’s numbers in one list',
      icon: <ListChecks {...ICON} />,
      run: { to: rcfConsoleHref('all') },
    },
    {
      key: 'activity',
      label: 'Open call activity',
      sub: 'All customers, by time range',
      icon: <PhoneIncoming {...ICON} />,
      run: { onClick: onActivity },
    },
    {
      key: 'calls',
      label: 'Calls & Quality',
      sub: 'Search every call, with quality grades',
      icon: <Activity {...ICON} />,
      run: { to: callsHref(null) },
    },
    {
      key: 'reports',
      label: 'Reporting',
      sub: 'Spreadsheet or PDF reports, per customer',
      icon: <BarChart3 {...ICON} />,
      run: { to: reportingHref(null) },
    },
    {
      key: 'trace',
      label: 'Troubleshooting',
      sub: 'Trace a call by number or Call-ID',
      icon: <Search {...ICON} />,
      run: { to: TROUBLESHOOTING_HREF },
    },
  ];
}
