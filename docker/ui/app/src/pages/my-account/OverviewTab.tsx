/**
 * My Account › Overview — ONE balanced row (docker/ui/CLAUDE.md §20):
 *
 *   ┌ Account ───────────────────────────┐ ┌ Estimated monthly bill ─────────┐
 *   │ [G] Granite Telephony  HYBRID ●ACT │ │ Call forwarding lines    $50.00 │
 *   │ Type · Member since · Account ID   │ │ Voicemail mailboxes       $8.00 │
 *   │ Products on this account           │ │ SIP trunk — HQ PBX      $154.50 │
 *   │  Call forwarding   20 numbers  →   │ │ ▸ Line details                  │
 *   │  SIP trunk          4 numbers      │ │ ESTIMATED MONTHLY TOTAL $212.50 │
 *   │  Voicemail          3 numbers  →   │ │ disclaimer                      │
 *   └────────────────────────────────────┘ └─────────────────────────────────┘
 *
 * The account card carries what used to be a separate "Your numbers" tile
 * row (now one line per product, with a link to its page), so it stands as
 * tall as the bill beside it. The bill's per-line breakdown (trunk call
 * paths, trunk numbers) folds behind "Line details"; the total and the
 * server's disclaimer stay visible, pinned to the card's foot.
 */
import { Link } from 'react-router-dom';
import { ArrowRight, Boxes, IdCard, PhoneForwarded, Receipt, Server, Sparkles, Voicemail } from 'lucide-react';
import { BalancedGrid, Disclosure } from '../../components/layout/kit';
import { API_CALLING_ENABLED } from '../../config/features';
import { productLabel, productMix, type ProductCount } from '../../config/products';
import type { BillingLineItem, MyCustomer } from '../../types/account';
import { fmtMoney } from '../../utils/format';
import { useAccountBilling, type AccountScope } from './myAccountData';
import { accountTypeLabel, fmtDate, plural } from './format';
import { InlineEmpty, InlineLoading, Section, StatusChip } from './parts';

/* ─── Products on the account ────────────────────────────────────────────── */

interface ProductLine {
  product: string;
  label: string;
  detail: string;
  /** Where the product is managed in this app, if anywhere. */
  href?: string;
  linkLabel?: string;
  icon: typeof PhoneForwarded;
}

/**
 * One line per product with numbers (catalog order, call forwarding always
 * listed), from `counts.numbers.by_product` — or, on an API that predates
 * it, the legacy per-product counts. SIP trunks ride on the SIP trunk line.
 */
function productLines(customer: MyCustomer): ProductLine[] {
  const byProduct = customer.counts.numbers?.by_product;
  const mix: ProductCount[] = byProduct
    ? productMix(byProduct)
    : [{ product: 'rcf', count: customer.counts.rcf }];
  if (!mix.some((m) => m.product === 'rcf')) mix.unshift({ product: 'rcf', count: 0 });
  const trunks = customer.counts.trunks;
  if (trunks > 0 && !mix.some((m) => m.product === 'trunk')) mix.push({ product: 'trunk', count: 0 });

  const lines: ProductLine[] = mix.map((m) => {
    const numbers = plural(m.count, 'number');
    switch (m.product) {
      case 'rcf':
        return {
          product: m.product,
          label: productLabel(m.product),
          detail: numbers,
          href: '/rcf',
          linkLabel: 'Manage',
          icon: PhoneForwarded,
        };
      case 'trunk':
        return {
          product: m.product,
          label: 'SIP trunking',
          detail: trunks > 0 ? `${plural(trunks, 'trunk')} · ${numbers}` : numbers,
          icon: Server,
        };
      case 'voicemail':
        return {
          product: m.product,
          label: productLabel(m.product),
          detail: numbers,
          href: '/voicemail',
          linkLabel: 'Open',
          icon: Voicemail,
        };
      default:
        return { product: m.product, label: productLabel(m.product), detail: numbers, icon: Boxes };
    }
  });
  if (API_CALLING_ENABLED && customer.counts.api_dids > 0) {
    lines.push({ product: 'api', label: 'API Calling', detail: plural(customer.counts.api_dids, 'number'), icon: Boxes });
  }
  return lines;
}

