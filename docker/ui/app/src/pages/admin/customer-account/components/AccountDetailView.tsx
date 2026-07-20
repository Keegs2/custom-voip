/**
 * AccountDetailView — the read view of the customer 360. Composes overview
 * tiles, the CPS-tier line, the per-product service sections (each wrapped in a
 * glass SectionPanel with its product accent), usage analytics, and the action
 * bar. The heavy service sections are reused as-is from their own modules.
 */

import { GLASS } from '../../../../components/glass/glass';
import { Spinner } from '../../../../components/ui/Spinner';
import type { Customer } from '../../../../types/customer';
import { CustomerRcfSection } from './CustomerRcfSection';
import { CustomerApiSection } from './CustomerApiSection';
import { CustomerTrunkSection } from './CustomerTrunkSection';
import { CustomerUcaasSection } from './CustomerUcaasSection';
import { useCustomerTierLine } from '../hooks';
import { accountAccent } from '../types';
import { inlineLoading, tierLineLabel, tierLineRow } from '../styles';
import { SectionPanel } from './SectionPanel';
import { AccountOverviewTiles } from './StatTiles';
import { UsageSection } from './UsageSection';
import { AccountActions } from './AccountActions';

interface AccountDetailViewProps {
  customer: Customer;
  onEdit: () => void;
  onDelete: () => void;
}

export function AccountDetailView({ customer, onEdit, onDelete }: AccountDetailViewProps) {
  const { data: tierData, isLoading: tierLoading } = useCustomerTierLine(customer.id);
  const tier = tierData?.tier;

  const headerAccent = accountAccent(customer.account_type);

  const showRcf = customer.account_type === 'rcf' || customer.account_type === 'hybrid';
  const showApi = customer.account_type === 'api' || customer.account_type === 'hybrid';
  const showTrunk = customer.account_type === 'trunk' || customer.account_type === 'hybrid';
  const showUcaas = customer.account_type === 'ucaas' || customer.ucaas_enabled === true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <AccountOverviewTiles customer={customer} />

      {/* CPS Tier line */}
      {tierLoading && (
        <div style={inlineLoading}>
          <Spinner size="xs" /> Loading tier…
        </div>
      )}
      {!tierLoading && tier && (
        <div style={tierLineRow}>
          <span style={tierLineLabel}>CPS Tier:</span>
          <span style={{ color: GLASS.text, fontWeight: 600 }}>{tier.name}</span>
          <span style={{ color: GLASS.textFaint }}>—</span>
          <span>{tier.cps_limit} CPS</span>
        </div>
      )}

      {/* Service sections — each section's internal accent matches its panel */}
      {showRcf && (
        <SectionPanel accent={GLASS.success}>
          <CustomerRcfSection customerId={customer.id} accent={GLASS.success} />
        </SectionPanel>
      )}
      {showApi && (
        <SectionPanel accent="#a855f7">
          <CustomerApiSection customerId={customer.id} accent="#a855f7" />
        </SectionPanel>
      )}
      {showTrunk && (
        <SectionPanel accent={GLASS.warning}>
          <CustomerTrunkSection customerId={customer.id} accent={GLASS.warning} />
        </SectionPanel>
      )}
      {showUcaas && (
        <SectionPanel accent="#0ea5e9">
          <CustomerUcaasSection customerId={customer.id} accent="#0ea5e9" />
        </SectionPanel>
      )}

      {/* Usage & Analytics */}
      <UsageSection customerId={customer.id} accent={headerAccent} />

      {/* Account actions */}
      <AccountActions customer={customer} onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}
