/**
 * AccountCards — the dashboard's account cards:
 *
 *   TeamCard          who on the account can sign in (tenant: /auth/team,
 *                     staff preview: /search/user/by-customer/{id})
 *   RequestsCard      numbers waiting on Granite (tenant: /numbers/my,
 *                     staff preview: /numbers/inventory?customer_id)
 *   QuickActionsCard  a list of actions — built by quickActions.tsx
 *                     (customer set, or the admin sets)
 *
 * Staff variants: the Team card is read-only (no My account link), and the
 * requests card can list every customer's requests with the customer's name
 * as a way into that customer's dashboard.
 *
 * Layout (docker/ui/CLAUDE.md §20): `follow` makes Team / Number requests a
 * kit follower — its height comes from the card beside it and its list
 * scrolls inside (every item listed); otherwise the first few items show
 * with "Show all N". QuickActionsCard can lay its actions in two columns
 * (`columns={2}`) when it sits in a wide slot.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { ArrowRight, Inbox, Users, Zap } from 'lucide-react';
import type { TeamMember, TeamRole } from '../../types/account';
import type { DidInventoryItem } from '../../types/didInventory';
import { fmt } from '../../utils/format';
import { Card, CardState } from './Card';
import { CustomerName } from './CallCards';
import type { QuickAction } from './quickActions';
import { fmtRelative, initials } from './accountData';
import { ShowMoreButton, useShowMore } from '../../components/layout/kit';

// ─── Team ────────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<TeamRole, string> = {
  admin: 'Administrator',
  user: 'Can edit',
  readonly: 'View only',
};

const TEAM_PREVIEW = 4;

export interface TeamCardProps {
  team: UseQueryResult<TeamMember[]>;
  nowMs: number;
  order: number;
  /** Header link (default My account), or null for none. */
  link?: { to: string; label: string } | null;
  /** Shown when nobody has access. */
  emptyText?: string;
  /** Height follows the card beside it; every member listed, scrolling inside. */
  follow?: boolean;
  /** Extra classes (grid placement). */
  className?: string;
}

const MY_ACCOUNT_LINK = { to: '/my-account', label: 'My account' };

