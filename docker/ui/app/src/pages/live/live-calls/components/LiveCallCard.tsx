/**
 * LiveCallCard — one active call inside a frosted card, with full in-dialog
 * control (hangup / transfer / redirect / DTMF). All control state + the update
 * action come from `useCallControl`; the Button/ui primitives are reused as-is.
 *
 * React #310: the control hook is the first thing called in the component.
 */

import { PhoneOff, ArrowRightLeft, Link2, Hash } from 'lucide-react';
import type { LiveCall } from '../../../../types/liveCall';
import { GlassCard, GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { Button } from '../../../../components/ui/Button';
import { MONO, controlInput } from '../../shared/styles';
import { useCallControl, fmtSince } from '../hooks';

interface LiveCallCardProps {
  call: LiveCall;
  index: number;
  onActed: () => void;
}

export function LiveCallCard({ call, index, onActed }: LiveCallCardProps) {
  // Control hook first — before any conditional (React #310).
  const c = useCallControl(call, onActed);
  const inbound = call.direction === 'inbound';
  const dirColor = inbound ? GLASS.cyan : GLASS.green;

  return (
    <GlassCard index={index} style={{ padding: '18px 20px' }}>
      {/* Call summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <GlassChip label={call.direction} color={dirColor} dot />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: '0.9rem', color: GLASS.text }}>
          <span>{call.caller}</span>
          <ArrowRightLeft size={13} color={GLASS.textFaint} />
          <span>{call.dest}</span>
        </div>
        <GlassChip label={call.state} color={GLASS.textMuted} />
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: GLASS.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {call.answered_at ? `answered ${fmtSince(call.answered_at)}` : 'unanswered'}
        </span>
      </div>

      <div style={{ fontFamily: MONO, fontSize: '0.66rem', color: GLASS.textFaint, marginBottom: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={call.uuid}>
        {call.uuid}
      </div>

      {/* Controls */}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Button variant="danger" size="sm" icon={<PhoneOff size={13} />} loading={c.busy === 'hangup'} disabled={c.busy !== null} onClick={() => void c.act('hangup')}>
            Hangup
          </Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input style={controlInput} placeholder="Transfer to number" value={c.transferDest} onChange={(e) => c.setTransferDest(e.target.value)} />
          <Button variant="ghost" size="sm" icon={<ArrowRightLeft size={13} />} loading={c.busy === 'transfer'} disabled={c.busy !== null || !c.transferDest.trim()} onClick={() => void c.act('transfer', { destination: c.transferDest.trim() })}>
            Transfer
          </Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input style={controlInput} placeholder="Redirect voice_url" value={c.voiceUrl} onChange={(e) => c.setVoiceUrl(e.target.value)} />
          <Button variant="ghost" size="sm" icon={<Link2 size={13} />} loading={c.busy === 'redirect'} disabled={c.busy !== null || !c.voiceUrl.trim()} onClick={() => void c.act('redirect', { voice_url: c.voiceUrl.trim() })}>
            Redirect
          </Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input style={controlInput} placeholder="DTMF digits" value={c.digits} onChange={(e) => c.setDigits(e.target.value.replace(/[^0-9*#A-Da-d]/g, ''))} />
          <Button variant="ghost" size="sm" icon={<Hash size={13} />} loading={c.busy === 'dtmf'} disabled={c.busy !== null || !c.digits.trim()} onClick={() => void c.act('dtmf', { digits: c.digits.trim() })}>
            Send
          </Button>
        </div>
      </div>

      {/* Confirmation feedback */}
      {c.lastResult && (
        <div
          style={{
            marginTop: 12,
            fontSize: '0.75rem',
            padding: '8px 12px',
            borderRadius: 9,
            color: c.lastResult.confirmed ? GLASS.success : GLASS.warning,
            background: hexToRgba(c.lastResult.confirmed ? GLASS.success : GLASS.warning, 0.1),
            border: `1px solid ${hexToRgba(c.lastResult.confirmed ? GLASS.success : GLASS.warning, 0.25)}`,
          }}
        >
          ok: {String(c.lastResult.ok)} · confirmed: {String(c.lastResult.confirmed)}
        </div>
      )}
    </GlassCard>
  );
}