function AccountCard({ customer }: { customer: MyCustomer }) {
  const lines = productLines(customer);
  return (
    <Section
      id="ma-account"
      title="Account"
      subtitle="Your organization on the platform"
      icon={<IdCard size={16} strokeWidth={1.8} />}
      className="ma-card-account"
    >
      <div className="ma-identity">
        <div className="dl-avatar" aria-hidden="true">
          {customer.name.charAt(0) || '?'}
        </div>
        <div className="ma-identity-text">
          <div className="ma-identity-name">{customer.name}</div>
          <div className="ma-identity-tags">
            <span className="dl-tag">{customer.account_type}</span>
            <StatusChip status={customer.status} />
          </div>
        </div>
      </div>

      <dl className="ma-facts ma-facts-3">
        <div>
          <dt>Account type</dt>
          <dd>{accountTypeLabel(customer.account_type)}</dd>
        </div>
        <div>
          <dt>Member since</dt>
          <dd>{fmtDate(customer.created_at)}</dd>
        </div>
        <div>
          <dt>Account ID</dt>
          <dd className="ma-mono">#{customer.id}</dd>
        </div>
      </dl>

      <div className="ma-products">
        <h3 className="ma-subhead">Products on this account</h3>
        <ul className="ma-product-list">
          {lines.map((l) => {
            const Icon = l.icon;
            return (
              <li key={l.product} className="ma-product">
                <span className="ma-product-icon" aria-hidden="true">
                  <Icon size={14} strokeWidth={1.9} />
                </span>
                <span className="ma-product-label">{l.label}</span>
                <span className="ma-product-detail">{l.detail}</span>
                {l.href ? (
                  <Link to={l.href} className="ma-product-link" aria-label={`${l.linkLabel} ${l.label.toLowerCase()}`}>
                    {l.linkLabel}
                    <ArrowRight size={13} strokeWidth={2.2} aria-hidden="true" />
                  </Link>
                ) : (
                  <span className="ma-product-link-spacer" aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ul>
        {customer.ucaas_enabled && (
          <p className="ma-ucaas">
            <Sparkles size={14} aria-hidden="true" />
            UCaaS features enabled
          </p>
        )}
      </div>
    </Section>
  );
}

/* ─── Estimated monthly bill ─────────────────────────────────────────────── */

function hasBreakdown(item: BillingLineItem): item is Extract<BillingLineItem, { components: unknown }> {
  return (item.product === 'trunk' || item.product === 'api') && item.components.length > 0;
}

/** The one line under a bill line's label: "20 lines × $2.50" / "23 call paths · 4 trunk numbers". */
function lineSummary(item: BillingLineItem): string | null {
  if (item.product === 'rcf' || item.product === 'voicemail') {
    return `${item.qty.toLocaleString()} ${item.unit}${item.qty === 1 ? '' : 's'} × ${fmtMoney(item.unit_price)}`;
  }
  return item.components.length > 0 ? item.components.map((c) => c.label).join(' · ') : null;
}

/**
 * READ-ONLY "Estimated monthly bill". The platform does not invoice — CDRs
 * are rated externally (Equinox); this is the server-computed estimate, its
 * lines, a bold total and the server-authored disclaimer (shown verbatim).
 */
function BillCard({ scope }: { scope: AccountScope }) {
  const { data, isLoading, isError } = useAccountBilling(scope);
  const detailed = data?.line_items.filter(hasBreakdown) ?? [];

  return (
    <Section
      id="ma-bill"
      title="Estimated Monthly Bill"
      subtitle="A read-only estimate — actual charges are billed separately"
      icon={<Receipt size={16} strokeWidth={1.8} />}
      className="ma-card-bill"
    >
      {isLoading ? (
        <InlineLoading label="Loading your estimate…" />
      ) : isError ? (
        <InlineEmpty message="Unable to load your estimated bill right now." />
      ) : !data || data.line_items.length === 0 ? (
        <InlineEmpty message="No billable products are provisioned yet. Contact support to get started." />
      ) : (
        <div className="ma-bill">
          <ul className="ma-bill-lines">
            {data.line_items.map((item, i) => {
              const summary = lineSummary(item);
              return (
                <li key={`${item.product}-${item.label}-${i}`} className="ma-bill-line">
                  <div className="ma-bill-line-text">
                    <span className="ma-bill-line-label">{item.label}</span>
                    {summary && <span className="ma-bill-line-sub">{summary}</span>}
                  </div>
                  <span className="ma-bill-amount">{fmtMoney(item.subtotal)}</span>
                </li>
              );
            })}
          </ul>

          {detailed.length > 0 && (
            <Disclosure
              variant="bare"
              title="Line details"
              summary={null}
              persistKey="account:bill-details"
              className="ma-bill-details"
            >
              <div className="ma-bill-breakdown">
                {detailed.map((item, i) => (
                  <div key={`${item.label}-${i}`} className="ma-bill-breakdown-group">
                    <div className="ma-bill-breakdown-title">{item.label}</div>
                    {item.components.map((c, j) => (
                      <div key={`${c.label}-${j}`} className="ma-bill-breakdown-row">
                        <span>{c.label}</span>
                        <span className="ma-num">{fmtMoney(c.amount)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Disclosure>
          )}

          <div className="ma-bill-foot">
            <div className="ma-bill-total">
              <span className="ma-bill-total-label">Estimated Monthly Total</span>
              <span className="ma-bill-total-value">{fmtMoney(data.total_monthly_estimate)}</span>
            </div>
            {/* Server-authored disclaimer — shown verbatim, never collapsed. */}
            {data.disclaimer && <p className="ma-bill-disclaimer">{data.disclaimer}</p>}
          </div>
        </div>
      )}
    </Section>
  );
}

/* ─── Tab ────────────────────────────────────────────────────────────────── */

export function OverviewTab({ customer, scope }: { customer: MyCustomer; scope: AccountScope }) {
  return (
    <BalancedGrid columns="minmax(0, 1fr) minmax(0, 1fr)" stackBelow="md" className="ma-overview" label="Account overview">
      <AccountCard customer={customer} />
      <BillCard scope={scope} />
    </BalancedGrid>
  );
}
