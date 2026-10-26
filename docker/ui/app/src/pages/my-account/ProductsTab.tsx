/**
 * My Account › Products — what is provisioned on the account, read-only
 * (docker/ui/CLAUDE.md §20):
 *
 *   ┌ Remote Call Forwarding (leader) ──────────┐ ┌ SIP Trunks ─────────────┐
 *   │ Number · Forwards to (+ ring · caller ID ·│ │ Granite HQ PBX   ACTIVE │
 *   │ channels) · Status — first 6, Show all N  │ ├ Voicemail ──────────────┤
 *   │ Manage call forwarding →                  │ │ 3 numbers, Open →       │
 *   └───────────────────────────────────────────┘ └─────────────────────────┘
 *
 * One product → one full-width card (8 rows before "Show all"). "Show all"
 * opens the rest inside a capped scroll with sticky heads. The forwarding
 * list is GET /rcf (at most 100 rows) — past that the card says so and
 * links to the full manager.
 */
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Boxes, Code2, PhoneForwarded, Server, Sparkles, Voicemail } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { BalancedGrid, ShowMoreButton, useShowMore } from '../../components/layout/kit';
import { listApiDids } from '../../api/apiDids';
import { API_CALLING_ENABLED } from '../../config/features';
import type { MyCustomer } from '../../types/account';
import { fmt } from '../../utils/format';
import { useAccountAllNumbers } from '../dashboard/accountData';
import { useAccountRcfList, useAccountTrunkList, type AccountScope } from './myAccountData';
import { plural } from './format';
import { EnabledPill, InlineEmpty, InlineLoading, Section } from './parts';

/* ─── Remote Call Forwarding ─────────────────────────────────────────────── */

