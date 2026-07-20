/**
 * Small glass status pills for the DID feature — status, product, and owning
 * environment. All compose the canonical <GlassChip> so they refract the same
 * way as every other glass surface, tinted by the semantic colour maps in
 * types.ts.
 */

import { CheckCircle, Clock, ArrowRightLeft, Ban, AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { DidStatus, DidAllocatedEnv } from '../../../../types/didInventory';
import { STATUS_META, PRODUCT_META, ENV_META } from '../types';

const STATUS_ICON: Record<DidStatus, ReactNode> = {
  available:   <CheckCircle size={11} />,
  assigned:    <CheckCircle size={11} />,
  reserved:    <Clock size={11} />,
  porting_in:  <ArrowRightLeft size={11} />,
  porting_out: <ArrowRightLeft size={11} />,
  suspended:   <Ban size={11} />,
};

export function StatusBadge({ status }: { status: DidStatus }) {
  const meta = STATUS_META[status];
  if (!meta) {
    return <GlassChip label={status} color={GLASS.textMuted} icon={<AlertCircle size={11} />} />;
  }
  return <GlassChip label={meta.label} color={meta.color} icon={STATUS_ICON[status]} />;
}

export function ProductPill({ type }: { type: string }) {
  const color = PRODUCT_META[type] ?? GLASS.textMuted;
  return <GlassChip label={type.toUpperCase()} color={color} />;
}

/**
 * Owning-environment pill. Missing/undefined is treated as Production:
 * did_inventory.allocated_env is NOT NULL DEFAULT 'prod', so an absent value
 * only means the endpoint didn't serialize the column — the number is still
 * owned by production, which is less surprising than a neutral dash.
 */
export function EnvBadge({ env }: { env?: DidAllocatedEnv }) {
  const meta = ENV_META[env ?? 'prod'];
  return <GlassChip label={meta.label} color={meta.color} />;
}
