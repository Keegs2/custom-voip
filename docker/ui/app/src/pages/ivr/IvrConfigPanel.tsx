/**
 * IVR Builder — Configuration Panel
 *
 * Right sidebar shown when a node is selected. Renders verb-specific form fields
 * and a "Delete Node" button at the bottom.
 */

import { verbColor, type BuilderNode } from './ivrUtils';
import type { IvrAction } from './useIvrFlow';

interface IvrConfigPanelProps {
  node: BuilderNode | null;
  dispatch: React.Dispatch<IvrAction>;
}

// ---------------------------------------------------------------------------
// Shared form field components
// ---------------------------------------------------------------------------

interface LabeledFieldProps {
  label: string;
  children: React.ReactNode;
  hint?: string;
}

function LabeledField({ label, children, hint }: LabeledFieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
      <label
        style={{
          fontSize: '0.68rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.8px',
          color: '#718096',
        }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <p style={{ fontSize: '0.68rem', color: '#4a5568', lineHeight: 1.6, margin: 0 }}>{hint}</p>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: '0.875rem',
  color: '#e2e8f0',
  background: '#0d0f15',
  border: '1px solid rgba(42,47,69,0.6)',
  outline: 'none',
  boxSizing: 'border-box',
};

// ---------------------------------------------------------------------------
// Verb-specific form renders
// ---------------------------------------------------------------------------

function SayFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <>
      <LabeledField label="Text to speak">
        <textarea
          style={{ ...inputStyle, resize: 'vertical', minHeight: 90 }}
          value={node.config.text ?? ''}
          placeholder="Enter the text to be spoken..."
          rows={4}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'text', value: e.target.value })}
        />
      </LabeledField>
      <LabeledField label="Voice">
        <select
          style={inputStyle}
          value={node.config.voice ?? 'woman'}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'voice', value: e.target.value })}
        >
          <option value="woman">Woman</option>
          <option value="man">Man</option>
        </select>
      </LabeledField>
    </>
  );
}

function PlayFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <LabeledField label="Audio URL">
      <input
        type="url"
        style={inputStyle}
        value={node.config.url ?? ''}
        placeholder="https://example.com/audio.mp3"
        onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'url', value: e.target.value })}
      />
    </LabeledField>
  );
}

function GatherFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <>
      <LabeledField label="Max Digits">
        <input
          type="number"
          style={inputStyle}
          min={1}
          max={20}
          value={node.config.numDigits ?? '1'}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'numDigits', value: e.target.value })}
        />
      </LabeledField>
      <LabeledField label="Timeout (seconds)">
        <input
          type="number"
          style={inputStyle}
          min={1}
          max={60}
          value={node.config.timeout ?? '5'}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'timeout', value: e.target.value })}
        />
      </LabeledField>
      <p style={{ fontSize: '0.72rem', color: '#4a5568', lineHeight: 1.6, marginTop: -8, marginBottom: 16 }}>
        Use the branch tabs beneath the node to define what happens for each digit.
        Drop Say/Play verbs into the prompt area to play audio while waiting.
      </p>
    </>
  );
}

function DialFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <>
      <LabeledField label="Phone Number">
        <input
          type="tel"
          style={inputStyle}
          value={node.config.number ?? ''}
          placeholder="+1XXXXXXXXXX"
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'number', value: e.target.value })}
        />
      </LabeledField>
      <LabeledField label="Caller ID (optional)">
        <input
          type="tel"
          style={inputStyle}
          value={node.config.callerId ?? ''}
          placeholder="+1XXXXXXXXXX"
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'callerId', value: e.target.value })}
        />
      </LabeledField>
      <LabeledField label="Timeout (seconds)">
        <input
          type="number"
          style={inputStyle}
          min={5}
          max={120}
          value={node.config.timeout ?? '30'}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'timeout', value: e.target.value })}
        />
      </LabeledField>
    </>
  );
}

function PauseFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <LabeledField label="Duration (seconds)">
      <input
        type="number"
        style={inputStyle}
        min={1}
        max={120}
        value={node.config.duration ?? '1'}
        onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'duration', value: e.target.value })}
      />
    </LabeledField>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

const asidePanelStyle = {
  width: '300px',
  flexShrink: 0,
  background: '#0f1117',
  borderLeft: '1px solid rgba(255,255,255,0.06)',
} as const;

export function IvrConfigPanel({ node, dispatch }: IvrConfigPanelProps) {
  if (!node) {
    return (
      <aside
        style={{ ...asidePanelStyle, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}
        aria-label="Node configuration panel"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: 24,
            textAlign: 'center',
          }}
        >
          <div>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
                background: 'rgba(42,47,69,0.35)',
                border: '1px solid rgba(42,47,69,0.5)',
              }}
              aria-hidden="true"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: 20, height: 20, color: '#334155' }}>
                <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p style={{ color: '#475569', fontSize: '0.875rem', fontWeight: 600, margin: 0 }}>No node selected</p>
            <p style={{ color: '#334155', fontSize: '0.78rem', marginTop: 4, lineHeight: 1.6, marginBottom: 0 }}>
              Click a node on the canvas to configure it.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const accentColor = verbColor(node.type);

  return (
    <aside
      style={{ ...asidePanelStyle, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}
      aria-label="Node configuration panel"
    >
      {/* Panel header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '20px 20px 16px',
          borderBottom: '1px solid rgba(42,47,69,0.5)',
        }}
      >
        <div
          style={{
            width: 3,
            height: 20,
            borderRadius: 99,
            flexShrink: 0,
            backgroundColor: accentColor,
            boxShadow: `0 0 6px ${accentColor}60`,
          }}
          aria-hidden="true"
        />
        <h2
          style={{
            fontSize: '0.7rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '1px',
            color: accentColor,
            margin: 0,
          }}
        >
          {node.type} — Config
        </h2>
        <button
          type="button"
          style={{
            marginLeft: 'auto',
            width: 24,
            height: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            color: '#4a5568',
            fontSize: '0.875rem',
            lineHeight: 1,
            cursor: 'pointer',
          }}
          aria-label="Deselect node"
          onClick={() => dispatch({ type: 'SELECT_NODE', nodeId: null })}
        >
          ✕
        </button>
      </div>

      {/* Form fields */}
      <div style={{ flex: 1, padding: '20px 20px 8px' }}>
        {node.type === 'say'    && <SayFields    node={node} dispatch={dispatch} />}
        {node.type === 'play'   && <PlayFields   node={node} dispatch={dispatch} />}
        {node.type === 'gather' && <GatherFields node={node} dispatch={dispatch} />}
        {node.type === 'dial'   && <DialFields   node={node} dispatch={dispatch} />}
        {node.type === 'hangup' && (
          <p style={{ color: '#718096', fontSize: '0.875rem', lineHeight: 1.6, margin: 0 }}>
            This verb ends the call immediately. No configuration required.
          </p>
        )}
        {node.type === 'pause' && <PauseFields node={node} dispatch={dispatch} />}
      </div>

      {/* Delete button */}
      <div
        style={{
          padding: '12px 20px 20px',
          borderTop: '1px solid rgba(42,47,69,0.5)',
        }}
      >
        <button
          type="button"
          style={{
            width: '100%',
            padding: '10px 16px',
            borderRadius: 8,
            fontSize: '0.875rem',
            fontWeight: 600,
            border: '1px solid rgba(239,68,68,0.25)',
            background: 'rgba(127,29,29,0.5)',
            color: '#fca5a5',
            cursor: 'pointer',
          }}
          onClick={() => dispatch({ type: 'REMOVE_NODE', nodeId: node.id })}
        >
          Delete Node
        </button>
      </div>
    </aside>
  );
}
