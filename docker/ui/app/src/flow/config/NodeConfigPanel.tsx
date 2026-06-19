/**
 * Per-node config editor for the selected canvas node. Typed per `NodeConfig`
 * arm — each verb shows only its own fields. Edits commit straight to the store
 * (`updateNodeConfig`); zundo's debounced `handleSet` keeps undo history sane.
 *
 * React #310: ALL hooks are declared unconditionally at the very top, before
 * the `selected == null` early return.
 */
import { useFlowStore } from '../store/flowStore';
import { FormField } from '../../components/ui/FormField';
import { Button } from '../../components/ui/Button';
import { NODE_META } from '../model/palette';
import { MENU_DIGIT_KEYS } from '../canvas/handles';
import type { NodeConfig, NodeType } from '../model/types';

const VOICES = ['default', 'male', 'female', 'woman', 'man'];

export function NodeConfigPanel() {
  // Hooks first — React #310.
  const selectedId = useFlowStore((s) => s.selectedId);
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === s.selectedId) ?? null);
  const updateNodeConfig = useFlowStore((s) => s.updateNodeConfig);
  const updateNodeLabel = useFlowStore((s) => s.updateNodeLabel);
  const removeNode = useFlowStore((s) => s.removeNode);
  const product = useFlowStore((s) => s.doc.product);

  if (!node || !selectedId) {
    return (
      <div style={{ padding: 16, fontSize: '0.78rem', color: '#64748b' }}>
        Select a node to edit its settings.
      </div>
    );
  }

  const nodeType = (node.type ?? 'say') as NodeType;
  const config = node.data.config;
  const meta = NODE_META[nodeType];
  const accent = meta?.accent ?? '#3b82f6';

  // Narrowed setter — merges a partial patch into this node's config arm.
  const set = (patch: Partial<NodeConfig>) => updateNodeConfig(selectedId, patch);
  const num = (v: string): number | undefined => (v === '' ? undefined : Number(v));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 14px',
          borderBottom: '1px solid rgba(42,47,69,0.6)',
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.78rem',
            fontWeight: 800,
            color: accent,
            background: `${accent}1f`,
          }}
        >
          {meta?.glyph ?? '•'}
        </span>
        <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#e2e8f0' }}>
          {meta?.label ?? nodeType}
        </span>
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', flex: 1 }}>
        {nodeType !== 'entry' && (
          <FormField
            label="Label"
            value={node.data.label ?? ''}
            onChange={(e) => updateNodeLabel(selectedId, e.target.value)}
            placeholder={meta?.label}
          />
        )}

        {config.type === 'entry' && (
          <p style={{ fontSize: '0.74rem', color: '#94a3b8', lineHeight: 1.5 }}>
            The Entry node is where inbound calls begin. Bind the DID in the
            toolbar above. Connect it to the first verb of your flow.
          </p>
        )}

        {config.type === 'say' && (
          <>
            <FormField
              as="textarea"
              label="Text to speak"
              value={config.text}
              onChange={(e) => set({ text: e.target.value })}
              placeholder="Thank you for calling…"
            />
            <FormField as="select" label="Voice" value={config.voice} onChange={(e) => set({ voice: e.target.value })}>
              {VOICES.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </FormField>
          </>
        )}

        {config.type === 'play' && (
          <FormField
            label="Audio URL"
            value={config.url}
            onChange={(e) => set({ url: e.target.value })}
            placeholder="https://…/greeting.wav"
          />
        )}

        {config.type === 'pause' && (
          <FormField
            label="Seconds"
            type="number"
            min={1}
            value={String(config.seconds)}
            onChange={(e) => set({ seconds: num(e.target.value) ?? 1 })}
          />
        )}

        {config.type === 'menu' && (
          <>
            <FormField
              as="textarea"
              label="Prompt"
              value={config.prompt ?? ''}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder="Press 1 for sales, 2 for support…"
              hint="Played inside the Gather while collecting input."
            />
            <FormField as="select" label="Voice" value={config.voice ?? 'default'} onChange={(e) => set({ voice: e.target.value })}>
              {VOICES.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </FormField>

            <div>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Options (each adds a handle)
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {config.digits.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => set({ digits: config.digits.filter((x) => x !== d) })}
                    title="Remove option"
                    style={{
                      padding: '3px 9px',
                      borderRadius: 6,
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      color: accent,
                      background: `${accent}1f`,
                      border: `1px solid ${accent}55`,
                      cursor: 'pointer',
                    }}
                  >
                    {d} ✕
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {MENU_DIGIT_KEYS.filter((d) => !config.digits.includes(d)).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => set({ digits: [...config.digits, d] })}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      color: '#94a3b8',
                      background: 'rgba(26,29,39,0.9)',
                      border: '1px solid rgba(42,47,69,0.8)',
                      cursor: 'pointer',
                    }}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>

            <FormField
              label="Digits to collect"
              type="number"
              min={1}
              value={String(config.numDigits ?? 1)}
              onChange={(e) => set({ numDigits: num(e.target.value) ?? 1 })}
            />
            <FormField
              label="Timeout (s)"
              type="number"
              min={1}
              value={String(config.timeout)}
              onChange={(e) => set({ timeout: num(e.target.value) ?? 5 })}
            />
          </>
        )}

        {/* RCF forward — single destination, no failover (plan §0.1/§12). */}
        {config.type === 'dial' && product === 'rcf' && (
          <>
            <FormField
              label="Forward to"
              value={config.number}
              onChange={(e) => set({ number: e.target.value })}
              placeholder="+16175551234"
              hint="The single destination this DID forwards to."
            />
            <FormField
              label="Ring timeout (s)"
              type="number"
              min={5}
              value={String(config.timeout)}
              onChange={(e) => set({ timeout: num(e.target.value) ?? 30 })}
            />
            <FormField
              label="Max channels"
              type="number"
              min={1}
              value={String(config.maxChannels ?? '')}
              onChange={(e) => set({ maxChannels: num(e.target.value) })}
              placeholder="(optional concurrent-call cap)"
            />
            <label style={checkboxRow}>
              <input
                type="checkbox"
                checked={!!config.passCallerId}
                onChange={(e) => set({ passCallerId: e.target.checked })}
              />
              Pass caller ID through
            </label>
          </>
        )}

        {/* IVR / API / conference dial — full destination options. */}
        {config.type === 'dial' && product !== 'rcf' && (
          <>
            <FormField
              label="Destination"
              value={config.number}
              onChange={(e) => set({ number: e.target.value })}
              placeholder="+16175551234 or extension"
            />
            <FormField
              label="Caller ID"
              value={config.callerId ?? ''}
              onChange={(e) => set({ callerId: e.target.value })}
              placeholder="(optional)"
            />
            <FormField
              label="Ring timeout (s)"
              type="number"
              min={5}
              value={String(config.timeout)}
              onChange={(e) => set({ timeout: num(e.target.value) ?? 30 })}
            />
            <label style={checkboxRow}>
              <input type="checkbox" checked={!!config.record} onChange={(e) => set({ record: e.target.checked })} />
              Record this call
            </label>
          </>
        )}

        {config.type === 'record' && (
          <>
            <FormField
              label="Max length (s)"
              type="number"
              min={1}
              value={String(config.maxLength ?? '')}
              onChange={(e) => set({ maxLength: num(e.target.value) })}
            />
            <FormField
              label="Finish on key"
              value={config.finishOnKey ?? ''}
              onChange={(e) => set({ finishOnKey: e.target.value })}
              placeholder="#"
            />
            <label style={checkboxRow}>
              <input type="checkbox" checked={!!config.playBeep} onChange={(e) => set({ playBeep: e.target.checked })} />
              Play beep before recording
            </label>
            <label style={checkboxRow}>
              <input type="checkbox" checked={!!config.transcribe} onChange={(e) => set({ transcribe: e.target.checked })} />
              Transcribe
            </label>
          </>
        )}

        {config.type === 'redirect' && (
          <>
            <FormField
              label="Redirect URL"
              value={config.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="/ivr/webhook/123 or https://…"
            />
            <FormField as="select" label="Method" value={config.method ?? 'POST'} onChange={(e) => set({ method: e.target.value as 'GET' | 'POST' })}>
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </FormField>
          </>
        )}

        {config.type === 'reject' && (
          <FormField
            label="Reason"
            value={config.reason ?? ''}
            onChange={(e) => set({ reason: e.target.value })}
            placeholder="busy / rejected"
          />
        )}

        {config.type === 'conference' && (
          <>
            <FormField
              label="Room"
              value={config.room}
              onChange={(e) => set({ room: e.target.value })}
              placeholder="sales-standup"
            />
            <FormField
              label="Max participants"
              type="number"
              min={2}
              value={String(config.maxParticipants ?? '')}
              onChange={(e) => set({ maxParticipants: num(e.target.value) })}
            />
            <label style={checkboxRow}>
              <input type="checkbox" checked={!!config.muted} onChange={(e) => set({ muted: e.target.checked })} />
              Join muted
            </label>
            <label style={checkboxRow}>
              <input type="checkbox" checked={!!config.beep} onChange={(e) => set({ beep: e.target.checked })} />
              Beep on join/leave
            </label>
            <label style={checkboxRow}>
              <input type="checkbox" checked={!!config.waitForModerator} onChange={(e) => set({ waitForModerator: e.target.checked })} />
              Wait for moderator
            </label>
            <label style={checkboxRow}>
              <input type="checkbox" checked={!!config.record} onChange={(e) => set({ record: e.target.checked })} />
              Record conference
            </label>
          </>
        )}

        {/* UCaaS find-me/follow-me ring plan. */}
        {config.type === 'ringGroup' && (
          <>
            <FormField
              as="select"
              label="Ring strategy"
              value={config.strategy}
              onChange={(e) => set({ strategy: e.target.value as 'sequential' | 'parallel' })}
              hint={
                config.strategy === 'sequential'
                  ? 'Ring each destination in order, one at a time.'
                  : 'Ring all destinations at once; first to answer wins.'
              }
            >
              <option value="sequential">Sequential (one at a time)</option>
              <option value="parallel">Parallel (all at once)</option>
            </FormField>
            <FormField
              label="Ring timeout (s)"
              type="number"
              min={5}
              value={String(config.ringTimeout)}
              onChange={(e) => set({ ringTimeout: num(e.target.value) ?? 30 })}
              hint="Overall time to ring before the fallback is used."
            />

            <div>
              <div style={legsHeader}>Destinations (in ring order)</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {config.legs.map((leg, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={legIndex}>{i + 1}</span>
                    <input
                      style={{ ...legInput, flex: 1 }}
                      value={leg.to}
                      placeholder="+16175551234 or 1001"
                      onChange={(e) => set({ legs: config.legs.map((l, j) => (j === i ? { ...l, to: e.target.value } : l)) })}
                    />
                    <input
                      style={{ ...legInput, width: 56 }}
                      type="number"
                      min={1}
                      value={leg.timeout === undefined ? '' : String(leg.timeout)}
                      placeholder="s"
                      title="Per-leg ring time (optional)"
                      onChange={(e) =>
                        set({ legs: config.legs.map((l, j) => (j === i ? { ...l, timeout: num(e.target.value) } : l)) })
                      }
                    />
                    <button
                      type="button"
                      style={legBtn}
                      disabled={i === 0}
                      title="Move up"
                      onClick={() => set({ legs: swap(config.legs, i, i - 1) })}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      style={legBtn}
                      disabled={i === config.legs.length - 1}
                      title="Move down"
                      onClick={() => set({ legs: swap(config.legs, i, i + 1) })}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      style={{ ...legBtn, color: '#ef4444' }}
                      title="Remove destination"
                      onClick={() => set({ legs: config.legs.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                style={addLegBtn}
                onClick={() => set({ legs: [...config.legs, { to: '' }] })}
              >
                + Add destination
              </button>
            </div>
          </>
        )}

        {config.type === 'voicemail' && (
          <>
            <FormField
              as="textarea"
              label="Greeting"
              value={config.greeting ?? ''}
              onChange={(e) => set({ greeting: e.target.value })}
              placeholder="You've reached … please leave a message."
              hint="Optional spoken greeting before the beep."
            />
            <FormField
              label="Mailbox"
              value={config.mailbox ?? ''}
              onChange={(e) => set({ mailbox: e.target.value })}
              placeholder="(optional — defaults to the extension)"
            />
            <p style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
              Terminal fallback — the caller is sent to voicemail if no one answers.
            </p>
          </>
        )}

        {config.type === 'hangup' && (
          <p style={{ fontSize: '0.74rem', color: '#94a3b8' }}>Ends the call. No configuration.</p>
        )}
      </div>

      {nodeType !== 'entry' && (
        <div style={{ padding: 12, borderTop: '1px solid rgba(42,47,69,0.6)' }}>
          <Button variant="danger" size="sm" onClick={() => removeNode(selectedId)} className="w-full">
            Delete node
          </Button>
        </div>
      )}
    </div>
  );
}

const checkboxRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: '0.76rem',
  color: '#cbd5e1',
  cursor: 'pointer',
};

/** Return a copy of `arr` with the items at `i` and `j` swapped (no-op if out of range). */
function swap<T>(arr: T[], i: number, j: number): T[] {
  if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

const legsHeader: React.CSSProperties = {
  fontSize: '0.68rem',
  fontWeight: 700,
  color: '#4a5568',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 6,
};

const legIndex: React.CSSProperties = {
  width: 18,
  textAlign: 'center',
  fontSize: '0.7rem',
  fontWeight: 700,
  color: '#64748b',
  flexShrink: 0,
};

const legInput: React.CSSProperties = {
  height: 30,
  padding: '0 8px',
  borderRadius: 7,
  fontSize: '0.76rem',
  color: '#e2e8f0',
  background: '#1e2130',
  border: '1px solid #2a2f45',
  outline: 'none',
};

const legBtn: React.CSSProperties = {
  width: 26,
  height: 30,
  borderRadius: 7,
  fontSize: '0.78rem',
  fontWeight: 700,
  color: '#94a3b8',
  background: 'rgba(26,29,39,0.9)',
  border: '1px solid rgba(42,47,69,0.8)',
  cursor: 'pointer',
  flexShrink: 0,
};

const addLegBtn: React.CSSProperties = {
  marginTop: 8,
  padding: '6px 10px',
  borderRadius: 8,
  fontSize: '0.74rem',
  fontWeight: 700,
  color: '#34d399',
  background: 'rgba(52,211,153,0.12)',
  border: '1px solid rgba(52,211,153,0.4)',
  cursor: 'pointer',
};
