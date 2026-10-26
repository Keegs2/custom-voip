/**
 * My Account › Users & Access — who can sign in (docker/ui/CLAUDE.md §20):
 * the active users (first 8, then "Show all N" inside a capped scroll with
 * sticky heads), and everyone who can't sign in behind an "Inactive users"
 * row with its count — rarely needed, never in the way. Read-only.
 */
import { Users } from 'lucide-react';
import type { TeamMember } from '../../types/account';
import { Disclosure, ShowMoreButton, useShowMore } from '../../components/layout/kit';
import { useAccountTeamList, type AccountScope } from './myAccountData';
import { ROLE_LABEL, fmtDateTime, plural } from './format';
import { InlineEmpty, InlineLoading, Section, StatusChip } from './parts';

const PREVIEW_ROWS = 8;

function MemberCell({ m }: { m: TeamMember }) {
  return (
    <div className="ma-member">
      <span className="dl-avatar dl-avatar-sm" aria-hidden="true">
        {(m.name || m.email).charAt(0)}
      </span>
      <span className="ma-member-name">
        {m.name || '—'}
        {m.is_self && <span className="dl-tag ma-you">You</span>}
      </span>
    </div>
  );
}

function RoleTag({ role }: { role: TeamMember['role'] }) {
  return <span className={role === 'admin' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>{ROLE_LABEL[role]}</span>;
}

interface MemberTableProps {
  members: readonly TeamMember[];
  /** Show the Status column (the inactive list; active users all read "Active"). */
  showStatus: boolean;
  bodyId?: string;
  capped?: boolean;
  label: string;
}

function MemberTable({ members, showStatus, bodyId, capped, label }: MemberTableProps) {
  return (
    <div className={`ma-tablewrap${capped ? ' ma-tablewrap-cap' : ''}`}>
      <table className="ma-table" aria-label={label}>
        <thead>
          <tr>
            <th className="dl-th">User</th>
            <th className="dl-th">Email</th>
            <th className="dl-th">Role</th>
            {showStatus && <th className="dl-th">Status</th>}
            <th className="dl-th">Last login</th>
          </tr>
        </thead>
        <tbody id={bodyId}>
          {members.map((m) => (
            <tr key={m.id} className="dl-row">
              <td>
                <MemberCell m={m} />
              </td>
              <td className="ma-mono ma-cell-soft">{m.email}</td>
              <td>
                <RoleTag role={m.role} />
              </td>
              {showStatus && (
                <td>
                  <StatusChip status={m.status} />
                </td>
              )}
              <td className="ma-cell-dim ma-nowrap">{fmtDateTime(m.last_login)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TeamTab({ scope }: { scope: AccountScope }) {
  // ALL hooks unconditionally at the top (React #310).
  const { data, isLoading, isError } = useAccountTeamList(scope);
  const members: readonly TeamMember[] = data ?? [];
  const active = members.filter((m) => m.status === 'active');
  const inactive = members.filter((m) => m.status !== 'active');
  const more = useShowMore(active, PREVIEW_ROWS);

  const ready = !isLoading && !isError && members.length > 0;
  const admins = active.filter((m) => m.role === 'admin').length;

  return (
    <Section
      id="ma-team"
      title="Users & Access"
      subtitle="User accounts associated with your organization"
      icon={<Users size={16} strokeWidth={1.8} />}
      actions={
        ready ? (
          <span className="ma-head-note">
            {plural(active.length, 'active user')}
            {admins > 0 ? ` · ${plural(admins, 'administrator')}` : ''}
          </span>
        ) : undefined
      }
      flush={ready}
      className="ma-card-team"
    >
      {isLoading ? (
        <InlineLoading label="Loading team members…" />
      ) : isError ? (
        <InlineEmpty message="Unable to load team members right now." />
      ) : members.length === 0 ? (
        <InlineEmpty message="No user accounts are associated with this account yet." />
      ) : (
        <>
          {active.length > 0 ? (
            <MemberTable
              members={more.visible}
              showStatus={false}
              bodyId={more.listId}
              capped={more.expanded}
              label="Active users"
            />
          ) : (
            <InlineEmpty message="No one on this account can sign in right now." />
          )}
          {more.needed && <ShowMoreButton {...more.buttonProps} variant="bar" noun="users" />}

          {inactive.length > 0 && (
            <Disclosure
              variant="row"
              title="Inactive users"
              count={inactive.length}
              summary="Accounts that can’t sign in"
              persistKey="account:inactive-users"
              className="ma-inactive"
              contentClassName="ma-inactive-content"
            >
              <MemberTable members={inactive} showStatus label="Inactive users" />
            </Disclosure>
          )}
        </>
      )}
    </Section>
  );
}
