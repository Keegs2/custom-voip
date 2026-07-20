/**
 * AccountHeader — the customer identity card (glass). Account-type accent is a
 * justified local override mirroring the Sidebar per-product hues.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { Badge } from '../../../../components/ui/Badge';
import type { Customer } from '../../../../types/customer';
import { accountAccent } from '../types';
import { addonPill, headerGlow, headerIcon, headerId, headerTitle } from '../styles';
import { IconUser } from './icons';

export function AccountHeader({ customer }: { customer: Customer }) {
  const accent = accountAccent(customer.account_type);
  const showUcaasPill =
    customer.account_type === 'api' ||
    customer.account_type === 'trunk' ||
    customer.account_type === 'hybrid';

  return (
    <GlassPanel accent={accent} radius={20} padding="28px 36px">
      <div style={headerGlow(accent)} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 22, flexWrap: 'wrap' }}>
        <div style={headerIcon(accent)}>
          <IconUser />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              marginBottom: 10,
            }}
          >
            <h1 style={headerTitle}>{customer.name}</h1>
            <Badge variant={customer.status}>
              {customer.status.charAt(0).toUpperCase() + customer.status.slice(1)}
            </Badge>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Badge variant={customer.account_type}>{customer.account_type.toUpperCase()}</Badge>
            <Badge variant={customer.traffic_grade}>{customer.traffic_grade}</Badge>
            {showUcaasPill && (
              <span style={addonPill(!!customer.ucaas_enabled, '#0ea5e9')}>
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: customer.ucaas_enabled ? '#0ea5e9' : '#475569',
                    flexShrink: 0,
                  }}
                />
                UCaaS {customer.ucaas_enabled ? 'Enabled' : 'Disabled'}
              </span>
            )}
            <span style={headerId}>#{customer.id}</span>
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}
