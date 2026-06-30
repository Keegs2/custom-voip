/**
 * CarrierCard — one carrier gateway rendered as an interactive frosted-glass
 * card: identity header, status/role/product badges, the SIP connection detail
 * block, a live connectivity test with inline result, and edit / enable-disable
 * / delete actions. The inline edit form swaps in over the detail block.
 *
 * Data + mutations live in `useCarrierCard`; this component is presentation +
 * wiring only. React #310: every hook sits at the top, before any return.
 */

import { useState, type ReactNode } from 'react';
import { GlassCard } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import { useCarrierCard } from '../hooks';
import {
  cardBody,
  cardName,
  cardGateway,
  badgeRow,
  actionsRow,
  actionBtn,
  testResultText,
  editShell,
  spinnerRing,
} from '../styles';
import { EnabledBadge, PrimaryBadge, FailoverBadge, ProductTypeBadge } from './badges';
import { ConnectionInfo } from './ConnectionInfo';
import { CarrierForm } from './CarrierForm';
import { IconPulse } from './icons';

interface ActionButtonProps {
  tone: 'accent' | 'success' | 'danger' | 'muted';
  onClick: () => void;
  loading?: boolean;
  children: ReactNode;
}

function ActionButton({ tone, onClick, loading, children }: ActionButtonProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ ...actionBtn(tone, hovered), opacity: loading ? 0.6 : 1 }}
    >
      {loading && <span style={spinnerRing(tone === 'danger' ? GLASS.danger : GLASS.accent)} />}
      {children}
    </button>
  );
}

export function CarrierCard({ carrier, index = 0 }: { carrier: Carrier; index?: number }) {
  const {
    isEditing,
    testResult,
    testing,
    deletePending,
    beginEdit,
    cancelEdit,
    save,
    toggleEnabled,
    test,
    remove,
  } = useCarrierCard(carrier);

  const accent = carrier.enabled ? GLASS.accent : GLASS.textFaint;

  return (
    <GlassCard index={index} accent={accent}>
      <div style={cardBody}>
        {/* Header */}
        <div>
          <div style={cardName}>{carrier.display_name || carrier.gateway_name}</div>
          <div style={cardGateway}>{carrier.gateway_name}</div>
          <div style={badgeRow}>
            <EnabledBadge enabled={carrier.enabled} />
            {carrier.is_primary && <PrimaryBadge />}
            {carrier.is_failover && <FailoverBadge />}
            {(carrier.product_types ?? []).map((pt) => (
              <ProductTypeBadge key={pt} type={pt} />
            ))}
          </div>
        </div>

        {/* Connection details OR inline edit form */}
        {isEditing ? (
          <div style={editShell()}>
            <CarrierForm
              carrier={carrier}
              submitLabel="Save Changes"
              onCancel={cancelEdit}
              onSubmit={save}
            />
          </div>
        ) : (
          <>
            <ConnectionInfo carrier={carrier} />

            {/* Actions */}
            <div style={actionsRow}>
              <ActionButton tone="accent" onClick={test} loading={testing}>
                {!testing && <IconPulse />}
                Test Connection
              </ActionButton>

              {testResult && (
                <span style={testResultText(testResult.reachable)}>
                  {testResult.reachable
                    ? `Reachable${testResult.latency_ms != null ? ` · ${testResult.latency_ms}ms` : ''}`
                    : `Unreachable — ${testResult.error ?? 'connection timeout'}`}
                </span>
              )}

              <span style={{ flex: 1 }} />

              <ActionButton tone="muted" onClick={beginEdit}>Edit</ActionButton>
              <ActionButton tone={carrier.enabled ? 'muted' : 'success'} onClick={toggleEnabled}>
                {carrier.enabled ? 'Disable' : 'Enable'}
              </ActionButton>
              <ActionButton tone="danger" onClick={remove} loading={deletePending}>Delete</ActionButton>
            </div>
          </>
        )}
      </div>
    </GlassCard>
  );
}