function RcfProductSection({ scope, accountTotal, previewRows }: { scope: AccountScope; accountTotal: number; previewRows: number }) {
  // ALL hooks unconditionally at the top (React #310).
  const { data, isLoading, isError } = useAccountRcfList(scope);
  const rows = useMemo(() => data?.items ?? [], [data]);
  const more = useShowMore(rows, previewRows);

  const total = Math.max(accountTotal, rows.length);
  const partial = total > rows.length && rows.length > 0;

  return (
    <Section
      id="ma-rcf"
      title="Remote Call Forwarding"
      subtitle="Numbers that forward inbound calls to your destinations"
      icon={<PhoneForwarded size={16} strokeWidth={1.8} />}
      actions={<span className="dl-count">{plural(total, 'number')}</span>}
      flush={!isLoading && !isError && rows.length > 0}
      className="ma-card-rcf"
      footer={
        <div className="ma-foot-split">
          <span className="ma-cell-dim">
            {partial ? `Showing the first ${rows.length} of ${total.toLocaleString()}` : 'Read-only here'}
          </span>
          <Link to="/rcf" className="ma-foot-link">
            Manage call forwarding
            <ArrowRight size={13} strokeWidth={2.2} aria-hidden="true" />
          </Link>
        </div>
      }
    >
      {isLoading ? (
        <InlineLoading label="Loading call forwarding numbers…" />
      ) : isError ? (
        <InlineEmpty message="Unable to load RCF numbers." />
      ) : rows.length === 0 ? (
        <InlineEmpty message="No RCF numbers are provisioned yet. Contact support to add numbers." />
      ) : (
        <>
          <div className={`ma-tablewrap${more.expanded ? ' ma-tablewrap-cap' : ''}`}>
            <table className="ma-table" aria-label="Call forwarding numbers">
              <thead>
                <tr>
                  <th className="dl-th">Number</th>
                  <th className="dl-th">Forwards to</th>
                  <th className="dl-th ma-th-status">Status</th>
                </tr>
              </thead>
              <tbody id={more.listId}>
                {more.visible.map((r) => (
                  <tr key={r.id} className="dl-row">
                    <td>
                      <span className="ma-cellstack">
                        <span className="ma-num-strong">{fmt(r.did)}</span>
                        <span className={`ma-cell-dim${r.name ? '' : ' ma-italic'}`}>{r.name ?? 'No label'}</span>
                      </span>
                    </td>
                    <td>
                      <span className="ma-cellstack">
                        <span className="ma-num-dest">{fmt(r.forward_to)}</span>
                        <span className="ma-cell-dim">
                          Rings {r.ring_timeout}s · Caller ID {r.pass_caller_id ? 'passed through' : 'shows this number'} ·{' '}
                          {r.max_channels === 0 ? 'no call limit' : plural(r.max_channels, 'channel')}
                        </span>
                      </span>
                    </td>
                    <td className="ma-td-status">
                      <EnabledPill enabled={r.enabled} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more.needed && <ShowMoreButton {...more.buttonProps} variant="bar" noun="numbers" />}
        </>
      )}
    </Section>
  );
}

/* ─── Row list (trunks, voicemail, API) ──────────────────────────────────── */

function RowItem({ children }: { children: ReactNode }) {
  return <li className="ma-item">{children}</li>;
}

function TrunkProductSection({ scope, grow }: { scope: AccountScope; grow: boolean }) {
  const { data, isLoading, isError } = useAccountTrunkList(scope);
  const rows = data?.items ?? [];

  return (
    <Section
      id="ma-trunks"
      title="SIP Trunks"
      subtitle="IP-authenticated SIP trunks for your PBX"
      icon={<Server size={16} strokeWidth={1.8} />}
      actions={<span className="dl-count">{plural(rows.length, 'trunk')}</span>}
      className={grow ? 'lk-grow' : undefined}
    >
      {isLoading ? (
        <InlineLoading label="Loading SIP trunks…" />
      ) : isError ? (
        <InlineEmpty message="Unable to load SIP trunks." />
      ) : rows.length === 0 ? (
        <InlineEmpty message="No SIP trunks are provisioned yet. Contact support to add a trunk." />
      ) : (
        <ul className="ma-items">
          {rows.map((t) => (
            <RowItem key={t.id}>
              <span className="ma-item-main">
                <span className="ma-item-title">{t.trunk_name}</span>
                {t.package_name && <span className="ma-cell-dim">{t.package_name}</span>}
              </span>
              <span className="ma-item-meta">
                <span>
                  <span className="ma-cell-dim">Auth</span> {t.auth_type}
                </span>
                <span>
                  <span className="ma-cell-dim">IPs</span> {t.ip_count ?? 0}
                </span>
                <span>
                  <span className="ma-cell-dim">DIDs</span> {t.did_count ?? 0}
                </span>
                <span>
                  <span className="ma-cell-dim">Channels</span> {t.max_channels}
                </span>
                <span>
                  <span className="ma-cell-dim">CPS</span> {t.cps_limit}
                </span>
              </span>
              <EnabledPill enabled={t.enabled} />
            </RowItem>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** The account's voicemail numbers (GET /reports/my-numbers, voicemail rows). */
function VoicemailProductSection({ scope, customerId, grow }: { scope: AccountScope; customerId: number; grow: boolean }) {
  // ALL hooks unconditionally at the top (React #310).
  // Same query + cache key as the dashboard's numbers card.
  const { data, isLoading, isError } = useAccountAllNumbers({ customerId, staff: scope.kind === 'staff' });
  const rows = useMemo(() => (data?.numbers ?? []).filter((n) => n.product === 'voicemail'), [data]);
  const more = useShowMore(rows, 5);

  return (
    <Section
      id="ma-voicemail"
      title="Voicemail"
      subtitle="Numbers that take messages for you"
      icon={<Voicemail size={16} strokeWidth={1.8} />}
      actions={<span className="dl-count">{plural(rows.length, 'number')}</span>}
      className={grow ? 'lk-grow' : undefined}
    >
      {isLoading ? (
        <InlineLoading label="Loading voicemail numbers…" />
      ) : isError ? (
        <InlineEmpty message="Unable to load voicemail numbers." />
      ) : rows.length === 0 ? (
        <InlineEmpty message="No voicemail numbers yet." />
      ) : (
        <>
          <ul className="ma-items" id={more.listId}>
            {more.visible.map((n) => (
              <RowItem key={n.number}>
                <span className="ma-item-main">
                  <span className="ma-num-strong">{fmt(n.number)}</span>
                  <span className={`ma-cell-dim${n.name ? '' : ' ma-italic'}`}>{n.name ?? 'No label'}</span>
                </span>
                <Link to="/voicemail" className="ma-foot-link">
                  Open voicemail
                  <ArrowRight size={13} strokeWidth={2.2} aria-hidden="true" />
                </Link>
                {n.enabled !== undefined && <EnabledPill enabled={n.enabled} on="On" off="Off" />}
              </RowItem>
            ))}
          </ul>
          {more.needed && <ShowMoreButton {...more.buttonProps} noun="numbers" className="ma-more-inline" />}
        </>
      )}
    </Section>
  );
}

/** API DIDs — retired; renders (and fetches) only while API_CALLING_ENABLED. Tenant scope only. */
function ApiDidProductSection({ grow }: { grow: boolean }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['my-account-api-dids'],
    queryFn: () => listApiDids(),
  });
  const rows = data?.items ?? [];

  return (
    <Section
      id="ma-api"
      title="API DIDs"
      subtitle="Programmable voice numbers routed to your webhooks"
      icon={<Code2 size={16} strokeWidth={1.8} />}
      actions={<span className="dl-count">{plural(rows.length, 'DID')}</span>}
      className={grow ? 'lk-grow' : undefined}
    >
      {isLoading ? (
        <InlineLoading label="Loading API DIDs…" />
      ) : isError ? (
        <InlineEmpty message="Unable to load API DIDs." />
      ) : rows.length === 0 ? (
        <InlineEmpty message="No API DIDs are provisioned yet. Contact support to add a number." />
      ) : (
        <ul className="ma-items">
          {rows.map((d) => (
            <RowItem key={d.id}>
              <span className="ma-item-main">
                <span className="ma-num-strong">{fmt(d.did)}</span>
                <span className="ma-num-dest ma-ellipsis" title={d.voice_url}>
                  {d.voice_url}
                </span>
              </span>
              <EnabledPill enabled={d.enabled} />
            </RowItem>
          ))}
        </ul>
      )}
    </Section>
  );
}

function UcaasProductSection({ grow }: { grow: boolean }) {
  return (
    <Section
      id="ma-ucaas"
      title="UCaaS"
      subtitle="Unified communications features are enabled for your account"
      icon={<Sparkles size={16} strokeWidth={1.8} />}
      actions={<span className="dl-tag">Enabled</span>}
      className={grow ? 'lk-grow' : undefined}
    >
      <div className="dl-note ma-note">
        <Sparkles size={17} aria-hidden="true" />
        <span>
          Extensions and voicemail are available on your account. Your administrator can configure UCaaS features —
          contact support for details.
        </span>
      </div>
    </Section>
  );
}

/* ─── Tab ────────────────────────────────────────────────────────────────── */

export function ProductsTab({ customer, scope }: { customer: MyCustomer; scope: AccountScope }) {
  const type = customer.account_type;
  const showRcf = type === 'rcf' || type === 'hybrid';
  const showTrunk = type === 'trunk' || type === 'hybrid';
  // Voicemail is switched on per account, not per type: shown whenever the
  // account has mailbox numbers (only an API with `counts.numbers` says so).
  const showVoicemail = (customer.counts.numbers?.by_product.voicemail ?? 0) > 0;
  // API Calling is retired: its section (and the /api-dids call it makes) only
  // renders while API_CALLING_ENABLED is on, for the tenant's own account.
  // Hybrid now means RCF + SIP Trunking, so hybrid never shows it.
  const showApi = API_CALLING_ENABLED && type === 'api' && scope.kind === 'self';
  // RCF customers must NEVER see UCaaS — gate strictly on the flag and never for rcf.
  const showUcaas = customer.ucaas_enabled === true && type !== 'rcf';

  // The other products, in order; the last card of the side column absorbs
  // the row's spare height (`grow`).
  const sideCards: ((grow: boolean) => ReactNode)[] = [];
  if (showTrunk) sideCards.push((grow) => <TrunkProductSection key="trunk" scope={scope} grow={grow} />);
  if (showVoicemail) {
    sideCards.push((grow) => (
      <VoicemailProductSection key="vm" scope={scope} customerId={customer.id} grow={grow} />
    ));
  }
  if (showApi) sideCards.push((grow) => <ApiDidProductSection key="api" grow={grow} />);
  if (showUcaas) sideCards.push((grow) => <UcaasProductSection key="ucaas" grow={grow} />);
  const side = sideCards.map((render, i) => render(i === sideCards.length - 1));

  if (!showRcf && side.length === 0) {
    return (
      <Section id="ma-products" title="Products" subtitle="No products configured" icon={<Boxes size={16} strokeWidth={1.8} />}>
        <InlineEmpty message="No products are configured for your account. Contact support to get started." />
      </Section>
    );
  }

  // One product → full width; call forwarding beside the others → a balanced row.
  if (!showRcf) return <div className="ma-stack">{side}</div>;
  const rcf = (
    <RcfProductSection scope={scope} accountTotal={customer.counts.rcf} previewRows={side.length > 0 ? 6 : 8} />
  );
  if (side.length === 0) return rcf;
  return (
    <BalancedGrid columns="minmax(0, 1.55fr) minmax(0, 1fr)" stackBelow="lg" className="ma-products-row" label="Products">
      {rcf}
      <div className="lk-col">{side}</div>
    </BalancedGrid>
  );
}
