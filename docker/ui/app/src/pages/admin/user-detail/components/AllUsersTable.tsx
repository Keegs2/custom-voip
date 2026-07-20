/**
 * AllUsersTable — the clickable, filterable user list inside the lookup panel.
 * Filtering is a pure derived computation; clicking a row opens the 360 view.
 */

import { useMemo, useState } from 'react';
import { GLASS } from '../../../../components/glass/glass';
import { Badge } from '../../../../components/ui/Badge';
import type { User } from '../../../../types/auth';
import { fmtRelativeTime, filterUsers, getAvatarColor } from '../helpers';
import { ROLE_CONFIG } from '../constants';
import { tableTd, tableTh, tableHeadRow, statusPill } from '../styles';

interface AllUsersTableProps {
  users: User[];
  searchTerm: string;
  onSelectUser: (userId: number) => void;
}

export function AllUsersTable({ users, searchTerm, onSelectUser }: AllUsersTableProps) {
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const filtered = useMemo(() => filterUsers(users, searchTerm), [users, searchTerm]);
  const term = searchTerm.trim();

  if (filtered.length === 0) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center', color: GLASS.textMuted, fontSize: '0.85rem', fontStyle: 'italic' }}>
        {term.length > 0 ? `No users match "${searchTerm}"` : 'No users found.'}
      </div>
    );
  }

  return (
    <div style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden' }}>
      {/* Row count label */}
      <div style={{ padding: '9px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '0.68rem', color: GLASS.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
          {filtered.length} user{filtered.length !== 1 ? 's' : ''}
          {term.length > 0 && users.length !== filtered.length && (
            <span style={{ color: GLASS.textFaint, fontWeight: 400, marginLeft: 6 }}>of {users.length} total</span>
          )}
        </span>
        <span style={{ fontSize: '0.68rem', color: GLASS.textFaint }}>Click a row to open 360 view</span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr style={tableHeadRow}>
              {['Name', 'Email', 'Role', 'Customer', 'Status', 'Last Login'].map((col) => <th key={col} style={tableTh}>{col}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => {
              const avatarColor = getAvatarColor(u.name);
              const isHovered = hoveredRow === u.id;
              const roleCfg = ROLE_CONFIG[u.role] ?? ROLE_CONFIG.user;
              return (
                <tr
                  key={u.id}
                  onClick={() => onSelectUser(u.id)}
                  onMouseEnter={() => setHoveredRow(u.id)}
                  onMouseLeave={() => setHoveredRow(null)}
                  style={{ background: isHovered ? 'rgba(255,255,255,0.04)' : 'transparent', cursor: 'pointer', transition: 'background 0.1s' }}
                >
                  <td style={{ ...tableTd, whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          background: `${avatarColor}22`,
                          border: `1px solid ${avatarColor}44`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          color: avatarColor,
                          flexShrink: 0,
                        }}
                      >
                        {u.name.charAt(0).toUpperCase()}
                      </div>
                      <span style={{ fontSize: '0.82rem', color: GLASS.text, fontWeight: 500 }}>{u.name}</span>
                    </div>
                  </td>
                  <td style={{ ...tableTd, color: GLASS.textMuted, maxWidth: 220 }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.email}>{u.email}</span>
                  </td>
                  <td style={{ ...tableTd, whiteSpace: 'nowrap' }}>
                    <span style={statusPill(roleCfg.color)}>{roleCfg.label}</span>
                  </td>
                  <td style={{ ...tableTd, color: GLASS.textMuted, maxWidth: 180 }}>
                    {u.customer_name ? (
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.customer_name}>{u.customer_name}</span>
                    ) : (
                      <span style={{ color: GLASS.textFaint, fontStyle: 'italic' }}>—</span>
                    )}
                  </td>
                  <td style={{ ...tableTd, whiteSpace: 'nowrap' }}>
                    <Badge variant={u.status === 'active' ? 'active' : 'disabled'}>{u.status}</Badge>
                  </td>
                  <td style={{ ...tableTd, color: GLASS.textMuted, whiteSpace: 'nowrap' }}>{fmtRelativeTime(u.last_login)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
