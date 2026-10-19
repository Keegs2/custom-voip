/**
 * AccountCards — the dashboard's account cards:
 *
 *   TeamCard          who on the account can sign in (tenant: /auth/team,
 *                     staff preview: /search/user/by-customer/{id})
 *   RequestsCard      numbers waiting on Granite (tenant: /numbers/my,
 *                     staff preview: /numbers/inventory?customer_id)
 *   QuickActionsCard  request / manage numbers, open call activity, reports,
 *                     the full numbers manager
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { ArrowRight, BarChart3, Inbox, ListChecks, PhoneIncoming, Plus, Users, Zap } from 'lucide-react';
import type { TeamMember, TeamRole } from '../../types/account';
import type { DidInventoryItem } from '../../types/didInventory';
import { fmt } from '../../utils/format';
import { Card, CardState } from './Card';
import { fmtRelative, initials } from './accountData';

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
}

export function TeamCard({ team, nowMs, order }: TeamCardProps) {
  // ALL hooks unconditionally at the top (React #310).
  const [showAll, setShowAll] = useState(false);
  const members = useMemo(() => {
    const list = team.data ?? [];
    // You first, then everyone else in the API's order.
    return [...list.filter((m) => m.is_self), ...list.filter((m) => !m.is_self)];
  }, [team.data]);
  const shown = showAll ? members : members.slice(0, TEAM_PREVIEW);

  return (
    <Card
      id="ad-team"
      title="Team"
      icon={<Users size={15} strokeWidth={2.2} />}
      count={team.data ? team.data.length : null}
      action={<Link to="/my-account" className="ad-linkbtn">My account</Link>}
      className="ad-span-4"
      order={order}
      footer={
        members.length > TEAM_PREVIEW ? (
          <button type="button" className="ad-linkbtn" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
            {showAll ? 'Show fewer' : `Show all ${members.length}`}
          </button>
        ) : undefined
      }
    >
      {team.data === undefined ? (
        team.isError ? (
          <CardState kind="error" onRetry={() => void team.refetch()}>The team couldn’t load.</CardState>
        ) : (
          <CardState kind="loading">Loading the team…</CardState>
        )
      ) : members.length === 0 ? (
        <p className="ad-quiet">No one has access yet. Ask Granite support to add a teammate.</p>
      ) : (
        <ul className="ad-team">
          {shown.map((m) => {
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
  actionLabel: string;
  onOpen: () => void;
  order: number;
}

export function RequestsCard({ dids, actionLabel, onOpen, order }: RequestsCardProps) {
  const open = useMemo(
    () => (dids.data ?? []).filter((d) => d.status === 'reserved' || d.status === 'release_requested'),
    [dids.data],
  );
  const pending = open.filter((d) => d.status === 'reserved').length;
  const releasing = open.length - pending;

  return (
    <Card
      id="ad-requests"
      title="Number requests"
      sub="Waiting on Granite"
      icon={<Inbox size={15} strokeWidth={2.2} />}
      count={dids.data ? open.length : null}
      className="ad-span-4"
      order={order}
      footer={
        <button type="button" className="ad-btn ad-btn-quiet ad-btn-block" onClick={onOpen}>
          {actionLabel}
        </button>
      }
    >
      {dids.data === undefined ? (
        dids.isError ? (
          <CardState kind="error" onRetry={() => void dids.refetch()}>Requests couldn’t load.</CardState>
        ) : (
          <CardState kind="loading">Loading requests…</CardState>
        )
      ) : open.length === 0 ? (
        <p className="ad-quiet">Nothing waiting on Granite. Need more numbers? Request them any time.</p>
      ) : (
        <>
          <div className="ad-req-counts">
            <span><strong>{pending}</strong> waiting for approval</span>
            <span><strong>{releasing}</strong> {releasing === 1 ? 'release' : 'releases'} pending</span>
          </div>
          <ul className="ad-req-list">
            {open.slice(0, REQUEST_PREVIEW).map((d) => (
              <li key={d.id}>
                <span className="ad-num ad-num-sm">{fmt(d.did)}</span>
                <span className={`ad-req-state ad-req-${d.status === 'reserved' ? 'pending' : 'release'}`}>
                  <span className="ad-dot" aria-hidden="true" />
                  {d.status === 'reserved' ? 'Waiting for approval' : 'Release pending'}
                </span>
              </li>
            ))}
          </ul>
          {open.length > REQUEST_PREVIEW && <p className="ad-quiet">And {open.length - REQUEST_PREVIEW} more.</p>}
        </>
      )}
    </Card>
  );
}

// ─── Quick actions ───────────────────────────────────────────────────────────

interface ActionDef {
  key: string;
  label: string;
  sub: string;
  icon: ReactNode;
  run: { to: string } | { onClick: () => void };
}

export interface QuickActionsCardProps {
  numbersLabel: string;
  onNumbers: () => void;
  onActivity: () => void;
  showReports: boolean;
  order: number;
}

export function QuickActionsCard({ numbersLabel, onNumbers, onActivity, showReports, order }: QuickActionsCardProps) {
  const actions: ActionDef[] = [
    {
      key: 'numbers',
      label: numbersLabel,
      sub: 'New numbers, releases and open requests',
      icon: <Plus size={16} strokeWidth={2.2} />,
      run: { onClick: onNumbers },
    },
    {
      key: 'activity',
      label: 'Open call activity',
      sub: 'Every call, by number and time range',
      icon: <PhoneIncoming size={16} strokeWidth={2.2} />,
      run: { onClick: onActivity },
    },
    ...(showReports
      ? [{
          key: 'reports',
          label: 'Download a report',
          sub: 'Spreadsheet or PDF for any period',
          icon: <BarChart3 size={16} strokeWidth={2.2} />,
          run: { to: '/reporting' },
        }]
      : []),
    {
      key: 'all',
      label: 'Manage all numbers',
      sub: 'The full list, with sorting and paging',
      icon: <ListChecks size={16} strokeWidth={2.2} />,
      run: { to: '/rcf' },
    },
  ];

  return (
    <Card
      id="ad-actions"
      title="Quick actions"
      icon={<Zap size={15} strokeWidth={2.2} />}
      className="ad-span-4"
      order={order}
    >
      <ul className="ad-actions">
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
