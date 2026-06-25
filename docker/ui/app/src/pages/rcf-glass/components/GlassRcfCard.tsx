/**
 * GlassRcfCard — one RCF line as a frosted, lift-on-hover glass card. Purely
 * presentational; the editable destination delegates to <ForwardToEditor>.
 */

import type { RcfEntry } from '../../../types/rcf';
import { GlassCard, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { fmt } from '../../../utils/format';
import { StatusChip } from './StatusChip';
import { ForwardToEditor } from './ForwardToEditor';
import { IconArrow, IconClock, IconId } from './icons';
import {
  cardBody,
  cardDid,
  cardName,
  dividerLine,
  forwardsPill,
  forwardsPillLabel,
} from '../styles';

interface GlassRcfCardProps {
  entry: RcfEntry;
  canEdit: boolean;
  isAdmin: boolean;
  index: number;
}

export function GlassRcfCard({ entry, canEdit, isAdmin, index }: GlassRcfCardProps) {
  // Enabled lines glow in the app accent; disabled lines fade to faint.
  const accent = entry.enabled ? GLASS.accent : GLASS.textFaint;

  return (
    <GlassCard index={index} accent={accent}>
      <div style={cardBody}>
        {/* Row 1: status + customer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, gap: 8 }}>
          <StatusChip enabled={entry.enabled} />
          {isAdmin && entry.customer_name && <GlassChip label={entry.customer_name} color={GLASS.cyan} />}
        </div>

        {/* Row 2: name + DID */}
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          {entry.name && <div style={cardName}>{entry.name}</div>}
          <div style={cardDid}>{fmt(entry.did)}</div>
        </div>

        {/* Row 3: forwards-to divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={dividerLine(true)} />
          <span style={forwardsPill()}>
            <IconArrow color={GLASS.accent} />
            <span style={forwardsPillLabel()}>Forwards to</span>
          </span>
          <div style={dividerLine(false)} />
        </div>

        {/* Row 4: forward_to inline editor */}
        <div style={{ textAlign: 'center', marginBottom: 18, minHeight: 38, display: 'flex', justifyContent: 'center' }}>
          <ForwardToEditor entry={entry} canEdit={canEdit} size="lg" />
        </div>

        {/* Row 5: read-only chips */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <GlassChip label={`${entry.ring_timeout ?? 30}s ring`} color={GLASS.textMuted} icon={<IconClock />} />
          <GlassChip
            label={entry.pass_caller_id ? 'Pass caller ID' : 'Show DID'}
            color={entry.pass_caller_id ? GLASS.accent : GLASS.textMuted}
            icon={<IconId />}
          />
        </div>
      </div>
    </GlassCard>
  );
}