export function TeamCard({
  team,
  nowMs,
  order,
  link = MY_ACCOUNT_LINK,
  emptyText = 'No one has access yet. Ask Granite support to add a teammate.',
  follow = false,
  className,
}: TeamCardProps) {
  // ALL hooks unconditionally at the top (React #310).
  const members = useMemo(() => {
    const list = team.data ?? [];
    // You first, then everyone else in the API's order.
    return [...list.filter((m) => m.is_self), ...list.filter((m) => !m.is_self)];
  }, [team.data]);
  const more = useShowMore(members, follow ? Number.POSITIVE_INFINITY : TEAM_PREVIEW);

  return (
    <Card
      id="ad-team"
      title="Team"
      icon={<Users size={15} strokeWidth={2.2} />}
      count={team.data ? team.data.length : null}
      action={link ? <Link to={link.to} className="ad-linkbtn">{link.label}</Link> : undefined}
      className={`ad-span-4${follow ? ' lk-follow' : ''}${className ? ` ${className}` : ''}`}
      order={order}
      footer={more.needed ? <ShowMoreButton {...more.buttonProps} noun="people" /> : undefined}
    >
      {team.data === undefined ? (
        team.isError ? (
          <CardState kind="error" onRetry={() => void team.refetch()}>The team couldn’t load.</CardState>
        ) : (
          <CardState kind="loading">Loading the team…</CardState>
        )
      ) : members.length === 0 ? (
        <p className="ad-quiet">{emptyText}</p>
      ) : (
        <ul className="ad-team" id={more.listId}>
          {more.visible.map((m) => {
            const seen = fmtRelative(m.last_login, nowMs);
            const inactive = m.status !== 'active';
            return (
              <li key={m.id} className={inactive ? 'ad-member ad-member-inactive' : 'ad-member'}>
                <span className="ad-avatar" aria-hidden="true">{initials(m.name, m.email)}</span>
                <span className="ad-member-id">
                  <span className="ad-member-name">
                    {m.name || m.email}
                    {m.is_self && <span className="ad-tag">You</span>}
                  </span>
                  <span className="ad-faint ad-ellipsis">
                    {ROLE_LABEL[m.role] ?? m.role} ·{' '}
                    {inactive ? `Account ${m.status}` : seen ? `Signed in ${seen}` : 'Never signed in'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ─── Number requests ─────────────────────────────────────────────────────────

const REQUEST_PREVIEW = 4;

export interface RequestsCardProps {
  dids: UseQueryResult<DidInventoryItem[]>;
  /** Footer button, or null for none. */
  action: { label: string; onClick: () => void } | null;
  order: number;
  sub?: string;
  emptyText?: string;
  /** Customer id → name: each request shows whose it is. */
  customerNames?: ReadonlyMap<number, string>;
  onPickCustomer?: (customerId: number) => void;
  /** Height follows the card beside it; every request listed, scrolling inside. */
  follow?: boolean;
  /** Extra classes (grid placement). */
  className?: string;
}

export function RequestsCard({
  dids,
  action,
  order,
  sub = 'Waiting on Granite',
  emptyText = 'Nothing waiting on Granite. Need more numbers? Request them any time.',
  customerNames,
  onPickCustomer,
  follow = false,
  className,
}: RequestsCardProps) {
  // ALL hooks unconditionally at the top (React #310).
  const open = useMemo(
    () => (dids.data ?? []).filter((d) => d.status === 'reserved' || d.status === 'release_requested'),
    [dids.data],
  );
  const more = useShowMore(open, follow ? Number.POSITIVE_INFINITY : REQUEST_PREVIEW);
  const pending = open.filter((d) => d.status === 'reserved').length;
  const releasing = open.length - pending;

  return (
    <Card
      id="ad-requests"
      title="Number requests"
      sub={sub}
      icon={<Inbox size={15} strokeWidth={2.2} />}
      count={dids.data ? open.length : null}
      className={`ad-span-4${follow ? ' lk-follow' : ''}${className ? ` ${className}` : ''}`}
      order={order}
      footer={
        action ? (
          <button type="button" className="ad-btn ad-btn-quiet ad-btn-block" onClick={action.onClick}>
            {action.label}
          </button>
        ) : undefined
      }
    >
      {dids.data === undefined ? (
        dids.isError ? (
          <CardState kind="error" onRetry={() => void dids.refetch()}>Requests couldn’t load.</CardState>
        ) : (
          <CardState kind="loading">Loading requests…</CardState>
        )
      ) : open.length === 0 ? (
        <p className="ad-quiet">{emptyText}</p>
      ) : (
        <>
          <div className="ad-req-counts">
            <span><strong>{pending}</strong> waiting for approval</span>
            <span><strong>{releasing}</strong> {releasing === 1 ? 'release' : 'releases'} pending</span>
          </div>
          <ul className="ad-req-list" id={more.listId}>
            {more.visible.map((d) => (
              <li key={d.id}>
                {customerNames ? (
                  <span className="ad-stack">
                    <span className="ad-num ad-num-sm">{fmt(d.did)}</span>
                    <CustomerName id={d.customer_id} names={customerNames} onPick={onPickCustomer} />
                  </span>
                ) : (
                  <span className="ad-num ad-num-sm">{fmt(d.did)}</span>
                )}
                <span className={`ad-req-state ad-req-${d.status === 'reserved' ? 'pending' : 'release'}`}>
                  <span className="ad-dot" aria-hidden="true" />
                  {d.status === 'reserved' ? 'Waiting for approval' : 'Release pending'}
                </span>
              </li>
            ))}
          </ul>
          {more.needed && <ShowMoreButton {...more.buttonProps} noun="requests" />}
        </>
      )}
    </Card>
  );
}

// ─── Quick actions ───────────────────────────────────────────────────────────

export interface QuickActionsCardProps {
  actions: readonly QuickAction[];
  order: number;
  title?: string;
  sub?: string;
  /** Two columns of actions (a wide slot). Default 1. */
  columns?: 1 | 2;
  /** Grid placement classes (default "ad-span-4"). */
  className?: string;
}

export function QuickActionsCard({
  actions,
  order,
  title = 'Quick actions',
  sub,
  columns = 1,
  className = 'ad-span-4',
}: QuickActionsCardProps) {
  return (
    <Card
      id="ad-actions"
      title={title}
      sub={sub}
      icon={<Zap size={15} strokeWidth={2.2} />}
      className={className}
      order={order}
    >
      <ul className={`ad-actions${columns === 2 ? ' ad-actions-2' : ''}`}>
        {actions.map((a) => {
          const inner = (
            <>
              <span className="ad-action-icon" aria-hidden="true">{a.icon}</span>
              <span className="ad-action-text">
                <span className="ad-action-label">{a.label}</span>
                <span className="ad-faint">{a.sub}</span>
              </span>
              <ArrowRight className="ad-action-arrow" size={15} aria-hidden="true" />
            </>
          );
          return (
            <li key={a.key}>
              {'to' in a.run ? (
                <Link to={a.run.to} className="ad-action">{inner}</Link>
              ) : (
                <button type="button" className="ad-action" onClick={a.run.onClick}>{inner}</button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
